/**
 * Phase 90 MEM-04 — periodic mid-session flush to memory/YYYY-MM-DD-HHMM.md.
 *
 * Closes the "dashboard-restart SIGKILL loses in-flight session context"
 * crisis by persisting a Haiku-summarized delta of the current session
 * every 15 minutes (configurable via defaults.memoryFlushIntervalMs +
 * agents.*.memoryFlushIntervalMs). On stopAgent, a final flush fires with
 * a 10s await cap (D-29) so a clean shutdown captures the tail end.
 *
 * Reuses Phase 89's summarizeWithHaiku (D-27) — same Haiku prompt-template
 * shape, same 10s timeout contract, same fire-and-forget canary (Phase
 * 83/86/87/89 blueprint: synchronous caller + `.catch(log.warn)`).
 *
 * Skip heuristic (D-26): a tick is a no-op unless the turns-since-last-flush
 * window contains >=1 user turn AND >=1 assistant turn that EITHER has a
 * tool-call marker OR >=200 chars of text. Prevents spam during idle
 * windows where the agent is just acknowledging pings.
 *
 * Atomic write discipline (Phase 82/84/86/88): temp+rename via
 * atomicWriteFile, exported as a module-level helper so memory-cue.ts and
 * subagent-capture.ts can reuse the exact same write path.
 *
 * Pure-ish module: MemoryFlushTimer is a small class (needed for timer
 * lifecycle — start/stop/flushNow) but all I/O is DI'd via MemoryFlushDeps.
 * 100% unit-testable without a daemon.
 *
 * Memory overhaul 2026-10-25 (WP4): the cursor (lastFlushAt) only advances
 * once the window is on disk or there was nothing in it. A skipped window
 * (not meaningful yet), an aborted, failed or empty summary all leave the
 * cursor where it was, so the turns are retried on the next tick instead of
 * being skipped forever. After MAX_CONSECUTIVE_FLUSH_FAILURES failed
 * summaries in a row the raw turns are written under
 * RAW_TURNS_HEADING and the cursor advances. Filenames carry seconds
 * (YYYY-MM-DD-HHMMSS.md) and never overwrite an existing file. The
 * summary abort budget is DEFAULT_FLUSH_SUMMARIZE_TIMEOUT_MS (60s), not the
 * 10s noted above.
 */

import { writeFile, rename, mkdir, unlink, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { nanoid } from "nanoid";
import type { Logger } from "pino";
import type { ConversationTurn } from "./conversation-types.js";

/**
 * D-26 default cadence — 15 minutes. Operators override via
 * defaults.memoryFlushIntervalMs or agents.*.memoryFlushIntervalMs.
 */
export const DEFAULT_MEMORY_FLUSH_INTERVAL_MS = 15 * 60 * 1000;

/**
 * D-27 verbatim prompt — pinned by MEM-04-T4 via grep assertion. Do not
 * rewrite the phrasing without updating the test and the PLAN.
 */
export const FLUSH_SUMMARY_PROMPT =
  "Summarize the most important decisions, tasks in progress, and standing rules from this session segment. Under 300 words, markdown sections, no meta-commentary.";

/**
 * Memory overhaul 2026-10-25 (WP4): abort budget for one periodic summary.
 * The summarizer path (Haiku via the bridge) was measured at 30 to 64s in
 * production and the bridge gives its summarizer child 60s, so the old 10s
 * cap aborted most flushes. Tests and the stop path override it.
 */
export const DEFAULT_FLUSH_SUMMARIZE_TIMEOUT_MS = 60_000;

/**
 * Memory overhaul 2026-10-25 (WP4): failed summaries tolerated in a row
 * before the raw turns are written instead and the cursor advances.
 */
export const MAX_CONSECUTIVE_FLUSH_FAILURES = 3;

/** Heading for a flush file written without a summary (raw fallback). */
export const RAW_TURNS_HEADING = "## Raw turns (summary unavailable)";

/**
 * Character cap on the rendered transcript (prompt and raw fallback). The
 * window can now span several intervals (retries, skipped windows), so the
 * NEWEST characters are kept.
 */
const MAX_TRANSCRIPT_CHARS = 20_000;

/**
 * Options for a single flushNow() call.
 *
 *   rawOnFailure: write the raw turns at once when the summary fails, instead
 *     of waiting for MAX_CONSECUTIVE_FLUSH_FAILURES. Used by the stop path,
 *     which has no later tick to retry on.
 *   summarizeTimeoutMs: abort budget for this call's summary.
 */
export type FlushNowOptions = Readonly<{
  rawOnFailure?: boolean;
  summarizeTimeoutMs?: number;
}>;

/**
 * Summarize function signature. Matches the shape of summarizeWithHaiku
 * (src/manager/summarize-with-haiku.ts) minus the AbortSignal piping —
 * the timer passes the signal via the opts bag so production wiring
 * cleanly reuses Phase 89's helper.
 */
export type FlushSummarizeFn = (
  prompt: string,
  opts: { readonly signal?: AbortSignal },
) => Promise<string>;

/**
 * Function that returns the conversation turns from `sinceTs` (ms epoch)
 * up to "now". Implemented by SessionManager against the active
 * ConversationStore session — tests inject a pure stub.
 */
export type GetTurnsSinceFn = (sinceTs: number) => readonly ConversationTurn[];

/**
 * Dependencies for a MemoryFlushTimer instance. All I/O + state is DI'd so
 * the timer can be exercised with fake timers + tmp-dir workspaces +
 * spy-summarize functions, no daemon required.
 */
export type MemoryFlushDeps = Readonly<{
  /** {workspace}: memory/YYYY-MM-DD-HHMMSS.md lands at `<workspace>/memory/*`. */
  workspacePath: string;
  /** Agent name for log prefix + filename disambiguation (if reused cross-agent). */
  agentName: string;
  /** Interval ms — default DEFAULT_MEMORY_FLUSH_INTERVAL_MS. */
  intervalMs?: number;
  /** Turn accessor (pure). Returns empty array when agent has no active session. */
  getTurnsSince: GetTurnsSinceFn;
  /** Haiku summarizer — typically summarizeWithHaiku from session-summarizer. */
  summarize: FlushSummarizeFn;
  /** Logger (pino). */
  log: Logger;
  /** Test-only clock override. Production leaves undefined → Date.now. */
  now?: () => number;
  /** Abort budget per summary. Default DEFAULT_FLUSH_SUMMARIZE_TIMEOUT_MS. */
  summarizeTimeoutMs?: number;
  /** Failed summaries in a row before the raw fallback. Default MAX_CONSECUTIVE_FLUSH_FAILURES. */
  maxConsecutiveFailures?: number;
}>;

/**
 * D-26 skip heuristic — returns true when the turns list contains the
 * minimum signal for a "meaningful segment worth summarizing":
 *
 *   ≥1 user turn AND ≥1 assistant turn where EITHER
 *     - content length ≥ 200 chars (non-trivial reply), OR
 *     - content contains a tool-call marker (the assistant DID work).
 *
 * The tool-call marker check is deliberately string-based (not schema-
 * parsed) because assistant turn content in ConversationStore is the
 * raw agent reply text; a schema-validated "toolCalls" array doesn't
 * exist on this type. The heuristic matches the SDK's tool-use render
 * surface: `<tool_use …`, `[tool use:`, etc.
 */
export function meaningfulTurnsSince(
  turns: readonly ConversationTurn[],
): boolean {
  let hasUser = false;
  let hasAssistantSignal = false;
  for (const t of turns) {
    if (t.role === "user") hasUser = true;
    if (t.role === "assistant") {
      const content = t.content ?? "";
      const longEnough = content.length >= 200;
      const hasToolCall =
        content.includes("tool_use") || content.includes("[tool use");
      if (longEnough || hasToolCall) hasAssistantSignal = true;
    }
    if (hasUser && hasAssistantSignal) return true;
  }
  return false;
}

/**
 * Atomic temp+rename file write. Shared with memory-cue.ts +
 * subagent-capture.ts. Mirrors Phase 82 yaml-writer + Phase 88
 * install-single-skill discipline.
 *
 *   1. mkdir -p parent (recursive: true — no-op when exists).
 *   2. Write content to `<dst>.<pid>.<now>.<nanoid>.tmp`.
 *   3. Rename tmp → dst (atomic on POSIX).
 *   4. On rename failure: best-effort unlink tmp, rethrow.
 *
 * The nanoid(4) suffix makes concurrent writers to the SAME destination
 * (distinct pids in dev) collision-free at the tmp stage.
 */
export async function atomicWriteFile(
  dstPath: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(dstPath), { recursive: true });
  const tmp = `${dstPath}.${process.pid}.${Date.now()}.${nanoid(4)}.tmp`;
  await writeFile(tmp, content, "utf8");
  try {
    await rename(tmp, dstPath);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
      /* tmp already gone — best-effort cleanup */
    }
    throw err;
  }
}

/**
 * MemoryFlushTimer — per-agent setInterval wrapper that fires a
 * Haiku-summarized delta flush every interval, plus an explicit
 * flushNow() hook for stopAgent's final-flush path.
 *
 * Lifecycle:
 *   start(): schedules the interval (no-op if already running).
 *   stop():  clears the interval (no-op if not running). Does NOT
 *           cancel an in-flight flushNow() — callers that need to
 *           await a pending flush should await flushNow() first.
 *   flushNow(): synchronous caller → returns the Promise of the current
 *           flush attempt. Concurrent callers during an in-flight flush
 *           receive the SAME Promise (dedup via inFlight state).
 */
export class MemoryFlushTimer {
  private handle: NodeJS.Timeout | null = null;
  private lastFlushAt: number;
  private inFlight: Promise<string | null> | null = null;
  private readonly intervalMs: number;
  /** WP4: failed summaries since the last successful write. */
  private consecutiveFailures = 0;

  constructor(private readonly deps: MemoryFlushDeps) {
    this.intervalMs = deps.intervalMs ?? DEFAULT_MEMORY_FLUSH_INTERVAL_MS;
    this.lastFlushAt = (deps.now ?? Date.now)();
  }

  start(): void {
    if (this.handle !== null) return;
    this.handle = setInterval(() => {
      // Fire-and-forget per Phase 83/86/87/89 canary. Errors warn-logged,
      // never propagate past the turn boundary.
      void this.flushNow().catch((err) =>
        this.deps.log.warn(
          { err: (err as Error).message, agent: this.deps.agentName },
          "periodic flush failed (non-fatal)",
        ),
      );
    }, this.intervalMs);
    // Never keep the event loop alive just for this timer — same discipline
    // as the Gap 3 session-flush timer (session-manager.ts:1599).
    this.handle.unref?.();
  }

  stop(): void {
    if (this.handle !== null) {
      clearInterval(this.handle);
      this.handle = null;
    }
  }

  /**
   * Perform a flush immediately. Returns the written file path, or null
   * when nothing was written (skip heuristic declined, or the summary
   * failed and will be retried on the next tick).
   *
   * Concurrent callers during an in-flight flush receive the same Promise
   * (dedup via `inFlight`); their `opts` are ignored. When the outer
   * Promise settles, the next call starts a fresh attempt.
   *
   * A summarizer that throws, aborts or returns an empty string counts as a
   * failed summary (WP4): the cursor stays put and null is returned, until
   * the failure budget is spent (or `opts.rawOnFailure` is set), at which
   * point the raw turns are written and the cursor advances. Only a failed
   * file write rejects.
   *
   * NOT declared `async` because we want to return the EXACT same Promise
   * instance to concurrent callers (toBe-referential equality in tests).
   * An `async` wrapper would produce a fresh Promise on every call.
   *
   * WP4 fix: `inFlight` is cleared by a settle handler on the attempt, not
   * by a `finally` inside it. An attempt that returns before its first
   * `await` (the skip paths) used to run that `finally` synchronously,
   * BEFORE `inFlight` was assigned, so the settled Promise stayed in
   * `inFlight` and every later flushNow() returned it: after the first
   * skipped tick the timer never flushed again.
   */
  flushNow(opts: FlushNowOptions = {}): Promise<string | null> {
    if (this.inFlight) return this.inFlight;
    const attempt = this.runFlush(opts);
    this.inFlight = attempt;
    const clear = (): void => {
      if (this.inFlight === attempt) this.inFlight = null;
    };
    // Registered before any caller's await, so callers resume with
    // `inFlight` already cleared. Both handlers swallow, so this derived
    // promise never rejects unhandled; callers still see the rejection.
    attempt.then(clear, clear);
    return attempt;
  }

  /** One flush attempt. See flushNow for the contract. */
  private async runFlush(opts: FlushNowOptions): Promise<string | null> {
    const now = (this.deps.now ?? Date.now)();
    const turns = this.deps.getTurnsSince(this.lastFlushAt);
    if (turns.length === 0) {
      // Nothing in the window: advancing loses nothing.
      this.lastFlushAt = now;
      return null;
    }
    if (!meaningfulTurnsSince(turns)) {
      // WP4: keep the cursor so these turns are part of the window that
      // gets summarized once it becomes meaningful.
      this.deps.log.debug(
        { agent: this.deps.agentName, turnCount: turns.length },
        "flush skipped (not meaningful)",
      );
      return null;
    }

    // Render turns into a compact transcript for the summarizer. The
    // 20K char cap prevents runaway prompts on very long segments
    // (Haiku's context is large but we pay per-token); the newest
    // characters are kept because the window can span several ticks.
    const transcript = renderTranscript(turns);
    const prompt = `${FLUSH_SUMMARY_PROMPT}\n\nSession segment:\n${transcript}`;

    // D-27 abort cap via AbortController. Re-uses Phase 89 summarizer.
    const timeoutMs =
      opts.summarizeTimeoutMs ??
      this.deps.summarizeTimeoutMs ??
      DEFAULT_FLUSH_SUMMARIZE_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
    let summary = "";
    let failure: string | null = null;
    try {
      summary = await this.deps.summarize(prompt, {
        signal: controller.signal,
      });
    } catch (err) {
      failure = (err as Error)?.message ?? String(err);
    } finally {
      clearTimeout(timeoutHandle);
    }
    if (
      failure === null &&
      (typeof summary !== "string" || summary.trim().length === 0)
    ) {
      failure = controller.signal.aborted
        ? `summary aborted after ${timeoutMs}ms`
        : "empty summary";
    }

    if (failure !== null) {
      this.consecutiveFailures++;
      const maxFailures =
        this.deps.maxConsecutiveFailures ?? MAX_CONSECUTIVE_FLUSH_FAILURES;
      const giveUp =
        opts.rawOnFailure === true ||
        this.consecutiveFailures >= maxFailures;
      this.deps.log.warn(
        {
          agent: this.deps.agentName,
          reason: failure,
          consecutiveFailures: this.consecutiveFailures,
          turnCount: turns.length,
          rawFallback: giveUp,
        },
        giveUp
          ? "flush: summary failed, writing raw turns"
          : "flush: summary failed, will retry the same window next tick",
      );
      if (!giveUp) return null;
      const path = await this.writeFlushFile(
        now,
        turns.length,
        `${RAW_TURNS_HEADING}\n\n${transcript}`,
        true,
      );
      this.consecutiveFailures = 0;
      this.lastFlushAt = now;
      return path;
    }

    const path = await this.writeFlushFile(now, turns.length, summary, false);
    this.consecutiveFailures = 0;
    this.lastFlushAt = now;
    this.deps.log.info(
      { agent: this.deps.agentName, path, turnCount: turns.length },
      "session flush written",
    );
    return path;
  }

  /**
   * Write one flush file. D-28 path: turn-start timestamp (`now`, not
   * wall-clock at write time) prevents concurrent-agent collision when two
   * agents flush at the same tick. WP4: seconds granularity, plus a numeric
   * suffix if that name is already taken, so a periodic tick and the stop
   * path's final flush in the same minute never overwrite each other.
   */
  private async writeFlushFile(
    now: number,
    turnCount: number,
    content: string,
    raw: boolean,
  ): Promise<string> {
    const iso = new Date(now).toISOString();
    const date = iso.slice(0, 10); // YYYY-MM-DD
    const hhmmss = `${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
    const dir = join(this.deps.workspacePath, "memory");
    const path = await firstFreePath(dir, `${date}-${hhmmss}`);
    const body = `---
flushed_at: ${iso}
agent: ${this.deps.agentName}
turn_count: ${turnCount}${raw ? "\nsummary: unavailable" : ""}
---

# Session Flush ${date} ${iso.slice(11, 19)}

${content}
`;
    await atomicWriteFile(path, body);
    return path;
  }
}

/** Render turns as `[role] content` lines, keeping the newest characters. */
function renderTranscript(turns: readonly ConversationTurn[]): string {
  const full = turns.map((t) => `[${t.role}] ${t.content}`).join("\n");
  return full.length > MAX_TRANSCRIPT_CHARS
    ? full.slice(full.length - MAX_TRANSCRIPT_CHARS)
    : full;
}

/** `<dir>/<base>.md`, or `<dir>/<base>-2.md`, `-3`, ... when taken. */
async function firstFreePath(dir: string, base: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = join(dir, n === 1 ? `${base}.md` : `${base}-${n}.md`);
    try {
      await access(candidate);
    } catch {
      return candidate;
    }
  }
}
