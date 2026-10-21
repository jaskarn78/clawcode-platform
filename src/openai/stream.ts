/**
 * Phase 69 Plan 02 — SSE writer for the OpenAI endpoint.
 *
 * Wraps a Node.js `http.ServerResponse` with:
 *
 *   - SSE headers (Pitfall 5): `Content-Type: text/event-stream`,
 *     `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`,
 *     `X-Accel-Buffering: no` (nginx buffering kill).
 *
 *   - Keepalive timer (69-RESEARCH.md Pattern 5): emits `: keepalive\n\n`
 *     (SSE comment — spec-compliant, clients ignore) every `keepaliveMs`
 *     while no real delta has been sent. Stops as soon as the first chunk
 *     is emitted so real content isn't interleaved with comments.
 *
 *   - Backpressure (Node.js backpressuring-in-streams docs): when
 *     `res.write()` returns `false`, `emit` awaits the `drain` event before
 *     resolving so the caller doesn't race ahead of the socket buffer.
 *
 *   - `[DONE]` terminator (Pitfall 4): `emitDone` writes the literal
 *     `data: [DONE]\n\n` bytes and calls `res.end()`. The double newline is
 *     load-bearing — Python OpenAI SDK's SSE parser blocks forever without it.
 *
 *   - Client-disconnect hook: `onClose(cb)` wires the `close` and `error`
 *     events on the response socket so the server can abort the Claude
 *     query via AbortController.
 *
 *   - Graceful-shutdown hook (Pitfall 10): server keeps a Set<handle> and
 *     calls `close()` on each before `server.close()` so the SSE connections
 *     don't hold the daemon open during systemd shutdown.
 *
 * This module is pure-Node; it has no knowledge of translator state,
 * ApiKeysStore, or config — just writes bytes in the right shape.
 */

import type { ServerResponse } from "node:http";
import type { ChatCompletionChunk, OpenAiError } from "./types.js";

/**
 * Public handle returned by `startOpenAiSse`. Each handle is bound to a single
 * `res` object; tests may use a `PassThrough`-backed shim that satisfies the
 * subset of `ServerResponse` we touch.
 */
export interface OpenAiSseHandle {
  /**
   * Emit one chunk as `data: <json>\n\n`. Resolves after the bytes have been
   * accepted by the socket (may await `drain` under backpressure). Resolves
   * to `false` if the response is already ended or the write failed.
   */
  emit(chunk: ChatCompletionChunk): Promise<boolean>;

  /**
   * Emit the terminal `data: [DONE]\n\n` sentinel and end the response.
   * Idempotent — a second call is a no-op.
   */
  emitDone(): void;

  /**
   * Emit a voice `status` / `tool` liveness frame (§4) as a VALID empty
   * `chat.completion.chunk` — `data: {…,"choices":[],"x_clawcode_event":{type,…}}`.
   * Strict OpenAI clients (e.g. the LiveKit `openai` plugin) parse it as an
   * empty chunk (`for choice in [] → no-op`) instead of crashing on a custom
   * `event:`-typed frame with no `choices`. Counts as activity (resets the
   * idle-watchdog) but does NOT set the first-delta flag (a status frame is not
   * content). No-op once the stream is done/ended. Resolves false on a failed write.
   */
  emitEvent(eventType: string, data: unknown): Promise<boolean>;

  /**
   * Emit a final error frame carrying the OpenAI error envelope
   * (`data: {"error":{…}}`, LiteLLM-compatible error-in-stream) followed by the
   * `[DONE]` sentinel. Use this when the driver fails mid stream after at least
   * one chunk has been sent — the client sees a clean termination. The `error`
   * key makes strict OpenAI clients raise a clean APIError (fail-fast); no named
   * `event: error` frame is written (it would crash chunk-parsing clients).
   */
  emitError(err: OpenAiError): void;

  /**
   * Register a callback for the `close` and `error` events on the underlying
   * response. Used by the server to trigger `AbortController.abort()` when
   * the client disconnects. Safe to call multiple times.
   */
  onClose(cb: () => void): void;

  /**
   * Hard-close the stream without writing `[DONE]`. Clears the keepalive
   * timer and calls `res.end()` if the response is not already ended. Used
   * by the graceful-shutdown path (Pitfall 10).
   */
  close(): void;
}

/** Minimal shape of `ServerResponse` we actually touch — kept tight for testability. */
interface SseResponseLike {
  writeHead(status: number, headers: Record<string, string>): void;
  write(chunk: string): boolean;
  end(): void;
  once(event: "drain", cb: () => void): void;
  on(event: "close" | "error", cb: () => void): void;
  readonly writableEnded: boolean;
}

/** Minimum keepalive cadence — guards against pathological 0/negative values. */
const MIN_KEEPALIVE_MS = 100;

/**
 * Wrap a `ServerResponse` with SSE semantics for OpenAI `/v1/chat/completions`.
 *
 * Writes the SSE response headers on creation (status 200). Every subsequent
 * call to `emit`/`emitDone`/`emitError` writes body bytes. The caller is
 * responsible for translating SDK events into ChatCompletionChunk objects
 * (via `src/openai/translator.ts`) before passing them here.
 */
export function startOpenAiSse(
  res: ServerResponse,
  opts: { keepaliveMs: number; enhanced?: boolean; id?: string; model?: string },
): OpenAiSseHandle {
  // Chunk identity for voice status/tool frames (emitEvent). These are emitted
  // as VALID empty `chat.completion.chunk`s so strict OpenAI clients (e.g. the
  // LiveKit `openai` plugin, which parses every non-[DONE] data: line as a
  // chunk) see `choices: []` → a harmless no-op, instead of `choices: null` →
  // `for choice in chunk.choices` TypeError. Only the voice path calls
  // emitEvent, and it always supplies id/model; the fallbacks keep the type total.
  const chunkId = opts.id ?? "chatcmpl-voice-event";
  const chunkModel = opts.model ?? "";
  const keepaliveMs = Math.max(opts.keepaliveMs, MIN_KEEPALIVE_MS);
  // Voice/enhanced mode turns the keepalive into an IDLE-WATCHDOG that NEVER
  // stops after the first delta — so mid-reply tool/think gaps stay alive
  // (resolves the client's relisten + audio-cutout bugs). Default (non-voice)
  // keeps the EXACT legacy behavior (comments only until the first real chunk)
  // so other OpenAI consumers are byte-identical.
  const enhanced = opts.enhanced === true;
  const resLike = res as unknown as SseResponseLike;

  // Write headers exactly once. Pitfall 5 headers included.
  resLike.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  let firstDeltaSent = false;
  let doneEmitted = false;
  // Idle-watchdog clock (enhanced mode): timestamp of the last bytes written —
  // a real chunk, a named event, OR a keepalive. A keepalive fires only after
  // the stream has been silent for >= keepaliveMs.
  let lastActivityAt = Date.now();

  function writeKeepalive(): void {
    if (resLike.writableEnded) return;
    try {
      resLike.write(": keepalive\n\n");
      lastActivityAt = Date.now();
    } catch {
      // Socket died between the check and the write — swallow; the next emit
      // attempt will see writableEnded.
    }
  }

  // Enhanced: emit one keepalive immediately so the client sees liveness within
  // ~1s (spec §3a), then tick finely (<=1s) so a gap is caught within ~1s of
  // crossing the cadence — keeping max silence under the client's 8s watchdog.
  if (enhanced) writeKeepalive();
  const keepalive = setInterval(
    () => {
      if (resLike.writableEnded) return;
      if (enhanced) {
        if (Date.now() - lastActivityAt >= keepaliveMs) writeKeepalive();
      } else {
        if (firstDeltaSent) return;
        writeKeepalive();
      }
    },
    enhanced ? Math.min(keepaliveMs, 1000) : keepaliveMs,
  );
  // Prevent the keepalive timer from keeping the Node.js event loop alive —
  // otherwise tests with fake timers could hang waiting for the timer to
  // fire when the test has already finished. Always unref in production too
  // (the caller owns the lifecycle of the response; SSE state shouldn't keep
  // the process alive on its own).
  if (typeof (keepalive as unknown as { unref?: () => void }).unref === "function") {
    (keepalive as unknown as { unref: () => void }).unref();
  }

  /**
   * Wait for a single `drain` event. Resolves to true if it arrived, or
   * false if the response ended first (we assume caller already observed
   * `writableEnded`).
   */
  function waitForDrain(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const onDrain = () => {
        if (settled) return;
        settled = true;
        resolve(true);
      };
      const onClose = () => {
        if (settled) return;
        settled = true;
        resolve(false);
      };
      resLike.once("drain", onDrain);
      resLike.on("close", onClose);
    });
  }

  async function emit(chunk: ChatCompletionChunk): Promise<boolean> {
    if (resLike.writableEnded || doneEmitted) return false;
    firstDeltaSent = true;
    lastActivityAt = Date.now();
    const body = `data: ${JSON.stringify(chunk)}\n\n`;
    try {
      const ok = resLike.write(body);
      if (!ok) {
        const drained = await waitForDrain();
        if (!drained) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  async function emitEvent(eventType: string, data: unknown): Promise<boolean> {
    if (resLike.writableEnded || doneEmitted) return false;
    lastActivityAt = Date.now();
    // Emit a HYBRID frame that satisfies BOTH SSE consumers of this endpoint:
    //
    //   event: <type>
    //   data: { …chat.completion.chunk…, <payload fields top-level>,
    //           choices: [], x_clawcode_event: { …payload, type } }
    //
    // 1. NAMED-EVENT consumer (the on-device iOS cascade parser,
    //    `SSEParser.swift` parseStatus/parseTool — the v2 handoff §2 contract):
    //    keys on the `event:` line, then reads `state`/`phase`/`label`/`ok` off
    //    the data object at the TOP LEVEL. So we both write the `event:` line
    //    AND mirror the payload fields to the chunk's top level. Without these,
    //    the v2 "working state" pill never lights up (the parser ignores
    //    `x_clawcode_event`).
    // 2. STRICT-CHUNK consumer (the LiveKit `openai` plugin, openai-python
    //    ≥2.36): the body is STILL a valid empty-`choices` chunk → it is
    //    processed as a normal chunk and `for choice in chunk.choices` iterates
    //    `[]` → no-op. A non-"error" `event:` line is yielded-as-chunk by
    //    `_streaming.py` (verified against the worker's pinned
    //    livekit-agents 1.6.1 → openai>=2.36 stack), so the added line is inert
    //    there. `x_clawcode_event` is retained for any consumer already on it.
    //
    // Fixed chunk identity is spread LAST so a payload key can never clobber
    // `choices`/`id`/etc. — `choices: []` stays authoritative (never `null`,
    // which would crash the LiveKit plugin). NOT typed as ChatCompletionChunk:
    // the top-level payload mirror is extra fields the strict consumer ignores,
    // and the object is only JSON-serialized to the wire. Deliberately does NOT
    // set `firstDeltaSent` — a status frame is not content, so it must not flip
    // the idle-watchdog's pre/post-first-token state.
    const payloadFields: Record<string, unknown> =
      data !== null && typeof data === "object" ? (data as Record<string, unknown>) : {};
    const eventChunk = {
      ...payloadFields,
      id: chunkId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: chunkModel,
      choices: [] as ChatCompletionChunk["choices"],
      x_clawcode_event: {
        ...(data !== null && typeof data === "object" ? (data as Record<string, unknown>) : { data }),
        type: eventType, // last — a payload `type` key must never clobber the event type
      },
    };
    const body = `event: ${eventType}\ndata: ${JSON.stringify(eventChunk)}\n\n`;
    try {
      const ok = resLike.write(body);
      if (!ok) {
        const drained = await waitForDrain();
        if (!drained) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  function emitDone(): void {
    if (doneEmitted) return;
    doneEmitted = true;
    clearInterval(keepalive);
    try {
      if (!resLike.writableEnded) {
        resLike.write("data: [DONE]\n\n");
        resLike.end();
      }
    } catch {
      // Socket closed already — nothing to do.
    }
  }

  function emitError(err: OpenAiError): void {
    if (doneEmitted) return;
    doneEmitted = true;
    clearInterval(keepalive);
    try {
      if (!resLike.writableEnded) {
        // Emit a final SSE frame carrying the OpenAI error envelope, then the
        // [DONE] terminator so well-behaved clients terminate their parse loop
        // gracefully (LiteLLM-style error-in-stream). NOTE: no named
        // `event: error` frame, even in enhanced/voice mode — the openai client
        // parses every non-[DONE] data: line as a chunk, so a `{message,...}`
        // payload (no `choices`, no `error` key) would crash it. The envelope
        // below has an `error` key, which the openai client special-cases into a
        // clean APIError (fail-fast preserved without the crash).
        resLike.write(`data: ${JSON.stringify(err)}\n\n`);
        resLike.write("data: [DONE]\n\n");
        resLike.end();
      }
    } catch {
      // ignore
    }
  }

  function onClose(cb: () => void): void {
    resLike.on("close", cb);
    resLike.on("error", cb);
  }

  function close(): void {
    clearInterval(keepalive);
    doneEmitted = true;
    try {
      if (!resLike.writableEnded) {
        resLike.end();
      }
    } catch {
      // ignore
    }
  }

  return { emit, emitEvent, emitDone, emitError, onClose, close };
}
