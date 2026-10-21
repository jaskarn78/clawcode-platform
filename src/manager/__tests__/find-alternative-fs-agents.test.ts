/**
 * Phase 96 Plan 03 — D-08 cross-agent FS alternatives lookup (TDD RED).
 *
 * Pure helper: reads per-agent FsCapabilitySnapshot maps from a DI provider,
 * filters to agents whose snapshot has the queried path with status='ready'.
 * Used by clawcode_list_files (and future fs read tools) to populate the
 * `alternatives` field on permission-class ToolCallError responses — when
 * fin-client can't read /home/X but admin-clawdy can, the LLM gets
 * that hint structured into the error.
 *
 * Mirrors Phase 94's findAlternativeAgents shape — same provider DI pattern,
 * same Object.freeze immutability contract, same ASCII-sorted output. Only
 * the per-agent state Map and the readiness predicate differ
 * (FsCapabilitySnapshot vs McpServerState).
 */

import { describe, it, expect } from "vitest";
import {
  findAlternativeFsAgents,
  type FindAlternativeFsAgentsDeps,
} from "../find-alternative-fs-agents.js";
import type { FsCapabilitySnapshot } from "../persistent-session-handle.js";

/** Build a minimal FsCapabilitySnapshot with the chosen status. */
function makeSnapshot(
  status: "ready" | "degraded" | "unknown",
  mode: "rw" | "ro" | "denied" = "ro",
): FsCapabilitySnapshot {
  return {
    status,
    mode,
    lastProbeAt: "2026-04-25T19:00:00.000Z",
    ...(status === "ready"
      ? { lastSuccessAt: "2026-04-25T19:00:00.000Z" }
      : {}),
  };
}

describe("findAlternativeFsAgents — D-08 cross-agent FS-ready-status lookup", () => {
  it("FAFS-1 EMPTY-PROVIDER: deps.listAgentNames returns [] → []", () => {
    const deps: FindAlternativeFsAgentsDeps = {
      listAgentNames: () => [],
      fsStateProvider: () => new Map(),
    };
    const result = findAlternativeFsAgents("/home/example-user/anything/", deps);
    expect(result).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("FAFS-2 SINGLE-READY: agent with the queried path 'ready' included", () => {
    const finTaxState = new Map<string, FsCapabilitySnapshot>([
      [
        "/home/example-user/.openclaw/workspace-acme/",
        makeSnapshot("ready", "ro"),
      ],
    ]);
    const deps: FindAlternativeFsAgentsDeps = {
      listAgentNames: () => ["fin-tax"],
      fsStateProvider: (agent) =>
        agent === "fin-tax" ? finTaxState : new Map(),
    };
    const result = findAlternativeFsAgents(
      "/home/example-user/.openclaw/workspace-acme/",
      deps,
    );
    expect(result).toEqual(["fin-tax"]);
  });

  it("FAFS-3 DEGRADED-EXCLUDED: agent with path status='degraded' → excluded", () => {
    const stateAll = new Map<string, FsCapabilitySnapshot>([
      ["/path", makeSnapshot("degraded", "denied")],
    ]);
    const deps: FindAlternativeFsAgentsDeps = {
      listAgentNames: () => ["a", "b"],
      fsStateProvider: () => stateAll,
    };
    const result = findAlternativeFsAgents("/path", deps);
    expect(result).toEqual([]);
  });

  it("FAFS-4 MULTIPLE-SORTED: zeta + alpha + middle all ready → ASCII-ascending sort", () => {
    const readyState = new Map<string, FsCapabilitySnapshot>([
      ["/path", makeSnapshot("ready", "ro")],
    ]);
    const deps: FindAlternativeFsAgentsDeps = {
      // Provider returns names in non-sorted insertion order to ensure the
      // helper enforces ASCII-ascending sort itself.
      listAgentNames: () => ["zeta", "alpha", "middle"],
      fsStateProvider: () => readyState,
    };
    const result = findAlternativeFsAgents("/path", deps);
    expect(result).toEqual(["alpha", "middle", "zeta"]);
  });

  it("FAFS-5 SELF-EXCLUDED: currentAgentName='fin-client' → not in result even when ready", () => {
    const readyState = new Map<string, FsCapabilitySnapshot>([
      ["/path", makeSnapshot("ready", "ro")],
    ]);
    const deps: FindAlternativeFsAgentsDeps = {
      listAgentNames: () => ["fin-client", "admin-clawdy", "fin-tax"],
      fsStateProvider: () => readyState,
      currentAgentName: "fin-client",
    };
    const result = findAlternativeFsAgents("/path", deps);
    expect(result).not.toContain("fin-client");
    expect(result).toEqual(["admin-clawdy", "fin-tax"]);
  });

  it("FAFS-6 IMMUTABLE: result is Object.frozen (CLAUDE.md immutability rule)", () => {
    const readyState = new Map<string, FsCapabilitySnapshot>([
      ["/path", makeSnapshot("ready", "ro")],
    ]);
    const deps: FindAlternativeFsAgentsDeps = {
      listAgentNames: () => ["a"],
      fsStateProvider: () => readyState,
    };
    const result = findAlternativeFsAgents("/path", deps);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("FAFS-7 MISSING-PATH: agent's snapshot has other paths but not the queried one → excluded", () => {
    const otherPathState = new Map<string, FsCapabilitySnapshot>([
      ["/different/path", makeSnapshot("ready", "ro")],
    ]);
    const deps: FindAlternativeFsAgentsDeps = {
      listAgentNames: () => ["fin-tax"],
      fsStateProvider: () => otherPathState,
    };
    const result = findAlternativeFsAgents("/home/X", deps);
    expect(result).toEqual([]);
  });
});
