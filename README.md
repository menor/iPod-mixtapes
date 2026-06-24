# iPod Mixtapes

Sync a named Plex playlist onto a 5.5-gen iPod Video (A1136). Plex is the source of
truth; the iPod is a one-way mirror. Built on the [podscribe](https://github.com/menor/podscribe)
iTunesDB library. Runs on [Bun](https://bun.sh).

## Setup

```bash
bun install
cp .env.example .env   # then fill in PLEX_BASE_URL and PLEX_TOKEN
```

`.env` is gitignored and auto-loaded by Bun. The token is never hardcoded or logged.

## Usage

```bash
bun run sync "<plex-playlist>" --mount /Volumes/IPOD
```

Options:

| Flag | Meaning |
| --- | --- |
| `--mount <path>` | Mounted iPod volume (required) |
| `--name <name>` | Playlist name to create on the iPod (default: the Plex title) |
| `--temp <dir>` | Download folder (default: a temp dir, removed after a successful run) |
| `--keep-temp` | Keep the download folder (debugging) |
| `--env <path>` | `.env` file to load (default: `.env`) |

The command exits non-zero if any track failed to download — the playlist is then
incomplete and the failures are listed.

## How it syncs (iteration 1: wipe-and-rebuild)

1. Open the iPod and back up its existing iTunesDB (timestamped).
2. Wipe the device (it is a disposable mirror).
3. Download every playlist track in Plex order, stamping each with `PLEXID:<ratingKey>`.
4. Write a fresh iTunesDB. Order matches Plex by construction.

It re-downloads the whole playlist each run. Iteration 2 (planned) will reuse on-device
audio and download only new tracks.

## Architecture

`src/core/` is UI-agnostic (no console/process access; progress via callbacks) so a future
web app can drive the same engine. `src/cli/` is a thin wrapper over it.

- `src/config.ts` — load + validate Plex config from env.
- `src/core/plex.ts` — connect/verify, find a playlist, normalize tracks.
- `src/core/download.ts` — download one file with retry + progress.
- `src/core/sync.ts` — the sync engine (strategy seam).
- `src/cli/sync.ts` — CLI entry point.

## Develop

```bash
bun test           # bun:test
bun run typecheck  # tsgo --noEmit
```
