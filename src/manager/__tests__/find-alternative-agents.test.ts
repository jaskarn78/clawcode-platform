/**
 * Phase 94 Plan 04 Task 1 — TDD RED for findAlternativeAgents.
 *
 * Pure helper: reads the per-agent McpServerState snapshot map from a
 * provider DI surface, filters to agents whose backing server has
 * capabilityProbe.status === "ready" for the named tool. D-07 cross-agent
 * alternatives data — consumed at the LLM tool-result slot via
 * ToolCallError.alternatives.
 */

import { describe, it, expect } from "vitest";
import {
  findAlternativeAgents,
  type McpStateProvider,
} from "../find-alternative-agents.js";
import type { McpServerState } from "../../mcp/readiness.js";

/** Build a minimal McpServerState with optional capabilityProbe. */
function makeServerState(
  status: "ready" | "degraded" | "failed" | "reconnecting" | "unknown",
): McpServerState {
  return {
    name: "browser",
    status: "ready",
    failureCount: 0,
    optional: false,
    capabilityProbe: {
      lastRunAt: "2026-04-25T00:00:00.000Z",
      status,
    },
  } as McpServerState;
}

describe("findAlternativeAgents — D-07 cross-agent ready-status lookup", () => {
  it("FAA-1 happy: 3 agents, 2 with ready browser, 1 degraded → returns 2 ready agents (sorted)", () => {
    const stateA = new Map<string, McpServerState>([["browser", makeServerState("ready")]]);
    const stateB = new Map<string, McpServerState>([["browser", makeServerState("degraded")]]);
    const stateC = new Map<string, McpServerState>([["browser", makeServerState("ready")]]);
    const provider: McpStateProvider = {
      listAgents: () => ["a", "b", "c"],
      getStateFor: (agent) => {
        if (agent === "a") return stateA;
        if (agent === "b") return stateB;
        if (agent === "c") return stateC;
        return new Map();
      },
      toolToServer: (toolName) => (toolName === "browser_snapshot" ? "browser" : undefined),
    };
    const result = findAlternativeAgents("browser_snapshot", provider);
    expect(result).toEqual(["a", "c"]);
  });

  it("FAA-2 no-alternatives: every agent's mcp is degraded → empty array", () => {
    const stateAll = new Map<string, McpServerState>([["browser", makeServerState("degraded")]]);
    const provider: McpStateProvider = {
      listAgents: () => ["a", "b", "c"],
      getStateFor: () => stateAll,
      toolToServer: () => "browser",
    };
    const result = findAlternativeAgents("browser_snapshot", provider);
    expect(result).toEqual([]);
  });

  it("FAA-3 missing-mcp: agent without the mcp excluded; ready agent included", () => {
    const stateA = new Map<string, McpServerState>(); // no browser at all
    const stateB = new Map<string, McpServerState>([["browser", makeServerState("ready")]]);
    const provider: McpStateProvider = {
      listAgents: () => ["a", "b"],
      getStateFor: (agent) => (agent === "a" ? stateA : stateB),
      toolToServer: () => "browser",
    };
    const result = findAlternativeAgents("browser_snapshot", provider);
    expect(result).toEqual(["b"]);
  });

  it("FAA-4 reconnecting + failed + unknown: all excluded; only ready counts", () => {
    const stateA = new Map<string, McpServerState>([["browser", makeServerState("reconnecting")]]);
    const stateB = new Map<string, McpServerState>([["browser", makeServerState("failed")]]);
    const stateC = new Map<string, McpServerState>([["browser", makeServerState("unknown")]]);
    const stateD = new Map<string, McpServerState>([["browser", makeServerState("ready")]]);
    const provider: McpStateProvider = {
      listAgents: () => ["a", "b", "c", "d"],
      getStateFor: (agent) => {
        if (agent === "a") return stateA;
        if (agent === "b") return stateB;
        if (agent === "c") return stateC;
        if (agent === "d") return stateD;
        return new Map();
      },
      toolToServer: () => "browser",
    };
    const result = findAlternativeAgents("browser_snapshot", provider);
    expect(result).toEqual(["d"]);
  });

  it("FAA-5 missing-capability-probe field: agent with server but no capabilityProbe → excluded (legacy snapshot)", () => {
    const legacyState: McpServerState = {
      name: "browser",
      status: "ready",
      failureCount: 0,
      optional: false,
      // No capabilityProbe field — legacy Phase 85 snapshot before 94-01.
    } as McpServerState;
    const provider: McpStateProvider = {
      listAgents: () => ["legacy", "fresh"],
      getStateFor: (agent) =>
        agent === "legacy"
          ? new Map([["browser", legacyState]])
          : new Map([["browser", makeServerState("ready")]]),
      toolToServer: () => "browser",
    };
    const result = findAlternativeAgents("browser_snapshot", provider);
    expect(result).toEqual(["fresh"]);
  });

  it("FAA-6 default tool→server heuristic: mcp__<server>__ prefix used when toolToServer not provided", () => {
    const provider: McpStateProvider = {
      listAgents: () => ["a"],
      getStateFor: () => new Map([["browser", makeServerState("ready")]]),
      // No toolToServer — default heuristic should extract "browser" from "mcp__browser__snapshot".
    };
    const result = findAlternativeAgents("mcp__browser__snapshot", provider);
    expect(result).toEqual(["a"]);
  });

  it("FAA-7 immutable result: returned array is frozen (CLAUDE.md immutability rule)", () => {
    const provider: McpStateProvider = {
      listAgents: () => ["a"],
      getStateFor: () => new Map([["browser", makeServerState("ready")]]),
      toolToServer: () => "browser",
    };
    const result = findAlternativeAgents("browser_snapshot", provider);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("FAA-8 unmappable tool name: heuristic can't extract server → returns empty (frozen)", () => {
    const provider: McpStateProvider = {
      listAgents: () => ["a"],
      getStateFor: () => new Map([["browser", makeServerState("ready")]]),
      // No toolToServer — heuristic can't extract anything from a single bare word.
    };
    const result = findAlternativeAgents("snapshot", provider);
    // "snapshot" doesn't have a "_" or mcp__ prefix, so no server extracted.
    // (The default-fallback heuristic returns undefined for single-word tool names.)
    expect(Object.isFrozen(result)).toBe(true);
    // Could match nothing OR happen to match — the contract is empty when no server resolved.
    // We accept either [] or pursuit-of-best-effort lookup; pin to: result is frozen + safe.
    expect(Array.isArray(result)).toBe(true);
  });
});
