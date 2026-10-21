/**
 * 999.147 WS-3 — the Unraid poller, and the container-restart action.
 *
 * Shape mirrors MemoryGuard deliberately (tick → evaluate → dedup/cooldown →
 * page) so an operator debugging one is not learning a second vocabulary. The
 * differences are all forced by the box: no PSI, no swap, and an SSH hop
 * instead of /proc.
 *
 * Every SSH failure is non-fatal and transition-logged. A poller that throws
 * into its own interval, or that pages every minute because Tailscale
 * hiccupped, would be a second flood on top of the one being fixed.
 */

import type { Logger } from "pino";
import { execFile } from "node:child_process";
import {
  evaluateUnraid,
  parseUnraidContainers,
  parseUnraidSnapshot,
  recordUnraidPoint,
  UNRAID_CONTAINERS_CMD,
  UNRAID_SNAPSHOT_CMD,
  UNRAID_WATCH_DEFAULTS,
  type UnraidBreach,
  type UnraidContainer,
  type UnraidWatchConfig,
} from "./unraid-memory-watch.js";
import type { TrajectoryPoint } from "../manager/memory-imminence.js";

export type UnraidSsh = (command: string) => Promise<string>;

/**
 * SSH runner over the clawdy → unraid hop. BatchMode so a missing key fails
 * fast instead of hanging on a password prompt; the timeout is well under the
 * poll interval so a wedged tick can never overlap the next one.
 */
export function makeUnraidSsh(target: string): UnraidSsh {
  return (command) =>
    new Promise((resolve, reject) => {
      execFile(
        "ssh",
        [
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=8",
          "-o",
          "StrictHostKeyChecking=accept-new",
          target,
          command,
        ],
        { timeout: 25_000, maxBuffer: 1 << 20 },
        (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
      );
    });
}

export interface UnraidPage {
  readonly key: string;
  readonly severity: "warn" | "critical";
  readonly message: string;
  readonly container?: UnraidContainer;
}

export interface UnraidWatchDeps {
  readonly log: Logger;
  readonly ssh: UnraidSsh;
  readonly postPage: (page: UnraidPage) => Promise<void>;
  readonly resolveConfig: () => Partial<UnraidWatchConfig> & {
    enabled?: boolean;
    pollIntervalMs?: number;
    alertCooldownMs?: number;
  };
  readonly now?: () => number;
}

const DEFAULT_POLL_MS = 5 * 60_000;
const DEFAULT_COOLDOWN_MS = 60 * 60_000;

export class UnraidWatch {
  private readonly deps: UnraidWatchDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private points: readonly TrajectoryPoint[] = [];
  private previousOomCount: number | null = null;
  private sustain: Record<string, number> = {};
  /**
   * key → when it last paged AND at what severity.
   *
   * The severity is load-bearing, not bookkeeping: `unraid:mem-exhaustion` is
   * emitted at `warn` while falling and at `critical` once under the floor, so
   * a cooldown keyed on the name alone would page the projection and then go
   * SILENT straight through the OOM — on the one box with no swap to slow that
   * down. Same escalation bypass `memory-guard.ts` carries for the same reason.
   */
  private readonly lastPagedAt = new Map<
    string,
    { at: number; severity: "warn" | "critical" }
  >();
  private consecutiveSshFailures = 0;
  private sshFailureLogged = false;

  constructor(deps: UnraidWatchDeps) {
    this.deps = deps;
  }

  start(): void {
    const cfg = this.deps.resolveConfig();
    if (cfg.enabled === false) return;
    const interval = cfg.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.timer = setInterval(() => {
      void this.tick();
    }, interval);
    // unref: a homelab poller must never hold a wedged shutdown open (the
    // stuck-shutdown incident class).
    this.timer.unref?.();
    this.deps.log.info(
      { tag: "unraid-watch", intervalMs: interval },
      "unraid memory watch started",
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One poll. Never throws. Exposed for tests. */
  async tick(): Promise<void> {
    const raw = this.deps.resolveConfig();
    if (raw.enabled === false) return;
    const cfg: UnraidWatchConfig = { ...UNRAID_WATCH_DEFAULTS, ...raw };
    const now = this.deps.now?.() ?? Date.now();

    let text: string;
    try {
      text = await this.deps.ssh(UNRAID_SNAPSHOT_CMD);
      if (this.consecutiveSshFailures > 0) {
        this.deps.log.info(
          { tag: "unraid-watch", after: this.consecutiveSshFailures },
          "unraid snapshot recovered",
        );
      }
      this.consecutiveSshFailures = 0;
      this.sshFailureLogged = false;
    } catch (err) {
      // Transition-logged, not per-tick: a box that is off for a week must not
      // put 2000 lines in the journal.
      this.consecutiveSshFailures += 1;
      if (!this.sshFailureLogged) {
        this.sshFailureLogged = true;
        this.deps.log.warn(
          {
            tag: "unraid-watch",
            err: err instanceof Error ? err.message : String(err),
          },
          "unraid snapshot failed (will keep trying, no alert)",
        );
      }
      return;
    }

    const snap = parseUnraidSnapshot(text);
    if (!snap) {
      this.deps.log.warn(
        { tag: "unraid-watch", sample: text.slice(0, 200) },
        "unraid snapshot unparseable — skipping tick",
      );
      return;
    }

    this.points = recordUnraidPoint(this.points, snap, now, cfg);
    const breaches = evaluateUnraid({
      snap,
      points: this.points,
      previousOomCount: this.previousOomCount,
      cfg,
    });
    // Advance the OOM baseline AFTER evaluating. Rebaselining unconditionally
    // is what makes a RESET safe: the source is /var/log/syslog on a tmpfs, so
    // the counter drops to zero on reboot or rotation. evaluateUnraid only
    // pages on a POSITIVE delta, so a reset is silently absorbed here and the
    // next genuine kill still pages against the new, lower baseline. (This is
    // why the counter must never be read as an absolute — the same rule the
    // cgroup memory.events readers follow, with the extra wrinkle that this
    // source is not even monotonic within the box's life.)
    this.previousOomCount = snap.oomCount;

    // Sustain counters, same discipline as the fleet guard.
    const active = breaches.map((b) => b.key);
    const next: Record<string, number> = {};
    for (const key of active) next[key] = (this.sustain[key] ?? 0) + 1;
    this.sustain = next;

    const ready = breaches.filter(
      (b) => !b.requiresSustain || (this.sustain[b.key] ?? 0) >= cfg.sustainSamples,
    );

    this.deps.log.info(
      {
        tag: "unraid-watch",
        memAvailableMb: snap.memAvailableMb,
        memTotalMb: snap.memTotalMb,
        logUsedMb: snap.logUsedMb,
        logTotalMb: snap.logTotalMb,
        oomCount: snap.oomCount,
        activeBreaches: breaches.map((b) => b.key),
      },
      "unraid-watch sample",
    );

    if (ready.length === 0) return;

    const cooldown = raw.alertCooldownMs ?? DEFAULT_COOLDOWN_MS;
    const pageable = ready.filter((b) => {
      const last = this.lastPagedAt.get(b.key);
      if (last === undefined) return true;
      // Escalation is a ONE-WAY door through the cooldown: warn → critical
      // always pages. A repeated critical still waits out the window, so this
      // is an escape hatch for the transition, not a hole in the cooldown.
      if (last.severity === "warn" && b.severity === "critical") return true;
      return now - last.at >= cooldown;
    });
    if (pageable.length === 0) return;

    // The 4.9s docker-stats call is paid ONLY here — on a tick that has
    // already decided to page — because it exists to name the offender, not
    // to detect the problem.
    const container = pageable.some((b) => b.wantsOffender)
      ? await this.topContainer()
      : undefined;

    for (const breach of pageable) {
      this.lastPagedAt.set(breach.key, {
        at: now,
        severity: breach.severity,
      });
      try {
        await this.deps.postPage({
          key: breach.key,
          severity: breach.severity,
          message: breach.message,
          ...(breach.wantsOffender && container ? { container } : {}),
        });
      } catch (err) {
        this.deps.log.warn(
          {
            tag: "unraid-watch",
            key: breach.key,
            err: err instanceof Error ? err.message : String(err),
          },
          "unraid page failed (non-fatal)",
        );
      }
    }
  }

  private async topContainer(): Promise<UnraidContainer | undefined> {
    try {
      const out = await this.deps.ssh(UNRAID_CONTAINERS_CMD);
      return parseUnraidContainers(out)[0];
    } catch (err) {
      // The page still goes out, just without a named offender — better a
      // warning with less detail than no warning at all.
      this.deps.log.warn(
        {
          tag: "unraid-watch",
          err: err instanceof Error ? err.message : String(err),
        },
        "unraid container stats failed (paging without an offender)",
      );
      return undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// The action: restart ONE named container
// ---------------------------------------------------------------------------

/** Docker names are `[a-zA-Z0-9][a-zA-Z0-9_.-]*` — no colons, no shell metas. */
const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;

export function isValidContainerName(name: string): boolean {
  return CONTAINER_NAME.test(name);
}

export interface ContainerRestartDeps {
  readonly ssh: UnraidSsh;
  readonly log: Logger;
  readonly audit: (row: {
    at: string;
    container: string;
    actor: string;
    outcome: "restarted" | "refused" | "failed";
    detail: string;
  }) => Promise<void>;
  readonly now?: () => number;
}

/**
 * Restart one container. Operator-locked scope: nothing here touches the
 * array, VMs, parity, or caches.
 *
 * The name is validated against a strict allowlist pattern BEFORE it reaches a
 * shell — this string arrives from a Discord customId, and `docker restart` is
 * being invoked over SSH where a metacharacter would be a command injection,
 * not a typo.
 */
export async function restartUnraidContainer(
  name: string,
  actor: string,
  deps: ContainerRestartDeps,
): Promise<{ ok: boolean; message: string }> {
  const at = new Date(deps.now?.() ?? Date.now()).toISOString();
  if (!isValidContainerName(name)) {
    await safeAudit(deps, {
      at,
      container: name.slice(0, 64),
      actor,
      outcome: "refused",
      detail: "invalid container name",
    });
    return { ok: false, message: "⚠️ Refused — invalid container name." };
  }
  try {
    await deps.ssh(`docker restart ${name}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await safeAudit(deps, {
      at,
      container: name,
      actor,
      outcome: "failed",
      detail,
    });
    return { ok: false, message: `❌ Restart failed for \`${name}\`: ${detail}` };
  }
  await safeAudit(deps, {
    at,
    container: name,
    actor,
    outcome: "restarted",
    detail: "docker restart on operator request",
  });
  deps.log.warn(
    { tag: "unraid-watch", container: name, actor },
    "unraid container restarted on operator request",
  );
  return { ok: true, message: `✅ Restarted \`${name}\` on Unraid.` };
}

async function safeAudit(
  deps: ContainerRestartDeps,
  row: Parameters<ContainerRestartDeps["audit"]>[0],
): Promise<void> {
  try {
    await deps.audit(row);
  } catch (err) {
    deps.log.warn(
      {
        tag: "unraid-watch",
        err: err instanceof Error ? err.message : String(err),
      },
      "unraid audit write failed (action still happened)",
    );
  }
}
