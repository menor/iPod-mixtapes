/**
 * Plex -> iPod sync engine (iteration 1: wipe-and-rebuild).
 *
 * Strategy: the iPod is a disposable mirror of one Plex playlist. Each run backs up
 * the existing iTunesDB (via podscribe's wipeAll), erases the device, downloads every
 * playlist track in Plex order, and writes a fresh DB. Order matches Plex by
 * construction. A future iteration 2 will reuse on-device audio and download only new
 * tracks (see the project plan) — this module is the seam where that swaps in.
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
import { downloadFile } from "./download.js";
import type { PlexTrackRef } from "./plex.js";

export interface SyncEvents {
  /** Coarse phase changes, e.g. "opening iPod", "wiping", "downloading". */
  onPhase?: (phase: string) => void;
  /** The timestamped backup path of the pre-wipe iTunesDB, or undefined if none. */
  onBackup?: (backupPath: string | undefined) => void;
  onTrackStart?: (index: number, total: number, track: PlexTrackRef) => void;
  onTrackProgress?: (index: number, received: number, total?: number) => void;
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
  /** Folder for transient downloads. Caller cleans it up after a successful run. */
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

export async function syncPlaylistToIpod(input: SyncInput): Promise<SyncSummary> {
  const { mountPath, playlistName, tracks, tempDir, libraryName, events } = input;

  events?.onPhase?.("opening iPod");
  const db = openIpod(mountPath, libraryName ? { libraryName } : {});

  // wipeAll backs up the existing DB BEFORE deleting anything, then erases the
  // device. That single backup satisfies the "back up before any write" rule, so
  // the later save() skips its own backup (the original DB is already gone).
  events?.onPhase?.("backing up + wiping iPod");
  const backupPath = wipeAll(db, { confirm: true });
  events?.onBackup?.(backupPath);

  await mkdir(tempDir, { recursive: true });

  const playlist = getOrCreatePlaylist(db, playlistName);
  const skipped: SkippedTrack[] = [];
  let added = 0;

  events?.onPhase?.("downloading tracks");
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i]!;
    events?.onTrackStart?.(i, tracks.length, track);

    const ext = (track.container ?? "mp3").replace(/^\./, "");
    const tempPath = join(tempDir, `${track.ratingKey}.${ext}`);

    try {
      await downloadFile(track.downloadUrl, tempPath, {
        onProgress: (p) => events?.onTrackProgress?.(i, p.received, p.total),
      });

      // addTrack copies the file in, probes the file for stream info, and registers
      // it on the master playlist. Stamp the ratingKey so iteration 2 can match by
      // identity. Overlay Plex's metadata via `meta`: many source files carry no ID3
      // tags, so the file probe alone would write blank title/artist/album. Plex is
      // the source of truth here; only defined fields override the probe.
      const ipodTrack = await addTrack(db, tempPath, {
        comment: `PLEXID:${track.ratingKey}`,
        meta: {
          title: track.title,
          artist: track.artist,
          album: track.album,
        },
      });
      addToPlaylist(playlist, ipodTrack);

      added++;
      events?.onTrackDone?.(i, track);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      skipped.push({ track, reason });
      events?.onTrackSkipped?.(i, track, reason);
    }
  }

  events?.onPhase?.("writing iTunesDB");
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
