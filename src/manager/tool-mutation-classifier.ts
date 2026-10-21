/**
 * Debug session `in-tool-wedge-recovery` work-stream (B) — tool
 * read-only-vs-mutating classifier + wedge-recovery decision core.
 *
 * PURPOSE. When an in-tool SDK wedge is detected and the turn is aborted,
 * the user's request is half-finished. The operator decision (2026-05-21):
 *   - if the wedged in-flight tool was READ-ONLY, the request can be safely
 *     auto re-run (a read-only tool has no side effects — re-running is
 *     idempotent);
 *   - if it was MUTATING (or unknown / unclassifiable), auto re-running
 *     could repeat a side effect, so the agent must NOT silently re-run —
 *     it posts a "that response stalled — please resend" notice instead.
 *
 * This module is the PURE decision core for that branch. It is patterned
 * exactly on `src/manager/financial-verification-gate.ts`: no I/O, no
 * logging, no `Date`, no local imports (so it can never participate in an
 * import cycle), a `Object.freeze`d whitelist, and substring/exact matching
 * against the SDK `mcp__<server>__<tool>` naming convention. All side
 * effects (capturing the in-flight tool, dispatching the re-run, posting
 * the notice) live in the call sites — `persistent-session-handle.ts`,
 * `bridge.ts`, `subagent-thread-spawner.ts`.
 *
 * CONSERVATISM (operator constraint — FORK 4 / FORK 5). The classifier errs
 * toward MUTATING in every ambiguous case:
 *   - `Bash` is MUTATING unconditionally — `curl -X GET` and `rm -rf` are
 *     statically indistinguishable, so arg inspection is unsafe and out of
 *     scope.
 *   - An MCP tool whose SDK annotation is ABSENT is MUTATING (we never
 *     assume read-only without an explicit signal).
 *   - Any tool name that matches nothing — a new built-in, a typo, an MCP
 *     tool from an un-annotated server not on the fallback allowlist — is
 *     MUTATING.
 *   - A parallel tool batch is read-only ONLY if EVERY in-flight tool is
 *     read-only; one mutating/unknown member makes the whole wedge mutating
 *     (`isBatchReadOnly`).
 *
 * The conservative default means a false "mutating" costs one extra
 * "please resend" notice (mild UX friction); a false "read-only" could
 * silently repeat a side effect (data corruption). The asymmetry dictates
 * the direction of every default.
 *
 * The pure DECISION core below keeps no local imports (cycle safety). The
 * one exception is the presentation helper `describeStallNotice`, which
 * renders the warning glyph through the `cc_*` icon registry (`icons.js` is
 * a leaf module — it imports nothing from `manager/`, so no cycle).
 */
import { icons } from "../discord/icons.js";

/**
 * Read-only BUILT-IN tool allowlist (FORK 4, operator-locked 2026-05-21).
 *
 * Built-in (non-MCP) tools have bare names — no `mcp__` prefix. Only these
 * are read-only; EVERY other built-in (`Bash`, `Write`, `Edit`,
 * `NotebookEdit`, `TodoWrite`, `Task`, ...) is mutating.
 *
 * `Bash` is deliberately NOT here — its command string can be anything
 * from `ls` to `rm -rf /`, and the classifier does not (and must not)
 * inspect arguments. `NotebookRead` / `TodoRead` are deliberately omitted:
 * the SDK tool-schema set (`sdk-tools.d.ts`) defines only `NotebookEdit`
 * and `TodoWrite` — there is no confirmed read-only Notebook/Todo tool, so
 * adding a speculative name would be unsafe. An unconfirmed tool falls to
 * `unknown → mutating`, which is the correct safe outcome.
 *
 * Frozen so the allowlist cannot be mutated at runtime, and pinned by the
 * static-grep regression test — a future edit that empties it (which would
 * make EVERY built-in classify mutating and disable all auto-recovery, a
 * silent capability loss) fails that test.
 */
export const READ_ONLY_BUILTIN_TOOLS: readonly string[] = Object.freeze([
  "Read",
  "Grep",
  "Glob",
  "WebSearch",
  "WebFetch",
]);

/**
 * Read-only clawcode-MCP tool FALLBACK allowlist (FORK 4).
 *
 * MCP tools are named `mcp__<server>__<tool>` (e.g.
 * `mcp__clawcode__memory_lookup`). The PRIMARY MCP classification source
 * is the SDK's own `annotations.readOnly` flag (see
 * {@link classifyMcpToolFromAnnotation}). This list is the FALLBACK for
 * clawcode's own MCP tools when no annotation is available (the clawcode
 * MCP server may not set tool annotations). Matching is by the `<tool>`
 * suffix after the final `__`, exact-match against this set.
 *
 * Only unambiguously side-effect-free clawcode MCP tools belong here.
 * `memory_lookup` reads memory; `ask_advisor` consults a reviewer (no
 * mutation of agent/user state); `web_search` / `web_fetch` retrieve
 * external content; `find_agents` reads the registry. Anything that
 * posts, spawns, marks-complete, or writes is excluded — those are
 * mutating and must fall through to the mutating default.
 *
 * Frozen + static-grep-pinned for the same reason as the built-in list.
 */
export const READ_ONLY_MCP_TOOL_SUFFIXES: readonly string[] = Object.freeze([
  "memory_lookup",
  "ask_advisor",
  "web_search",
  "web_fetch",
  "find_agents",
]);

/**
 * DETACHABLE built-in tools — debug session `in-tool-wedge-recovery`
 * work-stream (C), FORK 8.
 *
 * These are the built-in tools whose in-flight execution the SDK's
 * `Query.backgroundTasks(toolUseId)` can cleanly detach: "foreground
 * tasks" in the SDK's vocabulary — `Bash` shell commands and `Task`
 * (subagent) calls. When a turn wedges inside one of these, the 999.64
 * heartbeat sweep can DETACH the hung task (the turn resumes with a
 * synthetic "running in the background" tool_result) instead of bluntly
 * force-releasing + aborting the whole turn.
 *
 * SCOPE — this axis is ORTHOGONAL to the read-only/mutating axis:
 *   - `Bash` is BOTH mutating (the B classifier) AND detachable (here).
 *   - MCP tools (`mcp__<server>__<tool>`) are NEVER detachable —
 *     `backgroundTasks` does not target MCP tool calls (SDK-confirmed).
 *     A wedge inside an MCP tool falls back to the blunt force-release.
 *   - `Read`/`Grep`/etc. are not "tasks" — they complete inline; they are
 *     not detachable and (in practice) do not wedge the way a long Bash
 *     command or a subagent does.
 *
 * Frozen + static-grep-pinned: a future edit that empties this list would
 * silently disable all clean-detach recovery (every wedge would fall back
 * to the blunt force-release) — the regression test fails on an empty list.
 */
export const DETACHABLE_TOOLS: readonly string[] = Object.freeze([
  "Bash",
  "Task",
]);

/**
 * Is a tool's in-flight execution cleanly detachable via
 * `Query.backgroundTasks` (FORK 8)?
 *
 * `true` only for the built-in foreground-task tools in
 * {@link DETACHABLE_TOOLS}. `false` for every MCP tool
 * (`mcp__<server>__<tool>` — `backgroundTasks` does not target them), for
 * every non-task built-in, and for an empty / non-string name.
 *
 * This is a per-TOOL predicate. The batch rule for a wedged turn (detach
 * only when EVERY in-flight tool is detachable; otherwise fall back to
 * force-release — a mixed batch is never half-detached) lives at the
 * call site in `persistent-session-handle.ts`.
 */
export function isDetachableTool(toolName: string): boolean {
  if (typeof toolName !== "string" || toolName.length === 0) return false;
  // MCP tools are never detachable — short-circuit before the allowlist
  // check (a contrived `mcp__x__Bash` must NOT match).
  if (toolName.startsWith("mcp__")) return false;
  return DETACHABLE_TOOLS.includes(toolName);
}

/**
 * Classification of a single tool call.
 *   - `read-only` — the tool has no side effects; a turn wedged inside it
 *     can be safely auto re-run.
 *   - `mutating`  — the tool may have a side effect (or is unknown /
 *     unclassifiable); a turn wedged inside it must NOT be auto re-run.
 */
export type ToolMutationClass = "read-only" | "mutating";

/**
 * Minimal projection of one entry from the SDK's `Query.mcpServerStatus()`
 * result, carrying only the fields the classifier consults. The real SDK
 * `McpServerStatus` is wider (status / serverInfo / config / scope / ...);
 * structural typing lets a caller pass the full object unchanged.
 *
 * `tools[].annotations.readOnly` / `.destructive` are the SDK's own
 * per-tool classification (sdk.d.ts `McpServerStatus.tools[].annotations`).
 */
export type McpToolAnnotationSnapshot = {
  /** Server name as configured (the `<server>` in `mcp__<server>__<tool>`). */
  readonly name: string;
  /** Tools the connected server advertises, with optional annotations. */
  readonly tools?: readonly {
    readonly name: string;
    readonly annotations?: {
      readonly readOnly?: boolean;
      readonly destructive?: boolean;
    };
  }[];
};

/**
 * Structured description of an in-tool wedge, surfaced from
 * `persistent-session-handle.ts` on the thrown `AbortError` (FORK 6). The
 * recovery decision (`decideWedgeRecovery`) is computed from this.
 */
export type WedgeInfo = {
  /**
   * Why the tracker tripped — mirrors `StreamStallReason` from
   * `stream-stall-tracker.ts`. `"no-useful-tokens"` with an empty
   * `inFlightToolNames` is a pure-text hang (no tool in flight).
   */
  readonly reason:
    | "no-useful-tokens"
    | "max-pause-exceeded"
    | "max-turn-duration"
    | "sweep-force-release";
  /**
   * Names of every tool that was in flight (paused, awaiting a
   * tool_result) when the wedge was detected. EMPTY for a pure-text hang
   * — that case is auto-retry-safe by definition (no side effect could
   * have been in progress). One entry for a single-tool wedge; multiple
   * for a parallel batch.
   */
  readonly inFlightToolNames: readonly string[];
};

/**
 * The recovery action chosen for a wedged turn.
 *   - `auto-rerun` — no in-flight tool, OR every in-flight tool is
 *     read-only: the original request can be safely re-dispatched.
 *   - `notify`     — at least one in-flight tool was mutating / unknown:
 *     do NOT re-run; post a "please resend" notice.
 */
export type WedgeRecoveryAction = "auto-rerun" | "notify";

/**
 * Split an SDK tool name into its kind.
 *   - `mcp__<server>__<tool>` → `{ kind: "mcp", server, tool }`.
 *   - anything else           → `{ kind: "builtin" }`.
 *
 * The MCP form is the SDK convention (see
 * `src/manager/find-alternative-agents.ts` regex). A defensive parse: an
 * `mcp__` prefix with a missing `__<tool>` segment is treated as builtin
 * (it will then fail the builtin allowlist and classify mutating — the
 * safe outcome).
 */
function parseToolName(
  name: string,
): { kind: "mcp"; server: string; tool: string } | { kind: "builtin" } {
  if (!name.startsWith("mcp__")) return { kind: "builtin" };
  const rest = name.slice("mcp__".length);
  const sep = rest.indexOf("__");
  if (sep <= 0 || sep >= rest.length - 2) return { kind: "builtin" };
  return {
    kind: "mcp",
    server: rest.slice(0, sep),
    tool: rest.slice(sep + 2),
  };
}

/**
 * Look up an MCP tool's SDK `readOnly` annotation in a
 * `mcpServerStatus()` snapshot.
 *
 * @returns `true` / `false` when the snapshot has an explicit annotation
 *          for `mcp__<server>__<tool>`; `undefined` when no annotation is
 *          available (server not in the snapshot, tool not advertised, or
 *          `annotations.readOnly` absent) — the caller then falls back to
 *          {@link READ_ONLY_MCP_TOOL_SUFFIXES}.
 *
 * A `destructive: true` annotation forces `false` even if `readOnly` is
 * somehow also set — destructive always wins (conservative).
 */
function classifyMcpToolFromAnnotation(
  server: string,
  tool: string,
  snapshot: readonly McpToolAnnotationSnapshot[] | undefined,
): boolean | undefined {
  if (!snapshot) return undefined;
  const serverEntry = snapshot.find((s) => s.name === server);
  if (!serverEntry?.tools) return undefined;
  const toolEntry = serverEntry.tools.find((t) => t.name === tool);
  const ann = toolEntry?.annotations;
  if (!ann) return undefined;
  if (ann.destructive === true) return false;
  if (ann.readOnly === true) return true;
  if (ann.readOnly === false) return false;
  return undefined;
}

/**
 * Classify a single tool call as read-only or mutating.
 *
 * Decision order:
 *   1. MCP tool with an explicit SDK annotation in `mcpSnapshot` → use it.
 *   2. MCP tool, no annotation → exact-match the `<tool>` suffix against
 *      {@link READ_ONLY_MCP_TOOL_SUFFIXES}; hit → read-only.
 *   3. Built-in tool → exact-match against {@link READ_ONLY_BUILTIN_TOOLS}.
 *   4. Anything else (unknown built-in, un-annotated unlisted MCP tool,
 *      malformed name, empty string) → `mutating` (the conservative
 *      unknown-default the operator constraint mandates).
 *
 * @param toolName    the tool name from the `tool_use` block.
 * @param mcpSnapshot optional `Query.mcpServerStatus()` projection — the
 *                    SDK's runtime source of truth for MCP annotations.
 *                    Omit / pass `undefined` to use the fallback allowlist
 *                    only.
 */
export function classifyTool(
  toolName: string,
  mcpSnapshot?: readonly McpToolAnnotationSnapshot[],
): ToolMutationClass {
  if (typeof toolName !== "string" || toolName.length === 0) {
    return "mutating";
  }
  const parsed = parseToolName(toolName);
  if (parsed.kind === "mcp") {
    const annotated = classifyMcpToolFromAnnotation(
      parsed.server,
      parsed.tool,
      mcpSnapshot,
    );
    if (annotated === true) return "read-only";
    if (annotated === false) return "mutating";
    // No annotation — fall back to the clawcode-MCP read-only allowlist.
    return READ_ONLY_MCP_TOOL_SUFFIXES.includes(parsed.tool)
      ? "read-only"
      : "mutating";
  }
  // Built-in tool.
  return READ_ONLY_BUILTIN_TOOLS.includes(toolName) ? "read-only" : "mutating";
}

/**
 * FORK 5 — is a whole parallel tool batch read-only?
 *
 * `true` ONLY when EVERY tool name classifies read-only. An empty batch
 * is `true` (vacuously — there is no mutating tool, and the pure-text-hang
 * case routes here). One mutating / unknown member makes the entire batch
 * mutating.
 */
export function isBatchReadOnly(
  toolNames: readonly string[],
  mcpSnapshot?: readonly McpToolAnnotationSnapshot[],
): boolean {
  return toolNames.every(
    (n) => classifyTool(n, mcpSnapshot) === "read-only",
  );
}

/**
 * The wedge-recovery decision core (FORK 1 / FORK 5 + the operator
 * pure-text-hang rule).
 *
 * Rules:
 *   - EMPTY `inFlightToolNames` → pure-text hang, no tool in flight, no
 *     side effect could have been mid-execution → `auto-rerun`. (This is
 *     the operator's explicit "pure-text hang → auto re-run is safe" rule;
 *     it must NOT fall into the conservative-mutating bucket.)
 *   - All in-flight tools read-only → `auto-rerun`.
 *   - Any in-flight tool mutating / unknown → `notify`.
 *
 * This function is SESSION-TYPE-AGNOSTIC. FORK 1 (a delegated subagent
 * wedge is ALWAYS notify-only, never auto re-run, regardless of tool
 * class) is enforced at the subagent call site, not here — the subagent
 * spawner simply never calls `auto-rerun`. Keeping that policy at the call
 * site keeps this core a pure tool-class decision.
 *
 * @returns `"auto-rerun"` or `"notify"`.
 */
export function decideWedgeRecovery(
  wedge: WedgeInfo,
  mcpSnapshot?: readonly McpToolAnnotationSnapshot[],
): WedgeRecoveryAction {
  if (wedge.inFlightToolNames.length === 0) {
    // Pure-text hang — no tool, no side effect — safe to re-run.
    return "auto-rerun";
  }
  return isBatchReadOnly(wedge.inFlightToolNames, mcpSnapshot)
    ? "auto-rerun"
    : "notify";
}

/**
 * Phase 999.114 — operator/user-facing one-liner for an aborted turn.
 *
 * The previous copy was a fixed string claiming "a tool wedged". That is wrong
 * for the most common case by a wide margin: a `no-useful-tokens` trip with an
 * empty `inFlightToolNames` is a PURE-TEXT hang — the model simply produced no
 * text, JSON or thinking delta inside the window, usually because it was slow
 * to its FIRST token. A 7-day production sweep found 17 such trips, ALL with
 * `inFlightTools: []`. Naming a wedged tool in that case sent two separate
 * investigations down a dead end before the transcript showed no tool was ever
 * involved.
 *
 * Pure so both delivery surfaces (the channel notice and the subagent-thread
 * notice) render the same sentence from the same facts.
 */
export function describeStallNotice(info: WedgeInfo | undefined): string {
  const tools = info?.inFlightToolNames ?? [];
  if (tools.length > 0) {
    const named = tools.length === 1 ? `\`${tools[0]}\`` : `${tools.length} tools`;
    return icons.prefix(
      "warning",
      `That response stalled mid-way — ${named} stopped responding and the ` +
        `turn was aborted. Please resend your message.`,
    );
  }
  if (info?.reason === "max-turn-duration") {
    return icons.prefix(
      "warning",
      "That response hit the maximum turn duration and was stopped. " +
        "Try narrowing the request, or split it into smaller steps.",
    );
  }
  // `no-useful-tokens` / `sweep-force-release` with no tool in flight.
  return icons.prefix(
    "warning",
    "That response was cut off before it produced any output — the model " +
      "went quiet for longer than the stall watchdog allows (often a slow first " +
      "token on a long reasoning turn). No tool was involved. Please resend.",
  );
}
