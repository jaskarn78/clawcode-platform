/**
 * 99-mdrop — Admin Clawdy memory drop fix.
 *
 * Audit: .planning/phases/99-memory-translator-and-sync-hygiene/
 *        ADMIN-CLAWDY-MEMORY-DROP-2026-04-27.md
 *
 * Bug: when session-summarizer falls back to a raw-turn dump (96 turns,
 * ~19.6KB), the conversation-brief assembler tried to inject the raw
 * markdown verbatim. The 2K token budget truncated the entry → next
 * session resumed with an effectively empty brief → agent dropped its
 * working memory mid-thread without any operator-visible alert.
 *
 * Fixes covered here:
 *   - RT-DOWNGRADE — raw-turn-tagged session yields a 1-line placeholder
 *     instead of injecting the bloated raw markdown.
 *   - RT-MIX — LLM-summary candidates render unchanged; raw-turn-tagged
 *     candidates render as placeholders. Both can coexist.
 *   - BRIEF-ERR-LEVEL — when budget pressure DROPS sessions AND any
 *     candidate carried `raw-fallback`, the telemetry log is emitted at
 *     `error` level (50) with `truncationReason: "budget"` and
 *     `hasFallbackTagged: true`.
 *
 * Conventions: real MemoryStore(":memory:") + real ConversationStore so
 * SQL surfaces match production. `now` injected (no clock monkey-patching).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MemoryStore } from "../store.js";
import { ConversationStore } from "../conversation-store.js";
import { assembleConversationBrief } from "../conversation-brief.js";
import type { MemoryEntry } from "../types.js";

const T = new Date("2026-04-28T12:00:00Z").getTime();

function emptyEmbedding(): Float32Array {
  return new Float32Array(384).fill(0.1);
}

function seedSummary(
  memStore: MemoryStore,
  sessionId: string,
  content: string,
  createdAt: string,
  extraTags: readonly string[] = [],
  sourceTurnIds: readonly string[] | undefined = undefined,
): MemoryEntry {
  const entry = memStore.insert(
    {
      content,
      source: "conversation",
      importance: 0.78,
      tags: ["session-summary", `session:${sessionId}`, ...extraTags],
      skipDedup: true,
      ...(sourceTurnIds ? { sourceTurnIds } : {}),
    },
    emptyEmbedding(),
  );
  memStore
    .getDatabase()
    .prepare("UPDATE memories SET created_at = ? WHERE id = ?")
    .run(createdAt, entry.id);
  return entry;
}

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

const baseConfig = {
  sessionCount: 3,
  gapThresholdHours: 4,
  budgetTokens: 2000,
};

describe("conversation-brief — 99-mdrop raw-turn downgrade", () => {
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

  it("RT-DOWNGRADE — raw-turn-tagged summary yields placeholder, NOT bloated content", () => {
    // Seed a terminated session far enough back that gap-skip does NOT fire.
    seedEndedSession(
      memStore,
      convStore,
      "agent-a",
      "2026-04-27T00:00:00Z",
      "2026-04-27T00:00:00Z",
    );

    // The bloated 19.6KB-style raw-turn dump that wrecked Admin Clawdy.
    const bloatedRawTurns =
      "## Raw Turns\n\n" +
      Array.from(
        { length: 96 },
        (_, i) =>
          `### user (turn ${i})\n\n` +
          "X".repeat(200) +
          "\n\n### assistant (turn " +
          (i + 1) +
          ")\n\n" +
          "Y".repeat(200),
      ).join("\n\n");

    seedSummary(
      memStore,
      "s-bloated",
      bloatedRawTurns,
      new Date(T - 5 * 3_600_000).toISOString(),
      ["raw-fallback"],
      Array.from({ length: 96 }, (_, i) => `t-${i}`),
    );

    const result = assembleConversationBrief(
      { agentName: "agent-a", now: T },
      {
        conversationStore: convStore,
        memoryStore: memStore,
        config: baseConfig,
      },
    );

    expect(result.skipped).toBe(false);
    if (result.skipped) return;

    // Bloated body must NOT leak through.
    expect(result.brief).not.toContain("X".repeat(200));
    expect(result.brief).not.toContain("Y".repeat(200));
    expect(result.brief).not.toMatch(/### user \(turn \d+\)/);

    // Placeholder must mention turn count and the fallback condition.
    expect(result.brief).toMatch(/Prior session/i);
    expect(result.brief).toMatch(/raw-turn fallback/i);
    expect(result.brief).toContain("96"); // turn count surfaced
    expect(result.sessionCount).toBe(1);

    // Token cost must be cheap — placeholder, not 19.6KB dump.
    expect(result.tokens).toBeLessThan(200);
  });

  it("RT-MIX — LLM summary renders verbatim, raw-turn entry renders as placeholder, both coexist", () => {
    seedEndedSession(
      memStore,
      convStore,
      "agent-a",
      "2026-04-27T00:00:00Z",
      "2026-04-27T00:00:00Z",
    );

    // (1) Healthy LLM summary — most recent.
    seedSummary(
      memStore,
      "s-llm",
      "## User Preferences\n- Likes terse responses\n## Decisions\n- Used SQLite",
      new Date(T - 5 * 3_600_000).toISOString(),
    );

    // (2) Raw-turn fallback session — older.
    seedSummary(
      memStore,
      "s-raw",
      "## Raw Turns\n\n" +
        Array.from({ length: 12 }, (_, i) => `### user (turn ${i})\n\nbody`).join(
          "\n\n",
        ),
      new Date(T - 6 * 3_600_000).toISOString(),
      ["raw-fallback"],
      Array.from({ length: 12 }, (_, i) => `t-${i}`),
    );

    const result = assembleConversationBrief(
      { agentName: "agent-a", now: T },
      {
        conversationStore: convStore,
        memoryStore: memStore,
        config: baseConfig,
      },
    );

    expect(result.skipped).toBe(false);
    if (result.skipped) return;
    expect(result.sessionCount).toBe(2);

    // Healthy summary intact.
    expect(result.brief).toContain("Likes terse responses");
    expect(result.brief).toContain("Used SQLite");

    // Raw-turn placeholder present, raw turns NOT present.
    expect(result.brief).toMatch(/raw-turn fallback/i);
    expect(result.brief).toContain("12"); // turn count

    // No raw-turn body leakage.
    expect(result.brief).not.toMatch(/### user \(turn \d+\)/);
  });

  it("regression — pre-fix LLM-only briefs still render unchanged (no false-positive downgrade)", () => {
    // Confirms the downgrade ONLY triggers on the `raw-fallback` tag.
    seedEndedSession(
      memStore,
      convStore,
      "agent-a",
      "2026-04-27T00:00:00Z",
      "2026-04-27T00:00:00Z",
    );

    const llmBody = "## User Preferences\n- Prefers brevity";
    seedSummary(
      memStore,
      "s-norm",
      llmBody,
      new Date(T - 5 * 3_600_000).toISOString(),
      [], // no raw-fallback
    );

    const result = assembleConversationBrief(
      { agentName: "agent-a", now: T },
      {
        conversationStore: convStore,
        memoryStore: memStore,
        config: baseConfig,
      },
    );

    expect(result.skipped).toBe(false);
    if (result.skipped) return;
    expect(result.brief).toContain("Prefers brevity");
    expect(result.brief).not.toMatch(/raw-turn fallback/i);
  });
});

describe("conversation-brief — 99-mdrop telemetry escalation", () => {
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

  it("BRIEF-ERR-LEVEL — error log fires when budget drops sessions AND raw-turn tag present", () => {
    // Setup: budget drops sessions (requestedCount > actualCount) AND at
    // least one of the candidates was raw-turn-tagged. Together this is a
    // textbook context-loss scenario that the operator must see.
    seedEndedSession(
      memStore,
      convStore,
      "agent-a",
      "2026-04-27T00:00:00Z",
      "2026-04-27T00:00:00Z",
    );

    // Three heavy LLM summaries (no raw-fallback) — budget=2000 admits 1,
    // drops 2. Plus ONE raw-turn-tagged entry mixed in. The raw-turn entry
    // renders as a tiny placeholder so it does not contribute to the budget,
    // but it still counts as a CONSIDERED candidate the operator must know
    // about. This mirrors the production scenario: heavy LLM history pushes
    // the recent raw-turn fallback into the dropped set.
    const heavyBody = "Architecture decisions resolved. ".repeat(250);
    // Most-recent slot: raw-fallback (would have been useless content
    // anyway — that is the bug we just downgraded).
    seedSummary(
      memStore,
      "raw-recent",
      "## Raw Turns\n\n### user (turn 0)\n\nbody",
      new Date(T - 1 * 3_600_000).toISOString(),
      ["raw-fallback"],
    );
    // Older slots: heavy LLM bodies that DO consume budget.
    for (let i = 0; i < 3; i++) {
      const iso = new Date(T - (i + 2) * 3_600_000).toISOString();
      seedSummary(memStore, `heavy-${i}`, heavyBody, iso, []);
    }

    const errorCalls: Array<{ payload: Record<string, unknown>; msg: string }> = [];
    const warnCalls: Array<{ payload: Record<string, unknown>; msg: string }> = [];
    // LoggerLike is structural with optional `error`. The extra `info`
    // method below is fine at runtime but TS object-literal-strictness
    // flags it; widen the type so the consumer reads only warn/error.
    const log: { info: () => void; warn: (p: Record<string, unknown>, m: string) => void; error: (p: Record<string, unknown>, m: string) => void } = {
      info: () => {},
      warn: (payload: Record<string, unknown>, msg: string) => {
        warnCalls.push({ payload, msg });
      },
      error: (payload: Record<string, unknown>, msg: string) => {
        errorCalls.push({ payload, msg });
      },
    };

    const result = assembleConversationBrief(
      { agentName: "agent-a", now: T },
      {
        conversationStore: convStore,
        memoryStore: memStore,
        config: { sessionCount: 3, gapThresholdHours: 4, budgetTokens: 2000 },
        // The structural LoggerLike on the consumer side has only warn (+
        // optional error). The fixture's extra `info` is for traceability
        // in the test, not part of the contract — narrow the assignment.
        log: log as unknown as Parameters<typeof assembleConversationBrief>[1]["log"],
      },
    );

    expect(result.skipped).toBe(false);
    if (result.skipped) return;

    // Budget pressure dropped sessions.
    expect(result.sessionCount).toBeLessThan(3);

    // The escalated telemetry must fire on `error`, not `warn`.
    expect(errorCalls.length).toBeGreaterThan(0);
    expect(warnCalls.length).toBe(0);

    const evt = errorCalls[0]!;
    expect(evt.payload).toMatchObject({
      agent: "agent-a",
      requestedCount: 3,
      truncationReason: "budget",
      hasFallbackTagged: true,
      section: "conversation_context",
    });
    expect(typeof evt.payload.actualCount).toBe("number");
    expect((evt.payload.actualCount as number) < 3).toBe(true);
    // The new message MUST signal context-loss risk so log filters can pick
    // it up alongside the existing warn message.
    expect(evt.msg).toMatch(/context loss/i);
  });

  it("budget pressure WITHOUT raw-turn tag stays at warn level (no false escalation)", () => {
    seedEndedSession(
      memStore,
      convStore,
      "agent-a",
      "2026-04-27T00:00:00Z",
      "2026-04-27T00:00:00Z",
    );

    const heavyBody = "Architecture decisions resolved. ".repeat(250);
    for (let i = 0; i < 3; i++) {
      const iso = new Date(T - (i + 1) * 3_600_000).toISOString();
      seedSummary(memStore, `clean-${i}`, heavyBody, iso); // NO raw-fallback tag
    }

    const errorSpy = vi.fn();
    const warnSpy = vi.fn();
    const log = {
      info: () => {},
      warn: warnSpy,
      error: errorSpy,
    };

    const result = assembleConversationBrief(
      { agentName: "agent-a", now: T },
      {
        conversationStore: convStore,
        memoryStore: memStore,
        config: { sessionCount: 3, gapThresholdHours: 4, budgetTokens: 2000 },
        log,
      },
    );

    expect(result.skipped).toBe(false);
    if (result.skipped) return;

    // Budget pressure did happen.
    expect(result.sessionCount).toBeLessThan(3);
    // …but no raw-turn — telemetry stays at warn.
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [payload] = warnSpy.mock.calls[0]!;
    expect(payload).toMatchObject({
      truncationReason: "budget",
      hasFallbackTagged: false,
    });
  });
});
