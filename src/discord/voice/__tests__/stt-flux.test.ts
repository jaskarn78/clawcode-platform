/**
 * Phase 135.1 Phase 5 — Flux STT client unit tests (mock WS).
 *
 * Verifies the v2 event routing (StartOfTurn / Update / EndOfTurn / EagerEndOfTurn
 * / TurnResumed), that non-TurnInfo frames are ignored, media send, CloseStream
 * on close, and the stereo→mono downmix.
 */
import { describe, it, expect, vi } from "vitest";
import pino from "pino";
import {
  openFluxConnection,
  handleFluxMessage,
  downmixStereoToMono,
  type FluxCallbacks,
} from "../stt-flux.js";

const log = pino({ level: "silent" });

function makeCallbacks(): FluxCallbacks & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {
    start: [], update: [], eot: [], eager: [], resumed: [], error: [],
  };
  return {
    calls,
    onStartOfTurn: (t) => calls.start.push(t),
    onUpdate: (t) => calls.update.push(t),
    onEndOfTurn: (t) => calls.eot.push(t),
    onEagerEndOfTurn: (t) => calls.eager.push(t),
    onTurnResumed: () => calls.resumed.push(true),
    onError: (e) => calls.error.push(e),
  };
}

const frame = (obj: unknown) => Buffer.from(JSON.stringify(obj));

describe("handleFluxMessage routing", () => {
  it("routes each TurnInfo event to its callback", () => {
    const cb = makeCallbacks();
    handleFluxMessage(frame({ type: "TurnInfo", event: "StartOfTurn", transcript: "Hey" }), cb);
    handleFluxMessage(frame({ type: "TurnInfo", event: "Update", transcript: "Hey there" }), cb);
    handleFluxMessage(frame({ type: "TurnInfo", event: "EagerEndOfTurn", transcript: "Hey there friend" }), cb);
    handleFluxMessage(frame({ type: "TurnInfo", event: "EndOfTurn", transcript: "Hey there friend." }), cb);
    handleFluxMessage(frame({ type: "TurnInfo", event: "TurnResumed", transcript: "Hey there friend and" }), cb);
    expect(cb.calls.start).toEqual(["Hey"]);
    expect(cb.calls.update).toEqual(["Hey there"]);
    expect(cb.calls.eager).toEqual(["Hey there friend"]);
    expect(cb.calls.eot).toEqual(["Hey there friend."]);
    expect(cb.calls.resumed).toEqual([true]);
  });

  it("ignores non-TurnInfo frames (Connected / ConfigureSuccess)", () => {
    const cb = makeCallbacks();
    handleFluxMessage(frame({ type: "Connected", request_id: "x" }), cb);
    handleFluxMessage(frame({ type: "ConfigureSuccess" }), cb);
    handleFluxMessage(Buffer.from("not json"), cb);
    expect(cb.calls.start).toEqual([]);
    expect(cb.calls.eot).toEqual([]);
  });

  it("suppresses empty StartOfTurn/Update transcripts", () => {
    const cb = makeCallbacks();
    handleFluxMessage(frame({ type: "TurnInfo", event: "StartOfTurn", transcript: "" }), cb);
    expect(cb.calls.start).toEqual([]);
  });
});

describe("downmixStereoToMono", () => {
  it("averages L and R into mono samples (halving byte length)", () => {
    // one stereo frame: L=1000, R=2000
    const stereo = Buffer.alloc(4);
    stereo.writeInt16LE(1000, 0);
    stereo.writeInt16LE(2000, 2);
    const mono = downmixStereoToMono(stereo);
    expect(mono.length).toBe(2);
    expect(mono.readInt16LE(0)).toBe(1500); // (1000+2000)>>1
  });
});

describe("openFluxConnection", () => {
  function fakeWs() {
    const handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
    const sent: (string | Buffer)[] = [];
    return {
      handlers,
      sent,
      ws: {
        readyState: 1,
        on(ev: string, cb: (...a: unknown[]) => void) {
          (handlers[ev] ??= []).push(cb);
        },
        send(d: string | Buffer) {
          sent.push(d);
        },
        close: vi.fn(),
      },
      emit: (ev: string, ...a: unknown[]) => (handlers[ev] ?? []).forEach((h) => h(...a)),
    };
  }

  it("connects, sends media, and CloseStream on close", async () => {
    const f = fakeWs();
    const cb = makeCallbacks();
    const p = openFluxConnection(
      "key",
      cb,
      { eotThreshold: 0.7 },
      log,
      () => f.ws as never,
    );
    f.emit("open");
    const conn = await p;
    conn.sendMedia(Buffer.from([1, 2, 3, 4]));
    // the audio frame is among the sent items (silence keepalive may also send)
    expect(f.sent.some((s) => Buffer.isBuffer(s) && s.length === 4)).toBe(true);
    conn.close();
    expect(f.sent.some((s) => typeof s === "string" && s.includes("CloseStream"))).toBe(true);
  });

  it("keepalive injects silence only during gaps (never mid-speech) and idle-closes", async () => {
    vi.useFakeTimers();
    try {
      const f = fakeWs();
      const conn = await (() => {
        const p = openFluxConnection("key", makeCallbacks(), {}, log, () => f.ws as never);
        f.emit("open");
        return p;
      })();
      const SILENCE_BYTES = Math.round(48000 * 0.08) * 2; // 80ms 48k mono s16le
      const silences = () =>
        f.sent.filter((s) => Buffer.isBuffer(s) && s.length === SILENCE_BYTES).length;

      // Just opened, <250ms idle → no silence injected.
      vi.advanceTimersByTime(160);
      expect(silences()).toBe(0);
      // Past 250ms idle → silence keeps the socket alive.
      vi.advanceTimersByTime(200);
      expect(silences()).toBeGreaterThan(0);

      // Real audio resets the idle clock → NO silence within the next 250ms
      // (this is the fix: never chop live speech with keepalive frames).
      const before = silences();
      conn.sendMedia(Buffer.from([1, 2, 3, 4]));
      vi.advanceTimersByTime(160);
      expect(silences()).toBe(before);

      // Long idle → connection self-closes (CloseStream + ws.close).
      vi.advanceTimersByTime(61_000);
      expect(f.sent.some((s) => typeof s === "string" && s.includes("CloseStream"))).toBe(true);
      expect(f.ws.close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
