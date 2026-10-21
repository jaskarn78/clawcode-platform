import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Logger } from "pino";
import type { ResolvedAgentConfig } from "../shared/types.js";
import { getAgentMemoryDbPath } from "../shared/agent-paths.js";
import { MemoryStore } from "../memory/store.js";
import { EmbeddingService } from "../memory/embedder.js";
import {
  dualWriteMemoryV2,
  dualWriteChunkV2,
  readMigrationPhase,
} from "../memory/embedding-v2-dual-write.js";
import { V2_WRITE_PHASES } from "../memory/embedding-version.js";
import { int8ToBuffer } from "../memory/embedder-quantize.js";
import { SessionLogger } from "../memory/session-log.js";
import {
  CompactionManager,
  CharacterCountFillProvider,
} from "../memory/compaction.js";
import { TierManager } from "../memory/tier-manager.js";
import { DEFAULT_TIER_CONFIG } from "../memory/tiers.js";
import { saveSummary } from "../memory/context-summary.js";
import { UsageTracker } from "../usage/tracker.js";
import { EpisodeStore } from "../memory/episode-store.js";
import { DocumentStore } from "../documents/store.js";
import { ConversationStore } from "../memory/conversation-store.js";
import { TraceStore } from "../performance/trace-store.js";
import { TraceCollector } from "../performance/trace-collector.js";

/**
 * Manages per-agent memory lifecycle: initialization, cleanup, and accessors.
 *
 * Each agent gets its own MemoryStore, SessionLogger, CompactionManager,
 * TierManager, UsageTracker, and CharacterCountFillProvider.
 */
export class AgentMemoryManager {
  readonly memoryStores: Map<string, MemoryStore> = new Map();
  readonly compactionManagers: Map<string, CompactionManager> = new Map();
  readonly sessionLoggers: Map<string, SessionLogger> = new Map();
  readonly contextFillProviders: Map<string, CharacterCountFillProvider> =
    new Map();
  readonly tierManagers: Map<string, TierManager> = new Map();
  readonly usageTrackers: Map<string, UsageTracker> = new Map();
  readonly episodeStores: Map<string, EpisodeStore> = new Map();
  readonly documentStores: Map<string, DocumentStore> = new Map();
  readonly conversationStores: Map<string, ConversationStore> = new Map();
  readonly traceStores: Map<string, TraceStore> = new Map();
  readonly traceCollectors: Map<string, TraceCollector> = new Map();
  readonly embedder: EmbeddingService = new EmbeddingService();

  constructor(private readonly log: Logger) {}

  /**
   * Initialize memory resources for an agent.
   * Creates MemoryStore, SessionLogger, CompactionManager, TierManager,
   * UsageTracker, and CharacterCountFillProvider.
   */
  initMemory(name: string, config: ResolvedAgentConfig): void {
    try {
      // Phase 75 SHARED-01 — all per-agent runtime DBs/dirs live under
      // memoryPath, not workspace. For dedicated-workspace agents the two
      // paths are identical (loader fallback); for shared-workspace agents
      // (acme family) this gives each agent an isolated memories.db.
      const memoryDir = join(config.memoryPath, "memory");
      if (!existsSync(memoryDir)) {
        mkdirSync(memoryDir, { recursive: true });
      }

      const dbPath = getAgentMemoryDbPath(config.memoryPath);
      const store = new MemoryStore(dbPath);
      this.memoryStores.set(name, store);

      // Phase 999.119 — boot-time self-heal. Rows that reference a memory
      // or chunk which no longer exists (left by deletes that bypassed
      // MemoryStore.delete) wedge the auto-linker and tier maintenance
      // with "FOREIGN KEY constraint failed". Removing them here means a
      // restart is always a clean slate. Non-fatal; ~100 ms on the largest
      // fleet DB.
      try {
        const repaired = store.repairIntegrity();
        if (repaired.total > 0) {
          this.log.warn(
            { agent: name, ...repaired },
            "memory integrity repaired at boot — dangling rows removed",
          );
        }
      } catch (error) {
        this.log.warn(
          { agent: name, error: (error as Error).message },
          "memory integrity repair failed (non-fatal)",
        );
      }

      // Phase 141 — best-effort embedding-v2 dual-write. When this agent's
      // embedding migration is mid-flight, also write the v2 vector for each
      // NEW memory/chunk at write time so v2 keeps pace with v1 (the re-embed
      // backfill's forward cursor never revisits writes landed behind it).
      // Fire-and-forget + best-effort: never blocks or fails the v1 write. CLI
      // / bulk-import stores construct MemoryStore directly without these hooks
      // → they opt out (the backfill handles bulk imports).
      const dualWriteDeps = {
        store,
        embedder: this.embedder,
        agent: name,
        log: this.log,
      };
      store.setEmbeddingV2Hook((id, content) => {
        void dualWriteMemoryV2(dualWriteDeps, id, content);
      });
      store.setChunkEmbeddingV2Hook((id, body) => {
        void dualWriteChunkV2(dualWriteDeps, id, body);
      });

      // Phase 999.119 v2 switch — pre-warm bge-small when this agent reads
      // or writes v2, so the first turn after a restart does not pay the
      // ~200 ms model load inside its retrieval. Best-effort, detached.
      if (V2_WRITE_PHASES.has(readMigrationPhase({ store, agent: name }))) {
        void this.embedder.warmupV2().catch((error: unknown) => {
          this.log.warn(
            { agent: name, error: (error as Error).message },
            "embedding-v2 warmup failed (non-fatal; lazy warm on first use)",
          );
        });
      }

      const sessionLogger = new SessionLogger(memoryDir);
      this.sessionLoggers.set(name, sessionLogger);

      const compactionManager = new CompactionManager({
        memoryStore: store,
        embedder: this.embedder,
        sessionLogger,
        log: this.log,
      });
      this.compactionManagers.set(name, compactionManager);

      // Create a fill provider for heartbeat monitoring
      const fillProvider = new CharacterCountFillProvider();
      this.contextFillProviders.set(name, fillProvider);

      // Create TierManager for this agent
      const tierConfig = config.memory?.tiers ?? DEFAULT_TIER_CONFIG;
      const tierManager = new TierManager({
        store,
        embedder: this.embedder,
        memoryDir,
        tierConfig,
        scoringConfig: {
          semanticWeight: config.memory?.decay?.semanticWeight ?? 0.7,
          decayWeight: config.memory?.decay?.decayWeight ?? 0.3,
          halfLifeDays: config.memory?.decay?.halfLifeDays ?? 30,
        },
        log: this.log,
        agentName: name,
      });
      this.tierManagers.set(name, tierManager);

      // Create EpisodeStore for this agent
      const episodeStore = new EpisodeStore(store, this.embedder);
      this.episodeStores.set(name, episodeStore);

      // Create DocumentStore for this agent (shares same SQLite DB)
      const documentStore = new DocumentStore(store.getDatabase());
      this.documentStores.set(name, documentStore);

      // Create ConversationStore for this agent (Phase 64 -- shares memories.db connection)
      const conversationStore = new ConversationStore(store.getDatabase());
      this.conversationStores.set(name, conversationStore);

      // Phase 999.42 capability A (CONTEXT D2) — one-shot summary-only
      // backfill for sessions summarized before this phase shipped. The
      // `session_archive_backfill_v1` migrations-row guard makes this a
      // no-op on every boot after the first, so an unconditional call here
      // is safe (a stray double-call short-circuits to alreadyRun:true).
      // It lives inside the surrounding try/catch — already non-fatal:
      // a backfill failure logs and memory init continues.
      const backfill = conversationStore.backfillSessionArchive(
        this.log.child({ agent: name, component: "session-archive-backfill" }),
      );
      if (!backfill.alreadyRun) {
        this.log.info(
          {
            agent: name,
            backfilled: backfill.backfilled,
            skipped: backfill.skipped,
          },
          "session archive backfill complete",
        );
      }

      // Create UsageTracker for this agent
      const usageDbPath = join(memoryDir, "usage.db");
      const usageTracker = new UsageTracker(usageDbPath);
      this.usageTrackers.set(name, usageTracker);

      // Create TraceStore + TraceCollector for this agent (Phase 50)
      // Per-agent traces.db at <memoryPath>/traces.db mirrors usage.db isolation pattern.
      // Turn lifecycle is caller-owned (DiscordBridge/Scheduler construct Turn via
      // TraceCollector.startTurn) — SessionManager is pure passthrough.
      // Phase 75 SHARED-01 — memoryPath (not workspace) so shared-workspace
      // agents get isolated traces.db.
      const tracesDbPath = join(config.memoryPath, "traces.db");
      const traceStore = new TraceStore(tracesDbPath);
      this.traceStores.set(name, traceStore);
      const traceCollector = new TraceCollector(
        traceStore,
        this.log.child({ agent: name, component: "trace" }),
      );
      this.traceCollectors.set(name, traceCollector);

      this.log.info({ agent: name, dbPath }, "memory initialized");
    } catch (error) {
      this.log.error(
        { agent: name, error: (error as Error).message },
        "failed to initialize memory (non-fatal)",
      );
    }
  }

  /**
   * Clean up memory resources for an agent.
   * Closes the MemoryStore and UsageTracker, removes from all maps.
   */
  cleanupMemory(name: string): void {
    const store = this.memoryStores.get(name);
    if (store) {
      try {
        store.close();
      } catch (error) {
        this.log.warn(
          { agent: name, error: (error as Error).message },
          "error closing memory store",
        );
      }
      this.memoryStores.delete(name);
    }
    this.compactionManagers.delete(name);
    this.sessionLoggers.delete(name);
    this.contextFillProviders.delete(name);
    this.tierManagers.delete(name);
    this.episodeStores.delete(name);
    this.documentStores.delete(name);
    this.conversationStores.delete(name);
    // No close() needed -- EpisodeStore, DocumentStore and ConversationStore all
    // read through the same DB connection that MemoryStore closes above

    const usageTracker = this.usageTrackers.get(name);
    if (usageTracker) {
      try {
        usageTracker.close();
      } catch (error) {
        this.log.warn(
          { agent: name, error: (error as Error).message },
          "error closing usage tracker",
        );
      }
      this.usageTrackers.delete(name);
    }

    // Close TraceStore (Phase 50) — mirrors UsageTracker cleanup exactly.
    const traceStore = this.traceStores.get(name);
    if (traceStore) {
      try {
        traceStore.close();
      } catch (error) {
        this.log.warn(
          { agent: name, error: (error as Error).message },
          "failed to close trace store",
        );
      }
      this.traceStores.delete(name);
    }
    this.traceCollectors.delete(name);
  }

  /**
   * Persist a context summary after compaction.
   * Saves to the agent's memory directory for injection on next resume.
   *
   * Phase 75 SHARED-01 — takes memoryPath (not workspace) so shared-workspace
   * agents write context summaries into their private per-agent memory dir.
   */
  async saveContextSummary(
    agentName: string,
    memoryPath: string,
    summary: string,
  ): Promise<void> {
    const memoryDir = join(memoryPath, "memory");
    await saveSummary(memoryDir, agentName, summary);
    this.log.info({ agent: agentName }, "context summary saved");
  }

  /**
   * Store SOUL.md as a retrievable memory entry for an agent (LOAD-02).
   *
   * Reads SOUL.md from the agent's workspace and inserts it as a high-importance
   * memory with tags ["soul", "identity"]. Idempotent — skips insert if a "soul"
   * tagged entry already exists.
   */
  async storeSoulMemory(name: string, config: ResolvedAgentConfig): Promise<void> {
    const store = this.memoryStores.get(name);
    if (!store) return;

    try {
      const soulPath = join(config.workspace, "SOUL.md");
      const soulContent = await readFile(soulPath, "utf-8");

      const existingSoul = store.findByTag("soul");
      if (existingSoul.length === 0) {
        const embedding = await this.embedder.embed(soulContent);
        store.insert(
          {
            content: soulContent,
            source: "system",
            importance: 1.0,
            tags: ["soul", "identity"],
            skipDedup: true,
          },
          embedding,
        );
        this.log.info({ agent: name }, "Stored SOUL.md as memory entry");
      }
    } catch {
      // No SOUL.md or embedding failure — not fatal
    }
  }

  /**
   * Pre-warm the embedding model at daemon startup.
   * Call before starting any agents to avoid cold-start latency.
   */
  async warmupEmbeddings(): Promise<void> {
    await this.embedder.warmup();
    this.log.info("embedding model warmed up");
  }

  /**
   * Phase 56 Plan 01 — run READ-ONLY warmup queries on the three per-agent
   * SQLite databases (memories.db, usage.db, traces.db) to prime the page
   * cache and prepared-statement plan cache.
   *
   * INVARIANT: NO INSERT/UPDATE/DELETE anywhere in this body. Warmup must
   * never alter on-disk state operators expect untouched after a restart.
   *
   * Budget: ≤ 200ms per agent total on SSD (empty tables).
   *
   * @throws Error if the agent has no MemoryStore registered or if any
   *         query fails; the thrown message names the offending DB so
   *         operators can attribute the failure.
   */
  async warmSqliteStores(name: string): Promise<{
    readonly memories_ms: number;
    readonly usage_ms: number;
    readonly traces_ms: number;
  }> {
    const store = this.memoryStores.get(name);
    if (!store) {
      throw new Error(
        `warmSqliteStores: no MemoryStore for agent '${name}'`,
      );
    }
    const usageTracker = this.usageTrackers.get(name);
    const traceStore = this.traceStores.get(name);

    // memories.db — 3 READ queries. The vec0 MATCH primes the sqlite-vec
    // extension so the first real memory_lookup does not pay the extension
    // boot cost.
    const t0 = performance.now();
    try {
      const db = store.getDatabase();
      db.prepare("SELECT COUNT(*) AS n FROM memories").get();
      db.prepare(
        "SELECT id, tier, importance FROM memories ORDER BY accessed_at DESC LIMIT 1",
      )
        .all();
      db.prepare(
        "SELECT memory_id FROM vec_memories WHERE embedding MATCH ? AND k = 1",
      )
        .all(new Float32Array(384));
      // Phase 999.119 v2 switch — prime the v2 table too when reads use it.
      if (store.getEmbeddingReadVersion() === "v2") {
        db.prepare(
          "SELECT memory_id FROM vec_memories_v2 WHERE embedding MATCH vec_int8(?) AND k = 1",
        )
          .all(int8ToBuffer(new Int8Array(384)));
      }
    } catch (e) {
      throw new Error(
        `warmSqliteStores[memories]: ${(e as Error).message}`,
      );
    }
    const memories_ms = performance.now() - t0;

    // usage.db — 2 READ queries. Uses the real `timestamp` column (ISO text).
    const t1 = performance.now();
    if (usageTracker) {
      try {
        const udb = usageTracker.getDatabase();
        udb.prepare("SELECT COUNT(*) AS n FROM usage_events").get();
        udb.prepare(
          "SELECT session_id FROM usage_events WHERE timestamp > ? ORDER BY timestamp DESC LIMIT 1",
        )
          .all(
            new Date(Date.now() - 24 * 60 * 60 * 1000)
              .toISOString()
              .replace("Z", "")
              .slice(0, 19),
          );
      } catch (e) {
        throw new Error(
          `warmSqliteStores[usage]: ${(e as Error).message}`,
        );
      }
    }
    const usage_ms = performance.now() - t1;

    // traces.db — 3 READ queries. The LEFT JOIN primes the span retention
    // query plan (see 50-RESEARCH.md pitfall 4).
    const t2 = performance.now();
    if (traceStore) {
      try {
        const tdb = traceStore.getDatabase();
        tdb.prepare("SELECT COUNT(*) AS n FROM traces").get();
        tdb.prepare("SELECT COUNT(*) AS n FROM trace_spans").get();
        tdb.prepare(
          "SELECT t.id FROM traces t LEFT JOIN trace_spans s ON s.turn_id = t.id LIMIT 1",
        )
          .all();
      } catch (e) {
        throw new Error(
          `warmSqliteStores[traces]: ${(e as Error).message}`,
        );
      }
    }
    const traces_ms = performance.now() - t2;

    return Object.freeze({ memories_ms, usage_ms, traces_ms });
  }
}
