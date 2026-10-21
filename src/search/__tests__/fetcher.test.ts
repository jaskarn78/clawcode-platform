import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchUrl } from "../fetcher.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const DEFAULT_OPTS = { timeoutMs: 10000, maxBytes: 1048576, userAgentSuffix: null as string | null };

/** Build a Response whose body streams `bytes` in one chunk. */
function streamedResponse(bytes: Uint8Array, headers: Record<string, string> = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers });
}

describe("fetchUrl", () => {
  it("F1: happy path → { ok: true, status: 200, headers, body: Buffer }", async () => {
    const payload = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      streamedResponse(payload, { "content-type": "text/plain" }),
    );

    const result = await fetchUrl("https://example.com", DEFAULT_OPTS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe(200);
      expect(result.headers["content-type"]).toBe("text/plain");
      expect(Buffer.isBuffer(result.body)).toBe(true);
      expect(result.body.toString("utf8")).toBe("Hello");
    }
  });

  it("F2: non-http(s) scheme → invalid_url", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await fetchUrl("ftp://example.com/file.txt", DEFAULT_OPTS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("invalid_url");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("F3: Content-Length > maxBytes → size_limit before streaming body", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("ignored body", {
        status: 200,
        headers: { "content-length": "2000000", "content-type": "text/html" },
      }),
    );
    const result = await fetchUrl("https://example.com", { ...DEFAULT_OPTS, maxBytes: 1024 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("size_limit");
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("F4: streaming body > maxBytes (no content-length) → size_limit", async () => {
    const bigChunk = new Uint8Array(2048);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      streamedResponse(bigChunk, { "content-type": "text/html" }),
      // no content-length header
    );
    const result = await fetchUrl("https://example.com", { ...DEFAULT_OPTS, maxBytes: 512 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("size_limit");
    }
  });

  it("F5: timeout fires → network error with /timeout|aborted/i message", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          const signal = options?.signal as AbortSignal | undefined;
          if (signal) {
            signal.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          }
        }),
    );
    const result = await fetchUrl("https://example.com", { ...DEFAULT_OPTS, timeoutMs: 1000 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("network");
      expect(result.error.message).toMatch(/timeout|aborted/i);
    }
  });

  it("F6: User-Agent header starts with `ClawCode/<version> (+https://github.com/example-user/clawcode)`", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      streamedResponse(new Uint8Array([0x68, 0x69])),
    );
    await fetchUrl("https://example.com", DEFAULT_OPTS);

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toMatch(
      /^ClawCode\/\S+ \(\+https:\/\/github\.com\/example-user\/clawcode\)$/,
    );
  });

  it("F7: userAgentSuffix appended to UA when non-null", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      streamedResponse(new Uint8Array([0x68, 0x69])),
    );
    await fetchUrl("https://example.com", { ...DEFAULT_OPTS, userAgentSuffix: "agent-clawdy" });

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toContain("agent-clawdy");
    expect(headers["User-Agent"]).toMatch(/ agent-clawdy$/); // appended at end with space
  });

  it("F8: 404 → network error with status populated, no large body read", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Not Found", { status: 404 }),
    );
    const result = await fetchUrl("https://example.com/missing", DEFAULT_OPTS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("network");
      expect(result.error.status).toBe(404);
      expect(result.error.message).toMatch(/404|not found/i);
    }
  });

  it("rejects empty-string URL → invalid_url", async () => {
    const result = await fetchUrl("", DEFAULT_OPTS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("invalid_url");
    }
  });

  it("rejects malformed URL → invalid_url", async () => {
    const result = await fetchUrl("not a url at all", DEFAULT_OPTS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("invalid_url");
    }
  });
});
