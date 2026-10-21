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
 */

import { writeFile, rename, mkdir, unlink } from "node:fs/promises";
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
  /** {workspace} — memory/YYYY-MM-DD-HHMM.md lands at `<workspace>/memory/*`. */
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
   * when the skip heuristic declined the flush.
   *
   * Concurrent callers during an in-flight flush receive the same Promise
   * (dedup via `inFlight`). When the outer Promise settles, the next call
   * starts a fresh attempt.
   *
   * NOT declared `async` because we want to return the EXACT same Promise
   * instance to concurrent callers (toBe-referential equality in tests).
   * An `async` wrapper would produce a fresh Promise on every call.
   */
  flushNow(): Promise<string | null> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        const now = (this.deps.now ?? Date.now)();
        const turns = this.deps.getTurnsSince(this.lastFlushAt);
        if (!meaningfulTurnsSince(turns)) {
          this.deps.log.debug(
            { agent: this.deps.agentName, turnCount: turns.length },
            "flush skipped (not meaningful)",
          );
          this.lastFlushAt = now;
          return null;
        }

        // Render turns into a compact transcript for the summarizer. 20K
        // char cap prevents runaway prompts on very long segments (Haiku's
        // context is large but we pay per-token).
        const transcript = turns
          .map((t) => `[${t.role}] ${t.content}`)
          .join("\n")
          .slice(0, 20_000);
        const prompt = `${FLUSH_SUMMARY_PROMPT}\n\nSession segment:\n${transcript}`;

        // D-27 — 10s cap via AbortController. Re-uses Phase 89 summarizer.
        const controller = new AbortController();
        const timeoutHandle = setTimeout(() => controller.abort(), 10_000);
        let summary: string;
        try {
          summary = await this.deps.summarize(prompt, {
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeoutHandle);
        }

        if (typeof summary !== "string" || summary.length === 0) {
          this.deps.log.debug(
            { agent: this.deps.agentName },
            "flush: empty summary — skipping write",
          );
          this.lastFlushAt = now;
          return null;
        }

        // D-28 path: turn-start timestamp (now, not wall-clock) prevents
        // concurrent-agent collision when two agents flush at the same tick.
        const iso = new Date(now).toISOString();
        const date = iso.slice(0, 10); // YYYY-MM-DD
        const hhmm = `${iso.slice(11, 13)}${iso.slice(14, 16)}`; // HHMM
        const path = join(
          this.deps.workspacePath,
          "memory",
          `${date}-${hhmm}.md`,
        );
        const body = `---
flushed_at: ${iso}
agent: ${this.deps.agentName}
turn_count: ${turns.length}
---

# Session Flush ${date} ${iso.slice(11, 16)}

${summary}
`;
        await atomicWriteFile(path, body);
        this.lastFlushAt = now;
        this.deps.log.info(
          { agent: this.deps.agentName, path, turnCount: turns.length },
          "session flush written",
        );
        return path;
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }
}
