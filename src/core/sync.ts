/**
 * Plex -> iPod sync engine (iteration 1: wipe-and-rebuild).
 *
 * Strategy: the iPod is a disposable mirror of one Plex playlist. Each run downloads
 * every playlist track to the Mac first, then backs up the existing iTunesDB and
 * erases the device (podscribe's wipeAll), copies the downloads in Plex order, and
 * writes a fresh DB. Downloading first means a slow or broken network never leaves
 * the iPod erased: the iPod is only touched once the files are on the Mac. A future
 * iteration 2 will reuse on-device audio and download only new tracks (see the
 * project plan) — this module is the seam where that swaps in.
 *
 * UI-agnostic: progress is emitted through `events`; nothing here writes to a console.
 * Failures to download or add a track are recorded and reported, never silently
 * dropped — the caller exits non-zero when `skipped` is non-empty.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  openIpod,
  wipeAll,
  addTrack,
  getOrCreatePlaylist,
  addToPlaylist,
  save,
} from "podscribe";
import { downloadFile } from "./download.ts";
import type { PlexTrackRef } from "./plex.ts";
import type { SyncPhase } from "../shared/job.ts";

export type { SyncPhase };

export interface SyncEvents {
  onPhase?: (phase: SyncPhase) => void;
  /** The timestamped backup path of the pre-wipe iTunesDB, or undefined if none. */
  onBackup?: (backupPath: string | undefined) => void;
  onTrackStart?: (index: number, total: number, track: PlexTrackRef) => void;
  onTrackProgress?: (index: number, received: number, total?: number) => void;
  /** A download attempt failed and will be retried. */
  onTrackRetry?: (index: number, track: PlexTrackRef, attempt: number, reason: string) => void;
  /** The track is downloaded to the Mac. It reaches the iPod in the copying phase. */
  onTrackDone?: (index: number, track: PlexTrackRef) => void;
  onTrackSkipped?: (index: number, track: PlexTrackRef, reason: string) => void;
}

export interface SyncInput {
  /** Mounted iPod volume path, e.g. "/Volumes/IPOD". */
  mountPath: string;
  /** Playlist name to create on the iPod (usually the Plex playlist title). */
  playlistName: string;
  /** Plex tracks, already in the desired order. */
  tracks: PlexTrackRef[];
  /** Folder for the downloads. Holds the whole playlist at once. The caller removes it. */
  tempDir: string;
  /** Master/library playlist name. Defaults to podscribe's "iPod". */
  libraryName?: string;
  events?: SyncEvents;
}

export interface SkippedTrack {
  track: PlexTrackRef;
  reason: string;
}

export interface SyncSummary {
  playlistName: string;
  requested: number;
  added: number;
  skipped: SkippedTrack[];
  backupPath?: string;
  dbPath: string;
  bytesWritten: number;
}

/**
 * Extensions the iPod plays, as podscribe's addTrack accepts them. Checked before the
 * download, so a .flac costs no bandwidth and is reported before anything is erased.
 * podscribe does not export its list; keep this in step with SUPPORTED in its ipodLib.
 */
const SUPPORTED_EXTENSIONS = [".mp3", ".m4a", ".aac", ".mp4", ".wav", ".aif", ".aiff"];

export async function syncPlaylistToIpod(input: SyncInput): Promise<SyncSummary> {
  const { mountPath, playlistName, tracks, tempDir, libraryName, events } = input;
  const skipped: SkippedTrack[] = [];
  const skip = (i: number, track: PlexTrackRef, err: unknown) => {
    const reason = err instanceof Error ? err.message : String(err);
    skipped.push({ track, reason });
    events?.onTrackSkipped?.(i, track, reason);
  };

  // openIpod only reads. It fails fast when the mount is not an iPod.
  events?.onPhase?.("opening");
  const db = openIpod(mountPath, libraryName ? { libraryName } : {});

  await mkdir(tempDir, { recursive: true });
  const downloaded: { index: number; track: PlexTrackRef; path: string }[] = [];

  events?.onPhase?.("downloading");
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i]!;
    events?.onTrackStart?.(i, tracks.length, track);
    const ext = `.${(track.container ?? "mp3").replace(/^\./, "")}`;
    const path = join(tempDir, `${track.ratingKey}${ext}`);
    try {
      if (!SUPPORTED_EXTENSIONS.includes(ext.toLowerCase())) {
        throw new Error(`unsupported audio format "${ext}". Supported: ${SUPPORTED_EXTENSIONS.join(", ")}`);
      }
      await downloadFile(track.downloadUrl, path, {
        onProgress: (p) => events?.onTrackProgress?.(i, p.received, p.total),
        onRetry: (attempt, reason) => events?.onTrackRetry?.(i, track, attempt, reason),
      });
      downloaded.push({ index: i, track, path });
      events?.onTrackDone?.(i, track);
    } catch (err) {
      skip(i, track, err);
    }
  }

  // Erasing for nothing would leave the iPod empty. Stop while it is still unchanged.
  if (tracks.length > 0 && downloaded.length === 0) {
    throw new Error("No track downloaded. The iPod was not changed.");
  }

  // wipeAll backs up the existing DB BEFORE deleting anything, then erases the
  // device. That single backup satisfies the "back up before any write" rule, so
  // the later save() skips its own backup (the original DB is already gone).
  events?.onPhase?.("wiping");
  const backupPath = wipeAll(db, { confirm: true });
  events?.onBackup?.(backupPath);

  const playlist = getOrCreatePlaylist(db, playlistName);
  let added = 0;

  events?.onPhase?.("copying");
  for (const { index, track, path } of downloaded) {
    try {
      // addTrack copies the file in, probes the file for stream info, and registers
      // it on the master playlist. Stamp the ratingKey so iteration 2 can match by
      // identity. Overlay Plex's metadata via `meta`: many source files carry no ID3
      // tags, so the file probe alone would write blank title/artist/album. Plex is
      // the source of truth here; only defined fields override the probe.
      const ipodTrack = await addTrack(db, path, {
        comment: `PLEXID:${track.ratingKey}`,
        meta: {
          title: track.title,
          artist: track.artist,
          album: track.album,
        },
      });
      addToPlaylist(playlist, ipodTrack);
      added++;
    } catch (err) {
      skip(index, track, err);
    }
  }

  events?.onPhase?.("writing");
  const result = save(db, { backup: false });

  return {
    playlistName,
    requested: tracks.length,
    added,
    skipped,
    backupPath,
    dbPath: result.dbPath,
    bytesWritten: result.bytesWritten,
  };
}
