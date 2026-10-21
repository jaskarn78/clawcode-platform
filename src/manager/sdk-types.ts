/**
 * Local type definitions for the Claude Agent SDK query() API.
 *
 * These mirror the subset of types used by session-adapter.ts.
 * The SDK is pre-1.0 and these types may change between minor versions.
 *
 * MIGRATION NOTES (when SDK stabilizes):
 * 1. Replace SdkModule with direct named imports from '@anthropic-ai/claude-agent-sdk'
 * 2. Replace SdkQuery with SDK's exported Query type
 * 3. Replace SdkStreamMessage with SDK's exported SDKMessage type
 * 4. Replace SdkQueryOptions with SDK's exported Options type
 * 5. Remove this file entirely once SDK types are stable
 * 6. Update loadSdk() in session-adapter.ts to use named imports instead of dynamic import
 *
 * API migration: unstable_v2_createSession/unstable_v2_resumeSession -> query()
 * The query() API supports mcpServers, settingSources, resume, streamInput() for
 * multi-turn, and mcpServerStatus() — capabilities the unstable_v2 API lacked.
 *
 * SDK version at time of writing: 0.2.97. Re-verified against 0.3.282 (999.169):
 * every name used here exists; 0.3.x only adds.
 * SDK repo: https://github.com/anthropics/claude-agent-sdk-typescript
 */

// Phase 145 WS1 — type-ONLY SDK imports for the in-process PreToolUse hook
// registration (`SdkQueryOptions.hooks` below). `import type` is fully erased at
// compile, so it does NOT pull the SDK runtime into this projection module and
// does NOT trip the dynamic-`loadSdk()` discipline (no value is referenced). We
// import the SDK's own `HookEvent`/`HookCallbackMatcher` rather than re-projecting
// loosely so the callback-shape check this plan depends on stays intact.
import type {
  HookEvent,
  HookCallbackMatcher,
} from "@anthropic-ai/claude-agent-sdk";

/**
 * A user message sent via streamInput() for multi-turn conversations.
 */
export type SdkUserMessage = {
  readonly type: "user";
  readonly content: string;
};

/**
 * Phase 87 CMD-01 — local projection of the SDK's `SlashCommand` type
 * (sdk.d.ts:4239-4252). Returned by Query.initializationResult().commands
 * and Query.supportedCommands(). Used by native-cc-commands.ts to build
 * Discord SlashCommandDef[] entries for each agent.
 *
 * `name` is the bare command (without leading slash); `description` is the
 * human-readable summary; `argumentHint` is a template (e.g. "<file>") for
 * any arguments the command accepts.
 */
export type SlashCommand = {
  readonly name: string;
  readonly description: string;
  readonly argumentHint: string;
};

/**
 * Phase 999.98 D7 — local projection of the SDK's `ModelInfo` type
 * (sdk.d.ts:1081). Returned by Query.initializationResult().models. The
 * model monitor (model-catalog-store.ts / model-monitor.ts) reads only
 * `value` (the API model id, e.g. `claude-opus-4-8`) + `displayName`, so
 * we project narrowly here (mirroring the `SlashCommand` precedent) rather
 * than pulling the SDK package's deep type into the catalog modules.
 *
 * The init result carries the OAuth/Max-entitled model set (the fleet sets
 * no `availableModels` allowlist), so an absent model = not entitled →
 * never surfaced / auto-selected.
 */
export type ModelInfo = {
  readonly value: string;
  readonly displayName: string;
};

/**
 * Phase 87 CMD-02 — SDK PermissionMode union.
 * Mirrors @anthropic-ai/claude-agent-sdk@0.2.97 sdk.d.ts:1512.
 * Exported for consumption by SessionHandle, SessionManager, daemon IPC,
 * and Discord slash-command dispatch — single source of truth.
 */
export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk"
  | "auto";

/**
 * Options passed to sdk.query().
 * Subset of SDK's Options -- only fields we actually use.
 */
/**
 * Phase 52 Plan 02: `systemPrompt` widened to accept the SDK's preset+append
 * form. Matches node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:
 *
 *   systemPrompt?: string | {
 *     type: 'preset';
 *     preset: 'claude_code';
 *     append?: string;
 *     excludeDynamicSections?: boolean;
 *   };
 *
 * SdkSessionAdapter emits the preset-object form so the SDK's claude_code
 * preset scaffolds cache markers automatically; `append` concatenates our
 * stable prefix (identity + soul + skills header + stable hot-tier).
 */
/**
 * Mirror of the SDK's `AgentDefinition` (0.3.282 sdk.d.ts) — the subset ClawCode
 * sets. `tools`/`disallowedTools` use exact tool names, e.g.
 * `mcp__search__web_search`.
 */
export type SdkAgentDefinition = {
  readonly description: string;
  readonly prompt: string;
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly model?: string;
  readonly skills?: readonly string[];
  readonly maxTurns?: number;
  readonly background?: boolean;
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max" | number;
  readonly permissionMode?: PermissionMode;
};

export type SdkQueryOptions = {
  readonly cwd?: string;
  readonly model?: string;
  readonly effort?: "low" | "medium" | "high" | "max";
  readonly systemPrompt?:
    | string
    | {
        readonly type: "preset";
        readonly preset: "claude_code";
        readonly append?: string;
        readonly excludeDynamicSections?: boolean;
      };
  readonly permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  readonly mcpServers?: Record<
    string,
    | {
        readonly command: string;
        readonly args?: readonly string[];
        readonly env?: Readonly<Record<string, string>>;
      }
    // 999.175 — in-process server (sdk.d.ts McpSdkServerConfigWithInstance):
    // the OpenAI endpoint's client-declared tools.
    | { readonly type: "sdk"; readonly name: string; readonly instance: unknown }
  >;
  /**
   * Built-in tool set (sdk.d.ts Options.tools). `[]` disables every built-in
   * tool — the OpenAI endpoint does this when the client brings its own tools.
   */
  readonly tools?: readonly string[];
  readonly settingSources?: readonly string[];
  readonly resume?: string;
  readonly sessionId?: string;
  readonly allowDangerouslySkipPermissions?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * The Claude Code binary to spawn (`Options.pathToClaudeCodeExecutable`).
   * Callers do NOT set it (999.169): the SDK chokepoint injects the fleet
   * binary into every query (`withPinnedClaudeBinary`), and
   * `claude-binary-pin-static.test.ts` fails if any other file sets it.
   */
  readonly pathToClaudeCodeExecutable?: string;
  /** 999.173 — ~30 s AI summaries of running subagents on `task_progress.summary`. */
  readonly agentProgressSummaries?: boolean;
  /**
   * 999.173 (SDK >= 0.3.x) — declare that this consumer can stop background
   * tasks individually, so an interrupt no longer kills them all. Only safe
   * together with a per-task stop surface (`Query.stopTask`).
   */
  readonly perTaskStopAffordance?: boolean;
  /** 999.173 — programmatic subagent definitions (`Options.agents`). */
  readonly agents?: Readonly<Record<string, SdkAgentDefinition>>;
  /** Phase 59 -- native SDK abort support (sdk.d.ts:957 Options.abortController). */
  readonly abortController?: AbortController;
  /**
   * Phase 99 sub-scope N (2026-04-26) — SDK deny-list option. Mirrors
   * @anthropic-ai/claude-agent-sdk@0.2.97 sdk.d.ts:50,1023,2709
   * (`Options.disallowedTools?: string[]`). When set, the LLM physically
   * cannot invoke any tool whose name matches an entry. session-adapter.ts
   * forwards this from AgentSessionConfig.disallowedTools when present;
   * absent for the existing fleet so no behavior change ships.
   */
  readonly disallowedTools?: readonly string[];
  /**
   * Phase 145 WS1 (2026-06-18) — in-process SDK PreToolUse hook registration.
   * Mirrors @anthropic-ai/claude-agent-sdk@0.2.140 sdk.d.ts:1318
   * (`Options.hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>`).
   *
   * session-adapter forwards this SPREAD-CONDITIONALLY from
   * AgentSessionConfig.subagentPermissionGate (the `subagentPermissionHook`
   * makes in-process subagents non-interactive so the headless parallel()
   * barrier cannot deadlock on a permission prompt). Absent for the existing
   * fleet — the field is OMITTED when the gate is off so the Options bag is
   * byte-identical (the spread-conditional OMIT idiom, NOT `hooks: undefined`).
   *
   * UNLIKE streamStallTimeoutMs/maxTurnDurationMs/onStreamStall, this IS a real
   * SDK option — it is deliberately NOT stripped by `stripHandleOnlyFields`; it
   * reaches sdk.query so the bundled binary fires the callback.
   *
   * Typed against the SDK's own hook types (imported type-only — erased at
   * compile, does not trip the dynamic-loadSdk discipline) rather than projected
   * loosely, so the callback-shape check that this plan depends on is preserved.
   */
  readonly hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  /**
   * Phase 117 Plan 04 T05 — native advisor model id.
   *
   * Mirrors @anthropic-ai/claude-agent-sdk@0.2.132 `sdk.d.ts:4930`
   * (`Options.advisorModel?: string`). When set, the bundled `claude`
   * CLI binary enables the `advisor_20260301` server tool inside the
   * agent's own turn (the executor decides timing) and auto-injects
   * the `advisor-tool-2026-03-01` beta header server-side — ClawCode
   * does NOT manually negotiate the beta. RESEARCH §6 Pitfall 2
   * confirmed this via `strings` on the bundled CLI binary.
   *
   * Spread-conditionally forwarded by session-adapter from
   * AgentSessionConfig.advisorModel. The gate that produces / omits
   * that field lives in `session-config.ts:shouldEnableAdvisor`
   * (backend === "native" AND budget.canCall).
   */
  readonly advisorModel?: string;
  /**
   * Phase 117.1 — SDK escape hatch for CLI args not yet wired through typed
   * Options. `extraArgs: { advisor: "claude-opus-4-8" }` appends
   * `--advisor claude-opus-4-8` to the bundled binary spawn. Mirrors the
   * SDK's public `extraArgs?: Record<string, string | null>` field
   * (sdk.d.ts:1268). Used to bridge the SDK 0.2.140 gap where
   * `advisorModel?: string` is declared in the typed Options but not
   * translated to a CLI flag during spawn (verified via grep on sdk.mjs
   * arg-builder: lists --model/--effort/--agent/--betas but no --advisor).
   *
   * The binary ALSO requires `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL=1`
   * in env to honor the flag — set in `/etc/clawcode/env` (systemd
   * EnvironmentFile) at the daemon level so all spawned binaries inherit it.
   *
   * Remove this field once upstream SDK wires `advisorModel` end-to-end.
   */
  readonly extraArgs?: Record<string, string | null>;
  /**
   * FIND-123-A.next — structural spawn override for the SDK's
   * `spawnClaudeCodeProcess` hook (sdk.d.ts:1806). When supplied, the SDK
   * calls this function instead of its non-detached `spawn()` default, so
   * ClawCode owns the `detached: true` flag and the per-(re-)spawn PID
   * capture. Only `createPersistentSessionHandle` populates this — the
   * ephemeral query sites (advisor, haiku-direct, summarize, json-rpc-call,
   * initial drain query, benchmarks) deliberately don't launch
   * MCP-bearing trees, so the wrapper is not threaded through them.
   *
   * Typed loosely as `unknown` to avoid pulling the SDK's `SpawnOptions` /
   * `SpawnedProcess` types into this seam-only module — the production
   * call site in `persistent-session-handle.ts` casts when forwarding to
   * the real SDK Options.
   */
  readonly spawnClaudeCodeProcess?: (options: unknown) => unknown;
  /**
   * Phase 999.172 — ask the CLI to predict the user's next prompt after each
   * turn (SDK 0.2.140 `Options.promptSuggestions`, sent once in the
   * initialize request). The CLI emits at most one
   * `{type:"prompt_suggestion", suggestion}` per turn, after `result`; turn 1,
   * API errors and plan mode are suppressed. Needs the spawn env
   * `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=true` too (probe: the option alone
   * emits nothing).
   */
  readonly promptSuggestions?: boolean;
};

/**
 * An assistant-type message from the SDK stream.
 * The SDK's actual SDKAssistantMessage has a nested `message: BetaMessage` structure,
 * but at the stream level the adapter checks for a `content` property.
 * We type this loosely to match runtime usage.
 */
export type SdkAssistantMessage = {
  readonly type: "assistant";
  readonly content?: string;
  readonly message?: unknown;
  readonly uuid?: string;
  readonly session_id?: string;
};

/**
 * A successful result message from the SDK stream.
 *
 * Phase 52 Plan 01: `usage` is extended with `cache_creation_input_tokens`
 * and `cache_read_input_tokens` — BetaUsage (snake_case) as reported by the
 * SDK. session-adapter reads these to populate the per-turn cache telemetry
 * snapshot via `Turn.recordCacheUsage`.
 */
export type SdkResultSuccess = {
  readonly type: "result";
  readonly subtype: "success";
  readonly result?: string;
  readonly is_error?: boolean;
  readonly total_cost_usd?: number;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly cache_creation_input_tokens?: number;
    readonly cache_read_input_tokens?: number;
  };
  readonly num_turns?: number;
  readonly duration_ms?: number;
  readonly model?: string;
  readonly uuid?: string;
  readonly session_id?: string;
};

/**
 * An error result message from the SDK stream.
 *
 * Phase 52 Plan 01: `usage` extended with cache fields (same shape as
 * SdkResultSuccess). Error results can still carry partial token counts.
 */
export type SdkResultError = {
  readonly type: "result";
  readonly subtype: "error_during_execution" | "error_max_turns" | "error_max_budget_usd" | "error_max_structured_output_retries" | string;
  readonly is_error: boolean;
  readonly result?: string;
  readonly total_cost_usd?: number;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly cache_creation_input_tokens?: number;
    readonly cache_read_input_tokens?: number;
  };
  readonly num_turns?: number;
  readonly duration_ms?: number;
  readonly model?: string;
  readonly uuid?: string;
  readonly session_id?: string;
};

/**
 * Union of result message types from the SDK stream.
 */
export type SdkResultMessage = SdkResultSuccess | SdkResultError;

/**
 * Union of message types we handle from query() iteration.
 *
 * The SDK's full SDKMessage union has ~25 variants. We only discriminate on
 * "assistant" and "result" types in session-adapter -- all other message types
 * are ignored during stream consumption. This narrowed union keeps our adapter
 * focused on what it actually processes.
 */
export type SdkStreamMessage = SdkAssistantMessage | SdkResultMessage;

/**
 * The Query object returned by sdk.query().
 * An async generator that yields SDK messages, with methods for multi-turn
 * interaction and MCP server management.
 */
export type SdkQuery = AsyncGenerator<SdkStreamMessage, void> & {
  interrupt(): Promise<void>;
  close(): void;
  streamInput(stream: AsyncIterable<SdkUserMessage>): Promise<void>;
  mcpServerStatus(): Promise<unknown[]>;
  setMcpServers(servers: Record<string, unknown>): Promise<unknown>;
  /**
   * 2026-09-24 remote-mcp-reconnect — SDK Query.reconnectMcpServer
   * (sdk.d.ts:2185): respawns one MCP server in place; throws on failure.
   * OPTIONAL because non-SDK backends (codex, claude-code-interactive)
   * build their own query objects without it — callers feature-detect.
   */
  reconnectMcpServer?(serverName: string): Promise<void>;
  /**
   * Phase 83 EFFORT-01 — SDK mid-session thinking-token control.
   * Mirrors @anthropic-ai/claude-agent-sdk@0.2.97 Query.setMaxThinkingTokens
   * (sdk.d.ts:1728). Pass `null` to reset to model default, `0` to disable
   * thinking outright, or a positive integer for an explicit budget.
   * Consumed by persistent-session-handle.ts:setEffort.
   */
  setMaxThinkingTokens(maxThinkingTokens: number | null): Promise<void>;
  /**
   * Quick 260715-j1j (D3) — SDK mid-session flag-settings merge.
   * Mirrors @anthropic-ai/claude-agent-sdk Query.applyFlagSettings
   * (sdk.d.ts:2083) — an `apply_flag_settings` control request whose CLI
   * handler reads the RAW settings object (`"ultracode" in settings`), no
   * zod strip. Used by persistent-session-handle.ts:setEffort to enter/exit
   * the ultracode orchestration mode ({ultracode: true|false}, claude
   * ≥2.1.210). On an older CLI (prod pin 2.1.158) the control request is
   * unknown and silently ignored — the agent degrades to plain xhigh
   * (the setMaxThinkingTokens budget still applies).
   */
  applyFlagSettings(settings: Record<string, unknown>): Promise<void>;
  /**
   * Phase 86 MODEL-03 — SDK mid-session model swap.
   * Mirrors @anthropic-ai/claude-agent-sdk@0.2.97 Query.setModel
   * (sdk.d.ts:1711). Passing undefined resets to the session default;
   * a string must be a valid Claude model id. Consumed by
   * persistent-session-handle.ts:setModel.
   */
  setModel(model?: string): Promise<void>;
  /**
   * Phase 87 CMD-02 — SDK mid-session permission-mode swap.
   * Mirrors @anthropic-ai/claude-agent-sdk@0.2.97 Query.setPermissionMode
   * (sdk.d.ts:1704). Control-plane control request, safe by the same design
   * as setModel/setMaxThinkingTokens (CMD-00 spike confirmation). Consumed
   * by persistent-session-handle.ts:setPermissionMode.
   */
  setPermissionMode(mode: PermissionMode): Promise<void>;
  /**
   * Phase 87 CMD-01 — enumerate SDK-reported slash commands at init time.
   * Mirrors @anthropic-ai/claude-agent-sdk@0.2.97 Query.initializationResult
   * (sdk.d.ts:1748). Returns the full SDKControlInitializeResponse which
   * includes commands + agents + models + skills — preferred over
   * supportedCommands() because one round-trip covers Plan 02/03 needs.
   * Consumed by persistent-session-handle.ts:getSupportedCommands (cached).
   */
  initializationResult(): Promise<{
    readonly commands: readonly SlashCommand[];
    readonly agents?: readonly unknown[];
    // Phase 999.98 D7 — narrowed from `readonly unknown[]` to the local
    // ModelInfo projection so `getSupportedModels()` can return the entitled
    // catalog without an unsafe cast. The SDK's full ModelInfo carries more
    // fields (sdk.d.ts:1081); the monitor only needs value + displayName.
    readonly models?: readonly ModelInfo[];
  }>;
  /**
   * Phase 87 CMD-01 — narrower enumeration post-init (no agents/models).
   * Mirrors @anthropic-ai/claude-agent-sdk@0.2.97 Query.supportedCommands
   * (sdk.d.ts:1754). Available for callers that only need the commands list
   * after initialization has completed.
   */
  supportedCommands(): Promise<readonly SlashCommand[]>;
  /**
   * Debug session `in-tool-wedge-recovery` work-stream (C), FORK 8 —
   * background in-flight foreground tasks (Bash commands + subagents).
   * Mirrors @anthropic-ai/claude-agent-sdk Query.backgroundTasks
   * (sdk.d.ts ~2235).
   *
   * With `toolUseId`, targets the single foreground task started by that
   * tool_use block; the blocking tool call returns IMMEDIATELY with a
   * synthetic "running in the background" tool_result and the in-flight
   * turn RESUMES (no AbortError). Without `toolUseId`, backgrounds all
   * foreground tasks.
   *
   * SPIKE-CONFIRMED: the detach is a pure control-plane op (a JS state
   * flip + synthetic tool_result) — it works even against a fully-wedged
   * subprocess and never touches the child's stdio. It does NOT kill the
   * OS subprocess, and it does NOT target MCP tool calls.
   *
   * @returns `true` when at least one task was backgrounded; `false` when
   *   a `toolUseId` was given and it matched no live foreground task
   *   (already settled / wrong id) — handle that as "nothing to do", not
   *   an error.
   */
  backgroundTasks(toolUseId?: string): Promise<boolean>;
  /**
   * Debug session `in-tool-wedge-recovery` work-stream (C), FORK 8 — stop
   * a running task. Mirrors @anthropic-ai/claude-agent-sdk Query.stopTask
   * (sdk.d.ts ~2228). Used for best-effort subprocess cleanup AFTER a
   * `backgroundTasks` detach. A `task_notification` with status
   * `'stopped'` is emitted. A D-state child that cannot be killed is
   * irreducible — `stopTask` is best-effort, never block on it.
   */
  stopTask(taskId: string): Promise<void>;
  /**
   * Phase 999.75 Part B (B1/B5) — live context-window token usage.
   * Mirrors @anthropic-ai/claude-agent-sdk Query.getContextUsage
   * (sdk.d.ts:2123). Returns a real token count for the current epoch's
   * context window — the source of truth for compaction's
   * `tokens_before`/`tokens_after` before/after measurement (replaces the
   * ~4-chars-per-token char-count proxy). Consumed by
   * persistent-session-handle.ts:getContextUsage.
   */
  getContextUsage(): Promise<SdkContextUsage>;
  /**
   * The data behind Claude Code's `/usage`: claude.ai plan rate-limit
   * utilization straight from Anthropic's usage endpoint. Mirrors the SDK's
   * experimental `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`
   * (sdk.d.ts ~3047). Optional: an SDK without it simply lacks the method.
   */
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?(opts?: {
    skipBehaviors?: boolean;
  }): Promise<SdkPlanUsage>;
};

/** One claude.ai plan window: utilization is a PERCENT (0-100). */
export type SdkPlanWindow = {
  readonly utilization: number | null;
  readonly resets_at: string | null;
} | null;

/** Local projection of the SDK's experimental `/usage` response. */
export type SdkPlanUsage = {
  readonly rate_limits_available: boolean;
  readonly rate_limits: {
    readonly five_hour?: SdkPlanWindow;
    readonly seven_day?: SdkPlanWindow;
    readonly seven_day_opus?: SdkPlanWindow;
    readonly seven_day_sonnet?: SdkPlanWindow;
    readonly [k: string]: unknown;
  } | null;
};

/**
 * Phase 999.75 Part B (B1) — local projection of the SDK's
 * `SDKControlGetContextUsageResponse` (sdk.d.ts:2589-2603). Only the
 * `totalTokens` field is read by the compaction handler; the rest of the
 * SDK shape (per-category breakdown, grid rows) is omitted. The local alias
 * exists so consumers don't import the raw SDK (Phase 136 CI forbids
 * `@anthropic-ai/claude-agent-sdk` imports outside
 * `src/llm-runtime/backends/anthropic-agent-sdk.ts`).
 */
export type SdkContextUsage = {
  /** Total tokens currently occupying the live context window. */
  readonly totalTokens: number;
};

/**
 * Phase 999.75 Part A (A1) — local projection of the SDK's `SessionMessage`
 * type (sdk.d.ts:3720-3727). Returned by `getSessionMessages()` for reading a
 * historical session's JSONL transcript.
 *
 * `message` is typed `unknown` verbatim from the SDK — it carries the raw
 * Anthropic message object whose `content` is a block array (text / tool_use /
 * tool_result). Consumers MUST narrow it through a runtime validator before
 * walking the blocks; `src/memory/sdk-transcript-reader.ts` owns that
 * validation. The local alias exists so consumers don't import the raw SDK
 * (Phase 136 CI forbids `@anthropic-ai/claude-agent-sdk` imports outside
 * `src/llm-runtime/backends/anthropic-agent-sdk.ts`).
 */
export type SessionMessage = {
  readonly type: "user" | "assistant" | "system";
  readonly uuid: string;
  readonly session_id: string;
  readonly message: unknown;
  readonly parent_tool_use_id: null;
};

/**
 * Phase 999.75 Part A (A1) — options for `getSessionMessages()`. Mirrors the
 * SDK's `GetSessionMessagesOptions` (sdk.d.ts:683-704); only the fields
 * ClawCode passes are projected. `dir` is the project directory (same
 * semantics as `listSessions({ dir })` — when omitted the SDK searches every
 * project directory for the session file).
 */
export type GetSessionMessagesOptions = {
  readonly dir?: string;
  readonly limit?: number;
  readonly offset?: number;
  readonly includeSystemMessages?: boolean;
};

/**
 * Shape of the dynamically imported SDK module.
 * Contains only the functions we call from session-adapter.
 */
export type SdkModule = {
  query(params: { prompt: string | AsyncIterable<SdkUserMessage>; options?: SdkQueryOptions }): SdkQuery;
};
