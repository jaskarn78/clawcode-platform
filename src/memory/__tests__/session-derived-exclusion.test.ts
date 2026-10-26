/**
 * Memory overhaul 2026-10-25 (WP1): session-derived rows (mid-session
 * flushes, session summaries, raw fallbacks) never seed or receive
 * auto:similar links and never reach the hot tier.
 *
 * Live facts the fixes were designed against: on the production host 19 of
 * the 20 hot-tier rows of one agent were mid-session flush rows. They got
 * there through the centrality path (auto:similar backlinks between
 * near-identical flush rows), since access_count never reached 3.
 *
 * Covers SESSION_DERIVED_TAGS, the promotion SQL in
 * MemoryStore.listWarmCandidatesForPromotion (whose inline tag list is
 * pinned to the constant here), TierManager.refreshHotTier /
 * getHotMemories / runMaintenance, and autoLinkMemory / discoverAutoLinks.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { MemoryStore } from "../store.js";
import { TierManager } from "../tier-manager.js";
import {
  DEFAULT_TIER_CONFIG,
  SESSION_DERIVED_TAGS,
  hasSessionDerivedTag,
} from "../tiers.js";
import { autoLinkMemory, discoverAutoLinks } from "../similarity.js";

/** Unit vector mixing axis 0 (weight `w0`) and axis 1. */
function vec(w0: number, axis = 0): Float32Array {
  const v = new Float32Array(384);
  v[axis] = w0;
  v[axis === 0 ? 1 : 0] = Math.sqrt(Math.max(0, 1 - w0 * w0));
  return v;
}

function insertRow(
  db: DatabaseType,
  id: string,
  opts: {
    tags?: readonly string[];
    tier?: string;
    embedding?: Float32Array;
    accessCount?: number;
    importance?: number;
  } = {},
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO memories (id, content, source, importance, access_count, tags, created_at, updated_at, accessed_at, tier)
     VALUES (?, ?, 'conversation', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    `content of ${id}`,
    opts.importance ?? 0.5,
    opts.accessCount ?? 0,
    JSON.stringify(opts.tags ?? []),
    now,
    now,
    now,
    opts.tier ?? "warm",
  );
  db.prepare("INSERT INTO vec_memories (memory_id, embedding) VALUES (?, ?)").run(
    id,
    opts.embedding ?? vec(1),
  );
}

function link(db: DatabaseType, source: string, target: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO memory_links (source_id, target_id, link_text, created_at) VALUES (?, ?, 'auto:similar', ?)",
  ).run(source, target, new Date().toISOString());
}

function tierOf(db: DatabaseType, id: string): string {
  return (db.prepare("SELECT tier FROM memories WHERE id = ?").get(id) as { tier: string }).tier;
}

function linksOf(db: DatabaseType): string[] {
  return (
    db.prepare("SELECT source_id, target_id FROM memory_links ORDER BY source_id, target_id").all() as Array<{
      source_id: string;
      target_id: string;
    }>
  ).map((l) => `${l.source_id}->${l.target_id}`);
}

function autoLinkedAt(db: DatabaseType, id: string): string | null {
  return (db.prepare("SELECT auto_linked_at FROM memories WHERE id = ?").get(id) as {
    auto_linked_at: string | null;
  }).auto_linked_at;
}

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: vi.fn().mockReturnThis(),
  level: "silent",
};

describe("SESSION_DERIVED_TAGS", () => {
  it("lists exactly the flush, summary and raw-fallback tags", () => {
    expect([...SESSION_DERIVED_TAGS].sort()).toEqual(
      ["mid-session", "raw-fallback", "session-summary"],
    );
    expect(Object.isFrozen(SESSION_DERIVED_TAGS)).toBe(true);
  });

  it("hasSessionDerivedTag matches whole tags only", () => {
    expect(hasSessionDerivedTag(["mid-session", "flush:1"])).toBe(true);
    expect(hasSessionDerivedTag(["session-summary"])).toBe(true);
    expect(hasSessionDerivedTag(["raw-fallback"])).toBe(true);
    expect(hasSessionDerivedTag(["session:abc", "mid-session-notes"])).toBe(false);
    expect(hasSessionDerivedTag([])).toBe(false);
  });
});

describe("WP1: session-derived rows never reach the hot tier", () => {
  let store: MemoryStore;
  let db: DatabaseType;

  beforeEach(() => {
    store = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
    db = store.getDatabase();
  });

  afterEach(() => {
    store.close();
  });

  function tierManager(): TierManager {
    return new TierManager({
      store,
      embedder: {} as never,
      memoryDir: "/tmp/wp1-session-derived-unused",
      tierConfig: DEFAULT_TIER_CONFIG,
      scoringConfig: { semanticWeight: 0.7, decayWeight: 0.3, halfLifeDays: 30 },
      log: silentLog as never,
    });
  }

  it("listWarmCandidatesForPromotion excludes every SESSION_DERIVED_TAGS tag (pins the inline SQL list)", () => {
    for (const tag of SESSION_DERIVED_TAGS) {
      insertRow(db, `derived-${tag}`, { tags: [tag, "session:s1"] });
    }
    insertRow(db, "plain", { tags: ["session:s1", "mid-session-notes"] });
    insertRow(db, "untagged");

    const ids = store.listWarmCandidatesForPromotion(100).map((c) => c.id).sort();

    expect(ids).toEqual(["plain", "untagged"]);
  });

  it("refreshHotTier promotes a real hub but not flush rows with the same backlinks and accesses", () => {
    insertRow(db, "flush-hub", { tags: ["mid-session", "session:s1", "flush:1"], accessCount: 10 });
    insertRow(db, "summary-hub", { tags: ["session-summary", "session:s1"], accessCount: 10 });
    insertRow(db, "fact-hub", { accessCount: 10 });
    for (let i = 0; i < 6; i++) {
      insertRow(db, `src-${i}`);
      link(db, `src-${i}`, "flush-hub");
      link(db, `src-${i}`, "summary-hub");
      link(db, `src-${i}`, "fact-hub");
    }

    tierManager().refreshHotTier();

    expect(tierOf(db, "fact-hub")).toBe("hot");
    expect(tierOf(db, "flush-hub")).toBe("warm");
    expect(tierOf(db, "summary-hub")).toBe("warm");
  });

  it("refreshHotTier demotes session-derived rows already in the hot tier and frees their slots", () => {
    for (let i = 0; i < 20; i++) {
      insertRow(db, `old-flush-${i}`, { tags: ["mid-session", "session:s1"], tier: "hot" });
    }
    insertRow(db, "fact", { accessCount: 5 });

    const result = tierManager().refreshHotTier();

    expect(result.demoted).toBe(20);
    for (let i = 0; i < 20; i++) expect(tierOf(db, `old-flush-${i}`)).toBe("warm");
    expect(tierOf(db, "fact")).toBe("hot");
  });

  it("getHotMemories never returns session-derived rows, even ones still marked hot", () => {
    insertRow(db, "hot-flush", { tags: ["mid-session"], tier: "hot", importance: 0.9 });
    insertRow(db, "hot-summary", { tags: ["session-summary"], tier: "hot", importance: 0.9 });
    insertRow(db, "hot-raw", { tags: ["raw-fallback"], tier: "hot", importance: 0.9 });
    insertRow(db, "hot-fact", { tier: "hot", importance: 0.6 });

    const hot = tierManager().getHotMemories();

    expect(hot.map((m) => m.id)).toEqual(["hot-fact"]);
  });

  it("runMaintenance leaves no session-derived row hot", () => {
    for (let i = 0; i < 5; i++) {
      insertRow(db, `flush-${i}`, { tags: ["mid-session", "session:s1"], tier: i < 2 ? "hot" : "warm", accessCount: 9 });
    }
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 5; j++) if (i !== j) link(db, `flush-${i}`, `flush-${j}`);
    }

    const result = tierManager().runMaintenance();

    expect(result.errors).toBe(0);
    const hotDerived = db
      .prepare(
        `SELECT COUNT(*) AS n FROM memories m WHERE m.tier = 'hot'
         AND EXISTS (SELECT 1 FROM json_each(m.tags) t WHERE t.value IN ('mid-session','session-summary','raw-fallback'))`,
      )
      .get() as { n: number };
    expect(hotDerived.n).toBe(0);
  });
});

describe("WP1: auto-linking skips session-derived rows", () => {
  let store: MemoryStore;
  let db: DatabaseType;

  beforeEach(() => {
    store = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
    db = store.getDatabase();
  });

  afterEach(() => {
    store.close();
  });

  it("autoLinkMemory: a session-derived source creates no links and is stamped as scanned", () => {
    for (const tag of SESSION_DERIVED_TAGS) {
      insertRow(db, `src-${tag}`, { tags: [tag] });
    }
    insertRow(db, "fact", {});

    for (const tag of SESSION_DERIVED_TAGS) {
      const result = autoLinkMemory(store, `src-${tag}`);
      expect(result.linksCreated).toBe(0);
      expect(autoLinkedAt(db, `src-${tag}`)).not.toBeNull();
    }
    expect(linksOf(db)).toEqual([]);
  });

  it("autoLinkMemory: closer session-derived neighbours are skipped and do not crowd out a real one", () => {
    insertRow(db, "fact-a", { embedding: vec(1) });
    // Ten flush rows identical to fact-a: all closer than the real neighbour.
    for (let i = 0; i < 10; i++) {
      insertRow(db, `flush-${i}`, { tags: ["mid-session", "session:s1"], embedding: vec(1) });
    }
    insertRow(db, "summary", { tags: ["session-summary"], embedding: vec(1) });
    insertRow(db, "fact-b", { embedding: vec(0.9) });

    const result = autoLinkMemory(store, "fact-a");

    expect(result.linksCreated).toBe(2);
    expect(linksOf(db)).toEqual(["fact-a->fact-b", "fact-b->fact-a"]);
  });

  it("discoverAutoLinks: session-derived candidates are stamped and skipped, real ones link past them", () => {
    insertRow(db, "fact-a", { embedding: vec(1) });
    insertRow(db, "fact-b", { embedding: vec(0.95) });
    for (let i = 0; i < 8; i++) {
      insertRow(db, `flush-${i}`, { tags: ["mid-session", "session:s1"], embedding: vec(1) });
    }
    insertRow(db, "raw", { tags: ["mid-session", "raw-fallback"], embedding: vec(1) });

    const result = discoverAutoLinks(store);

    expect(result.errors).toBe(0);
    expect(result.pairsScanned).toBe(11);
    expect(linksOf(db)).toEqual(["fact-a->fact-b", "fact-b->fact-a"]);
    const unstamped = db
      .prepare("SELECT COUNT(*) AS n FROM memories WHERE auto_linked_at IS NULL")
      .get() as { n: number };
    expect(unstamped.n).toBe(0);
  });

  it("without session-derived rows nearby, linking is unchanged (five neighbours considered)", () => {
    insertRow(db, "hub", { embedding: vec(1) });
    for (let i = 0; i < 8; i++) {
      insertRow(db, `n-${i}`, { embedding: vec(0.99 - i * 0.01) });
    }

    const result = autoLinkMemory(store, "hub");

    expect(result.pairsScanned).toBe(5);
    expect(result.linksCreated).toBe(10);
  });
});
