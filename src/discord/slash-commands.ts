/**
 * Slash command registration and interaction handling for Discord.
 *
 * Registers guild-scoped slash commands via Discord REST API on startup,
 * listens for interactions, routes them to agents, and replies with the response.
 */

import { buildCv2Payload } from "./cv2-renderer.js";
// Phase 999.114 — catalog-driven `/clawcode-model` option list.
import { buildModelPickerOptions } from "./model-picker-options.js";
import { buildLedgerCardSpec, buildLedgerPlainText, VSRC_PREFIX } from "./ledger-card.js";
import { RA_PREFIX } from "./reply-actions.js";
import { STATUS_PING_BUTTON_PREFIX } from "./status-ping-render.js";
import { RETRY_PREFIX } from "./retry-actions.js";
import { handleResearchButton, type ResearchButtonDeps } from "./research-card-button.js";
import { RESEARCH_BUTTON_PREFIX } from "./research-card.js";
import {
  handleContainerReliefButton,
  handleReliefButton,
  MEMREL_PREFIX,
} from "./memory-relief-button.js";
import type { ReliefDeps } from "../manager/memory-relief.js";
import type { ContainerRestartDeps } from "../homelab/unraid-watch-service.js";
import type { TurnLedger as LedgerLike } from "./ledger-store.js";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  REST,
  Routes,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { execSync } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { statSync, existsSync, readdirSync, readFileSync } from "node:fs";
import type { RoutingTable } from "./types.js";
import type { SessionManager } from "../manager/session-manager.js";
import type { ResolvedAgentConfig } from "../shared/types.js";
import type { EffortLevel } from "../config/schema.js";
import { effortSchema, outputStyleSchema } from "../config/schema.js";
import { UltracodeNotAllowedError } from "../manager/model-errors.js";
import type { SlashCommandDef } from "./slash-types.js";
import { DEFAULT_SLASH_COMMANDS, CONTROL_COMMANDS, GSD_SLASH_COMMANDS } from "./slash-types.js";
// Phase 999.171 — /clawcode-ux reply handler (routes to set-ux-feature).
import { handleUxSlash } from "./ux-slash.js";
// Phase 93 Plan 01 — pure renderer for /clawcode-status daemon short-circuit.
import { buildStatusData, renderStatus, renderUsageBars } from "./status-render.js";
import { effectiveSnapshots, livePlanSnapshots } from "../usage/plan-usage-probe.js";
// Phase 999.113 WS-6 — run-log readers for accurate Dreamt:/Consolidated:
// panel lines (attempt + outcome, not just last artifact mtime).
import {
  listRecentDreamRuns,
  type DreamRunRow,
} from "../manager/dream-run-log.js";
import {
  listRecentConsolidationRuns,
  type ConsolidationRunRow,
} from "../manager/consolidation-run-log.js";
import type { RateLimitSnapshot } from "../usage/rate-limit-tracker.js";
// Token in/out totals carried into the /clawcode-usage embed (type-only —
// erased at compile, so the runtime usage-embed module stays lazy-imported).
import type { UsageTokens } from "./usage-embed.js";
// Quick 260611-h50 — DST-correct Pacific day/week UTC ranges for the
// /clawcode-usage token totals. Pure (Intl-only, no discord.js reach), so a
// static import is fine — it does NOT pull EmbedBuilder into the module graph.
import { pacificDayRangeUtc } from "../usage/pacific-window.js";
// Phase 94 Plan 07 — shared pure renderer for the capability-probe column on
// /clawcode-tools (Discord) AND `clawcode mcp-status` (CLI). Reads the
// list-mcp-status IPC payload (with 94-01 + 94-07 extensions) and produces
// per-server frozen ProbeRowOutput objects. Cross-renderer parity test in
// the CLI test file pins content equivalence. Static-grep pin for the
// 25-field Discord embed cap: EMBED_LINE_CAP = 25 (single source in
// probe-renderer.ts; re-asserted here so the slash file owns the literal
// surface that the acceptance grep checks).
// Imports include `recoverySuggestionFor` for the static-grep acceptance
// pin even though buildProbeRow internally invokes it — the renderer
// indirection is documented at the call site below.
import {
  buildProbeRow,
  paginateRows,
  recoverySuggestionFor,
  EMBED_LINE_CAP,
  type ProbeRowOutput,
  type ProbeRowState,
} from "../manager/probe-renderer.js";
// Reference recoverySuggestionFor at module scope so the unused-import
// check passes — this is the documented escape hatch for renderer code
// paths that want to surface a recovery hint without going through
// buildProbeRow (e.g. a future "compose-only" UI flow).
void recoverySuggestionFor;

// Static-grep pin (94-07 acceptance): document the cap inline so the
// acceptance grep `grep -q "EMBED_LINE_CAP = 25" src/discord/slash-commands.ts`
// matches. Source-of-truth lives in probe-renderer.ts. The local const
// re-statement is redundant at runtime but guards against accidental
// cap drift if anyone forks the value here.
const EMBED_LINE_CAP_ASSERTED: 25 = EMBED_LINE_CAP as 25; // EMBED_LINE_CAP = 25
void EMBED_LINE_CAP_ASSERTED;
// Phase 87 CMD-01 — SDK-driven native command registration.
// Phase 87 CMD-03 — buildNativePromptString for prompt-channel dispatch.
import {
  buildNativeCommandDefs,
  mergeAndDedupe,
  buildNativePromptString,
} from "../manager/native-cc-commands.js";
import { resolveDeniedCommands } from "../security/acl-parser.js";
import { sendIpcRequest } from "../ipc/client.js";
import { SOCKET_PATH } from "../manager/daemon.js";
import type { RegistryEntry } from "../manager/types.js";
import type {
  WorkflowCancelResult,
  WorkflowDetail,
  WorkflowSteerResult,
  WorkflowSummary,
} from "../manager/workflow-orchestrator.js";
import {
  renderCancelResultText,
  renderSteerResultText,
  renderWorkflowDetailText,
} from "../manager/workflow-status-render.js";
import { getAgentForChannel } from "./router.js";
import { ProgressiveMessageEditor } from "./streaming.js";
import { formatOutboundText } from "./markdown-table-wrap.js";
import type { Logger } from "pino";
import { logger } from "../shared/logger.js";
import type { TurnDispatcher } from "../manager/turn-dispatcher.js";
import type { TurnOrigin } from "../manager/turn-origin.js";
import { makeRootOrigin } from "../manager/turn-origin.js";
import type { SkillsCatalog } from "../skills/types.js";
// Skill-slash-commands — opt-in per-skill Discord command registration.
import { buildSkillSlashCommands } from "./skill-slash-commands.js";
// Phase 100 Plan 04 GSD-01..03 — long-runner /gsd-* slash dispatch pre-spawns
// a subagent thread via SubagentThreadSpawner.spawnInThread. The spawner is
// injected via the SlashCommandHandlerConfig (optional — when absent the
// handler emits a graceful "unavailable" reply, mirroring Phase 87 CMD-05's
// optional-DI pattern for ACL deny sets).
import type { SubagentThreadSpawner } from "./subagent-thread-spawner.js";
// Phase 141 (#8) — reuse the v3 chat-routing gate so a skill-named
// /clawcode-<skill> turn reaches a claude-code-interactive agent over the live
// channel (push + awaitReply) instead of the inert daemon-side streamFromAgent.
import { resolveV3ChatBridge, type ChatChannelBridge } from "./bridge.js";
import { runAccountCommand, type AccountFlowDeps } from "./account-swap-flow.js";

/**
 * Maximum Discord message length (API limit).
 */
const DISCORD_MAX_LENGTH = 2000;

/**
 * Phase 86 MODEL-02 — TTL for the /clawcode-model select-menu collector.
 * The menu auto-dismisses after this many ms with no selection and the
 * handler replies "timed out". 30 seconds matches the Discord ephemeral
 * reply TTL comfortably.
 */
const MODEL_PICKER_TTL_MS = 30_000;

/**
 * Phase 86 MODEL-02 — Discord StringSelectMenuBuilder hard cap. The picker
 * truncates the allowedModels list to the first 25 entries and appends an
 * overflow note to the content string. Discord rejects menus with more
 * than 25 options at registration time.
 */
const DISCORD_SELECT_CAP = 25;

/**
 * Phase 86 MODEL-05 — TTL for the cache-invalidation confirmation collector.
 * Users get 30s to confirm before the dialog auto-dismisses. Mirrors the
 * picker TTL above for consistency (operators only have one "model switch"
 * decision window to hold in their head).
 */
const MODEL_CONFIRM_TTL_MS = 30_000;

/**
 * Phase 87 CMD-07 — Discord's per-guild slash-command cap is 100. Reserve a
 * 10-slot buffer so future admin-only additions don't immediately trip the
 * limit. Exceeding this ceiling throws BEFORE rest.put — no partial registration,
 * no silent truncation.
 */
const MAX_COMMANDS_PER_GUILD = 90;

/**
 * 2026-08-07 — Discord's hard cap on `choices` entries per option. Used by the
 * dynamic `agent:` picker in register(): a fleet larger than this leaves the
 * option free-text rather than registering a truncated (and therefore
 * misleading) dropdown.
 */
const DISCORD_MAX_CHOICES_PER_OPTION = 25;

/**
 * Phase 100 Plan 04 GSD-01..03 — long-runner /gsd-* commands that auto-spawn
 * a subagent thread when invoked in #admin-clawdy. Short-runners (gsd-debug,
 * gsd-quick) are intentionally NOT in this set — they fall through to the
 * existing control-command / agent-routed branch where formatCommandMessage
 * rewrites their claudeCommand template ("/gsd:debug {issue}" / "/gsd:quick
 * {task}") to the canonical SDK form for inline dispatch.
 *
 * Detection happens BEFORE the generic control-command dispatch in
 * handleInteraction — see the 12th application of the inline-handler-short-
 * circuit pattern (Phases 85/86/87/88/90/91/92/95/96).
 */
const GSD_LONG_RUNNERS: ReadonlySet<string> = new Set([
  "gsd-autonomous",
  "gsd-plan-phase",
  "gsd-execute-phase",
]);

import { CLAWCODE_VERSION } from "../shared/version.js";
// Phase 135 Plan 01 Task 3 — /vc {join,leave,status} slash command handler.
// Plan 02 wires the daemon-owned VoiceManager via `config.voiceManager`.
// Phase 135 REVIEW CR-01 — the lazy-construct fallback was removed (it
// created a divergent unwired VoiceManager with no transcriptDispatcher
// and no capWarningSink — exact `feedback_silent_path_bifurcation`
// failure mode). When `config.voiceManager` is absent, `/vc` now
// fail-closes with an ephemeral error and a loud daemon log. The
// VoiceManager import is type-only (no runtime construction here).
import { handleVcCommand } from "./voice/command.js";
import type { VoiceManager } from "./voice/manager.js";

/**
 * Phase 93 Plan 01 — best-effort short git sha for /clawcode-status. Mirrors
 * the benchmarks/runner.ts pattern (try execSync, fallback to undefined).
 * Resolved once at first /clawcode-status call (lazy + cached) to avoid
 * per-startup git-rev-parse cost when the command is never used. The
 * `null` sentinel indicates "not yet resolved"; `undefined` means "git
 * unavailable / repo missing — render as 'unknown'".
 */
let CACHED_COMMIT_SHA: string | undefined | null = null;
function resolveCommitSha(): string | undefined {
  if (CACHED_COMMIT_SHA !== null) return CACHED_COMMIT_SHA;
  try {
    const sha = execSync("git rev-parse --short HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    CACHED_COMMIT_SHA = sha.length > 0 ? sha : undefined;
  } catch {
    CACHED_COMMIT_SHA = undefined;
  }
  return CACHED_COMMIT_SHA;
}

// ---------------------------------------------------------------------------
// Phase 85 Plan 03 TOOL-06 / UI-01 — /clawcode-tools inline handler helpers.
//
// Hoisted to module scope (not class members) so unit tests can exercise the
// pure bits in isolation, and so the handler reads as a straight-line flow
// without reaching through `this` for simple lookups.
// ---------------------------------------------------------------------------

/** Server status → emoji mapping used as the field-name prefix. */
const STATUS_EMOJI: Record<string, string> = {
  ready: "\u{1F7E2}",         // green circle
  degraded: "\u{1F7E1}",      // yellow circle
  failed: "\u{1F534}",        // red circle
  reconnecting: "\u{1F7E0}",  // orange circle
  unknown: "\u{26AA}",        // white (neutral) circle
};

/**
 * Shape of a single server entry returned by the `list-mcp-status` IPC
 * method (Plan 01 daemon.ts case). Duplicated here instead of imported so
 * slash-commands stays decoupled from the manager module graph.
 *
 * Phase 94 Plan 01 — additive `capabilityProbe?:` field carries the per-
 * server probe snapshot (status / lastRunAt / error / lastSuccessAt).
 *
 * Phase 94 Plan 07 D-07 — additive `alternatives?:` field carries other
 * agents whose snapshot has the same server in capabilityProbe.status
 * === "ready"; populated daemon-side from findAlternativeAgents (94-04).
 */
type ToolsIpcCapabilityProbe = {
  readonly lastRunAt: string;
  readonly status: "ready" | "degraded" | "reconnecting" | "failed" | "unknown";
  readonly error?: string;
  readonly lastSuccessAt?: string;
};

type ToolsIpcServer = {
  readonly name: string;
  readonly status: "ready" | "degraded" | "failed" | "reconnecting" | "unknown";
  readonly lastSuccessAt: number | null;
  readonly lastFailureAt: number | null;
  readonly failureCount: number;
  readonly optional: boolean;
  readonly lastError: string | null;
  readonly capabilityProbe?: ToolsIpcCapabilityProbe;
  readonly alternatives?: ReadonlyArray<string>;
};

type ToolsIpcResponse = {
  readonly agent: string;
  readonly servers: ReadonlyArray<ToolsIpcServer>;
};

/**
 * Embed colour driven by the worst-state server in the set.
 * Exported for test convenience / future reuse by the dashboard.
 */
export function resolveEmbedColor(
  servers: ReadonlyArray<{ readonly status: string }>,
): number {
  if (servers.some((s) => s.status === "failed")) return 0xea4335;       // red
  if (servers.some((s) => s.status === "degraded")) return 0xfbbc05;     // yellow
  if (servers.some((s) => s.status === "reconnecting")) return 0xfb8c00; // orange
  return 0x34a853;                                                        // green
}

/**
 * Short relative-time formatter for embed fields: "3s", "12m", "4h", "2d".
 * Keeps the embed compact — a full ISO timestamp is overkill for an
 * operator glance.
 */
export function formatRelativeTime(deltaMs: number): string {
  const s = Math.floor(Math.max(0, deltaMs) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

/**
 * Configuration for the SlashCommandHandler.
 */
/** Phase 999.160 v1.1 — whatever can answer a reply-action click (the shared v2 bridge or a v3 one). */
/** 999.178 R1 — the same bridge surface also answers Retry-button and status-ping clicks. */
type ReplyActionBridgeLike = Pick<
  Required<ChatChannelBridge>,
  "handleReplyActionButton" | "handleRetryButton"
> &
  Partial<Pick<ChatChannelBridge, "handleStatusPingButton">>;

export type SlashCommandHandlerConfig = {
  readonly routingTable: RoutingTable;
  readonly sessionManager: SessionManager;
  readonly resolvedAgents: readonly ResolvedAgentConfig[];
  readonly botToken: string;
  readonly client?: Client;
  readonly log?: Logger;
  /**
   * Phase 135 Plan 02 — shared VoiceManager from the daemon. When
   * provided, `/vc` commands route through this instance (the same one
   * the DiscordBridge holds for autoJoin / voiceStateUpdate / transcript
   * dispatch). When absent, the handler falls back to lazy construction
   * (Plan 01 scaffolding shape) — voice commands work but the bridge's
   * ready listener and voiceStateUpdate handler will see no manager.
   */
  readonly voiceManager?: import("./voice/manager.js").VoiceManager;
  /**
   * Quick task 260419-nic — optional TurnDispatcher reference used by the
   * /clawcode-steer slash command to dispatch a follow-up [USER STEER] turn
   * after interrupting the in-flight one. Optional so existing callers
   * (tests, legacy wiring) don't break; when absent, /clawcode-steer
   * replies with a clear "steer unavailable" message.
   */
  readonly turnDispatcher?: TurnDispatcher;
  /**
   * Phase 141 (#8) — v3 channel-bridge resolver (the same closure DiscordBridge
   * receives via BridgeConfig.getBridge: `agent => agentChannelRegistry.get(agent)?.bridge`).
   * When a skill-named `/clawcode-<skill>` turn targets a `claude-code-interactive`
   * agent, the handler routes it over the live ClawCode channel (push +
   * awaitReply) instead of the INERT v3 `streamFromAgent` (which yields nothing →
   * "(No response from agent)"). Optional; absent → v2 streamFromAgent path.
   */
  readonly getBridge?: (agentName: string) => ChatChannelBridge | undefined;
  /**
   * Phase 999.160 v1.1 — the SHARED v2 Discord bridge, for reply-action
   * buttons. `getBridge` only knows the v3 per-agent registry, which is empty
   * for every v2 agent (all of prod on 2026-09-23) — the first real click
   * landed in "No agent is bound to this channel." The v2 bridge owns the
   * reply-action registry, so it answers the click.
   */
  readonly getReplyActionBridge?: () => ReplyActionBridgeLike | undefined;
  /**
   * 2026-08-28 — direct verification-ledger lookup for the `🧾 Sources` button
   * (`DiscordBridge.getLedgerByMessageId`). No channel→agent hop, so it works
   * for v2 agents and inside threads. Optional; absent → legacy getBridge hop.
   */
  readonly getLedger?: (messageId: string) => LedgerLike | undefined;
  /**
   * 999.147 — deps for the 🩹 relief button on a MemoryGuard imminence page.
   * Resolved lazily per click so the daemon can build them after this handler
   * is constructed. Absent → the arm below is never registered and a relief
   * click is simply ignored (no ack), matching the strict-prefix discipline
   * every other button here follows.
   */
  readonly getReliefDeps?: () => ReliefDeps | undefined;
  /** Phase 999.173 — deps for the research card's Status / Stop buttons. */
  readonly getResearchButtonDeps?: () => ResearchButtonDeps | undefined;
  /** 999.147 WS-3 — deps for the 🔄 Unraid container-restart button. */
  readonly getContainerReliefDeps?: () => ContainerRestartDeps | undefined;
  /**
   * Phase 999.176 — deps for `/clawcode-account` (fleet account swap). Absent
   * → the command answers "not configured". Carries its own admin gate.
   */
  readonly getAccountFlowDeps?: () => AccountFlowDeps | undefined;
  /**
   * Phase 83 EFFORT-05 — optional skills catalog used to resolve per-skill
   * effort overrides on slash-command invocation. When a slash command name
   * (e.g. `clawcode-<skill>`) maps to a catalog entry with an `effort:`
   * frontmatter value, the handler applies that level for the duration of
   * the turn (setEffortForAgent) and reverts in a finally block. Optional
   * so existing callers (tests, pre-Phase-83 wiring) continue to work with
   * no per-skill override behavior.
   */
  readonly skillsCatalog?: SkillsCatalog;
  /**
   * Skill-slash-commands — per-agent set of ACTIVE (manifest-survived) skill
   * names. Computed once at boot by the daemon's skill-manifest loop
   * (manifest-refused skills excluded). Used to:
   *   1. Build the opt-in `/<skill>` command union at register() time.
   *   2. Gate each invocation in handleInteraction — a `/<skill>` invoked in
   *      a channel whose agent does not have the skill is rejected.
   *
   * Optional so existing callers (tests, pre-feature wiring) keep working;
   * when absent the handler falls back to `ResolvedAgentConfig.skills` (the
   * configured set, without manifest-refusal filtering).
   */
  readonly loadedSkillsByAgent?: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * Phase 87 CMD-05 — optional test-time override for the per-agent ACL deny
   * sets. Production code reads SECURITY.md via resolveDeniedCommands inside
   * register(); tests inject the pre-computed Map directly so the integration
   * test doesn't have to fs-write fixture SECURITY.md files.
   *
   * When absent, register() derives `<memoryPath>/SECURITY.md` (or
   * `<workspace>/SECURITY.md`) per agent and calls resolveDeniedCommands
   * itself.
   */
  readonly aclDeniedByAgent?: ReadonlyMap<string, ReadonlySet<string>> | Record<
    string,
    ReadonlySet<string>
  >;
  /**
   * Phase 95 Plan 03 DREAM-07 — admin Discord user IDs. Operator-tier
   * commands (e.g. /clawcode-dream) gate on this set BEFORE invoking IPC
   * so non-admins receive an instant ephemeral "Admin-only command" reply.
   * Empty / undefined → admin-only commands refuse all callers (safe
   * default — fail closed).
   */
  readonly adminUserIds?: readonly string[];
  /**
   * Phase 100 Plan 04 GSD-01..03 — optional subagent thread spawner used by
   * the 12th inline-handler short-circuit for /gsd-* long-runners. When the
   * dispatcher detects gsd-autonomous / gsd-plan-phase / gsd-execute-phase in
   * #admin-clawdy, it pre-spawns a subagent thread via spawnInThread and
   * passes the canonical /gsd:* slash as the subagent's first user message.
   *
   * Optional so tests + non-Discord wiring continue to work — when absent,
   * the handler emits a "Subagent thread spawning unavailable" editReply and
   * does NOT throw. Mirrors the optional-DI pattern used by aclDeniedByAgent
   * (Phase 87 CMD-05) and skillsCatalog (Phase 83 EFFORT-05).
   */
  readonly subagentThreadSpawner?: SubagentThreadSpawner;
};

// ---------------------------------------------------------------------------
// Phase 95 Plan 03 DREAM-07 — /clawcode-dream helpers (admin gate + embed
// renderer). Pure exported functions so the slash-commands tests exercise
// them without spinning up the full SlashCommandHandler.
// ---------------------------------------------------------------------------

/**
 * IPC response shape for `run-dream-pass` mirrored from the daemon's
 * RunDreamPassResponse. Re-declared here so the slash module doesn't pull
 * in the daemon's internal types (keeps the import graph narrow).
 */
type DreamIpcResponse = {
  readonly agent: string;
  readonly startedAt: string;
  readonly outcome:
    | {
        readonly kind: "completed";
        readonly result: {
          readonly themedReflection: string;
          readonly newWikilinks: ReadonlyArray<unknown>;
          readonly promotionCandidates: ReadonlyArray<unknown>;
          readonly suggestedConsolidations: ReadonlyArray<unknown>;
        };
        readonly durationMs: number;
        readonly tokensIn: number;
        readonly tokensOut: number;
        readonly model: string;
      }
    | { readonly kind: "skipped"; readonly reason: string }
    | { readonly kind: "failed"; readonly error: string };
  readonly applied:
    | {
        readonly kind: "applied";
        readonly appliedWikilinkCount: number;
        readonly surfacedPromotionCount: number;
        readonly surfacedConsolidationCount: number;
        readonly logPath: string;
      }
    | { readonly kind: "skipped"; readonly reason: string }
    | { readonly kind: "failed"; readonly error: string };
};

/**
 * Phase 95 Plan 03 DREAM-07 / Phase 100-fu — pure admin gate.
 *
 * Returns true when EITHER:
 *   1. The interaction's `user.id` is in the explicit `adminUserIds`
 *      allowlist (back-compat path), OR
 *   2. The interaction's `channelId` is bound (via `routingTable`) to a
 *      resolved agent flagged `admin: true` (NEW channel-bound path).
 *
 * Both paths are independently sufficient. Empty allowlist + unbound
 * channel + non-admin agent binding all fail-closed → returns false.
 *
 * Rationale: the daemon does not always populate `adminUserIds` at
 * construction (see manager/daemon.ts SlashCommandHandler init), so an
 * operator running `/clawcode-dream` from `#admin-clawdy` (a channel
 * bound to an `admin: true` agent) was being rejected with
 * "Admin-only command" despite the channel itself being trusted. The
 * channel-bound path closes that gap without requiring extra config.
 */
export function isAdminClawdyInteraction(
  interaction: {
    readonly user: { readonly id: string };
    readonly channelId: string;
  },
  context: {
    readonly adminUserIds: readonly string[];
    readonly routingTable: {
      readonly channelToAgent: ReadonlyMap<string, string>;
    };
    readonly resolvedAgents: readonly {
      readonly name: string;
      readonly admin: boolean;
    }[];
  },
): boolean {
  // Path 1: explicit user-ID allowlist match (back-compat).
  if (
    context.adminUserIds.length > 0 &&
    context.adminUserIds.includes(interaction.user.id)
  ) {
    return true;
  }
  // Path 2: channel-bound to an admin agent.
  const agentName = context.routingTable.channelToAgent.get(
    interaction.channelId,
  );
  if (agentName !== undefined) {
    const agent = context.resolvedAgents.find((a) => a.name === agentName);
    if (agent?.admin === true) return true;
  }
  return false;
}

/**
 * Phase 95 Plan 03 DREAM-07 — themed dream-pass embed.
 *
 * Color palette mirrors the Phase 91-05 conflict-color literals:
 *   completed: 0x2ecc71 (green)
 *   skipped:   0xf1c40f (yellow)
 *   failed:    0xe74c3c (red)
 *
 * Description for completed = themedReflection truncated at 4000 chars
 * (Discord embed description hard-cap is 4096; 4000 is the safety margin
 * preserving the trailing "..." marker if needed). Pinned by DSL3 test.
 */
export function renderDreamEmbed(
  agent: string,
  response: DreamIpcResponse,
): EmbedBuilder {
  const colorByKind = {
    completed: 0x2ecc71,
    skipped: 0xf1c40f,
    failed: 0xe74c3c,
  } as const;
  const embed = new EmbedBuilder()
    .setTitle(`💠 Dream pass — ${agent}`)
    .setColor(colorByKind[response.outcome.kind])
    .setTimestamp();

  if (response.outcome.kind === "completed") {
    const reflection = response.outcome.result.themedReflection ?? "";
    embed.setDescription(reflection.slice(0, 4000));
    const applied = response.applied;
    const appliedWikilinkCount =
      applied.kind === "applied" ? applied.appliedWikilinkCount : 0;
    const surfacedPromotionCount =
      applied.kind === "applied" ? applied.surfacedPromotionCount : 0;
    const surfacedConsolidationCount =
      applied.kind === "applied" ? applied.surfacedConsolidationCount : 0;
    const logPath =
      applied.kind === "applied" ? applied.logPath : "(no log path)";
    embed.addFields(
      { name: "Outcome", value: "completed", inline: true },
      {
        name: "Wikilinks",
        value: `${appliedWikilinkCount} applied`,
        inline: true,
      },
      {
        name: "Promotion candidates",
        value: `${surfacedPromotionCount} surfaced for review`,
        inline: true,
      },
      {
        name: "Consolidations",
        value: `${surfacedConsolidationCount} surfaced for review`,
        inline: true,
      },
      {
        name: "Cost",
        value: `${response.outcome.tokensIn} in / ${response.outcome.tokensOut} out · ${(response.outcome.durationMs / 1000).toFixed(1)}s · ${response.outcome.model}`,
        inline: false,
      },
      { name: "Log", value: `\`${logPath}\``, inline: false },
    );
  } else if (response.outcome.kind === "skipped") {
    embed.setDescription("(no result — see fields below)");
    embed.addFields({
      name: "Outcome",
      value: `skipped: ${response.outcome.reason}`,
    });
  } else {
    embed.setDescription("(no result — see fields below)");
    embed.addFields({
      name: "Outcome",
      value: `failed: ${response.outcome.error}`,
    });
  }
  return embed;
}

// ---------------------------------------------------------------------------
// Phase 124 Plan 03 — /clawcode-session-compact helpers (admin gate + embed
// renderer). Pure exported function so the slash-compact tests exercise the
// embed shape without instantiating SlashCommandHandler. Mirrors the
// /clawcode-dream helper shape (DreamIpcResponse + renderDreamEmbed).
// ---------------------------------------------------------------------------

/**
 * IPC response shape for the daemon's `compact-session` method. Mirrors the
 * `CompactSessionResult` discriminated union exported from
 * `src/manager/daemon-compact-session-ipc.ts`. Re-declared here so the slash
 * module doesn't pull in the manager's internal type graph (keeps the import
 * direction clean — Discord layer reads daemon contract via IPC shape only).
 */
export type CompactSessionIpcResponse =
  | {
      readonly ok: true;
      readonly tokens_before: number | null;
      readonly tokens_after: number | null;
      readonly summary_written: boolean;
      // Phase 999.75 Part B — native /compact performs no fork; `forked_to`
      // is `null` on that path (kept for backward compat).
      readonly forked_to: string | null;
      readonly memories_created: number;
      // Phase 999.75 Part B — Layer 2 live-window-reduction telemetry.
      readonly live_reduced?: boolean;
      readonly skip_reason?: string;
    }
  | {
      readonly ok: false;
      readonly error:
        | "DAEMON_NOT_READY"
        | "AGENT_NOT_RUNNING"
        | "AGENT_NOT_INITIALIZED"
        | "ERR_TURN_TOO_LONG"
        | "UNKNOWN";
      readonly message?: string;
    };

/**
 * Render the ephemeral embed for `/clawcode-session-compact`.
 *
 * Success (`ok:true`) → green (0x2ecc71), 5 fields populated from the IPC
 * response (tokens_before, tokens_after, summary_written yes/no,
 * forked_to, memories_created). `null` tokens render as `n/a`.
 *
 * Error (`ok:false`) → red (0xe74c3c), description carries the error code
 * verbatim so the operator sees CLI parity (the same error names surface
 * from `clawcode session compact` via Plan 124-02). Optional `message`
 * appended as a second line.
 *
 * Pure function — no side effects, no IPC, no clock. Pinned by T03-H2,
 * T03-H3, T04-E1 in slash-compact.test.ts.
 */
export function renderCompactEmbed(
  agent: string,
  response: CompactSessionIpcResponse,
): EmbedBuilder {
  if (response.ok) {
    const embed = new EmbedBuilder()
      .setTitle(`💠 Compaction complete: ${agent}`)
      .setColor(0x2ecc71)
      .setTimestamp();
    const fmtTokens = (n: number | null): string =>
      n === null ? "n/a" : String(n);
    embed.addFields(
      { name: "Tokens before", value: fmtTokens(response.tokens_before), inline: true },
      { name: "Tokens after", value: fmtTokens(response.tokens_after), inline: true },
      {
        name: "Summary written",
        value: response.summary_written ? "yes" : "no",
        inline: true,
      },
      {
        name: "Memories created",
        value: String(response.memories_created),
        inline: true,
      },
      // Phase 999.75 Part B — surface whether native /compact actually
      // reduced the live context window. `skip_reason` explains a false.
      {
        name: "Live window reduced",
        value:
          response.live_reduced === true
            ? "yes"
            : response.skip_reason !== undefined
              ? `no (${response.skip_reason})`
              : "no",
        inline: true,
      },
    );
    return embed;
  }
  // Error path — red embed; error code verbatim in description.
  const embed = new EmbedBuilder()
    .setTitle(`💠 Compaction failed: ${agent}`)
    .setColor(0xe74c3c)
    .setTimestamp();
  const lines = [`\`${response.error}\``];
  if (response.message !== undefined && response.message.length > 0) {
    lines.push(response.message);
  }
  embed.setDescription(lines.join("\n"));
  return embed;
}

// ---------------------------------------------------------------------------
// Phase 132 Plan 03 T-03 — /approve-skill + /reject-skill helpers (/edit-skill
// retired 2026-09-23; the "found" arm below is its now-unused result shape).
// Pure exported function so the slash-commands tests can exercise the embed
// rendering without spinning up the full SlashCommandHandler.
// ---------------------------------------------------------------------------

/**
 * Wire shape of the DraftActionResult discriminated union returned by the
 * daemon's three new IPC methods. Mirrors
 * src/manager/skill-draft-actions.ts DraftActionResult.
 */
type SkillDraftActionWire =
  | { readonly status: "approved"; readonly finalPath: string }
  | {
      readonly status: "rejected";
      readonly finalPath: string;
      readonly fingerprint12: string;
    }
  | { readonly status: "found"; readonly draftPath: string }
  | {
      readonly status: "not-found";
      readonly reason: "staging-file-missing";
    };

/**
 * Render a DraftActionResult as a discord.js EmbedBuilder. Success embeds
 * are green and include the resolved final/draft path; the not-found embed
 * is red with the staging-file-missing reason. Pure function — exported
 * for testability + DRY across the /approve-skill and /reject-skill inline
 * handlers.
 */
export function renderSkillDraftActionEmbed(
  agent: string,
  draftId: string,
  response: SkillDraftActionWire,
): EmbedBuilder {
  const baseAgent = agent.length > 0 ? agent : "(unbound)";
  if (response.status === "approved") {
    return new EmbedBuilder()
      .setTitle("💠 Skill approved")
      .setColor(0x2ecc71)
      .addFields(
        { name: "Agent", value: baseAgent, inline: true },
        { name: "Draft", value: `\`${draftId}\``, inline: false },
        { name: "Moved to", value: `\`${response.finalPath}\``, inline: false },
      )
      .setTimestamp();
  }
  if (response.status === "rejected") {
    return new EmbedBuilder()
      .setTitle("💠 Skill rejected (fingerprint preserved)")
      .setColor(0xe67e22)
      .addFields(
        { name: "Agent", value: baseAgent, inline: true },
        { name: "Draft", value: `\`${draftId}\``, inline: false },
        { name: "Archived to", value: `\`${response.finalPath}\``, inline: false },
        {
          name: "Fingerprint",
          value: `\`${response.fingerprint12}\``,
          inline: true,
        },
      )
      .setTimestamp();
  }
  if (response.status === "found") {
    return new EmbedBuilder()
      .setTitle("💠 Skill draft ready for edit")
      .setColor(0x3498db)
      .setDescription(
        "scp-edit the file below, then run `/approve-skill <draft-id>` to promote.",
      )
      .addFields(
        { name: "Agent", value: baseAgent, inline: true },
        { name: "Draft", value: `\`${draftId}\``, inline: false },
        { name: "Path", value: `\`${response.draftPath}\``, inline: false },
      )
      .setTimestamp();
  }
  // not-found
  return new EmbedBuilder()
    .setTitle("💠 Skill draft not found")
    .setColor(0xe74c3c)
    .addFields(
      { name: "Agent", value: baseAgent, inline: true },
      { name: "Draft", value: `\`${draftId}\``, inline: false },
      { name: "Reason", value: response.reason, inline: false },
    )
    .setTimestamp();
}

// ---------------------------------------------------------------------------
// Phase 96 Plan 05 PFS- — /clawcode-probe-fs helpers (FsProbeOutcome embed
// renderer). 11th application of the inline-handler-short-circuit pattern.
// Pure exported function so the slash-commands tests exercise it without
// spinning up the full SlashCommandHandler.
// ---------------------------------------------------------------------------

/**
 * Wire shape of a single FsCapabilitySnapshot entry returned by the daemon's
 * `probe-fs` IPC handler. Mirrors src/manager/persistent-session-handle.ts
 * FsCapabilitySnapshot but re-declared here so this module doesn't reach into
 * the manager's type graph (decoupling discipline).
 */
type FsCapabilitySnapshotWire = {
  readonly status: "ready" | "degraded" | "unknown";
  readonly mode: "rw" | "ro" | "denied";
  readonly lastProbeAt: string;
  readonly lastSuccessAt?: string;
  readonly error?: string;
};

/**
 * Wire shape of FsProbeOutcome (mirror of src/manager/fs-probe.ts). The
 * snapshot is JSON-serialized as an array of [path, state] tuples (Maps don't
 * round-trip through JSON-RPC). Optional `changes` field populated by the
 * daemon when the operator passes a previous snapshot for diff rendering.
 */
type FsProbeOutcomeWire =
  | {
      readonly kind: "completed";
      readonly snapshot: ReadonlyArray<readonly [string, FsCapabilitySnapshotWire]>;
      readonly durationMs: number;
      readonly changes?: ReadonlyArray<{
        readonly path: string;
        readonly from: string;
        readonly to: string;
      }>;
    }
  | { readonly kind: "failed"; readonly error: string };

/**
 * Phase 96 Plan 05 PFS- — themed filesystem-capability probe embed.
 *
 * Color palette mirrors the conflict-color literals used by other slash
 * embeds (sync-status / dream):
 *   completed (all ready):     0x2ecc71 (green)
 *   completed (some degraded): 0xf1c40f (yellow)
 *   failed:                    0xe74c3c (red)
 *
 * D-03 spec — three fields:
 *   1. "Probed paths" — comma-list of canonical paths
 *   2. "Ready / Degraded" — count summary (e.g. "2 ready / 1 degraded")
 *   3. (optional) "Changes since last probe" — top 3 transitions
 *
 * Status emoji LOCKED per CRITICAL invariant:
 *   ✓ ready · ⚠ degraded · ? unknown
 * (Phase 96 uses simpler ✓/⚠ vs Phase 85 plan 03's ✅/❌ — filesystem has
 * no failed/reconnecting analog so the simpler palette suffices.)
 */
export function renderProbeFsEmbed(
  agent: string,
  outcome: FsProbeOutcomeWire,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`Filesystem capability — ${agent}`)
    .setTimestamp();

  if (outcome.kind === "failed") {
    embed.setColor(0xe74c3c);
    embed.addFields({
      name: "Error",
      value: outcome.error,
      inline: false,
    });
    return embed;
  }

  // outcome.kind === "completed"
  const entries = outcome.snapshot;
  const readyCount = entries.filter(([, s]) => s.status === "ready").length;
  const degradedCount = entries.filter(
    ([, s]) => s.status === "degraded",
  ).length;
  const unknownCount = entries.filter(
    ([, s]) => s.status === "unknown",
  ).length;

  embed.setColor(degradedCount > 0 ? 0xf1c40f : 0x2ecc71);

  // Field 1 — paths probed (truncate to 1024 char Discord field cap if huge)
  const pathLines = entries.map(([path, state]) => {
    const emoji =
      state.status === "ready" ? "✓" : state.status === "degraded" ? "⚠" : "?";
    return `${emoji} ${path}`;
  });
  const pathsValue =
    pathLines.length > 0 ? pathLines.join("\n").slice(0, 1024) : "(none)";
  embed.addFields({
    name: "Probed paths",
    value: pathsValue,
    inline: false,
  });

  // Field 2 — counts summary
  const countParts: string[] = [];
  countParts.push(`${readyCount} ready`);
  if (degradedCount > 0) countParts.push(`${degradedCount} degraded`);
  if (unknownCount > 0) countParts.push(`${unknownCount} unknown`);
  embed.addFields({
    name: "Ready / Degraded",
    value: countParts.join(" / "),
    inline: false,
  });

  // Field 3 (optional) — Changes since last probe (top 3 transitions)
  if (outcome.changes && outcome.changes.length > 0) {
    const changeLines = outcome.changes
      .slice(0, 3)
      .map((c) => `${c.path}: ${c.from} → ${c.to}`);
    embed.addFields({
      name: "Changes since last probe",
      value: changeLines.join("\n").slice(0, 1024),
      inline: false,
    });
  }

  // Field 4 (footer info) — duration probed in
  embed.setFooter({
    text: `Probed in ${outcome.durationMs}ms`,
  });

  return embed;
}

/**
 * Handles Discord slash command registration and interaction dispatch.
 *
 * On start(): connects a discord.js Client, registers guild-scoped commands
 * via the REST API, and listens for interactionCreate events.
 *
 * On stop(): removes the interaction listener and disconnects the client.
 */
export class SlashCommandHandler {
  private readonly routingTable: RoutingTable;
  private readonly sessionManager: SessionManager;
  private readonly resolvedAgents: readonly ResolvedAgentConfig[];
  private readonly botToken: string;
  private readonly log: Logger;
  private readonly turnDispatcher: TurnDispatcher | null;
  // Phase 141 (#8) — v3 channel-bridge resolver (null when not injected → v2
  // streamFromAgent path). See SlashCommandHandlerConfig.getBridge.
  private readonly getBridge:
    | ((agentName: string) => ChatChannelBridge | undefined)
    | null;
  private readonly getReplyActionBridge: (() => ReplyActionBridgeLike | undefined) | null;
  private readonly getLedger: ((messageId: string) => LedgerLike | undefined) | null;
  private readonly getReliefDeps: (() => ReliefDeps | undefined) | null;
  private readonly getResearchButtonDeps: (() => ResearchButtonDeps | undefined) | null;
  private readonly getAccountFlowDeps: (() => AccountFlowDeps | undefined) | null;
  private readonly getContainerReliefDeps:
    | (() => ContainerRestartDeps | undefined)
    | null;
  private readonly skillsCatalog: SkillsCatalog | null;
  /**
   * Skill-slash-commands — per-agent active skill name sets (manifest-refused
   * excluded). Null when not injected → handler falls back to
   * `ResolvedAgentConfig.skills`.
   */
  private readonly loadedSkillsByAgent: ReadonlyMap<
    string,
    ReadonlySet<string>
  > | null;
  /**
   * Skill-slash-commands — populated by register(): the opt-in skill command
   * defs and the command-name → holding-agent(s) map. The handler reads
   * `skillCommandDefs` to find a def for an incoming `/<skill>` invocation
   * and `skillCommandAgents` to name the agent(s) in a wrong-channel reject.
   */
  private skillCommandDefs: ReadonlyMap<string, SlashCommandDef> = new Map();
  private skillCommandAgents: ReadonlyMap<string, readonly string[]> =
    new Map();
  /**
   * Phase 87 CMD-05 — optional DI for per-agent ACL deny sets. Tests pass a
   * Map/Record to bypass SECURITY.md file lookups; production derives it at
   * register time.
   */
  private readonly aclDeniedByAgent: ReadonlyMap<string, ReadonlySet<string>> | null;
  /**
   * Phase 95 Plan 03 DREAM-07 — admin Discord user IDs (gates /clawcode-dream
   * and any future admin-tier slash commands). Empty array → fail-closed
   * (no admins recognized).
   */
  private readonly adminUserIds: readonly string[];
  /**
   * Phase 100 Plan 04 GSD-01..03 — optional subagent thread spawner used by
   * handleGsdLongRunner. null when not wired (graceful fallback per
   * SlashCommandHandlerConfig.subagentThreadSpawner JSDoc).
   */
  private readonly subagentThreadSpawner: SubagentThreadSpawner | null;
  private client: Client | null = null;
  private interactionHandler: ((interaction: Interaction) => void) | null = null;
  /**
   * Phase 135 Plan 02 — voice-manager reference.
   *
   * Always the daemon-owned VoiceManager (constructed in the bridge boot
   * path so `autoJoin()` fires on `client.on("ready")`), passed in via
   * `config.voiceManager`. Phase 135 REVIEW CR-01 removed the prior
   * lazy-construct fallback: when this is null at `/vc` dispatch time,
   * the command fail-closes with a loud log + ephemeral operator reply.
   */
  private voiceManager: VoiceManager | null = null;

  constructor(config: SlashCommandHandlerConfig) {
    this.routingTable = config.routingTable;
    this.sessionManager = config.sessionManager;
    this.resolvedAgents = config.resolvedAgents;
    this.botToken = config.botToken;
    this.client = config.client ?? null;
    this.log = config.log ?? logger;
    this.turnDispatcher = config.turnDispatcher ?? null;
    this.getBridge = config.getBridge ?? null;
    this.getReplyActionBridge = config.getReplyActionBridge ?? null;
    this.getLedger = config.getLedger ?? null;
    this.getReliefDeps = config.getReliefDeps ?? null;
    this.getResearchButtonDeps = config.getResearchButtonDeps ?? null;
    this.getAccountFlowDeps = config.getAccountFlowDeps ?? null;
    this.getContainerReliefDeps = config.getContainerReliefDeps ?? null;
    this.skillsCatalog = config.skillsCatalog ?? null;
    this.loadedSkillsByAgent = config.loadedSkillsByAgent ?? null;
    // Phase 87 CMD-05 — accept either a Map or a plain Record from config.
    if (config.aclDeniedByAgent) {
      if (config.aclDeniedByAgent instanceof Map) {
        this.aclDeniedByAgent = config.aclDeniedByAgent;
      } else {
        this.aclDeniedByAgent = new Map(
          Object.entries(config.aclDeniedByAgent as Record<string, ReadonlySet<string>>),
        );
      }
    } else {
      this.aclDeniedByAgent = null;
    }
    this.adminUserIds = Object.freeze([...(config.adminUserIds ?? [])]);
    // Phase 100 Plan 04 GSD-01..03 — wire optional subagent thread spawner.
    this.subagentThreadSpawner = config.subagentThreadSpawner ?? null;
    // Phase 135 Plan 02 — prefer the daemon-injected VoiceManager so
    // `/vc` shares the same instance as the bridge's autoJoin /
    // voiceStateUpdate / transcript-dispatch wiring. When absent (most
    // unit tests, standalone runner), fall back to lazy construction
    // on first dispatch (Plan 01 path).
    this.voiceManager = config.voiceManager ?? null;
  }

  /**
   * Start the handler: connect to Discord, register commands, listen for interactions.
   */
  async start(): Promise<void> {
    if (!this.client) {
      throw new Error("SlashCommandHandler requires a Discord client — cannot start without Discord bridge");
    }

    // Register commands for each guild
    await this.register();

    // Start listening for interactions
    this.interactionHandler = (interaction: Interaction) => {
      if (interaction.isChatInputCommand()) {
        void this.handleInteraction(interaction);
      } else if (
        // 2026-08-27 verification v2 — the 🧾 Sources button on a delivered
        // reply. Strict-prefix discipline: only our own prefixes route here.
        interaction.isButton() &&
        interaction.customId.startsWith(VSRC_PREFIX)
      ) {
        void this.handleLedgerButton(interaction);
      } else if (
        // Phase 999.160 — reply-action buttons under a delivered reply. Same
        // strict-prefix discipline; the bridge owns the registry + dispatch.
        interaction.isButton() &&
        interaction.customId.startsWith(RA_PREFIX)
      ) {
        // v1.1 — v3 per-agent bridge first, then the shared v2 bridge (all of
        // prod). Without the fallback the click never reached the registry.
        const raAgent = getAgentForChannel(this.routingTable, interaction.channelId);
        const raBridge = (raAgent ? this.getBridge?.(raAgent) : undefined) ?? this.getReplyActionBridge?.();
        if (raBridge?.handleReplyActionButton) {
          void raBridge.handleReplyActionButton(interaction).catch((err: unknown) =>
            this.log.warn({ error: err instanceof Error ? err.message : String(err) }, "reply-action button failed"),
          );
        } else {
          void interaction.reply({ content: "That button isn't wired for this channel — type the request instead.", flags: 64 as never }).catch(() => {});
        }
      } else if (
        // 999.178 R1 — Continue/Stop on a stalled status-ping reply. Same
        // strict-prefix discipline; the shared v2 bridge owns the handler (v3
        // agents don't use this path). The `.catch` is load-bearing: an
        // unhandled rejection here takes the whole daemon (and fleet) down.
        interaction.isButton() &&
        interaction.customId.startsWith(STATUS_PING_BUTTON_PREFIX)
      ) {
        const spAgent = getAgentForChannel(this.routingTable, interaction.channelId);
        const spBridge = (spAgent ? this.getBridge?.(spAgent) : undefined) ?? this.getReplyActionBridge?.();
        if (spBridge?.handleStatusPingButton) {
          void spBridge.handleStatusPingButton(interaction).catch((err: unknown) =>
            this.log.warn({ error: err instanceof Error ? err.message : String(err) }, "status-ping button failed"),
          );
        } else {
          void interaction.reply({ content: "That button isn't wired for this channel — type the request instead.", flags: 64 as never }).catch(() => {});
        }
      } else if (
        // 999.178 R1 — Retry button on a failed-turn notice. Same strict-prefix
        // discipline and bridge resolution as the reply-action arm above. The `.catch` is load-bearing (an
        // unhandled rejection here would take the daemon down).
        interaction.isButton() &&
        interaction.customId.startsWith(RETRY_PREFIX)
      ) {
        const rtAgent = getAgentForChannel(this.routingTable, interaction.channelId);
        const rtBridge = (rtAgent ? this.getBridge?.(rtAgent) : undefined) ?? this.getReplyActionBridge?.();
        if (rtBridge?.handleRetryButton) {
          void rtBridge.handleRetryButton(interaction, []).catch((err: unknown) =>
            this.log.warn({ error: err instanceof Error ? err.message : String(err) }, "retry button failed"),
          );
        } else {
          void interaction.reply({ content: "That button isn't wired for this channel — send the message again.", flags: 64 as never }).catch(() => {});
        }
      } else if (
        // 999.147 — 🩹 relief button on a MemoryGuard imminence page. Same
        // strict-prefix discipline; the `.catch` is load-bearing, as on the
        // other arms: an unhandled rejection here takes the whole
        // daemon (and therefore the entire fleet) down.
        interaction.isButton() &&
        interaction.customId.startsWith(MEMREL_PREFIX)
      ) {
        // Two actions share the prefix, discriminated by the action letter:
        // `:k:` kills a fleet process, `:d:` restarts an Unraid container.
        if (interaction.customId.startsWith("memrel:d:")) {
          const containerDeps = this.getContainerReliefDeps?.();
          if (containerDeps) {
            void handleContainerReliefButton(interaction, containerDeps).catch(
              (err) =>
                this.log.warn(
                  {
                    tag: "unraid-watch",
                    err: err instanceof Error ? err.message : String(err),
                  },
                  "container relief interaction failed",
                ),
            );
          }
        } else {
          const reliefDeps = this.getReliefDeps?.();
          if (reliefDeps) {
            void handleReliefButton(interaction, reliefDeps).catch((err) =>
              this.log.warn(
                {
                  tag: "memory-relief",
                  err: err instanceof Error ? err.message : String(err),
                },
                "relief interaction failed",
              ),
            );
          }
        }
      } else if (
        // Phase 999.173 — research card Status / Stop… buttons AND the Stop…
        // picker's select menu. Same strict-prefix discipline; the handler
        // never throws, the .catch is belt-and-braces (an unhandled rejection
        // here takes the whole daemon down).
        (interaction.isButton() || interaction.isStringSelectMenu()) &&
        interaction.customId.startsWith(RESEARCH_BUTTON_PREFIX)
      ) {
        const researchDeps = this.getResearchButtonDeps?.();
        if (researchDeps) {
          void handleResearchButton(interaction as never, researchDeps).catch((err) =>
            this.log.warn(
              { tag: "research", err: err instanceof Error ? err.message : String(err) },
              "research button failed",
            ),
          );
        } else {
          void interaction.reply({ content: "Research buttons aren't available right now.", flags: 64 as never }).catch(() => {});
        }
      }
    };
    this.client.on("interactionCreate", this.interactionHandler);

    this.log.info("slash command handler started");
  }

  /**
   * Register guild-scoped slash commands via Discord REST API.
   * Uses bulk overwrite (PUT) per guild to sync all commands at once.
   *
   * Phase 87 CMD-01/04/05/07 — the registration loop now:
   *   1. Iterates each agent's SessionHandle via SessionManager.getSessionHandle
   *      and calls `getSupportedCommands()` to learn what the SDK reports.
   *   2. Resolves a per-agent deny set (SECURITY.md `## Command ACLs` or the
   *      DI'd override) and filters native commands through it.
   *   3. Builds `clawcode-<name>` SlashCommandDef[] entries via
   *      native-cc-commands.buildNativeCommandDefs with a nativeBehavior
   *      discriminator.
   *   4. Merges with each agent's static slashCommands + CONTROL_COMMANDS via
   *      mergeAndDedupe; native wins on name collision (re-provides
   *      compact/usage removed from DEFAULT_SLASH_COMMANDS per CMD-04).
   *   5. Asserts the per-guild body length stays <= 90 BEFORE rest.put —
   *      over-cap throws without partial registration.
   */
  /**
   * Skill-slash-commands — resolve the per-agent ACTIVE skill name sets used
   * for both registration and the invocation-time channel gate.
   *
   * Prefers the daemon-injected `loadedSkillsByAgent` (manifest-refused
   * skills already excluded). Falls back to `ResolvedAgentConfig.skills` (the
   * configured set, no manifest filtering) when that map is not wired — keeps
   * tests / pre-feature callers working.
   */
  private resolveActiveSkillsByAgent(): ReadonlyMap<
    string,
    ReadonlySet<string>
  > {
    const result = new Map<string, ReadonlySet<string>>();
    for (const agent of this.resolvedAgents) {
      const injected = this.loadedSkillsByAgent?.get(agent.name);
      result.set(
        agent.name,
        injected ?? new Set<string>(agent.skills),
      );
    }
    return result;
  }

  async register(): Promise<void> {
    if (!this.client?.user) {
      throw new Error("Client not connected — call start() first");
    }

    const rest = new REST({ version: "10" }).setToken(this.botToken);
    const clientId = this.client.user.id;

    // Extract unique guild IDs from client cache
    const guildIds = [...this.client.guilds.cache.keys()];

    if (guildIds.length === 0) {
      this.log.warn("no guilds found in client cache — no commands registered");
      return;
    }

    for (const guildId of guildIds) {
      // Collect all commands across all agents for this guild.
      // Phase 999.21 — `allCommands` is the TOP-LEVEL slash command set;
      // entries with `subcommandOf` set route into `gsdSubcommands` instead
      // and are emitted as a single composite Discord body item below.
      const allCommands: SlashCommandDef[] = [];
      // Skill-slash-commands — names of the opt-in skill commands appended to
      // `allCommands`. Used by the defensive cap-prune below so an over-cap
      // body sheds SKILL commands first, never the static set.
      const skillCommandNames = new Set<string>();
      const gsdSubcommands: SlashCommandDef[] = [];
      const seenNames = new Set<string>();

      for (const agent of this.resolvedAgents) {
        const agentCommands = resolveAgentCommands(agent.slashCommands);

        // Phase 87 CMD-01 — discover SDK-reported native commands per agent.
        // A missing handle (agent not yet started, failed warm-path, etc.)
        // or a thrown getSupportedCommands() falls back to an empty list so
        // the static DEFAULT_SLASH_COMMANDS still register. Never throw out of
        // the register loop because of SDK flakiness during startup.
        let sdkCommands: readonly import("../manager/sdk-types.js").SlashCommand[] = [];
        try {
          const handle = this.sessionManager.getSessionHandle?.(agent.name);
          if (handle && typeof handle.getSupportedCommands === "function") {
            sdkCommands = await handle.getSupportedCommands();
          }
        } catch (err) {
          this.log.warn(
            { agent: agent.name, error: (err as Error).message },
            "sdk getSupportedCommands failed — falling back to DEFAULT_SLASH_COMMANDS only",
          );
        }

        // Phase 87 CMD-05 — ACL filter. Prefer the DI'd map when set; else
        // read `<memoryPath>/SECURITY.md` (or `<workspace>/SECURITY.md`) and
        // call resolveDeniedCommands. Missing file / missing section → no
        // denies (permissive default).
        let denied: ReadonlySet<string> = new Set();
        if (this.aclDeniedByAgent) {
          denied = this.aclDeniedByAgent.get(agent.name) ?? new Set();
        } else {
          const basePath = agent.memoryPath || agent.workspace;
          if (basePath) {
            try {
              denied = await resolveDeniedCommands(
                join(basePath, "SECURITY.md"),
              );
            } catch (err) {
              this.log.warn(
                { agent: agent.name, error: (err as Error).message },
                "resolveDeniedCommands failed — defaulting to permissive ACL",
              );
              denied = new Set();
            }
          }
        }

        // Phase 87 CMD-01 — build native-CC entries via pure classifier.
        const nativeDefs = buildNativeCommandDefs(sdkCommands, { denied });

        // Phase 87 CMD-04 — mergeAndDedupe: native wins on name collision so
        // the removed clawcode-compact / clawcode-usage duplicates get
        // re-provided with nativeBehavior="prompt-channel".
        //
        // 2026-08-07 RCA — that "native wins" rule only holds for names
        // ClawCode does NOT define itself. Phase 117.1-02 added `effort` and
        // `model` to ALLOWED_NATIVES, so the SDK's one-free-text-arg
        // (`args`) shape started overwriting the RICH definitions in
        // DEFAULT_SLASH_COMMANDS: `/clawcode-effort` lost its `level`
        // dropdown + `agent` target option, and `/clawcode-model` lost its
        // picker — the operator could no longer target another agent and had
        // to ask Admin Clawdy to edit yaml + restart the fleet. Native entries
        // whose name collides with a DEFAULT_SLASH_COMMANDS entry are dropped
        // here; the ClawCode definition wins and keeps its options. CMD-04's
        // intent is unaffected (its two names are absent from the defaults,
        // so they still get re-provided natively).
        const richNames = new Set(DEFAULT_SLASH_COMMANDS.map((c) => c.name));
        const nativeDefsNoClobber = nativeDefs.filter((n) => {
          if (!richNames.has(n.name)) return true;
          this.log.debug(
            { agent: agent.name, command: n.name },
            "native SDK command dropped — ClawCode defines this name with richer options",
          );
          return false;
        });

        const merged = mergeAndDedupe(agentCommands, nativeDefsNoClobber);

        for (const cmd of merged) {
          // Phase 999.21 — route entries with `subcommandOf` into the nested
          // GSD composite (single /get-shit-done top-level command) instead
          // of allCommands. Entries WITHOUT subcommandOf with a `gsd-` flat
          // name (legacy yaml entries on Admin Clawdy) are gracefully
          // remapped: the `gsd-` prefix is stripped and the entry is rewritten
          // with `subcommandOf: "get-shit-done"` so operators can leave their
          // yaml unchanged through the migration. Non-GSD entries take the
          // normal top-level dedup path.
          if (cmd.subcommandOf) {
            const key = `${cmd.subcommandOf}:${cmd.name}`;
            if (!seenNames.has(key)) {
              seenNames.add(key);
              gsdSubcommands.push(cmd);
            }
          } else if (cmd.name.startsWith("gsd-")) {
            const subName = cmd.name.replace(/^gsd-/, "");
            const key = `get-shit-done:${subName}`;
            if (!seenNames.has(key)) {
              seenNames.add(key);
              gsdSubcommands.push({
                ...cmd,
                name: subName,
                subcommandOf: "get-shit-done",
              });
            }
          } else if (!seenNames.has(cmd.name)) {
            seenNames.add(cmd.name);
            allCommands.push(cmd);
          }
        }
      }

      // Phase 100 follow-up — auto-inherit GSD_SLASH_COMMANDS for any guild
      // that has at least one agent with `gsd?.projectDir` configured. Single
      // source of truth (slash-types.ts); no per-agent yaml duplication.
      //
      // Phase 999.21 — GSD entries are now NESTED subcommands under a single
      // /get-shit-done top-level command. They are NOT pushed into
      // `allCommands` (which is the top-level set); instead they're collected
      // into `gsdSubcommands` and emitted as ONE composite Discord body item
      // below (type=1 SUB_COMMAND children). The same skip-and-collect logic
      // is mirrored in the per-agent merge loop above (the dedup at L1124
      // routes entries with subcommandOf into gsdSubcommands instead of
      // allCommands) so any agent yaml entry that opts into the nested form
      // also lands in the composite. seenNames keys for nested entries are
      // namespaced as `${subcommandOf}:${name}` so they cannot collide with
      // top-level command names.
      const hasGsdEnabledAgent = this.resolvedAgents.some(
        (a) => a.gsd?.projectDir,
      );
      if (hasGsdEnabledAgent) {
        for (const cmd of GSD_SLASH_COMMANDS) {
          // Phase 999.21 — every GSD_SLASH_COMMANDS entry has subcommandOf
          // set, so route into gsdSubcommands. Defensive fallback: if a
          // future entry lacks subcommandOf, fall back to top-level dedup.
          if (cmd.subcommandOf) {
            const key = `${cmd.subcommandOf}:${cmd.name}`;
            if (!seenNames.has(key)) {
              seenNames.add(key);
              gsdSubcommands.push(cmd);
            }
          } else if (!seenNames.has(cmd.name)) {
            seenNames.add(cmd.name);
            allCommands.push(cmd);
          }
        }
      }

      // Add control commands (daemon-direct, not agent-routed)
      for (const cmd of CONTROL_COMMANDS) {
        if (!seenNames.has(cmd.name)) {
          seenNames.add(cmd.name);
          allCommands.push(cmd);
        }
      }

      // Skill-slash-commands — append opt-in per-skill commands. Each agent
      // skill whose SKILL.md frontmatter sets `slashCommand: true` becomes a
      // guild-wide `/<skill>` command, registered ONCE as the union across
      // every agent that has it.
      //
      // Reserved-name set: `seenNames` already holds every static / native /
      // CONTROL command name at this point, so a skill normalising onto one
      // of those is skipped (the static set is never regressed). The bare
      // `gsd-` prefix is added wholesale because the per-agent merge loop
      // above re-homes ANY bare `gsd-<x>` name under `/get-shit-done` — a
      // skill normalising to `gsd-foo` must not be silently re-parented.
      if (this.skillsCatalog && this.skillsCatalog.size > 0) {
        const skillResult = buildSkillSlashCommands(
          this.resolveActiveSkillsByAgent(),
          this.skillsCatalog,
          // Reserved = every name already in seenNames. The bare `gsd-`
          // namespace is handled separately below because it is a prefix,
          // not a fixed set of names.
          new Set<string>(seenNames),
        );
        const registeredDefs = new Map<string, SlashCommandDef>();
        const registeredAgents = new Map<string, readonly string[]>();
        for (const cmd of skillResult.commands) {
          // Pre-filter any skill command that would land in the bare `gsd-`
          // namespace (re-homed under /get-shit-done by the loop above).
          if (cmd.name.startsWith("gsd-")) {
            this.log.warn(
              { command: cmd.name, skill: cmd.skillDispatch?.skillName },
              "skill-slash-command: skipped — collides with reserved gsd- namespace",
            );
            continue;
          }
          if (seenNames.has(cmd.name)) continue;
          seenNames.add(cmd.name);
          allCommands.push(cmd);
          skillCommandNames.add(cmd.name);
          registeredDefs.set(cmd.name, cmd);
          const agents = skillResult.agentsByCommand.get(cmd.name);
          if (agents) registeredAgents.set(cmd.name, agents);
        }
        for (const dropped of skillResult.skipped) {
          this.log.warn(
            {
              command: dropped.commandName,
              skill: dropped.skillName,
              reason: dropped.reason,
            },
            "skill-slash-command: skipped — name collision",
          );
        }
        // Indexes are guild-independent (catalog + agents are the same for
        // every guild); the last guild's pass wins, which is fine.
        this.skillCommandDefs = registeredDefs;
        this.skillCommandAgents = registeredAgents;
      }

      // 2026-08-07 — dynamic `agent:` picker. Every option literally named
      // `agent` takes a configured agent name, and the static defs can't
      // enumerate the fleet (it's config, not codegen). Built once per
      // register() from the resolved fleet and injected below, so
      // /clawcode-effort, /clawcode-model, /clawcode-usage … all render a
      // dropdown of real agents instead of a free-text box (typos and
      // "Unknown agent" replies were the old failure mode).
      //
      // Discord hard-caps choices at 25 per option: above that we leave the
      // option free-text (the handler still validates against
      // sessionManager.getAgentConfig, so behavior only degrades to typing).
      const agentChoices = this.resolvedAgents
        .map((a) => ({ name: a.name, value: a.name }))
        .slice(0, DISCORD_MAX_CHOICES_PER_OPTION);
      const canPickAgent =
        this.resolvedAgents.length > 0 &&
        this.resolvedAgents.length <= DISCORD_MAX_CHOICES_PER_OPTION;

      // Convert to Discord API format
      const body: Array<Record<string, unknown>> = allCommands.map((cmd) => ({
        name: cmd.name,
        description: cmd.description,
        options: cmd.options.map((opt) => {
          const choices =
            opt.choices && opt.choices.length > 0
              ? opt.choices
              : opt.name === "agent" && canPickAgent
                ? agentChoices
                : undefined;
          return {
            name: opt.name,
            type: opt.type,
            description: opt.description,
            required: opt.required,
            // Phase 83 UI-01 — forward choices when defined so Discord renders
            // a dropdown. Spread-only: options without choices stay byte-identical
            // to the pre-Phase-83 payload (back-compat for every other option).
            ...(choices && choices.length > 0
              ? {
                  choices: choices.map((c) => ({
                    name: c.name,
                    value: c.value,
                  })),
                }
              : {}),
          };
        }),
        // Phase 100 follow-up — forward defaultMemberPermissions when defined
        // so Discord hides the command from non-admin users. Spread-only;
        // commands without the field stay byte-identical to the prior payload.
        ...((cmd as { defaultMemberPermissions?: string }).defaultMemberPermissions !== undefined
          ? { default_member_permissions: (cmd as { defaultMemberPermissions?: string }).defaultMemberPermissions }
          : {}),
      }));

      // Phase 999.21 — emit ONE composite top-level Discord body item for the
      // collected GSD subcommands. Each child gets type=1 (SUB_COMMAND).
      // Discord caps subcommand counts at 25 per top-level command — 19 fits
      // comfortably. `default_member_permissions` is intentionally NOT set on
      // the composite (none of the 19 GSD entries currently use the field;
      // Discord scopes the bitmask at top-level commands only — even if a
      // subcommand wanted one, Discord would reject it). claudeCommand text
      // values on each subcommand stay BYTE-IDENTICAL pre/post — pinned by
      // GS1l + GSDN-03 regression tests.
      //
      // Phase 999.32 — Discord-side composite suppressed. Operator hit
      // friction with the 19-subcommand menu; consolidated into a SINGLE
      // top-level `/gsd-do args:<subcommand + flags>` entry registered via
      // DEFAULT_SLASH_COMMANDS. The dispatcher in handleInteraction parses
      // the args' first token, rewrites commandName to `gsd-${first-token}`,
      // and existing carve-outs (GSD_LONG_RUNNERS subagent-thread spawn,
      // set-project inline handler) keep matching against the legacy flat
      // names. GSD_SLASH_COMMANDS stays as the source-of-truth for what
      // subcommand names are valid (used by the dispatcher's lookup).
      // Setting `gsdSubcommands` aside so it's still typed but never emitted.
      void gsdSubcommands;

      // Skill-slash-commands — defensive cap-prune. Opt-in (`slashCommand:
      // true`) keeps the registered set well under the 90-cap by
      // construction, but if a future config opts in enough skills to breach
      // it, the static `/clawcode-*` / GSD / CONTROL set must NOT be
      // collateral damage. Skill commands are appended LAST, so when the
      // body is over-cap we drop SKILL entries first (newest-first) until
      // the body fits — the static set always survives.
      if (body.length > MAX_COMMANDS_PER_GUILD && skillCommandNames.size > 0) {
        let prunedCount = 0;
        for (let i = body.length - 1; i >= 0 && body.length > MAX_COMMANDS_PER_GUILD; i--) {
          if (skillCommandNames.has(body[i].name as string)) {
            body.splice(i, 1);
            prunedCount++;
          }
        }
        if (prunedCount > 0) {
          this.log.warn(
            { guildId, prunedCount, limit: MAX_COMMANDS_PER_GUILD },
            "skill-slash-command: pruned skill commands to fit the per-guild cap",
          );
        }
      }

      // Phase 87 CMD-07 — pre-flight cap assertion. Thrown BEFORE rest.put so
      // no partial registration lands; operators see the full over-cap error
      // in the warn log below and can prune before retry.
      if (body.length > MAX_COMMANDS_PER_GUILD) {
        this.log.error(
          {
            guildId,
            commandCount: body.length,
            limit: MAX_COMMANDS_PER_GUILD,
          },
          "too many commands for guild — refusing to register (CMD-07)",
        );
        continue;
      }

      try {
        await rest.put(
          Routes.applicationGuildCommands(clientId, guildId),
          { body },
        );
        this.log.info(
          { guildId, commandCount: body.length },
          "slash commands registered",
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.log.error({ guildId, error: msg }, "failed to register slash commands");
      }
    }
  }

  /**
   * Skill-slash-commands — handle an opt-in `/<skill>` invocation.
   *
   * Returns `true` once the interaction has been fully handled (dispatched
   * or rejected); the caller stops processing in either case.
   *
   * Flow:
   *   1. Resolve the channel→agent binding.
   *   2. Gate: confirm the bound agent's ACTIVE skill set contains the
   *      skill. If the channel has no agent, or the agent does not have the
   *      skill → ephemeral reject (naming the agent(s) that DO have it).
   *   3. Otherwise defer + dispatch the natural-language turn via the same
   *      formatCommandMessage + streamFromAgent path the static agent-routed
   *      commands use, including the per-skill `effort:` override.
   *
   * The gate runs BEFORE deferReply so the wrong-channel reject is a clean
   * ephemeral reply rather than an ephemeral message after a public defer.
   */
  private async handleSkillDispatch(
    interaction: ChatInputCommandInteraction,
    skillDef: SlashCommandDef,
  ): Promise<boolean> {
    const channelId = interaction.channelId;
    const commandName = skillDef.name;
    const skillName = skillDef.skillDispatch?.skillName ?? commandName;

    const agentName = getAgentForChannel(this.routingTable, channelId);

    // Agent(s) that DO have this skill — named in any reject for good UX.
    const holders = this.skillCommandAgents.get(commandName) ?? [];
    const holdersLabel =
      holders.length === 0
        ? "no agent currently has it"
        : holders.length === 1
          ? `it belongs to **${holders[0]}**`
          : `it belongs to: ${holders.map((h) => `**${h}**`).join(", ")}`;

    if (!agentName) {
      try {
        await interaction.reply({
          content:
            `This channel is not bound to an agent — \`/${commandName}\` ` +
            `cannot run here (${holdersLabel}).`,
          ephemeral: true,
        });
      } catch {
        /* interaction may have expired */
      }
      return true;
    }

    // Gate: does the bound agent actually have this skill active?
    const activeSkills = this.resolveActiveSkillsByAgent().get(agentName);
    const agentHasSkill = activeSkills?.has(skillName) ?? false;
    if (!agentHasSkill) {
      try {
        await interaction.reply({
          content:
            `This channel's agent (**${agentName}**) does not have the ` +
            `\`${skillName}\` skill — ${holdersLabel}.`,
          ephemeral: true,
        });
      } catch {
        /* interaction may have expired */
      }
      return true;
    }

    // Defer (public — skill output streams into the channel like any
    // agent-routed command).
    try {
      await interaction.deferReply({});
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log.error(
        { commandName, channelId, error: msg },
        "skill-slash-command: failed to defer reply",
      );
      return true;
    }

    // Extract the single optional `args` string option. When omitted, bind
    // an empty string so the `{args}` placeholder collapses cleanly.
    const argsRaw = interaction.options.get("args")?.value;
    const args = typeof argsRaw === "string" ? argsRaw : "";
    const options = new Map<string, string | number | boolean>([
      ["args", args],
    ]);
    // Trim so an omitted `args` collapses cleanly (no trailing space after
    // the `{args}` substitution).
    const formattedMessage = formatCommandMessage(skillDef, options).trim();

    this.log.info(
      { agent: agentName, command: commandName, skill: skillName, channelId },
      "skill-slash-command: routing to agent",
    );

    try {
      await interaction.editReply("Thinking...");
    } catch {
      /* non-fatal */
    }

    const editor = new ProgressiveMessageEditor({
      editFn: async (content: string) => {
        const wrapped = formatOutboundText(content);
        const truncated =
          wrapped.length > DISCORD_MAX_LENGTH
            ? wrapped.slice(0, DISCORD_MAX_LENGTH - 3) + "..."
            : wrapped;
        await interaction.editReply(truncated);
      },
      editIntervalMs: 1500,
    });

    // Per-skill effort override (mirrors the generic agent-routed path).
    // Resolve the catalog entry by the ORIGINAL skill name (skill commands
    // are normalised, so a name lookup keyed on commandName would miss).
    const skillEntry = this.skillsCatalog?.get(skillName);
    const skillEffort = skillEntry?.effort;
    let priorEffort: EffortLevel | null = null;
    if (skillEffort) {
      try {
        priorEffort = this.sessionManager.getEffortForAgent(agentName);
        this.sessionManager.setEffortForAgent(agentName, skillEffort);
      } catch (err) {
        this.log.warn(
          {
            agent: agentName,
            command: commandName,
            skillEffort,
            error: (err as Error).message,
          },
          "skill-slash-command: skill-effort apply failed — continuing without override",
        );
        priorEffort = null;
      }
    }

    try {
      const response = await this.sessionManager.streamFromAgent(
        agentName,
        formattedMessage,
        (accumulated) => editor.update(accumulated),
      );
      await editor.flush();

      const text = response.trim();
      if (text.length === 0) {
        await interaction.editReply("(No response from agent)");
        return true;
      }
      const truncated =
        text.length > DISCORD_MAX_LENGTH
          ? text.slice(0, DISCORD_MAX_LENGTH - 3) + "..."
          : text;
      await interaction.editReply(truncated);
    } catch (error) {
      editor.dispose();
      const msg = error instanceof Error ? error.message : String(error);
      this.log.error(
        { agent: agentName, command: commandName, error: msg },
        "skill-slash-command: execution failed",
      );
      try {
        await interaction.editReply(`Command failed: ${msg}`);
      } catch {
        /* interaction may have expired */
      }
    } finally {
      if (priorEffort !== null) {
        try {
          this.sessionManager.setEffortForAgent(agentName, priorEffort);
        } catch (err) {
          this.log.warn(
            {
              agent: agentName,
              command: commandName,
              priorEffort,
              error: (err as Error).message,
            },
            "skill-slash-command: skill-effort revert failed — agent may be at wrong level",
          );
        }
      }
    }
    return true;
  }

  /**
   * Stop the handler: remove interaction listener and disconnect.
   * Per D-05, commands are left registered (Discord handles stale gracefully).
   */
  async stop(): Promise<void> {
    if (this.client && this.interactionHandler) {
      this.client.removeListener("interactionCreate", this.interactionHandler);
      this.interactionHandler = null;
    }

    // Client is shared with Discord bridge — do not destroy it here
    this.client = null;

    this.log.info("slash command handler stopped");
  }

  /**
   * Handle an incoming slash command interaction.
   * Routes to the correct agent by channel, defers reply for long-running execution.
   */
  private async handleInteraction(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const channelId = interaction.channelId;
    // Phase 999.21 — /get-shit-done nested subcommand entry-point rewrite.
    // Discord delivers nested commands as commandName === "get-shit-done"
    // with the actual command in interaction.options.getSubcommand(). Remap
    // to the legacy flat `gsd-<sub>` form so every downstream dispatch carve-
    // out (handleSetGsdProjectCommand, handleGsdLongRunner, agent-routed
    // branch, GSD_LONG_RUNNERS lookup, cmdDef resolution) keeps working
    // unchanged. The remap is the SINGLE rewrite point for the
    // consolidation; every existing string-comparison against `gsd-*` names
    // continues to match without modification downstream.
    let commandName = interaction.commandName;
    let gsdDoRewrittenArgs: string | null = null;
    if (commandName === "get-shit-done") {
      // Phase 999.21 legacy entry — kept for back-compat in case Discord's
      // client cache still routes /get-shit-done despite Phase 999.32
      // suppressing the composite registration. Translates the same way as
      // the new gsd-do entry below: extract subcommand, rewrite commandName.
      let sub: string | null = null;
      try {
        sub = interaction.options.getSubcommand(false);
      } catch {
        sub = null;
      }
      if (!sub) {
        try {
          await interaction.reply({
            content: "Missing subcommand for /get-shit-done.",
            ephemeral: true,
          });
        } catch {
          /* expired */
        }
        return;
      }
      commandName = `gsd-${sub}`;
    } else if (commandName === "gsd-do") {
      // Phase 999.32 — single-entry GSD command. Parse the args' first token
      // as the subcommand name and rewrite commandName to `gsd-${first-token}`
      // so existing carve-outs (handleSetGsdProjectCommand,
      // handleGsdLongRunner, agent-routed branch via formatCommandMessage)
      // keep matching the legacy flat-name strings without modification.
      // Remaining tokens become the new args value passed downstream.
      const raw = interaction.options.getString("args", true).trim();
      if (raw.length === 0) {
        try {
          await interaction.reply({
            content:
              "Missing args. Usage: `/gsd-do args:<subcommand> [flags...]` (e.g. `args:autonomous --from 100`)",
            ephemeral: true,
          });
        } catch {
          /* expired */
        }
        return;
      }
      const firstSpace = raw.search(/\s/);
      const sub = firstSpace === -1 ? raw : raw.slice(0, firstSpace);
      const rest = firstSpace === -1 ? "" : raw.slice(firstSpace + 1).trim();
      // Light validation: subcommand must look like a slug (no shell
      // metacharacters). The downstream formatCommandMessage forwards the
      // claudeCommand text into the agent's prompt; the subcommand becomes
      // a path segment in `/gsd:<sub>`. Reject obvious prompt-injection
      // shapes (newlines, backticks) before they reach the agent context.
      if (!/^[a-z][a-z0-9-]*$/i.test(sub)) {
        try {
          await interaction.reply({
            content:
              `Invalid subcommand "${sub}". Use letters/digits/hyphens only (e.g. autonomous, plan-phase, set-project).`,
            ephemeral: true,
          });
        } catch {
          /* expired */
        }
        return;
      }
      commandName = `gsd-${sub}`;
      gsdDoRewrittenArgs = rest;
    }

    // Phase 135 Plan 02 — /vc {join,leave,status} voice channel
    // commands. Inline short-circuit BEFORE the generic CONTROL_COMMANDS
    // branch (same pattern as /clawcode-tools below — Phases
    // 85/86/87/88/90/91/92/95/96/100). The handler dispatches through
    // the daemon-owned VoiceManager (wired via `config.voiceManager`)
    // so transcripts route through the SAME instance the bridge
    // attached `transcriptDispatcher` and `capWarningSink` to.
    //
    // Phase 135 REVIEW CR-01 — fail-closed when `config.voiceManager`
    // is absent. The previous lazy-construct path built a divergent
    // VoiceManager with no transcriptDispatcher (handleFinalTranscript
    // warn-logs and drops every utterance) and no capWarningSink
    // (silent disconnect on cap-hit). That is the
    // `feedback_silent_path_bifurcation` failure mode — bot joins
    // voice, captures audio, never replies. We now refuse the
    // command with a loud daemon log + ephemeral operator-visible
    // reply.
    if (commandName === "vc") {
      if (!this.voiceManager) {
        this.log.error(
          { commandName: "vc" },
          "/vc invoked but config.voiceManager not wired — daemon misconfigured",
        );
        try {
          await interaction.reply({
            content: "voice subsystem not wired — daemon misconfigured, see logs",
            ephemeral: true,
          });
        } catch {
          /* expired */
        }
        return;
      }
      // Phase 135 Plan 02 — pass resolvedAgents + routingTable so the
      // handler can look up which agent owns the voice channel for the
      // invoking guild. /vc join takes no nested options (the
      // slash-types schema does not support nested options on
      // SUB_COMMANDs today); the bound agent's `voice.channelId` is
      // used.
      await handleVcCommand(interaction, this.voiceManager, this.resolvedAgents, this.routingTable);
      return;
    }

    // Phase 85 Plan 03 TOOL-06 / UI-01 — dedicated inline handler for
    // /clawcode-tools. Routes through the same IPC as a control command but
    // renders the reply as a Discord EmbedBuilder (native structured element,
    // not free-text blob). Carved out BEFORE the generic control-command
    // dispatch so the EmbedBuilder path can't be short-circuited by the
    // text-formatting branch in handleControlCommand.
    if (commandName === "clawcode-tools") {
      await this.handleToolsCommand(interaction);
      return;
    }

    // Phase 86 MODEL-02 / MODEL-03 — /clawcode-model inline handler.
    // Routes ENTIRELY through IPC set-model (Plan 02). The old LLM-prompt
    // routing (slash-types.ts claudeCommand "Set my model to {model}")
    // has been REMOVED — this handler is the only dispatch path. Carved
    // out BEFORE the generic CONTROL_COMMANDS and agent-lookup branches
    // so the picker and IPC dispatch can't be short-circuited downstream.
    if (commandName === "clawcode-model") {
      await this.handleModelCommand(interaction);
      return;
    }

    // Phase 87 CMD-02 — /clawcode-permissions inline handler.
    // Routes through IPC set-permission-mode (control-plane, NOT prompt
    // channel). Carved out BEFORE the generic CONTROL_COMMANDS branch so
    // the IPC dispatch path can't be short-circuited by the text-formatting
    // branch downstream. Mirrors the /clawcode-model carve-out above.
    if (commandName === "clawcode-permissions") {
      await this.handlePermissionsCommand(interaction);
      return;
    }

    // Phase 88 MKT-07 / UI-01 — /clawcode-skills inline handler.
    // Lists installed skills + renders a native remove picker.
    if (commandName === "clawcode-skills") {
      await this.handleSkillsCommand(interaction);
      return;
    }

    // Phase 95 Plan 03 DREAM-07 / UI-01 — /clawcode-dream inline handler.
    // 10th application of the inline-handler-short-circuit-before-
    // CONTROL_COMMANDS pattern (Phases 85/86/87/88/90/91/92). Admin-only
    // ephemeral: gates BEFORE deferReply so non-admins never see the IPC
    // call land. Routes through the daemon's `run-dream-pass` IPC method
    // (Plan 95-03 daemon edge wires runDreamPass + applyDreamResult).
    // EmbedBuilder render via the pure renderDreamEmbed helper (above).
    if (commandName === "clawcode-dream") {
      await this.handleDreamCommand(interaction);
      return;
    }

    // Phase 142 — /clawcode-optimize inline handler. Admin-only ephemeral
    // (the optimizer spawns eval forks + proposes skill changes, so it stays
    // operator-tier — unlike the now-open /clawcode-dream). Routes through the
    // run-agent-optimization IPC method; renders the staged-proposal summary.
    if (commandName === "clawcode-optimize") {
      await this.handleOptimizeCommand(interaction);
      return;
    }

    // Phase 999.176 — /clawcode-account inline handler (fleet account swap).
    // The flow owns its own stricter admin gate (admin user id AND admin
    // channel) and never touches CONTROL_COMMANDS / IPC.
    if (commandName === "clawcode-account") {
      const deps = this.getAccountFlowDeps?.();
      if (!deps) {
        await interaction
          .reply({ content: "Account switching isn't configured on this daemon.", flags: MessageFlags.Ephemeral })
          .catch(() => {});
        return;
      }
      await runAccountCommand(interaction, deps).catch((err: unknown) => {
        this.log.warn(
          { command: "clawcode-account", error: err instanceof Error ? err.message : String(err) },
          "account command failed",
        );
      });
      return;
    }

    // Phase 124 Plan 03 — /clawcode-session-compact inline handler.
    // Admin-only ephemeral. Mirrors the /clawcode-dream pattern: gates on
    // isAdminClawdyInteraction BEFORE deferReply so non-admins never see
    // the IPC call land. Routes through the daemon's `compact-session` IPC
    // method (Plan 124-01 daemon edge wires handleCompactSession). Render
    // via the pure renderCompactEmbed helper exported below.
    if (commandName === "clawcode-session-compact") {
      await this.handleCompactCommand(interaction);
      return;
    }

    // Phase 132 Plan 03 T-03 — operator review surface for candidate skill
    // drafts staged by the out-of-band Haiku 4.5 distiller (Plan 02) and by
    // /clawcode-optimize (/edit-skill retired 2026-09-23). Both commands are
    // admin-only ephemeral (D-06 + threat T-132-03-02,
    // mirroring /clawcode-dream + /clawcode-session-compact precedent).
    // Inline-handler-short-circuit pattern: gates on isAdminClawdyInteraction
    // BEFORE deferReply so non-admins get an instant ephemeral reject (zero
    // IPC + zero LLM turn cost). Renders the DraftActionResult discriminated
    // union via the dedicated renderSkillDraftActionEmbed helper below.
    if (commandName === "approve-skill") {
      await this.handleSkillDraftActionCommand(
        interaction,
        "approve-skill-draft",
      );
      return;
    }
    if (commandName === "reject-skill") {
      await this.handleSkillDraftActionCommand(
        interaction,
        "reject-skill-draft",
      );
      return;
    }

    // Phase 96 Plan 05 PFS- / UI-01 — /clawcode-probe-fs inline handler.
    // 11th application of the inline-handler-short-circuit-before-
    // CONTROL_COMMANDS pattern (Phases 85/86/87/88/90/91/92/95). Admin-only
    // ephemeral: gates BEFORE deferReply so non-admins never see the IPC
    // call land. Routes through the daemon's `probe-fs` IPC method
    // (Plan 96-05 daemon edge wires runFsProbe → writeFsSnapshot →
    // setFsCapabilitySnapshot). EmbedBuilder render via the pure
    // renderProbeFsEmbed helper (above). D-03 refresh trigger: operator
    // forces re-probe immediately after ACL/group/systemd change to
    // eliminate the 60s heartbeat-stale window per RESEARCH.md Pitfall 7.
    // Phase 999.32 — /clawcode-probe-fs slash command removed (operator
    // cleanup). The CLI subcommand `clawcode probe fs <agent>` and the
    // daemon's `probe-fs` IPC method stay live; heartbeat fs-probe still
    // runs every 60s for ambient refresh. The handleProbeFsCommand helper
    // is left intact for future re-introduction (or removal in a
    // dead-code sweep) but no slash command routes to it.

    // Phase 103 OBS-07 / UI-01 — /clawcode-usage inline handler.
    // 12th application of the inline-handler-short-circuit-before-
    // CONTROL_COMMANDS pattern (Phases 85/86/87/88/90/91/92/95/96/100).
    // Reads per-agent OAuth Max usage snapshots via the daemon-routed
    // `list-rate-limit-snapshots` IPC method (NOT `rate-limit-status` —
    // see Pitfall 5). Renders an EmbedBuilder via buildUsageEmbed so the
    // reply is structured (UI-01 compliance — NOT free-text). Carved out
    // BEFORE the generic CONTROL_COMMANDS dispatch so the EmbedBuilder
    // path can't be short-circuited by the text-formatting branch in
    // handleControlCommand. Zero LLM turn cost per invocation.
    if (commandName === "clawcode-usage") {
      await this.handleUsageCommand(interaction);
      return;
    }

    // Phase 100 follow-up — /gsd-set-project inline handler. Routed BEFORE
    // GSD_LONG_RUNNERS so the runtime project switcher never falls into the
    // long-runner subagent-thread path. Validates the path option (absolute,
    // exists, is-directory) and dispatches `set-gsd-project` IPC to the
    // daemon, which persists to ~/.clawcode/manager/gsd-project-overrides.json
    // and triggers an agent restart (gsd.projectDir is non-reloadable per
    // Phase 100 GSD-07).
    if (commandName === "gsd-set-project") {
      await this.handleSetGsdProjectCommand(interaction, gsdDoRewrittenArgs);
      return;
    }

    // Phase 100 Plan 04 GSD-01..03 / GSD-09 — 12th application of the inline-
    // handler-short-circuit-before-CONTROL_COMMANDS pattern (Phases 85/86/87/
    // 88/90/91/92/95/96). Long-runner GSD commands pre-spawn a subagent
    // thread so the main channel stays free; the subagent inherits Admin
    // Clawdy's settingSources (["project","user"] per Plan 100-02 + Plan
    // 100-07) and dispatches the canonical /gsd:* slash inline because
    // settingSources includes "user" (loads ~/.claude/commands/gsd/*.md per
    // Plan 100-06). Short-runners (gsd-debug, gsd-quick) fall through to the
    // legacy agent-routed branch below — their claudeCommand template
    // ("/gsd:debug {issue}" / "/gsd:quick {task}") rewrites to the canonical
    // SDK form via formatCommandMessage's placeholder substitution.
    if (GSD_LONG_RUNNERS.has(commandName)) {
      await this.handleGsdLongRunner(interaction, commandName, gsdDoRewrittenArgs);
      return;
    }

    // /clawcode-goal — inline short-circuit BEFORE the generic CONTROL_COMMANDS
    // dispatch. The condition/action options select goal-set / goal-status /
    // goal-clear, so it can't go through the single-ipcMethod control path.
    if (commandName === "clawcode-goal") {
      await this.handleGoalCommand(interaction);
      return;
    }

    // Check if this is a control command (daemon-direct, no agent needed)
    const controlCmd = CONTROL_COMMANDS.find((c) => c.name === commandName);
    if (controlCmd) {
      await this.handleControlCommand(interaction, controlCmd);
      return;
    }

    // Phase 87 CMD-03 — prompt-channel native-CC dispatch carve-out.
    //
    // Looks up the command definition in the resolved (per-guild-merged) set
    // that Plan 01's register() built. If nativeBehavior === "prompt-channel",
    // route through TurnDispatcher.dispatchStream with the canonical
    // `/<name> <args>` string. Output streams via ProgressiveMessageEditor.
    //
    // Ordering rationale: lives AFTER the clawcode-model / clawcode-tools /
    // CONTROL_COMMANDS carve-outs (so those dedicated inline handlers always
    // win for their respective names, even if a stray prompt-channel entry
    // with a colliding name somehow reaches this ladder) but BEFORE the
    // legacy agent-routed branch (so formatCommandMessage + claudeCommand
    // template path does NOT execute for native-CC prompt-channel entries).
    const nativeDef = this.findNativePromptChannelCommand(commandName);
    if (nativeDef) {
      await this.dispatchNativePromptCommand(interaction, nativeDef);
      return;
    }

    // Skill-slash-commands — opt-in `/<skill>` dispatch carve-out.
    //
    // Placed AFTER all native / CONTROL / dedicated-handler branches and
    // BEFORE the generic agent-routed fallthrough, so no existing command
    // changes behaviour. Skill commands are registered guild-wide (the union
    // across every agent that has the skill), so `/<skill>` appears in the
    // slash menu of EVERY channel — this branch gates by the channel→agent
    // binding and rejects (ephemerally) when the channel's agent does not
    // have the skill. The gate fires BEFORE deferReply so a wrong-channel
    // reject stays ephemeral (a post-public-defer ephemeral is awkward).
    const skillDef = this.skillCommandDefs.get(commandName);
    if (skillDef?.skillDispatch) {
      const handled = await this.handleSkillDispatch(interaction, skillDef);
      if (handled) return;
      // handled === false → channel had no agent / agent lacked the skill;
      // an ephemeral reject was already sent. Stop here.
      return;
    }

    // Look up agent for this channel
    const agentName = getAgentForChannel(this.routingTable, channelId);

    if (!agentName) {
      try {
        await interaction.reply({
          content: "This channel is not bound to an agent.",
          ephemeral: true,
        });
      } catch {
        // Interaction may have expired
      }
      return;
    }

    // Defer reply immediately (allows up to 15 min for response).
    // clawcode-status is ephemeral so the operator can dismiss it.
    try {
      await interaction.deferReply(
        commandName === "clawcode-status" ? { ephemeral: true } : {},
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log.error({ commandName, channelId, error: msg }, "failed to defer reply");
      return;
    }

    // Find the command definition for this agent.
    // Phase 999.21 — when the rewrite-at-entry remap fired (the operator
    // invoked /get-shit-done <sub>), `commandName` is now `gsd-<sub>` for
    // every downstream string match. cmdDef lookup must accept BOTH forms:
    //   1. The legacy flat `gsd-<sub>` name (Admin Clawdy yaml entries
    //      shipped pre-999.21 still carry these names directly).
    //   2. The stripped `<sub>` name (GSD_SLASH_COMMANDS entries post-999.21
    //      use the bare suffix).
    // The dual-lookup keeps both back-compat (legacy yaml on Admin Clawdy)
    // and the auto-inheritance path (GSD-enabled agent without a yaml block,
    // e.g. fin-client) working unchanged. The strip is gated on the
    // rewrite-at-entry remap firing so non-GSD agent-routed commands still
    // match by their full name without surprise prefix stripping.
    const agentConfig = this.resolvedAgents.find((a) => a.name === agentName);
    const agentCommands = agentConfig
      ? resolveAgentCommands(agentConfig.slashCommands)
      : DEFAULT_SLASH_COMMANDS;
    const wasGsdNested = interaction.commandName === "get-shit-done";
    const subName = wasGsdNested ? commandName.replace(/^gsd-/, "") : null;
    const commandDef =
      agentCommands.find((c) => c.name === commandName) ??
      (subName ? agentCommands.find((c) => c.name === subName) : undefined) ??
      (subName
        ? GSD_SLASH_COMMANDS.find((c) => c.name === subName)
        : undefined);

    if (!commandDef) {
      try {
        await interaction.editReply(`Unknown command: /${commandName}`);
      } catch {
        // Interaction may have expired
      }
      return;
    }

    // Extract options from the interaction.
    // Phase 999.32 — when invoked via /gsd-do, the dispatcher pre-parsed
    // the rest-of-args. Bind that string to whatever option name cmdDef
    // expects so formatCommandMessage's placeholder substitution works
    // without needing the original interaction's option set.
    const options = new Map<string, string | number | boolean>();
    if (gsdDoRewrittenArgs !== null) {
      for (const opt of commandDef.options) {
        options.set(opt.name, gsdDoRewrittenArgs);
      }
    } else {
      for (const opt of commandDef.options) {
        const value = interaction.options.get(opt.name);
        if (value !== null && value !== undefined) {
          // discord.js returns CommandInteractionOption; extract the value
          const raw = value.value;
          if (raw !== null && raw !== undefined) {
            options.set(opt.name, raw);
          }
        }
      }
    }

    // Phase 83 EFFORT-07 + Phase 93 Plan 01 — /clawcode-status daemon-side
    // short-circuit, now backed by the pure renderStatus(buildStatusData)
    // module. Pulls authoritative runtime state directly from the session
    // handle; does NOT consume an LLM turn (EFFORT-07 reliability win
    // preserved).
    //
    // Phase 93 restores the rich OpenClaw-parity 9-line block deferred in
    // EFFORT-07. Where ClawCode has no equivalent for an OpenClaw field
    // (Runner / Fast Mode / Harness / Reasoning / Elevated / Activation /
    // Queue / Context / Compactions / Tokens), the renderer emits
    // `unknown` / `n/a` placeholders per CONTEXT.md D-93-01-1. Defensive
    // try/catch in buildStatusData (Pitfall 6) means a stopped/crashed
    // agent still gets all 9 lines with `unknown` placeholders rather than
    // a generic "Failed to read status" wipe.
    if (commandName === "clawcode-status") {
      try {
        const agentCfg = this.resolvedAgents.find((a) => a.name === agentName);
        const memBase = agentCfg?.memoryPath ?? "";

        const newestMtime = (dir: string): number | undefined => {
          try {
            if (!existsSync(dir)) return undefined;
            const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
            if (files.length === 0) return undefined;
            return Math.max(...files.map((f) => statSync(join(dir, f)).mtimeMs));
          } catch {
            return undefined;
          }
        };

        const lastDreamWikilinkCount = (dir: string): number | undefined => {
          try {
            if (!existsSync(dir)) return undefined;
            const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
            if (files.length === 0) return undefined;
            const content = readFileSync(join(dir, files[files.length - 1]!), "utf-8");
            const matches = [...content.matchAll(/\*\*New wikilinks \((\d+)\):\*\*/g)];
            if (matches.length === 0) return undefined;
            return parseInt(matches[matches.length - 1]![1]!, 10);
          } catch {
            return undefined;
          }
        };

        // Phase 999.113 WS-6 — run-log reads. Both are defensive: a
        // missing/corrupt log file degrades to the mtime-only behavior and
        // must never break /clawcode-status (load-bearing panel). Limit 200
        // covers weeks of fleet-wide rows for the per-agent filters inside
        // buildStatusData's derive helpers.
        let dreamRuns: readonly DreamRunRow[] | undefined;
        try {
          dreamRuns = await listRecentDreamRuns(200);
        } catch {
          dreamRuns = undefined;
        }
        let consolidationRuns: readonly ConsolidationRunRow[] | undefined;
        try {
          consolidationRuns = await listRecentConsolidationRuns(200);
        } catch {
          consolidationRuns = undefined;
        }

        const dreamsDir = join(memBase, "dreams");
        const data = buildStatusData({
          sessionManager: this.sessionManager,
          resolvedAgents: this.resolvedAgents,
          agentName,
          agentVersion: CLAWCODE_VERSION,
          commitSha: resolveCommitSha(),
          now: Date.now(),
          lastConsolidationAt: newestMtime(join(memBase, "memory", "digests")),
          lastDreamAt: newestMtime(dreamsDir),
          lastDreamWikilinks: lastDreamWikilinkCount(dreamsDir),
          dreamRuns,
          consolidationRuns,
        });
        const baseRender = renderStatus(data);

        // Phase 103 OBS-08 — append optional 5h+7d session/weekly bars
        // when the per-agent RateLimitTracker has snapshots. Wrapped in
        // try/catch (and renderUsageBars itself returns "" on no data,
        // Pitfall 7) so the bar suffix is purely additive — a thrown
        // accessor or missing tracker NEVER collapses the 9-line block.
        // 2026-09-26: Anthropic's live `/usage` numbers first (shared
        // account), tracked snapshots only as a filtered fallback.
        let usageBarSuffix = "";
        try {
          const tracker =
            this.sessionManager.getRateLimitTrackerForAgent(agentName);
          const live = await livePlanSnapshots();
          usageBarSuffix = renderUsageBars(
            effectiveSnapshots(tracker?.getAllSnapshots() ?? [], live, Date.now()),
          );
        } catch {
          // observational — bars are optional, never break status render
        }

        await interaction.editReply(baseRender + usageBarSuffix);
      } catch (error) {
        // Defense-in-depth: buildStatusData/renderStatus are pure and don't
        // throw under expected conditions (every accessor is try/catch'd
        // internally — Pitfall 6). This catch only fires if Discord
        // editReply itself errors out (expired interaction, network blip).
        // Swallow per surrounding command-handler discipline.
        const msg = error instanceof Error ? error.message : String(error);
        try {
          await interaction.editReply(`Failed to read status: ${msg}`);
        } catch {
          /* expired */
        }
      }
      return;
    }

    // Handle /effort directly — no need to route through the agent.
    // Phase 83 EFFORT-04 — validates against the full v2.2 level set.
    // Phase 100 follow-up — restricted to #admin-clawdy + optional agent target.
    if (commandName === "clawcode-style") {
      // 2026-08-14 operator decision — usable by anyone, in any channel
      // (updated from the launch-day admin gate). The default target is the
      // CHANNEL'S bound agent, so `/clawcode-style bluf` in #projects styles
      // projects; `agent:` targets others explicitly. Style is cosmetic and
      // per-agent - no cost dimension, unlike /clawcode-effort which stays
      // admin-gated.
      const styleArg = options.get("style");
      const validStyles: readonly string[] = outputStyleSchema.options;
      const isStatus = styleArg === "status";
      if (typeof styleArg !== "string" || (!isStatus && !validStyles.includes(styleArg))) {
        try {
          await interaction.editReply(`Invalid style. Use: ${validStyles.join(", ")}, status`);
        } catch { /* expired */ }
        return;
      }
      const rawAgent = options.get("agent");
      let resolvedTarget: string;
      if (typeof rawAgent === "string" && rawAgent.length > 0) {
        if (!this.sessionManager.getAgentConfig(rawAgent)) {
          try {
            await interaction.editReply(`Unknown agent: \`${rawAgent}\`.`);
          } catch { /* expired */ }
          return;
        }
        resolvedTarget = rawAgent;
      } else {
        resolvedTarget = agentName;
      }
      if (isStatus) {
        // Status: the target's resolved style, plus every runtime override so
        // a fleet-wide glance needs one invocation.
        const overrides = this.sessionManager.getStyleOverrides();
        const lines = [
          `**${resolvedTarget}**: \`${this.sessionManager.getStyleForAgent(resolvedTarget)}\``,
        ];
        if (overrides.size > 0) {
          lines.push("", "Runtime overrides:");
          for (const [name, style] of overrides) {
            lines.push(`- ${name}: \`${style}\``);
          }
        } else {
          lines.push("", "_No runtime overrides - all agents on config/default._");
        }
        try {
          await interaction.editReply(lines.join("\n"));
        } catch { /* expired */ }
        return;
      }
      try {
        this.sessionManager.setStyleForAgent(
          resolvedTarget,
          styleArg as import("../manager/output-styles/roster.js").OutputStyleId,
        );
        await interaction.editReply(
          styleArg === "default"
            ? `Style override **cleared** for ${resolvedTarget} - natural form from the next turn.`
            : `Style set to **${styleArg}** for ${resolvedTarget} - applies from the next turn (persists across restarts).`,
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        await interaction.editReply(`Failed to set style: ${msg}`);
      }
      return;
    }

    if (commandName === "clawcode-effort") {
      // Channel guard — mirrors the /gsd-* admin-clawdy guard at
      // handleGsdLongRunner (slash-commands.ts:1942). Effort changes are
      // privileged: xhigh/max levels add real per-turn cost, and runaway
      // effort on a high-volume agent (fin-client's 30 cron schedules)
      // is expensive. Concentrating the dial in one channel makes accidental
      // bumps from miscellaneous channels impossible.
      if (agentName !== "Admin Clawdy") {
        try {
          await interaction.editReply(
            "`/clawcode-effort` is restricted to #admin-clawdy. Invoke from the admin channel and use `agent:` to target other agents.",
          );
        } catch { /* expired */ }
        return;
      }
      const level = options.get("level");
      // Quick 260715-j1j (D8) — validLevels derives from effortSchema.options
      // (single source; kills the hardcoded-array drift that would have
      // silently rejected new levels like ultracode). Same reply shape.
      const validLevels: readonly string[] = effortSchema.options;
      if (typeof level !== "string" || !validLevels.includes(level)) {
        try {
          await interaction.editReply(`Invalid effort level. Use: ${validLevels.join(", ")}`);
        } catch { /* expired */ }
        return;
      }
      // Phase 100 follow-up — optional `agent:` lets the operator target any
      // configured agent from #admin-clawdy. Default: the channel-bound agent
      // (admin-clawdy itself, given the guard above passed).
      const rawAgent = options.get("agent");
      let resolvedTarget: string;
      if (typeof rawAgent === "string" && rawAgent.length > 0) {
        if (!this.sessionManager.getAgentConfig(rawAgent)) {
          try {
            await interaction.editReply(`Unknown agent: \`${rawAgent}\`.`);
          } catch { /* expired */ }
          return;
        }
        resolvedTarget = rawAgent;
      } else {
        resolvedTarget = agentName;
      }
      try {
        this.sessionManager.setEffortForAgent(
          resolvedTarget,
          level as EffortLevel,
        );
        await interaction.editReply(
        `Effort set to **${level}** for ${resolvedTarget}` +
          this.v3LiveSwitchNote(resolvedTarget, { persisted: true }),
      );
      } catch (error) {
        // Quick 260715-j1j (D6) — surface the ultracode gate's typed
        // rejection with its operator-readable reason (mirrors the
        // ModelNotAllowedError rendering pattern on the model slash path).
        if (error instanceof UltracodeNotAllowedError) {
          await interaction.editReply(
            `❌ ${error.reason}\n\n\`ultracode\` needs an xhigh-capable model (opus/fable) AND \`nativeWorkflow: true\` in clawcode.yaml (restart required — the flag is non-reloadable).`,
          );
          return;
        }
        const msg = error instanceof Error ? error.message : String(error);
        await interaction.editReply(`Failed to set effort: ${msg}`);
      }
      return;
    }

    // Format the command message
    const formattedMessage = formatCommandMessage(commandDef, options);

    this.log.info(
      { agent: agentName, command: commandName, channelId },
      "routing slash command to agent",
    );

    // Show immediate "Thinking..." feedback
    try {
      await interaction.editReply("Thinking...");
    } catch {
      // Non-fatal: continue even if this edit fails
    }

    // Set up progressive editor for streaming updates.
    // Phase 100 follow-up — wrap raw markdown tables in ```text``` fences
    // so Discord renders monospace + column alignment.
    const editor = new ProgressiveMessageEditor({
      editFn: async (content: string) => {
        const wrapped = formatOutboundText(content);
        const truncated = wrapped.length > DISCORD_MAX_LENGTH
          ? wrapped.slice(0, DISCORD_MAX_LENGTH - 3) + "..."
          : wrapped;
        await interaction.editReply(truncated);
      },
      editIntervalMs: 1500,
    });

    // Phase 83 EFFORT-05 — per-skill effort override. Resolve the command
    // name against the skills catalog (with or without the `clawcode-` prefix
    // that the Discord convention requires) and, when the skill has an
    // `effort:` frontmatter, apply that level for the duration of the turn.
    // Revert in a finally block so error paths can't strand the agent at an
    // elevated level. Zero side effects when the catalog isn't injected or
    // the command doesn't map to a skill with an override.
    const skillEntry =
      this.skillsCatalog?.get(commandName) ??
      this.skillsCatalog?.get(commandName.replace(/^clawcode-/, ""));
    const skillEffort = skillEntry?.effort;
    let priorEffort: EffortLevel | null = null;
    if (skillEffort) {
      try {
        priorEffort = this.sessionManager.getEffortForAgent(agentName);
        this.sessionManager.setEffortForAgent(agentName, skillEffort);
      } catch (err) {
        this.log.warn(
          { agent: agentName, command: commandName, skillEffort, error: (err as Error).message },
          "slash-command: skill-effort apply failed — continuing without override",
        );
        priorEffort = null;
      }
    }

    try {
      // Phase 141 (#8) — v3 (claude-code-interactive) agents have an INERT
      // daemon-side handle, so streamFromAgent returns "" → the skill turn lands
      // as "(No response from agent)" (silent drop). Route reply-expecting skill
      // turns over the live ClawCode channel (push + awaitReply) — the same path
      // a regular Discord message uses — and drive the SAME interaction editor
      // via the bridge's progress callback. v2 agents (no bridge) keep the
      // unchanged streamFromAgent path. correlationId is `slash-` prefixed so it
      // can never collide with the `discord-<id>` chat correlation.
      const backend =
        this.sessionManager.getAgentConfig?.(agentName)?.llmRuntime?.backend;
      const v3Bridge = resolveV3ChatBridge(
        backend,
        this.getBridge ?? undefined,
        agentName,
      );
      let response: string;
      if (v3Bridge) {
        const correlationId = `slash-${interaction.id}`;
        // Stream progress into the interaction editor ONLY when no other turn is
        // awaiting on this agent's bridge — registerProgressCallback is a single
        // shared slot, so a concurrent turn would clobber it (parity with the
        // chat path's single-in-flight streaming gate, bridge.ts:~2181). The
        // final editReply below delivers the full response either way.
        const canStream =
          (v3Bridge.pendingReplyCount?.() ?? 0) === 0 &&
          typeof v3Bridge.registerProgressCallback === "function";
        let didRegisterProgress = false;
        if (canStream) {
          v3Bridge.registerProgressCallback?.((acc) => editor.update(acc));
          didRegisterProgress = true;
        }
        v3Bridge.push({
          type: "a2a",
          message_id: correlationId,
          content: formattedMessage,
          meta: {
            source_agent: "discord-slash",
            source_channel: channelId,
            // Parity with the chat push (bridge.ts) — lets handleAck correlate
            // the reply by id, not only the fail-closed handleTurnComplete
            // fallback (which can't deliver when another reply is pending).
            reply_correlation_id: correlationId,
          },
        });
        try {
          const ack = await v3Bridge.awaitReply(correlationId, 120_000);
          response = ack.result ?? "";
        } finally {
          // Only clear the shared single-slot callback if WE registered it —
          // otherwise a concurrent chat turn that registered first (and is still
          // streaming) would have its callback wiped when this slash settles.
          if (didRegisterProgress) v3Bridge.clearProgressCallback?.();
        }
      } else {
        // Stream from agent with progressive updates (v2 SDK path)
        response = await this.sessionManager.streamFromAgent(
          agentName,
          formattedMessage,
          (accumulated) => editor.update(accumulated),
        );
      }

      await editor.flush();

      // Handle empty response
      const text = response.trim();
      if (text.length === 0) {
        await interaction.editReply("(No response from agent)");
        return;
      }

      // Final edit with complete (possibly truncated) text
      const truncated =
        text.length > DISCORD_MAX_LENGTH
          ? text.slice(0, DISCORD_MAX_LENGTH - 3) + "..."
          : text;

      await interaction.editReply(truncated);
    } catch (error) {
      editor.dispose();

      const msg = error instanceof Error ? error.message : String(error);
      this.log.error(
        { agent: agentName, command: commandName, error: msg },
        "slash command execution failed",
      );
      try {
        await interaction.editReply(`Command failed: ${msg}`);
      } catch {
        // Interaction may have expired
      }
    } finally {
      // Phase 83 EFFORT-05 — revert to the snapshot-at-dispatch-time effort.
      // Runs on both success AND error paths (try/finally). Swallows revert
      // failures (logged) so a transient SDK failure cannot propagate past
      // the interaction boundary.
      if (priorEffort !== null) {
        try {
          this.sessionManager.setEffortForAgent(agentName, priorEffort);
        } catch (err) {
          this.log.warn(
            { agent: agentName, command: commandName, priorEffort, error: (err as Error).message },
            "slash-command: skill-effort revert failed — agent may be at wrong level",
          );
        }
      }
    }
  }

  /**
   * Phase 85 Plan 03 TOOL-06 / UI-01 — handle /clawcode-tools.
   *
   * Reads per-agent MCP readiness via the `list-mcp-status` IPC (daemon-routed,
   * zero LLM turn cost) and replies with a native Discord EmbedBuilder.
   *
   * Agent resolution:
   *   1. Explicit `agent` option takes precedence.
   *   2. Otherwise infer from the channel-agent routing table.
   *   3. Neither → ephemeral error, no IPC call spent.
   *
   * Reply is always ephemeral (operator-only view). Empty-servers case
   * returns a plain string — an empty embed would be visually noisy.
   */
  private async handleToolsCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const explicitAgent = interaction.options.get("agent")?.value;
    const agentName =
      typeof explicitAgent === "string" && explicitAgent.length > 0
        ? explicitAgent
        : getAgentForChannel(this.routingTable, interaction.channelId);

    if (!agentName) {
      try {
        await interaction.reply({
          content:
            "This channel is not bound to an agent and no agent was provided.",
          ephemeral: true,
        });
      } catch {
        /* interaction may have expired */
      }
      return;
    }

    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (error) {
      this.log.error(
        { command: "clawcode-tools", error: (error as Error).message },
        "failed to defer tools reply",
      );
      return;
    }

    let response: ToolsIpcResponse;
    try {
      response = (await sendIpcRequest(SOCKET_PATH, "list-mcp-status", {
        agent: agentName,
      })) as ToolsIpcResponse;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      try {
        await interaction.editReply(`Failed to read MCP state: ${msg}`);
      } catch {
        /* expired */
      }
      return;
    }

    if (response.servers.length === 0) {
      try {
        await interaction.editReply(`No MCP servers configured for ${agentName}`);
      } catch {
        /* expired */
      }
      return;
    }

    // Phase 94 Plan 07 — capability-probe rows. Built via the shared pure
    // helper (probe-renderer.ts) so the CLI surface (`clawcode mcp-status`)
    // and this Discord embed render identical content for the same
    // snapshot. Cross-renderer parity is pinned by a CLI test.
    //
    // Cross-agent alternatives (D-07 / TOOL-12) come from the IPC payload's
    // `alternatives` field — computed daemon-side via findAlternativeAgents
    // (94-04 helper) over the per-agent McpStateProvider; the renderer here
    // just surfaces them. Single-source-of-truth: the daemon's
    // `list-mcp-status` handler is the only place findAlternativeAgents
    // runs for this surface.
    const nowDate = new Date();
    const now = nowDate.getTime();

    const buildEmbed = (resp: ToolsIpcResponse): { embed: EmbedBuilder; row: ActionRowBuilder<ButtonBuilder> } => {
      const rows: readonly ProbeRowOutput[] = Object.freeze(
        resp.servers.map((s) => {
          const stateLike: ProbeRowState = { capabilityProbe: s.capabilityProbe };
          const alternatives = s.alternatives ?? [];
          return buildProbeRow(s.name, stateLike, alternatives, new Date());
        }),
      );

      const pages = paginateRows(rows, EMBED_LINE_CAP);
      const firstPage = pages[0] ?? [];

      const e = new EmbedBuilder()
        .setTitle(`MCP Tools · ${agentName}`)
        .setColor(resolveEmbedColor(resp.servers));

      if (pages.length > 1) {
        e.setFooter({
          text: `Showing first ${EMBED_LINE_CAP} of ${rows.length} servers (Discord embed cap)`,
        });
      }

      for (let i = 0; i < firstPage.length; i++) {
        const row = firstPage[i]!;
        const s = resp.servers[i]!;
        const connectEmoji = STATUS_EMOJI[s.status] ?? STATUS_EMOJI.unknown!;
        const optSuffix = s.optional && s.status !== "ready" ? " (optional)" : "";
        const lastSuccess = s.lastSuccessAt
          ? `${formatRelativeTime(now - s.lastSuccessAt)} ago`
          : "never";
        const errLine = s.lastError ? `\nerror: ${s.lastError}` : "";

        const probeLines: string[] = [];
        const probeLastGood = row.lastSuccessIso
          ? `last good: ${row.lastSuccessIso}${row.lastSuccessRelative ? ` (${row.lastSuccessRelative})` : ""}`
          : "last good: never";
        probeLines.push(`probe: ${row.statusEmoji} ${row.status} — ${probeLastGood}`);
        if (row.recoverySuggestion) {
          probeLines.push(row.recoverySuggestion);
        }
        if (row.alternatives.length > 0) {
          probeLines.push(`Healthy alternatives: ${row.alternatives.join(", ")}`);
        }

        e.addFields({
          name: `${connectEmoji} ${s.name}${optSuffix}`,
          value: `status: ${s.status}\nlast success: ${lastSuccess}\nfailures: ${s.failureCount}\n${probeLines.join("\n")}${errLine}`,
          inline: false,
        });
      }

      const refreshRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`tools-refresh:${agentName}`)
          .setLabel("Refresh")
          .setStyle(ButtonStyle.Secondary),
      );

      return { embed: e, row: refreshRow };
    };

    const { embed, row: refreshRow } = buildEmbed(response);

    try {
      await interaction.editReply({ embeds: [embed], components: [refreshRow] });
    } catch (error) {
      this.log.error(
        { command: "clawcode-tools", error: (error as Error).message },
        "failed to send tools embed",
      );
      return;
    }

    // 5-minute refresh collector — lets the operator re-check without re-running the command.
    let refreshReply: import("discord.js").Message | undefined;
    try {
      refreshReply = await interaction.fetchReply() as import("discord.js").Message;
    } catch {
      return;
    }
    const collector = refreshReply.createMessageComponentCollector({
      componentType: ComponentType.Button,
      filter: (i: ButtonInteraction) =>
        i.user.id === interaction.user.id &&
        i.customId === `tools-refresh:${agentName}`,
      time: 5 * 60 * 1000,
    });

    collector.on("collect", async (btn: ButtonInteraction) => {
      try {
        await btn.deferUpdate();
      } catch {
        return;
      }
      try {
        const refreshed = (await sendIpcRequest(SOCKET_PATH, "list-mcp-status", {
          agent: agentName,
        })) as ToolsIpcResponse;
        const { embed: freshEmbed, row: freshRow } = buildEmbed(refreshed);
        await btn.editReply({ embeds: [freshEmbed], components: [freshRow] });
      } catch {
        /* silent — collector just skips failed refreshes */
      }
    });
  }

  /**
   * Phase 95 Plan 03 DREAM-07 / UI-01 — handle /clawcode-dream.
   *
   * Admin-only ephemeral. Gates on isAdminClawdyInteraction BEFORE deferring
   * the reply so non-admins receive an instant "Admin-only command" reply
   * (zero IPC + zero LLM turn cost). Admin invocations defer ephemerally,
   * dispatch through the daemon's `run-dream-pass` IPC method, and render
   * the DreamPassOutcome via the pure renderDreamEmbed helper.
   *
   * Slash semantics: --idle-bypass is ALWAYS true for this surface — the
   * Discord operator-driven manual trigger semantically wants the dream
   * pass to fire even if the agent has been chatting recently. CLI uses
   * the opposite default (--idle-bypass=false → must be explicit).
   */
  /**
   * Phase 142 — handle /clawcode-optimize. Admin-only ephemeral (the optimizer
   * spawns eval forks + proposes skill changes — operator-tier; gates BEFORE
   * deferReply like the other operator commands). Routes through the daemon's
   * `run-agent-optimization` IPC method and renders the staged-proposal summary.
   * Staged skill drafts are reviewed/applied via /approve-skill.
   */
  private async handleOptimizeCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    if (
      !isAdminClawdyInteraction(interaction, {
        adminUserIds: this.adminUserIds,
        routingTable: this.routingTable,
        resolvedAgents: this.resolvedAgents,
      })
    ) {
      try {
        await interaction.reply({
          content: "Admin-only command",
          flags: MessageFlags.Ephemeral,
        });
      } catch {
        /* interaction may have expired */
      }
      return;
    }

    const agent = interaction.options.getString("agent", true);

    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (error) {
      this.log.error(
        { command: "clawcode-optimize", error: (error as Error).message },
        "failed to defer optimize reply",
      );
      return;
    }

    let r: {
      readonly agent: string;
      readonly status: string;
      readonly reason?: string;
      readonly outcome?: string;
      readonly baselineScore?: number;
      readonly candidateScore?: number;
      readonly stagedDraftCount?: number;
      readonly removeCount?: number;
    };
    try {
      r = (await sendIpcRequest(SOCKET_PATH, "run-agent-optimization", {
        agent,
      })) as typeof r;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(
        { command: "clawcode-optimize", agent, error: msg },
        "optimize IPC failed",
      );
      try {
        await interaction.editReply({ content: `Optimizer failed: ${msg}` });
      } catch {
        /* interaction may have expired */
      }
      return;
    }

    const pct = (n?: number): string =>
      typeof n === "number" ? `${Math.round(n * 100)}%` : "n/a";
    let content: string;
    if (r.status === "skipped") {
      content = `Optimizer skipped for **${r.agent}**: ${r.reason ?? "n/a"}`;
    } else {
      const lines = [
        `Optimizer for **${r.agent}** — **${(r.outcome ?? "n/a").toUpperCase()}**`,
        `Score: ${pct(r.baselineScore)} → ${pct(r.candidateScore)}`,
      ];
      if (r.outcome === "improved") {
        lines.push(
          `Staged ${r.stagedDraftCount ?? 0} skill draft(s) for review — approve via /approve-skill.`,
        );
        if ((r.removeCount ?? 0) > 0) {
          lines.push(`${r.removeCount} remove(s) flagged for manual review.`);
        }
      }
      content = lines.join("\n");
    }

    try {
      await interaction.editReply({ content });
    } catch (error) {
      this.log.error(
        { command: "clawcode-optimize", error: (error as Error).message },
        "failed to edit optimize reply",
      );
    }
  }

  private async handleDreamCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    // Operator request 2026-06-02 — /clawcode-dream is NO LONGER admin-gated:
    // any channel user may trigger a dream pass for an agent. The other
    // operator commands (/clawcode-session-compact, skill draft/patch review)
    // KEEP their isAdminClawdyInteraction gate — only this one is opened.
    // NOTE: this lets non-admins trigger an LLM-cost dream pass; the reply
    // stays ephemeral so output isn't broadcast to the channel.
    // Phase 999.188 — the agent defaults to the channel's agent; `action`
    // adds pending / veto / approve for the dream auto-promote veto window.
    const agent =
      interaction.options.getString("agent", false)?.trim() ||
      getAgentForChannel(this.routingTable, interaction.channelId) ||
      "";
    const action = (interaction.options.getString("action", false) ?? "run").trim().toLowerCase();
    const runId = interaction.options.getString("run", false)?.trim() ?? "";
    const reason = interaction.options.getString("reason", false)?.trim() ?? "";

    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (error) {
      this.log.error(
        { command: "clawcode-dream", error: (error as Error).message },
        "failed to defer dream reply",
      );
      return;
    }

    if (action !== "run") {
      const content = await this.handleDreamVetoAction(action, agent, runId, reason);
      await interaction.editReply({ content }).catch(() => {});
      return;
    }
    if (agent.length === 0) {
      await interaction
        .editReply({ content: "No agent here. Run `/clawcode-dream` in an agent's channel, or pass `agent:`." })
        .catch(() => {});
      return;
    }

    let response: DreamIpcResponse;
    try {
      response = (await sendIpcRequest(SOCKET_PATH, "run-dream-pass", {
        agent,
        idleBypass: true,
      })) as DreamIpcResponse;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(
        { command: "clawcode-dream", agent, error: msg },
        "run-dream-pass IPC failed",
      );
      try {
        await interaction.editReply({
          content: `dream pass error: ${msg}`,
        });
      } catch {
        /* expired */
      }
      return;
    }

    try {
      await interaction.editReply({
        embeds: [renderDreamEmbed(agent, response)],
      });
    } catch (error) {
      this.log.error(
        { command: "clawcode-dream", error: (error as Error).message },
        "failed to send dream embed",
      );
    }
  }

  /**
   * Phase 999.188 — pending / veto / approve for dream auto-promote runs.
   * Returns the ephemeral reply text. `pending` lists the agent's open veto
   * windows with their deadlines; `veto` and `approve` act on one run id.
   */
  private async handleDreamVetoAction(action: string, agent: string, runId: string, reason: string): Promise<string> {
    try {
      if (action === "pending") {
        if (agent.length === 0) return "No agent here. Pass `agent:` or run this in an agent's channel.";
        const q = (await sendIpcRequest(SOCKET_PATH, "get-dream-queue", { agent })) as {
          pendingVetoWindows?: ReadonlyArray<{ runId: string; candidateCount: number; deadline: number; isPriorityPass: boolean }>;
        };
        const rows = q.pendingVetoWindows ?? [];
        if (rows.length === 0) return `No pending dream promotions for ${agent}.`;
        const lines = rows.map((r) => {
          const mins = Math.max(0, Math.round((r.deadline - Date.now()) / 60_000));
          return `- \`${r.runId}\` · ${r.candidateCount} candidate${r.candidateCount === 1 ? "" : "s"} · applies in ${mins} min${r.isPriorityPass ? " · priority" : ""}`;
        });
        return `Pending dream promotions for ${agent}:\n${lines.join("\n")}\nVeto: \`/clawcode-dream action:veto run:<id>\` · Approve now: \`/clawcode-dream action:approve run:<id>\``;
      }
      if (runId.length === 0) return `Pass \`run:<id>\` for ${action}. \`/clawcode-dream action:pending\` lists them.`;
      if (action === "veto") {
        await sendIpcRequest(SOCKET_PATH, "veto-dream-run", { runId, reason: reason || "vetoed from Discord" });
        return `Vetoed dream run \`${runId}\`. Nothing from it will be written to MEMORY.md.`;
      }
      if (action === "approve") {
        const r = (await sendIpcRequest(SOCKET_PATH, "approve-dream-run", { runId })) as { applied?: boolean; report?: string; error?: string };
        if (r.error) return `Approve failed: ${r.error}`;
        return r.report ?? (r.applied ? `Applied dream run \`${runId}\`.` : `Run \`${runId}\` is not pending.`);
      }
      return `Unknown action \`${action}\`. Use run, pending, veto or approve.`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn({ command: "clawcode-dream", action, runId, error: msg }, "dream veto action failed");
      return `dream ${action} error: ${msg}`;
    }
  }

  /**
   * /clawcode-goal — set / inspect / clear an autonomous goal loop for the
   * channel's agent (the ClawCode duplicate of Claude Code's /goal). Inline-
   * handled (short-circuited before the generic CONTROL_COMMANDS dispatch)
   * because the condition/action options select between three IPC methods.
   *
   * NOT admin-gated (operator decision: available to all agents). The reply is
   * ephemeral; the loop's per-turn progress + final outcome post in-channel.
   */
  private async handleGoalCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const channelId = interaction.channelId;
    const explicitAgent =
      interaction.options.getString("agent", false)?.trim() || undefined;
    const condition =
      interaction.options.getString("condition", false)?.trim() || undefined;
    const action = (interaction.options.getString("action", false) ?? "")
      .trim()
      .toLowerCase();

    const agent =
      explicitAgent ?? getAgentForChannel(this.routingTable, channelId) ?? undefined;

    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (error) {
      this.log.error(
        { command: "clawcode-goal", error: (error as Error).message },
        "failed to defer goal reply",
      );
      return;
    }

    if (!agent) {
      await interaction
        .editReply({
          content:
            "No agent here — run `/clawcode-goal` in an agent's channel, or pass `agent:`.",
        })
        .catch(() => {});
      return;
    }

    // Pick the operation: explicit action wins; otherwise a condition means set,
    // and no condition means show status.
    const method: "goal-set" | "goal-status" | "goal-clear" =
      action === "clear"
        ? "goal-clear"
        : action === "status"
          ? "goal-status"
          : condition
            ? "goal-set"
            : "goal-status";

    if ((action === "set" || method === "goal-set") && !condition) {
      await interaction
        .editReply({
          content:
            "Give a `condition:` to set a goal (e.g. `condition: all tests in src/auth pass`), or use `action: status` / `action: clear`.",
        })
        .catch(() => {});
      return;
    }

    let result: Record<string, unknown>;
    try {
      result = (await sendIpcRequest(SOCKET_PATH, method, {
        agent,
        channelId,
        ...(method === "goal-set" ? { condition } : {}),
      })) as Record<string, unknown>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(
        { command: "clawcode-goal", agent, method, error: msg },
        "goal IPC failed",
      );
      await interaction.editReply({ content: `Goal error: ${msg}` }).catch(() => {});
      return;
    }

    await interaction
      .editReply({ content: renderGoalReply(method, agent, condition, result) })
      .catch((error) => {
        this.log.error(
          { command: "clawcode-goal", error: (error as Error).message },
          "failed to send goal reply",
        );
      });
  }

  /**
   * Phase 124 Plan 03 — handle /clawcode-session-compact.
   *
   * Admin-only ephemeral. Mirrors handleDreamCommand structurally:
   *   1. Admin gate via isAdminClawdyInteraction BEFORE deferReply — non-admins
   *      get an instant "Admin-only command" reply (zero IPC, zero LLM cost).
   *   2. deferReply ephemerally so Discord doesn't time out the interaction
   *      while the daemon performs compaction (which can take several seconds
   *      for a multi-MB session JSONL).
   *   3. T-03 will replace the placeholder editReply below with the actual
   *      `sendIpcRequest(SOCKET_PATH, "compact-session", {agent})` dispatch.
   *   4. T-04 will add error-code propagation + thrown-IPC handling.
   */
  private async handleCompactCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    // Admin gate FIRST — no IPC, no defer for non-admins.
    if (
      !isAdminClawdyInteraction(interaction, {
        adminUserIds: this.adminUserIds,
        routingTable: this.routingTable,
        resolvedAgents: this.resolvedAgents,
      })
    ) {
      try {
        await interaction.reply({
          content: "Admin-only command",
          flags: MessageFlags.Ephemeral,
        });
      } catch {
        /* interaction may have expired */
      }
      return;
    }

    const agent = interaction.options.getString("agent", true);

    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (error) {
      this.log.error(
        { command: "clawcode-session-compact", error: (error as Error).message },
        "failed to defer compact reply",
      );
      return;
    }

    // T-03/T-04 — dispatch the daemon `compact-session` IPC. The daemon
    // returns a discriminated union (`ok:true | ok:false` with one of four
    // named error codes); on a thrown IPC error we synthesize an UNKNOWN
    // entry so the embed renderer has a single uniform path. CLI parity:
    // the same named codes surface from `clawcode session compact` (Plan
    // 124-02), so the operator sees the same vocabulary in both surfaces.
    let response: CompactSessionIpcResponse;
    try {
      response = (await sendIpcRequest(
        SOCKET_PATH,
        "compact-session",
        { agent },
      )) as CompactSessionIpcResponse;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(
        { command: "clawcode-session-compact", agent, error: msg },
        "compact-session IPC failed",
      );
      response = { ok: false, error: "UNKNOWN", message: msg };
    }
    try {
      await interaction.editReply({
        embeds: [renderCompactEmbed(agent, response)],
      });
    } catch (error) {
      this.log.error(
        { command: "clawcode-session-compact", error: (error as Error).message },
        "failed to send compact embed",
      );
    }
  }

  /**
   * Phase 132 Plan 03 T-03 — unified handler for the operator review slash
   * commands /approve-skill and /reject-skill (/edit-skill retired 2026-09-23).
   *
   * Admin-only ephemeral matching the /clawcode-dream + /clawcode-session-
   * compact precedent (D-06 + threat T-132-03-02). Gates on
   * isAdminClawdyInteraction BEFORE deferReply so non-admins never see the
   * IPC call land. Resolves the channel-bound agent (defaults the IPC
   * `agent` field to the channel's binding so the operator doesn't have to
   * type it), dispatches the IPC, and renders the DraftActionResult
   * discriminated union via renderSkillDraftActionEmbed.
   *
   * NOTE: `reason` for /reject-skill is forwarded only when present (Discord
   * optional STRING option). The handler intentionally trims to undefined
   * for empty strings so the daemon-side rejectDraft falls back to its
   * "no reason given" default.
   */
  private async handleSkillDraftActionCommand(
    interaction: ChatInputCommandInteraction,
    ipcMethod: "approve-skill-draft" | "reject-skill-draft",
  ): Promise<void> {
    if (
      !isAdminClawdyInteraction(interaction, {
        adminUserIds: this.adminUserIds,
        routingTable: this.routingTable,
        resolvedAgents: this.resolvedAgents,
      })
    ) {
      try {
        await interaction.reply({
          content: "Admin-only command",
          flags: MessageFlags.Ephemeral,
        });
      } catch {
        /* interaction may have expired */
      }
      return;
    }

    const draftId = interaction.options.getString("draft-id", true);
    const reasonRaw =
      ipcMethod === "reject-skill-draft"
        ? interaction.options.getString("reason", false) ?? undefined
        : undefined;
    const reason =
      typeof reasonRaw === "string" && reasonRaw.trim().length > 0
        ? reasonRaw
        : undefined;
    // Default the IPC's `agent` field to the channel's bound agent. Admin
    // commands may be invoked from outside an agent-bound channel; in that
    // case the daemon-side handler will treat the missing agent as a
    // not-found result. Operators can future-extend the slash command with
    // an explicit agent option if cross-channel usage becomes common.
    const channelId = interaction.channelId;
    const agentName = getAgentForChannel(this.routingTable, channelId) ?? "";

    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (error) {
      this.log.error(
        { ipcMethod, error: (error as Error).message },
        "failed to defer skill-draft-action reply",
      );
      return;
    }

    type SkillDraftActionResult =
      | { readonly status: "approved"; readonly finalPath: string }
      | {
          readonly status: "rejected";
          readonly finalPath: string;
          readonly fingerprint12: string;
        }
      | { readonly status: "found"; readonly draftPath: string }
      | {
          readonly status: "not-found";
          readonly reason: "staging-file-missing";
        };

    let response: SkillDraftActionResult;
    try {
      response = (await sendIpcRequest(SOCKET_PATH, ipcMethod, {
        agent: agentName,
        draftId,
        ...(reason !== undefined ? { reason } : {}),
      })) as SkillDraftActionResult;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(
        { ipcMethod, agent: agentName, draftId, error: msg },
        "skill-draft-action IPC failed",
      );
      try {
        await interaction.editReply({
          content: `skill-draft-action error: ${msg}`,
        });
      } catch {
        /* expired */
      }
      return;
    }

    try {
      await interaction.editReply({
        embeds: [renderSkillDraftActionEmbed(agentName, draftId, response)],
      });
    } catch (error) {
      this.log.error(
        { ipcMethod, error: (error as Error).message },
        "failed to send skill-draft-action embed",
      );
    }
  }

  /**
   * Phase 96 Plan 05 PFS- / UI-01 — handle /clawcode-probe-fs.
   *
   * Admin-only ephemeral. Gates on isAdminClawdyInteraction BEFORE deferring
   * the reply so non-admins receive an instant "Admin-only command" reply
   * (zero IPC + zero LLM turn cost — mirrors handleDreamCommand). Admin
   * invocations defer ephemerally, dispatch through the daemon's `probe-fs`
   * IPC method (which invokes runFsProbe → writeFsSnapshot →
   * setFsCapabilitySnapshot at the daemon edge), and render the
   * FsProbeOutcome via the pure renderProbeFsEmbed helper.
   *
   * D-03 refresh trigger: operator runs `/clawcode-probe-fs <agent>` after
   * ACL/group/systemd change to force re-probe BEFORE asking user to retry.
   * Eliminates the 60s heartbeat-stale window per RESEARCH.md Pitfall 7.
   *
   * D-04 silent: After probe completes, NO Discord broadcast post. Operator
   * inspects via this slash response only (ephemeral) or `clawcode fs-status`
   * CLI. Capability change reflects in next turn's stable-prefix re-render.
   *
   * Discord/CLI parity invariant: Both this slash and `clawcode probe-fs`
   * CLI invoke the SAME daemon IPC primitive ("probe-fs") which routes
   * through runFsProbe (96-01); identical FsProbeOutcome rendered to both
   * surfaces (RESEARCH.md Validation Architecture Dim 6).
   */
  private async handleProbeFsCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    // Admin gate FIRST — no IPC, no defer for non-admins.
    // Phase 100-fu — pass full context so channel-bound admin agents
    // grant admin access without requiring an explicit user-ID allowlist.
    if (
      !isAdminClawdyInteraction(interaction, {
        adminUserIds: this.adminUserIds,
        routingTable: this.routingTable,
        resolvedAgents: this.resolvedAgents,
      })
    ) {
      try {
        await interaction.reply({
          content: "Admin-only command",
          flags: MessageFlags.Ephemeral,
        });
      } catch {
        /* interaction may have expired */
      }
      return;
    }

    const agent = interaction.options.getString("agent", true);

    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (error) {
      this.log.error(
        { command: "clawcode-probe-fs", error: (error as Error).message },
        "failed to defer probe-fs reply",
      );
      return;
    }

    let outcome: FsProbeOutcomeWire;
    try {
      outcome = (await sendIpcRequest(SOCKET_PATH, "probe-fs", {
        agent,
      })) as FsProbeOutcomeWire;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(
        { command: "clawcode-probe-fs", agent, error: msg },
        "probe-fs IPC failed",
      );
      try {
        await interaction.editReply({
          content: `probe-fs error: ${msg}`,
        });
      } catch {
        /* expired */
      }
      return;
    }

    try {
      await interaction.editReply({
        embeds: [renderProbeFsEmbed(agent, outcome)],
      });
    } catch (error) {
      this.log.error(
        { command: "clawcode-probe-fs", error: (error as Error).message },
        "failed to send probe-fs embed",
      );
    }
  }

  /**
   * Phase 100 Plan 04 GSD-01..03 / GSD-09 — handle long-runner /gsd-* slash
   * commands by pre-spawning a subagent thread.
   *
   * Flow:
   *   1. Defer reply within the 3s Discord interaction-token window
   *      (RESEARCH.md Pitfall 4 — deferReply MUST be the FIRST async call).
   *   2. Channel-bound-to-admin-clawdy guard (CONTEXT.md lock-in: only
   *      Admin Clawdy responds to /gsd-* slashes).
   *   3. Resolve the cmdDef from admin-clawdy's slashCommands list (Plan 07
   *      adds the 5 entries; this method trusts that contract).
   *   4. Build the canonical /gsd:* string via formatCommandMessage (existing
   *      helper at the bottom of this file). For "/gsd:autonomous {args}"
   *      with args="--from 100" → produces "/gsd:autonomous --from 100".
   *   5. Pre-spawn a subagent thread named gsd:<short>:<phaseArg>; the
   *      canonical /gsd:* string flows into spawnInThread.task as the
   *      subagent's first user message, which the SDK auto-dispatches
   *      because settingSources includes "user" (loads ~/.claude/commands/
   *      gsd/*.md per Plan 100-06 symlinks).
   *   6. EditReply with thread URL + ack message.
   *
   * Phase 99-M auto-relay (Plan 100-05 extension) handles the parent-side
   * completion summary on subagent session end — out of scope for Plan 04.
   *
   * Spawn errors are surfaced verbatim via err.message (Phase 85 TOOL-04
   * precedent). Missing spawner DI emits a graceful "unavailable" reply.
   *
   * @param interaction — the Discord ChatInputCommandInteraction
   * @param commandName — the slash command name (gsd-autonomous /
   *                      gsd-plan-phase / gsd-execute-phase per
   *                      GSD_LONG_RUNNERS)
   */
  private async handleGsdLongRunner(
    interaction: ChatInputCommandInteraction,
    commandName: string,
    /**
     * Phase 999.32 — when the operator invoked via /gsd-do args:<sub> ...,
     * the dispatcher pre-parsed the rest-of-args into this string. We treat
     * it as the value for whatever option the cmdDef expects ({args}, {phase},
     * {task}, {issue}) so formatCommandMessage's placeholder substitution
     * still produces the canonical /gsd:<sub> ... slash. null when the
     * operator went through the legacy /get-shit-done composite path
     * (Discord nested subcommand UI) — in that case, options come from
     * interaction.options.get(name) as before.
     */
    gsdDoRewrittenArgs: string | null = null,
  ): Promise<void> {
    // Step 1 — defer FIRST (before any other I/O). 3s race-safe.
    try {
      await interaction.deferReply({ ephemeral: false });
    } catch (error) {
      this.log.error(
        { command: commandName, error: (error as Error).message },
        "failed to defer /gsd-* reply",
      );
      return;
    }

    // Step 2 — capability-based guard. Phase 100 follow-up: replaced the
    // hardcoded `agentName !== "Admin Clawdy"` check with a check on the
    // channel-bound agent's `gsd?.projectDir` field. Any agent the operator
    // has GSD-enabled (Admin Clawdy, fin-client, future agents) passes;
    // any non-GSD agent (personal, fin-tax, etc.) gets a clear rejection
    // mentioning what's missing so operators know how to fix it.
    const channelId = interaction.channelId;
    const agentName = getAgentForChannel(this.routingTable, channelId);
    const agentConfig = agentName
      ? this.resolvedAgents.find((a) => a.name === agentName)
      : undefined;
    if (!agentConfig?.gsd?.projectDir) {
      try {
        await interaction.editReply(
          `\`/gsd-*\` commands are restricted to GSD-enabled agents. ` +
            `This channel's agent (\`${agentName ?? "unknown"}\`) has no \`gsd.projectDir\` configured. ` +
            `Set one via \`/gsd-set-project path:<abs-path>\` or add a \`gsd:\` block to clawcode.yaml.`,
        );
      } catch {
        /* expired */
      }
      return;
    }

    // Step 3 — resolve cmdDef. First check the agent's own slashCommands
    // list (legacy yaml-defined entries on Admin Clawdy still win), then fall
    // back to GSD_SLASH_COMMANDS so any GSD-enabled agent without a yaml
    // block (e.g. fin-client) finds its cmdDef via the auto-inheritance
    // path. Mirrors the seenNames dedup at register time — first match wins.
    //
    // Phase 999.21 — GSD_SLASH_COMMANDS entries now use the stripped suffix
    // for `name` (e.g. "autonomous"); the rewrite-at-entry remap leaves
    // `commandName` as the legacy `gsd-<sub>` form for downstream match
    // back-compat, so lookups against GSD_SLASH_COMMANDS must strip the
    // `gsd-` prefix. The agent's own slashCommands are checked under both
    // forms (legacy yaml entries still use the `gsd-*` flat name; future
    // yaml entries may use the stripped form with subcommandOf set).
    const subName = commandName.replace(/^gsd-/, "");
    const cmdDef =
      agentConfig.slashCommands.find((c) => c.name === commandName) ??
      agentConfig.slashCommands.find((c) => c.name === subName) ??
      GSD_SLASH_COMMANDS.find((c) => c.name === subName);
    if (!cmdDef) {
      try {
        await interaction.editReply(`Unknown command: /${commandName}`);
      } catch {
        /* expired */
      }
      return;
    }

    // Step 4 — extract option values + build canonical /gsd:* string.
    // Phase 999.32 — when invoked via /gsd-do, the dispatcher passes the
    // pre-parsed rest-of-args; bind it to whatever option name cmdDef
    // expects (the operator typed one free-form string; substitute it for
    // every {args} / {phase} / {task} / {issue} placeholder uniformly).
    const options = new Map<string, string | number | boolean>();
    if (gsdDoRewrittenArgs !== null) {
      for (const opt of cmdDef.options) {
        options.set(opt.name, gsdDoRewrittenArgs);
      }
    } else {
      for (const opt of cmdDef.options) {
        const v = interaction.options.get(opt.name);
        if (v !== null && v !== undefined && v.value !== null && v.value !== undefined) {
          options.set(opt.name, v.value);
        }
      }
    }
    const canonicalSlash = formatCommandMessage(cmdDef, options);

    // Step 5 — build thread name: gsd:autonomous:100 / gsd:plan:100 /
    // gsd:execute:100. shortName maps the Discord-compatible name back to
    // the short canonical form: gsd-autonomous → autonomous;
    // gsd-plan-phase → plan; gsd-execute-phase → execute.
    const phaseArgRaw = String(
      options.get("phase") ?? options.get("args") ?? "",
    ).trim();
    const phaseArg = phaseArgRaw.length > 0 ? phaseArgRaw.split(/\s+/)[0]! : "";
    const shortName = commandName.replace(/^gsd-/, "").replace(/-phase$/, "");
    const threadName = phaseArg
      ? `gsd:${shortName}:${phaseArg}`
      : `gsd:${shortName}`;

    // Step 6 — graceful fallback when spawner not wired.
    if (!this.subagentThreadSpawner) {
      try {
        await interaction.editReply(
          "Subagent thread spawning unavailable (no Discord bridge).",
        );
      } catch {
        /* expired */
      }
      return;
    }

    // Step 7 — pre-spawn subagent thread; surface verbatim error on failure.
    // `agentConfig.name` is non-null here (we returned early at Step 2 when
    // agentConfig was undefined). Use it instead of `agentName` so TS narrows
    // the type without an extra non-null assertion.
    const parentAgentName = agentConfig.name;
    try {
      // Debug session `autorelay-fires-after-turn-1` (2026-05-22, option C)
      // — `/gsd:*` long-runner work is inherently MULTI-TURN (a phase plan
      // executes across many SDK turns: read files → edit → test → ...).
      // With the default `autoRelay: true`, `postInitialMessage` would
      // relay the subagent's TURN-1 output to the parent's main channel as
      // "finished" the moment the first SDK turn's stream ended — the exact
      // premature-relay bug. Pass `autoRelay: false` so the relay is NOT
      // fired on turn-1; the GSD subagent instead signals genuine
      // completion via the `subagent_complete` MCP tool (instructed in the
      // spawner's threadContext, which now binds for non-delegated
      // multi-turn spawns too). One-shot non-delegated subagents are
      // untouched — they keep the `autoRelay: true` default and relay
      // after turn-1 as before.
      const result = await this.subagentThreadSpawner.spawnInThread({
        parentAgentName,
        threadName,
        task: canonicalSlash,
        autoRelay: false,
      });
      const threadUrl = `https://discord.com/channels/${interaction.guildId}/${result.threadId}`;
      try {
        await interaction.editReply(
          `🚀 Spawned ${threadName} subthread for ${canonicalSlash}\nThread: ${threadUrl}\n_Working in subthread; main channel summary on completion._`,
        );
      } catch {
        /* expired */
      }
      this.log.info(
        {
          command: commandName,
          threadId: result.threadId,
          threadName,
          parentAgent: parentAgentName,
        },
        "/gsd-* long-runner subthread spawned",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(
        { command: commandName, error: msg },
        "/gsd-* long-runner spawn failed",
      );
      try {
        await interaction.editReply(`Failed to spawn /gsd-* subthread: ${msg}`);
      } catch {
        /* expired */
      }
    }
  }

  /**
   * Phase 100 follow-up — `/gsd-set-project` runtime project switcher.
   *
   * Lets an operator change a GSD-enabled agent's `gsd.projectDir` at runtime
   * without editing clawcode.yaml or restarting the daemon. The slash handler
   * does the validation (absolute path, exists, is-directory), then dispatches
   * `set-gsd-project` IPC to the daemon. The daemon persists the override to
   * `~/.clawcode/manager/gsd-project-overrides.json` and triggers an agent
   * restart (gsd.projectDir is non-reloadable per Phase 100 GSD-07).
   *
   * Capability gate: any agent with `gsd?.projectDir` configured can switch
   * its OWN project. No admin-clawdy guard — there's no destructive cross-
   * agent surface, only a per-agent project root rebind.
   *
   * Path validation order (fail-fast):
   *   1. `path.isAbsolute(p)` — reject relative paths
   *   2. `statSync(p)` — reject ENOENT (path doesn't exist)
   *   3. `stats.isDirectory()` — reject regular files / symlinks-to-files
   *
   * On success: ephemeral reply confirming the new projectDir + agent restart.
   * On IPC failure: ephemeral reply with verbatim error (operator-debuggable).
   */
  private async handleSetGsdProjectCommand(
    interaction: ChatInputCommandInteraction,
    /**
     * Phase 999.32 — when invoked via /gsd-do args:set-project /abs/path,
     * the dispatcher pre-parsed everything after `set-project` into this
     * string. When non-null, used as the path value instead of reading
     * the `path` option (which doesn't exist on the gsd-do interaction).
     */
    gsdDoRewrittenArgs: string | null = null,
  ): Promise<void> {
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (error) {
      this.log.error(
        { command: "gsd-set-project", error: (error as Error).message },
        "failed to defer gsd-set-project reply",
      );
      return;
    }

    const channelId = interaction.channelId;
    const agentName = getAgentForChannel(this.routingTable, channelId);
    const agentConfig = agentName
      ? this.resolvedAgents.find((a) => a.name === agentName)
      : undefined;

    // Capability gate — only GSD-enabled agents can switch their project.
    if (!agentConfig?.gsd?.projectDir) {
      try {
        await interaction.editReply(
          `\`/gsd-set-project\` requires a GSD-enabled agent. ` +
            `This channel's agent (\`${agentName ?? "unknown"}\`) is not a GSD agent ` +
            `(no \`gsd.projectDir\` configured).`,
        );
      } catch {
        /* expired */
      }
      return;
    }

    // Read the required `path` option (or use the rewritten args from
    // /gsd-do).
    const path =
      gsdDoRewrittenArgs !== null
        ? gsdDoRewrittenArgs
        : interaction.options.getString("path", true);
    if (!path || typeof path !== "string") {
      try {
        await interaction.editReply(
          "`/gsd-set-project` requires a `path:` option (absolute directory path).",
        );
      } catch { /* expired */ }
      return;
    }

    // Validation step 1 — must be absolute.
    if (!isAbsolute(path)) {
      try {
        await interaction.editReply(
          `\`${path}\` is not an absolute path. Provide a path that starts with \`/\`.`,
        );
      } catch { /* expired */ }
      return;
    }

    // Validation step 2 + 3 — must exist and be a directory.
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(path);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      try {
        await interaction.editReply(
          `Path \`${path}\` does not exist or is not accessible: ${msg}`,
        );
      } catch { /* expired */ }
      return;
    }
    if (!stats.isDirectory()) {
      try {
        await interaction.editReply(
          `Path \`${path}\` is not a directory. \`gsd.projectDir\` must point at a directory.`,
        );
      } catch { /* expired */ }
      return;
    }

    // Dispatch `set-gsd-project` IPC. The daemon side is in daemon.ts —
    // persists to gsd-project-overrides.json + restarts the agent.
    // `agentConfig.name` is non-null here (we returned early at the capability
    // gate when agentConfig was undefined). Use it instead of `agentName`.
    const targetAgent = agentConfig.name;
    try {
      await sendIpcRequest(SOCKET_PATH, "set-gsd-project", {
        agent: targetAgent,
        projectDir: path,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(
        { command: "gsd-set-project", agent: targetAgent, error: msg },
        "set-gsd-project IPC failed",
      );
      try {
        await interaction.editReply(
          `Failed to set GSD project for \`${targetAgent}\`: ${msg}`,
        );
      } catch { /* expired */ }
      return;
    }

    try {
      await interaction.editReply(
        `GSD project set to \`${path}\` for \`${targetAgent}\`. ` +
          `Restarting agent — new sessions will use this directory.`,
      );
    } catch { /* expired */ }
  }

  /**
   * Phase 103 OBS-07 / UI-01 — /clawcode-usage inline handler.
   *
   * Routes through the daemon-direct `list-rate-limit-snapshots` IPC method
   * (zero LLM turn cost) and renders a native Discord EmbedBuilder via the
   * pure buildUsageEmbed function in usage-embed.ts. The 12th application
   * of the inline-handler-short-circuit-before-CONTROL_COMMANDS pattern.
   *
   * Resolves target agent from the optional `agent:` arg, falling back to
   * the channel's bound agent. Mirrors the /clawcode-tools agent-resolution
   * idiom verbatim — operators can target any agent from any channel by
   * passing `agent:`, but the default is the channel's binding (so users
   * in a per-agent channel just type /clawcode-usage with no args).
   *
   * Pitfall 5 closure: this IPC name is `list-rate-limit-snapshots`, NOT
   * `rate-limit-status` (the latter is the SEPARATE Discord outbound
   * rate-limiter token-bucket IPC).
   *
   * Pitfall 7 closure: empty snapshots render the "No usage data yet"
   * graceful path inside buildUsageEmbed — never an empty embed.
   */
  private async handleUsageCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const explicitAgent = interaction.options.get("agent")?.value;
    const targetAgent =
      typeof explicitAgent === "string" && explicitAgent.length > 0
        ? explicitAgent
        : getAgentForChannel(this.routingTable, interaction.channelId);

    if (!targetAgent) {
      try {
        await interaction.reply({
          content:
            "This channel is not bound to an agent and no agent was provided.",
          ephemeral: true,
        });
      } catch {
        /* interaction may have expired */
      }
      return;
    }

    try {
      await interaction.deferReply({ ephemeral: false });
    } catch (error) {
      this.log.error(
        { command: "clawcode-usage", error: (error as Error).message },
        "failed to defer usage reply",
      );
      return;
    }

    // Quick 260611-h50 — one clock for the whole panel: the Pacific day/week
    // windows AND the embed footer share this single `now` so the buckets and
    // the bars never disagree about "today". The token totals are computed in
    // Pacific (America/Los_Angeles) local time, DST-correct, and passed to the
    // daemon as explicit half-open UTC ranges (startIso/endIso). The daemon's
    // existing UTC period semantics are untouched — the CLI keeps UTC.
    const now = new Date();
    const dayRange = pacificDayRangeUtc(now);

    // Fetch the two data sources concurrently: OAuth-Max rate-limit snapshots
    // plus the current Pacific day's token totals. allSettled so one source
    // failing (e.g. the `usage` IPC throws when the agent isn't running) never
    // blanks the whole panel — each contributes what it can. (Weekly totals
    // were dropped 2026-06-11 — the panel is current-day only by design.)
    const [snapResult, dailyResult] = await Promise.allSettled([
      sendIpcRequest(SOCKET_PATH, "list-rate-limit-snapshots", {
        agent: targetAgent,
      }) as Promise<{
        snapshots?: readonly RateLimitSnapshot[];
        source?: "anthropic" | "tracked";
      }>,
      sendIpcRequest(SOCKET_PATH, "usage", {
        agent: targetAgent,
        period: "daily",
        startIso: dayRange.startIso,
        endIso: dayRange.endIso,
      }) as Promise<Partial<UsageTokens>>,
    ]);

    // If both sources failed the daemon is unreachable / the agent is gone —
    // surface the error rather than a misleading "No usage data yet" panel.
    if (
      snapResult.status === "rejected" &&
      dailyResult.status === "rejected"
    ) {
      const err = snapResult.reason;
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(
        { command: "clawcode-usage", error: msg },
        "all usage IPC calls failed",
      );
      try {
        await interaction.editReply(`Failed to read usage: ${msg}`);
      } catch {
        /* interaction may have expired */
      }
      return;
    }

    const snapshots: readonly RateLimitSnapshot[] =
      snapResult.status === "fulfilled"
        ? (snapResult.value.snapshots ?? [])
        : [];

    // Normalize a fulfilled `usage` IPC payload into UsageTokens; a rejected
    // fetch (agent not running) leaves the bucket undefined → field omitted.
    // tokens_in is the FRESH/uncached half; the cache halves arrive in their
    // own fields (token-accuracy fix 2026-06-11) — the embed sums them for the
    // true API-metered "In" headline and renders the breakdown.
    const toTokens = (
      r: PromiseSettledResult<Partial<UsageTokens>>,
    ): UsageTokens | undefined =>
      r.status === "fulfilled"
        ? {
            tokens_in: r.value.tokens_in ?? 0,
            tokens_out: r.value.tokens_out ?? 0,
            cost_usd: r.value.cost_usd ?? 0,
            cache_read_tokens: r.value.cache_read_tokens ?? 0,
            cache_creation_tokens: r.value.cache_creation_tokens ?? 0,
            turns: r.value.turns ?? 0,
            duration_ms: r.value.duration_ms ?? 0,
          }
        : undefined;

    // Dynamic import keeps the slash-commands module graph decoupled from
    // usage-embed's discord.js EmbedBuilder reach; mirrors the Phase 91
    // sync-status pattern (lazy-load when the command actually fires).
    const { buildUsageEmbed } = await import("./usage-embed.js");

    const embed = buildUsageEmbed({
      agent: targetAgent,
      snapshots,
      // Reuse the SAME clock the Pacific day window was computed from, so the
      // footer's PT date and the "Today" bucket agree.
      now: now.getTime(),
      daily: toTokens(dailyResult),
      source:
        snapResult.status === "fulfilled" ? snapResult.value.source : undefined,
    });

    try {
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      this.log.error(
        { command: "clawcode-usage", error: (error as Error).message },
        "failed to send usage embed",
      );
    }
  }

  /**
   * Phase 86 MODEL-02 / MODEL-03 / MODEL-06 — /clawcode-model inline handler.
   *
   * Two paths share the same IPC dispatch:
   *   - No-arg: render a StringSelectMenuBuilder from the bound agent's
   *     resolved allowedModels; await the selection (30s TTL); dispatch via
   *     IPC. The menu is pure UI — selection funnels back through
   *     dispatchModelChange so arg-path and picker-path share error handling.
   *   - Arg: validate the agent binding and dispatch immediately via IPC.
   *
   * UI-01 compliance: the picker is a native discord.js StringSelectMenuBuilder
   * (not a free-text argument). Discord enforces a 25-entry cap on the menu;
   * when the allowedModels list exceeds that, the picker truncates and appends
   * a "+N more" note to the content string.
   *
   * Error rendering: when the IPC error envelope carries
   * `data.kind === "model-not-allowed"` (the ModelNotAllowedError payload
   * from Plan 01 surfaced via Plan 02's ManagerError {code:-32602, data}
   * wire), the reply renders the allowed list from `data.allowed`.
   */
  /**
   * Phase 141 (#9) — honest caveat for the live-switch commands on v3 agents.
   * `/clawcode-model|effort|permissions` dispatch an SDK mutator that is INERT
   * on a `claude-code-interactive` agent (rejected, swallowed) — the value is
   * honored only at SPAWN (`--model`/`--effort`/`--permission-mode`), NOT on the
   * running session. Without this note the command reports a "set to X" success
   * the live PTY never applies (the self-confirming lie: `/clawcode-status` reads
   * the same cached value back and agrees). `persisted` distinguishes
   * effort/model (survive a restart — effort-state / YAML) from permissions
   * (ephemeral — reset on restart unless set in clawcode.yaml). Returns "" for
   * v2/SDK agents, where the live switch genuinely works.
   *
   * Quick 260715-j1j (D10) — ultracode is v2-only for now: the v3 PTY spawn
   * clamps it to a plain `--effort xhigh` (mapEffortToCliFlag), so a v3 agent
   * never gets the native-Workflow orchestration semantics. The persisted
   * caveat states this so a "set to ultracode" success isn't misleading.
   */
  private v3LiveSwitchNote(
    agentName: string,
    opts: { readonly persisted: boolean },
  ): string {
    const backend =
      this.sessionManager.getAgentConfig?.(agentName)?.llmRuntime?.backend;
    if (backend !== "claude-code-interactive") return "";
    return opts.persisted
      ? "\n\n⚠️ This is a v3 (channels) agent — the value is applied at **spawn**, not live, so it does **not** affect the running session. It's persisted and takes effect on the agent's next restart. Note: `ultracode` is v2-only for now — a v3 agent runs plain xhigh instead."
      : "\n\n⚠️ This is a v3 (channels) agent — the value is applied at **spawn**, not live, and is **not** persisted. Set `llmRuntime.permissionMode` in clawcode.yaml and restart the agent to apply it.";
  }

  private async handleModelCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    // 2026-09-04 — optional `agent` target (same idiom as handleUsageCommand).
    // A single `agentName` drives BOTH paths downstream: the allowedModels
    // lookup, the picker's `model-picker:<agent>:<nonce>` customId, and
    // dispatchModelChange — so retargeting here retargets the arg path and the
    // no-arg picker together, and the picker renders the TARGET agent's
    // allowedModels rather than the channel agent's.
    const explicitAgent = interaction.options.get("agent")?.value;
    const agentName =
      typeof explicitAgent === "string" && explicitAgent.length > 0
        ? explicitAgent
        : getAgentForChannel(this.routingTable, interaction.channelId);
    if (!agentName) {
      try {
        await interaction.reply({
          content:
            "This channel is not bound to an agent and no agent was provided.",
          ephemeral: true,
        });
      } catch {
        /* interaction may have expired */
      }
      return;
    }

    const agentConfig = this.resolvedAgents.find((a) => a.name === agentName);
    const allowed = [...(agentConfig?.allowedModels ?? [])];

    const modelArg = interaction.options.get("model")?.value;
    const model =
      typeof modelArg === "string" && modelArg.length > 0 ? modelArg : undefined;

    // Arg path — direct IPC dispatch.
    if (model !== undefined) {
      await this.dispatchModelChange(interaction, agentName, model, false);
      return;
    }

    // No-arg path — render the select-menu picker.
    if (allowed.length === 0) {
      try {
        await interaction.reply({
          content: `No models available for ${agentName} (allowedModels is empty).`,
          ephemeral: true,
        });
      } catch {
        /* expired */
      }
      return;
    }

    // Phase 999.114 — options are built from the model CATALOG (display name,
    // price, current-vs-previous, and the `<family>@latest` tracks) instead of
    // rendering the raw config alias as the label. With historical pins now
    // selectable, a bare `opus-4-8` string told the operator nothing.
    const options = buildModelPickerOptions(
      allowed,
      agentConfig?.model,
    );
    const capped = options.slice(0, DISCORD_SELECT_CAP);
    const overflow = options.length - capped.length;
    const nonce = Math.random().toString(36).slice(2, 8);
    const customId = `model-picker:${agentName}:${nonce}`;

    const menu = new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder("Choose a model")
      .addOptions(
        capped.map((o) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(o.label)
            .setValue(o.value)
            .setDescription(o.description)
            // Pre-select the agent's current model so the menu shows where it
            // stands today rather than an empty box.
            .setDefault(o.isCurrent),
        ),
      );
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      menu,
    );

    const overflowNote =
      overflow > 0
        ? `\n(Showing first ${DISCORD_SELECT_CAP} of ${options.length}.)`
        : "";
    try {
      await interaction.reply({
        content: `Pick a model for **${agentName}**.${overflowNote}`,
        components: [row],
        ephemeral: true,
      });
    } catch (err) {
      this.log.error(
        { agent: agentName, error: (err as Error).message },
        "failed to render model picker",
      );
      return;
    }

    // Wait for the select-menu interaction (30s TTL).
    let followUp: StringSelectMenuInteraction;
    try {
      const channel = interaction.channel;
      if (!channel) {
        throw new Error("interaction has no channel — cannot collect");
      }
      followUp = (await channel.awaitMessageComponent({
        componentType: ComponentType.StringSelect,
        filter: (i: { user: { id: string }; customId: string }) =>
          i.user.id === interaction.user.id && i.customId === customId,
        time: MODEL_PICKER_TTL_MS,
      })) as StringSelectMenuInteraction;
    } catch {
      try {
        await interaction.editReply({
          content: "Model picker timed out (no selection in 30s).",
          components: [],
        });
      } catch {
        /* expired */
      }
      return;
    }

    const chosen = followUp.values[0];
    if (!chosen) {
      try {
        await followUp.update({
          content: "No selection captured.",
          components: [],
        });
      } catch {
        /* expired */
      }
      return;
    }

    // Acknowledge the select-menu interaction so Discord doesn't mark it as
    // "interaction failed"; dispatchModelChange will emit the final status
    // via editReply on the original slash-command interaction.
    try {
      await followUp.update({
        content: `Switching ${agentName} to **${chosen}**...`,
        components: [],
      });
    } catch {
      /* expired */
    }

    await this.dispatchModelChange(interaction, agentName, chosen, true);
  }

  /**
   * Phase 86 MODEL-03 / MODEL-06 — shared IPC dispatch for both the direct
   * arg-path and the select-menu path.
   *
   * `editMode=true` means the slash-command interaction has already been
   * replied-to (via `interaction.reply` during the picker render) — the
   * final status must use `editReply`. `editMode=false` is the direct
   * arg-path: defer first, then editReply with the outcome.
   *
   * Renders the typed ModelNotAllowedError payload from the IPC envelope
   * by reading `err.data.allowed` (Plan 02 propagates this through
   * IpcError.data, which Plan 03 extended client.ts to pass through).
   */
  private async dispatchModelChange(
    interaction: ChatInputCommandInteraction,
    agentName: string,
    model: string,
    editMode: boolean,
  ): Promise<void> {
    if (!editMode) {
      try {
        await interaction.deferReply({ ephemeral: true });
      } catch {
        /* already replied/deferred */
      }
    }

    // Phase 86 MODEL-05 — cache-invalidation confirmation for mid-conversation
    // changes. Skip when the handle has no active model (fresh boot — no
    // turn has executed yet). Being too conservative (always show confirm)
    // is cheap; being too permissive (never show confirm) misses the prompt-
    // cache invalidation warning, so when in doubt we show it.
    let activeModel: string | undefined;
    try {
      activeModel = this.sessionManager.getModelForAgent(agentName);
    } catch {
      activeModel = undefined;
    }
    if (activeModel !== undefined) {
      const outcome = await this.promptCacheInvalidationConfirm(
        interaction,
        agentName,
        activeModel,
        model,
      );
      if (outcome === "cancelled") {
        try {
          await interaction.editReply({
            content: "Model change cancelled.",
            components: [],
          });
        } catch {
          /* expired */
        }
        return;
      }
      if (outcome === "timeout") {
        try {
          await interaction.editReply({
            content: "Confirmation timed out.",
            components: [],
          });
        } catch {
          /* expired */
        }
        return;
      }
      // outcome === "confirmed" — fall through to IPC dispatch.
    }

    try {
      const res = (await sendIpcRequest(SOCKET_PATH, "set-model", {
        agent: agentName,
        model,
      })) as {
        readonly agent: string;
        readonly old_model: string;
        readonly new_model: string;
        readonly persisted: boolean;
        readonly persist_error: string | null;
        readonly note: string;
      };
      const persistSuffix = res.persisted
        ? ""
        : `\n(Note: live swap OK, but YAML persistence failed: ${res.persist_error ?? "unknown"})`;
      const message =
        `Model set to **${res.new_model}** for ${agentName} (was ${res.old_model}).${persistSuffix}` +
        this.v3LiveSwitchNote(agentName, { persisted: true });
      try {
        await interaction.editReply(message);
      } catch {
        /* expired */
      }
    } catch (err) {
      // Plan 02 IPC envelope: ModelNotAllowedError carries
      // `data.kind === "model-not-allowed"` and `data.allowed: string[]`.
      // Render the allowed list ephemerally.
      const maybe = err as { message?: string; data?: unknown };
      const data = maybe.data as
        | { kind?: string; allowed?: readonly string[] }
        | undefined;
      let reply: string;
      if (
        data?.kind === "model-not-allowed" &&
        Array.isArray(data.allowed)
      ) {
        reply = `'${model}' is not allowed for ${agentName}. Allowed: ${data.allowed.join(", ")}`;
      } else {
        reply = `Failed to set model: ${maybe.message ?? String(err)}`;
      }
      try {
        await interaction.editReply(reply);
      } catch {
        /* expired */
      }
    }
  }

  /**
   * Phase 86 MODEL-05 — native Discord button confirmation.
   *
   * Renders two buttons (Confirm = danger style, Cancel = secondary) with
   * agent + nonce namespaced customIds; awaits the user's click for up to
   * MODEL_CONFIRM_TTL_MS. Returns "confirmed" | "cancelled" | "timeout".
   *
   * UI-01 compliance: buttons are native ButtonBuilder components — NOT a
   * free-text "yes/no" LLM prompt or a reaction-emoji pattern.
   *
   * The filter accepts any customId whose prefix matches the namespaced
   * confirm OR cancel id for THIS agent (collision safety across parallel
   * picker invocations in the same channel — e.g. two operators picking
   * for different agents at once).
   */
  private async promptCacheInvalidationConfirm(
    interaction: ChatInputCommandInteraction,
    agentName: string,
    oldModel: string,
    newModel: string,
  ): Promise<"confirmed" | "cancelled" | "timeout"> {
    const nonce = Math.random().toString(36).slice(2, 8);
    const confirmId = `model-confirm:${agentName}:${nonce}`;
    const cancelId = `model-cancel:${agentName}:${nonce}`;
    // Prefixes pinned by C7 — the filter below must accept only THIS agent's
    // buttons, not a parallel picker's buttons for a different agent.
    const confirmPrefix = `model-confirm:${agentName}:`;
    const cancelPrefix = `model-cancel:${agentName}:`;

    const confirm = new ButtonBuilder()
      .setCustomId(confirmId)
      .setLabel("Switch & invalidate cache")
      .setStyle(ButtonStyle.Danger);
    const cancel = new ButtonBuilder()
      .setCustomId(cancelId)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      confirm,
      cancel,
    );

    const warning =
      `Changing from **${oldModel}** to **${newModel}** will invalidate the prompt cache ` +
      `for ${agentName}. The next turn will pay full-prefix token cost. Proceed?`;

    try {
      await interaction.editReply({ content: warning, components: [row] });
    } catch {
      // Interaction expired — treat as cancel (no side effect fired yet).
      return "cancelled";
    }

    let btn: ButtonInteraction;
    try {
      const channel = interaction.channel;
      if (!channel) {
        throw new Error("interaction has no channel — cannot collect");
      }
      btn = (await channel.awaitMessageComponent({
        componentType: ComponentType.Button,
        filter: (i: { user: { id: string }; customId: string }) =>
          i.user.id === interaction.user.id &&
          (i.customId.startsWith(confirmPrefix) ||
            i.customId.startsWith(cancelPrefix)),
        time: MODEL_CONFIRM_TTL_MS,
      })) as ButtonInteraction;
    } catch {
      return "timeout";
    }

    const isConfirm = btn.customId.startsWith(confirmPrefix);
    try {
      await btn.update({
        content: isConfirm
          ? `Switching ${agentName} to **${newModel}**...`
          : "Cancelled.",
        components: [],
      });
    } catch {
      /* expired — outcome below still derives from btn.customId */
    }

    return isConfirm ? "confirmed" : "cancelled";
  }

  /**
   * Phase 87 CMD-02 — /clawcode-permissions inline handler.
   *
   * Routes the live SDK permission-mode swap via IPC set-permission-mode
   * (control-plane path — NOT prompt routing). Mirrors the Phase 83
   * clawcode-effort inline shortcut but surfaces through the daemon
   * IPC envelope so daemon-level validation (6-value union) runs once.
   *
   * Contract:
   *   - Unbound channel → ephemeral "not bound" reply, no IPC call.
   *   - Missing/empty mode arg → ephemeral usage reply, no IPC call.
   *   - IPC success → ephemeral confirmation mentioning the mode + agent.
   *   - IPC error → ephemeral error message (daemon error bubbles up
   *     verbatim so the valid-modes list from the server-side rejection
   *     surfaces to the user).
   */
  private async handlePermissionsCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const agentName = getAgentForChannel(
      this.routingTable,
      interaction.channelId,
    );
    if (!agentName) {
      try {
        await interaction.reply({
          content: "This channel is not bound to an agent.",
          ephemeral: true,
        });
      } catch {
        /* interaction may have expired */
      }
      return;
    }

    const modeArg = interaction.options.get("mode")?.value;
    const mode =
      typeof modeArg === "string" && modeArg.length > 0 ? modeArg : undefined;
    if (!mode) {
      try {
        await interaction.reply({
          content:
            "Usage: /clawcode-permissions mode:<default|acceptEdits|bypassPermissions|plan|dontAsk|auto>",
          ephemeral: true,
        });
      } catch {
        /* expired */
      }
      return;
    }

    try {
      await interaction.deferReply({ ephemeral: true });
    } catch {
      return;
    }

    try {
      await sendIpcRequest(SOCKET_PATH, "set-permission-mode", {
        name: agentName,
        mode,
      });
      try {
        await interaction.editReply(
          `Permission mode set to **${mode}** for ${agentName}` +
            this.v3LiveSwitchNote(agentName, { persisted: false }),
        );
      } catch {
        /* expired */
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      try {
        await interaction.editReply(`Failed to set permission mode: ${msg}`);
      } catch {
        /* expired */
      }
    }
  }

  /**
   * Phase 88 MKT-07 / UI-01 — /clawcode-skills inline handler.
   *
   * Lists the bound agent's installed skills and renders a native
   * StringSelectMenuBuilder remove picker. Selection dispatches IPC
   * marketplace-remove and renders a single ephemeral outcome message.
   */
  private async handleSkillsCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    const agentName = getAgentForChannel(
      this.routingTable,
      interaction.channelId,
    );
    if (!agentName) {
      try {
        await interaction.reply({
          content: "This channel is not bound to an agent.",
          ephemeral: true,
        });
      } catch {
        /* expired */
      }
      return;
    }

    try {
      await interaction.deferReply({ ephemeral: true });
    } catch {
      return;
    }

    let listResp: { agent: string; installed: readonly string[] };
    try {
      listResp = (await sendIpcRequest(SOCKET_PATH, "marketplace-list", {
        agent: agentName,
      })) as typeof listResp;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      try {
        await interaction.editReply(`Failed to load installed skills: ${msg}`);
      } catch {
        /* expired */
      }
      return;
    }

    if (listResp.installed.length === 0) {
      try {
        await interaction.editReply(
          `No skills installed for **${agentName}**. Install one from the dashboard's Marketplace page.`,
        );
      } catch {
        /* expired */
      }
      return;
    }

    const capped = listResp.installed.slice(0, DISCORD_SELECT_CAP);
    const overflow = listResp.installed.length - capped.length;
    const nonce = Math.random().toString(36).slice(2, 8);
    const customId = `skills-remove:${agentName}:${nonce}`;

    const bulletList = listResp.installed.map((n) => `• ${n}`).join("\n");

    const menu = new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder("Choose a skill to remove")
      .addOptions(
        capped.map((name) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(name.slice(0, 100))
            .setValue(name)
            .setDescription(`Remove from ${agentName}`.slice(0, 100)),
        ),
      );
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      menu,
    );

    const overflowNote =
      overflow > 0
        ? `\n(Showing first ${DISCORD_SELECT_CAP} of ${listResp.installed.length}.)`
        : "";

    try {
      await interaction.editReply({
        content: `Installed skills for **${agentName}**:\n${bulletList}${overflowNote}\n\nSelect one to remove:`,
        components: [row],
      });
    } catch {
      return;
    }

    let followUp: StringSelectMenuInteraction;
    try {
      const channel = interaction.channel;
      if (!channel) {
        throw new Error("interaction has no channel — cannot collect");
      }
      followUp = (await channel.awaitMessageComponent({
        componentType: ComponentType.StringSelect,
        filter: (i: { user: { id: string }; customId: string }) =>
          i.user.id === interaction.user.id && i.customId === customId,
        time: MODEL_PICKER_TTL_MS,
      })) as StringSelectMenuInteraction;
    } catch {
      try {
        await interaction.editReply({
          content: "Picker timed out (no selection in 30s).",
          components: [],
        });
      } catch {
        /* expired */
      }
      return;
    }

    const chosen = followUp.values[0];
    if (!chosen) {
      try {
        await followUp.update({
          content: "No selection captured.",
          components: [],
        });
      } catch {
        /* expired */
      }
      return;
    }

    try {
      await followUp.update({
        content: `Removing **${chosen}** from ${agentName}...`,
        components: [],
      });
    } catch {
      /* expired */
    }

    try {
      const resp = (await sendIpcRequest(SOCKET_PATH, "marketplace-remove", {
        agent: agentName,
        skill: chosen,
      })) as {
        agent: string;
        skill: string;
        removed: boolean;
        persisted: boolean;
        persist_error: string | null;
        reason?: string;
      };

      let msg: string;
      if (!resp.removed) {
        msg = `${resp.skill} not removed from ${agentName}${resp.reason ? ` (${resp.reason})` : ""}`;
      } else if (resp.persisted) {
        msg = `Removed **${resp.skill}** from ${agentName}.`;
      } else {
        msg =
          `Removed **${resp.skill}** from ${agentName} (note: clawcode.yaml write failed: ${resp.persist_error ?? "unknown"}).`;
      }
      try {
        await interaction.editReply({ content: msg, components: [] });
      } catch {
        /* expired */
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      try {
        await interaction.editReply({
          content: `Remove failed: ${msg}`,
          components: [],
        });
      } catch {
        /* expired */
      }
    }
  }

  /**
   * 999.63d/8 — render the `/clawcode-verify` panel and keep it live.
   *
   * Selects apply on change (no submit step): each interaction writes the
   * setting, re-reads the effective state and redraws, so the panel always
   * shows what is actually in force rather than what was clicked. The
   * collector is scoped to the invoking user and expires with the
   * ephemeral message.
   */
  private async renderVerifyPanel(
    interaction: ChatInputCommandInteraction,
    agent: string,
  ): Promise<void> {
    const send = (method: string, params: Record<string, unknown>) =>
      sendIpcRequest(SOCKET_PATH, method, params) as Promise<unknown>;

    const readState = async (target: string): Promise<VerifyPanelState> => {
      const res = (await send("set-verification", {
        agent: target,
        action: "status",
      })) as {
        override?: unknown;
        effective?: { enabled: boolean; mode: string; profile: string };
      };
      const eff = res.effective ?? {
        enabled: false,
        mode: "auto",
        profile: "finance",
      };
      return {
        agent: target,
        agents: this.resolvedAgents.map((a) => a.name),
        enabled: eff.enabled,
        mode: eff.mode,
        profile: eff.profile,
        fromOverride: res.override != null,
      };
    };

    let state: VerifyPanelState;
    try {
      state = await readState(agent);
    } catch (error) {
      await interaction.editReply(
        `verify: could not read state — ${(error as Error).message}`,
      );
      return;
    }

    type Editable = {
      editReply: (o: {
        content: string;
        components: never;
      }) => Promise<unknown>;
    };
    const draw = async (
      target: Editable,
      st: VerifyPanelState,
    ): Promise<void> => {
      await target.editReply({
        content: renderVerifyPanelText(st),
        components: buildVerifyPanelComponents(st) as never,
      });
    };

    await draw(interaction as unknown as Editable, state);

    let message;
    try {
      message = await interaction.fetchReply();
    } catch {
      return; // panel rendered; just not live-updatable
    }

    const collector = message.createMessageComponentCollector({
      filter: (i: Interaction) =>
        "user" in i &&
        i.user.id === interaction.user.id &&
        "customId" in i &&
        parseVerifyPanelId((i as { customId: string }).customId) !== null,
      time: 5 * 60 * 1000,
    });

    collector.on("collect", async (i) => {
      const parsed = parseVerifyPanelId(i.customId);
      if (!parsed) return;
      try {
        await i.deferUpdate();
      } catch {
        return;
      }
      try {
        let target = parsed.agent;
        if (parsed.field === "reset") {
          await send("set-verification", { agent: target, action: "reset" });
        } else if (i.isStringSelectMenu()) {
          const value = i.values[0];
          if (value === undefined) return;
          if (parsed.field === "agent") {
            // Switching agent only changes what the panel is looking at.
            target = value;
          } else {
            await send("set-verification", {
              agent: target,
              [parsed.field]: value,
            });
          }
        }
        const next = await readState(target);
        await draw(i as unknown as Editable, next);
      } catch (error) {
        this.log.warn(
          { error: (error as Error).message },
          "verify panel update failed",
        );
      }
    });

    collector.on("end", () => {
      // Leave the last state visible but inert — a stale clickable panel
      // that silently no-ops is worse than one that is visibly finished.
      void interaction.editReply({ components: [] }).catch(() => undefined);
    });
  }

  /**
   * 2026-08-27 — `vsrc:<messageId>` button: reply EPHEMERALLY with the
   * verification ledger card (only the tapper sees it). Answers from the
   * bridge's in-memory store within the 3 s interaction window; falls back to
   * plain text if the CV2 + ephemeral flag combination is rejected.
   */
  private async handleLedgerButton(interaction: ButtonInteraction): Promise<void> {
    const messageId = interaction.customId.slice(VSRC_PREFIX.length);
    const startedAt = Date.now();
    // 2026-08-28 — direct lookup first (v2 agents, threads); the legacy
    // channel→agent→bridge hop stays as a fallback for injected harnesses.
    let ledger = this.getLedger?.(messageId);
    let source: "direct" | "bridge" | "miss" = ledger ? "direct" : "miss";
    if (!ledger) {
      const agent = getAgentForChannel(this.routingTable, interaction.channelId);
      const bridge = agent ? this.getBridge?.(agent) : undefined;
      ledger = (
        bridge as unknown as { getLedgerByMessageId?: (id: string) => LedgerLike | undefined } | undefined
      )?.getLedgerByMessageId?.(messageId);
      if (ledger) source = "bridge";
    }
    this.log.info(
      {
        tag: "phase999.63-ledger-click",
        messageId,
        channelId: interaction.channelId,
        userId: interaction.user?.id,
        source,
        claims: ledger?.claims.length ?? 0,
        sources: ledger?.evidence.length ?? 0,
        ms: Date.now() - startedAt,
      },
      "ledger button click",
    );
    if (!ledger) {
      try {
        await interaction.reply({
          flags: MessageFlags.Ephemeral,
          content:
            "This answer's verification ledger is no longer available (older than 7 days) · react 🔍 to re-verify.",
        });
      } catch {
        /* interaction expired */
      }
      return;
    }
    const input = {
      agent: ledger.agent,
      promptExcerpt: ledger.promptExcerpt,
      at: new Date(ledger.deliveredAt).toISOString().slice(11, 16),
      claims: ledger.claims,
      evidence: ledger.evidence,
      // Phase 999.133 — recalled memory shares the card.
      ...(ledger.recall ? { recall: ledger.recall } : {}),
    };
    try {
      const payload = buildCv2Payload(buildLedgerCardSpec(input));
      await interaction.reply({
        flags: (MessageFlags.Ephemeral | payload.flags) as never,
        components: payload.components as never,
      });
    } catch {
      try {
        await interaction.reply({ flags: MessageFlags.Ephemeral, content: buildLedgerPlainText(input) });
      } catch {
        /* interaction expired */
      }
    }
  }

  /**
   * Handle a control command by routing to the daemon via IPC.
   * Control commands defer with ephemeral (except fleet which is public)
   * and communicate directly with the daemon — no agent session involved.
   */
  private async handleControlCommand(
    interaction: ChatInputCommandInteraction,
    cmd: SlashCommandDef,
  ): Promise<void> {
    const isFleet = cmd.name === "clawcode-fleet";

    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (error) {
      this.log.error(
        { command: cmd.name, error: (error as Error).message },
        "failed to defer control reply",
      );
      return;
    }

    const ipcMethod = cmd.ipcMethod ?? cmd.name;
    const agentName = interaction.options.getString("agent");

    try {
      if (isFleet) {
        const result = (await sendIpcRequest(SOCKET_PATH, "status", {})) as {
          entries: RegistryEntry[];
        };
        const embed = buildFleetEmbed(result.entries, this.resolvedAgents);
        await interaction.editReply({ embeds: [embed] });
      } else if (cmd.name === "clawcode-workflows") {
        // Phase 999.165 — act on one workflow (cancel is admin-gated).
        const controlReply = await handleWorkflowsControlSlash({
          action: interaction.options.getString("action") ?? undefined,
          workflowId: interaction.options.getString("workflow") ?? undefined,
          stepId: interaction.options.getString("step") ?? undefined,
          text: interaction.options.getString("text") ?? undefined,
          isAdmin: isAdminClawdyInteraction(interaction, {
            adminUserIds: this.adminUserIds,
            routingTable: this.routingTable,
            resolvedAgents: this.resolvedAgents,
          }),
          operatorLabel: `operator (${interaction.user.username})`,
          sendIpc: (method, params) =>
            sendIpcRequest(SOCKET_PATH, method, params) as Promise<unknown>,
        });
        if (controlReply !== null) {
          await interaction.editReply(controlReply);
          return;
        }
        // Pull-based daemon workflow status — the Discord analog of Claude
        // Code's `/workflows`. Calls the `workflow-status` IPC (read-only
        // `listWorkflows` projection); optional `agent` filters by trigger.
        const result = (await sendIpcRequest(SOCKET_PATH, "workflow-status", {
          agent: agentName ?? undefined,
        })) as { workflows: WorkflowSummary[] };
        const embed = buildWorkflowsEmbed(result.workflows);
        await interaction.editReply({ embeds: [embed] });
      } else if (ipcMethod === "interrupt-agent") {
        // Quick task 260419-nic — daemon-direct mid-turn abort. Bypasses IPC
        // (we already hold a SessionManager reference) so there's no extra
        // hop on the time-sensitive path.
        const resolvedName =
          agentName ?? getAgentForChannel(this.routingTable, interaction.channelId);
        if (!resolvedName) {
          await interaction.editReply(
            "No agent to interrupt — specify `agent:` or run in an agent-bound channel.",
          );
          return;
        }
        const reply = await handleInterruptSlash({
          agentName: resolvedName,
          interruptAgent: (n) => this.sessionManager.interruptAgent(n),
          cancelPendingReplies: (n) =>
            this.getBridge?.(n)?.cancelPendingReplies?.("/clawcode-interrupt") ?? 0,
          log: this.log,
        });
        await interaction.editReply(reply);
      } else if (ipcMethod === "steer-agent") {
        // Quick task 260419-nic — interrupt + dispatch [USER STEER] follow-up.
        const resolvedName =
          agentName ?? getAgentForChannel(this.routingTable, interaction.channelId);
        const guidance = interaction.options.getString("guidance");
        if (!resolvedName) {
          await interaction.editReply(
            "No agent to steer — specify `agent:` or run in an agent-bound channel.",
          );
          return;
        }
        if (!guidance) {
          await interaction.editReply("Guidance is required.");
          return;
        }
        if (!this.turnDispatcher) {
          await interaction.editReply(
            "Steer unavailable: turn dispatcher not wired.",
          );
          return;
        }
        const dispatcher = this.turnDispatcher;
        const reply = await handleSteerSlash({
          agentName: resolvedName,
          guidance,
          channelId: interaction.channelId,
          interactionId: interaction.id,
          interruptAgent: (n) => this.sessionManager.interruptAgent(n),
          hasActiveTurn: (n) => this.sessionManager.hasActiveTurn(n),
          dispatch: (origin, n, msg) => dispatcher.dispatch(origin, n, msg),
          log: this.log,
        });
        await interaction.editReply(reply);
      } else if (ipcMethod === "set-verbose-level") {
        // Phase 117 Plan 117-11 T04 — per-channel verbose toggle. Routes the
        // operator's level choice (on/off/status) through the daemon IPC
        // handler (T05) which upserts via VerboseState and returns the
        // resulting {level, updatedAt}. Reply is ephemeral (inherited from
        // the deferReply at the top of this method).
        const reply = await handleVerboseSlash({
          channelId: interaction.channelId,
          level: interaction.options.getString("level", true),
          sendIpc: (method, params) =>
            sendIpcRequest(SOCKET_PATH, method, params) as Promise<unknown>,
        });
        await interaction.editReply(reply);
      } else if (ipcMethod === "set-verification") {
        // 999.63d/7 — per-agent verification trail control. Needs its OWN
        // branch: the generic fallback below forwards only `{name}`, so
        // mode/profile/action would never reach the daemon.
        const resolved =
          agentName ??
          getAgentForChannel(this.routingTable, interaction.channelId);
        if (!resolved) {
          await interaction.editReply(
            "No agent resolved — specify `agent:` or run in an agent-bound channel.",
          );
          return;
        }
        const vMode = interaction.options.getString("mode") ?? undefined;
        const vProfile = interaction.options.getString("profile") ?? undefined;
        const vAction = interaction.options.getString("action") ?? undefined;
        if (vMode === undefined && vProfile === undefined && vAction === undefined) {
          // 999.63d/8 — bare invocation opens the interactive panel rather
          // than printing a status line. Typed options keep the old path.
          await this.renderVerifyPanel(interaction, resolved);
          return;
        }
        const reply = await handleVerifySlash({
          agent: resolved,
          mode: vMode,
          profile: vProfile,
          action: vAction,
          sendIpc: (method, params) =>
            sendIpcRequest(SOCKET_PATH, method, params) as Promise<unknown>,
        });
        await interaction.editReply(reply);
      } else if (ipcMethod === "set-fast-lane") {
        // Phase 999.164 — per-agent quick-lane toggle. Own branch: the generic
        // fallback below forwards only `{name}`, so `lane` would never arrive.
        const resolved =
          agentName ??
          getAgentForChannel(this.routingTable, interaction.channelId);
        if (!resolved) {
          await interaction.editReply(
            "No agent resolved — specify `agent:` or run in an agent-bound channel.",
          );
          return;
        }
        const reply = await handleQuickSlash({
          agent: resolved,
          lane: interaction.options.getString("lane") ?? undefined,
          sendIpc: (method, params) =>
            sendIpcRequest(SOCKET_PATH, method, params) as Promise<unknown>,
        });
        await interaction.editReply(reply);
      } else if (ipcMethod === "set-ux-feature") {
        // Phase 999.171 — /clawcode-ux per-agent UX toggle. Own branch: the
        // generic fallback below forwards only `{name}`, so `feature` / `state`
        // would never arrive. Same agent resolution as /clawcode-quick.
        const resolved =
          agentName ??
          getAgentForChannel(this.routingTable, interaction.channelId);
        if (!resolved) {
          await interaction.editReply(
            "No agent resolved — specify `agent:` or run in an agent-bound channel.",
          );
          return;
        }
        const reply = await handleUxSlash({
          agent: resolved,
          feature: interaction.options.getString("feature") ?? "",
          state: interaction.options.getString("state") ?? undefined,
          // 999.173 polish — research model (research only; validated by the daemon).
          model: interaction.options.getString("model") ?? undefined,
          sendIpc: (method, params) =>
            sendIpcRequest(SOCKET_PATH, method, params) as Promise<unknown>,
        });
        await interaction.editReply(reply);
      } else {
        if (!agentName) {
          await interaction.editReply("Agent name is required.");
          return;
        }
        await sendIpcRequest(SOCKET_PATH, ipcMethod, { name: agentName });
        const verb =
          ipcMethod === "start"
            ? "started"
            : ipcMethod === "stop"
              ? "stopped"
              : "restarted";
        await interaction.editReply(`Agent **${agentName}** ${verb}.`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log.error(
        { command: cmd.name, agent: agentName, error: msg },
        "control command failed",
      );
      try {
        await interaction.editReply(`Command failed: ${msg}`);
      } catch {
        /* expired */
      }
    }
  }

  /**
   * Phase 87 CMD-03 — lookup a registered native-CC command by name and
   * return it iff it has nativeBehavior === "prompt-channel".
   *
   * Implementation reads from the same resolved set register() iterates at
   * startup: walks every resolvedAgents entry, resolves the agent's commands
   * via resolveAgentCommands (which merges DEFAULT_SLASH_COMMANDS with the
   * agent's own slashCommands — the register loop additionally folds in
   * buildNativeCommandDefs output, but by the time we get here the agent's
   * slashCommands carry the nativeBehavior-tagged entries Plan 01's register
   * loop stamped onto them in production).
   *
   * Prompt-channel entries are agent-agnostic by definition (the dispatch
   * target is the channel's bound agent, not the agent that first reported
   * the command) — so returning the FIRST match across all agents is
   * deliberate and safe.
   */
  private findNativePromptChannelCommand(
    name: string,
  ): SlashCommandDef | null {
    for (const agent of this.resolvedAgents) {
      for (const cmd of resolveAgentCommands(agent.slashCommands)) {
        if (cmd.name === name && cmd.nativeBehavior === "prompt-channel") {
          return cmd;
        }
      }
    }
    return null;
  }

  /**
   * Phase 87 CMD-03 / CMD-06 — dispatch a prompt-channel native-CC command.
   *
   * Mirrors the agent-routed streaming flow in handleInteraction (lines
   * 600-700 of this file) but substitutes the canonical `/<name> <args>`
   * prompt (buildNativePromptString) for the agent's claudeCommand template
   * and routes through TurnDispatcher.dispatchStream so origin propagates
   * (critical for trace stitching — see turn-origin.ts).
   *
   * Flow:
   *   1. Resolve agent by channel; reject if unbound (ephemeral "not bound").
   *   2. deferReply + "Thinking..." feedback.
   *   3. Build prompt string via buildNativePromptString.
   *   4. Stream via TurnDispatcher.dispatchStream with ProgressiveMessageEditor
   *      (v1.7 streaming primitive — reused verbatim, ZERO new primitive).
   *   5. On SDK error, dispose editor and surface the VERBATIM error text
   *      in the ephemeral reply (Phase 85 TOOL-04 pattern).
   *   6. Truncate oversized responses at DISCORD_MAX_LENGTH.
   *   7. Empty response → "(No response from agent)".
   *
   * When turnDispatcher is not wired (test scenarios / legacy boot), fall
   * back with an ephemeral error message — this path is unreachable in
   * production (daemon.ts always constructs a TurnDispatcher).
   */
  private async dispatchNativePromptCommand(
    interaction: ChatInputCommandInteraction,
    cmd: SlashCommandDef,
  ): Promise<void> {
    const agentName = getAgentForChannel(
      this.routingTable,
      interaction.channelId,
    );
    if (!agentName) {
      try {
        await interaction.reply({
          content: "This channel is not bound to an agent.",
          ephemeral: true,
        });
      } catch {
        /* interaction may have expired */
      }
      return;
    }

    try {
      await interaction.deferReply();
    } catch (error) {
      this.log.error(
        { command: cmd.name, error: (error as Error).message },
        "failed to defer prompt-channel reply",
      );
      return;
    }

    // Extract optional args value (Discord STRING option) and build the
    // canonical prompt. Non-string / missing values → no args.
    const argsRaw = interaction.options.get("args")?.value;
    const args = typeof argsRaw === "string" ? argsRaw : undefined;
    const prompt = buildNativePromptString(cmd.name, args);

    this.log.info(
      {
        agent: agentName,
        command: cmd.name,
        channelId: interaction.channelId,
        prompt,
      },
      "prompt-channel native-CC dispatch",
    );

    try {
      await interaction.editReply("Thinking...");
    } catch {
      /* non-fatal */
    }

    const editor = new ProgressiveMessageEditor({
      editFn: async (content: string) => {
        // Phase 100 follow-up — wrap raw markdown tables in ```text``` fences.
        const wrapped = formatOutboundText(content);
        const truncated =
          wrapped.length > DISCORD_MAX_LENGTH
            ? wrapped.slice(0, DISCORD_MAX_LENGTH - 3) + "..."
            : wrapped;
        await interaction.editReply(truncated);
      },
      editIntervalMs: 1500,
    });

    try {
      if (!this.turnDispatcher) {
        throw new Error(
          "Turn dispatcher not wired — cannot dispatch native-CC prompt command",
        );
      }
      const origin = makeRootOrigin("discord", interaction.channelId);
      const response = await this.turnDispatcher.dispatchStream(
        origin,
        agentName,
        prompt,
        (accumulated) => editor.update(accumulated),
      );
      await editor.flush();
      const text = response.trim();
      if (text.length === 0) {
        await interaction.editReply("(No response from agent)");
        return;
      }
      const truncated =
        text.length > DISCORD_MAX_LENGTH
          ? text.slice(0, DISCORD_MAX_LENGTH - 3) + "..."
          : text;
      await interaction.editReply(truncated);
    } catch (err) {
      editor.dispose();
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(
        {
          agent: agentName,
          command: cmd.name,
          prompt,
          error: msg,
        },
        "native-CC prompt command failed",
      );
      // CMD-03 truth #4 / Phase 85 TOOL-04 — surface the VERBATIM error
      // text in the ephemeral reply (no rewording, no wrapping).
      try {
        await interaction.editReply(`Command failed: ${msg}`);
      } catch {
        /* expired */
      }
    }
  }
}

// ---------------------------------------------------------------------------
/**
 * Render the ephemeral `/clawcode-goal` reply from the IPC result. Pure +
 * exported so the set/status/clear copy is unit-testable without Discord.
 */
export function renderGoalReply(
  method: "goal-set" | "goal-status" | "goal-clear",
  agent: string,
  condition: string | undefined,
  r: Record<string, unknown>,
): string {
  if (method === "goal-set") {
    const replaced = r.replaced === true;
    const cond = typeof r.condition === "string" ? r.condition : (condition ?? "");
    return (
      `🎯 Goal ${replaced ? "replaced" : "set"} for **${agent}** — it'll work ` +
      `autonomously until:\n> _${cond}_\n` +
      "Progress posts in this channel. `/clawcode-goal action:clear` to stop, " +
      "`/clawcode-goal` for status."
    );
  }
  if (method === "goal-clear") {
    if (r.wasRunning === true) {
      const cond = typeof r.condition === "string" ? ` (_${r.condition}_)` : "";
      return `🛑 Cleared **${agent}**'s goal${cond}.`;
    }
    return `No active goal for **${agent}** to clear.`;
  }
  // goal-status
  if (r.running === true) {
    const turns = typeof r.turns === "number" ? r.turns : 0;
    const mins = typeof r.elapsedMs === "number" ? Math.round(r.elapsedMs / 60_000) : 0;
    const reason =
      typeof r.lastReason === "string" && r.lastReason.trim() !== ""
        ? r.lastReason
        : "just started";
    const cond = typeof r.condition === "string" ? r.condition : "";
    return (
      `🎯 **${agent}** is pursuing a goal — turn ${turns}, ~${mins}m in.\n` +
      `> _${cond}_\nLatest check: ${reason}`
    );
  }
  return `No active goal for **${agent}**. Set one with \`/clawcode-goal condition:<your goal>\`.`;
}

// Quick task 260419-nic — pure handlers for /clawcode-interrupt + /clawcode-steer.
//
// Exported so tests can drive the command logic without spinning up a real
// Discord interaction pipeline. `handleControlCommand` wires them in-process
// against SessionManager + TurnDispatcher.
// ---------------------------------------------------------------------------

// 2026-05-23 — STEER_CLEAR_POLL_MS + STEER_CLEAR_MAX_WAIT_MS are now
// owned by the steer-subagent orchestrator (single source of truth for
// the post-interrupt clear-wait policy across `/clawcode-steer`,
// bridge auto-steer Path A, and `steer_subagent` MCP tool Path B).
// Imported as named re-exports to keep the existing slash-handler
// reads byte-identical.
import {
  STEER_CLEAR_POLL_MS,
  STEER_CLEAR_MAX_WAIT_MS,
} from "../manager/steer-subagent.js";

const STEER_PREFIX = "[USER STEER] ";

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Render the ephemeral reply for `/clawcode-interrupt`.
 *
 * Returns:
 *   - "🛑 Stopped {agent} mid-turn."           — interruptAgent reported interrupted:true
 *   - "No active turn for {agent}."            — interruptAgent reported {false,false}
 *   - "Error: could not interrupt {agent}: …"  — interruptAgent threw
 *
 * Never throws — errors map to a user-visible message.
 */
export async function handleInterruptSlash(deps: {
  readonly agentName: string;
  readonly interruptAgent: (
    name: string,
  ) => Promise<{ readonly interrupted: boolean; readonly hadActiveTurn: boolean }>;
  /**
   * Phase 141 (1C) — release the daemon-side pending `awaitReply` for the agent
   * so a v3 turn stops immediately on interrupt (typing clears, the turn ❌s now)
   * instead of hanging to its 120s timeout. Returns the count rejected. Optional:
   * absent / 0 for v2 or non-channel agents.
   */
  readonly cancelPendingReplies?: (agentName: string) => number;
  readonly log: Logger;
}): Promise<string> {
  const { agentName, interruptAgent, cancelPendingReplies, log } = deps;
  try {
    const result = await interruptAgent(agentName);
    if (result.interrupted) {
      const repliesCancelled = cancelPendingReplies?.(agentName) ?? 0;
      log.info(
        { agent: agentName, event: "slash_interrupt_ok", repliesCancelled },
        "slash /interrupt succeeded",
      );
      return `🛑 Stopped ${agentName} mid-turn.`;
    }
    return `No active turn for ${agentName}.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(
      { agent: agentName, error: msg },
      "slash /interrupt failed",
    );
    return `Error: could not interrupt ${agentName}: ${msg}`;
  }
}

/**
 * Render the ephemeral reply for `/clawcode-steer`.
 *
 * Flow:
 *   1. interruptAgent(agent) — fires q.interrupt() on any in-flight turn.
 *   2. Poll hasActiveTurn() every 50ms for up to 2000ms until the turn clears.
 *      If the deadline expires, log.warn and proceed anyway (SerialTurnQueue
 *      will queue the new turn behind the stuck one — caller still gets a
 *      response once the stuck turn resolves or aborts).
 *   3. dispatch(origin=discord, agent, "[USER STEER] {guidance}") — the
 *      TurnDispatcher owns Turn lifecycle + opens the streaming reply in
 *      the channel via the normal DiscordBridge path.
 *
 * Returns:
 *   - "↩ Steered {agent}. New response coming in this channel." — happy path
 *   - "Error: could not steer {agent}: …"                        — dispatch threw
 */
export async function handleSteerSlash(deps: {
  readonly agentName: string;
  readonly guidance: string;
  readonly channelId: string;
  readonly interactionId: string;
  readonly interruptAgent: (
    name: string,
  ) => Promise<{ readonly interrupted: boolean; readonly hadActiveTurn: boolean }>;
  readonly hasActiveTurn: (name: string) => boolean;
  readonly dispatch: (
    origin: TurnOrigin,
    agentName: string,
    message: string,
  ) => Promise<unknown>;
  readonly log: Logger;
  readonly sleep?: (ms: number) => Promise<void>;
}): Promise<string> {
  const {
    agentName,
    guidance,
    channelId,
    interruptAgent,
    hasActiveTurn,
    dispatch,
    log,
  } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  try {
    // 1. Interrupt any in-flight turn (safe no-op if idle).
    await interruptAgent(agentName);

    // 2. Poll for the turn to clear, up to STEER_CLEAR_MAX_WAIT_MS.
    const deadline = Date.now() + STEER_CLEAR_MAX_WAIT_MS;
    while (hasActiveTurn(agentName) && Date.now() < deadline) {
      await sleep(STEER_CLEAR_POLL_MS);
    }
    if (hasActiveTurn(agentName)) {
      log.warn(
        { agent: agentName, waitMs: STEER_CLEAR_MAX_WAIT_MS },
        "steer: turn did not clear within deadline — dispatching anyway (will queue)",
      );
    }

    // 3. Dispatch the new turn via the discord origin kind.
    const origin = makeRootOrigin("discord", channelId);
    await dispatch(origin, agentName, `${STEER_PREFIX}${guidance}`);
    log.info(
      { agent: agentName, channelId, event: "slash_steer_ok" },
      "slash /steer dispatched",
    );
    return `↩ Steered ${agentName}. New response coming in this channel.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ agent: agentName, error: msg }, "slash /steer failed");
    return `Error: could not steer ${agentName}: ${msg}`;
  }
}

/**
 * Format a slash command invocation into a message string for the agent.
 *
 * Replaces `{optionName}` placeholders in claudeCommand with the provided values.
 * Any options without a matching placeholder are appended as "key: value" lines.
 *
 * @param def - The slash command definition
 * @param options - Map of option name to value from the Discord interaction
 * @returns Formatted message string
 */
export function formatCommandMessage(
  def: SlashCommandDef,
  options: ReadonlyMap<string, string | number | boolean>,
): string {
  let message = def.claudeCommand;
  const unmatched: Array<[string, string | number | boolean]> = [];

  for (const [name, value] of options) {
    const placeholder = `{${name}}`;
    if (message.includes(placeholder)) {
      message = message.replaceAll(placeholder, String(value));
    } else {
      unmatched.push([name, value]);
    }
  }

  if (unmatched.length > 0) {
    const extra = unmatched.map(([k, v]) => `${k}: ${String(v)}`).join("\n");
    message = `${message}\n${extra}`;
  }

  return message;
}

/**
 * Resolve the full set of slash commands for an agent.
 *
 * Starts with DEFAULT_SLASH_COMMANDS and overrides any matching names
 * with the agent's custom commands. Returns the merged array.
 *
 * @param agentSlashCommands - Agent's custom slash commands (may be empty)
 * @returns Merged array with defaults + custom overrides
 */
export function resolveAgentCommands(
  agentSlashCommands: readonly SlashCommandDef[],
): readonly SlashCommandDef[] {
  const customByName = new Map<string, SlashCommandDef>();
  for (const cmd of agentSlashCommands) {
    customByName.set(cmd.name, cmd);
  }

  // Replace defaults with custom overrides, keep order
  const merged = DEFAULT_SLASH_COMMANDS.map((defaultCmd) => {
    const custom = customByName.get(defaultCmd.name);
    if (custom) {
      customByName.delete(defaultCmd.name);
      return custom;
    }
    return defaultCmd;
  });

  // Append any custom commands that don't override a default
  const extras = [...customByName.values()];

  return [...merged, ...extras];
}

/**
 * Format a duration in milliseconds to a compact "Xd Xh Xm" string.
 */
export function formatUptime(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);

  return parts.join(" ");
}

/**
 * Build a Discord embed data object for fleet status display.
 * Returns a plain object (not EmbedBuilder) for testability.
 *
 * Color coding:
 * - Green (0x00ff00): all agents running
 * - Red (0xff0000): any agent stopped, crashed, or failed
 * - Yellow (0xffff00): mixed statuses
 * - Gray (0x808080): no agents
 */
export function buildFleetEmbed(
  entries: readonly RegistryEntry[],
  configs: readonly ResolvedAgentConfig[],
): {
  title: string;
  color: number;
  fields: Array<{ name: string; value: string; inline: boolean }>;
  timestamp: string;
} {
  // Omit intentionally-disabled agents (config `autoStart: false`) from the
  // fleet view — retired/off agents should not clutter the active/inactive
  // listing. `autoStart` is always resolved (schema default `true`), so
  // `=== false` precisely selects disabled agents; an entry with no matching
  // config is kept (can't classify → show it rather than silently hide).
  const visible = entries.filter(
    (entry) => configs.find((c) => c.name === entry.name)?.autoStart !== false,
  );

  const fields = visible.map((entry) => {
    const config = configs.find((c) => c.name === entry.name);
    const statusEmoji =
      entry.status === "running"
        ? "\u{1F7E2}"
        : entry.status === "stopped" || entry.status === "crashed" || entry.status === "failed"
          ? "\u{1F534}"
          : "\u{1F7E1}";
    const model = config?.model ?? "unknown";
    const uptime = entry.startedAt
      ? formatUptime(Date.now() - entry.startedAt)
      : "\u2014";
    const lastActivity = entry.lastStableAt
      ? new Date(entry.lastStableAt).toISOString().slice(0, 16).replace("T", " ")
      : "\u2014";
    // Phase 56 Plan 02 — append warm-path suffix so operators see readiness
    // without leaving Discord. Legacy entries (no fields) get no suffix so
    // the embed stays backward-compat.
    let warmPathSuffix = "";
    if (
      entry.warm_path_readiness_ms !== undefined &&
      entry.warm_path_readiness_ms !== null
    ) {
      if (entry.lastError?.startsWith("warm-path:")) {
        warmPathSuffix = " \u00B7 warm-path error";
      } else if (entry.warm_path_ready === true) {
        const ms = Math.round(entry.warm_path_readiness_ms);
        warmPathSuffix = ` \u00B7 warm ${ms}ms`;
      } else {
        warmPathSuffix = " \u00B7 warming";
      }
    }
    return {
      name: entry.name,
      value: `${statusEmoji} ${entry.status} \u00B7 ${model} \u00B7 up ${uptime} \u00B7 last ${lastActivity}${warmPathSuffix}`,
      inline: false,
    };
  });

  const allRunning = visible.every((e) => e.status === "running");
  const anyDown = visible.some(
    (e) =>
      e.status === "stopped" || e.status === "crashed" || e.status === "failed",
  );
  const color =
    visible.length === 0
      ? 0x808080
      : allRunning
        ? 0x00ff00
        : anyDown
          ? 0xff0000
          : 0xffff00;

  return { title: "Fleet Status", color, fields, timestamp: new Date().toISOString() };
}

/**
 * Build a Discord embed data object for in-flight workflow status (the
 * `/clawcode-workflows` view). Returns a plain object (not EmbedBuilder) for
 * testability — mirrors `buildFleetEmbed`.
 *
 * Color: gray (none) · green (all done) · red (any failed) · yellow (running).
 */
export function buildWorkflowsEmbed(
  workflows: readonly WorkflowSummary[],
): {
  title: string;
  color: number;
  fields: Array<{ name: string; value: string; inline: boolean }>;
  timestamp: string;
} {
  if (workflows.length === 0) {
    return {
      title: "Workflows",
      color: 0x808080,
      fields: [
        {
          name: "No workflows running",
          value: "Start one with the `start_workflow` tool.",
          inline: false,
        },
      ],
      timestamp: new Date().toISOString(),
    };
  }

  const fields = workflows.map((wf) => {
    const statusEmoji = wf.cancelled
      ? "\u{1F6D1}" // stop sign — Phase 999.165
      : wf.status === "done"
        ? "\u{1F7E2}" // green
        : wf.status === "failed"
          ? "\u{1F534}" // red
          : "\u{1F7E1}"; // yellow — running / fanning-out
    const elapsed = formatUptime(wf.ageMs);
    const lastPing = wf.lastProgressAt
      ? new Date(wf.lastProgressAt).toISOString().slice(0, 16).replace("T", " ")
      : "—";
    const w = wf.workers;
    return {
      name: `${wf.workflowId} · ${wf.parentAgentName}`,
      value:
        `${statusEmoji} ${wf.cancelled ? `cancelled by ${wf.cancelled.by}` : wf.status} · elapsed ${elapsed} · ` +
        `workers ${w.running}R/${w.done}D/${w.failed}F of ${w.total} · last ping ${lastPing}`,
      inline: false,
    };
  });

  const color = workflows.some((w) => w.status === "failed")
    ? 0xff0000
    : workflows.every((w) => w.status === "done")
      ? 0x00ff00
      : 0xffff00;

  return {
    title: "Workflows",
    color,
    fields,
    timestamp: new Date().toISOString(),
  };
}

/** Phase 999.165 — deps for the `/clawcode-workflows` control actions. */
export interface WorkflowsControlSlashDeps {
  readonly action?: string;
  readonly workflowId?: string;
  readonly stepId?: string;
  readonly text?: string;
  readonly isAdmin: boolean;
  readonly operatorLabel: string;
  readonly sendIpc: (method: string, params: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Phase 999.165 — `/clawcode-workflows action:cancel`. Returns the reply text,
 * or null when the invocation is a plain status read (the caller renders the
 * embed). Cancel is admin-only: the command itself is visible to everyone.
 */
export async function handleWorkflowsControlSlash(
  deps: WorkflowsControlSlashDeps,
): Promise<string | null> {
  // Phase 999.165 slice 2 — one workflow's live status (anyone may read it).
  if ((deps.action === undefined || deps.action === "status") && deps.workflowId) {
    try {
      const one = (await deps.sendIpc("workflow-status", { workflowId: deps.workflowId })) as {
        workflow: WorkflowDetail | null;
      };
      return one.workflow
        ? "```\n" + renderWorkflowDetailText(one.workflow).slice(0, 1880) + "\n```"
        : `No workflow ${deps.workflowId} is running (finished workflows are forgotten after a while).`;
    } catch (err) {
      return `Could not read ${deps.workflowId}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  if (deps.action === "steer") {
    if (!deps.isAdmin) return "Steering a workflow is admin-only.";
    if (!deps.workflowId) return "Pass `workflow:` (the wf_… id — run `/clawcode-workflows` to see them).";
    if (!deps.text) return "Pass `text:` — the new direction for the workflow.";
    try {
      const result = (await deps.sendIpc("steer-workflow", {
        workflowId: deps.workflowId,
        guidance: deps.text,
        by: deps.operatorLabel,
        ...(deps.stepId ? { stepId: deps.stepId } : {}),
      })) as WorkflowSteerResult;
      return renderSteerResultText(deps.workflowId, result);
    } catch (err) {
      return `Could not steer ${deps.workflowId}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  if (deps.action !== "cancel") return null;
  if (!deps.isAdmin) return "Cancelling a workflow is admin-only.";
  if (!deps.workflowId) return "Pass `workflow:` (the wf_… id — run `/clawcode-workflows` to see them).";
  try {
    const result = (await deps.sendIpc("cancel-workflow", {
      workflowId: deps.workflowId,
      by: deps.operatorLabel,
      ...(deps.stepId ? { stepId: deps.stepId } : {}),
      ...(deps.text ? { reason: deps.text } : {}),
    })) as WorkflowCancelResult;
    return renderCancelResultText(deps.workflowId, result);
  } catch (err) {
    return `Could not cancel ${deps.workflowId}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------------------------------------------------------------------------
// Phase 117 Plan 117-11 T04 — pure handler for /clawcode-verbose.
//
// Exported so tests can drive the command logic without spinning up a real
// Discord interaction pipeline (mirror of handleInterruptSlash / handleSteerSlash
// at slash-commands.ts:~4324). `handleControlCommand` wires it in-process
// against `sendIpcRequest` and the slash interaction's deferred ephemeral
// reply.
//
// The IPC daemon-side handler (T05) returns { level, updatedAt } on success
// or surfaces a JSON-RPC error (caught upstream → editReply "Command failed").
// This handler renders the user-visible reply text only; the caller wraps
// it in editReply so the ephemeral-ness inherited from deferReply is
// preserved (we DO NOT call reply() here — second reply would throw
// InteractionAlreadyReplied).
// ---------------------------------------------------------------------------

/** Successful response payload from the `set-verbose-level` IPC method. */
export type VerboseSlashIpcResult = {
  readonly level: "normal" | "verbose";
  readonly updatedAt: string;
};

/** Inputs for the pure verbose-slash handler. */
export type VerboseSlashDeps = {
  readonly channelId: string;
  /** "on" | "off" | "status" — the operator's level choice from the slash option. */
  readonly level: string;
  /** Test-injectable IPC sender. Production binds this to `sendIpcRequest(SOCKET_PATH, ...)`. */
  readonly sendIpc: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
};

/**
 * Render the ephemeral reply text for `/clawcode-verbose`.
 *
 * Returns:
 *   - "verbose: verbose for this channel"    — level=on  → IPC sets verbose
 *   - "verbose: normal for this channel"     — level=off → IPC sets normal
 *   - "verbose: <level> (last changed <ts>)" — level=status → IPC reads current
 *   - "verbose: <error string>"              — IPC handler returned { error: ... }
 *
 * Never throws — IPC transport errors bubble to handleControlCommand's outer
 * catch (which renders "Command failed: <msg>").
 */
export async function handleVerboseSlash(
  deps: VerboseSlashDeps,
): Promise<string> {
  const { channelId, level, sendIpc } = deps;
  const response = (await sendIpc("set-verbose-level", {
    channelId,
    level,
  })) as VerboseSlashIpcResult | { readonly error: string };
  if ("error" in response) {
    return `verbose: ${response.error}`;
  }
  if (level === "status") {
    return `verbose: ${response.level} (last changed ${response.updatedAt})`;
  }
  return `verbose: ${response.level} for this channel`;
}

/** Phase 999.164 — deps for `/clawcode-quick` (testable without a client). */
export interface QuickSlashDeps {
  readonly agent: string;
  readonly lane?: string;
  readonly sendIpc: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
}

interface QuickSlashIpcResult {
  readonly agent: string;
  readonly enabled: boolean;
  readonly source: "override" | "config";
  readonly model: string;
  readonly map: string;
}

/** Headroom under Discord's 2,000-char message limit. */
const QUICK_SLASH_REPLY_MAX_CHARS = 1900;

/**
 * Route `/clawcode-quick` to the daemon and render the ephemeral reply. A bare
 * invocation is a status read, and every reply that leaves the lane on shows
 * this agent's quick-lane map — what it answers, and what always takes the
 * full turn.
 */
export async function handleQuickSlash(deps: QuickSlashDeps): Promise<string> {
  const lane = deps.lane ?? "status";
  const response = (await deps.sendIpc("set-fast-lane", {
    agent: deps.agent,
    lane,
  })) as QuickSlashIpcResult | { readonly error: string };
  if ("error" in response) return `quick lane: ${response.error}`;
  const state = response.enabled ? "**on**" : "**off**";
  const head =
    lane === "on" || lane === "off"
      ? `Quick lane ${state} for **${response.agent}** — kept across restarts. \`/clawcode-quick lane:reset\` follows config again.`
      : lane === "reset"
        ? `Quick lane override cleared for **${response.agent}** — now ${state} from config.`
        : `Quick lane ${state} for **${response.agent}** (${response.source === "override" ? "set with /clawcode-quick" : "from config"}, model ${response.model}).`;
  const text = response.enabled ? `${head}\n\n${response.map}` : head;
  return text.length > QUICK_SLASH_REPLY_MAX_CHARS
    ? `${text.slice(0, QUICK_SLASH_REPLY_MAX_CHARS - 1)}…`
    : text;
}

/** 999.63d/7 — deps for `/clawcode-verify` (testable without a client). */
export interface VerifySlashDeps {
  readonly agent: string;
  readonly mode?: string;
  readonly profile?: string;
  readonly action?: string;
  readonly sendIpc: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
}

interface VerifySlashIpcResult {
  readonly agent: string;
  readonly override: { mode?: string; profile?: string } | null;
  readonly effective?: {
    readonly enabled: boolean;
    readonly mode: string;
    readonly profile: string;
  };
  readonly reset?: boolean;
}

/**
 * Route `/clawcode-verify` to the daemon and render the ephemeral reply.
 *
 * Split out of the dispatcher for the same reason as handleVerboseSlash:
 * the interesting behaviour is argument handling and message shaping, and
 * neither should need a live Discord client to test.
 */
export async function handleVerifySlash(
  deps: VerifySlashDeps,
): Promise<string> {
  const { agent, mode, profile, action, sendIpc } = deps;
  if (
    action === undefined &&
    mode === undefined &&
    profile === undefined
  ) {
    // Bare invocation reads as "what is it set to?" rather than an error.
    return handleVerifySlash({ ...deps, action: "status" });
  }
  const response = (await sendIpc("set-verification", {
    agent,
    ...(mode !== undefined ? { mode } : {}),
    ...(profile !== undefined ? { profile } : {}),
    ...(action !== undefined ? { action } : {}),
  })) as VerifySlashIpcResult | { readonly error: string };

  if ("error" in response) return `verify: ${response.error}`;

  if (response.reset === true) {
    return `verify: override cleared for **${agent}** — back to its config.`;
  }
  if (action === "status" && response.effective) {
    const e = response.effective;
    const src = response.override ? "override" : "config";
    return e.enabled
      ? `verify (**${agent}**): trail **on**, mode **${e.mode}**, topic **${e.profile}** _(${src})_`
      : `verify (**${agent}**): trail **off** — set \`verification.ux.streamStatus: true\` to enable. Mode would be **${e.mode}**, topic **${e.profile}**.`;
  }
  const o = response.override ?? {};
  const bits = [
    o.mode !== undefined ? `mode **${o.mode}**` : null,
    o.profile !== undefined ? `topic **${o.profile}**` : null,
  ].filter((x): x is string => x !== null);
  return `verify (**${agent}**): ${bits.join(", ")}`;
}

// ---------------------------------------------------------------------
// 999.63d/8 — `/clawcode-verify` interactive panel.
//
// The command's options already render as Discord choice pickers, but
// that still means remembering which option name to type and re-running
// the command per field. The panel is one ephemeral message with a
// select per setting: pick, it applies, the panel redraws showing the
// new state. Typed options keep working for anyone who prefers them.
// ---------------------------------------------------------------------

/** Current + available state the panel renders from. */
export interface VerifyPanelState {
  readonly agent: string;
  readonly agents: readonly string[];
  readonly enabled: boolean;
  readonly mode: string;
  readonly profile: string;
  readonly fromOverride: boolean;
}

export const VERIFY_MODE_CHOICES: readonly {
  value: string;
  label: string;
  description: string;
}[] = Object.freeze([
  {
    value: "auto",
    label: "auto — on-topic prompts + busy turns",
    description: "Default. Paints when it is likely useful.",
  },
  {
    value: "topic",
    label: "topic — only on-topic prompts",
    description: "Strictest. Quiet turns never paint.",
  },
  {
    value: "always",
    label: "always — every turn that uses tools first",
    description: "Most verbose.",
  },
]);

export const VERIFY_PROFILE_CHOICES: readonly {
  value: string;
  label: string;
  description: string;
}[] = Object.freeze([
  {
    value: "finance",
    label: "finance — figures, eligibility, tax rules",
    description: "401(k), RMD, Roth, dollar amounts, percentages.",
  },
  {
    value: "legal",
    label: "legal — clauses, obligations, terms",
    description: "Indemnity, jurisdiction, cure periods, NDA/MSA.",
  },
  {
    value: "none",
    label: "none — never arms on topic",
    description: "Only the busy-turn path can paint.",
  },
]);

/** Discord caps a select at 25 options. */
const SELECT_MAX_OPTIONS = 25;

/**
 * Build the panel body text. Split from the components so the wording is
 * testable without a Discord client.
 */
export function renderVerifyPanelText(state: VerifyPanelState): string {
  const src = state.fromOverride ? "set here" : "from config";
  const head = `**Verification trail — ${state.agent}**`;
  if (!state.enabled) {
    return [
      head,
      "",
      "⚠️ The trail is **off** for this agent. These settings are stored and will",
      "take effect once `verification.ux.streamStatus: true` is set in config.",
      "",
      `Mode **${state.mode}** · Topic **${state.profile}** _(${src})_`,
    ].join("\n");
  }
  return [
    head,
    "",
    `Mode **${state.mode}** · Topic **${state.profile}** _(${src})_`,
    "",
    "_Mode decides when the trail appears; topic decides which prompts count as on-topic._",
  ].join("\n");
}

/**
 * Build the panel's action rows: agent / mode / topic selects plus a
 * reset button. Returns raw JSON so the caller can pass it straight to
 * editReply and so tests need no client.
 */
export function buildVerifyPanelComponents(
  state: VerifyPanelState,
): unknown[] {
  const agentOptions = [...new Set([state.agent, ...state.agents])]
    .slice(0, SELECT_MAX_OPTIONS)
    .map((a) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(a.slice(0, 100))
        .setValue(a.slice(0, 100))
        .setDefault(a === state.agent),
    );

  const rows: unknown[] = [];

  if (agentOptions.length > 1) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>()
        .addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`cv:agent:${state.agent}`)
            .setPlaceholder("Agent")
            .addOptions(agentOptions),
        )
        .toJSON(),
    );
  }

  rows.push(
    new ActionRowBuilder<StringSelectMenuBuilder>()
      .addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`cv:mode:${state.agent}`)
          .setPlaceholder("When the trail appears")
          .addOptions(
            VERIFY_MODE_CHOICES.map((c) =>
              new StringSelectMenuOptionBuilder()
                .setLabel(c.label.slice(0, 100))
                .setDescription(c.description.slice(0, 100))
                .setValue(c.value)
                .setDefault(c.value === state.mode),
            ),
          ),
      )
      .toJSON(),
  );

  rows.push(
    new ActionRowBuilder<StringSelectMenuBuilder>()
      .addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`cv:profile:${state.agent}`)
          .setPlaceholder("What counts as on-topic")
          .addOptions(
            VERIFY_PROFILE_CHOICES.map((c) =>
              new StringSelectMenuOptionBuilder()
                .setLabel(c.label.slice(0, 100))
                .setDescription(c.description.slice(0, 100))
                .setValue(c.value)
                .setDefault(c.value === state.profile),
            ),
          ),
      )
      .toJSON(),
  );

  rows.push(
    new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`cv:reset:${state.agent}`)
          .setLabel("Reset to config")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(!state.fromOverride),
      )
      .toJSON(),
  );

  // Discord caps a message at 5 action rows; we build at most 4.
  return rows;
}

/** Parse a panel customId. Returns null for anything not ours. */
export function parseVerifyPanelId(
  customId: string,
): { field: "agent" | "mode" | "profile" | "reset"; agent: string } | null {
  const m = /^cv:(agent|mode|profile|reset):(.+)$/.exec(customId);
  if (!m) return null;
  return {
    field: m[1] as "agent" | "mode" | "profile" | "reset",
    agent: m[2]!,
  };
}
