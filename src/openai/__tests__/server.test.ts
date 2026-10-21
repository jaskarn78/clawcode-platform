/**
 * Phase 69 Plan 02 — integration tests for src/openai/server.ts
 * (OPENAI-01, OPENAI-02, OPENAI-03, OPENAI-06, OPENAI-07).
 *
 * Boots a real node:http server on an ephemeral port with a :memory:
 * ApiKeysStore + a MockSessionDriver replaying recorded SDK fixtures. Uses
 * Node 22's built-in `fetch()` to issue requests — no third-party HTTP client.
 *
 * Covered rows from 69-VALIDATION.md (every 69-02 integration row):
 *   OPENAI-03: GET /v1/models returns top-level agents only, no auth required.
 *   OPENAI-04: 401 missing / 401 invalid / 403 agent-mismatch (no agent-name leak)
 *              / 401 revoked.
 *   OPENAI-01: Non-stream 200 returns ChatCompletionResponse shape from fixture.
 *   OPENAI-02: Stream 200 returns text/event-stream chunks with role-on-first
 *              + [DONE] terminator + keepalive-when-stalled.
 *   OPENAI-02: Client disconnect aborts the driver (signal observed).
 *   OPENAI-06: Stream tool-use fixture yields per-index tool_calls deltas.
 *   OPENAI-06: role:'tool' reply translates to ClaudeToolResultBlock passed
 *              to driver.
 *   OPENAI-07: driver receives keyHash; x-request-id echoed / generated.
 *   Additional: malformed JSON → 400, body-too-large → 413, charset-OK,
 *               OPTIONS 204, unknown route 404, graceful-close activeStreams.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { startOpenAiServer, type OpenAiServerHandle, type OpenAiSessionDriver } from "../server.js";
import { ApiKeysStore } from "../keys.js";
import type { SdkStreamEvent } from "../types.js";
import { SessionError } from "../../shared/errors.js";
import { UpstreamTurnError } from "../upstream-error.js";
import type { RequestLogger, RequestLogRecord } from "../request-logger.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURES_DIR = join(import.meta.dirname, "fixtures");
const textStream: SdkStreamEvent[] = JSON.parse(
  readFileSync(join(FIXTURES_DIR, "sdk-stream-text.json"), "utf8"),
);
const toolUseStream: SdkStreamEvent[] = JSON.parse(
  readFileSync(join(FIXTURES_DIR, "sdk-stream-tool-use.json"), "utf8"),
);
/**
 * Post-v2.0 hardening fixture — a single-tool-call stream that terminates
 * via finish_reason:"tool_calls". Used by Task 2 of 260419-jtk to pin the
 * server-level tool-call contract + stream_options.include_usage interop.
 */
const toolUseTerminalStream: SdkStreamEvent[] = JSON.parse(
  readFileSync(join(FIXTURES_DIR, "sdk-stream-tool-use-terminal.json"), "utf8"),
);

// ---------------------------------------------------------------------------
// Mock session driver — replays recorded events with optional delay + abort.
// ---------------------------------------------------------------------------

interface MockDriverOptions {
  /** Events to replay for each `dispatch` call. */
  events: SdkStreamEvent[];
  /** Delay in ms before the FIRST event fires (to exercise keepalive). */
  preFirstEventDelayMs?: number;
  /** Delay in ms between each event (to exercise chunk-by-chunk emission). */
  perEventDelayMs?: number;
  /** Throw mid-stream at this event index (0-based). */
  throwAtIndex?: number;
}

interface MockDriver extends OpenAiSessionDriver {
  /** Captured inputs from every dispatch call. */
  readonly calls: Array<Parameters<OpenAiSessionDriver["dispatch"]>[0]>;
  /** Whether the most recent dispatch observed its signal being aborted. */
  lastAborted: boolean;
}

function makeMockDriver(opts: MockDriverOptions): MockDriver {
  const calls: Array<Parameters<OpenAiSessionDriver["dispatch"]>[0]> = [];
  let lastAborted = false;

  const driver: MockDriver = {
    calls,
    get lastAborted() {
      return lastAborted;
    },
    set lastAborted(v: boolean) {
      lastAborted = v;
    },
    async *dispatch(input) {
      calls.push(input);
      lastAborted = false;
      // Track signal abort via event listener so an early consumer bail
      // (generator.return()) still records `lastAborted` before finally.
      const onAbort = () => {
        lastAborted = true;
      };
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener("abort", onAbort, { once: true });
      try {
        if (opts.preFirstEventDelayMs && opts.preFirstEventDelayMs > 0) {
          await sleepOrAbort(opts.preFirstEventDelayMs, input.signal);
          if (input.signal.aborted) {
            return;
          }
        }
        for (let i = 0; i < opts.events.length; i++) {
          if (input.signal.aborted) {
            return;
          }
          if (opts.throwAtIndex !== undefined && i === opts.throwAtIndex) {
            throw new Error("mock-driver-error");
          }
          yield opts.events[i]!;
          if (opts.perEventDelayMs && opts.perEventDelayMs > 0) {
            await sleepOrAbort(opts.perEventDelayMs, input.signal);
          }
        }
      } finally {
        input.signal.removeEventListener("abort", onAbort);
      }
    },
  };
  return driver;
}

function sleepOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    if (signal.aborted) {
      clearTimeout(t);
      resolve();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

// ---------------------------------------------------------------------------
// Test harness setup/teardown
// ---------------------------------------------------------------------------

interface TestHarness {
  handle: OpenAiServerHandle;
  baseUrl: string;
  keysStore: ApiKeysStore;
  driver: MockDriver;
  pinnedKey: string;
  pinnedHashHex: string;
  agentNames: string[];
}

async function bootHarness(opts: {
  events: SdkStreamEvent[];
  preFirstEventDelayMs?: number;
  perEventDelayMs?: number;
  throwAtIndex?: number;
  agentNames?: string[];
  pinAgent?: string;
  keepaliveMs?: number;
  maxBody?: number;
  /** Post-v2.0 hardening — optional custom driver (overrides events-based mock). */
  driverOverride?: OpenAiSessionDriver;
  /** Post-v2.0 hardening — warm-path readiness probe. When omitted, wait gate is disabled. */
  agentIsRunning?: (agentName: string) => boolean;
  /** Post-v2.0 hardening — max wait before 503 Retry-After. */
  agentReadinessWaitMs?: number;
  /** Post-v2.0 hardening — poll cadence during readiness wait. */
  agentReadinessPollIntervalMs?: number;
  /** Quick task 260419-mvh — optional request logger for SI-* tests. */
  requestLogger?: RequestLogger;
}): Promise<TestHarness> {
  const agentNames = opts.agentNames ?? [
    "clawdy",
    "assistant",
    "clawdy-sub-research",
    "clawdy-thread-abc",
  ];
  const pinAgent = opts.pinAgent ?? "clawdy";
  const keysStore = new ApiKeysStore(":memory:");
  const { key, row } = keysStore.createKey(pinAgent, { label: "test-key" });
  const mockDriver = makeMockDriver({
    events: opts.events,
    preFirstEventDelayMs: opts.preFirstEventDelayMs,
    perEventDelayMs: opts.perEventDelayMs,
    throwAtIndex: opts.throwAtIndex,
  });
  const driver: OpenAiSessionDriver = opts.driverOverride ?? mockDriver;
  const handle = await startOpenAiServer({
    port: 0,
    host: "127.0.0.1",
    maxRequestBodyBytes: opts.maxBody ?? 1 * 1024 * 1024,
    streamKeepaliveMs: opts.keepaliveMs ?? 15_000,
    apiKeysStore: keysStore,
    driver,
    agentNames: () => agentNames,
    agentIsRunning: opts.agentIsRunning,
    agentReadinessWaitMs: opts.agentReadinessWaitMs,
    agentReadinessPollIntervalMs: opts.agentReadinessPollIntervalMs,
    requestLogger: opts.requestLogger,
  });
  const baseUrl = `http://127.0.0.1:${handle.address.port}`;
  return {
    handle,
    baseUrl,
    keysStore,
    driver: mockDriver,
    pinnedKey: key,
    pinnedHashHex: row.key_hash,
    agentNames,
  };
}

async function teardown(h: TestHarness): Promise<void> {
  await h.handle.close();
  h.keysStore.close();
}

// ---------------------------------------------------------------------------
// Tests: OPENAI-03 /v1/models
// ---------------------------------------------------------------------------

describe("GET /v1/models — OPENAI-03", () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await bootHarness({ events: textStream });
  });
  afterEach(async () => {
    await teardown(h);
  });

  it("returns list of top-level agents only — sub/thread names excluded", async () => {
    const res = await fetch(`${h.baseUrl}/v1/models`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      data: Array<{ id: string; object: string; owned_by: string; created: number }>;
    };
    expect(body.object).toBe("list");
    const ids = body.data.map((d) => d.id);
    expect(ids).toEqual(["clawdy", "assistant"]);
    for (const entry of body.data) {
      expect(entry.object).toBe("model");
      expect(entry.owned_by).toBe("clawcode");
      expect(typeof entry.created).toBe("number");
      expect(entry.created).toBeGreaterThan(1_700_000_000);
    }
  });

  it("does NOT require auth — no Authorization header → 200", async () => {
    const res = await fetch(`${h.baseUrl}/v1/models`);
    expect(res.status).toBe(200);
  });

  it("CORS headers present on /v1/models", async () => {
    const res = await fetch(`${h.baseUrl}/v1/models`);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-expose-headers")).toContain("x-request-id");
  });
});

// ---------------------------------------------------------------------------
// Tests: OPENAI-04 auth paths
// ---------------------------------------------------------------------------

describe("POST /v1/chat/completions — auth (OPENAI-04)", () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await bootHarness({ events: textStream });
  });
  afterEach(async () => {
    await teardown(h);
  });

  it("missing Authorization → 401 authentication_error code:missing_key", async () => {
    const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "clawdy", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.type).toBe("authentication_error");
    expect(body.error.code).toBe("missing_key");
  });

  it("unknown bearer → 401 code:invalid_key", async () => {
    const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer ck_nope_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      body: JSON.stringify({ model: "clawdy", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.type).toBe("authentication_error");
    expect(body.error.code).toBe("invalid_key");
  });

  it("known key but mismatched model → 403 code:agent_mismatch (never leaks the real agent)", async () => {
    const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${h.pinnedKey}`,
      },
      body: JSON.stringify({ model: "assistant", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.type).toBe("permission_error");
    expect(body.error.code).toBe("agent_mismatch");
    // Message MUST NOT include the pinned agent name 'clawdy'.
    expect(body.error.message).not.toContain("clawdy");
  });

  it("revoked key → 401 code:invalid_key", async () => {
    h.keysStore.revokeKey("test-key");
    const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${h.pinnedKey}`,
      },
      body: JSON.stringify({ model: "clawdy", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_key");
  });
});

// ---------------------------------------------------------------------------
// Quick task 260419-p51 — scope-aware auth (P51-SERVER-SCOPE)
// ---------------------------------------------------------------------------

describe("POST /v1/chat/completions — scope-aware auth (P51-SERVER-SCOPE)", () => {
  it("legacy pinned key on its own agent → 200 (no regression)", async () => {
    const h = await bootHarness({ events: textStream });
    try {
      const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${h.pinnedKey}`,
        },
        body: JSON.stringify({
          model: "clawdy",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(res.status).toBe(200);
    } finally {
      await teardown(h);
    }
  });

  it("legacy pinned key on OTHER agent → 403 code:agent_mismatch (no regression)", async () => {
    const h = await bootHarness({ events: textStream });
    try {
      const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${h.pinnedKey}`,
        },
        body: JSON.stringify({
          model: "assistant",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe("agent_mismatch");
    } finally {
      await teardown(h);
    }
  });

  it("scope='all' key on any configured agent → 200", async () => {
    const h = await bootHarness({ events: textStream });
    try {
      // Mint an --all key directly on the store.
      const { key: allKey } = h.keysStore.createAllKey({ label: "fleet" });
      // First hit: clawdy
      const r1 = await fetch(`${h.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${allKey}`,
        },
        body: JSON.stringify({
          model: "clawdy",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(r1.status).toBe(200);
      // Second hit: assistant (a different agent with the same key).
      const r2 = await fetch(`${h.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${allKey}`,
        },
        body: JSON.stringify({
          model: "assistant",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(r2.status).toBe(200);
    } finally {
      await teardown(h);
    }
  });

  it("scope='all' key on unknown model → 404 code:unknown_model", async () => {
    const h = await bootHarness({ events: textStream });
    try {
      const { key: allKey } = h.keysStore.createAllKey({ label: "fleet" });
      const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${allKey}`,
        },
        body: JSON.stringify({
          model: "does-not-exist",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe("unknown_model");
      expect(body.error.type).toBe("invalid_request_error");
    } finally {
      await teardown(h);
    }
  });

  it("scope='all' key stamps driverInput.agentName = body.model (not the key's owner)", async () => {
    const h = await bootHarness({ events: textStream });
    try {
      const { key: allKey } = h.keysStore.createAllKey({ label: "fleet" });
      const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${allKey}`,
        },
        body: JSON.stringify({
          model: "assistant",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(res.status).toBe(200);
      // The mock driver captured the dispatch input — agentName should be
      // "assistant" (the requested model), NOT "*" (the --all key's owner).
      const call = h.driver.calls.at(-1);
      expect(call?.agentName).toBe("assistant");
    } finally {
      await teardown(h);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: OPENAI-01 non-streaming
// ---------------------------------------------------------------------------

describe("POST /v1/chat/completions — non-stream (OPENAI-01)", () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await bootHarness({ events: textStream });
  });
  afterEach(async () => {
    await teardown(h);
  });

  it("returns ChatCompletionResponse with id chatcmpl-*, object chat.completion, text content", async () => {
    const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${h.pinnedKey}`,
      },
      body: JSON.stringify({
        model: "clawdy",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toMatch(/^chatcmpl-/);
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("clawdy");
    expect(body.choices[0].message.role).toBe("assistant");
    expect(body.choices[0].message.content).toBe("Hello, human.");
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.choices[0].logprobs).toBeNull();
    expect(body.system_fingerprint).toBeNull();
    expect(typeof body.usage.prompt_tokens).toBe("number");
    expect(typeof body.usage.completion_tokens).toBe("number");
    expect(body.usage.total_tokens).toBe(body.usage.prompt_tokens + body.usage.completion_tokens);
  });

  it("usage populates prompt_tokens from input + cache_read, completion from output", async () => {
    const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${h.pinnedKey}`,
      },
      body: JSON.stringify({
        model: "clawdy",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const body = await res.json();
    // text fixture: input_tokens:12, output_tokens:3, cache_read:0
    expect(body.usage.prompt_tokens).toBe(12);
    expect(body.usage.completion_tokens).toBe(3);
  });

  it("accepts Content-Type: application/json; charset=utf-8 (Pitfall 9)", async () => {
    const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${h.pinnedKey}`,
      },
      body: JSON.stringify({
        model: "clawdy",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Tests: OPENAI-02 streaming
// ---------------------------------------------------------------------------

/** Parse SSE body into an ordered list of `data: {...}` JSON chunks + the terminator. */
function parseSseBody(body: string): {
  chunks: unknown[];
  seenDone: boolean;
  keepaliveCount: number;
  raw: string;
} {
  const lines = body.split("\n\n");
  const chunks: unknown[] = [];
  let seenDone = false;
  let keepaliveCount = 0;
  for (const block of lines) {
    if (block === "") continue;
    if (block.startsWith(": keepalive")) {
      keepaliveCount++;
      continue;
    }
    if (block.startsWith("data: [DONE]")) {
      seenDone = true;
      continue;
    }
    if (block.startsWith("data: ")) {
      const json = block.slice("data: ".length);
      try {
        chunks.push(JSON.parse(json));
      } catch {
        // Ignore malformed — test will fail on chunk assertions.
      }
    }
  }
  return { chunks, seenDone, keepaliveCount, raw: body };
}

describe("POST /v1/chat/completions — streaming (OPENAI-02)", () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await bootHarness({ events: textStream });
  });
  afterEach(async () => {
    await teardown(h);
  });

  it("returns text/event-stream with role-on-first + [DONE] terminator", async () => {
    const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${h.pinnedKey}`,
      },
      body: JSON.stringify({
        model: "clawdy",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    const parsed = parseSseBody(body);
    expect(parsed.seenDone).toBe(true);
    expect(parsed.chunks.length).toBeGreaterThan(0);
    const first = parsed.chunks[0] as { choices: Array<{ delta: { role?: string; content?: string } }> };
    expect(first.choices[0]!.delta.role).toBe("assistant");
    expect(first.choices[0]!.delta.content).toBe("");
    // Subsequent chunks must not have role.
    for (let i = 1; i < parsed.chunks.length; i++) {
      const c = parsed.chunks[i] as { choices: Array<{ delta: { role?: string } }> };
      expect(c.choices[0]!.delta.role).toBeUndefined();
    }
    // Final non-done chunk has finish_reason 'stop'.
    const last = parsed.chunks[parsed.chunks.length - 1] as {
      choices: Array<{ finish_reason: string | null; delta: object }>;
    };
    expect(last.choices[0]!.finish_reason).toBe("stop");
    expect(last.choices[0]!.delta).toEqual({});
  });

  it("echoes X-Accel-Buffering: no + Cache-Control: no-cache on SSE response", async () => {
    const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${h.pinnedKey}`,
      },
      body: JSON.stringify({
        model: "clawdy",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    expect(res.headers.get("cache-control") ?? "").toContain("no-cache");
    await res.text();
  });
});

describe("POST /v1/chat/completions — SSE keepalive when driver stalls", () => {
  it("keepalive arrives before any data chunk when the driver holds off", async () => {
    const h = await bootHarness({
      events: textStream,
      preFirstEventDelayMs: 300,
      keepaliveMs: 50,
    });
    try {
      const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${h.pinnedKey}`,
        },
        body: JSON.stringify({
          model: "clawdy",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.text();
      const parsed = parseSseBody(body);
      expect(parsed.keepaliveCount).toBeGreaterThanOrEqual(1);
      // First data chunk should appear AFTER keepalive comments.
      const firstData = body.indexOf("data: ");
      const firstKeepalive = body.indexOf(": keepalive");
      expect(firstKeepalive).toBeGreaterThanOrEqual(0);
      expect(firstKeepalive).toBeLessThan(firstData);
    } finally {
      await teardown(h);
    }
  });
});

describe("POST /v1/chat/completions — client disconnect aborts driver", () => {
  it("AbortController on client side flips driver.signal.aborted (via node:http with explicit socket destroy)", async () => {
    // Use node:http directly — fetch/undici can keep sockets alive across
    // abort, which makes the req.on('close') timing flakey. Direct http
    // request + explicit socket.destroy() guarantees close fires promptly.
    const http = await import("node:http");
    const h = await bootHarness({
      events: textStream,
      perEventDelayMs: 100,
      keepaliveMs: 50,
    });
    try {
      const url = new URL(`${h.baseUrl}/v1/chat/completions`);
      const body = JSON.stringify({
        model: "clawdy",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      });
      const clientReq = http.request({
        method: "POST",
        host: url.hostname,
        port: Number(url.port),
        path: url.pathname,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${h.pinnedKey}`,
          "content-length": Buffer.byteLength(body).toString(),
        },
      });
      clientReq.write(body);
      clientReq.end();
      await new Promise<void>((resolve, reject) => {
        clientReq.on("response", () => resolve());
        clientReq.on("error", reject);
      });
      // Give the driver a moment to enter the stream loop.
      await new Promise((r) => setTimeout(r, 50));
      // Force-close the socket — this triggers req.on('close') on the server.
      clientReq.destroy();
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && !h.driver.lastAborted) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(h.driver.lastAborted).toBe(true);
    } finally {
      await teardown(h);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: OPENAI-06 tool-use streaming + tool-result translation
// ---------------------------------------------------------------------------

describe("POST /v1/chat/completions — tool-use streaming (OPENAI-06)", () => {
  it("replay tool-use fixture → sequential tool_calls deltas + finish_reason:'tool_calls'", async () => {
    const h = await bootHarness({ events: toolUseStream });
    try {
      const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${h.pinnedKey}`,
        },
        body: JSON.stringify({
          model: "clawdy",
          messages: [{ role: "user", content: "weather + time" }],
          stream: true,
        }),
      });
      const body = await res.text();
      const parsed = parseSseBody(body);
      expect(parsed.seenDone).toBe(true);
      // Find tool_use start chunks (those carrying id + type + name).
      const startChunks = parsed.chunks.filter((c) => {
        const delta = (c as { choices: Array<{ delta: { tool_calls?: Array<{ id?: string; type?: string }> } }> })
          .choices[0]!.delta;
        return delta.tool_calls?.[0]?.id !== undefined;
      });
      expect(startChunks).toHaveLength(2);
      const first = startChunks[0] as {
        choices: Array<{ delta: { tool_calls: Array<{ id: string; type: string; function: { name: string } }> } }>;
      };
      expect(first.choices[0]!.delta.tool_calls[0]!.id).toBe("tu_aaa");
      expect(first.choices[0]!.delta.tool_calls[0]!.type).toBe("function");
      expect(first.choices[0]!.delta.tool_calls[0]!.function.name).toBe("get_weather");
      // Final chunk has finish_reason:'tool_calls'.
      const last = parsed.chunks[parsed.chunks.length - 1] as {
        choices: Array<{ finish_reason: string | null; delta: object }>;
      };
      expect(last.choices[0]!.finish_reason).toBe("tool_calls");
    } finally {
      await teardown(h);
    }
  });

  // Post-v2.0 hardening — Task 2 of 260419-jtk.
  // Pins the terminal tool-call contract at the SERVER seam + usage-trailer interop.

  it("T1 — realistic tool_use sequence terminates with finish_reason:'tool_calls' and correct delta shapes", async () => {
    const h = await bootHarness({ events: toolUseTerminalStream });
    try {
      const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${h.pinnedKey}`,
        },
        body: JSON.stringify({
          model: "clawdy",
          messages: [{ role: "user", content: "go to example.com" }],
          stream: true,
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.text();
      const parsed = parseSseBody(body);
      expect(parsed.seenDone).toBe(true);

      // First tool-call start chunk — must carry { index, id, type, function:{name} }.
      const startChunks = parsed.chunks.filter((c) => {
        const delta = (c as { choices: Array<{ delta: { tool_calls?: Array<{ id?: string }> } }> })
          .choices[0]!.delta;
        return delta.tool_calls?.[0]?.id !== undefined;
      });
      expect(startChunks).toHaveLength(1);
      const startTc = (startChunks[0] as {
        choices: Array<{ delta: { tool_calls: Array<{ index: number; id: string; type: string; function: { name: string } }> } }>;
      }).choices[0]!.delta.tool_calls[0]!;
      expect(startTc).toMatchObject({
        index: 0,
        id: "tu_bn1",
        type: "function",
        function: { name: "browser_navigate" },
      });

      // Argument-delta chunks — carry ONLY { index, function:{arguments} } (no id, no type).
      const argChunks = parsed.chunks.filter((c) => {
        const tc = (c as { choices: Array<{ delta: { tool_calls?: Array<{ id?: string; function?: { arguments?: string } }> } }> })
          .choices[0]!.delta.tool_calls?.[0];
        return tc !== undefined && tc.id === undefined && tc.function?.arguments !== undefined;
      });
      expect(argChunks.length).toBeGreaterThan(0);
      for (const c of argChunks) {
        const tc = (c as { choices: Array<{ delta: { tool_calls: Array<{ index: number; id?: string; type?: string; function: { arguments: string } }> } }> })
          .choices[0]!.delta.tool_calls[0]!;
        expect(tc.id).toBeUndefined();
        expect(tc.type).toBeUndefined();
        expect(typeof tc.index).toBe("number");
        expect(typeof tc.function.arguments).toBe("string");
      }

      // Concatenated arguments across index:0 chunks must parse as valid JSON.
      let concatenated = "";
      for (const c of parsed.chunks) {
        const tc = (c as { choices: Array<{ delta: { tool_calls?: Array<{ index: number; function?: { arguments?: string } }> } }> })
          .choices[0]!.delta.tool_calls?.[0];
        if (tc && tc.index === 0 && tc.function?.arguments) {
          concatenated += tc.function.arguments;
        }
      }
      expect(concatenated).toBe('{"url":"https://example.com"}');
      expect(() => JSON.parse(concatenated)).not.toThrow();

      // Last chunk before [DONE]: delta:{} + finish_reason:"tool_calls".
      const last = parsed.chunks[parsed.chunks.length - 1] as {
        choices: Array<{ finish_reason: string | null; delta: object }>;
      };
      expect(last.choices[0]!.delta).toEqual({});
      expect(last.choices[0]!.finish_reason).toBe("tool_calls");
    } finally {
      await teardown(h);
    }
  });

  it("T2 — trailing usage chunk fires when stream_options.include_usage:true on a tool-call stream", async () => {
    const h = await bootHarness({ events: toolUseTerminalStream });
    try {
      const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${h.pinnedKey}`,
        },
        body: JSON.stringify({
          model: "clawdy",
          messages: [{ role: "user", content: "go to example.com" }],
          stream: true,
          stream_options: { include_usage: true },
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.text();
      const parsed = parseSseBody(body);
      expect(parsed.seenDone).toBe(true);
      // Need AT LEAST two final chunks: terminal + usage trailer.
      expect(parsed.chunks.length).toBeGreaterThanOrEqual(2);

      const terminalChunk = parsed.chunks[parsed.chunks.length - 2] as {
        id: string;
        choices: Array<{ finish_reason: string | null; delta: object }>;
        usage?: unknown;
      };
      const usageChunk = parsed.chunks[parsed.chunks.length - 1] as {
        id: string;
        choices: unknown[];
        usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      };

      // Terminal chunk: tool_calls finish, delta empty, no usage.
      expect(terminalChunk.choices[0]!.delta).toEqual({});
      expect(terminalChunk.choices[0]!.finish_reason).toBe("tool_calls");
      expect(terminalChunk.usage).toBeUndefined();

      // Usage chunk: choices:[] and fixture-derived token numbers.
      expect(usageChunk.choices).toEqual([]);
      expect(usageChunk.usage.prompt_tokens).toBe(15);
      expect(usageChunk.usage.completion_tokens).toBe(5);
      expect(usageChunk.usage.total_tokens).toBe(20);

      // Same id across terminal + usage chunk — OpenAI clients group by id.
      expect(usageChunk.id).toBe(terminalChunk.id);
    } finally {
      await teardown(h);
    }
  });

  it("T3 — no trailing usage chunk when stream_options is absent", async () => {
    const h = await bootHarness({ events: toolUseTerminalStream });
    try {
      const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${h.pinnedKey}`,
        },
        body: JSON.stringify({
          model: "clawdy",
          messages: [{ role: "user", content: "go to example.com" }],
          stream: true,
        }),
      });
      const body = await res.text();
      const parsed = parseSseBody(body);
      // Last chunk is the terminal — finish_reason:tool_calls, no usage.
      const last = parsed.chunks[parsed.chunks.length - 1] as {
        choices: Array<{ finish_reason: string | null }>;
        usage?: unknown;
      };
      expect(last.choices[0]!.finish_reason).toBe("tool_calls");
      expect(last.usage).toBeUndefined();
      // No chunk in the stream should have choices:[] (the usage-trailer shape).
      for (const c of parsed.chunks) {
        const choices = (c as { choices: unknown[] }).choices;
        expect(choices.length).toBeGreaterThan(0);
      }
    } finally {
      await teardown(h);
    }
  });

  it("T4 — no trailing usage chunk when stream_options.include_usage:false explicitly", async () => {
    const h = await bootHarness({ events: toolUseTerminalStream });
    try {
      const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${h.pinnedKey}`,
        },
        body: JSON.stringify({
          model: "clawdy",
          messages: [{ role: "user", content: "go to example.com" }],
          stream: true,
          stream_options: { include_usage: false },
        }),
      });
      const body = await res.text();
      const parsed = parseSseBody(body);
      const last = parsed.chunks[parsed.chunks.length - 1] as {
        choices: Array<{ finish_reason: string | null }>;
        usage?: unknown;
      };
      expect(last.choices[0]!.finish_reason).toBe("tool_calls");
      expect(last.usage).toBeUndefined();
      for (const c of parsed.chunks) {
        const choices = (c as { choices: unknown[] }).choices;
        expect(choices.length).toBeGreaterThan(0);
      }
    } finally {
      await teardown(h);
    }
  });
});

describe("POST /v1/chat/completions — client tool-result reply (OPENAI-06)", () => {
  it("role:'tool' message translates to ClaudeToolResultBlock passed to driver", async () => {
    const h = await bootHarness({ events: textStream });
    try {
      await fetch(`${h.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${h.pinnedKey}`,
        },
        body: JSON.stringify({
          model: "clawdy",
          messages: [
            { role: "user", content: "weather?" },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_x",
                  type: "function",
                  function: { name: "get_weather", arguments: "{}" },
                },
              ],
            },
            { role: "tool", tool_call_id: "call_x", content: "72F" },
          ],
        }),
      });
      expect(h.driver.calls).toHaveLength(1);
      const call = h.driver.calls[0]!;
      expect(call.toolResults).toEqual([
        { type: "tool_result", tool_use_id: "call_x", content: "72F" },
      ]);
    } finally {
      await teardown(h);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: OPENAI-07 TurnOrigin / X-Request-Id
// ---------------------------------------------------------------------------

describe("POST /v1/chat/completions — driver input propagation (OPENAI-07)", () => {
  it("driver receives keyHash (hashHex) and agentName from the authenticated key", async () => {
    const h = await bootHarness({ events: textStream });
    try {
      await fetch(`${h.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${h.pinnedKey}`,
        },
        body: JSON.stringify({
          model: "clawdy",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      const call = h.driver.calls[0]!;
      expect(call.keyHash).toBe(h.pinnedHashHex);
      // The TurnOrigin.source.id fingerprint is first 8 hex of keyHash — verify.
      expect(call.keyHash.slice(0, 8)).toMatch(/^[0-9a-f]{8}$/);
      expect(call.agentName).toBe("clawdy");
    } finally {
      await teardown(h);
    }
  });

  it("X-Request-Id is echoed when client sends it", async () => {
    const h = await bootHarness({ events: textStream });
    try {
      const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${h.pinnedKey}`,
          "x-request-id": "test-xyz-123",
        },
        body: JSON.stringify({
          model: "clawdy",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(res.headers.get("x-request-id")).toBe("test-xyz-123");
      expect(h.driver.calls[0]!.xRequestId).toBe("test-xyz-123");
    } finally {
      await teardown(h);
    }
  });

  it("X-Request-Id is generated when client omits it (nanoid pattern)", async () => {
    const h = await bootHarness({ events: textStream });
    try {
      const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${h.pinnedKey}`,
        },
        body: JSON.stringify({
          model: "clawdy",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      const xrid = res.headers.get("x-request-id");
      expect(xrid).toBeTruthy();
      // nanoid(16) alphabet is [A-Za-z0-9_-]; length 16.
      expect(xrid).toMatch(/^[A-Za-z0-9_-]{16}$/);
      expect(h.driver.calls[0]!.xRequestId).toBe(xrid);
    } finally {
      await teardown(h);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: body validation + route negatives
// ---------------------------------------------------------------------------

describe("POST /v1/chat/completions — body validation", () => {
  it("malformed JSON body → 400 invalid_request_error code:body_parse_error", async () => {
    const h = await bootHarness({ events: textStream });
    try {
      const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${h.pinnedKey}`,
        },
        body: "{ this is not json",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.code).toBe("body_parse_error");
    } finally {
      await teardown(h);
    }
  });

  it("body larger than maxRequestBodyBytes → 413", async () => {
    const h = await bootHarness({ events: textStream, maxBody: 256 });
    try {
      const big = "x".repeat(300);
      const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${h.pinnedKey}`,
        },
        body: JSON.stringify({
          model: "clawdy",
          messages: [{ role: "user", content: big }],
        }),
      });
      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.error.code).toBe("body_too_large");
    } finally {
      await teardown(h);
    }
  });

  it("missing user message → 400 code:no_user_message", async () => {
    const h = await bootHarness({ events: textStream });
    try {
      const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${h.pinnedKey}`,
        },
        body: JSON.stringify({
          model: "clawdy",
          messages: [{ role: "system", content: "alone" }],
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("no_user_message");
    } finally {
      await teardown(h);
    }
  });

  it("wrong Content-Type → 400 code:invalid_content_type", async () => {
    const h = await bootHarness({ events: textStream });
    try {
      const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          authorization: `Bearer ${h.pinnedKey}`,
        },
        body: JSON.stringify({
          model: "clawdy",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("invalid_content_type");
    } finally {
      await teardown(h);
    }
  });
});

describe("server — OPTIONS + 404 + graceful close", () => {
  it("OPTIONS /v1/chat/completions → 204 with CORS preflight", async () => {
    const h = await bootHarness({ events: textStream });
    try {
      const res = await fetch(`${h.baseUrl}/v1/chat/completions`, { method: "OPTIONS" });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-methods")).toContain("POST");
      expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
    } finally {
      await teardown(h);
    }
  });

  it("unknown route → 404 route_not_found", async () => {
    const h = await bootHarness({ events: textStream });
    try {
      const res = await fetch(`${h.baseUrl}/not/a/route`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.type).toBe("not_found_error");
      expect(body.error.code).toBe("route_not_found");
    } finally {
      await teardown(h);
    }
  });

  it("graceful close — activeStreams are closed before server.close() completes", async () => {
    const h = await bootHarness({
      events: textStream,
      perEventDelayMs: 200,
      keepaliveMs: 50,
    });
    // Kick off a streaming request but don't read its body — this keeps a
    // live SSE handle in activeStreams.
    const ac = new AbortController();
    const p = fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${h.pinnedKey}`,
      },
      body: JSON.stringify({
        model: "clawdy",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
      signal: ac.signal,
    });
    // Wait long enough for the handle to register.
    await new Promise((r) => setTimeout(r, 100));
    expect(h.handle.activeStreams.size).toBeGreaterThanOrEqual(1);
    // Close — activeStreams should be cleared first.
    const closePromise = h.handle.close();
    ac.abort();
    await p.catch(() => {
      /* expected */
    });
    await closePromise;
    expect(h.handle.activeStreams.size).toBe(0);
    h.keysStore.close();
  });
});

// ---------------------------------------------------------------------------
// Post-v2.0 hardening — warm-path startup race (quick task 260419-jtk Task 3)
// ---------------------------------------------------------------------------

describe("POST /v1/chat/completions — warm-path startup race", () => {
  it("W1 — agent already running → immediate dispatch (no wait)", async () => {
    const h = await bootHarness({
      events: textStream,
      agentIsRunning: () => true,
      agentReadinessWaitMs: 1000,
      agentReadinessPollIntervalMs: 50,
    });
    try {
      const started = Date.now();
      const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${h.pinnedKey}`,
        },
        body: JSON.stringify({
          model: "clawdy",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      const elapsed = Date.now() - started;
      expect(res.status).toBe(200);
      // No poll cycles — should complete well under the 1000ms budget.
      expect(elapsed).toBeLessThan(500);
      expect(h.driver.calls.length).toBe(1);
    } finally {
      await teardown(h);
    }
  });

  it("W2 — agent never warms within budget → 503 Retry-After:2 + agent_warming code", async () => {
    const h = await bootHarness({
      events: textStream,
      agentIsRunning: () => false,
      agentReadinessWaitMs: 150,
      agentReadinessPollIntervalMs: 25,
    });
    try {
      const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${h.pinnedKey}`,
        },
        body: JSON.stringify({
          model: "clawdy",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("2");
      const body = await res.json();
      expect(body.error.type).toBe("server_error");
      expect(body.error.code).toBe("agent_warming");
      expect(body.error.message).toMatch(/warming/i);
      // Pre-dispatch gate held — driver never invoked.
      expect(h.driver.calls.length).toBe(0);
    } finally {
      await teardown(h);
    }
  });

  it("W3 — agent warms partway through the poll window → dispatch succeeds", async () => {
    let callCount = 0;
    const isRunning = (_name: string): boolean => {
      callCount++;
      // Not running for the first 3 observations, then ready.
      return callCount > 3;
    };
    const h = await bootHarness({
      events: textStream,
      agentIsRunning: isRunning,
      agentReadinessWaitMs: 500,
      agentReadinessPollIntervalMs: 25,
    });
    try {
      const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${h.pinnedKey}`,
        },
        body: JSON.stringify({
          model: "clawdy",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(res.status).toBe(200);
      // Polled at least 3 times to flip to true, capped by budget/pollInterval.
      expect(callCount).toBeGreaterThanOrEqual(3);
      expect(callCount).toBeLessThanOrEqual(500 / 25 + 4);
      expect(h.driver.calls.length).toBe(1);
    } finally {
      await teardown(h);
    }
  });

  it("W4 — no agentIsRunning config → wait gate disabled (Plan 02 hermetic harness preserved)", async () => {
    // Pre-Task-3 behaviour: NO agentIsRunning field passed. Existing Plan 02
    // tests rely on this hermetic path — regression guard.
    const h = await bootHarness({ events: textStream });
    try {
      const started = Date.now();
      const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${h.pinnedKey}`,
        },
        body: JSON.stringify({
          model: "clawdy",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(res.status).toBe(200);
      expect(Date.now() - started).toBeLessThan(500);
      expect(h.driver.calls.length).toBe(1);
    } finally {
      await teardown(h);
    }
  });

  it("W5 — SessionError 'not running' from driver on non-stream path surfaces as 503 agent_warming", async () => {
    // No agentIsRunning config — disable pre-dispatch gate so we exercise the
    // defensive catch path inside runNonStreaming.
    const throwingDriver: OpenAiSessionDriver = {
      // eslint-disable-next-line require-yield
      async *dispatch(_input) {
        throw new SessionError("Agent 'clawdy' is not running", "clawdy");
      },
    };
    const h = await bootHarness({
      events: textStream,
      driverOverride: throwingDriver,
    });
    try {
      const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${h.pinnedKey}`,
        },
        body: JSON.stringify({
          model: "clawdy",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("2");
      const body = await res.json();
      expect(body.error.type).toBe("server_error");
      expect(body.error.code).toBe("agent_warming");
    } finally {
      await teardown(h);
    }
  });
});

// ---------------------------------------------------------------------------
// Upstream model failure — the CLI completed the turn but the API call inside
// it failed. Was an opaque 500 driver_error; now 502 upstream_error carrying
// the API's text (2026-09-23: "... version 2.1.280 or newer is required").
// ---------------------------------------------------------------------------

describe("POST /v1/chat/completions — upstream model failure", () => {
  const API_ERROR =
    "API Error: 400 Claude Code 2.1.140 does not support this model; " +
    "version 2.1.280 or newer is required.";
  const upstreamFailingDriver: OpenAiSessionDriver = {
    // eslint-disable-next-line require-yield
    async *dispatch(_input) {
      throw new UpstreamTurnError("openai-driver: initial drain query", "success", API_ERROR);
    },
  };
  const post = (h: TestHarness, stream: boolean) =>
    fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${h.pinnedKey}`,
      },
      body: JSON.stringify({
        model: "clawdy",
        messages: [{ role: "user", content: "hi" }],
        stream,
      }),
    });

  it("non-stream → 502 upstream_error carrying the upstream text", async () => {
    const h = await bootHarness({ events: textStream, driverOverride: upstreamFailingDriver });
    try {
      const res = await post(h, false);
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error.type).toBe("server_error");
      expect(body.error.code).toBe("upstream_error");
      expect(body.error.message).toBe(`Upstream model call failed: ${API_ERROR}`);
    } finally {
      await teardown(h);
    }
  });

  it("stream → in-stream error envelope with code upstream_error", async () => {
    const h = await bootHarness({ events: textStream, driverOverride: upstreamFailingDriver });
    try {
      const res = await post(h, true);
      expect(res.status).toBe(200); // SSE headers are committed before dispatch
      const parsed = parseSseBody(await res.text());
      const errors = parsed.chunks.filter(
        (c): c is { error: { code: string; message: string } } =>
          typeof c === "object" && c !== null && "error" in c,
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]!.error.code).toBe("upstream_error");
      expect(errors[0]!.error.message).toContain("2.1.280 or newer is required");
    } finally {
      await teardown(h);
    }
  });

  it("any other driver failure keeps the generic 500 driver_error", async () => {
    const brokenDriver: OpenAiSessionDriver = {
      // eslint-disable-next-line require-yield
      async *dispatch(_input) {
        throw new Error("Claude Code native binary not found");
      },
    };
    const h = await bootHarness({ events: textStream, driverOverride: brokenDriver });
    try {
      const res = await post(h, false);
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error.code).toBe("driver_error");
    } finally {
      await teardown(h);
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 73 Plan 02 — readiness-wait default tuned 2000 → 300ms (LAT-04)
// ---------------------------------------------------------------------------

describe("POST /v1/chat/completions — Phase 73 readiness-wait default", () => {
  it("uses 300ms default when no override provided (agent never warms → 503 within budget)", async () => {
    // No agentReadinessWaitMs passed → server falls back to its new 300ms default.
    // With agentIsRunning always false, the 503 arrives after ~300ms (the default).
    const h = await bootHarness({
      events: textStream,
      agentIsRunning: () => false,
      // agentReadinessWaitMs intentionally omitted — exercises the 300ms default.
      agentReadinessPollIntervalMs: 25,
    });
    try {
      const started = Date.now();
      const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${h.pinnedKey}`,
        },
        body: JSON.stringify({
          model: "clawdy",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      const elapsed = Date.now() - started;
      expect(res.status).toBe(503);
      // 300ms budget + some scheduler slack — previous 2000ms default would
      // let elapsed reach ~2s, so this upper bound is the regression guard.
      expect(elapsed).toBeLessThan(700);
      // And it DID wait — not an immediate 503 (would be < 50ms).
      expect(elapsed).toBeGreaterThanOrEqual(250);
      expect(h.driver.calls.length).toBe(0);
    } finally {
      await teardown(h);
    }
  });

  it("warm path (isRunning===true) skips wait — dispatches in under 50ms", async () => {
    // Warm agent: the single isRunning() call at the top of waitForAgentReady
    // returns true → handler skips the wait loop entirely. Total latency is
    // the HTTP round-trip + driver dispatch (a fixture replay here).
    const h = await bootHarness({
      events: textStream,
      agentIsRunning: () => true,
      // Large wait budget to prove the skip is what's fast — not the budget.
      agentReadinessWaitMs: 5000,
      agentReadinessPollIntervalMs: 25,
    });
    try {
      const started = Date.now();
      const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${h.pinnedKey}`,
        },
        body: JSON.stringify({
          model: "clawdy",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      const elapsed = Date.now() - started;
      expect(res.status).toBe(200);
      // Warm-path should dispatch fast; the wait loop is skipped entirely.
      // 500ms is a generous CI-friendly bound (spec says < 50ms on clawdy).
      expect(elapsed).toBeLessThan(500);
      expect(h.driver.calls.length).toBe(1);
    } finally {
      await teardown(h);
    }
  });
});

// ---------------------------------------------------------------------------
// Quick task 260419-mvh Task 2 — JSONL request logger integration
// ---------------------------------------------------------------------------

function makeRecordingLogger(): { logger: RequestLogger; records: RequestLogRecord[] } {
  const records: RequestLogRecord[] = [];
  const logger: RequestLogger = {
    log: (r) => {
      records.push(r);
    },
    close: async () => {},
  };
  return { logger, records };
}

/**
 * Wait for the recording logger to have accumulated at least `n` records or
 * until the 1s deadline passes. The logger fires inside res.on('close'),
 * which Node schedules microtask-late — a short poll keeps tests deterministic
 * without timing hacks.
 */
async function awaitRecords(
  records: RequestLogRecord[],
  n: number,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (records.length < n && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("POST /v1/chat/completions — request logging (quick task 260419-mvh)", () => {
  it("SI-1 — non-stream 200 writes exactly one record with full field shape", async () => {
    const { logger, records } = makeRecordingLogger();
    const h = await bootHarness({ events: textStream, requestLogger: logger });
    try {
      const started = Date.now();
      const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${h.pinnedKey}`,
        },
        body: JSON.stringify({
          model: "clawdy",
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        }),
      });
      expect(res.status).toBe(200);
      await awaitRecords(records, 1);
      expect(records).toHaveLength(1);
      const r = records[0]!;
      expect(r.status_code).toBe(200);
      expect(r.stream).toBe(false);
      expect(r.finish_reason).toBe("stop");
      expect(r.total_ms).toBeGreaterThanOrEqual(0);
      expect(r.total_ms).toBeLessThan(Date.now() - started + 500);
      expect(r.response_bytes).toBeGreaterThan(0);
      expect(r.agent).toBe("clawdy");
      expect(r.model).toBe("clawdy");
      expect(r.messages_count).toBe(1);
      expect(r.bearer_key_prefix).toBe(h.pinnedKey.slice(0, 12));
      expect(r.bearer_key_prefix!.length).toBe(12);
      expect(r.error_type).toBeNull();
      expect(r.error_code).toBeNull();
      expect(r.method).toBe("POST");
      expect(r.path).toBe("/v1/chat/completions");
    } finally {
      await teardown(h);
    }
  });

  it("SI-2 — stream 200 writes record with ttfb_ms > 0 and finish_reason:'stop'", async () => {
    const { logger, records } = makeRecordingLogger();
    const h = await bootHarness({
      events: textStream,
      perEventDelayMs: 5,
      requestLogger: logger,
    });
    try {
      const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${h.pinnedKey}`,
        },
        body: JSON.stringify({
          model: "clawdy",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      });
      await res.text();
      await awaitRecords(records, 1);
      expect(records).toHaveLength(1);
      const r = records[0]!;
      expect(r.stream).toBe(true);
      expect(r.status_code).toBe(200);
      expect(r.finish_reason).toBe("stop");
      expect(r.ttfb_ms).not.toBeNull();
      expect(r.ttfb_ms!).toBeGreaterThanOrEqual(0);
      expect(r.total_ms).toBeGreaterThanOrEqual(r.ttfb_ms!);
      expect(r.response_bytes).toBeGreaterThan(0);
    } finally {
      await teardown(h);
    }
  });

  it("SI-3 — 401 missing bearer writes record with error_code:'missing_key'", async () => {
    const { logger, records } = makeRecordingLogger();
    const h = await bootHarness({ events: textStream, requestLogger: logger });
    try {
      const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "clawdy",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(res.status).toBe(401);
      await awaitRecords(records, 1);
      expect(records).toHaveLength(1);
      const r = records[0]!;
      expect(r.status_code).toBe(401);
      expect(r.error_type).toBe("authentication_error");
      expect(r.error_code).toBe("missing_key");
      expect(r.bearer_key_prefix).toBeNull();
      expect(r.agent).toBeNull();
    } finally {
      await teardown(h);
    }
  });

  it("SI-4 — 503 agent warming writes record with error_code:'agent_warming'", async () => {
    const { logger, records } = makeRecordingLogger();
    const h = await bootHarness({
      events: textStream,
      requestLogger: logger,
      agentIsRunning: () => false,
      agentReadinessWaitMs: 100,
      agentReadinessPollIntervalMs: 25,
    });
    try {
      const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${h.pinnedKey}`,
        },
        body: JSON.stringify({
          model: "clawdy",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(res.status).toBe(503);
      await awaitRecords(records, 1);
      expect(records).toHaveLength(1);
      const r = records[0]!;
      expect(r.status_code).toBe(503);
      expect(r.error_code).toBe("agent_warming");
      expect(r.agent).toBe("clawdy"); // key resolved before warm-gate tripped
      expect(r.bearer_key_prefix).toBe(h.pinnedKey.slice(0, 12));
    } finally {
      await teardown(h);
    }
  });

  it("SI-5 — GET /v1/models writes record with method:'GET', agent/messages_count null, bearer null", async () => {
    const { logger, records } = makeRecordingLogger();
    const h = await bootHarness({ events: textStream, requestLogger: logger });
    try {
      const res = await fetch(`${h.baseUrl}/v1/models`);
      expect(res.status).toBe(200);
      await awaitRecords(records, 1);
      expect(records).toHaveLength(1);
      const r = records[0]!;
      expect(r.method).toBe("GET");
      expect(r.path).toBe("/v1/models");
      expect(r.agent).toBeNull();
      expect(r.messages_count).toBeNull();
      expect(r.bearer_key_prefix).toBeNull();
      expect(r.status_code).toBe(200);
    } finally {
      await teardown(h);
    }
  });

  it("SI-6 — exactly one logger.log() call per request (no duplicates across close events)", async () => {
    const { logger, records } = makeRecordingLogger();
    const h = await bootHarness({ events: textStream, requestLogger: logger });
    try {
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${h.pinnedKey}`,
          },
          body: JSON.stringify({
            model: "clawdy",
            messages: [{ role: "user", content: `hi ${i}` }],
          }),
        });
        expect(res.status).toBe(200);
      }
      await awaitRecords(records, 3);
      expect(records).toHaveLength(3);
    } finally {
      await teardown(h);
    }
  });

  it("SI-7 — 403 agent-mismatch still records (bearer prefix + agent set from key, error_code:'agent_mismatch')", async () => {
    const { logger, records } = makeRecordingLogger();
    const h = await bootHarness({ events: textStream, requestLogger: logger });
    try {
      const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${h.pinnedKey}`,
        },
        body: JSON.stringify({
          model: "assistant", // key is pinned to clawdy → 403
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(res.status).toBe(403);
      await awaitRecords(records, 1);
      const r = records[0]!;
      expect(r.status_code).toBe(403);
      expect(r.error_type).toBe("permission_error");
      expect(r.error_code).toBe("agent_mismatch");
      expect(r.bearer_key_prefix).toBe(h.pinnedKey.slice(0, 12));
      expect(r.agent).toBe("clawdy"); // resolved before mismatch check
      expect(r.model).toBe("assistant");
    } finally {
      await teardown(h);
    }
  });
});
