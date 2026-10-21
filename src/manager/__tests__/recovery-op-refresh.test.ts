import { describe, it, expect, vi } from "vitest";
import type { Logger } from "pino";

/**
 * Phase 94 Plan 03 Task 1 — op-refresh handler tests (RED).
 *
 * Pin matches/recover behavior for D-05 pattern 2:
 *   op:// auth error → re-resolve via `op read` → swap env on the MCP
 *   subprocess (or signals SIGHUP if subprocess supports it) → "recovered".
 */

import type { RecoveryDeps } from "../recovery/types.js";
import { opRefreshHandler } from "../recovery/op-refresh.js";

const noopLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => noopLog,
} as unknown as Logger;

function makeDeps(overrides: Partial<RecoveryDeps> = {}): RecoveryDeps {
  return {
    execFile: overrides.execFile ?? vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
    killSubprocess: overrides.killSubprocess ?? vi.fn().mockResolvedValue(undefined),
    adminAlert: overrides.adminAlert ?? vi.fn().mockResolvedValue(undefined),
    opRead: overrides.opRead ?? vi.fn().mockResolvedValue("fresh-secret-value"),
    readEnvForServer: overrides.readEnvForServer ?? vi.fn().mockReturnValue({}),
    writeEnvForServer: overrides.writeEnvForServer ?? vi.fn().mockResolvedValue(undefined),
    now: overrides.now ?? (() => new Date("2026-04-25T12:00:00.000Z")),
    log: overrides.log ?? noopLog,
    // Phase 999.10 plan 03 — propagate the optional invalidate override.
    // Omitted-by-default preserves the back-compat shape (deps.invalidate
    // === undefined) that REC-OP-REFRESH-INV-02 pins.
    ...(overrides.invalidate !== undefined ? { invalidate: overrides.invalidate } : {}),
  };
}

describe("opRefreshHandler", () => {
  it("REC-OP-MATCH: matches op:// auth-error variants", () => {
    expect(
      opRefreshHandler.matches("op://example-vault-27/secret/value not authorized", {} as never),
    ).toBe(true);
    expect(
      opRefreshHandler.matches("op://example-vault-32 service account expired", {} as never),
    ).toBe(true);
    expect(
      opRefreshHandler.matches("op://example-vault/secret token expired", {} as never),
    ).toBe(true);
  });

  it("REC-OP-NO-MATCH: does NOT match unrelated errors", () => {
    expect(opRefreshHandler.matches("socket hang up", {} as never)).toBe(false);
    expect(opRefreshHandler.matches("Executable doesn't exist at /ms-playwright", {} as never)).toBe(false);
    expect(opRefreshHandler.matches("500 internal server error", {} as never)).toBe(false);
  });

  it("REC-OP-REFRESH-INV-01: invalidates cache for each op:// ref BEFORE re-reading (SEC-05)", async () => {
    // Phase 999.10 plan 03 — when an MCP child raises an op:// auth error,
    // the recovery handler must drop any cached value for that URI from the
    // SecretsResolver BEFORE shelling out to op read again, otherwise
    // opRead's underlying resolver could serve back the same stale value
    // that just triggered the auth-error. This test pins the ordering.
    const callOrder: string[] = [];
    const opRead = vi.fn(async (ref: string) => {
      callOrder.push(`opRead:${ref}`);
      return `fresh-${ref}`;
    });
    const invalidate = vi.fn((ref: string) => {
      callOrder.push(`invalidate:${ref}`);
    });
    const readEnvForServer = vi.fn().mockReturnValue({
      TOKEN_A: "op://example-vault-14/ItemA/field",
      TOKEN_B: "op://example-vault-15/ItemB/field",
      LITERAL: "static-value",
    });
    const writeEnvForServer = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ opRead, invalidate, readEnvForServer, writeEnvForServer });

    const outcome = await opRefreshHandler.recover("test-server", deps);
    expect(outcome.kind).toBe("recovered");

    // Both URIs invalidated.
    expect(invalidate).toHaveBeenCalledWith("op://example-vault-14/ItemA/field");
    expect(invalidate).toHaveBeenCalledWith("op://example-vault-15/ItemB/field");

    // Per-ref ordering: invalidate(ref) precedes opRead(ref) for the same ref.
    for (const ref of ["op://example-vault-14/ItemA/field", "op://example-vault-15/ItemB/field"]) {
      const invIdx = callOrder.indexOf(`invalidate:${ref}`);
      const readIdx = callOrder.indexOf(`opRead:${ref}`);
      expect(invIdx).toBeGreaterThanOrEqual(0);
      expect(readIdx).toBeGreaterThanOrEqual(0);
      expect(invIdx).toBeLessThan(readIdx);
    }

    // Literal env values do NOT trigger invalidate.
    expect(invalidate).not.toHaveBeenCalledWith("static-value");
  });

  it("REC-OP-REFRESH-INV-02: handler still works when deps.invalidate is undefined (back-compat)", async () => {
    // Existing pre-999.10 tests (and the long-tail of test-deps that don't
    // know about the new optional field) must still produce a `recovered`
    // outcome. The optional `?.` chain in op-refresh.ts is the safety net.
    const opRead = vi.fn().mockResolvedValue("fresh-value");
    const readEnvForServer = vi.fn().mockReturnValue({
      TOKEN: "op://example-vault-13/Item/field",
    });
    const writeEnvForServer = vi.fn().mockResolvedValue(undefined);
    // makeDeps sets invalidate omitted-by-default (it's not in the
    // overrides spread) — confirm the handler still recovers.
    const deps = makeDeps({ opRead, readEnvForServer, writeEnvForServer });
    expect(deps.invalidate).toBeUndefined();

    const outcome = await opRefreshHandler.recover("legacy-server", deps);
    expect(outcome.kind).toBe("recovered");
    expect(opRead).toHaveBeenCalledWith("op://example-vault-13/Item/field");
  });

  it("REC-OP-RECOVER-OK: opRead resolves + writeEnvForServer succeeds → outcome.kind='recovered'", async () => {
    const opRead = vi.fn().mockImplementation(async (ref: string) => {
      if (ref === "op://example-vault-27/api/key") return "fresh-api-key-12345";
      if (ref === "op://example-vault-27/db/password") return "fresh-db-pw";
      return "fresh-default";
    });
    const readEnvForServer = vi.fn().mockReturnValue({
      API_KEY: "op://example-vault-27/api/key",
      DB_PASSWORD: "op://example-vault-27/db/password",
      OTHER: "literal-value",
    });
    const writeEnvForServer = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ opRead, readEnvForServer, writeEnvForServer });

    const outcome = await opRefreshHandler.recover("1password-mcp", deps);
    expect(outcome.kind).toBe("recovered");
    if (outcome.kind === "recovered") {
      expect(outcome.serverName).toBe("1password-mcp");
      expect(outcome.handlerName).toBe("op-refresh");
    }
    // op:// references should each be resolved
    expect(opRead).toHaveBeenCalledWith("op://example-vault-27/api/key");
    expect(opRead).toHaveBeenCalledWith("op://example-vault-27/db/password");
    // writeEnvForServer should receive the resolved env
    const writeCall = writeEnvForServer.mock.calls[0];
    expect(writeCall?.[0]).toBe("1password-mcp");
    expect(writeCall?.[1].API_KEY).toBe("fresh-api-key-12345");
    expect(writeCall?.[1].DB_PASSWORD).toBe("fresh-db-pw");
    // Literal values pass through unchanged
    expect(writeCall?.[1].OTHER).toBe("literal-value");
  });
});
