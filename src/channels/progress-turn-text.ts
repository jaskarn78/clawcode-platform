/**
 * Phase 999.82 — current-turn assistant-text accumulation for the progress hook.
 *
 * Extracted into its own side-effect-free module (the hook binary itself runs
 * `main()` at import time, so its turn-boundary logic can't be unit-tested by
 * importing the binary). This module is pure: given a bounded tail of the
 * `claude --channels` JSONL transcript, return the assistant `text` blocks
 * emitted SO FAR THIS TURN, concatenated. The hook ships the result as a
 * `ProgressFrame.accumulated_text`.
 *
 * Reuses the ONE block extractor (`extractContentBlocks`) — no parallel parser
 * (`feedback_silent_path_bifurcation`).
 */

import { extractContentBlocks } from "../memory/sdk-transcript-reader.js";

/**
 * Concatenate the assistant `text` blocks emitted SO FAR THIS TURN from a
 * bounded tail of the transcript.
 *
 * "Current turn" = the records since the last REAL user prompt. The transcript
 * is append-only across the whole session, so we walk parsed records BACKWARDS
 * from the end, collecting assistant text, and stop at the turn boundary.
 *
 * CRITICAL (verified against live transcripts): `tool_result` blocks are
 * delivered as `type:"user"` records too — content `[{type:"tool_result"}]`,
 * NO text block. A single multi-tool turn therefore contains several `user`
 * records (one per tool result) interleaved with the assistant's text. Stopping
 * at the FIRST `user` record walking backwards would fragment the stream —
 * after the 2nd tool call we'd only see the latest text block, not the
 * accumulated total (must-have truth #1: carry the ACCUMULATED text). So the
 * boundary is a user record that carries a REAL prompt — a `text` block (or, via
 * `extractContentBlocks`, string content folded into one). A pure-`tool_result`
 * user record is mid-turn → walk past it.
 *
 * A leading partial line (truncated by the bounded read) is dropped — a parse
 * failure on it is harmless.
 */
/**
 * Phase 141 (B) — current-turn progress: the accumulated assistant `text` AND the
 * `tool_use` activity (tool names in document order) emitted so far this turn. The
 * progress hook renders the tools as a compact activity line so a tool-chaining turn
 * that narrates little still shows visible movement instead of a dead channel.
 */
export interface TurnProgress {
  readonly text: string;
  readonly tools: readonly string[];
}

/**
 * Single backward walk over the current turn collecting BOTH assistant `text`
 * blocks and `tool_use` names (document order). `accumulateTurnText` delegates here
 * so there is exactly ONE turn-boundary parser (`feedback_silent_path_bifurcation`).
 */
export function accumulateTurnProgress(transcript: string): TurnProgress {
  if (transcript.length === 0) return { text: "", tools: [] };
  const lines = transcript.split("\n");
  const records: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const obj = JSON.parse(trimmed) as unknown;
      if (obj && typeof obj === "object") {
        records.push(obj as Record<string, unknown>);
      }
    } catch {
      continue;
    }
  }

  const textsReversed: string[] = [];
  const toolsReversed: string[] = [];
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i];
    if (!rec) continue;
    const recType = rec.type;
    const blocks = extractContentBlocks(rec.message);
    if (recType === "user") {
      const hasText =
        !!blocks &&
        blocks.some((b) => b.type === "text" && typeof b.text === "string");
      if (hasText) break;
      continue;
    }
    if (recType !== "assistant") continue;
    if (!blocks) continue;
    for (let b = blocks.length - 1; b >= 0; b--) {
      const block = blocks[b];
      if (!block) continue;
      if (block.type === "text" && typeof block.text === "string") {
        textsReversed.push(block.text);
      } else if (block.type === "tool_use" && typeof block.name === "string") {
        toolsReversed.push(block.name);
      }
    }
  }
  textsReversed.reverse();
  toolsReversed.reverse();
  return { text: textsReversed.join(""), tools: toolsReversed };
}

/** Strip the `mcp__server__` prefix so MCP tools render with their bare name. */
function bareToolName(name: string): string {
  const parts = name.split("__");
  return parts[parts.length - 1] ?? name;
}

/** Tools that are pure machinery / noise in a user-facing activity line. */
const ACTIVITY_HIDDEN_TOOLS = new Set([
  "clawcode_ack", // the reply mechanism itself
  "ToolSearch", // deferred-tool schema loading (internal)
  "clawcode_inbox_read",
  "clawcode_status",
]);

/** Emoji per known tool; falls back to a generic wrench. */
function toolEmoji(bare: string): string {
  switch (bare) {
    case "WebSearch":
      return "🔍";
    case "WebFetch":
      return "🌐";
    case "Read":
      return "📖";
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return "✏️";
    case "Bash":
      return "💻";
    case "Glob":
    case "Grep":
      return "🔎";
    case "Task":
      return "🤖";
    case "spawn_subagent_thread":
      return "🧵";
    case "memory_lookup":
    case "memory_save":
      return "🧠";
    default:
      return "🔧";
  }
}

/**
 * Phase 141 (B) — render the turn's tool activity as a compact one-line marker for
 * the progress stream, e.g. `🔍 WebSearch ×2 · 🌐 WebFetch`. Hidden machinery tools
 * (ack, ToolSearch) are dropped. Consecutive duplicates collapse to `×N`. Returns
 * "" when there is nothing user-meaningful to show.
 */
export function renderToolActivity(tools: readonly string[]): string {
  const visible = tools
    .map(bareToolName)
    .filter((t) => !ACTIVITY_HIDDEN_TOOLS.has(t));
  if (visible.length === 0) return "";
  const segments: string[] = [];
  for (const bare of visible) {
    const label = `${toolEmoji(bare)} ${bare}`;
    const last = segments[segments.length - 1];
    if (last && last.startsWith(label + (last.includes(" ×") ? " ×" : ""))) {
      // collapse consecutive duplicate into ×N
      const m = last.match(/ ×(\d+)$/);
      const n = m ? Number(m[1]) + 1 : 2;
      segments[segments.length - 1] = `${label} ×${n}`;
    } else {
      segments.push(label);
    }
  }
  return segments.join(" · ");
}

/** v3 streaming activity level (see `streamingConfigSchema.activity`). */
export type ActivityStyle = "natural" | "raw" | "off";

/**
 * Phase 141 — humanized present-progressive phrase for a tool. Pairs with
 * {@link toolEmoji} so `natural` activity reads as "🔍 Searching the web…"
 * instead of the raw "🔍 WebSearch ×2" machinery.
 */
function toolPhrase(bare: string): string {
  switch (bare) {
    case "WebSearch":
      return "Searching the web…";
    case "WebFetch":
      return "Reading a page…";
    case "Read":
    case "Glob":
    case "Grep":
      return "Looking through files…";
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return "Editing…";
    case "Bash":
      return "Running a command…";
    case "Task":
    case "spawn_subagent_thread":
      return "Working with a subagent…";
    case "memory_lookup":
    case "memory_save":
      return "Checking memory…";
    default:
      return "Working…";
  }
}

/**
 * Phase 141 — single entry point for rendering the turn's tool activity at the
 * chosen verbosity level (decoupled from `/clawcode-verbose`):
 *   - `off`     → "" (prose only; the hook emits no activity line).
 *   - `raw`     → the machinery line via {@link renderToolActivity}.
 *   - `natural` → one humanized phrase for the CURRENT (last visible) tool, e.g.
 *                 "🔍 Searching the web…". No tool names, no ×N, no joined list.
 * Returns "" when there is nothing user-meaningful to show.
 */
export function renderActivity(
  tools: readonly string[],
  style: ActivityStyle,
): string {
  if (style === "off") return "";
  if (style === "raw") return renderToolActivity(tools);
  const visible = tools
    .map(bareToolName)
    .filter((t) => !ACTIVITY_HIDDEN_TOOLS.has(t));
  const last = visible[visible.length - 1];
  if (!last) return "";
  return `${toolEmoji(last)} ${toolPhrase(last)}`;
}

/**
 * Phase 141 — matches a leading tool-activity marker line produced by
 * {@link renderToolActivity}: a sequence of `<emoji> <ToolName>[ ×N]` segments
 * joined by ` · `, anchored end-to-end. Anchoring to the FULL grammar (not just
 * a leading `<emoji> `) is deliberate — prose that merely opens with one of these
 * emojis (e.g. "🔍 I searched for X", "🧠 Recalling from memory…", "🔧 Fix-it
 * suggestion:") must NOT be mistaken for a marker line and stripped from the
 * stream. Tool-name token is `[^\s·]+` so it can't swallow the space-delimited
 * separator or a following prose word.
 */
const TOOL_ACTIVITY_EMOJI = "(?:🔍|🌐|📖|✏️|💻|🔎|🤖|🧵|🧠|🔧)";
const TOOL_ACTIVITY_PREFIX_RE = new RegExp(
  `^${TOOL_ACTIVITY_EMOJI} [^\\s·]+(?: ×\\d+)?` +
    `(?: · ${TOOL_ACTIVITY_EMOJI} [^\\s·]+(?: ×\\d+)?)*$`,
  "u",
);

/**
 * Phase 141 — strip the leading tool-activity marker line from a progress
 * frame's accumulated text (verbose-gating: tool uses are shown ONLY when the
 * channel is in verbose mode). Returns the prose after the `\n\n` separator, or
 * "" when the frame was markers-only, or the text unchanged when there is no
 * marker line. Format mirrors the hook: `"<activity>\n\n<prose>"` | `"<activity>"`
 * | `"<prose>"`.
 */
export function stripToolActivity(accumulated: string): string {
  const sep = accumulated.indexOf("\n\n");
  const head = sep >= 0 ? accumulated.slice(0, sep) : accumulated;
  if (TOOL_ACTIVITY_PREFIX_RE.test(head)) {
    return sep >= 0 ? accumulated.slice(sep + 2) : "";
  }
  return accumulated;
}

export function accumulateTurnText(transcript: string): string {
  // Delegates to the single turn-boundary parser (Phase 141 B) so there is no
  // parallel walk to drift out of sync (`feedback_silent_path_bifurcation`).
  return accumulateTurnProgress(transcript).text;
}
