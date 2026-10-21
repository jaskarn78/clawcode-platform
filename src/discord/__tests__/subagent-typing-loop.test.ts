import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  startTypingLoop,
  TYPING_REFRESH_MS,
} from "../subagent-typing-loop.js";

/**
 * Phase 999.36 Plan 00 Task 1 — sub-bug A typing indicator helper.
 *
 * Spy-tests the `startTypingLoop(thread, log)` helper that mirrors the
 * `bridge.ts:357-377` `fireTypingIndicator` + `bridge.ts:606-611` 8-second
 * heartbeat reference patterns. The helper MUST:
 *   - fire ONCE eagerly at t=0
 *   - re-fire every 8s thereafter (D-05 cadence — Discord typing extends
 *     ~10s/call; 8s gives 2s safety margin so the indicator never flickers)
 *   - return a stop handle that clears the interval
 *   - swallow sendTyping rejections (archived threads, rate limits,
 *     permission errors) at log.debug — never throw to caller
 *   - tolerate thread surfaces that lack sendTyping (test mocks, older
 *     discord.js mocks) as a no-op
 */
describe("startTypingLoop (Phase 999.36 sub-bug A)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function makeFakeLog() {
    return {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
    };
  }

  it("Test 1 — fires sendTyping ONCE eagerly on entry (t=0)", async () => {
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    const thread = { sendTyping };
    const log = makeFakeLog();
    log.child.mockReturnValue(log);

    const handle = startTypingLoop(thread, log as any);

    // Allow the eager fire's microtask + any swallowed catch handler to run.
    await vi.advanceTimersByTimeAsync(0);
    expect(sendTyping).toHaveBeenCalledTimes(1);

    handle.stop();
  });

  it("Test 2 — fires sendTyping again at t=8s", async () => {
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    const thread = { sendTyping };
    const log = makeFakeLog();

    const handle = startTypingLoop(thread, log as any);

    await vi.advanceTimersByTimeAsync(0);
    expect(sendTyping).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(8000);
    expect(sendTyping).toHaveBeenCalledTimes(2);

    handle.stop();
  });

  it("Test 3 — fires sendTyping a 3rd time at t=16s", async () => {
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    const thread = { sendTyping };
    const log = makeFakeLog();

    const handle = startTypingLoop(thread, log as any);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(8000);
    await vi.advanceTimersByTimeAsync(8000);
    expect(sendTyping).toHaveBeenCalledTimes(3);

    handle.stop();
  });

  it("Test 4 — handle.stop() clears the interval; no further sendTyping calls", async () => {
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    const thread = { sendTyping };
    const log = makeFakeLog();

    const handle = startTypingLoop(thread, log as any);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(8000);
    expect(sendTyping).toHaveBeenCalledTimes(2);

    handle.stop();

    // Advance time well past several intervals — no further fires expected.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sendTyping).toHaveBeenCalledTimes(2);
  });

  it("Test 5 — sendTyping rejection (archived thread) is swallowed at log.debug — never throws", async () => {
    const archiveErr = new Error(
      "DiscordAPIError 50083 — Thread is archived",
    );
    const sendTyping = vi.fn().mockRejectedValue(archiveErr);
    const thread = { sendTyping };
    const log = makeFakeLog();

    // Must not throw on construction or eager fire.
    const handle = startTypingLoop(thread, log as any);

    await vi.advanceTimersByTimeAsync(0);
    expect(sendTyping).toHaveBeenCalledTimes(1);
    // Pino-style call: log.debug({ error, ... }, "msg")
    expect(log.debug).toHaveBeenCalled();

    // Subsequent ticks also rejected, also swallowed.
    await vi.advanceTimersByTimeAsync(8000);
    expect(sendTyping).toHaveBeenCalledTimes(2);

    handle.stop();
  });

  it("Test 6 — thread without sendTyping method is a no-op (no throws, valid handle)", async () => {
    const thread = {} as { sendTyping?: () => Promise<unknown> };
    const log = makeFakeLog();

    const handle = startTypingLoop(thread, log as any);

    // Advancing time must not throw and must not log warnings/errors.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(8000);
    await vi.advanceTimersByTimeAsync(8000);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();

    // stop() is still callable without throwing.
    expect(() => handle.stop()).not.toThrow();
  });

  it("D-05 regression pin — exported TYPING_REFRESH_MS is exactly 8000ms", () => {
    expect(TYPING_REFRESH_MS).toBe(8000);
  });

  it("D-05 source-grep regression pin — file contains literal 'TYPING_REFRESH_MS = 8000'", () => {
    // Belt-and-braces: the constant is ALSO grep-asserted in the source so a
    // refactor that re-exports a named import without the literal still trips
    // the acceptance criteria checker.
    const source = readFileSync(
      resolve(__dirname, "../subagent-typing-loop.ts"),
      "utf8",
    );
    const matches = source.match(/TYPING_REFRESH_MS\s*=\s*8000/g) ?? [];
    expect(matches.length).toBe(1);
  });
});
