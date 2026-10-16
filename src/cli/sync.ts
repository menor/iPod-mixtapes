#!/usr/bin/env node
/**
 * Thin CLI over the UI-agnostic core (src/core). It parses args, prints progress,
 * and sets the exit code — all sync logic lives in the core so a future webapp can
 * reuse it unchanged.
 *
 *   ipod-mixtapes <plex-playlist> --mount /Volumes/IPOD [options]
 *
 * Options:
 *   --mount <path>     Mounted iPod volume (required), e.g. /Volumes/IPOD
 *   --name <name>      Playlist name to create on the iPod (default: Plex title)
 *   --temp <dir>       Download folder (default: a temp dir, removed after success)
 *   --keep-temp        Keep the download folder (for debugging)
 *   --env <path>       .env file to load (default: .env)
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { connectPlex, fetchPlaylist } from "../core/plex.ts";
import { syncPlaylistToIpod, type SyncPhase, type SyncSummary } from "../core/sync.ts";

interface Args {
  playlist: string;
  mount: string;
  name?: string;
  temp?: string;
  keepTemp: boolean;
  envPath: string;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let mount: string | undefined;
  let name: string | undefined;
  let temp: string | undefined;
  let keepTemp = false;
  let envPath = ".env";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--mount": mount = argv[++i]; break;
      case "--name": name = argv[++i]; break;
      case "--temp": temp = argv[++i]; break;
      case "--keep-temp": keepTemp = true; break;
      case "--env": envPath = argv[++i] ?? ".env"; break;
      case "-h":
      case "--help": usageAndExit(0); break;
      default:
        if (a.startsWith("-")) fail(`Unknown option: ${a}`);
        positional.push(a);
    }
  }

  if (positional.length === 0) fail("Missing <plex-playlist> argument.");
  if (positional.length > 1) {
    fail(`Too many arguments. Quote the playlist name: "${positional.join(" ")}"`);
  }
  if (!mount) fail("Missing required --mount <path> (the mounted iPod volume).");

  return { playlist: positional[0]!, mount: mount!, name, temp, keepTemp, envPath };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const config = loadConfig(args.envPath).plex;

  process.stdout.write(`Connecting to Plex at ${config.baseUrl} ...\n`);
  const server = await connectPlex(config);

  process.stdout.write(`Fetching playlist "${args.playlist}" ...\n`);
  const playlist = await fetchPlaylist(server, args.playlist);
  process.stdout.write(
    `Found "${playlist.title}" with ${playlist.tracks.length} track(s).\n\n`,
  );

  const tempDir =
    args.temp ?? (await mkdtemp(join(tmpdir(), "ipod-mixtapes-")));

  let summary: SyncSummary;
  try {
    summary = await syncPlaylistToIpod({
      mountPath: args.mount,
      playlistName: args.name ?? playlist.title,
      tracks: playlist.tracks,
      tempDir,
      events: makeProgressPrinter(),
    });
  } finally {
    if (!args.keepTemp && !args.temp) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  printSummary(summary, tempDir, args.keepTemp || Boolean(args.temp));

  // Fail loudly: a partial sync must not look like success to a script.
  if (summary.skipped.length > 0) process.exitCode = 1;
}

const PHASE_LABELS: Record<SyncPhase, string> = {
  opening: "opening iPod",
  wiping: "backing up + wiping iPod",
  downloading: "downloading tracks",
  writing: "writing iTunesDB",
};

function makeProgressPrinter() {
  let barOpen = false;
  const endBar = () => {
    if (barOpen) {
      process.stdout.write("\n");
      barOpen = false;
    }
  };
  return {
    onPhase: (phase: SyncPhase) => {
      endBar();
      process.stdout.write(`==> ${PHASE_LABELS[phase]}\n`);
    },
    onBackup: (path?: string) => {
      process.stdout.write(
        path ? `    backed up old DB -> ${path}\n` : "    no existing DB to back up\n",
      );
    },
    onTrackStart: (i: number, total: number, t: { title: string }) => {
      process.stdout.write(`  [${i + 1}/${total}] ${t.title}`);
      barOpen = true;
    },
    onTrackProgress: (_i: number, received: number, total?: number) => {
      const pct = total ? ` ${Math.floor((received / total) * 100)}%` : "";
      process.stdout.write(`\r  downloading${pct}                `);
      barOpen = true;
    },
    onTrackDone: (i: number, t: { title: string }) => {
      process.stdout.write(`\r  [${i + 1}] ${t.title} — ok            \n`);
      barOpen = false;
    },
    onTrackSkipped: (i: number, t: { title: string }, reason: string) => {
      process.stdout.write(`\r  [${i + 1}] ${t.title} — SKIPPED: ${reason}\n`);
      barOpen = false;
    },
  };
}

function printSummary(summary: SyncSummary, tempDir: string, kept: boolean): void {
  process.stdout.write("\n=== Sync summary ===\n");
  process.stdout.write(`Playlist : ${summary.playlistName}\n`);
  process.stdout.write(`Requested: ${summary.requested}\n`);
  process.stdout.write(`Added    : ${summary.added}\n`);
  process.stdout.write(`Skipped  : ${summary.skipped.length}\n`);
  if (summary.backupPath) process.stdout.write(`Backup   : ${summary.backupPath}\n`);
  process.stdout.write(`DB       : ${summary.dbPath} (${summary.bytesWritten} bytes)\n`);
  if (kept) process.stdout.write(`Temp kept: ${tempDir}\n`);

  if (summary.skipped.length > 0) {
    process.stdout.write("\n!!! MISSING (download/add failed) — playlist is incomplete:\n");
    for (const s of summary.skipped) {
      process.stdout.write(`  - ${s.track.title} (ratingKey ${s.track.ratingKey}): ${s.reason}\n`);
    }
  }
}

function usageAndExit(code: number): never {
  process.stdout.write(
    'Usage: ipod-mixtapes <plex-playlist> --mount /Volumes/IPOD ' +
      "[--name <name>] [--temp <dir>] [--keep-temp] [--env <path>]\n",
  );
  process.exit(code);
}

function fail(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  usageAndExit(2);
}

main().catch((err) => {
  process.stderr.write(`\nfatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
