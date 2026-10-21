/**
 * Phase 145 WS1 — in-process SDK `PreToolUse` hook that makes in-process
 * Workflow/Agent subagents NON-INTERACTIVE so the headless `parallel()` barrier
 * cannot deadlock on a permission prompt that has no approver.
 *
 * ROOT CAUSE (145-RESEARCH): in-process Workflow/Agent subagents do NOT inherit
 * the parent session's `permissionMode: "bypassPermissions"` → they fall back to
 * `"default"` → the SDK prompts on "dangerous" tools (`WebFetch`) → in a headless
 * session there is no operator to answer → the turn hangs forever
 * (`wf_b7627966-614`). `createSession` passes NO `agents:` (`AgentDefinition[]`)
 * option, so these are SDK-INTERNAL workers — there is no `AgentDefinition` to set
 * `permissionMode` on. The session-level PreToolUse hook is the only lever.
 *
 * THE FIX: a deterministic PreToolUse decision. A hook `deny` takes precedence
 * over `bypassPermissions` and is headless-safe — the model sees a clean denial
 * and continues; no prompt → no hang (sdk.d.ts:3193 "PreToolUse hook denies
 * bypass canUseTool"). We deny ONLY the tools that prompt/no-op headless
 * (`WebFetch`, `AskUserQuestion`) and ALLOW everything else a subagent
 * legitimately needs (Read/Grep/Bash/Edit/Write + the `mcp__*` servers).
 *
 * This mirrors the headless-safe deny posture of `clawcode-bash-allowlist-hook.ts`
 * (deny short-circuits without a prompt) but is the INVERSE allow/deny default:
 *   - bash-allowlist is DENY-by-default (a command must match the allowlist).
 *   - this hook is ALLOW-by-default for the working set (a new working tool must
 *     not silently break subagents) and maintains a small, explicit DENY list of
 *     the known-interactive tools.
 * It is still fail-CLOSED for the SPECIFIC hazard: a tool we KNOW prompts is
 * ALWAYS denied, and an empty/undefined `tool_name` (unparseable → we cannot
 * confirm it is a safe non-interactive tool) is denied to avoid an ambiguous
 * headless prompt.
 *
 * SCOPING (two layers, byte-stable when off):
 *   1. `subagentPermissionHook` early-returns `{}` (no change) when `agent_id` is
 *      absent → top-level/main-thread tool calls are completely unaffected.
 *   2. session-adapter registers the `hooks:` KEY spread-conditionally behind the
 *      `subagentPermissionGate` config flag → the existing fleet's Options bag is
 *      byte-identical when the flag is off.
 *
 * NB: this is the SDK (v2) IN-PROCESS `HookCallback` variant — NOT the v3
 * `--settings` command-hook variant (`clawcode-bash-allowlist-hook.ts`, a separate
 * runnable binary that pipes JSON over stdin/stdout). The deadlocked agents run on
 * the SDK/v2 backend (audit-confirmed), which wires no command hooks.
 */

import type {
  HookCallback,
  PreToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";

/**
 * The explicit DENY list: built-in tools that assume an interactive frontend and
 * therefore hang or no-op when a headless subagent calls them.
 *
 * Kept SMALL + explicit (per 145-RESEARCH "Anti-Patterns" — a speculative deny
 * entry that is not tested is scope creep that can mis-deny):
 *   - `WebFetch`  — LOCKED. Web research for subagents goes via the `mcp__*`
 *                   search servers. Left interactive, it is the exact tool that triggers
 *                   the `default`-mode prompt → the deadlock.
 *   - `AskUserQuestion` — non-rendering interactive tool; a subagent has no
 *                   operator to answer it (already in the fleet `disallowedTools`
 *                   default since Plan 01, but denied here too so the hook is
 *                   self-contained and survives a disallow-list regression).
 */
const SUBAGENT_DENIED_TOOLS: ReadonlySet<string> = new Set([
  "WebFetch",
  "AskUserQuestion",
]);

const DENY_REASONS: Readonly<Record<string, string>> = {
  WebFetch:
    "WebFetch is denied for subagents: it prompts for permission interactively and a headless subagent cannot answer — do web research via the MCP search servers instead.",
  AskUserQuestion:
    "AskUserQuestion is denied for subagents: it is a non-rendering interactive prompt and a subagent has no operator to answer it.",
};

export interface SubagentToolDecision {
  readonly deny: boolean;
  readonly reason?: string;
}

/**
 * Pure decision table (exported for unit tests). Returns `{deny:true,reason}` to
 * block a subagent's tool call, `{deny:false}` to allow it.
 *
 * Allow-by-default for the working set; explicit deny for the known-interactive
 * tools; fail-CLOSED (deny) on an empty/undefined `tool_name` — an unparseable
 * tool name cannot be confirmed non-interactive, so denying avoids an ambiguous
 * headless prompt (the very hazard this hook exists to prevent).
 */
export function decideSubagentTool(toolName: string): SubagentToolDecision {
  // Fail-closed for the ambiguous-prompt hazard: an empty/undefined tool_name is
  // unparseable. We cannot confirm it is a safe non-interactive tool, so deny
  // rather than risk an interactive prompt with no approver.
  if (typeof toolName !== "string" || toolName.length === 0) {
    return {
      deny: true,
      reason: "subagent tool call has an empty/undefined tool_name — denied to avoid an ambiguous headless prompt",
    };
  }

  if (SUBAGENT_DENIED_TOOLS.has(toolName)) {
    return {
      deny: true,
      reason: DENY_REASONS[toolName] ?? `${toolName} is denied for subagents (non-interactive headless context).`,
    };
  }

  // Allow-by-default: Read/Grep/Glob/Bash/Edit/Write + every `mcp__*` server tool
  // + any new built-in working tool. A subagent legitimately needs the full
  // working set; only the explicit deny list above is blocked.
  return { deny: false };
}

/**
 * The in-process `PreToolUse` hook callback (matches the SDK `HookCallback`
 * signature). Registered SPREAD-CONDITIONALLY in session-adapter behind
 * `config.subagentPermissionGate` — see that file for the byte-stability gate.
 *
 * Typed against the `HookInput` UNION (via `HookCallback`), NOT a narrowed
 * `PreToolUseHookInput`, so it remains assignable into `HookCallbackMatcher.hooks`.
 * It narrows on `hook_event_name` before reading `tool_name` (defense-in-depth —
 * the hook is only registered for `PreToolUse`, but a non-PreToolUse member of the
 * union does not carry `tool_name`).
 */
export const subagentPermissionHook: HookCallback = async (input, _toolUseID, _options) => {
  // `agent_id` lives on `BaseHookInput` so it is readable on the raw union.
  // Present ONLY when the hook fires from within a subagent (sdk.d.ts:129) — this
  // is the subagent discriminator. Absent (or empty) → a top-level / main-thread
  // turn → return `{}` (no change) so the existing fleet is unaffected.
  const agentId = input.agent_id;
  const isSubagent = typeof agentId === "string" && agentId.length > 0;
  if (!isSubagent) return {};

  // Defense-in-depth: only PreToolUse carries `tool_name`. The hook is only
  // registered for PreToolUse, but narrow before reading the field so a stray
  // event can never throw / mis-read.
  if (input.hook_event_name !== "PreToolUse") return {};
  const pre = input as PreToolUseHookInput;

  const decision = decideSubagentTool(pre.tool_name);
  if (decision.deny) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          decision.reason ?? `${pre.tool_name} is denied for subagents.`,
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
    },
  };
};
