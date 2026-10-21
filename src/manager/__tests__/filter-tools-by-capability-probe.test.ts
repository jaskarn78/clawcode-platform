/**
 * Phase 94 Plan 02 Task 1 — TDD RED for filterToolsByCapabilityProbe.
 *
 * Pure module: same `(tools, deps)` input → same output. The LLM-visible
 * tool list is filtered to those backed by an MCP server whose
 * capabilityProbe.status === "ready". D-12 flap-stability window prevents
 * prompt-cache prefix-hash yo-yo when a server flips ready ↔ degraded
 * within 5 minutes.
 *
 * 9 FT-* tests pin the contract:
 *   FT-READY            — single ready server, tool kept (output frozen)
 *   FT-DEGRADED         — degraded server, tool filtered out
 *   FT-FAILED           — failed server, tool filtered out
 *   FT-RECONNECTING     — reconnecting status treated as degraded (D-12)
 *   FT-UNKNOWN          — unknown / missing-probe filtered (conservative)
 *   FT-BUILTIN          — tools without mcpServer always pass (Read/Bash/Write)
 *   FT-MIXED            — combined: some kept, some filtered, builtins pass
 *   FT-IDEMPOTENT       — same input twice yields deep-equal output
 *   FT-FLAP-STABILITY   — D-12 5min window: 3 transitions → sticky degraded
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  filterToolsByCapabilityProbe,
  FLAP_WINDOW_MS,
  FLAP_TRANSITION_THRESHOLD,
  type ToolDef,
  type FilterDeps,
  type FlapHistoryEntry,
} from "../filter-tools-by-capability-probe.js";
import type {
  CapabilityProbeStatus,
  McpServerState,
} from "../../mcp/readiness.js";

/**
 * Build a minimal McpServerState fixture with a populated capabilityProbe
 * field. The Phase 85 connect-test status mirrors the probe status here
 * (ready map → ready connect-test) for fixture simplicity — the filter
 * only reads `capabilityProbe.status`.
 */
function makeState(
  serverName: string,
  status: CapabilityProbeStatus,
  lastRunAt = "2026-04-25T12:00:00.000Z",
): ReadonlyMap<string, McpServerState> {
  const connectStatus =
    status === "unknown" || status === "reconnecting"
      ? "reconnecting"
      : status;
  return new Map<string, McpServerState>([
    [
      serverName,
      {
        name: serverName,
        status: connectStatus as McpServerState["status"],
        lastSuccessAt: status === "ready" ? Date.parse(lastRunAt) : null,
        lastFailureAt: status === "ready" ? null : Date.parse(lastRunAt),
        lastError: null,
        failureCount: 0,
        optional: false,
        capabilityProbe: { status, lastRunAt },
      },
    ],
  ]);
}

describe("filterToolsByCapabilityProbe — D-04 dynamic tool advertising", () => {
  it("FT-READY: ready server's tool passes; output frozen", () => {
    const tools: readonly ToolDef[] = [
      { name: "browser_snapshot", mcpServer: "browser" },
    ];
    const deps: FilterDeps = { snapshot: makeState("browser", "ready") };

    const result = filterToolsByCapabilityProbe(tools, deps);

    expect(result).toEqual([{ name: "browser_snapshot", mcpServer: "browser" }]);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("FT-DEGRADED: degraded server's tool filtered out", () => {
    const tools: readonly ToolDef[] = [
      { name: "browser_snapshot", mcpServer: "browser" },
    ];
    const deps: FilterDeps = { snapshot: makeState("browser", "degraded") };

    const result = filterToolsByCapabilityProbe(tools, deps);

    expect(result).toEqual([]);
  });

  it("FT-FAILED: failed server's tool filtered out", () => {
    const tools: readonly ToolDef[] = [
      { name: "browser_snapshot", mcpServer: "browser" },
    ];
    const deps: FilterDeps = { snapshot: makeState("browser", "failed") };

    const result = filterToolsByCapabilityProbe(tools, deps);

    expect(result).toEqual([]);
  });

  it("FT-RECONNECTING: reconnecting status treated as degraded (D-12)", () => {
    const tools: readonly ToolDef[] = [
      { name: "browser_snapshot", mcpServer: "browser" },
    ];
    const deps: FilterDeps = {
      snapshot: makeState("browser", "reconnecting"),
    };

    const result = filterToolsByCapabilityProbe(tools, deps);

    expect(result).toEqual([]);
  });

  it("FT-UNKNOWN: unknown status (or missing capabilityProbe) filtered out", () => {
    const tools: readonly ToolDef[] = [
      { name: "browser_snapshot", mcpServer: "browser" },
    ];
    // (a) explicit unknown
    const depsUnknown: FilterDeps = {
      snapshot: makeState("browser", "unknown"),
    };
    expect(filterToolsByCapabilityProbe(tools, depsUnknown)).toEqual([]);

    // (b) capabilityProbe field absent entirely (legacy snapshot)
    const legacyState: McpServerState = {
      name: "browser",
      status: "ready",
      lastSuccessAt: 0,
      lastFailureAt: null,
      lastError: null,
      failureCount: 0,
      optional: false,
      // no capabilityProbe
    };
    const depsLegacy: FilterDeps = {
      snapshot: new Map([["browser", legacyState]]),
    };
    expect(filterToolsByCapabilityProbe(tools, depsLegacy)).toEqual([]);

    // (c) server entry missing entirely
    const depsMissing: FilterDeps = { snapshot: new Map() };
    expect(filterToolsByCapabilityProbe(tools, depsMissing)).toEqual([]);
  });

  it("FT-BUILTIN: tools without mcpServer always pass (Read/Write/Bash)", () => {
    const tools: readonly ToolDef[] = [
      { name: "Read" },
      { name: "Write" },
      { name: "Bash" },
    ];
    const deps: FilterDeps = { snapshot: new Map() };

    const result = filterToolsByCapabilityProbe(tools, deps);

    expect(result).toEqual([{ name: "Read" }, { name: "Write" }, { name: "Bash" }]);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("FT-MIXED: some kept, some filtered, built-ins always pass", () => {
    const tools: readonly ToolDef[] = [
      { name: "a", mcpServer: "x" },
      { name: "b", mcpServer: "y" },
      { name: "Read" },
    ];
    const snapshot = new Map<string, McpServerState>([
      ...makeState("x", "ready").entries(),
      ...makeState("y", "degraded").entries(),
    ]);
    const deps: FilterDeps = { snapshot };

    const result = filterToolsByCapabilityProbe(tools, deps);

    expect(result).toEqual([
      { name: "a", mcpServer: "x" },
      { name: "Read" },
    ]);
  });

  it("FT-IDEMPOTENT: same input twice yields deep-equal output; result is frozen", () => {
    const tools: readonly ToolDef[] = [
      { name: "browser_snapshot", mcpServer: "browser" },
      { name: "Read" },
    ];
    const deps: FilterDeps = { snapshot: makeState("browser", "ready") };

    const r1 = filterToolsByCapabilityProbe(tools, deps);
    const r2 = filterToolsByCapabilityProbe(tools, deps);

    expect(r1).toEqual(r2);
    expect(Object.isFrozen(r1)).toBe(true);
    expect(Object.isFrozen(r2)).toBe(true);

    // Re-filtering the output with the same deps is idempotent.
    const r3 = filterToolsByCapabilityProbe(r1, deps);
    expect(r3).toEqual(r1);
  });

  it("FT-FLAP-STABILITY: 3 transitions in 5min window → sticky degraded; window resets after 5min", () => {
    // D-12: server flapping ready ↔ degraded ≥ FLAP_TRANSITION_THRESHOLD (3)
    // times within FLAP_WINDOW_MS (5min) is treated as degraded for the rest
    // of the window even when current snapshot says ready. Prevents prompt-
    // cache prefix-hash yo-yo.
    expect(FLAP_WINDOW_MS).toBe(5 * 60 * 1000);
    expect(FLAP_TRANSITION_THRESHOLD).toBe(3);

    const tools: readonly ToolDef[] = [
      { name: "browser_snapshot", mcpServer: "browser" },
    ];
    const flapHistory = new Map<string, FlapHistoryEntry>();
    let nowMs = Date.parse("2026-04-25T12:00:00.000Z");
    const now = (): Date => new Date(nowMs);

    // Tick 1: ready (initial, no transition recorded)
    let result = filterToolsByCapabilityProbe(tools, {
      snapshot: makeState("browser", "ready"),
      flapHistory,
      now,
    });
    expect(result).toEqual([{ name: "browser_snapshot", mcpServer: "browser" }]);

    // Tick 2: degraded (transition #1)
    nowMs += 30_000;
    result = filterToolsByCapabilityProbe(tools, {
      snapshot: makeState("browser", "degraded"),
      flapHistory,
      now,
    });
    expect(result).toEqual([]); // currently degraded anyway

    // Tick 3: ready (transition #2)
    nowMs += 30_000;
    result = filterToolsByCapabilityProbe(tools, {
      snapshot: makeState("browser", "ready"),
      flapHistory,
      now,
    });
    expect(result).toEqual([{ name: "browser_snapshot", mcpServer: "browser" }]);

    // Tick 4: degraded (transition #3 — threshold reached → sticky)
    nowMs += 30_000;
    result = filterToolsByCapabilityProbe(tools, {
      snapshot: makeState("browser", "degraded"),
      flapHistory,
      now,
    });
    expect(result).toEqual([]);

    // Tick 5: ready, BUT sticky-degraded engaged within window
    nowMs += 30_000;
    result = filterToolsByCapabilityProbe(tools, {
      snapshot: makeState("browser", "ready"),
      flapHistory,
      now,
    });
    expect(result).toEqual([]); // sticky — flap stability suppresses the ready signal

    const stickyEntry = flapHistory.get("browser");
    expect(stickyEntry?.stickyDegraded).toBe(true);

    // Advance past window — resets, ready returns
    nowMs += FLAP_WINDOW_MS + 1;
    result = filterToolsByCapabilityProbe(tools, {
      snapshot: makeState("browser", "ready"),
      flapHistory,
      now,
    });
    expect(result).toEqual([{ name: "browser_snapshot", mcpServer: "browser" }]);
    const reset = flapHistory.get("browser");
    expect(reset?.stickyDegraded).toBe(false);
  });
});

describe("FT-REG-SINGLE-SRC: single-source-of-truth filter call site (D-04 + plan rule 3)", () => {
  it("session-config.ts is the SOLE call site of filterToolsByCapabilityProbe", () => {
    const sessionConfig = readFileSync(
      "src/manager/session-config.ts",
      "utf8",
    );
    expect(sessionConfig).toContain("filterToolsByCapabilityProbe");
  });

  it("context-assembler.ts MUST NOT call the filter (consumes filtered output)", () => {
    const assembler = readFileSync(
      "src/manager/context-assembler.ts",
      "utf8",
    );
    // Allow the contract comment to mention the function name once but
    // reject any actual `filterToolsByCapabilityProbe(` call expression.
    expect(assembler).not.toMatch(/filterToolsByCapabilityProbe\s*\(/);
  });

  it("mcp-prompt-block.ts MUST NOT call the filter (renders given list)", () => {
    const block = readFileSync("src/manager/mcp-prompt-block.ts", "utf8");
    expect(block).not.toMatch(/filterToolsByCapabilityProbe\s*\(/);
  });

  it("FT-PURITY: filter module has no fs/sdk/setTimeout/process.env imports", () => {
    const src = readFileSync(
      "src/manager/filter-tools-by-capability-probe.ts",
      "utf8",
    );
    expect(src).not.toMatch(/from\s+["']node:fs/);
    expect(src).not.toMatch(/from\s+["']@anthropic-ai\/claude-agent-sdk/);
    expect(src).not.toMatch(/setTimeout\s*\(/);
    expect(src).not.toMatch(/process\.env/);
  });
});
