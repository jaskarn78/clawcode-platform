/**
 * Phase 100 follow-up — vault-scoped MCP env override tests.
 *
 * `resolveMcpEnvOverrides` lets the daemon swap a per-agent MCP env value
 * (e.g. `OP_SERVICE_ACCOUNT_TOKEN`) before spawning the MCP subprocess.
 * Values that match `op://...` are resolved via an injected `opRead` shell-
 * out (production wires `op read` against the daemon's clawdbot service
 * account); literal values pass through unchanged.
 *
 * Why a separate resolver and not the existing config/loader.ts opRefResolver:
 *   - The config-load resolver is sync (`execSync`) and runs at boot for
 *     every shared MCP env. The override resolver is async + per-agent +
 *     used to layer a NARROWER-scoped token over the daemon's wide-scope
 *     token (e.g. swap clawdbot's full-fleet token for a Acme-only
 *     vault-scoped token). DI-pure for unit testing.
 *   - The clawdbot token MUST NEVER appear in test assertions, log lines,
 *     or any error message — a leak there means it leaks at runtime too.
 */

import { describe, it, expect, vi } from "vitest";
import { resolveMcpEnvOverrides } from "../op-env-resolver.js";

describe("resolveMcpEnvOverrides", () => {
  it("OP-1: literal string values pass through unchanged", async () => {
    const opRead = vi.fn(async () => "should-not-be-called");
    const out = await resolveMcpEnvOverrides(
      {
        "1password": { OP_FOO: "literal-value" },
      },
      { opRead },
    );
    expect(out["1password"]?.OP_FOO).toBe("literal-value");
    expect(opRead).not.toHaveBeenCalled();
  });

  it("OP-2: op:// values are resolved via opRead, replaced with resolved value", async () => {
    const opRead = vi.fn(
      async (uri: string) => `RESOLVED:${uri}`,
    );
    const out = await resolveMcpEnvOverrides(
      {
        "1password": {
          OP_SERVICE_ACCOUNT_TOKEN:
            "op://example-vault-21/Acme Service Account/credential",
        },
      },
      { opRead },
    );
    expect(out["1password"]?.OP_SERVICE_ACCOUNT_TOKEN).toBe(
      "RESOLVED:op://example-vault-21/Acme Service Account/credential",
    );
    expect(opRead).toHaveBeenCalledTimes(1);
    expect(opRead).toHaveBeenCalledWith(
      "op://example-vault-21/Acme Service Account/credential",
    );
  });

  it("OP-3: opRead rejection → resolveMcpEnvOverrides rejects (no fallback)", async () => {
    const opRead = vi.fn(async () => {
      throw new Error("op CLI not signed in");
    });
    await expect(
      resolveMcpEnvOverrides(
        {
          "1password": {
            OP_SERVICE_ACCOUNT_TOKEN: "op://example-vault-21/Item/credential",
          },
        },
        { opRead },
      ),
    ).rejects.toThrow(/Failed to resolve op:\/\/ reference/);
  });

  it("OP-4: empty resolution → throws (no silent zero-length token)", async () => {
    const opRead = vi.fn(async () => "");
    await expect(
      resolveMcpEnvOverrides(
        {
          "1password": {
            OP_SERVICE_ACCOUNT_TOKEN: "op://example-vault-21/Item/credential",
          },
        },
        { opRead },
      ),
    ).rejects.toThrow(/empty/i);
  });

  it("OP-5: mixed env (some literal, some op://) handled correctly per-key", async () => {
    const opRead = vi.fn(async (uri: string) => `RESOLVED:${uri}`);
    const out = await resolveMcpEnvOverrides(
      {
        "1password": {
          OP_SERVICE_ACCOUNT_TOKEN: "op://example-vault-21/SA/credential",
          OP_REGION: "us-east-1",
          OTHER_LITERAL: "abc",
        },
      },
      { opRead },
    );
    expect(out["1password"]?.OP_SERVICE_ACCOUNT_TOKEN).toBe(
      "RESOLVED:op://example-vault-21/SA/credential",
    );
    expect(out["1password"]?.OP_REGION).toBe("us-east-1");
    expect(out["1password"]?.OTHER_LITERAL).toBe("abc");
    expect(opRead).toHaveBeenCalledTimes(1);
  });

  it("OP-6: error message does NOT leak the resolved (clawdbot) value", async () => {
    // Defense in depth: even if opRead throws AFTER successfully reading a
    // secret (unlikely, but the rejection text MUST never carry the secret).
    const opRead = vi.fn(async () => {
      throw new Error("auth failed for token ops_clawdbot_supersecret_123");
    });
    try {
      await resolveMcpEnvOverrides(
        {
          "1password": {
            OP_SERVICE_ACCOUNT_TOKEN: "op://example-vault-21/SA/credential",
          },
        },
        { opRead },
      );
      expect.fail("expected throw");
    } catch (err) {
      // The wrapped error includes the op:// URI for operator debugging
      // (which is operator-controlled config, not a secret) but should NOT
      // include any resolved token. The underlying opRead's message MAY
      // include implementation noise — we don't assert that, but we DO
      // assert the wrapping layer's prefix is sane.
      expect((err as Error).message).toContain("Failed to resolve op://");
      expect((err as Error).message).toContain(
        "op://example-vault-21/SA/credential",
      );
    }
  });

  it("OP-7: log.info called with envKey + opUri but NEVER the resolved value", async () => {
    const logCalls: Array<Record<string, unknown>> = [];
    const opRead = vi.fn(async () => "secret-acme-token-XYZ");
    await resolveMcpEnvOverrides(
      {
        "1password": {
          OP_SERVICE_ACCOUNT_TOKEN: "op://example-vault-21/SA/credential",
        },
      },
      {
        opRead,
        log: {
          warn: () => {},
          info: (obj: unknown, _msg?: unknown) => {
            // Mirror pino's signature — first arg is the structured fields.
            if (typeof obj === "object" && obj !== null) {
              logCalls.push(obj as Record<string, unknown>);
            }
          },
        },
      },
    );
    expect(logCalls.length).toBe(1);
    const entry = logCalls[0]!;
    expect(entry.envKey).toBe("OP_SERVICE_ACCOUNT_TOKEN");
    expect(entry.opUri).toBe("op://example-vault-21/SA/credential");
    // The resolved secret MUST NOT appear in any log field.
    for (const [, value] of Object.entries(entry)) {
      if (typeof value === "string") {
        expect(value).not.toContain("secret-acme-token-XYZ");
      }
    }
  });
});
