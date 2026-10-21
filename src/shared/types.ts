// Phase 95 DREAM-01..03 — dream config type lives in the config schema.
// We import the inferred zod type so ResolvedAgentConfig.dream stays in
// lockstep with the schema definition (one source of truth).
import type { DreamConfig, HomelabConfig, OptimizerConfig, OpenaiVoiceConfig } from "../config/schema.js";
import type { ConfigModel } from "./model-catalog.js";

/**
 * Resolved agent configuration after defaults merging.
 * All optional fields from the raw config are resolved to concrete values.
 */
export type ResolvedAgentConfig = {
  readonly name: string;
  /**
   * Phase 999.117 WS-5 — additional names this agent answers to for
   * agent-to-agent addressing. Optional so the many existing
   * ResolvedAgentConfig fixtures stay valid; read it as `aliases ?? []`.
   */
  readonly aliases?: readonly string[];
  readonly workspace: string;
  /**
   * Phase 75 SHARED-01 — resolved filesystem path for the agent's
   * private runtime state (memories.db, traces.db, inbox/, heartbeat.log,
   * context-summary files, session-state). When the YAML omitted
   * `memoryPath:`, loader.ts populates this from `workspace` so downstream
   * consumers can always read it unconditionally. Always absolute
   * (expanded via expandHome in loader.ts Plan 02).
   */
  readonly memoryPath: string;
  readonly channels: readonly string[];
  /**
   * Multi-platform messaging phase — optional Slack binding. `channels` are
   * Slack channel ids; the identity fields drive the per-message
   * username/icon masquerade (fallback: agent name). undefined when the agent
   * has no Slack binding. See .planning/multi-platform-messaging-PLAN.md.
   */
  readonly slack?: {
    readonly channels: readonly string[];
    readonly displayName?: string;
    readonly iconUrl?: string;
    readonly iconEmoji?: string;
  };
  // Phase 999.98 — Category A executor path: widened to include "fable" and the
  // four `<family>@latest` opt-in literals (D11). The `@latest` form is the
  // CONFIG-TIME value carried through to session-adapter.ts, which PRE-RESOLVES
  // it to a concrete id (via `resolveLatestModel` over the daemon's catalog
  // snapshot) BEFORE the `resolveModelId` call — so the live/SDK boundary never
  // sees `@latest`. This resolved-config type stays the single source the
  // adapter reads, hence it must admit the sugar.
  readonly model: ConfigModel;
  // Mirrors `effortSchema` in config/schema.ts. Phase note: the schema was
  // extended with `xhigh`, `auto`, and `off` but this resolved-type union
  // had not been widened to match — keep them in sync.
  // Quick 260715-j1j (D1) — "ultracode" appended (8th level, schema order).
  readonly effort:
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max"
    | "auto"
    | "off"
    | "ultracode";
  /**
   * Quick 260715-j1j (D5) — per-agent native-Workflow opt-in. Populated by
   * the loader resolver ONLY when the agent yaml sets `nativeWorkflow: true`
   * (spread-conditional — OMITTED for the non-opted fleet so resolved-config
   * deep-equality pins stay byte-identical). Optional at the type level so
   * existing ResolvedAgentConfig test factories compile unchanged; every
   * consumer gates on `=== true` (fail-closed). NON-RELOADABLE — see the
   * agentSchema doc comment.
   */
  readonly nativeWorkflow?: boolean;
  /**
   * WS-1 (999.99 structural delivery) — turn-attributed stream consumption
   * gate. Cascade: agent.delivery?.attributedStream ??
   * defaults.delivery?.attributedStream ?? false. When true, the SDK epoch
   * wraps its driver iterator in an AttributedStreamDemux so self-fired
   * turns (Monitor / background-task notifications) deliver their output
   * to the channel immediately instead of buffering into the next inbound
   * reply. Spread-conditional OMIT when false — the non-canary fleet's
   * resolved shape stays byte-identical. NON-RELOADABLE (read at session
   * spawn, like disallowedTools).
   */
  readonly deliveryAttributedStream?: boolean;
  /**
   * Phase 86 MODEL-01 — per-agent allowlist for the /clawcode-model
   * Discord picker and the SessionManager.setModelForAgent guard.
   *
   * ALWAYS populated after resolution (loader.ts fills from
   * defaults.allowedModels when the agent omits the field). Downstream
   * consumers (Plan 02 daemon IPC, Plan 03 slash command) read this
   * unconditionally.
   *
   * Phase 999.114 — widened from the hardcoded ("haiku"|"sonnet"|"opus") triple
   * to the catalog-derived `ModelAlias`. The old narrow type contradicted its
   * own docstring ("Default is the full modelSchema enum") and silently
   * truncated any richer allowlist an operator wrote in clawcode.yaml.
   * Default is `DEFAULT_PICKER_MODELS` (every catalog alias).
   */
  readonly allowedModels: readonly ConfigModel[];
  /**
   * Phase 89 GREET-07 — ALWAYS populated by loader.ts from
   * agent.greetOnRestart ?? defaults.greetOnRestart. Downstream
   * (SessionManager.restartAgent → restart-greeting.ts) reads unconditionally.
   */
  readonly greetOnRestart: boolean;
  /**
   * Phase 89 GREET-10 — ALWAYS populated by loader.ts. Milliseconds.
   */
  readonly greetCoolDownMs: number;
  /**
   * Phase 124 Plan 02 D-06 — ALWAYS populated by loader.ts from
   * `agent['auto-compact-at'] ?? defaults['auto-compact-at']` (zod default
   * 0.7). The auto-compaction trigger ratio (0..1) of the context window.
   * Plan 125 consumes this to decide when to fire compaction automatically;
   * Phase 124 only ships the schema + loader resolver + this field so that
   * `clawcode reload` picks up YAML edits without a daemon restart.
   */
  readonly autoCompactAt: number;
  /**
   * Phase 125 Plan 02 — count of trailing turns the verbatim gate ALWAYS
   * preserves during auto-compaction. Populated by loader.ts from
   * `agent.preserveLastTurns ?? defaults.preserveLastTurns ?? 10`. Range
   * 1..100 (zod-validated). Optional at the type level for back-compat
   * with existing ResolvedAgentConfig test factories (consumers default
   * to 10).
   */
  readonly preserveLastTurns?: number;
  /**
   * Phase 125 Plan 02 (SC-8) — per-agent verbatim regex patterns. The
   * loader compiles each pattern string once via `new RegExp(p)`; invalid
   * patterns reject at config-resolve time (loader throws). UNDEFINED
   * when neither agent nor defaults provide entries — daemon treats this
   * as the empty pattern set.
   */
  readonly preserveVerbatimPatterns?: readonly RegExp[];
  /**
   * Phase 96 D-05 — per-agent fileAccess override. UNDEFINED when the agent
   * does not declare it (loader does not inherit defaults here — defaults
   * are merged by `resolveFileAccess(agent, cfg, defaults)` at IPC handler
   * call time). Daemon `probe-fs` / `list-fs-status` IPC handlers read this
   * via `manager.getAgentConfig(agent).fileAccess`.
   *
   * Bug fix 2026-04-25 (deploy): 96-01 added the schema field but missed
   * propagating it into the resolved type — daemon never saw per-agent
   * fileAccess, only defaults.fileAccess (zod default).
   */
  readonly fileAccess?: readonly string[];
  /**
   * Phase 96 D-09 — per-agent outputDir template (LITERAL string with
   * tokens preserved: {date}, {client_slug}, {channel_name}, {agent}).
   * UNDEFINED when the agent does not override defaults.outputDir.
   * Runtime `resolveOutputDir(template, ctx, deps)` expands tokens at
   * write time with fresh per-call ctx.
   */
  readonly outputDir?: string;
  /**
   * Phase 100 GSD-02 — per-agent SDK settingSources. ALWAYS populated by
   * loader.ts (defaults to ["project"]). Plan 02's session-adapter.ts will
   * read this verbatim to replace the hardcoded `settingSources: ["project"]`
   * at lines 592 + 631. The SDK loads ~/.claude/skills/, ~/.claude/commands/,
   * and ~/.claude/CLAUDE.md when 'user' is included; 'project' loads the
   * cwd's local .claude/ tree; 'local' loads .claude/local/ (gitignored).
   * Admin Clawdy sets ["project","user"] for GSD support; production agents
   * stay at ["project"].
   */
  readonly settingSources: readonly ("project" | "user" | "local")[];
  /**
   * Phase 100 GSD-04 — per-agent gsd block. UNDEFINED when agent.gsd.projectDir
   * is unset. Plan 02's session-adapter.ts will read `config.gsd?.projectDir
   * ?? config.workspace` to choose the SDK cwd. expandHome() already applied
   * by the loader (raw `~/...` paths are resolved before reaching this type).
   */
  readonly gsd?: { readonly projectDir: string };
  /**
   * Phase 100 follow-up — dream config propagated via resolveAgentConfig
   * (without this field, daemon's getResolvedDreamConfig sees undefined
   * and silently disables auto-fire). Same root-cause shape as Phase 100
   * settingSources / gsd.projectDir and Phase 96 fileAccess: schema
   * parsed `dream` but resolver dropped it before reaching the daemon.
   *
   * Populated when the agent declares a `dream:` block OR when
   * `defaults.dream` is set (resolver merges agent over defaults).
   * `enabled: false` (the schema default) is preserved verbatim — the
   * daemon's IPC handler checks `dream?.enabled === true`.
   */
  readonly dream?: DreamConfig;
  /**
   * Per-agent VOICE profile for the OpenAI endpoint (opt-in, default off).
   * Passed through verbatim by the resolver (`agent.openaiVoice`) — no
   * defaults cascade (per-agent only). The OpenAI driver/bootstrap reads this
   * to run the full agent session + enhanced streaming for voice; absent →
   * the stateless soul-only transient (today's behavior).
   */
  readonly openaiVoice?: OpenaiVoiceConfig;
  /**
   * Phase 142 — agent-optimizer config, propagated via resolveAgentConfig
   * (agent.optimizer ?? defaults.optimizer). Populated whenever `defaults.
   * optimizer` is set (default-bearing) or the agent declares an `optimizer:`
   * block. `enabled: false` (the schema default) is preserved verbatim — the
   * daemon's optimizer trigger checks `optimizer?.enabled === true` AND a
   * resolvable `evalSet` before running (MEASURED variant: no eval set = no run).
   */
  readonly optimizer?: OptimizerConfig;
  /**
   * Phase 999.47 Plan 02 — fleet-level homelab refresh tick config.
   * Propagated from `defaults.homelab` by the loader resolver (no
   * per-agent override at this time; homelab is fleet-wide). When
   * `defaults.homelab` is omitted from clawcode.yaml, this field is
   * undefined and the heartbeat check (`src/heartbeat/checks/homelab-
   * refresh.ts`) falls back to the documented constants. Reloadable
   * subset documented in `RELOADABLE_FIELDS` (src/config/types.ts).
   */
  readonly homelab?: HomelabConfig;
  /**
   * Phase 99 sub-scope N (2026-04-26) — SDK-level deny-list. When set, the
   * LLM physically cannot invoke any tool whose name matches an entry. Used
   * for the subagent recursion guard: SubagentThreadSpawner.spawnInThread
   * injects `["mcp__clawcode__spawn_subagent_thread"]` on the subagent's
   * config so subagents cannot chain further subagents (they inherit the
   * parent's "delegate, don't execute" soul and would otherwise loop).
   * session-config.ts propagates this verbatim into AgentSessionConfig and
   * session-adapter.ts forwards it into the SDK's disallowedTools option.
   * UNDEFINED for the existing 15+ agent fleet — no behavior change.
   */
  readonly disallowedTools?: readonly string[];
  /**
   * 999.103 WS-1 — live TodoWrite checklist mirrored to the agent's channel.
   * Resolved by the loader (agent ?? defaults, whole-object). Absent = off.
   */
  readonly todoMirror?: {
    readonly enabled: boolean;
    readonly minItems: number;
  };
  /**
   * 999.105 — output-style baseline from YAML (agent ?? defaults). Runtime
   * /clawcode-style overrides (style-state.json) take precedence at dispatch.
   */
  readonly outputStyle?: string;
  /**
   * Phase 90 MEM-01 — ALWAYS populated by loader.ts from
   * agent.memoryAutoLoad ?? defaults.memoryAutoLoad. Downstream
   * (session-config.ts MEMORY.md injection) reads unconditionally.
   * When false, the MEMORY.md block is omitted from the stable prefix.
   */
  readonly memoryAutoLoad: boolean;
  /**
   * Phase 90 MEM-01 — Optional absolute path override for MEMORY.md.
   * When set (expanded via expandHome in loader.ts), session-config.ts
   * reads from this path instead of `{workspace}/MEMORY.md`. Undefined
   * when the agent did not declare an override — the workspace-relative
   * default path wins.
   */
  readonly memoryAutoLoadPath?: string;
  /**
   * Phase 90 MEM-03 — ALWAYS populated by loader.ts from
   * agent.memoryRetrievalTopK ?? defaults.memoryRetrievalTopK. Consumed
   * by SessionManager.getMemoryRetrieverForAgent to cap the retrieved
   * chunk set per turn.
   */
  readonly memoryRetrievalTopK: number;
  /**
   * Phase 999.124 — memory-recall footer on replies. Loader-populated from
   * agent.memoryRecallFooter ?? defaults.memoryRecallFooter; absent = on.
   */
  readonly memoryRecallFooter?: boolean;
  /** Phase 999.133 — recalled memory on the 🧾 button/card (default) or as the footer line. */
  readonly memoryRecallDisplay?: "button" | "footer";
  /** Phase 999.127 — weekly memory digest (loader-populated; absent = on). */
  readonly memoryDigest?: { readonly enabled: boolean };
  /** Phase 999.123 — run the `verify-figures` fact-check step before the final report. */
  readonly workflowVerifyFigures?: boolean;
  /** Phase 999.128 — named workflow templates (fleet merged with per-agent, by name). */
  readonly workflowTemplates?: readonly import("../manager/workflow-templates.js").WorkflowTemplate[];
  /**
   * Phase 127 — stream-stall supervisor threshold (ms). Populated by
   * loader.ts via cascade:
   *   agent.streamStallTimeoutMs ??
   *   defaults.modelOverrides?.[resolved.model]?.streamStallTimeoutMs ??
   *   defaults.streamStallTimeoutMs (180000 baseline).
   * Consumed by the SDK iteration loop (persistent-session-handle.ts
   * production path + wrapSdkQuery test path) — the per-turn stall checker
   * compares Date.now() - lastUsefulTokenAt against this value, aborting
   * the in-flight turn on trip. Reloadable: the checker re-reads on each
   * setInterval tick so a yaml edit applies within
   * Math.min(threshold/4, 30000)ms without daemon restart.
   *
   * Optional at the type level for back-compat with the ~25 existing
   * ResolvedAgentConfig test factories (same precedent as
   * `memoryRetrievalTokenBudget?: number` above). Production loader.ts
   * always populates it; consumers default to 180000ms when undefined.
   */
  readonly streamStallTimeoutMs?: number;
  /**
   * Phase 145 WS2 — absolute turn-duration ceiling (ms). Populated by
   * loader.ts via cascade:
   *   agent.maxTurnDurationMs ??
   *   defaults.modelOverrides?.[resolved.model]?.maxTurnDurationMs ??
   *   defaults.maxTurnDurationMs ??
   *   DEFAULT_MAX_TURN_DURATION_MS (20-min built-in).
   * Threaded into AgentSessionConfig (handle-only) by buildSessionConfig;
   * Plan 03 reads it at the createStreamStallTracker call site
   * (persistent-session-handle.ts) to LIFT the watchdog-of-last-resort
   * ceiling for long-running background workers (WS2). The zod min equals
   * the 20-min default, so an operator can only ever raise it.
   *
   * Optional at the type level for back-compat with existing
   * ResolvedAgentConfig test factories (same precedent as
   * `streamStallTimeoutMs?: number` above). Production loader.ts always
   * populates it; consumers default to DEFAULT_MAX_TURN_DURATION_MS.
   */
  readonly maxTurnDurationMs?: number;
  /**
   * Phase 145 WS1 — subagent permission-hook gate. Populated by loader.ts:
   *   agent.subagentPermissionGate ?? defaults.subagentPermissionGate ?? false.
   * Threaded into AgentSessionConfig by buildSessionConfig; Plan 02 reads it
   * in the SDK adapter to decide whether to register the deterministic
   * PreToolUse hook that makes in-process subagents non-interactive
   * (auto-allow the working set, auto-deny the prompting WebFetch tool).
   * Default false keeps the existing fleet byte-identical.
   *
   * Optional at the type level (same back-compat precedent as the other
   * additive ResolvedAgentConfig flags). Production loader.ts always
   * populates it; consumers treat undefined as false.
   */
  readonly subagentPermissionGate?: boolean;
  /**
   * Per-agent advisor override block (Phase 117 `agentAdvisorOverrideSchema`),
   * carried verbatim from the parsed agent config so the IPC + capability
   * surfaces can resolve the per-agent backend/model.
   *
   * BUGFIX (2026-06-26): previously the loader resolved advisor-*derived*
   * values via `resolveAdvisorBackend`/`resolveAdvisorModel` but never carried
   * the raw `advisor` block onto `ResolvedAgentConfig`. `handleAskAdvisor`
   * (daemon.ts) reads `getAgentConfig(agent).advisor.backend` — which was
   * always `undefined` — so the documented per-agent override
   * (`agents.<name>.advisor.backend: fork`) was SILENTLY DROPPED and every
   * agent fell through to `defaults.advisor.backend`. Carrying the block here
   * makes `resolveAdvisorBackend(cfg, defaults)` honor the per-agent value.
   * Omitted (spread-conditional in loader.ts) for agents with no override →
   * byte-stable for the existing fleet.
   */
  readonly advisor?: {
    readonly backend?: "native" | "fork";
    readonly model?: string;
    readonly maxUsesPerRequest?: number;
    readonly forkTimeoutMs?: number;
    readonly caching?: {
      readonly enabled?: boolean;
      readonly ttl?: "5m" | "1h";
    };
  };
  /**
   * Phase 999.100 — FULLY-RESOLVED mid-turn steering config. Unlike the
   * `advisor` block above (carried verbatim), the loader resolves the
   * per-field cascade (agents[].steering ?? defaults.steering ?? baseline)
   * HERE so the bridge gate reads one final struct per message — avoiding
   * the 2026-06-26 advisor class of bug where derived resolution dropped
   * the per-agent override. Optional at the type level so hand-built test
   * configs don't need updates; consumers resolve absence via
   * `resolveSteeringRuntime` (src/manager/midturn-intent.ts baseline:
   * autoClassify=false → feature off).
   */
  readonly steering?: {
    readonly autoClassify: boolean;
    readonly stopIntent: boolean;
    readonly maxInjectionsPerTurn: number;
    readonly minConfidence: number;
    readonly stopMinConfidence: number;
    readonly classifierTimeoutMs: number;
  };
  /**
   * Phase 115 sub-scope 3 — populated by loader.ts from
   * agent.memoryRetrievalTokenBudget ?? defaults.memoryRetrievalTokenBudget.
   * Range 500-8000 (zod-validated). Consumed by
   * SessionManager.getMemoryRetrieverForAgent and forwarded to
   * retrieveMemoryChunks as the per-turn <memory-context> token cap.
   * Down from the pre-115 hardcoded 2000 default; the zod knob existed
   * in defaultsSchema since Phase 90 MEM-03 but was never wired through —
   * Phase 115 Plan 01 lit it up. Optional at the type level so existing
   * ResolvedAgentConfig test factories don't need updates; consumers
   * default to 1500 (matches defaults.memoryRetrievalTokenBudget).
   */
  readonly memoryRetrievalTokenBudget?: number;
  /**
   * Phase 115 sub-scope 4 — populated by loader.ts from
   * agent.memoryRetrievalExcludeTags ?? defaults.memoryRetrievalExcludeTags.
   * Tag list whose memories are excluded from the per-turn <memory-context>
   * block at hybrid-RRF retrieval. Locked default
   * ["session-summary","mid-session","raw-fallback"] removes pollution-
   * feedback memories that pre-115 leaked into the prompt as giant blobs
   * (research codebase-memory-retrieval.md Pain Points #3 + #15). Empty
   * array disables filtering. Consumed by
   * SessionManager.getMemoryRetrieverForAgent and forwarded to
   * retrieveMemoryChunks as `excludeTags`. Optional at the type level for
   * back-compat with existing ResolvedAgentConfig factory test code;
   * consumers default to the locked Phase 115 list.
   */
  readonly memoryRetrievalExcludeTags?: readonly string[];
  /**
   * Phase 115 sub-scope 2 — populated by loader.ts from
   * agent.excludeDynamicSections ?? defaults.excludeDynamicSections (zod
   * default true). When true, the SDK strips per-machine dynamic sections
   * (cwd, auto-memory paths, git status) from the cached system prompt and
   * re-injects them as the first user message — improves cross-agent
   * prompt-cache reuse. Consumed by session-config.ts's buildSessionConfig
   * to thread into AgentSessionConfig and on into the SDK options.
   * Reload classification: NEXT-SESSION only. Optional at the type level
   * for back-compat with ~20 existing ResolvedAgentConfig test factories;
   * consumers default to true (matches defaults.excludeDynamicSections).
   */
  readonly excludeDynamicSections?: boolean;
  /**
   * Phase 115 sub-scope 5 (Plan 04) — populated by loader.ts from
   * agent.cacheBreakpointPlacement ?? defaults.cacheBreakpointPlacement
   * (zod default "static-first"). Controls the assembled stable-prefix
   * section ordering: "static-first" (default) places static sections
   * (identity, soul, skills, tools, fs-capability, delegates) BEFORE the
   * CACHE_BREAKPOINT_MARKER and dynamic sections (hot memories, graph
   * context) AFTER, recovering prompt-cache hit rate on turns where only
   * dynamic content changed; "legacy" keeps the pre-115-04 interleaved
   * order with no marker. Consumed by session-config.ts to pass into
   * `assembleContext` via AssembleOptions.cacheBreakpointPlacement. Reload
   * classification: NEXT-SESSION only — placement is baked into the
   * assembled stable prefix at session create/resume. Optional at the
   * type level for back-compat with existing ResolvedAgentConfig test
   * factories; consumers default to "static-first".
   */
  readonly cacheBreakpointPlacement?: "static-first" | "legacy";
  /**
   * Phase 90 MEM-02 — ALWAYS populated by loader.ts from
   * agent.memoryScannerEnabled ?? defaults.memoryScannerEnabled.
   * When false, daemon.ts skips the MemoryScanner construction for
   * this agent (memory/ content is managed externally).
   */
  readonly memoryScannerEnabled: boolean;
  /**
   * Phase 90 MEM-04 — ALWAYS populated by loader.ts from
   * agent.memoryFlushIntervalMs ?? defaults.memoryFlushIntervalMs.
   * Consumed by SessionManager.startAgent when constructing the per-agent
   * MemoryFlushTimer. Milliseconds — default 900_000 (15 minutes) per D-26.
   */
  readonly memoryFlushIntervalMs: number;
  /**
   * Phase 90 MEM-05 — ALWAYS populated by loader.ts from
   * agent.memoryCueEmoji ?? defaults.memoryCueEmoji. Consumed by
   * TurnDispatcher's cue-detection post-turn hook to determine which
   * reaction emoji to post (D-32). Default "✅".
   */
  readonly memoryCueEmoji: string;
  /**
   * Phase 999.43 D-09 — populated by loader.ts from
   * agent.autoIngestAttachments ?? defaults.autoIngestAttachments (both
   * default-bearing in zod, so the resolved value is always a concrete
   * boolean at runtime). Read LAZILY by the Phase 999.43 Plan 02 dispatcher
   * on each `attachmentReceived` event — a YAML edit takes effect on the
   * NEXT attachment Discord delivers (RELOADABLE_FIELDS in src/config/
   * types.ts). Mirrors the memoryAutoLoad / autoStart blueprint.
   *
   * Optional at the type level for back-compat with the ~30 existing
   * ResolvedAgentConfig test factories (same precedent as
   * `memoryRetrievalTokenBudget?: boolean` / `excludeDynamicSections?:
   * boolean` above). Production loader.ts always populates it; consumers
   * default to false when undefined.
   */
  readonly autoIngestAttachments?: boolean;
  /**
   * Phase 999.43 D-01 Axis 1 — populated by loader.ts from
   * agent.ingestionPriority ?? defaults.ingestionPriority (default
   * "medium"). Three-level enum; the score-formula multipliers per D-01
   * are: high=1.5, medium=1.0, low=0.7. Consumed at retrieval time by
   * Plan 03's score-weighting in `search_documents`. Reloadable — same
   * closure-re-read path as autoIngestAttachments above.
   *
   * Optional at the type level for back-compat with the ~30 existing
   * ResolvedAgentConfig test factories (same precedent as
   * `streamStallTimeoutMs?: number` / `excludeDynamicSections?: boolean`
   * above). Production loader.ts always populates it; consumers default to
   * "medium" when undefined.
   */
  readonly ingestionPriority?: "low" | "medium" | "high";
  /**
   * Phase 100 follow-up — ALWAYS populated by loader.ts from
   * agent.autoStart ?? defaults.autoStart (both default-bearing in zod, so
   * the resolved value is always a concrete boolean). Consumed by the
   * daemon's auto-start IIFE (src/manager/daemon.ts) to filter the array
   * passed to manager.startAll on boot — autoStart=false agents are NOT
   * spawned on the daemon's start-all loop, but their config remains in
   * the routeMethod `configs` array so the operator can manually start
   * them via `clawcode start <name>` (the IPC handler does
   * `configs.find((c) => c.name === name)`, NOT a `getAgentConfig` lookup,
   * so dormant agents are findable on demand).
   */
  readonly autoStart: boolean;
  /**
   * Phase 999.25 — boot-time wake-order priority. Lower numbers boot first.
   * `undefined` means "boot last in YAML order" (stable sort). Consumed by
   * the daemon's auto-start IIFE which sorts `autoStartAgents` by
   * `(wakeOrder ?? Infinity)` before passing to `manager.startAll`.
   *
   * Pass-through from agent yaml — no defaults.X fallback (defaults has no
   * wakeOrder field; ordering is per-agent or undefined).
   */
  readonly wakeOrder?: number;
  readonly skills: readonly string[];
  /** dashboard-rework — native Claude Code plugins enabled for this agent
   *  (`<plugin>@<marketplace>` refs). Attached at spawn (v3 channels path).
   *  Optional so existing ResolvedAgentConfig constructors/fixtures compile;
   *  the loader always populates it (`agent.plugins ?? []`). */
  readonly plugins?: readonly string[];
  /**
   * Phase 999.13 DELEG-02 — per-agent specialty → target-agent map.
   * UNDEFINED when the agent does not declare `delegates:` in yaml
   * (back-compat: existing 15-agent fleet sees no behavior change).
   * When set, session-config.ts renders this via `renderDelegatesBlock`
   * and threads the resulting string into `ContextSources.delegatesBlock`,
   * which the assembler appends to the END of the stable prefix.
   *
   * configSchema.superRefine has already validated that every value
   * points to a configured agent name at config load time — runtime
   * consumers can trust the data.
   */
  readonly delegates?: Readonly<Record<string, string>>;
  /**
   * Tenant/owner tag for cross-agent isolation (2026-06-27). When two agents
   * carry DIFFERENT non-undefined owners, cross-agent actions between them
   * (ask/spawn-delegate/workflow/post/delegate/schedule/thread/history) are
   * denied at the IPC dispatch chokepoint (`agent-owner-isolation.ts`), unless
   * the caller is `admin`. UNDEFINED = untenanted (no boundary asserted from or
   * toward it). See .planning/phases/agent-owner-isolation/SPEC.md.
   */
  readonly owner?: string;
  /**
   * DERIVED — `true` only when the agent opted in AND its owner is in
   * `defaults.claudeAiConnectors.allowedOwners` AND it is not admin
   * (`resolveClaudeAiConnectorsEntitlement`). Omitted otherwise. Spread into
   * sub/thread/worker configs, so those inherit the parent's entitlement.
   */
  readonly claudeAiConnectors?: true;
  /**
   * DERIVED (not from YAML) — absolute cross-owner agent-dir prefixes this agent
   * must not touch via file tools. Computed by the loader from the full fleet
   * (every other-owner agent's workspace + memoryPath) and threaded to the
   * in-process PreToolUse owner-FS-guard hook. Undefined/empty for untenanted or
   * admin agents (no guard). Defense-in-depth — see owner-fs-guard-hook.ts.
   */
  readonly crossOwnerForbiddenPaths?: readonly string[];
  readonly soul: string | undefined;
  readonly identity: string | undefined;
  /**
   * Phase 78 CONF-01 — absolute expanded path to a SOUL markdown file.
   * Undefined unless the agent's YAML entry set `soulFile:`. When set,
   * session-config.ts reads this file lazily at session boot and prefers
   * it over `<workspace>/SOUL.md` and the inline `soul` field.
   * Expansion via expandHome() happens in loader.ts — never raw `~/...`.
   */
  readonly soulFile?: string;
  /**
   * Phase 78 CONF-01 — absolute expanded path to an IDENTITY markdown file.
   * Same precedence rules as soulFile; session-config.ts reads lazily.
   */
  readonly identityFile?: string;
  readonly memory: {
    readonly compactionThreshold: number;
    readonly searchTopK: number;
    readonly consolidation: {
      readonly enabled: boolean;
      readonly weeklyThreshold: number;
      readonly monthlyThreshold: number;
      // Phase 999.98 — Category D: kept 3-only by the 3-only decision. NEVER
      // summarize on a $10/$50 model — Fable is deliberately excluded here.
      readonly summaryModel?: "sonnet" | "opus" | "haiku";
      readonly schedule: string;
    };
    readonly decay: {
      readonly halfLifeDays: number;
      readonly semanticWeight: number;
      readonly decayWeight: number;
    };
    readonly deduplication: {
      readonly enabled: boolean;
      readonly similarityThreshold: number;
    };
    readonly tiers?: {
      readonly hotAccessThreshold: number;
      readonly hotAccessWindowDays: number;
      readonly hotDemotionDays: number;
      readonly coldRelevanceThreshold: number;
      readonly hotBudget: number;
      // Phase 100-fu — backlink-count threshold for centrality-based hot
      // promotion. Mirrored on the zod schema and in DEFAULT_TIER_CONFIG.
      // Was missing from this resolved type, which surfaced as TS2741 at
      // session-memory.ts:88 when passing tierConfig to TierManager.
      readonly centralityPromoteThreshold: number;
    };
    /**
     * Phase 67 — conversation persistence knobs. Shape mirrors the resolved
     * `conversationConfigSchema` output from `src/memory/schema.ts`. Kept
     * optional because the raw agent config may omit the block entirely;
     * when present, all five fields are supplied by Zod defaults.
     */
    readonly conversation?: {
      readonly enabled: boolean;
      readonly turnRetentionDays: number;
      /** SESS-02 — last-N session summaries rendered in the conversation brief. */
      readonly resumeSessionCount: number;
      /** SESS-03 — skip auto-injection when gap from last session is under this many hours. */
      readonly resumeGapThresholdHours: number;
      /** Dedicated token budget for the conversation_context section (NOT shared with resume_summary). */
      readonly conversationContextBudget: number;
      /** Phase 68 — RETR-03: half-life (days) for retrieval-time decay weighting over conversation search results. */
      readonly retrievalHalfLifeDays: number;
      /**
       * Gap 3 (memory-persistence-gaps) — how often to write a non-terminating
       * mid-session summary while a session is live. 0 disables the timer;
       * positive values produce one MemoryEntry tagged "mid-session" per
       * interval. Default 15 min.
       */
      readonly flushIntervalMinutes: number;
    };
  };
  readonly heartbeat: {
    readonly enabled: boolean;
    readonly intervalSeconds: number;
    readonly checkTimeoutSeconds: number;
    readonly contextFill: {
      readonly warningThreshold: number;
      readonly criticalThreshold: number;
      readonly zoneThresholds?: {
        readonly yellow: number;
        readonly orange: number;
        readonly red: number;
      };
    };
    /**
     * Phase 100 follow-up — operator-specified per-agent heartbeat cadence
     * (e.g., "50m" for fin-client's context-zone monitor). Populated
     * by loader.ts when the agent declares the extended `heartbeat: {every,
     * model, prompt}` shape; undefined when the agent uses the boolean form.
     * Surfaced verbatim in the capability manifest.
     */
    readonly every?: string;
    /**
     * Phase 100 follow-up — operator-specified model for the per-agent
     * heartbeat prompt. Same population rules as `every`.
     */
    readonly model?: "haiku" | "sonnet" | "opus";
  };
  readonly skillsPath: string;
  readonly schedules: readonly {
    readonly name: string;
    readonly cron: string;
    readonly prompt: string;
    readonly enabled: boolean;
  }[];
  readonly admin: boolean;
  // Per-agent OS sandbox (bubblewrap). Resolved from agents.*.sandbox →
  // defaults.sandbox → {enabled:false, allowRuntimeOp:false}. NON_RELOADABLE
  // (captured into the spawn at boot). Admin agents are exempt at the wrapper.
  readonly sandbox: { readonly enabled: boolean; readonly allowRuntimeOp: boolean };
  // Phase 999.98 — subagent surface, NOT the primary executor path: kept
  // 3-only by the 3-only decision (loader.ts cast-narrows the schema-derived
  // value into this field). Do not widen a subagent surface to add fable.
  readonly subagentModel: "sonnet" | "opus" | "haiku" | undefined;
  /** Phase 999.162 — per-agent `ENABLE_TOOL_SEARCH` value ("true" | "false" | "auto" | "auto:N"). */
  readonly toolSearch?: string;
  /** Phase 999.173 — research-subagent knobs, verbatim from yaml (defaults applied at session build). */
  readonly research?: {
    readonly model?: "sonnet" | "opus" | "haiku" | "fable" | "inherit";
    readonly effort?: "low" | "medium" | "high" | "xhigh" | "max";
    readonly maxTurns?: number;
    readonly maxConcurrent?: number;
    readonly holdTimeoutMinutes?: number;
    readonly tools?: readonly string[];
    readonly deniedTools?: readonly string[];
    readonly allowBash?: boolean;
    readonly usageGuard?: { readonly reduceAt?: number; readonly blockAt?: number };
    readonly maxToolCalls?: number;
    readonly maxSessionToolCalls?: number;
    readonly maxMinutes?: number;
    /** Route deep-dive / research / workflow requests to researchers (research-route.ts). */
    readonly autoRoute?: boolean;
  };
  /** Phase 999.161 — fast lane (parsed with schema defaults; absent = off). */
  readonly fastLane?: {
    readonly enabled: boolean;
    readonly model: "haiku" | "sonnet";
    readonly answerTimeoutMs: number;
    readonly maxTokens: number;
    readonly maxMessageChars: number;
    /** Phase 999.164 — operator words/phrases that always mean "task lane". */
    readonly taskTopics?: readonly string[];
  };
  /**
   * Phase 999.171 — per-agent UX toggles, resolved to three booleans (omitted
   * block = all false). Optional so hand-built fixtures keep compiling. The
   * `/clawcode-ux` runtime override layers over this (ux-feature-state.json).
   */
  readonly uxFeatures?: {
    readonly liveThinking: boolean;
    readonly statusPing: boolean;
    readonly promptSuggestions: boolean;
    readonly researchSubagents: boolean;
  };
  readonly threads: {
    readonly idleTimeoutMinutes: number;
    readonly maxThreadSessions: number;
  };
  readonly webhook?: {
    readonly displayName: string;
    readonly avatarUrl?: string;
    readonly webhookUrl?: string;
  };
  readonly reactions: boolean;
  readonly security?: {
    readonly allowlist: readonly { readonly pattern: string }[];
    /**
     * Phase 74 Plan 02 — per-agent gate against scope='all' bearer keys.
     * When `true`, the OpenAI endpoint returns 403 agent_forbids_multi_agent_key
     * for any scope='all' bearer targeting this agent. Default `false`.
     * Does NOT affect the `openclaw:<slug>` template-driver path.
     */
    readonly denyScopeAll: boolean;
  };
  readonly mcpServers: readonly {
    readonly name: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    /**
     * Phase 85 TOOL-01 — when true, readiness-gate failure is
     * warn-logged but does NOT block the agent transitioning to
     * `status: running`. Default false = mandatory. Populated by
     * config/loader.ts from mcpServerSchema.
     */
    readonly optional: boolean;
    /**
     * Phase 100 follow-up — operator-curated annotations surfaced in the
     * capability manifest. UNDEFINED for legacy entries without
     * description/accessPattern (back-compat).
     */
    readonly description?: string;
    readonly accessPattern?: "read-only" | "read-write" | "write-only";
    /**
     * Phase 999.54 (D-01a) — SDK alwaysLoad passthrough. UNDEFINED for legacy
     * entries that don't set the field; spread-conditional construction at
     * src/config/loader.ts (Plan 02) keeps the field OMITTED from the resolved
     * entry when yaml didn't declare it, preserving byte-stable deep-equality
     * for the existing fleet. Forwarded verbatim through AgentSessionConfig
     * → transformMcpServersForSdk → SDK Options.mcpServers[].alwaysLoad.
     */
    readonly alwaysLoad?: boolean;
    /**
     * INC-2026-08-11 — minimum ms between heartbeat probes while this server is
     * steady-state healthy. Absent/0 = probe every tick (fleet default).
     *
     * MUST be carried here as well as in `mcpServerSchema`, or the loader drops
     * it between config and runtime and the throttle is silently inert — the
     * knob would parse, validate, and do nothing.
     */
    readonly minProbeIntervalMs?: number;
  }[];
  /**
   * Phase 100 follow-up — per-agent MCP env override map (vault-scoped
   * service account distribution). UNDEFINED on the existing 15-agent fleet
   * (all inherit the daemon's clawdbot full-fleet token via shared
   * mcpServers[].env). Populated only on agents that explicitly declare
   * `mcpEnvOverrides` in YAML — currently the 5 acme agents (fin-
   * acquisition, fin-research, fin-tax, fin-playground, acme-content-
   * creator) which scope down to the Acme vault SA token.
   *
   * Values are stored VERBATIM here (loader does NOT call op read at
   * config-load time). The daemon resolves op:// URIs at agent-start via
   * `resolveMcpEnvOverrides` (src/manager/op-env-resolver.ts) before the
   * MCP subprocess spawns. Resolved tokens NEVER appear in this type — they
   * land directly in the spawn-time mcpServers[].env passed to the SDK.
   */
  readonly mcpEnvOverrides?: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
  readonly acceptsTasks?: Readonly<Record<string, readonly string[]>>;  // Phase 59
  readonly escalationBudget?: {
    readonly daily?: {
      readonly sonnet?: number;
      readonly opus?: number;
    };
    readonly weekly?: {
      readonly sonnet?: number;
      readonly opus?: number;
    };
  };
  readonly contextBudgets?: {
    readonly identity: number;
    readonly hotMemories: number;
    readonly toolDefinitions: number;
    readonly graphContext: number;
  };
  readonly slashCommands: readonly {
    readonly name: string;
    readonly description: string;
    readonly claudeCommand: string;
    readonly options: readonly {
      readonly name: string;
      readonly type: number;
      readonly description: string;
      readonly required: boolean;
    }[];
  }[];
  readonly perf?: {
    readonly traceRetentionDays?: number;
    readonly slos?: readonly {
      readonly segment:
        | "end_to_end"
        | "first_token"
        | "context_assemble"
        | "tool_call";
      readonly metric: "p50" | "p95" | "p99";
      readonly thresholdMs: number;
    }[];
    readonly memoryAssemblyBudgets?: {
      readonly identity?: number;
      readonly soul?: number;
      readonly skills_header?: number;
      readonly hot_tier?: number;
      readonly recent_history?: number;
      readonly per_turn_summary?: number;
      readonly resume_summary?: number;
      /**
       * fleet-audit-2026-06-16 (H4) — per-agent override for the MEMORY.md
       * auto-load hard char cap (`INJECTED_MEMORY_MAX_CHARS`, default 16,000).
       * Lets a heavy-monitor agent (Admin Clawdy) shrink its tier-1 injection
       * cost via config. Bounded [1000, 16000] at the schema; resolved at the
       * MEMORY.md auto-load site in `session-config.ts`. Omitted → the module
       * const (no-op for the fleet).
       */
      readonly injectedMemoryMaxChars?: number;
      /** Phase 999.187 — cap for the USER.md auto-load (default 4,000 chars). */
      readonly injectedUserMaxChars?: number;
    };
    readonly lazySkills?: {
      readonly enabled: boolean;
      readonly usageThresholdTurns: number;
      readonly reinflateOnMention: boolean;
    };
    readonly resumeSummaryBudget?: number;
    readonly streaming?: {
      readonly editIntervalMs?: number;
      readonly maxLength?: number;
      // Phase 141 — v3 streaming activity level (mirrors streamingConfigSchema.activity).
      // "natural" (default) | "raw" | "off". Decoupled from the /clawcode-verbose flag.
      readonly activity?: "natural" | "raw" | "off";
    };
    /**
     * Phase 55 — per-agent tool dispatch / cache / SLO overrides. Mirrors the
     * Zod `toolsConfigSchema` parse output verbatim. Inline literal shape
     * (no cross-module import) preserves the `src/shared/types.ts` low-dep
     * boundary established in Phase 51 / 53 / 54.
     *
     * `maxConcurrent` + `idempotent` are REQUIRED when `tools` is present
     * (the Zod schema supplies defaults), so consumers can read them without
     * an optional-chain fallback. The whole `tools` block remains optional.
     */
    readonly tools?: {
      readonly maxConcurrent: number;
      readonly idempotent: readonly string[];
      readonly slos?: Readonly<Record<string, {
        readonly thresholdMs: number;
        readonly metric?: "p50" | "p95" | "p99";
      }>>;
    };
  };
  // Phase 113 — per-agent Haiku vision pre-pass config.
  readonly vision?: {
    readonly enabled: boolean;
    /** Deprecated no-op (Phase 999.154). */
    readonly preserveImage: boolean;
    /** Phase 999.154 — see schema.ts `vision`. Absent ⇒ "inline". */
    readonly mode?: "inline" | "prepass" | "off";
    readonly inline?: {
      readonly fullResImages?: number;
      readonly maxImageTokens?: number;
      readonly maxImages?: number;
      readonly screenshotSidePx?: number;
      readonly photoSidePx?: number;
      readonly contactSheet?: { readonly grid?: number; readonly tilePx?: number };
    };
    readonly burst?: { readonly quietMs?: number; readonly maxWaitMs?: number };
  };
  /**
   * 999.101 — bot-trigger allowlist (see schema doc). Present only when
   * the agent opts in; the bridge treats absent/empty as drop-all-bots
   * (the pre-999.101 behavior).
   */
  readonly botTriggers?: readonly {
    readonly author: string;
    readonly authorId?: string;
    readonly cooldownMinutes: number;
    readonly enabled: boolean;
  }[];
  /**
   * Phase 115 sub-scope 14 — per-agent operator-toggle for the diagnostic
   * baseopts dump. UNDEFINED on the existing fleet (no behavior change). When
   * `dumpBaseOptionsOnSpawn === true`, session-adapter.ts writes a per-agent
   * baseopts dump on every createSession/resumeSession (secrets redacted).
   * Replaces the temporary hardcoded fin-client + Admin Clawdy allowlist
   * deployed during the 2026-05-07 incident response. The schema parses
   * `agents[*].debug` as optional; this resolved type mirrors the optional
   * shape verbatim.
   */
  readonly debug?: {
    readonly dumpBaseOptionsOnSpawn: boolean;
  };
  /**
   * Phase 136 — primary agent runtime backend selection.
   *
   * ALWAYS populated by loader.ts (resolver fills from
   * `agent.llmRuntime?.backend ?? defaults.llmRuntime?.backend ?? "anthropic-agent-sdk"`).
   * Phase 136 ships the seam scaffold with a single accepted value
   * (`"anthropic-agent-sdk"` — the current production runtime,
   * extracted into `AnthropicAgentSdkBackend`). Phase 137 widens the
   * Zod enum to add `"anthropic-api-key"` for pay-as-you-go billing
   * when the 2026-06-15 Anthropic Agent SDK credit cap depletes;
   * Phase 138 wires credit telemetry + automatic failover; Phase 141
   * adds Codex; Phase 142 adds OpenRouter.
   *
   * **Optional at the type level for back-compat** with existing
   * ResolvedAgentConfig test factories (~30 inline test fixtures)
   * that don't go through the resolver. Same precedent as
   * `preserveLastTurns?: number` (Phase 125 Plan 02) and
   * `vision?: { ... }` (Phase 113). Downstream consumers (the
   * `createLlmRuntimeService` factory at
   * `src/llm-runtime/llm-runtime-service.ts`) read the field via
   * `config.llmRuntime?.backend ?? "anthropic-agent-sdk"` so a
   * missing block resolves to the Phase 136 baseline.
   *
   * **Construction-site consumer:** `createLlmRuntimeService(config, deps)`
   * at `src/llm-runtime/llm-runtime-service.ts`. Single chokepoint per
   * agent per session in `daemon.ts` — direct
   * `await import("@anthropic-ai/claude-agent-sdk")` outside
   * `src/llm-runtime/backends/anthropic-agent-sdk.ts` is forbidden
   * (static-grep CI test enforces).
   *
   * **NON_RELOADABLE** — backend selection is captured into the
   * session boot path at agent start; YAML edits take effect on the
   * next `clawcode restart <agent>`. Same architectural pattern as
   * Phase 117 `advisor.backend` and Phase 999.54 `alwaysLoad`.
   */
  readonly llmRuntime?: {
    readonly backend: import("../llm-runtime/types.js").LlmRuntimeBackend;
    /**
     * Phase 137 Plan 01 — Codex-specific sub-config. Only consulted
     * when `backend === "codex-cli"`. Optional: when unset, discovery
     * falls back to PATH lookup + the CODEX_DEFAULT_COMMON_PATHS list.
     * NON_RELOADABLE per `src/config/types.ts`.
     */
    readonly codex?: {
      readonly pathToCodexExecutable?: string;
      /**
       * Phase 137 Plan 03 T-03 — operator-overridable Codex model
       * id. Default "gpt-5-codex" set in the Zod resolver. Captured
       * once at query construction (CodexSdkModule) and baked into
       * the spawn argv. NON_RELOADABLE per src/config/types.ts;
       * YAML edits take effect on the next `clawcode restart`.
       */
      readonly model?: string;
    };
    /**
     * Phase 138 Plan 05 D4 — ordered failover-chain. The loader
     * resolver ALWAYS populates this (cascade:
     * `agent.llmRuntime?.failoverChain ?? defaults.llmRuntime?.
     * failoverChain ?? []`), so it is non-optional here. An empty
     * array means "no failover" — a 95% provider crossing warns only.
     * RELOADABLE per `src/config/types.ts`.
     */
    readonly failoverChain: readonly import("../llm-runtime/types.js").LlmRuntimeBackend[];
    /**
     * Phase 999.84 Plan 04 — Model A opt-in for v3 chat agents.
     * `true` → spawn argv includes `plugin:discord@claude-plugins-official`
     * (Anthropic's official Discord turn-source, the production-tested
     * path); the agent reads its own DISCORD_BOT_TOKEN from
     * `~/.clawcode/channels-state/<agent>/.env`. `undefined`/`false`
     * (default) → Model B (`server:clawcode-channel` only — the
     * experimental path 999.84 falsified as flaky). Cascade:
     * `agent.llmRuntime?.includeDiscordPlugin ??
     * defaults.llmRuntime?.includeDiscordPlugin`. NON_RELOADABLE — the
     * `claude --channels` argv is locked at spawn time.
     */
    readonly includeDiscordPlugin?: boolean;
    /**
     * Phase 141 (#4) — v3 PTY permission mode. Threaded to the
     * `claude --channels` spawn as `--permission-mode <mode>`. Unset →
     * buildChannelsArgv defaults to `bypassPermissions` (parity with the
     * v2 SDK path's hardcoded session-adapter.ts:1312/1469). NON_RELOADABLE —
     * the argv is locked at spawn time.
     */
    readonly permissionMode?:
      | "acceptEdits"
      | "auto"
      | "bypassPermissions"
      | "default"
      | "dontAsk"
      | "plan";
    /**
     * Phase 999.86 — pre-warmed worker pool sizing for v3 Discord chat.
     *
     * `size` is the number of `claude --channels` workers kept idle on
     * the dev-channels confirmation menu per parent agent. Default `1`.
     * Set `0` to disable pre-warming for this agent — every chat
     * dispatch then cold-spawns (legacy Fix C latency, ~10-15 s).
     *
     * `maxConcurrent` caps the simultaneously alive workers
     * (warm + in-flight). Defaults to `size + 2`, so a 3-4 message
     * burst can overlap without blocking but a runaway loop can't
     * exhaust memory. Set explicitly when an agent expects bursty
     * channels.
     *
     * Cascade: `agent.llmRuntime?.warmPool ??
     * defaults.llmRuntime?.warmPool`. The whole block is consumed only
     * when `CLAWCODE_WARM_POOL=1` is set on the daemon (canary gate).
     */
    readonly warmPool?: {
      readonly size?: number;
      readonly maxConcurrent?: number;
    };
  };
  /**
   * Phase 999.63 Plan 04 — resolved financial-verification enforcement
   * override (CONTEXT.md D6).
   *
   * Populated by the loader cascade resolver:
   *   `agent.verification?.enforced ??
   *      defaults.verification?.enforced`
   * The whole block is emitted ONLY when `enforced` resolves to a concrete
   * boolean — when neither side sets it the field stays `undefined`, and
   * the gate resolver (`isVerificationEnforced`) falls back to the
   * `fin-` / `acme-` name-prefix default.
   *
   * Optional at the type level for back-compat with the ~30 inline
   * `ResolvedAgentConfig` test factories that don't go through the
   * resolver. Same precedent as `vision`, `llmRuntime`, `providers`.
   *
   * RELOADABLE — the daemon `verificationOverride` DI closure
   * reads the live resolved config on every gate evaluation (per-turn),
   * NOT at agent spawn. Deliberately absent from `NON_RELOADABLE_FIELDS`.
   */
  readonly verification?: {
    readonly enforced?: boolean;
    /** 2026-07-31 adaptive verify budget — see financial-verification-gate.ts. */
    readonly maxVerifyHops?: number;
    readonly skipIfTurnMsOver?: number;
    readonly shrinkIfTurnMsOver?: number;
    readonly deferMs?: number;
    /** 999.63b — rule-claim class knobs (shadow-by-default). */
    readonly ruleClaims?: {
      readonly enabled?: boolean;
      readonly maxVerifyHops?: number;
    };
    /** C — pre-delivery hold mode (off-by-default; see gate defaults). */
    readonly holdDelivery?: boolean;
    readonly holdTimeoutMs?: number;
    /** 999.63d/6 — which vocabulary decides a turn is worth narrating. */
    readonly topic?: {
      readonly profile?: "finance" | "legal" | "none";
      readonly extraTerms?: readonly string[];
    };
    /** 999.63d — verified-streaming UX knobs (all off-by-default). */
    readonly ux?: {
      readonly streamStatus?: boolean;
      /** 999.63d/5 — WHEN the trail arms. Default "auto". */
      readonly streamStatusMode?: "always" | "topic" | "auto";
      /** 2026-08-27 — short pre-answer fragments become trail lines. */
      readonly narrationAsTrail?: boolean;
      readonly sourcesFooter?: "off" | "claims" | "always";
      readonly verdictReactions?: boolean;
      readonly modelSourcesLine?: "keep" | "strip" | "flag";
      readonly ledgerButton?: boolean;
      readonly ledgerReaction?: string;
      readonly liveClaims?: boolean;
  readonly statusMessage?: "inline" | "separate";
      readonly unverifiedNotice?: boolean;
      readonly compactBelowChars?: number;
      readonly sourcesCharBudget?: number;
      readonly pendingMarker?: boolean;
      readonly verifiedBadge?: boolean;
    };
  };
  /**
   * Phase 137 Plan 04 — per-provider credentials surface.
   *
   * Populated by the loader cascade resolver:
   *   `agent.providers?.openai?.apiKeyPath ?? defaults.providers?.openai?.apiKeyPath`
   *
   * Optional at the type level for back-compat with existing
   * ResolvedAgentConfig test factories that don't go through the
   * resolver. Same precedent as `vision`, `llmRuntime` (Phase 113 /
   * 136). Downstream consumer
   * (`OpenAiCredentialsResolver` at
   * `src/llm-runtime/credentials/openai-credentials.ts`) reads via
   * `config.providers?.openai?.apiKeyPath` so a missing block resolves
   * to a `OpenAiCredentialsMissingError` on first turn (lazy fail —
   * boot stays non-blocking for non-codex-cli agents).
   *
   * RELOADABLE — see `src/config/types.ts` RELOADABLE_FIELDS. Operators
   * rotate the key at runtime via clawcode.yaml edits; ConfigWatcher
   * invalidates the per-agent OpenAiCredentialsResolver cache so the
   * next turn re-resolves.
   */
  readonly providers?: {
    readonly openai?: {
      /**
       * Either an `op://example-vault/item/field` URI (resolved via
       * SecretsResolver) or a plaintext `sk-...` value. The
       * `OpenAiCredentialsResolver` dispatches on `value.startsWith
       * ("op://")` — anything else is treated as plaintext and
       * returned verbatim.
       */
      readonly apiKeyPath?: string;
      /**
       * Phase 138 D6 — per-provider daily cost cap in USD. Loader
       * cascade: `agent.providers?.openai?.dailyCapUsd ??
       * defaults.providers?.openai?.dailyCapUsd`. The consumer
       * (Plans 02-04) applies `?? DEFAULT_DAILY_CAP_USD` from
       * `src/usage/provider-usage-tracker.ts` — a missing field stays
       * distinguishable from an explicit cap. RELOADABLE.
       */
      readonly dailyCapUsd?: number;
    };
    /**
     * Phase 138 D6 — Anthropic per-provider block. No `apiKeyPath`:
     * Anthropic auth uses OAuth bearer tokens from the claude-cli
     * login flow, not clawcode.yaml. Cost cap only.
     */
    readonly anthropic?: {
      /** Phase 138 D6 — per-provider daily cost cap in USD. RELOADABLE. */
      readonly dailyCapUsd?: number;
    };
  };
  /**
   * Phase 135 Plan 02 — per-agent voice config (Discord voice channels).
   *
   * Optional: voice is opt-in per CONTEXT.md ("missing block = no
   * voice for that agent"). When set, `voice.channelId` triggers
   * auto-join on bridge `ready` / `resumed`. `voice.deepgramKey` and
   * `voice.elevenLabsKey` are pre-resolved by the Zone 5 walker in
   * `secrets-collector.ts` before this ResolvedAgentConfig lands.
   *
   * Mirrors the `voiceConfigSchema` shape from `src/config/schema.ts`.
   * Importing the zod-inferred type here keeps the resolved type in
   * lockstep with the schema source-of-truth.
   *
   * **NON_RELOADABLE** — joining/leaving voice has side effects (audio
   * resources, Deepgram WS) that don't compose with hot-swap. Listed
   * in `NON_RELOADABLE_FIELDS` from Plan 01; YAML edits take effect on
   * the next daemon restart.
   */
  readonly voice?: import("../config/schema.js").VoiceConfig;
};

/**
 * Phase 88 MKT-02 + Phase 90 Plan 04 HUB-01 — resolved marketplace source
 * entry (post-expandHome). Discriminated union covering both legacy
 * filesystem sources and ClawHub registry sources.
 *
 * Legacy branch: `kind: "legacy"` — path already expandHome'd. Mirrors the
 * Phase 88 shape (label optional) and is produced from the raw path-only
 * zod variant of marketplaceSources.
 *
 * ClawHub branch: `kind: "clawhub"` — baseUrl + optional authToken/
 * cacheTtlMs pass through verbatim. `authToken` may be a literal or an
 * `op://` reference; downstream consumers decide whether to resolve it.
 */
export type ResolvedMarketplaceSource =
  | Readonly<{
      kind: "legacy";
      path: string;
      label?: string;
    }>
  | Readonly<{
      kind: "clawhub";
      baseUrl: string;
      authToken?: string;
      cacheTtlMs?: number;
    }>;

export type ResolvedMarketplaceSources = readonly ResolvedMarketplaceSource[];

/**
 * Result of creating or verifying a workspace directory.
 */
export type WorkspaceResult = {
  readonly agentName: string;
  readonly path: string;
  readonly created: boolean;
  readonly filesWritten: readonly string[];
};
