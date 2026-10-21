/**
 * Phase 999.122 — memory-census heartbeat check.
 */

import { describe, it, expect } from "vitest";
import memoryCensusCheck from "../memory-census.js";
import type { CheckContext } from "../../types.js";

type Overrides = {
  integrity?: Partial<Record<string, number>>;
  coldFiles?: number;
  staleActive?: number;
  missingV2?: number;
  readVersion?: string;
};

function makeContext(agentName: string, o: Overrides = {}, withStore = true): CheckContext {
  const integrity = {
    danglingLinks: 0,
    danglingSessionSummaries: 0,
    orphanVecV1: 0,
    orphanVecV2: 0,
    orphanChunkVecV1: 0,
    orphanChunkVecV2: 0,
    orphanChunkFts: 0,
    fkViolations: 0,
    memoriesWithoutEmbedding: 0,
    total: 0,
    ...o.integrity,
  };
  const store = {
    checkIntegrity: () => integrity,
    getDatabase: () => ({
      prepare: () => ({
        all: () => [
          { tier: "hot", n: 10 },
          { tier: "warm", n: 90 },
          { tier: "cold", n: 100 },
        ],
      }),
    }),
    getEmbeddingReadVersion: () => o.readVersion ?? "v2",
    countMemoriesMissingV2Embedding: () => o.missingV2 ?? 0,
    countChunksMissingV2Embedding: () => 0,
  };
  const sessionManager = {
    getMemoryStore: () => (withStore ? store : undefined),
    getTierManager: () => ({ coldArchiveFileCount: () => o.coldFiles ?? 0 }),
    getConversationStore: () => ({
      getSessionHealth: () => ({
        total: 40,
        active: 2,
        activeEmpty: 1,
        staleActive: o.staleActive ?? 0,
        emptyTerminated: 3,
      }),
    }),
    getRunningAgents: () => [agentName],
  };
  return {
    agentName,
    sessionManager: sessionManager as unknown as CheckContext["sessionManager"],
    registry: { agents: [] } as unknown as CheckContext["registry"],
    config: { enabled: true, intervalSeconds: 60, checkTimeoutSeconds: 10, contextFill: { warningThreshold: 0.6, criticalThreshold: 0.75 } },
  };
}

describe("memory-census check", () => {
  it("is healthy with the sizes and the read path in the message, census in metadata", async () => {
    const r = await memoryCensusCheck.execute(makeContext("fin-client", { missingV2: 2 }));
    expect(r.status).toBe("healthy");
    expect(r.message).toBe(
      "memories 200 (hot 10 / warm 90 / cold 100) · FK 0 · orphans 0 · sessions 2 active · reads v2 (v2 99% covered)",
    );
    expect(r.metadata).toMatchObject({
      memories: 200,
      tierCounts: { hot: 10, warm: 90, cold: 100 },
      embedding: { readVersion: "v2", memoriesMissingV2: 2, v2Coverage: 0.99 },
      sessions: { staleActive: 0 },
    });
  });

  it("warns, naming the problems and the repair command, when the store needs the doctor", async () => {
    const r = await memoryCensusCheck.execute(
      makeContext("fin-research", {
        integrity: { fkViolations: 1, danglingLinks: 3, total: 3, memoriesWithoutEmbedding: 256 },
        coldFiles: 118,
        staleActive: 263,
      }),
    );
    expect(r.status).toBe("warning");
    expect(r.message).toContain("1 foreign-key violation(s)");
    expect(r.message).toContain("3 repairable integrity issue(s)");
    expect(r.message).toContain("256 memories without any embedding");
    expect(r.message).toContain("118 legacy cold archive file(s)");
    expect(r.message).toContain("263 stale active session rows");
    expect(r.message).toContain("clawcode memory doctor -a fin-research --repair");
    expect((r.metadata as { problems: string[] }).problems).toHaveLength(5);
  });

  it("skips derived sessions that share the parent store", async () => {
    const r = await memoryCensusCheck.execute(makeContext("projects-fork-6NMty0"));
    expect(r.status).toBe("healthy");
    expect(r.metadata).toMatchObject({ skipped: true });
  });

  it("is healthy with no store", async () => {
    const r = await memoryCensusCheck.execute(makeContext("stopped-agent", {}, false));
    expect(r).toEqual({ status: "healthy", message: "No memory store" });
  });

  it("degrades to a warning when the census throws", async () => {
    const ctx = makeContext("fin-client");
    (ctx.sessionManager as unknown as { getMemoryStore: () => unknown }).getMemoryStore = () => ({
      checkIntegrity: () => {
        throw new Error("database is locked");
      },
    });
    const r = await memoryCensusCheck.execute(ctx);
    expect(r.status).toBe("warning");
    expect(r.message).toBe("memory-census failed: database is locked");
  });
});
