/**
 * Phase 125 Plan 04 — Tier 3 payload truncator.
 *
 * Per BACKLOG-SOURCE §"TIER 3 — PROSE SUMMARY":
 *   Long tool_use payloads (base64 PDFs, large MCP responses) →
 *   "tool X ran, returned a Y of Z bytes" (drop the bytes entirely)
 *
 * This is a pure function. No I/O, no logging side-effects (the caller in
 * `index.ts` owns sentinel emission). The detection is structural — we
 * scan content for tool_use / tool_result markers and replace bulky
 * payloads with a deterministic stub.
 *
 * Thresholds (BACKLOG-SOURCE Tier 3 spec):
 *   - tool_use content > 4 KB → truncate (base64 PDFs land here)
 *   - tool_result content > 8 KB → truncate (large MCP responses)
 *
 * Untouched content flows through unchanged; small payloads survive.
 */

import type { ConversationTurn } from "../../memory/compaction.js";

export const TIER3_TOOL_USE_THRESHOLD = 4_096;
export const TIER3_TOOL_RESULT_THRESHOLD = 8_192;

const TOOL_USE_NAME_RE = /tool_use:\s*([A-Za-z0-9_.\-]+)/;
const TOOL_RESULT_NAME_RE = /tool_result:\s*([A-Za-z0-9_.\-]+)/;

const BASE64_HINT_RE = /[A-Za-z0-9+/]{200,}={0,2}/;
const JSON_HINT_RE = /^\s*[{[]/;

type PayloadKind = "binary" | "json" | "text";

function inferKind(content: string): PayloadKind {
  if (BASE64_HINT_RE.test(content)) return "binary";
  if (JSON_HINT_RE.test(content)) return "json";
  return "text";
}

function buildStub(
  marker: "tool_use" | "tool_result",
  name: string,
  kind: PayloadKind,
  bytes: number,
): string {
  return `[tier3] ${marker}: ${name} ran, returned a ${kind} payload of ${bytes} bytes`;
}

function truncateOne(turn: ConversationTurn): ConversationTurn {
  const content = turn.content;
  const bytes = Buffer.byteLength(content, "utf8");

  const useMatch = TOOL_USE_NAME_RE.exec(content);
  if (useMatch && bytes > TIER3_TOOL_USE_THRESHOLD) {
    return Object.freeze({
      timestamp: turn.timestamp,
      role: turn.role,
      content: buildStub("tool_use", useMatch[1], inferKind(content), bytes),
    });
  }

  const resultMatch = TOOL_RESULT_NAME_RE.exec(content);
  if (resultMatch && bytes > TIER3_TOOL_RESULT_THRESHOLD) {
    return Object.freeze({
      timestamp: turn.timestamp,
      role: turn.role,
      content: buildStub(
        "tool_result",
        resultMatch[1],
        inferKind(content),
        bytes,
      ),
    });
  }

  return turn;
}

/**
 * Replace bulky tool_use / tool_result payloads with deterministic stubs.
 * Pure function — returns a new frozen array; never mutates input.
 */
export function truncateLargePayloads(
  turns: readonly ConversationTurn[],
): readonly ConversationTurn[] {
  if (turns.length === 0) return turns;
  const out = turns.map(truncateOne);
  return Object.freeze(out);
}
