import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { PlexTrackRef } from "../src/core/plex.ts";
import type { SyncInput, SyncSummary } from "../src/core/sync.ts";
import { JobConflictError, createJobStore, type JobDeps, type JobSnapshot } from "../src/server/jobs.ts";
import { createJobServer } from "../src/server/http.ts";

const tracks: PlexTrackRef[] = [
  { ratingKey: "1", title: "One", downloadUrl: "http://plex/1", sizeBytes: 3_000_000 },
  { ratingKey: "2", title: "Two", downloadUrl: "http://plex/2" },
];

/**
 * A stub engine. It reports phases like the real one, then pauses after the first
 * track until release() is called — so a test can look at a job mid-sync.
 */
function stubDeps() {
  let syncCalls = 0;
  let release!: () => void;
  const paused = new Promise<void>((r) => (release = r));
  const deps: JobDeps = {
    plan: async (name) => {
      if (name === "missing") throw new Error('No playlist named "missing".');
      return { title: "Weezer", tracks };
    },
    inspectIpod: async (mount) => {
      if (mount === "/not-an-ipod") throw new Error("no iPod_Control under /not-an-ipod");
      return { trackCount: 7 };
    },
    sync: async (input: SyncInput): Promise<SyncSummary> => {
      syncCalls++;
      const ev = input.events!;
      ev.onPhase?.("opening");
      ev.onPhase?.("wiping");
      ev.onBackup?.("/ipod/iTunesDB.backup");
      ev.onPhase?.("downloading");
      ev.onTrackStart?.(0, 2, tracks[0]!);
      ev.onTrackDone?.(0, tracks[0]!);
      ev.onTrackStart?.(1, 2, tracks[1]!);
      await paused;
      ev.onTrackSkipped?.(1, tracks[1]!, "HTTP 404");
      ev.onPhase?.("writing");
      return {
        playlistName: input.playlistName,
        requested: 2,
        added: 1,
        skipped: [{ track: tracks[1]!, reason: "HTTP 404" }],
        dbPath: "/ipod/iTunesDB",
        bytesWritten: 100,
      };
    },
  };
  return { deps, release, syncCalls: () => syncCalls };
}

/** Collects every snapshot a subscriber sees, and resolves when one matches. */
function watch(job: { subscribe(fn: (s: JobSnapshot) => void): () => void }) {
  const seen: JobSnapshot[] = [];
  const waiters: { phase: string; resolve: (s: JobSnapshot) => void }[] = [];
  const unsubscribe = job.subscribe((s) => {
    seen.push(s);
    for (const w of waiters) if (w.phase === s.phase) w.resolve(s);
  });
  const until = (phase: string) =>
    seen.find((s) => s.phase === phase) ??
    new Promise<JobSnapshot>((resolve) => waiters.push({ phase, resolve }));
  return { seen, until, unsubscribe };
}

describe("JobStore", () => {
  it("plans, then waits: the engine never runs without approval", async () => {
    const { deps, syncCalls } = stubDeps();
    const job = createJobStore(deps).create("weezer", "/ipod");
    const w = watch(job);

    assert.equal(w.seen[0]!.phase, "planning");
    const ready = await w.until("awaiting-approval");
    assert.equal(ready.playlistName, "Weezer");
    assert.equal(ready.tracksTotal, 2);
    // Track "Two" has no size, so the total is a lower bound and says so.
    assert.deepEqual(ready.plan, { totalBytes: 3_000_000, unknownSizes: 1, ipodTracksNow: 7 });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(syncCalls(), 0);
  });

  it("a folder that is not an iPod fails during planning, before any approval", async () => {
    const { deps, syncCalls } = stubDeps();
    const job = createJobStore(deps).create("weezer", "/not-an-ipod");
    const failed = await watch(job).until("failed");
    assert.match(failed.error!, /no iPod_Control/);
    assert.equal(syncCalls(), 0);
  });

  it("a late subscriber gets the current state first (reconnect)", async () => {
    const { deps, release } = stubDeps();
    const store = createJobStore(deps);
    const job = store.create("weezer", "/ipod");
    await watch(job).until("awaiting-approval");
    store.approve(job);
    await watch(job).until("downloading");

    // "Reopen the tab" mid-sync: the first snapshot already shows progress.
    const reopened = watch(job);
    assert.equal(reopened.seen[0]!.phase, "downloading");
    assert.equal(reopened.seen[0]!.tracksDone, 1);
    assert.equal(reopened.seen[0]!.current?.title, "Two");
    assert.equal(reopened.seen[0]!.backupPath, "/ipod/iTunesDB.backup");

    release();
    const done = await reopened.until("done");
    assert.equal(done.tracksDone, 1);
    assert.deepEqual(done.skipped, [{ index: 1, title: "Two", reason: "HTTP 404" }]);
  });

  it("refuses a second approve and a second active job", async () => {
    const { deps, release, syncCalls } = stubDeps();
    const store = createJobStore(deps);
    const job = store.create("weezer", "/ipod");
    await watch(job).until("awaiting-approval");

    store.approve(job);
    assert.throws(() => store.approve(job), JobConflictError);
    assert.throws(() => store.create("weezer", "/ipod"), JobConflictError);

    release();
    await watch(job).until("done");
    assert.equal(syncCalls(), 1);
    assert.ok(store.create("weezer", "/ipod")); // a finished job no longer blocks
  });

  it("an unknown playlist fails the job with the reason", async () => {
    const { deps } = stubDeps();
    const job = createJobStore(deps).create("missing", "/ipod");
    const failed = await watch(job).until("failed");
    assert.match(failed.error!, /No playlist named "missing"/);
  });
});

describe("HTTP", () => {
  async function serve(t: { after(fn: () => void): void }) {
    const stub = stubDeps();
    const server = createJobServer(createJobStore(stub.deps), { defaultMount: "./fake-ipod" });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => server.close());
    return { ...stub, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }

  /** Read the first SSE frame from a job's event stream. */
  async function firstEvent(base: string, id: string): Promise<JobSnapshot> {
    const abort = new AbortController();
    const events = await fetch(`${base}/jobs/${id}/events`, { signal: abort.signal });
    assert.equal(events.headers.get("content-type"), "text/event-stream");
    const reader = events.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    abort.abort();
    return JSON.parse(first.replace(/^data: /, "")) as JobSnapshot;
  }

  it("POST /jobs, then the event stream opens with the current snapshot", async (t) => {
    const { base } = await serve(t);

    const bad = await fetch(`${base}/jobs`, { method: "POST", body: "{}" });
    assert.equal(bad.status, 400);

    const created = await fetch(`${base}/jobs`, {
      method: "POST",
      body: JSON.stringify({ playlist: "weezer", mount: "/ipod" }),
    });
    assert.equal(created.status, 201);
    const { id } = (await created.json()) as JobSnapshot;
    await new Promise((r) => setTimeout(r, 20)); // let planning finish

    const snapshot = await firstEvent(base, id);
    assert.equal(snapshot.phase, "awaiting-approval");
    assert.equal(snapshot.tracksTotal, 2);
    assert.equal(snapshot.plan?.ipodTracksNow, 7);

    assert.equal((await fetch(`${base}/jobs/nope/events`)).status, 404);
  });

  it("the engine runs only after POST /approve, and only once", async (t) => {
    const { base, release, syncCalls } = await serve(t);
    const created = await fetch(`${base}/jobs`, {
      method: "POST",
      body: JSON.stringify({ playlist: "weezer", mount: "/ipod" }),
    });
    const { id } = (await created.json()) as JobSnapshot;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(syncCalls(), 0);

    const approve = () => fetch(`${base}/jobs/${id}/approve`, { method: "POST" });
    assert.equal((await approve()).status, 202);
    assert.equal((await approve()).status, 409);
    assert.equal(syncCalls(), 1);
    release();
  });

  it("turns bad requests into 4xx replies with a reason", async (t) => {
    const { base } = await serve(t);
    const post = (body: string) => fetch(`${base}/jobs`, { method: "POST", body });

    const notJson = await post("{nope");
    assert.equal(notJson.status, 400);
    assert.deepEqual(await notJson.json(), { error: "Body is not valid JSON." });

    assert.equal((await post("x".repeat(20_000))).status, 413);

    const { id } = (await (await post(JSON.stringify({ playlist: "weezer", mount: "/ipod" }))).json()) as JobSnapshot;
    assert.equal((await fetch(`${base}/jobs/${id}`, { method: "DELETE" })).status, 405);
  });

  it("GET /jobs/latest finds the newest job, so a reopened tab can reconnect", async (t) => {
    const { base } = await serve(t);
    assert.equal((await fetch(`${base}/jobs/latest`)).status, 404);

    const created = await fetch(`${base}/jobs`, {
      method: "POST",
      body: JSON.stringify({ playlist: "weezer", mount: "/ipod" }),
    });
    const { id } = (await created.json()) as JobSnapshot;
    const latest = await fetch(`${base}/jobs/latest`);
    assert.equal(latest.status, 200);
    assert.equal(((await latest.json()) as JobSnapshot).id, id);
  });

  it("serves the UI files and nothing else", async (t) => {
    const { base } = await serve(t);
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /importmap/);
    for (const path of ["/app/app.js", "/app/outcome.js", "/vendor/preact/preact.mjs", "/vendor/preact/hooks.mjs"]) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get("content-type")!, /javascript/);
    }
    assert.deepEqual(await (await fetch(`${base}/settings`)).json(), { defaultMount: "./fake-ipod" });
    // fetch() normalizes "/../", so send the raw paths over node:http.
    for (const path of ["/../package.json", "/app/../../package.json", "/src/web/app.js"]) {
      assert.equal(await rawStatus(base, path), 404, path);
    }
  });
});

/** GET a path exactly as written, without URL normalization. */
function rawStatus(base: string, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const { hostname, port } = new URL(base);
    http.get({ hostname, port, path }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    }).on("error", reject);
  });
}
