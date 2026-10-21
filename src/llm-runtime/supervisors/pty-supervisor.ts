/**
 * Phase 140 Plan 02 Task 1 — PtySupervisor.
 *
 * Owns the lifecycle of a real `claude --channels` child launched through a
 * TTY (CONTEXT Gate-3: the binary needs a pseudo-terminal — a bare pipe is
 * insufficient, so node-pty rather than child_process.spawn).
 *
 * Responsibilities (the supervision state machine this plan proves):
 *   - spawn() launches `claude` via the injected `PtySpawnFn` (default wraps
 *     node-pty's `spawn`), detached behind the seam, and registers the child
 *     PID with the existing `McpProcessTracker` via `register(agent, pid, [])`
 *     so the daemon's NEGATIVE-pid group kill (`killAgentGroup`) and the
 *     `orphan-claude-reaper` cover this child with ZERO new cleanup code
 *     (T-140-02-03).
 *   - on child exit, a restart is scheduled with exponential backoff starting
 *     at 1s, doubling each restart, capped at 60s.
 *   - a restart storm (> 10 restarts within a rolling 1-hour window) trips a
 *     circuit breaker: no further restart is scheduled, an operator-alert log
 *     line is emitted, and `getState()` returns "circuit-open" (T-140-02-01,
 *     DoS mitigation).
 *   - stop() group-kills via the tracker (it does NOT re-implement kill) and
 *     cancels any pending restart timer.
 *
 * --- 140-01 continuity gate (branch_flag: resume-design-required) ----------
 * A bare `claude --channels` respawn starts a FRESH session — native
 * auto-resume does NOT happen (140-01-SUMMARY sub-check B, operator-accepted).
 * Therefore THIS supervisor owns the resume mechanism: each restart appends
 * `--resume <session-id>` when the injected `getResumeSessionId()` returns a
 * captured id. Without this, a restart silently wipes the conversation. The
 * id source (on-disk transcript dir `~/.claude/projects/<cwd-hash>/<id>.jsonl`
 * and/or the SDK init result) is wired by Plan 03/04 behind this getter seam;
 * this plan proves the replay path.
 *
 * DI discipline mirrors `CodexAgentCli` — the constructor captures every
 * dependency (spawn fn, tracker, logger, `now()` clock, `scheduleRestart`
 * timer seam, resume-id getter); there is NO module-level state, so the unit
 * test runs fully deterministically with a fake pty + fake tracker + a
 * hand-driven scheduler (no real binary, no real TTY, no real timers).
 *
 * Logs (operator-greppable):
 *   { component: "pty-supervisor", agent, action: "spawn"|"restart-scheduled"
 *     |"circuit-open"|"stop", ... }
 * Any argv log line carrying `--mcp-config` is redacted via the shared
 * `redactCmdline` (T-140-02-02 — no cleartext-secret leak into journald).
 *
 * See:
 *   - src/mcp/process-tracker.ts — `register` / `killAgentGroup` (REUSE).
 *   - src/mcp/orphan-claude-reaper.ts — `CLAUDE_ARGV0_RE`, `redactCmdline`
 *     (REUSE — argv0 must end in `claude` so the reaper matches).
 *   - src/manager/detached-spawn.ts — detached:true spawn precedent.
 *   - .planning/phases/140-claudecode-interactive-channels-backend/140-CONTEXT.md
 */

import { createRequire } from "node:module";
import { redactCmdline } from "../../mcp/orphan-claude-reaper.js";
import type { McpProcessTracker } from "../../mcp/process-tracker.js";

/** Restart backoff floor (first restart waits this long). */
const BACKOFF_BASE_MS = 1_000;
/** Restart backoff ceiling — doubling is clamped here. */
const BACKOFF_CAP_MS = 60_000;
/** Rolling window over which restarts are counted for the circuit breaker. */
const CIRCUIT_WINDOW_MS = 60 * 60 * 1_000; // 1 hour
/**
 * Max restarts permitted inside the rolling window. The (N+1)th restart
 * attempt within the window trips the breaker — i.e. 10 restarts are allowed,
 * the 11th exit stops the supervisor.
 */
const CIRCUIT_MAX_RESTARTS = 10;

/**
 * Minimal pseudo-terminal handle — the subset of node-pty's `IPty` this
 * supervisor consumes. Kept narrow so the unit test can supply a hand-rolled
 * fake without pulling the native addon.
 */
export interface PtyHandle {
  /** OS process id of the spawned child (the `claude` process-group leader). */
  readonly pid: number;
  /** Register an exit listener; returns a disposable to detach it. */
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): {
    dispose(): void;
  };
  /** Send a signal to the pty (defaults to SIGHUP in node-pty). */
  kill(signal?: string): void;
  /** Write to the child's stdin (node-pty `write`). Optional on fakes. */
  write?(data: string): void;
}

/**
 * Spawn seam. Production wraps node-pty's `spawn(file, args, options)`; the
 * unit test injects a fake that records the argv and returns a fake handle.
 * The first argv element (`file` is also passed as `args[0]`) MUST end in
 * `claude` so `orphan-claude-reaper`'s `CLAUDE_ARGV0_RE` covers the child.
 */
export type PtySpawnFn = (
  file: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string | undefined>>;
  },
) => PtyHandle;

/** A cancellable scheduled callback (the `setTimeout` seam). */
export interface CancellableTimer {
  cancel(): void;
}

/** Pino-compatible logger subset (matches `LlmRuntimeDeps.logger` + error). */
export interface PtySupervisorLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** Tracker subset this supervisor needs (register on spawn, kill on stop). */
export type PtySupervisorTracker = Pick<
  McpProcessTracker,
  "register" | "killAgentGroup"
>;

export interface PtySupervisorDeps {
  /** Agent name — the key under which the PID is registered + killed. */
  readonly agent: string;
  /**
   * The base `claude --channels` argv. `argv[0]` MUST end in `claude` (orphan
   * reaper coverage). Plan 04 supplies the production values
   * (`claude --dangerously-load-development-channels server:clawcode-channel
   * plugin:discord@claude-plugins-official --mcp-config <path>`); this plan
   * proves the supervision state machine over whatever argv it is handed.
   */
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Spawn seam — default wraps node-pty (see `defaultPtySpawn`). */
  readonly spawnPty: PtySpawnFn;
  /** Existing daemon-wide tracker (REUSE — no new kill/reap code). */
  readonly tracker: PtySupervisorTracker;
  readonly log: PtySupervisorLogger;
  /** Injectable clock for deterministic backoff/window tests. */
  readonly now: () => number;
  /**
   * setTimeout seam — schedules a restart `ms` in the future and returns a
   * handle to cancel it. Production wraps `setTimeout`/`clearTimeout`.
   */
  readonly scheduleRestart: (cb: () => void, ms: number) => CancellableTimer;
  /**
   * 140-01 resume seam. Returns the captured `claude` session id to replay on
   * the NEXT spawn, or null for a fresh session. Wired by Plan 03/04 to the
   * transcript-dir watcher / SDK init result; the test injects a fake.
   */
  readonly getResumeSessionId?: () => string | null;
}

/** Public supervision state. */
export type PtyState =
  | "idle" // constructed, never spawned
  | "running" // a child is live
  | "restarting" // child exited, a restart is scheduled
  | "circuit-open" // restart storm tripped the breaker — no more restarts
  | "stopped"; // stop() was called — terminal

/**
 * Supervises a single `claude --channels` PTY child: spawn → register →
 * backoff-restart → circuit-break → stop.
 */
export class PtySupervisor {
  private state: PtyState = "idle";
  private child: PtyHandle | null = null;
  private exitDisposable: { dispose(): void } | null = null;
  private pendingTimer: CancellableTimer | null = null;

  /** Backoff for the NEXT restart (doubles per restart, capped). */
  private nextBackoffMs = BACKOFF_BASE_MS;
  /** Timestamps (from `now()`) of restarts inside the rolling window. */
  private restartTimes: number[] = [];

  constructor(private readonly deps: PtySupervisorDeps) {}

  /** Current public supervision state. */
  getState(): PtyState {
    return this.state;
  }

  /**
   * Launch the `claude` child (fresh session — NO `--resume`), register its
   * PID, and wire the exit→restart handler. Idempotent only in the sense that
   * a second call while running spawns a new child; callers spawn once.
   */
  async spawn(): Promise<void> {
    await this.launch(this.deps.argv);
  }

  /**
   * Write to the running child's stdin (PTY). Phase 140 parity — the backend's
   * post-spawn warm-nudge triggers the agent's first turn so its channel MCP
   * client connects (caveat #2). No-op if not running or the handle can't write.
   */
  write(data: string): void {
    this.child?.write?.(data);
  }

  /**
   * Group-kill the child via the tracker (NOT a re-implemented kill) and
   * cancel any pending restart timer. Terminal — a later exit event is a
   * no-op once stopped.
   */
  async stop(): Promise<void> {
    this.state = "stopped";
    this.cancelPendingRestart();
    // Detach our exit listener BEFORE killing so the kill-induced exit does
    // not schedule a restart.
    this.exitDisposable?.dispose();
    this.exitDisposable = null;
    this.child = null;
    this.deps.log.info(
      { component: "pty-supervisor", agent: this.deps.agent, action: "stop" },
      "stopping pty supervisor",
    );
    // REUSE the existing negative-pid group kill — do not re-implement.
    await this.deps.tracker.killAgentGroup(this.deps.agent);
  }

  // ------------------------------------------------------------------------

  /** Spawn `claude` with the given argv, register the PID, wire exit handler. */
  private async launch(argv: readonly string[]): Promise<void> {
    const file = argv[0]!;
    const child = this.deps.spawnPty(file, argv, {
      cwd: this.deps.cwd,
      env: this.deps.env,
    });
    this.child = child;
    this.state = "running";

    // REUSE: register the PID so killAgentGroup + orphan-claude-reaper cover
    // the child. mcpPids is [] — the channel MCP runs IN-process under the
    // agent's own `claude` (no separate child to track here).
    await this.deps.tracker.register(this.deps.agent, child.pid, []);

    this.deps.log.info(
      {
        component: "pty-supervisor",
        agent: this.deps.agent,
        action: "spawn",
        pid: child.pid,
        cmdline: redactCmdline(argv), // T-140-02-02 — redact --mcp-config
      },
      "spawned claude pty child",
    );

    this.exitDisposable = child.onExit(() => this.onChildExit());
  }

  /** Child exited — decide restart vs circuit-break (unless stopped). */
  private onChildExit(): void {
    if (this.state === "stopped") return; // intentional kill — do not restart
    this.child = null;

    const now = this.deps.now();
    // Prune restarts older than the rolling window, then check the cap.
    this.restartTimes = this.restartTimes.filter(
      (t) => now - t < CIRCUIT_WINDOW_MS,
    );

    if (this.restartTimes.length >= CIRCUIT_MAX_RESTARTS) {
      // Restart storm — trip the breaker (T-140-02-01).
      this.state = "circuit-open";
      this.deps.log.error(
        {
          component: "pty-supervisor",
          agent: this.deps.agent,
          action: "circuit-open",
          restartsInWindow: this.restartTimes.length,
          windowMs: CIRCUIT_WINDOW_MS,
        },
        "pty restart circuit-breaker tripped — no further restart (operator alert)",
      );
      return;
    }

    // Schedule the restart at the current backoff, then double (capped).
    const delayMs = this.nextBackoffMs;
    this.state = "restarting";
    this.deps.log.warn(
      {
        component: "pty-supervisor",
        agent: this.deps.agent,
        action: "restart-scheduled",
        delayMs,
        restartsInWindow: this.restartTimes.length,
      },
      "scheduling pty restart with backoff",
    );
    this.pendingTimer = this.deps.scheduleRestart(() => {
      this.pendingTimer = null;
      void this.restart();
    }, delayMs);

    this.nextBackoffMs = Math.min(this.nextBackoffMs * 2, BACKOFF_CAP_MS);
  }

  /** Fire a scheduled restart: count it, build the resume argv, relaunch. */
  private async restart(): Promise<void> {
    if (this.state === "stopped" || this.state === "circuit-open") return;
    this.restartTimes.push(this.deps.now());
    await this.launch(this.buildRestartArgv());
  }

  /**
   * 140-01 resume mechanism: append `--resume <id>` when a captured session id
   * exists, so a restart RESUMES the conversation instead of starting fresh.
   * Returns the base argv unchanged when there is no id (or no getter).
   */
  private buildRestartArgv(): readonly string[] {
    const sessionId = this.deps.getResumeSessionId?.() ?? null;
    if (!sessionId) return this.deps.argv;
    return [...this.deps.argv, "--resume", sessionId];
  }

  private cancelPendingRestart(): void {
    if (this.pendingTimer) {
      this.pendingTimer.cancel();
      this.pendingTimer = null;
    }
  }
}

/**
 * Production `PtySpawnFn` — wraps node-pty's `spawn` with a TTY + detached so
 * the child is its own process-group leader (mirrors `makeDetachedSpawn`'s
 * detached:true rationale: negative-pid group kill must NOT hit the daemon's
 * own pgid). node-pty children already get a fresh session/pgid via the
 * pseudo-terminal allocation, so the daemon's `killAgentGroup` and the
 * orphan-claude-reaper cover them.
 *
 * Lazy require (not a static import) so `npx tsc --noEmit` + unit tests
 * (which inject a fake `PtySpawnFn`) never need the native addon resolved at
 * module-load. The cast is the node-pty `IPty` → narrow `PtyHandle` subset.
 *
 * Phase 140 (live-E2E finding): use `createRequire(import.meta.url)`, NOT a bare
 * `require`. The codebase is ESM (tsup esm output + tsx dev), where `require` is
 * undefined — a bare `require("node-pty")` throws "require is not defined" and
 * the v3 agent fails to spawn. `createRequire` gives a working CJS `require` in
 * ESM while keeping the load lazy (node-pty resolved only on first v3 spawn).
 */
const nodeRequire = createRequire(import.meta.url);

export function defaultPtySpawn(): PtySpawnFn {
  return (file, args, options) => {
    const pty = nodeRequire("node-pty") as typeof import("node-pty");
    // Phase 140 (live-E2E finding): `launch()` calls `spawnPty(file, fullArgv)`
    // where `args[0] === file` (the program). node-pty's `spawn(file, args)`
    // PREPENDS `file`, so passing the full argv made claude run as
    // `claude claude --channels …` — claude treats the duplicate path as a
    // positional prompt and never enters --channels mode (no MCP servers, no
    // channel). Strip the leading program so node-pty gets the post-program args.
    const ptyArgs = args.length > 0 && args[0] === file ? args.slice(1) : [...args];
    const child = pty.spawn(file, ptyArgs, {
      name: "xterm-256color",
      // A concrete terminal size — claude's interactive TUI needs sane
      // dimensions to render + accept input (a 0×0 / unset pty can wedge it).
      cols: 120,
      rows: 40,
      cwd: options.cwd,
      env: options.env,
    });
    // TEMP DEBUG: capture pty output to a file so we can see what claude shows.
    if (process.env.CLAWCODE_DEBUG_PTY) {
      try {
        const fs = nodeRequire("node:fs") as typeof import("node:fs");
        const f = `/tmp/claude-pty-${child.pid}.log`;
        child.onData((d: string) => { try { fs.appendFileSync(f, d); } catch { /* */ } });
      } catch { /* */ }
    }
    return child as unknown as PtyHandle;
  };
}
