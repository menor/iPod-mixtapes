/**
 * The job snapshot the server streams to the browser. Types only, no imports, so
 * both the server (TypeScript) and the browser (JSDoc, checkJs) can load this file.
 */

/**
 * The engine's phases, in order. A fixed set so callers can map them (CLI labels,
 * server job phases). Backup and wipe are one phase: podscribe's wipeAll does both.
 */
export type SyncPhase = "opening" | "wiping" | "downloading" | "writing";

/**
 * planning → awaiting-approval → opening → wiping → downloading → writing → done
 * Any step can end in failed. Nothing touches the iPod before approval.
 */
export type JobPhase = "planning" | "awaiting-approval" | SyncPhase | "done" | "failed";

export interface JobSnapshot {
  id: string;
  phase: JobPhase;
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
  /** Why the job failed, when phase is "failed". */
  error?: string;
  /** The phase the job was in when it failed. Tells what happened to the iPod. */
  failedIn?: JobPhase;
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
