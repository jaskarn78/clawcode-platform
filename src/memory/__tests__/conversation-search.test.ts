/**
 * Phase 68 Plan 01 — unit tests for `searchByScope` orchestrator.
 *
 * Covers:
 *   - pagination: MAX_RESULTS_PER_PAGE hard cap, offset-based paging
 *   - hasMore / nextOffset envelope math
 *   - decay weighting (recent beats old given equal raw relevance; `now` injected)
 *   - deduplication (scope='all' prefers session-summary over raw-turn per sessionId)
 *
 * Fixture pattern mirrors `conversation-store.test.ts`: real MemoryStore on
 * `:memory:` with dedup disabled, real ConversationStore over the same DB.
 * `now: Date` is injected so decay math is deterministic — no
 * `vi.setSystemTime()` or `Date.now` monkey-patching.
 *
 * The embedder is a stub (duck-typed) because the MVP orchestrator uses
 * substring matching for memories — no KNN path exercised in unit tests.
 */

import { describe, it, expect, afterEach } from "vitest";
import { MemoryStore } from "../store.js";
import { ConversationStore } from "../conversation-store.js";
import { searchByScope } from "../conversation-search.js";
import type {
  ScopedSearchDeps,
  ScopedSearchResult,
} from "../conversation-search.types.js";
import type { EmbeddingService } from "../embedder.js";

/** Zero-vector normalised embedding — dedup is disabled so content doesn't collide. */
function unitEmbedding(seed = 1): Float32Array {
  const v = new Float32Array(384);
  for (let i = 0; i < 384; i++) v[i] = Math.sin(seed * 7 + i * 0.13);
  let norm = 0;
  for (let i = 0; i < 384; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < 384; i++) v[i] /= norm;
  return v;
}

/** Stub embedder — orchestrator's MVP memory path uses substring match; this
 *  stays here so ScopedSearchDeps typechecks. */
const stubEmbedder = {
  async embed(_text: string): Promise<Float32Array> {
    return unitEmbedding(1);
  },
  async warmup(): Promise<void> {
    /* no-op */
  },
  isReady(): boolean {
    return true;
  },
} as unknown as EmbeddingService;

/** Seed a session-summary MemoryEntry with controllable createdAt + accessedAt. */
function seedSummary(
  memStore: MemoryStore,
  sessionId: string,
  content: string,
  at: string,
  importance = 0.5,
  extraTags: readonly string[] = [],
): string {
  const entry = memStore.insert(
    {
      content,
      source: "conversation",
      importance,
      tags: ["session-summary", `session:${sessionId}`, ...extraTags],
      skipDedup: true,
    },
    unitEmbedding(content.length),
  );
  memStore
    .getDatabase()
    .prepare(
      "UPDATE memories SET created_at = ?, accessed_at = ?, updated_at = ? WHERE id = ?",
    )
    .run(at, at, at, entry.id);
  return entry.id;
}

/** Seed a general (non-summary) memory. */
function seedMemory(
  memStore: MemoryStore,
  content: string,
  at: string,
  tags: readonly string[] = [],
): string {
  const entry = memStore.insert(
    {
      content,
      source: "manual",
      importance: 0.5,
      tags: [...tags],
      skipDedup: true,
    },
    unitEmbedding(content.length),
  );
  memStore
    .getDatabase()
    .prepare(
      "UPDATE memories SET created_at = ?, accessed_at = ?, updated_at = ? WHERE id = ?",
    )
    .run(at, at, at, entry.id);
  return entry.id;
}

/** Record a conversation turn with a controllable createdAt. */
function seedTurn(
  memStore: MemoryStore,
  convStore: ConversationStore,
  sessionId: string,
  content: string,
  at: string,
  isTrustedChannel = true,
): string {
  const turn = convStore.recordTurn({
    sessionId,
    role: "user",
    content,
    isTrustedChannel,
  });
  memStore
    .getDatabase()
    .prepare("UPDATE conversation_turns SET created_at = ? WHERE id = ?")
    .run(at, turn.id);
  return turn.id;
}

describe("searchByScope", () => {
  let memStore: MemoryStore;
  let convStore: ConversationStore;

  function setup(): void {
    memStore = new MemoryStore(":memory:", {
      enabled: false,
      similarityThreshold: 0.85,
    });
    convStore = new ConversationStore(memStore.getDatabase());
  }

  function deps(): ScopedSearchDeps {
    return {
      memoryStore: memStore,
      conversationStore: convStore,
      embedder: stubEmbedder,
    };
  }

  afterEach(() => {
    memStore?.close();
  });

  // ---------------------------------------------------------------
  // Pagination
  // ---------------------------------------------------------------
  describe("pagination", () => {
    it("honors MAX_RESULTS_PER_PAGE hard cap of 10", async () => {
      setup();
      const session = convStore.startSession("agent-a");
      // Seed 15 matching turns
      for (let i = 0; i < 15; i++) {
        seedTurn(
          memStore,
          convStore,
          session.id,
          `foo result ${i}`,
          `2026-04-10T0${i % 10}:00:00Z`,
        );
      }

      // limit:20 must clamp to 10
      const page = await searchByScope(deps(), {
        scope: "all",
        query: "foo",
        limit: 20,
        offset: 0,
        now: new Date("2026-04-15T12:00:00Z"),
      });
      expect(page.results.length).toBe(10);
      expect(page.hasMore).toBe(true);
      expect(page.nextOffset).toBe(10);
    });

    it("limit:5 returns exactly 5 results with nextOffset=5", async () => {
      setup();
      const session = convStore.startSession("agent-a");
      for (let i = 0; i < 15; i++) {
        seedTurn(
          memStore,
          convStore,
          session.id,
          `foo result ${i}`,
          `2026-04-10T0${i % 10}:00:00Z`,
        );
      }

      const page = await searchByScope(deps(), {
        scope: "all",
        query: "foo",
        limit: 5,
        offset: 0,
        now: new Date("2026-04-15T12:00:00Z"),
      });
      expect(page.results.length).toBe(5);
      expect(page.hasMore).toBe(true);
      expect(page.nextOffset).toBe(5);
    });
  });

  // ---------------------------------------------------------------
  // hasMore / nextOffset envelope
  // ---------------------------------------------------------------
  describe("hasMore", () => {
    it("hasMore=false when offset + page covers the full candidate set", async () => {
      setup();
      const session = convStore.startSession("agent-a");
      // Seed 8 matching turns — fewer than the page size
      for (let i = 0; i < 8; i++) {
        seedTurn(
          memStore,
          convStore,
          session.id,
          `bar result ${i}`,
          `2026-04-10T0${i}:00:00Z`,
        );
      }

      const page = await searchByScope(deps(), {
        scope: "conversations",
        query: "bar",
        limit: 10,
        offset: 0,
        now: new Date("2026-04-15T12:00:00Z"),
      });
      expect(page.results.length).toBe(8);
      expect(page.totalCandidates).toBe(8);
      expect(page.hasMore).toBe(false);
      expect(page.nextOffset).toBeNull();
    });

    it("hasMore=true with correct nextOffset on partial page", async () => {
      setup();
      const session = convStore.startSession("agent-a");
      for (let i = 0; i < 12; i++) {
        seedTurn(
          memStore,
          convStore,
          session.id,
          `baz result ${i}`,
          `2026-04-10T0${i % 10}:00:00Z`,
        );
      }

      const first = await searchByScope(deps(), {
        scope: "conversations",
        query: "baz",
        limit: 10,
        offset: 0,
        now: new Date("2026-04-15T12:00:00Z"),
      });
      expect(first.results.length).toBe(10);
      expect(first.hasMore).toBe(true);
      expect(first.nextOffset).toBe(10);

      const second = await searchByScope(deps(), {
        scope: "conversations",
        query: "baz",
        limit: 10,
        offset: 10,
        now: new Date("2026-04-15T12:00:00Z"),
      });
      expect(second.results.length).toBe(2);
      expect(second.hasMore).toBe(false);
      expect(second.nextOffset).toBeNull();
      expect(second.totalCandidates).toBe(12);
    });
  });

  // ---------------------------------------------------------------
  // Decay weighting
  // ---------------------------------------------------------------
  describe("decay", () => {
    it("recent results rank above old ones given equal raw relevance", async () => {
      setup();
      const now = new Date("2026-04-18T12:00:00Z");
      // Two session-summaries with identical importance; one recent, one old.
      const sidRecent = "sess-recent";
      const sidOld = "sess-old";
      const idRecent = seedSummary(
        memStore,
        sidRecent,
        "deployment discussion recent",
        "2026-04-17T12:00:00Z", // 1 day ago
        0.5,
      );
      const idOld = seedSummary(
        memStore,
        sidOld,
        "deployment discussion old",
        "2026-02-17T12:00:00Z", // ~60 days ago
        0.5,
      );

      const page = await searchByScope(deps(), {
        scope: "conversations",
        query: "deployment",
        limit: 10,
        offset: 0,
        now,
      });
      expect(page.results.length).toBe(2);
      // The recent summary must rank first
      expect(page.results[0]!.id).toBe(idRecent);
      expect(page.results[1]!.id).toBe(idOld);
      expect(page.results[0]!.combinedScore).toBeGreaterThan(
        page.results[1]!.combinedScore,
      );
      // Sanity: both have positive scores
      expect(page.results[0]!.combinedScore).toBeGreaterThan(0);
      expect(page.results[1]!.combinedScore).toBeGreaterThan(0);
    });

    it("conversation-turn results use constant importance 0.5 for decay math", async () => {
      setup();
      const now = new Date("2026-04-18T12:00:00Z");
      const session = convStore.startSession("agent-a");
      const recentId = seedTurn(
        memStore,
        convStore,
        session.id,
        "alpha discussion recent",
        "2026-04-17T12:00:00Z",
      );
      const oldId = seedTurn(
        memStore,
        convStore,
        session.id,
        "alpha discussion ancient",
        "2026-02-17T12:00:00Z",
      );

      const page = await searchByScope(deps(), {
        scope: "conversations",
        query: "alpha",
        limit: 10,
        offset: 0,
        now,
      });
      expect(page.results.length).toBe(2);
      // Two identical-content turns (same BM25 relevance) — decay breaks the tie
      // in favour of the recent turn.
      const recent = page.results.find(
        (r: ScopedSearchResult) => r.id === recentId,
      );
      const ancient = page.results.find(
        (r: ScopedSearchResult) => r.id === oldId,
      );
      expect(recent).toBeDefined();
      expect(ancient).toBeDefined();
      expect(recent!.combinedScore).toBeGreaterThan(ancient!.combinedScore);
      expect(page.results[0]!.id).toBe(recentId);
      // All conversation-turn results carry origin === 'conversation-turn'
      for (const r of page.results) {
        expect(r.origin).toBe("conversation-turn");
      }
    });
  });

  // ---------------------------------------------------------------
  // Deduplication (scope='all' prefers session-summary over raw-turn)
  // ---------------------------------------------------------------
  describe("deduplicate", () => {
    it("scope='all' prefers session-summary over raw-turn for same sessionId", async () => {
      setup();
      const now = new Date("2026-04-18T12:00:00Z");

      // Session S1 has BOTH a summary AND matching raw turns
      const s1 = convStore.startSession("agent-a");
      seedSummary(
        memStore,
        s1.id,
        "session summary about deployment strategy",
        "2026-04-17T10:00:00Z",
        0.7,
      );
      seedTurn(
        memStore,
        convStore,
        s1.id,
        "user asked about deployment timeline",
        "2026-04-17T10:00:00Z",
      );
      seedTurn(
        memStore,
        convStore,
        s1.id,
        "assistant explained deployment steps",
        "2026-04-17T10:05:00Z",
      );

      const page = await searchByScope(deps(), {
        scope: "all",
        query: "deployment",
        limit: 10,
        offset: 0,
        now,
      });

      const s1Results = page.results.filter(
        (r: ScopedSearchResult) => r.sessionId === s1.id,
      );
      expect(s1Results.length).toBe(1);
      expect(s1Results[0]!.origin).toBe("session-summary");
      // No conversation-turn results for S1 survive the dedup
      const s1TurnResults = page.results.filter(
        (r: ScopedSearchResult) =>
          r.sessionId === s1.id && r.origin === "conversation-turn",
      );
      expect(s1TurnResults.length).toBe(0);
    });

    it("raw turns are preserved when their session has no matching summary", async () => {
      setup();
      const now = new Date("2026-04-18T12:00:00Z");

      // Session S2 has NO matching summary — only raw turns
      const s2 = convStore.startSession("agent-a");
      seedTurn(
        memStore,
        convStore,
        s2.id,
        "user discussed deployment without summary",
        "2026-04-17T10:00:00Z",
      );
      seedTurn(
        memStore,
        convStore,
        s2.id,
        "another deployment turn also unsummarized",
        "2026-04-17T10:05:00Z",
      );

      const page = await searchByScope(deps(), {
        scope: "all",
        query: "deployment",
        limit: 10,
        offset: 0,
        now,
      });

      const s2Results = page.results.filter(
        (r: ScopedSearchResult) => r.sessionId === s2.id,
      );
      // Both raw turns survive because no summary exists for S2
      expect(s2Results.length).toBe(2);
      for (const r of s2Results) {
        expect(r.origin).toBe("conversation-turn");
      }
    });
  });

  // ---------------------------------------------------------------
  // Additional coverage — scope semantics + snippet truncation + immutability
  // ---------------------------------------------------------------
  describe("scope semantics", () => {
    it("scope='memories' excludes session-summaries AND raw turns", async () => {
      setup();
      const now = new Date("2026-04-18T12:00:00Z");
      const session = convStore.startSession("agent-a");

      // Regular memory that matches
      seedMemory(memStore, "alpha general knowledge memory", "2026-04-10T00:00:00Z");
      // Session-summary that also matches — must NOT appear in 'memories' scope
      seedSummary(
        memStore,
        session.id,
        "alpha session summary",
        "2026-04-11T00:00:00Z",
      );
      // Raw turn that matches — must NOT appear either
      seedTurn(
        memStore,
        convStore,
        session.id,
        "alpha raw turn",
        "2026-04-12T00:00:00Z",
      );

      const page = await searchByScope(deps(), {
        scope: "memories",
        query: "alpha",
        limit: 10,
        offset: 0,
        now,
      });

      // Only the regular memory
      expect(page.results.length).toBe(1);
      expect(page.results[0]!.origin).toBe("memory");
      expect(page.results[0]!.content).toContain("general knowledge");
    });

    it("truncates content > SNIPPET_MAX_CHARS to snippet with ellipsis", async () => {
      setup();
      const now = new Date("2026-04-18T12:00:00Z");
      const sid = "long-summary";
      const longContent = "alpha " + "x".repeat(800);
      seedSummary(memStore, sid, longContent, "2026-04-17T00:00:00Z");

      const page = await searchByScope(deps(), {
        scope: "conversations",
        query: "alpha",
        limit: 10,
        offset: 0,
        now,
      });
      expect(page.results.length).toBe(1);
      const r = page.results[0]!;
      expect(r.content.length).toBe(longContent.length);
      // Snippet is truncated and has an ellipsis suffix
      expect(r.snippet.length).toBeLessThanOrEqual(501); // 500 + 1 ellipsis char
      expect(r.snippet.endsWith("…")).toBe(true);
    });

    it("returns frozen page and frozen result objects", async () => {
      setup();
      const session = convStore.startSession("agent-a");
      seedTurn(
        memStore,
        convStore,
        session.id,
        "freeze check content",
        "2026-04-17T00:00:00Z",
      );

      const page = await searchByScope(deps(), {
        scope: "conversations",
        query: "freeze",
        limit: 10,
        offset: 0,
        now: new Date("2026-04-18T12:00:00Z"),
      });
      expect(Object.isFrozen(page)).toBe(true);
      expect(Object.isFrozen(page.results)).toBe(true);
      expect(Object.isFrozen(page.results[0])).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------
// Phase 999.125 — time windows
// ---------------------------------------------------------------------
describe("searchByScope — time window (Phase 999.125)", () => {
  let memStore: MemoryStore;
  let convStore: ConversationStore;
  const NOW = new Date("2026-09-05T12:00:00Z");
  const JULY = { since: "2026-07-01T00:00:00.000Z", until: "2026-07-31T23:59:59.999Z" };

  function setup(): void {
    memStore = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
    convStore = new ConversationStore(memStore.getDatabase());
  }
  function deps(): ScopedSearchDeps {
    return { memoryStore: memStore, conversationStore: convStore, embedder: stubEmbedder };
  }
  /** Record + end + archive a session, then pin its span. */
  function seedArchivedSession(content: string, startedAt: string, endedAt: string): string {
    const session = convStore.startSession("agent-a");
    seedTurn(memStore, convStore, session.id, content, startedAt);
    convStore.endSession(session.id);
    convStore.archiveSession(session.id);
    const db = memStore.getDatabase();
    db.prepare("UPDATE conversation_sessions SET started_at = ?, ended_at = ? WHERE id = ?").run(startedAt, endedAt, session.id);
    db.prepare("UPDATE session_archive SET started_at = ?, ended_at = ? WHERE session_id = ?").run(startedAt, endedAt, session.id);
    // The archived session's raw turns are pruned in production; mirror that
    // so the archive path (not the turn path) is what answers.
    convStore.deleteTurnsForSession(session.id);
    return session.id;
  }
  afterEach(() => {
    memStore?.close();
  });

  it("with a query, every path is restricted to the window", async () => {
    setup();
    const julyMem = seedMemory(memStore, "budget plan alpha", "2026-07-10T10:00:00.000Z");
    seedMemory(memStore, "budget plan beta", "2026-08-10T10:00:00.000Z");
    const session = convStore.startSession("agent-a");
    const julyTurn = seedTurn(memStore, convStore, session.id, "budget talk in july", "2026-07-15T10:00:00.000Z");
    seedTurn(memStore, convStore, session.id, "budget talk in august", "2026-08-15T10:00:00.000Z");
    // Summaries for OTHER sessions (scope=all dedups a raw turn against its
    // own session's summary; the turn above must survive).
    seedSummary(memStore, "s-july", "budget summary july", "2026-07-20T10:00:00.000Z");
    seedSummary(memStore, "s-aug", "budget summary august", "2026-08-20T10:00:00.000Z");

    const page = await searchByScope(deps(), { scope: "all", query: "budget", limit: 10, offset: 0, now: NOW, ...JULY });
    const ids = page.results.map((r) => r.id);
    expect(ids).toContain(julyMem);
    expect(ids).toContain(julyTurn);
    expect(page.results.every((r) => r.createdAt >= JULY.since && r.createdAt <= JULY.until)).toBe(true);
    expect(page.results.map((r) => r.content)).not.toContain("budget plan beta");
    expect(page.results.map((r) => r.content)).not.toContain("budget talk in august");
    expect(page.results.map((r) => r.content)).not.toContain("budget summary august");
  });

  it("with an empty query, a window is a chronological browse (newest first)", async () => {
    setup();
    seedMemory(memStore, "no keywords here", "2026-07-05T10:00:00.000Z");
    seedMemory(memStore, "outside the window", "2026-06-05T10:00:00.000Z");
    const session = convStore.startSession("agent-a");
    seedTurn(memStore, convStore, session.id, "a plain turn", "2026-07-25T10:00:00.000Z");

    const page = await searchByScope(deps(), { scope: "all", query: "", limit: 10, offset: 0, now: NOW, ...JULY });
    expect(page.results.map((r) => r.content)).toEqual(["a plain turn", "no keywords here"]);
    expect(page.results.map((r) => r.origin)).toEqual(["conversation-turn", "memory"]);
  });

  it("archived sessions match by their span and carry startedAt", async () => {
    setup();
    const inJuly = seedArchivedSession("we discussed the roof", "2026-07-12T09:00:00.000Z", "2026-07-12T10:00:00.000Z");
    seedArchivedSession("we discussed the car", "2026-08-12T09:00:00.000Z", "2026-08-12T10:00:00.000Z");
    // Straddles the boundary: began in June, ended in July → overlaps.
    const straddle = seedArchivedSession("we discussed the fence", "2026-06-30T23:00:00.000Z", "2026-07-01T01:00:00.000Z");

    const browse = await searchByScope(deps(), { scope: "conversations", query: "", limit: 10, offset: 0, now: NOW, ...JULY });
    expect(browse.results.map((r) => r.id)).toEqual([inJuly, straddle]);
    expect(browse.results[0]!.startedAt).toBe("2026-07-12T09:00:00.000Z");
    expect(browse.results[0]!.origin).toBe("session-archive");

    const queried = await searchByScope(deps(), { scope: "conversations", query: "discussed", limit: 10, offset: 0, now: NOW, ...JULY });
    expect(queried.results.map((r) => r.id).sort()).toEqual([inJuly, straddle].sort());
    expect(queried.results.some((r) => r.content.includes("the car"))).toBe(false);
  });

  it("a one-sided window works (since only)", async () => {
    setup();
    seedMemory(memStore, "recent thing", "2026-09-01T10:00:00.000Z");
    seedMemory(memStore, "old thing", "2025-01-01T10:00:00.000Z");
    const page = await searchByScope(deps(), { scope: "memories", query: "thing", limit: 10, offset: 0, now: NOW, since: "2026-08-01T00:00:00.000Z" });
    expect(page.results.map((r) => r.content)).toEqual(["recent thing"]);
  });
});
