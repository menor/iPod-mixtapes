import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countIpodTracks } from "../src/core/ipod.ts";

describe("countIpodTracks", () => {
  it("counts 0 on an iPod with no iTunesDB yet", async (t) => {
    const mount = await mkdtemp(join(tmpdir(), "ipod-count-"));
    t.after(() => rm(mount, { recursive: true, force: true }));
    await mkdir(join(mount, "iPod_Control", "iTunes"), { recursive: true });
    assert.deepEqual(await countIpodTracks(mount), { trackCount: 0 });
  });

  it("throws when the folder is not an iPod", async (t) => {
    const mount = await mkdtemp(join(tmpdir(), "ipod-count-"));
    t.after(() => rm(mount, { recursive: true, force: true }));
    await assert.rejects(countIpodTracks(mount), /no iPod_Control/);
  });
});
