/**
 * Phase 999.122 — the runner journals status transitions and logs a
 * warning ONCE per transition (rate-limited), not on every tick.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HeartbeatRunner } from "../runner.js";
import { HeartbeatTransitionJournal } from "../transition-journal.js";
import type { CheckModule, CheckResult, HeartbeatConfig } from "../types.js";

function mockSessionManager(agents: string[]) {
  return {
    getRunningAgents: vi.fn().mockReturnValue(agents),
    getContextFillProvider: vi.fn().mockReturnValue(undefined),
    getCompactionManager: vi.fn().mockReturnValue(undefined),
    getMemoryStore: vi.fn().mockReturnValue(undefined),
  } as any;
}

function mockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() } as any;
}

const config: HeartbeatConfig = {
  enabled: true,
  intervalSeconds: 1,
  checkTimeoutSeconds: 10,
  contextFill: { warningThreshold: 0.6, criticalThreshold: 0.75 },
};

/** A check whose result is whatever `next` currently holds. */
function scriptedCheck(name: string, next: { result: CheckResult }): CheckModule {
  return { name, execute: vi.fn().mockImplementation(async () => next.result) };
}

describe("HeartbeatRunner transition journaling", () => {
  let tempDir: string;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 5, 12, 0, 0));
    tempDir = mkdtempSync(join(tmpdir(), "hb-runner-tr-"));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("logs a warning once when a check degrades, stays quiet while it persists, logs recovery", async () => {
    const log = mockLogger();
    const journal = new HeartbeatTransitionJournal({ logCooldownMs: 600_000 });
    const runner = new HeartbeatRunner({
      sessionManager: mockSessionManager(["agent-a"]),
      registryPath: join(tempDir, "registry.json"),
      config,
      checksDir: join(tempDir, "checks"),
      log,
      transitionJournal: journal,
    });
    const next: { result: CheckResult } = { result: { status: "healthy", message: "ok" } };
    (runner as any).checks = [scriptedCheck("auto-linker", next)];

    await runner.tick(); // healthy first observation → nothing journaled
    expect(journal.all()).toHaveLength(0);

    next.result = { status: "warning", message: "FOREIGN KEY constraint failed" };
    vi.advanceTimersByTime(1_000);
    await runner.tick();
    vi.advanceTimersByTime(1_000);
    await runner.tick(); // still warning → no second entry, no second log
    vi.advanceTimersByTime(1_000);
    await runner.tick();

    const warns = log.warn.mock.calls.filter((c: unknown[]) => c[1] === "heartbeat check warning");
    expect(warns).toHaveLength(1);
    expect(warns[0]![0]).toMatchObject({ agent: "agent-a", check: "auto-linker", from: "healthy" });
    expect(journal.all().map((t) => t.to)).toEqual(["warning"]);

    next.result = { status: "healthy", message: "ok" };
    vi.advanceTimersByTime(1_000);
    await runner.tick();
    const infos = log.info.mock.calls.filter((c: unknown[]) => c[1] === "heartbeat check recovered");
    expect(infos).toHaveLength(1);
    expect(journal.all().map((t) => `${t.from}->${t.to}`)).toEqual(["healthy->warning", "warning->healthy"]);
    expect(runner.getTransitionJournal()).toBe(journal);
  });

  it("keeps the per-tick critical log unchanged and journals the critical transition once", async () => {
    const log = mockLogger();
    const journal = new HeartbeatTransitionJournal({});
    const runner = new HeartbeatRunner({
      sessionManager: mockSessionManager(["agent-a"]),
      registryPath: join(tempDir, "registry.json"),
      config,
      checksDir: join(tempDir, "checks"),
      log,
      transitionJournal: journal,
    });
    const next: { result: CheckResult } = { result: { status: "critical", message: "down" } };
    (runner as any).checks = [scriptedCheck("inbox", next)];
    await runner.tick();
    vi.advanceTimersByTime(1_000);
    await runner.tick();
    const criticals = log.warn.mock.calls.filter((c: unknown[]) => c[1] === "heartbeat check critical");
    expect(criticals).toHaveLength(2);
    expect(journal.all()).toEqual([
      expect.objectContaining({ agent: "agent-a", check: "inbox", from: null, to: "critical" }),
    ]);
  });
});
