/**
 * Phase 999.42 capability A (Plan 03 T-01) — `ConversationStore.searchArchive`.
 *
 * The retrieval side of capability A: FTS5 MATCH over `session_archive_fts`,
 * the index that survives the consolidation prune. Tests prove:
 *  - matches are returned BM25-ordered with a correct `totalMatches`;
 *  - an empty / whitespace query is safe (never throws);
 *  - SEC-01 default-exclude: with no `includeUntrustedChannels`, an archive row
 *    with `has_untrusted_turn=1` is EXCLUDED from both results and totalMatches;
 *  - with `includeUntrustedChannels: true`, that same row IS included;
 *  - a `summary-only` archive row (always `has_untrusted_turn=0`) is matchable.
 *
 * Fixture pattern mirrors `conversation-store-archive-e2e.test.ts`: a real
 * temp-file `better-sqlite3` db so the `session_archive_*` FTS5 triggers fire.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nanoid } from "nanoid";
import { MemoryStore } from "../store.js";
import { ConversationStore } from "../conversation-store.js";

describe("ConversationStore.searchArchive (Plan 03 T-01)", () => {
  let dir: string;
  let memStore: MemoryStore;
  let convStore: ConversationStore;

  function setup(): void {
    dir = mkdtempSync(join(tmpdir(), "conv-search-archive-"));
    memStore = new MemoryStore(join(dir, "memory.db"), {
      enabled: false,
      similarityThreshold: 0.85,
    });
    convStore = new ConversationStore(memStore.getDatabase());
  }

  afterEach(() => {
    memStore?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Archive a real session with the given turns via the live `archiveSession`
   * path (so `archived_from='full'`). `trusted` controls whether the turns
   * come from a trusted channel — i.e. whether the archive row ends up with
   * `has_untrusted_turn` 0 or 1.
   */
  function archiveFullSession(
    agentName: string,
    contents: readonly string[],
    trusted: boolean,
  ): string {
    const session = convStore.startSession(agentName);
    for (let i = 0; i < contents.length; i++) {
      convStore.recordTurn({
        sessionId: session.id,
        role: i % 2 === 0 ? "user" : "assistant",
        content: contents[i]!,
        isTrustedChannel: trusted,
      });
    }
    convStore.endSession(session.id);
    convStore.archiveSession(session.id);
    return session.id;
  }

  /**
   * Seed a `summary-only` archive row directly. A real `conversation_sessions`
   * row is created first to satisfy the `session_archive.session_id` FK; the
   * archive row is then inserted via `archiveSessionInsert` semantics (a plain
   * INSERT here exercises the `session_archive_ai` FTS5 trigger).
   */
  function seedSummaryOnlyArchive(agentName: string, fullText: string): string {
    const session = convStore.startSession(agentName);
    convStore.endSession(session.id);
    const now = new Date().toISOString();
    memStore
      .getDatabase()
      .prepare(
        `INSERT INTO session_archive
           (session_id, agent_name, started_at, ended_at, turn_count,
            total_tokens, summary_memory_id, archived_at, archived_from,
            has_untrusted_turn, full_text)
         VALUES (?, ?, ?, ?, 0, 0, NULL, ?, 'summary-only', 0, ?)`,
      )
      .run(session.id, agentName, now, now, now, fullText);
    return session.id;
  }

  it("returns archive rows matching the FTS5 query with a correct totalMatches", () => {
    setup();
    const sid = archiveFullSession(
      "agent-a",
      ["Discussed the phlogiston extractor design at length."],
      true,
    );
    archiveFullSession("agent-a", ["Unrelated chatter about lunch plans."], true);

    const page = convStore.searchArchive("phlogiston", {
      limit: 10,
      offset: 0,
    });
    expect(page.results).toHaveLength(1);
    expect(page.totalMatches).toBe(1);
    expect(page.results[0]!.sessionId).toBe(sid);
    expect(page.results[0]!.archivedFrom).toBe("full");
    expect(page.results[0]!.hasUntrustedTurn).toBe(false);
    expect(page.results[0]!.fullText).toContain("phlogiston");
    expect(typeof page.results[0]!.bm25Score).toBe("number");
  });

  it("orders results by BM25 ascending (most relevant first)", () => {
    setup();
    // A row mentioning the term twice should score better (lower BM25) than a
    // row mentioning it once amid unrelated text.
    const strong = archiveFullSession(
      "agent-a",
      ["chronosynclastic chronosynclastic infundibulum core."],
      true,
    );
    archiveFullSession(
      "agent-a",
      [
        "A long passage about many topics that only mentions the " +
          "chronosynclastic term a single time near the end.",
      ],
      true,
    );

    const page = convStore.searchArchive("chronosynclastic", {
      limit: 10,
      offset: 0,
    });
    expect(page.results.length).toBe(2);
    expect(page.results[0]!.sessionId).toBe(strong);
    // BM25 ascending — the first result's score is <= the second's.
    expect(page.results[0]!.bm25Score).toBeLessThanOrEqual(
      page.results[1]!.bm25Score,
    );
  });

  it("an empty / whitespace query is safe and returns zero results", () => {
    setup();
    archiveFullSession("agent-a", ["Some archived content here."], true);

    expect(() => convStore.searchArchive("", { limit: 10, offset: 0 })).not.toThrow();
    const empty = convStore.searchArchive("", { limit: 10, offset: 0 });
    expect(empty.results).toHaveLength(0);
    expect(empty.totalMatches).toBe(0);

    const whitespace = convStore.searchArchive("   ", { limit: 10, offset: 0 });
    expect(whitespace.results).toHaveLength(0);
    expect(whitespace.totalMatches).toBe(0);
  });

  it("an agent-crafted query with FTS5-reserved characters does not crash the parser", () => {
    setup();
    archiveFullSession("agent-a", ["Talked about the deployment pipeline."], true);

    // `:` and `()` are FTS5-reserved — escapeFtsQuery phrase-quotes them.
    expect(() =>
      convStore.searchArchive("deployment: (pipeline)", { limit: 10, offset: 0 }),
    ).not.toThrow();
  });

  it("SEC-01 default-exclude: an has_untrusted_turn=1 row is EXCLUDED with no includeUntrustedChannels", () => {
    setup();
    const trusted = archiveFullSession(
      "agent-a",
      ["Trusted channel talk about the quasar calibration."],
      true,
    );
    archiveFullSession(
      "agent-a",
      ["Untrusted channel talk about the quasar calibration."],
      false, // untrusted → has_untrusted_turn=1
    );

    // Default options (no includeUntrustedChannels) — only the trusted row.
    const page = convStore.searchArchive("quasar", { limit: 10, offset: 0 });
    expect(page.results).toHaveLength(1);
    expect(page.totalMatches).toBe(1);
    expect(page.results[0]!.sessionId).toBe(trusted);
    expect(page.results[0]!.hasUntrustedTurn).toBe(false);
  });

  it("SEC-01 explicit-include: includeUntrustedChannels:true includes the untrusted row", () => {
    setup();
    archiveFullSession(
      "agent-a",
      ["Trusted channel talk about the quasar calibration."],
      true,
    );
    const untrusted = archiveFullSession(
      "agent-a",
      ["Untrusted channel talk about the quasar calibration."],
      false,
    );

    const page = convStore.searchArchive("quasar", {
      limit: 10,
      offset: 0,
      includeUntrustedChannels: true,
    });
    expect(page.results).toHaveLength(2);
    expect(page.totalMatches).toBe(2);
    const untrustedHit = page.results.find((r) => r.sessionId === untrusted);
    expect(untrustedHit).toBeDefined();
    expect(untrustedHit!.hasUntrustedTurn).toBe(true);
  });

  it("a summary-only archive row is matchable (always passes the SEC-01 filter)", () => {
    setup();
    const sid = seedSummaryOnlyArchive(
      "agent-a",
      "## Decisions\n- Adopted the cryostat regulation strategy",
    );

    const page = convStore.searchArchive("cryostat", { limit: 10, offset: 0 });
    expect(page.results).toHaveLength(1);
    expect(page.results[0]!.sessionId).toBe(sid);
    expect(page.results[0]!.archivedFrom).toBe("summary-only");
    expect(page.results[0]!.hasUntrustedTurn).toBe(false);
  });

  it("pagination: limit + offset slice the result set", () => {
    setup();
    for (let i = 0; i < 5; i++) {
      archiveFullSession("agent-a", [`paginate token entry number ${i}`], true);
    }

    const first = convStore.searchArchive("paginate", { limit: 2, offset: 0 });
    expect(first.results).toHaveLength(2);
    expect(first.totalMatches).toBe(5);

    const second = convStore.searchArchive("paginate", { limit: 2, offset: 2 });
    expect(second.results).toHaveLength(2);
    expect(second.totalMatches).toBe(5);

    const third = convStore.searchArchive("paginate", { limit: 2, offset: 4 });
    expect(third.results).toHaveLength(1);
    expect(third.totalMatches).toBe(5);
  });

  it("returns frozen result objects and a frozen envelope", () => {
    setup();
    archiveFullSession("agent-a", ["frozen check archived content"], true);
    const page = convStore.searchArchive("frozen", { limit: 10, offset: 0 });
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(page.results)).toBe(true);
    expect(Object.isFrozen(page.results[0])).toBe(true);
  });

  it("a query matching nothing returns an empty page (not an error)", () => {
    setup();
    archiveFullSession("agent-a", ["only this content exists"], true);
    // `nanoid()` produces a token guaranteed absent from the corpus.
    const page = convStore.searchArchive(nanoid(), { limit: 10, offset: 0 });
    expect(page.results).toHaveLength(0);
    expect(page.totalMatches).toBe(0);
  });
});
