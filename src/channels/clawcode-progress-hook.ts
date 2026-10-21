#!/usr/bin/env node
/**
 * Phase 999.82 — ClawCode v3 `PostToolUse` hook (block-level progress stream).
 *
 * The runnable binary the v3 backend injects via `--settings`
 * (`{"hooks":{"PostToolUse":[{"hooks":[{"type":"command","command":"node <dist>/channels/clawcode-progress-hook.js"}]}]}}`).
 * `claude --channels` fires it after EVERY tool call mid-turn and pipes the
 * PostToolUse event JSON on stdin (which includes `transcript_path` +
 * `session_id`). Token-granular streaming is blocked on `--channels`
 * (STREAMING-RESEARCH §1), so this PostToolUse fire is the block-level
 * granularity we get — Approach A, the recommended path.
 *
 * The hook's whole job: read the live transcript, concatenate the assistant
 * `text` blocks emitted SO FAR THIS TURN, and ship them to the daemon as a
 * `ProgressFrame` over `hook.sock` (the SAME socket the Stop hook uses;
 * `frame.type` discriminates daemon-side). The daemon fans the text out to the
 * live Discord editor (Plan 02 / Plan 04). Progress is best-effort COSMETIC —
 * it NEVER participates in delivery truth (that stays with ack / turn_complete).
 *
 * Discipline — IDENTICAL to clawcode-stop-hook.ts (its precedent):
 *   - routes by `process.env.CLAWCODE_AGENT_NAME` (authoritative; cwd is NOT
 *     trusted — it diverges for subagents, which is why Plan 03 must set this to
 *     the SUBAGENT's name in the spawn env). The frame's `agent` is NEVER taken
 *     from the attacker-influenceable stdin payload (threat T-999.82-01-01).
 *   - reads stdin with a 2s defensive timeout; parse-fail → return (send
 *     nothing → degrade to no-stream).
 *   - bounded tail-read of the transcript (last N KB — never re-parse the whole
 *     file) so a crafted/huge transcript can't wedge the turn (T-999.82-01-02).
 *   - empty accumulated text → return (nothing to stream).
 *   - `main().then(exit0, exit0)` — a PostToolUse hook NEVER throws out of the
 *     process; a non-zero exit could surface as a turn error.
 */

import { openSync, fstatSync, readSync, closeSync } from "node:fs";

import {
  defaultHookSocketPath,
  sendProgressFrame,
} from "./unix-socket-transport.js";
// Pure, unit-tested turn-boundary logic (lives in its own module so it can be
// tested without importing this binary, which runs main() at import time).
import {
  accumulateTurnProgress,
  renderActivity,
  type ActivityStyle,
} from "./progress-turn-text.js";

interface PostToolUsePayload {
  readonly session_id?: string;
  readonly transcript_path?: string;
  /** 999.103 WS-1 — PostToolUse also carries the tool identity + full input;
   *  read (only) for the TodoWrite mirror. Everything else stays derived from
   *  the transcript tail-read as before. */
  readonly tool_name?: string;
  readonly tool_input?: unknown;
}

/** Bounded tail-read window. A turn's worth of records fits easily in 256 KB. */
const TAIL_READ_BYTES = 256 * 1024;

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
    // Defensive: if stdin never closes, don't hang the turn.
    const t = setTimeout(() => resolve(data), 2_000);
    t.unref?.();
  });
}

/**
 * Bounded tail-read: open the transcript, read at most the last
 * {@link TAIL_READ_BYTES}, and return the decoded text. Returns "" on any I/O
 * failure (send-nothing degradation). Never reads the whole file.
 */
function tailReadTranscript(path: string): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = size > TAIL_READ_BYTES ? size - TAIL_READ_BYTES : 0;
    const length = size - start;
    if (length <= 0) return "";
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, start);
    return buf.toString("utf-8");
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

async function main(): Promise<void> {
  const agent = process.env.CLAWCODE_AGENT_NAME;
  if (!agent) return; // No identity → can't route. Never break the turn.

  let payload: PostToolUsePayload = {};
  try {
    const raw = await readStdin();
    if (raw.trim().length > 0) payload = JSON.parse(raw) as PostToolUsePayload;
  } catch {
    return; // Malformed payload → drop silently.
  }

  // 999.103 WS-1 — TodoWrite mirror. The checklist is already on stdin;
  // ship it as a `todo` frame over the SAME hook.sock. Best-effort and
  // ADDITIVE: the normal progress flow below still runs, so prose streaming
  // is unaffected. Daemon-side config decides whether anything renders.
  if (payload.tool_name === "TodoWrite") {
    const input = payload.tool_input;
    const todos =
      typeof input === "object" && input !== null && Array.isArray((input as { todos?: unknown }).todos)
        ? ((input as { todos: unknown[] }).todos)
        : null;
    if (todos && todos.length > 0) {
      await sendProgressFrame(defaultHookSocketPath(agent), {
        type: "todo",
        agent,
        session_id: payload.session_id,
        todos,
      });
    }
  }

  const transcriptPath = payload.transcript_path;
  if (typeof transcriptPath !== "string" || transcriptPath.length === 0) {
    return; // No transcript to read → nothing to stream.
  }

  const transcript = tailReadTranscript(transcriptPath);
  // Phase 141 — stream tool ACTIVITY alongside prose so a tool-chaining turn that
  // narrates little still shows visible movement. The render STYLE is chosen by the
  // agent's per-agent config, delivered via the CLAWCODE_ACTIVITY_STYLE spawn env
  // (natural | raw | off); unknown/absent coerces to "natural". Decoupled from the
  // /clawcode-verbose advisor flag (which lives daemon-side).
  const styleEnv = process.env.CLAWCODE_ACTIVITY_STYLE;
  const style: ActivityStyle =
    styleEnv === "raw" || styleEnv === "off" ? styleEnv : "natural";
  const { text, tools } = accumulateTurnProgress(transcript);
  const activity = renderActivity(tools, style);
  if (text.length === 0 && activity.length === 0) return; // Nothing yet → no-stream.
  const accumulatedText =
    activity.length > 0 && text.length > 0
      ? `${activity}\n\n${text}`
      : activity.length > 0
        ? activity
        : text;

  await sendProgressFrame(defaultHookSocketPath(agent), {
    type: "progress",
    agent,
    session_id: payload.session_id,
    accumulated_text: accumulatedText,
  });
}

// Never throw out of the hook — a non-zero exit / unhandled rejection could
// surface as a turn error in the agent's session.
main().then(
  () => process.exit(0),
  () => process.exit(0),
);
