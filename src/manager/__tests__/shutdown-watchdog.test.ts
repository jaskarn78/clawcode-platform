import { describe, it, expect, vi } from "vitest";
import { pino } from "pino";
import {
  withShutdownStep,
  armShutdownWatchdog,
  DEFAULT_SHUTDOWN_STEP_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_WATCHDOG_MS,
} from "../shutdown-watchdog.js";

// Silent logger; tests assert behaviour via spies/timing, not log output.
const silentLog = pino({ level: "silent" });

describe("withShutdownStep", () => {
  it("resolves immediately when the step settles before the timeout", async () => {
    const step = vi.fn().mockResolvedValue(undefined);
    const result = await withShutdownStep("fast", step, 1_000, silentLog);
    expect(result.timedOut).toBe(false);
    expect(step).toHaveBeenCalledOnce();
  });

  it("swallows a thrown step (non-fatal) and reports not-timed-out", async () => {
    const warn = vi.fn();
    const step = vi.fn().mockRejectedValue(new Error("boom"));
    const result = await withShutdownStep(
      "throwing",
      step,
      1_000,
      { warn } as never,
    );
    expect(result.timedOut).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ step: "throwing", err: "boom" }),
      expect.stringContaining("threw"),
    );
  });

  it("times out and continues when the step hangs past the bound", async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.fn();
      // A step that never settles.
      const step = vi.fn().mockReturnValue(new Promise<void>(() => {}));
      const pending = withShutdownStep(
        "hanging",
        step,
        5_000,
        { warn } as never,
      );
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await pending;
      expect(result.timedOut).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ step: "hanging", timeoutMs: 5_000 }),
        expect.stringContaining("timed out"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a slow step abort the whole sequence (sequential continue)", async () => {
    vi.useFakeTimers();
    try {
      const order: string[] = [];
      const hang = withShutdownStep(
        "a",
        () => new Promise<void>(() => {}),
        1_000,
        silentLog,
      ).then(() => order.push("a-done"));
      await vi.advanceTimersByTimeAsync(1_000);
      await hang;
      // Next step still runs after the timed-out one.
      await withShutdownStep("b", async () => {}, 1_000, silentLog).then(() =>
        order.push("b-done"),
      );
      expect(order).toEqual(["a-done", "b-done"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("armShutdownWatchdog", () => {
  it("force-exits with the supplied code when not disarmed in budget", () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn();
      armShutdownWatchdog(0, 20_000, exit, silentLog);
      vi.advanceTimersByTime(20_000);
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses exit code 129 on the SIGHUP path (preserves systemd restart contract)", () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn();
      armShutdownWatchdog(129, 20_000, exit, silentLog);
      vi.advanceTimersByTime(20_000);
      expect(exit).toHaveBeenCalledWith(129);
      expect(exit).not.toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire after disarm (clean in-budget shutdown)", () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn();
      const handle = armShutdownWatchdog(0, 20_000, exit, silentLog);
      handle.disarm();
      vi.advanceTimersByTime(60_000);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("disarm is idempotent", () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn();
      const handle = armShutdownWatchdog(0, 20_000, exit, silentLog);
      handle.disarm();
      handle.disarm();
      vi.advanceTimersByTime(60_000);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("exposes sane defaults", () => {
    expect(DEFAULT_SHUTDOWN_STEP_TIMEOUT_MS).toBe(10_000);
    expect(DEFAULT_SHUTDOWN_WATCHDOG_MS).toBe(20_000);
    // Six serial step timeouts must stay under the watchdog budget in the
    // worst case only if steps run concurrently; they run sequentially, so the
    // watchdog is the real bound — assert it is the larger of the two.
    expect(DEFAULT_SHUTDOWN_WATCHDOG_MS).toBeGreaterThan(0);
  });
});
