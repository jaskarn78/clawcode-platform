/**
 * Phase 999.14 — MCP-09 GREEN: stale thread-binding sweep.
 *
 * Periodic sweep that detects bindings whose `lastActivity` is older than a
 * configurable idle threshold (`defaults.threadIdleArchiveAfter`) and routes
 * each through `cleanupThreadWithClassifier`. Belt-and-suspenders against
 * MCP-08 missing edge cases.
 *
 * Contract pinned by `src/discord/__tests__/stale-binding-sweep.test.ts`.
 */

import type { Logger } from "pino";
import type { ThreadBinding, ThreadBindingRegistry } from "./thread-types.js";
import { readThreadRegistry } from "./thread-registry.js";
import {
  cleanupThreadWithClassifier,
  type ThreadCleanupSpawner,
} from "./thread-cleanup.js";
import { isSubagentThreadName } from "../manager/subagent-name.js";

export interface ScanStaleBindingsArgs {
  readonly registry: ThreadBindingRegistry;
  readonly now: number;
  /** Idle threshold in ms. <= 0 disables sweep (returns []). */
  readonly idleMs: number;
}

/**
 * Pure function — return entries where `now - lastActivity > idleMs`.
 * Sorted oldest-first (deterministic for log output).
 * If idleMs <= 0, returns [] (sweep disabled).
 */
export function scanStaleBindings(
  args: ScanStaleBindingsArgs,
): readonly ThreadBinding[] {
  if (args.idleMs <= 0) return [];
  const stale = args.registry.bindings.filter(
    (b) => args.now - b.lastActivity > args.idleMs,
  );
  // Sort by lastActivity ascending (oldest first) for deterministic logs.
  return [...stale].sort((a, b) => a.lastActivity - b.lastActivity);
}

/**
 * Parse an idle-duration string like "24h" / "6h" / "30m" / "30s" / "0".
 * Returns the duration in milliseconds. "0" → 0 (sweep disabled).
 *
 * @throws on unparseable input.
 */
export function parseIdleDuration(input: string): number {
  if (input === "0") return 0;
  const m = input.match(/^(\d+)(h|m|s)$/i);
  if (!m) {
    throw new Error(
      `parseIdleDuration: unparseable input '${input}' (expected e.g. '24h', '30m', '15s', or '0')`,
    );
  }
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  if (unit === "h") return n * 60 * 60 * 1000;
  if (unit === "m") return n * 60 * 1000;
  return n * 1000; // "s"
}

export interface SweepStaleBindingsArgs {
  readonly spawner: ThreadCleanupSpawner;
  readonly registryPath: string;
  readonly now: number;
  readonly idleMs: number;
  readonly log: Logger;
  /**
   * Phase 999.X — optional callback to also stop the bound subagent
   * session after a binding cleanup. Wraps `SessionManager.stopAgent`
   * in production. The sweep ONLY invokes this when the binding's
   * `sessionName` matches `isSubagentThreadName` (auto-spawned
   * subagent thread); operator-defined agent bindings keep prior
   * behavior — binding gets pruned, session stays.
   *
   * Optional for back-compat: existing call sites without subagent
   * lifecycle responsibility (and all current tests that don't pass
   * this) keep working unchanged.
   */
  readonly stopSubagentSession?: (sessionName: string) => Promise<void>;
}

export interface SweepStaleBindingsResult {
  readonly staleCount: number;
  readonly prunedCount: number;
  readonly agents: Readonly<Record<string, number>>;
  /** Phase 999.X — count of subagent sessions stopped this sweep cycle. */
  readonly subagentSessionsStopped: number;
}

/**
 * Periodic sweep — reads registry, calls scanStaleBindings, invokes
 * cleanupThreadWithClassifier per stale entry, emits a single summary
 * warn log per cycle:
 *   { component: 'thread-cleanup', action: 'stale-sweep', staleCount,
 *     prunedCount, agents:{...alphabetical}, idleMs,
 *     msg: 'stale-binding sweep complete' }
 *
 * Behavior:
 *   - idleMs <= 0 → returns immediately, no log (sweep disabled).
 *   - staleCount === 0 → debug-level log only (no warn).
 *   - Individual cleanup failures do not abort the sweep — sweep continues
 *     and the failed entry is excluded from prunedCount.
 */
export async function sweepStaleBindings(
  args: SweepStaleBindingsArgs,
): Promise<SweepStaleBindingsResult> {
  if (args.idleMs <= 0) {
    return {
      staleCount: 0,
      prunedCount: 0,
      agents: {},
      subagentSessionsStopped: 0,
    };
  }

  const registry = await readThreadRegistry(args.registryPath);
  const stale = scanStaleBindings({
    registry,
    now: args.now,
    idleMs: args.idleMs,
  });

  if (stale.length === 0) {
    args.log.debug(
      {
        component: "thread-cleanup",
        action: "stale-sweep",
        staleCount: 0,
        idleMs: args.idleMs,
      },
      "stale-binding sweep: nothing to prune",
    );
    return {
      staleCount: 0,
      prunedCount: 0,
      agents: {},
      subagentSessionsStopped: 0,
    };
  }

  let prunedCount = 0;
  let subagentSessionsStopped = 0;
  const agentCounts = new Map<string, number>();

  for (const binding of stale) {
    let cleanupOk = false;
    try {
      const result = await cleanupThreadWithClassifier({
        spawner: args.spawner,
        registryPath: args.registryPath,
        threadId: binding.threadId,
        agentName: binding.agentName,
        log: args.log,
      });
      cleanupOk = true;
      if (result.bindingPruned) {
        prunedCount += 1;
        agentCounts.set(
          binding.agentName,
          (agentCounts.get(binding.agentName) ?? 0) + 1,
        );
      }
    } catch (err) {
      // Per-entry failure must NOT abort the sweep — log and continue.
      args.log.error(
        {
          component: "thread-cleanup",
          action: "sweep-entry-failed",
          err: String(err),
          threadId: binding.threadId,
          agentName: binding.agentName,
        },
        "stale-binding sweep entry failed; continuing",
      );
    }

    // Phase 999.X — also stop the underlying subagent session when the
    // binding belongs to an auto-spawned subagent thread. Operator-
    // defined agent names (no -nanoid6 suffix) are NEVER stopped.
    // We attempt the stop regardless of whether the Discord-side
    // archive succeeded: the binding being stale (>idleMs) is the
    // signal that the subagent's job is over; even a transient Discord
    // error doesn't change that.
    if (
      args.stopSubagentSession !== undefined &&
      isSubagentThreadName(binding.sessionName)
    ) {
      try {
        await args.stopSubagentSession(binding.sessionName);
        subagentSessionsStopped += 1;
        args.log.info(
          {
            component: "thread-cleanup",
            action: "stop-subagent-session",
            sessionName: binding.sessionName,
            threadId: binding.threadId,
            cleanupOk,
          },
          "stopped subagent session after binding sweep",
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // "Agent X is not running" is a tolerable race with another stop
        // path (auto-archive in subagent-thread-spawner, manual operator
        // stop, etc.); log at info, not error.
        if (msg.includes("not running")) {
          args.log.info(
            {
              component: "thread-cleanup",
              action: "stop-subagent-session",
              sessionName: binding.sessionName,
              err: msg,
            },
            "subagent session already stopped (race tolerated)",
          );
        } else {
          args.log.error(
            {
              component: "thread-cleanup",
              action: "stop-subagent-session-failed",
              err: msg,
              sessionName: binding.sessionName,
              threadId: binding.threadId,
            },
            "stopSubagentSession failed; continuing sweep",
          );
        }
      }
    }
  }

  // Alphabetically-sorted agent counts for deterministic log readability.
  const agents: Record<string, number> = {};
  for (const name of Array.from(agentCounts.keys()).sort()) {
    agents[name] = agentCounts.get(name)!;
  }

  args.log.warn(
    {
      component: "thread-cleanup",
      action: "stale-sweep",
      staleCount: stale.length,
      prunedCount,
      agents,
      idleMs: args.idleMs,
      subagentSessionsStopped,
    },
    "stale-binding sweep complete",
  );

  return {
    staleCount: stale.length,
    prunedCount,
    agents,
    subagentSessionsStopped,
  };
}
