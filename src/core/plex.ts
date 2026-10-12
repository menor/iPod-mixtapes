/**
 * UI-agnostic Plex access layer.
 *
 * Wraps @ctrl/plex behind a tiny, normalized surface so the rest of the project
 * (and a future webapp) never touches the library's types directly. No console
 * or process access lives here — callers pass config in and get plain data back.
 */
import { PlexServer } from "@ctrl/plex";
import type { PlexConfig } from "../config.ts";

/** A Plex playlist reduced to what sync needs: identity + ordered members. */
export interface PlexPlaylistRef {
  title: string;
  ratingKey?: string;
  tracks: PlexTrackRef[];
}

/** One playlist member, normalized away from @ctrl/plex's Track class. */
export interface PlexTrackRef {
  /** Stable identity across syncs. Stamped on the iPod as PLEXID:<ratingKey>. */
  ratingKey: string;
  title: string;
  artist?: string;
  album?: string;
  durationMs?: number;
  /** Source container/extension, e.g. "mp3". */
  container?: string;
  sizeBytes?: number;
  /** Authenticated URL to fetch the original (untranscoded) file. */
  downloadUrl: string;
}

/**
 * Connect to the remote Plex server and VERIFY the connection before returning.
 * Verification is a real round-trip (fetch the library), so bad URL/token fails
 * here with a clear message rather than deep inside a later sync step.
 */
export async function connectPlex(config: PlexConfig): Promise<PlexServer> {
  const server = new PlexServer(config.baseUrl, config.token);
  try {
    await server.library();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not reach Plex at ${config.baseUrl}: ${reason}\n` +
        `Check PLEX_BASE_URL and PLEX_TOKEN are correct and the server is reachable.`,
    );
  }
  return server;
}

/**
 * Find a playlist by exact, case-insensitive title and return its tracks in order.
 * Throws — naming the available audio playlists — when no match exists, so a typo
 * surfaces loudly instead of silently syncing an empty set.
 */
export async function fetchPlaylist(
  server: PlexServer,
  name: string,
): Promise<PlexPlaylistRef> {
  const playlists = await allPlaylists(server);

  const wanted = name.trim().toLowerCase();
  const match = playlists.find((p) => (p.title ?? "").trim().toLowerCase() === wanted);

  if (!match) {
    const audioNames = playlists
      .filter((p) => p.playlistType === "audio")
      .map((p) => `"${p.title}"`)
      .sort();
    throw new Error(
      `No Plex playlist named "${name}". Available audio playlists: ` +
        (audioNames.length ? audioNames.join(", ") : "(none found)"),
    );
  }

  const items = await match.items();
  const tracks: PlexTrackRef[] = [];

  for (const item of items) {
    const track = item as {
      ratingKey?: string;
      title?: string;
      grandparentTitle?: string;
      parentTitle?: string;
      duration?: number;
      media?: Array<{ parts?: Array<{ key?: string; container?: string; size?: number }> }>;
    };

    const ratingKey = track.ratingKey;
    const part = track.media?.[0]?.parts?.[0];

    // A playlist member with no ratingKey or no downloadable part can't be synced
    // by identity — fail loudly naming the title rather than skipping in silence.
    if (!ratingKey) {
      throw new Error(`Plex track "${track.title ?? "(untitled)"}" has no ratingKey.`);
    }
    if (!part?.key) {
      throw new Error(
        `Plex track "${track.title ?? ratingKey}" has no media part to download.`,
      );
    }

    tracks.push({
      ratingKey,
      title: track.title ?? "(untitled)",
      artist: track.grandparentTitle,
      album: track.parentTitle,
      durationMs: track.duration,
      container: part.container,
      sizeBytes: part.size,
      downloadUrl: server.url(part.key, { includeToken: true }).toString(),
    });
  }

  return { title: match.title ?? name, ratingKey: match.ratingKey, tracks };
}

/**
 * All playlists visible on the server. @ctrl/plex exposes playlists per library
 * section, so we gather across sections and dedupe by ratingKey — a playlist can
 * surface from more than one section depending on server configuration.
 */
async function allPlaylists(server: PlexServer): Promise<PlexPlaylist[]> {
  const library = await server.library();
  const sections = await library.sections();

  const byKey = new Map<string, PlexPlaylist>();
  for (const section of sections) {
    let sectionPlaylists: PlexPlaylist[];
    try {
      sectionPlaylists = (await section.playlists()) as unknown as PlexPlaylist[];
    } catch {
      continue; // a section type without playlists — skip, don't abort.
    }
    for (const pl of sectionPlaylists) {
      byKey.set(pl.ratingKey ?? pl.title ?? Math.random().toString(), pl);
    }
  }
  return [...byKey.values()];
}

/** The slice of @ctrl/plex's Playlist class this module relies on. */
interface PlexPlaylist {
  title?: string;
  ratingKey?: string;
  playlistType?: string;
  items(): Promise<unknown[]>;
}
