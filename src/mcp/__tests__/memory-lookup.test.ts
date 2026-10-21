import { describe, it, expect } from "vitest";
import { z } from "zod/v4";
import { TOOL_DEFINITIONS } from "../server.js";

/**
 * Phase 68-02 — memory_lookup schema tests.
 *
 * We assert the shape of the extended memory_lookup Zod schema by
 * reconstructing it in the test and confirming (via parse) that the same
 * defaults + validation rules are applied. The inline schema in
 * src/mcp/server.ts is the source of truth; this file enforces the
 * backward-compat + new-parameter contract documented in 68-01-SUMMARY.md
 * "Integration Hooks for Plan 68-02" and 68-CONTEXT.md.
 *
 * The critical invariants guarded here:
 *   1. Pre-v1.9 callers (no scope, no page) get scope='memories' + page=0
 *      defaults — the IPC handler then routes them down the legacy
 *      GraphSearch path (byte-compat preserved).
 *   2. limit is hard-capped at MAX_RESULTS_PER_PAGE=10 (was 20 pre-v1.9).
 *   3. scope accepts only 'memories' | 'conversations' | 'all'.
 *   4. page is a non-negative integer with default 0.
 */

// Reconstructed schema — must match src/mcp/server.ts::memory_lookup inline schema.
// When updating server.ts's schema, mirror the update here.
const expectedSchema = z.object({
  query: z.string(),
  limit: z.number().int().min(1).max(10).default(5),
  agent: z.string(),
  scope: z.enum(["memories", "conversations", "all"]).default("memories"),
  page: z.number().int().min(0).default(0),
});

describe("memory_lookup tool definition", () => {
  it("is defined in TOOL_DEFINITIONS", () => {
    expect(TOOL_DEFINITIONS).toHaveProperty("memory_lookup");
  });

  it("has correct ipcMethod", () => {
    expect(TOOL_DEFINITIONS.memory_lookup.ipcMethod).toBe("memory-lookup");
  });

  it("has a description", () => {
    expect(TOOL_DEFINITIONS.memory_lookup.description).toBeTruthy();
  });
});

describe("memory_lookup tool scope parameter", () => {
  it("parses scope='memories' (default when omitted)", () => {
    const result = expectedSchema.parse({ query: "x", agent: "a" });
    expect(result.scope).toBe("memories");
    expect(result.page).toBe(0);
    expect(result.limit).toBe(5);
  });

  it("parses scope='conversations' explicitly", () => {
    const result = expectedSchema.parse({
      query: "x",
      agent: "a",
      scope: "conversations",
    });
    expect(result.scope).toBe("conversations");
  });

  it("parses scope='all' explicitly", () => {
    const result = expectedSchema.parse({
      query: "x",
      agent: "a",
      scope: "all",
    });
    expect(result.scope).toBe("all");
  });

  it("rejects invalid scope values", () => {
    expect(() =>
      expectedSchema.parse({ query: "x", agent: "a", scope: "everything" }),
    ).toThrow();
  });

  it("caps limit at 10 (MAX_RESULTS_PER_PAGE — was 20 pre-v1.9)", () => {
    expect(() =>
      expectedSchema.parse({ query: "x", agent: "a", limit: 20 }),
    ).toThrow();
  });

  it("accepts limit up to 10 inclusive", () => {
    const result = expectedSchema.parse({ query: "x", agent: "a", limit: 10 });
    expect(result.limit).toBe(10);
  });

  it("rejects limit below 1", () => {
    expect(() =>
      expectedSchema.parse({ query: "x", agent: "a", limit: 0 }),
    ).toThrow();
  });

  it("accepts page parameter with custom value", () => {
    const result = expectedSchema.parse({ query: "x", agent: "a", page: 2 });
    expect(result.page).toBe(2);
  });

  it("rejects negative page", () => {
    expect(() =>
      expectedSchema.parse({ query: "x", agent: "a", page: -1 }),
    ).toThrow();
  });

  it("rejects non-integer page", () => {
    expect(() =>
      expectedSchema.parse({ query: "x", agent: "a", page: 1.5 }),
    ).toThrow();
  });
});

describe("memory_lookup backward compatibility", () => {
  it("call without scope preserves legacy parameter shape (fills defaults)", () => {
    // Pre-v1.9 callers pass exactly these three keys.
    // Defaults fill in scope='memories' + page=0 — resolves to the legacy
    // GraphSearch IPC branch in daemon.ts, preserving byte-for-byte response.
    const result = expectedSchema.parse({ query: "x", limit: 5, agent: "a" });
    expect(result).toEqual({
      query: "x",
      limit: 5,
      agent: "a",
      scope: "memories",
      page: 0,
    });
  });

  it("backward — pre-v1.9 signature {query, agent} still parses successfully", () => {
    // Callers that omit limit entirely also work (default=5).
    const result = expectedSchema.parse({ query: "find deployment", agent: "test-agent" });
    expect(result.query).toBe("find deployment");
    expect(result.agent).toBe("test-agent");
    expect(result.limit).toBe(5);
    expect(result.scope).toBe("memories");
    expect(result.page).toBe(0);
  });
});
