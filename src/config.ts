import { existsSync, readFileSync } from "node:fs";

/**
 * Plex connection settings, loaded from the environment.
 *
 * This is the only module that touches process.env. The core (src/core) takes
 * a plain PlexConfig object as an argument, so it stays UI-agnostic and a future
 * webapp can supply config from its own source instead of a .env file.
 */
export interface PlexConfig {
  /** Base URL including scheme and port, e.g. https://plex.example.com:32400 */
  baseUrl: string;
  /** X-Plex-Token. Secret — never logged or committed. */
  token: string;
}

/**
 * Load and validate Plex config from .env / process.env. Fails loudly: a missing
 * or empty value throws with a message naming exactly what to set and where.
 */
export function loadPlexConfig(envPath = ".env"): PlexConfig {
  // Bun auto-loads .env into the environment at startup. We still parse the given
  // file so a custom `--env <path>` works without a Bun flag. Already-set vars
  // (shell or Bun-loaded) win — we never overwrite them.
  if (existsSync(envPath)) {
    applyEnvFile(envPath);
  }

  const baseUrl = (process.env.PLEX_BASE_URL ?? "").trim();
  const token = (process.env.PLEX_TOKEN ?? "").trim();

  const missing: string[] = [];
  if (!baseUrl) missing.push("PLEX_BASE_URL");
  if (!token) missing.push("PLEX_TOKEN");

  if (missing.length > 0) {
    throw new Error(
      `Missing required Plex config: ${missing.join(", ")}.\n` +
        `Set it in ${envPath} (copy .env.example) or export it in your shell. ` +
        `Never hardcode the token.`,
    );
  }

  // Catch a trailing-slash baseUrl early so URL joins downstream are predictable.
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token };
}

/** Minimal KEY=VALUE .env parser. Skips comments/blanks; does not overwrite set vars. */
function applyEnvFile(path: string): void {
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
