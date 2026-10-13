/**
 * HTTP layer over the job store. node:http, no framework (ADR 0003).
 *
 *   GET  /                     → the web UI (plus /app/*.js and /vendor/preact/*)
 *   GET  /settings             → {"defaultMount": "..."} to prefill the form
 *   POST /jobs                 {"playlist": "...", "mount": "..."} → 201 snapshot
 *   GET  /jobs/latest          → the newest job's snapshot, or 404 when there is none
 *   GET  /jobs/:id             → current snapshot
 *   GET  /jobs/:id/events      → Server-Sent Events: current snapshot first, then each change
 *   POST /jobs/:id/approve     → 202; starts the sync
 *
 * Every SSE message is a full JobSnapshot, so a client that missed events is
 * correct again after the next one.
 */
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { JobConflictError, type JobStore } from "./jobs.ts";

const MAX_BODY_BYTES = 10_000;

const root = join(import.meta.dirname, "..", "..");
const JS = "text/javascript; charset=utf-8";

/** Every file the server will send. Anything else is a 404, so no path can escape. */
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: join(root, "src/web/index.html"), type: "text/html; charset=utf-8" },
  "/app/app.js": { file: join(root, "src/web/app.js"), type: JS },
  "/vendor/preact/preact.mjs": { file: join(root, "node_modules/preact/dist/preact.mjs"), type: JS },
  "/vendor/preact/hooks.mjs": { file: join(root, "node_modules/preact/hooks/dist/hooks.mjs"), type: JS },
};

export interface ServerOptions {
  /** Prefills the form's mount field. */
  defaultMount: string;
}

export function createJobServer(store: JobStore, options: ServerOptions): Server {
  return createServer((req, res) => {
    handle(store, options, req, res).catch((err) => {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });
}

async function handle(
  store: JobStore,
  options: ServerOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;

  const asset = STATIC_FILES[path];
  if (req.method === "GET" && asset) {
    res.writeHead(200, { "content-type": asset.type, "cache-control": "no-cache" });
    res.end(await readFile(asset.file));
    return;
  }

  if (req.method === "GET" && path === "/settings") {
    return sendJson(res, 200, { defaultMount: options.defaultMount });
  }

  if (req.method === "GET" && path === "/jobs/latest") {
    const latest = store.latest();
    if (!latest) return sendJson(res, 404, { error: "No jobs yet." });
    return sendJson(res, 200, latest.snapshot());
  }

  if (req.method === "POST" && path === "/jobs") {
    const body = await readJson(req);
    const playlist = typeof body.playlist === "string" ? body.playlist.trim() : "";
    const mount = typeof body.mount === "string" ? body.mount.trim() : "";
    if (!playlist || !mount) {
      return sendJson(res, 400, { error: 'Body needs "playlist" and "mount" strings.' });
    }
    try {
      const job = store.create(playlist, mount);
      return sendJson(res, 201, job.snapshot());
    } catch (err) {
      return sendConflictOrThrow(res, err);
    }
  }

  const match = /^\/jobs\/([^/]+)(\/events|\/approve)?$/.exec(path);
  const job = match ? store.get(match[1]!) : undefined;
  if (!match || !job) return sendJson(res, 404, { error: "Not found." });
  const action = match[2];

  if (req.method === "GET" && action === undefined) {
    return sendJson(res, 200, job.snapshot());
  }

  if (req.method === "GET" && action === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const unsubscribe = job.subscribe((snapshot) => {
      res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    });
    req.on("close", unsubscribe);
    return;
  }

  if (req.method === "POST" && action === "/approve") {
    try {
      store.approve(job);
      return sendJson(res, 202, job.snapshot());
    } catch (err) {
      return sendConflictOrThrow(res, err);
    }
  }

  return sendJson(res, 405, { error: "Method not allowed." });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY_BYTES) throw new Error("Request body too large.");
  }
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function sendConflictOrThrow(res: ServerResponse, err: unknown): void {
  if (!(err instanceof JobConflictError)) throw err;
  sendJson(res, 409, { error: err.message });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
