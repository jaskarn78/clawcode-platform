/**
 * 999.147 WS-2 — the relief action behind the button on an imminence page.
 *
 * Operator decision (2026-09-16): **kill the named offender only.** The same
 * process memwatch's v2 policy would take at its next threshold, taken now,
 * on a human's explicit click. No blanket kills, no agent restart, no daemon
 * bounce. MemoryGuard itself stays alert-only; this module is the one place a
 * human-initiated kill can happen, and it is deliberately narrow.
 *
 * Everything here is FAIL-CLOSED. A relief click is a SIGKILL against a pid an
 * operator has not personally verified, arriving an unknown number of minutes
 * after the page that named it. Four things can have changed in between, and
 * each one is a way to kill the wrong process:
 *
 *   1. The process exited and the kernel recycled its pid. This is the
 *      dangerous one — pid reuse is not exotic on a box spawning hundreds of
 *      short-lived claude/mcp children an hour. Guarded by `starttime`
 *      (`/proc/<pid>/stat` field 22), the only stable pid-identity token
 *      Linux offers: same pid + different starttime = different process,
 *      full stop.
 *   2. The balloon deflated on its own. Guarded by re-reading current anon.
 *   3. The pid left the clawcode cgroup, or was never in it. Guarded by
 *      membership — this must never be able to kill a system service.
 *   4. It is the daemon itself. Killing that takes the whole fleet down, so
 *      it is refused unconditionally, button or no button.
 *
 * Pure decision core + injected effects, so every refusal path is testable
 * without a real process to kill.
 */

import { readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { Logger } from "pino";

/** How long a relief button stays live. Past this it refuses and says so. */
export const RELIEF_TTL_MS = 30 * 60 * 1000;

/** Discord customId prefix. Strict-prefix routed, like acctlink:/vsrc:/trn:. */
export const MEMREL_PREFIX = "memrel:";

export interface ReliefTarget {
  readonly pid: number;
  /** `/proc/<pid>/stat` field 22 — the pid-identity token. */
  readonly startTicks: number;
  /** When the button was minted (epoch ms). */
  readonly issuedAtMs: number;
}

/**
 * `memrel:k:<pid>:<startTicks>:<issuedAtSec>`
 *
 * Seconds rather than ms for the timestamp purely to stay well inside
 * Discord's 100-character customId ceiling; the TTL is measured in minutes so
 * second resolution is ample. `comm` is deliberately NOT encoded — it would
 * need escaping (it can contain `:`), and it is not what establishes identity.
 * The human-readable name lives on the button label; `starttime` is the check.
 */
export function encodeReliefId(target: ReliefTarget): string {
  return [
    "memrel:k",
    target.pid,
    target.startTicks,
    Math.floor(target.issuedAtMs / 1000),
  ].join(":");
}

export function parseReliefId(customId: string): ReliefTarget | null {
  if (!customId.startsWith(MEMREL_PREFIX)) return null;
  const parts = customId.split(":");
  if (parts.length !== 5 || parts[1] !== "k") return null;
  const [pid, startTicks, issuedAtSec] = [parts[2], parts[3], parts[4]].map(
    Number,
  );
  if (
    !Number.isInteger(pid) ||
    !Number.isInteger(startTicks) ||
    !Number.isInteger(issuedAtSec) ||
    pid <= 1 ||
    startTicks <= 0 ||
    issuedAtSec <= 0
  ) {
    return null;
  }
  return { pid, startTicks, issuedAtMs: issuedAtSec * 1000 };
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export type ReliefRefusal =
  | "expired"
  | "gone"
  | "identity-mismatch"
  | "not-in-cgroup"
  | "is-daemon"
  | "recovered";

export interface ReliefProcess {
  readonly pid: number;
  readonly comm: string;
  readonly startTicks: number;
  readonly anonSwapMb: number;
}

export type ReliefDecision =
  | { readonly ok: true; readonly proc: ReliefProcess }
  | { readonly ok: false; readonly refusal: ReliefRefusal; readonly detail: string };

export interface ReliefDecisionInput {
  readonly target: ReliefTarget;
  readonly nowMs: number;
  /** Null when /proc/<pid> is gone. */
  readonly live: ReliefProcess | null;
  readonly inCgroup: boolean;
  readonly daemonPid: number;
  /**
   * Below this the balloon is considered deflated and the kill pointless —
   * the operator gets told it recovered instead of a corpse.
   */
  readonly stillFatMb: number;
}

/**
 * Pure. Ordered so the most dangerous confusions are refused first and the
 * "nothing to do" cases last.
 */
export function decideRelief(input: ReliefDecisionInput): ReliefDecision {
  const { target, live } = input;

  if (target.pid === input.daemonPid) {
    return {
      ok: false,
      refusal: "is-daemon",
      detail: `pid ${target.pid} is the ClawCode daemon — killing it takes the whole fleet down`,
    };
  }
  if (input.nowMs - target.issuedAtMs > RELIEF_TTL_MS) {
    return {
      ok: false,
      refusal: "expired",
      detail: `this button was issued ${Math.round((input.nowMs - target.issuedAtMs) / 60_000)} min ago and has expired — re-check current memory before acting`,
    };
  }
  if (live === null) {
    return {
      ok: false,
      refusal: "gone",
      detail: `pid ${target.pid} no longer exists — it exited on its own`,
    };
  }
  // THE pid-reuse guard. Same pid, different start time = a different process
  // that happens to have inherited the number.
  if (live.startTicks !== target.startTicks) {
    return {
      ok: false,
      refusal: "identity-mismatch",
      detail: `pid ${target.pid} has been recycled (now \`${live.comm}\`, started at a different time) — refusing to kill an unrelated process`,
    };
  }
  if (!input.inCgroup) {
    return {
      ok: false,
      refusal: "not-in-cgroup",
      detail: `pid ${target.pid} is not in the ClawCode cgroup — out of scope for this button`,
    };
  }
  if (live.anonSwapMb < input.stillFatMb) {
    return {
      ok: false,
      refusal: "recovered",
      detail: `pid ${target.pid} (\`${live.comm}\`) is down to ${live.anonSwapMb}MB — the pressure already cleared, no kill needed`,
    };
  }
  return { ok: true, proc: live };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface ReliefDeps {
  /** Reads live process state; null when /proc/<pid> is gone. */
  readonly readProc: (pid: number) => ReliefProcess | null;
  /** True when the pid is a member of the clawcode cgroup. */
  readonly inCgroup: (pid: number) => boolean;
  readonly kill: (pid: number) => void;
  readonly daemonPid: number;
  readonly now: () => number;
  readonly log: Logger;
  /** Append-only audit trail. Never throws into the caller. */
  readonly audit: (row: ReliefAuditRow) => Promise<void>;
  readonly stillFatMb?: number;
}

export interface ReliefAuditRow {
  readonly at: string;
  readonly pid: number;
  readonly comm: string | null;
  readonly anonSwapMb: number | null;
  readonly actor: string;
  readonly outcome: "killed" | "refused" | "kill-failed";
  readonly refusal?: ReliefRefusal;
  readonly detail: string;
}

export interface ReliefOutcome {
  readonly ok: boolean;
  /** Operator-facing single line. Safe to put straight in a Discord reply. */
  readonly message: string;
}

/**
 * Verify, then kill. `actor` is the Discord user id (or `cli:<user>`) and is
 * recorded verbatim in the audit row — every kill through this path is
 * attributable to a human.
 */
export async function executeRelief(
  target: ReliefTarget,
  actor: string,
  deps: ReliefDeps,
): Promise<ReliefOutcome> {
  const now = deps.now();
  const live = deps.readProc(target.pid);
  const decision = decideRelief({
    target,
    nowMs: now,
    live,
    inCgroup: live !== null && deps.inCgroup(target.pid),
    daemonPid: deps.daemonPid,
    stillFatMb: deps.stillFatMb ?? 512,
  });

  const at = new Date(now).toISOString();
  if (!decision.ok) {
    await safeAudit(deps, {
      at,
      pid: target.pid,
      comm: live?.comm ?? null,
      anonSwapMb: live?.anonSwapMb ?? null,
      actor,
      outcome: "refused",
      refusal: decision.refusal,
      detail: decision.detail,
    });
    deps.log.info(
      { tag: "memory-relief", pid: target.pid, actor, refusal: decision.refusal },
      "memory relief refused",
    );
    return { ok: false, message: `⚠️ Not killed — ${decision.detail}.` };
  }

  const { proc } = decision;
  try {
    deps.kill(proc.pid);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await safeAudit(deps, {
      at,
      pid: proc.pid,
      comm: proc.comm,
      anonSwapMb: proc.anonSwapMb,
      actor,
      outcome: "kill-failed",
      detail,
    });
    deps.log.warn(
      { tag: "memory-relief", pid: proc.pid, actor, err: detail },
      "memory relief kill failed",
    );
    return { ok: false, message: `❌ Kill failed for pid ${proc.pid}: ${detail}` };
  }

  await safeAudit(deps, {
    at,
    pid: proc.pid,
    comm: proc.comm,
    anonSwapMb: proc.anonSwapMb,
    actor,
    outcome: "killed",
    detail: `SIGKILL on operator request`,
  });
  deps.log.warn(
    {
      tag: "memory-relief",
      pid: proc.pid,
      comm: proc.comm,
      anonSwapMb: proc.anonSwapMb,
      actor,
    },
    "memory relief: process killed on operator request",
  );
  return {
    ok: true,
    message: `✅ Killed \`${proc.comm}\` (pid ${proc.pid}) — released ~${proc.anonSwapMb}MB.`,
  };
}

/** An audit sink that throws must never turn a successful kill into an error. */
async function safeAudit(deps: ReliefDeps, row: ReliefAuditRow): Promise<void> {
  try {
    await deps.audit(row);
  } catch (err) {
    deps.log.warn(
      {
        tag: "memory-relief",
        err: err instanceof Error ? err.message : String(err),
      },
      "memory relief audit write failed (action still happened)",
    );
  }
}

// ---------------------------------------------------------------------------
// Production readers (thin, injected for tests) — same shape as memory-guard
// ---------------------------------------------------------------------------

/**
 * Read one process's identity + current anon footprint from /proc.
 *
 * `starttime` is parsed from the tail of `/proc/<pid>/stat` rather than by
 * splitting the whole line: field 2 is the comm, it is parenthesised, and it
 * may itself contain spaces and `)`. Splitting the line whole mis-indexes
 * every field after it — and the failure is silent, producing a mismatch that
 * reads as "always refuses" rather than as a bug. `lastIndexOf(")")` is the
 * documented way to find where the fixed-width fields begin.
 */
export function readReliefProc(pid: number): ReliefProcess | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    // After "(comm) " the next token is field 3 (state), so field 22
    // (starttime) sits at index 19 of this slice.
    const startTicks = Number(stat.slice(close + 2).split(" ")[19]) || 0;
    if (startTicks <= 0) return null;

    const status = readFileSync(`/proc/${pid}/status`, "utf-8");
    const field = (k: string): number => {
      const row = status.split("\n").find((l) => l.startsWith(`${k}:`));
      return row ? Number(row.split(/\s+/)[1]) || 0 : 0;
    };
    const comm =
      status
        .split("\n")
        .find((l) => l.startsWith("Name:"))
        ?.slice(5)
        .trim() ?? "?";
    return {
      pid,
      comm,
      startTicks,
      anonSwapMb: Math.round((field("RssAnon") + field("VmSwap")) / 1024),
    };
  } catch {
    return null;
  }
}

/**
 * Cgroup membership, read fresh on every check.
 *
 * Deliberately NOT cached: the whole point is that time has passed since the
 * page, so a snapshot taken at mint time would be answering the wrong
 * question. Fails CLOSED — an unreadable cgroup means "not a member", so a
 * broken read refuses the kill rather than permitting it.
 */
export function makeCgroupMembership(
  cgroupDir: string | null,
): (pid: number) => boolean {
  return (pid) => {
    if (cgroupDir === null) return false;
    try {
      return readFileSync(`${cgroupDir}/cgroup.procs`, "utf-8")
        .split("\n")
        .some((l) => Number(l.trim()) === pid);
    } catch {
      return false;
    }
  };
}

/** JSONL audit trail, one row per relief attempt. Append-only. */
export function makeReliefAudit(
  path: string,
): (row: ReliefAuditRow) => Promise<void> {
  return async (row) => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(row)}\n`, "utf-8");
  };
}

export const DEFAULT_RELIEF_AUDIT_PATH = join(
  homedir(),
  ".clawcode",
  "security",
  "memory-relief.jsonl",
);

/** 999.147 WS-3 — Unraid container restarts, kept in their own trail. */
export const DEFAULT_UNRAID_AUDIT_PATH = join(
  homedir(),
  ".clawcode",
  "security",
  "unraid-relief.jsonl",
);

// ---------------------------------------------------------------------------
// Boot seam
// ---------------------------------------------------------------------------

/**
 * The relief deps are built in the daemon-boot closure but needed by
 * `routeMethod`, which is a top-level function already carrying 34 positional
 * parameters (its own comment warns that each addition means touching every
 * call site plus the test harness). Same seam `setIngestAlertDeps` uses for
 * exactly this problem — a module-level setter written once at boot.
 *
 * Null until boot wires it; the IPC handler then reports the daemon is not
 * ready rather than killing anything.
 */
let reliefDepsFactory: (() => ReliefDeps) | null = null;

export function setReliefDepsFactory(factory: () => ReliefDeps): void {
  reliefDepsFactory = factory;
}

export function getReliefDepsFactory(): (() => ReliefDeps) | null {
  return reliefDepsFactory;
}
