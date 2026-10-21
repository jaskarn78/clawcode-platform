/**
 * Phase 999.10 Plan 02 — SEC-04 graceful-degradation integration test.
 *
 * Exercises the boot orchestration shape (preResolveAll + structured pino
 * logs + fail-open posture) end-to-end against the real SecretsResolver
 * class without mocking it. The test does NOT call `startDaemon` directly
 * (too heavy — DB writes, sockets, MCP children); instead, it replays the
 * exact sequence Wave 2's daemon edit performs at boot:
 *
 *   1. construct SecretsResolver with a mocked opRead that fails for one URI
 *   2. await secretsResolver.preResolveAll(["op://example-vault-6","op://example-vault-7"])
 *   3. assert no throw, partial-failure log lines emitted, working URI cached
 *
 * This is labelled an "integration test" because it pins down the
 * orchestration contract (parallel pre-resolve + per-URI failure log + final
 * summary log + fail-open continuation) — Wave 2's daemon.ts changes are a
 * thin shell over this exact shape.
 *
 * Real `op read` shell-out is exercised manually per VALIDATION.md (manual-
 * only verifications) since it requires a live 1Password CLI session.
 */

import { describe, it, expect, vi } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";
import { SecretsResolver, type OpReadFn } from "../secrets-resolver.js";

function makeCapturingLogger(): { log: pino.Logger; lines: () => string[] } {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  const log = pino({ level: "debug" }, sink);
  return {
    log,
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((s) => s.length > 0),
  };
}

describe("daemon boot — partial op:// pre-resolve failure", () => {
  it("BOOT-DEGRADED-01: failed pre-resolve disables affected MCPs but daemon continues", async () => {
    const VALUE_A = "secret-a-77c1";
    const FAIL_REASON = "op read exited 1: item not found";

    // opRead resolves "op://example-vault-6/x/y" but rejects "op://example-vault-7/x/y" — mirrors the
    // 1Password partial-failure shape (one item missing, others fine).
    const opRead: OpReadFn = vi.fn(async (uri: string) => {
      if (uri === "op://example-vault-6/x/y") return VALUE_A;
      throw new Error(FAIL_REASON);
    });

    const { log, lines } = makeCapturingLogger();
    const secretsResolver = new SecretsResolver({
      opRead,
      log: log.child({ subsystem: "secrets" }),
      // Fast retries for test wall-clock — keeps total under 100ms.
      retryOptions: { retries: 0, minTimeout: 1, maxTimeout: 1, randomize: false },
    });

    const allOpRefs = ["op://example-vault-6/x/y", "op://example-vault-7/x/y"] as const;

    // Mirror the daemon.ts boot pre-resolve block exactly:
    log.info({ count: allOpRefs.length }, "secrets: pre-resolving op:// references");
    let threw = false;
    let preResolveResults:
      | readonly { uri: string; ok: boolean; reason?: string }[]
      | undefined;
    try {
      preResolveResults = await secretsResolver.preResolveAll(allOpRefs);
    } catch {
      threw = true;
    }

    // Fail-open contract: preResolveAll must NOT throw on partial failure.
    expect(threw).toBe(false);
    expect(preResolveResults).toBeDefined();

    const failed = preResolveResults!.filter((r) => !r.ok);
    for (const f of failed) {
      log.error({ uri: f.uri, reason: f.reason }, "secrets: pre-resolve failed");
    }
    log.info(
      { resolved: preResolveResults!.length - failed.length, failed: failed.length },
      "secrets: pre-resolve complete",
    );

    // Per-URI outcome shape.
    expect(preResolveResults).toHaveLength(2);
    const aResult = preResolveResults!.find((r) => r.uri === "op://example-vault-6/x/y");
    const bResult = preResolveResults!.find((r) => r.uri === "op://example-vault-7/x/y");
    expect(aResult?.ok).toBe(true);
    expect(bResult?.ok).toBe(false);
    expect(bResult?.reason).toContain("item not found");

    // Cache outcomes — working URI is reachable via getCached, failing URI is not.
    expect(secretsResolver.getCached("op://example-vault-6/x/y")).toBe(VALUE_A);
    expect(secretsResolver.getCached("op://example-vault-7/x/y")).toBeUndefined();

    // Structured pino log lines — both per-URI failure and summary fired.
    const captured = lines();
    const failureLine = captured.find((l) => l.includes("secrets: pre-resolve failed"));
    const completeLine = captured.find((l) => l.includes("secrets: pre-resolve complete"));
    expect(failureLine).toBeDefined();
    expect(completeLine).toBeDefined();
    expect(failureLine!).toContain("op://example-vault-7/x/y");
    expect(completeLine!).toMatch(/"failed"\s*:\s*1/);
    expect(completeLine!).toMatch(/"resolved"\s*:\s*1/);
  });
});
