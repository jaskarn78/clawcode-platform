/**
 * 2026-07-31 — MemoryGuard: cgroup memory census + budget watchdog.
 *
 * Born from three incidents that all grew silently for days before
 * hurting: the Phase 110 shim-rollout drift (5 agents on ~240 MB Node
 * shims ≈ 3.6 GB), the double-`npx` playwright chain (~1.1 GB of npm
 * intermediaries), and the still-open "unregistered claude class"
 * (workflow/subagent CLI spawns ≈ 10 GB at peak). None tripped an alarm
 * because nothing watched WHERE the cgroup's memory lived — only the
 * 20 GB MemoryMax cliff existed, and the first symptom was fleet-wide.
 *
 * Design (operator decisions 2026-07-31):
 *   - ALERT-ONLY. The guard never kills anything. Auto-remediation
 *     deliberately has NO config surface yet (same discipline as the
 *     advisor `portable-fork` backend: don't ship a knob whose behavior
 *     doesn't exist) — it will be added per-class once real telemetry
 *     has been watched.
 *   - Tiered alerts through the daemon's postToAdminClawdy primitive
 *     (webhook → bot-direct → pino fallback): ⚠️ warn on class-budget /
 *     drift breaches, 🚨 CRITICAL on total-watermark / subagent-class /
 *     host breaches. Deduplicated per breach key with a cooldown;
 *     recovery is logged (not alerted).
 *   - Scope: deep per-class census of the clawcode cgroup + a
 *     lightweight host summary (MemAvailable, SwapFree, root-disk free —
 *     the ENOSPC fleet-down had the same "grew silently" shape).
 *
 * Telemetry: one `memory-guard` summary line every summaryIntervalMs
 * (class rollup — greppable, dashboard-able), plus an immediate line on
 * every breach-state CHANGE. Healthy samples between summaries emit
 * nothing (60 s cadence must not flood the journal).
 *
 * All knobs live under `defaults.memoryGuard` and are read per-tick →
 * a config save takes effect on the next sample, no restart.
 *
 * The census/evaluation core is PURE (injected readers) so tests drive
 * it with fixture snapshots; production readers use /sys/fs/cgroup +
 * /proc directly (no execa/ps dependency).
 */

import { readFileSync, readdirSync, statfsSync } from "node:fs";
import { getHeapStatistics } from "node:v8";
import type { Logger } from "pino";
import { spawnKindOf } from "./subagent-name.js";
import { isBrowserInstance } from "./chrome-instances.js";
import {
  readPressure,
  pressureSummaryFields,
  isCorroborated,
  type PressureSample,
  type MemoryEvents,
} from "./memory-pressure.js";
import {
  advanceSustain,
  evaluateImminence,
  pushPoint,
  resolveTier,
  sustained,
  IMMINENCE_DEFAULTS,
  type AlertTier,
  type ImminenceBreach,
  type ImminenceConfig,
  type TrajectoryPoint,
} from "./memory-imminence.js";

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Process classes the census rolls up to.
 *
 * 2026-07-31 memory program P1 — the claude-family classes are decided by
 * REGISTRY MEMBERSHIP, not parentage. Every managed spawn (agents, workflow
 * workers, warm-pool, forks, subagent threads) is a direct daemon child, so
 * the original ppid split measured the wrong population. The rogue classes
 * are the ones NOT in the live registry pid set:
 *   - `unmanaged-cli`: live parent — nested Task-lane / Bash-run claude
 *   - `survivor-cli`: ppid=1 — restart survivor / orphaned nested spawn
 * (a live agent's CLI legitimately reparents to init after a daemon
 * restart, so ppid=1 alone is NOT an orphan signal; membership is).
 */
export type MemClass =
  | "daemon"
  | "managed-agent-cli" // in the live registry set, operator-defined session
  | "managed-worker-cli" // in the live registry set, generated kinds (sub/via/thread/pool/fork)
  | "bridge-cli" // haiku-via-bridge one-shot children (registered by the bridge governor, P3)
  | "unmanaged-cli" // claude-family proc NOT in any set, parent alive
  | "survivor-cli" // claude-family proc NOT in any set, reparented to init
  | "mcp-node-shim" // Node shim: `clawcode {browser,search,image}-mcp` — budget 0 post Phase 110 flip
  | "mcp-go-shim" // static Go shim (`clawcode-mcp-shim`)
  | "clawcode-mcp" // per-agent sidecar: `clawcode mcp` / `mcp-broker-shim` / slim `clawcode-mcp-standalone.js`
  | "mcp-node" // other node MCP servers (google-workspace, mysql, playwright server, …)
  | "mcp-python" // python MCP servers + embedder
  | "npm" // npm/npx intermediaries (the playwright-chain signature)
  | "chrome" // chromium/chrome-headless (orphan-leak signature)
  | "other";

export interface ProcSample {
  readonly pid: number;
  readonly ppid: number;
  readonly rssKb: number;
  /**
   * 999.106 QW-6 (INC-2026-08-14 ugrep balloon) — anonymous + swapped-out
   * memory, the two components VmRSS misses once pages hit swap. Mirrors
   * memwatch's `RssAnon + VmSwap` numerator: the 16.8GB balloon held ≤8GB in
   * swap, so a VmRSS-only census under-attributed it by that much. 0 when the
   * status fields are absent (older kernels / raced exit).
   */
  readonly anonKb: number;
  readonly swapKb: number;
  readonly comm: string;
  readonly args: string;
  /**
   * 999.147 — `/proc/<pid>/stat` field 22 (process start time in clock ticks
   * since boot). The pid-identity token the relief button re-checks at click
   * time; 0 when unreadable, which the relief path treats as "refuse".
   * Optional so existing test fixtures keep compiling.
   */
  readonly startTicks?: number;
}

/**
 * Everything the pure classifier needs to place one claude-family proc.
 * Built once per tick by `buildCensusContext` (also pure — fixture-driven
 * in tests).
 */
export interface CensusContext {
  readonly daemonPid: number;
  /** Live registry pids whose session kind is "agent". */
  readonly agentPids: ReadonlySet<number>;
  /** Live registry pids of generated worker kinds (sub/via/thread/pool/fork). */
  readonly workerPids: ReadonlySet<number>;
  /** Bridge-registered one-shot children (empty until P3 wires the bridge governor). */
  readonly bridgePids: ReadonlySet<number>;
  /** comm by pid for the whole sample — resolves the bwrap hop. */
  readonly commByPid: ReadonlyMap<number, string>;
  /** True when the registry read failed → classifier uses the legacy ppid fallback. */
  readonly liveSetUnavailable: boolean;
}

export function buildCensusContext(args: {
  readonly daemonPid: number;
  readonly procs: readonly ProcSample[];
  /** null = registry read unavailable/failed (fallback mode). */
  readonly managed: ReadonlyArray<{ pid: number; sessionName: string }> | null;
  readonly bridgePids: ReadonlySet<number>;
}): CensusContext {
  const commByPid = new Map(args.procs.map((p) => [p.pid, p.comm]));
  if (args.managed === null) {
    return {
      daemonPid: args.daemonPid,
      agentPids: new Set(),
      workerPids: new Set(),
      bridgePids: args.bridgePids,
      commByPid,
      liveSetUnavailable: true,
    };
  }
  const agentPids = new Set<number>();
  const workerPids = new Set<number>();
  for (const { pid, sessionName } of args.managed) {
    if (spawnKindOf(sessionName) === "agent") agentPids.add(pid);
    else workerPids.add(pid);
  }
  return {
    daemonPid: args.daemonPid,
    agentPids,
    workerPids,
    bridgePids: args.bridgePids,
    commByPid,
    liveSetUnavailable: false,
  };
}

function isClaudeLike(proc: ProcSample): boolean {
  return (
    proc.comm === "claude" || /\/claude(\s|$)/.test(proc.args.slice(0, 200))
  );
}

/** Pure per-process classifier. */
export function classifyProc(proc: ProcSample, ctx: CensusContext): MemClass {
  const { comm, args } = proc;
  if (proc.pid === ctx.daemonPid) return "daemon";
  // bwrap wrappers count as claude-family: bwrap exists here solely as the
  // agent sandbox, and a sandboxed session's registered pid IS the bwrap
  // pid (the inner claude hangs off it — the "bwrap hop" below).
  if (isClaudeLike(proc) || comm === "bwrap") {
    // Membership: own pid in a set, or parent in a set AND the parent is
    // the bwrap wrapper (sandboxed sessions). The comm guard stops a
    // nested claude spawned BY a managed claude from inheriting managed
    // status — that one is exactly the unmanaged population.
    const inSet = (set: ReadonlySet<number>): boolean =>
      set.has(proc.pid) ||
      (set.has(proc.ppid) && ctx.commByPid.get(proc.ppid) === "bwrap");
    if (ctx.bridgePids.has(proc.pid)) return "bridge-cli";
    if (inSet(ctx.agentPids)) return "managed-agent-cli";
    if (inSet(ctx.workerPids)) return "managed-worker-cli";
    if (ctx.liveSetUnavailable) {
      // Legacy ppid heuristic mapped onto the new names — census never
      // goes dark because the registry read failed.
      return proc.ppid === ctx.daemonPid
        ? "managed-agent-cli"
        : "unmanaged-cli";
    }
    return proc.ppid === 1 ? "survivor-cli" : "unmanaged-cli";
  }
  if (/clawcode-mcp-shim/.test(args)) return "mcp-go-shim";
  if (/clawcode (browser|search|image)-mcp/.test(args)) return "mcp-node-shim";
  if (/clawcode (mcp|mcp-broker-shim)/.test(args)) return "clawcode-mcp";
  // P2 slim sidecar (`node …/clawcode-mcp-standalone.js`) is the SAME
  // logical sidecar as `clawcode mcp` — without this it falls through to
  // the generic node fallback and pads mcp-node by ~90 MB per agent.
  if (/clawcode-mcp-standalone\.js/.test(args)) return "clawcode-mcp";
  if (comm === "npm" || comm === "npx" || /npm exec|npx -y|sh -c npx/.test(args)) {
    return "npm";
  }
  if (comm.includes("chrome")) return "chrome";
  if (comm === "node") return "mcp-node";
  if (comm.startsWith("python")) return "mcp-python";
  return "other";
}

// ---------------------------------------------------------------------------
// Budgets + evaluation
// ---------------------------------------------------------------------------

export interface ClassBudget {
  readonly maxRssMb?: number;
  readonly maxCount?: number;
  /**
   * INC-2026-08-09 — browser-INSTANCE ceiling for multi-process classes.
   * Chrome spawns ~12 helpers per browser, so a process count is a measure of
   * how Chrome is built, not of load: 22 procs was 2 browsers. Where this is
   * set it replaces `maxCount` as the alerting rule; `maxProcs` stays as a
   * far-away runaway-renderer backstop.
   */
  readonly maxInstances?: number;
  /** Runaway-helper backstop (≈ maxInstances × 20). Never the primary signal. */
  readonly maxProcs?: number;
  /**
   * QW-6 — class ceiling on summed RssAnon+VmSwap (MB). Catches what maxRssMb
   * structurally cannot: pages the balloon parked in swap. Defaulted ONLY on
   * `other` — anon budgets on the mcp/agent classes would fire day-one.
   */
  readonly maxAnonSwapMb?: number;
  /**
   * STRUCTURAL budgets describe a state that is definitionally wrong (a
   * restart survivor, a Node shim that should not exist) and page with NO
   * kernel corroboration — such a leak produces no PSI and no throttle.
   * PROXY budgets infer memory trouble from a number and must be corroborated.
   * Derived when absent: `maxCount === 0` ⇒ structural, else proxy.
   */
  readonly kind?: "structural" | "proxy";
}

/**
 * Per-FIELD budget merge (INC-2026-08-09 prerequisite).
 *
 * The previous object-level `??` meant an operator writing
 * `chrome: { maxCount: 30 }` silently discarded the ENTIRE default entry,
 * including `maxRssMb: 2560` — the one chrome rule that actually works. Adding
 * more fields without this would just add more things to lose.
 */
export function mergeBudgets(
  ...layers: readonly (ClassBudget | undefined)[]
): ClassBudget | undefined {
  let out: ClassBudget | undefined;
  // Later layers are lower priority (defaults last), so only fill gaps.
  for (const layer of layers) {
    if (!layer) continue;
    out = {
      maxRssMb: out?.maxRssMb ?? layer.maxRssMb,
      maxCount: out?.maxCount ?? layer.maxCount,
      maxInstances: out?.maxInstances ?? layer.maxInstances,
      maxProcs: out?.maxProcs ?? layer.maxProcs,
      maxAnonSwapMb: out?.maxAnonSwapMb ?? layer.maxAnonSwapMb,
      kind: out?.kind ?? layer.kind,
    };
  }
  return out;
}

/** Structural vs proxy, DERIVED so it survives classes added later. */
export function budgetKind(budget: ClassBudget): "structural" | "proxy" {
  return budget.kind ?? (budget.maxCount === 0 ? "structural" : "proxy");
}

/**
 * Single-source defaults, calibrated from the 2026-07-31 healthy-ish
 * baseline (daemon 2.1G, 9 agent CLIs ≈ 2.9G, sidecars ≈ 240 MB each)
 * with headroom. Config overrides per class via
 * `defaults.memoryGuard.classBudgets.<class>`.
 */
export const DEFAULT_CLASS_BUDGETS: Readonly<
  Partial<Record<MemClass, ClassBudget>>
> = Object.freeze({
  daemon: { maxRssMb: 4096 },
  "managed-agent-cli": { maxRssMb: 6144 },
  // 3 workflow + 3/parent subs + pools (warmSize+2 each) + forks — the
  // COUNT bound is the new signal.
  "managed-worker-cli": { maxRssMb: 5120, maxCount: 18 },
  // 4 bridge sites; the P3 semaphore is 3 — count 4 tolerates one
  // teardown race.
  "bridge-cli": { maxCount: 4, maxRssMb: 2048 },
  // The TRUE "unregistered claude class" — nested Task-lane/Bash spawns
  // are legitimate but bounded. CRITICAL severity.
  "unmanaged-cli": { maxRssMb: 3072, maxCount: 8 },
  // Any survivor after the clean-shutdown pgkill is a leak. CRITICAL.
  "survivor-cli": { maxCount: 0 },
  // Post Phase 110 baseline flip there should be ZERO Node shims — any
  // count is the drift signature.
  "mcp-node-shim": { maxCount: 0 },
  // Sized for the SLIM fleet (~90 MB × ~14 sidecars ≈ 1.3 G). The old
  // 3584 tolerated bundled 246 MB sidecars — now a breach here is the
  // bundled-drift signature (an agent referencing the fat registry entry).
  "clawcode-mcp": { maxRssMb: 2048 },
  "mcp-node": { maxRssMb: 6144 },
  "mcp-python": { maxRssMb: 3072 },
  // A pinned playwright leaves ~0 npm intermediaries; the double-npx
  // chain put 14 of them at ~1.1G.
  npm: { maxCount: 4, maxRssMb: 768 },
  // INC-2026-08-09: was `maxCount: 12`, which sat exactly between chrome's idle
  // (5 procs) and working (17-19 procs) populations — so it fired if and only
  // if the shopping agent did its job. Now bounded by BROWSER INSTANCES (live
  // range 1-2) with a far-away proc backstop for a genuine runaway-renderer loop.
  //
  // INC-2026-08-10: 3 → 4. The workflow report renderer launches its own
  // headless Chromium, and its `comm` is `chrome-headless` with no `--type=`,
  // so `isBrowserInstance` counts it — verified on clawdy (6 procs, ~430 MB,
  // browser-main + 2 zygotes + gpu + utility + renderer). It is bounded by
  // CONSTRUCTION: `renderPdfs` holds a process-wide single-flight lock, so at
  // most ONE report browser can exist at any instant. Reserving exactly one
  // slot keeps the detector's power over runaway growth without letting a
  // report render coinciding with shopping activity re-create the very noise
  // the instance rule was written to kill. `maxProcs: 60` already had the
  // headroom; the RSS rule is the one that would catch a real balloon anyway.
  chrome: { maxInstances: 4, maxProcs: 60, maxRssMb: 2560 },
  // QW-6 — `other` is where an unclassified tool child (the 16.8GB ugrep)
  // lands; the anon+swap ceiling is the rule the VmRSS budget could not be.
  other: { maxRssMb: 2048, maxAnonSwapMb: 4096 },
});

/**
 * P1 taxonomy migration — operator configs written against the 2026-07-31
 * class names keep applying. Looked up when the NEW key has no explicit
 * config entry; the service logs a one-time warn suggesting the new key.
 */
export const LEGACY_CLASS_BUDGET_ALIASES: Readonly<
  Partial<Record<MemClass, string>>
> = Object.freeze({
  "managed-agent-cli": "agent-cli",
  "unmanaged-cli": "subagent-cli",
});

/** Classes whose breaches are CRITICAL (vs warn). */
const CRITICAL_CLASSES: ReadonlySet<MemClass> = new Set([
  "unmanaged-cli",
  "survivor-cli",
]);

export interface MemoryGuardBudgetConfig {
  readonly warnPct: number;
  readonly critPct: number;
  readonly classBudgets?: Readonly<Partial<Record<string, ClassBudget>>>;
  readonly hostMinAvailableMb: number;
  readonly hostMinRootDiskFreeGb: number;
  /**
   * 999.106 QW-6 — single-process anon+swap balloon warn line (MB). The
   * fattest non-daemon proc's `RssAnon + VmSwap` over this fires
   * `proc:anon-balloon`. 4096 default: attribution tier, deliberately ABOVE
   * memwatch's 3GiB warn (memwatch owns the page for what it kills).
   */
  readonly balloonWarnMb: number;
  /** QW-6 — cgroup memory.swap.current warn line (MB) of the 2G SwapMax. */
  readonly swapWarnMb: number;
}

export interface ClassRollup {
  readonly count: number;
  readonly rssMb: number;
  /** QW-6 — per-class RssAnon / VmSwap sums (MB). The swap component is what
   *  a VmRSS census cannot see; `maxAnonSwapMb` budgets judge their sum.
   *  Optional (like instanceCount) so pre-QW-6 fixtures compile; the tick
   *  always fills both. Absent ⇒ the anonswap rule reads 0 (fail-open). */
  readonly anonMb?: number;
  readonly swapMb?: number;
  /**
   * Browser-main processes, for multi-process classes only (chrome).
   * Undefined elsewhere. Helpers are deliberately still counted in `count` and
   * summed into `rssMb` — dropping them would pull ~1.5GB out of the rollup and
   * blind the maxRssMb rule.
   */
  readonly instanceCount?: number;
}

export interface CensusSnapshot {
  /** cgroup memory.current, bytes. */
  readonly currentBytes: number;
  /** Effective ceiling: memory.high if set, else memory.max, bytes ("max" → null). */
  readonly ceilingBytes: number | null;
  readonly anonBytes: number;
  readonly fileBytes: number;
  /**
   * QW-6 — cgroup memory.swap.current, bytes. null/absent = unreadable or
   * unbounded (fail-open: the swap rule simply doesn't evaluate; optional so
   * pre-QW-6 fixtures compile). memory.current does NOT include swapped
   * pages, which is how 16.8GB stayed under MemoryMax.
   */
  readonly swapBytes?: number | null;
  /**
   * QW-6 — the fattest single proc by RssAnon+VmSwap, EXCLUDING the daemon
   * pid (memwatch parity: the daemon is covered by its own class budget +
   * heap rider). Undefined when the census saw no procs.
   */
  readonly fattestAnonProc?: {
    readonly pid: number;
    readonly cls: MemClass;
    readonly comm: string;
    readonly anonSwapMb: number;
    /** 999.147 — pid-identity token for the relief button. See ProcSample. */
    readonly startTicks?: number;
  };
  readonly classes: Readonly<Partial<Record<MemClass, ClassRollup>>>;
  readonly hostAvailableMb: number | null;
  readonly hostSwapFreeMb: number | null;
  readonly hostRootDiskFreeGb: number | null;
}

export interface Breach {
  /** Stable dedup key, e.g. `class:mcp-node-shim:count` or `total:pct`. */
  readonly key: string;
  readonly severity: "warn" | "critical";
  readonly message: string;
  /**
   * STRUCTURAL breaches page with no kernel corroboration; PROXY breaches infer
   * memory trouble from a number and must be corroborated (WS4). Absent on the
   * host/daemon breaches, which are neither — they measure a real resource
   * directly (host MemAvailable, root disk free, V8 heap limit).
   */
  readonly kind?: "structural" | "proxy";
}

/** Pure budget evaluation — returns the full set of ACTIVE breaches. */
export function evaluateBudgets(
  snap: CensusSnapshot,
  cfg: MemoryGuardBudgetConfig,
): readonly Breach[] {
  const breaches: Breach[] = [];

  // Total watermarks — measured against the effective ceiling.
  if (snap.ceilingBytes !== null && snap.ceilingBytes > 0) {
    const pct = snap.currentBytes / snap.ceilingBytes;
    if (pct >= cfg.critPct) {
      breaches.push({
        key: "total:pct",
        severity: "critical",
        message: `cgroup at ${(pct * 100).toFixed(0)}% of ceiling (${mb(snap.currentBytes)}MB / ${mb(snap.ceilingBytes)}MB; anon ${mb(snap.anonBytes)}MB)`,
      });
    } else if (pct >= cfg.warnPct) {
      breaches.push({
        key: "total:pct",
        severity: "warn",
        // WS4 (2026-09-02) — deliberately UNKINDED, i.e. never
        // corroboration-gated, despite being the single noisiest warn key
        // after the class rules (26 posts 2026-08-11..09-02, all on the 6h
        // cooldown boundary with PSI at zero, all self-clearing).
        //
        // Tagging it `proxy` was tried and REVERTED against the 2026-08-14
        // journal. Through the 90-minute climb into that OOM kill, PSI read
        // zero and memory.events was FLAT (eventsHigh unchanged 17:37→18:27) —
        // so a corroboration gate suppresses every warn on the way up. The
        // 84%-of-ceiling warn at 17:45:45 was the ONLY pre-critical page in
        // that window. The criticals at 91% and 100% survive either way
        // (critical is never gated), but losing the 80-90% band costs the one
        // early signal that fires during a slow ceiling approach — exactly the
        // shape a quiet-PSI gate is blind to. 11% less suppression for the
        // only warning that works in the documented failure mode.

        message: `cgroup at ${(pct * 100).toFixed(0)}% of ceiling (${mb(snap.currentBytes)}MB / ${mb(snap.ceilingBytes)}MB; anon ${mb(snap.anonBytes)}MB)`,
      });
    }
  }

  // Per-class budgets.
  for (const [cls, rollup] of Object.entries(snap.classes) as Array<
    [MemClass, ClassRollup]
  >) {
    const legacyKey = LEGACY_CLASS_BUDGET_ALIASES[cls];
    // Per-FIELD merge: an operator override must not silently discard the
    // sibling defaults (see mergeBudgets).
    const budget: ClassBudget | undefined = mergeBudgets(
      cfg.classBudgets?.[cls],
      legacyKey !== undefined ? cfg.classBudgets?.[legacyKey] : undefined,
      DEFAULT_CLASS_BUDGETS[cls],
    );
    if (!budget) continue;
    const severity: Breach["severity"] = CRITICAL_CLASSES.has(cls)
      ? "critical"
      : "warn";
    const kind = budgetKind(budget);
    // INSTANCE rule replaces the raw count rule wherever it is configured.
    // `maxCount` is only consulted when no instance ceiling exists, so a
    // multi-process class can never be judged on helper count again.
    if (
      budget.maxInstances !== undefined &&
      rollup.instanceCount !== undefined &&
      rollup.instanceCount > budget.maxInstances
    ) {
      breaches.push({
        key: `class:${cls}:instances`,
        severity,
        kind,
        message: `${cls} ${rollup.instanceCount} browser instances over budget ${budget.maxInstances} (${rollup.count} procs, ${rollup.rssMb}MB)`,
      });
    }
    if (budget.maxProcs !== undefined && rollup.count > budget.maxProcs) {
      breaches.push({
        key: `class:${cls}:procs`,
        severity,
        kind,
        message: `${cls} ${rollup.count} processes over runaway backstop ${budget.maxProcs} (${rollup.rssMb}MB) — helper explosion, not instance sprawl`,
      });
    }
    if (
      budget.maxInstances === undefined &&
      budget.maxCount !== undefined &&
      rollup.count > budget.maxCount
    ) {
      breaches.push({
        key: `class:${cls}:count`,
        severity,
        kind,
        message:
          cls === "mcp-node-shim"
            ? `${rollup.count} Node shim proc(s) running (budget 0) — Phase 110 runtime drift; check phase110-shim-resolver warns + per-agent shimRuntime overrides`
            : `${cls} count ${rollup.count} over budget ${budget.maxCount} (${rollup.rssMb}MB)`,
      });
    }
    if (budget.maxRssMb !== undefined && rollup.rssMb > budget.maxRssMb) {
      breaches.push({
        key: `class:${cls}:rss`,
        severity,
        // WS4 (2026-09-02) — this rule was the one class rule that did NOT
        // carry `kind`, while its three siblings above all thread the same
        // `budgetKind(budget)` value. Nothing in the `Breach` contract wanted
        // that: the unkinded set is documented as the host/daemon DIRECT
        // measurements, which a class RSS budget is not. Left as-is it was
        // merely inconsistent; with a corroboration gate reading `kind` it
        // would have exempted the single largest source of warn traffic
        // (chrome/clawcode-mcp/mcp-node/other RSS ≈ 49 of 232 posts over
        // 2026-07-23..09-02) for no stated reason.
        kind,
        message: `${cls} RSS ${rollup.rssMb}MB over budget ${budget.maxRssMb}MB (${rollup.count} proc(s))`,
      });
    }
    // QW-6 — the swap-inclusive class ceiling (what maxRssMb cannot see).
    const anonSwapMb = (rollup.anonMb ?? 0) + (rollup.swapMb ?? 0);
    if (
      budget.maxAnonSwapMb !== undefined &&
      anonSwapMb > budget.maxAnonSwapMb
    ) {
      breaches.push({
        key: `class:${cls}:anonswap`,
        severity,
        // STRUCTURAL by declaration: near-zero PSI early in a swap-hidden
        // slow balloon is exactly when this must still page — a proxy kind
        // would let a future corroboration gate silence it.
        kind: "structural",
        message: `${cls} anon+swap ${anonSwapMb}MB over budget ${budget.maxAnonSwapMb}MB (anon ${rollup.anonMb ?? 0}MB + swap ${rollup.swapMb ?? 0}MB, ${rollup.count} proc(s))`,
      });
    }
  }

  // QW-6 (INC-2026-08-14 ugrep) — single-proc anon+swap balloon, class-
  // agnostic so it fires no matter where the classifier put the balloon.
  // STRUCTURAL: it measures a real per-process resource directly and must
  // never be corroboration-gated (the swap-hidden slow balloon produces no
  // PSI until it is too late). warn-tier: MemoryGuard is the ATTRIBUTION
  // tier (pid/comm/class); memwatch owns the kill and its own paging.
  if (
    snap.fattestAnonProc !== undefined &&
    snap.fattestAnonProc.anonSwapMb > cfg.balloonWarnMb
  ) {
    const p = snap.fattestAnonProc;
    breaches.push({
      key: "proc:anon-balloon",
      severity: "warn",
      kind: "structural",
      message: `single process anon+swap balloon: pid ${p.pid} (${p.comm}, class ${p.cls}) at ${p.anonSwapMb}MB — over the ${cfg.balloonWarnMb}MB attribution line (VmRSS census under-counts swapped pages; memwatch owns the kill)`,
    });
  }

  // QW-6 — cgroup swap consumption (of the 2G MemorySwapMax). memory.current
  // does not include swapped pages; sustained swap use is the early tell that
  // the working set no longer fits. Direct measurement — no `kind`, like the
  // host rules (never corroboration-gated).
  if (
    snap.swapBytes !== null &&
    snap.swapBytes !== undefined &&
    mb(snap.swapBytes) > cfg.swapWarnMb
  ) {
    breaches.push({
      key: "cgroup:swap",
      severity: "warn",
      message: `cgroup swap at ${mb(snap.swapBytes)}MB over the ${cfg.swapWarnMb}MB warn line (memory.current excludes swapped pages — the balloon-hiding path)`,
    });
  }

  // Host summary — the ENOSPC and swap-death shapes.
  if (
    snap.hostAvailableMb !== null &&
    snap.hostAvailableMb < cfg.hostMinAvailableMb
  ) {
    breaches.push({
      key: "host:mem",
      severity: "critical",
      message: `host MemAvailable ${snap.hostAvailableMb}MB below ${cfg.hostMinAvailableMb}MB`,
    });
  }
  if (
    snap.hostRootDiskFreeGb !== null &&
    snap.hostRootDiskFreeGb < cfg.hostMinRootDiskFreeGb
  ) {
    breaches.push({
      key: "host:disk",
      severity: "critical",
      message: `root disk free ${snap.hostRootDiskFreeGb.toFixed(1)}GB below ${cfg.hostMinRootDiskFreeGb}GB (ENOSPC fleet-down precursor)`,
    });
  }

  return breaches;
}

function mb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

// ---------------------------------------------------------------------------
// Production readers (thin, injected for tests)
// ---------------------------------------------------------------------------

/** Resolve this process's cgroup dir under /sys/fs/cgroup (v2). */
export function resolveOwnCgroupDir(): string | null {
  try {
    const line = readFileSync("/proc/self/cgroup", "utf-8")
      .split("\n")
      .find((l) => l.startsWith("0::"));
    if (!line) return null;
    const rel = line.slice(3).trim();
    if (!rel || rel === "/") return null;
    return `/sys/fs/cgroup${rel}`;
  } catch {
    return null;
  }
}

function readNum(path: string): number | null {
  try {
    const raw = readFileSync(path, "utf-8").trim();
    if (raw === "max") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function readStatField(path: string, field: string): number {
  try {
    const line = readFileSync(path, "utf-8")
      .split("\n")
      .find((l) => l.startsWith(`${field} `));
    return line ? Number(line.split(" ")[1]) : 0;
  } catch {
    return 0;
  }
}

/** Default proc lister — walks the cgroup's pids via /proc. */
export function listCgroupProcs(cgroupDir: string): ProcSample[] {
  let pids: number[];
  try {
    pids = readFileSync(`${cgroupDir}/cgroup.procs`, "utf-8")
      .split("\n")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    // Threaded cgroups nest — fall back to scanning child dirs' procs.
    try {
      pids = readdirSync(cgroupDir)
        .filter((d) => d.endsWith(".scope") || d.endsWith(".slice"))
        .flatMap((d) =>
          readFileSync(`${cgroupDir}/${d}/cgroup.procs`, "utf-8")
            .split("\n")
            .map((s) => Number(s.trim()))
            .filter((n) => Number.isFinite(n) && n > 0),
        );
    } catch {
      return [];
    }
  }
  const out: ProcSample[] = [];
  for (const pid of pids) {
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf-8");
      const get = (k: string): string =>
        status
          .split("\n")
          .find((l) => l.startsWith(`${k}:`))
          ?.split(/\s+/)[1] ?? "";
      const comm =
        status
          .split("\n")
          .find((l) => l.startsWith("Name:"))
          ?.split(/\s+/)[1] ?? "";
      const rssKb = Number(get("VmRSS")) || 0;
      // QW-6 — the balloon numerator (RssAnon + VmSwap, memwatch parity).
      const anonKb = Number(get("RssAnon")) || 0;
      const swapKb = Number(get("VmSwap")) || 0;
      const ppid = Number(get("PPid")) || 0;
      let args = "";
      try {
        args = readFileSync(`/proc/${pid}/cmdline`, "utf-8")
          .replaceAll("\0", " ")
          // 1024, not 400: a helper's `--type=` marker must never fall
          // outside the captured slice, or every renderer reclassifies as a
          // browser instance and MemoryGuard pages hard (INC-2026-08-09).
          .slice(0, 1024);
      } catch {
        // kernel thread / raced exit — comm-only classification.
      }
      // 999.147 — `starttime` (field 22 of /proc/<pid>/stat) is the ONLY
      // reliable pid-identity token on Linux. The relief button carries it so
      // a click arriving after the process exited cannot kill whatever pid the
      // kernel recycled in the meantime. Parsed from the last field group
      // because comm (field 2) is parenthesised and may itself contain spaces
      // and ')' — splitting the whole line would mis-index every field after it.
      let startTicks = 0;
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
        const afterComm = stat.slice(stat.lastIndexOf(")") + 2);
        startTicks = Number(afterComm.split(" ")[19]) || 0;
      } catch {
        // Raced exit — 0 means "unknown", and the relief path refuses to act
        // on an unknown identity rather than guessing.
      }
      out.push({ pid, ppid, rssKb, anonKb, swapKb, comm, args, startTicks });
    } catch {
      // Process exited between the pid list and the read — skip.
    }
  }
  return out;
}

/** P1 (1b) — the daemon's own V8/process view, sampled on the summary tick. */
export interface DaemonHeapSample {
  readonly rssMb: number;
  readonly heapUsedMb: number;
  readonly heapTotalMb: number;
  readonly externalMb: number;
  readonly arrayBuffersMb: number;
  readonly heapLimitMb: number;
  readonly mallocedMb: number;
  readonly nativeContexts: number;
  /** > 0 is THE JS leak tell (detached-but-referenced realms). */
  readonly detachedContexts: number;
}

/**
 * P1 (1b) — pure heap-breach rule: warn when the JS heap has consumed
 * ≥ 85% of the V8 heap limit (RSS is already covered by the `daemon`
 * class budget; the heap limit is the crash line worth alerting on).
 */
export function evaluateDaemonHeap(
  heap: DaemonHeapSample | null,
): Breach | null {
  if (!heap || heap.heapLimitMb <= 0) return null;
  const pct = heap.heapUsedMb / heap.heapLimitMb;
  if (pct < 0.85) return null;
  return {
    key: "daemon:heap",
    severity: "warn",
    message: `daemon JS heap at ${(pct * 100).toFixed(0)}% of the V8 limit (${heap.heapUsedMb}MB / ${heap.heapLimitMb}MB; detachedContexts ${heap.detachedContexts})`,
  };
}

export interface MemoryGuardReaders {
  readonly readCgroup: () => {
    currentBytes: number;
    ceilingBytes: number | null;
    anonBytes: number;
    fileBytes: number;
    /** QW-6 — cgroup memory.swap.current; optional so older fixtures compile
     *  (absent ⇒ null ⇒ the swap rule fails open). */
    swapCurrentBytes?: number | null;
  } | null;
  readonly listProcs: () => ProcSample[];
  readonly readHost: () => {
    availableMb: number | null;
    swapFreeMb: number | null;
    rootDiskFreeGb: number | null;
  };
  /** P1 (1b) — daemon self-view; absent in older fixtures → rider omitted. */
  readonly readHeap?: () => DaemonHeapSample | null;
  /**
   * INC-2026-08-09 — kernel pressure (PSI + cgroup reclaim events). Absent in
   * older fixtures. OBSERVE-ONLY for now: logged in the summary, gating
   * nothing, so the readers get a week of real telemetry before they are
   * allowed to suppress an alert.
   */
  readonly readPressure?: () => PressureSample;
}

export function makeProductionReaders(): MemoryGuardReaders | null {
  const cgroupDir = resolveOwnCgroupDir();
  if (!cgroupDir) return null;
  return {
    readPressure: () => readPressure(cgroupDir),
    readCgroup: () => {
      const currentBytes = readNum(`${cgroupDir}/memory.current`);
      if (currentBytes === null) return null;
      const high = readNum(`${cgroupDir}/memory.high`);
      const max = readNum(`${cgroupDir}/memory.max`);
      // F2 — one ceiling definition everywhere: min(high, max). Previously
      // `high ?? max`, which agreed with min in practice (high <= max) but
      // diverged in principle from cgroup-stats' consumers.
      const bounded = [high, max].filter(
        (v): v is number => v !== null && v > 0,
      );
      return {
        currentBytes,
        ceilingBytes: bounded.length > 0 ? Math.min(...bounded) : null,
        anonBytes: readStatField(`${cgroupDir}/memory.stat`, "anon"),
        fileBytes: readStatField(`${cgroupDir}/memory.stat`, "file"),
        // QW-6 — null on unreadable/"max" (fail-open: swap rule skips).
        swapCurrentBytes: readNum(`${cgroupDir}/memory.swap.current`),
      };
    },
    listProcs: () => listCgroupProcs(cgroupDir),
    readHost: () => {
      let availableMb: number | null = null;
      let swapFreeMb: number | null = null;
      try {
        const mi = readFileSync("/proc/meminfo", "utf-8");
        const grab = (k: string): number | null => {
          const line = mi.split("\n").find((l) => l.startsWith(`${k}:`));
          const kb = line ? Number(line.split(/\s+/)[1]) : NaN;
          return Number.isFinite(kb) ? Math.round(kb / 1024) : null;
        };
        availableMb = grab("MemAvailable");
        swapFreeMb = grab("SwapFree");
      } catch {
        // host meminfo unreadable — degrade gracefully
      }
      let rootDiskFreeGb: number | null = null;
      try {
        const s = statfsSync("/");
        rootDiskFreeGb = (s.bavail * s.bsize) / 1024 ** 3;
      } catch {
        // statfs unavailable — degrade gracefully
      }
      return { availableMb, swapFreeMb, rootDiskFreeGb };
    },
    readHeap: () => {
      try {
        const mu = process.memoryUsage();
        const hs = getHeapStatistics();
        return {
          rssMb: mb(mu.rss),
          heapUsedMb: mb(mu.heapUsed),
          heapTotalMb: mb(mu.heapTotal),
          externalMb: mb(mu.external),
          arrayBuffersMb: mb(mu.arrayBuffers ?? 0),
          heapLimitMb: mb(hs.heap_size_limit),
          mallocedMb: mb(hs.malloced_memory),
          nativeContexts: hs.number_of_native_contexts,
          detachedContexts: hs.number_of_detached_contexts,
        };
      } catch {
        return null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface ResolvedMemoryGuardConfig {
  readonly enabled?: boolean;
  readonly sampleIntervalMs?: number;
  readonly summaryIntervalMs?: number;
  readonly warnPct?: number;
  readonly critPct?: number;
  readonly alertCooldownMs?: number;
  readonly hostMinAvailableMb?: number;
  readonly hostMinRootDiskFreeGb?: number;
  /** QW-6 — single-proc anon+swap balloon warn line (MB). */
  readonly balloonWarnMb?: number;
  /** QW-6 — cgroup swap warn line (MB). */
  readonly swapWarnMb?: number;
  /**
   * 999.147 — master switch for the three-tier alert router. `false` restores
   * the pre-999.147 behaviour where every breach posts to Discord instantly.
   * Hot-reloadable, so a bad tiering decision is one `clawcode reload` away
   * from rollback without a deploy.
   */
  readonly tiering?: boolean;
  /**
   * 999.147 — per-key tier overrides. Keys are exact breach keys
   * (`"total:pct"`) or class-rule wildcards (`"class:*:rss"`). Lets an
   * operator promote or demote a single rule mid-incident.
   */
  readonly alertTiers?: Readonly<Record<string, AlertTier>>;
  /** 999.147 — imminence thresholds. See IMMINENCE_DEFAULTS. */
  readonly imminence?: Partial<ImminenceConfig>;
  /**
   * 999.147 — how often the DIGEST tier flushes. One message carrying
   * everything that breached since the last flush. Default 24h.
   */
  readonly digestIntervalMs?: number;
  /**
   * 999.147 — floor between two `actNow` pages of the same key. `actNow`
   * bypasses `alertCooldownMs` (that is the INC-2026-08-14 blindness fix:
   * a benign warn must not open a 6h window that swallows a real one), so it
   * needs its own, much shorter, anti-machine-gun bound. Default 15 min.
   */
  readonly actNowCooldownMs?: number;
  /** G-2 — balloon line for the GATE-TIGHTEN signal published on the
   *  MemorySignalBus (distinct job from balloonWarnMb's alert: the signal
   *  defers admission, the alert pages). */
  readonly gateBalloonMb?: number;
  /** G-2 — max age (ms) before the published signal is treated as stale by
   *  the gates (default 3 census ticks — reader-side, wired in the daemon). */
  readonly signalMaxAgeMs?: number;
  /**
   * WS4 — when true (default), a warn-tier breach only reaches Discord if
   * independent kernel evidence corroborates it. Critical-tier and STRUCTURAL
   * breaches are never gated. Suppressed breaches still log and still hold
   * their alertState slot. Set false to restore pre-WS4 behavior (every
   * breach pages).
   */
  readonly corroborateWarnings?: boolean;
  readonly classBudgets?: Readonly<Partial<Record<string, ClassBudget>>>;
}

/** Runtime defaults — single-sourced; schema `.default()`s mirror these. */
export const MEMORY_GUARD_DEFAULTS = Object.freeze({
  enabled: true,
  sampleIntervalMs: 60_000,
  summaryIntervalMs: 600_000,
  warnPct: 0.8,
  critPct: 0.9,
  alertCooldownMs: 6 * 60 * 60 * 1000,
  hostMinAvailableMb: 2048,
  hostMinRootDiskFreeGb: 5,
  // QW-6 — see MemoryGuardBudgetConfig: balloon = attribution tier above
  // memwatch's 3GiB warn; swap warn = half the 2G MemorySwapMax.
  balloonWarnMb: 4096,
  swapWarnMb: 1024,
  // G-2 — gate-tighten signal knobs (schema .default()s mirror these).
  gateBalloonMb: 4096,
  signalMaxAgeMs: 180_000,
  // WS4 — corroboration gate ON. See the emission block in tick().
  corroborateWarnings: true,
  // 999.147 — three-tier alert router ON. See memory-imminence.ts.
  tiering: true,
  digestIntervalMs: 24 * 60 * 60 * 1000,
  actNowCooldownMs: 15 * 60 * 1000,
});

/**
 * 999.147 — a tier-A page: the fleet is actually in trouble. Carries the
 * offending process so the delivery layer can attach a one-click relief
 * button, and the plain text so a leg that cannot carry components (bot-direct,
 * pino) still says what to do.
 */
export interface MemoryPage {
  readonly key: string;
  readonly severity: Breach["severity"];
  readonly message: string;
  /** Absent when the census saw nothing worth naming. */
  readonly offender?: {
    readonly pid: number;
    readonly comm: string;
    readonly cls: MemClass;
    readonly anonSwapMb: number;
    readonly startTicks?: number;
  };
}

export interface MemoryGuardDeps {
  readonly log: Logger;
  /** Alert sink (daemon's postToAdminClawdy). Absent → log-only. */
  readonly postToAdminClawdy?: (msg: string) => Promise<void>;
  /**
   * 999.147 — tier-A sink. When wired, imminence pages go here instead of
   * `postToAdminClawdy` so the delivery layer can attach the relief button.
   * Absent → pages fall back to the plain text sink (never dropped).
   */
  readonly postPage?: (page: MemoryPage) => Promise<void>;
  /** Live config resolver — read per tick (reload without restart). */
  readonly resolveConfig: () => ResolvedMemoryGuardConfig | undefined;
  readonly daemonPid: number;
  /**
   * P1 (1a) — registry-membership source for the census. `managed` comes
   * from SessionManager.listClaudePids(); `bridge` from the bridge spawn
   * governor (empty Set until P3 lands). Absent or throwing → the
   * classifier falls back to the legacy ppid heuristic (census never
   * goes dark).
   */
  readonly getManagedPids?: () => {
    readonly managed: ReadonlyArray<{ pid: number; sessionName: string }>;
    readonly bridge: ReadonlySet<number>;
  };
  /** Injectable for tests; production uses makeProductionReaders(). */
  readonly readers?: MemoryGuardReaders | null;
  readonly now?: () => number;
  /**
   * G-2 — publish the census-derived gate-tighten signal at the end of each
   * tick (production: MemorySignalBus.publish). Optional; absent → the
   * backpressure loop simply never sees a balloon signal (fail-open at the
   * reading gates). The push-through-injected-fn shape keeps MemoryGuard
   * ignorant of its consumers.
   */
  readonly publishMemorySignal?: (signal: {
    readonly at: number;
    readonly anonBalloon: boolean;
    readonly balloonPid: number | null;
  }) => void;
}

/**
 * Consecutive healthy samples required before a breach counts as CLEARED.
 * At the 60s default cadence this is ~5 minutes. One healthy sample is
 * oscillation, not recovery: chrome crossed its old threshold every time the
 * shopping agent started and finished a page load (INC-2026-08-09).
 */
const CLEAR_HYSTERESIS_TICKS = 5;

/**
 * The per-tick config view: every knob defaulted, except the three whose
 * resolved shape differs from the raw config shape (`classBudgets` and
 * `alertTiers` stay genuinely optional; `imminence` widens from a Partial the
 * operator may write to the complete record the predicates consume).
 */
type ResolvedConfig = Required<
  Omit<
    ResolvedMemoryGuardConfig,
    "classBudgets" | "alertTiers" | "imminence"
  >
> & {
  classBudgets?: ResolvedMemoryGuardConfig["classBudgets"];
  alertTiers?: Readonly<Record<string, AlertTier>>;
  imminence: ImminenceConfig;
};

export class MemoryGuard {
  private readonly deps: MemoryGuardDeps;
  private readonly readers: MemoryGuardReaders | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /**
   * breach key → dedup/escalation state.
   *
   * INC-2026-08-09 — this used to be DELETED the moment a breach cleared, which
   * silently defeated the cooldown: a re-breach saw `prev === undefined`, skipped
   * the suppression guard entirely, and alerted again immediately. Any breach
   * that oscillates around its threshold therefore paged on every cycle — the
   * mechanism behind 18 chrome breaches / 14 clears in ~9 days despite a 6h
   * cooldown.
   *
   * The entry now survives as a TOMBSTONE (`clearedAt` set, `lastAlertAt`
   * retained) until the cooldown has fully elapsed, so a flapping breach is
   * judged against when it last PAGED, not when it last cleared.
   */
  private readonly alertState = new Map<
    string,
    {
      severity: Breach["severity"];
      lastAlertAt: number;
      /** Consecutive healthy samples since the breach was last active. */
      healthyTicks: number;
      /** Set once hysteresis is satisfied; null while the breach is live. */
      clearedAt: number | null;
      /**
       * WS4 — set while this key is being held back by the corroboration
       * gate. Purely for transition-logging (log on ENTRY to suppression, not
       * every tick); it deliberately does NOT participate in the cooldown,
       * because a suppressed breach has not paged anyone.
       */
      suppressedAt?: number;
      /**
       * 999.147 — last time this key actually PINGED A HUMAN, as distinct
       * from `lastAlertAt`, which is now the state-machine's journal/dedup
       * clock and advances for telemetry- and digest-tier breaches too.
       *
       * Without the split, a rule demoted to telemetry would still stamp
       * `lastAlertAt` on every transition — so promoting it back to `page`
       * mid-incident via `alertTiers` could land inside a 6h cooldown that
       * nothing human-visible ever opened, and the operator would reasonably
       * conclude the escape hatch is inert. Same reasoning as WS4's
       * `suppressedAt`: a breach that paged nobody is not serving a cooldown.
       */
      lastPagedAt?: number;
    }
  >();
  private lastSummaryAt = 0;
  /** P1 — transition-logged fallback state (avoid per-tick warn flood). */
  private lastLiveSetUnavailable = false;
  /** P1 — one-time legacy classBudgets-key advisory. */
  private legacyBudgetKeysWarned = false;
  /**
   * INC-2026-08-09 — previous tick's reclaim counters, for the DELTA.
   * memory.events is cumulative, so an absolute read would mean one historical
   * throttle permanently un-gates every alert. Null until the second tick,
   * which is why the first tick after a restart can never corroborate.
   */
  private previousEvents: MemoryEvents | null = null;
  /**
   * 999.147 — rolling anon/host-availability samples, the input to every
   * trajectory predicate. Bounded by `imminence.windowMs`, so this is a few
   * dozen numbers, not a leak.
   */
  private anonPoints: readonly TrajectoryPoint[] = [];
  private hostPoints: readonly TrajectoryPoint[] = [];
  /** Consecutive-sample counters, keyed by imminence breach key. */
  private sustainCounts: Readonly<Record<string, number>> = {};
  /**
   * Digest accumulator: breach key → what it last looked like + how many times
   * it fired since the last flush. One message a day instead of one per event.
   */
  private readonly digest = new Map<
    string,
    { severity: Breach["severity"]; message: string; count: number; lastAt: number }
  >();
  private lastDigestAt = 0;
  /** Last time each key paged via the actNow bypass (its own short floor). */
  private readonly lastActNowAt = new Map<string, number>();

  constructor(deps: MemoryGuardDeps) {
    this.deps = deps;
    this.readers =
      deps.readers !== undefined ? deps.readers : makeProductionReaders();
  }

  start(): void {
    if (this.timer) return;
    if (!this.readers) {
      this.deps.log.warn(
        { tag: "memory-guard" },
        "memory-guard: cgroup not resolvable — guard disabled (non-Linux or no cgroup v2)",
      );
      return;
    }
    // Fixed outer cadence; the per-tick enabled/interval knobs are read
    // inside tick(). unref() so a wedged shutdown is never held open by
    // the guard (the stuck-shutdown incident class).
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        this.deps.log.warn(
          { tag: "memory-guard", err: (err as Error).message },
          "memory-guard tick failed (non-fatal)",
        );
      }
    }, this.resolved().sampleIntervalMs);
    this.timer.unref?.();
    // G-2 review — the balloon gate-signal is published once per census tick
    // and the gates discard it after signalMaxAgeMs. A cadence at or above
    // the staleness window makes every signal expire before the next publish:
    // the tighten leg silently self-disables under a schema-legal config.
    // Fail-open direction, so warn loudly rather than block.
    const startCfg = this.resolved();
    if (startCfg.sampleIntervalMs >= startCfg.signalMaxAgeMs) {
      this.deps.log.warn(
        {
          tag: "memory-guard",
          sampleIntervalMs: startCfg.sampleIntervalMs,
          signalMaxAgeMs: startCfg.signalMaxAgeMs,
        },
        "memory-guard: sampleIntervalMs >= signalMaxAgeMs — every gate signal " +
          "goes stale before the next publish; the anon-balloon tighten leg is " +
          "effectively DISABLED",
      );
    }
    this.deps.log.info(
      { tag: "memory-guard", ...this.resolved() },
      "memory-guard started (alert-only)",
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private resolved(): ResolvedConfig {
    const cfg = this.deps.resolveConfig() ?? {};
    return {
      enabled: cfg.enabled ?? MEMORY_GUARD_DEFAULTS.enabled,
      sampleIntervalMs:
        cfg.sampleIntervalMs ?? MEMORY_GUARD_DEFAULTS.sampleIntervalMs,
      summaryIntervalMs:
        cfg.summaryIntervalMs ?? MEMORY_GUARD_DEFAULTS.summaryIntervalMs,
      warnPct: cfg.warnPct ?? MEMORY_GUARD_DEFAULTS.warnPct,
      critPct: cfg.critPct ?? MEMORY_GUARD_DEFAULTS.critPct,
      alertCooldownMs:
        cfg.alertCooldownMs ?? MEMORY_GUARD_DEFAULTS.alertCooldownMs,
      hostMinAvailableMb:
        cfg.hostMinAvailableMb ?? MEMORY_GUARD_DEFAULTS.hostMinAvailableMb,
      hostMinRootDiskFreeGb:
        cfg.hostMinRootDiskFreeGb ??
        MEMORY_GUARD_DEFAULTS.hostMinRootDiskFreeGb,
      balloonWarnMb: cfg.balloonWarnMb ?? MEMORY_GUARD_DEFAULTS.balloonWarnMb,
      swapWarnMb: cfg.swapWarnMb ?? MEMORY_GUARD_DEFAULTS.swapWarnMb,
      gateBalloonMb: cfg.gateBalloonMb ?? MEMORY_GUARD_DEFAULTS.gateBalloonMb,
      signalMaxAgeMs:
        cfg.signalMaxAgeMs ?? MEMORY_GUARD_DEFAULTS.signalMaxAgeMs,
      corroborateWarnings:
        cfg.corroborateWarnings ?? MEMORY_GUARD_DEFAULTS.corroborateWarnings,
      tiering: cfg.tiering ?? MEMORY_GUARD_DEFAULTS.tiering,
      alertTiers: cfg.alertTiers,
      imminence: {
        ...IMMINENCE_DEFAULTS,
        ...(cfg.imminence ?? {}),
        // LAST, and with an explicit `??` chain rather than relying on spread
        // order: an optional zod key can arrive as a present-but-undefined
        // property, which a spread would happily write over a good default.
        // Single-sourced off hostMinAvailableMb, so raising that one knob
        // cannot open a gap between the level rule and its own projection.
        hostFloorMb:
          cfg.imminence?.hostFloorMb ??
          cfg.hostMinAvailableMb ??
          MEMORY_GUARD_DEFAULTS.hostMinAvailableMb,
      },
      digestIntervalMs:
        cfg.digestIntervalMs ?? MEMORY_GUARD_DEFAULTS.digestIntervalMs,
      actNowCooldownMs:
        cfg.actNowCooldownMs ?? MEMORY_GUARD_DEFAULTS.actNowCooldownMs,
      classBudgets: cfg.classBudgets,
    };
  }

  /** One sample: census → evaluate → summary/alert. Exposed for tests. */
  tick(): void {
    const cfg = this.resolved();
    if (!cfg.enabled || !this.readers) return;
    const now = this.deps.now?.() ?? Date.now();

    const cg = this.readers.readCgroup();
    if (!cg) return;
    const procs = this.readers.listProcs();
    const host = this.readers.readHost();

    // P1 (1a) — registry-membership census context. A failed/absent
    // registry read degrades to the legacy ppid heuristic; log the
    // transition (not every tick) so a persistently-broken read is
    // visible without flooding.
    let managed: ReadonlyArray<{ pid: number; sessionName: string }> | null =
      null;
    let bridgePids: ReadonlySet<number> = new Set();
    if (this.deps.getManagedPids) {
      try {
        const r = this.deps.getManagedPids();
        managed = r.managed;
        bridgePids = r.bridge;
      } catch {
        managed = null;
      }
    }
    const ctx = buildCensusContext({
      daemonPid: this.deps.daemonPid,
      procs,
      managed,
      bridgePids,
    });
    if (ctx.liveSetUnavailable !== this.lastLiveSetUnavailable) {
      this.lastLiveSetUnavailable = ctx.liveSetUnavailable;
      if (ctx.liveSetUnavailable && this.deps.getManagedPids) {
        this.deps.log.warn(
          { tag: "memory-guard" },
          "memory-guard: registry pid read unavailable — census running on the legacy ppid fallback",
        );
      }
    }

    // One-time legacy-classBudgets advisory.
    if (!this.legacyBudgetKeysWarned && cfg.classBudgets) {
      const legacyUsed = Object.values(LEGACY_CLASS_BUDGET_ALIASES).filter(
        (k) => k !== undefined && cfg.classBudgets?.[k] !== undefined,
      );
      if (legacyUsed.length > 0) {
        this.legacyBudgetKeysWarned = true;
        this.deps.log.warn(
          { tag: "memory-guard", legacyKeys: legacyUsed },
          "memory-guard: classBudgets uses pre-P1 class names (still applied via alias) — rename to managed-agent-cli / unmanaged-cli",
        );
      }
    }

    const classes: Partial<
      Record<
        MemClass,
        {
          count: number;
          rssMb: number;
          anonMb: number;
          swapMb: number;
          instanceCount?: number;
        }
      >
    > = {};
    // QW-6 — fattest single proc by anon+swap, EXCLUDING the daemon (own
    // class budget + heap rider cover it; memwatch makes the same exclusion).
    let fattest: CensusSnapshot["fattestAnonProc"];
    for (const p of procs) {
      const cls = classifyProc(p, ctx);
      const cur = classes[cls] ?? { count: 0, rssMb: 0, anonMb: 0, swapMb: 0 };
      // INC-2026-08-09 — multi-process classes also carry a browser-INSTANCE
      // count. Every helper stays in `count`/`rssMb`; only the alerting rule
      // changes (see ClassBudget.maxInstances).
      const instanceCount =
        cls === "chrome"
          ? (cur.instanceCount ?? 0) + (isBrowserInstance(p) ? 1 : 0)
          : cur.instanceCount;
      classes[cls] = {
        count: cur.count + 1,
        rssMb: cur.rssMb + Math.round(p.rssKb / 1024),
        anonMb: cur.anonMb + Math.round(p.anonKb / 1024),
        swapMb: cur.swapMb + Math.round(p.swapKb / 1024),
        ...(instanceCount !== undefined ? { instanceCount } : {}),
      };
      if (p.pid !== this.deps.daemonPid) {
        const anonSwapMb = Math.round((p.anonKb + p.swapKb) / 1024);
        if (fattest === undefined || anonSwapMb > fattest.anonSwapMb) {
          fattest = {
            pid: p.pid,
            cls,
            comm: p.comm,
            anonSwapMb,
            ...(p.startTicks !== undefined ? { startTicks: p.startTicks } : {}),
          };
        }
      }
    }

    const snap: CensusSnapshot = {
      currentBytes: cg.currentBytes,
      ceilingBytes: cg.ceilingBytes,
      anonBytes: cg.anonBytes,
      fileBytes: cg.fileBytes,
      swapBytes: cg.swapCurrentBytes ?? null,
      ...(fattest !== undefined ? { fattestAnonProc: fattest } : {}),
      classes,
      hostAvailableMb: host.availableMb,
      hostSwapFreeMb: host.swapFreeMb,
      hostRootDiskFreeGb: host.rootDiskFreeGb,
    };

    // P1 (1b) — daemon self-view rider + heap breach.
    const heap = this.readers.readHeap?.() ?? null;
    const heapBreach = evaluateDaemonHeap(heap);

    // G-2 — publish the gate-tighten signal EVERY tick (an all-clear tick
    // publishes anonBalloon:false, which is what keeps the gates' staleness
    // window honest: silence means the producer died, not that all is well).
    // gateBalloonMb is the DEFER line, distinct from balloonWarnMb's alert.
    const gateBalloon =
      snap.fattestAnonProc !== undefined &&
      snap.fattestAnonProc.anonSwapMb > cfg.gateBalloonMb;
    this.deps.publishMemorySignal?.({
      at: now,
      anonBalloon: gateBalloon,
      balloonPid: gateBalloon ? snap.fattestAnonProc!.pid : null,
    });

    // INC-2026-08-09 — kernel pressure sample. OBSERVE-ONLY: recorded in the
    // summary so a week of real telemetry exists before WS4 lets it suppress
    // anything. The delta baseline advances every tick regardless.
    const pressure = this.readers.readPressure?.() ?? null;
    const prevEvents = this.previousEvents;
    if (pressure?.events) this.previousEvents = pressure.events;

    // 999.147 — trajectory input. Recorded EVERY tick, including ticks that
    // breach nothing: a slope is only as good as the quiet samples that
    // establish it, and the first climb after a restart must not be judged
    // against an empty window.
    const anonMbNow = mb(snap.anonBytes);
    const ceilingMbNow =
      snap.ceilingBytes !== null && snap.ceilingBytes > 0
        ? mb(snap.ceilingBytes)
        : null;
    const imm: ImminenceConfig = cfg.imminence;
    this.anonPoints = pushPoint(
      this.anonPoints,
      { atMs: now, mb: anonMbNow },
      imm.windowMs,
    );
    if (snap.hostAvailableMb !== null) {
      this.hostPoints = pushPoint(
        this.hostPoints,
        { atMs: now, mb: snap.hostAvailableMb },
        imm.windowMs,
      );
    }

    // The kernel's own opinion, for the two proof-not-projection predicates.
    // Both are DELTAS against the previous sample — `memory.events` is
    // cumulative, and an absolute read would page forever over one historical
    // kill (the rule the WS3 readers were built on).
    const verdictNow =
      pressure !== null
        ? isCorroborated({
            current: pressure,
            previousEvents: prevEvents,
            scope: "cgroup",
          })
        : null;
    const oomKillDelta =
      pressure?.events && prevEvents
        ? Math.max(0, pressure.events.oomKill - prevEvents.oomKill)
        : 0;

    const imminentCandidates = evaluateImminence({
      nowMs: now,
      anonMb: anonMbNow,
      ceilingMb: ceilingMbNow,
      anonPoints: this.anonPoints,
      hostAvailableMb: snap.hostAvailableMb,
      hostPoints: this.hostPoints,
      actNow: verdictNow?.actNow === true,
      actNowReason: verdictNow?.reason ?? "",
      oomKillDelta,
      cfg: imm,
    });
    this.sustainCounts = advanceSustain(
      this.sustainCounts,
      imminentCandidates.map((b) => b.key),
    );
    const imminent = sustained(imminentCandidates, this.sustainCounts, imm);
    const imminentByKey = new Map(imminent.map((b) => [b.key, b]));

    const breaches = [
      ...evaluateBudgets(snap, {
        warnPct: cfg.warnPct,
        critPct: cfg.critPct,
        classBudgets: cfg.classBudgets,
        hostMinAvailableMb: cfg.hostMinAvailableMb,
        hostMinRootDiskFreeGb: cfg.hostMinRootDiskFreeGb,
        balloonWarnMb: cfg.balloonWarnMb,
        swapWarnMb: cfg.swapWarnMb,
      }),
      ...(heapBreach ? [heapBreach] : []),
      ...imminent,
    ];

    // Periodic summary line (greppable rollup).
    if (now - this.lastSummaryAt >= cfg.summaryIntervalMs) {
      this.lastSummaryAt = now;
      this.deps.log.info(
        {
          tag: "memory-guard",
          currentMb: mb(snap.currentBytes),
          ceilingMb: snap.ceilingBytes !== null ? mb(snap.ceilingBytes) : null,
          anonMb: mb(snap.anonBytes),
          fileMb: mb(snap.fileBytes),
          // QW-6 — swap + fattest-proc riders (observe value from day one;
          // the per-class anon/swap sums ride in `classes` below).
          swapCurrentMb: snap.swapBytes != null ? mb(snap.swapBytes) : null,
          fattestAnonProc: snap.fattestAnonProc ?? null,
          classes,
          hostAvailableMb: snap.hostAvailableMb,
          hostRootDiskFreeGb:
            snap.hostRootDiskFreeGb !== null
              ? Number(snap.hostRootDiskFreeGb.toFixed(1))
              : null,
          // P1 (1b) — daemon self-view (first heap telemetry in the
          // codebase). Null when the reader is absent (older fixtures)
          // or the sample failed.
          daemonHeap: heap,
          censusMode: ctx.liveSetUnavailable ? "ppid-fallback" : "registry",
          // INC-2026-08-09 — pressure rider. When these read zero while a
          // class budget is breached, the breach is a proxy with no kernel
          // support: exactly the chrome case.
          ...(pressure ? pressureSummaryFields(pressure, prevEvents) : {}),
          activeBreaches: breaches.map((b) => b.key),
        },
        "memory-guard summary",
      );
    }

    // Breach-state transitions: new/escalated → log + alert (deduped);
    // cleared → recovery log only (no alert noise).
    const activeKeys = new Set(breaches.map((b) => b.key));
    for (const [key, state] of this.alertState) {
      if (activeKeys.has(key)) continue;
      const healthyTicks = state.healthyTicks + 1;
      if (state.clearedAt === null) {
        if (healthyTicks < CLEAR_HYSTERESIS_TICKS) {
          // Not clear yet — a single healthy sample is oscillation, not
          // recovery. Hold the breach open so the flap never reaches the
          // re-alert path in the first place.
          this.alertState.set(key, { ...state, healthyTicks });
          continue;
        }
        // Genuinely recovered: log once, then keep the tombstone so a
        // re-breach inside the cooldown window is still suppressed.
        this.alertState.set(key, { ...state, healthyTicks, clearedAt: now });
        this.deps.log.info(
          { tag: "memory-guard", key, previousSeverity: state.severity },
          "memory-guard breach cleared",
        );
        continue;
      }
      // Tombstone: retire it only once the cooldown has fully elapsed, so the
      // next breach is genuinely NEW rather than a continuation of the flap.
      if (now - state.lastAlertAt >= cfg.alertCooldownMs) {
        this.alertState.delete(key);
      } else {
        this.alertState.set(key, { ...state, healthyTicks });
      }
    }
    for (const breach of breaches) {
      // 999.147 — the tier is resolved FIRST because it decides which clock
      // bounds this breach (see lastPagedAt) and whether a human is involved
      // at all. `tiering: false` restores the pre-999.147 firehose.
      const tier: AlertTier =
        cfg.tiering === false
          ? "page"
          : resolveTier(breach.key, cfg.alertTiers);
      const prev = this.alertState.get(breach.key);
      const escalated =
        prev !== undefined &&
        prev.severity === "warn" &&
        breach.severity === "critical";
      // WS4 — a key whose last outcome was a GATE SUPPRESSION never paged a
      // human, so it is not serving a cooldown. Without this, an
      // uncorroborated sample would open a 6h window that swallows the
      // corroborated breach arriving minutes later. Testing `suppressedAt`
      // directly (rather than leaning on `lastAlertAt: 0` arithmetic) keeps
      // the semantics true under any clock, fake or real.
      // 999.147 — the INC-2026-08-14 blindness fix. That day a benign 84%
      // warn opened a 6h cooldown; 100 minutes later the cgroup crossed its
      // ceiling, the kernel OOM-killed chrome and the daemon died — and the
      // page that mattered never fired, because its key was still serving that
      // cooldown. An `actNow` breach (kernel stalling now, or an OOM kill just
      // happened) is proof rather than inference, so it bypasses the long
      // cooldown entirely and serves only its own short anti-machine-gun floor.
      const immNow = imminentByKey.get(breach.key);
      const actNowBypass =
        immNow?.actNow === true &&
        now - (this.lastActNowAt.get(breach.key) ?? 0) >=
          cfg.actNowCooldownMs;
      // A page is bounded by when it last PAGED; a journal/digest line by
      // when it last wrote one. Conflating them is what would make a mid-
      // incident tier promotion look inert for up to six hours.
      //
      // ABSENCE is tested explicitly, never `now - (x ?? 0) >= cooldown`.
      // That arithmetic only reads as "never paged" because real epoch ms
      // dwarfs six hours; under any fake clock — or in the first six hours of
      // 1970 — it silently inverts. Same landmine WS4 banked for
      // `suppressedAt`, and the reason this is a marker rather than a number.
      const tierCooled =
        tier === "page"
          ? prev?.lastPagedAt === undefined ||
            now - prev.lastPagedAt >= cfg.alertCooldownMs
          : now - (prev?.lastAlertAt ?? 0) >= cfg.alertCooldownMs;
      const cooledDown =
        actNowBypass ||
        (prev !== undefined &&
          (prev.suppressedAt !== undefined || tierCooled));
      if (prev !== undefined && !escalated && !cooledDown) {
        // Suppressed. Reset the healthy run and re-open the tombstone, but
        // DO NOT touch lastAlertAt — the cooldown is measured from the last
        // time this actually paged a human.
        this.alertState.set(breach.key, {
          ...prev,
          healthyTicks: 0,
          clearedAt: null,
        });
        continue;
      }

      // WS4 (2026-09-02) — corroboration gate on the Discord leg ONLY.
      //
      // WHY. Over 2026-07-23..09-02 this guard posted 232 messages to
      // #admin-clawdy, ~95% warn-tier proxy breaches that self-cleared with
      // every kernel pressure metric reading zero. That volume is not merely
      // noise: on 2026-08-14 the 6h cooldown, started by a benign 84%-of-
      // ceiling warn, was still running when the cgroup crossed its ceiling
      // and the kernel OOM-killed chrome — the page that mattered never fired.
      // Suppressing uncorroborated warns is the half of that fix which makes
      // the channel readable. (The cooldown itself is UNCHANGED here — a
      // genuine escalation can still be swallowed by a cooldown a benign warn
      // opened. That is deliberately out of scope for this change.)
      //
      // SCOPE — only `kind: "proxy"` warns are gated, which is precisely the
      // contract the `Breach` doc comment already stated: "PROXY breaches
      // infer memory trouble from a number and must be corroborated (WS4)".
      // Everything else pages exactly as it does today:
      //   - critical-tier, whatever its kind (the operator must always see it)
      //   - STRUCTURAL (`proc:anon-balloon`, `class:*:anonswap`) — swap-hidden
      //     ballooning produces near-zero PSI precisely while it still matters
      //   - UNKINDED direct measurements (`host:mem`, `host:disk`,
      //     `cgroup:swap`, `daemon:heap`) — these measure a real resource, and
      //     cgroup PSI is structurally incapable of corroborating some of them
      //     (a V8 heap limit is process-local; the cgroup can be idle).
      // isCorroborated FAILS OPEN: no PSI on this kernel ⇒ corroborated.
      const gated =
        cfg.corroborateWarnings !== false &&
        breach.severity === "warn" &&
        breach.kind === "proxy";
      // `pressure === null` means no reader was injected at all (tests, or a
      // platform without the cgroup tree) — fail open, same contract as
      // isCorroborated's own `!current.available` branch.
      const verdict =
        gated && pressure !== null
          ? isCorroborated({
              current: pressure,
              previousEvents: prevEvents,
              scope: breach.key.startsWith("host:") ? "host" : "cgroup",
            })
          : null;

      if (verdict !== null && !verdict.corroborated) {
        // Suppressed — and CRITICALLY, this must not start the cooldown.
        // `lastAlertAt` means "last time this paged a human" (see the
        // suppression branch above); a gate-suppressed breach never did.
        // Advancing it here would let a quiet, uncorroborated sample open a
        // 6h window that then swallows the corroborated breach arriving an
        // hour later — the exact INC-2026-08-14 shape, made worse. Carrying
        // the previous value forward (0 when this key has never paged) keeps
        // `cooledDown` true, so every subsequent tick re-reaches this gate and
        // pages the moment the kernel actually corroborates.
        this.alertState.set(breach.key, {
          severity: breach.severity,
          lastAlertAt: prev?.lastAlertAt ?? 0,
          ...(prev?.lastPagedAt !== undefined
            ? { lastPagedAt: prev.lastPagedAt }
            : {}),
          healthyTicks: 0,
          clearedAt: null,
          suppressedAt: now,
        });
        // Transition-logged: one line when a key ENTERS suppression, not one
        // per 60s tick for as long as it stays there (the census cadence would
        // otherwise put ~1400 lines/day of a self-clearing proxy in the
        // journal). `activeBreaches` on the periodic summary already carries
        // the still-suppressed state for anyone counting.
        if (prev?.suppressedAt === undefined) {
          this.deps.log.info(
            {
              tag: "memory-guard",
              key: breach.key,
              severity: breach.severity,
              kind: breach.kind ?? null,
              reason: verdict.reason,
            },
            `memory-guard breach suppressed (uncorroborated): ${breach.message}`,
          );
        }
        continue;
      }

      this.alertState.set(breach.key, {
        severity: breach.severity,
        lastAlertAt: now,
        // Only a tier-A emission counts as having paged a human.
        ...(tier === "page"
          ? { lastPagedAt: now }
          : prev?.lastPagedAt !== undefined
            ? { lastPagedAt: prev.lastPagedAt }
            : {}),
        healthyTicks: 0,
        clearedAt: null,
      });

      const logFn =
        breach.severity === "critical"
          ? this.deps.log.error.bind(this.deps.log)
          : this.deps.log.warn.bind(this.deps.log);
      logFn(
        {
          tag: "memory-guard",
          key: breach.key,
          severity: breach.severity,
          // Ship the verdict ON the breach line so an operator never has to
          // reconstruct the alert↔kernel-state join from summary lines again.
          corroboration: verdict?.reason ?? null,
        },
        `memory-guard breach: ${breach.message}`,
      );
      // The journal line above is emitted for EVERY tier: demoting a rule must
      // never cost observability, only interruption. What changes here is
      // solely whether a human is pinged.
      if (tier === "telemetry") continue;

      if (tier === "digest") {
        const cur = this.digest.get(breach.key);
        this.digest.set(breach.key, {
          severity: breach.severity,
          message: breach.message,
          count: (cur?.count ?? 0) + 1,
          lastAt: now,
        });
        continue;
      }

      if (immNow?.actNow === true) this.lastActNowAt.set(breach.key, now);

      const prefix =
        breach.severity === "critical"
          ? "🚨 **MemoryGuard CRITICAL**"
          : "⚠️ MemoryGuard";
      // The corroborating evidence is WHY this one got through the gate —
      // include it so the message answers "is this real?" on its face.
      const why = verdict?.corroborated ? ` — ${verdict.reason}` : "";
      const text = `${prefix}: ${breach.message}${why}`;

      // Prefer the page sink (it can attach the relief button); fall back to
      // the plain sink so a daemon built before WS-2 still delivers the text.
      const post = this.deps.postPage
        ? this.deps.postPage({
            key: breach.key,
            severity: breach.severity,
            message: text,
            ...(snap.fattestAnonProc !== undefined
              ? { offender: snap.fattestAnonProc }
              : {}),
          })
        : this.deps.postToAdminClawdy?.(text);
      void post?.catch((err) => {
        this.deps.log.warn(
          { tag: "memory-guard", err: (err as Error).message },
          "memory-guard alert post failed (non-fatal)",
        );
      });
    }

    this.maybeFlushDigest(now, cfg);
  }

  /**
   * 999.147 — the DIGEST tier's single daily message.
   *
   * Everything demoted out of the page tier still surfaces here, once, with a
   * count. This is the concession to the OTHER half of the 999.115 finding: the
   * guard has historically been blind as well as noisy, so nothing is deleted —
   * it is moved to a cadence a human can actually absorb.
   */
  private maybeFlushDigest(now: number, cfg: ResolvedConfig): void {
    // First tick after a restart establishes the window; it does not flush an
    // empty (or half-collected) digest.
    if (this.lastDigestAt === 0) {
      this.lastDigestAt = now;
      return;
    }
    if (now - this.lastDigestAt < cfg.digestIntervalMs) return;
    this.lastDigestAt = now;
    if (this.digest.size === 0) return;

    const rows = [...this.digest.entries()].sort(
      (a, b) => b[1].count - a[1].count,
    );
    this.digest.clear();

    const hours = Math.round(cfg.digestIntervalMs / 3_600_000);
    const lines = rows.map(
      ([key, v]) =>
        `• \`${key}\` ×${v.count} — ${v.message}`,
    );
    const body = [
      `🗒️ **MemoryGuard digest** — ${rows.length} rule(s) breached in the last ${hours}h, none urgent enough to page.`,
      ...lines,
    ].join("\n");

    this.deps.log.info(
      { tag: "memory-guard", keys: rows.map(([k]) => k) },
      "memory-guard digest",
    );
    void this.deps.postToAdminClawdy?.(body).catch((err) => {
      this.deps.log.warn(
        { tag: "memory-guard", err: (err as Error).message },
        "memory-guard digest post failed (non-fatal)",
      );
    });
  }
}
