/**
 * Phase 999.172 — prompt-suggestion rendezvous.
 *
 * The CLI emits `prompt_suggestion` (the model's prediction of the user's next
 * prompt) AFTER a turn's `result`: ~1 s on 2.1.280, ~11 s measured on 2.1.282
 * (2026-09-25 probe). The Discord bridge records the delivered reply only
 * after table planning, the pending-slot await and hold verification. Either
 * side can therefore arrive first, so both land here, keyed by the turn id,
 * and the pair is joined whichever order it arrives in.
 *
 * WHY A MODULE-LEVEL REGISTRY. Same reason as `thinking-sink.ts`: the frame is
 * read by the attributed-stream demux deep below the dispatch path, and
 * threading a callback through the dispatcher, session manager and handle
 * would touch every layer. The handle offers; the bridge registers.
 *
 * WHY KEYED BY TURN ID. Only a Discord-user turn has one that the bridge also
 * knows. A suggestion from any other turn never meets a reply record and
 * expires (`no-reply-record`), so it can never decorate the last Discord reply.
 *
 * Every attach call is isolated: a renderer fault never reaches the stream
 * pump that emits into the sink.
 */

/** Long enough for the measured ~11 s gap plus hold/verification latency. */
export const SUGGESTION_SINK_TTL_MS = 60_000;

/** The bridge's side: where a suggestion for this turn should be attached. */
export type SuggestionReplyRecord = Readonly<{
  agentName: string;
  messageId: string;
  attach: (suggestion: string) => void | Promise<void>;
}>;

export type SuggestionDropReason =
  | "empty"
  | "no-turn"
  | "ambiguous"
  | "orphan"
  | "no-discord-turn"
  | "superseded"
  | "no-reply-record";

export type SuggestionDropEvent = Readonly<{
  turnId: string | null;
  agentName: string | null;
  reason: SuggestionDropReason;
}>;

type Slot = {
  suggestion?: { readonly text: string; readonly agentName: string; readonly at: number };
  record?: { readonly rec: SuggestionReplyRecord; readonly at: number };
};

const slots = new Map<string, Slot>();

function defaultDropLogger(ev: SuggestionDropEvent): void {
  console.info(
    JSON.stringify({
      component: "prompt-suggestion",
      agent: ev.agentName,
      turnId: ev.turnId,
      reason: ev.reason,
      msg: `prompt-suggestion: dropped(${ev.reason})`,
    }),
  );
}

let dropLogger: (ev: SuggestionDropEvent) => void = defaultDropLogger;

/** Override the drop journal (tests); `null` restores the default. */
export function setSuggestionDropLogger(fn: ((ev: SuggestionDropEvent) => void) | null): void {
  dropLogger = fn ?? defaultDropLogger;
}

/** Journal one dropped suggestion. Never throws. */
export function logSuggestionDrop(ev: SuggestionDropEvent): void {
  try {
    dropLogger(ev);
  } catch {
    // journaling is observational
  }
}

function sweep(now: number): void {
  for (const [turnId, slot] of slots) {
    const suggestionStale = slot.suggestion !== undefined && now - slot.suggestion.at > SUGGESTION_SINK_TTL_MS;
    const recordStale = slot.record !== undefined && now - slot.record.at > SUGGESTION_SINK_TTL_MS;
    if (suggestionStale) {
      logSuggestionDrop({ turnId, agentName: slot.suggestion!.agentName, reason: "no-reply-record" });
      slot.suggestion = undefined;
    }
    if (recordStale) slot.record = undefined;
    if (slot.suggestion === undefined && slot.record === undefined) slots.delete(turnId);
  }
}

function fire(rec: SuggestionReplyRecord, text: string): void {
  try {
    const out = rec.attach(text);
    if (out && typeof (out as Promise<void>).catch === "function") {
      (out as Promise<void>).catch(() => undefined);
    }
  } catch {
    // a renderer fault must never reach the stream pump
  }
}

function tryJoin(turnId: string): void {
  const slot = slots.get(turnId);
  if (!slot?.suggestion || !slot.record) return;
  slots.delete(turnId);
  fire(slot.record.rec, slot.suggestion.text);
}

/** The handle's side: a suggestion for a Discord-user turn. */
export function offerPromptSuggestion(
  turnId: string,
  suggestion: string,
  meta: Readonly<{ agentName: string }>,
  now: number = Date.now(),
): void {
  sweep(now);
  const slot = slots.get(turnId) ?? {};
  slot.suggestion = { text: suggestion, agentName: meta.agentName, at: now };
  slots.set(turnId, slot);
  tryJoin(turnId);
}

/** The bridge's side: the delivered reply a suggestion for this turn attaches to. */
export function registerSuggestionReply(
  turnId: string,
  rec: SuggestionReplyRecord,
  now: number = Date.now(),
): void {
  sweep(now);
  const slot = slots.get(turnId) ?? {};
  slot.record = { rec, at: now };
  slots.set(turnId, slot);
  tryJoin(turnId);
}

// ---------------------------------------------------------------------------
// Routing — the safety gate, pure so it is testable without a stream.
// ---------------------------------------------------------------------------

/** What the demux knows when a `prompt_suggestion` frame arrives. */
export type PromptSuggestionEvent = Readonly<{
  suggestion: string;
  /** The turn that closed last: kind and, for a daemon turn, its send token. */
  attribution: Readonly<{ kind: "daemon" | "orphan"; token: number | null }> | null;
  /** A daemon send or a new turn has started since that close. */
  superseded: boolean;
  /**
   * An earlier close in the ambiguity window may own this frame (the frame
   * carries no turn correlation). Optional for callers that predate it.
   */
  ambiguous?: boolean;
}>;

export type PromptSuggestionRoute =
  | Readonly<{ kind: "offer"; turnId: string; suggestion: string }>
  | Readonly<{ kind: "drop"; reason: Exclude<SuggestionDropReason, "no-reply-record"> }>;

/**
 * Offer only a suggestion for a daemon turn that a Discord user started
 * (sendAndStream registered its turn id under the send token). Ambiguous
 * frames (another close in the window may own it), self-fired turns,
 * send()/sendAndCollect() turns (cron, IPC, ask-agent — the Event Dossier's
 * wakes), and suggestions the user has already moved past are dropped with a
 * reason.
 */
export function routePromptSuggestion(
  ev: PromptSuggestionEvent,
  turnIdForToken: (token: number) => string | undefined,
): PromptSuggestionRoute {
  const text = typeof ev.suggestion === "string" ? ev.suggestion.trim() : "";
  if (text.length === 0) return { kind: "drop", reason: "empty" };
  if (ev.attribution === null) return { kind: "drop", reason: "no-turn" };
  if (ev.ambiguous === true) return { kind: "drop", reason: "ambiguous" };
  if (ev.superseded) return { kind: "drop", reason: "superseded" };
  if (ev.attribution.kind !== "daemon" || ev.attribution.token === null) return { kind: "drop", reason: "orphan" };
  const turnId = turnIdForToken(ev.attribution.token);
  if (turnId === undefined) return { kind: "drop", reason: "no-discord-turn" };
  return { kind: "offer", turnId, suggestion: text };
}

/** Test helper — drop every pending slot and restore the default logger. */
export function resetSuggestionSinkForTests(): void {
  slots.clear();
  dropLogger = defaultDropLogger;
}
