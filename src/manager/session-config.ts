import { readFile } from "node:fs/promises";
import { resolveResearchSession, type ResearchSessionConfig } from "./research-subagents.js";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ResolvedAgentConfig } from "../shared/types.js";
import type { AgentSessionConfig } from "./types.js";
import { MANAGER_SOCKET_PATH } from "../config/loader.js";
import {
  discoverMcpDepPaths,
  type SandboxBindPlan,
} from "./bwrap-sandbox.js";
import type { SkillsCatalog } from "../skills/types.js";
import type { TierManager } from "../memory/tier-manager.js";
import {
  loadLatestSummary,
  enforceSummaryBudget,
  DEFAULT_RESUME_SUMMARY_BUDGET,
} from "../memory/context-summary.js";
import type { BootstrapStatus } from "../bootstrap/types.js";
import { buildBootstrapPrompt } from "../bootstrap/prompt-builder.js";
import { extractFingerprint, formatFingerprint } from "../memory/fingerprint.js";
import { resolveMemoryRoots } from "../memory/memory-roots.js";
import { readIdentityContent, readSoulContent } from "./persona-files.js";
// Phase 100 follow-up — capability manifest. Pure read of resolved config;
// emitted into the stable prefix after identity so the LLM has its enabled
// features in context (root cause of the "I don't dream" failure mode).
import { buildCapabilityManifest } from "./capability-manifest.js";
import { resolveUxFeature } from "./ux-feature-state-store.js";
import { isManagedWorkerName } from "./subagent-name.js";
import {
  assembleContext,
  assembleContextTraced,
  DEFAULT_BUDGETS,
  INJECTED_MEMORY_MAX_CHARS,
  INJECTED_USER_MAX_CHARS,
  renderHotMemoryLine,
} from "./context-assembler.js";
// Phase 999.7 — TraceCollector wired through deps for context-audit pipeline
// restoration. Without it, the per-section section_tokens metadata is never
// written to traces.db and `clawcode context-audit` reports sampledTurns: 0.
import type { TraceCollector } from "../performance/trace-collector.js";
import type {
  ContextSources,
  BudgetWarningEvent,
  SkillCatalogEntry,
  ResolvedLazySkillsConfig,
} from "./context-assembler.js";
import type { MemoryEntry } from "../memory/types.js";
import type { SkillUsageTracker } from "../usage/skill-usage-tracker.js";
// Phase 67 — Resume Auto-Injection (SESS-02, SESS-03)
import type { ConversationStore } from "../memory/conversation-store.js";
import type { MemoryStore } from "../memory/store.js";
import {
  assembleConversationBrief,
  DEFAULT_RESUME_SESSION_COUNT,
  DEFAULT_RESUME_GAP_THRESHOLD_HOURS,
  DEFAULT_CONVERSATION_CONTEXT_BUDGET,
} from "../memory/conversation-brief.js";
// Phase 73 Plan 02 — per-agent conversation-brief cache (LAT-02).
import {
  ConversationBriefCache,
  computeBriefFingerprint,
} from "./conversation-brief-cache.js";
// Phase 85 Plan 02 — MCP section renderer (TOOL-02 / TOOL-05 / TOOL-07).
import { renderMcpPromptBlock } from "./mcp-prompt-block.js";
import type { McpServerState } from "../mcp/readiness.js";
// Phase 94 Plan 02 TOOL-03 — single-source-of-truth filter for the LLM-
// visible tool list. The filter wraps the MCP server set BEFORE the
// renderer assembles the stable-prefix tool block so the LLM never sees
// servers in degraded/failed/reconnecting/unknown states. The mutable
// suffix (operator-truth) reads the UNFILTERED snapshot for full
// visibility — see mcp-prompt-block.ts for that contract.
import {
  filterToolsByCapabilityProbe,
  type FlapHistoryEntry,
} from "./filter-tools-by-capability-probe.js";
// Phase 115 Plan 03 sub-scope 1 — MEMORY.md auto-load cap upgraded from
// the 50KB byte cap to the 16K char cap (`INJECTED_MEMORY_MAX_CHARS`).
// The legacy `MEMORY_AUTOLOAD_MAX_BYTES` constant remains exported from
// `config/schema.ts` for back-compat with the schema test that pins it
// (`src/config/__tests__/schema.test.ts:1672+`); this assembly path no
// longer references it. Char-cap import is folded into the
// context-assembler import block above.

// Phase 999.13 DELEG-02 — per-agent specialist delegate map renderer.
// Memory overhaul WP6 (2026-10-25): the Phase 94 directive resolver and
// renderer finally get a production caller: buildSessionConfig renders the
// enabled directives into `sources.systemPromptDirectives` (the assembler
// has carried that field since Phase 94 but nothing ever set it).
import {
  renderDelegatesBlock,
  renderSystemPromptDirectiveBlock,
  resolveSystemPromptDirectives,
} from "../config/loader.js";
import {
  DEFAULT_SYSTEM_PROMPT_DIRECTIVES,
  type SystemPromptDirective,
} from "../config/schema.js";
// Phase 117 Plan 04 T05 — advisor backend + model resolvers (config + SDK alias).
// `resolveAdvisorBackend` and `resolveAdvisorModel` in `config/loader.ts`
// implement the per-agent → defaults → baseline fall-through; the SDK
// alias map in `manager/model-resolver.ts` canonicalises `"opus"` →
// `"claude-opus-4-8"` before the value reaches the SDK Options surface.
// Both are pure functions — safe to call inside buildSessionConfig.
import {
  resolveAdvisorBackend as resolveAdvisorBackendConfig,
  resolveAdvisorModel as resolveAdvisorModelConfig,
} from "../config/loader.js";
import { resolveAdvisorModel as resolveAdvisorModelAlias } from "./model-resolver.js";
// Phase 999.98 D3 — Fable advisor-OMIT gate.
import {
  advisorPairingValid,
  advisorAllowedForExecutor,
  resolveModelId,
  resolveExecutorModelForGates,
} from "./model-resolver.js";
// Phase 94 Plan 05 — TOOL-08 / TOOL-09 auto-injected built-in tools.
// Tool DEFs (no mcpServer attribution) are appended to the LLM-visible
// tool block in every agent's stable prefix. Plan 94-02's filter sees no
// mcpServer attribution and lets them through unconditionally — they are
// built-in helpers, not MCP-backed.
import { CLAWCODE_FETCH_DISCORD_MESSAGES_DEF } from "./tools/clawcode-fetch-discord-messages.js";
import { CLAWCODE_SHARE_FILE_DEF } from "./tools/clawcode-share-file.js";
// Phase 96 Plan 02 — D-02 filesystem-capability block renderer + types.
// Imported here at session-config (the daemon edge) so the LLM's stable
// prefix carries the live <filesystem_capability> block alongside the
// Phase 85 <tool_status> and Phase 95 <dream_log_recent> blocks. The
// renderer is pure-DI (no fs/SDK reach); the snapshot comes from the
// fsCapabilitySnapshotProvider deps surface, which SessionManager wires
// to `this.getFsCapabilitySnapshotForAgent` (parallel to mcpStateProvider).
import { renderFilesystemCapabilityBlock } from "../prompt/filesystem-capability-block.js";
import type { FsCapabilitySnapshot } from "./persistent-session-handle.js";
// Phase 96 Plan 03 — D-07 auto-injected directory listing tool. Same
// auto-injection site as Phase 94's two helpers; LLMs use this to drill
// into operator-shared paths the system-prompt block (96-02) advertises
// at the path-root level. Token-guarded (depth max 3, entries max 500).
import { CLAWCODE_LIST_FILES_DEF } from "./tools/clawcode-list-files.js";

/**
 * Phase 53 Plan 02 — minimal logger shape accepted by `buildSessionConfig`.
 *
 * Mirrors pino's `Logger.warn` so the production code can pass its
 * `this.log` instance directly. Declared locally so this module has no
 * hard `pino` dependency (keeps transitive imports small).
 *
 * SECURITY: callers MUST NOT log prompt bodies here. `onBudgetWarning`
 * and `enforceSummaryBudget` send only `{ agent, section, beforeTokens,
 * budgetTokens, strategy }` — never the summary text.
 */
export type SessionConfigLoggerLike = {
  readonly warn: (obj: Record<string, unknown>, msg?: string) => void;
};

/**
 * Dependencies required by buildSessionConfig.
 * Passed in rather than accessed via `this` to decouple from SessionManager.
 *
 * Phase 52 Plan 02 — `priorHotStableToken` is threaded by SessionManager from
 * the per-agent map it maintains across turns so hot-tier placement (stable
 * vs mutable) decisions are stable across session-config rebuilds.
 *
 * Phase 53 Plan 02 — `log` is optional (back-compat): when supplied, it
 * receives pino WARN records when per-section budgets are exceeded and
 * when the resume-summary gets hard-truncated. Production SessionManager
 * always passes its logger; tests may omit it.
 */
export type SessionConfigDeps = {
  readonly tierManagers: Map<string, TierManager>;
  readonly skillsCatalog: SkillsCatalog;
  readonly allAgentConfigs: readonly ResolvedAgentConfig[];
  readonly priorHotStableToken?: string;
  readonly log?: SessionConfigLoggerLike;
  /**
   * Phase 53 Plan 03 — shared in-memory SkillUsageTracker. When absent,
   * the assembler treats the usage window as empty and the warm-up guard
   * (turns < threshold) keeps all skills rendering full content.
   */
  readonly skillUsageTracker?: SkillUsageTracker;
  /**
   * Phase 67 — per-agent ConversationStore map. When set (and `memoryStores`
   * also carries an entry for the agent), `buildSessionConfig` invokes
   * `assembleConversationBrief` and threads the rendered brief into the
   * `conversation_context` mutable-suffix section. Absent entries degrade
   * gracefully — no brief renders, no error.
   */
  readonly conversationStores?: Map<string, ConversationStore>;
  /**
   * Phase 67 — per-agent MemoryStore map. Required alongside
   * `conversationStores` for the brief-assembler path to run. Session
   * summaries are queried via `memoryStore.findByTag("session-summary")`.
   */
  readonly memoryStores?: Map<string, MemoryStore>;
  /**
   * Phase 67 — epoch-millisecond clock override. Defaults to `Date.now()` in
   * production. Injected so integration tests can simulate a 4-hour gap
   * boundary without `vi.setSystemTime()` or Date monkey-patching.
   */
  readonly now?: number;
  /**
   * Phase 73 Plan 02 — per-agent conversation-brief cache (LAT-02).
   *
   * When supplied, `buildSessionConfig` short-circuits `assembleConversationBrief`
   * when the current terminated-session-id fingerprint matches the cached
   * entry's fingerprint. Absent → legacy behavior (brief re-assembled every
   * call). Owned by SessionManager; invalidated on stopAgent + crash.
   */
  readonly briefCache?: ConversationBriefCache;
  /**
   * Phase 85 Plan 02 — per-agent MCP state provider (TOOL-02).
   *
   * When absent (tests, legacy bootstrap paths, first-boot before the
   * readiness handshake runs), the MCP renderer falls back to an empty
   * Map and every server renders as `status: unknown`. Production
   * SessionManager wires this to `this.getMcpStateForAgent` so the
   * prompt carries live readiness state.
   */
  readonly mcpStateProvider?: (
    agentName: string,
  ) => ReadonlyMap<string, McpServerState>;
  /**
   * Phase 94 Plan 02 TOOL-03 — per-agent flap-history Map provider.
   *
   * The filter mutates the returned Map in-place per call to count
   * ready ↔ non-ready transitions for the D-12 5min flap-stability
   * window. SessionManager wires this to the per-handle Map (stable
   * identity across all session-config rebuilds for the same agent).
   *
   * Optional — when absent, the filter still applies the ready/degraded
   * gate; the flap-stability window simply doesn't engage. Tests that
   * don't care about flap behavior can skip wiring it.
   */
  readonly flapHistoryProvider?: (
    agentName: string,
  ) => Map<string, FlapHistoryEntry>;
  /**
   * Phase 96 Plan 02 D-02 — per-agent filesystem-capability snapshot provider.
   *
   * When absent (tests, legacy bootstrap paths, first-boot before the
   * 60s heartbeat tick fires fs-probe), the renderer falls back to an
   * empty Map and `renderFilesystemCapabilityBlock` returns the empty
   * string (cache-stability invariant — STRICT no placeholder block per
   * 96-02 W-4 fix). Production SessionManager wires this to
   * `this.getFsCapabilitySnapshotForAgent` so the prompt carries the
   * live capability state.
   *
   * Together with the Section 4 mandatory fleet probe in
   * 96-07-DEPLOY-RUNBOOK.md, this closes the D-01 boot-probe approximation:
   * (a) operator runs fleet probe immediately after deploy → snapshot
   * persists → next session-config rebuild reads it; (b) heartbeat tick
   * (≤60s) refreshes ongoing.
   */
  readonly fsCapabilitySnapshotProvider?: (
    agentName: string,
  ) => ReadonlyMap<string, FsCapabilitySnapshot>;
  /**
   * Phase 100 follow-up — per-agent MCP env override resolver.
   *
   * When the agent declares `mcpEnvOverrides`, buildSessionConfig invokes
   * this resolver to substitute `op://...` URIs with concrete secret values
   * BEFORE the resulting AgentSessionConfig.mcpServers[].env is handed to
   * the SDK adapter. Implementation lives in
   * src/manager/op-env-resolver.ts (`resolveMcpEnvOverrides`); production
   * SessionManager wires the daemon's clawdbot-token-aware `op read` shell-
   * out (`defaultOpReadShellOut`).
   *
   * Optional — when absent (tests, bootstrap paths), `mcpEnvOverrides` is
   * silently skipped: the agent inherits the daemon's clawdbot-scoped token
   * from the shared mcpServers[].env (back-compat with the existing 15-
   * agent fleet behavior).
   *
   * Throws propagate — a bad op:// reference fails the agent start (loud
   * signal); SessionManager catches at the boundary and routes through the
   * MCP-failure path. We intentionally do NOT swallow errors here: the
   * alternative would silently inherit the daemon's full-fleet token,
   * defeating the entire vault-scoping objective.
   */
  readonly opEnvResolver?: (
    overrides: Record<string, Record<string, string>>,
    agentName: string,
  ) => Promise<Record<string, Record<string, string>>>;
  /**
   * Phase 999.7 — per-agent TraceCollector for context-audit telemetry.
   *
   * When supplied, buildSessionConfig opens a synthetic `bootstrap:<id>` Turn
   * around `assembleContextTraced` so the per-section `section_tokens`
   * metadata lands in traces.db. Without this, the wrapper is a no-op (no
   * Turn → no span → no metadata write) and `clawcode context-audit`
   * reports `sampledTurns: 0` for every agent.
   *
   * Captures per session-start (NOT per-turn — buildSessionConfig only runs
   * at agent start + hot-reload). One row per agent restart is enough to
   * surface the tail-of-context-budget hot spots; per-turn context refresh
   * is a separate phase.
   *
   * Optional — when absent (tests, legacy paths), behavior is unchanged
   * and `assembleContext` is called with no tracing.
   */
  readonly traceCollector?: TraceCollector;
  /**
   * Phase 117 Plan 04 T05 — advisor defaults block (`config.defaults.advisor`
   * from clawcode.yaml) and the daemon-wide AdvisorBudget.
   *
   * Together they let `buildSessionConfig` decide whether to spread-
   * conditionally inject `advisorModel` into `AgentSessionConfig` (which
   * the SDK adapter then forwards into `Options.advisorModel`). The
   * gate evaluates two conditions per RESEARCH §6 Pitfall 3 / §13.5:
   *
   *   1. `resolveAdvisorBackend(agent, defaults) === "native"` — the
   *      operator hasn't flipped the agent to the fork rollback path.
   *   2. `advisorBudget.canCall(agent.name) === true` — the per-agent
   *      per-day cap (`AdvisorBudget`, 10/day) is not exhausted.
   *
   * When EITHER condition is false, `advisorModel` is OMITTED from the
   * returned `AgentSessionConfig` (spread-conditional pattern; never
   * `{advisorModel: undefined}`). The adapter then omits the field from
   * the SDK Options object so the bundled `claude` CLI binary treats
   * the feature as off for that session.
   *
   * Optional — when absent (tests, bootstrap paths, fleet defaults not
   * loaded yet), buildSessionConfig falls through to the hard-coded
   * resolver defaults (`"native"` / `"opus"`) and the advisor is
   * enabled-by-default for the agent. Production daemon wires this in
   * via `SessionManager.setAdvisorDefaults(config.defaults.advisor)`
   * + `SessionManager.setAdvisorBudget(...)`.
   */
  readonly advisorDefaults?: {
    advisor?: {
      backend?: string;
      model?: string;
    };
  };
  readonly advisorBudget?: {
    canCall(agent: string): boolean;
  };
  /**
   * WP6 (2026-10-25): fleet-wide `defaults.systemPromptDirectives` from
   * clawcode.yaml. Threaded the same way as `advisorDefaults`. When absent
   * (tests, bootstrap paths, SessionManager not yet wired), the schema's
   * DEFAULT_SYSTEM_PROMPT_DIRECTIVES apply, which is what the zod default
   * puts in `defaults.systemPromptDirectives` anyway. The per-agent override
   * is read off `config.systemPromptDirectives` when the loader carries it.
   */
  readonly systemPromptDirectiveDefaults?: Readonly<Record<string, SystemPromptDirective>>;
  /**
   * Phase 127 Plan 02 — per-agent stream-stall callback factory.
   *
   * When supplied, `buildSessionConfig` invokes this with the agent's
   * resolved `{name, model, effort}` and threads the returned callback
   * into `AgentSessionConfig.onStreamStall`. Plan 01 declared the hook;
   * Plan 02 supplies the daemon-side implementation
   * ({@link src/manager/stream-stall-callback.ts:makeStreamStallCallback})
   * that fires the Discord webhook notification + JSONL stall row.
   *
   * Optional — when absent (tests, bootstrap paths, daemon boot before
   * WebhookManager + SessionLogger are wired), the callback is OMITTED
   * (spread-conditional pattern; `{onStreamStall: undefined}` is NEVER
   * set). The Plan 01 tracker still emits `phase127-stream-stall` log +
   * aborts via fireInterruptOnce(), so protective behavior holds even
   * without this hook.
   */
  readonly streamStallCallbackFactory?: (args: {
    readonly agentName: string;
    readonly model: string;
    readonly effort: string;
  }) => (payload: {
    readonly lastUsefulTokenAgeMs: number;
    readonly thresholdMs: number;
  }) => void;
  /**
   * WS-1 (999.99 structural delivery) — per-agent orphan-output delivery
   * callback factory. Mirrors the streamStallCallbackFactory pattern above:
   * production SessionManager supplies it in `configDeps()`
   * (makeOrphanDeliveryCallback → webhookManager.send to the agent's own
   * channel); absent in tests/bootstrap paths → the callback is OMITTED and
   * the demux warn-logs undeliverable orphan output instead of posting it.
   * Only consulted when the agent's `deliveryAttributedStream` is true.
   */
  readonly orphanDeliveryCallbackFactory?: (args: {
    readonly agentName: string;
  }) => (payload: {
    readonly text: string;
    readonly originKind: string | null;
    readonly isError: boolean;
    readonly classification:
      | "orphan-signaled"
      | "orphan-unsignaled"
      | "reclassified-from-daemon"
      // 999.99-F2 — late output of an abandoned daemon read (abort-deadline
      // / AbortSignal exit without the result). Same union as the demux's
      // canonical OrphanTurnOutput.classification.
      | "abandoned-daemon";
  }) => void;
};

/**
 * Compute the frozen per-agent bwrap bind-plan from the resolved config, or
 * `undefined` when the agent is NOT sandboxed (disabled or admin). Returning
 * undefined keeps `AgentSessionConfig.sandbox` omitted → the non-sandboxed
 * fleet's session config (and therefore its spawn) is byte-identical. The plan
 * is NON_RELOADABLE — captured here at session-config time and frozen into the
 * spawn argv downstream.
 */
function buildSandboxPlan(config: ResolvedAgentConfig): SandboxBindPlan | undefined {
  if (!config.sandbox.enabled || config.admin) return undefined;
  const home = homedir();
  const managerDir = dirname(MANAGER_SOCKET_PATH);
  const expand = (p: string): string =>
    p.replace(/^~(?=\/|$)/, home).replace(/\{agent\}/g, config.name);
  return {
    enabled: true,
    admin: false,
    allowRuntimeOp: config.sandbox.allowRuntimeOp,
    homeDir: home,
    // Per-agent claude config dir (Phase 145). Daemon-managed, OUTSIDE the bound
    // workspace, deterministic per agent so transcript-resume survives restart,
    // and bound only into THIS agent's namespace (other agents' dirs stay
    // invisible — deny-by-omission). Relocates claude's ~30 scratch subdirs +
    // session transcripts off the shared `~/.claude`.
    claudeConfigDir: join(home, ".clawcode", "agents", config.name, "claude-config"),
    workspace: config.workspace,
    memoryPath: config.memoryPath,
    channelsStateDir: join(home, ".clawcode", "channels-state", config.name),
    managerSock: MANAGER_SOCKET_PATH,
    brokerSock: join(managerDir, "mcp-broker.sock"),
    skillsPath: config.skillsPath,
    fileAccessRO: (config.fileAccess ?? []).map(expand),
    mcpDepPathsRO: discoverMcpDepPaths(config.mcpServers),
  };
}

/**
 * Phase 999.173 — research subagents are decided HERE, at session build (the
 * `agents` option is sent once in the SDK initialize request). Spread into both
 * returns (Rule 3); `{}` unless research is on for this session.
 */
function researchSessionFor(config: ResolvedAgentConfig): ResearchSessionConfig | undefined {
  return resolveResearchSession({
    name: config.name,
    model: config.model,
    ...(config.uxFeatures !== undefined ? { uxFeatures: config.uxFeatures } : {}),
    ...(config.research !== undefined ? { research: config.research } : {}),
    deliveryAttributedStream: config.deliveryAttributedStream === true,
  });
}

function researchSessionField(
  config: ResolvedAgentConfig,
): { researchSubagents: ResearchSessionConfig } | Record<string, never> {
  const r = researchSessionFor(config);
  return r === undefined ? {} : { researchSubagents: r };
}

/**
 * Phase 999.173 — routing steers for research-enabled agents. Every other
 * agent keeps the pre-999.173 sentences byte-identically (prompt-cache prefix
 * stability); these replace them only when research is on.
 */
const RESEARCH_THREAD_GUIDANCE =
  "You have the **subagent-thread** skill. Use the `spawn_subagent_thread` MCP tool ONLY when the user " +
  "explicitly asks for a thread or a visible subagent. For research, deep dives, investigations and " +
  "comparisons, launch `researcher` subagents with the Agent tool instead: they run in the background " +
  "while a live research card shows their progress.\n";
const RESEARCH_SELF_FIRED_STEER =
  "If you ever run a self-scheduled or background turn that is NOT a researcher finishing, deliver its " +
  "result by calling `mcp__clawcode__post_to_agent` (to your own channel). When your researcher subagents " +
  "finish, write the synthesis as plain text: ClawCode delivers it as a reply to the user's original " +
  "message, so never post_to_agent a research synthesis. Each researcher's notes are saved as it works in " +
  "research/<date>-<message id>/ in your workspace (Findings at the top of each file): when a researcher " +
  "failed or was stopped, read its file and use what it found instead of redoing the work.";
const RESEARCH_WORKFLOW_STEER =
  "For research, deep dives, investigations and comparisons, launch 2-4 `researcher` subagents in " +
  "parallel with the Agent tool (subagent_type \"researcher\", one per sub-question): they run in the " +
  "background with a live research card, and when they have all finished you write ONE synthesis. " +
  "Use the `mcp__clawcode__start_workflow` tool ONLY when the user explicitly asks for a workflow.";

/** Phase 999.171 — true when the resolved block has at least one UX flag on. */
function hasAnyUxFeature(
  ux: ResolvedAgentConfig["uxFeatures"],
): ux is NonNullable<ResolvedAgentConfig["uxFeatures"]> {
  return ux !== undefined && (ux.liveThinking || ux.promptSuggestions || ux.researchSubagents);
}

/**
 * Phase 999.172 — the UX block a session STARTS with.
 *
 * `promptSuggestions` is a session-start option (sent once in the CLI's
 * initialize request), so the `/clawcode-ux` override is resolved HERE, at
 * create/resume, not only at render time. It is forced off for every
 * machine-generated session (thread/subagent/pool/fork): a thread session's
 * config is a snapshot of its parent's, and suggestions belong to the agent's
 * own Discord replies only. liveThinking / researchSubagents pass through as
 * configured (liveThinking is read per message by the bridge; research is
 * 999.173's).
 */
export function sessionUxFeatures(
  config: Pick<ResolvedAgentConfig, "name" | "uxFeatures">,
): ResolvedAgentConfig["uxFeatures"] {
  const base = config.uxFeatures;
  const promptSuggestions =
    !isManagedWorkerName(config.name) &&
    resolveUxFeature(config.name, "promptSuggestions", base).enabled;
  if (base === undefined && !promptSuggestions) return undefined;
  return {
    liveThinking: base?.liveThinking ?? false,
    statusPing: base?.statusPing ?? false,
    promptSuggestions,
    researchSubagents: base?.researchSubagents ?? false,
  };
}

/**
 * Build an AgentSessionConfig from a ResolvedAgentConfig.
 * Reads SOUL.md and IDENTITY.md from the workspace for systemPrompt.
 * Injects hot memories, skills, admin info, subagent config, and context summary.
 */
export async function buildSessionConfig(
  config: ResolvedAgentConfig,
  deps: SessionConfigDeps,
  contextSummary?: string,
  bootstrapStatus?: BootstrapStatus,
): Promise<AgentSessionConfig> {
  // Frozen at session-config time (NON_RELOADABLE); carried symmetrically
  // through BOTH the bootstrap-needed and the main return (Rule 3).
  const sandboxPlan = buildSandboxPlan(config);
  // Phase 999.172 — resolved once, carried by BOTH returns (Rule 3).
  const sessionUx = sessionUxFeatures(config);
  // Bootstrap-needed agents get the walkthrough prompt instead of normal config
  if (bootstrapStatus === "needed") {
    let systemPrompt = buildBootstrapPrompt({
      workspace: config.workspace,
      agentName: config.name,
      channels: [...config.channels],
    });

    // Still include Discord channel bindings even during bootstrap
    const channels = config.channels ?? [];
    if (channels.length > 0) {
      systemPrompt += "\n\n## Discord Communication\n";
      systemPrompt += `You are bound to Discord channel(s): ${channels.join(", ")}\n`;
      systemPrompt += "Messages from Discord are delivered to you automatically. ";
      systemPrompt += "Your text responses are sent back to Discord automatically — just respond normally. ";
      systemPrompt += "Do NOT use Discord REST API calls, bot tokens, or any Discord tools to reply. ";
      systemPrompt += "Simply output your response as text and the system handles delivery.";
    }

    return {
      name: config.name,
      model: config.model,
      effort: config.effort,
      workspace: config.workspace,
      systemPrompt: systemPrompt.trim(),
      channels,
      contextSummary,
      // Phase 99 sub-scope N (2026-04-26) — propagate disallowedTools through
      // the bootstrap-needed path too. Spread-conditional matches the main
      // return below so the field is OMITTED rather than explicitly undefined
      // when not set (preserves byte-stable deep-equality regression pins).
      ...(config.disallowedTools && config.disallowedTools.length > 0
        ? { disallowedTools: config.disallowedTools }
        : {}),
      // Phase 999.162 — per-agent tool search rides the same spread-conditional discipline.
      ...(config.toolSearch !== undefined ? { toolSearch: config.toolSearch } : {}),
      // claude.ai connector entitlement (Rule 3 symmetric edit; matches the main
      // return below). Omitted unless entitled, so the rest of the fleet's config
      // stays byte-identical.
      ...(config.claudeAiConnectors === true ? { claudeAiConnectors: true as const } : {}),
      // Phase 999.171 — UX toggles through the bootstrap-needed path too (Rule 3
      // symmetric edit; matches the main return below). Omitted unless a flag is on.
      ...(hasAnyUxFeature(sessionUx) ? { uxFeatures: sessionUx } : {}),
      // Quick 260715-j1j (D5/D11) — propagate nativeWorkflow through the
      // bootstrap-needed path too (Rule 3 symmetric edit; matches the main
      // return below). Spread-conditional so the non-opted fleet's config
      // stays byte-identical (field omitted).
      ...(config.nativeWorkflow === true ? { nativeWorkflow: true as const } : {}),
      // Phase 999.173 — research subagents (Rule 3 symmetric; omitted unless on).
      ...researchSessionField(config),
      // WS-1 (999.99 structural delivery) — propagate the attributed-stream
      // pair through the bootstrap-needed path too (Rule 3 symmetric edit;
      // matches the main return below). A canary agent's FIRST boot must not
      // silently revert to the buffering legacy consumption.
      ...(config.deliveryAttributedStream === true
        ? { attributedStream: true as const }
        : {}),
      ...(config.deliveryAttributedStream === true &&
      deps.orphanDeliveryCallbackFactory !== undefined
        ? {
            onOrphanTurnOutput: deps.orphanDeliveryCallbackFactory({
              agentName: config.name,
            }),
          }
        : {}),
      // Phase 115 sub-scope 2 — propagate excludeDynamicSections through
      // the bootstrap path too so the SDK strips dynamic sections even on
      // first-spawn agents (Rule 3 symmetric edit; matches the main return
      // below). Always populated from ResolvedAgentConfig (default true).
      excludeDynamicSections: config.excludeDynamicSections,
      // Per-agent OS sandbox — carried on the bootstrap path too (Rule 3
      // symmetric edit; matches the main return below). Spread-conditional so
      // a non-sandboxed agent's config is byte-identical (field omitted).
      ...(sandboxPlan ? { sandboxPlan } : {}),
    };
  }

  // --- Collect identity sources ---
  //
  // Phase 115 Plan 03 sub-scope 1 — carved into FOUR sub-source fields so
  // the assembler can budget each independently via
  // `enforceDropLowestImportance` (T02). The legacy single `identityStr`
  // is also kept (composed at the end) for back-compat with any consumer
  // still reading `sources.identity`.

  // Phase 78 CONF-01 — SOUL content via the 3-branch precedence in
  // persona-files.ts (soulFile → <workspace>/SOUL.md → inline soul, silent
  // fall-through). Content is used for fingerprint extraction only (LOAD-02) —
  // full SOUL.md text is never embedded in the system prompt.
  const soulContent = await readSoulContent(config);

  let identitySoulFingerprint = "";
  if (soulContent) {
    const fingerprint = extractFingerprint(soulContent);
    identitySoulFingerprint = formatFingerprint(fingerprint);
  }

  // Phase 78 CONF-01 — IDENTITY content via the same precedence
  // (identityFile → <workspace>/IDENTITY.md → inline identity). Unlike soul,
  // the full identity text is appended to the system prompt.
  const identityContent = await readIdentityContent(config);

  const identityFile = identityContent;

  // Inject agent name and recall guidance (LOAD-01)
  // Phase 115 Plan 03 sub-scope 1 — agent-name line + capability manifest
  // are composed into a single sub-source field so the assembler treats
  // them as one budget-able unit (mid-low importance — bullet-truncated).
  // WP6 (2026-10-25): the line used to point at `memory_lookup` while the
  // capability manifest teaches `clawcode_memory_search`; one prompt, two
  // tool vocabularies. It now names the same tools the manifest does.
  let identityCapabilityManifest =
    `Your name is ${config.name}. Pass '${config.name}' as the agent parameter to tools that ask for it. ` +
    `For anything older than what is shown here, call clawcode_memory_search (your saved memory and notes) and search_documents (uploaded files).\n`;

  // Phase 100 follow-up — capability manifest (after identity, before
  // MEMORY.md auto-load and MCP block). Sits in the cached stable prefix
  // so the LLM has its enabled-feature list in context every turn
  // without paying re-render cost. Returns "" for minimal agents (no
  // dream, no schedules, no subagent-thread skill, no GSD) — we only
  // pay the prompt cost for agents with notable opt-ins. Root cause:
  // fin-client claimed it didn't dream while dreams were being
  // persisted under memory/dreams/ (2026-04-27 operator surface).
  // Phase 999.173 — research routing steers (below) key on the same
  // session-start decision as the `agents` option.
  const researchOn = researchSessionFor(config) !== undefined;
  const capabilityManifest = buildCapabilityManifest(config, { researchSubagents: researchOn });
  if (capabilityManifest.length > 0) {
    identityCapabilityManifest += "\n" + capabilityManifest;
  }

  // Phase 90 MEM-01 + Phase 115 Plan 03 sub-scope 1 — MEMORY.md auto-load
  // into stable prefix, AFTER SOUL+IDENTITY and BEFORE MCP status (per D-18).
  //
  // Phase 115 D-01 lock — char cap of `INJECTED_MEMORY_MAX_CHARS = 16,000`
  // REPLACES the legacy 50KB byte cap. When over cap, head-tail truncate
  // (70/20 — Hermes precedent) with a marker between head and tail:
  //
  //   [TRUNCATED — N chars dropped, dream-pass priority requested]
  //
  // The marker text is intentionally agent-actionable: when the agent reads
  // its own MEMORY.md and sees this, it understands that a priority dream-pass
  // has been requested at the daemon side (D-05 — Plan 115-05 wires the
  // consumer-side dream-cron re-schedule).
  //
  // Daemon-side: emit `[diag] tier1-truncation` warn (sub-scope 13c upgrade
  // from `memory-md-truncation` — preserves the same warn channel pattern
  // shipped in 115-02 but tags this as a TIER-1 event, distinct from random
  // file truncation). Best-effort `recordTier1TruncationEvent` on the
  // TraceCollector — the column slot is open in 115-00 but the method
  // landing here defensively guards against absence (typeof check).
  //
  // Silent fall-through on missing file (same semantics as SOUL/IDENTITY
  // branches above). Opt-out via config.memoryAutoLoad === false; override
  // path via config.memoryAutoLoadPath (absolute, loader expanded ~/...).
  // fleet-audit-2026-06-16 (H4) — per-agent override for the MEMORY.md
  // auto-load char cap. Defaults to the module const (16,000 — byte-for-byte
  // no-op for the fleet). An agent whose tier-1 injection runs hot (Admin
  // Clawdy, 82% of budget) can lower this via
  // `perf.memoryAssemblyBudgets.injectedMemoryMaxChars` to shrink its stable-
  // prefix cost without a code change. The schema already bounds it to
  // [1000, 16000]; the `?? const` keeps the const ceiling as the hard floor.
  const memoryMaxChars =
    config.perf?.memoryAssemblyBudgets?.injectedMemoryMaxChars ??
    INJECTED_MEMORY_MAX_CHARS;

  let identityMemoryAutoload = "";
  let identityUserAutoload = "";
  // Phase 999.187 — MEMORY.md and USER.md come from the ONE Tier 1 directory
  // that `clawcode_memory_edit` / `_archive` write to (`resolveMemoryRoots`).
  // Before this the prompt read `<workspace>/MEMORY.md` while the tools wrote
  // `<memoryPath>/MEMORY.md`, so an agent with `memoryPath` set edited memory
  // it never saw. When the canonical file is absent but the legacy workspace
  // copy exists, the legacy copy is loaded and a warning names both paths so
  // the operator can move it.
  const memoryRoots = resolveMemoryRoots({
    workspace: config.workspace,
    memoryPath: config.memoryPath,
    memoryAutoLoadPath: config.memoryAutoLoadPath,
  });
  const readTier1File = async (
    file: "MEMORY.md" | "USER.md",
    canonical: string,
    legacy: string | null,
  ): Promise<string | null> => {
    try {
      return await readFile(canonical, "utf-8");
    } catch {
      /* fall through to the legacy location */
    }
    if (!legacy) return null;
    try {
      const raw = await readFile(legacy, "utf-8");
      deps.log?.warn(
        {
          agent: config.name,
          file,
          loaded: legacy,
          canonical,
          action: "memory-root-legacy-fallback",
        },
        `[diag] ${file} loaded from the legacy workspace path; the memory tools write to the canonical path — move the file`,
      );
      return raw;
    } catch {
      return null;
    }
  };
  if (config.memoryAutoLoad !== false) {
    const memoryPath = memoryRoots.memoryMdPath;
    const raw = await readTier1File("MEMORY.md", memoryPath, memoryRoots.legacyMemoryMdPath);
    if (raw !== null) {
      let body = raw;
      if (body.length > memoryMaxChars) {
        // Phase 115 D-01 + D-04 — Hermes 70/20 head-tail truncation. 10%
        // dropped from the middle. Marker is agent-actionable: it requests
        // a priority dream-pass (D-05 trigger).
        const headLen = Math.floor(memoryMaxChars * 0.7);
        const tailLen = Math.floor(memoryMaxChars * 0.2);
        const originalChars = body.length;
        const dropped = originalChars - headLen - tailLen;
        const head = body.slice(0, headLen);
        const tail = body.slice(-tailLen);
        body = `${head}\n\n[TRUNCATED — ${dropped} chars dropped, dream-pass priority requested]\n\n${tail}`;

        // Phase 115 sub-scope 13(c) upgrade — daemon-side warn. Action label
        // upgraded `memory-md-truncation` → `tier1-truncation` to distinguish
        // tier-1-level events (Phase 115 enforcement) from earlier 50KB-byte
        // truncation events (Phase 90 era). Operator-grep-friendly.
        if (deps.log) {
          deps.log.warn(
            {
              agent: config.name,
              originalChars,
              capChars: memoryMaxChars,
              droppedChars: dropped,
              file: "MEMORY.md",
              action: "tier1-truncation",
            },
            "[diag] tier1-truncation",
          );
        }

        // Phase 115 D-05 + cross-plan defensive wiring — record the event
        // on TraceCollector so Plan 115-05's dream-cron consumer can read
        // the count and trip a per-agent priority dream-pass when the
        // 2-in-24h trigger fires. Method may not yet exist on the
        // collector (115-00 opened the column slot but consumers add their
        // own write methods). Same `typeof === "function"` guard pattern
        // as 115-02 used for `incrementPromptBloatWarning`.
        const tc = deps.traceCollector as
          | (TraceCollector & {
              recordTier1TruncationEvent?: (agent: string) => void;
            })
          | undefined;
        if (tc && typeof tc.recordTier1TruncationEvent === "function") {
          try {
            tc.recordTier1TruncationEvent(config.name);
          } catch {
            // never let observability block startup
          }
        }
      }
      identityMemoryAutoload = body;
    }
    // MEMORY.md not present → silently skip. Absence is the common case on
    // first-boot agents.

    // Phase 999.187 — USER.md rides in the same Tier 1 block. The memory
    // protocol has told every agent since Phase 115 that "MEMORY.md and
    // USER.md" are always shown above; USER.md was never loaded. Same
    // head/tail truncation as MEMORY.md under its own (smaller) cap.
    // WP6 (2026-10-25): carried as its OWN sub-source
    // (`identityUserAutoload`) instead of being appended to the MEMORY.md
    // body: the assembler's identity budget now shrinks MEMORY.md to its
    // floor before it touches the user profile, and the read-site marker
    // below survives that pass.
    const userMaxChars =
      config.perf?.memoryAssemblyBudgets?.injectedUserMaxChars ??
      INJECTED_USER_MAX_CHARS;
    const userRaw = await readTier1File("USER.md", memoryRoots.userMdPath, memoryRoots.legacyUserMdPath);
    if (userRaw !== null && userRaw.trim().length > 0) {
      let userBody = userRaw;
      if (userBody.length > userMaxChars) {
        const headLen = Math.floor(userMaxChars * 0.7);
        const tailLen = Math.floor(userMaxChars * 0.2);
        const originalChars = userBody.length;
        const dropped = originalChars - headLen - tailLen;
        userBody = `${userBody.slice(0, headLen)}\n\n[TRUNCATED — ${dropped} chars dropped; keep USER.md under ${userMaxChars} chars]\n\n${userBody.slice(-tailLen)}`;
        deps.log?.warn(
          {
            agent: config.name,
            originalChars,
            capChars: userMaxChars,
            droppedChars: dropped,
            file: "USER.md",
            action: "tier1-truncation",
          },
          "[diag] tier1-truncation",
        );
      }
      identityUserAutoload = userBody;
    }
  }

  // Phase 115 Plan 03 sub-scope 1 — also build the legacy compound
  // `identityStr` so the rendered stable-prefix preserves byte-compat
  // with pre-115 sessions for agents whose sub-sources are unchanged.
  // The assembler now prefers the four carved fields when present (T01)
  // and falls back to this string for tests that pass only `identity`.
  let identityStr = "";
  if (identitySoulFingerprint) {
    identityStr += identitySoulFingerprint + "\n\n";
  }
  if (identityFile) {
    identityStr += identityFile;
  }
  identityStr += identityCapabilityManifest;
  if (identityMemoryAutoload) {
    identityStr +=
      "\n## Long-term memory (MEMORY.md)\n\n" + identityMemoryAutoload + "\n";
  }
  if (identityUserAutoload) {
    identityStr +=
      "\n## About the user (USER.md)\n\n" + identityUserAutoload + "\n";
  }

  // --- Collect hot memories source ---
  //
  // Phase 53 Plan 02: we now track BOTH the rendered string (kept for
  // cache-hash continuity with Phase 52) AND the raw MemoryEntry list so the
  // assembler can apply importance-ordered truncation when hot_tier exceeds
  // its per-section budget.
  let hotMemoriesStr = "";
  let hotMemoriesEntries: readonly MemoryEntry[] = [];
  const agentTierManager = deps.tierManagers.get(config.name);
  if (agentTierManager) {
    const hotMemories = agentTierManager.getHotMemories().slice(0, 3);
    hotMemoriesEntries = hotMemories;
    if (hotMemories.length > 0) {
      // WP6: each bullet carries its created date (renderHotMemoryLine).
      hotMemoriesStr = hotMemories
        .map((mem) => renderHotMemoryLine(mem))
        .join("\n");
    }
  }

  // --- Collect skills header source (Phase 53 Plan 02 + Plan 03) ---
  //
  // Phase 53 Plan 02 carved skill descriptions out of `toolDefinitionsStr`
  // so the assembler could budget the section independently. Plan 53-03
  // layers lazy-skill compression on top: we now build a per-skill catalog
  // with `fullContent` AND the legacy bullet-line pre-rendering, then let
  // the assembler decide which to render per skill via its decision matrix
  // (full for recently-used / mentioned / warm-up; compressed otherwise).
  let skillsHeaderStr = "";
  const skillsCatalogEntries: SkillCatalogEntry[] = [];
  const assignedSkills = config.skills ?? [];
  if (assignedSkills.length > 0) {
    const skillDescriptions: string[] = [];
    for (const skillName of assignedSkills) {
      const entry = deps.skillsCatalog.get(skillName);
      if (entry) {
        const versionPart =
          entry.version !== null ? ` (v${entry.version})` : "";
        const bullet = `- **${entry.name}**${versionPart}: ${entry.description}`;
        skillDescriptions.push(bullet);
        // Full content falls back to the description bullet when a real
        // SKILL.md body is not wired in yet. This keeps the lazy-skill
        // decision matrix working from day one; a follow-up can read the
        // on-disk SKILL.md body via `entry.path` if we want maximum savings.
        skillsCatalogEntries.push(
          Object.freeze({
            name: entry.name,
            description: entry.description,
            fullContent: bullet,
          }),
        );
      }
    }
    if (skillDescriptions.length > 0) {
      skillsHeaderStr += skillDescriptions.join("\n");
      skillsHeaderStr +=
        "\n\nYour skill directories are symlinked in your workspace under skills/. Read SKILL.md in each for detailed instructions.\n";
    }
  }

  // 999.103 WS-2 — superpowers dormancy gate. The plugin's skills (brainstorm,
  // write-plans, ...) are powerful but coding-workflow-opinionated; the
  // operator's decision is REFERENCED, NOT AUTO-INVOKED. This line is the
  // instruction gate: the plugin stays installed and discoverable, and the
  // model is told to reach for it only on an explicit operator ask. Gated on
  // the agent's plugin list so the untouched fleet's prompts stay
  // byte-identical (prompt-cache prefix stability).
  const hasSuperpowers = (config.plugins ?? []).some((p) =>
    p.startsWith("superpowers@"),
  );
  if (hasSuperpowers) {
    skillsHeaderStr +=
      "\nThe superpowers plugin (brainstorming / writing-plans / executing-plans) is installed but OFF by default: invoke its skills ONLY when the operator explicitly asks (e.g. \"use superpowers\", \"brainstorm this\", \"write a plan\"). For ordinary multi-step work, plan with your built-in todo list instead - the operator sees it live in this channel.\n";
  }

  // --- Collect tool definitions source (MCP + admin + subagent) ---
  let toolDefinitionsStr = "";

  // Subagent thread skill guidance (SASK-03)
  const hasSubagentThreadSkill = (config.skills ?? []).includes("subagent-thread");
  if (hasSubagentThreadSkill && researchOn) {
    toolDefinitionsStr += RESEARCH_THREAD_GUIDANCE;
  } else if (hasSubagentThreadSkill) {
    toolDefinitionsStr += "You have the **subagent-thread** skill. When you need to delegate work to a subagent ";
    toolDefinitionsStr += "and want the work visible in Discord, prefer the `spawn_subagent_thread` MCP tool ";
    toolDefinitionsStr += "over the raw Agent tool.\n\n";
    toolDefinitionsStr += "The `spawn_subagent_thread` tool creates a dedicated Discord thread where the subagent ";
    toolDefinitionsStr += "operates. This makes the subagent's work visible to channel members and provides a ";
    toolDefinitionsStr += "shareable thread URL.\n\n";
    toolDefinitionsStr += "Use the raw Agent tool only when Discord visibility is NOT needed (e.g., quick internal ";
    toolDefinitionsStr += "computations, file operations that don't need a thread).\n";
  }

  // Phase 85 TOOL-02 / TOOL-05 / TOOL-07 — MCP block rendered by a pure
  // helper that includes (a) the pre-authenticated framing, (b) a live
  // status table sourced from mcpStateProvider, (c) the verbatim-error
  // rule. The concatenation lands in `sources.toolDefinitions`, which the
  // v1.7 two-block assembler places in the STABLE PREFIX — survives
  // compaction-driven prompt-cache eviction.
  //
  // Pitfall 12 closure: the replaced block leaked `command`/`args` into
  // every prompt. renderMcpPromptBlock reads only `name`, `optional`, and
  // `state.lastError.message` — command/args/env values never reach the
  // prompt surface.
  const mcpServers = config.mcpServers ?? [];
  if (mcpServers.length > 0) {
    const mcpState = deps.mcpStateProvider?.(config.name) ?? new Map();
    // Phase 94 Plan 02 TOOL-03 — single-source-of-truth filter call site.
    // Pre-filter the LLM-visible server set BEFORE the renderer assembles
    // the stable-prefix tool block. Each MCP server is represented as a
    // ToolDef whose mcpServer attribution is its own name; the filter
    // drops any server whose capabilityProbe.status !== "ready" (D-04 +
    // D-12 sticky-degraded). When Playwright is degraded, the LLM does
    // not see the `browser` server in its tool table at all → it cannot
    // promise screenshots. When auto-recovery (Plan 94-03) restores the
    // probe to ready, the next session-config rebuild re-includes the
    // server.
    //
    // Static-grep regression pin: this is the SOLE call site of
    // filterToolsByCapabilityProbe in src/. context-assembler.ts and
    // mcp-prompt-block.ts MUST NOT call the filter — they consume the
    // already-filtered output (mcp-prompt-block) or render unrelated
    // structure (context-assembler).
    const flapHistory = deps.flapHistoryProvider?.(config.name);
    const tools = mcpServers.map((s) => ({
      name: s.name,
      mcpServer: s.name,
    }));
    const filteredToolNames = new Set(
      filterToolsByCapabilityProbe(tools, {
        snapshot: mcpState,
        flapHistory,
      }).map((t) => t.name),
    );
    const advertisedServers = mcpServers.filter((s) =>
      filteredToolNames.has(s.name),
    );
    const mcpBlock = renderMcpPromptBlock({
      servers: advertisedServers,
      stateByName: mcpState,
    });
    if (mcpBlock.length > 0) {
      toolDefinitionsStr += toolDefinitionsStr.length > 0 ? "\n\n" : "";
      toolDefinitionsStr += mcpBlock;
    }
  }

  // Phase 94 Plan 05 — TOOL-08 / TOOL-09 auto-injected built-in tools.
  //
  // Both tools are advertised to EVERY agent regardless of mcpServers list,
  // skill assignment, or admin status. They are built-in helpers (no
  // mcpServer attribution) so the Plan 94-02 capability-probe filter never
  // removes them. The render shape is intentionally minimal — the LLM
  // already understands tool defs from input_schema; this block is just a
  // discoverability hint inside the system prompt.
  //
  // Static-grep regression: tool names MUST appear verbatim in the
  // assembled stable prefix for every agent (clean or configured). Tests
  // cover the synthetic "clean agent" baseline.
  toolDefinitionsStr += toolDefinitionsStr.length > 0 ? "\n\n" : "";
  toolDefinitionsStr += "## Built-in Discord helpers (auto-injected)\n";
  toolDefinitionsStr += `- **${CLAWCODE_FETCH_DISCORD_MESSAGES_DEF.name}**: ${CLAWCODE_FETCH_DISCORD_MESSAGES_DEF.description}\n`;
  toolDefinitionsStr += `- **${CLAWCODE_SHARE_FILE_DEF.name}**: ${CLAWCODE_SHARE_FILE_DEF.description}\n`;
  // Phase 96 Plan 03 — D-07 auto-injected directory listing tool. Built-in
  // (no mcpServer attribution); the Plan 94-02 capability-probe filter
  // never removes it. Boundary-checked through 96-01 checkFsCapability;
  // out-of-allowlist refusals carry alternatives via D-08
  // findAlternativeFsAgents.
  toolDefinitionsStr += `- **${CLAWCODE_LIST_FILES_DEF.name}**: ${CLAWCODE_LIST_FILES_DEF.description}\n`;

  // Admin agent information (per D-11, D-12)
  if (config.admin && deps.allAgentConfigs.length > 0) {
    const otherAgents = deps.allAgentConfigs.filter(
      (a) => a.name !== config.name,
    );
    if (otherAgents.length > 0) {
      toolDefinitionsStr += toolDefinitionsStr.length > 0 ? "\n\n" : "";
      toolDefinitionsStr += "You are the admin agent. You can read files in any agent's workspace and coordinate cross-agent tasks.\n\n";
      toolDefinitionsStr += "| Agent | Workspace | Model |\n";
      toolDefinitionsStr += "|-------|-----------|-------|\n";
      for (const agent of otherAgents) {
        toolDefinitionsStr += `| ${agent.name} | ${agent.workspace} | ${agent.model} |\n`;
      }
      toolDefinitionsStr +=
        "\nTo send a message to another agent, describe what you want to communicate and the system will route it via the messaging system.\n";
    }
  }

  // Subagent model guidance (per D-02, D-03)
  if (config.subagentModel) {
    toolDefinitionsStr += toolDefinitionsStr.length > 0 ? "\n\n" : "";
    toolDefinitionsStr += `When spawning subagents via the Agent tool, use model: "${config.subagentModel}" unless a specific task requires a different model.\n`;
  }

  // --- Collect Discord bindings source ---
  let discordBindingsStr = "";
  const channels = config.channels ?? [];
  if (channels.length > 0) {
    discordBindingsStr += "## Discord Communication\n";
    discordBindingsStr += `You are bound to Discord channel(s): ${channels.join(", ")}\n`;
    discordBindingsStr += "Messages from Discord are delivered to you automatically. ";
    discordBindingsStr += "Your text responses are sent back to Discord automatically — just respond normally. ";
    discordBindingsStr += "Do NOT use Discord REST API calls, bot tokens, or any Discord tools to reply. ";
    discordBindingsStr += "Simply output your response as text and the system handles delivery.";
    // Phase 999.99 — recurring-poll delivery steer. Rides discordBindingsStr →
    // assembler `discordBindings` input (:945) → context-assembler staticParts
    // → stablePrefix → main return systemPrompt (:1133), so EVERY steady-state
    // channel-bound fleet agent sees it (NOT the bootstrap-only branch at
    // :366-384, which the running fleet never reaches — anchoring there is a
    // documented false-green). This is the EXCEPTION TO, not a reversal of, the
    // "output your response as text and the system handles delivery" line above:
    // that auto-delivery only collects turns the daemon itself drives. A
    // SELF-SCHEDULED / background turn runs outside the collector, so its plain
    // text buffers in driverIter and drains one-per-inbound-message (CONTEXT
    // §2c — the operator's "I have to keep prompting to flush the buffered poll
    // responses" symptom). The steer points the model at the delivered
    // primitive (schedule_recurring, Plan 01) and the proven escape hatch
    // (post_to_agent). It is load-bearing for Monitor, which is steered-not-
    // blocked (Q3). Appending here churns the stablePrefix computePrefixHash
    // ONCE on rollout (intended fleet-wide cache bust, like the context-bloat
    // fix #3a precedent). Emitted exactly once. V3-REACH: this is the v2 (Agent SDK) stablePrefix; if the v3 PTY
    // backend assembles its prompt outside buildSessionConfig the steer is
    // v2-only — the hard BLOCK (disallowedTools) still covers v3 via Phase 141
    // #7, so SC-2's "blocked" half holds fleet-wide.
    discordBindingsStr += " ";
    discordBindingsStr += "For recurring work ('poll X every N minutes', periodic checks), use the `schedule_recurring` tool — each tick posts to your channel as a standalone message. ";
    discordBindingsStr += researchOn
      ? RESEARCH_SELF_FIRED_STEER
      : "If you ever run a self-scheduled or background turn, deliver its result by calling `mcp__clawcode__post_to_agent` (to your own channel). Do NOT assume plain text output from a self-fired turn will appear in Discord — it will not; it buffers and is lost.";
    // quick task 260714-mkq — workflow steering. Mirrors the schedule_recurring
    // + post_to_agent steer above. Lives in this never-truncated Discord steer
    // so the guidance survives the identity-budget tail truncation that clips
    // the capability-manifest section-12 `start_workflow` bullet. Steers agents
    // onto the recoverable daemon `start_workflow` path and OFF the native
    // in-session Workflow tool, whose lanes run inside the turn and were killed
    // when the turn ended (2026-07-14 stall-kill incident).
    // Quick 260715-j1j (D11) — the anti-Workflow sentence is now CONDITIONAL
    // on the per-agent nativeWorkflow opt-in. Non-opted agents (the fleet)
    // keep the 260714-mkq sentence byte-identically (load-bearing for the
    // stablePrefix prompt-cache hash; pinned by
    // session-config-workflow-steer.test.ts). Opted-in agents get the
    // inverted, bounded variant — native Workflow permitted for in-turn
    // parallel lanes (lanes ≤4), start_workflow still preferred for
    // long-running background work that must survive the turn.
    discordBindingsStr += " ";
    if (researchOn) {
      discordBindingsStr += RESEARCH_WORKFLOW_STEER + " ";
    }
    if (config.nativeWorkflow === true) {
      discordBindingsStr += "The native in-session Workflow tool is PERMITTED for this agent for in-turn parallel lanes — keep concurrent lanes ≤4 (bounded fan-out). Still prefer the `mcp__clawcode__start_workflow` tool for long-running background work that must survive the turn: it returns immediately, posts progress + results to your channel, and a stuck step auto-aborts.";
    } else if (researchOn) {
      discordBindingsStr += "Do NOT use the native in-session Workflow tool: it runs inside your turn and is killed when the turn ends, so its results are lost and its failure is invisible.";
    } else {
      discordBindingsStr += "For background fan-out (running several independent tasks in parallel), use the `mcp__clawcode__start_workflow` tool — it returns immediately, posts progress + results to your channel, and a stuck step auto-aborts. Do NOT use the native in-session Workflow tool for this: it runs inside your turn and is killed when the turn ends, so its results are lost and its failure is invisible.";
    }
  }

  // --- Collect context summary source (Phase 53 Plan 02 — CTX-04) ---
  //
  // The session-resume summary gets a HARD token budget enforced BEFORE it
  // lands in the assembler's mutable suffix. When over budget, we attempt
  // up-to-2 regenerations (future work — no live regenerator wired today)
  // then hard-truncate with a WARN. Default 1500, floor 500 (per D-04).
  let contextSummaryStr = "";
  const loadedSummary =
    contextSummary ??
    // Phase 75 SHARED-02 — loadLatestSummary must resolve against
    // memoryPath (not workspace) so shared-workspace agents find the
    // context-summary.md that saveContextSummary wrote under
    // memoryPath/memory/. For dedicated-workspace agents the loader
    // fallback makes workspace === memoryPath, so this is a no-op.
    // WP6: loadLatestSummary now skips the heartbeat placeholder and any
    // file older than 7 days; the injected clock keeps that testable. The
    // one-argument call shape is kept when no clock is injected.
    (await (deps.now !== undefined
      ? loadLatestSummary(join(config.memoryPath, "memory"), { now: deps.now })
      : loadLatestSummary(join(config.memoryPath, "memory"))));
  if (loadedSummary) {
    const resumeBudget =
      config.perf?.resumeSummaryBudget ?? DEFAULT_RESUME_SUMMARY_BUDGET;
    const enforced = await enforceSummaryBudget({
      summary: loadedSummary,
      budget: resumeBudget,
      log: deps.log,
      agentName: config.name,
      // regenerate: omitted — live LLM regeneration is future work. The
      // hard-truncate fallback handles oversized summaries today.
    });
    contextSummaryStr = `## Context Summary (from previous session)\n${enforced.summary}`;
  }

  // --- Phase 67 — Resume Auto-Injection (SESS-02 / SESS-03) ---
  //
  // When both per-agent stores are wired, render the conversation brief via
  // the pure helper from Plan 01. The helper handles:
  //   - SESS-03 gap check (short-circuits when last session <4h ago by default)
  //   - SESS-02 last-N tag-scoped retrieval with accumulate-budget enforcement
  //   - Markdown rendering under a stable "## Recent Sessions" heading
  // Result is threaded into `ContextSources.conversationContext` and lands
  // in the MUTABLE SUFFIX — never in the cached stable prefix (Pitfall 1).
  // Graceful degradation: when EITHER store is absent (legacy startup path,
  // tests that don't wire stores), skip the helper entirely — no throw.
  let conversationContextStr = "";
  const convStore = deps.conversationStores?.get(config.name);
  const memStore = deps.memoryStores?.get(config.name);
  if (convStore && memStore) {
    const sessionCount =
      config.memory.conversation?.resumeSessionCount ??
      DEFAULT_RESUME_SESSION_COUNT;
    // Phase 73 Plan 02 — compute fingerprint over the actual brief inputs
    // (terminated-session IDs) so invalidation is driven by content-change,
    // not by a coarse agent-name key (73-RESEARCH Pitfall 7).
    const terminatedIds = convStore
      .listRecentTerminatedSessions(config.name, sessionCount)
      .map((s) => s.id);
    const fingerprint = computeBriefFingerprint(terminatedIds);
    const cached = deps.briefCache?.get(config.name);
    if (cached && cached.fingerprint === fingerprint) {
      // Cache HIT — skip assembleConversationBrief entirely, inline the
      // cached rendered block.
      conversationContextStr = cached.briefBlock;
    } else {
      // Cache MISS (or no cache wired) — compute the brief and, if a cache
      // is present and the result is non-skipped, write it back keyed by
      // the fresh fingerprint.
      const briefResult = assembleConversationBrief(
        { agentName: config.name, now: deps.now ?? Date.now() },
        {
          conversationStore: convStore,
          memoryStore: memStore,
          config: {
            sessionCount,
            gapThresholdHours:
              config.memory.conversation?.resumeGapThresholdHours ??
              DEFAULT_RESUME_GAP_THRESHOLD_HOURS,
            budgetTokens:
              config.memory.conversation?.conversationContextBudget ??
              DEFAULT_CONVERSATION_CONTEXT_BUDGET,
          },
          log: deps.log,
        },
      );
      if (!briefResult.skipped) {
        conversationContextStr = briefResult.brief; // already budget-enforced
        deps.briefCache?.set(config.name, {
          fingerprint,
          briefBlock: briefResult.brief,
        });
      }
    }
    // 2026-08-27 — table rendering contract. The daemon renders every
    // markdown table for Discord (src/discord/table-delivery.ts): 2 columns →
    // a list, narrow grids → monospace, wide numeric grids → a PNG card. The
    // model only needs to emit clean tables — and never fence them (a fenced
    // table is passed through raw).
    discordBindingsStr +=
      " Markdown tables are welcome for comparisons and are rendered for Discord automatically" +
      " (2 columns become a list, narrow grids stay monospace, wide numeric grids become an image card):" +
      " put the row label in the first column, keep headers short, one fact per cell, at most ~12 rows," +
      " and never wrap a table in a code fence.";
  }

  // Phase 96 Plan 02 D-02 — render <filesystem_capability> block at the
  // daemon edge using the live snapshot from the fs-probe heartbeat (96-07)
  // + boot-approximation fleet probe (96-07-DEPLOY-RUNBOOK Section 4).
  // Empty snapshot → STRICT empty string (cache-stability invariant for
  // v2.5 fixtures without fileAccess). The assembler inserts this block
  // BETWEEN Phase 94 <tool_status> and Phase 95 <dream_log_recent> when
  // non-empty (verified by grep pin in 96-02 Task 3 acceptance_criteria).
  const fsSnapshot =
    deps.fsCapabilitySnapshotProvider?.(config.name) ??
    new Map<string, FsCapabilitySnapshot>();
  const filesystemCapabilityBlockStr = renderFilesystemCapabilityBlock(
    fsSnapshot,
    config.workspace,
  );

  // --- Assemble with budgets ---
  const budgets = config.contextBudgets ?? DEFAULT_BUDGETS;

  // Phase 53 Plan 03 — resolve lazySkills config + usage window. When the
  // tracker is absent, the assembler treats usage as empty and the warm-up
  // guard (turns < threshold) keeps all skills rendering full content.
  const skillUsage = deps.skillUsageTracker?.getWindow(config.name);
  const lazySkillsConfig: ResolvedLazySkillsConfig | undefined =
    config.perf?.lazySkills
      ? Object.freeze({
          enabled: config.perf.lazySkills.enabled,
          usageThresholdTurns: config.perf.lazySkills.usageThresholdTurns,
          reinflateOnMention: config.perf.lazySkills.reinflateOnMention,
        })
      : undefined;

  // WP6 (2026-10-25) — system-prompt directives. Phase 94 shipped the
  // resolver + renderer + the assembler field and documented the directives
  // as RELOADABLE, but no runtime caller ever rendered them: no-em-dashes,
  // mutate-verify, parallel-tool-calls and the rest were silently absent
  // from every agent's prompt. Per-key merge of the agent override (read
  // structurally, like `advisor`, because ResolvedAgentConfig does not
  // declare the field yet) over the fleet defaults; "" when every directive
  // is disabled so the stable prefix is byte-identical to the no-directives
  // baseline (REG-ASSEMBLER-EMPTY-WHEN-DISABLED).
  const agentDirectiveOverrides = (
    config as unknown as {
      systemPromptDirectives?: Record<string, { enabled?: boolean; text?: string }>;
    }
  ).systemPromptDirectives;
  const systemPromptDirectivesStr = renderSystemPromptDirectiveBlock(
    resolveSystemPromptDirectives(
      agentDirectiveOverrides,
      deps.systemPromptDirectiveDefaults ?? DEFAULT_SYSTEM_PROMPT_DIRECTIVES,
    ),
  );

  const sources: ContextSources = {
    // WP6: operator directives lead the stable prefix (assembler places
    // them first). Empty string when all are disabled.
    systemPromptDirectives: systemPromptDirectivesStr,
    // Legacy compound identity (kept for back-compat with consumers that
    // read `sources.identity` directly). The four carved fields below
    // take precedence at the assembler when any are non-undefined
    // (Phase 115 Plan 03 sub-scope 1 / T01).
    identity: identityStr,
    // Phase 115 Plan 03 sub-scope 1 — four carved sub-source fields. The
    // assembler composes them into the same compound identity rendering
    // (byte-compatible with `identityStr` above) but treats them as separate
    // budget-able units when over the per-section budget triggers
    // `enforceDropLowestImportance` (T02).
    identitySoulFingerprint,
    identityFile,
    identityCapabilityManifest,
    identityMemoryAutoload,
    // WP6: USER.md as its own sub-source (truncated after MEMORY.md).
    identityUserAutoload,
    // Phase 53 Plan 02: SOUL.md body is currently folded into `identityStr`
    // by the fingerprint+identity concatenation above. We leave `soul: ""`
    // here so section_tokens.soul reports 0 for this agent — accurate given
    // the current consolidation behavior. A future refactor can carve SOUL
    // out of identity and populate `sources.soul` directly.
    soul: "",
    // Phase 53 Plan 02 legacy path — kept for the zero-skills case.
    skillsHeader: skillsHeaderStr.trim(),
    hotMemories: hotMemoriesStr,
    hotMemoriesEntries,
    toolDefinitions: toolDefinitionsStr.trim(),
    graphContext: "",
    discordBindings: discordBindingsStr,
    contextSummary: contextSummaryStr,
    // Phase 53 Plan 02: split summary fields. Resume summary is the loaded
    // session-resume file; per-turn summary is a future field populated by
    // per-turn recap logic (empty today).
    resumeSummary: contextSummaryStr,
    perTurnSummary: "",
    // Recent conversation history is SDK-owned; leave empty so
    // section_tokens.recent_history reports 0 at agent-startup time.
    // Per-turn refresh paths (future) may populate this for accurate
    // per-turn audit.
    recentHistory: "",
    // Phase 53 Plan 03 — lazy-skill sources.
    skills: skillsCatalogEntries.length > 0 ? skillsCatalogEntries : undefined,
    skillUsage,
    lazySkillsConfig,
    // Per-turn mention sources stay empty at session-config time. A
    // future per-turn assembler re-call will populate these; the tests
    // exercise them directly via `assembleContext` sources.
    currentUserMessage: "",
    lastAssistantMessage: "",
    // Phase 67 — conversation brief threaded into the MUTABLE SUFFIX.
    // Empty string when stores are not wired or gap-skip fired.
    conversationContext: conversationContextStr,
    // Phase 96 Plan 02 D-02 — <filesystem_capability> block (rendered above).
    // Empty string when no fs snapshot is available (cache-stability path).
    filesystemCapabilityBlock: filesystemCapabilityBlockStr,
    // Phase 999.13 DELEG-02 — per-agent delegate directive; empty when
    // delegates unset OR `{}` (byte-identical to no-delegates baseline).
    delegatesBlock: renderDelegatesBlock(config.delegates),
  };

  // Phase 52 Plan 02 — two-block assembly for prompt caching.
  //   stablePrefix   → systemPrompt (fed to SDK preset.append, cached)
  //   mutableSuffix  → per-turn prepend to user message (outside cache)
  //   hotStableToken → persisted by SessionManager for next-turn comparison
  //
  // The `priorHotStableToken` dep controls hot-tier placement: matching
  // token → hot-tier stays in stable block; non-matching → hot-tier falls
  // into mutable for this turn only (cache thrashing guard, CONTEXT D-05).
  //
  // Phase 53 Plan 02 — per-section budgets + onBudgetWarning callback.
  // Warnings flow to `deps.log.warn` with section/beforeTokens/budgetTokens/
  // strategy — the full prompt body is NEVER logged (SECURITY).
  const onBudgetWarning = deps.log
    ? (event: BudgetWarningEvent) => {
        deps.log!.warn(
          {
            agent: config.name,
            section: event.section,
            beforeTokens: event.beforeTokens,
            budgetTokens: event.budgetTokens,
            strategy: event.strategy,
          },
          "context-assembly budget exceeded",
        );
      }
    : undefined;

  // Phase 999.7 — when a TraceCollector is wired, capture per-section token
  // counts via a synthetic bootstrap Turn. The Turn is opened, the assembler
  // emits metadata onto its `context_assemble` span, and the Turn is ended
  // immediately so the row commits to traces.db. Status is "ok" on success,
  // "error" if assembly throws. Best-effort — failures here are observability,
  // never block agent startup.
  const traceCollector = deps.traceCollector;
  let bootstrapTurn:
    | ReturnType<TraceCollector["startTurn"]>
    | undefined;
  if (traceCollector) {
    try {
      const bootstrapId = `bootstrap:${config.name}:${Date.now()}`;
      bootstrapTurn = traceCollector.startTurn(bootstrapId, config.name, null);
    } catch {
      bootstrapTurn = undefined; /* never let tracing block startup */
    }
  }
  // Phase 115 Plan 03 sub-scope 1 / T02 — D-02 outer-cap fallback log sink.
  // Adapter that forwards `error` calls to the structured pino logger.
  // Optional — if `deps.log` lacks `error`, the cap fallback still runs but
  // emits no log line.
  const capFallbackLog = deps.log
    ? {
        error: (obj: Record<string, unknown>, msg?: string) => {
          // SessionConfigLoggerLike narrows to {warn}; callers pass full pino
          // loggers in production where `.error` does exist. Cast through
          // unknown for the optional method probe.
          const fullLog = deps.log as unknown as {
            error?: (o: Record<string, unknown>, m?: string) => void;
          };
          if (typeof fullLog.error === "function") {
            fullLog.error(obj, msg);
          } else {
            // Fallback: use warn at higher verbosity if error isn't available.
            deps.log?.warn(obj, msg);
          }
        },
      }
    : undefined;

  let assembled;
  try {
    assembled = bootstrapTurn
      ? assembleContextTraced(
          sources,
          budgets,
          {
            priorHotStableToken: deps.priorHotStableToken,
            memoryAssemblyBudgets: config.perf?.memoryAssemblyBudgets,
            onBudgetWarning,
            agentName: config.name,
            log: capFallbackLog,
            // Phase 115 Plan 04 sub-scope 5 — thread the resolved
            // cacheBreakpointPlacement through to the assembler so the
            // operator-controlled config flag is actually consumed. Default
            // is "static-first" (zod default in defaultsSchema); operators
            // can flip per-agent or fleet-wide via clawcode.yaml. The flag
            // is captured into systemPrompt.append at session create/resume
            // (NON_RELOADABLE_FIELDS) — agent restart required to take effect.
            cacheBreakpointPlacement: config.cacheBreakpointPlacement,
          },
          bootstrapTurn,
        )
      : assembleContext(sources, budgets, {
          priorHotStableToken: deps.priorHotStableToken,
          memoryAssemblyBudgets: config.perf?.memoryAssemblyBudgets,
          onBudgetWarning,
          agentName: config.name,
          log: capFallbackLog,
          // Phase 115 Plan 04 sub-scope 5 — see assembleContextTraced branch
          // above for rationale. Symmetric edit (same pattern as
          // excludeDynamicSections wiring further down at line ~1052).
          cacheBreakpointPlacement: config.cacheBreakpointPlacement,
        });
    bootstrapTurn?.end("success");
  } catch (err) {
    bootstrapTurn?.end("error");
    throw err;
  }
  const trimmedMutable = assembled.mutableSuffix.trim();

  // Phase 100 follow-up — apply per-agent MCP env overrides (op:// resolution)
  // BEFORE assembling AgentSessionConfig.mcpServers. Resolved values OVERWRITE
  // the env entries from the shared mcpServers[].env block (loaded with the
  // daemon's clawdbot full-fleet token). For acme agents this swaps
  // OP_SERVICE_ACCOUNT_TOKEN from the clawdbot-scoped token to the
  // Acme-vault-scoped token before the SDK spawns the MCP subprocess.
  //
  // Skipped when:
  //   - config.mcpEnvOverrides is undefined (existing 15-agent fleet)
  //   - deps.opEnvResolver is undefined (test paths, bootstrap)
  //   - config.mcpServers is empty (no servers to override)
  //
  // Throws propagate — see SessionConfigDeps.opEnvResolver doc for rationale.
  const overrideMap = config.mcpEnvOverrides;
  let resolvedOverrides:
    | Record<string, Record<string, string>>
    | undefined;
  if (overrideMap && deps.opEnvResolver && (config.mcpServers ?? []).length > 0) {
    // Convert the readonly-Record shape on the resolved config back to a
    // mutable plain Record for the resolver call (resolver returns a fresh
    // mutable copy — we never write back to the input).
    const mutableInput: Record<string, Record<string, string>> = {};
    for (const [serverName, envMap] of Object.entries(overrideMap)) {
      mutableInput[serverName] = { ...envMap };
    }
    resolvedOverrides = await deps.opEnvResolver(mutableInput, config.name);
  }

  // Build the effective mcpServers list with per-agent env overrides merged
  // in last-wins. Each server's env starts from the shared block (which has
  // the daemon's clawdbot-resolved values via config/loader.ts), then any
  // per-agent override key replaces it. Servers WITHOUT a matching override
  // entry pass through unchanged.
  const baseMcpServers = config.mcpServers ?? [];
  const effectiveMcpServers = resolvedOverrides
    ? baseMcpServers.map((s) => {
        const override = resolvedOverrides![s.name];
        if (!override) return s;
        return { ...s, env: { ...s.env, ...override } };
      })
    : baseMcpServers;

  return {
    name: config.name,
    model: config.model,
    effort: config.effort,
    workspace: config.workspace,
    systemPrompt: assembled.stablePrefix.trim(),
    mutableSuffix: trimmedMutable.length > 0 ? trimmedMutable : undefined,
    hotStableToken: assembled.hotStableToken,
    channels,
    contextSummary,
    mcpServers: effectiveMcpServers,
    // Per-agent OS sandbox (bwrap) bind-plan — frozen at session-config time,
    // NON_RELOADABLE. Spread-conditional: omitted (→ byte-identical config +
    // pass-through spawn) for every non-sandboxed/admin agent.
    ...(sandboxPlan ? { sandboxPlan } : {}),
    // Phase 100 GSD-02 / GSD-04 — propagate settingSources + gsd from
    // ResolvedAgentConfig (Plan 01) into AgentSessionConfig so the SDK
    // adapter (Plan 02) receives the per-agent values. The spread-conditional
    // pattern (matching the existing mutableSuffix pattern above) keeps the
    // AgentSessionConfig field OMITTED rather than explicitly `undefined`
    // when the resolved config doesn't carry them — preserves byte-stable
    // deep-equality in regression tests (SA10 cascade).
    ...(config.settingSources ? { settingSources: config.settingSources } : {}),
    // 999.103 WS-2 follow-up — plugin refs to the adapter (same
    // spread-conditional byte-stability pattern).
    ...(config.plugins && config.plugins.length > 0 ? { plugins: config.plugins } : {}),
    ...(config.gsd ? { gsd: config.gsd } : {}),
    // Phase 99 sub-scope N (2026-04-26) — propagate disallowedTools through
    // ResolvedAgentConfig → AgentSessionConfig so the SDK adapter receives
    // the per-agent SDK deny-list. SubagentThreadSpawner injects this on
    // subagent configs to physically block `mcp__clawcode__spawn_subagent_thread`.
    // Spread-conditional pattern (matching settingSources/gsd above) keeps
    // the field OMITTED rather than explicitly undefined when not set so the
    // existing 15+ agent fleet stays byte-identical (SA10-style cascade).
    ...(config.disallowedTools && config.disallowedTools.length > 0
      ? { disallowedTools: config.disallowedTools }
      : {}),
    // Phase 999.162 — per-agent tool search rides the same spread-conditional discipline.
    ...(config.toolSearch !== undefined ? { toolSearch: config.toolSearch } : {}),
    // claude.ai connector entitlement (derived by the loader).
    ...(config.claudeAiConnectors === true ? { claudeAiConnectors: true as const } : {}),
    // Phase 999.171 — per-agent UX toggles for the session-start consumers
    // (999.172 / 999.173). Spread-conditional: omitted unless some flag is on,
    // so the rest of the fleet's AgentSessionConfig stays byte-identical.
    ...(hasAnyUxFeature(sessionUx) ? { uxFeatures: sessionUx } : {}),
    // Quick 260715-j1j (D5/D11) — propagate nativeWorkflow from
    // ResolvedAgentConfig so the workflow-steer conditionals (v2 steer in
    // this file + the v3 channel-protocol prompt) read it off the session
    // config. Spread-conditional (matches disallowedTools above) — the
    // non-opted fleet's AgentSessionConfig stays byte-identical.
    ...(config.nativeWorkflow === true ? { nativeWorkflow: true as const } : {}),
    // Phase 999.173 — research subagents (omitted unless on for this session).
    ...researchSessionField(config),
    // Phase 115 sub-scope 14 — propagate `debug` block from ResolvedAgentConfig
    // → AgentSessionConfig so the SDK adapter (session-adapter.ts) reads the
    // operator-toggle for the diagnostic baseopts dump. Spread-conditional so
    // the field is OMITTED for fleet agents that don't set `debug:` in yaml
    // (preserves byte-stable equality in regression tests; matches the
    // settingSources / gsd / disallowedTools pattern above). T03 of this plan
    // makes this the SOLE gate after removing the hardcoded allowlist.
    ...(config.debug ? { debug: config.debug } : {}),
    // Phase 115 sub-scope 2 — propagate `excludeDynamicSections` from
    // ResolvedAgentConfig (always populated by loader, default true) into
    // AgentSessionConfig so session-adapter's buildSystemPromptOption can
    // forward it to the SDK. Pass through verbatim — the SDK ignores this
    // flag when systemPrompt is a string (custom prompt), but our preset
    // shape ({type:"preset",preset:"claude_code",append:...}) honors it.
    excludeDynamicSections: config.excludeDynamicSections,
    // Phase 127 — propagate stream-stall supervisor threshold from
    // ResolvedAgentConfig (loader cascade: agent → modelOverrides →
    // defaults → 180_000 baseline) into AgentSessionConfig so the SDK
    // adapter threads it into per-handle baseOptions. Spread-conditional
    // OMIT when undefined preserves byte-stable equality with legacy
    // builders. Consumers default to 180_000ms.
    ...(typeof config.streamStallTimeoutMs === "number"
      ? { streamStallTimeoutMs: config.streamStallTimeoutMs }
      : {}),
    // Phase 145 WS2 — propagate the absolute turn-duration ceiling from
    // ResolvedAgentConfig (loader cascade: agent → modelOverrides → defaults
    // → 20-min default) into AgentSessionConfig so the SDK adapter threads it
    // into per-handle baseOptions (handle-only). Spread-conditional OMIT when
    // undefined preserves byte-stable equality with legacy builders. Plan 03
    // reads it at the createStreamStallTracker call site.
    ...(typeof config.maxTurnDurationMs === "number"
      ? { maxTurnDurationMs: config.maxTurnDurationMs }
      : {}),
    // Phase 145 WS1 — propagate the subagent permission-hook gate from
    // ResolvedAgentConfig (loader cascade, default false) into
    // AgentSessionConfig so Plan 02 can read it at the hook-registration site.
    // Spread-conditional `=== true` OMIT mirrors the disallowedTools precedent
    // above: the field is OMITTED (never `{subagentPermissionGate:false}`) for
    // the existing fleet, preserving byte-stable equality in regression tests.
    ...(config.subagentPermissionGate === true
      ? { subagentPermissionGate: true as const }
      : {}),
    // Cross-owner FS guard (2026-06-27) — propagate the loader-derived forbidden
    // cross-owner dir prefixes so session-adapter can register the PreToolUse
    // owner-FS-guard hook. Spread-conditional OMIT when empty (untenanted/admin
    // agents) so their options bag is byte-identical (no hook).
    ...(config.crossOwnerForbiddenPaths && config.crossOwnerForbiddenPaths.length > 0
      ? { crossOwnerForbiddenPaths: config.crossOwnerForbiddenPaths }
      : {}),
    // Phase 127 Plan 02 — onStreamStall callback (Discord webhook +
    // sessionLog.recordStall). Spread-conditional OMIT when the factory
    // is absent (tests, bootstrap paths) — the Plan 01 tracker still
    // emits the structured log + aborts, so the protective surface
    // works without the daemon-side wiring. Production SessionManager
    // wires the factory in `configDeps()`.
    ...(deps.streamStallCallbackFactory !== undefined
      ? {
          onStreamStall: deps.streamStallCallbackFactory({
            agentName: config.name,
            model: config.model,
            effort: config.effort,
          }),
        }
      : {}),
    // WS-1 (999.99 structural delivery) — attributed-stream pair.
    // Spread-conditional OMIT for the non-canary fleet (byte-stable). The
    // delivery callback rides ONLY when the gate is on AND the factory is
    // wired (production SessionManager supplies it; tests/bootstrap omit).
    ...(config.deliveryAttributedStream === true
      ? { attributedStream: true as const }
      : {}),
    ...(config.deliveryAttributedStream === true &&
    deps.orphanDeliveryCallbackFactory !== undefined
      ? {
          onOrphanTurnOutput: deps.orphanDeliveryCallbackFactory({
            agentName: config.name,
          }),
        }
      : {}),
    // Phase 117 Plan 04 T05 — advisor model passthrough.
    //
    // Spread-conditional pattern (RESEARCH §6 Pitfall 3): the field is
    // OMITTED — never `{advisorModel: undefined}` — when the gate says
    // the advisor should be off. The session-adapter then propagates
    // the same omission into the SDK Options so the bundled CLI binary
    // does not enable the `advisor_20260301` server tool for this
    // session.
    //
    // Gate (`shouldEnableAdvisor`):
    //   1. `resolveAdvisorBackend(agent, defaults) === "native"`
    //      — the operator hasn't flipped to the fork rollback path.
    //   2. `advisorBudget.canCall(agent) !== false`
    //      — the per-day cap is not exhausted (RESEARCH §13.5
    //      mitigation B: omit advisorModel on exhaustion). When the
    //      budget is undefined (tests, bootstrap), this leg is
    //      treated as PASS so default-configured agents in test
    //      paths still get the field — production wires the budget
    //      via `SessionManager.setAdvisorBudget` so this is safe.
    //
    // The resolved value is run through the SDK alias resolver
    // (`resolveAdvisorModelAlias`) so the config-level `"opus"`
    // becomes the canonical `"claude-opus-4-8"` before reaching the
    // SDK (RESEARCH §13.7 — Anthropic's docs name this exact alias).
    ...(shouldEnableAdvisor(config, deps)
      ? {
          advisorModel: resolveAdvisorModelAlias(
            resolveAdvisorModelConfig(
              config as unknown as { advisor?: { model?: string } },
              deps.advisorDefaults,
            ),
          ),
        }
      : {}),
  };
}

/**
 * Phase 117 Plan 04 T05 — should we hand `advisorModel` to the SDK?
 *
 * Two gates evaluated, both must pass:
 *
 *   (a) **Backend = native.** When `resolveAdvisorBackend(agent, defaults)`
 *       returns `"fork"`, the agent's `ask_advisor` invocations route
 *       through `LegacyForkAdvisor` (Plan 117-03) instead — the native
 *       SDK server tool MUST NOT also be enabled or the model would
 *       have two parallel advisor surfaces. Defaults to `"native"`
 *       when neither side specifies (loader baseline).
 *
 *   (b) **Budget not exhausted.** If `AdvisorBudget.canCall(agent)`
 *       returns `false`, the daily cap is hit; omit `advisorModel` on
 *       the next session reload so the SDK does not re-fire the
 *       server tool. Per RESEARCH §13.5: this is mitigation B (omit
 *       advisorModel) — the cheap mitigation. The risk that prior
 *       `advisor_tool_result` blocks remaining in history could
 *       produce a `400 invalid_request_error` is the documented
 *       soft-cap acceptance (RESEARCH §13.5 paragraph ending
 *       "accept the daily-cap-soft-limit risk").
 *
 * When `advisorBudget` is undefined (tests, bootstrap paths before
 * daemon DI fires), this leg defaults to PASS — agents with budget
 * not yet wired get the advisor by default, matching the production
 * fleet default of `defaults.advisor.backend: native`.
 */
function shouldEnableAdvisor(
  config: ResolvedAgentConfig,
  deps: SessionConfigDeps,
): boolean {
  // Loader resolvers accept structural types — `config as unknown as ...`
  // is the minimum-coupling cast since `ResolvedAgentConfig` does not
  // currently expose the `advisor?` field on its type (Plan 117-06 only
  // adds it to the raw schema, not the resolved-type alias). The runtime
  // value is read off `config.advisor` if operator set it; otherwise the
  // resolver falls back through `deps.advisorDefaults?.advisor`.
  const backend = resolveAdvisorBackendConfig(
    config as unknown as { advisor?: { backend?: string } },
    deps.advisorDefaults,
  );
  if (backend !== "native") return false;
  if (deps.advisorBudget && !deps.advisorBudget.canCall(config.name)) {
    return false;
  }
  // Phase 999.98 D3 — Fable advisor-OMIT. A Fable *executor* 400s with the
  // default native advisor (`opus` → `claude-opus-4-8`):
  //   `400 tools.10.model: 'claude-opus-4-8' cannot be used as an advisor when
  //    the request model is 'claude-fable-5'`.
  // `config.model` is the ALIAS form ("fable") OR — since Phase 999.98 D11 —
  // the `<family>@latest` sugar. Resolve it to the executor id FIRST, then ask
  // the pure predicate. Use `resolveExecutorModelForGates` (NOT plain
  // `resolveModelId`): a raw `"fable@latest"` is not an alias, so `resolveModelId`
  // would pass it through unchanged and `advisorAllowedForExecutor("fable@latest")`
  // would wrongly return true → the SDK keeps the native advisor ON → the same
  // Fable per-turn 400 this gate exists to prevent. `resolveExecutorModelForGates`
  // collapses `@latest` to the family's pinned concrete id (family is all the
  // gate needs). When the advisor is not allowed for the resolved executor, omit
  // it (the spread at :1224 drops `advisorModel` → the SDK never enables
  // `advisor_20260301` → no per-turn 400). Do NOT route Fable to the fork backend
  // (drags in Category-C cast widening); do NOT ship `advisor=claude-fable-5`
  // (probe-gated, DEFERRED).
  const executor = resolveExecutorModelForGates(config.model);
  if (!advisorAllowedForExecutor(executor)) {
    return false;
  }
  // 2026-08-28 — pairing guard. The env flag the adapter sets for native
  // agents bypasses the CLI's own client-side check, and a weaker advisor
  // than the executor 400s EVERY request of the session (fin-client on
  // `fable` with the fleet-default `opus` advisor would be a dead agent). An
  // invalid pair never reaches the SDK: the session comes up without the
  // advisor and the operator is told exactly which field to fix.
  const advisor = resolveAdvisorModelAlias(
    resolveAdvisorModelConfig(
      config as unknown as { advisor?: { model?: string } },
      deps.advisorDefaults,
    ),
  );
  const pairing = advisorPairingValid(executor, advisor);
  if (!pairing.ok) {
    deps.log?.warn(
      { agent: config.name, executor, advisor, reason: pairing.reason },
      "native advisor NOT enabled: invalid executor/advisor pairing — set " +
        "`agents[].advisor.model` to a model at least as capable as the executor " +
        "(e.g. `fable` for a fable agent)",
    );
    return false;
  }
  return true;
}
