/**
 * Download primitive: fetch one URL to a file, with retry and optional progress.
 *
 * UI-agnostic. Progress is reported through a callback so a CLI can draw a bar and
 * a future webapp can stream the same numbers — neither is assumed here.
 */
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface DownloadProgress {
  /** Bytes written so far. */
  received: number;
  /** Total bytes from Content-Length, or undefined if the server omits it. */
  total?: number;
}

export interface DownloadOptions {
  /** Total attempts before giving up. Default 3. */
  retries?: number;
  /** Milliseconds to wait between attempts (grows linearly). Default 1000. */
  retryDelayMs?: number;
  /** Called as bytes arrive. */
  onProgress?: (p: DownloadProgress) => void;
  /** Called after a failed attempt that will be retried. `attempt` is the one that failed. */
  onRetry?: (attempt: number, reason: string) => void;
  /** Abort in-flight downloads (e.g. on Ctrl-C). */
  signal?: AbortSignal;
}

/**
 * Download `url` to `destPath`. Retries on failure, deleting any partial file
 * between attempts so a retry never appends to a truncated download. Throws with
 * the last error if every attempt fails — the caller decides whether to skip.
 */
export async function downloadFile(
  url: string,
  destPath: string,
  opts: DownloadOptions = {},
): Promise<void> {
  const retries = opts.retries ?? 3;
  const retryDelayMs = opts.retryDelayMs ?? 1000;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await downloadOnce(url, destPath, opts);
      return;
    } catch (err) {
      lastErr = err;
      await rm(destPath, { force: true }); // drop partial before retrying
      if (attempt < retries) {
        opts.onRetry?.(attempt, err instanceof Error ? err.message : String(err));
        await delay(retryDelayMs * attempt, opts.signal);
      }
    }
  }

  const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`Download failed after ${retries} attempt(s): ${reason}`);
}

async function downloadOnce(
  url: string,
  destPath: string,
  opts: DownloadOptions,
): Promise<void> {
  const res = await fetch(url, { signal: opts.signal });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  if (!res.body) {
    throw new Error("response had no body");
  }

  const lenHeader = res.headers.get("content-length");
  const total = lenHeader ? Number(lenHeader) : undefined;

  let received = 0;
  const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  if (opts.onProgress) {
    source.on("data", (chunk: Buffer) => {
      received += chunk.length;
      opts.onProgress!({ received, total });
    });
  }

  await pipeline(source, createWriteStream(destPath));
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    }, { once: true });
  });
}
