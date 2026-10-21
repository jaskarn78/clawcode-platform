/**
 * Phase 999.27 — broker-shim detection tests.
 *
 * Pins the predicate used to skip 1password broker-pooled servers from
 * per-agent capability probes / warm-path checks / heartbeat reconnect.
 * A regression that lets the broker shim through these probes recreates
 * the 2026-05-01 incident: probe spawns shim with un-overridden default
 * env (clawdbot token instead of agent's per-agent token), broker sees
 * tokenHash drift, rebind cycles every 60s, pool churn.
 */

import { describe, it, expect } from "vitest";
import {
  isBrokerPooledMcpServer,
  filterOutBrokerPooled,
} from "../broker-shim-detect.js";

describe("isBrokerPooledMcpServer (Phase 999.27)", () => {
  it("matches the production broker-shim signature", () => {
    expect(
      isBrokerPooledMcpServer({
        command: "clawcode",
        args: ["mcp-broker-shim", "--pool", "1password"],
      }),
    ).toBe(true);
  });

  it("does NOT match other clawcode-CLI MCPs (clawcode mcp / browser-mcp / search-mcp)", () => {
    // These are auto-injected by the loader and use the clawcode CLI but
    // are NOT broker-pooled. They MUST stay in the probe set.
    const cases = [
      { command: "clawcode", args: ["mcp"] },
      { command: "clawcode", args: ["browser-mcp"] },
      { command: "clawcode", args: ["search-mcp"] },
      { command: "clawcode", args: ["image-mcp"] },
    ];
    for (const c of cases) {
      expect(isBrokerPooledMcpServer(c)).toBe(false);
    }
  });

  it("does NOT match third-party MCPs (npx / python / direct node)", () => {
    const cases = [
      { command: "npx", args: ["-y", "@takescake/1password-mcp@latest"] },
      { command: "node", args: ["/opt/foo/server.js"] },
      { command: "python3", args: ["/opt/bar/server.py"] },
    ];
    for (const c of cases) {
      expect(isBrokerPooledMcpServer(c)).toBe(false);
    }
  });

  it("matches even when args carry extra trailing options", () => {
    // Future-proofing — the loader rewrites args to include the shim
    // marker but may add more options later.
    expect(
      isBrokerPooledMcpServer({
        command: "clawcode",
        args: ["mcp-broker-shim", "--pool", "1password", "--socket", "/x.sock"],
      }),
    ).toBe(true);
  });
});

describe("filterOutBrokerPooled (Phase 999.27)", () => {
  it("removes broker-pooled servers, preserves others, preserves order", () => {
    const servers = [
      { name: "a", command: "node", args: ["a.js"] },
      {
        name: "1password",
        command: "clawcode",
        args: ["mcp-broker-shim", "--pool", "1password"],
      },
      { name: "b", command: "python3", args: ["b.py"] },
      { name: "browser", command: "clawcode", args: ["browser-mcp"] },
    ];
    const filtered = filterOutBrokerPooled(servers);
    expect(filtered.map((s) => s.name)).toEqual(["a", "b", "browser"]);
  });

  it("is a no-op on empty arrays", () => {
    expect(filterOutBrokerPooled([])).toEqual([]);
  });

  it("returns empty when ALL servers are broker-pooled", () => {
    const servers = [
      {
        name: "1p",
        command: "clawcode",
        args: ["mcp-broker-shim", "--pool", "1password"],
      },
    ];
    expect(filterOutBrokerPooled(servers)).toEqual([]);
  });
});
