/**
 * Sync jobs, kept in server memory.
 *
 * A job is one "sync playlist P to the iPod at M" request. It has an id and a phase,
 * and it outlives any browser tab watching it. Watchers subscribe and receive the
 * FULL snapshot on every change — first the current state, then each update. That
 * one rule is what makes close-the-tab-and-reopen work.
 *
 * The engine and Plex are injected (JobDeps), so tests drive a job with stubs and
 * never touch a disk or the network.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlexPlaylistRef, PlexTrackRef } from "../core/plex.ts";
import type { SyncInput, SyncSummary } from "../core/sync.ts";
import type { JobPhase, JobSnapshot } from "../shared/job.ts";

export type { JobPhase, JobSnapshot, PlanPreview } from "../shared/job.ts";

export interface JobDeps {
  /** Look up the playlist and its tracks. Throws when it does not exist. */
  plan(playlistName: string): Promise<PlexPlaylistRef>;
  /** Count the tracks on the iPod. Read-only. Throws when the mount is not an iPod. */
  inspectIpod(mountPath: string): Promise<{ trackCount: number }>;
  /** Run the engine. Production passes syncPlaylistToIpod. */
  sync(input: SyncInput): Promise<SyncSummary>;
}

type Listener = (snapshot: JobSnapshot) => void;

/** Download progress fires per chunk; send at most one progress update per this window. */
const PROGRESS_INTERVAL_MS = 250;

export type Job = ReturnType<typeof createJob>;

function createJob(deps: JobDeps, playlistName: string, mountPath: string) {
  const state: JobSnapshot = {
    id: randomUUID(),
    phase: "planning",
    playlistName,
    mountPath,
    tracksTotal: 0,
    tracksDone: 0,
    bytesDone: 0,
    skipped: [],
    retried: [],
    updatedAt: new Date().toISOString(),
  };
  const listeners = new Set<Listener>();
  let tracks: PlexTrackRef[] = [];
  let lastProgressAt = 0;

  function snapshot(): JobSnapshot {
    return structuredClone(state);
  }

  /** Sends the current snapshot right away, then every change. Returns an unsubscribe. */
  function subscribe(listener: Listener): () => void {
    listener(snapshot());
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** Fetch the plan, then stop and wait for approve(). Never touches the iPod. */
  async function plan(): Promise<void> {
    try {
      const [playlist, ipod] = await Promise.all([
        deps.plan(state.playlistName),
        deps.inspectIpod(state.mountPath),
      ]);
      tracks = playlist.tracks;
      const sizes = playlist.tracks.map((t) => t.sizeBytes);
      update({
        phase: "awaiting-approval",
        playlistName: playlist.title,
        tracksTotal: playlist.tracks.length,
        plan: {
          totalBytes: sizes.reduce<number>((sum, n) => sum + (n ?? 0), 0),
          unknownSizes: sizes.filter((n) => n === undefined).length,
          ipodTracksNow: ipod.trackCount,
        },
      });
    } catch (err) {
      fail(err);
    }
  }

  /** Run the engine. The caller checks the phase first; see the store's approve. */
  async function run(): Promise<void> {
    // Leave awaiting-approval before the first await, so a second approve() is refused.
    update({ phase: "opening" });
    const tempDir = await mkdtemp(join(tmpdir(), "ipod-mixtapes-"));
    try {
      const summary = await deps.sync({
        mountPath: state.mountPath,
        playlistName: state.playlistName,
        tracks,
        tempDir,
        events: {
          onPhase: (phase) => update({ phase }),
          onBackup: (backupPath) => update({ backupPath }),
          onTrackStart: (index, _total, track) =>
            update({ current: { index, title: track.title, receivedBytes: 0 } }),
          onTrackProgress: (index, receivedBytes, totalBytes) => {
            const current = state.current;
            if (!current || current.index !== index) return;
            update({ current: { ...current, receivedBytes, totalBytes } }, true);
          },
          onTrackRetry: (index, track) => {
            const others = state.retried.filter((r) => r.index !== index);
            const retries = (state.retried.find((r) => r.index === index)?.retries ?? 0) + 1;
            const current = state.current && { ...state.current, receivedBytes: 0 };
            update({ retried: [...others, { index, title: track.title, retries }], current });
          },
          onTrackDone: () =>
            update({
              tracksDone: state.tracksDone + 1,
              bytesDone: state.bytesDone + (state.current?.receivedBytes ?? 0),
              current: undefined,
            }),
          onTrackSkipped: (index, track, reason) =>
            update({
              skipped: [...state.skipped, { index, title: track.title, reason }],
              current: undefined,
            }),
        },
      });
      // A partial sync still ends in "done": the iPod holds a valid DB. The skipped
      // list says what is missing; the end screen must make that loud.
      update({ phase: "done", tracksDone: summary.added, current: undefined });
    } catch (err) {
      fail(err);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  function fail(err: unknown): void {
    const error = err instanceof Error ? err.message : String(err);
    update({ phase: "failed", failedIn: state.phase, error, current: undefined });
  }

  function update(patch: Partial<JobSnapshot>, isProgress = false): void {
    Object.assign(state, patch, { updatedAt: new Date().toISOString() });
    const now = Date.now();
    if (isProgress && now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
    lastProgressAt = now;
    const s = snapshot();
    for (const listener of listeners) listener(s);
  }

  return {
    id: state.id,
    phase: (): JobPhase => state.phase,
    isActive: () => state.phase !== "done" && state.phase !== "failed",
    snapshot,
    subscribe,
    plan,
    run,
  };
}

/** Thrown for requests that do not fit the job's current state. Maps to HTTP 409. */
export class JobConflictError extends Error {}

export type JobStore = ReturnType<typeof createJobStore>;

/** All jobs. One iPod, so at most one active job at a time. */
export function createJobStore(deps: JobDeps) {
  const jobs = new Map<string, Job>();

  return {
    get: (id: string): Job | undefined => jobs.get(id),

    /** The newest job. A freshly opened tab uses it to find a running sync. */
    latest: (): Job | undefined => [...jobs.values()].at(-1),

    /** Create a job and start planning in the background. */
    create(playlistName: string, mountPath: string): Job {
      const active = [...jobs.values()].find((j) => j.isActive());
      if (active) {
        throw new JobConflictError(`Job ${active.id} is still ${active.phase()}.`);
      }
      const job = createJob(deps, playlistName, mountPath);
      jobs.set(job.id, job);
      void job.plan();
      return job;
    },

    /** Start the sync. Only a job waiting for approval can start. */
    approve(job: Job): void {
      if (job.phase() !== "awaiting-approval") {
        throw new JobConflictError(`Job ${job.id} is ${job.phase()}, not awaiting-approval.`);
      }
      void job.run();
    },
  };
}
