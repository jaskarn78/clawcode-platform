/**
 * Phase 137 Plan 02 T-01 — static-grep regression for OpenAI
 * field-name constants.
 *
 * Asserts:
 *   (a) `OPENAI_FIELD_NAMES` is exported from `constants.ts` and
 *       contains every name the translation layer needs.
 *   (b) Each value in `OPENAI_FIELD_NAMES` appears at least once
 *       inside `constants.ts` itself (the literal source-of-
 *       truth).
 *   (c) `anthropic-openai.ts` does NOT contain bare quoted
 *       occurrences of any OpenAI field-name value. Translation
 *       code MUST reference via `OPENAI_FIELD_NAMES.X`. If this
 *       fails, someone hard-coded a string literal that would
 *       drift on an OpenAI-Version bump (researcher_todo #1).
 *
 * `anthropic-openai.ts` may not exist yet (T-01 lands before T-02).
 * In that case (c) is vacuously satisfied — we do not synthesize a
 * failure where there is no source file to scan.
 *
 * See:
 *   - src/llm-runtime/translation/constants.ts
 *   - src/llm-runtime/__tests__/static-grep-no-direct-sdk.test.ts
 *     (Phase 136 precedent — same shape)
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

import { OPENAI_FIELD_NAMES } from "../constants.js";

const CONSTANTS_PATH = resolve(
  process.cwd(),
  "src/llm-runtime/translation/constants.ts",
);
const TRANSLATION_PATH = resolve(
  process.cwd(),
  "src/llm-runtime/translation/anthropic-openai.ts",
);

/**
 * Strip JS/TS line and block comments so the bare-string scan
 * doesn't trip on JSDoc / inline rationale referencing the field
 * name. Mirrors the Phase 136 static-grep-no-direct-sdk strategy.
 */
function stripComments(src: string): string {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    m
      .split("")
      .map((c) => (c === "\n" ? "\n" : " "))
      .join(""),
  );
  out = out.replace(/\/\/[^\n]*/g, "");
  return out;
}

describe("Phase 137 Plan 02 T-01 — OPENAI_FIELD_NAMES constant discipline", () => {
  it("exports OPENAI_FIELD_NAMES with ≥9 field-name entries", () => {
    expect(typeof OPENAI_FIELD_NAMES).toBe("object");
    const keys = Object.keys(OPENAI_FIELD_NAMES);
    expect(keys.length).toBeGreaterThanOrEqual(9);
  });

  it("constants.ts file exists and exports OPENAI_FIELD_NAMES (sanity)", () => {
    expect(existsSync(CONSTANTS_PATH)).toBe(true);
    const content = readFileSync(CONSTANTS_PATH, "utf-8");
    expect(content).toContain("OPENAI_FIELD_NAMES");
    // Each value MUST appear in the file's source (it's the
    // single source of truth — defining a field name without
    // it appearing literally is a typo).
    for (const value of Object.values(OPENAI_FIELD_NAMES)) {
      expect(
        content,
        `OPENAI_FIELD_NAMES value "${value}" missing from constants.ts source`,
      ).toContain(`"${value}"`);
    }
  });

  it("anthropic-openai.ts (if present) contains zero bare OpenAI field-name string literals", () => {
    // Vacuous-pass when T-02 hasn't landed yet.
    if (!existsSync(TRANSLATION_PATH)) {
      // Sanity log only; not an assertion failure.
      return;
    }
    const raw = readFileSync(TRANSLATION_PATH, "utf-8");
    const stripped = stripComments(raw);

    const offenders: Array<{ value: string; line: number; text: string }> = [];
    const lines = stripped.split("\n");
    for (const [name, value] of Object.entries(OPENAI_FIELD_NAMES)) {
      // Skip the "name" entry — `name` literally appears as a
      // property key in OpenAI's nested function shape AND in
      // schema property names, plus it's the most generic word.
      // The OPENAI_FIELD_NAMES.NAME constant exists for cases
      // where we EMIT the field key; bare `"name"` strings are
      // not necessarily a drift risk for that one entry.
      //
      // Apply this carve-out narrowly: only NAME. All other
      // field names (tool_calls, tool_call_id, role, etc.) are
      // distinctive enough that any bare occurrence IS drift.
      if (name === "NAME") continue;
      // ASSISTANT_ROLE + USER_ROLE — `"assistant"` / `"user"` are
      // also broad enough to appear in test fixtures, error
      // strings, or type narrowing literals. Carve them out for
      // now; the wire-impactful ones (tool_calls, tool_call_id,
      // role, content, arguments, parameters) remain enforced.
      if (name === "ASSISTANT_ROLE" || name === "USER_ROLE") continue;
      // DESCRIPTION is similarly broad (appears in JSDoc, tool
      // descriptions, fixture text). Carve out.
      if (name === "DESCRIPTION") continue;

      const pattern = new RegExp(`["']${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`, "g");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (pattern.test(line)) {
          offenders.push({ value, line: i + 1, text: line.trim() });
        }
      }
    }

    if (offenders.length > 0) {
      const formatted = offenders
        .map((o) => `  - line ${o.line}: bare "${o.value}" — ${o.text}`)
        .join("\n");
      throw new Error(
        `Bare OpenAI field-name string literals found in anthropic-openai.ts:\n${formatted}\n\n` +
          `Fix: replace each bare literal with OPENAI_FIELD_NAMES.<KEY> ` +
          `(see src/llm-runtime/translation/constants.ts).`,
      );
    }
    expect(offenders).toEqual([]);
  });
});
