/**
 * Phase 115 Plan 03 sub-scope 11 — Tier 1 / Tier 2 discriminated-union
 * type-shape regression tests.
 *
 * The Tier 1 / Tier 2 boundary is exposed in code as a TypeScript
 * discriminated union (`MemoryTier1Source` | `MemoryTier2Source`).
 * Plan 115-04 will consume these types by name, so this suite pins:
 *   1. Both interfaces are exported from `src/memory/types.ts`.
 *   2. The `tier` discriminator narrows correctly at runtime via
 *      string-literal switches (the union is sound).
 *   3. The pre-existing `MemorySource` string union and `MemoryTier`
 *      hot/warm/cold storage tier are NOT shadowed by the new types.
 *   4. The `ContextSources.identityMemoryAutoloadSource` field on the
 *      assembler accepts a `MemoryTier1Source` shape (compile-time check
 *      via assignment).
 */

import { describe, it, expect, expectTypeOf } from "vitest";
import type {
  MemoryTier1Source,
  MemoryTier2Source,
  TypedMemorySource,
  MemorySource as MemorySourceStringUnion,
  MemoryTier as StorageTier,
} from "../types.js";
import type { ContextSources } from "../../manager/context-assembler.js";

describe("MemoryTier1Source / MemoryTier2Source discriminated union", () => {
  it("MemoryTier1Source has tier='tier1' and the four curated source kinds", () => {
    const t1Memory: MemoryTier1Source = {
      tier: "tier1",
      source: "memory",
      path: "/home/example-user/.clawcode/agents/test-agent/MEMORY.md",
      maxChars: 16_000,
      content: "## Long-term memory\n\n- Test entry",
    };
    const t1Soul: MemoryTier1Source = {
      tier: "tier1",
      source: "soul",
      path: "/home/example-user/.clawcode/agents/test-agent/SOUL.md",
      maxChars: 1200,
      content: "Identity fingerprint",
    };
    const t1Identity: MemoryTier1Source = {
      tier: "tier1",
      source: "identity",
      path: "/home/example-user/.clawcode/agents/test-agent/IDENTITY.md",
      maxChars: 4000,
      content: "## Persona\n\nClawdy",
    };
    const t1User: MemoryTier1Source = {
      tier: "tier1",
      source: "user",
      path: "/home/example-user/.clawcode/agents/test-agent/USER.md",
      maxChars: 2000,
      content: "## Operator\n\nName: example-user",
    };

    expect(t1Memory.tier).toBe("tier1");
    expect(t1Memory.source).toBe("memory");
    expect(t1Memory.maxChars).toBe(16_000);
    expect(t1Soul.source).toBe("soul");
    expect(t1Identity.source).toBe("identity");
    expect(t1User.source).toBe("user");
  });

  it("MemoryTier2Source has tier='tier2' and chunkId/memoryId optional fields", () => {
    const t2Chunk: MemoryTier2Source = {
      tier: "tier2",
      source: "chunks",
      chunkId: "chunk-abc-123",
      content: "Body of the chunk row.",
      tags: ["procedures"],
      importance: 0.7,
    };
    const t2Memory: MemoryTier2Source = {
      tier: "tier2",
      source: "memories",
      memoryId: "mem-xyz-456",
      content: "Memory text from memory_save.",
      tags: [],
      importance: 0.5,
    };

    expect(t2Chunk.tier).toBe("tier2");
    expect(t2Chunk.source).toBe("chunks");
    expect(t2Chunk.chunkId).toBe("chunk-abc-123");
    expect(t2Memory.tier).toBe("tier2");
    expect(t2Memory.memoryId).toBe("mem-xyz-456");
  });

  it("discriminator narrows TypedMemorySource at runtime via switch on `tier`", () => {
    const sources: TypedMemorySource[] = [
      {
        tier: "tier1",
        source: "memory",
        path: "/m.md",
        maxChars: 16_000,
        content: "T1 content",
      },
      {
        tier: "tier2",
        source: "chunks",
        chunkId: "c1",
        content: "T2 content",
        tags: [],
        importance: 0.5,
      },
    ];

    const t1Hits: MemoryTier1Source[] = [];
    const t2Hits: MemoryTier2Source[] = [];

    for (const src of sources) {
      switch (src.tier) {
        case "tier1":
          // narrowing should make `path` and `maxChars` accessible.
          expect(src.path).toBeDefined();
          expect(src.maxChars).toBeGreaterThan(0);
          t1Hits.push(src);
          break;
        case "tier2":
          // narrowing should make `tags` and `importance` accessible.
          expect(Array.isArray(src.tags)).toBe(true);
          expect(typeof src.importance).toBe("number");
          t2Hits.push(src);
          break;
      }
    }

    expect(t1Hits).toHaveLength(1);
    expect(t2Hits).toHaveLength(1);
  });

  it("ContextSources.identityMemoryAutoloadSource accepts MemoryTier1Source", () => {
    const tier1Memory: MemoryTier1Source = {
      tier: "tier1",
      source: "memory",
      path: "/x.md",
      maxChars: 16_000,
      content: "body",
    };

    // Assignment-style compile + runtime check that the field is wired
    // through `ContextSources` as documented for Plan 115-04 consumption.
    const partialSources: Pick<ContextSources, "identityMemoryAutoloadSource"> = {
      identityMemoryAutoloadSource: tier1Memory,
    };

    expect(partialSources.identityMemoryAutoloadSource?.tier).toBe("tier1");
    expect(partialSources.identityMemoryAutoloadSource?.source).toBe("memory");
    expect(partialSources.identityMemoryAutoloadSource?.content).toBe("body");
  });

  it("does not shadow the pre-existing MemorySource string union", () => {
    // Compile-time: the legacy MemorySource alias still resolves to the
    // string-union shape (NOT the new discriminated union). A runtime
    // assignment exercises the type alias.
    const legacy: MemorySourceStringUnion = "conversation";
    expect(legacy).toBe("conversation");
    expectTypeOf<MemorySourceStringUnion>().toEqualTypeOf<
      "conversation" | "manual" | "system" | "consolidation" | "episode"
    >();
  });

  it("does not shadow the pre-existing storage MemoryTier (hot/warm/cold)", () => {
    // `MemoryTier` (storage tier) is independent from
    // `MemoryTier1Source["tier"]` / `MemoryTier2Source["tier"]`. Pin both
    // remain accessible by name without collision.
    const storage: StorageTier = "hot";
    expect(storage).toBe("hot");
    expectTypeOf<StorageTier>().toEqualTypeOf<"hot" | "warm" | "cold">();
  });
});
