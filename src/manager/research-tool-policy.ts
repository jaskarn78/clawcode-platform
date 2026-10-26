/**
 * Phase 999.173 — what a researcher subagent may use.
 *
 * Default: INHERIT the parent agent's tool surface (the SDK's native behavior
 * when `AgentDefinition.tools` is omitted — every built-in and every MCP server
 * the parent has: finnhub / acme-db for fin-client, google-workspace
 * / playwright / brave for personal, the auto-injected search / browser /
 * image servers), MINUS anything with side effects.
 *
 * Enforced in two layers:
 *   1. `disallowedTools` on the AgentDefinition — exact names the SDK removes
 *      before the model sees them: mutating built-ins, the whole 1password
 *      server (server-level spec), every acting clawcode tool, Bash unless
 *      `research.allowBash`, plus `research.deniedTools`.
 *   2. `decideResearcherTool` — run by the research PreToolUse hook for calls
 *      made BY a researcher (`agent_type === "researcher"`). It re-checks the
 *      exact denials, allows only the read-only clawcode tools, and denies
 *      tools on OTHER servers whose names carry a mutating verb (Gmail send,
 *      Drive create/trash, calendar update …), plus non-read SQL. Tool names
 *      on third-party servers are not known when the session is built, which
 *      is why this layer exists.
 *
 * Deny wins over the operator's `research.tools` override: an explicit list
 * narrows or widens what is inherited, never what is side-effecting.
 */

import type { ResearchSessionConfig } from "./research-subagents.js";

/** Built-ins with side effects (or that fan out / need an operator). */
export const RESEARCHER_DENIED_BUILTINS: readonly string[] = Object.freeze([
  "Agent",
  "Task",
  "Workflow",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "AskUserQuestion",
  "SendUserFile",
  "ScheduleWakeup",
  "CronCreate",
  "CronDelete",
  "TodoWrite",
]);

/** Shell tools — denied unless `research.allowBash`. */
export const RESEARCHER_BASH_TOOLS: readonly string[] = Object.freeze(["Bash", "BashOutput", "KillShell", "KillBash"]);

/** Whole servers a researcher never sees. */
export const RESEARCHER_DENIED_SERVERS: readonly string[] = Object.freeze(["1password"]);

/** clawcode tools that only read. Every other clawcode tool is denied to researchers. */
export const CLAWCODE_READONLY_TOOLS: ReadonlySet<string> = new Set([
  "memory_lookup",
  "clawcode_memory_search",
  "clawcode_memory_recall",
  "search_documents",
  "list_documents",
  "read_thread",
  "client_facts",
  "clawcode_fetch_discord_messages",
  "list_schedules",
  "list_agents",
  "agent_status",
  "workflow_status",
  "workflow_templates",
  "task_status",
  "training_stats",
  "list_agent_schemas",
]);

/**
 * The acting clawcode tools, named exactly for `disallowedTools` (the hook's
 * clawcode allowlist also catches any tool added later).
 */
export const CLAWCODE_ACTING_TOOLS: readonly string[] = Object.freeze([
  "start_workflow",
  "cancel_workflow",
  "steer_workflow",
  "edit_workflow",
  "spawn_subagent_thread",
  "steer_subagent",
  "subagent_complete",
  "archive_thread",
  "post_to_agent",
  "send_to_agent",
  "send_message",
  "ask_agent",
  "delegate_task",
  "cancel_task",
  "task_complete",
  "schedule_reminder",
  "schedule_recurring",
  "cancel_schedule",
  "clawcode_share_file",
  "send_attachment",
  "post_cv2_embed",
  "show_preview",
  "memory_save",
  "clawcode_memory_edit",
  "clawcode_memory_archive",
  // Memory overhaul 2026-10-25 (WP5) - corrections mutate the memory store.
  "clawcode_memory_forget",
  "clawcode_memory_update",
  "ingest_document",
  "delete_document",
  "clawcode_rag_set_priority",
  "client_fact_set",
  "ask_user_question",
  "ask_advisor",
  "verify_claim",
  "list_webhooks",
]);

/**
 * Verbs that make a third-party MCP tool side-effecting. Matched against the
 * tool's name tokens (split on `_`, `-`, `.` and camelCase), never its input.
 */
export const MUTATING_VERBS: ReadonlySet<string> = new Set([
  "send", "post", "create", "update", "delete", "remove", "trash", "untrash", "move", "rename",
  "upload", "share", "unshare", "schedule", "cancel", "start", "stop", "spawn", "write", "set",
  "insert", "upsert", "modify", "patch", "put", "append", "archive", "unarchive", "edit", "submit",
  "publish", "reply", "forward", "draft", "purchase", "buy", "checkout", "pay", "transfer",
  "kill", "restart", "drop", "truncate", "grant", "revoke", "invite", "approve", "reject", "merge",
  "commit", "push", "deploy", "install", "uninstall", "enable", "disable", "mark", "label",
  "subscribe", "unsubscribe", "reserve", "rsvp", "accept", "decline", "copy", "import",
  "manage",
]);

/** Tools whose input is SQL: allowed only for read statements. */
const SQL_TOOL_RE = /(^|_)(execute|exec|run)_?(sql|query)$|(^|_)(sql|query)$|^query_?database$/;
const READ_SQL_RE = /^(select|with|show|describe|desc|explain)\b/i;

export type ResearcherToolDecision = Readonly<{ deny: boolean; reason?: string }>;

const ALLOW: ResearcherToolDecision = Object.freeze({ deny: false });

function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_\-.\s]+/)
    .filter((t) => t.length > 0);
}

function sqlOf(input: unknown): string | null {
  if (input === null || typeof input !== "object") return null;
  for (const key of ["sql", "query", "statement", "q"]) {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v === "string") return v;
  }
  return null;
}

/** True when the SQL text is a single read statement. */
export function isReadOnlySql(sql: string): boolean {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .trim()
    .replace(/;\s*$/, "");
  if (stripped.includes(";")) return false;
  if (!READ_SQL_RE.test(stripped)) return false;
  // A CTE or SELECT can still write (`WITH x AS (DELETE …)`, `SELECT … INTO`).
  return !/\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|replace|call|into\s+outfile|lock)\b/i.test(stripped);
}

function deny(reason: string): ResearcherToolDecision {
  return { deny: true, reason };
}

/**
 * The policy for one tool call made by a researcher. `extraDenied` is
 * `research.deniedTools`; `allowBash` is `research.allowBash`.
 */
export function decideResearcherTool(
  toolName: string,
  toolInput: unknown,
  opts: Readonly<{ allowBash: boolean; extraDenied?: readonly string[] }>,
): ResearcherToolDecision {
  if (typeof toolName !== "string" || toolName.length === 0) {
    return deny("Researcher tool call without a tool name.");
  }
  if (opts.extraDenied?.includes(toolName)) {
    return deny(`${toolName} is denied to researchers by this agent's config.`);
  }
  if (RESEARCHER_DENIED_BUILTINS.includes(toolName)) {
    return deny(`${toolName} is not available to researchers: they read and report, they do not act.`);
  }
  if (!opts.allowBash && RESEARCHER_BASH_TOOLS.includes(toolName)) {
    return deny("Shell access is off for researchers on this agent (research.allowBash).");
  }
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(toolName);
  if (mcp === null) return ALLOW;
  const [, server, tool] = mcp as unknown as [string, string, string];
  if (RESEARCHER_DENIED_SERVERS.includes(server)) {
    return deny(`The ${server} server is never available to researchers.`);
  }
  if (opts.extraDenied?.includes(`mcp__${server}`)) {
    return deny(`The ${server} server is denied to researchers by this agent's config.`);
  }
  if (server === "clawcode") {
    return CLAWCODE_READONLY_TOOLS.has(tool)
      ? ALLOW
      : deny(`${tool} acts on the agent's behalf; researchers only read. Report what should be done instead.`);
  }
  if (SQL_TOOL_RE.test(tool.toLowerCase())) {
    const sql = sqlOf(toolInput);
    if (sql !== null && isReadOnlySql(sql)) return ALLOW;
    return deny("Researchers may only run single read-only SQL statements (SELECT / WITH / SHOW / DESCRIBE / EXPLAIN).");
  }
  const verb = nameTokens(tool).find((t) => MUTATING_VERBS.has(t));
  if (verb !== undefined) {
    return deny(`${tool} changes something (${verb}); researchers only read. Report what should be done instead.`);
  }
  return ALLOW;
}

/** Exact names for `AgentDefinition.disallowedTools` (layer 1). */
export function researcherDisallowedTools(r: Pick<ResearchSessionConfig, "allowBash" | "deniedTools">): string[] {
  return [
    ...RESEARCHER_DENIED_BUILTINS,
    ...(r.allowBash ? [] : RESEARCHER_BASH_TOOLS),
    ...RESEARCHER_DENIED_SERVERS.map((s) => `mcp__${s}`),
    ...CLAWCODE_ACTING_TOOLS.map((t) => `mcp__clawcode__${t}`),
    ...r.deniedTools,
  ];
}
