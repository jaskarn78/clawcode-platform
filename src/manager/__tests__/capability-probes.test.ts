import { describe, it, expect, vi } from "vitest";
import type { Logger } from "pino";

/**
 * Phase 94 Plan 01 Task 1 — capability-probes registry tests (RED).
 *
 * Tests pin:
 *   - PR-1 registry has ≥ 13 entries covering 9 declared + 4 auto-injected MCPs
 *   - PR-2 1password probe shape — vaults_list (D-01)
 *   - PR-3 finnhub probe shape — quote(symbol="AAPL") (D-01)
 *   - PR-4 brave-search probe shape — search(query="test", limit=1) (D-01)
 *   - PR-5 default-fallback for unknown server uses listTools (TOOL-02)
 *   - PR-6 default-fallback empty list → degraded with "no tools" error
 *
 * RED: src/manager/capability-probes.ts does not exist yet.
 */

import {
  PROBE_REGISTRY,
  getProbeFor,
  defaultListToolsProbe,
  type ProbeDeps,
  type ProbeFn,
} from "../capability-probes.js";

const noopLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => noopLog,
} as unknown as Logger;

function makeProbeDeps(overrides: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    callTool: overrides.callTool ?? vi.fn().mockResolvedValue({}),
    listTools: overrides.listTools ?? vi.fn().mockResolvedValue([{ name: "x" }]),
    log: overrides.log ?? noopLog,
    ...(overrides.now !== undefined ? { now: overrides.now } : {}),
  };
}

describe("PROBE_REGISTRY — fleet coverage", () => {
  it("PR-1 registry has 13 entries covering 9 declared + 4 auto-injected MCPs", () => {
    expect(PROBE_REGISTRY.size).toBeGreaterThanOrEqual(13);
    const declared = [
      "browser",
      "playwright",
      "1password",
      "acme-db",
      "acme-content",
      "finnhub",
      "brave-search",
      "google-workspace",
      "fal-ai",
      "browserless",
    ];
    const autoInjected = ["clawcode", "search", "image"];
    // Note: "browser" appears in both declared and auto-injected lists per
    // D-01; the registry just has one entry by that name.
    const expected = new Set([...declared, ...autoInjected]);
    for (const name of expected) {
      expect(PROBE_REGISTRY.has(name)).toBe(true);
    }
  });
});

describe("registered probes — D-01 representative call shapes", () => {
  it("PR-2 1password probe invokes vaults_list({})", async () => {
    const callTool = vi.fn().mockResolvedValue({});
    const deps = makeProbeDeps({ callTool });
    const probe = getProbeFor("1password");
    const r = await probe(deps);
    expect(r.kind).toBe("ok");
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool.mock.calls[0]![0]).toBe("1password");
    expect(callTool.mock.calls[0]![1]).toBe("vaults_list");
    expect(callTool.mock.calls[0]![2]).toEqual({});
  });

  it("PR-3 finnhub probe invokes quote(symbol=AAPL)", async () => {
    const callTool = vi.fn().mockResolvedValue({});
    const deps = makeProbeDeps({ callTool });
    const probe = getProbeFor("finnhub");
    const r = await probe(deps);
    expect(r.kind).toBe("ok");
    expect(callTool).toHaveBeenCalledTimes(1);
    const [serverName, toolName, args] = callTool.mock.calls[0]!;
    expect(serverName).toBe("finnhub");
    expect(toolName).toBe("quote");
    expect((args as { symbol: string }).symbol).toBe("AAPL");
  });

  it("PR-4 brave-search probe invokes search(query=test, limit=1)", async () => {
    const callTool = vi.fn().mockResolvedValue({});
    const deps = makeProbeDeps({ callTool });
    const probe = getProbeFor("brave-search");
    const r = await probe(deps);
    expect(r.kind).toBe("ok");
    expect(callTool).toHaveBeenCalledTimes(1);
    const [serverName, toolName, args] = callTool.mock.calls[0]!;
    expect(serverName).toBe("brave-search");
    expect(toolName).toBe("search");
    expect((args as { query: string }).query).toBe("test");
    expect((args as { limit: number }).limit).toBe(1);
  });
});

describe("defaultListToolsProbe — fallback for unmapped servers", () => {
  it("PR-5 unknown server: getProbeFor returns a probe that calls listTools()", async () => {
    const listTools = vi.fn().mockResolvedValue([{ name: "first-tool" }, { name: "second" }]);
    const deps = makeProbeDeps({ listTools });
    const probe = getProbeFor("never-heard-of-it");
    expect(typeof probe).toBe("function");
    const r = await probe(deps);
    expect(r.kind).toBe("ok");
    expect(listTools).toHaveBeenCalled();
  });

  it("PR-6 empty tool list → ProbeResult.failure with 'no tools' in error", async () => {
    const listTools = vi.fn().mockResolvedValue([]);
    const deps = makeProbeDeps({ listTools });
    const probe = getProbeFor("never-heard-of-it");
    const r = await probe(deps);
    expect(r.kind).toBe("failure");
    if (r.kind === "failure") {
      expect(r.error.toLowerCase()).toContain("no tools");
    }
  });

  it("PR-6b defaultListToolsProbe is exported", () => {
    expect(typeof defaultListToolsProbe).toBe("function");
  });
});

describe("registry shape", () => {
  it("ProbeFn type alignment: every entry is callable with ProbeDeps", () => {
    for (const [name, fn] of PROBE_REGISTRY) {
      expect(typeof fn).toBe("function");
      // Type-level check via the cast below — runtime only verifies callability.
      const asProbeFn: ProbeFn = fn;
      void asProbeFn;
      expect(name.length).toBeGreaterThan(0);
    }
  });
});
