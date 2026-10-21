import type { SandboxBindPlan } from "./bwrap-sandbox.js";
import type { ConfigModel } from "../shared/model-catalog.js";

/**
 * Agent lifecycle status — represents the state machine for each agent.
 * Transitions: stopped -> starting -> running -> stopping -> stopped
 * Error path: running -> crashed -> restarting -> starting
 * Terminal: crashed -> failed (after max retries)
 */
export type AgentStatus =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "crashed"
  | "restarting"
  | "failed";

/**
 * A single agent's entry in the persistent registry.
 * All fields are readonly — updates produce new objects.
 */
export type RegistryEntry = {
  readonly name: string;
  readonly status: AgentStatus;
  readonly sessionId: string | null;
  readonly startedAt: number | null;
  readonly restartCount: number;
  readonly consecutiveFailures: number;
  readonly lastError: string | null;
  readonly lastStableAt: number | null;
  /**
   * Phase 56 Plan 01 — warm-path readiness flag. Flips to `true` after
   * `runWarmPathCheck` succeeds for this agent (wired in Plan 02).
   *
   * OPTIONAL for backward compatibility: entries persisted before Phase 56
   * lack this field. Consumers MUST treat `undefined` as "not ready" and
   * re-run the warm-path check on next startup.
   */
  readonly warm_path_ready?: boolean;
  /**
   * Phase 56 Plan 01 — total warm-path duration in milliseconds for this
   * agent's last successful readiness check. `null` while the check is
   * pending; a number after success. `undefined` on pre-Phase-56 entries.
   */
  readonly warm_path_readiness_ms?: number | null;
  /**
   * Timestamp (ms since epoch) when the entry most recently transitioned to
   * status="stopped" via stopAgent. Consumed by `reconcileRegistry` to TTL-prune
   * subagent / thread-session "gravestones" so the registry does not grow
   * unboundedly.
   *
   * OPTIONAL for backward compatibility: entries persisted before the
   * clawdy-v2-stability fix (2026-04-19) lack this field. The reap path treats
   * `undefined` as "stopped long ago" → eligible for immediate prune on first
   * boot (one-time cleanup of legacy zombies).
   */
  readonly stoppedAt?: number | null;
};

/**
 * The full registry — an immutable collection of agent entries.
 */
export type Registry = {
  readonly entries: readonly RegistryEntry[];
  readonly updatedAt: number;
};

/**
 * Configuration for the exponential backoff calculator.
 */
export type BackoffConfig = {
  readonly baseMs: number;
  readonly maxMs: number;
  readonly maxRetries: number;
  readonly stableAfterMs: number;
};

/**
 * Configuration passed to the SessionAdapter when creating a session.
 *
 * Phase 52 Plan 02:
 *   - `systemPrompt` now carries ONLY the STABLE PREFIX (identity + stable
 *     hot-tier + tool definitions). The SDK adapter wraps it in
 *     `{ type: "preset", preset: "claude_code", append: systemPrompt }` so
 *     the preset's cache scaffolding kicks in.
 *   - `mutableSuffix` is NEW — per-turn block (discord bindings, context
 *     summary, and hot-tier when composition just drifted) that the adapter
 *     prepends to the user message, sitting OUTSIDE the cached block.
 *   - `hotStableToken` is NEW — sha256 of the hot-tier signature THIS turn,
 *     carried forward by SessionManager for next-turn comparison so
 *     hot-tier enters/exits the cacheable block without thrashing.
 */
export type AgentSessionConfig = {
  readonly name: string;
  // Phase 999.98 — Category A executor path: widened to include "fable" and the
  // four `<family>@latest` opt-in literals (D11). session-adapter.ts reads
  // `config.model` at the start (:1497) + resume (:1705) sites and PRE-RESOLVES
  // any `@latest` value to a concrete id (via `resolveLatestModel` over the
  // daemon catalog snapshot) BEFORE calling `resolveModelId` — `@latest` never
  // reaches the SDK boundary. This per-turn config type must admit the sugar so
  // it can flow from the resolved config to the adapter pre-resolve.
  readonly model: ConfigModel;
  // Mirrors `effortSchema` in config/schema.ts and ResolvedAgentConfig.effort
  // — the canonical 8-value union. Was previously narrowed to 4 values which
  // diverged from the schema after `xhigh`/`auto`/`off` were added.
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
   * Quick 260715-j1j (D5/D11) — per-agent native-Workflow opt-in, threaded
   * from ResolvedAgentConfig by buildSessionConfig (spread-conditional —
   * OMITTED for the non-opted fleet, preserving byte-stable deep-equality
   * pins). Consumed by the workflow-steer conditionals (session-config.ts
   * v2 steer + the v3 channel-protocol prompt). Optional at this boundary
   * so existing AgentSessionConfig builders compile unchanged; consumers
   * gate on `=== true` (fail-closed).
   */
  readonly nativeWorkflow?: boolean;
  readonly workspace: string;
  readonly systemPrompt: string;
  readonly mutableSuffix?: string;
  readonly hotStableToken?: string;
  readonly channels: readonly string[];
  readonly contextSummary?: string;
  readonly mcpServers?: readonly {
    readonly name: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    /**
     * Phase 85 TOOL-01 — mirrors ResolvedAgentConfig.mcpServers[].optional.
     * Defaults to false (mandatory) at the config/loader layer.
     */
    readonly optional: boolean;
    /**
     * Phase 999.54 (D-01a) — mirrors ResolvedAgentConfig.mcpServers[].alwaysLoad.
     * This field is the actual contract for what reaches transformMcpServersForSdk
     * (session-adapter.ts:1317). Without this widening here, the transform
     * function's inline param type silently strips the field (RESEARCH.md Pitfall 2).
     */
    readonly alwaysLoad?: boolean;
  }[];
  /**
   * Phase 100 GSD-02 — per-agent SDK settingSources passthrough. When omitted
   * (existing fleet, all 15+ agents), session-adapter applies the
   * ['project'] default at lines 592/631. When set (Admin Clawdy + future
   * GSD-enabled agents), passes through verbatim. Mirrors
   * ResolvedAgentConfig.settingSources but stays optional at this boundary
   * so existing call sites that build AgentSessionConfig don't need updates
   * until they choose to opt in. See RESEARCH.md Architecture Pattern 5.
   */
  readonly settingSources?: readonly ("project" | "user" | "local")[];
  /**
   * 999.103 WS-2 follow-up — per-agent native Claude Code plugin refs
   * (`<plugin>@<marketplace>`), resolved to local install paths at spawn by
   * session-adapter.resolveSdkPlugins. Optional at this boundary; propagated
   * from ResolvedAgentConfig.plugins by buildSessionConfig.
   */
  readonly plugins?: readonly string[];
  /**
   * Phase 100 GSD-04 — per-agent gsd block. UNDEFINED when not set (existing
   * fleet). When set, session-adapter uses gsd.projectDir as the SDK cwd
   * instead of config.workspace at lines 588/627. Mirrors
   * ResolvedAgentConfig.gsd verbatim.
   */
  readonly gsd?: { readonly projectDir: string };
  /**
   * Phase 99 sub-scope N (2026-04-26) — SDK-level deny-list. When set, the
   * LLM physically cannot invoke any tool whose name matches an entry. Used
   * for the subagent recursion guard: subagent sessions disallow
   * `mcp__clawcode__spawn_subagent_thread` so they cannot chain further
   * subagents (subagents inherit the parent's "delegate, don't execute"
   * soul and would otherwise loop indefinitely). Forwarded verbatim into
   * the SDK's `disallowedTools` option in both `createSession` and
   * `resumeSession` (symmetric-edits Rule 3). Empty/undefined → omitted
   * from baseOptions so the existing 15+ agent fleet is unaffected.
   */
  readonly disallowedTools?: readonly string[];
  /**
   * Phase 115 sub-scope 14 — operator-toggle for the diagnostic baseopts
   * dump. UNDEFINED for the existing fleet (no behavior change). When set,
   * `dumpBaseOptionsOnSpawn === true` enables the per-agent baseopts dump
   * to ~/.clawcode/agents/<agent>/diagnostics/baseopts-<flow>-<ts>.json on
   * every createSession/resumeSession (secrets redacted via redactSecrets
   * in session-adapter.ts). Replaces the temporary hardcoded fin-client
   * + Admin Clawdy allowlist. Mirrors `ResolvedAgentConfig.debug` verbatim
   * but stays optional at this boundary so existing call sites that build
   * AgentSessionConfig don't need updates until they choose to opt in.
   */
  readonly debug?: {
    readonly dumpBaseOptionsOnSpawn: boolean;
  };
  /**
   * Phase 115 sub-scope 2 — operator-toggle for the SDK
   * `systemPrompt.excludeDynamicSections` flag. UNDEFINED for legacy call
   * sites; when set, session-adapter passes it through verbatim to the SDK.
   * Down-stream of buildSessionConfig which resolves it from
   * ResolvedAgentConfig (always populated, default true). Stays optional
   * here for back-compat with existing AgentSessionConfig builders (e.g. the
   * bootstrap path in session-config.ts which has a different return shape).
   */
  readonly excludeDynamicSections?: boolean;
  /**
   * Phase 117 Plan 04 T05 — native advisor model passthrough.
   *
   * When SET, the SDK adapter spread-conditionally adds
   * `advisorModel: <value>` to the `Options` object handed to
   * `sdk.query`, enabling the `advisor_20260301` server tool inside
   * the agent's own turn (the bundled `claude` CLI binary handles the
   * `advisor-tool-2026-03-01` beta header injection automatically per
   * RESEARCH §6 Pitfall 2).
   *
   * When UNDEFINED, the adapter OMITS the field entirely (NEVER
   * passes `{advisorModel: undefined}` — the spread-conditional idiom
   * preserves byte-stable equality and avoids implicit-undefined
   * surprises per RESEARCH §6 Pitfall 3).
   *
   * Value is the SDK-canonical model id (e.g. `"claude-opus-4-8"`),
   * already resolved through the alias map in
   * `src/manager/model-resolver.ts` before reaching this field. Raw
   * operator aliases (`"opus"`) are NEVER written here.
   *
   * The gate that decides set-vs-omit lives in
   * `src/manager/session-config.ts:shouldEnableAdvisor` and evaluates
   * `(a) backend === "native"` AND `(b) AdvisorBudget.canCall(agent)`.
   * Both conditions must pass per RESEARCH §6 Pitfall 4 + §13.5.
   */
  readonly advisorModel?: string;
  /**
   * Phase 127 — stream-stall supervisor threshold (ms). When set, the SDK
   * adapter (session-adapter.ts createSession/resumeSession) threads it
   * into the per-handle baseOptions as an adapter-only field; the
   * persistent-session-handle iteration loop constructs one
   * `createStreamStallTracker` per turn that aborts the in-flight query
   * when `Date.now() - lastUsefulTokenAt > streamStallTimeoutMs`.
   *
   * UNDEFINED for legacy call sites; consumers default to 180_000ms
   * (matches `defaults.streamStallTimeoutMs`). Populated by
   * `session-config.ts:buildSessionConfig` from
   * `ResolvedAgentConfig.streamStallTimeoutMs` (loader cascade).
   *
   * Optional at this boundary mirrors the
   * `memoryRetrievalTokenBudget?: number` precedent — back-compat with
   * existing AgentSessionConfig builders (the bootstrap path has a
   * different return shape).
   */
  readonly streamStallTimeoutMs?: number;
  /**
   * Phase 145 WS2 — absolute turn-duration ceiling (ms). When set, the SDK
   * adapter (session-adapter.ts createSession/resumeSession) threads it into
   * the per-handle baseOptions as an adapter-only (handle-only) field, and
   * the persistent-session-handle iteration loop reads it (Plan 03) to
   * override the tracker's 20-min DEFAULT_MAX_TURN_DURATION_MS for
   * long-running background workers (WS2).
   *
   * UNDEFINED for legacy call sites; consumers default to
   * DEFAULT_MAX_TURN_DURATION_MS (20 min). Populated by
   * `session-config.ts:buildSessionConfig` from
   * `ResolvedAgentConfig.maxTurnDurationMs` (loader cascade). Optional at this
   * boundary mirrors the `streamStallTimeoutMs?: number` precedent above —
   * back-compat with existing AgentSessionConfig builders.
   */
  readonly maxTurnDurationMs?: number;
  /**
   * Phase 145 WS1 — subagent permission-hook gate. When true, the SDK
   * adapter (Plan 02) registers a deterministic PreToolUse hook that makes
   * in-process Workflow/Agent subagents non-interactive (auto-allow the
   * working tool set, auto-deny the prompting WebFetch tool) so a headless
   * subagent never hangs on a permission prompt. Populated by
   * `buildSessionConfig` from `ResolvedAgentConfig.subagentPermissionGate`
   * (loader cascade, default false). UNDEFINED/false for the existing fleet
   * keeps it byte-identical (no hook registered). Plan 01 declares the field;
   * Plan 02 reads it at the hook-registration site.
   */
  readonly subagentPermissionGate?: boolean;
  /**
   * Cross-owner FS guard (2026-06-27) — absolute cross-owner agent-dir prefixes
   * this session's file tools must not touch. Threaded from
   * ResolvedAgentConfig.crossOwnerForbiddenPaths; session-adapter registers the
   * PreToolUse owner-FS-guard hook when non-empty. Omitted for untenanted/admin
   * agents (byte-identical bag, no hook).
   */
  readonly crossOwnerForbiddenPaths?: readonly string[];
  /**
   * claude.ai connector entitlement (from ResolvedAgentConfig). `true` →
   * `buildCleanEnv` sets `ENABLE_CLAUDEAI_MCP_SERVERS=true`; omitted → the
   * forced `false`. NON_RELOADABLE (spawn env).
   */
  readonly claudeAiConnectors?: true;
  /**
   * Phase 127 — operator-injected callback fired on stall trip. Receives
   * the structured payload (lastUsefulTokenAgeMs, thresholdMs) that the
   * production wiring also emits via `phase127-stream-stall` log. The
   * daemon-side wiring (Plan 02) hangs Discord notification + session-log
   * persistence on this hook; Plan 01 keeps the field type-level only so
   * the chokepoint is testable in isolation.
   *
   * UNDEFINED in this plan — Plan 02 wires the daemon-side
   * implementation. Production code MUST handle undefined gracefully:
   * the tracker still emits `phase127-stream-stall` to console.info AND
   * still aborts the SDK query via the per-handle AbortController, so
   * the protective behavior works in Plan 01 even before Plan 02 lands
   * the side-effect surface.
   */
  readonly onStreamStall?: (payload: {
    readonly lastUsefulTokenAgeMs: number;
    readonly thresholdMs: number;
  }) => void;
  /**
   * WS-1 (999.99 structural delivery) — turn-attributed stream consumption
   * gate. When true, the SDK adapter threads it into the per-handle
   * baseOptions (handle-only, stripped before sdk.query) and
   * persistent-session-handle wraps each epoch's driver iterator in an
   * `AttributedStreamDemux`: self-fired turns (Monitor / background
   * Bash / background Agent task-notifications) deliver their output via
   * `onOrphanTurnOutput` the moment they complete instead of buffering
   * into the next inbound reply (the 2026-07-15/16 off-by-N incident).
   *
   * UNDEFINED/false → legacy consumption, byte-identical fleet behavior.
   * Populated by `buildSessionConfig` from
   * `ResolvedAgentConfig.deliveryAttributedStream` (loader cascade,
   * default false — canary-first rollout).
   */
  readonly attributedStream?: boolean;
  /**
   * WS-1 — delivery sink for orphan (self-fired) turn output. Only
   * meaningful when `attributedStream` is true. Populated by
   * `buildSessionConfig` via the SessionManager-supplied factory (mirrors
   * the `onStreamStall` factory pattern); fire-and-forget — the demux
   * guards the call, a throwing sink is warn-logged and dropped.
   */
  readonly onOrphanTurnOutput?: (payload: {
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

  /**
   * Per-agent OS-sandbox (bubblewrap) bind-plan. Present ONLY for non-admin
   * agents with `sandbox.enabled: true`; omitted (undefined) otherwise so the
   * non-sandboxed fleet's config is byte-identical. Computed in
   * `buildSessionConfig` (NON_RELOADABLE), carried as a handle-only field
   * through `AdapterBaseOptions` → `makeDetachedSpawn`, and stripped before
   * the bag reaches `sdk.query`. See `src/manager/bwrap-sandbox.ts`. Named
   * `sandboxPlan` (not `sandbox`) to avoid colliding with the
   * `ResolvedAgentConfig.sandbox` config toggle when the two are spread
   * together (e.g. `cli/commands/run.ts`).
   */
  readonly sandboxPlan?: SandboxBindPlan;

  /** Phase 999.162 — per-agent `ENABLE_TOOL_SEARCH` for the spawned CLI (see agentSchema.toolSearch). */
  readonly toolSearch?: string;
  /**
   * Phase 999.171 — per-agent UX toggles, threaded for the session-start
   * consumers in 999.172 (prompt suggestions) and 999.173 (research
   * subagents). OMITTED when every flag is false (byte-stable config for the
   * rest of the fleet). Frozen at session start: live-thinking rendering
   * reads the live resolved config instead, so it stays hot-reloadable.
   */
  readonly uxFeatures?: Readonly<{
    liveThinking: boolean;
    statusPing: boolean;
    promptSuggestions: boolean;
    researchSubagents: boolean;
  }>;
  /**
   * Phase 999.173 — present ONLY when research subagents are on for this
   * session (override-resolved toggle + attributed stream + operator agent;
   * see research-subagents.ts). Drives the `agents.researcher` SDK options,
   * the launch-gate hook and the handle's research tracker. Omitted otherwise
   * so the rest of the fleet stays byte-identical.
   */
  readonly researchSubagents?: import("./research-subagents.js").ResearchSessionConfig;

};

/**
 * Default backoff configuration per D-12, D-13, D-14:
 * - 1s base delay
 * - 5 minute cap
 * - 10 max retries
 * - 5 minute stability window
 */
export const DEFAULT_BACKOFF_CONFIG: BackoffConfig = {
  baseMs: 1_000,
  maxMs: 300_000,
  maxRetries: 10,
  stableAfterMs: 300_000,
} as const;
