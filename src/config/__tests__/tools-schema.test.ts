import { describe, it, expect } from "vitest";
import {
  agentSchema,
  defaultsSchema,
  IDEMPOTENT_TOOL_DEFAULTS,
  toolsConfigSchema,
} from "../schema.js";

describe("toolsConfigSchema (Phase 55)", () => {
  it("applies defaults (maxConcurrent=10, idempotent=IDEMPOTENT_TOOL_DEFAULTS) when empty object passed", () => {
    const result = toolsConfigSchema.parse({});
    expect(result.maxConcurrent).toBe(10);
    expect(result.idempotent).toEqual([...IDEMPOTENT_TOOL_DEFAULTS]);
    expect(result.slos).toBeUndefined();
  });

  it("overriding maxConcurrent keeps the default idempotent whitelist intact", () => {
    const result = toolsConfigSchema.parse({ maxConcurrent: 5 });
    expect(result.maxConcurrent).toBe(5);
    expect(result.idempotent).toEqual([...IDEMPOTENT_TOOL_DEFAULTS]);
  });

  it("rejects maxConcurrent: 0 (hard floor of 1 prevents dispatcher deadlock)", () => {
    expect(() => toolsConfigSchema.parse({ maxConcurrent: 0 })).toThrow();
    expect(() => toolsConfigSchema.parse({ maxConcurrent: -1 })).toThrow();
  });

  it("accepts slos record with optional metric field", () => {
    const result = toolsConfigSchema.parse({
      slos: {
        memory_lookup: { thresholdMs: 50 },
        search_documents: { thresholdMs: 100, metric: "p99" },
      },
    });
    expect(result.slos).toEqual({
      memory_lookup: { thresholdMs: 50 },
      search_documents: { thresholdMs: 100, metric: "p99" },
    });
    // Defaults still applied for other fields.
    expect(result.maxConcurrent).toBe(10);
    expect(result.idempotent).toEqual([...IDEMPOTENT_TOOL_DEFAULTS]);
  });

  it("agentSchema.perf.tools accepts a tools block with a custom maxConcurrent", () => {
    const result = agentSchema.parse({
      name: "x",
      perf: { tools: { maxConcurrent: 3 } },
    });
    // After Zod parses, perf.tools.maxConcurrent is populated (default or override),
    // perf.tools.idempotent is populated from IDEMPOTENT_TOOL_DEFAULTS.
    expect(result.perf?.tools?.maxConcurrent).toBe(3);
    expect(result.perf?.tools?.idempotent).toEqual([
      ...IDEMPOTENT_TOOL_DEFAULTS,
    ]);
  });

  it("defaultsSchema.perf accepts optional tools block (or omits it entirely)", () => {
    const withoutTools = defaultsSchema.parse({});
    expect(withoutTools.perf).toBeUndefined();

    const withTools = defaultsSchema.parse({
      perf: {
        tools: {
          slos: { memory_lookup: { thresholdMs: 75, metric: "p95" } },
        },
      },
    });
    expect(withTools.perf?.tools?.slos?.memory_lookup).toEqual({
      thresholdMs: 75,
      metric: "p95",
    });
    // Defaults applied even via defaultsSchema path.
    expect(withTools.perf?.tools?.maxConcurrent).toBe(10);
  });

  it("IDEMPOTENT_TOOL_DEFAULTS contains EXACTLY the 4 CONTEXT D-02 entries + Phase 71 web-search tools", () => {
    // Correctness-critical: if a non-idempotent tool sneaks into this list, the
    // intra-turn cache (Plan 55-02) would serve stale results for side-effectful
    // tools. Phase 71 (SEARCH-03) extends the list with `web_search` +
    // `web_fetch_url` — both are read-only from the agent's perspective, so
    // duplicate intra-turn calls can safely return cached results.
    expect(IDEMPOTENT_TOOL_DEFAULTS).toHaveLength(6);
    expect([...IDEMPOTENT_TOOL_DEFAULTS]).toEqual([
      "memory_lookup",
      "search_documents",
      "memory_list",
      "memory_graph",
      "web_search",
      "web_fetch_url",
    ]);
    // Non-idempotent tools MUST NOT appear.
    const forbidden = [
      "memory_save",
      "spawn_subagent_thread",
      "ingest_document",
      "delete_document",
      "send_message",
      "send_to_agent",
      "send_attachment",
      "ask_advisor",
    ];
    for (const bad of forbidden) {
      expect(IDEMPOTENT_TOOL_DEFAULTS).not.toContain(bad);
    }
    // Frozen (cannot be mutated at runtime).
    expect(Object.isFrozen(IDEMPOTENT_TOOL_DEFAULTS)).toBe(true);
  });
});
