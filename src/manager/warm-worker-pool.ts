/**
 * Phase 999.86 — Pre-warmed worker pool for v3 (claude-code-interactive)
 * Discord chat.
 *
 * **The problem.** `claude --dangerously-load-development-channels` does NOT
 * reliably treat `notifications/claude/channel` MCP notifications as a
 * turn-trigger for a running parent process (per channels-reference docs:
 * "events are dropped silently with no error returned to your server"). 6+
 * live attempts on the dev daemon, plus 999.82/.83/.84 canary data, show
 * the parent path is flaky in both Model A (agent-owned discord plugin)
 * and Model B (daemon-owned bot) configurations.
 *
 * **The one mechanism that works.** Phase 999.83 proved that delivering a
 * task as `firstTurnInput` PTY-text DURING the menu-dismiss transition of a
 * fresh `claude --channels` spawn reliably fires a turn. That pattern is the
 * basis of the shipped subagent dispatch fix.
 *
 * **What this module adds.** A pool of pre-spawned `claude --channels`
 * workers in `deferFirstTurn` mode — they boot to the
 * `--dangerously-load-development-channels` confirmation menu and PARK
 * there, MCP servers connected, channel listener bound, waiting. When a
 * Discord chat message arrives, `dispatch()` pops a warm worker, writes
 * `\r<message>\n` to its PTY (the single menu-dismiss + first-turn write
 * pattern 999.83 proved reliable), awaits the agent's `clawcode_ack` /
 * Stop-hook completion, and tears the worker down. A replacement is spawned
 * asynchronously so the next message lands warm.
 *
 * Common case: sub-second pop + ~3 s turn = ~3-5 s total reply latency.
 * Burst case (pool exhausted): falls through to a cold spawn for the
 * overflowing message; the user-visible typing indicator covers the
 * ~10-15 s.
 */

import { nanoid } from "nanoid";
import type { Logger } from "pino";

import type { ResolvedAgentConfig } from "../shared/types.js";
import type { ChannelSpawnSeam } from "../llm-runtime/backends/claude-code-interactive.js";
import type { SessionManager } from "./session-manager.js";
import type {
  SubagentChannelBridge,
  SubagentChannelListener,
  WiredSubagentChannelLike,
} from "../discord/subagent-thread-spawner.js";
import {
  ChannelReplyTimeoutError,
  V3_CHANNEL_REPLY_TIMEOUT_MS,
} from "./agent-channel-bridge.js";

/** Per-parent-agent config knobs. */
export interface WarmWorkerPoolAgentConfig {
  /** Parent agent name. */
  readonly name: string;
  /**
   * Number of workers to keep idle on the menu prompt. `0` disables pre-
   * warming for this agent (every dispatch cold-spawns). Default `1`.
   */
  readonly warmSize: number;
  /**
   * Hard cap on simultaneously alive workers (warm + dispatched). Defaults
   * to `warmSize + 2` so a burst of 3-4 concurrent dispatches can overlap
   * without blocking, but a runaway loop can't bloat memory.
   */
  readonly maxConcurrent?: number;
}

/** Result of a dispatch — the assistant text plus a status hint. */
export interface WarmWorkerDispatchResult {
  readonly result: string;
  /**
   * `true` when the dispatch consumed a pre-warmed worker (sub-second pop);
   * `false` when the pool was empty and the dispatch waited on a fresh
   * cold spawn. Used by telemetry / canary observation; callers should not
   * branch on it.
   */
  readonly wasWarm: boolean;
}

export interface WarmWorkerPoolDispatchOpts {
  readonly correlationId: string;
  readonly onProgress?: (accumulated: string) => void;
  /** Max time to wait for the worker's reply. Default 120 000 ms. */
  readonly timeoutMs?: number;
}

/** Dependencies the pool needs the daemon to inject. */
export interface WarmWorkerPoolDeps {
  readonly sessionManager: SessionManager;
  /**
   * Same callback `SubagentThreadSpawner` uses (`daemon.ts` ~9042). Registers
   * a per-worker `LlmRuntimeService` resolver so `startAgent` →
   * `SdkSessionAdapter` finds a runtime for the worker session name.
   */
  readonly registerLlmRuntime: (
    sessionName: string,
    workerConfig: ResolvedAgentConfig,
    parentAgentName: string,
    opts?: { firstTurnInput?: string; deferFirstTurn?: boolean },
  ) => void;
  /**
   * Wire a per-worker `daemon.sock` + `hook.sock`. The daemon injects
   * `(cfg) => agentChannelRegistry.wireForConfig(cfg)`; the registry's
   * backend gate ensures only v3-shaped configs get a socket.
   */
  readonly wireChannelForSubagent: (
    cfg: ResolvedAgentConfig,
  ) => WiredSubagentChannelLike;
  /**
   * Per-worker teardown — REQUIRED, every dispatched worker leaks two
   * socket listeners without it.
   */
  readonly unwireChannelForSubagent: (
    sessionName: string,
  ) => Promise<void> | void;
  /** Look up the PARENT agent's config (model, soul, mcpServers, …). */
  readonly getParentConfig: (
    parentName: string,
  ) => ResolvedAgentConfig | undefined;
  /**
   * The module-level supervisor registry from
   * `claude-code-interactive.ts` — keyed by session name; the pool reads
   * this AFTER `sessionManager.startAgent` resolves to get the worker's
   * PTY write seam.
   */
  readonly liveSupervisorByAgent: Map<string, ChannelSpawnSeam>;
  readonly logger: Logger;
  /**
   * Connect-wait knobs for the worker's channel-listener (mirrors the
   * spawner's connectPollMs / connectCeilingMs at
   * `subagent-thread-spawner.ts:383-384`). The default values match.
   */
  readonly connectPollMs?: number;
  readonly connectCeilingMs?: number;
  /**
   * Test seam — when supplied, the pool uses this in place of `nanoid` for
   * deterministic worker session names. Production leaves undefined.
   */
  readonly generateId?: () => string;
  /**
   * Phase 141 WS-1 (1B worker reuse). When `true`, a worker is RETURNED to the
   * warm set after its reply (keyed for reuse, capped at `warmSize`) instead of
   * being torn down — eliminating the per-message cold-start. When `false`
   * (default), the original 999.86 spawn-and-retire behavior is preserved.
   * Gated by the daemon behind the pool's `CLAWCODE_WARM_POOL` canary +
   * `CLAWCODE_WARM_POOL_REUSE` (default on). Operator chose warm-pool
   * concurrency + reuse (Phase 141 GATE-0 decision: Option A — chat-concurrency
   * with the fail-closed main-bridge backstop for control traffic).
   */
  readonly reuseWorkers?: boolean;
}

interface WorkerHandle {
  readonly sessionName: string;
  readonly parentAgent: string;
  readonly bridge: SubagentChannelBridge;
  readonly listener: SubagentChannelListener | undefined;
  readonly spawnedAt: number;
}

interface ResolvedAgentPoolConfig {
  readonly name: string;
  readonly warmSize: number;
  readonly maxConcurrent: number;
}

interface AgentPoolState {
  readonly cfg: ResolvedAgentPoolConfig;
  /** FIFO of pre-warmed worker handles whose channel `isConnected()` flipped true. */
  readonly warm: WorkerHandle[];
  /** Workers currently spawning (counted toward `maxConcurrent`). */
  spawning: number;
  /** Workers handed out to a dispatch (counted toward `maxConcurrent`). */
  inFlight: number;
}

/** Default value when an agent's config omits `pool.warm.maxConcurrent`. */
function defaultMaxConcurrent(warmSize: number): number {
  return Math.max(warmSize + 2, 3);
}

/**
 * Phase 141 WS-1 — menu-dismiss keystroke (Enter / CR), identical to the v3
 * backend's `DEFAULT_WARM_NUDGE`. Dismisses the
 * `--dangerously-load-development-channels` confirmation menu so a deferred
 * pool worker proceeds to connect its channel.
 */
const MENU_DISMISS = "\r";
/** Throttle for the menu-dismiss nudge while waiting for the channel to connect. */
const MENU_DISMISS_NUDGE_INTERVAL_MS = 1_000;

/**
 * The pool. One instance per daemon owns all v3 agents' workers.
 */
export class WarmWorkerPool {
  private readonly perAgent = new Map<string, AgentPoolState>();
  /**
   * P4 (memory program) — every session name this pool instance has spawned
   * and not yet successfully torn down. A `-pool-` session in the registry
   * that is NOT in this set was leaked (e.g. a failed stop left it running
   * after the pool dropped its handle). Names are removed ONLY after
   * `stopAgent` succeeds — a failed stop keeps the name managed, which
   * fails safe (the reaper alerts instead of double-killing).
   */
  private readonly managedNames = new Set<string>();
  private readonly connectPollMs: number;
  private readonly connectCeilingMs: number;
  private readonly generateId: () => string;
  private readonly reuseWorkers: boolean;
  private stopped = false;

  constructor(
    private readonly deps: WarmWorkerPoolDeps,
    private readonly configs: readonly WarmWorkerPoolAgentConfig[],
  ) {
    this.connectPollMs = deps.connectPollMs ?? 250;
    this.connectCeilingMs = deps.connectCeilingMs ?? 30_000;
    this.generateId = deps.generateId ?? (() => nanoid(6));
    this.reuseWorkers = deps.reuseWorkers ?? false;
    for (const cfg of configs) {
      this.perAgent.set(cfg.name, {
        cfg: {
          name: cfg.name,
          warmSize: cfg.warmSize,
          maxConcurrent:
            cfg.maxConcurrent ?? defaultMaxConcurrent(cfg.warmSize),
        },
        warm: [],
        spawning: 0,
        inFlight: 0,
      });
    }
  }

  /**
   * Per-agent capacity snapshot. Useful for tests + the daemon's
   * `/agent-pool-status` IPC if/when it lands.
   */
  size(parent: string): { warm: number; spawning: number; inFlight: number } {
    const state = this.perAgent.get(parent);
    if (!state) return { warm: 0, spawning: 0, inFlight: 0 };
    return { warm: state.warm.length, spawning: state.spawning, inFlight: state.inFlight };
  }

  /**
   * P4 — does this pool instance currently own `sessionName`? Consumed by
   * the fork/pool session scan (`scanForForkPoolSessions`): a running
   * `-pool-` session this pool doesn't own is a leak candidate.
   */
  isPoolManaged(sessionName: string): boolean {
    return this.managedNames.has(sessionName);
  }

  /**
   * P4 — per-parent structural cap for the leak scan: `maxConcurrent` for
   * pooled parents, 0 for parents this pool doesn't manage (any `-pool-`
   * session of an unpooled parent is over-cap by definition).
   */
  poolCapForParent(parent: string): number {
    const state = this.perAgent.get(parent);
    return state ? state.cfg.maxConcurrent : 0;
  }

  /**
   * Pre-spawn workers for every configured agent. Resolves once every
   * agent has at least one connected worker OR a spawn attempt rejects.
   * Logs every spawn outcome — partial successes do not crash the daemon.
   */
  async start(): Promise<void> {
    const all: Promise<unknown>[] = [];
    for (const state of this.perAgent.values()) {
      for (let i = 0; i < state.cfg.warmSize; i++) {
        all.push(
          this.spawnWorker(state.cfg.name).catch((err: unknown) => {
            this.deps.logger.warn(
              { agent: state.cfg.name, err: (err as Error)?.message },
              "phase99986-worker-spawn-failed",
            );
          }),
        );
      }
    }
    await Promise.all(all);
  }

  /**
   * Dispatch a Discord chat message to a worker.
   *
   * 1. Pop a warm worker (or spawn-and-wait if pool empty).
   * 2. Refill the pool asynchronously (best-effort).
   * 3. Deliver the message via a CHANNEL PUSH over the worker's connected
   *    clawcode-channel (`worker.bridge.push`) — the proven v3 delivery path.
   * 4. Await `bridge.awaitReply(correlationId, timeoutMs)`.
   * 5. Reuse (return to warm) or tear down the worker in `finally`.
   */
  async dispatch(
    parentAgent: string,
    userMessage: string,
    opts: WarmWorkerPoolDispatchOpts,
  ): Promise<WarmWorkerDispatchResult> {
    if (this.stopped) {
      throw new Error("WarmWorkerPool: dispatch after stop()");
    }
    const state = this.requireState(parentAgent);

    // 1. Pop a warm worker, or spawn one inline if the pool is empty.
    let worker: WorkerHandle;
    let wasWarm: boolean;
    const head = state.warm.shift();
    if (head) {
      worker = head;
      wasWarm = true;
    } else {
      // Respect `maxConcurrent` on the hot path too — `maybeRefill` only gates
      // the refill spawn, so without this a burst of concurrent empty-pool
      // dispatches would cold-spawn workers without any ceiling (the runaway/
      // burst guard the cap exists for). Hard ceiling by design; excess surfaces
      // as a visible error (→ Discord ❌, retryable) rather than silent bloat.
      const live = state.warm.length + state.spawning + state.inFlight;
      if (live >= state.cfg.maxConcurrent) {
        throw new Error(
          `WarmWorkerPool: '${parentAgent}' at capacity (${live}/${state.cfg.maxConcurrent})`,
        );
      }
      this.deps.logger.info(
        { agent: parentAgent, reason: "pool-empty" },
        "phase99986-worker-cold-dispatch",
      );
      // `enqueue: false` — an inline cold dispatch OWNS the worker for this
      // turn, so it must NEVER touch `warm`. (Pre-1B, spawnWorker always pushed
      // to warm and the cold path left a stale stopped handle there after
      // teardown; worse under reuse/concurrency, a 2nd dispatch could pop the
      // in-use worker during the microtask gap before it was spliced out.)
      worker = await this.spawnWorker(parentAgent, { enqueue: false });
      wasWarm = false;
    }

    // Count this dispatch's worker as in-flight BEFORE deciding whether to
    // refill. Under reuse the in-flight worker RETURNS to the pool, so
    // maybeRefill must see it — otherwise it spawns a replacement AND the
    // worker comes back, pushing the warm set over `warmSize` (the returned
    // worker then gets torn down → churn, defeating reuse).
    state.inFlight += 1;
    // 2. Refill — fire-and-forget; the next dispatch lands warm again.
    void this.maybeRefill(parentAgent);

    try {
      if (opts.onProgress && typeof worker.bridge.registerProgressCallback === "function") {
        worker.bridge.registerProgressCallback(opts.onProgress);
      }
      // 3. Deliver via a CHANNEL PUSH over the worker's connected clawcode-channel
      //    — the SAME mechanism the persistent v3 chat path (bridge.ts) and a
      //    no-task subagent spawn use, both proven to fire a turn on claude
      //    2.1.158. (Phase 141 WS-1: the original PTY-write dispatch never fired a
      //    turn on a warm worker — observed live 3×; `\n` is not the claude TUI
      //    submit key and a long-idle worker did not take stdin. Channel-push is
      //    the working delivery path; the warm-time `\r` nudge in spawnWorker is
      //    still needed only to CONNECT the channel.) No ack instruction in
      //    `content` → the agent replies as text and the worker's Stop hook
      //    delivers it (A1 handleTurnComplete), resolving the awaitReply below.
      worker.bridge.push({
        type: "a2a",
        message_id: opts.correlationId,
        content: userMessage,
        meta: {
          reply_correlation_id: opts.correlationId,
          source_agent: "discord",
        },
      });
      this.deps.logger.info(
        {
          agent: parentAgent,
          session: worker.sessionName,
          correlationId: opts.correlationId,
          wasWarm,
          messageLength: userMessage.length,
        },
        "phase99986-worker-dispatch",
      );

      // 4. Await ack / Stop-hook turn-complete fallback. Default to the
      // turn-ceiling window (V3_CHANNEL_REPLY_TIMEOUT_MS), not the old 120s —
      // a long-but-healthy v3 turn delivers only on completion, so 120s
      // rejected real research turns before they could finish.
      const ack = await worker.bridge.awaitReply(
        opts.correlationId,
        opts.timeoutMs ?? V3_CHANNEL_REPLY_TIMEOUT_MS,
      );
      return { result: ack.result ?? "", wasWarm };
    } finally {
      worker.bridge.clearProgressCallback?.();
      state.inFlight = Math.max(0, state.inFlight - 1);
      // 5. Phase 141 WS-1 (1B) — RETURN the worker to the warm set for reuse
      //    (no per-message cold-start) when reuse is enabled, the pool is live,
      //    and the warm set is under its `warmSize` cap. Otherwise tear it down.
      //    Re-enqueueing is safe: a worker is only in `warm` while IDLE (it was
      //    shifted/owned for this dispatch and inFlight was just decremented),
      //    so it can't be handed to a second dispatch while its PTY is busy.
      //    Teardown stays best-effort — failures are logged, never surfaced
      //    (the dispatch already produced a result or rejected with the cause).
      if (
        this.reuseWorkers &&
        !this.stopped &&
        state.warm.length < state.cfg.warmSize
      ) {
        state.warm.push(worker);
        this.deps.logger.info(
          {
            agent: parentAgent,
            session: worker.sessionName,
            warmSize: state.warm.length,
          },
          "phase99986-worker-reused",
        );
      } else {
        await this.teardownWorker(worker).catch((err: unknown) => {
          this.deps.logger.warn(
            {
              agent: parentAgent,
              session: worker.sessionName,
              err: (err as Error)?.message,
            },
            "phase99986-worker-teardown-failed",
          );
        });
      }
    }
  }

  /**
   * Graceful shutdown. After this call, `dispatch()` rejects. Drains any
   * idle warm workers; in-flight dispatches continue and their `finally`
   * runs teardown as normal.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    const drains: Promise<unknown>[] = [];
    for (const state of this.perAgent.values()) {
      const workers = state.warm.splice(0, state.warm.length);
      for (const w of workers) {
        drains.push(this.teardownWorker(w));
      }
    }
    await Promise.allSettled(drains);
  }

  // ── internals ──────────────────────────────────────────────────────────

  private requireState(parent: string): AgentPoolState {
    const state = this.perAgent.get(parent);
    if (!state) {
      throw new Error(
        `WarmWorkerPool: parent '${parent}' is not configured for pooling`,
      );
    }
    return state;
  }

  private async maybeRefill(parent: string): Promise<void> {
    const state = this.perAgent.get(parent);
    if (!state || this.stopped) return;
    const total = state.warm.length + state.spawning + state.inFlight;
    // Phase 141 WS-1 (1B) — under reuse, in-flight workers RETURN to the warm
    // set, so they count toward maintaining `warmSize` (else we'd spawn a
    // replacement AND get the dispatched worker back → churn + over-cap
    // teardown). Without reuse, only the idle warm count matters (the in-flight
    // worker is torn down after its reply, as in the original 999.86 path).
    const provisioned =
      state.warm.length +
      state.spawning +
      (this.reuseWorkers ? state.inFlight : 0);
    if (provisioned >= state.cfg.warmSize) return;
    if (total >= state.cfg.maxConcurrent) return;
    try {
      await this.spawnWorker(parent);
    } catch (err) {
      this.deps.logger.warn(
        { agent: parent, err: (err as Error)?.message },
        "phase99986-worker-refill-failed",
      );
    }
  }

  /**
   * Spawn one worker for `parent`. Builds the worker's `ResolvedAgentConfig`
   * from the parent's config, registers the LLM runtime with
   * `deferFirstTurn: true` (the backend fires NO first-turn input), wires its
   * sockets, starts the session, then drives the menu-dismiss `\r` until the
   * channel connects (Phase 141 WS-1 — see `waitForChannelConnection`), leaving
   * the worker warm at the idle prompt. Pushes the handle onto the warm queue.
   */
  private async spawnWorker(
    parent: string,
    opts: { enqueue?: boolean } = {},
  ): Promise<WorkerHandle> {
    // `enqueue` (default true) — push the warmed handle onto `state.warm` for
    // later pop. start()/maybeRefill() want this. An inline cold dispatch passes
    // `false`: it owns the handle immediately and the worker must never appear
    // in `warm` (else a concurrent dispatch could pop a busy PTY).
    const enqueue = opts.enqueue ?? true;
    const state = this.requireState(parent);
    const parentConfig = this.deps.getParentConfig(parent);
    if (!parentConfig) {
      throw new Error(
        `WarmWorkerPool: parent config not found for '${parent}'`,
      );
    }
    state.spawning += 1;
    const sessionName = `${parent}-pool-${this.generateId()}`;
    this.managedNames.add(sessionName);
    const workerConfig = buildWorkerConfig(parentConfig, sessionName);
    try {
      this.deps.registerLlmRuntime(sessionName, workerConfig, parent, {
        deferFirstTurn: true,
      });

      const wired = this.deps.wireChannelForSubagent(workerConfig);
      const bridge = wired?.bridge;
      if (!bridge) {
        throw new Error(
          `WarmWorkerPool: wireChannelForSubagent returned no bridge for ${sessionName}`,
        );
      }
      const listener = wired?.listener;

      await this.deps.sessionManager.startAgent(sessionName, workerConfig);

      const connected = await this.waitForChannelConnection(
        listener,
        sessionName,
      );
      if (!connected) {
        throw new Error(
          `WarmWorkerPool: worker ${sessionName} channel never connected within ${this.connectCeilingMs}ms`,
        );
      }

      const handle: WorkerHandle = {
        sessionName,
        parentAgent: parent,
        bridge,
        listener,
        spawnedAt: Date.now(),
      };
      if (enqueue) {
        state.warm.push(handle);
        this.deps.logger.info(
          { agent: parent, session: sessionName, warmSize: state.warm.length },
          "phase99986-worker-warmed",
        );
      }
      return handle;
    } catch (err) {
      // Spawn failed mid-way — make sure the partial worker's sockets
      // don't leak. Best-effort.
      await this.deps
        .unwireChannelForSubagent(sessionName)
        ?.catch?.((e: unknown) =>
          this.deps.logger.warn(
            { agent: parent, session: sessionName, err: (e as Error)?.message },
            "phase99986-worker-spawn-cleanup-failed",
          ),
        );
      throw err;
    } finally {
      state.spawning = Math.max(0, state.spawning - 1);
    }
  }

  /**
   * Wait for the worker's channel listener to connect, DRIVING the menu-dismiss
   * `\r` until it does (Phase 141 WS-1 fix).
   *
   * Pool workers spawn with `deferFirstTurn: true` → they park on the
   * `--dangerously-load-development-channels` confirmation menu. On claude 2.1.158
   * the `clawcode-channel` MCP server only connects AFTER that menu is dismissed,
   * so a worker that just parks NEVER connects and this gate would time out
   * (the connect-before-menu-dismiss deadlock). So we fire the SAME menu-dismiss
   * `\r` the `warmNudge`/`firstTurnInput` backend branches use — throttled to
   * ~1/s and STOPPED the instant `isConnected()` flips, so no late `\r` ever
   * lands on a reused, in-service worker. Pre-connect `\r`s hit the menu
   * (idempotent confirm); the connect signal proves the menu was dismissed.
   */
  private async waitForChannelConnection(
    listener: SubagentChannelListener | undefined,
    sessionName: string,
  ): Promise<boolean> {
    if (!listener || typeof listener.isConnected !== "function") return true;
    if (listener.isConnected()) return true;
    const deadline = Date.now() + this.connectCeilingMs;
    let lastNudge = 0;
    while (Date.now() < deadline) {
      const now = Date.now();
      // Re-fetch each iteration: the supervisor registers during startAgent's
      // loadSdkModule; fetching once could miss it if registration lands a tick
      // late, leaving the menu never dismissed → the channel never connects.
      const supervisor = this.deps.liveSupervisorByAgent.get(sessionName);
      if (
        supervisor?.write &&
        now - lastNudge >= MENU_DISMISS_NUDGE_INTERVAL_MS
      ) {
        try {
          supervisor.write(MENU_DISMISS);
        } catch {
          /* best-effort — a dead PTY surfaces as a connection timeout below */
        }
        lastNudge = now;
      }
      await new Promise((r) => setTimeout(r, this.connectPollMs));
      if (listener.isConnected()) return true;
    }
    return false;
  }

  private async teardownWorker(worker: WorkerHandle): Promise<void> {
    // Order: stop the session (kills the PTY child + descendants via the
    // mcpTracker.killAgentGroup negative-pid path), then unwire the per-
    // worker sockets, then drop the supervisor entry so a stale handle
    // is never returned by a later lookup.
    try {
      await this.deps.sessionManager.stopAgent(worker.sessionName);
      this.managedNames.delete(worker.sessionName);
    } catch (err) {
      this.deps.logger.warn(
        { session: worker.sessionName, err: (err as Error)?.message },
        "phase99986-worker-stop-failed",
      );
    }
    try {
      await this.deps.unwireChannelForSubagent(worker.sessionName);
    } catch (err) {
      this.deps.logger.warn(
        { session: worker.sessionName, err: (err as Error)?.message },
        "phase99986-worker-unwire-failed",
      );
    }
    this.deps.liveSupervisorByAgent.delete(worker.sessionName);
  }
}

/**
 * Build a worker's `ResolvedAgentConfig` from its parent's. The worker is
 * a fresh v3 session whose identity, soul, model, and MCP surface match
 * the parent, but with NO Discord channels (the daemon owns the gateway
 * and the pool dispatcher posts the reply to the parent's main channel
 * via the same `bridge.ts` sendResponse path as a long-lived parent),
 * NO threads, NO schedules, NO delegates, and `spawn_subagent_thread`
 * disallowed (workers are pure executors, no nesting).
 *
 * Exported for unit tests; production callers use the class above.
 */
export function buildWorkerConfig(
  parentConfig: ResolvedAgentConfig,
  sessionName: string,
): ResolvedAgentConfig {
  // Strip parent fields that don't apply to a one-turn worker. The spread
  // mirrors SubagentThreadSpawner's `subagentSourceConfig` recipe but
  // drops the thread/webhook/delegation surface entirely.
  const {
    delegates: _stripDelegates,
    ...rest
  } = parentConfig as ResolvedAgentConfig & {
    delegates?: unknown;
  };

  return {
    ...rest,
    name: sessionName,
    channels: [],
    schedules: [],
    slashCommands: [],
    // Keep the parent's Layer-1 tool blocklist (Phase 141 #7) AND forbid nested
    // subagent spawns (workers are pure executors). Merge + dedupe — overwriting
    // with only the spawn block would silently drop a locked-down parent's
    // disallowedTools on the worker that serves its chat turns.
    disallowedTools: [
      ...new Set([
        ...(parentConfig.disallowedTools ?? []),
        "mcp__clawcode__spawn_subagent_thread",
      ]),
    ],
    // Workers are pure v3 chat executors; force the backend explicitly so
    // a flipped failoverStateReader can't accidentally route them through
    // the SDK backend (which has no PTY write seam the pool can drive).
    llmRuntime: {
      ...(parentConfig.llmRuntime ?? {}),
      backend: "claude-code-interactive",
    },
  } as ResolvedAgentConfig;
}
