/**
 * Phase 999.25 — relay-and-mark-completed helper.
 *
 * Single source of truth for the subagent completion flow. Used by:
 *
 *   1. The `subagent-complete` IPC handler (explicit
 *      `mcp__clawcode__subagent_complete` tool fires this path).
 *   2. The daemon's session-end backstop.
 *
 * Dedupe is the `binding.completedAt` flag — read-then-write semantics; a
 * second caller sees `completedAt !== null` and skips. The relay itself is
 * idempotent (`relayCompletionToParent` walks Discord history
 * newest→oldest, so repeated calls produce the same content).
 *
 * 999.65 — the read→stamp-completedAt→write is now performed through
 * `mutateThreadRegistry` (a per-path async critical section). The previous
 * bare `readThreadRegistry` + `writeThreadRegistry` raced every other
 * registry writer — most damagingly `thread-manager.routeMessage`'s
 * lastActivity bump, which could clobber a freshly stamped
 * `lastDeliveryAt` and make this very gate refuse the relay. See the
 * `mutateThreadRegistry` doc comment in `thread-registry.ts`.
 *
 * 999.65 — every non-"relayed" return now emits a structured diagnostic
 * log line (`subagent-completion-relay-skipped`) carrying threadId,
 * sessionName, agentName (parent), and reason. The drop class was
 * previously silent (see `feedback_silent_path_bifurcation`).
 *
 * Debug session `relay-delivery-not-confirmed` (FAULT 1) — the
 * `delivery-not-confirmed` gate no longer hard-skips on a not-yet-stamped
 * `lastDeliveryAt`. The explicit-tool `subagent_complete` IPC can race
 * ahead of the spawner's post-delivery `stampLastDeliveryAt` commit; the
 * gate now DEFER-AND-RETRIES (bounded `deliveryRetry` budget, injectable
 * `sleep`) and only returns `delivery-not-confirmed` if the stamp is still
 * missing after the whole budget. See the inline comment at the gate.
 *
 * The session-end callback in `subagent-thread-spawner.ts` ALSO checks
 * `binding.completedAt` and skips if set — that's a second dedupe site,
 * kept inline there because it's part of the spawner's own lifecycle.
 *
 * No side effects beyond Discord post + thread-bindings.json write.
 * Pure deps so unit tests pass `vi.fn()` without a daemon or Discord.
 */

import type { Logger } from "pino";
import type {
  ThreadBinding,
  ThreadBindingRegistry,
} from "../discord/thread-types.js";

export type RelayAndMarkCompletedResult =
  | { readonly ok: true; readonly reason: "relayed" }
  | { readonly ok: true; readonly reason: "already-completed" }
  | { readonly ok: false; readonly reason: "no-binding" }
  | { readonly ok: false; readonly reason: "disabled" }
  | { readonly ok: false; readonly reason: "spawner-unavailable" }
  | { readonly ok: false; readonly reason: "delivery-not-confirmed" };

export type RelayAndMarkCompletedDeps = {
  readonly readThreadRegistry: () => Promise<ThreadBindingRegistry>;
  /**
   * 999.65 — atomic read-modify-write of the thread registry. Production
   * binds this to `mutateThreadRegistry(THREAD_REGISTRY_PATH, ...)` so the
   * completedAt stamp runs inside the per-path critical section and cannot
   * lose-update against a concurrent writer.
   *
   * The mutator receives the freshly-read registry and returns the next
   * registry; the helper resolves to the persisted registry.
   */
  readonly mutateThreadRegistry: (
    mutator: (current: ThreadBindingRegistry) => ThreadBindingRegistry,
  ) => Promise<ThreadBindingRegistry>;
  /**
   * The spawner-side relay function. Production binds to
   * `subagentThreadSpawner.relayCompletionToParent(threadId)`.
   * `null` indicates the spawner is unavailable (Discord bridge
   * disabled) — handler returns `spawner-unavailable`.
   *
   * Phase 999.19 — `relayCompletionToParent` now resolves to the
   * delegate's trimmed final text (`string | null`); this handler only
   * `await`s and discards it, so the resolved value is irrelevant here.
   */
  readonly relayCompletionToParent:
    | ((threadId: string) => Promise<string | null>)
    | null;
  readonly now: () => number;
  readonly log: Logger;
  /** When `false`, returns `{ ok: false, reason: "disabled" }` immediately. */
  readonly enabled: boolean;
  /**
   * Debug session `relay-delivery-not-confirmed` (FAULT 1) — async delay
   * used by the `delivery-not-confirmed` defer-and-retry loop. Production
   * binds `(ms) => new Promise((r) => setTimeout(r, ms))`. Unit tests pass
   * a no-op (`() => Promise.resolve()`) so the retry loop exhausts its
   * budget instantly without waiting real time.
   *
   * Optional — defaults to a real `setTimeout` delay so existing callers
   * that don't yet pass it keep working.
   */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Debug session `relay-delivery-not-confirmed` (FAULT 1) — bounded retry
   * budget for the `delivery-not-confirmed` defer-and-retry loop.
   *
   * The explicit-tool `subagent_complete` IPC can be dispatched the instant
   * the subagent's final stream block is emitted — potentially BEFORE the
   * spawner's post-delivery `stampLastDeliveryAt` commits (the stamp runs
   * AFTER the final-text edit + every overflow chunk drains to Discord). On
   * a long answer with overflow chunks that drain window is 100s of ms to a
   * few seconds. Rather than hard-skipping the relay on a not-yet-stamped
   * `lastDeliveryAt`, the helper re-reads the registry up to
   * `deliveryRetry.attempts` times, sleeping `deliveryRetry.delayMs` between
   * attempts, and proceeds the moment the stamp lands. Only if the stamp is
   * STILL missing after the whole budget does it return
   * `delivery-not-confirmed` (a genuine crash-mid-stream / never-delivered).
   *
   * This preserves the Phase 999.36 D-13 intent — never relay before the
   * subagent's final chunks reach Discord — because the retry waits for the
   * very stamp the spawner writes AFTER those chunks drain.
   *
   * Optional — defaults to `DEFAULT_DELIVERY_RETRY` (`{ attempts: 120,
   * delayMs: 250 }` = ~30s total worst-case; widened from the original ~5s
   * by quick-fix 260610-qu5 to cover the observed ~12s post-`subagent_complete`
   * drain window). Tests inject a no-op `sleep` so the loop runs instantly.
   */
  readonly deliveryRetry?: {
    readonly attempts: number;
    readonly delayMs: number;
  };
};

/**
 * Debug session `relay-delivery-not-confirmed` (FAULT 1) — default
 * defer-and-retry budget. ~30s worst case (120 × 250ms). The happy case
 * (stamp already landed, or lands within the first attempt or two)
 * returns immediately — the full budget is only spent on a genuine
 * never-delivered subagent.
 *
 * Quick-fix 260610-qu5 — widened from the original ~5s (20 × 250ms) to
 * ~30s. The live 2026-06-10 diagnosis (`project_fable_subagent_delivery_failure`)
 * observed a real subagent's stream settle ~12s AFTER the explicit-tool
 * `subagent_complete` IPC fired (`lQBDmc`: 34-turn / 1513-token run, overflow
 * chunks draining to Discord). The ~5s budget exhausted before its
 * `lastDeliveryAt` stamp landed → `relay-skipped (delivery-not-confirmed)` →
 * the fast relay was skipped even though a real answer WAS written. ~30s
 * comfortably covers the observed ~12s drain window. `delayMs` stays small
 * (250ms) so the happy path returns the instant the stamp lands. EXPORTED so
 * a unit test can pin the worst-case-budget floor (>= 30000ms) — exporting is
 * NOT a wire-contract change (the IPC schema, deps shape, and result union are
 * untouched).
 */
export const DEFAULT_DELIVERY_RETRY = { attempts: 120, delayMs: 250 } as const;

/**
 * 999.65 — emit the structured diagnostic line for a non-"relayed"
 * outcome. Single mutation point so every skip/dedupe reason is logged
 * with the same shape. `relayed` is intentionally NOT logged here — the
 * success path already logs `marked-completed`.
 */
function logRelaySkip(
  log: Logger,
  reason: RelayAndMarkCompletedResult["reason"],
  fields: {
    readonly threadId?: string;
    readonly sessionName?: string;
    readonly agentName?: string;
  },
): void {
  log.info(
    {
      component: "subagent-completion",
      action: "relay-skipped",
      reason,
      threadId: fields.threadId ?? null,
      sessionName: fields.sessionName ?? null,
      // Parent agent — the agent whose main channel the relay targets.
      parentAgent: fields.agentName ?? null,
    },
    "subagent-completion-relay-skipped",
  );
}

/**
 * Look up the binding for `threadId`, fire the relay, stamp
 * `completedAt`. Idempotent: if `completedAt` is already set, returns
 * `{ ok: true, reason: "already-completed" }` without re-firing.
 *
 * Throws ONLY on unexpected errors (Discord post fatal, registry write
 * fatal). Callers wrap in try/catch — the IPC handler logs at error level
 * on throw but never propagates (would crash the IPC server).
 */
export async function relayAndMarkCompletedByThreadId(
  deps: RelayAndMarkCompletedDeps,
  threadId: string,
): Promise<RelayAndMarkCompletedResult> {
  if (!deps.enabled) {
    logRelaySkip(deps.log, "disabled", { threadId });
    return { ok: false, reason: "disabled" };
  }
  if (deps.relayCompletionToParent === null) {
    logRelaySkip(deps.log, "spawner-unavailable", { threadId });
    return { ok: false, reason: "spawner-unavailable" };
  }

  const registry = await deps.readThreadRegistry();
  const binding = registry.bindings.find((b) => b.threadId === threadId);
  if (binding === undefined) {
    logRelaySkip(deps.log, "no-binding", { threadId });
    return { ok: false, reason: "no-binding" };
  }
  if (binding.completedAt !== undefined && binding.completedAt !== null) {
    // Dedupe hit — not an error, but logged so parallel-completion
    // behaviour is observable (a genuine second relay for the SAME thread
    // is correctly suppressed; distinct threads have distinct bindings and
    // are never collapsed here).
    logRelaySkip(deps.log, "already-completed", {
      threadId,
      sessionName: binding.sessionName,
      agentName: binding.agentName,
    });
    return { ok: true, reason: "already-completed" };
  }

  // Phase 999.36 sub-bug D (D-13) — gate completion on delivery
  // confirmation. Without this, a tool-result-with-no-followup or a
  // heartbeat-quiescence sweep can fire the relay before the subagent's
  // actual final chunks reach Discord.
  //
  // Debug session `relay-delivery-not-confirmed` (FAULT 1) — the gate used
  // to HARD-SKIP (return `delivery-not-confirmed`, no retry) the instant
  // `lastDeliveryAt` was unstamped. Its premise — "unstamped == delivery
  // never happened" — is wrong: the explicit-tool `subagent_complete` IPC
  // can be dispatched the moment the subagent's final stream block is
  // emitted, which can be BEFORE the spawner's post-delivery
  // `stampLastDeliveryAt` commits (that stamp runs AFTER the final-text
  // edit + every overflow chunk drains to Discord — see
  // subagent-thread-spawner.ts:1270-1295). On a long answer with overflow
  // chunks that window is 100s of ms to a few seconds. A 2026-05-22 prod
  // incident lost a real deliverable's relay exactly this way.
  //
  // Fix: defer-and-retry instead of hard-skip. Re-read the registry up to
  // `deliveryRetry.attempts` times, sleeping `deliveryRetry.delayMs`
  // between attempts; proceed the moment the stamp lands. This PRESERVES
  // the D-13 intent — it still waits for the stamp the spawner writes
  // AFTER the final chunks reach Discord — it just stops treating a
  // not-yet-landed stamp as a permanent failure. Only when the stamp is
  // STILL missing after the whole budget do we return
  // `delivery-not-confirmed` (a genuine crash-mid-stream / never-delivered
  // subagent).
  const retry = deps.deliveryRetry ?? DEFAULT_DELIVERY_RETRY;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let deliveryStamped =
    binding.lastDeliveryAt !== undefined && binding.lastDeliveryAt !== null;
  if (!deliveryStamped) {
    for (
      let attempt = 1;
      attempt <= retry.attempts && !deliveryStamped;
      attempt++
    ) {
      await sleep(retry.delayMs);
      const fresh = await deps.readThreadRegistry();
      const liveBinding = fresh.bindings.find((b) => b.threadId === threadId);
      if (liveBinding === undefined) {
        // Binding vanished mid-retry (removeThreadSession raced) — there is
        // nothing left to relay or stamp. Treat as no-binding.
        logRelaySkip(deps.log, "no-binding", { threadId });
        return { ok: false, reason: "no-binding" };
      }
      if (
        liveBinding.completedAt !== undefined &&
        liveBinding.completedAt !== null
      ) {
        // Another relay path (session-end backstop / a concurrent caller)
        // confirmed delivery and completed it while we were waiting.
        logRelaySkip(deps.log, "already-completed", {
          threadId,
          sessionName: liveBinding.sessionName,
          agentName: liveBinding.agentName,
        });
        return { ok: true, reason: "already-completed" };
      }
      deliveryStamped =
        liveBinding.lastDeliveryAt !== undefined &&
        liveBinding.lastDeliveryAt !== null;
    }
  }
  if (!deliveryStamped) {
    // Budget exhausted — the stamp never landed. This is now a genuine
    // never-delivered signal (the spawner's post-delivery stamp would have
    // landed within the drain window), not a stamp-vs-IPC reorder.
    logRelaySkip(deps.log, "delivery-not-confirmed", {
      threadId,
      sessionName: binding.sessionName,
      agentName: binding.agentName,
    });
    return { ok: false, reason: "delivery-not-confirmed" };
  }

  await deps.relayCompletionToParent(threadId);

  // 999.65 — stamp completedAt inside the per-path critical section. The
  // mutator re-reads the registry (so it observes any write committed
  // between our read above and now), re-checks the dedupe flag, and
  // rebuilds only this binding — no other binding's concurrently-written
  // fields are clobbered.
  const now = deps.now();
  await deps.mutateThreadRegistry((current) => {
    const idx = current.bindings.findIndex((b) => b.threadId === threadId);
    if (idx === -1) {
      // Binding vanished between our read and the critical section
      // (removeThreadSession raced). Nothing to stamp.
      return current;
    }
    const live = current.bindings[idx]!;
    if (live.completedAt !== undefined && live.completedAt !== null) {
      // Another relay path stamped it first inside the lock — leave it.
      return current;
    }
    const updatedBinding: ThreadBinding = { ...live, completedAt: now };
    return {
      bindings: current.bindings.map((b, i) =>
        i === idx ? updatedBinding : b,
      ),
      updatedAt: now,
    };
  });

  deps.log.info(
    {
      component: "subagent-completion",
      action: "marked-completed",
      threadId,
      sessionName: binding.sessionName,
      agentName: binding.agentName,
    },
    "subagent completion relayed and marked",
  );

  return { ok: true, reason: "relayed" };
}

/**
 * Convenience wrapper for the IPC handler — takes `agentName` (which
 * is the binding's `sessionName` for subagent threads) and resolves to
 * `threadId` before delegating to `relayAndMarkCompletedByThreadId`.
 *
 * Returns the same `RelayAndMarkCompletedResult` shape so the IPC
 * handler can pass through.
 */
export async function relayAndMarkCompletedByAgentName(
  deps: RelayAndMarkCompletedDeps,
  agentName: string,
): Promise<RelayAndMarkCompletedResult> {
  if (!deps.enabled) {
    logRelaySkip(deps.log, "disabled", { sessionName: agentName });
    return { ok: false, reason: "disabled" };
  }
  if (deps.relayCompletionToParent === null) {
    logRelaySkip(deps.log, "spawner-unavailable", { sessionName: agentName });
    return { ok: false, reason: "spawner-unavailable" };
  }
  const registry = await deps.readThreadRegistry();
  const binding = registry.bindings.find((b) => b.sessionName === agentName);
  if (!binding) {
    logRelaySkip(deps.log, "no-binding", { sessionName: agentName });
    return { ok: false, reason: "no-binding" };
  }
  return relayAndMarkCompletedByThreadId(deps, binding.threadId);
}
