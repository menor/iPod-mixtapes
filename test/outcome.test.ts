import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PlexTrackRef } from "../src/core/plex.ts";
import type { SyncInput, SyncSummary } from "../src/core/sync.ts";
import { createJobStore, type JobDeps, type JobSnapshot } from "../src/server/jobs.ts";
import { describeDoingNow, describeOutcome } from "../src/web/outcome.js";

const track = (n: number): PlexTrackRef => ({
  ratingKey: String(n),
  title: `Track ${n}`,
  downloadUrl: `http://plex/${n}`,
});
const tracks = [track(1), track(2), track(3)];

/** Run a job to its end with a stub engine, approving it on the way. */
async function runToEnd(sync: JobDeps["sync"]): Promise<JobSnapshot> {
  const store = createJobStore({
    plan: async () => ({ title: "Mix", tracks }),
    inspectIpod: async () => ({ trackCount: 5 }),
    sync,
  });
  const job = store.create("Mix", "/Volumes/IPOD");
  return new Promise((resolve) => {
    job.subscribe((s) => {
      if (s.status === "awaiting-approval") job.approve();
      if (s.status === "done" || s.status === "failed") resolve(s);
    });
  });
}

const summary = (input: SyncInput, added: number): SyncSummary => ({
  playlistName: input.playlistName,
  requested: input.tracks.length,
  added,
  skipped: [],
  dbPath: "/ipod/iTunesDB",
  bytesWritten: 1,
});

describe("end screen", () => {
  it("forced failures: 1 track fails for good, 1 fails once then copies", async () => {
    // Events in the order the real engine sends them; downloadFile makes 3 attempts.
    const end = await runToEnd(async (input) => {
      const ev = input.events!;
      ev.onPhase?.("opening");
      ev.onPhase?.("wiping");
      ev.onPhase?.("downloading");
      ev.onTrackStart?.(0, 3, tracks[0]!);
      ev.onTrackDone?.(0, tracks[0]!);
      ev.onTrackStart?.(1, 3, tracks[1]!);
      ev.onTrackRetry?.(1, tracks[1]!, 1, "HTTP 500");
      ev.onTrackRetry?.(1, tracks[1]!, 2, "HTTP 500");
      ev.onTrackSkipped?.(1, tracks[1]!, "Download failed after 3 attempt(s): HTTP 500");
      ev.onTrackStart?.(2, 3, tracks[2]!);
      ev.onTrackRetry?.(2, tracks[2]!, 1, "socket hang up");
      ev.onTrackDone?.(2, tracks[2]!);
      ev.onPhase?.("writing");
      return summary(input, 2);
    });

    assert.equal(end.status, "done");
    assert.equal(end.skipped.length, 1);
    assert.deepEqual(end.retried, [
      { index: 1, title: "Track 2", retries: 2 },
      { index: 2, title: "Track 3", retries: 1 },
    ]);

    const o = describeOutcome(end);
    assert.equal(o.tone, "warn");
    assert.equal(o.headline, "Sync finished, 1 track missing");
    assert.equal(o.ipodState, "Old music erased. 2 of 3 new tracks on the iPod.");
    assert.match(o.fix!, /Run the sync again to retry 1 track/);
    assert.deepEqual(o.warnings, ["1 track needed retries, then copied."]);
    assert.match(o.safeToUnplug, /^Yes/);
  });

  it("a failure while writing says the iPod shows no music", async () => {
    const end = await runToEnd(async (input) => {
      input.events!.onPhase?.("writing");
      throw new Error("EIO: i/o error, write");
    });
    assert.equal(end.status, "failed");
    assert.equal(end.step, "writing");
    assert.equal(end.ipod, "erased");
    const o = describeOutcome(end);
    assert.equal(o.tone, "bad");
    assert.match(o.ipodState, /iPod shows no music/);
    assert.equal(o.fix, "Run the sync again.");
  });
});

describe("describeOutcome", () => {
  const base: JobSnapshot = {
    id: "j",
    status: "done",
    ipod: "synced",
    playlistName: "Mix",
    mountPath: "/Volumes/IPOD",
    tracksTotal: 3,
    tracksDone: 3,
    bytesDone: 30_000_000,
    skipped: [],
    retried: [],
    plan: { totalBytes: 30_000_000, unknownSizes: 0, ipodTracksNow: 5 },
    updatedAt: "",
  };

  it("a clean sync has no fix and no warnings", () => {
    const o = describeOutcome(base);
    assert.equal(o.tone, "ok");
    assert.equal(o.ipodState, "Old music erased. All 3 new tracks on the iPod.");
    assert.equal(o.fix, undefined);
    assert.deepEqual(o.warnings, []);
  });

  it("does not claim old music was erased when the iPod was empty", () => {
    const o = describeOutcome({ ...base, plan: { ...base.plan!, ipodTracksNow: 0 } });
    assert.equal(o.ipodState, "All 3 new tracks on the iPod.");
  });

  it("unsupported formats get a convert-or-remove fix, not 'run again'", () => {
    const o = describeOutcome({
      ...base,
      tracksDone: 1,
      skipped: [
        { index: 1, title: "A", reason: 'unsupported audio format ".flac". Supported: .mp3' },
        { index: 2, title: "B", reason: 'unsupported audio format ".flac". Supported: .mp3' },
      ],
    });
    assert.equal(o.fix, "Convert 2 tracks to MP3 or AAC in Plex, or remove them from the playlist.");
  });

  it("a failure while opening leaves the iPod unchanged", () => {
    const o = describeOutcome({ ...base, status: "failed", step: "opening", ipod: "untouched", tracksDone: 0 });
    assert.equal(o.ipodState, "Unchanged. Nothing was erased.");
    assert.match(o.fix!, /mounted at \/Volumes\/IPOD/);
  });

  it("a failure while planning leaves the iPod unchanged and points at the inputs", () => {
    const o = describeOutcome({ ...base, status: "failed", step: undefined, ipod: "untouched", tracksDone: 0 });
    assert.equal(o.ipodState, "Unchanged. Nothing was erased.");
    assert.match(o.fix!, /playlist name/);
  });

  it("a failure while wiping says the state is unknown", () => {
    const o = describeOutcome({ ...base, status: "failed", step: "wiping", ipod: "erased", tracksDone: 0 });
    assert.match(o.ipodState, /^Unknown/);
  });
});

describe("live screen", () => {
  it("the doing-now line names the track and its progress", () => {
    const line = describeDoingNow({
      ...({} as JobSnapshot),
      status: "running",
      step: "downloading",
      tracksTotal: 25,
      current: { index: 6, title: "Psychotropia", receivedBytes: 3_200_000, totalBytes: 8_100_000 },
    });
    assert.equal(line, "Downloading 7 of 25: Psychotropia — 3.2 of 8.1 MB");
    const starting = describeDoingNow({
      ...({} as JobSnapshot),
      status: "running",
      step: "downloading",
      tracksTotal: 25,
      current: { index: 6, title: "Psychotropia", receivedBytes: 0 },
    });
    assert.equal(starting, "Downloading 7 of 25: Psychotropia");
  });
});
