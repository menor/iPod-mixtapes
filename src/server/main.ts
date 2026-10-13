/**
 * Starts the local sync server: real Plex + real engine behind the job store.
 *
 *   npm run serve            (PORT and HOST env vars override the defaults)
 *
 * Binds to localhost only. There is no auth: anyone who can reach the port can
 * wipe the iPod.
 */
import { loadPlexConfig } from "../config.ts";
import { connectPlex, fetchPlaylist } from "../core/plex.ts";
import { syncPlaylistToIpod } from "../core/sync.ts";
import { createJobServer } from "./http.ts";
import { JobStore } from "./jobs.ts";

const port = Number(process.env.PORT ?? 4573);
const host = process.env.HOST ?? "127.0.0.1";

const config = loadPlexConfig();
process.stdout.write(`Connecting to Plex at ${config.baseUrl} ...\n`);
const plex = await connectPlex(config);

const store = new JobStore({
  plan: (playlistName) => fetchPlaylist(plex, playlistName),
  sync: syncPlaylistToIpod,
});

createJobServer(store).listen(port, host, () => {
  process.stdout.write(`Listening on http://${host}:${port}\n`);
});
