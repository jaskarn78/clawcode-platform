/**
 * Phase 135.1 Phase 4 — ElevenLabs multi-context streaming TTS over WebSocket.
 *
 * One persistent socket per voice session carries up to 5 independent synthesis
 * "contexts", each keyed by a client-chosen context_id. We open ONE context per
 * assistant turn, stream the agent's sentences into it as the LLM produces them
 * (via SentenceAggregator), and `flush` at turn end — so the bot starts speaking
 * after the FIRST sentence instead of waiting for the whole response. Barge-in
 * sends `close_context` to stop server-side synthesis (and billing) mid-turn
 * without tearing down the socket.
 *
 * Wire protocol (verified against elevenlabs.io/docs, run wf_4b95c776-8ce):
 *   - connect wss://api.elevenlabs.io/v1/text-to-speech/{voice}/multi-stream-input
 *       ?model_id=…&output_format=…&auto_mode=true&inactivity_timeout=180
 *     auth via `xi-api-key` header (the `ws` lib supports headers; native
 *     WebSocket cannot — this is why we use `ws`).
 *   - SEND snake_case: {text, context_id, flush?}, {context_id, flush:true},
 *     {context_id, close_context:true}, {text:"", context_id} (keepalive),
 *     {close_socket:true}.
 *   - RECEIVE camelCase: {audio:<base64>, contextId}, {isFinal:true, contextId}.
 *
 * Output format: default pcm_24000 (mono s16le, no tier gate) which we upsample
 * to 48 kHz stereo for StreamType.Raw — deterministic, ffmpeg-free framing. The
 * format is a config knob; opus/mp3 would need a different StreamType and are
 * left as future options.
 *
 * The whole path is gated behind `voice.streamingTts.enabled` (default false)
 * with the HTTP `speakResponse` as the proven fallback, and is operator-verified
 * live before rollout.
 */
import { WebSocket, type RawData } from "ws";
import { PassThrough, type Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

export const ELEVENLABS_WS_MODEL = "eleven_flash_v2_5";
export const ELEVENLABS_WS_OUTPUT_FORMAT = "pcm_24000" as const;

/**
 * Zero-order-hold upsample of s16le mono @24 kHz → s16le stereo @48 kHz: each
 * input sample becomes two frames (2× rate) of L=R (mono→stereo). Adequate for
 * speech; avoids a resampler dependency. `carry` holds a byte split across
 * chunk boundaries so 16-bit samples never tear.
 */
export function upsample24kMonoTo48kStereo(
  input: Buffer,
  carry: Buffer,
): { output: Buffer; carry: Buffer } {
  const buf = carry.length > 0 ? Buffer.concat([carry, input]) : input;
  const wholeSamples = buf.length >> 1; // 2 bytes per s16 sample
  const usedBytes = wholeSamples * 2;
  const out = Buffer.allocUnsafe(wholeSamples * 8); // 2× rate × 2 ch × 2 bytes
  let o = 0;
  for (let i = 0; i < wholeSamples; i++) {
    const lo = buf[i * 2] as number;
    const hi = buf[i * 2 + 1] as number;
    // two 48 kHz frames, each L + R = the same 16-bit sample four times.
    out[o++] = lo; out[o++] = hi; out[o++] = lo; out[o++] = hi;
    out[o++] = lo; out[o++] = hi; out[o++] = lo; out[o++] = hi;
  }
  const nextCarry = usedBytes < buf.length ? buf.subarray(usedBytes) : Buffer.alloc(0);
  return { output: out, carry: nextCarry };
}

/** Injectable WS factory so tests can substitute a fake socket. */
export type WsFactory = (url: string, headers: Record<string, string>) => WsLike;

/** Minimal shape of the `ws` socket the client uses (eases mocking). */
export type WsLike = {
  on(event: "open", cb: () => void): void;
  on(event: "message", cb: (data: RawData) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  send(data: string): void;
  close(): void;
  readyState: number;
};

const WS_OPEN = 1;

export type TtsSocketOptions = {
  readonly apiKey: string;
  readonly voiceId: string;
  readonly model?: string;
  readonly outputFormat?: string;
  readonly log: Logger;
  /** Test seam — defaults to the real `ws` WebSocket. */
  readonly wsFactory?: WsFactory;
};

/**
 * 999.116 A3 (G7) — observation hooks on a context. `onFirstAudio` fires once,
 * on the first audio message routed to the context (TTS first byte).
 */
export type TtsContextHooks = {
  readonly onFirstAudio?: () => void;
};

/** One in-flight synthesis context (one per assistant turn). */
export type TtsSpeechContext = {
  readonly contextId: string;
  /** 48 kHz stereo s16le PCM for createAudioResource(StreamType.Raw). */
  readonly audio: Readable;
  /** Queue a complete sentence for synthesis. */
  pushSentence(text: string): void;
  /** Force out buffered text at turn end. */
  flush(): void;
  /** Barge-in: stop server-side synthesis + billing and end the audio stream. */
  cancel(): void;
};

export class VoiceTtsSocket {
  private readonly opts: TtsSocketOptions;
  private readonly log: Logger;
  private ws: WsLike | null = null;
  private openPromise: Promise<void> | null = null;
  private keepAlive: NodeJS.Timeout | null = null;
  private closed = false;
  /** contextId → live context (route inbound audio by contextId). */
  private readonly contexts = new Map<string, InternalContext>();

  constructor(opts: TtsSocketOptions) {
    this.opts = opts;
    this.log = opts.log.child({ component: "voice-tts-ws" });
  }

  get isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WS_OPEN;
  }

  /** Lazily open the socket and resolve once the WS handshake completes. */
  async ensureOpen(): Promise<void> {
    if (this.isOpen) return;
    // Only reuse the cached promise while the socket is still viable
    // (CONNECTING or OPEN). A resolved promise on a CLOSING/CLOSED socket — e.g.
    // the server hit its 180s inactivity timeout between turns — must NOT be
    // reused, or the next turn's TTS would silently no-op on a dead socket.
    if (this.openPromise && this.ws && this.ws.readyState <= WS_OPEN) {
      return this.openPromise;
    }
    this.openPromise = null;
    this.ws = null;
    this.closed = false;
    this.openPromise = new Promise<void>((resolve, reject) => {
      const model = this.opts.model ?? ELEVENLABS_WS_MODEL;
      const format = this.opts.outputFormat ?? ELEVENLABS_WS_OUTPUT_FORMAT;
      const url =
        `wss://api.elevenlabs.io/v1/text-to-speech/${this.opts.voiceId}/multi-stream-input` +
        `?model_id=${encodeURIComponent(model)}` +
        `&output_format=${encodeURIComponent(format)}` +
        `&auto_mode=true&inactivity_timeout=180`;
      const factory: WsFactory =
        this.opts.wsFactory ??
        ((u, h) => new WebSocket(u, { headers: h }) as unknown as WsLike);
      let settled = false;
      let ws: WsLike;
      try {
        ws = factory(url, { "xi-api-key": this.opts.apiKey });
      } catch (err) {
        this.openPromise = null;
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.ws = ws;
      ws.on("open", () => {
        // Ignore a stale socket's open if it was already superseded.
        if (this.ws !== ws) return;
        settled = true;
        this.startKeepAlive();
        this.log.info({ voiceId: this.opts.voiceId, model, format }, "tts ws open");
        resolve();
      });
      ws.on("message", (data) => {
        if (this.ws !== ws) return; // drop messages from a superseded socket
        this.onMessage(data);
      });
      ws.on("error", (err) => {
        this.log.warn({ error: err.message }, "tts ws error");
        if (!settled) {
          this.openPromise = null;
          reject(err);
        }
        // Only tear down shared state if this is still the current socket — the
        // `ws` lib emits 'close' after 'error', and a superseded socket's
        // trailing events must not clobber a replacement.
        if (this.ws === ws) this.teardown();
      });
      ws.on("close", () => {
        this.log.info({}, "tts ws closed");
        if (this.ws === ws) this.teardown();
      });
    });
    return this.openPromise;
  }

  /** Open a fresh synthesis context for one turn. */
  beginContext(
    voiceSettings?: Record<string, unknown>,
    hooks?: TtsContextHooks,
  ): TtsSpeechContext {
    const contextId = `ctx-${randomUUID()}`;
    const ctx = new InternalContext(
      contextId,
      (obj) => this.send(obj),
      () => this.contexts.delete(contextId),
      hooks,
    );
    this.contexts.set(contextId, ctx);
    // First message with a new context_id CREATES it (settings honored only here).
    ctx.init(voiceSettings);
    return ctx;
  }

  /** Graceful socket close (pending flushes complete first). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Capture the socket BEFORE teardown() nulls this.ws, or the ws.close()
    // below would be dead code and rely entirely on the server honoring
    // close_socket.
    const ws = this.ws;
    try {
      this.send({ close_socket: true });
    } catch {
      /* non-fatal */
    }
    this.teardown();
    try {
      ws?.close();
    } catch {
      /* non-fatal */
    }
  }

  private onMessage(data: RawData): void {
    let msg: { audio?: string; contextId?: string; isFinal?: boolean; is_final?: boolean };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return; // ignore non-JSON
    }
    const ctxId = msg.contextId; // camelCase inbound
    if (!ctxId) return;
    const ctx = this.contexts.get(ctxId);
    if (!ctx) return; // audio for a closed/superseded context — drop
    if (msg.audio) ctx.onAudio(msg.audio);
    if (msg.isFinal === true || msg.is_final === true) ctx.onFinal();
  }

  private send(obj: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return;
    this.ws.send(JSON.stringify(obj));
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    // Reset every context's inactivity timer well under the 180s cap.
    this.keepAlive = setInterval(() => {
      for (const id of this.contexts.keys()) {
        this.send({ text: "", context_id: id });
      }
    }, 120_000);
    if (typeof this.keepAlive.unref === "function") this.keepAlive.unref();
  }

  private stopKeepAlive(): void {
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
  }

  private teardown(): void {
    this.stopKeepAlive();
    for (const ctx of this.contexts.values()) ctx.endAudio();
    this.contexts.clear();
    this.openPromise = null;
    this.ws = null;
  }
}

/** Internal per-context state: framing, base64 decode, resample, PassThrough. */
class InternalContext implements TtsSpeechContext {
  readonly contextId: string;
  readonly audio: PassThrough;
  private readonly sendFn: (obj: Record<string, unknown>) => void;
  private readonly onDone: () => void;
  private readonly hooks: TtsContextHooks;
  private carry: Buffer = Buffer.alloc(0);
  private ended = false;
  private sawAudio = false;

  constructor(
    contextId: string,
    sendFn: (obj: Record<string, unknown>) => void,
    onDone: () => void,
    hooks: TtsContextHooks = {},
  ) {
    this.contextId = contextId;
    this.sendFn = sendFn;
    this.onDone = onDone;
    this.hooks = hooks;
    this.audio = new PassThrough();
    // If the consumer (player) destroys the stream (e.g. abortVoiceTurn), stop
    // synthesis too.
    this.audio.on("close", () => this.cancel());
  }

  init(voiceSettings?: Record<string, unknown>): void {
    this.sendFn({
      text: " ",
      context_id: this.contextId,
      ...(voiceSettings ? { voice_settings: voiceSettings } : {}),
    });
  }

  pushSentence(text: string): void {
    if (this.ended || text.trim().length === 0) return;
    // auto_mode=true → each message synthesises immediately; a trailing space
    // is the documented safe continuation convention.
    this.sendFn({ text: text.endsWith(" ") ? text : `${text} `, context_id: this.contextId });
  }

  flush(): void {
    if (this.ended) return;
    this.sendFn({ context_id: this.contextId, flush: true });
  }

  cancel(): void {
    if (this.ended) {
      this.endAudio();
      return;
    }
    this.sendFn({ context_id: this.contextId, close_context: true });
    this.endAudio();
  }

  onAudio(base64: string): void {
    if (this.ended) return;
    if (!this.sawAudio) {
      this.sawAudio = true;
      try {
        this.hooks.onFirstAudio?.();
      } catch {
        /* observation only — never break audio */
      }
    }
    let raw: Buffer;
    try {
      raw = Buffer.from(base64, "base64");
    } catch {
      return;
    }
    const { output, carry } = upsample24kMonoTo48kStereo(raw, this.carry);
    this.carry = carry;
    if (output.length > 0 && !this.audio.destroyed) this.audio.write(output);
  }

  onFinal(): void {
    this.endAudio();
  }

  /** End the audio stream + retire the context exactly once. */
  endAudio(): void {
    if (this.ended) return;
    this.ended = true;
    try {
      if (!this.audio.destroyed) this.audio.end();
    } catch {
      /* non-fatal */
    }
    this.onDone();
  }
}
