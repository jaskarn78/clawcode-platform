/**
 * Phase 135.1 Phase 5 — Deepgram Flux (v2 "listen") streaming STT client.
 *
 * Flux is a turn-native conversational STT model that replaces nova-3's
 * silence-timer endpointing (utterance_end_ms 1500 + endpointing 500 ≈ 1.2-1.7s
 * of dead air) with a learned end-of-turn signal (~260ms p50). It is a DIFFERENT
 * endpoint (/v2/listen), mono-only, and carries per-turn events — so we open ONE
 * connection PER USER (which also fixes nova-3's shared-WS last-speaker
 * attribution hack).
 *
 * Wire protocol (verified against developers.deepgram.com, run wf_4b95c776-8ce):
 *   - connect wss://api.deepgram.com/v2/listen?model=flux-general-en
 *       &encoding=linear16&sample_rate=48000&eot_threshold=…&eot_timeout_ms=…
 *       [&eager_eot_threshold=…]   auth: Authorization: Token <key> header.
 *   - SEND raw binary linear16 MONO frames (~80ms cadence). No KeepAlive JSON
 *     (Flux rejects it) — stream zero-filled silence frames to hold the socket
 *     open during app-side gaps. End with {"type":"CloseStream"}.
 *   - RECEIVE JSON: {type:"Connected"}, {type:"TurnInfo", event:"StartOfTurn"|
 *     "Update"|"EagerEndOfTurn"|"EndOfTurn"|"TurnResumed", transcript, ...}.
 *     transcript is top-level (NOT nested in channel.alternatives like v1).
 *
 * Gated behind `voice.stt.engine: "flux"` (default "nova3"); nova-3 (stt.ts)
 * stays the proven fallback and rollback path.
 */
import { WebSocket, type RawData } from "ws";
import type { Logger } from "pino";

export const FLUX_MODEL = "flux-general-en";
export const DEFAULT_FLUX_EOT_THRESHOLD = 0.7;
export const DEFAULT_FLUX_EOT_TIMEOUT_MS = 5000;
/** Close a per-user Flux connection after this long with no real audio (cost). */
export const DEFAULT_FLUX_IDLE_CLOSE_MS = 60_000;
/** 80ms of 48kHz mono s16le silence, for keepalive during gaps. */
const SILENCE_FRAME = Buffer.alloc(Math.round(48000 * 0.08) * 2);

export type FluxTurnEvent =
  | "StartOfTurn"
  | "Update"
  | "EagerEndOfTurn"
  | "EndOfTurn"
  | "TurnResumed";

export type FluxCallbacks = {
  /** First non-empty transcript of a new turn — the barge-in trigger. */
  readonly onStartOfTurn: (transcript: string) => void;
  /** Interim transcript refresh (~every 0.25s). */
  readonly onUpdate: (transcript: string) => void;
  /** Turn is final — dispatch the agent turn. */
  readonly onEndOfTurn: (transcript: string) => void;
  /** Speculative end-of-turn (only if eager mode enabled). */
  readonly onEagerEndOfTurn?: (transcript: string) => void;
  /** User kept talking after an eager EOT — cancel speculative work. */
  readonly onTurnResumed?: () => void;
  readonly onError: (err: Error) => void;
  readonly onClose?: () => void;
};

export type FluxConfig = {
  readonly eotThreshold?: number;
  readonly eagerEotThreshold?: number;
  readonly eotTimeoutMs?: number;
};

/** Injectable WS factory (test seam). */
export type FluxWsFactory = (url: string, headers: Record<string, string>) => FluxWsLike;

export type FluxWsLike = {
  on(event: "open", cb: () => void): void;
  on(event: "message", cb: (data: RawData) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  send(data: string | Buffer): void;
  close(): void;
  readyState: number;
};

const WS_OPEN = 1;

/** Handle matching the DeepgramLiveConnection surface used by the manager. */
export type FluxLiveConnection = {
  sendMedia: (pcm: Buffer) => void;
  close: () => void;
};

/**
 * Open one Flux connection (one per user). Resolves once the WS is open.
 */
export async function openFluxConnection(
  apiKey: string,
  callbacks: FluxCallbacks,
  cfg: FluxConfig,
  log: Logger,
  wsFactory?: FluxWsFactory,
): Promise<FluxLiveConnection> {
  const params = new URLSearchParams({
    model: FLUX_MODEL,
    encoding: "linear16",
    sample_rate: "48000",
    eot_threshold: String(cfg.eotThreshold ?? DEFAULT_FLUX_EOT_THRESHOLD),
    eot_timeout_ms: String(cfg.eotTimeoutMs ?? DEFAULT_FLUX_EOT_TIMEOUT_MS),
  });
  if (typeof cfg.eagerEotThreshold === "number") {
    params.set("eager_eot_threshold", String(cfg.eagerEotThreshold));
  }
  const url = `wss://api.deepgram.com/v2/listen?${params.toString()}`;
  const factory: FluxWsFactory =
    wsFactory ??
    ((u, h) => new WebSocket(u, { headers: h }) as unknown as FluxWsLike);

  return new Promise<FluxLiveConnection>((resolve, reject) => {
    let settled = false;
    let ws: FluxWsLike;
    try {
      ws = factory(url, { Authorization: `Token ${apiKey}` });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    // Silence keepalive: Flux has no KeepAlive message; stream zero frames so
    // the socket survives app-side silence (Discord only emits audio while a
    // user speaks). CRITICAL: only inject silence during genuine GAPS (>250ms
    // since real audio) — never mid-utterance, or we chop live speech and skew
    // Flux's learned end-of-turn timing. After a longer idle we close the
    // socket (manager reopens on the next utterance) to stop billing silence.
    let lastMediaAt = Date.now();
    const teardown = () => {
      clearInterval(keepAlive);
      try {
        if (ws.readyState === WS_OPEN) ws.send(JSON.stringify({ type: "CloseStream" }));
      } catch {
        /* non-fatal */
      }
      try {
        ws.close();
      } catch {
        /* non-fatal */
      }
    };
    const keepAlive = setInterval(() => {
      if (ws.readyState !== WS_OPEN) return;
      const idleMs = Date.now() - lastMediaAt;
      if (idleMs >= DEFAULT_FLUX_IDLE_CLOSE_MS) {
        // Idle too long — close (onClose lets the manager reopen on next speech).
        teardown();
        return;
      }
      if (idleMs > 250) {
        try {
          ws.send(SILENCE_FRAME);
        } catch {
          /* non-fatal */
        }
      }
    }, 80);
    if (typeof keepAlive.unref === "function") keepAlive.unref();

    ws.on("open", () => {
      settled = true;
      log.debug({}, "flux ws open");
      resolve({
        sendMedia: (pcm: Buffer) => {
          try {
            if (ws.readyState === WS_OPEN) {
              lastMediaAt = Date.now();
              ws.send(pcm);
            }
          } catch {
            /* non-fatal */
          }
        },
        close: teardown,
      });
    });

    ws.on("message", (data) => handleFluxMessage(data, callbacks));

    ws.on("error", (err) => {
      clearInterval(keepAlive);
      if (!settled) reject(err);
      else callbacks.onError(err);
    });

    ws.on("close", () => {
      clearInterval(keepAlive);
      callbacks.onClose?.();
    });
  });
}

/** Parse one inbound Flux message and route it to the right callback. */
export function handleFluxMessage(data: RawData, callbacks: FluxCallbacks): void {
  let msg: { type?: string; event?: string; transcript?: string };
  try {
    msg = JSON.parse(data.toString());
  } catch {
    return;
  }
  if (msg.type !== "TurnInfo") return; // ignore Connected/ConfigureSuccess/etc.
  const transcript = typeof msg.transcript === "string" ? msg.transcript : "";
  switch (msg.event as FluxTurnEvent | undefined) {
    case "StartOfTurn":
      if (transcript.length > 0) callbacks.onStartOfTurn(transcript);
      break;
    case "Update":
      if (transcript.length > 0) callbacks.onUpdate(transcript);
      break;
    case "EagerEndOfTurn":
      callbacks.onEagerEndOfTurn?.(transcript);
      break;
    case "EndOfTurn":
      callbacks.onEndOfTurn(transcript);
      break;
    case "TurnResumed":
      callbacks.onTurnResumed?.();
      break;
    default:
      break;
  }
}

/** Downmix interleaved 48kHz stereo s16le → mono (average L+R) for Flux. */
export function downmixStereoToMono(stereo: Buffer): Buffer {
  const frames = stereo.length >> 2; // 4 bytes per stereo frame (L16 + R16)
  const out = Buffer.allocUnsafe(frames * 2);
  for (let i = 0; i < frames; i++) {
    const l = stereo.readInt16LE(i * 4);
    const r = stereo.readInt16LE(i * 4 + 2);
    out.writeInt16LE((l + r) >> 1, i * 2);
  }
  return out;
}
