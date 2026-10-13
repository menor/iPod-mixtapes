/**
 * HTTP layer over the job store. node:http, no framework (ADR 0003).
 *
 *   POST /jobs                 {"playlist": "...", "mount": "..."} → 201 snapshot
 *   GET  /jobs/:id             → current snapshot
 *   GET  /jobs/:id/events      → Server-Sent Events: current snapshot first, then each change
 *   POST /jobs/:id/approve     → 202; starts the sync
 *
 * Every SSE message is a full JobSnapshot, so a client that missed events is
 * correct again after the next one.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { JobConflictError, type JobStore } from "./jobs.ts";

const MAX_BODY_BYTES = 10_000;

export function createJobServer(store: JobStore): Server {
  return createServer((req, res) => {
    handle(store, req, res).catch((err) => {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });
}

async function handle(store: JobStore, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;

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
