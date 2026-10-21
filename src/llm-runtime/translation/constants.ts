/**
 * Phase 137 Plan 02 — OpenAI field-name constants.
 *
 * Centralised string-literal source-of-truth for the OpenAI
 * function-calling wire format. Every reference to an OpenAI field
 * name in `anthropic-openai.ts` MUST route through
 * `OPENAI_FIELD_NAMES`, never a bare quoted literal. A static-grep
 * regression in `__tests__/static-grep-translation-constants.test.ts`
 * enforces the discipline.
 *
 * Why: when OpenAI bumps an API version (researcher_todo #1 / #2 —
 * Chat Completions → Responses API), the rename surface is exactly
 * this file, not a fanned-out string-replace across the translation
 * implementation.
 *
 * Note: `OPENAI_API_VERSION` is intentionally NOT defined here.
 * Plan 02 does not pin a wire version (per CONTEXT D2 + the
 * <objective> block — that's Plan 03's responsibility once the
 * Codex CLI's API surface is verified). If a version constant
 * surfaces later it goes in a separate `api-version.ts` so this
 * file stays a flat name-table.
 */

export const OPENAI_FIELD_NAMES = Object.freeze({
  FUNCTION_TYPE: "function",
  TOOL_ROLE: "tool",
  ASSISTANT_ROLE: "assistant",
  USER_ROLE: "user",
  TOOL_CALLS: "tool_calls",
  TOOL_CALL_ID: "tool_call_id",
  ROLE: "role",
  CONTENT: "content",
  ARGUMENTS: "arguments",
  NAME: "name",
  PARAMETERS: "parameters",
  DESCRIPTION: "description",
} as const);

/** Type of any valid value inside `OPENAI_FIELD_NAMES`. */
export type OpenAiFieldName =
  (typeof OPENAI_FIELD_NAMES)[keyof typeof OPENAI_FIELD_NAMES];

/**
 * Translation-internal sentinel for marking an Anthropic
 * `tool_result.is_error: true` payload on the OpenAI side, which
 * has no native `is_error` field. The reverse translation strips
 * this prefix and re-emits `is_error: true`. Documented asymmetric
 * encoding — round-trips cleanly only when the original tool
 * content did NOT itself begin with this exact string.
 */
export const IS_ERROR_PREFIX = "[error] ";
