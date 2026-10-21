/**
 * Phase 94 Plan 04 — D-06 honest ToolCallError schema.
 *
 * Pure module. NO I/O imports, NO clock imports, NO SDK imports, NO logger.
 * Static-grep regression pins enforce these invariants (see plan rules
 * section). No fs imports, no SDK imports, no env access, no clock
 * construction.
 *
 * When a tool that PASSED the capability probe (Plan 94-01) still fails
 * mid-turn — transient network blip, auth token expiry race, quota burst,
 * permission revocation — the executor wraps the failure into a structured
 * `ToolCallError` discriminated-shape object the LLM receives in the
 * tool-result slot. The LLM then adapts naturally: tries an alternative
 * agent, asks the user to refresh credentials, waits for the quota window,
 * etc. Without this wrap, the LLM either silently retries the same bad
 * call or surfaces a raw exception to the user.
 *
 * 5-value ErrorClass enum LOCKED at: transient | auth | quota | permission | unknown.
 * Adding a 6th value cascades through Plans 94-05 (renderer) + 94-07 (display)
 * and requires an explicit STATE.md decision.
 *
 * Verbatim-message pass-through (Phase 85 TOOL-04 inheritance):
 *   The `message` field carries `err.message` straight through. No wrapping,
 *   no truncation, no rewriting. Operators see what the LLM sees.
 *
 * Classification is REGEX-BASED, deterministic. No LLM judgment in the
 * wrapper itself. Tests pin every regex match → class transition.
 */

/**
 * D-06 5-value ErrorClass union. The contract Plans 94-05/07 depend on.
 */
export type ErrorClass =
  | "transient"
  | "auth"
  | "quota"
  | "permission"
  | "unknown";

/**
 * D-06 ToolCallError shape. JSON-serializable; survives the SDK
 * tool-result-slot round-trip; readonly fields enforced via TypeScript +
 * Object.freeze on the wrapper output.
 */
export interface ToolCallError {
  /** Discriminator literal — locked. Allows future expansion of the LLM
   *  tool-result variant union without breaking existing consumers. */
  readonly kind: "ToolCallError";
  /** The tool name as advertised to the LLM (e.g. "browser_snapshot"). */
  readonly tool: string;
  /** D-06 5-value enum classification. */
  readonly errorClass: ErrorClass;
  /** Verbatim from MCP/source — Phase 85 TOOL-04 pattern. */
  readonly message: string;
  /** Operator-actionable hint, populated when suggestionFor returns one. */
  readonly suggestion?: string;
  /** Healthy agent names that could substitute (D-07 cross-agent suggestion data). */
  readonly alternatives?: readonly string[];
}

/**
 * Classification regexes. Order matters in `classifyToolError`:
 *   auth/quota/permission are checked BEFORE transient because auth/quota/
 *   permission may carry transient indicators (e.g. "401 timeout") and the
 *   more specific class wins.
 *
 * Word-boundary anchors keep tokens like "401" / "429" / "403" from
 * matching incidental occurrences in body text (e.g. "version 401").
 */
const TRANSIENT_RE = /(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network|timeout|unreachable)/i;
const AUTH_RE = /\b(401|unauthorized|invalid[_ ]?key|expired|authentication)\b/i;
const QUOTA_RE = /\b(429|rate[_ ]?limit|quota|too many requests)\b/i;
const PERMISSION_RE = /\b(403|forbidden|permission|insufficient)\b/i;

/**
 * Pure: classify an error string or Error instance into one of the 5
 * ErrorClass values. Empty / null-ish messages classify as "unknown" —
 * operators inspect the verbatim text to learn more.
 *
 * Order of precedence (matches the test pins):
 *   1. auth          (401 / unauthorized / invalid_key / expired / authentication)
 *   2. quota         (429 / rate_limit / quota / too many requests)
 *   3. permission    (403 / forbidden / permission / insufficient)
 *   4. transient     (ECONNRESET / ETIMEDOUT / socket hang up / network / timeout)
 *   5. unknown       (fallthrough — verbatim message inspected by operator)
 */
export function classifyToolError(error: string | Error): ErrorClass {
  const msg = typeof error === "string" ? error : error?.message ?? "";
  if (msg === "") return "unknown";
  if (AUTH_RE.test(msg)) return "auth";
  if (QUOTA_RE.test(msg)) return "quota";
  if (PERMISSION_RE.test(msg)) return "permission";
  if (TRANSIENT_RE.test(msg)) return "transient";
  return "unknown";
}

/**
 * DI surface for `wrapMcpToolError`. All optional — the minimum-viable
 * wrap requires only `tool`. Production wires `findAlternatives` from
 * `findAlternativeAgents(toolName, mcpStateProvider)`; tests pass synthetic
 * functions or omit them entirely.
 */
export interface WrapToolErrorContext {
  /** Tool name for the `tool` field on the wrapped output. */
  readonly tool: string;
  /** Optional metadata; not surfaced into ToolCallError but useful for caller-side logging. */
  readonly mcpServerName?: string;
  /** Pure-function callback returning healthy alternative agents (D-07). */
  readonly findAlternatives?: () => readonly string[];
  /** Per-class suggestion injection — daemon edge wires this from a registry. */
  readonly suggestionFor?: (errorClass: ErrorClass) => string | undefined;
}

/**
 * Pure: wrap a runtime tool-call rejection into a frozen `ToolCallError`.
 *
 * Side-effect-free. Returns a frozen object so consumers cannot mutate
 * the structure (CLAUDE.md immutability rule). The `alternatives` array,
 * when populated, is also frozen.
 *
 * Empty `alternatives` array is omitted entirely (cleaner JSON for the
 * LLM tool-result slot — the LLM doesn't need to read an empty list to
 * know there are no alternatives).
 */
export function wrapMcpToolError(
  rawError: string | Error,
  context: WrapToolErrorContext,
): ToolCallError {
  const message =
    typeof rawError === "string"
      ? rawError
      : rawError?.message ?? String(rawError);
  const errorClass = classifyToolError(rawError);
  const alternatives = context.findAlternatives?.();
  const suggestion = context.suggestionFor?.(errorClass);

  // Build the object with strictly the populated fields. `undefined` would
  // serialize as missing keys anyway, but explicit omission keeps the JSON
  // tighter and the test for `alternatives === undefined` passes both
  // shape-wise (no key) and value-wise.
  const out: ToolCallError = {
    kind: "ToolCallError" as const,
    tool: context.tool,
    errorClass,
    message,
    ...(suggestion !== undefined && suggestion !== "" ? { suggestion } : {}),
    ...(alternatives !== undefined && alternatives.length > 0
      ? { alternatives: Object.freeze([...alternatives]) }
      : {}),
  };

  return Object.freeze(out);
}
