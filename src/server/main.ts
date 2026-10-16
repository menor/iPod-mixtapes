/**
 * Starts the local sync server: real Plex + real engine behind the job store.
 *
 *   npm run serve            (PORT, HOST and MOUNT override the defaults; see config.ts)
 *
 * Binds to localhost only. There is no auth: anyone who can reach the port can
 * wipe the iPod.
 *
 * Ctrl-C (or SIGTERM) during a sync waits for it to finish, because stopping partway
 * can leave the iPod erased with no track list. A second signal stops at once.
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
const server = createJobServer(store, { defaultMount: config.ipod.defaultMount });
server.listen(port, host, () => {
  process.stdout.write(`Listening on http://${host}:${port}\n`);
});

let waiting = false;

function onSignal(): void {
  const job = store.latest();
  if (waiting) return stop(1); // forced: the iPod may be left with no music
  if (!job?.isWritingToIpod()) return stop(0);
  waiting = true;
  process.stdout.write(
    `\nA sync is ${job.phase()}. Stopping now can leave the iPod with no music.\n` +
      `Waiting for it to finish. Press Ctrl-C again to stop now.\n`,
  );
  job.subscribe((s) => {
    if (s.phase === "done" || s.phase === "failed") stop(0);
  });
}

function stop(code: number): void {
  // Open event streams keep close() waiting, so end them too.
  server.close(() => process.exit(code));
  server.closeAllConnections();
}

process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
