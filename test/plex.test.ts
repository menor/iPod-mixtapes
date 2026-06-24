import { describe, it, expect } from "bun:test";
import { fetchPlaylist } from "../src/core/plex.js";
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

    expect(pl.title).toBe("Roadtrip");
    expect(pl.tracks).toHaveLength(1);
    const t = pl.tracks[0]!;
    expect(t).toMatchObject({
      ratingKey: "55123",
      title: "Song One",
      artist: "Artist A",
      album: "Album A",
      durationMs: 210000,
      container: "mp3",
      sizeBytes: 5_000_000,
    });
    expect(t.downloadUrl).toContain("/library/parts/1/file.mp3");
    expect(t.downloadUrl).toContain("X-Plex-Token=tok");
  });

  it("throws naming available audio playlists when the name is unknown", async () => {
    const server = fakeServer([
      fakePlaylist("Roadtrip", [fakeTrack()]),
      fakePlaylist("Chill", [fakeTrack()]),
    ]);

    await expect(fetchPlaylist(server, "Nope")).rejects.toThrow(/"Chill", "Roadtrip"/);
  });

  it("fails loudly when a track has no downloadable part", async () => {
    const server = fakeServer([
      fakePlaylist("Roadtrip", [fakeTrack({ media: [{ parts: [] }] })]),
    ]);

    await expect(fetchPlaylist(server, "Roadtrip")).rejects.toThrow(/no media part/);
  });
});
