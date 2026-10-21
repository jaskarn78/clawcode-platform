/**
 * Phase 999.14 — MCP child process tracker (singleton, daemon-wide).
 * Phase 999.15 — extended with reconciler-friendly API surface (TRACK-03):
 *   - 3-arg register(name, claudePid, mcpPids) — stores claudePid alongside MCPs
 *   - updateAgent(name, claudePid) / replaceMcpPids(name, mcpPids) — sync mutators
 *   - getRegisteredAgents() → ReadonlyMap<name, RegisteredAgent>
 *   - pruneDeadPids(name) — async; uses isPidAlive
 *
 * Mirrors SecretsResolver DI shape (constructor captures deps, no module
 * state). Tracks per-agent MCP child PIDs and provides idempotent process-
 * group kills for MCP-02 (agent disconnect) and MCP-04 (daemon shutdown).
 *
 * Invariants:
 *   - All mutations are IMMUTABLE — every update writes a NEW RegisteredAgent
 *     object reference. Callers holding a previous reference observe the
 *     pre-mutation state (pinned by PT-3 / PT-4).
 *   - Mutator methods (register's entry write, updateAgent, replaceMcpPids)
 *     are SYNC — JS event-loop ordering serializes mutations. Cmdline cache
 *     enrichment in register/replaceMcpPids is async + best-effort and runs
 *     AFTER the synchronous entry write so subsequent sync code observes the
 *     new state immediately.
 *
 * Canonical log shape (pinned by tests):
 *   { component: "mcp-tracker", action: "sigterm" | "sigkill", pid, cmdline,
 *     reason: "agent-disconnect" | "shutdown" }
 */

import type { Logger } from "pino";
import { readProcInfo, isPidAlive } from "./proc-scan.js";

/**
 * Idempotent process-group SIGTERM/SIGKILL helper.
 *
 * Calls `process.kill(-pid, sig)` — negative pid signals every process sharing
 * the pgid. Used for live MCP cleanup. Orphan reaper uses individual
 * `process.kill(pid, sig)` since orphan pgid leadership is unreliable.
 *
 * Refuses pid <= 1 (pid 0 hits caller's group, pid 1 is init). Returns true
 * on success OR ESRCH (idempotent), false on EPERM. Other errors logged +
 * rethrown.
 */
export function killGroup(
  pid: number,
  sig: NodeJS.Signals,
  log: Logger,
): boolean {
  if (pid <= 1) {
    log.error(
      { component: "mcp-tracker", action: "kill", pid, sig },
      "refusing to kill pid <= 1",
    );
    return false;
  }
  try {
    process.kill(-pid, sig);
    return true;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ESRCH") return true; // already gone — idempotent success
    if (e.code === "EPERM") {
      log.warn(
        { component: "mcp-tracker", action: "kill", pid, sig, code: "EPERM" },
        "kill denied (not our process)",
      );
      return false;
    }
    log.error(
      { component: "mcp-tracker", action: "kill", pid, sig, code: e.code },
      "kill failed unexpectedly",
    );
    throw err;
  }
}

/**
 * Phase 999.15 — per-agent tracker entry.
 *
 * Returned by getRegisteredAgents() as the value type of the ReadonlyMap.
 * Reference identity changes on every updateAgent / replaceMcpPids call
 * (immutable mutation pattern — pinned by PT-3 / PT-4).
 */
export interface RegisteredAgent {
  readonly claudePid: number;
  readonly mcpPids: readonly number[];
  /** Epoch ms — set at register-time, preserved across updates. */
  readonly registeredAt: number;
}

export interface McpProcessTrackerDeps {
  readonly uid: number;
  readonly log: Logger;
  readonly clockTicksPerSec: number;
  readonly bootTimeUnix: number;
  /**
   * Phase 999.14 MCP-01 — union regex for configured MCP server cmdlines.
   * Optional so existing tests that don't exercise MCP-01 PID discovery
   * can construct a tracker with the original 4-field shape.
   */
  readonly patterns?: RegExp;
  /**
   * Phase 999.15 TRACK-06 — late-bound reconcile closure. When provided,
   * killAgentGroup calls this BEFORE the SIGTERM loop to sync /proc state
   * with tracker state (so we kill the LIVE MCP children, not stale recorded
   * ones). Failure is non-fatal — falls back to recorded PIDs (safety net).
   *
   * Daemon (src/manager/daemon.ts) wires this to a closure that calls
   * reconcileAgent(name, deps) from src/mcp/reconciler.ts. Late-bound to
   * avoid the bootstrap circular dependency (reconciler imports the tracker
   * type; tracker dep would import the reconciler module).
   *
   * Tests inject a fake deps.reconcileAgent directly via constructor.
   */
  readonly reconcileAgent?: (name: string) => Promise<void>;
}

/** Polling interval for the post-SIGTERM grace loop. */
const POLL_MS = 250;

/**
 * Per-agent MCP PID tracker with idempotent process-group kills.
 */
export class McpProcessTracker {
  /** Phase 999.15 — reshaped from Map<string, ReadonlySet<number>> to per-agent entry. */
  private readonly entries = new Map<string, RegisteredAgent>();
  /** Captured at register-time so kill-time logs include cmdline even after death. */
  private readonly cmdlines = new Map<number, string>();
  private readonly log: Logger;

  constructor(private readonly deps: McpProcessTrackerDeps) {
    this.log = deps.log;
  }

  /**
   * Phase 999.14 MCP-01 — read-only accessor for configured cmdline regex.
   * SessionManager.startAgent passes this to discoverAgentMcpPids without
   * re-building the regex on every agent start.
   *
   * @throws if constructed without patterns (programmer error).
   */
  get patterns(): RegExp {
    if (!this.deps.patterns) {
      throw new Error(
        "McpProcessTracker.patterns accessed but not configured (constructor was given no patterns regex)",
      );
    }
    return this.deps.patterns;
  }

  /**
   * Phase 999.15 — register an agent with its claude subprocess PID + MCP child PIDs.
   *
   * SYNC entry write (the immediate this.entries.set call) — subsequent sync
   * code observes the new state right away. Cmdline cache enrichment is
   * async/best-effort and runs AFTER the entry write, so failures here never
   * roll back tracker state.
   *
   * Replaces any prior entry for the same agent. registeredAt updates to now
   * on every call — fresh registration is treated as a new lifecycle.
   */
  async register(
    agentName: string,
    claudePid: number,
    mcpPids: readonly number[],
  ): Promise<void> {
    // SYNC — JS event-loop ordering serializes mutations (Phase 999.15 invariant per orchestrator)
    const entry: RegisteredAgent = {
      claudePid,
      mcpPids: [...mcpPids],
      registeredAt: Date.now(),
    };
    this.entries.set(agentName, entry);
    // Best-effort cmdline cache enrichment — failures don't roll back state.
    await this.enrichCmdlineCache(mcpPids);
  }

  /**
   * Phase 999.15 — replace tracked claudePid for an agent.
   *
   * SYNC. Constructs a NEW RegisteredAgent object (immutable mutation —
   * callers holding the prior reference see the old claudePid). registeredAt
   * is preserved (this is an update, not a fresh registration).
   *
   * @throws if the agent is not registered (caller should register first).
   */
  updateAgent(agentName: string, claudePid: number): void {
    // SYNC — JS event-loop ordering serializes mutations (Phase 999.15 invariant per orchestrator)
    const existing = this.entries.get(agentName);
    if (!existing) {
      throw new Error(
        `McpProcessTracker.updateAgent: agent '${agentName}' not registered`,
      );
    }
    const next: RegisteredAgent = {
      claudePid,
      mcpPids: existing.mcpPids,
      registeredAt: existing.registeredAt,
    };
    this.entries.set(agentName, next);
  }

  /**
   * Phase 999.15 — replace tracked MCP child PIDs for an agent.
   *
   * SYNC entry write (immediate this.entries.set). Constructs a NEW
   * RegisteredAgent object (immutable mutation). Cmdline cache enrichment
   * for newly added pids is fire-and-forget so this method itself stays sync.
   *
   * @throws if the agent is not registered.
   */
  replaceMcpPids(agentName: string, mcpPids: readonly number[]): void {
    // SYNC — JS event-loop ordering serializes mutations (Phase 999.15 invariant per orchestrator)
    const existing = this.entries.get(agentName);
    if (!existing) {
      throw new Error(
        `McpProcessTracker.replaceMcpPids: agent '${agentName}' not registered`,
      );
    }
    const next: RegisteredAgent = {
      claudePid: existing.claudePid,
      mcpPids: [...mcpPids],
      registeredAt: existing.registeredAt,
    };
    this.entries.set(agentName, next);
    // Fire-and-forget cmdline cache enrichment — this method must stay sync.
    void this.enrichCmdlineCache(mcpPids);
  }

  /**
   * Phase 999.15 — return the full registered-agent map as a ReadonlyMap.
   *
   * Returned reference is the live internal Map (typed as ReadonlyMap so
   * callers cannot mutate). Reference identity of each entry value changes
   * on every updateAgent/replaceMcpPids call (immutable mutation — pinned by
   * PT-3, PT-4). Used by the reconciler (Plan 02) and the mcp-tracker CLI
   * (Plan 03) for inspection.
   */
  getRegisteredAgents(): ReadonlyMap<string, RegisteredAgent> {
    return this.entries;
  }

  /**
   * Phase 999.15 Plan 03 (TRACK-05) — read-only accessor for the per-agent
   * cmdline cache populated at register / replaceMcpPids time. Returns the
   * cmdlines (one per MCP PID, in registration order, with redaction
   * already applied by the proc-scan layer).
   *
   * Used by `buildMcpTrackerSnapshot` (mcp-tracker-snapshot.ts) to surface
   * cmdlines to operators via `clawcode mcp-tracker`. Returns an empty
   * array when:
   *   - the agent is unknown,
   *   - the cmdline cache enrichment hasn't completed yet (race-safe),
   *   - or every cached cmdline has been evicted.
   */
  getCmdlinesForAgent(agentName: string): readonly string[] {
    const entry = this.entries.get(agentName);
    if (!entry) return [];
    const out: string[] = [];
    for (const pid of entry.mcpPids) {
      const cmd = this.cmdlines.get(pid);
      if (cmd !== undefined) out.push(cmd);
    }
    return out;
  }

  /**
   * Phase 999.15 — partition the agent's mcpPids into pruned (dead) + alive.
   *
   * Walks the agent's MCP PID list, calls isPidAlive(pid) for each, and
   * removes dead ones from tracker state via replaceMcpPids. Idempotent:
   * calling twice in a row with no /proc changes is a no-op the second time.
   *
   * Returns the partition for caller logging / metrics. Empty arrays if the
   * agent is not registered (defensive — does NOT throw).
   */
  async pruneDeadPids(
    agentName: string,
  ): Promise<{ pruned: readonly number[]; alive: readonly number[] }> {
    const entry = this.entries.get(agentName);
    if (!entry) return { pruned: [], alive: [] };
    const alive: number[] = [];
    const pruned: number[] = [];
    for (const pid of entry.mcpPids) {
      if (isPidAlive(pid)) alive.push(pid);
      else pruned.push(pid);
    }
    if (pruned.length > 0) {
      this.replaceMcpPids(agentName, alive);
    }
    return { pruned, alive };
  }

  /** Remove an agent's tracked PIDs. Returns the evicted MCP PIDs. */
  unregister(agentName: string): readonly number[] {
    const entry = this.entries.get(agentName);
    if (!entry) return [];
    this.entries.delete(agentName);
    // Don't drop cmdline cache yet — killAll/killAgentGroup may still need them.
    return [...entry.mcpPids];
  }

  /** All tracked MCP PIDs across every agent (deduplicated). claudePid NOT included. */
  list(): readonly number[] {
    const all = new Set<number>();
    for (const entry of this.entries.values()) {
      for (const pid of entry.mcpPids) all.add(pid);
    }
    return Array.from(all);
  }

  /** Tracked MCP PIDs for a specific agent (empty array if unknown). */
  listForAgent(agentName: string): readonly number[] {
    const entry = this.entries.get(agentName);
    return entry ? [...entry.mcpPids] : [];
  }

  /**
   * SIGTERM agent's PGs, await grace, SIGKILL stragglers. Idempotent — second
   * call after eviction is a no-op. Used by MCP-02.
   *
   * Phase 999.15 TRACK-06 — reconciles BEFORE kill so SIGTERM targets the
   * LIVE MCP children (not stale recorded ones). The reconcile closure is
   * injected via deps.reconcileAgent; failure falls back to the recorded
   * PIDs (safety net — kill is best-effort cleanup, never block on /proc
   * walk failures).
   */
  async killAgentGroup(agentName: string, graceMs: number = 5000): Promise<void> {
    // Phase 999.15 TRACK-06 — sync /proc state with tracker before kill.
    if (this.deps.reconcileAgent) {
      try {
        await this.deps.reconcileAgent(agentName);
      } catch (err) {
        this.log.warn(
          { agent: agentName, err: String(err) },
          "reconcile-before-kill failed; falling back to recorded PIDs",
        );
      }
    }
    const pids = this.listForAgent(agentName); // post-reconcile state
    if (pids.length === 0) return; // already evicted — no-op
    await this.killPids(pids, graceMs, "agent-disconnect");
    // Evict on success so a second call is a no-op.
    this.entries.delete(agentName);
    for (const pid of pids) this.cmdlines.delete(pid);
  }

  /**
   * SIGTERM every tracked PID (deduplicated), grace, SIGKILL. Used by MCP-04.
   *
   * Phase 999.15 — NO reconcile here. This is the graceful-exit path
   * (whole-daemon shutdown); /proc walks may hit timing issues during
   * shutdown teardown. Use the recorded PIDs from the most recent reconcile
   * cycle (CONTEXT determinism — locked decision).
   */
  async killAll(graceMs: number = 5000): Promise<void> {
    const pids = this.list();
    if (pids.length === 0) return;
    await this.killPids(pids, graceMs, "shutdown");
    this.entries.clear();
    this.cmdlines.clear();
  }

  /**
   * Best-effort cmdline cache population. Failures are swallowed (cache is
   * for log enrichment only — kill flow uses "unknown" if the cache misses).
   */
  private async enrichCmdlineCache(pids: readonly number[]): Promise<void> {
    await Promise.all(
      pids.map(async (pid) => {
        try {
          const info = await readProcInfo(pid);
          if (info) {
            this.cmdlines.set(pid, info.cmdline.join(" "));
          }
        } catch {
          /* swallow — best-effort enrichment, not load-bearing */
        }
      }),
    );
  }

  /** SIGTERM each pid, poll for liveness, SIGKILL stragglers after grace. */
  private async killPids(
    pids: readonly number[],
    graceMs: number,
    reason: "agent-disconnect" | "shutdown",
  ): Promise<void> {
    // Snapshot starttime per pid so we can detect PID recycling during the grace.
    const initialStartTime = new Map<number, number>();
    await Promise.all(
      pids.map(async (pid) => {
        try {
          const info = await readProcInfo(pid);
          if (info) initialStartTime.set(pid, info.startTimeJiffies);
        } catch {
          /* unreachable in practice; leave starttime unset → treat liveness as gone */
        }
      }),
    );

    // SIGTERM each pid via NEGATIVE pid (process-group form).
    for (const pid of pids) {
      const cmdline = this.cmdlines.get(pid) ?? "unknown";
      this.log.warn(
        {
          component: "mcp-tracker",
          action: "sigterm",
          pid,
          cmdline,
          reason,
        },
        "terminating MCP process group",
      );
      killGroup(pid, "SIGTERM", this.log);
    }

    // Poll until every pid is gone OR grace expires.
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      const alive = await this.checkAlive(pids, initialStartTime);
      if (alive.length === 0) return;
      await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
    }

    // Grace expired: SIGKILL stragglers via POSITIVE pid (orphan group leader
    // may already be dead; fall back to individual kill).
    const stragglers = await this.checkAlive(pids, initialStartTime);
    for (const pid of stragglers) {
      const cmdline = this.cmdlines.get(pid) ?? "unknown";
      this.log.warn(
        {
          component: "mcp-tracker",
          action: "sigkill",
          pid,
          cmdline,
          reason,
          graceMs,
        },
        "force-killing MCP process after grace",
      );
      try {
        process.kill(pid, "SIGKILL");
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== "ESRCH") {
          this.log.error(
            { component: "mcp-tracker", action: "sigkill", pid, code: e.code },
            "SIGKILL failed unexpectedly",
          );
        }
      }
    }
  }

  /** Filter pids to those still alive with same starttime (no PID recycling). */
  private async checkAlive(
    pids: readonly number[],
    initialStartTime: Map<number, number>,
  ): Promise<readonly number[]> {
    const alive: number[] = [];
    for (const pid of pids) {
      try {
        const info = await readProcInfo(pid);
        if (!info) continue; // gone
        const expected = initialStartTime.get(pid);
        if (expected !== undefined && info.startTimeJiffies !== expected) {
          // PID recycled to unrelated process — treat as gone.
          continue;
        }
        alive.push(pid);
      } catch {
        // Treat I/O failure as gone (proc disappeared mid-read).
      }
    }
    return alive;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
