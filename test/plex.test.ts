import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchPlaylist } from "../src/core/plex.ts";
import type { PlexServer } from "@ctrl/plex";

/**
 * A fake PlexServer exposing only what fetchPlaylist touches: library().sections(),
 * section.playlists(), playlist.items(), and url(). Cast to PlexServer for the call.
 */
function fakeServer(playlists: unknown[]): PlexServer {
  const section = { type: "artist", playlists: async () => playlists };
  return {
    library: async () => ({ sections: async () => [section] }),
    url: (key: string, _opts?: unknown) => new URL(`https://plex.test${key}?X-Plex-Token=tok`),
  } as unknown as PlexServer;
}

function fakePlaylist(title: string, items: unknown[]) {
  return { title, ratingKey: `pl-${title}`, playlistType: "audio", items: async () => items };
}

function fakeTrack(over: Record<string, unknown> = {}) {
  return {
    ratingKey: "55123",
    title: "Song One",
    grandparentTitle: "Artist A",
    parentTitle: "Album A",
    duration: 210000,
    media: [{ parts: [{ key: "/library/parts/1/file.mp3", container: "mp3", size: 5_000_000 }] }],
    ...over,
  };
}

describe("fetchPlaylist", () => {
  it("normalizes tracks and builds an authenticated download URL", async () => {
    const server = fakeServer([fakePlaylist("Roadtrip", [fakeTrack()])]);

    const pl = await fetchPlaylist(server, "roadtrip"); // case-insensitive

    assert.equal(pl.title, "Roadtrip");
    assert.equal(pl.tracks.length, 1);
    const t = pl.tracks[0]!;
    assert.partialDeepStrictEqual(t, {
      ratingKey: "55123",
      title: "Song One",
      artist: "Artist A",
      album: "Album A",
      durationMs: 210000,
      container: "mp3",
      sizeBytes: 5_000_000,
    });
    assert.ok(t.downloadUrl.includes("/library/parts/1/file.mp3"));
    assert.ok(t.downloadUrl.includes("X-Plex-Token=tok"));
  });

  it("throws naming available audio playlists when the name is unknown", async () => {
    const server = fakeServer([
      fakePlaylist("Roadtrip", [fakeTrack()]),
      fakePlaylist("Chill", [fakeTrack()]),
    ]);

    await assert.rejects(fetchPlaylist(server, "Nope"), /"Chill", "Roadtrip"/);
  });

  it("fails loudly when a track has no downloadable part", async () => {
    const server = fakeServer([
      fakePlaylist("Roadtrip", [fakeTrack({ media: [{ parts: [] }] })]),
    ]);

    await assert.rejects(fetchPlaylist(server, "Roadtrip"), /no media part/);
  });
});
