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
 *
 * Errors: routes throw, and one handler in createJobServer turns the error into a
 * response. HttpError carries its status; JobConflictError is a 409; anything else is a 500.
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
  "/app/outcome.js": { file: join(root, "src/web/outcome.js"), type: JS },
  "/vendor/preact/preact.mjs": { file: join(root, "node_modules/preact/dist/preact.mjs"), type: JS },
  "/vendor/preact/hooks.mjs": { file: join(root, "node_modules/preact/hooks/dist/hooks.mjs"), type: JS },
};

export interface ServerOptions {
  /** Prefills the form's mount field. */
  defaultMount: string;
}

/** A request the server refuses, with the HTTP status to send. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function createJobServer(store: JobStore, options: ServerOptions): Server {
  return createServer((req, res) => {
    handle(store, options, req, res).catch((err) => sendError(res, err));
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
    if (!latest) throw new HttpError(404, "No jobs yet.");
    return sendJson(res, 200, latest.snapshot());
  }

  if (req.method === "POST" && path === "/jobs") {
    const body = await readJson(req);
    const playlist = typeof body.playlist === "string" ? body.playlist.trim() : "";
    const mount = typeof body.mount === "string" ? body.mount.trim() : "";
    if (!playlist || !mount) throw new HttpError(400, 'Body needs "playlist" and "mount" strings.');
    return sendJson(res, 201, store.create(playlist, mount).snapshot());
  }

  const match = /^\/jobs\/([^/]+)(\/events|\/approve)?$/.exec(path);
  const job = match ? store.get(match[1]!) : undefined;
  if (!match || !job) throw new HttpError(404, "Not found.");
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
    store.approve(job);
    return sendJson(res, 202, job.snapshot());
  }

  throw new HttpError(405, "Method not allowed.");
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || "{}");
  } catch {
    throw new HttpError(400, "Body is not valid JSON.");
  }
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

function sendError(res: ServerResponse, err: unknown): void {
  // Headers already went out (an open event stream): a JSON reply is no longer possible.
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const status =
    err instanceof HttpError ? err.status : err instanceof JobConflictError ? 409 : 500;
  sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
