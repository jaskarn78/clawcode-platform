/**
 * Phase 90 MEM-04 — MemoryFlushTimer unit tests.
 *
 * Verifies:
 *   T1: cadence (interval fires repeatedly with fake timers)
 *   T2: skip heuristic (no meaningful turns → no summarize, no write)
 *   T3: atomic temp+rename write to memory/YYYY-MM-DD-HHMM.md
 *   T4: D-27 prompt verbatim ("Summarize the most important decisions...")
 *   T5: stop() cancels interval
 *   T6: concurrent flushNow() is deduped via inFlight Promise
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import type { ConversationTurn } from "../conversation-types.js";
import {
  MemoryFlushTimer,
  meaningfulTurnsSince,
  atomicWriteFile,
} from "../memory-flush.js";

const silentLog = pino({ level: "silent" });

function makeTurn(
  role: "user" | "assistant",
  content: string,
  createdAt: string = "2026-04-24T12:00:00.000Z",
): ConversationTurn {
  return Object.freeze({
    id: `t-${Math.random()}`,
    sessionId: "s1",
    turnIndex: 0,
    role,
    content,
    tokenCount: null,
    channelId: null,
    discordUserId: null,
    discordMessageId: null,
    isTrustedChannel: false,
    origin: null,
    instructionFlags: null,
    createdAt,
  });
}

describe("meaningfulTurnsSince (Phase 90 MEM-04)", () => {
  it("returns false for an empty turn list", () => {
    expect(meaningfulTurnsSince([])).toBe(false);
  });

  it("returns false when only user turns are present (no assistant signal)", () => {
    expect(meaningfulTurnsSince([makeTurn("user", "hello")])).toBe(false);
  });

  it("returns false when assistant reply is short and has no tool-call marker", () => {
    expect(
      meaningfulTurnsSince([
        makeTurn("user", "hi"),
        makeTurn("assistant", "ok"),
      ]),
    ).toBe(false);
  });

  it("returns true when user turn + assistant turn has >=200 chars", () => {
    expect(
      meaningfulTurnsSince([
        makeTurn("user", "q"),
        makeTurn("assistant", "a".repeat(200)),
      ]),
    ).toBe(true);
  });

  it("returns true when user turn + assistant content contains a tool-call marker", () => {
    expect(
      meaningfulTurnsSince([
        makeTurn("user", "question?"),
        makeTurn(
          "assistant",
          "calling <tool_use name=\"Read\" />", // short but has tool_use marker
        ),
      ]),
    ).toBe(true);
  });
});

describe("MemoryFlushTimer (Phase 90 MEM-04)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mem-flush-"));
  });

  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("MEM-04-T1: fires the configured interval tick with fake timers", async () => {
    vi.useFakeTimers();
    try {
      const summarizeSpy = vi.fn(async () => "summary text");
      const timer = new MemoryFlushTimer({
        workspacePath: tmp,
        agentName: "alice",
        intervalMs: 60_000,
        getTurnsSince: () => [
          makeTurn("user", "hello"),
          makeTurn("assistant", "a".repeat(250)),
        ],
        summarize: summarizeSpy,
        log: silentLog,
      });
      timer.start();
      await vi.advanceTimersByTimeAsync(60_000);
      // Drain microtasks + the async inFlight closure
      await vi.runOnlyPendingTimersAsync();
      timer.stop();
      expect(summarizeSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("MEM-04-T2: skips flush when turns are not meaningful (no summarize, no file)", async () => {
    const summarizeSpy = vi.fn(async () => "should not be called");
    const timer = new MemoryFlushTimer({
      workspacePath: tmp,
      agentName: "alice",
      intervalMs: 60_000,
      getTurnsSince: () => [], // empty — not meaningful
      summarize: summarizeSpy,
      log: silentLog,
    });
    const result = await timer.flushNow();
    expect(result).toBeNull();
    expect(summarizeSpy).not.toHaveBeenCalled();
    expect(existsSync(join(tmp, "memory"))).toBe(false);
  });

  it("MEM-04-T3: atomic write to memory/YYYY-MM-DD-HHMM.md — tmp unlinked on rename success", async () => {
    const now = new Date("2026-04-24T18:30:00.000Z").getTime();
    const timer = new MemoryFlushTimer({
      workspacePath: tmp,
      agentName: "alice",
      intervalMs: 60_000,
      getTurnsSince: () => [
        makeTurn("user", "Zaid investment proportion?"),
        makeTurn("assistant", "b".repeat(220)),
      ],
      summarize: async () => "## Decisions\nZaid wants 40% SGOV.",
      log: silentLog,
      now: () => now,
    });
    const path = await timer.flushNow();
    expect(path).toBe(join(tmp, "memory", "2026-04-24-1830.md"));
    expect(existsSync(path!)).toBe(true);
    const contents = readFileSync(path!, "utf8");
    expect(contents).toContain("## Decisions");
    expect(contents).toContain("Zaid wants 40% SGOV");
    expect(contents).toContain("flushed_at:");

    // No stray .tmp files after rename
    const entries = readdirSync(join(tmp, "memory"));
    const tmpFiles = entries.filter((e) => e.endsWith(".tmp"));
    expect(tmpFiles).toEqual([]);
  });

  it("MEM-04-T4: passes the D-27 verbatim prompt to summarize()", async () => {
    const summarizeSpy = vi.fn(
      async (_prompt: string, _opts: { readonly signal?: AbortSignal }) => "out",
    );
    const timer = new MemoryFlushTimer({
      workspacePath: tmp,
      agentName: "alice",
      intervalMs: 60_000,
      getTurnsSince: () => [
        makeTurn("user", "hi"),
        makeTurn("assistant", "x".repeat(250)),
      ],
      summarize: summarizeSpy,
      log: silentLog,
    });
    await timer.flushNow();
    expect(summarizeSpy).toHaveBeenCalled();
    const prompt = summarizeSpy.mock.calls[0][0];
    expect(prompt).toContain(
      "Summarize the most important decisions, tasks in progress, and standing rules from this session segment.",
    );
    expect(prompt).toContain("Under 300 words");
    expect(prompt).toContain("no meta-commentary");
  });

  it("MEM-04-T5: stop() cancels the interval — no further ticks", async () => {
    vi.useFakeTimers();
    try {
      const summarizeSpy = vi.fn(async () => "x");
      const timer = new MemoryFlushTimer({
        workspacePath: tmp,
        agentName: "alice",
        intervalMs: 60_000,
        getTurnsSince: () => [
          makeTurn("user", "hi"),
          makeTurn("assistant", "y".repeat(220)),
        ],
        summarize: summarizeSpy,
        log: silentLog,
      });
      timer.start();
      timer.stop();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(summarizeSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("MEM-04-T6: concurrent flushNow() returns the same in-flight Promise (dedup)", async () => {
    let resolveSummary: ((val: string) => void) | null = null;
    const summaryPromise = new Promise<string>((r) => (resolveSummary = r));
    const summarizeSpy = vi.fn(() => summaryPromise);
    const timer = new MemoryFlushTimer({
      workspacePath: tmp,
      agentName: "alice",
      intervalMs: 60_000,
      getTurnsSince: () => [
        makeTurn("user", "hi"),
        makeTurn("assistant", "z".repeat(250)),
      ],
      summarize: summarizeSpy as never,
      log: silentLog,
    });
    const a = timer.flushNow();
    const b = timer.flushNow();
    expect(a).toBe(b); // same in-flight Promise
    resolveSummary!("out");
    await a;
    await b;
    expect(summarizeSpy).toHaveBeenCalledTimes(1);
  });
});

describe("atomicWriteFile (Phase 90 MEM-04)", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "atomic-write-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("writes content then renames .tmp → dst atomically; tmp gone after", async () => {
    const dst = join(tmp, "nested", "file.md");
    await atomicWriteFile(dst, "hello world");
    expect(existsSync(dst)).toBe(true);
    expect(readFileSync(dst, "utf8")).toBe("hello world");
    const parent = join(tmp, "nested");
    const entries = readdirSync(parent);
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
  });
});
