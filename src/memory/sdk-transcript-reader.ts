/**
 * Phase 999.75 Part A (A2/A3) — tool-aware compaction transcript reader.
 *
 * The compaction tier extractors (`tier3-payload-truncator`, `tier4-drop`)
 * regex for `tool_use:` / `tool_result:` markers — but compaction historically
 * fed them final-text-only `ConversationStore` turns, where those markers
 * never appear. The tiers were silent no-ops: their green test suite only
 * passed because the fixtures fabricated the markers.
 *
 * Tool blocks live ONLY in the SDK's own JSONL transcript. This module reads
 * that transcript via `getSessionMessages` and flattens the content blocks
 * into `ToolOutputTurn[]` carrying the exact `tool_use:` / `tool_result:` text
 * formats the tier regexes expect — so the tiers actually fire.
 *
 * **Fail-open contract.** `readToolAwareTurns` returns `null` on ANY failure
 * (the underlying call throws, the transcript is empty, or no usable content
 * blocks are produced). A malformed *individual* block is skipped + logged,
 * keeping the rest. The daemon caller treats `null` as "fall back to the
 * existing ConversationStore extractor input" — compaction never fails
 * because the tool-aware path failed.
 *
 * Pure-ish: no I/O of its own beyond the injected `getSessionMessages`
 * dependency; logging is the only side-effect.
 *
 * See:
 *   - `src/memory/tool-output-prune.ts` — the `ToolOutputTurn` shape produced.
 *   - `src/manager/compact-extractors/tier3-payload-truncator.ts:25-26` —
 *     `tool_use:` / `tool_result:` name regexes the formats must satisfy.
 *   - `src/manager/compact-extractors/tier4-drop.ts:25-27` — the `args:` +
 *     `ok|error` token regexes.
 *   - `src/manager/compact-extractors/index.ts:37-66` —
 *     `turnsFromConcatenatedText`, the round-trip target for
 *     `toolAwareTurnsToText`.
 */

import type {
  GetSessionMessagesOptions,
  SessionMessage,
} from "../manager/sdk-types.js";
import type { ToolOutputTurn } from "./tool-output-prune.js";

/**
 * Minimal logger shape — Pino-compatible. Only `warn` is used (malformed
 * blocks / fail-open sentinels); kept narrow so callers can inject any
 * structured logger.
 */
export interface SdkTranscriptReaderLog {
  readonly warn: (obj: unknown, msg?: string) => void;
}

/**
 * Dependencies for `readToolAwareTurns`. All injected so the reader is
 * testable without a live SDK or filesystem.
 */
export interface ReadToolAwareTurnsDeps {
  /** Session UUID whose JSONL transcript is read. */
  readonly sessionId: string;
  /**
   * Project directory the session file lives under (same semantics as
   * `listSessions({ dir })`). Threaded from the agent's resolved SDK cwd
   * (`config.gsd?.projectDir ?? config.workspace`). May be omitted — the
   * SDK then searches every project directory.
   */
  readonly dir?: string;
  /**
   * The SDK module's `getSessionMessages`. Production wires the real
   * `LlmRuntimeSdkModule` method; tests inject a fake.
   */
  readonly getSessionMessages: (
    sessionId: string,
    options?: GetSessionMessagesOptions,
  ) => Promise<readonly SessionMessage[]>;
  /** Agent name — for structured log context only. */
  readonly agentName: string;
  /** Structured logger for malformed-block + fail-open sentinels. */
  readonly log: SdkTranscriptReaderLog;
}

/**
 * A single Anthropic content block. Typed loosely — `SessionMessage.message`
 * is `unknown`, so every field is validated at runtime before use.
 */
type ContentBlock = Readonly<Record<string, unknown>>;

/** Narrow: is `v` a plain non-null object? */
function isObject(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Narrow: extract the `content` block array from a raw SDK `message`.
 *
 * Exported (Phase 999.82) so the `clawcode-progress-hook` reuses this ONE block
 * extractor when tailing the live transcript — no parallel parser
 * (`feedback_silent_path_bifurcation`). Pure: validates the raw shape and
 * returns frozen blocks; a string `content` becomes a single text block.
 */
export function extractContentBlocks(message: unknown): readonly ContentBlock[] | null {
  if (!isObject(message)) return null;
  const content = message.content;
  // The Anthropic message `content` may be a string (rare, plain-text turn)
  // or an array of typed blocks. A string carries no tool blocks — the
  // caller treats it as a single text block via the message-level fallback.
  if (typeof content === "string") {
    return [Object.freeze({ type: "text", text: content })];
  }
  if (!Array.isArray(content)) return null;
  return content.filter(isObject);
}

/**
 * Render a `tool_result` body to a single-line string. The SDK delivers
 * `tool_result.content` either as a string OR as an array of
 * `{type:"text", text}` blocks — both are flattened here.
 */
function renderToolResultBody(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const parts: string[] = [];
    for (const part of raw) {
      if (isObject(part) && typeof part.text === "string") {
        parts.push(part.text);
      }
    }
    return parts.join(" ");
  }
  return "";
}

/**
 * First pass — build a `tool_use_id` → tool-name map from every `tool_use`
 * block across the transcript. Lets the second pass resolve a `tool_result`'s
 * tool name even when blocks arrive out of order.
 */
function buildToolUseIdNameMap(
  messages: readonly SessionMessage[],
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    const blocks = extractContentBlocks(msg.message);
    if (!blocks) continue;
    for (const block of blocks) {
      if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      ) {
        map.set(block.id, block.name);
      }
    }
  }
  return map;
}

/**
 * Convert one content block into a `ToolOutputTurn`, or `null` when the block
 * is not convertible (unknown type / malformed). The `null` is the caller's
 * skip signal.
 *
 * Format contract (must satisfy the tier regexes):
 *   - `text`        → `{role, content: <text>, isToolOutput:false}`
 *   - `tool_use`    → `{role:"assistant",
 *                       content:"tool_use: <name> args: <JSON.stringify(input)>",
 *                       toolName, isToolOutput:false}`
 *   - `tool_result` → `{role:"user",
 *                       content:"tool_result: <toolName> <ok|error> <body>",
 *                       toolName, isToolOutput:true}`
 */
function blockToTurn(
  block: ContentBlock,
  msgRole: "user" | "assistant",
  toolNameById: ReadonlyMap<string, string>,
): ToolOutputTurn | null {
  const type = block.type;

  if (type === "text") {
    if (typeof block.text !== "string") return null;
    return Object.freeze({
      role: msgRole,
      content: block.text,
      timestamp: "",
      isToolOutput: false,
    });
  }

  if (type === "tool_use") {
    if (typeof block.name !== "string") return null;
    // `input` is the tool's argument object — stringify so tier4's
    // `args:\s*(\{...\}|...)` regex can dedup repeated identical calls.
    let argsJson: string;
    try {
      argsJson = JSON.stringify(block.input ?? {});
    } catch {
      // Circular / unserialisable input — skip the args, keep the marker.
      argsJson = "{}";
    }
    return Object.freeze({
      role: "assistant",
      content: `tool_use: ${block.name} args: ${argsJson}`,
      timestamp: "",
      toolName: block.name,
      isToolOutput: false,
    });
  }

  if (type === "tool_result") {
    const id = block.tool_use_id;
    if (typeof id !== "string") return null;
    // Resolve the tool name from the first-pass map; fall back to the id
    // itself so the marker is still tier-parsable (the regex accepts any
    // [A-Za-z0-9_.-]+ token).
    const toolName = toolNameById.get(id) ?? id;
    // `is_error === true` → "error" (matches tier4's err(?:or)? token);
    // anything else → "ok".
    const status = block.is_error === true ? "error" : "ok";
    const body = renderToolResultBody(block.content);
    return Object.freeze({
      role: "user",
      content: `tool_result: ${toolName} ${status} ${body}`,
      timestamp: "",
      toolName,
      isToolOutput: true,
    });
  }

  // Unknown block type (thinking, image, server_tool_use, …) — not a turn
  // the compaction tiers care about; skip it.
  return null;
}

/**
 * Read the real SDK JSONL transcript for `sessionId` and flatten its content
 * blocks into `ToolOutputTurn[]` carrying tool markers verbatim.
 *
 * Fail-open: returns `null` when the transcript is unavailable, empty, or
 * produces no usable turns. A malformed *individual* block is skipped (logged)
 * — the rest of the transcript still converts.
 */
export async function readToolAwareTurns(
  deps: ReadToolAwareTurnsDeps,
): Promise<readonly ToolOutputTurn[] | null> {
  let messages: readonly SessionMessage[];
  try {
    messages = await deps.getSessionMessages(deps.sessionId, {
      dir: deps.dir,
    });
  } catch (err) {
    deps.log.warn(
      {
        agent: deps.agentName,
        sessionId: deps.sessionId,
        sentinel: "999.75-sdk-transcript-reader",
        error: (err as Error).message,
      },
      "[999.75-sdk-transcript-reader] getSessionMessages threw — fail-open to ConversationStore",
    );
    return null;
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    // Empty transcript (session-not-found per the SDK contract, or the
    // Codex stub) — nothing to convert; fail open.
    return null;
  }

  const toolNameById = buildToolUseIdNameMap(messages);

  const turns: ToolOutputTurn[] = [];
  let skipped = 0;
  for (const msg of messages) {
    // Compaction operates over user|assistant turns only — system messages
    // (compact boundaries, notices) carry no tool blocks of interest.
    if (msg.type !== "user" && msg.type !== "assistant") continue;
    const blocks = extractContentBlocks(msg.message);
    if (!blocks) {
      skipped++;
      continue;
    }
    for (const block of blocks) {
      const turn = blockToTurn(block, msg.type, toolNameById);
      if (turn === null) {
        skipped++;
        continue;
      }
      turns.push(turn);
    }
  }

  if (skipped > 0) {
    deps.log.warn(
      {
        agent: deps.agentName,
        sessionId: deps.sessionId,
        sentinel: "999.75-sdk-transcript-reader",
        skippedBlocks: skipped,
        convertedTurns: turns.length,
      },
      "[999.75-sdk-transcript-reader] skipped malformed/unconvertible blocks",
    );
  }

  if (turns.length === 0) {
    // The transcript had messages but none produced a usable turn — treat
    // as a fail-open so the daemon falls back rather than feeding the
    // extractor an empty payload.
    return null;
  }

  return Object.freeze(turns);
}

/**
 * Render tool-aware turns to the `[role]: content` line format the extractor
 * seam consumes — identical to `compaction.ts:147-149`. Tool markers survive
 * the round-trip through `turnsFromConcatenatedText`
 * (`compact-extractors/index.ts:37-66`, which handles multi-line continuation
 * lines), so a `tool_use:` / `tool_result:` marker emitted here is parsed
 * back out by the tier extractors unchanged.
 */
export function toolAwareTurnsToText(
  turns: readonly ToolOutputTurn[],
): string {
  return turns.map((t) => `[${t.role}]: ${t.content}`).join("\n");
}
