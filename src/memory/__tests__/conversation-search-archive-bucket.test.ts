/**
 * Phase 999.42 capability A (Plan 03 T-02) — the session-archive bucket
 * inside `searchByScope`.
 *
 * T-02 — scope dispatch, origin discriminant, dedup, SEC-01 propagation:
 *   (1) scope='memories' → the archive bucket is NOT consulted.
 *   (2) scope='conversations' and scope='all' → archive hits appear with
 *       origin='session-archive'.
 *   (3) archive hit + session-summary hit for the same sessionId → exactly one
 *       result (the existing sessionId-keyed dedup, extended to session-archive).
 *   (4) archive relevanceScore is in [0,1] (BM25 normalised).
 *   (5) an archive row with has_untrusted_turn=1 does NOT appear in
 *       searchByScope results — the orchestrator's includeUntrustedChannels:
 *       false propagates.
 *
 * T-03 — capability-A end-to-end + memory-tool inheritance (second describe
 * block below):
 *   (6) consolidation-surviving cross-session search at the orchestrator layer.
 *   (7) the production searchByScope-routed memory tool (memory-lookup-handler)
 *       inherits the archive bucket — structural + behavioural proof.
 *
 * Fixture pattern mirrors `conversation-search.test.ts` (DI ScopedSearchDeps)
 * but over a real temp-file db so the `session_archive_*` FTS5 triggers fire.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nanoid } from "nanoid";
import pino from "pino";
import { MemoryStore } from "../store.js";
import { ConversationStore } from "../conversation-store.js";
import { searchByScope } from "../conversation-search.js";
import type {
  ScopedSearchDeps,
  ScopedSearchResult,
} from "../conversation-search.types.js";
import type { EmbeddingService } from "../embedder.js";
import type {
  SummarizeFn,
  SummarizeSessionDeps,
} from "../session-summarizer.types.js";
import { summarizeSession } from "../session-summarizer.js";
import { invokeMemoryLookup } from "../../manager/memory-lookup-handler.js";

/** Stub embedder — the MVP memory path uses substring match; this stays for typing. */
const stubEmbedder = {
  async embed(_text: string): Promise<Float32Array> {
    return new Float32Array(384).fill(0.1);
  },
  async warmup(): Promise<void> {
    /* no-op */
  },
  isReady(): boolean {
    return true;
  },
} as unknown as EmbeddingService;

describe("searchByScope — session-archive bucket (Plan 03 T-02)", () => {
  let dir: string;
  let memStore: MemoryStore;
  let convStore: ConversationStore;

  function setup(): void {
    dir = mkdtempSync(join(tmpdir(), "conv-search-archive-bucket-"));
    memStore = new MemoryStore(join(dir, "memory.db"), {
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
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** Archive a real session via the live `archiveSession` path (archived_from='full'). */
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

  /** Seed a session-summary MemoryEntry tagged `session:<id>`. */
  function seedSummary(sessionId: string, content: string): string {
    const entry = memStore.insert(
      {
        content,
        source: "conversation",
        importance: 0.7,
        tags: ["session-summary", `session:${sessionId}`],
        skipDedup: true,
      },
      new Float32Array(384).fill(0.1),
    );
    return entry.id;
  }

  // -----------------------------------------------------------------
  // T-02 (1) — scope='memories' does not consult the archive bucket
  // -----------------------------------------------------------------
  it("scope='memories' — the archive bucket is NOT consulted", async () => {
    setup();
    archiveFullSession("agent-a", ["archived talk about the heliotrope module"], true);

    const page = await searchByScope(deps(), {
      scope: "memories",
      query: "heliotrope",
      limit: 10,
      offset: 0,
      now: new Date("2026-05-20T12:00:00Z"),
    });
    // No archive hit — the archive content never appears in 'memories' scope.
    expect(page.results.every((r) => r.origin !== "session-archive")).toBe(true);
    expect(page.results).toHaveLength(0);
  });

  // -----------------------------------------------------------------
  // T-02 (2) — scope='conversations' and scope='all' surface archive hits
  // -----------------------------------------------------------------
  it("scope='conversations' surfaces archive hits with origin='session-archive'", async () => {
    setup();
    const sid = archiveFullSession(
      "agent-a",
      ["archived talk about the heliotrope module"],
      true,
    );

    const page = await searchByScope(deps(), {
      scope: "conversations",
      query: "heliotrope",
      limit: 10,
      offset: 0,
      now: new Date("2026-05-20T12:00:00Z"),
    });
    const archiveHits = page.results.filter(
      (r) => r.origin === "session-archive",
    );
    expect(archiveHits).toHaveLength(1);
    expect(archiveHits[0]!.sessionId).toBe(sid);
    expect(archiveHits[0]!.content).toContain("heliotrope");
  });

  it("scope='all' surfaces archive hits with origin='session-archive'", async () => {
    setup();
    const sid = archiveFullSession(
      "agent-a",
      ["archived talk about the heliotrope module"],
      true,
    );

    const page = await searchByScope(deps(), {
      scope: "all",
      query: "heliotrope",
      limit: 10,
      offset: 0,
      now: new Date("2026-05-20T12:00:00Z"),
    });
    const archiveHits = page.results.filter(
      (r) => r.origin === "session-archive",
    );
    expect(archiveHits).toHaveLength(1);
    expect(archiveHits[0]!.sessionId).toBe(sid);
  });

  // -----------------------------------------------------------------
  // T-02 (3) — archive + summary same-session collision dedupes to one
  // -----------------------------------------------------------------
  it("archive hit + session-summary hit for the same sessionId → exactly one result", async () => {
    setup();
    // A session that has BOTH a full archive row AND a session-summary memory,
    // both matching the query.
    const sid = archiveFullSession(
      "agent-a",
      ["raw turn talk about the deployment cadence"],
      true,
    );
    seedSummary(sid, "session summary about the deployment cadence");

    const page = await searchByScope(deps(), {
      scope: "all",
      query: "deployment cadence",
      limit: 10,
      offset: 0,
      now: new Date("2026-05-20T12:00:00Z"),
    });
    const forSession = page.results.filter((r) => r.sessionId === sid);
    // Exactly one — the existing sessionId-keyed dedup (extended to
    // session-archive) collapses the archive-vs-summary collision.
    expect(forSession).toHaveLength(1);
    // The distilled summary is preferred (Pitfall 4 — same posture as the
    // pre-existing summary-vs-turn dedup).
    expect(forSession[0]!.origin).toBe("session-summary");
  });

  // -----------------------------------------------------------------
  // T-02 (4) — archive relevanceScore is BM25-normalised into [0,1]
  // -----------------------------------------------------------------
  it("archive relevanceScore is in [0,1] (BM25 normalised)", async () => {
    setup();
    archiveFullSession(
      "agent-a",
      ["archived talk about the heliotrope module"],
      true,
    );

    const page = await searchByScope(deps(), {
      scope: "conversations",
      query: "heliotrope",
      limit: 10,
      offset: 0,
      now: new Date("2026-05-20T12:00:00Z"),
    });
    const archiveHits = page.results.filter(
      (r) => r.origin === "session-archive",
    );
    expect(archiveHits.length).toBeGreaterThan(0);
    for (const r of archiveHits) {
      expect(r.relevanceScore).toBeGreaterThan(0);
      expect(r.relevanceScore).toBeLessThanOrEqual(1);
      expect(r.combinedScore).toBeGreaterThan(0);
    }
  });

  // -----------------------------------------------------------------
  // T-02 (5) — SEC-01: an has_untrusted_turn=1 archive row never reaches
  //            searchByScope results (includeUntrustedChannels:false propagates)
  // -----------------------------------------------------------------
  it("an untrusted archive row does NOT appear in searchByScope results", async () => {
    setup();
    const trusted = archiveFullSession(
      "agent-a",
      ["trusted channel talk about the quasar calibration"],
      true,
    );
    const untrusted = archiveFullSession(
      "agent-a",
      ["untrusted channel talk about the quasar calibration"],
      false, // has_untrusted_turn=1
    );

    const page = await searchByScope(deps(), {
      scope: "all",
      query: "quasar calibration",
      limit: 10,
      offset: 0,
      now: new Date("2026-05-20T12:00:00Z"),
    });
    const archiveHits = page.results.filter(
      (r) => r.origin === "session-archive",
    );
    // Only the trusted session's archive row surfaces.
    expect(archiveHits.map((r) => r.sessionId)).toContain(trusted);
    expect(archiveHits.map((r) => r.sessionId)).not.toContain(untrusted);
  });

  it("returns frozen result objects (archive hits included)", async () => {
    setup();
    archiveFullSession("agent-a", ["frozen archive content check"], true);
    const page = await searchByScope(deps(), {
      scope: "conversations",
      query: "frozen",
      limit: 10,
      offset: 0,
      now: new Date("2026-05-20T12:00:00Z"),
    });
    const hit = page.results.find(
      (r: ScopedSearchResult) => r.origin === "session-archive",
    );
    expect(hit).toBeDefined();
    expect(Object.isFrozen(hit)).toBe(true);
  });

  it("a query matching nothing returns no archive hits (not an error)", async () => {
    setup();
    archiveFullSession("agent-a", ["only this archived content exists"], true);
    const page = await searchByScope(deps(), {
      scope: "all",
      query: nanoid(),
      limit: 10,
      offset: 0,
      now: new Date("2026-05-20T12:00:00Z"),
    });
    expect(page.results.filter((r) => r.origin === "session-archive")).toHaveLength(
      0,
    );
  });
});

/**
 * Phase 999.42 capability A (Plan 03 T-03) — the end-to-end proofs.
 *
 *   (6) consolidation-surviving cross-session search at the ORCHESTRATOR
 *       layer: a real session recorded → summarized (raw turns pruned,
 *       conversation_turns_fts rows wiped) → `searchByScope` STILL finds it,
 *       via the session-archive bucket. This is capability A's reason to
 *       exist; without it the query returns nothing.
 *   (7) memory-tool inheritance. The production searchByScope-routed MCP tool
 *       is `memory-lookup` (via `invokeMemoryLookup`) — NOT the lazy-load
 *       `clawcode-memory-*` tools, which use the Phase 90 `retrieveMemoryChunks`
 *       path and do NOT route through `searchByScope` (see 999.42-03-SUMMARY
 *       deviation note). Proven both structurally (the handler imports
 *       `searchByScope`) and behaviourally (an archive hit surfaces with the
 *       UNCHANGED `MemoryLookupParams` shape — zero tool-schema change).
 */
describe("searchByScope — capability A end-to-end (Plan 03 T-03)", () => {
  let dir: string;
  let memStore: MemoryStore;
  let convStore: ConversationStore;

  function setup(): void {
    dir = mkdtempSync(join(tmpdir(), "conv-search-archive-e2e-"));
    memStore = new MemoryStore(join(dir, "memory.db"), {
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
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** Archive a real session via the live `archiveSession` path. */
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

  // -----------------------------------------------------------------
  // T-03 (6) — consolidation-surviving cross-session search, END-TO-END.
  // -----------------------------------------------------------------
  it("consolidation-surviving cross-session search — capability A end-to-end", async () => {
    setup();

    // Record a real session with distinctive raw-turn content (all-trusted,
    // so it passes the SEC-01 filter).
    const session = convStore.startSession("agent-a");
    for (let i = 0; i < 4; i++) {
      convStore.recordTurn({
        sessionId: session.id,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Turn ${i} discusses the phlogiston extractor blueprint.`,
        isTrustedChannel: true,
      });
    }
    convStore.endSession(session.id);

    // Summarize → consolidation: archive written, then raw turns pruned.
    const llmSummarize: SummarizeFn = vi
      .fn()
      .mockResolvedValue("## Decisions\n- Shipped it\n");
    const summDeps: SummarizeSessionDeps = {
      conversationStore: convStore,
      memoryStore: memStore,
      embedder: stubEmbedder,
      summarize: llmSummarize,
      log: pino({ level: "silent" }),
    };
    const result = await summarizeSession(
      { agentName: "agent-a", sessionId: session.id },
      summDeps,
    );
    expect(result).toMatchObject({ success: true });

    // The session is CONSOLIDATED — raw turns pruned, conversation_turns_fts
    // rows wiped by the `conversation_turns_ad` trigger.
    expect(convStore.getTurnsForSession(session.id)).toHaveLength(0);

    // ...yet a query for the original raw-turn word STILL resolves at the
    // orchestrator layer — via the session-archive bucket. Without
    // capability A this returns nothing (the turns are gone).
    const page = await searchByScope(deps(), {
      scope: "all",
      query: "phlogiston",
      limit: 10,
      offset: 0,
      now: new Date("2026-05-20T12:00:00Z"),
    });
    const hit = page.results.find((r) => r.sessionId === session.id);
    expect(hit).toBeDefined();
    expect(hit!.origin).toBe("session-archive");
    expect(hit!.content).toContain("phlogiston");
  });

  // -----------------------------------------------------------------
  // T-03 (7) — memory-tool inheritance: structural + behavioural.
  // -----------------------------------------------------------------
  it("memory-lookup handler structurally routes through searchByScope", () => {
    const handlerSrc = readFileSync(
      new URL("../../manager/memory-lookup-handler.ts", import.meta.url),
      "utf8",
    );
    expect(handlerSrc).toContain("searchByScope");
    expect(handlerSrc).toContain('from "../memory/conversation-search.js"');
  });

  it("memory-lookup tool inherits the archive bucket — consolidated-session hit, no schema change", async () => {
    setup();

    // A consolidated session: archived via the live path, turns then pruned.
    const sid = archiveFullSession(
      "agent-a",
      ["the chronosynclastic infundibulum was the key design choice"],
      true,
    );
    convStore.deleteTurnsForSession(sid); // simulate the post-archive prune

    // Call the production memory-lookup handler with the SAME MemoryLookupParams
    // shape an MCP caller uses — no new field, no schema change.
    const response = await invokeMemoryLookup(
      { agent: "agent-a", query: "chronosynclastic", scope: "all" },
      {
        memoryStore: memStore,
        conversationStore: convStore,
        embedder: stubEmbedder,
      },
    );
    expect("results" in response).toBe(true);
    const archiveResult = response.results.find(
      (r) => "origin" in r && r.origin === "session-archive",
    );
    expect(archiveResult).toBeDefined();
    expect(archiveResult!.content).toContain("chronosynclastic");
  });
});
