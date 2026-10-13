/**
 * Starts the local sync server: real Plex + real engine behind the job store.
 *
 *   npm run serve            (PORT, HOST and MOUNT env vars override the defaults)
 *
 * MOUNT only prefills the form. It defaults to ./fake-ipod, so the real iPod is
 * never the target by accident.
 *
 * Binds to localhost only. There is no auth: anyone who can reach the port can
 * wipe the iPod.
 */
import { loadPlexConfig } from "../config.ts";
import { countIpodTracks } from "../core/ipod.ts";
import { connectPlex, fetchPlaylist } from "../core/plex.ts";
import { syncPlaylistToIpod } from "../core/sync.ts";
import { createJobServer } from "./http.ts";
import { JobStore } from "./jobs.ts";

const port = Number(process.env.PORT ?? 4573);
const host = process.env.HOST ?? "127.0.0.1";
const defaultMount = process.env.MOUNT ?? "./fake-ipod";

const config = loadPlexConfig();
process.stdout.write(`Connecting to Plex at ${config.baseUrl} ...\n`);
const plex = await connectPlex(config);

const store = new JobStore({
  plan: (playlistName) => fetchPlaylist(plex, playlistName),
  inspectIpod: countIpodTracks,
  sync: syncPlaylistToIpod,
});

createJobServer(store, { defaultMount }).listen(port, host, () => {
  process.stdout.write(`Listening on http://${host}:${port}\n`);
});
