/**
 * Synthetic 6-hour fin-client replay fixture builder.
 *
 * Pure code (no Node side effects). Two builders:
 *
 *   - `buildSyntheticReplay()` → frozen `ConversationTurn[]`. The
 *     final-text-only shape a `ConversationStore` produces — used by the
 *     byte-reduction / Tier-1 marker / SC-8 verbatim tests that operate on
 *     ConversationStore-shape turns. ~60% heartbeat probe noise, ~20%
 *     repeated tool calls, ~15% real work turns, ~5% failed-then-retried
 *     tool calls. Total ≥ 400 turns.
 *
 *   - `buildSyntheticSdkTranscript()` → frozen `SessionMessage[]`. The shape
 *     `getSessionMessages` returns — raw Anthropic content-block arrays
 *     carrying typed `tool_use` / `tool_result` blocks. Phase 999.75 Part A:
 *     drives the `readToolAwareTurns` → `toolAwareTurnsToText` →
 *     `buildTieredExtractor` path so the tiers fire on REAL tool blocks
 *     (the prior fixture fabricated `tool_use:` markers as turn text, which
 *     `ConversationStore` never carries — that "certified a no-op").
 *
 * Asserted properties of `buildSyntheticReplay` (used by seam-integration):
 *   - At least 400 turns.
 *   - Includes the `[125-01-active-state]` sentinel marker (Plan 01 wire).
 *   - Includes turns mentioning "AUM" and "$45M" (SC-8 verbatim patterns).
 *   - Includes turns mentioning SOUL.md / IDENTITY.md / daily-notes paths.
 */
import type { ConversationTurn } from "../../../../memory/compaction.js";
import type { SessionMessage } from "../../../sdk-types.js";

const OPERATOR_MSGS: readonly string[] = Object.freeze([
  "What's the status on the Client A term-sheet?",
  "Push the AUM update to the deck.",
  "Need the $45M close note by EOD.",
  "Loop me in when the lawyer responds.",
  "Confirm SOUL.md identity loaded.",
]);

const ASSISTANT_WORK: readonly string[] = Object.freeze([
  "Reviewed daily-notes/2026-05-14/client-a-sync.md and updated the term-sheet column.",
  "Posted the AUM update; lawyer copied on thread.",
  "Drafted the $45M close note; pending Client A approval.",
  "Lawyer responded: needs revised closing date.",
  "Reloaded SOUL.md + IDENTITY.md; persona intact.",
]);

export function buildSyntheticReplay(): readonly ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const start = new Date("2026-05-14T08:00:00Z").getTime();
  let i = 0;
  const ts = (): string => new Date(start + i++ * 45_000).toISOString();

  const PROBE_COUNT = 252;
  const REPEAT_GROUPS = 28;
  const REPEAT_REPS = 3;
  const WORK_COUNT = 63;
  const FAIL_TRIPLETS = 7;

  for (let p = 0; p < PROBE_COUNT; p++) {
    const role: "user" | "assistant" = p % 2 === 0 ? "user" : "assistant";
    const content =
      p % 3 === 0
        ? `[125-01-active-state] header tick ${p}`
        : p % 3 === 1
        ? `HEARTBEAT_OK probe id=${p}`
        : `--- ACTIVE STATE ---\nfield: value-${p}`;
    turns.push(Object.freeze({ timestamp: ts(), role, content }));
  }

  for (let r = 0; r < REPEAT_GROUPS; r++) {
    const argHash = `{"path":"file-${r}.ts"}`;
    for (let k = 0; k < REPEAT_REPS; k++) {
      turns.push(
        Object.freeze({
          timestamp: ts(),
          role: "assistant" as const,
          content: `tool_use: read_file args: ${argHash}`,
        }),
      );
    }
  }

  for (let w = 0; w < WORK_COUNT; w++) {
    const role: "user" | "assistant" = w % 2 === 0 ? "user" : "assistant";
    const content =
      role === "user"
        ? OPERATOR_MSGS[w % OPERATOR_MSGS.length]
        : ASSISTANT_WORK[w % ASSISTANT_WORK.length];
    turns.push(Object.freeze({ timestamp: ts(), role, content }));
  }

  for (let f = 0; f < FAIL_TRIPLETS; f++) {
    turns.push(
      Object.freeze({
        timestamp: ts(),
        role: "assistant" as const,
        content: "tool_result: fetch_url failed",
      }),
    );
    turns.push(
      Object.freeze({
        timestamp: ts(),
        role: "assistant" as const,
        content: `tool_use: fetch_url args: retry-${f}`,
      }),
    );
    turns.push(
      Object.freeze({
        timestamp: ts(),
        role: "assistant" as const,
        content: "tool_result: fetch_url ok",
      }),
    );
  }

  return Object.freeze(turns);
}

/** Wrap a content-block array as a `SessionMessage` (getSessionMessages shape). */
function sdkMsg(
  type: "user" | "assistant",
  blocks: readonly unknown[],
  idx: number,
): SessionMessage {
  return Object.freeze({
    type,
    uuid: `uuid-${idx}`,
    session_id: "fixture-session-7",
    message: Object.freeze({ role: type, content: Object.freeze(blocks) }),
    parent_tool_use_id: null,
  });
}

/**
 * Build a synthetic SDK JSONL transcript — the `SessionMessage[]` shape
 * `getSessionMessages` returns. Unlike `buildSyntheticReplay` (which
 * fabricates `tool_use:` strings as turn text), this carries REAL typed
 * `tool_use` / `tool_result` content blocks, so it exercises the
 * `readToolAwareTurns` converter end-to-end.
 *
 * Deliberately includes the two cases that prove the tiers are no longer
 * no-ops once routed through the converter:
 *   - A `tool_use` block whose `input` stringifies to a > 4 KB base64-style
 *     payload — Tier 3 must collapse it to a `[tier3]` stub.
 *   - A failed-then-retried `tool_result` pair (`is_error:true` followed by
 *     an `ok` result for the same tool) — Tier 4 must drop the failed one.
 */
export function buildSyntheticSdkTranscript(): readonly SessionMessage[] {
  const out: SessionMessage[] = [];
  let i = 0;

  // 1. Plain operator + assistant text turns (real work — survive).
  out.push(
    sdkMsg("user", [{ type: "text", text: OPERATOR_MSGS[0] }], i++),
  );
  out.push(
    sdkMsg("assistant", [{ type: "text", text: ASSISTANT_WORK[0] }], i++),
  );

  // 2. A tool_use carrying a bulky base64-style payload. JSON.stringify of
  //    `input` lands the content well past the 4 KB Tier 3 threshold.
  const bigBase64 =
    "TWFuIGlzIGRpc3Rpbmd1aXNoZWQsIG5vdCBvbmx5IGJ5IGhpcyByZWFzb24=".repeat(
      120,
    );
  out.push(
    sdkMsg(
      "assistant",
      [
        {
          type: "tool_use",
          id: "tu-pdf",
          name: "read_pdf",
          input: { path: "deck.pdf", data: bigBase64 },
        },
      ],
      i++,
    ),
  );
  out.push(
    sdkMsg(
      "user",
      [
        {
          type: "tool_result",
          tool_use_id: "tu-pdf",
          content: "parsed 14 pages",
        },
      ],
      i++,
    ),
  );

  // 3. A failed-then-retried tool_result pair for the SAME tool — Tier 4
  //    drops the failed result when the retry succeeds within 4 turns.
  out.push(
    sdkMsg(
      "assistant",
      [{ type: "tool_use", id: "tu-f1", name: "fetch_url", input: { url: "u" } }],
      i++,
    ),
  );
  out.push(
    sdkMsg(
      "user",
      [
        {
          type: "tool_result",
          tool_use_id: "tu-f1",
          is_error: true,
          content: "connection refused",
        },
      ],
      i++,
    ),
  );
  out.push(
    sdkMsg(
      "assistant",
      [{ type: "tool_use", id: "tu-f2", name: "fetch_url", input: { url: "u" } }],
      i++,
    ),
  );
  out.push(
    sdkMsg(
      "user",
      [{ type: "tool_result", tool_use_id: "tu-f2", content: "200 OK body" }],
      i++,
    ),
  );

  // 4. Closing real-work turn.
  out.push(
    sdkMsg("assistant", [{ type: "text", text: ASSISTANT_WORK[2] }], i++),
  );

  return Object.freeze(out);
}
