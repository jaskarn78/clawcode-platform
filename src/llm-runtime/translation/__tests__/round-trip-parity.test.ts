/**
 * Phase 137 Plan 02 T-03 — round-trip parity test (SC3 acceptance).
 *
 * For every fixture tool in `fixtures/tools.ts`:
 *   1. tool_use round-trip — `translateToolUseFromOpenAI(
 *      translateToolUseToOpenAI(block))` recovers the original
 *      block exactly.
 *   2. tool definition schema preservation —
 *      `translateToolsToOpenAI([tool])[0].function.parameters`
 *      deep-equals `tool.input_schema` (the modulo `cache_control`
 *      drop is at the envelope, not the schema).
 *   3. tool_result round-trip — `translateToolResultFromOpenAI(
 *      translateToolResultToOpenAI(block))` recovers the original
 *      block modulo the documented string-shape collapse.
 *   4. Idempotence — feeding the recovered tool_use back through
 *      `translateToolUseToOpenAI` produces the same OpenAI wire
 *      shape as the first pass.
 *
 * Asymmetric losses are explicit (referencing CONTEXT D2 +
 * researcher_todo #5):
 *   - `cache_control` (Anthropic-only) dropped on tool defs.
 *   - tool_result `content: Array<{type:"text",text}>` collapses to
 *     a single string; the recovered block has string-shape only.
 *   - `is_error: true` round-trips via the `IS_ERROR_PREFIX`
 *     sentinel.
 * Tests assert THESE are the only losses — any other drift fails.
 */

import { describe, expect, it } from "vitest";

import {
  translateToolResultFromOpenAI,
  translateToolResultToOpenAI,
  translateToolsToOpenAI,
  translateToolUseFromOpenAI,
  translateToolUseToOpenAI,
} from "../anthropic-openai.js";
import type { AnthropicToolResultBlock } from "../types.js";

import { TOOL_FIXTURES } from "./fixtures/tools.js";

describe("Phase 137 Plan 02 T-03 — round-trip parity (SC3 acceptance)", () => {
  // Sanity: every fixture used by the iteration below.
  it("fixture file exports ≥5 representative tools", () => {
    expect(TOOL_FIXTURES.length).toBeGreaterThanOrEqual(5);
  });

  for (const fixture of TOOL_FIXTURES) {
    describe(`fixture: ${fixture.label}`, () => {
      it("tool_use round-trip preserves the original block exactly", () => {
        const recovered = translateToolUseFromOpenAI(
          translateToolUseToOpenAI(fixture.toolUse),
        );
        expect(recovered).toEqual(fixture.toolUse);
      });

      it("tool definition schema is preserved (parameters === input_schema)", () => {
        const out = translateToolsToOpenAI([fixture.tool]);
        expect(out).toHaveLength(1);
        const translated = out[0]!;
        expect(translated.function.parameters).toEqual(fixture.tool.input_schema);
        expect(translated.function.name).toBe(fixture.tool.name);
        expect(translated.function.description).toBe(fixture.tool.description);
      });

      it("cache_control is dropped on the OpenAI side (documented loss)", () => {
        // Per CONTEXT D2 — no OpenAI equivalent at the tool-def layer.
        const out = translateToolsToOpenAI([fixture.tool]);
        // Whether the source had cache_control or not, the OpenAI
        // envelope NEVER carries it.
        expect(JSON.stringify(out[0])).not.toContain("cache_control");
      });

      it("tool_result round-trip preserves string-content blocks", () => {
        // Construct a string-content variant of the fixture result
        // (independent of the fixture's own shape).
        const original: AnthropicToolResultBlock = {
          type: "tool_result",
          tool_use_id: fixture.toolUse.id,
          content: typeof fixture.toolResult.content === "string"
            ? fixture.toolResult.content
            : fixture.toolResult.content.map((b) => b.text).join("\n"),
        };
        const recovered = translateToolResultFromOpenAI(
          translateToolResultToOpenAI(original),
        );
        expect(recovered).toEqual(original);
      });

      it("tool_result round-trip preserves is_error: true via IS_ERROR_PREFIX sentinel", () => {
        const errBlock: AnthropicToolResultBlock = {
          type: "tool_result",
          tool_use_id: fixture.toolUse.id,
          content: "fatal: simulated failure",
          is_error: true,
        };
        const recovered = translateToolResultFromOpenAI(
          translateToolResultToOpenAI(errBlock),
        );
        expect(recovered).toEqual(errBlock);
      });

      it("idempotent: round-tripped tool_use re-translates to the same OpenAI wire shape", () => {
        const firstPass = translateToolUseToOpenAI(fixture.toolUse);
        const recovered = translateToolUseFromOpenAI(firstPass);
        const secondPass = translateToolUseToOpenAI(recovered);
        expect(secondPass).toEqual(firstPass);
      });
    });
  }

  // -------------------------------------------------------------
  // Documented asymmetric loss: array-content tool_result
  // collapses to string-shape only. This test pins the documented
  // behaviour — if a future change recovers the array shape, this
  // test must be updated alongside the docs.
  // -------------------------------------------------------------
  it("tool_result array→string collapse is one-way (documented loss per researcher_todo #5)", () => {
    const original: AnthropicToolResultBlock = {
      type: "tool_result",
      tool_use_id: "tu_array_001",
      content: [
        { type: "text", text: "line 1" },
        { type: "text", text: "line 2" },
      ],
    };
    const recovered = translateToolResultFromOpenAI(
      translateToolResultToOpenAI(original),
    );
    // Recovered content is the joined STRING, not the original array.
    expect(recovered.content).toBe("line 1\nline 2");
    // String-shape content is loss-less under a SECOND round-trip,
    // proving the collapse is a fixed point (not progressive drift).
    const recovered2 = translateToolResultFromOpenAI(
      translateToolResultToOpenAI(recovered),
    );
    expect(recovered2).toEqual(recovered);
  });
});
