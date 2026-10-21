/**
 * Upstream turn failures surfaced by the OpenAI-endpoint drivers.
 *
 * When the model call inside a Claude Code turn fails, the CLI still completes
 * the turn: it emits a `result` message with `is_error: true` and — confusingly
 * — `subtype: "success"`, carrying the API error text in `result.result`. The
 * drivers used to throw only the subtype ("initial drain query failed
 * (success)") and discard the text, so every such failure reached callers as
 * an opaque 500 `driver_error`. On 2026-09-23 that text was
 * `API Error: 400 Claude Code 2.1.140 does not support this model; version
 * 2.1.280 or newer is required.` — the whole diagnosis, thrown away.
 *
 * `UpstreamTurnError` keeps that text so the server can answer 502
 * `upstream_error` with it, and the daemon log names the real cause.
 */

/** Cap on the upstream text carried in errors, logs, and HTTP bodies. */
export const UPSTREAM_MESSAGE_MAX_CHARS = 500;

/** Shape of the SDK `result` message fields the drivers read. */
export type SdkResultFields = {
  readonly session_id?: string;
  readonly is_error?: boolean;
  readonly subtype?: string;
  readonly result?: unknown;
  readonly errors?: unknown;
};

export class UpstreamTurnError extends Error {
  /** Which driver step failed, e.g. `openai-driver: initial drain query`. */
  readonly step: string;
  /** The SDK result subtype (`success`, `error_during_execution`, …). */
  readonly subtype: string;
  /** Upstream error text, trimmed and capped; `""` when the SDK gave none. */
  readonly upstreamMessage: string;

  constructor(step: string, subtype: string, upstreamMessage: string) {
    super(
      upstreamMessage.length > 0
        ? `${step} failed (${subtype}): ${upstreamMessage}`
        : `${step} failed (${subtype})`,
    );
    this.name = "UpstreamTurnError";
    this.step = step;
    this.subtype = subtype;
    this.upstreamMessage = upstreamMessage;
  }
}

/**
 * Name-based (not `instanceof`), like server.ts's `isSessionNotRunningError`,
 * so module duplication across build boundaries cannot defeat the check.
 */
export function isUpstreamTurnError(err: unknown): err is UpstreamTurnError {
  return (
    err instanceof Error &&
    err.name === "UpstreamTurnError" &&
    typeof (err as { upstreamMessage?: unknown }).upstreamMessage === "string"
  );
}

/**
 * Build the error for an `is_error` result message. Reads `result` (the text a
 * completed-but-failed turn carries) and falls back to `errors[]` (the
 * `error_during_execution` / `error_max_turns` shapes).
 */
export function upstreamTurnErrorFromResult(
  step: string,
  msg: SdkResultFields,
): UpstreamTurnError {
  return new UpstreamTurnError(
    step,
    msg.subtype ?? "unknown",
    capUpstreamText(extractResultText(msg)),
  );
}

function extractResultText(msg: SdkResultFields): string {
  if (typeof msg.result === "string" && msg.result.trim().length > 0) {
    return msg.result;
  }
  if (Array.isArray(msg.errors)) {
    return msg.errors
      .filter((e): e is string => typeof e === "string" && e.length > 0)
      .join("; ");
  }
  return "";
}

function capUpstreamText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > UPSTREAM_MESSAGE_MAX_CHARS
    ? `${trimmed.slice(0, UPSTREAM_MESSAGE_MAX_CHARS)}…`
    : trimmed;
}
