import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadFile } from "../src/core/download.ts";

const realFetch = globalThis.fetch;
const tmpDirs: string[] = [];

async function freshDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "dl-test-"));
  tmpDirs.push(d);
  return d;
}

afterEach(async () => {
  globalThis.fetch = realFetch;
  while (tmpDirs.length) await rm(tmpDirs.pop()!, { recursive: true, force: true });
});

/** A minimal Response whose body is a web ReadableStream of one chunk. */
function okResponse(bytes: Uint8Array): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-length": String(bytes.length) },
  });
}

describe("downloadFile", () => {
  it("writes the file and reports progress", async () => {
    const payload = new TextEncoder().encode("hello ipod");
    globalThis.fetch = (async () => okResponse(payload)) as unknown as typeof fetch;

    const dest = join(await freshDir(), "out.mp3");
    const seen: number[] = [];
    await downloadFile("https://x/y.mp3", dest, {
      onProgress: (p) => seen.push(p.received),
    });

    assert.equal(await readFile(dest, "utf8"), "hello ipod");
    assert.equal(seen.at(-1), payload.length);
  });

  it("retries after a failure, then succeeds", async () => {
    const payload = new TextEncoder().encode("second try");
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) throw new Error("network blip");
      return okResponse(payload);
    }) as unknown as typeof fetch;

    const dest = join(await freshDir(), "out.mp3");
    const retries: [number, string][] = [];
    await downloadFile("https://x/y.mp3", dest, {
      retries: 3,
      retryDelayMs: 1,
      onRetry: (attempt, reason) => retries.push([attempt, reason]),
    });

    assert.equal(calls, 2);
    assert.deepEqual(retries, [[1, "network blip"]]);
    assert.equal(await readFile(dest, "utf8"), "second try");
  });

  it("gives up after exhausting retries, naming the last error", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500, statusText: "Server Error" })) as unknown as typeof fetch;

    const dest = join(await freshDir(), "out.mp3");
    let retryCalls = 0;
    await assert.rejects(
      downloadFile("https://x/y.mp3", dest, {
        retries: 2,
        retryDelayMs: 1,
        onRetry: () => retryCalls++,
      }),
      /after 2 attempt/,
    );
    // Only attempts that will be retried report: the last failure throws instead.
    assert.equal(retryCalls, 1);
  });
});
