import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { McpHealthResult } from "../health.js";

/**
 * Phase 85 Plan 01 — TOOL-01/TOOL-04 unit tests for
 * `performMcpReadinessHandshake` + `mcpServerSchema.optional` flag.
 *
 * The module under test (`../readiness.js`) is pure: it runs JSON-RPC
 * `initialize` via `checkMcpServerHealth` against every configured MCP
 * server in parallel, partitions failures into mandatory vs optional,
 * and classifies each server's state.
 *
 * We mock `../health.js:checkMcpServerHealth` so the tests stay hermetic
 * (no child_process spawn, no timing noise).
 */

// Mock checkMcpServerHealth — the readiness module's only I/O dep.
vi.mock("../health.js", () => ({
  checkMcpServerHealth: vi.fn(),
}));

import { checkMcpServerHealth } from "../health.js";
import {
  performMcpReadinessHandshake,
  MCP_HANDSHAKE_TIMEOUT_MS,
  type McpReadinessReport,
} from "../readiness.js";

const mockedHealth = vi.mocked(checkMcpServerHealth);

function ok(name: string): McpHealthResult {
  return { name, healthy: true, latencyMs: 10 };
}
function fail(name: string, error: string): McpHealthResult {
  return { name, healthy: false, latencyMs: 10, error };
}

describe("performMcpReadinessHandshake", () => {
  beforeEach(() => {
    mockedHealth.mockReset();
  });
  afterEach(() => {
    mockedHealth.mockReset();
  });

  it("Test 1 — all three mandatory servers healthy → ready:true", async () => {
    mockedHealth
      .mockResolvedValueOnce(ok("a"))
      .mockResolvedValueOnce(ok("b"))
      .mockResolvedValueOnce(ok("c"));

    const rep: McpReadinessReport = await performMcpReadinessHandshake([
      { name: "a", command: "x", args: [], env: {}, optional: false },
      { name: "b", command: "x", args: [], env: {}, optional: false },
      { name: "c", command: "x", args: [], env: {}, optional: false },
    ]);

    expect(rep.ready).toBe(true);
    expect(rep.errors).toEqual([]);
    expect(rep.optionalErrors).toEqual([]);
    expect(rep.stateByName.size).toBe(3);
    for (const name of ["a", "b", "c"] as const) {
      const s = rep.stateByName.get(name);
      expect(s).toBeDefined();
      expect(s!.status).toBe("ready");
      expect(s!.lastError).toBeNull();
      expect(s!.failureCount).toBe(0);
      expect(s!.optional).toBe(false);
      expect(s!.lastSuccessAt).toBeTypeOf("number");
    }
  });

  it("Test 2 — one mandatory fails → ready:false, verbatim error, no rewording", async () => {
    mockedHealth
      .mockResolvedValueOnce(ok("a"))
      .mockResolvedValueOnce(fail("b", "Failed to start: ENOENT"))
      .mockResolvedValueOnce(ok("c"));

    const rep = await performMcpReadinessHandshake([
      { name: "a", command: "x", args: [], env: {}, optional: false },
      { name: "b", command: "x", args: [], env: {}, optional: false },
      { name: "c", command: "x", args: [], env: {}, optional: false },
    ]);

    expect(rep.ready).toBe(false);
    // Verbatim — TOOL-04 pass-through invariant.
    expect(rep.errors).toEqual(["mcp: b: Failed to start: ENOENT"]);
    expect(rep.optionalErrors).toEqual([]);

    const sb = rep.stateByName.get("b")!;
    expect(sb.status).toBe("failed");
    expect(sb.lastError).not.toBeNull();
    expect(sb.lastError!.message).toBe("Failed to start: ENOENT");
    expect(sb.lastSuccessAt).toBeNull();
    expect(sb.lastFailureAt).toBeTypeOf("number");
    expect(sb.failureCount).toBe(1);
  });

  it("Test 3 — only optional fails → ready:true, optionalErrors populated", async () => {
    mockedHealth
      .mockResolvedValueOnce(ok("mand-a"))
      .mockResolvedValueOnce(fail("opt-server", "auth refused"));

    const rep = await performMcpReadinessHandshake([
      { name: "mand-a", command: "x", args: [], env: {}, optional: false },
      { name: "opt-server", command: "x", args: [], env: {}, optional: true },
    ]);

    expect(rep.ready).toBe(true);
    expect(rep.errors).toEqual([]);
    expect(rep.optionalErrors).toEqual(["mcp: opt-server: auth refused"]);

    const opt = rep.stateByName.get("opt-server")!;
    expect(opt.status).toBe("failed");
    expect(opt.optional).toBe(true);
    expect(opt.lastError!.message).toBe("auth refused");

    const mand = rep.stateByName.get("mand-a")!;
    expect(mand.status).toBe("ready");
  });

  it("Test 4 — timeout: all servers hang (healthy:false with 'timed out ...') → ready:false, per-server error", async () => {
    // checkMcpServerHealth handles its own timeout; we simulate the result.
    mockedHealth
      .mockResolvedValueOnce(fail("s1", "Health check timed out after 5000ms"))
      .mockResolvedValueOnce(fail("s2", "Health check timed out after 5000ms"));

    const rep = await performMcpReadinessHandshake([
      { name: "s1", command: "x", args: [], env: {}, optional: false },
      { name: "s2", command: "x", args: [], env: {}, optional: false },
    ]);

    expect(rep.ready).toBe(false);
    // One per server — parallel spawn, each with its own scoped error.
    expect(rep.errors).toHaveLength(2);
    expect(rep.errors[0]).toContain("mcp: s1:");
    expect(rep.errors[1]).toContain("mcp: s2:");
    expect(rep.errors[0]).toContain("timed out after 5000ms");
  });

  it("Test 5a — empty servers list returns ready:true with empty map", async () => {
    const rep = await performMcpReadinessHandshake([]);
    expect(rep.ready).toBe(true);
    expect(rep.errors).toEqual([]);
    expect(rep.optionalErrors).toEqual([]);
    expect(rep.stateByName.size).toBe(0);
    expect(mockedHealth).not.toHaveBeenCalled();
  });

  it("Test 5b — frozen report; timeoutMs + now() injection honored", async () => {
    mockedHealth.mockResolvedValueOnce(ok("a"));

    const now = vi.fn(() => 1_700_000_000_000);
    const rep = await performMcpReadinessHandshake(
      [{ name: "a", command: "x", args: [], env: {}, optional: false }],
      { timeoutMs: 1234, now },
    );

    expect(Object.isFrozen(rep)).toBe(true);
    expect(Object.isFrozen(rep.errors)).toBe(true);
    expect(Object.isFrozen(rep.optionalErrors)).toBe(true);

    // timeoutMs forwarded to checkMcpServerHealth.
    expect(mockedHealth).toHaveBeenCalledWith(
      expect.objectContaining({ name: "a" }),
      1234,
    );

    // `now()` stamp used for lastSuccessAt.
    const s = rep.stateByName.get("a")!;
    expect(s.lastSuccessAt).toBe(1_700_000_000_000);
  });

  it("Test 6 — exports MCP_HANDSHAKE_TIMEOUT_MS === 5000", () => {
    expect(MCP_HANDSHAKE_TIMEOUT_MS).toBe(5000);
  });

  it("Test 7 — mixed: one mandatory fail + one optional fail + one ready", async () => {
    mockedHealth
      .mockResolvedValueOnce(ok("good"))
      .mockResolvedValueOnce(fail("mand-bad", "connection refused"))
      .mockResolvedValueOnce(fail("opt-bad", "token expired"));

    const rep = await performMcpReadinessHandshake([
      { name: "good", command: "x", args: [], env: {}, optional: false },
      { name: "mand-bad", command: "x", args: [], env: {}, optional: false },
      { name: "opt-bad", command: "x", args: [], env: {}, optional: true },
    ]);

    expect(rep.ready).toBe(false); // mandatory failure blocks
    expect(rep.errors).toEqual(["mcp: mand-bad: connection refused"]);
    expect(rep.optionalErrors).toEqual(["mcp: opt-bad: token expired"]);
    expect(rep.stateByName.get("good")!.status).toBe("ready");
    expect(rep.stateByName.get("mand-bad")!.status).toBe("failed");
    expect(rep.stateByName.get("opt-bad")!.status).toBe("failed");
  });
});

describe("mcpServerSchema — `optional` flag back-compat", () => {
  it("Test 5 (schema) — config without `optional` parses with optional===false", async () => {
    const { mcpServerSchema } = await import("../../config/schema.js");
    const result = mcpServerSchema.safeParse({
      name: "x",
      command: "x",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.optional).toBe(false);
    }
  });

  it("accepts explicit optional:true", async () => {
    const { mcpServerSchema } = await import("../../config/schema.js");
    const result = mcpServerSchema.safeParse({
      name: "x",
      command: "x",
      optional: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.optional).toBe(true);
    }
  });
});
