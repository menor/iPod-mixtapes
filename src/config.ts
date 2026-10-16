import { existsSync } from "node:fs";

/**
 * App settings, loaded from the environment.
 *
 * This is the only module that touches process.env. Everything else takes plain
 * config objects as arguments, so the core (src/core) stays UI-agnostic and a future
 * webapp can supply config from its own source instead of a .env file.
 */
export interface AppConfig {
  server: {
    /** PORT, default 4573. */
    port: number;
    /** HOST, default 127.0.0.1. Localhost only: there is no auth. */
    host: string;
  };
  ipod: {
    /** MOUNT, default ./fake-ipod. Only prefills the form, so the real iPod is never the target by accident. */
    defaultMount: string;
  };
  plex: PlexConfig;
}

export interface PlexConfig {
  /** Base URL including scheme and port, e.g. https://plex.example.com:32400 */
  baseUrl: string;
  /** X-Plex-Token. Secret — never logged or committed. */
  token: string;
}

/**
 * Load and validate config from .env / process.env. Fails loudly: a missing or bad
 * value throws with a message naming exactly what to set and where.
 */
export function loadConfig(envPath = ".env"): AppConfig {
  // Already-set vars (from the shell) win: loadEnvFile never overwrites them.
  if (existsSync(envPath)) process.loadEnvFile(envPath);

  const env = (name: string) => (process.env[name] ?? "").trim();

  const port = Number(env("PORT") || 4573);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be a whole number from 1 to 65535, got "${env("PORT")}".`);
  }

  const baseUrl = env("PLEX_BASE_URL");
  const token = env("PLEX_TOKEN");
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

  return {
    server: { port, host: env("HOST") || "127.0.0.1" },
    ipod: { defaultMount: env("MOUNT") || "./fake-ipod" },
    // Catch a trailing-slash baseUrl early so URL joins downstream are predictable.
    plex: { baseUrl: baseUrl.replace(/\/+$/, ""), token },
  };
}
