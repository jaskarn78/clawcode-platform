/**
 * WS-1 (999.99 structural delivery plan) — AttributedStreamDemux.
 *
 * THE off-by-N fix. The daemon's legacy consumption model reads the shared
 * SDK stream only while a daemon-initiated turn is in flight
 * (`iterateUntilResult` returns on the FIRST `result` frame it sees, with
 * zero correlation to the input it pushed). Any turn the claude process runs
 * on its own — `Monitor` events, background Bash exits, background `Agent`
 * completions, all surfaced as task-notification wakeups — therefore
 * accumulates unread in the iterator, and the next inbound message pops the
 * OLDEST buffered result as its "reply" (2026-07-15/16 Admin Clawdy
 * incident; Phase 100 comment at daemon.ts `triggerDeliveryFn` describes the
 * same class).
 *
 * This module is the SOLE reader of the raw per-epoch driver iterator. It
 * runs an always-on pump (starts at construction, ends with the epoch),
 * classifies every turn at its opening frame, and routes:
 *
 *   - DAEMON-classified turn frames → an internal frame queue whose
 *     `turnIterator()` is what `iterateUntilResult` consumes — the legacy
 *     loop body runs UNCHANGED, it simply never sees frames that belong to
 *     someone else's turn.
 *   - ORPHAN-classified turn frames → buffered per turn; on the turn's
 *     `result`, the final text is handed to `onOrphanOutput` for immediate
 *     standalone channel delivery (no more waiting for the next inbound
 *     message to flush).
 *   - Ambient frames (rate-limit events, background-task chatter, …) →
 *     the daemon queue, exactly where the legacy loop would have seen them.
 *
 * Classification protocol (probe-verified on claude 2.1.210/2.1.211 — the
 * prod pin — probe script: scratchpad/probe-stream.mjs, 2026-07-16):
 *
 *   1. The CLI serializes turns: frames of one turn complete before the
 *      next turn's frames begin. Turn-content frames are assistant / user
 *      (tool_results) / stream_event / system:init; `result` closes a turn.
 *   2. Pushed inputs are NOT echoed as user frames — so daemon turns are
 *      recognized by an expectation registered via `registerDaemonSend()`
 *      immediately before the input push (the handle's SerialTurnQueue
 *      guarantees at most one in-flight daemon send).
 *   3. Self-fired turns are PRECEDED by a `system:task_notification` frame
 *      — that signal enqueues an "orphan" expectation.
 *   4. Expectations are consumed FIFO at turn-open (mirrors the CLI's own
 *      input queue ordering).
 *   5. The `result` frame carries `origin: {kind: "task-notification"}` for
 *      self-fired turns and NO origin for daemon-sent ones (verified on the
 *      prod pin) — used as an authoritative cross-check that HEALS a wrong
 *      tentative classification:
 *        - daemon-tentative turn whose result says task-notification →
 *          rerouted to the orphan sink; the daemon waiter keeps waiting for
 *          its real turn (streamed chunks self-heal via edit-overwrite).
 *        - orphan-tentative turn whose result has NO origin while a daemon
 *          send is pending → its buffered frames + result are FLUSHED into
 *          the daemon queue (late-burst streaming, correct pairing).
 *
 * 999.155 — the CLI FOLDS input that arrives while a turn is running into
 * that turn (transcript queue-operation `enqueue`→`remove`) instead of giving
 * it a turn of its own. Measured 2026-09-22: 329 daemon turns in 7 days were
 * opened orphan-tentative because a task_notification folded into the
 * PREVIOUS turn left a surplus orphan expectation (silent channel, stall
 * tracker paused, false 15-min max-pause kills), and a daemon send folded
 * into a running self-fired turn left its waiter hanging until timeout
 * (state-contract queue jam). Two rules close both:
 *   - a task_notification seen MID-TURN is marked `midTurn`; at the next turn
 *     open, leading midTurn orphan entries yield to a pending daemon send;
 *   - an orphan turn that closes while a daemon send is pending is HELD for
 *     `mergeGraceMs`: if no new turn opens (the CLI starts a queued input
 *     within ~100 ms), the daemon input was folded into it and its result is
 *     handed to the daemon consumer; otherwise it is delivered as orphan.
 *
 * The demux never throws into the pump; a raw-iterator error is forwarded to
 * the daemon queue (so the legacy loop's catch/recovery paths fire exactly as
 * they would reading the raw iterator) and the demux goes dead for the epoch.
 *
 * 999.171 — live thinking. `system/thinking_tokens` frames (running token
 * total of the current thinking block) are OBSERVED here, the only place that
 * reads the stream, and reported to `onThinkingTokens` with the kind of the
 * turn open at that moment. The tap is observational: the frame keeps its
 * ambient routing, so the daemon queue sees exactly what it saw before. The
 * consumer acts only on openKind "daemon" (self-fired turns must never paint
 * an operator turn). Accepted residual: a daemon-TENTATIVE turn that its
 * result later heals to orphan has already reported its frames as daemon —
 * its draft chunks streamed to the same consumer in that window, so this is
 * the text stream's attribution, not a new leak.
 *
 * 999.172 — prompt suggestions. `{type:"prompt_suggestion", suggestion}`
 * arrives AFTER a turn's result (probe: ~1 s on 2.1.280, ~11 s on 2.1.282),
 * when that turn is already closed. The demux reports it to
 * `onPromptSuggestion` with the attribution of the LAST CLOSED turn (daemon +
 * its send token, or orphan) and whether a daemon send or a new turn has
 * superseded it since. A suggestion that arrives during a 999.155 merge hold
 * is decided by the hold (merged → the folded send's token; separate →
 * orphan). Observational like the thinking tap: the frame keeps its ambient
 * routing, so the daemon queue sees exactly what it saw before.
 *
 * AMBIGUITY RULE (PR #190 review). The frame carries NO turn correlation
 * (type / suggestion / uuid / session_id only), and it lands 1–11 s after its
 * result — long enough for another turn to open AND close in between. So the
 * demux keeps a short history of closes, each marked "resolved" once a
 * suggestion has been reported for it. A suggestion is attributed to the
 * last close ONLY when no EARLIER close within SUGGESTION_AMBIGUITY_WINDOW_MS
 * of it is still unresolved, and the last close itself is unresolved;
 * otherwise it is reported `ambiguous` and every close in the window is
 * marked resolved (poisoned), so a later straggler cannot land either. The
 * cost is conservative: a quick follow-up after a turn that produced no
 * suggestion (turn 1, cold cache, a cron wake) gets none.
 * 999.173 — child lane. Subagent frames carry a non-null
 * `parent_tool_use_id`. A BACKGROUND subagent streams while the parent is
 * idle; treated as turn content, its frames opened a phantom orphan turn that
 * swallowed the user's next reply. They now never open, feed or close a
 * parent turn: `onChildFrame` observes them, and they reach the daemon queue
 * only while a DAEMON turn is open (legacy parity for a foreground subagent)
 * and never for a detached background task (`isDetachedChild`). Task frames
 * (`system/task_*`, `background_tasks_changed`) are observed via `onTaskFrame`
 * and keep their routing.
 */

import type { SdkStreamMessage } from "./sdk-types.js";

/** Minimal pino-like logger surface (matches PostToAgentLogger). */
export type DemuxLogger = Readonly<{
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}>;

/** Structural view of a stream frame — the SDK union is wider than our local projection. */
type Frame = {
  readonly type?: string;
  readonly subtype?: string;
  readonly result?: unknown;
  readonly is_error?: boolean;
  readonly num_turns?: number;
  readonly origin?: { readonly kind?: string };
  readonly message?: { readonly content?: unknown };
  readonly suggestion?: unknown;
  /** 999.173 — set on subagent (child-lane) frames; null/absent on the parent's own. */
  readonly parent_tool_use_id?: string | null;
};

/** 999.172 — which closed turn a prompt suggestion belongs to. */
export type SuggestionAttribution = Readonly<{ kind: "daemon" | "orphan"; token: number | null }>;

/**
 * 999.172 (review) — an earlier close still waiting for its suggestion within
 * this many ms of the last close makes a new suggestion ambiguous. The CLI's
 * measured post-result delay is 1–11 s; 30 s leaves margin.
 */
export const SUGGESTION_AMBIGUITY_WINDOW_MS = 30_000;

/** One turn close, for suggestion attribution. */
type CloseRecord = {
  readonly attribution: SuggestionAttribution;
  readonly at: number;
  /** A suggestion has been reported for this close (attributed or dropped). */
  resolved: boolean;
  /** A daemon send, a new turn, or an abandon happened after this close. */
  superseded: boolean;
};

export type OrphanTurnOutput = Readonly<{
  /** Final user-visible text of the orphan turn (result.result, falling back to accumulated assistant text). */
  text: string;
  /** origin.kind from the result frame; null when the CLI omitted it. */
  originKind: string | null;
  isError: boolean;
  /**
   * How the turn was attributed:
   *  - "orphan-signaled": a task_notification preceded it (the normal case)
   *  - "orphan-unsignaled": no signal and no daemon send pending (unknown self-fire source)
   *  - "reclassified-from-daemon": tentatively daemon, healed at result via origin
   *  - "abandoned-daemon": a daemon turn whose consumer exited without the
   *    result (abort-deadline / AbortSignal / force-release — the 999.99-F2
   *    family, seed of the 2026-07-23 fin-client incident). Its late output
   *    delivers here instead of poisoning the next dispatch's reply.
   */
  classification:
    | "orphan-signaled"
    | "orphan-unsignaled"
    | "reclassified-from-daemon"
    | "abandoned-daemon";
}>;

export type AttributedStreamDemuxOptions = Readonly<{
  raw: AsyncIterator<SdkStreamMessage>;
  /**
   * Delivery sink for orphan-turn output. Fire-and-forget from the demux's
   * perspective; a throw is caught and warn-logged (delivery failures must
   * never wedge the pump).
   */
  onOrphanOutput: (out: OrphanTurnOutput) => void;
  /** Orphan turn opened — pause the in-flight daemon turn's stall tracker. */
  onOrphanTurnStart?: () => void;
  /** Orphan turn closed — resume the stall tracker. */
  onOrphanTurnEnd?: () => void;
  /**
   * A pending daemon send was folded into the orphan turn, so the orphan's
   * output went to the daemon consumer (the user's reply) instead of
   * onOrphanOutput. Lets the research tracker settle a synthesis that was
   * delivered that way.
   */
  onOrphanMergedIntoDaemon?: () => void;
  /** Every raw frame — keeps the 999.64 activity watchdog fed while foreign turns run. */
  onActivity?: () => void;
  /**
   * 999.155 — every frame of an OPEN orphan turn. Proof the CLI generator is
   * alive while the daemon turn sits paused behind it: the handle re-arms the
   * stall tracker's max-pause window so a long foreign (or misclassified)
   * turn is never killed as an "in-tool wedge".
   */
  onOrphanActivity?: () => void;
  /**
   * 999.155 — how long a closed orphan turn is held when a daemon send is
   * pending, waiting to see whether the CLI opens a separate turn for it.
   * Default MERGE_GRACE_MS.
   */
  mergeGraceMs?: number;
  /**
   * 999.99 review follow-up (telemetry blackout) — usage sink for result
   * frames that NEVER reach the daemon consumer (orphan + abandoned-daemon
   * turns). Production wires the handle's extractUsage so self-fired turns
   * keep charging usage.db / advisor budget. Best-effort: throws are
   * swallowed.
   */
  onTurnUsage?: (resultFrame: SdkStreamMessage) => void;
  /**
   * 999.171 — every `system/thinking_tokens` frame with a valid count
   * (finite, >= 0), plus the kind of the turn open when it arrived (null when
   * idle). Observational only: the frame itself is still forwarded exactly as
   * before. The consumer must act only on openKind "daemon" — orphan and idle
   * frames belong to no operator turn. A throw is swallowed (a renderer
   * fault never reaches the pump).
   */
  onThinkingTokens?: (
    ev: Readonly<{ estimatedTokens: number; openKind: "daemon" | "orphan" | null }>,
  ) => void;
  /**
   * 999.172 — every `prompt_suggestion` frame, with the attribution of the
   * turn that closed last (null when none has) and whether a daemon send or a
   * new turn has started since that close. Observational: the frame itself is
   * still forwarded. A non-string suggestion is reported as "" (the consumer's
   * gate drops it). A throw is swallowed.
   */
  onPromptSuggestion?: (
    ev: Readonly<{
      suggestion: string;
      attribution: SuggestionAttribution | null;
      superseded: boolean;
      /** 999.172 review — an earlier close in the window may own this frame. */
      ambiguous: boolean;
    }>,
  ) => void;
  /** Clock seam for the suggestion ambiguity window (tests). Default Date.now. */
  now?: () => number;
  /**
   * 999.173 — every subagent (child-lane) frame, with the kind of the parent
   * turn open when it arrived. Observational; a throw is swallowed.
   */
  onChildFrame?: (
    ev: Readonly<{
      parentToolUseId: string;
      openKind: "daemon" | "orphan" | null;
      frame: SdkStreamMessage;
    }>,
  ) => void;
  /**
   * 999.173 — whether a child lane belongs to a DETACHED background task
   * (a background researcher). Such frames never reach a daemon turn that
   * happens to be open when they arrive. Absent → nothing is detached.
   */
  isDetachedChild?: (parentToolUseId: string) => boolean;
  /**
   * 999.173 — every `system/task_started|task_progress|task_updated|
   * task_notification` and `system/background_tasks_changed` frame.
   * Observational only: routing is unchanged. A throw is swallowed.
   */
  onTaskFrame?: (frame: SdkStreamMessage) => void;
  /**
   * 999.173 — every `result` frame, observed BEFORE the turn closes (so a
   * consumer can count self-fired wake turns — including ones whose output is
   * empty and therefore never reaches onOrphanOutput). Routing unchanged; a
   * throw is swallowed.
   */
  onResultFrame?: (frame: SdkStreamMessage) => void;
  log?: DemuxLogger;
}>;

/** Expectation FIFO entry — daemon entries carry the send token so
 * retraction/abandonment can target EXACTLY the registering send
 * (999.99 review: identity-less entries let a stale retraction eat a
 * fresh dispatch's expectation). */
type Expectation =
  | { kind: "orphan"; midTurn?: boolean }
  | { kind: "daemon"; token: number };

/**
 * 999.155 — hold window for "was the pending daemon input folded into the
 * orphan turn that just closed?".
 *
 * Sized against the gap between a turn ending and the CLI starting the input
 * queued behind it, measured over 9,930 prod transcripts / 14 days
 * (2026-09-22): p50 70 ms, p90 119 ms, p99 = max 399 ms, nothing above 1 s.
 * 3 s is ~7.5× the observed worst case.
 *
 * The two failure directions are NOT symmetric, which is why the window errs
 * long: too short re-creates the state-contract jam (a folded send's result
 * delivered as orphan text while its waiter hangs to its deadline); too long
 * only delays a genuine orphan's delivery by the window.
 */
export const MERGE_GRACE_MS = 3_000;

/** 999.155 — an orphan turn's close, held until the merge decision. */
type PendingMerge = {
  readonly resultMsg: SdkStreamMessage;
  readonly resultFrame: Frame;
  readonly classification: OrphanTurnOutput["classification"];
  readonly originKind: string | null;
  /** Frames not yet seen by the daemon consumer (empty when already forwarded). */
  readonly frames: readonly SdkStreamMessage[];
  readonly text: readonly string[];
  readonly timer: ReturnType<typeof setTimeout>;
};

/** Module-global daemon-send token counter (unique across demux instances /
 * epoch swaps — a ghost's stale token can never match a fresh send). */
let globalDaemonTokenCounter = 1;

/**
 * Internal single-consumer frame queue with error propagation. Deliberately
 * NOT AsyncPushQueue: the legacy loop must observe a raw-iterator rejection
 * as a rejected next() (its catch paths key on that), and `undefined` frame
 * values must not be conflated with end-of-stream.
 */
class FrameQueue {
  private readonly items: SdkStreamMessage[] = [];
  private failure: unknown = null;
  private ended = false;
  /**
   * FIFO of pending consumers. A QUEUE (not a single slot) deliberately: an
   * interrupted turn exits `iterateUntilResult` while its raced `next()` is
   * still pending; the NEXT turn then issues another `next()`. Native async
   * generators serialize exactly this way (the abandoned call silently
   * consumes one value) — mirroring that keeps the legacy loop's post-abort
   * semantics byte-compatible.
   */
  private readonly waiters: {
    resolve: (r: IteratorResult<SdkStreamMessage>) => void;
    reject: (err: unknown) => void;
  }[] = [];

  push(frame: SdkStreamMessage): void {
    if (this.ended || this.failure !== null) return;
    const w = this.waiters.shift();
    if (w) {
      w.resolve({ value: frame, done: false });
      return;
    }
    this.items.push(frame);
  }

  fail(err: unknown): void {
    if (this.ended || this.failure !== null) return;
    this.failure = err;
    for (const w of this.waiters.splice(0)) {
      w.reject(err);
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const w of this.waiters.splice(0)) {
      w.resolve({ value: undefined as unknown as SdkStreamMessage, done: true });
    }
  }

  next(): Promise<IteratorResult<SdkStreamMessage>> {
    return new Promise((resolve, reject) => {
      if (this.items.length > 0) {
        resolve({ value: this.items.shift() as SdkStreamMessage, done: false });
        return;
      }
      if (this.failure !== null) {
        reject(this.failure);
        return;
      }
      if (this.ended) {
        resolve({ value: undefined as unknown as SdkStreamMessage, done: true });
        return;
      }
      this.waiters.push({ resolve, reject });
    });
  }

  /**
   * 999.99-F2 — abandon support. Called when the daemon consumer exits
   * WITHOUT having consumed its turn's result (abort-deadline, AbortSignal,
   * force-release). Two jobs:
   *
   *  1. RESOLVE (never reject) every pending waiter into the void with
   *     done:true. The abandoned turn's raced `next()` has no continuation
   *     (its Promise.race already settled on the abort side), so a
   *     resolution is silently absorbed — a rejection there would surface
   *     as an unhandledRejection. Clearing the waiters also stops the
   *     native "dangling waiter eats the next turn's first frame"
   *     semantics from consuming a frame that now belongs to a live turn.
   *
   *  2. Drain and return the unconsumed items. At abandon time no new
   *     daemon turn has started (the SerialTurnQueue slot is still held by
   *     the aborting send), so every queued item belongs to the abandoned
   *     turn or is ambient — the demux re-routes their content to the
   *     orphan sink instead of letting the NEXT dispatch pop them.
   */
  drainForAbandon(): SdkStreamMessage[] {
    for (const w of this.waiters.splice(0)) {
      w.resolve({ value: undefined as unknown as SdkStreamMessage, done: true });
    }
    return this.items.splice(0);
  }
}

const isResultFrame = (f: Frame): boolean => f.type === "result";
const isOrphanSignal = (f: Frame): boolean =>
  f.type === "system" && f.subtype === "task_notification";
/** 999.171 — live thinking progress (ambient: never opens or closes a turn). */
const isThinkingTokens = (f: Frame): boolean =>
  f.type === "system" && f.subtype === "thinking_tokens";
/** 999.172 — the model's predicted next prompt (ambient: arrives after a result). */
const isPromptSuggestion = (f: Frame): boolean => f.type === "prompt_suggestion";
/** 999.173 — background-task bookkeeping frames (observed, routing unchanged). */
const TASK_SUBTYPES: ReadonlySet<string> = new Set([
  "task_started",
  "task_progress",
  "task_updated",
  "task_notification",
  "background_tasks_changed",
]);
const isTaskFrame = (f: Frame): boolean =>
  f.type === "system" && typeof f.subtype === "string" && TASK_SUBTYPES.has(f.subtype);
/** 999.173 — the parent tool_use id of a subagent frame, or null for the parent's own frames. */
function childParentOf(f: Frame): string | null {
  if (f.type !== "assistant" && f.type !== "user" && f.type !== "stream_event") return null;
  const parent = f.parent_tool_use_id;
  return typeof parent === "string" && parent.length > 0 ? parent : null;
}
/** Frames that OPEN a turn when none is open. Everything else is ambient. */
const isTurnContent = (f: Frame): boolean =>
  f.type === "assistant" ||
  f.type === "user" ||
  f.type === "stream_event" ||
  (f.type === "system" && f.subtype === "init");

/** Extract assistant text blocks (fallback orphan text when result.result is empty). */
function assistantText(f: Frame): string {
  if (f.type !== "assistant") return "";
  const content = f.message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) =>
      // Null-guard each block (999.99 review): a malformed frame must
      // degrade to empty text, never throw into route()'s catch-all.
      b !== null &&
      typeof b === "object" &&
      (b as { type?: string }).type === "text"
        ? String((b as { text?: unknown }).text ?? "")
        : "",
    )
    .filter((t) => t.length > 0)
    .join("\n");
}

function resultOriginKind(f: Frame): string | null {
  const kind = f.origin?.kind;
  return typeof kind === "string" ? kind : null;
}

export class AttributedStreamDemux {
  private readonly raw: AsyncIterator<SdkStreamMessage>;
  private readonly onOrphanOutput: (out: OrphanTurnOutput) => void;
  private readonly onOrphanTurnStart: (() => void) | undefined;
  private readonly onOrphanTurnEnd: (() => void) | undefined;
  private readonly onOrphanMergedIntoDaemon: (() => void) | undefined;
  private readonly onActivity: (() => void) | undefined;
  private readonly onOrphanActivity: (() => void) | undefined;
  private readonly onThinkingTokens: AttributedStreamDemuxOptions["onThinkingTokens"];
  private readonly onPromptSuggestion: AttributedStreamDemuxOptions["onPromptSuggestion"];
  private readonly onChildFrame: AttributedStreamDemuxOptions["onChildFrame"];
  private readonly isDetachedChild: AttributedStreamDemuxOptions["isDetachedChild"];
  private readonly onTaskFrame: AttributedStreamDemuxOptions["onTaskFrame"];
  private readonly onResultFrame: AttributedStreamDemuxOptions["onResultFrame"];
  private readonly mergeGraceMs: number;
  private pendingMerge: PendingMerge | null = null;
  /**
   * 999.172 — the turn that closed last, for prompt-suggestion attribution.
   * `superseded` flips when a daemon send registers or a new turn opens after
   * that close. Null until the first close.
   */
  private closes: CloseRecord[] = [];
  private readonly now: () => number;
  /** 999.172 — a suggestion that arrived while a merge hold was undecided. */
  private heldSuggestion: string | null = null;
  private readonly log: DemuxLogger | undefined;

  private readonly daemonQueue = new FrameQueue();
  /** FIFO of expected turn kinds, mirroring the CLI input-queue order. */
  private readonly expected: Expectation[] = [];
  /**
   * Monotonic token source for daemon-send identity — MODULE-GLOBAL (see
   * globalDaemonTokenCounter) so tokens stay unique across epoch swaps: a
   * ghost holding an old epoch's token must never collide with a fresh
   * demux instance's first send.
   */
  /** Token of the OPEN daemon turn (null when state !== "daemon"). */
  private openDaemonToken: number | null = null;
  /**
   * Token of the most recent daemon turn whose result was FORWARDED to the
   * daemon queue. Lets abandonDaemonTurn recognize "my turn already closed
   * and its result may still sit unconsumed" (purge path) without ever
   * touching a newer turn's frames.
   */
  private lastForwardedDaemonToken: number | null = null;
  private readonly onTurnUsage: ((resultFrame: SdkStreamMessage) => void) | undefined;
  private state: "idle" | "daemon" | "orphan" = "idle";
  /** Tentative kind of the OPEN turn ("daemon"|"orphan"); meaningful when state !== idle. */
  private openKind: "daemon" | "orphan" | null = null;
  /** Whether the open orphan turn had a task_notification signal. */
  private openOrphanSignaled = false;
  /**
   * 999.99-F2 — the open turn is a CONVERTED abandoned daemon turn (its
   * consumer exited on abort-deadline/signal without the result). Drives
   * the "abandoned-daemon" classification at close and DISABLES the
   * orphan→daemon heal for this turn: a new daemon send may already be
   * registered by the time the abandoned turn's origin-less result lands,
   * and healing would flush the stale frames to the NEW consumer — the
   * exact off-by-one this flag exists to kill.
   */
  private openAbandonedDaemon = false;
  /** Buffered frames of the open ORPHAN turn (flushed to daemonQueue on heal). */
  private orphanFrames: SdkStreamMessage[] = [];
  /** Accumulated assistant text of the open ORPHAN turn (result.result fallback). */
  private orphanText: string[] = [];
  private stopped = false;
  private pumpDone: Promise<void>;

  constructor(opts: AttributedStreamDemuxOptions) {
    this.raw = opts.raw;
    this.onOrphanOutput = opts.onOrphanOutput;
    this.onOrphanTurnStart = opts.onOrphanTurnStart;
    this.onOrphanTurnEnd = opts.onOrphanTurnEnd;
    this.onOrphanMergedIntoDaemon = opts.onOrphanMergedIntoDaemon;
    this.onActivity = opts.onActivity;
    this.onOrphanActivity = opts.onOrphanActivity;
    this.onThinkingTokens = opts.onThinkingTokens;
    this.onPromptSuggestion = opts.onPromptSuggestion;
    this.now = opts.now ?? Date.now;
    this.onChildFrame = opts.onChildFrame;
    this.isDetachedChild = opts.isDetachedChild;
    this.onTaskFrame = opts.onTaskFrame;
    this.onResultFrame = opts.onResultFrame;
    this.mergeGraceMs = opts.mergeGraceMs ?? MERGE_GRACE_MS;
    this.onTurnUsage = opts.onTurnUsage;
    this.log = opts.log;
    this.pumpDone = this.pump();
  }

  /**
   * Register a daemon-initiated send. MUST be called immediately BEFORE the
   * input is pushed to the SDK input queue (the handle's SerialTurnQueue
   * serializes sends, so at most one daemon expectation is outstanding in
   * steady state — the FIFO tolerates transient overlap regardless).
   *
   * Returns the send's identity token. The caller holds it for the turn's
   * lifetime and passes it to abandonDaemonTurn on abnormal exit — the
   * token gate makes a LATE abandon (ghost consumer surviving past a
   * force-release, up to the 2s interrupt deadline) a strict no-op instead
   * of corrupting a successor turn (999.99 review CRITICAL finding).
   */
  registerDaemonSend(): number {
    const token = globalDaemonTokenCounter++;
    this.expected.push({ kind: "daemon", token });
    // 999.172 — the user has moved on: a suggestion for the previous turn is stale.
    this.supersedeLastClose();
    return token;
  }

  /** The demuxed iterator `iterateUntilResult` consumes in place of the raw driver. */
  turnIterator(): AsyncIterator<SdkStreamMessage> {
    return {
      next: () => this.daemonQueue.next(),
    };
  }

  /**
   * 999.99-F2 — the daemon consumer exited WITHOUT consuming its turn's
   * result (abort-deadline exceeded, AbortSignal, force-release). This is
   * the seed family of the 2026-07-23 fin-client incident: on the legacy path
   * the turn's late frames + result sat unread and the NEXT dispatch popped
   * the stale result as its reply.
   *
   * Called synchronously from the send paths' catch block — i.e. BEFORE the
   * SerialTurnQueue slot releases, so no new daemon turn can be consuming
   * concurrently. Recovery, by demux state:
   *
   *  - Purge the FrameQueue (void-resolve dangling waiters + drain items).
   *    Everything queued belongs to the abandoned turn (or is ambient).
   *    If the purge captured the turn's RESULT frame (turn already closed
   *    state-side and its result was sitting unconsumed), emit it to the
   *    orphan sink NOW as "abandoned-daemon" output.
   *  - Open "daemon" turn → convert it to orphan-mode (openAbandonedDaemon)
   *    so its remaining frames buffer and its eventual result delivers via
   *    the sink. onOrphanTurnStart fires so a NEXT daemon turn that starts
   *    meanwhile begins with its stall tracker paused (isOrphanTurnOpen).
   *  - Turn never opened (state idle/orphan with our expectation still
   *    queued) → remove the unconsumed "daemon" expectation so the
   *    not-yet-started turn classifies as an orphan when its frames arrive.
   *
   * Idempotent: a second call finds an empty queue, a non-daemon state and
   * no pending daemon expectation, and no-ops.
   */
  abandonDaemonTurn(token: number, reason: string): void {
    // 999.172 — an abandoned turn's reply was never delivered normally; a
    // suggestion for it has nothing to attach to.
    for (const c of this.closes) {
      if (c.attribution.token === token) c.superseded = true;
    }
    // Branch 1 — OUR turn is the open daemon turn: purge the queue (its
    // items are ours + ambient; no other daemon consumer can exist while
    // the caller still holds — or, on the force-release path, has not yet
    // released — the SerialTurnQueue slot) and convert to orphan-mode. The
    // eventual result emits "abandoned-daemon" via closeTurn.
    if (this.state === "daemon" && this.openDaemonToken === token) {
      const purged = this.daemonQueue.drainForAbandon();
      const purgedText: string[] = [];
      for (const m of purged) {
        const t = assistantText(m as Frame);
        if (t.length > 0) purgedText.push(t);
      }
      this.log?.warn(
        { reason, token, purgedFrames: purged.length },
        "attributed-demux: open daemon turn abandoned by its consumer — converted to orphan-mode",
      );
      this.state = "orphan";
      this.openKind = "orphan";
      this.openOrphanSignaled = false;
      this.openAbandonedDaemon = true;
      this.openDaemonToken = null;
      this.orphanFrames = [];
      this.orphanText = purgedText;
      try {
        this.onOrphanTurnStart?.();
      } catch {
        // observational — never break the caller
      }
      return;
    }

    // Branch 2 — our turn never opened: retract EXACTLY our expectation
    // (token match — a fresh dispatch's entry is untouchable) so the
    // upcoming turn classifies as an orphan. No purge: queued items belong
    // to whatever turn is live, not to us.
    const idx = this.expected.findIndex(
      (e) => e.kind === "daemon" && e.token === token,
    );
    if (idx >= 0) {
      this.expected.splice(idx, 1);
      this.log?.warn(
        { reason, token },
        "attributed-demux: daemon send abandoned before its turn opened — expectation retracted",
      );
      return;
    }

    // Branch 3 — our turn already CLOSED and its result was forwarded but
    // possibly never consumed. Only safe to purge while the stream is idle
    // (a newer open turn would own the queue).
    if (this.state === "idle" && this.lastForwardedDaemonToken === token) {
      const purged = this.daemonQueue.drainForAbandon();
      this.lastForwardedDaemonToken = null;
      const purgedText: string[] = [];
      let purgedResult: Frame | null = null;
      for (const m of purged) {
        const f = m as Frame;
        if (isResultFrame(f)) {
          purgedResult = f;
          continue;
        }
        const t = assistantText(f);
        if (t.length > 0) purgedText.push(t);
      }
      if (purgedResult) {
        this.log?.warn(
          { reason, token, purgedFrames: purged.length },
          "attributed-demux: abandoned daemon turn's result purged from queue — delivering late via orphan sink",
        );
        try {
          this.onTurnUsage?.(purgedResult as unknown as SdkStreamMessage);
        } catch {
          // observational
        }
        const resultText =
          typeof purgedResult.result === "string" ? purgedResult.result : "";
        const text = resultText.length > 0 ? resultText : purgedText.join("\n");
        if (text.length > 0) {
          try {
            this.onOrphanOutput({
              text,
              originKind: resultOriginKind(purgedResult),
              isError: purgedResult.is_error === true,
              classification: "abandoned-daemon",
            });
          } catch (err) {
            this.log?.warn(
              { error: err instanceof Error ? err.message : String(err) },
              "attributed-demux: onOrphanOutput threw (abandoned delivery) — dropped",
            );
          }
        }
      }
      return;
    }

    // Ghost call — a late duplicate (force-release already abandoned this
    // turn) or a stale token while a NEWER turn owns the stream. Strict
    // no-op: touching anything here is how a ghost corrupts its successor
    // (999.99 review CRITICAL finding).
    this.log?.info(
      { reason, token },
      "attributed-demux: abandonDaemonTurn ghost call ignored (token no longer live)",
    );
  }

  /**
   * Whether an orphan turn is streaming RIGHT NOW. Read by the handle when a
   * daemon turn constructs its stall tracker: an orphan already mid-flight
   * means the daemon turn will see silence until the orphan completes, so
   * the tracker starts paused (the demux's onOrphanTurnEnd resumes it).
   */
  isOrphanTurnOpen(): boolean {
    return this.state === "orphan";
  }

  /**
   * 999.99 review follow-up — whether a DAEMON turn is streaming right now.
   * Read by injectMidTurn: an inject is only safe while the daemon turn is
   * still open ON THE WIRE (its result not yet routed); once the result has
   * been processed stream-side, a push would become the NEXT turn's opening
   * input (the steer-spill reply-swap the review flagged). Consumer-side
   * hasInFlight() alone cannot see this.
   */
  isDaemonTurnOpen(): boolean {
    return this.state === "daemon";
  }

  /**
   * Epoch teardown — stops the pump. Best-effort raw.return() so an
   * abandoned epoch's generator can settle; the pump loop exits on the
   * next settle of its in-flight next().
   */
  stop(): void {
    if (this.pendingMerge !== null) this.resolvePendingMerge("separate");
    this.stopped = true;
    // 999.99 review (critic — orphan-blind teardown): an epoch swap/close
    // mid-orphan-turn used to vanish the turn's partial output with no log.
    // Flush the accumulated text through the sink (marked truncated) and
    // balance the pause hook before ending the queue.
    if (this.state === "orphan") {
      const text = this.orphanText.join("\n");
      this.log?.warn(
        { textLength: text.length },
        "attributed-demux: epoch teardown mid-orphan-turn — flushing truncated output",
      );
      if (text.length > 0) {
        try {
          this.onOrphanOutput({
            text,
            originKind: null,
            isError: false,
            classification: this.openAbandonedDaemon
              ? "abandoned-daemon"
              : this.openOrphanSignaled
                ? "orphan-signaled"
                : "orphan-unsignaled",
          });
        } catch {
          // fire-and-forget sink
        }
      }
      try {
        this.onOrphanTurnEnd?.();
      } catch {
        // observational
      }
      this.state = "idle";
      this.openKind = null;
      this.openAbandonedDaemon = false;
    }
    try {
      void this.raw.return?.(undefined as never);
    } catch {
      // teardown is best-effort
    }
    this.daemonQueue.end();
  }

  /** Test/diagnostic seam — resolves when the pump loop has exited. */
  whenDone(): Promise<void> {
    return this.pumpDone;
  }

  // -------------------------------------------------------------------------
  // Pump
  // -------------------------------------------------------------------------

  private async pump(): Promise<void> {
    for (;;) {
      let step: IteratorResult<SdkStreamMessage>;
      try {
        step = await this.raw.next();
      } catch (err) {
        if (this.stopped) return;
        // Forward the failure to the daemon consumer — the legacy loop's
        // catch/recovery paths (AbortError vs generator-dead) key on a
        // rejected next(), exactly as if it read the raw iterator.
        this.log?.warn(
          { error: err instanceof Error ? err.message : String(err) },
          "attributed-demux: raw stream error — forwarding to daemon consumer",
        );
        this.abandonOpenOrphan("raw-stream-error");
        this.daemonQueue.fail(err);
        return;
      }
      if (this.stopped) return;
      if (step.done) {
        this.abandonOpenOrphan("raw-stream-end");
        this.daemonQueue.end();
        return;
      }

      try {
        this.route(step.value);
      } catch (err) {
        // Routing must never kill the pump — misrouted frames degrade to the
        // legacy behavior (forward to daemon queue) rather than wedging.
        this.log?.error(
          { error: err instanceof Error ? err.message : String(err) },
          "attributed-demux: route() threw — forwarding frame to daemon queue",
        );
        // 999.99 review — a throw ON A RESULT FRAME must still close the
        // open turn, or the state machine stays phantom-open and rebuilds
        // the off-by-one conveyor inside the component built to kill it.
        if (isResultFrame(step.value as Frame) && this.state !== "idle") {
          const wasOrphan = this.state === "orphan";
          this.resetTurn(wasOrphan);
        }
        this.daemonQueue.push(step.value);
      }
    }
  }

  private route(msg: SdkStreamMessage): void {
    const f = msg as Frame;
    try {
      this.onActivity?.();
    } catch {
      // observational — never break the pump
    }
    // 999.171 — observe live thinking, then fall through: the frame keeps its
    // normal (ambient) routing below, so the daemon queue is unchanged.
    if (isThinkingTokens(f)) this.tapThinkingTokens(msg);
    // 999.172 — observe the prompt suggestion, then fall through: ambient routing unchanged.
    if (isPromptSuggestion(f)) this.tapPromptSuggestion(f);
    // 999.173 — observe background-task bookkeeping; routing below is unchanged.
    if (isTaskFrame(f) && this.onTaskFrame !== undefined) {
      try {
        this.onTaskFrame(msg);
      } catch {
        // observational — a tracker fault never reaches the pump
      }
    }
    // 999.173 — a subagent frame belongs to no parent turn. Checked before the
    // merge decision: child frames are not the next turn's opening content.
    const childParent = childParentOf(f);
    if (childParent !== null) {
      this.routeChild(msg, childParent);
      return;
    }

    // 999.155 — a held orphan close is decided by the next turn-opening frame.
    if (this.pendingMerge !== null && (isTurnContent(f) || isResultFrame(f))) {
      this.resolvePendingMerge("separate");
    }
    // 999.173 — observe results AFTER a held close is decided: the held turn's
    // output must reach its consumer before the next turn's result is seen
    // (the research tracker attributes each self-fired output to the result
    // observed just before it).
    if (isResultFrame(f) && this.onResultFrame !== undefined) {
      try {
        this.onResultFrame(msg);
      } catch {
        // observational — never break the pump
      }
    }

    if (isOrphanSignal(f)) {
      // Mid-turn signals are usually FOLDED into the running turn by the CLI
      // (no turn of their own) — mark them so they cannot outrank a real send.
      this.expected.push({ kind: "orphan", midTurn: this.state !== "idle" });
      // The signal frame itself is ambient — the legacy loop ignores it, so
      // forward for parity (it would have seen it buffered).
      this.daemonQueue.push(msg);
      return;
    }

    if (this.state === "idle") {
      if (isResultFrame(f)) {
        // Zero-content turn (stale backlog edge): open+close in one frame.
        this.openTurnFor(f);
        this.closeTurn(msg, f);
        return;
      }
      if (isTurnContent(f)) {
        this.openTurnFor(f);
        this.feedOpenTurn(msg, f);
        return;
      }
      // Ambient while idle — forward for legacy parity (rate_limit_event etc.).
      this.daemonQueue.push(msg);
      return;
    }

    // A turn is open — turn-content belongs to it until its result closes it.
    if (isResultFrame(f)) {
      this.closeTurn(msg, f);
      return;
    }
    // 999.99 review (telemetry blackout) — AMBIENT frames stay ambient even
    // mid-turn: rate_limit_event / misc system frames forward to the daemon
    // queue for legacy parity instead of being buried in an orphan buffer
    // (the rate-limit tracker reads them from the legacy loop).
    if (!isTurnContent(f)) {
      this.daemonQueue.push(msg);
      return;
    }
    this.feedOpenTurn(msg, f);
  }

  /**
   * 999.173 — route one subagent frame. Never opens, feeds or closes a parent
   * turn. Forwarded to the daemon queue only while a DAEMON turn is open and
   * the lane is not a detached background task (a foreground subagent's frames
   * are part of the turn the legacy loop is reading). During a self-fired
   * turn it only proves liveness; while idle it is dropped — queueing it would
   * hand stale subagent frames to the next dispatch.
   */
  private routeChild(msg: SdkStreamMessage, parentToolUseId: string): void {
    const openKind = this.state === "idle" ? null : this.openKind;
    if (this.onChildFrame !== undefined) {
      try {
        this.onChildFrame({ parentToolUseId, openKind, frame: msg });
      } catch {
        // observational — never break the pump
      }
    }
    if (this.state === "daemon") {
      let detached = false;
      try {
        detached = this.isDetachedChild?.(parentToolUseId) === true;
      } catch {
        detached = false;
      }
      if (!detached) this.daemonQueue.push(msg);
      return;
    }
    if (this.state === "orphan") {
      try {
        this.onOrphanActivity?.();
      } catch {
        // observational — never break the pump
      }
    }
  }

  /**
   * 999.171 — report a thinking frame's running token total with the kind of
   * the open turn. The count comes from the CLI child process, so it is
   * type-checked (finite number >= 0) before anything sees it. Never throws.
   */
  private tapThinkingTokens(msg: SdkStreamMessage): void {
    if (this.onThinkingTokens === undefined) return;
    const estimatedTokens = (msg as { estimated_tokens?: unknown }).estimated_tokens;
    if (
      typeof estimatedTokens !== "number" ||
      !Number.isFinite(estimatedTokens) ||
      estimatedTokens < 0
    ) {
      return;
    }
    try {
      this.onThinkingTokens({ estimatedTokens, openKind: this.openKind });
    } catch {
      // observational — a renderer fault never reaches the pump
    }
  }

  /**
   * 999.172 — report a prompt suggestion against the last closed turn. During
   * an undecided merge hold the suggestion is held and reported when the hold
   * resolves (resolvePendingMerge), because only then is the owner known.
   */
  private tapPromptSuggestion(f: Frame): void {
    if (this.onPromptSuggestion === undefined) return;
    const suggestion = typeof f.suggestion === "string" ? f.suggestion : "";
    if (this.pendingMerge !== null) {
      this.heldSuggestion = suggestion;
      return;
    }
    this.emitPromptSuggestion(suggestion);
  }

  private emitPromptSuggestion(suggestion: string): void {
    const last = this.closes.length > 0 ? this.closes[this.closes.length - 1]! : null;
    let ambiguous = false;
    if (last !== null) {
      const inWindow = this.closes.filter((c) => last.at - c.at < SUGGESTION_AMBIGUITY_WINDOW_MS);
      const earlierUnresolved = inWindow.some((c) => c !== last && !c.resolved);
      // A close that already had a suggestion reported cannot own another
      // (the CLI emits at most one per turn).
      ambiguous = earlierUnresolved || last.resolved;
      if (ambiguous) {
        // Poison the whole window: a later straggler must not land either.
        for (const c of inWindow) c.resolved = true;
      } else {
        last.resolved = true;
      }
    }
    try {
      this.onPromptSuggestion?.({
        suggestion,
        attribution: last?.attribution ?? null,
        superseded: last?.superseded ?? false,
        ambiguous,
      });
    } catch {
      // observational — a consumer fault never reaches the pump
    }
  }

  /** 999.172 — record a turn close (fresh, unresolved) in the bounded history. */
  private markClosed(kind: "daemon" | "orphan", token: number | null): void {
    const at = this.now();
    this.closes = this.closes.filter(
      (c) => at - c.at < SUGGESTION_AMBIGUITY_WINDOW_MS * 2,
    );
    this.closes.push({
      attribution: { kind, token: kind === "daemon" ? token : null },
      at,
      resolved: false,
      superseded: false,
    });
    if (this.closes.length > AttributedStreamDemux.CLOSE_HISTORY_CAP) {
      this.closes = this.closes.slice(-AttributedStreamDemux.CLOSE_HISTORY_CAP);
    }
  }

  private static readonly CLOSE_HISTORY_CAP = 16;

  private supersedeLastClose(): void {
    const last = this.closes.length > 0 ? this.closes[this.closes.length - 1]! : null;
    if (last !== null) last.superseded = true;
  }

  private openTurnFor(_f: Frame): void {
    // 999.172 — a new turn supersedes any suggestion for the previous one.
    this.supersedeLastClose();
    this.dropSurplusMidTurnSignals();
    const entry = this.expected.length > 0 ? this.expected.shift() : undefined;
    let kind: "daemon" | "orphan";
    let signaled = false;
    if (entry?.kind === "daemon") {
      kind = "daemon";
      this.openDaemonToken = entry.token;
    } else if (entry?.kind === "orphan") {
      kind = "orphan";
      signaled = true;
    } else {
      // No expectation — unknown self-fire source (or a signal the CLI
      // consumed differently). NEVER tentatively daemon: pairing an unknown
      // turn with a send that was never made is exactly the legacy bug.
      kind = "orphan";
      signaled = false;
    }
    this.state = kind;
    this.openKind = kind;
    this.openOrphanSignaled = signaled;
    this.orphanFrames = [];
    this.orphanText = [];
    if (kind === "orphan") {
      try {
        this.onOrphanTurnStart?.();
      } catch {
        // observational — never break the pump
      }
    }
  }

  /**
   * Cap on buffered orphan-turn frames (999.99 review: unbounded buffering
   * of a long token-streamed self-fired turn is a real OOM vector — this
   * host has cgroup-OOM'd before). Past the cap, frames are dropped from
   * the heal-flush buffer while the TEXT accumulator keeps growing (text
   * is what delivery needs; the flush degrades gracefully).
   */
  private static readonly ORPHAN_FRAME_BUFFER_CAP = 1000;
  private orphanFramesCapped = false;

  private feedOpenTurn(msg: SdkStreamMessage, f: Frame): void {
    if (this.openKind === "daemon") {
      this.daemonQueue.push(msg);
      return;
    }
    try {
      this.onOrphanActivity?.();
    } catch {
      // observational — never break the pump
    }
    // 999.99 review (critic) — converted abandoned-daemon turn liveness
    // bound: a system:init frame can only open a NEW turn, so its arrival
    // proves the abandoned turn will never emit its result (interrupt
    // killed it CLI-side without a result frame). Force-close the
    // converted turn (deliver its accumulated text, balance the pause
    // hook) and open the new turn against the expectation FIFO.
    if (this.openAbandonedDaemon && f.type === "system" && f.subtype === "init") {
      this.log?.warn(
        {},
        "attributed-demux: new turn opened while an abandoned turn awaited its result — force-closing the abandoned turn",
      );
      const text = this.orphanText.join("\n");
      if (text.length > 0) {
        try {
          this.onOrphanOutput({
            text,
            originKind: null,
            isError: false,
            classification: "abandoned-daemon",
          });
        } catch {
          // fire-and-forget sink
        }
      }
      this.resetTurn(true);
      this.openTurnFor(f);
      this.feedOpenTurn(msg, f);
      return;
    }
    // Buffering bounds (999.99 review): stream_event deltas are never
    // needed by the heal flush (the legacy loop rebuilds text from
    // assistant frames; chunk-callbacks merely degrade) — skip them.
    // Everything else buffers up to the cap.
    if (f.type !== "stream_event") {
      if (this.orphanFrames.length < AttributedStreamDemux.ORPHAN_FRAME_BUFFER_CAP) {
        this.orphanFrames.push(msg);
      } else if (!this.orphanFramesCapped) {
        this.orphanFramesCapped = true;
        this.log?.warn(
          { cap: AttributedStreamDemux.ORPHAN_FRAME_BUFFER_CAP },
          "attributed-demux: orphan frame buffer cap reached — heal flush will be text-degraded",
        );
      }
    }
    const text = assistantText(f);
    if (text.length > 0) this.orphanText.push(text);
  }

  private closeTurn(msg: SdkStreamMessage, f: Frame): void {
    const originKind = resultOriginKind(f);
    const wasOpen = this.state !== "idle";
    const kind = wasOpen ? this.openKind : null;

    // Resolve final attribution (origin is authoritative when present).
    if (kind === "daemon" || (!wasOpen && this.peekExpectDaemon())) {
      if (originKind === "task-notification") {
        // HEAL: tentatively daemon, actually self-fired. The daemon waiter
        // keeps waiting; its expectation is restored to the FIFO head WITH
        // ITS ORIGINAL TOKEN (identity preserved for abandonment).
        this.log?.warn(
          { originKind },
          "attributed-demux: daemon-tentative turn reclassified to orphan at result (origin cross-check)",
        );
        if (kind === "daemon" && this.openDaemonToken !== null) {
          this.expected.unshift({ kind: "daemon", token: this.openDaemonToken });
          // Its frames already streamed to the daemon consumer; if no separate
          // turn follows, the send was folded into this one — keep the result.
          this.holdForMerge(msg, f, "reclassified-from-daemon", originKind, [], this.orphanText);
          this.resetTurn(false);
          return;
        }
        this.emitOrphan(f, "reclassified-from-daemon", originKind);
        this.markClosed("orphan", null);
        this.resetTurn(false);
        return;
      }
      // Genuine daemon result — forward; the legacy loop terminates on it.
      if (!wasOpen) {
        // Zero-content-turn defensive branch: consume the expectation and
        // adopt its token as the forwarded turn's identity.
        const entry = this.expected.shift();
        this.lastForwardedDaemonToken =
          entry?.kind === "daemon" ? entry.token : null;
      } else {
        this.lastForwardedDaemonToken = this.openDaemonToken;
      }
      this.markClosed("daemon", this.lastForwardedDaemonToken);
      this.daemonQueue.push(msg);
      this.resetTurn(false);
      return;
    }

    // Orphan-tentative (or unknown zero-content) turn.
    // 999.99-F2 guard: a CONVERTED abandoned-daemon turn must NEVER heal
    // back to daemon — its origin-less result plus an already-registered
    // NEXT daemon send would otherwise flush the stale frames to the new
    // consumer (the exact off-by-one the abandon path exists to kill).
    const daemonStillExpected = this.expected.some((e) => e.kind === "daemon");
    if (
      originKind === null &&
      daemonStillExpected &&
      kind === "orphan" &&
      !this.openAbandonedDaemon
    ) {
      // HEAL: no origin on the result while a daemon send is pending — this
      // was the daemon's turn. Flush the withheld frames so the legacy loop
      // processes the full sequence and returns the CORRECT result.
      //
      // 999.99 review (FIFO reconciliation) — the consumed "orphan"
      // expectation is deliberately NOT restored here. If it was genuinely
      // this turn's signal, it is spent; if it was a SURPLUS entry
      // (coalesced notifications), restoring it would degrade EVERY future
      // daemon turn to orphan-tentative (stall tracker paused, no streaming)
      // forever. A wrongly-dropped signal self-corrects: its turn still
      // classifies orphan-unsignaled by default.
      this.log?.warn(
        { bufferedFrames: this.orphanFrames.length },
        "attributed-demux: orphan-tentative turn reclassified to daemon at result — flushing buffered frames",
      );
      const idx = this.expected.findIndex((e) => e.kind === "daemon");
      if (idx >= 0) {
        const entry = this.expected.splice(idx, 1)[0];
        this.lastForwardedDaemonToken =
          entry?.kind === "daemon" ? entry.token : null;
      }
      this.markClosed("daemon", this.lastForwardedDaemonToken);
      for (const buffered of this.orphanFrames) this.daemonQueue.push(buffered);
      this.daemonQueue.push(msg);
      this.resetTurn(true);
      return;
    }

    // Zero-content orphan turn closed straight from idle: consume the
    // pending orphan expectation so it cannot misclassify the NEXT turn.
    if (!wasOpen && this.expected[0]?.kind === "orphan") {
      this.expected.shift();
    }
    if (wasOpen && daemonStillExpected && !this.openAbandonedDaemon) {
      this.holdForMerge(
        msg,
        f,
        this.openOrphanSignaled ? "orphan-signaled" : "orphan-unsignaled",
        originKind,
        this.orphanFrames,
        this.orphanText,
      );
      this.resetTurn(true);
      return;
    }
    this.emitOrphan(
      f,
      this.openAbandonedDaemon
        ? "abandoned-daemon"
        : this.openOrphanSignaled
          ? "orphan-signaled"
          : "orphan-unsignaled",
      originKind,
    );
    this.markClosed("orphan", null);
    this.resetTurn(true);
  }

  /**
   * 999.155 — drop orphan expectations that were signaled MID-TURN and sit
   * ahead of a pending daemon send. The CLI folded those notifications into
   * the turn that was running; leaving them would label the daemon's own
   * turn orphan (no streaming, paused stall tracker) until its result. If one
   * was in fact a separate self-fired turn, its result carries
   * origin=task-notification and the daemon-tentative heal reroutes it.
   */
  private dropSurplusMidTurnSignals(): void {
    const daemonIdx = this.expected.findIndex((e) => e.kind === "daemon");
    if (daemonIdx <= 0) return;
    let dropped = 0;
    while (this.expected.length > 0) {
      const head = this.expected[0]!;
      if (head.kind !== "orphan" || head.midTurn !== true) break;
      this.expected.shift();
      dropped++;
    }
    if (dropped > 0) {
      this.log?.info(
        { dropped },
        "attributed-demux: surplus mid-turn notification signal(s) yielded to a pending daemon send",
      );
    }
  }

  private holdForMerge(
    resultMsg: SdkStreamMessage,
    resultFrame: Frame,
    classification: OrphanTurnOutput["classification"],
    originKind: string | null,
    frames: readonly SdkStreamMessage[],
    text: readonly string[],
  ): void {
    // A previous hold that was never decided can only mean two orphan closes
    // back to back with no turn content between — decide it first.
    if (this.pendingMerge !== null) this.resolvePendingMerge("separate");
    const timer = setTimeout(() => this.resolvePendingMerge("merged"), this.mergeGraceMs);
    (timer as { unref?: () => void }).unref?.();
    this.pendingMerge = {
      resultMsg,
      resultFrame,
      classification,
      originKind,
      frames: [...frames],
      text: [...text],
      timer,
    };
  }

  private resolvePendingMerge(outcome: "merged" | "separate"): void {
    const held = this.pendingMerge;
    if (held === null) return;
    this.pendingMerge = null;
    clearTimeout(held.timer);
    const idx = this.expected.findIndex((e) => e.kind === "daemon");
    if (outcome === "merged" && idx >= 0 && !this.stopped) {
      const entry = this.expected.splice(idx, 1)[0];
      this.lastForwardedDaemonToken = entry?.kind === "daemon" ? entry.token : null;
      this.log?.warn(
        { classification: held.classification, originKind: held.originKind, frames: held.frames.length },
        "attributed-demux: pending daemon send was folded into the orphan turn — result delivered to the daemon consumer",
      );
      for (const frame of held.frames) this.daemonQueue.push(frame);
      this.daemonQueue.push(held.resultMsg);
      this.markClosed("daemon", this.lastForwardedDaemonToken);
      this.releaseHeldSuggestion();
      try {
        this.onOrphanMergedIntoDaemon?.();
      } catch {
        // observational — never break the pump
      }
      return;
    }
    this.emitOrphan(held.resultFrame, held.classification, held.originKind, held.text);
    this.markClosed("orphan", null);
    this.releaseHeldSuggestion();
  }

  /** 999.172 — report a suggestion held across a merge hold, now that its owner is known. */
  private releaseHeldSuggestion(): void {
    const suggestion = this.heldSuggestion;
    if (suggestion === null) return;
    this.heldSuggestion = null;
    this.emitPromptSuggestion(suggestion);
  }

  private peekExpectDaemon(): boolean {
    return this.expected[0]?.kind === "daemon";
  }

  private emitOrphan(
    resultFrame: Frame,
    classification: OrphanTurnOutput["classification"],
    originKind: string | null,
    accumulated: readonly string[] = this.orphanText,
  ): void {
    // 999.99 review (telemetry blackout) — charge usage for turns whose
    // result never reaches the legacy loop's extractUsage. Best-effort.
    try {
      this.onTurnUsage?.(resultFrame as unknown as SdkStreamMessage);
    } catch {
      // observational — never break the pump
    }
    const resultText =
      typeof resultFrame.result === "string" ? resultFrame.result : "";
    const text = resultText.length > 0 ? resultText : accumulated.join("\n");
    if (text.length === 0) {
      this.log?.info(
        { classification, originKind },
        "attributed-demux: orphan turn produced no user-visible text — nothing to deliver",
      );
      return;
    }
    try {
      this.onOrphanOutput({
        text,
        originKind,
        isError: resultFrame.is_error === true,
        classification,
      });
    } catch (err) {
      this.log?.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "attributed-demux: onOrphanOutput threw (delivery sink) — dropped",
      );
    }
  }

  private resetTurn(wasOrphan: boolean): void {
    if (wasOrphan && this.openKind === "orphan") {
      try {
        this.onOrphanTurnEnd?.();
      } catch {
        // observational — never break the pump
      }
    }
    this.state = "idle";
    this.openKind = null;
    this.openOrphanSignaled = false;
    this.openAbandonedDaemon = false;
    this.openDaemonToken = null;
    this.orphanFrames = [];
    this.orphanText = [];
    this.orphanFramesCapped = false;
  }

  /** An orphan turn cut off by stream end/error — balance the pause hook. */
  private abandonOpenOrphan(reason: string): void {
    if (this.state === "orphan") {
      this.log?.info({ reason }, "attributed-demux: open orphan turn abandoned");
      try {
        this.onOrphanTurnEnd?.();
      } catch {
        // observational
      }
    }
    this.state = "idle";
    this.openKind = null;
    this.openAbandonedDaemon = false;
  }
}
