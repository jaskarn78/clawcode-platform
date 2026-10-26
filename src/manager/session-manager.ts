import { EventEmitter } from "node:events";
import type { SendImageInput } from "./session-adapter.js";
import { logger } from "../shared/logger.js";
import { SessionError } from "../shared/errors.js";
// Phase 999.114 — catalog-derived alias type + the shipped picker default.
import { type ConfigModel } from "../shared/model-catalog.js";
import { DEFAULT_PICKER_MODELS } from "../shared/model-catalog.js";
// P3 (memory program) — spawn admission gate + class helper.
import { spawnClassOf, type SpawnGovernor } from "./spawn-governor.js";
// FIND-123-A.next T-04 — /proc-walk PID discovery removed in favor of
// handle.getClaudePid() (sink populated by makeDetachedSpawn). Only the
// MCP-children walk remains; discoverClaudeSubprocessPid stays exported
// from proc-scan.ts because the periodic reconciler (recovery path) at
// src/mcp/reconciler.ts still needs it for stale-claude rediscovery.
import { discoverAgentMcpPids } from "../mcp/proc-scan.js";

/**
 * Phase 999.15 TRACK-02 — polled discovery budget for the agent.start MCP
 * registration path. Replaces the prior fixed 1s settle window (which the
 * 2026-04-30 deploy on clawdy revealed captures the dying first-PID when
 * the SDK respawns claude during warmup).
 *
 * Total wall-clock budget = MAX_ATTEMPTS × INTERVAL = 30s. After that, the
 * polled loop logs a warn and exits — the 60s reaper-tick reconciler
 * (Plan 02 TRACK-01) catches up on the next tick.
 *
 * MIN_AGE_SEC = 5 → discoverClaudeSubprocessPid filters candidates younger
 * than 5s, so the dying-first-PID (typically dies within 2-3s) is excluded.
 */
// Exported so the orphan-claude-reaper structural-invariant test can pin
// `schemaDefault.minAgeSeconds >= MCP_POLL_INTERVAL_MS * MCP_POLL_MAX_ATTEMPTS / 1000 * safetyMultiplier`.
// Without this link, the two timing constants drift independently and
// regress the polled-discovery race that Phase 109-B keeps reintroducing.
export const MCP_POLL_INTERVAL_MS = 5000;
export const MCP_POLL_MAX_ATTEMPTS = 6;
export const MCP_POLL_MIN_AGE_SEC = 5;

/**
 * Phase 999.15 TRACK-02 — fake-timer-friendly sleep helper. Uses setTimeout
 * (NOT Promise.resolve().then) so vi.useFakeTimers + vi.advanceTimersByTimeAsync
 * drive the polled-discovery loop deterministically in SM-1..SM-4.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
import type { SessionAdapter, SessionHandle } from "./session-adapter.js";
// Phase 115 sub-scope 13(a) — `prompt-bloat-suspected` classifier.
// Pure function; runs inside the agent crash handler when the SDK error
// matches `invalid_request_error` AND the latest stable prefix exceeds
// the threshold (initial 20K chars, may be tuned per 115-08).
import { classifyPromptBloat } from "./session-adapter.js";
import type { BackoffConfig } from "./types.js";
import { DEFAULT_BACKOFF_CONFIG } from "./types.js";
import { readRegistry, updateEntry, createEntry, mutateRegistry } from "./registry.js";
import type { ResolvedAgentConfig } from "../shared/types.js";
import type { EffortLevel } from "../config/schema.js";
import type { Logger } from "pino";
import type { SkillsCatalog } from "../skills/types.js";
import type { MemoryStore } from "../memory/store.js";
import type { EmbeddingService } from "../memory/embedder.js";
import type { SessionLogger } from "../memory/session-log.js";
import type {
  CompactionManager,
  CharacterCountFillProvider,
  CompactionResult,
  ConversationTurn,
} from "../memory/compaction.js";
import type { TierManager } from "../memory/tier-manager.js";
import { buildForkName, buildForkConfig } from "./fork.js";
import type { ForkOptions, ForkResult } from "./fork.js";
import type { UsageTracker } from "../usage/tracker.js";
import { RateLimitTracker } from "../usage/rate-limit-tracker.js";
// Phase 138 Plan 01 T-04 — per-provider credit telemetry + phase138-usage hook.
import { ProviderUsageTracker } from "../usage/provider-usage-tracker.js";
import { buildProviderUsageHook } from "../usage/provider-usage-hook.js";
import type { DocumentStore } from "../documents/store.js";
import type { TraceStore } from "../performance/trace-store.js";
import {
  getTrajectoryForTurnId as getTrajectoryForTurnIdHelper,
  getTrajectoryForSubagent as getTrajectoryForSubagentHelper,
  type TurnTrajectoryView,
} from "./session-manager-trajectory.js";
import type { TraceCollector, Turn } from "../performance/trace-collector.js";
import type { ConversationStore } from "../memory/conversation-store.js";
import { summarizeSession, flushSessionMidway } from "../memory/session-summarizer.js";
import type { SummarizeFn } from "../memory/session-summarizer.types.js";
import { summarizeWithHaiku } from "./summarize-with-haiku.js";
import { AgentMemoryManager } from "./session-memory.js";
import { SessionRecoveryManager } from "./session-recovery.js";
import type { CrashAlertPayload } from "./session-recovery.js";
import { buildSessionConfig } from "./session-config.js";
// OpenAI VOICE route — full-but-lean session base-options (opt-in per agent).
import type { SdkQueryOptions } from "./sdk-types.js";
import {
  isVoiceEnabled,
  applyVoiceOverrides,
  mapSessionConfigToVoiceBaseOptions,
} from "./voice-session-base-options.js";
import { makeStreamStallCallback } from "./stream-stall-callback.js";
// WS-1 (999.99 structural delivery) — orphan-output delivery factory.
import { makeOrphanDeliveryCallback } from "./orphan-delivery-callback.js";
import type { UnloadedSkillEntry } from "./skill-loader.js";
import { detectBootstrapNeeded } from "../bootstrap/detector.js";
import { computePrefixHash } from "./context-assembler.js";
import { SkillUsageTracker } from "../usage/skill-usage-tracker.js";
import type { SkillTrackingConfig } from "./session-adapter.js";
// 999.105 — runtime output-style overrides (Route O overlay).
import {
  readStyleState,
  writeStyleState,
  clearStyleState,
  DEFAULT_STYLE_STATE_PATH,
} from "./output-styles/style-state-store.js";
import type { OutputStyleId } from "./output-styles/roster.js";
import { outputStyleSchema } from "../config/schema.js";
// Phase 117 Plan 04 T03/T04/T05 — AdvisorBudget DI + observer wiring.
import type { AdvisorBudget } from "../usage/advisor-budget.js";
import type { AdvisorObserverConfig } from "./session-adapter.js";
import { runWarmPathCheck, WARM_PATH_TIMEOUT_MS, type WarmPathDurations } from "./warm-path-check.js";
import {
  performMcpReadinessHandshake,
  MCP_HANDSHAKE_TIMEOUT_WARMPATH_MS,
  type McpReadinessReport,
  type McpServerState,
} from "../mcp/readiness.js";
// Phase 999.27 — broker-pooled MCP detection (skip per-agent probes for
// 1password broker shim; broker has its own heartbeat).
import { filterOutBrokerPooled } from "../mcp/broker-shim-detect.js";
import { ConversationBriefCache } from "./conversation-brief-cache.js";
import {
  readEffortState,
  writeEffortState,
  DEFAULT_EFFORT_STATE_PATH,
} from "./effort-state-store.js";
import { resolveModelId } from "./model-resolver.js";
import { ModelNotAllowedError, UltracodeNotAllowedError } from "./model-errors.js";
import { checkUltracodeEligibility } from "./ultracode-gate.js";
import type { PermissionMode } from "./sdk-types.js";
import type { WebhookManager } from "../discord/webhook-manager.js";
import { sendRestartGreeting, classifyRestart } from "./restart-greeting.js";
import type { MemoryScanner } from "../memory/memory-scanner.js";
import {
  retrieveMemoryChunks,
  type MemoryRetrievalResult,
} from "../memory/memory-retrieval.js";
import { MemoryFlushTimer } from "../memory/memory-flush.js";
import { resolveMemoryRoots } from "../memory/memory-roots.js";
import { dirname as pathDirname } from "node:path";
import { ownerFactsAsChunks, type SharedFactsStore } from "../memory/shared-facts-store.js";

/** Configuration for creating a SessionManager. */
export type SessionManagerOptions = {
  readonly adapter: SessionAdapter;
  readonly registryPath: string;
  readonly backoffConfig?: BackoffConfig;
  readonly log?: Logger;
  /**
   * P3 (memory program) — class-aware spawn admission gate. Optional
   * (tests/CLI run ungoverned); production wires the daemon-constructed
   * SpawnGovernor. Acquired at startAgentCore entry, released when the
   * spawn attempt settles.
   */
  readonly spawnGovernor?: SpawnGovernor;
  /**
   * Phase 66 -- test-only override for the Haiku summarize function.
   * Production leaves this undefined; the constructor defaults to
   * summarizeWithHaiku so integration tests can inject a mock.
   */
  readonly summarizeFn?: SummarizeFn;
  /**
   * Gap 3 (memory-persistence-gaps) -- test-only override that bypasses the
   * minutes→ms conversion for the periodic mid-session flush timer. When set
   * to a positive number, the flush timer fires every `flushIntervalMsOverride`
   * milliseconds regardless of the per-agent config value. Used to keep the
   * Gap 3 integration tests fast (real-timer-based). Production leaves this
   * undefined so the agent-level knob controls the interval.
   */
  readonly flushIntervalMsOverride?: number;
  /**
   * Phase 83 Plan 02 EFFORT-03 — path to the per-agent runtime effort-state
   * JSON store. Defaults to `~/.clawcode/manager/effort-state.json`. Tests
   * inject a tmpdir-rooted path for isolation.
   */
  readonly effortStatePath?: string;
  /** 999.105 — override the style-state path (tests). */
  readonly styleStatePath?: string;
  /**
   * Phase 100 follow-up — per-agent MCP env override resolver wiring.
   *
   * When set, SessionManager threads this through SessionConfigDeps so
   * buildSessionConfig can substitute `op://...` URIs in
   * `ResolvedAgentConfig.mcpEnvOverrides` with concrete vault-scoped tokens
   * BEFORE the SDK adapter spawns the MCP subprocess. Production daemon
   * wires this to `resolveMcpEnvOverrides + defaultOpReadShellOut`. Tests
   * leave it undefined → mcpEnvOverrides is silently skipped (back-compat).
   *
   * The agentName argument is provided for audit-log correlation; the
   * resolver itself is stateless across calls.
   */
  readonly opEnvResolver?: (
    overrides: Record<string, Record<string, string>>,
    agentName: string,
  ) => Promise<Record<string, Record<string, string>>>;
  /**
   * Phase 999.14 MCP-01 — daemon-wide MCP child process tracker. When set,
   * SessionManager.startAgent discovers the agent's claude subprocess PID
   * via /proc walk (after a settle window), enumerates MCP child PIDs of
   * that claude PID, and registers them in the tracker. stopAgent unregisters.
   *
   * Optional: tests / non-Linux paths leave it undefined; SessionManager
   * skips MCP lifecycle work entirely (back-compat with pre-Phase-999.14
   * test fixtures).
   */
  readonly mcpTracker?: import("../mcp/process-tracker.js").McpProcessTracker | null;

  /**
   * Phase 999.15 TRACK-02 — cached at daemon boot via readBootTimeUnix() /
   * readClockTicksPerSec() and passed through so the polled-discovery loop
   * can hand them to discoverClaudeSubprocessPid({ minAge: 5, ... })
   * without re-reading /proc/stat per call.
   *
   * Optional: tests mock discoverClaudeSubprocessPid directly and don't
   * exercise the age-filter math; production daemon ALWAYS supplies these
   * when mcpTracker is set.
   */
  readonly mcpBootTimeUnix?: number;
  readonly mcpClockTicksPerSec?: number;

  /**
   * Quick task 260521-5gh Gap 2 — optional crash-alert DI hook, threaded
   * straight into SessionRecoveryManager. Fired on every crash
   * (`terminal: false`) and on the terminal `failed` transition
   * (`terminal: true`). Production daemon wires this to a closure that posts
   * a Discord crash alert via `bridge.sendCrashAlert`; tests omit it
   * (back-compat). A throwing hook is swallowed inside the recovery manager.
   */
  readonly onCrashAlert?: (payload: CrashAlertPayload) => void;
};

/**
 * Manages agent session lifecycles: start, stop, restart, crash recovery.
 * Composes AgentMemoryManager, SessionRecoveryManager, and buildSessionConfig.
 */
export class SessionManager {
  private readonly adapter: SessionAdapter;
  private readonly registryPath: string;
  private readonly log: Logger;
  /** P3 — optional class-aware spawn admission gate (daemon-wired). */
  private readonly spawnGovernor: SpawnGovernor | undefined;
  private readonly sessions: Map<string, SessionHandle> = new Map();
  /**
   * Per-agent lifecycle serialization. start/stop/restart/performRestart for
   * a SINGLE agent must never run concurrently: they all mutate the same
   * memory-store maps and share one better-sqlite3 connection, which is
   * CLOSED by stopAgent→cleanupMemory. Before this lock, a reload/manual
   * `restartAgent` (its stopAgent closing the store) could race a crash-timer
   * `performRestart` (its startAgent reading the store), so the in-flight
   * start landed on a closed connection — "The database connection is not
   * open" — and the per-agent restart failed, requiring a full daemon
   * restart to recover. Each entry is the tail of that agent's op chain;
   * `withLifecycleLock` queues the next op behind it. Pruned when idle.
   */
  private readonly lifecycleChains: Map<string, Promise<unknown>> = new Map();
  private readonly configs: Map<string, ResolvedAgentConfig> = new Map();
  private readonly memory: AgentMemoryManager;
  /**
   * Phase 999.131 — owner-scoped shared facts (one fleet store, keyed by
   * owner). Set by the daemon at boot; absent in tests and standalone.
   */
  private sharedFactsStore: SharedFactsStore | undefined;
  private readonly recovery: SessionRecoveryManager;
  private readonly sessionEndCallbacks: Map<string, () => Promise<void>> = new Map();
  /** Phase 65 -- tracks the active ConversationStore session ID per agent. */
  private readonly activeConversationSessionIds: Map<string, string> = new Map();
  private skillsCatalog: SkillsCatalog = new Map();
  /**
   * Phase 130 Plan 02 — per-agent record of skills the manifest-loader
   * REFUSED at boot (status: refused-mcp-missing or parse-error). Plan 03
   * surfaces this map via Discord webhook batch (boot-time) and via
   * `clawcode skills <agent>` CLI table. Initialized empty; populated
   * by daemon at boot via `setUnloadedSkillsByAgent`.
   */
  private unloadedSkillsByAgent: ReadonlyMap<string, readonly UnloadedSkillEntry[]> = new Map();
  private allAgentConfigs: readonly ResolvedAgentConfig[] = [];
  /**
   * Phase 52 Plan 02 — per-agent prefixHash across turns.
   *
   * Keyed by agent name; value is the sha256 of the stable prefix assembled
   * for that agent's most recent turn. Updated from inside the adapter's
   * `prefixHashProvider.persist()` hook. Enables CACHE-04 eviction detection.
   */
  private readonly lastPrefixHashByAgent: Map<string, string> = new Map();
  /**
   * Phase 52 Plan 02 — per-agent hot-tier stable token across turns.
   *
   * Used by `buildSessionConfig` / `assembleContext` to decide hot-tier
   * placement (stable prefix vs mutable suffix) so a single hot-tier
   * mutation doesn't thrash the cache.
   */
  private readonly lastHotStableTokenByAgent: Map<string, string> = new Map();
  /**
   * Phase 52 Plan 02 — per-agent latest stablePrefix string.
   *
   * Stored at `buildSessionConfig` time (session start + hot-reload) so the
   * per-turn `prefixHashProvider` can compute `sha256(latest)` on every
   * iteration. Skills hot-reload updates this via `refreshStablePrefix`
   * which triggers a fresh `buildSessionConfig` run.
   */
  private readonly latestStablePrefixByAgent: Map<string, string> = new Map();

  /**
   * Phase 53 Plan 03 — shared in-memory skill-usage tracker across all
   * agents. Per-agent isolation happens INSIDE the tracker (keyed by
   * agent name). Capacity 20 matches Plan 53-01's default
   * `lazySkills.usageThresholdTurns` — operators can tune per-agent
   * thresholds downstream at the assembler; the tracker retains up to
   * 20 turns regardless.
   */
  private readonly skillUsageTracker: SkillUsageTracker = new SkillUsageTracker({
    capacity: 20,
  });

  /**
   * Phase 117 Plan 04 T02 — advisor consultation event bus.
   *
   * Per RESEARCH §13.10: `session-adapter.ts` emits two observational
   * events on this emitter when the Claude Agent SDK's native advisor
   * tool fires inside an agent's own turn (Plan 117-04 T03/T04 wires
   * the emitters at the per-assistant-message scan site and at the
   * terminal `result` event for budget accounting).
   *
   * Event shapes (see `src/advisor/types.ts`):
   *   - `"advisor:invoked"` payload: `AdvisorInvokedEvent`
   *     `{ agent, turnId, toolUseId }` — fires when the executor emits
   *     `server_tool_use{name:"advisor"}`. Discord bridge (Plan 117-09)
   *     listens to drop the 💭 reaction on the triggering message.
   *   - `"advisor:resulted"` payload: `AdvisorResultedEvent`
   *     `{ agent, turnId, toolUseId, kind, text?, errorCode? }` — fires
   *     when the matching `advisor_tool_result` block arrives in the
   *     same assistant message. `kind` distinguishes the three SDK
   *     terminal states (advisor_result / advisor_redacted_result /
   *     advisor_tool_result_error). Plan 117-09 uses this for the
   *     footer and `/verbose` inline display (Plan 117-11).
   *
   * Observational ONLY — listeners that throw must not break the
   * message path. `session-adapter.ts` wraps `emit()` in try/catch
   * (RESEARCH §6 Pitfall 1 + Pitfall 7 invariant).
   *
   * Lifetime: same as SessionManager instance. The emitter is
   * `public readonly` so DiscordBridge can subscribe directly through
   * its injected SessionManager reference (RESEARCH §13.10 — public
   * property is the simplest reachable surface).
   */
  public readonly advisorEvents: EventEmitter = new EventEmitter();

  /** Phase 73 Plan 02 — per-agent conversation-brief cache (LAT-02). */
  private readonly briefCache = new ConversationBriefCache();
  /**
   * Phase 66 -- production SummarizeFn (summarizeWithHaiku) with a test-only
   * injection hook. Passed into summarizeSession at session-boundary events.
   */
  private readonly summarizeFn: SummarizeFn;

  /**
   * Gap 3 (memory-persistence-gaps) -- test-only override for the flush
   * interval in milliseconds. When set, bypasses the per-agent
   * `flushIntervalMinutes` config so tests can exercise the timer path with
   * real timers in ~100ms instead of ~15min.
   */
  private readonly flushIntervalMsOverride: number | undefined;

  /**
   * Phase 83 Plan 02 EFFORT-03 — resolved path to the effort-state JSON
   * store. Set once at construction; all persistence / re-apply paths
   * reference this field so test-time paths and production defaults never
   * diverge.
   */
  private readonly effortStatePath: string;
  // 999.105 — per-agent runtime style overrides. Map is authoritative at
  // dispatch; style-state.json makes it survive restarts. No handle control
  // request exists for style (spike F1), so unlike effort this is PURELY
  // daemon-side state read by TurnDispatcher per turn.
  private readonly styleOverrides = new Map<string, OutputStyleId>();
  private readonly styleStatePath: string;

  /**
   * Phase 100 follow-up — per-agent MCP env override resolver. UNDEFINED in
   * tests (mcpEnvOverrides silently skipped). Production wires
   * resolveMcpEnvOverrides + defaultOpReadShellOut at the daemon edge.
   */
  private readonly opEnvResolver?: (
    overrides: Record<string, Record<string, string>>,
    agentName: string,
  ) => Promise<Record<string, Record<string, string>>>;

  /**
   * Phase 999.14 MCP-01 — daemon-wide MCP child process tracker. Optional —
   * tests/non-Linux leave it undefined and PID discovery is skipped.
   */
  private readonly mcpTracker?: import("../mcp/process-tracker.js").McpProcessTracker | null;

  /**
   * Phase 999.15 TRACK-02 — proc-age math constants for polled discovery.
   * Set at construction from SessionManagerOptions; passed through to
   * discoverClaudeSubprocessPid as opts.bootTimeUnix + opts.clockTicksPerSec
   * so the function does NOT re-read /proc/stat on every poll attempt.
   */
  private readonly mcpBootTimeUnix?: number;
  private readonly mcpClockTicksPerSec?: number;

  /**
   * 260419-q2z Fix B — in-flight session summaries awaited by {@link drain}
   * at daemon shutdown. Each call to `summarizeSessionIfPossible` is wrapped
   * in {@link trackSummary} so SIGTERM never truncates an unfinished summary.
   */
  private readonly pendingSummaries: Set<Promise<void>> = new Set();

  /**
   * Gap 3 (memory-persistence-gaps) — per-agent periodic flush timers. Each
   * timer fires a non-terminating `flushSessionMidway` call so the current
   * conversation is checkpointed to the memory DB at the configured interval,
   * protecting against data loss on unclean shutdowns (SIGKILL, OOM, power).
   * Cleared on stopAgent + crash + drain.
   */
  private readonly flushTimers: Map<string, NodeJS.Timeout> = new Map();

  /**
   * Gap 3 (memory-persistence-gaps) — per-agent flush sequence counter.
   * Encoded into the memory row's `flush:N` tag so operators can trace the
   * evolution of a long session. Resets on agent stop.
   */
  private readonly flushSequenceByAgent: Map<string, number> = new Map();

  /**
   * Phase 85 Plan 01 TOOL-01 — per-agent MCP state map.
   *
   * Populated at `startAgent` by the MCP readiness probe; mutated by the
   * `mcp-reconnect` heartbeat check as servers flap/recover. Drained on
   * `stopAgent` so a restart starts clean.
   *
   * Read by `/clawcode-tools` (via IPC `list-mcp-status`) and by the
   * two-block prompt-builder in Plan 02 to expose live tool health in
   * the system prompt (TOOL-02/TOOL-05).
   */
  private readonly mcpStateByAgent: Map<
    string,
    Map<string, McpServerState>
  > = new Map();

  /**
   * Phase 89 GREET-08 / D-14 — per-agent last-greeting-at timestamp (ms epoch).
   * Cool-down Map: if an entry exists and (now - entry) < agent.greetCoolDownMs,
   * the greeting is suppressed inside sendRestartGreeting. Reset on daemon boot
   * (in-memory only — matches CONTEXT.md §Claude's Discretion). Cleared
   * per-agent on stopAgent so an operator stop + restart does NOT see the
   * cool-down window (operator-initiated restart is a clean restart by intent).
   */
  private readonly greetCoolDownByAgent: Map<string, number> = new Map();

  /**
   * Phase 89 GREET-01 / D-08 — optional WebhookManager reference, wired in
   * from daemon.ts via setWebhookManager() AFTER the daemon constructs the
   * WebhookManager (which happens after SessionManager construction in boot
   * order). When undefined, the greeting helper is simply not invoked —
   * graceful degradation. Matches the setSkillsCatalog DI pattern at line 254.
   */
  private webhookManager: WebhookManager | undefined = undefined;

  /**
   * Phase 90.1 hotfix — bot-direct fallback sender for Phase 89 restart
   * greetings when per-agent webhooks are missing (e.g., bot lacks
   * MANAGE_WEBHOOKS permission in the target channel, or the auto-provisioner
   * hasn't run). Wired from daemon.ts via setBotDirectSender() AFTER the
   * DiscordBridge starts. When undefined, behavior matches Phase 89 original:
   * greeting is skipped with `skipped-no-webhook` outcome.
   */
  private botDirectSender: import("./restart-greeting.js").BotDirectSender | undefined = undefined;

  /**
   * Phase 90 MEM-02 — per-agent MemoryScanner references, wired in from
   * daemon.ts via setMemoryScanner(name, scanner) AFTER daemon boot
   * constructs the scanner for each agent (mirrors the
   * setWebhookManager DI pattern). When an agent has no scanner (opt-out
   * via memoryScannerEnabled=false), retrieval still works against the
   * existing memory_chunks rows — the scanner is only responsible for
   * keeping them up-to-date. Scanners are stop()'d on agent stop.
   */
  private readonly memoryScanners: Map<string, MemoryScanner> = new Map();

  /**
   * Phase 90 MEM-04 — per-agent MemoryFlushTimer map. NOT to be confused
   * with `flushTimers` above (Gap 3 memory-persistence-gaps: mid-session
   * DB summarization via flushSessionMidway). The MEM-04 timer fires a
   * Haiku-summarized DISK flush to memory/YYYY-MM-DD-HHMM.md every 15 min
   * (configurable), surviving SIGKILL-class shutdowns. Distinct concerns;
   * distinct map.
   *
   * Created in startAgent AFTER warm-path success; stopped + final-flushed
   * (with 10s cap, D-29) in stopAgent BEFORE handle.close.
   */
  private readonly memoryFileFlushTimers: Map<string, MemoryFlushTimer> = new Map();

  /**
   * Phase 103 OBS-02 — per-agent compaction counter mirror. In-memory only;
   * resets on daemon restart (Research Open Q4 — informational counter, not
   * persistence-worthy). Bumped by SessionManager.compactForAgent on each
   * successful CompactionManager.compact() resolve. Read by /clawcode-status
   * via getCompactionCountForAgent.
   *
   * Map identity stable for SessionManager lifetime — entries created lazily
   * on first compaction or via accessor read (which returns 0 for missing).
   */
  private readonly compactionCounts: Map<string, number> = new Map();

  /**
   * Phase 103 OBS-04 — per-agent RateLimitTracker map.
   *
   * Each tracker shares the agent's UsageTracker SQLite DB handle (one DB per
   * agent — see `src/usage/tracker.ts` initSchema where the
   * `rate_limit_snapshots` table lives alongside `usage_events`). Constructed
   * at agent startAgent (after warm-path success) and injected into the
   * SessionHandle via `handle.setRateLimitTracker` so the SDK
   * `rate_limit_event` dispatch hook in persistent-session-handle.ts has a
   * destination. Cleaned on stopAgent.
   *
   * Read by:
   *   - `getRateLimitTrackerForAgent` (this file) — Plan 03 IPC consumer
   *   - `/clawcode-status` renderer for session/weekly bars (Plan 03)
   *   - `/clawcode-usage` Discord slash command (Plan 03)
   */
  private readonly rateLimitTrackers: Map<string, RateLimitTracker> = new Map();

  /**
   * Phase 103 OBS-01 — per-agent activation timestamp mirror (ms epoch).
   * Mirrors the registry.startedAt write in startAgent so /clawcode-status
   * has a synchronous accessor without awaiting readRegistry. Reset on
   * stopAgent (entry deleted). Set on each successful warm-path completion
   * to match the registry semantics ("most recent successful start").
   */
  private readonly activationAtByAgent: Map<string, number> = new Map();

  /**
   * Phase 103 OBS-01 — injected HeartbeatRunner reference for context-zone
   * fillPercentage lookup. Set once at daemon boot via setHeartbeatRunner
   * (mirrors the setWebhookManager / setBotDirectSender DI pattern). Left
   * undefined in tests / SessionManager-only fixtures — the
   * getContextFillPercentageForAgent accessor returns undefined when unset.
   */
  private heartbeatRunner: import("../heartbeat/runner.js").HeartbeatRunner | undefined = undefined;

  /**
   * 260419-q2z Fix B — set to `true` by {@link drain}; causes
   * `streamFromAgent` / `dispatchTurn` to reject new work with
   * `SessionError('shutting down ...')`. `stopAgent` / `reconcileRegistry`
   * continue to function so the daemon can still clean up cleanly.
   */
  private draining: boolean = false;

  constructor(options: SessionManagerOptions) {
    this.adapter = options.adapter;
    this.registryPath = options.registryPath;
    this.log = options.log ?? logger;
    this.spawnGovernor = options.spawnGovernor;
    this.summarizeFn = options.summarizeFn ?? summarizeWithHaiku;
    this.flushIntervalMsOverride = options.flushIntervalMsOverride;
    // Phase 83 Plan 02 EFFORT-03 — persist path resolves via DI or default.
    this.effortStatePath = options.effortStatePath ?? DEFAULT_EFFORT_STATE_PATH;
    this.styleStatePath = options.styleStatePath ?? DEFAULT_STYLE_STATE_PATH;
    // Phase 100 follow-up — vault-scope override resolver (DI). Undefined in
    // tests / bootstrap; daemon wires the production opRead at edge.
    this.opEnvResolver = options.opEnvResolver;
    // Phase 999.14 MCP-01 — capture optional MCP process tracker.
    this.mcpTracker = options.mcpTracker;
    // Phase 999.15 TRACK-02 — cache age-filter constants (production daemon
    // wires these at boot; tests omit and rely on mocked discoverClaudeSubprocessPid).
    this.mcpBootTimeUnix = options.mcpBootTimeUnix;
    this.mcpClockTicksPerSec = options.mcpClockTicksPerSec;
    this.memory = new AgentMemoryManager(this.log);
    this.recovery = new SessionRecoveryManager(
      this.registryPath,
      options.backoffConfig ?? DEFAULT_BACKOFF_CONFIG,
      this.log,
      async (name, config) => this.performRestart(name, config),
      // Quick task 260521-5gh Gap 2 — crash-alert DI hook (optional).
      options.onCrashAlert,
    );
  }

  /**
   * Phase 53 Plan 03 — shared SkillUsageTracker. Exposed for buildSessionConfig
   * (so the assembler can read the per-turn usage window) and for tests.
   */
  getSkillUsageTracker(): SkillUsageTracker {
    return this.skillUsageTracker;
  }

  /**
   * Build a SkillTrackingConfig for `agent`, pulling the skill catalog names
   * from the agent's config. Returns undefined when the agent has no skills
   * (nothing to track).
   */
  private makeSkillTracking(
    config: ResolvedAgentConfig,
  ): SkillTrackingConfig | undefined {
    const skills = config.skills ?? [];
    if (skills.length === 0) return undefined;
    return {
      skillUsageTracker: this.skillUsageTracker,
      agentName: config.name,
      skillCatalogNames: [...skills],
    };
  }

  // Test helpers (delegate to recovery)
  get _lastCrashPromise(): Promise<void> | null { return this.recovery._lastCrashPromise; }
  set _lastCrashPromise(v: Promise<void> | null) { this.recovery._lastCrashPromise = v; }
  get _lastRestartPromise(): Promise<void> | null { return this.recovery._lastRestartPromise; }
  set _lastRestartPromise(v: Promise<void> | null) { this.recovery._lastRestartPromise = v; }
  get _lastStabilityPromise(): Promise<void> | null { return this.recovery._lastStabilityPromise; }
  set _lastStabilityPromise(v: Promise<void> | null) { this.recovery._lastStabilityPromise = v; }
  /**
   * Test helper — dispose all pending recovery timers (stability + restart)
   * for every agent. Lets a test halt the auto-restart chain after asserting
   * a first crash, so a crashed (not-running) agent's scheduled restart timer
   * does not leak past the test. Delegates to {@link SessionRecoveryManager.clearAllTimers}.
   * @internal
   */
  _clearAllRecoveryTimers(): void { this.recovery.clearAllTimers(); }

  setSkillsCatalog(catalog: SkillsCatalog): void { this.skillsCatalog = catalog; }

  /**
   * Phase 130 Plan 02 — daemon-boot setter for the per-agent unloaded-skills
   * map (DI'd from `unloadedSkillsByAgent` constructed in daemon.ts:5a).
   * Plan 03 CLI handler reads this via `getUnloadedSkills(agentName)`.
   */
  setUnloadedSkillsByAgent(map: ReadonlyMap<string, readonly UnloadedSkillEntry[]>): void {
    this.unloadedSkillsByAgent = map;
  }

  /**
   * Phase 130 Plan 02 — per-agent accessor for refused-skill records.
   * Returns an empty array (not undefined) when the agent has no refusals
   * so callers don't need null-checks. Plan 03 T-02 CLI consumes this.
   */
  getUnloadedSkills(agentName: string): readonly UnloadedSkillEntry[] {
    return this.unloadedSkillsByAgent.get(agentName) ?? [];
  }

  /**
   * Phase 89 GREET-01 — inject the WebhookManager reference after both this
   * SessionManager and the WebhookManager are constructed (daemon boot order
   * has SessionManager first at ~line 1014, WebhookManager at ~1823/1834/1839).
   * Called exactly once by the daemon. When left unset, restartAgent's
   * greeting side-effect is a no-op (graceful degradation).
   */
  setWebhookManager(wm: WebhookManager): void {
    this.webhookManager = wm;
  }

  /**
   * Phase 90.1 hotfix — inject the bot-direct fallback sender. Called once by
   * daemon.ts AFTER the DiscordBridge starts. Greeting helper will use this
   * when the per-agent webhook is missing. Idempotent.
   */
  setBotDirectSender(sender: import("./restart-greeting.js").BotDirectSender): void {
    this.botDirectSender = sender;
  }

  /** Phase 999.131 — wire the fleet shared-facts store. */
  setSharedFactsStore(store: SharedFactsStore): void {
    this.sharedFactsStore = store;
  }

  getSharedFactsStore(): SharedFactsStore | undefined {
    return this.sharedFactsStore;
  }

  /**
   * Phase 999.131 — append the owner's shared facts that match the query to
   * the per-agent retrieval result. The owner comes from the agent's OWN
   * config, so an agent can never read another owner's facts. Fail-open:
   * any error returns the agent's chunks unchanged.
   */
  private async appendOwnerFacts(
    agentName: string,
    query: string,
    chunks: readonly import("../memory/memory-retrieval.js").MemoryRetrievalResult[],
  ): Promise<readonly import("../memory/memory-retrieval.js").MemoryRetrievalResult[]> {
    const store = this.sharedFactsStore;
    const owner = this.configs.get(agentName)?.owner;
    if (!store || !owner) return chunks;
    try {
      const embedding = await this.memory.embedder.embed(query);
      const facts = ownerFactsAsChunks(store, owner, embedding);
      return facts.length > 0 ? [...chunks, ...facts] : chunks;
    } catch (err) {
      this.log.warn(
        { agent: agentName, error: err instanceof Error ? err.message : String(err) },
        "owner shared-facts retrieval failed (fail-open)",
      );
      return chunks;
    }
  }

  /**
   * Phase 90 MEM-02 — inject a per-agent MemoryScanner reference. Called
   * exactly once per agent by daemon.ts during boot after the scanner is
   * constructed. Mirrors the setWebhookManager post-construction DI
   * pattern; keeps the SessionManager constructor signature stable.
   *
   * Idempotent — re-calling with the same name replaces the previous
   * scanner (daemon config reload path). The caller is responsible for
   * stopping the prior scanner before re-injecting.
   */
  setMemoryScanner(agentName: string, scanner: MemoryScanner): void {
    this.memoryScanners.set(agentName, scanner);
  }

  /**
   * Phase 117 Plan 04 T05 — daemon-wide AdvisorBudget reference.
   *
   * Wired by daemon.ts AFTER SessionManager construction (daemon
   * constructs the SQLite-backed AdvisorBudget at line ~2592, before
   * SessionManager is constructed at line ~2401 in the existing boot
   * order). Setter pattern mirrors `setWebhookManager` /
   * `setBotDirectSender` so the constructor signature stays stable
   * (15+ agent test fixtures rely on the existing shape).
   *
   * When unset (tests, bootstrap paths), `makeAdvisorObserver` returns
   * undefined and the SDK adapter skips advisor-event observation +
   * budget accounting. Native-backend agents in this state still
   * function — the SDK enforces its own server-side `max_uses` cap;
   * only the daily soft-cap goes uncharged. Documented as the
   * acceptable graceful-degradation mode in RESEARCH §13.5.
   */
  private advisorBudget: AdvisorBudget | undefined = undefined;

  setAdvisorBudget(budget: AdvisorBudget): void {
    this.advisorBudget = budget;
  }

  /**
   * Phase 117 Plan 04 T05 — daemon-wide advisor defaults block
   * (`config.defaults.advisor` from clawcode.yaml).
   *
   * Wired by daemon.ts AFTER SessionManager construction (the full
   * `config.defaults` is only known once `loadConfig` resolves; setter
   * pattern mirrors setWebhookManager / setBotDirectSender to keep the
   * SessionManager constructor signature stable).
   *
   * Threaded into `SessionConfigDeps.advisorDefaults` (via
   * `configDeps`) so `buildSessionConfig`'s `shouldEnableAdvisor`
   * gate can run `resolveAdvisorBackend(agent, defaults)` against
   * the same defaults block the rest of the daemon uses. When unset
   * (tests), the resolver falls through to its hard-coded baseline
   * (`"native"` / `"opus"`).
   */
  private advisorDefaults:
    | { advisor?: { backend?: string; model?: string } }
    | undefined = undefined;

  setAdvisorDefaults(defaults: {
    advisor?: { backend?: string; model?: string };
  }): void {
    this.advisorDefaults = defaults;
  }

  /**
   * Phase 117 Plan 04 T03/T04 — build the native-advisor observer wiring
   * for a single agent. Returns undefined when the AdvisorBudget has
   * not been injected (test paths) so the adapter's advisorObserver
   * argument falls back to "no observation."
   *
   * Mirrors the `makeSkillTracking` pattern (line ~471 in this file) —
   * a tiny factory invoked from startAgent / restartAgent right before
   * the `adapter.createSession` / `resumeSession` call. Returning a
   * fresh object each time keeps the observer config immutable per
   * session-handle lifecycle, matching the existing observational
   * contract for skill-mention tracking.
   */
  private makeAdvisorObserver(
    agentName: string,
  ): AdvisorObserverConfig | undefined {
    if (!this.advisorBudget) return undefined;
    return {
      agentName,
      advisorEvents: this.advisorEvents,
      advisorBudget: this.advisorBudget,
    };
  }

  /**
   * Phase 103 OBS-01 — inject the HeartbeatRunner reference so
   * `/clawcode-status` can read context-zone fillPercentage synchronously.
   * Called once by daemon.ts AFTER both SessionManager and HeartbeatRunner
   * are constructed (mirrors setWebhookManager / setBotDirectSender DI).
   * Idempotent: re-calling replaces the reference.
   *
   * Tests / SessionManager-only fixtures leave this unset — the
   * getContextFillPercentageForAgent accessor returns undefined when no
   * runner is wired (graceful degradation).
   */
  setHeartbeatRunner(runner: import("../heartbeat/runner.js").HeartbeatRunner): void {
    this.heartbeatRunner = runner;
  }

  /**
   * Phase 90 MEM-02 — test helper (read-only view of the scanner map).
   * Tests assert scanner stop() called on stopAgent; production callers
   * MUST NOT reach into this map directly.
   * @internal
   */
  get _memoryScanners(): ReadonlyMap<string, MemoryScanner> {
    return this.memoryScanners;
  }

  /**
   * Phase 90 MEM-04 — test helper (read-only view of the disk-flush timer
   * map). Tests assert the timer is created on startAgent and removed on
   * stopAgent. Production callers MUST NOT reach into this map directly.
   * @internal
   */
  get _memoryFileFlushTimers(): ReadonlyMap<string, MemoryFlushTimer> {
    return this.memoryFileFlushTimers;
  }

  /**
   * Phase 90 MEM-03 — build a pre-turn retrieval closure for `agentName`.
   * Returns undefined when the agent has no MemoryStore (not initialized /
   * already stopped) — the TurnDispatcher short-circuits to zero-retrieval
   * in that case.
   *
   * The closure captures the agent's MemoryStore + the shared MiniLM
   * embedder. Re-reads topK per turn from this.configs so a YAML hot-reload
   * takes effect without re-wiring. 14-day time window is hard-coded per
   * D-24; the budget reads from this.allAgentConfigs' defaults (defaults.
   * memoryRetrievalTokenBudget).
   */
  getMemoryRetrieverForAgent(
    agentName: string,
  ): ((query: string) => Promise<readonly MemoryRetrievalResult[]>) | undefined {
    const store = this.memory.memoryStores.get(agentName);
    if (!store) return undefined;
    const config = this.configs.get(agentName);
    const topK = config?.memoryRetrievalTopK ?? 5;
    // Phase 115 sub-scope 3 — wire the previously-dead memoryRetrievalTokenBudget
    // knob from ResolvedAgentConfig (loader populates from agent.X ??
    // defaults.X). Pre-115 the per-turn <memory-context> always used the
    // hardcoded 2000-token default in retrieveMemoryChunks regardless of yaml
    // config. Now per-agent + defaults flow through. Default 1500 here matches
    // defaults.memoryRetrievalTokenBudget so test code that builds a
    // ResolvedAgentConfig without this field still gets the Phase 115 default.
    const tokenBudget = config?.memoryRetrievalTokenBudget ?? 1500;
    // Phase 115 sub-scope 4 — read the locked Phase 115 default tag-exclusion
    // list when the resolved config lacks one (test-factory back-compat — in
    // production, loader always populates from defaults, so the `??` only
    // fires for unit tests building a ResolvedAgentConfig literal). The
    // locked list is documented in CONTEXT.md sub-scope 4 and verified by
    // grep in the plan's must_haves. Operators can fully replace per-agent.
    const excludeTags =
      config?.memoryRetrievalExcludeTags ??
      (["session-summary", "mid-session", "raw-fallback"] as const);
    const embedder = this.memory.embedder;
    // Phase 101 Plan 04 — pull the reranker config via the resolver closure
    // wired by daemon.ts at boot (mirrors `setAllowMistralOcr` pattern). When
    // the resolver is unset (tests, bootstrap) the rerank step is skipped
    // (back-compat with pre-101-04 retrieval).
    const rerankerResolver = this.rerankerConfigResolver;
    // Phase 999.43 Plan 03 Task 2 — capture `this` so the inner closure can
    // re-resolve the agent's documentStore + LIVE ingestionPriority on every
    // call. Both reads run AT TURN TIME (not at retriever construction time)
    // so a `clawcode reload` flip of ingestionPriority takes effect on the
    // next turn without re-wiring the retriever.
    const self = this;
    // Phase 999.43 D-01 axis 1 multipliers (LOCKED VERBATIM):
    //   high: 1.5, medium: 1.0, low: 0.7
    const DOC_PRIORITY_AGENT_WEIGHTS = {
      high: 1.5,
      medium: 1.0,
      low: 0.7,
    } as const;
    // Quick-260521-437 — capture the retrieval-tuning resolver so the inner
    // closure can re-read `documentIngest.retrieval.{recencyBoostDays,
    // maxChunksPerRetrieval}` AT TURN TIME. Unset in tests / bootstrap →
    // the schema-default behavior (2-day window, 2-chunk cap) is applied
    // anyway so production is the fixed behavior even without explicit YAML.
    const retrievalResolver = this.documentIngestRetrievalResolver;
    // Quick-260521-437 — schema defaults; the single source of truth when
    // the resolver is unset OR returns undefined (config block absent).
    const RETRIEVAL_DEFAULT_RECENCY_BOOST_DAYS = 2;
    const RETRIEVAL_DEFAULT_MAX_CHUNKS_PER_RETRIEVAL = 2;
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    return async (query: string) => {
      const rerankerCfg = rerankerResolver?.();
      // Re-resolve at call time for hot-reload semantics. When the agent
      // has no DocumentStore (e.g. fresh agent before any ingest) the
      // documentPriority arg is omitted and retrieveMemoryChunks runs
      // the legacy pipeline (back-compat).
      const docStore = self.getDocumentStore(agentName);
      const liveConfig = self.configs.get(agentName);
      const livePriority = liveConfig?.ingestionPriority ?? "medium";
      const liveAgentWeight = DOC_PRIORITY_AGENT_WEIGHTS[livePriority];
      // Quick-260521-437 — resolve the retrieval knobs at turn time. The
      // resolver returns undefined when the `documentIngest.retrieval`
      // block is absent; fall back to the schema defaults so production
      // gets the fixed behavior (shorter recency window + document-chunk
      // cap) even without an explicit YAML entry.
      const retrievalCfg = retrievalResolver?.();
      const recencyBoostDays =
        retrievalCfg?.recencyBoostDays ??
        RETRIEVAL_DEFAULT_RECENCY_BOOST_DAYS;
      const documentChunkCap =
        retrievalCfg?.maxChunksPerRetrieval ??
        RETRIEVAL_DEFAULT_MAX_CHUNKS_PER_RETRIEVAL;
      const recencyWindowMs = recencyBoostDays * MS_PER_DAY;
      const documentPriority = docStore
        ? {
            getDocumentRow: (docSlug: string) => {
              const row = docStore.getDocumentRowBySlug(docSlug);
              if (!row) return null;
              return {
                content_priority_weight: row.content_priority_weight,
                ingested_at: row.ingested_at,
              };
            },
            agentWeight: liveAgentWeight,
            recencyWindowMs,
          }
        : undefined;
      const chunks = await retrieveMemoryChunks({
        query,
        store,
        // Phase 999.119 v2 switch — the query is embedded for whichever
        // space the agent's migration currently reads from.
        embed: (text: string) => store.embedQuery(embedder, text),
        topK,
        timeWindowDays: 14,
        tokenBudget,
        excludeTags,
        agent: agentName,
        reranker: rerankerCfg,
        documentPriority,
        documentChunkCap,
      });
      // Phase 999.131 — owner-scoped shared facts ride along (fail-open).
      return this.appendOwnerFacts(agentName, query, chunks);
    };
  }

  /**
   * Phase 101 Plan 04 (D-04, U9, SC-10) — daemon-boot DI of the reranker
   * config getter. Mirrors the `setAllowMistralOcr` resolver pattern: the
   * daemon hands SessionManager a closure that reads
   * `config.defaults.documentIngest.reranker` at CALL time so a `clawcode
   * reload` mutation propagates without re-wiring. Unset in tests +
   * bootstrap paths; `getMemoryRetrieverForAgent` then runs the legacy
   * non-reranked retrieval (back-compat).
   *
   * The resolver may return `undefined` (config block absent) — that
   * signal is treated the same as "disabled" by `retrieveMemoryChunks`.
   */
  private rerankerConfigResolver:
    | (() => Readonly<{
        enabled: boolean;
        topNToRerank: number;
        finalTopK: number;
        timeoutMs: number;
      }> | undefined)
    | undefined = undefined;

  setRerankerConfigResolver(
    resolver: () => Readonly<{
      enabled: boolean;
      topNToRerank: number;
      finalTopK: number;
      timeoutMs: number;
    }> | undefined,
  ): void {
    this.rerankerConfigResolver = resolver;
  }

  /**
   * Quick-260521-437 — daemon-boot DI of the retrieval-tuning config
   * getter. Same call-time closure pattern as `rerankerConfigResolver`:
   * the daemon hands SessionManager a closure that reads
   * `config.defaults.documentIngest.retrieval` at CALL time so a
   * `clawcode reload` mutation propagates without re-wiring. Unset in
   * tests + bootstrap paths; `getMemoryRetrieverForAgent` then falls back
   * to the schema defaults (2-day recency window, 2-chunk document cap)
   * so production gets the fixed behavior even without explicit YAML.
   *
   * The resolver may return `undefined` (config block absent) — the
   * retriever closure treats that the same as "use schema defaults".
   */
  private documentIngestRetrievalResolver:
    | (() => Readonly<{
        recencyBoostDays: number;
        maxChunksPerRetrieval: number;
      }> | undefined)
    | undefined = undefined;

  setDocumentIngestRetrievalResolver(
    resolver: () => Readonly<{
      recencyBoostDays: number;
      maxChunksPerRetrieval: number;
    }> | undefined,
  ): void {
    this.documentIngestRetrievalResolver = resolver;
  }

  /**
   * @internal Phase 89 test-only — exposes the cool-down map for integration
   * tests (stopAgent cleanup + GREET-10 cool-down semantics). Read-only view
   * so production callers can't mutate the map through this getter.
   */
  get _greetCoolDownByAgent(): ReadonlyMap<string, number> {
    return this.greetCoolDownByAgent;
  }

  setAllAgentConfigs(configs: readonly ResolvedAgentConfig[]): void {
    this.allAgentConfigs = configs;

    // Phase 999.43-fu — hot-reload propagation fix. The reload path
    // (ConfigReloader.applyChanges) calls this method with the fresh
    // resolved-agents snapshot after a yaml edit. Prior to this fix the
    // method only updated `this.allAgentConfigs` (consumed by
    // session-config.ts for admin baseOptions); the per-agent
    // `this.configs` Map that `getAgentConfig(name)` reads remained the
    // boot-time snapshot, so RELOADABLE_FIELDS that depend on
    // `getAgentConfig` — `autoIngestAttachments`, `ingestionPriority`,
    // `autonomousSkillDrafting`, `skillDistiller`, plus closure re-reads
    // at session-manager.ts:719/764/1689/1774/2472 — silently failed to
    // hot-reload until `systemctl restart clawcode`.
    //
    // Mirror the HeartbeatRunner.setAgentConfigs pattern at
    // src/heartbeat/runner.ts:143-147 (the field that DOES hot-reload
    // today does so because its consumer keeps its own per-agent Map).
    //
    // Invariant preservation: `this.configs` carries an implicit
    // "agents that have been started" invariant (populated by
    // `startAgent` / `reconcileRegistry`). We refresh ONLY existing
    // entries — a brand-new agent added via yaml still needs the
    // existing start-up path to register in `this.configs`. This
    // matches how closures at lines 1689/1774/2472 expect
    // `this.configs.get(name)` to indicate "running" vs "unknown".
    for (const config of configs) {
      if (this.configs.has(config.name)) {
        this.configs.set(config.name, config);
      }
    }
  }

  /**
   * Phase 52 Plan 02 — read the most recent prefixHash for `agent` (or
   * undefined on a fresh session). Used by tests + the per-turn provider
   * closure.
   */
  getLastPrefixHash(agent: string): string | undefined {
    return this.lastPrefixHashByAgent.get(agent);
  }

  /**
   * Phase 52 Plan 02 — record the latest prefixHash for `agent`.
   * Called by the provider closure's `persist` hook AFTER recordCacheUsage
   * so the NEXT turn's comparison has a fresh baseline.
   */
  setLastPrefixHash(agent: string, hash: string): void {
    this.lastPrefixHashByAgent.set(agent, hash);
  }

  /**
   * Phase 52 Plan 02 — build a PrefixHashProvider closure for `agent`.
   *
   * On every turn, returns `{ current: sha256(latestStablePrefix), last }`
   * where `latestStablePrefix` is the most recent stablePrefix rebuilt via
   * buildSessionConfig (refreshed on skills hot-reload). `persist` updates
   * the per-agent Map so the next turn can compare.
   *
   * Returns undefined when the agent has no cached stablePrefix — the
   * adapter treats this as "no prefix drift signal" and records the
   * cache telemetry snapshot without the prefix fields.
   */
  private makePrefixHashProvider(agent: string) {
    return {
      get: () => {
        const prefix = this.latestStablePrefixByAgent.get(agent) ?? "";
        return {
          current: prefix.length > 0 ? computePrefixHash(prefix) : "",
          last: this.lastPrefixHashByAgent.get(agent),
        };
      },
      persist: (hash: string) => {
        this.lastPrefixHashByAgent.set(agent, hash);
      },
    };
  }

  /**
   * Register a callback to be invoked when a session ends (stop or crash).
   * Used by daemon to auto-cleanup subagent thread bindings.
   */
  registerSessionEndCallback(sessionName: string, callback: () => Promise<void>): void {
    this.sessionEndCallbacks.set(sessionName, callback);
  }

  /** Phase 73 Plan 02 — escape hatch (stop/crash auto-invalidate). */
  invalidateBriefCache(n: string): void { this.briefCache.invalidate(n); }

  /** @throws SessionError if the agent is already running */
  /**
   * Serialize a lifecycle operation for `name` behind any in-flight op for the
   * same agent. Independent agents never contend (separate chains). Runs `fn`
   * after the prior op SETTLES (success or failure — a failed op must not wedge
   * the chain). Returns `fn`'s result/rejection unchanged so callers see the
   * same contract as before. Internal compositors (restartAgent, performRestart)
   * acquire the lock ONCE and call the `*Core` methods directly to avoid
   * self-deadlock; everyone else calls the public locked methods.
   */
  private withLifecycleLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.lifecycleChains.get(name) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    // Non-rejecting tail keeps the chain flowing; prune when this op is the last.
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    const guarded = tail.finally(() => {
      if (this.lifecycleChains.get(name) === guarded) {
        this.lifecycleChains.delete(name);
      }
    });
    this.lifecycleChains.set(name, guarded);
    return run;
  }

  async startAgent(name: string, config: ResolvedAgentConfig): Promise<void> {
    return this.withLifecycleLock(name, () => this.startAgentCore(name, config));
  }

  private async startAgentCore(name: string, config: ResolvedAgentConfig): Promise<void> {
    if (this.sessions.has(name)) {
      throw new SessionError(`Agent '${name}' is already running`, name);
    }

    // P3 (memory program) — fork residency cap: the first-ever bound on
    // fork-kind sessions (advisor/optimizer/escalation forks previously
    // had NO cap and NO timeout). Fork callers already handle start
    // failures via their finally-cleanup, so a loud throw here is safe.
    if (this.spawnGovernor && spawnClassOf(name) === "fork") {
      const cap = this.spawnGovernor.maxResidentForks();
      const resident = [...this.sessions.keys()].filter(
        (n) => spawnClassOf(n) === "fork",
      ).length;
      if (resident >= cap) {
        throw new SessionError(
          `fork residency cap reached (${resident}/${cap}) — retry after a fork completes`,
          name,
        );
      }
    }

    // P3 — spawn-slot admission (class-aware; agent class is advisory and
    // never hard-blocks — see spawn-governor.ts). Between here and the
    // outer try below only non-throwing statements run; the release lands
    // in that try's finally so every exit path frees the slot.
    const releaseSpawnSlot = this.spawnGovernor
      ? await this.spawnGovernor.acquire(name)
      : () => {};
    this.configs.set(name, config);

    // Phase 106 STALL-02 — warmup-timeout sentinel. After the 2026-04-30
    // 22:09 PT incident where research/fin-research silently stalled
    // post-memory-scanner, post-schedules-registered, but pre-warm-path-ready
    // (no error, no log), this sentinel converts silent failure into loud
    // failure: at 60s elapsed without warm-path-ready, emit a structured
    // pino-warn that operators can `grep "warmup-timeout" | jq .mcpServersPending`
    // to identify the hung MCP. Cleared on any startAgent exit (success,
    // failure, exception) via the try/finally wrapping the body.
    // lastStep semantics: tracks the current major phase of agent startup so
    // the warmup-timeout warn pinpoints WHICH subsystem hung. The dominant
    // expected stall point per RESEARCH.md is `adapter.createSession` (Claude
    // Agent SDK MCP cold-start handshake), so we sync-init lastStep to that
    // value at the top of the try block — operators reading
    // `journalctl | grep warmup-timeout | jq .lastStep` see the most-likely
    // culprit by default. We monotonically advance through warm-path-check
    // and post-warm as we pass each milestone. The "init" / "build-session-config"
    // / "mcp-discovery" labels are reserved for future granularity but
    // currently mostly transient (operators rarely catch a stall in those
    // microsecond windows in practice).
    let lastStep:
      | "init"
      | "build-session-config"
      | "adapter-create-session"
      | "mcp-discovery"
      | "warm-path-check"
      | "post-warm" = "init";
    // Quick task 260521-5gh Gap 1/Gap 3 — session-start anchor for the
    // warm-path-failure crash log's `uptimeMs`. The registry `startedAt`
    // field is only written AFTER warm-path success (see post-warm block
    // below), so on a warm-path failure there is no registry `startedAt`
    // yet — `startAgentAtMs` is the correct uptime anchor for that path.
    const startAgentAtMs = Date.now();
    const mcpServersConfigured = (config.mcpServers ?? []).map((s) => s.name);
    let mcpReadinessRef: McpReadinessReport | null = null;
    const warmupTimeoutHandle = setTimeout(() => {
      const loaded: string[] = [];
      const pending: string[] = [];
      if (mcpReadinessRef) {
        for (const [serverName, state] of mcpReadinessRef.stateByName) {
          if (state.status === "ready") loaded.push(serverName);
          else pending.push(serverName);
        }
      } else {
        pending.push(...mcpServersConfigured);
      }
      this.log.warn(
        {
          agent: name,
          elapsedMs: 60_000,
          lastStep,
          mcpServersConfigured,
          mcpServersLoaded: loaded,
          mcpServersPending: pending,
        },
        "agent warmup-timeout — boot stalled, no warm-path-ready",
      );
    }, 60_000);

    try {
    // Phase 106 STALL-02 — sync-advance lastStep to the dominant expected
    // stall point (adapter.createSession). Operators reading the
    // warmup-timeout warn see the most-likely culprit by default; later
    // milestones (warm-path-check, post-warm) overwrite this as we pass them.
    lastStep = "adapter-create-session";

    // Ensure registry entry exists. Atomic RMW so a concurrent startAgent
    // (e.g. a sibling workflow fan-out worker) cannot lose-update this seed.
    await mutateRegistry(this.registryPath, (current) => {
      const seeded = current.entries.find((e) => e.name === name)
        ? current
        : {
            entries: [...current.entries, createEntry(name)],
            updatedAt: Date.now(),
          };
      return updateEntry(seeded, name, { status: "starting" });
    });

    // Initialize memory, store SOUL.md as retrievable memory, and refresh hot tier.
    //
    // Quick task 260419-mvh — fail-fast on memory init failure.
    //
    // Two guards handle the two failure modes of AgentMemoryManager.initMemory:
    //   1. try/catch — forward-compat: if initMemory starts propagating errors
    //      (better error hygiene), capture the REAL cause in one place.
    //   2. `!memoryStores.has(name)` — today's silent-swallow path. initMemory's
    //      own try/catch (session-memory.ts:125) logs ERROR but does NOT throw,
    //      leaving no MemoryStore behind. Before this guard the cascade continued
    //      into warm-path which THEN threw `warmSqliteStores: no MemoryStore for
    //      agent '${name}'` — hiding the real root cause in the prior log line.
    //
    // On either failure: mark the agent 'failed' with a single-line cause in
    // lastError, skip warm-path/createSession/etc., and return cleanly so the
    // daemon keeps serving the other agents (same contract as warm-path failure).
    try {
      this.memory.initMemory(name, config);
    } catch (initErr) {
      const errMsg = (initErr as Error).message;
      this.log.warn(
        { agent: name, error: errMsg },
        "failed to initialize memory — agent marked failed, skipping warm-path",
      );
      await mutateRegistry(this.registryPath, (current) =>
        updateEntry(current, name, {
          status: "failed",
          lastError: `initMemory: ${errMsg}`,
        }),
      );
      return;
    }
    if (!this.memory.memoryStores.has(name)) {
      const errMsg =
        "MemoryStore missing after initMemory (check earlier 'failed to initialize memory' log for root cause)";
      this.log.warn({ agent: name }, errMsg);
      await mutateRegistry(this.registryPath, (current) =>
        updateEntry(current, name, {
          status: "failed",
          lastError: `initMemory: ${errMsg}`,
        }),
      );
      return;
    }

    // Phase 65: start a ConversationStore session alongside the agent session
    const convStore = this.memory.conversationStores.get(name);
    if (convStore) {
      try {
        const convSession = convStore.startSession(name);
        this.activeConversationSessionIds.set(name, convSession.id);
        // Phase 999.119 pass 2 — a previous run that never stopped cleanly
        // leaves its row `active` forever; close it now that a new one owns
        // this agent. Rows with turns become eligible for the summary drain.
        const closed = convStore.closeStaleActiveSessions(name, convSession.id);
        if (closed > 0) {
          this.log.info({ agent: name, closed }, "closed stale active conversation sessions from earlier runs");
        }
      } catch (err) {
        this.log.warn({ agent: name, error: (err as Error).message }, "failed to start conversation session (non-fatal)");
      }
    }

    await this.memory.storeSoulMemory(name, config);
    const tierManager = this.memory.tierManagers.get(name);
    if (tierManager) tierManager.refreshHotTier();

    const bootstrapStatus = await detectBootstrapNeeded(config);
    this.log.info({ agent: name, bootstrapStatus }, "bootstrap check");

    // Phase 52 Plan 02 — thread priorHotStableToken for hot-tier placement.
    const sessionConfig = await buildSessionConfig(
      config,
      this.configDeps(name),
      undefined,
      bootstrapStatus,
    );

    // Phase 52 Plan 02 — cache latest stablePrefix + hotStableToken for the
    // per-turn prefixHashProvider + next buildSessionConfig respectively.
    this.latestStablePrefixByAgent.set(name, sessionConfig.systemPrompt);
    if (sessionConfig.hotStableToken) {
      this.lastHotStableTokenByAgent.set(name, sessionConfig.hotStableToken);
    }

    // Build usage callback
    const usageTracker = this.memory.usageTrackers.get(name);
    const sessionIdRef = { current: "" };

    // Phase 138 Plan 01 T-04 — per-provider credit telemetry.
    //
    // Construct a ProviderUsageTracker sharing the per-agent usage.db
    // connection (one SQLite file per agent — no new file, no new WAL
    // coordination). The `phase138-usage` hook fires from the SAME
    // unified usage callback as the existing `usageTracker.record(...)`
    // — both backends (anthropic-agent-sdk + codex-cli) route their
    // turn-terminating `result`-message usage through this one
    // callback, so the hook is fired exactly once per turn for either
    // provider (silent-path-bifurcation safe). The provider is derived
    // from `config.llmRuntime.backend`, NOT model-name inference.
    const providerUsageTracker = usageTracker
      ? new ProviderUsageTracker(usageTracker.getDatabase())
      : undefined;
    const providerUsageHook = buildProviderUsageHook({
      tracker: providerUsageTracker,
      agent: name,
      backend: config.llmRuntime?.backend,
      logger: this.log,
    });

    const usageCallback = usageTracker
      ? (data: { tokens_in: number; tokens_out: number; cost_usd: number; turns: number; model: string; duration_ms: number; cache_read_tokens?: number; cache_creation_tokens?: number }) => {
          try {
            // `...data` carries cache_read_tokens / cache_creation_tokens
            // (token-accuracy fix 2026-06-11) straight into the usage_events
            // row; record() defaults them to 0 when a caller omits them.
            usageTracker.record({ agent: name, timestamp: new Date().toISOString(), session_id: sessionIdRef.current, ...data });
          } catch { /* non-fatal */ }
          // Phase 138 T-04 — additive: per-provider telemetry + the
          // phase138-usage log line. Internally fail-silent — never
          // breaks the existing usage_events record path above.
          providerUsageHook(data);
        }
      : undefined;

    // Phase 52 Plan 02 — attach per-turn prefixHash provider so the adapter
    // can record cache_eviction_expected against the in-flight stablePrefix.
    // Phase 53 Plan 03 — attach skill-mention tracking so `iterateWithTracing`
    // records which skills appear in each turn's assistant text.
    const handle = await this.adapter.createSession(
      sessionConfig,
      usageCallback,
      this.makePrefixHashProvider(name),
      this.makeSkillTracking(config),
      // Phase 117 Plan 04 T03/T04 — native advisor observer wiring.
      // Returns undefined when AdvisorBudget hasn't been injected (test
      // paths); production daemon sets the budget right after
      // SessionManager construction so the observer is always present
      // for the 15+ agent fleet.
      this.makeAdvisorObserver(name),
    );
    sessionIdRef.current = handle.sessionId;
    this.sessions.set(name, handle);

    // FIND-123-A.next T-04 — sink-based claudePid acquisition (replaces the
    // Phase 999.15 TRACK-02 polled /proc-walk discovery via
    // discoverClaudeSubprocessPid).
    //
    // The structural spawn wrapper (T-02) writes the live claude subprocess
    // PID into the handle's pidSink synchronously inside the SDK's
    // `spawnLocalProcess` callback, so by the time the first `query()` has
    // emitted any data the sink is populated. The race window between
    // handle construction and SDK spawn is small but non-zero — we poll
    // the sink with the same 30s budget (6×5s) so a slow SDK init does
    // not skip registration. Polling stays fire-and-forget so warmup
    // never blocks on it.
    //
    // sessions.has(name) check at every iteration short-circuits if the
    // operator stops the agent during the wait (Pitfall 6 — abort on
    // dispose). Reaper reconciliation (`mcp/reconciler.ts:reconcileAgent`,
    // recovery path) still uses /proc discovery to rediscover after an
    // SDK respawn — that path is intentionally out of scope here.
    if (this.mcpTracker) {
      lastStep = "mcp-discovery";
      // FIND-123-A.next T-04 sink-based registration. Extracted into a shared
      // helper (quick task 260714-mkq) so the boot-resume path in
      // reconcileRegistry registers a resumed main the SAME way.
      this.registerClaudePidWithTracker(name);
    }

    // Phase 999.92 follow-up — persisted-effort re-apply MOVED to post-
    // warm-path-ready (see below at "EFFORT-03 re-apply" marker). The
    // original Phase 83 EFFORT-03 placement was pre-warm-path; on slow
    // SDK-CLI cold starts the `q.setMaxThinkingTokens` Promise landed on
    // a subprocess whose stdin handler wasn't fully initialized, producing
    // a benign `[effort] setMaxThinkingTokens(...) failed: Claude Code
    // process exited with code 1` log line that was easily mistaken for
    // an actual subprocess crash (e.g. 999.92's initial diagnosis spent
    // significant time on this signal before recognizing it as a
    // separate race). Moving the re-apply to after warm-path-ready
    // guarantees the SDK stdin handler is alive when setMaxThinkingTokens
    // fires. No consumer reads `handle.getEffort()` during warm-path
    // (verified: getEffortForAgent / turn-dispatcher / daemon IPC all
    // run post-warm), so the brief window where getEffort returns the
    // config default is operator-invisible.

    this.attachCrashHandler(name, config, handle);
    this.recovery.setStabilityTimer(name);

    // Phase 56 Plan 02 — warm-path ready gate. Registry stays in 'starting'
    // while we warm SQLite + verify embedder + probe session plumbing. On
    // failure or timeout (10s), mark the agent 'failed' with a structured
    // error — daemon keeps running other agents. On success, a single atomic
    // registry write flips status -> 'running' AND records warm_path_ready +
    // warm_path_readiness_ms in the same transaction.
    // Phase 85 Plan 01 TOOL-01 — mcpProbe closes over a ref so the report
    // is reachable after runWarmPathCheck resolves (for subsequent handle
    // + state-map population). Optional failures are warn-logged here and
    // do NOT contribute to the gate-blocking errors array.
    const mcpReadiness: { current: McpReadinessReport | null } = { current: null };
    const mcpServers = config.mcpServers ?? [];
    lastStep = "warm-path-check";
    // Phase 140-12 (live-E2E finding): SKIP the warm-path gate for v3
    // (claude-code-interactive) agents. The gate is v2-oriented — it probes the
    // SDK session's `sessionId` and JSON-RPC-handshakes `config.mcpServers` AS IF
    // the daemon owns them. For v3, claude owns the session + its MCP servers
    // (the daemon's SDK module is the inert FakeChannelsSdkModule), so the gate
    // can NEVER pass → the agent was stuck "starting" + restart-looped, never
    // reaching "running" (which broke ask-agent's isRunning guard + churned the
    // channel). Readiness for v3 = the supervised PTY spawned (loadSdkModule
    // succeeded above). Mark ready directly.
    const isV3Channels =
      config.llmRuntime?.backend === "claude-code-interactive";
    const warmResult = isV3Channels
      ? {
          ready: true as const,
          durations_ms: {} as WarmPathDurations,
          total_ms: 0,
          errors: [] as readonly string[],
        }
      : await runWarmPathCheck({
      agent: name,
      sqliteWarm: (agentName) => this.memory.warmSqliteStores(agentName),
      embedder: this.memory.embedder,
      sessionProbe: async () => {
        // Session plumbing verified by the handle existing + sessionId
        // populated. If the handle is missing or empty, throw to record a
        // session-scoped warm-path error.
        if (!handle || !handle.sessionId) {
          throw new Error("session handle not ready");
        }
      },
      // Phase 85 Plan 01 TOOL-01 — JSON-RPC `initialize` handshake against
      // every configured MCP server. Mandatory failures block the warm-
      // path; optional failures are warn-logged and allowed through.
      ...(mcpServers.length > 0
        ? {
            mcpProbe: async () => {
              // Phase 999.27 — skip broker-pooled servers (1password broker
              // shim) from warm-path probes. The probe spawns the shim with
              // the daemon's default env (clawdbot token) instead of the
              // per-agent overridden env, causing broker rebind cycles + pool
              // churn. Broker has its own heartbeat (`mcp-broker.ts`).
              const probableServers = filterOutBrokerPooled(mcpServers);
              // Warm-path gate runs at boot AND on every warm-path recovery
              // restart. Pass the COLD-path handshake timeout — the mandatory
              // `clawcode` MCP is `clawcode mcp` (a cold Node CLI boot, not
              // the Go shim). The 5s steady-state default is too short under
              // recovery-storm load — the 2026-05-21 fin-client incident
              // where recovery attempts 2 & 3 failed at exactly 5000ms.
              const rep = await performMcpReadinessHandshake(probableServers, {
                timeoutMs: MCP_HANDSHAKE_TIMEOUT_WARMPATH_MS,
              });
              mcpReadiness.current = rep;
              if (rep.optionalErrors.length > 0) {
                this.log.warn(
                  { agent: name, optionalErrors: rep.optionalErrors },
                  "mcp: optional servers failed handshake (non-blocking)",
                );
              }
              return { errors: rep.errors };
            },
          }
        : {}),
      timeoutMs: WARM_PATH_TIMEOUT_MS,
    });

    // Persist the MCP state map regardless of gate outcome. On a mandatory
    // failure we still want the state visible (e.g. for `list-mcp-status`
    // + Plan 03's /clawcode-tools) even though the agent is marked failed.
    // On success this gets re-persisted alongside the handle below.
    if (mcpReadiness.current) {
      this.setMcpStateForAgent(name, mcpReadiness.current.stateByName);
    }

    if (!warmResult.ready) {
      // Quick task 260521-5gh Gap 1 — route warm-path failures through the
      // canonical recovery.handleCrash() entry point so a transient failure
      // (e.g. a slow cold MCP boot) gets the same exponential-backoff +
      // 10-retry envelope as a session crash, instead of being marked
      // terminally `failed` on the FIRST failure (the bug that took
      // fin-client offline ~25 min on 2026-05-20).
      const errMsg = `warm-path: ${warmResult.errors.join("; ")}`;
      // Pre-write ONLY the observability fields. updateEntry is a partial
      // merge (registry.ts), so these survive the later handleCrash registry
      // write. Crucially we do NOT write `status: "failed"` here — that
      // first-failure-is-terminal write was the bug being removed; the status
      // ("crashed", or terminal "failed" after the envelope is exhausted) is
      // owned exclusively by the recovery subsystem.
      await mutateRegistry(this.registryPath, (current) =>
        updateEntry(current, name, {
          warm_path_ready: false,
          warm_path_readiness_ms: warmResult.total_ms,
        }),
      );
      this.log.error(
        {
          agent: name,
          errors: warmResult.errors,
          total_ms: warmResult.total_ms,
          durations_ms: warmResult.durations_ms,
        },
        "warm-path check failed — routing through recovery",
      );
      // Close the SDK handle — it is alive (only the warm-path probe failed).
      // handleCrash does NOT close handles. Close swallows any error from the
      // mock/SDK handle.
      try {
        await handle.close();
      } catch {
        /* handle may already be closed */
      }
      // handleCrash already clears the stability timer AND deletes the
      // session from the map — do not double those side effects here.
      // errMsg already carries the joined warmResult.errors, so the
      // enriched Gap-3 crash log surfaces the full detail.
      const warmPathError = new Error(errMsg);
      this.recovery.handleCrash(name, config, warmPathError, this.sessions, {
        cause: "warm-path-check",
        startedAtMs: startAgentAtMs,
      });
      return;
    }

    // Phase 106 STALL-02 — capture latest readiness so the sentinel timer
    // (rare exotic stall during post-warm registry write) reports a useful
    // mcpServersLoaded/Pending split rather than empty/configured.
    mcpReadinessRef = mcpReadiness.current;
    lastStep = "post-warm";
    const startedAt = Date.now();
    await mutateRegistry(this.registryPath, (current) =>
      updateEntry(current, name, {
        status: "running",
        sessionId: handle.sessionId,
        startedAt,
        warm_path_ready: true,
        warm_path_readiness_ms: warmResult.total_ms,
        lastError: null,
      }),
    );
    // Phase 103 OBS-01 — mirror startedAt for synchronous /clawcode-status
    // reads. Cleared in stopAgent.
    this.activationAtByAgent.set(name, startedAt);
    this.log.info(
      {
        agent: name,
        sessionId: handle.sessionId,
        total_ms: warmResult.total_ms,
        durations_ms: warmResult.durations_ms,
      },
      "warm-path ready — agent started",
    );

    // EFFORT-03 re-apply (Phase 83 Plan 02 — relocated by 999.92 follow-up).
    // Persisted runtime effort overrides make `/clawcode-effort` survive
    // `clawcode restart <agent>`. Read happens AFTER warm-path-ready so
    // q.setMaxThinkingTokens lands on a fully-initialized SDK subprocess
    // stdin handler (the pre-warm placement caused the benign canary
    // misdiagnosed during 999.92 — see comment at the original site
    // before attachCrashHandler above). A corrupt/missing state file
    // falls back to the config default (no throw). Persistence errors
    // are observational only — never affect agent runtime.
    // 999.105 — restore the persisted style override. Pure map population
    // (no handle call), so unlike effort it cannot race SDK init. Restored on
    // BOTH boot paths — see reconcileRegistry, whose effort twin has no
    // restore (the live gap the 999.105 plan told us not to copy).
    try {
      const persistedStyle = await readStyleState(this.styleStatePath, name, this.log);
      if (persistedStyle) this.styleOverrides.set(name, persistedStyle);
    } catch {
      /* observational only */
    }
    try {
      const persisted = await readEffortState(this.effortStatePath, name, this.log);
      if (persisted && persisted !== config.effort) {
        // Quick 260715-j1j (D6) — this direct handle.setEffort bypasses the
        // setEffortForAgent gate, so a persisted "ultracode" override must be
        // re-checked here: the config may have changed since persist (model
        // downgrade, nativeWorkflow removed) or the deploy rolled back. On
        // gate failure we warn and SKIP the re-apply — the agent keeps its
        // config default and startup continues normally. Never throw:
        // persistence is observational only (see docblock above), and a
        // stale override must not crash boot.
        const ultracodeGate =
          persisted === "ultracode"
            ? checkUltracodeEligibility({
                model: config.model,
                nativeWorkflow: config.nativeWorkflow,
              })
            : ({ ok: true } as const);
        if (!ultracodeGate.ok) {
          this.log.warn(
            {
              agent: name,
              persisted,
              configDefault: config.effort,
              reason: ultracodeGate.reason,
            },
            "persisted ultracode override no longer eligible — skipping re-apply (agent keeps config default)",
          );
        } else {
          handle.setEffort(persisted);
          this.log.info(
            { agent: name, effort: persisted, configDefault: config.effort },
            "re-applied persisted effort override",
          );
        }
      } else if (config.effort === "ultracode") {
        // Quick 260715-j1j review WR-01 — config-default ultracode activation.
        // Every OTHER effort level reaches the SDK via the session-start
        // `effort` option, but ultracode cannot be expressed there (D2 clamps
        // narrowEffortForSdkOption("ultracode") → "high"), so without this
        // branch a `clawcode.yaml` default of `effort: ultracode` boots at
        // plain high and the config knob is a silent partial no-op. Reached
        // when there is NO differing persisted override (persisted is null or
        // matches the config default). Gate re-checked because D7 load
        // validation pairs the nativeWorkflow flag but cannot verify MODEL
        // capability (aliases). Same warn-and-degrade contract as the
        // persisted path — never throw, startup continues.
        const bootGate = checkUltracodeEligibility({
          model: config.model,
          nativeWorkflow: config.nativeWorkflow,
        });
        if (!bootGate.ok) {
          this.log.warn(
            { agent: name, configDefault: config.effort, reason: bootGate.reason },
            "config-default ultracode not eligible — agent stays at the narrowed spawn effort",
          );
        } else {
          handle.setEffort("ultracode");
          this.log.info(
            { agent: name, effort: "ultracode" },
            "activated config-default ultracode after warm-path-ready",
          );
        }
      } else if (persisted) {
        // Persistence matches config default — no-op, but record at debug for
        // operator traceability.
        this.log.debug(
          { agent: name, effort: persisted },
          "persisted effort matches config default",
        );
      }
    } catch (err) {
      // Observational — never block startup on persistence.
      this.log.warn(
        { agent: name, error: (err as Error).message },
        "effort-state read failed on start (non-fatal)",
      );
    }

    // Phase 85 Plan 01 TOOL-01 — mirror MCP state onto the handle so
    // TurnDispatcher-scope consumers (Plan 02 prompt-builder) can read
    // live tool health without reaching into SessionManager's private
    // maps. Mirror is ALSO kept in sync by the mcp-reconnect heartbeat
    // check every tick (see src/heartbeat/checks/mcp-reconnect.ts).
    if (mcpReadiness.current) {
      handle.setMcpState(mcpReadiness.current.stateByName);
    }

    // Phase 103 OBS-04 / OBS-05 — construct + inject per-agent
    // RateLimitTracker. Shares the agent's UsageTracker DB handle (Research
    // §Architecture — add table to UsageTracker DB rather than a second
    // per-agent DB; one DB handle per agent stays clean).
    //
    // The tracker is the destination for SDK `rate_limit_event` messages
    // dispatched by persistent-session-handle.iterateUntilResult. When the
    // agent has no UsageTracker (e.g. memoryEnabled=false), the block silently
    // no-ops; the handle's dispatch branch optional-chains
    // `_rateLimitTracker?.record(...)` so a missing tracker is graceful and
    // /clawcode-usage shows "no data" (Pitfall 7).
    //
    // Pitfall 8: messages arriving in the race window between handle
    // construction (line ~660 above) and this injection are silently dropped.
    // Acceptable best-effort capture per Research.
    if (usageTracker) {
      const rateLimitTracker = new RateLimitTracker(usageTracker.getDatabase(), this.log);
      this.rateLimitTrackers.set(name, rateLimitTracker);
      handle.setRateLimitTracker(rateLimitTracker);
    }

    // Phase 94 Plan 01 Gap-Closure — boot-time capability probe (D-03).
    //
    // Without this fire-and-forget kickoff, every server's
    // capabilityProbe field is undefined for the first 60 seconds after
    // startup (until the heartbeat tick runs). Plan 94-02's filter would
    // then treat all MCP-backed tools as `unknown` and exclude them from
    // the LLM-visible tool list — agents start blind for a full minute.
    //
    // The schedule contract (D-03) specifies "boot once + 60s heartbeat
    // tick + on-demand". This satisfies the boot-once leg.
    //
    // Implementation:
    //   - Fire-and-forget (no await) — the warm-path is already green
    //     and we don't want to add 10s × N to startup latency.
    //   - Uses the same heartbeat-edge wiring (stub callTool that throws
    //     + getProbeFor override forcing default-fallback) until Plan
    //     94-03's real callTool wiring lifts the override. The
    //     default-fallback uses listTools, which the heartbeat extension
    //     stubs to return one synthetic entry — net effect is connect-ok
    //     servers come up as `capabilityProbe.status="ready"` immediately.
    //   - Errors swallowed via .catch() — boot must never fail because
    //     the probe coroutine threw. The next 60s heartbeat tick reruns
    //     this probe with full state-merge semantics.
    if (mcpServers.length > 0) {
      // Phase 999.27 — skip broker-pooled servers from agent-side capability
      // probes. The 1password broker shim is daemon-singleton transport;
      // probes spawning it with un-overridden env cause rebind cycles.
      const probableForCapability = filterOutBrokerPooled(mcpServers);
      const serverNames = probableForCapability.map((s) => s.name);
      const priorState = this.getMcpStateForAgent(name);
      const prevProbeByName = new Map<
        string,
        import("../mcp/readiness.js").CapabilityProbeSnapshot
      >();
      for (const [serverName, prior] of priorState) {
        if (prior.capabilityProbe) {
          prevProbeByName.set(serverName, prior.capabilityProbe);
        }
      }

      // Fire-and-forget — runs in background, completes within ~10s
      // wall-clock per server in parallel. Logged on completion.
      // Uses real JSON-RPC callTool/listTools (Gap 2 closure) to actually
      // verify each MCP subprocess responds to tools/list at the daemon
      // edge — capability-probe.ts itself remains DI-pure.
      void (async () => {
        try {
          const { probeAllMcpCapabilities } = await import("./capability-probe.js");
          const { makeRealCallTool, makeRealListTools } = await import(
            "../mcp/json-rpc-call.js"
          );
          const pino = (await import("pino")).default;
          const probeLog = pino({ level: "silent" });

          const serversByName = new Map(
            probableForCapability.map((s) => [
              s.name,
              {
                name: s.name,
                command: s.command,
                args: s.args,
                env: s.env,
              },
            ]),
          );
          const realListTools = makeRealListTools(serversByName);
          const realCallTool = makeRealCallTool(serversByName);

          const probeDeps = {
            callTool: realCallTool,
            listTools: realListTools,
            // Default-fallback override per heartbeat — verify capability
            // via tools/list response. Plan 94-03 will lift this per-server
            // as registry probes are vetted.
            getProbeFor: () => async (innerDeps: {
              listTools: (s: string) => Promise<readonly { readonly name: string }[]>;
            }) => {
              try {
                const tools = await innerDeps.listTools("__boot_probe__");
                if (tools.length === 0) {
                  return { kind: "failure" as const, error: "no tools exposed" };
                }
                return { kind: "ok" as const };
              } catch (err) {
                return {
                  kind: "failure" as const,
                  error: err instanceof Error ? err.message : String(err),
                };
              }
            },
            now: () => new Date(),
            log: probeLog,
          };
          const probeResults = await probeAllMcpCapabilities(
            serverNames,
            probeDeps as unknown as Parameters<typeof probeAllMcpCapabilities>[1],
            prevProbeByName,
          );

          // Merge fresh probe snapshots into each server's existing
          // McpServerState (preserves connect-test status from warm-path).
          const currentState = this.getMcpStateForAgent(name);
          const merged = new Map<string, McpServerState>();
          for (const [serverName, state] of currentState) {
            const probe = probeResults.get(serverName);
            if (probe) {
              merged.set(
                serverName,
                Object.freeze({ ...state, capabilityProbe: probe }),
              );
            } else {
              merged.set(serverName, state);
            }
          }
          this.setMcpStateForAgent(name, merged);
          // Mirror onto the handle so TurnDispatcher-scope reads see fresh probe.
          try {
            handle.setMcpState(merged);
          } catch {
            // Handle may have been closed (agent stopped) — best-effort.
          }
          this.log.info(
            { agent: name, servers: serverNames.length },
            "boot-time capability probe complete",
          );
        } catch (err) {
          // Observational — boot must never fail because of probe error.
          this.log.warn(
            { agent: name, err: (err as Error).message },
            "boot-time capability probe failed (non-fatal; next heartbeat tick will retry)",
          );
        }
      })();
    }

    // Gap 3 (memory-persistence-gaps): start mid-session flush timer AFTER
    // warm-path success. Before the gate is green there is no active
    // conversation to flush, and starting the timer earlier would waste a
    // tick if warm-path fails.
    this.startFlushTimer(name, config);

    // Phase 90 MEM-04 — per-agent disk-flush timer. Writes a Haiku-summarized
    // session delta to memory/YYYY-MM-DD-HHMM.md every intervalMs. Separate
    // from the Gap 3 DB flush above (that one summarizes into the memories
    // table via flushSessionMidway; this one lands on DISK so a SIGKILL
    // between DB flushes doesn't lose the active session's context). Skip
    // heuristic prevents spam on idle windows.
    this.startMemoryFileFlushTimer(name, config);
    } finally {
      // Phase 106 STALL-02 — clear the warmup-timeout sentinel on every
      // exit path (success, early-return failure, exception). The
      // outer try/finally guarantees no timer leak.
      clearTimeout(warmupTimeoutHandle);
      // P3 — spawn slot turns over when the attempt settles (success OR
      // failure): the governor bounds concurrent SPAWNS, not residency.
      releaseSpawnSlot();
    }
  }

  /**
   * Phase 90 MEM-04 — construct + start the disk-flush MemoryFlushTimer
   * for `name`. Safe to call from startAgent; defensive stop-first so
   * hot-reloads don't leak a timer. Uses the agent's config
   * memoryFlushIntervalMs (populated by loader.ts from the defaults
   * fallback) and wires getTurnsSince against the active ConversationStore
   * session (falls back to empty array when no active session, which
   * yields a skip per the meaningfulTurnsSince heuristic).
   */
  private startMemoryFileFlushTimer(
    name: string,
    config: ResolvedAgentConfig,
  ): void {
    this.stopMemoryFileFlushTimer(name); // defensive: never leak a prior timer

    const timer = new MemoryFlushTimer({
      // Phase 999.187 — flush files land beside the daily logs (memoryDir).
      workspacePath: pathDirname(resolveMemoryRoots(config).memoryDir),
      agentName: name,
      intervalMs: config.memoryFlushIntervalMs,
      getTurnsSince: (sinceTs: number) => {
        const convStore = this.memory.conversationStores.get(name);
        const convSessionId = this.activeConversationSessionIds.get(name);
        if (!convStore || !convSessionId) return [];
        const turns = convStore.getTurnsForSession(convSessionId);
        // Filter to turns created after sinceTs (epoch ms). ConversationTurn
        // carries an ISO createdAt — parse once per turn. When parsing fails
        // (defensive), include the turn rather than silently drop it.
        return turns.filter((t) => {
          const ts = Date.parse(t.createdAt);
          return Number.isFinite(ts) ? ts > sinceTs : true;
        });
      },
      summarize: (prompt, opts) =>
        this.summarizeFn(prompt, { signal: opts.signal }),
      log: this.log.child({ memoryFlush: name }),
    });
    timer.start();
    this.memoryFileFlushTimers.set(name, timer);
    this.log.info(
      { agent: name, intervalMs: config.memoryFlushIntervalMs },
      "memory-file flush timer started (MEM-04)",
    );
  }

  /**
   * Phase 90 MEM-04 — stop the disk-flush timer for `name`. Safe to call
   * when no timer is registered (no-op). Does NOT await in-flight flush —
   * use awaitMemoryFileFinalFlush for that (stopAgent path).
   */
  private stopMemoryFileFlushTimer(name: string): void {
    const timer = this.memoryFileFlushTimers.get(name);
    if (timer) {
      timer.stop();
      this.memoryFileFlushTimers.delete(name);
    }
  }

  /**
   * Phase 90 MEM-04 D-29 — final flush with 10s cap, invoked by stopAgent
   * BEFORE handle.close() so the final session delta lands on disk. Both
   * paths (resolve / 10s-timeout) log and fall through — a stuck summarizer
   * must not block operator-initiated stops.
   */
  private async awaitMemoryFileFinalFlush(name: string): Promise<void> {
    const timer = this.memoryFileFlushTimers.get(name);
    if (!timer) return;
    try {
      await Promise.race([
        timer.flushNow(),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error("flush timeout")), 10_000),
        ),
      ]);
    } catch (err) {
      this.log.warn(
        { agent: name, err: (err as Error).message },
        "final memory-file flush hit 10s cap or failed (non-fatal)",
      );
    } finally {
      timer.stop();
      this.memoryFileFlushTimers.delete(name);
    }
  }

  /**
   * Dispatch a turn to the named agent and await the result.
   *
   * (Renamed from the previous "send-to-agent" framing in Phase 999.2 D-RNI-01 —
   *  it was misleading; this method dispatches a turn and waits for the
   *  response, whether the target is the caller's own agent
   *  (heartbeat/inbox), a fork (escalation), or a true peer (cross-agent IPC).)
   *
   * Signature is identical to the prior method (D-RNI-03):
   * @param name      Target agent name.
   * @param message   Turn content.
   * @param turn      Optional pre-constructed Turn (caller-owned lifecycle,
   *                  Phase 50). The caller (DiscordBridge / Scheduler) constructs
   *                  the Turn via `getTraceCollector(name).startTurn(...)` and
   *                  owns `turn.end()`. SessionManager is pure passthrough — it
   *                  does NOT create or end Turn objects.
   * @param options   Optional `{ signal }` abort handle (Phase 59).
   * @returns         Resolves with the agent's response string.
   * @throws SessionError if the agent is not running.
   */
  async dispatchTurn(
    name: string,
    message: string,
    turn?: Turn,
    // Phase 59 (signal); Phase 999.165 (onToolUse — workflow live status,
    // forwarded verbatim into SendOptions like streamFromAgent's).
    options?: {
      readonly signal?: AbortSignal;
      readonly onToolUse?: (name: string, input?: unknown) => void;
    },
  ): Promise<string> {
    // 260419-q2z Fix B — reject new turns once drain() has been called.
    if (this.draining) {
      throw new SessionError(
        `shutting down, agent '${name}' is no longer accepting turns`,
        name,
      );
    }
    const handle = this.requireSession(name);
    this.log.info({ agent: name, messageLength: message.length }, "sending message to agent");
    const response = await handle.sendAndCollect(message, turn, options);
    this.log.info({ agent: name, responseLength: response.length }, "agent responded");
    return response;
    // NOTE: SessionManager does NOT call turn.end() — caller owns Turn lifecycle (50-02b).
    // If the handle throws, the exception propagates and the caller's try/catch ends the turn with 'error'.
  }

  /**
   * @throws SessionError if the agent is not running
   *
   * Accepts an OPTIONAL pre-constructed Turn (caller-owned lifecycle, Phase 50).
   * See dispatchTurn docstring for the lifecycle contract.
   */
  async streamFromAgent(
    name: string,
    message: string,
    onChunk: (accumulated: string) => void,
    turn?: Turn,
    // Phase 59 (signal); UX-C 2026-08-26 (onToolUse — forwarded verbatim
    // into SendOptions, where the persistent handle already threads it;
    // undefined ⇒ byte-identical legacy path).
    options?: {
      readonly signal?: AbortSignal;
      readonly onToolUse?: (name: string, input?: unknown) => void;
      /** Phase 999.154 — native image blocks, forwarded to SendOptions.images. */
      readonly images?: ReadonlyArray<SendImageInput>;
    },
  ): Promise<string> {
    // 260419-q2z Fix B — reject new turns once drain() has been called.
    if (this.draining) {
      throw new SessionError(
        `shutting down, agent '${name}' is no longer accepting turns`,
        name,
      );
    }
    const handle = this.requireSession(name);
    this.log.info(
      { agent: name, messageLength: message.length, images: options?.images?.length ?? 0 },
      "streaming message to agent",
    );
    const response = await handle.sendAndStream(message, onChunk, turn, options);
    this.log.info({ agent: name, responseLength: response.length }, "agent stream complete");
    return response;
    // NOTE: SessionManager does NOT call turn.end() — caller owns Turn lifecycle (50-02b).
  }

  /**
   * Set the reasoning effort level for a running agent. Takes effect on next turn.
   * Phase 83 EFFORT-04 — accepts the full v2.2 EffortLevel set.
   * Phase 83 Plan 02 EFFORT-03 — persist to disk so the override survives
   * `clawcode restart <name>`. Fire-and-forget: the runtime side-effect is
   * already on the handle; persistence is best-effort. A persistence failure
   * MUST NOT block the caller — the SDK call has already fired.
   */
  setEffortForAgent(name: string, level: EffortLevel): void {
    const handle = this.requireSession(name);
    // Quick 260715-j1j (D6) — central ultracode eligibility gate. Shared
    // automatically by the Discord slash path and the set-effort IPC (both
    // call this method). Throws typed so the caller renders the gate's
    // operator-readable reason as its ephemeral reply (same pattern as
    // ModelNotAllowedError in setModelForAgent below).
    // Review WR-02 — capability is checked against the CURRENT RUNTIME model
    // first (handle.getModel() = the id most recently passed to setModel, or
    // the session-start id): an operator may have /clawcode-model-switched an
    // opus/fable agent down to sonnet/haiku since boot, and the running CLI
    // would reject ultracode while the fire-and-forget .catch swallows it —
    // a false success. Falls back to the config model when the handle has no
    // runtime id yet (resolveModelFamily accepts aliases AND concrete ids).
    if (level === "ultracode") {
      const config = this.getAgentConfig(name);
      const eligibility = checkUltracodeEligibility({
        model: handle.getModel() ?? config?.model,
        nativeWorkflow: config?.nativeWorkflow,
      });
      if (!eligibility.ok) {
        throw new UltracodeNotAllowedError(name, eligibility.reason);
      }
    }
    handle.setEffort(level);
    this.log.info({ agent: name, effort: level }, "effort level updated");
    // Best-effort persistence — see docblock above.
    void writeEffortState(this.effortStatePath, name, level, this.log).catch((err) => {
      this.log.warn(
        { agent: name, error: (err as Error).message },
        "effort-state persist failed (non-fatal)",
      );
    });
  }

  /**
   * 999.63d (INC 2026-08-26 effort-clobber fix) — TRANSIENT effort set
   * for MACHINERY pins: the financial-verification corrective hop's
   * low-pin + restore and the skill-effort pin + restore. Applies to the
   * live handle only and NEVER writes effort-state.json — the durable
   * store records OPERATOR intent exclusively (slash command / IPC via
   * `setEffortForAgent`).
   *
   * Root cause being fixed: pins persisted through `setEffortForAgent`,
   * so (a) a crash/restart between pin-persist and restore-persist left
   * the pin value ("low") as a durable operator override, and (b) a pin
   * firing after session start but BEFORE the async boot-time persisted-
   * override re-apply snapshotted the CONFIG effort and "restored" it
   * over the operator's stored override (observed: fin-client
   * xhigh → high, effort-state.json written at the exact ms of a hop's
   * falsePositiveAck).
   *
   * No ultracode eligibility gate: a transient call only pins DOWN (low /
   * skill levels; ultracode is clamped upstream) or restores a level that
   * was live on this handle moments earlier.
   */
  setEffortForAgentTransient(name: string, level: EffortLevel): void {
    const handle = this.requireSession(name);
    handle.setEffort(level);
    this.log.debug(
      { agent: name, effort: level },
      "effort level updated (transient — not persisted)",
    );
  }

  /**
   * 999.105 — set the runtime output style for an agent. `default` CLEARS the
   * override (map delete + state-file removal) so the baseline is the absence
   * of an overlay, never a stored "be default". Takes effect on the agent's
   * next turn — no restart, no handle call (there is no native seam; spike F1).
   * Unlike setEffortForAgent this does not require a RUNNING session: style is
   * daemon-side state, and pre-setting a stopped agent is harmless.
   */
  setStyleForAgent(name: string, style: OutputStyleId): void {
    const parsed = outputStyleSchema.safeParse(style);
    if (!parsed.success) {
      throw new Error(`unknown output style: ${String(style)}`);
    }
    if (!this.getAgentConfig(name)) {
      throw new Error(`unknown agent: ${name}`);
    }
    if (style === "default") {
      this.styleOverrides.delete(name);
      void clearStyleState(this.styleStatePath, name, this.log).catch((err) => {
        this.log.warn(
          { agent: name, error: (err as Error).message },
          "style-state clear failed (non-fatal)",
        );
      });
    } else {
      this.styleOverrides.set(name, style);
      void writeStyleState(this.styleStatePath, name, style, this.log).catch((err) => {
        this.log.warn(
          { agent: name, error: (err as Error).message },
          "style-state persist failed (non-fatal)",
        );
      });
    }
    this.log.info({ agent: name, style }, "output style updated");
  }

  /**
   * 999.105 — resolved style at dispatch time: runtime override, else the
   * YAML baseline (agent ?? defaults, already cascaded by the loader), else
   * "default" (no overlay).
   */
  getStyleForAgent(name: string): OutputStyleId {
    const override = this.styleOverrides.get(name);
    if (override) return override;
    const configured = this.getAgentConfig(name)?.outputStyle;
    const parsed = outputStyleSchema.safeParse(configured);
    return parsed.success ? parsed.data : "default";
  }

  /** 999.105 — runtime overrides snapshot (slash `status` rendering). */
  getStyleOverrides(): ReadonlyMap<string, OutputStyleId> {
    return new Map(this.styleOverrides);
  }

  /** Get the current reasoning effort level for a running agent. */
  getEffortForAgent(name: string): EffortLevel {
    const handle = this.requireSession(name);
    return handle.getEffort();
  }

  /**
   * Phase 86 MODEL-03 / MODEL-06 — set the active model for a running agent
   * via SDK Query.setModel. Validates `alias` against the agent's resolved
   * `allowedModels` BEFORE dispatching to the handle. Throws
   * ModelNotAllowedError (typed) on violation so the caller (IPC / slash
   * command) can render an ephemeral error with the allowed list.
   *
   * Plan 02 adds atomic YAML persistence AFTER this call returns; the
   * persistence path is owned by the daemon IPC handler to keep
   * SessionManager single-responsibility.
   *
   * `alias` is a config alias (e.g. "sonnet"); this method resolves it
   * to a full SDK model id via resolveModelId (same helper used by
   * session-adapter.ts). Runtime-only: does NOT modify clawcode.yaml.
   *
   * @throws SessionError if the agent is not running
   * @throws ModelNotAllowedError if alias is not in the agent's allowedModels
   */
  // Phase 999.98 W-1 — WIDENED to include "fable" (live `/clawcode-model`
  // switch path; cast-narrowing here would break live-switching to Fable). The
  // per-agent `allowedModels` allowlist below still gates whether a given agent
  // may switch to fable — type-acceptance and runtime-permission are separate.
  // Phase 999.114 — `ConfigModel` (catalog-derived) replaces the hand-listed
  // 4-literal union so every historical pin AND every `<family>@latest` track
  // is a valid live-switch target.
  //
  // `resolvedId` lets the CALLER supply the concrete SDK id. That is required
  // for `<family>@latest`, whose resolution needs the discovered-model catalog
  // snapshot the daemon owns and this class does not. Omitted for a plain
  // alias, which `resolveModelId` handles on its own.
  setModelForAgent(name: string, alias: ConfigModel, resolvedId?: string): void {
    const handle = this.requireSession(name);
    const config = this.configs.get(name);
    // Defensive — configs is always populated for running agents (set in
    // startAgent), but an allowlist violation must fail loud if somehow
    // reached without a config entry.
    // Defensive fallback only — a running agent always has a resolved config
    // (and therefore a resolved `allowedModels`). Phase 999.114: falls back to
    // the catalog's DEFAULT_PICKER_MODELS rather than a hardcoded 3-set, so the
    // fallback can never be narrower than the shipped picker default.
    const allowed = (config?.allowedModels ??
      DEFAULT_PICKER_MODELS) as readonly string[];
    if (!allowed.includes(alias)) {
      throw new ModelNotAllowedError(name, alias, allowed);
    }
    const modelId = resolvedId ?? resolveModelId(alias);
    handle.setModel(modelId);
    this.log.info({ agent: name, model: alias, modelId }, "model updated");
  }

  /**
   * Phase 86 MODEL-07 — current live model alias/id for /clawcode-status.
   * Returns the most recent id dispatched to the handle, or undefined when
   * the session started without a model and setModel was never called.
   *
   * @throws SessionError if the agent is not running
   */
  getModelForAgent(name: string): string | undefined {
    const handle = this.requireSession(name);
    return handle.getModel();
  }

  /**
   * Phase 87 CMD-02 — set the permission mode for a running agent via
   * SDK Query.setPermissionMode. Validates the mode is one of the 6
   * supported values before dispatch. Runtime-only — does NOT modify
   * clawcode.yaml (unlike setModelForAgent's Plan 02 path; permissions are
   * intentionally ephemeral and reset on restart).
   *
   * Unlike setModelForAgent, there is NO per-agent allowlist: every agent
   * can set every PermissionMode by design. The only validation is the
   * STATIC 6-value union.
   *
   * @throws SessionError if the agent is not running
   * @throws Error if mode is not a valid PermissionMode
   */
  setPermissionModeForAgent(name: string, mode: string): void {
    const handle = this.requireSession(name);
    const validModes: readonly PermissionMode[] = [
      "default",
      "acceptEdits",
      "bypassPermissions",
      "plan",
      "dontAsk",
      "auto",
    ];
    if (!validModes.includes(mode as PermissionMode)) {
      throw new Error(
        `Invalid permission mode '${mode}'. Valid: ${validModes.join(", ")}`,
      );
    }
    handle.setPermissionMode(mode as PermissionMode);
    this.log.info({ agent: name, permissionMode: mode }, "permission mode updated");
  }

  /**
   * Phase 87 CMD-02 — current live permission mode for a running agent.
   * Returns the value most recently passed to setPermissionModeForAgent, or
   * the session-start default ("default" when unset).
   *
   * @throws SessionError if the agent is not running
   */
  getPermissionModeForAgent(name: string): PermissionMode {
    const handle = this.requireSession(name);
    return handle.getPermissionMode();
  }

  /** @throws SessionError if the agent is not running */
  async forwardToAgent(name: string, message: string): Promise<void> {
    const handle = this.requireSession(name);
    this.log.info({ agent: name, messageLength: message.length }, "forwarding message to agent");
    await handle.send(message);
  }

  async forkSession(agentName: string, options?: ForkOptions): Promise<ForkResult> {
    if (!this.sessions.has(agentName)) {
      throw new SessionError(`Agent '${agentName}' is not running`, agentName);
    }
    const parentConfig = this.configs.get(agentName);
    if (!parentConfig) {
      throw new SessionError(`Config for agent '${agentName}' not found`, agentName);
    }
    const forkName = buildForkName(agentName);
    await this.startAgent(forkName, buildForkConfig(parentConfig, forkName, options));
    const sessionId = this.sessions.get(forkName)?.sessionId ?? "unknown";
    this.log.info({ parent: agentName, fork: forkName, sessionId }, "session forked");
    return { forkName, parentAgent: agentName, sessionId };
  }

  /** @throws SessionError if the agent is not running */
  async stopAgent(name: string): Promise<void> {
    return this.withLifecycleLock(name, () => this.stopAgentCore(name));
  }

  /**
   * INC-2026-06-04 — bound the SDK session close.
   *
   * `handle.close()` awaits the `claude` child's exit with no cap. A wedged
   * child (ignoring SIGTERM) made the serial 14-agent stopAll hang past
   * systemd's TimeoutStopSec, so systemd SIGKILL'd the whole cgroup — leaving
   * orphans and (next boot) the crash-loop conditions. Cap the close: a child
   * still alive after the cap is abandoned here and reaped by systemd's cgroup
   * kill on process exit. We bound the close specifically (NOT the whole stop)
   * so the summarization/flush steps keep their own 10s caps and we never drop
   * a healthy agent's final summary. Registry writes stay serial → no race.
   */
  private async closeHandleWithTimeout(
    handle: { close: () => Promise<void> },
    name: string,
    capMs = 8_000,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), capMs);
    });
    try {
      const result = await Promise.race([
        handle.close().then(() => "closed" as const),
        timeout,
      ]);
      if (result === "timeout") {
        this.log.warn(
          { agent: name, capMs },
          "handle.close() exceeded cap during stop — abandoning (systemd cgroup kill reaps the wedged child on exit)",
        );
      }
    } catch (err) {
      this.log.warn(
        { agent: name, error: (err as Error).message },
        "handle.close() threw during stop (non-fatal)",
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async stopAgentCore(name: string): Promise<void> {
    const handle = this.requireSession(name);
    this.briefCache.invalidate(name); // Phase 73 Plan 02 — LAT-02
    this.recovery.clearStabilityTimer(name);
    this.recovery.clearRestartTimer(name);
    // Phase 141 (C) — for v3 (claude-code-interactive) agents, transition the
    // PtySupervisor to "stopped" BEFORE the killAgentGroup below. stop() detaches
    // the supervisor's exit listener (so the kill does NOT fire onChildExit →
    // respawn) and group-kills the child via the now-wired tracker. Without this
    // the supervisor stays "running" and resurrects archived/stalled subagents
    // (the Phase-141 Workstream-C leak). No-op for non-v3 agents (map miss) and
    // when stop() is unimplemented (optional seam). Best-effort: a stop failure
    // must never block operator/teardown stop.
    try {
      const { liveSupervisorByAgent } = await import(
        "../llm-runtime/backends/claude-code-interactive.js"
      );
      await liveSupervisorByAgent.get(name)?.stop?.();
    } catch (err) {
      this.log.warn(
        { agent: name, err: String(err) },
        "v3 supervisor stop failed during stopAgent (non-fatal)",
      );
    }
    // Phase 999.14 MCP-02 — fire process-group SIGTERM at the agent's tracked
    // MCP PIDs BEFORE handle.close (the SDK teardown). killAgentGroup is
    // idempotent (ESRCH treated as success), so a second invocation from the
    // PSH disconnect handler is a safe no-op. Wrapped in try/catch so a
    // tracker failure NEVER blocks stopAgent — operator-initiated stop must
    // always complete cleanly even if /proc is misbehaving.
    if (this.mcpTracker) {
      try {
        await this.mcpTracker.killAgentGroup(name, 5_000);
      } catch (err) {
        this.log.error(
          { agent: name, err: String(err) },
          "tracker.killAgentGroup failed during stopAgent (non-fatal)",
        );
      }
    }
    // Gap 3 (memory-persistence-gaps): stop the flush timer BEFORE
    // summarization so a timer tick cannot race against endSession and
    // try to flush a session that has just transitioned out of 'active'.
    this.stopFlushTimer(name);

    // Phase 90 MEM-04 D-29 — final disk flush with 10s cap BEFORE
    // handle.close. Awaits an in-flight flush OR starts a final one
    // (skip heuristic applies — no flush if no meaningful turns since
    // last tick). Sibling to the Gap 3 DB-summarization cleanup above;
    // distinct concerns (DB memories vs disk markdown).
    await this.awaitMemoryFileFinalFlush(name);

    // Phase 65: end the ConversationStore session before memory cleanup
    const convSessionId = this.activeConversationSessionIds.get(name);
    const convStoreForStop = this.memory.conversationStores.get(name);
    if (convStoreForStop && convSessionId) {
      try { convStoreForStop.endSession(convSessionId); } catch { /* session may already be ended */ }
      // Phase 66 -- awaited summarization (bounded by its internal 10s
      // timeout). MUST run BEFORE cleanupMemory because cleanupMemory closes
      // the MemoryStore + ConversationStore connections. Wrapped in try/catch
      // so a summarization failure never blocks a stop.
      try {
        // 260419-q2z Fix B — track stop-path summary so drain() waits for it.
        await this.trackSummary(
          this.summarizeSessionIfPossible(name, convSessionId),
        );
      } catch (err) {
        this.log.warn(
          {
            agent: name,
            session: convSessionId,
            error: (err as Error).message,
          },
          "stop-path summarization failed (non-fatal)",
        );
      }
    }
    this.activeConversationSessionIds.delete(name);

    this.memory.cleanupMemory(name);

    await mutateRegistry(this.registryPath, (current) =>
      updateEntry(current, name, { status: "stopping" }),
    );

    await this.closeHandleWithTimeout(handle, name);
    this.sessions.delete(name);
    // Phase 103 OBS-01/02 — clear synchronous /clawcode-status mirrors. Counter
    // resets on stop (matches in-memory-only semantics — Open Q4); activation
    // mirror cleared so the post-stop accessor read returns undefined.
    this.compactionCounts.delete(name);
    this.activationAtByAgent.delete(name);
    // Phase 103 OBS-04 — drop the per-agent RateLimitTracker reference. The
    // underlying SQLite snapshot rows survive (the UsageTracker DB is closed
    // by AgentMemoryManager.cleanupMemory above) so a subsequent restart
    // restores them on next RateLimitTracker construction.
    this.rateLimitTrackers.delete(name);
    // Phase 52 Plan 02 — drop per-agent cache-prefix state so a fresh start
    // records cacheEvictionExpected=false on turn 1 (no prior hash).
    this.lastPrefixHashByAgent.delete(name);
    this.lastHotStableTokenByAgent.delete(name);
    this.latestStablePrefixByAgent.delete(name);
    // Phase 53 Plan 03 — clear per-agent skill-usage buffer so a restart
    // warms up cleanly (no stale mentions from prior session).
    this.skillUsageTracker.resetAgent(name);
    // Phase 85 Plan 01 TOOL-01 — drop per-agent MCP state so a restart
    // starts clean (no stale failed-server entries from a prior session).
    this.mcpStateByAgent.delete(name);
    // Phase 89 D-14 — reset cool-down on agent stop so an operator-initiated
    // stop + restart sequence bypasses the 5-min suppression (operator intent
    // is NOT a crash loop).
    this.greetCoolDownByAgent.delete(name);
    // Phase 90 MEM-02 — stop the chokidar watcher + drop the reference.
    // Swallow errors (a mid-close watcher on a unit-tested path shouldn't
    // block agent stop). Scheduled for a future unit-level refactor if
    // chokidar close() starts throwing during daemon shutdown.
    const scanner = this.memoryScanners.get(name);
    if (scanner) {
      this.memoryScanners.delete(name);
      void scanner.stop().catch((err) => {
        this.log.warn(
          { agent: name, error: (err as Error).message },
          "memory-scanner stop failed (non-fatal)",
        );
      });
    }

    // clawdy-v2-stability (2026-04-19): record stoppedAt so reconcileRegistry's
    // TTL-prune pass can reap stale subagent/thread gravestones. Parent agents
    // also get the timestamp but are never TTL-reaped — only sub/thread entries.
    await mutateRegistry(this.registryPath, (current) =>
      updateEntry(current, name, {
        status: "stopped",
        sessionId: null,
        stoppedAt: Date.now(),
      }),
    );

    // Invoke session end callback (e.g., subagent thread cleanup)
    const endCallback = this.sessionEndCallbacks.get(name);
    if (endCallback) {
      this.sessionEndCallbacks.delete(name);
      try {
        await endCallback();
      } catch (err) {
        this.log.warn({ agent: name, error: (err as Error).message }, "session end callback failed");
      }
    }

    this.log.info({ agent: name }, "agent stopped");
  }

  /**
   * Quick task 260419-nic — interrupt the agent's in-flight SDK turn.
   *
   * Returns a 2-flag result so callers (e.g., Discord `/clawcode-interrupt`
   * slash handler) can render the right ephemeral message:
   *   - hadActiveTurn=false, interrupted=false → "No active turn for X"
   *   - hadActiveTurn=true,  interrupted=true  → "Stopped X mid-turn"
   *
   * No-op (returns {false,false}) when:
   *   - the agent is not in this.sessions (never started / already stopped)
   *   - the handle does not expose interrupt/hasActiveTurn (legacy handles)
   *   - hasActiveTurn() returns false
   *
   * Throws if handle.interrupt() itself throws — caller (slash-command layer)
   * surfaces the error ephemerally.
   */
  async interruptAgent(
    name: string,
  ): Promise<{ readonly interrupted: boolean; readonly hadActiveTurn: boolean }> {
    const handle = this.sessions.get(name);
    if (!handle) {
      return { interrupted: false, hadActiveTurn: false };
    }
    // Phase 141 (#13) — v3 (claude-code-interactive) agents run their turn in a
    // PTY child, NOT the daemon's inert Query. The inert handle exposes
    // interrupt()/hasActiveTurn(), but hasActiveTurn() is ALWAYS false (the
    // daemon never drives the turn) → the gate below would short-circuit and the
    // real PTY turn would never be interrupted. Abort it instead by writing a
    // Ctrl-C (\x03) straight to the live PTY via the supervisor registry.
    // NOTE: whether \x03 actually aborts a `claude --channels` turn (vs being
    // swallowed at a non-prompt point) is UNVERIFIED — it needs a live canary.
    // The wiring is mechanical and a swallowed \x03 is a harmless no-op (no worse
    // than today's inert no-op), so landing the wiring is safe ahead of the canary.
    const cfg = this.configs.get(name);
    if (cfg?.llmRuntime?.backend === "claude-code-interactive") {
      const { debugWriteToPtyForAgent } = await import(
        "../llm-runtime/backends/claude-code-interactive.js"
      );
      const r = debugWriteToPtyForAgent(name, "\x03");
      if (r.ok) {
        this.log.info(
          { agent: name, event: "agent_interrupted", via: "pty-ctrl-c" },
          "v3 agent turn interrupt (Ctrl-C written to PTY)",
        );
      } else {
        this.log.warn(
          { agent: name, reason: r.reason },
          "v3 interrupt could not reach the PTY",
        );
      }
      // hadActiveTurn is unknowable from the daemon on v3 (it can't see the PTY's
      // turn state); a successful write is the best available signal.
      return { interrupted: r.ok, hadActiveTurn: r.ok };
    }
    // Duck-type guard — legacy wrapSdkQuery handles (used by the test-only
    // createTracedSessionHandle) do expose stubs for these, but newer MCP
    // adapters or custom handles may not. Belt-and-suspenders.
    if (
      typeof handle.interrupt !== "function" ||
      typeof handle.hasActiveTurn !== "function"
    ) {
      return { interrupted: false, hadActiveTurn: false };
    }
    if (!handle.hasActiveTurn()) {
      return { interrupted: false, hadActiveTurn: false };
    }
    try {
      handle.interrupt();
    } catch (err) {
      this.log.warn(
        { agent: name, error: (err as Error).message },
        "interrupt failed",
      );
      throw err;
    }
    this.log.info(
      { agent: name, event: "agent_interrupted" },
      "agent turn interrupted",
    );
    return { interrupted: true, hadActiveTurn: true };
  }

  /**
   * Quick task 260419-nic — expose the handle's hasActiveTurn() for the
   * `/clawcode-steer` slash-command's poll loop. Returns false when the
   * agent is not running OR the handle predates the Task 1 primitive.
   */
  hasActiveTurn(name: string): boolean {
    const handle = this.sessions.get(name);
    if (!handle) return false;
    if (typeof handle.hasActiveTurn !== "function") return false;
    return handle.hasActiveTurn();
  }

  /**
   * Phase 999.100 — push a steering message into the agent's RUNNING turn
   * (no interrupt). Delegates to the v2 persistent handle's injectMidTurn;
   * feature-checks so v3 adapters / legacy mocks (no method) report
   * `unsupported` and the bridge falls back to the normal queued dispatch.
   * Fail-open by construction: every decline reason maps to "behave like
   * the feature is off".
   */
  injectMidTurn(
    name: string,
    text: string,
    opts?: { readonly maxPerTurn?: number },
  ): { injected: boolean; reason?: "closed" | "idle" | "cap" | "unsupported" } {
    const handle = this.sessions.get(name);
    if (!handle || typeof handle.injectMidTurn !== "function") {
      return { injected: false, reason: "unsupported" };
    }
    return handle.injectMidTurn(text, opts);
  }

  /**
   * 999.99 review — capability probe for the bridge's steering gate:
   * true only when the agent's LIVE session was built with the
   * attributed-stream demux. False for legacy sessions, v3 adapters, and
   * not-running agents — the steering feature stays inert there (a
   * steering stop on a legacy session would re-seed the off-by-one).
   */
  hasAttributedStream(name: string): boolean {
    const handle = this.sessions.get(name);
    if (!handle || typeof handle.hasAttributedStream !== "function") return false;
    return handle.hasAttributedStream();
  }

  /**
   * 999.99 review — whether a self-fired (orphan) turn is streaming on the
   * agent's session RIGHT NOW. The 999.64 stale-turn sweep consults this
   * before force-releasing: a daemon turn waiting behind a long foreign
   * turn is healthy, and the interrupt would land on the foreign turn.
   */
  isOrphanTurnOpen(name: string): boolean {
    const handle = this.sessions.get(name);
    if (!handle || typeof handle.isOrphanTurnOpen !== "function") return false;
    return handle.isOrphanTurnOpen();
  }

  /**
   * Phase 124 follow-up — surface the in-flight turn's start timestamp.
   *
   * Mirrors the `hasActiveTurn` shape: returns null when the agent is not
   * running, the handle predates the primitive (legacy mocks / wrapSdkQuery
   * paths), or no turn is in-flight. Read by the daemon's `compact-session`
   * dep-builder to enforce the ERR_TURN_TOO_LONG safety budget — the
   * handler resolves it through a per-agent `ReadonlyMap<string, number>`,
   * but the source of truth is the handle's slot, not a daemon-side map.
   */
  getTurnStartedAt(name: string): number | null {
    const handle = this.sessions.get(name);
    if (!handle) return null;
    if (typeof handle.getTurnStartedAt !== "function") return null;
    return handle.getTurnStartedAt();
  }

  /**
   * Quick task 260521-4sa (999.64) — surface the in-flight turn's last
   * SDK-activity timestamp. Mirrors the `getTurnStartedAt` duck-type shape:
   * returns null when the agent is not running, the handle predates the
   * primitive (legacy mocks / wrapSdkQuery paths), or no turn is in-flight.
   * Read by the heartbeat inbox stale-lock watchdog.
   */
  getLastTurnActivityAt(name: string): number | null {
    const handle = this.sessions.get(name);
    if (!handle) return null;
    if (typeof handle.getLastTurnActivityAt !== "function") return null;
    return handle.getLastTurnActivityAt();
  }

  /**
   * Quick task 260521-4sa (999.64) — force-release a wedged turn lock.
   *
   * Delegates to the handle's `forceReleaseTurn()` (which fires `interrupt()`
   * then identity-clears the SerialTurnQueue slot). Returns true iff a turn
   * was actually released. Safe default `false` when the agent is not
   * running or the handle predates the primitive. Driven by the heartbeat
   * inbox stale-lock watchdog; the forensic log line is owned by that caller.
   */
  forceReleaseTurn(name: string): boolean {
    const handle = this.sessions.get(name);
    if (!handle) return false;
    if (typeof handle.forceReleaseTurn !== "function") return false;
    return handle.forceReleaseTurn();
  }

  /**
   * Debug session `in-tool-wedge-recovery` work-stream (C), FORK 8 —
   * clean-detach-or-force-release a wedged turn.
   *
   * Delegates to the handle's `tryBackgroundOrRelease()` — which detaches
   * a wedged Bash/Task tool via `Query.backgroundTasks` (turn resumes,
   * `"detached"`) or falls back to `forceReleaseTurn()` for an MCP-tool
   * wedge / mixed batch / nothing-detached (`"released"`).
   *
   * Graceful degradation: a legacy handle that predates
   * `tryBackgroundOrRelease` falls back to the plain `forceReleaseTurn()`
   * delegator here, so the 999.64 sweep keeps working unchanged on old
   * handles. `"no-turn"` when the agent is not running / no turn in
   * flight. NEVER throws — a thrown `tryBackgroundOrRelease` is trapped
   * and degraded to a `forceReleaseTurn()` attempt. Driven by the
   * heartbeat stale-turn sweep; the forensic log lines are owned there.
   */
  async backgroundOrReleaseStaleTurn(
    name: string,
  ): Promise<"detached" | "released" | "no-turn"> {
    const handle = this.sessions.get(name);
    if (!handle) return "no-turn";
    if (typeof handle.tryBackgroundOrRelease === "function") {
      try {
        return await handle.tryBackgroundOrRelease();
      } catch {
        // Trapped — degrade to the blunt force-release below so a sick
        // SDK can never leave a wedged turn un-recovered.
      }
    }
    // Legacy handle (no tryBackgroundOrRelease) OR the detach path threw:
    // fall back to the plain force-release.
    if (typeof handle.forceReleaseTurn !== "function") return "no-turn";
    return handle.forceReleaseTurn() ? "released" : "no-turn";
  }

  /**
   * Debug session `in-tool-wedge-recovery` work-stream (B) — fetch the
   * SDK's per-MCP-tool read-only/destructive annotations for an agent.
   *
   * Delegates to the handle's `getMcpToolAnnotations()` (which calls
   * `q.mcpServerStatus()` and projects the result). Returns an empty
   * array when the agent is not running, the handle predates the
   * primitive, or the SDK call fails — the wedge classifier then falls
   * back to its static clawcode-MCP allowlist. NEVER throws. Called at
   * most once per wedge by the Discord recovery layer.
   */
  async getMcpToolAnnotationsForAgent(
    name: string,
  ): Promise<
    readonly import("./tool-mutation-classifier.js").McpToolAnnotationSnapshot[]
  > {
    const handle = this.sessions.get(name);
    if (!handle) return [];
    if (typeof handle.getMcpToolAnnotations !== "function") return [];
    try {
      return await handle.getMcpToolAnnotations();
    } catch {
      return [];
    }
  }

  /**
   * 2026-09-24 remote-mcp-reconnect — the agent's live claude CLI pid, or
   * null when not running / not yet spawned / non-SDK backend.
   */
  getClaudePidForAgent(name: string): number | null {
    return this.sessions.get(name)?.getClaudePid?.() ?? null;
  }

  /**
   * 2026-09-24 remote-mcp-reconnect — SDK status per MCP server. Empty map
   * when the agent is not running or the handle predates the primitive.
   * NEVER throws.
   */
  async getMcpServerStatusesForAgent(
    name: string,
  ): Promise<ReadonlyMap<string, string>> {
    const handle = this.sessions.get(name);
    if (!handle || typeof handle.getMcpServerStatuses !== "function") {
      return new Map();
    }
    try {
      return await handle.getMcpServerStatuses();
    } catch {
      return new Map();
    }
  }

  /**
   * 2026-09-24 remote-mcp-reconnect — respawn one MCP server in place.
   * THROWS when the agent isn't running, the backend lacks the primitive,
   * or the SDK reconnect fails.
   */
  async reconnectMcpServerForAgent(
    name: string,
    serverName: string,
  ): Promise<void> {
    const handle = this.sessions.get(name);
    if (!handle) throw new Error(`agent '${name}' is not running`);
    if (typeof handle.reconnectMcpServer !== "function") {
      throw new Error("reconnectMcpServer not supported by this handle");
    }
    await handle.reconnectMcpServer(serverName);
  }

  async restartAgent(name: string, config: ResolvedAgentConfig): Promise<void> {
    return this.withLifecycleLock(name, () => this.restartAgentCore(name, config));
  }

  private async restartAgentCore(name: string, config: ResolvedAgentConfig): Promise<void> {
    // Phase 90.1 hotfix — tolerate "agent not running" at the stop step.
    // Previously, restartAgent threw when called on a stopped agent, forcing
    // daemon.ts IPC handler to fall back to plain startAgent() which bypasses
    // the Phase 89 greeting. Now we log-and-continue so the greeting block
    // at the end of this method always runs.
    try {
      // *Core (not the public locked stopAgent) — we already hold this agent's
      // lifecycle lock; calling the locked method would queue behind ourselves
      // and deadlock.
      await this.stopAgentCore(name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not running|no such session|requireSession/i.test(msg)) {
        this.log.info(
          { agent: name },
          "[restart] agent was already stopped — continuing to start + greeting",
        );
      } else {
        throw err;
      }
    }
    const prevEntry = (await readRegistry(this.registryPath)).entries.find(
      (e) => e.name === name,
    );
    // Phase 89 GREET-03 — capture BEFORE the restartCount bump so the
    // classifier sees the pre-restart failure state. classifyRestart
    // treats >0 as crash-suspected, 0 as clean (Finding 3 in 89-RESEARCH).
    const prevConsecutiveFailures = prevEntry?.consecutiveFailures ?? 0;
    // Atomic partial-merge bump. Safe to base the new count on the pre-read
    // prevEntry: restartAgentCore runs under the per-name withLifecycleLock, so
    // no concurrent same-name restart can race the counter, and the merge onto a
    // fresh registry preserves any cross-name/cross-field concurrent writes.
    const nextRestartCount = (prevEntry?.restartCount ?? 0) + 1;
    await mutateRegistry(this.registryPath, (current) =>
      updateEntry(current, name, { restartCount: nextRestartCount }),
    );
    await this.startAgentCore(name, config);

    // Phase 89 GREET-01 / GREET-09 — fire-and-forget greeting.
    // This MUST stay async: D-16 requires restart success to be independent
    // of Discord availability. Rejections are logged and swallowed per the
    // Phase 83 canary blueprint (see setEffortForAgent at line ~656).
    const webhookManager = this.webhookManager;
    const convStore = this.memory.conversationStores.get(name);
    // Phase 90.1 debug — log the OUTER GUARD state so we can see whether we
    // even reached sendRestartGreeting. Previously this branch was silent.
    this.log.info(
      {
        agent: name,
        hasWebhookManager: Boolean(webhookManager),
        hasConvStore: Boolean(convStore),
        hasBotDirectSender: Boolean(this.botDirectSender),
      },
      "[greeting] restartAgent: evaluating greeting guards",
    );
    if (webhookManager && convStore) {
      // Phase 99 D-fix (2026-04-25 evening): wire fast-path lookup for
      // existing summary memory entries so restart-greeting can skip the
      // 10s Haiku call when summary_memory_id is already populated.
      const memStoreForGreeting = this.memory.memoryStores.get(name);
      const getMemoryById = memStoreForGreeting
        ? (id: string) => {
            try {
              const entry = memStoreForGreeting.getById(id);
              return entry?.content;
            } catch {
              return undefined;
            }
          }
        : undefined;
      void sendRestartGreeting(
        {
          webhookManager,
          conversationStore: convStore,
          summarize: this.summarizeFn,
          getMemoryById,
          now: () => Date.now(),
          log: this.log,
          coolDownState: this.greetCoolDownByAgent,
          // Phase 90.1 hotfix — pass bot-direct fallback if wired. Greeting
          // helper uses it when no per-agent webhook is provisioned.
          botDirectSender: this.botDirectSender,
        },
        {
          agentName: name,
          config,
          restartKind: classifyRestart(prevConsecutiveFailures),
        },
      )
        .then((outcome) => {
          // Phase 90.1 debug — log every greeting outcome so silent-skip
          // classes (empty-state, cool-down, dormant, no-webhook) are
          // visible in production logs without requiring a debugger.
          this.log.info(
            { agent: name, outcome },
            "[greeting] sendRestartGreeting outcome",
          );
        })
        .catch((err: unknown) => {
          this.log.warn(
            { agent: name, error: (err as Error).message },
            "[greeting] sendRestartGreeting threw (non-fatal)",
          );
        });
    }
  }

  async startAll(configs: readonly ResolvedAgentConfig[]): Promise<void> {
    const errors: Array<{ name: string; error: Error }> = [];
    for (const config of configs) {
      // Gap 1 (memory-persistence-gaps): skip agents already resumed by
      // reconcileRegistry. Before this guard, startAll would call startAgent
      // for every config in the list, startAgent's `this.sessions.has(name)`
      // precondition would throw "already running", and the error was
      // caught + logged as a noisy `error` on every daemon boot even though
      // the outcome was correct (agent IS running).
      if (this.sessions.has(config.name)) {
        this.log.debug(
          { agent: config.name },
          "startAll: agent already running (resumed by reconcile) — skipping",
        );
        continue;
      }
      try { await this.startAgent(config.name, config); }
      catch (error) {
        errors.push({ name: config.name, error: error as Error });
        this.log.error({ agent: config.name, error: (error as Error).message }, "failed to start agent");
        // G4 (sandbox-hardening-2026-06-19): a thrown startAgent — e.g. a broken
        // sandbox bind → claude dies at init → createSession rejects — otherwise
        // leaves the registry at "starting", a misleading zombie that "only an
        // operator noticed". Record an OBSERVABLE health state so monitoring sees
        // the agent is down. Terminal "failed" (NOT recovery-scheduled) mirrors
        // the memory-init-failure path and avoids a boot-time retry storm; the
        // operator re-enables after fixing the bind (gated by the WS-4 pre-flight
        // validator). Best-effort — a registry write must not abort starting the
        // REST of the fleet (the whole point of per-agent isolation).
        try {
          await mutateRegistry(this.registryPath, (current) => {
            const seeded = current.entries.find((e) => e.name === config.name)
              ? current
              : {
                  entries: [...current.entries, createEntry(config.name)],
                  updatedAt: Date.now(),
                };
            return updateEntry(seeded, config.name, {
              status: "failed",
              lastError: `startAgent: ${(error as Error).message}`,
            });
          });
        } catch (markErr) {
          this.log.warn(
            { agent: config.name, error: (markErr as Error).message },
            "failed to mark agent 'failed' in registry after start failure (non-fatal)",
          );
        }
      }
    }
    if (errors.length > 0) {
      this.log.warn({ failed: errors.length, total: configs.length }, "some agents failed to start");
    }
  }

  async stopAll(): Promise<void> {
    const names = [...this.sessions.keys()];
    const errors: Array<{ name: string; error: Error }> = [];
    for (const name of names) {
      try { await this.stopAgent(name); }
      catch (error) { errors.push({ name, error: error as Error }); }
    }
    if (errors.length > 0) {
      this.log.warn({ failed: errors.length, total: names.length }, "some agents failed to stop");
    }
    this.log.info({ stopped: names.length }, "all agents stopped");
  }

  async reconcileRegistry(configs: readonly ResolvedAgentConfig[]): Promise<void> {
    // Read-only iteration snapshot. Per-entry status transitions below go
    // through the atomic mutateRegistry so they can't lose-update a concurrent
    // writer (e.g. a recovery write firing during boot reconcile).
    const registry = await readRegistry(this.registryPath);
    let resumed = 0, crashed = 0, failed = 0;

    for (const entry of registry.entries) {
      const config = configs.find((c) => c.name === entry.name);

      if (entry.status === "running" && entry.sessionId && config) {
        // 999.105 — style restore on the RESUME path too (the path most
        // agents take on a daemon restart; the effort store misses it).
        try {
          const persistedStyle = await readStyleState(this.styleStatePath, entry.name, this.log);
          if (persistedStyle) this.styleOverrides.set(entry.name, persistedStyle);
        } catch {
          /* observational only */
        }
        try {
          // Gap 1 (memory-persistence-gaps): initialize memory BEFORE
          // buildSessionConfig so the resumed agent has a MemoryStore +
          // ConversationStore. Without this, stopAgent's summarization
          // branch is a no-op because activeConversationSessionIds stays
          // empty and conversationStores.get() returns undefined.
          try {
            this.memory.initMemory(entry.name, config);
          } catch (initErr) {
            this.log.warn(
              { agent: entry.name, error: (initErr as Error).message },
              "failed to initialize memory during reconcile (resumed agent will have no memory persistence)",
            );
          }

          const sessionConfig = await buildSessionConfig(
            config,
            this.configDeps(entry.name),
          );
          // Phase 52 Plan 02 — cache latest stable bits for provider + next call.
          this.latestStablePrefixByAgent.set(
            entry.name,
            sessionConfig.systemPrompt,
          );
          if (sessionConfig.hotStableToken) {
            this.lastHotStableTokenByAgent.set(
              entry.name,
              sessionConfig.hotStableToken,
            );
          }
          const handle = await this.adapter.resumeSession(
            entry.sessionId,
            sessionConfig,
            undefined,
            this.makePrefixHashProvider(entry.name),
            this.makeSkillTracking(config),
            // Phase 117 Plan 04 T03/T04 — symmetric mirror of the
            // createSession path above (Rule 3 symmetric-edits). A
            // resumed session MUST attach the same advisor observer as
            // the original create call so post-restart advisor events
            // continue to fire on the daemon-wide EventEmitter.
            this.makeAdvisorObserver(entry.name),
          );
          this.sessions.set(entry.name, handle);
          this.configs.set(entry.name, config);

          // Gap 1 (memory-persistence-gaps): start a FRESH ConversationStore
          // session for the resumed agent. We intentionally do NOT try to
          // reattach to any orphaned 'active' row in the DB — conversation-
          // store.ts:298-303 already documents that orphans are unrecoverable
          // (we don't know when they truly ended). A fresh session keeps the
          // state machine clean and guarantees stopAgent summarization fires.
          const convStore = this.memory.conversationStores.get(entry.name);
          if (convStore) {
            try {
              const convSession = convStore.startSession(entry.name);
              this.activeConversationSessionIds.set(entry.name, convSession.id);
              // Phase 999.119 pass 2 — same stale-row close as startAgent.
              const closed = convStore.closeStaleActiveSessions(entry.name, convSession.id);
              if (closed > 0) {
                this.log.info({ agent: entry.name, closed }, "closed stale active conversation sessions from earlier runs");
              }
            } catch (err) {
              this.log.warn(
                { agent: entry.name, error: (err as Error).message },
                "failed to start conversation session during reconcile (non-fatal)",
              );
            }
          }

          this.attachCrashHandler(entry.name, config, handle);
          // 2026-08-27 — EFFORT restore on the RESUME path. This was the
          // documented "live gap" (see the 999.105 style-restore comment
          // above): startAgentCore re-applied persisted effort, reconcile
          // did not, and reconcile is the path most agents take on a daemon
          // restart. Observed 2026-08-26: `effort-state.json` said
          // fin-client=xhigh, three restarts logged 6 -> 2 -> 0
          // "re-applied" lines, and every fin-client turn after the last boot
          // ran at the yaml default `high`. Same gate + log line as the
          // start path so the two stay greppable together.
          try {
            const persisted = await readEffortState(this.effortStatePath, entry.name, this.log);
            if (persisted && persisted !== config.effort) {
              const ultracodeGate =
                persisted === "ultracode"
                  ? checkUltracodeEligibility({
                      model: config.model,
                      nativeWorkflow: config.nativeWorkflow,
                    })
                  : ({ ok: true } as const);
              if (!ultracodeGate.ok) {
                this.log.warn(
                  {
                    agent: entry.name,
                    persisted,
                    configDefault: config.effort,
                    reason: ultracodeGate.reason,
                    path: "reconcile",
                  },
                  "persisted ultracode override no longer eligible — skipping re-apply (agent keeps config default)",
                );
              } else {
                handle.setEffort(persisted);
                this.log.info(
                  { agent: entry.name, effort: persisted, configDefault: config.effort, path: "reconcile" },
                  "re-applied persisted effort override",
                );
              }
            }
          } catch (err) {
            this.log.warn(
              { agent: entry.name, error: (err as Error).message, path: "reconcile" },
              "effort restore failed on reconcile (non-fatal; agent keeps config default)",
            );
          }
          // quick task 260714-mkq — register the RESUMED main's claudePid with
          // the McpProcessTracker (mirrors startAgentCore). Without this, every
          // boot-resumed main is absent from scanForOrphanClaudes' snapshot and
          // the orphan-claude reaper alerts the whole fleet each tick;
          // reconcileAllAgents only self-heals ALREADY-registered agents, so it
          // can never add a never-registered resumed main. Fire-and-forget.
          this.registerClaudePidWithTracker(entry.name);
          this.recovery.setStabilityTimer(entry.name);
          // Gap 3 (memory-persistence-gaps): resumed sessions also get the
          // periodic flush timer so a daemon reboot doesn't silently extend
          // the at-risk window between persistence checkpoints.
          this.startFlushTimer(entry.name, config);
          resumed++;
          this.log.info({ agent: entry.name, sessionId: entry.sessionId }, "session resumed");
        } catch (error) {
          await mutateRegistry(this.registryPath, (current) =>
            updateEntry(current, entry.name, {
              status: "crashed",
              lastError: (error as Error).message,
              consecutiveFailures: entry.consecutiveFailures + 1,
            }),
          );
          this.configs.set(entry.name, config);
          this.recovery.scheduleRestart(entry.name, config, entry.consecutiveFailures + 1);
          crashed++;
          this.log.warn({ agent: entry.name, error: (error as Error).message }, "failed to resume session, marking crashed");
        }
      } else if ((entry.status === "crashed" || entry.status === "restarting") && config) {
        this.configs.set(entry.name, config);
        this.recovery.scheduleRestart(entry.name, config, entry.consecutiveFailures);
        crashed++;
      } else if (entry.status === "failed") {
        failed++;
      }
    }
    this.log.info({ total: registry.entries.length, resumed, crashed, failed }, "registry reconciliation complete");
  }

  getRunningAgents(): readonly string[] { return [...this.sessions.keys()]; }

  /**
   * 2026-07-31 memory program F2 — the registry-membership source of truth
   * for the MemoryGuard census: every managed session's live claude pid,
   * with its session name (so the census can split agent vs worker kinds
   * via spawnKindOf). Excludes `__broker:*` synthetic owners (pooled MCP
   * children are accounted separately). Best-effort: a handle without a
   * pid (starting/legacy) is simply omitted — the census degrades to its
   * ppid fallback rather than throwing.
   */
  listClaudePids(): ReadonlyArray<{ pid: number; sessionName: string }> {
    const out: Array<{ pid: number; sessionName: string }> = [];
    for (const name of this.sessions.keys()) {
      if (name.startsWith("__broker:")) continue;
      try {
        const pid = this.getSessionHandle(name)?.getClaudePid?.();
        if (typeof pid === "number" && pid > 1) {
          out.push({ pid, sessionName: name });
        }
      } catch {
        // Census is observational — never let one handle break the sweep.
      }
    }
    return out;
  }

  /**
   * Phase 87 CMD-01 — expose the per-agent SessionHandle for consumers that
   * need to read SDK-surfaced state without going through a named accessor.
   *
   * Current consumers:
   *   - SlashCommandHandler.register() — calls handle.getSupportedCommands()
   *     per agent to build the native-CC registration set (CMD-01)
   *   - Plan 02 dispatch paths — will reach through this to invoke
   *     handle.setPermissionMode / other SDK control-plane methods
   *
   * Returns undefined when the agent has never started or has been stopped.
   */
  getSessionHandle(name: string): SessionHandle | undefined {
    return this.sessions.get(name);
  }

  /**
   * Post-v2.0 hardening — single-name boolean readiness probe.
   *
   * Used by the OpenAI endpoint (src/openai/server.ts) to bound the warm-path
   * startup race. During the ~5s window between daemon start and the agent's
   * warm path completing, `streamFromAgent` / `nonStreamFromAgent` throw
   * `SessionError('not running')`. The endpoint polls this helper to decide
   * between wait-then-dispatch and a 503 Retry-After response.
   *
   * Deliberately does NOT differentiate "starting" vs "fully warm" —
   * `this.sessions.has(name)` flips to true AFTER warmupAgent returns, which
   * is exactly the gate the endpoint needs.
   */
  isRunning(name: string): boolean {
    return this.sessions.has(name);
  }

  // Memory accessors (delegate to AgentMemoryManager)
  getMemoryStore(agentName: string): MemoryStore | undefined { return this.memory.memoryStores.get(agentName); }
  getCompactionManager(agentName: string): CompactionManager | undefined { return this.memory.compactionManagers.get(agentName); }

  /**
   * Phase 999.19 — embed arbitrary text via the shared process-wide
   * `EmbeddingService`. Used by delegated-work consolidation, which writes
   * to a delegate's `MemoryStore` whose session may not be running.
   */
  embedText(text: string): Promise<Float32Array> { return this.memory.embedder.embed(text); }

  /**
   * Phase 103 OBS-02 — current compaction count for an agent.
   * Returns 0 when no compactions have occurred. In-memory only;
   * resets on daemon restart (Research Open Q4).
   */
  getCompactionCountForAgent(name: string): number {
    return this.compactionCounts.get(name) ?? 0;
  }

  /**
   * Phase 103 OBS-02 — internal hook for bumping the counter after a
   * successful CompactionManager.compact() resolve. Use compactForAgent
   * in production; this exists for the wrapper itself + future code paths
   * that need to record a compaction outside the canonical entry point.
   */
  private bumpCompactionCount(name: string): void {
    this.compactionCounts.set(name, (this.compactionCounts.get(name) ?? 0) + 1);
  }

  /**
   * Phase 103 OBS-02 — canonical entry point for triggering a compaction.
   * Wraps CompactionManager.compact so the counter bumps ONLY on resolve.
   * Reject path leaves the counter unchanged (Pitfall 3 — compactions
   * must reflect SUCCESSFUL flushes only). Returns the same
   * CompactionResult so callers see no behavior change.
   *
   * Throws SessionError when the agent has no CompactionManager (e.g.
   * the agent is not initialized).
   */
  async compactForAgent(
    name: string,
    conversation: readonly ConversationTurn[],
    extractMemories: (text: string) => Promise<readonly string[]>,
  ): Promise<CompactionResult> {
    const cm = this.memory.compactionManagers.get(name);
    if (!cm) {
      throw new SessionError(`Agent '${name}' has no CompactionManager`, name);
    }
    const result = await cm.compact(conversation, extractMemories);
    this.bumpCompactionCount(name);
    return result;
  }

  /**
   * Phase 103 OBS-01 — context-zone fillPercentage (0-1) for /clawcode-status.
   * Returns undefined when:
   *   - no HeartbeatRunner is wired (tests / minimal fixtures)
   *   - the runner has no zone data for this agent (agent stopped, or zone
   *     check has not yet run after warm-path completion)
   */
  getContextFillPercentageForAgent(name: string): number | undefined {
    const zone = this.heartbeatRunner?.getZoneStatuses().get(name);
    return zone?.fillPercentage;
  }

  /**
   * Phase 103 OBS-01 — registry-recorded activation timestamp (ms epoch).
   * Returns undefined when the agent has no recorded start (never started
   * since daemon boot, or has been stopped). Mirrors registry.startedAt
   * synchronously to avoid awaiting readRegistry on every status render.
   */
  getActivationAtForAgent(name: string): number | undefined {
    return this.activationAtByAgent.get(name);
  }

  /**
   * Phase 103 OBS-04 / OBS-06 — per-agent RateLimitTracker accessor.
   *
   * Returns undefined when:
   *   - the agent is not running (never started, or stopped)
   *   - the agent's UsageTracker was unavailable at start (no DB handle to
   *     share — graceful degradation, /clawcode-usage shows "no data")
   *
   * Read by:
   *   - daemon.ts list-rate-limit-snapshots IPC handler (Plan 03)
   *   - /clawcode-status renderer for session/weekly bars (Plan 03)
   *   - /clawcode-usage Discord slash command (Plan 03)
   */
  getRateLimitTrackerForAgent(name: string): RateLimitTracker | undefined {
    return this.rateLimitTrackers.get(name);
  }
  getContextFillProvider(agentName: string): CharacterCountFillProvider | undefined { return this.memory.contextFillProviders.get(agentName); }
  getEmbedder(): EmbeddingService { return this.memory.embedder; }
  getAgentConfig(agentName: string): ResolvedAgentConfig | undefined { return this.configs.get(agentName); }

  /**
   * OpenAI VOICE route — build the FULL-but-LEAN session base-options for an
   * agent that opted into voice (`agents.<name>.openaiVoice.enabled === true`).
   *
   * Returns `null` for agents NOT opted in — the OpenAI driver then keeps its
   * existing soul-only transient path BYTE-IDENTICAL (the gate short-circuits
   * BEFORE any `buildSessionConfig` work runs, so non-voice agents never touch
   * this path).
   *
   * For opted-in agents it:
   *   1. cascades the voice-only overrides (effort / memoryAutoLoad /
   *      memoryRetrievalTopK / memoryRetrievalTokenBudget) over the agent's base
   *      config and trims `mcpServers` by `mcpAllowlist` (omitted → all; `[]` →
   *      none) — keeping the assembled stable prefix small for low TTFT;
   *   2. assembles the real `AgentSessionConfig` via `buildSessionConfig` (the
   *      same daemon-side path the live SDK session uses — identity/skills/MCP
   *      prompt + hot memories folded into the stable prefix);
   *   3. maps it into the lean SDK `baseOptions` (mirrors the relevant subset of
   *      `SdkSessionAdapter.createSession`) and computes a `staticPrefixHash`
   *      over the bytes BEFORE the cache-breakpoint marker (excludes rotating
   *      hot memories) so the driver's transient cache key is stable turn-to-turn
   *      and the warm voice handle is reused.
   *
   * Per-turn RAG retrieval is intentionally NOT added — voice relies on the hot
   * memories already in the stable prefix (a deliberate latency choice).
   */
  async buildVoiceSessionBaseOptions(
    agentName: string,
  ): Promise<{ baseOptions: SdkQueryOptions; staticPrefixHash: string } | null> {
    const cfg = this.getAgentConfig(agentName);
    if (!isVoiceEnabled(cfg)) return null;

    const voiceCfg = applyVoiceOverrides(cfg, cfg.openaiVoice);
    const sessionConfig = await buildSessionConfig(
      voiceCfg,
      this.configDeps(agentName),
    );
    return mapSessionConfigToVoiceBaseOptions(sessionConfig);
  }

  /**
   * Phase 85 Plan 01 TOOL-01 — read the per-agent MCP state map.
   *
   * Returns an empty `Map` for agents with no MCP servers or unknown
   * agent names. Consumed by:
   *   - `src/heartbeat/checks/mcp-reconnect.ts` (reconcile prior vs current)
   *   - `src/manager/daemon.ts` IPC `list-mcp-status` handler
   *   - Plan 02 prompt-builder (surface live tool health in system prompt)
   */
  getMcpStateForAgent(name: string): ReadonlyMap<string, McpServerState> {
    return this.mcpStateByAgent.get(name) ?? new Map();
  }

  /**
   * Phase 85 Plan 01 TOOL-01 — persist the per-agent MCP state map.
   *
   * Called at `startAgent` after the readiness probe runs and by the
   * `mcp-reconnect` heartbeat check after every tick's probe. Always
   * stores a DEFENSIVE COPY so external mutations of the passed-in map
   * don't leak into the SessionManager's state.
   */
  setMcpStateForAgent(
    name: string,
    state: ReadonlyMap<string, McpServerState>,
  ): void {
    this.mcpStateByAgent.set(name, new Map(state));
  }
  getSessionLogger(agentName: string): SessionLogger | undefined { return this.memory.sessionLoggers.get(agentName); }
  getTierManager(agentName: string): TierManager | undefined { return this.memory.tierManagers.get(agentName); }
  /** Phase 999.8 follow-up — used by `tier-maintenance-tick` IPC to iterate every agent with a TierManager. */
  tierManagerNames(): IterableIterator<string> { return this.memory.tierManagers.keys(); }
  getUsageTracker(agentName: string): UsageTracker | undefined { return this.memory.usageTrackers.get(agentName); }
  getEpisodeStore(agentName: string) { return this.memory.episodeStores.get(agentName); }
  getDocumentStore(agentName: string): DocumentStore | undefined { return this.memory.documentStores.get(agentName); }
  /** Phase 50 — per-agent trace store for latency instrumentation (retention reads via heartbeat). */
  getTraceStore(agentName: string): TraceStore | undefined { return this.memory.traceStores.get(agentName); }
  /** Phase 50 — per-agent trace collector; callers construct Turn via `.startTurn(...)` and own lifecycle. */
  getTraceCollector(agentName: string): TraceCollector | undefined { return this.memory.traceCollectors.get(agentName); }

  /** Phase 65 -- per-agent ConversationStore for turn persistence. */
  getConversationStore(agentName: string): ConversationStore | undefined {
    return this.memory.conversationStores.get(agentName);
  }

  /**
   * Phase 132-fu T02 — per-agent tool-call trajectory + total wall-clock for
   * a single turn id (`traces.id`). Used by the daemon's two terminal
   * `task.completed` emit sites (subagent-complete + delegate-task) to
   * populate the Phase 132 distiller's eligibility-filter inputs.
   *
   * `turnId` is the native trace id at the call site — Discord message id
   * for Discord turns, `subagent:<thread>` for subagent dispatches, or the
   * delegate task id. NOT a ConversationStore session id (those don't
   * correspond — see Plan SUMMARY for the architectural rationale).
   *
   * Returns `undefined` when the agent has no TraceStore (unknown agent).
   * Returns `{trajectory:[], durationMs:0}` when the trace row is missing.
   */
  getTrajectoryForTurnId(
    agentName: string,
    turnId: string,
  ): TurnTrajectoryView | undefined {
    return getTrajectoryForTurnIdHelper(
      this.memory.traceStores,
      agentName,
      turnId,
    );
  }

  /**
   * Phase 132-fu T06 — multi-turn trajectory for a subagent session.
   *
   * The CORRECT accessor for the subagent-complete emit site. A subagent
   * session spans many Discord message-reply turns; each is its own trace
   * row. Aggregates tool-call spans across all of the agent's traces inside
   * the binding's wall-clock window.
   *
   * `sessionName` is the subagent's per-process agent name (e.g.
   * `<parent>-sub-<nanoid>`) — verbatim what its TraceStore is registered
   * under. `createdAtMs` + `completedAtMs` come from the ThreadBinding
   * (the relay-stamped completedAt is fresh at the call site).
   *
   * Returns undefined when the subagent has no TraceStore (agent already
   * torn down before the relay fired). Returns {trajectory:[], durationMs:N}
   * when the agent ran but recorded no tool spans in the window.
   */
  getTrajectoryForSubagent(
    sessionName: string,
    createdAtMs: number,
    completedAtMs: number,
  ): TurnTrajectoryView | undefined {
    return getTrajectoryForSubagentHelper(
      this.memory.traceStores,
      sessionName,
      createdAtMs,
      completedAtMs,
    );
  }

  /** Phase 65 -- active conversation session ID for an agent (undefined if no active session). */
  getActiveConversationSessionId(agentName: string): string | undefined {
    return this.activeConversationSessionIds.get(agentName);
  }

  /**
   * Phase 999.75 -- the live SDK session UUID for an agent (the running
   * `SessionHandle.sessionId`). This is the id the SDK JSONL transcript is
   * keyed by (`~/.claude/projects/<dir>/<sessionId>.jsonl`) and is DISTINCT
   * from `getActiveConversationSessionId` (the ConversationStore session id).
   * Undefined when the agent has no running session.
   */
  getSdkSessionId(agentName: string): string | undefined {
    return this.sessions.get(agentName)?.sessionId;
  }

  async saveContextSummary(agentName: string, summary: string): Promise<void> {
    const config = this.configs.get(agentName);
    if (!config) {
      this.log.warn({ agent: agentName }, "cannot save context summary: config not found");
      return;
    }
    // Phase 75 SHARED-01 — pass memoryPath (not workspace) so shared-workspace
    // agents write context summaries into their per-agent memory dir.
    await this.memory.saveContextSummary(agentName, config.memoryPath, summary);
  }

  async warmupEmbeddings(): Promise<void> { await this.memory.warmupEmbeddings(); }

  // Private helpers
  private requireSession(name: string): SessionHandle {
    const handle = this.sessions.get(name);
    if (!handle) throw new SessionError(`Agent '${name}' is not running`, name);
    return handle;
  }

  /**
   * Phase 52 Plan 02 — optionally thread the per-agent `priorHotStableToken`
   * so hot-tier placement is consistent across builds. Callers without an
   * agent name (historically: none remain after this plan) get undefined
   * and hot-tier enters the stable prefix by default (first-turn path).
   */
  private configDeps(agentName?: string) {
    const priorHotStableToken =
      agentName !== undefined
        ? this.lastHotStableTokenByAgent.get(agentName)
        : undefined;
    return {
      tierManagers: this.memory.tierManagers,
      skillsCatalog: this.skillsCatalog,
      allAgentConfigs: this.allAgentConfigs,
      priorHotStableToken,
      // Phase 53 Plan 02 — thread SessionManager's pino logger into the
      // assembler so per-section budget-exceeded events + resume-summary
      // hard-truncation events surface in structured logs.
      log: this.log,
      // Phase 53 Plan 03 — thread the shared SkillUsageTracker so the
      // assembler can read the per-agent usage window.
      skillUsageTracker: this.skillUsageTracker,
      // Phase 67 gap-closure — thread per-agent ConversationStore + MemoryStore
      // Maps so buildSessionConfig can invoke assembleConversationBrief.
      // `now` is intentionally omitted — buildSessionConfig defaults to Date.now().
      conversationStores: this.memory.conversationStores,
      memoryStores: this.memory.memoryStores,
      briefCache: this.briefCache, // Phase 73 Plan 02 — LAT-02
      // Phase 85 Plan 02 — thread per-agent MCP readiness state so
      // renderMcpPromptBlock can populate the live status table in the
      // stable prefix (TOOL-02 / TOOL-07).
      mcpStateProvider: (name: string) => this.getMcpStateForAgent(name),
      // Phase 96 Plan 02 D-02 — thread per-agent filesystem-capability
      // snapshot so renderFilesystemCapabilityBlock can populate the
      // <filesystem_capability> block in the LLM stable prefix.
      // Snapshot is mutated in-place by the fs-probe heartbeat check
      // (96-07) every 60s; session-config rebuilds on next turn pick up
      // the latest state automatically.
      fsCapabilitySnapshotProvider: (name: string) =>
        this.getSessionHandle(name)?.getFsCapabilitySnapshot() ?? new Map(),
      // Phase 100 follow-up — thread the vault-scope MCP env resolver so
      // buildSessionConfig can swap clawdbot-scoped tokens for narrower
      // (e.g. Acme-only) tokens before MCP subprocess spawn.
      // Undefined in tests → buildSessionConfig silently skips (back-compat).
      opEnvResolver: this.opEnvResolver,
      // Phase 999.7 — per-agent TraceCollector for context-audit telemetry.
      // Wired here so buildSessionConfig can capture section_tokens metadata
      // on a synthetic bootstrap Turn at every session start. Without this,
      // `clawcode context-audit` reports `sampledTurns: 0` for every agent.
      traceCollector:
        agentName !== undefined
          ? this.memory.traceCollectors.get(agentName)
          : undefined,
      // Phase 117 Plan 04 T05 — advisor defaults + budget for the
      // `shouldEnableAdvisor` gate inside buildSessionConfig. Both
      // optional — when SessionManager hasn't been wired (test paths),
      // the gate falls through to its hard-coded baselines and the
      // advisor is enabled-by-default (matches the production fleet
      // default `defaults.advisor.backend: native`).
      advisorDefaults: this.advisorDefaults,
      advisorBudget: this.advisorBudget,
      // Phase 127 Plan 02 — stream-stall callback factory. When
      // `webhookManager` is wired (post-construction setWebhookManager
      // pattern), this returns a closure that emits a Discord
      // notification + records a JSONL stall row on trip. When the
      // webhookManager is still undefined (boot ordering, tests), the
      // factory falls back to a sessionLogger-only callback. When even
      // the agent name is unknown (configDeps called with no name —
      // legacy callers in test paths), the factory itself is omitted
      // and buildSessionConfig OMITS the `onStreamStall` field.
      streamStallCallbackFactory:
        agentName !== undefined
          ? this.makeStreamStallCallbackFactory()
          : undefined,
      // WS-1 (999.99 structural delivery) — orphan-output delivery factory.
      // Same gate + late-binding shape as the stall factory above: the
      // callback closes over `this.webhookManager` (DI'd post-construction),
      // so a boot-window orphan degrades to a warn-logged drop instead of a
      // crash. Only consulted by buildSessionConfig when the agent's
      // deliveryAttributedStream gate is on.
      orphanDeliveryCallbackFactory:
        agentName !== undefined
          ? (args: { readonly agentName: string }) =>
              makeOrphanDeliveryCallback({
                agentName: args.agentName,
                // Late-binding: resolved at DELIVERY time so a session built
                // during the boot window still delivers once the manager is
                // wired (unlike a factory-time capture).
                webhookManagerProvider: () => this.webhookManager,
                // 999.99 review — bot-direct fallback for webhook-less
                // agents (client-a-health / state-contract class): same
                // sendText(channelId, …) primitive as trigger delivery,
                // channel resolved from the agent's binding at delivery time.
                botDirectSendProvider: () => {
                  const sender = this.botDirectSender;
                  if (!sender) return undefined;
                  return (channelId: string, content: string) =>
                    sender.sendText(channelId, content);
                },
                channelIdProvider: () =>
                  this.configs.get(args.agentName)?.channels?.[0],
                // 999.173 — research synthesis delivered as a reply.
                botDirectReplyProvider: () => {
                  const sender = this.botDirectSender;
                  if (!sender?.sendReply) return undefined;
                  return (channelId: string, content: string, replyToMessageId: string) =>
                    sender.sendReply!(channelId, content, replyToMessageId);
                },
                log: this.log,
              })
          : undefined,
    };
  }

  /**
   * Phase 127 Plan 02 — build a stall-callback factory closure.
   *
   * Closed over `this.webhookManager` (DI'd via setWebhookManager AFTER
   * construction) and a late-binding lookup for the per-agent
   * SessionLogger + active sessionId. Both lookups happen at trip
   * time, not factory time, so the factory survives a webhookManager
   * that lands during boot and a session that rotates mid-lifetime.
   *
   * The factory accepts `{agentName, model, effort}` and returns a
   * callback the buildSessionConfig spread inserts into
   * `AgentSessionConfig.onStreamStall`.
   */
  private makeStreamStallCallbackFactory(): (args: {
    readonly agentName: string;
    readonly model: string;
    readonly effort: string;
  }) => (payload: {
    readonly lastUsefulTokenAgeMs: number;
    readonly thresholdMs: number;
  }) => void {
    return (args) =>
      makeStreamStallCallback({
        agentName: args.agentName,
        model: args.model,
        effort: args.effort,
        webhookManager: this.webhookManager,
        sessionLoggerProvider: () =>
          this.memory.sessionLoggers.get(args.agentName),
        sessionIdProvider: () =>
          this.sessions.get(args.agentName)?.sessionId ?? "",
        log: this.log,
      });
  }

  private async performRestart(name: string, config: ResolvedAgentConfig): Promise<void> {
    // Serialize against any concurrent stop/restart for this agent (the
    // crash-timer that calls performRestart can fire while a config-reload /
    // manual restartAgent is mid-flight). Inside the lock we hold exclusive
    // access, so startAgentCore can never run while another path is closing
    // this agent's store.
    return this.withLifecycleLock(name, async () => {
      // Dedup: if another lifecycle op (a reload/manual restartAgent that ran
      // first in the queue) already brought the agent back, don't double-start
      // — startAgentCore would throw "already running". A clean skip.
      if (this.sessions.has(name)) {
        this.log.info(
          { agent: name },
          "performRestart: agent already running (recovered by another path) — skipping",
        );
        return;
      }
      try {
        await mutateRegistry(this.registryPath, (current) =>
          updateEntry(current, name, { status: "restarting" }),
        );
        await this.startAgentCore(name, config);
      } catch (error) {
        this.log.error({ agent: name, error: (error as Error).message }, "restart attempt failed");
      }
    });
  }

  /**
   * Phase 66 -- invoke session summarization for a terminal session.
   *
   * Non-fatal on any failure. Returns after summarizeSession resolves (which
   * includes its internal 10s timeout + raw-turn fallback). Callers decide
   * whether to await this (stopAgent: awaited) or fire-and-forget it
   * (onError crash handler: void + .catch).
   *
   * Pulls all deps from AgentMemoryManager + the injected summarizeFn so
   * tests can swap the LLM call without touching the rest of the pipeline.
   */
  /**
   * 260419-q2z Fix B — register an in-flight summarization promise with the
   * shutdown drain. Adds to {@link pendingSummaries} and removes on settle.
   *
   * Returns the original promise so callers can await / catch exactly as
   * before — the tracker is invisible to happy-path code.
   */
  private trackSummary(p: Promise<void>): Promise<void> {
    this.pendingSummaries.add(p);
    const settle = (): void => {
      this.pendingSummaries.delete(p);
    };
    p.then(settle, settle);
    return p;
  }

  /**
   * 260419-q2z Fix B — test-only hook that feeds a promise into the same
   * pendingSummaries set used by production crash/stop paths.
   * Production code MUST NOT call this; it exists so the shutdown drain tests
   * can exercise drain() without standing up full agent+memory infrastructure.
   */
  __testTrackSummary(p: Promise<void>): Promise<void> {
    return this.trackSummary(p);
  }

  /**
   * 260419-q2z Fix B — test-only inspector for the draining flag.
   */
  __testIsDraining(): boolean {
    return this.draining;
  }

  /**
   * 260419-q2z Fix B — drain in-flight summarization promises before daemon
   * shutdown so SIGTERM does not truncate a registry update or memory insert
   * mid-flight.
   *
   * After calling drain(), new turn dispatches (streamFromAgent /
   * dispatchTurn) reject with `SessionError('shutting down, agent X is no
   * longer accepting turns')`. This is the ONE surface that blocks new work;
   * stopAgent / reconcileRegistry continue to function so the daemon can
   * still clean up.
   *
   * @param timeoutMs - Hard ceiling on how long to wait for pending
   *                    summaries. On timeout, the promises are NOT cancelled
   *                    — drain just stops waiting. The summaries continue in
   *                    the background; any SIGKILL that follows will kill
   *                    them.
   * @returns Counts of settled vs. timed-out summaries. `settled + timedOut`
   *          equals the number of summaries that were in flight when drain
   *          was called.
   */
  async drain(
    timeoutMs: number,
  ): Promise<{ readonly settled: number; readonly timedOut: number }> {
    this.draining = true;
    const count = this.pendingSummaries.size;
    if (count === 0) {
      return { settled: 0, timedOut: 0 };
    }
    const snapshot = [...this.pendingSummaries];
    const allSettled = Promise.allSettled(snapshot).then(() => "done" as const);
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
      // Don't keep the event loop alive just for this timer.
      timeoutHandle.unref?.();
    });
    try {
      const winner = await Promise.race([allSettled, timeout]);
      if (winner === "done") {
        return { settled: count, timedOut: 0 };
      }
      return { settled: 0, timedOut: this.pendingSummaries.size };
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }

  /**
   * Gap 1 (memory-persistence-gaps) — shared onError handler used by
   * `startAgent` (fresh start) AND `reconcileRegistry` (resume-after-reboot).
   *
   * Previously this block lived inline inside `startAgent`. `reconcileRegistry`
   * attached a DIFFERENT onError that only delegated to `recovery.handleCrash`,
   * leaving resumed sessions without crash-time summarization. Extracting the
   * handler keeps both call sites identical and guarantees conversation
   * summaries survive daemon reboots.
   */
  /**
   * FIND-123-A.next T-04 — fire-and-forget sink-based claudePid registration.
   *
   * Polls the per-handle `ClaudePidSink` (populated by the structural spawn
   * wrapper `makeDetachedSpawn` on every (re-)spawn) with the same 30s budget
   * (6×5s), then registers the agent's claudePid + its MCP children with the
   * McpProcessTracker. Fire-and-forget so warmup / resume never blocks on it;
   * the `sessions.has(name)` re-checks guard against a concurrent stop/dispose
   * (Pitfall 6). Idempotent — `tracker.register` overwrites any prior entry.
   *
   * Called from BOTH `startAgentCore` (fresh create) AND `reconcileRegistry`
   * (boot-resume). Quick task 260714-mkq extracted this so the resume path
   * gets registration too: previously the boot-resume path had NO registration,
   * so every boot-resumed main was absent from the tracker snapshot and the
   * orphan-claude reaper flagged the whole fleet on each 60s tick (2026-07-14
   * prod incident — every fleet main alerted, all session-resumed at boot).
   * `reconcileAllAgents` only self-heals agents ALREADY registered, so it can
   * never add a never-registered resumed main — registration must happen here
   * on the resume path too. Both `createSession` and `resumeSession` route
   * through `createPersistentSessionHandle`, so the resumed handle's sink is
   * populated identically; `getClaudePid()` returns the live pid for a resume.
   */
  private registerClaudePidWithTracker(name: string): void {
    if (!this.mcpTracker) return;
    void (async () => {
      try {
        let claudePid: number | null = null;
        for (let attempt = 0; attempt < MCP_POLL_MAX_ATTEMPTS; attempt++) {
          await sleep(MCP_POLL_INTERVAL_MS);
          if (!this.sessions.has(name)) return;
          const liveHandle = this.sessions.get(name);
          const found = liveHandle?.getClaudePid?.() ?? null;
          if (found !== null && found > 1) {
            claudePid = found;
            break;
          }
        }
        if (claudePid === null) {
          this.log.warn(
            { agent: name },
            "no claude pid in sink within 30s — relying on reaper reconciliation",
          );
          return;
        }
        // Re-check disposal post-loop before mutating tracker state.
        if (!this.sessions.has(name)) return;
        const tracker = this.mcpTracker;
        if (!tracker) return; // narrowing
        let patterns: RegExp;
        try {
          patterns = tracker.patterns;
        } catch {
          // Tracker constructed without patterns (test fixture); skip.
          return;
        }
        const mcpPids = await discoverAgentMcpPids(claudePid, patterns);
        // Phase 999.15 TRACK-03 — 3-arg register stores claudePid alongside MCPs.
        await tracker.register(name, claudePid, mcpPids);
        this.log.info(
          {
            agent: name,
            claudePid,
            mcpPidCount: mcpPids.length,
            source: "123-A-next-sink",
          },
          "registered agent MCP PIDs with tracker (FIND-123-A.next T-04 sink)",
        );
      } catch (err) {
        this.log.warn(
          { agent: name, err: String(err) },
          "MCP PID sink registration failed (non-fatal — reaper will catch leaks)",
        );
      }
    })();
  }

  private attachCrashHandler(
    name: string,
    config: ResolvedAgentConfig,
    handle: SessionHandle,
  ): void {
    handle.onError((error: Error) => {
      // Phase 115 sub-scope 13(a) — prompt-bloat classifier.
      // Runs FIRST so the [diag] log line is correlated with this exact crash;
      // any subsequent crash-handling work (summarize, recovery, mcp teardown)
      // is independent. Failure-isolated: classifier errors NEVER block the
      // existing crash-recovery path.
      try {
        const stablePrefix =
          this.latestStablePrefixByAgent.get(name) ?? "";
        const traceCollector = this.memory.traceCollectors.get(name);
        const traceSink = traceCollector
          ? {
              incrementPromptBloatWarning: (agent: string): void => {
                // Phase 115 sub-scope 13(a) dependency note: 115-00-T02
                // adds a `prompt_bloat_warnings_24h` column on traces.db.
                // Until that DDL lands in this worktree, the increment
                // method may not exist on TraceCollector — invoke
                // defensively. Classifier remains operator-visible via
                // the warn log line even when the counter is dark.
                const sink = traceCollector as unknown as {
                  incrementPromptBloatWarning?: (agent: string) => void;
                };
                if (typeof sink.incrementPromptBloatWarning === "function") {
                  sink.incrementPromptBloatWarning(agent);
                }
                /* else: column/method not yet present — best-effort no-op */
              },
            }
          : undefined;
        classifyPromptBloat(
          error,
          stablePrefix.length,
          name,
          this.log,
          traceSink,
        );
      } catch {
        /* classifier MUST NEVER break the crash-recovery path */
      }
      // Phase 65: crash the ConversationStore session
      const convSessionId = this.activeConversationSessionIds.get(name);
      const convStoreForCrash = this.memory.conversationStores.get(name);
      if (convStoreForCrash && convSessionId) {
        try { convStoreForCrash.crashSession(convSessionId); } catch { /* best-effort */ }
        // Phase 66 -- fire-and-forget summarization (non-fatal, non-blocking).
        // BEFORE recovery.handleCrash so summarize starts even if recovery
        // synchronously resets state. Detached so crash recovery is never
        // delayed waiting on Haiku (up to 10s internal timeout).
        // 260419-q2z Fix B — track the crash-path summary so shutdown drain
        // waits for it even though we're fire-and-forget at this callsite.
        void this.trackSummary(
          this.summarizeSessionIfPossible(name, convSessionId),
        ).catch((err) => {
          this.log.warn(
            {
              agent: name,
              session: convSessionId,
              error: (err as Error).message,
            },
            "crash-path summarization failed (non-fatal)",
          );
        });
      }
      this.activeConversationSessionIds.delete(name);
      this.briefCache.invalidate(name); // Phase 73 Plan 02 — LAT-02
      // Gap 3 (memory-persistence-gaps): crash also stops the flush timer —
      // crashSession transitioned the session out of 'active' so flushes
      // would now skip anyway, but killing the timer here saves wakeups.
      this.stopFlushTimer(name);
      // Phase 90 MEM-04 — stop the disk-flush timer on crash. Do NOT await
      // a final flush here: the session already crashed and the Haiku call
      // would likely fail on the corrupted state. Timer is just stopped.
      this.stopMemoryFileFlushTimer(name);

      // Phase 999.14 MCP-02 — fire process-group SIGTERM on crash. The
      // underlying claude subprocess has died (that's why onError fired);
      // its MCP grandchildren have reparented to PID 1 by the time we get
      // here. killAgentGroup signals their pgid, idempotent on dead PIDs.
      // Fire-and-forget so crash recovery isn't delayed by /proc reads.
      // See RESEARCH.md Pitfall 5: this is the SESSION-LEVEL teardown trigger,
      // NOT a per-MCP transport disconnect — reaper-storm safe.
      if (this.mcpTracker) {
        const tracker = this.mcpTracker;
        void (async () => {
          try {
            await tracker.killAgentGroup(name, 5_000);
          } catch (err) {
            this.log.error(
              { agent: name, err: String(err) },
              "tracker.killAgentGroup failed during crash teardown (non-fatal)",
            );
          }
        })();
      }
      this.recovery.handleCrash(name, config, error, this.sessions);
      // Invoke session end callback on crash (e.g., subagent thread cleanup)
      const endCallback = this.sessionEndCallbacks.get(name);
      if (endCallback) {
        this.sessionEndCallbacks.delete(name);
        endCallback().catch((err) => {
          this.log.warn({ agent: name, error: (err as Error).message }, "session end callback failed on crash");
        });
      }
    });
  }

  /**
   * Gap 3 (memory-persistence-gaps) — start the periodic mid-session flush
   * timer for an agent. Reads `config.memory.conversation.flushIntervalMinutes`
   * (default 15, `0` disables). Safe to call from startAgent and
   * reconcileRegistry. Clears any pre-existing timer first (so hot-reloads
   * that re-enter this path do not leak).
   */
  private startFlushTimer(name: string, config: ResolvedAgentConfig): void {
    this.stopFlushTimer(name); // defensive: never leak a prior timer

    // Test-only override takes precedence so Gap 3 integration tests can
    // exercise the timer path without waiting real minutes.
    const intervalMs =
      this.flushIntervalMsOverride !== undefined
        ? this.flushIntervalMsOverride
        : (config.memory.conversation?.flushIntervalMinutes ?? 15) * 60_000;

    if (intervalMs <= 0) {
      this.log.debug(
        { agent: name },
        "flush timer disabled (interval <= 0)",
      );
      return;
    }
    this.flushSequenceByAgent.set(name, 0);
    // WP1 (memory overhaul 2026-10-25) — one flush in flight per timer. A
    // tick that lands while the previous flush is still summarizing would
    // read the same cursor and write a duplicate row.
    let inFlight = false;
    const timer = setInterval(() => {
      // Non-blocking: fire-and-forget through trackSummary so drain() at
      // daemon shutdown waits for an in-flight flush.
      const convSessionId = this.activeConversationSessionIds.get(name);
      if (!convSessionId) return; // no active session — skip this tick
      if (this.draining) return; // shutdown in progress — new flushes pointless
      if (inFlight) return; // previous flush still running — skip this tick
      // WP1 — the sequence advances only when a row is written. The flush
      // is incremental now: a tick with fewer than flushMinNewTurns new
      // turns is skipped inside flushSessionMidway and must not consume a
      // flush:N label, so the labels stay dense.
      const nextSeq = (this.flushSequenceByAgent.get(name) ?? 0) + 1;
      inFlight = true;
      const run = this.flushSessionIfPossible(name, convSessionId, nextSeq)
        .then((result) => {
          const stillThisTimer = this.flushTimers.get(name) === timer;
          if (
            result !== undefined &&
            "success" in result &&
            result.success &&
            stillThisTimer
          ) {
            this.flushSequenceByAgent.set(name, nextSeq);
          }
        })
        .finally(() => {
          inFlight = false;
        });
      void this.trackSummary(run).catch((err) => {
        this.log.warn(
          {
            agent: name,
            session: convSessionId,
            flushSequence: nextSeq,
            error: (err as Error).message,
          },
          "mid-session flush failed (non-fatal)",
        );
      });
    }, intervalMs);
    // Never keep the event loop alive just for this timer — if everything
    // else shuts down, the flush timer should not stop the process.
    timer.unref?.();
    this.flushTimers.set(name, timer);

    this.log.info(
      { agent: name, intervalMs },
      "mid-session flush timer started",
    );
  }

  /**
   * Gap 3 (memory-persistence-gaps) — stop the flush timer for an agent.
   * Safe to call when no timer is registered (no-op).
   */
  private stopFlushTimer(name: string): void {
    const timer = this.flushTimers.get(name);
    if (timer !== undefined) {
      clearInterval(timer);
      this.flushTimers.delete(name);
    }
    this.flushSequenceByAgent.delete(name);
  }

  /**
   * Gap 3 (memory-persistence-gaps) — invoke the mid-session flush pipeline.
   * Mirrors summarizeSessionIfPossible's shape so tests can exercise the
   * production wiring end-to-end.
   *
   * WP1 — resolves with the flush result (undefined when the stores are
   * missing or the pipeline threw) so the timer can advance the flush
   * sequence only when a row was actually written. The cursor itself is
   * recovered by flushSessionMidway from the session's existing flush
   * rows, so nothing has to be tracked here across restarts.
   */
  private async flushSessionIfPossible(
    agentName: string,
    sessionId: string,
    flushSequence: number,
  ): Promise<Awaited<ReturnType<typeof flushSessionMidway>> | undefined> {
    const memoryStore = this.memory.memoryStores.get(agentName);
    const conversationStore = this.memory.conversationStores.get(agentName);
    if (!memoryStore || !conversationStore) {
      this.log.warn(
        { agent: agentName, session: sessionId, flushSequence },
        "flush: missing memoryStore or conversationStore (non-fatal)",
      );
      return undefined;
    }
    try {
      return await flushSessionMidway(
        { agentName, sessionId, flushSequence },
        {
          conversationStore,
          memoryStore,
          embedder: this.memory.embedder,
          summarize: this.summarizeFn,
          log: this.log,
        },
      );
    } catch (err) {
      // flushSessionMidway is designed to never throw, but log defensively.
      this.log.warn(
        {
          agent: agentName,
          session: sessionId,
          flushSequence,
          error: (err as Error).message,
        },
        "flush threw unexpectedly (non-fatal)",
      );
      return undefined;
    }
  }

  /**
   * Phase 99-C — drain the pending-summary backlog for an agent.
   *
   * Looks up sessions in terminal status that never received a Phase 64
   * summarization (status IN ('ended','crashed') AND summary_memory_id IS
   * NULL — see ConversationStore.listPendingSummarySessions for the full
   * predicate) and runs `summarizeSession` on each, oldest-first. Counts
   * the outcome shape so the caller (the `summarize-pending` heartbeat
   * check) can render a one-line healthy/warning message.
   *
   * Each in-flight summary is registered with `trackSummary` so daemon
   * shutdown drain (`drain(timeoutMs)`) waits for it to settle, exactly
   * like the stop-path and crash-path trigger sites already do.
   *
   * Never throws — failures fall through into the `skipped` count and a
   * defensive warn log. The heartbeat check timeout is the ultimate
   * upper bound on per-tick work.
   */
  async summarizePendingSessions(
    agentName: string,
    limit: number,
  ): Promise<{
    readonly attempted: number;
    readonly summarized: number;
    readonly skipped: number;
  }> {
    const memoryStore = this.memory.memoryStores.get(agentName);
    const conversationStore = this.memory.conversationStores.get(agentName);
    if (!memoryStore || !conversationStore) {
      return { attempted: 0, summarized: 0, skipped: 0 };
    }
    let pending: readonly { readonly id: string }[] = [];
    try {
      pending = conversationStore.listPendingSummarySessions(agentName, limit);
    } catch (err) {
      this.log.warn(
        { agent: agentName, error: (err as Error).message },
        "summarize-pending: list query failed (non-fatal)",
      );
      return { attempted: 0, summarized: 0, skipped: 0 };
    }

    let attempted = 0;
    let summarized = 0;
    let skipped = 0;
    for (const session of pending) {
      attempted++;
      const sessionId = session.id;
      try {
        const result = await this.trackSummary(
          (async () => {
            const r = await summarizeSession(
              { agentName, sessionId },
              {
                conversationStore,
                memoryStore,
                embedder: this.memory.embedder,
                summarize: this.summarizeFn,
                log: this.log,
              },
            );
            if ("success" in r && r.success) {
              summarized++;
            } else {
              skipped++;
            }
          })(),
        );
        void result;
      } catch (err) {
        skipped++;
        this.log.warn(
          {
            agent: agentName,
            session: sessionId,
            error: (err as Error).message,
          },
          "summarize-pending: per-session summarization threw (non-fatal)",
        );
      }
    }
    return { attempted, summarized, skipped };
  }

  private async summarizeSessionIfPossible(
    agentName: string,
    sessionId: string,
  ): Promise<void> {
    const memoryStore = this.memory.memoryStores.get(agentName);
    const conversationStore = this.memory.conversationStores.get(agentName);
    if (!memoryStore || !conversationStore) {
      this.log.warn(
        { agent: agentName, session: sessionId },
        "summarize: missing memoryStore or conversationStore (non-fatal)",
      );
      return;
    }
    try {
      const result = await summarizeSession(
        { agentName, sessionId },
        {
          conversationStore,
          memoryStore,
          embedder: this.memory.embedder,
          summarize: this.summarizeFn,
          log: this.log,
        },
      );
      if ("success" in result && result.success) {
        this.log.info(
          {
            agent: agentName,
            session: sessionId,
            memoryId: result.memoryId,
            fallback: result.fallback,
            turnCount: result.turnCount,
          },
          "session summarized",
        );
      } else {
        this.log.info(
          {
            agent: agentName,
            session: sessionId,
            reason: (result as { reason: string }).reason,
          },
          "session summarization skipped",
        );
      }
    } catch (err) {
      // summarizeSession is designed to never throw, but log defensively so
      // an unexpected exception doesn't propagate past the lifecycle hook.
      this.log.warn(
        {
          agent: agentName,
          session: sessionId,
          error: (err as Error).message,
        },
        "summarization threw unexpectedly (non-fatal)",
      );
    }
  }
}
