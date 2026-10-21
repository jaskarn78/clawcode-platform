/**
 * Phase 124 Plan 01 T-05 — end-to-end integration test for handleCompactSession.
 *
 * Exercises the hybrid compaction primitive against a real MemoryStore +
 * real CompactionManager + real SessionLogger, with the SDK forkSession
 * call stubbed. Asserts the revised D-04 acceptance criteria:
 *
 *   - memory.db `memories` row count grows by exactly N (extracted facts).
 *   - All ORIGINAL memory IDs are preserved (no destructive deletion).
 *   - `vec_memories` virtual table grows by the same N.
 *   - CompactionResult.summary is non-empty.
 *   - IPC payload reports `summary_written: true` and `memories_created` === N.
 *
 * Phase 999.75 Part B — Layer 2 replaced the fork+swap full-copy step with
 * native `/compact`. The main test now drives the native-compact path via
 * the `sendCompactCommand` + `getContextUsage` DI seams and asserts
 * `live_reduced:true` + `tokens_after < tokens_before`. `forked_to` is
 * always `null` on the native path (no fork).
 *
 * Test runs in-memory (`:memory:` SQLite + tmpdir for session-log files).
 * No network calls.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";

import { MemoryStore } from "../../memory/store.js";
import type { EmbeddingService } from "../../memory/embedder.js";
import {
  CompactionManager,
  type ConversationTurn,
} from "../../memory/compaction.js";
import { SessionLogger } from "../../memory/session-log.js";
import { handleCompactSession } from "../daemon-compact-session-ipc.js";

/** Build a normalized random 384-dim embedding (matches store test fixtures). */
function randomEmbedding(): Float32Array {
  const arr = new Float32Array(384);
  for (let i = 0; i < 384; i++) {
    arr[i] = (Math.random() * 2 - 1) * 0.1;
  }
  let norm = 0;
  for (let i = 0; i < 384; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < 384; i++) arr[i] /= norm;
  return arr;
}

/** Deterministic per-text embedding — same text → same vector. */
function deterministicEmbedding(text: string): Float32Array {
  const arr = new Float32Array(384);
  let seed = 0;
  for (let i = 0; i < text.length; i++) {
    seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
  }
  for (let i = 0; i < 384; i++) {
    // LCG-ish; deterministic per (seed, i)
    const x = ((seed + i * 2654435761) >>> 0) / 0xffffffff;
    arr[i] = x - 0.5;
  }
  let norm = 0;
  for (let i = 0; i < 384; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < 384; i++) arr[i] /= norm;
  return arr;
}

const SILENT_LOG = pino({ level: "silent" });

describe("handleCompactSession — integration (revised D-04)", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
  });

  it(
    "extracts memories into memory.db; preserves original ids; runs native /compact",
    async () => {
      // Disable dedup so the baseline entries + extracted facts don't merge
      // (deterministicEmbedding for "baseline-N" is close enough across N to
      // trip the default dedup similarity threshold).
      const store = new MemoryStore(":memory:", {
        enabled: false,
        similarityThreshold: 0.85,
      });
      const tmp = await mkdtemp(join(tmpdir(), "compact-session-it-"));
      const sessionLogger = new SessionLogger(tmp);

      // Pre-populate memory.db with 5 baseline entries (the "pre-state").
      const preExistingIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const entry = store.insert(
          { content: `baseline-${i}: prior memory entry`, source: "manual" },
          deterministicEmbedding(`baseline-${i}`),
        );
        preExistingIds.push(entry.id);
      }

      const db = store.getDatabase();
      const memCountBefore = (
        db
          .prepare("SELECT COUNT(*) AS n FROM memories")
          .get() as { n: number }
      ).n;
      const vecCountBefore = (
        db
          .prepare("SELECT COUNT(*) AS n FROM vec_memories")
          .get() as { n: number }
      ).n;
      expect(memCountBefore).toBe(5);
      expect(vecCountBefore).toBe(5);

      // Build a real CompactionManager wired against the real store.
      // CompactionManager only calls `embedder.embed()` (see compaction.ts:157);
      // the rest of EmbeddingService is unused on this path, so we narrow the
      // stub to match the test-stub pattern used elsewhere (e.g.
      // session-summarizer.test.ts createMockEmbedder).
      const cm = new CompactionManager({
        memoryStore: store,
        embedder: {
          embed: async (text: string) => deterministicEmbedding(text),
        } as unknown as EmbeddingService,
        sessionLogger,
        log: SILENT_LOG,
      });

      // Synthesize 50+ conversation turns so the compaction sees a real
      // payload (matches T-05 acceptance criterion).
      const conversation: ConversationTurn[] = [];
      for (let i = 0; i < 52; i++) {
        conversation.push({
          timestamp: "2026-05-14T12:00:00Z",
          role: i % 2 === 0 ? "user" : "assistant",
          content: `turn-${i}: User's favorite color is purple. discussion-line-${i}.`,
        });
      }

      const ORIGINAL_SID = "orig-11111111-2222-3333-4444-555555555555";

      // Phase 999.75 Part B — fake the native /compact DI seams. The
      // `sendCompactCommand` fake records that /compact was dispatched;
      // `getContextUsage` returns a shrinking before/after pair so the
      // handler observes `tokens_after < tokens_before`.
      const compactCommands: string[] = [];
      const sendCompactCommand = async (command: string): Promise<string> => {
        compactCommands.push(command);
        return "compacted";
      };
      let usageCall = 0;
      const getContextUsage = async (): Promise<{ totalTokens: number }> => {
        usageCall += 1;
        // First call (before) → 50_000; second call (after) → 12_000.
        return { totalTokens: usageCall === 1 ? 50_000 : 12_000 };
      };

      // Hardcoded extractor: returns 3 distinct facts. Mirrors the test-stub
      // pattern called out in plan T-05.
      const FACTS = [
        "User's favorite color is purple.",
        "Plan 124-01 ships a hybrid compaction primitive.",
        "Path B defers the live-handle hot-swap to a follow-up plan.",
      ] as const;
      const extractMemories = async () =>
        Object.freeze(FACTS.slice()) as readonly string[];

      // Stub manager surface — wire the real CompactionManager via the
      // canonical compactForAgent path (mirrors session-manager.ts:2203
      // logic without instantiating the full SessionManager).
      const result = await handleCompactSession(
        { agent: "synthetic-test" },
        {
          manager: {
            getSessionHandle: () => ({
              sessionId: ORIGINAL_SID,
              hasActiveTurn: () => false,
            }),
            getConversationTurns: () => conversation,
            getContextFillProvider: () => undefined,
            compactForAgent: async (_name, conv, ex) => cm.compact(conv, ex),
            hasCompactionManager: () => true,
          },
          sendCompactCommand,
          getContextUsage,
          extractMemories,
          log: SILENT_LOG,
          daemonReady: true,
        },
      );

      // --- Success-shape assertions ---
      expect(result.ok).toBe(true);
      if (!result.ok) return; // type guard
      expect(result.summary_written).toBe(true);
      expect(result.forked_to).toBeNull();
      expect(result.memories_created).toBe(FACTS.length);
      // Phase 999.75 Part B — native /compact ran and the live window shrank.
      expect(result.live_reduced).toBe(true);
      expect(result.skip_reason).toBeUndefined();
      expect(result.tokens_before).toBe(50_000);
      expect(result.tokens_after).toBe(12_000);

      // --- native /compact dispatch shape ---
      expect(compactCommands).toEqual(["/compact"]);

      // --- D-04 revised: memory.db GROWS BY DESIGN ---
      const memCountAfter = (
        db
          .prepare("SELECT COUNT(*) AS n FROM memories")
          .get() as { n: number }
      ).n;
      const vecCountAfter = (
        db
          .prepare("SELECT COUNT(*) AS n FROM vec_memories")
          .get() as { n: number }
      ).n;
      expect(memCountAfter).toBe(memCountBefore + FACTS.length);
      expect(vecCountAfter).toBe(vecCountBefore + FACTS.length);

      // --- D-04 revised: ALL ORIGINAL chunk IDs preserved ---
      for (const id of preExistingIds) {
        const row = store.getById(id);
        expect(row).not.toBeNull();
      }

      // --- new chunks are queryable via vec search (recall probe) ---
      // The probe fact is "User's favorite color is purple." — the same text
      // is one of the extracted FACTS, embedded deterministically, so a
      // nearest-neighbor query against vec_memories returns it as a top hit.
      const probeEmbedding = deterministicEmbedding(
        "User's favorite color is purple.",
      );
      const results = store.searchMemoriesVec(probeEmbedding, 1);
      expect(results.length).toBeGreaterThan(0);
      // searchMemoriesVec returns {memory_id, distance}; hydrate via getById.
      const hit = store.getById(results[0].memory_id);
      expect(hit).not.toBeNull();
      expect(hit?.content).toBe("User's favorite color is purple.");

      cleanup = async () => {
        store.close();
        await rm(tmp, { recursive: true, force: true });
      };
    },
    30_000,
  );

  it("returns AGENT_NOT_RUNNING when no handle exists", async () => {
    const result = await handleCompactSession(
      { agent: "ghost" },
      {
        manager: {
          getSessionHandle: () => undefined,
          getConversationTurns: () => [],
          getContextFillProvider: () => undefined,
          compactForAgent: async () => {
            throw new Error("should not be called");
          },
          hasCompactionManager: () => true,
        },
        sdkForkSession: async () => ({ sessionId: "never" }),
        extractMemories: async () => [],
        log: SILENT_LOG,
        daemonReady: true,
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("AGENT_NOT_RUNNING");
  });

  it("returns AGENT_NOT_INITIALIZED when CompactionManager missing", async () => {
    const result = await handleCompactSession(
      { agent: "uninit" },
      {
        manager: {
          getSessionHandle: () => ({
            sessionId: "x",
            hasActiveTurn: () => false,
          }),
          getConversationTurns: () => [],
          getContextFillProvider: () => undefined,
          compactForAgent: async () => {
            throw new Error("should not be called");
          },
          hasCompactionManager: () => false,
        },
        sdkForkSession: async () => ({ sessionId: "never" }),
        extractMemories: async () => [],
        log: SILENT_LOG,
        daemonReady: true,
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("AGENT_NOT_INITIALIZED");
  });

  it("returns DAEMON_NOT_READY when daemonReady=false", async () => {
    const result = await handleCompactSession(
      { agent: "boot-window" },
      {
        manager: {
          getSessionHandle: () => undefined,
          getConversationTurns: () => [],
          getContextFillProvider: () => undefined,
          compactForAgent: async () => {
            throw new Error("should not be called");
          },
          hasCompactionManager: () => false,
        },
        sdkForkSession: async () => ({ sessionId: "never" }),
        extractMemories: async () => [],
        log: SILENT_LOG,
        daemonReady: false,
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("DAEMON_NOT_READY");
  });
});
