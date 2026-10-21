/**
 * Phase 999.25 — Subagent completion sweep (quiescence-timer relay).
 *
 * Catches the case where a subagent finishes its work but does NOT call
 * the explicit `subagent_complete` MCP tool — operator-visible result
 * shouldn't wait until session-end (hours later, after the Phase 999.X
 * 2h reaper). After a subagent's binding has been quiet for
 * `quiescenceMinutes` (default 5), the sweep fires
 * `relayCompletionToParent` and stamps `binding.completedAt` so the
 * other relay paths (explicit tool, session-end callback) become no-ops.
 *
 * Hosted in the same 60s `onTickAfter` callback in `daemon.ts:4609`
 * alongside the orphan-claude reaper, subagent-session reaper, and
 * stale-binding sweep. Pure scan + DI'd side effects so unit tests
 * don't need a full daemon.
 *
 * False-positive guards:
 *   - `isSubagentThreadName(binding.sessionName)` — operator-defined
 *     agent bindings are never touched.
 *   - `binding.completedAt` already set → skip (idempotent).
 *   - Session must be `"running"` in the registry (skip
 *     `starting`/`stopping`/`stopped`/`crashed`/`restarting`/`failed`).
 *     Stopped sessions are handled by the existing session-end relay
 *     path in `daemon.ts:6258`; starting sessions are skipped to avoid
 *     racing the spawner.
 *   - Env kill-switch: `CLAWCODE_SUBAGENT_COMPLETION_DISABLE=1`. When
 *     set, the sweep noops (the explicit tool also returns
 *     `{ ok: false, reason: "disabled" }`).
 *
 * Canonical log shape (pinned by tests):
 *   { component: "subagent-completion-sweep",
 *     action: "alert" | "relayed" | "skip",
 *     agent, sessionName, threadId, idleSec, msg }
 */

import type { Logger } from "pino";
import type { ThreadBinding } from "../discord/thread-types.js";
import { isSubagentThreadName } from "./subagent-name.js";
import {
  relayAndMarkCompletedByThreadId,
  type RelayAndMarkCompletedDeps,
  type RelayAndMarkCompletedResult,
} from "./relay-and-mark-completed.js";

/**
 * Minimal slice of a registry entry the sweep reads. Defined as a
 * structural type so tests don't need a full RegistryEntry mock —
 * mirrors the shape `subagent-session-reaper` uses.
 */
export type RunningSessionInfo = {
  readonly name: string;
  readonly status: string;
};

export type CompletionSweepCandidate = {
  readonly sessionName: string;
  readonly threadId: string;
  readonly idleSec: number;
  /**
   * Snapshot of the binding's `lastDeliveryAt` at scan time. `null` when
   * the spawner's post-delivery stamp has not landed (subagent is mid-think
   * between tool calls, or crashed before producing output). The dispatch
   * helper uses this to refuse a quiescence relay until delivery is
   * confirmed.
   */
  readonly lastDeliveryAt: number | null;
  /**
   * Snapshot of the binding's `producedRealContent` at scan time. `null`
   * for legacy bindings written before the field existed (treated as
   * unknown — the dispatch helper refuses to relay unless the value is
   * explicitly `true`). Pre-emptively closes the placeholder-relay class
   * fixed by commit `bdf2cdc3` on the auto-relay-after-turn-1 path.
   */
  readonly producedRealContent: boolean | null;
};

export type ScanArgs = {
  /** Snapshot of running sessions at tick start. */
  readonly sessions: readonly RunningSessionInfo[];
  /** Snapshot of thread bindings at tick start. */
  readonly bindings: readonly ThreadBinding[];
  readonly quiescenceMinutes: number;
  /** Test seam — defaults to Date.now(). */
  readonly now?: number;
};

/**
 * Pure scan — return bindings that should fire the quiescence relay.
 * No side effects, deterministic ordering by binding input order.
 */
export function scanQuiescentBindings(
  args: ScanArgs,
): readonly CompletionSweepCandidate[] {
  const now = args.now ?? Date.now();
  const quiescenceMs = args.quiescenceMinutes * 60_000;

  // O(1) lookups by sessionName.
  const runningByName = new Map<string, RunningSessionInfo>();
  for (const s of args.sessions) {
    if (s.status === "running") runningByName.set(s.name, s);
  }

  const out: CompletionSweepCandidate[] = [];
  for (const b of args.bindings) {
    if (!isSubagentThreadName(b.sessionName)) continue;
    if (b.completedAt !== undefined && b.completedAt !== null) continue;
    if (!runningByName.has(b.sessionName)) continue;
    const idleMs = now - b.lastActivity;
    if (idleMs < quiescenceMs) continue;
    out.push({
      sessionName: b.sessionName,
      threadId: b.threadId,
      idleSec: Math.round(idleMs / 1000),
      lastDeliveryAt: b.lastDeliveryAt ?? null,
      producedRealContent: b.producedRealContent ?? null,
    });
  }
  return out;
}

export type TickArgs = ScanArgs & {
  readonly enabled: boolean;
  readonly log: Logger;
  /**
   * Per-candidate handler. Phase 999.36 sub-bug D changed the contract:
   * the sweep is NO LONGER a relay-firing path. The handler is now the
   * operator-visibility hook — production wires this to emit a
   * `subagent_idle_warning` log line with in-memory dedupe so a stuck
   * subagent doesn't generate a warning every tick. Tests pass a
   * `vi.fn()`.
   *
   * Real completion paths: explicit `subagent_complete` tool,
   * `postInitialMessage` delivery-confirmed stamp, OR session-end
   * backstop. Quiescence is observational only.
   *
   * Resolves to `{ ok: true }` on every invocation (the handler is
   * a soft observer, not a side-effect operator). Reserved for
   * forward-compat with handlers that might surface a result. Throws
   * only on unexpected errors — caller logs at error level.
   */
  readonly onQuiescent: (
    c: CompletionSweepCandidate,
  ) => Promise<{ readonly ok: boolean; readonly reason?: string }>;
};

/**
 * One tick of the subagent-completion sweep.
 *
 * In disabled state (yaml `enabled: false` OR env kill-switch): noop.
 *
 * Otherwise: scan candidates, invoke onQuiescent per candidate. The
 * sweep itself does NOT log "firing completion relay" anymore (Phase
 * 999.36 sub-bug D — quiescence is no longer a completion signal). The
 * onQuiescent handler is the operator-visibility surface (production
 * wires to `subagent_idle_warning` with dedupe). Failures are logged
 * but never propagate.
 */
/**
 * Quiescence-relay dispatcher (advisor option 1 — re-enable a gated
 * quiescence-relay path). Production wires the daemon's `onQuiescent` to
 * call this first; if it returns "skipped-needs-warning", the daemon falls
 * back to `handleSubagentQuiescenceWarning` so a still-not-stamped
 * subagent surfaces as an idle warning.
 *
 * Gates (must ALL be true for the relay to fire):
 *  - `enabled` — config knob `subagentCompletion.relayOnQuiescence` (default
 *    true). Rollback path: operators can flip just this knob without
 *    losing idle warnings.
 *  - `lastDeliveryAt !== null` — spawner's post-delivery stamp landed
 *    (final text + overflow chunks drained to Discord). Closes the
 *    premature-relay class that motivated Phase 999.36 D's removal of
 *    the original quiescence-relay.
 *  - `producedRealContent === true` — the SDK turn produced real content
 *    (not just the unedited "🔄 Working…" placeholder). Closes the
 *    placeholder-relay class fixed by commit `bdf2cdc3` on the
 *    auto-relay-after-turn-1 path.
 *
 * When all three pass, the helper delegates to
 * `relayAndMarkCompletedByThreadId` (the same unified relay path used by
 * the explicit `subagent_complete` tool and the session-end backstop).
 * `completedAt` is stamped on success; the binding becomes terminal and
 * subsequent ticks skip it.
 *
 * **Timing note.** `quiescenceMinutes` measures idle from
 * `binding.lastActivity`, which `thread-manager.routeMessage` bumps on
 * every incoming Discord message. A subagent that takes 8 min to deliver
 * its long response will typically already be past 5 min idle by the time
 * `lastDeliveryAt` lands — so the relay fires on the NEXT 60s tick after
 * delivery, not literally 5 min later. This is the behaviour you want
 * (don't make operators wait 5 extra minutes after the work is done) but
 * is non-obvious from the knob name; flag it in any operator-facing doc.
 *
 * Returns:
 *  - `"relayed"` — the relay path returned a terminal outcome (relayed
 *    or already-completed). No follow-up warning needed.
 *  - `"skipped-needs-warning"` — gates failed (no stamp / no content /
 *    disabled). Caller should emit the idle warning so the operator
 *    sees a stuck subagent.
 *
 * Throws ONLY on unexpected errors from the underlying relay path —
 * callers wrap in try/catch (the sweep already does).
 */
export type QuiescenceRelayResult =
  | { readonly outcome: "relayed"; readonly reason: RelayAndMarkCompletedResult["reason"] }
  | {
      readonly outcome: "skipped-needs-warning";
      readonly reason:
        | "disabled"
        | "no-delivery-stamp"
        | "no-real-content"
        | "spawner-unavailable"
        | "relay-disabled"
        | "delivery-not-confirmed"
        | "no-binding";
    };

export async function handleSubagentQuiescenceRelay(args: {
  readonly candidate: CompletionSweepCandidate;
  readonly enabled: boolean;
  readonly relayDeps: RelayAndMarkCompletedDeps;
  readonly log: Logger;
}): Promise<QuiescenceRelayResult> {
  if (!args.enabled) {
    return { outcome: "skipped-needs-warning", reason: "disabled" };
  }
  if (args.candidate.lastDeliveryAt === null) {
    return { outcome: "skipped-needs-warning", reason: "no-delivery-stamp" };
  }
  if (args.candidate.producedRealContent !== true) {
    return { outcome: "skipped-needs-warning", reason: "no-real-content" };
  }
  args.log.info(
    {
      component: "subagent-completion-sweep",
      action: "relay-firing",
      threadId: args.candidate.threadId,
      sessionName: args.candidate.sessionName,
      idleSec: args.candidate.idleSec,
    },
    "subagent quiescence — firing gated completion relay",
  );
  const result = await relayAndMarkCompletedByThreadId(
    args.relayDeps,
    args.candidate.threadId,
  );
  // The relay path logs its own outcome ("marked-completed" or
  // "subagent-completion-relay-skipped"); we just thread the reason out
  // so the caller can skip the warning on success and dispatch it on
  // an unexpected skip.
  if (result.ok && (result.reason === "relayed" || result.reason === "already-completed")) {
    return { outcome: "relayed", reason: result.reason };
  }
  // delivery-not-confirmed / no-binding / disabled / spawner-unavailable
  // — fall through to a warning so the operator sees the binding is
  // still pending.
  args.log.info(
    {
      component: "subagent-completion-sweep",
      action: "relay-deferred",
      threadId: args.candidate.threadId,
      sessionName: args.candidate.sessionName,
      reason: result.reason,
    },
    "subagent quiescence — relay path returned non-terminal; will warn",
  );
  // Pass the relay path's reason through verbatim so the next debugger
  // reading logs sees the actual cause (spawner-unavailable / disabled /
  // delivery-not-confirmed / no-binding) instead of a synthesized label.
  // `relayed` and `already-completed` are handled above; the remaining
  // reasons are 1:1 with the union widening above. `relay-disabled` is
  // the surface name for the relay's own internal "disabled" reason (the
  // unified relay enabled flag, distinct from the sweep's
  // `relayOnQuiescence` knob — that one short-circuits at the top with
  // `outcome: "skipped-needs-warning", reason: "disabled"`).
  const passThroughReason: QuiescenceRelayResult["reason"] =
    result.reason === "disabled"
      ? "relay-disabled"
      : (result.reason as Exclude<
          RelayAndMarkCompletedResult["reason"],
          "relayed" | "already-completed" | "disabled"
        >);
  return { outcome: "skipped-needs-warning", reason: passThroughReason };
}

/**
 * Phase 999.36 sub-bug D — pure handler for the quiescence-warning path.
 *
 * Deduped emission of `subagent_idle_warning` for a single candidate. The
 * dedupe Map is owned by the caller (daemon's onTickAfter closure) so it
 * survives across ticks. Returns "warned" if a warning was emitted,
 * "deduped" if the candidate was suppressed.
 *
 * Pure side effects: mutates `emittedAt` Map, calls `log.info`. No I/O.
 */
export function handleSubagentQuiescenceWarning(args: {
  readonly candidate: CompletionSweepCandidate;
  readonly emittedAt: Map<string, number>;
  readonly now: number;
  readonly quiescenceMinutes: number;
  readonly log: Logger;
}): "warned" | "deduped" {
  const warnDedupeMs = args.quiescenceMinutes * 60_000;
  const lastWarn = args.emittedAt.get(args.candidate.threadId) ?? 0;
  if (args.now - lastWarn < warnDedupeMs) {
    return "deduped";
  }
  args.emittedAt.set(args.candidate.threadId, args.now);
  args.log.info(
    {
      threadId: args.candidate.threadId,
      sessionName: args.candidate.sessionName,
      idleSec: args.candidate.idleSec,
      quiescenceMinutes: args.quiescenceMinutes,
    },
    "subagent_idle_warning",
  );
  return "warned";
}

export async function tickSubagentCompletionSweep(
  args: TickArgs,
): Promise<void> {
  if (!args.enabled) return;
  if (process.env.CLAWCODE_SUBAGENT_COMPLETION_DISABLE === "1") return;

  const candidates = scanQuiescentBindings(args);
  if (candidates.length === 0) return;

  for (const c of candidates) {
    try {
      await args.onQuiescent(c);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      args.log.error(
        {
          component: "subagent-completion-sweep",
          action: "onQuiescent-failed",
          agent: c.sessionName,
          threadId: c.threadId,
          err: msg,
        },
        "completion-sweep onQuiescent handler failed unexpectedly",
      );
    }
  }
}
