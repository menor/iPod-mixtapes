import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTrack, openIpod, save } from "podscribe";
import type { PlexTrackRef } from "../src/core/plex.ts";
import { syncPlaylistToIpod, type SyncEvents } from "../src/core/sync.ts";
import { countIpodTracks } from "../src/core/ipod.ts";

/** A fake iPod folder holding 1 old track, plus a temp folder for downloads. */
async function setup(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "sync-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mount = join(root, "ipod");
  await mkdir(join(mount, "iPod_Control", "iTunes"), { recursive: true });
  const old = join(root, "old.mp3");
  await writeFile(old, Buffer.alloc(2000, 1));
  const db = openIpod(mount);
  await addTrack(db, old, { meta: { title: "Old song" } });
  const { dbPath } = save(db, { backup: false });
  return { mount, dbPath, tempDir: join(root, "temp") };
}

/** Plex stand-in: /ok/* sends 2000 bytes of fake MP3, anything else is a 500. */
async function plexStub(t: { after(fn: () => void): void }) {
  const requested: string[] = [];
  const server = http.createServer((req, res) => {
    requested.push(req.url!);
    if (req.url!.startsWith("/ok/")) res.end(Buffer.alloc(2000, 2));
    else res.writeHead(500).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, requested };
}

/** Every event as one short string, in the order the engine sent them. */
function recorder() {
  const log: string[] = [];
  const events: SyncEvents = {
    onPhase: (p) => log.push(p),
    onTrackDone: (i) => log.push(`done ${i}`),
    onTrackSkipped: (i) => log.push(`skipped ${i}`),
  };
  return { log, events };
}

describe("syncPlaylistToIpod", () => {
  it("downloads every track before it erases the iPod", async (t) => {
    const { mount, tempDir } = await setup(t);
    const plex = await plexStub(t);
    const tracks: PlexTrackRef[] = [
      { ratingKey: "1", title: "One", downloadUrl: `${plex.base}/ok/1`, container: "mp3" },
      { ratingKey: "2", title: "Two", downloadUrl: `${plex.base}/ok/2`, container: "flac" },
      { ratingKey: "3", title: "Three", downloadUrl: `${plex.base}/ok/3`, container: "mp3" },
    ];
    const { log, events } = recorder();

    const summary = await syncPlaylistToIpod({ mountPath: mount, playlistName: "Mix", tracks, tempDir, events });

    assert.deepEqual(log, [
      "opening",
      "downloading",
      "done 0",
      "skipped 1",
      "done 2",
      "wiping",
      "copying",
      "writing",
    ]);
    // The format check runs before the download, so the .flac is never fetched.
    assert.deepEqual(plex.requested, ["/ok/1", "/ok/3"]);
    assert.match(summary.skipped[0]!.reason, /unsupported audio format "\.flac"/);
    assert.equal(summary.added, 2);
    assert.deepEqual(await countIpodTracks(mount), { trackCount: 2 });
  });

  it("leaves the iPod untouched when no track downloads", async (t) => {
    const { mount, dbPath, tempDir } = await setup(t);
    const plex = await plexStub(t);
    const before = await readFile(dbPath);
    const tracks: PlexTrackRef[] = [{ ratingKey: "1", title: "One", downloadUrl: `${plex.base}/fail/1` }];
    const { log, events } = recorder();

    // downloadFile retries with real delays, so this test takes about 3 seconds.
    await assert.rejects(
      syncPlaylistToIpod({ mountPath: mount, playlistName: "Mix", tracks, tempDir, events }),
      /No track downloaded/,
    );

    assert.deepEqual(log, ["opening", "downloading", "skipped 0"]);
    assert.deepEqual(await readFile(dbPath), before);
    assert.deepEqual(await countIpodTracks(mount), { trackCount: 1 });
  });
});
