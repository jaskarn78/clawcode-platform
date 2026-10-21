/**
 * Phase 999.19-02 T-02 — unit proof for `consolidateDelegatedWork`.
 *
 * Covers the `<behavior>` block: D5 record shape, importance/tags,
 * delegate-store targeting, embedding passthrough, and the
 * failure-swallow contract (consolidation NEVER throws — a failure must
 * never block the spawner's archive/stop chain).
 */
import { describe, it, expect, vi } from "vitest";
import type { Logger } from "pino";
import type { MemoryStore } from "../../memory/store.js";
import type { CreateMemoryInput } from "../../memory/types.js";
import {
  consolidateDelegatedWork,
  buildConsolidationContent,
  type ConsolidationDeps,
  type ConsolidationInput,
} from "../subagent-consolidation.js";

/** A pino-shaped logger stub — only the levels the module uses. */
function makeLog(): Logger & {
  warn: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
} {
  return {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  } as unknown as Logger & {
    warn: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
  };
}

/** A MemoryStore stub with a spy-able `insert`. */
function makeStore(): MemoryStore & { insert: ReturnType<typeof vi.fn> } {
  return {
    insert: vi.fn((input: CreateMemoryInput) => ({
      id: "mem-1",
      content: input.content,
      source: input.source,
      importance: input.importance ?? 0.5,
      accessCount: 0,
      tags: input.tags ?? [],
      embedding: null,
      createdAt: "2026-05-20T00:00:00.000Z",
      updatedAt: "2026-05-20T00:00:00.000Z",
      accessedAt: "2026-05-20T00:00:00.000Z",
      tier: "hot",
      sourceTurnIds: null,
    })),
  } as unknown as MemoryStore & { insert: ReturnType<typeof vi.fn> };
}

function baseInput(overrides: Partial<ConsolidationInput> = {}): ConsolidationInput {
  return {
    delegateAgent: "research",
    parentAgent: "admin-clawdy",
    task: "find cool features openclaw has",
    keyFindings: "openclaw has a webhook bridge and a gateway router",
    threadId: "thread-abc123",
    ...overrides,
  };
}

describe("buildConsolidationContent (D5 record shape)", () => {
  it("contains the header, task, key-findings, thread id, delegated-by, and an ISO timestamp", () => {
    const content = buildConsolidationContent(baseInput());
    expect(content).toContain("[Delegated research]");
    expect(content).toContain("find cool features openclaw has");
    expect(content).toContain("Key findings:");
    expect(content).toContain("openclaw has a webhook bridge");
    expect(content).toContain("thread-abc123");
    expect(content).toContain("Delegated by: admin-clawdy");
    // ISO-8601 timestamp (Completed: line).
    expect(content).toMatch(/Completed: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("uses the threadUrl when provided, else falls back to the bare threadId", () => {
    const withUrl = buildConsolidationContent(
      baseInput({ threadUrl: "https://discord.com/channels/1/2/thread-abc123" }),
    );
    expect(withUrl).toContain("https://discord.com/channels/1/2/thread-abc123");
    const noUrl = buildConsolidationContent(baseInput());
    expect(noUrl).toContain("Thread: thread-abc123");
  });

  it("truncates a 5000-char task to <= 201 chars inside content (200 + ellipsis)", () => {
    const longTask = "x".repeat(5000);
    const content = buildConsolidationContent(baseInput({ task: longTask }));
    // The run of x's in content must be at most 200, plus the ellipsis.
    const xRun = content.match(/x+/)?.[0] ?? "";
    expect(xRun.length).toBeLessThanOrEqual(200);
    expect(content).toContain("…");
    // The full task string must NOT appear verbatim — it was truncated.
    expect(content).not.toContain(longTask);
  });

  it("truncates key findings to ~1200 chars", () => {
    const longFindings = "y".repeat(5000);
    const content = buildConsolidationContent(
      baseInput({ keyFindings: longFindings }),
    );
    const yRun = content.match(/y+/)?.[0] ?? "";
    expect(yRun.length).toBeLessThanOrEqual(1200);
    expect(content).not.toContain(longFindings);
  });
});

describe("consolidateDelegatedWork", () => {
  it("writes ONE consolidation record into the delegate's store with importance 0.7 and the 3 tags", async () => {
    const store = makeStore();
    const log = makeLog();
    const deps: ConsolidationDeps = {
      getMemoryStore: vi.fn(() => store),
      embedText: vi.fn(async () => new Float32Array(384)),
      log,
    };
    await consolidateDelegatedWork(baseInput(), deps);

    expect(deps.getMemoryStore).toHaveBeenCalledWith("research");
    expect(store.insert).toHaveBeenCalledTimes(1);
    const [input] = store.insert.mock.calls[0] as [CreateMemoryInput];
    expect(input.source).toBe("consolidation");
    expect(input.importance).toBe(0.7);
    expect(input.tags).toEqual([
      "delegated-research",
      "subagent",
      "admin-clawdy",
    ]);
  });

  it("passes the exact embedding returned by embedText to store.insert", async () => {
    const store = makeStore();
    const embedding = new Float32Array(384);
    embedding[0] = 0.42;
    const deps: ConsolidationDeps = {
      getMemoryStore: vi.fn(() => store),
      embedText: vi.fn(async () => embedding),
      log: makeLog(),
    };
    await consolidateDelegatedWork(baseInput(), deps);
    const [, passedEmbedding] = store.insert.mock.calls[0] as [
      CreateMemoryInput,
      Float32Array,
    ];
    expect(passedEmbedding).toBe(embedding);
  });

  it("when getMemoryStore returns undefined: no insert, WARN logged, no throw", async () => {
    const log = makeLog();
    const deps: ConsolidationDeps = {
      getMemoryStore: vi.fn(() => undefined),
      embedText: vi.fn(async () => new Float32Array(384)),
      log,
    };
    await expect(
      consolidateDelegatedWork(baseInput(), deps),
    ).resolves.toBeUndefined();
    expect(deps.embedText).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("when embedText rejects: no throw, WARN logged", async () => {
    const store = makeStore();
    const log = makeLog();
    const deps: ConsolidationDeps = {
      getMemoryStore: vi.fn(() => store),
      embedText: vi.fn(async () => {
        throw new Error("embedder OOM");
      }),
      log,
    };
    await expect(
      consolidateDelegatedWork(baseInput(), deps),
    ).resolves.toBeUndefined();
    expect(store.insert).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("when store.insert throws: no throw, WARN logged", async () => {
    const store = makeStore();
    store.insert.mockImplementation(() => {
      throw new Error("DB locked");
    });
    const log = makeLog();
    const deps: ConsolidationDeps = {
      getMemoryStore: vi.fn(() => store),
      embedText: vi.fn(async () => new Float32Array(384)),
      log,
    };
    await expect(
      consolidateDelegatedWork(baseInput(), deps),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("a 5000-char task still produces a valid record (truncated, not dropped)", async () => {
    const store = makeStore();
    const deps: ConsolidationDeps = {
      getMemoryStore: vi.fn(() => store),
      embedText: vi.fn(async () => new Float32Array(384)),
      log: makeLog(),
    };
    await consolidateDelegatedWork(
      baseInput({ task: "z".repeat(5000) }),
      deps,
    );
    expect(store.insert).toHaveBeenCalledTimes(1);
    const [input] = store.insert.mock.calls[0] as [CreateMemoryInput];
    const zRun = input.content.match(/z+/)?.[0] ?? "";
    expect(zRun.length).toBeLessThanOrEqual(200);
  });
});
