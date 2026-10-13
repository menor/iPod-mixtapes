/**
 * Read-only look at an iPod, for the plan preview. Never writes.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { openIpod, readItunesDb } from "podscribe";

/** Count the tracks in the iPod's iTunesDB. A missing DB means a fresh iPod: 0. */
export async function countIpodTracks(mountPath: string): Promise<{ trackCount: number }> {
  const { dbPath } = openIpod(mountPath); // throws when there is no iPod_Control
  if (!existsSync(dbPath)) return { trackCount: 0 };
  return { trackCount: readItunesDb(await readFile(dbPath)).tracks.length };
}
