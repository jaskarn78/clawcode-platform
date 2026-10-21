/**
 * Phase 999.14 — MCP-08 GREEN: Discord thread cleanup with classified-error
 * registry pruning.
 *
 * Wraps `subagentThreadSpawner.archiveThread` so that when Discord returns
 * 50001 (Missing Access) or 10003 (Unknown Channel) — both indicating the
 * thread is gone server-side — the registry binding is pruned manually.
 * Transient errors (5xx, 429, network) leave the registry intact for the
 * next sweep to retry.
 *
 * Contract pinned by `src/discord/__tests__/thread-cleanup.test.ts` (17 tests).
 */

import type { Logger } from "pino";
import type { ThreadBindingRegistry } from "./thread-types.js";
import {
  mutateThreadRegistry,
  removeBinding,
} from "./thread-registry.js";

/** Network error codes — treated as transient (retain) per MCP-08 truth table. */
const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

/**
 * Classification of a Discord cleanup error (error path only).
 *   - "prune"   — Discord says the thread is gone server-side. Safe to
 *                 prune the registry binding.
 *   - "retain"  — Transient error (5xx, 429, network). Leave registry
 *                 intact so the next sweep can retry.
 *   - "unknown" — Anything else. Caller treats as retain (conservative).
 */
export type DiscordCleanupClassification = "prune" | "retain" | "unknown";

/**
 * Classification including the success path (used by cleanupThreadWithClassifier
 * return value to distinguish "archived OK" from the error paths).
 */
export type CleanupClassification =
  | "success"
  | DiscordCleanupClassification;

/**
 * Pure function — given an error from a Discord setArchived attempt,
 * classify whether the binding should be pruned, retained, or unknown.
 *
 * Truth table (MCP-08):
 *   - 50001 / 10003 / HTTP 404 → "prune"
 *   - HTTP 5xx / 429 / network codes (ECONNRESET, ETIMEDOUT, ENOTFOUND,
 *     EAI_AGAIN) → "retain"
 *   - everything else → "unknown" (caller treats as retain)
 */
export function classifyDiscordCleanupError(
  err: unknown,
): DiscordCleanupClassification {
  if (err == null || typeof err !== "object") return "unknown";
  const e = err as { code?: number | string; status?: number };
  if (e.code === 50001 || e.code === 10003) return "prune";
  if (typeof e.status === "number") {
    if (e.status === 404) return "prune";
    if (e.status === 429) return "retain";
    if (e.status >= 500 && e.status < 600) return "retain";
  }
  if (typeof e.code === "string" && NETWORK_ERROR_CODES.has(e.code)) {
    return "retain";
  }
  return "unknown";
}

/**
 * Minimal spawner surface needed by the cleanup helper. Defined as a
 * structural type so tests can pass `vi.fn()` without instantiating the
 * full SubagentThreadSpawner class.
 */
export interface ThreadCleanupSpawner {
  archiveThread(
    threadId: string,
    opts?: { lock?: boolean },
  ): Promise<{ bindingPruned: boolean }>;
}

export interface CleanupThreadArgs {
  readonly spawner: ThreadCleanupSpawner;
  readonly registryPath: string;
  readonly threadId: string;
  readonly agentName: string;
  readonly log: Logger;
  readonly lock?: boolean;
}

export interface CleanupThreadResult {
  readonly archived: boolean;
  readonly bindingPruned: boolean;
  readonly classification: CleanupClassification;
}

/**
 * Archive a Discord thread with classified-error cleanup semantics.
 *
 * Behavior contract (pinned by thread-cleanup.test.ts):
 *   - Happy path: spawner.archiveThread resolves → returns
 *     { archived:true, bindingPruned, classification:"success" }.
 *     No warn log emitted.
 *   - Discord 50001 / 10003 / 404 → registry pruned via removeBinding +
 *     writeThreadRegistry, returns
 *     { archived:false, bindingPruned:true, classification:"prune" }.
 *     Canonical warn log emitted: { component:'thread-cleanup',
 *     action:'prune-after-discord-error', discordCode, threadId, agentName }.
 *   - 5xx / 429 / network → registry NOT pruned, returns
 *     { archived:false, bindingPruned:false, classification:"retain" }.
 *     Info-level log only (5xx storms must not blow up logs).
 *   - Unknown error → registry NOT pruned, returns
 *     { archived:false, bindingPruned:false, classification:"unknown" }.
 */
export async function cleanupThreadWithClassifier(
  args: CleanupThreadArgs,
): Promise<CleanupThreadResult> {
  try {
    const result = await args.spawner.archiveThread(args.threadId, {
      lock: args.lock,
    });
    return {
      archived: true,
      bindingPruned: result.bindingPruned,
      classification: "success",
    };
  } catch (err) {
    const cls = classifyDiscordCleanupError(err);
    const discordCode = (err as { code?: number | string }).code;
    if (cls === "prune") {
      // Manually prune the registry binding — Discord side is already gone.
      let pruned = false;
      try {
        // 999.65 — atomic read-modify-write. Always write — Discord-side
        // is gone, so the on-disk state must reflect that even if
        // removeBinding returns the same reference (binding wasn't there).
        // Idempotent on disk.
        await mutateThreadRegistry(args.registryPath, (current) =>
          removeBinding(current, args.threadId),
        );
        pruned = true;
      } catch (writeErr) {
        args.log.error(
          {
            component: "thread-cleanup",
            action: "prune-write-failed",
            err: String(writeErr),
            threadId: args.threadId,
            agentName: args.agentName,
          },
          "registry prune write failed (binding may persist)",
        );
      }
      args.log.warn(
        {
          component: "thread-cleanup",
          action: "prune-after-discord-error",
          discordCode,
          threadId: args.threadId,
          agentName: args.agentName,
        },
        "discord thread gone server-side; pruned registry binding",
      );
      return {
        archived: false,
        bindingPruned: pruned,
        classification: "prune",
      };
    }
    // retain / unknown — info log only, leave registry intact.
    args.log.info(
      {
        component: "thread-cleanup",
        action: "retain-on-transient-error",
        discordCode,
        threadId: args.threadId,
        agentName: args.agentName,
        classification: cls,
      },
      "transient discord error; retained registry binding for next sweep",
    );
    return {
      archived: false,
      bindingPruned: false,
      classification: cls,
    };
  }
}

/**
 * Re-export so the sweep helper (MCP-09) and the IPC handler (MCP-10)
 * can use a single ThreadBindingRegistry symbol.
 */
export type { ThreadBindingRegistry };
