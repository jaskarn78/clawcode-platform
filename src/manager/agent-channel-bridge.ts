/**
 * Phase 140 — ClawCode channel: daemon-side bridge.
 *
 * The daemon's authority for one v3 agent's ClawCode channel. It pushes
 * daemon-originated events to the agent (cross-agent / cron / dream / wake /
 * memory), owns the inbox of batched deliveries, and is the single source of
 * truth for "did the agent process this" — per the spec, a pushed
 * notification can be dropped silently, so the `clawcode_ack` round-trip is
 * the ONLY delivery truth. `awaitReply` lets a synchronous caller (e.g. an
 * `ask-agent` IPC) block on the agent's ack.
 *
 * **Transport-agnostic.** The bridge sends via an injected sink
 * (`ChannelMessageSink`) and implements `ChannelDaemonLink` so the
 * agent-side `ClawcodeChannelServerCore` can relay tool calls straight in. In
 * production the sink writes NDJSON to the per-agent Unix socket
 * (`~/.clawcode/channels-state/<agent>/daemon.sock`) and the relayed tool
 * calls arrive over that same socket; in tests the bridge and the server core
 * are linked in-process. The socket server itself is Stage 2 — this PR ships
 * the state machine, proven against a mock transport.
 *
 * Spec:
 *   `.planning/phases/140-claudecode-interactive-channels-backend/specs/clawcode-channel-spec.md`
 */

import type {
  AckInput,
  ChannelDaemonLink,
  ChannelEventType,
  DaemonChannelMessage,
  InboxEnvelope,
  InboxReadInput,
  StatusInput,
} from "../channels/clawcode-channel-server.js";
import { DEFAULT_MAX_TURN_DURATION_MS } from "./stream-stall-tracker.js";

/** Sink that delivers a daemon message to the agent's channel server. */
export type ChannelMessageSink = (msg: DaemonChannelMessage) => void;

/**
 * v3 channel chat — how long a synchronous caller (Discord chat in bridge.ts,
 * or the warm-worker pool) waits for the agent's reply over the channel before
 * failing the route with {@link ChannelReplyTimeoutError}.
 *
 * MUST sit just ABOVE the stream-stall tracker's absolute
 * {@link DEFAULT_MAX_TURN_DURATION_MS} (20min) wall-clock ceiling. A v3 turn
 * delivers its final answer ONLY when the turn ENDS — via the Stop-hook
 * (`handleTurnComplete`) or an explicit `clawcode_ack` — which for a research
 * agent (web-search + multi-minute reasoning) is routinely minutes in. The old
 * hardcoded 120s cap rejected basically every real research turn before it
 * could finish (live evidence 2026-06-14: successful turns were sub-second —
 * totalMs 415/467 — while every real turn died at totalMs ≈ 120001, surfacing
 * as "did not reply over the channel within timeout ... within 120000ms" and no
 * response in Discord).
 *
 * Sizing it at ceiling + 60s means: a healthy long turn resolves on its own
 * completion; a genuinely wedged turn is force-settled by the 20min ceiling
 * (→ interrupt → Stop hook → reply resolved) just INSIDE this window, so the
 * route still settles instead of hanging unbounded. The +60s margin covers the
 * force-settle → Stop-hook → relay latency. Single-sourced so a future change to
 * the turn ceiling carries the reply timeout with it.
 *
 * NOTE: this does NOT change `awaitReply`'s 30s DEFAULT (used by quick
 * agent-to-agent ack paths like ask-agent) — only the value the two v3-chat
 * call sites pass explicitly.
 */
export const V3_CHANNEL_REPLY_TIMEOUT_MS = DEFAULT_MAX_TURN_DURATION_MS + 60_000;

const DEFAULT_INBOX_DRAIN = 10;

/**
 * Cap on the bounded remembered-acked structures. After a tracked message is
 * acked (finding a) its `tracked` entry is evicted to keep the live map from
 * growing across a long-lived agent — but `isAcked` and `awaitReply` must
 * still answer correctly for a recently-acked id. We retain just the
 * message_id and (when present) the correlation→ack mapping in FIFO sets
 * capped here. Beyond the cap the OLDEST entries are forgotten, which folds
 * back into the spec's drop-is-silent contract (an already-collected id =
 * silent no-op). Mirrors `recentSentIds` / `RECENT_SENT_CAP` in the official
 * discord channel server.
 */
const ACKED_MEMORY_CAP = 1024;

interface InboxRow {
  readonly envelope: InboxEnvelope;
  state: "pending" | "in-flight";
}

interface TrackedMessage {
  readonly correlationId: string | undefined;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: Error): void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Thrown by `awaitReply` when the agent doesn't ack within the deadline. */
export class ChannelReplyTimeoutError extends Error {
  constructor(
    readonly correlationId: string,
    readonly timeoutMs: number,
  ) {
    super(
      `No agent ack for correlation '${correlationId}' within ${timeoutMs}ms`,
    );
    this.name = "ChannelReplyTimeoutError";
  }
}

/** Thrown into a pending `awaitReply` when its turn is aborted via `/clawcode-interrupt`. */
export class ChannelReplyInterruptedError extends Error {
  constructor(
    readonly correlationId: string,
    reason: string,
  ) {
    super(`Reply for correlation '${correlationId}' aborted: ${reason}`);
    this.name = "ChannelReplyInterruptedError";
  }
}

export class AgentChannelBridge implements ChannelDaemonLink {
  /** Ordered inbox of batched deliveries awaiting `clawcode_inbox_read`. */
  private readonly inbox: InboxRow[] = [];
  /**
   * In-flight tracked messages keyed by message_id. An entry lives here from
   * `push`/`enqueueInbox` until its ack, at which point it is EVICTED (finding
   * a) — the map never grows unbounded for a long-lived agent.
   */
  private readonly tracked = new Map<string, TrackedMessage>();
  /**
   * Bounded FIFO of message_ids already acked, retained AFTER eviction so
   * `isAcked` keeps reporting true for a recently-acked id (finding a). Insert
   * order = iteration order, so the oldest id is dropped when the cap is hit.
   */
  private readonly ackedIds = new Set<string>();
  /**
   * Bounded FIFO mapping a reply_correlation_id to the ack that resolved it,
   * retained AFTER eviction so `awaitReply` can resolve immediately when the
   * ack landed before the caller registered (finding c).
   */
  private readonly ackedCorrelations = new Map<string, AckInput>();
  /** Pending `awaitReply` promises keyed by reply_correlation_id. */
  private readonly pendingReplies = new Map<string, Deferred<AckInput>>();
  private lastStatus: StatusInput | null = null;
  /**
   * Phase 999.82 — single-slot progress callback for the live Discord editor.
   * Best-effort COSMETIC fanout: a PostToolUse hook ships accumulated assistant
   * text mid-turn and `onProgress` forwards it here. Single in-flight turn per
   * agent (SPEC §Risks), so one slot suffices; Plan 02 owns any >1-pending skip
   * policy. CRITICAL INVARIANT: progress NEVER touches `pendingReplies` /
   * `tracked` / `ackedCorrelations` — delivery truth stays with ack /
   * turn_complete. Pinned by a test.
   */
  private progressCallback: ((text: string) => void) | null = null;

  constructor(
    private readonly agent: string,
    private readonly send: ChannelMessageSink,
  ) {}

  /**
   * Push a daemon event to the agent immediately (fire-and-forget
   * notification). Tracks it for ack correlation; if it carries a
   * `reply_correlation_id`, a later ack resolves the matching `awaitReply`.
   */
  push(msg: DaemonChannelMessage): void {
    this.track(msg);
    this.send(msg);
  }

  /**
   * Enqueue a batched delivery into the inbox WITHOUT pushing it inline. The
   * agent learns of it via a subsequent `notifyInbox()` and drains it with
   * `clawcode_inbox_read`. Order is preserved.
   */
  enqueueInbox(msg: DaemonChannelMessage): void {
    this.track(msg);
    this.inbox.push({
      envelope: {
        type: msg.type,
        message_id: msg.message_id,
        content: msg.content,
        meta: msg.meta,
      },
      state: "pending",
    });
  }

  /**
   * Announce that pending inbox deliveries are available. Sends a single
   * `inbox`-type notification carrying the pending count + the drain tool name
   * (spec event taxonomy). No-op when the inbox is empty.
   */
  notifyInbox(messageId: string): void {
    const count = this.pendingCount();
    if (count === 0) return;
    this.send({
      type: "inbox",
      message_id: messageId,
      content: String(count),
      meta: { message_count: count, drain_via: "clawcode_inbox_read" },
    });
  }

  /**
   * Block until the agent acks the message carrying `correlationId`, or reject
   * after `timeoutMs`. Used by synchronous cross-agent paths (e.g. ask-agent).
   */
  awaitReply(correlationId: string, timeoutMs = 30_000): Promise<AckInput> {
    // (c) ACK-BEFORE-REGISTER RACE: the correlated message may have been acked
    // before any caller registered an awaitReply. Resolve synchronously from
    // the remembered-ack map rather than hanging until the timeout fires.
    const alreadyAcked = this.ackedCorrelations.get(correlationId);
    if (alreadyAcked) return Promise.resolve(alreadyAcked);

    const existing = this.pendingReplies.get(correlationId);
    if (existing) return existing.promise;

    const d = defer<AckInput>();
    this.pendingReplies.set(correlationId, d);

    if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      const timer = setTimeout(() => {
        if (this.pendingReplies.delete(correlationId)) {
          d.reject(new ChannelReplyTimeoutError(correlationId, timeoutMs));
        }
      }, timeoutMs);
      // Don't keep the event loop alive solely for this timer.
      timer.unref?.();
    }
    return d.promise;
  }

  // ── ChannelDaemonLink (agent → daemon, relayed by the channel server) ─────

  /**
   * Agent acked a delivery. Clears the inbox row (if any), resolves a pending
   * `awaitReply` when the message carried a `reply_correlation_id`, then evicts
   * the tracked entry and records the id in the bounded remembered-acked set.
   * Unknown `message_id` → silent no-op (drop-is-silent: the daemon never
   * assumes delivery).
   */
  handleAck(input: AckInput): void {
    // Phase 141 — tolerate the agent dropping (or adding) the "discord-" prefix
    // when copying the message_id back into clawcode_ack. Observed live: the
    // envelope carried `message_id="discord-<id>"` but the model acked with
    // `"<id>"`, so the exact-match lookup missed → the ack was a silent no-op →
    // the real answer (ack.result) was lost and the daemon fell back to the
    // Stop-hook's trailing narration ("Answered with the current date and
    // time."). Try the exact id first, then the prefix-toggled variant; key all
    // downstream eviction/remember by the ACTUAL tracked key.
    let key = input.message_id;
    let tracked = this.tracked.get(key);
    if (!tracked) {
      const alt = key.startsWith("discord-")
        ? key.slice("discord-".length)
        : `discord-${key}`;
      const altTracked = this.tracked.get(alt);
      if (altTracked) {
        key = alt;
        tracked = altTracked;
      }
    }
    if (!tracked) {
      // Genuinely unknown id, OR an id already acked-and-evicted (finding a).
      // Either way a silent no-op per spec — the daemon never assumes delivery,
      // and re-acking an already-collected message must not throw.
      return;
    }

    // Clear the inbox row for this message_id, if present.
    const idx = this.inbox.findIndex(
      (row) => row.envelope.message_id === key,
    );
    if (idx !== -1) this.inbox.splice(idx, 1);

    // Correlate a synchronous reply, if one is awaited. Done BEFORE eviction so
    // the resolving Deferred sees the ack; also remember the correlation so a
    // LATER awaitReply (finding c) can resolve immediately.
    if (tracked.correlationId !== undefined) {
      const d = this.pendingReplies.get(tracked.correlationId);
      if (d) {
        this.pendingReplies.delete(tracked.correlationId);
        d.resolve(input);
      }
      this.rememberCorrelation(tracked.correlationId, input);
    }

    // (a) MEMORY LEAK: evict the in-flight tracked entry; record the id in the
    // bounded remembered-acked set so `isAcked` still answers true.
    this.tracked.delete(key);
    this.rememberAckedId(key);
  }

  /**
   * Phase 140 — DETERMINISTIC DELIVERY FALLBACK (the Stop-hook path).
   *
   * Called when the agent's `claude --channels` turn ENDS (signalled by a
   * `Stop` hook the v3 backend injects via `--settings`). Resolves every
   * STILL-PENDING `awaitReply` with the agent's final assistant message, so a
   * synchronous caller (Discord chat) ALWAYS gets a reply even when the model
   * never called `clawcode_ack`. This removes the model's discretion from the
   * delivery path — the prompt's ack-by-default is now a fast-path, not the
   * only delivery truth.
   *
   * **Deduped by construction.** `clawcode_ack` is a TOOL CALL the agent makes
   * mid-turn; its relay reaches `handleAck` (which resolves + removes the
   * pending reply) BEFORE the turn ends and the Stop hook fires. So when the
   * agent DID ack, `pendingReplies` is already empty here → no-op, no
   * double-post. Only an UN-acked correlation is still pending → resolved with
   * `lastAssistantMessage`. Mirrors `handleAck`'s bookkeeping (remember the
   * correlation, evict the tracked entry, record the acked id) so a LATE real
   * ack that arrives after this is a silent no-op per the drop-is-silent
   * contract. Returns the number of replies resolved (telemetry).
   */
  handleTurnComplete(lastAssistantMessage: string): number {
    // Phase 141 A1 — FAIL-CLOSED correlation guard. The Stop-hook frame carries
    // NO message_id (clawcode-stop-hook.ts: only session_id + last_assistant_
    // message), so this fallback cannot tell WHICH pending reply the just-ended
    // turn produced. It is unambiguous ONLY when EXACTLY ONE reply is pending.
    // With >1 pending — reachable because the v3 push+awaitReply path is NOT
    // daemon-serialized (ask-agent IPC / slash skill-turns / Discord chat all
    // share this per-agent bridge) — resolving any of them risks delivering one
    // turn's text to a different caller (the `a03111b4` mis-delivery class). So
    // bail: leave them pending → a VISIBLE awaitReply timeout, never wrong-
    // content. size===0 (agent acked, or empty turn) → no-op, unchanged.
    //
    // NECESSARY, NOT SUFFICIENT: this does not close the residual hole where a
    // turn acks (dropping size to 1) and its Stop hook then resolves a DIFFERENT
    // still-pending reply with this turn's text. Full coexistence-correctness
    // needs a v3 single-flight gate so size is always ≤1 — see the A1 prod-
    // readiness note in 141-REMAINING.md.
    if (this.pendingReplies.size !== 1) return 0;
    let resolved = 0;
    // Snapshot keys — the map is mutated within the loop.
    for (const correlationId of [...this.pendingReplies.keys()]) {
      const d = this.pendingReplies.get(correlationId);
      if (!d) continue;
      const synthesized: AckInput = {
        message_id: correlationId,
        status: "processed",
        result: lastAssistantMessage,
      };
      this.pendingReplies.delete(correlationId);
      d.resolve(synthesized);
      this.rememberCorrelation(correlationId, synthesized);
      // Evict the matching in-flight tracked entry so a LATE real ack for the
      // same correlation is a silent no-op (drop-is-silent).
      for (const [mid, t] of this.tracked) {
        if (t.correlationId === correlationId) {
          this.tracked.delete(mid);
          this.rememberAckedId(mid);
          break;
        }
      }
      resolved++;
    }
    return resolved;
  }

  /**
   * Phase 141 (1C) — abort cleanup for `/clawcode-interrupt`. The v3 interrupt
   * writes Ctrl-C to the agent PTY (aborting the MODEL), but the daemon-side
   * `awaitReply` keeps blocking until its 120s timeout — the Discord typing
   * indicator leaks the whole time, then the turn ❌-times-out. Rejecting the
   * pending reply here cuts that short: the chat path's `await awaitReply` throws
   * at once → typing clears, the turn ❌s immediately instead of in ~2 minutes.
   * Mirrors `handleTurnComplete` bookkeeping (evict the in-flight tracked entry +
   * remember the id) so a LATE real ack for the aborted turn is a silent no-op
   * (drop-is-silent). Returns the number rejected (telemetry); no-op when nothing
   * is pending (v2/non-channel agents, or an idle agent).
   */
  cancelPendingReplies(reason: string): number {
    if (this.pendingReplies.size === 0) return 0;
    let cancelled = 0;
    for (const correlationId of [...this.pendingReplies.keys()]) {
      const d = this.pendingReplies.get(correlationId);
      if (!d) continue;
      this.pendingReplies.delete(correlationId);
      d.reject(new ChannelReplyInterruptedError(correlationId, reason));
      for (const [mid, t] of this.tracked) {
        if (t.correlationId === correlationId) {
          this.tracked.delete(mid);
          this.rememberAckedId(mid);
          break;
        }
      }
      cancelled++;
    }
    return cancelled;
  }

  /**
   * (b) MISSED-ACK RETRY (spec failure-mode: "Agent doesn't ack within N
   * seconds → daemon retries via inbox"). Flip in-flight inbox rows back to
   * pending so the next `notifyInbox` re-announces them for a fresh
   * `clawcode_inbox_read` drain. Optionally restrict to a single `filterType`.
   * Returns the number of rows re-pended (for callers/telemetry).
   */
  rependInFlight(filterType?: ChannelEventType): number {
    let repended = 0;
    for (const row of this.inbox) {
      if (row.state !== "in-flight") continue;
      if (filterType !== undefined && row.envelope.type !== filterType) continue;
      row.state = "pending";
      repended++;
    }
    return repended;
  }

  /**
   * Drain up to `max_count` (default 10) pending envelopes in insertion order,
   * optionally filtered by `filter_type`. Returned rows are marked in-flight;
   * the agent must `clawcode_ack` each one.
   */
  handleInboxRead(input: InboxReadInput): readonly InboxEnvelope[] {
    const max = input.max_count ?? DEFAULT_INBOX_DRAIN;
    const filter: ChannelEventType | undefined = input.filter_type;
    const drained: InboxEnvelope[] = [];
    for (const row of this.inbox) {
      if (drained.length >= max) break;
      if (row.state !== "pending") continue;
      if (filter !== undefined && row.envelope.type !== filter) continue;
      row.state = "in-flight";
      drained.push(row.envelope);
    }
    return drained;
  }

  /** Agent reported its state (dashboard / heartbeat telemetry). */
  handleStatus(input: StatusInput): void {
    this.lastStatus = input;
  }

  // ── Progress fanout (Phase 999.82 — best-effort cosmetic streaming) ───────

  /**
   * Register the live-editor progress sink. Single-slot (one in-flight turn per
   * agent — SPEC §Risks). Registering a second while one is active is allowed:
   * it replaces the slot (Plan 02 owns the >1-pending skip policy).
   */
  registerProgressCallback(cb: (text: string) => void): void {
    this.progressCallback = cb;
  }

  /** Clear the progress sink (turn end / editor torn down). */
  clearProgressCallback(): void {
    this.progressCallback = null;
  }

  /**
   * Forward accumulated assistant text to the registered progress callback. A
   * PostToolUse hook ships this mid-turn (per tool call). No callback → no-op.
   *
   * CRITICAL: progress is best-effort COSMETIC. It MUST NOT read or mutate
   * `pendingReplies` / `tracked` / `ackedCorrelations` — a pending `awaitReply`
   * stays pending. `clawcode_ack` and `handleTurnComplete` remain the ONLY
   * delivery truth. This invariant is pinned by a test.
   */
  onProgress(text: string): void {
    this.progressCallback?.(text);
  }

  // ── Introspection (dashboard / heartbeat / tests) ─────────────────────────

  pendingCount(): number {
    return this.inbox.filter((r) => r.state === "pending").length;
  }

  /**
   * Phase 999.82 Plan 02 — number of registered `awaitReply` promises in
   * flight. The v3 chat branch checks this BEFORE its own `awaitReply` to
   * decide whether to stream: `push` only `track`s (does NOT register a
   * pending reply), so a non-zero count here means ANOTHER turn is already
   * awaiting → streaming is skipped to avoid attaching progress to the wrong
   * message (single-in-flight correlation, SPEC §Risks).
   */
  pendingReplyCount(): number {
    return this.pendingReplies.size;
  }

  inFlightCount(): number {
    return this.inbox.filter((r) => r.state === "in-flight").length;
  }

  getLastStatus(): StatusInput | null {
    return this.lastStatus;
  }

  /**
   * Whether a message has been acked. A still-tracked message is in-flight
   * (not yet acked) → false; on ack it is evicted from `tracked` and recorded
   * in the bounded remembered-acked set → true. False for unknown ids and for
   * acks evicted past the cap (already-collected = silent no-op per spec).
   */
  isAcked(messageId: string): boolean {
    return this.ackedIds.has(messageId);
  }

  /** Test/diagnostic: count of in-flight tracked messages (drained on ack). */
  trackedSize(): number {
    return this.tracked.size;
  }

  /** Test/diagnostic: size of the bounded remembered-acked id set. */
  ackedRememberedSize(): number {
    return this.ackedIds.size;
  }

  private track(msg: DaemonChannelMessage): void {
    this.tracked.set(msg.message_id, {
      correlationId: msg.meta?.reply_correlation_id,
    });
    // Cap like ackedIds/ackedCorrelations. Fire-and-forget pushes (reactions,
    // a2a-relay) carry no reply_correlation_id and the agent never acks them
    // under reply-as-text, so they would otherwise never evict → unbounded
    // growth. FIFO-evict the oldest past the cap (1024 simultaneously-in-flight
    // is far beyond any real concurrency, so this never drops a live reply).
    if (this.tracked.size > ACKED_MEMORY_CAP) {
      const oldest = this.tracked.keys().next().value;
      if (oldest !== undefined) this.tracked.delete(oldest);
    }
    void this.agent;
  }

  /** Record an acked id in the bounded FIFO set (oldest evicted past the cap). */
  private rememberAckedId(messageId: string): void {
    this.ackedIds.add(messageId);
    if (this.ackedIds.size > ACKED_MEMORY_CAP) {
      const oldest = this.ackedIds.values().next().value;
      if (oldest !== undefined) this.ackedIds.delete(oldest);
    }
  }

  /** Record a correlation→ack in the bounded FIFO map (oldest evicted past the cap). */
  private rememberCorrelation(correlationId: string, input: AckInput): void {
    this.ackedCorrelations.set(correlationId, input);
    if (this.ackedCorrelations.size > ACKED_MEMORY_CAP) {
      const oldest = this.ackedCorrelations.keys().next().value;
      if (oldest !== undefined) this.ackedCorrelations.delete(oldest);
    }
  }
}
