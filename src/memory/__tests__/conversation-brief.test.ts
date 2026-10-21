/**
 * Phase 67 Plan 01 — unit tests for `assembleConversationBrief`.
 *
 * Covers SESS-02 (last-N rendering), SESS-03 (4-hour gap skip), and edge
 * cases (empty store, active-session fallback, decay bypass, tag
 * precision). Uses real MemoryStore(":memory:") + real ConversationStore
 * (mirrors conversation-store.test.ts harness) so the helper runs against
 * the exact SQL surfaces it will hit in production. `now` is injected in
 * epoch-ms — no `Date.now()` monkey-patching.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MemoryStore } from "../store.js";
import { ConversationStore } from "../conversation-store.js";
import { assembleConversationBrief } from "../conversation-brief.js";
import type { MemoryEntry } from "../types.js";

/** Deterministic "now" — 2026-04-18T12:00:00Z. */
const T = new Date("2026-04-18T12:00:00Z").getTime();

/** Zero-vector embedding (dedup disabled in fixture, so content doesn't matter here). */
function emptyEmbedding(): Float32Array {
  return new Float32Array(384).fill(0.1);
}

/**
 * Seed a session-summary MemoryEntry with a controllable `createdAt`.
 * Inserts via the real MemoryStore then rewrites `created_at` via raw SQL
 * so we can simulate summaries from arbitrary historical moments.
 */
function seedSummary(
  memStore: MemoryStore,
  sessionId: string,
  content: string,
  createdAt: string,
  extraTags: readonly string[] = [],
): MemoryEntry {
  const entry = memStore.insert(
    {
      content,
      source: "conversation",
      importance: 0.78,
      tags: ["session-summary", `session:${sessionId}`, ...extraTags],
      skipDedup: true,
    },
    emptyEmbedding(),
  );
  memStore
    .getDatabase()
    .prepare("UPDATE memories SET created_at = ? WHERE id = ?")
    .run(createdAt, entry.id);
  return entry;
}

/**
 * Seed a non-summary conversation memory (used to prove the brief filters
 * on the `"session-summary"` tag, not on `source === "conversation"`).
 */
function seedNonSummaryMemory(
  memStore: MemoryStore,
  content: string,
  tags: readonly string[],
  createdAt: string,
): MemoryEntry {
  const entry = memStore.insert(
    {
      content,
      source: "conversation",
      importance: 0.5,
      tags: [...tags],
      skipDedup: true,
    },
    emptyEmbedding(),
  );
  memStore
    .getDatabase()
    .prepare("UPDATE memories SET created_at = ? WHERE id = ?")
    .run(createdAt, entry.id);
  return entry;
}

/**
 * Seed an ended session with controllable `started_at` and `ended_at`.
 * Returns the session id for later inspection.
 */
function seedEndedSession(
  memStore: MemoryStore,
  convStore: ConversationStore,
  agentName: string,
  startedAt: string,
  endedAt: string,
): string {
  const session = convStore.startSession(agentName);
  memStore
    .getDatabase()
    .prepare(
      "UPDATE conversation_sessions SET started_at = ?, ended_at = ?, status = 'ended' WHERE id = ?",
    )
    .run(startedAt, endedAt, session.id);
  return session.id;
}

/**
 * Seed an ACTIVE session with a controllable `started_at` (no end timestamp).
 * Simulates the crash-recovery case: previous daemon did not cleanly close.
 */
function seedActiveSession(
  memStore: MemoryStore,
  convStore: ConversationStore,
  agentName: string,
  startedAt: string,
): string {
  const session = convStore.startSession(agentName);
  memStore
    .getDatabase()
    .prepare(
      "UPDATE conversation_sessions SET started_at = ? WHERE id = ?",
    )
    .run(startedAt, session.id);
  return session.id;
}

const defaultConfig = {
  sessionCount: 3,
  gapThresholdHours: 4,
  budgetTokens: 2000,
};

describe("assembleConversationBrief", () => {
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

  it("renders last N summaries", () => {
    // Seed 5 summaries; seed an OLD ended session (outside gap threshold).
    seedEndedSession(
      memStore,
      convStore,
      "agent-a",
      "2026-04-17T00:00:00Z",
      "2026-04-17T00:00:00Z", // > 4h before T (2026-04-18T12:00:00Z)
    );
    for (let i = 0; i < 5; i++) {
      const hoursAgo = i + 1;
      const iso = new Date(T - hoursAgo * 3_600_000).toISOString();
      seedSummary(memStore, `s-${i}`, `Summary body ${i}`, iso);
    }

    const result = assembleConversationBrief(
      { agentName: "agent-a", now: T },
      { conversationStore: convStore, memoryStore: memStore, config: defaultConfig },
    );

    expect(result.skipped).toBe(false);
    if (result.skipped) return;
    expect(result.sessionCount).toBe(3);
    // 3 session blocks → 3 ### subheaders
    const headerCount = (result.brief.match(/^### Session from /gm) ?? []).length;
    expect(headerCount).toBe(3);
    // Most-recent (i=0 = 1h ago) must appear; oldest (i=4 = 5h ago) must NOT.
    expect(result.brief).toContain("Summary body 0");
    expect(result.brief).not.toContain("Summary body 4");
  });

  it("renders markdown structure", () => {
    // Gap far enough in the past that SESS-03 does NOT fire.
    seedEndedSession(
      memStore,
      convStore,
      "agent-a",
      "2026-04-17T00:00:00Z",
      "2026-04-17T00:00:00Z",
    );
    seedSummary(
      memStore,
      "s-a",
      "Body about architecture",
      new Date(T - 3_600_000 * 5).toISOString(), // 5h ago
    );

    const result = assembleConversationBrief(
      { agentName: "agent-a", now: T },
      { conversationStore: convStore, memoryStore: memStore, config: defaultConfig },
    );

    expect(result.skipped).toBe(false);
    if (result.skipped) return;
    expect(result.brief.startsWith("## Recent Sessions\n\n")).toBe(true);
    expect(result.brief).toContain("### Session from ");
  });

  it("respects sessionCount config", () => {
    seedEndedSession(
      memStore,
      convStore,
      "agent-a",
      "2026-04-17T00:00:00Z",
      "2026-04-17T00:00:00Z",
    );
    for (let i = 0; i < 6; i++) {
      const iso = new Date(T - (i + 1) * 3_600_000).toISOString();
      seedSummary(memStore, `s-${i}`, `Body ${i}`, iso);
    }

    const result = assembleConversationBrief(
      { agentName: "agent-a", now: T },
      {
        conversationStore: convStore,
        memoryStore: memStore,
        // Budget is high enough that small bodies will NOT trigger the
        // accumulate stop — we are isolating sessionCount behaviour only.
        config: { sessionCount: 5, gapThresholdHours: 4, budgetTokens: 20_000 },
      },
    );

    expect(result.skipped).toBe(false);
    if (result.skipped) return;
    expect(result.sessionCount).toBe(5);
    const headerCount = (result.brief.match(/^### Session from /gm) ?? []).length;
    expect(headerCount).toBe(5);
  });

  it("enforces conversation_context budget", () => {
    seedEndedSession(
      memStore,
      convStore,
      "agent-a",
      "2026-04-17T00:00:00Z",
      "2026-04-17T00:00:00Z",
    );
    // ~1500 tokens each by repeating a dense token-heavy line. Claude's
    // tokenizer averages ~3.5 chars/token, so ~5250 chars ≈ 1500 tokens.
    const heavyBody = "Architecture decisions resolved. ".repeat(250);
    for (let i = 0; i < 3; i++) {
      const iso = new Date(T - (i + 1) * 3_600_000).toISOString();
      seedSummary(memStore, `big-${i}`, heavyBody, iso);
    }

    const result = assembleConversationBrief(
      { agentName: "agent-a", now: T },
      {
        conversationStore: convStore,
        memoryStore: memStore,
        config: { sessionCount: 3, gapThresholdHours: 4, budgetTokens: 2000 },
      },
    );

    expect(result.skipped).toBe(false);
    if (result.skipped) return;
    // Accumulate strategy: first summary (~1500 tok) fits; adding a second
    // would blow past 2000 — stop at 1.
    expect(result.sessionCount).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("skips when gap under threshold", () => {
    // Session ended 2h ago, threshold 4h → skip.
    const twoHoursAgo = new Date(T - 2 * 3_600_000).toISOString();
    seedEndedSession(memStore, convStore, "agent-a", twoHoursAgo, twoHoursAgo);
    // Seed a summary that SHOULD NOT be rendered.
    seedSummary(
      memStore,
      "s-never",
      "Should not appear",
      new Date(T - 3_600_000).toISOString(),
    );

    const findByTagSpy = vi.spyOn(memStore, "findByTag");

    const result = assembleConversationBrief(
      { agentName: "agent-a", now: T },
      { conversationStore: convStore, memoryStore: memStore, config: defaultConfig },
    );

    expect(result.skipped).toBe(true);
    if (!result.skipped) return;
    expect(result.reason).toBe("gap");
    // Gap short-circuit MUST happen before any MemoryStore read.
    expect(findByTagSpy).toHaveBeenCalledTimes(0);
  });

  it("injects when gap over threshold", () => {
    // Session ended 5h ago, threshold 4h → inject.
    const fiveHoursAgo = new Date(T - 5 * 3_600_000).toISOString();
    seedEndedSession(memStore, convStore, "agent-a", fiveHoursAgo, fiveHoursAgo);
    seedSummary(
      memStore,
      "s-old",
      "Old session content",
      new Date(T - 6 * 3_600_000).toISOString(),
    );

    const result = assembleConversationBrief(
      { agentName: "agent-a", now: T },
      { conversationStore: convStore, memoryStore: memStore, config: defaultConfig },
    );

    expect(result.skipped).toBe(false);
    if (result.skipped) return;
    expect(result.brief.length).toBeGreaterThan(0);
    expect(result.brief).toContain("Old session content");
  });

  it("respects gap threshold config", () => {
    // Session ended 2h ago, custom threshold 1h → 2h > 1h, so inject.
    const twoHoursAgo = new Date(T - 2 * 3_600_000).toISOString();
    seedEndedSession(memStore, convStore, "agent-a", twoHoursAgo, twoHoursAgo);
    seedSummary(
      memStore,
      "s-recent",
      "Recent session content",
      new Date(T - 3 * 3_600_000).toISOString(),
    );

    const result = assembleConversationBrief(
      { agentName: "agent-a", now: T },
      {
        conversationStore: convStore,
        memoryStore: memStore,
        config: { sessionCount: 3, gapThresholdHours: 1, budgetTokens: 2000 },
      },
    );

    expect(result.skipped).toBe(false);
    if (result.skipped) return;
    expect(result.brief).toContain("Recent session content");
  });

  it("zero history produces empty string", () => {
    // No sessions, no summaries.
    const result = assembleConversationBrief(
      { agentName: "agent-a", now: T },
      { conversationStore: convStore, memoryStore: memStore, config: defaultConfig },
    );

    expect(result.skipped).toBe(false);
    if (result.skipped) return;
    expect(result.brief).toBe("");
    expect(result.sessionCount).toBe(0);
    expect(result.tokens).toBe(0);
  });

  it("falls back to startedAt for active session", () => {
    // Active session whose startedAt is 5h ago (no endedAt).
    // Helper must use startedAt for gap math → 5h > 4h threshold → inject.
    const fiveHoursAgo = new Date(T - 5 * 3_600_000).toISOString();
    seedActiveSession(memStore, convStore, "agent-a", fiveHoursAgo);
    seedSummary(
      memStore,
      "s-active",
      "Active-session summary",
      new Date(T - 6 * 3_600_000).toISOString(),
    );

    const result = assembleConversationBrief(
      { agentName: "agent-a", now: T },
      { conversationStore: convStore, memoryStore: memStore, config: defaultConfig },
    );

    expect(result.skipped).toBe(false);
    if (result.skipped) return;
    expect(result.brief).toContain("Active-session summary");
  });

  it("renders old summaries without decay filter", () => {
    // Summary from 60 days ago — decay is a separate concern, brief
    // must render whatever findByTag returns.
    seedEndedSession(
      memStore,
      convStore,
      "agent-a",
      "2026-04-17T00:00:00Z",
      "2026-04-17T00:00:00Z",
    );
    const sixtyDaysAgo = new Date(T - 60 * 24 * 3_600_000).toISOString();
    seedSummary(memStore, "s-ancient", "Ancient summary content", sixtyDaysAgo);

    const result = assembleConversationBrief(
      { agentName: "agent-a", now: T },
      { conversationStore: convStore, memoryStore: memStore, config: defaultConfig },
    );

    expect(result.skipped).toBe(false);
    if (result.skipped) return;
    expect(result.brief).toContain("Ancient summary content");
  });

  it("filters by session-summary tag only", () => {
    seedEndedSession(
      memStore,
      convStore,
      "agent-a",
      "2026-04-17T00:00:00Z",
      "2026-04-17T00:00:00Z",
    );
    // 3 session-summary memories.
    for (let i = 0; i < 3; i++) {
      const iso = new Date(T - (i + 1) * 3_600_000).toISOString();
      seedSummary(memStore, `s-sum-${i}`, `SESSION-SUMMARY-BODY-${i}`, iso);
    }
    // 2 conversation-source memories tagged differently — must be excluded.
    seedNonSummaryMemory(
      memStore,
      "FACT-BODY user preference noted",
      ["fact", "user-preference"],
      new Date(T - 3_600_000 * 2).toISOString(),
    );
    seedNonSummaryMemory(
      memStore,
      "DECISION-BODY stack choice",
      ["decision"],
      new Date(T - 3_600_000 * 3).toISOString(),
    );

    const result = assembleConversationBrief(
      { agentName: "agent-a", now: T },
      { conversationStore: convStore, memoryStore: memStore, config: defaultConfig },
    );

    expect(result.skipped).toBe(false);
    if (result.skipped) return;
    expect(result.sessionCount).toBe(3);
    expect(result.brief).not.toContain("FACT-BODY");
    expect(result.brief).not.toContain("DECISION-BODY");
    expect(result.brief).toContain("SESSION-SUMMARY-BODY-0");
  });

  // ── Regression: agents-forget-across-sessions (2026-04-19) ──────────────
  //
  // Production-ordering bug: SessionManager.startAgent calls
  // ConversationStore.startSession() BEFORE buildSessionConfig runs, so a
  // brand-new 'active' row exists with startedAt=now. The original
  // assembleConversationBrief used listRecentSessions (no status filter) and
  // the gap-check collapsed to ~0ms on every daemon boot. This test would
  // have failed with the old code AND passes with the fixed terminated-only
  // query.
  describe("regression: agents-forget-across-sessions (production ordering)", () => {
    it("ignores the current active session when measuring gap — terminated-only", () => {
      // (1) Seed a prior terminated session that ended 5h ago (beyond default 4h gap).
      const fiveHoursAgo = new Date(T - 5 * 3_600_000).toISOString();
      seedEndedSession(memStore, convStore, "agent-a", fiveHoursAgo, fiveHoursAgo);

      // (2) Seed a summary for it so the brief has something to render.
      seedSummary(
        memStore,
        "s-prior",
        "Prior session content",
        new Date(T - 5.5 * 3_600_000).toISOString(),
      );

      // (3) Simulate production: startSession() was just called and the
      //     active session sits at the TOP of listRecentSessions(). With the
      //     old code this row's startedAt collapsed the gap to zero.
      const activeJustNow = new Date(T - 1_000).toISOString(); // 1s ago
      seedActiveSession(memStore, convStore, "agent-a", activeJustNow);

      // (4) assembleConversationBrief should skip over the active row and
      //     evaluate the gap against the terminated row (5h ago > 4h).
      const result = assembleConversationBrief(
        { agentName: "agent-a", now: T },
        { conversationStore: convStore, memoryStore: memStore, config: defaultConfig },
      );

      expect(result.skipped).toBe(false);
      if (result.skipped) return;
      expect(result.brief).toContain("Prior session content");
    });

    it("still gap-skips when the prior terminated session is within threshold", () => {
      // Prior terminated session ended 2h ago, threshold 4h — should gap-skip
      // even though an active session also exists.
      const twoHoursAgo = new Date(T - 2 * 3_600_000).toISOString();
      seedEndedSession(memStore, convStore, "agent-a", twoHoursAgo, twoHoursAgo);
      seedSummary(
        memStore,
        "s-recent",
        "Should not render",
        new Date(T - 3 * 3_600_000).toISOString(),
      );
      const activeJustNow = new Date(T - 500).toISOString();
      seedActiveSession(memStore, convStore, "agent-a", activeJustNow);

      const result = assembleConversationBrief(
        { agentName: "agent-a", now: T },
        { conversationStore: convStore, memoryStore: memStore, config: defaultConfig },
      );

      expect(result.skipped).toBe(true);
      if (!result.skipped) return;
      expect(result.reason).toBe("gap");
    });

    it("renders brief when only active sessions exist and summaries are present", () => {
      // No terminated sessions at all (clean first-boot after summaries
      // somehow pre-existed, or orphan-active case). No previous terminated
      // session → no gap to measure → fall through to render.
      const activeJustNow = new Date(T - 500).toISOString();
      seedActiveSession(memStore, convStore, "agent-a", activeJustNow);
      seedSummary(
        memStore,
        "s-orphan",
        "Orphan summary body",
        new Date(T - 12 * 3_600_000).toISOString(),
      );

      const result = assembleConversationBrief(
        { agentName: "agent-a", now: T },
        { conversationStore: convStore, memoryStore: memStore, config: defaultConfig },
      );

      expect(result.skipped).toBe(false);
      if (result.skipped) return;
      expect(result.brief).toContain("Orphan summary body");
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 999.13 — TZ-04: renderBrief uses TZ-aware date slice (not UTC slice)
//
// Open Question 1 LOCKED YES — Plan 02 must convert the date in the
// `### Session from <YYYY-MM-DD>` heading from a raw UTC slice
// (`mem.createdAt.slice(0, 10)`) to a TZ-aware date derived via
// renderAgentVisibleTimestamp.
//
// Wave 0 RED: a session that ended 2026-05-01 02:00 UTC = 2026-04-30 19:00
// PDT — current main renders "Session from 2026-05-01" (UTC date) — the
// new test asserts "2026-04-30" (operator-perceived date).
//
// On main: assembleConversationBrief has no agentTz parameter so the test
// fails because the rendered brief uses the UTC date.
// ---------------------------------------------------------------------------
describe("Phase 999.13 — TZ-04: renderBrief TZ-aware date slice", () => {
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

  it("renderBrief-tz-date: createdAt 2026-05-01T02:00:00Z + agentTz America/Los_Angeles → 'Session from 2026-04-30'", () => {
    // Seed an old terminated session > 4h before T to bypass gap-skip.
    seedEndedSession(
      memStore,
      convStore,
      "agent-a",
      "2026-04-29T00:00:00Z",
      "2026-04-29T00:00:00Z",
    );
    // Summary createdAt 2026-05-01T02:00:00Z → 2026-04-30 19:00 PDT
    seedSummary(
      memStore,
      "tz-test",
      "TZ-aware brief body",
      "2026-05-01T02:00:00Z",
    );

    const T_LATER = new Date("2026-05-02T12:00:00Z").getTime();

    // Phase 999.13 TZ-04 (Q1=YES) — AssembleBriefInput.agentTz threads through
    // renderBrief to produce operator-local date in `### Session from <YYYY-MM-DD>`.
    const result = assembleConversationBrief(
      { agentName: "agent-a", now: T_LATER, agentTz: "America/Los_Angeles" },
      { conversationStore: convStore, memoryStore: memStore, config: defaultConfig },
    );

    expect(result.skipped).toBe(false);
    if (result.skipped) return;
    // Operator-perceived date — Pacific time on April 30.
    expect(result.brief).toContain("Session from 2026-04-30");
    expect(result.brief).not.toContain("Session from 2026-05-01");
  });
});
