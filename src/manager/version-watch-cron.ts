/**
 * Phase 999.169 — daily CLI + SDK version watch (croner-landmine-safe).
 *
 * Same shape as `model-monitor-cron.ts`: DI `cronFactory`, construction wrapped
 * in try/catch (a bad pattern degrades, never crashes the daemon —
 * INC-2026-06-04), and the tick body fully guarded. One extra run ~10 min after
 * boot so a skew or override introduced by a deploy is
 * reported the same day (Discord is connected by then; at `startDaemon` time
 * the admin post has no transport yet).
 *
 * Posts only UNSURFACED findings (persistent dedup), so a stable situation is
 * reported once, not daily. Resolved situations are pruned from the state so a
 * recurrence reports again; new-pair keys are kept (a release is news once).
 */

import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { Cron } from "croner";
import { compareCliVersions } from "../shared/cli-version.js";
import {
  evaluateVersions,
  fetchLatestPair,
  markSurfaced,
  renderAlert,
  unsurfaced,
  type FetchJson,
  type IconPrefix,
  type RegistryPair,
  type RuntimeTruth,
  type VersionFinding,
  type VersionWatchState,
} from "./version-watch.js";

/** Daily at 16:23 UTC (~09:23 PT). Static literal, never interpolated. */
export const VERSION_WATCH_CRON_PATTERN = "23 16 * * *";
export const VERSION_WATCH_FIRST_RUN_DELAY_MS = 10 * 60 * 1000;

export type VersionWatchCronHandle = { readonly stop: () => void };
export type VersionWatchCronFactory = (
  pattern: string,
  opts: { readonly name: string },
  callback: () => void | Promise<void>,
) => VersionWatchCronHandle;

const DEFAULT_FACTORY: VersionWatchCronFactory = (pattern, opts, callback) => {
  const cron = new Cron(pattern, { name: opts.name }, async () => {
    await callback();
  });
  return { stop: () => cron.stop() };
};

export type VersionWatchDeps = {
  readonly getRuntime: () => RuntimeTruth;
  readonly getHighestFloor: () => string | null;
  readonly fetchJson: FetchJson;
  readonly readState: () => VersionWatchState;
  readonly writeState: (state: VersionWatchState) => void;
  readonly postToAdminClawdy: (msg: string) => Promise<void>;
  readonly icon?: IconPrefix;
  readonly now: () => number;
  readonly log: {
    readonly info: (msg: string) => void;
    readonly warn: (msg: string) => void;
    readonly error: (msg: string) => void;
  };
};

/** Drop keys for situations that no longer hold; keep new-pair history. */
export function pruneResolved(state: VersionWatchState, current: readonly VersionFinding[]): VersionWatchState {
  const live = new Set(current.map((f) => f.key));
  const surfaced: Record<string, string> = {};
  for (const [k, v] of Object.entries(state.surfaced)) {
    if (k.startsWith("new-pair:") || live.has(k)) surfaced[k] = v;
  }
  return { surfaced };
}

export async function runVersionWatchTick(deps: VersionWatchDeps): Promise<{ readonly posted: number; readonly findings: number }> {
  const runtime = deps.getRuntime();
  let latest: RegistryPair | null = null;
  let registryError: string | null = null;
  try {
    latest = await fetchLatestPair(
      deps.fetchJson,
      (sdk) => runtime.sdkVersion !== null && (compareCliVersions(sdk, runtime.sdkVersion) ?? 0) > 0,
    );
  } catch (err) {
    registryError = err instanceof Error ? err.message : String(err);
    deps.log.warn(`[version-watch] npm registry unavailable: ${registryError}`);
  }
  const findings = evaluateVersions(
    {
      latest,
      registryError,
      runtime,
      highestFloor: deps.getHighestFloor(),
      now: deps.now(),
    },
    deps.icon,
  );
  const state = pruneResolved(deps.readState(), findings);
  const fresh = unsurfaced(findings, state);
  if (fresh.length === 0) {
    deps.writeState(state);
    return { posted: 0, findings: findings.length };
  }
  await deps.postToAdminClawdy(renderAlert(fresh, deps.icon));
  deps.writeState(markSurfaced(state, fresh, deps.now()));
  deps.log.info(`[version-watch] surfaced ${fresh.map((f) => f.key).join(", ")}`);
  return { posted: fresh.length, findings: findings.length };
}

/** Timer handle from `schedule` — `unref` is optional (tests pass plain objects). */
export type ScheduledHandle = { unref?: () => void };

export type VersionWatchRegistration = {
  readonly registered: boolean;
  readonly reason?: string;
  readonly stop?: () => void;
};

export function registerVersionWatchCron(
  deps: VersionWatchDeps & {
    readonly cronFactory?: VersionWatchCronFactory;
    readonly schedule?: (fn: () => void, ms: number) => ScheduledHandle | undefined;
    readonly cancel?: (handle: ScheduledHandle) => void;
    readonly firstRunDelayMs?: number;
  },
): VersionWatchRegistration {
  const onTick = async (): Promise<void> => {
    try {
      await runVersionWatchTick(deps);
    } catch (err) {
      deps.log.error(`[version-watch] tick crashed (caught): ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  let handle: VersionWatchCronHandle;
  try {
    handle = (deps.cronFactory ?? DEFAULT_FACTORY)(VERSION_WATCH_CRON_PATTERN, { name: "version-watch" }, onTick);
  } catch (err) {
    deps.log.error(`[version-watch] cron construction failed: ${err instanceof Error ? err.message : String(err)}`);
    return { registered: false, reason: "pattern-error" };
  }
  const schedule = deps.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancel =
    deps.cancel ?? ((h: ScheduledHandle) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>));
  const timer = schedule(() => {
    void onTick();
  }, deps.firstRunDelayMs ?? VERSION_WATCH_FIRST_RUN_DELAY_MS);
  timer?.unref?.();
  return {
    registered: true,
    stop: () => {
      // A stop before the delayed first run must cancel it too (shutdown, tests).
      if (timer !== undefined) cancel(timer);
      handle.stop();
    },
  };
}

/** JSON state file, written atomically; a missing/corrupt file reads as empty. */
export function fileStateStore(path: string): {
  readonly read: () => VersionWatchState;
  readonly write: (s: VersionWatchState) => void;
} {
  return {
    read: () => {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as { surfaced?: unknown };
        return parsed.surfaced !== null && typeof parsed.surfaced === "object"
          ? { surfaced: parsed.surfaced as Record<string, string> }
          : { surfaced: {} };
      } catch {
        return { surfaced: {} };
      }
    },
    write: (s) => {
      const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o644 });
      renameSync(tmp, path);
    },
  };
}

/** Registry fetch with a hard timeout. */
export const defaultFetchJson: FetchJson = async (url) => {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return (await res.json()) as unknown;
};
