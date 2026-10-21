/**
 * Phase 91 Plan 01 Task 2 — Sync runner (SYNC-01 + SYNC-02 + SYNC-05 + SYNC-07).
 *
 * Pure-function entry point `syncOnce()` that drives one continuous-sync
 * cycle: OpenClaw → ClawCode via rsync-over-SSH. Invoked by:
 *   - scripts/sync/clawcode-sync.sh (systemd timer, 5-min cadence)
 *   - Plan 91-04's `clawcode sync run-once` CLI subcommand (on-demand)
 *
 * Responsibilities:
 *   1. Read sync-state.json; bail with `paused` outcome when
 *      authoritativeSide === "clawcode" and reverse sync is not yet
 *      opted in (D-18). This is how the 5-min timer becomes a no-op
 *      post-cutover without needing to be disabled.
 *   2. Spawn rsync with the Plan 91-01 filter file, include/exclude list,
 *      --delete, --partial, --inplace, --itemize-changes, --stats.
 *   3. Parse --itemize-changes + --stats stdout into
 *      {filesAdded, filesUpdated, filesRemoved, bytesTransferred, touchedPaths}.
 *   4. Recompute sha256 of each touched destination file; merge into
 *      perFileHashes. This is the baseline that Plan 91-02's conflict
 *      detection will compare against on the next cycle.
 *   5. Atomically persist the updated sync-state.json.
 *   6. Append one JSONL entry to ~/.clawcode/manager/sync.jsonl with the
 *      SyncRunOutcome shape flattened (SYNC-07 observability contract).
 *
 * Not in scope (deferred to later plans):
 *   - Conflict detection + skip logic (Plan 91-02)
 *   - Discord alerting (Plan 91-02)
 *   - CLI command registration (Plan 91-04)
 *   - Reverse direction implementation (Plan 91-04)
 *   - Log rotation (Plan 91-05)
 *
 * All I/O is DI-injected via `SyncRunnerDeps` so tests can inject a fake
 * rsync runner + fake appender without touching real hosts or filesystems.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import { nanoid } from "nanoid";
import {
  readSyncState,
  updateSyncStateConflict,
  writeSyncState,
} from "./sync-state-store.js";
import type {
  SyncConflict,
  SyncJsonlEntry,
  SyncRunOutcome,
  SyncStateFile,
} from "./types.js";
import {
  detectConflicts,
  type FileHashPair,
} from "./conflict-detector.js";
import {
  ADMIN_CLAWDY_CHANNEL_ID,
  sendConflictAlert,
  type ConflictAlertDeps,
} from "./conflict-alerter.js";

// ---------------------------------------------------------------------------
// Dependency injection struct
// ---------------------------------------------------------------------------

/**
 * rsync process execution signature. Default impl spawns a real rsync via
 * node:child_process.execFile (see `defaultRsyncRunner` below). Tests
 * inject a fake that returns canned stdout/stderr/exitCode.
 */
export type RsyncRunner = (
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/**
 * JSONL appender signature. Default impl does mkdir + appendFile. Tests
 * inject a recorder that captures each entry as a JS object.
 */
export type JsonlAppender = (
  filePath: string,
  entry: SyncJsonlEntry,
) => Promise<void>;

/**
 * Hash-the-destination-file signature — isolated for testability. Default
 * impl reads via fs.readFile + computes sha256. Tests stub the output map.
 */
export type DestHasher = (absPath: string) => Promise<string | null>;

/**
 * Probe for source-side (OpenClaw) sha256 hashes keyed by relpath.
 *
 * Plan 91-02 Task 2: used PRE-rsync to enumerate candidate files + their
 * source hashes so `detectConflicts` can classify each vs the dest's
 * current sha256 + sync-state's perFileHashes baseline.
 *
 * Default impl runs `ssh <host> 'cd <workspace> && find ... | xargs
 * sha256sum'` — isolated here so tests don't need a real SSH tunnel.
 */
export type SourceHashProbe = (
  relpaths: readonly string[],
) => Promise<ReadonlyMap<string, string>>;

/**
 * Dry-run rsync — returns the list of relpaths that WOULD transfer this
 * cycle, without actually transferring anything. Plan 91-02 Task 2 uses
 * this to enumerate candidates before the real run.
 *
 * Default impl adds `-n` (--dry-run) to the normal rsync argv + parses
 * `-i` itemize lines the same way parseRsyncStats does. Separate DI slot
 * from `runRsync` so tests can simulate "10 candidates → 2 conflicts"
 * without entangling the real-run stub.
 */
export type DryRunRsync = (
  baseArgs: readonly string[],
) => Promise<{
  readonly candidateRelpaths: readonly string[];
  readonly stderr: string;
  readonly exitCode: number;
}>;

export type SyncRunnerDeps = {
  readonly syncStatePath: string;
  readonly filterFilePath: string;
  readonly syncJsonlPath: string;
  readonly log: Logger;
  readonly now?: () => Date;
  readonly runRsync?: RsyncRunner;
  readonly appendJsonl?: JsonlAppender;
  readonly hashDest?: DestHasher;
  /** Plan 91-02 — probe OpenClaw source sha256 for candidate files. */
  readonly probeSourceHashes?: SourceHashProbe;
  /** Plan 91-02 — dry-run rsync to enumerate candidates without transfer. */
  readonly dryRunRsync?: DryRunRsync;
  /** Plan 91-02 — bot token for fire-and-forget conflict alerts. */
  readonly alertBotToken?: string;
  /** Plan 91-02 — override admin-clawdy channel (default ADMIN_CLAWDY_CHANNEL_ID). */
  readonly alertChannelId?: string;
  /** Plan 91-02 — fetch DI for tests. */
  readonly alertFetch?: typeof fetch;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run one sync cycle. Returns a SyncRunOutcome discriminated union.
 *
 * All outcomes (including failures) append exactly one line to sync.jsonl
 * before returning — so the observability log is never "lost" due to an
 * early return. If the JSONL append itself fails, we warn and swallow
 * (log availability cannot block sync success).
 */
export async function syncOnce(deps: SyncRunnerDeps): Promise<SyncRunOutcome> {
  const cycleId = nanoid();
  const start = deps.now?.() ?? new Date();
  const startMs = start.getTime();
  const elapsed = () => (deps.now?.() ?? new Date()).getTime() - startMs;

  const state = await readSyncState(deps.syncStatePath, deps.log);

  // D-01 + D-18: while authoritativeSide === "clawcode", sync is paused.
  // Plan 91-04 will introduce `reverseEnabled`; for now, any clawcode-side
  // authoritative flag means "do nothing this cycle".
  if (state.authoritativeSide === "clawcode") {
    const outcome: SyncRunOutcome = {
      kind: "paused",
      cycleId,
      reason: "authoritative-is-clawcode-no-reverse-opt-in",
    };
    await appendOutcomeToJsonl(deps, outcome, start);
    deps.log.info(
      { cycleId, reason: outcome.reason },
      "sync cycle paused — authoritativeSide=clawcode",
    );
    return outcome;
  }

  // Phase 96 D-11: when authoritativeSide === "deprecated", the Phase 91
  // mirror is disabled; agents read source-of-truth via ACL. Short-circuit:
  // no rsync, no alert, ledger-only at info level (informational, not warn).
  // Operator restores via `clawcode sync re-enable-timer` within
  // DEPRECATION_ROLLBACK_WINDOW_MS of state.deprecatedAt.
  if (state.authoritativeSide === "deprecated") {
    const outcome: SyncRunOutcome = {
      kind: "deprecated",
      cycleId,
      reason: "phase-91-mirror-deprecated; agents read source via ACL",
    };
    await appendOutcomeToJsonl(deps, outcome, start);
    deps.log.info(
      { cycleId, reason: outcome.reason, deprecatedAt: state.deprecatedAt },
      "sync cycle skipped — Phase 91 mirror deprecated",
    );
    return outcome;
  }

  // Build rsync command. SSH options are verbatim from D-04 runbook:
  //   BatchMode=yes            → never prompt for password (key-only auth)
  //   ConnectTimeout=10        → bail fast on Tailscale outage
  //   StrictHostKeyChecking=accept-new  → auto-trust first connection
  const baseRsyncArgs: readonly string[] = [
    "-av",
    "--filter",
    `merge ${deps.filterFilePath}`,
    "--delete",
    "--partial",
    "--inplace",
    "--itemize-changes",
    "--stats",
    "--timeout=120",
    "-e",
    "ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new",
    `${state.openClawHost}:${state.openClawWorkspace}/`,
    `${state.clawcodeWorkspace}/`,
  ];

  // Plan 91-02 conflict-detection pre-flight. Engages ONLY when BOTH the
  // dryRunRsync + probeSourceHashes probes are wired (production or test
  // injection). Plan 91-01 tests don't wire them, so this block is a no-op
  // there — full backward compatibility with the Wave 1 contract.
  const conflicts: SyncConflict[] = [];
  const excludeArgs: string[] = [];
  const hashDestForProbe = deps.hashDest ?? ((abs) => defaultDestHasher(abs));
  if (deps.dryRunRsync && deps.probeSourceHashes) {
    try {
      const dryRun = await deps.dryRunRsync(baseRsyncArgs);
      if (dryRun.exitCode !== 0 && dryRun.exitCode !== 23) {
        // Dry-run failed — skip conflict detection this cycle, let the
        // real rsync below surface the real failure. Don't swallow.
        deps.log.warn(
          { cycleId, exitCode: dryRun.exitCode, stderr: dryRun.stderr.slice(0, 500) },
          "sync dry-run failed; proceeding without conflict detection",
        );
      } else if (dryRun.candidateRelpaths.length > 0) {
        // Probe source hashes (ssh + sha256sum) + dest hashes (local) for
        // every candidate, then run the pure detectConflicts partition.
        const sourceHashes = await deps.probeSourceHashes(
          dryRun.candidateRelpaths,
        );
        const pairs: FileHashPair[] = [];
        for (const relpath of dryRun.candidateRelpaths) {
          const srcHash = sourceHashes.get(relpath);
          if (srcHash === undefined) continue; // missing on source — skip
          const absDest = join(state.clawcodeWorkspace, relpath);
          let destHash: string | null;
          try {
            destHash = await hashDestForProbe(absDest);
          } catch (err) {
            deps.log.warn({ relpath, err }, "sync pre-probe dest hash failed");
            destHash = null;
          }
          pairs.push({ path: relpath, sourceHash: srcHash, destHash });
        }
        const detection = detectConflicts(state.perFileHashes, pairs, start);
        for (const c of detection.conflicts) {
          conflicts.push(c);
          // rsync --exclude targets relpaths from the source root. Each
          // conflicting path becomes a per-cycle skip (D-12: per-FILE,
          // not per-CYCLE — other clean files still propagate).
          excludeArgs.push(`--exclude=${c.path}`);
        }
        if (conflicts.length > 0) {
          deps.log.info(
            { cycleId, conflictCount: conflicts.length },
            "sync conflicts detected — excluding from this cycle",
          );
        }
      }
    } catch (err) {
      // Conflict detection itself errored — log + proceed without it.
      // The real rsync below will still run; next cycle will retry.
      deps.log.warn(
        { cycleId, err },
        "sync conflict-detection pre-flight failed; proceeding without it",
      );
    }
  }

  const rsyncArgs: readonly string[] = [...baseRsyncArgs, ...excludeArgs];

  const runRsync = deps.runRsync ?? defaultRsyncRunner;
  let result: { stdout: string; stderr: string; exitCode: number };
  try {
    result = await runRsync(rsyncArgs);
  } catch (err) {
    // SSH tunnel failed before rsync produced output, or rsync binary
    // is missing. Either way: graceful degradation (D-04) — warn, append
    // JSONL, return failed-ssh. Daemon/timer untouched.
    const outcome: SyncRunOutcome = {
      kind: "failed-ssh",
      cycleId,
      error: err instanceof Error ? err.message : String(err),
      durationMs: elapsed(),
    };
    await appendOutcomeToJsonl(deps, outcome, start);
    deps.log.warn({ cycleId, err }, "sync ssh/spawn failed");
    return outcome;
  }

  // exit 0 = success, 23 = "partial transfer due to error" (acceptable
  // for --delete on files rsync couldn't read; Plan 91-02 treats this
  // as conflict-skip). Any other non-zero is a real rsync failure.
  if (result.exitCode !== 0 && result.exitCode !== 23) {
    const outcome: SyncRunOutcome = {
      kind: "failed-rsync",
      cycleId,
      error: result.stderr.slice(0, 4000),
      durationMs: elapsed(),
      exitCode: result.exitCode,
    };
    await appendOutcomeToJsonl(deps, outcome, start);
    deps.log.warn(
      { cycleId, exitCode: result.exitCode, stderr: result.stderr.slice(0, 500) },
      "sync rsync failed",
    );
    return outcome;
  }

  const parsed = parseRsyncStats(result.stdout);

  // Regression pin for R7: if rsync somehow propagated a *.sqlite or
  // /sessions/** path into touchedPaths, something upstream broke the
  // filter file. Fail loud instead of silently writing a hash for it.
  for (const p of parsed.touchedPaths) {
    if (p.endsWith(".sqlite") || p.endsWith(".sqlite-shm") || p.endsWith(".sqlite-wal")) {
      throw new Error(
        `filter-file regression: .sqlite path leaked into rsync output: ${p}`,
      );
    }
    if (p.startsWith("sessions/") || p === "sessions" || p.includes("/sessions/")) {
      throw new Error(
        `filter-file regression: sessions/ path leaked into rsync output: ${p}`,
      );
    }
  }

  // Early-out: nothing changed this cycle AND no conflicts to record.
  if (
    parsed.filesAdded + parsed.filesUpdated + parsed.filesRemoved === 0 &&
    conflicts.length === 0
  ) {
    const outcome: SyncRunOutcome = {
      kind: "skipped-no-changes",
      cycleId,
      durationMs: elapsed(),
    };
    await appendOutcomeToJsonl(deps, outcome, start);
    deps.log.debug({ cycleId }, "sync skipped — no file changes");
    return outcome;
  }

  // Recompute sha256 for each touched destination file. This is the
  // baseline Plan 91-02 will compare against next cycle to detect
  // operator-edited conflicts.
  const hashDest = deps.hashDest ?? ((abs) => defaultDestHasher(abs));
  const updatedHashes: Record<string, string> = { ...state.perFileHashes };
  for (const relpath of parsed.touchedPaths) {
    const absDest = join(state.clawcodeWorkspace, relpath);
    try {
      const hash = await hashDest(absDest);
      if (hash === null) {
        // File removed or unreadable — drop its entry.
        delete updatedHashes[relpath];
      } else {
        updatedHashes[relpath] = hash;
      }
    } catch (err) {
      // Hash failure is non-fatal — we still recorded the transfer in
      // JSONL; the missing hash just means next cycle re-computes it.
      deps.log.warn({ relpath, err }, "sync dest hash failed");
      delete updatedHashes[relpath];
    }
  }

  const nextState: SyncStateFile = {
    ...state,
    updatedAt: start.toISOString(),
    lastSyncedAt: start.toISOString(),
    perFileHashes: updatedHashes,
  };
  await writeSyncState(deps.syncStatePath, nextState, deps.log);

  // Plan 91-02: persist each conflict to sync-state.json.conflicts[] via
  // updateSyncStateConflict (idempotent — duplicate unresolved conflicts
  // collapse). Writes happen sequentially so the final sync-state.json
  // reflects the full set. If persistence fails mid-list, operators still
  // see SOME conflicts + can diagnose via sync.jsonl.
  for (const c of conflicts) {
    try {
      await updateSyncStateConflict(deps.syncStatePath, c, deps.log);
    } catch (err) {
      deps.log.warn(
        { cycleId, path: c.path, err },
        "sync conflict persistence failed",
      );
    }
  }

  const outcome: SyncRunOutcome =
    conflicts.length > 0
      ? {
          kind: "partial-conflicts",
          cycleId,
          filesAdded: parsed.filesAdded,
          filesUpdated: parsed.filesUpdated,
          filesRemoved: parsed.filesRemoved,
          filesSkippedConflict: conflicts.length,
          bytesTransferred: parsed.bytesTransferred,
          durationMs: elapsed(),
          conflicts: Object.freeze([...conflicts]),
        }
      : {
          kind: "synced",
          cycleId,
          filesAdded: parsed.filesAdded,
          filesUpdated: parsed.filesUpdated,
          filesRemoved: parsed.filesRemoved,
          filesSkippedConflict: 0,
          bytesTransferred: parsed.bytesTransferred,
          durationMs: elapsed(),
        };
  await appendOutcomeToJsonl(deps, outcome, start);

  // Plan 91-02 D-15: fire-and-forget conflict alert. `.catch(log.warn)`
  // ensures Discord unavailability never bubbles up to our caller. Every
  // cycle that ends with conflicts fires — operators need visibility on
  // ongoing divergence (same-cycle suppression would hide persistent
  // issues).
  if (conflicts.length > 0 && deps.alertBotToken) {
    const alertDeps: ConflictAlertDeps = {
      botToken: deps.alertBotToken,
      channelId: deps.alertChannelId ?? ADMIN_CLAWDY_CHANNEL_ID,
      log: deps.log,
      fetchImpl: deps.alertFetch,
      now: deps.now,
    };
    void sendConflictAlert(conflicts, cycleId, alertDeps).catch((err) => {
      deps.log.warn(
        { cycleId, err },
        "conflict-alert fire-and-forget failed",
      );
    });
  }
  deps.log.info(
    {
      cycleId,
      added: parsed.filesAdded,
      updated: parsed.filesUpdated,
      removed: parsed.filesRemoved,
      bytes: parsed.bytesTransferred,
    },
    "sync cycle complete",
  );
  return outcome;
}

// ---------------------------------------------------------------------------
// rsync --itemize-changes + --stats parser (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Parse rsync's `-i --stats` stdout into counts + touched paths.
 *
 * rsync --itemize-changes format per line: "YXcstpoguax path"
 *   - First char 'Y': '>' = receiving, '<' = sending, '*' = message,
 *     'c' = local change/creation, 'h' = hard-link, '.' = no change
 *   - Second char 'X': 'f' = file, 'd' = directory, 'L' = symlink, etc.
 *   - Remaining chars: attribute change flags (c=checksum, s=size,
 *     t=time, p=perms, o=owner, g=group, u=U, a=ACL, x=xattr).
 *     '+' in a slot means the file is being added.
 *
 * Examples:
 *   >f+++++++++ MEMORY.md           (new file received)
 *   >f..t...... SOUL.md             (timestamp-only update)
 *   >f.st...... memory/2026-04-24.md (size+time update)
 *   *deleting   old-note.md         (file deleted)
 *   cd+++++++++ memory/             (directory created — skip, not a file)
 *
 * --stats block ends with lines like:
 *   Total transferred file size: 12,456 bytes
 *
 * We accept commas in the byte count (locale-formatted on some systems).
 */
export function parseRsyncStats(stdout: string): {
  filesAdded: number;
  filesUpdated: number;
  filesRemoved: number;
  bytesTransferred: number;
  touchedPaths: readonly string[];
} {
  let filesAdded = 0;
  let filesUpdated = 0;
  let filesRemoved = 0;
  const touchedPaths: string[] = [];

  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    // "*deleting path" — always starts with '*deleting '
    const del = line.match(/^\*deleting\s+(.+?)\s*$/);
    if (del?.[1]) {
      const p = del[1].trim();
      // Skip directory deletions (trailing slash) — we care about files.
      if (!p.endsWith("/")) {
        filesRemoved++;
        touchedPaths.push(p);
      }
      continue;
    }

    // Itemize format: 11 chars, space, path. Second char must be 'f' for
    // files (skip directories 'd', symlinks 'L').
    //   ^([<>ch.*])([fdLDSps])([cstpoguax.+?]{9})\s+(.+)$
    const it = line.match(
      /^([<>ch.*])([fdLDSps])([cstpoguax.+?]{9})\s+(.+?)\s*$/,
    );
    if (!it) continue;
    const [, , fileType, flags, rawPath] = it;
    if (fileType !== "f") continue; // skip non-files

    const path = rawPath.trim();
    if (path === "") continue;

    // '+' in the size slot (index 2 of flags, 0-indexed) → new file added.
    // rsync puts '+' in EVERY slot for a brand-new file, so checking one
    // representative slot is sufficient. We use flags[0] === '+' which
    // corresponds to the 'c' (checksum) slot — always '+' on new files.
    if (flags.startsWith("+++++++++")) {
      filesAdded++;
      touchedPaths.push(path);
    } else {
      filesUpdated++;
      touchedPaths.push(path);
    }
  }

  // Pull bytes from --stats block.
  const bytesMatch = stdout.match(
    /Total transferred file size:\s*([\d,]+)\s*bytes/,
  );
  const bytesTransferred = bytesMatch?.[1]
    ? parseInt(bytesMatch[1].replace(/,/g, ""), 10)
    : 0;

  return {
    filesAdded,
    filesUpdated,
    filesRemoved,
    bytesTransferred: Number.isFinite(bytesTransferred) ? bytesTransferred : 0,
    touchedPaths,
  };
}

// ---------------------------------------------------------------------------
// Default implementations (overridable via SyncRunnerDeps)
// ---------------------------------------------------------------------------

async function defaultRsyncRunner(
  args: readonly string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // Late-load child_process so ESM module evaluation doesn't force it on
  // test workers that mock everything. Mirrors the pattern used in
  // src/marketplace/clawhub-client.ts (execFile via promisify).
  const { execFile } = await import("node:child_process");
  return await new Promise((resolve) => {
    // maxBuffer bumped to 16MB — --itemize-changes + 513MB uploads dir can
    // produce tens of thousands of lines on a full-sync cycle.
    const child = execFile(
      "rsync",
      args as string[],
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // execFile's callback fires with err=null on success, err.code=N
        // on non-zero exit. We want to resolve — not reject — so the
        // caller can branch on exitCode cleanly.
        const exitCode =
          err && typeof (err as NodeJS.ErrnoException).code === "number"
            ? ((err as NodeJS.ErrnoException).code as unknown as number)
            : err
              ? 1
              : 0;
        resolve({
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? "",
          exitCode,
        });
      },
    );
    // If rsync can't even spawn (e.g., binary missing), execFile calls
    // the callback with an error; the block above already handles it.
    child.on("error", () => {
      /* callback path handles it; avoid double-resolve */
    });
  });
}

async function defaultDestHasher(absPath: string): Promise<string | null> {
  try {
    const buf = await readFile(absPath);
    return createHash("sha256").update(buf).digest("hex");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Append the outcome as a flat JSONL line for SYNC-07 observability.
 * Errors in the appender itself warn + swallow — one missing log line
 * must not block the sync from completing.
 */
async function appendOutcomeToJsonl(
  deps: SyncRunnerDeps,
  outcome: SyncRunOutcome,
  start: Date,
): Promise<void> {
  const entry: SyncJsonlEntry = flattenOutcomeToJsonl(outcome, start);
  const appender = deps.appendJsonl ?? defaultJsonlAppender;
  try {
    await appender(deps.syncJsonlPath, entry);
  } catch (err) {
    deps.log.warn({ err }, "sync.jsonl append failed");
  }
}

/**
 * Flatten a SyncRunOutcome discriminated union into a JSONL-friendly flat
 * object. Consumers (Plan 91-05 Discord reports, jq one-liners) can key
 * off `status` alone; the union kind maps 1:1 onto that field.
 */
export function flattenOutcomeToJsonl(
  outcome: SyncRunOutcome,
  start: Date,
): SyncJsonlEntry {
  const base = {
    timestamp: start.toISOString(),
    cycleId: outcome.cycleId,
    direction: "openclaw-to-clawcode" as const,
    status: outcome.kind,
  };
  switch (outcome.kind) {
    case "synced":
      return {
        ...base,
        filesAdded: outcome.filesAdded,
        filesUpdated: outcome.filesUpdated,
        filesRemoved: outcome.filesRemoved,
        filesSkippedConflict: outcome.filesSkippedConflict,
        bytesTransferred: outcome.bytesTransferred,
        durationMs: outcome.durationMs,
      };
    case "partial-conflicts":
      return {
        ...base,
        filesAdded: outcome.filesAdded,
        filesUpdated: outcome.filesUpdated,
        filesRemoved: outcome.filesRemoved,
        filesSkippedConflict: outcome.filesSkippedConflict,
        bytesTransferred: outcome.bytesTransferred,
        durationMs: outcome.durationMs,
      };
    case "skipped-no-changes":
      return { ...base, durationMs: outcome.durationMs };
    case "paused":
      return { ...base, reason: outcome.reason };
    case "deprecated":
      return { ...base, reason: outcome.reason };
    case "failed-ssh":
      return { ...base, error: outcome.error, durationMs: outcome.durationMs };
    case "failed-rsync":
      return {
        ...base,
        error: outcome.error,
        durationMs: outcome.durationMs,
        exitCode: outcome.exitCode,
      };
  }
}

async function defaultJsonlAppender(
  filePath: string,
  entry: SyncJsonlEntry,
): Promise<void> {
  const { appendFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, JSON.stringify(entry) + "\n", "utf8");
}
