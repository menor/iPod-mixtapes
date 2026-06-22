import { existsSync } from "node:fs";

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
  // process.loadEnvFile is built into Node >=20.12 — no dotenv dependency.
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
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
