import type { McpServerSchemaConfig } from "../config/schema.js";
import type { McpServerState } from "../mcp/readiness.js";

/**
 * Phase 85 Plan 02 — pure renderer for the MCP section of the system prompt.
 *
 * Phase 94 Plan 02 TOOL-03 — this renderer DOES NOT filter. The server
 * list passed in via `input.servers` has ALREADY been filtered upstream
 * in `session-config.ts` (the single-source-of-truth call site). This
 * renderer's job is to render whatever it is given. The filter happens
 * UPSTREAM so the LLM stable prefix never names a degraded/failed/
 * reconnecting/unknown server. Operator-truth (full server list
 * including degraded) is exposed via the `/clawcode-tools` slash
 * command + `clawcode mcp-status` CLI (Phase 85 Plan 03), NOT by
 * re-injecting the unfiltered list here.
 *
 * Emits, in order:
 *   1. A `## MCP Tools (pre-authenticated)` heading
 *   2. The {@link MCP_PREAUTH_STATEMENT} (TOOL-02)
 *   3. A live per-server status table sourced from `stateByName`
 *   4. The {@link MCP_VERBATIM_ERROR_RULE} (TOOL-05)
 *
 * The result lands in `sources.toolDefinitions` inside
 * `buildSessionConfig`, which the v1.7 two-block assembler places in the
 * STABLE PREFIX (TOOL-07 — survives compaction-driven prompt-cache eviction).
 *
 * SECURITY (Pitfall 12 closure): this module ONLY reads `server.name`,
 * `server.optional`, and `state.lastError.message`. It NEVER renders
 * `server.command`, `server.args`, or any `server.env` value — the legacy
 * bullet-list in `session-config.ts:289-298` leaked the full command line
 * into every agent's prompt; removing that leak is a side-effect of this
 * plan.
 *
 * PURITY: zero I/O, zero logger, zero side effects. Unit-testable without
 * mocks beyond the readiness contract.
 */

/**
 * Phase 85 TOOL-02 — canonical pre-authenticated framing.
 *
 * Exported so tests and future prompt-assembly consumers can pin / re-use a
 * single source of truth. Wording is deliberate:
 *   - Opens with the emphasized sentence a regression-test greps for
 *     (`"MCP tools are pre-authenticated"` must appear verbatim).
 *   - Forbids "log in / unlock / prompt the user to set up" framing that
 *     phantom-error responses typically reach for.
 *   - Tells the agent to CALL the tool directly — no pre-emptive excuses.
 */
export const MCP_PREAUTH_STATEMENT =
  "**MCP tools are pre-authenticated.** Every server listed below has already " +
  "completed its authentication handshake at agent startup. You do not need " +
  "to log in, unlock a vault, or prompt the user to 'set up' an MCP server. " +
  "If you need a tool from one of these servers, call it directly.";

/**
 * Phase 85 TOOL-05 — verbatim-error rule.
 *
 * Pinned by a static-grep regression test on this very file AND by a
 * `toContain(MCP_VERBATIM_ERROR_RULE)` assertion in both the unit tests
 * (`mcp-prompt-block.test.ts`) and the integration tests
 * (`session-config-mcp.test.ts`).
 *
 * The wording is conservative on purpose: it forbids confabulated
 * "misconfigured" claims UNLESS the MCP server itself returned that word
 * in its own error message.
 */
export const MCP_VERBATIM_ERROR_RULE =
  "If an MCP tool reports an error, include the actual error message verbatim; do not assume the tool is misconfigured unless the error explicitly states misconfiguration.";

/**
 * Context-bloat fix #6 — defensive cap on the rendered `lastError` cell.
 *
 * The MCP prompt block lives in the cached STABLE PREFIX. A pathological
 * MCP server returning a multi-KB JSON-RPC error would inflate that prefix
 * and bust its prompt cache. The error text still reaches the agent (TOOL-04
 * intent preserved) — we only trim a degenerate tail. 500 chars is far
 * larger than any well-formed error message.
 */
export const MCP_LAST_ERROR_MAX_CHARS = 500;

/**
 * Minimal server shape consumed by {@link renderMcpPromptBlock}.
 *
 * Accepts both the zod-inferred `McpServerSchemaConfig` (with mutable
 * fields) and `ResolvedAgentConfig.mcpServers[number]` (all readonly). The
 * renderer only reads `name` and `optional`; `command`/`args`/`env` are
 * intentionally off-limits per the SECURITY note above, so the narrowed
 * type here is `{ name, optional? }` — pass the full server object and the
 * extra fields are ignored.
 */
type RenderableServer = Pick<McpServerSchemaConfig, "name"> & {
  readonly optional?: boolean;
};

export type RenderMcpPromptInput = {
  readonly servers: readonly RenderableServer[];
  /**
   * Per-server readiness state keyed by `server.name`. When a server has
   * no entry, its row renders with status `unknown` — this is the
   * pre-heartbeat state on a fresh boot before the first mcp-reconnect
   * tick has classified it.
   */
  readonly stateByName: ReadonlyMap<string, McpServerState>;
};

/**
 * Render the MCP section of the system prompt.
 *
 * Returns an empty string when `servers.length === 0` — anchoring a
 * "pre-authenticated" statement to nothing would confuse the agent
 * ("pre-authenticated" applies to which tools?).
 *
 * Table shape (pipes escaped inside cells):
 * ```
 * | Server | Status | Tools | Last Error |
 * |--------|--------|-------|------------|
 * | name   | ready  | —     |            |
 * ```
 *
 * The Tools column is deliberately `—` (U+2014 em dash) in v2.2. Populating
 * it with the list of exposed tool names would require calling
 * `q.mcpServerStatus()` at prompt-build time, which is out of scope for
 * Plan 01 and would make the stable prefix recompute on every tool-list
 * change. A follow-up plan can wire the tool list through without
 * invalidating the current prompt shape.
 */
export function renderMcpPromptBlock(input: RenderMcpPromptInput): string {
  if (input.servers.length === 0) return "";

  const header = "## MCP Tools (pre-authenticated)";
  const preamble = MCP_PREAUTH_STATEMENT;

  const rows = input.servers.map((s) => {
    const state = input.stateByName.get(s.name);
    const baseStatus = state?.status ?? "unknown";
    // TOOL-01 operator signal: an `optional: true` server that is NOT
    // currently ready gets `(optional)` appended — makes it obvious in the
    // prompt that the failure didn't block startup.
    const optional = state?.optional ?? s.optional ?? false;
    const status =
      optional && baseStatus !== "ready"
        ? `${baseStatus} (optional)`
        : baseStatus;
    // Tools column placeholder until q.mcpServerStatus() wiring lands. The
    // em dash is intentional — a stray `"--"` edit would break the
    // test-6 assertion in mcp-prompt-block.test.ts.
    const tools = "\u2014";
    const lastErrRaw = state?.lastError?.message ?? "";
    // Escape pipes and strip newlines so a multi-line JSON-RPC error does
    // not break the markdown table. We ESCAPE pipes and COLLAPSE newlines
    // to spaces. TOOL-04 still holds — the actual error text reaches the
    // agent — but context-bloat fix #6 adds a defensive 500-char cap with
    // an ellipsis: a pathological multi-KB error must not bloat the cached
    // stable prefix and bust its prompt cache. The cap is far above any
    // well-formed error length, so normal errors are untouched.
    const lastErrNormalized = lastErrRaw
      .replace(/\|/g, "\\|")
      .replace(/\r?\n/g, " ")
      .trim();
    const lastErr =
      lastErrNormalized.length > MCP_LAST_ERROR_MAX_CHARS
        ? `${lastErrNormalized.slice(0, MCP_LAST_ERROR_MAX_CHARS)}…`
        : lastErrNormalized;
    return `| ${s.name} | ${status} | ${tools} | ${lastErr} |`;
  });

  const table = [
    "| Server | Status | Tools | Last Error |",
    "|--------|--------|-------|------------|",
    ...rows,
  ].join("\n");

  const rule = MCP_VERBATIM_ERROR_RULE;

  return [header, preamble, table, rule].join("\n\n");
}
