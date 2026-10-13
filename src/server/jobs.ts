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

export class Job {
  readonly id = randomUUID();
  #state: JobSnapshot;
  #tracks: PlexTrackRef[] = [];
  #listeners = new Set<Listener>();
  #lastProgressAt = 0;
  #deps: JobDeps;

  constructor(deps: JobDeps, playlistName: string, mountPath: string) {
    this.#deps = deps;
    this.#state = {
      id: this.id,
      phase: "planning",
      playlistName,
      mountPath,
      tracksTotal: 0,
      tracksDone: 0,
      skipped: [],
      updatedAt: new Date().toISOString(),
    };
  }

  get phase(): JobPhase {
    return this.#state.phase;
  }

  get isActive(): boolean {
    return this.#state.phase !== "done" && this.#state.phase !== "failed";
  }

  snapshot(): JobSnapshot {
    return structuredClone(this.#state);
  }

  /** Sends the current snapshot right away, then every change. Returns an unsubscribe. */
  subscribe(listener: Listener): () => void {
    listener(this.snapshot());
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Fetch the plan, then stop and wait for approve(). Never touches the iPod. */
  async plan(): Promise<void> {
    try {
      const [playlist, ipod] = await Promise.all([
        this.#deps.plan(this.#state.playlistName),
        this.#deps.inspectIpod(this.#state.mountPath),
      ]);
      this.#tracks = playlist.tracks;
      const sizes = playlist.tracks.map((t) => t.sizeBytes);
      this.#update({
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
      this.#fail(err);
    }
  }

  /** Run the engine. The caller checks the phase first; see JobStore.approve. */
  async run(): Promise<void> {
    // Leave awaiting-approval before the first await, so a second approve() is refused.
    this.#update({ phase: "opening" });
    const tempDir = await mkdtemp(join(tmpdir(), "ipod-mixtapes-"));
    try {
      const summary = await this.#deps.sync({
        mountPath: this.#state.mountPath,
        playlistName: this.#state.playlistName,
        tracks: this.#tracks,
        tempDir,
        events: {
          onPhase: (phase) => this.#update({ phase }),
          onBackup: (backupPath) => this.#update({ backupPath }),
          onTrackStart: (index, _total, track) =>
            this.#update({ current: { index, title: track.title, receivedBytes: 0 } }),
          onTrackProgress: (index, receivedBytes, totalBytes) => {
            const current = this.#state.current;
            if (!current || current.index !== index) return;
            this.#update({ current: { ...current, receivedBytes, totalBytes } }, true);
          },
          onTrackDone: () =>
            this.#update({ tracksDone: this.#state.tracksDone + 1, current: undefined }),
          onTrackSkipped: (_index, track, reason) =>
            this.#update({
              skipped: [...this.#state.skipped, { title: track.title, reason }],
              current: undefined,
            }),
        },
      });
      // A partial sync still ends in "done": the iPod holds a valid DB. The skipped
      // list says what is missing; the end screen must make that loud.
      this.#update({ phase: "done", tracksDone: summary.added, current: undefined });
    } catch (err) {
      this.#fail(err);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  #fail(err: unknown): void {
    const error = err instanceof Error ? err.message : String(err);
    this.#update({ phase: "failed", error, current: undefined });
  }

  #update(patch: Partial<JobSnapshot>, isProgress = false): void {
    Object.assign(this.#state, patch, { updatedAt: new Date().toISOString() });
    const now = Date.now();
    if (isProgress && now - this.#lastProgressAt < PROGRESS_INTERVAL_MS) return;
    this.#lastProgressAt = now;
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) listener(snapshot);
  }
}

/** Thrown for requests that do not fit the job's current state. Maps to HTTP 409. */
export class JobConflictError extends Error {}

/** All jobs. One iPod, so at most one active job at a time. */
export class JobStore {
  #jobs = new Map<string, Job>();
  #deps: JobDeps;

  constructor(deps: JobDeps) {
    this.#deps = deps;
  }

  get(id: string): Job | undefined {
    return this.#jobs.get(id);
  }

  /** The newest job. A freshly opened tab uses it to find a running sync. */
  latest(): Job | undefined {
    return [...this.#jobs.values()].at(-1);
  }

  /** Create a job and start planning in the background. */
  create(playlistName: string, mountPath: string): Job {
    const active = [...this.#jobs.values()].find((j) => j.isActive);
    if (active) {
      throw new JobConflictError(`Job ${active.id} is still ${active.phase}.`);
    }
    const job = new Job(this.#deps, playlistName, mountPath);
    this.#jobs.set(job.id, job);
    void job.plan();
    return job;
  }

  /** Start the sync. Only a job waiting for approval can start. */
  approve(job: Job): void {
    if (job.phase !== "awaiting-approval") {
      throw new JobConflictError(`Job ${job.id} is ${job.phase}, not awaiting-approval.`);
    }
    void job.run();
  }
}
