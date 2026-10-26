import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { researchBudgetStatusLine } from "./research-subagents.js";
import { DEFAULT_USAGE_GUARD, currentUsageSnapshots, evaluateUsageGuard, setResearchUsageProvider, usageStatusLine } from "./research-usage-guard.js";
import { PlanUsageProbe, setActivePlanUsageProbe } from "../usage/plan-usage-probe.js";
import { fileURLToPath } from "node:url";
import { setResearchCardPort } from "./research-card-sink.js";
import { makeResearchCardPort } from "../discord/research-card-port.js";
import { setBackgroundCardPort } from "./background-task-board.js";
import { makeBackgroundCardPort } from "../discord/background-card.js";
import { homedir, tmpdir } from "node:os";
import {
  mkdir,
  writeFile,
  unlink,
  access,
  stat,
  readFile,
  realpath,
  mkdtemp,
  rm,
} from "node:fs/promises";
// INC-2026-07-27 — the last-known-good secret store is read once at
// SecretsResolver construction and written on each successful resolve, both
// inside synchronous DI callbacks, so it uses the sync fs API deliberately.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
// 2026-09-10 — `post-cv2-embed` re-validates its spec server-side with the
// same schema the MCP tool enforces, so a caller that bypasses the MCP
// wrapper (raw socket) cannot ship a component the tool would have refused.
// zod-only module; no cycle back into the daemon.
import { CV2_SPEC_SCHEMA } from "../mcp/cv2-spec-schema.js";
import { connect, type Server } from "node:net";
import { logger } from "../shared/logger.js";
import { handleVerifyClaim } from "./daemon-verify-claim-ipc.js";
import { baseAgentName } from "./fork.js";
import { parentAgentName } from "./subagent-name.js";
// Phase 999.165 — workflow control: ownership + the task-tool hint.
import {
  authorizeWorkflowControl,
  isWorkflowId,
  resolveWorkflowCaller,
  workflowActorLabel,
  workflowIdTaskHint,
} from "./workflow-control.js";
import {
  DEFAULT_VERIFICATION_STATE_PATH,
  TRAIL_MODES,
  clearVerificationState,
  hydrateVerificationOverrides,
  readVerificationState,
  setVerificationOverride,
  writeVerificationState,
} from "./verification-state-store.js";
// Phase 999.164 — /clawcode-quick per-agent quick-lane toggle.
import {
  DEFAULT_FAST_LANE_STATE_PATH,
  clearFastLaneState,
  getFastLaneOverride,
  hydrateFastLaneOverrides,
  resolveFastLaneEnabled,
  setFastLaneOverride,
  writeFastLaneState,
} from "./fast-lane-state-store.js";
import { renderQuickLaneMap, routingProfileFromConfig } from "./fast-lane-routing.js";
// Phase 999.171 — /clawcode-ux per-agent UX feature toggles.
import { DEFAULT_UX_FEATURE_STATE_PATH, hydrateUxFeatureOverrides } from "./ux-feature-state-store.js";
import { handleSetUxFeature } from "./ux-feature-ipc.js";
import { isVerificationEnforced } from "./financial-verification-policy.js";
import {
  TOPIC_PROFILE_NAMES,
  isTopicProfileName,
} from "./topic-profiles.js";
import { ManagerError } from "../shared/errors.js";
import { createIpcServer } from "../ipc/server.js";
import type { IpcHandler } from "../ipc/server.js";
import { SessionManager } from "./session-manager.js";
// P1 robust auto-ingest (image-overload fix).
import { configureSharpAtBoot, withImageWorkSlotReleased } from "./image-work-governor.js";
import { buildVisionService, resolveImageIngestConfig } from "../vision/config.js";
import { configureVisionService, getVisionService } from "../vision/service.js";
import { IngestVisionBatcher } from "../vision/ingest-batcher.js";
import { cleanupVisionContamination } from "../vision/contamination-cleanup.js";
import { EmbedWorkerClient } from "./embed-worker-client.js";
import { autoIngestQueue } from "./auto-ingest-queue.js";
import { handleAutoIngestAttachment } from "./auto-ingest-handler.js";
import type { CrashAlertPayload } from "./session-recovery.js";
import type { SessionAdapter } from "./session-adapter.js";
import { SdkSessionAdapter, logResolvedClaudeBinary, probeClaudeBinary } from "./session-adapter.js";
import { BINARY_MANIFEST_FILE, checkBinaryIntegrity, readBinaryManifest } from "../shared/claude-binary.js";
import { AccountService } from "../account/account-service.js";
import { handleAccountIpc, isAccountIpcMethod } from "../account/account-ipc.js";
import { cleanupWorkRoot } from "../account/oauth-cli.js";
import {
  accountSwapPathsFor,
  applyPendingSwapAtBoot,
  consumeSwapBootResult,
} from "../account/pending-swap.js";
import { buildAccountFlowDeps } from "../discord/account-swap-wiring.js";
import { postSwapBootReport } from "../discord/account-swap-flow.js";
import {
  checkCliVersion,
  checkClaudeBinaryLockstep,
  collectCliVersionRequirements,
  formatCliVersionFailure,
  formatLockstepFailure,
  isLockstepFatal,
} from "./cli-version-guard.js";
import { TurnDispatcher } from "./turn-dispatcher.js";
import { MemoryContextAugmenter } from "./memory-context-augmenter.js";
// Phase 999.6 SNAP-01..05 — pre-deploy running-fleet snapshot. Writer fires
// at top of shutdown() (before drain); reader fires at boot path (before
// autoStartAgents filter) to restore the running fleet across restarts.
import {
  writePreDeploySnapshot,
  readAndConsumePreDeploySnapshot,
} from "./snapshot-manager.js";
import { TaskStore } from "../tasks/store.js";
import { TaskManager } from "../tasks/task-manager.js";
import { SchemaRegistry } from "../tasks/schema-registry.js";
import { PayloadStore } from "../tasks/payload-store.js";
import {
  runStartupReconciliation,
  ORPHAN_THRESHOLD_MS,
} from "../tasks/reconciler.js";
import { loadConfig, resolveAllAgents, defaultOpRefResolver, resolveShimCommand, resolveBrokerShimCommand } from "../config/loader.js";
import type { OpRefResolver, ShimRuntime } from "../config/loader.js";
// Phase 104 — single SecretsResolver instance threads through every
// op:// resolution site (Discord botToken, loader sync wrapper, per-agent
// opEnvResolver). See SUMMARY.md for the three call-site rewrites.
import { SecretsResolver, DEFAULT_LKG_MAX_AGE_MS } from "./secrets-resolver.js";
// Phase 999.14 — MCP child process lifecycle hardening (boot scan + reaper
// + shutdown cleanup). Singleton mirrors the SecretsResolver DI pattern.
import { McpProcessTracker } from "../mcp/process-tracker.js";
import { buildMcpTrackerSnapshot } from "./mcp-tracker-snapshot.js";
// Phase 109-D — fleet-wide observability (cgroup memory + claude proc drift
// + per-MCP-pattern aggregate). Pure helper; safe to invoke from the IPC
// handler.
import { buildFleetStats, type McpRuntime } from "./fleet-stats.js";
import {
  reapOrphans,
  startOrphanReaper,
  scanForNpmStrays,
  scanForSurvivorClis,
  actOnScannedOrphans,
} from "../mcp/orphan-reaper.js";
import {
  resolveRemediationMode,
  scanForForkPoolSessions,
  forkPoolParentOf,
  type RemediationConfig,
} from "./reap-policy.js";
// Phase 115 Plan 07 sub-scope 15 — daemon-side MCP tool-response cache.
// Folds Phase 999.40 (now SUPERSEDED-BY-115). The store is a singleton
// owned by the daemon process; dispatchTool wraps tool calls at the IPC
// boundary so search/image/search-documents land in the cache.
import { ToolCacheStore } from "../mcp/tool-cache-store.js";
import { dispatchTool } from "../mcp/tool-dispatch.js";
import {
  classifyMissingTraceStore,
  logTraceStoreAbsent,
  emptyLatencyReport,
  emptyCacheReport,
} from "./trace-store-absent.js";
import {
  buildMcpCommandRegexes,
  readBootTimeUnix,
  readClockTicksPerSec,
} from "../mcp/proc-scan.js";
// Phase 999.15 — tracker reconciliation engine. Wired into the existing
// onTickAfter callback (alongside sweepStaleBindings) AND into the
// McpProcessTracker construction via the late-bound reconcileAgent closure
// for TRACK-06 reconcile-before-kill.
import { reconcileAllAgents, reconcileAgent } from "../mcp/reconciler.js";
// Phase 109-B — orphan-claude reaper. Detects `claude` procs whose ppid is
// the daemon but which are not in tracker.getRegisteredAgents() (the
// today-fire pattern from 2026-05-03). Wired into onTickAfter AFTER the
// reconciler so a freshly-discovered SDK respawn is registered before the
// reaper sees it.
import {
  tickOrphanClaudeReaper,
  type OrphanClaudeReaperMode,
} from "../mcp/orphan-claude-reaper.js";
// Phase 999.X — subagent-thread session reaper. Catches the today-fire
// pattern (admin-clawdy 2026-05-04): auto-spawned subagent sessions
// (`*-via-*-<nanoid6>` / `*-sub-<nanoid6>`) sitting at status `running`
// for hours after their work completed. Hosted in the same onTickAfter
// alongside orphan-claude-reaper + stale-binding-sweep. Default mode
// "reap" — see config/schema.ts subagentReaper for rationale.
import {
  tickSubagentSessionReaper,
  type SubagentReaperMode,
  type RunningSessionInfo,
} from "./subagent-session-reaper.js";
// Phase 999.25 — subagent completion relay. `relayAndMarkCompleted`
// helpers used by the IPC handler (`subagent-complete` tool) and the
// quiescence sweep, both wired below. Single source of truth for the
// idempotent relay-and-stamp flow.
import {
  relayAndMarkCompletedByAgentName,
} from "./relay-and-mark-completed.js";
// Debug session `relay-delivery-not-confirmed` (FAULT 2) — pre-teardown
// subagent-relay drain. Runs in the shutdown closure BEFORE
// `discordBridge.stop()` so completion relays still reach Discord while
// the client token is alive.
import { drainPendingSubagentRelays } from "./drain-pending-subagent-relays.js";
import {
  tickSubagentCompletionSweep,
  handleSubagentQuiescenceWarning,
  handleSubagentQuiescenceRelay,
} from "./subagent-completion-sweep.js";
// Phase 108 — daemon-managed broker pooling 1password-mcp children across
// agents. The broker owns ONE @takescake/1password-mcp child per unique
// resolved OP_SERVICE_ACCOUNT_TOKEN; agents connect via per-process shim
// CLI subprocesses (loader.ts auto-injects `clawcode mcp-broker-shim
// --pool 1password`). ShimServer accepts socket connections from those
// shims and bridges them to the broker.
import { OnePasswordMcpBroker } from "../mcp/broker/broker.js";
import { ShimServer } from "../mcp/broker/shim-server.js";
import { resolveBrokerChildSpawn } from "../mcp/broker/pinned-child.js";
// P3 (memory program) — spawn governance + bridge child census.
import { SpawnGovernor, SPAWN_GOVERNOR_DEFAULTS } from "./spawn-governor.js";
// 999.106 G-2 — backpressure loop: on-acquire PSI + census balloon signal.
import { MemorySignalBus } from "./memory-signal-bus.js";
import { readPressure as readMemoryPressure } from "./memory-pressure.js";
import { getBridgeChildPids } from "../bridge/bridge-spawn-governor.js";
import { spawn as childSpawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { cleanupThreadWithClassifier } from "../discord/thread-cleanup.js";
import {
  parseIdleDuration,
  sweepStaleBindings,
} from "../discord/stale-binding-sweep.js";
import {
  readThreadRegistry,
  mutateThreadRegistry,
  removeBinding,
  addBinding,
  updateActivity,
  getBindingForThread,
  getBindingForSession,
  getBindingsForAgent,
  stampLastDeliveryAt,
  resetSteerGates,
  migrateBindingsForPhase999_36,
} from "../discord/thread-registry.js";
import {
  prepareSubagentSteer,
  frameSteeringGuidance,
} from "./steer-subagent.js";
import { collectAllOpRefs } from "./secrets-collector.js";
import { applySecretsDiff } from "./secrets-watcher-bridge.js";
import {
  defaultOpReadShellOut,
  defaultOpRatelimitShellOut,
} from "./op-env-resolver.js";
// Phase 104 Plan 04 — IPC handlers for secrets-status / secrets-invalidate.
// Pure handler module so the case branches in the IPC dispatch closure stay
// one-liners and the logic is unit-testable without booting the IPC server.
import {
  handleSecretsStatus,
  handleSecretsInvalidate,
  handleSecretsRefresh,
} from "./secrets-ipc-handler.js";
import { readRegistry, reconcileRegistry, updateEntry, mutateRegistry } from "./registry.js";
import { isNonFatalPipeError } from "./crash-policy.js";
import { isSubagentOrThreadSession, spawnKindOf } from "./subagent-name.js";
// Phase 140 Plan 07 (#14) — per-agent ClawCode channel registry. First
// production instantiation of AgentChannelBridge + the Unix-socket listener;
// gated to v3 (claude-code-interactive) agents in the boot loop below.
import { AgentChannelRegistry } from "./agent-channel-registry.js";
import { buildRoutingTable } from "../discord/router.js";
// Multi-platform messaging (Slack) — see .planning/multi-platform-messaging-PLAN.md.
import {
  MessagingBridge,
  SlackAdapter,
  buildPlatformRoutingTable,
  type AgentIdentity,
  // Phase 145 WS3 (Plan 04) — the shared pending-prompt registry singleton
  // (injected into the extracted ask-user-question handler).
  pendingPromptRegistry,
} from "../messaging/index.js";
import { createRateLimiter } from "../discord/rate-limiter.js";
import { DEFAULT_RATE_LIMITER_CONFIG } from "../discord/types.js";
import type { RoutingTable, RateLimiter } from "../discord/types.js";
import { HeartbeatRunner } from "../heartbeat/runner.js";
import { HeartbeatTransitionJournal } from "../heartbeat/transition-journal.js";
import { SHARED_FACTS_DB_FILE, SharedFactsStore } from "../memory/shared-facts-store.js";
import type { CheckStatus, HeartbeatConfig } from "../heartbeat/types.js";
import type { ContextZone, ZoneTransition } from "../heartbeat/context-zones.js";
import { CompactionEventLog } from "./compaction-event-log.js";
import { buildHeartbeatStatusPayload } from "./heartbeat-status-builder.js";
import { TaskScheduler } from "../scheduler/scheduler.js";
import { TriggerEngine } from "../triggers/engine.js";
import { SchedulerSource } from "../triggers/scheduler-source.js";
import { RecurringScheduleStore } from "../triggers/recurring-schedule-store.js";
import { MysqlSource } from "../triggers/sources/mysql-source.js";
import { WebhookSource } from "../triggers/sources/webhook-source.js";
import { InboxSource } from "../triggers/sources/inbox-source.js";
import { CalendarSource } from "../triggers/sources/calendar-source.js";
import { createWebhookHandler } from "../dashboard/webhook-handler.js";
import { DEFAULT_REPLAY_MAX_AGE_MS, DEFAULT_DEBOUNCE_MS, DEFAULT_DEDUP_LRU_SIZE, type TriggerDeliveryFn } from "../triggers/types.js";
import { loadPolicies, PolicyValidationError } from "../triggers/policy-loader.js";
import { PolicyEvaluator } from "../triggers/policy-evaluator.js";
import { PolicyWatcher } from "../triggers/policy-watcher.js";
import { scanSkillsDirectory } from "../skills/scanner.js";
import {
  loadSkillManifest,
  classifySkillForLoadGate,
  type UnloadedSkillEntry,
} from "./skill-loader.js";
import { notifyUnloadedSkills } from "./skill-load-notifier.js";
// Phase 132-02 — autonomous skill creation (Hermes pattern). Single emit
// pathway for task.completed events + out-of-band Haiku distiller. The
// emitter is fire-and-forget (D-01); the daemon NEVER awaits it.
import { emitTaskCompletedEvent } from "./skill-distiller-task-event.js";
import type { TaskCompletedEventDeps } from "./skill-distiller-task-event.js";
import { distillSkillDraft, type CallHaikuFn } from "./skill-distiller.js";
import {
  resolveModelId,
  deriveFamily,
  type CatalogSnapshot,
  resolveLatestModel,
  LATEST_MODEL_MAX_AGE_MS,
} from "./model-resolver.js";
import { ModelCatalogStore } from "./model-catalog-store.js";
import { registerModelMonitorCron } from "./model-monitor-cron.js";
import {
  defaultFetchJson,
  fileStateStore,
  registerVersionWatchCron,
  VERSION_WATCH_CRON_PATTERN,
} from "./version-watch-cron.js";
import { icons } from "../discord/icons.js";
import { rewriteIconShortcodes } from "../discord/icon-shortcodes.js";
import { deliverAgentText, type AgentTextSinks } from "./agent-text-delivery.js";
import { makeRootOrigin } from "./turn-origin.js";
import { TranscriptionWatcher } from "../transcription/watcher.js";
import { pollTrees, parseTreeMap, defaultSsh } from "../transcription/unraid.js";
import { deliverTranscript } from "../transcription/deliver.js";
import { findTranscriptRequest } from "../transcription/request-meta.js";
import { resolveAgent } from "../transcription/routing.js";
// INC-2026-08-08 — hourly 1Password service-account ratelimit probe, plus the
// admin-alert delivery target resolver that ITS alerts (and MemoryGuard's, and
// document-ingest's, and the model-monitor's) all travel through.
import { registerRatelimitMonitorCron } from "./ratelimit-monitor-cron.js";
import {
  deliverAdminAlert,
  resolveAdminAlertTarget,
  selectAdminAlertLeg,
  type AdminAlertTarget,
} from "./admin-alert-target.js";
// Deployment constant for the #admin-clawdy channel — already the terminal
// target used by the Phase 91 sync conflict alerter and the Phase 90.1
// bot-direct restart greeting. Type-only-adjacent module (no runtime deps
// beyond a pino type), so importing it here adds no cycle.
import { ADMIN_CLAWDY_CHANNEL_ID } from "../sync/conflict-alerter.js";
import type { PinnedAgentInput } from "./model-monitor.js";
// Phase 132 Plan 03 — operator review surface (approve / reject / edit
// skill drafts) and the daemon-side embed posted to the agent's Discord
// channel when distillSkillDraft resolves status:"staged" (D-06 + locked
// CONTEXT §specifics embed shape).
import {
  approveDraft,
  rejectDraft,
  locateDraftForEdit,
} from "./skill-draft-actions.js";
import {
  buildSkillDraftEmbed,
  postSkillDraftEmbed,
  type DraftStagedRecord,
} from "../discord/skill-draft-embed.js";
// Phase 999.42 Plan 06 — capability C skill PATCH lifecycle operator
// review surface. The three IPC verbs (list-skill-patches /
// apply-skill-patch / reject-skill-patch) route to these pure-IO handlers
// from Plan 05's skill-patch-actions.ts.
import {
  applyPatch,
  rejectPatch,
  listPatchesForSkill,
  parsePatchFile,
} from "./skill-patch-actions.js";
// Phase 999.42 Plan 07 — capability C progressive-refinement loop. When an
// eligible trajectory's fingerprint matches a skill the distiller already
// created, route to PATCH-SUGGEST (a Haiku-refined patch artifact) instead
// of a duplicate create-draft. Gated behind suggestPatches (default OFF).
import {
  shouldRouteToPatch,
  suggestPatch,
} from "./skill-patch-suggest.js";
import {
  buildSkillPatchEmbed,
  postSkillPatchEmbed,
} from "../discord/skill-patch-embed.js";

/**
 * Phase 132-02 — module-scoped late-bound holder for the task.completed
 * emitter deps. Bound by startDaemon at boot (one closure shared across
 * both terminal emit sites: subagent-complete in the closure-intercept
 * handler + delegate-task in routeMethod). routeMethod is a top-level
 * function and cannot reach startDaemon's local scope, so the late-bound
 * holder is the cheapest way to satisfy the single-source-of-truth
 * invariant (feedback_silent_path_bifurcation) without expanding the
 * routeMethod signature across 3 call sites.
 */
let phase132EmitterDepsRef: TaskCompletedEventDeps | null = null;
/**
 * Phase 132 Plan 03 T-03 — module-scoped late-bound holder for the
 * skill-draft-action handler deps (log + agentWorkspaceDir). Same scope-
 * bridge pattern as `phase132EmitterDepsRef`: routeMethod is top-level
 * and cannot see startDaemon's local `log` / homedir-rooted resolver, so
 * the boot wiring stashes the closure here and the three IPC case branches
 * read it. Single-source-of-truth: only set inside startDaemon.
 */
let phase132DraftActionDepsRef: {
  readonly log: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    warn: (obj: Record<string, unknown>, msg: string) => void;
    error: (obj: Record<string, unknown>, msg: string) => void;
  };
  readonly agentWorkspaceDir: (agent: string) => string;
} | null = null;
/**
 * Phase 999.42 Plan 06 — module-scoped late-bound holder for the skill
 * PATCH-action handler deps (`applyPatch` / `rejectPatch` /
 * `listPatchesForSkill` from skill-patch-actions.ts). Same scope-bridge
 * pattern as `phase132DraftActionDepsRef`: routeMethod is top-level and
 * cannot see startDaemon's local `log` / homedir-rooted resolver, so the
 * boot wiring stashes the closure here and the three patch IPC case
 * branches read it. Single-source-of-truth: only set inside startDaemon.
 * The deps shape is the Plan 05 `PatchActionDeps` (log + agentWorkspaceDir).
 */
let phase99942PatchActionDepsRef: {
  readonly log: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    warn: (obj: Record<string, unknown>, msg: string) => void;
    error: (obj: Record<string, unknown>, msg: string) => void;
  };
  readonly agentWorkspaceDir: (agent: string) => string;
} | null = null;
/**
 * UX-A (2026-08-26) — module-scoped late-bound holder for the superseded-
 * share marker. Same scope-bridge pattern as `phase132DraftActionDepsRef`:
 * routeMethod is top-level and cannot see startDaemon's local `log` or the
 * daemon-lifetime SharedDocRefStore, so boot wiring stashes the closure
 * here and the share-file IPC case reads it (null before boot ⇒ skip).
 */
let markSupersededShareRef:
  | ((args: {
      bridge: {
        discordClient: { channels: { fetch: (id: string) => Promise<unknown> } };
      };
      agentName: string;
      filename: string;
      messageId: string;
      channelId: string;
      caption: string | undefined;
      formatCaption: (s: string) => string;
    }) => Promise<void>)
  | null = null;
import { linkAgentSkills } from "../skills/linker.js";
import type { SkillsCatalog } from "../skills/types.js";
import { writeMessage, createMessage } from "../collaboration/inbox.js";
import {
  LoopGovernor,
  DEFAULT_LOOP_GOVERNOR_CONFIG,
} from "../collaboration/loop-governor.js";
import { DeliveryDedupe } from "../collaboration/delivery-dedupe.js";
import { PresentationRegistry } from "../collaboration/presentation-registry.js";

/**
 * Phase 999.117 — the agent-to-agent services constructed once at daemon boot
 * and shared by every A2A entry path.
 *
 * They MUST be single instances: the governor's budgets are per-conversation
 * and per-ordered-pair, and the dedupe only works if every consumer consults
 * one record of what has already been delivered. A second instance of either
 * silently halves the coverage.
 */
export type A2aServices = Readonly<{
  governor: LoopGovernor;
  dedupe: DeliveryDedupe;
  presentations: PresentationRegistry;
  reactionSender: {
    react(channelId: string, messageId: string, emoji: string): Promise<void>;
  };
}>;
import { createInboxAckEmitter, type InboxAckEmitter } from "../collaboration/inbox-ack.js";
import { SlashCommandHandler, resolveAgentCommands } from "../discord/slash-commands.js";
import { DiscordBridge } from "../discord/bridge.js";
// Phase 122 — universal table wrap at the bot-direct chokepoint. Imported
// here because the BotDirectSender concrete implementation lives inline in
// this file (object literal at the wireup site below); the type lives in
// restart-greeting.ts. By wrapping inside sendText / sendEmbed we cover
// daemon-ask-agent-ipc.ts:286 (999.12 mirror) AND
// daemon-post-to-agent-ipc.ts:220 (Phase 119 A2A-01) by inheritance.
import { formatOutboundText } from "../discord/markdown-table-wrap.js";
import { splitKeepingAnnotations } from "../discord/markdown-table-wrap.js";
import { deliverScheduledOutput, DeadLetterRateLimiter } from "./scheduled-delivery.js";
import { configureSuppressLinkEmbeds, deliveryFlags } from "../discord/delivery-flags.js";
import { chunkIndexForFile, planOutboundTables } from "../discord/table-delivery.js";
import { configureTableRendering } from "../discord/markdown-table-wrap.js";
import { ChannelType, type CategoryChannel, type GuildTextBasedChannel, type TextChannel } from "discord.js";
import { provisionAgent } from "./agent-provisioner.js";
import { ThreadManager } from "../discord/thread-manager.js";
import { THREAD_REGISTRY_PATH } from "../discord/thread-types.js";
// Phase 999.36 sub-bug C (D-09, D-10) — pure resolver for share-file
// channel routing. Consults the thread binding registry FIRST so subagent
// invocations route to their bound thread instead of falling back to a
// sibling agent's primary channel via shared-workspace identity drift.
import { resolveShareFileChannel } from "./tools/share-file-channel-resolver.js";
import { WebhookManager, buildWebhookIdentities } from "../discord/webhook-manager.js";
import {
  provisionWebhooks,
  verifyAgentWebhookIdentity,
} from "../discord/webhook-provisioner.js";
import { SemanticSearch } from "../memory/search.js";
import { MemoryScanner, type MemoryScannerDeps } from "../memory/memory-scanner.js";
import { isWithinDir, resolveMemoryRoots } from "../memory/memory-roots.js";
import { chunkText, chunkPdf } from "../documents/chunker.js";
// Phase 999.43 Plan 02 T03 — handler body lives in auto-ingest-handler.ts;
// the daemon case dynamic-imports it on first dispatch (memory-lookup
// handler precedent). No top-level classifier import needed here.
// Phase 101 Plan 02 T04 — robust ingestion engine + structured extraction.
// `ingest()` is the single entry point per `feedback_silent_path_bifurcation`.
import {
  ingest as ingestDocumentEngine,
  logIngest,
  computeDocSlug,
} from "../document-ingest/index.js";
import { extractStructured, IngestError as DocIngestError } from "../document-ingest/extractor.js";
import type { ExtractionSchemaName } from "../document-ingest/schemas/index.js";
import type { OcrBackend, TaskHint } from "../document-ingest/types.js";
import { setAllowMistralOcr } from "../document-ingest/ocr/index.js";
import { warmupReranker, applyRerankerEnvOverride } from "../memory/reranker.js";
// Phase 101 Plan 02 T05 — fail-mode alerts to admin-clawdy (U7, SC-7).
import {
  setIngestAlertDeps,
  recordIngestAlert,
} from "../document-ingest/alerts.js";
// Phase 101 Plan 03 T03 — U6 cross-ingest into memory_chunks so Phase 90
// hybrid-RRF surfaces document content on subsequent agent turns.
import {
  crossIngestToMemory,
  MigrationPhaseStore,
} from "../document-ingest/cross-ingest.js";
import { GraphSearch } from "../memory/graph-search.js";
import { invokeMemoryLookup } from "./memory-lookup-handler.js";
// Phase 115 sub-scope 7 — lazy-load memory tools (T01).
import {
  clawcodeMemorySearch,
  clawcodeMemoryRecall,
  clawcodeMemoryEdit,
  clawcodeMemoryArchive,
} from "../memory/tools/index.js";
// Phase 999.8 Plan 01 — pure handler for memory-graph IPC with configurable LIMIT.
import { handleMemoryGraphIpc } from "./memory-graph-handler.js";
import { startOfWeek } from "date-fns";
import { ConfigWatcher } from "../config/watcher.js";
import { ConfigReloader } from "./config-reloader.js";
import {
  armShutdownWatchdog,
  withShutdownStep,
  DEFAULT_SHUTDOWN_STEP_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_WATCHDOG_MS,
} from "./shutdown-watchdog.js";
import {
  assertIngestSizeWithinLimit,
  resolveIngestMaxInputBytes,
} from "./ingest-size-guard.js";
import {
  decideAgentIdentity,
  initProcessIdentitySecret,
  getProcessIdentitySecret,
  AGENT_TOKEN_PARAM,
  CALLER_AGENT_PARAM,
} from "./agent-identity-token.js";
import {
  enforceCrossAgentIsolation,
  resolveVerifiedCaller,
  assertCrossAgentAllowed,
} from "./agent-owner-isolation.js";
import type { ConfigDiff } from "../config/types.js";
import Database from "better-sqlite3";
import { DeliveryQueue } from "../discord/delivery-queue.js";
import { SubagentThreadSpawner } from "../discord/subagent-thread-spawner.js";
import { AllowlistMatcher } from "../security/allowlist-matcher.js";
import { ApprovalLog } from "../security/approval-log.js";
import { parseSecurityMd } from "../security/acl-parser.js";
import type { SecurityPolicy } from "../security/types.js";
import { startDashboardServer } from "../dashboard/server.js";
import { PreviewStore } from "../dashboard/preview-store.js";
import { handleShowPreview } from "./show-preview-handler.js";
import { renderPreviewSnapshot, renderPreviewMotion } from "./preview-snapshot.js";
import { DashboardAuditTrail } from "../dashboard/dashboard-audit-trail.js";
import { startOpenAiEndpoint, type OpenAiEndpointHandle } from "../openai/endpoint-bootstrap.js";
import { installWorkspaceSkills } from "../skills/installer.js";
import { EscalationMonitor } from "./escalation.js";
import type { EscalationConfig } from "./escalation.js";
import { AdvisorBudget } from "../usage/advisor-budget.js";
import { VerboseState } from "../usage/verbose-state.js";
// Phase 117-03 — ported advisor system-prompt builder (parity baseline from
// the inline construction at the old :9836 site). The IPC handler at
// `ask-advisor` now calls this rather than inlining the string.
import { buildAdvisorSystemPrompt } from "../advisor/prompts.js";
// Phase 117-07 — provider-neutral AdvisorService composition at daemon boot.
// The IPC handler at `ask-advisor` dispatches through this service (which
// owns budget enforcement + truncation + backend dispatch) rather than
// inlining `forkAdvisorConsult`. The two backends registered today are
// `LegacyForkAdvisor` (rollback path, fork+dispatch) and `AnthropicSdkAdvisor`
// (native marker; see backend file header for why `consult()` throws).
import {
  DefaultAdvisorService,
  BackendRegistry,
  resolveAdvisorModel as resolveAdvisorModelAlias,
  type AdvisorService,
  type BackendId,
} from "../advisor/index.js";
// Phase 999.114 — the accepted config-alias set + its type, derived from the
// single-source-of-truth catalog (replaces hand-listed 4-literal unions).
import { MODEL_ALIASES, type ConfigModel } from "../shared/model-catalog.js";
import { LegacyForkAdvisor } from "../advisor/backends/legacy-fork.js";
import { AnthropicSdkAdvisor } from "../advisor/backends/anthropic-sdk.js";
// Single source of truth for child-spawn env credential handling.
import { buildAnthropicSafeEnv } from "./spawn-env.js";
import {
  resolveAdvisorBackend,
  resolveAdvisorModel as resolveAdvisorModelConfig,
} from "../config/loader.js";
import { EscalationBudget } from "../usage/budget.js";
import { modelSchema, agentSchema, effortSchema } from "../config/schema.js";
import type { EffortLevel } from "../config/schema.js";
// Phase 116-03 F26 — agent-block patcher (in-UI config editor).
import { patchAgentInYaml } from "../config/yaml-patcher.js";
import type { ResolvedAgentConfig, ResolvedMarketplaceSources } from "../shared/types.js";
// Phase 86 Plan 02 MODEL-04 — atomic YAML persistence for `agents[*].model`.
import { updateAgentModel, updateAgentSkills } from "../migration/yaml-writer.js";
import { ModelNotAllowedError } from "./model-errors.js";
// Phase 88 Plan 02 MKT-01..07 — marketplace catalog + single-skill installer.
import {
  loadMarketplaceCatalog,
  type MarketplaceEntry,
} from "../marketplace/catalog.js";
import {
  installSingleSkill,
  type SkillInstallOutcome,
} from "../marketplace/install-single-skill.js";
import { DEFAULT_SKILLS_LEDGER_PATH } from "../migration/skills-ledger.js";
// Phase 90 Plan 05 HUB-02 / HUB-04 — ClawHub plugin list + install + manifest fetch.
import {
  fetchClawhubPlugins,
  downloadClawhubPluginManifest,
  type ClawhubPluginsResponse,
  type ClawhubPluginListItem,
} from "../marketplace/clawhub-client.js";
import {
  installClawhubPlugin,
  mapFetchErrorToOutcome,
  type PluginInstallOutcome,
} from "../marketplace/install-plugin.js";
// Phase 90 Plan 06 HUB-05 / HUB-07 — GitHub OAuth device-code flow +
// 1Password op:// rewrite probe for install-time config collection.
// Imported via module namespace so tests can vi.spyOn() the exports.
import * as githubOauthMod from "../marketplace/github-oauth.js";
import * as opRewriteMod from "../marketplace/op-rewrite.js";
import type { OpRewriteProposal } from "../marketplace/op-rewrite.js";
// Phase 90 Plan 04 HUB-08 — ClawHub cache primitive. Plan 05 instantiates
// a daemon-scoped cache<ClawhubPluginsResponse> for plugin list calls.
import { createClawhubCache } from "../marketplace/clawhub-cache.js";
import type { ClawhubCache } from "../marketplace/clawhub-cache.js";
import { resolveMarketplaceSources } from "../config/loader.js";
import type { Logger } from "pino";
import { detectUnconsolidatedWeeks, runConsolidation } from "../memory/consolidation.js";
import { summarizeWithHaiku } from "./summarize-with-haiku.js";
import { callHaikuDirect, callModelDirect, configureHaikuRouting } from "./haiku-direct.js";
import { synthesizeReport } from "./workflow-summary/synthesize-report.js";
import {
  pruneWorkflowArtifacts,
  DEFAULT_KEEP_WORKFLOWS,
} from "./workflow-summary/prune-workflow-artifacts.js";
import { GoalManager } from "./goal-manager.js";
// Phase 142 — agent optimizer trigger (run-agent-optimization IPC + /clawcode-optimize).
import {
  handleRunAgentOptimizationIpc,
  type RunAgentOptimizationRequest,
  type RunAgentOptimizationIpcDeps,
} from "./optimizer-ipc.js";
import { runAgentOptimization } from "../optimizer/optimizer-run.js";
import { loadEvalSet } from "../optimizer/eval-set.js";
import { makeOptimizerForkResolver } from "../optimizer/fork-resolver.js";
import type { ScheduleEntry } from "../scheduler/types.js";
import type {
  CacheHitRateStatus,
  CacheTelemetryReport,
  LatencyReport,
  PercentileRow,
  SloMetric,
  SloStatus,
  ToolPercentileRow,
} from "../performance/types.js";
import { sinceToIso } from "../performance/percentiles.js";
import {
  DEFAULT_SLOS,
  evaluateCacheHitRateStatus,
  evaluateSloStatus,
  getPerToolSlo,
  mergeSloOverrides,
  resolveSloFor,
  type SloEntry,
} from "../performance/slos.js";
import type { TraceStore } from "../performance/trace-store.js";
import type { TraceCollector } from "../performance/trace-collector.js";
import { scheduleDailySummaryCron, type DailySummaryCronHandle } from "./daily-summary-cron.js";
import { scheduleMemoryDigestCron, type MemoryDigestCronHandle } from "./memory-digest-cron.js";
import {
  collectFleetReportCard,
  scheduleReportCardCron,
  type ReportCardCronHandle,
  type ReportCardDeps,
} from "./report-card-cron.js";
import { renderReportCard } from "./report-card.js";
import {
  scheduleMigrationCron,
  kickEmbeddingMigrationBatch,
  type MigrationCronHandle,
} from "./migration-cron.js";
import { buildDreamMachinery } from "./dream-machinery.js";
import { registerDreamCron, type DreamCronRegistration } from "./dream-cron.js";
// Phase 999.188 — dream auto-promote: veto store (ONE instance), the veto
// tick that closes windows, and the promote primitive that writes MEMORY.md.
import { createDreamVetoStore, type VetoStoreRow } from "./dream-veto-store.js";
import { registerDreamVetoTick, type VetoTickHandle } from "./dream-veto-tick.js";
import { promoteCandidates, formatPromoteReport } from "./dream-promote.js";
import { resolveDreamPolicy } from "./dream-machinery.js";
import { INJECTED_MEMORY_MAX_CHARS } from "./context-assembler.js";
// Phase 138 Plan 05 — cross-provider auto-failover. The FailoverStateStore
// owns the `failover_state` table in the shared fleet-alerts.db; the
// FailoverController + 1-minute cron drive the threshold→failover state
// machine.
import { FailoverStateStore } from "../usage/failover-state.js";
import {
  FailoverController,
  type FailoverAgentConfig,
} from "./failover-controller.js";
import {
  scheduleFailoverCron,
  type FailoverCronHandle,
} from "./failover-cron.js";
import { isAgentIdle as isAgentIdlePrimitive } from "./idle-window-detector.js";
import { isDiscordRateLimitError } from "../discord/streaming.js";
import { nanoid } from "nanoid";
import { createPool, type Pool } from "mysql2/promise";
// Phase 70 — browser automation MCP.
import { BrowserManager } from "../browser/manager.js";
import {
  MemoryGuard,
  MEMORY_GUARD_DEFAULTS,
  resolveOwnCgroupDir,
  type MemoryPage,
} from "./memory-guard.js";
// 999.147 — relief button: the one path where a Discord click SIGKILLs a
// process. All of the safety (pid-reuse, cgroup membership, daemon refusal)
// lives in memory-relief.ts; the daemon only supplies the effects.
import {
  executeRelief,
  getReliefDepsFactory,
  setReliefDepsFactory,
  makeCgroupMembership,
  makeReliefAudit,
  readReliefProc,
  DEFAULT_RELIEF_AUDIT_PATH,
  DEFAULT_UNRAID_AUDIT_PATH,
  type ReliefDeps,
} from "./memory-relief.js";
import {
  buildContainerReliefRow,
  buildReliefRow,
  containerReliefSuffix,
  reliefMessageSuffix,
  worthOffering,
} from "../discord/memory-relief-button.js";
import {
  makeUnraidSsh,
  UnraidWatch,
  type ContainerRestartDeps,
} from "../homelab/unraid-watch-service.js";
import { handleBrowserToolCall } from "../browser/daemon-handler.js";
import type { IpcBrowserToolCallParams } from "../ipc/types.js";
// Phase 71 — web search MCP.
import { handleSearchToolCall } from "../search/daemon-handler.js";
import { createBraveClient } from "../search/providers/brave.js";
import { createExaClient } from "../search/providers/exa.js";
import { fetchUrl } from "../search/fetcher.js";
import type { IpcSearchToolCallParams } from "../ipc/types.js";
// Phase 72 — image generation MCP.
import { handleImageToolCall } from "../image/daemon-handler.js";
import { createOpenAiImageClient } from "../image/providers/openai.js";
import { createMiniMaxImageClient } from "../image/providers/minimax.js";
import { createFalImageClient } from "../image/providers/fal.js";
import type { IpcImageToolCallParams } from "../ipc/types.js";
// Phase 145 WS3 (Plan 04) — ask-user-question round-trip contract + the
// extracted, unit-tested handler dispatcher.
import type { IpcAskUserQuestionParams } from "../ipc/types.js";
import { handleAskUserQuestion } from "./ask-user-question-handler.js";
import {
  SharedDocRefStore,
  sharedDocKey,
  supersededContent,
} from "./shared-doc-refs.js";
// Phase 145 WS2 (Plan 05) — background workflow orchestrator (fan-out half).
import type { IpcWorkflowSpec, IpcStartWorkflowParams, IpcWorkflowStep } from "../ipc/types.js";
import {
  WorkflowOrchestrator,
  MAX_WORKFLOW_PARALLEL_STEPS,
  // 999.106 W-2 — waved-execution caps, enforced at this IPC boundary too.
  MAX_WORKFLOW_TOTAL_STEPS,
  MAX_WORKFLOW_WAVES,
} from "./workflow-orchestrator.js";
import { readCgroupMemoryStats } from "./cgroup-stats.js";
import type { ImageBackend, ImageProvider } from "../image/types.js";

/**
 * Augment a LatencyReport's segments with `slo_status`, `slo_threshold_ms`,
 * and `slo_metric` per row, using `DEFAULT_SLOS` merged with per-agent
 * `perf.slos?` overrides.
 *
 * The threshold + metric are emitted ALONGSIDE the status so the dashboard
 * can render the "SLO target" subtitle directly from the response — single
 * source of truth stays server-side (no client mirror of DEFAULT_SLOS). An
 * agent overriding `end_to_end` to 4000ms will see both the cell tint AND
 * the subtitle reflect that value, never the default.
 *
 * A segment with no configured SLO passes through with `slo_threshold_ms:
 * null` and `slo_metric: null`; the dashboard falls back to the no-data
 * cell class and omits the subtitle. `slo_status` is intentionally left
 * unset on that branch — there's nothing to evaluate against.
 *
 * Pure; safe to call with `undefined` override array. Exported for unit
 * testing in `src/manager/__tests__/daemon-latency-slo.test.ts`.
 *
 * @param segments - Percentile rows from TraceStore.getPercentiles.
 * @param agentSlos - Per-agent `perf.slos?` overrides (may be undefined).
 * @returns Frozen array of rows with SLO fields populated.
 */
export function augmentWithSloStatus(
  segments: readonly PercentileRow[],
  agentSlos: readonly SloEntry[] | undefined,
): readonly PercentileRow[] {
  const effectiveSlos =
    agentSlos && agentSlos.length > 0
      ? mergeSloOverrides(DEFAULT_SLOS, agentSlos)
      : DEFAULT_SLOS;

  // First match wins per segment — matches the semantics of the dashboard's
  // "tint the cell for the server-reported metric" rendering path. If a
  // future revision adds multiple metrics per segment (e.g. p50 AND p95
  // first_token), this helper picks the first; the dashboard can be taught
  // to render both at that point.
  const slosBySeg = new Map<string, SloEntry>();
  for (const s of effectiveSlos) {
    if (!slosBySeg.has(s.segment)) slosBySeg.set(s.segment, s);
  }

  return Object.freeze(
    segments.map((segRow) => {
      const slo = slosBySeg.get(segRow.segment);
      if (!slo) {
        // No SLO configured for this segment — emit nulls so the response
        // shape is consistent across rows. Dashboard falls back to no-data
        // cell styling and omits the subtitle.
        return Object.freeze({
          ...segRow,
          slo_threshold_ms: null,
          slo_metric: null,
        });
      }
      return Object.freeze({
        ...segRow,
        slo_status: evaluateSloStatus(segRow, slo.thresholdMs, slo.metric),
        slo_threshold_ms: slo.thresholdMs,
        slo_metric: slo.metric,
      });
    }),
  );
}

/**
 * Phase 55 Plan 03 — augmented per-tool percentile row with server-evaluated
 * SLO fields attached. Mirrors the AugmentedToolRow shape consumed by the
 * CLI (src/cli/commands/tools.ts) and dashboard (src/dashboard/static/app.js)
 * so both renderers read the server truth directly without mirroring any
 * threshold constants client-side.
 */
export type AugmentedToolRow = ToolPercentileRow & {
  readonly slo_status: SloStatus;
  readonly slo_threshold_ms: number;
  readonly slo_metric: SloMetric;
};

/**
 * Phase 55 Plan 03 — augment per-tool percentile rows with SLO status /
 * threshold / metric using `getPerToolSlo` (per-tool override wins, global
 * tool_call SLO as fallback — always yields non-null threshold + metric).
 *
 * The SQL query (`TraceStore.getToolPercentiles`) already sorts rows by
 * p95 DESC (nulls last); this helper preserves that ordering so consumers
 * render slowest-first without a client-side resort.
 *
 * Pure; safe to call with `undefined` perfTools. Exported for unit testing
 * in `src/manager/__tests__/daemon-tools.test.ts`.
 *
 * @param rows      - Frozen per-tool percentile rows from TraceStore.
 * @param perfTools - Optional `perf.tools` config block (only `.slos` read).
 * @returns Frozen array of augmented rows with SLO fields populated.
 */
export function augmentToolsWithSlo(
  rows: readonly ToolPercentileRow[],
  perfTools:
    | {
        readonly slos?: Readonly<
          Record<
            string,
            { readonly thresholdMs: number; readonly metric?: SloMetric }
          >
        >;
      }
    | undefined,
): readonly AugmentedToolRow[] {
  return Object.freeze(
    rows.map((row) => {
      const slo = getPerToolSlo(row.tool_name, perfTools);
      return Object.freeze({
        ...row,
        slo_status: evaluateSloStatus(row, slo.thresholdMs, slo.metric),
        slo_threshold_ms: slo.thresholdMs,
        slo_metric: slo.metric,
      });
    }),
  );
}

/**
 * Phase 54 Plan 04 — minimum first_token sample count before the headline
 * card transitions out of "warming up" (no_data / gray). Protects operators
 * from seeing red on a newly-started agent where a single outlier skews p50.
 */
export const COLD_START_MIN_TURNS = 5;

/**
 * Phase 54 Plan 04 — shape emitted as the top-level `first_token_headline`
 * object on the `latency` IPC response.
 *
 * Mirrors the three SLO fields on PercentileRow so the dashboard + CLI render
 * the headline card verbatim from the server response (no client-side SLO
 * mirror — Phase 51 Plan 03 invariant preserved).
 */
export type FirstTokenHeadline = {
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly count: number;
  readonly slo_status: SloStatus;
  readonly slo_threshold_ms: number | null;
  readonly slo_metric: SloMetric | null;
};

/**
 * Phase 54 Plan 04 — evaluate the First Token headline object that appears
 * at the top of each agent tile on the dashboard and as a block above the
 * segments table in the CLI.
 *
 * Cold-start guard: when `row.count < COLD_START_MIN_TURNS`, slo_status is
 * forced to "no_data" regardless of the measured percentile. Operators see
 * a neutral gray "warming up" card until the 5th sample arrives.
 *
 * Per-agent perf.slos overrides for first_token flow through via
 * `mergeSloOverrides`, so an agent that sets a custom threshold sees the
 * card coloring reflect that (single source of truth stays server-side).
 *
 * @param row        - PercentileRow for first_token (typically from
 *                     TraceStore.getFirstTokenPercentiles).
 * @param agentSlos  - Per-agent overrides from `perf.slos?` (may be undefined).
 * @returns Frozen FirstTokenHeadline.
 */
export function evaluateFirstTokenHeadline(
  row: PercentileRow,
  agentSlos: readonly SloEntry[] | undefined,
): FirstTokenHeadline {
  const effectiveSlos =
    agentSlos && agentSlos.length > 0
      ? mergeSloOverrides(DEFAULT_SLOS, agentSlos)
      : DEFAULT_SLOS;
  const slo = effectiveSlos.find((s) => s.segment === "first_token");

  // Cold-start guard — preempts healthy/breach coloring.
  if (row.count < COLD_START_MIN_TURNS) {
    return Object.freeze({
      p50: row.p50,
      p95: row.p95,
      p99: row.p99,
      count: row.count,
      slo_status: "no_data" as SloStatus,
      slo_threshold_ms: slo?.thresholdMs ?? null,
      slo_metric: slo?.metric ?? null,
    });
  }

  if (!slo) {
    return Object.freeze({
      p50: row.p50,
      p95: row.p95,
      p99: row.p99,
      count: row.count,
      slo_status: "no_data" as SloStatus,
      slo_threshold_ms: null,
      slo_metric: null,
    });
  }

  return Object.freeze({
    p50: row.p50,
    p95: row.p95,
    p99: row.p99,
    count: row.count,
    slo_status: evaluateSloStatus(row, slo.thresholdMs, slo.metric),
    slo_threshold_ms: slo.thresholdMs,
    slo_metric: slo.metric,
  });
}

// ---------------------------------------------------------------------------
// Phase 86 Plan 02 MODEL-04 — set-model IPC handler (pure, testable).
//
// Extracted from the daemon's `case "set-model":` so `src/manager/__tests__/
// daemon-set-model.test.ts` can drive the full behaviour (live SDK swap BEFORE
// YAML persist, typed ModelNotAllowedError → ManagerError w/ code -32602 +
// data.allowed, atomic YAML round-trip, non-rollback on persistence failure)
// without spinning up the full daemon surface.
//
// Contract:
//   - setModelForAgent fires FIRST (Plan 01 SDK swap). If it throws:
//       * ModelNotAllowedError → ManagerError w/ code=-32602 + data.allowed
//       * any other error → rethrown as-is
//   - On successful swap, updateAgentModel is called. Persistence failure
//     does NOT undo the live swap (rationale: SDK swap is irreversible —
//     see Plan 02 non-rollback decision). `persisted: false` + `persist_error`
//     are surfaced in the response.
//   - In-memory configs[] is updated AFTER the persist attempt so a fresh
//     restart reads the same value the operator just set (ref matches disk).
// ---------------------------------------------------------------------------

/**
 * Minimal manager surface the set-model IPC handler needs — defined as a
 * structural type so tests can inject a stub without constructing a full
 * SessionManager. Matches the real SessionManager method signatures byte for
 * byte (setModelForAgent throws ModelNotAllowedError on allowlist violation).
 */
export type SetModelIpcManager = {
  // Phase 999.98 W-1 — WIDENED to include "fable" (NOT cast-narrowed): this is
  // the live `/clawcode-model` switch path. Cast-narrowing here would silently
  // break live-switching a running agent to Fable.
  // Phase 999.114 — now `ModelAlias`, DERIVED from the catalog, instead of a
  // hand-listed 4-literal union. The union had to be edited by hand for every
  // new pin; historical pins (opus-4-6, fable-5, …) are live-switch targets too.
  setModelForAgent: (
    name: string,
    alias: ConfigModel,
    resolvedId?: string,
  ) => void;
  setAllAgentConfigs: (configs: readonly ResolvedAgentConfig[]) => void;
};

/**
 * Dependencies for the pure set-model handler. `configs` is mutable by design
 * — the handler splices the updated frozen entry in place to mirror the
 * pre-existing daemon invariant that `configs[idx].model` reflects the most
 * recent runtime value (read by subsequent IPC methods + /clawcode-status
 * fallback when the handle isn't yet swapped).
 */
export type SetModelIpcDeps = {
  readonly manager: SetModelIpcManager;
  /**
   * Phase 999.114 — the daemon-owned discovered-model snapshot, needed to
   * resolve a `<family>@latest` live switch to a concrete SDK id. Injected (not
   * imported) so the handler stays unit-testable with a stub.
   */
  readonly catalogSnapshot: () => CatalogSnapshot;
  /** Injected clock for the `@latest` freshness bound (testability). */
  readonly nowMs: () => number;
  readonly configs: ResolvedAgentConfig[];
  readonly configPath: string;
  readonly params: Record<string, unknown>;
};

/**
 * Response payload for the set-model IPC method.
 * `persisted: true` — YAML write succeeded (or was a no-op because the bytes
 * already matched); `persisted: false` — live swap succeeded but the YAML
 * write threw (operator must reconcile by hand or re-invoke).
 */
export type SetModelIpcResult = Readonly<{
  agent: string;
  // Phase 999.98 W-1 — WIDENED to include "fable" so a fable/@latest flip is not
  // mistyped on the live-switch result payload (part of D11's live-flip story).
  // Phase 999.114 — `ConfigModel`, derived from the catalog (see above). This
  // is deliberately WIDER than `ModelAlias`: a `<family>@latest` selection is
  // persisted VERBATIM so the agent keeps TRACKING. Writing the resolved
  // concrete id here instead would silently convert a tracking agent into a
  // pinned one the first time an operator touched the picker.
  old_model: ConfigModel;
  new_model: ConfigModel;
  persisted: boolean;
  persist_error: string | null;
  note: string;
}>;

export async function handleSetModelIpc(
  deps: SetModelIpcDeps,
): Promise<SetModelIpcResult> {
  const { manager, configs, configPath, params, catalogSnapshot, nowMs } = deps;

  const agentName = validateStringParam(params, "agent");
  const modelParam = validateStringParam(params, "model");

  // --- Defense-in-depth: validate alias before any side effect ------
  // SessionManager.setModelForAgent validates too, but failing fast here
  // produces a clean ManagerError message instead of a runtime type
  // error from inside the SDK wiring.
  const parsed = modelSchema.safeParse(modelParam);
  if (!parsed.success) {
    // Phase 999.98 — error string lists the full modelSchema set (now incl.
    // fable). Per-agent `allowedModels` is enforced separately by
    // setModelForAgent (ModelNotAllowedError), so the picker still defaults
    // 3-only even though the schema admits fable here.
    // Phase 999.114 — the accepted set is DERIVED. The old message hardcoded
    // "haiku, sonnet, opus, fable" and would have silently lied about every
    // historical pin the schema now accepts.
    throw new ManagerError(
      `Invalid model '${modelParam}'. Must be one of: ${MODEL_ALIASES.join(", ")}`,
    );
  }
  // Phase 999.98 D11 — the live `/clawcode-model` switch is a CONCRETE-id
  // operation; `<family>@latest` is config-input sugar that the daemon
  // pre-resolves at session START (not a live-switch target). Reject it here
  // so `@latest` never reaches setModelForAgent / the SetModelIpcResult
  // payload (both deliberately typed 4-only: haiku|sonnet|opus|fable). An
  // operator wanting the newest tier live should switch to the concrete id.
  // Phase 999.98 D11 REJECTED `<family>@latest` here as "config-time sugar".
  // Phase 999.114 ACCEPTS it: tracking the newest entitled model in a family is
  // exactly the "new models become available automatically" behavior the
  // operator asked for, and it is the only path that needs NO deploy when
  // Anthropic ships a new version.
  //
  // The value PERSISTED to clawcode.yaml is the literal `fable@latest` (the
  // agent keeps tracking); only the LIVE SDK swap needs a concrete id, which we
  // resolve here from the daemon-owned catalog snapshot — the same snapshot,
  // and the same freshness bound, the session adapter uses at spawn.
  const newModel = parsed.data as ConfigModel;
  const resolvedId = newModel.endsWith("@latest")
    ? resolveLatestModel(newModel, catalogSnapshot(), {
        now: nowMs(),
        maxAgeMs: LATEST_MODEL_MAX_AGE_MS,
      })
    : undefined;

  // --- Agent lookup --------------------------------------------------
  const idx = configs.findIndex((c) => c.name === agentName);
  if (idx === -1) {
    throw new ManagerError(`Agent '${agentName}' not found in config`);
  }
  // Phase 999.98 D11 — the existing config model may be a `<family>@latest` value
  // (an agent pinned to the latest track). The SetModelIpcResult.old_model field
  // is deliberately concrete (live-switch result), so collapse `@latest` to its
  // family for the informational payload — the live swap itself always targets a
  // concrete `newModel`.
  const oldModelRaw = configs[idx]!.model;
  const oldModel = (
    oldModelRaw.endsWith("@latest")
      ? oldModelRaw.slice(0, -"@latest".length)
      : oldModelRaw
  ) as ConfigModel;

  // --- Live SDK swap FIRST (Plan 01) --------------------------------
  // Throws ModelNotAllowedError when alias is not in the resolved
  // allowedModels. Mapped to a typed IPC error so Plan 03's Discord
  // slash-command renderer reads `data.allowed` ephemerally.
  try {
    manager.setModelForAgent(agentName, newModel, resolvedId);
  } catch (err) {
    if (err instanceof ModelNotAllowedError) {
      throw new ManagerError(err.message, {
        code: -32602, // JSON-RPC "Invalid params" per Phase 86 Plan 02 contract
        data: {
          kind: "model-not-allowed",
          agent: err.agent,
          attempted: err.attempted,
          allowed: err.allowed,
        },
      });
    }
    throw err;
  }

  // --- Atomic YAML persist (Plan 02 MODEL-04) -----------------------
  // Runs AFTER the live swap so the Discord UX is instant; persistence
  // is a durable side-effect, not a gate. Failure here does NOT roll
  // back the swap (SDK swap is irreversible). Operator sees the error
  // in the response + can reconcile by hand.
  let persisted = false;
  let persistError: string | null = null;
  try {
    const result = await updateAgentModel({
      existingConfigPath: configPath,
      agentName,
      newModel,
    });
    if (result.outcome === "updated" || result.outcome === "no-op") {
      persisted = true;
    } else {
      persistError = result.reason;
    }
  } catch (err) {
    persistError = err instanceof Error ? err.message : String(err);
    // Do NOT re-throw: the live swap already succeeded and is visible to
    // the next turn via getModelForAgent. Operator receives a
    // persisted:false response and can re-invoke /clawcode-model to
    // retry YAML write.
  }

  // --- Mirror in-memory config (matches pre-Plan-02 invariant) ------
  // Updated AFTER the persist attempt so a fresh restart reads the
  // same alias the operator just set. The frozen-copy pattern matches
  // CLAUDE.md immutability rules (never mutate ResolvedAgentConfig in
  // place; replace the ref).
  const existingConfig = configs[idx]!;
  const updatedConfig = Object.freeze({ ...existingConfig, model: newModel });
  configs[idx] = updatedConfig;
  manager.setAllAgentConfigs(configs);

  return Object.freeze({
    agent: agentName,
    old_model: oldModel,
    new_model: newModel,
    persisted,
    persist_error: persistError,
    note: persisted
      ? "Live swap + clawcode.yaml updated"
      : `Live swap OK; persistence failed: ${persistError ?? "unknown"}`,
  });
}

// ---------------------------------------------------------------------------
// Phase 87 Plan 02 CMD-02 — set-permission-mode IPC handler (pure, testable).
//
// Thin wrapper around SessionManager.setPermissionModeForAgent. Unlike
// set-model, permission mode is intentionally ephemeral — NO YAML
// persistence. Runtime swap only; state resets on agent restart. Mirrors
// the set-effort shape (validate params → dispatch → ok-envelope).
// ---------------------------------------------------------------------------

/**
 * Minimal manager surface the set-permission-mode IPC handler needs.
 * Structural type so tests can inject a stub without a full SessionManager.
 */
export type SetPermissionModeIpcManager = {
  setPermissionModeForAgent: (name: string, mode: string) => void;
};

export type SetPermissionModeIpcDeps = {
  readonly manager: SetPermissionModeIpcManager;
  readonly params: Record<string, unknown>;
};

export type SetPermissionModeIpcResult = Readonly<{
  ok: true;
  agent: string;
  permission_mode: string;
}>;

/**
 * Dispatch `set-permission-mode` via SessionManager.setPermissionModeForAgent.
 *
 * Rethrows invalid-mode / unknown-agent errors from the SessionManager as
 * ManagerError so the IPC envelope carries a clean JSON-RPC message instead
 * of a bare Error / SessionError instance the transport cannot serialize
 * with its type information.
 */
export async function handleSetPermissionModeIpc(
  deps: SetPermissionModeIpcDeps,
): Promise<SetPermissionModeIpcResult> {
  const { manager, params } = deps;
  const name = validateStringParam(params, "name");
  const mode = validateStringParam(params, "mode");
  try {
    manager.setPermissionModeForAgent(name, mode);
  } catch (err) {
    // Normalize into ManagerError so the IPC JSON-RPC envelope carries the
    // message consistently (SessionError / Error subclasses are stripped to
    // a plain string at the transport boundary).
    const msg = err instanceof Error ? err.message : String(err);
    throw new ManagerError(msg);
  }
  return { ok: true, agent: name, permission_mode: mode };
}

// ---------------------------------------------------------------------------
// Phase 110 Stage 0b 0B-RT-13 — list-mcp-tools IPC handler (pure, testable).
//
// Wave 1 daemon-side prerequisite for Waves 2-4. Future Go shims call this
// method at boot to fetch the canonical MCP tool list for their shim type,
// JSON-Schema-converted from the single-source-of-truth Zod definitions in
// `src/{search,image,browser}/tools.ts`. Schemas stay single-sourced — the
// Go shim does NOT duplicate Zod (Pitfall 4 in 110-RESEARCH.md — schema
// drift between TS and Go).
//
// JSON Schema conversion uses zod/v4's NATIVE `z.toJSONSchema()` — no new
// npm dep. (CONTEXT.md hedged "verify zod-to-json-schema in deps before
// adding"; native availability is the answer to that verification, and
// CLAUDE.md's "no new deps" rule prefers native.)
//
// Sequencing constraint (locked in 110-CONTEXT.md): this handler ships in
// its own commit BEFORE any Go shim builds against it.
//
// Pure-DI shape mirrors handleSetModelIpc / handleRunDreamPassIpc. Tests
// inject TOOL_DEFINITIONS arrays directly so the unit suite doesn't depend
// on the search/image/browser modules' transitive imports (providers,
// readability, playwright). Production wiring at the daemon edge passes
// the real TOOL_DEFINITIONS imports.
// ---------------------------------------------------------------------------

import {
  listMcpToolsRequestSchema,
  type ListMcpToolsRequest,
  type ListMcpToolsResponse,
  type McpToolSchema,
} from "../ipc/protocol.js";
import { z as zV4 } from "zod/v4";
// Phase 110 Stage 0b 0B-RT-13 — production wiring imports for the
// list-mcp-tools handler. Aliased so the unit-test deps surface (which
// passes synthetic fixtures) and the production wiring (which imports
// the real frozen TOOL_DEFINITIONS arrays) stay distinct in greps.
import { TOOL_DEFINITIONS as SEARCH_TOOL_DEFINITIONS } from "../search/tools.js";
import { TOOL_DEFINITIONS as IMAGE_TOOL_DEFINITIONS } from "../image/tools.js";
import { TOOL_DEFINITIONS as BROWSER_TOOL_DEFINITIONS } from "../browser/tools.js";

/**
 * Shape of one tool definition the handler converts. Matches the
 * `ToolDefinition` interface exported by every shim's tools.ts (search,
 * image, browser) — narrow structural type so tests can pass synthetic
 * arrays without importing the full provider stack.
 */
export interface ListMcpToolsHandlerToolDef {
  readonly name: string;
  readonly description: string;
  readonly schemaBuilder: (z_: typeof zV4) => Record<string, unknown>;
}

/**
 * DI surface for the list-mcp-tools IPC handler. Production wiring at the
 * daemon edge passes the real imported TOOL_DEFINITIONS arrays; unit tests
 * pass synthetic fixtures.
 */
export interface ListMcpToolsIpcDeps {
  readonly searchTools: ReadonlyArray<ListMcpToolsHandlerToolDef>;
  readonly imageTools: ReadonlyArray<ListMcpToolsHandlerToolDef>;
  readonly browserTools: ReadonlyArray<ListMcpToolsHandlerToolDef>;
  /**
   * Optional override for the JSON Schema converter. Defaults to zod/v4's
   * native `z.toJSONSchema`. Tests can substitute a deterministic stub if
   * native output drifts across zod minor versions.
   */
  readonly toJsonSchema?: (shape: unknown) => Record<string, unknown>;
}

/**
 * Build the JSON-Schema-converted tool list for the requested shim type.
 *
 * Returns a NEW array (CLAUDE.md immutability — never mutates the input
 * TOOL_DEFINITIONS arrays which are `Object.freeze`d ReadonlyArrays anyway).
 *
 * Throws ManagerError(-32602) on invalid params — the listMcpToolsRequestSchema
 * Zod parser handles enum + missing-field validation in a single pass.
 */
export function handleListMcpToolsIpc(
  deps: ListMcpToolsIpcDeps,
  rawParams: unknown,
): ListMcpToolsResponse {
  const parsed = listMcpToolsRequestSchema.safeParse(rawParams);
  if (!parsed.success) {
    // -32602 invalid params per JSON-RPC 2.0 spec (mirrors Phase 86 Plan 02
    // ModelNotAllowedError mapping at line 575).
    throw new ManagerError(
      `list-mcp-tools: invalid params: ${parsed.error.message}`,
      { code: -32602 },
    );
  }
  const req: ListMcpToolsRequest = parsed.data;

  const defs =
    req.shimType === "search"
      ? deps.searchTools
      : req.shimType === "image"
        ? deps.imageTools
        : deps.browserTools;

  // Native zod/v4 converter; tests can override.
  const convert =
    deps.toJsonSchema ??
    ((shape: unknown): Record<string, unknown> =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      zV4.toJSONSchema(shape as any) as Record<string, unknown>);

  const tools: McpToolSchema[] = defs.map((def) => {
    // schemaBuilder returns a raw shape (Record); wrap with z.object() so
    // toJSONSchema sees the full object schema (with required[] fields).
    const rawShape = def.schemaBuilder(zV4) as Record<string, unknown>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const objectSchema = zV4.object(rawShape as any);
    return {
      name: def.name,
      description: def.description,
      inputSchema: convert(objectSchema),
    };
  });

  return { tools };
}

// ---------------------------------------------------------------------------
// Phase 95 Plan 03 DREAM-07 — run-dream-pass IPC handler (pure, testable).
//
// Operator-driven manual dream-pass trigger backing both `clawcode dream
// <agent>` (CLI) and `/clawcode-dream` (Discord slash, admin-only). Reuses
// Plan 95-01's runDreamPass + Plan 95-02's applyDreamResult primitives
// verbatim — neither path duplicates dream-pass logic.
//
// Pure-DI shape mirrors handleSetModelIpc + Phase 94-01 mcp-probe handler.
// Tests stub all four primitives (runDreamPass, applyDreamResult,
// isAgentIdle, getResolvedDreamConfig) so the handler's own decision tree
// is exercised without spinning up the SessionManager / TurnDispatcher /
// MemoryStore stack.
//
// Decision tree:
//   1. agent not in registry → throw ManagerError(-32602)
//   2. dream config disabled AND !force → skipped(disabled), no run
//   3. !idleBypass AND !isAgentIdle → skipped(agent-active), no run
//   4. else → runDreamPass(agent, model) → applyDreamResult(agent, outcome)
//      → return {outcome, applied, agent, startedAt}
//
// Token-cost gate: skipped paths NEVER call runDreamPass — the LLM dispatch
// is the only expensive step.
// ---------------------------------------------------------------------------

/**
 * Phase 95 Plan 03 — IPC request shape for run-dream-pass.
 */
export interface RunDreamPassRequest {
  readonly agent: string;
  readonly modelOverride?: "haiku" | "sonnet" | "opus";
  readonly idleBypass?: boolean;
  readonly force?: boolean;
}

/**
 * Phase 95 Plan 03 — IPC response shape for run-dream-pass.
 */
export interface RunDreamPassResponse {
  readonly outcome: import("./dream-pass.js").DreamPassOutcome;
  readonly applied: import("./dream-auto-apply.js").DreamApplyOutcome;
  readonly agent: string;
  readonly startedAt: string;
}

/**
 * Phase 95 Plan 03 — DI surface. Production wiring at the daemon edge maps
 * each function to the real primitive; tests inject vi.fn() stubs.
 */
export interface RunDreamPassIpcDeps {
  readonly runDreamPass: (
    agent: string,
    model: string,
  ) => Promise<import("./dream-pass.js").DreamPassOutcome>;
  readonly applyDreamResult: (
    agent: string,
    outcome: import("./dream-pass.js").DreamPassOutcome,
  ) => Promise<import("./dream-auto-apply.js").DreamApplyOutcome>;
  readonly isAgentIdle: (
    agent: string,
  ) => { readonly idle: boolean; readonly reason: string };
  readonly getResolvedDreamConfig: (
    agent: string,
  ) =>
    | { readonly enabled: boolean; readonly idleMinutes: number; readonly model: string }
    | null;
  readonly knownAgents: () => readonly string[];
  readonly now: () => Date;
  readonly log: {
    info: (m: string) => void;
    warn: (m: string) => void;
    error: (m: string) => void;
  };
}

/**
 * Pure exported handler — orchestrates the runDreamPass + applyDreamResult
 * chain with idle-gate + force-override + model-override semantics.
 */
export async function handleRunDreamPassIpc(
  req: RunDreamPassRequest,
  deps: RunDreamPassIpcDeps,
): Promise<RunDreamPassResponse> {
  if (!deps.knownAgents().includes(req.agent)) {
    throw new ManagerError(`agent not found: ${req.agent}`, {
      code: -32602,
    });
  }
  const startedAt = deps.now().toISOString();
  const baseConfig = deps.getResolvedDreamConfig(req.agent);

  // Disabled-config short-circuit (force overrides operator-side).
  const enabled = baseConfig?.enabled ?? false;
  if (!enabled && !req.force) {
    deps.log.info(
      `[run-dream-pass] ${req.agent}: skipped — dream.enabled=false (use --force to override)`,
    );
    return {
      outcome: { kind: "skipped", reason: "disabled" },
      applied: { kind: "skipped", reason: "no-completed-result" },
      agent: req.agent,
      startedAt,
    };
  }

  // Idle-gate short-circuit (idleBypass overrides operator-side).
  if (!req.idleBypass) {
    const idle = deps.isAgentIdle(req.agent);
    if (!idle.idle) {
      deps.log.info(
        `[run-dream-pass] ${req.agent}: skipped — agent active (${idle.reason}); use --idle-bypass to override`,
      );
      return {
        outcome: { kind: "skipped", reason: "agent-active" },
        applied: { kind: "skipped", reason: "no-completed-result" },
        agent: req.agent,
        startedAt,
      };
    }
  }

  // Resolve model: explicit override > config default > "haiku" fallback.
  const model = req.modelOverride ?? baseConfig?.model ?? "haiku";

  // deps.runDreamPass + deps.applyDreamResult — Plan 95-01 + 95-02 primitives.
  const outcome = await deps.runDreamPass(req.agent, model);
  const applied = await deps.applyDreamResult(req.agent, outcome);
  deps.log.info(
    `[run-dream-pass] ${req.agent}: outcome=${outcome.kind} applied=${applied.kind}`,
  );
  return { outcome, applied, agent: req.agent, startedAt };
}

// ---------------------------------------------------------------------------
// Phase 92 GAP CLOSURE — yaml-writer outcome→YamlWriteOutcome adapter.
// Mirrors the helper in src/cli/commands/cutover-apply-additive.ts so the
// daemon's IPC handlers can reuse the same Phase 86 atomic-writer call shape.
function mapYamlOutcome(
  outcome: string,
  reason: string | undefined,
): { kind: "updated" | "no-op" | "not-found" | "file-not-found" | "refused"; reason?: string } {
  if (outcome === "updated") return { kind: "updated" };
  if (outcome === "no-op") return { kind: "no-op" };
  if (outcome === "not-found")
    return { kind: "not-found", reason: reason ?? "agent or file not found" };
  if (outcome === "file-not-found")
    return { kind: "file-not-found", reason: reason ?? "yaml not found" };
  if (outcome === "refused")
    return { kind: "refused", reason: reason ?? "schema/secret-scan refusal" };
  return { kind: "refused", reason: `unknown outcome: ${outcome}` };
}

// ---------------------------------------------------------------------------
// Phase 110 follow-up — daemon-side search-key resolution helper.
//
// Reads `defaults.search.brave.apiKey` and `defaults.search.exa.apiKey` from
// the parsed config, resolves op:// references via the boot-warm
// SecretsResolver cache, and returns a synthetic env that injects the
// resolved value at the matching apiKeyEnv key — overlaying process.env
// at exactly those two slots while preserving everything else.
//
// Returns process.env unchanged when neither yaml field is set, so the
// existing /etc/clawcode/env path keeps working as a fallback.
//
// Pure: no I/O (cache reads only), no logging — testable in isolation.
//
// Exported solely for unit tests at src/manager/__tests__/build-search-env.test.ts.
// The production call site is the daemon's createBraveClient/createExaClient
// construction in 9d below.
export function buildSearchEnv(
  searchCfg: { brave: { apiKeyEnv: string; apiKey?: string }; exa: { apiKeyEnv: string; apiKey?: string } },
  resolver: { getCached(uri: string): string | undefined },
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  const inject = (rawValue: string | undefined, envKey: string): void => {
    if (!rawValue) return;
    let resolved: string | undefined;
    if (rawValue.startsWith("op://")) {
      // SecretsResolver.preResolveAll already warmed the cache at boot.
      // getCached() returns the resolved string or undefined on cache miss
      // (which here means pre-resolve failed; legacy env-var fallback
      // takes over because we leave env[envKey] untouched).
      resolved = resolver.getCached(rawValue);
    } else {
      resolved = rawValue;
    }
    if (resolved && resolved.length > 0) {
      env[envKey] = resolved;
    }
  };
  inject(searchCfg.brave.apiKey, searchCfg.brave.apiKeyEnv);
  inject(searchCfg.exa.apiKey, searchCfg.exa.apiKeyEnv);
  return env;
}

// Phase 92 Plan 04 CUT-06 / CUT-07 — cutover-button-action IPC handler.
//
// MIRROR Phase 86 Plan 02 handleSetModelIpc blueprint: pure exported helper
// with DI surface, called from the daemon's closure-based intercept BEFORE
// routeMethod (per the marketplace handler pattern). Tests inject vi.fn()
// stubs for gapById + the applierDeps surface.
//
// Routes:
//   IPC params {customId} → parseCutoverButtonCustomId → gapById → dispatch
//                         → DestructiveButtonOutcome
//
// The IPC wrapper does NOT touch Discord — that's the slash-commands.ts
// inline handler's job. This handler is daemon-side because Plan 92-06's
// CLI-driven verify pipeline needs to invoke the same destructive-fix path
// without going through Discord.
// ---------------------------------------------------------------------------

import {
  handleCutoverButtonInteraction,
  type ButtonHandlerDeps,
} from "../cutover/button-handler.js";
import type { DestructiveButtonOutcome } from "../cutover/types.js";
// Phase 92 GAP CLOSURE — operator-facing CLI ↔ daemon IPC handlers.
import {
  handleCutoverVerifyIpc,
  handleCutoverRollbackIpc,
} from "./cutover-ipc-handlers.js";

/**
 * DI surface for handleCutoverButtonActionIpc. Mirrors ButtonHandlerDeps
 * verbatim because the IPC wrapper is a thin pass-through; it parses the
 * customId from IPC params and dispatches to the pure handler.
 */
export type CutoverButtonActionIpcDeps = ButtonHandlerDeps;

/**
 * Daemon-side IPC handler for `cutover-button-action`. Validates the
 * `customId` param, dispatches to the pure button-handler, and returns
 * the typed DestructiveButtonOutcome.
 *
 * Throws ManagerError when params.customId is missing or non-string so the
 * IPC envelope carries a clean JSON-RPC error message.
 */
export async function handleCutoverButtonActionIpc(
  params: { customId?: unknown },
  deps: CutoverButtonActionIpcDeps,
): Promise<DestructiveButtonOutcome> {
  const customId = params.customId;
  if (typeof customId !== "string" || customId.length === 0) {
    throw new ManagerError(
      "cutover-button-action: missing or invalid 'customId' param",
    );
  }
  // user.id is not used by the pure handler today (no per-user gating in
  // Plan 92-04), but the field is required by ButtonInteractionLike for
  // future extension. Pass a daemon-side sentinel.
  return handleCutoverButtonInteraction(
    { customId, user: { id: "daemon-ipc" } },
    deps,
  );
}

// ---------------------------------------------------------------------------
// Phase 88 Plan 02 MKT-01..07 — marketplace IPC handlers (pure, testable).
//
// MIRROR Phase 86 Plan 02 handleSetModelIpc blueprint:
//   - Exported pure helpers with DI surface
//   - ManagerError for typed domain errors
//   - case delegation in <10 lines at the bottom switch
//
// Post-install rewire:
//   After installSingleSkill succeeds with outcome in
//   {installed, installed-persist-failed, already-installed}, the handler
//   rescans skillsTargetDir (scanSkillsDirectory) and calls linkAgentSkills
//   against the target agent. This closes MKT-04's "hot-reload" requirement
//   — the new skill becomes linker-visible without a daemon restart.
// ---------------------------------------------------------------------------

/**
 * Shared dependency bundle for the three marketplace IPC handlers. `configs`
 * is mutable by design — the install/remove handlers splice updated frozen
 * entries in place so subsequent IPC methods (e.g. the `skills` observability
 * call) see the new `skills:` list without a daemon restart.
 *
 * The DI hooks (`loadCatalog`, `installSkill`, `updateSkills`, `scanCatalog`,
 * `linkSkills`) default to the real production implementations. Tests inject
 * stubs without needing `vi.mock`.
 */
export type MarketplaceIpcDeps = Readonly<{
  configs: ResolvedAgentConfig[];
  configPath: string;
  // Phase 90 Plan 04 HUB-01 — union of legacy {path,label?} and clawhub
  // {kind:"clawhub",baseUrl,...} shapes. Consumers (loadMarketplaceCatalog
  // + Plan 90-04 Task 2) discriminate on .kind.
  marketplaceSources: ResolvedMarketplaceSources;
  localSkillsPath: string;
  skillsTargetDir: string;
  ledgerPath: string;
  log: Logger;
  // DI hooks — default to real impls when omitted.
  loadCatalog?: typeof loadMarketplaceCatalog;
  installSkill?: typeof installSingleSkill;
  updateSkills?: typeof updateAgentSkills;
  scanCatalog?: typeof scanSkillsDirectory;
  linkSkills?: typeof linkAgentSkills;
  /**
   * Phase 93 Plan 02 D-93-02-2 — config.defaults.clawhubBaseUrl forwarded
   * here so handleMarketplaceListIpc can pass it to loadMarketplaceCatalog
   * for auto-injection. Optional → back-compat preserved when caller omits
   * (Pitfall 4 — keep the field optional to avoid the Rule 3 fixture cascade).
   */
  defaultClawhubBaseUrl?: string;
}>;

export type MarketplaceListIpcResult = Readonly<{
  agent: string;
  installed: readonly string[];
  available: readonly MarketplaceEntry[];
}>;

export type MarketplaceInstallIpcResult = Readonly<{
  outcome: SkillInstallOutcome;
  /** True iff post-install linkAgentSkills was invoked. */
  rewired: boolean;
}>;

export type MarketplaceRemoveIpcResult = Readonly<{
  agent: string;
  skill: string;
  removed: boolean;
  persisted: boolean;
  persist_error: string | null;
  reason?: string;
}>;

/**
 * `marketplace-list` — returns the installed-skills list AND the available
 * catalog (catalog minus already-installed) for the given agent.
 *
 * Plan 02's /clawcode-skills-browse handler consumes `available` directly
 * into a StringSelectMenuBuilder; /clawcode-skills consumes `installed`
 * directly into the remove-picker.
 */
export async function handleMarketplaceListIpc(
  deps: MarketplaceIpcDeps & { params: Record<string, unknown> },
): Promise<MarketplaceListIpcResult> {
  const agentName = validateStringParam(deps.params, "agent");
  const idx = deps.configs.findIndex((c) => c.name === agentName);
  if (idx === -1) {
    throw new ManagerError(`Agent '${agentName}' not found in config`);
  }
  const agent = deps.configs[idx]!;

  const loadCatalog = deps.loadCatalog ?? loadMarketplaceCatalog;
  const catalog = await loadCatalog({
    localSkillsPath: deps.localSkillsPath,
    sources: deps.marketplaceSources,
    log: deps.log,
    // Phase 93 Plan 02 D-93-02-2 — auto-inject default ClawHub source when
    // the operator hasn't configured an explicit clawhub source. Conditional
    // spread keeps the call argument clean when the field is undefined.
    ...(deps.defaultClawhubBaseUrl !== undefined
      ? { defaultClawhubBaseUrl: deps.defaultClawhubBaseUrl }
      : {}),
  });

  const installed = [...agent.skills];
  const installedSet = new Set(installed);
  const available = Object.freeze(
    catalog.filter((e) => !installedSet.has(e.name)),
  );

  return Object.freeze({
    agent: agentName,
    installed,
    available,
  });
}

/**
 * `marketplace-install` — installs ONE skill on the given agent and (on
 * successful copy) rewires the agent's workspace/skills/ symlink tree so
 * the new skill is linker-visible without a daemon restart.
 *
 * Rewire runs on `installed`, `installed-persist-failed`, and
 * `already-installed` outcomes (any outcome where the filesystem state
 * might be behind the intended symlinks). Refusal outcomes skip the
 * rewire.
 */
export async function handleMarketplaceInstallIpc(
  deps: MarketplaceIpcDeps & { params: Record<string, unknown> },
): Promise<MarketplaceInstallIpcResult> {
  const agentName = validateStringParam(deps.params, "agent");
  const skillName = validateStringParam(deps.params, "skill");
  const force = deps.params.force === true;

  // Fast-fail: agent lookup runs BEFORE catalog load so an unknown agent
  // doesn't pay the catalog-scan cost.
  const idx = deps.configs.findIndex((c) => c.name === agentName);
  if (idx === -1) {
    throw new ManagerError(`Agent '${agentName}' not found in config`);
  }

  const loadCatalog = deps.loadCatalog ?? loadMarketplaceCatalog;
  const catalog = await loadCatalog({
    localSkillsPath: deps.localSkillsPath,
    sources: deps.marketplaceSources,
    log: deps.log,
  });

  const installSkill = deps.installSkill ?? installSingleSkill;
  const outcome = await installSkill({
    skillName,
    agentName,
    catalog,
    skillsTargetDir: deps.skillsTargetDir,
    clawcodeYamlPath: deps.configPath,
    ledgerPath: deps.ledgerPath,
    force,
  });

  // Rewire on any outcome that left the filesystem in a state the
  // symlink tree should reflect.
  const shouldRewire =
    outcome.kind === "installed" ||
    outcome.kind === "installed-persist-failed" ||
    outcome.kind === "already-installed";

  let rewired = false;
  if (shouldRewire) {
    // In-memory mirror of the new skills list (installSingleSkill persisted
    // to YAML on `installed`, but the in-memory ResolvedAgentConfig needs
    // manual update). `already-installed` is a no-op; `installed-persist-
    // failed` still adds in-memory so the next invocation sees the skill
    // and the symlink matches.
    const existing = deps.configs[idx]!;
    const alreadyInList = existing.skills.includes(skillName);
    let updatedSkills = existing.skills as readonly string[];
    if (
      (outcome.kind === "installed" ||
        outcome.kind === "installed-persist-failed") &&
      !alreadyInList
    ) {
      updatedSkills = [...existing.skills, skillName];
      deps.configs[idx] = Object.freeze({
        ...existing,
        skills: updatedSkills,
      });
    }

    // Rescan the target dir so the fresh copy is in the catalog map.
    const scanCatalog = deps.scanCatalog ?? scanSkillsDirectory;
    const linkSkills = deps.linkSkills ?? linkAgentSkills;
    const freshCatalog = await scanCatalog(deps.skillsTargetDir, deps.log);
    await linkSkills(
      join(deps.configs[idx]!.workspace, "skills"),
      deps.configs[idx]!.skills,
      freshCatalog,
      deps.log,
    );
    rewired = true;
  }

  return Object.freeze({ outcome, rewired });
}

/**
 * `marketplace-remove` — removes ONE skill from the given agent's
 * `skills:` list in clawcode.yaml. Does NOT rewire symlinks (stale
 * symlink is harmless; scanner re-reads the YAML at next daemon boot).
 */
export async function handleMarketplaceRemoveIpc(
  deps: MarketplaceIpcDeps & { params: Record<string, unknown> },
): Promise<MarketplaceRemoveIpcResult> {
  const agentName = validateStringParam(deps.params, "agent");
  const skillName = validateStringParam(deps.params, "skill");

  const idx = deps.configs.findIndex((c) => c.name === agentName);
  if (idx === -1) {
    throw new ManagerError(`Agent '${agentName}' not found in config`);
  }

  const updateSkills = deps.updateSkills ?? updateAgentSkills;
  let removed = false;
  let persisted = false;
  let persistError: string | null = null;
  let reason: string | undefined;

  try {
    const result = await updateSkills({
      existingConfigPath: deps.configPath,
      agentName,
      skillName,
      op: "remove",
    });
    switch (result.outcome) {
      case "updated":
        removed = true;
        persisted = true;
        break;
      case "no-op":
        removed = false;
        persisted = true;
        reason = result.reason;
        break;
      case "not-found":
      case "file-not-found":
        removed = false;
        persisted = false;
        persistError = result.reason;
        break;
    }
  } catch (err) {
    // Non-rollback: even though persistence failed, the operator intent
    // was to remove — surface removed:true so the UI reports the
    // requested change and persisted:false so the operator sees the
    // reconciliation hint.
    removed = true;
    persisted = false;
    persistError = err instanceof Error ? err.message : String(err);
  }

  // Mirror in-memory config so subsequent IPC calls (e.g. marketplace-list)
  // reflect the removal, regardless of persistence outcome.
  if (removed) {
    const existing = deps.configs[idx]!;
    const nextSkills = existing.skills.filter((s) => s !== skillName);
    deps.configs[idx] = Object.freeze({ ...existing, skills: nextSkills });
  }

  return Object.freeze({
    agent: agentName,
    skill: skillName,
    removed,
    persisted,
    persist_error: persistError,
    ...(reason !== undefined ? { reason } : {}),
  });
}

// ---------------------------------------------------------------------------
// Phase 90 Plan 05 HUB-02 / HUB-04 — Plugin marketplace IPC handlers.
//
// Parallel to handleMarketplaceList/Install/RemoveIpc but routes through
// the ClawHub plugins endpoint (not skills) and writes to
// `agents[*].mcpServers` via installClawhubPlugin (which calls
// updateAgentMcpServers).
//
// Wired into the daemon IPC closure BEFORE routeMethod (same closure
// pattern as the skill marketplace handlers).
// ---------------------------------------------------------------------------

export type MarketplacePluginsIpcDeps = Readonly<{
  configs: ResolvedAgentConfig[];
  configPath: string;
  clawhubBaseUrl: string;
  clawhubAuthToken?: string;
  cache: ClawhubCache<ClawhubPluginsResponse>;
  log: Logger;
  // DI hooks for hermetic tests — default to real impls when omitted.
  fetchPlugins?: typeof fetchClawhubPlugins;
  downloadManifest?: typeof downloadClawhubPluginManifest;
  installPlugin?: typeof installClawhubPlugin;
}>;

export type MarketplaceListPluginsIpcResult = Readonly<{
  agent: string;
  installed: readonly string[];
  available: readonly ClawhubPluginListItem[];
}>;

/**
 * `marketplace-list-plugins` — returns the installed-mcpServer-names list
 * AND the available catalog (catalog minus already-installed) for the
 * given agent.
 *
 * Plan 05 Task 2's /clawcode-plugins-browse handler consumes `available`
 * directly into a StringSelectMenuBuilder. Rate-limited responses fail
 * open (empty `available`) so the UI can render "no plugins" instead of
 * an error state — the operator retries later.
 */
export async function handleMarketplaceListPluginsIpc(
  deps: MarketplacePluginsIpcDeps & { params: Record<string, unknown> },
): Promise<MarketplaceListPluginsIpcResult> {
  const agentName = validateStringParam(deps.params, "agent");
  const cfg = deps.configs.find((c) => c.name === agentName);
  if (!cfg) {
    throw new ManagerError(`Agent '${agentName}' not found in config`);
  }

  const cacheKey = {
    endpoint: "plugins",
    query: "",
    cursor: "",
  } as const;
  const fetchFn = deps.fetchPlugins ?? fetchClawhubPlugins;

  let response: ClawhubPluginsResponse;
  const hit = deps.cache.get(cacheKey);
  if (hit.kind === "hit") {
    response = hit.value;
  } else if (hit.kind === "rate-limited") {
    // Cache says still rate-limited — fail open with empty result so the
    // UI can surface "no plugins available right now".
    return Object.freeze({
      agent: agentName,
      installed: Object.freeze([]),
      available: Object.freeze([]),
    });
  } else {
    try {
      response = await fetchFn({
        baseUrl: deps.clawhubBaseUrl,
        ...(deps.clawhubAuthToken !== undefined
          ? { authToken: deps.clawhubAuthToken }
          : {}),
      });
      deps.cache.set(cacheKey, response);
    } catch (err) {
      // Rate-limit → cache negative entry + fail open
      if (
        err !== null &&
        typeof err === "object" &&
        "retryAfterMs" in err &&
        typeof (err as { retryAfterMs?: unknown }).retryAfterMs === "number"
      ) {
        deps.cache.setNegative(
          cacheKey,
          (err as { retryAfterMs: number }).retryAfterMs,
        );
        return Object.freeze({
          agent: agentName,
          installed: Object.freeze([]),
          available: Object.freeze([]),
        });
      }
      throw err;
    }
  }

  // Extract installed mcpServer names from the agent's resolved config.
  // The config shape is a union of string-refs (→ top-level map) and
  // inline objects; we normalize to names only (what the installer needs).
  const mcpList = (cfg as ResolvedAgentConfig & {
    mcpServers?: readonly (
      | string
      | Readonly<{ name: string; command?: string; args?: readonly string[]; env?: Readonly<Record<string, string>> }>
    )[];
  }).mcpServers ?? [];
  const installed: string[] = [];
  for (const m of mcpList) {
    if (typeof m === "string") installed.push(m);
    else if (typeof m === "object" && m !== null && typeof m.name === "string") {
      installed.push(m.name);
    }
  }

  const installedSet = new Set(installed);
  const available = Object.freeze(
    response.items.filter((p) => !installedSet.has(p.name)),
  );

  return Object.freeze({
    agent: agentName,
    installed: Object.freeze(installed),
    available,
  });
}

/**
 * `marketplace-install-plugin` — install ONE plugin on the given agent.
 *
 * Flow: list catalog → find matching item → download manifest →
 * installClawhubPlugin (with operator-supplied configInputs) → return
 * the typed PluginInstallOutcome.
 *
 * Error passthrough: ClawhubRateLimitedError / AuthRequiredError /
 * ManifestInvalidError are caught + mapped to outcome variants via
 * mapFetchErrorToOutcome. Any other exception bubbles up.
 *
 * NOTE: Plugin hot-reload is deferred per Phase 90 CONTEXT D-5 — the
 * installer writes the YAML but the agent's MCP subprocess doesn't
 * hot-add the new server. Operator must restart the agent manually.
 */
export async function handleMarketplaceInstallPluginIpc(
  deps: MarketplacePluginsIpcDeps & { params: Record<string, unknown> },
): Promise<PluginInstallOutcome> {
  const agentName = validateStringParam(deps.params, "agent");
  const pluginName = validateStringParam(deps.params, "plugin");
  const rawInputs = deps.params.configInputs;
  const configInputs: Record<string, string> = {};
  if (rawInputs !== null && typeof rawInputs === "object") {
    for (const [k, v] of Object.entries(rawInputs as Record<string, unknown>)) {
      if (typeof v === "string") configInputs[k] = v;
    }
  }

  const cfg = deps.configs.find((c) => c.name === agentName);
  if (!cfg) {
    throw new ManagerError(`Agent '${agentName}' not found in config`);
  }

  const fetchFn = deps.fetchPlugins ?? fetchClawhubPlugins;
  const dlFn = deps.downloadManifest ?? downloadClawhubPluginManifest;
  const install = deps.installPlugin ?? installClawhubPlugin;

  try {
    // List call to resolve manifestUrl for the chosen plugin name.
    const listResp = await fetchFn({
      baseUrl: deps.clawhubBaseUrl,
      ...(deps.clawhubAuthToken !== undefined
        ? { authToken: deps.clawhubAuthToken }
        : {}),
    });
    const item = listResp.items.find((p) => p.name === pluginName);
    if (!item) {
      return Object.freeze({
        kind: "not-in-catalog" as const,
        plugin: pluginName,
      });
    }
    // manifestUrl is optional on the list response — fall back to a
    // canonical URL derived from the plugin name. If neither resolves to
    // a real manifest, downloadClawhubPluginManifest surfaces a
    // manifest-invalid error.
    const manifestUrl =
      item.manifestUrl ??
      `${deps.clawhubBaseUrl.replace(/\/+$/, "")}/api/v1/plugins/${encodeURIComponent(item.name)}/manifest`;

    const manifest = await dlFn({
      manifestUrl,
      ...(deps.clawhubAuthToken !== undefined
        ? { authToken: deps.clawhubAuthToken }
        : {}),
    });

    return await install({
      manifest,
      agentName,
      configPath: deps.configPath,
      configInputs,
    });
  } catch (err) {
    return mapFetchErrorToOutcome(err, pluginName);
  }
}

// ---------------------------------------------------------------------------
// Phase 90 Plan 06 HUB-05 / HUB-07 — install-time config UX IPC handlers.
//
// Three pure-function handlers exported here so the slash-command inline
// handler (slash-commands.ts) can trigger them via sendIpcRequest:
//   - clawhub-oauth-start:       kick off GitHub device-code flow
//   - clawhub-oauth-poll:        long-lived RPC (up to 15min) that polls the
//                                 token endpoint and writes the received token
//                                 to 1Password on success
//   - marketplace-probe-op-items: single-field 1P rewrite probe; used by
//                                 the caller to decide whether to show the
//                                 "Use op://..." confirmation button row
//
// All three are closed-over in the IPC handler closure below and route
// BEFORE routeMethod so the existing routeMethod signature stays stable.
// ---------------------------------------------------------------------------

/**
 * IPC handler for `clawhub-oauth-start`.
 *
 * Initiates the GitHub device-code flow and returns the payload the Discord
 * UI needs to render the "visit {URL} and enter {code}" embed. The device_code
 * + poll_interval_s + expires_at are passed back to `clawhub-oauth-poll` to
 * complete the flow.
 */
export async function handleClawhubOauthStartIpc(
  deps: { log: Logger },
  _params: Record<string, unknown>,
): Promise<
  Readonly<{
    user_code: string;
    verification_uri: string;
    device_code: string;
    poll_interval_s: number;
    expires_at: number;
  }>
> {
  const init = await githubOauthMod.initiateDeviceCodeFlow();
  return Object.freeze({
    user_code: init.user_code,
    verification_uri: init.verification_uri,
    device_code: init.device_code,
    poll_interval_s: init.interval,
    expires_at: init.expires_at,
  });
}

/**
 * IPC handler for `clawhub-oauth-poll`. Long-lived RPC — may block for up
 * to 15 minutes (device-code expiry). The caller (slash-commands.ts)
 * extends the IPC request timeout for this method specifically.
 *
 * Success → stores token at op://example-vault-21/ClawHub Token/credential via
 * `op item create` and returns {stored:true, message}. Any error (expired,
 * access_denied, network) → returns {stored:false, message:<description>}
 * so the Discord UI can show a friendly message.
 */
export async function handleClawhubOauthPollIpc(
  deps: { log: Logger },
  params: Record<string, unknown>,
): Promise<Readonly<{ stored: boolean; message: string }>> {
  const deviceCode = validateStringParam(params, "device_code");
  const pollIntervalS =
    typeof params.poll_interval_s === "number"
      ? params.poll_interval_s
      : 5;
  const expiresAt =
    typeof params.expires_at === "number"
      ? params.expires_at
      : Date.now() + 900_000;

  try {
    const token = await githubOauthMod.pollForAccessToken({
      user_code: "",
      verification_uri: "",
      device_code: deviceCode,
      interval: pollIntervalS,
      expires_at: expiresAt,
    });
    await githubOauthMod.storeTokenTo1Password(token, "ClawHub Token");
    return Object.freeze({
      stored: true,
      message:
        "Token stored at op://example-vault-21/ClawHub Token/credential — restart the daemon to pick up authenticated ClawHub fetches.",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.log.warn({ err: msg }, "clawhub OAuth poll failed");
    return Object.freeze({
      stored: false,
      message: msg,
    });
  }
}

/**
 * IPC handler for `marketplace-probe-op-items`.
 *
 * Returns {proposal} where proposal is an op:// URI + confidence + item
 * title if a fuzzy match exists against the operator's 1Password vault,
 * else null. Called once per sensitive field before the Discord UI decides
 * whether to show the "Use op://..." confirmation button row.
 *
 * Graceful degradation: if `op item list` fails (binary missing, not
 * signed in), listOpItems returns [] → proposal is null → UI skips the
 * confirmation step and falls through to literal paste (still gated by
 * Plan 05's secret-scan on install).
 */
export async function handleMarketplaceProbeOpItemsIpc(
  deps: { log: Logger },
  params: Record<string, unknown>,
): Promise<Readonly<{ proposal: OpRewriteProposal | null }>> {
  const fieldName = validateStringParam(params, "fieldName");
  const fieldLabel = validateStringParam(params, "fieldLabel");
  const items = await opRewriteMod.listOpItems({ log: deps.log });
  const proposal = opRewriteMod.proposeOpUri(fieldName, fieldLabel, items);
  return Object.freeze({ proposal });
}

/**
 * Base directory for manager runtime files.
 *
 * Phase 110 Stage 0b — `CLAWCODE_MANAGER_DIR` env override allows a
 * parallel dev daemon (running as the same user, separate config) to
 * bind sockets, write registry, and snapshot to a fully isolated path
 * without colliding with another daemon's manager files. Same defense-
 * in-depth pattern as `CLAWCODE_MANAGER_SOCK` (Go shim side) and
 * `CLAWCODE_STATIC_SHIM_PATH` (loader side). Default is canonical.
 */
/**
 * Arguments to `forkAdvisorConsult` — Phase 117-03 extraction shape.
 *
 * - `agent`         : parent agent name to fork from.
 * - `question`      : single-turn message dispatched to the fork.
 * - `systemPrompt`  : fully-assembled system-prompt override (the caller
 *                     is responsible for memory-context retrieval +
 *                     `buildAdvisorSystemPrompt` assembly so this function
 *                     remains a signature-pure fork-and-dispatch primitive).
 * - `advisorModel`  : SDK model alias (today: literal `"opus"` matching
 *                     the legacy `modelOverride` at the old :9844 site;
 *                     Plan 117-06 wires per-agent resolution).
 */
export interface ForkAdvisorArgs {
  readonly agent: string;
  readonly question: string;
  readonly systemPrompt: string;
  readonly advisorModel: string;
}

/**
 * Fork-based advisor consultation primitive — extracted verbatim from the
 * inline body that used to live at `daemon.ts:9843–9854` (Phase 117-03).
 *
 * Behavior contract (DO NOT CHANGE — parity test in
 * `src/advisor/backends/__tests__/legacy-fork.test.ts` enforces it):
 *   1. Fork the parent agent under `advisorModel` (literal `"opus"` today)
 *      with the caller-supplied `systemPromptOverride`.
 *   2. Dispatch ONE turn carrying `question` to the fork.
 *   3. In `finally`, ALWAYS call `stopAgent(forkName)` — even when
 *      `dispatchTurn` throws. This invariant is the most important
 *      behavioral guarantee preserved by the extraction.
 *   4. Return `{ answer }` (untruncated; the caller — today the IPC
 *      handler, Plan 117-07 the `AdvisorService` — owns the
 *      `ADVISOR_RESPONSE_MAX_LENGTH` truncation).
 *
 * This function does NOT:
 *   - retrieve memory context (caller builds the system prompt),
 *   - enforce the daily budget (`AdvisorBudget.canCall` / `recordCall`),
 *   - truncate the answer.
 * Those concerns belong to the IPC handler (today) and `AdvisorService`
 * (Plan 117-07).
 *
 * Wrapped as `LegacyForkAdvisor` in `src/advisor/backends/legacy-fork.ts`
 * to plug into the provider-neutral `AdvisorService` registry while
 * preserving today's behavior as the operator rollback path
 * (CONTEXT.md `<scope>`).
 */
export async function forkAdvisorConsult(
  manager: SessionManager,
  args: ForkAdvisorArgs,
): Promise<{ answer: string }> {
  // `modelOverride` is typed `"sonnet" | "opus" | "haiku"` on `ForkOptions`
  // (see `src/manager/fork.ts:9`). Plan 117-03 keeps the legacy call shape
  // (`"opus"`); Plan 117-06 introduces a real alias resolver in front of
  // this primitive so the cast can be replaced with the resolved literal.
  const fork = await manager.forkSession(args.agent, {
    modelOverride: args.advisorModel as "sonnet" | "opus" | "haiku",
    systemPromptOverride: args.systemPrompt,
  });

  let answer: string;
  try {
    answer = await manager.dispatchTurn(fork.forkName, args.question);
  } finally {
    // Always clean up the fork — this try/finally is the parity invariant.
    await manager.stopAgent(fork.forkName).catch(() => {});
  }

  return { answer };
}

/**
 * Phase 999.75 Part A (A4) — load tool-aware compaction turns rendered to the
 * `[role]: content` text the extractor seam consumes.
 *
 * Resolves the agent's live SDK session UUID + project directory, reads the
 * real SDK JSONL transcript via `readToolAwareTurns`, and renders it through
 * `toolAwareTurnsToText`. The result feeds the tiered *extractor* — tool
 * markers (`tool_use:` / `tool_result:`) reach `tier3-payload-truncator` and
 * `tier4-drop`, which never fired on the final-text-only `ConversationStore`
 * turns.
 *
 * **Fail-open.** Returns `null` on ANY shortfall — no active session, no
 * project dir, the reader fails, or the transcript yields no usable turns.
 * Both compaction call sites treat `null` as "use the existing
 * `ConversationStore` extractor input", so compaction degrades to today's
 * behaviour with no data loss.
 *
 * Exported so `__tests__` can mock `getSessionMessages` (e.g. throwing) and
 * assert the fail-open path. Both daemon call sites call this helper with a
 * BYTE-IDENTICAL argument shape (anti-bifurcation — CONTEXT D-06).
 */
export async function loadCompactionTurns(deps: {
  readonly agentName: string;
  readonly manager: Pick<SessionManager, "getSdkSessionId">;
  readonly sdk: {
    getSessionMessages: (
      sessionId: string,
      options?: { readonly dir?: string },
    ) => Promise<readonly import("./sdk-types.js").SessionMessage[]>;
  };
  /**
   * The agent's resolved config — only `gsd?.projectDir` + `workspace` are
   * read (the SDK cwd derivation, mirroring session-adapter.ts:1283).
   * Undefined when the agent is not in the resolved set → fail open.
   */
  readonly config:
    | { readonly gsd?: { readonly projectDir: string }; readonly workspace: string }
    | undefined;
  readonly log: Logger;
}): Promise<string | null> {
  const sessionId = deps.manager.getSdkSessionId(deps.agentName);
  if (!sessionId || !deps.config) return null;
  const dir = deps.config.gsd?.projectDir ?? deps.config.workspace;
  const { readToolAwareTurns, toolAwareTurnsToText } = await import(
    "../memory/sdk-transcript-reader.js"
  );
  const turns = await readToolAwareTurns({
    sessionId,
    dir,
    getSessionMessages: (id, opts) => deps.sdk.getSessionMessages(id, opts),
    agentName: deps.agentName,
    log: deps.log,
  });
  if (turns === null) return null;
  return toolAwareTurnsToText(turns);
}

/**
 * Phase 117-07 T02 — `ask-advisor` IPC handler dispatch body.
 *
 * Replaces the previous inline ~60-line block at the `case "ask-advisor"`
 * switch arm. Owns ZERO business logic beyond:
 *   1. Resolving the backend at the IPC boundary via the loader resolver
 *      (per-agent → defaults → "native").
 *   2. Short-circuiting native-backend agents with the RESEARCH §13.11
 *      explanatory response (MCP tool is also gated off for them in
 *      `src/mcp/server.ts:925`, Plan 117-07 T03; this IPC path remains
 *      callable as stale-state defense).
 *   3. Dispatching fork-backend agents through `AdvisorService.ask`,
 *      which owns budget gating + backend dispatch + truncation +
 *      `recordCall` ordering (Plan 117-02 T06 — single source of truth
 *      for `ADVISOR_RESPONSE_MAX_LENGTH`).
 *
 * Exported so `__tests__/daemon-ask-advisor-dispatch.test.ts` can mock
 * `AdvisorService.ask` and exercise both branches without instantiating
 * the full daemon. The IPC envelope (response field names `answer`,
 * `budget_remaining`, plus the new `backend` discriminator) is operator-
 * visible contract — see the test suite for the parity assertions.
 */
export interface AskAdvisorDeps {
  readonly manager: SessionManager;
  readonly advisorService: AdvisorService;
  readonly advisorBudget: AdvisorBudget;
  readonly advisorDefaults:
    | { readonly advisor?: { readonly backend?: string } }
    | undefined;
}

export async function handleAskAdvisor(
  deps: AskAdvisorDeps,
  params: { agent: string; question: string },
): Promise<{
  readonly answer: string;
  readonly budget_remaining: number;
  readonly backend: BackendId;
}> {
  const { manager, advisorService, advisorBudget, advisorDefaults } = deps;
  const { agent, question } = params;

  // RESEARCH §13.11 — native short-circuit. The MCP tool is unregistered
  // for native-backend agents (Plan 117-07 T03 gates `server.tool` in
  // `src/mcp/server.ts:925`); this IPC path remains callable for the
  // fork backend, plus stale-state defense for any native call that
  // slips through (e.g. a `clawcode mcp` client warm from before the
  // backend flipped). The response makes the misuse readable to the
  // caller so any agent that invokes the tool by mistake gets a clear
  // pointer rather than an opaque failure.
  //
  // Cast `cfg` mirrors session-config.ts:1187 — see daemon-boot
  // composition comment above. `ResolvedAgentConfig` doesn't expose
  // `advisor?` on its type yet (Plan 117-06 schema-only).
  const cfg = manager.getAgentConfig(agent) as unknown as
    | { advisor?: { backend?: string } }
    | undefined;
  const backendId = resolveAdvisorBackend(cfg, advisorDefaults);

  // 2026-08-02 — fork-caller quarantine. Forks ARE the advisor mechanism
  // (LegacyForkAdvisor answers a consult by forking the parent session);
  // a fork consulting its own advisor therefore forked the fork — the
  // nested session crashed on the LlmRuntime resolver gap ("No LlmRuntime
  // resolver registered", 3× the week of 2026-07-27: state-contract ×1,
  // client-a-personal ×2) and burned minutes inside user-visible turns.
  // Refusing at this single IPC chokepoint means no config cascade
  // (per-agent OR defaults) can re-enable the recursion. Subagent
  // threads / workflow workers / pool workers are NOT forks and keep
  // full advisor access. No budget is charged.
  if (spawnKindOf(agent) === "fork") {
    return {
      answer:
        "Advisor consultation is unavailable inside forked sessions — " +
        "forks are the advisor mechanism itself, so consulting would " +
        "recurse. Proceed with your own judgment.",
      budget_remaining: advisorBudget.getRemaining(agent),
      backend: backendId,
    };
  }

  if (backendId === "native") {
    return {
      answer:
        "Advisor runs in-session for native-backend agents — your agent " +
        "will consult automatically on its next hard decision. To force " +
        "a synchronous fork-based call, set agent.advisor.backend: fork.",
      budget_remaining: advisorBudget.getRemaining(agent),
      backend: "native" as const,
    };
  }

  // Fork-backend dispatch. `AdvisorService.ask` owns:
  //   - budget gate (canCall) — short-circuits with a budget-exhausted
  //     answer if 0 remaining today;
  //   - backend dispatch (LegacyForkAdvisor.consult → forkAdvisorConsult);
  //   - response truncation to `ADVISOR_RESPONSE_MAX_LENGTH`;
  //   - recordCall on success ONLY (failed turns don't charge budget).
  // The IPC envelope re-maps `budgetRemaining` (camelCase service shape)
  // to `budget_remaining` (operator-visible IPC contract).
  const result = await advisorService.ask({ agent, question });
  return {
    answer: result.answer,
    budget_remaining: result.budgetRemaining,
    backend: result.backend,
  };
}

export const MANAGER_DIR =
  process.env.CLAWCODE_MANAGER_DIR ?? join(homedir(), ".clawcode", "manager");

/**
 * Path to the Unix domain socket.
 */
export const SOCKET_PATH = join(MANAGER_DIR, "clawcode.sock");

/**
 * Phase 145 WS3 (Plan 04) — daemon-owned bounded timeout for the
 * `ask-user-question` round-trip. sendIpcRequest has no client timeout, so the
 * handler's Promise.race against this bound is what unblocks the worker when
 * the operator never answers. `_DEFAULT_` applies when the tool passes no
 * `timeoutMs`; `_MAX_` caps any caller-supplied value.
 */
export const ASK_USER_QUESTION_DEFAULT_TIMEOUT_MS = 10 * 60_000; // 10 minutes
export const ASK_USER_QUESTION_MAX_TIMEOUT_MS = 30 * 60_000; // 30 minutes

/**
 * Path to the PID file.
 */
export const PID_PATH = join(MANAGER_DIR, "clawcode.pid");

/**
 * Path to the registry file.
 */
export const REGISTRY_PATH = join(MANAGER_DIR, "registry.json");

/**
 * Phase 999.6 SNAP-01..02 — Path to the pre-deploy running-fleet snapshot.
 * Written at shutdown (before drain), read+deleted at boot (before the
 * autoStartAgents filter). See `src/manager/snapshot-manager.ts` for the
 * write/read contract and invariants.
 */
export const PRE_DEPLOY_SNAPSHOT_PATH = join(MANAGER_DIR, "pre-deploy-snapshot.json");
// Phase 108 — daemon-side socket the per-agent `clawcode mcp-broker-shim`
// subprocesses connect to. Owner-only permissions (chmod 0700 dir).
export const MCP_BROKER_SOCKET_PATH = join(MANAGER_DIR, "mcp-broker.sock");


/**
 * Ensure no stale socket file exists.
 * If another daemon is running (socket accepts connections), throws ManagerError.
 * If socket file exists but no daemon is running (stale), deletes it.
 *
 * Per RESEARCH Pitfall 2: stale socket cleanup.
 *
 * @param socketPath - Path to the Unix domain socket
 */
export async function ensureCleanSocket(socketPath: string): Promise<void> {
  // Check if file exists
  try {
    await access(socketPath);
  } catch {
    // File doesn't exist, nothing to clean
    return;
  }

  // Check if it's a real socket with an active listener
  const isActive = await checkSocketActive(socketPath);

  if (isActive) {
    throw new ManagerError("Another manager is already running");
  }

  // Stale socket file -- remove it
  await unlink(socketPath);
}

/**
 * Check if a socket file has an active listener by trying to connect.
 */
function checkSocketActive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);

    socket.on("connect", () => {
      // Another daemon is running
      socket.destroy();
      resolve(true);
    });

    socket.on("error", () => {
      // Connection failed -- stale socket
      resolve(false);
    });
  });
}

/**
 * Start the daemon process.
 * Loads config, creates SessionManager, reconciles registry, starts IPC server.
 *
 * @param configPath - Path to the clawcode.yaml config file
 * @param adapter - Optional SessionAdapter (defaults to SdkSessionAdapter)
 * @returns Cleanup function for tests
 */
let globalCrashHandlersInstalled = false;

/**
 * C3 — initialise the per-process identity secret (mint + verify per-agent
 * capability tokens for the memory/document/conversation IPC handlers). The
 * secret lives in `agent-identity-token.ts` as a process singleton so the v3
 * spawn path can mint tokens without a circular import. Re-exported under the
 * daemon's historical name for the dispatch-path gate test.
 */
export function initAgentIdentitySecret(): string {
  return initProcessIdentitySecret();
}

/**
 * C3 enforcement chokepoint. Call at the TOP of every memory/document/
 * conversation IPC handler, passing the caller-supplied target agent name.
 * Throws `ManagerError` on a token-mismatch (cross-agent impersonation);
 * fail-open (returns) when no token is present (trusted CLI/dashboard path) or
 * the secret is not yet initialised. Single choke point so a new handler that
 * forgets to call it is the only way to leave a hole — not per-case logic drift.
 */
function enforceAgentIdentity(
  params: Record<string, unknown>,
  requestedAgent: string,
): void {
  const secret = getProcessIdentitySecret();
  if (secret === null) return; // pre-boot / not initialised — fail-open
  const decision = decideAgentIdentity({
    secret,
    requestedAgent,
    token: params[AGENT_TOKEN_PARAM],
    callerAgent: params[CALLER_AGENT_PARAM],
  });
  if (!decision.ok) {
    throw new ManagerError(decision.reason);
  }
}

/**
 * INC-2026-06-04 — install process-level crash handlers once per process.
 *
 * The daemon had NO `unhandledRejection` / `uncaughtException` handlers, so an
 * async rejection from a post-boot background task would terminate the process
 * with exit code 1 and no structured log — undiagnosable from journald. These
 * preserve Node's default crash-on-unhandled behaviour while logging the full
 * reason + stack (pino fatal) FIRST. Idempotent so repeated startDaemon()
 * calls (tests) don't stack listeners.
 */
function installGlobalCrashHandlers(log: {
  fatal: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}): void {
  if (globalCrashHandlersInstalled) return;
  globalCrashHandlersInstalled = true;
  // unhandledRejection stays STRICT — a rejected promise comes from an awaited
  // path with its own handling, so an unhandled one is a genuine bug. (Only
  // uncaughtException gets the EPIPE leniency below; see crash-policy.ts.)
  process.on("unhandledRejection", (reason: unknown) => {
    log.fatal(
      {
        reason: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
      },
      "unhandledRejection — daemon exiting (previously a silent exit-1)",
    );
    process.exit(1);
  });
  process.on("uncaughtException", (err: Error) => {
    // 2026-06-19 prod-down defense-in-depth: a managed child's async EPIPE
    // (write to a dead claude stdin) must never exit the whole fleet. EPIPE is
    // "the peer went away," not corrupted daemon state. The spawn-seam guard
    // (detached-spawn.ts) catches this for the v2/SDK path; this is the net for
    // the other claude-spawning paths that don't route through that seam. All
    // other uncaught errors stay fatal (INC-2026-06-04 backstop preserved).
    if (isNonFatalPipeError(err)) {
      log.warn(
        { error: err.message, code: (err as NodeJS.ErrnoException).code },
        "uncaughtException EPIPE (non-fatal — peer went away; daemon continuing)",
      );
      return;
    }
    log.fatal(
      { error: err.message, stack: err.stack },
      "uncaughtException — daemon exiting (previously a silent exit-1)",
    );
    process.exit(1);
  });
}

/** Phase 999.176 — wait for agent auto-start before probing a swapped account. */
const ACCOUNT_SWAP_REPORT_DELAY_MS = 90_000;

export async function startDaemon(
  configPath: string,
  adapter?: SessionAdapter,
): Promise<{ server: Server; manager: SessionManager; taskStore: TaskStore; taskManager: TaskManager; payloadStore: PayloadStore; triggerEngine: TriggerEngine; routingTable: RoutingTable; rateLimiter: RateLimiter; heartbeatRunner: HeartbeatRunner; taskScheduler: TaskScheduler; skillsCatalog: SkillsCatalog; slashHandler: SlashCommandHandler; threadManager: ThreadManager; webhookManager: WebhookManager; discordBridge: DiscordBridge | null; subagentThreadSpawner: SubagentThreadSpawner | null; configWatcher: ConfigWatcher; configReloader: ConfigReloader; policyWatcher: PolicyWatcher; routingTableRef: { current: RoutingTable }; secretsResolver: SecretsResolver; dashboard: { readonly server: import("node:http").Server; readonly sseManager: import("../dashboard/sse.js").SseManager; readonly close: () => Promise<void> }; shutdown: () => Promise<void> }> {
  const log = logger.child({ component: "daemon" });

  // INC-2026-06-04 observability hardening — install crash handlers before any
  // background task can fire an unhandled rejection (see helper above).
  installGlobalCrashHandlers(log);

  // 1. Ensure manager directory exists
  await mkdir(MANAGER_DIR, { recursive: true });

  // C3 — mint the per-process identity secret before any agent is spawned so
  // the spawn path can inject per-agent capability tokens (HMAC(secret, name))
  // and the IPC enforcement chokepoint can verify them.
  initAgentIdentitySecret();

  // 2. Clean stale socket
  await ensureCleanSocket(SOCKET_PATH);

  // 3. Write PID file
  await writeFile(PID_PATH, String(process.pid), "utf-8");

  // 3a. Phase 999.176 — apply a pending fleet account swap FIRST, before the
  // warm pool or any `claude` process exists to hold or refresh
  // the old credential (src/account/pending-swap.ts). Never throws; a failed
  // swap leaves the live credential untouched and is reported post-boot.
  const accountSwapPaths = accountSwapPathsFor(MANAGER_DIR);
  const claudeConfigDir =
    process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  await applyPendingSwapAtBoot(accountSwapPaths, claudeConfigDir, log);
  await cleanupWorkRoot(accountSwapPaths.workRoot);

  // 4. Load config
  // Phase 999.X — `let` (not `const`) so the configWatcher's onChange
  // handler can reassign on yaml edit. Long-lived closures (orphan-claude
  // reaper, subagent-session reaper, both inside onTickAfter) read
  // `config.defaults.<dial>` lazily on each tick — `let` mutability +
  // closure-by-reference means yaml hot-reload of those dials takes
  // effect on the next 60s tick without a daemon restart. Pre-fix this
  // was `const` and the closures captured a boot-time snapshot,
  // silently ignoring yaml edits.
  let config = await loadConfig(configPath);

  // 4a. Fleet Claude Code binary — resolved + probed ONCE; the CLI-floor and
  // lockstep guards below reuse this same probe. Loud at every boot so a
  // missing or drifted binary is visible immediately (999.169; the 2026-06-01
  // regression ran on the wrong binary for days).
  const resolvedBinary = logResolvedClaudeBinary(log);

  // Phase 999.159 — CLI-floor gate. Anthropic enforces a per-model minimum CLI
  // version against the version the client claims, so shipping a model pin that
  // needs a newer binary than the fleet runs 400s EVERY TURN with no local
  // signal. It happened twice (09-01 Fable 5.1, 09-22 Opus 5.5) because the
  // requirement lived only in a code comment. Now it is `minCliVersion` data in
  // MODEL_ALIAS_CATALOG, checked here BEFORE any turn can reach the wire.
  //
  // Reuses the single `--version` probe above. An unprobeable binary warns and
  // boots (it proves nothing, and must not be what keeps the fleet down); a
  // model that is merely SELECTABLE warns; only a model an agent will actually
  // RUN is fatal.
  const cliVerdict = checkCliVersion(
    resolvedBinary.version,
    collectCliVersionRequirements(config),
  );
  if (cliVerdict.installed === null && cliVerdict.highestRequired !== null) {
    log.warn(
      {
        component: "cli-version-guard",
        highestRequired: cliVerdict.highestRequired,
        pin: resolvedBinary.pin,
      },
      "CLI-version guard: could not probe the pinned binary's version — " +
        `compatibility with the configured models (need >= ${cliVerdict.highestRequired}) ` +
        "is UNVERIFIED. Booting anyway; run `clawcode check-cli-version` to check.",
    );
  }
  for (const unmet of cliVerdict.selectableUnmet) {
    log.warn(
      {
        component: "cli-version-guard",
        model: unmet.model,
        source: unmet.source,
        minCliVersion: unmet.minCliVersion,
        installed: cliVerdict.installed,
      },
      `CLI-version guard: selectable model ${unmet.model} needs CLI >= ` +
        `${unmet.minCliVersion} but the binary is ${cliVerdict.installed} — ` +
        "selecting it (e.g. via /clawcode-model) would 400 every turn.",
    );
  }
  if (cliVerdict.blocking.length > 0) {
    const detail = formatCliVersionFailure(cliVerdict);
    if (process.env.CLAWCODE_SKIP_CLI_VERSION_GUARD === "1") {
      // Emergency valve, deliberately loud and deliberately not a config knob:
      // if this guard is ever WRONG it must not be the thing that keeps the
      // fleet down until a deploy can land. Setting it accepts per-turn 400s.
      log.error(
        { component: "cli-version-guard", override: true, blocking: cliVerdict.blocking },
        `CLI-version guard OVERRIDDEN by CLAWCODE_SKIP_CLI_VERSION_GUARD=1 — ${detail}`,
      );
    } else {
      log.fatal(
        {
          component: "cli-version-guard",
          installed: cliVerdict.installed,
          highestRequired: cliVerdict.highestRequired,
          blocking: cliVerdict.blocking,
          pin: resolvedBinary.pin,
        },
        detail,
      );
      process.exit(1);
    }
  }

  // Phase 999.169 — CLI + SDK lockstep. The binary every agent spawns must be the
  // exact CLI the installed Agent SDK was built against (its claudeCodeVersion).
  // No binary, or a drifted one, is fatal (same emergency valve as the floor
  // guard); the CLAWCODE_CLAUDE_BIN override is the deliberate rollback path and
  // only warns.
  const lockstep = checkClaudeBinaryLockstep(resolvedBinary);
  if (isLockstepFatal(lockstep)) {
    const detail = formatLockstepFailure(lockstep);
    if (process.env.CLAWCODE_SKIP_CLI_VERSION_GUARD === "1") {
      log.error({ component: "cli-lockstep-guard", override: true, lockstep }, `CLI/SDK lockstep guard OVERRIDDEN — ${detail}`);
    } else {
      log.fatal({ component: "cli-lockstep-guard", lockstep }, detail);
      process.exit(1);
    }
  } else if (lockstep.kind === "ok") {
    log.info({ component: "cli-lockstep-guard", lockstep }, formatLockstepFailure(lockstep));
  } else {
    log.warn({ component: "cli-lockstep-guard", lockstep }, formatLockstepFailure(lockstep));
  }

  // 999.169 — binary integrity: compare the installed bundled binary with the
  // sha256 the build recorded (dist/claude-binary.json beside this bundle).
  // Loud, not fatal: a swapped binary must be visible, but a stale or missing
  // manifest must never be what keeps the fleet down.
  const bootIntegrity = checkBinaryIntegrity(
    resolvedBinary,
    readBinaryManifest(fileURLToPath(new URL(`../${BINARY_MANIFEST_FILE}`, import.meta.url))),
  );
  if (bootIntegrity.kind === "mismatch") {
    log.error(
      { component: "claude-binary-integrity", integrity: bootIntegrity },
      `Claude binary integrity MISMATCH: ${bootIntegrity.path ?? "?"} sha256 ${bootIntegrity.actual} ` +
        `≠ build-recorded ${bootIntegrity.expected}. node_modules was modified after install — re-run npm ci.`,
    );
  } else {
    log.info({ component: "claude-binary-integrity", integrity: bootIntegrity }, `Claude binary integrity: ${bootIntegrity.kind}`);
  }

  // Install the haiku-direct routing policy at boot: "bridge" spawns the bundled
  // `claude` binary for one-shot Haiku calls, "direct" uses the SDK in-process.
  configureHaikuRouting(config.defaults.bridge?.haikuDirectRouting ?? "bridge");
  log.info(
    {
      tag: "phase999.58-haiku-direct",
      routing: config.defaults.bridge?.haikuDirectRouting ?? "bridge",
    },
    "bridge haikuDirectRouting installed at boot",
  );

  // 2026-06-22 — install the Discord table-rendering policy at boot. Governs
  // how outbound markdown tables are rendered for Discord (adaptive grid /
  // cards / legacy fence / off) via the single `formatOutboundText`
  // chokepoint. Daemon-wide; NON-RELOADABLE — restart to change. Default
  // (omitted config) is the adaptive renderer.
  configureTableRendering(config.discord?.tableRendering);
  configureSuppressLinkEmbeds(config.discord?.suppressLinkEmbeds);
  log.info(
    {
      tag: "discord-table-rendering",
      mode: config.discord?.tableRendering?.mode ?? "adaptive",
      mobileColumnBudget: config.discord?.tableRendering?.mobileColumnBudget ?? 32,
      imageEnabled: config.discord?.tableRendering?.image?.enabled ?? true,
    },
    "discord table-rendering policy installed at boot",
  );

  // 4z. 2026-05-08 hotfix — forward-declaration of `subagentThreadSpawner`
  // hoisted to top-of-function. The actual assignment lives at the original
  // SubagentThreadSpawner instantiation site (~line 5396). Pre-fix this was
  // a single `const` declaration there; route handlers + IPC closures defined
  // EARLIER in the function captured `subagentThreadSpawner` lexically and
  // dispatched on incoming requests BEFORE the const declaration line ran.
  // Result: any IPC request landing during the ~5s startup window threw
  // `Cannot access 'subagentThreadSpawner' before initialization` (TDZ) at
  // level 50 in the ipc-server component. Splitting into early `let`
  // declaration (initialized to `null`) + later assignment ends the TDZ at
  // the declaration point; route handlers see `null` during boot (which
  // they already handle gracefully via `subagentThreadSpawner ? ... : ...`)
  // and pick up the real value once the assignment lands. Bug introduced
  // by 999.36-01 wiring; production-visible 2026-05-08 14:14:29 UTC during
  // the Discord-outage restart cycle when `clawcode status` triggered an
  // early IPC request mid-boot.
  let subagentThreadSpawner: SubagentThreadSpawner | null = null;

  // 4a. Phase 104 SEC-01/SEC-04 — single SecretsResolver instance for the
  // whole daemon lifetime. Pre-resolves every op:// URI in the config in
  // parallel BEFORE the loader's sync resolver runs, so subsequent boot
  // steps (loader sync wrapper below, per-agent opEnvResolver, Discord
  // botToken) hit a warm cache and never re-shell `op read` for the same
  // URI. Mirrors the existing graceful-degradation pattern at line ~1545
  // (resolveAllAgents onMcpError) — partial failures are logged loudly but
  // do NOT block boot. Critical secrets (Discord botToken) keep their own
  // fail-closed behavior at the resolution call site.
  // INC-2026-07-27 — outage fallback wiring. The 2026-07-27 restart resolved
  // 0/17 refs against a rate-limited service account and two agents whose
  // 1password MCP token is ITSELF an op:// ref could not start. Three layers,
  // all consulted only AFTER a live read fails:
  //   1. operator env fallback  — explicit map in `defaults.secrets.envFallback`
  //      (values come from the systemd EnvironmentFile, already the blessed
  //      on-box secret store; nothing new lands on disk).
  //   2. last-known-good store  — 0600 file under the manager dir, written on
  //      every successful resolve. Strictly less exposed than the status quo
  //      (resolved secrets already ride world-readable MCP argv).
  //   3. circuit breaker        — stops feeding a throttle that our own
  //      retries were sustaining.
  const secretsCachePath = join(MANAGER_DIR, "secrets-lkg.json");
  const envFallbackMap = config.defaults.secrets?.envFallback ?? {};
  const secretsResolver = new SecretsResolver({
    opRead: defaultOpReadShellOut,
    log: log.child({ subsystem: "secrets" }),
    envFallback: (uri: string) => {
      const envName = envFallbackMap[uri];
      if (!envName) return undefined;
      const v = process.env[envName];
      return v !== undefined && v.length > 0 ? v : undefined;
    },
    breakerThreshold: config.defaults.secrets?.breakerThreshold ?? 3,
    breakerCooldownMs: config.defaults.secrets?.breakerCooldownMs ?? 300_000,
    // Staleness ceiling on layer 2. An LKG entry older than this is refused,
    // so a deleted/rotated secret eventually hard-fails (and surfaces via the
    // "secrets: pre-resolve failed" line below) instead of being replayed
    // forever. Age tracks daemon uptime since the last LIVE read of that URI,
    // NOT the credential's rotation age — see DEFAULT_LKG_MAX_AGE_MS.
    lkgMaxAgeMs: config.defaults.secrets?.lkgMaxAgeMs ?? DEFAULT_LKG_MAX_AGE_MS,
    // WS-5 (2026-08-28) — fresh-serve window. An LKG entry younger than this
    // is served at boot WITHOUT an `op read`, so a restart no longer spends
    // ~30 reads of the shared 1,000/24h 1Password cap re-reading unchanged
    // values. 0 (schema default) keeps the pre-WS-5 live-read-every-boot
    // behaviour. Rotations: `clawcode secrets refresh [uri]`.
    lkgFreshMs: config.defaults.secrets?.lkgFreshMs ?? 0,
    persistentStore: {
      load: () => {
        try {
          const raw = readFileSync(secretsCachePath, "utf8");
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          const out: Record<string, { value: string; savedAt: number }> = {};
          for (const [uri, entry] of Object.entries(parsed)) {
            const e = entry as { value?: unknown; savedAt?: unknown };
            if (typeof e?.value === "string" && typeof e?.savedAt === "number") {
              out[uri] = { value: e.value, savedAt: e.savedAt };
            }
          }
          return out;
        } catch {
          // Missing or corrupt store must never block boot.
          return {};
        }
      },
      save: (entries) => {
        // 0600 + owner-only dir. Written atomically-ish via mode on create;
        // a partial write is tolerable because load() drops unparseable data.
        mkdirSync(MANAGER_DIR, { recursive: true, mode: 0o700 });
        writeFileSync(secretsCachePath, JSON.stringify(entries), {
          encoding: "utf8",
          mode: 0o600,
        });
      },
    },
  });
  const allOpRefs = collectAllOpRefs(config);
  log.info({ count: allOpRefs.length }, "secrets: pre-resolving op:// references");
  const preResolveResults = await secretsResolver.preResolveAll(allOpRefs);
  const failedRefs = preResolveResults.filter((r) => !r.ok);
  for (const f of failedRefs) {
    // Fail-open: log loudly and continue. Affected MCPs degrade via the
    // existing onMcpResolutionError path (loader.ts) when their env value
    // hits getCached() === undefined and the sync wrapper throws.
    log.error({ uri: f.uri, reason: f.reason }, "secrets: pre-resolve failed");
  }
  log.info(
    {
      resolved: preResolveResults.length - failedRefs.length,
      failed: failedRefs.length,
    },
    "secrets: pre-resolve complete",
  );

  // 4-bis. Phase 999.14 — MCP child process lifecycle hardening. Construct
  // the per-daemon McpProcessTracker singleton AFTER secretsResolver is
  // warmed up but BEFORE manager.startAll spawns any new MCP children.
  // Run a one-shot boot orphan scan (MCP-05) BEFORE startAll so leftover
  // PPID=1 MCP procs from a prior daemon crash get killed before fresh
  // children of the same names spawn (otherwise port/connection collisions).
  //
  // Skipped entirely when no MCP servers are configured — tracker stays null
  // and downstream code paths guard with `if (mcpTracker)`. Boot-scan failure
  // is non-fatal (logged + continue) per RESEARCH.md: a crashed reaper must
  // never prevent agents from starting; the next 60s tick catches stragglers.
  const mcpServersConfig = config.mcpServers ?? {};
  const mcpLog = log.child({ subsystem: "mcp-lifecycle" });
  let mcpTracker: McpProcessTracker | null = null;
  let reaperInterval: NodeJS.Timeout | null = null;
  // FIND-123-A.next T-08 — late-bound sink-lookup closure. Assigned after
  // SessionManager construction (line ~2526) so the reconcile closures
  // declared above (TRACK-06 killAgentGroup path) and below (TRACK-01
  // per-tick path) can share a single resolver that reads
  // `manager.getSessionHandle(name)?.getClaudePid?.()`. Returns `undefined`
  // for absent sessions (drives agent-gone), `null` for present-but-sink-
  // empty (drives skip), and a number for the live PID.
  let getClaudePidByName:
    | ((agentName: string) => number | null | undefined)
    | undefined;
  // Phase 999.15 — hoisted out of the inner try so SessionManager construction
  // (line ~1816) and the onTickAfter reconcile closure (line ~4070+) can both
  // pass them to discoverClaudeSubprocessPid({ minAge, bootTimeUnix,
  // clockTicksPerSec }) without re-reading /proc/stat per call.
  let mcpBootTimeUnix: number | undefined;
  let mcpClockTicksPerSec: number | undefined;
  // FIND-123-A — hoisted so the shutdown-scan reap (post-killAll) can run a
  // synchronous orphan sweep against the same configured patterns/uid that
  // the boot-scan + periodic reaper use. Without the shutdown-side sweep,
  // `mcp-server-mysql` grandchildren reparent to PID 1 on `systemctl restart`
  // and persist for up to one reaper-tick interval (≥60s, observed 9 min).
  let mcpPatterns: RegExp | undefined;
  let mcpUid: number | undefined;
  if (Object.keys(mcpServersConfig).length > 0) {
    try {
      mcpBootTimeUnix = await readBootTimeUnix();
      mcpClockTicksPerSec = readClockTicksPerSec();
      mcpPatterns = buildMcpCommandRegexes(mcpServersConfig);
      mcpUid = process.getuid?.() ?? -1;
      // Phase 999.15 TRACK-06 — late-bound reconcileAgent closure for
      // tracker.killAgentGroup. Pattern from Phase 100 follow-up
      // triggerDeliveryFn — closure captures the LIVE `mcpTracker` ref so
      // the reconciler always sees the post-construction singleton (avoids
      // bootstrap circular dep where reconciler imports the tracker type).
      const reconcileAgentClosure = async (name: string): Promise<void> => {
        if (!mcpTracker) return;
        await reconcileAgent(name, {
          tracker: mcpTracker,
          daemonPid: process.pid,
          log: mcpLog,
          getClaudePid: getClaudePidByName,
        });
      };
      mcpTracker = new McpProcessTracker({
        uid: mcpUid,
        patterns: mcpPatterns,
        log: mcpLog,
        clockTicksPerSec: mcpClockTicksPerSec,
        bootTimeUnix: mcpBootTimeUnix,
        reconcileAgent: reconcileAgentClosure,
      });
      try {
        await reapOrphans({
          uid: mcpUid,
          patterns: mcpPatterns,
          clockTicksPerSec: mcpClockTicksPerSec,
          bootTimeUnix: mcpBootTimeUnix,
          reason: "boot-scan",
          log: mcpLog,
        });
      } catch (err) {
        // Boot-scan failure is non-fatal — daemon continues to startAll.
        // The next 60s reaper tick will catch any stragglers.
        mcpLog.error(
          { err: String(err) },
          "mcp boot-scan failed; continuing daemon boot",
        );
      }
    } catch (err) {
      // Tracker construction failed (e.g. /proc unavailable on non-Linux).
      // Leave tracker null; downstream guards skip MCP lifecycle work.
      mcpLog.warn(
        { err: String(err) },
        "mcp tracker init skipped (likely non-Linux or /proc unavailable)",
      );
      mcpTracker = null;
    }
  } else {
    mcpLog.info("no mcp servers configured; skipping lifecycle tracker");
  }

  // 4-ter. Phase 108 — OnePasswordMcpBroker + ShimServer.
  //
  // Owns ONE pooled `@takescake/1password-mcp` child per unique resolved
  // OP_SERVICE_ACCOUNT_TOKEN. Constructed AFTER SecretsResolver (so the
  // tokenHash → rawToken map is built from warmed cache values) AND AFTER
  // McpProcessTracker (so onPoolSpawn can register the pool PID under a
  // synthetic `__broker:1password:<tokenHash>` owner). The reconciler
  // (src/mcp/reconciler.ts via the per-agent skip-list added in this
  // phase) treats those entries as broker-owned and never SIGTERMs them
  // during per-agent cleanup.
  //
  // ORDERING DECISION (108-04): the planner offered tracker-before-broker
  // OR broker-before-tracker. We pick **tracker-before-broker** so the
  // broker's onPoolSpawn callback closes over the already-constructed
  // tracker singleton (no forward-reference / null-checks needed). Per
  // RESEARCH.md §5 the only hard constraint is "broker is up before
  // agents start" — both orderings satisfy that since manager.startAll
  // happens far below.
  //
  // Token literal flow (Phase 104 SEC-07): shim hashes
  // OP_SERVICE_ACCOUNT_TOKEN client-side → handshake sends only
  // {agent, tokenHash}. Broker resolves tokenHash → rawToken via the
  // daemon-built tokenHashToRawToken map below, then spawns the pool
  // child with the literal in its env. Logs only ever see tokenHash.
  const tokenHashToRawToken = new Map<string, string>();
  const collectTokenLiteral = (literal: string): string => {
    // 8-char slice MUST match the shim's hashing (mcp-broker-shim.ts).
    // A drift here makes shim handshakes resolve to rawToken="" → child
    // spawn with empty token → auth fail → crash loop → shim exit 75.
    const tokenHash = createHash("sha256").update(literal).digest("hex").slice(0, 8);
    if (!tokenHashToRawToken.has(tokenHash)) {
      tokenHashToRawToken.set(tokenHash, literal);
    }
    return tokenHash;
  };
  // Process-env fallback (loader's auto-inject path uses this token).
  if (process.env.OP_SERVICE_ACCOUNT_TOKEN) {
    collectTokenLiteral(process.env.OP_SERVICE_ACCOUNT_TOKEN);
  }
  // Per-agent overrides (mcpEnvOverrides.1password.OP_SERVICE_ACCOUNT_TOKEN)
  // resolved through SecretsResolver get harvested below once
  // resolvedAgents is built (line ~1706+). Defer the populate-from-config
  // step until after the resolveAllAgents call.

  const brokerLog = log.child({ subsystem: "mcp-broker" });
  const broker = new OnePasswordMcpBroker({
    log: brokerLog,
    spawnFn: ({ tokenHash, rawToken }) => {
      // Fail loud if rawToken is empty — that means tokenHash failed to
      // resolve in the daemon's tokenHashToRawToken map, which is the
      // canonical hash-length-mismatch failure mode. Better to surface
      // a daemon error than silently crash-loop pool children with bad
      // auth. SEC-07: include only tokenHash in the error.
      if (!rawToken) {
        // INC-2026-07-27 — this WAS a `throw`, and it took the fleet down.
        // Two escape routes, both fatal:
        //   (1) attach — ShimServer calls `void broker.acceptConnection(...)`
        //       (shim-server.ts), so the throw became an unhandledRejection
        //       and the daemon handler process.exit(1)-ed;
        //   (2) respawn — the broker calls spawnFn from the pool child's
        //       'exit' listener, so the throw became an uncaughtException
        //       (not EPIPE, so no leniency) → process.exit(1) again.
        // systemd gave up after 5 restarts. One agent's unresolvable MCP
        // token must never take the whole fleet with it, so we now REFUSE
        // this one spawn: BrokerSpawnFn returns `ChildProcess | null`, the
        // broker declines to create the pool (no null child is ever stored),
        // and the attaching agent gets a structured POOL_UNAVAILABLE error.
        // That agent loses its pooled 1password MCP and nothing else.
        // The ROOT trigger is also fixed: fallback-served secrets now
        // populate the sync cache, so the daemon token map is never missing
        // a literal that a shim will hash.
        // SEC-07: log only tokenHash, never the literal.
        brokerLog.error(
          { tokenHash },
          "mcp-broker: empty rawToken — refusing pool spawn (this agent's " +
            "1password MCP is degraded; daemon and other agents unaffected). " +
            "Daemon token map has no literal for this hash. Causes: an op:// " +
            "override resolved via a FALLBACK path that skipped the sync cache " +
            "(fixed 2026-07-27), or shim/daemon hash-slice drift — both must " +
            "slice(0, 8).",
        );
        return null;
      }
      // Spawn the upstream MCP child the broker pools. This is the same
      // command the pre-Phase-108 loader injected per-agent — now once
      // per token. SEC-07: never log rawToken.
      //
      // Phase 999.88 — per-site proxy opt-in. The 1password broker child
      // runs `npx -y @takescake/1password-mcp@latest` and talks ONLY to
      // 1password.com via the OP_SERVICE_ACCOUNT_TOKEN — never to
      // api.anthropic.com. The ambient ANTHROPIC_API_KEY is stripped from the
      // child env (defense-in-depth). The 2026-05-28 deploy regression broke
      // this very pattern: the 999.87 daemon-wide gate injected
      // https_proxy into the broker child and stalled its initialize
      // against 1password.com.
      //
      // OP_SERVICE_ACCOUNT_TOKEN passes through as extraEnv (spreads
      // LAST in the helper) so the broker's pool child still
      // authenticates as the resolved per-agent token unchanged.
      // P2 (WS-2d) — pinned-install resolution with npx fallback. Kills
      // the last `@latest` npx chain (intermediary npm procs + registry
      // re-resolution on every pool-child respawn). Resolution logged so
      // the runbook's pin can be verified from the journal.
      const brokerChildSpawn = resolveBrokerChildSpawn();
      brokerLog.info(
        {
          source: brokerChildSpawn.source,
          command: brokerChildSpawn.command,
        },
        "mcp-broker: 1password child spawn resolved",
      );
      const child = childSpawn(
        brokerChildSpawn.command,
        [...brokerChildSpawn.args],
        {
          env: buildAnthropicSafeEnv({
            OP_SERVICE_ACCOUNT_TOKEN: rawToken,
          }),
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      // Phase 999.15 reconciler integration — register pool PID under
      // synthetic owner so reconciler skip-list (added in this phase)
      // keeps it safe from per-agent SIGTERM during agent cleanup.
      if (mcpTracker !== null && child.pid !== undefined) {
        const syntheticOwner = `__broker:1password:${tokenHash}`;
        void mcpTracker.register(syntheticOwner, process.pid, [child.pid]);
        // Tear down tracker entry when the child exits (broker's own
        // exit handler is the source of truth for respawn — when the
        // broker calls spawnFn again on respawn we re-register fresh).
        child.once("exit", () => {
          if (mcpTracker !== null) {
            mcpTracker.unregister(syntheticOwner);
          }
        });
      }
      brokerLog.info(
        {
          component: "mcp-broker",
          pool: `1password-mcp:${tokenHash}`,
          childPid: child.pid ?? null,
        },
        "spawned pool child",
      );
      return child;
    },
  });

  const shimServer = new ShimServer({
    log: brokerLog.child({ component: "mcp-broker-shim-server" }),
    broker,
    socketPath: MCP_BROKER_SOCKET_PATH,
    resolveRawToken: (tokenHash) => tokenHashToRawToken.get(tokenHash),
  });

  // Listen on the unix-domain socket. Bind failures are non-fatal: log
  // loudly and continue — agents that try to use 1password will see MCP
  // child spawn errors via the SDK's existing onMcpResolutionError path.
  const brokerNetServer = createNetServer((socket) => {
    shimServer.handleConnection(socket);
  });
  try {
    // Best-effort cleanup of stale socket file from a prior crashed daemon.
    try {
      await unlink(MCP_BROKER_SOCKET_PATH);
    } catch {
      // ENOENT is the happy path; other errors will surface on listen().
    }
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (err: Error): void => {
        brokerNetServer.removeListener("listening", onListening);
        rejectListen(err);
      };
      const onListening = (): void => {
        brokerNetServer.removeListener("error", onError);
        resolveListen();
      };
      brokerNetServer.once("error", onError);
      brokerNetServer.once("listening", onListening);
      brokerNetServer.listen(MCP_BROKER_SOCKET_PATH);
    });
    brokerLog.info(
      { socketPath: MCP_BROKER_SOCKET_PATH },
      "mcp-broker listening",
    );
  } catch (err) {
    brokerLog.error(
      { socketPath: MCP_BROKER_SOCKET_PATH, err: String(err) },
      "mcp-broker socket bind failed; pool routing will fail until restart",
    );
  }

  // 4b. Phase 104 — sync wrapper around the warmed cache. The loader
  // requires a SYNC resolver (loader.ts is sync by design); the warming was
  // done above by preResolveAll. If a URI was missed (config edited between
  // yaml-parse and now, or a hot-reload added a new ref), throw — the
  // loader's onMcpResolutionError path will degrade the affected MCP
  // gracefully (matches existing line ~1545 behavior).
  const cachedOpRefResolver: OpRefResolver = (uri: string): string => {
    const cached = secretsResolver.getCached(uri);
    if (cached === undefined) {
      throw new Error(
        `SecretsResolver: ${uri} not pre-resolved (likely added by hot-reload — re-run preResolveAll). `
          + `If this is a fresh op:// URI, save the config to trigger ConfigWatcher.onChange which auto-resolves new refs.`,
      );
    }
    return cached;
  };

  // 5a. Phase 138 — fleet-level coordination db (`fleet-alerts.db`).
  // A SINGLE db (NOT per-agent — the per-agent `usage.db` owns only
  // `provider_usage`) houses BOTH `provider_alert_state` (Plan 03's
  // threshold dedup) and `failover_state` (Plan 05's runtime override).
  // Constructed HERE — before the per-agent LlmRuntime resolver loop
  // (step 6 below) — because that loop wires the FailoverStateStore as
  // each agent's `failoverStateReader`. Pragmas mirror UsageTracker
  // (src/usage/tracker.ts:55-57). The ThresholdAlerter is still built
  // later (after WebhookManager converges) against this same handle.
  const fleetAlertDb = new Database(join(MANAGER_DIR, "fleet-alerts.db"));
  fleetAlertDb.pragma("journal_mode = WAL");
  fleetAlertDb.pragma("busy_timeout = 5000");
  fleetAlertDb.pragma("synchronous = NORMAL");
  log.info(
    { path: join(MANAGER_DIR, "fleet-alerts.db") },
    "fleet-alerts db initialized",
  );

  // Phase 999.98 D8/D11 — runtime model catalog store + the `@latest` snapshot
  // ref. Constructed HERE (before the SdkSessionAdapter at ~3348) so the
  // `getCatalogSnapshot` accessor can be threaded into the adapter for the
  // `<family>@latest` pre-resolve. The catalog is daemon RUNTIME-STATE in
  // ~/.clawcode/manager/ — the config differ never reads it (D8).
  //
  // `latestSnapshot` is a mutable boot-loaded ref the model-monitor cron tick
  // refreshes after each upsert; `getCatalogSnapshot` returns the LIVE ref so an
  // `@latest` agent picks up the freshest snapshot on each (re)start. At boot
  // the catalog is empty → `resolveLatestModel` falls back to the pinned alias.
  const modelCatalogDb = new Database(join(MANAGER_DIR, "model-catalog.db"));
  const modelCatalogStore = new ModelCatalogStore(modelCatalogDb);
  let latestSnapshot: CatalogSnapshot = modelCatalogStore.snapshot();
  const getCatalogSnapshot = (): CatalogSnapshot => latestSnapshot;
  log.info(
    { path: join(MANAGER_DIR, "model-catalog.db") },
    "model catalog db initialized",
  );

  // 5b. Phase 138 Plan 05 — failover runtime-state store. Its
  // constructor creates the `failover_state` table idempotently on the
  // shared `fleetAlertDb`. The SAME instance is wired two ways:
  //   - as each agent's `failoverStateReader` in the resolver loop
  //     below (the LlmRuntime factory reads the override every turn);
  //   - as the FailoverController's write surface (the 1-minute cron).
  const failoverStateStore = new FailoverStateStore({ db: fleetAlertDb });
  log.info("failover-state store initialized (failover_state table)");

  // 5. Resolve all agents — pass the cached sync resolver so any
  // `op://example-vault/item/field` references under mcpServers[].env get
  // substituted with concrete secret values BEFORE the SDK spawns the
  // MCP children. Without this, literal `op://...` strings reach the
  // child process and crash it at first use (e.g. MySQL driver does
  // `dns.lookup("op://...")` → ENOTFOUND).
  //
  // Graceful degradation: a bad op:// ref (missing item, wrong field)
  // logs a loud error and disables just that one MCP for the affected
  // agent. The daemon continues booting; other agents that don't
  // reference the broken MCP are unaffected. Operators see exactly
  // which agent + MCP + env var failed in the daemon log.
  const resolvedAgents = resolveAllAgents(config, cachedOpRefResolver, (info) => {
    log.error(
      { agent: info.agent, server: info.server, reason: info.message },
      // Covers MCP-server env AND voice keys (server:"voice") — INC-2026-06-04
      // WS-A9: optional-secret resolution failures degrade, never crash boot.
      "secret resolution failed — feature disabled for agent (MCP server or voice)",
    );
  });

  let transcriptionWatcher: TranscriptionWatcher | undefined;

  // Phase 136 T-06 — construct an LlmRuntimeService per agent at boot.
  //
  // The service registry below is the single chokepoint required by
  // CONTEXT D-03a + feedback_silent_path_bifurcation: ONE
  // createLlmRuntimeService call per agent per daemon lifetime. The
  // factory emits one structured `phase136-llm-runtime` log line per
  // agent (D-07) so operators can grep
  // `journalctl -u clawcode -g phase136-llm-runtime` to verify
  // migration coverage across the fleet.
  //
  // Phase 138 Plan 04 T-03 — the registry now stores per-agent
  // RESOLVER functions, not boot-cached `LlmRuntimeService` instances.
  // The per-turn dispatch path (`SdkSessionAdapter`, the two
  // compaction-fork sites) consumes the resolver: each call
  // re-invokes `createLlmRuntimeService` so 138-05's `failover_state`
  // override lands next-turn (design (a) — CONTEXT D3 + 138-05 T3).
  // Boot-time telemetry parity is preserved by priming each resolver
  // once in the loop below (`resolver()`, discarded) — so the
  // `phase136-llm-runtime` line still fires at boot, not at
  // first-turn-after-boot.
  const {
    createAgentLlmRuntimeResolver,
    OpenAiCredentialsResolver,
  } = await import("../llm-runtime/index.js");
  const llmRuntimeRegistry = new Map<
    string,
    import("../llm-runtime/index.js").AgentLlmRuntimeResolver
  >();
  // Phase 137 Plan 04 T-03 — per-agent OpenAiCredentialsResolver
  // registry. Constructed ONCE per agent here (single chokepoint per
  // feedback_silent_path_bifurcation memory + CONTEXT D-03a). The
  // ConfigWatcher onChange handler (further down in this function)
  // walks this registry on credentials-changed deltas and calls
  // `invalidateCache()` to honour the RELOADABLE classification (T5).
  //
  // Agents WITHOUT `providers.openai.apiKeyPath` get NO entry in this
  // map — CodexAgentCli's `loadSdkModule()` then throws the
  // operator-actionable missing-credentials error on first turn (T3
  // lazy-fail; daemon boot stays non-blocking).
  const openaiCredentialsRegistry = new Map<
    string,
    import("../llm-runtime/index.js").OpenAiCredentialsResolver
  >();
  // Phase 100 follow-up / v3-optin — the vault-scoped MCP env override resolver,
  // HOISTED above the per-agent boot loop so the v3 `claude-code-interactive`
  // backend can receive it via `LlmRuntimeDeps.opEnvResolver` (mcpEnvOverrides
  // parity with the v2 SDK path — see `session-config.ts`). Also consumed by
  // `SessionManager` below (same const). Daemon shells out via `op read <uri>`
  // through the shared `SecretsResolver` (cache + retry + telemetry); resolved
  // values (e.g. a Acme-only SA token) replace per-server env entries
  // before spawn. The clawdbot fleet token NEVER appears in any agent MCP
  // subprocess env / error / log — see `src/manager/op-env-resolver.ts`.
  const { resolveMcpEnvOverrides } = await import("./op-env-resolver.js");
  const opEnvResolver = async (
    overrides: Record<string, Record<string, string>>,
    agentName: string,
  ): Promise<Record<string, Record<string, string>>> => {
    return resolveMcpEnvOverrides(overrides, {
      opRead: (uri: string) => secretsResolver.resolve(uri),
      log: {
        warn: (...args: unknown[]) =>
          (log.warn as (...a: unknown[]) => void)({ agent: agentName }, ...args),
        info: (...args: unknown[]) =>
          (log.info as (...a: unknown[]) => void)({ agent: agentName }, ...args),
      },
    });
  };
  // Phase 140 Plan 07 (#14) — per-agent ClawCode channel registry. Constructed
  // ONCE here; `wireForConfig` (called per agent in the loop below) opens a
  // bridge + Unix-socket listener for v3 (`claude-code-interactive`) agents only
  // — a v2/SDK agent gets nothing (the gate lives in the registry). The agent's
  // own MCP-server client connects to the per-agent socket and reconnects every
  // 1s, so listener-before-client ordering is free. Torn down in the shutdown
  // closure via `agentChannelRegistry.closeAll()`. Bridge lifecycle = DAEMON
  // lifecycle (not session lifecycle): a respawned v3 agent reuses the same
  // socket. Runtime failover flips do NOT create/destroy bridges mid-life — that
  // failover-aware lifecycle + the `clawcode_inbox_read` return path are
  // documented deferred follow-ups (see agent-channel-registry.ts).
  const agentChannelRegistry = new AgentChannelRegistry();
  for (const cfg of resolvedAgents) {
    const apiKeyPath = cfg.providers?.openai?.apiKeyPath;
    const credentials = apiKeyPath
      ? new OpenAiCredentialsResolver({
          secretsResolver,
          apiKeyPath,
          logger: log.child({ agent: cfg.name, subsystem: "openai-credentials" }),
          agentName: cfg.name,
        })
      : undefined;
    if (credentials) {
      openaiCredentialsRegistry.set(cfg.name, credentials);
    }
    const resolver = createAgentLlmRuntimeResolver(cfg, {
      logger: log,
      openaiCredentials: credentials,
      // Phase 138 Plan 05 T-05 — wire the live FailoverStateStore as the
      // factory's `failoverStateReader`. `createAgentLlmRuntimeResolver`
      // spreads `...deps` into the per-turn factory call, so the factory
      // reads `failoverStateStore.getActiveBackend(name, now)` BEFORE the
      // config-backend switch on EVERY turn — a failover row written by
      // the cron flips the agent's next turn with no daemon restart.
      failoverStateReader: failoverStateStore,
      // Phase 140 Plan 06 Task 10 — inject the daemon's LIVE McpProcessTracker
      // singleton so the v3 `claude-code-interactive` backend's default
      // supervisor factory registers the spawned `claude --channels` PTY pid
      // (→ killAgentGroup + orphan-claude-reaper coverage; closes 140-04
      // Deferred Issue #1). ONLY ClaudeCodeInteractiveBackend reads this field
      // — the Anthropic-SDK + Codex backends ignore it, so the wiring is
      // naturally gated to v3 agents and does NOT touch v2/masking lifecycle.
      // `mcpTracker` is `McpProcessTracker | null` here (boot-scan failure /
      // non-Linux); null flows through to the backend's no-op fallback.
      mcpTracker,
      // v3-optin — mcpEnvOverrides parity for the v3 backend: the resolver
      // merges the acme agents' vault-scoped op:// tokens into the v3
      // `.mcp.json` per-server env (no-op for non-acme agents). The SDK +
      // Codex backends ignore it.
      opEnvResolver,
      // Phase 999.98-03 (gap closure) — thread the LIVE catalog snapshot accessor
      // into the v3 backend so it pre-resolves `<family>@latest` → newest entitled
      // id (parity with the v2 adapter's getCatalogSnapshot at :3379). The SDK +
      // Codex backends ignore it.
      getCatalogSnapshot,
    });
    llmRuntimeRegistry.set(cfg.name, resolver);
    // Phase 140 Plan 07 (#14) — open a ClawCode channel for this agent IFF its
    // configured backend is v3. Returns null (no socket) for v2/SDK agents, so
    // the call is safe to make unconditionally — the gate is internal.
    // 999.103 WS-1 — thread the TodoWrite sink. Late-bound ref: the TodoMirror
    // is constructed after Discord login (it needs the webhook manager); the
    // closure reads it at frame time. Worker/dream sessions resolve to a
    // disabled config inside the mirror, so passing this unconditionally is
    // safe for every wired channel.
    agentChannelRegistry.wireForConfig(cfg, {
      onTodo: (frame) =>
        todoMirrorRef.current?.onTodoUpdate(frame.agent, frame.todos),
    });
    // Phase 138 Plan 04 T-03 — boot-priming. Invoke the resolver once
    // here so its first `phase136-llm-runtime` emission fires at BOOT
    // (matching pre-138-04 behaviour where the factory ran in this
    // loop). The returned service is discarded — the call exists
    // solely to warm the resolver's memo + fire the boot-time log.
    // Without this, design (a) would slip the first emission to the
    // first per-turn invocation, breaking operator greps that count
    // `phase136-llm-runtime` in a fixed post-restart window.
    resolver();
  }
  // Phase 138 Plan 04 T-03 — `llmRuntimeRegistry` is now CONSUMED (the
  // `getLlmRuntime` closure below + the two compaction-fork sites), so
  // the prior no-op discard of that registry is removed.
  // The openaiCredentialsRegistry discard below STAYS — that registry is
  // independently consumed by the ConfigWatcher credentials-changed
  // walk further down (its only other consumer), and would otherwise
  // trip --noUnusedLocals between here and that walk.
  void openaiCredentialsRegistry;
  // Phase 138 Plan 04 T-03 — per-agent runtime resolver lookup. The
  // `SdkSessionAdapter` constructor + the two compaction-fork sites
  // call this to resolve the per-turn runtime. Every resolved agent
  // has a registry entry (the loop above populates one per agent);
  // the throw is a defensive guard for an unknown agent name.
  const getLlmRuntime = (
    agentName: string,
  ): import("../llm-runtime/index.js").LlmRuntimeService => {
    let resolver = llmRuntimeRegistry.get(agentName);
    if (!resolver) {
      // BUGFIX (2026-06-26) — parent-resolver fallback for `<parent>-fork-<id>`
      // forks that dispatch a turn but never register their OWN resolver.
      // Specifically the ADVISOR fork (`forkAdvisorConsult` below): it forks
      // the parent session + a model override and SHARES the parent's
      // skills/tools, so the parent's resolver is the correct one. Without this,
      // `dispatchTurn(forkName, ...)` threw "No LlmRuntime resolver registered
      // for '<parent>-fork-<id>'" → the fork advisor backend was DEAD on prod.
      //
      // This is exactly the candidate-skill-isolation case the OPTIMIZER
      // deliberately avoids (optimizer/fork-resolver.ts) — but optimizer eval
      // forks are `-opt`-suffixed AND register their own resolver via
      // `startAgent`, so the exact-name lookup above already finds theirs and
      // the `-opt` guard below keeps this fallback off them. Scoped narrowly to
      // the `-fork-<id>` shape so a genuinely-unknown agent name still throws.
      const m = /^(.+)-fork-[A-Za-z0-9_-]+$/.exec(agentName);
      if (m && !agentName.endsWith("-opt")) {
        resolver = llmRuntimeRegistry.get(m[1]);
      }
    }
    if (!resolver) {
      // 2026-08-27 — FLEET-DOWN fix. A subagent THREAD session is named
      // `<agent>-thread-<discord thread id>` and is never registered in the
      // per-agent registry, so this lookup missed and the throw below became
      // an unhandledRejection that EXITED THE DAEMON — taking all 9 agents
      // down with it. It fired three times today (14:46, 15:45, 15:46), each
      // on an `Admin Clawdy-thread-…` spawn. The `-fork-` fallback above
      // already established the pattern; threads (and the `-sub-` / `-via-`
      // spawn names, via parentAgentName) just weren't covered.
      for (const candidate of [
        /^(.+)-thread-[0-9]+$/.exec(agentName)?.[1],
        parentAgentName(agentName),
      ]) {
        if (candidate && candidate !== agentName) {
          resolver = llmRuntimeRegistry.get(candidate);
          if (resolver) break;
        }
      }
    }
    if (!resolver) {
      throw new Error(
        `No LlmRuntime resolver registered for agent '${agentName}' — ` +
          `the per-agent registry should contain every resolved agent.`,
      );
    }
    return resolver();
  };

  // Phase 108 — harvest every per-agent OP_SERVICE_ACCOUNT_TOKEN literal
  // (post-op:// resolution) into the daemon-side tokenHash → rawToken map
  // built above. Per-agent overrides (yaml mcpEnvOverrides.1password) live
  // in `agent.mcpEnvOverrides` as op:// URIs; they were NOT resolved by
  // resolveAllAgents (loader keeps them verbatim — see MCP-LOAD-1 test).
  // Resolve each via the warm cache here so the broker's spawnFn has the
  // literal when an agent on a non-default token connects.
  for (const agent of resolvedAgents) {
    // 1) The auto-injected `1password` MCP entry's env carries either the
    //    process-env token (no override) OR the resolved override literal.
    //    Loader's resolveMcpEnvValue runs op:// substitution at that path,
    //    so `mcpServers[i].env.OP_SERVICE_ACCOUNT_TOKEN` is already a
    //    literal here.
    const opServer = agent.mcpServers.find((s) => s.name === "1password");
    const opServerToken = opServer?.env?.OP_SERVICE_ACCOUNT_TOKEN;
    if (typeof opServerToken === "string" && opServerToken.length > 0) {
      collectTokenLiteral(opServerToken);
    }
    // 2) Per-agent mcpEnvOverrides.1password.OP_SERVICE_ACCOUNT_TOKEN. Two
    //    legal yaml shapes:
    //      a) op:// URI — resolve via the warm secrets cache, then collect.
    //      b) Literal `ops_...` token (current production yaml) — collect
    //         directly. The shim hashes whatever literal flows through its
    //         env, so the daemon must collect the same literal here so the
    //         hashes match at handshake time.
    const overrideValue = agent.mcpEnvOverrides?.["1password"]?.OP_SERVICE_ACCOUNT_TOKEN;
    if (typeof overrideValue === "string" && overrideValue.length > 0) {
      if (overrideValue.startsWith("op://")) {
        const resolved = secretsResolver.getCached(overrideValue);
        if (typeof resolved === "string" && resolved.length > 0) {
          collectTokenLiteral(resolved);
        } else {
          brokerLog.warn(
            { agent: agent.name, uri: overrideValue },
            "mcp-broker: per-agent OP_SERVICE_ACCOUNT_TOKEN op:// override unresolved; pool spawn for this agent will fail",
          );
        }
      } else {
        // Literal token — collect directly. SEC-07: never log the literal.
        collectTokenLiteral(overrideValue);
      }
    }
  }
  brokerLog.info(
    { uniqueTokens: tokenHashToRawToken.size },
    "mcp-broker: tokenHash → rawToken map built",
  );

  // Phase 100 follow-up — merge runtime gsd.projectDir overrides into the
  // resolved configs BEFORE SessionManager spins up. The override file lives
  // at ~/.clawcode/manager/gsd-project-overrides.json and is written by the
  // /gsd-set-project Discord slash + set-gsd-project IPC. Overrides survive
  // daemon restart by being applied here at boot. Missing file / parse error
  // → readAllGsdProjectOverrides returns an empty Map (silent — fresh boot).
  // Override only applies to agents that already have gsd.projectDir set in
  // yaml — never grants GSD capability to a non-GSD agent (operator must
  // edit yaml first).
  {
    const { readAllGsdProjectOverrides, DEFAULT_GSD_PROJECT_OVERRIDES_PATH } =
      await import("./gsd-project-store.js");
    const overrides = await readAllGsdProjectOverrides(
      DEFAULT_GSD_PROJECT_OVERRIDES_PATH,
      log,
    );
    if (overrides.size > 0) {
      const list = resolvedAgents as ResolvedAgentConfig[];
      for (let i = 0; i < list.length; i++) {
        const agent = list[i]!;
        const overridden = overrides.get(agent.name);
        if (overridden && agent.gsd?.projectDir) {
          list[i] = { ...agent, gsd: { projectDir: overridden } };
          log.info(
            { agent: agent.name, projectDir: overridden },
            "applied runtime gsd.projectDir override",
          );
        }
      }
    }
  }

  // 5c. Validate only one admin agent (per D-14)
  const adminAgents = resolvedAgents.filter(a => a.admin);
  if (adminAgents.length > 1) {
    throw new ManagerError(
      `Only one admin agent allowed, found ${adminAgents.length}: ${adminAgents.map(a => a.name).join(", ")}`
    );
  }
  if (adminAgents.length === 1) {
    log.info({ admin: adminAgents[0].name }, "admin agent configured");
  }

  // 5a. Scan skills directory and link agent skills
  const skillsPath = resolvedAgents.length > 0 ? resolvedAgents[0].skillsPath : "";

  // Install workspace skills to global and agent skills directories (once)
  await installWorkspaceSkills(join(process.cwd(), "skills"), skillsPath, log);

  const skillsCatalog = await scanSkillsDirectory(skillsPath, log);
  log.info({ skills: skillsCatalog.size }, "skills catalog loaded");

  // Phase 130 Plan 02 — per-agent accumulator of refused skills. Plan 03
  // T-01 reads this immediately after boot to emit ONE batched Discord
  // notification per agent; Plan 03 T-02 surfaces it on the
  // `clawcode skills <agent>` CLI table via the manager's getter.
  const unloadedSkillsByAgent = new Map<string, UnloadedSkillEntry[]>();
  // Skill-slash-commands — per-agent ACTIVE skill name sets (manifest-refused
  // skills excluded). Captured from the same loop that drives linkAgentSkills
  // so the slash-command registration uses the authoritative active set, not
  // the raw `agent.skills` config (which still includes refused skills).
  const loadedSkillsByAgent = new Map<string, ReadonlySet<string>>();

  // Phase 130 Plan 02 — single chokepoint for SKILL.md manifest validation.
  // For each per-agent skill, call `loadSkillManifest` once with the agent's
  // enabled MCP server names. Skills that REFUSE (status: refused-mcp-missing
  // or parse-error) are filtered OUT of the link list so no broken symlink is
  // created in the agent's workspace. Manifest-missing falls through as a
  // back-compat warning (D-03a) — pre-Phase-130 skills still load.
  //
  // The per-agent `unloadedSkills` accumulator is captured into
  // `unloadedSkillsByAgent` for Plan 03's Discord webhook batch + CLI surface.
  // Silent-path-bifurcation guard: this is the ONLY call to `loadSkillManifest`
  // in daemon.ts. CLI's `clawcode skills --validate` (Plan 03 T-02) reuses the
  // same module; tests reuse the same module. ONE chokepoint, ONE log emission
  // shape, ONE refusal taxonomy.
  for (const agent of resolvedAgents) {
    const enabledMcp = agent.mcpServers.map((s) => s.name);
    const loadedSkills: string[] = [];
    const unloaded: UnloadedSkillEntry[] = [];
    for (const skillName of agent.skills) {
      const entry = skillsCatalog.get(skillName);
      if (!entry) {
        // Skill name listed in config but absent from the catalog — preserve
        // the existing `linkAgentSkills` warn-and-skip behavior (NOT a Phase
        // 130 refusal). Falls through with the original name so downstream
        // logging is unchanged.
        loadedSkills.push(skillName);
        continue;
      }
      // skill-slash-commands fix (reelforge-cmd-not-registered) — classify
      // the manifest result through the shared pure load-gate helper.
      // parse-error skills are now ADMITTED to loadedSkills (back-compat,
      // like manifest-missing — a pre-Phase-130 frontmatter without
      // version/owner predates the manifest contract) while STILL recorded
      // in `unloaded` for the operator notify; only refused-mcp-missing is a
      // hard exclude.
      const decision = classifySkillForLoadGate(
        skillName,
        loadSkillManifest(entry.path, enabledMcp),
      );
      if (decision.loaded) loadedSkills.push(skillName);
      if (decision.unloadedEntry) unloaded.push(decision.unloadedEntry);
    }
    unloadedSkillsByAgent.set(agent.name, unloaded);
    // Skill-slash-commands — retain the active set for slash registration.
    loadedSkillsByAgent.set(agent.name, new Set<string>(loadedSkills));
    await linkAgentSkills(join(agent.workspace, "skills"), loadedSkills, skillsCatalog, log, {
      // Native Skill() resolution — must match the session's cwd
      // (ensureSessionCwd: gsd.projectDir ?? workspace), not the workspace
      // blindly, or a gsd agent's links land where the CLI never looks.
      cliSkillsDir: join(agent.gsd?.projectDir ?? agent.workspace, ".claude", "skills"),
    });
  }

  // Phase 88 Plan 02 MKT-01 — resolve marketplace legacy sources once at
  // boot. Empty `[]` when `defaults.marketplaceSources` is omitted (v2.1/v2.2
  // configs are unchanged). Closed over by the marketplace-* IPC intercepts
  // below so /clawcode-skills-browse / -install / -remove have the full
  // catalog surface without a per-call re-resolve.
  const resolvedMarketplaceSources = resolveMarketplaceSources(config);
  const ledgerPath = DEFAULT_SKILLS_LEDGER_PATH;

  // Phase 90 Plan 05 HUB-02 — daemon-scoped cache for ClawHub /api/v1/plugins
  // responses. TTL mirrors Plan 04 HUB-08 skills cache (configurable via
  // defaults.clawhubCacheTtlMs, default 10 min). Negative entries carry
  // their own retryAfterMs from Retry-After header.
  const clawhubPluginsCache = createClawhubCache<ClawhubPluginsResponse>(
    config.defaults.clawhubCacheTtlMs,
  );

  // 5b. Build routing table and rate limiter
  const routingTable = buildRoutingTable(resolvedAgents);
  // Mutable ref — config hot-reload swaps `current` so bridge + IPC observe
  // updated channel→agent bindings without needing daemon restart.
  const routingTableRef = { current: routingTable };
  const rateLimiter = createRateLimiter(DEFAULT_RATE_LIMITER_CONFIG);
  log.info({ routes: routingTable.channelToAgent.size }, "routing table built");

  // 5d. Reconcile registry — prune ghost entries left by renamed/removed agents.
  // Runs BEFORE SessionManager so startAll never sees stale names.
  //
  // clawdy-v2-stability follow-up (2026-04-19): `pruneNonStoppedSubagents: true`
  // reaps sub/thread entries whose `status !== "stopped"` but whose child
  // process cannot be alive — by definition, no subagent process survives a
  // daemon restart, so any entry marked running/starting/etc. at boot time is
  // a phantom left over from an uncleanly-exited prior daemon. Without this,
  // those entries survive the TTL reap (targets stopped) AND the
  // pollMemoryStats filter (allows running), triggering
  // "Memory store not found" log spam every SSE tick.
  const knownAgentNames = new Set(resolvedAgents.map((a) => a.name));
  // Atomic ghost-prune. The reconcile transform is synchronous and pure, so it
  // runs inside mutateRegistry's critical section; returning the same reference
  // when nothing was pruned skips the write (preserves the original
  // "only write when pruned" behavior).
  let prunedGhosts: ReturnType<typeof reconcileRegistry>["pruned"] = [];
  await mutateRegistry(REGISTRY_PATH, (current) => {
    const reconciled = reconcileRegistry(current, knownAgentNames, {
      pruneNonStoppedSubagents: true,
    });
    prunedGhosts = reconciled.pruned;
    return reconciled.pruned.length > 0 ? reconciled.registry : current;
  });
  if (prunedGhosts.length > 0) {
    for (const entry of prunedGhosts) {
      log.info(
        { name: entry.name, reason: entry.reason },
        "pruned ghost registry entry",
      );
    }
    log.info(
      { prunedCount: prunedGhosts.length },
      "registry reconciliation complete",
    );
  }

  // 6. Create SessionManager
  // Phase 138 Plan 04 T-03 — thread the per-agent runtime resolver
  // into `SdkSessionAdapter`. `createSession`/`resumeSession` now
  // resolve the per-turn SDK load through `getLlmRuntime(config.name)`
  // → the failover-aware per-agent registry above.
  // Phase 999.98 D11 — thread `getCatalogSnapshot` so createSession/resumeSession
  // can PRE-RESOLVE a `<family>@latest` config value to the newest entitled
  // concrete id (via resolveLatestModel over the live snapshot) BEFORE the pure
  // resolveModelId call.
  const sessionAdapter =
    adapter ?? new SdkSessionAdapter({ getLlmRuntime, getCatalogSnapshot });
  // `opEnvResolver` + its `resolveMcpEnvOverrides` import are defined ABOVE the
  // per-agent boot loop (hoisted so the v3 backend's `LlmRuntimeDeps` can carry
  // it). It is consumed here unchanged.

  // P3 (memory program) — SpawnGovernor: class-aware admission for every
  // managed spawn. Live-config resolver + the high-aware cgroup percent
  // (P1's effective min(high,max) ceiling). Fail-open on read errors;
  // agent class advisory-only.
  // 999.106 G-2 — the backpressure loop's shared pieces. The bus carries the
  // census-derived anon-balloon signal (MemoryGuard publishes each tick,
  // constructed further down — the bus is just a passive holder, so
  // construction order does not matter); the PSI read is fresh per acquire.
  // Every leg fails open: absent cgroup dir / stale signal / throw ⇒ admit
  // on cgroup-% alone.
  const memorySignalBus = new MemorySignalBus();
  const gateCgroupDir = resolveOwnCgroupDir();
  const readGatePressure = () => readMemoryPressure(gateCgroupDir);
  const getBalloonSignal = () =>
    memorySignalBus.get(
      config.defaults.memoryGuard?.signalMaxAgeMs ??
        MEMORY_GUARD_DEFAULTS.signalMaxAgeMs,
    );

  const spawnGovernor = new SpawnGovernor({
    resolveConfig: () => config.defaults.spawnGovernor,
    readMemoryPercent: async () =>
      (await readCgroupMemoryStats())?.memoryPercent ?? null,
    readPressure: readGatePressure,
    getBalloonSignal,
    log: log.child({ component: "spawn-governor" }),
  });

  const manager = new SessionManager({
    adapter: sessionAdapter,
    registryPath: REGISTRY_PATH,
    log,
    opEnvResolver,
    spawnGovernor,
    // Phase 999.14 MCP-01 — daemon-wide tracker for per-agent MCP child
    // PID discovery + cleanup. Null when no MCP servers configured (no-op).
    mcpTracker,
    // Phase 999.15 TRACK-02 — proc-age math constants piped through so the
    // polled-discovery loop can pass minAge=5 + bootTimeUnix +
    // clockTicksPerSec to discoverClaudeSubprocessPid without per-call
    // /proc/stat reads. Undefined when mcpTracker is null (non-Linux / no
    // MCP servers configured).
    mcpBootTimeUnix,
    mcpClockTicksPerSec,
    // Quick task 260521-5gh Gap 2 — crash-alert DI hook. Posts an agent
    // crash to its bound Discord channel. DiscordBridge isn't constructed
    // until later in boot, so we close over discordBridgeRef and read the
    // resolved bridge at CALL TIME (same deferred-resolution pattern as
    // discordReact / postCorrectiveMessage). When no bridge exists (CLI
    // runner / non-Discord turn), this is a silent no-op — recovery still
    // ran. The bridge.sendCrashAlert method is already fail-open; we only
    // guard the routingTableRef channel lookup so the closure never throws.
    onCrashAlert: (payload: CrashAlertPayload): void => {
      const bridge = discordBridgeRef.current;
      if (!bridge) return;
      const channelId =
        routingTableRef.current.agentToChannels.get(payload.agent)?.[0] ??
        null;
      const text = payload.terminal
        ? `⚠️ ${payload.agent} FAILED after max retries — manual restart needed`
        : `${payload.agent} crashed (attempt ${payload.attempt}): ${payload.errorSummary}`;
      // Fire-and-forget — sendCrashAlert is fail-open and never throws.
      void bridge.sendCrashAlert({ channelId, text });
    },
  });

  // FIND-123-A.next T-08 — bind the sink-lookup closure now that `manager`
  // exists. Both reconcile callsites (TRACK-06 killAgentGroup closure above,
  // TRACK-01 per-tick reconcileAllAgents below) read this via captured
  // reference; assigning here makes the resolver live for every subsequent
  // reaper tick + kill-group flow.
  getClaudePidByName = (agentName: string): number | null | undefined => {
    const handle = manager.getSessionHandle(agentName);
    if (!handle) return undefined;
    return handle.getClaudePid?.() ?? null;
  };

  // Phase dream-cron-wiring — shared dream machinery factory. Builds the
  // per-agent runDreamPass / applyDreamResult / getLastTurnAt adapters
  // ONCE, consumed by BOTH the `run-dream-pass` IPC handler (manual
  // `clawcode dream` trigger) and the boot-time `registerDreamCron`
  // wiring (30-min-idle auto trigger). Single implementation — no
  // silent-path-bifurcation between the manual and auto dream paths.
  // Phase 999.188 — ONE veto store for the daemon (the JSONL file is the
  // state; the dashboard's read-only handlers open their own view of it).
  const dreamVetoStore = createDreamVetoStore();
  let dreamVetoTick: VetoTickHandle | null = null;
  const postDreamTextToAgent = async (agent: string, text: string): Promise<void> => {
    await deliverAgentText({
      agentName: agent,
      text,
      reason: "dream-promote",
      sinks: agentTextSinks(agent),
      log,
    });
  };
  /** Phase 999.188 — the apply callback the veto tick runs when a window closes. */
  const applyDreamVetoRow = async (row: VetoStoreRow): Promise<{ ok: true } | { ok: false; error: string }> => {
    const cfg = resolvedAgents.find((a) => a.name === row.agentName);
    if (!cfg) return { ok: false, error: `agent not configured: ${row.agentName}` };
    const roots = resolveMemoryRoots(cfg);
    const store = manager.getMemoryStore(row.agentName);
    const capChars =
      cfg.perf?.memoryAssemblyBudgets?.injectedMemoryMaxChars ?? INJECTED_MEMORY_MAX_CHARS;
    const { readFile: rf } = await import("node:fs/promises");
    const result = await promoteCandidates(row, {
      resolveChunk: (chunkId) => {
        const c = store?.getMemoryChunk(chunkId);
        return c ? { heading: c.heading, body: c.body } : null;
      },
      readMemory: async () => {
        try {
          return await rf(roots.memoryMdPath, "utf8");
        } catch {
          return "";
        }
      },
      appendMemory: async (content) => {
        const r = await clawcodeMemoryEdit(
          { path: "MEMORY.md", mode: "append", content },
          { memoryRoot: roots.tier1Dir, agentName: row.agentName, log: logger.child({ component: "dream-promote" }) },
        );
        return r.ok ? { ok: true } : { ok: false, error: r.error };
      },
      capChars,
      now: () => new Date(),
    });
    log.info(
      {
        agent: row.agentName,
        runId: row.runId,
        promoted: result.promoted.length,
        skipped: result.skipped.map((x) => x.reason),
        memoryChars: result.memoryChars,
        action: "dream-promote-applied",
      },
      "[dream] promotion run applied",
    );
    // Best-effort channel line (the veto tick's onApplied cannot see the
    // result, so post it here). Failure never affects the row's status.
    void postDreamTextToAgent(row.agentName, formatPromoteReport(row.agentName, row.runId, result)).catch(() => {});
    return result.ok ? { ok: true } : { ok: false, error: result.error ?? "nothing promoted" };
  };

  const buildDreamMachineryForDaemon = () =>
    buildDreamMachinery({
      manager,
      vetoStore: dreamVetoStore,
      resolveDreamPolicy: (agent: string) =>
        resolveDreamPolicy(resolvedAgents.find((a) => a.name === agent)?.dream),
      postToAgent: postDreamTextToAgent,
      resolveMemoryRoot: (agent: string) => {
        const cfg = resolvedAgents.find((a) => a.name === agent);
        // Phase 999.187 — the ONE Tier 1 dir (same as the prompt + edit tool).
        return cfg ? resolveMemoryRoots(cfg).tier1Dir : "";
      },
      // dream-pass is a one-shot LLM call (no session context, no tools).
      // callHaikuDirect honors the maxOutputTokens budget (dream-pass needs
      // ~4096 for full JSON; haiku-direct's 2048 default truncates mid-
      // string → parse-failed). Site tag "dream-pass" for haiku-direct
      // telemetry attribution.
      dispatch: async (dispatchReq) => {
        try {
          const text = await callHaikuDirect(
            dispatchReq.systemPrompt,
            dispatchReq.userPrompt,
            { maxTokens: dispatchReq.maxOutputTokens },
            "dream-pass",
          );
          // Token counts unavailable from the direct call; approximate
          // via chars/4 (consistent with dream-prompt-builder's budget).
          const inApprox = Math.ceil(
            (dispatchReq.systemPrompt.length + dispatchReq.userPrompt.length) /
              4,
          );
          const outApprox = Math.ceil(text.length / 4);
          return { rawText: text, tokensIn: inApprox, tokensOut: outApprox };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`dream-dispatch-failed: ${msg}`);
        }
      },
      now: () => new Date(),
      log,
    });

  // 6-bis. Create TurnDispatcher singleton (Phase 57 Plan 03).
  // Single chokepoint for every agent-turn initiation — Discord bridge and
  // task scheduler route through it so every persisted trace row carries a
  // TurnOrigin JSON blob. Future Phase 59 handoffs + Phase 60 triggers plug
  // in by calling the same dispatch/dispatchStream methods (no per-source
  // Turn lifecycle reinvention).
  const turnDispatcher = new TurnDispatcher({
    sessionManager: manager,
    log,
    // Phase 90 MEM-03 — pre-turn hybrid-RRF retrieval hook. The closure
    // defers to SessionManager.getMemoryRetrieverForAgent which produces
    // a per-call retriever (reads topK from current agent config, uses
    // the shared MiniLM embedder). Returns empty array when the agent
    // has no MemoryStore (opt-out or not-yet-initialized) — zero side
    // effects on the hot path.
    memoryRetriever: async (agentName, query) => {
      const retriever = manager.getMemoryRetrieverForAgent(agentName);
      if (!retriever) return [];
      return retriever(query);
    },
    // Phase 999.187 — topic-shift refresh for the retrieval cadence gate.
    queryEmbedder: (q: string) => manager.getEmbedder().embed(q),
    // Phase 90 MEM-05 — cue-memory writer DI. Wrapped into a closure so
    // memory-cue.ts stays pure (no Logger import from the daemon layer);
    // the dispatcher's own log.child is threaded in.
    memoryCueWriter: async (args) => {
      const { writeCueMemory } = await import("../memory/memory-cue.js");
      return writeCueMemory({ ...args, log });
    },
    // Phase 90 MEM-06 — subagent-return capture DI. Mirror shape of
    // memoryCueWriter — pure module imported lazily.
    subagentCapture: async (args) => {
      const { captureSubagentReturn } = await import(
        "../memory/subagent-capture.js"
      );
      return captureSubagentReturn({ ...args, log });
    },
    // Phase 90 MEM-05 / MEM-06 — per-agent workspace resolver. Looks up
    // the resolved agent config from the manager's in-memory map. Returns
    // undefined when the agent isn't registered (e.g., daemon boot race).
    workspaceForAgent: (agentName) => {
      const cfg = resolvedAgents.find((a) => a.name === agentName);
      // Phase 999.187 — the cue writer and subagent capture append
      // `memory/<file>` to this, so hand them the parent of the agent's
      // canonical memoryDir (== workspace unless `memoryPath` is set). Daily
      // logs and consolidation already used that dir; now every dated file
      // lands in one place.
      return cfg ? dirname(resolveMemoryRoots(cfg).memoryDir) : undefined;
    },
    // Phase 90 MEM-05 D-32 — Discord reaction adder. DiscordBridge isn't
    // constructed until later in boot; we close over discordBridgeRef so
    // the resolved reference is read at CALL TIME (when a cue actually
    // fires), not construction time. When discord isn't available (no
    // token / no bindings), the reaction is a no-op. All discord.js calls
    // are try/catch-wrapped — a stale snowflake or permission error MUST
    // NOT poison the cue-write path.
    discordReact: async (target, emoji) => {
      const bridge = discordBridgeRef.current;
      if (!bridge) return;
      try {
        const channel = await bridge.discordClient.channels.fetch(
          target.channelId,
        );
        if (!channel || !("messages" in channel)) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const message = await (channel as any).messages.fetch(target.messageId);
        if (!message) return;
        await message.react(emoji);
      } catch (err) {
        log.warn(
          { err: (err as Error).message, target, emoji },
          "discord reaction failed (non-fatal)",
        );
      }
    },
    // Phase 999.63 Plan 02 T-02 — wire the per-turn verification-tool-called
    // signal. Reads the active Turn's accumulated tool-call names via the
    // agent's TraceCollector. Returns [] when no collector / no active turn
    // (boot race, test). Feeds firePostTurnDetectors — detectMissedUpload
    // (Phase 96, previously always saw []) AND the Plan 03 financial-
    // verification gate consume this. Before this plan the hook was
    // declared-but-unwired (Phase 96 D-10), so the detectors always saw [].
    recentToolCallNames: (agentName: string): readonly string[] =>
      manager.getTraceCollector(agentName)?.getActiveTurnToolCallNames(agentName) ?? [],
    // 2026-08-27 — figures-class provenance (tool_result text, bounded).
    recentToolResultText: (agentName: string): string =>
      manager.getTraceCollector(agentName)?.getActiveTurnToolResultText(agentName) ?? "",
    // 2026-08-27 — evidence ledger (sources the turn consulted, + lookback).
    // 2026-08-28 — fork/thread session names (`<agent>-fork-xxxxxx`) have no
    // collector of their own; resolve to the base agent like the verify-claim
    // arm does, or the delivery snapshot for a forked turn is always empty.
    recentEvidence: (agentName: string) => {
      const owner = manager.getTraceCollector(agentName) ? agentName : baseAgentName(agentName);
      return manager.getTraceCollector(owner)?.getActiveTurnEvidence(owner) ?? [];
    },
    // 2026-08-27 — claim ledger (verify_claim records for the active turn).
    recentClaims: (agentName: string) => {
      const owner = manager.getTraceCollector(agentName) ? agentName : baseAgentName(agentName);
      return manager.getTraceCollector(owner)?.getActiveTurnClaims(owner) ?? [];
    },
    // Phase 999.63 Plan 03 D5 — labelled-correction delivery. The
    // financial-verification gate's corrective re-prompt response is
    // posted to the agent's Discord channel as a SEPARATE message.
    // DiscordBridge isn't constructed until later in boot, so we close
    // over discordBridgeRef and read the resolved bridge at CALL TIME
    // (same deferred-resolution pattern as discordReact above). When no
    // bridge exists (CLI runner / non-Discord turn), this is a silent
    // no-op — the gate still ran + telemetry still fired.
    postCorrectiveMessage: async ({ channelId, text }) => {
      const bridge = discordBridgeRef.current;
      if (!bridge) return;
      await bridge.postFinancialCorrection({ channelId, text });
    },
    // 999.63c — preferred correction delivery: edit the original message
    // in place when the bridge can prove it safe (deliveredRefs hit +
    // decision ladder), internally falling back to the labelled post.
    // Same deferred-resolution pattern; a missing bridge reports "post"
    // (nothing delivered — CLI runner / non-Discord turn, matching the
    // postCorrectiveMessage no-op posture).
    applyCorrectiveEdit: async (args) => {
      const bridge = discordBridgeRef.current;
      if (!bridge) return "post";
      return bridge.applyFinancialCorrection(args);
    },
    // 999.63d — verify-behind marker + ✅ badge. Same deferred-bridge
    // pattern; missing bridge = no-op (CLI runner / non-Discord turn).
    appendPendingMarker: async (args) => {
      const bridge = discordBridgeRef.current;
      if (!bridge) return null;
      return bridge.appendFinancialPendingMarker(args);
    },
    removePendingMarker: async (args) => {
      const bridge = discordBridgeRef.current;
      if (!bridge) return;
      await bridge.removeFinancialPendingMarker(args);
    },
    applyVerifiedBadge: async (args) => {
      const bridge = discordBridgeRef.current;
      if (!bridge) return;
      await bridge.applyVerifiedBadge(args);
    },
    // 2026-07-31 (supersedes the Plan 04 `verificationOverride`)
    // — full-block resolver, HOT-RELOAD CORRECT: reads the live
    // `manager.getAgentConfig` map (updated by setAllAgentConfigs on every
    // reload) instead of the boot-time `resolvedAgents` array, which
    // silently ignored `clawcode reload` for this knob. The array stays
    // as the boot-window fallback (before setAllAgentConfigs first runs).
    resolveVerification: (agentName: string) =>
      manager.getAgentConfig(agentName)?.verification ??
      resolvedAgents.find((a) => a.name === agentName)?.verification,
  });
  // 999.63d/7 — re-apply persisted verification overrides. Mirrors the
  // effort-state boot restore: an operator who flipped this from Discord
  // expects it to survive a restart, and an override that silently fails
  // to re-apply is the failure class this gate exists to catch.
  void hydrateVerificationOverrides(
    DEFAULT_VERIFICATION_STATE_PATH,
    log as unknown as import("pino").Logger,
  ).catch((err: unknown) => {
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "verification-state hydrate failed — agents fall back to yaml",
    );
  });
  // Phase 999.164 — re-apply persisted /clawcode-quick overrides (same
  // contract as the verification overrides above).
  void hydrateFastLaneOverrides(
    DEFAULT_FAST_LANE_STATE_PATH,
    log as unknown as import("pino").Logger,
  ).catch((err: unknown) => {
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "fast-lane-state hydrate failed — agents fall back to yaml",
    );
  });
  // Phase 999.171 — re-apply persisted /clawcode-ux overrides (same contract).
  void hydrateUxFeatureOverrides(
    DEFAULT_UX_FEATURE_STATE_PATH,
    log as unknown as import("pino").Logger,
  ).catch((err: unknown) => {
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "ux-feature-state hydrate failed — agents fall back to yaml",
    );
  });
  log.info("TurnDispatcher initialized");

  // 6-ter. Create TaskStore singleton (Phase 58 Plan 03).
  // Daemon-scoped SQLite — shared across all agents, single-writer owned by
  // the daemon. Consumers (Phase 59 TaskManager, Phase 60 TriggerEngine,
  // Phase 63 CLIs via READ-ONLY handle) import the instance from startDaemon's
  // return value. Agents NEVER write directly — the single-writer invariant
  // (STATE.md Phase 58 blockers) must be preserved.
  const taskStore = new TaskStore({
    dbPath: join(MANAGER_DIR, "tasks.db"),
  });
  log.info({ path: join(MANAGER_DIR, "tasks.db") }, "TaskStore initialized");

  // Reconcile stale in-flight tasks from the previous daemon run BEFORE
  // SessionManager.startAll fires — so any Phase 59 delegate_task on the
  // first tick does not race against a stale row carrying a duplicate
  // task_id (LIFE-04).
  const reconciliation = runStartupReconciliation(
    taskStore,
    ORPHAN_THRESHOLD_MS,
    log,
  );
  if (reconciliation.reconciledCount > 0) {
    log.warn(
      {
        count: reconciliation.reconciledCount,
        taskIds: reconciliation.reconciledTaskIds,
      },
      "startup reconciliation marked stale tasks orphaned",
    );
  }

  // Mutable ref so closures created before discordBridge initialization can still access it
  const discordBridgeRef: { current: DiscordBridge | null } = { current: null };
  // 999.160 v1.2 — icon sync reads the bridge at call time (it is not built yet here).
  setIconSyncBridgeGetter(() => discordBridgeRef.current);

  // Phase 145 WS3 (Plan 04) — late-binding ref to the Slack MessagingBridge so
  // the `ask-user-question` IPC handler (constructed at the handler step well
  // before the Slack bridge is built) can reach it at CALL TIME for the text-
  // fallback post path. Same `.current = X` pattern as discordBridgeRef.
  const slackMessagingBridgeRef: {
    current: import("../messaging/bridge.js").MessagingBridge | null;
  } = { current: null };

  // Phase 145 WS2 (Plan 05) — late-binding ref to the background workflow
  // orchestrator. The `start-workflow` IPC handler is constructed at the
  // handler step (well before the orchestrator is built — it needs the spawner's
  // registerLlmRuntime closure that only exists after the spawner is
  // constructed near the end of boot), so it reads `.current` at CALL TIME.
  // Same `.current = X` pattern as discordBridgeRef.
  const workflowOrchestratorRef: { current: WorkflowOrchestrator | null } = {
    current: null,
  };
  // Phase 999.130 — report-card deps, populated once the crons are wired so
  // the `report-card` IPC intercept below (a boot-closure handler like
  // start-workflow) can serve the CLI the same numbers the Monday post uses.
  const reportCardDepsRef: { current: ReportCardDeps | null } = { current: null };

  // Phase 116-03 F27 — late-binding ref for the dashboard's SseManager. The
  // bridge is constructed BEFORE the dashboard (step 11b vs 11d) but its
  // onConversationTurn closure needs to broadcast through the SseManager.
  // Same `.current = X` pattern as discordBridgeRef — the closure reads at
  // fire time so it picks up the post-startDashboardServer value.
  const sseManagerRef: {
    current: import("../dashboard/sse.js").SseManager | null;
  } = { current: null };
  // Field-name contract: SSE payload is locked to {agent, turnId, ts, role}
  // per the dashboard-redesign-2026-05-08 spec (must-have #4). Daemon-side
  // emit uses the same key set; UI destructures by these names.

  // Backlog 999.95 — one shared live-preview store, constructed here (before
  // the IPC handler closure at the switch ~6700 AND before startDashboardServer
  // below). Injected into the dashboard server so the /preview routes read from
  // it; the `show-preview` IPC handler pushes into it by closure. Single
  // instance → routes' SSE responses and the handler's reloads share state.
  const previewStore = new PreviewStore();


  // Phase 100 follow-up — late-binding refs for the TriggerEngine deliveryFn.
  // TriggerEngine is constructed at boot step 6-quinquies-b (~line 1935),
  // long before WebhookManager (~line 3530) and the bot-direct sender
  // (~line 3499) exist. Using mutable refs is the same pattern already
  // applied for discordBridgeRef — the closure reads `.current` at fire time
  // (cron triggers don't fire until after the agents start at the bottom of
  // boot), so the slot is populated by then. If a trigger somehow fires
  // before either is ready, the deliveryFn warn-logs + skips delivery
  // (the dispatch itself still ran, watermark still advances).
  const webhookManagerRef: { current: WebhookManager | null } = { current: null };
  const botDirectSenderRef: {
    current: import("./restart-greeting.js").BotDirectSender | null;
  } = { current: null };
  // 999.178 R1 — late-bound operator dead-letter sink. `postToAdminClawdy` is
  // a const declared ~1200 lines below (after WebhookManager wiring); the
  // scheduled-delivery dead-letter references it through this ref rather than
  // reasoning about boot ordering (replayMissed can fire a scheduled delivery
  // during boot). Set once, right after postToAdminClawdy is defined.
  const postToAdminRef: {
    current: ((msg: string) => Promise<void>) | null;
  } = { current: null };
  // 999.103 WS-1 — live TodoWrite checklist mirror. Same late-bound pattern:
  // populated after Discord login when the webhook manager exists.
  const todoMirrorRef: {
    current: import("../discord/todo-mirror.js").TodoMirror | null;
  } = { current: null };

  // 6a. Create escalation budget tracker (shared SQLite DB in manager dir)
  const escalationBudgetDb = new Database(join(MANAGER_DIR, "escalation-budget.db"));
  const escalationBudget = new EscalationBudget(escalationBudgetDb);

  // Build per-agent budget configs from resolved configs
  const budgetConfigs = new Map<string, import("../usage/budget.js").AgentBudgetConfig>();
  for (const agentConfig of resolvedAgents) {
    if (agentConfig.escalationBudget) {
      budgetConfigs.set(agentConfig.name, agentConfig.escalationBudget);
    }
  }

  // Create EscalationMonitor with budget enforcement and Discord alerts
  const escalationMonitor = new EscalationMonitor(manager, {
    errorThreshold: 3,
    escalationModel: "sonnet",
    keywordTriggers: ["this needs opus"],
  }, {
    budget: escalationBudget,
    budgetConfigs,
    alertCallback: (agent, model, threshold) => {
      const bridge = discordBridgeRef.current;
      if (!bridge) return;
      const agentConfig = resolvedAgents.find(a => a.name === agent);
      const channelId = agentConfig?.channels[0];
      if (!channelId) return;
      const config = budgetConfigs.get(agent);
      const dailyLimit = config?.daily?.[model as keyof typeof config.daily] ?? 0;
      const tokensUsed = escalationBudget.getUsageForPeriod(agent, model, "daily");
      bridge.sendBudgetAlert(channelId, {
        agent,
        model,
        tokensUsed,
        tokenLimit: dailyLimit as number,
        threshold,
        period: "daily",
      }).catch(err => log.warn({ err, agent }, "failed to send budget alert"));
    },
  });
  log.info("escalation monitor initialized with budget enforcement");

  // 6a2. Create advisor budget tracker (shared SQLite DB in manager dir)
  const advisorBudgetDb = new Database(join(MANAGER_DIR, "advisor-budget.db"));
  const advisorBudget = new AdvisorBudget(advisorBudgetDb);
  log.info("advisor budget initialized");

  // 6a2a. Phase 138 — fleet-level coordination db (`fleet-alerts.db`).
  // NOTE: as of Plan 05 the `fleetAlertDb` handle + the
  // `FailoverStateStore` are constructed EARLIER (just before the
  // per-agent LlmRuntime resolver loop, step "5b" above) — the resolver
  // loop wires the FailoverStateStore as each agent's
  // `failoverStateReader`, so the db must exist before that loop. The
  // ThresholdAlerter (Plan 03) is still built later, after WebhookManager
  // converges (~line 8290). One db, two tables: `provider_alert_state`
  // (ThresholdAlerter) + `failover_state` (FailoverStateStore).

  // 6a2b. Phase 117 Plan 117-11 — per-channel verbose-level state for
  // /clawcode-verbose (Discord operator slash command). Separate file
  // from advisor-budget.db per RESEARCH §4.1 + §6 Pitfall 4 / §7 Q2
  // RESOLVED — matches the AdvisorBudget's own-file precedent and keeps
  // backup/restore semantics independent across the two stores. Shared
  // by the IPC `set-verbose-level` handler (writes) and the DiscordBridge
  // mutation point at bridge.ts:~810 (reads via getLevel).
  const verboseStateDb = new Database(join(MANAGER_DIR, "verbose-state.db"));
  const verboseState = new VerboseState(verboseStateDb);
  log.info({ path: join(MANAGER_DIR, "verbose-state.db") }, "verbose state initialized");

  // 6a2c. Phase 999.117 WS-3 — agent-to-agent loop governor.
  //
  // ONE instance for the whole fleet: the bounds are per-conversation and
  // per-ordered-pair, so a second instance would split the counters and
  // silently double every budget. Counters are in-memory and deliberately
  // NOT persisted — a daemon restart clearing them is the right failure
  // mode, since a restart is exactly when previously-blocked traffic should
  // get one more chance.
  //
  // NOT hot-reloadable: thresholds are captured here at boot. A YAML change
  // needs a restart. (Assume restart-to-apply unless proven otherwise —
  // `allowedModels`, `verification.ux` and `heartbeat.enabled` were all
  // documented reloadable and were not.)
  const a2aGovernorConfig = {
    ...DEFAULT_LOOP_GOVERNOR_CONFIG,
    ...(config.defaults?.a2a?.governor ?? {}),
  };
  // Phase 999.117 WS-2 — ONE cross-path delivery dedupe for the whole daemon.
  // Every consumer that can turn an A2A message into a turn shares it: the
  // InboxSource watcher, the heartbeat reconciler, the Discord webhook relay,
  // and the v3 channel push. Separate instances would each see a subset of
  // the paths and dedupe nothing between them — which IS the double-delivery
  // bug. In-memory and TTL'd by design: after a restart a redelivery should
  // get through, because a restart is when an in-flight message may have been
  // lost before it reached a turn.
  const a2aDeliveryDedupe = new DeliveryDedupe();

  // Phase 999.117 WS-4 — remembers which Discord message rendered which A2A
  // delivery, so an acknowledgment can be a REACTION on the original rather
  // than a separate post. Prod was emitting ~51 standalone receipt messages a
  // week, roughly one per real message; a checkmark on the message being
  // acknowledged says the same thing without a line of channel noise. Bounded
  // and in-memory: losing the mapping on restart costs a decoration, never a
  // message.
  const a2aPresentations = new PresentationRegistry();

  // Late-bound like botDirectSenderRef: the Discord client does not exist yet
  // at this point in boot, and a pre-bridge ack must degrade to text rather
  // than throw.
  const a2aReactionSenderRef: {
    current:
      | { react(channelId: string, messageId: string, emoji: string): Promise<void> }
      | null;
  } = { current: null };

  const a2aLoopGovernor = new LoopGovernor({
    config: a2aGovernorConfig,
    now: () => Date.now(),
    onBreakerOpen: (event) => {
      // Fires ONCE per wedge, not once per suppressed message — a wedged
      // pair should produce one alert the operator can act on, not a flood
      // that buries the signal (the MemoryGuard noise lesson).
      log.warn(
        {
          from: event.from,
          to: event.to,
          conversationId: event.conversationId,
          rule: event.rule,
          reopensAt: new Date(event.reopensAt).toISOString(),
        },
        `[999.117] a2a loop breaker OPEN — ${event.detail}`,
      );
    },
  });
  log.info(
    {
      mode: a2aGovernorConfig.mode,
      maxHops: a2aGovernorConfig.maxHops,
      maxConsecutiveAutoReplies: a2aGovernorConfig.maxConsecutiveAutoReplies,
      conversationCap: a2aGovernorConfig.conversationCap,
    },
    "a2a loop governor initialized",
  );

  /** The bundle handed to every A2A entry path. Built once, shared. */
  const a2aServices: A2aServices = {
    governor: a2aLoopGovernor,
    dedupe: a2aDeliveryDedupe,
    presentations: a2aPresentations,
    reactionSender: {
      react: async (channelId, messageId, emoji) => {
        const sender = a2aReactionSenderRef.current;
        if (!sender) throw new Error("reaction sender not wired");
        await sender.react(channelId, messageId, emoji);
      },
    },
  };

  // Phase 117 Plan 04 T05 — inject the AdvisorBudget into SessionManager so
  // `makeAdvisorObserver(agent)` returns a real observer (and the SDK
  // adapter records `advisor_message` iterations + emits advisor events
  // for the Discord bridge in Plan 117-09). Setter DI mirrors the
  // existing setWebhookManager / setBotDirectSender pattern — the budget
  // is constructed AFTER SessionManager so the constructor signature
  // stays stable (15+ agent test fixtures rely on that shape).
  manager.setAdvisorBudget(advisorBudget);

  // Phase 117 Plan 04 T05 — also thread the daemon-wide advisor defaults
  // block so `buildSessionConfig.shouldEnableAdvisor` resolves the
  // backend + model via the same fall-through path the rest of the
  // daemon uses (per-agent → defaults → baseline). config.defaults is
  // populated by zod with the schema defaults (backend: "native", model:
  // "opus") so even fleets that omit the block entirely get the gate
  // semantics right.
  manager.setAdvisorDefaults({ advisor: config.defaults.advisor });

  // Phase 117 Plan 07 T01 — compose `AdvisorService` at daemon boot.
  //
  // Registry holds both backends: `LegacyForkAdvisor` (operator rollback
  // path; agents with `advisor.backend: fork` route here) and
  // `AnthropicSdkAdvisor` (native marker — its `consult()` throws by
  // design, see backend file header §spike). `PortableForkAdvisor`
  // intentionally NOT registered — scaffold only per Plan 117-05.
  //
  // The service closes over `config.defaults.advisor` via the
  // `resolveBackend` / `resolveAdvisorModel` deps so the IPC handler
  // (Plan 117-07 T02) can call `advisorService.ask({agent, question})`
  // with no extra config plumbing. Budget + truncation + recordCall
  // ownership lives in `DefaultAdvisorService.ask` (Plan 117-02 T06),
  // removing the duplication that used to live inline in the
  // `ask-advisor` IPC handler.
  //
  // NOTE on memoryContext: the pre-117-07 inline handler retrieved top-5
  // semantic memories and threaded them into `buildAdvisorSystemPrompt`.
  // The provider-neutral `AdvisorServiceDeps.resolveSystemPrompt` is
  // synchronous (`(agent) => string`) so memory context injection drops
  // here as a deliberate parity loss for the rollback path. Native
  // agents have memory MCP tools in-session; fork-backend agents retain
  // `clawcode_memory_search` / `memory_lookup` MCP tools as an
  // equivalent surface. Widening the service surface to re-thread
  // memory belongs to a follow-up phase, not 117-07.
  const advisorRegistry = new BackendRegistry();
  advisorRegistry.register(new LegacyForkAdvisor(manager));
  advisorRegistry.register(new AnthropicSdkAdvisor());
  // Loader resolvers accept structural types — `cfg as unknown as ...`
  // mirrors the pattern in `session-config.ts:1187` since
  // `ResolvedAgentConfig` does not currently expose the `advisor?` field
  // on its type (Plan 117-06 only adds it to the raw schema, not the
  // resolved-type alias). The runtime value is read off `cfg.advisor`
  // if operator set it; otherwise the resolver falls back through
  // `config.defaults.advisor`.
  const advisorService: AdvisorService = new DefaultAdvisorService({
    budget: advisorBudget,
    resolveBackend: (agent: string) => {
      const cfg = manager.getAgentConfig(agent) as unknown as
        | { advisor?: { backend?: string } }
        | undefined;
      const id = resolveAdvisorBackend(cfg, config.defaults);
      return { backend: advisorRegistry.get(id), id };
    },
    resolveSystemPrompt: (agent: string) =>
      buildAdvisorSystemPrompt(agent, null),
    // 2026-08-27 — per-agent fork consult bound; cascades agent → defaults.
    resolveConsultTimeoutMs: (agent: string) => {
      const cfg = manager.getAgentConfig(agent) as unknown as
        | { advisor?: { forkTimeoutMs?: number } }
        | undefined;
      return cfg?.advisor?.forkTimeoutMs ?? config.defaults?.advisor?.forkTimeoutMs;
    },
    resolveAdvisorModel: (agent: string) => {
      const cfg = manager.getAgentConfig(agent) as unknown as
        | { advisor?: { model?: string } }
        | undefined;
      const raw = resolveAdvisorModelConfig(cfg, config.defaults);
      return resolveAdvisorModelAlias(raw);
    },
  });
  log.info("advisor service composed (backends: fork, native)");

  // 6-quater. Create TaskManager singleton (Phase 59 Plan 03).
  // Depends on: taskStore (6-ter), turnDispatcher (6-bis), escalationBudget (6a),
  // resolvedAgents (5a), and a SchemaRegistry loaded from ~/.clawcode/task-schemas/.
  //
  // Exposed on the daemon return value so Phase 63 observability CLIs can
  // read task state without re-entering through IPC.
  const payloadStore = new PayloadStore(taskStore.rawDb);
  const schemaRegistry = await SchemaRegistry.load();
  log.info(
    { schemas: schemaRegistry.size(), schemaNames: schemaRegistry.names() },
    "SchemaRegistry loaded",
  );

  const taskManager = new TaskManager({
    store: taskStore,
    turnDispatcher,
    schemaRegistry,
    escalationBudget,
    getAgentConfig: (name) =>
      resolvedAgents.find((c) => c.name === name) ?? null,
    storePayload: (id, p) => payloadStore.storePayload(id, p),
    getStoredPayload: (id) => payloadStore.getPayload(id),
    storeResult: (id, r) => payloadStore.storeResult(id, r),
    getStoredResult: (id) => payloadStore.getResult(id),
    log,
  });
  log.info({ schemaCount: taskManager.schemaCount }, "TaskManager initialized");

  // 6-quinquies-a. Create TaskScheduler (moved from step 8b — Phase 60).
  // TaskScheduler only needs sessionManager + turnDispatcher + log,
  // all available since step 6-bis. Moved earlier so SchedulerSource
  // can wrap it before HeartbeatRunner starts.
  // IMPORTANT: Only handler-based schedules go through TaskScheduler directly.
  // Prompt-based schedules are routed through SchedulerSource -> TriggerEngine.
  const taskScheduler = new TaskScheduler({
    sessionManager: manager,
    turnDispatcher,
    log,
  });

  // /clawcode-goal — autonomous goal loop owner. One boot instance holds at most
  // one running loop per agent. Limits are SOFT (judged); the config knobs here
  // are the runaway circuit-breaker + the judge model. All external effects are
  // injected so GoalManager stays unit-tested in isolation.
  const goalCfg = config.defaults.goal;
  const goalEvaluatorModel = goalCfg?.evaluatorModel ?? "haiku";
  const goalManager = new GoalManager({
    // Adapt the concrete bridge to GoalBridgeLike. The real push() takes a
    // narrowly-typed DaemonChannelMessage; we only ever push a valid "a2a"
    // envelope, so the cast at the boundary is safe and keeps goal-manager.ts
    // decoupled from the channel-protocol types.
    getBridge: (agent) => {
      const b = agentChannelRegistry.get(agent)?.bridge;
      return b
        ? {
            push: (msg) => b.push(msg as Parameters<typeof b.push>[0]),
            awaitReply: (id, timeoutMs) => b.awaitReply(id, timeoutMs),
            cancelPendingReplies: (reason) => b.cancelPendingReplies(reason),
          }
        : undefined;
    },
    dispatchTurn: (agent, content) => manager.dispatchTurn(agent, content),
    // Judge each turn with the configured model (Haiku by default). callModelDirect
    // never throws — returns "" on failure, which the judge reads as not-met.
    callModel: (system, user) =>
      callModelDirect(system, user, goalEvaluatorModel, { maxTokens: 400 }, "summarizer"),
    sendToChannel: async (agent, text) => {
      const channelId = routingTableRef.current.agentToChannels.get(agent)?.[0];
      const sender = botDirectSenderRef.current;
      if (!channelId || !sender) return;
      await sender.sendText(channelId, text);
    },
    newCorrelationId: () => `goal-${nanoid(10)}`,
    now: () => Date.now(),
    log: {
      info: (obj: unknown, msg?: string) => log.info(obj as object, msg),
      warn: (obj: unknown, msg?: string) => log.warn(obj as object, msg),
    },
    config: {
      backstopMaxTurns: goalCfg?.backstopMaxTurns ?? 100,
      backstopDeadlineMs: (goalCfg?.backstopMinutes ?? 60) * 60_000,
      turnTimeoutMs: goalCfg?.turnTimeoutMs ?? 600_000,
    },
  });

  for (const agentConfig of resolvedAgents) {
    const handlerSchedules: ScheduleEntry[] = [];

    // Inject consolidation schedule if enabled (Phase 46) — handler-based.
    // Spread defaults so a PARTIAL consolidation block (e.g. prod's
    // `defaults.memory.consolidation: { weeklyThreshold: 1 }`) still resolves
    // `enabled: true` + a `schedule`. Before 2026-06-18 the `?? {...}` fallback
    // only applied when consolidation was entirely ABSENT, so a partial
    // override left `enabled` undefined and `if (consolidationConfig.enabled)`
    // SILENTLY skipped registration — consolidation never ran fleet-wide (no
    // digests / no consolidation-runs.jsonl ever) even though the log filter
    // below counted the agent as enabled (`enabled !== false`). The spread
    // aligns both checks: an explicit `enabled: false` still disables; a
    // partial/absent block defaults to enabled.
    // Per-field `?? default`: the schema TYPES these as required, but a
    // partial YAML block (`{ weeklyThreshold: 1 }`) leaves the others
    // undefined at RUNTIME. `?? true` defaults a missing `enabled` to on;
    // an explicit `enabled: false` (not nullish) still disables.
    // Cascade: per-agent override → fleet `defaults.memory.consolidation` →
    // hardcoded floor. Agents override `memory` WHOLESALE (loader `??`), so a
    // per-agent memory block without an explicit consolidation value loses the
    // operator's `defaults.memory.consolidation` (e.g. `weeklyThreshold: 1`).
    // Falling back through `consolidationDft` restores that intent instead of
    // silently snapping to the hardcoded 7.
    const consolidationCfg = agentConfig.memory?.consolidation;
    const consolidationDft = config.defaults.memory?.consolidation;
    const consolidationConfig = {
      enabled: consolidationCfg?.enabled ?? consolidationDft?.enabled ?? true,
      weeklyThreshold:
        consolidationCfg?.weeklyThreshold ??
        consolidationDft?.weeklyThreshold ??
        7,
      monthlyThreshold:
        consolidationCfg?.monthlyThreshold ??
        consolidationDft?.monthlyThreshold ??
        4,
      schedule:
        consolidationCfg?.schedule ?? consolidationDft?.schedule ?? "0 3 * * *",
    };
    if (consolidationConfig.enabled) {
      const embedder = manager.getEmbedder();
      // Phase 75 SHARED-01 — memoryPath (not workspace) so consolidation
      // writes weekly/monthly digests into the per-agent memory dir.
      const memoryDir = join(agentConfig.memoryPath, "memory");

      handlerSchedules.push({
        name: "memory-consolidation",
        cron: consolidationConfig.schedule ?? "0 3 * * *",
        enabled: true,
        handler: async () => {
          // Phase 999.113 WS-3 (2026-08-28) — resolve the MemoryStore at FIRE
          // time, not at registration time. This block runs during daemon boot,
          // but per-agent MemoryStores are not created until `startAgent` runs
          // `initMemory` (same ordering Phase 90 MEM-02 documents for the
          // memory scanners, which solved it with a lazy proxy). The previous
          // `const memoryStore = manager.getMemoryStore(...)` above captured
          // `undefined` for every agent and the guard below returned silently
          // on every 03:00 tick — forever, and without leaving a run-log row.
          // Prod evidence: consolidation-runs.jsonl held 4 rows, all from a
          // single manual trigger on 2026-06-19, and nothing in the 71 days
          // since despite the cron being registered and the daemon being alive
          // across 03:00 on many of those nights.
          const memoryStore = manager.getMemoryStore(agentConfig.name);
          if (!memoryStore) {
            // Never fail silently again — a missing store at fire time is now
            // an operator-visible condition rather than an invisible no-op.
            log.warn(
              { agent: agentConfig.name, schedule: "memory-consolidation" },
              "consolidation skipped — no MemoryStore for agent at fire time",
            );
            return;
          }
          const deps = {
            memoryDir,
            memoryStore,
            embedder,
            summarize: (prompt: string) => summarizeWithHaiku(prompt, {}),
            // Phase 115 sub-scope 13(b) — agent label threaded into the
            // consolidation run-log so operators can correlate JSONL rows
            // back to the specific agent's consolidation cycle.
            runLabel: agentConfig.name,
          };
          // Phase 999.113 WS-3 — entry/exit logging. runConsolidation's only
          // durable trace was the run-log JSONL, so "did consolidation run?"
          // required reading a file under ~clawcode. A starved run (0 digests,
          // completes in ~3ms) is now distinguishable from one that never fired.
          log.info(
            { agent: agentConfig.name, memoryDir },
            "consolidation run starting",
          );
          const result = await runConsolidation(deps, consolidationConfig);
          log.info(
            {
              agent: agentConfig.name,
              weeklyDigestsCreated: result.weeklyDigestsCreated,
              monthlyDigestsCreated: result.monthlyDigestsCreated,
              filesArchived: result.filesArchived,
              errorCount: result.errors.length,
            },
            "consolidation run complete",
          );
        },
      });
    }

    // Only add handler-based schedules to TaskScheduler (those with a handler).
    // User-defined yaml schedules are prompt-based (ScheduleEntryConfig has no
    // `handler` field). The cast covers a future case where dynamically-injected
    // schedules carry a handler at runtime — today this filter is a no-op for
    // config-sourced entries, by design.
    for (const schedule of agentConfig.schedules as readonly ScheduleEntry[]) {
      if (schedule.enabled && schedule.handler) {
        handlerSchedules.push(schedule);
      }
    }

    if (handlerSchedules.length > 0) {
      taskScheduler.addAgent(agentConfig.name, handlerSchedules);
    }
  }
  log.info({ agents: resolvedAgents.filter(a => a.schedules.length > 0 || a.memory?.consolidation?.enabled !== false).length }, "task scheduler initialized (handler-based schedules)");

  // 6-quinquies-a2. Create mysql2 pool for MysqlSource (Phase 61 TRIG-02).
  // Pool is daemon-level — shared across all MysqlSource instances.
  // Created only if mysql trigger sources are configured. Pool size 2 per CONTEXT.md.
  let mysqlPool: Pool | null = null;
  const mysqlConfigs = config.triggers?.sources?.mysql ?? [];
  if (mysqlConfigs.length > 0) {
    const mysqlHost = process.env.MYSQL_HOST;
    const mysqlUser = process.env.MYSQL_USER;
    const mysqlPassword = process.env.MYSQL_PASSWORD;
    const mysqlDatabase = process.env.MYSQL_DATABASE;

    if (mysqlHost && mysqlUser && mysqlDatabase) {
      mysqlPool = createPool({
        host: mysqlHost,
        user: mysqlUser,
        password: mysqlPassword,
        database: mysqlDatabase,
        connectionLimit: 2,
        waitForConnections: true,
        enableKeepAlive: true,
      });
      log.info({ host: mysqlHost, database: mysqlDatabase }, "mysql2 pool created for trigger sources");
    } else {
      log.warn("MySQL trigger sources configured but MYSQL_HOST/MYSQL_USER/MYSQL_DATABASE env vars missing — skipping");
    }
  }

  // 6-quinquies-b. Create TriggerEngine singleton (Phase 60).
  // Depends on: turnDispatcher (6-bis), taskStore (6-ter), taskScheduler (6-quinquies-a).
  // The engine owns all non-Discord turn initiation. SchedulerSource is
  // the first registered source — replaces the direct TurnDispatcher path
  // that TaskScheduler previously used for prompt-based schedules.
  const configuredAgentNames = new Set(resolvedAgents.map(a => a.name));

  // 6-quinquies-b-pre. Boot-time policy load (Phase 62 POL-01).
  // Read .clawcode/policies.yaml BEFORE TriggerEngine construction.
  // Invalid policy = daemon refuses to start. Missing file = empty rules.
  const policyPath = join(homedir(), ".clawcode", "policies.yaml");
  const policyAuditPath = join(MANAGER_DIR, "policy-audit.jsonl");
  let bootEvaluator: PolicyEvaluator | undefined;
  try {
    const policyContent = await readFile(policyPath, "utf-8");
    const compiledRules = loadPolicies(policyContent);
    bootEvaluator = new PolicyEvaluator(compiledRules, configuredAgentNames);
    log.info({ path: policyPath, ruleCount: compiledRules.length }, "policies.yaml loaded at boot");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // No policy file — fall through to TriggerEngine's existing default-allow
      // function-form (evaluatePolicy) by leaving bootEvaluator undefined.
      // The engine ternary at engine.ts:130-132 selects evaluatePolicy() when
      // this.evaluator is undefined, which allows any event whose targetAgent
      // is in configuredAgents (Phase 105 POLICY-01..03).
      // PolicyWatcher.onReload still wires reloadEvaluator(real) once the
      // operator drops a policies.yaml at policyPath — back-compat preserved.
      bootEvaluator = undefined;
      log.info(
        { policyPath },
        "no policies.yaml found — using default-allow evaluator: any configured agent can receive events. Drop a policies.yaml at this path to enable rule-based filtering.",
      );
    } else if (err instanceof PolicyValidationError) {
      // Invalid policy — daemon must refuse to start (POL-01)
      throw new ManagerError(
        `FATAL: policies.yaml invalid -- daemon cannot start: ${err.message}`,
      );
    } else {
      throw err;
    }
  }

  // Phase 100 follow-up — deliveryFn for trigger-fired output.
  //
  // The bug: pre-fix, TriggerEngine.ingest() awaited dispatch() and threw
  // away the response string. Scheduled cron output (e.g. fin-client's
  // 15-min status check) was generated by the agent but never reached
  // Discord — it stayed in the conversation history and got dragged into
  // the next user-msg-driven reply, producing wrong-slot attribution.
  //
  // The closure routes the response to the agent's bound Discord channel,
  // preferring the per-agent webhook (so the message wears the agent's
  // identity) and falling back to bot-direct text. References WebhookManager
  // and BotDirectSender via mutable refs because both are constructed AFTER
  // TriggerEngine — by the time any cron tick fires, both refs are populated.
  // 999.178 R1 — one rate limiter for the whole daemon so a flapping schedule
  // can't spam Admin Clawdy. In-memory: a restart resets the window (acceptable
  // — a post right after restart is fine).
  const deadLetterLimiter = new DeadLetterRateLimiter();
  const triggerDeliveryFn: TriggerDeliveryFn = async (
    targetAgent,
    response,
    context,
  ) => {
    const cfg = manager.getAgentConfig(targetAgent);
    if (!cfg) {
      log.warn(
        { targetAgent },
        "trigger-delivery: unknown agent — skipping",
      );
      return;
    }
    const channelId = cfg.channels?.[0];
    if (!channelId) {
      log.warn(
        { targetAgent },
        "trigger-delivery: agent has no bound channel — skipping",
      );
      return;
    }
    // 999.178 R1 — scheduled output is agent-authored: resolve its
    // `:cc_name:` icon shortcodes before delivery (unknown names strip
    // cleanly). Client drafts extracted below are stripped of icons.
    response = rewriteIconShortcodes(response, icons);
    const wm = webhookManagerRef.current;
    const hasWebhook = !!(wm && wm.hasWebhook(targetAgent));
    const bot = botDirectSenderRef.current;
    if (!hasWebhook && !bot) {
      log.warn(
        { targetAgent, channelId },
        "trigger-delivery: no sender available (no webhook + no bot-direct) — skipping",
      );
      return;
    }

    // 999.178 R1 — scheduled output is CHUNKED (never truncated), a client-facing
    // ```draft block is posted as its own copy-paste-clean message, and a failed
    // post is retried then dead-lettered to the operator. The planning + retry +
    // dead-letter logic is the pure, unit-tested `deliverScheduledOutput`; this
    // closure is just the daemon-edge wiring. The engine advanced the watermark
    // BEFORE delivery ON PURPOSE — a failed tick must not be re-dispatched (that
    // re-runs the agent turn at full cost), so durability lives in the
    // dead-letter, not a watermark rewind.
    const label = context?.label ?? "scheduled";
    await deliverScheduledOutput(response, targetAgent, label, {
      hasWebhook,
      sendWebhook: (text) => wm!.send(targetAgent, text),
      sendBotDirect: (chunk) => bot!.sendText(channelId, chunk),
      deadLetter: async (msg) => {
        // Rate-limit per (agent, schedule): a flapping schedule accrues a
        // "+N more failures" summary instead of one Admin Clawdy post per tick.
        const gated = deadLetterLimiter.gate(targetAgent, label, msg);
        if (gated === null) {
          log.info(
            { targetAgent, label },
            "trigger-delivery: dead-letter suppressed (rate-limited; counted for the next post)",
          );
          return;
        }
        const sink = postToAdminRef.current;
        if (sink) {
          await sink(gated).catch((err: unknown) =>
            log.error(
              { targetAgent, label, err: err instanceof Error ? err.message : String(err) },
              "trigger-delivery: dead-letter to operator FAILED — scheduled output lost",
            ),
          );
        } else {
          log.error(
            { targetAgent, label },
            "trigger-delivery: no operator sink wired — scheduled output lost (dead-letter dropped)",
          );
        }
      },
      onAttemptError: ({ postIndex, postCount, attempt, error }) =>
        log.warn(
          { targetAgent, label, post: postIndex + 1, of: postCount, attempt, error },
          "trigger-delivery: post attempt failed — retrying",
        ),
    });
  };

  const triggerEngine = new TriggerEngine(
    {
      turnDispatcher,
      taskStore,
      log,
      config: {
        replayMaxAgeMs: config.triggers?.replayMaxAgeMs ?? DEFAULT_REPLAY_MAX_AGE_MS,
        dedupLruSize: DEFAULT_DEDUP_LRU_SIZE,
        defaultDebounceMs: config.triggers?.defaultDebounceMs ?? DEFAULT_DEBOUNCE_MS,
      },
      deliveryFn: triggerDeliveryFn,
    },
    configuredAgentNames,
    bootEvaluator,
  );

  // Register SchedulerSource adapter for prompt-based cron schedules.
  // Phase 999.99 follow-up — durable store for runtime recurring schedules
  // (agent `schedule_recurring`). Sibling of the other ~/.clawcode/manager
  // stores; honors CLAWCODE_MANAGER_DIR via MANAGER_DIR.
  const recurringScheduleStore = new RecurringScheduleStore({
    filePath: join(MANAGER_DIR, "recurring-schedules.json"),
    log,
  });
  const schedulerSource = new SchedulerSource({
    resolvedAgents,
    sessionManager: manager,
    turnDispatcher,
    ingest: (event) => triggerEngine.ingest(event),
    log,
    recurringStore: recurringScheduleStore,
  });
  triggerEngine.registerSource(schedulerSource);

  // --- Phase 61: Register additional trigger sources (6-quinquies-c) ---

  // TRIG-02: MySQL DB-change sources
  if (mysqlPool) {
    for (const cfg of mysqlConfigs) {
      const mysqlSource = new MysqlSource({
        pool: mysqlPool,
        table: cfg.table,
        idColumn: cfg.idColumn,
        pollIntervalMs: cfg.pollIntervalMs,
        targetAgent: cfg.targetAgent,
        batchSize: cfg.batchSize,
        filter: cfg.filter,
        ingest: (event) => triggerEngine.ingest(event),
        log,
      });
      triggerEngine.registerSource(mysqlSource);
    }
  }

  // TRIG-03: Webhook source (single source, multiple trigger configs)
  const webhookConfigs = config.triggers?.sources?.webhook ?? [];
  let webhookSource: WebhookSource | null = null;
  if (webhookConfigs.length > 0) {
    webhookSource = new WebhookSource({
      configs: webhookConfigs,
      ingest: (event) => triggerEngine.ingest(event),
      log,
    });
    triggerEngine.registerSource(webhookSource);
  }

  // Quick 260520-r70 — construct the SHARED agent-to-agent ack-emitter
  // ONCE. The SAME instance is passed to every InboxSource below AND wired
  // into the heartbeat reconciler (heartbeatRunner.setInboxAckEmitter,
  // further down) so both inbox consumers fire the ack from a single hook
  // point — no bifurcation. The `deliverAck` closure routes the ack
  // through the EXISTING `handlePostToAgentIpc` cascade with kind: "ack"
  // (no 4th delivery path). webhookManager / botDirectSender / routing
  // table are read via late-bound refs because this emitter is built
  // before those slots are populated; the closure only runs at
  // message-consume time, long after boot.
  const inboxAckEmitter: InboxAckEmitter = createInboxAckEmitter({
    fleetAgentNames: new Set(resolvedAgents.map((a) => a.name)),
    now: () => Date.now(),
    log: {
      info: (...args: unknown[]) => log.info(args[0] as object, args[1] as string),
      warn: (...args: unknown[]) => log.warn(args[0] as object, args[1] as string),
      error: (...args: unknown[]) => log.error(args[0] as object, args[1] as string),
    },
    deliverAck: async (req) => {
      const { handlePostToAgentIpc } = await import(
        "./daemon-post-to-agent-ipc.js"
      );
      const wm = webhookManagerRef.current;
      if (!wm) {
        // Pre-bridge boot window — webhook manager not yet assigned. The
        // ack can't route; report degraded so the emitter resolves
        // cleanly (fire-and-forget contract).
        return { ok: false, delivered: false };
      }
      const res = await handlePostToAgentIpc(
        {
          from: req.from,
          to: req.to,
          message: req.message,
          kind: req.kind,
          causationId: req.causationId,
        },
        {
          runningAgents: manager.getRunningAgents(),
          configs: resolvedAgents,
          agentChannels: routingTableRef.current.agentToChannels,
          webhookManager: wm,
          // Phase 999.117 WS-4 — same registry + reaction sender, so an ack
          // lands as a checkmark on the message it acknowledges.
          presentations: a2aPresentations,
          reactionSender: {
            react: async (channelId, messageId, emoji) => {
              const sender = a2aReactionSenderRef.current;
              if (!sender) throw new Error("reaction sender not wired");
              await sender.react(channelId, messageId, emoji);
            },
          },
          writeInbox: async (p) => {
            const targetConfig = resolvedAgents.find((c) => c.name === p.to);
            if (!targetConfig) {
              throw new ManagerError(`Target agent '${p.to}' not found`);
            }
            const inboxDir = join(targetConfig.memoryPath, "inbox");
            // Forward p.kind so the ack persists with kind: "ack" —
            // closing the loop (a future consume of the ack is a no-op).
            const inboxMsg = createMessage(
              p.from,
              p.to,
              p.content,
              "normal",
              p.kind,
            );
            await writeMessage(inboxDir, inboxMsg);
            return { messageId: inboxMsg.id };
          },
          log: {
            info: (...args: unknown[]) => console.info(...args),
            warn: (...args: unknown[]) => console.warn(...args),
            error: (...args: unknown[]) => console.error(...args),
          },
          botDirectSender: {
            sendText: async (channelId: string, text: string) => {
              const sender = botDirectSenderRef.current;
              if (!sender) return;
              await sender.sendText(channelId, text);
            },
          },
          // Phase 140 #14b — route a2a acks to a v3 target via the channel too
          // (uniform with the post-to-agent path; no v2/v3 ack bifurcation).
          getBridge: (agent) => agentChannelRegistry.get(agent)?.bridge,
        },
      );
      return { ok: res.ok, delivered: res.delivered };
    },
  });

  // TRIG-04: Inbox sources (one per agent with inbox trigger config)
  const inboxConfigs = config.triggers?.sources?.inbox ?? [];
  for (const cfg of inboxConfigs) {
    const agentConfig = resolvedAgents.find(a => a.name === cfg.targetAgent);
    if (!agentConfig) {
      log.warn({ targetAgent: cfg.targetAgent }, "inbox trigger configured for unknown agent — skipping");
      continue;
    }
    // Phase 75 SHARED-01 — memoryPath (not workspace) so InboxSource
    // watches only this agent's inbox in the shared-workspace case.
    const inboxDir = join(agentConfig.memoryPath, "inbox");
    const inboxSource = new InboxSource({
      agentName: cfg.targetAgent,
      inboxDir,
      stabilityThresholdMs: cfg.stabilityThresholdMs,
      targetAgent: cfg.targetAgent,
      ingest: (event) => triggerEngine.ingest(event),
      log,
      // Quick 260520-r70 — shared ack-emitter (same instance the
      // heartbeat reconciler receives via setInboxAckEmitter).
      ackEmitter: inboxAckEmitter,
      // Phase 999.117 WS-2 — the SAME dedupe instance the heartbeat
      // reconciler and the Discord relay hold.
      dedupe: a2aDeliveryDedupe,
    });
    triggerEngine.registerSource(inboxSource);
  }

  // Demote heartbeat inbox check to reconciler mode when InboxSource is primary
  if (inboxConfigs.length > 0) {
    const { setInboxSourceActive } = await import("../heartbeat/checks/inbox.js");
    setInboxSourceActive(true);
    log.info("heartbeat inbox check demoted to reconciler mode (InboxSource is primary)");
  }

  // TRIG-05: Calendar sources
  const calendarConfigs = config.triggers?.sources?.calendar ?? [];
  for (const cfg of calendarConfigs) {
    const mcpServerConfig = config.mcpServers?.[cfg.mcpServer];
    if (!mcpServerConfig) {
      log.warn({ mcpServer: cfg.mcpServer }, "calendar trigger references unknown MCP server — skipping");
      continue;
    }
    const calendarSource = new CalendarSource({
      user: cfg.user,
      targetAgent: cfg.targetAgent,
      calendarId: cfg.calendarId,
      pollIntervalMs: cfg.pollIntervalMs,
      offsetMs: cfg.offsetMs,
      maxResults: cfg.maxResults,
      eventRetentionDays: cfg.eventRetentionDays,
      mcpServer: {
        command: mcpServerConfig.command,
        args: mcpServerConfig.args,
        env: mcpServerConfig.env as Record<string, string> | undefined,
      },
      taskStore,
      ingest: (event) => triggerEngine.ingest(event),
      log,
    });
    triggerEngine.registerSource(calendarSource);
  }

  // Replay missed events from last watermarks (TRIG-06).
  // Runs SYNCHRONOUSLY before agent startAll so missed triggers
  // fire before new cron ticks begin.
  // Safety net: replay must NEVER crash boot. It runs before startAll, so a
  // missed trigger targeting a not-yet-started agent would otherwise throw
  // `Agent '<name>' is not running` and exit the process (the per-event guard
  // in replayMissed handles this, but a source.poll() failure must not either).
  try {
    await triggerEngine.replayMissed();
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "trigger-engine: replayMissed failed (non-fatal) — continuing boot",
    );
  }

  // Start all trigger sources (fires cron jobs).
  triggerEngine.startAll();

  // Phase 999.99 follow-up — re-register DURABLE agent-created recurring
  // schedules AFTER startAll (which registers the yaml `schedules:`), so an
  // agent's `schedule_recurring` survives a daemon restart. Crash-proof by
  // construction (per-entry guarded; never rejects) → can't block boot.
  // Forward-only resume — restored schedules live outside `scheduleEntries`, so
  // replayMissed/poll never back-fires their missed ticks.
  await schedulerSource.restoreFromStore(
    new Set(resolvedAgents.map((a) => a.name)),
  );

  log.info(
    { sources: triggerEngine.registry.size },
    "TriggerEngine initialized with sources",
  );

  // 6-quinquies-d. Start PolicyWatcher for hot-reload (Phase 62 POL-03).
  // The watcher uses the same policyPath from boot. On valid reload, it
  // swaps the TriggerEngine's evaluator atomically. Invalid reloads are
  // logged and keep the old policy.
  const policyWatcher = new PolicyWatcher({
    policyPath,
    auditPath: policyAuditPath,
    onReload: (newEvaluator, diff) => {
      triggerEngine.reloadEvaluator(newEvaluator);
      log.info(
        { added: diff.added.length, removed: diff.removed.length, modified: diff.modified.length },
        "policy hot-reloaded — TriggerEngine evaluator swapped",
      );
    },
    onError: (error) => {
      log.warn({ error: error.message }, "policy reload failed — keeping previous policy");
    },
    log,
    configuredAgents: configuredAgentNames,
  });
  // start() is safe here — we already validated at boot, so this will NOT
  // throw for invalid content. It re-reads the file and starts chokidar.
  await policyWatcher.start();
  log.info({ policyPath, auditPath: policyAuditPath }, "policy watcher started");

  // 6b. Wire skills catalog into session manager for prompt injection
  manager.setSkillsCatalog(skillsCatalog);

  // Phase 130 Plan 02 — wire the per-agent refused-skill map. Plan 03's
  // CLI (`clawcode skills <agent>`) reads `manager.getUnloadedSkills(name)`
  // to render the per-skill status table.
  manager.setUnloadedSkillsByAgent(unloadedSkillsByAgent);

  // Phase 132 Plan 02 — wire the task.completed event emitter + Haiku
  // distiller deps. ONE DistillerDeps + ONE emitterDeps closure shared by
  // both daemon call sites (subagent-complete + delegate-task) per the
  // single-source-of-truth invariant (feedback_silent_path_bifurcation).
  // The dispatcher is fire-and-forget (D-01); the daemon NEVER awaits it.
  // Phase 132-fu3 — resolve via the live ResolvedAgentConfig so that
  // shared-workspace agents (e.g. fin-client lives at agents/acme/,
  // not agents/fin-client/) write their skill drafts into the correct
  // workspace. Falls back to the hardcoded `~/.clawcode/agents/<agent>` path
  // when the agent is unknown (degradation-safe — never throws inside this
  // resolver). `manager.getAgentConfig(agentName)` returns the same
  // ResolvedAgentConfig that SessionManager hands to the SDK at spawn, so
  // the workspace path stays in sync with the running session.
  const phase132AgentWorkspaceDir = (agentName: string): string => {
    const cfg = manager.getAgentConfig(agentName);
    return cfg?.workspace ?? join(homedir(), ".clawcode", "agents", agentName);
  };
  const phase132CallHaiku: CallHaikuFn = async (
    model,
    systemPrompt,
    userPrompt,
    opts,
  ) => {
    // The default Haiku path uses callHaikuDirect (model is hardcoded
    // there). Sonnet escalation would require a parameterized client;
    // for v1 we delegate to callHaikuDirect for the haiku case and
    // log a warning otherwise. This keeps the OAuth-token flow intact
    // while satisfying the D-02 grep-verifiable literal in the worker.
    if (model !== "claude-haiku-4-5") {
      log.warn(
        { component: "phase132-distiller", requestedModel: model },
        "phase132-distiller: non-haiku model requested — falling back to Haiku for OAuth-bound call",
      );
    }
    // Phase 999.58 C7 — site tag for phase999.58-haiku-direct telemetry
    // attribution. phase132-distiller is the 4th consumer (alongside
    // summarizer, vision-pre-pass, dream-pass).
    const text = await callHaikuDirect(
      systemPrompt,
      userPrompt,
      {
        signal: opts.signal,
        maxTokens: opts.maxTokens ?? 4096,
      },
      "skill-distiller",
    );
    return { text };
  };
  const phase132DistillerDeps = {
    callHaiku: phase132CallHaiku,
    resolveModelId,
    log: log.child({ component: "phase132-distiller" }),
    agentWorkspaceDir: phase132AgentWorkspaceDir,
    now: () => new Date(),
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  };
  // Phase 999.42 Plan 07 — patch-suggest DI bundle. Reuses the SAME
  // phase132CallHaiku seam + the shared-workspace-aware resolver verbatim.
  // SuggestPatchDeps is a superset of FindActiveSkillDeps, so this single
  // object satisfies both shouldRouteToPatch and suggestPatch.
  const phase99942PatchSuggestDeps = {
    callHaiku: phase132CallHaiku,
    resolveModelId,
    log: log.child({ component: "phase999.42-skill-patch-suggest" }),
    agentWorkspaceDir: phase132AgentWorkspaceDir,
    now: () => new Date(),
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  };
  phase132EmitterDepsRef = {
    log: log.child({ component: "phase132-task-event" }),
    getAgentConfig: (agentName: string) => {
      const cfg = manager.getAgentConfig(agentName);
      if (!cfg) return undefined;
      const sd = (cfg as { skillDistiller?: { minToolCalls: number; minDurationMs: number; outcomeFilter: readonly ("success" | "partial" | "failed")[]; distillerModel?: "haiku" | "sonnet" } }).skillDistiller;
      const autonomousSkillDrafting = (cfg as { autonomousSkillDrafting?: boolean }).autonomousSkillDrafting;
      return {
        name: cfg.name,
        autonomousSkillDrafting,
        skillDistiller: sd,
      };
    },
    dispatchDistiller: async (event) => {
      // Look up config inside the dispatcher to obtain the resolved
      // SkillDistillerConfig. Emitter already ran the gate; the distiller
      // needs the actual config block to pass through. This fresh
      // getAgentConfig call IS the reloadable-field closure-re-read — a
      // `suggestPatches` yaml flip is picked up here without a restart.
      const cfg = manager.getAgentConfig(event.agent);
      const sd = (cfg as { skillDistiller?: { minToolCalls: number; minDurationMs: number; outcomeFilter: readonly ("success" | "partial" | "failed")[]; distillerModel?: "haiku" | "sonnet"; suggestPatches?: boolean } } | undefined)?.skillDistiller;
      const enabled = (cfg as { autonomousSkillDrafting?: boolean } | undefined)?.autonomousSkillDrafting === true;
      if (!sd) return;

      // Phase 999.42 Plan 07 — capability C patch-suggest branch. ONE
      // discriminating branch at THIS single dispatch site (the Phase 132
      // fu2 dispatch closure). When suggestPatches is true AND the
      // trajectory fingerprint matches an active skill the distiller
      // already created, route to PATCH-SUGGEST instead of producing a
      // duplicate create-draft. When suggestPatches is false (default),
      // shouldRouteToPatch returns null WITHOUT scanning skills/ — the
      // dispatch is byte-identical to Phase 132. Wrapped in its own
      // try/catch so a transient fs error in the active-skill scan never
      // destabilizes the out-of-band dispatch (D-01 fire-and-forget).
      try {
        const active = await shouldRouteToPatch(
          event,
          sd.suggestPatches === true,
          phase99942PatchSuggestDeps,
        );
        if (active) {
          const result = await suggestPatch(
            event,
            active,
            phase99942PatchSuggestDeps,
          );
          if (result.status === "suggested") {
            const bridge = discordBridgeRef.current;
            if (bridge) {
              // Single patch-embed posting site — reuse the Plan 06
              // buildSkillPatchEmbed + the single-bridge postSkillPatchEmbed
              // helper (no parallel Discord posting path).
              const embed = buildSkillPatchEmbed(result.record);
              void postSkillPatchEmbed(bridge, event.agent, embed).catch(
                (err: unknown) => {
                  log.error(
                    {
                      agent: event.agent,
                      patchId: result.record.patchId,
                      err: err instanceof Error ? err.message : String(err),
                    },
                    "phase999.42 patch-suggest embed post failed",
                  );
                },
              );
            }
          }
          // Patch path taken — do NOT also run the create-draft path.
          return;
        }
      } catch (err) {
        // Defensive: shouldRouteToPatch already swallows scan errors, but
        // suggestPatch's atomic write or the embed build could throw. Log
        // + swallow so the create-draft fallthrough is never reached after
        // a partial patch attempt and the emitter is never destabilized.
        log.error(
          {
            agent: event.agent,
            err: err instanceof Error ? err.message : String(err),
          },
          "phase999.42 patch-suggest threw unexpectedly",
        );
        return;
      }

      // Phase 132 Plan 03 T-03 — single embed-post site (silent-path-
      // bifurcation invariant: exactly one postSkillDraftEmbed call-site
      // in daemon.ts). When the distiller resolves status:"staged", build
      // a DraftStagedRecord from the event + the distiller result and
      // fire-and-forget post the locked-shape embed to the agent's
      // channel. Other statuses (rejected/skipped/errored) already log
      // phase132-skill-draft in Plan 02 and need no embed surface.
      // The embed post is awaited inside postSkillDraftEmbed which swallows
      // bridge failures (returns null) — we re-wrap in .catch to keep the
      // distiller-side D-01 out-of-band invariant (no propagation).
      return distillSkillDraft(
        event,
        {
          enabled,
          minToolCalls: sd.minToolCalls,
          minDurationMs: sd.minDurationMs,
          outcomeFilter: sd.outcomeFilter,
          distillerModel: sd.distillerModel,
        },
        phase132DistillerDeps,
      )
        .then((result) => {
          if (result.status !== "staged") return;
          const bridge = discordBridgeRef.current;
          if (!bridge) return;
          const record: DraftStagedRecord = {
            draftId: basename(result.draftPath, ".md"),
            slug: result.manifest.name,
            agent: event.agent,
            sessionId: event.sessionId,
            trajectoryFingerprint: result.fingerprint,
            stepCount: result.stepCount,
            manifest: result.manifest,
            draftPath: result.draftPath,
          };
          const embed = buildSkillDraftEmbed(record);
          void postSkillDraftEmbed(bridge, event.agent, embed).catch(
            (err: unknown) => {
              log.error(
                {
                  agent: event.agent,
                  draftId: record.draftId,
                  err: err instanceof Error ? err.message : String(err),
                },
                "phase132 staged-embed post failed",
              );
            },
          );
        })
        .catch((err: unknown) => {
          // Defensive observability — distillSkillDraft logs phase132-skill-
          // draft at every documented exit branch, but an unexpected throw
          // (disk full mid-atomic-write, callHaiku throwing on the rejected
          // network path, etc.) would otherwise vanish into the
          // fire-and-forget void. Log + swallow so D-01 fire-and-forget
          // invariant holds at the dispatcher boundary while operators still
          // see disasters in journalctl.
          log.error(
            {
              agent: event.agent,
              err: err instanceof Error ? err.message : String(err),
            },
            "phase132 distillSkillDraft threw unexpectedly",
          );
        });
    },
    now: () => Date.now(),
  };

  // Phase 132 Plan 03 T-03 — bind the late-bound holder so routeMethod's
  // three new IPC case branches (approve-skill-draft / reject-skill-draft /
  // edit-skill-draft) can resolve the per-agent workspace dir + log child.
  phase132DraftActionDepsRef = {
    log: log.child({ component: "phase132-skill-action" }),
    agentWorkspaceDir: phase132AgentWorkspaceDir,
  };

  // Phase 999.42 Plan 06 — bind the skill-PATCH-action holder so routeMethod's
  // three patch IPC case branches (list-skill-patches / apply-skill-patch /
  // reject-skill-patch) can resolve the per-agent workspace dir + log child.
  // Reuses phase132AgentWorkspaceDir verbatim (shared-workspace-aware) — the
  // patch lifecycle lives in the same agent workspace as the create-draft
  // lifecycle. PatchActionDeps shape == DraftActionDeps shape.
  phase99942PatchActionDepsRef = {
    log: log.child({ component: "phase999.42-skill-patch-action" }),
    agentWorkspaceDir: phase132AgentWorkspaceDir,
  };

  // Phase 90 MEM-02 — build a lazy MemoryStore proxy. Scanners are
  // constructed at boot but the per-agent MemoryStore doesn't exist until
  // startAgent runs initMemory. The proxy returned here defers every
  // method lookup to the provider function so a scanner event that fires
  // before the store initializes simply no-ops (returns null / {} /
  // empty-string as appropriate).
  const scannerExtraRoots = (
    workspacePath: string,
    agentCfg: { workspace: string; memoryPath?: string; memoryAutoLoadPath?: string },
  ): readonly string[] => {
    const roots = resolveMemoryRoots(agentCfg);
    return isWithinDir(join(workspacePath, "memory"), roots.memoryDir) ? [] : [roots.memoryDir];
  };
  const makeLazyMemoryStoreProxy = (
    provider: () => unknown,
  ): MemoryScannerDeps["store"] => {
    return new Proxy({} as never, {
      get(_t, prop: string) {
        const s = provider() as Record<string, unknown> | undefined;
        if (!s) {
          if (prop === "getMemoryFileSha256") return () => null;
          if (prop === "deleteMemoryChunksByPath") return () => 0;
          return () => "";
        }
        return typeof s[prop] === "function" ? (s[prop] as (...a: unknown[]) => unknown).bind(s) : s[prop];
      },
    }) as unknown as MemoryScannerDeps["store"];
  };

  // 6b-bis. Phase 90 MEM-02 — per-agent MemoryScanner DI. Constructs a
  // chokidar watcher on {workspace}/memory/**/*.md for each agent whose
  // resolved config has memoryScannerEnabled=true (the default). The
  // scanner maintains memory_chunks + vec_memory_chunks + memory_chunks_fts
  // + memory_files tables live — both on boot (via backfill) and on
  // subsequent file events.
  //
  // Wire-order: BETWEEN setSkillsCatalog and setAllAgentConfigs so the
  // scanners are ready before reconcileRegistry spins up sessions (which
  // immediately drive warm-path and may invoke memory retrieval). Per-
  // agent MemoryStore instances are initialized inside SessionManager
  // startAgent so the backfill runs lazily on first turn — boot stays
  // fast even when there are thousands of indexed memory files.
  for (const agent of resolvedAgents) {
    if (agent.memoryScannerEnabled === false) continue;
    const workspacePath = agent.workspace;
    if (!workspacePath) continue;
    // Resolve the per-agent MemoryStore lazily — SessionManager.startAgent
    // initializes memory.memoryStores AFTER this loop runs, so a fresh
    // scanner call at boot returns a wrapper that defers the lookup until
    // each chokidar event fires. When the store doesn't exist yet (agent
    // not started), the wrapper no-ops cleanly so early file events don't
    // crash.
    const storeProvider = () =>
      (manager as unknown as {
        memory: { memoryStores: Map<string, unknown> };
      }).memory.memoryStores.get(agent.name);
    const scanner = new MemoryScanner(
      {
        store: makeLazyMemoryStoreProxy(storeProvider),
        embed: (text: string) =>
          (manager as unknown as {
            memory: { embedder: { embed: (t: string) => Promise<Float32Array> } };
          }).memory.embedder.embed(text),
        log: log.child({ scanner: agent.name }),
      },
      workspacePath,
      // Phase 999.187 — when `memoryPath` puts the agent's dated memory files
      // outside `<workspace>/memory`, watch + backfill that dir as well so
      // cues, flushes and daily logs written there are indexed.
      scannerExtraRoots(workspacePath, agent),
    );
    manager.setMemoryScanner(agent.name, scanner);
    // Fire-and-forget: chokidar watches the directory even if it doesn't
    // exist yet (creates on first event). Scanner start failures are
    // non-fatal — MEM-01 stable-prefix auto-load still carries standing rules.
    void scanner.start().catch((err) => {
      log.warn(
        { agent: agent.name, error: (err as Error).message },
        "memory-scanner start failed (non-fatal)",
      );
    });
  }

  // 6c. Wire agent configs into session manager for admin prompt injection
  manager.setAllAgentConfigs(resolvedAgents);

  // 7. Reconcile registry per D-10
  await manager.reconcileRegistry(resolvedAgents);

  // 8. Initialize heartbeat runner
  // Phase 999.12 HB-01 — thread defaults.heartbeatInboxTimeoutMs into the
  // HeartbeatConfig so the inbox check gets its 60s default instead of the
  // fleet-wide 10s checkTimeoutSeconds (which false-positive-criticals
  // during normal cross-agent turns).
  const heartbeatConfig: HeartbeatConfig = {
    ...config.defaults.heartbeat,
    ...(config.defaults.heartbeatInboxTimeoutMs !== undefined
      ? { inboxTimeoutMs: config.defaults.heartbeatInboxTimeoutMs }
      : {}),
  };
  // Phase 124 Plan 04 T-01 — single source of truth for last-compaction
  // timestamps. Constructed BEFORE the heartbeat runner so the runner can
  // be wired with the trigger closure in Plan 04 T-02. Both the manual
  // IPC path (case "compact-session") and the heartbeat auto-trigger path
  // record into this same log on `ok:true`, so the cooldown gate sees a
  // unified view regardless of which path fired the compaction.
  const compactionEventLog = new CompactionEventLog();
  // Phase 999.122 — status-transition journal. Survives a restart (last 48 h
  // in `heartbeat-transitions.jsonl`) and is surfaced by `heartbeat-status`
  // as `incidents`, so /api/health and `clawcode health` show what fired
  // overnight, not only the current state.
  // Phase 999.131 — owner-scoped shared facts: one fleet store keyed by
  // owner, written by `memory_save({ scope: "owner" })`, read at retrieval
  // by every agent with the same owner (never across owners).
  const sharedFactsStore = new SharedFactsStore(join(MANAGER_DIR, SHARED_FACTS_DB_FILE));
  manager.setSharedFactsStore(sharedFactsStore);
  log.info({ path: join(MANAGER_DIR, SHARED_FACTS_DB_FILE) }, "shared-facts store opened");
  const heartbeatTransitionJournal = new HeartbeatTransitionJournal({
    persistPath: join(MANAGER_DIR, "heartbeat-transitions.jsonl"),
    onError: (err) =>
      log.warn({ error: err.message }, "heartbeat transition journal persistence failed"),
  });
  const heartbeatRunner = new HeartbeatRunner({
    sessionManager: manager,
    registryPath: REGISTRY_PATH,
    config: heartbeatConfig,
    checksDir: join(import.meta.dirname, "../heartbeat/checks"),
    log,
    transitionJournal: heartbeatTransitionJournal,
    snapshotCallback: async (agentName: string, zone: ContextZone, fillPercentage: number) => {
      const pct = Math.round(fillPercentage * 100);
      const summaryMessage = `Auto-snapshot at ${pct}% context fill [${zone} zone]`;
      try {
        await manager.saveContextSummary(agentName, summaryMessage);
        log.info({ agent: agentName, zone, fillPercentage }, "zone snapshot saved");
      } catch (err) {
        log.warn({ agent: agentName, error: (err as Error).message }, "zone snapshot save failed");
      }
    },
    notificationCallback: async (agentName: string, transition: ZoneTransition) => {
      const pct = Math.round(transition.fillPercentage * 100);
      log.info(
        { agent: agentName, from: transition.from, to: transition.to, fillPercentage: pct },
        `[Context Health] Agent '${agentName}' zone: ${transition.from} -> ${transition.to} (${pct}%)`,
      );
      // Deliver zone transition alerts to the agent's Discord channel
      const agentConfig = resolvedAgents.find(a => a.name === agentName);
      const channelId = agentConfig?.channels[0];
      if (channelId) {
        const emoji = transition.to === "red" ? "🔴" : transition.to === "yellow" ? "🟡" : "🟢";
        deliveryQueue.enqueue(
          agentName,
          channelId,
          `${emoji} **Context Health** — zone changed: ${transition.from} → ${transition.to} (${pct}% filled)`,
        );
      }
    },
  });
  await heartbeatRunner.initialize();
  heartbeatRunner.setAgentConfigs(resolvedAgents);
  // Phase 124 Plan 04 T-02 — wire the auto-trigger closure + cooldown
  // lookup BEFORE the first tick so threshold-cross fires immediately on
  // the first heartbeat cycle that observes it. The closure shares the
  // same handler the manual IPC path uses (handleCompactSession), so
  // both paths converge on identical compaction semantics. Errors are
  // logged but never propagated — the heartbeat tick must not block on
  // compaction.
  heartbeatRunner.setGetLastCompactionAt((a) =>
    compactionEventLog.getLastCompactionAt(a),
  );
  // Quick 260520-r70 — wire the SAME ack-emitter instance the InboxSource
  // consumers hold into the heartbeat reconciler check. Single hook point:
  // both inbox consumers fire the agent-to-agent ack through this exact
  // closure (no bifurcation).
  heartbeatRunner.setInboxAckEmitter(inboxAckEmitter);
  // Phase 999.117 WS-2 — same shared dedupe, so the reconciler sweep cannot
  // re-deliver what the watcher (or the webhook relay) already delivered.
  heartbeatRunner.setDeliveryDedupe(a2aDeliveryDedupe);
  heartbeatRunner.setCompactSessionTrigger(async (agent: string) => {
    try {
      const { handleCompactSession } = await import(
        "./daemon-compact-session-ipc.js"
      );
      // Phase 138 Plan 04 T-03 — resolve the SDK through the per-agent
      // runtime resolver instead of the direct free-function loader.
      // The local `sdk` reference continues to expose
      // `sdk.forkSession(id, opts)` because `LlmRuntimeSdkModule`
      // widens `SdkModule` with the forkSession method declaration.
      // `getLlmRuntime` is in lexical scope here (heartbeat closure
      // captured at daemon-boot construction time).
      const sdk = await getLlmRuntime(agent).loadSdkModule();
      // Phase 125 Plan 02 — D-01 single extractor seam. Tier 1 partition
      // runs here (full ConversationTurn[] visible); preserved turns ride
      // through the extractor head so they end up in the fork-summary
      // verbatim. The getConversationTurns lambda below is unchanged —
      // the daily-log audit trail still receives ALL turns.
      const { buildTieredExtractor, partitionForVerbatim } = await import(
        "./compact-extractors/index.js"
      );
      const cfgForAgent = resolvedAgents.find((a) => a.name === agent);
      const preserveLastTurnsAuto = cfgForAgent?.preserveLastTurns ?? 10;
      const preserveVerbatimAuto = cfgForAgent?.preserveVerbatimPatterns ?? [];
      const allTurnsAuto = (() => {
        const sid = manager.getActiveConversationSessionId(agent);
        const store = manager.getConversationStore(agent);
        if (!sid || !store) return [];
        return store
          .getTurnsForSession(sid)
          .filter((t) => t.role !== "system")
          .map((t) => ({
            timestamp: t.createdAt,
            role: t.role as "user" | "assistant",
            content: t.content,
          }));
      })();
      const partitionDepsAuto = {
        preserveLastTurns: preserveLastTurnsAuto,
        preserveVerbatimPatterns: preserveVerbatimAuto,
        clock: () => new Date(),
        log,
        agentName: agent,
      };
      const { preserved: preservedAuto } = partitionForVerbatim(
        allTurnsAuto,
        partitionDepsAuto,
      );
      // Phase 125 Plan 03 — Tier 2 Haiku-driven structured extraction.
      // Reuses summarizeWithHaiku (the same OAuth-Bearer Haiku path that
      // session-summarizer uses in production — D-03). The onTier2Facts
      // callback re-runs the active-state builder WITH the LLM-grounded
      // facts and overwrites ~/.clawcode/agents/<agent>/state/active-state.yaml
      // so SC-4's operator-inspectable file reflects the latest extraction.
      const onTier2FactsAuto = async (facts: import("./compact-extractors/types.js").Tier2Facts): Promise<void> => {
        try {
          const { buildActiveStateBlock } = await import(
            "./active-state/builder.js"
          );
          const { writeActiveStateYaml } = await import(
            "./active-state/yaml-writer.js"
          );
          const fsPromises = await import("node:fs/promises");
          const operatorMsgs = allTurnsAuto
            .filter((t) => t.role === "user")
            .slice(-5)
            .map((t) => t.content);
          // Note: builder accepts ConversationTurn from memory/conversation-types.
          // Compaction turns are a structural subset (timestamp/role/content);
          // builder reads only role/content/createdAt and tolerates absent
          // fields via the heuristic regexes.
          const block = buildActiveStateBlock({
            recentOperatorMessages: operatorMsgs,
            recentAgentTurns: allTurnsAuto as unknown as readonly import("../memory/conversation-types.js").ConversationTurn[],
            agentName: agent,
            clock: () => new Date(),
            tier2Facts: facts,
          });
          await writeActiveStateYaml(agent, block, {
            baseDir: activeStateBaseDir,
            fs: fsPromises,
            clock: () => new Date(),
          });
        } catch (err) {
          log.warn(
            { agent, error: (err as Error).message },
            "[125-03-tier2-haiku] onTier2Facts (auto) failed (non-fatal)",
          );
        }
      };
      const baseExtractMemories = buildTieredExtractor({
        ...partitionDepsAuto,
        preservedTurns: preservedAuto,
        tier2Summarize: (prompt, opts) => summarizeWithHaiku(prompt, opts),
        onTier2Facts: onTier2FactsAuto,
      });
      // Phase 999.75 Part A (A4) — feed the extractor the tool-aware SDK
      // transcript (tool blocks verbatim) instead of the final-text-only
      // ConversationStore text. The closure substitutes the text the
      // extractor sees; `getConversationTurns` below is UNCHANGED so the
      // daily-log flush still receives ConversationStore turns (Fork A).
      // Fail-open: `loadCompactionTurns` → null → the base extractor runs
      // on the ConversationStore text exactly as before. Byte-identical to
      // the manual IPC call site (anti-bifurcation).
      const toolAwareTextAuto = await loadCompactionTurns({
        agentName: agent,
        manager,
        sdk,
        config: cfgForAgent,
        log,
      });
      const extractMemories =
        toolAwareTextAuto !== null
          ? (_text: string): Promise<readonly string[]> =>
              baseExtractMemories(toolAwareTextAuto)
          : baseExtractMemories;
      // Phase 124 follow-up — same producer-side wire as the manual IPC
      // path. The auto-trigger fires from the heartbeat cycle and uses the
      // same safety-budget gate so an in-flight long turn does not stall
      // the heartbeat task. Both sites read getTurnStartedAt — divergence
      // would let one path skip the gate.
      const turnStartedAtAuto = (() => {
        const ts = manager.getTurnStartedAt(agent);
        return ts !== null ? new Map([[agent, ts]]) : new Map<string, number>();
      })();
      // Phase 999.75 Part B — `CompactSessionDeps` (the `manager` projection
      // + the handle-backed `sendCompactCommand` / `getContextUsage` seams)
      // is assembled by the shared `buildCompactSessionDeps` helper so this
      // call site stays byte-identical to the manual IPC site below
      // (anti-bifurcation — same precedent as Part A's `loadCompactionTurns`).
      const { buildCompactSessionDeps } = await import(
        "./build-compact-session-deps.js"
      );
      const autoResult = await handleCompactSession(
        { agent },
        buildCompactSessionDeps({
          agent,
          manager,
          extractMemories,
          log,
          turnStartedAt: turnStartedAtAuto,
        }),
      );
      if (autoResult.ok === true) {
        compactionEventLog.record(agent);
        compactionEventLog.recordTokens(agent, {
          tokensBefore: autoResult.tokens_before,
          tokensAfter: autoResult.tokens_after,
          liveReduced: autoResult.live_reduced,
          ...(autoResult.skip_reason !== undefined
            ? { skipReason: autoResult.skip_reason }
            : {}),
        });
        log.info(
          {
            agent,
            tokens_before: autoResult.tokens_before,
            tokens_after: autoResult.tokens_after,
            live_reduced: autoResult.live_reduced,
            skip_reason: autoResult.skip_reason,
          },
          "[124-04-auto-trigger] compaction complete",
        );
      } else {
        log.warn(
          { agent, error: autoResult.error },
          "[124-04-auto-trigger] compaction failed",
        );
      }
    } catch (err) {
      // Never let an auto-trigger failure propagate to the heartbeat tick.
      log.warn(
        { agent, error: (err as Error).message },
        "[124-04-auto-trigger] dispatch threw",
      );
    }
  });
  // Phase 125 Plan 01 — wire the active-state builder/writer into the
  // heartbeat tick. Closure pulls last-N operator messages + assistant
  // turns from the per-agent ConversationStore, builds the block via the
  // pure builder, persists YAML to ~/.clawcode/agents/<agent>/state/, and
  // returns the rendered header for the runner's lastProbeText cache.
  // Sentinel `[125-01-active-state]` is logged once per agent per process
  // so journalctl -g '\[125-01-active-state\]' proves the wiring runs.
  const activeStateSentinelFired = new Set<string>();
  const activeStateBaseDir = join(homedir(), ".clawcode", "agents");
  heartbeatRunner.setActiveStateProvider(async (agent: string) => {
    try {
      const { buildActiveStateBlock } = await import(
        "./active-state/builder.js"
      );
      const {
        writeActiveStateYaml,
        renderActiveStateForPrompt,
      } = await import("./active-state/yaml-writer.js");
      const fsPromises = await import("node:fs/promises");
      const sid = manager.getActiveConversationSessionId(agent);
      const store = manager.getConversationStore(agent);
      const turns =
        sid && store
          ? store
              .getTurnsForSession(sid)
              .filter((t) => t.role !== "system")
          : [];
      const operatorMsgs = turns
        .filter((t) => t.role === "user")
        .slice(-5)
        .map((t) => t.content);
      const block = buildActiveStateBlock({
        recentOperatorMessages: operatorMsgs,
        recentAgentTurns: turns,
        agentName: agent,
        clock: () => new Date(),
      });
      await writeActiveStateYaml(agent, block, {
        baseDir: activeStateBaseDir,
        fs: fsPromises,
        clock: () => new Date(),
      });
      if (!activeStateSentinelFired.has(agent)) {
        activeStateSentinelFired.add(agent);
        log.info(
          { agent },
          "[125-01-active-state] active-state header dispatched for first tick",
        );
      }
      return renderActiveStateForPrompt(block);
    } catch (err) {
      log.warn(
        { agent, error: (err as Error).message },
        "[125-01-active-state] builder/writer failed",
      );
      return null;
    }
  });
  heartbeatRunner.start();
  log.info({ checks: "discovered", interval: heartbeatConfig.intervalSeconds }, "heartbeat started");

  // 8b. (Moved to step 6-quinquies-a — Phase 60)

  // Phase 999.36 sub-bug D — one-time migration of pre-Phase entries.
  // Backfills lastDeliveryAt = lastActivity for bindings that pre-date
  // the new gate. Idempotent: re-running on already-migrated bindings
  // is a no-op. Runs BEFORE ThreadManager creation so any subsequent
  // session-attach / sweep reads a registry where every binding has a
  // lastDeliveryAt sentinel.
  // REMOVE AFTER 999.36+1 milestone closes — bindings will be naturally
  // migrated by then.
  try {
    const migration = await migrateBindingsForPhase999_36(THREAD_REGISTRY_PATH);
    log.info(
      { migrated: migration.migrated, total: migration.total },
      "phase 999.36 thread-binding migration complete",
    );
  } catch (err) {
    log.warn(
      { error: (err as Error).message },
      "phase 999.36 thread-binding migration failed (gate may refuse pre-existing bindings)",
    );
  }

  // 8c. Create ThreadManager for Discord thread session lifecycle
  const threadManager = new ThreadManager({
    sessionManager: manager,
    routingTable,
    registryPath: THREAD_REGISTRY_PATH,
    log,
  });
  heartbeatRunner.setThreadManager(threadManager);
  heartbeatRunner.setTaskStore(taskStore);
  // Phase 104 plan 03 (SEC-05) — give the heartbeat checks (specifically
  // mcp-reconnect's RecoveryDeps factory) access to the secrets cache so
  // the op-refresh recovery handler can call deps.invalidate(ref) before
  // re-reading via op CLI. Without this hook, opRead — which is wired
  // through SecretsResolver in production — would serve the same stale
  // value that triggered the original auth-error.
  heartbeatRunner.setSecretsResolver(secretsResolver);
  // Phase 108 (POOL-07) — broker-status provider for the mcp-broker
  // heartbeat check. Adapter is intentionally narrow — only
  // getPoolStatus() — to enforce the rate-limit-budget invariant
  // (no synthetic password_read against 1Password).
  heartbeatRunner.setBrokerStatusProvider({
    getPoolStatus: () => broker.getPoolStatus(),
  });
  // Phase 103 OBS-01 — wire HeartbeatRunner into SessionManager so
  // /clawcode-status can read context-zone fillPercentage synchronously.
  manager.setHeartbeatRunner(heartbeatRunner);
  log.info("thread manager initialized");

  // 8d. Build manual webhook identities (from config webhookUrl fields)
  const manualWebhookIdentities = buildWebhookIdentities(resolvedAgents);
  let webhookManager: WebhookManager;
  log.info({ manualWebhooks: manualWebhookIdentities.size }, "manual webhook identities loaded");

  // Phase 138 Plan 03 T-03 — forward declaration. The ThresholdAlerter is
  // constructed later (after WebhookManager converges) but the IPC
  // `handler` closure below captures it lexically; by IPC-request time it
  // is always assigned. Same forward-declaration shape as `webhookManager`.
  let thresholdAlerter: import("../usage/threshold-alerter.js").ThresholdAlerter;

  // 8e. Initialize security: approval log, allowlist matchers, security policies
  const approvalLog = new ApprovalLog({
    filePath: join(MANAGER_DIR, "approval-audit.jsonl"),
    log,
  });

  const allowlistMatchers = new Map<string, AllowlistMatcher>();
  for (const agent of resolvedAgents) {
    if (agent.security?.allowlist && agent.security.allowlist.length > 0) {
      const staticPatterns = agent.security.allowlist.map(e => e.pattern);
      const matcher = new AllowlistMatcher(staticPatterns);
      // Load persisted allow-always patterns
      const alwaysPatterns = approvalLog.loadAllowAlways(agent.name);
      for (const p of alwaysPatterns) {
        matcher.addAllowAlways(p);
      }
      allowlistMatchers.set(agent.name, matcher);
    }
  }
  log.info({ agents: allowlistMatchers.size }, "allowlist matchers initialized");

  const securityPolicies = new Map<string, SecurityPolicy>();
  for (const agent of resolvedAgents) {
    try {
      const acls = await parseSecurityMd(join(agent.workspace, "SECURITY.md"));
      if (acls.length > 0) {
        securityPolicies.set(agent.name, {
          allowlist: agent.security?.allowlist ?? [],
          channelAcls: acls,
        });
      }
    } catch {
      // No SECURITY.md or parse error — skip
    }
  }
  log.info({ agents: securityPolicies.size }, "security policies loaded");

  // 9. Await embedding warmup before accepting IPC requests
  await manager.warmupEmbeddings();

  // 9b. Phase 56 Plan 01 — embedder warmup probe. HARD FAIL on error:
  //     memory_lookup without a working embedding pipeline is a broken
  //     surface, not a degraded one (see 56-CONTEXT — Embedding Model
  //     Residency). Refusing to start the IPC server here prevents the
  //     daemon from accepting queries it cannot fulfil.
  try {
    await manager.getEmbedder().embed("warmup probe");
    log.info("embedder probe succeeded");
  } catch (err) {
    const msg = (err as Error).message;
    log.error(
      { error: msg },
      "embedder probe failed — daemon startup HARD FAIL",
    );
    throw new ManagerError(
      `embedder probe failed: ${msg} — daemon cannot start without a working embedding pipeline`,
    );
  }

  // 9c. Phase 70 — browser automation MCP.
  //
  // Instantiate the shared BrowserManager singleton and (when warmOnBoot
  // is true) launch the resident Chromium process + run its built-in
  // health probe. HARD FAIL on probe failure, mirroring the embedder
  // probe above — a broken browser pipeline surfaces immediately rather
  // than degrading the first tool call on a running agent. The install
  // hint is carried through from BrowserManager.warm() so the operator
  // sees the exact npx command to run.
  // Phase 101 Plan 02 T03/T04 — wire the D-08 Mistral OCR gate from
  // `defaults.documentIngest.allowMistralOcr`. Read at call time via the
  // closure so a `clawcode reload` (which mutates `config` in place) takes
  // effect without a daemon bounce. Defaults to `false` when the block is
  // omitted entirely from `clawcode.yaml`.
  setAllowMistralOcr(
    () => config.defaults.documentIngest?.allowMistralOcr ?? false,
  );

  // Phase 101 Plan 04 (D-04, U9, SC-10) — wire the bge-reranker-base
  // config from `defaults.documentIngest.reranker`. Same call-time
  // closure pattern as `setAllowMistralOcr` above so a `clawcode reload`
  // takes effect on the next retrieval turn without a daemon bounce.
  // Resolver returns `undefined` when the block is absent (back-compat
  // for pre-101-04 configs); `retrieveMemoryChunks` treats that as
  // "rerank disabled".
  //
  // Emergency env override: `CLAWCODE_RERANKER_ENABLED=false` short-circuits
  // the YAML setting to force-disable on the next turn. This is the
  // emergency knob — unlike the `clawcode reload` YAML path it doesn't
  // require daemon-liveness, so an operator can disable mid-incident via
  // systemd env without a config edit. Mirrors operator preference for
  // flippable rollback paths (Phase 110 shimRuntime, Phase 117 advisor
  // backend). Read at call-time so a systemd-reload-env takes effect on
  // the next retrieval turn.
  manager.setRerankerConfigResolver(() =>
    applyRerankerEnvOverride(config.defaults.documentIngest?.reranker),
  );

  // Quick-260521-437 — wire the per-turn retrieval-tuning knobs from
  // `defaults.documentIngest.retrieval`. Same call-time closure pattern as
  // `setRerankerConfigResolver` above so a `clawcode reload` (which mutates
  // `config` in place) takes effect on the next retrieval turn without a
  // daemon bounce. Resolver returns `undefined` when the block is absent;
  // `getMemoryRetrieverForAgent` then falls back to the schema defaults
  // (2-day recency window, 2-chunk document cap) so the bloat fix is
  // active even for configs that don't declare the block.
  manager.setDocumentIngestRetrievalResolver(
    () => config.defaults.documentIngest?.retrieval,
  );

  // Phase 101 Plan 04 — warm the Xenova/bge-reranker-base ONNX session
  // on daemon boot so the first operator turn doesn't pay the cold-load
  // cost (~3-5s on warm cache, up to ~30s on first-ever download). Fire-
  // and-forget per the plan's "non-blocking warmup" directive — a failed
  // warm logs a warn and the retrieval path falls back lazily on the
  // first turn (covered by the 500ms timeout fallback).
  if (
    process.env.CLAWCODE_RERANKER_ENABLED !== "false" &&
    config.defaults.documentIngest?.reranker?.enabled !== false
  ) {
    void warmupReranker().catch((err) => {
      logger.warn(
        { err, phase: "phase101-ingest", event: "reranker-warmup-failed" },
        "phase101 reranker warmup failed — retrieval will load lazily on first turn",
      );
    });
  }

  // Phase 101 Plan 02 T05 — wire the U7 ingest-alerts surface. Logger
  // is the shared daemon logger. `postToAdminClawdy` uses the existing
  // webhookManagerRef (same closure pattern as triggerDeliveryFn at
  // line 3112) so a stall before WebhookManager wiring lands a pino
  // log only — never crashes on a null reference.
  //
  // Phase 999.98 D10 — EXTRACTED to a named const so the model-monitor cron
  // surfaces new-tier / pin-bump proposals through the SAME
  // webhook→bot-direct→pino path (instead of an ad-hoc webhook call).
  //
  // INC-2026-08-08 — THIS LEG WAS DEAD IN PRODUCTION. Two bugs, one symptom:
  //   (1) both lookups keyed the literal "admin-clawdy", but the live agent in
  //       /etc/clawcode/clawcode.yaml is named "Admin Clawdy" — so hasWebhook()
  //       missed AND the resolved-config lookup missed; and
  //   (2) the bot-direct branch never called sendText at all — it logged
  //       "missing channel id" and returned, even though the channel id was
  //       available from the routing table the whole time.
  // Net effect: every alert from document-ingest, MemoryGuard and the
  // model-monitor has been a pino line nobody reads. The cascade now lives in
  // admin-alert-target.ts (pure + unit-tested) and this closure is just the
  // daemon-edge wiring. The target is resolved PER ALERT (not memoized) so a
  // `clawcode reload` that rebinds the admin channel is picked up without a
  // daemon bounce.
  const adminAlertTarget = (): AdminAlertTarget =>
    resolveAdminAlertTarget({
      agents: resolvedAgents,
      agentToChannels: routingTableRef.current.agentToChannels,
      // Operator escape hatch — re-point alerts mid-incident with a systemd
      // env edit, no YAML change (mirrors CLAWCODE_RERANKER_ENABLED).
      envChannelId: process.env.CLAWCODE_ADMIN_ALERT_CHANNEL_ID,
      fallbackChannelId: ADMIN_CLAWDY_CHANNEL_ID,
    });
  const postToAdminClawdy = async (msg: string): Promise<void> => {
    // deliverAdminAlert NEVER throws — a failing alert must not take down a
    // MemoryGuard tick or a cron onTick.
    await deliverAdminAlert(msg, {
      webhook: webhookManagerRef.current,
      botDirect: botDirectSenderRef.current,
      target: adminAlertTarget(),
      log: logger,
    });
  };
  // 999.178 R1 — publish the sink for the scheduled-delivery dead-letter
  // (defined far above triggerDeliveryFn; wired here via the late-bound ref).
  postToAdminRef.current = postToAdminClawdy;
  setIngestAlertDeps({ logger, postToAdminClawdy });

  // 999.147 — the tier-A sink. Same delivery ladder as postToAdminClawdy, plus
  // a 🩹 relief button attached as a follow-up edit on the WEBHOOK leg (the
  // only leg that can carry components). The CLI equivalent is appended to the
  // TEXT, so a bot-direct or pino fallback still leaves the operator able to
  // act — a page whose only remediation is an invisible button would be worse
  // than the plain text it replaced.
  const postMemoryPage = async (page: MemoryPage): Promise<void> => {
    const offender = page.offender;
    // `fattestAnonProc` EXCLUDES the daemon pid by construction, so when the
    // daemon's own V8 heap is the problem the "top consumer" is an unrelated
    // process. Offering to kill it would be inviting the operator to do
    // something that cannot help and might hurt.
    const offerWouldHelp = page.key !== "daemon:heap";
    const canOffer =
      offerWouldHelp &&
      offender !== undefined &&
      offender.startTicks !== undefined &&
      offender.startTicks > 0 &&
      offender.pid !== process.pid &&
      worthOffering(offender.anonSwapMb);
    if (!canOffer) {
      await deliverAdminAlert(page.message, {
        webhook: webhookManagerRef.current,
        botDirect: botDirectSenderRef.current,
        target: adminAlertTarget(),
        log: logger,
      });
      return;
    }
    const offer = {
      pid: offender.pid,
      comm: offender.comm,
      anonSwapMb: offender.anonSwapMb,
      startTicks: offender.startTicks as number,
      issuedAtMs: Date.now(),
    };
    await deliverAdminAlert(
      `${page.message}${reliefMessageSuffix(offer)}`,
      {
        webhook: webhookManagerRef.current,
        botDirect: botDirectSenderRef.current,
        target: adminAlertTarget(),
        log: logger,
      },
      { components: [buildReliefRow(offer)] },
    );
  };

  // Relief deps are resolved lazily per click: the cgroup membership read must
  // be fresh (time has passed since the page), and the audit sink is created
  // once. Fails CLOSED everywhere — see memory-relief.ts.
  const reliefAudit = makeReliefAudit(DEFAULT_RELIEF_AUDIT_PATH);
  const reliefInCgroup = makeCgroupMembership(resolveOwnCgroupDir());
  const memoryReliefDeps: () => ReliefDeps = () => ({
    readProc: readReliefProc,
    inCgroup: reliefInCgroup,
    kill: (pid) => {
      process.kill(pid, "SIGKILL");
    },
    daemonPid: process.pid,
    now: () => Date.now(),
    log: logger,
    audit: reliefAudit,
  });
  setReliefDepsFactory(memoryReliefDeps);

  // 999.147 WS-3 — Unraid memory watch. OFF unless the operator enables it:
  // it opens an SSH hop to another box, which is not something to start by
  // default. Pages carry a 🔄 button that restarts ONE named container and
  // nothing else — never the array, VMs, parity, or caches.
  type UnraidCfg = NonNullable<typeof config.defaults.unraidWatch>;
  const unraidCfg = (): Partial<UnraidCfg> =>
    config.defaults.unraidWatch ?? {};
  const unraidSsh = makeUnraidSsh(
    unraidCfg().sshTarget ?? "root@10.0.0.1",
  );
  const unraidAudit = makeReliefAudit(DEFAULT_UNRAID_AUDIT_PATH);
  const containerReliefDeps: () => ContainerRestartDeps = () => ({
    ssh: unraidSsh,
    log: logger,
    audit: async (row) => {
      // Map onto the shared audit row's vocabulary WITHOUT losing the
      // distinction: an attempted restart that errored is not the same event
      // as one that was refused before it ran, and in a security trail that
      // difference is a fact, not a rounding.
      const outcome =
        row.outcome === "restarted"
          ? "killed"
          : row.outcome === "failed"
            ? "kill-failed"
            : "refused";
      await unraidAudit({
        at: row.at,
        pid: -1,
        comm: row.container,
        anonSwapMb: null,
        actor: row.actor,
        outcome,
        detail: `unraid container ${row.outcome}: ${row.detail}`,
      });
    },
    now: () => Date.now(),
  });
  const unraidWatch = new UnraidWatch({
    log: log.child({ component: "unraid-watch" }),
    ssh: unraidSsh,
    resolveConfig: unraidCfg,
    postPage: async (page) => {
      const c = page.container;
      const prefix =
        page.severity === "critical" ? "🚨 **Unraid CRITICAL**" : "⚠️ Unraid";
      // Same rule as the fleet page: the button is a bonus the webhook leg
      // may carry; the text always says what to run instead.
      const text = c
        ? `${prefix}: ${page.message}${containerReliefSuffix(c.name, c.memMb)}`
        : `${prefix}: ${page.message}`;
      await deliverAdminAlert(
        text,
        {
          webhook: webhookManagerRef.current,
          botDirect: botDirectSenderRef.current,
          target: adminAlertTarget(),
          log: logger,
        },
        c
          ? {
              components: [
                buildContainerReliefRow(c.name, c.memMb, Date.now()),
              ],
            }
          : undefined,
      );
    },
  });
  unraidWatch.start();

  // 2026-07-31 — MemoryGuard: alert-only cgroup memory census + budget
  // watchdog (src/manager/memory-guard.ts). Reuses postToAdminClawdy
  // (webhook → bot-direct → pino) for tiered ⚠️/🚨 alerts. Config
  // resolver reads `config` live (reload mutates it in place) so
  // `defaults.memoryGuard.*` knobs apply on the next sample without a
  // bounce. The interval is unref()'d — the guard can never hold a
  // wedged shutdown open (stuck-shutdown incident class).
  const memoryGuard = new MemoryGuard({
    log: log.child({ component: "memory-guard" }),
    postToAdminClawdy,
    // 999.147 — tier-A pages go here so they can carry the relief button;
    // digests and the pre-999.147 fallback keep using postToAdminClawdy.
    postPage: postMemoryPage,
    resolveConfig: () => config.defaults.memoryGuard,
    daemonPid: process.pid,
    // P1 (1a) — registry-membership census: the live claude-pid set (with
    // session names, so the census splits agent vs worker kinds). Bridge
    // pids stay empty until the P3 bridge governor registers them.
    getManagedPids: () => ({
      managed: manager.listClaudePids(),
      // P3 — bridge one-shot children now registered by the bridge spawn
      // governor → census `bridge-cli` class gets real data.
      bridge: getBridgeChildPids(),
    }),
    // 999.106 G-2 — publish the gate-tighten signal each census tick (the
    // gates read it via memorySignalBus.get with the staleness window).
    publishMemorySignal: (signal) => memorySignalBus.publish(signal),
  });
  memoryGuard.start();

  const browserCfg = config.defaults.browser;
  const browserManager = new BrowserManager({
    headless: browserCfg.headless,
    viewport: browserCfg.viewport,
    userAgent: browserCfg.userAgent,
    log: log.child({ component: "browser" }),
  });
  if (browserCfg.enabled && browserCfg.warmOnBoot) {
    const browserT0 = Date.now();
    try {
      await browserManager.warm();
      log.info(
        { durationMs: Date.now() - browserT0 },
        "browser warm+probe succeeded",
      );
    } catch (err) {
      const browserMsg = (err as Error).message;
      log.error(
        { error: browserMsg },
        "browser warm probe failed — daemon startup HARD FAIL",
      );
      throw new ManagerError(`browser warm probe failed: ${browserMsg}`);
    }
  } else if (!browserCfg.enabled) {
    log.info(
      "browser MCP disabled (defaults.browser.enabled=false); skipping warm",
    );
  } else {
    log.info(
      "browser warmOnBoot=false; Chromium will launch lazily on first tool call",
    );
  }

  // 9d. Phase 71 — Web search MCP clients.
  //
  // Lazy API-key reads inside `.search()` keep daemon boot cheap even when
  // BRAVE_API_KEY / EXA_API_KEY are absent. No warm-path probe needed —
  // HTTP clients are ephemeral; missing keys surface as `invalid_argument`
  // on first tool call, not as daemon-boot crashes.
  //
  // Phase 110 follow-up — yaml-level `defaults.search.brave.apiKey` (and
  // .exa.apiKey) take precedence over process.env[apiKeyEnv] when set.
  // Plain strings pass through verbatim; op:// references are resolved
  // via the boot-time SecretsResolver cache (collectAllOpRefs zone 4).
  // Why: systemd EnvironmentFile=/etc/clawcode/env on prod historically
  // never carried BRAVE_API_KEY, so daemon process.env lookup failed
  // silently and every web_search call returned `invalid_argument:
  // missing Brave API key`. Routing through 1Password matches every
  // other secret in the same yaml.
  const searchCfg = config.defaults.search;
  const searchEnv = buildSearchEnv(searchCfg, secretsResolver);
  const braveClient = createBraveClient(searchCfg, searchEnv);
  const exaClient = createExaClient(searchCfg, searchEnv);
  if (searchCfg.enabled) {
    log.info(
      { backend: searchCfg.backend, maxResults: searchCfg.maxResults },
      "search MCP clients ready (lazy — no boot-time network)",
    );
  } else {
    log.info(
      "search MCP disabled (defaults.search.enabled=false); skipping",
    );
  }

  // 9e. Phase 72 — Image generation MCP clients.
  //
  // Lazy API-key reads inside each provider method keep daemon boot cheap
  // even when OPENAI_API_KEY / MINIMAX_API_KEY / FAL_API_KEY are absent.
  // No warm-path probe needed — HTTP clients are ephemeral; missing keys
  // surface as `invalid_input` on first tool call.
  const imageCfg = config.defaults.image;
  const imageProviders: Record<ImageBackend, ImageProvider> = {
    openai: createOpenAiImageClient(imageCfg),
    minimax: createMiniMaxImageClient(imageCfg),
    fal: createFalImageClient(imageCfg),
  };
  if (imageCfg.enabled) {
    log.info(
      { backend: imageCfg.backend, workspaceSubdir: imageCfg.workspaceSubdir },
      "image MCP clients ready (lazy — no boot-time network)",
    );
  } else {
    log.info(
      "image MCP disabled (defaults.image.enabled=false); skipping",
    );
  }

  // 9f. Phase 115 Plan 07 sub-scope 15 — daemon-side MCP tool-response
  // cache. Folds Phase 999.40 (now SUPERSEDED-BY-115). Singleton store
  // at ~/.clawcode/manager/tool-cache.db; intercepts search/image/
  // search-documents calls below via dispatchTool.
  //
  // When config.defaults.toolCache.enabled === false, we still allocate
  // the store but the wrapper bypasses (saves operators having to wipe
  // the DB to disable caching). Default = enabled, 100MB cap.
  const toolCacheCfg = config.defaults.toolCache;
  const toolCacheEnabled = toolCacheCfg?.enabled ?? true;
  const toolCacheMaxSizeMb = toolCacheCfg?.maxSizeMb ?? 100;
  const toolCachePolicy = toolCacheCfg?.policy ?? {};
  const toolCacheStore = new ToolCacheStore();
  if (toolCacheEnabled) {
    log.info(
      {
        path: toolCacheStore.getPath(),
        maxSizeMb: toolCacheMaxSizeMb,
        policyOverrides: Object.keys(toolCachePolicy).length,
      },
      "tool-cache ready (Phase 115 sub-scope 15)",
    );
  } else {
    log.info(
      "tool-cache disabled (defaults.toolCache.enabled=false); dispatchTool will bypass",
    );
  }

  // Periodic size-metric sampler — logs cache size every 60s to journalctl
  // so operators can grep `tool-cache-size-mb` for trend visibility. The
  // dashboard does NOT read this — it queries `toolCacheStore.sizeMb()`
  // directly via the `case "cache"` IPC intercept (see ~line 3360 below)
  // so the surfaced size is fresh without a heartbeat dependency.
  const toolCacheSizeReporter = setInterval(() => {
    if (!toolCacheEnabled) return;
    try {
      const sizeMb = toolCacheStore.sizeMb();
      log.debug(
        {
          sizeMb: Math.round(sizeMb * 100) / 100,
          action: "tool-cache-size-mb",
        },
        "[diag] tool-cache size metric",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      log.warn(
        { err: msg, action: "tool-cache-size-report-failed" },
        "[diag] tool-cache size sampling failed (non-fatal)",
      );
    }
  }, 60_000);

  // 10. Create IPC handler. Phase 69 intercepts `openai-key-*` methods
  // BEFORE routeMethod so we can delegate to the already-opened ApiKeysStore
  // owned by the OpenAiEndpointHandle below (no double-open, no extra
  // positional arg on routeMethod). openAiEndpointRef is a closure over the
  // `let` declared later in this function so the CLI can reach the store
  // immediately after startOpenAiEndpoint returns.
  //
  // Phase 70 piggybacks on the same closure pattern: `browser-tool-call`
  // is handled BEFORE routeMethod so the new path stays off the existing
  // 24-arg routeMethod signature. handleBrowserToolCall is a pure-ish
  // dispatcher extracted to src/browser/daemon-handler.ts for testability.
  let openAiEndpointRef: OpenAiEndpointHandle | null = null;

  // Phase 116-06 T04/T07 — dashboard action audit trail. Initialized
  // here (BEFORE the IPC handler closure) so list-dashboard-audit and
  // dashboard-telemetry-summary handlers can read through this
  // reference. The dashboard server reuses the same instance via
  // DashboardServerConfig.auditTrail; one writer, one reader, one
  // file → no cross-process JSONL races.
  //
  // File path: MANAGER_DIR/dashboard-audit.jsonl. Parallel sibling to
  // config-audit.jsonl (config-watcher) — distinct file because the
  // schemas differ (dashboard actions are richer; see
  // dashboard-audit-trail.ts docstring).
  const dashboardAuditTrail = new DashboardAuditTrail({
    filePath: join(MANAGER_DIR, "dashboard-audit.jsonl"),
    log,
  });

  // UX-A (2026-08-26, Client A trust program) — daemon-lifetime store of the
  // last share message per (agent, document), so a re-share of the same
  // filename marks the previous share message as superseded. In-memory
  // only (a restart forgets old shares — acceptable: the banner is a
  // convenience marker, not a compliance record).
  //
  // The helper lives HERE (not inline in the share-file case) because that
  // case block shadows the daemon logger with the tool's silent logger —
  // this closure keeps the real `log` reachable. Entirely fail-open.
  const sharedDocRefs = new SharedDocRefStore();
  const markSupersededShare = async (args: {
    bridge: { discordClient: { channels: { fetch: (id: string) => Promise<unknown> } } };
    agentName: string;
    filename: string;
    messageId: string;
    channelId: string;
    caption: string | undefined;
    formatCaption: (s: string) => string;
  }): Promise<void> => {
    const prev = sharedDocRefs.record(
      sharedDocKey(args.agentName, args.filename),
      {
        messageId: args.messageId,
        channelId: args.channelId,
        content:
          args.caption !== undefined ? args.formatCaption(args.caption) : "",
        at: Date.now(),
      },
    );
    if (!prev || prev.messageId === args.messageId) return;
    try {
      const prevChannel = await args.bridge.discordClient.channels.fetch(
        prev.channelId,
      );
      if (prevChannel && typeof prevChannel === "object" && "messages" in prevChannel) {
        const prevMsg = await (
          prevChannel as {
            messages: {
              fetch: (id: string) => Promise<{
                edit: (content: string) => Promise<unknown>;
              }>;
            };
          }
        ).messages.fetch(prev.messageId);
        await prevMsg.edit(supersededContent(prev));
        log.info(
          {
            agent: args.agentName,
            filename: args.filename,
            supersededMessageId: prev.messageId,
          },
          "share-file: previous share marked superseded",
        );
      }
    } catch (err) {
      log.debug(
        {
          agent: args.agentName,
          error: err instanceof Error ? err.message : String(err),
        },
        "share-file: superseded-marking failed (non-fatal)",
      );
    }
  };
  markSupersededShareRef = markSupersededShare;

  // Phase 999.176 — fleet account swap orchestrator. Slots are read lazily
  // off the live config binding so `defaults.accountSwap` reloads apply.
  const accountService = new AccountService({
    oauth: {
      // The fleet binary resolved at boot (999.169) — the same one agents run.
      claudeBin: resolvedBinary.pin ?? "claude",
      configDir: claudeConfigDir,
      workRoot: accountSwapPaths.workRoot,
    },
    paths: accountSwapPaths,
    getSlots: () => config.defaults.accountSwap?.slots ?? [],
    // Same self-SIGHUP as the restart-daemon IPC: graceful shutdown, exit 129,
    // systemd restarts, and step 3a applies the swap on the way up.
    requestRestart: () =>
      setImmediate(() => {
        try {
          process.kill(process.pid, "SIGHUP");
        } catch (err) {
          log.error(
            { component: "account-swap", error: err instanceof Error ? err.message : String(err) },
            "account swap: SIGHUP self-signal failed",
          );
        }
      }),
  });

  const handler: IpcHandler = async (method, params) => {
    // ── Cross-agent owner isolation (2026-06-27) — SINGLE chokepoint ──────────
    // Refuse a cross-owner action (ask/spawn-delegate/workflow/post/delegate/
    // schedule/message-history) BEFORE any handler runs. Keyed on the
    // TOKEN-VERIFIED caller (not self-reported params); tokenless CLI/dashboard
    // calls fail open. New cross-agent handlers must be added to
    // CROSS_AGENT_TARGET_EXTRACTORS or they silently bypass this.
    enforceCrossAgentIsolation(
      method,
      params,
      resolvedAgents,
      getProcessIdentitySecret(),
    );
    // Discord channel/thread reads: the target agent is NOT a params field, so
    // resolve it (channel→owning agent via config; thread→parent agent via the
    // binding registry) and apply the same owner boundary. fetch-discord-messages
    // is the direct "read a Operator channel" vector; read-thread covers subagent
    // threads. Unresolvable targets fall through (non-fleet channel/untracked
    // thread → no tenant boundary to assert).
    if (method === "fetch-discord-messages" || method === "read-thread") {
      const verifiedCaller = resolveVerifiedCaller(
        params,
        getProcessIdentitySecret(),
      );
      if (verifiedCaller !== null) {
        let targetAgent: string | undefined;
        if (method === "fetch-discord-messages") {
          const channelId =
            typeof params.channel_id === "string" ? params.channel_id : undefined;
          if (channelId) {
            targetAgent = resolvedAgents.find((a) =>
              a.channels.includes(channelId),
            )?.name;
          }
        } else {
          const threadId =
            typeof params.threadId === "string" ? params.threadId : undefined;
          if (threadId) {
            const registry = await readThreadRegistry(THREAD_REGISTRY_PATH);
            targetAgent = getBindingForThread(registry, threadId)?.agentName;
          }
        }
        if (targetAgent) {
          assertCrossAgentAllowed(verifiedCaller, targetAgent, resolvedAgents);
        }
      }
    }
    // Phase 116-postdeploy 2026-05-12 — endpoint info for the SPA's
    // /dashboard/v2/openai page. Read-only; safe even when the endpoint
    // is disabled (returns `{enabled: false}`). Renders the base URL +
    // curl example without the SPA needing to hardcode port 3101.
    if (method === "openai-endpoint-info") {
      const ep = openAiEndpointRef;
      if (!ep || !ep.enabled) {
        return { enabled: false };
      }
      return {
        enabled: true,
        host: ep.host ?? null,
        port: ep.port ?? null,
      };
    }
    if (
      method === "openai-key-create" ||
      method === "openai-key-list" ||
      method === "openai-key-revoke"
    ) {
      const ep = openAiEndpointRef;
      if (!ep || !ep.enabled || !ep.apiKeysStore) {
        throw new ManagerError(
          "OpenAI endpoint is not active — start the daemon with config.defaults.openai.enabled=true or set CLAWCODE_OPENAI_PORT to a free port",
        );
      }
      const { routeOpenAiKeyIpc } = await import("../openai/ipc-handlers.js");
      return routeOpenAiKeyIpc(
        {
          apiKeysStore: ep.apiKeysStore,
          sessionManager: manager,
          // Phase 999.19 — central predicate also excludes -via- delegated sessions.
          agentNames: () => resolvedAgents.filter((a) => !isSubagentOrThreadSession(a.name)).map((a) => a.name),
        },
        method,
        params,
      );
    }
    if (method === "browser-tool-call") {
      return handleBrowserToolCall(
        { browserManager, resolvedAgents, browserConfig: browserCfg },
        params as unknown as IpcBrowserToolCallParams,
      );
    }
    // Phase 71 — search-tool-call is intercepted BEFORE routeMethod
    // for the same reason as browser-tool-call: the existing 24-arg
    // routeMethod signature stays stable. The daemon-owned BraveClient
    // + ExaClient + fetcher are closed over here.
    //
    // Phase 115 Plan 07 sub-scope 15 — wrap with dispatchTool so repeat
    // queries hit the daemon-side cache. web_search / web_fetch_url use
    // CROSS-AGENT keying (public data shared) per
    // tool-cache-policy.ts:DEFAULT_TOOL_CACHE_POLICY.
    if (method === "search-tool-call") {
      const p = params as unknown as IpcSearchToolCallParams;
      const upstream = () =>
        handleSearchToolCall(
          {
            searchConfig: searchCfg,
            resolvedAgents,
            braveClient,
            exaClient,
            fetcher: fetchUrl,
          },
          p,
        );
      if (!toolCacheEnabled) return upstream();
      return dispatchTool({
        tool: p.toolName,
        args: p.args,
        agentName: p.agent,
        cacheStore: toolCacheStore,
        maxSizeMb: toolCacheMaxSizeMb,
        userPolicy: toolCachePolicy,
        upstream,
        log,
        traceCollector: manager.getTraceCollector(p.agent) ?? undefined,
      });
    }
    // Phase 72 — image-tool-call is intercepted BEFORE routeMethod
    // (same closure pattern as browser-tool-call + search-tool-call).
    // The daemon-owned image provider clients + per-agent UsageTracker
    // lookup are closed over here.
    //
    // Phase 115 Plan 07 sub-scope 15 — image_generate / image_edit /
    // image_variations are NEVER cached (TTL 0 / no-cache strategy in
    // DEFAULT_TOOL_CACHE_POLICY — each call is unique work). dispatchTool
    // bypasses on the no-cache strategy, so wiring the wrapper here is a
    // safety net for any future image tool an operator might add to the
    // policy table.
    if (method === "image-tool-call") {
      const p = params as unknown as IpcImageToolCallParams;
      const upstream = () =>
        handleImageToolCall(
          {
            imageConfig: imageCfg,
            resolvedAgents,
            providers: imageProviders,
            usageTrackerLookup: (agent) => manager.getUsageTracker(agent),
          },
          p,
        );
      if (!toolCacheEnabled) return upstream();
      return dispatchTool({
        tool: p.toolName,
        args: p.args,
        agentName: p.agent,
        cacheStore: toolCacheStore,
        maxSizeMb: toolCacheMaxSizeMb,
        userPolicy: toolCachePolicy,
        upstream,
        log,
        traceCollector: manager.getTraceCollector(p.agent) ?? undefined,
      });
    }
    // Phase 145 WS3 (Plan 04) — ask-user-question. Intercepted BEFORE
    // routeMethod (same closure pattern as the tool-call methods above), and
    // delegated to the extracted, unit-tested handleAskUserQuestion dispatcher
    // (mirrors browser/search/image daemon-handler extraction for testability).
    // The real bridge interactions + the fail-closed operator allowlist are
    // injected here as deps. sendIpcRequest has NO client timeout, so the
    // handler owns the load-bearing bounded timeout that always settles the
    // blocked worker (RESEARCH Pattern 4 / Pitfall 6).
    if (method === "ask-user-question") {
      // Fail-closed operator allowlist. Dedicated CLAWCODE_ASK_USER_AUTHORIZED_IDS
      // wins; falls back to the admin Discord ids (the channel operators).
      // Empty → no one can answer → a clean no-operator result (never trust-first-replier).
      const askAllowlistIds = (
        process.env.CLAWCODE_ASK_USER_AUTHORIZED_IDS?.trim() ||
        process.env.CLAWCODE_ADMIN_DISCORD_USER_IDS?.trim() ||
        ""
      )
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      return handleAskUserQuestion(
        {
          agents: resolvedAgents,
          registry: pendingPromptRegistry,
          allowlistIds: askAllowlistIds,
          newPromptId: () => nanoid(),
          defaultTimeoutMs: ASK_USER_QUESTION_DEFAULT_TIMEOUT_MS,
          maxTimeoutMs: ASK_USER_QUESTION_MAX_TIMEOUT_MS,
          renderNative: (channelId, questions, allowlistIds, timeoutMs, promptId) => {
            const bridge = discordBridgeRef.current;
            if (!bridge) return Promise.resolve(null);
            return bridge.askQuestionDiscord(
              channelId,
              questions,
              allowlistIds,
              timeoutMs,
              promptId,
            );
          },
          postText: async (platform, channelId, agent, text) => {
            if (platform === "slack") {
              const slackBridge = slackMessagingBridgeRef.current;
              if (!slackBridge) {
                throw new Error("no Slack bridge bound for text fallback");
              }
              await slackBridge.postText(channelId, agent, text);
              return;
            }
            throw new Error(`no text-fallback post path for platform ${platform}`);
          },
          log,
        },
        params as unknown as IpcAskUserQuestionParams,
      );
    }
    // Phase 145 WS2 (Plan 05) — start-workflow. Intercepted BEFORE routeMethod
    // (same closure pattern as the tool-call methods above). This is the
    // FAST-RETURN handler that is the core SC-2 mechanism: it resolves the
    // agent, validates the spec, launches the BACKGROUND orchestrator, and
    // RETURNS THE WORKFLOW ID IMMEDIATELY — it does NOT await any worker
    // completion. The triggering turn therefore settles in seconds, so no turn
    // watchdog ever spans the workflow's wall-clock duration. The orchestrator
    // instance is constructed once at daemon boot (near the spawner, so it can
    // reuse the spawner's registerLlmRuntime closure) and read here at CALL
    // TIME via workflowOrchestratorRef — shareable with Plan 06's barrier +
    // progress tick.
    // Phase 999.130 — fleet report card on demand (same collector as the cron).
    if (method === "report-card") {
      const deps = reportCardDepsRef.current;
      if (!deps) {
        throw new ManagerError("report card not ready (daemon still booting)");
      }
      const card = await collectFleetReportCard(deps);
      return { text: renderReportCard(card), card };
    }
    if (method === "start-workflow") {
      const p = params as unknown as IpcStartWorkflowParams;
      const orchestrator = workflowOrchestratorRef.current;
      if (!orchestrator) {
        return {
          ok: false as const,
          reason: "invalid-spec" as const,
        };
      }
      // Validate the spec at the boundary (zod-equivalent guards + the DoS
      // caps). The MCP tool already zod-bounds the shape, but the daemon
      // re-validates because the IPC boundary is the real trust boundary
      // (T-145-14). 999.106 W-2 — the spec is `{steps}` XOR `{waves}`;
      // both/neither is malformed. Structural caps (per-wave ≤8, ≤6 waves,
      // total ≤24) are enforced AGAIN by `normalizeWorkflowSpec` inside
      // `launchWorkflow` — the 3rd enforcement point, matching the pre-W-2
      // 3× discipline.
      // Phase 999.128 — a named template resolves to a spec first (agent's
      // merged template list; per-agent overrides fleet by name), then goes
      // through the SAME validation as a hand-written spec.
      let templateSpec: IpcWorkflowSpec | undefined;
      // Phase 999.129 — recurring-run lineage travels with the launch.
      let templateOrigin: import("./workflow-summary/previous-run.js").WorkflowOrigin | undefined;
      if (typeof p.template === "string" && p.template.length > 0) {
        if (p.spec !== undefined) {
          return {
            ok: false as const,
            reason: "invalid-spec" as const,
            message: "pass either a template or a spec, not both",
          };
        }
        const { resolveWorkflowTemplate } = await import("./workflow-templates.js");
        const templates =
          manager.getAgentConfig(p.agent)?.workflowTemplates ??
          resolvedAgents.find((a) => a.name === p.agent)?.workflowTemplates ??
          [];
        const rawParams = p.params && typeof p.params === "object" ? p.params : {};
        const cleanParams: Record<string, string> = {};
        for (const [k, v] of Object.entries(rawParams)) {
          if (typeof v === "string") cleanParams[k] = v;
          else if (typeof v === "number" || typeof v === "boolean") cleanParams[k] = String(v);
        }
        const resolved = resolveWorkflowTemplate(templates, p.template, cleanParams);
        if (!resolved.ok) {
          log.warn(
            { component: "start-workflow", agent: p.agent, template: p.template, reason: resolved.reason },
            resolved.message,
          );
          return { ok: false as const, reason: resolved.reason, message: resolved.message };
        }
        templateSpec = resolved.spec;
        templateOrigin = { template: p.template, params: resolved.params };
        log.info(
          { component: "start-workflow", agent: p.agent, template: p.template, params: resolved.params },
          "workflow template resolved",
        );
      }
      const rawSteps = (templateSpec ?? p.spec)?.steps;
      const rawWaves = (templateSpec ?? p.spec)?.waves;
      if (Array.isArray(rawSteps) === Array.isArray(rawWaves)) {
        return { ok: false as const, reason: "invalid-spec" as const };
      }
      const waves: readonly (readonly IpcWorkflowStep[])[] = Array.isArray(
        rawWaves,
      )
        ? rawWaves
        : [rawSteps as readonly IpcWorkflowStep[]];
      const totalSteps = waves.reduce(
        (n, wave) => n + (Array.isArray(wave) ? wave.length : 0),
        0,
      );
      const validStep = (s: IpcWorkflowStep | undefined): boolean =>
        s !== undefined &&
        s !== null &&
        typeof s.stepId === "string" &&
        s.stepId.length > 0 &&
        typeof s.prompt === "string" &&
        s.prompt.length > 0 &&
        // 999.106 QW-2 — optional per-step MCP allowlist: absent, or an
        // array of non-empty strings. Anything else is a malformed spec.
        (s.mcpServers === undefined ||
          (Array.isArray(s.mcpServers) &&
            s.mcpServers.every(
              (name: unknown) => typeof name === "string" && name.length > 0,
            )));
      if (
        waves.length === 0 ||
        waves.length > MAX_WORKFLOW_WAVES ||
        totalSteps > MAX_WORKFLOW_TOTAL_STEPS ||
        !waves.every(
          (wave) =>
            Array.isArray(wave) &&
            wave.length > 0 &&
            wave.length <= MAX_WORKFLOW_PARALLEL_STEPS &&
            wave.every(validStep),
        )
      ) {
        return { ok: false as const, reason: "invalid-spec" as const };
      }
      try {
        // launchWorkflow throws synchronously for an unknown agent / bad spec
        // and otherwise returns the id WITHOUT awaiting the background fan-out.
        // The spec is forwarded in its normalized `waves` form (a legacy
        // `{steps}` spec became one wave above).
        const workflowId = orchestrator.launchWorkflow(
          p.agent,
          {
            waves: waves.map((wave) =>
              wave.map((s) => ({
                stepId: s.stepId,
                prompt: s.prompt,
                ...(s.mcpServers !== undefined
                  ? { mcpServers: [...s.mcpServers] }
                  : {}),
              })),
            ),
          },
          templateOrigin ? { origin: templateOrigin } : {},
        );
        // 999.106 W-2 review — say "queued", not "spawned": at reply time zero
        // workers exist (fan-out is a deferred microtask), later waves may not
        // start for hours, and a stall/wall-clock drain means some may never
        // spawn. The agent repeats this message to the operator verbatim.
        return {
          ok: true as const,
          workflowId,
          message:
            `Started ${workflowId} — ${totalSteps} background step${
              totalSteps === 1 ? "" : "s"
            }` +
            (waves.length > 1
              ? ` across ${waves.length} waves (run in order)`
              : "") +
            ` queued; workers spawn as fleet slots free up. Progress and results will post to your channel; you can end your turn now.`,
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(
          { component: "start-workflow", agent: p.agent, err: msg },
          "start-workflow rejected",
        );
        return {
          ok: false as const,
          reason: msg.includes("Unknown agent")
            ? ("unknown-agent" as const)
            : ("invalid-spec" as const),
        };
      }
    }
    // Pull-based workflow status (2026-06-26) — the daemon-side analog of Claude
    // Code's `/workflows`. Read-only projection of in-flight + just-finished
    // background workflows via the orchestrator's `listWorkflows`. Mirrors the
    // start-workflow ref access above; optional `{ agent }` filters by trigger.
    // Backs the `/clawcode-workflows` slash command + a dashboard panel.
    if (method === "workflow-status") {
      const orchestrator = workflowOrchestratorRef.current;
      if (!orchestrator) return { workflows: [] };
      const p = params as { agent?: string; workflowId?: string };
      // Phase 999.165 — an agent (token-verified) sees only its own workflows
      // unless it is admin; the operator path keeps the optional filter.
      const caller = resolveWorkflowCaller(
        resolveVerifiedCaller(params, getProcessIdentitySecret()),
        params,
        resolvedAgents,
      );
      // One workflow in detail (live status: per-step activity + ETA). The
      // list response below stays byte-compatible for the dashboard panel.
      if (typeof p.workflowId === "string" && p.workflowId.length > 0) {
        const detail = orchestrator.describeWorkflow(p.workflowId);
        if (!detail) return { workflow: null };
        authorizeWorkflowControl(caller, detail.parentAgentName, p.workflowId, resolvedAgents);
        return { workflow: detail };
      }
      const filterAgent =
        caller.kind === "agent" && !caller.admin ? caller.agent : p.agent;
      return {
        workflows: orchestrator.listWorkflows(
          filterAgent ? { agent: filterAgent } : undefined,
        ),
      };
    }
    // Phase 999.165 — stop a whole workflow, or one step of it. Ownership:
    // workflow-control.ts (own workflows only for agents, admin exempt, never
    // across tenants; tokenless = trusted operator).
    if (method === "cancel-workflow") {
      const orchestrator = workflowOrchestratorRef.current;
      if (!orchestrator) {
        throw new ManagerError("workflow orchestrator not ready (daemon still booting)");
      }
      const workflowId = validateStringParam(params, "workflowId");
      const state = orchestrator.getWorkflowState(workflowId);
      if (!state) return { status: "not-found" as const };
      const caller = resolveWorkflowCaller(
        resolveVerifiedCaller(params, getProcessIdentitySecret()),
        params,
        resolvedAgents,
      );
      authorizeWorkflowControl(caller, state.parentAgentName, workflowId, resolvedAgents);
      const request = {
        by: workflowActorLabel(caller),
        ...(typeof params.reason === "string" && params.reason.trim().length > 0
          ? { reason: params.reason }
          : {}),
      };
      const stepId =
        typeof params.stepId === "string" && params.stepId.trim().length > 0
          ? params.stepId.trim()
          : undefined;
      return stepId
        ? orchestrator.cancelStep(workflowId, stepId, request)
        : orchestrator.cancelWorkflow(workflowId, request);
    }
    // Phase 999.165 — steer / edit a running workflow (same ownership rule).
    if (method === "steer-workflow" || method === "edit-workflow") {
      const orchestrator = workflowOrchestratorRef.current;
      if (!orchestrator) {
        throw new ManagerError("workflow orchestrator not ready (daemon still booting)");
      }
      const workflowId = validateStringParam(params, "workflowId");
      const state = orchestrator.getWorkflowState(workflowId);
      if (!state) return { status: "not-found" as const };
      const caller = resolveWorkflowCaller(
        resolveVerifiedCaller(params, getProcessIdentitySecret()),
        params,
        resolvedAgents,
      );
      authorizeWorkflowControl(caller, state.parentAgentName, workflowId, resolvedAgents);
      const by = workflowActorLabel(caller);
      const str = (key: string): string | undefined =>
        typeof params[key] === "string" && (params[key] as string).trim().length > 0
          ? (params[key] as string)
          : undefined;
      if (method === "steer-workflow") {
        return orchestrator.steerWorkflow(workflowId, {
          guidance: validateStringParam(params, "guidance"),
          by,
          ...(str("stepId") ? { stepId: str("stepId")!.trim() } : {}),
          ...(params.restart === true ? { restart: true } : {}),
        });
      }
      const op = str("op");
      const stepId = validateStringParam(params, "stepId");
      if (op === "remove_step") {
        return orchestrator.editWorkflow(workflowId, { kind: "remove_step", stepId, ...(str("reason") ? { reason: str("reason")! } : {}) }, { by });
      }
      if (op === "replace_step") {
        return orchestrator.editWorkflow(
          workflowId,
          { kind: "replace_step", stepId, prompt: validateStringParam(params, "prompt"), ...(params.restart === true ? { restart: true } : {}) },
          { by },
        );
      }
      if (op === "add_step") {
        const wave = str("wave") ?? "next";
        if (wave !== "current" && wave !== "next" && wave !== "new") {
          throw new ManagerError(`invalid wave '${wave}' — expected current | next | new`);
        }
        const mcpServers = Array.isArray(params.mcpServers)
          ? (params.mcpServers as unknown[]).filter((x): x is string => typeof x === "string")
          : undefined;
        return orchestrator.editWorkflow(
          workflowId,
          { kind: "add_step", stepId, prompt: validateStringParam(params, "prompt"), wave, ...(mcpServers ? { mcpServers } : {}) },
          { by },
        );
      }
      throw new ManagerError(`invalid op '${op ?? ""}' — expected add_step | replace_step | remove_step`);
    }
    // Phase 115 Plan 07 sub-scope 15 — search-documents IPC method
    // intercept BEFORE routeMethod so the daemon-side cache wraps the
    // call with PER-AGENT keying (Phase 90 isolation lock — each agent's
    // document corpus is private and stays private when cached).
    //
    // On miss, upstream() dispatches to routeMethod with the full 24-arg
    // signature so the existing case "search-documents" handler body
    // executes unchanged. On hit, the cached response is wrapped in a
    // CacheStamped envelope ({ cached: { age_ms, source }, data }).
    if (method === "search-documents" && toolCacheEnabled) {
      const agentName =
        typeof params.agent === "string" ? params.agent : "";
      // Strip the agent field from the cache-key args — it's the
      // per-agent strategy component (handled by buildCacheKey), not a
      // content discriminator.
      const argsForCache: Record<string, unknown> = { ...params };
      delete argsForCache.agent;
      return dispatchTool({
        tool: "search_documents",
        args: argsForCache,
        agentName,
        cacheStore: toolCacheStore,
        maxSizeMb: toolCacheMaxSizeMb,
        userPolicy: toolCachePolicy,
        upstream: () =>
          routeMethod(
            manager,
            resolvedAgents,
            method,
            params,
            routingTableRef,
            rateLimiter,
            heartbeatRunner,
            taskScheduler,
            skillsCatalog,
            threadManager,
            webhookManager,
            deliveryQueue,
            subagentThreadSpawner,
            allowlistMatchers,
            approvalLog,
            securityPolicies,
            escalationMonitor,
            advisorBudget,
            discordBridgeRef,
            configPath,
            config.defaults.basePath,
            taskManager,
            taskStore,
            schedulerSource,
            botDirectSenderRef,
            advisorService,
            config.defaults,
            compactionEventLog,
            thresholdAlerter,
            getLlmRuntime,
            failoverStateStore,
            agentChannelRegistry,
            goalManager,
            getCatalogSnapshot,
            a2aServices,
          ),
        log,
        traceCollector: manager.getTraceCollector(agentName) ?? undefined,
      });
    }
    // Phase 115 Plan 07 sub-scope 15 — tool-cache management IPC handlers
    // (status / clear / inspect). Routed BEFORE routeMethod to keep the
    // signature stable. Returned as plain JSON envelopes.
    if (method === "tool-cache-status") {
      return {
        sizeMb: toolCacheStore.sizeMb(),
        rows: toolCacheStore.rowCount(),
        topTools: toolCacheStore.topToolsByRows(10),
        path: toolCacheStore.getPath(),
        enabled: toolCacheEnabled,
        maxSizeMb: toolCacheMaxSizeMb,
      };
    }
    // Phase 115 Plan 07 T04 — augment the existing `cache` IPC method
    // with live tool_cache_size_mb so the dashboard panel can surface
    // it next to prompt_cache_hit_rate (sub-scope 16(c)). The base
    // method runs in routeMethod; we patch the response post-hoc with
    // the live size signal sourced from ToolCacheStore.sizeMb().
    if (method === "cache") {
      const baseResult = await routeMethod(
        manager,
        resolvedAgents,
        method,
        params,
        routingTableRef,
        rateLimiter,
        heartbeatRunner,
        taskScheduler,
        skillsCatalog,
        threadManager,
        webhookManager,
        deliveryQueue,
        subagentThreadSpawner,
        allowlistMatchers,
        approvalLog,
        securityPolicies,
        escalationMonitor,
        advisorBudget,
        discordBridgeRef,
        configPath,
        config.defaults.basePath,
        taskManager,
        taskStore,
        schedulerSource,
        botDirectSenderRef,
        advisorService,
        config.defaults,
        compactionEventLog,
        thresholdAlerter,
        getLlmRuntime,
        failoverStateStore,
        agentChannelRegistry,
        goalManager,
        getCatalogSnapshot,
        a2aServices,
      );
      const liveSizeMb = toolCacheEnabled ? toolCacheStore.sizeMb() : 0;
      // Phase 115 Plan 08 T03 — augment `case "cache"` with per-agent
      // split-latency + tool_use_rate fields. The dashboard cache panel
      // (`renderCachePanel` in src/dashboard/static/app.js) reads these
      // four fields off the same `report` object that already carries
      // tool_cache_*. Adding them here means the dashboard fetches stay
      // unchanged — one cache fetch surfaces the full Phase 115 perf
      // picture (prompt cache + tool cache + tool-latency methodology).
      //
      // Plan 115-08 own CLI (`clawcode tool-latency-audit`) reads its
      // own dedicated IPC handler instead — different output shape +
      // a fleet-gate roll-up. The per-agent fields here are JUST the
      // raw inputs the dashboard renders inline.
      //
      // Helper: compute the four T01/T02 fields for one agent. Returns
      // empty object on failure so cache rendering never breaks.
      const computeSplitLatencyFields = (
        agentName: string,
        sinceIso: string,
      ): Record<string, unknown> => {
        try {
          const ts = manager.getTraceStore(agentName);
          if (!ts) return {};
          const split = ts.getSplitLatencyAggregate(agentName, sinceIso);
          // Use a 24h window for the rate signal (matches the CLI default).
          const rateSinceIso = new Date(
            Date.now() - 24 * 3_600_000,
          ).toISOString();
          const rateSnap = ts.computeToolUseRatePerTurn(
            agentName,
            rateSinceIso,
            24,
          );
          // Phase 115 Plan 09 T04 — sub-scope 16(c) dashboard surface.
          // Folds tier1_* / lazy_recall / prompt_bloat aggregates onto the
          // same `cache` report so the dashboard renders the four new
          // metrics inline with prompt_cache + tool_cache + split-latency.
          // The 24h window matches the rate signal above so all dashboard
          // subtitle lines share one temporal frame.
          const phase115 = ts.getPhase115DashboardMetrics(
            agentName,
            rateSinceIso,
          );
          return {
            tool_execution_ms_p50: split.toolExecutionMsP50,
            tool_roundtrip_ms_p50: split.toolRoundtripMsP50,
            parallel_tool_call_rate: split.parallelToolCallRate,
            tool_use_rate: rateSnap.rate,
            // sub-scope 16(c) dashboard fields. NULL bubbles up when the
            // 115-02 writers haven't fired yet for this agent — dashboard
            // renders "—" gracefully.
            tier1_inject_chars: phase115.latestTier1InjectChars,
            tier1_budget_pct: phase115.latestTier1BudgetPct,
            lazy_recall_call_count: phase115.lazyRecallCalls24h,
            prompt_bloat_warnings_24h: phase115.promptBloatWarnings24h,
          };
        } catch {
          // Observability augmentation MUST NEVER break the cache fetch path.
          return {};
        }
      };

      // Phase 116 F02 — fold the resolved per-model SLO bundle into every
      // cache response so the dashboard agent tile (F03 in 116-01) can render
      // the first-token p50 gauge against the right per-model threshold
      // (sonnet 6s / opus 8s / haiku 2s) and surface the per-agent override
      // source pill. Lookup never throws — unknown agent names degrade to
      // omitting the slos field rather than failing the cache fetch.
      const computeSloFields = (
        agentName: string,
      ): Record<string, unknown> => {
        try {
          const cfg = resolvedAgents.find((a) => a.name === agentName);
          if (!cfg) return {};
          return { slos: resolveSloFor(cfg) };
        } catch {
          return {};
        }
      };

      // baseResult is either a single augmented report (case "cache" non-all)
      // or an array of reports (case "cache" --all). Either way, fold in the
      // fleet-wide live size signal so the dashboard reads a fresh number
      // even on the very first turn (when per-agent telemetry is still
      // accumulating).
      // Phase 116 hotfix 2026-05-11 — `base.since` is ALREADY an ISO timestamp
      // (set at line 8560 by the underlying `case "cache"` handler via
      // sinceToIso(params.since)). Re-running sinceToIso() on an ISO string
      // throws RangeError("invalid since duration: <iso>"), poisoning every
      // /api/agents/:name/cache response. Use base.since directly (or compute
      // 24h fallback as ISO) — never re-parse.
      const resolveSinceIso = (base: Record<string, unknown>): string => {
        const raw = typeof base.since === "string" ? base.since : "";
        // ISO timestamps from the underlying handler — pass through.
        if (raw.includes("T") && raw.includes("Z")) return raw;
        // Defensive: if some future caller passes a duration string, convert.
        try {
          return sinceToIso(raw || "24h");
        } catch {
          return new Date(Date.now() - 24 * 3_600_000).toISOString();
        }
      };
      if (Array.isArray(baseResult)) {
        return baseResult.map((r) => {
          const base = r as Record<string, unknown>;
          const sinceIso = resolveSinceIso(base);
          const agentName =
            typeof base.agent === "string" ? (base.agent as string) : "";
          return Object.freeze({
            ...base,
            tool_cache_size_mb_live: liveSizeMb,
            ...computeSplitLatencyFields(agentName, sinceIso),
            ...computeSloFields(agentName),
          });
        });
      }
      const base = baseResult as Record<string, unknown>;
      const sinceIso = resolveSinceIso(base);
      const agentName =
        typeof base.agent === "string" ? (base.agent as string) : "";
      return Object.freeze({
        ...base,
        tool_cache_size_mb_live: liveSizeMb,
        ...computeSplitLatencyFields(agentName, sinceIso),
        ...computeSloFields(agentName),
      });
    }
    if (method === "tool-cache-clear") {
      const tool =
        typeof (params as { tool?: unknown }).tool === "string"
          ? ((params as { tool?: string }).tool as string)
          : undefined;
      const cleared = toolCacheStore.clear(tool);
      return { cleared, tool: tool ?? null };
    }
    if (method === "tool-cache-inspect") {
      const tool =
        typeof (params as { tool?: unknown }).tool === "string"
          ? ((params as { tool?: string }).tool as string)
          : undefined;
      const agent =
        typeof (params as { agent?: unknown }).agent === "string"
          ? ((params as { agent?: string }).agent as string)
          : undefined;
      const limit =
        typeof (params as { limit?: unknown }).limit === "number"
          ? Math.min(
              Math.max((params as { limit?: number }).limit ?? 100, 1),
              500,
            )
          : 100;
      const rows = toolCacheStore.inspect({ tool, agent, limit });
      return { rows, count: rows.length };
    }
    // Phase 115 Plan 08 T03 — sub-scope 17(a/b/c) + 6-A `tool-latency-audit`
    // IPC handler. Composes T01's split-latency percentile (per-turn
    // tool_execution_ms / tool_roundtrip_ms) with T02's tool_use_rate
    // computation. Output shape mirrors the CLI's
    // ToolLatencyAuditResponse (src/cli/commands/tool-latency-audit.ts).
    //
    // Threshold per CONTEXT D-12: 0.30 (30%). Knob, not constant — plan
    // 115-09 may refine.
    if (method === "tool-latency-audit") {
      const windowHoursRaw = (params as { windowHours?: unknown }).windowHours;
      const windowHours =
        typeof windowHoursRaw === "number" && windowHoursRaw >= 1
          ? windowHoursRaw
          : 24;
      const filterAgent =
        typeof (params as { agent?: unknown }).agent === "string"
          ? ((params as { agent?: string }).agent as string)
          : undefined;

      const sinceIso = new Date(
        Date.now() - windowHours * 3_600_000,
      ).toISOString();
      const SUB_SCOPE_6B_THRESHOLD = 0.3;

      const targetAgents = filterAgent
        ? resolvedAgents.filter((a) => a.name === filterAgent)
        : resolvedAgents;

      const rows: Array<{
        readonly agent: string;
        readonly turnsTotal: number;
        readonly turnsWithTools: number;
        readonly toolUseRate: number;
        readonly toolExecutionMsP50: number | null;
        readonly toolRoundtripMsP50: number | null;
        readonly parallelToolCallRate: number | null;
        readonly subScope6BGate: string;
      }> = [];

      let fleetSum = 0;
      let fleetCount = 0;

      for (const cfg of targetAgents) {
        const traceStore = manager.getTraceStore(cfg.name);
        if (!traceStore) {
          rows.push({
            agent: cfg.name,
            turnsTotal: 0,
            turnsWithTools: 0,
            toolUseRate: 0,
            toolExecutionMsP50: null,
            toolRoundtripMsP50: null,
            parallelToolCallRate: null,
            subScope6BGate: "no-data",
          });
          continue;
        }
        const rateSnap = traceStore.computeToolUseRatePerTurn(
          cfg.name,
          sinceIso,
          windowHours,
        );
        const split = traceStore.getSplitLatencyAggregate(cfg.name, sinceIso);

        let gate: string;
        if (rateSnap.turnsTotal === 0) {
          gate = "no-data";
        } else if (rateSnap.rate < SUB_SCOPE_6B_THRESHOLD) {
          gate = "below-30%-threshold";
          fleetSum += rateSnap.rate;
          fleetCount += 1;
        } else {
          gate = "above-30%-threshold";
          fleetSum += rateSnap.rate;
          fleetCount += 1;
        }

        rows.push({
          agent: cfg.name,
          turnsTotal: rateSnap.turnsTotal,
          turnsWithTools: rateSnap.turnsWithTools,
          toolUseRate: rateSnap.rate,
          toolExecutionMsP50: split.toolExecutionMsP50,
          toolRoundtripMsP50: split.toolRoundtripMsP50,
          parallelToolCallRate: split.parallelToolCallRate,
          subScope6BGate: gate,
        });
      }

      const fleetAvg =
        fleetCount > 0 ? fleetSum / fleetCount : null;
      const decision: "ship-6B" | "defer-6B" | "no-signal" =
        fleetAvg === null
          ? "no-signal"
          : fleetAvg < SUB_SCOPE_6B_THRESHOLD
            ? "ship-6B"
            : "defer-6B";

      return {
        computed_at: new Date().toISOString(),
        windowHours,
        rows,
        fleetGate: {
          fleet_avg_tool_use_rate: fleetAvg,
          threshold: SUB_SCOPE_6B_THRESHOLD,
          decision,
          agentsCounted: fleetCount,
        },
      };
    }
    // Phase 88 Plan 02 MKT-01..07 — marketplace IPC is intercepted BEFORE
    // routeMethod (same closure pattern as browser/search/image-tool-call)
    // so the existing routeMethod signature stays stable. The three
    // handlers close over the daemon-local marketplace deps
    // (skillsPath + resolvedMarketplaceSources + ledgerPath + log).
    if (
      method === "marketplace-list" ||
      method === "marketplace-install" ||
      method === "marketplace-remove"
    ) {
      const deps = {
        configs: resolvedAgents as ResolvedAgentConfig[],
        configPath,
        marketplaceSources: resolvedMarketplaceSources,
        localSkillsPath: skillsPath,
        skillsTargetDir: skillsPath,
        ledgerPath,
        log,
        // Phase 93 Plan 02 D-93-02-2 — auto-inject the public ClawHub default
        // when the operator hasn't configured an explicit clawhub source.
        defaultClawhubBaseUrl: config.defaults.clawhubBaseUrl,
        params,
      };
      if (method === "marketplace-list") {
        return handleMarketplaceListIpc(deps);
      }
      if (method === "marketplace-install") {
        return handleMarketplaceInstallIpc(deps);
      }
      return handleMarketplaceRemoveIpc(deps);
    }
    // skill-create — agent-initiated skill authoring via daemon IPC.
    // Writes SKILL.md to skillsPath, rescans catalog, re-links agent workspace,
    // and persists the skill name to the agent's YAML config. Exists because
    // agent processes cannot write to skillsPath directly (tool ACL restriction).
    if (method === "skill-create") {
      const agentName = validateStringParam(params, "agent");
      const skillName = validateStringParam(params, "name");
      const content = validateStringParam(params, "content");
      if (!/^[a-z0-9][a-z0-9-]*$/.test(skillName)) {
        throw new ManagerError(
          `Invalid skill name '${skillName}' — must match [a-z0-9][a-z0-9-]*`,
        );
      }
      const agentIdx = (resolvedAgents as ResolvedAgentConfig[]).findIndex(
        (a) => a.name === agentName,
      );
      if (agentIdx === -1) {
        throw new ManagerError(`Agent '${agentName}' not found in config`);
      }
      const skillDir = join(skillsPath, skillName);
      const skillFile = join(skillDir, "SKILL.md");
      await mkdir(skillDir, { recursive: true });
      await writeFile(skillFile, content, "utf-8");
      const freshCatalog = await scanSkillsDirectory(skillsPath, log);
      const agentCfg = (resolvedAgents as ResolvedAgentConfig[])[agentIdx]!;
      const alreadyAssigned = agentCfg.skills.includes(skillName);
      const updatedSkills = alreadyAssigned
        ? agentCfg.skills
        : [...agentCfg.skills, skillName];
      if (!alreadyAssigned) {
        (resolvedAgents as ResolvedAgentConfig[])[agentIdx] = Object.freeze({
          ...agentCfg,
          skills: updatedSkills,
        });
        try {
          await updateAgentSkills({
            existingConfigPath: configPath,
            agentName,
            skillName,
            op: "add",
          });
        } catch (err) {
          log.warn(
            { agent: agentName, skill: skillName, error: (err as Error).message },
            "skill-create: YAML persist failed — skill linked in-memory only",
          );
        }
      }
      const skillCreateAgent = (resolvedAgents as ResolvedAgentConfig[])[agentIdx]!;
      await linkAgentSkills(
        join(skillCreateAgent.workspace, "skills"),
        updatedSkills,
        freshCatalog,
        log,
        {
          cliSkillsDir: join(
            skillCreateAgent.gsd?.projectDir ?? skillCreateAgent.workspace,
            ".claude",
            "skills",
          ),
        },
      );
      log.info({ agent: agentName, skill: skillName, path: skillFile }, "skill created");
      return Object.freeze({ created: true, skill: skillName, path: skillFile });
    }
    // Phase 90 Plan 05 HUB-02 / HUB-04 — ClawHub plugin list + install IPC.
    // Closure-based intercept parallel to the skill marketplace handlers
    // above. Writes to agents[*].mcpServers via updateAgentMcpServers.
    if (
      method === "marketplace-list-plugins" ||
      method === "marketplace-install-plugin"
    ) {
      const pluginDeps = {
        configs: resolvedAgents as ResolvedAgentConfig[],
        configPath,
        clawhubBaseUrl: config.defaults.clawhubBaseUrl,
        // Phase 90 Plan 06 wires GitHub OAuth token here; until then the
        // daemon relies on ClawHub's public/unauthenticated surface.
        clawhubAuthToken: undefined,
        cache: clawhubPluginsCache,
        log,
        params,
      };
      if (method === "marketplace-list-plugins") {
        return handleMarketplaceListPluginsIpc(pluginDeps);
      }
      return handleMarketplaceInstallPluginIpc(pluginDeps);
    }
    // Phase 90 Plan 06 HUB-05 / HUB-07 — install-time config UX.
    // Three pure handlers: OAuth start/poll (long-lived — the poll request
    // may block for up to 15min) + 1Password rewrite probe per sensitive
    // field. Routed BEFORE routeMethod per the closure-intercept pattern.
    if (method === "clawhub-oauth-start") {
      return handleClawhubOauthStartIpc({ log }, params);
    }
    if (method === "clawhub-oauth-poll") {
      return handleClawhubOauthPollIpc({ log }, params);
    }
    if (method === "marketplace-probe-op-items") {
      return handleMarketplaceProbeOpItemsIpc({ log }, params);
    }
    // Phase 95 Plan 03 DREAM-07 — run-dream-pass IPC.
    // Operator-driven manual dream-pass trigger backing both
    // `clawcode dream <agent>` (CLI) and `/clawcode-dream` (Discord slash,
    // admin-only). Closure-based intercept BEFORE routeMethod so the IPC
    // handler signature stays stable. The daemon edge wires the four
    // primitives (runDreamPass / applyDreamResult / isAgentIdle /
    // getResolvedDreamConfig) to real production sources here; Plans
    // 95-01 + 95-02 own the pure-DI logic.
    // Phase 96 Plan 05 PFS- — probe-fs + list-fs-status IPC handlers.
    // Operator-driven on-demand filesystem-capability re-probe + cached
    // snapshot read. Backs both `clawcode probe-fs <agent>` (CLI) and
    // `/clawcode-probe-fs` (Discord slash, admin-only) — Discord/CLI parity
    // invariant per RESEARCH.md Validation Architecture Dim 6. Closure-based
    // intercept BEFORE routeMethod so the IPC handler signature stays stable.
    // The daemon edge wires production deps (node:fs/promises.access /
    // realpath / writeFile / rename / mkdir + os.homedir for the
    // fs-capability.json path); Plan 96-01 owns the pure-DI runFsProbe +
    // writeFsSnapshot primitives (NEVER re-implemented here — pinned by
    // static-grep `grep -q "runFsProbe" src/manager/daemon.ts`).
    if (method === "probe-fs") {
      const { handleProbeFsIpc } = await import("./daemon-fs-ipc.js");
      const {
        access: fsAccessFn,
        realpath: fsRealpathFn,
        writeFile: fsWriteFileFn,
        rename: fsRenameFn,
        mkdir: fsMkdirFn,
        readFile: fsReadFileFn,
        constants: fsConstants,
      } = await import("node:fs/promises").then((m) => ({
        access: m.access,
        realpath: m.realpath,
        writeFile: m.writeFile,
        rename: m.rename,
        mkdir: m.mkdir,
        readFile: m.readFile,
        constants: m.constants,
      }));
      const { resolve: pathResolveFn } = await import("node:path");
      const { writeFsSnapshot } = await import("./fs-snapshot-store.js");
      const { resolveFileAccess } = await import("../config/loader.js");
      return handleProbeFsIpc(
        { agent: validateStringParam(params, "agent") },
        {
          resolveFileAccessForAgent: (agent) => {
            const cfg = manager.getAgentConfig(agent) ?? resolvedAgents.find((a) => a.name === agent);
            return resolveFileAccess(
              agent,
              cfg as unknown as { readonly fileAccess?: readonly string[] },
              config.defaults as unknown as { readonly fileAccess?: readonly string[] },
            );
          },
          getHandleAccessors: (agent) => {
            const handle = manager.getSessionHandle(agent);
            if (!handle) return null;
            return {
              getFsCapabilitySnapshot: () => handle.getFsCapabilitySnapshot(),
              setFsCapabilitySnapshot: (next) => handle.setFsCapabilitySnapshot(next),
            };
          },
          fsAccess: fsAccessFn,
          fsConstants,
          realpath: fsRealpathFn,
          resolve: pathResolveFn,
          writeFsSnapshot: (agent, snapshot, filePath) =>
            writeFsSnapshot(agent, snapshot, filePath, {
              writeFile: (p, data, enc) => fsWriteFileFn(p, data, enc),
              rename: fsRenameFn,
              // node:fs/promises.mkdir returns Promise<string | undefined>;
              // wrap to match our deps Promise<void> signature.
              mkdir: async (p, options) => {
                await fsMkdirFn(p, options);
              },
              readFile: (p, enc) => fsReadFileFn(p, enc),
              log,
            }),
          getFsCapabilityPath: (agent) =>
            join(homedir(), ".clawcode", "agents", agent, "fs-capability.json"),
          now: () => new Date(),
          log,
        },
      );
    }
    if (method === "list-fs-status") {
      const { handleListFsStatusIpc } = await import("./daemon-fs-ipc.js");
      return handleListFsStatusIpc(
        { agent: validateStringParam(params, "agent") },
        {
          getHandleAccessors: (agent) => {
            const handle = manager.getSessionHandle(agent);
            if (!handle) return null;
            return {
              getFsCapabilitySnapshot: () => handle.getFsCapabilitySnapshot(),
              setFsCapabilitySnapshot: (next) => handle.setFsCapabilitySnapshot(next),
            };
          },
        },
      );
    }
    if (method === "run-agent-optimization") {
      // Phase 142 — measured agent optimizer. Mirrors the run-dream-pass edge:
      // build DI deps from in-scope handles, dispatch to the pure handler. The
      // optimization stages any kept proposal for operator review (never auto-
      // applies). v1 uses Haiku for judge+proposer (config.model not yet honored).
      const req: RunAgentOptimizationRequest = {
        agent: validateStringParam(params, "agent"),
      };
      const optimizerIpcDeps: RunAgentOptimizationIpcDeps = {
        knownAgents: () => resolvedAgents.map((a) => a.name),
        now: () => new Date(),
        log,
        getOptimizerConfig: (agent: string) =>
          resolvedAgents.find((a) => a.name === agent)?.optimizer ?? null,
        loadEvalSetFor: async (agent: string, evalSetPath: string) => {
          const cfg = resolvedAgents.find((a) => a.name === agent);
          const base =
            cfg?.memoryPath ?? join(homedir(), ".clawcode", "agents", agent, "memory");
          return loadEvalSet(join(base, evalSetPath));
        },
        runOptimizationFor: async (agent, evalSet, config) => {
          const parentConfig = resolvedAgents.find((a) => a.name === agent);
          if (!parentConfig) {
            throw new ManagerError(`agent not found: ${agent}`, { code: -32602 });
          }
          const agentDir = join(homedir(), ".clawcode", "agents", agent);
          const memTmp = await mkdtemp(join(tmpdir(), `opt-${agent}-`));
          const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
          const fp = createHash("sha1")
            .update(`${agent}:${config.evalSet ?? ""}:${ts}`)
            .digest("hex")
            .slice(0, 12);
          // Phase 142 fix — register each eval fork's LlmRuntime resolver
          // (built from the FORK config) before startAgent and remove it after
          // stopAgent. Without this the fork name is absent from
          // `llmRuntimeRegistry`, `getLlmRuntime` throws in the SdkSessionAdapter
          // constructor, and every eval fail-closes to 0%. Mirrors the
          // subagent-spawner callback (below, ~9256) but unregisters (one-shot
          // fork → no late-turn race).
          const forkResolver = makeOptimizerForkResolver({
            registry: llmRuntimeRegistry,
            createResolver: createAgentLlmRuntimeResolver,
            logger: log,
            openaiCredentialsFor: (parent) => openaiCredentialsRegistry.get(parent),
            failoverStateReader: failoverStateStore,
            mcpTracker,
            // Phase 142 follow-up — wired so a tool-capable eval fork
            // (optimizer.evalMcpServers granted) gets op:// MCP creds resolved;
            // the resolver only uses it when the fork actually has mcpServers.
            opEnvResolver,
          });
          try {
            return await runAgentOptimization({
              sessionManager: manager,
              parentConfig,
              // Phase 142 fix — judge + proposer honor the agent's configured
              // optimizer.model (default opus) instead of being hardcoded to
              // Haiku. Non-haiku models route via the SDK-direct OAuth path
              // (billing-safe); haiku keeps the bridge route. See callModelDirect.
              llm: (s: string, u: string) =>
                callModelDirect(s, u, config.model, { maxTokens: 1024 }, "summarizer"),
              agentSkillsRoot: join(agentDir, "skills"),
              agentWorkspaceDir: (a: string) => join(homedir(), ".clawcode", "agents", a),
              evalSet,
              config: {
                samplesPerTask: config.samplesPerTask,
                maxActionsPerRun: config.maxActionsPerRun,
                minImprovementMargin: config.minImprovementMargin,
                eligibleSkills: config.eligibleSkills,
                // Phase 142 follow-up — fail-closed MCP allowlist for eval forks.
                // The runner intersects this with the agent's attached servers;
                // unlisted/unattached servers are dropped (tool-free when empty).
                evalMcpServers: config.evalMcpServers,
              },
              memoryPath: memTmp,
              registerLlmRuntime: forkResolver.registerLlmRuntime,
              unregisterLlmRuntime: forkResolver.unregisterLlmRuntime,
              draftIdSuffix: `${ts}-${fp}`,
              log: (o, m) => log.info(o, m),
            });
          } finally {
            await rm(memTmp, { recursive: true, force: true });
          }
        },
      };
      try {
        return await handleRunAgentOptimizationIpc(req, optimizerIpcDeps);
      } catch (err) {
        if (err instanceof ManagerError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        throw new ManagerError(`run-agent-optimization: ${msg}`);
      }
    }
    if (method === "run-dream-pass") {
      const req: RunDreamPassRequest = {
        agent: validateStringParam(params, "agent"),
        modelOverride:
          typeof params.modelOverride === "string"
            ? (params.modelOverride as "haiku" | "sonnet" | "opus")
            : undefined,
        idleBypass:
          typeof params.idleBypass === "boolean"
            ? (params.idleBypass as boolean)
            : false,
        force:
          typeof params.force === "boolean"
            ? (params.force as boolean)
            : false,
      };

      // Shared dream machinery — the SAME runDreamPass / applyDreamResult
      // adapters the boot-time `registerDreamCron` wiring uses. Manual
      // IPC trigger and the 30-min-idle auto trigger share ONE
      // implementation (silent-path-bifurcation defense — see
      // src/manager/dream-machinery.ts header).
      const dreamMachinery = buildDreamMachineryForDaemon();

      const dreamIpcDeps: RunDreamPassIpcDeps = {
        knownAgents: () => resolvedAgents.map((a) => a.name),
        now: () => new Date(),
        log,
        // Plan 95-01 — resolve dream config from agent's config block,
        // falling back to defaults.dream resolved at config load time.
        // Defaults: enabled=false (opt-in), idleMinutes=30, model='haiku'.
        getResolvedDreamConfig: (agent: string) => {
          const cfg = resolvedAgents.find((a) => a.name === agent);
          if (!cfg) return null;
          // Phase 95 dream config lives at agentSchema.dream (optional)
          // with defaults applied at the loader's defaults.dream resolver.
          // ResolvedAgentConfig may not surface it directly; treat absence
          // as fleet-default (enabled=false, 30min, haiku). Force flag at
          // the IPC handler overrides enabled=false at the operator's risk.
          // Phase 100 follow-up — ResolvedAgentConfig now carries `dream`
          // directly (resolver merges agent.dream ?? defaults.dream).
          // The `as unknown as ...` cast is gone; clean property access.
          const dreamCfg = cfg.dream;
          return {
            enabled: dreamCfg?.enabled ?? false,
            idleMinutes: dreamCfg?.idleMinutes ?? 30,
            model: dreamCfg?.model ?? "haiku",
          };
        },
        // Plan 95-01 — isAgentIdle gate. Now backed by a REAL lastTurnAt
        // derived from the agent's ConversationStore (shared dream
        // machinery). Previously this used a non-existent
        // `manager.getLastTurnAt` accessor that always resolved to null,
        // so the idle check always returned "no-prior-turn". The manual
        // IPC path papered over that with --idle-bypass; the cron path
        // (registerDreamCron) cannot bypass, so the real timestamp is
        // required there and shared here for consistency.
        isAgentIdle: (agent: string) => {
          const cfg = resolvedAgents.find((a) => a.name === agent);
          const idleMinutes = cfg?.dream?.idleMinutes ?? 30;
          return isAgentIdlePrimitive({
            lastTurnAt: dreamMachinery.getLastTurnAt(agent),
            idleMinutes,
            now: () => new Date(),
          });
        },
        // Plan 95-01 — runDreamPass + applyDreamResult adapters now come
        // from the shared dream machinery (src/manager/dream-machinery.ts).
        // The boot-time `registerDreamCron` wiring uses the EXACT same
        // adapters — there is no parallel dream-pass implementation.
        runDreamPass: (agent: string, model: string) =>
          dreamMachinery.runDreamPass(agent, model),
        applyDreamResult: (agent, outcome) =>
          dreamMachinery.applyDreamResult(agent, outcome),
      };

      try {
        return await handleRunDreamPassIpc(req, dreamIpcDeps);
      } catch (err) {
        if (err instanceof ManagerError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        throw new ManagerError(`run-dream-pass: ${msg}`);
      }
    }
    // Phase 92 Plan 04 CUT-06 / CUT-07 — cutover-button-action IPC.
    // Closure-based intercept BEFORE routeMethod (mirrors marketplace +
    // browser-tool-call patterns above) so the existing routeMethod
    // signature stays stable. Plan 92-06 will wire cutover-verify-summary;
    // for Plan 92-04 the button-action handler is the only IPC method.
    if (method === "cutover-button-action") {
      // Lazy import of the cutover ledger module's default path so we
      // don't pay the import cost on every IPC tick. The ledger path
      // is overridable via params for tests + per-agent customization.
      const { DEFAULT_CUTOVER_LEDGER_PATH } = await import(
        "../cutover/ledger.js"
      );
      const targetAgent =
        typeof params.agent === "string"
          ? (params.agent as string)
          : "fin-client";
      const targetAgentConfig = resolvedAgents.find(
        (a) => a.name === targetAgent,
      );
      const memoryRoot =
        targetAgentConfig?.memoryPath ?? targetAgentConfig?.workspace ?? "";
      const cutoverDeps = {
        applierDeps: {
          agent: targetAgent,
          clawcodeYamlPath: configPath,
          memoryRoot,
          openClawHost:
            typeof params.openClawHost === "string"
              ? (params.openClawHost as string)
              : "",
          openClawWorkspace:
            typeof params.openClawWorkspace === "string"
              ? (params.openClawWorkspace as string)
              : "",
          ledgerPath:
            typeof params.ledgerPath === "string"
              ? (params.ledgerPath as string)
              : DEFAULT_CUTOVER_LEDGER_PATH,
          // Production wires Phase 91 rsync runner here; first-pass returns
          // a non-zero exit so a stray Accept on outdated-memory-file fails
          // safely in audit-log mode rather than performing an unconfigured
          // rsync. Plan 92-06 will inject the real runner.
          runRsync: async () => ({
            stdout: "",
            stderr: "rsync runner not wired in Plan 92-04 first pass",
            exitCode: 1,
          }),
          log,
        },
        // First-pass gap resolver: returns null until Plan 92-06 wires the
        // CUTOVER-GAPS.json reader. The handler treats null as
        // "invalid-customId" — safe default that surfaces an audit hint.
        gapById: async () => null,
        log,
      };
      return handleCutoverButtonActionIpc(params, cutoverDeps);
    }
    // Phase 92 GAP CLOSURE — `cutover-verify` IPC.
    //
    // Builds VerifyPipelineDeps lazily so the per-call agent / output-dir
    // / staging-dir overrides flow through to the pipeline without
    // mutating daemon-scoped singletons. The handler dispatches into
    // runVerifyPipeline + writeCutoverReport — same flow that runs from
    // the operator CLI; same DI surface that's covered by 6 verify-pipeline
    // tests.
    //
    // Production primitives wired:
    //   - profiler dispatcher: turnDispatcher.dispatch (clawdy LLM pass)
    //   - canary dispatchStream: turnDispatcher.dispatchStream
    //   - canary fetchApi: native fetch against http://localhost:3101
    //   - probe loadConfig: loadConfig() + resolveAllAgents
    //   - probe listMcpStatus: manager.getMcpStateForAgent
    //   - probe readWorkspaceInventory: filesystem walk over memoryRoot
    //   - additive applier: scanSkillSecrets + updateAgentSkills/Config +
    //                       runRsync via execFile
    //   - report writer: writeCutoverReport (atomic temp+rename)
    //
    // Discord fetchMessages: stubbed to return empty pages — the SDK MCP
    // tool wiring is daemon-internal only via per-agent Claude Code child
    // processes and is out of scope for this gap closure. The MC ingestor
    // is the PRIMARY corpus per D-11; verify can run end-to-end without
    // Discord.
    if (method === "cutover-verify") {
      const { writeCutoverReport } = await import(
        "../cutover/report-writer.js"
      );
      const { ingestDiscordHistory } = await import(
        "../cutover/discord-ingestor.js"
      );
      const { runSourceProfiler } = await import(
        "../cutover/source-profiler.js"
      );
      const { probeTargetCapability } = await import(
        "../cutover/target-probe.js"
      );
      const { diffAgentVsTarget } = await import("../cutover/diff-engine.js");
      const { applyAdditiveFixes } = await import(
        "../cutover/additive-applier.js"
      );
      const { synthesizeCanaryPrompts } = await import(
        "../cutover/canary-synthesizer.js"
      );
      const { runCanary } = await import("../cutover/canary-runner.js");
      const {
        CANARY_API_ENDPOINT,
        CANARY_CHANNEL_ID,
        CANARY_TIMEOUT_MS,
      } = await import("../cutover/types.js");
      const yamlWriter = await import("../migration/yaml-writer.js");
      const { scanSkillSecrets } = await import(
        "../migration/skills-secret-scan.js"
      );
      const skillsTransformer = await import(
        "../migration/skills-transformer.js"
      );
      const { execFile } = await import("node:child_process");
      const { join: joinPath } = await import("node:path");
      const { homedir: homedirFn } = await import("node:os");

      const verifyHandlerDeps = {
        log,
        buildPipelineDeps: async (resolved: {
          agent: string;
          applyAdditive: boolean;
          outputDir: string | undefined;
          stagingDir: string | undefined;
          depthMsgs: number | undefined;
          depthDays: number | undefined;
        }) => {
          const home = homedirFn();
          const stagingDir =
            resolved.stagingDir ??
            joinPath(home, ".clawcode", "manager", "cutover-staging", resolved.agent);
          const outputDir =
            resolved.outputDir ??
            joinPath(home, ".clawcode", "manager", "cutover-reports", resolved.agent);
          const targetAgentConfig = resolvedAgents.find(
            (a) => a.name === resolved.agent,
          );
          const memoryRoot =
            targetAgentConfig?.memoryPath ??
            targetAgentConfig?.workspace ??
            joinPath(home, ".clawcode", "agents", resolved.agent);

          // Discord fetchMessages — stubbed (see comment above).
          const fetchMessagesStub = async () =>
            ({ messages: [], hasMore: false }) as const;

          // Profiler dispatcher — wraps turnDispatcher.dispatch as
          // ProfilerDispatchFn. Signature: (origin, agentName, message, opts?)
          // → Promise<string>. The profiler agent is "clawdy" by default.
          const profilerDispatch = async (
            origin: unknown,
            agentName: string,
            message: string,
          ): Promise<string> => {
            return await turnDispatcher.dispatch(
              origin as never,
              agentName,
              message,
            );
          };

          // Canary dispatchStream — wraps turnDispatcher.dispatchStream so
          // CanaryDispatchStreamFn ({agentName, prompt, origin}) →
          // Promise<{text}> resolves with the final accumulated text.
          const canaryDispatchStream = async (args: {
            agentName: string;
            prompt: string;
            origin: unknown;
          }): Promise<{ text: string }> => {
            const text = await turnDispatcher.dispatchStream(
              args.origin as never,
              args.agentName,
              args.prompt,
              () => {
                /* accumulator chunks not needed by canary — final text is the return value */
              },
            );
            return { text };
          };

          // Canary fetchApi — native fetch against the OpenAI-compat endpoint.
          const canaryFetchApi = async (
            url: string,
            body: unknown,
          ): Promise<{ status: number; text: string; json: unknown }> => {
            const res = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            });
            const rawText = await res.text();
            let json: unknown;
            try {
              json = JSON.parse(rawText);
            } catch {
              /* keep rawText only */
            }
            const responseText =
              (
                json as {
                  choices?: { message?: { content?: string } }[];
                } | undefined
              )?.choices?.[0]?.message?.content ?? rawText;
            return { status: res.status, text: responseText, json };
          };

          // Yaml writer adapters (mirror cutover-apply-additive.ts).
          const updateAgentSkillsAdapter = async (
            agent: string,
            nextSkills: readonly string[],
            opts: { clawcodeYamlPath: string },
          ) => {
            let lastResult: { outcome: string; reason?: string } = {
              outcome: "no-op",
            };
            for (const skill of nextSkills) {
              const r = await yamlWriter.updateAgentSkills({
                existingConfigPath: opts.clawcodeYamlPath,
                agentName: agent,
                skillName: skill,
                op: "add",
              });
              lastResult = r;
              if (r.outcome === "not-found" || r.outcome === "file-not-found") {
                break;
              }
            }
            return mapYamlOutcome(lastResult.outcome, lastResult.reason);
          };
          const updateAgentConfigAdapter = async (
            agent: string,
            patch: Readonly<Record<string, unknown>>,
            opts: { clawcodeYamlPath: string },
          ) => {
            const r = await yamlWriter.updateAgentConfig({
              existingConfigPath: opts.clawcodeYamlPath,
              agentName: agent,
              patch,
            });
            return mapYamlOutcome(
              r.outcome,
              "reason" in r ? r.reason : undefined,
            );
          };
          const scanSkillForSecretsAdapter = async (skillDir: string) => {
            const result = await scanSkillSecrets(skillDir);
            if (result.pass) return { refused: false };
            return {
              refused: true,
              reason: result.offender?.reason ?? "secret detected",
            };
          };
          const normalizeSkillFrontmatterAdapter = async (
            skillDir: string,
          ): Promise<void> => {
            const skillMdPath = joinPath(skillDir, "SKILL.md");
            const { existsSync } = await import("node:fs");
            if (!existsSync(skillMdPath)) return;
            const { readFile: rf, writeFile: wf } = await import(
              "node:fs/promises"
            );
            const content = await rf(skillMdPath, "utf8");
            const skillName = skillDir.split("/").filter(Boolean).pop() ?? "skill";
            const next = skillsTransformer.normalizeSkillFrontmatter(
              content,
              skillName,
            );
            if (next !== content) await wf(skillMdPath, next, "utf8");
          };

          const runRsyncAdapter = async (rsyncArgs: readonly string[]) => {
            return await new Promise<{
              stdout: string;
              stderr: string;
              exitCode: number;
            }>((resolve) => {
              const child = execFile(
                "rsync",
                rsyncArgs as string[],
                { maxBuffer: 16 * 1024 * 1024 },
                (err, stdout, stderr) => {
                  const exitCode =
                    err && typeof (err as NodeJS.ErrnoException).code === "number"
                      ? ((err as NodeJS.ErrnoException).code as unknown as number)
                      : err
                        ? 1
                        : 0;
                  resolve({
                    stdout: stdout?.toString() ?? "",
                    stderr: stderr?.toString() ?? "",
                    exitCode,
                  });
                },
              );
              child.on("error", () => {
                /* callback handles the error path */
              });
            });
          };

          // Probe loadConfig — re-reads the daemon's clawcode.yaml.
          const probeLoadConfig = async () => {
            const cfg = await loadConfig(configPath);
            return cfg;
          };

          const probeListMcpStatus = async (agentName: string) => {
            const state = manager.getMcpStateForAgent(agentName);
            return [...state.values()].map((s) => ({
              name: s.name,
              status: s.status,
              lastSuccessAt: s.lastSuccessAt,
              lastFailureAt: s.lastFailureAt,
              failureCount: s.failureCount,
              optional: s.optional,
              lastError: s.lastError?.message ?? null,
            }));
          };

          const probeReadWorkspaceInventory = async (
            _agentName: string,
            mr: string,
          ) => {
            // Minimal first-pass: empty inventory. The full filesystem walk
            // (Phase 92 Plan 02 defaultReadWorkspaceInventory) is wired by
            // the CLI scaffold; for daemon-IPC verify we accept an empty
            // inventory which means everything looks like a "missing" gap.
            // This is the SAFE default — operators see ALL gaps and decide.
            const { existsSync: _exists, readdirSync: _readdir } = await import(
              "node:fs"
            );
            void _exists;
            void _readdir;
            void mr;
            return {
              memoryFiles: [],
              memoryMdSha256: null,
              uploads: [],
              skillsInstalled: [],
            };
          };

          return {
            agent: resolved.agent,
            applyAdditive: resolved.applyAdditive,
            // First pass: skip canary unless operator explicitly opts in
            // (canary requires a live agent + working Discord channel).
            // Operators will re-run with --apply-additive to address gaps;
            // a real cutover_ready=true requires canary, gated by Plan 92-05.
            runCanaryOnReady: false,
            outputDir,
            stagingDir,
            ingestDiscordHistory,
            runSourceProfiler,
            probeTargetCapability,
            diffAgentVsTarget,
            applyAdditiveFixes,
            synthesizeCanaryPrompts,
            runCanary,
            writeCutoverReport,
            ingestDeps: {
              channels: targetAgentConfig?.channels ?? [],
              stagingDir,
              fetchMessages: fetchMessagesStub,
              log,
            },
            profileDeps: {
              historyJsonlPaths: [
                joinPath(stagingDir, "mc-history.jsonl"),
                joinPath(stagingDir, "discord-history.jsonl"),
              ],
              outputDir: joinPath(outputDir, "latest"),
              dispatcher: { dispatch: profilerDispatch },
              log,
            },
            probeDeps: {
              outputDir: joinPath(outputDir, "latest"),
              loadConfig: probeLoadConfig,
              listMcpStatus: probeListMcpStatus,
              readWorkspaceInventory: probeReadWorkspaceInventory,
              log,
            },
            applierDeps: {
              clawcodeYamlPath: configPath,
              skillsTargetDir: joinPath(home, ".clawcode", "skills"),
              memoryRoot,
              uploadsTargetDir: joinPath(memoryRoot, "uploads", "discord"),
              openClawHost: "example-user@10.0.0.3",
              openClawWorkspace: "/home/example-user/.openclaw/workspace-acme",
              openClawSkillsRoot: "/home/example-user/.openclaw/skills",
              ledgerPath: joinPath(
                home,
                ".clawcode",
                "manager",
                "cutover-ledger.jsonl",
              ),
              updateAgentSkills: updateAgentSkillsAdapter,
              updateAgentConfig: updateAgentConfigAdapter,
              scanSkillForSecrets: scanSkillForSecretsAdapter,
              normalizeSkillFrontmatter: normalizeSkillFrontmatterAdapter,
              runRsync: runRsyncAdapter,
              log,
            },
            canaryDeps: {
              canaryChannelId: CANARY_CHANNEL_ID,
              apiEndpoint: CANARY_API_ENDPOINT,
              timeoutMs: CANARY_TIMEOUT_MS,
              outputDir: joinPath(outputDir, "latest"),
              dispatchStream: canaryDispatchStream as never,
              fetchApi: canaryFetchApi,
              log,
            },
            synthesizerDeps: {
              dispatcher: { dispatch: profilerDispatch },
              log,
            },
            log,
          };
        },
      };
      // Cast through `unknown` to decouple from the structural-equivalence
      // mismatch TS reports between the daemon's locally-inferred
      // VerifyPipelineDeps shape and the one imported by handleCutoverVerifyIpc.
      // The shapes ARE identical at runtime (same types.ts → same primitives);
      // the duplicate-type complaint is a TS module-graph artifact only.
      return handleCutoverVerifyIpc(
        params,
        verifyHandlerDeps as unknown as Parameters<typeof handleCutoverVerifyIpc>[1],
      );
    }
    // Phase 92 GAP CLOSURE — `cutover-rollback` IPC. LIFO ledger rewind via
    // runRollbackEngine with Phase 86 atomic YAML writers wired in.
    if (method === "cutover-rollback") {
      const { join: joinPath } = await import("node:path");
      const { homedir: homedirFn } = await import("node:os");
      const yamlWriter = await import("../migration/yaml-writer.js");

      return handleCutoverRollbackIpc(params, {
        log,
        buildEngineDeps: async (resolved) => {
          const home = homedirFn();
          const ledgerPath =
            resolved.ledgerPath ??
            joinPath(home, ".clawcode", "manager", "cutover-ledger.jsonl");
          const targetAgentConfig = resolvedAgents.find(
            (a) => a.name === resolved.agent,
          );
          const memoryRoot =
            targetAgentConfig?.memoryPath ??
            targetAgentConfig?.workspace ??
            joinPath(home, ".clawcode", "agents", resolved.agent);

          const removeAgentSkillAdapter = async (
            agent: string,
            skillName: string,
            opts: { clawcodeYamlPath: string },
          ) => {
            const r = await yamlWriter.updateAgentSkills({
              existingConfigPath: opts.clawcodeYamlPath,
              agentName: agent,
              skillName,
              op: "remove",
            });
            return mapYamlOutcome(
              r.outcome,
              "reason" in r ? r.reason : undefined,
            );
          };

          // Remove ONE entry from agents[*].allowedModels: read current
          // array, filter out target, write filtered array back via
          // updateAgentConfig (which deep-merges patches).
          const removeAgentAllowedModelAdapter = async (
            agent: string,
            model: string,
            opts: { clawcodeYamlPath: string },
          ) => {
            try {
              const { readFile: rf } = await import("node:fs/promises");
              const { parseDocument } = await import("yaml");
              const text = await rf(opts.clawcodeYamlPath, "utf8");
              const doc = parseDocument(text);
              const js = doc.toJS() as { agents?: Array<{ name?: string; allowedModels?: string[] }> };
              const entry = js.agents?.find((a) => a.name === agent);
              if (!entry) return { kind: "not-found" as const, reason: `agent ${agent} not found` };
              const current = Array.isArray(entry.allowedModels)
                ? entry.allowedModels
                : [];
              if (!current.includes(model)) {
                return { kind: "no-op" as const };
              }
              const filtered = current.filter((m) => m !== model);
              const r = await yamlWriter.updateAgentConfig({
                existingConfigPath: opts.clawcodeYamlPath,
                agentName: agent,
                patch: { allowedModels: filtered },
              });
              return mapYamlOutcome(
                r.outcome,
                "reason" in r ? r.reason : undefined,
              );
            } catch (err) {
              return {
                kind: "refused" as const,
                reason: `removeAgentAllowedModel failed: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              };
            }
          };

          return {
            agent: resolved.agent,
            ledgerTo: resolved.ledgerTo,
            ledgerPath,
            clawcodeYamlPath: configPath,
            memoryRoot,
            uploadsTargetDir: joinPath(memoryRoot, "uploads", "discord"),
            skillsTargetDir: joinPath(home, ".clawcode", "skills"),
            dryRun: resolved.dryRun,
            removeAgentSkill: removeAgentSkillAdapter,
            removeAgentAllowedModel: removeAgentAllowedModelAdapter,
            log,
          };
        },
      });
    }
    // Phase 100 follow-up — set-gsd-project intercept (BEFORE routeMethod
    // so the closure can mutate the daemon-scoped resolvedAgents array +
    // re-publish to manager.setAllAgentConfigs without changing routeMethod's
    // signature). Persists to gsd-project-overrides.json (atomic temp+rename),
    // splices a new ResolvedAgentConfig with the new gsd.projectDir into the
    // resolvedAgents array, calls manager.setAllAgentConfigs to publish the
    // change, and triggers manager.restartAgent so the new SDK session picks
    // up the new cwd (gsd.projectDir is non-reloadable per Phase 100 GSD-07).
    if (method === "set-gsd-project") {
      const agentName = validateStringParam(params, "agent");
      const projectDirRaw = validateStringParam(params, "projectDir");
      const idx = resolvedAgents.findIndex((a) => a.name === agentName);
      if (idx === -1) {
        throw new ManagerError(`Agent '${agentName}' not found in config`);
      }
      const current = resolvedAgents[idx]!;
      if (!current.gsd?.projectDir) {
        throw new ManagerError(
          `Agent '${agentName}' is not GSD-enabled (no gsd.projectDir in config). ` +
            `Add a \`gsd:\` block to clawcode.yaml first.`,
        );
      }
      const { writeGsdProjectOverride, DEFAULT_GSD_PROJECT_OVERRIDES_PATH } =
        await import("./gsd-project-store.js");
      const { expandHome } = await import("../config/defaults.js");
      const expandedPath = expandHome(projectDirRaw);
      // Persist the override BEFORE mutating in-memory state. If the write
      // fails, the daemon stays in a consistent state (yaml + in-memory unchanged).
      await writeGsdProjectOverride(
        DEFAULT_GSD_PROJECT_OVERRIDES_PATH,
        agentName,
        expandedPath,
        log,
      );
      // Build a new immutable ResolvedAgentConfig with the swapped gsd block.
      const next: ResolvedAgentConfig = {
        ...current,
        gsd: { projectDir: expandedPath },
      };
      // Splice in place — both manager.setAllAgentConfigs and the slash
      // handler hold the SAME array reference, so after this mutation both
      // see the new entry on subsequent reads.
      (resolvedAgents as ResolvedAgentConfig[])[idx] = next;
      manager.setAllAgentConfigs(resolvedAgents);
      // Restart so the new SDK session boots with the new gsd.projectDir as
      // cwd. Mirrors the "restart" case fallback for stopped agents.
      try {
        await manager.restartAgent(agentName, next);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/not running|no such session|requireSession/i.test(msg)) {
          await manager.startAgent(agentName, next);
        } else {
          throw err;
        }
      }
      return { ok: true, agent: agentName, projectDir: expandedPath };
    }

    // Phase 104 Plan 04 — secrets-status / secrets-invalidate intercepts
    // BEFORE routeMethod (closure-intercept pattern, mirrors set-gsd-project
    // above + marketplace + browser-tool-call). The handler module consults
    // the daemon-scoped `secretsResolver` singleton via closure so
    // routeMethod's signature stays stable and the handlers remain unit-
    // testable in isolation. SEC-06 telemetry surface for /clawcode-status;
    // closes Pitfall 3 manual-rotation gap.
    switch (method) {
      case "secrets-status": {
        return handleSecretsStatus(secretsResolver);
      }
      case "secrets-invalidate": {
        return handleSecretsInvalidate(secretsResolver, params);
      }
      // WS-5 (2026-08-28) — forced live re-read (rotation path). With
      // `defaults.secrets.lkgFreshMs` enabled, `secrets-invalidate` alone is
      // undone by the next resolve fresh-serving the LKG entry; this drops
      // the entry from cache AND the durable store, then reads live.
      case "secrets-refresh": {
        return handleSecretsRefresh(secretsResolver, params);
      }
      // Phase 117 Plan 117-11 T05 — operator-driven per-channel verbose
      // toggle. Routes the /clawcode-verbose slash command's level choice
      // through VerboseState. Closure-intercept BEFORE routeMethod so the
      // already-massive routeMethod signature stays stable; `verboseState`
      // is constructed at boot (alongside advisorBudget at :~2697) and
      // shared by reference with the Discord bridge (T06) so reads at the
      // single mutation point in bridge.ts (~:810) see the same state.
      // Returns { level, updatedAt } so the slash handler can render the
      // ephemeral reply (handleVerboseSlash in slash-commands.ts).
      // 999.63d/7 — per-agent verification trail control from Discord.
      // Persisted (survives restart, re-applied on boot) and merged over
      // the agent's yaml, which stays the operator-authored baseline.
      // 2026-08-27 — `verify_claim` MCP tool. Records a validated claim on the
      // agent's ACTIVE turn (laundering-proof: the source must be in the
      // evidence ledger) and fans it out live to the bridge's trail.
      case "verify-claim": {
        const agentName = validateStringParam(params, "agent");
        enforceAgentIdentity(params, agentName);
        return handleVerifyClaim(
          {
            // A forked session reports the FORK name (`<agent>-fork-<id>`),
            // but the collector + active turn only ever exist under the base
            // agent. Resolve to whichever name actually has a collector.
            recordClaimForActiveTurn: (a, p, o) => {
              const owner = manager.getTraceCollector(a) ? a : baseAgentName(a);
              return manager.getTraceCollector(owner)?.recordClaimForActiveTurn(owner, p, o) ?? null;
            },
            getActiveTurnEvidence: (a) => {
              const owner = manager.getTraceCollector(a) ? a : baseAgentName(a);
              return manager.getTraceCollector(owner)?.getActiveTurnEvidence(owner) ?? [];
            },
            log: logger,
          },
          params,
        );
      }
      case "set-verification": {
        const agentName = validateStringParam(params, "agent");
        const action =
          typeof params?.action === "string" ? params.action : undefined;
        const statePath = DEFAULT_VERIFICATION_STATE_PATH;

        if (action === "reset") {
          await clearVerificationState(statePath, agentName, logger);
          setVerificationOverride(agentName, null);
          return { agent: agentName, override: null, reset: true };
        }

        const mode = typeof params?.mode === "string" ? params.mode : undefined;
        const profile =
          typeof params?.profile === "string" ? params.profile : undefined;

        if (action === "status" || (mode === undefined && profile === undefined)) {
          const override = await readVerificationState(
            statePath,
            agentName,
            logger,
          );
          const cfg = manager.getAgentConfig(agentName);
          const fromConfig = cfg?.verification;
          return {
            agent: agentName,
            override,
            effective: {
              enabled: fromConfig?.ux?.streamStatus === true,
              mode:
                override?.mode ?? fromConfig?.ux?.streamStatusMode ?? "auto",
              profile:
                override?.profile ?? fromConfig?.topic?.profile ?? "finance",
            },
          };
        }

        if (mode !== undefined && !TRAIL_MODES.includes(mode as never)) {
          throw new ManagerError(
            `invalid mode '${mode}' — expected ${TRAIL_MODES.join(" | ")}`,
          );
        }
        if (profile !== undefined && !isTopicProfileName(profile)) {
          throw new ManagerError(
            `invalid profile '${profile}' — expected ${TOPIC_PROFILE_NAMES.join(" | ")}`,
          );
        }
        const merged = await writeVerificationState(
          statePath,
          agentName,
          {
            ...(mode !== undefined ? { mode: mode as never } : {}),
            ...(profile !== undefined ? { profile: profile as never } : {}),
          },
          logger,
        );
        // File is the durable record; the registry is what the bridge's
        // per-message hot path reads. Written together, always.
        setVerificationOverride(agentName, merged);
        return { agent: agentName, override: merged };
      }
      case "set-fast-lane": {
        // Phase 999.164 — /clawcode-quick. on/off persist an override (file +
        // in-memory registry, written together); reset drops it; status reports
        // the effective state and this agent's quick-lane map.
        const agentName = validateStringParam(params, "agent");
        const lane = typeof params?.lane === "string" ? params.lane : "status";
        const cfg = manager.getAgentConfig(agentName);
        if (!cfg) throw new ManagerError(`unknown agent '${agentName}'`);
        if (lane === "reset") {
          await clearFastLaneState(DEFAULT_FAST_LANE_STATE_PATH, agentName, logger);
          setFastLaneOverride(agentName, null);
        } else if (lane === "on" || lane === "off") {
          const written = await writeFastLaneState(DEFAULT_FAST_LANE_STATE_PATH, agentName, { enabled: lane === "on" }, logger);
          setFastLaneOverride(agentName, written);
        } else if (lane !== "status") {
          throw new ManagerError(`invalid lane '${lane}' — expected on | off | status | reset`);
        }
        const effective = resolveFastLaneEnabled(getFastLaneOverride(agentName), cfg.fastLane?.enabled);
        return {
          agent: agentName,
          lane,
          enabled: effective.enabled,
          source: effective.source,
          model: cfg.fastLane?.model ?? "haiku",
          map: renderQuickLaneMap({
            profile: routingProfileFromConfig(cfg),
            enabled: effective.enabled,
            verificationEnforced: isVerificationEnforced(agentName, cfg.verification?.enforced),
          }),
        };
      }
      case "set-ux-feature": {
        // Phase 999.171 — /clawcode-ux. All validation + persistence lives in ux-feature-ipc.ts.
        return handleSetUxFeature({
          params: params ?? {},
          getConfigFeatures: (a) => {
            const cfg = manager.getAgentConfig(a);
            return cfg ? (cfg.uxFeatures ?? {}) : null;
          },
          // yaml agents only: getAgentConfig also finds thread/subagent sessions (MD-01).
          isConfiguredAgent: (a) => resolvedAgents.some((c) => c.name === a),
          // 999.172 — what the running session started with ("restart pending").
          getStartedFeatures: (a) => manager.getSessionHandle(a)?.getStartedUxFeatures?.(),
          // 999.173 polish — the configured research model, for the status source.
          getConfigResearchModel: (a) => manager.getAgentConfig(a)?.research?.model,
          // 999.173 polish — usage guard state for the status reply.
          getResearchUsageStatus: (a) => {
            const g = manager.getAgentConfig(a)?.research?.usageGuard;
            const thresholds = {
              reduceAt: g?.reduceAt ?? DEFAULT_USAGE_GUARD.reduceAt,
              blockAt: g?.blockAt ?? DEFAULT_USAGE_GUARD.blockAt,
            };
            const now = Date.now();
            return usageStatusLine(evaluateUsageGuard(currentUsageSnapshots(), now, thresholds), thresholds, now);
          },
          getResearchBudgetStatus: (a) => researchBudgetStatusLine(manager.getAgentConfig(a)?.research),
          filePath: DEFAULT_UX_FEATURE_STATE_PATH,
          log: logger,
        });
      }
      case "set-verbose-level": {
        const channelId = validateStringParam(params, "channelId");
        const level = validateStringParam(params, "level");
        if (level === "status") {
          const status = verboseState.getStatus(channelId);
          return { level: status.level, updatedAt: status.updatedAt };
        }
        if (level !== "on" && level !== "off") {
          throw new ManagerError(
            `invalid verbose level '${level}' — expected on | off | status`,
          );
        }
        const newLevel: "verbose" | "normal" =
          level === "on" ? "verbose" : "normal";
        verboseState.setLevel(channelId, newLevel);
        const status = verboseState.getStatus(channelId);
        return { level: status.level, updatedAt: status.updatedAt };
      }
      // Phase 999.84 Plan 01 — debug-only PTY write IPC for the
      // discriminating experiment that decides parent-channel turn-trigger
      // fix path. Strictly gated:
      //   1) `CLAWCODE_DEBUG_PTY_WRITE=1` must be set on the daemon process
      //      (otherwise returns `{ skipped: true, reason: "flag-off" }` —
      //      zero behavior change vs prod).
      //   2) Agent must be configured with the v3 `claude-code-interactive`
      //      backend (other backends' resolvers don't implement
      //      `debugWriteToPty`).
      //   3) Agent must have completed at least one `loadSdkModule()` — i.e.
      //      its supervisor has spawned and been captured.
      // Returns `{ ok, reason?, agent, textLength }`. NEVER touched by
      // production code paths. See `999.84-RESEARCH.md`.
      case "debug-pty-write": {
        if (process.env.CLAWCODE_DEBUG_PTY_WRITE !== "1") {
          return { skipped: true, reason: "flag-off" };
        }
        const agentName = validateStringParam(params, "agent");
        const text = validateStringParam(params, "text");
        // Resolve via the module-level liveSupervisor registry (NOT the
        // per-call resolver — that returns a fresh backend instance whose
        // liveSupervisor is always null; the ACTIVE supervisor lives on the
        // session-manager's first-instance backend, accessible only via the
        // module-level map populated at spawn time).
        const { debugWriteToPtyForAgent } = await import(
          "../llm-runtime/backends/claude-code-interactive.js"
        );
        const result = debugWriteToPtyForAgent(agentName, text);
        logger.info(
          {
            agent: agentName,
            textLength: text.length,
            ok: result.ok,
            ...(result.ok ? {} : { reason: result.reason }),
          },
          "phase99984-debug-pty-write",
        );
        return {
          ...result,
          agent: agentName,
          textLength: text.length,
        };
      }
      // Backlog 999.95 — push a live HTML preview (or URL) into the dashboard
      // preview store + post a one-tap activity-launch affordance on the FIRST
      // push of an id. Closure-intercept (not routeMethod) because it needs the
      // captured `previewStore` + `discordBridgeRef`. Size/scheme are
      // re-validated here (Layer-2) even though the MCP tool also checks — IPC
      // has no frame cap and other IPC clients could call this verb directly.
      case "show-preview": {
        // Body extracted to handleShowPreview (show-preview-handler.ts) so the
        // html/url discrimination + id-gen + Layer-2 validation + launch-post
        // branch are unit-tested in isolation. discordBridgeRef.current
        // structurally satisfies ActivityLauncher.
        // 999.95-fu — inline snapshot surface: render with the on-box headless
        // Chromium and deliver via the bridge (edit-in-place on id reuse).
        // Bridge unbound → snapshot skipped, behavior identical to pre-fu.
        const snapshotBridge = discordBridgeRef.current;
        return handleShowPreview(params, {
          previewStore,
          launcher: snapshotBridge,
          activityBaseUrl: process.env.CLAWCODE_ACTIVITY_BASE_URL ?? "",
          // 999.95-fu3 — the pushing agent's bound channel. Without this the
          // preview is stored unscoped and never resolves as any channel's
          // `current`, so the isolation would be inert rather than wrong —
          // which is precisely the failure mode that is hard to notice.
          ...(((): { agentChannelId?: string } => {
            const agentName =
              typeof params.agent === "string" ? params.agent : undefined;
            const ch = agentName
              ? routingTableRef.current.agentToChannels.get(agentName)?.[0]
              : undefined;
            return ch !== undefined ? { agentChannelId: ch } : {};
          })()),
          log: logger,
          snapshot: snapshotBridge
            ? {
                renderMotion: (input) => renderPreviewMotion(input, logger),
                render: (input) => renderPreviewSnapshot(input, logger),
                deliver: (a) => snapshotBridge.postPreviewSnapshot(a),
              }
            : null,
        });
      }
      // Phase 109-A — broker-status IPC. Returns the live PoolStatus[] from
      // the daemon-singleton broker (rps + throttle + lastRetryAfterSec
      // counters live here). Empty array when broker has no pools active
      // (no agents have spawned a 1Password shim yet — normal at boot).
      case "broker-status": {
        const pools = broker.getPoolStatus();
        const totalRps = pools.reduce(
          (sum, p) => sum + (p.rpsLastMin ?? 0),
          0,
        );
        const totalThrottles24h = pools.reduce(
          (sum, p) => sum + (p.throttleEvents24h ?? 0),
          0,
        );
        return { pools, totalRps, totalThrottles24h };
      }
      // Phase 110 Stage 0b 0B-RT-13 — list-mcp-tools IPC. Closure-intercept
      // pattern (mirrors secrets-status / broker-status / mcp-tracker-
      // snapshot above). Pure handler `handleListMcpToolsIpc` does the
      // Zod-shape → JSON-Schema conversion via zod/v4's NATIVE
      // `z.toJSONSchema()` (no new npm dep). Production wiring passes the
      // real frozen TOOL_DEFINITIONS arrays for search/image/browser; the
      // handler returns { tools: ToolSchema[] }. Sequencing constraint
      // (CONTEXT.md): this method ships BEFORE any Go shim builds against
      // it (Wave 1 prerequisite for Waves 2-4).
      case "list-mcp-tools": {
        return handleListMcpToolsIpc(
          {
            searchTools: SEARCH_TOOL_DEFINITIONS,
            imageTools: IMAGE_TOOL_DEFINITIONS,
            browserTools: BROWSER_TOOL_DEFINITIONS,
          },
          params,
        );
      }
      // Phase 999.15 TRACK-05 — mcp-tracker-snapshot intercept BEFORE
      // routeMethod (closure-intercept pattern, mirrors secrets-status
      // above). Pure handler in mcp-tracker-snapshot.ts builds the
      // response from the daemon-scoped mcpTracker singleton via closure.
      // Returns { agents: [] } when tracker is unset (Linux-only feature
      // not available on this platform). Optional `agent` param filters
      // to one entry — consumed by `clawcode mcp-tracker -a <name>`.
      case "mcp-tracker-snapshot": {
        if (!mcpTracker) {
          return { agents: [] };
        }
        const filter =
          params && typeof (params as { agent?: unknown }).agent === "string"
            ? ((params as { agent: string }).agent)
            : undefined;
        return buildMcpTrackerSnapshot(mcpTracker, filter);
      }
      // Phase 109-D — fleet-wide observability snapshot. Walks /proc once to
      // count claude procs vs tracker.getRegisteredAgents() (drift detector),
      // aggregates per-MCP-cmdline-pattern child counts + summed VmRSS, and
      // reads cgroup memory.{current,max} for memory pressure. Linux-only
      // signals degrade to null on non-Linux hosts. Read-only; never mutates
      // tracker or registry state.
      case "fleet-stats": {
        const trackedClaudeCount = mcpTracker
          ? Array.from(mcpTracker.getRegisteredAgents().keys()).filter(
              (n) => !n.startsWith("__broker:"),
            ).length
          : 0;
        // Phase 110 Stage 0a — every aggregate carries a runtime
        // classification so /api/fleet-stats consumers can split shim-
        // runtime cohorts (Stage 0/1 targets) from yaml-defined externals.
        // Yaml-defined entries default to "external"; the loader-auto-
        // injected shims (browser/search/image — see src/config/loader.ts:
        // 249-294) and the broker shim (1password — same file:215-238)
        // are added below with their runtime read from
        // config.defaults.shimRuntime (built-in baseline "static").
        const labeledPatterns: Array<{
          label: string;
          regex: RegExp;
          runtime: McpRuntime;
        }> = [];
        for (const [name, cfg] of Object.entries(mcpServersConfig)) {
          try {
            const single = buildMcpCommandRegexes({ [name]: cfg });
            labeledPatterns.push({
              label: name,
              regex: single,
              runtime: "external",
            });
          } catch {
            // Skip empty/invalid entries — buildMcpCommandRegexes throws on empty.
          }
        }
        // Loader-auto-injected shim patterns. These are NOT in
        // mcpServersConfig (they're injected per-agent inside
        // resolveAgentConfig) but they show up in /proc with the cmdline
        // shape that `resolveShimCommand(<type>, <runtime>)` produces.
        // Phase 110 Stage 0b: command/args MUST be derived from the same
        // `defaults.shimRuntime.<type>` selector that the loader reads,
        // otherwise an operator who flips a flag → static would see the
        // running Go binary become invisible to /api/fleet-stats (the
        // Stage 0a regex `clawcode <type>-mcp` would never match
        // `/opt/clawcode/bin/clawcode-mcp-shim --type <type>`). Both call-
        // sites import resolveShimCommand to keep the spawn shape and
        // the proc-scan regex shape in lockstep — single source of
        // truth in src/config/loader.ts.
        // Fallback "static" — MUST stay in lockstep with resolveRuntime's
        // baseline in src/config/loader.ts (2026-07-31 flip), else flipped
        // shims vanish from /api/fleet-stats proc-scan.
        const shimRuntimeCfg = config.defaults.shimRuntime;
        const browserRuntime: ShimRuntime = shimRuntimeCfg?.browser ?? "static";
        const searchRuntime: ShimRuntime = shimRuntimeCfg?.search ?? "static";
        const imageRuntime: ShimRuntime = shimRuntimeCfg?.image ?? "static";
        const browserCmd = resolveShimCommand("browser", browserRuntime);
        const searchCmd = resolveShimCommand("search", searchRuntime);
        const imageCmd = resolveShimCommand("image", imageRuntime);
        const autoInjected: ReadonlyArray<{
          label: string;
          command: string;
          args: readonly string[];
          runtime: McpRuntime;
        }> = [
          {
            label: "browser",
            command: browserCmd.command,
            args: browserCmd.args,
            runtime: browserRuntime,
          },
          {
            label: "search",
            command: searchCmd.command,
            args: searchCmd.args,
            runtime: searchRuntime,
          },
          {
            label: "image",
            command: imageCmd.command,
            args: imageCmd.args,
            runtime: imageRuntime,
          },
          {
            // Phase 108 broker shim. Both `--pool 1password` (legacy
            // form, current loader auto-inject) and `--type 1password`
            // (Phase 110 alias) match because the regex includes the
            // bare-package-name alternation `\bmcp-broker-shim\b`.
            // Broker is NOT in scope for Stage 0b (operator-locked —
            // see CONTEXT.md "mcp-broker-shim inclusion: NO — defer to
            // Stage 0c"). P5 (Stage 0c, operator-unlocked 2026-08-03):
            // shape now derived from the SAME dial the loader reads
            // (defaults.shimRuntime.broker, baseline "static") so the
            // proc-scan tracks whichever runtime actually spawns.
            label: "1password",
            command: resolveBrokerShimCommand(
              config.defaults.shimRuntime?.broker ?? "static",
            ).command,
            args: [
              ...resolveBrokerShimCommand(
                config.defaults.shimRuntime?.broker ?? "static",
              ).args,
            ],
            runtime:
              (config.defaults.shimRuntime?.broker ?? "static") === "static"
                ? "static"
                : "node",
          },
        ];
        for (const { label, command, args, runtime } of autoInjected) {
          // Skip if the operator yaml-defined a server with the same
          // name (mcpServersConfig wins — the operator's entry already
          // got pushed above with runtime: "external").
          if (mcpServersConfig[label] !== undefined) continue;
          try {
            const regex = buildMcpCommandRegexes({
              [label]: { command, args: [...args] },
            });
            labeledPatterns.push({ label, regex, runtime });
          } catch {
            // unreachable — args is non-empty for every auto-inject
          }
        }
        return await buildFleetStats({
          daemonPid: process.pid,
          trackedClaudeCount,
          mcpPatterns: labeledPatterns,
        });
      }
      // Phase 107 VEC-CLEAN-03 — memory-cleanup-orphans intercept BEFORE
      // routeMethod (closure-intercept pattern, mirrors secrets-status +
      // mcp-tracker-snapshot above). Per-agent: resolve MemoryStore via
      // manager.getMemoryStore(agent) and call store.cleanupOrphans().
      // Optional `agent` param scopes to one agent; otherwise iterates all
      // resolvedAgents. Per-agent error logged + sentinel { totalAfter: -1 }
      // pushed into results so partial failures don't kill the whole
      // operator command. Returns { results: [{ agent, removed, totalAfter }] }.
      case "memory-cleanup-orphans": {
        const agentParam =
          params && typeof (params as { agent?: unknown }).agent === "string"
            ? ((params as { agent: string }).agent)
            : null;
        // C3 — a tokenized (agent) caller may only clean its OWN store. The
        // all-agents sweep (agentParam null) is an admin/maintenance op:
        // reject it for tokenized callers, allow it untokenized (CLI). When a
        // specific agent is named, enforce identity on it.
        if (agentParam === null && params[AGENT_TOKEN_PARAM] !== undefined) {
          throw new ManagerError(
            "fleet-wide orphan cleanup is an admin operation — agents may only clean their own memory",
          );
        }
        if (agentParam !== null) {
          enforceAgentIdentity(params, agentParam);
        }
        const targets = agentParam
          ? [agentParam]
          : resolvedAgents.map((a) => a.name);
        const results: Array<{
          agent: string;
          removed: number;
          totalAfter: number;
        }> = [];
        for (const agent of targets) {
          const store = manager.getMemoryStore(agent);
          if (!store) {
            results.push({ agent, removed: 0, totalAfter: 0 });
            continue;
          }
          try {
            const r = store.cleanupOrphans();
            results.push({
              agent,
              removed: r.removed,
              totalAfter: r.totalAfter,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error(`[memory-cleanup-orphans] ${agent} failed: ${msg}`);
            results.push({ agent, removed: 0, totalAfter: -1 });
          }
        }
        return { results };
      }
      // Phase 999.119 — memory integrity doctor. Same identity rules as
      // memory-cleanup-orphans above: a tokenized caller may only inspect
      // its own store; the fleet-wide form is operator-only.
      case "memory-doctor": {
        const agentParam =
          params && typeof (params as { agent?: unknown }).agent === "string"
            ? ((params as { agent: string }).agent)
            : null;
        const repair = (params as { repair?: unknown }).repair === true;
        // Phase 999.126 — near-duplicate session-summary collapse. `dedupe`
        // previews the groups; `dedupeRun` applies them. Independent of
        // `repair` so an operator can preview without touching anything.
        const dedupeRun = (params as { dedupeRun?: unknown }).dedupeRun === true;
        const dedupe = dedupeRun || (params as { dedupe?: unknown }).dedupe === true;
        const dedupeThresholdRaw = (params as { dedupeThreshold?: unknown }).dedupeThreshold;
        const dedupeThreshold =
          typeof dedupeThresholdRaw === "number" && dedupeThresholdRaw >= 0.8 && dedupeThresholdRaw <= 1
            ? dedupeThresholdRaw
            : undefined;
        if (agentParam === null && params[AGENT_TOKEN_PARAM] !== undefined) {
          throw new ManagerError(
            "fleet-wide memory doctor is an admin operation — agents may only inspect their own memory",
          );
        }
        if (agentParam !== null) {
          enforceAgentIdentity(params, agentParam);
        }
        const targets = agentParam
          ? [agentParam]
          : resolvedAgents.map((a) => a.name);
        const results: Array<Record<string, unknown>> = [];
        for (const agent of targets) {
          const store = manager.getMemoryStore(agent);
          if (!store) {
            results.push({ agent, error: "no memory store (agent not running?)" });
            continue;
          }
          try {
            const tierManager = manager.getTierManager(agent);
            const conv = manager.getConversationStore(agent);
            // Phase 999.122 — the census is the ONE implementation shared
            // with the `memory-census` heartbeat check (what /api/health
            // carries), so the doctor and the brief never disagree.
            const { collectMemoryCensus, sessionCutoffs } = await import(
              "./memory-census.js"
            );
            const census = collectMemoryCensus(manager, agent);
            if (!census) {
              results.push({ agent, error: "no memory store (agent not running?)" });
              continue;
            }
            const { tierCounts, coldFiles, integrity: before, sessions, embedding } = census;
            const { staleActiveBefore, emptyTerminatedBefore } = sessionCutoffs();
            // Phase 999.126 — summary dedupe preview (+ apply). Groups are
            // computed once; the apply consumes that same preview.
            let dedupeFields: Record<string, unknown> = {};
            if (dedupe) {
              const { findSummaryDuplicateGroups, applySummaryDedupe } = await import(
                "../memory/summary-dedupe.js"
              );
              const preview = findSummaryDuplicateGroups(
                store,
                dedupeThreshold !== undefined ? { threshold: dedupeThreshold } : {},
              );
              dedupeFields = { dedupe: preview };
              if (dedupeRun && preview.groups.length > 0) {
                const applied = applySummaryDedupe(store, preview.groups);
                log.info({ agent, ...applied }, "[memory-doctor] summary dedupe applied");
                dedupeFields = { dedupe: preview, dedupeApplied: applied };
              }
            }
            if (!repair) {
              results.push({ agent, tierCounts, coldFiles, before, sessions, embedding, ...dedupeFields });
              continue;
            }
            const repaired = store.repairIntegrity();
            const coldImport = tierManager ? tierManager.importColdArchives() : null;
            // Phase 999.119 pass 2 — give vector-less memories their v1
            // embedding back (they are invisible to search until then).
            // Bounded per call so one doctor run cannot monopolise the
            // embedder; `remaining` tells the operator to run it again.
            const REEMBED_PER_CALL = 500;
            const embedder = manager.getEmbedder();
            let reembedded = 0;
            let reembedFailed = 0;
            for (const row of store.listMemoriesMissingEmbedding(REEMBED_PER_CALL)) {
              try {
                const vec = await embedder.embed(row.content);
                store.insertEmbeddingV1(row.id, vec);
                reembedded++;
              } catch (err) {
                reembedFailed++;
                log.warn(
                  { agent, memoryId: row.id, error: (err as Error).message },
                  "[memory-doctor] re-embed failed for memory",
                );
              }
            }
            const reembed = {
              reembedded,
              failed: reembedFailed,
              remaining: store.countMemoriesMissingEmbedding(),
            };
            const sessionsRepair = conv
              ? {
                  closed: conv.closeOrphanedActiveSessions(
                    manager.getRunningAgents(),
                    staleActiveBefore,
                  ),
                  pruned: conv.pruneEmptyTerminatedSessions(emptyTerminatedBefore),
                }
              : null;
            store.optimize();
            const after = store.checkIntegrity();
            log.info(
              { agent, repaired, coldImport, reembed, sessionsRepair },
              "[memory-doctor] repair complete",
            );
            results.push({
              agent,
              tierCounts,
              coldFiles,
              before,
              sessions,
              embedding,
              repaired,
              coldImport,
              reembed,
              sessionsRepair,
              after,
              ...dedupeFields,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error(`[memory-doctor] ${agent} failed: ${msg}`);
            results.push({ agent, error: msg });
          }
        }
        return { results, repair, dedupe, dedupeRun };
      }
      // Phase 115 D-08 — embedding-v2 migration IPC handlers. Closure-
      // intercept pattern (mirrors memory-cleanup-orphans above). Per-
      // agent migrator constructed on each call; no shared singleton.
      // Phase 90 per-agent isolation preserved.
      case "embedding-migration-status": {
        const { EmbeddingV2Migrator } = await import(
          "../memory/migrations/embedding-v2.js"
        );
        const agentParam =
          params && typeof (params as { agent?: unknown }).agent === "string"
            ? (params as { agent: string }).agent
            : null;
        const targets = agentParam
          ? [agentParam]
          : resolvedAgents.map((a) => a.name);
        const results: Array<{
          agent: string;
          phase: string;
          progressProcessed: number;
          progressTotal: number;
          lastCursor: string | null;
          startedAt: string | null;
          completedAt: string | null;
          paused: boolean;
          error?: string;
          readVersion?: "v1" | "v2";
          coverage?: {
            memories: number;
            memoriesV2: number;
            chunks: number;
            chunksV2: number;
          };
        }> = [];
        const pausedSet = new Set(
          (config.defaults as { embeddingMigration?: { pausedAgents?: readonly string[] } })
            .embeddingMigration?.pausedAgents ?? [],
        );
        for (const agent of targets) {
          const store = manager.getMemoryStore(agent);
          if (!store) {
            results.push({
              agent,
              phase: "no-store",
              progressProcessed: 0,
              progressTotal: 0,
              lastCursor: null,
              startedAt: null,
              completedAt: null,
              paused: pausedSet.has(agent),
              error: "memory store not available",
            });
            continue;
          }
          try {
            const m = new EmbeddingV2Migrator(store.getDatabase(), agent);
            const s = m.getState();
            // Phase 999.119 v2 switch — read version + v2 coverage so the
            // operator can see when a cutover is safe (both 100 %).
            const db = store.getDatabase();
            const countRows = (sql: string): number => {
              try {
                return (db.prepare(sql).get() as { n: number }).n;
              } catch {
                return 0;
              }
            };
            const coverage = {
              memories: countRows("SELECT COUNT(*) AS n FROM vec_memories"),
              memoriesV2: countRows(
                "SELECT COUNT(*) AS n FROM vec_memories_v2 WHERE memory_id IN (SELECT memory_id FROM vec_memories)",
              ),
              chunks: countRows("SELECT COUNT(*) AS n FROM vec_memory_chunks"),
              chunksV2: countRows(
                "SELECT COUNT(*) AS n FROM vec_memory_chunks_v2 WHERE chunk_id IN (SELECT chunk_id FROM vec_memory_chunks)",
              ),
            };
            results.push({
              agent,
              phase: s.phase,
              progressProcessed: s.progressProcessed,
              progressTotal: s.progressTotal,
              lastCursor: s.lastCursor,
              startedAt: s.startedAt,
              completedAt: s.completedAt,
              paused: pausedSet.has(agent),
              readVersion: store.getEmbeddingReadVersion(),
              coverage,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error(`[embedding-migration-status] ${agent} failed: ${msg}`);
            results.push({
              agent,
              phase: "error",
              progressProcessed: 0,
              progressTotal: 0,
              lastCursor: null,
              startedAt: null,
              completedAt: null,
              paused: pausedSet.has(agent),
              error: msg,
            });
          }
        }
        return { results };
      }
      case "embedding-migration-transition": {
        const { EmbeddingV2Migrator } = await import(
          "../memory/migrations/embedding-v2.js"
        );
        const p = params as { agent?: string; toPhase?: string } | undefined;
        const agent = p?.agent;
        const toPhase = p?.toPhase;
        if (!agent || typeof agent !== "string") {
          return { ok: false, error: "agent param required" };
        }
        if (!toPhase || typeof toPhase !== "string") {
          return { ok: false, error: "toPhase param required" };
        }
        const store = manager.getMemoryStore(agent);
        if (!store) {
          return { ok: false, error: "memory store not available" };
        }
        try {
          const m = new EmbeddingV2Migrator(store.getDatabase(), agent);
          // For re-embedding entry, seed progress_total with the
          // current count of memories missing v2 vectors.
          if (toPhase === "re-embedding") {
            const total = store.countMemoriesMissingV2Embedding();
            m.transition(
              "re-embedding",
              total + m.getState().progressProcessed,
            );
          } else {
            m.transition(
              toPhase as Parameters<typeof m.transition>[0],
            );
          }
          const s = m.getState();
          log.info(
            {
              agent,
              action: "embedding-migration-transition",
              fromPhase: "(see new state)",
              toPhase: s.phase,
            },
            "[diag] embedding-v2 migration transitioned",
          );
          // Phase 115-postdeploy 2026-05-12 — one-shot batch kick on
          // transition into a working phase. Fire-and-forget so the
          // IPC response returns immediately; the operator sees
          // progressProcessed jump from 0 within seconds instead of
          // waiting up to 30s for the cron tick. Errors are caught and
          // logged inside `kickEmbeddingMigrationBatch`.
          if (s.phase === "re-embedding" || s.phase === "dual-write") {
            void kickEmbeddingMigrationBatch({
              agent,
              manager,
              config,
              log,
            });
          }
          return { ok: true, phase: s.phase };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { ok: false, error: msg };
        }
      }
      case "embedding-migration-pause": {
        // Pause = add to defaults.embeddingMigration.pausedAgents.
        // Persisted state lives in the runtime config; the heartbeat
        // runner consults this list before processing. NOTE: this plan
        // ships the IPC + state-machine machinery; the heartbeat runner
        // wiring (which actually skips paused agents) lands in wave 4.
        const p = params as { agent?: string } | undefined;
        const agent = p?.agent;
        if (!agent || typeof agent !== "string") {
          return { ok: false, error: "agent param required" };
        }
        const cfgEm = (config.defaults as {
          embeddingMigration?: {
            cpuBudgetPct?: number;
            batchSize?: number;
            pausedAgents?: string[];
          };
        }).embeddingMigration;
        const paused = new Set<string>(cfgEm?.pausedAgents ?? []);
        paused.add(agent);
        if (!cfgEm) {
          (config.defaults as {
            embeddingMigration?: {
              cpuBudgetPct?: number;
              batchSize?: number;
              pausedAgents?: string[];
            };
          }).embeddingMigration = {
            cpuBudgetPct: 5,
            batchSize: 50,
            pausedAgents: [...paused],
          };
        } else {
          cfgEm.pausedAgents = [...paused];
        }
        log.info(
          { agent, action: "embedding-migration-pause" },
          "[diag] embedding-v2 migration paused for agent",
        );
        return { ok: true, paused: [...paused] };
      }
      case "embedding-migration-resume": {
        const p = params as { agent?: string } | undefined;
        const agent = p?.agent;
        if (!agent || typeof agent !== "string") {
          return { ok: false, error: "agent param required" };
        }
        const cfgEm = (config.defaults as {
          embeddingMigration?: {
            cpuBudgetPct?: number;
            batchSize?: number;
            pausedAgents?: string[];
          };
        }).embeddingMigration;
        const paused = new Set<string>(cfgEm?.pausedAgents ?? []);
        paused.delete(agent);
        if (cfgEm) cfgEm.pausedAgents = [...paused];
        log.info(
          { agent, action: "embedding-migration-resume" },
          "[diag] embedding-v2 migration resumed for agent",
        );
        return { ok: true, paused: [...paused] };
      }
      // Phase 999.25 — subagent-complete intercept BEFORE routeMethod
      // (closure-intercept pattern, mirrors secrets-status +
      // mcp-tracker-snapshot above). The handler closes over `config`
      // (live ref post-PR-#8 closure-capture fix), `log`, and
      // `subagentThreadSpawner`, none of which are on routeMethod's
      // signature. Pure helper in `relay-and-mark-completed.ts` does
      // the lookup → idempotent-relay → stamp-completedAt; this case
      // is a thin shell that wires deps + handles the env kill-switch
      // + reads the live `config.defaults.subagentCompletion.enabled`
      // toggle.
      case "subagent-complete": {
        const agentName = validateStringParam(params, "agentName");
        if (process.env.CLAWCODE_SUBAGENT_COMPLETION_DISABLE === "1") {
          return { ok: false, reason: "disabled" };
        }
        const sc = (config.defaults as {
          subagentCompletion?: { enabled?: boolean };
        }).subagentCompletion;
        const enabled = sc?.enabled !== false;
        // Phase 999.36 sub-bug D diag (D-12) — source-tagged completion-fired
        // log so one observation cycle on prod identifies which firing path
        // produces the premature autoRelay/autoArchive race. Plan 02 will
        // use these tags to gate completion on streamFullyDrained &&
        // deliveryConfirmed (D-13) without changing behavior here.
        log.info(
          { source: "explicit-tool", agent: agentName },
          "[diag] subagent-complete-fired",
        );
        // 2026-05-08 hotfix: capture into local const so TS narrows across
        // the closure boundary (post-TDZ-fix the outer is `let`, which TS
        // doesn't narrow inside the arrow-function below even with a check).
        const spawnerLocal = subagentThreadSpawner;
        const relayResult = await relayAndMarkCompletedByAgentName(
          {
            readThreadRegistry: () =>
              readThreadRegistry(THREAD_REGISTRY_PATH),
            // 999.65 — atomic read-modify-write so the completedAt stamp
            // cannot lose-update against a concurrent registry writer.
            mutateThreadRegistry: (mutator) =>
              mutateThreadRegistry(THREAD_REGISTRY_PATH, mutator),
            relayCompletionToParent: spawnerLocal
              ? (threadId) => spawnerLocal.relayCompletionToParent(threadId)
              : null,
            now: () => Date.now(),
            log: log.child({ subsystem: "subagent-completion" }),
            enabled,
            // Debug session `relay-delivery-not-confirmed` (FAULT 1) — real
            // async delay so the `delivery-not-confirmed` defer-and-retry
            // loop waits for the spawner's post-delivery `stampLastDeliveryAt`
            // to land instead of hard-skipping a relay that raced ahead of
            // the stamp. `deliveryRetry` left as the helper default
            // (≈5s worst case).
            sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
          },
          agentName,
        );
        // Phase 132-02 + 132-fu — task.completed emit at terminal
        // subagent-complete resolution. Fire-and-forget per D-01 (NO await).
        //
        // Phase 132-fu wires the real trajectory source via the multi-turn
        // agent-window accessor (SessionManager.getTrajectoryForSubagent).
        // A subagent session spans many Discord message-reply turns inside
        // the thread — each is its own `traces.id = discord:<snowflake>`.
        // Single-turnId lookup would miss the full work-trajectory.
        //
        // We re-read the registry to recover the binding (createdAt +
        // completedAt + sessionName). The relayAndMarkCompletedByAgentName
        // call above just stamped completedAt + persisted; that's the
        // window-upper-bound. The subagent's per-process TraceStore is
        // keyed by sessionName (e.g. <parent>-sub-<nanoid>) — verbatim
        // the agent name registered via sessionManager.startAgent at spawn.
        if (relayResult.ok && relayResult.reason === "relayed" && phase132EmitterDepsRef) {
          try {
            const registry = await readThreadRegistry(THREAD_REGISTRY_PATH);
            const binding = registry.bindings.find(
              (b) => b.sessionName === agentName,
            );
            const completedAt = binding?.completedAt;
            const view =
              binding && typeof completedAt === "number"
                ? manager.getTrajectoryForSubagent(
                    binding.sessionName,
                    binding.createdAt,
                    completedAt,
                  )
                : undefined;
            const trajectory = view?.trajectory ?? [];
            const durationMs = view?.durationMs ?? 0;
            emitTaskCompletedEvent(phase132EmitterDepsRef, {
              agent: agentName,
              sessionId: binding?.threadId ?? "",
              trajectory,
              durationMs,
              toolCallCount: trajectory.length,
              outcome: "success",
            });
          } catch (err) {
            log.error(
              { agent: agentName, err: (err as Error).message },
              "phase132 task.completed emit failed (subagent-complete site)",
            );
          }
        }
        return relayResult;
      }
      // post-cv2-embed — agent calls the `post_cv2_embed` MCP tool with a
      // CV2 spec; daemon resolves the agent's bound channel and posts a
      // Discord Components v2 message via bridge.postCv2ToAgentChannel.
      // After the tool returns the agent should call `clawcode_ack` with
      // empty `result` so the existing skip at bridge.ts
      // (`response.trim().length > 0`) suppresses the redundant text
      // follow-up — no daemon change to handleAck needed for that.
      case "post-cv2-embed": {
        const agentName = validateStringParam(params, "agentName");
        // C3 — `files[]` turns `agentName` into a key that resolves that
        // agent's private roots and reads from them, so a caller naming
        // another agent must be rejected here (fail-open only when no token
        // is present: trusted CLI/dashboard path, same as every C3 handler).
        enforceAgentIdentity(params, agentName);
        const rawSpec = (params as { spec?: unknown }).spec;
        if (!rawSpec || typeof rawSpec !== "object") {
          return { ok: false, reason: "invalid-spec", detail: "spec must be an object" };
        }
        // Re-validate server-side. The MCP tool applies this same schema, but
        // the renderer itself will happily emit a customId button or a select
        // for any raw-socket caller that skips the wrapper — and there is no
        // handler for agent-authored ids. The "link-only" guarantee has to
        // live at THIS boundary to be a guarantee.
        const parsedSpec = CV2_SPEC_SCHEMA.safeParse(rawSpec);
        if (!parsedSpec.success) {
          const detail = parsedSpec.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join(".") || "spec"}: ${i.message}`)
            .join("; ");
          return { ok: false, reason: "invalid-spec", detail };
        }
        // 999.178 R1 — resolve `:cc_name:` icon shortcodes in the
        // agent-authored text blocks (text.content and section lines) before
        // rendering; unknown names strip cleanly. Immutable rebuild.
        const spec = {
          ...parsedSpec.data,
          blocks: parsedSpec.data.blocks.map((b) =>
            b.type === "text"
              ? { ...b, content: rewriteIconShortcodes(b.content, icons) }
              : b.type === "section"
                ? { ...b, text: b.text.map((t) => rewriteIconShortcodes(t, icons)) }
                : b,
          ),
        };
        const bridge = discordBridge;
        if (!bridge) {
          return { ok: false, reason: "bridge-unavailable", detail: "Discord bridge not running" };
        }

        // 2026-09-10 — `files[]` carries the attachments a media gallery,
        // thumbnail or file block refers to. Same upload boundary as
        // clawcode_share_file (workspace + memoryPath + fileAccess), applied
        // to the path AND its realpath, then Discord's per-file cap; nothing
        // is read until every file passes. Loader is DI-pure and lives in
        // tools/cv2-attachments.ts.
        const rawFiles = (params as { files?: unknown }).files;
        let files: Parameters<typeof bridge.postCv2ToAgentChannel>[2] = [];
        if (rawFiles !== undefined) {
          if (!Array.isArray(rawFiles)) {
            return { ok: false, reason: "invalid-files", detail: "files must be an array" };
          }
          // A subagent calls with its sessionName, which is not in the static
          // agent list — resolve it to the parent it inherits roots from, the
          // way share-file does. Channel routing is unaffected (the routing
          // table already knows the subagent's thread).
          const registryForCv2 = await readThreadRegistry(THREAD_REGISTRY_PATH);
          const subBindingForCv2 = getBindingForSession(registryForCv2, agentName);
          const rootsOwner = subBindingForCv2 ? subBindingForCv2.agentName : agentName;
          const agentConfig = (resolvedAgents as ResolvedAgentConfig[]).find((a) => a.name === rootsOwner);
          if (!agentConfig) {
            return { ok: false, reason: "invalid-files", detail: `agent '${rootsOwner}' not found in config` };
          }
          const allowedRoots: string[] = [];
          if (agentConfig.workspace) allowedRoots.push(agentConfig.workspace);
          if (agentConfig.memoryPath) allowedRoots.push(agentConfig.memoryPath);
          const { resolveFileAccess: resolveFileAccessForCv2 } = await import("../config/loader.js");
          for (const p of resolveFileAccessForCv2(
            rootsOwner,
            agentConfig as unknown as { readonly fileAccess?: readonly string[] },
            undefined,
          )) {
            if (!allowedRoots.includes(p)) allowedRoots.push(p);
          }
          const { loadCv2Attachments } = await import("./tools/cv2-attachments.js");
          const loaded = await loadCv2Attachments(
            rawFiles as Parameters<typeof loadCv2Attachments>[0],
            {
              allowedRoots,
              workspaceRoot: agentConfig.workspace,
              realpath,
              stat: async (p) => {
                const st = await stat(p);
                return { size: st.size, isFile: st.isFile() };
              },
              readFile: (p) => readFile(p),
            },
          );
          if (!loaded.ok) {
            log.warn({ agent: agentName, detail: loaded.reason }, "post-cv2-embed: files refused");
            return { ok: false, reason: "invalid-files", detail: loaded.reason };
          }
          files = loaded.files;
        }

        const result = await bridge.postCv2ToAgentChannel(
          agentName,
          spec as Parameters<typeof bridge.postCv2ToAgentChannel>[1],
          files,
        );
        return result;
      }
      // Auto-steer (2026-05-23) — Path B handler.
      //
      // Parent agent calls `steer_subagent` MCP tool → IPC →
      // here. We (1) interrupt the subagent's in-flight turn + reset
      // the relay gates via the pure orchestrator
      // `prepareSubagentSteer`, then (2) post the framed guidance
      // INTO the subagent's thread, marking the bot post's ID so
      // bridge's auto-steer trigger picks it up. The bot post then
      // flows through the SAME dispatch pipeline as Path A
      // (human-in-thread auto-steer), so there's exactly one steer
      // dispatch code path.
      //
      // The visible thread message is "🧭 *Steering (via <parent>):
      // <guidance>*" wrapping the operator's guidance — gives the
      // operator a forensic record of what was steered and by whom.
      case "steer-subagent": {
        const threadId = validateStringParam(params, "threadId");
        const guidance = validateStringParam(params, "guidance");
        const reason = (params as { reason?: unknown }).reason;
        const reasonStr =
          typeof reason === "string" && reason.length > 0 ? reason : null;
        // Production verification log per feedback_silent_path_bifurcation
        // — first prod call should produce this line so the new IPC path
        // is observable in real traffic, not just in tests. Includes the
        // guidance LENGTH only (not content) to keep operator messages
        // out of logs.
        log.info(
          {
            component: "steer-subagent",
            action: "ipc-received",
            source: "mcp-tool",
            threadId,
            guidanceLength: guidance.length,
            hasReason: reasonStr !== null,
          },
          "[diag] steer-subagent-fired",
        );

        const steerPrep = await prepareSubagentSteer({
          threadId,
          deps: {
            getBinding: async (tid) => {
              const registry = await readThreadRegistry(THREAD_REGISTRY_PATH);
              return getBindingForThread(registry, tid);
            },
            interruptAgent: (name) => manager.interruptAgent(name),
            hasActiveTurn: (name) => manager.hasActiveTurn(name),
            sleep: (ms) =>
              new Promise<void>((resolve) => setTimeout(resolve, ms)),
            resetSteerGates: (tid) =>
              resetSteerGates(THREAD_REGISTRY_PATH, tid),
            log: log.child({ subsystem: "steer-subagent" }),
          },
        });
        if (!steerPrep.ok) {
          return {
            ok: false,
            reason: steerPrep.reason,
            detail: steerPrep.detail ?? null,
          };
        }

        // Post the framed guidance into the subagent's thread. Bridge
        // sees the MessageCreate event and — because we tagged the ID
        // — runs it through the auto-steer trigger.
        const bridge = discordBridgeRef.current;
        if (!bridge) {
          // Bridge not running. The prep already interrupted + reset
          // gates; without a bridge there's no way to deliver the
          // guidance, so callers see the partial-success state
          // explicitly. Operator can re-issue once bridge is back.
          return {
            ok: false,
            reason: "bridge-unavailable",
            detail:
              "steer prep succeeded (interrupted + gates reset) but Discord bridge is offline; guidance not delivered",
          };
        }
        // Resolve the parent agent's display name for the visible
        // attribution line. Falls back to the binding's agentName if
        // we can't read the config (e.g. parent was renamed).
        const parentAgentLabel = steerPrep.parentAgentName;
        // 999.178 R1 — operator-facing decoration (the model parses the
        // `<operator-steering>` frame below, not this line); compass icon,
        // plain text when the set is not loaded.
        const visiblePrefix = icons.prefix(
          "compass",
          `*Steering (via \`${parentAgentLabel}\`)*${reasonStr ? ` — ${reasonStr}` : ""}`,
        );
        const framedGuidance = frameSteeringGuidance(guidance);
        // The visible prefix is what the operator reads; the framed
        // guidance below it is what the model parses. Discord renders
        // the whole thing in one message so the operator sees the
        // <operator-steering> envelope inline (helpful for forensics).
        const postBody = `${visiblePrefix}\n\n${framedGuidance}`;
        const posted = await bridge.postToThread(threadId, postBody);
        if (!posted) {
          return {
            ok: false,
            reason: "post-failed",
            detail:
              "steer prep succeeded but the framed guidance could not be posted into the subagent thread",
          };
        }
        bridge.markPendingSteer(posted.id);
        log.info(
          {
            component: "steer-subagent",
            action: "dispatched",
            threadId,
            sessionName: steerPrep.sessionName,
            parentAgent: parentAgentLabel,
            interrupted: steerPrep.interrupted,
            hadActiveTurn: steerPrep.hadActiveTurn,
            messageId: posted.id,
          },
          "steer-subagent — framed guidance posted; bridge will auto-dispatch",
        );
        return {
          ok: true,
          sessionName: steerPrep.sessionName,
          interrupted: steerPrep.interrupted,
          hadActiveTurn: steerPrep.hadActiveTurn,
          messageId: posted.id,
        };
      }
      // =====================================================================
      // Phase 116-03 — Tier 1.5 operator workflow IPC handlers (F26/F27/F28).
      // Closure-intercept pattern (mirrors embedding-migration-* + secrets-status
      // above). Grouped contiguously to minimize merge surface with sibling
      // plans. All three feature areas share this block; append further
      // workflow IPC additions inside this fence.
      // =====================================================================

      // F26 — In-UI agent config editor.
      //
      // get-agent-config returns the live RESOLVED agent block (merged
      // defaults + per-agent fields, the same shape `resolveAllAgents` hands
      // session-adapter) PLUS the operator's RAW partial from clawcode.yaml
      // so the editor can show "this is what you wrote" vs "this is what
      // takes effect after merge". Restart-required vs hot-reloadable
      // classification is sourced from RELOADABLE_FIELDS so the UI can
      // grey out restart-only knobs without re-encoding the list.
      case "get-agent-config": {
        const agentName = validateStringParam(params, "agent");
        const resolved = resolvedAgents.find((a) => a.name === agentName);
        if (!resolved) {
          throw new ManagerError(`Agent not found: ${agentName}`);
        }
        const rawAgent = config.agents.find((a) => a.name === agentName) ?? null;
        return {
          agent: agentName,
          resolved,
          raw: rawAgent,
          // Field paths the operator MAY edit and have take effect without a
          // daemon restart. Encoded as the local agent-block key names (not
          // the `agents.<name>.x` form) so the UI maps 1:1 to form fields.
          hotReloadableFields: [
            "channels",
            "skills",
            "schedules",
            "heartbeat",
            "effort",
            "allowedModels",
            "greetOnRestart",
            "greetCoolDownMs",
            "memoryAutoLoad",
            "memoryAutoLoadPath",
            "memoryRetrievalTopK",
            "memoryRetrievalTokenBudget",
            "memoryRetrievalExcludeTags",
            "memoryScannerEnabled",
            "memoryFlushIntervalMs",
            "memoryCueEmoji",
            "systemPromptDirectives",
            "dream",
            "fileAccess",
            "outputDir",
          ],
          restartRequiredFields: [
            "name",
            "workspace",
            "memoryPath",
            "model",
            "settingSources",
            "gsd",
            "excludeDynamicSections",
            "cacheBreakpointPlacement",
            "soulFile",
            "identityFile",
          ],
        };
      }

      // update-agent-config — Zod-validate the partial against the
      // PARTIAL agent schema BEFORE any disk write, then call
      // patchAgentInYaml() which does the atomic temp+rename. Rejecting
      // invalid bodies BEFORE patching means a broken YAML never lands on
      // disk; ConfigWatcher's reload path would otherwise be left holding
      // the bag (the watcher logs the parse error and silently keeps the
      // old config — operator wouldn't see why their edit didn't apply).
      // Returns the patcher result verbatim so the UI can render
      // "hot-reloaded: [channels, model]" vs "needs restart: [workspace]"
      // in the save success toast. The PUT route surfaces a 400 on bad
      // bodies; success returns 200.
      case "update-agent-config": {
        const agentName = validateStringParam(params, "agent");
        const partialRaw = (params as { partial?: unknown }).partial;
        if (typeof partialRaw !== "object" || partialRaw === null) {
          throw new ManagerError(
            "Missing required parameter: partial (object)",
          );
        }
        // Zod partial: every agent-schema field becomes optional. We reject
        // `name` even when supplied — operator must use `clawcode restart`
        // and a manual yaml edit to rename an agent (memoryPath / inbox dir
        // are coupled).
        const partialObj = partialRaw as Record<string, unknown>;
        if ("name" in partialObj) {
          throw new ManagerError(
            "Cannot patch agent `name` — rename requires a full restart + yaml edit",
          );
        }
        const partialSchema = (
          agentSchema as unknown as {
            partial: () => { parse: (v: unknown) => Record<string, unknown> };
          }
        ).partial();
        const parsed = partialSchema.parse(partialObj);
        const result = await patchAgentInYaml({
          existingConfigPath: configPath,
          agentName,
          partial: parsed,
        });
        if (result.outcome === "not-found") {
          throw new ManagerError(
            `Agent '${agentName}' not in clawcode.yaml: ${result.reason}`,
          );
        }
        if (result.outcome === "file-not-found") {
          throw new ManagerError(result.reason);
        }
        // Quick 260715-j1j review CR-02 — the patched document failed the
        // FULL configSchema parse (cross-field superRefine invariants the
        // agentSchema.partial() pre-check above cannot see, e.g. D7's
        // effort:ultracode ↔ nativeWorkflow pairing). Nothing was written;
        // surface the zod reason so the dashboard shows a real error
        // instead of a false "saved" that breaks the next daemon boot.
        if (result.outcome === "invalid") {
          throw new ManagerError(result.reason);
        }
        if (result.outcome === "no-op") {
          return {
            written: false,
            reason: result.reason,
            hotReloaded: [],
            agentsNeedingRestart: [],
          };
        }
        // result.outcome === "updated"
        log.info(
          {
            agent: agentName,
            hotReloaded: result.hotReloadedFields,
            restartRequired: result.restartRequiredFields,
            sha256: result.targetSha256,
          },
          "[F26] agent config patched on disk",
        );
        return {
          written: true,
          sha256: result.targetSha256,
          hotReloaded: result.hotReloadedFields,
          agentsNeedingRestart:
            result.restartRequiredFields.length > 0 ? [agentName] : [],
          restartRequiredFields: result.restartRequiredFields,
        };
      }

      // hot-reload-now — force-touch the clawcode.yaml mtime so chokidar
      // schedules an immediate reload tick. The watcher debounces at 500ms
      // (default in ConfigWatcher constructor); after the PUT lands the
      // operator may want hot-reloadable fields applied without waiting.
      // We bump mtime by writing the same bytes back via temp+rename — that
      // way the actual content hash on disk doesn't shift and audit-trail
      // sees `(no changes detected)` if the prior update-agent-config call
      // already wrote the file (chokidar fires; differ.diffConfigs returns
      // empty; watcher logs debug and exits). Safe to call repeatedly.
      case "hot-reload-now": {
        // The simplest reliable trigger: re-read the file bytes and write
        // them back via the same temp+rename pattern. Any chokidar listener
        // sees one change event. We deliberately do NOT call
        // configWatcher.reload directly — that method is private and the
        // public `start()`/`stop()` surface doesn't expose a manual tick.
        const { readFile, writeFile, rename } = await import(
          "node:fs/promises"
        );
        const { dirname, join } = await import("node:path");
        const bytes = await readFile(configPath, "utf8");
        const tmp = join(
          dirname(configPath),
          `.clawcode.yaml.${process.pid}.${Date.now()}.touch.tmp`,
        );
        await writeFile(tmp, bytes, "utf8");
        await rename(tmp, configPath);
        log.info({ path: configPath }, "[F26] hot-reload-now: touched yaml");
        return { ok: true, touchedAt: Date.now() };
      }

      // F27 — Conversations view.
      //
      // search-conversations runs ConversationStore.searchTurns across one
      // agent (when `agent` param supplied) or every resolved agent (fanout
      // + merge by bm25 ascending). Each agent's store opens lazily through
      // SessionManager.getConversationStore — only running agents have one,
      // so non-running entries silently skip with an empty result.
      //
      // Trust filter: includeUntrustedChannels is FALSE by default (SEC-01
      // hygiene — agent-facing search-tools default the same way). The
      // dashboard is on 127.0.0.1 + operator-scope, but defaulting to
      // trusted-only keeps the surface aligned with the rest of the system.
      // Operator can opt-in via `includeUntrustedChannels: true` in params.
      case "search-conversations": {
        const q = validateStringParam(params, "q");
        const agentParam =
          params && typeof (params as { agent?: unknown }).agent === "string"
            ? (params as { agent: string }).agent
            : null;
        // C3 — a tokenized (agent) caller may only search its OWN
        // conversations. The all-agents search (agentParam null) is an admin
        // (dashboard) op: reject for tokenized callers, allow untokenized.
        if (agentParam === null && params[AGENT_TOKEN_PARAM] !== undefined) {
          throw new ManagerError(
            "fleet-wide conversation search is an admin operation — agents may only search their own conversations",
          );
        }
        if (agentParam !== null) {
          enforceAgentIdentity(params, agentParam);
        }
        const limit =
          typeof (params as { limit?: unknown }).limit === "number"
            ? Math.max(1, Math.min((params as { limit: number }).limit, 200))
            : 50;
        const includeUntrustedChannels =
          (params as { includeUntrustedChannels?: unknown })
            .includeUntrustedChannels === true;
        const sinceMs =
          typeof (params as { sinceMs?: unknown }).sinceMs === "number"
            ? (params as { sinceMs: number }).sinceMs
            : null;
        const targets = agentParam
          ? [agentParam]
          : resolvedAgents.map((a) => a.name);

        type Hit = {
          turnId: string;
          sessionId: string;
          role: "user" | "assistant" | "system";
          content: string;
          bm25Score: number;
          createdAt: string;
          channelId: string | null;
          isTrustedChannel: boolean;
          agent: string;
        };
        const allHits: Hit[] = [];
        let totalMatches = 0;
        for (const agent of targets) {
          const store = manager.getConversationStore(agent);
          if (!store) continue;
          try {
            const result = store.searchTurns(q, {
              limit,
              offset: 0,
              includeUntrustedChannels,
            });
            totalMatches += result.totalMatches;
            for (const r of result.results) {
              // Optional since-cutoff filter — createdAt is ISO; cheap parse.
              if (sinceMs !== null) {
                const t = Date.parse(r.createdAt);
                if (!Number.isFinite(t) || t < sinceMs) continue;
              }
              allHits.push({ ...r, agent });
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn({ agent, q, msg }, "[F27] search-conversations failed");
          }
        }
        // FTS5 BM25 — lower = better. Stable-sort ASC then truncate to limit.
        allHits.sort((a, b) => a.bm25Score - b.bm25Score);
        return {
          hits: allHits.slice(0, limit),
          totalMatches,
          agentsQueried: targets,
        };
      }

      // list-recent-conversations returns the recent session metadata for
      // one agent — used by the F27 left-pane "past sessions" list. Pulls
      // from ConversationStore.listRecentSessions (ALL statuses including
      // 'active' — the UI marks active sessions distinctly so the operator
      // can see in-flight turns without waiting for stop/crash to summarize).
      case "list-recent-conversations": {
        const agent = validateStringParam(params, "agent");
        enforceAgentIdentity(params, agent); // C3 — gate cross-agent access
        const limit =
          typeof (params as { limit?: unknown }).limit === "number"
            ? Math.max(1, Math.min((params as { limit: number }).limit, 200))
            : 50;
        const store = manager.getConversationStore(agent);
        if (!store) {
          return { agent, sessions: [] };
        }
        const sessions = store.listRecentSessions(agent, limit);
        return { agent, sessions };
      }

      // F28 — Kanban task board.
      //
      // list-tasks-kanban returns ALL non-purged tasks grouped by status
      // column. Six visible columns map to eight raw statuses:
      //   Backlog   ← pending
      //   Scheduled ← (synthetic — operator-tagged future-deadline tasks;
      //                today maps to pending too; future plan may add a
      //                discriminator. Leave column present but empty for
      //                now so the UI shape is stable.)
      //   Running   ← running
      //   Waiting   ← awaiting_input
      //   Failed    ← failed | timed_out | orphaned
      //   Done      ← complete | cancelled
      //
      // We expose raw_status alongside the column so a UI tooltip can
      // distinguish e.g. `complete` from `cancelled` inside the Done column.
      case "list-tasks-kanban": {
        const rows = taskStore.rawDb
          .prepare(
            `SELECT task_id, task_type, caller_agent, target_agent, status,
                    started_at, ended_at, heartbeat_at, chain_token_cost, error
             FROM tasks
             ORDER BY started_at DESC
             LIMIT 1000`,
          )
          .all() as Array<{
          task_id: string;
          task_type: string;
          caller_agent: string;
          target_agent: string;
          status: string;
          started_at: number;
          ended_at: number | null;
          heartbeat_at: number;
          chain_token_cost: number;
          error: string | null;
        }>;
        const columns: Record<string, typeof rows> = {
          Backlog: [],
          Scheduled: [],
          Running: [],
          Waiting: [],
          Failed: [],
          Done: [],
        };
        for (const row of rows) {
          switch (row.status) {
            case "pending":
              columns.Backlog!.push(row);
              break;
            case "running":
              columns.Running!.push(row);
              break;
            case "awaiting_input":
              columns.Waiting!.push(row);
              break;
            case "failed":
            case "timed_out":
            case "orphaned":
              columns.Failed!.push(row);
              break;
            case "complete":
            case "cancelled":
              columns.Done!.push(row);
              break;
            default:
              log.warn({ status: row.status, task_id: row.task_id }, "unknown task status in kanban");
          }
        }
        return { columns, total: rows.length };
      }

      // create-task — operator-authored task injection. Builds a TaskRow
      // with status='pending' (Backlog column) and a synthetic causation_id.
      // depth=0 (operator is root; caller_agent='operator' as a sentinel).
      // The input_digest hashes the body so the same operator-authored
      // task can be detected if re-submitted (idempotency hint, not enforced
      // — same as delegate-task path in router.ts).
      case "create-task": {
        const title = validateStringParam(params, "title");
        const target_agent = validateStringParam(params, "target_agent");
        const description =
          typeof (params as { description?: unknown }).description === "string"
            ? (params as { description: string }).description
            : "";
        const { randomUUID, createHash } = await import("node:crypto");
        const task_id = randomUUID();
        const causation_id = randomUUID();
        const inputObj = { title, description, target_agent };
        const input_digest = createHash("sha256")
          .update(JSON.stringify(inputObj))
          .digest("hex");
        const now = Date.now();
        const row = {
          task_id,
          task_type: "operator-created",
          caller_agent: "operator",
          target_agent,
          causation_id,
          parent_task_id: null,
          depth: 0,
          input_digest,
          status: "pending" as const,
          started_at: now,
          ended_at: null,
          heartbeat_at: now,
          result_digest: null,
          error: null,
          chain_token_cost: 0,
        };
        taskStore.insert(row);
        log.info(
          { task_id, target_agent, title },
          "[F28] operator-created task inserted",
        );
        return { task_id, row };
      }

      // transition-task — wraps TaskStore.transition() which itself runs
      // assertLegalTransition before any UPDATE. Illegal transitions throw
      // IllegalTaskTransitionError; we surface the message verbatim to the
      // dashboard so the optimistic UI flip can be reverted with the reason
      // displayed. The patch sub-object (result_digest / error /
      // chain_token_cost / ended_at) is forwarded as-is.
      case "transition-task": {
        const task_id = validateStringParam(params, "task_id");
        const status = validateStringParam(params, "status");
        const patch =
          params && typeof (params as { patch?: unknown }).patch === "object"
            ? ((params as { patch: Record<string, unknown> }).patch)
            : {};
        // The TaskStatus type is the same string set the schema CHECK
        // constraint enforces. Pass through; TaskStore.transition rejects
        // illegal targets via assertLegalTransition.
        const next = taskStore.transition(
          task_id,
          status as
            | "pending"
            | "running"
            | "awaiting_input"
            | "complete"
            | "failed"
            | "cancelled"
            | "timed_out"
            | "orphaned",
          patch as {
            ended_at?: number;
            result_digest?: string | null;
            error?: string | null;
            chain_token_cost?: number;
          },
        );
        log.info(
          { task_id, status },
          "[F28] task transition succeeded",
        );
        return { task_id, row: next };
      }

      // =====================================================================
      // Phase 116-04 — Tier 2 deep-dive IPC handlers (F11-F15).
      // Closure-intercept block, same convention as 116-03 above. All handlers
      // read existing per-agent stores (ConversationStore, TraceStore, Veto-
      // Store, MemoryStore) through the SessionManager surface. No new
      // singletons; the daemon already owns every primitive these routes need.
      //
      // F11 — three-panel agent detail drawer:
      //   list-recent-turns  -> last N conversation turns for transcript
      // F12 — per-turn trace waterfall:
      //   get-turn-trace     -> trace_spans rows for one turn_id
      // F13 — cross-agent IPC inbox viewer:
      //   list-ipc-inboxes   -> per-agent inbox state + 24h delivery log
      // F14 — memory subsystem panel (READ-ONLY per 116-DEFERRED):
      //   get-memory-snapshot -> tier counts + tier-1 file previews +
      //                          vec_memories migration delta + last
      //                          consolidation timestamps + dream status
      // F15 — dream-pass queue + D-10 veto windows:
      //   get-dream-queue    -> pending depth + next fire + last 7 events +
      //                         active veto windows
      //   veto-dream-run     -> operator veto on a D-10 window with rationale
      // =====================================================================

      // F11 — last N conversation turns for the drawer's center column.
      // Reads conversation_turns table directly via the store's getDatabase()
      // accessor (Phase 90 read-only pattern; same as Plan 116-03 F27 search
      // path). Returns rows in DESCENDING `created_at` order so the UI can
      // prepend live `conversation-turn` SSE events to the head of the list
      // without re-sorting.
      //
      // Trust filter: defaults to SEC-01 hygiene (untrusted Discord channels
      // excluded), matches the F27 search default. Untrusted turns are
      // visible only when the operator explicitly passes
      // includeUntrustedChannels=true (future operator-toggle in the drawer).
      case "list-recent-turns": {
        const agent = validateStringParam(params, "agent");
        enforceAgentIdentity(params, agent); // C3 — gate cross-agent access
        const limit =
          typeof (params as { limit?: unknown }).limit === "number"
            ? Math.max(1, Math.min((params as { limit: number }).limit, 200))
            : 50;
        const includeUntrustedChannels =
          (params as { includeUntrustedChannels?: unknown })
            .includeUntrustedChannels === true;
        // 116-postdeploy Bug 2 — optional session pin. When sessionId is
        // present the result is constrained to one session's turns in
        // chronological ORDER ASC (so the UI can render top-to-bottom
        // without re-sorting). Used by the F27 transcript pane added in
        // the same fix. When absent the original DESC-by-created_at
        // recent-turns behaviour is preserved (F11 drawer center column).
        const sessionId =
          typeof (params as { sessionId?: unknown }).sessionId === "string" &&
          (params as { sessionId: string }).sessionId.length > 0
            ? (params as { sessionId: string }).sessionId
            : null;
        const store = manager.getConversationStore(agent);
        if (!store) {
          return { agent, turns: [] };
        }
        // Direct read against conversation_turns. The store's public surface
        // (searchTurns / listRecentSessions) doesn't expose this; rather
        // than add a new public method on ConversationStore (which has its
        // own test surface), we inline the prepared statement here. Trust
        // filter mirrors the WHERE clause in searchTurns.
        const db = store.getDatabase();
        const trustClause = includeUntrustedChannels
          ? ""
          : "AND (is_trusted_channel = 1 OR channel_id IS NULL)";
        // The leading `WHERE 1=1` lets us append both the trust clause and
        // the optional session_id predicate as plain `AND …` fragments
        // without branching on which is present. SQLite's planner folds
        // the constant predicate at prepare time.
        const sessionClause = sessionId !== null ? "AND session_id = ?" : "";
        // For session-pinned queries: chronological order so transcript
        // renders top→bottom. For unfiltered queries: reverse-chronological
        // so the F11 drawer can prepend SSE events without re-sorting.
        const orderClause =
          sessionId !== null
            ? "ORDER BY turn_index ASC"
            : "ORDER BY created_at DESC";
        const sql = `
          SELECT id, session_id, turn_index, role, content, token_count,
                 channel_id, discord_user_id, discord_message_id,
                 is_trusted_channel, origin, created_at
          FROM conversation_turns
          WHERE 1=1 ${trustClause} ${sessionClause}
          ${orderClause}
          LIMIT ?
        `;
        const sqlParams: Array<string | number> =
          sessionId !== null ? [sessionId, limit] : [limit];
        const rows = db.prepare(sql).all(...sqlParams) as ReadonlyArray<{
          id: string;
          session_id: string;
          turn_index: number;
          role: string;
          content: string;
          token_count: number | null;
          channel_id: string | null;
          discord_user_id: string | null;
          discord_message_id: string | null;
          is_trusted_channel: number;
          origin: string | null;
          created_at: string;
        }>;
        return {
          agent,
          turns: rows.map((r) => ({
            turnId: r.id,
            sessionId: r.session_id,
            turnIndex: r.turn_index,
            role: r.role,
            content: r.content,
            tokenCount: r.token_count,
            channelId: r.channel_id,
            discordUserId: r.discord_user_id,
            discordMessageId: r.discord_message_id,
            isTrustedChannel: r.is_trusted_channel === 1,
            origin: r.origin,
            createdAt: r.created_at,
          })),
        };
      }

      // F12 — trace_spans for one turn_id. Reads via TraceStore's public
      // getDatabase() accessor (same READ-ONLY contract as the warmup
      // queries in AgentMemoryManager). Returns spans sorted by started_at
      // so the SVG waterfall can render top-to-bottom without re-sorting.
      // Also returns the parent `traces` row metadata (total_ms,
      // cache_eviction_expected) for the waterfall header strip.
      //
      // Optional `withPercentiles` flag — if true, batches a per-span-name
      // percentile lookup for the 24h window so the hover tooltip can render
      // "p47 of 24h" without a second round-trip. Capped to the 6 canonical
      // names + the actual tool_call.* names in this turn (small set).
      case "get-turn-trace": {
        const agent = validateStringParam(params, "agent");
        const turnId = validateStringParam(params, "turnId");
        const store = manager.getTraceStore(agent);
        if (!store) {
          // M4 — non-running agent: no store, no spans. Return an empty trace
          // (null turn) + debug-log instead of a level:50 throw.
          if (classifyMissingTraceStore(manager, agent).kind === "absent") {
            logTraceStoreAbsent(log, agent, "get-turn-trace");
            return { turn: null, spans: [] };
          }
          throw new ManagerError(
            `Trace store not found for agent '${agent}' (agent may not be running)`,
          );
        }
        const db = store.getDatabase();
        const turnRow = db
          .prepare(
            `SELECT id, agent, started_at, ended_at, total_ms,
                    discord_channel_id, status, cache_eviction_expected
             FROM traces WHERE id = ?`,
          )
          .get(turnId) as
          | {
              id: string;
              agent: string;
              started_at: string;
              ended_at: string;
              total_ms: number;
              discord_channel_id: string | null;
              status: string;
              cache_eviction_expected: number | null;
            }
          | undefined;
        if (!turnRow) {
          throw new ManagerError(
            `Turn not found: ${turnId} (agent=${agent})`,
          );
        }
        const spanRows = db
          .prepare(
            `SELECT name, started_at, duration_ms, metadata_json
             FROM trace_spans
             WHERE turn_id = ?
             ORDER BY started_at ASC`,
          )
          .all(turnId) as ReadonlyArray<{
          name: string;
          started_at: string;
          duration_ms: number;
          metadata_json: string | null;
        }>;
        return {
          turn: {
            id: turnRow.id,
            agent: turnRow.agent,
            startedAt: turnRow.started_at,
            endedAt: turnRow.ended_at,
            totalMs: turnRow.total_ms,
            discordChannelId: turnRow.discord_channel_id,
            status: turnRow.status,
            cacheEvictionExpected: turnRow.cache_eviction_expected === 1,
          },
          spans: spanRows.map((s) => ({
            name: s.name,
            startedAt: s.started_at,
            durationMs: s.duration_ms,
            metadata: s.metadata_json,
          })),
        };
      }

      // F13 — per-agent IPC inbox snapshot + fleet 24h delivery log.
      //
      // Two-part response:
      //   inboxes[]: per-agent pending message count + last-modified time of
      //              the inbox directory (the "heartbeat" proxy — chokidar's
      //              watch tick fires on any file write, but the dir mtime
      //              is the cheapest cross-platform freshness signal).
      //   deliveryLog[]: last 24h of cross-agent send/post/ask traffic from
      //              the delivery queue (status: pending|delivered|failed).
      //
      // Inbox dir resolution: agent.memoryPath + "/inbox" (same path
      // captured.ts uses to write inbox files via writeMessage in
      // src/collaboration/inbox.ts). For agents with no memoryPath we
      // return zero counts rather than scanning.
      case "list-ipc-inboxes": {
        const { readdir, stat: fsStat } = await import("node:fs/promises");
        const { join: joinPath } = await import("node:path");
        const inboxes: Array<{
          agent: string;
          pending: number;
          lastModified: string | null;
          inboxDir: string;
          error?: string;
        }> = [];
        for (const cfg of resolvedAgents) {
          if (!cfg.memoryPath) {
            inboxes.push({
              agent: cfg.name,
              pending: 0,
              lastModified: null,
              inboxDir: "",
            });
            continue;
          }
          const inboxDir = joinPath(cfg.memoryPath, "inbox");
          try {
            const entries = await readdir(inboxDir);
            const jsonFiles = entries.filter((f) => f.endsWith(".json"));
            let lastModifiedMs = 0;
            for (const f of jsonFiles) {
              try {
                const st = await fsStat(joinPath(inboxDir, f));
                if (st.mtimeMs > lastModifiedMs)
                  lastModifiedMs = st.mtimeMs;
              } catch {
                // unreadable file — skip without failing the whole agent
              }
            }
            inboxes.push({
              agent: cfg.name,
              pending: jsonFiles.length,
              lastModified:
                lastModifiedMs > 0
                  ? new Date(lastModifiedMs).toISOString()
                  : null,
              inboxDir,
            });
          } catch (err) {
            // ENOENT — inbox dir not yet created. Treat as empty.
            const errCode = (err as { code?: string }).code;
            if (errCode === "ENOENT") {
              inboxes.push({
                agent: cfg.name,
                pending: 0,
                lastModified: null,
                inboxDir,
              });
            } else {
              inboxes.push({
                agent: cfg.name,
                pending: 0,
                lastModified: null,
                inboxDir,
                error:
                  err instanceof Error ? err.message : String(err),
              });
            }
          }
        }

        // Outbound Discord delivery health from delivery-queue.db. The queue
        // tracks agent → channel SENDS (one row per outbound message).
        // Cross-agent IPC (send_to_agent / ask_agent) does NOT flow through
        // this queue — those are file-based via writeMessage to the
        // recipient's inbox dir + InboxSource pickup (fire-and-forget;
        // recipient discovery is the inboxes[] surface above).
        //
        // We expose:
        //   - deliveryStats: { pending, inFlight, failed, delivered, totalEnqueued }
        //   - recentFailures: last 50 permanently-failed sends (for inline
        //     fleet-wide failure list in the F13 panel)
        let deliveryStats: unknown = null;
        let recentFailures: ReadonlyArray<unknown> = [];
        try {
          deliveryStats = deliveryQueue.getStats();
          recentFailures = deliveryQueue.getFailedEntries(50);
        } catch (err) {
          log.warn(
            { err },
            "[F13] delivery-queue probe failed; returning empty stats",
          );
        }
        return { inboxes, deliveryStats, recentFailures };
      }

      // F14 — memory subsystem snapshot (READ-ONLY in v1; in-UI editor
      // explicitly DEFERRED per .planning/phases/116-.../116-DEFERRED.md).
      //
      // Aggregates:
      //   - tier counts (hot/warm/cold) from MemoryStore
      //   - tier-1 file previews (first 1000 chars each): SOUL.md /
      //     IDENTITY.md / MEMORY.md / USER.md from agent.memoryPath
      //   - vec_memories vs vec_memories_v2 migration delta from
      //     EmbeddingV2Migrator state (Phase 90 / 115)
      //   - last 5 consolidation events from the dream-pass log dir
      //     (~/<memoryRoot>/dreams/*.md) — file list with mtime
      //   - dream-pass schedule status (next fire + last fire timestamp)
      //     surfaced as a forward-pointer; full surface lives in F15
      //
      // For each tier-1 file we also return last-modified + total bytes so
      // the UI can render "5,234 chars total (showing 1,000)". File reads
      // are best-effort: ENOENT returns null for that slot rather than
      // throwing the whole snapshot.
      case "get-memory-snapshot": {
        const agent = validateStringParam(params, "agent");
        enforceAgentIdentity(params, agent); // C3 — gate cross-agent access
        const cfg = resolvedAgents.find((a) => a.name === agent);
        if (!cfg) {
          throw new ManagerError(`Agent not found: ${agent}`);
        }
        const { readFile: rf, stat: fsStat } = await import(
          "node:fs/promises"
        );
        const { join: joinPath } = await import("node:path");

        const PREVIEW_LEN = 1000;
        const tier1FileNames = [
          "SOUL.md",
          "IDENTITY.md",
          "MEMORY.md",
          "USER.md",
        ];

        type FilePreview = {
          name: string;
          path: string;
          preview: string | null;
          totalChars: number;
          lastModified: string | null;
          error?: string;
        };

        const files: FilePreview[] = [];
        // Phase 999.187 — MEMORY.md / USER.md previews come from the ONE
        // Tier 1 dir the prompt and the edit tool share; SOUL / IDENTITY keep
        // reading from memoryPath (operator files, unchanged).
        const snapshotRoots = resolveMemoryRoots(cfg);
        if (cfg.memoryPath) {
          for (const fname of tier1FileNames) {
            const fpath =
              fname === "MEMORY.md"
                ? snapshotRoots.memoryMdPath
                : fname === "USER.md"
                  ? snapshotRoots.userMdPath
                  : joinPath(cfg.memoryPath, fname);
            try {
              const content = await rf(fpath, "utf8");
              const st = await fsStat(fpath);
              files.push({
                name: fname,
                path: fpath,
                preview:
                  content.length > PREVIEW_LEN
                    ? content.slice(0, PREVIEW_LEN)
                    : content,
                totalChars: content.length,
                lastModified: new Date(st.mtimeMs).toISOString(),
              });
            } catch (err) {
              const errCode = (err as { code?: string }).code;
              if (errCode === "ENOENT") {
                files.push({
                  name: fname,
                  path: fpath,
                  preview: null,
                  totalChars: 0,
                  lastModified: null,
                });
              } else {
                files.push({
                  name: fname,
                  path: fpath,
                  preview: null,
                  totalChars: 0,
                  lastModified: null,
                  error:
                    err instanceof Error ? err.message : String(err),
                });
              }
            }
          }
        }

        // Tier counts via MemoryStore. The store carries hot/warm/cold
        // discrimination per Phase 56+ tier model. Returns zeros if the
        // store isn't running yet (race at agent boot).
        let tierCounts: {
          hot: number;
          warm: number;
          cold: number;
          total: number;
        } = { hot: 0, warm: 0, cold: 0, total: 0 };
        let migrationDelta: {
          vecMemoriesRows: number | null;
          vecMemoriesV2Rows: number | null;
          phase: string | null;
        } = {
          vecMemoriesRows: null,
          vecMemoriesV2Rows: null,
          phase: null,
        };
        try {
          const memStore = manager.getMemoryStore(agent);
          if (memStore) {
            const db = memStore.getDatabase();
            // Tier counts — `tier` column is added in Phase 56+ migrations.
            try {
              const rows = db
                .prepare(
                  `SELECT tier, COUNT(*) as n FROM memories GROUP BY tier`,
                )
                .all() as ReadonlyArray<{ tier: string | null; n: number }>;
              for (const r of rows) {
                tierCounts.total += r.n;
                if (r.tier === "hot") tierCounts.hot += r.n;
                else if (r.tier === "warm") tierCounts.warm += r.n;
                else if (r.tier === "cold") tierCounts.cold += r.n;
              }
            } catch {
              // Older agents may not yet have the tier column; total only.
              const row = db
                .prepare(`SELECT COUNT(*) as n FROM memories`)
                .get() as { n: number };
              tierCounts.total = row.n;
            }
            // Migration delta — vec_memories vs vec_memories_v2. Tables may
            // not exist; guard each.
            try {
              const v1 = db
                .prepare(`SELECT COUNT(*) as n FROM vec_memories`)
                .get() as { n: number };
              migrationDelta.vecMemoriesRows = v1.n;
            } catch {
              // table absent — leave null
            }
            try {
              const v2 = db
                .prepare(`SELECT COUNT(*) as n FROM vec_memories_v2`)
                .get() as { n: number };
              migrationDelta.vecMemoriesV2Rows = v2.n;
            } catch {
              // table absent — leave null
            }
          }
        } catch (err) {
          log.warn(
            { err, agent },
            "[F14] memory snapshot store probe failed; returning partial",
          );
        }

        // Last 5 dream/consolidation log entries from the daily dream-log
        // markdown files. Pattern from src/manager/dream-log-writer.ts.
        type ConsolidationEntry = {
          file: string;
          lastModified: string;
          sizeBytes: number;
        };
        const consolidations: ConsolidationEntry[] = [];
        if (cfg.memoryPath) {
          const dreamsDir = joinPath(cfg.memoryPath, "dreams");
          try {
            const { readdir: rd } = await import("node:fs/promises");
            const entries = await rd(dreamsDir);
            const mdFiles = entries.filter((e) => e.endsWith(".md"));
            const stats = await Promise.all(
              mdFiles.map(async (f) => {
                try {
                  const st = await fsStat(joinPath(dreamsDir, f));
                  return {
                    file: f,
                    lastModified: new Date(st.mtimeMs).toISOString(),
                    sizeBytes: st.size,
                  };
                } catch {
                  return null;
                }
              }),
            );
            for (const s of stats) {
              if (s) consolidations.push(s);
            }
            consolidations.sort((a, b) =>
              b.lastModified.localeCompare(a.lastModified),
            );
            consolidations.splice(5);
          } catch {
            // dreams dir absent — empty list
          }
        }

        return {
          agent,
          memoryPath: cfg.memoryPath ?? null,
          files,
          tierCounts,
          migrationDelta,
          consolidations,
          editAffordance: {
            available: false,
            // Operator-facing hint surfacing the CLI flow (per 116-DEFERRED
            // operator decision — in-UI editor is a separate follow-up
            // phase). UI renders this as a tooltip on each disabled "Edit"
            // button.
            hint: "In-UI editing is deferred. Use `clawcode memory edit <agent> <file>` (filesystem CLI flow) — see 116-DEFERRED.md for rationale.",
          },
        };
      }

      // F15 — dream-pass queue snapshot.
      //
      // Three data sources, each best-effort:
      //   1. Last 7 dream events from the per-agent dream-log markdown
      //      files (~/<memoryRoot>/dreams/YYYY-MM-DD.md). Each file may
      //      hold multiple "## [HH:MM UTC] Dream pass" sections; we
      //      grep-count headers + read the most-recent's metadata.
      //   2. Pending D-10 veto windows from dream-veto-pending.jsonl
      //      (createDreamVetoStore().list() reducing by runId to latest).
      //   3. Next scheduled fire — derived from the agent's resolved
      //      dream config (cfg.dream.idleMinutes). The cron scheduler IS
      //      now registered at daemon boot via `registerDreamCron` (one
      //      per dream-enabled agent — see the "dream-cron-wiring" block
      //      in startDaemon). We surface the configured idle cadence +
      //      the cfg.dream.* fields so the UI can render "next fire:
      //      ~Xh from now" using croner client-side parsing without
      //      round-tripping through the daemon for every refresh.
      case "get-dream-queue": {
        const agent = validateStringParam(params, "agent");
        const cfg = resolvedAgents.find((a) => a.name === agent);
        if (!cfg) {
          throw new ManagerError(`Agent not found: ${agent}`);
        }
        const { readFile: rf, stat: fsStat, readdir: rd } = await import(
          "node:fs/promises"
        );
        const { join: joinPath } = await import("node:path");

        // 1. Last 7 dream events
        type DreamEvent = {
          file: string;
          lastModified: string;
          headerCount: number; // number of "## " headers in the file
        };
        const events: DreamEvent[] = [];
        if (cfg.memoryPath) {
          const dreamsDir = joinPath(cfg.memoryPath, "dreams");
          try {
            const entries = await rd(dreamsDir);
            const mdFiles = entries.filter((e) => e.endsWith(".md"));
            for (const f of mdFiles) {
              try {
                const fpath = joinPath(dreamsDir, f);
                const st = await fsStat(fpath);
                const content = await rf(fpath, "utf8");
                const headerCount = (content.match(/^## /gm) ?? []).length;
                events.push({
                  file: f,
                  lastModified: new Date(st.mtimeMs).toISOString(),
                  headerCount,
                });
              } catch {
                // skip unreadable
              }
            }
            events.sort((a, b) =>
              b.lastModified.localeCompare(a.lastModified),
            );
            events.splice(7);
          } catch {
            // ENOENT — no dreams yet
          }
        }

        // 2. Pending D-10 veto windows. Lazy import to avoid cost when no
        //    veto path has ever fired.
        type VetoWindow = {
          runId: string;
          agentName: string;
          candidateCount: number;
          deadline: number;
          isPriorityPass: boolean;
          status: string;
          scheduledAt: string;
        };
        const pending: VetoWindow[] = [];
        try {
          const { createDreamVetoStore } = await import(
            "./dream-veto-store.js"
          );
          const store = createDreamVetoStore();
          const rows = await store.list();
          // Reduce by runId to latest row, then filter to pending matching
          // this agent.
          const byRunId = new Map<string, (typeof rows)[number]>();
          for (const r of rows) {
            byRunId.set(r.runId, r);
          }
          for (const r of byRunId.values()) {
            if (r.agentName === agent && r.status === "pending") {
              pending.push({
                runId: r.runId,
                agentName: r.agentName,
                candidateCount: r.candidates.length,
                deadline: r.deadline,
                isPriorityPass: r.isPriorityPass,
                status: r.status,
                scheduledAt: r.scheduledAt,
              });
            }
          }
        } catch (err) {
          log.warn(
            { err, agent },
            "[F15] dream-veto-store probe failed; returning empty pending list",
          );
        }

        // 3. Next-fire schedule — config-derived. The dream-cron scheduler
        //    fires when the agent has been idle for `idleMinutes` minutes.
        //    The schema doesn't carry a literal cron string; the UI renders
        //    "next fire: idle ≥ Xm" rather than a wall-clock countdown.
        //    retentionDays surfaces so the operator sees the consolidation
        //    horizon at a glance.
        const dreamConfig = cfg.dream
          ? {
              enabled: cfg.dream.enabled,
              idleMinutes: cfg.dream.idleMinutes,
              model: cfg.dream.model,
              retentionDays: cfg.dream.retentionDays ?? null,
            }
          : null;

        return {
          agent,
          events,
          pendingVetoWindows: pending,
          dreamConfig,
        };
      }

      // F15 — operator-fired veto on a D-10 pending window. The plan's
      // `:windowId` and the VetoStore's `runId` are the same identifier;
      // we use `runId` in the IPC contract for parity with the store.
      // Rationale is required (operator-supplied free text) and capped at
      // 200 chars defensively (same truncation the veto-store applies).
      case "veto-dream-run": {
        const runId = validateStringParam(params, "runId");
        const reason = validateStringParam(params, "reason");
        if (reason.length === 0) {
          throw new ManagerError("veto reason must be non-empty");
        }
        const { createDreamVetoStore } = await import(
          "./dream-veto-store.js"
        );
        const store = createDreamVetoStore();
        await store.vetoRun(runId, reason);
        log.info({ runId, reasonLen: reason.length }, "[F15] dream veto recorded");
        return { runId, vetoed: true, recordedAt: new Date().toISOString() };
      }

      // Phase 999.188 — operator approval: close the window and apply now.
      case "approve-dream-run": {
        const runId = validateStringParam(params, "runId");
        const rows = await dreamVetoStore.list();
        const target = rows.find((r) => r.runId === runId);
        if (!target) return { runId, applied: false, error: "unknown run id" };
        if (target.status !== "pending") {
          return { runId, applied: false, error: `run is ${target.status}, not pending` };
        }
        const approved = (await dreamVetoStore.approveRun?.(runId)) ?? false;
        if (!approved) return { runId, applied: false, error: "run is no longer pending" };
        const appliedNow = dreamVetoTick
          ? await dreamVetoTick.runOnce()
          : await dreamVetoStore.tick(new Date(), applyDreamVetoRow);
        const after = (await dreamVetoStore.list()).find((r) => r.runId === runId);
        log.info({ runId, status: after?.status, action: "dream-approve" }, "[dream] run approved from operator surface");
        if (after?.status === "applied") {
          return { runId, applied: true, report: `Applied dream run \`${runId}\` for ${target.agentName}: ${target.candidates.length} candidate${target.candidates.length === 1 ? "" : "s"} written to MEMORY.md (see the channel line).` };
        }
        return { runId, applied: appliedNow.includes(runId), error: after?.applyError ?? `run ended ${after?.status ?? "unknown"}` };
      }

      // Phase 116-postdeploy 2026-05-12 — list recent dream-pass artefacts
      // for the dashboard /memory page. Reads memory/dreams/*.md from the
      // target agent's memoryPath. Best-effort + ENOENT-tolerant: a fresh
      // agent with no dreams yet returns `{artifacts: []}` rather than
      // erroring. Body content is truncated to `previewChars` (default 800)
      // to keep IPC payloads small; the SPA renders the preview in a card
      // and an operator can open the file in their editor for the full text.
      case "list-dream-artifacts": {
        const agentName = validateStringParam(params, "agent");
        const limit =
          typeof params.limit === "number" && params.limit > 0
            ? Math.min(Math.floor(params.limit), 100)
            : 20;
        const previewChars =
          typeof params.previewChars === "number" && params.previewChars > 0
            ? Math.min(Math.floor(params.previewChars), 4000)
            : 800;
        const cfg = resolvedAgents.find((a) => a.name === agentName);
        if (!cfg) {
          throw new ManagerError(`Agent not found: ${agentName}`);
        }
        if (!cfg.memoryPath) {
          return { artifacts: [], memoryPath: null };
        }
        const { readdir, readFile, stat: fsStat } = await import(
          "node:fs/promises"
        );
        const { join: joinPath } = await import("node:path");
        // memoryPath is already the root that contains dreams/ + inbox/ as
        // direct children (cf. writeDreamLog in src/manager/dream-log-writer.ts
        // which joins `${memoryRoot}/dreams`, and the list-ipc-inboxes
        // handler above which joins `${memoryPath}/inbox`). Do NOT nest
        // another "memory" segment in between — that would silently return
        // empty results in production.
        const dreamsDir = joinPath(cfg.memoryPath, "dreams");
        let names: string[];
        try {
          names = await readdir(dreamsDir);
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code === "ENOENT") {
            return { artifacts: [], memoryPath: dreamsDir };
          }
          throw err;
        }
        const mdFiles = names.filter((n) => n.endsWith(".md"));
        // Sort by name descending — dream filenames are YYYY-MM-DD.md so a
        // lexicographic sort gives newest-first without a stat() each.
        mdFiles.sort((a, b) => b.localeCompare(a));
        const slice = mdFiles.slice(0, limit);
        const artifacts: Array<{
          file: string;
          path: string;
          date: string | null;
          sizeBytes: number;
          mtime: string | null;
          preview: string;
        }> = [];
        for (const name of slice) {
          const filePath = joinPath(dreamsDir, name);
          let st;
          try {
            st = await fsStat(filePath);
          } catch {
            continue;
          }
          let raw = "";
          try {
            raw = await readFile(filePath, "utf-8");
          } catch {
            // unreadable — push placeholder + size from stat
          }
          const dateMatch = name.match(/^(\d{4}-\d{2}-\d{2})/);
          const preview = raw
            ? raw.slice(0, previewChars) +
              (raw.length > previewChars ? "…" : "")
            : "";
          artifacts.push({
            file: name,
            path: filePath,
            date: dateMatch ? dateMatch[1]! : null,
            sizeBytes: st.size,
            mtime: new Date(st.mtimeMs).toISOString(),
            preview,
          });
        }
        return { artifacts, memoryPath: dreamsDir };
      }

      // =====================================================================
      // Phase 116-05 — Fleet-scale + cost IPC handlers (F16/F17).
      // Same closure-intercept convention as 116-03/116-04 above. Both
      // handlers read from already-open singletons (per-agent UsageTracker
      // via SessionManager + the daemon-scope EscalationBudget). No new
      // schema, no new singletons.
      //
      // F17 — cost dashboard:
      //   costs-daily    -> per-day cost rows for the trend chart.
      //   budget-status  -> EscalationBudget gauges (tokens) per agent
      //                     per model per period (daily + weekly).
      //
      // F16 reuses existing per-agent IPC routes — no new daemon surface.
      //
      // SCOPE CAVEAT: `getRunningAgents()` is used for both handlers, same
      // as the existing `costs` handler at line ~9201. UsageTracker
      // instances close on stopAgent; rebuilding them for historical reads
      // on stopped agents would mean opening usage.db from disk + caching.
      // Out of scope for 116-05; documented as a forward-pointer in the
      // SUMMARY. Operators viewing a 30d trend for a stopped agent will
      // see zero rows; restart the agent to surface its historical data.
      // =====================================================================

      case "costs-daily": {
        // F17 per-day cost trend rows. Params:
        //   days?  (number, 1..90, default 30) — window size in days,
        //          UTC-aligned from start-of-day (now - days+1) through now.
        //   agent? (string)                    — restrict to one agent
        // Returns: { days, since, until, rows: CostByDay[] }
        //
        // Each CostByDay row is one (date, agent, model) bucket. The
        // dashboard re-stacks client-side (per-agent OR per-model toggle).
        const rawDays = (params as { days?: unknown }).days;
        const days =
          typeof rawDays === "number" && Number.isFinite(rawDays)
            ? Math.max(1, Math.min(Math.floor(rawDays), 90))
            : 30;
        const agentFilter =
          typeof (params as { agent?: unknown }).agent === "string" &&
          (params as { agent: string }).agent.length > 0
            ? (params as { agent: string }).agent
            : null;
        const now = new Date();
        // UTC start-of-day(now - (days-1)) → inclusive lower bound covering
        // exactly `days` daily buckets.
        const sinceUtc = new Date(
          Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() - (days - 1),
            0,
            0,
            0,
            0,
          ),
        );
        const sinceIso = sinceUtc.toISOString();
        const untilIso = now.toISOString();

        const agentList = agentFilter
          ? [agentFilter]
          : manager.getRunningAgents();

        const rows: Array<{
          date: string;
          agent: string;
          model: string;
          tokens_in: number;
          tokens_out: number;
          cost_usd: number;
        }> = [];
        for (const agentName of agentList) {
          const tracker = manager.getUsageTracker(agentName);
          if (!tracker) continue;
          const dayRows = tracker.getCostsByDay(sinceIso, untilIso);
          for (const r of dayRows) {
            rows.push({
              date: r.date,
              agent: r.agent,
              model: r.model,
              tokens_in: r.tokens_in,
              tokens_out: r.tokens_out,
              cost_usd: r.cost_usd,
            });
          }
        }
        return {
          days,
          since: sinceIso,
          until: untilIso,
          rows,
        };
      }

      case "budget-status": {
        // F17 budget gauges. Returns one row per (agent, model, period)
        // pairing the configured token limit with the current period's
        // tokens_used. Models with no limit configured are omitted (no
        // gauge to render). Periods covered: daily + weekly (the two
        // EscalationBudget natively tracks).
        //
        // UNITS: TOKENS (matches schema). The dashboard renders these on a
        // separate row from the USD spend cards. Conversion to USD would
        // need a model-pricing lookup per row — defensible alternative but
        // we keep this contract token-native to match the underlying
        // AgentBudgetConfig surface. See 116-05-SUMMARY decisions.
        const rows: Array<{
          agent: string;
          model: string;
          period: "daily" | "weekly";
          tokens_used: number;
          tokens_limit: number;
          pct: number;
          status: "ok" | "warning" | "exceeded";
        }> = [];
        for (const [agent, cfg] of budgetConfigs.entries()) {
          for (const period of ["daily", "weekly"] as const) {
            const periodCfg = cfg[period];
            if (!periodCfg) continue;
            for (const model of ["sonnet", "opus"] as const) {
              const limit = periodCfg[model];
              if (typeof limit !== "number" || limit <= 0) continue;
              const used = escalationBudget.getUsageForPeriod(
                agent,
                model,
                period,
              );
              const pct = limit > 0 ? used / limit : 0;
              let status: "ok" | "warning" | "exceeded" = "ok";
              if (pct >= 1.0) status = "exceeded";
              else if (pct >= 0.8) status = "warning";
              rows.push({
                agent,
                model,
                period,
                tokens_used: used,
                tokens_limit: limit,
                pct,
                status,
              });
            }
          }
        }
        return { rows };
      }
      // === end Phase 116-05 IPC handlers ===

      // =====================================================================
      // Phase 116-06 — Tier 3 polish + cutover IPC handlers (F18/F20/F22/F23
      // + telemetry). Same closure-intercept convention as the earlier 116-XX
      // blocks. T01 (heatmaps) reads from per-agent TraceStore singletons via
      // manager.getTraceStore(). T04 (audit) appends to a JSONL via the
      // DashboardAuditTrail singleton wired into the dashboard server. T07
      // (telemetry) reuses the same audit infrastructure with an "action"
      // discriminator so we don't multiply on-disk JSONL files.
      //
      // F19 swim-lane DEFERRED OUT OF PHASE 116 (see 116-DEFERRED.md).
      // =====================================================================

      case "activity-by-day": {
        // F18 (per-agent) + F22 (fleet) — calendar-grid activity heatmap.
        // Params:
        //   days? (number, 1..90, default 30) — window size; UTC-aligned
        //                                       start-of-day(now - days+1).
        //   agent? (string)                   — restrict to one agent.
        // Returns: { days, since, until, rows: [{date, agent, turn_count}] }
        //
        // SCOPE NOTE: getTraceStore returns the per-agent TraceStore for
        // every agent the daemon has spun up since boot (including stopped
        // agents whose stores haven't closed). We iterate the agentList
        // (resolved agents — every agent in clawcode.yaml, running or not)
        // so the fleet aggregate reflects ALL configured agents that have
        // recorded turns. An agent whose TraceStore hasn't initialized (no
        // turns ever) yields zero rows; the heatmap renders a blank lane.
        const rawDays = (params as { days?: unknown }).days;
        const days =
          typeof rawDays === "number" && Number.isFinite(rawDays)
            ? Math.max(1, Math.min(Math.floor(rawDays), 90))
            : 30;
        const agentFilter =
          typeof (params as { agent?: unknown }).agent === "string" &&
          (params as { agent: string }).agent.length > 0
            ? (params as { agent: string }).agent
            : null;
        const now = new Date();
        const sinceUtc = new Date(
          Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() - (days - 1),
            0,
            0,
            0,
            0,
          ),
        );
        const sinceIso = sinceUtc.toISOString();
        const untilIso = now.toISOString();

        const agentList = agentFilter
          ? [agentFilter]
          : resolvedAgents.map((a) => a.name);

        const rows: Array<{
          date: string;
          agent: string;
          turn_count: number;
        }> = [];
        for (const agentName of agentList) {
          const store = manager.getTraceStore(agentName);
          if (!store) continue;
          // activityByDay returns ALL agent rows in that DB filtered by
          // started_at. In ClawCode each agent owns its own traces.db so
          // every row legitimately belongs to `agentName`. We still echo
          // the row's `agent` column verbatim (defensive — survives any
          // future cross-agent traces.db restructure).
          for (const r of store.getActivityByDay(sinceIso)) {
            rows.push({
              date: r.date,
              agent: r.agent,
              turn_count: r.turn_count,
            });
          }
        }
        return {
          days,
          since: sinceIso,
          until: untilIso,
          rows,
        };
      }
      case "list-dashboard-audit": {
        // F23 — read the dashboard audit log tail. Filters: since (ISO
        // 8601), action (exact match), agent (target match), limit
        // (default 500, max 5000). Returns rows DESCENDING by timestamp
        // so the F23 viewer renders the freshest at the top.
        if (!dashboardAuditTrail) {
          return { rows: [], filePath: null };
        }
        const opts: {
          since?: string;
          action?: string;
          target?: string;
          limit?: number;
        } = {};
        const sinceRaw = (params as { since?: unknown }).since;
        if (typeof sinceRaw === "string" && sinceRaw.length > 0) {
          opts.since = sinceRaw;
        }
        const actionRaw = (params as { action?: unknown }).action;
        if (typeof actionRaw === "string" && actionRaw.length > 0) {
          opts.action = actionRaw;
        }
        const agentRaw = (params as { agent?: unknown }).agent;
        if (typeof agentRaw === "string" && agentRaw.length > 0) {
          opts.target = agentRaw;
        }
        const limitRaw = (params as { limit?: unknown }).limit;
        if (typeof limitRaw === "number" && Number.isFinite(limitRaw)) {
          opts.limit = limitRaw;
        }
        const rows = await dashboardAuditTrail.listActions(opts);
        return { rows, filePath: dashboardAuditTrail.getFilePath() };
      }

      case "dashboard-telemetry-summary": {
        // T07 — count v2 page-view + error events in the last 24h. Drives
        // the small "v2 page views: N · errors: M" badge.
        if (!dashboardAuditTrail) {
          return {
            pageViews24h: 0,
            errors24h: 0,
            since: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
          };
        }
        return dashboardAuditTrail.telemetrySummary24h();
      }
      // === end Phase 116-06 IPC handlers ===
    }

    // Phase 999.154 — on-demand vision canary (deploy verification) and the
    // WS-5 contamination cleanup (dry-run unless `apply: true`). Both run
    // in-daemon: it owns the DB handles and the embed worker.
    if (method === "vision-canary") {
      const service = getVisionService();
      if (service === null) return { ok: false, reason: "vision service not configured" };
      const outcome = await service.runCanary();
      return {
        ok: [...outcome.values()].every(Boolean),
        providers: Object.fromEntries(outcome),
        health: Object.fromEntries(service.providerIds.map((id) => [id, service.health.get(id)])),
      };
    }
    if (method === "vision-cleanup") {
      // Destructive + returns excerpts from EVERY agent's memory: operator CLI
      // (source:"cli") or a verified admin agent only — same gate as the
      // other admin-gated mutations. Agents reach the socket via Bash.
      const cleanupCallerRaw = params[CALLER_AGENT_PARAM];
      const cleanupCaller = typeof cleanupCallerRaw === "string" ? cleanupCallerRaw : undefined;
      if (cleanupCaller !== undefined) enforceAgentIdentity(params, cleanupCaller);
      const cleanupAdmin =
        cleanupCaller !== undefined &&
        resolvedAgents.some((a) => a.name === cleanupCaller && a.admin === true);
      if (params.source !== "cli" && !cleanupAdmin) {
        throw new ManagerError("vision-cleanup requires the operator CLI (source:cli) or an admin agent");
      }
      const only = typeof params.agent === "string" && params.agent.length > 0 ? params.agent : null;
      const apply = params.apply === true;
      if (only !== null && !resolvedAgents.some((a) => a.name === only)) {
        throw new ManagerError(`vision-cleanup: unknown agent '${only}'`);
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const seen = new Set<string>();
      const reports: unknown[] = [];
      for (const agent of resolvedAgents) {
        if (only !== null && agent.name !== only) continue;
        const store = manager.getMemoryStore(agent.name);
        if (!store) {
          reports.push({ agent: agent.name, skipped: "no memory store (agent not running)" });
          continue;
        }
        const db = store.getDatabase();
        if (seen.has(db.name)) continue; // shared DB — cleaned once
        seen.add(db.name);
        const report = await cleanupVisionContamination(db, {
          apply,
          backupPath: `${db.name}.bak-999154-${stamp}`,
          embed: (texts, includeV1) => embedWorkerClient.embedBothVersions(texts, includeV1),
        });
        log.info({ tag: "phase999.154-cleanup", agent: agent.name, ...report, samples: undefined }, "vision cleanup");
        reports.push({ agent: agent.name, ...report });
      }
      return { apply, reports };
    }

    // Phase 999.176 — account status + OAuth code submission.
    if (isAccountIpcMethod(method)) {
      return handleAccountIpc(accountService, method, params);
    }

    return routeMethod(manager, resolvedAgents, method, params, routingTableRef, rateLimiter, heartbeatRunner, taskScheduler, skillsCatalog, threadManager, webhookManager, deliveryQueue, subagentThreadSpawner, allowlistMatchers, approvalLog, securityPolicies, escalationMonitor, advisorBudget, discordBridgeRef, configPath, config.defaults.basePath, taskManager, taskStore, schedulerSource, botDirectSenderRef, advisorService, config.defaults, compactionEventLog, thresholdAlerter, getLlmRuntime, failoverStateStore, agentChannelRegistry, goalManager, getCatalogSnapshot, a2aServices);
  };

  // 11. Create IPC server
  const server = createIpcServer(SOCKET_PATH, handler);

  // === P1 robust auto-ingest — boot wiring (image-overload fix) ===
  // Configure libvips globally before any image decode (P1-SHARP): 2 governor
  // slots × concurrency(1) = ≤2 active libvips threads daemon-wide.
  configureSharpAtBoot(log);
  // Single dedicated embed worker (P1-EMBED-WORKER) — keeps ONNX embedding off
  // the main event loop during ingest bursts. Construction NEVER throws into
  // startDaemon: a missing worker file or ONNX-load failure fails OPEN to
  // inline-on-main (reusing the daemon's existing embedder singleton, no extra
  // model copy). A crash-loop here would be strictly worse than the incident.
  const embedWorkerClient = new EmbedWorkerClient({
    log,
    getInlineEmbedder: () => manager.getEmbedder(),
  });
  if (embedWorkerClient.getMode() === "inline") {
    // 'inline' immediately after construction == the worker file was missing on
    // disk == a build/ship miss (tsup second-entry or deploy rsync line dropped).
    // Scream it so it's caught at deploy, not silently as a 2×-model RSS regression.
    log.error(
      { tag: "p1-embed-worker", reason: "embed_worker_missing_on_disk" },
      "embed worker file missing on disk at boot — auto-ingest will embed inline on the MAIN thread (DEGRADED). Verify dist/cli/embed-worker.js was built (tsup) and shipped (deploy-clawdy.sh).",
    );
  }
  // Phase 999.154 — vision provider chain (bridge-haiku → ocr-only) + real-
  // provider health canary. Boot-time only: `defaults.imageIngest` changes
  // take effect on the next daemon restart.
  const imageIngestConfig = resolveImageIngestConfig(config.defaults.imageIngest);
  const visionService = buildVisionService(imageIngestConfig, log);
  configureVisionService(visionService);
  visionService.startCanary(imageIngestConfig.canaryIntervalMin * 60_000);
  log.info(
    {
      tag: "phase999.154-vision",
      providers: imageIngestConfig.provider,
      batchSize: imageIngestConfig.batchSize,
      canaryIntervalMin: imageIngestConfig.canaryIntervalMin,
    },
    "vision service configured",
  );
  autoIngestQueue.archiveTtlDays = imageIngestConfig.archive.ttlDays;
  // Phase 999.154 WS-3 — one labeled vision call per upload burst.
  const ingestVisionBatcher = new IngestVisionBatcher({
    getService: getVisionService,
    peekQueued: (pred, limit) => autoIngestQueue.peekQueued(pred, limit),
    // The drain holds a decode slot around the whole handler; hand it back
    // while the ~20 s batch call is on the wire.
    releaseSlotDuring: withImageWorkSlotReleased,
    batchSize: imageIngestConfig.batchSize,
    log,
  });
  // Bounded never-drop ingest queue (P1-INGESTQ). The IPC case enqueues and
  // ACKs in µs; this drains serially through the image-work governor.
  autoIngestQueue.init({
    logger: log,
    getDocumentStore: (a) => manager.getDocumentStore(a),
    listIngestAgents: () =>
      resolvedAgents
        .filter((c) => c.autoIngestAttachments === true)
        .map((c) => ({ agent: c.name, memoryPath: c.memoryPath })),
    runHandler: (p) =>
      handleAutoIngestAttachment(p, {
        getDocumentStore: (a) => manager.getDocumentStore(a),
        getMemoryStore: (a) => manager.getMemoryStore(a),
        embedBoth: (texts, includeV1) =>
          embedWorkerClient.embedBothVersions(texts, includeV1),
        // Live read (honors hot-reload) — manager.getAgentConfig reads the
        // updated configs Map, not a boot snapshot.
        getAgentConfig: (a) => manager.getAgentConfig(a),
        logger: log,
        engine: ingestDocumentEngine,
        analyzeImage: (params) => ingestVisionBatcher.analyze(params),
        imageIngest: imageIngestConfig,
      }),
  });
  // Boot rescan (P1-RESCAN) — recover inbox files <24 h not yet ingested
  // (deferred-at-overflow, restart-lost, crashed-mid-ingest). Non-awaited so it
  // drains in the background without delaying boot; the queue's isTracked dedup
  // makes it race-safe against a concurrent live attachment.
  void autoIngestQueue.runRescanAll();
  // === end P1 robust auto-ingest boot wiring ===

  // 11. Resolve Discord bot token from config (COEX-01: no fallback to shared plugin token).
  //
  // Phase 104 — route through warmed cache + retry shim instead of an
  // inline execSync. preResolveAll above already populated the cache for
  // this URI on the happy path; resolve() here is either a free cache hit
  // OR a one-shot retry if pre-resolve failed for botToken specifically.
  // Critical-secret fail-closed contract preserved: any resolution failure
  // throws and refuses to start the Discord bridge.
  let botToken: string;
  if (config.discord?.botToken) {
    const raw = config.discord.botToken;
    if (raw.startsWith("op://")) {
      try {
        botToken = await secretsResolver.resolve(raw);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Failed to resolve Discord bot token from 1Password — refusing to start Discord bridge. `
            + `Reason: ${reason}. Fix: ensure 1Password CLI is authenticated (op signin) or set a literal token in clawcode.yaml discord.botToken`,
        );
      }
    } else {
      botToken = raw;
    }
  } else {
    botToken = "";
    log.warn("No discord.botToken configured — Discord bridge disabled");
  }

  // 999.149 — sinks for posting an agent's own reply into its own channel.
  // Resolved at DELIVERY time, never captured: webhookManager and the bot
  // sender are both late-bound, and a session built during the boot window
  // would otherwise hold `undefined` for its whole life.
  const agentTextSinks = (agentName: string): AgentTextSinks => ({
    webhookManager: () => webhookManager,
    botDirectSend: () => {
      const sender = botDirectSenderRef.current;
      return sender ? (channelId: string, content: string) => sender.sendText(channelId, content) : undefined;
    },
    channelId: () => routingTableRef.current.agentToChannels.get(agentName)?.[0],
  });

  // 11a. Create delivery queue for reliable outbound message delivery.
  // The deliverFn closure captures webhookManager and the Discord client ref
  // so the queue can send via webhook or channel.send with splitting.
  const deliveryDbPath = join(MANAGER_DIR, "delivery-queue.db");
  const deliveryDb = new Database(deliveryDbPath);
  const deliveryQueue = new DeliveryQueue({
    db: deliveryDb,
    deliverFn: async (agentName: string, channelId: string, content: string) => {
      // 2026-08-27 — final-delivery table planning for BOTH legs: wide
      // numeric grids become PNG cards (files) + a placeholder line, and the
      // remainder goes through formatOutboundText. Fail-open inside.
      const plan = await planOutboundTables(content, { log });
      // Try webhook delivery first -- but skip for thread channels since
      // webhooks deliver to the parent channel, not the thread (SATH-03).
      const isThreadChannel = !routingTableRef.current.channelToAgent.has(channelId);
      if (!isThreadChannel && webhookManager.hasWebhook(agentName)) {
        const sent = await webhookManager.sendWithFiles(agentName, plan.text, plan.files);
        // 999.63d/4 — retain per-chunk refs so a financial correction can
        // edit long deliveries in place instead of posting a note wall.
        // Only meaningful for multi-chunk sends but recorded for all —
        // the correction planner does its own matching. Fail-open.
        discordBridge?.recordChunkedDelivery({
          agentName,
          channelId,
          kind: "webhook",
          chunks: sent.chunks,
          messageIds: sent.messageIds,
        });
        return;
      }
      // Fallback: send via Discord client channel (thread channels and
      // webhook-less agents). 2026-08-27 — this leg used to send RAW content
      // with no formatOutboundText (documented drift): every table posted in
      // a thread showed literal pipes. It now delivers the same planned text
      // as the webhook leg (tables rendered, images attached), keeping its
      // bespoke newline/space splitter; it still records no chunk refs.
      if (discordBridge) {
        const client = discordBridge.discordClient;
        const channel = await client.channels.fetch(channelId);
        if (channel && "send" in channel && typeof channel.send === "function") {
          const MAX_LENGTH = 2000;
          const bespokeSplit = (body: string, max: number): string[] => {
            const out: string[] = [];
            let remaining = body;
            while (remaining.length > 0) {
              if (remaining.length <= max) {
                out.push(remaining);
                break;
              }
              // Split long messages at newlines or spaces
              let splitIdx = remaining.lastIndexOf("\n", max);
              if (splitIdx <= 0 || splitIdx < max / 2) {
                splitIdx = remaining.lastIndexOf(" ", max);
              }
              if (splitIdx <= 0 || splitIdx < max / 2) {
                splitIdx = max;
              }
              out.push(remaining.slice(0, splitIdx));
              remaining = remaining.slice(splitIdx).trimStart();
            }
            return out;
          };
          // 2026-08-27 — the trailing annotation block never straddles chunks.
          const chunks = splitKeepingAnnotations(plan.text, MAX_LENGTH, bespokeSplit);
          type SendOpts = { content: string; files?: Array<{ attachment: Buffer; name: string; description?: string }>; flags?: number };
          const sender = channel as { send: (c: string | SendOpts) => Promise<unknown> };
          const sentIds: string[] = [];
          for (let i = 0; i < chunks.length; i++) {
            const files = plan.files
              .filter((f) => chunkIndexForFile(chunks, f) === i)
              .map((f) => ({ attachment: f.attachment, name: f.name, ...(f.description ? { description: f.description } : {}) }));
            const sent = await sender.send({ content: chunks[i], ...(files.length > 0 ? { files } : {}), ...deliveryFlags() });
            const id = (sent as { id?: unknown } | null | undefined)?.id;
            if (typeof id === "string") sentIds.push(id);
          }
          // 2026-08-28 — this leg never recorded its message ids, so corrections
          // and the 🧾 button could not find thread/bot-leg deliveries.
          if (sentIds.length === chunks.length) {
            discordBridge?.recordChunkedDelivery({ agentName, channelId, kind: "bot", chunks, messageIds: sentIds });
          }
        }
      }
    },
    log,
  });
  log.info({ dbPath: deliveryDbPath }, "delivery queue initialized");

  // ---- Multi-platform messaging: Slack bridge ----
  // Independent of the Discord bridge below — Slack agents run the full turn
  // loop through the platform-neutral MessagingBridge + SlackAdapter. Fail-open:
  // a Slack startup error logs and continues (Discord + the daemon stay up).
  // Tokens accept op:// refs (same SecretsResolver path as discord.botToken).
  // Declared at function scope so the shutdown handler can stop it.
  // See .planning/multi-platform-messaging-PLAN.md.
  let slackMessagingBridge: MessagingBridge | null = null;
  {
    const slackEntries = resolvedAgents
      .filter((a) => a.slack !== undefined && a.slack.channels.length > 0)
      .map((a) => ({ name: a.name, channels: a.slack!.channels }));
    if (config.slack && slackEntries.length > 0) {
      try {
        const resolveToken = async (raw: string): Promise<string> =>
          raw.startsWith("op://") ? await secretsResolver.resolve(raw) : raw;
        const appToken = await resolveToken(config.slack.appToken);
        const slackBotToken = await resolveToken(config.slack.botToken);

        const slackRoutingTable = buildPlatformRoutingTable(slackEntries);
        const slackRoutingTableRef = { current: slackRoutingTable };

        const slackIdentityFor = (agentName: string): AgentIdentity => {
          const cfg = resolvedAgents.find((a) => a.name === agentName);
          return {
            displayName: cfg?.slack?.displayName ?? agentName,
            iconUrl: cfg?.slack?.iconUrl,
            iconEmoji: cfg?.slack?.iconEmoji,
          };
        };

        const slackAdapter = new SlackAdapter({ botToken: slackBotToken, appToken, log });
        slackMessagingBridge = new MessagingBridge({
          adapter: slackAdapter,
          routingTableRef: slackRoutingTableRef,
          turnDispatcher,
          identityResolver: slackIdentityFor,
          log,
        });
        await slackMessagingBridge.start();
        // Phase 145 WS3 (Plan 04) — publish the Slack bridge to the late-binding
        // ref so the ask-user-question text-fallback path can post via it.
        slackMessagingBridgeRef.current = slackMessagingBridge;
        log.info(
          { boundChannels: slackRoutingTable.channelToAgent.size },
          "Slack bridge started",
        );
      } catch (err) {
        log.error({ err }, "Slack bridge failed to start (continuing without Slack)");
        slackMessagingBridge = null;
      }
    } else if (config.slack && slackEntries.length === 0) {
      log.info("slack: configured but no agent has slack.channels — bridge idle");
    }
  }

  // 11b. Start Discord bridge to receive messages and route them to agent sessions.
  // The bridge connects to Discord via discord.js, listens for messages in bound
  // channels, and forwards them to agent sessions via sessionManager.forwardToAgent().
  // Agents respond via their inherited Discord MCP plugin (reply tool).
  let discordBridge: DiscordBridge | null = null;
  // Phase 135 Plan 02 — voice subsystem wiring.
  //
  // Construction order: bridge first (it owns the Discord client),
  // VoiceManager second (needs the client), then wire the bridge's
  // voiceManager field + the transcript dispatcher. The dispatcher
  // routes Deepgram final transcripts → bridge.handleVoiceTranscript,
  // which fail-closes on the VOICE_DEV_BYPASS_ACL env-gate until
  // Plan 03 lands the real ACL check.
  let voiceManager: import("../discord/voice/manager.js").VoiceManager | null = null;
  if (botToken && routingTable.channelToAgent.size > 0) {
    discordBridge = new DiscordBridge({
      routingTableRef,
      sessionManager: manager,
      turnDispatcher,
      // 2026-08-28 — restart-proof 🧾 verification ledgers (7-day retention).
      ledgerDbPath: join(MANAGER_DIR, "verification-ledger.db"),
      threadManager,
      deliveryQueue,
      securityPolicies,
      botToken,
      log,
      // Phase 140 Model B — route messages for v3 (claude-code-interactive)
      // agents over the ClawCode channel (push + awaitReply) instead of the v2
      // SDK dispatch. undefined for v2 agents → unchanged. Same registry the
      // ask-agent / post-to-agent IPC handlers use.
      getBridge: (agent) => agentChannelRegistry.get(agent)?.bridge,
      // Phase 117 Plan 117-11 T06 — share the boot-time VerboseState with the
      // bridge so the mutation point at bridge.ts:~810 reads the same
      // per-channel level state that the /clawcode-verbose IPC handler writes.
      verboseState,
      // Phase 116-03 F27 — fire `conversation-turn` SSE events after each
      // recordTurn write. Metadata only (NO content). Ref reads .current at
      // fire time so the post-startDashboardServer assignment is visible.
      onConversationTurn: (info) => {
        const sse = sseManagerRef.current;
        if (!sse) return;
        try {
          sse.broadcast("conversation-turn", info);
        } catch (err) {
          log.warn(
            { err, agent: info.agent, turnId: info.turnId },
            "[F27] SSE conversation-turn broadcast failed (non-fatal)",
          );
        }
      },
    });

    // Phase 135 Plan 02 — construct VoiceManager + wire into the bridge
    // BEFORE `bridge.start()` so the bridge's `client.on("ready")`
    // handler (which calls `voiceManager.autoJoin()`) sees the wired
    // manager. The transcript dispatcher routes Deepgram finals →
    // bridge.handleVoiceTranscript (Plan 03 wires the real ACL gate
    // here via enforceVoiceChannelAcl).
    //
    // Phase 135 Plan 03 — also wire the cap-warning sink. On monthly
    // cap hit, VoiceManager.checkCapAndDisconnectIfNeeded calls this
    // sink to post a warning to the agent's text channel.
    {
      const { VoiceManager } = await import("../discord/voice/manager.js");
      const { dispatchTranscriptToAgent } = await import("../discord/voice/ingress.js");
      voiceManager = new VoiceManager(
        discordBridge.discordClient,
        log,
        resolvedAgents,
      );
      const bridgeForVoice = discordBridge;
      voiceManager.setTranscriptDispatcher(
        async (session, transcript, voiceUserId, sttTiming) => {
          await dispatchTranscriptToAgent(
            bridgeForVoice,
            session,
            transcript,
            voiceUserId,
            log,
            sttTiming,
          );
        },
      );
      // Phase 135.1 — barge-in ACL gate: only channel-allowed speakers may
      // interrupt the agent. Mirrors the transcript-dispatch wiring.
      voiceManager.setBargeInAcl((agentName, channelId, voiceUserId) =>
        bridgeForVoice.voiceBargeInAllowed(agentName, channelId, voiceUserId),
      );
      // 999.116 hotfix — the join greeting speaks through the same HTTP TTS
      // path as replies (no trace: it is not an answer).
      voiceManager.setGreetingSpeaker(async (session, text) => {
        const { speakResponse } = await import("../discord/voice/tts.js");
        await speakResponse(session, text);
      });
      voiceManager.setCapWarningSink(async (agentName, capMinutes) => {
        try {
          const channels = routingTable.agentToChannels.get(agentName) ?? [];
          const channelId = channels[0];
          if (!channelId) {
            log.warn(
              { agent: agentName },
              "voice cap-hit but agent has no text channel — cannot post warning",
            );
            return;
          }
          const warning =
            `Voice monthly cap reached (${capMinutes} min). Disconnected from voice. `
            + `Will rejoin next month or after operator override.`;
          await bridgeForVoice.sendAgentMessageToChannel(agentName, channelId, warning);
        } catch (err) {
          log.error(
            { agent: agentName, error: err instanceof Error ? err.message : String(err) },
            "voice cap-warning post failed",
          );
        }
      });
      discordBridge.setVoiceManager(voiceManager);
      log.info(
        { voiceEnabledAgents: resolvedAgents.filter((a) => a.voice?.channelId).length },
        "voice subsystem wired (VoiceManager + transcript dispatcher + cap-warning sink)",
      );
    }

    // 999.143 — transcription progress cards + completion delivery.
    // The Unraid trees are declared once, on the `transcribe` MCP server, so
    // that is the single source of truth; an agent owns a tree by listing
    // `transcribe` AND naming the tree in its directive. The tree name is the
    // routing key, so a tree is mapped to the agent whose name matches it, or
    // to the agent explicitly configured for it.
    const treeSpec = config.mcpServers?.transcribe?.env?.TRANSCRIBE_TREES;
    const trees = parseTreeMap(typeof treeSpec === "string" ? treeSpec : undefined);
    if (
      trees.size > 0 &&
      config.defaults.transcription?.watcher !== false &&
      config.defaults.transcription?.sshTarget !== undefined &&
      discordBridge
    ) {
      const bridgeForWatcher = discordBridge;
      const sshTarget = config.defaults.transcription.sshTarget;
      const treeToAgent = new Map<string, string>();
      for (const treeName of trees.keys()) {
        const explicit = config.defaults.transcription?.treeAgents?.[treeName];
        const byName = resolvedAgents.find((a) => a.name === treeName)?.name;
        const owner = explicit ?? byName;
        if (owner) treeToAgent.set(treeName, owner);
      }
      transcriptionWatcher = new TranscriptionWatcher(
        {
          poll: () => pollTrees(defaultSsh(sshTarget), trees),
          agentFor: (t, job) =>
            resolveAgent(
              {
                byTree: treeToAgent,
                // Optional job-prefix → agent routing for trees shared by
                // several agents.
                byJobPrefix: new Map(
                  Object.entries(config.defaults.transcription?.jobPrefixAgents ?? {}),
                ),
              },
              t, job,
            ),
          postCard: async (agent, spec) => {
            const r = await bridgeForWatcher.postCv2ToAgentChannel(agent, spec);
            return r.ok ? r.messageId : undefined;
          },
          editCard: async (agent, messageId, spec) => {
            await bridgeForWatcher.editCv2InAgentChannel(agent, messageId, spec);
          },
          deliver: async (agent, tree, job) =>
            deliverTranscript({
              agent, tree, job,
              root: trees.get(tree)!,
              sshTarget,
              manager,
              bridge: bridgeForWatcher,
              // 999.149 — the summary turn's reply has no bridge behind it to
              // post it. Without this sink it is computed and discarded, which
              // is precisely what happened on 09-16 and 09-17.
              postText: (a, text, reason) =>
                deliverAgentText({
                  agentName: a,
                  text,
                  reason,
                  sinks: agentTextSinks(a),
                  log,
                }),
              // 999.156 — finish the ORIGINAL request as a channel turn
              // replying to the message that carried the audio, and make the
              // transcript retrievable.
              findRequest: async (a, j) => {
                const mem = manager.getAgentConfig(a)?.memoryPath;
                return mem ? findTranscriptRequest(mem, j) : undefined;
              },
              runChannelTurn: (a, request, prompt) =>
                bridgeForWatcher.runFollowUpTurn({
                  agent: a,
                  channelId: request.channelId,
                  messageId: request.messageId,
                  prompt,
                  label: "transcript",
                }),
              ingest: (a, path, request) => {
                const result = autoIngestQueue.enqueue({
                  agent: a,
                  file_path: path,
                  filename: path.split("/").pop() ?? path,
                  mime_type: "text/plain",
                  size: 0,
                  vision_analysis: null,
                  channel_id: request?.channelId ?? "",
                  message_id: request?.messageId ?? "",
                  user_id: request?.authorId ?? "",
                  user_name: request?.authorName ?? "",
                  origin: "transcript",
                });
                log.info({ agent: a, path, result }, "transcript queued for document ingest");
              },
              withTyping: (a, fn) => bridgeForWatcher.withTypingInAgentChannel(a, fn),
              log,
            }),
          log,
        },
        config.defaults.transcription?.pollSeconds
          ? config.defaults.transcription.pollSeconds * 1000
          : 15_000,
      );
      transcriptionWatcher.start();
      log.info(
        { trees: [...treeToAgent.entries()].map(([t, a]) => `${t}->${a}`) },
        "transcription watcher wired",
      );
    }

    try {
      await discordBridge.start();
      discordBridgeRef.current = discordBridge;
      log.info({ boundChannels: routingTable.channelToAgent.size }, "Discord bridge started");

      // Phase 141 — wire pre-turn <memory-context> auto-injection into the v3
      // (claude --channels) chat path. The v2 path gets it via TurnDispatcher;
      // v3 chat bypasses TurnDispatcher, so without this a v3 agent lost the
      // auto-retrieval reflex. Same retriever closure as TurnDispatcher
      // (getMemoryRetrieverForAgent) → identical behavior; applies to BOTH the
      // persistent push path and the warm-pool path. Fail-open inside augment().
      discordBridge.setMemoryContextAugmenter(
        new MemoryContextAugmenter({
          retriever: async (agentName, query) => {
            const retriever = manager.getMemoryRetrieverForAgent(agentName);
            if (!retriever) return [];
            return retriever(query);
          },
          // Phase 999.187 — same topic-shift rule as the v2 TurnDispatcher.
          queryEmbedder: (q: string) => manager.getEmbedder().embed(q),
          log,
        }),
      );

      // Phase 90.1 hotfix — wire bot-direct fallback into SessionManager so
      // Phase 89 restart greetings can fall back to plain bot-identity send
      // when per-agent webhooks are missing (MANAGE_WEBHOOKS missing / auto-
      // provisioner no-oped). Captures the bridge via closure.
      {
        const bridgeForGreeting = discordBridge;
        const botDirectImpl: import("./restart-greeting.js").BotDirectSender = {
          async sendEmbed(channelId, embed) {
            const channel = await bridgeForGreeting.discordClient.channels.fetch(channelId);
            if (!channel || !channel.isTextBased() || !("send" in channel)) {
              throw new Error(`channel ${channelId} is not a sendable text channel`);
            }
            // Phase 122 — wrap agent-generated description body before send.
            // setDescription mutates the embed in place so the same builder
            // is dispatched. Embed.data is always defined on a real
            // EmbedBuilder; optional-chain protects test doubles.
            const description = embed.data?.description;
            if (typeof description === "string" && description.length > 0) {
              embed.setDescription(formatOutboundText(description));
            }
            const msg = await (channel as import("discord.js").TextBasedChannel & { send: (opts: { embeds: import("discord.js").EmbedBuilder[] }) => Promise<{ id: string }> }).send({ embeds: [embed] });
            return msg.id;
          },
          // Phase 100 follow-up — plain-text bot-direct send. Mirrors the
          // sendEmbed shape but accepts a content string. Used as the
          // bot-identity fallback for TriggerEngine's deliveryFn when the
          // agent has no per-agent webhook provisioned. Phase 122 wraps
          // here so the Phase 119 A2A-01 bot-direct rung
          // (daemon-post-to-agent-ipc.ts:220) and the 999.12 ask-agent
          // mirror (daemon-ask-agent-ipc.ts:286) both inherit the wrap.
          async sendText(channelId, content) {
            const channel = await bridgeForGreeting.discordClient.channels.fetch(channelId);
            if (!channel || !channel.isTextBased() || !("send" in channel)) {
              throw new Error(`channel ${channelId} is not a sendable text channel`);
            }
            const wrapped = formatOutboundText(content);
            const msg = await (channel as import("discord.js").TextBasedChannel & { send: (opts: { content: string }) => Promise<{ id: string }> }).send({ content: wrapped });
            return msg.id;
          },
          // INC-2026-08-10 - one message carrying the workflow summary and its
          // two report PDFs. Same wrap as sendText (idempotent, so
          // pre-formatted callers are unaffected) so the two senders cannot
          // drift. NOTE: `content` here does NOT pass through splitMessage -
          // Discord rejects the whole message over 2000 chars, which is why
          // the workflow summary is hard-capped below that.
          async sendFiles(channelId, content, files) {
            const channel = await bridgeForGreeting.discordClient.channels.fetch(channelId);
            if (!channel || !channel.isTextBased() || !("send" in channel)) {
              throw new Error(`channel ${channelId} is not a sendable text channel`);
            }
            const wrapped = formatOutboundText(content);
            const msg = await (channel as import("discord.js").TextBasedChannel & {
              send: (opts: {
                content: string;
                files: { attachment: Buffer; name: string }[];
              }) => Promise<{ id: string }>;
            }).send({
              content: wrapped,
              files: files.map((f) => ({ attachment: f.data, name: f.name })),
            });
            return msg.id;
          },
          // 999.103 WS-1 - in-place edit of a bot-identity message (todo-card
          // fallback leg). Same wrap as sendText so the two cannot drift.
          async editText(channelId, messageId, content) {
            const channel = await bridgeForGreeting.discordClient.channels.fetch(channelId);
            if (!channel || !channel.isTextBased() || !("messages" in channel)) {
              throw new Error(`channel ${channelId} is not a text channel`);
            }
            const wrapped = formatOutboundText(content);
            const msg = await (channel as import("discord.js").TextBasedChannel & {
              messages: { fetch: (id: string) => Promise<{ edit: (c: string) => Promise<unknown> }> };
            }).messages.fetch(messageId);
            await msg.edit(wrapped);
          },
          // 999.173 - reply under the originating message (research synthesis).
          // Same wrap as sendText. fail_if_not_exists=false: a deleted origin
          // degrades to a plain post instead of a failed delivery; no pings.
          async sendReply(channelId, content, replyToMessageId) {
            const channel = await bridgeForGreeting.discordClient.channels.fetch(channelId);
            if (!channel || !channel.isTextBased() || !("send" in channel)) {
              throw new Error(`channel ${channelId} is not a sendable text channel`);
            }
            const wrapped = formatOutboundText(content);
            const msg = await (channel as import("discord.js").TextBasedChannel & {
              send: (opts: {
                content: string;
                reply: { messageReference: string; failIfNotExists: boolean };
                allowedMentions: { parse: never[]; repliedUser: boolean };
              }) => Promise<{ id: string }>;
            }).send({
              content: wrapped,
              reply: { messageReference: replyToMessageId, failIfNotExists: false },
              allowedMentions: { parse: [], repliedUser: false },
            });
            return msg.id;
          },
        };
        manager.setBotDirectSender(botDirectImpl);
        // Phase 999.173 — research card port (bot identity, raw REST, reply to
        // the originating message). Trackers paint through it; absent = no card.
        setResearchCardPort(makeResearchCardPort(bridgeForGreeting.discordClient.rest as never, icons));
        // 999.178 — background-work card + wake typing (BackgroundTaskBoard).
        setBackgroundCardPort(
          makeBackgroundCardPort(bridgeForGreeting.discordClient.rest as never, (name) => icons.inline(name)),
        );
        // Phase 999.173 polish — usage-aware research launch guard. Primary
        // signal (2026-09-26): LIVE claude.ai plan usage, the data behind
        // `/usage`, asked of any running agent every 5 minutes (one shared
        // account). Fallback when no fresh answer: every agent's SDK
        // rate_limit_event snapshots (the guard drops a previous account's).
        const planUsageProbe = new PlanUsageProbe(
          () =>
            resolvedAgents.flatMap((a) => {
              const h = manager.getSessionHandle(a.name);
              return h?.getPlanUsage ? [() => h.getPlanUsage!()] : [];
            }),
          log,
        );
        const planUsageTimer = setInterval(() => void planUsageProbe.refresh(), 5 * 60 * 1000);
        planUsageTimer.unref?.();
        // Sessions resume ~5-30 s after boot; ask early so research launched
        // right after a restart is guarded, and again in case none was up yet.
        setTimeout(() => void planUsageProbe.refresh(), 30_000).unref?.();
        setTimeout(() => void planUsageProbe.refresh(), 90_000).unref?.();
        setActivePlanUsageProbe(planUsageProbe);
        setResearchUsageProvider(() => {
          const live = planUsageProbe.fresh();
          if (live) return live;
          void planUsageProbe.refresh();
          return resolvedAgents.flatMap((a) => manager.getRateLimitTrackerForAgent(a.name)?.getAllSnapshots() ?? []);
        });
        // Phase 999.117 WS-4 — reaction sender for A2A receipts. Adding a
        // checkmark to the message being acknowledged replaces a whole
        // standalone "✅ X processed your message" post. Best-effort by
        // design: a failed reaction falls back to the text notification, and
        // must never be able to fail a delivery.
        a2aReactionSenderRef.current = {
          react: async (channelId: string, messageId: string, emoji: string) => {
            const channel =
              await bridgeForGreeting.discordClient.channels.fetch(channelId);
            if (!channel || !channel.isTextBased() || !("messages" in channel)) {
              throw new Error(`channel ${channelId} cannot hold reactions`);
            }
            const msg = await (
              channel as import("discord.js").TextBasedChannel & {
                messages: { fetch: (id: string) => Promise<{ react: (e: string) => Promise<unknown> }> };
              }
            ).messages.fetch(messageId);
            await msg.react(emoji);
          },
        };
        // Phase 100 follow-up — also expose to the TriggerEngine deliveryFn.
        botDirectSenderRef.current = botDirectImpl;
      }

      // Auto-provision webhooks for agents without manual webhookUrl
      const allWebhookIdentities = await provisionWebhooks({
        client: discordBridge.discordClient,
        agents: resolvedAgents,
        manualIdentities: manualWebhookIdentities,
        log,
      });
      // Phase 119 A2A-02 — reprovisioner closure for the 401/404 recovery
      // path in WebhookManager.sendAsAgent. Bounded to the resolved-agent
      // snapshot at boot — runtime config reloads do NOT update this closure
      // (a daemon restart already covers the YAML-change path). Returns
      // undefined when the agent has no channel binding or provisioning
      // throws — caller surfaces the original 401/404.
      const bridgeForReprovision = discordBridge;
      const reprovisionWebhook = async (agentName: string) => {
        const agentCfg = resolvedAgents.find((a) => a.name === agentName);
        if (!agentCfg?.webhook?.displayName) return undefined;
        const channelId = agentCfg.channels[0];
        if (!channelId) return undefined;
        const status = await verifyAgentWebhookIdentity({
          client: bridgeForReprovision.discordClient,
          agentName,
          channelId,
          displayName: agentCfg.webhook.displayName,
          avatarUrl: agentCfg.webhook.avatarUrl,
          log,
        });
        if (status.status === "missing") return undefined;
        return {
          displayName: status.displayName,
          avatarUrl: agentCfg.webhook.avatarUrl,
          webhookUrl: status.webhookUrl,
        };
      };
      webhookManager = new WebhookManager({
        identities: allWebhookIdentities,
        log,
        reprovisionWebhook,
      });
      discordBridge.setWebhookManager(webhookManager);
      // Phase 999.117 WS-2 — shared dedupe for the webhook-relay consumer.
      discordBridge.setDeliveryDedupe(a2aDeliveryDedupe);
      // Phase 999.144 — inbound-channel auth: envelope HMAC mode + human
      // allowlist. Default shadow (verify + log, always deliver) so the
      // first deploy surfaces any unsigned legacy path in the logs before
      // enforce is flipped in config. Boot-applied like the governor.
      discordBridge.setIngressAuth({
        envelopeAuthMode: config.defaults?.a2a?.envelopeAuth ?? "shadow",
        allowedUserIds: config.discord?.allowedUserIds,
      });
      log.info(
        { total: allWebhookIdentities.size, manual: manualWebhookIdentities.size, autoProvisioned: allWebhookIdentities.size - manualWebhookIdentities.size },
        "webhook manager initialized with auto-provisioned identities",
      );

      // Phase 90 Plan 07 WIRE-05 — per-agent webhook identity probe.
      // provisionWebhooks above does the heavy lifting; this loop surfaces
      // per-agent {verified|provisioned|missing} status in the log so
      // operators can spot-check at boot. Fire-and-forget — probe failures
      // are logged but never block daemon startup.
      for (const agent of resolvedAgents) {
        if (!agent.webhook?.displayName) continue;
        const channelId = agent.channels[0];
        void verifyAgentWebhookIdentity({
          client: discordBridge.discordClient,
          agentName: agent.name,
          channelId,
          displayName: agent.webhook.displayName,
          avatarUrl: agent.webhook.avatarUrl,
          log,
        })
          .then((status) =>
            log.info(
              { agent: agent.name, status },
              "webhook identity probe",
            ),
          )
          .catch((err) =>
            log.warn(
              { agent: agent.name, error: (err as Error).message },
              "webhook identity probe failed (non-fatal)",
            ),
          );
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error({ error: msg }, "Discord bridge failed to start");
      discordBridge = null;
      // Fallback: create webhook manager with manual-only identities
      webhookManager = new WebhookManager({ identities: manualWebhookIdentities, log });
      log.info({ webhooks: manualWebhookIdentities.size }, "webhook manager initialized (manual only, bridge failed)");
    }
  } else {
    log.warn("Discord bridge not started (no bot token or no channel bindings)");
    webhookManager = new WebhookManager({ identities: manualWebhookIdentities, log });
    log.info({ webhooks: manualWebhookIdentities.size }, "webhook manager initialized (manual only, no bridge)");
  }

  // Phase 89 GREET-01 — wire webhook DI into SessionManager now that both
  // are constructed (SessionManager at line ~1014, WebhookManager above in
  // all three branches: Discord-up success path, Discord-start failure
  // fallback, no-bot-token/no-bindings path). Before this call, restartAgent
  // greetings are no-ops. Exactly one call, post-convergence.
  manager.setWebhookManager(webhookManager);

  // Phase 130 Plan 03 T-01 — fire-and-forget Discord notification per agent
  // for any skills that the Plan 02 manifest loader refused at boot.
  // Single emission point: the unloadedSkillsByAgent map is sealed once
  // at boot (no hot-reload yet for this surface — D-06 reload-on-edit
  // belongs to a follow-up plan). Fire-and-forget per Phase 89 canary —
  // boot continues regardless of webhook delivery outcome.
  notifyUnloadedSkills({ unloadedSkillsByAgent, webhookManager, log });

  // Phase 100 follow-up — also expose to the TriggerEngine deliveryFn
  // closure constructed earlier at boot (~line 1935). The closure reads
  // `.current` lazily at trigger-fire time, so this single post-convergence
  // assignment covers all three webhook-construction branches above.
  webhookManagerRef.current = webhookManager;

  // 999.103 WS-1 — construct the TodoWrite mirror now that the webhook
  // manager exists. Config is read LIVE per update (reload-friendly: flipping
  // `todoMirror.enabled` in the YAML takes effect on the next TodoWrite, no
  // restart). The editor prefers the agent's masking webhook; a webhook-less
  // agent falls back to bot-direct sendText+editText when available.
  {
    const { TodoMirror } = await import("../discord/todo-mirror.js");
    const { makeWebhookEditFn } = await import("../discord/webhook-manager.js");
    const { ProgressiveMessageEditor } = await import("../discord/streaming.js");
    todoMirrorRef.current = new TodoMirror({
      logger: log,
      getConfig: (agent) => {
        const cfg = resolvedAgents.find((a) => a.name === agent);
        // Unknown session names (workflow workers `<parent>-sub-<id>`, dream
        // passes) have no config entry → disabled by construction.
        if (!cfg) return { enabled: false, minItems: 2 };
        const knob = cfg.todoMirror ?? config.defaults.todoMirror;
        return {
          enabled: knob?.enabled ?? false,
          minItems: knob?.minItems ?? 2,
        };
      },
      makeEditor: (agent) => {
        // Webhook path — the agent's own identity, first-class edit API.
        if (webhookManager.hasWebhook(agent)) {
          const editFn = makeWebhookEditFn(webhookManager, agent);
          return new ProgressiveMessageEditor({
            editFn,
            log,
            agent,
            turnId: `todo-${Date.now()}`,
          });
        }
        // Bot-direct fallback — needs the editText leg (999.103 WS-1).
        const sender = botDirectSenderRef.current;
        const channelId = routingTableRef.current.agentToChannels.get(agent)?.[0];
        if (sender?.editText && channelId) {
          const senderRef = sender;
          let messageId: string | null = null;
          const editFn = async (content: string): Promise<void> => {
            if (messageId === null) {
              messageId = await senderRef.sendText(channelId, content);
              return;
            }
            await senderRef.editText!(channelId, messageId, content);
          };
          return new ProgressiveMessageEditor({
            editFn,
            log,
            agent,
            turnId: `todo-${Date.now()}`,
          });
        }
        return null;
      },
    });
    log.info("todo mirror initialized (999.103 WS-1)");
  }

  // INC-2026-08-08 — ADMIN-ALERT-01 sentinel. Every daemon alert surface
  // (document-ingest fail-modes, MemoryGuard breaches, model-monitor
  // proposals, the 1P ratelimit monitor) funnels through postToAdminClawdy,
  // whose terminal leg is a pino line — SILENT by design. When the first two
  // legs broke, alerts were invisible for months and nothing said so. This one
  // boot line makes the live leg greppable. Wiring assertion only: no message
  // is sent (same no-side-effect shape as the A2A-01 sentinel below), and it
  // routes through the SAME selectAdminAlertLeg the delivery path uses, so
  // what it reports and what actually happens cannot drift.
  {
    const alertTarget = adminAlertTarget();
    const alertLeg = selectAdminAlertLeg({
      webhook: webhookManagerRef.current,
      botDirect: botDirectSenderRef.current,
      target: alertTarget,
    });
    const sentinelFields = {
      sentinel: "ADMIN-ALERT-01",
      leg: alertLeg,
      adminAgent: alertTarget.agentName ?? null,
      channelId: alertTarget.channelId,
      channelSource: alertTarget.channelSource,
    };
    // DEGRADED covers more than "no sender". The cascade's terminal leg is a
    // non-empty deployment constant, so channelId is NEVER empty and the leg
    // alone can never report the failure this sentinel exists to catch: a
    // renamed admin agent (the exact `admin-clawdy` vs `Admin Clawdy` mismatch
    // that silently killed every alert) still yields a routable-looking
    // bot-direct leg — pointed at a hardcoded channel that may not exist in
    // this guild. Treat "no admin agent resolved" and "fell through to the
    // deployment constant" as failures too.
    const alertDegraded =
      alertTarget.agentName === undefined ||
      alertTarget.channelSource === "deployment-constant";
    if (alertLeg === "pino-only") {
      log.warn(
        sentinelFields,
        "[ADMIN-ALERT-01-sentinel] FAIL — admin alerts will NOT reach Discord (pino only)",
      );
    } else if (alertDegraded) {
      log.warn(
        sentinelFields,
        `[ADMIN-ALERT-01-sentinel] DEGRADED — delivering via ${alertLeg} to an UNVERIFIED channel (no admin agent matched, or channel came from the deployment constant)`,
      );
    } else {
      log.info(
        sentinelFields,
        `[ADMIN-ALERT-01-sentinel] OK — admin alerts deliver via ${alertLeg}`,
      );
    }
  }

  // Phase 138 Plan 03 T-03 — construct the credit-threshold alerter ONCE,
  // now that WebhookManager has converged across all three branches. The
  // ThresholdAlerter constructor creates the `provider_alert_state` table
  // on `fleetAlertDb` (built at step 6a2a). The heartbeat-status IPC case
  // fires `void thresholdAlerter.evaluate(payload)` per heartbeat —
  // fire-and-forget, so the IPC response is never blocked on the Discord
  // round-trip. Discord delivery routes to the `admin-clawdy` channel.
  const { ThresholdAlerter } = await import("../usage/threshold-alerter.js");
  thresholdAlerter = new ThresholdAlerter({
    db: fleetAlertDb,
    webhookManager,
    logger: log,
  });
  log.info("phase138 threshold alerter initialized");

  // 11b2. Create SubagentThreadSpawner for IPC-driven subagent thread creation
  // 2026-05-08 hotfix: assignment-only (declaration moved up to step 4z to
  // end TDZ for early-IPC-request handlers — see comment there).
  subagentThreadSpawner = discordBridge
    ? new SubagentThreadSpawner({
        sessionManager: manager,
        // Phase 999.57 (2026-05-15) — required dep. The spawner upserts the
        // subagent's heartbeat-disabled config into the runner's local map
        // immediately after sessionManager.startAgent so the existing
        // runner.ts:271 gate fires for subagent sessions. heartbeatRunner
        // is constructed at line 3300 above, well before this point.
        heartbeatRunner,
        // Quick task 260520-qo5 (2026-05-20) — required dep. Fixes a
        // fleet-wide subagent-spawn regression introduced by commit
        // `0be63e0` (`feat(138-04): daemon wires per-agent resolver into
        // per-turn dispatch`). 138-04 made `getLlmRuntime` above throw
        // for any agent name absent from the boot-populated
        // `llmRuntimeRegistry`; subagent session names are never in it,
        // so every subagent spawn threw at `SdkSessionAdapter`
        // `loadSdkModule()`. This callback registers a per-subagent
        // resolver into `llmRuntimeRegistry` keyed by the subagent
        // session name BEFORE `startAgent` runs (the spawner enforces
        // the pre-startAgent ordering — see subagent-thread-spawner.ts).
        //
        // Credentials inheritance: the subagent inherits the PARENT
        // agent's OpenAI credentials. `openaiCredentialsRegistry` is
        // keyed by parent agent name; `.get(parentAgentName)` returns
        // `undefined` for parents without `providers.openai.apiKeyPath`,
        // which we pass through unchanged — matching the boot-loop
        // behaviour at the `resolvedAgents` loop above.
        //
        // Cleanup deferral: this hotfix does NOT add an
        // `unregisterLlmRuntime` counterpart. The leak is bounded — one
        // small Map entry (string key + closure) per subagent session,
        // and subagent sessions are finite per daemon uptime; a restart
        // clears them. De-registering at the `stopAgent` sites risks a
        // race against a still-needed late turn. See T-qo5-01 in the
        // plan's threat model.
        registerLlmRuntime: (
          name: string,
          subagentConfig: import("../shared/types.js").ResolvedAgentConfig,
          parentAgentName: string,
          // Phase 999.83-02 (Fix A) — optional first-turn input (the subagent's
          // task). The spawner passes `{ firstTurnInput: config.task }` only for
          // a v3 subagent WITH a task; forwarded into the resolver's deps so the
          // backend delivers it as the agent's first PTY turn-trigger.
          // Phase 999.86 — `deferFirstTurn` short-circuits both the warm-nudge
          // and the firstTurnInput so the pool's later PTY write is the
          // FIRST input claude sees (chat dispatcher delivers it then).
          opts?: { firstTurnInput?: string; deferFirstTurn?: boolean },
        ): void => {
          llmRuntimeRegistry.set(
            name,
            createAgentLlmRuntimeResolver(subagentConfig, {
              logger: log,
              openaiCredentials:
                openaiCredentialsRegistry.get(parentAgentName),
              failoverStateReader: failoverStateStore,
              firstTurnInput: opts?.firstTurnInput,
              deferFirstTurn: opts?.deferFirstTurn,
              // Phase 141 (C) — wire the live McpProcessTracker into SUBAGENT v3
              // supervisors too (parity with the main-agent resolver above).
              // Without it the subagent PTY pid is never registered, so
              // killAgentGroup(subName) is a no-op → archived/stalled subagents
              // never die (10h zombies → contention). ONLY the v3 backend reads it.
              mcpTracker,
              // Phase 999.98-03 (gap closure) — a v3 subagent configured with a
              // `<family>@latest` model resolves it over the live catalog snapshot
              // at spawn, same as the main-agent resolver. ONLY the v3 backend reads it.
              getCatalogSnapshot,
            }),
          );
        },
        registryPath: THREAD_REGISTRY_PATH,
        discordClient: discordBridge.discordClient,
        log,
        // Phase 99 sub-scope M (2026-04-26) — auto-relay subagent completion
        // to parent agent. When wired, the spawner fetches the subagent's
        // last reply on session-end and dispatches a synthetic turn to the
        // parent ("your subagent finished, summarize for the user"). The
        // parent's response posts in the main channel via the normal Discord
        // pipeline, closing the loop without operator intervention.
        turnDispatcher,
        // Inline-relay (2026-05-23) — when the subagent's verbatim final
        // reply fits in a single Discord message (no artifacts, not the
        // attachment-only sentinel), post it directly to the parent's
        // main channel instead of dispatching a parent-summary turn.
        // Production opt-in: tests default to false so existing
        // dispatch-path assertions stay valid without per-test updates.
        // Long deliverables, artifact-bearing turns, and attachment-
        // only outcomes still flow through the summary dispatch path.
        inlineRelayEnabled: true,
        // Phase 140 parity — v3 parent relay-back. When the relay target is a
        // v3 (claude-code-interactive) agent, push the completion summary over
        // its ClawCode channel instead of dispatchStream (which can't drive a
        // v3 agent's out-of-process turns). undefined for v2 parents → unchanged.
        getParentChannelBridge: (name) => agentChannelRegistry.get(name)?.bridge,
        // Phase 999.82-03 — dynamic subagent channel lifecycle. The spawner
        // wires a v3 subagent's bridge + sockets BEFORE startAgent (the
        // registry's backend gate filters out v2 subagents → null, no socket)
        // and tears them down on session end. Unlike boot-wired bridges
        // (daemon lifetime), a dynamic subagent bridge MUST be unwired or it
        // leaks two listeners per spawn. Mirrors the getParentChannelBridge
        // resolver injection above; uses the SAME registry instance the daemon
        // already owns from the Plan 140 boot wiring.
        wireChannelForSubagent: (cfg) => agentChannelRegistry.wireForConfig(cfg),
        unwireChannelForSubagent: (name) =>
          agentChannelRegistry.unwireForAgent(name),
      })
    : null;
  if (subagentThreadSpawner) {
    log.info("subagent thread spawner initialized");
    // Debug session `stale-turn-watchdog-miss` (999.64 RECURRENCE) gap #3
    // — wire the heartbeat stale-turn sweep's post-force-release hook to
    // the spawner's typing-indicator cleanup. When the sweep force-
    // releases a wedged subagent turn, it also clears that subagent's
    // stuck Discord typing indicator (the turn lock and the typing loop
    // are independent lifecycles; `postInitialMessage`'s `finally` never
    // runs when the SDK turn hangs forever). Bound here, after the
    // spawner exists, mirroring setThreadManager / setActiveStateProvider.
    const spawnerForTyping = subagentThreadSpawner;
    heartbeatRunner.setStaleTurnReleaseCallback((sessionName: string) => {
      spawnerForTyping.stopTypingForSession(sessionName);
    });
  }

  // Phase 145 WS2 (Plan 05) — construct the background workflow orchestrator.
  // Built here (AFTER the spawner) so it reuses the SAME registerLlmRuntime
  // wiring the spawner uses (per-worker resolver into llmRuntimeRegistry keyed
  // by the worker session name, registered BEFORE startAgent). It is ADDITIVE +
  // INERT: nothing runs until an agent invokes the `start_workflow` MCP tool,
  // so the existing fleet is byte-identical. The instance is shared (via
  // workflowOrchestratorRef) with Plan 06's barrier + progress tick.
  workflowOrchestratorRef.current = new WorkflowOrchestrator({
    startAgent: (name, cfg) => manager.startAgent(name, cfg),
    // 999.109 review (CRITICAL) — register each worker's config with the
    // heartbeat runner so its `heartbeat.enabled: false` gate actually
    // applies (additive upsert, same call the subagent-thread spawner
    // makes). Without this the runner's per-agent lookup is undefined and
    // the full check loop — inbox 5-min force-release + parent-inbox drain
    // — runs against every workflow worker.
    registerHeartbeatConfig: (cfg) => heartbeatRunner.setAgentConfigs([cfg]),
    // Synchronous worker teardown (2026-06-27 OOM fix): driveWorker stops the
    // session before releasing its admission slot so the in-process SDK context
    // is freed from the daemon heap promptly (the reaper stays the backstop).
    stopAgent: (name) => manager.stopAgent(name),
    // Same per-worker resolver the spawner registers (daemon.ts spawner block
    // above). Without it, startAgent -> SdkSessionAdapter loadSdkModule ->
    // getLlmRuntime(workerSessionName) throws.
    registerLlmRuntime: (name, workerConfig, parentAgentName, opts) => {
      llmRuntimeRegistry.set(
        name,
        createAgentLlmRuntimeResolver(workerConfig, {
          logger: log,
          openaiCredentials: openaiCredentialsRegistry.get(parentAgentName),
          failoverStateReader: failoverStateStore,
          firstTurnInput: opts?.firstTurnInput,
          deferFirstTurn: opts?.deferFirstTurn,
          mcpTracker,
          getCatalogSnapshot,
        }),
      );
    },
    // The reaper-survival substrate. A worker has no Discord thread, so the
    // worker session name doubles as a synthetic threadId. A non-snowflake id
    // is benign: if a leftover worker binding ever reaches the stale-binding
    // sweep, the Discord lookup 404s -> cleanupThreadWithClassifier prunes it
    // (never a wrong-thread action). Atomic read-modify-write so a concurrent
    // registry writer cannot lose-update the new binding (999.65).
    addWorkerBinding: async (b) => {
      await mutateThreadRegistry(THREAD_REGISTRY_PATH, (current) =>
        addBinding(current, {
          threadId: b.threadId,
          parentChannelId: "",
          agentName: b.agentName,
          sessionName: b.sessionName,
          createdAt: b.lastActivity,
          lastActivity: b.lastActivity,
        }),
      );
    },
    refreshWorkerBinding: async (threadId, timestamp) => {
      await mutateThreadRegistry(THREAD_REGISTRY_PATH, (current) =>
        updateActivity(current, threadId, timestamp),
      );
    },
    removeWorkerBinding: async (threadId) => {
      await mutateThreadRegistry(THREAD_REGISTRY_PATH, (current) =>
        removeBinding(current, threadId),
      );
    },
    // Resolve the triggering agent's live config (the running config wins; fall
    // back to the boot-resolved config). Returns undefined for an unknown agent
    // -> launchWorkflow rejects fast.
    getParentConfig: (parentName) =>
      manager.getAgentConfig(parentName) ??
      resolvedAgents.find((a) => a.name === parentName),
    // Phase 145 WS2 (Plan 06) — drive a worker's turn + collect its result.
    // Backend-agnostic (v2 SDK + v3, via handle.sendAndCollect); RETURNS the
    // worker's final response. `firstTurnInput` is v3/PTY-only (would leave a
    // v2 worker idle) and the relay/completedAt seam deadlocks a channel-less
    // worker (no lastDeliveryAt stamp), so dispatchTurn is the only usable
    // worker turn-fire + collection path. The signal is the wall-clock backstop.
    // Phase 999.165 — steer a worker's RUNNING turn. Only on sessions built
    // with the attributed-stream demux (the bridge's own steering gate, for the
    // same off-by-one reason); otherwise decline and the orchestrator restarts
    // the step with the guidance instead.
    injectMidTurn: (sessionName, text) =>
      manager.hasAttributedStream(sessionName)
        ? manager.injectMidTurn(sessionName, text, { maxPerTurn: 5 })
        : { injected: false, reason: "no-attributed-stream" },
    dispatchTurn: (sessionName, message, signal, onToolUse) =>
      manager.dispatchTurn(
        sessionName,
        message,
        undefined,
        signal || onToolUse
          ? { ...(signal ? { signal } : {}), ...(onToolUse ? { onToolUse } : {}) }
          : undefined,
      ),
    // Phase 145 WS2 (Plan 06) — post progress pings + the final result to the
    // triggering agent's bound channel (same surface the goal-evaluator's
    // sendToChannel uses). Best-effort — but NOT silent (Finding 3,
    // 260714-mkq review): a channel-less caller (e.g. a subagent-thread
    // session with channels: []) used to hit a silent `return` here, so a
    // workflow it launched delivered progress/results into a black hole with
    // zero operator signal. The spawner now disallows start_workflow for
    // subagents; this warn makes any RESIDUAL channel-less caller diagnosable.
    // 999.149 — the parent agent ANSWERS. Fan-in posts a report ABOUT the
    // workflow; until now the agent the operator was actually talking to never
    // spoke and never even learned the workflow had finished. This dispatches
    // one turn into the parent's own session (so it can judge the results
    // against the request that launched them) and posts the reply through the
    // same chunked sink the transcription summary uses.
    //
    // Origin kind is `trigger`, not a new `workflow-fanin` value: SOURCE_KINDS
    // is a LOCKED shape whose comment requires a roadmap update to extend, and
    // a workflow completion genuinely is a trigger. The sourceId carries the
    // workflow id so traces stay greppable.
    dispatchParentAnswer: async (parentAgentName, prompt, workflowId) => {
      const channelId = routingTableRef.current.agentToChannels.get(parentAgentName)?.[0];
      const origin = makeRootOrigin("trigger", `workflow-fanin:${workflowId}`);
      const reply = await turnDispatcher.dispatch(
        origin,
        parentAgentName,
        prompt,
        channelId ? { channelId } : {},
      );
      const res = await deliverAgentText({
        agentName: parentAgentName,
        text: reply,
        reason: `workflow-answer:${workflowId}`,
        sinks: agentTextSinks(parentAgentName),
        log,
      });
      // The orchestrator reads this to decide whether the deterministic summary
      // still has to post as the floor. A genuine FAILURE (no sink, send
      // rejected) means the operator would otherwise get silence — post the
      // floor. An EMPTY reply is not a failure: the agent chose to say nothing
      // in prose, which in practice means it posted through a tool instead. The
      // floor there would be a status wall stacked on top of what the agent
      // already said — exactly the noise this phase removed.
      return res.ok || res.reason === "empty";
    },
    postToBoundChannel: async (parentAgentName, text) => {
      const channelId =
        routingTableRef.current.agentToChannels.get(parentAgentName)?.[0];
      const sender = botDirectSenderRef.current;
      if (!channelId || !sender) {
        log.warn(
          {
            agent: parentAgentName,
            hasChannel: Boolean(channelId),
            hasSender: Boolean(sender),
            textLength: text.length,
          },
          "no bound channel/sender — workflow delivery dropped",
        );
        return;
      }
      await sender.sendText(channelId, text);
    },
    // INC-2026-08-10 — the same resolution as postToBoundChannel, but carrying
    // the rendered report PDFs. THROWS on every failure (rather than warn-and-
    // return like the text path) because the orchestrator uses the rejection as
    // its signal to fall back to a text-only post; swallowing here would drop
    // the summary entirely.
    postFilesToBoundChannel: async (parentAgentName, text, files) => {
      const channelId =
        routingTableRef.current.agentToChannels.get(parentAgentName)?.[0];
      const sender = botDirectSenderRef.current;
      if (!channelId || !sender?.sendFiles) {
        throw new Error(
          `no file-capable bound channel for ${parentAgentName} ` +
            `(channel=${Boolean(channelId)}, sender=${Boolean(sender?.sendFiles)})`,
        );
      }
      await sender.sendFiles(channelId, text, files);
    },
    // 2026-07-27 disk persistence — write workflow artifacts under the parent
    // agent's workspace: <workspace>/workflows/<wfId>/<relativePath>. Results
    // previously lived only in daemon memory (10-min terminal prune) + the
    // chunked channel post, so an agent doing follow-up work had to scrape
    // its own channel. Containment check is defense-in-depth behind the
    // orchestrator's stepId sanitizer (stepIds are model-supplied). Writes
    // run as the daemon user, so the files are agent-readable like the rest
    // of the workspace. Callers treat every failure as best-effort.
    // Phase 999.129 — the latest completed run of the same template + params,
    // read from the persisted `run.json` records under <workspace>/workflows/.
    readPreviousRun: async (parentAgentName, origin, currentWorkflowId) => {
      const parentConfig =
        manager.getAgentConfig(parentAgentName) ??
        resolvedAgents.find((a) => a.name === parentAgentName);
      if (!parentConfig?.workspace) return null;
      const { readdir } = await import("node:fs/promises");
      const { parseRunRecord, pickPreviousRun, RUN_RECORD_FILE } = await import(
        "./workflow-summary/previous-run.js"
      );
      const root = resolvePath(parentConfig.workspace, "workflows");
      let dirs: string[];
      try {
        dirs = await readdir(root);
      } catch {
        return null;
      }
      const records = [];
      for (const dir of dirs) {
        if (dir === currentWorkflowId) continue;
        try {
          const raw = await readFile(resolvePath(root, dir, RUN_RECORD_FILE), "utf8");
          const rec = parseRunRecord(raw);
          if (rec) records.push(rec);
        } catch {
          /* no run record in this dir (an ad-hoc run, or an older build) */
        }
      }
      return pickPreviousRun(records, origin, currentWorkflowId);
    },
    persistWorkflowArtifact: async (
      parentAgentName,
      workflowId,
      relativePath,
      content,
    ) => {
      const parentConfig =
        manager.getAgentConfig(parentAgentName) ??
        resolvedAgents.find((a) => a.name === parentAgentName);
      if (!parentConfig?.workspace) {
        throw new Error(
          `persistWorkflowArtifact: no workspace for agent '${parentAgentName}'`,
        );
      }
      const dir = resolvePath(parentConfig.workspace, "workflows", workflowId);
      const target = resolvePath(dir, relativePath);
      if (!target.startsWith(dir + "/")) {
        throw new Error(
          `persistWorkflowArtifact: path escapes workflow dir: ${relativePath}`,
        );
      }
      await mkdir(dir, { recursive: true });
      await writeFile(target, content, "utf8");
    },
    // 999.106 W-2 — the read counterpart: the wave boundary caps in-heap
    // results at RESULT_HEAP_CAP, and the final-report sources + report PDFs
    // re-read the FULL text from disk through this. Same containment check as
    // the writer (relativePath flows from orchestrator-built resultFile
    // strings, but stepIds are model-supplied — defense in depth). Callers
    // treat every failure as best-effort (they fall back to the capped
    // in-heap copy).
    readWorkflowArtifact: async (parentAgentName, workflowId, relativePath) => {
      const parentConfig =
        manager.getAgentConfig(parentAgentName) ??
        resolvedAgents.find((a) => a.name === parentAgentName);
      if (!parentConfig?.workspace) {
        throw new Error(
          `readWorkflowArtifact: no workspace for agent '${parentAgentName}'`,
        );
      }
      const dir = resolvePath(parentConfig.workspace, "workflows", workflowId);
      const target = resolvePath(dir, relativePath);
      if (!target.startsWith(dir + "/")) {
        throw new Error(
          `readWorkflowArtifact: path escapes workflow dir: ${relativePath}`,
        );
      }
      return await readFile(target, "utf8");
    },
    // INC-2026-08-10 — bound <workspace>/workflows/. Nothing has pruned these
    // since disk persistence landed 2026-07-27, and this host has already had
    // one ENOSPC fleet-down that grew quietly over days.
    pruneWorkflowArtifacts: async (parentAgentName) => {
      const parentConfig =
        manager.getAgentConfig(parentAgentName) ??
        resolvedAgents.find((a) => a.name === parentAgentName);
      if (!parentConfig?.workspace) return;
      await pruneWorkflowArtifacts(
        parentConfig.workspace,
        config.defaults.workflow?.keepArtifactDirs ?? DEFAULT_KEEP_WORKFLOWS,
        { logger: log },
      );
    },
    // nanoid(6) — load-bearing length. The worker session name is
    // `${parent}-sub-${id}` and `isSubagentThreadName` (subagent-name.ts) only
    // matches a TRAILING 6-char nanoid suffix (the spawner uses nanoid(6)). A
    // default 21-char id would NOT match -> the idle subagent reaper skips the
    // worker entirely -> the lastActivity survival machinery is inert AND there
    // is no idle-reap backstop for a leaked worker. Keep this at 6. (The `wf_`
    // workflow id reuses the same generator; a 6-char wf id is fine — same
    // collision space the spawner already trusts.)
    generateId: () => nanoid(6),
    now: () => Date.now(),
    // Worker-admission bounds (2026-06-27 OOM fix). Read live from the current
    // config object so a YAML change applies on the next daemon restart (config
    // = file-save only; there is no `clawcode reload`). NOTE (INC-2026-07-26):
    // the schema's workflow block is `.optional()`, so a yaml WITHOUT a
    // `workflow:` key (prod today) resolves to undefined and these ??
    // fallbacks ARE the effective defaults — they must stay in lockstep with
    // the schema defaults or a schema-side change is silently inert in prod
    // (exactly what a review of the 3600s admission-timeout bump caught).
    getWorkflowLimits: () => ({
      maxConcurrentWorkers: config.defaults.workflow?.maxConcurrentWorkers ?? 3,
      memoryHighWatermarkPercent:
        config.defaults.workflow?.memoryHighWatermarkPercent ?? 85,
      admissionTimeoutMs:
        config.defaults.workflow?.admissionTimeoutMs ?? 3_600_000,
      // INC-2026-08-10 — read live from the config object (like the limits
      // above) so a rollback to "inline" applies on the next workflow without
      // a daemon restart; shutdown has wedged before and restarts cost minutes.
      outputMode: config.defaults.workflow?.output?.mode ?? "summary",
      // 999.106 QW-2 (worker diet) — fleet ceiling of MCP server names a
      // workflow worker keeps. DELIBERATELY no ?? fallback: absence IS
      // inherit-the-parent's-roster (today's behavior), so there is no default
      // value to keep in lockstep with the schema.
      workerMcpAllowlist: config.defaults.workflow?.worker?.mcpServers,
    }),
    // INC-2026-08-10 — the two report PDFs delivered with the summary.
    // `undefined` (reports: false) means finalize posts text only; the summary
    // itself is unaffected either way. Read at CONSTRUCTION rather than per
    // call because the browser driver is a fixed capability, unlike the
    // limits above which an operator flips at runtime.
    // Phase 999.123 — fact-check step opt-in (absent config = off).
    verifyFiguresFor: (parentAgentName: string) =>
      manager.getAgentConfig(parentAgentName)?.workflowVerifyFigures ??
      resolvedAgents.find((a) => a.name === parentAgentName)?.workflowVerifyFigures ??
      false,
    ...((config.defaults.workflow?.output?.reports ?? true)
      ? {
          reportDeps: {
            ...((config.defaults.workflow?.output?.synthesis ?? true)
              ? {
                  synthesize: (doc: import("../reports/types.js").ReportDoc) =>
                    synthesizeReport(doc, {
                      logger: log,
                      // Sonnet, not Haiku: this is an editing judgement over
                      // tens of thousands of words, and the deterministic
                      // fallback below it means a slow-but-good call is the
                      // right trade. maxTokens covers the full JSON envelope
                      // (a per-step condensation for up to 8 steps).
                      callModel: (system, user) =>
                        callModelDirect(
                          system,
                          user,
                          "sonnet",
                          { maxTokens: 8_000 },
                          "workflow-report",
                        ),
                    }),
                }
              : {}),
          },
        }
      : {}),
    // cgroup memory percent for the admission gate's hard backstop; null on
    // dev / non-Linux / unbounded cgroup → the gate fails OPEN (never blocks).
    readMemoryPercent: async () => {
      const stats = await readCgroupMemoryStats();
      return stats?.memoryPercent ?? null;
    },
    // 999.106 G-2 — backpressure readers for the admission gate (same bus +
    // PSI legs the SpawnGovernor uses; thresholds single-sourced from the
    // spawnGovernor config block). All fail-open.
    readPressure: readGatePressure,
    getBalloonSignal,
    getGateTightenThresholds: () => ({
      psiFull10:
        config.defaults.spawnGovernor?.gateTightenPsiFull10 ??
        SPAWN_GOVERNOR_DEFAULTS.gateTightenPsiFull10,
      psiSome60:
        config.defaults.spawnGovernor?.gateTightenPsiSome60 ??
        SPAWN_GOVERNOR_DEFAULTS.gateTightenPsiSome60,
    }),
    logger: log,
  });
  log.info("workflow orchestrator initialized (Phase 145 WS2)");

  // 999.109 (INC-2026-08-18) — exempt LIVE workflow workers from the
  // heartbeat's stale-turn sweep. The sweep runs before the per-agent
  // `heartbeat.enabled === false` gate by design (999.64, so a wedged
  // subagent THREAD stays reachable), which also stripped workers of the
  // exact protection the SC-2 contract gives them: three fin-client
  // workflows were force-released mid-research at the sweep's 5-min
  // interactive threshold. Ownership is the discriminator — subagent
  // threads share the `-sub-` name shape and stay fully sweepable. Read at
  // CALL time through the ref, so it is correct no matter the boot order.
  heartbeatRunner.setSweepExemptionProbe((sessionName: string) =>
    workflowOrchestratorRef.current?.isLiveWorkerSession(sessionName) === true,
  );

  // P4 (memory program) — narrow handle for the fork/pool session scan in
  // the 60s reaper tick below. Null when the warm pool is disabled (every
  // `-pool-` session is then structurally unmanaged by definition).
  let warmPoolForReaper: {
    isPoolManaged(name: string): boolean;
    poolCapForParent(parent: string): number;
  } | null = null;

  // Phase 999.86 — pre-warmed worker pool for v3 Discord chat. Gated behind
  // `CLAWCODE_WARM_POOL=1` for safe rollout; when disabled, v3 chat keeps
  // using the existing long-lived parent `v3Bridge.push` path (flaky per
  // 999.84-EXPERIMENT but operational). When enabled, the pool spawns N=1
  // workers per v3 agent in `deferFirstTurn` mode (parked on the
  // `--dangerously-load-development-channels` menu); chat dispatches pop a
  // worker, deliver `\r<message>\n` (the proven fresh-spawn trigger pattern
  // from 999.83), and — Phase 141 WS-1 (1B) — RETURN it to the warm set for
  // reuse (no per-message cold-start) instead of tearing it down. Constructed
  // AFTER the spawner so we can reuse the same `registerLlmRuntime` /
  // `wireChannelForSubagent` callbacks.
  if (
    process.env.CLAWCODE_WARM_POOL === "1" &&
    discordBridge &&
    subagentThreadSpawner
  ) {
    const { WarmWorkerPool } = await import("./warm-worker-pool.js");
    const { DefaultEphemeralChatDispatcher } = await import(
      "../discord/ephemeral-chat-dispatcher.js"
    );
    const { liveSupervisorByAgent } = await import(
      "../llm-runtime/backends/claude-code-interactive.js"
    );
    const v3PoolAgents = resolvedAgents
      .filter((cfg) => cfg.llmRuntime?.backend === "claude-code-interactive")
      .map((cfg) => ({
        name: cfg.name,
        warmSize: cfg.llmRuntime?.warmPool?.size ?? 1,
        maxConcurrent: cfg.llmRuntime?.warmPool?.maxConcurrent,
      }));
    if (v3PoolAgents.length > 0) {
      const pool = new WarmWorkerPool(
        {
          sessionManager: manager,
          registerLlmRuntime: (name, cfg, parent, opts) => {
            llmRuntimeRegistry.set(
              name,
              createAgentLlmRuntimeResolver(cfg, {
                logger: log,
                openaiCredentials: openaiCredentialsRegistry.get(parent),
                failoverStateReader: failoverStateStore,
                firstTurnInput: opts?.firstTurnInput,
                deferFirstTurn: opts?.deferFirstTurn,
                // Phase 141 (C) — wire the live tracker into warm-pool v3 workers
                // too, so their PTY pids register for killAgentGroup coverage
                // (parity with the main-agent resolver; closes the subagent leak).
                mcpTracker,
                // Phase 999.98-03 (gap closure) — warm-pool v3 workers resolve a
                // `<family>@latest` model over the live catalog snapshot at spawn,
                // same as the main-agent resolver. ONLY the v3 backend reads it.
                getCatalogSnapshot,
              }),
            );
          },
          wireChannelForSubagent: (cfg) =>
            agentChannelRegistry.wireForConfig(cfg),
          unwireChannelForSubagent: (name) =>
            agentChannelRegistry.unwireForAgent(name),
          getParentConfig: (name) => manager.getAgentConfig(name),
          liveSupervisorByAgent,
          logger: log,
          // Phase 141 WS-1 (1B) — reuse warm workers across messages (return to
          // the warm set instead of spawn-and-retire) to kill the per-message
          // cold-start. ON by default whenever the pool is enabled; set
          // CLAWCODE_WARM_POOL_REUSE=0 to fall back to 999.86 spawn-and-retire
          // for canary isolation. (GATE-0 Option A: chat-concurrency + reuse;
          // control traffic stays on the fail-closed main bridge.)
          reuseWorkers: process.env.CLAWCODE_WARM_POOL_REUSE !== "0",
        },
        v3PoolAgents,
      );
      // Fire-and-forget pre-warm. Individual spawn failures are logged and
      // do not block daemon boot (dispatches will cold-spawn until the pool
      // refills). Operator confirms with `pgrep -af "claude.*channels"` +
      // grep for `phase99986-worker-warmed`.
      void pool.start().then(
        () => log.info("phase99986-warm-pool-ready"),
        (err: unknown) =>
          log.warn(
            { err: (err as Error)?.message },
            "phase99986-warm-pool-start-failed",
          ),
      );
      warmPoolForReaper = pool;
      const dispatcher = new DefaultEphemeralChatDispatcher({ pool, logger: log });
      discordBridge.setEphemeralChatDispatcher(dispatcher);
      log.info(
        { agents: v3PoolAgents.map((a) => a.name) },
        "phase99986-warm-pool-dispatcher-wired",
      );
    }
  }

  // 11c. Initialize slash command handler (requires Discord bridge client — no fallback)
  // Quick task 260419-nic — pass turnDispatcher so /clawcode-steer can
  // dispatch [USER STEER] follow-up turns after interrupting in-flight ones.
  // Phase 999.176 — /clawcode-account deps. Gate = admin user id (env
  // allowlist) AND an admin-agent channel; empty allowlist → fail closed.
  const accountAdminUserIds = (process.env.CLAWCODE_ADMIN_DISCORD_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (accountAdminUserIds.length === 0) {
    log.warn(
      { component: "account-swap" },
      "CLAWCODE_ADMIN_DISCORD_USER_IDS is empty — /clawcode-account will refuse everyone",
    );
  }
  const accountFlowDeps = buildAccountFlowDeps({
    service: accountService,
    adminUserIds: accountAdminUserIds,
    getRoutingTable: () => routingTableRef.current,
    resolvedAgents,
    sessionManager: manager,
    getBridge: (agent) => agentChannelRegistry.get(agent)?.bridge,
    getMacAgent: () => config.defaults.accountSwap?.macAgent,
    log,
  });
  const slashHandler = new SlashCommandHandler({
    routingTable,
    sessionManager: manager,
    resolvedAgents,
    botToken,
    client: discordBridge?.discordClient,
    turnDispatcher,
    // Phase 141 (#8) — same v3 channel-bridge resolver DiscordBridge gets, so a
    // skill-named /clawcode-<skill> turn reaches a claude-code-interactive agent
    // over the live channel (push + awaitReply) instead of the inert
    // streamFromAgent. Returns undefined for v2 agents → unchanged path.
    getBridge: (agent) => agentChannelRegistry.get(agent)?.bridge,
    // 999.160 v1.1 — reply-action clicks: the shared v2 bridge (see getLedger below).
    getReplyActionBridge: () => discordBridge ?? undefined,
    // 2026-08-28 — the `🧾 Sources` button looked the ledger up through
    // getBridge (the v3 registry → undefined for every v2 agent) and answered
    // "no longer available" on 100 % of clicks. Direct lookup, thread-safe.
    getLedger: (messageId) => discordBridge?.getLedgerByMessageId(messageId),
    // 999.147 — 🩹 relief button. NOTE the interactionCreate routing table is
    // built once at handler start, so adding this prefix needs a daemon
    // restart; it is NOT hot-reloadable (project_slash_commands_routing_snapshot).
    getReliefDeps: memoryReliefDeps,
    getContainerReliefDeps: containerReliefDeps,
    // Phase 999.173 — research card Status / Stop (stopTask on the live handle).
    getResearchButtonDeps: () => ({
      getSessionHandle: (agentName: string) => manager.getSessionHandle(agentName),
      log: {
        info: (obj: Record<string, unknown>, msg: string) => log.info(obj, msg),
        warn: (obj: Record<string, unknown>, msg: string) => log.warn(obj, msg),
      },
    }),
    // Phase 999.176 — /clawcode-account (fleet account swap).
    getAccountFlowDeps: () => accountFlowDeps,
    // Phase 83 EFFORT-05 — inject the catalog so slash-command dispatch can
    // resolve per-skill `effort:` frontmatter overrides and apply them for
    // the duration of the turn.
    skillsCatalog,
    // Skill-slash-commands — per-agent active skill sets (manifest-refused
    // excluded). Drives opt-in `/<skill>` registration and the
    // invocation-time channel→agent skill-membership gate.
    loadedSkillsByAgent,
    // Phase 135 Plan 02 — share the daemon-constructed VoiceManager so
    // `/vc` commands operate on the same Map<guildId, VoiceSession>
    // the bridge's autoJoin/voiceStateUpdate listeners see. Without
    // this share, /vc status would return an empty list because the
    // sessions are held on the bridge-side instance.
    voiceManager: voiceManager ?? undefined,
    log,
  });
  if (botToken) {
    try {
      await slashHandler.start();
      log.info("slash command handler started");
      // Phase 999.176 — report a swap applied at step 3a once agents have had
      // time to boot (auto-start runs later in startDaemon). Fire-and-forget.
      const swapReportClient = discordBridge?.discordClient;
      if (swapReportClient) {
        const timer = setTimeout(() => {
          void (async () => {
            const result = await consumeSwapBootResult(accountSwapPaths);
            if (result === null) return;
            await postSwapBootReport(result, accountFlowDeps, {
              client: swapReportClient,
              probeAuth: async () => {
                const { callModelDirect } = await import("./haiku-direct.js");
                const text = await callModelDirect(
                  "Reply with the single word PONG.",
                  "ping",
                  "haiku",
                  { maxTokens: 16, trimmedStartup: true },
                );
                return text.trim().length > 0;
              },
            });
          })().catch((err: unknown) =>
            log.warn(
              { component: "account-swap", error: err instanceof Error ? err.message : String(err) },
              "account swap boot report failed",
            ),
          );
        }, ACCOUNT_SWAP_REPORT_DELAY_MS);
        timer.unref?.();
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.warn({ error: msg }, "slash command handler failed to start (non-fatal)");
    }
  }

  // 11d. Initialize config hot-reload
  const auditTrailPath = join(MANAGER_DIR, "config-audit.jsonl");

  const configReloader = new ConfigReloader({
    sessionManager: manager,
    taskScheduler,
    heartbeatRunner,
    webhookManager,
    skillsCatalog,
    routingTableRef,
    log,
  });

  const configWatcher = new ConfigWatcher({
    configPath,
    auditTrailPath,
    onChange: async (diff, newResolvedAgents, newConfig) => {
      // Capture the OLD haiku routing BEFORE the `config = newConfig` swap below.
      const oldBridgeRouting = config.defaults.bridge?.haikuDirectRouting ?? "bridge";
      // Phase 999.X — replace the daemon's `config` reference so closures
      // reading `config.defaults.<dial>` (orphan-claude reaper,
      // subagent-session reaper, both inside onTickAfter) see the live
      // yaml on the next tick. Done FIRST so any failure in the rest of
      // this handler still leaves config in sync with what the watcher
      // believes is current.
      config = newConfig;
      // Phase 104 plan 03 (SEC-05) — reconcile the secrets cache against
      // the diff BEFORE applyChanges so the reload's downstream agent
      // restarts/spawns hit a hot, fresh cache. Walks the diff for op:// URI
      // changes: invalidates old URIs, warm-resolves new ones. Failures are
      // logged inside applySecretsDiff and never propagate (configReloader
      // must still run for the non-secret parts of the diff).
      await applySecretsDiff(diff, secretsResolver, log);
      // Phase 137 Plan 04 T-03 (T5) — credentials hot-reload.
      //
      // RELOADABLE per `src/config/types.ts` RELOADABLE_FIELDS. Walk
      // the diff for any `providers.openai.apiKeyPath` change and
      // invalidate the per-agent OpenAiCredentialsResolver cache so
      // the next CodexQuery spawn re-resolves the (possibly rotated)
      // key from SecretsResolver. SecretsResolver itself is invalidated
      // by `applySecretsDiff` above when the URI changes; this hook
      // is the wrapper-side counterpart.
      //
      // Single chokepoint per feedback_silent_path_bifurcation memory —
      // ONE openaiCredentialsRegistry walk per reload, no parallel
      // resolver pools. The diff includes both top-level
      // `defaults.providers.openai.apiKeyPath` deltas and per-agent
      // `agents[].providers.openai.apiKeyPath` deltas; both surfaces
      // need invalidation.
      //
      // The diff is a flat changes array — we filter to entries whose
      // path includes "providers.openai.apiKeyPath". For each, walk
      // the registry and invalidate every entry whose resolved
      // ResolvedAgentConfig referenced that URI. Simpler heuristic:
      // any credentials change → invalidate ALL entries. The
      // invalidate operation is cheap (drops one string from memory)
      // and the next-turn re-resolution hits the warm SecretsResolver
      // cache for unchanged URIs, so the cost of fan-out is one extra
      // SecretsResolver.resolve() per agent on the next turn.
      try {
        const credentialsChanged = diff.changes.some((c) =>
          c.fieldPath.includes("providers.openai.apiKeyPath"),
        );
        if (credentialsChanged) {
          log.info(
            { agentCount: openaiCredentialsRegistry.size },
            "phase137-codex-credentials-hot-reload",
          );
          for (const resolver of openaiCredentialsRegistry.values()) {
            resolver.invalidateCache();
          }
        }
      } catch (err) {
        log.warn(
          { err: String(err) },
          "phase137-codex-credentials-hot-reload: invalidation walk threw (non-fatal)",
        );
      }
      // Phase 108 — Pitfall 2: hot-reload of OP_SERVICE_ACCOUNT_TOKEN is
      // explicitly NOT supported (CONTEXT.md §"Out of scope"). The broker
      // pins each agent → tokenHash on first connect; a yaml edit that
      // changes a token literal mid-flight is caught at the broker's
      // sticky-pin check and rejected per-connection. Surface an
      // operator-visible warning here so the rejection isn't a silent
      // surprise. Walk the diff for any 1password-token change.
      try {
        for (const newAgent of newResolvedAgents) {
          const newOverride =
            newAgent.mcpEnvOverrides?.["1password"]?.OP_SERVICE_ACCOUNT_TOKEN;
          const oldAgent = resolvedAgents.find((a) => a.name === newAgent.name);
          const oldOverride =
            oldAgent?.mcpEnvOverrides?.["1password"]?.OP_SERVICE_ACCOUNT_TOKEN;
          if (newOverride !== oldOverride) {
            brokerLog.error(
              {
                agent: newAgent.name,
                hadOverride: oldOverride !== undefined,
                hasOverride: newOverride !== undefined,
              },
              "mcp-broker: hot-reload of OP_SERVICE_ACCOUNT_TOKEN is NOT supported — restart daemon to apply (broker token pin is sticky per-agent)",
            );
          }
        }
      } catch (err) {
        brokerLog.warn(
          { err: String(err) },
          "mcp-broker: hot-reload token-diff probe threw (non-fatal)",
        );
      }
      // Hot-reload the haiku-direct routing policy. callHaikuDirect /
      // callHaikuVision see the new policy on the next invocation.
      const newBridgeRouting = newConfig.defaults.bridge?.haikuDirectRouting ?? "bridge";
      if (oldBridgeRouting !== newBridgeRouting) {
        configureHaikuRouting(newBridgeRouting);
        log.info(
          {
            tag: "haiku-direct",
            oldRouting: oldBridgeRouting,
            newRouting: newBridgeRouting,
          },
          "bridge haikuDirectRouting reloaded",
        );
      }
      const summary = await configReloader.applyChanges(diff, newResolvedAgents);
      log.info({ subsystems: summary.subsystemsReloaded, agents: summary.agentsAffected }, "config hot-reloaded");
    },
    log,
    // Hot-reload must resolve op:// refs too — otherwise adding a new
    // mcpServers entry with `op://...` env on a running daemon would still
    // crash the child. Matches the boot-time resolver above.
    //
    // Phase 104 — uses the shared cached sync wrapper so hot-reload
    // hits the warmed cache. The applySecretsDiff call above (SEC-05) pre-
    // resolves new op:// refs so this sync wrapper finds them in the cache.
    opRefResolver: cachedOpRefResolver,
  });
  await configWatcher.start();
  log.info({ configPath, auditTrail: auditTrailPath }, "config watcher started");

  // 11d. Start dashboard server (non-fatal — daemon continues if port is taken)
  const dashboardPort = Number(process.env.CLAWCODE_DASHBOARD_PORT) || 3100;
  const dashboardHost = process.env.CLAWCODE_DASHBOARD_HOST ?? "127.0.0.1";
  let dashboard: Awaited<ReturnType<typeof startDashboardServer>> | null = null;
  try {
    // Phase 61 TRIG-03: Inject webhook handler routed through WebhookSource.handleHttp.
    // WebhookSource.handleHttp owns TriggerEvent construction + stable idempotency keys.
    const webhookHandler = webhookSource
      ? createWebhookHandler(
          webhookSource.configMap,
          (triggerId, payload, rawBodyBytes) =>
            webhookSource!.handleHttp(triggerId, payload, rawBodyBytes),
          log,
        )
      : undefined;
    // Phase 116-06 T08 — cutover redirect closure reads the LIVE config
    // ref. `config` is the `let`-bound mutable reference reassigned on
    // every ConfigWatcher reload tick (see line 1818 + reassignment at
    // the ConfigReloader applyChanges callsite). The dashboard server
    // invokes this getter on every incoming `GET /` request, so a
    // `clawcode config set defaults.dashboardCutoverRedirect true` edit
    // takes effect on the very next request after chokidar fires the
    // debounce timer — no daemon restart needed.
    const cutoverRedirectEnabled = (): boolean =>
      config.defaults.dashboardCutoverRedirect === true;
    dashboard = await startDashboardServer({
      port: dashboardPort,
      host: dashboardHost,
      socketPath: SOCKET_PATH,
      webhookHandler,
      cutoverRedirectEnabled,
      auditTrail: dashboardAuditTrail,
      previewStore,
    });
    // Phase 116-03 F27 — publish the SseManager into the late-binding ref so
    // the bridge's onConversationTurn closure picks it up. From now on, every
    // captureDiscordExchange call broadcasts a `conversation-turn` event.
    sseManagerRef.current = dashboard.sseManager;
    log.info({ port: dashboardPort, host: dashboardHost }, "dashboard server started");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ port: dashboardPort, host: dashboardHost, error: msg }, "dashboard server failed to start — continuing without dashboard");
  }

  // 11d-bis. Phase 69 — OpenAI-compatible endpoint. Starts AFTER dashboard
  // (so dashboard port conflicts surface first) and AFTER SessionManager +
  // ConversationStore are fully initialized (which happens above inside the
  // SessionManager constructor path). Non-fatal: an EADDRINUSE on the openai
  // port is logged at warn and the daemon continues without the endpoint.
  //
  // Env overrides: CLAWCODE_OPENAI_PORT, CLAWCODE_OPENAI_HOST (mirrors
  // CLAWCODE_DASHBOARD_PORT / _HOST). Disabled entirely via
  // config.defaults.openai.enabled = false.
  //
  // Under the hood, startOpenAiEndpoint calls startOpenAiServer from
  // src/openai/server.ts with a production OpenAiSessionDriver built via
  // createOpenAiSessionDriver (src/openai/driver.ts). Shutdown honors
  // Pitfall 10: drain activeStreams → server.close() → apiKeysStore.close().
  const openAiEndpoint: OpenAiEndpointHandle = await startOpenAiEndpoint(
    {
      managerDir: MANAGER_DIR,
      sessionManager: manager,
      turnDispatcher,
      // Phase 999.19 — central predicate also excludes -via- delegated sessions.
      agentNames: () => resolvedAgents.filter((a) => !isSubagentOrThreadSession(a.name)).map((a) => a.name),
      log,
    },
    config.defaults.openai,
  );
  openAiEndpointRef = openAiEndpoint;

  // 11e. Phase 52 Plan 03 (CACHE-03): daily cost + cache hit-rate summary
  // cron. Fires at 09:00 UTC and posts one Discord embed per running agent
  // carrying the previous 24h cost totals AND `💾 Cache: {hitRate}% over
  // {turns} turns` when turns > 0 (suppressed on idle days per BLOCKER-1).
  // Shutdown handler below calls `.stop()` to clean up the timer.
  const dailySummaryCron: DailySummaryCronHandle = scheduleDailySummaryCron({
    manager,
    webhookManager,
    log,
  });
  log.info({ pattern: "0 9 * * *" }, "daily summary cron scheduled (09:00 UTC)");

  // Phase 999.127 — weekly "what I learned about you" digest (Mondays 09:00
  // America/Los_Angeles by default; `defaults.memoryDigest` overrides).
  // Posts through the bot-direct sender so the message is the agent's own,
  // and seeds the number reactions through the A2A reactor (best-effort).
  const memoryDigestCron: MemoryDigestCronHandle = scheduleMemoryDigestCron({
    manager,
    channelFor: (agent) => routingTableRef.current.agentToChannels.get(agent)?.[0],
    sender: () => botDirectSenderRef.current ?? undefined,
    reactor: () => a2aReactionSenderRef.current ?? undefined,
    log,
    ...(config.defaults.memoryDigest?.cron ? { pattern: config.defaults.memoryDigest.cron } : {}),
    ...(config.defaults.memoryDigest?.timezone
      ? { timezone: config.defaults.memoryDigest.timezone }
      : {}),
    ...(config.defaults.memoryDigest?.maxItems
      ? { maxItems: config.defaults.memoryDigest.maxItems }
      : {}),
  });
  log.info(
    { pattern: config.defaults.memoryDigest?.cron ?? "0 9 * * 1" },
    "memory digest cron scheduled",
  );

  // Phase 999.130 — weekly fleet report card to the admin channel (Mondays
  // 09:10 Pacific by default, after the digests). The same collector backs
  // the `report-card` IPC so the CLI shows the same numbers.
  const workflowWeekStats = async (
    agent: string,
    sinceMs: number,
    untilMs: number,
  ): Promise<{ run: number; failed: number }> => {
    const cfg = manager.getAgentConfig(agent) ?? resolvedAgents.find((a) => a.name === agent);
    if (!cfg?.workspace) return { run: 0, failed: 0 };
    const { readdir } = await import("node:fs/promises");
    const root = resolvePath(cfg.workspace, "workflows");
    let dirs: string[];
    try {
      dirs = await readdir(root);
    } catch {
      return { run: 0, failed: 0 };
    }
    let run = 0;
    let failed = 0;
    for (const dir of dirs) {
      try {
        const raw = await readFile(resolvePath(root, dir, "summary.json"), "utf8");
        const summary = JSON.parse(raw) as { finishedAt?: unknown; status?: unknown };
        const finishedAt = typeof summary.finishedAt === "number" ? summary.finishedAt : NaN;
        if (!(finishedAt >= sinceMs && finishedAt <= untilMs)) continue;
        run += 1;
        if (summary.status === "failed") failed += 1;
      } catch {
        /* not a finished run */
      }
    }
    return { run, failed };
  };
  const reportCardDeps: ReportCardDeps = {
    manager,
    incidents: (windowMs) => heartbeatRunner.getTransitionJournal().summary(windowMs),
    workflowStats: workflowWeekStats,
    log,
  };
  reportCardDepsRef.current = reportCardDeps;
  const reportCardCron: ReportCardCronHandle = scheduleReportCardCron({
    ...reportCardDeps,
    postToAdmin: postToAdminClawdy,
    ...(config.defaults.reportCard?.cron ? { pattern: config.defaults.reportCard.cron } : {}),
    ...(config.defaults.reportCard?.timezone ? { timezone: config.defaults.reportCard.timezone } : {}),
  });
  log.info({ pattern: config.defaults.reportCard?.cron ?? "10 9 * * 1" }, "report card cron scheduled");

  // 11f'. Phase 115-postdeploy 2026-05-12 — embedding-v2 migration cron.
  // Phase 115 Plan 06 shipped the state machine + IPC handlers + runner
  // but NEVER shipped a scheduler that called `runReEmbedBatch`. The
  // operator's "Start re-embedding" click flipped the phase to
  // `re-embedding` and then progress sat at 0% forever because nothing
  // on the daemon side invoked the runner. Silent-path-bifurcation
  // anti-pattern (see `feedback_silent_path_bifurcation.md`).
  //
  // Cron iterates `manager.getRunningAgents()` every 30s, calls
  // `runReEmbedBatch` for each agent in a working phase (`dual-write`
  // or `re-embedding`). Skips paused agents per
  // `defaults.embeddingMigration.pausedAgents`. The one-shot kick from
  // the transition IPC handler (see `embedding-migration-transition`
  // case below) gives the operator immediate progress without waiting
  // up to 30s for the first tick.
  //
  // Sentinel test: `src/memory/migrations/__tests__/migration-cron-wiring.test.ts`
  // statically asserts `runReEmbedBatch` has at least one production
  // caller in `src/manager/migration-cron.ts` so this bug class can't
  // recur silently.
  const migrationCron: MigrationCronHandle = scheduleMigrationCron({
    manager,
    config,
    log,
  });
  log.info(
    { pattern: "*/30 * * * * *" },
    "embedding-v2 migration cron scheduled (every 30s)",
  );

  // 11f-2. Phase 138 Plan 05 — cross-provider auto-failover cron.
  //
  // Every minute, the FailoverController:
  //   1. reads `provider_alert_state` for today's `threshold=95` rows
  //      (the Plan 03 → Plan 05 signal) → which providers are saturated;
  //   2. resolves each agent's CONFIGURED backend + `failoverChain`;
  //   3. reads `failover_state` (all rows, incl. expired);
  //   4. runs the pure `evaluateFailoverDecisions` state machine;
  //   5. applies decisions via `failoverStateStore.set` + clears expired
  //      rows, emitting `phase138-failover-{triggered,cleared}` + a
  //      fire-and-forget Discord alert per failover.
  //
  // The factory override (`createLlmRuntimeService` → `failoverStateReader`)
  // wired in the resolver loop above means a failover row flips the
  // affected agent's NEXT turn — no daemon restart, clawcode.yaml
  // untouched (CONTEXT D3 runtime-state override).
  //
  // SHUTDOWN ORDER: `failoverCron.stop()` runs BEFORE `fleetAlertDb.close()`
  // so an in-flight tick never writes to a closed handle.
  const failoverController = new FailoverController({
    failoverStateStore,
    // Saturated providers = today's UTC `threshold=95` rows in
    // `provider_alert_state` (owned by ThresholdAlerter, Plan 03).
    readSaturatedProviders: () => {
      const today = new Date().toISOString().slice(0, 10);
      try {
        const rows = fleetAlertDb
          .prepare(
            "SELECT DISTINCT provider FROM provider_alert_state " +
              "WHERE date = ? AND threshold = 95",
          )
          .all(today) as { provider: string }[];
        return new Set(rows.map((r) => r.provider));
      } catch (err) {
        // The table may not exist until ThresholdAlerter's constructor
        // runs (later in boot) — treat a missing table as "none
        // saturated" so the first ticks are harmless no-ops.
        log.debug(
          { err: String(err) },
          "phase138-failover: provider_alert_state read skipped",
        );
        return new Set<string>();
      }
    },
    // Per-agent CONFIGURED runtime config — the resolver always
    // populates `llmRuntime.{backend,failoverChain}`.
    resolveAgents: (): readonly FailoverAgentConfig[] =>
      resolvedAgents.map((c) => ({
        name: c.name,
        backend: c.llmRuntime?.backend ?? "anthropic-agent-sdk",
        failoverChain: c.llmRuntime?.failoverChain ?? [],
      })),
    webhookManager,
    logger: log,
  });
  const failoverCron: FailoverCronHandle = scheduleFailoverCron({
    controller: failoverController,
    logger: log,
  });
  log.info(
    { pattern: "*/1 * * * *" },
    "phase138 failover cron scheduled (every 1m)",
  );

  // 11f''. Phase dream-cron-wiring — per-agent dream-pass auto-trigger cron.
  //
  // THE BUG THIS FIXES (silent-path-bifurcation, instance #5):
  //   `registerDreamCron` (src/manager/dream-cron.ts) — the 30-min-idle
  //   AUTO trigger for dream passes — was fully implemented + unit-tested
  //   but had ZERO production callers. daemon.ts never registered it.
  //   Dream passes only ever fired via the manual `clawcode dream` IPC
  //   call. The auto-trigger went dark for 5+ days on fin-client
  //   before anyone noticed. See `feedback_silent_path_bifurcation.md`.
  //
  // THE FIX:
  //   Register one dream cron per agent at boot, mirroring the
  //   scheduleDailySummaryCron / scheduleMigrationCron pattern above.
  //   `registerDreamCron` self-skips agents with `dream.enabled !== true`
  //   (returns {registered:false, reason:'disabled'}), so calling it for
  //   EVERY resolved agent is correct and future-proofs the imminent
  //   `defaults.dream` fleet-enable. The cron tick gates on `isAgentIdle`
  //   against a REAL lastTurnAt from the shared dream machinery (the
  //   ConversationStore-backed `getLastTurnAt`) — NOT the old
  //   always-null `manager.getLastTurnAt` stub that would have left the
  //   cron registered-but-never-firing.
  //
  // SHARED MACHINERY:
  //   `runDreamPass` / `applyDreamResult` come from the SAME
  //   `buildDreamMachineryForDaemon()` the manual IPC handler uses — one
  //   dream-pass implementation, no parallel path.
  //
  // SHUTDOWN:
  //   Each registration's `.unregister()` is called in the SIGTERM
  //   shutdown sequence alongside dailySummaryCron.stop() /
  //   migrationCron.stop().
  //
  // Sentinel test: `src/manager/__tests__/dream-cron-wiring.test.ts`
  // statically asserts `registerDreamCron` has a production caller in
  // daemon.ts so this bug class cannot recur silently.
  const dreamCronRegistrations: DreamCronRegistration[] = [];
  {
    const dreamMachinery = buildDreamMachineryForDaemon();
    for (const agentCfg of resolvedAgents) {
      const dreamCfg = {
        enabled: agentCfg.dream?.enabled ?? false,
        idleMinutes: agentCfg.dream?.idleMinutes ?? 30,
        model: agentCfg.dream?.model ?? "haiku",
      };
      const registration = registerDreamCron({
        agentName: agentCfg.name,
        dreamConfig: dreamCfg,
        // Real ConversationStore-backed lastTurnAt — the cron has no
        // --idle-bypass, so a working timestamp is load-bearing here.
        getLastTurnAt: () => dreamMachinery.getLastTurnAt(agentCfg.name),
        // Cron's runDreamPass takes (agent) only — bake in the agent's
        // configured model. Shared machinery's runDreamPass is (agent, model).
        runDreamPass: (agent: string) =>
          dreamMachinery.runDreamPass(agent, dreamCfg.model),
        applyDreamResult: (agent, outcome) =>
          dreamMachinery.applyDreamResult(agent, outcome),
        // Raw idle-window primitive — DreamCronDeps.isAgentIdle expects
        // the (deps) → result signature; the cron builds IsAgentIdleDeps
        // internally from getLastTurnAt / idleMinutes / now.
        isAgentIdle: isAgentIdlePrimitive,
        now: () => new Date(),
        log: {
          info: (msg: string) => log.info(msg),
          warn: (msg: string) => log.warn(msg),
          error: (msg: string) => log.error(msg),
        },
        // Phase 999.188 — D-05 priority pass: 2+ tier-1 truncations in 24h
        // shorten the idle threshold and let every candidate through the
        // veto window (D-10 Row 5).
        truncationEventCounter: {
          countTruncationEventsSince: (agent: string, sinceMs: number) =>
            manager.getTraceCollector(agent)?.countTruncationEventsSince(agent, sinceMs) ?? 0,
        },
        applyDreamResultPriority: (agent, outcome, isPriorityPass) =>
          dreamMachinery.applyDreamResult(agent, outcome, isPriorityPass),
      });
      if (registration.registered) {
        dreamCronRegistrations.push(registration);
        log.info(
          {
            agent: agentCfg.name,
            idleMinutes: dreamCfg.idleMinutes,
            model: dreamCfg.model,
          },
          "dream cron registered",
        );
      } else if (registration.reason === "disabled") {
        log.debug(
          { agent: agentCfg.name },
          "dream cron skipped (dream.enabled=false)",
        );
      } else {
        // pattern-error (or any non-disabled reason) — a real failure that
        // degraded ONE agent's dreaming. Visible (warn), never fatal: the
        // daemon must boot. INC-2026-06-04 fail-open.
        log.warn(
          { agent: agentCfg.name, reason: registration.reason },
          "dream cron not registered (degraded — daemon continues)",
        );
      }
    }
  }
  log.info(
    { registered: dreamCronRegistrations.length },
    "dream cron wiring complete",
  );
  // Phase 999.188 — the veto tick. Without it every scheduled promotion
  // stayed `pending` forever (Phase 115 shipped the store, never the tick).
  try {
    dreamVetoTick = registerDreamVetoTick({
      vetoStore: dreamVetoStore,
      applyRow: applyDreamVetoRow,
      now: () => new Date(),
      log: {
        info: (obj, msg) => log.info(obj, msg),
        warn: (obj, msg) => log.warn(obj, msg),
      },
    });
    log.info({ everyMinutes: 1 }, "dream veto tick registered");
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "dream veto tick not registered (degraded — promotions stay pending)",
    );
  }

  // 11f'''. Phase 999.98 D9/D10/D11 — model-monitor poll cron. Croner-landmine-
  // safe (registerModelMonitorCron guards BOTH construction + tick). Discovers
  // the entitled model set per running agent via getSupportedModels(), upserts
  // the catalog, refreshes the `@latest` snapshot, and surfaces new-tier /
  // pin-bump PROPOSALS to Admin Clawdy (never auto-flips a pinned agent).
  //
  // getPinnedAgents: running agents pinned to a CONCRETE model become pin-bump
  // candidates; an `@latest`-track agent is EXCLUDED (it adopts new tiers live
  // via the snapshot pre-resolve, so a bump proposal would be noise). The family
  // is derived from the resolved id (resolveModelId collapses the alias).
  const getPinnedAgents = (): readonly PinnedAgentInput[] => {
    const out: PinnedAgentInput[] = [];
    for (const name of manager.getRunningAgents()) {
      const cfg = resolvedAgents.find((a) => a.name === name);
      if (!cfg) continue;
      // Exclude @latest-track agents — they are not pin-bump targets.
      if (cfg.model.endsWith("@latest")) continue;
      const resolvedModelId = resolveModelId(cfg.model);
      const family = deriveFamily(resolvedModelId);
      if (family === null) continue;
      out.push({ name, resolvedModelId, family });
    }
    return out;
  };
  const modelMonitorCron = registerModelMonitorCron({
    catalogStore: modelCatalogStore,
    getRunningAgents: () => manager.getRunningAgents(),
    getHandle: (name) => manager.getSessionHandle(name),
    getPinnedAgents,
    refreshSnapshot: () => {
      latestSnapshot = modelCatalogStore.snapshot();
    },
    postToAdminClawdy,
    now: () => Date.now(),
    log: {
      info: (msg: string) => log.info(msg),
      warn: (msg: string) => log.warn(msg),
      error: (msg: string) => log.error(msg),
    },
  });
  if (modelMonitorCron.registered) {
    log.info(
      { pattern: "0 */6 * * *" },
      "phase999.98 model-monitor cron scheduled (every 6h)",
    );
  } else {
    // pattern-error — degraded (no discovery), never fatal. INC-2026-06-04
    // fail-open: the daemon boots regardless.
    log.warn(
      { reason: modelMonitorCron.reason },
      "phase999.98 model-monitor cron not registered (degraded — daemon continues)",
    );
  }

  // Phase 999.169 — daily CLI + SDK version watch (+ one run ~10 min after boot).
  // Runtime truth: the SDK this daemon LOADED (boot probe) vs the binary on disk
  // NOW (re-probed per tick), so deps staged without a restart show up as skew.
  // Posts to Admin Clawdy only for unsurfaced findings: a newer matched pair,
  // skew, the CLAWCODE_CLAUDE_BIN override, or a fingerprint downgrade.
  const versionWatchState = fileStateStore(join(MANAGER_DIR, "version-watch-state.json"));
  const versionWatchCron = registerVersionWatchCron({
    getRuntime: () => {
      const fresh = probeClaudeBinary();
      return {
        sdkVersion: resolvedBinary.sdkVersion,
        sdkClaudeCodeVersion: resolvedBinary.sdkClaudeCodeVersion,
        binaryVersion: fresh.version,
        source: fresh.source,
        pin: fresh.pin,
        error: fresh.error,
      };
    },
    getHighestFloor: () => checkCliVersion(null, collectCliVersionRequirements(config)).highestRequired,
    fetchJson: defaultFetchJson,
    readState: versionWatchState.read,
    writeState: versionWatchState.write,
    postToAdminClawdy,
    icon: (name, text) => icons.prefix(name, text),
    now: () => Date.now(),
    log: {
      info: (msg: string) => log.info(msg),
      warn: (msg: string) => log.warn(msg),
      error: (msg: string) => log.error(msg),
    },
  });
  if (versionWatchCron.registered) {
    log.info({ pattern: VERSION_WATCH_CRON_PATTERN }, "999.169 version-watch cron scheduled (daily + 10 min after boot)");
  } else {
    log.warn({ reason: versionWatchCron.reason }, "999.169 version-watch cron not registered (degraded — daemon continues)");
  }

  // 11f''''. INC-2026-08-08 — hourly 1Password service-account ratelimit
  // probe. The 1,000-reads/24h cap is SHARED across every service account on
  // the org; on 2026-08-08 two standalone cron jobs shelling `op read`
  // directly drained it and the first signal the fleet got was agents failing
  // to start. This cron shells `op service-account ratelimit`, parses the
  // `account read_write` row, and posts tiered ⚠️/🚨 alerts through the SAME
  // postToAdminClawdy leg the model-monitor uses. Same croner-landmine guards
  // (construction + tick), so a bad probe can never crash the daemon.
  //
  // Cost: 24 probes/day. Whether `service-account ratelimit` itself counts
  // against the read cap is undocumented; worst case that is 2.4% of the daily
  // budget — a fair price for early warning. The probe deliberately does NOT
  // route through the on-box `op-cached` wrapper: that funnel is a URI-keyed
  // cache for `op read`, and this is not a read.
  const ratelimitMonitorCron = registerRatelimitMonitorCron({
    runRatelimitProbe: defaultOpRatelimitShellOut,
    postToAdminClawdy,
    now: () => Date.now(),
    log: {
      info: (msg: string) => log.info(msg),
      warn: (msg: string) => log.warn(msg),
      error: (msg: string) => log.error(msg),
    },
  });
  if (ratelimitMonitorCron.registered) {
    log.info(
      { pattern: "17 * * * *" },
      "1p-ratelimit monitor cron scheduled (hourly at :17)",
    );
  } else {
    // pattern-error — degraded (no ratelimit visibility), never fatal.
    log.warn(
      { reason: ratelimitMonitorCron.reason },
      "1p-ratelimit monitor cron not registered (degraded — daemon continues)",
    );
  }

  // 11g. Phase 999.14 — start the periodic MCP orphan reaper. Runs every 60s
  // AFTER manager.startAll has had time to spawn fresh MCP children (the
  // first tick fires at t=60s, by which time the npm-wrapper exec handoff
  // is complete and the 5s-young filter excludes any in-progress spawn).
  //
  // The onTickAfter callback runs the MCP-09 stale-binding sweep AFTER the
  // orphan reap completes — locked decision per CONTEXT.md (sweep observes
  // post-reap registry state). Disabled when defaults.threadIdleArchiveAfter
  // === "0" or subagentThreadSpawner is null (Discord disabled).
  if (mcpTracker) {
    const idleAfter =
      (config.defaults as { threadIdleArchiveAfter?: string }).threadIdleArchiveAfter ?? "24h";
    let idleMs = 0;
    try {
      idleMs = parseIdleDuration(idleAfter);
    } catch (err) {
      mcpLog.error(
        { err: String(err), idleAfter },
        "invalid threadIdleArchiveAfter; sweep disabled",
      );
    }
    // Phase 999.15 TRACK-01 — reconciler ALWAYS runs (independent of the
    // 999.14 stale-binding sweep). Both calls are wrapped in their own
    // try/catch so a failure in one does NOT block the other or propagate
    // to startOrphanReaper (which would crash the 60s tick loop).
    const sweepEnabled = idleMs > 0 && subagentThreadSpawner != null;
    // 2026-05-08 hotfix: snapshot for TS narrowing post-TDZ-fix (outer is `let`).
    const sweepSpawner = subagentThreadSpawner;
    // Phase 999.36 sub-bug D — dedupe quiescence warnings per binding so
    // a stuck subagent doesn't generate a warning every quiescenceMinutes.
    // Map keyed by threadId; value = timestamp of last warning emitted.
    // In-memory only (resets on daemon restart — quiescence resumes from
    // a fresh sweep cycle which is acceptable).
    const idleWarningEmittedAt = new Map<string, number>();
    // P4 — fork/pool leak candidates must survive TWO consecutive 60s ticks
    // before a reap-mode stop fires (alert-before-reap grace). Names not
    // re-seen on a tick are cleared, so a transient blip never accumulates.
    const forkPoolSightings = new Map<string, number>();
    const onTickAfter = async () => {
      if (sweepEnabled && sweepSpawner) {
        try {
          await sweepStaleBindings({
            spawner: sweepSpawner,
            registryPath: THREAD_REGISTRY_PATH,
            now: Date.now(),
            idleMs,
            log: mcpLog,
            // Phase 999.X — when a stale binding belongs to an auto-
            // spawned subagent thread (name regex match), also stop
            // the underlying session. Operator-defined agent bindings
            // are filtered inside sweepStaleBindings via
            // isSubagentThreadName, so this callback is safe to pass
            // unconditionally.
            stopSubagentSession: (name) => manager.stopAgent(name),
          });
        } catch (err) {
          mcpLog.error(
            { err: String(err) },
            "stale-binding sweep failed (non-fatal)",
          );
        }
      }
      // Phase 999.15 TRACK-01 — tracker reconciliation (independent of sweep).
      if (mcpTracker) {
        try {
          await reconcileAllAgents({
            tracker: mcpTracker,
            daemonPid: process.pid,
            log: mcpLog,
            getClaudePid: getClaudePidByName,
          });
        } catch (err) {
          mcpLog.error(
            { err: String(err) },
            "reconcileAllAgents failed (non-fatal)",
          );
        }
      }
      // Phase 109-B — orphan-claude reaper. Runs AFTER the reconciler so a
      // freshly-discovered SDK respawn (TRACK-02 polled discovery) gets
      // registered before this scan can mark it as orphaned. Reads the
      // current mode from the live config defaults so a yaml hot-reload
      // (defaults.orphanClaudeReaper.mode) takes effect on the next tick
      // without a daemon restart.
      if (
        mcpTracker &&
        mcpBootTimeUnix !== undefined &&
        mcpClockTicksPerSec !== undefined
      ) {
        const oc = (config.defaults as {
          orphanClaudeReaper?: {
            mode?: OrphanClaudeReaperMode;
            minAgeSeconds?: number;
          };
        }).orphanClaudeReaper;
        const mode: OrphanClaudeReaperMode = oc?.mode ?? "alert";
        const minAgeSeconds = oc?.minAgeSeconds ?? 30;
        const mcpUidForReaper = process.getuid?.() ?? -1;
        try {
          await tickOrphanClaudeReaper({
            daemonPid: process.pid,
            tracker: mcpTracker,
            uid: mcpUidForReaper,
            minAgeSeconds,
            bootTimeUnix: mcpBootTimeUnix,
            clockTicksPerSec: mcpClockTicksPerSec,
            mode,
            log: mcpLog.child({ subsystem: "orphan-claude-reaper" }),
          });
        } catch (err) {
          mcpLog.error(
            { err: String(err) },
            "orphan-claude reaper tick failed (non-fatal)",
          );
        }
      }
      // Phase 999.X — subagent-thread session reaper. Walks the
      // session registry + thread bindings to find auto-spawned
      // subagent sessions (`*-via-*-<nanoid6>` / `*-sub-<nanoid6>`)
      // that are: (a) orphaned (binding gone but session still
      // running) or (b) idle (binding lastActivity > idleTimeout).
      // Reads config.defaults.subagentReaper each tick so a yaml
      // hot-reload takes effect on the next 60s sweep. Wrapped in
      // its own try/catch so a failure here does NOT crash the
      // tick loop or block other reapers.
      try {
        const sr = (config.defaults as {
          subagentReaper?: {
            mode?: SubagentReaperMode;
            idleTimeoutMinutes?: number;
            minAgeSeconds?: number;
          };
        }).subagentReaper;
        const subMode: SubagentReaperMode = sr?.mode ?? "reap";
        const subIdleTimeoutMinutes = sr?.idleTimeoutMinutes ?? 1440;
        const subMinAgeSeconds = sr?.minAgeSeconds ?? 300;
        // Snapshot both registries at tick start (matches the
        // orphan-claude-reaper invariant: the decision uses one
        // consistent snapshot, no mid-walk mutation).
        const sessionRegistry = await readRegistry(REGISTRY_PATH);
        const sessions: readonly RunningSessionInfo[] = sessionRegistry.entries.map(
          (e) => ({
            name: e.name,
            status: e.status,
            startedAt: e.startedAt,
          }),
        );
        const threadRegistry = await readThreadRegistry(THREAD_REGISTRY_PATH);
        await tickSubagentSessionReaper({
          sessions,
          bindings: threadRegistry.bindings,
          idleTimeoutMinutes: subIdleTimeoutMinutes,
          minAgeSeconds: subMinAgeSeconds,
          mode: subMode,
          log: mcpLog.child({ subsystem: "subagent-session-reaper" }),
          stopAgent: (name) => manager.stopAgent(name),
        });
      } catch (err) {
        mcpLog.error(
          { err: String(err) },
          "subagent-session reaper tick failed (non-fatal)",
        );
      }
      // P4 (memory program) — remediation-gated reapers. Two-plane rule:
      // MemoryGuard budgets only ever ALERT; everything here acts on
      // STRUCTURAL orphan signals (ppid-1 + no live partner, absent from
      // the live registry, orphaned parent, over-cap). Modes resolve
      // through the tighten-only lattice in reap-policy.ts — the new
      // classes default "off", so this block is INERT until the operator
      // flips defaults.memoryGuard.remediation (rollout: off → alert →
      // reap). Own try/catch: a failure never blocks the other reapers.
      try {
        const remediation = (
          config.defaults as {
            memoryGuard?: { remediation?: RemediationConfig };
          }
        ).memoryGuard?.remediation;
        const remLog = mcpLog.child({ subsystem: "remediation" });

        // npm/npx wrapper strays (ppid-1, ≥10min, no live pipe partner).
        const npmMode = resolveRemediationMode("npm", remediation, process.env);
        if (npmMode !== "off") {
          await actOnScannedOrphans({
            reason: "npm-stray",
            mode: npmMode,
            scan: () =>
              scanForNpmStrays({
                uid: mcpUid,
                clockTicksPerSec: readClockTicksPerSec(),
                bootTimeUnix: bootTimeUnixForReaper,
              }),
            log: remLog,
          });
        }

        // Survivor claude CLIs (ppid-1, absent from the live pid set the
        // MemoryGuard census uses, ≥15min old, daemon up ≥5min).
        const survivorMode = resolveRemediationMode(
          "survivor-cli",
          remediation,
          process.env,
        );
        if (survivorMode !== "off") {
          const livePids = new Set<number>([
            ...manager.listClaudePids().map((p) => p.pid),
            ...getBridgeChildPids(),
          ]);
          await actOnScannedOrphans({
            reason: "survivor-cli",
            mode: survivorMode,
            scan: () =>
              scanForSurvivorClis({
                uid: mcpUid,
                clockTicksPerSec: readClockTicksPerSec(),
                bootTimeUnix: bootTimeUnixForReaper,
                livePids,
                daemonUptimeSeconds: process.uptime(),
              }),
            log: remLog,
          });
        }

        // Fork/pool session leaks (registry plane). Alert-before-reap:
        // a candidate acts only after TWO consecutive-tick sightings.
        const forkMode = resolveRemediationMode("fork", remediation, process.env);
        const poolMode = resolveRemediationMode("pool", remediation, process.env);
        if (forkMode !== "off" || poolMode !== "off") {
          const reg = await readRegistry(REGISTRY_PATH);
          const runningAgentNames = new Set(
            reg.entries
              .filter(
                (e) => e.status === "running" && spawnKindOf(e.name) === "agent",
              )
              .map((e) => e.name),
          );
          const candidates = scanForForkPoolSessions({
            sessions: reg.entries.map((e) => ({
              name: e.name,
              status: e.status,
              startedAt: e.startedAt,
            })),
            runningAgentNames,
            isPoolManaged: (n) => warmPoolForReaper?.isPoolManaged(n) ?? false,
            poolCapForParent: (p) =>
              warmPoolForReaper?.poolCapForParent(p) ?? 0,
            parentOf: forkPoolParentOf,
          });
          const seenThisTick = new Set<string>();
          for (const c of candidates) {
            const mode = c.kind === "fork" ? forkMode : poolMode;
            if (mode === "off") continue;
            seenThisTick.add(c.name);
            const sightings = (forkPoolSightings.get(c.name) ?? 0) + 1;
            forkPoolSightings.set(c.name, sightings);
            const acting = mode === "reap" && sightings >= 2;
            remLog.warn(
              {
                component: "remediation",
                action: acting ? "reap" : "alert",
                kind: c.kind,
                sessionName: c.name,
                reason: c.reason,
                ageSec: c.ageSec,
                sightings,
                mode,
              },
              acting
                ? "reaping leaked fork/pool session"
                : "fork/pool leak candidate detected",
            );
            if (acting) {
              try {
                await manager.stopAgent(c.name);
                forkPoolSightings.delete(c.name);
              } catch (stopErr) {
                remLog.warn(
                  { sessionName: c.name, err: String(stopErr) },
                  "fork/pool reap stop failed",
                );
              }
            }
          }
          for (const name of [...forkPoolSightings.keys()]) {
            if (!seenThisTick.has(name)) forkPoolSightings.delete(name);
          }
        }
      } catch (err) {
        mcpLog.error(
          { err: String(err) },
          "remediation reaper tick failed (non-fatal)",
        );
      }
      // Subagent quiescence sweep. Phase 999.25 fired the relay here, but
      // Phase 999.36 sub-bug D removed it because a mid-think subagent
      // (between tool calls, 5+ min wait) could have a relay sent to the
      // parent's main channel before its actual final chunks arrived.
      //
      // Quiescence-relay is now back, but GATED:
      //   - `lastDeliveryAt !== null` — the spawner's post-delivery stamp
      //     landed, so the final text + overflow chunks fully drained to
      //     Discord. Closes the premature-relay class that motivated the
      //     999.36 D removal.
      //   - `producedRealContent === true` — the SDK turn produced real
      //     content (not the unedited "🔄 Working…" placeholder). Closes
      //     the placeholder-relay class fixed by commit `bdf2cdc3`.
      //   - `subagentCompletion.relayOnQuiescence !== false` — operator
      //     rollback knob (default true). When false, falls back to the
      //     pre-fix observational-only behaviour without losing the idle
      //     warning.
      //
      // When gates pass, the sweep delegates to the same unified
      // `relayAndMarkCompletedByThreadId` path used by the explicit
      // `subagent_complete` tool and the session-end backstop. When gates
      // fail, the existing `subagent_idle_warning` log is emitted instead.
      try {
        const scCfg = (config.defaults as {
          subagentCompletion?: {
            enabled?: boolean;
            quiescenceMinutes?: number;
            relayOnQuiescence?: boolean;
          };
        }).subagentCompletion;
        const completionEnabled = scCfg?.enabled !== false;
        const quiescenceMinutes = scCfg?.quiescenceMinutes ?? 5;
        const relayOnQuiescence = scCfg?.relayOnQuiescence !== false;
        // Snapshot both registries (consistent-snapshot invariant
        // matches subagent-session-reaper above).
        const sessionRegistryForCompletion = await readRegistry(REGISTRY_PATH);
        const sessionsForCompletion = sessionRegistryForCompletion.entries.map(
          (e) => ({ name: e.name, status: e.status }),
        );
        const threadRegistryForCompletion = await readThreadRegistry(
          THREAD_REGISTRY_PATH,
        );
        // Build the relay deps once per tick, mirroring the explicit-tool
        // `subagent-complete` IPC handler at daemon.ts case "subagent-complete".
        // The same shape is reused so `completedAt` dedupe and the
        // delivery-confirmed retry loop behave identically across paths.
        const sweepSpawner = subagentThreadSpawner;
        const sweepRelayDeps = {
          readThreadRegistry: () => readThreadRegistry(THREAD_REGISTRY_PATH),
          mutateThreadRegistry: (
            mutator: Parameters<typeof mutateThreadRegistry>[1],
          ) => mutateThreadRegistry(THREAD_REGISTRY_PATH, mutator),
          relayCompletionToParent: sweepSpawner
            ? (threadId: string) => sweepSpawner.relayCompletionToParent(threadId)
            : null,
          now: () => Date.now(),
          log: mcpLog.child({ subsystem: "subagent-completion" }),
          enabled: completionEnabled,
          sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
        };
        await tickSubagentCompletionSweep({
          sessions: sessionsForCompletion,
          bindings: threadRegistryForCompletion.bindings,
          quiescenceMinutes,
          enabled: completionEnabled,
          log: mcpLog.child({ subsystem: "subagent-completion-sweep" }),
          onQuiescent: async (c) => {
            // Try the gated relay first. If gates pass the relay fires
            // (and `completedAt` is stamped, terminalizing the binding).
            // If gates fail, fall back to the idle-warning helper so the
            // operator sees a stuck subagent.
            const relayResult = await handleSubagentQuiescenceRelay({
              candidate: c,
              enabled: relayOnQuiescence && completionEnabled,
              relayDeps: sweepRelayDeps,
              log: mcpLog,
            });
            if (relayResult.outcome === "relayed") {
              return { ok: true, reason: relayResult.reason };
            }
            const warningResult = handleSubagentQuiescenceWarning({
              candidate: c,
              emittedAt: idleWarningEmittedAt,
              now: Date.now(),
              quiescenceMinutes,
              log: mcpLog,
            });
            return { ok: true, reason: warningResult };
          },
        });
      } catch (err) {
        mcpLog.error(
          { err: String(err) },
          "subagent-completion sweep tick failed (non-fatal)",
        );
      }

      // Phase 145 WS2 (Plan 06) — drive the background workflow orchestrator's
      // fan-in sweep from this SAME 60s tick (the SINGLE driver, alongside the
      // reapers + completion sweep; no separate timer → no silent-path-
      // bifurcation per feedback_silent_path_bifurcation). The sweep refreshes
      // each running worker's lastActivity (reaper survival) + posts throttled
      // progress pings. The barrier itself is promise-based inside the
      // orchestrator's background job, NOT here. INERT until an agent invokes
      // start_workflow (no running workflows → the sweep is a no-op).
      try {
        const orchestrator = workflowOrchestratorRef.current;
        if (orchestrator) {
          await orchestrator.sweepWorkflows(Date.now());
        }
      } catch (err) {
        mcpLog.error(
          { err: String(err) },
          "workflow-orchestrator sweep tick failed (non-fatal)",
        );
      }
    };
    const mcpUid = process.getuid?.() ?? -1;
    const bootTimeUnixForReaper = await readBootTimeUnix();
    const mcpPatternsForReaper = buildMcpCommandRegexes(mcpServersConfig);
    reaperInterval = startOrphanReaper({
      uid: mcpUid,
      patterns: mcpPatternsForReaper,
      clockTicksPerSec: readClockTicksPerSec(),
      bootTimeUnix: bootTimeUnixForReaper,
      intervalMs: 60_000,
      log: mcpLog,
      onTickAfter,
    });
    mcpLog.info(
      {
        intervalMs: 60_000,
        sweepEnabled,
        reconcilerEnabled: true, // Phase 999.15 TRACK-01 — always-on
        idleMs,
      },
      "mcp orphan reaper + stale-binding sweep + reconciler started",
    );
  }

  // 12. Register signal handlers per D-15
  const shutdown = async (): Promise<void> => {
    log.info("shutdown signal received");
    // Phase 999.6 SNAP-01 — write running-fleet snapshot FIRST so a hang
    // anywhere downstream still leaves boot with a valid restore record.
    // getRunningAgents() reflects the live SDK-attached sessions; this is
    // the moment of truth before drain/stopAll begin tearing down.
    try {
      await writePreDeploySnapshot(
        PRE_DEPLOY_SNAPSHOT_PATH,
        manager.getRunningAgents().map((name) => ({
          name,
          sessionId: manager.getSessionHandle?.(name)?.sessionId ?? null,
        })),
        log,
      );
    } catch (err) {
      log.warn(
        { err: (err as Error).message },
        "pre-deploy snapshot write failed (non-fatal — boot falls back to static autoStart)",
      );
    }
    // Phase 108 — broker preDrainNotify BEFORE manager.drain. Stops new
    // shim connections immediately while existing ones continue serving
    // any in-flight tool calls until manager.drain finishes the agents'
    // last turns. RESEARCH.md §5 ordering invariant.
    try {
      shimServer.preDrainNotify();
    } catch (err) {
      log.warn(
        { err: (err as Error).message },
        "mcp-broker preDrainNotify threw (non-fatal)",
      );
    }
    // 260419-q2z Fix B — drain in-flight session summaries BEFORE closing any
    // downstream resource. The 15s ceiling matches summarizeSession's internal
    // 10s timeout + 5s slack for embed + insert + markSummarized. After drain
    // returns, new turn dispatches via streamFromAgent/dispatchTurn reject
    // with SessionError('shutting down ...'), so stopAll() below is safe from
    // races with an in-progress turn.
    try {
      const drainResult = await manager.drain(15_000);
      log.info(
        { settled: drainResult.settled, timedOut: drainResult.timedOut },
        "session manager drain complete",
      );
    } catch (err) {
      // drain() is designed not to throw, but log defensively so an
      // unexpected exception doesn't block the rest of shutdown.
      log.warn(
        { err: (err as Error).message },
        "session manager drain threw unexpectedly (non-fatal)",
      );
    }
    // Phase 108 — drain the broker AFTER manager.drain so any shim-routed
    // tool calls in-flight during the agents' final turns can complete.
    // The 2000ms ceiling matches Pitfall 3 (last-ref drain timeout). We
    // wrap in try/catch so a hung broker shutdown doesn't block the rest
    // of daemon shutdown — log + continue.
    try {
      await shimServer.shutdown(2000);
    } catch (err) {
      log.warn(
        { err: (err as Error).message },
        "mcp-broker shutdown threw (non-fatal)",
      );
    }
    try {
      brokerNetServer.close();
      // Best-effort cleanup of the socket file so the next daemon boot
      // doesn't trip on EADDRINUSE.
      try {
        await unlink(MCP_BROKER_SOCKET_PATH);
      } catch {
        // socket may not exist — fine.
      }
    } catch (err) {
      log.warn(
        { err: (err as Error).message },
        "mcp-broker socket close threw (non-fatal)",
      );
    }
    // Phase 140 Plan 07 (#14) — tear down every v3 agent's ClawCode channel
    // socket listener. Runs AFTER manager.drain (agents' final turns done) so a
    // late channel push can't fault a closing socket. closeAll() is best-effort
    // (swallows per-listener errors) + removes the socket files so the next boot
    // doesn't trip on EADDRINUSE.
    try {
      await agentChannelRegistry.closeAll();
    } catch (err) {
      log.warn(
        { err: (err as Error).message },
        "agent channel registry closeAll threw (non-fatal)",
      );
    }
    // Phase 69 — close OpenAI endpoint FIRST: activeStreams drained + server
    // closed + apiKeysStore handle released, before the dashboard (which
    // owns the IPC socket for CLI fallback queries) shuts down. The
    // endpoint-bootstrap helper encapsulates the Pitfall 10 ordering
    // (activeStreams → server.close → store.close).
    //
    // Phase 74 Plan 02 invariant: the ordering is manager.drain() (above)
    // → openAiEndpoint.close() (which internally drains the OpenClaw
    // TransientSessionCache before server.close()) → browserManager.close()
    // → server.close(). In-flight openclaw-template transient turns either
    // finish cleanly or abort with AbortError — no leaked SDK subprocesses.
    await withShutdownStep(
      "openAiEndpoint.close",
      () => openAiEndpoint.close(),
      DEFAULT_SHUTDOWN_STEP_TIMEOUT_MS,
      log,
    );
    if (dashboard) {
      const dashboardToClose = dashboard;
      await withShutdownStep(
        "dashboard.close",
        () => dashboardToClose.close(),
        DEFAULT_SHUTDOWN_STEP_TIMEOUT_MS,
        log,
      );
    }
    // Backlog 999.95 — stop the preview keepalive timer + end open SSE streams.
    previewStore.close();
    await configWatcher.stop();
    await policyWatcher.stop();
    // Phase 70 — close the browser BEFORE the IPC server so any in-flight
    // browser-tool-call requests fail cleanly. BrowserManager.close() runs
    // Pitfall-10 ordered save-state → ctx.close → browser.close per agent,
    // so cookies / localStorage / IndexedDB are flushed to disk here.
    await withShutdownStep(
      "browserManager.close",
      () => browserManager.close(),
      DEFAULT_SHUTDOWN_STEP_TIMEOUT_MS,
      log,
    );
    server.close();
    // Debug session `relay-delivery-not-confirmed` (FAULT 2) — drain
    // pending subagent completion relays BEFORE `discordBridge.stop()`.
    // `discordBridge.stop()` calls `client.destroy()`, which clears the
    // discord.js REST token; after that any `channels.fetch()` throws
    // "Expected token to be set for this request, but none was present".
    // The per-subagent session-end callbacks (registered at spawn time)
    // fire LATER in this closure when the agents are stopped — too late,
    // the token is gone. Running the drain here, while the client is still
    // alive, relays every not-yet-completed subagent and stamps
    // `completedAt` so the later session-end callbacks dedupe instead of
    // re-attempting the now-tokenless post. Bounded so a slow Discord
    // cannot hang shutdown; never throws.
    if (subagentThreadSpawner) {
      const drainSpawner = subagentThreadSpawner;
      try {
        await drainPendingSubagentRelays({
          getSubagentBindings: () => drainSpawner.getSubagentBindings(),
          stampLastDeliveryAt: (threadId, deliveredAt, producedRealContent) =>
            stampLastDeliveryAt(
              THREAD_REGISTRY_PATH,
              threadId,
              deliveredAt,
              producedRealContent,
            ),
          relayDeps: {
            readThreadRegistry: () => readThreadRegistry(THREAD_REGISTRY_PATH),
            mutateThreadRegistry: (mutator) =>
              mutateThreadRegistry(THREAD_REGISTRY_PATH, mutator),
            relayCompletionToParent: (threadId) =>
              drainSpawner.relayCompletionToParent(threadId),
            now: () => Date.now(),
            log: log.child({ subsystem: "subagent-completion" }),
            enabled: true,
            sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
            // The drain force-stamps `lastDeliveryAt` itself immediately
            // before relaying, so the defer-and-retry loop has nothing to
            // wait for — one fast attempt keeps shutdown snappy.
            deliveryRetry: { attempts: 1, delayMs: 50 },
          },
          now: () => Date.now(),
          log,
          perBindingTimeoutMs: 5_000,
          totalBudgetMs: 20_000,
        });
      } catch (err) {
        // drainPendingSubagentRelays is designed not to throw — log
        // defensively so an unexpected exception cannot block shutdown.
        log.warn(
          { err: (err as Error).message },
          "pre-teardown subagent-relay drain threw unexpectedly (non-fatal)",
        );
      }
    }
    if (discordBridge) {
      const bridgeToStop = discordBridge;
      await withShutdownStep(
        "discordBridge.stop",
        () => bridgeToStop.stop(),
        DEFAULT_SHUTDOWN_STEP_TIMEOUT_MS,
        log,
      );
    }
    // Multi-platform messaging — stop the Slack bridge (disconnects Socket Mode).
    if (slackMessagingBridge) {
      try {
        await slackMessagingBridge.stop();
      } catch (err) {
        log.warn({ err: (err as Error).message }, "slack bridge stop failed (non-fatal)");
      }
    }
    await withShutdownStep(
      "slashHandler.stop",
      () => slashHandler.stop(),
      DEFAULT_SHUTDOWN_STEP_TIMEOUT_MS,
      log,
    );
    triggerEngine.stopAll(); // Stop trigger sources (clears debounce timers)
    taskScheduler.stop();    // Stop handler-based cron jobs
    heartbeatRunner.stop();
    dailySummaryCron.stop();
    memoryDigestCron.stop();
    reportCardCron.stop();
    try {
      sharedFactsStore.close();
    } catch {
      /* already closed */
    }
    // Phase 115-postdeploy 2026-05-12 — embedding-v2 migration cron stop.
    migrationCron.stop();
    // Phase dream-cron-wiring — stop every per-agent dream cron.
    for (const registration of dreamCronRegistrations) {
      registration.unregister?.();
    }
    // Phase 999.188 — stop the veto tick with the dream crons.
    dreamVetoTick?.stop();
    // Clean up all subagent thread bindings before stopping agents
    if (subagentThreadSpawner) {
      const subBindings = await subagentThreadSpawner.getSubagentBindings();
      for (const binding of subBindings) {
        try { await subagentThreadSpawner.cleanupSubagentThread(binding.threadId); } catch { /* best-effort */ }
      }
    }
    // Clean up all thread sessions before stopping agents.
    // Phase 999.14 MCP-08 — also route every binding through
    // cleanupThreadWithClassifier so the registry is pruned on Discord
    // 50001/10003/404 even during shutdown (operator pain regression:
    // today's incident left 3 stale fin-client bindings because
    // shutdown's catch swallowed the error path).
    const allBindings = await threadManager.getActiveBindings();
    for (const binding of allBindings) {
      try { await threadManager.removeThreadSession(binding.threadId); } catch (err) {
        log.debug({ err: String(err), threadId: binding.threadId }, "removeThreadSession failed during shutdown (non-fatal)");
      }
      if (subagentThreadSpawner) {
        try {
          await cleanupThreadWithClassifier({
            spawner: subagentThreadSpawner,
            registryPath: THREAD_REGISTRY_PATH,
            threadId: binding.threadId,
            agentName: binding.agentName ?? "(unknown)",
            log,
          });
        } catch (err) {
          log.warn({ err: String(err), threadId: binding.threadId }, "cleanupThreadWithClassifier failed during shutdown (non-fatal)");
        }
      }
    }
    deliveryQueue.stop();
    deliveryDb.close();
    advisorBudgetDb.close();
    // Phase 138 Plan 05 — stop the 1-minute failover cron BEFORE
    // closing `fleetAlertDb` so an in-flight tick never writes to a
    // closed handle (the shutdown-order contract flagged in the Plan 03
    // SUMMARY).
    failoverCron.stop();
    // Phase 138 Plan 03 T-03 — close the fleet-level coordination db
    // (`provider_alert_state` + `failover_state`).
    fleetAlertDb.close();
    // Phase 999.98 D8/D9 — stop the model-monitor cron BEFORE closing the
    // catalog db so an in-flight tick never writes to a closed handle (the
    // same failover shutdown-order contract). `stop?.()` is safe even when the
    // registration returned {registered:false} (no `stop`).
    modelMonitorCron.stop?.();
    versionWatchCron.stop?.();
    // INC-2026-08-08 — stop the 1P ratelimit probe on the same shutdown rung.
    // `stop?.()` is safe even when registration returned {registered:false}.
    ratelimitMonitorCron.stop?.();
    modelCatalogDb.close();
    webhookManager.destroy();

    // FIND-123-A.next T-03 — structural group-kill of every per-agent claude
    // process tree BEFORE manager.stopAll(). The SDK's own close path
    // (invoked by stopAll) lets MCP grandchildren reparent to PID 1; here
    // we preempt that by killing the entire process group of each claude
    // subprocess via the PID captured by makeDetachedSpawn (T-02).
    //
    // Why BEFORE stopAll, not after:
    //   - stopAll's dispose() removes the SessionHandle from sessions,
    //     which clears its pidSink in `close()`. By the time killAll
    //     would run, every handle.getClaudePid() returns null.
    //   - Issuing SIGTERM to the negative-PID FIRST guarantees the
    //     claude tree (and its MCP grandchildren) receive the signal
    //     while the daemon still owns the kill-permission grant
    //     (PID 1 doesn't yet "own" the reparented children).
    //
    // Read each handle's claudePid via getClaudePid() — additive-optional
    // on the SessionHandle TYPE, so legacy/mock handles without the
    // wrapper silently skip and rely on the existing backstop reaper.
    //
    // killAgentGroup's negative-PID kill in mcpTracker.killAll() STAYS as
    // additive defense-in-depth (research §Out-of-scope; advisor #6).
    try {
      const runningAgents = manager.getRunningAgents();
      const claudePidSnapshot: Array<{ agent: string; claudePid: number }> = [];
      for (const agentName of runningAgents) {
        const handle = manager.getSessionHandle(agentName);
        const pid = handle?.getClaudePid?.();
        if (typeof pid === "number" && pid > 1) {
          claudePidSnapshot.push({ agent: agentName, claudePid: pid });
        }
      }
      for (const { agent, claudePid } of claudePidSnapshot) {
        let killed = false;
        try {
          process.kill(-claudePid, "SIGTERM");
          killed = true;
        } catch (err) {
          // ESRCH is benign (process group already gone); anything else
          // gets logged but never blocks shutdown.
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "ESRCH") {
            mcpLog.warn(
              { agent, claudePid, err: String(err) },
              "123-A-next-shutdown-pgkill: SIGTERM to claude process group failed",
            );
          }
        }
        mcpLog.info(
          { agent, claudePid, killed },
          "[123-A-next-shutdown-pgkill]",
        );
      }
      // Grace period — let SIGTERM propagate before the SDK's normal close
      // races with us in stopAll(). 1500ms matches the 2s window the
      // existing shutdown-scan reaper uses (research §implementation).
      if (claudePidSnapshot.length > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1_500));
      }
    } catch (err) {
      mcpLog.warn(
        { err: String(err) },
        "123-A-next-shutdown-pgkill: snapshot/dispatch failed (non-fatal — backstop reaper still runs)",
      );
    }

    await withShutdownStep(
      "manager.stopAll",
      () => manager.stopAll(),
      DEFAULT_SHUTDOWN_STEP_TIMEOUT_MS,
      log,
    );
    // Phase 999.14 MCP-04 — clear the reaper interval and SIGTERM/SIGKILL
    // any tracked MCP child PIDs that survived stopAll. Runs AFTER stopAll
    // (so per-agent killAgentGroup hooks have already fired) and BEFORE
    // pid-file/socket cleanup. Idempotent on dead PIDs (ESRCH treated as
    // success). 5s grace before SIGKILL — matches systemd's TimeoutStopSec.
    if (reaperInterval) {
      clearInterval(reaperInterval);
      reaperInterval = null;
    }
    if (mcpTracker) {
      try {
        await mcpTracker.killAll(5_000);
      } catch (err) {
        mcpLog.error(
          { err: String(err) },
          "mcp tracker killAll failed during shutdown (non-fatal)",
        );
      }
    }
    // FIND-123-A — synchronous orphan sweep AFTER killAll. ClawCode does
    // not own the `claude` subprocess spawn (the Claude Agent SDK does,
    // non-detached) so the tracker's negative-pid kills in killAll silently
    // ESRCH on MCP-wrapper PIDs that share the daemon's pgid. When claude
    // exits, its `mcp-server-mysql` grandchildren reparent to PID 1 and
    // wait up to one reaper interval (≥60s, observed 9 min) before the
    // periodic sweep on the next daemon boot reaps them. Running reapOrphans
    // here, at the exact moment we know the orphans have just appeared,
    // closes the window. 2s grace is sufficient — these processes were
    // alive seconds ago and SIGTERM-then-SIGKILL is the same path the
    // periodic reaper already exercises.
    if (mcpTracker && mcpPatterns !== undefined && mcpUid !== undefined
        && mcpBootTimeUnix !== undefined && mcpClockTicksPerSec !== undefined) {
      try {
        await reapOrphans({
          uid: mcpUid,
          patterns: mcpPatterns,
          clockTicksPerSec: mcpClockTicksPerSec,
          bootTimeUnix: mcpBootTimeUnix,
          reason: "shutdown-scan",
          log: mcpLog,
          graceMs: 2_000,
        });
      } catch (err) {
        mcpLog.error(
          { err: String(err) },
          "mcp shutdown-scan reap failed (non-fatal)",
        );
      }
    }
    // Close TaskStore AFTER manager.stopAll() so any in-flight agent
    // transition that writes to the store completes first (Phase 58 Plan 03).
    try {
      taskStore.close();
    } catch (err) {
      log.warn({ err: (err as Error).message }, "taskStore close failed");
    }
    // Phase 61: Clean up mysql2 pool (sources already stopped by triggerEngine.stopAll)
    if (mysqlPool) {
      try {
        await mysqlPool.end();
        log.info("mysql2 pool closed");
      } catch (err) {
        log.error({ error: (err as Error).message }, "mysql2 pool close failed");
      }
    }
    // Phase 115 Plan 07 sub-scope 15 — close the tool-cache singleton
    // and stop the size-metric sampler. Best-effort; an unclean close
    // doesn't block shutdown.
    try {
      clearInterval(toolCacheSizeReporter);
      toolCacheStore.close();
    } catch (err) {
      log.warn(
        { err: (err as Error).message },
        "tool-cache close failed (non-fatal)",
      );
    }
    await unlink(SOCKET_PATH).catch((err) => { log.debug({ path: SOCKET_PATH, error: (err as Error).message }, "socket file cleanup failed (may not exist)"); });
    await unlink(PID_PATH).catch((err) => { log.debug({ path: PID_PATH, error: (err as Error).message }, "pid file cleanup failed (may not exist)"); });
  };

  // C1 — stuck-shutdown wedge. A single shared signal entry point that:
  //   1. arms a top-level force-exit watchdog covering the ENTIRE shutdown
  //      closure (the per-step `withShutdownStep` bounds above are the inner
  //      net; this is the outer net for anything still unbounded), and
  //   2. guards against re-entry so a second signal during teardown doesn't
  //      run the 445-line closure twice.
  // The watchdog exit code matches the signal's intended disposition so the
  // SIGHUP→129 / systemd `RestartForceExitStatus=129` contract is preserved
  // even when the watchdog (not the natural exit) fires.
  let shuttingDown = false;
  const handleShutdownSignal = (signal: string, exitCode: number): void => {
    if (shuttingDown) {
      log.info({ signal }, "shutdown already in progress — ignoring repeat signal");
      return;
    }
    shuttingDown = true;
    const watchdog = armShutdownWatchdog(
      exitCode,
      DEFAULT_SHUTDOWN_WATCHDOG_MS,
      (code) => process.exit(code),
      log,
    );
    void shutdown()
      .catch((err) => {
        // shutdown() is designed not to throw, but a force-exit on an
        // unexpected throw is still better than leaving the process wedged.
        log.error(
          { signal, err: err instanceof Error ? err.message : String(err) },
          "shutdown closure threw unexpectedly — forcing exit",
        );
      })
      .finally(() => {
        watchdog.disarm();
        process.exit(exitCode);
      });
  };

  process.on("SIGTERM", () => handleShutdownSignal("SIGTERM", 0));

  process.on("SIGINT", () => handleShutdownSignal("SIGINT", 0));

  // Phase 999.23 — SIGHUP handler. Without this, an agent inside the daemon
  // that runs `kill -HUP <pid>` (or systemctl reload, which sends SIGHUP by
  // default) terminates the daemon silently because Node's default SIGHUP
  // disposition is to exit. Combined with `Restart=on-failure`, systemd
  // does NOT restart on a SIGHUP-induced exit (treated as clean). Outage
  // 2026-05-01 06:07: Admin Clawdy fell back to `kill -HUP` after sudo
  // refused systemctl reload; daemon died silently and stayed down.
  //
  // Behavior: graceful shutdown then exit with code 129 (128 + signal 1).
  // The systemd unit declares RestartForceExitStatus=129 so that exit code
  // is treated as a failure trigger, restoring the restart loop.
  process.on("SIGHUP", () => {
    log.info("received SIGHUP — initiating clean shutdown (will systemd-restart)");
    handleShutdownSignal("SIGHUP", 129);
  });

  log.info({ socket: SOCKET_PATH }, "manager daemon started");

  // Auto-start all configured agents on daemon boot.
  //
  // Phase 100 follow-up — operator-curated active fleet. The full
  // `resolvedAgents` array is preserved for routeMethod (so the `start
  // <name>` IPC handler at line ~3990 can find dormant configs via
  // `configs.find((c) => c.name === name)` and the operator can manually
  // boot them later). Only the boot auto-start path filters out
  // `autoStart=false` agents — they don't get an SDK session on daemon
  // start, cutting cold-start time from O(N agents × 2-3s) to
  // O(active agents × 2-3s). Skipped agents are logged at info level so
  // operators can verify the skip happened (not a silent failure).
  // Phase 999.6 SNAP-02 — read pre-deploy snapshot and union into autoStart set.
  // Awaited synchronously (sub-10ms). Reader deletes the file before returning
  // to prevent infinite auto-revive loops on partial-startAll failures.
  const snapshotKnownAgentNames = new Set(resolvedAgents.map((c) => c.name));
  const restoredFromSnapshot = await readAndConsumePreDeploySnapshot(
    PRE_DEPLOY_SNAPSHOT_PATH,
    snapshotKnownAgentNames,
    config.defaults.preDeploySnapshotMaxAgeHours ?? 24,
    log,
  );

  const autoStartAgents = resolvedAgents.filter((cfg) => {
    if (cfg.autoStart !== false) return true;
    if (restoredFromSnapshot.has(cfg.name)) {
      log.info(
        { agent: cfg.name },
        "boot auto-start via pre-deploy snapshot (yaml autoStart=false overridden for one boot)",
      );
      return true;
    }
    log.info(
      { agent: cfg.name },
      "skipping boot auto-start — autoStart=false (manually startable via `clawcode start <name>`)",
    );
    return false;
  });

  // Clean up stale "starting" or "running" statuses for skipped agents.
  // reconcileRegistry ignores "starting" entries entirely, so an agent that
  // stalled during warmup (e.g. MCP timeout on a previous boot) keeps that
  // status forever — the fleet shows it as "starting" indefinitely. "running"
  // is also stale: if the session never resumed or was not attempted
  // (autoStart=false), the registry should reflect that the agent is stopped.
  {
    const skippedNames = new Set(
      resolvedAgents
        .filter((cfg) => !autoStartAgents.includes(cfg))
        .map((cfg) => cfg.name),
    );
    if (skippedNames.size > 0) {
      try {
        // Collect the cleared entries inside the atomic mutator (logging is
        // done after, so the mutator stays pure w.r.t. the registry); a no-op
        // returns the same reference and skips the write.
        const cleared: { name: string; was: string }[] = [];
        await mutateRegistry(REGISTRY_PATH, (current) => {
          let next = current;
          for (const entry of current.entries) {
            if (
              skippedNames.has(entry.name) &&
              (entry.status === "starting" || entry.status === "running")
            ) {
              cleared.push({ name: entry.name, was: entry.status });
              next = updateEntry(next, entry.name, { status: "stopped" });
            }
          }
          return next;
        });
        for (const c of cleared) {
          log.info({ agent: c.name, was: c.was }, "cleared stale active status for autoStart=false agent");
        }
      } catch (err) {
        log.warn({ error: (err as Error).message }, "failed to clear stale registry statuses for skipped agents (non-fatal)");
      }
    }
  }

  // Phase 999.25 — sort by wakeOrder (lower = earlier). `undefined` becomes
  // Infinity so unordered agents boot LAST. Stable sort: ties + same-priority
  // groups preserve YAML order. Boot remains sequential (startAll uses
  // `for...await`); this only changes the order, not the total time.
  const sortedAutoStartAgents = [...autoStartAgents].sort(
    (a, b) => (a.wakeOrder ?? Infinity) - (b.wakeOrder ?? Infinity),
  );
  if (sortedAutoStartAgents.some((c) => c.wakeOrder !== undefined)) {
    log.info(
      {
        order: sortedAutoStartAgents.map((c) => ({
          name: c.name,
          wakeOrder: c.wakeOrder ?? null,
        })),
      },
      "wake-order applied to auto-start sequence",
    );
  }
  void (async () => {
    try {
      await manager.startAll(sortedAutoStartAgents);
      log.info(
        {
          agents: sortedAutoStartAgents.length,
          skipped: resolvedAgents.length - sortedAutoStartAgents.length,
        },
        "all agents auto-started",
      );
    } catch (err) {
      log.error({ error: (err as Error).message }, "failed to auto-start agents");
    }
    // Phase 119 A2A-01 sentinel — D-02 (revised 2026-05-14 post-deploy).
    // Verifies the bot-direct fallback wiring is reachable on the production
    // path WITHOUT actually delivering a side-effecting message. The original
    // sentinel called handlePostToAgentIpc self-ping which delivered a real
    // webhook message to the agent's channel — operator-visible noise in
    // #admin-clawdy on every boot (4 sentinel messages from 2 deploys).
    //
    // The original silent-path-bifurcation it was designed to prevent: "we
    // added the bot-direct fallback in code but production never executes
    // it." The dependency presence check below catches that EXACT class of
    // bug (DI wiring break post-deploy) without the round-trip side effect.
    // Unit tests at daemon-post-to-agent-ipc.test.ts continue to exercise
    // the dispatch chain end-to-end with mocks.
    if (process.env.VITEST || process.env.NODE_ENV === "test") return;
    try {
      const running = manager.getRunningAgents();
      const probeAgent = sortedAutoStartAgents.find((a) =>
        running.includes(a.name),
      )?.name;
      if (!probeAgent) {
        log.warn(
          { sentinel: "A2A-01" },
          "[A2A-01-sentinel] FAIL — no running agent available to probe",
        );
        return;
      }
      const sender = botDirectSenderRef.current;
      const probeChannels = routingTableRef.current.agentToChannels.get(probeAgent);
      const wiringOk =
        webhookManager !== undefined &&
        sender !== null &&
        sender !== undefined &&
        typeof sender.sendText === "function" &&
        probeChannels !== undefined &&
        probeChannels.length > 0;
      if (wiringOk) {
        log.info(
          {
            sentinel: "A2A-01",
            probeAgent,
            channels: probeChannels.length,
          },
          "[A2A-01-sentinel] OK — wiring verified (webhookManager + botDirectSender + agent-channels registered)",
        );
      } else {
        log.warn(
          {
            sentinel: "A2A-01",
            probeAgent,
            hasWebhookManager: webhookManager !== undefined,
            hasBotDirectSender: sender !== null && sender !== undefined,
            hasAgentChannels: probeChannels !== undefined && probeChannels.length > 0,
          },
          "[A2A-01-sentinel] FAIL — DI wiring incomplete",
        );
      }
    } catch (err) {
      log.warn(
        { sentinel: "A2A-01", error: (err as Error).message },
        "[A2A-01-sentinel] FAIL",
      );
    }
  })();

  // TaskManager owns no external resources (inflight timers .unref()'d,
  // db handle owned by TaskStore via PayloadStore). No explicit shutdown needed.
  return { server, manager, taskStore, taskManager, payloadStore, triggerEngine, routingTable, rateLimiter, heartbeatRunner, taskScheduler, skillsCatalog, slashHandler, threadManager, webhookManager, discordBridge, subagentThreadSpawner, configWatcher, configReloader, policyWatcher, routingTableRef, secretsResolver, dashboard: dashboard ?? { server: null as unknown as ReturnType<typeof import("node:http").createServer>, sseManager: null as unknown as import("../dashboard/sse.js").SseManager, close: async () => {} }, shutdown };
}

/**
 * Route an IPC method to the appropriate SessionManager action.
 */
// 999.160 v1.2 — `clawcode icons sync` reaches the Discord bridge through this
// late-bound getter: the bridge is constructed inside startup while routeMethod
// is module-level (same shape as the memory-relief deps factory).
type IconSyncBridge = {
  syncIcons(files: ReadonlyArray<{ readonly name: string; readonly png: string }>): Promise<import("../discord/icons.js").IconSyncResult>;
};
let iconSyncBridgeGetter: (() => IconSyncBridge | null) | null = null;
export function setIconSyncBridgeGetter(fn: () => IconSyncBridge | null): void {
  iconSyncBridgeGetter = fn;
}

export async function routeMethod(
  manager: SessionManager,
  configs: readonly import("../shared/types.js").ResolvedAgentConfig[],
  method: string,
  params: Record<string, unknown>,
  routingTableRef: { current: RoutingTable },
  rateLimiter: RateLimiter,
  heartbeatRunner: HeartbeatRunner,
  taskScheduler: TaskScheduler,
  skillsCatalog: SkillsCatalog,
  threadManager: ThreadManager,
  webhookManager: WebhookManager,
  deliveryQueue: DeliveryQueue,
  subagentThreadSpawner: SubagentThreadSpawner | null,
  allowlistMatchers: Map<string, AllowlistMatcher>,
  approvalLog: ApprovalLog,
  securityPolicies: Map<string, SecurityPolicy>,
  escalationMonitor: EscalationMonitor,
  advisorBudget: AdvisorBudget,
  discordBridgeRef: { current: DiscordBridge | null },
  configPath: string,
  agentsBasePath: string,
  taskManager: TaskManager,
  taskStore: TaskStore,
  schedulerSource: SchedulerSource,
  // Phase 999.12 IPC-02 — bot-direct sender ref for ask-agent's no-webhook
  // fallback path. Mutable ref so the closure reads `.current` at call time
  // (Pitfall 7: pre-bridge boot leaves .current null).
  botDirectSenderRef: { current: import("./restart-greeting.js").BotDirectSender | null },
  // Phase 117 Plan 07 T01 — provider-neutral advisor service. The
  // `ask-advisor` IPC handler dispatches through this. `advisorBudget`
  // is also passed (unchanged) because the native short-circuit path
  // reports `budget_remaining` straight from the budget without going
  // through the service.
  advisorService: AdvisorService,
  // Phase 117 Plan 07 T02 — daemon-wide defaults block for advisor
  // backend resolution at the IPC handler gate (`resolveAdvisorBackend`).
  // Closes over `config.defaults` so the handler can short-circuit for
  // native-backend agents before invoking the service.
  advisorDefaults: {
    readonly advisor?: { readonly backend?: string };
  } | undefined,
  // Phase 124 Plan 04 T-01 — in-memory log of last-compaction timestamps.
  // Read by `heartbeat-status` (surfaces `last_compaction_at` per agent)
  // and written by `compact-session` on `ok:true`. Single source of truth
  // for both the telemetry surface and the auto-trigger cooldown gate.
  compactionEventLog: CompactionEventLog,
  // Phase 138 Plan 03 T-03 — boot-constructed credit-threshold alerter.
  // The `heartbeat-status` case fires `void thresholdAlerter.evaluate(...)`
  // with the same aggregator snapshot it serves to the IPC client, so a
  // 75/90/95/99% crossing dispatches a deduped Discord alert. Constructed
  // ONCE at boot (a single `fleet-alerts.db` connection); passed by
  // reference so the handler never re-opens the db per heartbeat.
  thresholdAlerter: import("../usage/threshold-alerter.js").ThresholdAlerter,
  // Phase 138 Plan 04 T-03 — per-agent runtime resolver lookup. The
  // `compact-session` IPC handler resolves the SDK module through this
  // (mirrors the heartbeat auto-trigger site, which has direct
  // lexical access). Threaded as a parameter because `routeMethod` is
  // a top-level function — `llmRuntimeRegistry` is constructed inside
  // the daemon-boot closure and not in scope here otherwise.
  getLlmRuntime: (
    agentName: string,
  ) => import("../llm-runtime/index.js").LlmRuntimeService,
  // Phase 138 Plan 05 T-06 — the live FailoverStateStore. Backs the
  // `failover-status` / `failover-reset` / `failover-set` IPC handlers
  // (the `clawcode failover` CLI surface). Threaded as a parameter
  // because `routeMethod` is a top-level function and the store is
  // constructed inside the daemon-boot closure.
  failoverStateStore: import("../usage/failover-state.js").FailoverStateStore,
  // Phase 140 #14b — per-agent ClawCode channel registry. The `post-to-agent`
  // IPC handler reads `agentChannelRegistry.get(to)?.bridge` to deliver to a v3
  // (claude-code-interactive) target via channel push instead of the v2
  // webhook/heartbeat cascade. Threaded as a parameter because `routeMethod` is
  // a top-level function and the registry is constructed in the daemon-boot
  // closure (same rationale as getLlmRuntime / failoverStateStore above).
  agentChannelRegistry: AgentChannelRegistry,
  // /clawcode-goal — boot-constructed owner of running goal loops. The
  // goal-set / goal-status / goal-clear handlers call into it.
  goalManager: GoalManager,
  // Phase 999.114 — live discovered-model catalog snapshot accessor. The
  // `set-model` handler needs it to resolve a `<family>@latest` live switch to
  // a concrete SDK id. Boot-constructed in the daemon closure (same rationale
  // as getLlmRuntime / agentChannelRegistry above), so it arrives as a param.
  getCatalogSnapshot: () => CatalogSnapshot,
  // Phase 999.117 WS-3 — the fleet-wide A2A loop governor. The
  // `post-to-agent` handler evaluates every cross-agent message against it
  // before the inbox write. Threaded as a parameter for the same reason as
  // agentChannelRegistry / getLlmRuntime above: `routeMethod` is a top-level
  // function and the governor is constructed in the daemon-boot closure.
  // ONE instance fleet-wide — a second would split the per-conversation and
  // per-pair counters and silently double every budget.
  // Phase 999.117 — the agent-to-agent services, bundled.
  //
  // One object rather than four more positional parameters: `routeMethod`
  // already takes 34, and each addition means touching every call site plus
  // the test harness's `u, u, u, ...` run. These four are always constructed
  // together in the daemon-boot closure and always used together by the
  // post-to-agent handler, so they travel as a unit.
  a2a: A2aServices,
): Promise<unknown> {
  switch (method) {
    case "start": {
      const name = validateStringParam(params, "name");
      const config = configs.find((c) => c.name === name);
      if (!config) {
        throw new ManagerError(`Agent '${name}' not found in config`);
      }
      await manager.startAgent(name, config);
      return { ok: true };
    }

    case "stop": {
      const name = validateStringParam(params, "name");
      await manager.stopAgent(name);
      return { ok: true };
    }

    case "restart": {
      const name = validateStringParam(params, "name");
      const config = configs.find((c) => c.name === name);
      if (!config) {
        throw new ManagerError(`Agent '${name}' not found in config`);
      }
      // If the agent is already stopped, restartAgent() throws from its
      // internal stopAgent() call. Fall back to a plain start so
      // "restart" works uniformly regardless of current state.
      try {
        await manager.restartAgent(name, config);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/not running|no such session|requireSession/i.test(msg)) {
          await manager.startAgent(name, config);
        } else {
          throw err;
        }
      }
      return { ok: true };
    }

    // Phase 138 Plan 05 T-06 — `clawcode failover` operator surface.
    // Admin-only by the SAME gate as `stop` / `restart`: the IPC socket
    // is owner-only (chmod 0700 dir, src/manager/daemon.ts socket
    // setup) — there is no per-request content check; reaching the
    // daemon at all means shell access on the daemon host.
    case "failover-status": {
      const agentFilter =
        typeof params.agent === "string" && params.agent.length > 0
          ? params.agent
          : undefined;
      const active = failoverStateStore.listActive(Date.now());
      const rows = (
        agentFilter
          ? active.filter((r) => r.agent === agentFilter)
          : active
      ).map((r) => ({
        agent: r.agent,
        active_backend: r.active_backend,
        reason: r.reason,
        triggered_at: r.triggered_at,
        expires_at: r.expires_at,
      }));
      return { rows };
    }

    case "failover-reset": {
      const agentName = validateStringParam(params, "agent");
      failoverStateStore.clear(agentName);
      logger.info(
        { tag: "phase138-failover-manual-reset", agent: agentName },
        "phase138-failover-manual-reset",
      );
      return { ok: true as const, agent: agentName, action: "reset" as const };
    }

    case "failover-set": {
      const agentName = validateStringParam(params, "agent");
      const backendRaw = validateStringParam(params, "backend");
      if (
        backendRaw !== "anthropic-agent-sdk" &&
        backendRaw !== "codex-cli"
      ) {
        throw new ManagerError(
          `Invalid backend '${backendRaw}' — must be 'anthropic-agent-sdk' or 'codex-cli'`,
        );
      }
      // Manual override — `expires_at = NULL` (until-cleared; operator
      // agency per CONTEXT D8). `reason = 'manual'` so the audit trail
      // distinguishes it from a `threshold-95` auto-failover.
      failoverStateStore.set(agentName, backendRaw, "manual", null);
      logger.info(
        {
          tag: "phase138-failover-manual-set",
          agent: agentName,
          backend: backendRaw,
        },
        "phase138-failover-manual-set",
      );
      return {
        ok: true as const,
        agent: agentName,
        action: "set" as const,
        backend: backendRaw,
      };
    }

    case "start-all": {
      await manager.startAll(configs);
      return { ok: true };
    }

    case "stop-all": {
      await manager.stopAll();
      return { ok: true };
    }

    case "status": {
      const registry = await readRegistry(REGISTRY_PATH);
      return { entries: registry.entries };
    }

    case "routes": {
      return {
        channels: Object.fromEntries(routingTableRef.current.channelToAgent),
        agents: Object.fromEntries(routingTableRef.current.agentToChannels),
      };
    }

    case "rate-limit-status": {
      const stats = rateLimiter.getStats();
      return {
        globalTokens: stats.globalTokens,
        channelTokens: Object.fromEntries(stats.channelTokens),
        queueDepths: Object.fromEntries(stats.queueDepths),
      };
    }

    case "list-rate-limit-snapshots": {
      // Phase 103 OBS-06 — per-agent OAuth Max usage snapshots. Resolves the
      // RateLimitTracker via SessionManager (returns undefined when agent is
      // not running OR when the agent has no UsageTracker DB to share — see
      // Plan 02 startAgent flow). Empty `snapshots: []` when no data so the
      // /clawcode-usage embed can render the "No usage data yet" graceful
      // path (Pitfall 7).
      //
      // NOT the same as the existing `rate-limit-status` case above —
      // that's the Discord outbound rate-limiter token bucket (Pitfall 5).
      const { handleListRateLimitSnapshotsIpc } = await import(
        "./daemon-rate-limit-ipc.js"
      );
      const agent = validateStringParam(params, "agent");
      const { livePlanSnapshots } = await import("../usage/plan-usage-probe.js");
      return handleListRateLimitSnapshotsIpc(
        { agent },
        {
          getRateLimitTrackerForAgent: (name) =>
            manager.getRateLimitTrackerForAgent(name),
        },
        await livePlanSnapshots(),
      );
    }

    case "list-rate-limit-snapshots-fleet": {
      // Phase 116-postdeploy — fleet aggregate of subscription utilisation
      // snapshots. Mirrors the `costs` aggregation pattern at daemon.ts:9547:
      // iterates `manager.getRunningAgents()`, asks each for its
      // RateLimitTracker, and rolls up `getAllSnapshots()` into a single
      // wire payload so the Usage page can render fleet-level bars without
      // doing N round-trips from the SPA.
      //
      // Empty `agents: []` when no agents are running OR none have emitted
      // a `rate_limit_event` yet — the SPA renders the "data appears after
      // first turn" graceful path on empty.
      const { handleListRateLimitSnapshotsIpc } = await import(
        "./daemon-rate-limit-ipc.js"
      );
      const agents: Array<{
        agent: string;
        snapshots: ReturnType<typeof handleListRateLimitSnapshotsIpc>["snapshots"];
      }> = [];
      const { livePlanSnapshots } = await import("../usage/plan-usage-probe.js");
      const live = await livePlanSnapshots();
      for (const agentName of manager.getRunningAgents()) {
        const result = handleListRateLimitSnapshotsIpc(
          { agent: agentName },
          {
            getRateLimitTrackerForAgent: (name) =>
              manager.getRateLimitTrackerForAgent(name),
          },
          live,
        );
        agents.push({ agent: result.agent, snapshots: result.snapshots });
      }
      return { agents };
    }

    case "heartbeat-status": {
      // Phase 124 Plan 04 T-01 — delegated to the pure builder so the
      // telemetry surface (session_tokens, last_compaction_at) stays
      // unit-testable. Pre-Plan-04 inline body preserved verbatim inside
      // the builder; behavior is additive (existing consumers parse the
      // same shape).
      //
      // Phase 138 Plan 02 T-02 — attach fleet credit telemetry. The
      // aggregator reads every agent's per-agent usage.db read-only at
      // snapshot time (CONTEXT D2 — compute-on-demand, no central table).
      // `configs` (NOT getRunningAgents) is the agent source so a stopped
      // agent's same-day spend still counts toward the cap. The cap
      // cascade is resolved straight off ResolvedAgentConfig.providers,
      // which the Plan 01 loader already cascades agent-over-defaults;
      // the consumer only applies the DEFAULT_DAILY_CAP_USD fallback.
      const { ProviderTelemetryAggregator } = await import(
        "./provider-telemetry-aggregator.js"
      );
      const { DEFAULT_DAILY_CAP_USD } = await import(
        "../usage/provider-usage-tracker.js"
      );
      const providerTelemetryAggregator = new ProviderTelemetryAggregator({
        // Callback form — always reflects the current configs after a
        // hot-reload without rebuilding the aggregator.
        agents: () =>
          configs.map((c) => ({
            name: c.name,
            usageDbPath: join(c.memoryPath, "memory", "usage.db"),
          })),
        resolveCap: (provider, agentName) => {
          const cfg = agentName
            ? configs.find((c) => c.name === agentName)
            : undefined;
          const capped =
            provider === "openai"
              ? cfg?.providers?.openai?.dailyCapUsd
              : cfg?.providers?.anthropic?.dailyCapUsd;
          return capped ?? DEFAULT_DAILY_CAP_USD;
        },
        loggerFactory: () => logger,
      });
      // Phase 138 Plan 03 T-03 — compute the credit-telemetry snapshot
      // ONCE, then (a) feed the SAME payload to the ThresholdAlerter and
      // (b) hand the builder a `{snapshot: () => payload}` so the IPC
      // client and the alerter observe identical data — no double agent
      // db read, no silent-path bifurcation (HARD CONSTRAINT #4).
      const creditSnapshot = providerTelemetryAggregator.snapshot();
      // Fire-and-forget — the Discord round-trip never blocks the IPC
      // response. A 75/90/95/99% crossing dispatches a deduped alert via
      // `provider_alert_state` in fleet-alerts.db. `.evaluate` itself
      // never rejects (webhook errors are caught inside); the `.catch`
      // here is a belt-and-braces guard for an unexpected throw.
      void thresholdAlerter
        .evaluate(creditSnapshot)
        .catch((err: unknown) =>
          logger.error(
            { tag: "phase138-alerter-uncaught", err: String(err) },
            "phase138-alerter-uncaught",
          ),
        );
      return buildHeartbeatStatusPayload({
        results: heartbeatRunner.getLatestResults(),
        zoneStatuses: heartbeatRunner.getZoneStatuses(),
        getLastCompactionAt: (a) => compactionEventLog.getLastCompactionAt(a),
        getContextFillProvider: (a) => manager.getContextFillProvider(a),
        providerTelemetryAggregator: { snapshot: () => creditSnapshot },
        // Phase 999.122 — 24 h incident window from the transition journal.
        transitionJournal: heartbeatRunner.getTransitionJournal(),
      });
    }

    case "context-zone-status": {
      const zoneStatuses = heartbeatRunner.getZoneStatuses();
      const agentsResult: Record<string, { zone: string; fillPercentage: number }> = {};
      for (const [name, data] of zoneStatuses) {
        agentsResult[name] = { zone: data.zone, fillPercentage: data.fillPercentage };
      }
      return { agents: agentsResult };
    }

    case "schedules": {
      // Phase 999.99 — merge runtime recurring schedules alongside the config
      // cron statuses so `list_schedules` surfaces them (SC-4). The existing
      // `schedules` field is preserved for back-compat (existing consumers read
      // it); reminders are NOT surfaced here (SC-4 = recurring only).
      const statuses = taskScheduler.getStatuses();
      const recurring = schedulerSource.listRecurring();
      return { schedules: statuses, recurring };
    }

    case "skills": {
      const catalog = Array.from(skillsCatalog.entries()).map(([, entry]) => ({ ...entry }));
      const allAssignments = Object.fromEntries(configs.map((c) => [c.name, c.skills]));

      const agentFilter = typeof params.agent === "string" ? params.agent : undefined;
      const assignments = agentFilter
        ? Object.fromEntries(
            Object.entries(allAssignments).filter(([name]) => name === agentFilter),
          )
        : allAssignments;

      // Phase 130 Plan 03 T-02 — surface refused skills per agent. When
      // `agent` is supplied, return only that agent's unloaded list (matches
      // the `assignments` filter shape). When unfiltered, return the full map.
      const unloadedSkills: Record<string, readonly UnloadedSkillEntry[]> = {};
      if (agentFilter !== undefined) {
        unloadedSkills[agentFilter] = manager.getUnloadedSkills(agentFilter);
      } else {
        for (const c of configs) {
          unloadedSkills[c.name] = manager.getUnloadedSkills(c.name);
        }
      }

      return { catalog, assignments, unloadedSkills };
    }

    // Phase 999.2 Plan 02 D-RNI-IPC-01 — canonical name `ask-agent` and the
    // deprecated alias `send-message` share a single body via stacked-case.
    // The deprecated branch logs a one-line metric so operators can grep the
    // daemon journal for `deprecated.*alias.*used` to verify the 30-day
    // removal trigger (D-RNX-03 / Open Question 2 in RESEARCH.md).
    case "goal-set":
    case "goal-status":
    case "goal-clear": {
      // /clawcode-goal — resolve the target agent: an explicit `agent` param
      // wins; otherwise the agent bound to the invoking channel (mirrors the
      // /clawcode-interrupt resolution).
      const explicitAgent =
        typeof params.agent === "string" && params.agent.trim() !== ""
          ? (params.agent as string)
          : undefined;
      const channelId =
        typeof params.channelId === "string" ? (params.channelId as string) : undefined;
      const goalAgent =
        explicitAgent ??
        (channelId ? routingTableRef.current.channelToAgent.get(channelId) : undefined);
      if (!goalAgent) {
        throw new ManagerError(
          "No agent for goal — run /clawcode-goal in an agent-bound channel, or pass `agent:`.",
        );
      }

      if (method === "goal-status") {
        return { agent: goalAgent, ...goalManager.status(goalAgent) };
      }
      if (method === "goal-clear") {
        return { ok: true, agent: goalAgent, ...goalManager.clear(goalAgent) };
      }
      // goal-set — the condition carries the goal + any soft stop-clauses.
      const condition = validateStringParam(params, "condition").trim();
      if (condition.length === 0) {
        throw new ManagerError("Goal condition must not be empty.");
      }
      if (condition.length > 4000) {
        throw new ManagerError("Goal condition too long (max 4000 chars).");
      }
      const { replaced } = goalManager.start(goalAgent, condition);
      return { ok: true, agent: goalAgent, replaced, condition };
    }

    case "ask-agent":
    case "send-message": {
      if (method === "send-message") {
        // Operator metric for D-RNX-03's 30-day removal trigger. Operator
        // greps the daemon journal for `deprecated.*alias.*used` after the
        // horizon; zero hits → safe to remove the alias. Matches the
        // console-based logging style used elsewhere in routeMethod (the
        // daemon-scoped pino `log` is not threaded into this function).
        console.info(
          `[deprecated IPC alias used] alias=send-message canonical=ask-agent`,
        );
      }
      const from = validateStringParam(params, "from");
      const to = validateStringParam(params, "to");
      const content = validateStringParam(params, "content");
      const priority = typeof params.priority === "string" ? params.priority : "normal";
      const mirror = params.mirror_to_target_channel === true;

      // Find target agent config to get workspace path
      const targetConfig = configs.find((c) => c.name === to);
      if (!targetConfig) {
        throw new ManagerError(`Target agent '${to}' not found in config`);
      }

      // Phase 75 SHARED-01 — memoryPath (not workspace) so cross-agent
      // sends deliver to the target's private inbox, never a shared one.
      const inboxDir = join(targetConfig.memoryPath, "inbox");

      // Phase 999.2 Plan 03 — delegate inbox-write + dispatch + mirror to the
      // pure-DI handler (mirrors the Phase 103 daemon-rate-limit-ipc.ts /
      // Phase 96 daemon-fs-ipc.ts blueprint). Errors from dispatchTurn now
      // PROPAGATE to the IPC client (D-SYN-05) — the silent `try {} catch {}`
      // that lived here pre-Plan-03 (and was masking ALL dispatch errors as
      // false-success) is GONE.
      const { handleAskAgentIpc } = await import("./daemon-ask-agent-ipc.js");
      const askResult = await handleAskAgentIpc(
        { from, to, content, priority, mirror_to_target_channel: mirror },
        {
          runningAgents: manager.getRunningAgents(),
          dispatchTurn: (toName, msg) => manager.dispatchTurn(toName, msg),
          // Phase 999.117 WS-3 — the SAME governor instance post-to-agent
          // uses, so both entry paths share one set of budgets. Two
          // instances would each see half the traffic and neither would
          // reach a threshold.
          loopGovernor: a2a.governor,
          writeInbox: async (p) => {
            const message = createMessage(
              p.from,
              p.to,
              p.content,
              p.priority as "normal" | "high" | "urgent",
            );
            await writeMessage(inboxDir, message);
            return { messageId: message.id };
          },
          webhookManager,
          configs,
          // routeMethod has no pino-childed log in scope; console is the
          // existing tracing surface (matches webhook-failure logging in
          // post-to-agent at this same case-block).
          log: {
            info: (...args: unknown[]) => console.info(...args),
            warn: (...args: unknown[]) => console.warn(...args),
            error: (...args: unknown[]) => console.error(...args),
          },
          // Phase 999.12 IPC-02 — bot-direct fallback for response mirror
          // when target lacks a webhook. Late-bound ref read so pre-bridge
          // boot windows (Pitfall 7) silently skip the mirror without throwing.
          botDirectSender: {
            sendText: async (channelId: string, text: string) => {
              const sender = botDirectSenderRef.current;
              if (!sender) return;
              await sender.sendText(channelId, text);
            },
          },
          agentChannels: routingTableRef.current.agentToChannels,
          // Phase 140 #14b(ask) — v3 target asks over the channel (push +
          // awaitReply) instead of dispatchTurn. undefined for v2/SDK targets.
          getBridge: (agent) => agentChannelRegistry.get(agent)?.bridge,
        },
      );

      // Phase 999.2 D-SYN-06 — escalation path UNCHANGED. The handler
      // returns {ok, messageId, response} without inspecting indicators;
      // escalation runs HERE at the daemon edge, on the response text the
      // handler returned, and may overwrite the response by re-dispatching
      // through escalationMonitor.escalate (which talks to the SessionManager
      // — a dependency we deliberately don't push into the pure module).
      if (askResult.response !== undefined) {
        const ERROR_INDICATORS = [
          "i can't", "i'm unable", "i don't have the capability",
          "tool_use_error", "error executing",
        ];
        const lowerResponse = askResult.response.toLowerCase();
        const isError = ERROR_INDICATORS.some((indicator) => lowerResponse.includes(indicator));
        if (escalationMonitor.shouldEscalate(to, askResult.response, isError)) {
          const escalatedResponse = await escalationMonitor.escalate(to, content);
          return {
            ok: true,
            messageId: askResult.messageId,
            response: escalatedResponse,
            escalated: true,
          };
        }
        return {
          ok: true,
          messageId: askResult.messageId,
          response: askResult.response,
          escalated: false,
        };
      }

      return { ok: true, messageId: askResult.messageId };
    }

    // Phase 999.2 Plan 02 D-RNI-IPC-02 — canonical name `post-to-agent` and
    // the deprecated alias `send-to-agent` share a single body via stacked-
    // case. Deprecated branch logs a metric mirroring the ask-agent path.
    case "post-to-agent":
    case "send-to-agent": {
      if (method === "send-to-agent") {
        // Operator metric — see the matching block in case "send-message"
        // above for rationale (D-RNX-03 / RESEARCH.md Open Question 2).
        console.info(
          `[deprecated IPC alias used] alias=send-to-agent canonical=post-to-agent`,
        );
      }
      const from = validateStringParam(params, "from");
      const to = validateStringParam(params, "to");
      const message = validateStringParam(params, "message");

      // Quick 260511-pw2 — delegate to the pure-DI handler so all six
      // silent-skip points emit structured `post-to-agent skipped` logs
      // with reason tags (mirrors Phase 999.18 / quick 260501-i3r
      // `subagent relay skipped` substrate). Sender's tool result now
      // surfaces `{ok, delivered, reason?, messageId}` so the MCP wrapper
      // can render explicit "queued in inbox" text — fixes the
      // post-id-looks-task-shaped confusion Admin Clawdy observed.
      const { handlePostToAgentIpc } = await import("./daemon-post-to-agent-ipc.js");
      return await handlePostToAgentIpc(
        { from, to, message },
        {
          runningAgents: manager.getRunningAgents(),
          configs,
          agentChannels: routingTableRef.current.agentToChannels,
          webhookManager,
          writeInbox: async (p) => {
            const targetConfig = configs.find((c) => c.name === p.to);
            if (!targetConfig) {
              // Defensive — handler validated already, but writeInbox is a
              // pure dep so it owns its own precondition.
              throw new ManagerError(`Target agent '${p.to}' not found`);
            }
            // Phase 75 SHARED-01 — memoryPath (not workspace) so the inbox
            // write lands in the target's private inbox even in
            // shared-workspace deployments.
            const inboxDir = join(targetConfig.memoryPath, "inbox");
            // WS-0 (quick 260716-u5h) — propagate p.kind. This closure
            // previously dropped it, so acks landed on disk as kind
            // "message": the inbox-ack loop-prevention ("never ack an ack")
            // and the WS-0 ack turn-suppression both key on the persisted
            // kind and were inert for every daemon-written ack (classic
            // silent-path-bifurcation; fed the 2026-07-16 self-echo chain).
            // Phase 999.117 WS-1 — thread the envelope onto the persisted
            // message so the recipient's reply carries the conversation
            // forward and the governor sees the real depth on the next hop.
            // Dropping these here would make every hop look like hop 1 —
            // exactly the silent-bifurcation shape that made p.kind inert
            // for daemon-written acks until 2026-07-16.
            const inboxMsg = createMessage(
              p.from,
              p.to,
              p.content,
              "normal",
              p.kind ?? "message",
              {
                conversationId: p.conversationId,
                causationId: p.causationId,
                hops: p.hops,
                autoSubmitted: p.autoSubmitted,
              },
            );
            await writeMessage(inboxDir, inboxMsg);
            return { messageId: inboxMsg.id };
          },
          log: {
            info: (...args: unknown[]) => console.info(...args),
            warn: (...args: unknown[]) => console.warn(...args),
            error: (...args: unknown[]) => console.error(...args),
          },
          // Phase 999.117 WS-3 — loop governor. Single fleet-wide instance
          // built at boot (see a2aLoopGovernor); counters are in-memory, so
          // a restart clears them, which is the right failure mode.
          loopGovernor: a2a.governor,
          deliveryDedupe: a2a.dedupe,
          presentations: a2a.presentations,
          reactionSender: a2a.reactionSender,
          // Phase 119 A2A-01 — bot-direct fallback for the no-webhook path.
          // Late-bound ref read so pre-bridge boot windows silently skip the
          // bot-direct rung without throwing (mirrors the ask-agent wiring
          // shape above at this same case-block).
          botDirectSender: {
            sendText: async (channelId: string, text: string) => {
              const sender = botDirectSenderRef.current;
              if (!sender) return;
              await sender.sendText(channelId, text);
            },
          },
          // Phase 140 #14b — v3 target delivery. Returns the live bridge for a
          // claude-code-interactive agent (else undefined → unchanged cascade).
          getBridge: (agent) => agentChannelRegistry.get(agent)?.bridge,
        },
      );
    }

    // Phase 999.117 WS-6 — operator visibility for A2A loop governance.
    // `clawcode a2a status` reads this. Reports the RESOLVED thresholds the
    // governor is actually running with, not what the YAML says, so a knob
    // that failed to apply (several in this codebase were documented
    // reloadable and were not) is visible rather than assumed.
    case "a2a-status": {
      return {
        governor: a2a.governor.describeConfig(),
        trackedConversations: a2a.governor.trackedConversations(),
        openBreakers: a2a.governor.listOpenBreakers(),
        dedupeTracked: a2a.dedupe.size(),
      };
    }

    case "set-effort": {
      const name = validateStringParam(params, "name");
      const level = validateStringParam(params, "level");
      // Phase 83 EFFORT-04 — accepts the full v2.2 level set.
      // Quick 260715-j1j (D8) — validLevels derives from effortSchema.options
      // (single source; kills the hardcoded-array drift). The ultracode
      // eligibility gate lives in setEffortForAgent — an ineligible agent's
      // UltracodeNotAllowedError propagates through the IPC error envelope
      // with its operator-readable reason.
      const validLevels: readonly string[] = effortSchema.options;
      if (!validLevels.includes(level)) {
        throw new ManagerError(`Invalid effort level '${level}'. Valid: ${validLevels.join(", ")}`);
      }
      manager.setEffortForAgent(name, level as EffortLevel);
      return { ok: true, agent: name, effort: level };
    }

    case "get-effort": {
      const name = validateStringParam(params, "name");
      const level = manager.getEffortForAgent(name);
      return { ok: true, agent: name, effort: level };
    }

    case "set-permission-mode": {
      // Phase 87 CMD-02 — live SDK permission-mode swap. Delegates to the
      // pure testable handler (mirror of handleSetModelIpc). No YAML
      // persistence — permission mode is runtime-only by design (see Plan 02
      // non-rollback / ephemeral decision).
      return await handleSetPermissionModeIpc({ manager, params });
    }

    case "send-attachment": {
      const agentName = validateStringParam(params, "agent");
      const filePath = validateStringParam(params, "file_path");
      const message = typeof params.message === "string" ? params.message : undefined;

      // Verify file exists
      try {
        await access(filePath);
      } catch {
        throw new ManagerError(`File not found: ${filePath}`);
      }

      // Verify file size (Discord limit: 25MB for standard, 8MB without boost)
      const fileStat = await stat(filePath);
      if (fileStat.size > 25 * 1024 * 1024) {
        throw new ManagerError(`File too large (${fileStat.size} bytes). Discord limit is 25MB.`);
      }

      // Find the agent's channel(s)
      const agentConfig = configs.find((c) => c.name === agentName);
      if (!agentConfig) {
        throw new ManagerError(`Agent '${agentName}' not found in config`);
      }
      const channels = agentConfig.channels;
      if (channels.length === 0) {
        throw new ManagerError(`Agent '${agentName}' has no Discord channels configured`);
      }

      // Send via Discord client
      const bridge = discordBridgeRef.current;
      if (!bridge) {
        throw new ManagerError("Discord bridge not available");
      }

      const client = bridge.discordClient;
      const targetChannelId = typeof params.channel_id === "string" ? params.channel_id : channels[0];
      const channel = await client.channels.fetch(targetChannelId);
      if (!channel || !("send" in channel) || typeof channel.send !== "function") {
        throw new ManagerError(`Cannot send to channel ${targetChannelId}`);
      }

      await (channel as { send: (opts: { content?: string; files: string[] }) => Promise<unknown> }).send({
        ...(message ? { content: message } : {}),
        files: [filePath],
      });

      return { ok: true, agent: agentName, channel: targetChannelId, file: filePath };
    }

    // ----------------------------------------------------------------
    // Phase 94 Plan 05 TOOL-08 / D-08 — fetch-discord-messages (Gap 3
    // closure). Built-in helper auto-injected through the clawcode MCP
    // server (src/mcp/server.ts). Wires production deps (discord.js
    // client.channels.fetch + messages.fetch) onto the DI-pure handler
    // (src/manager/tools/clawcode-fetch-discord-messages.ts).
    // ----------------------------------------------------------------
    case "fetch-discord-messages": {
      const channelId = validateStringParam(params, "channel_id");
      const limit = typeof params.limit === "number"
        ? Math.max(1, Math.min(100, Math.floor(params.limit)))
        : 50;
      const before = typeof params.before === "string" ? params.before : undefined;

      const bridge = discordBridgeRef.current;
      if (!bridge) {
        throw new ManagerError("Discord bridge not available");
      }
      const { clawcodeFetchDiscordMessages } = await import(
        "./tools/clawcode-fetch-discord-messages.js"
      );
      const pinoMod = (await import("pino")).default;
      const log = pinoMod({ level: "silent" });

      const result = await clawcodeFetchDiscordMessages(
        {
          channel_id: channelId,
          limit,
          ...(before !== undefined ? { before } : {}),
        },
        {
          fetchMessages: async (cid, opts) => {
            const ch = await bridge.discordClient.channels.fetch(cid);
            if (!ch || typeof (ch as { messages?: unknown }).messages !== "object") {
              throw new Error(`Channel '${cid}' is not a text channel/thread`);
            }
            const fetchOpts: { limit?: number; before?: string } = {};
            if (opts.limit !== undefined) fetchOpts.limit = opts.limit;
            if (opts.before !== undefined) fetchOpts.before = opts.before;
            const collection = await (
              ch as {
                messages: {
                  fetch: (
                    o: { limit?: number; before?: string },
                  ) => Promise<Map<string, unknown>>;
                };
              }
            ).messages.fetch(fetchOpts);
            type DiscordMsg = {
              id: string;
              author: { username: string };
              content: string;
              createdAt: Date;
              attachments: Map<string, { name?: string | null; url: string }>;
            };
            return [...(collection as Map<string, DiscordMsg>).values()].map((m) => ({
              id: m.id,
              author: m.author.username,
              content: m.content ?? "",
              ts: m.createdAt.toISOString(),
              attachments: [...m.attachments.values()].map((a) => ({
                filename: a.name ?? "attachment",
                url: a.url,
              })),
            }));
          },
          log,
        },
      );

      // The DI-pure handler returns either FetchDiscordMessagesOutput or
      // ToolCallError. Surface ToolCallError as a ManagerError so the
      // MCP wrapper in src/mcp/server.ts renders it as isError:true.
      if ("kind" in result && result.kind === "ToolCallError") {
        throw new ManagerError(result.message);
      }
      return result;
    }

    // ----------------------------------------------------------------
    // Phase 94 Plan 05 TOOL-09 / D-09 — share-file (Gap 3 closure).
    // Built-in helper auto-injected through the clawcode MCP server.
    // Wires production deps (fs.promises.stat + discord.js channel.send
    // bot-direct upload) onto the DI-pure handler. The webhook→bot-direct
    // fallback specified in 94-05 is reduced here to bot-direct only;
    // webhook-manager.sendFile is deferred until a future phase adds a
    // file-upload primitive to WebhookManager (acknowledged in 94-05
    // SUMMARY "Next Phase Readiness").
    // ----------------------------------------------------------------
    // Phase 999.128 — named workflow templates available to an agent
    // (fleet `defaults.workflow.templates` merged with per-agent entries).
    case "list-workflow-templates": {
      const agentName = validateStringParam(params, "agent");
      enforceAgentIdentity(params, agentName);
      const { describeTemplates } = await import("./workflow-templates.js");
      const templates =
        manager.getAgentConfig(agentName)?.workflowTemplates ??
        configs.find((c) => c.name === agentName)?.workflowTemplates ??
        [];
      return { agent: agentName, templates: describeTemplates(templates) };
    }

    // Phase 999.132 — per-client fact vault. Lives in the agent's OWN
    // workspace (`clients/<slug>/facts.json`), so another agent can never
    // read or write it; the vault module validates slugs and keys.
    case "client-fact-set": {
      const agentName = validateStringParam(params, "agent");
      enforceAgentIdentity(params, agentName);
      const cfg = configs.find((c) => c.name === agentName);
      if (!cfg?.workspace) throw new ManagerError(`Agent '${agentName}' has no workspace`);
      const client = validateStringParam(params, "client");
      const vaultMod = await import("./client-vault.js");
      if (params.remove === true) {
        const key = validateStringParam(params, "key");
        const current = await vaultMod.readVault(cfg.workspace, client);
        const { vault, removed } = vaultMod.removeFact(current, key, agentName);
        if (!removed) return { client, key, removed: false, path: vaultMod.vaultPath(cfg.workspace, client) };
        const path = await vaultMod.writeVault(cfg.workspace, vault);
        logger.info({ agent: agentName, client, key }, "client fact removed");
        return { client, key, removed: true, previous: removed, path };
      }
      const input = {
        key: validateStringParam(params, "key"),
        value: validateStringParam(params, "value"),
        source: validateStringParam(params, "source"),
        asOf: validateStringParam(params, "as_of"),
        ...(typeof params.note === "string" ? { note: params.note } : {}),
        setBy: agentName,
      };
      try {
        const current = await vaultMod.readVault(cfg.workspace, client);
        const { vault, previous } = vaultMod.setFact(current, input);
        const path = await vaultMod.writeVault(cfg.workspace, vault);
        logger.info({ agent: agentName, client, key: input.key, replaced: previous !== null }, "client fact set");
        return { client, key: input.key, fact: vault.facts[input.key], previous, path };
      } catch (err) {
        throw new ManagerError(err instanceof Error ? err.message : String(err));
      }
    }

    case "client-facts": {
      const agentName = validateStringParam(params, "agent");
      enforceAgentIdentity(params, agentName);
      const cfg = configs.find((c) => c.name === agentName);
      if (!cfg?.workspace) throw new ManagerError(`Agent '${agentName}' has no workspace`);
      const vaultMod = await import("./client-vault.js");
      if (typeof params.client !== "string" || params.client.length === 0) {
        return { clients: await vaultMod.listClients(cfg.workspace) };
      }
      try {
        const vault = await vaultMod.readVault(cfg.workspace, params.client);
        return {
          client: vault.client,
          facts: vault.facts,
          history: params.history === true ? vault.history : undefined,
          updatedAt: vault.updatedAt,
          text: vaultMod.renderVault(vault),
          sources: vaultMod.factsAsSources(vault),
        };
      } catch (err) {
        throw new ManagerError(err instanceof Error ? err.message : String(err));
      }
    }

    case "share-file": {
      const agentName = validateStringParam(params, "agent");
      const filePath = validateStringParam(params, "path");
      const caption = typeof params.caption === "string" ? params.caption : undefined;
      const channelIdParam =
        typeof params.channel_id === "string" ? params.channel_id : undefined;

      // Phase 999.36 sub-bug C (D-09, D-10) [Rule 3 - blocking deviation
      // from plan's action block] — read the thread registry FIRST and
      // resolve the subagent binding by sessionName. The agent-config
      // lookup below uses the PARENT agent's name when `agentName` is
      // actually a subagent sessionName (subagents are spawned dynamically
      // and their sessionNames are NOT in the static `configs[]` list, so
      // the pre-fix lookup threw "Agent not found" for any subagent that
      // followed Task 4's prompt instruction to pass its own sessionName).
      // Subagents legitimately inherit the parent's workspace, memoryPath,
      // and fileAccess for security gating (allowedRoots) — only the
      // channel routing differs (binding.threadId vs parent.channels[0]).
      const threadRegistryForShare = await readThreadRegistry(
        THREAD_REGISTRY_PATH,
      );
      const subagentBinding = getBindingForSession(
        threadRegistryForShare,
        agentName,
      );
      const lookupName = subagentBinding
        ? subagentBinding.agentName
        : agentName;
      const agentConfig = configs.find((c) => c.name === lookupName);
      if (!agentConfig) {
        throw new ManagerError(`Agent '${lookupName}' not found in config`);
      }

      const bridge = discordBridgeRef.current;
      if (!bridge) {
        throw new ManagerError("Discord bridge not available");
      }

      // Resolve allowedRoots to the agent's workspace + memoryPath + Phase 96
      // D-05/D-06 fileAccess paths (operator-shared via ACL). Without
      // fileAccess inclusion, share-file refused operator-shared paths even
      // though the Phase 96 capability probe + clawcode_list_files honored
      // them — surfaced as deploy bug 2026-04-25 when fin-client tried
      // to share /home/example-user/.openclaw/workspace-acme/research/*.pdf
      // and got "outside the agent workspace; refused" despite the path
      // being in the resolved fileAccess set.
      const allowedRoots: string[] = [];
      if (agentConfig.workspace) allowedRoots.push(agentConfig.workspace);
      if (agentConfig.memoryPath) allowedRoots.push(agentConfig.memoryPath);
      // Phase 96.1 hotfix — extend allowedRoots with resolved fileAccess.
      // resolveFileAccess merges defaults.fileAccess + agent.fileAccess and
      // expands the {agent} token. Defaults are always populated by zod
      // default ([/home/clawcode/.clawcode/agents/{agent}/]).
      const { resolveFileAccess: resolveFileAccessForShare } = await import(
        "../config/loader.js"
      );
      // routeMethod doesn't receive the top-level `config` object — only
      // the resolved per-agent `configs[]`. Pass undefined for defaults;
      // resolveFileAccess will skip the defaults merge. The defaults
      // template `{agent}` expands to the agent's workspace dir which is
      // already in allowedRoots from line 4172 (agentConfig.workspace),
      // so no functional loss. Per-agent fileAccess override (which IS
      // populated for cross-workspace cases like fin-client reading
      // /home/example-user/.openclaw/workspace-acme/) still applies.
      // Bug fix 2026-04-25 evening: original Phase 96.1 hotfix referenced
      // `config.defaults` but `config` is not in routeMethod scope —
      // ReferenceError at runtime broke clawcode_share_file entirely.
      const fileAccessPaths = resolveFileAccessForShare(
        agentName,
        agentConfig as unknown as { readonly fileAccess?: readonly string[] },
        undefined,
      );
      for (const p of fileAccessPaths) {
        if (!allowedRoots.includes(p)) allowedRoots.push(p);
      }
      if (allowedRoots.length === 0) {
        throw new ManagerError(
          `Agent '${agentName}' has no workspace, memoryPath, or fileAccess configured`,
        );
      }

      // Phase 999.36 sub-bug C (D-09, D-10) — route through a pure helper
      // that consults the thread binding registry FIRST. For subagent
      // invocations (where `agentName` is actually the sessionName like
      // `fin-client-sub-OV9rkf`), the helper resolves to the bound
      // thread, NOT to the parent agent's primary channel. For regular
      // agent invocations, the helper falls through to the existing
      // `agentConfig.channels[0]` behavior — backwards compatible.
      // (threadRegistryForShare is read above for the agentConfig lookup.)
      const channelId = resolveShareFileChannel(
        agentName,
        channelIdParam,
        threadRegistryForShare,
        agentConfig,
      );
      if (!channelId) {
        throw new ManagerError(
          `Agent '${agentName}' has no Discord channels configured, no thread binding, and no channel_id provided`,
        );
      }

      const { clawcodeShareFile } = await import("./tools/clawcode-share-file.js");
      const pinoMod = (await import("pino")).default;
      const log = pinoMod({ level: "silent" });

      // Bot-direct upload primitive — captures the message's first
      // attachment URL after Discord uploads the file. Used both as the
      // primary path and the fallback (single-channel UX consistency
      // pending webhook-manager.sendFile in a future phase).
      //
      // 2026-05-23 — caption MUST be wrapped through formatOutboundText
      // before posting (em-dash strip + markdown-table fence). The
      // commit 88f600b7 universal-wrap audit missed this inline closure
      // because it lives inside an IPC handler rather than at a named
      // bridge chokepoint. Every `clawcode_share_file` call with a
      // caption was leaking em dashes until this fix. The
      // `em-dash-strip-coverage` sentinel suite pins this site to
      // catch a future regression.
      const botUpload = async (
        cid: string,
        file: { path: string; filename: string; caption?: string },
      ): Promise<{ url: string; messageId?: string; channelId?: string }> => {
        const channel = await bridge.discordClient.channels.fetch(cid);
        if (!channel || !("send" in channel) || typeof channel.send !== "function") {
          throw new Error(`Cannot send to channel ${cid}`);
        }
        const sendOpts: { content?: string; files: string[] } = {
          files: [file.path],
        };
        if (file.caption !== undefined) {
          sendOpts.content = formatOutboundText(file.caption);
        }
        const message = (await (
          channel as {
            send: (
              opts: { content?: string; files: string[] },
            ) => Promise<{ id: string; attachments: Map<string, { url: string }> }>;
          }
        ).send(sendOpts)) as { id: string; attachments: Map<string, { url: string }> };
        const attachment = [...message.attachments.values()][0];
        if (!attachment) {
          throw new Error("Discord upload returned no attachment URL");
        }
        // UX-A (2026-08-26) — the message id used to be discarded here,
        // which made superseded-share marking impossible. Additive return.
        return { url: attachment.url, messageId: message.id, channelId: cid };
      };

      const result = await clawcodeShareFile(
        {
          path: filePath,
          ...(caption !== undefined ? { caption } : {}),
        },
        {
          allowedRoots,
          // Webhook path deferred — both DI surfaces forward to bot-direct.
          // The 94-05 handler tries webhook first, then bot. Until
          // webhook-manager.sendFile lands, both calls resolve to the
          // same primitive (idempotent — Discord deduplication is
          // not a concern because webhook will never reject when both
          // paths are identical).
          sendViaWebhook: botUpload,
          sendViaBot: botUpload,
          currentChannelId: () => channelId,
          stat: async (p: string) => {
            await access(p);
            const s = await stat(p);
            return { size: s.size, isFile: s.isFile() };
          },
          log,
        },
      );

      if ("kind" in result && result.kind === "ToolCallError") {
        throw new ManagerError(result.message);
      }

      // UX-A (2026-08-26) — superseded-document marking. When THIS share
      // displaces a fresh previous share of the same (agent, filename),
      // the old share message gets the superseded banner so a stale
      // document version can't be grabbed from scrollback as current.
      // Fail-open; the share result is returned untouched either way.
      if (
        !("kind" in result) &&
        typeof result.messageId === "string" &&
        typeof result.channelId === "string" &&
        markSupersededShareRef
      ) {
        await markSupersededShareRef({
          bridge,
          agentName,
          filename: result.filename,
          messageId: result.messageId,
          channelId: result.channelId,
          caption,
          formatCaption: formatOutboundText,
        });
      }
      return result;
    }

    case "slash-commands": {
      const commands = configs.map((a) => ({
        agent: a.name,
        commands: resolveAgentCommands(a.slashCommands).map((c) => ({
          name: c.name,
          description: c.description,
          claudeCommand: c.claudeCommand,
        })),
      }));
      return { agents: commands };
    }

    case "threads": {
      const bindings = await threadManager.getActiveBindings();
      const agentFilter = typeof params.agent === "string" ? params.agent : undefined;
      const filtered = agentFilter
        ? bindings.filter(b => b.agentName === agentFilter)
        : bindings;
      return { bindings: filtered };
    }

    case "fork-session": {
      const name = validateStringParam(params, "name");
      const systemPrompt = typeof params.systemPrompt === "string" ? params.systemPrompt : undefined;
      const model = typeof params.model === "string" ? params.model as "sonnet" | "opus" | "haiku" : undefined;
      const result = await manager.forkSession(name, { systemPromptOverride: systemPrompt, modelOverride: model });
      return { ok: true, forkName: result.forkName, parentAgent: result.parentAgent, sessionId: result.sessionId };
    }

    case "webhooks": {
      // 2026-09-03 — report the LIVE manager, not raw YAML.
      //
      // This used to enumerate `configs` and include an agent only if it
      // declared `webhook.displayName`. No production agent does, so it
      // returned an empty list for the entire fleet — and kept doing so after
      // the daemon began auto-provisioning nine identities at boot. An agent
      // calling `list_webhooks` was told "no webhook exists to use" while
      // nine existed, which is worse than no tool at all: it reports a
      // capability as absent and sends the agent down a different path.
      //
      // `a2aOnly` is surfaced so the answer is not just "there is one" but
      // "there is one, and it is for agent-to-agent messages" — the
      // distinction that actually governs what the agent may do with it.
      const identities = webhookManager.listIdentities();
      const webhooks = identities.map((id) => ({
        agent: id.agent,
        displayName: id.displayName,
        avatarUrl: id.avatarUrl,
        hasWebhookUrl: true,
        a2aOnly: id.a2aOnly,
        source: configs.find((c) => c.name === id.agent)?.webhook?.displayName
          ? ("config" as const)
          : ("auto-provisioned" as const),
      }));
      return { webhooks };
    }

    case "consolidate-now": {
      // Phase 999.113 WS-7 — preview or run consolidation for ONE agent, using
      // exactly the deps the cron handler builds (same store, embedder,
      // summarizer, memoryDir), so what the operator stages is what the cron
      // will do. Default is a pure read: `detectUnconsolidatedWeeks` touches
      // no files. Archiving only ever happens under `run: true`.
      const agentName = validateStringParam(params, "agent");
      enforceAgentIdentity(params, agentName);
      const run = params.run === true;

      // `configs` carries the loader-resolved per-agent config, whose
      // `memory.consolidation` is non-optional (defaults already cascaded by
      // the schema), so this needs no second defaults lookup.
      const agentCfg = configs.find((a) => a.name === agentName);
      if (!agentCfg) {
        throw new ManagerError(`Unknown agent '${agentName}'`);
      }
      const consolidationConfig = {
        enabled: agentCfg.memory.consolidation.enabled,
        weeklyThreshold: agentCfg.memory.consolidation.weeklyThreshold,
        monthlyThreshold: agentCfg.memory.consolidation.monthlyThreshold,
        schedule: agentCfg.memory.consolidation.schedule,
      };
      const memoryDir = join(agentCfg.memoryPath, "memory");

      const weeks = detectUnconsolidatedWeeks(memoryDir, consolidationConfig.weeklyThreshold);
      const plan = weeks.map((w) => ({
        week: `${w.year}-W${String(w.week).padStart(2, "0")}`,
        period: `${w.startDate} to ${w.endDate}`,
        files: w.files.length,
      }));

      if (!run) {
        return {
          agent: agentName,
          memoryDir,
          enabled: consolidationConfig.enabled,
          weeklyThreshold: consolidationConfig.weeklyThreshold,
          ran: false,
          weeksPending: plan,
        };
      }

      const store = manager.getMemoryStore(agentName);
      if (!store) {
        throw new ManagerError(
          `Memory store not found for agent '${agentName}' (agent may not be running)`,
        );
      }
      const result = await runConsolidation(
        {
          memoryDir,
          memoryStore: store,
          embedder: manager.getEmbedder(),
          summarize: (prompt: string) => summarizeWithHaiku(prompt, {}),
          runLabel: agentName,
        },
        consolidationConfig,
      );
      logger.info(
        { agent: agentName, trigger: "operator", ...result, errors: result.errors.length },
        "consolidation run complete (manual)",
      );
      return {
        agent: agentName,
        memoryDir,
        enabled: consolidationConfig.enabled,
        weeklyThreshold: consolidationConfig.weeklyThreshold,
        ran: true,
        weeksPending: plan,
        weeklyDigestsCreated: result.weeklyDigestsCreated,
        monthlyDigestsCreated: result.monthlyDigestsCreated,
        filesArchived: result.filesArchived,
        errors: result.errors,
      };
    }

    case "memory-search": {
      const agentName = validateStringParam(params, "agent");
      enforceAgentIdentity(params, agentName); // C3 — gate cross-agent access
      const query = validateStringParam(params, "query");
      const topK = typeof params.topK === "number" ? params.topK : 10;

      const store = manager.getMemoryStore(agentName);
      if (!store) {
        throw new ManagerError(`Memory store not found for agent '${agentName}' (agent may not be running)`);
      }

      const embedder = manager.getEmbedder();
      // Phase 999.119 v2 switch — embed for the agent's read version.
      const queryEmbedding = await store.embedQuery(embedder, query);
      const search = new SemanticSearch(store.getDatabase());
      const results = search.search(queryEmbedding, topK);

      return {
        results: results.map((r) => ({
          id: r.id,
          content: r.content,
          source: r.source,
          importance: r.importance,
          accessCount: r.accessCount,
          tier: r.tier,
          createdAt: r.createdAt,
          score: r.combinedScore,
          distance: r.distance,
        })),
      };
    }

    case "memory-lookup": {
      // Phase 68-02 — scope-aware conversation search with pagination.
      // Delegates to `invokeMemoryLookup` (memory-lookup-handler.ts) so the
      // same handler body runs in production and integration tests without
      // duplication. Branching: scope='memories' && page=0 → legacy
      // GraphSearch (pre-v1.9 byte-compat); otherwise → searchByScope with
      // paginated envelope (hasMore/nextOffset/origin/session_id).
      const agentName = validateStringParam(params, "agent");
      enforceAgentIdentity(params, agentName); // C3 — gate cross-agent access
      // Phase 999.125 — `query` may be empty when a time window is given
      // (chronological browse); the handler enforces the either/or rule.
      const query = typeof params.query === "string" ? params.query : "";
      const since = typeof params.since === "string" ? params.since : undefined;
      const until = typeof params.until === "string" ? params.until : undefined;
      const store = manager.getMemoryStore(agentName);
      if (!store) {
        throw new ManagerError(
          `Memory store not found for agent '${agentName}' (agent may not be running)`,
        );
      }

      // Coerce raw IPC params to the handler's typed shape. All the
      // defense-in-depth clamping (limit, page) happens inside the handler.
      const scope =
        params.scope === "conversations" || params.scope === "all"
          ? params.scope
          : "memories";
      const page = typeof params.page === "number" ? params.page : 0;
      const limit = typeof params.limit === "number" ? params.limit : 5;

      // Phase 68 — RETR-03 gap closure. Resolve the per-agent
      // retrieval half-life from the conversation config block. Zod has
      // already enforced min(1) at config-load time, so no clamping
      // here. Leave undefined when the conversation block is absent so
      // the handler/searchByScope fallback to DEFAULT_RETRIEVAL_HALF_LIFE_DAYS
      // remains the single source of truth.
      const agentConfig = manager.getAgentConfig(agentName);
      const retrievalHalfLifeDays =
        agentConfig?.memory.conversation?.retrievalHalfLifeDays;

      return invokeMemoryLookup(
        {
          agent: agentName,
          query,
          limit,
          scope,
          page,
          retrievalHalfLifeDays,
          ...(since !== undefined ? { since } : {}),
          ...(until !== undefined ? { until } : {}),
        },
        {
          memoryStore: store,
          conversationStore: manager.getConversationStore(agentName),
          embedder: manager.getEmbedder(),
        },
      );
    }

    case "usage": {
      const agentName = validateStringParam(params, "agent");
      const period = typeof params.period === "string" ? params.period : "session";
      const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
      const date = typeof params.date === "string" ? params.date : undefined;
      // Quick 260611-h50 — optional explicit half-open [startIso, endIso) UTC
      // range. When BOTH are present the caller is asking for an arbitrary
      // window (e.g. /clawcode-usage Pacific buckets); otherwise the existing
      // period switch below is used UNCHANGED so the CLI keeps its UTC
      // calendar-day / Monday-week semantics. Backwards-compatible.
      const startIso = typeof params.startIso === "string" ? params.startIso : undefined;
      const endIso = typeof params.endIso === "string" ? params.endIso : undefined;

      const usageTracker = manager.getUsageTracker(agentName);
      if (!usageTracker) {
        throw new ManagerError(`Usage tracker not found for agent '${agentName}' (agent may not be running)`);
      }

      // Range path takes precedence when both ISO bounds are supplied. The
      // echoed `period` carries the caller's hint (or "range") so the embed
      // labelling stays caller-driven.
      if (startIso !== undefined && endIso !== undefined) {
        const aggregate = usageTracker.getUsageInRange(startIso, endIso);
        return { agent: agentName, period: period ?? "range", ...aggregate };
      }

      let aggregate;
      switch (period) {
        case "session": {
          const sid = sessionId ?? "";
          aggregate = usageTracker.getSessionUsage(sid);
          break;
        }
        case "daily": {
          const day = date ?? new Date().toISOString().slice(0, 10);
          aggregate = usageTracker.getDailyUsage(day);
          break;
        }
        case "weekly": {
          const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 });
          const weekStartStr = weekStart.toISOString().slice(0, 10);
          aggregate = usageTracker.getWeeklyUsage(weekStartStr);
          break;
        }
        case "total": {
          aggregate = usageTracker.getTotalUsage(agentName);
          break;
        }
        default:
          throw new ManagerError(`Invalid usage period: ${period}`);
      }

      return { agent: agentName, period, ...aggregate };
    }

    case "agent-activity": {
      // Phase 116-postdeploy 2026-05-12 — F03 tile 24h sparkline IPC.
      // Mirrors the shape of `case "latency":` below. Returns per-hour
      // turn counts for a single agent over a sliding window.
      //
      // Params:
      //   agent       (string, required)
      //   windowHours (number, optional, default 24, clamped to 1..168)
      const agentName = validateStringParam(params, "agent");
      const rawWindow = (params as { windowHours?: unknown }).windowHours;
      const windowHours =
        typeof rawWindow === "number" && Number.isFinite(rawWindow)
          ? Math.max(1, Math.min(Math.floor(rawWindow), 168))
          : 24;
      // sinceToIso accepts "24h", "1h" etc — feed it the clamped value
      // as a duration string so we stay on the same window-parser the
      // rest of the trace-store IPC surface uses.
      let sinceIso: string;
      try {
        sinceIso = sinceToIso(`${windowHours}h`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "invalid since duration";
        throw new ManagerError(`Invalid windowHours: ${msg}`);
      }
      const store = manager.getTraceStore(agentName);
      // Stopped agents (no TraceStore singleton) return an empty
      // buckets array, NOT an error — the tile renders the "no turns
      // 24h" empty state in that case.
      const buckets = store
        ? store
            .getActivityByHour(agentName, sinceIso)
            .map((r) => ({ bucket: r.bucket, turn_count: r.turn_count }))
        : [];
      return {
        agent: agentName,
        windowHours,
        since: sinceIso,
        buckets,
      };
    }

    case "fleet-activity-summary": {
      // Phase 116-postdeploy 2026-05-12 — main-dashboard tile sort.
      // Operator: "the main dashboard page should show agents ordered by
      // whats used the most". Returns one row per non-ephemeral agent
      // with turn counts over rolling 24h / 7d windows plus the last-turn
      // timestamp. The SPA sorts the tile grid by `turns_24h DESC` with
      // alphabetical tiebreak.
      //
      // Subagents (-sub-) and ephemeral threads (-thread-) are filtered
      // out — matches the canonical `agentNames` filter at line ~3326 so
      // the main-dashboard tile grid doesn't sort against transient
      // execution units that an operator never sees as tiles anyway.
      //
      // Stopped agents (no TraceStore singleton) surface with zero
      // counts; they still appear in the response so the client can
      // render their tiles in the dormant footer without missing data.
      const nowMs = Date.now();
      const since24hIso = new Date(nowMs - 24 * 3_600_000).toISOString();
      const since7dIso = new Date(nowMs - 7 * 24 * 3_600_000).toISOString();
      // `configs` is the in-scope ResolvedAgentConfig[] for the IPC
      // handler (see daemon.ts:1122). Filter matches the canonical
      // `agentNames` projection used elsewhere in this module so the
      // main-dashboard tile grid doesn't sort against ephemeral
      // subagents/threads.
      const tileAgents = configs.filter(
        // Phase 999.19 — central predicate also excludes -via- delegated sessions.
        (a) => !isSubagentOrThreadSession(a.name),
      );
      const summary = tileAgents.map((cfg) => {
        const store = manager.getTraceStore(cfg.name);
        if (!store) {
          return {
            agent: cfg.name,
            turns_24h: 0,
            turns_7d: 0,
            last_turn_at: null as string | null,
          };
        }
        const r24 = store.getTurnSummarySince(cfg.name, since24hIso);
        const r7d = store.getTurnSummarySince(cfg.name, since7dIso);
        return {
          agent: cfg.name,
          turns_24h: r24.n,
          turns_7d: r7d.n,
          // 7d MAX is always >= 24h MAX, so use it as the most-recent
          // signal. Falls back to null when the agent has zero turns in
          // the last week (operator-stopped fleet, fresh install, etc.).
          last_turn_at: r7d.last_at,
        };
      });
      return {
        since_24h: since24hIso,
        since_7d: since7dIso,
        agents: summary,
      };
    }

    case "list-planning-tasks": {
      // Phase 116-postdeploy 2026-05-12 — Tasks Kanban planning-artefact
      // ingest. Scans the repo's `.planning/` tree at request time;
      // missing dir (production install at /opt/clawcode) returns the
      // empty response — never errors so the SPA's Tasks page degrades
      // gracefully. Heavy I/O is bounded (one readdir + per-file stat;
      // bodies parsed for frontmatter + first-paragraph excerpt only).
      const { listPlanningTasks } = await import("./planning-tasks.js");
      return await listPlanningTasks();
    }

    case "restart-daemon": {
      // Phase 116-postdeploy 2026-05-12 — Basic-mode "Restart daemon"
      // quick action. Sends SIGHUP to ourselves; the SIGHUP handler at
      // daemon.ts:~7563 runs graceful shutdown and exits with code 129,
      // which systemd's RestartForceExitStatus=129 turns into a clean
      // restart. Phase 999.6 pre-deploy snapshot preserves running agents.
      //
      // setImmediate ordering: schedule the signal on the NEXT tick so
      // the IPC response + socket flush land BEFORE shutdown begins.
      // Without this, the dashboard sees a network error instead of the
      // "daemon restarting…" toast we want to surface.
      //
      // Original design was `restart-discord-bot` (stop→start on the
      // bridge singleton). Withdrawn before deploy because
      // DiscordBridge.stop() calls client.destroy() and every consumer
      // that captured `bridge.discordClient` at boot (WebhookManager,
      // SubagentThreadSpawner, restart-greeting BotDirectSender) holds
      // a reference to the destroyed Client — bridge-restart alone
      // can't repair those closures. Daemon restart sidesteps the
      // entire problem by rebuilding everything from scratch.
      setImmediate(() => {
        try {
          process.kill(process.pid, "SIGHUP");
        } catch (err) {
          // Logging only — by the time we get here the IPC response is
          // already on the wire. If signal delivery fails (unusual on a
          // unix host), systemd's idle-watchdog will eventually notice.
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(
            { component: "daemon", error: msg },
            "restart-daemon: SIGHUP self-signal failed",
          );
        }
      });
      return {
        ok: true,
        message:
          "SIGHUP scheduled — daemon will restart via systemd (RestartForceExitStatus=129). Reconnect in ~3-5s.",
      };
    }

    case "latency": {
      const since = typeof params.since === "string" && params.since.length > 0 ? params.since : "24h";
      let sinceIso: string;
      try {
        sinceIso = sinceToIso(since);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "invalid since duration";
        throw new ManagerError(`Invalid since duration: ${msg}`);
      }

      const isAll = params.all === true;
      if (isAll) {
        const agents = manager.getRunningAgents();
        const reports: LatencyReport[] = [];
        for (const agentName of agents) {
          const store = manager.getTraceStore(agentName);
          if (!store) continue; // skip agents without a store (race at startup)
          const rawSegments = store.getPercentiles(agentName, sinceIso);
          const agentConfig = configs.find((c) => c.name === agentName);
          const segments = augmentWithSloStatus(rawSegments, agentConfig?.perf?.slos);
          // Phase 54 Plan 04: server-emit first_token_headline so the CLI +
          // dashboard render color/subtitle from the response (no client
          // mirror). Cold-start guard in evaluateFirstTokenHeadline keeps
          // newly-started agents gray until 5 samples exist.
          const firstTokenRow = store.getFirstTokenPercentiles(agentName, sinceIso);
          const first_token_headline = evaluateFirstTokenHeadline(
            firstTokenRow,
            agentConfig?.perf?.slos,
          );
          reports.push(
            Object.freeze({
              agent: agentName,
              since: sinceIso,
              segments,
              first_token_headline,
            }),
          );
        }
        return reports;
      }

      const agentName = validateStringParam(params, "agent");
      const store = manager.getTraceStore(agentName);
      if (!store) {
        // M4 — a non-running agent's store is torn down on idle/stop. A poller
        // hitting it is benign (expected), not a fault: return an empty report
        // + log at debug instead of throwing a level:50 "handler error".
        if (classifyMissingTraceStore(manager, agentName).kind === "absent") {
          logTraceStoreAbsent(logger, agentName, "latency");
          return emptyLatencyReport(agentName, sinceIso);
        }
        throw new ManagerError(
          `Trace store not found for agent '${agentName}' (agent may not be running)`,
        );
      }
      const rawSegments = store.getPercentiles(agentName, sinceIso);
      const agentConfig = configs.find((c) => c.name === agentName);
      const segments = augmentWithSloStatus(rawSegments, agentConfig?.perf?.slos);
      // Phase 54 Plan 04: server-emit first_token_headline (same pattern as
      // --all branch above — single source of truth for SLO evaluation stays
      // here, dashboard + CLI are dumb renderers).
      const firstTokenRow = store.getFirstTokenPercentiles(agentName, sinceIso);
      const first_token_headline = evaluateFirstTokenHeadline(
        firstTokenRow,
        agentConfig?.perf?.slos,
      );
      return Object.freeze({
        agent: agentName,
        since: sinceIso,
        segments,
        first_token_headline,
      }) satisfies LatencyReport;
    }

    case "cache": {
      // Phase 52 Plan 03: CACHE_HIT_RATE_SLO-augmented cache telemetry report
      // with optional `cache_effect_ms` first-token delta. Mirrors the shape
      // of `case "latency"` above so the CLI + dashboard formatters stay
      // symmetric with `clawcode latency`.
      const since =
        typeof params.since === "string" && params.since.length > 0
          ? params.since
          : "24h";
      let sinceIso: string;
      try {
        sinceIso = sinceToIso(since);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "invalid since duration";
        throw new ManagerError(`Invalid since duration: ${msg}`);
      }

      /**
       * Build a single-agent augmented CacheTelemetryReport. Shared helper
       * for both the single-agent and `--all` branches below.
       *
       * Throws `ManagerError` when the trace store is missing (agent not
       * running) — the `--all` branch catches + filters these so a single
       * missing store doesn't kill the fleet response.
       */
      const buildReport = (
        agentName: string,
      ): CacheTelemetryReport & {
        readonly status: CacheHitRateStatus;
        readonly cache_effect_ms: number | null;
        readonly tool_cache_hit_rate: number | null;
        readonly tool_cache_size_mb: number | null;
        readonly tool_cache_turns: number;
      } => {
        const store = manager.getTraceStore(agentName);
        if (!store) {
          throw new ManagerError(
            `Trace store not found for agent '${agentName}' (agent may not be running)`,
          );
        }
        const report = store.getCacheTelemetry(agentName, sinceIso);
        const status = evaluateCacheHitRateStatus(
          report.avgHitRate,
          report.totalTurns,
        );
        const effect = computeCacheEffectMs(store, agentName, sinceIso);
        // Advisory WARN: if we have ≥ 20 eligible turns AND the delta is
        // non-negative, the cache is NOT delivering first-token benefit.
        // Per CONTEXT D-05 this is an operator-facing signal, not a hard
        // failure — the metric still surfaces in the response.
        if (effect !== null && effect >= 0 && report.totalTurns >= 20) {
          logger.warn(
            {
              agent: agentName,
              cacheEffectMs: effect,
              totalTurns: report.totalTurns,
            },
            "cache delivering no first-token benefit (expected delta < 0)",
          );
        }
        // Phase 115 Plan 07 T04 — aggregate tool-cache telemetry over the
        // same window. Surfaced next to prompt_cache_hit_rate on the
        // dashboard (sub-scope 16(c) per roadmap line 875).
        // tool_cache_hit_rate is the per-turn average from traces.db;
        // tool_cache_size_mb is fleet-wide and may be NULL on per-turn
        // rollups — the live value is folded into the response by the
        // closure intercept of `cache` IPC (see tool_cache_size_mb_live).
        const toolCache = store.getToolCacheTelemetry(agentName, sinceIso);
        return Object.freeze({
          ...report,
          status,
          cache_effect_ms: effect,
          tool_cache_hit_rate: toolCache.avgToolCacheHitRate,
          tool_cache_size_mb: toolCache.avgToolCacheSizeMb,
          tool_cache_turns: toolCache.turnsWithCacheEvents,
        });
      };

      const isAll = params.all === true;
      if (isAll) {
        const agents = manager.getRunningAgents();
        const reports = agents
          .map((a) => {
            try {
              return buildReport(a);
            } catch {
              return null;
            }
          })
          .filter(
            (r): r is NonNullable<typeof r> => r !== null,
          );
        return reports;
      }

      const agentName = validateStringParam(params, "agent");
      // M4 — single-agent: a non-running agent has no store. Return an empty
      // report + debug-log instead of letting buildReport throw a level:50
      // "handler error" (the ~20s poller noise source). The --all branch above
      // already catch-filters, so only the single-agent path needs this gate.
      if (
        !manager.getTraceStore(agentName) &&
        classifyMissingTraceStore(manager, agentName).kind === "absent"
      ) {
        logTraceStoreAbsent(logger, agentName, "cache");
        return emptyCacheReport(agentName, sinceIso);
      }
      return buildReport(agentName);
    }

    case "tools": {
      // Phase 55 Plan 03: per-tool round-trip timing surface. Returns one
      // frozen ToolsReport (or ToolsReport[] for --all) with augmented
      // ToolPercentileRow[] carrying slo_status/slo_threshold_ms/slo_metric
      // per tool. Rows sorted by p95 DESC at the SQL layer so CLI + dashboard
      // render slowest-first without a client-side resort. Mirrors the
      // shape of `case "latency"` / `case "cache"` above.
      const since =
        typeof params.since === "string" && params.since.length > 0
          ? params.since
          : "24h";
      let sinceIso: string;
      try {
        sinceIso = sinceToIso(since);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "invalid since duration";
        throw new ManagerError(`Invalid since duration: ${msg}`);
      }

      const buildToolsReport = (
        agentName: string,
      ): {
        readonly agent: string;
        readonly since: string;
        readonly tools: readonly AugmentedToolRow[];
      } => {
        const store = manager.getTraceStore(agentName);
        if (!store) {
          throw new ManagerError(
            `Trace store not found for agent '${agentName}' (agent may not be running)`,
          );
        }
        const rawRows = store.getToolPercentiles(agentName, sinceIso);
        const agentConfig = configs.find((c) => c.name === agentName);
        const tools = augmentToolsWithSlo(rawRows, agentConfig?.perf?.tools);
        return Object.freeze({ agent: agentName, since: sinceIso, tools });
      };

      const isAll = params.all === true;
      if (isAll) {
        const agents = manager.getRunningAgents();
        const reports = agents
          .map((a) => {
            try {
              return buildToolsReport(a);
            } catch {
              return null;
            }
          })
          .filter((r): r is NonNullable<typeof r> => r !== null);
        return reports;
      }

      const agentName = validateStringParam(params, "agent");
      return buildToolsReport(agentName);
    }

    case "bench-run-prompt": {
      // Phase 51: invoked by `clawcode bench` to run a single prompt against a
      // running agent and capture a trace. Not exposed via Discord; CLI /
      // harness only. Caller-owned Turn lifecycle matches the Phase 50
      // contract: SessionManager.dispatchTurn NEVER calls turn.end(); this
      // handler does, in both success and error paths.
      //
      // Phase 54 Plan 03 — response shape extended with rate_limit_errors:
      // number. The bench harness currently runs without a Discord bridge
      // binding (bench-agent has no channels), so rate-limit errors cannot
      // happen on this code path today. The counter exists as a
      // forward-compat hook — when/if a future bench variant exercises the
      // Discord edit pipeline end-to-end, the isDiscordRateLimitError
      // helper (imported from src/discord/streaming.js for reuse) becomes
      // the producer. `bench --check-regression` hard-fails on any total
      // > 0, so the shape MUST be present even at zero to wire the gate.
      const agentName = validateStringParam(params, "agent");
      const prompt = validateStringParam(params, "prompt");
      const turnIdPrefix =
        typeof params.turnIdPrefix === "string" && params.turnIdPrefix.length > 0
          ? params.turnIdPrefix
          : "bench:";

      const collector = manager.getTraceCollector(agentName);
      if (!collector) {
        throw new ManagerError(
          `Trace collector not found for agent '${agentName}' (agent may not be running)`,
        );
      }

      const turnId = `${turnIdPrefix}${nanoid(10)}`;
      const turn = collector.startTurn(turnId, agentName, null);
      let rateLimitErrors = 0;
      try {
        const response = await manager.dispatchTurn(agentName, prompt, turn);
        turn.end("success");
        return { turnId, response, rate_limit_errors: rateLimitErrors };
      } catch (err) {
        turn.end("error");
        // If the underlying send failure IS a rate-limit signal (unlikely
        // on the non-Discord bench path but captured here for symmetry),
        // classify it before throwing so the runner can still tally.
        if (isDiscordRateLimitError(err)) {
          rateLimitErrors += 1;
        }
        const msg = err instanceof Error ? err.message : "unknown bench error";
        throw new ManagerError(`bench-run-prompt failed: ${msg}`);
      }
    }

    case "memory-list": {
      const agentName = validateStringParam(params, "agent");
      enforceAgentIdentity(params, agentName); // C3 — gate cross-agent access
      const limit = typeof params.limit === "number" ? params.limit : 20;

      const store = manager.getMemoryStore(agentName);
      if (!store) {
        throw new ManagerError(`Memory store not found for agent '${agentName}' (agent may not be running)`);
      }

      const entries = store.listRecent(limit);
      return {
        entries: entries.map((e) => ({
          id: e.id,
          content: e.content,
          source: e.source,
          importance: e.importance,
          accessCount: e.accessCount,
          tier: e.tier,
          createdAt: e.createdAt,
          accessedAt: e.accessedAt,
        })),
      };
    }

    case "episode-list": {
      const agentName = validateStringParam(params, "agent");
      const limit = typeof params.limit === "number" ? params.limit : 20;
      const countOnly = params.count === true;

      const episodeStore = manager.getEpisodeStore(agentName);
      if (!episodeStore) {
        throw new ManagerError(`Episode store not found for agent '${agentName}' (agent may not be running)`);
      }

      if (countOnly) {
        return { count: episodeStore.getEpisodeCount() };
      }

      const episodes = episodeStore.listEpisodes(limit);
      return {
        episodes: episodes.map((e) => ({
          id: e.id,
          content: e.content,
          source: e.source,
          importance: e.importance,
          tags: e.tags,
          tier: e.tier,
          createdAt: e.createdAt,
        })),
      };
    }

    case "delivery-queue-status": {
      return {
        stats: deliveryQueue.getStats(),
        failed: deliveryQueue.getFailedEntries(20),
      };
    }

    case "spawn-subagent-thread": {
      if (!subagentThreadSpawner) {
        throw new ManagerError("Subagent thread spawning requires Discord bridge");
      }
      const parentAgent = validateStringParam(params, "parentAgent");
      const threadName = validateStringParam(params, "threadName");
      const systemPrompt = typeof params.systemPrompt === "string" ? params.systemPrompt : undefined;
      const task = typeof params.task === "string" ? params.task : undefined;
      // Phase 999.98-fu — `fable` selectable for subagent threads (Category C widen).
      const model = typeof params.model === "string" ? params.model as "sonnet" | "opus" | "haiku" | "fable" : undefined;
      // Phase 999.3 — D-EDG-04: empty string treated as not-set; D-ARC-02:
      // validate delegate exists at IPC boundary so the verbatim error
      // surfaces to the MCP caller (per Phase 85 TOOL-04 verbatim-error pattern).
      const delegateToRaw = typeof params.delegateTo === "string" ? params.delegateTo : undefined;
      const delegateTo = delegateToRaw && delegateToRaw.length > 0 ? delegateToRaw : undefined;
      if (delegateTo) {
        const delegateConfig = manager.getAgentConfig(delegateTo);
        if (!delegateConfig) {
          throw new ManagerError(`Delegate agent '${delegateTo}' not found in config`);
        }
      }
      // Phase 100 follow-up — post-reply chain.
      //   autoRelay (default true): parent gets a synthetic turn in main channel
      //   autoArchive (default false): also archive thread + stop session
      //   autoArchive implies autoRelay
      // Phase 999.19 D2 — forward autoArchive as a tri-state
      // (boolean | undefined). Coercing `undefined` → `false` here would
      // defeat the spawner's delegate-aware default (delegated spawns
      // default autoArchive true). The spawner is the single site that
      // resolves the default.
      const autoArchive =
        typeof params.autoArchive === "boolean" ? params.autoArchive : undefined;
      const autoRelay = params.autoRelay === undefined
        ? true
        : params.autoRelay !== false;
      const result = await subagentThreadSpawner.spawnInThread({
        parentAgentName: parentAgent,
        threadName,
        systemPrompt,
        model,
        task,
        autoRelay,
        autoArchive,
        delegateTo,
      });
      // Register session end callback for automatic cleanup (SATH-04).
      // Phase 99 sub-scope M (2026-04-26) — also auto-relay completion to
      // parent agent BEFORE cleanup so the binding (parent agent + channel)
      // is still readable. Relay is fire-and-forget (errors logged, never
      // thrown) so cleanup always runs.
      //
      // Phase 999.25 — dedupe with the explicit `subagent_complete` tool
      // and the quiescence sweep. If `binding.completedAt` is already
      // set, both prior paths fired; skip the relay here to avoid a
      // duplicate post in the parent channel. Cleanup still runs.
      manager.registerSessionEndCallback(result.sessionName, async () => {
        try {
          const reg = await readThreadRegistry(THREAD_REGISTRY_PATH);
          const binding = getBindingForThread(reg, result.threadId);
          if (binding?.completedAt !== undefined && binding?.completedAt !== null) {
            logger.info(
              {
                component: "subagent-thread-spawner",
                action: "skip-session-end-relay",
                reason: "already-completed",
                threadId: result.threadId,
                sessionName: result.sessionName,
                completedAt: binding.completedAt,
              },
              "session-end relay skipped — completion already relayed",
            );
          } else {
            // Phase 999.36 sub-bug D diag (D-12) — session-end firing log.
            // This path fires when the subagent's claude session naturally
            // ends and neither the explicit-tool nor quiescence-sweep
            // beat it to the relay.
            logger.info(
              {
                source: "session-end",
                threadId: result.threadId,
                sessionName: result.sessionName,
              },
              "[diag] subagent-complete-fired",
            );
            // Phase 999.36 sub-bug D backstop — session-end is
            // delivery-equivalent. If the agent's session ended without an
            // explicit lastDeliveryAt stamp (crash mid-stream, manual stop,
            // etc.), the operator still deserves notification. Stamp delivery
            // now so markRelayCompleted's gate passes.
            //
            // Session-end carries no content signal, so we stamp
            // `producedRealContent: true` as the delivery-equivalent default
            // — preserves existing behaviour for relay paths that gate on
            // the new flag (the quiescence sweep). A placeholder-only
            // subagent that hit session-end without ever delivering real
            // content is rare and acceptable to surface; the alternative
            // (silent drop) is the regression we're fixing on the
            // quiescence path.
            try {
              const stamp = await stampLastDeliveryAt(
                THREAD_REGISTRY_PATH,
                result.threadId,
                Date.now(),
                true,
              );
              if (!stamp.ok) {
                logger.warn(
                  { threadId: result.threadId, reason: stamp.reason },
                  "session-end backstop lastDeliveryAt stamp failed (relay may refuse)",
                );
              }
            } catch (err) {
              logger.warn(
                {
                  threadId: result.threadId,
                  error: (err as Error).message,
                },
                "session-end backstop lastDeliveryAt stamp threw (relay may refuse)",
              );
            }
            await subagentThreadSpawner.relayCompletionToParent(result.threadId);
          }
        } catch (err) {
          // Best-effort: relay failure must not block cleanup. Matches
          // the pre-Phase-999.25 fire-and-forget posture.
          logger.warn(
            {
              component: "subagent-thread-spawner",
              err: String(err),
              threadId: result.threadId,
              sessionName: result.sessionName,
            },
            "session-end relay errored (non-fatal); cleanup continues",
          );
        }
        await subagentThreadSpawner.cleanupSubagentThread(result.threadId);
      });
      return { ok: true, ...result };
    }

    case "cleanup-subagent-thread": {
      if (!subagentThreadSpawner) {
        throw new ManagerError("Subagent thread spawning requires Discord bridge");
      }
      const threadId = validateStringParam(params, "threadId");
      await subagentThreadSpawner.cleanupSubagentThread(threadId);
      return { ok: true };
    }

    case "archive-discord-thread": {
      // Phase 100 follow-up — operator/agent-driven Discord thread archive +
      // auto-prune the thread-bindings.json registry entry.
      //
      // Phase 999.14 MCP-08 — now routed through cleanupThreadWithClassifier
      // so Discord 50001 (Missing Access) and 10003 (Unknown Channel) — both
      // indicating the thread is gone server-side — prune the registry entry
      // instead of throwing. Returns success-with-classification on every
      // path (CLI uses classification to print the right message).
      if (!subagentThreadSpawner) {
        throw new ManagerError("Discord thread archive requires Discord bridge");
      }
      const threadId = validateStringParam(params, "threadId");
      const lock = params.lock === true;
      // Resolve agentName for log triage (operator regression — fin-client vs fin-test).
      let agentName = "(unknown)";
      try {
        const reg = await readThreadRegistry(THREAD_REGISTRY_PATH);
        agentName = getBindingForThread(reg, threadId)?.agentName ?? "(unknown)";
      } catch {
        /* best-effort — non-fatal if registry read fails */
      }
      const result = await cleanupThreadWithClassifier({
        spawner: subagentThreadSpawner,
        registryPath: THREAD_REGISTRY_PATH,
        threadId,
        agentName,
        log: logger,
        lock,
      });
      return { ok: true, ...result };
    }

    case "threads-prune-stale": {
      // Phase 999.14 MCP-10 — operator escape hatch: run the stale-binding
      // sweep on demand with an operator-supplied threshold (overrides the
      // daemon-wide defaults.threadIdleArchiveAfter).
      if (!subagentThreadSpawner) {
        throw new ManagerError("Stale-binding prune requires Discord bridge");
      }
      const staleAfter = validateStringParam(params, "staleAfter");
      const idleMs = parseIdleDuration(staleAfter);
      const result = await sweepStaleBindings({
        spawner: subagentThreadSpawner,
        registryPath: THREAD_REGISTRY_PATH,
        now: Date.now(),
        idleMs,
        log: logger,
      });
      return { ok: true, ...result };
    }

    case "threads-prune-agent": {
      // Phase 999.14 MCP-10 — last-resort operator escape hatch. Force-prunes
      // ALL bindings for the named agent without calling Discord. Used when
      // the registry has bindings whose Discord state is unknown / unreachable
      // (today's incident: 3 fin-client bindings, all Discord-50001).
      const agentName = validateStringParam(params, "agent");
      // 999.65 — atomic read-modify-write: enumerate + prune all of the
      // agent's bindings inside one critical section so a concurrent
      // registry writer cannot lose-update the prune. prunedCount is the
      // PRE-prune count, captured inside the mutator.
      let prunedCount = 0;
      await mutateThreadRegistry(THREAD_REGISTRY_PATH, (current) => {
        const bindings = getBindingsForAgent(current, agentName);
        prunedCount = bindings.length;
        let next = current;
        for (const b of bindings) {
          next = removeBinding(next, b.threadId);
        }
        return next;
      });
      logger.info(
        {
          component: "thread-cleanup",
          action: "force-prune-agent",
          agent: agentName,
          prunedCount,
        },
        "force-pruned all bindings for agent (no Discord call)",
      );
      return { ok: true, prunedCount };
    }

    case "schedule-reminder": {
      // Phase 100 follow-up (operator-surfaced 2026-04-27) — backs the
      // `schedule_reminder` MCP tool. Agents promise "ping me at 7:58 PM"
      // but had no scheduling primitive — the reminder leaked into context
      // and bled into the next inbound turn instead of firing as its own
      // standalone message. This routes through SchedulerSource +
      // TriggerEngine + the f984008 delivery callback, so the agent's reply
      // posts to its bound Discord channel.
      //
      // Accepts `at` as either ISO 8601 (`2026-04-27T19:58:00-07:00`) or a
      // relative expression ("in 15 min", "in 2 hours", "in 30s", "in 3
      // days"). In-memory only — daemon restart loses pending reminders.
      const agentName = validateStringParam(params, "agent");
      const prompt = validateStringParam(params, "prompt");
      const atRaw = validateStringParam(params, "at");

      let fireAt: Date;
      const relMatch = atRaw.match(
        /^in\s+(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|days?)$/i,
      );
      if (relMatch) {
        const n = parseInt(relMatch[1]!, 10);
        const unit = relMatch[2]!.toLowerCase();
        let ms: number;
        if (unit.startsWith("s")) ms = n * 1000;
        else if (unit.startsWith("m")) ms = n * 60 * 1000;
        else if (unit.startsWith("h")) ms = n * 60 * 60 * 1000;
        else if (unit.startsWith("d")) ms = n * 24 * 60 * 60 * 1000;
        else throw new ManagerError(`Unsupported time unit: ${unit}`);
        fireAt = new Date(Date.now() + ms);
      } else {
        fireAt = new Date(atRaw);
        if (isNaN(fireAt.getTime())) {
          throw new ManagerError(
            `Invalid 'at' format. Use ISO 8601 (e.g. 2026-04-27T19:58:00-07:00) or relative ("in 15 min").`,
          );
        }
      }

      const result = await schedulerSource.addOneShotReminder({
        fireAt,
        agentName,
        prompt,
      });
      return {
        ok: true,
        reminderId: result.reminderId,
        fireAt: fireAt.toISOString(),
      };
    }

    case "schedule-recurring": {
      // Phase 999.99 — backs the `schedule_recurring` MCP tool. Registers a
      // runtime recurring schedule whose every tick posts a standalone Discord
      // message via the f984008 trigger-delivery callback (the recurring twin
      // of schedule_reminder), instead of self-firing a turn whose output
      // buffers in driverIter and drains one-per-inbound-message.
      //
      // Accepts a raw `cron` string OR a friendly `interval` ("every 5 min" /
      // "every 2 hours"). The friendly form is RANGE-CONSTRAINED because a naive
      // `every N min → */N` reproduces the slash-90 June crash; out-of-range
      // values are a clean ManagerError, not a crash. Either way the derived
      // cron passes through addRecurringSchedule's croner construction guard +
      // min-interval + per-agent cap (those ManagerErrors propagate as clean
      // JSON-RPC errors). DURABLE — persisted to
      // ~/.clawcode/manager/recurring-schedules.json + re-registered on restart
      // (forward-only resume). A persist failure rolls back + errors cleanly.
      const agentName = validateStringParam(params, "agent");
      const prompt = validateStringParam(params, "prompt");
      const cronRaw = typeof params.cron === "string" ? params.cron.trim() : "";
      const intervalRaw =
        typeof params.interval === "string" ? params.interval.trim() : "";

      let cron: string;
      if (cronRaw.length > 0) {
        cron = cronRaw;
      } else if (intervalRaw.length > 0) {
        // Friendly-interval parser — RANGE-CONSTRAINED to dodge the slash-90
        // croner-crash vector. min: 1..59 → `*/N * * * *`; hours: 1..23 →
        // `0 */N * * *`; anything else demands a raw cron string.
        const m = intervalRaw.match(
          /^every\s+(\d+)\s*(m|min|minutes?|h|hr|hours?)$/i,
        );
        if (!m) {
          throw new ManagerError(
            "Unsupported interval. Use 'every N min' (1-59), 'every N hours' (1-23), or pass a raw cron.",
          );
        }
        const n = parseInt(m[1]!, 10);
        const unit = m[2]!.toLowerCase();
        if (unit.startsWith("m")) {
          if (n < 1 || n > 59) {
            throw new ManagerError(
              "'every N min' requires 1 ≤ N ≤ 59. For longer intervals use 'every N hours' or a raw cron.",
            );
          }
          cron = `*/${n} * * * *`;
        } else {
          if (n < 1 || n > 23) {
            throw new ManagerError(
              "'every N hours' requires 1 ≤ N ≤ 23. For longer intervals use a raw cron.",
            );
          }
          cron = `0 */${n} * * *`;
        }
      } else {
        throw new ManagerError(
          "schedule_recurring requires either 'cron' or 'interval'.",
        );
      }

      const result = await schedulerSource.addRecurringSchedule({
        cron,
        agentName,
        prompt,
      });
      return { ok: true, scheduleId: result.scheduleId, cron };
    }

    case "cancel-schedule": {
      // Phase 999.99 — backs the `cancel_schedule` MCP tool. Cancel is keyed
      // by the scheduleId returned from schedule_recurring; `agent` is accepted
      // for symmetry/audit even though the id alone identifies the schedule.
      validateStringParam(params, "agent");
      const scheduleId = validateStringParam(params, "scheduleId");
      const cancelled = await schedulerSource.cancelRecurring(scheduleId);
      return { ok: true, cancelled };
    }

    case "approve-command": {
      const agentName = validateStringParam(params, "agent");
      const command = validateStringParam(params, "command");
      const approvedBy = typeof params.approvedBy === "string" ? params.approvedBy : "ipc";
      await approvalLog.record({ timestamp: new Date().toISOString(), agentName, command, decision: "approved", approvedBy });
      return { ok: true };
    }

    case "deny-command": {
      const agentName = validateStringParam(params, "agent");
      const command = validateStringParam(params, "command");
      const approvedBy = typeof params.approvedBy === "string" ? params.approvedBy : "ipc";
      await approvalLog.record({ timestamp: new Date().toISOString(), agentName, command, decision: "denied", approvedBy });
      return { ok: true };
    }

    case "allow-always": {
      const agentName = validateStringParam(params, "agent");
      const pattern = validateStringParam(params, "pattern");
      const approvedBy = typeof params.approvedBy === "string" ? params.approvedBy : "ipc";
      await approvalLog.recordAllowAlways(agentName, pattern, approvedBy);
      const matcher = allowlistMatchers.get(agentName);
      if (matcher) matcher.addAllowAlways(pattern);
      return { ok: true };
    }

    case "check-command": {
      const agentName = validateStringParam(params, "agent");
      const command = validateStringParam(params, "command");
      const matcher = allowlistMatchers.get(agentName);
      if (!matcher) return { allowed: true, reason: "no-allowlist-configured" };
      const result = matcher.check(command);
      return { allowed: result.allowed, matchedPattern: result.matchedPattern };
    }

    case "update-security": {
      const targetAgent = validateStringParam(params, "agent");
      const content = validateStringParam(params, "content");
      const config = configs.find(c => c.name === targetAgent);
      if (!config) throw new ManagerError(`Agent '${targetAgent}' not found`);
      const securityPath = join(config.workspace, "SECURITY.md");
      await writeFile(securityPath, content, "utf-8");
      // Re-parse and update in-memory policies
      const newAcls = await parseSecurityMd(securityPath);
      const existingPolicy = securityPolicies.get(targetAgent);
      securityPolicies.set(targetAgent, { allowlist: existingPolicy?.allowlist ?? [], channelAcls: newAcls });
      return { ok: true };
    }

    case "security-status": {
      const agentFilter = typeof params.agent === "string" ? params.agent : undefined;
      const statuses: Record<string, unknown> = {};
      for (const config of configs) {
        if (agentFilter && config.name !== agentFilter) continue;
        const matcher = allowlistMatchers.get(config.name);
        const policy = securityPolicies.get(config.name);
        statuses[config.name] = {
          allowlistPatterns: config.security?.allowlist?.map(e => e.pattern) ?? [],
          allowAlwaysPatterns: matcher?.getAllowAlwaysPatterns() ?? [],
          channelAcls: policy?.channelAcls ?? [],
        };
      }
      return { agents: statuses };
    }

    case "mcp-servers": {
      const agentFilter = typeof params.agent === "string" ? params.agent : undefined;
      const check = params.check === true;

      type McpServerEntry = {
        readonly agent: string;
        readonly name: string;
        readonly command: string;
        readonly args: readonly string[];
        readonly healthy: boolean | null;
        readonly latencyMs?: number;
        readonly error?: string;
      };

      const entries: McpServerEntry[] = [];

      for (const config of configs) {
        if (agentFilter && config.name !== agentFilter) continue;
        const mcpServers = config.mcpServers ?? [];
        for (const server of mcpServers) {
          if (check) {
            const { checkMcpServerHealth } = await import("../mcp/health.js");
            const result = await checkMcpServerHealth(server);
            entries.push({
              agent: config.name,
              name: server.name,
              command: server.command,
              args: server.args,
              healthy: result.healthy,
              latencyMs: result.latencyMs,
              ...(result.error !== undefined ? { error: result.error } : {}),
            });
          } else {
            entries.push({
              agent: config.name,
              name: server.name,
              command: server.command,
              args: server.args,
              healthy: null,
            });
          }
        }
      }

      return { servers: entries };
    }

    case "list-mcp-status": {
      // Phase 85 Plan 01 TOOL-01 — per-agent MCP state snapshot.
      // Returns the live state map maintained by the warm-path gate +
      // `mcp-reconnect` heartbeat check. No probe spawn; this is a pure
      // read of the in-memory map.
      //
      // Phase 94 Plan 01 — payload extension: each entry now carries
      // an additional `capabilityProbe` field (additive-optional) sourced
      // from the per-server CapabilityProbeSnapshot written by the
      // mcp-reconnect heartbeat. Phase 85 readers that don't consult
      // capabilityProbe continue to work unchanged.
      //
      // Phase 94 Plan 07 D-07 / TOOL-12 — payload extension: each entry
      // also carries an `alternatives` array listing other agents whose
      // snapshot has the SAME server in capabilityProbe.status==="ready".
      // Computed daemon-side via findAlternativeAgents (94-04 helper) so
      // both /clawcode-tools and `clawcode mcp-status` render from the
      // same single-source-of-truth IPC payload (D-11 invariant).
      const agentName = validateStringParam(params, "agent");
      const state = manager.getMcpStateForAgent(agentName);
      const { findAlternativeAgents } = await import(
        "./find-alternative-agents.js"
      );
      // Build a one-shot McpStateProvider over all known agents (excluding
      // the querying agent itself — operators don't need "this agent" in
      // its own alternatives list). The toolToServer override returns the
      // server name verbatim because we already pass the server name as
      // the lookup key (skips the SDK-prefix heuristic which would mis-
      // tokenize server names containing underscores or hyphens).
      const allAgentNames = configs
        // Phase 999.19 — central predicate also excludes -via- delegated sessions.
        .filter((c) => !isSubagentOrThreadSession(c.name))
        .map((c) => c.name);
      const otherAgents = allAgentNames.filter((n) => n !== agentName);
      const altsProvider = {
        listAgents: () => otherAgents,
        getStateFor: (name: string) => manager.getMcpStateForAgent(name),
        toolToServer: (s: string) => s,
      };
      const servers = [...state.values()].map((s) => {
        const alternatives = findAlternativeAgents(s.name, altsProvider);
        return {
          name: s.name,
          status: s.status,
          lastSuccessAt: s.lastSuccessAt,
          lastFailureAt: s.lastFailureAt,
          failureCount: s.failureCount,
          optional: s.optional,
          lastError: s.lastError?.message ?? null,
          // Phase 94 Plan 01 — capability probe block (undefined until first
          // probe runs; serializes through JSON-RPC as null).
          ...(s.capabilityProbe !== undefined
            ? { capabilityProbe: s.capabilityProbe }
            : {}),
          // Phase 94 Plan 07 D-07 — alternatives is always present (frozen
          // empty array when no other agent has the server ready). Renderer
          // suppresses the line for ready servers itself; the wire payload
          // carries the data unconditionally for symmetry.
          alternatives: [...alternatives],
        };
      });
      return { agent: agentName, servers };
    }

    case "mcp-probe": {
      // Phase 94 Plan 01 TOOL-01 — on-demand capability probe trigger.
      // Operator runs `clawcode mcp-probe -a <agent>` to force an immediate
      // probe of all configured MCP servers. The boot + 60s heartbeat
      // schedule continues unaffected; this just runs an extra cycle now.
      //
      // Phase 94 Plan 01 Gap-Closure 2 — real callTool / listTools wired
      // at the daemon edge via JSON-RPC stdio (src/mcp/json-rpc-call.ts).
      // Connect-test runs first; for ready/degraded servers the capability
      // probe issues a real tools/list against each MCP subprocess.
      // capability-probe.ts itself stays DI-pure — this is the production
      // injection site.
      const agentName = validateStringParam(params, "agent");
      const cfg = manager.getAgentConfig(agentName);
      if (!cfg) {
        throw new ManagerError(`agent '${agentName}' not configured`);
      }
      const mcpServers = cfg.mcpServers ?? [];
      const priorState = manager.getMcpStateForAgent(agentName);

      // Re-run the connect-test first (same primitive as the warm-path
      // gate + heartbeat) so we have an authoritative status to mirror
      // into capabilityProbe for failed servers.
      const { performMcpReadinessHandshake } = await import(
        "../mcp/readiness.js"
      );
      const { probeAllMcpCapabilities } = await import(
        "./capability-probe.js"
      );
      const { makeRealCallTool, makeRealListTools } = await import(
        "../mcp/json-rpc-call.js"
      );
      // Phase 999.27 — skip broker-pooled servers from on-demand probes.
      // The 1password broker shim probe would spawn with daemon-default
      // env (clawdbot token), causing broker rebind cycles. Broker has
      // its own heartbeat at `heartbeat/checks/mcp-broker.ts`.
      const probableServers = (
        await import("../mcp/broker-shim-detect.js")
      ).filterOutBrokerPooled(mcpServers);
      const rep = await performMcpReadinessHandshake(probableServers);

      // Carry prior capabilityProbe blocks for lastSuccessAt preservation.
      const prevProbeByName = new Map<
        string,
        import("../mcp/readiness.js").CapabilityProbeSnapshot
      >();
      for (const [name, prior] of priorState) {
        if (prior.capabilityProbe) {
          prevProbeByName.set(name, prior.capabilityProbe);
        }
      }

      const probeLog = (await import("pino")).default({ level: "silent" });
      const serversByName = new Map(
        probableServers.map((s) => [
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
        // Default-fallback override per heartbeat: verify capability via
        // tools/list response. Plan 94-03 will lift this per-server as
        // registry probes are vetted to be safe to call in production.
        getProbeFor: () => async (innerDeps: {
          listTools: (s: string) => Promise<readonly { readonly name: string }[]>;
        }) => {
          try {
            const tools = await innerDeps.listTools("__on_demand_probe__");
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

      const readyOrDegradedNames: string[] = [];
      for (const [name, fresh] of rep.stateByName) {
        if (fresh.status !== "failed") readyOrDegradedNames.push(name);
      }

      const probeResults = readyOrDegradedNames.length > 0
        ? await probeAllMcpCapabilities(
            readyOrDegradedNames,
            // The orchestrator's getProbeFor signature returns a ProbeFn
            // so the inline closure above is the right shape; cast the
            // deps object to the ProbeOrchestratorDeps shape.
            probeDeps as unknown as Parameters<typeof probeAllMcpCapabilities>[1],
            prevProbeByName,
          )
        : new Map<string, import("../mcp/readiness.js").CapabilityProbeSnapshot>();

      // Build merged state: connect-fail mirrors into capabilityProbe;
      // connect-ok takes the probe result.
      type McpState = import("../mcp/readiness.js").McpServerState;
      type ProbeSnap = import("../mcp/readiness.js").CapabilityProbeSnapshot;
      const merged = new Map<string, McpState>();
      const nowIso = new Date().toISOString();
      for (const [name, fresh] of rep.stateByName) {
        let probe: ProbeSnap;
        if (fresh.status === "failed") {
          const priorProbe = prevProbeByName.get(name);
          probe = {
            lastRunAt: nowIso,
            status: "failed",
            ...(fresh.lastError?.message
              ? { error: fresh.lastError.message }
              : {}),
            ...(priorProbe?.lastSuccessAt !== undefined
              ? { lastSuccessAt: priorProbe.lastSuccessAt }
              : {}),
          };
        } else {
          probe = probeResults.get(name) ?? {
            lastRunAt: nowIso,
            status: "unknown",
          };
        }
        merged.set(name, Object.freeze({ ...fresh, capabilityProbe: probe }));
      }

      manager.setMcpStateForAgent(agentName, merged);

      // Return the capabilityProbe snapshots verbatim so the CLI can
      // render them directly.
      const servers = [...merged.values()].map((s) => ({
        name: s.name,
        status: s.status,
        capabilityProbe: s.capabilityProbe,
        lastError: s.lastError?.message ?? null,
        optional: s.optional,
      }));
      return { agent: agentName, servers };
    }

    case "list-sync-status": {
      // Phase 91 Plan 05 SYNC-08 — OpenClaw ↔ ClawCode sync snapshot.
      //
      // Reads two on-disk artifacts produced by Plan 91-01/02:
      //   - ~/.clawcode/manager/sync-state.json → authoritativeSide,
      //     conflicts[], lastSyncedAt (SyncStateFile from src/sync/types.ts)
      //   - ~/.clawcode/manager/sync.jsonl (last line) → last cycle outcome
      //     (filesAdded/Updated/Removed/Bytes/Duration/status/cycleId)
      //
      // Consumed by the /clawcode-sync-status inline handler in
      // slash-commands.ts (Phase 85 /clawcode-tools blueprint mirrored
      // verbatim). Zero LLM turn cost — pure file reads, no network.
      //
      // Missing/unparseable files fall back to DEFAULT_SYNC_STATE +
      // lastCycle:null respectively (never throws to the IPC caller).
      const { readSyncState, DEFAULT_SYNC_STATE_PATH, DEFAULT_SYNC_JSONL_PATH } =
        await import("../sync/sync-state-store.js");

      const state = await readSyncState(DEFAULT_SYNC_STATE_PATH, logger);
      const openConflicts = state.conflicts.filter((c) => c.resolvedAt === null);

      let lastCycle: Record<string, unknown> | null = null;
      try {
        const raw = await readFile(DEFAULT_SYNC_JSONL_PATH, "utf8");
        const lines = raw.trim().split("\n").filter((l) => l.length > 0);
        if (lines.length > 0) {
          const parsed = JSON.parse(lines[lines.length - 1]!) as unknown;
          if (parsed && typeof parsed === "object") {
            lastCycle = parsed as Record<string, unknown>;
          }
        }
      } catch (err) {
        // Missing jsonl is the first-boot path — silent. Other failures
        // (corrupt JSON, permission) warn but still return a snapshot so
        // the embed can render "never-run".
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          logger.warn(
            {
              path: DEFAULT_SYNC_JSONL_PATH,
              error: err instanceof Error ? err.message : String(err),
            },
            "list-sync-status: failed to read sync.jsonl, returning lastCycle=null",
          );
        }
      }

      return {
        authoritativeSide: state.authoritativeSide,
        lastSyncedAt: state.lastSyncedAt,
        conflictCount: openConflicts.length,
        conflicts: openConflicts.map((c) => ({
          path: c.path,
          sourceHash: c.sourceHash,
          destHash: c.destHash,
          detectedAt: c.detectedAt,
        })),
        lastCycle,
      };
    }

    case "discord-sync-icons": {
      // 999.160 v1.2 — upload cc_*.png as application emojis through the bridge.
      const bridge = iconSyncBridgeGetter?.() ?? null;
      if (!bridge) return { ok: false, message: "Discord bridge is not running." };
      const raw = (params as { icons?: unknown }).icons;
      if (!Array.isArray(raw) || raw.length === 0 || raw.length > 64) {
        throw new ManagerError("icons: expected 1–64 entries");
      }
      const files = raw.map((e) => {
        const o = e as { name?: unknown; png?: unknown };
        if (typeof o.name !== "string" || typeof o.png !== "string" || o.png.length === 0 || o.png.length > 400_000) {
          throw new ManagerError("icons: each entry needs {name, png} with png ≤ 300 KB base64");
        }
        return { name: o.name, png: o.png };
      });
      const result = await bridge.syncIcons(files);
      return { ok: true, ...result };
    }
    case "memory-relieve": {
      // 999.147 — the CLI equivalent of the 🩹 button, named inline on every
      // imminence page so the action stays reachable when the alert lands on
      // a leg that cannot carry components (bot-direct, pino).
      //
      // `startTicks` is optional: a CLI operator is naming a pid they are
      // looking at RIGHT NOW, so there is no stale-button window to guard —
      // the identity is read fresh here. Supplying it explicitly is still
      // honoured, which is what makes a scripted call safe. Every other
      // guard (not-the-daemon, cgroup membership, already-recovered) applies
      // identically, because this is the same executeRelief.
      const factory = getReliefDepsFactory();
      if (!factory) {
        return {
          ok: false,
          message: "⚠️ Memory relief is not wired on this daemon.",
        };
      }
      const pidRaw = (params as { pid?: unknown })?.pid;
      if (typeof pidRaw !== "number" || !Number.isInteger(pidRaw) || pidRaw <= 1) {
        throw new ManagerError("Missing or invalid required parameter: pid");
      }
      const pid = pidRaw;
      const supplied = (params as { startTicks?: unknown })?.startTicks;
      const live = readReliefProc(pid);
      if (live === null) {
        return { ok: false, message: `⚠️ Not killed — pid ${pid} does not exist.` };
      }
      const startTicks =
        typeof supplied === "number" && Number.isInteger(supplied)
          ? supplied
          : live.startTicks;
      const actorRaw = (params as { actor?: unknown })?.actor;
      const actor =
        typeof actorRaw === "string" && actorRaw.length > 0
          ? `cli:${actorRaw.slice(0, 64)}`
          : "cli:unknown";
      return await executeRelief(
        { pid, startTicks, issuedAtMs: Date.now() },
        actor,
        factory(),
      );
    }
    case "ask-advisor": {
      // Phase 117-07 T02 — dispatch delegated to `handleAskAdvisor` for
      // testability + to make the dispatch shape (native short-circuit
      // vs fork-via-AdvisorService) reviewable without scrolling the
      // 60-line inline body that used to live here. Truncation + budget
      // gate + recordCall now live in `DefaultAdvisorService.ask`
      // (Plan 117-02 T06) — single source of truth for
      // `ADVISOR_RESPONSE_MAX_LENGTH`. Memory-context retrieval dropped
      // by design — see the AdvisorService composition comment at the
      // daemon-boot site for the parity-loss rationale.
      const agentName = validateStringParam(params, "agent");
      const question = validateStringParam(params, "question");
      return await handleAskAdvisor(
        { manager, advisorService, advisorBudget, advisorDefaults },
        { agent: agentName, question },
      );
    }

    // Phase 124 Plan 01 T-03 — hybrid compaction primitive. Wires the
    // pure-DI handler at daemon-compact-session-ipc.ts. Operator-callable
    // via `clawcode session compact <agent>`. Per Path B (advisor-consulted
    // before write), live-handle hot-swap is deferred — the fork JSONL is
    // produced on disk + memory.db grows + `forked_to` is surfaced; the
    // live worker continues writing to the original session. Tracked as a
    // follow-up in 124-01-SUMMARY.md.
    case "compact-session": {
      const agentName = validateStringParam(params, "agent");
      const { handleCompactSession } = await import(
        "./daemon-compact-session-ipc.js"
      );
      // Phase 138 Plan 04 T-03 — resolve the SDK through the per-agent
      // runtime resolver (threaded into `routeMethod` as
      // `getLlmRuntime`). Mirror of the heartbeat auto-trigger
      // callsite above; silent-path-bifurcation gate (CONTEXT D-06) —
      // BOTH compaction-fork sites updated in the SAME commit.
      const sdk = await getLlmRuntime(agentName).loadSdkModule();
      // Phase 125 Plan 02 — D-01 single extractor seam. Identical
      // construction to the auto-trigger callsite above. Tier 1 runs
      // here so preserved turns ride through `buildTieredExtractor`'s
      // head; daily-log durability is preserved (getConversationTurns
      // below still returns ALL turns to compactForAgent's flush step).
      const {
        buildTieredExtractor: buildExtIpc,
        partitionForVerbatim: partitionIpc,
      } = await import("./compact-extractors/index.js");
      const cfgForAgentIpc = configs.find(
        (a: ResolvedAgentConfig) => a.name === agentName,
      );
      const preserveLastTurnsIpc = cfgForAgentIpc?.preserveLastTurns ?? 10;
      const preserveVerbatimIpc =
        cfgForAgentIpc?.preserveVerbatimPatterns ?? [];
      const allTurnsIpc = (() => {
        const sid = manager.getActiveConversationSessionId(agentName);
        const store = manager.getConversationStore(agentName);
        if (!sid || !store) return [];
        return store
          .getTurnsForSession(sid)
          .filter((t) => t.role !== "system")
          .map((t) => ({
            timestamp: t.createdAt,
            role: t.role as "user" | "assistant",
            content: t.content,
          }));
      })();
      const partitionDepsIpc = {
        preserveLastTurns: preserveLastTurnsIpc,
        preserveVerbatimPatterns: preserveVerbatimIpc,
        clock: () => new Date(),
        log: logger,
        agentName,
      };
      const { preserved: preservedIpc } = partitionIpc(
        allTurnsIpc,
        partitionDepsIpc,
      );
      // Phase 125 Plan 03 — Tier 2 Haiku-driven structured extraction
      // (mirror of the auto-trigger site above; silent-path-bifurcation
      // gate from Plan 02 continues to apply — BOTH sites updated in the
      // same commit).
      const onTier2FactsIpc = async (facts: import("./compact-extractors/types.js").Tier2Facts): Promise<void> => {
        try {
          const { buildActiveStateBlock } = await import(
            "./active-state/builder.js"
          );
          const { writeActiveStateYaml } = await import(
            "./active-state/yaml-writer.js"
          );
          const fsPromises = await import("node:fs/promises");
          const operatorMsgs = allTurnsIpc
            .filter((t) => t.role === "user")
            .slice(-5)
            .map((t) => t.content);
          const block = buildActiveStateBlock({
            recentOperatorMessages: operatorMsgs,
            recentAgentTurns: allTurnsIpc as unknown as readonly import("../memory/conversation-types.js").ConversationTurn[],
            agentName: agentName,
            clock: () => new Date(),
            tier2Facts: facts,
          });
          await writeActiveStateYaml(agentName, block, {
            baseDir: join(homedir(), ".clawcode", "agents"),
            fs: fsPromises,
            clock: () => new Date(),
          });
        } catch (err) {
          logger.warn(
            { agent: agentName, error: (err as Error).message },
            "[125-03-tier2-haiku] onTier2Facts (ipc) failed (non-fatal)",
          );
        }
      };
      const baseExtractMemories = buildExtIpc({
        ...partitionDepsIpc,
        preservedTurns: preservedIpc,
        tier2Summarize: (prompt, opts) => summarizeWithHaiku(prompt, opts),
        onTier2Facts: onTier2FactsIpc,
      });
      // Phase 999.75 Part A (A4) — feed the extractor the tool-aware SDK
      // transcript (tool blocks verbatim) instead of the final-text-only
      // ConversationStore text. The closure substitutes the text the
      // extractor sees; `getConversationTurns` below is UNCHANGED so the
      // daily-log flush still receives ConversationStore turns (Fork A).
      // Fail-open: `loadCompactionTurns` → null → the base extractor runs
      // on the ConversationStore text exactly as before. Byte-identical to
      // the heartbeat auto-trigger call site (anti-bifurcation).
      const toolAwareTextIpc = await loadCompactionTurns({
        agentName,
        manager,
        sdk,
        config: cfgForAgentIpc,
        log: logger,
      });
      const extractMemories =
        toolAwareTextIpc !== null
          ? (_text: string): Promise<readonly string[]> =>
              baseExtractMemories(toolAwareTextIpc)
          : baseExtractMemories;
      // Phase 124 follow-up — wire the producer-side turnStartedAt slot
      // into the handler's safety-budget gate. Build a 1-entry map at call
      // time from SessionManager.getTurnStartedAt(); when no turn is in
      // flight (or the agent is not running) the map stays empty and the
      // gate falls through. `maxTurnAgeMs` is left to its 10-min default
      // per CONTEXT D-03 step 2.
      const turnStartedAtIpc = (() => {
        const ts = manager.getTurnStartedAt(agentName);
        return ts !== null ? new Map([[agentName, ts]]) : new Map<string, number>();
      })();
      // Phase 999.75 Part B — `CompactSessionDeps` (the `manager` projection
      // + the handle-backed `sendCompactCommand` / `getContextUsage` seams)
      // is assembled by the shared `buildCompactSessionDeps` helper so this
      // call site stays byte-identical to the heartbeat auto-trigger site
      // above (anti-bifurcation — same precedent as Part A's
      // `loadCompactionTurns`).
      const { buildCompactSessionDeps } = await import(
        "./build-compact-session-deps.js"
      );
      const compactResult = await handleCompactSession(
        { agent: agentName },
        buildCompactSessionDeps({
          agent: agentName,
          manager,
          extractMemories,
          log: logger,
          turnStartedAt: turnStartedAtIpc,
        }),
      );
      // Phase 124 Plan 04 T-01 — record into the in-memory log so
      // `heartbeat-status` surfaces `last_compaction_at` AND the heartbeat
      // auto-trigger cooldown gate (T-02) sees both manual and auto
      // compactions through the same source of truth. Only successful
      // compactions are recorded — failed attempts must NOT enter cooldown.
      // Phase 999.75 Part B — also capture the token-reduction snapshot.
      if (compactResult.ok === true) {
        compactionEventLog.record(agentName);
        compactionEventLog.recordTokens(agentName, {
          tokensBefore: compactResult.tokens_before,
          tokensAfter: compactResult.tokens_after,
          liveReduced: compactResult.live_reduced,
          ...(compactResult.skip_reason !== undefined
            ? { skipReason: compactResult.skip_reason }
            : {}),
        });
      }
      return compactResult;
    }

    // Phase 132 Plan 03 T-03 — operator review surface (slash commands
    // /approve-skill / /reject-skill / /edit-skill). Each dispatches to a
    // pure-IO handler in src/manager/skill-draft-actions.ts that resolves
    // the staging file by readdir + basename match (no string-concat path
    // traversal — see threat T-132-03-01) and either moves the draft to
    // active skills/ (approve, D-04), archives to skills-rejected/ with
    // fingerprint12 preserved (reject, D-07), or returns the absolute path
    // for scp-edit (locate-for-edit, CONTEXT §Claude's Discretion).
    //
    // Late-bound holder pattern: routeMethod can't reach startDaemon's
    // local `log` or homedir-rooted resolver, so the ref is wired at boot
    // (phase132DraftActionDepsRef). Missing-ref means the daemon is mid-
    // shutdown or boot — return a synthetic error so the IPC client sees
    // a structured failure rather than throwing.
    case "approve-skill-draft": {
      const agentName = validateStringParam(params, "agent");
      const draftId = validateStringParam(params, "draftId");
      if (!phase132DraftActionDepsRef) {
        return { status: "not-found", reason: "staging-file-missing" };
      }
      try {
        return await approveDraft(
          { agent: agentName, draftId },
          phase132DraftActionDepsRef,
        );
      } catch (err) {
        logger.error(
          {
            agent: agentName,
            draftId,
            err: err instanceof Error ? err.message : String(err),
          },
          "approve-skill-draft failed",
        );
        throw new ManagerError(
          `approve-skill-draft: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    case "reject-skill-draft": {
      const agentName = validateStringParam(params, "agent");
      const draftId = validateStringParam(params, "draftId");
      const reasonRaw = params.reason;
      const reason = typeof reasonRaw === "string" ? reasonRaw : undefined;
      if (!phase132DraftActionDepsRef) {
        return { status: "not-found", reason: "staging-file-missing" };
      }
      try {
        return await rejectDraft(
          { agent: agentName, draftId, reason },
          phase132DraftActionDepsRef,
        );
      } catch (err) {
        logger.error(
          {
            agent: agentName,
            draftId,
            err: err instanceof Error ? err.message : String(err),
          },
          "reject-skill-draft failed",
        );
        throw new ManagerError(
          `reject-skill-draft: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    case "edit-skill-draft": {
      const agentName = validateStringParam(params, "agent");
      const draftId = validateStringParam(params, "draftId");
      if (!phase132DraftActionDepsRef) {
        return { status: "not-found", reason: "staging-file-missing" };
      }
      try {
        return await locateDraftForEdit(
          { agent: agentName, draftId },
          phase132DraftActionDepsRef,
        );
      } catch (err) {
        logger.error(
          {
            agent: agentName,
            draftId,
            err: err instanceof Error ? err.message : String(err),
          },
          "edit-skill-draft failed",
        );
        throw new ManagerError(
          `edit-skill-draft: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Phase 999.42 Plan 06 — capability C skill PATCH lifecycle operator
    // review surface (slash commands /patch-skill / /approve-patch /
    // /reject-patch). Each dispatches to a pure-IO handler in
    // src/manager/skill-patch-actions.ts (Plan 05) — single dispatch site
    // each (silent-path-bifurcation invariant). Late-bound holder pattern
    // mirrors phase132DraftActionDepsRef: routeMethod can't reach
    // startDaemon's local `log` / homedir-rooted resolver, so the ref is
    // wired at boot (phase99942PatchActionDepsRef). Missing-ref means the
    // daemon is mid-shutdown or boot — return a synthetic structured
    // failure rather than throwing.
    case "list-skill-patches": {
      const agentName = validateStringParam(params, "agent");
      const slug = validateStringParam(params, "slug");
      if (!phase99942PatchActionDepsRef) {
        return { status: "listed", slug, patches: [] };
      }
      try {
        return await listPatchesForSkill(
          { agent: agentName, slug },
          phase99942PatchActionDepsRef,
        );
      } catch (err) {
        logger.error(
          {
            agent: agentName,
            slug,
            err: err instanceof Error ? err.message : String(err),
          },
          "list-skill-patches failed",
        );
        throw new ManagerError(
          `list-skill-patches: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    case "apply-skill-patch": {
      const agentName = validateStringParam(params, "agent");
      const patchId = validateStringParam(params, "patchId");
      if (!phase99942PatchActionDepsRef) {
        return { status: "not-found", reason: "patch-file-missing" };
      }
      try {
        return await applyPatch(
          { agent: agentName, patchId },
          phase99942PatchActionDepsRef,
        );
      } catch (err) {
        // Plan 05 note: applyPatch does writeFile(SKILL.md) then
        // unlink(patchFile) in two ops. If the unlink throws AFTER the
        // SKILL.md write, the patch IS applied but applyPatch throws and
        // the patch file lingers in skill-patches/. Detect that ordering
        // by re-reading the live skill: if it now equals the patch body,
        // the write succeeded — surface an `applied` result tagged
        // `patchFileLingered` so the slash handler tells the operator to
        // clear the stale artifact (rather than reporting a flat failure
        // for an apply that actually happened).
        const lingered = await detectAppliedDespitePatchUnlinkFailure(
          agentName,
          patchId,
          phase99942PatchActionDepsRef.agentWorkspaceDir,
        );
        if (lingered) {
          logger.warn(
            {
              agent: agentName,
              patchId,
              err: err instanceof Error ? err.message : String(err),
            },
            "apply-skill-patch: patch applied but patch-file unlink failed (lingering)",
          );
          return lingered;
        }
        logger.error(
          {
            agent: agentName,
            patchId,
            err: err instanceof Error ? err.message : String(err),
          },
          "apply-skill-patch failed",
        );
        throw new ManagerError(
          `apply-skill-patch: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    case "reject-skill-patch": {
      const agentName = validateStringParam(params, "agent");
      const patchId = validateStringParam(params, "patchId");
      const reasonRaw = params.reason;
      const reason = typeof reasonRaw === "string" ? reasonRaw : undefined;
      if (!phase99942PatchActionDepsRef) {
        return { status: "not-found", reason: "patch-file-missing" };
      }
      try {
        return await rejectPatch(
          { agent: agentName, patchId, reason },
          phase99942PatchActionDepsRef,
        );
      } catch (err) {
        logger.error(
          {
            agent: agentName,
            patchId,
            err: err instanceof Error ? err.message : String(err),
          },
          "reject-skill-patch failed",
        );
        throw new ManagerError(
          `reject-skill-patch: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    case "set-model": {
      // Phase 86 Plan 02 MODEL-04 — delegate to the pure testable handler.
      // Live SDK swap fires FIRST (Plan 01 SessionHandle.setModel); atomic
      // clawcode.yaml persist follows via the v2.1 writer pipeline. The old
      // next-session deferral note is retired — the live handle now swaps
      // in-turn, and next-boot persistence is handled by updateAgentModel.
      return await handleSetModelIpc({
        manager,
        configs: configs as ResolvedAgentConfig[],
        configPath,
        params,
        // Phase 999.114 — the same live snapshot ref the session adapter reads,
        // so a `<family>@latest` live switch resolves to exactly what the next
        // spawn of that agent would resolve to.
        catalogSnapshot: getCatalogSnapshot,
        nowMs: () => Date.now(),
      });
    }

    case "costs": {
      const period = typeof params.period === "string" ? params.period : "today";
      const now = new Date();
      let since: Date;
      switch (period) {
        case "today":
          since = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          break;
        case "week": {
          const dayOfWeek = now.getDay();
          since = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek);
          break;
        }
        case "month":
          since = new Date(now.getFullYear(), now.getMonth(), 1);
          break;
        default:
          since = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      }
      const results: Array<{ agent: string; model: string; input_tokens: number; output_tokens: number; cost_usd: number }> = [];
      for (const agentName of manager.getRunningAgents()) {
        const tracker = manager.getUsageTracker(agentName);
        if (tracker) {
          const agentCosts = tracker.getCostsByAgentModel(since.toISOString(), now.toISOString());
          // CostByAgentModel uses `tokens_in/tokens_out`; the IPC wire shape
          // here uses `input_tokens/output_tokens`. Map field names rather
          // than push() the row directly.
          for (const row of agentCosts) {
            results.push({
              agent: row.agent,
              model: row.model,
              input_tokens: row.tokens_in,
              output_tokens: row.tokens_out,
              cost_usd: row.cost_usd,
            });
          }
        }
      }
      return { period, costs: results };
    }

    case "ingest-document": {
      // Phase 101 Plan 02 T04 — single ingestion entry point per
      // `feedback_silent_path_bifurcation`. Wires the Phase 101 ingestion
      // engine (`src/document-ingest/index.ts`) + optional structured
      // extraction (`extractStructured`) + atomic temp+rename writes to
      // `<workspace>/documents/<doc-slug>-<date>.{md,json}`.
      const agentName = validateStringParam(params, "agent");
      enforceAgentIdentity(params, agentName); // C3 — gate cross-agent access
      const filePath = validateStringParam(params, "file_path");
      const source =
        typeof params.source === "string" && params.source.length > 0
          ? params.source
          : filePath;
      const taskHintRaw = params.taskHint;
      const taskHint: TaskHint | undefined =
        taskHintRaw === "high-precision" || taskHintRaw === "standard"
          ? taskHintRaw
          : undefined;
      const extractRaw = params.extract;
      const extract: "text" | "structured" | "both" =
        extractRaw === "structured" || extractRaw === "both"
          ? extractRaw
          : "text";
      const schemaNameRaw = params.schemaName;
      const schemaName: ExtractionSchemaName =
        schemaNameRaw === "taxReturn" ? "taxReturn" : "taxReturn";
      const backendRaw = params.backend;
      const backend: OcrBackend | undefined =
        backendRaw === "tesseract-cli" ||
        backendRaw === "tesseract-wasm" ||
        backendRaw === "claude-haiku" ||
        backendRaw === "claude-sonnet" ||
        backendRaw === "mistral" ||
        backendRaw === "none"
          ? backendRaw
          : undefined;
      const force = params.force === true;

      const docStore = manager.getDocumentStore(agentName);
      if (!docStore) {
        throw new ManagerError(
          `Document store not found for agent '${agentName}' (agent may not be running)`,
        );
      }

      // T-101-08 mitigation — resolve file_path against the agent's
      // workspace root. Reject path traversal outside the workspace.
      // `path.relative` returns a string starting with `..` when the
      // resolved target is outside `workspaceRoot`.
      const agentConfig = configs.find((c) => c.name === agentName);
      const workspaceRoot = agentConfig?.workspace;
      const path = await import("node:path");
      if (workspaceRoot) {
        const resolvedTarget = path.resolve(filePath);
        const resolvedRoot = path.resolve(workspaceRoot);
        const rel = path.relative(resolvedRoot, resolvedTarget);
        if (
          rel.startsWith("..") ||
          path.isAbsolute(rel)
        ) {
          throw new ManagerError(
            `file_path '${filePath}' is outside agent workspace '${workspaceRoot}' — refused (T-101-08)`,
          );
        }
      }

      // C2 input-size guard — reject a runaway multi-GB input before it is
      // read/decoded wholesale (a single pathological ingest can balloon RSS).
      // Bounds one file, NOT cumulative session RSS (the fleet-kill itself is
      // a systemd OOMPolicy issue — see RUNBOOK). Runs AFTER the traversal
      // check so we only stat paths already confirmed inside the workspace.
      try {
        const inputStat = await stat(path.resolve(filePath));
        assertIngestSizeWithinLimit(
          inputStat.size,
          resolveIngestMaxInputBytes(),
          filePath,
          (message) => new ManagerError(message),
        );
      } catch (err) {
        if (err instanceof ManagerError) throw err;
        // stat failure (missing/unreadable) is left to the ingest engine to
        // surface with its richer error — don't mask it here.
      }

      // Compute docSlug + atomic-write target paths (Phase 96 pattern).
      // Phase 101 Plan 03 T03 — slug logic centralized in
      // `src/document-ingest/index.ts::computeDocSlug` so the daemon + the
      // cross-ingest seam derive identical slugs from the same filePath.
      const docSlug = computeDocSlug(filePath);
      const dateStr = new Date().toISOString().slice(0, 10);
      const docsDir = workspaceRoot
        ? path.join(workspaceRoot, "documents")
        : path.join(process.cwd(), "documents");
      const textMdPath = path.join(docsDir, `${docSlug}-${dateStr}.md`);
      const structuredJsonPath = path.join(
        docsDir,
        `${docSlug}-${dateStr}.json`,
      );

      // D-07 cache short-circuit: when force !== true AND a structured
      // JSON output exists with matching extractionSchemaVersion, return
      // the cached structured result without re-extracting.
      const fsPromises = await import("node:fs/promises");
      if (!force && (extract === "structured" || extract === "both")) {
        try {
          const cached = JSON.parse(
            await fsPromises.readFile(structuredJsonPath, "utf-8"),
          );
          if (cached?.extractionSchemaVersion === "v1") {
            logger.info(
              { docSlug, agent: agentName, cached: true },
              "phase101-ingest cache hit (force=false; D-07)",
            );
            return {
              ok: true,
              source,
              chunks_created: 0,
              total_chars: 0,
              structured: cached,
              paths: { textMd: textMdPath, structuredJson: structuredJsonPath },
              telemetry: { cached: true, docSlug, type: "cached" as const },
            };
          }
        } catch {
          // No cached file — fall through to full ingest.
        }
      }

      const fileBuffer = await readFile(filePath);

      // Run the Phase 101 engine to get text + telemetry. Pass the explicit
      // backend override (if provided) through; the engine forwards it to
      // ocrPage when image-bearing handlers fire.
      let ingestResult;
      try {
        ingestResult = await ingestDocumentEngine(fileBuffer, filePath, {
          taskHint,
          backend,
        });
      } catch (err) {
        // T05 — fail-mode alerts for the two engine-side terminal errors:
        // max-pages-exceeded (DoS guard) and mistral-disabled (D-08 gate).
        const msg = err instanceof Error ? err.message : String(err);
        if (/MAX_PAGES/.test(msg)) {
          await recordIngestAlert({
            docSlug,
            type: "unknown",
            reason: "max-pages-exceeded",
            severity: "error",
            agent: agentName,
          }).catch(() => {
            /* alerts never poison the ingest path */
          });
        } else if (/Mistral OCR backend disabled/.test(msg)) {
          await recordIngestAlert({
            docSlug,
            type: "unknown",
            reason: "mistral-disabled",
            severity: "error",
            agent: agentName,
          }).catch(() => {
            /* alerts never poison the ingest path */
          });
        }
        throw err;
      }
      // `backend` is now threaded through ingestDocumentEngine → ocrPage above.

      // Structured extraction (U4) when extract != 'text'.
      let structured: unknown | undefined;
      if (extract === "structured" || extract === "both") {
        try {
          structured = await extractStructured(
            ingestResult.text,
            schemaName,
            { taskHint },
          );
        } catch (err) {
          if (err instanceof DocIngestError) {
            // T05 — fail-mode alert (extraction-missing-required).
            const missingFields = (err as DocIngestError & {
              missingFields?: readonly string[];
            }).missingFields;
            await recordIngestAlert({
              docSlug,
              type: ingestResult.telemetry.type,
              reason: "extraction-missing-required",
              severity: "error",
              missingFields,
              agent: agentName,
            }).catch(() => {
              /* alerts never poison the ingest path */
            });
            throw new ManagerError(
              `structured extraction failed: ${err.message}`,
            );
          }
          throw err;
        }
      }

      // Atomic temp+rename writes (Phase 96 pattern). Skip when text is
      // empty (degenerate ingest case from text-only docs etc.).
      await fsPromises.mkdir(docsDir, { recursive: true });
      if (ingestResult.text.length > 0) {
        const tmpMd = `${textMdPath}.tmp-${process.pid}-${Date.now()}`;
        await fsPromises.writeFile(tmpMd, ingestResult.text, "utf-8");
        await fsPromises.rename(tmpMd, textMdPath);
      }
      if (structured !== undefined) {
        const tmpJson = `${structuredJsonPath}.tmp-${process.pid}-${Date.now()}`;
        await fsPromises.writeFile(
          tmpJson,
          JSON.stringify(structured, null, 2),
          "utf-8",
        );
        await fsPromises.rename(tmpJson, structuredJsonPath);
      }

      // Chunk + embed + persist into the DocumentStore (legacy contract
      // preserved). Prefer the engine's extracted text when present;
      // otherwise fall back to the legacy chunker for parity with the
      // pre-101 daemon behavior.
      const chunks =
        ingestResult.text.length > 0
          ? chunkText(ingestResult.text)
          : filePath.endsWith(".pdf")
            ? await chunkPdf(fileBuffer)
            : chunkText(fileBuffer.toString("utf-8"));

      if (chunks.length === 0) {
        const telemetryFull = {
          ...ingestResult.telemetry,
          chunksCreated: 0,
        };
        logIngest(telemetryFull, logger);
        return {
          ok: true,
          source,
          chunks_created: 0,
          total_chars: ingestResult.text.length,
          ...(structured !== undefined ? { structured } : {}),
          paths: {
            textMd: textMdPath,
            ...(structured !== undefined
              ? { structuredJson: structuredJsonPath }
              : {}),
          },
          telemetry: telemetryFull,
        };
      }

      const embedder = manager.getEmbedder();
      // CF-2 (Phase 101 D-09): document write path uses embedV2 (bge-small int8).
      // The vec_document_chunks vec0 table is int8[384] — Float32 embeddings
      // would fail the MATCH operator's type check.
      const embeddings: Int8Array[] = [];
      try {
        for (const chunk of chunks) {
          embeddings.push(await embedder.embedV2(chunk.content));
        }
      } catch (err) {
        // T05 — fail-mode alert (embedder-failure).
        await recordIngestAlert({
          docSlug,
          type: ingestResult.telemetry.type,
          reason: "embedder-failure",
          severity: "error",
          agent: agentName,
        }).catch(() => {
          /* alerts never poison the ingest path */
        });
        const msg = err instanceof Error ? err.message : String(err);
        throw new ManagerError(`embedder.embedV2 failed: ${msg}`);
      }

      const result = docStore.ingest(source, chunks, embeddings);

      // Phase 101 Plan 03 T03 (U6) — cross-ingest the document chunks into
      // the agent's memory_chunks pipeline so Phase 90 hybrid-RRF surfaces
      // them on subsequent operator turns. Failure here MUST NOT poison the
      // parent ingest (docStore.ingest already succeeded — the document IS
      // ingested; the memory mirror is a best-effort retrieval enhancement).
      let memoryChunksWritten = 0;
      let migrationPhaseAfter:
        | "v1-only"
        | "dual-write"
        | "v2-only"
        | undefined;
      try {
        const memoryStore = manager.getMemoryStore(agentName);
        if (!memoryStore) {
          throw new Error(
            `MemoryStore not found for agent '${agentName}' — skipping cross-ingest`,
          );
        }
        // P1-CROSSINGEST — crossIngest no longer embeds internally; precompute
        // v1 here (v2 is already computed above as `embeddings`). Index-aligned
        // with chunks. This manual operator path stays on the main thread (low
        // volume — it is NOT the burst path the embed worker exists for).
        const embeddingsV1: Float32Array[] = [];
        for (const chunk of chunks) {
          embeddingsV1.push(await embedder.embed(chunk.content));
        }
        const crossResult = await crossIngestToMemory({
          agent: agentName,
          docSlug,
          chunks: chunks.map((c, i) => ({ index: i, content: c.content })),
          precomputedV1: embeddingsV1,
          precomputedV2: embeddings,
          memoryStore,
          migrationPhaseStore: new MigrationPhaseStore(memoryStore, agentName),
        });
        memoryChunksWritten = crossResult.chunksWritten;
        migrationPhaseAfter = crossResult.migrationPhaseAfter;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          { docSlug, agent: agentName, err: msg },
          "phase101-ingest cross-ingest-failed",
        );
        // T05 — record as embedder-failure (closest available reason; the
        // cross-ingest path's actual failure modes are an embedV1/embedV2
        // throw or a SQLite write throw, both of which the embedder-failure
        // category covers semantically). Alerts never poison the ingest.
        await recordIngestAlert({
          docSlug,
          type: ingestResult.telemetry.type,
          reason: "embedder-failure",
          severity: "error",
          agent: agentName,
        }).catch(() => {
          /* alerts never poison the ingest path */
        });
      }

      const telemetryFull = {
        ...ingestResult.telemetry,
        chunksCreated: result.chunksCreated,
        memoryChunksWritten,
        ...(migrationPhaseAfter !== undefined ? { migrationPhaseAfter } : {}),
      };
      logIngest(telemetryFull, logger);
      return {
        ok: true,
        source,
        chunks_created: result.chunksCreated,
        total_chars: result.totalChars,
        ...(structured !== undefined ? { structured } : {}),
        paths: {
          textMd: textMdPath,
          ...(structured !== undefined
            ? { structuredJson: structuredJsonPath }
            : {}),
        },
        telemetry: telemetryFull,
      };
    }

    case "auto-ingest-attachment": {
      // P1-INGESTQ — enqueue-and-ACK. Validate IPC params, hand to the bounded
      // never-drop queue (deps wired once at boot via autoIngestQueue.init), and
      // return IMMEDIATELY ({queued, queueDepth} or {deferred} at the cap)
      // instead of awaiting the 40-57 s handler. This closes the loopback-IPC-
      // socket-exhaustion vector — each socket now closes in µs, never held open
      // 40-57 s. The queue drains serially through the image-work governor and
      // calls handleAutoIngestAttachment for each item.
      //
      // SINGLE auto-ingest entry point per feedback_silent_path_bifurcation.md.
      // Manual `ingest-document` case above remains the operator-driven path.
      const agentName = validateStringParam(params, "agent");
      const filePath = validateStringParam(params, "file_path");
      const filename = validateStringParam(params, "filename");
      const channelId = validateStringParam(params, "channel_id");
      const messageId = validateStringParam(params, "message_id");
      const userId = validateStringParam(params, "user_id");
      const userName = validateStringParam(params, "user_name");
      const mimeType =
        typeof params.mime_type === "string" && params.mime_type.length > 0
          ? params.mime_type
          : null;
      const size = typeof params.size === "number" ? params.size : 0;
      const visionAnalysis =
        typeof params.vision_analysis === "string" &&
        params.vision_analysis.length > 0
          ? params.vision_analysis
          : null;

      return autoIngestQueue.enqueue({
        agent: agentName,
        file_path: filePath,
        filename,
        mime_type: mimeType,
        size,
        vision_analysis: visionAnalysis,
        channel_id: channelId,
        message_id: messageId,
        user_id: userId,
        user_name: userName,
      });
    }

    // Phase 999.43 Plan 04 T01 — single set-doc-priority write surface.
    // Two entrypoints (by source + by message_id) and one bulk variant
    // delegate to handlers in `src/manager/set-doc-priority-handler.ts`.
    // D-08 sandbox + Phase 90 isolation enforced in the handler — agents
    // cannot escalate own doc beyond MEDIUM; agents cannot mutate docs
    // they did not ingest. Audit log at `${memoryPath}/audit-priority-
    // changes.jsonl` (writeAuditLog inside the handler). All runtime log
    // lines from this path carry tag `phase999.43-priority` (grep target
    // for `journalctl -u clawcode -g phase999.43-priority`).
    case "set-doc-priority": {
      const { handleSetDocPriority } = await import(
        "./set-doc-priority-handler.js"
      );
      const agentName = validateStringParam(params, "agent");
      enforceAgentIdentity(params, agentName); // C3 — gate cross-agent access
      const source = validateStringParam(params, "source");
      const levelRaw = validateStringParam(params, "level");
      if (levelRaw !== "high" && levelRaw !== "medium" && levelRaw !== "low") {
        throw new ManagerError(`invalid level '${levelRaw}'`);
      }
      const whoRaw = typeof params.who === "string" ? params.who : "operator";
      const who: "operator" | "agent" =
        whoRaw === "agent" ? "agent" : "operator"; // default operator
      const callerAgent =
        typeof params.callerAgent === "string" ? params.callerAgent : undefined;
      const reason =
        typeof params.reason === "string" ? params.reason : undefined;

      return await handleSetDocPriority(
        { agent: agentName, source, level: levelRaw, who, callerAgent, reason },
        {
          getDocumentStore: (a) => manager.getDocumentStore(a),
          getAgentMemoryPath: (a) =>
            configs.find((c) => c.name === a)?.memoryPath,
          logger,
        },
      );
    }

    case "set-doc-priority-by-message": {
      const { handleSetDocPriorityByMessage } = await import(
        "./set-doc-priority-handler.js"
      );
      const agentName = validateStringParam(params, "agent");
      const messageId = validateStringParam(params, "message_id");
      const levelRaw = validateStringParam(params, "level");
      if (levelRaw !== "high" && levelRaw !== "medium" && levelRaw !== "low") {
        throw new ManagerError(`invalid level '${levelRaw}'`);
      }
      const whoRaw = typeof params.who === "string" ? params.who : "operator";
      const who: "operator" | "agent" =
        whoRaw === "agent" ? "agent" : "operator";
      const callerAgent =
        typeof params.callerAgent === "string" ? params.callerAgent : undefined;
      const reason =
        typeof params.reason === "string" ? params.reason : undefined;

      return await handleSetDocPriorityByMessage(
        {
          agent: agentName,
          message_id: messageId,
          level: levelRaw,
          who,
          callerAgent,
          reason,
        },
        {
          getDocumentStore: (a) => manager.getDocumentStore(a),
          getAgentMemoryPath: (a) =>
            configs.find((c) => c.name === a)?.memoryPath,
          logger,
        },
      );
    }

    case "reclassify-docs": {
      const { handleReclassifyDocs } = await import(
        "./set-doc-priority-handler.js"
      );
      const agentName = validateStringParam(params, "agent");
      const rule = validateStringParam(params, "rule");
      // CLI-only entry point — `who` is always "operator" regardless of
      // what the caller sends. Keeps the audit-trail discriminator honest.
      return await handleReclassifyDocs(
        { agent: agentName, rule, who: "operator" },
        {
          getDocumentStore: (a) => manager.getDocumentStore(a),
          getAgentMemoryPath: (a) =>
            configs.find((c) => c.name === a)?.memoryPath,
          logger,
        },
      );
    }


    case "search-documents": {
      const agentName = validateStringParam(params, "agent");
      enforceAgentIdentity(params, agentName); // C3 — gate cross-agent access
      const query = validateStringParam(params, "query");
      const limit = typeof params.limit === "number" ? Math.min(Math.max(params.limit, 1), 20) : 5;
      const source = typeof params.source === "string" && params.source.length > 0 ? params.source : undefined;

      const docStore = manager.getDocumentStore(agentName);
      if (!docStore) {
        throw new ManagerError(`Document store not found for agent '${agentName}' (agent may not be running)`);
      }

      const embedder = manager.getEmbedder();
      // CF-2 (Phase 101 D-09): search-documents query embedding must match
      // the int8[384] vec_document_chunks column the write path now produces.
      // Rule 3 deviation: plan named only the write path at line 11011, but
      // leaving search on Float32 .embed() would break every search call
      // post-migration. Documented in 101-01-SUMMARY.md.
      const queryEmbedding = await embedder.embedV2(query);

      // Phase 999.43 Plan 03 — D-01 axis 1 (agent priority) LOCKED VERBATIM:
      //   high: 1.5, medium: 1.0, low: 0.7
      // Resolved LIVE from the agent's current `ingestionPriority` config
      // value (not the snapshotted agent_priority_weight_at_ingest column)
      // so `clawcode reload` takes effect immediately per Plan 01 SUMMARY
      // hot-reload promise. The DocumentStore applies the D-02 score formula
      // (similarity × agentWeight × contentWeight × recencyBoost) — see
      // src/documents/store.ts `search` method.
      const SEARCH_AGENT_PRIORITY_WEIGHTS = {
        high: 1.5,
        medium: 1.0,
        low: 0.7,
      } as const;
      const searchAgentConfig = configs.find((c) => c.name === agentName);
      const searchAgentPriority =
        searchAgentConfig?.ingestionPriority ?? "medium";
      const searchAgentWeight =
        SEARCH_AGENT_PRIORITY_WEIGHTS[searchAgentPriority];

      const results = docStore.search(
        queryEmbedding,
        limit,
        source,
        searchAgentWeight,
      );

      return {
        results: results.map((r) => ({
          chunk_id: r.chunkId,
          source: r.source,
          chunk_index: r.chunkIndex,
          content: r.content,
          similarity: r.similarity,
          // Phase 999.43 Plan 03 — additive payload fields (MCP consumer at
          // server.ts:1220-1234 ignores unknown fields; legacy clients see
          // identical `similarity` shape).
          weighted_score: r.weightedScore,
          recency_boost_applied: r.recencyBoostApplied,
          context_before: r.contextBefore,
          context_after: r.contextAfter,
          // Phase 999.43-fu2 Path A T03 — additive surface for image
          // attachments. Only present when the underlying documents row
          // has a non-NULL source_image_path (image MIME at ingest time);
          // omitted on the wire for PDF/docx/etc. ingests.
          ...(r.sourceImagePath ? { source_image_path: r.sourceImagePath } : {}),
        })),
      };
    }

    case "delete-document": {
      const agentName = validateStringParam(params, "agent");
      enforceAgentIdentity(params, agentName); // C3 — gate cross-agent access
      const source = validateStringParam(params, "source");

      const docStore = manager.getDocumentStore(agentName);
      if (!docStore) {
        throw new ManagerError(`Document store not found for agent '${agentName}' (agent may not be running)`);
      }

      const count = docStore.deleteDocument(source);
      return { ok: true, source, chunks_deleted: count };
    }

    case "list-documents": {
      const agentName = validateStringParam(params, "agent");
      enforceAgentIdentity(params, agentName); // C3 — gate cross-agent access

      const docStore = manager.getDocumentStore(agentName);
      if (!docStore) {
        throw new ManagerError(`Document store not found for agent '${agentName}' (agent may not be running)`);
      }

      const sources = docStore.listSources();
      const totalChunks = docStore.getChunkCount();
      return { sources: [...sources], total_chunks: totalChunks };
    }

    case "message-history": {
      const agentName = validateStringParam(params, "agent");
      const limit = typeof params.limit === "number" ? params.limit : 50;
      const date = typeof params.date === "string" ? params.date : undefined;

      const config = configs.find(c => c.name === agentName);
      if (!config) {
        return { messages: [], dates: [] };
      }

      // Phase 75 SHARED-01 — memoryPath (not workspace) so the health-log
      // CLI reader loads each agent's private heartbeat.log / digests.
      const memoryDir = join(config.memoryPath, "memory");
      const { readdir, readFile } = await import("node:fs/promises");

      let logFiles: string[] = [];
      try {
        const files = await readdir(memoryDir);
        logFiles = files
          .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
          .sort()
          .reverse();
      } catch { /* no logs yet */ }

      const dates = logFiles.map(f => f.replace(".md", ""));
      const targetDate = date ?? dates[0];
      if (!targetDate) {
        return { messages: [], dates };
      }

      const filePath = join(memoryDir, `${targetDate}.md`);
      let content = "";
      try {
        content = await readFile(filePath, "utf-8");
      } catch {
        return { messages: [], dates };
      }

      const messages: Array<{ time: string; role: string; content: string }> = [];
      const sections = content.split(/^## /m).filter(Boolean);
      for (const section of sections) {
        const match = section.match(/^(\d{2}:\d{2}:\d{2})\s+\[(user|assistant)\]\n([\s\S]*)/);
        if (match) {
          messages.push({
            time: match[1],
            role: match[2],
            content: match[3].trim(),
          });
        }
      }

      const trimmed = messages.slice(-limit);
      return { messages: trimmed, dates, currentDate: targetDate };
    }

    case "read-thread": {
      const threadId = validateStringParam(params, "threadId");
      const limit = typeof params.limit === "number"
        ? Math.max(1, Math.min(100, Math.floor(params.limit)))
        : 20;

      const bridge = discordBridgeRef.current;
      if (!bridge) {
        throw new ManagerError("Discord bridge not available");
      }
      const channel = await bridge.discordClient.channels.fetch(threadId);
      if (!channel || !channel.isThread()) {
        throw new ManagerError(`Channel '${threadId}' is not a Discord thread`);
      }

      const collection = await channel.messages.fetch({ limit });
      const messages = [...collection.values()]
        .map((m) => {
          const embedContent = m.embeds?.[0]?.description;
          const embedFooter = m.embeds?.[0]?.footer?.text;
          return {
            id: m.id,
            author: m.author.username,
            authorId: m.author.id,
            bot: m.author.bot,
            webhookId: m.webhookId ?? null,
            content: m.content || embedContent || "",
            embedFooter: embedFooter ?? null,
            createdAt: m.createdAt.toISOString(),
            attachmentCount: m.attachments.size,
          };
        })
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

      return {
        threadId,
        threadName: "name" in channel ? channel.name : null,
        messageCount: messages.length,
        messages,
      };
    }

    case "memory-save": {
      const agentName = validateStringParam(params, "agent");
      enforceAgentIdentity(params, agentName); // C3 — gate cross-agent access
      const content = validateStringParam(params, "content");
      const tags = Array.isArray(params.tags) ? params.tags as string[] : [];
      const importance = typeof params.importance === "number" ? params.importance : 0.7;

      // Phase 999.131 — `scope: "owner"` writes to the fleet shared-facts
      // store under the agent's OWN configured owner (never a parameter).
      if (params.scope === "owner") {
        const owner =
          manager.getAgentConfig(agentName)?.owner ??
          configs.find((c) => c.name === agentName)?.owner;
        if (!owner) {
          throw new ManagerError(
            `Agent '${agentName}' has no owner configured; owner-scoped facts need an 'owner:' in clawcode.yaml`,
          );
        }
        const shared = manager.getSharedFactsStore();
        if (!shared) {
          throw new ManagerError("shared-facts store is not available on this daemon");
        }
        const sharedEmbedding = await manager.getEmbedder().embed(content);
        const saved = shared.save({ owner, content, tags, importance, sourceAgent: agentName }, sharedEmbedding);
        logger.info(
          { agent: agentName, owner, action: saved.action, factId: saved.fact.id },
          "owner-scoped fact saved",
        );
        return { id: saved.fact.id, scope: "owner", owner, action: saved.action };
      }

      const store = manager.getMemoryStore(agentName);
      if (!store) {
        throw new ManagerError(`Memory store not found for agent '${agentName}' (agent may not be running)`);
      }

      const embedder = manager.getEmbedder();
      const embedding = await embedder.embed(content);
      // Memory overhaul 2026-10-25 (WP5) - report what dedup did so the
      // agent is told the truth: "created", "duplicate" (nothing stored,
      // `id` is the existing memory) or "superseded" (new row stored, the
      // older near-duplicate `supersedes` is now hidden from search).
      const outcome = store.insertWithStatus(
        { content, source: "conversation", importance, tags },
        embedding,
      );
      return {
        id: outcome.entry.id,
        status: outcome.status,
        ...(outcome.supersedes ? { supersedes: outcome.supersedes } : {}),
      };
    }

    // ── Phase 115 sub-scope 7 — lazy-load memory tools ─────────────────
    //
    // The four MCP tool handlers. Each resolves the agent context via
    // `validateStringParam(params, "agent")` (mirrors memory-save / memory-
    // lookup), then dispatches to the pure tool function with the per-
    // agent MemoryStore. Cross-agent isolation is enforced at this
    // resolution layer.
    case "clawcode-memory-search": {
      const agentName = validateStringParam(params, "agent");
      enforceAgentIdentity(params, agentName); // C3 — gate cross-agent access
      // Phase 115 Plan 05 T04 — lazy_recall_call_count writer. Increment
      // FIRST so observability is recorded even if the handler throws on
      // an unknown agent or empty store. Best-effort — TraceCollector
      // method is missing on legacy daemons, hence the typeof guard
      // (mirrors session-config.ts recordTier1TruncationEvent pattern).
      const tcSearch = manager.getTraceCollector(agentName) as
        | (TraceCollector & {
            recordLazyRecallCall?: (agent: string, tool: string) => void;
          })
        | undefined;
      if (tcSearch && typeof tcSearch.recordLazyRecallCall === "function") {
        tcSearch.recordLazyRecallCall(agentName, "clawcode_memory_search");
      }

      const query = validateStringParam(params, "query");
      const k = typeof params.k === "number" ? params.k : 10;
      const includeTags = Array.isArray(params.includeTags)
        ? (params.includeTags as string[])
        : undefined;
      const excludeTags = Array.isArray(params.excludeTags)
        ? (params.excludeTags as string[])
        : undefined;

      const store = manager.getMemoryStore(agentName);
      if (!store) {
        throw new ManagerError(
          `Memory store not found for agent '${agentName}' (agent may not be running)`,
        );
      }
      const embedder = manager.getEmbedder();
      const lazyLoadLog = logger.child({ component: "clawcode-memory-search" });

      // Phase 999.187 — owner facts ride into the lazy search (owner from
      // the agent's OWN config; shared store may be absent on old daemons).
      const searchOwner =
        manager.getAgentConfig(agentName)?.owner ?? configs.find((c) => c.name === agentName)?.owner;
      const sharedForSearch = manager.getSharedFactsStore();
      const ownerFacts =
        searchOwner && sharedForSearch
          ? { store: sharedForSearch, owner: searchOwner, embed: (t: string) => embedder.embed(t) }
          : undefined;
      const result = await clawcodeMemorySearch(
        { query, k, includeTags, excludeTags },
        { store, embedder, agentName, log: lazyLoadLog, ownerFacts },
      );
      return result;
    }

    case "clawcode-memory-recall": {
      const agentName = validateStringParam(params, "agent");
      enforceAgentIdentity(params, agentName); // C3 — gate cross-agent access
      // Phase 115 Plan 05 T04 — lazy_recall_call_count writer.
      const tcRecall = manager.getTraceCollector(agentName) as
        | (TraceCollector & {
            recordLazyRecallCall?: (agent: string, tool: string) => void;
          })
        | undefined;
      if (tcRecall && typeof tcRecall.recordLazyRecallCall === "function") {
        tcRecall.recordLazyRecallCall(agentName, "clawcode_memory_recall");
      }

      const memoryId = validateStringParam(params, "memoryId");

      const store = manager.getMemoryStore(agentName);
      if (!store) {
        throw new ManagerError(
          `Memory store not found for agent '${agentName}' (agent may not be running)`,
        );
      }

      // Memory overhaul 2026-10-25 (WP5) - `shared:<id>` hits from search
      // are recallable. Owner from the agent's OWN config, same as search.
      const recallOwner =
        manager.getAgentConfig(agentName)?.owner ?? configs.find((c) => c.name === agentName)?.owner;
      const sharedForRecall = manager.getSharedFactsStore();
      const recallOwnerFacts =
        recallOwner && sharedForRecall ? { store: sharedForRecall, owner: recallOwner } : undefined;

      const result = await clawcodeMemoryRecall(
        { memoryId },
        { store, agentName, ownerFacts: recallOwnerFacts },
      );
      return result;
    }

    case "clawcode-memory-edit": {
      const agentName = validateStringParam(params, "agent");
      enforceAgentIdentity(params, agentName); // C3 — gate cross-agent access
      // Phase 115 Plan 05 T04 — lazy_recall_call_count writer.
      const tcEdit = manager.getTraceCollector(agentName) as
        | (TraceCollector & {
            recordLazyRecallCall?: (agent: string, tool: string) => void;
          })
        | undefined;
      if (tcEdit && typeof tcEdit.recordLazyRecallCall === "function") {
        tcEdit.recordLazyRecallCall(agentName, "clawcode_memory_edit");
      }

      const path = validateStringParam(params, "path") as "MEMORY.md" | "USER.md";
      const mode = validateStringParam(params, "mode") as
        | "view"
        | "create"
        | "str_replace"
        | "append";
      const oldStr = typeof params.oldStr === "string" ? params.oldStr : undefined;
      const newStr = typeof params.newStr === "string" ? params.newStr : undefined;
      const content = typeof params.content === "string" ? params.content : undefined;

      const cfg = manager.getAgentConfig(agentName) ?? configs.find((a) => a.name === agentName);
      const memoryRoot = cfg ? resolveMemoryRoots(cfg).tier1Dir : ""; // Phase 999.187 — same dir the prompt loads
      if (memoryRoot.length === 0) {
        throw new ManagerError(
          `Memory root not found for agent '${agentName}' (agent may not be configured)`,
        );
      }

      const editLog = logger.child({ component: "clawcode-memory-edit" });
      const result = await clawcodeMemoryEdit(
        { path, mode, oldStr, newStr, content },
        {
          memoryRoot,
          agentName,
          log: {
            warn: (obj, msg) => editLog.warn(obj, msg),
            error: (obj, msg) => editLog.error(obj, msg),
          },
        },
      );
      return result;
    }

    case "clawcode-memory-archive": {
      const agentName = validateStringParam(params, "agent");
      enforceAgentIdentity(params, agentName); // C3 — gate cross-agent access
      // Phase 115 Plan 05 T04 — lazy_recall_call_count writer.
      const tcArchive = manager.getTraceCollector(agentName) as
        | (TraceCollector & {
            recordLazyRecallCall?: (agent: string, tool: string) => void;
          })
        | undefined;
      if (tcArchive && typeof tcArchive.recordLazyRecallCall === "function") {
        tcArchive.recordLazyRecallCall(agentName, "clawcode_memory_archive");
      }

      const chunkId = validateStringParam(params, "chunkId");
      const targetPath = validateStringParam(params, "targetPath") as
        | "MEMORY.md"
        | "USER.md";
      const wrappingPrefix =
        typeof params.wrappingPrefix === "string" ? params.wrappingPrefix : undefined;
      const wrappingSuffix =
        typeof params.wrappingSuffix === "string" ? params.wrappingSuffix : undefined;

      const store = manager.getMemoryStore(agentName);
      if (!store) {
        throw new ManagerError(
          `Memory store not found for agent '${agentName}' (agent may not be running)`,
        );
      }
      const cfg = manager.getAgentConfig(agentName) ?? configs.find((a) => a.name === agentName);
      const memoryRoot = cfg ? resolveMemoryRoots(cfg).tier1Dir : ""; // Phase 999.187 — same dir the prompt loads
      if (memoryRoot.length === 0) {
        throw new ManagerError(
          `Memory root not found for agent '${agentName}' (agent may not be configured)`,
        );
      }

      const archiveLog = logger.child({ component: "clawcode-memory-archive" });
      const result = await clawcodeMemoryArchive(
        { chunkId, targetPath, wrappingPrefix, wrappingSuffix },
        {
          store,
          memoryRoot,
          agentName,
          log: {
            info: (obj, msg) => archiveLog.info(obj, msg),
            warn: (obj, msg) => archiveLog.warn(obj, msg),
            error: (obj, msg) => archiveLog.error(obj, msg),
          },
        },
      );
      return result;
    }

    // ── Memory overhaul 2026-10-25 (WP5) - corrections on saved memories ──
    //
    // forget retires a row (superseded_by = "forgotten"); update inserts the
    // corrected content and marks the old row superseded by it. Nothing is
    // deleted. Same per-agent resolution and C3 identity gate as the four
    // lazy-load tools above.
    case "clawcode-memory-forget": {
      const agentName = validateStringParam(params, "agent");
      enforceAgentIdentity(params, agentName); // C3: gate cross-agent access
      const id = validateStringParam(params, "id");
      const reason = validateStringParam(params, "reason");

      const store = manager.getMemoryStore(agentName);
      if (!store) {
        throw new ManagerError(
          `Memory store not found for agent '${agentName}' (agent may not be running)`,
        );
      }

      const { clawcodeMemoryForget } = await import("../memory/tools/clawcode-memory-forget.js");
      const forgetLog = logger.child({ component: "clawcode-memory-forget" });
      return clawcodeMemoryForget(
        { id, reason },
        { store, agentName, log: { info: (obj, msg) => forgetLog.info(obj, msg) } },
      );
    }

    case "clawcode-memory-update": {
      const agentName = validateStringParam(params, "agent");
      enforceAgentIdentity(params, agentName); // C3: gate cross-agent access
      const id = validateStringParam(params, "id");
      const content = validateStringParam(params, "content");
      const tags = Array.isArray(params.tags) ? (params.tags as string[]) : undefined;

      const store = manager.getMemoryStore(agentName);
      if (!store) {
        throw new ManagerError(
          `Memory store not found for agent '${agentName}' (agent may not be running)`,
        );
      }

      const { clawcodeMemoryUpdate } = await import("../memory/tools/clawcode-memory-update.js");
      const embedder = manager.getEmbedder();
      const updateLog = logger.child({ component: "clawcode-memory-update" });
      return clawcodeMemoryUpdate(
        { id, content, ...(tags ? { tags } : {}) },
        {
          store,
          agentName,
          embed: (text: string) => embedder.embed(text),
          log: { info: (obj, msg) => updateLog.info(obj, msg) },
        },
      );
    }

    case "memory-graph": {
      // Phase 999.8 Plan 01 — body extracted into a pure helper so the
      // optional `limit` param contract (default 5000, range [1, 50000])
      // is unit-testable without standing up a full MemoryStore. Mirrors
      // the handleSetModelIpc / invokeMemoryLookup extraction pattern.
      const agentName = validateStringParam(params, "agent");
      enforceAgentIdentity(params, agentName); // C3 — gate cross-agent access
      const store = manager.getMemoryStore(agentName);
      if (!store) {
        return { nodes: [], links: [] };
      }
      return handleMemoryGraphIpc(params, store.getDatabase());
    }

    case "tier-maintenance-tick": {
      // Phase 999.8 follow-up (2026-04-30) — operator-triggered tier
      // backfill. When `agent` is set, runs maintenance for that one agent.
      // When omitted, runs maintenance for every agent that has a
      // TierManager (the natural set: agents with memory). Returns the
      // per-agent {promoted, demoted, archived} counts so the CLI can
      // print a one-line summary. Heartbeat-driven tier-maintenance
      // (every 6h) still runs unaffected — this is purely an on-demand
      // shortcut so a fresh deploy doesn't have to wait for the first tick.
      const agentParam = typeof params.agent === "string" ? params.agent : undefined;
      const targetNames: readonly string[] = agentParam
        ? [agentParam]
        : Array.from(manager.tierManagerNames());
      const results: Record<
        string,
        {
          promoted: number;
          demoted: number;
          archived: number;
          rewarmed: number;
          errors: number;
          firstError: string | null;
        }
      > = {};
      const skipped: string[] = [];
      for (const name of targetNames) {
        const tm = manager.getTierManager(name);
        if (!tm) {
          skipped.push(name);
          continue;
        }
        const r = tm.runMaintenance();
        results[name] = {
          promoted: r.promoted,
          demoted: r.demoted,
          archived: r.archived,
          rewarmed: r.rewarmed,
          errors: r.errors,
          firstError: r.firstError,
        };
      }
      return { results, skipped };
    }

    case "agent-create": {
      const name = validateStringParam(params, "name");
      const soul = validateStringParam(params, "soul");
      const parentChannelId = validateStringParam(params, "parentChannelId");
      const invokerUserId = validateStringParam(params, "invokerUserId");
      const model = typeof params.model === "string" ? params.model : undefined;

      const adminIds = (process.env.CLAWCODE_ADMIN_DISCORD_USER_IDS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (adminIds.length === 0 || !adminIds.includes(invokerUserId)) {
        throw new ManagerError("Not authorized to create agents");
      }

      const bridge = discordBridgeRef.current;
      if (!bridge) {
        throw new ManagerError("Discord bridge not available");
      }
      const client = bridge.discordClient;

      const parent = await client.channels.fetch(parentChannelId);
      if (!parent || parent.type !== ChannelType.GuildText) {
        throw new ManagerError("Invocation channel is not a guild text channel");
      }
      const guild = (parent as TextChannel).guild;
      const categoryId = (parent as TextChannel).parentId ?? undefined;
      const category = categoryId
        ? ((await client.channels.fetch(categoryId).catch(() => null)) as CategoryChannel | null)
        : null;

      const newChannel = await guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parent: category?.id ?? null,
        topic: `ClawCode agent: ${name}`,
      });

      try {
        const result = await provisionAgent(
          { name, soul, model, channelId: newChannel.id },
          { configPath, agentsBasePath },
        );
        return {
          ok: true,
          name: result.name,
          model: result.model,
          channelId: newChannel.id,
          channelUrl: `https://discord.com/channels/${guild.id}/${newChannel.id}`,
          workspace: result.workspace,
        };
      } catch (err) {
        await (newChannel as GuildTextBasedChannel).delete(`agent-create failed: ${(err as Error).message}`).catch(() => {});
        throw err;
      }
    }

    // Phase 59 — cross-agent RPC / handoff IPC cases
    case "delegate-task": {
      const caller = validateStringParam(params, "caller");
      const target = validateStringParam(params, "target");
      const schema = validateStringParam(params, "schema");
      const payload = params.payload;
      const deadline_ms = typeof params.deadline_ms === "number" ? params.deadline_ms : undefined;
      const budgetOwner = typeof params.budgetOwner === "string" ? params.budgetOwner : undefined;
      const parentTaskId = typeof params.parent_task_id === "string" ? params.parent_task_id : undefined;
      try {
        const delegateResult = await taskManager.delegate({ caller, target, schema, payload, deadline_ms, budgetOwner, parentTaskId });
        // Phase 132-fu2 — task.completed emit MOVED to the `task-complete`
        // IPC handler below (case "task-complete"). At delegate DISPATCH time
        // `taskManager.delegate` has only inserted a "pending" row + fired a
        // fire-and-forget `void turnDispatcher.dispatch(...)` (HAND-01
        // async-ticket, src/tasks/task-manager.ts:318-326). The target's
        // TraceCollector has not started a turn yet, so emitting here would
        // always produce `{trajectory:[], durationMs:0}` and the eligibility
        // filter would always reject on `too-few-tool-calls` — exactly the
        // silent-path-bifurcation pattern MEMORY.md flags. The emit now lives
        // in the `task-complete` IPC handler where `completeTask()` runs
        // AFTER the target's Turn has written its trace row.
        //
        // Silent-path-bifurcation invariant after fu2:
        //   exactly 2 emitTaskCompletedEvent(...) call sites in daemon.ts —
        //   one at subagent-complete (~line 6319) and one at task-complete
        //   (~line 12488). The dispatch-site emit is GONE.
        return delegateResult;
      } catch (err) {
        // Quick 260511-pw3 — translate ValidationError("unknown_schema")
        // into a JSON-RPC error whose `data` carries the target's accepted
        // schemas list. The IPC server forwards `error.data` to the wire
        // (src/ipc/server.ts:121-124). MCP wrapper at delegate_task renders
        // this list so the sender's LLM can retry with a valid schema
        // instead of falling back to post_to_agent (which has its own
        // silent-drop class of bug — quick 260511-pw2).
        const { ValidationError } = await import("../tasks/errors.js");
        if (err instanceof ValidationError && err.reason === "unknown_schema") {
          const acceptedSchemas = taskManager.acceptedSchemasForTarget(target);
          throw new ManagerError(err.message, {
            // -32602 = Invalid params (JSON-RPC standard).
            code: -32602,
            data: {
              reason: "unknown_schema",
              schema,
              target,
              acceptedSchemas,
            },
          });
        }
        throw err;
      }
    }

    case "list-agent-schemas": {
      // Quick 260511-pw3 — schema introspection. Returns the target's
      // accepted schemas with `callerAllowed` and `registered` flags so
      // the sender's LLM can choose a valid schema before calling
      // `delegate_task`. Fixes the discovery gap that drove Admin Clawdy's
      // 2026-05-11 `bug.report` rejection (RESEARCH.md "where do agents
      // declare what they accept").
      const caller = validateStringParam(params, "caller");
      const target = validateStringParam(params, "target");
      const targetConfig = configs.find((c) => c.name === target);
      if (!targetConfig) {
        throw new ManagerError(`Target agent '${target}' not found`);
      }
      const schemas = taskManager.listSchemasForAgent(caller, target);
      return { target, caller, schemas };
    }
    case "task-status": {
      const task_id = validateStringParam(params, "task_id");
      // Phase 999.165 — agents reached for task tools with a workflow id.
      if (isWorkflowId(task_id)) throw new ManagerError(workflowIdTaskHint(task_id));
      return taskManager.getStatus(task_id);
    }
    case "cancel-task": {
      const task_id = validateStringParam(params, "task_id");
      if (isWorkflowId(task_id)) throw new ManagerError(workflowIdTaskHint(task_id));
      const caller = validateStringParam(params, "caller");
      await taskManager.cancel(task_id, caller);
      return { ok: true };
    }
    case "task-complete": {
      const task_id = validateStringParam(params, "task_id");
      const result = params.result;
      const chain_token_cost = typeof params.chain_token_cost === "number" ? params.chain_token_cost : 0;
      // Phase 132-fu2 — capture target_agent BEFORE completeTask, so we have
      // it for the post-completion emit even though completeTask itself does
      // not return it. If the row is missing here, completeTask will throw
      // TaskNotFoundError below and we never emit (correct: no completion).
      const rowForEmit = taskStore.get(task_id);
      await taskManager.completeTask(task_id, result, chain_token_cost);
      // Phase 132-fu2 — task.completed emit at the TRUE terminal site.
      // `completeTask()` has just transitioned the row to "complete" and
      // returned, which means the target agent's Turn ran to completion and
      // its TraceStore has the per-turn trace row keyed by the task_id (the
      // target's turnId for this delegated turn is `task:<nanoid>` —
      // verified against TURN_ID_REGEX in src/manager/turn-origin.ts:60).
      //
      // Hardcoded outcome="success" is correct for this IPC handler — the
      // task-complete path only fires on success. Failed/cancelled/timed_out
      // transitions go through other handlers (cancel-task, handleDispatchError,
      // task timeout) which deliberately do NOT emit (no skill to distill
      // from a failed task).
      //
      // Silent-path-bifurcation invariant: exactly 2 emit sites in daemon.ts
      //   — subagent-complete (~line 6319) + this site. The delegate-task
      //   dispatch site emit was REMOVED in fu2.
      if (phase132EmitterDepsRef && rowForEmit) {
        try {
          const target = rowForEmit.target_agent;
          const view = manager.getTrajectoryForTurnId(target, task_id);
          const trajectory = view?.trajectory ?? [];
          const durationMs = view?.durationMs ?? 0;
          emitTaskCompletedEvent(phase132EmitterDepsRef, {
            agent: target,
            sessionId: task_id,
            trajectory,
            durationMs,
            toolCallCount: trajectory.length,
            outcome: "success",
          });
        } catch (emitErr) {
          logger.error(
            { agent: rowForEmit.target_agent, task_id, err: (emitErr as Error).message },
            "phase132 task.completed emit failed (task-complete site)",
          );
        }
      }
      return { ok: true };
    }
    case "task-retry": {
      const task_id = validateStringParam(params, "task_id");
      const response = await taskManager.retry(task_id);
      return response;
    }

    case "list-tasks": {
      const now = Date.now();
      const recentWindowMs = 30_000; // Show completed tasks for 30s
      const rows = taskStore.rawDb.prepare(
        `SELECT task_id, caller_agent, target_agent, status, started_at, ended_at, chain_token_cost
         FROM tasks
         WHERE status IN ('pending','running','awaiting_input')
            OR (ended_at > ? AND status IN ('complete','failed','cancelled','timed_out','orphaned'))
         ORDER BY started_at DESC`
      ).all(now - recentWindowMs);
      return { tasks: rows };
    }

    default:
      throw new ManagerError(`Unknown method: ${method}`);
  }
}

/**
 * Validate and extract a required string parameter.
 */
function validateStringParam(
  params: Record<string, unknown>,
  key: string,
): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ManagerError(`Missing required parameter: ${key}`);
  }
  return value;
}

/**
 * Phase 999.42 Plan 06 — write-then-unlink edge detector for apply-skill-patch.
 *
 * `applyPatch` (skill-patch-actions.ts) writes `skills/<slug>/SKILL.md` then
 * `unlink`s the patch file in two separate ops. If the unlink throws AFTER
 * the SKILL.md write succeeds, the patch IS applied but `applyPatch` throws.
 * This helper is called from the `apply-skill-patch` catch block: it re-reads
 * the still-present patch file + the live skill; when the live skill content
 * equals the patch body, the apply write completed and only the cleanup
 * failed. In that case it returns a synthetic `applied` PatchActionResult
 * (the slash handler renders it with a `patchFileLingered` warning).
 *
 * Returns `null` when the apply did NOT happen (the live skill does not match
 * the patch body, or anything is unreadable) — the caller then surfaces the
 * original failure normally. Never throws.
 */
async function detectAppliedDespitePatchUnlinkFailure(
  agent: string,
  patchId: string,
  agentWorkspaceDir: (agent: string) => string,
): Promise<{
  status: "applied";
  finalPath: string;
  newVersion: string;
  patchFileLingered: true;
} | null> {
  try {
    const agentDir = agentWorkspaceDir(agent);
    const patchPath = join(agentDir, "skill-patches", `${patchId}.md`);
    const rawPatch = await readFile(patchPath, "utf8").catch(() => null);
    if (rawPatch === null) return null; // patch file gone — unlink succeeded
    const parsed = parsePatchFile(String(rawPatch));
    if ("error" in parsed) return null;
    const skillPath = join(
      agentDir,
      "skills",
      parsed.wrapper.targetSlug,
      "SKILL.md",
    );
    const liveSkill = await readFile(skillPath, "utf8").catch(() => null);
    if (liveSkill === null) return null;
    if (String(liveSkill) !== parsed.body) return null; // apply did NOT happen
    const versionMatch = parsed.body.match(
      /^---\n[\s\S]*?\nversion:\s*(.+?)\s*$/m,
    );
    return {
      status: "applied",
      finalPath: skillPath,
      newVersion: versionMatch ? versionMatch[1]!.trim() : "(applied)",
      patchFileLingered: true,
    };
  } catch {
    return null;
  }
}

/**
 * Phase 52 Plan 03: compute the `cache_effect_ms` delta for the Prompt Cache
 * panel / CLI / IPC `cache` response.
 *
 * Returns:
 *   - `null` when the window has < 20 eligible turns (noise floor — CONTEXT
 *     D-05). Model latency variance is too high below this sample size to
 *     trust the delta.
 *   - `null` when either the hit-average or miss-average is NULL (only one
 *     branch of the cache-hit/miss split has data).
 *   - `hitAvgMs - missAvgMs` otherwise. Negative values are the expected
 *     signal (cached turns are faster). A positive value after 20+ turns
 *     triggers a WARN log at the call site.
 */
export function computeCacheEffectMs(
  store: TraceStore,
  agentName: string,
  sinceIso: string,
): number | null {
  const stats = store.getCacheEffectStats(agentName, sinceIso);
  if (stats.eligibleTurns < 20) return null;
  if (stats.hitAvgMs === null || stats.missAvgMs === null) return null;
  return stats.hitAvgMs - stats.missAvgMs;
}
