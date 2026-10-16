/**
 * Starts the local sync server: real Plex + real engine behind the job store.
 *
 *   npm run serve            (PORT, HOST and MOUNT override the defaults; see config.ts)
 *
 * Binds to localhost only. There is no auth: anyone who can reach the port can
 * wipe the iPod.
 */
import { loadConfig } from "../config.ts";
import { countIpodTracks } from "../core/ipod.ts";
import { connectPlex, fetchPlaylist } from "../core/plex.ts";
import { syncPlaylistToIpod } from "../core/sync.ts";
import { createJobServer } from "./http.ts";
import { createJobStore } from "./jobs.ts";

const config = loadConfig();
process.stdout.write(`Connecting to Plex at ${config.plex.baseUrl} ...\n`);
const plex = await connectPlex(config.plex);

const store = createJobStore({
  plan: (playlistName) => fetchPlaylist(plex, playlistName),
  inspectIpod: countIpodTracks,
  sync: syncPlaylistToIpod,
});

const { port, host } = config.server;
createJobServer(store, { defaultMount: config.ipod.defaultMount }).listen(port, host, () => {
  process.stdout.write(`Listening on http://${host}:${port}\n`);
});

