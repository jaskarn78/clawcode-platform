import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";
import type { SessionManager } from "../manager/session-manager.js";
import type { Registry } from "../manager/types.js";
import type { ResolvedAgentConfig } from "../shared/types.js";
import type { ThreadManager } from "../discord/thread-manager.js";
import type { TaskStore } from "../tasks/store.js";
import type { SecretsResolver } from "../manager/secrets-resolver.js";
import type { BrokerStatusProvider } from "./checks/mcp-broker.js";
import type { InboxMessage } from "../collaboration/types.js";
import type {
  CheckModule,
  CheckContext,
  CheckResult,
  HeartbeatConfig,
  HeartbeatLogEntry,
} from "./types.js";
import { discoverChecks } from "./discovery.js";
import {
  SWEEP_DETACH_TIMEOUT_MS,
  resolveForceReleaseThresholdMs,
} from "./stale-turn-thresholds.js";
import {
  ContextZoneTracker,
  DEFAULT_ZONE_THRESHOLDS,
} from "./context-zones.js";
import { HeartbeatTransitionJournal } from "./transition-journal.js";
import type {
  ContextZone,
  ZoneTransition,
  ZoneThresholds,
  SnapshotCallback,
} from "./context-zones.js";

/**
 * Callback invoked on any zone transition (for Discord notifications etc.).
 */
export type ZoneNotificationCallback = (
  agentName: string,
  transition: ZoneTransition,
) => Promise<void>;

/**
 * Options for creating a HeartbeatRunner.
 */
export type HeartbeatRunnerOptions = {
  readonly sessionManager: SessionManager;
  readonly registryPath: string;
  readonly config: HeartbeatConfig;
  readonly checksDir: string;
  readonly log: Logger;
  readonly snapshotCallback?: SnapshotCallback;
  readonly notificationCallback?: ZoneNotificationCallback;
  /**
   * Phase 999.122 — status-transition journal. The daemon passes one
   * backed by `~/.clawcode/manager/heartbeat-transitions.jsonl`; when
   * omitted an in-memory journal is used (legacy boot paths / tests).
   */
  readonly transitionJournal?: HeartbeatTransitionJournal;
};

/**
 * HeartbeatRunner executes discovered health checks sequentially
 * at a configurable interval for each running agent.
 *
 * Results are stored in memory and logged to NDJSON files per agent workspace.
 */
export class HeartbeatRunner {
  private readonly sessionManager: SessionManager;
  private readonly registryPath: string;
  private readonly config: HeartbeatConfig;
  private readonly checksDir: string;
  private readonly log: Logger;
  private readonly snapshotCallback?: SnapshotCallback;
  private readonly notificationCallback?: ZoneNotificationCallback;
  private readonly transitionJournal: HeartbeatTransitionJournal;

  private checks: readonly CheckModule[] = [];
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private readonly lastRun: Map<string, number> = new Map();
  private readonly latestResults: Map<
    string,
    Map<string, { result: CheckResult; lastChecked: string }>
  > = new Map();
  private readonly agentConfigs: Map<string, ResolvedAgentConfig> = new Map();
  private readonly zoneTrackers: Map<string, ContextZoneTracker> = new Map();
  private threadManager: ThreadManager | undefined;
  private taskStore: TaskStore | undefined;
  // Phase 104 plan 03 (SEC-05) — passed into CheckContext so mcp-reconnect's
  // RecoveryDeps factory can wire `invalidate: (ref) => secretsResolver.invalidate(ref)`.
  private secretsResolver: SecretsResolver | undefined;
  // Phase 108 (POOL-07) — daemon-side adapter exposing
  // broker.getPoolStatus() to the mcp-broker check. Threaded into
  // CheckContext per-tick. Setter wired in daemon.ts after broker
  // construction, mirroring setSecretsResolver / setThreadManager /
  // setTaskStore.
  private brokerStatusProvider: BrokerStatusProvider | undefined;
  // Phase 124 Plan 04 T-02 — auto-trigger closure threaded into the
  // context-fill check via CheckContext. Daemon wires this to a
  // handleCompactSession-bound closure; fire-and-forget on the check
  // side so the heartbeat tick never blocks on compaction.
  private compactSessionTrigger: ((agent: string) => Promise<void>) | undefined;
  // Phase 124 Plan 04 T-02 — last-compaction lookup for the auto-trigger
  // cooldown gate. Reads from the same `CompactionEventLog` the
  // `heartbeat-status` IPC surfaces, so manual + auto paths share one
  // cooldown view.
  private getLastCompactionAt: ((agent: string) => string | null) | undefined;
  // Quick 260520-r70 — shared agent-to-agent ack-emitter threaded into
  // the inbox reconciler check via CheckContext. The daemon constructs
  // ONE emitter and passes the SAME instance here and to InboxSource so
  // both inbox consumers fire the ack from a single hook (no
  // bifurcation). Fire-and-forget on the check side.
  private inboxAckEmitter:
    | ((consumed: InboxMessage, consumerAgent: string) => Promise<void>)
    | undefined;
  /**
   * Phase 999.117 WS-2 — the SHARED cross-path delivery dedupe. Same instance
   * InboxSource and the Discord webhook relay hold, so whichever consumer
   * reaches a message first owns the turn.
   */
  private deliveryDedupe:
    | { claim(deliveryId: string | undefined): boolean }
    | undefined;
  // Phase 125 Plan 01 — active-state header provider. The daemon wires a
  // closure that builds the per-agent ActiveStateBlock, persists it to
  // ~/.clawcode/agents/<agent>/state/active-state.yaml, and returns the
  // rendered text. Runner calls this once per tick per agent BEFORE
  // executing checks; the rendered string is stashed in `lastProbeText`
  // so future probe-text dispatch (deferred to a later phase) can prepend
  // it. Errors are swallowed at the call site (warn-logged) so a builder
  // failure never blocks the tick.
  private activeStateProvider:
    | ((agent: string) => Promise<string | null>)
    | undefined;
  private readonly lastProbeText: Map<string, string> = new Map();
  // Debug session `stale-turn-watchdog-miss` (999.64 RECURRENCE) — optional
  // hook invoked by the fleet-wide stale-turn sweep AFTER a successful
  // `forceReleaseTurn`. The daemon wires this to SubagentThreadSpawner's
  // typing-loop cleanup so a force-released subagent turn also clears its
  // stuck Discord typing indicator (gap #3 — the typing loop is a separate
  // lifecycle from the turn lock; `postInitialMessage`'s `finally` never
  // runs when the SDK turn hangs forever). The runner stays Discord-
  // agnostic — it only knows "release happened, run the cleanup for this
  // session name". No-op when unset (legacy boot paths / tests).
  private staleTurnReleaseCallback:
    | ((sessionName: string) => void)
    | undefined;

  // 999.109 (INC-2026-08-18) — sessions whose timeouts another component
  // owns are skipped by the stale-turn sweep. Unset ⇒ nothing is exempt.
  private sweepExemptionProbe:
    | ((sessionName: string) => boolean)
    | undefined;

  constructor(options: HeartbeatRunnerOptions) {
    this.sessionManager = options.sessionManager;
    this.registryPath = options.registryPath;
    this.config = options.config;
    this.checksDir = options.checksDir;
    this.log = options.log;
    this.snapshotCallback = options.snapshotCallback;
    this.notificationCallback = options.notificationCallback;
    this.transitionJournal = options.transitionJournal ?? new HeartbeatTransitionJournal();
  }

  /** Phase 999.122 — the status-transition journal (read by `heartbeat-status`). */
  getTransitionJournal(): HeartbeatTransitionJournal {
    return this.transitionJournal;
  }

  /**
   * Discover and load check modules from the checks directory.
   *
   * Phase 999.8 Plan 03 — discovery is now a static registry (see
   * check-registry.ts). The boot log surfaces both the count AND the
   * registered names so production journalctl gives operators an unambiguous
   * read of which checks are alive after a restart. The message string
   * changes from "discovered" → "registered" to make the new shape easy to
   * grep against the prior (broken) deployment's log lines.
   */
  async initialize(): Promise<void> {
    this.checks = await discoverChecks(this.checksDir);
    this.log.info(
      {
        checkCount: this.checks.length,
        checks: this.checks.map((c) => c.name),
      },
      "heartbeat checks registered",
    );
  }

  /**
   * Set agent configurations for workspace path lookup during logging.
   */
  setAgentConfigs(configs: readonly ResolvedAgentConfig[]): void {
    for (const config of configs) {
      this.agentConfigs.set(config.name, config);
    }
  }

  /**
   * Set the ThreadManager reference for thread-idle check context injection.
   */
  setThreadManager(tm: ThreadManager): void {
    this.threadManager = tm;
  }

  /**
   * Set the TaskStore reference for task-retention check context injection.
   * Phase 60 Plan 03 — mirrors the setThreadManager pattern.
   */
  setTaskStore(store: TaskStore): void {
    this.taskStore = store;
  }

  /**
   * Phase 104 plan 03 (SEC-05) — inject the SecretsResolver into
   * CheckContext so the op-refresh recovery handler can call
   * deps.invalidate(ref) before re-reading via op CLI. Mirrors the
   * setThreadManager / setTaskStore pattern.
   */
  setSecretsResolver(resolver: SecretsResolver): void {
    this.secretsResolver = resolver;
  }

  /**
   * Phase 108 (POOL-07) — inject the BrokerStatusProvider so the
   * `mcp-broker` heartbeat check can poll pool liveness without holding
   * a direct reference to the broker (keeps the check decoupled from
   * the broker module's lifecycle). Mirrors the setSecretsResolver /
   * setThreadManager / setTaskStore setter pattern.
   */
  setBrokerStatusProvider(provider: BrokerStatusProvider): void {
    this.brokerStatusProvider = provider;
  }

  /**
   * Phase 124 Plan 04 T-02 — wire the auto-trigger closure. The context-
   * fill check fires this (fire-and-forget) when an agent's resolved
   * `autoCompactAt` ratio is crossed and the 5-min cooldown has elapsed.
   * Mirrors the setSecretsResolver / setBrokerStatusProvider pattern.
   */
  setCompactSessionTrigger(fn: (agent: string) => Promise<void>): void {
    this.compactSessionTrigger = fn;
  }

  /**
   * Phase 124 Plan 04 T-02 — wire the last-compaction lookup so the
   * context-fill check can enforce the cooldown gate without holding a
   * direct reference to the CompactionEventLog module.
   */
  setGetLastCompactionAt(fn: (agent: string) => string | null): void {
    this.getLastCompactionAt = fn;
  }

  /**
   * Quick 260520-r70 — wire the shared agent-to-agent ack-emitter so the
   * inbox reconciler check can emit acks for cross-agent messages it
   * delivers. The daemon passes the SAME emitter instance to InboxSource,
   * guaranteeing both inbox consumers fire the ack from one hook point.
   * Mirrors the setCompactSessionTrigger / setGetLastCompactionAt pattern.
   */
  setInboxAckEmitter(
    fn: (consumed: InboxMessage, consumerAgent: string) => Promise<void>,
  ): void {
    this.inboxAckEmitter = fn;
  }

  /**
   * Phase 999.117 WS-2 — wire the SHARED cross-path delivery dedupe. Unset
   * (legacy/test boot) → no dedupe, behaviour unchanged.
   */
  setDeliveryDedupe(dedupe: {
    claim(deliveryId: string | undefined): boolean;
  }): void {
    this.deliveryDedupe = dedupe;
  }

  /**
   * Phase 125 Plan 01 — wire the active-state builder/writer closure.
   * Mirrors setCompactSessionTrigger pattern. No-op (back-compat) when
   * unset, so legacy boot paths and tests keep working.
   */
  setActiveStateProvider(
    fn: (agent: string) => Promise<string | null>,
  ): void {
    this.activeStateProvider = fn;
  }

  /**
   * Phase 125 Plan 01 — accessor for tests + future probe-text dispatch
   * (deferred to a later phase). Returns the latest rendered active-state
   * header for `agent`, or undefined if no provider has run for them yet.
   */
  getLastProbeText(agentName: string): string | undefined {
    return this.lastProbeText.get(agentName);
  }

  /**
   * Debug session `stale-turn-watchdog-miss` (999.64 RECURRENCE) — wire the
   * post-force-release cleanup hook. Invoked by `sweepStaleTurns()` after a
   * stale turn is force-released, so a wedged subagent's stuck Discord
   * typing indicator is also cleared. The daemon binds this to
   * `SubagentThreadSpawner.stopTypingForSession`. Mirrors the
   * `setActiveStateProvider` / `setThreadManager` setter pattern; keeps the
   * runner free of any Discord dependency.
   */
  setStaleTurnReleaseCallback(fn: (sessionName: string) => void): void {
    this.staleTurnReleaseCallback = fn;
  }

  /**
   * 999.109 (INC-2026-08-18) — register a predicate that exempts a session
   * from the stale-turn sweep because another component owns its timeouts.
   *
   * Production binds this to the workflow orchestrator's
   * `isLiveWorkerSession`: its workers legitimately run far past the sweep's
   * 5-minute interactive threshold and carry their own layered bounds
   * (per-worker wall clock, in-turn stall tracker, 45-min workflow stall
   * recovery). Without the exemption the sweep force-released three
   * fin-client workflows outright.
   *
   * Deliberately a PREDICATE over live ownership, not a name pattern:
   * subagent threads share the `-sub-` shape and MUST remain sweepable
   * (999.64 — they are the class the sweep exists for). Unset ⇒ nothing is
   * exempt (pre-999.109 behaviour).
   */
  setSweepExemptionProbe(fn: (sessionName: string) => boolean): void {
    this.sweepExemptionProbe = fn;
  }

  /**
   * Debug session `stale-turn-watchdog-miss` (999.64 RECURRENCE) —
   * fleet-wide stale-turn sweep.
   *
   * **Why this exists:** the original quick-260521-4sa watchdog lives
   * INSIDE the heartbeat `inbox` check. Phase 999.57 registers every
   * subagent session's config with `heartbeat.enabled: false`, so the
   * per-agent gate in `tick()` skips the WHOLE agent — including the
   * `inbox` check — for subagent threads. The 4sa watchdog therefore
   * could never fire for a subagent, the exact session class that wedges
   * (both 2026-05-21 fin-client recurrences were subagent threads).
   *
   * This sweep runs for EVERY running session — top-level agents AND
   * subagent threads — and runs in `tick()` BEFORE the heartbeat-disabled
   * gate, so a `heartbeat.enabled: false` subagent is still swept.
   *
   * Deliberately NARROW: it makes only the three turn-lifecycle calls
   * (`hasActiveTurn` → activity-age → `forceReleaseTurn`). It does NOT
   * execute check modules and does NOT read any agent's `memoryPath`, so
   * it cannot reintroduce the parent-memory leak the 999.57 heartbeat
   * gate was added to prevent. `forceReleaseTurn()` is fully synchronous
   * (fire-and-forget `interrupt()` + an in-memory identity-checked slot
   * clear — see persistent-session-handle.ts), so the sweep never blocks
   * the tick even when the SDK process is wedged.
   */
  private async sweepStaleTurns(
    agentNames: readonly string[],
  ): Promise<void> {
    // Defensive: the sweep relies on SessionManager turn-lifecycle methods.
    // Legacy boot paths and partial test stubs may not implement them —
    // duck-type once up front and skip the whole sweep rather than throw
    // mid-tick (the sweep is a safety net; a missing method must degrade
    // gracefully, never break the heartbeat tick).
    //
    // Debug session `in-tool-wedge-recovery` work-stream (C), FORK 8 —
    // `backgroundOrReleaseStaleTurn` is the NEW preferred recovery: it
    // cleanly DETACHES a wedged Bash/Task tool (the turn resumes) instead
    // of bluntly force-releasing + aborting. It is OPTIONAL in the
    // duck-type: a SessionManager that predates it falls back to the
    // legacy `forceReleaseTurn` path, so the 999.64 sweep is unchanged on
    // old builds.
    const sm = this.sessionManager as unknown as {
      hasActiveTurn?: (n: string) => boolean;
      getLastTurnActivityAt?: (n: string) => number | null;
      getTurnStartedAt?: (n: string) => number | null;
      forceReleaseTurn?: (n: string) => boolean;
      backgroundOrReleaseStaleTurn?: (
        n: string,
      ) => Promise<"detached" | "released" | "no-turn">;
      // 999.99 review — orphan-turn probe (attributed-stream sessions only).
      // Optional in the duck-type: absent on legacy builds → sweep unchanged.
      isOrphanTurnOpen?: (n: string) => boolean;
      // Phase 999.114 — resolved per-agent config, read ONLY for
      // `streamStallTimeoutMs` so the force-release stays strictly above that
      // agent's own stall abort. Optional in the duck-type: absent → the
      // sweep falls back to the 300s baseline (pre-999.114 behavior).
      getAgentConfig?: (n: string) => { streamStallTimeoutMs?: number } | undefined;
    };
    if (
      typeof sm.hasActiveTurn !== "function" ||
      typeof sm.getLastTurnActivityAt !== "function" ||
      typeof sm.getTurnStartedAt !== "function" ||
      typeof sm.forceReleaseTurn !== "function"
    ) {
      return;
    }

    const now = Date.now();
    for (const name of agentNames) {
      if (!sm.hasActiveTurn(name)) continue;

      // Prefer per-message activity age; fall back to turn-start for legacy
      // handles or a turn that produced zero messages. Both null → cannot
      // measure → treat as fresh (never risk a false force-release).
      const lastActivityAt =
        sm.getLastTurnActivityAt(name) ?? sm.getTurnStartedAt(name);
      if (lastActivityAt === null) continue;

      const staleMs = now - lastActivityAt;
      // Phase 999.114 — per-agent threshold, not the bare 300s constant. The
      // stream-stall abort is per-agent configurable (and now carries a
      // per-family floor — fable is 600s), so a fixed 300s sweep would fire
      // FIRST for any agent tuned above it and pre-empt the clean abort path
      // with a blunt force-release. Fail-safe: a throwing/absent accessor
      // degrades to the baseline, i.e. exactly the old behavior.
      let agentStallTimeoutMs: number | undefined;
      try {
        agentStallTimeoutMs = sm.getAgentConfig?.(name)?.streamStallTimeoutMs;
      } catch {
        agentStallTimeoutMs = undefined;
      }
      const forceReleaseThresholdMs =
        resolveForceReleaseThresholdMs(agentStallTimeoutMs);
      if (staleMs <= forceReleaseThresholdMs) continue;

      // 999.109 (INC-2026-08-18) — skip sessions another component owns the
      // timeouts for. Workflow workers routinely run 10-30 min per research
      // step; this sweep's threshold is calibrated for INTERACTIVE channel
      // turns, and force-releasing a healthy worker aborts its whole
      // workflow (three fin-client workflows lost this way). The probe
      // is evaluated per tick against LIVE ownership, so a worker becomes
      // sweepable again the instant it settles. Fail-safe: a throwing probe
      // degrades to "not exempt" (sweep as before).
      let sweepExempt = false;
      try {
        sweepExempt = this.sweepExemptionProbe?.(name) === true;
      } catch {
        sweepExempt = false;
      }
      if (sweepExempt) {
        this.log.info(
          { agent: name, staleMs },
          "stale-turn sweep skipped — session owned by the workflow orchestrator (its own wall-clock/stall bounds apply)",
        );
        continue;
      }

      // 999.99 review — a daemon turn waiting behind a streaming self-fired
      // (orphan) turn shows no activity of its own during the foreign
      // turn's silent tool runs; force-releasing it would land the
      // interrupt on the HEALTHY foreign turn and abort a legitimate
      // background task mid-tool. Skip while the orphan turn is open — the
      // sweep re-evaluates next tick once it closes (frames flowing at
      // close refresh lastTurnActivityAt via the demux onActivity hook).
      if (
        typeof sm.isOrphanTurnOpen === "function" &&
        sm.isOrphanTurnOpen(name)
      ) {
        this.log.info(
          { agent: name, staleMs },
          "stale-turn sweep deferred — a self-fired (orphan) turn is streaming; the waiting daemon turn is healthy",
        );
        continue;
      }

      const priorTurnStartedAt = sm.getTurnStartedAt(name);

      // FORK 8 — attempt the clean detach-or-release. Bounded by a 2s race
      // so an async `backgroundTasks` call against a sick SDK can never
      // block the heartbeat tick or starve the other agents in this loop.
      // The whole per-agent attempt is try/caught so one bad agent never
      // aborts the sweep for the rest. A timeout / throw degrades to the
      // legacy synchronous `forceReleaseTurn` for THIS agent.
      let outcome: "detached" | "released" | "no-turn" = "no-turn";
      if (typeof sm.backgroundOrReleaseStaleTurn === "function") {
        try {
          outcome = await Promise.race([
            sm.backgroundOrReleaseStaleTurn(name),
            new Promise<"released">((resolve) =>
              setTimeout(
                () => resolve("released"),
                SWEEP_DETACH_TIMEOUT_MS,
              ),
            ),
          ]);
        } catch (err) {
          this.log.warn(
            { agent: name, error: (err as Error).message },
            "stale-turn sweep detach-or-release threw — falling back to force-release",
          );
          outcome = sm.forceReleaseTurn(name) ? "released" : "no-turn";
        }
      } else {
        // Legacy SessionManager — the FORK 8 method is absent. Use the
        // original synchronous force-release path unchanged.
        outcome = sm.forceReleaseTurn(name) ? "released" : "no-turn";
      }

      if (outcome === "no-turn") continue;

      if (outcome === "detached") {
        // FORK 8 clean path — the wedged Bash/Task tool was detached and
        // the turn RESUMED. No abort, no lost request, no typing-indicator
        // cleanup needed (the turn is still live and will close normally).
        // Distinct grep anchor so operators can tell the clean detach from
        // the blunt force-release in journalctl.
        console.warn(
          "phase999.64-stale-turn-sweep-background-detach",
          JSON.stringify({
            agent: name,
            priorTurnStartedAt,
            staleMs,
            // Phase 999.114 — the threshold ACTUALLY applied for this
            // agent, not the baseline constant. Logging the constant here
            // would misreport every fable/tuned agent by 6 minutes.
            forceReleaseThresholdMs,
          }),
        );
        this.log.warn(
          { agent: name, priorTurnStartedAt, staleMs },
          "heartbeat stale-turn sweep cleanly detached a wedged Bash/Task tool — turn resumed",
        );
        // Do NOT fire the typing-indicator cleanup callback — the turn is
        // still alive; clearing the indicator now would be wrong.
        continue;
      }

      // outcome === "released" — the blunt force-release path fired (an
      // MCP-tool wedge / mixed batch / nothing-detached / detach timeout).
      // Forensic line — same structured-log idiom as the 4sa inbox-check
      // watchdog, with a distinct label so journalctl greps can tell the
      // fleet-wide sweep apart from the inbox-check force-release.
      console.warn(
        "phase999.64-stale-turn-sweep-force-release",
        JSON.stringify({
          agent: name,
          priorTurnStartedAt,
          staleMs,
          // Phase 999.114 — the threshold ACTUALLY applied (see above).
          forceReleaseThresholdMs,
        }),
      );
      this.log.warn(
        { agent: name, priorTurnStartedAt, staleMs },
        "heartbeat stale-turn sweep force-released a wedged turn",
      );

      // Gap #3 — clear the stuck Discord typing indicator. The turn lock
      // and the subagent typing loop are independent lifecycles; releasing
      // the lock alone leaves the indicator spinning forever. Guarded so a
      // throwing callback can never abort the sweep for other sessions.
      // Only the FORCE-RELEASE path needs this — the detach path leaves the
      // turn alive, so its indicator must keep spinning.
      if (this.staleTurnReleaseCallback) {
        try {
          this.staleTurnReleaseCallback(name);
        } catch (err) {
          this.log.warn(
            { agent: name, error: (err as Error).message },
            "stale-turn release callback threw (non-fatal)",
          );
        }
      }
    }
  }

  /**
   * Start the heartbeat interval timer.
   */
  start(): void {
    if (this.intervalId !== null) {
      return;
    }
    this.intervalId = setInterval(
      () => void this.tick(),
      this.config.intervalSeconds * 1000,
    );
  }

  /**
   * Stop the heartbeat interval timer.
   */
  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Execute one tick: run all checks for all running agents sequentially.
   */
  async tick(): Promise<void> {
    const agentNames = this.sessionManager.getRunningAgents();

    // Debug session `stale-turn-watchdog-miss` (999.64 RECURRENCE) — run
    // the fleet-wide stale-turn sweep FIRST, for ALL running sessions,
    // BEFORE the per-agent `heartbeat.enabled === false` gate below. This
    // is the load-bearing ordering: a subagent thread session carries
    // `heartbeat.enabled: false` (Phase 999.57), so it is skipped by the
    // gate inside the check loop — the sweep here is the only path that
    // sweeps it. Narrow (see sweepStaleTurns docblock).
    //
    // FIRE-AND-FORGET (not awaited): FORK 8's clean-detach path makes the
    // sweep async (`Query.backgroundTasks` is a Promise). The sweep is NOT
    // awaited here — awaiting it would serialize it ahead of the check
    // loop and shift the tick's timing relative to every other check.
    // Each per-agent attempt is already bounded by SWEEP_DETACH_TIMEOUT_MS
    // and fully try/caught, so the detached promise can neither hang nor
    // throw into the tick. A rejection is defensively swallowed so an
    // unhandled-rejection can never escape. This preserves the original
    // (pre-FORK-8) behaviour where the sweep never blocked the tick.
    void this.sweepStaleTurns(agentNames).catch((err) => {
      this.log.warn(
        { error: (err as Error).message },
        "stale-turn sweep threw (non-fatal — sweep is fire-and-forget)",
      );
    });

    // Cleanup zone trackers for agents no longer running
    const runningSet = new Set(agentNames);
    for (const [name, tracker] of this.zoneTrackers) {
      if (!runningSet.has(name)) {
        tracker.reset();
        this.zoneTrackers.delete(name);
      }
    }

    // Build a minimal registry for context (read-only snapshot)
    const registry: Registry = {
      entries: [],
      updatedAt: Date.now(),
    };

    for (const agentName of agentNames) {
      // Skip agents with heartbeat disabled (D-13)
      const agentConfig = this.agentConfigs.get(agentName);
      if (agentConfig && agentConfig.heartbeat.enabled === false) {
        continue;
      }

      // Phase 125 Plan 01 — build + persist the active-state header
      // BEFORE the check loop. Errors are warn-logged but never thrown:
      // the heartbeat tick must not block on active-state builder failure.
      if (this.activeStateProvider) {
        try {
          const rendered = await this.activeStateProvider(agentName);
          if (typeof rendered === "string" && rendered.length > 0) {
            const wrapped = `--- ACTIVE STATE ---\n${rendered}\n--- end ---`;
            this.lastProbeText.set(agentName, wrapped);
          }
        } catch (err) {
          this.log.warn(
            { agent: agentName, error: (err as Error).message },
            "active-state provider failed",
          );
        }
      }

      if (!this.latestResults.has(agentName)) {
        this.latestResults.set(agentName, new Map());
      }
      const agentResults = this.latestResults.get(agentName)!;

      for (const check of this.checks) {
        // Check per-check interval override
        const effectiveIntervalMs =
          (check.interval ?? this.config.intervalSeconds) * 1000;
        const runKey = `${agentName}:${check.name}`;
        const lastRunTime = this.lastRun.get(runKey) ?? 0;
        const now = Date.now();

        if (now - lastRunTime < effectiveIntervalMs) {
          continue; // Not due yet
        }

        const context: CheckContext = {
          agentName,
          sessionManager: this.sessionManager,
          registry,
          config: this.config,
          ...(this.threadManager ? { threadManager: this.threadManager } : {}),
          ...(this.taskStore ? { taskStore: this.taskStore } : {}),
          ...(this.secretsResolver ? { secretsResolver: this.secretsResolver } : {}),
          ...(this.brokerStatusProvider
            ? { brokerStatusProvider: this.brokerStatusProvider }
            : {}),
          // Phase 124 Plan 04 T-02 — auto-trigger wiring threaded
          // conditionally so legacy boot paths (and tests) that do not
          // call the new setters keep a CheckContext that exactly
          // matches the pre-Plan-04 shape.
          ...(this.compactSessionTrigger
            ? { compactSessionTrigger: this.compactSessionTrigger }
            : {}),
          ...(this.getLastCompactionAt
            ? { getLastCompactionAt: this.getLastCompactionAt }
            : {}),
          // Quick 260520-r70 — ack-emitter wiring threaded conditionally
          // so legacy boot paths (and tests) that never call the setter
          // keep a CheckContext that exactly matches the prior shape.
          ...(this.inboxAckEmitter
            ? { inboxAckEmitter: this.inboxAckEmitter }
            : {}),
          // Phase 999.117 WS-2 — same conditional-spread idiom so a boot path
          // that never calls the setter keeps a byte-identical context shape.
          ...(this.deliveryDedupe
            ? { deliveryDedupe: this.deliveryDedupe }
            : {}),
        };

        // Phase 999.12 HB-01 — special-case the inbox check timeout. Cross-
        // agent turns commonly take 30-90s; the fleet-wide checkTimeoutSeconds
        // (default 10s) creates false-positive critical alerts on the inbox
        // check. inboxTimeoutMs (default 60_000 from schema) overrides ONLY
        // the inbox check; other checks keep the fleet-wide timeout.
        const timeoutMs =
          check.name === "inbox" && this.config.inboxTimeoutMs !== undefined
            ? this.config.inboxTimeoutMs
            : (check.timeout ?? this.config.checkTimeoutSeconds) * 1000;
        const result = await this.executeWithTimeout(check, context, timeoutMs);
        const timestamp = new Date().toISOString();

        const previousStatus = agentResults.get(check.name)?.result.status;
        agentResults.set(check.name, { result, lastChecked: timestamp });
        this.lastRun.set(runKey, now);

        // Phase 999.122 — journal the status CHANGE (not every tick) and
        // log warnings once per transition, rate-limited per check, so a
        // warning that fires overnight is visible in both the daemon
        // journal and `/api/health` `incidents` the next morning.
        const transition = this.transitionJournal.record(
          agentName,
          check.name,
          previousStatus,
          result,
          timestamp,
        );
        if (transition && transition.to === "warning") {
          if (this.transitionJournal.shouldLog(agentName, check.name, now)) {
            this.log.warn(
              { agent: agentName, check: check.name, from: transition.from, message: result.message },
              "heartbeat check warning",
            );
          }
        } else if (transition && transition.to === "healthy") {
          this.log.info(
            { agent: agentName, check: check.name, from: transition.from },
            "heartbeat check recovered",
          );
        }

        // Log to NDJSON file
        // Phase 75 SHARED-01 — memoryPath (not workspace) so shared-workspace
        // agents write heartbeat.log into their private per-agent memory dir.
        if (agentConfig) {
          this.logResult(agentConfig.memoryPath, agentName, check.name, result, timestamp);
        }

        // Critical results logged at warn level
        if (result.status === "critical") {
          this.log.warn(
            { agent: agentName, check: check.name, message: result.message },
            "heartbeat check critical",
          );
        }

        // Zone tracking: update zone tracker if fill percentage is present in metadata
        if (check.name === "context-fill" && result.metadata && typeof result.metadata.fillPercentage === "number") {
          await this.updateZoneTracker(agentName, result.metadata.fillPercentage as number, agentConfig);
        }
      }
    }
  }

  /**
   * Update the zone tracker for an agent with a new fill percentage.
   * Creates tracker lazily if needed. Logs transitions and fires callbacks.
   */
  private async updateZoneTracker(
    agentName: string,
    fillPercentage: number,
    agentConfig: ResolvedAgentConfig | undefined,
  ): Promise<void> {
    // Get or create zone tracker
    if (!this.zoneTrackers.has(agentName)) {
      const thresholds: ZoneThresholds =
        agentConfig?.heartbeat?.contextFill?.zoneThresholds ?? DEFAULT_ZONE_THRESHOLDS;
      const tracker = new ContextZoneTracker({
        agentName,
        thresholds,
        onSnapshot: this.snapshotCallback,
      });
      this.zoneTrackers.set(agentName, tracker);
    }

    const tracker = this.zoneTrackers.get(agentName)!;
    const transition = await tracker.update(fillPercentage);

    if (transition) {
      this.log.info(
        {
          agent: agentName,
          from: transition.from,
          to: transition.to,
          fillPercentage: transition.fillPercentage,
        },
        "context zone transition",
      );

      // Fire notification callback (fire-and-forget)
      if (this.notificationCallback) {
        this.notificationCallback(agentName, transition).catch((err) => {
          this.log.warn(
            { agent: agentName, error: (err as Error).message },
            "zone notification callback failed",
          );
        });
      }
    }
  }

  /**
   * Get the latest results for all agents and checks.
   */
  getLatestResults(): ReadonlyMap<
    string,
    ReadonlyMap<string, { result: CheckResult; lastChecked: string }>
  > {
    return this.latestResults;
  }

  /**
   * Get current zone statuses for all tracked agents.
   * Returns zone and last known fill percentage from latest results.
   */
  getZoneStatuses(): ReadonlyMap<string, { zone: ContextZone; fillPercentage: number }> {
    const result = new Map<string, { zone: ContextZone; fillPercentage: number }>();
    for (const [name, tracker] of this.zoneTrackers) {
      // Extract last known fill percentage from latest results metadata
      let fillPercentage = 0;
      const agentResults = this.latestResults.get(name);
      if (agentResults) {
        const fillResult = agentResults.get("context-fill");
        if (fillResult?.result.metadata && typeof fillResult.result.metadata.fillPercentage === "number") {
          fillPercentage = fillResult.result.metadata.fillPercentage as number;
        }
      }
      result.set(name, { zone: tracker.zone, fillPercentage });
    }
    return result;
  }

  /**
   * Execute a check with a timeout. If the check exceeds the timeout,
   * a critical result is returned.
   */
  private async executeWithTimeout(
    check: CheckModule,
    context: CheckContext,
    timeoutMs: number,
  ): Promise<CheckResult> {
    return Promise.race([
      check.execute(context),
      new Promise<CheckResult>((resolve) => {
        setTimeout(() => {
          resolve({
            status: "critical",
            message: `Check '${check.name}' timed out after ${timeoutMs}ms`,
          });
        }, timeoutMs);
      }),
    ]);
  }

  /**
   * Log a check result to the agent's NDJSON heartbeat.log file.
   * Creates the memory directory defensively.
   *
   * Phase 75 SHARED-01 — takes memoryPath (not workspace) so shared-workspace
   * agents get isolated heartbeat.log files in their private memory dirs.
   */
  private logResult(
    memoryPath: string,
    agentName: string,
    checkName: string,
    result: CheckResult,
    timestamp: string,
  ): void {
    const memoryDir = join(memoryPath, "memory");
    try {
      mkdirSync(memoryDir, { recursive: true });
    } catch {
      // Directory may already exist
    }

    const entry: HeartbeatLogEntry = {
      timestamp,
      agent: agentName,
      check: checkName,
      status: result.status,
      message: result.message,
      ...(result.metadata ? { metadata: { ...result.metadata } } : {}),
    };

    const logPath = join(memoryDir, "heartbeat.log");
    appendFileSync(logPath, JSON.stringify(entry) + "\n");
  }
}
