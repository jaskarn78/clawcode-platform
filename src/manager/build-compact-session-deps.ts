/**
 * Phase 999.75 Part B — shared `CompactSessionDeps` builder.
 *
 * `handleCompactSession` is called from TWO sites in `daemon.ts`:
 *   - the heartbeat auto-trigger closure (`setCompactSessionTrigger`), and
 *   - the manual `case "compact-session"` IPC handler.
 *
 * Part A's `loadCompactionTurns` established the precedent: anything shared
 * by both compaction call sites lives in a single helper so the two sites
 * stay byte-identical (the CONTEXT D-06 anti-bifurcation gate). Part B adds
 * two more DI seams — `sendCompactCommand` and `getContextUsage` — both
 * handle-backed. This module owns their construction so each call site
 * carries ONE call instead of two duplicated handle-wiring blocks that
 * could silently drift.
 *
 * The `extractMemories` closure is deliberately NOT built here: it differs
 * per call site (each threads its own Tier-1/Tier-2 extractor + the
 * `loadCompactionTurns` tool-aware text). The caller passes it in.
 */
import { buildNativePromptString } from "./native-cc-commands.js";
import type { SessionHandle } from "./session-adapter.js";
import type { SessionManager } from "./session-manager.js";
import type {
  CompactLogger,
  CompactManagerLike,
  CompactSessionDeps,
  ExtractMemoriesFn,
  GetContextUsageFn,
  SendCompactCommandFn,
} from "./daemon-compact-session-ipc.js";

/**
 * Build the `manager` projection the handler reads. Identical at both call
 * sites — extracted so the two never drift (anti-bifurcation).
 */
export function buildCompactManagerLike(
  manager: SessionManager,
): CompactManagerLike {
  return {
    getSessionHandle: (n) => manager.getSessionHandle(n),
    getConversationTurns: (n) => {
      const sid = manager.getActiveConversationSessionId(n);
      const store = manager.getConversationStore(n);
      if (!sid || !store) return [];
      // Map ConversationStore.ConversationTurn → compaction.ConversationTurn.
      // The compaction primitive only reads {timestamp, role, content}.
      // System turns are dropped (compaction shape is user|assistant only).
      return store
        .getTurnsForSession(sid)
        .filter((t) => t.role !== "system")
        .map((t) => ({
          timestamp: t.createdAt,
          role: t.role as "user" | "assistant",
          content: t.content,
        }));
    },
    getContextFillProvider: (n) => manager.getContextFillProvider(n),
    compactForAgent: (n, conv, ex) => manager.compactForAgent(n, conv, ex),
    // No public CompactionManager accessor — mirror the throw guard at
    // session-manager.ts:2208 via the SessionLogger surface (created in the
    // same memory-init step, so its presence is a faithful proxy).
    hasCompactionManager: (n) => manager.getSessionLogger(n) !== undefined,
  };
}

/**
 * Phase 999.75 Part B (B6) — build the `sendCompactCommand` DI seam.
 *
 * Dispatches the native `/compact` slash command through the live handle's
 * `sendAndCollect`, which routes through the SerialTurnQueue (depth-1) so
 * `/compact` cannot interleave with an in-flight user turn. The SDK treats
 * `/compact` as a local command and the call resolves on the turn `result`.
 *
 * `buildNativePromptString("compact", undefined)` yields the canonical
 * `/compact` string (same builder every other native-CC dispatch site uses).
 */
export function buildSendCompactCommand(
  handle: SessionHandle,
): SendCompactCommandFn {
  return (command: string): Promise<string> => {
    // `command` is always the canonical "/compact" the handler passes;
    // normalize through buildNativePromptString defensively so the bare
    // `/compact` form is guaranteed (strips any clawcode- prefix).
    const bare = buildNativePromptString(
      command.replace(/^\//, ""),
      undefined,
    );
    return handle.sendAndCollect(bare);
  };
}

/**
 * Phase 999.75 Part B (B6) — build the `getContextUsage` DI seam, or
 * `undefined` when the handle does not expose it.
 *
 * Production `createPersistentSessionHandle` handles implement
 * `getContextUsage` (delegates to SDK `Query.getContextUsage()`). Legacy
 * `wrapSdkQuery` handles and mock fixtures do NOT — the handler then fails
 * open (no live reduction). Mirrors the additive-optional `swap?` pattern.
 */
export function buildGetContextUsage(
  handle: SessionHandle,
): GetContextUsageFn | undefined {
  if (typeof handle.getContextUsage !== "function") return undefined;
  const fn = handle.getContextUsage;
  return () => fn();
}

/**
 * Phase 999.75 Part B — assemble the full `CompactSessionDeps` for one
 * compaction call site.
 *
 * Both daemon call sites call this with the SAME shape; the only per-site
 * input is the `extractMemories` closure (which threads each site's own
 * tiered extractor + tool-aware text — see `loadCompactionTurns`).
 *
 * When the agent has no live handle the returned deps still carry the
 * `manager` projection — the handler itself resolves
 * `getSessionHandle(agent)` and returns `AGENT_NOT_RUNNING`. The
 * `sendCompactCommand`/`getContextUsage` seams are left undefined in that
 * case (Layer 2 cannot run without a handle anyway).
 */
export function buildCompactSessionDeps(args: {
  readonly agent: string;
  readonly manager: SessionManager;
  readonly extractMemories: ExtractMemoriesFn;
  readonly log: CompactLogger;
  readonly turnStartedAt: ReadonlyMap<string, number>;
}): CompactSessionDeps {
  const handle = args.manager.getSessionHandle(args.agent);
  return {
    manager: buildCompactManagerLike(args.manager),
    extractMemories: args.extractMemories,
    log: args.log,
    daemonReady: true,
    turnStartedAt: args.turnStartedAt,
    ...(handle !== undefined
      ? {
          sendCompactCommand: buildSendCompactCommand(handle),
          getContextUsage: buildGetContextUsage(handle),
        }
      : {}),
  };
}
