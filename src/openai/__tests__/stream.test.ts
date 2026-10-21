/**
 * Phase 69 Plan 02 — unit tests for src/openai/stream.ts (OPENAI-02).
 *
 * Covers every row of 69-VALIDATION.md task 69-02-03 plus Pitfalls 4, 5, 10:
 *   - SSE headers: text/event-stream + no-cache + keep-alive + X-Accel-Buffering:no (Pitfall 5).
 *   - Keepalive `: keepalive\n\n` comment emitted while no delta yet; stops after first emit.
 *   - emit writes `data: <json>\n\n` format EXACTLY (Pitfall 4 — double newline).
 *   - emitDone writes `data: [DONE]\n\n` and ends the response.
 *   - emitError writes an error chunk then [DONE].
 *   - Backpressure: emit awaits `drain` when write returns false.
 *   - onClose callback fires when the response emits 'close'.
 *   - close() clears the keepalive timer (no more comments after close).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";

import { startOpenAiSse } from "../stream.js";
import type { ChatCompletionChunk } from "../types.js";

// ---------------------------------------------------------------------------
// Mock ServerResponse — minimal shape we consume
// ---------------------------------------------------------------------------

interface MockRes {
  res: ServerResponse;
  writeHeadCalls: Array<{ status: number; headers: Record<string, string> }>;
  output(): string;
  outputBytes: string[];
  /** Make the next `write()` call return false, simulating a full buffer. */
  simulateFullBufferOnce(): void;
  /** Emit a 'drain' event — tests use this after simulateFullBufferOnce. */
  triggerDrain(): void;
  /** Emit a 'close' event — simulates client disconnect. */
  triggerClose(): void;
  writableEnded: boolean;
}

function mockRes(): MockRes {
  const bus = new EventEmitter();
  const bytes: string[] = [];
  let pendingFullBuffer = false;
  let ended = false;
  const writeHeadCalls: MockRes["writeHeadCalls"] = [];

  const res = {
    writeHead(status: number, headers: Record<string, string>): void {
      writeHeadCalls.push({ status, headers });
    },
    write(chunk: string): boolean {
      if (ended) return false;
      bytes.push(chunk);
      if (pendingFullBuffer) {
        pendingFullBuffer = false;
        return false;
      }
      return true;
    },
    end(): void {
      ended = true;
      bus.emit("finish");
    },
    once(event: string, cb: () => void): void {
      bus.once(event, cb);
    },
    on(event: string, cb: () => void): void {
      bus.on(event, cb);
    },
    get writableEnded(): boolean {
      return ended;
    },
  } as unknown as ServerResponse;

  return {
    res,
    writeHeadCalls,
    outputBytes: bytes,
    output: () => bytes.join(""),
    simulateFullBufferOnce: () => {
      pendingFullBuffer = true;
    },
    triggerDrain: () => bus.emit("drain"),
    triggerClose: () => bus.emit("close"),
    get writableEnded() {
      return ended;
    },
  };
}

function buildChunk(overrides: Partial<ChatCompletionChunk> = {}): ChatCompletionChunk {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1744934400,
    model: "clawdy",
    choices: [
      {
        index: 0,
        delta: { content: "hi" },
        finish_reason: null,
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("startOpenAiSse — headers", () => {
  it("writes text/event-stream + Cache-Control: no-cache, no-transform + Connection: keep-alive on first invocation", () => {
    const m = mockRes();
    startOpenAiSse(m.res, { keepaliveMs: 10_000 });
    expect(m.writeHeadCalls).toHaveLength(1);
    const call = m.writeHeadCalls[0]!;
    expect(call.status).toBe(200);
    expect(call.headers["Content-Type"]).toBe("text/event-stream");
    expect(call.headers["Cache-Control"]).toBe("no-cache, no-transform");
    expect(call.headers.Connection).toBe("keep-alive");
  });

  it("writes X-Accel-Buffering: no (Pitfall 5)", () => {
    const m = mockRes();
    startOpenAiSse(m.res, { keepaliveMs: 10_000 });
    expect(m.writeHeadCalls[0]!.headers["X-Accel-Buffering"]).toBe("no");
  });
});

describe("startOpenAiSse — keepalive", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits ': keepalive\\n\\n' comment when no delta sent within keepaliveMs", () => {
    const m = mockRes();
    startOpenAiSse(m.res, { keepaliveMs: 1000 });
    vi.advanceTimersByTime(1500);
    expect(m.output()).toContain(": keepalive\n\n");
  });

  it("emits multiple keepalive comments over multiple intervals while no delta sent", () => {
    const m = mockRes();
    startOpenAiSse(m.res, { keepaliveMs: 500 });
    vi.advanceTimersByTime(1600);
    const count = m.output().split(": keepalive\n\n").length - 1;
    expect(count).toBeGreaterThanOrEqual(3);
  });

  it("stops emitting keepalive once emit() is called", async () => {
    const m = mockRes();
    const handle = startOpenAiSse(m.res, { keepaliveMs: 500 });
    // Before first emit — keepalive fires.
    vi.advanceTimersByTime(500);
    const beforeCount = m.output().split(": keepalive\n\n").length - 1;

    // Switch to real timers for the emit (emit uses real Promise/IO).
    vi.useRealTimers();
    await handle.emit(buildChunk());
    vi.useFakeTimers();

    // After emit — keepalive should not add any more comments.
    vi.advanceTimersByTime(5000);
    const afterCount = m.output().split(": keepalive\n\n").length - 1;
    expect(afterCount).toBe(beforeCount);
  });
});

describe("startOpenAiSse — enhanced (voice) idle-watchdog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("emits a keepalive immediately (within ~1s) when enhanced", () => {
    const m = mockRes();
    startOpenAiSse(m.res, { keepaliveMs: 5000, enhanced: true });
    // Immediate beat happens synchronously at construction.
    expect(m.output()).toContain(": keepalive\n\n");
  });

  it("KEEPS emitting keepalives after the first delta during a silent gap (never stops)", async () => {
    const m = mockRes();
    const handle = startOpenAiSse(m.res, { keepaliveMs: 1000, enhanced: true });
    // Stay on fake timers throughout so Date.now() (the idle clock) is
    // consistent with the advanced timer clock. The mock write is synchronous,
    // so `await emit` resolves on the microtask queue without a real timer.
    await handle.emit(buildChunk()); // first real delta — legacy mode would stop here
    const afterDelta = m.output().split(": keepalive\n\n").length - 1;
    vi.advanceTimersByTime(3000); // silent gap (mid-reply tool call) → watchdog resumes
    const afterGap = m.output().split(": keepalive\n\n").length - 1;
    expect(afterGap).toBeGreaterThan(afterDelta);
  });

  it("a real delta suppresses the keepalive for one cadence window", async () => {
    const m = mockRes();
    const handle = startOpenAiSse(m.res, { keepaliveMs: 2000, enhanced: true });
    vi.advanceTimersByTime(2100); // one idle beat past the cadence
    const before = m.output().split(": keepalive\n\n").length - 1;
    await handle.emit(buildChunk()); // resets the idle clock (Date.now advanced)
    vi.advanceTimersByTime(1000); // < cadence since the delta
    const after = m.output().split(": keepalive\n\n").length - 1;
    expect(after).toBe(before); // no new keepalive yet
  });

  it("emitEvent emits a HYBRID frame: named event: line + top-level payload mirror + still a valid empty chunk", async () => {
    const m = mockRes();
    const handle = startOpenAiSse(m.res, {
      keepaliveMs: 10_000,
      enhanced: true,
      id: "chatcmpl-evt",
      model: "clawdy-voice",
    });
    await handle.emitEvent("tool", { phase: "start", name: "web_search", label: "Searching the web…" });
    const out = m.output();
    // The named `event:` line is what the iOS cascade parser keys on (handoff §2).
    expect(out).toContain("event: tool\ndata: ");
    const frame = out
      .split("\n\n")
      .map((s) => s.trim())
      .find((s) => s.includes("data: "))!;
    const dataLine = frame.split("\n").find((l) => l.startsWith("data: "))!;
    const chunk = JSON.parse(dataLine.slice("data: ".length));
    // Still a valid empty-choices chunk → strict LiveKit/openai consumer no-ops.
    expect(chunk.object).toBe("chat.completion.chunk");
    expect(chunk.id).toBe("chatcmpl-evt");
    expect(chunk.model).toBe("clawdy-voice");
    expect(chunk.choices).toEqual([]); // strict clients iterate this → harmless no-op
    // Payload mirrored at TOP LEVEL so iOS parseTool reads phase/label off the data object.
    expect(chunk.phase).toBe("start");
    expect(chunk.label).toBe("Searching the web…");
    expect(chunk.name).toBe("web_search");
    // x_clawcode_event retained for back-compat with any consumer already on it.
    expect(chunk.x_clawcode_event).toEqual({
      type: "tool",
      phase: "start",
      name: "web_search",
      label: "Searching the web…",
    });
  });

  it("emitEvent status frame mirrors `state` at top level for the iOS parseStatus path", async () => {
    const m = mockRes();
    const handle = startOpenAiSse(m.res, {
      keepaliveMs: 10_000,
      enhanced: true,
      id: "chatcmpl-evt",
      model: "clawdy-voice",
    });
    await handle.emitEvent("status", { state: "thinking" });
    const out = m.output();
    expect(out).toContain("event: status\ndata: ");
    const dataLine = out.split("\n").find((l) => l.startsWith("data: "))!;
    const chunk = JSON.parse(dataLine.slice("data: ".length));
    expect(chunk.choices).toEqual([]);
    expect(chunk.state).toBe("thinking"); // top-level for parseStatus
    expect(chunk.x_clawcode_event).toEqual({ type: "status", state: "thinking" });
  });

  it("emitError writes ONLY the OpenAI error envelope + [DONE], no named event: error frame", () => {
    const m = mockRes();
    const handle = startOpenAiSse(m.res, { keepaliveMs: 10_000, enhanced: true });
    const err = {
      error: { message: "tool timed out", type: "server_error" as const, code: "x" },
    };
    handle.emitError(err);
    const out = m.output();
    // The named frame is gone — it has no `choices`/`error` key and crashes
    // chunk-parsing clients. The envelope's `error` key → clean APIError.
    expect(out).not.toContain("event: error");
    expect(out).toContain(`data: ${JSON.stringify(err)}\n\n`);
    expect(out).toContain("data: [DONE]\n\n");
  });
});

describe("startOpenAiSse — emit format (Pitfall 4)", () => {
  it("emit writes 'data: <json>\\n\\n' format exactly", async () => {
    const m = mockRes();
    const handle = startOpenAiSse(m.res, { keepaliveMs: 10_000 });
    const chunk = buildChunk();
    await handle.emit(chunk);
    const body = m.output();
    // The chunk write is the last non-keepalive write. Strip any leading
    // keepalive (there shouldn't be any at 10s cadence, but defensive).
    const dataSegment = body.split(": keepalive\n\n").join("").trim();
    expect(dataSegment).toBe(`data: ${JSON.stringify(chunk)}\n\n`.trim());
    // Specifically — assert that the final write ended in a double newline.
    const last = m.outputBytes[m.outputBytes.length - 1]!;
    expect(last.endsWith("\n\n")).toBe(true);
    expect(last.startsWith("data: ")).toBe(true);
  });

  it("emit includes valid JSON that round-trips to the original chunk", async () => {
    const m = mockRes();
    const handle = startOpenAiSse(m.res, { keepaliveMs: 10_000 });
    const chunk = buildChunk({
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    });
    await handle.emit(chunk);
    const last = m.outputBytes[m.outputBytes.length - 1]!;
    const jsonPart = last.slice("data: ".length, -"\n\n".length);
    const parsed = JSON.parse(jsonPart);
    expect(parsed).toEqual(chunk);
  });
});

describe("startOpenAiSse — emitDone", () => {
  it("writes 'data: [DONE]\\n\\n' and ends the response", () => {
    const m = mockRes();
    const handle = startOpenAiSse(m.res, { keepaliveMs: 10_000 });
    handle.emitDone();
    expect(m.output()).toContain("data: [DONE]\n\n");
    expect(m.writableEnded).toBe(true);
  });

  it("is idempotent — a second emitDone is a no-op", () => {
    const m = mockRes();
    const handle = startOpenAiSse(m.res, { keepaliveMs: 10_000 });
    handle.emitDone();
    const first = m.output();
    handle.emitDone();
    expect(m.output()).toBe(first);
  });
});

describe("startOpenAiSse — emitError", () => {
  it("writes the error chunk then the [DONE] sentinel", () => {
    const m = mockRes();
    const handle = startOpenAiSse(m.res, { keepaliveMs: 10_000 });
    handle.emitError({
      error: {
        message: "mid-stream boom",
        type: "server_error",
        code: "driver_failed",
      },
    });
    const body = m.output();
    expect(body).toContain('"message":"mid-stream boom"');
    expect(body).toContain('"type":"server_error"');
    expect(body.indexOf('"server_error"')).toBeLessThan(body.indexOf("[DONE]"));
    expect(body).toContain("data: [DONE]\n\n");
    expect(m.writableEnded).toBe(true);
  });

  it("is mutually exclusive with emitDone — second call is a no-op", () => {
    const m = mockRes();
    const handle = startOpenAiSse(m.res, { keepaliveMs: 10_000 });
    handle.emitError({
      error: { message: "x", type: "server_error", code: null },
    });
    const first = m.output();
    handle.emitDone();
    expect(m.output()).toBe(first);
  });
});

describe("startOpenAiSse — backpressure", () => {
  it("emit awaits 'drain' when res.write returns false", async () => {
    const m = mockRes();
    const handle = startOpenAiSse(m.res, { keepaliveMs: 10_000 });
    m.simulateFullBufferOnce();
    let settled = false;
    const p = handle.emit(buildChunk()).then((v) => {
      settled = true;
      return v;
    });
    // Let the microtask queue drain — p should still be pending because
    // write returned false and we're awaiting 'drain'.
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    // Now emit the drain event — p should resolve true.
    m.triggerDrain();
    const result = await p;
    expect(result).toBe(true);
    expect(settled).toBe(true);
  });

  it("emit resolves false if the response closes during backpressure wait", async () => {
    const m = mockRes();
    const handle = startOpenAiSse(m.res, { keepaliveMs: 10_000 });
    m.simulateFullBufferOnce();
    const p = handle.emit(buildChunk());
    await Promise.resolve();
    m.triggerClose();
    const result = await p;
    expect(result).toBe(false);
  });
});

describe("startOpenAiSse — onClose + close", () => {
  it("onClose callback fires when res emits 'close'", () => {
    const m = mockRes();
    const handle = startOpenAiSse(m.res, { keepaliveMs: 10_000 });
    const cb = vi.fn();
    handle.onClose(cb);
    m.triggerClose();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("close() clears the keepalive timer — no more comments emitted after close", () => {
    vi.useFakeTimers();
    try {
      const m = mockRes();
      const handle = startOpenAiSse(m.res, { keepaliveMs: 500 });
      vi.advanceTimersByTime(500);
      const before = m.output();
      handle.close();
      vi.advanceTimersByTime(5000);
      const after = m.output();
      expect(after).toBe(before);
      expect(m.writableEnded).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
