import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod/v4";
import { sendIpcRequest } from "../ipc/client.js";
import { CV2_FILES_SCHEMA, CV2_SPEC_SCHEMA } from "./cv2-spec-schema.js";
import { renderScheduleList, type SchedulesIpcResult } from "./schedule-list.js";

// P2 (memory program) — the socket path is computed INLINE instead of
// imported from daemon.js: that value-import dragged the entire ~15k-line
// daemon module (239 imports) into every entry containing this file — a
// major part of the ~246 MB-per-agent sidecar bundle tax. Mirrors the
// identical cycle-avoidance idiom at src/config/loader.ts:90-116. Keep in
// lockstep with MANAGER_DIR / SOCKET_PATH in src/manager/daemon.ts.
const SOCKET_PATH = join(
  process.env.CLAWCODE_MANAGER_DIR ?? join(homedir(), ".clawcode", "manager"),
  "clawcode.sock",
);
import {
  AGENT_TOKEN_PARAM,
  CALLER_AGENT_PARAM,
  AGENT_TOKEN_ENV,
} from "../manager/agent-identity-token.js";
import { IDEMPOTENT_TOOL_DEFAULTS } from "../config/schema.js";
import type { Turn } from "../performance/trace-collector.js";
// Phase 145 WS3 (Plan 04) — ask_user_question round-trip result type.
// Phase 999.165 — workflow status + cancel tools.
import type {
  WorkflowCancelResult,
  WorkflowDetail,
  WorkflowEditResult,
  WorkflowSteerResult,
  WorkflowSummary,
} from "../manager/workflow-orchestrator.js";
import {
  renderCancelResultText,
  renderEditResultText,
  renderSteerResultText,
  renderWorkflowDetailText,
  renderWorkflowListText,
} from "../manager/workflow-status-render.js";
// Phase 145 WS2 (Plan 05) — start_workflow fast-return result type.
import type {
  IpcAskUserQuestionResult,
  IpcStartWorkflowResult,
} from "../ipc/types.js";

/**
 * Tool definitions for the ClawCode MCP server.
 * Each tool maps to an existing IPC method on the daemon.
 */
export const TOOL_DEFINITIONS = {
  agent_status: {
    description: "Get status of all ClawCode agents or a specific agent",
    ipcMethod: "status",
  },
  list_agents: {
    description: "List all configured agents with their current status",
    ipcMethod: "status",
  },
  send_message: {
    description: "Send a message to a ClawCode agent's inbox",
    ipcMethod: "send-message",
  },
  list_schedules: {
    description: "Show all scheduled tasks and runtime recurring schedules across agents",
    ipcMethod: "schedules",
  },
  list_webhooks: {
    description: "Show configured webhook identities",
    ipcMethod: "webhooks",
  },
  spawn_subagent_thread: {
    description: "Spawn a subagent in a new Discord thread",
    ipcMethod: "spawn-subagent-thread",
  },
  // Phase 999.25 — explicit work-completion signal. A subagent calls
  // this when its delegated work is done so the relay to the parent
  // channel fires immediately instead of waiting hours for the
  // session to be stopped.
  subagent_complete: {
    description:
      "Signal that this subagent has finished its delegated work. Posts your final answer to the parent agent's channel and stops further relays. Call this once, after your last substantive reply in the thread. agentName must match this subagent's session name (e.g. 'fin-client-via-fin-research-AbC123'). Operator-defined agents who call this get a clear no-op error.",
    ipcMethod: "subagent-complete",
  },
  read_thread: {
    description: "Read recent messages from a Discord thread (your subagent's work)",
    ipcMethod: "read-thread",
  },
  archive_thread: {
    description: "Archive a Discord thread and prune its registry binding",
    ipcMethod: "archive-discord-thread",
  },
  schedule_reminder: {
    description: "Schedule a one-off reminder that fires as a standalone turn",
    ipcMethod: "schedule-reminder",
  },
  // Phase 999.99 — runtime recurring-poll primitive. schedule_recurring
  // registers a delivered recurring schedule (raw cron or friendly interval)
  // whose every tick posts a standalone Discord message; cancel_schedule stops
  // one by its returned id.
  schedule_recurring: {
    description: "Register a recurring schedule that posts a standalone message each tick",
    ipcMethod: "schedule-recurring",
  },
  cancel_schedule: {
    description: "Cancel a runtime recurring schedule by its scheduleId",
    ipcMethod: "cancel-schedule",
  },
  // Phase 145 WS3 (Plan 04) — the interactive-question replacement for the
  // disallowed built-in AskUserQuestion. Renders the question in the agent's
  // bound channel (Discord buttons today; Slack/others get a numbered text
  // fallback) and blocks until the channel operator answers, returning the
  // structured selection.
  ask_user_question: {
    description: "Ask the channel operator a multiple-choice question and block until they answer",
    ipcMethod: "ask-user-question",
  },
  // Phase 145 WS2 (Plan 05) — background workflow orchestrator. Runs a long
  // multi-step / parallel job as a daemon background job (each step a worker
  // session with a lifted turn-duration ceiling) and returns a wf_ id
  // immediately, so the triggering turn settles without spanning the workflow.
  start_workflow: {
    description: "Run a long multi-step or parallel job as a background workflow and return immediately",
    ipcMethod: "start-workflow",
  },
  // Phase 999.165 — see and stop your background workflows.
  workflow_status: {
    description: "See your background workflows: status, steps done, current wave",
    ipcMethod: "workflow-status",
  },
  cancel_workflow: {
    description: "Stop one of your background workflows, or a single step of it",
    ipcMethod: "cancel-workflow",
  },
  steer_workflow: {
    description: "Give one of your running background workflows new direction mid-run",
    ipcMethod: "steer-workflow",
  },
  edit_workflow: {
    description: "Add, replace or remove steps of one of your running background workflows",
    ipcMethod: "edit-workflow",
  },
  memory_lookup: {
    description: "Search your memory for relevant context, past decisions, and knowledge",
    ipcMethod: "memory-lookup",
  },
  memory_save: {
    description: "Save knowledge, decisions, or important context to long-term memory",
    ipcMethod: "memory-save",
  },
  // Phase 115 sub-scope 7 — lazy-load memory tools. Replace the always-
  // injected memory model with tool-mediated recall: search returns
  // 500-char snippets + memory IDs; recall fetches the full body on
  // demand; edit / archive let the agent curate Tier 1 (MEMORY.md / USER.md).
  clawcode_memory_search: {
    description:
      "Search this agent's memory (FTS5 + sqlite-vec hybrid). Returns top-K snippets with memory IDs.",
    ipcMethod: "clawcode-memory-search",
  },
  clawcode_memory_recall: {
    description:
      "Fetch the full body of a memory by ID (returned from clawcode_memory_search hits).",
    ipcMethod: "clawcode-memory-recall",
  },
  clawcode_memory_edit: {
    description:
      "Edit your Tier 1 memory file (MEMORY.md or USER.md). Modes: view / create / append / str_replace.",
    ipcMethod: "clawcode-memory-edit",
  },
  clawcode_memory_archive: {
    description:
      "Promote a found chunk into MEMORY.md or USER.md (agent-curated Tier 2 → Tier 1 archive).",
    ipcMethod: "clawcode-memory-archive",
  },
  verify_claim: {
    description:
      "Record a fact you verified this turn (claim + verdict + the source you opened). Sources not opened this turn are rejected.",
    ipcMethod: "verify-claim",
  },
  ask_advisor: {
    description: "Ask opus for advice on a complex decision without switching sessions",
    ipcMethod: "ask-advisor",
  },
  send_attachment: {
    description: "Send a file attachment to your Discord channel (images, PDFs, media, etc.)",
    ipcMethod: "send-attachment",
  },
  // Backlog 999.95 — push a live HTML preview (or a URL) into your Discord
  // Embedded App surface. The first push of an id posts a one-tap launch
  // button; later pushes to the same id hot-reload the open preview over SSE
  // (no relaunch). Registered with an explicit zod schema below.
  show_preview: {
    description:
      "Push a live HTML preview (or a URL) into your Discord Embedded App. The first push of an id posts a one-tap launch button in your channel; later pushes to the same id update the open preview live, no relaunch. HTML is capped at 256 KiB.",
    ipcMethod: "show-preview",
  },
  send_to_agent: {
    description: "Send a message to another agent via their Discord channel",
    ipcMethod: "send-to-agent",
  },
  ingest_document: {
    description: "Ingest a document from your workspace for RAG search (text, markdown, or PDF)",
    ipcMethod: "ingest-document",
  },
  // Phase 999.43 Plan 04 T02 — agent-callable priority override on a
  // previously ingested document. D-08 sandbox: agents are capped at
  // MEDIUM (Layer-1 enforced via z.enum(["medium","low"]) in the
  // server.tool registration below; Layer-2 enforced at the daemon
  // handler in src/manager/set-doc-priority-handler.ts). Only the
  // operator can promote to HIGH via 🔴 emoji reaction or `clawcode rag
  // set-priority`.
  clawcode_rag_set_priority: {
    description:
      "Set the retrieval priority (medium/low) for a document you previously ingested. D-08 sandbox: agents are capped at MEDIUM; only the operator can promote to HIGH via 🔴 emoji reaction or `clawcode rag set-priority`.",
    ipcMethod: "set-doc-priority",
  },
  search_documents: {
    description:
      "Search the files, PDFs, screenshots and images that were uploaded or ingested for this agent. Returns exact chunks with provenance (filename, upload date, sender, channel, page) and the Source to filter on.",
    ipcMethod: "search-documents",
  },
  delete_document: {
    description: "Delete all chunks for an ingested document",
    ipcMethod: "delete-document",
  },
  list_documents: {
    description: "List all ingested document sources and total chunk count",
    ipcMethod: "list-documents",
  },
  // Cross-agent RPC / handoffs (Phase 59)
  delegate_task: {
    description: "Delegate a typed task to another agent. Returns a task_id immediately; the result arrives as a new turn. Prefer over send_to_agent when you need a structured, schema-validated payload with deadline + cost attribution.",
    ipcMethod: "delegate-task",
  },
  task_status: {
    description: "Check the status of a delegated task by task_id.",
    ipcMethod: "task-status",
  },
  cancel_task: {
    description: "Cancel an in-flight delegated task by task_id.",
    ipcMethod: "cancel-task",
  },
  task_complete: {
    description: "Signal completion of a delegated task you received. Provide the structured result matching the schema's output shape. Call this at the END of your turn -- the daemon dispatches the result back to the caller.",
    ipcMethod: "task-complete",
  },
  // Quick 260511-pw3 — schema introspection. Senders use this BEFORE
  // delegate_task so they don't take a blind shot at an unknown schema
  // (Admin Clawdy's 2026-05-11 `bug.report` failure mode).
  list_agent_schemas: {
    description:
      "List the task schemas a target agent accepts via delegate_task. Each entry includes `callerAllowed` (whether YOU are on the per-target allowlist) and `registered` (whether the schema YAML exists in the fleet registry). Both must be true for delegate_task to succeed. Call this BEFORE delegate_task to pick a valid schema.",
    ipcMethod: "list-agent-schemas",
  },
} as const;

/**
 * Phase 55 Plan 02 — per-agent tools config shape threaded through
 * `createMcpServer`. Mirrors `ResolvedAgentConfig.perf.tools` verbatim but
 * the whole block is optional (no agent context over stdio MCP transport).
 *
 * Inline type (no cross-module import of ToolsConfig from schema.ts) to
 * preserve server.ts's low-dep boundary.
 */
export type McpPerfTools = {
  readonly maxConcurrent: number;
  readonly idempotent: readonly string[];
  readonly slos?: Readonly<Record<string, {
    readonly thresholdMs: number;
    readonly metric?: "p50" | "p95" | "p99";
  }>>;
};

/**
 * Phase 55 Plan 02 — dependency-injection hooks for the cache wrapper.
 *
 * When `deps` is provided (daemon-hosted MCP path, where an active Turn is
 * available), the wrapped handlers consult `getActiveTurn()` to attach
 * cache lookups and `getAgentPerfTools()` to read the idempotent whitelist.
 *
 * When `deps` is undefined (stdio `clawcode mcp` path — no agent context),
 * the wrapper short-circuits to the legacy non-cached handler path. This
 * preserves backward compatibility with existing MCP clients.
 */
export type McpServerDeps = {
  readonly getActiveTurn?: (agentName: string) => Turn | null;
  readonly getAgentPerfTools?: (agentName: string) => McpPerfTools | undefined;
  /**
   * Phase 55 v1.7 cleanup — per-agent concurrency gate for capping in-flight
   * tool dispatches at `perf.tools.maxConcurrent`. When absent, no gate is
   * applied (concurrency is whatever the SDK/runtime dispatches).
   *
   * The gate's release function is returned from acquire — callers MUST call
   * it in a `finally` block to avoid leaks.
   */
  readonly acquireToolSlot?: (
    agentName: string,
  ) => Promise<() => void>;
};

/**
 * Cross-cutting helper — wrap a raw IPC handler with per-turn cache lookup
 * for whitelisted idempotent tools.
 *
 * Flow:
 *   1. If `deps` is absent OR no active Turn — run raw, no cache.
 *   2. Resolve whitelist from `perfTools.idempotent` ?? IDEMPOTENT_TOOL_DEFAULTS.
 *   3. If tool is whitelisted AND Turn.toolCache has a hit — return frozen
 *      cached value (raw handler NEVER runs).
 *   4. Else run raw handler. On SUCCESS + whitelisted — write to cache.
 *      On FAILURE — propagate; cache stays empty so retries re-run.
 *
 * Span metadata enrichment (`cached: true`) is performed by session-adapter
 * via hitCount delta detection — the wrapper has no direct span handle
 * because MCP handlers don't receive tool_use_id.
 *
 * Exported for direct unit-testing (see src/mcp/server.test.ts Phase 55
 * describe block).
 */
export async function invokeWithCache<R>(
  toolName: string,
  agentName: string,
  args: unknown,
  rawCall: () => Promise<R>,
  deps: McpServerDeps | undefined,
): Promise<R> {
  if (!deps?.getActiveTurn) return invokeWithConcurrencyGate(agentName, rawCall, deps);
  const turn = deps.getActiveTurn(agentName);
  if (!turn) return invokeWithConcurrencyGate(agentName, rawCall, deps);

  const perfTools = deps.getAgentPerfTools?.(agentName);
  const idempotent = perfTools?.idempotent ?? IDEMPOTENT_TOOL_DEFAULTS;
  const isIdempotent = idempotent.includes(toolName);

  if (isIdempotent) {
    const cached = turn.toolCache.get(toolName, args);
    if (cached !== undefined) {
      // Cache hit: no raw call, no concurrency slot needed
      return cached as R;
    }
  }

  const result = await invokeWithConcurrencyGate(agentName, rawCall, deps);
  if (isIdempotent) {
    turn.toolCache.set(toolName, args, result);
  }
  return result;
}

/**
 * Phase 55 v1.7 cleanup — gate a raw tool call through the per-agent
 * `ConcurrencyGate` when one is wired via `McpServerDeps.acquireToolSlot`.
 *
 * When `deps.acquireToolSlot` is undefined (stdio MCP path, or daemon running
 * without the gate hook), falls through to the raw call with no gating.
 *
 * The release function is called in a `finally` block so exceptions never
 * leak slots.
 */
async function invokeWithConcurrencyGate<R>(
  agentName: string,
  rawCall: () => Promise<R>,
  deps: McpServerDeps | undefined,
): Promise<R> {
  if (!deps?.acquireToolSlot) return rawCall();
  const release = await deps.acquireToolSlot(agentName);
  try {
    return await rawCall();
  } finally {
    release();
  }
}

/**
 * Phase 999.162 — MCP `_meta` key Claude Code honours to keep a tool loaded
 * in the prompt instead of deferring it behind ToolSearch.
 */
export const ALWAYS_LOAD_META_KEY = "anthropic/alwaysLoad";

/**
 * Create and configure the ClawCode MCP server.
 * Tools delegate to the daemon via the IPC client.
 *
 * Phase 55 Plan 02 — optional `deps` hooks thread per-agent Turn + perf.tools
 * config into the 4 whitelisted tool handlers (memory_lookup, search_documents,
 * memory_list, memory_graph — the latter two are not yet registered, but the
 * whitelist includes them for future-proofing). Non-whitelisted tools bypass
 * the cache unconditionally.
 *
 * @param deps Optional dependency-injection hooks. When absent (e.g. stdio
 *             MCP startMcpServer path), the wrapper falls back to the raw
 *             non-cached handler path.
 * @returns Configured McpServer ready for transport connection
 */
export function createMcpServer(
  deps?: McpServerDeps,
  /**
   * Phase 140 parity — the AUTHORITATIVE calling-agent identity. Set by the v3
   * standalone path (`startMcpServer` reads `CLAWCODE_AGENT`). When present it
   * OVERRIDES the self-reported caller params (`from` / parent `agent`) on the
   * sensitive comms/spawn tools, so a v3 agent cannot impersonate another over
   * the manager socket. `undefined` on the v2 in-process path → self-report
   * (unchanged). Memory-tool `agent` is left self-reported because the daemon
   * already enforces Phase-90 per-agent isolation on those.
   */
  selfAgentName?: string,
): McpServer {
  const server = new McpServer(
    {
      name: "clawcode",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // Phase 999.162 (WS-1) — per-tool always-load. Claude Code defers MCP tool
  // schemas behind ToolSearch unless a tool is pinned, and it reads the pin
  // from `_meta["anthropic/alwaysLoad"]` in tools/list (the per-tool twin of
  // the SDK's per-server `alwaysLoad`). Only the hot-path tools every agent
  // reaches for on turn 1 are pinned — the server-level pin Phase 999.54
  // D-03a put on the auto-injected `clawcode` entry loaded all ~48 schemas
  // (~78 KB) into every request of every agent. `update()` is silent here:
  // nothing is connected yet, so no list-changed notification goes out.
  const alwaysLoad = (tool: RegisteredTool): RegisteredTool => {
    tool.update({ _meta: { ...tool._meta, [ALWAYS_LOAD_META_KEY]: true } });
    return tool;
  };

  // C3 — attach this agent's spawn-injected capability token + authoritative
  // identity to every memory/document IPC payload so the daemon can reject
  // cross-agent impersonation. The caller identity is `selfAgentName` (the
  // authoritative spawn-injected `CLAWCODE_AGENT`, same trust basis as the
  // existing comms-tool override) when present; otherwise the self-reported
  // `agent` arg (v2 in-process path with no injected identity — the daemon
  // then fails open, preserving today's behaviour). When no token is present
  // the daemon fails open (trusted CLI/dashboard path).
  const withIdentity = <T extends Record<string, unknown>>(
    selfReportedAgent: string,
    payload: T,
  ): T & Record<string, unknown> => {
    const token = process.env[AGENT_TOKEN_ENV];
    const caller = selfAgentName ?? selfReportedAgent;
    if (token === undefined || token.length === 0) return payload;
    return {
      ...payload,
      [AGENT_TOKEN_PARAM]: token,
      [CALLER_AGENT_PARAM]: caller,
    };
  };

  // Tool: agent_status
  server.tool(
    "agent_status",
    "Get status of all ClawCode agents or a specific agent",
    { name: z.string().optional().describe("Agent name to filter by") },
    async ({ name }) => {
      const result = (await sendIpcRequest(SOCKET_PATH, "status", {})) as {
        entries: readonly { name: string; status: string; sessionId: string | null }[];
      };

      const entries = name
        ? result.entries.filter((e) => e.name === name)
        : result.entries;

      const text = entries
        .map((e) => `${e.name}: ${e.status}${e.sessionId ? ` (session: ${e.sessionId})` : ""}`)
        .join("\n");

      return { content: [{ type: "text" as const, text: text || "No agents found" }] };
    },
  );

  // Tools: ask_agent (canonical) + send_message (DEPRECATED alias)
  //
  // Phase 999.2 Plan 02 D-RNX-01 / D-RNX-04 — the MCP SDK does not support
  // tool aliases natively (server.tool throws on duplicate name). The
  // canonical alias pattern is to extract a shared schema + handler closure
  // and call server.tool() twice with different names. tools/list iterates
  // Object.entries(this._registeredTools) in INSERTION ORDER (verified
  // against node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:67-69),
  // so registering ask_agent FIRST controls LLM tool-list ordering — the
  // LLM sees the new name before the deprecated one.
  //
  // Behavior is unchanged from the pre-rename send_message tool. Plan 03
  // layers v2 sync-reply behavior on top by modifying askAgentHandler.
  // Phase 999.2 Plan 03 D-SYN-04 — `mirror_to_target_channel` extends the
  // schema with an optional boolean (default false). Both server.tool()
  // registrations share this object so the canonical and aliased tools stay
  // in lockstep automatically.
  const askAgentSchema = {
    to: z.string().describe("Target agent name"),
    content: z.string().describe("Message content"),
    from: z.string().default("mcp-client").describe("Sender name"),
    priority: z.enum(["normal", "high", "urgent"]).default("normal").describe("Message priority"),
    mirror_to_target_channel: z.boolean().default(false).describe(
      "When true, post the prompt + response as embeds in target's Discord channel for an audit trail.",
    ),
  } as const;

  // Phase 999.2 Plan 03 — v2 sync-reply behavior. See D-SYN-01..06:
  //   - When the target agent is running, surface its reply in the tool-result
  //     text so the caller's LLM can act on it (D-SYN-02 — fixes the
  //     2026-04-29 smoking-gun bug where the wrapper destructured
  //     {ok, messageId} and silently discarded result.response).
  //   - When the target is offline, render an explicit offline-text response
  //     so the caller knows the message was queued but not answered (D-SYN-03).
  //   - On dispatch error, render `Failed to ask {to}: {message}` so the
  //     caller (and the calling LLM) sees the failure rather than a
  //     false-success (D-SYN-05).
  const askAgentHandler = async ({
    to,
    content,
    from,
    priority,
    mirror_to_target_channel,
  }: {
    to: string;
    content: string;
    from: string;
    priority: "normal" | "high" | "urgent";
    mirror_to_target_channel: boolean;
  }) => {
    try {
      // The wire request uses the canonical IPC name `ask-agent` per
      // D-RNI-IPC-01. The daemon's stacked-case switch handles both names
      // (ask-agent + send-message) so the wire format is forward-compatible.
      const result = (await sendIpcRequest(SOCKET_PATH, "ask-agent", withIdentity(from, {
        // Phase 140 parity — authoritative identity wins over self-report.
        from: selfAgentName ?? from,
        to,
        content,
        priority,
        mirror_to_target_channel,
      }))) as { ok: boolean; messageId: string; response?: string };

      if (result.response !== undefined) {
        // D-SYN-02 — surface the reply in the tool-result text. THE BUG-FIX LINE.
        return {
          content: [{
            type: "text" as const,
            text: `Message sent to ${to} (id: ${result.messageId})\n\n${to} replied:\n${result.response}`,
          }],
        };
      }
      // D-SYN-03 — offline target.
      return {
        content: [{
          type: "text" as const,
          text: `Message queued in ${to}'s inbox. ${to} is not running — no synchronous reply.`,
        }],
      };
    } catch (err) {
      // D-SYN-05 — error propagation as plain tool-result text.
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Failed to ask ${to}: ${msg}` }],
      };
    }
  };

  // Register canonical name FIRST (D-RNX-04 — controls LLM tool-list order).
  server.tool(
    "ask_agent",
    "Ask another ClawCode agent a question and receive their reply synchronously. " +
      "Use this when you need a response — e.g., 'fin-client, what's our LTV target?'. " +
      "Set mirror_to_target_channel=true to post the Q+A as embeds in the target's channel for visibility.",
    askAgentSchema,
    askAgentHandler,
  );

  // Register deprecated alias SECOND. Same handler closure (object identity)
  // — calling either tool dispatches to the same code path.
  server.tool(
    "send_message",
    "[DEPRECATED — use ask_agent instead] " +
      "Backwards-compatibility alias for ask_agent. Identical behavior; " +
      "scheduled for removal once all agents have migrated (Phase 999.2 D-RNX-03).",
    askAgentSchema,
    askAgentHandler,
  );

  // Tool: list_schedules
  server.tool(
    "list_schedules",
    "Show all scheduled tasks across agents",
    {},
    async () => {
      const result = (await sendIpcRequest(SOCKET_PATH, "schedules", {})) as SchedulesIpcResult;
      return { content: [{ type: "text" as const, text: renderScheduleList(result) }] };
    },
  );

  // Tool: list_webhooks
  server.tool(
    "list_webhooks",
    "Show configured webhook identities for agents",
    {},
    async () => {
      const result = (await sendIpcRequest(SOCKET_PATH, "webhooks", {})) as {
        webhooks: readonly { agent: string; displayName: string; hasWebhookUrl: boolean }[];
      };

      if (result.webhooks.length === 0) {
        return { content: [{ type: "text" as const, text: "No webhook identities configured" }] };
      }

      const text = result.webhooks
        .map((w) => `${w.agent}: ${w.displayName} (${w.hasWebhookUrl ? "active" : "no url"})`)
        .join("\n");

      return { content: [{ type: "text" as const, text }] };
    },
  );

  // Tool: spawn_subagent_thread
  alwaysLoad(server.tool(
    "spawn_subagent_thread",
    "Spawn a subagent in a new Discord thread. If you pass `task`, the subagent starts working on it immediately and posts its response in the thread — you do NOT need to send a follow-up message. Use `delegateTo` to have a specialist agent (e.g., research-clawdy, fin-research) do the work using their config — useful when you want elevated thinking, opus-level reasoning, or specialist skills you don't have.",
    {
      agent: z.string().describe("Parent agent name"),
      threadName: z.string().describe("Name for the Discord thread"),
      model: z.enum(["sonnet", "opus", "haiku", "fable"]).optional().describe("Model for the subagent (fable = Claude Fable 5.1, the top tier above opus)"),
      systemPrompt: z.string().optional().describe("Custom system prompt (personality/role override; not the task)"),
      task: z.string().optional().describe("The task for the subagent to perform. When provided, the subagent starts working immediately and posts its response in the thread — no separate prompt needed."),
      autoRelay: z.boolean().optional().describe("Controls WHEN the subagent's completion summary is relayed to your (parent) main channel. CHOOSE BASED ON WHETHER THE TASK IS ONE-SHOT OR MULTI-TURN. Default: TRUE for non-delegated spawns, FALSE when `delegateTo` is set. **Pass `autoRelay: false` explicitly for ANY MULTI-TURN task** — anything where the subagent must work across several steps (e.g. read files → edit → run tests, multi-phase builds, research that spans tool calls). With `autoRelay: true` the relay fires the instant the subagent's FIRST SDK turn ends, so a multi-turn subagent would have its turn-1 output (an ack or a tool-use prelude) relayed to your main channel as if it were the finished deliverable. When you pass `autoRelay: false`, the subagent is expected to signal genuine completion itself by calling the `subagent_complete` MCP tool once the work is actually done — and the summary reaches your main channel as soon as it does. If the subagent forgets, the daemon's gated quiescence sweep relays the summary automatically after the thread has been idle for the configured `quiescenceMinutes` (default 5) once delivery has drained — but explicit signalling is faster. Leave `autoRelay` at its TRUE default ONLY for genuine one-shot Q&A where the subagent's first reply truly IS the complete deliverable. When the relay fires you'll see 'subagent done — here's what it found' in your main channel without polling the thread. autoArchive=true implies autoRelay=true (use autoArchive only for one-shot fire-and-forget tasks)."),
      autoArchive: z.boolean().optional().describe("Fire-and-forget pattern. When true, after the subagent posts its initial reply: (1) summary is relayed to your main channel (autoRelay), (2) the Discord thread is archived, (3) the subagent session is stopped. Best paired with `task` for short-lived 'do one thing then go away' subagents. Default: false (interactive — operator can keep replying in the thread)."),
      delegateTo: z.string().optional().describe("Optional. When set to a target agent name (e.g., 'fin-research', 'research', 'code-clawdy'), the spawned subagent uses the target's config (model, soul, skills) instead of yours. The thread still spawns in your channel, autoRelay still summarizes back to your main channel — but the work is done with the target agent's identity. Use this to delegate elevated-thinking work (research, coding) to a dedicated specialist standing agent."),
    },
    async ({ agent, threadName, model, systemPrompt, task, autoRelay, autoArchive, delegateTo }) => {
      try {
        const result = (await sendIpcRequest(SOCKET_PATH, "spawn-subagent-thread", withIdentity(agent, {
          // Phase 140 parity — authoritative identity wins over self-report.
          parentAgent: selfAgentName ?? agent,
          threadName,
          model,
          systemPrompt,
          task,
          autoRelay: autoRelay ?? true,
          autoArchive: autoArchive ?? false,
          delegateTo,
        }))) as { threadId: string; sessionName: string; parentAgent: string; channelId: string };

        const text = [
          `Thread URL: https://discord.com/channels/@me/${result.threadId}`,
          `Session: ${result.sessionName}`,
          `Parent Agent: ${result.parentAgent}`,
          `Channel: ${result.channelId}`,
        ].join("\n");

        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text" as const, text: `Error: ${message}` }] };
      }
    },
  ));

  // Phase 999.25 — subagent_complete tool. The subagent calls this
  // when its delegated work is done; relay fires immediately instead
  // of waiting for the session to be stopped (which today defers
  // delivery by hours).
  server.tool(
    "subagent_complete",
    "Signal that this subagent has finished its delegated work. Posts your final answer to the parent agent's channel right away (instead of waiting until your session is stopped) and prevents duplicate relays. Call this exactly once, after your last substantive message in the thread. agentName MUST be your own session name (e.g. 'fin-client-via-fin-research-AbC123' — typically the parent passed it in your spawn task description, or it's available as your agent identity). Idempotent: safe to call more than once.",
    {
      agentName: z
        .string()
        .describe(
          "Your own session name (the subagent thread session, e.g. 'fin-client-via-fin-research-AbC123')",
        ),
    },
    async ({ agentName }) => {
      try {
        // Don't surface the IPC's internal {ok, reason} to the model. The
        // subagent has no actionable response to any reason, and the model
        // will parrot strings like "delivery-not-confirmed" into its prose
        // — which then reaches the operator's chat through the quiescence
        // sweep relay. Daemon logs already carry the full diagnostic
        // picture via `subagent-completion-relay-skipped`.
        await sendIpcRequest(SOCKET_PATH, "subagent-complete", { agentName });
        return {
          content: [{ type: "text" as const, text: "Completion signaled." }],
        };
      } catch (error) {
        // IPC-level errors (socket missing, daemon down) are distinct from
        // a semantic relay-skipped reason — surface them so the model
        // knows the IPC itself failed.
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: "text" as const, text: `Error: ${message}` },
          ],
        };
      }
    },
  );

  // Tool: steer_subagent — auto-steer Path B (2026-05-23).
  //
  // When the operator gives you new guidance in your main channel that
  // applies to a running subagent's task, DO NOT cancel-and-respawn.
  // Call this tool with the subagent's threadId and the new guidance —
  // the daemon will interrupt the subagent's in-flight turn, reset the
  // relay gates so the half-delivered partial doesn't relay, and
  // dispatch the new guidance as the subagent's next turn (preserving
  // its session memory, tool state, and prior thread output).
  //
  // Use this any time the operator gives you redirection like
  // "actually use Chrome instead", "skip the X step", "also include Y",
  // etc. while your subagent is mid-task.
  server.tool(
    "steer_subagent",
    "Redirect a running subagent without canceling and respawning. Use this when the operator gives new guidance about a subagent's in-flight task — the daemon interrupts the current turn, the subagent's session memory + file-system context + tool state are preserved, and the new guidance becomes the next turn. Far better than spawning a new subagent: the subagent integrates the new directive with the work it has already done. Returns confirmation that the steer was dispatched.",
    {
      threadId: z
        .string()
        .describe(
          "Discord thread ID of the subagent to steer (from spawn_subagent_thread result, or read_thread).",
        ),
      guidance: z
        .string()
        .describe(
          "The new directive for the subagent. Be specific about what changed: e.g., 'use Chrome headless PDF instead of WeasyPrint — WeasyPrint is banned going forward', or 'skip step 3 (license check), the operator confirmed it's not needed'. The subagent will see this as <operator-steering>-framed input and integrate it with prior work.",
        ),
      reason: z
        .string()
        .optional()
        .describe(
          "Optional short reason shown in the subagent's thread (e.g. 'switching pdf tool'). One-liner; the operator and any thread readers see this attribution alongside your name.",
        ),
    },
    async ({ threadId, guidance, reason }) => {
      try {
        const result = (await sendIpcRequest(SOCKET_PATH, "steer-subagent", {
          threadId,
          guidance,
          reason,
        })) as {
          ok: boolean;
          reason?: string;
          detail?: string | null;
          sessionName?: string;
          interrupted?: boolean;
          hadActiveTurn?: boolean;
          messageId?: string;
        };
        if (!result.ok) {
          const lines = [
            `Steer NOT dispatched — reason: ${result.reason ?? "unknown"}`,
            result.detail ? `Detail: ${result.detail}` : null,
            result.reason === "terminal"
              ? "The subagent has already completed — spawn a new thread for new work."
              : null,
            result.reason === "no-binding"
              ? "Unknown threadId — verify it came from spawn_subagent_thread."
              : null,
          ].filter((l): l is string => l !== null);
          return {
            content: [{ type: "text" as const, text: lines.join("\n") }],
          };
        }
        const lines = [
          `Steer dispatched to ${result.sessionName ?? "(unknown)"}.`,
          `Active turn interrupted: ${result.interrupted ? "yes" : "no"} (had active turn: ${result.hadActiveTurn ? "yes" : "no"})`,
          `The subagent will integrate your guidance with prior work and continue.`,
        ];
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // Tool: post_cv2_embed — Discord Components v2 embed to the agent's
  // bound channel. Bypasses the normal text-posting path. After calling
  // this tool, ack the operator's message via clawcode_ack with EMPTY
  // result so the daemon's response posting skip-on-empty
  // (bridge.ts response.trim().length > 0 gate) suppresses a duplicate
  // text follow-up — otherwise you get the CV2 message AND a text post.
  server.tool(
    "post_cv2_embed",
    "Post a Discord Components v2 (CV2) card to your bound channel. Use when a skill instructs you to deliver a structured layout (task board, status card, product picks, charts) rather than freeform prose. Spec is a single Container with sequential blocks: `text` (markdown), `separator`, `section` (1-3 lines with a thumbnail image or a link button on the right), `media` (an image gallery of 1-10 files, INSIDE the container), `file` (a downloadable attachment inside the container), and `actions` (a row of up to 5 link buttons). Images and files come from `files[]`: list workspace paths there and refer to each by its basename (or its `name`) from a media item, file block or thumb accessory — every referenced name must be present or the post is refused. Limits: 40 blocks, 4000 chars per text block and 4000 total, 10 files of 25 MiB each. After this tool returns ok, call clawcode_ack with EMPTY `result` so the daemon does not post a duplicate text follow-up.",
    {
      agentName: z.string().describe("Your own agent name (so the daemon resolves the right channel binding)."),
      // 2026-09-10 — the block union used to be `text | separator` only,
      // so `{"type":"media"}` failed with -32602 "No matching discriminator"
      // while the renderer had supported media/section/file/actions since
      // 999.135. The schema now lives in cv2-spec-schema.ts (unit-tested the
      // way an agent probes it) and `files[]` carries the attachments.
      spec: CV2_SPEC_SCHEMA,
      files: CV2_FILES_SCHEMA.optional(),
    },
    async ({ agentName, spec, files }) => {
      try {
        // C3 identity token: `files[]` makes `agentName` a key into that
        // agent's private roots, so the daemon must be able to reject a
        // caller naming someone else. Same wrap as the memory/document tools.
        const result = (await sendIpcRequest(SOCKET_PATH, "post-cv2-embed", withIdentity(agentName, {
          agentName,
          spec,
          ...(files && files.length > 0 ? { files } : {}),
        }))) as
          | { ok: true; messageId: string }
          | { ok: false; reason: string; detail: string };
        if (result.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `CV2 embed posted (messageId: ${result.messageId}). Now call clawcode_ack with result: "" to suppress the text follow-up.`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `CV2 embed NOT posted — reason: ${result.reason}. Detail: ${result.detail}. Fall back to prose for this response.`,
            },
          ],
          isError: true,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // Tool: read_thread
  server.tool(
    "read_thread",
    "Read recent messages from a Discord thread. Use this after spawning a subagent with spawn_subagent_thread to see what it has posted. Returns messages oldest-first.",
    {
      threadId: z.string().describe("Discord thread ID (from spawn_subagent_thread result)"),
      limit: z.number().int().min(1).max(100).default(20).describe("Max messages to return (1-100, default 20)"),
    },
    async ({ threadId, limit }) => {
      try {
        const result = (await sendIpcRequest(SOCKET_PATH, "read-thread", withIdentity(selfAgentName ?? "", {
          threadId,
          limit,
        }))) as {
          threadId: string;
          threadName: string | null;
          messageCount: number;
          messages: ReadonlyArray<{
            id: string;
            author: string;
            bot: boolean;
            webhookId: string | null;
            content: string;
            embedFooter: string | null;
            createdAt: string;
            attachmentCount: number;
          }>;
        };
        if (result.messages.length === 0) {
          return { content: [{ type: "text" as const, text: `Thread '${result.threadName ?? result.threadId}' has no messages yet.` }] };
        }
        const header = `Thread: ${result.threadName ?? result.threadId} (${result.messageCount} messages)\n${"─".repeat(60)}`;
        const body = result.messages.map((m) => {
          const who = m.embedFooter ?? (m.bot ? `${m.author} [bot]` : m.author);
          const ts = m.createdAt.slice(0, 19).replace("T", " ");
          const attach = m.attachmentCount > 0 ? `  [${m.attachmentCount} attachment${m.attachmentCount === 1 ? "" : "s"}]` : "";
          return `[${ts}] ${who}:${attach}\n${m.content}`;
        }).join("\n\n");
        return { content: [{ type: "text" as const, text: `${header}\n${body}` }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Failed to read thread: ${msg}` }], isError: true };
      }
    },
  );

  // Tool: archive_thread
  //
  // Phase 100 follow-up — closes the operator-surfaced gap (2026-04-26):
  // "I don't have a tool to archive Discord threads." Wraps the daemon's
  // SubagentThreadSpawner.archiveThread which (a) calls Discord's setArchived
  // (and optionally setLocked) and (b) auto-prunes the thread-bindings.json
  // registry entry so maxThreadSessions accounting reflects reality.
  server.tool(
    "archive_thread",
    "Archive a Discord thread (close it without deleting). Use this when a subagent task is complete and the thread is no longer needed. Also auto-prunes the bindings registry so the parent agent can spawn new threads up to its maxThreadSessions cap. Pass `lock: true` to prevent further messages.",
    {
      threadId: z.string().describe("Discord thread ID to archive"),
      lock: z.boolean().optional().describe("Also lock the thread (prevents new messages even from operator). Default: false."),
    },
    async ({ threadId, lock }) => {
      try {
        const result = (await sendIpcRequest(SOCKET_PATH, "archive-discord-thread", {
          threadId,
          lock: lock ?? false,
        })) as { ok: boolean; bindingPruned: boolean };
        const text = result.bindingPruned
          ? `Thread ${threadId} archived${lock ? " + locked" : ""}; binding pruned from registry.`
          : `Thread ${threadId} archived${lock ? " + locked" : ""}; no binding existed in registry (already cleaned).`;
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Failed to archive thread: ${msg}` }], isError: true };
      }
    },
  );

  // Tool: schedule_reminder
  //
  // Phase 100 follow-up — operator-surfaced 2026-04-27. Closes the
  // "no scheduling primitive" gap where agents promised "ping me at 7:58
  // PM" but the reminder leaked into context and bled into the next
  // inbound turn. Routes through SchedulerSource → TriggerEngine → the
  // f984008 trigger-delivery callback, so the reply posts as a standalone
  // turn in the agent's bound channel.
  server.tool(
    "schedule_reminder",
    "Schedule a one-off reminder. At the specified time, you'll receive a synthetic turn with the given prompt — your response posts to your bound channel via webhook. Use this for 'ping me in 15 min' / 'check back at 7:58 PM' patterns. The reminder is in-memory only — does not survive daemon restart, so caveat the operator if a restart is imminent.",
    {
      agent: z.string().describe("Your agent name (pass your own name)"),
      at: z.string().describe("When to fire. ISO 8601 (e.g. '2026-04-27T19:58:00-07:00') OR relative ('in 15 min', 'in 2 hours', 'in 30s', 'in 3 days')"),
      prompt: z.string().describe("Message you'll receive when the reminder fires (becomes the turn payload)"),
    },
    async ({ agent, at, prompt }) => {
      try {
        const result = (await sendIpcRequest(SOCKET_PATH, "schedule-reminder", withIdentity(agent, {
          agent,
          at,
          prompt,
        }))) as { ok: boolean; reminderId: string; fireAt: string };
        return {
          content: [{ type: "text" as const, text: `Reminder ${result.reminderId} scheduled for ${result.fireAt}.` }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Failed to schedule reminder: ${msg}` }], isError: true };
      }
    },
  );

  // Tool: schedule_recurring
  //
  // Phase 999.99 — the recurring twin of schedule_reminder. Closes the
  // "poll X every N min" buffering bug: a self-scheduled turn's plain text
  // output buffers in the shared driverIter and drains one-per-inbound-message
  // (never reaching Discord on its own). This registers a DELIVERED recurring
  // schedule whose every tick routes SchedulerSource → TriggerEngine → the
  // f984008 trigger-delivery callback, so each tick posts as a standalone turn
  // in the agent's bound channel.
  //
  // Accepts a raw `cron` string OR a friendly `interval` ("every 5 min" /
  // "every 2 hours"). The friendly form is range-constrained daemon-side to
  // dodge the slash-90 croner-crash vector; an invalid cron / out-of-range
  // interval returns a clean isError result, never a crash.
  server.tool(
    "schedule_recurring",
    "Register a recurring schedule. Each tick fires a synthetic turn with the given prompt and your response posts to your bound channel via the trigger-delivery path. Use this for recurring 'poll X every N min' work so each tick posts to your channel as a standalone message — do NOT rely on plain text output from a self-scheduled turn landing in Discord; it does not. Provide either a friendly 'interval' or a raw 'cron'. The schedule is DURABLE — it persists across daemon restarts and resumes automatically (forward-only: it does not back-fire ticks missed while the daemon was down). Cancel it with cancel_schedule using the returned scheduleId.",
    {
      agent: z.string().describe("Your agent name (pass your own name)"),
      interval: z
        .string()
        .optional()
        .describe("Friendly: 'every 5 min' (1-59) or 'every 2 hours' (1-23)"),
      cron: z
        .string()
        .optional()
        .describe("Raw 5-field cron — use for anything the friendly form can't express"),
      prompt: z.string().describe("Message you'll receive each tick (becomes the turn payload)"),
    },
    async ({ agent, interval, cron, prompt }) => {
      try {
        const result = (await sendIpcRequest(SOCKET_PATH, "schedule-recurring", withIdentity(agent, {
          agent,
          interval,
          cron,
          prompt,
        }))) as { ok: boolean; scheduleId: string; cron: string };
        return {
          content: [
            {
              type: "text" as const,
              text: `Recurring schedule ${result.scheduleId} registered (cron '${result.cron}'). Durable — persists across daemon restarts (resumes automatically; does not back-fire missed ticks). Cancel with cancel_schedule.`,
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Failed to schedule recurring: ${msg}` }], isError: true };
      }
    },
  );

  // Tool: cancel_schedule
  //
  // Phase 999.99 — cancel a runtime recurring schedule by the scheduleId
  // returned from schedule_recurring (surfaces in list_schedules). Closes the
  // SC-4 loop: register → list → cancel.

  server.tool(
    "cancel_schedule",
    "Cancel a runtime recurring schedule by its scheduleId (the id returned from schedule_recurring, also shown in list_schedules).",
    {
      agent: z.string().describe("Your agent name (pass your own name)"),
      scheduleId: z.string().describe("The scheduleId returned from schedule_recurring"),
    },
    async ({ agent, scheduleId }) => {
      try {
        const result = (await sendIpcRequest(SOCKET_PATH, "cancel-schedule", {
          agent,
          scheduleId,
        })) as { ok: boolean; cancelled: boolean };
        return {
          content: [
            {
              type: "text" as const,
              text: result.cancelled
                ? `Schedule ${scheduleId} cancelled.`
                : `Schedule ${scheduleId} not found.`,
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Failed to cancel schedule: ${msg}` }], isError: true };
      }
    },
  );

  // Tool: ask_user_question
  //
  // Phase 145 WS3 (Plan 04) — the interactive-question replacement for the
  // disallowed built-in AskUserQuestion. The MCP tool + IPC contract are
  // PLATFORM-NEUTRAL ({questions} → {answers}); the daemon resolves the
  // agent's bound channel + platform and renders natively (Discord buttons
  // today) or via the universal numbered text fallback (Slack/others), then
  // blocks on a daemon-owned bounded timeout until the channel operator
  // answers. Mirrors schedule_recurring's server.tool + sendIpcRequest shape.
  //
  // zod schema enforces the real AskUserQuestion bounds: 1..4 questions, each
  // with a header + ≥1 labelled option + an optional multiSelect. ids are
  // optional in the tool input (the daemon fills stable ids when omitted) so
  // the model can pass a minimal {header, options:[{label}]} shape.
  server.tool(
    "ask_user_question",
    "Ask the channel operator a multiple-choice question and BLOCK until they answer. This is the interactive replacement for the built-in AskUserQuestion tool (which is disabled). Renders as buttons/menus in your Discord channel (numbered text elsewhere) and returns the operator's structured selection. Provide 1-4 questions, each with a short header and labelled options; set multiSelect:true to let them pick more than one. Returns cleanly (a timeout/no-operator note) if no one answers — it never hangs your turn. Use sparingly, only when you genuinely need an operator decision to proceed.",
    {
      agent: z.string().describe("Your agent name (pass your own name)"),
      questions: z
        .array(
          z.object({
            id: z.string().optional().describe("Stable id (auto-filled if omitted)"),
            header: z.string().min(1).describe("The question prompt / heading"),
            text: z.string().optional().describe("Optional longer body under the header"),
            options: z
              .array(
                z.object({
                  id: z.string().optional().describe("Stable option id (auto-filled if omitted)"),
                  label: z.string().min(1).describe("Button / row label shown to the operator"),
                  description: z.string().optional().describe("Optional longer option blurb"),
                }),
              )
              .min(1)
              .max(25)
              .describe("The selectable options (1-25)"),
            multiSelect: z
              .boolean()
              .optional()
              .describe("Allow picking more than one option"),
          }),
        )
        .min(1)
        .max(4)
        .describe("1-4 questions to ask the operator"),
    },
    async ({ agent, questions }) => {
      try {
        // Fill stable ids for any question/option the model left unlabelled so
        // the answers can round-trip by id (the daemon also defends this).
        const normalized = questions.map((q, qi) => ({
          id: q.id ?? `q${qi + 1}`,
          header: q.header,
          ...(q.text !== undefined ? { text: q.text } : {}),
          multiSelect: q.multiSelect ?? false,
          options: q.options.map((o, oi) => ({
            id: o.id ?? `q${qi + 1}o${oi + 1}`,
            label: o.label,
            ...(o.description !== undefined ? { description: o.description } : {}),
          })),
        }));

        const result = (await sendIpcRequest(SOCKET_PATH, "ask-user-question", {
          agent,
          questions: normalized,
        })) as IpcAskUserQuestionResult;

        if (!result.ok) {
          const reasonText =
            result.reason === "timeout"
              ? "The question timed out — the operator did not answer in time."
              : result.reason === "no-operator"
                ? "No authorized operator is configured to answer (set CLAWCODE_ASK_USER_AUTHORIZED_IDS)."
                : result.reason === "unsupported"
                  ? "This agent's channel cannot render the question."
                  : `The question could not be answered: ${result.reason}`;
          return { content: [{ type: "text" as const, text: reasonText }], isError: true };
        }

        // Render the answers as a compact, model-readable summary keyed by
        // questionId → the chosen option label(s).
        const lines = result.answers.answers.map((a) => {
          const q = normalized.find((nq) => nq.id === a.questionId);
          const labels = a.selectedOptionIds.map((oid) => {
            const opt = q?.options.find((o) => o.id === oid);
            return opt ? opt.label : oid;
          });
          const header = q ? q.header : a.questionId;
          return `- ${header}: ${labels.join(", ")}`;
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `The operator answered:\n${lines.join("\n")}`,
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Failed to ask the operator: ${msg}` }], isError: true };
      }
    },
  );

  // Tool: start_workflow
  //
  // Phase 145 WS2 (Plan 05) — run a long multi-step / parallel job as a daemon
  // BACKGROUND workflow, decoupled from this turn. The daemon allocates a
  // `wf_…` id and spawns one worker sub-session per parallel step (each with a
  // lifted turn-duration ceiling so a worker is not killed at 20 min), then
  // RETURNS THE ID IMMEDIATELY — this tool does NOT block on completion. The
  // triggering turn settles in seconds, so none of the turn watchdogs ever see
  // the workflow's wall-clock duration (the SC-2 mechanism). Mirrors
  // schedule_recurring's server.tool + sendIpcRequest shape.
  //
  // FAN-IN (progress + final results posting back to your channel) is delivered
  // ASYNCHRONOUSLY by the daemon. Do NOT keep this turn open waiting for the
  // result — end your turn after calling this; progress arrives later.
  // 999.106 W-2 — one step schema shared by the legacy `steps` shape and the
  // waved `waves` shape (they must never drift).
  const workflowStepSchema = z.object({
    stepId: z
      .string()
      .min(1)
      .describe("Short identifier for this step (e.g. 'fetch-filings')"),
    prompt: z
      .string()
      .min(1)
      .describe("What this worker should do — its full task instructions"),
    mcpServers: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "OPTIONAL memory saver: MCP server NAMES this step's worker keeps " +
          "(narrowing only — never grants beyond your own roster). Pass [] for a " +
          "tool-free worker (text-only analysis/synthesis steps need no servers " +
          "and spawn far lighter). Omit to inherit your full server set.",
      ),
  });

  server.tool(
    "start_workflow",
    "Run a long multi-step or parallel job as a BACKGROUND workflow instead of doing it inline in this turn. If the operator has configured a named template for the job (see the workflow_templates tool), pass `template` (+ `params`) instead of authoring steps. Use this for work that would otherwise take many minutes (research fan-out, multi-source gathering, batch processing) — each step runs as its own worker session with a lifted time limit, so the job is NOT bound by the normal per-turn duration cap. This returns IMMEDIATELY with a workflow id; it does NOT wait for the work to finish. End your turn after calling it — progress and results post to your channel asynchronously, AND each completed step's full result is saved to workflows/<workflow-id>/<NN>-<stepId>.md in your workspace (plus summary.json with per-step status). For follow-up processing, read those files from disk instead of re-parsing the channel post. SHAPE — pass exactly ONE of: `steps` (a single parallel group of 1-8 steps) or `waves` (ordered groups for staged work: gather in parallel → synthesize → gather more; up to 6 waves, each 1-8 parallel steps, 24 steps total). Waves run strictly in order — wave K finishes completely before wave K+1 starts — and every wave-2+ worker AUTOMATICALLY receives the concrete file paths of earlier steps' saved results as context (you cannot know the workflow id when authoring prompts, so do NOT hardcode workflows/... paths; just tell later-wave steps to read the earlier-result files listed in their context). The WHOLE workflow (all waves) must fit the ~4h wall-clock ceiling. CONCURRENCY: workers share a small FLEET-WIDE pool (default 3 concurrent, across ALL agents and ALL workflows), so steps beyond the pool queue first-come-first-served and start as slots free up. Prefer 3-4 substantial steps per wave over many small ones, and if you launch several workflows at once expect them to share the same pool. Steps that cannot get a worker within the admission window are marked failed and reported in the final summary.",
    {
      agent: z.string().describe("Your agent name (pass your own name)"),
      steps: z
        .array(workflowStepSchema)
        .min(1)
        .max(8)
        .optional()
        .describe(
          "1-8 parallel steps to run as background workers (a single wave). " +
            "Pass EITHER this OR `waves`, never both.",
        ),
      waves: z
        .array(z.array(workflowStepSchema).min(1).max(8))
        .min(1)
        .max(6)
        .refine(
          (ws) => ws.reduce((n, w) => n + w.length, 0) <= 24,
          { message: "waves exceed the 24-total-step cap" },
        )
        .optional()
        .describe(
          "Ordered waves (each an array of 1-8 parallel steps; ≤6 waves, ≤24 " +
            "steps total). Wave K completes before wave K+1 starts. Pass EITHER " +
            "this OR `steps`, never both.",
        ),
      template: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Launch a NAMED workflow template instead of authoring steps " +
            "(list them with the workflow_templates tool). Pass this INSTEAD of steps/waves.",
        ),
      params: z
        .record(z.string(), z.string())
        .optional()
        .describe("Values for the template's {{param}} placeholders, e.g. { ticker: \"NVDA\" }."),
    },
    async ({ agent, steps, waves, template, params }) => {
      try {
        // Exactly one shape — a crisp client-side error beats a round-trip to
        // the daemon's invalid-spec (the daemon re-validates regardless).
        // Phase 999.128 — `template` is the third shape.
        const shapes = [steps !== undefined, waves !== undefined, template !== undefined].filter(Boolean).length;
        if (shapes !== 1) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Could not start the workflow: pass exactly one of `steps`, `waves` or `template`.",
              },
            ],
            isError: true,
          };
        }
        const result = (await sendIpcRequest(SOCKET_PATH, "start-workflow", withIdentity(agent, {
          agent,
          ...(template !== undefined
            ? { template, ...(params !== undefined ? { params } : {}) }
            : { spec: waves !== undefined ? { waves } : { steps } }),
        }))) as IpcStartWorkflowResult;

        if (!result.ok) {
          const reasonText =
            result.reason === "unknown-agent"
              ? "Could not start the workflow: agent not found."
              : result.reason === "invalid-spec"
                ? `Could not start the workflow: ${result.message ?? "the spec is malformed — empty step/wave list, a wave over 8 steps, more than 6 waves, more than 24 steps total, an empty stepId/prompt, or an empty mcpServers name."}`
                : result.message
                  ? `Could not start the workflow: ${result.message}`
                  : `Could not start the workflow: ${result.reason}`;
          return { content: [{ type: "text" as const, text: reasonText }], isError: true };
        }

        return {
          content: [
            {
              type: "text" as const,
              text:
                `${result.message}\n\nCheck on it with workflow_status; redirect it with steer_workflow or edit_workflow; ` +
                `stop it (or one step) with cancel_workflow.`,
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Failed to start workflow: ${msg}` }], isError: true };
      }
    },
  );

  // Tool: workflow_status — Phase 999.165. Your own workflows (an admin agent
  // sees the fleet); the daemon enforces ownership from the identity token.
  server.tool(
    "workflow_status",
    "See your background workflows started with start_workflow. Without workflowId: id, status, steps done/running/failed, current wave and age of each. With workflowId: every step (by wave) with its status, how long it has run, what it is doing right now, and an ETA for the whole workflow.",
    {
      agent: z.string().describe("Your agent name (pass your own name)"),
      workflowId: z.string().min(1).optional().describe("Show this workflow in detail (e.g. wf_83Ndpj)"),
    },
    async ({ agent, workflowId }) => {
      try {
        if (workflowId !== undefined) {
          const one = (await sendIpcRequest(
            SOCKET_PATH,
            "workflow-status",
            withIdentity(agent, { agent, workflowId }),
          )) as { workflow: WorkflowDetail | null };
          if (!one.workflow) {
            return {
              content: [{ type: "text" as const, text: `No workflow ${workflowId} is running (finished workflows are forgotten after a while).` }],
              isError: true,
            };
          }
          return { content: [{ type: "text" as const, text: renderWorkflowDetailText(one.workflow) }] };
        }
        const result = (await sendIpcRequest(
          SOCKET_PATH,
          "workflow-status",
          withIdentity(agent, { agent }),
        )) as { workflows: WorkflowSummary[] };
        return { content: [{ type: "text" as const, text: renderWorkflowListText(result.workflows) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Could not read workflow status: ${msg}` }], isError: true };
      }
    },
  );

  // Tool: cancel_workflow — Phase 999.165. Stops the whole workflow, or one
  // step of it (the rest carries on). Only your own workflows (admin exempt).
  server.tool(
    "cancel_workflow",
    "Stop one of YOUR background workflows (the wf_… id from start_workflow or workflow_status). Without stepId the whole workflow stops: running steps are aborted, steps not yet started are skipped, nothing is retried, and finished steps keep their saved results. With stepId only that step stops (or is skipped if it has not started) and the rest carries on. Give a short reason — it is shown in the channel.",
    {
      agent: z.string().describe("Your agent name (pass your own name)"),
      workflowId: z.string().min(1).describe("The workflow id, e.g. wf_83Ndpj"),
      stepId: z.string().min(1).optional().describe("Stop only this step (its stepId)"),
      reason: z.string().max(200).optional().describe("Short reason shown in the channel"),
    },
    async ({ agent, workflowId, stepId, reason }) => {
      try {
        const result = (await sendIpcRequest(
          SOCKET_PATH,
          "cancel-workflow",
          withIdentity(agent, {
            agent,
            workflowId,
            ...(stepId !== undefined ? { stepId } : {}),
            ...(reason !== undefined ? { reason } : {}),
          }),
        )) as WorkflowCancelResult;
        const failed = result.status === "not-found" || result.status === "step-not-found";
        return {
          content: [{ type: "text" as const, text: renderCancelResultText(workflowId, result) }],
          ...(failed ? { isError: true } : {}),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Could not cancel ${workflowId}: ${msg}` }], isError: true };
      }
    },
  );

  // Tool: steer_workflow — Phase 999.165. Redirect a running workflow without
  // stopping it. Only your own workflows (admin exempt).
  server.tool(
    "steer_workflow",
    "Give one of YOUR running background workflows new direction without stopping it. A running step receives the guidance inside its current turn when its session supports that; otherwise (or with restart: true) that step restarts with the guidance added — at most 3 restarts per step, and a restart discards that attempt's progress. Steps that have not started get the guidance added to their instructions. Omit stepId to steer every running and pending step.",
    {
      agent: z.string().describe("Your agent name (pass your own name)"),
      workflowId: z.string().min(1).describe("The workflow id, e.g. wf_83Ndpj"),
      guidance: z.string().min(1).max(1500).describe("What should change — written as an instruction to the step"),
      stepId: z.string().min(1).optional().describe("Steer only this step"),
      restart: z.boolean().optional().describe("Restart running steps with the guidance instead of injecting it"),
    },
    async ({ agent, workflowId, guidance, stepId, restart }) => {
      try {
        const result = (await sendIpcRequest(
          SOCKET_PATH,
          "steer-workflow",
          withIdentity(agent, {
            agent,
            workflowId,
            guidance,
            ...(stepId !== undefined ? { stepId } : {}),
            ...(restart === true ? { restart: true } : {}),
          }),
        )) as WorkflowSteerResult;
        return {
          content: [{ type: "text" as const, text: renderSteerResultText(workflowId, result) }],
          ...(result.status === "steered" ? {} : { isError: true }),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Could not steer ${workflowId}: ${msg}` }], isError: true };
      }
    },
  );

  // Tool: edit_workflow — Phase 999.165. Change the plan of a running workflow.
  server.tool(
    "edit_workflow",
    "Change the plan of one of YOUR running background workflows. op=add_step adds a step (wave: current = join the wave that is running now, next = the following wave, new = a new final wave; same limits as start_workflow: 8 steps per wave, 24 total, 6 waves). op=replace_step gives a step new instructions: a step that has not started runs with them; a running step needs restart: true. op=remove_step stops a running step or skips one that has not started. Later-wave steps automatically get the earlier steps' saved result files as context.",
    {
      agent: z.string().describe("Your agent name (pass your own name)"),
      workflowId: z.string().min(1).describe("The workflow id, e.g. wf_83Ndpj"),
      op: z.enum(["add_step", "replace_step", "remove_step"]),
      stepId: z.string().min(1).max(64).describe("The step to add, replace or remove"),
      prompt: z.string().min(1).optional().describe("The step's full instructions (add_step, replace_step)"),
      wave: z.enum(["current", "next", "new"]).optional().describe("add_step only — where the step goes (default next)"),
      mcpServers: z.array(z.string().min(1)).optional().describe("add_step only — narrow the step's MCP servers ([] = none)"),
      restart: z.boolean().optional().describe("replace_step only — restart a RUNNING step with the new instructions"),
      reason: z.string().max(200).optional().describe("remove_step only — short reason shown in the channel"),
    },
    async ({ agent, workflowId, op, stepId, prompt, wave, mcpServers, restart, reason }) => {
      if ((op === "add_step" || op === "replace_step") && prompt === undefined) {
        return { content: [{ type: "text" as const, text: `${op} needs a prompt.` }], isError: true };
      }
      try {
        const result = (await sendIpcRequest(
          SOCKET_PATH,
          "edit-workflow",
          withIdentity(agent, {
            agent,
            workflowId,
            op,
            stepId,
            ...(prompt !== undefined ? { prompt } : {}),
            ...(wave !== undefined ? { wave } : {}),
            ...(mcpServers !== undefined ? { mcpServers } : {}),
            ...(restart === true ? { restart: true } : {}),
            ...(reason !== undefined ? { reason } : {}),
          }),
        )) as WorkflowEditResult;
        const ok = result.status === "replaced" || result.status === "added" || result.status === "step-stopped" || result.status === "step-will-skip";
        return {
          content: [{ type: "text" as const, text: renderEditResultText(workflowId, result) }],
          ...(ok ? {} : { isError: true }),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Could not edit ${workflowId}: ${msg}` }], isError: true };
      }
    },
  );

  // Tools: client_fact_set / client_facts (Phase 999.132) — per-client fact vault
  server.tool(
    "client_fact_set",
    "Record a structured fact about a CLIENT in that client's vault (clients/<slug>/facts.json in your workspace): " +
      "value + source + as-of date. Use it for every figure a document will rely on (AUM, balances, fees, limits, " +
      "decisions) so the fact-check step and your Sources section can cite it. Setting an existing key keeps the " +
      "previous value in history. Pass remove=true to retire a key.",
    {
      agent: z.string().describe("Your agent name (pass your own name)"),
      client: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).describe("Client slug (the clients/<slug> directory), e.g. 'montoya'"),
      key: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/).describe("Fact key, e.g. 'aum', 'fee.annual', 'accounts.401k.balance'"),
      value: z.string().min(1).max(500).optional().describe("The value as you would print it, e.g. '$1.2M' or '7.2%'"),
      source: z.string().min(1).optional().describe("Where it comes from: statement + date, form, conversation, public reference"),
      as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Date the value is true as of, YYYY-MM-DD"),
      note: z.string().max(300).optional().describe("Optional qualifier"),
      remove: z.boolean().optional().describe("Retire the key instead of setting it (its value goes to history)"),
    },
    async ({ agent, client, key, value, source, as_of, note, remove }) => {
      try {
        if (remove !== true && (!value || !source || !as_of)) {
          return { content: [{ type: "text" as const, text: "value, source and as_of are required unless remove=true." }], isError: true };
        }
        const result = (await sendIpcRequest(SOCKET_PATH, "client-fact-set", withIdentity(agent, {
          agent,
          client,
          key,
          ...(remove === true ? { remove: true } : { value, source, as_of, ...(note ? { note } : {}) }),
        }))) as { client: string; key: string; removed?: boolean; previous?: { value: string; asOf: string } | null; path: string };
        const text =
          remove === true
            ? result.removed
              ? `Retired ${client}/${key} (was "${result.previous?.value}" as of ${result.previous?.asOf}).`
              : `${client}/${key} was not on file.`
            : result.previous
              ? `Updated ${client}/${key} = ${value} (as of ${as_of}); previous "${result.previous.value}" (as of ${result.previous.asOf}) kept in history.`
              : `Recorded ${client}/${key} = ${value} (as of ${as_of}).`;
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Failed to set client fact: ${msg}` }], isError: true };
      }
    },
  );

  server.tool(
    "client_facts",
    "Read a client's fact vault (or list the clients that have one). Returns the facts table plus ready-made " +
      "Sources lines ('key: value (source, as of date)') to paste into a document's Sources section.",
    {
      agent: z.string().describe("Your agent name (pass your own name)"),
      client: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).optional().describe("Client slug; omit to list clients with a vault"),
      history: z.boolean().optional().describe("Include previous values per key"),
    },
    async ({ agent, client, history }) => {
      try {
        const result = (await sendIpcRequest(SOCKET_PATH, "client-facts", withIdentity(agent, {
          agent,
          ...(client ? { client } : {}),
          ...(history ? { history: true } : {}),
        }))) as { clients?: readonly string[]; text?: string; sources?: readonly string[]; history?: unknown };
        if (result.clients) {
          return {
            content: [
              {
                type: "text" as const,
                text: result.clients.length === 0 ? "No client vaults yet." : `Clients with a vault: ${result.clients.join(", ")}`,
              },
            ],
          };
        }
        const parts = [result.text ?? ""];
        if (result.sources && result.sources.length > 0) parts.push("", "Sources lines:", ...result.sources.map((l) => `- ${l}`));
        if (history && result.history) parts.push("", "History:", JSON.stringify(result.history, null, 2));
        return { content: [{ type: "text" as const, text: parts.join("\n") }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Failed to read client facts: ${msg}` }], isError: true };
      }
    },
  );

  // Tool: workflow_templates (Phase 999.128)
  server.tool(
    "workflow_templates",
    "List the named workflow templates the operator configured for you (fleet templates merged with your own). " +
      "Each has a name, a description, its {{param}} parameters (required ones have no default) and its step/wave counts. " +
      "Launch one with start_workflow({ template, params }).",
    {
      agent: z.string().describe("Your agent name (pass your own name)"),
    },
    async ({ agent }) => {
      try {
        const result = (await sendIpcRequest(
          SOCKET_PATH,
          "list-workflow-templates",
          withIdentity(agent, { agent }),
        )) as {
          templates: ReadonlyArray<{
            name: string;
            description: string | null;
            params: ReadonlyArray<{ name: string; description: string | null; required: boolean; default: string | null }>;
            steps: number;
            waves: number;
          }>;
        };
        if (result.templates.length === 0) {
          return { content: [{ type: "text" as const, text: "No workflow templates are configured for you." }] };
        }
        const lines = result.templates.map((t) => {
          const params =
            t.params.length === 0
              ? "no params"
              : t.params
                  .map((p) => `${p.name}${p.required ? " (required)" : ` = ${JSON.stringify(p.default)}`}${p.description ? `: ${p.description}` : ""}`)
                  .join("; ");
          return `- ${t.name}${t.description ? ` — ${t.description}` : ""} [${t.steps} step(s), ${t.waves} wave(s)] params: ${params}`;
        });
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Failed to list workflow templates: ${msg}` }], isError: true };
      }
    },
  );

  // Tool: memory_lookup
  //
  // Phase 55 Plan 02 — WHITELISTED IDEMPOTENT TOOL. Handler body runs through
  // `invokeWithCache` so a duplicate invocation within the same Turn returns
  // the frozen cached response without a second IPC round-trip.
  alwaysLoad(server.tool(
    "memory_lookup",
    "Search your memory for relevant context, past decisions, and knowledge. " +
      "Use scope='conversations' to search older Discord conversation history " +
      "(session summaries + raw turns via FTS5) when the auto-injected resume brief " +
      "is insufficient. Use scope='all' to search both memories and conversations. " +
      "Results are paginated (max 10 per page); call again with page+1 if hasMore is true. " +
      "Note: if new conversation turns are recorded between page requests, pagination " +
      "boundaries may shift — re-issue with page 0 if strict consistency is required. " +
      "Use since/until (ISO date, YYYY-MM-DD, or relative like 7d, 2w, yesterday) to restrict " +
      "results to a time window; with an EMPTY query and a window you get a chronological " +
      "browse of what was discussed then (archived sessions carry started_at).",
    {
      query: z
        .string()
        .describe("What to search for in memory (may be empty when since/until is given)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(5)
        .describe("Max results per page (1-10, hard cap at 10)"),
      agent: z.string().describe("Your agent name (pass your own name)"),
      scope: z
        .enum(["memories", "conversations", "all"])
        .default("memories")
        .describe(
          "What to search: 'memories' (default, matches pre-v1.9 behavior), " +
            "'conversations' (session summaries + raw turns), or 'all' (both).",
        ),
      page: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe(
          "Zero-based page index for pagination (default 0). " +
            "Response includes hasMore + nextOffset if more results exist.",
        ),
      since: z
        .string()
        .optional()
        .describe(
          "Inclusive lower time bound: ISO datetime, YYYY-MM-DD (local day), " +
            "or relative (7d, 2w, 12h, yesterday, today).",
        ),
      until: z
        .string()
        .optional()
        .describe(
          "Inclusive upper time bound, same forms as since (a bare date covers the whole day).",
        ),
    },
    async ({ query, limit, agent, scope, page, since, until }) => {
      return invokeWithCache(
        "memory_lookup",
        agent,
        // Include scope+page (+window) in the per-Turn cache key so an earlier
        // scope='memories' call does not serve a stale response to a later
        // scope='all' request in the same Turn.
        { query, limit, scope, page, since, until },
        async () => {
          const result = (await sendIpcRequest(SOCKET_PATH, "memory-lookup", withIdentity(agent, {
            agent,
            query,
            limit,
            scope,
            page,
            ...(since ? { since } : {}),
            ...(until ? { until } : {}),
          }))) as {
            results: readonly Record<string, unknown>[];
            hasMore?: boolean;
            nextOffset?: number | null;
          };

          // Legacy call path (scope='memories' && page=0) returns
          // { results: [...] } WITHOUT hasMore/nextOffset. New call paths
          // return the full paginated envelope. Pass through whichever
          // shape the daemon produced — the agent reads the fields the
          // response contains.
          const payload =
            result.hasMore !== undefined
              ? {
                  results: result.results,
                  hasMore: result.hasMore,
                  nextOffset: result.nextOffset ?? null,
                }
              : result.results;

          return {
            content: [
              { type: "text" as const, text: JSON.stringify(payload, null, 2) },
            ],
          };
        },
        deps,
      );
    },
  ));

  // Tool: memory_save
  server.tool(
    "memory_save",
    "Save a piece of knowledge, decision, or important context to your long-term memory for future recall. " +
      "Use scope='owner' for a durable fact about your OWNER as a person (preferences, constraints, standing " +
      "instructions) so every agent they own recalls it too; keep scope='agent' (default) for anything task- or agent-specific.",
    {
      content: z.string().describe("The knowledge or context to remember"),
      tags: z.array(z.string()).default([]).describe("Tags for categorization (e.g. ['project', 'decision'])"),
      importance: z.number().min(0).max(1).default(0.7).describe("Importance score: 0.0 (trivial) to 1.0 (critical)"),
      agent: z.string().describe("Your agent name (pass your own name)"),
      scope: z
        .enum(["agent", "owner"])
        .default("agent")
        .describe(
          "'agent' (default): your own memory. 'owner': a fact about your owner shared with every agent they own " +
            "(fails if your agent has no owner configured).",
        ),
    },
    async ({ content, tags, importance, agent, scope }) => {
      try {
        const result = (await sendIpcRequest(SOCKET_PATH, "memory-save", withIdentity(agent, {
          agent,
          content,
          tags,
          importance,
          ...(scope === "owner" ? { scope } : {}),
        }))) as { id: string; scope?: string; owner?: string; action?: string };
        return {
          content: [
            {
              type: "text" as const,
              text:
                result.scope === "owner"
                  ? `Owner fact ${result.action === "refreshed" ? "refreshed" : "saved"} for ${result.owner} (id: ${result.id}); every agent they own will recall it.`
                  : `Memory saved (id: ${result.id})`,
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Failed to save memory: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // ── Phase 115 sub-scope 7 — lazy-load memory tools ─────────────────────
  //
  // Four tools that convert the agent from "always-injected memory" to
  // "tool-mediated lazy recall." See plan 115-05 for the threat model.
  //
  // SECURITY notes:
  //   - clawcode_memory_edit's `path` arg is z.enum(["MEMORY.md", "USER.md"])
  //     ONLY. Operator-curated identity files (SOUL.md / IDENTITY.md) are
  //     intentionally excluded — the agent CANNOT edit them.
  //   - The `agent` arg matches the existing memory_lookup / memory_save
  //     pattern: the daemon resolves the per-agent MemoryStore via
  //     `manager.getMemoryStore(agent)`, so cross-agent recall is impossible
  //     at the daemon-side IPC handler boundary.
  //
  // Tool: clawcode_memory_search — FTS5 + sqlite-vec hybrid search.
  server.tool(
    "clawcode_memory_search",
    "Search this agent's memory (FTS5 + sqlite-vec hybrid) across ALL time — dated notes, standing " +
      "notes, digests, saved memories and the owner's shared facts. Returns top-K snippets with memory IDs. " +
      "Use clawcode_memory_recall(memoryId) to fetch full body.",
    {
      query: z.string().describe("What to search for in your memory"),
      k: z.number().int().min(1).max(50).default(10).describe("Top-K hits to return (1-50)"),
      includeTags: z.array(z.string()).optional().describe("Only return memories with at least one of these tags"),
      excludeTags: z.array(z.string()).optional().describe("Drop memories whose tags intersect this list"),
      agent: z.string().describe("Your agent name (pass your own name)"),
    },
    async ({ query, k, includeTags, excludeTags, agent }) => {
      try {
        const result = (await sendIpcRequest(SOCKET_PATH, "clawcode-memory-search", withIdentity(agent, {
          agent,
          query,
          k,
          includeTags,
          excludeTags,
        }))) as {
          hits: ReadonlyArray<Record<string, unknown>>;
          agentName: string;
        };
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Failed to search memory: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // Tool: clawcode_memory_recall — fetch full body by id.
  server.tool(
    "clawcode_memory_recall",
    "Fetch the full body of a memory by ID. Use the memoryId returned from a clawcode_memory_search hit.",
    {
      memoryId: z.string().describe("Memory ID returned from clawcode_memory_search"),
      agent: z.string().describe("Your agent name (pass your own name)"),
    },
    async ({ memoryId, agent }) => {
      try {
        const result = (await sendIpcRequest(SOCKET_PATH, "clawcode-memory-recall", withIdentity(agent, {
          agent,
          memoryId,
        }))) as Record<string, unknown>;
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Failed to recall memory: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // Tool: clawcode_memory_edit — Anthropic memory_20250818 contract on Tier 1 files.
  server.tool(
    "clawcode_memory_edit",
    "Edit your Tier 1 memory file. Path is locked to MEMORY.md or USER.md only. " +
      "Modes: view (read), create (overwrite), append, str_replace.",
    {
      path: z.enum(["MEMORY.md", "USER.md"]).describe("Tier 1 file to edit (locked enum)"),
      mode: z.enum(["view", "create", "str_replace", "append"]).describe("Edit operation"),
      oldStr: z.string().optional().describe("For str_replace: the existing string to replace"),
      newStr: z.string().optional().describe("For str_replace: the replacement string"),
      content: z.string().optional().describe("For create / append: the content to write"),
      agent: z.string().describe("Your agent name (pass your own name)"),
    },
    async ({ path, mode, oldStr, newStr, content, agent }) => {
      try {
        const result = (await sendIpcRequest(SOCKET_PATH, "clawcode-memory-edit", withIdentity(agent, {
          agent,
          path,
          mode,
          oldStr,
          newStr,
          content,
        }))) as { ok: boolean; after?: string; error?: string };
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Failed to edit memory: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // Tool: clawcode_memory_archive — agent-curated Tier 2 → Tier 1 promotion.
  server.tool(
    "clawcode_memory_archive",
    "Promote a found memory chunk into MEMORY.md or USER.md (agent-curated archive). " +
      "Bypasses the dream-pass review window — your decision is operator-trusted.",
    {
      chunkId: z.string().describe("Chunk ID to promote (returned from clawcode_memory_search)"),
      targetPath: z.enum(["MEMORY.md", "USER.md"]).describe("Target Tier 1 file"),
      wrappingPrefix: z.string().optional().describe("Optional prefix prepended to the chunk body (e.g. heading)"),
      wrappingSuffix: z.string().optional().describe("Optional suffix appended to the chunk body"),
      agent: z.string().describe("Your agent name (pass your own name)"),
    },
    async ({ chunkId, targetPath, wrappingPrefix, wrappingSuffix, agent }) => {
      try {
        const result = (await sendIpcRequest(SOCKET_PATH, "clawcode-memory-archive", withIdentity(agent, {
          agent,
          chunkId,
          targetPath,
          wrappingPrefix,
          wrappingSuffix,
        }))) as { ok: boolean; error?: string };
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Failed to archive memory: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // Tool: ask_advisor
  // 2026-08-27 — verify_claim: the model records each load-bearing financial
  // fact it verified; the daemon validates the source against the evidence
  // ledger (what this turn actually opened) and answers with the EFFECTIVE
  // verdict + a hint when downgraded. Renders live in the channel's trail.
  server.tool(
    "verify_claim",
    "Record a fact you verified THIS turn: the claim, your verdict (verified | corrected | unverified | not-a-claim), the source you actually opened (URL, client document name, or table:<name>) and optionally a short quote. Call once per load-bearing fact BEFORE asserting it. A source you did not open this turn is rejected and the claim is recorded as unverified.",
    {
      agent: z.string().describe("Your agent name (pass your own name)"),
      claim: z.string().min(3).max(300).describe("The fact, in one sentence"),
      verdict: z.enum(["verified", "corrected", "unverified", "not-a-claim"]),
      source: z.string().max(512).optional().describe("URL you opened, client document filename, or table:<name>"),
      quote: z.string().max(300).optional().describe("Short verbatim quote from the source"),
      correction: z.string().max(300).optional().describe("For verdict=corrected: the corrected statement"),
      class: z.enum(["figure", "rule", "product-term"]).optional(),
      audience: z.enum(["internal", "client"]).optional().describe("client = this fact goes into text the client will receive"),
    },
    async ({ agent, claim, verdict, source, quote, correction, class: cls, audience }) => {
      try {
        const result = (await sendIpcRequest(
          SOCKET_PATH,
          "verify-claim",
          withIdentity(agent, { agent, claim, verdict, source, quote, correction, class: cls, audience }),
        )) as { ok: boolean; id?: string; effectiveVerdict?: string; sourceStatus?: string; quoteStatus?: string; hint?: string; reason?: string; detail?: string };
        const text = result.ok
          ? `verify_claim ${result.id}: recorded as ${result.effectiveVerdict} (source ${result.sourceStatus}${result.quoteStatus && result.quoteStatus !== "none" ? `, quote ${result.quoteStatus}` : ""}).${result.hint ? ` ${result.hint}` : ""}`
          : result.reason === "no-active-turn"
            ? "verify_claim: no active turn to attach this claim to. Continue; state the claim as unverified if you could not confirm it."
            : `verify_claim: ${result.reason ?? "error"}${result.detail ? ` (${result.detail})` : ""}. Continue.`;
        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text" as const, text: `verify_claim error: ${message}. Continue; state the claim as unverified if you could not confirm it.` }] };
      }
    },
  );

  alwaysLoad(server.tool(
    "ask_advisor",
    "Ask opus for advice on a complex decision without switching sessions",
    {
      question: z.string().describe("The question or decision you need advice on"),
      agent: z.string().describe("Your agent name (pass your own name)"),
    },
    async ({ question, agent }) => {
      try {
        const result = (await sendIpcRequest(SOCKET_PATH, "ask-advisor", {
          agent,
          question,
        })) as { answer: string; budget_remaining: number };

        const text = [
          result.answer,
          "",
          `--- Budget remaining: ${result.budget_remaining} advisor calls today ---`,
        ].join("\n");

        return { content: [{ type: "text" as const, text }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text" as const, text: `Advisor error: ${message}` }] };
      }
    },
  ));

  // Tool: send_attachment
  server.tool(
    "send_attachment",
    "Send a file attachment to your Discord channel (images, PDFs, media, etc.)",
    {
      agent: z.string().describe("Your agent name (pass your own name)"),
      file_path: z.string().describe("Absolute path to the file to send"),
      message: z.string().optional().describe("Optional text message to include with the file"),
      channel_id: z.string().optional().describe("Target channel ID (defaults to your primary channel)"),
    },
    async ({ agent, file_path, message, channel_id }) => {
      try {
        const result = (await sendIpcRequest(SOCKET_PATH, "send-attachment", {
          agent,
          file_path,
          message,
          channel_id,
        })) as { ok: boolean; agent: string; channel: string; file: string };

        return {
          content: [{ type: "text" as const, text: `File sent to channel ${result.channel}: ${result.file}` }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text" as const, text: `Failed to send attachment: ${msg}` }] };
      }
    },
  );

  // Tool: show_preview (Backlog 999.95)
  // Push a live HTML preview (or a URL) into the Discord Embedded App surface.
  // Cross-field "exactly one of html/url" is validated in the handler — the MCP
  // tool schema is a raw zod shape and cannot carry an object-level .refine().
  server.tool(
    "show_preview",
    "Push a live HTML preview (or a URL) into your Discord Embedded App. First push of an id posts a one-tap launch button; reusing the id hot-reloads the open preview (no relaunch). Provide exactly one of html or url. HTML capped at 256 KiB.",
    {
      agent: z.string().describe("Your agent name (pass your own name)"),
      html: z
        .string()
        .max(256 * 1024)
        .optional()
        .describe("Full HTML document to render live. Provide html OR url, not both."),
      url: z
        .string()
        .optional()
        .describe(
          "URL or same-origin path (e.g. /dashboard/v2/) to frame instead of html. Provide html OR url, not both.",
        ),
      id: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,64}$/)
        .optional()
        .describe("Stable preview id; omit to auto-generate. Reuse the same id to update the open preview live."),
      caption: z
        .string()
        .max(1800)
        .optional()
        .describe(
          "Your ANSWER, posted as the message text above the image (markdown ok). Lead with the verdict — price, availability, recommendation. Without this the image lands with no answer beside it.",
        ),
      links: z
        .array(
          z.object({
            label: z.string().min(1).max(80).describe("Button text, e.g. \"Buy at AutoZone — $181.99\""),
            url: z.string().url().describe("https:// destination"),
          }),
        )
        .max(5)
        .optional()
        .describe("Up to 5 link buttons under the image (product page, alternate retailer, review source)."),
    },
    async ({ agent, html, url, id, caption, links }) => {
      try {
        const hasHtml = typeof html === "string" && html.length > 0;
        const hasUrl = typeof url === "string" && url.length > 0;
        if (hasHtml === hasUrl) {
          return {
            content: [
              {
                type: "text" as const,
                text: "show_preview requires exactly one of `html` or `url`.",
              },
            ],
          };
        }
        const result = (await sendIpcRequest(SOCKET_PATH, "show-preview", {
          // Phase 140 parity — authoritative identity wins over self-report.
          agent: selfAgentName ?? agent,
          ...(hasHtml ? { html } : { url }),
          ...(id ? { id } : {}),
          ...(caption ? { caption } : {}),
          ...(links && links.length > 0 ? { links } : {}),
        })) as {
          ok: boolean;
          id: string;
          isNew: boolean;
          previewUrl: string;
          posted: boolean;
        };
        const launchNote = result.posted ? " — launch button posted to your channel." : "";
        return {
          content: [
            {
              type: "text" as const,
              text: `Preview ${result.isNew ? "created" : "updated"} (id=${result.id}). URL: ${result.previewUrl}${launchNote}`,
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text" as const, text: `show_preview failed: ${msg}` }] };
      }
    },
  );

  // Tools: post_to_agent (canonical) + send_to_agent (DEPRECATED alias)
  //
  // Phase 999.2 Plan 02 D-RNX-02 / D-RNX-04 — same shared-handler pattern as
  // ask_agent above. post_to_agent is the broadcast / fire-and-forget tool
  // (writes inbox + posts webhook embed in target's channel — no synchronous
  // reply path). For Q&A, agents should use ask_agent instead.
  const postToAgentSchema = {
    from: z.string().describe("Your agent name (pass your own name)"),
    to: z.string().describe("Target agent name"),
    message: z.string().describe("Message content to send"),
  } as const;

  const postToAgentHandler = async ({
    from,
    to,
    message,
  }: {
    from: string;
    to: string;
    message: string;
  }) => {
    try {
      // Wire request uses canonical IPC name `post-to-agent` per D-RNI-IPC-02.
      const result = (await sendIpcRequest(SOCKET_PATH, "post-to-agent", withIdentity(from, {
        // Phase 140 parity — authoritative identity wins over self-report.
        from: selfAgentName ?? from,
        to,
        message,
      }))) as {
        ok?: boolean;
        delivered: boolean;
        messageId: string;
        // Quick 260511-pw2 — present iff `delivered=false`. One of:
        // "no-target-channels" | "no-webhook" | "webhook-send-failed".
        // Surfaced so the sender's LLM doesn't mistake the inbox id for a
        // queryable task id (Admin Clawdy 2026-05-11 bug).
        reason?: string;
        // Phase 999.117 WS-0 — which mechanism actually ran. Absent from a
        // pre-999.117 daemon, so every branch below degrades gracefully.
        via?: "v3-channel" | "webhook" | "bot-direct" | "self-channel" | "inbox";
      };
      // WS-0 (quick 260716-u5h) — self-target renders its own text: there is
      // no inbox record on this path, so the generic inbox-fallback wording
      // below would be a lie.
      const isSelfPost = (selfAgentName ?? from) === to;
      if (result.delivered) {
        // Phase 999.117 WS-0 — report the mechanism truthfully.
        //
        // This used to say "Message delivered to X via their Discord
        // channel." for every non-self success. On the `bot-direct` rung
        // that is FALSE: the recipient's Discord bridge drops bot-authored
        // non-webhook messages, so the post is operator-visible only and the
        // actual turn comes from the inbox watcher moments later. The
        // sending agent was being told its message had landed in a channel
        // the recipient never reads — which invites a re-send, and a
        // re-send is duplicate A2A traffic.
        const deliveredText: Record<string, string> = {
          "v3-channel": `Delivered to ${to} over their live channel — they are processing it now.`,
          webhook: `Delivered to ${to}'s Discord channel as an agent message — their bridge picks it up from there.`,
          "bot-direct": `Queued for ${to}. It was also posted into their Discord channel for operator visibility, but that post does NOT drive their turn — they pick the message up from their inbox within seconds. Do not re-send.`,
          inbox: `Queued in ${to}'s inbox — they pick it up within seconds. Do not re-send.`,
          "self-channel": `Posted to your Discord channel.`,
        };
        return {
          content: [
            {
              type: "text" as const,
              text: isSelfPost
                ? `Posted to your Discord channel.`
                : ((result.via && deliveredText[result.via]) ??
                  `Message accepted for ${to}.`),
            },
          ],
        };
      }
      if (result.reason === "self-target-no-delivery") {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Self-post could not be delivered to your channel (no webhook or bot sender available). ` +
                `Nothing was queued — self-posts never write an inbox record.`,
            },
          ],
        };
      }
      // Inbox-only fallback. Heartbeat reconciler
      // (src/heartbeat/checks/inbox.ts) drains the inbox for every agent so
      // the message still lands — but NOT immediately. Be explicit so the
      // sender's LLM knows this is not a task id to poll.
      const reasonNote = result.reason ? ` (reason: ${result.reason})` : "";
      return {
        content: [
          {
            type: "text" as const,
            // Phase 999.117 WS-0 — this used to say the message would land
            // "on their next inbox-heartbeat sweep (not immediately)". That
            // undersells it badly: the InboxSource chokidar watcher is the
            // PRIMARY path and fires in well under a second. The heartbeat
            // reconciler only picks up what the watcher missed (>120s old).
            // Telling the sender delivery is slow invites a re-send.
            text:
              `Queued in ${to}'s inbox${reasonNote} — their inbox watcher picks it up within seconds. ` +
              `No Discord presentation was posted, so this exchange is not visible in their channel. ` +
              `Do not re-send. Note: this is NOT a delegate_task id — do not call task_status on it. ` +
              `For synchronous Q&A use ask_agent instead.`,
          },
        ],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [
          { type: "text" as const, text: `Failed to send to ${to}: ${msg}` },
        ],
      };
    }
  };

  // Register canonical name FIRST (D-RNX-04).
  alwaysLoad(server.tool(
    "post_to_agent",
    "Broadcast a message to another agent's Discord channel. " +
      "The agent sees it as a normal message in their channel. " +
      "Does NOT wait for a reply — for synchronous Q&A use ask_agent. " +
      "Posting to YOURSELF delivers to your own channel only — it does not " +
      "create an inbox message or a new turn (use it to surface background " +
      "results to the operator).",
    postToAgentSchema,
    postToAgentHandler,
  ));

  // Register deprecated alias SECOND.
  server.tool(
    "send_to_agent",
    "[DEPRECATED — use post_to_agent instead] " +
      "Backwards-compatibility alias for post_to_agent. Identical behavior; " +
      "scheduled for removal once all agents have migrated (Phase 999.2 D-RNX-03).",
    postToAgentSchema,
    postToAgentHandler,
  );

  // Tool: ingest_document
  //
  // Phase 101 Plan 02 T04 — SINGLE ingestion entry point per
  // `feedback_silent_path_bifurcation`. Handles PDFs (text + scanned),
  // docx, xlsx, images, and plain text via the three-tier OCR fallback
  // (Tesseract CLI → WASM → Claude vision). Optional structured
  // extraction (`extract: 'structured' | 'both'`) drives Anthropic
  // tool-use against the matching zod schema in EXTRACTION_SCHEMAS
  // (`taxReturn` shipped; brokerage/401k/ADV deferred per D-06).
  //
  // Inputs:
  //   - file_path:  required absolute path; daemon validates containment
  //                 within the agent workspace (T-101-08).
  //   - agent:      defaults to the channel-bound agent (validated at the
  //                 IPC layer; pre-Phase-101 contract retained).
  //   - taskHint:   'standard' (Haiku) | 'high-precision' (Sonnet).
  //   - extract:    'text' (no structured pass) | 'structured' | 'both'.
  //   - schemaName: which extraction schema to apply (default 'taxReturn').
  //   - backend:    explicit OCR tier override (D-08 'mistral' gated by
  //                 defaults.documentIngest.allowMistralOcr).
  //   - force:      D-07 — bypass the `<doc-slug>-<date>.json` cache hit.
  server.tool(
    "ingest_document",
    "Robustly ingest a PDF/docx/xlsx/image into the agent's document store + memory. " +
      "Single entry point for document handling: type detection, OCR fallback " +
      "(Tesseract, then Claude vision; scanned pages inside a text PDF are OCRed too), and structured extraction via zod schemas " +
      "(taskHint='high-precision' uses Sonnet, default Haiku). Every stored chunk starts with a " +
      "header line 'Document: <filename> | uploaded <date> | page <p> | part <i>/<n>'. Afterwards " +
      "find the content with search_documents (exact chunks with provenance; pass the returned " +
      "Source to search one document) or clawcode_memory_search. Files sent in Discord are " +
      "usually ingested automatically, so search_documents first before re-ingesting. A file with " +
      "no extractable text stores 0 chunks. Pass " +
      "extract='structured'|'both' + schemaName to also produce a validated JSON " +
      "output (ExtractedTaxReturn shipped today). Use force=true to bypass the " +
      "<doc-slug>-<date>.json cache (D-07 schema-version re-extract).",
    {
      agent: z.string().describe("Your agent name"),
      file_path: z.string().describe("Absolute path to the document file"),
      source: z.string().optional().describe("Custom source identifier (defaults to file path)"),
      taskHint: z
        .enum(["standard", "high-precision"])
        .optional()
        .describe(
          "Quality dial. 'standard' (default) → Haiku for OCR/extraction (~$0.005/page); " +
            "'high-precision' → Sonnet (~$0.015/page). Use 'high-precision' for tax returns and other dense tabular financial documents.",
        ),
      extract: z
        .enum(["text", "structured", "both"])
        .optional()
        .describe(
          "What to extract. 'text' (default) — only chunked text for RAG. " +
            "'structured' — also run zod-schema-validated extraction via Anthropic tool-use. " +
            "'both' — text chunks + structured JSON. Structured outputs land at " +
            "<workspace>/documents/<doc-slug>-<date>.json.",
        ),
      schemaName: z
        .enum(["taxReturn"])
        .optional()
        .describe(
          "Which extraction schema to apply when extract != 'text'. " +
            "'taxReturn' (default) maps to ExtractedTaxReturn (D-06).",
        ),
      backend: z
        .enum([
          "tesseract-cli",
          "tesseract-wasm",
          "claude-haiku",
          "claude-sonnet",
          "mistral",
          "none",
        ])
        .optional()
        .describe(
          "Override the OCR three-tier auto-chain. 'mistral' (D-08) requires " +
            "defaults.documentIngest.allowMistralOcr=true; the stub then throws " +
            "'not yet implemented' until the operator wires the API client.",
        ),
      force: z
        .boolean()
        .optional()
        .describe(
          "D-07 schema-version opt-in re-extract. Default false: when " +
            "<doc-slug>-<date>.json exists with matching extractionSchemaVersion, " +
            "the cached result is returned. Set true to re-run extraction.",
        ),
    },
    async ({ agent, file_path, source, taskHint, extract, schemaName, backend, force }) => {
      try {
        const result = await sendIpcRequest(SOCKET_PATH, "ingest-document", withIdentity(agent, {
          agent,
          file_path,
          source,
          taskHint,
          extract,
          schemaName,
          backend,
          force,
        }));
        const r = result as {
          ok: boolean;
          source: string;
          chunks_created: number;
          total_chars: number;
          structured?: unknown;
          paths?: { textMd?: string; structuredJson?: string };
          telemetry?: unknown;
        };
        const lines = [
          `Ingested "${r.source}": ${r.chunks_created} chunks (${r.total_chars} chars)`,
        ];
        if (r.paths?.textMd) lines.push(`text: ${r.paths.textMd}`);
        if (r.paths?.structuredJson) lines.push(`structured: ${r.paths.structuredJson}`);
        if (r.structured !== undefined) {
          lines.push(`structured fields extracted: ${JSON.stringify(r.structured).length} chars`);
        }
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text" as const, text: `Ingest failed: ${msg}` }] };
      }
    },
  );

  // Tool: clawcode_rag_set_priority — Phase 999.43 Plan 04 T02
  //
  // Two layers of D-08 sandbox protect against agent self-escalation:
  //
  //   LAYER-1 (here): z.enum(["medium", "low"]) — the MCP SDK rejects
  //   any "high" argument at the SDK boundary, before the IPC handler
  //   even sees the request. This is the primary gate the agent's
  //   model interacts with.
  //
  //   LAYER-2 (daemon): set-doc-priority-handler.ts re-validates
  //   `who === "agent" && level === "high"` and returns a refusal +
  //   audit-log entry. Defense-in-depth — even if the MCP schema is
  //   ever relaxed or bypassed, the daemon refuses.
  //
  // Only operator surfaces (🔴 emoji reaction in src/discord/bridge.ts
  // + `clawcode rag set-priority` CLI) can set HIGH.
  server.tool(
    "clawcode_rag_set_priority",
    "Set retrieval priority for a previously-ingested document. D-08 sandbox: agents capped at MEDIUM; operator-only HIGH via 🔴 emoji or `clawcode rag set-priority`.",
    {
      agent: z
        .string()
        .describe(
          "Your agent name (required for daemon to scope the documents store)",
        ),
      source: z
        .string()
        .describe(
          "Document source identifier (full file path used at ingest time)",
        ),
      level: z
        .enum(["medium", "low"])
        .describe(
          "Priority level. HIGH is operator-only — D-08 sandbox. Use 'medium' or 'low' only.",
        ),
      reason: z.string().optional().describe("Short rationale for the audit log"),
    },
    async ({ agent, source, level, reason }) => {
      try {
        const result = await sendIpcRequest(
          SOCKET_PATH,
          "set-doc-priority",
          {
            agent,
            source,
            level,
            who: "agent",
            callerAgent: agent, // self-attribution — daemon enforces Phase 90 isolation
            reason,
          },
        );
        const r = result as {
          ok: boolean;
          source?: string;
          old_level?: string;
          new_level?: string;
          error?: string;
        };
        if (!r.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Priority change refused: ${r.error ?? "unknown"}`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Priority of "${r.source}" changed: ${r.old_level} → ${r.new_level}`,
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [
            { type: "text" as const, text: `set-priority failed: ${msg}` },
          ],
        };
      }
    },
  );

  // Tool: search_documents
  //
  // Phase 55 Plan 02 — WHITELISTED IDEMPOTENT TOOL. Handler body runs through
  // `invokeWithCache` so identical searches within the same Turn return the
  // frozen cached response without a second IPC round-trip.
  server.tool(
    "search_documents",
    // Phase 999.43-fu2 Path A T03 — the description advertises the
    // source_image_path field so agents know they can `Read` the underlying
    // image when shape semantics (charts, graphs, candlesticks) matter
    // beyond the OCR'd text.
    "Search the documents ingested for you: files, PDFs, spreadsheets, screenshots and images " +
      "sent in Discord (indexed automatically when attachment ingest is on) and anything ingested " +
      "with ingest_document. Use it when the user refers to something they sent or uploaded " +
      "earlier, or when a <memory-context> hit names a document and you need the exact text. " +
      "Each result shows: score (relevance after priority and recency weighting, higher is " +
      "better) and similarity (raw semantic closeness, 0 to 1); Source (the stored path or id, " +
      "pass it back as `source` to search inside that one document) and the chunk number; File, " +
      "Uploaded and From (original filename, upload date, sender and channel) when known; an " +
      "Image: <path> line for image attachments, which you can open with the Read tool when " +
      "chart shape, colors or layout matter beyond the text; then the chunk text, which starts " +
      "with a 'Document: <filename> | uploaded <date> | ... | page <p> | part <i>/<n>' header. " +
      "An image whose text could not be extracted is a one-line stub saying so; Read its Image " +
      "path to look at it.",
    {
      agent: z.string().describe("Your agent name"),
      query: z.string().describe("Search query"),
      limit: z.number().int().min(1).max(20).default(5).describe("Max results (default 5)"),
      source: z
        .string()
        .optional()
        .describe(
          "Restrict the search to one document: the exact Source value from an earlier result or " +
            "list_documents. Applied before ranking, so it returns that document's best chunks " +
            "even when other documents would score higher.",
        ),
    },
    async ({ agent, query, limit, source }) => {
      return invokeWithCache(
        "search_documents",
        agent,
        { query, limit, source },
        async () => {
          const result = await sendIpcRequest(SOCKET_PATH, "search-documents", withIdentity(agent, {
            agent, query, limit, source,
          }));
          const r = result as {
            results: readonly {
              chunk_id: string;
              source: string;
              chunk_index: number;
              content: string;
              similarity: number;
              weighted_score?: number;
              context_before: string | null;
              context_after: string | null;
              source_image_path?: string;
              // WP3 provenance (null when unknown).
              filename?: string | null;
              ingested_at?: string | null;
              user_name?: string | null;
              channel_name?: string | null;
              source_kind?: string | null;
            }[];
          };
          if (r.results.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: source
                    ? `No matching chunks in "${source}". Check the Source value with list_documents.`
                    : "No matching documents found.",
                },
              ],
            };
          }
          const formatted = r.results.map((hit, i) => {
            const score =
              typeof hit.weighted_score === "number"
                ? `score: ${hit.weighted_score.toFixed(3)}, `
                : "";
            const parts = [
              `--- Result ${i + 1} (${score}similarity: ${hit.similarity.toFixed(3)}) ---`,
              `Source: ${hit.source} [chunk ${hit.chunk_index}]`,
            ];
            // WP3: provenance from the documents row, when known.
            const prov: string[] = [];
            if (hit.filename) prov.push(`File: ${hit.filename}`);
            if (hit.ingested_at) prov.push(`Uploaded: ${hit.ingested_at.slice(0, 10)}`);
            const from = [
              hit.user_name ? hit.user_name : null,
              hit.channel_name ? `#${hit.channel_name.replace(/^#/, "")}` : null,
            ].filter((x): x is string => x !== null);
            if (from.length > 0) prov.push(`From: ${from.join(" in ")}`);
            if (hit.source_kind) prov.push(`Kind: ${hit.source_kind}`);
            if (prov.length > 0) parts.push(prov.join(" | "));
            // Phase 999.43-fu2 Path A T03 — surface persisted image path so
            // the agent can Read it for chart/graph shape re-look.
            if (hit.source_image_path) {
              parts.push(`Image: ${hit.source_image_path}`);
            }
            // WP3: adjacent chunks are context only; drop their header lines
            // (the hit's own header stays as the first line of its text).
            const noHeader = (t: string): string =>
              t.replace(/^Document: [^\n]*\| part \d+\/\d+\n/, "");
            if (hit.context_before) parts.push(`[...] ${noHeader(hit.context_before)}`);
            parts.push(hit.content);
            if (hit.context_after) parts.push(`${noHeader(hit.context_after)} [...]`);
            return parts.join("\n");
          }).join("\n\n");
          return { content: [{ type: "text" as const, text: formatted }] };
        },
        deps,
      );
    },
  );

  // Tool: delete_document
  server.tool(
    "delete_document",
    "Delete all chunks for an ingested document",
    {
      agent: z.string().describe("Your agent name"),
      source: z.string().describe("Document source identifier to delete"),
    },
    async ({ agent, source }) => {
      try {
        const result = await sendIpcRequest(SOCKET_PATH, "delete-document", withIdentity(agent, { agent, source }));
        const r = result as { ok: boolean; source: string; chunks_deleted: number };
        return {
          content: [{ type: "text" as const, text: `Deleted "${r.source}": ${r.chunks_deleted} chunks removed` }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text" as const, text: `Delete failed: ${msg}` }] };
      }
    },
  );

  // Tool: list_documents
  server.tool(
    "list_documents",
    "List all ingested document sources and total chunk count",
    {
      agent: z.string().describe("Your agent name"),
    },
    async ({ agent }) => {
      const result = await sendIpcRequest(SOCKET_PATH, "list-documents", withIdentity(agent, { agent }));
      const r = result as { sources: readonly string[]; total_chunks: number };
      if (r.sources.length === 0) {
        return { content: [{ type: "text" as const, text: "No documents ingested." }] };
      }
      const text = [`Documents (${r.total_chunks} total chunks):`, ...r.sources.map(s => `  - ${s}`)].join("\n");
      return { content: [{ type: "text" as const, text }] };
    },
  );

  // -------------------------------------------------------------------------
  // Cross-agent RPC / handoffs (Phase 59)
  // -------------------------------------------------------------------------

  // Tool: delegate_task
  server.tool(
    "delegate_task",
    "Delegate a typed task to another agent. Returns task_id immediately; the result arrives as a new turn.",
    {
      caller: z.string().describe("Your agent name"),
      target: z.string().describe("Target agent name"),
      schema: z.string().describe("Task schema name (e.g. 'research.brief')"),
      payload: z.record(z.string(), z.unknown()).describe("Task input payload matching the named schema"),
      deadline_ms: z.number().int().positive().optional().describe("Absolute wall-clock deadline (ms since epoch)"),
      budgetOwner: z.string().optional().describe("Override budget attribution (default: caller)"),
      parent_task_id: z.string().optional().describe("For nested handoffs; omit for root delegations"),
    },
    async ({ caller, target, schema, payload, deadline_ms, budgetOwner, parent_task_id }) => {
      try {
        const result = (await sendIpcRequest(SOCKET_PATH, "delegate-task", withIdentity(caller, {
          caller, target, schema, payload, deadline_ms, budgetOwner, parent_task_id,
        }))) as { task_id: string };
        return { content: [{ type: "text" as const, text: JSON.stringify({ task_id: result.task_id }) }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        // Quick 260511-pw3 — surface the target's accepted schemas on
        // unknown_schema rejections. IpcError.data carries
        // {reason, schema, target, acceptedSchemas} for this branch.
        const errData = (error as { data?: unknown }).data;
        if (
          errData !== null &&
          typeof errData === "object" &&
          "reason" in errData &&
          (errData as { reason: unknown }).reason === "unknown_schema"
        ) {
          const d = errData as {
            reason: string;
            schema?: string;
            target?: string;
            acceptedSchemas?: readonly string[];
          };
          const accepted = d.acceptedSchemas ?? [];
          const acceptedList = accepted.length > 0
            ? accepted.join(", ")
            : "(none — target agent has not declared any acceptsTasks schemas, or the registry has none of them)";
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Delegate failed: schema '${d.schema ?? schema}' is not accepted by '${d.target ?? target}'. ` +
                  `Accepted schemas: ${acceptedList}. ` +
                  `Call list_agent_schemas(caller, target) to inspect each schema's callerAllowed flag.`,
              },
            ],
          };
        }
        return { content: [{ type: "text" as const, text: `Delegate failed: ${msg}` }] };
      }
    },
  );

  // Quick 260511-pw3 — list_agent_schemas tool. Auto-injected for every
  // agent (the clawcode MCP server is itself auto-injected). Senders call
  // this BEFORE delegate_task to introspect what schemas the target
  // accepts — same auto-inject pattern as `clawcode_fetch_discord_messages`.
  server.tool(
    "list_agent_schemas",
    "List the task schemas a target agent accepts via delegate_task. Returns " +
      "an array of { name, callerAllowed, registered }. Both flags must be " +
      "true for delegate_task to succeed. Call this BEFORE delegate_task to " +
      "pick a valid schema instead of taking a blind shot.",
    {
      caller: z.string().describe("Your agent name"),
      target: z.string().describe("Target agent to introspect"),
    },
    async ({ caller, target }) => {
      try {
        const result = (await sendIpcRequest(SOCKET_PATH, "list-agent-schemas", {
          caller,
          target,
        })) as {
          target: string;
          caller: string;
          schemas: ReadonlyArray<{
            name: string;
            callerAllowed: boolean;
            registered: boolean;
          }>;
        };
        if (result.schemas.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Agent '${target}' declares NO accepted schemas. ` +
                  `delegate_task will be rejected for every schema. ` +
                  `The operator must add an \`acceptsTasks\` block to ${target}'s ` +
                  `clawcode.yaml entry. See docs/cross-agent-schemas.md.`,
              },
            ],
          };
        }
        // Render as a stable table the LLM can scan.
        const lines = result.schemas.map(
          (s) =>
            `  - ${s.name}` +
            ` (callerAllowed=${s.callerAllowed}, registered=${s.registered})`,
        );
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Schemas declared by '${target}' (from clawcode.yaml acceptsTasks):\n` +
                lines.join("\n") +
                `\n\nNote: BOTH callerAllowed=true AND registered=true are required ` +
                `for delegate_task to succeed. Schemas with registered=false exist in ` +
                `${target}'s config but lack a YAML file in ~/.clawcode/task-schemas/.`,
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text" as const, text: `list_agent_schemas failed: ${msg}` }] };
      }
    },
  );

  // Tool: task_status
  server.tool(
    "task_status",
    "Check the status of a delegated task.",
    { task_id: z.string().describe("Task id returned by delegate_task") },
    async ({ task_id }) => {
      try {
        const result = await sendIpcRequest(SOCKET_PATH, "task-status", { task_id });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text" as const, text: `Status failed: ${msg}` }] };
      }
    },
  );

  // Tool: cancel_task
  server.tool(
    "cancel_task",
    "Cancel an in-flight delegated task.",
    {
      task_id: z.string().describe("Task id to cancel"),
      caller: z.string().describe("Your agent name (for audit trail)"),
    },
    async ({ task_id, caller }) => {
      try {
        await sendIpcRequest(SOCKET_PATH, "cancel-task", { task_id, caller });
        return { content: [{ type: "text" as const, text: `Task ${task_id} cancelled` }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text" as const, text: `Cancel failed: ${msg}` }] };
      }
    },
  );

  // Tool: task_complete
  server.tool(
    "task_complete",
    "Signal completion of a delegated task with a structured result. Call this at the END of your turn.",
    {
      task_id: z.string().describe("Task id you received as the delegated task"),
      result: z.record(z.string(), z.unknown()).describe("Structured result matching the schema's output shape"),
      chain_token_cost: z.number().int().min(0).optional().describe("Tokens consumed during this task's execution"),
    },
    async ({ task_id, result, chain_token_cost }) => {
      try {
        await sendIpcRequest(SOCKET_PATH, "task-complete", { task_id, result, chain_token_cost });
        return { content: [{ type: "text" as const, text: `Task ${task_id} completed` }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text" as const, text: `Complete failed: ${msg}` }] };
      }
    },
  );

  // Phase 94 Plan 05 TOOL-08 / D-08 — built-in Discord message fetcher
  // (Gap 3 closure). Forwards to the daemon's fetch-discord-messages IPC,
  // where the discord.js client + channel/thread fetch lives. Auto-injected
  // into every agent's tool list because the clawcode MCP server is auto-
  // injected. Pure dispatch wrapper — handler logic + production deps are
  // bound at the daemon edge (src/manager/tools/clawcode-fetch-discord-messages.ts
  // accepts deps; the IPC handler wires discord.js client.channels.fetch).
  server.tool(
    "clawcode_fetch_discord_messages",
    "Fetch the most recent messages from a Discord channel or thread (Discord treats threads as channels). " +
      "Use channel_id for either. Limit defaults to 50, max 100. " +
      "Use before=<message_id> to page back further when N > 100 needed.",
    {
      channel_id: z.string().describe("Discord channel or thread ID (snowflake)"),
      limit: z.number().int().min(1).max(100).default(50).describe(
        "Number of messages to fetch (1-100; default 50)",
      ),
      before: z
        .string()
        .optional()
        .describe("Message snowflake — fetch messages older than this ID"),
    },
    async ({ channel_id, limit, before }) => {
      try {
        const result = (await sendIpcRequest(SOCKET_PATH, "fetch-discord-messages", withIdentity(selfAgentName ?? "", {
          channel_id,
          limit,
          ...(before !== undefined ? { before } : {}),
        }))) as {
          messages: ReadonlyArray<{
            id: string;
            author: string;
            content: string;
            ts: string;
            attachments: ReadonlyArray<{ filename: string; url: string }>;
          }>;
        };
        // Return as JSON text so the LLM can read the full structure.
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: "text" as const, text: `Failed to fetch messages: ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );

  // Phase 94 Plan 05 TOOL-09 / D-09 — built-in file-share helper (Gap 3
  // closure). Forwards to the daemon's share-file IPC, where the
  // discord.js bot-direct upload + 25MB cap + allowedRoots enforcement
  // live. Auto-injected into every agent's tool list because the
  // clawcode MCP server is auto-injected.
  server.tool(
    "clawcode_share_file",
    "Upload a file from the agent's workspace to the Discord channel/thread the agent is currently answering in. " +
      "Returns the CDN URL the user can click. " +
      "Use this WHENEVER the user wants a file — never tell the user a local path " +
      "(e.g. /home/clawcode/...). " +
      "Path must be absolute and inside the agent's workspace or memory directory.",
    {
      agent: z.string().describe("Your agent name (pass your own name)"),
      path: z
        .string()
        .describe("Absolute path inside agent workspace or memoryPath"),
      caption: z
        .string()
        .optional()
        .describe("Optional caption sent alongside the file"),
      channel_id: z
        .string()
        .optional()
        .describe(
          "Channel or thread ID for the upload destination. Defaults to the first configured channel for the agent.",
        ),
    },
    async ({ agent, path, caption, channel_id }) => {
      try {
        const result = (await sendIpcRequest(SOCKET_PATH, "share-file", {
          agent,
          path,
          ...(caption !== undefined ? { caption } : {}),
          ...(channel_id !== undefined ? { channel_id } : {}),
        })) as { url: string; filename: string; sizeBytes: number };
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: "text" as const, text: `Failed to share file: ${msg}` },
          ],
          isError: true,
        };
      }
    },
  );

  return server;
}

/**
 * Start the MCP server with stdio transport.
 * This is the entry point for `clawcode mcp`.
 *
 * Phase 55 Plan 02 — stdio transport has no agent context, so we omit
 * `deps`. Whitelisted-tool wrappers fall back to the raw handler path;
 * no intra-turn caching occurs on this path (correct: stdio MCP clients
 * are external — they are not inside a ClawCode Turn).
 */
export async function startMcpServer(): Promise<void> {
  // Phase 140 parity — the v3 backend wires this server with `CLAWCODE_AGENT` in
  // the per-agent `.mcp.json` env so the standalone (stdio) server KNOWS its
  // agent and can override self-reported caller identity (anti-impersonation).
  // Absent on the legacy `clawcode mcp` invocation → self-report (unchanged).
  const selfAgentName = process.env.CLAWCODE_AGENT?.trim() || undefined;
  const server = createMcpServer(undefined, selfAgentName);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
