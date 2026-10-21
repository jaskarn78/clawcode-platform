import { describe, it, expect, vi } from "vitest";

/**
 * Phase 107 Plan 01 Task 1 — DREAM-OUT-04 RED tests.
 *
 * Pin the parse-failure recovery contract introduced by DREAM-OUT-03:
 *   - prose input → {kind:"failed"}; structured warn (component, action,
 *     responsePrefix, agent, err); NO error log
 *   - valid JSON → {kind:"completed"}; NO warn / NO error
 *   - schema-correct fallback envelope → {kind:"completed"} (legitimate
 *     no-op); NO warn / NO error
 *   - malformed JSON (trailing comma) → {kind:"failed"}; structured warn;
 *     NO error log
 *   - non-fatal: runDreamPass NEVER throws on bad input
 *   - responsePrefix capped at 80 chars
 *
 * RED: against current dream-pass.ts:271-280 these tests fail because the
 * production code calls deps.log.error(string), not deps.log.warn(obj, msg).
 * Task 3 (DREAM-OUT-03) flips the path to GREEN.
 */

import {
  runDreamPass,
  type RunDreamPassDeps,
  type DreamResult,
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

/** Schema-correct fallback envelope contract (Phase 107 DREAM-OUT-01). */
const FALLBACK_ENVELOPE_TEXT =
  '{"newWikilinks":[],"promotionCandidates":[],"themedReflection":"","suggestedConsolidations":[]}';

interface MockLog {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
}

function buildMockLog(): MockLog {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function buildDeps(
  rawText: string,
  log: MockLog,
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
      rawText,
      tokensIn: 100,
      tokensOut: 50,
    } as DreamDispatchResponse);

  let tick = 0;
  const ticks = [
    new Date("2026-04-25T12:00:00.000Z"),
    new Date("2026-04-25T12:00:01.000Z"),
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
    // Cast: MockLog uses vi.fn() (variadic) so the call-site assertions can
    // inspect mock.calls; DreamPassLog declares warn as a single union
    // signature `(objOrMsg, msg?)`. Behaviorally compatible — vi.fn accepts
    // any args — but the structural types are too loose for direct
    // assignment.
    log: log as unknown as RunDreamPassDeps["log"],
  };
}

describe("Phase 107 DREAM-OUT-04 — dream-pass JSON recovery", () => {
  it("prose-input: returns failed and warns with structured fields; no error log", async () => {
    const log = buildMockLog();
    const deps = buildDeps("Noted — couldn't analyze that", log);

    const outcome = await runDreamPass("clawdy", deps);

    expect(outcome.kind).toBe("failed");
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        component: "dream-pass",
        action: "parse-failed",
        agent: "clawdy",
      }),
      expect.any(String),
    );
    const [obj] = log.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(typeof obj.responsePrefix).toBe("string");
    expect((obj.responsePrefix as string).length).toBeLessThanOrEqual(80);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("valid-json: returns completed; no warn, no error", async () => {
    const log = buildMockLog();
    const deps = buildDeps(JSON.stringify(VALID_DREAM_RESULT), log);

    const outcome = await runDreamPass("clawdy", deps);

    expect(outcome.kind).toBe("completed");
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("fallback-envelope: schema-correct no-op envelope completes legitimately; no warn, no error", async () => {
    const log = buildMockLog();
    const deps = buildDeps(FALLBACK_ENVELOPE_TEXT, log);

    const outcome = await runDreamPass("clawdy", deps);

    expect(outcome.kind).toBe("completed");
    if (outcome.kind === "completed") {
      expect(outcome.result.newWikilinks).toEqual([]);
      expect(outcome.result.promotionCandidates).toEqual([]);
      expect(outcome.result.themedReflection).toBe("");
      expect(outcome.result.suggestedConsolidations).toEqual([]);
    }
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("malformed-json: trailing comma triggers parse path warn (not zod path); no error", async () => {
    const log = buildMockLog();
    // Trailing comma — JSON.parse rejects this even though it looks close.
    const deps = buildDeps('{"newWikilinks":[],}', log);

    const outcome = await runDreamPass("clawdy", deps);

    expect(outcome.kind).toBe("failed");
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        component: "dream-pass",
        action: "parse-failed",
      }),
      expect.any(String),
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it("non-fatal: runDreamPass resolves on prose / valid / fallback / malformed inputs", async () => {
    const inputs = [
      "Noted — couldn't analyze that",
      JSON.stringify(VALID_DREAM_RESULT),
      FALLBACK_ENVELOPE_TEXT,
      '{"newWikilinks":[],}',
    ];
    for (const raw of inputs) {
      const log = buildMockLog();
      const deps = buildDeps(raw, log);
      await expect(runDreamPass("clawdy", deps)).resolves.toBeDefined();
    }
  });

  it("responsePrefix-cap: long prose response is truncated to ≤80 chars in warn payload", async () => {
    const log = buildMockLog();
    const longProse = "Picking up where we left off, ".repeat(100); // ~3000 chars
    const deps = buildDeps(longProse, log);

    const outcome = await runDreamPass("clawdy", deps);

    expect(outcome.kind).toBe("failed");
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [obj] = log.warn.mock.calls[0] as [Record<string, unknown>, string];
    const prefix = obj.responsePrefix as string;
    expect(typeof prefix).toBe("string");
    expect(prefix.length).toBeLessThanOrEqual(80);
    // Exactly 80 since input is much longer than 80 chars.
    expect(prefix.length).toBe(80);
    expect(log.error).not.toHaveBeenCalled();
  });
});
