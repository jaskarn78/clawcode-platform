import { nanoid } from "nanoid";
import type { Client, TextChannel } from "discord.js";
import type { Logger } from "pino";
import { readdir as fsReaddir, stat as fsStat } from "node:fs/promises";
import { join } from "node:path";
import type { SessionManager } from "../manager/session-manager.js";
import type { HeartbeatRunner } from "../heartbeat/runner.js";
import type { ResolvedAgentConfig } from "../shared/types.js";
import type { ThreadBinding, ThreadBindingRegistry } from "./thread-types.js";
import { DEFAULT_THREAD_CONFIG } from "./thread-types.js";
import type { SubagentThreadConfig, SubagentSpawnResult } from "./subagent-thread-types.js";
import {
  readThreadRegistry,
  mutateThreadRegistry,
  addBinding,
  removeBinding,
  getBindingForThread,
  getBindingsForAgent,
  stampLastDeliveryAt,
} from "./thread-registry.js";
import { logger } from "../shared/logger.js";
import { ManagerError } from "../shared/errors.js";
import { withRelayLock } from "../manager/relay-lock.js";
// Phase 99 sub-scope M (2026-04-26) — auto-relay subagent completion to parent.
import type { TurnDispatcher } from "../manager/turn-dispatcher.js";
import type { DaemonChannelMessage, AckInput } from "../channels/clawcode-channel-server.js";
// Phase 999.82-04 — channel-reply timeout surfaced to the wedge catch so a
// v3 subagent's channel dispatch that never acks is handled as a failed turn
// (notify parent), not a silent fall-through.
import { ChannelReplyTimeoutError } from "../manager/agent-channel-bridge.js";
import { makeRootOrigin } from "../manager/turn-origin.js";
// Debug session `in-tool-wedge-recovery` work-stream (B), FORK 1 — a
// wedged DELEGATED SUBAGENT turn is NEVER auto re-run (re-running would
// re-execute the parent's spawn instruction). It is notify-only: a clear
// notice is posted to the PARENT agent's channel. The `WedgeInfo` shape is
// attached to the thrown AbortError by the SDK handle.
import type { WedgeInfo } from "../manager/tool-mutation-classifier.js";
// Phase 999.114 — shared stall-notice renderer (same copy as the main channel).
import { describeStallNotice } from "../manager/tool-mutation-classifier.js";
// Finding 3 (260714-mkq review) — the workflow recursion-guard tool name,
// unioned into channel-less subagent disallowedTools (single-sourced with the
// orchestrator's own worker guard; no new string literal).
import { WORKFLOW_TOOL_DISALLOW } from "../manager/workflow-orchestrator.js";
// Phase 100 follow-up — progressive streaming into subagent threads so
// operators see "🔄 Working..." → live token stream → final message,
// instead of a silent thread until the subagent finishes its turn.
import { ProgressiveMessageEditor } from "./streaming.js";
import { formatOutboundText } from "./markdown-table-wrap.js";
// Sub-bug A (999.36 / D-04, D-05) typing-indicator emit loop for subagent
// thread dispatch. See src/discord/subagent-typing-loop.ts.
import { startTypingLoop } from "./subagent-typing-loop.js";
// Phase 999.57 (2026-05-15) — inheritance-override factory. See file doc
// for the four leak surfaces this slice plugs (heartbeat / MEMORY.md
// auto-load / hybrid-RRF retrieval / DB+disk flush timers).
import { buildSubagentOverrides } from "./subagent-config-overrides.js";
import { consolidateDelegatedWork } from "./subagent-consolidation.js";
// SUBAGENT COLD-START FIX — module-level seam to write to a v3 subagent's
// `claude --channels` PTY stdin. Used to deliver the delegated task as a
// self-submitting PTY turn AFTER the channel connects (the reliable trigger;
// a channel push can land in the connect→ready gap and never surface).
import { debugWriteToPtyForAgent } from "../llm-runtime/backends/claude-code-interactive.js";

/**
 * Phase 999.36 sub-bug B (D-07) — index where the editor's visible message
 * truncates with the "..." marker (slice(0, 1997) + "..."). Overflow loops
 * MUST use this index as their starting cursor (NOT 2000) so the bytes the
 * editor covered with "..." are recovered as overflow chunk 1's leading
 * bytes. Pre-fix: cursor = 2000 dropped bytes 1997..1999 at every chunk
 * seam.
 */
const EDITOR_TRUNCATE_INDEX = 1997;

/**
 * Debug session `autorelay-placeholder-misfire` (2026-05-22) — the exact
 * string posted as the streaming placeholder in `postInitialMessage`. Single-
 * sourced so (1) the placeholder send, (2) the autoRelay content gate, and
 * (3) the `relayCompletionToParent` defense-in-depth filter all agree on one
 * literal. If this string ever changes, all three sites update together.
 *
 * Why this is load-bearing: the editor that streams the subagent's real
 * reply edits this placeholder message in place. When the SDK delivers its
 * final text WITHOUT incremental `text_delta` events, the editor's `onChunk`
 * callback never fires, the placeholder is never edited, and the autoRelay
 * walk would otherwise relay this 13-char string to the parent as if it
 * were the subagent's completed result.
 */
export const SUBAGENT_WORKING_PLACEHOLDER = "🔄 Working...";

/**
 * Debug session `autorelay-placeholder-misfire` — pure predicate: does this
 * trimmed text represent real subagent output (vs. the unedited streaming
 * placeholder or an empty reply)?
 *
 * Used by the autoRelay content gate in `postInitialMessage`. The bug being
 * fixed is relaying the placeholder; the predicate therefore rejects exactly
 * two cases — an empty reply and a reply that is *exactly* the placeholder
 * string. It deliberately does NOT impose a length floor: a short genuine
 * reply ("Done.", "Confirmed.", "All set.") is real content a fire-and-
 * forget parent needs, and pre-fix behavior relayed those correctly.
 *
 * @param trimmed - already-trimmed candidate text
 * @returns true when `trimmed` is non-empty and not the streaming placeholder
 */
export function isRealSubagentContent(trimmed: string): boolean {
  if (trimmed.length === 0) return false;
  if (trimmed === SUBAGENT_WORKING_PLACEHOLDER) return false;
  return true;
}

/**
 * Phase 100 GSD-06 — pure helper: extract the parent agent's GSD project
 * root from a ResolvedAgentConfig.
 *
 * Returns the `gsd.projectDir` when set; undefined otherwise (which signals
 * `relayCompletionToParent` to skip artifact discovery entirely — the relay
 * still runs with the base Phase 99-M prompt, no behavior change for the
 * 14+ non-GSD agents in the fleet).
 *
 * Plan 100-01 added the `gsd?: { projectDir: string }` field to
 * ResolvedAgentConfig. This helper centralizes the optional-chain so
 * downstream consumers don't repeat the lookup.
 */
export function resolveArtifactRoot(
  parentConfig: ResolvedAgentConfig | undefined,
): string | undefined {
  return parentConfig?.gsd?.projectDir;
}

/**
 * Phase 100 GSD-06 — pure async helper: enumerate phase directories under
 * `<root>/.planning/phases/` filtered by mtime (last 24h) and prioritized by
 * phase-number prefix matching the task hint. Returns up to 5 RELATIVE paths
 * (from `<root>`) to keep Discord embeds compact (RESEARCH.md Pitfall 8 —
 * long phase slugs truncate Discord embeds).
 *
 * **Failures-swallow contract** (per Phase 99-M's existing relay
 * try/catch + log-and-swallow pattern at line 126-130):
 *   - root `.planning/phases/` doesn't exist → []
 *   - readdir errors (EACCES, ENOENT) → []
 *   - per-entry stat errors → entry skipped
 *
 * NEVER throws — caller's `relayCompletionToParent` is already in a
 * try/catch but this function returns the empty fallback proactively so the
 * relay extension is a true no-op when artifacts can't be discovered.
 *
 * **Filtering & sorting logic:**
 * 1. List `<root>/.planning/phases/` entries.
 * 2. Keep only directories (skip files like README.md).
 * 3. Stat each — keep entries with `mtimeMs` within the last 24h.
 * 4. If `taskHint` carries a phase number (regex `\b\d+\b`), sort
 *    matching-prefix dirs first; tiebreak by mtime DESC. Otherwise pure
 *    mtime DESC.
 * 5. Return up to 5 entries as relative paths
 *    (`.planning/phases/<name>/`).
 *
 * **DI:** filesystem operations are injected via the `deps` parameter so
 * tests can mock `readdir`/`stat` without touching the real filesystem.
 */
export async function discoverArtifactPaths(
  deps: {
    readdir: typeof fsReaddir;
    stat: typeof fsStat;
  },
  root: string,
  taskHint?: string,
): Promise<readonly string[]> {
  const phasesDir = join(root, ".planning", "phases");
  // Step 1 — root dir must exist
  try {
    await deps.stat(phasesDir);
  } catch {
    return [];
  }
  // Step 2 — list entries; surface readdir failures as []
  let directoryNames: string[];
  try {
    const dirents = (await deps.readdir(phasesDir, {
      withFileTypes: true,
    })) as unknown as Array<{
      name: string;
      isDirectory: () => boolean;
    }>;
    directoryNames = dirents
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  // Step 3 — mtime filter (24h window)
  const now = Date.now();
  const windowMs = 24 * 60 * 60 * 1000;
  const candidates: { name: string; mtimeMs: number }[] = [];
  for (const name of directoryNames) {
    try {
      const st = await deps.stat(join(phasesDir, name));
      if (now - st.mtimeMs <= windowMs) {
        candidates.push({ name, mtimeMs: st.mtimeMs });
      }
    } catch {
      // per-entry stat failure — skip silently
    }
  }
  // Step 4 — phase-prefix priority (if taskHint carries a phase number)
  const phaseMatch = taskHint?.match(/\b(\d+)\b/);
  const phaseNum = phaseMatch?.[1];
  candidates.sort((a, b) => {
    if (phaseNum) {
      const aMatches =
        a.name.startsWith(`${phaseNum}-`) || a.name === phaseNum;
      const bMatches =
        b.name.startsWith(`${phaseNum}-`) || b.name === phaseNum;
      if (aMatches && !bMatches) return -1;
      if (!aMatches && bMatches) return 1;
    }
    return b.mtimeMs - a.mtimeMs; // most recent first
  });
  // Step 5 — cap at 5, format as relative paths
  return candidates
    .slice(0, 5)
    .map((c) => `.planning/phases/${c.name}/`);
}

/**
 * Phase 999.82-04 — the narrow surface of a v3 subagent's ClawCode channel
 * bridge that the spawner's dispatch path uses. Structurally a subset of
 * `AgentChannelBridge` (push / awaitReply / register+clear progress callback),
 * declared locally so the spawner stays decoupled from the manager's concrete
 * bridge class and so tests can supply a minimal stub. Mirrors how the v3 chat
 * branch in `bridge.ts` consumes the bridge (Plan 02).
 */
export interface SubagentChannelBridge {
  push(msg: DaemonChannelMessage): void;
  awaitReply(correlationId: string, timeoutMs?: number): Promise<AckInput>;
  registerProgressCallback?(cb: (text: string) => void): void;
  clearProgressCallback?(): void;
}

/**
 * Phase 999.82-04 — the listener half of the wired channel. The daemon-side
 * `DaemonSocketListener` exposes `isConnected()` — true once the subagent's
 * `claude --channels` process has connected its `clawcode-channel` MCP client
 * to the per-agent socket. Narrowed to the one method the dispatch wait needs.
 */
export interface SubagentChannelListener {
  isConnected(): boolean;
}

/**
 * Phase 999.82-04 — the shape `wireChannelForSubagent` resolves to. The daemon
 * injects `(cfg) => agentChannelRegistry.wireForConfig(cfg)`, which returns a
 * `WiredAgentChannel` (carrying `.bridge` + `.listener`) for a v3 config and
 * `null` for a v2 config (the registry's backend gate). All fields optional so
 * the Plan-03 spawner tests — which mock `wireChannelForSubagent` returning
 * `({})` — still typecheck; the v3-vs-v2 dispatch branch feature-detects
 * `.bridge` at runtime and the connect-wait feature-detects `.listener`.
 */
export type WiredSubagentChannelLike =
  | {
      readonly bridge?: SubagentChannelBridge;
      readonly listener?: SubagentChannelListener;
    }
  | null
  | undefined;

/**
 * Configuration for creating a SubagentThreadSpawner.
 */
export type SubagentThreadSpawnerConfig = {
  readonly sessionManager: SessionManager;
  /**
   * Phase 999.57 (2026-05-15) — REQUIRED. The spawner must register the
   * subagent's config into the heartbeat runner immediately after
   * `sessionManager.startAgent` so the existing heartbeat-disabled gate
   * at `runner.ts:271` fires for the subagent session. Without this, the
   * runner's local `agentConfigs` map (populated once at daemon boot from
   * `resolvedAgents`) returns `undefined` for subagent session names and
   * the gate short-circuits truthy — heartbeat checks fire on every
   * subagent session regardless of the config-side `heartbeat.enabled:
   * false` override. See RESEARCH.md Finding 1 + `runner.ts:143-147`
   * (additive `setAgentConfigs` upsert).
   */
  readonly heartbeatRunner: HeartbeatRunner;
  /**
   * Quick task 260520-qo5 (2026-05-20) — REQUIRED. Fixes a fleet-wide
   * subagent-spawn regression introduced by commit `0be63e0`
   * (`feat(138-04): daemon wires per-agent resolver into per-turn
   * dispatch`).
   *
   * 138-04 made `getLlmRuntime(agentName)` in `daemon.ts` **throw** for
   * any agent name absent from the boot-populated `llmRuntimeRegistry`
   * Map. Dynamically-spawned subagent sessions get a runtime-generated
   * name (`subagent-thread-spawner.ts` `name: sessionName`) and are
   * never in that registry. So `startAgent` → `SdkSessionAdapter` →
   * `getLlmRuntime(config.name)` threw on every subagent spawn, leaving
   * empty/duplicate Discord threads.
   *
   * The spawner must register an LlmRuntime resolver for the subagent
   * session name BEFORE `startAgent` triggers the `SdkSessionAdapter`
   * → `getLlmRuntime` lookup. Three-arg signature: `subagentConfig`
   * does NOT carry a parent-name field, so `parentAgentName` is passed
   * explicitly — the daemon callback uses it to look up parent
   * credentials.
   */
  readonly registerLlmRuntime: (
    sessionName: string,
    subagentConfig: ResolvedAgentConfig,
    parentAgentName: string,
    // Phase 999.83-02 (Fix A) — optional first-turn input (the subagent's
    // task). When supplied (v3 subagent WITH a non-empty task), the daemon
    // callback forwards it so the backend delivers the task as the agent's
    // first real PTY turn-trigger (the reliable turn-trigger) instead of
    // relying on the racy channel notification. Omitted for no-task spawns.
    //
    // Phase 999.86 — `deferFirstTurn` is the pool's path: skip BOTH
    // schedules; the pool writes `\r<msg>\n` later when a Discord chat
    // dispatches. Spawners (this file) do not set it; only
    // `WarmWorkerPool` does.
    opts?: { firstTurnInput?: string; deferFirstTurn?: boolean },
  ) => void;
  readonly registryPath: string;
  readonly discordClient: Client;
  readonly log?: Logger;
  /**
   * Phase 99 sub-scope M (2026-04-26) — when set, on subagent session end the
   * spawner fetches the subagent's last assistant message from the thread
   * and dispatches a synthetic turn to the parent agent: "your subagent in
   * <thread> finished, last reply was <text>, summarize for the user". Parent
   * processes the turn, posts a brief summary to its main channel via the
   * normal Discord webhook pipeline. Optional — when omitted, no auto-relay.
   */
  readonly turnDispatcher?: TurnDispatcher;
  /**
   * Inline-relay (2026-05-23) — when `true`, `relayCompletionToParent`
   * checks if the subagent's verbatim final reply fits within a single
   * Discord message (with footer + headroom) AND has no artifacts AND
   * isn't the attachment-only sentinel. When all three pass, the
   * verbatim reply is posted DIRECTLY to the parent's main channel and
   * the parent-summary dispatch turn is skipped — operator reads the
   * actual deliverable inline. When `false` (default), every relay
   * goes through the dispatch-summary path.
   *
   * Opt-IN at construction (production daemon passes `true`); tests
   * default to `false` so existing dispatch-path assertions keep
   * working without per-test updates. New inline-relay tests opt in
   * by passing `true`.
   */
  readonly inlineRelayEnabled?: boolean;
  /**
   * Phase 140 parity — resolver for a v3 parent's ClawCode channel bridge. When
   * the relay target (`binding.agentName`) runs the v3 (claude-code-interactive)
   * backend, its turns happen in its OWN process — `turnDispatcher.dispatchStream`
   * cannot reach it — so the completion summary is PUSHED over the channel. The
   * v3 parent receives it as a turn and reacts in its own channel (same UX as the
   * v2 summary turn). Returns `undefined` for v2/SDK parents → unchanged dispatch.
   */
  readonly getParentChannelBridge?: (
    agentName: string,
  ) => { push(msg: DaemonChannelMessage): void } | undefined;
  /**
   * Phase 999.82-03 — wire a DYNAMIC subagent's ClawCode channel at spawn.
   *
   * The daemon injects `(cfg) => agentChannelRegistry.wireForConfig(cfg)`. The
   * registry's backend gate is the filter: a v3 (`claude-code-interactive`)
   * subagentConfig gets a bridge + `daemon.sock` + `hook.sock`; a v2 config
   * returns `null` and no socket is created. The spawner calls this BEFORE
   * `sessionManager.startAgent` so the subagent's Stop/PostToolUse hooks have a
   * listening socket the moment its session boots (the hook frames route by
   * `CLAWCODE_AGENT_NAME = sessionName` — see the spawn site). Optional so the
   * 86 existing spawner tests, which construct the spawner without it, keep
   * passing (mirrors `getParentChannelBridge` optionality).
   */
  readonly wireChannelForSubagent?: (
    cfg: ResolvedAgentConfig,
  ) => WiredSubagentChannelLike;
  /**
   * Phase 999.82-03 — tear down a dynamic subagent's channel on session end.
   *
   * The daemon injects `(name) => agentChannelRegistry.unwireForAgent(name)`.
   * Unlike boot-wired bridges (daemon lifetime), a dynamic subagent bridge MUST
   * tear down on thread completion/archive or it leaks its `daemon.sock` +
   * `hook.sock` listeners per spawn (threat T-999.82-03-02). The spawner calls
   * this at every subagent-session stop site; the registry method is idempotent
   * so a double call (auto-archive stop + cleanup stop) is a no-op. Optional for
   * the same test-compat reason as `wireChannelForSubagent`.
   */
  readonly unwireChannelForSubagent?: (
    sessionName: string,
  ) => Promise<void> | void;
  /**
   * Phase 999.82-04 (live-canary fix) — connect-wait tuning for the v3 subagent
   * channel dispatch. A freshly-spawned subagent's `claude --channels` process
   * connects its channel LAZILY (~6s after spawn, when the warm-nudge fires its
   * first turn). Pushing the task before the channel connects hits a cold
   * `DaemonSocketListener` whose `send` drops silently (no peer) → the subagent
   * never receives the task → `awaitReply` times out at 600s. So the dispatch
   * POLLS `listener.isConnected()` every `connectPollMs` until true, up to
   * `connectCeilingMs`, BEFORE pushing. Test-only knobs (default to production
   * values) so the suite doesn't sit on real 250ms ticks.
   */
  readonly connectPollMs?: number;
  readonly connectCeilingMs?: number;
};

/**
 * Spawns subagent sessions in Discord threads with webhook identity.
 * Handles thread creation, session startup, binding persistence, and cleanup.
 */
export class SubagentThreadSpawner {
  private readonly sessionManager: SessionManager;
  // Phase 999.57 — heartbeat-disabled gate dependency. See type doc on
  // SubagentThreadSpawnerConfig.heartbeatRunner.
  private readonly heartbeatRunner: HeartbeatRunner;
  // Quick task 260520-qo5 — pre-startAgent LlmRuntime registration. See
  // type doc on SubagentThreadSpawnerConfig.registerLlmRuntime.
  private readonly registerLlmRuntime: (
    sessionName: string,
    subagentConfig: ResolvedAgentConfig,
    parentAgentName: string,
    opts?: { firstTurnInput?: string },
  ) => void;
  private readonly registryPath: string;
  private readonly discordClient: Client;
  private readonly log: Logger;
  private readonly turnDispatcher?: TurnDispatcher;
  private readonly inlineRelayEnabled: boolean;
  private readonly getParentChannelBridge?: (
    agentName: string,
  ) => { push(msg: DaemonChannelMessage): void } | undefined;
  // Phase 999.82-03 — dynamic subagent channel lifecycle (wire at spawn,
  // tear down on session end). See type docs on SubagentThreadSpawnerConfig.
  private readonly wireChannelForSubagent?: (
    cfg: ResolvedAgentConfig,
  ) => WiredSubagentChannelLike;
  private readonly unwireChannelForSubagent?: (
    sessionName: string,
  ) => Promise<void> | void;
  // Phase 999.82-04 (live-canary fix) — channel connect-wait tuning. Defaults
  // to production values (250ms poll, 60s ceiling); tests override to run fast.
  private readonly connectPollMs: number;
  private readonly connectCeilingMs: number;
  /**
   * Debug session `stale-turn-watchdog-miss` (999.64 RECURRENCE) — gap #3.
   *
   * Per-session typing-loop cleanup functions. `postInitialMessage` starts
   * a `setInterval` typing loop (`startTypingLoop`) and — on the normal
   * path — stops it in its `finally`. But when the SDK turn HANGS forever
   * (`next()` never resolves), that `finally` never runs and the typing
   * indicator spins for the daemon's whole life.
   *
   * The heartbeat runner's fleet-wide stale-turn sweep force-releases the
   * wedged turn lock; it then calls `stopTypingForSession` (wired by the
   * daemon via `heartbeatRunner.setStaleTurnReleaseCallback`) so the
   * indicator is cleared too. This Map is the seam: the spawner registers
   * each session's `stop` fn here on typing-loop start, deregisters it in
   * the same `finally` that stops the loop, and the sweep consults it.
   */
  private readonly typingCleanups: Map<string, () => void> = new Map();

  constructor(config: SubagentThreadSpawnerConfig) {
    this.sessionManager = config.sessionManager;
    this.heartbeatRunner = config.heartbeatRunner;
    this.registerLlmRuntime = config.registerLlmRuntime;
    this.registryPath = config.registryPath;
    this.discordClient = config.discordClient;
    this.log = config.log ?? logger;
    this.turnDispatcher = config.turnDispatcher;
    this.inlineRelayEnabled = config.inlineRelayEnabled ?? false;
    this.getParentChannelBridge = config.getParentChannelBridge;
    this.wireChannelForSubagent = config.wireChannelForSubagent;
    this.unwireChannelForSubagent = config.unwireChannelForSubagent;
    this.connectPollMs = config.connectPollMs ?? 250;
    this.connectCeilingMs = config.connectCeilingMs ?? 60_000;
  }

  /**
   * Phase 999.82-04 (live-canary fix) — wait until the subagent's ClawCode
   * channel listener reports a connected peer, polling every `connectPollMs`
   * up to `connectCeilingMs`. Resolves `true` once `isConnected()` flips,
   * `false` if the ceiling is hit first. A freshly-spawned v3 subagent connects
   * its channel lazily (~6s after spawn, when the warm-nudge fires its first
   * turn); pushing before that hits a cold `DaemonSocketListener.send` that
   * drops silently (no peer), so the dispatch MUST await connection first.
   * When the listener surface is absent (test stubs that omit it), assume
   * connected so the dispatch proceeds (the bridge stub controls timing).
   */
  private async waitForChannelConnection(
    listener: SubagentChannelListener | undefined,
    sessionName: string,
  ): Promise<boolean> {
    if (!listener || typeof listener.isConnected !== "function") return true;
    if (listener.isConnected()) return true;
    const deadline = Date.now() + this.connectCeilingMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, this.connectPollMs));
      if (listener.isConnected()) {
        this.log.info(
          { sessionName, waitedMs: this.connectCeilingMs - (deadline - Date.now()) },
          "subagent channel connected — dispatching task",
        );
        return true;
      }
    }
    return false;
  }

  /**
   * Phase 99 sub-scope M (2026-04-26) — auto-relay a subagent's completion
   * to its parent agent. Called from the session-end callback BEFORE the
   * thread cleanup runs (so the binding is still readable).
   *
   * Flow:
   *   1. Read binding for threadId (parent agent + parent channel).
   *   2. Fetch the last 1-3 messages from the Discord thread.
   *   3. Filter to messages from the subagent identity (webhook posts).
   *   4. Build a relay prompt: "Your subagent in <thread> just finished.
   *      Last reply: <text>. Briefly summarize for the user in main channel."
   *   5. Dispatch a turn to the parent agent via TurnDispatcher with origin
   *      kind="task" sourceId="subagent-completion:<threadId>".
   *   6. The parent's turn runs through the normal Discord pipeline → reply
   *      posts to the parent's bound channel via webhook.
   *
   * Failures are logged + swallowed (the cleanup must still run regardless).
   * No-op when turnDispatcher is not wired or when the thread has no
   * subagent messages worth relaying.
   */
  /**
   * M2 — public entry. ALL three relay-trigger paths (the
   * `subagent_complete` IPC via `relayAndMarkCompletedByThreadId`, the
   * daemon session-end backstop, and the spawner's own auto-relay) call THIS
   * method to post the completion summary. Serialize them on the shared
   * per-thread relay lock so the dedupe-check + post is atomic per thread —
   * two concurrent paths can no longer both POST to the parent channel.
   */
  async relayCompletionToParent(threadId: string): Promise<string | null> {
    return withRelayLock(threadId, () =>
      this.relayCompletionToParentInner(threadId),
    );
  }

  private async relayCompletionToParentInner(
    threadId: string,
  ): Promise<string | null> {
    // Phase 999.19 T-03 — returns the delegate's trimmed final text on a
    // successful relay (so the caller can consolidate it into the
    // delegate's memory without a second thread fetch), or `null` on any
    // skip / early-return / failure path.
    if (!this.turnDispatcher) {
      this.log.info({ threadId, reason: "no-turn-dispatcher" }, "subagent relay skipped");
      return null;
    }
    try {
      const registry = await readThreadRegistry(this.registryPath);
      const binding = getBindingForThread(registry, threadId);
      if (!binding) {
        this.log.info({ threadId, reason: "no-binding" }, "subagent relay skipped");
        return null;
      }
      // M2 — exactly-once guard. Held inside the per-thread relay lock (see
      // the public wrapper), so a concurrent path that already relayed +
      // stamped `completedAt` makes this caller skip the POST. This closes
      // the double-post window for the DIRECT callers (session-end backstop,
      // auto-relay) that bypass relayAndMarkCompletedByThreadId's own gate.
      if (binding.completedAt !== undefined && binding.completedAt !== null) {
        this.log.info(
          { threadId, reason: "already-completed" },
          "subagent relay skipped",
        );
        return null;
      }
      const channel = await this.discordClient.channels.fetch(threadId);
      if (!channel || !("messages" in channel)) {
        this.log.info({ threadId, reason: "no-channel-or-not-text" }, "subagent relay skipped");
        return null;
      }
      // Fetch last 10 messages (enough to find the subagent's most recent
      // assistant reply, skipping the operator's follow-ups). Discord's
      // `fetch` returns newest-first.
      const fetched = await (channel as TextChannel).messages.fetch({
        limit: 10,
      });
      // Phase 100-fu (2026-04-28) — multi-chunk concatenation.
      //
      // Pre-fu code picked only the SINGLE most-recent bot message. When a
      // subagent's reply exceeded 2000 chars, postInitialMessage chunked
      // it across N thread.send() calls — but the relay then summarized
      // the parent on JUST the LAST chunk, losing chunks 1..N-1. Real
      // failure 2026-04-28: Opus tax-return analysis silently truncated
      // to one Discord message, parent built its main-channel summary on
      // truncated content.
      //
      // Fix: walk newest→oldest, gather a continuous run of bot messages,
      // stop at the first operator (non-bot) message OR the start of
      // history. Concatenate oldest-first so the parent sees the
      // chronological order. Skip empty/whitespace-only messages
      // (embed-only posts, Discord placeholders).
      //
      // Subagent posts via webhook OR direct bot send. We treat ALL bot
      // messages as eligible — the binding's parentChannelId already
      // scopes to this thread, so cross-bot interleaving is not a concern
      // for subagent-spawned threads.
      const messages = Array.from(fetched.values()); // newest first per discord.js
      const subagentChunks: string[] = [];
      // Phase 999.60 (2026-05-15) — also collect attachments from subagent
      // bot messages. clawcode_share_file uploads as a Discord ATTACHMENT,
      // which the pre-999.60 relay walked past silently (text-only). Result:
      // admin-clawdy received "subagent done, see thread" with no content,
      // and the operator had to manually ask for the file's contents.
      //
      // Auto-dump: collect attachment metadata here (URL, name, size, content-type),
      // then below — BEFORE the admin-clawdy relay turn fires — fetch each
      // text-like attachment's content from Discord's CDN and post it into
      // the parent's main channel (chunked through the 2000-char cap).
      // Binary or oversized attachments get a one-line announcement with URL.
      const subagentAttachments: Array<{
        url: string;
        name: string;
        size: number;
        contentType: string | null;
      }> = [];
      for (const m of messages) {
        if (!m.author.bot) break; // hit operator follow-up — stop walking
        if (m.attachments && typeof m.attachments.values === "function") {
          for (const a of m.attachments.values() as Iterable<{
            url: string;
            name?: string;
            size?: number;
            contentType?: string | null;
          }>) {
            subagentAttachments.push({
              url: a.url,
              name: a.name ?? "(unnamed)",
              size: a.size ?? 0,
              contentType: a.contentType ?? null,
            });
          }
        }
        if (!m.content || m.content.trim().length === 0) continue; // skip empty/embed-only
        // Debug session `autorelay-placeholder-misfire` (2026-05-22) —
        // DEFENSE-IN-DEPTH. Never relay the streaming placeholder. The
        // spawner's backstop write + autoRelay content gate should prevent
        // an unedited "🔄 Working..." placeholder from being the only bot
        // message here, but if it ever is (e.g. relay called from another
        // path, or a backstop edit that failed), `continue` skips it. The
        // walk proceeds to the next (real) message; if no real message
        // exists, `subagentChunks` ends empty and the
        // `no-bot-messages-or-attachments` early-return below fires.
        if (m.content.trim() === SUBAGENT_WORKING_PLACEHOLDER) {
          this.log.info(
            { threadId, reason: "skipped-working-placeholder" },
            "subagent relay: skipped the 'Working...' placeholder during history walk",
          );
          continue;
        }
        subagentChunks.push(m.content);
      }
      // Reverse to oldest-first so the relay reads in chronological order.
      subagentAttachments.reverse();
      if (subagentChunks.length === 0 && subagentAttachments.length === 0) {
        this.log.info({ threadId, reason: "no-bot-messages-or-attachments" }, "subagent relay skipped");
        return null;
      }
      if (subagentChunks.length === 0) {
        // Attachment-only relay — still proceed so the file content reaches the parent.
        this.log.info({ threadId, attachmentCount: subagentAttachments.length }, "subagent relay: attachments-only path");
        subagentChunks.push("(no text reply — see attached file(s) below)");
      }
      // Reverse to oldest-first so the relay reads in chronological order.
      const fullSubagentReply = subagentChunks.reverse().join("\n").trim();
      if (!fullSubagentReply) {
        this.log.info({ threadId, reason: "empty-content-after-concat" }, "subagent relay skipped");
        return null;
      }
      // Truncate huge replies — the parent's prompt has a budget.
      const trimmed =
        fullSubagentReply.length > 1500
          ? `${fullSubagentReply.slice(0, 1500)}…`
          : fullSubagentReply;
      const threadName = (channel as TextChannel).name ?? threadId;
      // Phase 100 GSD-06 — discover artifact paths from the parent's GSD
      // project root. No-op when the parent has no `gsd.projectDir` set
      // (the case for 14+ existing agents — Phase 99-M base behavior is
      // preserved). Failures inside discoverArtifactPaths return [] so
      // the relay continues with the unchanged Phase 99-M prompt.
      const parentConfig = this.sessionManager.getAgentConfig(
        binding.agentName,
      );
      const artifactRoot = resolveArtifactRoot(parentConfig);
      const artifacts = artifactRoot
        ? await discoverArtifactPaths(
            { readdir: fsReaddir, stat: fsStat },
            artifactRoot,
            // Use the thread name as taskHint — names like 'gsd:plan:100'
            // carry the phase number, which discoverArtifactPaths uses for
            // prefix priority.
            threadName,
          )
        : [];
      const artifactsLine =
        artifacts.length > 0
          ? `\n\n**Artifacts written:** ${artifacts.join(", ")}`
          : "";
      const includeArtifactsHint = artifacts.length > 0;
      const relayPrompt =
        `[SUBAGENT_COMPLETION] Your subagent in thread "${threadName}" just finished its work.\n\n` +
        `**Their final response (last assistant message):**\n${trimmed}` +
        artifactsLine +
        `\n\n` +
        `Briefly summarize the outcome for the user in this main channel (1-3 sentences max). ` +
        `Acknowledge completion and link to the thread if helpful (thread ID: ${threadId}). ` +
        (includeArtifactsHint
          ? `If artifacts are listed, include them verbatim in your summary so the operator can find them. `
          : ``) +
        `If the subagent's reply is too short or unclear to summarize, just acknowledge completion + link. ` +
        `Do NOT call read_thread again — you already have the relevant content above. End your turn after posting the summary.`;
      const origin = makeRootOrigin("task", `subagent-completion:${threadId}`);

      // Quick task 260501-nfe (2026-05-01) — fetch the parent's main channel
      // so the relay summary actually posts. Defensive: a missing or
      // non-text channel is a hard skip (we have no surface to post to).
      // Pre-fix this code called turnDispatcher.dispatch and discarded the
      // returned response — the dominant cause of "summary never posts" in
      // production (Phase 99-M wiring was never finished).
      const parentChannel = await this.discordClient.channels
        .fetch(binding.parentChannelId)
        .catch(() => null);
      const parentSendable = parentChannel as
        | {
            send: (
              content: string,
            ) => Promise<{ edit: (c: string) => Promise<unknown> }>;
          }
        | null;
      if (!parentSendable || typeof parentSendable.send !== "function") {
        this.log.info(
          {
            threadId,
            reason: "parent-channel-fetch-failed",
            parentChannelId: binding.parentChannelId,
          },
          "subagent relay skipped",
        );
        return null;
      }

      // Phase 999.60 (2026-05-15) — auto-dump subagent attachments into the
      // parent's main channel BEFORE the admin-clawdy relay turn fires.
      // For text-like attachments under 100KB, fetch content from Discord
      // CDN and post chunked (2000-char cap). For binary/oversized, post a
      // one-line announcement with the URL. Failures here are non-fatal —
      // the admin-clawdy relay summary still fires afterward.
      //
      // Why BEFORE the relay summary: the operator gets the actual content
      // first, then admin-clawdy's contextual summary. Reverse order would
      // mean the summary lands on a still-empty channel and the content
      // arrives later as an apparent afterthought.
      //
      // Text-file detection: extension-based first (.md/.txt/.json/.csv/.yaml/
      // .yml/.log/.sql) with contentType as a tiebreaker. Discord CDN URLs
      // are public for the lifetime of the message; we don't need auth.
      if (subagentAttachments.length > 0) {
        const TEXT_EXT_RE = /\.(md|txt|json|csv|yaml|yml|log|sql|tsv|ini|conf|toml)$/i;
        const MAX_INLINE_BYTES = 100_000;
        for (const a of subagentAttachments) {
          const isText =
            TEXT_EXT_RE.test(a.name) ||
            (a.contentType !== null && a.contentType.startsWith("text/"));
          const tooBig = a.size > MAX_INLINE_BYTES;
          if (!isText || tooBig) {
            try {
              await parentSendable.send(
                `📎 **${a.name}** (${a.size.toLocaleString()} bytes) — subagent deliverable: ${a.url}`,
              );
            } catch (err) {
              this.log.warn(
                { threadId, attachmentName: a.name, error: (err as Error).message },
                "auto-dump attachment announce failed (non-fatal)",
              );
            }
            continue;
          }
          let content = "";
          try {
            const res = await fetch(a.url);
            if (!res.ok) {
              throw new Error(`HTTP ${res.status}`);
            }
            content = await res.text();
          } catch (err) {
            this.log.warn(
              { threadId, attachmentName: a.name, error: (err as Error).message },
              "auto-dump attachment fetch failed (non-fatal — falling back to URL announce)",
            );
            try {
              await parentSendable.send(
                `📎 **${a.name}** (fetch failed; download: ${a.url})`,
              );
            } catch { /* swallowed — parent unreachable, nothing to do */ }
            continue;
          }
          const header = `📎 **${a.name}** — subagent deliverable (auto-dumped):\n\n`;
          const fullText = header + content;
          let cursor = 0;
          let chunksSent = 0;
          while (cursor < fullText.length) {
            const chunk = fullText.slice(cursor, cursor + 2000);
            try {
              await parentSendable.send(chunk);
              chunksSent++;
            } catch (err) {
              this.log.warn(
                {
                  threadId,
                  attachmentName: a.name,
                  chunkIndex: chunksSent,
                  cursor,
                  totalLength: fullText.length,
                  error: (err as Error).message,
                },
                "auto-dump attachment chunk send failed (non-fatal — stopping this attachment)",
              );
              break;
            }
            cursor += 2000;
          }
          this.log.info(
            {
              threadId,
              attachmentName: a.name,
              attachmentSize: a.size,
              chunksSent,
              fullySent: cursor >= fullText.length,
            },
            "subagent attachment auto-dumped to parent channel",
          );
        }
      }

      // Inline-relay branch (2026-05-23) — when the subagent's verbatim
      // final reply fits in a single Discord message (with footer +
      // headroom), post it directly to the parent's main channel
      // instead of dispatching a parent-summary turn. The operator
      // reads the actual deliverable inline; the thread stays as the
      // full record.
      //
      // Motivation (operator screenshot 2026-05-23): for short
      // deliverables (a one-paragraph email draft, a 1-2 sentence
      // answer), the prior summary-turn behaviour put a 1-3 sentence
      // parent-generated synopsis in the main channel and stranded the
      // actual content inside the thread. The operator had to open the
      // thread to read what the subagent actually produced. Inline-
      // relay surfaces the verbatim deliverable when it fits.
      //
      // Inline-relay is SKIPPED when:
      //   - Reply is the attachment-only sentinel ("(no text reply —
      //     see attached file(s) below)") — attachments already auto-
      //     dumped above; let the summary turn give the operator
      //     context for the file-only outcome.
      //   - Artifacts exist (`artifacts.length > 0`) — the Phase 100
      //     GSD-06 artifact-paths line belongs in the parent's summary
      //     turn (operator-visible "files were written: foo, bar").
      //     Skipping inline-relay preserves that context.
      //   - Formatted reply + footer + headroom exceeds Discord's
      //     2000-char cap.
      //
      // When inline-relay fires: skip the dispatchStream call entirely
      // and `return fullSubagentReply` early. Caller (the spawner's
      // post-reply chain at line ~1590) treats this identically to a
      // dispatch-path success — `relayedText` is captured and the
      // consolidation step (delegated work) still runs.
      //
      // Trade-off: parent's session does NOT receive a completion turn,
      // so the parent's context lacks "you just had a subagent
      // finish." If the operator follow-ups with "did the subagent
      // finish?", the parent re-reads the channel (where the inline
      // post is visible) or the thread. Acceptable for v1 — the
      // alternative (a redundant summary alongside the actual content)
      // felt noisy per the screenshot observation.
      //
      // Footer uses Discord's `<#threadId>` mention syntax so the
      // operator can click through to the thread for context. Plain
      // hyphen "via" wording (no em-dash) so the strip rules don't
      // trip on our own footer.
      const INLINE_FOOTER = `\n\n*via subagent <#${threadId}>*`;
      const INLINE_FULL_BUDGET = 2000;
      const INLINE_HEADROOM = 50;
      const formattedReply = formatOutboundText(fullSubagentReply);
      const isAttachmentOnlySentinel =
        subagentChunks.length === 1 &&
        fullSubagentReply ===
          "(no text reply — see attached file(s) below)";
      // Phase 140 parity — v3 parent: PUSH the completion summary over the
      // ClawCode channel. A v3 parent's turns run in its own `claude --channels`
      // process, so `turnDispatcher.dispatchStream` (the v2 path below) can't
      // reach it. The parent receives `relayPrompt` as a channel turn and reacts
      // in its own channel — the v3 analog of the summary turn. Skips both the
      // inline-relay and the dispatch paths. (NOTE: lands only if the parent's
      // channel is connected — see the lazy-connect / warm-nudge handling.)
      const parentBridge = this.getParentChannelBridge?.(binding.agentName);
      if (parentBridge) {
        parentBridge.push({
          type: "a2a",
          message_id: `subrelay-${nanoid(8)}`,
          content: relayPrompt,
          meta: { source_agent: binding.sessionName, subagent_thread: threadId },
        });
        this.log.info(
          { threadId, parentAgent: binding.agentName, path: "v3-channel-push" },
          "subagent relay pushed to v3 parent via ClawCode channel",
        );
        return fullSubagentReply;
      }

      const fitsInlineBudget =
        formattedReply.length + INLINE_FOOTER.length + INLINE_HEADROOM <=
        INLINE_FULL_BUDGET;
      if (
        this.inlineRelayEnabled &&
        !isAttachmentOnlySentinel &&
        artifacts.length === 0 &&
        fitsInlineBudget
      ) {
        try {
          await parentSendable.send(formattedReply + INLINE_FOOTER);
          this.log.info(
            {
              threadId,
              parentAgent: binding.agentName,
              path: "inline-relay",
              replyLength: formattedReply.length,
              footerLength: INLINE_FOOTER.length,
            },
            "subagent relay posted verbatim inline (parent summary turn skipped)",
          );
          return fullSubagentReply;
        } catch (err) {
          this.log.warn(
            {
              threadId,
              parentAgent: binding.agentName,
              path: "inline-relay-fallback",
              error: (err as Error).message,
            },
            "inline-relay post failed — falling back to summary-dispatch path",
          );
          // fall through to existing summary-dispatch path
        }
      }

      // Quick task 260501-nfe — mirror bridge.ts:585-665 user-message path.
      // Stream tokens into a ProgressiveMessageEditor that posts to the
      // parent's main channel via channel.send (first chunk) / .edit
      // (subsequent). Without this, the response string was awaited and
      // discarded — the dominant cause of "summary never posts" in
      // production (diagnosed 2026-05-01).
      let messageRef:
        | { edit: (content: string) => Promise<unknown> }
        | null = null;
      const editor = new ProgressiveMessageEditor({
        editFn: async (content: string) => {
          const wrapped = formatOutboundText(content);
          const truncated =
            wrapped.length > 2000 ? wrapped.slice(0, 1997) + "..." : wrapped;
          if (!messageRef) {
            messageRef = await parentSendable.send(truncated);
          } else {
            await messageRef.edit(truncated);
          }
        },
        editIntervalMs: 750,
        log: this.log,
        agent: binding.agentName,
      });

      const response = await this.turnDispatcher.dispatchStream(
        origin,
        binding.agentName,
        relayPrompt,
        (accumulated: string) => editor.update(accumulated),
        { channelId: binding.parentChannelId },
      );
      await editor.flush();

      // Phase 999.36 sub-bug D — NOT stamping lastDeliveryAt here. This flush
      // is the PARENT's main-channel summary post — the subagent's own binding
      // delivery was already stamped in postInitialMessage's finally-adjacent
      // block. Stamping here would double-stamp.

      // Defense-in-depth: if dispatch returned empty AND no chunk fired,
      // we have no post. Distinct from the 5 pre-dispatch silent-return
      // reasons because this one is post-dispatch.
      if (!messageRef && (!response || response.trim().length === 0)) {
        this.log.info(
          {
            threadId,
            reason: "empty-response-from-parent",
            parentAgent: binding.agentName,
          },
          "subagent relay skipped",
        );
        // The relay produced no parent-channel post, but the subagent's
        // own deliverable (`trimmed`) IS valid — return it so a delegated
        // spawn still consolidates the work into the delegate's memory.
        return trimmed;
      }

      // Overflow handling — when the final response exceeds 2000 chars, the
      // editor truncated the visible message. Send the tail as additional
      // channel.send() chunks so nothing is lost. Mirrors postInitialMessage
      // overflow logic (this file, lines 633-670).
      const finalWrapped = formatOutboundText(response ?? "");
      if (finalWrapped.length > 2000) {
        let cursor = EDITOR_TRUNCATE_INDEX;
        let chunksSent = 0;
        let lastError: string | null = null;
        while (cursor < finalWrapped.length) {
          const chunk = finalWrapped.slice(cursor, cursor + 2000);
          try {
            await parentSendable.send(chunk);
            chunksSent++;
          } catch (err) {
            lastError = (err as Error).message;
            this.log.warn(
              {
                threadId,
                parentAgent: binding.agentName,
                chunkIndex: chunksSent,
                cursor,
                totalLength: finalWrapped.length,
                error: lastError,
              },
              "subagent relay overflow chunk send failed (non-fatal — continuing if possible)",
            );
            break;
          }
          cursor += 2000;
        }
        // Phase 121-02 sub-bug B (D-07) — chunk-boundary diag, post-fix.
        // editorCutoffIndex == overflowStartCursor == EDITOR_TRUNCATE_INDEX
        // means the editor's '...' marker and the overflow loop's first
        // chunk are aligned on the same byte; seamGapBytes is 0.
        this.log.info(
          {
            threadId,
            parentAgent: binding.agentName,
            relayLen: trimmed.length,
            totalLength: finalWrapped.length,
            editorCutoffIndex: EDITOR_TRUNCATE_INDEX,
            overflowStartCursor: EDITOR_TRUNCATE_INDEX,
            seamGapBytes: 0,
            chunksSent,
            lastError,
            fullySent: cursor >= finalWrapped.length,
            endReason: lastError ? "send-failed" : "drained",
          },
          "subagent relay overflow chunks summary",
        );
      }

      this.log.info(
        {
          threadId,
          parentAgent: binding.agentName,
          subagentSession: binding.sessionName,
          relayLen: trimmed.length,
          artifactCount: artifacts.length,
          postedLength: (response ?? "").length,
        },
        "subagent completion relayed to parent",
      );
      // M2 — claim completion atomically inside the per-thread relay lock.
      // This is what makes the relay exactly-once across ALL trigger paths:
      // the IPC wrapper (relayAndMarkCompletedByThreadId) also stamps
      // completedAt, but the direct callers (session-end backstop,
      // auto-relay) did NOT — so a direct post left completedAt unset and a
      // concurrent path could post again. Stamping here (idempotent: the
      // mutator re-checks and leaves an already-set value) closes that
      // window for every path. mutateThreadRegistry uses a DIFFERENT lock
      // (withRegistryLock), so this nested stamp does not deadlock the relay
      // lock. Best-effort — a stamp failure must not fail an already-posted
      // relay.
      try {
        await mutateThreadRegistry(this.registryPath, (reg) => {
          const idx = reg.bindings.findIndex((b) => b.threadId === threadId);
          if (idx === -1) return reg;
          const live = reg.bindings[idx]!;
          if (live.completedAt !== undefined && live.completedAt !== null) {
            return reg; // another path stamped first — leave it
          }
          const updated: ThreadBinding = { ...live, completedAt: Date.now() };
          return {
            bindings: reg.bindings.map((b, i) => (i === idx ? updated : b)),
            updatedAt: Date.now(),
          };
        });
      } catch (stampErr) {
        this.log.warn(
          { threadId, error: (stampErr as Error).message },
          "subagent relay completedAt stamp failed (non-fatal — relay already posted)",
        );
      }
      // Phase 999.19 T-03 — return the delegate's trimmed final text so a
      // delegated spawn's caller can consolidate it without a second
      // thread fetch.
      return trimmed;
    } catch (err) {
      this.log.warn(
        { threadId, error: (err as Error).message },
        "subagent completion relay failed (non-fatal — cleanup continues)",
      );
      return null;
    }
  }

  /**
   * Spawn a subagent in a new Discord thread.
   *
   * 1. Validates parent agent config and channel
   * 2. Checks maxThreadSessions limit
   * 3. Creates Discord thread
   * 4. Starts subagent session with inherited config
   * 5. Persists thread binding
   *
   * @throws ManagerError if parent agent not found, no channels, or limit exceeded
   */
  async spawnInThread(config: SubagentThreadConfig): Promise<SubagentSpawnResult> {
    // 1. Get parent config
    const parentConfig = this.sessionManager.getAgentConfig(config.parentAgentName);
    if (!parentConfig) {
      throw new ManagerError(
        `Parent agent '${config.parentAgentName}' not found`,
      );
    }

    // Phase 999.3 — D-INH-01..03: when delegateTo is set, compose subagent
    // config from the delegate's identity (model/soul/skills/mcpServers/
    // subagentModel) but keep caller-owned, channel-scoped fields (channels,
    // threads quota, webhookUrl). D-EDG-04: empty string ≡ undefined.
    // D-EDG-05: defense-in-depth at spawner level (IPC handler is primary).
    const normalizedDelegateTo =
      config.delegateTo && config.delegateTo.length > 0
        ? config.delegateTo
        : undefined;
    const delegateConfig = normalizedDelegateTo
      ? this.sessionManager.getAgentConfig(normalizedDelegateTo)
      : undefined;
    if (normalizedDelegateTo && !delegateConfig) {
      throw new ManagerError(
        `Delegate agent '${normalizedDelegateTo}' not found in config`,
      );
    }
    // sourceConfig provides inherited fields (model/soul/skills/mcpServers/...).
    // parentConfig provides channel-scoped/quota fields (channels, threads, webhookUrl).
    const sourceConfig = delegateConfig ?? parentConfig;

    // 2. Resolve the channel. The subagent thread is ALWAYS created in the
    //   PARENT (spawning) agent's channel — for both delegated and
    //   non-delegated spawns. `relayChannelId` is the parent's channel and is
    //   also the completion-relay target (`binding.parentChannelId` →
    //   `relayCompletionToParent`) and the "Parent channel" line in the
    //   subagent's thread context. Must always exist — a misconfigured parent
    //   fails loud.
    //   Reverted 2026-05-21 per operator request — Phase 999.19 T-03
    //   delegate-channel routing removed; threads always spawn in the
    //   parent's channel (not the delegate's).
    const relayChannelId = parentConfig.channels[0];
    if (!relayChannelId) {
      throw new ManagerError(
        `Parent agent '${config.parentAgentName}' has no bound channels`,
      );
    }
    const channelId = relayChannelId;

    // 3. Check maxThreadSessions limit (caller's quota — D-INH-02)
    const maxSessions =
      parentConfig.threads?.maxThreadSessions ??
      DEFAULT_THREAD_CONFIG.maxThreadSessions;

    const registry = await readThreadRegistry(this.registryPath);
    // Phase 140 (2026-05-26) cap-leak fix — count only ACTIVE sessions against
    // the cap. `getBindingsForAgent` returns every binding ever created for the
    // agent (it's also used by the relay path, which needs completed ones), so
    // completed subagents (`completedAt` set) were counting against the cap
    // forever — three completed/wedged spawns permanently locked the agent out
    // of new threads. Exclude `completedAt`-stamped bindings here so only
    // genuinely in-flight sessions consume a slot. (NOTE: a WEDGED turn leaves
    // its binding un-stamped, so it still leaks a slot — but the v3-subagent
    // rework eliminates the wedge at the source; stamping wedged bindings
    // completed is folded into that phase.)
    const agentBindings = getBindingsForAgent(
      registry,
      config.parentAgentName,
    ).filter((b) => b.completedAt === undefined);

    if (agentBindings.length >= maxSessions) {
      throw new ManagerError(
        `Max thread sessions (${maxSessions}) reached for agent '${config.parentAgentName}'`,
      );
    }

    // 4. Fetch Discord channel and create thread
    const channel = await this.discordClient.channels.fetch(channelId) as TextChannel;
    const thread = await channel.threads.create({
      name: config.threadName,
      autoArchiveDuration: 1440,
    });

    // 5. Build session name (D-NAM-01: -via- infix when delegating; D-NAM-02 otherwise)
    const shortId = nanoid(6);
    const sessionName = normalizedDelegateTo
      ? `${config.parentAgentName}-via-${normalizedDelegateTo}-${shortId}`
      : `${config.parentAgentName}-sub-${shortId}`;

    // Debug session `autorelay-fires-after-turn-1` (2026-05-22, option C)
    // — resolve the relay mode BEFORE building the thread context so the
    // `subagent_complete` instruction below can be relay-mode-aware. The
    // same `isDelegated` / `autoArchive` / `autoRelay` values are reused
    // verbatim at the spawn-dispatch site further down (step 12) — this is
    // a HOIST of that computation, not a duplicate: the originals are
    // removed there and the hoisted consts flow into `postInitialMessage`.
    //
    // `relaysOnCompletionSignal` is the discriminator the context build
    // needs: when TRUE the subagent's completion is relayed ONLY when it
    // calls `subagent_complete` (multi-turn budget); when FALSE the relay
    // fires automatically after turn-1 (one-shot — the first reply IS the
    // deliverable, and calling `subagent_complete` is unnecessary).
    const isDelegated = Boolean(
      config.delegateTo && config.delegateTo.length > 0,
    );
    // Phase 999.19 D2 — delegated spawns are fire-and-forget; default
    // autoArchive true so `*-via-*` sessions don't leak into
    // /clawcode-fleet. Explicit `autoArchive: false` still opts out.
    // Non-delegated `-sub-` spawns keep autoArchive defaulting false
    // (they are often interactive — operator follows up in the thread).
    const autoArchive =
      config.autoArchive !== undefined ? config.autoArchive : isDelegated;
    // Phase 999.57 — delegated spawns default autoRelay FALSE (must signal
    // completion via `subagent_complete`). Debug session
    // `autorelay-fires-after-turn-1` (option C) — non-delegated spawns
    // keep the autoRelay TRUE default (one-shot Q&A relays after turn-1),
    // but a non-delegated MULTI-TURN caller now opts into deferred relay by
    // passing `autoRelay: false` explicitly (the `/gsd:*` slash path and
    // any MCP caller with a multi-turn task — see the `spawn_subagent_thread`
    // tool description). `autoArchive` still implies `autoRelay`.
    const autoRelay =
      autoArchive ||
      (isDelegated
        ? config.autoRelay === true
        : config.autoRelay !== false);
    // The subagent should be instructed to call `subagent_complete` exactly
    // when its completion is NOT auto-relayed after turn-1 — i.e. whenever
    // `autoRelay` is FALSE. That covers delegated spawns (999.57) AND
    // non-delegated multi-turn spawns that opted out of the turn-1 relay.
    const relaysOnCompletionSignal = !autoRelay;

    // 6. Build thread context for soul.
    // D-TCX-01: when delegating, append a 4-line "Delegation Context" block
    // including the canonical phrase "acting on behalf of" so the subagent
    // understands it speaks with delegate's identity in caller's channel.
    const baseContext = [
      "\n\n## Subagent Thread Context",
      `You are a subagent operating in a Discord thread.`,
      `Thread: "${config.threadName}" (ID: ${thread.id})`,
      // The parent's channel — also the thread's own channel and the
      // completion-relay target. (Phase 999.19 T-03 delegate-channel routing
      // reverted 2026-05-21; the thread always lives in the parent's channel.)
      `Parent channel: ${relayChannelId}`,
      `Parent agent: ${config.parentAgentName}`,
      `Your session name: ${sessionName}`,
      "Respond to messages in this thread only.",
      // Phase 999.36 sub-bug C (D-09) — explicit instruction so file
      // uploads route to THIS thread, not to a sibling agent's channel
      // via shared-workspace identity drift. Pair with daemon-side
      // resolveShareFileChannel fix at daemon.ts case "share-file".
      `When calling clawcode_share_file, pass agent="${sessionName}" (your session name above) — NOT "${config.parentAgentName}". This routes the upload to THIS thread.`,
      // Phase 999.57 (2026-05-15) — explicit completion contract. Pre-999.57,
      // the auto-relay fired on first-message-stream-end which produced
      // wrong-summary failures for any subagent that needed multiple turns
      // (production: 2026-05-15 admin-clawdy→research, two consecutive
      // failures at 18:04 + 18:09 archived in 5-10s with ack/leaked
      // content as "final response"). Post-999.57, delegated subagents
      // get the full multi-turn budget and MUST signal completion explicitly.
      //
      // Debug session `autorelay-fires-after-turn-1` (2026-05-22, option C)
      // — this instruction is now RELAY-MODE-AWARE, not delegation-gated.
      // Pre-fix it said "When your DELEGATED work is complete..." — the word
      // "delegated" made a non-delegated MULTI-TURN subagent (spawned with
      // `autoRelay: false`) read the instruction as not-applicable and never
      // call `subagent_complete`. Now: when the relay is deferred to the
      // completion signal (`relaysOnCompletionSignal` — true for delegated
      // spawns AND non-delegated multi-turn spawns), the subagent is told to
      // call the tool; when the relay is automatic after turn-1 (one-shot
      // non-delegated), the subagent is told it need NOT call it.
      relaysOnCompletionSignal
        ? `**Completion signal — PREFERRED.** Your work may span multiple turns. CRITICAL — how your deliverable reaches \`${config.parentAgentName}\`: the relay scrapes the messages you POSTED in this thread; the \`subagent_complete\` tool carries NO content (only agentName), so it transmits nothing on its own. A turn that ends on a bare \`subagent_complete\` call delivers NOTHING. Therefore you MUST, as the LAST thing you do: (1) POST your COMPLETE deliverable as a plain-text message in this thread FIRST — the full answer if short, or a short summary plus the shared-file reference if long (see the file contract below) — and THEN (2) call the \`subagent_complete\` MCP tool exactly ONCE with agentName="${sessionName}". Post first, signal second; never reverse that order and never end your turn on the bare tool call. Do not call \`subagent_complete\` on intermediate updates, acknowledgments, or tool-use preludes — only after your final deliverable is already posted and the work is genuinely done. If you forget to signal, the daemon's gated quiescence sweep relays whatever you posted after the thread has been idle for the configured \`quiescenceMinutes\` (default 5) — but it can only relay what is in the thread, so posting the full deliverable as plain text is mandatory either way; explicit signalling is still preferred because it's faster and avoids the idle wait.`
        : `**Completion — automatic.** Your reply in this thread is relayed to \`${config.parentAgentName}\`'s main channel automatically once your first response completes — you do NOT need to call \`subagent_complete\`. CRITICAL: the relay scrapes the messages you POSTED in this thread, so your COMPLETE deliverable MUST be your FINAL plain-text message — the full answer if short, or a short summary plus the shared-file reference if long (see the file contract below). A turn that ends on a bare tool call delivers NOTHING. Write your full answer as the last thing you post; do not end on an acknowledgment or a tool-use prelude.`,
      // Phase 999.58 (2026-05-15) — long-deliverable contract. Production
      // failure: research subagent produced a multi-section capability-gap
      // table that hit Discord's 2000-char cap mid-row at "BOOTSTRAP.md".
      // The relay then summarized truncated content. Root cause: subagents
      // had no instruction to use clawcode_share_file for long output, so
      // they default to posting everything as Discord messages. Fix:
      // explicit contract — anything structured or > ~1500 chars must go
      // to a workspace file + share. The relay's artifactsLine (relayCompletionToParent:300-303)
      // already surfaces shared files in the parent's summary.
      `If your deliverable is structured (tables, lists, code, multi-section docs) OR longer than ~1500 characters, write it to a markdown file in your workspace FIRST, then call \`clawcode_share_file\` with agent="${sessionName}" to surface it in this thread. Do NOT rely on posting long content as plain Discord messages — Discord caps individual messages at 2000 characters and silent mid-content truncation has caused real production failures. Posting a short summary (~3-5 sentences) in the thread alongside the shared file is fine; the file is the authoritative deliverable.`,
      // Phase 999.61 (2026-05-15) — system-reminder discrimination.
      // Production: research subagent received a Claude Code runtime nudge
      // wrapped in <system-reminder> tags ("The task tools haven't been
      // used recently. If you're working on tasks that would benefit from
      // tracking progress, consider using TaskCreate...") and posted
      // "Ignoring the reminder — current task is a focused Q&A, no todo
      // list needed" instead of executing the delegated task. The model
      // misread the runtime nudge as the operator's task and bailed.
      //
      // <system-reminder> tags carry instructions from the harness, not
      // from the operator. Subagents must distinguish: their TASK is the
      // initial user message (the `task` parameter passed to
      // spawn_subagent_thread by the parent agent). Reminders are
      // metadata to consult, not work to execute.
      `**Important — distinguishing your TASK from runtime nudges:** Your task is the FIRST user message you receive (sent by your parent agent at spawn time). It describes what you must deliver. Any text wrapped in \`<system-reminder>\` tags is a runtime nudge from the Claude Code harness — NOT from your parent and NOT your task. Read \`<system-reminder>\` content if it's actionable to your task (e.g., "consider using TaskCreate" → use it if it helps you execute), but do NOT respond to reminders, do NOT acknowledge them in chat, and absolutely do NOT treat them as your task. If your first user message looks like a reminder rather than a real task, ASK the parent agent for clarification via thread.send — never silently ack-and-stop.`,
      // Auto-steer (2026-05-23) — operator can redirect a running
      // subagent mid-flight. Their guidance arrives as a turn input
      // wrapped in `<operator-steering>...</operator-steering>` framing.
      // The frame explicitly tells the model to integrate the new
      // directive with prior work — but documenting it in the
      // system prompt too eliminates the "subagent restarts from
      // scratch" failure mode in case the framing alone is missed.
      `**Mid-task redirection — \`<operator-steering>\` blocks.** If a user turn arrives wrapped in \`<operator-steering>...</operator-steering>\`, the operator has redirected your task while you were mid-flight. Your previous work in this thread is preserved (file system, prior tool outputs, completed steps). DO NOT restart from scratch. Integrate the new directive with what you've already done: keep useful work, abandon work that no longer applies, pivot the in-progress step if the directive changes its target. Acknowledge the redirect briefly in your next reply ("Pivoting to <new approach> — keeping <preserved work>") then continue executing.`,
    ];
    const delegationContext = normalizedDelegateTo
      ? [
          "",
          "## Delegation Context",
          `You are acting on behalf of \`${config.parentAgentName}\` who delegated this work to you.`,
          "Use your full identity, skills, and standards. Treat the operator's request",
          "as one fulfilled THROUGH you, not BY you.",
          "POST the full deliverable as plain text in this thread BEFORE calling `subagent_complete`",
          "(which carries NO content — a turn ending on the bare tool call delivers nothing). Do not",
          "ack-and-wait; do not summarize a plan — execute it and post the result first.",
        ]
      : [];
    const threadContext = [...baseContext, ...delegationContext].join("\n");

    // 7. Determine model — read from sourceConfig so delegate's
    // subagentModel/model wins when delegating (D-INH-01).
    const model = config.model ?? sourceConfig.subagentModel ?? sourceConfig.model;

    // 8. Build webhook identity per D-INH-03 — caller's webhookUrl
    // (channel-bound), delegate's per-message displayName + avatar
    // (verified at webhook-manager.ts:71-75 — discord.js client.send accepts
    // username + avatarURL per-call without rebinding the webhook).
    const webhook = parentConfig.webhook?.webhookUrl
      ? {
          displayName: normalizedDelegateTo
            ? (delegateConfig!.webhook?.displayName ?? delegateConfig!.name)
            : sessionName,
          avatarUrl: normalizedDelegateTo
            ? delegateConfig!.webhook?.avatarUrl
            : parentConfig.webhook.avatarUrl,
          webhookUrl: parentConfig.webhook.webhookUrl,
        }
      : undefined;

    // 9. Build subagent config
    //
    // Phase 99 sub-scope N (2026-04-26) — recursion guard: subagents inherit
    // the parent's soul which often instructs delegation ("when given a task,
    // spawn a subagent"). Without a hard block at the SDK level, the
    // subagent will ALSO call spawn_subagent_thread, recursing N levels
    // deep before the operator notices (real incident: 5-deep nested Admin
    // Clawdy chain). Strip the spawn tool at SDK level via disallowedTools
    // so subagents physically cannot spawn further subagents. Operator can
    // still spawn subagents from a real agent session (which does not carry
    // this disallow). Tool name is `mcp__<server-name>__<tool-name>` per
    // the SDK convention; server name is "clawcode" (src/mcp/server.ts:232)
    // and tool name is "spawn_subagent_thread" (src/mcp/server.ts:334).
    //
    // Phase 999.3 D-TCX-03 — disallowedTools stays UNCONDITIONAL: the
    // recursion guard applies whether or not delegateTo is set. Test DEL-05
    // pins this; conditional placement would silently bypass the Phase 99-N
    // regression. The line below MUST be the only set-site, outside any
    // delegate/non-delegate branch.
    //
    // Phase 999.99 — the recursion-guard tool is now UNIONed with (NOT
    // substituted for) the inherited fleet `disallowedTools` default. Before
    // this phase the line below was a literal clobber
    // (`["mcp__clawcode__spawn_subagent_thread"]`), which overwrote the
    // fleet default that `...subagentSourceConfig` (a ResolvedAgentConfig,
    // session-manager getAgentConfig) had just spread in. That clobber meant
    // a subagent kept the recursion guard but LOST the fleet poll-tool block
    // (ScheduleWakeup/CronCreate) — so a subagent self-fired poll hit the
    // IDENTICAL buffer bug (CONTEXT §2c). "Fleet-wide" includes subagents:
    // the dedup union below gives a subagent BOTH the recursion guard AND the
    // fleet block. The union reads `subagentSourceConfig.disallowedTools`
    // AFTER the spread, so the inherited default is present; do NOT reorder.
    //
    // Phase 999.3 D-INH-01..02 — sourceConfig (delegate when delegating,
    // caller otherwise) carries inherited fields: model/soul/identity/skills/
    // mcpServers/subagentModel/effortLevel/etc. via spread. parentConfig
    // contributes channel-scoped overrides AFTER the spread:
    //   channels: []           — never inherit channels for subagents
    //   threads: caller's      — D-INH-02, caller's quota wins
    //   webhook: composed      — caller's URL + delegate's identity
    //
    // Phase 106 DSCOPE-02 — strip `delegates` from spread. Subagents never
    // orchestrate further subagents (recursion-guard at disallowedTools below
    // is defense-in-depth; this strip removes the *directive text* from the
    // subagent's system prompt entirely so the LLM doesn't even see it).
    // Doing the strip at the caller keeps `renderDelegatesBlock` pure — the
    // primary-agent code path remains byte-identical (Phase 999.13 invariant).
    // Destructure-only (no mutation) so sourceConfig.delegates stays intact
    // for any other consumer that holds a reference to it.
    const { delegates: _strippedDelegates, ...subagentSourceConfig } =
      sourceConfig;

    const subagentConfig: ResolvedAgentConfig = {
      ...subagentSourceConfig,
      name: sessionName,
      model,
      channels: [],
      soul: (config.systemPrompt ?? sourceConfig.soul ?? "") + threadContext,
      schedules: [],
      slashCommands: [],
      webhook,
      threads: parentConfig.threads,
      disallowedTools: Array.from(
        new Set([
          ...(subagentSourceConfig.disallowedTools ?? []),
          "mcp__clawcode__spawn_subagent_thread",
          // Finding 3 (260714-mkq review) — block start_workflow for
          // channel-less subagent-thread sessions. A subagent has
          // `channels: []` (set below), so a workflow it launches consumes
          // admission-gate slots while EVERY postToBoundChannel delivery
          // (progress, stall notice, final result) is silently dropped by the
          // daemon (no bound channel) — a silent result black hole. Same
          // constant the workflow-orchestrator already unions into its own
          // channel-less workers' disallowedTools (recursion guard).
          WORKFLOW_TOOL_DISALLOW,
          // Quick 260715-j1j review CR-03 — ALSO block the NATIVE "Workflow"
          // tool. An opted-in parent (nativeWorkflow: true) had "Workflow"
          // SUBTRACTED from its resolved deny-list (D5); the spread above
          // would hand that access to a channel-less subagent, where the
          // identical (or worse) delivery-black-hole argument applies AND the
          // July-14 stall-kill exposure returns. DELIBERATE ASYMMETRY: the
          // warm-worker-pool / workflow-orchestrator workers are NOT given
          // this union — they serve the opted-in agent's OWN channel turns,
          // so blocking Workflow there would break the nativeWorkflow feature
          // itself; they inherit the parent's resolved list unchanged.
          "Workflow",
        ]),
      ),
      // Quick 260715-j1j review CR-03 — strip the inherited opt-in flag so
      // the subagent's steer prompt never claims native Workflow is
      // PERMITTED while the union above blocks the tool. Spread-conditional
      // (only when the parent actually opted in) so the non-opted fleet's
      // subagent configs stay byte-identical.
      ...(subagentSourceConfig.nativeWorkflow === true
        ? { nativeWorkflow: false }
        : {}),
      // Phase 999.57 (2026-05-15) — inheritance-override slice MUST be
      // spread LAST so it wins over the source-config spread + the
      // per-field overrides above. Plugs four leak surfaces (heartbeat /
      // MEMORY.md auto-load / hybrid-RRF retrieval / DB+disk flush
      // timers). See subagent-config-overrides.ts for the per-field
      // justification.
      ...buildSubagentOverrides(
        parentConfig,
        sourceConfig,
        normalizedDelegateTo !== undefined,
      ),
    };

    // 10pre. Quick task 260520-qo5 — register an LlmRuntime resolver for
    // the subagent session name BEFORE startAgent. 138-04 (commit
    // `0be63e0`) made daemon.ts `getLlmRuntime(agentName)` throw for any
    // name absent from the boot-populated `llmRuntimeRegistry`. The
    // `startAgent` call below constructs the `SdkSessionAdapter`, whose
    // `loadSdkModule()` path calls `getLlmRuntime(config.name)` — so the
    // resolver MUST already exist by then.
    //
    // CRITICAL ORDERING: this runs BEFORE startAgent. Contrast the
    // heartbeat `setAgentConfigs` upsert below (step 10b) which runs
    // AFTER startAgent — heartbeat ticks tolerate a late registration,
    // the runtime lookup does not.
    // Phase 999.83-02 (Fix A) — thread the subagent's task as the backend's
    // first-turn PTY input ONLY when there's a non-empty task. The backend
    // delivers it menu-safe (\r first) + fire-once. A no-task spawn (e.g. the
    // self-introduction prompt) keeps the default \r warm-nudge. `config.task`
    // is the RAW task; the system-prompt-side threadContext anchor (see the
    // 999.61 framing comment in postInitialMessage) is the durable "this is
    // your task" signal — the channel push `content` is suppressed in this path
    // (double-run safety, below) so the framed `prompt` no longer reaches the
    // agent over the channel.
    const firstTurnTask =
      typeof config.task === "string" && config.task.length > 0
        ? config.task
        : undefined;
    this.registerLlmRuntime(
      sessionName,
      subagentConfig,
      config.parentAgentName,
      firstTurnTask !== undefined ? { firstTurnInput: firstTurnTask } : undefined,
    );

    // 10pre-b. Phase 999.82-03 — wire the subagent's ClawCode channel BEFORE
    // startAgent. The registry's backend gate is the filter: a v3
    // (`claude-code-interactive`) subagentConfig gets its bridge + `daemon.sock`
    // + `hook.sock`; a v2 config returns null and no socket is created (no
    // teardown needed for v2). This MUST run before startAgent so the
    // subagent's Stop/PostToolUse hooks find a listening socket the moment its
    // session boots — the hook frames route by `CLAWCODE_AGENT_NAME`, which the
    // v3 backend sets from `config.name` (= sessionName), so they land on THIS
    // subagent's bridge, not the parent's.
    //
    // LIFECYCLE PINCH (SPEC §Risks / T-999.82-03-02): unlike boot-wired bridges
    // (daemon lifetime), this dynamic bridge MUST be torn down on session end —
    // see the `unwireChannelForSubagent` calls at the stop sites below — or it
    // leaks its two listeners per spawn. The teardown is idempotent.
    // Phase 999.82-04 — capture the wire return. `wireForConfig` returns the
    // wired channel (carrying `.bridge`) for a v3 (`claude-code-interactive`)
    // subagent and `null` for a v2 one (the registry's backend gate). The
    // presence of `.bridge` IS the v3-vs-v2 signal the dispatch path branches
    // on below — there is no second backend gate (`feedback_silent_path_bifurcation`).
    const wiredChannel = this.wireChannelForSubagent?.(subagentConfig);
    const subagentBridge: SubagentChannelBridge | undefined =
      wiredChannel?.bridge;
    // Phase 999.82-04 (live-canary fix) — the listener half. The dispatch path
    // polls its `isConnected()` before pushing, because the subagent's channel
    // connects lazily (~6s post-spawn) and a cold push drops silently.
    const subagentListener: SubagentChannelListener | undefined =
      wiredChannel?.listener;

    // 10. Start agent session
    await this.sessionManager.startAgent(sessionName, subagentConfig);

    // 10b. Phase 999.57 (RESEARCH Finding 1) — register the subagent's
    // heartbeat-disabled config into the runner's local map. The existing
    // gate at heartbeat/runner.ts:271 short-circuits on
    // `agentConfig && agentConfig.heartbeat.enabled === false`. Without
    // this upsert, `agentConfigs.get(subagentSessionName)` returns
    // undefined → the `&&` short-circuits → checks fire on every subagent
    // session regardless of the config-side `heartbeat.enabled: false`
    // override above. setAgentConfigs is an additive upsert
    // (runner.ts:143-147 — for-of loop, no clear) so this is safe to
    // call alongside the daemon-boot registration at daemon.ts:3336.
    //
    // Order matters: this MUST run AFTER startAgent so a heartbeat tick
    // observing the freshly-started session also sees the gate-config.
    this.heartbeatRunner.setAgentConfigs([subagentConfig]);

    // 11. Persist thread binding
    const now = Date.now();
    const binding: ThreadBinding = {
      threadId: thread.id,
      // relayChannelId (the PARENT's channel). `relayCompletionToParent`
      // reads this to post the completion summary to the parent's main
      // channel. (Equal to the thread-creation channelId — Phase 999.19 T-03
      // delegate-channel routing reverted 2026-05-21.)
      parentChannelId: relayChannelId,
      agentName: config.parentAgentName,
      sessionName,
      createdAt: now,
      lastActivity: now,
    };

    // 999.65 — atomic read-modify-write so a concurrent registry writer
    // cannot lose-update this newly added binding.
    await mutateThreadRegistry(this.registryPath, (current) =>
      addBinding(current, binding),
    );

    this.log.info(
      { threadId: thread.id, threadName: config.threadName, parentAgent: config.parentAgentName, sessionName },
      "subagent thread spawned",
    );

    // 12. Kick off the initial prompt async -- either the handoff task (if
    // provided) or a generic intro. Deliberately not awaited so the MCP
    // caller gets the thread URL back immediately; the LLM roundtrip runs
    // in the background and posts directly to the thread. Errors are logged.
    // Phase 100 follow-up — post-reply chain:
    //   - autoRelay: parent gets a synthetic turn in its main channel
    //     summarizing the subagent's output
    //   - autoArchive (default false): also archive thread + stop session
    //   - autoArchive implies autoRelay
    //
    // Phase 999.57 (2026-05-15) — auto-relay fires when the subagent's FIRST
    // assistant stream ends (postInitialMessage awaits one SDK turn, then
    // calls relayCompletionToParent). For one-shot Q&A subagents this is
    // correct: the first reply IS the deliverable. For delegated multi-turn
    // work (delegateTo set), the first reply is almost always an ack or a
    // tool-use prelude — relaying it as "the answer" produces wrong
    // summaries (production failures 2026-05-15 18:04 + 18:09).
    //
    // Debug session `autorelay-fires-after-turn-1` (2026-05-22, option C)
    // — the same wrong-summary failure mode hit NON-delegated multi-turn
    // spawns (a `/gsd:*` phase build relayed its turn-1 output). The
    // `isDelegated` / `autoArchive` / `autoRelay` resolution is now HOISTED
    // to just before the thread-context build above (so the threadContext
    // `subagent_complete` instruction can be relay-mode-aware) — the
    // hoisted consts are reused verbatim here. Non-delegated multi-turn
    // callers opt out of the turn-1 relay with an explicit `autoRelay:
    // false` (the `/gsd:*` slash path; MCP callers per the
    // `spawn_subagent_thread` tool description). One-shot non-delegated
    // spawns keep `autoRelay: true` by default — unchanged.
    void this.postInitialMessage(
      thread,
      sessionName,
      config.threadName,
      config.task,
      autoRelay,
      autoArchive,
      // Phase 999.19 T-03 — delegate + parent names for delegated-work
      // consolidation. `normalizedDelegateTo` is `undefined` for
      // non-delegated spawns, which gates consolidation off entirely.
      normalizedDelegateTo,
      config.parentAgentName,
      // Phase 999.82-04 — the v3 subagent's channel bridge (undefined for a v2
      // subagent). When present, the turn is dispatched over the channel
      // (push + awaitReply + Stop-hook turn_complete fallback) instead of via
      // `streamFromAgent` — sidestepping the inert-Query wedge (SPEC §Root cause).
      subagentBridge,
      // Phase 999.82-04 (live-canary fix) — the channel listener; the dispatch
      // waits for its `isConnected()` before pushing (lazy-connect race).
      subagentListener,
    );

    return {
      threadId: thread.id,
      sessionName,
      parentAgent: config.parentAgentName,
      channelId,
    };
  }

  /**
   * Send the first prompt to the subagent and post its response to the thread.
   * If `task` is provided, the subagent starts working on it immediately.
   * If not, a brief intro prompt is sent so the thread isn't silent.
   * Failures are logged, never thrown -- the spawn has already succeeded.
   */
  private async postInitialMessage(
    thread: {
      send: (content: string) => Promise<{ edit: (content: string) => Promise<unknown>; id: string } | unknown>;
      id: string;
    },
    sessionName: string,
    threadName: string,
    task: string | undefined,
    autoRelay: boolean,
    autoArchive: boolean,
    // Phase 999.19 T-03 — delegated-work consolidation context.
    // `delegateAgent` is `undefined` for non-delegated spawns (the
    // consolidation step is gated on it being set). `parentAgent` is the
    // delegating agent — it becomes the "Delegated by" field + a tag.
    delegateAgent?: string,
    parentAgent?: string,
    // Phase 999.82-04 — when set (v3 subagent), dispatch the turn over the
    // ClawCode channel (push + awaitReply + Stop-hook turn_complete fallback)
    // instead of `streamFromAgent`. Undefined ⇒ v2 subagent ⇒ unchanged
    // `streamFromAgent` dispatch.
    subagentBridge?: SubagentChannelBridge,
    // Phase 999.82-04 (live-canary fix) — the channel listener; the v3 dispatch
    // polls `isConnected()` before pushing so a cold-channel push isn't dropped.
    subagentListener?: SubagentChannelListener,
  ): Promise<void> {
    // Sub-bug A handle declared outside the try so the finally block can
    // stop it whether the stream succeeded or threw (see import comment).
    let typingHandle: { stop: () => void } | null = null;
    // Debug session `autorelay-placeholder-misfire` (2026-05-22) — positive
    // content-production signal, declared in the OUTER scope so the
    // post-reply `if (autoRelay)` block below can read it. Stays `false`
    // when the subagent's turn produced no real content (only the unedited
    // "🔄 Working..." placeholder is in the thread) OR when the SDK turn
    // threw before producing output. autoRelay is gated on this so a
    // placeholder is never relayed to the parent as a completed result.
    let producedRealContent = false;
    try {
      // Phase 999.61 (2026-05-15) — wrap the operator's task with an
      // explicit directive frame. Production failure: research subagent
      // received a Claude Code `<system-reminder>` (the periodic TaskCreate
      // nudge) on its first turn alongside the actual task, and the model
      // responded to the reminder ("Ignoring the reminder — current task
      // is a focused Q&A, no todo list needed") instead of executing the
      // delegated work. The raw `task` string gave no structural signal
      // that THIS was the task vs. a runtime reminder.
      //
      // Fix: frame the task with a clear header + explicit "ignore
      // reminders" reminder so the model has a robust anchor for what to
      // execute. Pair with the threadContext instruction injected in the
      // baseContext build (see "distinguishing your TASK from runtime
      // nudges" line above) which lives in the system prompt.
      const prompt = task
        ? (
            `# YOUR TASK (delivered by parent agent)\n\n` +
            `${task}\n\n` +
            `---\n\n` +
            `**Execute this task.** Produce the deliverable in this turn or across multiple turns as needed. ` +
            `If you see \`<system-reminder>\` tags below or in subsequent turns, those are runtime nudges from the Claude Code harness — they are NOT your task and you should NOT respond to them. ` +
            `Your task is the text above. When the deliverable is complete, follow the subagent_complete + clawcode_share_file contract from your system prompt.`
          )
        : `You've just been spawned in a Discord thread titled "${threadName}". ` +
          `Introduce yourself in 1-2 short sentences based on your soul and state what you're ready to do. ` +
          `No filler, no meta-commentary about being an AI.`;

      // Phase 100 follow-up — progressive streaming into the thread.
      // Send a single placeholder, then edit it as the SDK streams tokens
      // back. Final flush captures any tail that didn't trigger an edit
      // (the editor debounces to 750ms by default to stay under Discord's
      // 5-edits-per-5-sec rate limit). When streaming produces >2000
      // chars, the editor truncates the edited message — we follow up
      // with thread.send() chunks for the overflow after the stream
      // completes (mirroring the pattern at slash-commands.ts:1550).
      const placeholder = await thread.send(SUBAGENT_WORKING_PLACEHOLDER);
      const editable = (placeholder ?? {}) as { edit?: (content: string) => Promise<unknown> };
      const canEdit = typeof editable.edit === "function";

      // Phase 999.36 sub-bug A (D-04, D-05) — fire typing indicator continuously
      // through the subagent's stream so the operator sees activity even during
      // 5-min boot waits. Mirrors bridge.ts:357-377 + 606-611 pattern.
      // Stopped in the finally block below before the autoRelay/autoArchive
      // chain so the indicator clears once the visible message is delivered.
      typingHandle = startTypingLoop(
        thread as unknown as { sendTyping?: () => Promise<unknown> },
        this.log,
      );

      // Debug session `stale-turn-watchdog-miss` (999.64 RECURRENCE) gap #3
      // — register this session's typing-loop stop fn so the heartbeat
      // stale-turn sweep can clear the indicator if the SDK turn hangs
      // forever (the `finally` below would never run in that case). The
      // matching deregister is in the `finally`; clearInterval is
      // idempotent, so a sweep-then-finally (or finally-then-sweep) double
      // stop is harmless.
      this.typingCleanups.set(sessionName, () => typingHandle?.stop());

      // Phase 100-fu — log streaming startup so the next overflow-related
      // failure has a breadcrumb (canEdit=true means we'll use the
      // edit-based progressive path; false means we fall back to single
      // send at the end).
      this.log.info(
        { sessionName, threadId: thread.id, canEdit, hasPlaceholder: Boolean(placeholder) },
        "subagent thread streaming initialized",
      );

      // If the surface doesn't support edit (test mocks, old discord.js),
      // fall back to the prior behavior — single send at the end.
      let lastSent = "";
      // Debug session `autorelay-placeholder-misfire` (2026-05-22) — set
      // true once the streaming editor has actually edited the placeholder
      // to real content. Stays false when the SDK delivers its reply
      // WITHOUT incremental `text_delta` events: `onChunk` never fires →
      // `editor.update()` never runs → `editor.flush()` is a no-op (it only
      // sends when `pendingText !== null`) → the placeholder is never
      // edited. The backstop write below uses this flag to guarantee the
      // real reply still reaches the thread.
      let editApplied = false;
      const editor = canEdit
        ? new ProgressiveMessageEditor({
            editFn: async (content: string) => {
              // Phase 100 follow-up — wrap raw markdown tables in ```text```
              // fences so Discord renders monospaced + columns visibly align.
              const wrapped = formatOutboundText(content);
              const truncated = wrapped.length > 2000 ? wrapped.slice(0, 1997) + "..." : wrapped;
              if (truncated === lastSent) return;
              lastSent = truncated;
              await editable.edit!(truncated);
              editApplied = true;
            },
            editIntervalMs: 750,
            log: this.log,
            agent: sessionName,
            // Hold the "🔄 Working..." placeholder visible for at least 1500ms
            // before the first streamed token edits it away. Phase 999.78 boot
            // suppression dropped time-to-first-token from ~3-5s to ~500-1000ms;
            // without this hold Discord's render cycle elides the placeholder
            // entirely and operators perceive the thread "appearing with
            // content directly" instead of going through a visible Working...
            // state. Hold cost: up to 1.5s of perceived stream latency per
            // subagent spawn — acceptable trade for the visual signal.
            firstEditMinDelayMs: 1500,
          })
        : null;

      // Phase 999.59 (2026-05-15) — capture the LAST accumulated text seen
      // by the editor so the overflow handler below can chunk against the
      // true stream content, not just the SDK's final reply.
      //
      // Why this matters: Claude Code SDK multi-step turns (assistant text →
      // tool_use → tool_result → assistant text → ...) emit MANY assistant
      // text blocks per turn. The streamFromAgent return value is the LAST
      // text block only. `accumulated` (passed to the onChunk callback)
      // concatenates the WHOLE stream. Production failure 2026-05-15 18:28:
      // research subagent emitted a long table mid-stream then closed with
      // a short "Research complete." final block (responseLength: 254).
      // The overflow trigger `text.length > 2000` saw 254, didn't fire.
      // Placeholder kept the editor-truncated table with no follow-up
      // chunks. The deliverable was silently lost mid-row at BOOTSTRAP.md.
      let accumulatedSeen = "";
      let reply: string | undefined;

      if (subagentBridge) {
        // Phase 999.82-04 — V3 CHANNEL DISPATCH. A v3 subagent's turn runs in
        // its OWN `claude --channels` process; `streamFromAgent` (the v2 SDK
        // iterate path) would drive an inert v3 Query — no tokens stream, the
        // Phase 127 stall tracker false-trips at ~180s and the turn "wedges"
        // (SPEC §Root cause). Instead we dispatch over the subagent's ClawCode
        // channel exactly like the parent chat (bridge.ts v3 branch, Plan 02):
        // push the task with a reply_correlation_id, register a thread-bound
        // progress callback so PostToolUse frames stream into the SAME
        // placeholder editor, then await the final assistant reply (resolved by
        // the agent's `clawcode_ack` OR the Stop-hook `turn_complete` fallback
        // inside `awaitReply`).
        //
        // `feedback_silent_path_bifurcation`: the reply + accumulated stream
        // feed the EXISTING downstream machinery (fullContent /
        // producedRealContent / backstop / overflow / stamp) via the same
        // `reply` / `accumulatedSeen` vars the v2 path sets — no new parallel
        // thread write.
        const correlationId = `subdispatch-${nanoid(12)}`;

        // Phase 999.82-04 (live-canary fix) — WAIT FOR THE CHANNEL TO CONNECT
        // BEFORE PUSHING. A freshly-spawned subagent's `claude --channels`
        // process connects its channel LAZILY (~6s after spawn, when the
        // warm-nudge fires its first turn). The daemon's `DaemonSocketListener.send`
        // drops silently when no peer is connected (no-peer drop), so a push
        // issued in that ~6s cold window never reaches the subagent → no turn →
        // no ack/turn_complete → `awaitReply` times out at 600s (the live gate3
        // canary failure: awaitReply started ~915047ms, channel connected at
        // 921351ms, 6.3s too late). The parent chat never hits this because its
        // channel is already warm when a Discord message arrives. Poll
        // `isConnected()` up to the ceiling; if it never connects, FAIL the
        // dispatch (handled below as a failed turn — notify parent) rather than
        // pushing into the void.
        const connected = await this.waitForChannelConnection(
          subagentListener,
          sessionName,
        );
        if (!connected) {
          throw new ChannelReplyTimeoutError(correlationId, this.connectCeilingMs);
        }

        // Register the progress callback BEFORE push so no early PostToolUse
        // frame is lost (mirror Plan 02 ordering). A tool-using turn streams;
        // a tool-less turn emits no progress frames → the placeholder is
        // final-only via the backstop edit below (today's behavior preserved).
        // The single in-flight subagent turn means there is no concurrent-turn
        // gate to honor (unlike the parent chat's pendingReplyCount guard).
        if (editor && typeof subagentBridge.registerProgressCallback === "function") {
          subagentBridge.registerProgressCallback((accumulated: string) => {
            accumulatedSeen = accumulated;
            editor.update(accumulated);
          });
        }

        // SUBAGENT COLD-START FIX (Option C — \r-retry connect + connection-
        // gated PTY task delivery). Each delivery channel does the part it is
        // reliable at:
        //   • The backend retries the idempotent menu-dismiss \r (5/20/45s),
        //     which dismisses the dev-channels menu and CONNECTS the channel
        //     (waitForChannelConnection above gates on it). One of the retries
        //     lands after the menu renders, so cold-start no longer hangs.
        //   • The TASK is delivered as a self-submitting PTY turn below, AFTER
        //     the channel is confirmed connected. This is the reliable trigger.
        //     A channel push that CARRIES the task can land in the connect→ready
        //     gap and never surface as a turn — observed live: 2 of 3 fresh
        //     subagents under load connected but never turned, 1 caught it
        //     (exactly the raciness Fix A flagged). A direct PTY write at the
        //     now-dismissed prompt always triggers a turn.
        // For a task spawn the PTY turn (below) is the reliable SOLE task
        // trigger (a task-carrying channel push can drop in the connect→ready
        // gap — observed 2/3 under load). The push's job is correlation: its
        // message_id + reply_correlation_id register the wait, and the agent
        // reads the message_id to address its clawcode_ack.
        //
        // 141-FIX (2026-06-02): the push content was previously "" — but an
        // EMPTY `a2a` notification SURFACES AS A TURN on the subagent (the
        // system prompt instructs the agent to act on a2a envelopes), and empty
        // content → the agent replies "Received an empty message … no task
        // provided" before the PTY task lands (observed live on research-sub-*,
        // correlation `subdispatch-…`). Fix: the correlation push carries a
        // non-empty HOLD notice that tells the agent to AWAIT its terminal task
        // and NOT reply to / ack this envelope on its own — so it can never
        // produce the empty "no task" turn, while the PTY write stays the SOLE
        // task trigger (still no T-999.83-02-DUP double-run). A no-task spawn
        // keeps the framed `prompt` as the channel-triggered intro.
        const hasTask = typeof task === "string" && task.length > 0;
        const HOLD_NOTICE =
          "(Correlation handle only — no task in this message. Your actual task " +
          "is being delivered to your terminal prompt right now: wait for it, do " +
          "the work, then call clawcode_ack with this message_id and your result. " +
          "Do NOT reply to or clawcode_ack this notification on its own.)";
        subagentBridge.push({
          // Reuse the existing `a2a` event type (the parent-chat v3 dispatch
          // uses it too). There is no `task` ChannelEventType — a delegated
          // turn IS an agent-to-agent delivery. See deviation note in SUMMARY.
          type: "a2a",
          message_id: correlationId,
          content: hasTask ? HOLD_NOTICE : prompt,
          meta: {
            reply_correlation_id: correlationId,
            source_agent: parentAgent ?? "discord",
          },
        });
        if (hasTask) {
          // Single-line the task: a literal newline in PTY stdin can submit
          // early / mis-key. The structural "this IS your task" anchor lives in
          // the system-prompt threadContext (999.61 framing), so a one-line
          // trigger is sufficient. Trailing \r (Enter) self-submits the turn —
          // no dependence on the channel push surfacing.
          const taskLine = (task as string).replace(/\r?\n/g, " ").trim();
          const wrote = debugWriteToPtyForAgent(sessionName, `${taskLine}\r`);
          this.log.info(
            {
              sessionName,
              ok: wrote.ok,
              reason: wrote.ok ? undefined : wrote.reason,
              taskChars: taskLine.length,
            },
            "subagent task delivered via PTY (post-connect turn trigger)",
          );
        }

        // Generous 10-minute deadline (a delegated subagent turn can be long).
        // A timeout rejects with ChannelReplyTimeoutError — handled in the
        // catch below as a failed turn (notify parent), NOT a daemon crash
        // (threat T-999.82-04-01).
        const ack = await subagentBridge.awaitReply(correlationId, 600_000);
        reply = ack.result ?? "";
        if (editor) await editor.flush();
      } else {
        // V2 SUBAGENT — unchanged `streamFromAgent` dispatch (the v2 SDK
        // iterate path streams `text_delta` tokens into the editor).
        reply = await this.sessionManager.streamFromAgent(
          sessionName,
          prompt,
          editor
            ? (accumulated: string) => {
                accumulatedSeen = accumulated;
                editor.update(accumulated);
              }
            : (accumulated: string) => {
                accumulatedSeen = accumulated;
              },
        );
        if (editor) await editor.flush();
      }

      // Defensive: streamFromAgent may resolve with undefined under test mocks
      // or if the SDK returns nothing. Treat undefined as empty.
      //
      // Phase 999.59 — use the longer of accumulatedSeen vs reply. In
      // single-block turns they're identical; in multi-block turns
      // accumulatedSeen has the full stream while reply has only the final
      // block. Picking the longer is safe in both cases. Trim once after.
      const baseReply = (reply ?? "").trim();
      const baseAccum = accumulatedSeen.trim();
      const fullContent = baseAccum.length > baseReply.length ? baseAccum : baseReply;
      const text = formatOutboundText(fullContent);

      // Debug session `autorelay-placeholder-misfire` (2026-05-22) — record
      // whether the subagent's turn produced real content. `fullContent` is
      // the already-trimmed reply (the longer of the SDK return value and
      // the accumulated stream). The predicate rejects empty replies and the
      // unedited placeholder string. autoRelay below is gated on this.
      producedRealContent = isRealSubagentContent(fullContent);

      if (!canEdit && text) {
        // Fallback path — send the final reply as a fresh message.
        await thread.send(text.slice(0, 2000));
      }

      // Debug session `autorelay-placeholder-misfire` (2026-05-22) —
      // BACKSTOP THREAD WRITE. The progressive editor edits the
      // "🔄 Working..." placeholder only when its `onChunk` callback fires,
      // and `onChunk` fires only on incremental SDK `text_delta` events.
      // When the SDK delivers the assistant's final text WITHOUT
      // incremental deltas (a buffered reply — observed on clawdy
      // 2026-05-22), `onChunk` never fires, `editor.flush()` is a no-op, and
      // the placeholder is never edited. The `!canEdit` and `text > 2000`
      // paths above do not cover the common `canEdit && 0 < len <= 2000`
      // case, so the thread would show only the 13-char placeholder.
      //
      // Here: if the surface is editable, the editor never applied an edit,
      // and we DO have real content, write it into the placeholder directly
      // (fall back to thread.send if the edit throws). This guarantees the
      // subagent's real reply reaches the thread regardless of the SDK's
      // streaming behavior — which is also what `relayCompletionToParent`
      // reads from when autoRelay fires.
      if (canEdit && !editApplied && producedRealContent) {
        const backstopText =
          text.length > 2000 ? text.slice(0, EDITOR_TRUNCATE_INDEX) + "..." : text;
        try {
          await editable.edit!(backstopText);
          editApplied = true;
          this.log.info(
            {
              sessionName,
              threadId: thread.id,
              contentLength: text.length,
            },
            "subagent placeholder backstop-edited — SDK reply arrived without incremental deltas (editor never fired)",
          );
        } catch (err) {
          // Edit failed — send the content as a fresh thread message so it
          // is not lost. A failure here is non-fatal; the autoRelay gate
          // below still keys off `producedRealContent`.
          this.log.warn(
            {
              sessionName,
              threadId: thread.id,
              error: (err as Error).message,
            },
            "subagent placeholder backstop edit failed — sending real reply as a fresh message",
          );
          try {
            await thread.send(backstopText);
          } catch (sendErr) {
            this.log.warn(
              {
                sessionName,
                threadId: thread.id,
                error: (sendErr as Error).message,
              },
              "subagent placeholder backstop send also failed (non-fatal)",
            );
          }
        }
      }
      // Phase 100 follow-up — handle overflow when reply exceeds 2000 chars.
      // The editor truncated the visible message; send the tail as
      // additional thread.send() chunks so nothing is lost.
      //
      // Phase 100-fu (2026-04-28) — structured diagnostics. Without an
      // aggregate "summary" log line, the next time Discord silently
      // dropped chunks there was no breadcrumb to debug from. Capture
      // totalLength + chunksSent + fullySent + lastError so the failure
      // mode is observable in production logs.
      //
      // Phase 999.59 — `text` now derives from accumulatedSeen|reply
      // (whichever is longer), so multi-step turns where the SDK final
      // block is short but the stream produced overflow now fire correctly.
      if (canEdit && text.length > 2000) {
        let cursor = EDITOR_TRUNCATE_INDEX;
        let chunksSent = 0;
        let lastError: string | null = null;
        while (cursor < text.length) {
          const chunk = text.slice(cursor, cursor + 2000);
          try {
            await thread.send(chunk);
            chunksSent++;
          } catch (err) {
            lastError = (err as Error).message;
            this.log.warn(
              {
                sessionName,
                threadId: thread.id,
                chunkIndex: chunksSent,
                cursor,
                totalLength: text.length,
                error: lastError,
              },
              "subagent overflow chunk send failed (non-fatal — continuing if possible)",
            );
            break;
          }
          cursor += 2000;
        }
        this.log.info(
          {
            sessionName,
            threadId: thread.id,
            totalLength: text.length,
            editorCutoffIndex: EDITOR_TRUNCATE_INDEX,
            overflowStartCursor: EDITOR_TRUNCATE_INDEX,
            seamGapBytes: 0,
            chunksSent,
            lastError,
            fullySent: cursor >= text.length,
            endReason: lastError ? "send-failed" : "drained",
          },
          "subagent overflow chunks summary",
        );
      }

      // Phase 999.36 sub-bug D (D-13) — stamp lastDeliveryAt AFTER the
      // final text + overflow chunks have fully drained to Discord. The
      // stamp gates markRelayCompleted from firing the subagent_complete
      // event — without this stamp, the relay path will refuse to mark
      // complete, preventing the premature-relay class.
      //
      // Failure to stamp is logged but non-fatal — the session-end callback
      // is the backstop (treats session-end as delivery-equivalent).
      try {
        const stampResult = await stampLastDeliveryAt(
          this.registryPath,
          thread.id,
          Date.now(),
          producedRealContent,
        );
        if (!stampResult.ok) {
          this.log.warn(
            { threadId: thread.id, sessionName, reason: stampResult.reason },
            "subagent lastDeliveryAt stamp failed (non-fatal — session-end backstop will fire)",
          );
        }
      } catch (err) {
        this.log.warn(
          { threadId: thread.id, sessionName, error: (err as Error).message },
          "subagent lastDeliveryAt stamp threw (non-fatal)",
        );
      }
    } catch (err) {
      this.log.warn(
        { sessionName, error: (err as Error).message, hadTask: Boolean(task) },
        "subagent initial message failed",
      );
      // Debug session `in-tool-wedge-recovery` work-stream (B), FORK 1 —
      // smart recovery for a wedged DELEGATED SUBAGENT turn.
      //
      // A subagent wedge surfaces here as an AbortError carrying a
      // `wedgeInfo` object — attached by the SDK handle on the Phase 127
      // ceiling abort AND on the 999.64 heartbeat sweep's force-release
      // (both 2026-05-21 production wedges were sweep-released subagents).
      //
      // FORK 1 — a subagent is NEVER auto re-run: its "request" is the
      // parent agent's `spawn_subagent_thread` instruction, and re-running
      // it would re-spawn / double-post. So this branch is NOTIFY-ONLY,
      // unconditionally, regardless of the in-flight tool's read-only vs
      // mutating class. The notice goes to the PARENT agent's channel so
      // the parent sees it and can decide whether to re-delegate.
      //
      // GATED on `wedgeInfo` presence — this catch also fires for ordinary
      // subagent failures and operator interrupts; only a genuine wedge
      // carries `wedgeInfo`. Without the gate this would spam the parent
      // channel on every unrelated subagent error.
      const subagentWedge = (err as { wedgeInfo?: WedgeInfo } | null)
        ?.wedgeInfo;
      // Phase 999.82-04 — a v3 subagent's channel dispatch that never acks
      // rejects `awaitReply` with ChannelReplyTimeoutError. The old inert-Query
      // wedge class is GONE for v3 dispatch (we no longer drive a v2 SDK iterate
      // over it), so a timeout is the new failed-turn surface. Treat it like a
      // wedge for the operator: NOTIFY-ONLY to the parent channel, never auto
      // re-run, never crash the daemon (threat T-999.82-04-01). Distinct notice
      // text so the operator can tell a stalled-tool wedge from a no-reply
      // timeout.
      const channelTimeout =
        err instanceof ChannelReplyTimeoutError ? err : null;
      if (subagentWedge || channelTimeout) {
        if (subagentWedge) {
          this.log.warn(
            {
              sessionName,
              threadId: thread.id,
              wedgeReason: subagentWedge.reason,
              inFlightTools: subagentWedge.inFlightToolNames,
            },
            "delegated subagent turn wedged — notifying parent channel (FORK 1: never auto re-run a subagent)",
          );
        } else {
          this.log.warn(
            { sessionName, threadId: thread.id },
            "delegated v3 subagent did not reply over its channel within the deadline — notifying parent channel (FORK 1: never auto re-run a subagent)",
          );
        }
        const noticeText = subagentWedge
          ? // Phase 999.114 — was a fixed "(a tool wedged)". `WedgeInfo`
            // documents `no-useful-tokens` + empty `inFlightToolNames` as a
            // pure-text hang with NO tool involved, which is what ALL 17 such
            // trips in the 7-day prod sweep were. Share the same pure renderer
            // as the main-channel notice so both surfaces tell the same truth.
            `⚠️ A delegated subagent's turn was aborted and recovered. ` +
            `${describeStallNotice(subagentWedge).replace(/^(?:⚠️|<:cc_warning:\d+>) /u, "")} ` +
            `The subagent did not finish — re-delegate the task if it is still needed. (thread: ${thread.id})`
          : `⚠️ A delegated subagent did not respond within the time limit and its turn was abandoned. ` +
            `The subagent did not finish — re-delegate the task if it is still needed. (thread: ${thread.id})`;
        try {
          const registry = await readThreadRegistry(this.registryPath);
          const binding = getBindingForThread(registry, thread.id);
          if (binding?.parentChannelId) {
            const parentChannel = await this.discordClient.channels
              .fetch(binding.parentChannelId)
              .catch(() => null);
            const parentSendable = parentChannel as
              | { send: (content: string) => Promise<unknown> }
              | null;
            if (parentSendable && typeof parentSendable.send === "function") {
              await parentSendable.send(noticeText);
            } else {
              this.log.info(
                { threadId: thread.id, sessionName },
                "subagent failed-turn notice skipped — parent channel unreachable",
              );
            }
          } else {
            this.log.info(
              { threadId: thread.id, sessionName },
              "subagent failed-turn notice skipped — no parent channel binding",
            );
          }
        } catch (notifyErr) {
          this.log.warn(
            {
              threadId: thread.id,
              sessionName,
              error: (notifyErr as Error).message,
            },
            "subagent failed-turn — failed to notify parent channel (non-fatal)",
          );
        }
      }
    } finally {
      // Phase 999.82-04 — clear the channel progress callback regardless of
      // outcome (success, timeout, or any throw) so a v3 subagent's bridge
      // never holds a stale closure pointing at this turn's editor. No-op for
      // the v2 path (no callback was registered). Wrapped so a clear failure
      // can't block the typing/cleanup teardown below.
      try {
        subagentBridge?.clearProgressCallback?.();
      } catch {
        /* non-fatal */
      }
      // Stop the typing indicator BEFORE the autoRelay/autoArchive chain so
      // the operator doesn't see typing during relay/archive cleanup.
      // Wrapped in try so clearInterval can never block the post-reply chain.
      try { typingHandle?.stop(); } catch { /* non-fatal */ }
      // Debug session `stale-turn-watchdog-miss` (999.64 RECURRENCE) gap #3
      // — deregister this session's typing cleanup. On the normal path the
      // loop is already stopped above; dropping the Map entry prevents an
      // unbounded leak of stale closures (one per subagent spawn). NB this
      // `finally` only runs when the SDK turn settled — for a wedged turn
      // the entry intentionally stays so the heartbeat sweep can use it.
      this.typingCleanups.delete(sessionName);
    }
    // Phase 100 follow-up — post-reply chain. Runs even if the initial
    // message failed, because the operator wanted notification and a
    // dangling thread is worse than no summary. Each step has its own
    // try/catch so a failure in one doesn't block the others.
    //
    // Phase 999.19 T-03 — capture the relay's trimmed delegate text so
    // the consolidation step below can write it into the delegate's
    // memory without a second Discord fetch. `null` on any relay
    // skip/early-return/failure path.
    let relayedText: string | null = null;
    // Debug session `autorelay-placeholder-misfire` (2026-05-22) — CONTENT
    // GATE. autoRelay fires on turn-1 stream-end. When the subagent's turn
    // produced no real content (`producedRealContent` is false — only the
    // unedited "🔄 Working..." placeholder is in the thread, or the SDK
    // turn threw before producing output), `relayCompletionToParent` would
    // walk the thread, find the lone placeholder, and relay 13 chars to the
    // parent as a "completed result" (the exact 2026-05-22 clawdy misfire).
    // Skip the relay in that case and log it — a missing relay is correct
    // when there is genuinely nothing to relay; a placeholder relay is not.
    if (autoRelay && !producedRealContent) {
      this.log.info(
        { threadId: thread.id, sessionName, threadName },
        "auto-relay skipped — subagent produced no real content (would relay the 'Working...' placeholder)",
      );
    }
    if (autoRelay && producedRealContent) {
      try {
        relayedText = await this.relayCompletionToParent(thread.id);
      } catch (err) {
        this.log.warn(
          { threadId: thread.id, sessionName, error: (err as Error).message },
          "auto-relay: relayCompletionToParent failed (non-fatal)",
        );
      }
    }
    if (autoArchive) {
      // Phase 999.36 sub-bug D (D-14) — verify delivery was confirmed
      // before archiving. If lastDeliveryAt is missing (stamp failed
      // earlier or the spawn never reached the delivery site), do NOT
      // archive — leave the thread open so the operator can investigate.
      // The relay above already gated on lastDeliveryAt; this is
      // defense-in-depth. On read failure, prefer leaving the thread open
      // (operator can manually archive).
      let deliveryConfirmed = false;
      try {
        const registry = await readThreadRegistry(this.registryPath);
        const binding = getBindingForThread(registry, thread.id);
        deliveryConfirmed = Boolean(binding?.lastDeliveryAt);
        if (!deliveryConfirmed) {
          this.log.warn(
            { threadId: thread.id, sessionName, hasBinding: Boolean(binding) },
            "auto-archive skipped — lastDeliveryAt not confirmed; thread stays open",
          );
        }
      } catch (err) {
        this.log.warn(
          { threadId: thread.id, sessionName, error: (err as Error).message },
          "auto-archive guard read failed (non-fatal); skipping archive",
        );
      }
      if (!deliveryConfirmed) {
        return;
      }
      // Phase 999.19 T-03 — delegated-work consolidation. Runs ONLY for
      // delegated spawns (`delegateAgent` set), AFTER the relay and the
      // deliveryConfirmed gate, BEFORE archive/stop. Writes one
      // `source: "consolidation"` record into the delegate agent's own
      // MemoryStore so the delegate accumulates a searchable record of
      // past delegated tasks. `consolidateDelegatedWork` swallows its own
      // errors; the outer try/catch here is belt-and-suspenders so a
      // programming error in the call site can never block archive/stop.
      // Non-delegated `-sub-` spawns never reach this (delegateAgent is
      // undefined).
      if (delegateAgent) {
        try {
          await consolidateDelegatedWork(
            {
              delegateAgent,
              parentAgent: parentAgent ?? "unknown",
              task: task ?? "",
              keyFindings: relayedText ?? "(no relayed text captured)",
              threadId: thread.id,
              // Thread URL needs the guild id, which the minimal `thread`
              // param does not carry — pass undefined; the record falls
              // back to the bare threadId (CONTEXT.md D5 allows this).
              threadUrl: undefined,
            },
            {
              getMemoryStore: (a) => this.sessionManager.getMemoryStore(a),
              embedText: (t) => this.sessionManager.embedText(t),
              log: this.log,
            },
          );
        } catch (err) {
          this.log.warn(
            { threadId: thread.id, error: (err as Error).message },
            "consolidation step threw (non-fatal — archive continues)",
          );
        }
      }
      try {
        await this.archiveThread(thread.id);
      } catch (err) {
        this.log.warn(
          { threadId: thread.id, sessionName, error: (err as Error).message },
          "auto-archive: archiveThread failed (non-fatal)",
        );
      }
      try {
        await this.sessionManager.stopAgent(sessionName);
      } catch (err) {
        this.log.warn(
          { threadId: thread.id, sessionName, error: (err as Error).message },
          "auto-archive: stopAgent failed (non-fatal)",
        );
      }
      // Phase 999.82-03 — tear down the dynamic subagent's ClawCode channel on
      // session end (the lifecycle pinch: dynamic bridges leak per spawn if
      // never unwired — see the wire site above). Idempotent + best-effort:
      // a v2 subagent never wired one (no-op), and a later cleanup call is a
      // no-op too. Own try/catch so a teardown failure can't break the archive.
      try {
        await this.unwireChannelForSubagent?.(sessionName);
      } catch (err) {
        this.log.warn(
          { threadId: thread.id, sessionName, error: (err as Error).message },
          "auto-archive: subagent channel teardown failed (non-fatal)",
        );
      }
      this.log.info(
        { threadId: thread.id, sessionName, threadName },
        "subagent auto-archived (relay + archive + stop)",
      );
    } else if (autoRelay && producedRealContent) {
      // Debug session `autorelay-placeholder-misfire` (2026-05-22) — gated
      // on `producedRealContent` so this "auto-relayed to parent" line is
      // logged ONLY when the relay actually fired. Without the gate, a
      // no-content spawn logged both "auto-relay skipped..." AND
      // "auto-relayed to parent" — a contradiction that would mislead an
      // operator into thinking the relay succeeded (the same silent-wrong-
      // result class this debug session fixed).
      this.log.info(
        { threadId: thread.id, sessionName, threadName },
        "subagent auto-relayed to parent (thread + session stay alive)",
      );
    }
  }

  /**
   * Clean up a subagent thread session.
   * Stops the session and removes the binding.
   * Does NOT delete the Discord thread (preserves history per SATH-04).
   * No-op if threadId has no binding.
   */
  async cleanupSubagentThread(threadId: string): Promise<void> {
    const registry = await readThreadRegistry(this.registryPath);
    const binding = getBindingForThread(registry, threadId);

    if (!binding) {
      return;
    }

    // Stop subagent session
    await this.sessionManager.stopAgent(binding.sessionName);

    // Phase 999.82-03 — tear down the dynamic subagent's ClawCode channel here
    // too. cleanupSubagentThread is the general (non-auto-archive) stop path; a
    // subagent that took this route still needs its bridge/sockets closed or
    // they leak (T-999.82-03-02). Idempotent: if the auto-archive path already
    // unwired this name, the registry's `unwireForAgent` is a no-op; and a v2
    // subagent never wired one. Own try/catch so teardown can't block cleanup.
    try {
      await this.unwireChannelForSubagent?.(binding.sessionName);
    } catch (err) {
      this.log.warn(
        { threadId, sessionName: binding.sessionName, error: (err as Error).message },
        "cleanup: subagent channel teardown failed (non-fatal)",
      );
    }

    // Remove binding from registry — 999.65: atomic read-modify-write.
    await mutateThreadRegistry(this.registryPath, (current) =>
      removeBinding(current, threadId),
    );

    this.log.info(
      { threadId, sessionName: binding.sessionName },
      "subagent thread cleaned up",
    );
  }

  /**
   * Get all subagent thread bindings from the registry.
   */
  async getSubagentBindings(): Promise<readonly ThreadBinding[]> {
    const registry = await readThreadRegistry(this.registryPath);
    return registry.bindings;
  }

  /**
   * Debug session `stale-turn-watchdog-miss` (999.64 RECURRENCE) gap #3 —
   * stop a subagent session's Discord typing indicator.
   *
   * Called by the heartbeat runner's fleet-wide stale-turn sweep (wired
   * via `heartbeatRunner.setStaleTurnReleaseCallback` in the daemon) AFTER
   * it force-releases a wedged subagent turn. `postInitialMessage`'s own
   * `finally` cannot clear the indicator when the SDK turn hangs forever —
   * the `finally` never runs — so the typing loop spins indefinitely. This
   * method stops the registered loop and drops the Map entry.
   *
   * Synchronous, idempotent (`clearInterval` is idempotent; a missing
   * entry is a no-op), and self-contained — safe to call from the runner
   * sweep's guarded callback site. No-op for a non-subagent session name
   * or one whose typing loop already ended normally.
   */
  stopTypingForSession(sessionName: string): void {
    const cleanup = this.typingCleanups.get(sessionName);
    if (!cleanup) return;
    this.typingCleanups.delete(sessionName);
    try {
      cleanup();
      this.log.info(
        { sessionName },
        "stale-turn sweep — subagent typing indicator stopped",
      );
    } catch (err) {
      this.log.warn(
        { sessionName, error: (err as Error).message },
        "stale-turn sweep — typing-indicator stop threw (non-fatal)",
      );
    }
  }

  /**
   * Phase 100 follow-up — archive (and optionally lock) a Discord thread.
   * Closes operator-facing thread management gap raised 2026-04-26
   * ("the bot doesn't expose archive through any of my MCP tools").
   *
   * Behavior:
   *   - Validates the thread is a real Discord thread channel the bot
   *     can fetch (membership/permission check by Discord).
   *   - Calls thread.setArchived(true). When `lock` is true, ALSO calls
   *     thread.setLocked(true) — a locked thread cannot have new messages.
   *   - Does NOT touch the bindings registry — the binding (if any)
   *     persists so the operator can audit "this thread was driven by
   *     subagent X". cleanupSubagentThread is the path that removes
   *     bindings, and it runs independently on session-end.
   *
   * Errors:
   *   - throws ManagerError when the channel can't be fetched or isn't
   *     a thread (passing a regular channel ID would be a programming
   *     error worth surfacing loudly).
   *   - propagates discord.js permission errors verbatim (operator may
   *     need to grant MANAGE_THREADS to the bot role).
   */
  async archiveThread(threadId: string, opts?: { readonly lock?: boolean }): Promise<{ readonly bindingPruned: boolean }> {
    const channel = await this.discordClient.channels.fetch(threadId);
    if (!channel) {
      throw new ManagerError(`Thread '${threadId}' not found`);
    }
    if (!("setArchived" in channel) || typeof (channel as { setArchived?: unknown }).setArchived !== "function") {
      throw new ManagerError(`Channel '${threadId}' is not a thread (no setArchived method)`);
    }
    const thread = channel as unknown as {
      setArchived(archived: boolean, reason?: string): Promise<unknown>;
      setLocked(locked: boolean, reason?: string): Promise<unknown>;
      name?: string;
    };
    if (opts?.lock === true) {
      await thread.setLocked(true, "archived via clawcode archive_thread");
    }
    await thread.setArchived(true, "archived via clawcode archive_thread");
    // Phase 100 follow-up — auto-prune the registry binding (if any) so the
    // maxThreadSessions accounting reflects reality. Without this, fin-client
    // hit the cap-3 limit even after archiving threads (operator surfaced
    // 2026-04-26). Mirror cleanupSubagentThread's pattern but DON'T stop the
    // session — that's a separate concern (the session may already be gone).
    // 999.65 — atomic read-modify-write: the existence check + removal
    // run inside one critical section so the prune is not interleaved.
    let bindingPruned = false;
    await mutateThreadRegistry(this.registryPath, (current) => {
      const binding = getBindingForThread(current, threadId);
      if (!binding) {
        return current;
      }
      bindingPruned = true;
      return removeBinding(current, threadId);
    });
    this.log.info(
      { threadId, threadName: thread.name, locked: opts?.lock === true, bindingPruned },
      "discord thread archived",
    );
    return { bindingPruned };
  }
}
