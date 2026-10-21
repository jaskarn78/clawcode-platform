import { describe, it, expect, vi } from "vitest";
import type { Logger } from "pino";

/**
 * Phase 94 Plan 03 Task 1 — playwright-chromium handler tests (RED).
 *
 * Pin matches/recover behavior for D-05 pattern 1:
 *   error matches /Executable doesn't exist at .*ms-playwright/ →
 *   run `npx playwright install chromium --with-deps` via deps.execFile
 *   (timeout 120s) → on success "recovered"; non-zero exit "give-up";
 *   throw "retry-later".
 */

import type { RecoveryDeps } from "../recovery/types.js";
import { playwrightChromiumHandler } from "../recovery/playwright-chromium.js";

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
    opRead: overrides.opRead ?? vi.fn().mockResolvedValue("fresh-secret"),
    readEnvForServer: overrides.readEnvForServer ?? vi.fn().mockReturnValue({}),
    writeEnvForServer: overrides.writeEnvForServer ?? vi.fn().mockResolvedValue(undefined),
    now: overrides.now ?? (() => new Date("2026-04-25T12:00:00.000Z")),
    log: overrides.log ?? noopLog,
  };
}

describe("playwrightChromiumHandler", () => {
  it("REC-PW-MATCH: matches the canonical Playwright Chromium-missing error", () => {
    const err =
      "Executable doesn't exist at /home/clawcode/.cache/ms-playwright/chromium-1187/chrome-linux/chrome\nLooks like Playwright was just installed";
    expect(playwrightChromiumHandler.matches(err, {} as never)).toBe(true);
  });

  it("REC-PW-NO-MATCH: does NOT match unrelated errors", () => {
    expect(playwrightChromiumHandler.matches("429 rate limit", {} as never)).toBe(false);
    expect(playwrightChromiumHandler.matches("socket hang up", {} as never)).toBe(false);
    expect(playwrightChromiumHandler.matches("op:// not authorized", {} as never)).toBe(false);
  });

  it("REC-PW-RECOVER-OK: deps.execFile returns exitCode=0 → outcome.kind='recovered'", async () => {
    const execFile = vi.fn().mockResolvedValue({
      stdout: "Chromium 1187 downloaded to /home/clawcode/.cache/ms-playwright",
      stderr: "",
      exitCode: 0,
    });
    const deps = makeDeps({ execFile });
    const outcome = await playwrightChromiumHandler.recover("playwright", deps);
    expect(outcome.kind).toBe("recovered");
    if (outcome.kind === "recovered") {
      expect(outcome.serverName).toBe("playwright");
      expect(outcome.handlerName).toBe("playwright-chromium");
      expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
    }
    // Verify the actual command shape used
    expect(execFile).toHaveBeenCalledTimes(1);
    const callArgs = execFile.mock.calls[0]!;
    expect(callArgs[0]).toBe("npx");
    expect(callArgs[1]).toEqual(["playwright", "install", "chromium", "--with-deps"]);
    // 120s timeout pinned
    expect(callArgs[2]?.timeoutMs).toBe(120_000);
  });

  it("REC-PW-RECOVER-FAIL: deps.execFile throws → outcome.kind='retry-later' + retryAfterMs > 0", async () => {
    const execFile = vi.fn().mockRejectedValue(new Error("ENOENT: spawn npx"));
    const deps = makeDeps({ execFile });
    const outcome = await playwrightChromiumHandler.recover("playwright", deps);
    expect(outcome.kind).toBe("retry-later");
    if (outcome.kind === "retry-later") {
      expect(outcome.retryAfterMs).toBeGreaterThan(0);
      expect(outcome.reason).toContain("ENOENT");
      expect(outcome.handlerName).toBe("playwright-chromium");
    }
  });

  it("REC-PW-RECOVER-NONZERO: deps.execFile exitCode=1 → outcome.kind='give-up' + reason contains stderr", async () => {
    const execFile = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "permission denied: cannot write to /home/clawcode/.cache/ms-playwright",
      exitCode: 1,
    });
    const deps = makeDeps({ execFile });
    const outcome = await playwrightChromiumHandler.recover("playwright", deps);
    expect(outcome.kind).toBe("give-up");
    if (outcome.kind === "give-up") {
      expect(outcome.reason).toContain("permission denied");
      expect(outcome.handlerName).toBe("playwright-chromium");
    }
  });
});
