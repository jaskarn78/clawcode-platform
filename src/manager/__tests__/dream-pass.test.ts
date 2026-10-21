import { describe, it, expect, vi } from "vitest";

/**
 * Phase 95 Plan 01 Task 1 — runDreamPass primitive tests (RED).
 *
 * Pin D-03 invariants + 3-variant DreamPassOutcome union:
 *   - D1: enabled=false → skipped; dispatch never called
 *   - D2: enabled=true → dispatch IS called (idle gating belongs to cron in 95-02)
 *   - D3: valid JSON dispatch response → completed outcome with metrics
 *   - D4: malformed JSON → failed (zod-validation error message)
 *   - D5: dispatch throws → failed (verbatim err.message — TOOL-04 inheritance)
 *   - D6: dispatch throws "input token budget exceeded" → failed verbatim
 *   - D7: model from resolvedDreamConfig.model passed through to dispatch
 *   - D8: durationMs measured via deps.now() (no bare `new Date()`)
 *
 * Module under test does not exist yet — imports fail (RED).
 */

import {
  runDreamPass,
  dreamPassOutcomeSchema,
  dreamResultSchema,
  type RunDreamPassDeps,
  type DreamResult,
  type DreamDispatchRequest,
  type DreamDispatchResponse,
} from "../dream-pass.js";
import type {
  MemoryChunk,
  ConversationSummary,
} from "../dream-prompt-builder.js";

const VALID_DREAM_RESULT: DreamResult = {
  newWikilinks: [
    {
      from: "memory/a.md",
      to: "memory/b.md",
      rationale: "Both reference deploy.",
    },
  ],
  promotionCandidates: [
    {
      chunkId: "chunk-1",
      currentPath: "memory/c.md",
      rationale: "Referenced 4 times in recent activity.",
      priorityScore: 75,
    },
  ],
  themedReflection: "Recent activity centered on deploy debugging.",
  suggestedConsolidations: [
    {
      sources: ["memory/a.md", "memory/b.md"],
      newPath: "memory/consolidations/deploy.md",
      rationale: "Same incident across 2 files.",
    },
  ],
};

const noopLog = {
  info: (_: string) => {},
  warn: (_: string) => {},
  error: (_: string) => {},
};

function buildDeps(
  overrides: Partial<RunDreamPassDeps> = {},
): RunDreamPassDeps {
  const baseChunks: MemoryChunk[] = [
    {
      id: "c1",
      path: "memory/c1.md",
      body: "Recent chunk content.",
      lastModified: new Date("2026-04-25T10:00:00Z"),
    },
  ];
  const baseSummaries: ConversationSummary[] = [
    {
      sessionId: "s1",
      summary: "Recent session summary.",
      endedAt: new Date("2026-04-25T11:00:00Z"),
    },
  ];

  // Default deps with sensible test stubs (overridable via `overrides`)
  const memoryStore = overrides.memoryStore ?? {
    getRecentChunks: vi.fn().mockResolvedValue(baseChunks),
  };
  const conversationStore = overrides.conversationStore ?? {
    getRecentSummaries: vi.fn().mockResolvedValue(baseSummaries),
  };
  const readFile =
    overrides.readFile ??
    vi.fn().mockImplementation(async (path: string) => {
      if (path.endsWith("MEMORY.md")) return "# Core memory";
      if (path.endsWith("graph-edges.json")) return '{"edges":[]}';
      return "";
    });
  const dispatch =
    overrides.dispatch ??
    vi.fn().mockResolvedValue({
      rawText: JSON.stringify(VALID_DREAM_RESULT),
      tokensIn: 1234,
      tokensOut: 567,
    } as DreamDispatchResponse);

  // Deterministic clock: now() returns successive timestamps so duration > 0
  let tick = 0;
  const ticks = [
    new Date("2026-04-25T12:00:00.000Z"),
    new Date("2026-04-25T12:00:04.200Z"),
  ];
  const now =
    overrides.now ??
    ((): Date => {
      const t = ticks[Math.min(tick, ticks.length - 1)];
      tick += 1;
      return t;
    });

  return {
    memoryStore,
    conversationStore,
    readFile,
    dispatch,
    resolvedDreamConfig: overrides.resolvedDreamConfig ?? {
      enabled: true,
      idleMinutes: 30,
      model: "haiku",
    },
    memoryRoot: overrides.memoryRoot ?? "/tmp/agents/test/memory",
    now,
    log: overrides.log ?? noopLog,
  };
}

describe("dreamResultSchema — D-03 structured output contract", () => {
  it("validates a well-formed DreamResult", () => {
    const result = dreamResultSchema.safeParse(VALID_DREAM_RESULT);
    expect(result.success).toBe(true);
  });

  it("rejects missing newWikilinks", () => {
    const bad = { ...VALID_DREAM_RESULT } as Partial<DreamResult>;
    delete bad.newWikilinks;
    const result = dreamResultSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects priorityScore out of [0,100] range", () => {
    const bad = {
      ...VALID_DREAM_RESULT,
      promotionCandidates: [
        {
          chunkId: "x",
          currentPath: "memory/x.md",
          rationale: "...",
          priorityScore: 150,
        },
      ],
    };
    const result = dreamResultSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});

describe("dreamPassOutcomeSchema — 3-variant locked discriminated union", () => {
  it("accepts kind='completed'", () => {
    const ok = {
      kind: "completed" as const,
      result: VALID_DREAM_RESULT,
      durationMs: 4200,
      tokensIn: 1234,
      tokensOut: 567,
      model: "haiku",
    };
    expect(dreamPassOutcomeSchema.safeParse(ok).success).toBe(true);
  });

  it("accepts kind='skipped' with reason='disabled' or 'agent-active'", () => {
    expect(
      dreamPassOutcomeSchema.safeParse({ kind: "skipped", reason: "disabled" })
        .success,
    ).toBe(true);
    expect(
      dreamPassOutcomeSchema.safeParse({
        kind: "skipped",
        reason: "agent-active",
      }).success,
    ).toBe(true);
  });

  it("accepts kind='failed' with error string", () => {
    expect(
      dreamPassOutcomeSchema.safeParse({ kind: "failed", error: "oops" })
        .success,
    ).toBe(true);
  });

  it("rejects unknown kind (4th variant — locked union)", () => {
    expect(
      dreamPassOutcomeSchema.safeParse({
        kind: "partial",
        result: VALID_DREAM_RESULT,
      }).success,
    ).toBe(false);
  });
});

describe("runDreamPass — D-03 LLM-pass primitive (pure DI)", () => {
  it("D1: enabled=false → returns {kind:'skipped', reason:'disabled'}; dispatch never called", async () => {
    const dispatch = vi.fn();
    const deps = buildDeps({
      resolvedDreamConfig: {
        enabled: false,
        idleMinutes: 30,
        model: "haiku",
      },
      dispatch,
    });
    const outcome = await runDreamPass("clawdy", deps);
    expect(outcome.kind).toBe("skipped");
    if (outcome.kind === "skipped") {
      expect(outcome.reason).toBe("disabled");
    }
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("D2: enabled=true → dispatch IS called (no idle gating in primitive — cron's job)", async () => {
    const dispatch = vi.fn().mockResolvedValue({
      rawText: JSON.stringify(VALID_DREAM_RESULT),
      tokensIn: 100,
      tokensOut: 50,
    } as DreamDispatchResponse);
    const deps = buildDeps({ dispatch });
    const outcome = await runDreamPass("clawdy", deps);
    expect(outcome.kind).toBe("completed");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("D3: valid JSON dispatch response → {kind:'completed', result, durationMs>0, tokensIn/out, model}", async () => {
    const deps = buildDeps();
    const outcome = await runDreamPass("clawdy", deps);
    expect(outcome.kind).toBe("completed");
    if (outcome.kind === "completed") {
      expect(outcome.result).toEqual(VALID_DREAM_RESULT);
      expect(outcome.durationMs).toBeGreaterThan(0);
      expect(outcome.tokensIn).toBe(1234);
      expect(outcome.tokensOut).toBe(567);
      expect(outcome.model).toBe("haiku");
    }
  });

  it("D4: malformed JSON in dispatch response → {kind:'failed', error contains 'dream-result-schema-validation-failed'} OR JSON parse error", async () => {
    const dispatch = vi.fn().mockResolvedValue({
      rawText: "this is not json",
      tokensIn: 100,
      tokensOut: 50,
    } as DreamDispatchResponse);
    const deps = buildDeps({ dispatch });
    const outcome = await runDreamPass("clawdy", deps);
    expect(outcome.kind).toBe("failed");
  });

  it("D4b: well-formed JSON but mismatched schema → {kind:'failed', error startsWith 'dream-result-schema-validation-failed'}", async () => {
    const dispatch = vi.fn().mockResolvedValue({
      rawText: JSON.stringify({ wrong: "shape" }),
      tokensIn: 100,
      tokensOut: 50,
    } as DreamDispatchResponse);
    const deps = buildDeps({ dispatch });
    const outcome = await runDreamPass("clawdy", deps);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.error).toContain("dream-result-schema-validation-failed");
    }
  });

  it("D5: dispatch throws → {kind:'failed', error: verbatim err.message}", async () => {
    const dispatch = vi.fn().mockRejectedValue(new Error("SDK timeout after 30s"));
    const deps = buildDeps({ dispatch });
    const outcome = await runDreamPass("clawdy", deps);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      // TOOL-04 verbatim pass-through
      expect(outcome.error).toBe("SDK timeout after 30s");
    }
  });

  it("D6: dispatch throws 'input token budget exceeded' → failed verbatim", async () => {
    const dispatch = vi
      .fn()
      .mockRejectedValue(new Error("input token budget exceeded"));
    const deps = buildDeps({ dispatch });
    const outcome = await runDreamPass("clawdy", deps);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.error).toBe("input token budget exceeded");
    }
  });

  it("D7: model passed through from resolvedDreamConfig.model into dispatch request", async () => {
    const dispatch = vi.fn().mockResolvedValue({
      rawText: JSON.stringify(VALID_DREAM_RESULT),
      tokensIn: 100,
      tokensOut: 50,
    } as DreamDispatchResponse);
    const deps = buildDeps({
      resolvedDreamConfig: {
        enabled: true,
        idleMinutes: 30,
        model: "opus",
      },
      dispatch,
    });
    await runDreamPass("clawdy", deps);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const req = dispatch.mock.calls[0][0] as DreamDispatchRequest;
    expect(req.model).toBe("opus");
  });

  it("D8: durationMs measured via deps.now() called twice (no bare `new Date()`)", async () => {
    const ticks = [
      new Date("2026-04-25T12:00:00.000Z"),
      new Date("2026-04-25T12:00:10.500Z"),
    ];
    let i = 0;
    const now = vi.fn(() => ticks[Math.min(i++, ticks.length - 1)]);
    const dispatch = vi.fn().mockResolvedValue({
      rawText: JSON.stringify(VALID_DREAM_RESULT),
      tokensIn: 100,
      tokensOut: 50,
    } as DreamDispatchResponse);
    const deps = buildDeps({ now, dispatch });
    const outcome = await runDreamPass("clawdy", deps);
    expect(outcome.kind).toBe("completed");
    if (outcome.kind === "completed") {
      expect(outcome.durationMs).toBe(10_500); // 10.5s
    }
    // now() invoked at least twice (start, end) — possibly more if helper
    // re-checks; test pins `>= 2`.
    expect(now.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
