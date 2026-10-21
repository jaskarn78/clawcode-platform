/**
 * Shared dream-pass machinery — single source of truth for the per-agent
 * `runDreamPass` / `applyDreamResult` / `getLastTurnAt` adapters.
 *
 * THE BUG THIS MODULE EXISTS TO PREVENT (silent-path-bifurcation):
 *   Before this module, the `run-dream-pass` IPC handler in daemon.ts
 *   built its dream adapters inline. `registerDreamCron`
 *   (`src/manager/dream-cron.ts`) — the 30-min-idle AUTO trigger — had
 *   ZERO production callers: daemon.ts never registered it. Dream passes
 *   only ever fired via the manual `clawcode dream` IPC call. The
 *   auto-trigger went dark for 5+ days on fin-client before anyone
 *   noticed.
 *
 *   This module extracts the dream adapters so the manual IPC path AND
 *   the cron auto-trigger path share ONE implementation. There is no
 *   second dream-pass code path to drift.
 *
 * WHY `getLastTurnAt` lives here (and is non-trivial):
 *   `registerDreamCron` gates each tick on `isAgentIdle`, which needs a
 *   real `lastTurnAt: Date | null`. The old IPC handler used
 *   `(manager as unknown as { getLastTurnAt?: ... }).getLastTurnAt?.(agent)`
 *   — but `SessionManager` has NO `getLastTurnAt` method, so that
 *   expression ALWAYS resolved to `null`. `isAgentIdle(null)` returns
 *   `idle=false, reason="no-prior-turn"`. The manual IPC path papers
 *   over this because operators pass `--idle-bypass`; the cron has no
 *   bypass, so a cron wired against that stub would register but NEVER
 *   fire — the exact bug class, one surface over.
 *
 *   This module derives `lastTurnAt` from the agent's `ConversationStore`:
 *   the max `createdAt` across turns in the most recent few sessions.
 *   That covers the boot-time edge where `startAgent` creates a fresh
 *   EMPTY active session (zero turns) — scanning several recent sessions
 *   finds the prior session's last real turn instead of collapsing to
 *   `null`.
 *
 * PURE-DI: this module imports only types from the daemon's stores; the
 * concrete `SessionManager` / clock / logger / LLM-call are injected by
 * the daemon edge. Tests inject fakes.
 */

import type { Logger } from "pino";
import type { DreamPassOutcome } from "./dream-pass.js";
import type { DreamApplyOutcome } from "./dream-auto-apply.js";
import type { ConversationStore } from "../memory/conversation-store.js";
import type { MemoryStore } from "../memory/store.js";
import type { VetoStore } from "./dream-veto-store.js";
import { D10_AUTO_APPLY_PRIORITY_FLOOR, D10_VETO_WINDOW_MS } from "./dream-auto-apply.js";

/**
 * Phase 999.188 — resolved dream auto-promote policy. Defaults apply when the
 * agent's `dream:` block omits the knobs (they are optional in the schema so
 * existing fixtures keep their shape).
 */
export interface DreamPromotePolicy {
  readonly autoPromote: boolean;
  readonly autoApplyFloor: number;
  readonly vetoWindowMs: number;
}

export function resolveDreamPolicy(
  dream: { autoPromote?: boolean; autoPromoteMinScore?: number; vetoWindowMinutes?: number } | undefined,
): DreamPromotePolicy {
  return Object.freeze({
    autoPromote: dream?.autoPromote ?? true,
    autoApplyFloor: dream?.autoPromoteMinScore ?? D10_AUTO_APPLY_PRIORITY_FLOOR,
    vetoWindowMs: (dream?.vetoWindowMinutes ?? D10_VETO_WINDOW_MS / 60_000) * 60_000,
  });
}

/**
 * Number of recent sessions scanned by `buildGetLastTurnAt` when deriving
 * the most-recent turn timestamp. Five covers the common boot edge: a
 * fresh empty active session created by `startAgent` plus several prior
 * terminated sessions — the scan finds the last real turn rather than
 * collapsing to `null` on the empty session.
 */
export const LAST_TURN_SESSION_SCAN_LIMIT = 5;

/**
 * Subset of `SessionManager` the dream machinery touches. Narrow on
 * purpose so unit tests stand up a tiny fake instead of the full manager.
 */
export interface DreamMachineryManager {
  getMemoryStore(agent: string): MemoryStore | undefined;
  getConversationStore(agent: string): ConversationStore | undefined;
}

/** Resolved per-agent dream config (enabled / idleMinutes / model). */
export interface ResolvedDreamConfig {
  readonly enabled: boolean;
  readonly idleMinutes: number;
  readonly model: string;
}

/**
 * Edge dependencies for the dream machinery factory. The daemon supplies
 * the real `SessionManager`, the agent's resolved config lookup, the
 * `memoryRoot` resolver, the LLM call, and a clock + logger.
 */
export interface DreamMachineryDeps {
  readonly manager: DreamMachineryManager;
  /** Resolve the agent's memory root (memoryPath ?? workspace ?? ""). */
  readonly resolveMemoryRoot: (agent: string) => string;
  /**
   * One-shot LLM call for the dream-pass prompt. Production wires
   * `callHaikuDirect`; tests inject a stub. Mirrors the dispatch
   * contract the dream-pass primitive expects.
   */
  readonly dispatch: (req: {
    readonly model: string;
    readonly systemPrompt: string;
    readonly userPrompt: string;
    readonly maxOutputTokens: number;
  }) => Promise<{
    readonly rawText: string;
    readonly tokensIn: number;
    readonly tokensOut: number;
  }>;
  readonly now: () => Date;
  readonly log: Logger;
  /**
   * Phase 999.113 WS-6 — optional dir override for the dream run-log
   * (test sandbox seam, mirroring the run-log module's own dirOverride).
   * Production omits it → ~/.clawcode/manager/dream-runs.jsonl.
   */
  readonly dreamRunLogDir?: string;
  /**
   * Phase 999.188 — when present (and the agent's policy has autoPromote),
   * `applyDreamResult` runs the D-10 applier: promotion candidates enter
   * the veto window and the agent's channel gets the candidate list.
   * Absent (tests, bootstrap) → the legacy show-only applier.
   */
  readonly vetoStore?: VetoStore;
  /** Phase 999.188 — per-agent policy lookup; undefined → defaults. */
  readonly resolveDreamPolicy?: (agent: string) => DreamPromotePolicy;
  /** Phase 999.188 — post text into the agent's channel (best-effort). */
  readonly postToAgent?: (agent: string, text: string) => Promise<void>;
  /** Phase 999.188 — run-id generator; tests pin it. Default nanoid. */
  readonly nanoid?: () => string;
}

/**
 * Per-agent dream adapters built by `buildDreamMachinery`. Shape matches
 * what BOTH `RunDreamPassIpcDeps` and `DreamCronDeps` consume.
 *   - `runDreamPass(agent, model)` — model-parameterized (IPC override path)
 *   - `applyDreamResult(agent, outcome)` — persists links + dream log
 *   - `getLastTurnAt(agent)` — real conversation-store-backed timestamp
 */
export interface DreamMachinery {
  readonly runDreamPass: (
    agent: string,
    model: string,
  ) => Promise<DreamPassOutcome>;
  readonly applyDreamResult: (
    agent: string,
    outcome: DreamPassOutcome,
    /** Phase 999.188 — D-10 Row 5; the cron passes it, the IPC path omits it. */
    isPriorityPass?: boolean,
  ) => Promise<DreamApplyOutcome>;
  readonly getLastTurnAt: (agent: string) => Date | null;
}

/**
 * Derive the most-recent turn timestamp for an agent from its
 * `ConversationStore`.
 *
 * Strategy: scan the most recent `LAST_TURN_SESSION_SCAN_LIMIT` sessions
 * (active + terminated), collect every turn's `createdAt`, return the
 * global max as a `Date`. Returns `null` when:
 *   - the agent has no live `ConversationStore` (not started yet), OR
 *   - no session has any turns (agent genuinely never spoke).
 *
 * `null` is the correct "never spoke" signal — `isAgentIdle(null)` returns
 * `no-prior-turn` and the cron correctly declines to dream a silent agent.
 *
 * Best-effort: any store error is caught and treated as `null` so a
 * conversation-store hiccup can never crash a cron tick.
 */
export function deriveLastTurnAt(
  agent: string,
  manager: DreamMachineryManager,
  log: Logger,
): Date | null {
  const store = manager.getConversationStore(agent);
  if (!store) return null;
  try {
    const sessions = store.listRecentSessions(
      agent,
      LAST_TURN_SESSION_SCAN_LIMIT,
    );
    let maxMs: number | null = null;
    for (const session of sessions) {
      const turns = store.getTurnsForSession(session.id);
      for (const turn of turns) {
        const ms = Date.parse(turn.createdAt);
        if (Number.isNaN(ms)) continue;
        if (maxMs === null || ms > maxMs) maxMs = ms;
      }
    }
    return maxMs === null ? null : new Date(maxMs);
  } catch (err) {
    log.warn(
      {
        component: "dream-machinery",
        action: "derive-last-turn-failed",
        agent,
        err: err instanceof Error ? err.message : String(err),
      },
      "dream-machinery: deriveLastTurnAt failed; treating as no-prior-turn",
    );
    return null;
  }
}

/**
 * Build the shared per-agent dream adapters.
 *
 * Used by:
 *   1. the `run-dream-pass` IPC handler (manual `clawcode dream` trigger)
 *   2. `registerDreamCron` wiring at daemon boot (30-min-idle auto trigger)
 *
 * Both call sites get the SAME `runDreamPass` / `applyDreamResult` /
 * `getLastTurnAt` — there is no parallel dream-pass implementation.
 */
export function buildDreamMachinery(
  deps: DreamMachineryDeps,
): DreamMachinery {
  const { manager, resolveMemoryRoot, dispatch, now, log } = deps;

  // Phase 999.113 WS-6 — per-agent attempt timing for the dream run-log.
  // `runDreamPass` records when the attempt started; `applyDreamResult`
  // (which BOTH production callers invoke immediately after the pass —
  // IPC handler and cron tick alike, sequential awaits) consumes it when
  // appending the run-log row. Worst case on the theoretical race of a
  // manual IPC pass overlapping a cron pass for the same agent: the row's
  // timing attribution is slightly off — acceptable for a diagnostic log.
  const passStartedAt = new Map<string, { iso: string; ms: number }>();

  const runDreamPass = async (
    agent: string,
    model: string,
  ): Promise<DreamPassOutcome> => {
    const { runDreamPass: runDreamPassPrim } = await import("./dream-pass.js");
    const { readFile } = await import("node:fs/promises");

    const startedAt = now();
    passStartedAt.set(agent, {
      iso: startedAt.toISOString(),
      ms: startedAt.getTime(),
    });

    const memoryStore = manager.getMemoryStore(agent);
    const conversationStore = manager.getConversationStore(agent);
    const memoryRoot = resolveMemoryRoot(agent);

    // Narrow adapter shapes so the dream-pass primitive stays decoupled
    // from production store APIs. Empty-getter fallback when stores
    // aren't open yet (agent not running) — surfaces as a low-signal
    // dream pass rather than an exception that crashes the trigger.
    const dreamMemoryStore = {
      getRecentChunks: async (_agent: string, limit: number) => {
        if (!memoryStore) return [];
        try {
          return memoryStore.listRecentMemoryChunks(limit);
        } catch (err) {
          log.warn(
            {
              component: "dream-pass",
              action: "list-chunks-failed",
              agent,
              err: err instanceof Error ? err.message : String(err),
            },
            "dream-pass: listRecentMemoryChunks failed; treating as empty",
          );
          return [];
        }
      },
    };
    const dreamConvStore = {
      getRecentSummaries: async (_agent: string, limit: number) => {
        if (!conversationStore || !memoryStore) return [];
        try {
          const sessions = conversationStore.listRecentTerminatedSessions(
            agent,
            limit,
          );
          return sessions
            .map((s) => {
              if (!s.summaryMemoryId) return null;
              const mem = memoryStore.getById(s.summaryMemoryId);
              if (!mem || mem.content.trim().length === 0) return null;
              const endedIso = s.endedAt ?? s.startedAt;
              return {
                sessionId: s.id,
                summary: mem.content,
                endedAt: new Date(endedIso),
              };
            })
            .filter((x): x is NonNullable<typeof x> => x !== null);
        } catch (err) {
          log.warn(
            {
              component: "dream-pass",
              action: "list-summaries-failed",
              agent,
              err: err instanceof Error ? err.message : String(err),
            },
            "dream-pass: listRecentTerminatedSessions failed; treating as empty",
          );
          return [];
        }
      },
    };

    return runDreamPassPrim(agent, {
      memoryStore: dreamMemoryStore,
      conversationStore: dreamConvStore,
      readFile: async (p: string) => {
        try {
          return await readFile(p, "utf8");
        } catch {
          return "";
        }
      },
      dispatch,
      resolvedDreamConfig: {
        enabled: true, // gate already passed at the caller layer
        idleMinutes: 30,
        model,
      },
      memoryRoot,
      now,
      log,
    });
  };

  /**
   * Phase 999.113 WS-6 — append exactly one dream run-log row per dream
   * pass, on EVERY outcome.
   *
   * CALL-SITE CHOICE: this adapter is the single narrowest point that
   * (a) sees the PASS outcome (completed | skipped | failed — needed to
   * tell "failed" from "noop"), (b) sees the APPLY outcome (applied |
   * skipped | failed — needed for wikilinks_added and apply-side
   * failures), and (c) is on BOTH production trigger paths: the manual
   * `run-dream-pass` IPC handler and the boot-time `registerDreamCron`
   * tick each call runDreamPass then applyDreamResult through this same
   * machinery (the silent-path-bifurcation guarantee this module exists
   * for). Instrumenting dream-cron.ts would miss the IPC path;
   * instrumenting dream-pass.ts would miss apply-side failures.
   *
   * A log failure must never affect dreaming — the append is fully
   * try/catch'd (warn-and-continue).
   */
  const recordDreamRun = async (
    agent: string,
    outcome: DreamPassOutcome,
    applied: DreamApplyOutcome | undefined,
    applyThrewMessage: string | undefined,
  ): Promise<void> => {
    try {
      const { appendDreamRun } = await import("./dream-run-log.js");
      const { nanoid } = await import("nanoid");

      const timing = passStartedAt.get(agent);
      passStartedAt.delete(agent);
      const nowMs = now().getTime();
      const startedAtIso = timing?.iso ?? now().toISOString();
      const durationMs =
        timing !== undefined
          ? Math.max(nowMs - timing.ms, 0)
          : outcome.kind === "completed"
            ? outcome.durationMs
            : 0;

      // Outcome mapping (documented in DreamRunRow):
      //   pass failed                    → failed (reason = pass error)
      //   pass skipped                   → noop   (reason = skip reason)
      //   completed + apply applied      → applied (+ wikilinks_added)
      //   completed + apply failed/threw → failed (reason = apply error)
      //   completed + apply skipped      → noop (defensive; unreachable
      //     today — the applier only skips non-completed outcomes)
      let status: "applied" | "noop" | "failed";
      let reason: string | undefined;
      let wikilinksAdded: number | undefined;
      if (outcome.kind === "failed") {
        status = "failed";
        reason = outcome.error;
      } else if (outcome.kind === "skipped") {
        status = "noop";
        reason = `pass-skipped: ${outcome.reason}`;
      } else if (applyThrewMessage !== undefined) {
        status = "failed";
        reason = `apply-threw: ${applyThrewMessage}`;
      } else if (applied === undefined || applied.kind === "skipped") {
        status = "noop";
        reason = "apply-skipped";
      } else if (applied.kind === "failed") {
        status = "failed";
        reason = applied.error;
      } else {
        status = "applied";
        wikilinksAdded = applied.appliedWikilinkCount;
      }

      await appendDreamRun(
        {
          run_id: nanoid(),
          agent,
          status,
          started_at: startedAtIso,
          duration_ms: durationMs,
          ...(wikilinksAdded !== undefined
            ? { wikilinks_added: wikilinksAdded }
            : {}),
          ...(reason !== undefined ? { reason } : {}),
        },
        deps.dreamRunLogDir,
      );
    } catch (err) {
      log.warn(
        {
          component: "dream-machinery",
          action: "run-log-append-failed",
          agent,
          err: err instanceof Error ? err.message : String(err),
        },
        "dream-machinery: dream run-log append failed; dreaming unaffected",
      );
    }
  };

  const applyDreamResult = async (
    agent: string,
    outcome: DreamPassOutcome,
    isPriorityPass: boolean = false,
  ): Promise<DreamApplyOutcome> => {
    const { applyDreamResult: applyDreamResultPrim, applyDreamResultD10 } = await import(
      "./dream-auto-apply.js"
    );
    const { writeDreamLog } = await import("./dream-log-writer.js");
    const { appendDreamWikilinks } = await import("./dream-graph-edges.js");
    const memoryRoot = resolveMemoryRoot(agent);
    const applyAutoLinks = async (_agent: string, links: ReadonlyArray<{ from: string; to: string }>) => {
      if (!memoryRoot) return { added: 0 };
      return appendDreamWikilinks({ memoryRoot, links, now });
    };
    const policy = deps.resolveDreamPolicy?.(agent) ?? resolveDreamPolicy(undefined);

    let applied: DreamApplyOutcome;
    try {
      if (deps.vetoStore && policy.autoPromote) {
        // Phase 999.188 — D-10: promotions enter the veto window.
        const memoryStore = manager.getMemoryStore(agent);
        const runIdGen = deps.nanoid ?? (await import("nanoid")).nanoid;
        const d10 = await applyDreamResultD10({
          agentName: agent,
          outcome,
          isPriorityPass,
          memoryRoot,
          log: {
            info: (m) => log.info(m),
            warn: (m) => log.warn(m),
            error: (m) => log.error(m),
          },
          vetoStore: deps.vetoStore,
          nanoid: runIdGen,
          applyAutoLinks,
          now,
          resolveChunk: (chunkId) => {
            const c = memoryStore?.getMemoryChunk(chunkId);
            return c ? { heading: c.heading, body: c.body } : null;
          },
          writeDreamLog,
          autoApplyFloor: policy.autoApplyFloor,
          vetoWindowMs: policy.vetoWindowMs,
          postDiscordSummary: deps.postToAgent ? (text) => deps.postToAgent!(agent, text) : undefined,
        });
        applied =
          d10.kind === "applied"
            ? {
                kind: "applied",
                appliedWikilinkCount: d10.appliedWikilinkCount,
                surfacedPromotionCount: d10.operatorRequiredCount - d10.surfacedConsolidationCount,
                surfacedConsolidationCount: d10.surfacedConsolidationCount,
                logPath: d10.logPath ?? "",
                runId: d10.runId,
                autoApplyScheduled: d10.autoApplyScheduled,
                isPriorityPass: d10.isPriorityPass,
              }
            : d10;
      } else {
        applied = await applyDreamResultPrim(agent, outcome, {
          applyAutoLinks,
          writeDreamLog,
          memoryRoot,
          now,
          log,
        });
      }
    } catch (err) {
      // The applier's contract is never-throw; defensively record the
      // attempt as failed before preserving caller semantics (rethrow —
      // the cron tick / IPC handler own the crash logging).
      await recordDreamRun(
        agent,
        outcome,
        undefined,
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }

    await recordDreamRun(agent, outcome, applied, undefined);
    return applied;
  };

  const getLastTurnAt = (agent: string): Date | null =>
    deriveLastTurnAt(agent, manager, log);

  return { runDreamPass, applyDreamResult, getLastTurnAt };
}
