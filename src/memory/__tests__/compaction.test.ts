import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  CompactionManager,
  CharacterCountFillProvider,
} from "../compaction.js";
import type { CompactionDeps, ConversationTurn } from "../compaction.js";
import type { MemoryStore } from "../store.js";
import type { EmbeddingService } from "../embedder.js";
import type { SessionLogger } from "../session-log.js";
import type { Logger } from "pino";

/** Create a mock MemoryStore with required methods. */
function mockMemoryStore(): MemoryStore {
  return {
    insert: vi.fn().mockReturnValue({
      id: "mem-1",
      content: "test",
      source: "conversation",
      importance: 0.5,
      accessCount: 0,
      tags: [],
      embedding: null,
      createdAt: "2026-04-09T00:00:00Z",
      updatedAt: "2026-04-09T00:00:00Z",
      accessedAt: "2026-04-09T00:00:00Z",
    }),
    recordSessionLog: vi.fn().mockReturnValue({
      id: "log-1",
      date: "2026-04-09",
      filePath: "/tmp/memory/2026-04-09.md",
      entryCount: 3,
      createdAt: "2026-04-09T00:00:00Z",
    }),
    close: vi.fn(),
  } as unknown as MemoryStore;
}

/** Create a mock EmbeddingService. */
function mockEmbedder(): EmbeddingService {
  return {
    embed: vi.fn().mockResolvedValue(new Float32Array(384)),
    warmup: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
  } as unknown as EmbeddingService;
}

/** Create a mock SessionLogger. */
function mockSessionLogger(): SessionLogger {
  return {
    flushConversation: vi.fn().mockResolvedValue("/tmp/memory/2026-04-09.md"),
    appendEntry: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionLogger;
}

/** Create a silent mock logger. */
function mockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

/** Sample conversation turns for testing. */
function sampleConversation(): ConversationTurn[] {
  return [
    { timestamp: "2026-04-09T10:00:00Z", role: "user", content: "What is TypeScript?" },
    { timestamp: "2026-04-09T10:00:05Z", role: "assistant", content: "TypeScript is a typed superset of JavaScript." },
    { timestamp: "2026-04-09T10:01:00Z", role: "user", content: "How does it handle generics?" },
  ];
}

/** Build CompactionDeps from mocks. */
function makeDeps(overrides: Partial<CompactionDeps> = {}): CompactionDeps {
  return {
    memoryStore: mockMemoryStore(),
    embedder: mockEmbedder(),
    sessionLogger: mockSessionLogger(),
    log: mockLogger(),
    ...overrides,
  };
}

describe("CompactionManager.compact", () => {
  let deps: CompactionDeps;
  let manager: CompactionManager;
  const conversation = sampleConversation();

  beforeEach(() => {
    deps = makeDeps();
    manager = new CompactionManager(deps);
  });

  it("flushes conversation to session log FIRST before any inserts", async () => {
    const callOrder: string[] = [];

    vi.mocked(deps.sessionLogger.flushConversation).mockImplementation(async () => {
      callOrder.push("flush");
      return "/tmp/memory/2026-04-09.md";
    });

    vi.mocked(deps.memoryStore.insert).mockImplementation((_input, _embedding) => {
      callOrder.push("insert");
      return { id: "mem-1", content: "test", source: "conversation" as const, importance: 0.5, accessCount: 0, tags: [], embedding: null, createdAt: "", updatedAt: "", accessedAt: "", tier: "warm" as const, sourceTurnIds: null };
    });

    const extractMemories = vi.fn().mockResolvedValue(["fact1"]);
    await manager.compact(conversation, extractMemories);

    expect(callOrder[0]).toBe("flush");
    expect(callOrder.indexOf("insert")).toBeGreaterThan(callOrder.indexOf("flush"));
  });

  it("records session log entry in store", async () => {
    const extractMemories = vi.fn().mockResolvedValue([]);
    await manager.compact(conversation, extractMemories);

    expect(deps.memoryStore.recordSessionLog).toHaveBeenCalledWith({
      date: "2026-04-09",
      filePath: "/tmp/memory/2026-04-09.md",
      entryCount: 3,
    });
  });

  it("calls extractMemories with full conversation text", async () => {
    const extractMemories = vi.fn().mockResolvedValue([]);
    await manager.compact(conversation, extractMemories);

    const expectedText = conversation
      .map((t) => `[${t.role}]: ${t.content}`)
      .join("\n");

    expect(extractMemories).toHaveBeenCalledWith(expectedText);
  });

  it("embeds and inserts each extracted memory", async () => {
    const extractMemories = vi.fn().mockResolvedValue(["fact one", "fact two", "fact three"]);
    await manager.compact(conversation, extractMemories);

    expect(deps.embedder.embed).toHaveBeenCalledTimes(3);
    expect(deps.embedder.embed).toHaveBeenCalledWith("fact one");
    expect(deps.embedder.embed).toHaveBeenCalledWith("fact two");
    expect(deps.embedder.embed).toHaveBeenCalledWith("fact three");

    expect(deps.memoryStore.insert).toHaveBeenCalledTimes(3);
    for (const call of (deps.memoryStore.insert as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[0]).toEqual(expect.objectContaining({ source: "conversation" }));
      expect(call[1]).toBeInstanceOf(Float32Array);
    }
  });

  it("returns correct logPath, memoriesCreated count, and summary", async () => {
    const extractMemories = vi.fn().mockResolvedValue(["TypeScript uses generics", "Generics enable type safety"]);
    const result = await manager.compact(conversation, extractMemories);

    expect(result.logPath).toBe("/tmp/memory/2026-04-09.md");
    expect(result.memoriesCreated).toBe(2);
    expect(result.summary).toContain("TypeScript uses generics");
    expect(result.summary).toContain("Generics enable type safety");
  });

  it("handles zero extracted memories gracefully", async () => {
    const extractMemories = vi.fn().mockResolvedValue([]);
    const result = await manager.compact(conversation, extractMemories);

    expect(result.memoriesCreated).toBe(0);
    expect(result.summary).toContain("No key facts");
  });
});

describe("CharacterCountFillProvider", () => {
  it("starts at 0% fill", () => {
    const provider = new CharacterCountFillProvider(1000);
    expect(provider.getContextFillPercentage()).toBe(0);
  });

  it("tracks character count from added turns", () => {
    const provider = new CharacterCountFillProvider(1000);
    provider.addTurn("Hello"); // 5 chars
    provider.addTurn("World"); // 5 chars
    expect(provider.getContextFillPercentage()).toBeCloseTo(0.01);
  });

  it("caps at 1.0 when characters exceed max", () => {
    const provider = new CharacterCountFillProvider(10);
    provider.addTurn("This is a longer string");
    expect(provider.getContextFillPercentage()).toBe(1);
  });

  it("resets character count", () => {
    const provider = new CharacterCountFillProvider(1000);
    provider.addTurn("Hello");
    provider.reset();
    expect(provider.getContextFillPercentage()).toBe(0);
  });

  it("uses default maxCharacters of 200000", () => {
    const provider = new CharacterCountFillProvider();
    provider.addTurn("x".repeat(100_000));
    expect(provider.getContextFillPercentage()).toBeCloseTo(0.5);
  });
});
