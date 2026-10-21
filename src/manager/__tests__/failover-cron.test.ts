/**
 * Phase 138 Plan 05 T-05 — `scheduleFailoverCron` tests.
 *
 * Uses an injected `cronFactory` stub that captures the callback so the
 * tick can be fired synchronously without croner's real timer.
 *
 * See:
 *   - `.planning/phases/138-.../138-05-PLAN.md` T-05
 *   - `src/manager/failover-cron.ts`
 */

import { describe, it, expect, vi } from "vitest";
import {
  scheduleFailoverCron,
  type FailoverCronFactory,
} from "../failover-cron.js";

/** Build a cron-factory stub that captures the callback + a stop spy. */
function captureFactory(): {
  factory: FailoverCronFactory;
  trigger: () => Promise<void>;
  stop: ReturnType<typeof vi.fn>;
  pattern: () => string | undefined;
  name: () => string | undefined;
} {
  let captured: (() => unknown | Promise<unknown>) | undefined;
  let capturedPattern: string | undefined;
  let capturedName: string | undefined;
  const stop = vi.fn();
  const factory: FailoverCronFactory = (pattern, opts, callback) => {
    captured = callback;
    capturedPattern = pattern;
    capturedName = opts.name;
    return { stop };
  };
  return {
    factory,
    trigger: async () => {
      if (captured) await captured();
    },
    stop,
    pattern: () => capturedPattern,
    name: () => capturedName,
  };
}

describe("scheduleFailoverCron", () => {
  it("(a) returns a handle; the tick fires controller.tick()", async () => {
    const cap = captureFactory();
    const controller = { tick: vi.fn().mockResolvedValue(undefined) };
    const handle = scheduleFailoverCron({
      controller,
      logger: { info: vi.fn(), error: vi.fn() },
      cronFactory: cap.factory,
    });
    expect(typeof handle.stop).toBe("function");
    expect(cap.pattern()).toBe("*/1 * * * *");
    expect(cap.name()).toBe("phase138-failover");
    await cap.trigger();
    expect(controller.tick).toHaveBeenCalledTimes(1);
  });

  it("(b) .stop() halts the cron (delegates to the croner handle)", () => {
    const cap = captureFactory();
    const handle = scheduleFailoverCron({
      controller: { tick: vi.fn().mockResolvedValue(undefined) },
      logger: { info: vi.fn(), error: vi.fn() },
      cronFactory: cap.factory,
    });
    handle.stop();
    expect(cap.stop).toHaveBeenCalledTimes(1);
  });

  it("(c) a tick error is caught + logged, never rethrown", async () => {
    const cap = captureFactory();
    const logger = { info: vi.fn(), error: vi.fn() };
    const controller = {
      tick: vi.fn().mockRejectedValue(new Error("tick exploded")),
    };
    scheduleFailoverCron({
      controller,
      logger,
      cronFactory: cap.factory,
    });
    // The callback must resolve (not reject) despite the tick throwing.
    await expect(cap.trigger()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ tag: "phase138-failover-cron-error" }),
      "phase138-failover-cron-error",
    );
  });
});
