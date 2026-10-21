import { join } from "node:path";

/**
 * Canonical per-agent memories.db path. Anchored at
 * `<memoryPath>/memory/memories.db`.
 *
 * `AgentMemoryManager.initMemory` (`src/manager/session-memory.ts:57,62`) is
 * the source of truth for where the running daemon opens the DB. Every other
 * reader/writer (translator CLI, memory-backfill CLI, migration verifier,
 * standalone import scripts, etc.) must funnel through this helper so a path
 * mismatch can never re-introduce the orphan-DB class of bug fixed in Phase
 * 99-A.
 *
 * Pinned by the `agent-paths.regression.test.ts` static-grep test — any
 * direct `join(... , "memories.db")` outside `__tests__/` and this file
 * fails CI.
 */
export function getAgentMemoryDbPath(memoryPath: string): string {
  return join(memoryPath, "memory", "memories.db");
}
