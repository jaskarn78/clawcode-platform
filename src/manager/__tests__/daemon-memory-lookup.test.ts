/**
 * Phase 68-02 — daemon memory-lookup IPC handler integration tests.
 *
 * Exercises the end-to-end wiring from IPC param → scope branching →
 * GraphSearch (legacy) OR searchByScope (new) → SQL → response envelope.
 * Uses REAL in-memory MemoryStore + ConversationStore (not mocks) to
 * honor the 67-VERIFICATION lesson: tests that only exercise helper
 * functions miss production wiring gaps.
 *
 * These tests call `invokeMemoryLookup` directly — the same function
 * the daemon IPC switch case calls at `src/manager/daemon.ts::case "memory-lookup"`.
 * When the handler body changes, this test picks up the change
 * automatically because it runs the same code path.
 *
 * WHEN CHANGING: any update to `invokeMemoryLookup` in
 * `src/manager/memory-lookup-handler.ts` is automatically exercised
 * here. The daemon's IPC switch case is a pure passthrough — keep it
 * that way.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { MemoryStore } from "../../memory/store.js";
import { ConversationStore } from "../../memory/conversation-store.js";
import type { EmbeddingService } from "../../memory/embedder.js";
import { ManagerError } from "../../shared/errors.js";
import { invokeMemoryLookup } from "../memory-lookup-handler.js";

// Deterministic fake embedder — cosine-normalized 384-dim vector derived
// from input text length. Removes the ONNX warmup dependency from the
// test suite (would add ~10s on cold runs) while still producing a
// vector that MemoryStore + sqlite-vec can ingest.
const fakeEmbedder: EmbeddingService = {
  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(384);
    for (let i = 0; i < 384; i++) {
      v[i] = Math.sin(i + text.length);
    }
    let norm = 0;
    for (let i = 0; i < 384; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < 384; i++) v[i] /= norm;
    }
    return v;
  },
} as EmbeddingService;

describe("daemon memory-lookup IPC integration — scope branching", () => {
  let memStore: MemoryStore;
  let convStore: ConversationStore;

  beforeEach(() => {
    memStore = new MemoryStore(":memory:", {
      enabled: false,
      similarityThreshold: 0.85,
    });
    convStore = new ConversationStore(memStore.getDatabase());
  });

  afterEach(() => {
    memStore?.close();
  });

  it("legacy default call (no scope, no page) returns pre-v1.9 response shape", async () => {
    const embedding = await fakeEmbedder.embed("deployment notes");
    memStore.insert(
      {
        content: "Deployment notes for v2",
        source: "manual",
        tags: ["project"],
        skipDedup: true,
      },
      embedding,
    );

    const result = (await invokeMemoryLookup(
      { agent: "agent-a", query: "deployment" },
      {
        memoryStore: memStore,
        conversationStore: convStore,
        embedder: fakeEmbedder,
      },
    )) as unknown as {
      results: Array<Record<string, unknown>>;
      hasMore?: boolean;
    };

    // No paginated envelope fields
    expect(result.hasMore).toBeUndefined();
    // If GraphSearch surfaced anything, the shape is the legacy one
    expect(result.results).toBeDefined();
    if (result.results.length > 0) {
      const first = result.results[0]!;
      expect(first).toHaveProperty("id");
      expect(first).toHaveProperty("content");
      expect(first).toHaveProperty("relevance_score");
      expect(first).toHaveProperty("tags");
      expect(first).toHaveProperty("created_at");
      expect(first).toHaveProperty("source");
      // linked_from is unique to the legacy GraphSearch branch
      expect(first).toHaveProperty("linked_from");
      // New-path fields MUST be absent on the legacy branch
      expect(first).not.toHaveProperty("origin");
      expect(first).not.toHaveProperty("session_id");
    }
  });

  it("explicit scope='memories' with page=0 also routes to legacy branch", async () => {
    const embedding = await fakeEmbedder.embed("test");
    memStore.insert(
      { content: "A test memory", source: "manual", skipDedup: true },
      embedding,
    );

    const result = (await invokeMemoryLookup(
      { agent: "agent-a", query: "test", scope: "memories", page: 0 },
      {
        memoryStore: memStore,
        conversationStore: convStore,
        embedder: fakeEmbedder,
      },
    )) as unknown as {
      results: Array<Record<string, unknown>>;
      hasMore?: boolean;
    };

    expect(result.hasMore).toBeUndefined();
  });

  it("scope='conversations' routes through searchByScope and returns paginated envelope", async () => {
    // Seed a session summary MemoryEntry containing the query term.
    const embedding = await fakeEmbedder.embed("deployment");
    memStore.insert(
      {
        content: "Session S1: discussed deployment strategy",
        source: "conversation",
        tags: ["session-summary", "session:S1"],
        skipDedup: true,
      },
      embedding,
    );

    // Seed a raw turn (FTS5 auto-syncs via trigger).
    const session = convStore.startSession("agent-a");
    convStore.recordTurn({
      sessionId: session.id,
      role: "user",
      content: "we need a deployment plan",
      isTrustedChannel: true,
    });

    const result = (await invokeMemoryLookup(
      {
        agent: "agent-a",
        query: "deployment",
        scope: "conversations",
        page: 0,
        limit: 10,
      },
      {
        memoryStore: memStore,
        conversationStore: convStore,
        embedder: fakeEmbedder,
      },
    )) as unknown as {
      results: Array<{ origin: string; session_id: string | null }>;
      hasMore: boolean;
      nextOffset: number | null;
    };

    expect(result.hasMore).toBeDefined();
    expect(typeof result.hasMore).toBe("boolean");
    expect(result.results.length).toBeGreaterThan(0);
    // Every result must have origin + session_id (new-path shape)
    for (const r of result.results) {
      expect(r.origin).toBeDefined();
      expect(["session-summary", "conversation-turn", "memory"]).toContain(
        r.origin,
      );
    }
    // At least one result should be the session-summary memory
    expect(result.results.some((r) => r.origin === "session-summary")).toBe(
      true,
    );
  });

  it("scope='all' merges memories + session-summaries + raw turns", async () => {
    // Plain knowledge memory
    const e1 = await fakeEmbedder.embed("general deployment knowledge");
    memStore.insert(
      {
        content: "General deployment knowledge: use blue-green",
        source: "manual",
        tags: ["knowledge"],
        skipDedup: true,
      },
      e1,
    );

    // Session summary for sessionA
    const e2 = await fakeEmbedder.embed("deployment summary");
    memStore.insert(
      {
        content: "Session summary: agent discussed deployment rollback plan",
        source: "conversation",
        tags: ["session-summary", "session:sessionA"],
        skipDedup: true,
      },
      e2,
    );

    // Raw turns for a DIFFERENT session (sessionB) so they aren't deduped
    // by dedupPreferSummary
    const sessionB = convStore.startSession("agent-a");
    convStore.recordTurn({
      sessionId: sessionB.id,
      role: "user",
      content: "tell me about our deployment process",
      isTrustedChannel: true,
    });

    const result = (await invokeMemoryLookup(
      { agent: "agent-a", query: "deployment", scope: "all", page: 0, limit: 10 },
      {
        memoryStore: memStore,
        conversationStore: convStore,
        embedder: fakeEmbedder,
      },
    )) as unknown as {
      results: Array<{ origin: string; session_id: string | null }>;
      hasMore: boolean;
      nextOffset: number | null;
    };

    const origins = new Set(result.results.map((r) => r.origin));
    // scope='all' surfaces multiple origins
    expect(origins.size).toBeGreaterThanOrEqual(2);
    expect(result.hasMore).toBeDefined();
  });

  it("pagination — page=1 returns offset = page * limit slice with hasMore tracking", async () => {
    // Seed 12 matching session summaries to exceed MAX_RESULTS_PER_PAGE (10).
    for (let i = 0; i < 12; i++) {
      const emb = await fakeEmbedder.embed(`deployment note ${i}`);
      memStore.insert(
        {
          content: `Session ${i}: deployment discussion notes`,
          source: "conversation",
          tags: ["session-summary", `session:sess-${i}`],
          skipDedup: true,
        },
        emb,
      );
    }

    const page0 = (await invokeMemoryLookup(
      {
        agent: "agent-a",
        query: "deployment",
        scope: "conversations",
        page: 0,
        limit: 10,
      },
      {
        memoryStore: memStore,
        conversationStore: convStore,
        embedder: fakeEmbedder,
      },
    )) as unknown as {
      results: readonly unknown[];
      hasMore: boolean;
      nextOffset: number | null;
    };

    expect(page0.results.length).toBe(10);
    expect(page0.hasMore).toBe(true);
    expect(page0.nextOffset).toBe(10);

    const page1 = (await invokeMemoryLookup(
      {
        agent: "agent-a",
        query: "deployment",
        scope: "conversations",
        page: 1,
        limit: 10,
      },
      {
        memoryStore: memStore,
        conversationStore: convStore,
        embedder: fakeEmbedder,
      },
    )) as unknown as {
      results: readonly unknown[];
      hasMore: boolean;
      nextOffset: number | null;
    };

    expect(page1.results.length).toBe(2);
    expect(page1.hasMore).toBe(false);
    expect(page1.nextOffset).toBeNull();
  });

  it("IPC-layer clamps limit > 10 to 10 (defense-in-depth)", async () => {
    // Seed 15 matches to prove the clamp kicks in at the IPC layer.
    for (let i = 0; i < 15; i++) {
      const emb = await fakeEmbedder.embed(`deployment ${i}`);
      memStore.insert(
        {
          content: `Memory ${i}: deployment info`,
          source: "conversation",
          tags: ["session-summary", `session:s-${i}`],
          skipDedup: true,
        },
        emb,
      );
    }

    // Caller bypasses MCP Zod and passes limit=50 directly.
    const result = (await invokeMemoryLookup(
      {
        agent: "agent-a",
        query: "deployment",
        scope: "all",
        page: 0,
        limit: 50,
      },
      {
        memoryStore: memStore,
        conversationStore: convStore,
        embedder: fakeEmbedder,
      },
    )) as unknown as { results: readonly unknown[] };

    expect(result.results.length).toBeLessThanOrEqual(10);
  });

  it("throws ManagerError when ConversationStore is missing for non-legacy scope", async () => {
    await expect(
      invokeMemoryLookup(
        { agent: "ghost", query: "x", scope: "conversations", page: 0 },
        {
          memoryStore: memStore,
          conversationStore: undefined, // simulate missing wiring
          embedder: fakeEmbedder,
        },
      ),
    ).rejects.toThrow(ManagerError);

    await expect(
      invokeMemoryLookup(
        { agent: "ghost", query: "x", scope: "conversations", page: 0 },
        {
          memoryStore: memStore,
          conversationStore: undefined,
          embedder: fakeEmbedder,
        },
      ),
    ).rejects.toThrow(/ConversationStore not found/);
  });

  it("legacy scope path does NOT require ConversationStore (graceful for legacy-only agents)", async () => {
    const embedding = await fakeEmbedder.embed("fallback test");
    memStore.insert(
      { content: "fallback test memory", source: "manual", skipDedup: true },
      embedding,
    );

    // Should succeed even with conversationStore undefined because the
    // legacy branch doesn't touch it.
    const result = await invokeMemoryLookup(
      { agent: "agent-a", query: "fallback" }, // no scope → legacy
      {
        memoryStore: memStore,
        conversationStore: undefined,
        embedder: fakeEmbedder,
      },
    );

    expect(result.results).toBeDefined();
  });

  /**
   * Phase 68-03 — RETR-03 gap closure regression test.
   *
   * Proves the `retrievalHalfLifeDays` config knob is LIVE end-to-end at
   * runtime, not merely defined in `conversationConfigSchema`. Prior to
   * 68-03 the value was inert: `searchByScope` always fell back to
   * `DEFAULT_RETRIEVAL_HALF_LIFE_DAYS=14` because nothing read the
   * resolved agent config and forwarded it through `MemoryLookupParams`.
   *
   * Test design:
   *   - Two independent `:memory:` stores (separate beforeEach instances
   *     would cross-contaminate; we build them inline to keep the test
   *     hermetic against the outer `beforeEach`).
   *   - Identical aged session-summary memory (10 days old) inserted in
   *     both. We use a direct UPDATE on `accessed_at` because
   *     MemoryStore.insert() doesn't accept an explicit timestamp —
   *     this is the same fixture pattern other decay tests rely on.
   *   - One call uses the default half-life (no `retrievalHalfLifeDays`
   *     param → `DEFAULT_RETRIEVAL_HALF_LIFE_DAYS=14`).
   *   - The other call passes `retrievalHalfLifeDays: 3` — at 10 days
   *     aged that decays roughly 6x faster than the default, producing
   *     a measurably lower combinedScore.
   *
   * Decay math at 10 days:
   *   importance(0.5) * 0.5^(10/14) ≈ 0.305
   *   importance(0.5) * 0.5^(10/3)  ≈ 0.049
   *   combinedScore = 0.7 * relevance + 0.3 * decay
   *   delta(combined) ≈ 0.3 * (0.305 - 0.049) ≈ 0.077
   *   We assert delta > 0.05 to stay above floating-point noise while
   *   still rejecting the "knob is inert" failure mode (delta == 0).
   */
  it("retrievalHalfLifeDays config knob changes decay weighting at runtime", async () => {
    const TEN_DAYS_AGO = new Date(
      Date.now() - 10 * 24 * 60 * 60 * 1000,
    ).toISOString();

    // Independent store pair A — exercised with DEFAULT half-life (14).
    const memStoreA = new MemoryStore(":memory:", {
      enabled: false,
      similarityThreshold: 0.85,
    });
    const convStoreA = new ConversationStore(memStoreA.getDatabase());
    // Independent store pair B — exercised with retrievalHalfLifeDays=3.
    const memStoreB = new MemoryStore(":memory:", {
      enabled: false,
      similarityThreshold: 0.85,
    });
    const convStoreB = new ConversationStore(memStoreB.getDatabase());

    try {
      const embedding = await fakeEmbedder.embed("deployment");
      const content = "We discussed the deployment rollout last month";
      const tags = ["session-summary", "session:aged"];

      // Insert into both stores with skipDedup so identical content lands
      // in both DBs without triggering the dedup short-circuit. Pin
      // importance=1.0 explicitly so MemoryStore.insert's "fall through
      // to calculateImportance when input is undefined or exactly 0.5"
      // branch (store.ts:148) does NOT kick in — keeps the decay-delta
      // math predictable and well above floating-point noise.
      const insertedA = memStoreA.insert(
        { content, source: "conversation", tags, importance: 1, skipDedup: true },
        embedding,
      );
      const insertedB = memStoreB.insert(
        { content, source: "conversation", tags, importance: 1, skipDedup: true },
        embedding,
      );

      // Backdate accessed_at to 10 days ago so the decay component diverges
      // measurably between the two half-life configurations.
      memStoreA
        .getDatabase()
        .prepare("UPDATE memories SET accessed_at = ? WHERE id = ?")
        .run(TEN_DAYS_AGO, insertedA.id);
      memStoreB
        .getDatabase()
        .prepare("UPDATE memories SET accessed_at = ? WHERE id = ?")
        .run(TEN_DAYS_AGO, insertedB.id);

      // Default half-life run (no retrievalHalfLifeDays param).
      const resultDefault = (await invokeMemoryLookup(
        {
          agent: "agent-a",
          query: "deployment",
          scope: "conversations",
          page: 0,
          limit: 10,
        },
        {
          memoryStore: memStoreA,
          conversationStore: convStoreA,
          embedder: fakeEmbedder,
        },
      )) as unknown as {
        results: Array<{
          session_id: string | null;
          relevance_score: number;
        }>;
      };

      // Aggressive half-life run (3 days).
      const resultShort = (await invokeMemoryLookup(
        {
          agent: "agent-a",
          query: "deployment",
          scope: "conversations",
          page: 0,
          limit: 10,
          retrievalHalfLifeDays: 3,
        },
        {
          memoryStore: memStoreB,
          conversationStore: convStoreB,
          embedder: fakeEmbedder,
        },
      )) as unknown as {
        results: Array<{
          session_id: string | null;
          relevance_score: number;
        }>;
      };

      // Both runs must surface the aged memory.
      expect(resultDefault.results.length).toBeGreaterThan(0);
      expect(resultShort.results.length).toBeGreaterThan(0);

      const agedDefault = resultDefault.results.find(
        (r) => r.session_id === "aged",
      );
      const agedShort = resultShort.results.find(
        (r) => r.session_id === "aged",
      );

      expect(agedDefault).toBeDefined();
      expect(agedShort).toBeDefined();

      // Aggressive half-life MUST decay the aged memory more.
      expect(agedShort!.relevance_score).toBeLessThan(
        agedDefault!.relevance_score,
      );

      // Sanity floor — the delta should be well above floating-point noise
      // (calculated ≈ 0.077; see test design comment).
      expect(
        agedDefault!.relevance_score - agedShort!.relevance_score,
      ).toBeGreaterThan(0.05);
    } finally {
      memStoreA.close();
      memStoreB.close();
    }
  });
});

/**
 * Phase 68-02 Task 3 — end-to-end smoke tests that chain real turn
 * recording → real memory insertion → real FTS5 (via trigger) →
 * invokeMemoryLookup → dedup + pagination + response envelope.
 *
 * These tests validate the production chain: if any link in the chain
 * were broken (e.g., FTS5 trigger missed an insert, dedup didn't apply,
 * session_id wasn't propagated), at least one of these assertions
 * would fail. This mirrors the 67-VERIFICATION post-mortem pattern —
 * prove the wiring is live, not just correct in isolation.
 */
describe("end-to-end — searchByScope via IPC handler", () => {
  let memStore: MemoryStore;
  let convStore: ConversationStore;

  beforeEach(() => {
    memStore = new MemoryStore(":memory:", {
      enabled: false,
      similarityThreshold: 0.85,
    });
    convStore = new ConversationStore(memStore.getDatabase());
  });

  afterEach(() => {
    memStore?.close();
  });

  it("scope='all' with real turns + session-summary returns deduplicated summary-first result", async () => {
    // 1. Record 3 raw turns containing "deployment" in a real session.
    const session = convStore.startSession("agent-a");
    convStore.recordTurn({
      sessionId: session.id,
      role: "user",
      content: "planning deployment for v2",
      isTrustedChannel: true,
    });
    convStore.recordTurn({
      sessionId: session.id,
      role: "assistant",
      content: "deployment will use blue-green",
      isTrustedChannel: true,
    });
    convStore.recordTurn({
      sessionId: session.id,
      role: "user",
      content: "deployment timeline is tight",
      isTrustedChannel: true,
    });

    // 2. Insert a session-summary MemoryEntry for the same session.
    //    Tags include the session:<id> pointer so dedup can link
    //    summary ↔ raw turns.
    const embedding = await fakeEmbedder.embed("deployment");
    memStore.insert(
      {
        content: "Session S1: discussed deployment strategy (blue-green)",
        source: "conversation",
        tags: ["session-summary", `session:${session.id}`],
        skipDedup: true,
      },
      embedding,
    );

    // 3. Invoke with scope='all' — chains FTS5 + findByTag + listRecent.
    const result = (await invokeMemoryLookup(
      {
        agent: "agent-a",
        query: "deployment",
        scope: "all",
        page: 0,
        limit: 10,
      },
      {
        memoryStore: memStore,
        conversationStore: convStore,
        embedder: fakeEmbedder,
      },
    )) as unknown as {
      results: Array<{ origin: string; session_id: string | null }>;
      hasMore: boolean;
      nextOffset: number | null;
    };

    // 4. For this session, dedup MUST keep only the summary. Raw turns
    //    get dropped because dedupPreferSummary prefers distilled summaries.
    const forThisSession = result.results.filter(
      (r) => r.session_id === session.id,
    );
    expect(forThisSession.length).toBeGreaterThanOrEqual(1);
    expect(forThisSession.every((r) => r.origin === "session-summary")).toBe(
      true,
    );
    // 5. Pagination envelope present on new-path responses.
    expect(typeof result.hasMore).toBe("boolean");
    expect(result.hasMore).toBe(false);
    expect(result.nextOffset).toBeNull();
  });

  it("backward-compat — pre-v1.9 call without scope returns ONLY legacy fields (no origin/session_id/hasMore)", async () => {
    const embedding = await fakeEmbedder.embed("test");
    memStore.insert(
      {
        content: "A test memory for backward-compat verification",
        source: "manual",
        tags: ["test"],
        skipDedup: true,
      },
      embedding,
    );

    // Pre-v1.9 call signature — exactly what an agent running the older
    // MCP tool would send.
    const result = (await invokeMemoryLookup(
      { agent: "agent-a", query: "test", limit: 5 },
      {
        memoryStore: memStore,
        conversationStore: convStore,
        embedder: fakeEmbedder,
      },
    )) as unknown as {
      results: Array<Record<string, unknown>>;
      hasMore?: boolean;
      nextOffset?: number | null;
    };

    // Legacy-branch envelope — NO pagination fields.
    expect(result.hasMore).toBeUndefined();
    expect(result.nextOffset).toBeUndefined();

    if (result.results.length > 0) {
      const first = result.results[0]!;
      // Legacy keys — ALL present
      expect(first).toHaveProperty("id");
      expect(first).toHaveProperty("content");
      expect(first).toHaveProperty("relevance_score");
      expect(first).toHaveProperty("tags");
      expect(first).toHaveProperty("created_at");
      expect(first).toHaveProperty("source");
      // linked_from is unique to GraphSearch (legacy path).
      expect(first).toHaveProperty("linked_from");
      // New-path fields MUST be absent for backward-compat.
      expect(first).not.toHaveProperty("origin");
      expect(first).not.toHaveProperty("session_id");
    }
  });

  // ---------------------------------------------------------------------------
  // Gap 4 (memory-persistence-gaps) — implicit-default fallback to scope='all'
  //
  // When the caller does NOT explicitly set scope (i.e. params.scope is
  // undefined) AND the legacy default-scope search returns zero results, the
  // handler retries once with scope='all'. Explicit scope='memories' never
  // triggers the fallback — callers that ask for the legacy path get the
  // legacy response shape regardless of result count.
  // ---------------------------------------------------------------------------
  describe("implicit-default fallback to scope='all' (Gap 4)", () => {
    it("falls back to scope='all' when implicit default returns empty AND conversation data matches", async () => {
      // NO memory row is inserted, so the legacy GraphSearch path returns
      // zero rows. But a conversation turn DOES match the query.
      const sessionA = convStore.startSession("agent-a");
      convStore.recordTurn({
        sessionId: sessionA.id,
        role: "user",
        content: "we should schedule the quarterly deployment review",
        isTrustedChannel: true,
      });

      const result = (await invokeMemoryLookup(
        { agent: "agent-a", query: "quarterly deployment review" },
        {
          memoryStore: memStore,
          conversationStore: convStore,
          embedder: fakeEmbedder,
        },
      )) as unknown as {
        results: Array<Record<string, unknown>>;
        hasMore?: boolean;
        nextOffset?: number | null;
      };

      // Fallback fired — response shape is the paginated envelope.
      expect(result.hasMore).toBeDefined();
      expect(result.results.length).toBeGreaterThan(0);
      // At least one result must be a conversation-turn origin (i.e. came
      // from the broader scope='all' search, not the legacy path).
      const origins = result.results.map((r) => r.origin);
      expect(origins).toContain("conversation-turn");
    });

    it("does NOT fall back when implicit default returns non-empty (preserves legacy shape)", async () => {
      // Insert a knowledge memory that DOES match — default scope path hits it.
      const embedding = await fakeEmbedder.embed("deployment strategy");
      memStore.insert(
        {
          content: "Use blue-green for deployment strategy",
          source: "manual",
          tags: ["knowledge"],
          skipDedup: true,
        },
        embedding,
      );

      const result = (await invokeMemoryLookup(
        { agent: "agent-a", query: "deployment strategy" },
        {
          memoryStore: memStore,
          conversationStore: convStore,
          embedder: fakeEmbedder,
        },
      )) as unknown as {
        results: Array<Record<string, unknown>>;
        hasMore?: boolean;
      };

      // Legacy response shape — no hasMore field.
      expect(result.hasMore).toBeUndefined();
      expect(result.results.length).toBeGreaterThan(0);
      const first = result.results[0]!;
      // Legacy path shape preserved.
      expect(first).toHaveProperty("linked_from");
      expect(first).not.toHaveProperty("origin");
    });

    it("does NOT fall back when explicit scope='memories' returns empty (legacy shape preserved)", async () => {
      // No memory inserted; conversation turn DOES match.
      const sessionA = convStore.startSession("agent-a");
      convStore.recordTurn({
        sessionId: sessionA.id,
        role: "user",
        content: "deployment rollback discussion",
        isTrustedChannel: true,
      });

      const result = (await invokeMemoryLookup(
        // NOTE: explicit scope='memories' — caller opted in to legacy path.
        { agent: "agent-a", query: "deployment rollback", scope: "memories" },
        {
          memoryStore: memStore,
          conversationStore: convStore,
          embedder: fakeEmbedder,
        },
      )) as unknown as {
        results: Array<Record<string, unknown>>;
        hasMore?: boolean;
      };

      // Legacy shape; empty results — fallback MUST NOT fire.
      expect(result.hasMore).toBeUndefined();
      expect(result.results).toHaveLength(0);
    });

    it("fallback does not fire when page > 0 (pagination through scoped envelope only)", async () => {
      // No matches anywhere. With default scope + page=1, we're already on
      // the new-path envelope (non-legacy). The fallback is a legacy-path
      // concept; pagination requests stay on whichever scope was requested.
      const result = (await invokeMemoryLookup(
        { agent: "agent-a", query: "nothing-matches-anywhere", page: 1 },
        {
          memoryStore: memStore,
          conversationStore: convStore,
          embedder: fakeEmbedder,
        },
      )) as unknown as {
        results: Array<Record<string, unknown>>;
        hasMore?: boolean;
      };
      // Even though empty, no fallback — page > 0 preserved.
      expect(result.hasMore).toBeDefined();
      expect(result.results).toHaveLength(0);
    });

    it("falls back when implicit-default returns empty AND scope='all' also returns empty (paginated envelope with zero results)", async () => {
      // No data at all — fallback fires, scope='all' also empty.
      const result = (await invokeMemoryLookup(
        { agent: "agent-a", query: "no-such-content-anywhere" },
        {
          memoryStore: memStore,
          conversationStore: convStore,
          embedder: fakeEmbedder,
        },
      )) as unknown as {
        results: Array<Record<string, unknown>>;
        hasMore?: boolean;
      };

      // Shape flipped to paginated envelope because fallback ran — but
      // still empty, which is the correct signal to the caller.
      expect(result.hasMore).toBeDefined();
      expect(result.results).toHaveLength(0);
    });
  });
});

// Phase 999.125 — time windows through the handler
describe("daemon memory-lookup IPC integration — time window (Phase 999.125)", () => {
  let memStore: MemoryStore;
  let convStore: ConversationStore;

  beforeEach(() => {
    memStore = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
    convStore = new ConversationStore(memStore.getDatabase());
  });
  afterEach(() => {
    memStore?.close();
  });

  async function seed(content: string, at: string): Promise<void> {
    const entry = memStore.insert(
      { content, source: "manual", tags: ["note"], skipDedup: true },
      await fakeEmbedder.embed(content),
    );
    memStore
      .getDatabase()
      .prepare("UPDATE memories SET created_at = ?, accessed_at = ?, updated_at = ? WHERE id = ?")
      .run(at, at, at, entry.id);
  }

  it("empty query + window → paginated browse of that window (never the legacy shape)", async () => {
    await seed("July decision about the AC", "2026-07-10T10:00:00.000Z");
    await seed("August note", "2026-08-10T10:00:00.000Z");
    const result = (await invokeMemoryLookup(
      { agent: "agent-a", query: "", since: "2026-07-01", until: "2026-07-31" },
      { memoryStore: memStore, conversationStore: convStore, embedder: fakeEmbedder },
    )) as unknown as { results: Array<Record<string, unknown>>; hasMore?: boolean };
    expect(result.hasMore).toBe(false);
    expect(result.results.map((r) => r.content)).toEqual(["July decision about the AC"]);
    expect(result.results[0]).toHaveProperty("origin", "memory");
  });

  it("relative bounds are accepted and a window forces the scoped path even for scope=memories", async () => {
    await seed("fresh", new Date(Date.now() - 2 * 86_400_000).toISOString());
    await seed("stale", new Date(Date.now() - 40 * 86_400_000).toISOString());
    const result = (await invokeMemoryLookup(
      { agent: "agent-a", query: "", scope: "memories", page: 0, since: "7d" },
      { memoryStore: memStore, conversationStore: convStore, embedder: fakeEmbedder },
    )) as unknown as { results: Array<Record<string, unknown>>; hasMore?: boolean };
    expect(result.hasMore).toBeDefined();
    expect(result.results.map((r) => r.content)).toEqual(["fresh"]);
  });

  it("rejects a bad bound and an empty query without a window", async () => {
    const deps = { memoryStore: memStore, conversationStore: convStore, embedder: fakeEmbedder };
    await expect(
      invokeMemoryLookup({ agent: "agent-a", query: "x", since: "last tuesday" }, deps),
    ).rejects.toThrow(ManagerError);
    await expect(
      invokeMemoryLookup({ agent: "agent-a", query: "x", since: "2026-08-01", until: "2026-07-01" }, deps),
    ).rejects.toThrow(/is after until/);
    await expect(invokeMemoryLookup({ agent: "agent-a", query: "   " }, deps)).rejects.toThrow(
      /query is required/,
    );
  });
});
