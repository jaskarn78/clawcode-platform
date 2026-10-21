/**
 * Phase 135 Plan 04 Task 2 — VAD filter + Deepgram param passthrough.
 *
 * Pins six behaviors at the openDeepgramConnection boundary:
 *
 *   1. High-confidence multi-word final → onFinalTranscript invoked.
 *   2. Low-confidence (< minConfidence) final → onFinalTranscript NOT
 *      invoked; onLowConfidenceReject invoked with transcript + confidence.
 *   3. Short (< minWordCount) final → onFinalTranscript NOT invoked;
 *      onShortUtteranceReject invoked with transcript + wordCount.
 *   4. Final with undefined confidence (Deepgram omitted the field) →
 *      treated as 1.0; onFinalTranscript invoked.
 *   5. Custom VadConfig thresholds win over the DEFAULT_* constants.
 *   6. utterance_end_ms + endpointing reach client.listen.v1.connect().
 *
 * Strategy: vi.mock("@deepgram/sdk", ...) replaces DeepgramClient with a
 * test double that exposes the connect() call args + the registered
 * `message` handler. We then invoke the handler with crafted Results
 * messages and assert the callback wiring.
 *
 * Aligns with the silent-path-bifurcation memory: stt.ts is the
 * production path (Deepgram listen.v1.connect). The filter must live at
 * the message-handler callsite so it actually reaches the prod code
 * path, not in a separate helper that nobody calls.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock @deepgram/sdk ─────────────────────────────────────────────────────
//
// Capture the connect() options + the `message` handler registration so
// the test can drive the inner filter logic without a real WS.
type MessageHandler = (msg: unknown) => void;

const connectCalls: Array<Record<string, unknown>> = [];
let capturedMessageHandler: MessageHandler | null = null;
let finalizeCalls = 0;

vi.mock("@deepgram/sdk", () => {
  class FakeSocket {
    private handlers = new Map<string, ((arg: unknown) => void)[]>();
    on(event: string, cb: (arg: unknown) => void) {
      const arr = this.handlers.get(event) ?? [];
      arr.push(cb);
      this.handlers.set(event, arr);
      if (event === "message") {
        capturedMessageHandler = cb as MessageHandler;
      }
    }
    connect() {
      /* no-op — waitForOpen resolves immediately below */
    }
    waitForOpen() {
      return Promise.resolve();
    }
    sendMedia(_data: unknown) {
      /* no-op */
    }
    sendKeepAlive(_payload: unknown) {
      /* no-op */
    }
    sendFinalize(_payload: unknown) {
      finalizeCalls += 1;
    }
    close() {
      /* no-op */
    }
  }
  return {
    DeepgramClient: class {
      constructor(_args: { apiKey: string }) {
        /* no-op */
      }
      listen = {
        v1: {
          connect: async (opts: Record<string, unknown>) => {
            connectCalls.push(opts);
            return new FakeSocket();
          },
        },
      };
    },
  };
});

import {
  openDeepgramConnection,
  DEFAULT_UTTERANCE_END_MS,
  DEFAULT_ENDPOINTING_MS,
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_MIN_WORD_COUNT,
} from "../stt.js";

beforeEach(() => {
  connectCalls.length = 0;
  capturedMessageHandler = null;
  finalizeCalls = 0;
});

/**
 * Build a Results-shaped Deepgram message.
 *
 * Phase 135 REBUILD: `is_final` segments are now BUFFERED, not dispatched —
 * a turn dispatches only when `speechFinal` (endpointing boundary),
 * `fromFinalize` (reply to a Finalize), or a separate `UtteranceEnd` message
 * (see {@link utteranceEndMsg}) arrives.
 */
function resultsMsg(opts: {
  transcript: string;
  confidence?: number;
  isFinal?: boolean;
  speechFinal?: boolean;
  fromFinalize?: boolean;
  duration?: number;
}) {
  const alt: Record<string, unknown> = { transcript: opts.transcript };
  if (opts.confidence !== undefined) alt.confidence = opts.confidence;
  return {
    type: "Results",
    is_final: opts.isFinal ?? true,
    speech_final: opts.speechFinal ?? false,
    from_finalize: opts.fromFinalize ?? false,
    duration: opts.duration ?? 1.0,
    channel: { alternatives: [alt] },
  };
}

/** Build an UtteranceEnd-shaped Deepgram message (word-gap turn boundary). */
function utteranceEndMsg() {
  return { type: "UtteranceEnd", channel: [0, 2], last_word_end: 3.1 };
}

describe("openDeepgramConnection — VAD param passthrough (135.4 Task 2)", () => {
  it("passes the configured utterance_end_ms + endpointing into listen.v1.connect", async () => {
    await openDeepgramConnection(
      "dg-key",
      {
        onFinalTranscript: () => {},
        onInterimTranscript: () => {},
        onError: () => {},
      },
      { utteranceEndMs: 2500, endpointingMs: 800 },
    );
    expect(connectCalls).toHaveLength(1);
    expect(connectCalls[0].utterance_end_ms).toBe(2500);
    expect(connectCalls[0].endpointing).toBe(800);
  });

  it("falls back to DEFAULT_UTTERANCE_END_MS + DEFAULT_ENDPOINTING_MS when vad is undefined", async () => {
    await openDeepgramConnection(
      "dg-key",
      {
        onFinalTranscript: () => {},
        onInterimTranscript: () => {},
        onError: () => {},
      },
    );
    expect(connectCalls[0].utterance_end_ms).toBe(DEFAULT_UTTERANCE_END_MS);
    expect(connectCalls[0].endpointing).toBe(DEFAULT_ENDPOINTING_MS);
  });

  it("falls back per-field when only one VAD field is set", async () => {
    await openDeepgramConnection(
      "dg-key",
      {
        onFinalTranscript: () => {},
        onInterimTranscript: () => {},
        onError: () => {},
      },
      { utteranceEndMs: 3000 },
    );
    expect(connectCalls[0].utterance_end_ms).toBe(3000);
    expect(connectCalls[0].endpointing).toBe(DEFAULT_ENDPOINTING_MS);
  });
});

describe("openDeepgramConnection — VAD filter at final-transcript callsite (135.4 Task 2)", () => {
  it("dispatches a high-confidence multi-word final", async () => {
    const onFinalTranscript = vi.fn();
    const onLowConfidenceReject = vi.fn();
    const onShortUtteranceReject = vi.fn();
    await openDeepgramConnection("dg-key", {
      onFinalTranscript,
      onInterimTranscript: () => {},
      onError: () => {},
      onLowConfidenceReject,
      onShortUtteranceReject,
    });
    expect(capturedMessageHandler).not.toBeNull();
    capturedMessageHandler!(
      resultsMsg({ transcript: "hey what's the weather", confidence: 0.9, speechFinal: true, duration: 1.4 }),
    );
    expect(onFinalTranscript).toHaveBeenCalledWith("hey what's the weather", 1.4);
    expect(onLowConfidenceReject).not.toHaveBeenCalled();
    expect(onShortUtteranceReject).not.toHaveBeenCalled();
  });

  it("drops a low-confidence final and fires onLowConfidenceReject", async () => {
    const onFinalTranscript = vi.fn();
    const onLowConfidenceReject = vi.fn();
    const onShortUtteranceReject = vi.fn();
    await openDeepgramConnection("dg-key", {
      onFinalTranscript,
      onInterimTranscript: () => {},
      onError: () => {},
      onLowConfidenceReject,
      onShortUtteranceReject,
    });
    capturedMessageHandler!(
      resultsMsg({ transcript: "muffled crowd noise here", confidence: 0.4 }),
    );
    expect(onFinalTranscript).not.toHaveBeenCalled();
    expect(onLowConfidenceReject).toHaveBeenCalledWith("muffled crowd noise here", 0.4);
    expect(onShortUtteranceReject).not.toHaveBeenCalled();
  });

  it("drops a short (1-word) final and fires onShortUtteranceReject", async () => {
    const onFinalTranscript = vi.fn();
    const onLowConfidenceReject = vi.fn();
    const onShortUtteranceReject = vi.fn();
    await openDeepgramConnection("dg-key", {
      onFinalTranscript,
      onInterimTranscript: () => {},
      onError: () => {},
      onLowConfidenceReject,
      onShortUtteranceReject,
    });
    capturedMessageHandler!(resultsMsg({ transcript: "yeah", confidence: 0.9, speechFinal: true }));
    expect(onFinalTranscript).not.toHaveBeenCalled();
    expect(onShortUtteranceReject).toHaveBeenCalledWith("yeah", 1);
    expect(onLowConfidenceReject).not.toHaveBeenCalled();
  });

  it("treats undefined confidence as 1.0 (allows the transcript)", async () => {
    const onFinalTranscript = vi.fn();
    const onLowConfidenceReject = vi.fn();
    await openDeepgramConnection("dg-key", {
      onFinalTranscript,
      onInterimTranscript: () => {},
      onError: () => {},
      onLowConfidenceReject,
    });
    capturedMessageHandler!(
      resultsMsg({ transcript: "what time is it", confidence: undefined, speechFinal: true, duration: 1.1 }),
    );
    expect(onFinalTranscript).toHaveBeenCalledWith("what time is it", 1.1);
    expect(onLowConfidenceReject).not.toHaveBeenCalled();
  });

  it("custom thresholds override the defaults (minConfidence=0.8 drops 0.7-confidence single-word)", async () => {
    const onFinalTranscript = vi.fn();
    const onLowConfidenceReject = vi.fn();
    const onShortUtteranceReject = vi.fn();
    await openDeepgramConnection(
      "dg-key",
      {
        onFinalTranscript,
        onInterimTranscript: () => {},
        onError: () => {},
        onLowConfidenceReject,
        onShortUtteranceReject,
      },
      { minConfidence: 0.8, minWordCount: 1 },
    );
    // 0.7-confidence below the custom 0.8 floor → confidence-fail first.
    capturedMessageHandler!(resultsMsg({ transcript: "yes", confidence: 0.7 }));
    expect(onFinalTranscript).not.toHaveBeenCalled();
    expect(onLowConfidenceReject).toHaveBeenCalledWith("yes", 0.7);
    // minWordCount lowered to 1 — a 1-word HIGH-confidence final should pass.
    capturedMessageHandler!(
      resultsMsg({ transcript: "ready", confidence: 0.95, speechFinal: true, duration: 0.4 }),
    );
    expect(onFinalTranscript).toHaveBeenCalledWith("ready", 0.4);
    expect(onShortUtteranceReject).not.toHaveBeenCalled();
  });

  it("optional reject callbacks may be omitted — filter still drops silently", async () => {
    const onFinalTranscript = vi.fn();
    await openDeepgramConnection("dg-key", {
      onFinalTranscript,
      onInterimTranscript: () => {},
      onError: () => {},
      // no onLowConfidenceReject / onShortUtteranceReject
    });
    // Should NOT throw despite missing reject callbacks.
    capturedMessageHandler!(resultsMsg({ transcript: "ok", confidence: 0.95 }));
    capturedMessageHandler!(resultsMsg({ transcript: "noisy", confidence: 0.2 }));
    expect(onFinalTranscript).not.toHaveBeenCalled();
  });

  it("interim transcripts are never filtered (filter only applies to is_final)", async () => {
    const onFinalTranscript = vi.fn();
    const onInterimTranscript = vi.fn();
    const onLowConfidenceReject = vi.fn();
    const onShortUtteranceReject = vi.fn();
    await openDeepgramConnection("dg-key", {
      onFinalTranscript,
      onInterimTranscript,
      onError: () => {},
      onLowConfidenceReject,
      onShortUtteranceReject,
    });
    // is_final: false — interim. Should bypass the filter entirely.
    capturedMessageHandler!(
      resultsMsg({ transcript: "ok", confidence: 0.1, isFinal: false }),
    );
    expect(onInterimTranscript).toHaveBeenCalledWith("ok");
    expect(onLowConfidenceReject).not.toHaveBeenCalled();
    expect(onShortUtteranceReject).not.toHaveBeenCalled();
    expect(onFinalTranscript).not.toHaveBeenCalled();
  });
});

describe("Phase 135 REBUILD — turn aggregation + dead-air rescue", () => {
  const baseCallbacks = () => ({
    onFinalTranscript: vi.fn(),
    onInterimTranscript: vi.fn(),
    onError: vi.fn(),
    onTurnFlush: vi.fn(),
    onDeadAirFinalize: vi.fn(),
  });

  it("buffers multiple is_final segments and dispatches ONE turn on speech_final", async () => {
    const cb = baseCallbacks();
    await openDeepgramConnection("dg-key", cb);
    capturedMessageHandler!(resultsMsg({ transcript: "hey clawdy", confidence: 0.9, duration: 0.8 }));
    capturedMessageHandler!(resultsMsg({ transcript: "what's the weather today", confidence: 0.9, duration: 1.2 }));
    // Buffered — NOT dispatched per is_final (the fragmentation bug).
    expect(cb.onFinalTranscript).not.toHaveBeenCalled();
    capturedMessageHandler!(resultsMsg({ transcript: "in london", confidence: 0.9, speechFinal: true, duration: 0.6 }));
    expect(cb.onFinalTranscript).toHaveBeenCalledTimes(1);
    expect(cb.onFinalTranscript).toHaveBeenCalledWith(
      "hey clawdy what's the weather today in london",
      2.6,
    );
    expect(cb.onTurnFlush).toHaveBeenCalledWith("speech_final", 3, 45);
  });

  it("dispatches the buffered turn on UtteranceEnd (noise-immune; no speech_final needed)", async () => {
    const cb = baseCallbacks();
    await openDeepgramConnection("dg-key", cb);
    capturedMessageHandler!(resultsMsg({ transcript: "tell me a joke", confidence: 0.9, duration: 1.0 }));
    expect(cb.onFinalTranscript).not.toHaveBeenCalled();
    capturedMessageHandler!(utteranceEndMsg());
    expect(cb.onFinalTranscript).toHaveBeenCalledWith("tell me a joke", 1.0);
    expect(cb.onTurnFlush).toHaveBeenCalledWith("utterance_end", 1, "tell me a joke".length);
  });

  it("does NOT double-dispatch when speech_final is followed by UtteranceEnd", async () => {
    const cb = baseCallbacks();
    await openDeepgramConnection("dg-key", cb);
    capturedMessageHandler!(resultsMsg({ transcript: "hello there", confidence: 0.9, speechFinal: true, duration: 1.0 }));
    expect(cb.onFinalTranscript).toHaveBeenCalledTimes(1);
    capturedMessageHandler!(utteranceEndMsg()); // buffer already flushed → no second dispatch
    expect(cb.onFinalTranscript).toHaveBeenCalledTimes(1);
    expect(finalizeCalls).toBe(0); // no speech since flush → no dead-air rescue
  });

  it("dead-air rescue: interim speech then UtteranceEnd with empty buffer sends Finalize", async () => {
    const cb = baseCallbacks();
    await openDeepgramConnection("dg-key", cb);
    // Interim speech arrives but NO is_final ever does (speech_final suppressed
    // by background noise — the exact dead-air failure mode).
    capturedMessageHandler!(resultsMsg({ transcript: "are you there", confidence: 0.9, isFinal: false }));
    expect(finalizeCalls).toBe(0);
    capturedMessageHandler!(utteranceEndMsg());
    expect(finalizeCalls).toBe(1);
    expect(cb.onDeadAirFinalize).toHaveBeenCalledTimes(1);
    expect(cb.onFinalTranscript).not.toHaveBeenCalled();
  });

  it("treats a from_finalize result as a turn boundary (reason=finalize)", async () => {
    const cb = baseCallbacks();
    await openDeepgramConnection("dg-key", cb);
    capturedMessageHandler!(resultsMsg({ transcript: "hello world", confidence: 0.9, fromFinalize: true, duration: 1.0 }));
    expect(cb.onFinalTranscript).toHaveBeenCalledWith("hello world", 1.0);
    expect(cb.onTurnFlush).toHaveBeenCalledWith("finalize", 1, "hello world".length);
  });

  it("does NOT send Finalize on UtteranceEnd when no speech was heard (genuine silence)", async () => {
    const cb = baseCallbacks();
    await openDeepgramConnection("dg-key", cb);
    capturedMessageHandler!(utteranceEndMsg());
    expect(finalizeCalls).toBe(0);
    expect(cb.onDeadAirFinalize).not.toHaveBeenCalled();
    expect(cb.onFinalTranscript).not.toHaveBeenCalled();
  });
});

describe("Phase 135 REBUILD — keyterm prompting", () => {
  it("passes keyterm query params when keyterms are configured", async () => {
    await openDeepgramConnection(
      "dg-key",
      { onFinalTranscript: () => {}, onInterimTranscript: () => {}, onError: () => {} },
      { keyterms: ["Clawdy", "ClawCode"] },
    );
    expect(connectCalls[0].keyterm).toEqual(["Clawdy", "ClawCode"]);
  });

  it("omits the keyterm param when no keyterms are configured", async () => {
    await openDeepgramConnection("dg-key", {
      onFinalTranscript: () => {},
      onInterimTranscript: () => {},
      onError: () => {},
    });
    expect(connectCalls[0].keyterm).toBeUndefined();
  });

  it("drops empty/whitespace keyterms (no empty keyterm param)", async () => {
    await openDeepgramConnection(
      "dg-key",
      { onFinalTranscript: () => {}, onInterimTranscript: () => {}, onError: () => {} },
      { keyterms: ["  ", ""] },
    );
    expect(connectCalls[0].keyterm).toBeUndefined();
  });
});

describe("VAD defaults — Phase 135.4 values", () => {
  it("DEFAULT_UTTERANCE_END_MS is 1500 (Plan 02 was 1000)", () => {
    expect(DEFAULT_UTTERANCE_END_MS).toBe(1500);
  });
  it("DEFAULT_ENDPOINTING_MS is 1000 (Phase 135 REBUILD raised from 500)", () => {
    expect(DEFAULT_ENDPOINTING_MS).toBe(1000);
  });
  it("DEFAULT_MIN_CONFIDENCE is 0.6", () => {
    expect(DEFAULT_MIN_CONFIDENCE).toBe(0.6);
  });
  it("DEFAULT_MIN_WORD_COUNT is 2", () => {
    expect(DEFAULT_MIN_WORD_COUNT).toBe(2);
  });
});
