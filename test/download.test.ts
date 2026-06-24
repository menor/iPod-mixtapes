import { describe, it, expect, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadFile } from "../src/core/download.js";

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

    expect(await readFile(dest, "utf8")).toBe("hello ipod");
    expect(seen.at(-1)).toBe(payload.length);
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
    await downloadFile("https://x/y.mp3", dest, { retries: 3, retryDelayMs: 1 });

    expect(calls).toBe(2);
    expect(await readFile(dest, "utf8")).toBe("second try");
  });

  it("gives up after exhausting retries, naming the last error", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500, statusText: "Server Error" })) as unknown as typeof fetch;

    const dest = join(await freshDir(), "out.mp3");
    await expect(
      downloadFile("https://x/y.mp3", dest, { retries: 2, retryDelayMs: 1 }),
    ).rejects.toThrow(/after 2 attempt/);
  });
});
