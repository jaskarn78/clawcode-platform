/**
 * Debug session `relay-delivery-not-confirmed` (FAULT 2) — pre-teardown
 * subagent-relay drain.
 *
 * THE BUG. The daemon shutdown closure (src/manager/daemon.ts) runs
 * `await discordBridge.stop()` — which calls `client.destroy()` and clears
 * the discord.js REST token — BEFORE it stops the agents. Stopping a
 * subagent fires its registered session-end callback (the Phase 999.36
 * sub-bug D backstop), whose only job is a Discord post via
 * `relayCompletionToParent` -> `discordClient.channels.fetch(threadId)`.
 * With the token already gone that REST call throws exactly:
 *
 *   "Expected token to be set for this request, but none was present"
 *
 * Net: a subagent that completed real work but whose `completedAt` was
 * never stamped (e.g. FAULT 1 left it unstamped) loses its parent relay
 * during a deploy restart. Observed on clawdy 2026-05-22.
 *
 * THE FIX. Run this drain in the shutdown closure BEFORE
 * `discordBridge.stop()` — while the Discord client is still alive. For
 * every subagent binding that has not been completed yet, treat
 * session-end as delivery-equivalent (force-stamp `lastDeliveryAt` if
 * missing, mirroring the existing session-end backstop) and run the
 * unified `relayAndMarkCompletedByThreadId` path.
 *
 * Using `relayAndMarkCompletedByThreadId` — not a bare
 * `relayCompletionToParent` — is load-bearing: it stamps `completedAt` on
 * success. The per-subagent session-end callbacks STILL fire later in
 * shutdown (when the agents are stopped, after `discordBridge.stop()`),
 * but they short-circuit on the `binding.completedAt !== null` dedupe
 * instead of re-attempting the now-tokenless Discord post.
 *
 * Bounded: a per-binding timeout and a total-budget ceiling so a slow or
 * unreachable Discord cannot hang daemon shutdown. A binding that times
 * out is left un-stamped — its session-end callback will still try (and
 * fail the same way today's bug fails), but shutdown is not blocked. The
 * common case (Discord healthy) drains cleanly in well under the budget.
 *
 * Pure deps so unit tests need no daemon, no Discord, no real timers.
 */

import type { Logger } from "pino";
import type { ThreadBinding } from "../discord/thread-types.js";
import {
  relayAndMarkCompletedByThreadId,
  type RelayAndMarkCompletedDeps,
} from "./relay-and-mark-completed.js";

export type DrainPendingSubagentRelaysDeps = {
  /**
   * Returns every live subagent thread binding. Production binds
   * `subagentThreadSpawner.getSubagentBindings()`.
   */
  readonly getSubagentBindings: () => Promise<readonly ThreadBinding[]>;
  /**
   * Force-stamp `lastDeliveryAt` for a threadId. Production binds
   * `(threadId, ts, prc) => stampLastDeliveryAt(THREAD_REGISTRY_PATH, threadId, ts, prc)`.
   * Session-end is delivery-equivalent — mirrors the daemon's existing
   * session-end backstop. The drain stamps `producedRealContent: true`
   * (session-end is delivery-equivalent and carries no content signal).
   * Failures are logged, never thrown.
   */
  readonly stampLastDeliveryAt: (
    threadId: string,
    deliveredAt: number,
    producedRealContent?: boolean,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * The unified relay+mark-completed deps. Production binds the SAME deps
   * object shape the explicit-tool `subagent-complete` IPC handler builds
   * (readThreadRegistry / mutateThreadRegistry / relayCompletionToParent /
   * now / log / enabled / sleep). Reused so the drain stamps `completedAt`
   * and the later session-end callbacks dedupe.
   *
   * `deliveryRetry` is overridden to a single fast attempt here — the
   * drain force-stamps `lastDeliveryAt` itself immediately before relaying,
   * so the defer-and-retry loop has nothing to wait for. A long retry
   * budget would only slow shutdown.
   */
  readonly relayDeps: RelayAndMarkCompletedDeps;
  readonly now: () => number;
  readonly log: Logger;
  /**
   * Per-binding wall-clock ceiling. A relay that exceeds this is abandoned
   * (logged) so one slow thread cannot stall the whole drain.
   */
  readonly perBindingTimeoutMs: number;
  /**
   * Total drain budget. Once exceeded, remaining bindings are skipped
   * (logged) and shutdown proceeds.
   */
  readonly totalBudgetMs: number;
};

export type DrainPendingSubagentRelaysResult = {
  /** Bindings inspected (all subagent bindings with no `completedAt`). */
  readonly pending: number;
  /** Relays that fired and stamped `completedAt`. */
  readonly relayed: number;
  /** Already-completed bindings skipped (dedupe). */
  readonly alreadyCompleted: number;
  /** Bindings that errored or timed out (left for the session-end path). */
  readonly failed: number;
  /** Bindings skipped because the total budget was exhausted. */
  readonly budgetExhausted: number;
};

/**
 * Wrap a promise in a wall-clock timeout. Rejects with a tagged error if
 * the deadline passes first. The underlying work is NOT cancelled (there
 * is no cancellation token on a Discord REST call) — it is simply
 * abandoned so the drain can move on.
 */
async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Relay every not-yet-completed subagent thread to its parent, BEFORE the
 * Discord client is destroyed during daemon shutdown.
 *
 * Never throws — shutdown must always proceed. Every failure path is
 * logged and counted; the result object is for the shutdown log line.
 */
export async function drainPendingSubagentRelays(
  deps: DrainPendingSubagentRelaysDeps,
): Promise<DrainPendingSubagentRelaysResult> {
  const result: {
    pending: number;
    relayed: number;
    alreadyCompleted: number;
    failed: number;
    budgetExhausted: number;
  } = {
    pending: 0,
    relayed: 0,
    alreadyCompleted: 0,
    failed: 0,
    budgetExhausted: 0,
  };

  let bindings: readonly ThreadBinding[];
  try {
    bindings = await deps.getSubagentBindings();
  } catch (err) {
    deps.log.warn(
      {
        component: "subagent-completion",
        action: "pre-teardown-drain-error",
        phase: "list-bindings",
        error: (err as Error).message,
      },
      "pre-teardown subagent-relay drain — could not list bindings (non-fatal; session-end backstop still runs)",
    );
    return result;
  }

  // Only bindings that have NOT been completed need a relay. A binding
  // with `completedAt` already set was relayed by the explicit tool / a
  // prior path — its session-end callback will dedupe regardless.
  const pending = bindings.filter(
    (b) => b.completedAt === undefined || b.completedAt === null,
  );
  result.pending = pending.length;
  if (pending.length === 0) {
    return result;
  }

  deps.log.info(
    {
      component: "subagent-completion",
      action: "pre-teardown-drain-start",
      pending: pending.length,
    },
    "pre-teardown subagent-relay drain — relaying pending completions before Discord teardown",
  );

  const startedAt = deps.now();
  for (const binding of pending) {
    if (deps.now() - startedAt >= deps.totalBudgetMs) {
      // Budget spent — leave the rest for the session-end callbacks
      // (which fail today, but shutdown must not hang).
      result.budgetExhausted++;
      deps.log.warn(
        {
          component: "subagent-completion",
          action: "pre-teardown-drain-budget-exhausted",
          threadId: binding.threadId,
          sessionName: binding.sessionName,
        },
        "pre-teardown subagent-relay drain — total budget exhausted; skipping remaining binding",
      );
      continue;
    }

    try {
      await withTimeout(
        (async () => {
          // Session-end is delivery-equivalent — force-stamp
          // `lastDeliveryAt` if missing so the relay gate passes. Mirrors
          // the daemon's existing session-end backstop (daemon.ts).
          if (
            binding.lastDeliveryAt === undefined ||
            binding.lastDeliveryAt === null
          ) {
            const stamp = await deps.stampLastDeliveryAt(
              binding.threadId,
              deps.now(),
              true,
            );
            if (!stamp.ok) {
              deps.log.warn(
                {
                  component: "subagent-completion",
                  action: "pre-teardown-drain-stamp-failed",
                  threadId: binding.threadId,
                  reason: stamp.reason,
                },
                "pre-teardown subagent-relay drain — lastDeliveryAt stamp failed (relay may refuse)",
              );
            }
          }
          // Unified path — stamps `completedAt` on success so the later
          // session-end callback dedupes instead of re-firing the relay.
          return relayAndMarkCompletedByThreadId(
            deps.relayDeps,
            binding.threadId,
          );
        })(),
        deps.perBindingTimeoutMs,
        `pre-teardown relay ${binding.threadId}`,
      ).then((relayResult) => {
        if (relayResult.ok && relayResult.reason === "relayed") {
          result.relayed++;
        } else if (
          relayResult.ok &&
          relayResult.reason === "already-completed"
        ) {
          result.alreadyCompleted++;
        } else {
          // disabled / no-binding / spawner-unavailable / delivery-not-confirmed
          result.failed++;
          deps.log.warn(
            {
              component: "subagent-completion",
              action: "pre-teardown-drain-not-relayed",
              threadId: binding.threadId,
              sessionName: binding.sessionName,
              reason: relayResult.reason,
            },
            "pre-teardown subagent-relay drain — relay not delivered for binding",
          );
        }
      });
    } catch (err) {
      result.failed++;
      deps.log.warn(
        {
          component: "subagent-completion",
          action: "pre-teardown-drain-error",
          phase: "relay",
          threadId: binding.threadId,
          sessionName: binding.sessionName,
          error: (err as Error).message,
        },
        "pre-teardown subagent-relay drain — relay threw or timed out (non-fatal; session-end backstop still runs)",
      );
    }
  }

  deps.log.info(
    {
      component: "subagent-completion",
      action: "pre-teardown-drain-complete",
      ...result,
    },
    "pre-teardown subagent-relay drain complete",
  );
  return result;
}
