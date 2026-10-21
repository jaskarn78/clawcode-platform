/**
 * Phase 135.1 Phase 4 — VoiceTtsSocket + resampler unit tests (mock WS).
 *
 * Verifies the ElevenLabs multi-context wire framing (init / text / flush /
 * close_context), the camelCase-inbound audio routing + base64 decode +
 * 24k-mono→48k-stereo upsample onto the audio stream, isFinal end-of-context,
 * and barge-in close_context. No network — a fake socket captures sends and
 * lets the test emit inbound messages.
 */
import { describe, it, expect, vi } from "vitest";
import pino from "pino";
import {
  VoiceTtsSocket,
  upsample24kMonoTo48kStereo,
  type WsLike,
} from "../tts-ws.js";

const log = pino({ level: "silent" });

/** Fake `ws` socket: records sends, exposes emit(event,...) to drive callbacks. */
function makeFakeWs() {
  const handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
  const sent: string[] = [];
  const ws = {
    readyState: 1,
    on(ev: string, cb: (...a: unknown[]) => void) {
      (handlers[ev] ??= []).push(cb);
    },
    send(data: string) {
      sent.push(data);
    },
    close: vi.fn(),
  };
  const emit = (ev: string, ...args: unknown[]) =>
    (handlers[ev] ?? []).forEach((h) => h(...args));
  const sentJson = () => sent.map((s) => JSON.parse(s));
  return { ws, emit, sentJson };
}

describe("upsample24kMonoTo48kStereo", () => {
  it("quadruples byte length (2x rate × 2 channels) and duplicates the sample", () => {
    // one s16 sample = 0x1234 little-endian
    const input = Buffer.from([0x34, 0x12]);
    const { output, carry } = upsample24kMonoTo48kStereo(input, Buffer.alloc(0));
    expect(output.length).toBe(8); // 1 sample → 2 frames × 2ch × 2 bytes
    // every 16-bit lane is the original sample
    for (let i = 0; i < 8; i += 2) {
      expect(output[i]).toBe(0x34);
      expect(output[i + 1]).toBe(0x12);
    }
    expect(carry.length).toBe(0);
  });

  it("carries an odd trailing byte across chunk boundaries", () => {
    const r1 = upsample24kMonoTo48kStereo(Buffer.from([0x34]), Buffer.alloc(0));
    expect(r1.output.length).toBe(0);
    expect(r1.carry.length).toBe(1);
    const r2 = upsample24kMonoTo48kStereo(Buffer.from([0x12]), r1.carry);
    expect(r2.output.length).toBe(8); // the carried + new byte formed one sample
    expect(r2.carry.length).toBe(0);
  });
});

describe("VoiceTtsSocket", () => {
  function connect() {
    const fake = makeFakeWs();
    const sock = new VoiceTtsSocket({
      apiKey: "k",
      voiceId: "v1",
      log,
      wsFactory: () => fake.ws as unknown as WsLike,
    });
    const opened = sock.ensureOpen();
    fake.emit("open");
    return { fake, sock, opened };
  }

  it("opens and sends context init + sentences + flush with snake_case fields", async () => {
    const { fake, sock, opened } = connect();
    await opened;
    const ctx = sock.beginContext({ stability: 0.5 });
    ctx.pushSentence("Hello there.");
    ctx.pushSentence("Second sentence.");
    ctx.flush();

    const msgs = fake.sentJson();
    // init carries context_id + voice_settings
    expect(msgs[0].context_id).toBe(ctx.contextId);
    expect(msgs[0].voice_settings).toEqual({ stability: 0.5 });
    // text messages carry context_id + a trailing space
    expect(msgs[1]).toMatchObject({ text: "Hello there. ", context_id: ctx.contextId });
    expect(msgs[2]).toMatchObject({ text: "Second sentence. ", context_id: ctx.contextId });
    // flush is snake_case
    expect(msgs[3]).toEqual({ context_id: ctx.contextId, flush: true });
  });

  it("routes inbound camelCase audio to the context stream, decoded + resampled", async () => {
    const { fake, sock, opened } = connect();
    await opened;
    const ctx = sock.beginContext();
    const chunks: Buffer[] = [];
    ctx.audio.on("data", (b: Buffer) => chunks.push(b));

    // one s16 sample 0x1234, base64 of [0x34,0x12]
    const b64 = Buffer.from([0x34, 0x12]).toString("base64");
    fake.emit("message", Buffer.from(JSON.stringify({ audio: b64, contextId: ctx.contextId })));

    const got = Buffer.concat(chunks);
    expect(got.length).toBe(8); // upsampled 24k mono → 48k stereo
    expect(got[0]).toBe(0x34);
    expect(got[1]).toBe(0x12);
  });

  it("ignores audio for an unknown/closed context", async () => {
    const { fake, sock, opened } = connect();
    await opened;
    const ctx = sock.beginContext();
    const spy = vi.fn();
    ctx.audio.on("data", spy);
    fake.emit("message", Buffer.from(JSON.stringify({ audio: "AAAA", contextId: "other" })));
    expect(spy).not.toHaveBeenCalled();
  });

  it("ends the audio stream on isFinal", async () => {
    const { fake, sock, opened } = connect();
    await opened;
    const ctx = sock.beginContext();
    const ended = new Promise<void>((r) => ctx.audio.on("end", () => r()));
    ctx.audio.resume(); // flowing mode so 'end' fires
    fake.emit("message", Buffer.from(JSON.stringify({ isFinal: true, contextId: ctx.contextId })));
    await ended;
    expect(true).toBe(true);
  });

  it("cancel() sends close_context (barge-in) and ends audio", async () => {
    const { fake, sock, opened } = connect();
    await opened;
    const ctx = sock.beginContext();
    ctx.cancel();
    const last = fake.sentJson().at(-1);
    expect(last).toEqual({ context_id: ctx.contextId, close_context: true });
  });

  it("close() sends close_socket", async () => {
    const { fake, sock, opened } = connect();
    await opened;
    sock.close();
    expect(fake.sentJson().some((m) => m.close_socket === true)).toBe(true);
  });

  it("999.116 A3 (G7): onFirstAudio fires exactly once, on the first audio for THIS context", async () => {
    const { fake, sock, opened } = connect();
    await opened;
    const onFirstAudio = vi.fn();
    const ctx = sock.beginContext(undefined, { onFirstAudio });
    ctx.audio.resume();
    const b64 = Buffer.from([0x34, 0x12]).toString("base64");
    // Audio for a different context never fires this context's hook.
    fake.emit("message", Buffer.from(JSON.stringify({ audio: b64, contextId: "other" })));
    expect(onFirstAudio).not.toHaveBeenCalled();
    fake.emit("message", Buffer.from(JSON.stringify({ audio: b64, contextId: ctx.contextId })));
    fake.emit("message", Buffer.from(JSON.stringify({ audio: b64, contextId: ctx.contextId })));
    expect(onFirstAudio).toHaveBeenCalledTimes(1);
  });

  it("999.116 A3 (G7): a throwing onFirstAudio hook never breaks audio delivery", async () => {
    const { fake, sock, opened } = connect();
    await opened;
    const ctx = sock.beginContext(undefined, {
      onFirstAudio: () => {
        throw new Error("observer bug");
      },
    });
    const chunks: Buffer[] = [];
    ctx.audio.on("data", (b: Buffer) => chunks.push(b));
    const b64 = Buffer.from([0x34, 0x12]).toString("base64");
    fake.emit("message", Buffer.from(JSON.stringify({ audio: b64, contextId: ctx.contextId })));
    expect(Buffer.concat(chunks).length).toBe(8);
  });
});
