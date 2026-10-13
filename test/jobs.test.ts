import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { PlexTrackRef } from "../src/core/plex.ts";
import type { SyncInput, SyncSummary } from "../src/core/sync.ts";
import { JobConflictError, JobStore, type JobDeps, type JobSnapshot } from "../src/server/jobs.ts";
import { createJobServer } from "../src/server/http.ts";

const tracks: PlexTrackRef[] = [
  { ratingKey: "1", title: "One", downloadUrl: "http://plex/1" },
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
    const job = new JobStore(deps).create("weezer", "/ipod");
    const w = watch(job);

    assert.equal(w.seen[0]!.phase, "planning");
    const ready = await w.until("awaiting-approval");
    assert.equal(ready.playlistName, "Weezer");
    assert.equal(ready.tracksTotal, 2);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(syncCalls(), 0);
  });

  it("a late subscriber gets the current state first (reconnect)", async () => {
    const { deps, release } = stubDeps();
    const store = new JobStore(deps);
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
    assert.deepEqual(done.skipped, [{ title: "Two", reason: "HTTP 404" }]);
  });

  it("refuses a second approve and a second active job", async () => {
    const { deps, release, syncCalls } = stubDeps();
    const store = new JobStore(deps);
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
    const job = new JobStore(deps).create("missing", "/ipod");
    const failed = await watch(job).until("failed");
    assert.match(failed.error!, /No playlist named "missing"/);
  });
});

describe("HTTP", () => {
  it("POST /jobs, then the event stream opens with the current snapshot", async (t) => {
    const { deps } = stubDeps();
    const server = createJobServer(new JobStore(deps)).listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => server.close());
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const bad = await fetch(`${base}/jobs`, { method: "POST", body: "{}" });
    assert.equal(bad.status, 400);

    const created = await fetch(`${base}/jobs`, {
      method: "POST",
      body: JSON.stringify({ playlist: "weezer", mount: "/ipod" }),
    });
    assert.equal(created.status, 201);
    const { id } = (await created.json()) as JobSnapshot;
    await new Promise((r) => setTimeout(r, 20)); // let planning finish

    const abort = new AbortController();
    const events = await fetch(`${base}/jobs/${id}/events`, { signal: abort.signal });
    assert.equal(events.headers.get("content-type"), "text/event-stream");
    const reader = events.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    abort.abort();

    const snapshot = JSON.parse(first.replace(/^data: /, "")) as JobSnapshot;
    assert.equal(snapshot.phase, "awaiting-approval");
    assert.equal(snapshot.tracksTotal, 2);

    assert.equal((await fetch(`${base}/jobs/nope/events`)).status, 404);
  });
});
