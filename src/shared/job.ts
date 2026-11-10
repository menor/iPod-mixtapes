/**
 * The job snapshot the server streams to the browser. Types only, no imports, so
 * both the server (TypeScript) and the browser (JSDoc, checkJs) can load this file.
 */

/**
 * The engine's phases, in order. A fixed set so callers can map them (CLI labels,
 * the job's step). Backup and wipe are one phase: podscribe's wipeAll does both.
 */
export type SyncPhase = "opening" | "wiping" | "downloading" | "writing";

/**
 * planning → awaiting-approval → running → done
 * Any status before done can end in failed. Nothing touches the iPod before approval.
 * While running, `step` says which SyncPhase the engine is in.
 */
export type JobStatus = "planning" | "awaiting-approval" | "running" | "done" | "failed";

/**
 * What the job has done to the iPod. An actor can restart; the iPod cannot, so the
 * job records the outside effect instead of making the end screen guess it.
 *   untouched — nothing erased yet
 *   erased    — the wipe started: old music may be partly or fully gone
 *   synced    — a fresh track list was saved
 */
export type IpodState = "untouched" | "erased" | "synced";

export interface JobSnapshot {
  id: string;
  status: JobStatus;
  /** The engine step while running; after a failure, the step it failed in. */
  step?: SyncPhase;
  ipod: IpodState;
  /** The playlist name as requested; replaced by Plex's exact title after planning. */
  playlistName: string;
  mountPath: string;
  tracksTotal: number;
  tracksDone: number;
  /** Bytes of finished tracks copied to the iPod. */
  bytesDone: number;
  /** The track being downloaded now, if any. */
  current?: { index: number; title: string; receivedBytes: number; totalBytes?: number };
  skipped: { index: number; title: string; reason: string }[];
  /** Tracks whose download failed at least once. A track can be here and in skipped. */
  retried: { index: number; title: string; retries: number }[];
  backupPath?: string;
  /** What approval will do. Set when planning finishes. */
  plan?: PlanPreview;
  /** Why the job failed, when status is "failed". */
  error?: string;
  updatedAt: string;
}

export interface PlanPreview {
  /** Sum of the known track sizes. A lower bound when unknownSizes > 0. */
  totalBytes: number;
  /** Tracks Plex reports no size for. */
  unknownSizes: number;
  /** Tracks on the iPod now. The wipe erases all of them. */
  ipodTracksNow: number;
}
