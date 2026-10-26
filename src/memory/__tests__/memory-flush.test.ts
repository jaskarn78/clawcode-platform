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
 *
 * Memory overhaul 2026-10-25 (WP4): T3 now expects a seconds-granularity
 * filename (YYYY-MM-DD-HHMMSS.md, was HHMM). The WP4 block at the end covers
 * the cursor rules: no advance on skip, abort, error or empty summary; raw
 * fallback after the failure budget; no same-name overwrite.
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
  MAX_CONSECUTIVE_FLUSH_FAILURES,
  RAW_TURNS_HEADING,
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

  it("MEM-04-T3: atomic write to memory/YYYY-MM-DD-HHMMSS.md, tmp unlinked on rename success", async () => {
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
    // WP4: seconds granularity (was 2026-04-24-1830.md).
    expect(path).toBe(join(tmp, "memory", "2026-04-24-183000.md"));
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

// ---------------------------------------------------------------------------
// Memory overhaul 2026-10-25 (WP4): cursor rules, raw fallback, filenames.
// ---------------------------------------------------------------------------

/**
 * A tiny turn log keyed by epoch-ms timestamps. getTurnsSince mirrors the
 * SessionManager wiring (turns created strictly after the cursor) and
 * records every cursor it was asked for.
 */
function makeTurnLog() {
  const turns: ConversationTurn[] = [];
  const cursors: number[] = [];
  return {
    add(role: "user" | "assistant", content: string, atMs: number): void {
      turns.push(makeTurn(role, content, new Date(atMs).toISOString()));
    },
    getTurnsSince: (since: number): readonly ConversationTurn[] => {
      cursors.push(since);
      return turns.filter((t) => Date.parse(t.createdAt) > since);
    },
    cursors,
  };
}

describe("MemoryFlushTimer cursor and fallback (WP4)", () => {
  let tmp: string;
  const T0 = new Date("2026-10-26T10:00:00.000Z").getTime();

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mem-flush-wp4-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeTimer(
    log: ReturnType<typeof makeTurnLog>,
    summarize: (p: string, o: { readonly signal?: AbortSignal }) => Promise<string>,
    clock: { t: number },
    extra: Partial<ConstructorParameters<typeof MemoryFlushTimer>[0]> = {},
  ): MemoryFlushTimer {
    return new MemoryFlushTimer({
      workspacePath: tmp,
      agentName: "alice",
      intervalMs: 60_000,
      getTurnsSince: log.getTurnsSince,
      summarize,
      log: silentLog,
      now: () => clock.t,
      ...extra,
    });
  }

  it("an empty summary does not advance the cursor; the next tick retries the same turns", async () => {
    const clock = { t: T0 };
    const log = makeTurnLog();
    log.add("user", "deploy plan?", T0 + 1_000);
    log.add("assistant", "d".repeat(250), T0 + 2_000);
    const summarize = vi
      .fn<(p: string, o: { readonly signal?: AbortSignal }) => Promise<string>>()
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("## Decisions\nship friday");
    const timer = makeTimer(log, summarize, clock);

    clock.t = T0 + 60_000;
    expect(await timer.flushNow()).toBeNull();
    clock.t = T0 + 120_000;
    const path = await timer.flushNow();

    expect(log.cursors).toEqual([T0, T0]);
    expect(summarize).toHaveBeenCalledTimes(2);
    expect(summarize.mock.calls[1][0]).toContain("deploy plan?");
    expect(readFileSync(path!, "utf8")).toContain("ship friday");
    // The successful write advances the cursor to that tick's start.
    clock.t = T0 + 180_000;
    await timer.flushNow();
    expect(log.cursors[2]).toBe(T0 + 120_000);
  });

  it("a summarizer that throws resolves null and keeps the cursor", async () => {
    const clock = { t: T0 };
    const log = makeTurnLog();
    log.add("user", "q", T0 + 1_000);
    log.add("assistant", "a".repeat(250), T0 + 2_000);
    const timer = makeTimer(
      log,
      async () => {
        throw new Error("haiku 529");
      },
      clock,
    );
    clock.t = T0 + 60_000;
    await expect(timer.flushNow()).resolves.toBeNull();
    clock.t = T0 + 120_000;
    await timer.flushNow();
    expect(log.cursors).toEqual([T0, T0]);
    expect(existsSync(join(tmp, "memory"))).toBe(false);
  });

  it("an aborted summary (timeout) keeps the cursor", async () => {
    const clock = { t: T0 };
    const log = makeTurnLog();
    log.add("user", "q", T0 + 1_000);
    log.add("assistant", "a".repeat(250), T0 + 2_000);
    // Mirrors summarizeWithHaiku: an abort resolves to "".
    const summarize = (_p: string, o: { readonly signal?: AbortSignal }) =>
      new Promise<string>((resolve) => {
        o.signal?.addEventListener("abort", () => resolve(""));
      });
    const timer = makeTimer(log, summarize, clock, { summarizeTimeoutMs: 20 });
    clock.t = T0 + 60_000;
    expect(await timer.flushNow()).toBeNull();
    clock.t = T0 + 120_000;
    expect(await timer.flushNow()).toBeNull();
    expect(log.cursors).toEqual([T0, T0]);
  });

  it(`after ${MAX_CONSECUTIVE_FLUSH_FAILURES} failed summaries the raw turns are written and the cursor advances`, async () => {
    const clock = { t: T0 };
    const log = makeTurnLog();
    log.add("user", "RAW-USER-WORDS about the staging db", T0 + 1_000);
    log.add("assistant", "RAW-ASSISTANT " + "x".repeat(250), T0 + 2_000);
    const summarize = vi.fn(async () => "");
    const timer = makeTimer(log, summarize, clock);

    const results: (string | null)[] = [];
    for (let i = 1; i <= MAX_CONSECUTIVE_FLUSH_FAILURES; i++) {
      clock.t = T0 + i * 60_000;
      results.push(await timer.flushNow());
    }
    expect(results.slice(0, -1)).toEqual(
      Array(MAX_CONSECUTIVE_FLUSH_FAILURES - 1).fill(null),
    );
    const rawPath = results[results.length - 1];
    expect(rawPath).toBe(join(tmp, "memory", "2026-10-26-100300.md"));
    const body = readFileSync(rawPath!, "utf8");
    expect(body).toContain(RAW_TURNS_HEADING);
    expect(body).toContain("[user] RAW-USER-WORDS about the staging db");
    expect(body).toContain("[assistant] RAW-ASSISTANT");
    expect(body).toContain("summary: unavailable");

    // Cursor advanced past the raw-written window; the counter reset, so the
    // next failure is a retry again, not an immediate raw write.
    log.add("user", "later", T0 + 200_000);
    log.add("assistant", "y".repeat(250), T0 + 201_000);
    clock.t = T0 + 240_000;
    expect(await timer.flushNow()).toBeNull();
    expect(log.cursors[log.cursors.length - 1]).toBe(
      T0 + MAX_CONSECUTIVE_FLUSH_FAILURES * 60_000,
    );
  });

  it("a success in between resets the failure count", async () => {
    const clock = { t: T0 };
    const log = makeTurnLog();
    log.add("user", "q1", T0 + 1_000);
    log.add("assistant", "a".repeat(250), T0 + 2_000);
    const summarize = vi
      .fn<(p: string, o: { readonly signal?: AbortSignal }) => Promise<string>>()
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("## Decisions\nok")
      .mockResolvedValue("");
    const timer = makeTimer(log, summarize, clock);
    for (let i = 1; i <= 3; i++) {
      clock.t = T0 + i * 60_000;
      await timer.flushNow();
    }
    log.add("user", "q2", T0 + 200_000);
    log.add("assistant", "b".repeat(250), T0 + 201_000);
    clock.t = T0 + 240_000;
    // Two more failures after the success: still below the budget.
    expect(await timer.flushNow()).toBeNull();
    clock.t = T0 + 300_000;
    expect(await timer.flushNow()).toBeNull();
    const files = readdirSync(join(tmp, "memory"));
    expect(files).toHaveLength(1);
    expect(readFileSync(join(tmp, "memory", files[0]!), "utf8")).not.toContain(
      RAW_TURNS_HEADING,
    );
  });

  it("rawOnFailure writes the raw turns on the first failure (stop path)", async () => {
    const clock = { t: T0 };
    const log = makeTurnLog();
    log.add("user", "final words", T0 + 1_000);
    log.add("assistant", "z".repeat(250), T0 + 2_000);
    const timer = makeTimer(log, async () => "", clock);
    clock.t = T0 + 60_000;
    const path = await timer.flushNow({ rawOnFailure: true });
    expect(path).not.toBeNull();
    expect(readFileSync(path!, "utf8")).toContain(RAW_TURNS_HEADING);
    expect(readFileSync(path!, "utf8")).toContain("final words");
  });

  it("per-call summarizeTimeoutMs overrides the default abort budget", async () => {
    const clock = { t: T0 };
    const log = makeTurnLog();
    log.add("user", "q", T0 + 1_000);
    log.add("assistant", "a".repeat(250), T0 + 2_000);
    let aborted = false;
    const summarize = (_p: string, o: { readonly signal?: AbortSignal }) =>
      new Promise<string>((resolve) => {
        o.signal?.addEventListener("abort", () => {
          aborted = true;
          resolve("");
        });
      });
    const timer = makeTimer(log, summarize, clock);
    clock.t = T0 + 60_000;
    const started = Date.now();
    const path = await timer.flushNow({ rawOnFailure: true, summarizeTimeoutMs: 25 });
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(path).not.toBeNull();
  });

  it("a skipped (not yet meaningful) window keeps the cursor, so its turns reach the next summary", async () => {
    const clock = { t: T0 };
    const log = makeTurnLog();
    log.add("user", "EARLY-SHORT-QUESTION", T0 + 1_000);
    log.add("assistant", "ok", T0 + 2_000);
    const summarize = vi.fn(async (_p: string) => "## Decisions\nx");
    const timer = makeTimer(log, summarize, clock);

    clock.t = T0 + 60_000;
    expect(await timer.flushNow()).toBeNull();
    expect(summarize).not.toHaveBeenCalled();

    log.add("user", "and the long one?", T0 + 70_000);
    log.add("assistant", "l".repeat(300), T0 + 71_000);
    clock.t = T0 + 120_000;
    expect(await timer.flushNow()).not.toBeNull();
    expect(log.cursors).toEqual([T0, T0]);
    expect(summarize.mock.calls[0]![0]).toContain("EARLY-SHORT-QUESTION");
  });

  it("keeps flushing after a skipped tick (inFlight is not left stuck on a settled promise)", async () => {
    const clock = { t: T0 };
    const log = makeTurnLog();
    const summarize = vi.fn(async (_p: string) => "## S\nafter skip");
    const timer = makeTimer(log, summarize, clock);
    // Tick 1: nothing to flush (returns before any await).
    clock.t = T0 + 60_000;
    const first = timer.flushNow();
    expect(await first).toBeNull();
    // Tick 2: a meaningful window. Before the WP4 fix this returned the
    // settled tick-1 promise (null) and never called summarize.
    log.add("user", "real question", T0 + 70_000);
    log.add("assistant", "r".repeat(250), T0 + 71_000);
    clock.t = T0 + 120_000;
    const second = timer.flushNow();
    expect(second).not.toBe(first);
    expect(await second).not.toBeNull();
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it("an empty window advances the cursor (nothing to lose)", async () => {
    const clock = { t: T0 };
    const log = makeTurnLog();
    const timer = makeTimer(log, async () => "x", clock);
    clock.t = T0 + 60_000;
    expect(await timer.flushNow()).toBeNull();
    clock.t = T0 + 120_000;
    await timer.flushNow();
    expect(log.cursors).toEqual([T0, T0 + 60_000]);
  });

  it("two flushes in the same second never overwrite each other", async () => {
    const clock = { t: T0 };
    const log = makeTurnLog();
    log.add("user", "first", T0 + 1_000);
    log.add("assistant", "a".repeat(250), T0 + 2_000);
    const timer = makeTimer(log, async () => "## S\none", clock);
    // A second timer instance on the same workspace (for example a
    // hot-reload restarted the timer) flushing in the same second.
    const log2 = makeTurnLog();
    log2.add("user", "second", T0 + 1_000);
    log2.add("assistant", "b".repeat(250), T0 + 2_000);
    const timer2 = makeTimer(log2, async () => "## S\ntwo", clock);
    clock.t = T0 + 61_000;
    const p1 = await timer.flushNow();
    const p2 = await timer2.flushNow();
    expect(p1).toBe(join(tmp, "memory", "2026-10-26-100101.md"));
    expect(p2).toBe(join(tmp, "memory", "2026-10-26-100101-2.md"));
    expect(readFileSync(p1!, "utf8")).toContain("one");
    expect(readFileSync(p2!, "utf8")).toContain("two");
  });

  it("keeps the newest transcript characters when the window is over the cap", async () => {
    const clock = { t: T0 };
    const log = makeTurnLog();
    log.add("user", "OLDEST " + "o".repeat(25_000), T0 + 1_000);
    log.add("user", "NEWEST-QUESTION", T0 + 2_000);
    log.add("assistant", "n".repeat(250), T0 + 3_000);
    const summarize = vi.fn(async (_p: string) => "## S\nx");
    const timer = makeTimer(log, summarize, clock);
    clock.t = T0 + 60_000;
    await timer.flushNow();
    const prompt = summarize.mock.calls[0]![0];
    expect(prompt).toContain("NEWEST-QUESTION");
    expect(prompt).not.toContain("OLDEST");
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
