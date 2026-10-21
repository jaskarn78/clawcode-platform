/**
 * TraceCollector — in-memory span buffer with batched per-turn flush.
 *
 * The collector is injected into hot-path modules (DiscordBridge,
 * ContextAssembler, SdkSessionAdapter) via the project's `Deps` pattern.
 * Each Discord message → reply cycle creates one `Turn`; spans are buffered
 * in memory for the lifetime of that turn and committed to the TraceStore
 * in a SINGLE transaction on `turn.end(status)`. This keeps SQLite write
 * amplification bounded under tool-heavy turns (see 50-RESEARCH.md
 * pitfall 5).
 *
 * Idempotency: calling `span.end()` or `turn.end()` more than once is a
 * safe no-op — useful because error handlers can call `end("error")`
 * alongside normal cleanup without double-writing.
 */

import {
  EVIDENCE_MAX_PER_TURN,
  evidenceKey,
  type EvidenceEntry,
} from "../manager/evidence-ledger.js";
import {
  CLAIMS_MAX_PER_TURN,
  validateClaim,
  type ClaimEntry,
  type ValidateClaimOptions,
  type VerifyClaimParams,
} from "../manager/claim-ledger.js";
import type { Logger } from "pino";
import type {
  CacheTelemetrySnapshot,
  SpanRecord,
  TurnRecord,
  TurnStatus,
} from "./types.js";
import type { TraceStore } from "./trace-store.js";
import type { TurnOrigin } from "../manager/turn-origin.js";
import { ToolCache } from "../mcp/tool-cache.js";

/** 2026-08-27 — caps for the per-turn tool-result text accumulator. */
export const TOOL_RESULT_TEXT_MAX_PER_RESULT = 8_000;
export const TOOL_RESULT_TEXT_MAX_PER_TURN = 96_000;
/**
 * 2026-08-27 — evidence lookback. A follow-up turn ("and for Roth?") reuses
 * the sources the previous turn opened; without this every follow-up would
 * read as unsourced. Carried entries are flagged `stale`.
 */
export const EVIDENCE_LOOKBACK_MS = 30 * 60 * 1000;
/**
 * 2026-08-28 — how long an ENDED turn keeps answering ledger reads and
 * accepting post-hoc `verify_claim` records. The bridge's self-owned
 * re-dispatch (wedge/crash/drain) ends the Turn before delivery reads the
 * ledger, and the corrective hop records claims after the turn committed —
 * both read/wrote a Turn that no longer existed and got `[]`/null. Same
 * window as the claim sink (`CLAIM_SINK_TTL_MS`).
 */
export const CLAIMS_LOOKBACK_MS = 10 * 60 * 1000;

/**
 * TraceCollector — factory for per-turn `Turn` objects.
 *
 * Holds a single TraceStore reference plus a base logger; callers invoke
 * `startTurn` to open a new in-memory buffer for a single Discord message
 * or scheduler tick.
 */
export class TraceCollector {
  constructor(
    private readonly store: TraceStore,
    private readonly log: Logger,
  ) {}

  /**
   * Open a new turn buffer.
   *
   * @param turnId    - Discord message id for Discord turns, or a prefixed
   *                    nanoid (`scheduler:<id>`, `subagent:<id>`) for
   *                    non-Discord triggers.
   * @param agent     - Agent name for filtering in percentile queries.
   * @param channelId - Discord channel id when available, else `null`.
   */
  startTurn(turnId: string, agent: string, channelId: string | null): Turn {
    const childLog = this.log.child({ agent, turnId });
    const turn = new Turn(turnId, agent, channelId, this.store, childLog, this);
    // Phase 115 Plan 05 T04 — register so `recordLazyRecallCall` can fold
    // the increment in directly. Unregistration happens at Turn.end().
    this.registerActiveTurn(agent, turn);
    return turn;
  }

  /**
   * Phase 115 Plan 05 T03 — record a tier-1 truncation event (D-05 trigger).
   *
   * Called from session-config.ts when MEMORY.md exceeds
   * INJECTED_MEMORY_MAX_CHARS at assembly time and the head-tail
   * truncation fires. Persists into the `tier1_truncation_events` table
   * for the dream-cron 2-in-24h priority-pass trigger.
   *
   * Failure-isolated — observability never blocks the parent path.
   * Errors are logged at warn level but never propagated.
   */
  recordTier1TruncationEvent(agent: string, droppedChars = 0): void {
    try {
      this.store.recordTier1TruncationEvent(agent, droppedChars);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      this.log.warn(
        { agent, droppedChars, err: msg, action: "tier1-truncation-record-failed" },
        "[trace] recordTier1TruncationEvent failed (non-fatal)",
      );
    }
  }

  /**
   * Phase 115 Plan 05 T03 — count tier-1 truncation events in a window.
   *
   * Used by dream-cron's `shouldFirePriorityPass` to compute the 2-in-24h
   * trigger condition. Returns 0 on error (fail-safe — never block dream
   * scheduling on observability failures).
   */
  countTruncationEventsSince(agent: string, sinceMs: number): number {
    try {
      return this.store.countTier1TruncationEventsSince(agent, sinceMs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      this.log.warn(
        { agent, sinceMs, err: msg, action: "tier1-truncation-count-failed" },
        "[trace] countTier1TruncationEventsSince failed (non-fatal); returning 0",
      );
      return 0;
    }
  }

  /**
   * Phase 115 Plan 05 T04 — record one lazy-recall tool invocation.
   *
   * Per CONTEXT.md sub-scope 7, the four lazy-load tools (`clawcode_memory_search`,
   * `_recall`, `_edit`, `_archive`) are the agent-facing surface that converts
   * the model from "always-injected memory" to "tool-mediated lazy recall."
   * This method increments the per-agent call counter the dashboard surfaces
   * (column `lazy_recall_call_count` in traces.db, slot opened by 115-00-T02).
   *
   * Per-turn association: when a Turn is active for `agent`, the increment
   * folds into the active turn buffer and lands in the `lazy_recall_call_count`
   * column at turn-end. When NO active turn exists (e.g. the tool fired
   * outside a Discord turn loop — heartbeat-driven, daemon-initiated probes),
   * a per-agent rolling counter accumulates and gets attached to the next
   * turn that ends for the agent.
   *
   * Failure-isolated — a counter failure NEVER blocks the tool path. Errors
   * are logged at warn level and dropped.
   *
   * @param agent — agent whose lazy-recall counter should be incremented
   * @param tool  — tool name for the structured log line
   *                ('clawcode_memory_search' | 'clawcode_memory_recall' |
   *                'clawcode_memory_edit' | 'clawcode_memory_archive')
   */
  recordLazyRecallCall(agent: string, tool: string): void {
    try {
      // Try the active-turn registry first.
      const turn = this.activeTurns.get(agent);
      if (turn !== undefined) {
        turn.bumpLazyRecallCount(tool);
        return;
      }
      // No active turn — bump the per-agent rolling counter that the next
      // ended turn will pick up.
      const rolling = this.pendingLazyRecallByAgent.get(agent) ?? 0;
      this.pendingLazyRecallByAgent.set(agent, rolling + 1);

      // Best-effort structured trace line so operators can grep
      // `lazy_recall_call agent=X tool=Y` in journalctl. Never throws.
      this.log.debug(
        { agent, tool, action: "lazy-recall-call" },
        "[trace] lazy_recall_call_count incremented (no-active-turn rolling)",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      this.log.warn(
        { agent, tool, err: msg, action: "lazy-recall-record-failed" },
        "[trace] recordLazyRecallCall failed (non-fatal)",
      );
    }
  }

  /**
   * Phase 999.63 Plan 02 T-01 — read the active Turn's accumulated tool-call
   * names for `agent`. Returns `[]` when no Turn is currently active for the
   * agent (boot race, test scenario, or the turn already ended).
   *
   * Consumer: the `recentToolCallNames` DI closure wired in daemon.ts feeds
   * `TurnDispatcher.firePostTurnDetectors` — Phase 96's `detectMissedUpload`
   * AND Plan 03's financial-verification gate ("did this turn call a
   * verification tool?").
   *
   * Failure-isolated — consistent with `countTruncationEventsSince` and the
   * other collector accessors: any error returns `[]` rather than throwing
   * into the post-turn detector path.
   */
  /** 2026-08-27 — provenance text for the active turn; "" when none/failed. */
  getActiveTurnToolResultText(agent: string): string {
    try {
      const turn = this.activeTurns.get(agent);
      return turn ? turn.getToolResultText() : "";
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      this.log.warn(
        { agent, err: msg, action: "active-turn-tool-result-text-failed" },
        "[trace] getActiveTurnToolResultText failed (non-fatal); returning empty",
      );
      return "";
    }
  }

  getActiveTurnToolCallNames(agent: string): readonly string[] {
    try {
      const turn = this.activeTurns.get(agent);
      return turn ? turn.getToolCallNames() : [];
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      this.log.warn(
        { agent, err: msg, action: "active-turn-tool-names-failed" },
        "[trace] getActiveTurnToolCallNames failed (non-fatal); returning []",
      );
      return [];
    }
  }

  /**
   * Phase 115 Plan 05 T04 — drain the per-agent rolling lazy-recall counter
   * accumulated since the last turn end. Returns the count and clears the
   * slot. Called from Turn.end() so the column reflects every recorded
   * call. Tests rely on this to assert the counter is correctly attributed.
   */
  drainPendingLazyRecallCount(agent: string): number {
    const n = this.pendingLazyRecallByAgent.get(agent) ?? 0;
    if (n > 0) this.pendingLazyRecallByAgent.delete(agent);
    return n;
  }

  /**
   * Phase 115 Plan 05 T04 — register an active Turn so `recordLazyRecallCall`
   * can fold the increment in directly. Called from Turn constructor; the
   * Turn unregisters on `end()`.
   *
   * Stored as a single-Turn-per-agent slot. ClawCode runs at most one Turn
   * per agent at a time (Phase 50 invariant); concurrent Turns per agent
   * are not supported.
   */
  registerActiveTurn(agent: string, turn: Turn): void {
    this.activeTurns.set(agent, turn);
  }

  /** 2026-08-27 — last turn's READ-class evidence per agent (lookback). */
  private readonly lastReadEvidence = new Map<
    string,
    { readonly at: number; readonly entries: readonly EvidenceEntry[] }
  >();

  /**
   * 2026-08-27 — evidence for the active turn, plus the previous turn's
   * read/document/queried entries (flagged `stale`) when they are younger
   * than EVIDENCE_LOOKBACK_MS. "" turn → lookback only; nothing → [].
   */
  getActiveTurnEvidence(agent: string, now: number = Date.now()): readonly EvidenceEntry[] {
    try {
      // 2026-08-28 — an ended-within-TTL turn still counts as CURRENT (not
      // stale): the self-owned re-dispatch path used to ship zero Sources.
      const turn = this.resolveTurn(agent, now);
      const current = turn ? turn.getEvidence() : [];
      const keys = new Set(current.map(evidenceKey));
      const back = this.lastReadEvidence.get(agent);
      const carried: EvidenceEntry[] = [];
      if (back && now - back.at <= EVIDENCE_LOOKBACK_MS) {
        for (const e of back.entries) {
          const k = evidenceKey(e);
          if (keys.has(k)) continue;
          keys.add(k);
          carried.push({ ...e, stale: true });
        }
      }
      return Object.freeze([...current, ...carried]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      this.log.warn(
        { agent, err: msg, action: "active-turn-evidence-failed" },
        "[trace] getActiveTurnEvidence failed (non-fatal); returning []",
      );
      return [];
    }
  }

  /** 2026-08-27 — claims for the active turn; [] when none. */
  getActiveTurnClaims(agent: string): readonly ClaimEntry[] {
    try {
      const turn = this.resolveTurn(agent);
      return turn ? turn.getClaims() : [];
    } catch {
      return [];
    }
  }

  /**
   * 2026-08-27 — record a verify_claim call for the agent's ACTIVE turn.
   * Null when the agent has no active turn (the IPC arm reports that back).
   */
  recordClaimForActiveTurn(
    agent: string,
    params: VerifyClaimParams,
    opts?: ValidateClaimOptions,
  ): ClaimEntry | null {
    try {
      const turn = this.resolveTurn(agent);
      return turn ? turn.recordClaim(params, opts) : null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      this.log.warn({ agent, err: msg, action: "record-claim-failed" }, "[trace] recordClaimForActiveTurn failed (non-fatal)");
      return null;
    }
  }

  unregisterActiveTurn(agent: string, turn: Turn): void {
    // 2026-08-27 — stash this turn's opened sources for the next turn's
    // lookback (read/document/queried only; search hits are not "consulted").
    try {
      const read = turn.getEvidence().filter((e) => e.kind !== "found" && !e.stale);
      if (read.length > 0) this.lastReadEvidence.set(agent, { at: Date.now(), entries: read });
    } catch {
      // Observational only.
    }
    if (this.activeTurns.get(agent) === turn) {
      this.activeTurns.delete(agent);
      this.lastEndedTurn.set(agent, { at: Date.now(), turn });
    }
  }

  // Phase 115 Plan 05 T04 — per-agent rolling lazy-recall counter for tool
  // calls that fire OUTSIDE an active Turn (heartbeat probes, daemon-driven
  // memory operations, etc.). Drained into the next Turn that ends for
  // the agent.
  private readonly pendingLazyRecallByAgent = new Map<string, number>();

  // Phase 115 Plan 05 T04 — per-agent active-Turn registry. Single slot
  // per agent (Phase 50 invariant: at most one Turn per agent at a time).
  private readonly activeTurns = new Map<string, Turn>();
  /** 2026-08-28 — the last ended Turn per agent (replaced per turn, never unioned). */
  private readonly lastEndedTurn = new Map<string, { readonly at: number; readonly turn: Turn }>();

  /** Active turn, else the turn that ended within CLAIMS_LOOKBACK_MS. */
  private resolveTurn(agent: string, now: number = Date.now()): Turn | undefined {
    const active = this.activeTurns.get(agent);
    if (active) return active;
    const ended = this.lastEndedTurn.get(agent);
    if (ended && now - ended.at <= CLAIMS_LOOKBACK_MS) return ended.turn;
    return undefined;
  }

  /**
   * Phase 115 Plan 07 T03 — record one tool-cache HIT.
   *
   * Increments the per-agent hit counter that the dashboard divides by
   * (hit + miss) to compute `tool_cache_hit_rate`. Mirrors the
   * `recordLazyRecallCall` pattern (rolling counter + structured debug
   * log line) — this is best-effort observability, never on the dispatch
   * critical path.
   *
   * Per-turn association is via the active-Turn registry; calls outside
   * any turn (e.g., heartbeat-driven tool probes) bump a per-agent
   * rolling counter that the next ended turn picks up.
   *
   * Failure-isolated. Errors logged at warn level, never thrown.
   */
  recordToolCacheHit(agent: string, tool: string): void {
    try {
      const turn = this.activeTurns.get(agent);
      if (turn !== undefined) {
        turn.bumpToolCacheHit(tool);
        return;
      }
      const rolling = this.pendingToolCacheHitsByAgent.get(agent) ?? 0;
      this.pendingToolCacheHitsByAgent.set(agent, rolling + 1);
      this.log.debug(
        { agent, tool, action: "tool-cache-hit-rolling" },
        "[trace] tool_cache_hit incremented (no-active-turn rolling)",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      this.log.warn(
        { agent, tool, err: msg, action: "tool-cache-hit-record-failed" },
        "[trace] recordToolCacheHit failed (non-fatal)",
      );
    }
  }

  /**
   * Phase 115 Plan 07 T03 — record one tool-cache MISS.
   *
   * Same flow as `recordToolCacheHit` but for the miss counter. The
   * dashboard computes `tool_cache_hit_rate = hits / (hits + misses)`
   * over a sliding window — both producers required.
   */
  recordToolCacheMiss(agent: string, tool: string): void {
    try {
      const turn = this.activeTurns.get(agent);
      if (turn !== undefined) {
        turn.bumpToolCacheMiss(tool);
        return;
      }
      const rolling = this.pendingToolCacheMissesByAgent.get(agent) ?? 0;
      this.pendingToolCacheMissesByAgent.set(agent, rolling + 1);
      this.log.debug(
        { agent, tool, action: "tool-cache-miss-rolling" },
        "[trace] tool_cache_miss incremented (no-active-turn rolling)",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      this.log.warn(
        { agent, tool, err: msg, action: "tool-cache-miss-record-failed" },
        "[trace] recordToolCacheMiss failed (non-fatal)",
      );
    }
  }

  /**
   * Phase 115 Plan 07 T03 — drain rolling tool-cache hit / miss counters
   * for the agent. Called from Turn.end() so out-of-turn cache events
   * land on the next ended turn. Returns { hits, misses } and clears
   * both slots.
   */
  drainPendingToolCacheCounters(
    agent: string,
  ): { readonly hits: number; readonly misses: number } {
    const hits = this.pendingToolCacheHitsByAgent.get(agent) ?? 0;
    const misses = this.pendingToolCacheMissesByAgent.get(agent) ?? 0;
    if (hits > 0) this.pendingToolCacheHitsByAgent.delete(agent);
    if (misses > 0) this.pendingToolCacheMissesByAgent.delete(agent);
    return { hits, misses };
  }


  // Phase 115 Plan 07 T03 — per-agent rolling tool-cache hit / miss counters
  // for tool calls firing OUTSIDE an active Turn (heartbeat / daemon-driven
  // probes). Drained into the next Turn that ends for the agent.
  private readonly pendingToolCacheHitsByAgent = new Map<string, number>();
  private readonly pendingToolCacheMissesByAgent = new Map<string, number>();

  /**
   * Phase 115 post-deploy patch (2026-05-08) — record bounded-tier
   * injection size for the agent's currently-active Turn. Mirrors
   * `recordLazyRecallCall`'s active-turn pattern but does NOT use
   * a rolling counter — Tier 1 size is a per-assembly snapshot, not
   * a per-event count.
   *
   * Behavior:
   *   - Active Turn for `agent` exists → fold into Turn.bumpTier1Size.
   *   - No active Turn → debug log, drop. The dashboard reads the
   *     most-recent non-NULL row via ORDER BY started_at DESC LIMIT 1
   *     (getPhase115DashboardMetrics line 674-680), so missing one
   *     bootstrap turn worth of data has no operator-facing impact —
   *     the next session-restart will populate.
   *
   * Failure-isolated. Errors logged at warn level, never thrown.
   */
  recordTier1Size(agent: string, injectChars: number, capChars: number): void {
    try {
      const turn = this.activeTurns.get(agent);
      if (turn !== undefined) {
        turn.bumpTier1Size(injectChars, capChars);
        return;
      }
      this.log.debug(
        { agent, injectChars, capChars, action: "tier1-size-no-active-turn" },
        "[trace] recordTier1Size called with no active turn — dropped",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      this.log.warn(
        { agent, injectChars, capChars, err: msg, action: "tier1-size-record-failed" },
        "[trace] recordTier1Size failed (non-fatal)",
      );
    }
  }

  /**
   * Phase 115 post-deploy patch (2026-05-08) — record one
   * `[diag] likely-prompt-bloat` warning for the given agent. Called
   * by the classifier sink at session-manager.ts:2392-2406. The sink
   * already duck-types this method onto the TraceCollector — adding
   * it here closes the schema-without-writer gap.
   *
   * Method NAME is `incrementPromptBloatWarning` to match the
   * `PromptBloatTraceSink` interface declared at
   * session-adapter.ts:196-204; renaming would force a session-adapter
   * edit which the sink contract was specifically designed to avoid.
   *
   * Mirrors `recordLazyRecallCall`'s active-turn + rolling-counter
   * pattern: when the classifier fires outside an active turn (rare
   * but possible — onError hooks may run after turn.end committed
   * for the same Discord message id), the increment lands in a
   * per-agent rolling counter that the next ended turn drains.
   *
   * Failure-isolated. Errors logged at warn, never thrown.
   */
  incrementPromptBloatWarning(agent: string): void {
    try {
      const turn = this.activeTurns.get(agent);
      if (turn !== undefined) {
        turn.bumpPromptBloatWarning();
        return;
      }
      const rolling = this.pendingPromptBloatWarningsByAgent.get(agent) ?? 0;
      this.pendingPromptBloatWarningsByAgent.set(agent, rolling + 1);
      this.log.debug(
        { agent, action: "prompt-bloat-warning-rolling" },
        "[trace] prompt_bloat_warning incremented (no-active-turn rolling)",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      this.log.warn(
        { agent, err: msg, action: "prompt-bloat-warning-record-failed" },
        "[trace] incrementPromptBloatWarning failed (non-fatal)",
      );
    }
  }

  /**
   * Phase 115 post-deploy patch (2026-05-08) — drain rolling
   * prompt-bloat counter for the agent. Called from Turn.end() so
   * out-of-turn classifier fires land on the next ended turn.
   * Returns the count and clears the slot.
   */
  drainPendingPromptBloatWarnings(agent: string): number {
    const n = this.pendingPromptBloatWarningsByAgent.get(agent) ?? 0;
    if (n > 0) this.pendingPromptBloatWarningsByAgent.delete(agent);
    return n;
  }

  // Phase 115 post-deploy patch (2026-05-08) — per-agent rolling
  // prompt-bloat warning counter for classifier fires that hit
  // OUTSIDE an active Turn. Drained into the next Turn that ends.
  private readonly pendingPromptBloatWarningsByAgent = new Map<string, number>();
}

/**
 * Turn — in-memory span buffer for a single message → reply cycle.
 *
 * Public identity fields (`id`, `agent`, `channelId`) are exposed so tests
 * and diagnostic logging can correlate spans to their parent turn without
 * wrapping the field access in a method.
 */
export class Turn {
  /** Discord message id (or prefixed nanoid for non-Discord turns). */
  public readonly id: string;
  public readonly agent: string;
  public readonly channelId: string | null;

  private readonly store: TraceStore;
  private readonly log: Logger;

  private readonly spans: SpanRecord[] = [];
  private readonly startedAtMs: number;
  private committed = false;
  /**
   * Phase 52 Plan 01: buffered cache-telemetry snapshot attached at `end()`.
   * Undefined when the SDK `result` message did not carry usage fields (or
   * when the session-adapter was not threaded with this Turn).
   */
  private cacheSnapshot: CacheTelemetrySnapshot | undefined = undefined;
  /**
   * Phase 57 Plan 02: buffered TurnOrigin blob attached via `recordOrigin`.
   * Undefined when the caller did not go through TurnDispatcher (Phase 50/51/52
   * legacy path — bench harness, some heartbeat checks). Spread into the
   * frozen TurnRecord at `end()` time (no extra transaction).
   */
  private turnOrigin: TurnOrigin | undefined = undefined;
  /**
   * Phase 55 Plan 02 — per-turn idempotent tool-result cache. Lazy-allocated
   * on first access; the `toolCache` getter constructs the ToolCache only
   * when a whitelisted tool handler first queries it. Most turns that never
   * issue a duplicate whitelisted tool call never allocate a Map.
   *
   * LIFETIME: the cache Map is unreachable once this Turn goes out of scope
   * (GC drops it). Explicit cleanup is theatrical — we do NOT clear the
   * field at `end()` because the Turn itself is the GC root.
   */
  private _toolCache: ToolCache | undefined = undefined;
  /**
   * Phase 115 Plan 05 T04 — per-turn lazy-recall call counter. Incremented
   * by `bumpLazyRecallCount` from the four `clawcode_memory_*` IPC handlers
   * in daemon.ts. Drained into the `lazyRecallCallCount` column in
   * traces.db at `end()` time.
   */
  private lazyRecallCallCount = 0;
  /**
   * Phase 999.63 Plan 02 T-01 — per-turn tool-call name accumulator. Appended
   * by `recordToolCallName` from the single `tool_call.<name>` span-open site
   * in session-adapter.ts (one push per tool-use block). Read live via
   * `getToolCallNames` / `TraceCollector.getActiveTurnToolCallNames`.
   *
   * Consumer: Plan 03's financial-verification gate ("did this turn call a
   * verification tool?"). In-memory-only — NOT persisted to a SQLite column
   * this phase; the list is freed when the Turn is GC'd. Duplicate names are
   * kept (multiplicity mirrors the span-per-call reality).
   */
  private readonly toolCallNames: string[] = [];
  /**
   * 2026-08-27 — per-turn TOOL RESULT text accumulator (figures-class
   * provenance). The financial-verification gate used to know only tool
   * NAMES, so a figure the agent read off the client's own statement in
   * the same turn was treated as "unverified" and re-prompted — the bulk
   * of 40 false re-prompts/day on fin-client. Bounded (8 KB per
   * result, 96 KB per turn) and in-memory only; never persisted.
   */
  private readonly toolResultTexts: string[] = [];
  private toolResultChars = 0;
  /**
   * 2026-08-27 — per-turn EVIDENCE ledger: every source the turn consulted,
   * derived from tool events (see evidence-ledger.ts). In-memory only;
   * deduped by (kind, target); capped.
   */
  private readonly evidence: EvidenceEntry[] = [];
  private readonly evidenceKeys = new Set<string>();
  /** 2026-08-27 — per-turn CLAIM ledger (verify_claim records, validated). */
  private readonly claims: ClaimEntry[] = [];
  /**
   * Phase 115 Plan 07 T03 — per-turn tool-cache hit / miss counters.
   * Incremented by `bumpToolCacheHit` / `bumpToolCacheMiss` from the
   * `dispatchTool` cache wrapper. Drained into `tool_cache_hit_rate`
   * column in traces.db at `end()` time as `hits / (hits + misses)`.
   * Turns with zero cache-eligible tool calls land NULL in the column.
   */
  private toolCacheHits = 0;
  private toolCacheMisses = 0;
  /**
   * Phase 115 Plan 08 T01 — per-turn tool-latency split-metric accumulators
   * (sub-scope 17a/b).
   *
   * - toolExecutionMs: sum of pure-execution durations from each
   *   `tool_call.<name>` span (tool_use_emitted → tool_result_arrived).
   *   Producer is the existing span lifecycle in session-adapter.ts:1419-1514;
   *   the addToolExecutionMs helper folds each span's duration in.
   * - toolRoundtripMs: sum of per-batch wall-clock durations
   *   (tool_use_emitted → next parent assistant message arrived). Producer
   *   is session-adapter.ts iterateWithTracing — open at first tool_use of
   *   a parent assistant message, close on next parent assistant message.
   * - parallelToolCallCount: MAX(tool_use blocks across any single parent
   *   assistant message in the turn). Producer is session-adapter.ts'
   *   per-message `toolUseCount` scan at line ~1399-1402.
   *
   * All three remain at sentinel values (0 for sums, 0 for max) when no
   * tool_use blocks fired in the turn. Turn.end() converts the sentinel
   * to NULL in the persisted record (so dashboard percentile queries can
   * distinguish "no tool calls this turn" from "0ms execution").
   */
  private toolExecutionMs = 0;
  private toolRoundtripMs = 0;
  private parallelToolCallCount = 0;
  /**
   * Phase 115 post-deploy patch (2026-05-08) — per-turn bounded-tier
   * injection size accumulator (sub-scope 1). Set by `bumpTier1Size`
   * after the assembler's `enforceDropLowestImportance` enforcement
   * fires on the identity section. NULL means "not measured this turn"
   * (most per-message turns; only bootstrap turns measure). When set,
   * the column reflects the actual rendered char count of the carved
   * identity block; `tier1BudgetPct` is the ratio over
   * INJECTED_MEMORY_MAX_CHARS. Distinguishing NULL from 0 matters —
   * 0 would be a bug signal, NULL is "out of scope this turn".
   */
  private tier1InjectChars: number | null = null;
  private tier1BudgetPct: number | null = null;
  /**
   * Phase 115 post-deploy patch (2026-05-08) — per-turn prompt-bloat
   * warning counter (sub-scope 13). Incremented by
   * `bumpPromptBloatWarning`, which is called from the
   * `classifyPromptBloat` sink at session-manager.ts:2392-2406 each
   * time the classifier emits a `[diag] likely-prompt-bloat` log.
   * Drained into `promptBloatWarnings24h` at `end()` — the column
   * name carries the 24h window because the dashboard SUM-aggregates
   * over a rolling 24h window; the per-turn writer just records the
   * per-turn delta.
   */
  private promptBloatWarnings = 0;
  /**
   * Phase 115 Plan 05 T04 — back-reference to the parent collector so the
   * Turn can pull rolling lazy-recall counts from outside-of-turn calls
   * at `end()` time. Optional so legacy bench-harness Turns (instantiated
   * directly) keep working.
   */
  private readonly collector: TraceCollector | undefined;

  constructor(
    id: string,
    agent: string,
    channelId: string | null,
    store: TraceStore,
    log: Logger,
    collector?: TraceCollector,
  ) {
    this.id = id;
    this.agent = agent;
    this.channelId = channelId;
    this.store = store;
    this.log = log;
    this.startedAtMs = Date.now();
    this.collector = collector;
  }

  /**
   * Phase 115 Plan 05 T04 — record one lazy-recall tool call within this
   * turn. Folded into the `lazyRecallCallCount` column at `end()`. No-op
   * after `end()` (post-commit).
   *
   * `tool` is the tool name (e.g. 'clawcode_memory_search'). It only
   * appears in the structured debug log line — the persisted column is
   * an aggregate count, not a per-tool histogram (sub-scope 7 dashboard
   * only needs the rate, not the breakdown — Plan 115-09 closeout).
   */
  bumpLazyRecallCount(tool: string): void {
    if (this.committed) return;
    this.lazyRecallCallCount += 1;
    this.log.debug(
      {
        agent: this.agent,
        turnId: this.id,
        tool,
        count: this.lazyRecallCallCount,
        action: "lazy-recall-call",
      },
      "[trace] lazy_recall_call_count incremented",
    );
  }

  /**
   * Phase 999.63 Plan 02 T-01 — record one tool-call name within this turn.
   * Appended to the in-memory `toolCallNames` accumulator. No-op after
   * `end()` (post-commit) — identical discipline to `bumpLazyRecallCount`.
   *
   * Fed from the single `tool_call.<name>` span-open site in
   * session-adapter.ts (one call per tool-use block). Duplicate names ARE
   * kept — the gate only needs membership, but multiplicity matches the
   * span-per-call reality and costs nothing.
   */
  recordToolCallName(name: string): void {
    if (this.committed) return;
    this.toolCallNames.push(name);
    this.log.debug(
      {
        agent: this.agent,
        turnId: this.id,
        tool: name,
        count: this.toolCallNames.length,
        action: "tool-call-name-recorded",
      },
      "[trace] tool-call name recorded",
    );
  }

  /**
   * Phase 999.63 Plan 02 T-01 — return a defensive (frozen) copy of the
   * tool-call names accumulated this turn, in call order. Returns `[]` for a
   * turn that called no tools. Read via
   * `TraceCollector.getActiveTurnToolCallNames` by the daemon's
   * `recentToolCallNames` DI closure.
   */
  getToolCallNames(): readonly string[] {
    return Object.freeze([...this.toolCallNames]);
  }

  /** 2026-08-27 — see `toolResultTexts`. Silently drops past the caps. */
  recordToolResultText(text: string): void {
    if (this.committed) return;
    if (typeof text !== "string" || text.length === 0) return;
    const slice = text.slice(0, TOOL_RESULT_TEXT_MAX_PER_RESULT);
    if (this.toolResultChars + slice.length > TOOL_RESULT_TEXT_MAX_PER_TURN) return;
    this.toolResultTexts.push(slice);
    this.toolResultChars += slice.length;
  }

  /** 2026-08-27 — joined tool-result text for this turn ("" when none). */
  getToolResultText(): string {
    return this.toolResultTexts.join("\n");
  }

  /** 2026-08-27 — record one consulted source. Dedupes; caps; no-op after end(). */
  recordEvidence(entry: EvidenceEntry): void {
    if (this.committed) return;
    if (!entry || typeof entry !== "object") return;
    if (this.evidence.length >= EVIDENCE_MAX_PER_TURN) return;
    const key = evidenceKey(entry);
    if (this.evidenceKeys.has(key)) return;
    this.evidenceKeys.add(key);
    this.evidence.push(entry);
  }

  /** 2026-08-27 — seed a hop turn with its parent's evidence. */
  seedEvidence(entries: readonly EvidenceEntry[]): void {
    for (const e of entries) this.recordEvidence(e);
  }

  /** 2026-08-27 — frozen snapshot of this turn's evidence. */
  getEvidence(): readonly EvidenceEntry[] {
    return Object.freeze([...this.evidence]);
  }

  /**
   * 2026-08-27 — validate + record one verify_claim call against THIS turn's
   * evidence and tool text. Returns null when over cap or after end().
   */
  recordClaim(params: VerifyClaimParams, opts?: ValidateClaimOptions): ClaimEntry | null {
    // 2026-08-28 — claims are NOT part of the committed TurnRecord, so a
    // post-hoc hop may still record against this turn's evidence after end().
    if (this.claims.length >= CLAIMS_MAX_PER_TURN) return null;
    const validated = validateClaim(params, this.evidence, this.getToolResultText(), opts);
    if (validated.claim.length === 0) return null;
    const entry: ClaimEntry = {
      ...validated,
      id: `c${this.claims.length + 1}`,
      turnId: this.id,
      at: Date.now(),
    };
    this.claims.push(entry);
    return entry;
  }

  /** 2026-08-27 — frozen snapshot of this turn's claims. */
  getClaims(): readonly ClaimEntry[] {
    return Object.freeze([...this.claims]);
  }

  /**
   * 2026-07-31 adaptive verify budget — wall-clock milliseconds since the
   * turn opened. Read-only; safe to call before `end()` (and after — the
   * value simply keeps growing, callers snapshot it at the dispatch
   * epilogue). Wall-time is the verifier's primary heaviness signal: no
   * output-token count exists on the Turn, and tool time is a subset of
   * wall time.
   */
  getElapsedMs(): number {
    return Date.now() - this.startedAtMs;
  }

  /**
   * 2026-07-31 adaptive verify budget — the pure tool-execution time
   * accumulated so far this turn (the `toolExecutionMs` fold). Read-only
   * telemetry rider alongside `getElapsedMs`.
   */
  getToolExecutionMsSoFar(): number {
    return this.toolExecutionMs;
  }

  /**
   * Phase 115 post-deploy patch (2026-05-08) — record the bounded-tier
   * (Tier 1) injection size for this turn. Called from
   * `assembleContextTraced` immediately after the identity assembly
   * runs, with `injectChars` = rendered identity char count and
   * `capChars` = `INJECTED_MEMORY_MAX_CHARS` (16K). The ratio lands
   * in `tier1BudgetPct` (clamped to [0, 1] for sane downstream math —
   * the column type is REAL and dashboard renders as percentage).
   *
   * Last-write-wins on repeat calls within the same turn (the
   * assembler runs once per bootstrap; this guards against accidental
   * multi-write when a future caller wires per-turn re-assembly).
   * No-op after `end()` (post-commit).
   *
   * `capChars` of 0 short-circuits to NULL (defensive — avoids
   * div-by-zero; should never happen in production where the constant
   * is 16_000).
   */
  bumpTier1Size(injectChars: number, capChars: number): void {
    if (this.committed) return;
    if (capChars <= 0) return;
    if (injectChars < 0) return;
    this.tier1InjectChars = injectChars;
    // Ratio in [0, 1]. The dashboard subtitle renderer multiplies by 100
    // for the % display and applies the 90%-budget warning threshold.
    this.tier1BudgetPct = injectChars / capChars;
    this.log.debug(
      {
        agent: this.agent,
        turnId: this.id,
        injectChars,
        capChars,
        budgetPct: this.tier1BudgetPct,
        action: "tier1-size-recorded",
      },
      "[trace] tier1_inject_chars + tier1_budget_pct recorded",
    );
  }

  /**
   * Phase 115 post-deploy patch (2026-05-08) — record one
   * `[diag] likely-prompt-bloat` event for this turn. Called from
   * the `classifyPromptBloat` trace-sink at session-manager.ts when
   * the classifier fires (invalid_request_error + stable prefix
   * exceeds PROMPT_BLOAT_THRESHOLD = 20K chars). Folded into
   * `promptBloatWarnings24h` column at `end()`; the dashboard
   * SUM-aggregates across a rolling 24h window per agent.
   *
   * No-op after `end()` (post-commit). Prompt-bloat events typically
   * fire during error handling on a turn that's about to crash —
   * the classifier runs FIRST (session-manager.ts:2386) so the
   * counter increment happens before turn.end("error") commits.
   */
  bumpPromptBloatWarning(): void {
    if (this.committed) return;
    this.promptBloatWarnings += 1;
    this.log.debug(
      {
        agent: this.agent,
        turnId: this.id,
        count: this.promptBloatWarnings,
        action: "prompt-bloat-warning",
      },
      "[trace] prompt_bloat_warnings_24h incremented",
    );
  }

  /**
   * Phase 115 Plan 07 T03 — record one tool-cache HIT within this turn.
   * Folded into `tool_cache_hit_rate` at `end()`. No-op after `end()`.
   *
   * `tool` only appears in the structured debug log — the persisted
   * column is an aggregate rate, not a per-tool histogram (Plan 115-09
   * dashboard renders the rate, not the breakdown).
   */
  bumpToolCacheHit(tool: string): void {
    if (this.committed) return;
    this.toolCacheHits += 1;
    this.log.debug(
      {
        agent: this.agent,
        turnId: this.id,
        tool,
        hits: this.toolCacheHits,
        action: "tool-cache-hit",
      },
      "[trace] tool_cache_hit incremented",
    );
  }

  /**
   * Phase 115 Plan 07 T03 — record one tool-cache MISS within this turn.
   * Folded into `tool_cache_hit_rate` at `end()`. No-op after `end()`.
   */
  bumpToolCacheMiss(tool: string): void {
    if (this.committed) return;
    this.toolCacheMisses += 1;
    this.log.debug(
      {
        agent: this.agent,
        turnId: this.id,
        tool,
        misses: this.toolCacheMisses,
        action: "tool-cache-miss",
      },
      "[trace] tool_cache_miss incremented",
    );
  }

  /**
   * Phase 115 Plan 08 T01 — fold one tool_call.<name> span's pure-execution
   * duration into the per-turn `tool_execution_ms` accumulator. Called
   * from session-adapter.ts at the same point the existing span ends
   * (matching `parent_tool_use_id` user message arrives). Sums across
   * every tool span in the turn.
   *
   * No-op after `end()` (post-commit).
   */
  addToolExecutionMs(durationMs: number): void {
    if (this.committed) return;
    if (durationMs > 0) this.toolExecutionMs += durationMs;
  }

  /**
   * Phase 115 Plan 08 T01 — fold one batch-roundtrip duration into the
   * per-turn `tool_roundtrip_ms` accumulator. A batch-roundtrip opens
   * when the first tool_use block appears in a parent assistant message
   * and closes when the NEXT parent assistant message arrives — capturing
   * the SDK dispatch + actual tool execution + result delivery + LLM
   * resume cost. Per-batch (not per-tool) so parallel batches collapse
   * to a single wall-clock interval.
   *
   * Sums across every batch in the turn (multi-batch turns where the
   * model emits sequential tool_use → tool_result cycles).
   *
   * No-op after `end()` (post-commit).
   */
  addToolRoundtripMs(durationMs: number): void {
    if (this.committed) return;
    if (durationMs > 0) this.toolRoundtripMs += durationMs;
  }

  /**
   * Phase 115 Plan 08 T01 — record the parallel tool-use batch size for
   * one parent assistant message. The persisted column is the MAX
   * batch size observed in any one message during this turn:
   * sequential-only turns land 1; turns with at least one N-block
   * parallel batch land N. Subsumes the `> 0` "had any tool" check used
   * by Plan 08 T02's `tool_use_rate_per_turn` computation while
   * preserving the sub-scope 17(b) parallel-vs-serial signal.
   *
   * Producer is session-adapter.ts iterateWithTracing — at the
   * per-message tool_use scan (~line 1399-1402), it already counts
   * `toolUseCount`; this method records that count.
   *
   * No-op after `end()` (post-commit).
   */
  recordParallelToolCallCount(batchSize: number): void {
    if (this.committed) return;
    if (batchSize > this.parallelToolCallCount) {
      this.parallelToolCallCount = batchSize;
    }
  }

  /**
   * Open a new span for the given phase. Metadata is captured by value
   * (shallow-copied + frozen) on `span.end()`.
   */
  startSpan(name: string, metadata: Record<string, unknown> = {}): Span {
    const startedAtMs = Date.now();
    return new Span(name, startedAtMs, metadata, (record) => {
      if (this.committed) return;
      this.spans.push(record);
    });
  }

  /**
   * Phase 55 Plan 02 — lazy-init per-turn tool-result cache.
   *
   * Only constructed on first access so turns that never trigger a duplicate
   * whitelisted tool call never allocate a Map. Subsequent reads return
   * the same instance (stable identity for the lifetime of this Turn).
   *
   * The returned cache is the Turn's property — it is automatically GC'd
   * when the Turn goes out of scope. Do NOT share this instance across
   * Turns (doing so would violate the strictly-per-turn scope invariant
   * that makes cross-turn leaks impossible by construction).
   */
  get toolCache(): ToolCache {
    if (!this._toolCache) this._toolCache = new ToolCache();
    return this._toolCache;
  }

  /**
   * Phase 52 Plan 01: record the SDK result-message usage fields on this Turn.
   *
   * Called by `SdkSessionAdapter.iterateWithTracing` on the `result` message,
   * BEFORE the parent Turn is `end()`ed. The snapshot is buffered in-memory
   * and spread into the TurnRecord at `end()` — no extra transaction.
   *
   * Idempotent: a second call overwrites the first. Calling after `end()`
   * is a no-op (parent already committed).
   *
   * SECURITY: snapshot carries only token counts + sha256 `prefixHash`.
   * NEVER prompt bodies or message contents.
   */
  recordCacheUsage(snapshot: CacheTelemetrySnapshot): void {
    if (this.committed) return;
    this.cacheSnapshot = snapshot;
  }

  /**
   * Phase 57 Plan 02: attach a TurnOrigin to this turn. Buffered in memory
   * and spread into the frozen TurnRecord at `end()`. Idempotent overwrite
   * semantics — second call replaces the first. Calling after `end()` is a
   * no-op (parent already committed). Mirrors the precedent set by
   * `recordCacheUsage`.
   *
   * Primary caller: TurnDispatcher.dispatch / dispatchStream. Downstream
   * Phase 63 `clawcode trace` walker reads the persisted blob to stitch
   * cross-agent causation chains.
   */
  recordOrigin(origin: TurnOrigin): void {
    if (this.committed) return;
    this.turnOrigin = origin;
  }

  /**
   * Commit the turn: build a frozen TurnRecord from all buffered spans
   * and persist it via TraceStore.writeTurn in one transaction.
   *
   * Subsequent calls are no-ops (idempotent). Write failures are logged
   * at `warn` level — trace writes never fail the parent message path.
   *
   * Phase 52 Plan 01: when a cache-telemetry snapshot was recorded via
   * `recordCacheUsage`, its fields are spread into the frozen TurnRecord.
   * Otherwise the five cache fields are `undefined` (legacy shape).
   *
   * Phase 57 Plan 02: when a TurnOrigin was attached via `recordOrigin`,
   * it is spread into the frozen TurnRecord and persisted as a JSON blob
   * in the `turn_origin` column. Otherwise the field is absent (legacy shape)
   * and the column lands NULL.
   */
  end(status: TurnStatus): void {
    if (this.committed) return;
    this.committed = true;
    const endedAtMs = Date.now();

    // Phase 115 Plan 05 T04 — drain any pending out-of-turn lazy-recall
    // calls accumulated for this agent and add them to the per-turn count.
    let lazyRecallCallCount = this.lazyRecallCallCount;
    // Phase 115 Plan 07 T03 — drain any pending out-of-turn tool-cache
    // hits / misses accumulated for this agent.
    let toolCacheHits = this.toolCacheHits;
    let toolCacheMisses = this.toolCacheMisses;
    // Phase 115 post-deploy patch (2026-05-08) — drain any pending
    // out-of-turn prompt-bloat warnings (classifier fires that hit
    // after a turn already committed but before the next started).
    let promptBloatWarnings = this.promptBloatWarnings;
    if (this.collector) {
      lazyRecallCallCount += this.collector.drainPendingLazyRecallCount(this.agent);
      const drained = this.collector.drainPendingToolCacheCounters(this.agent);
      toolCacheHits += drained.hits;
      toolCacheMisses += drained.misses;
      promptBloatWarnings += this.collector.drainPendingPromptBloatWarnings(this.agent);
      this.collector.unregisterActiveTurn(this.agent, this);
    }
    // Compute hit rate. Only meaningful when at least one cache-eligible
    // tool call happened during this turn (or rolled in from out-of-turn).
    // Otherwise leave it null so the column reflects "no signal" rather
    // than 0% / 100% (which would skew percentile rollups).
    const totalCacheEvents = toolCacheHits + toolCacheMisses;
    const toolCacheHitRate =
      totalCacheEvents > 0 ? toolCacheHits / totalCacheEvents : null;
    // Note — `tool_cache_size_mb` is a fleet-wide signal sourced from
    // ToolCacheStore.sizeMb() and surfaced via the `tool-cache-status`
    // IPC, not a per-turn column. We leave the persisted column NULL on
    // the per-turn write side; the dashboard reads the live size via the
    // IPC handler when the cache panel renders.

    const base = {
      id: this.id,
      agent: this.agent,
      channelId: this.channelId,
      startedAt: new Date(this.startedAtMs).toISOString(),
      endedAt: new Date(endedAtMs).toISOString(),
      totalMs: endedAtMs - this.startedAtMs,
      status,
      spans: Object.freeze([...this.spans]),
    };
    const record: TurnRecord = Object.freeze({
      ...base,
      ...(this.cacheSnapshot
        ? {
            cacheReadInputTokens: this.cacheSnapshot.cacheReadInputTokens,
            cacheCreationInputTokens: this.cacheSnapshot.cacheCreationInputTokens,
            inputTokens: this.cacheSnapshot.inputTokens,
            prefixHash: this.cacheSnapshot.prefixHash,
            cacheEvictionExpected: this.cacheSnapshot.cacheEvictionExpected,
          }
        : {}),
      ...(this.turnOrigin ? { turnOrigin: this.turnOrigin } : {}),
      // Phase 115 Plan 05 T04 — only attach when non-zero so legacy turn
      // shape stays NULL on the column for turns that never invoked a
      // lazy-recall tool. Mirrors the cache-telemetry-snapshot conditional
      // spread above.
      ...(lazyRecallCallCount > 0 ? { lazyRecallCallCount } : {}),
      // Phase 115 Plan 07 T03 — only attach when at least one cache-eligible
      // tool call ran (hit OR miss). Otherwise the column lands NULL so
      // percentile rollups can distinguish "no cache events this turn" from
      // "0% hit rate" (which has signal — implies misses but no hits).
      ...(toolCacheHitRate !== null
        ? {
            toolCacheHitRate,
            toolCacheHitCount: toolCacheHits,
            toolCacheMissCount: toolCacheMisses,
          }
        : {}),
      // Phase 115 Plan 08 T01 — only attach the three split-latency fields
      // when at least one tool_use batch fired this turn (signal: max
      // parallel count > 0). Turns without tool calls land NULL on all
      // three columns so percentile rollups distinguish "no tool calls"
      // from "0ms execution / 0 batch size" (which would be a buggy producer
      // signal). Producer must call recordParallelToolCallCount(>=1) for
      // any turn that fired a tool_use, even sequential single-call turns.
      ...(this.parallelToolCallCount > 0
        ? {
            toolExecutionMs: this.toolExecutionMs,
            toolRoundtripMs: this.toolRoundtripMs,
            parallelToolCallCount: this.parallelToolCallCount,
          }
        : {}),
      // Phase 115 post-deploy patch (2026-05-08) — only attach tier1_*
      // when bumpTier1Size was actually called this turn. NULL means
      // "not measured this turn" (most per-message turns; only bootstrap
      // turns measure). Distinguishing NULL from 0 matters: 0 would be a
      // bug signal (cap divisor of zero shouldn't reach here), NULL
      // is "out of scope". Mirrors the parallelToolCallCount > 0 conditional
      // spread above.
      ...(this.tier1InjectChars !== null
        ? {
            tier1InjectChars: this.tier1InjectChars,
            tier1BudgetPct: this.tier1BudgetPct,
          }
        : {}),
      // Phase 115 post-deploy patch (2026-05-08) — only attach
      // promptBloatWarnings24h when at least one classifier fire happened
      // this turn (or rolled in from out-of-turn). NULL means "no signal
      // this turn" — preserves dashboard SUM aggregator semantics where
      // healthy turns contribute 0 and crash turns contribute the count.
      ...(promptBloatWarnings > 0
        ? { promptBloatWarnings24h: promptBloatWarnings }
        : {}),
    });
    try {
      this.store.writeTurn(record);
      this.log.debug(
        { spanCount: record.spans.length, totalMs: record.totalMs, status },
        "turn traced",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      this.log.warn({ err: msg }, "trace write failed — dropping turn");
    }
  }
}

/**
 * Span — a single timed phase within a Turn.
 *
 * The Span captures the start timestamp at construction time and the
 * duration on `end()` (Date.now() delta). Calling `end()` twice is a
 * no-op so error handlers can safely defer cleanup.
 */
export class Span {
  private readonly name: string;
  private readonly startedAtMs: number;
  private readonly metadata: Record<string, unknown>;
  private readonly onEnd: (record: SpanRecord) => void;
  private ended = false;

  constructor(
    name: string,
    startedAtMs: number,
    metadata: Record<string, unknown>,
    onEnd: (record: SpanRecord) => void,
  ) {
    this.name = name;
    this.startedAtMs = startedAtMs;
    this.metadata = { ...metadata };
    this.onEnd = onEnd;
  }

  /**
   * Phase 53 Plan 02 — merge additional keys into this span's metadata record
   * BEFORE `end()` is called. No-op when the span has already ended (prevents
   * mutation after commit).
   *
   * The merge is shallow — top-level keys overwrite. Intended for small
   * dictionaries like `{ section_tokens }` emitted by the context assembler;
   * callers MUST NOT log full prompt bodies here (SECURITY — see phase
   * critical_constraints).
   */
  setMetadata(extra: Record<string, unknown>): void {
    if (this.ended) return;
    for (const key of Object.keys(extra)) {
      this.metadata[key] = extra[key];
    }
  }

  /** Close the span; duration is captured as `Date.now() - startedAtMs`. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    const durationMs = Date.now() - this.startedAtMs;
    this.onEnd(
      Object.freeze({
        name: this.name,
        startedAt: new Date(this.startedAtMs).toISOString(),
        durationMs,
        metadata: Object.freeze({ ...this.metadata }),
      }),
    );
  }
}
