/**
 * Phase 999.6 — Pre-deploy running-fleet snapshot.
 *
 * Operator pain this fixes: every `systemctl restart clawcode` (5+/day) loses
 * the runtime fleet — agents the operator manually started for the day stay
 * dead until they remember to restart each one. This module captures the
 * in-memory running-agent set on SIGTERM/SIGINT and restores it on next boot
 * by unioning into the static `autoStart=true` set, then deletes the file
 * so the NEXT normal restart honors yaml `autoStart` only.
 *
 * Design invariants (locked per 999.6-CONTEXT.md / 999.6-RESEARCH.md):
 *
 *   1. **Single writer.** Only the daemon writes this file, and only from
 *      inside `shutdown()`. Atomic rename guarantees concurrent reads see
 *      old or new content, never a half-written file. If the operator
 *      double-Ctrl-C's (two SIGTERMs in <1s), the second writer's rename
 *      clobbers the first — final on-disk state is consistent.
 *
 *   2. **SIGKILL bypasses everything.** If systemd's TimeoutStopSec elapses
 *      and SIGKILL is delivered, the writer never runs and the next boot
 *      loses the running fleet. Same fleet-loss behavior as today —
 *      acceptable. Mitigation: writer runs at the FIRST line of shutdown()
 *      so the JSON lands on disk well before any later step can hang.
 *
 *   3. **Read deletes BEFORE returning, always.** Even on the success path.
 *      This prevents an infinite auto-revive loop if downstream `startAll`
 *      partial-fails — the snapshot has been "applied" the moment we
 *      committed to the autoStart override. Re-applying on the next boot
 *      would double-start the same fleet.
 *
 *   4. **Sub-second restart races: documented limitation.** If SIGTERM
 *      arrives DURING boot (between snapshot read and startAll completion),
 *      the new shutdown writer captures a partial sessions map and the
 *      operator loses agents not yet started. Recoverable via manual
 *      `clawcode start <name>`. Adding boot-still-in-progress guards would
 *      expand scope without meaningfully reducing the operator-pain
 *      surface.
 */
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod/v4";
import type { Logger } from "pino";

/**
 * On-disk shape of `pre-deploy-snapshot.json`. `version: 1` is a literal so
 * future format migrations can fan out via discriminated unions; today's
 * reader rejects anything else (warn + delete) per CONTEXT.md.
 *
 * `sessionId` is informational only — the daemon spawns fresh sessions on
 * boot and never resumes via this id (per CONTEXT.md "NOT used for
 * restore"). Including it helps operators audit "what was running where"
 * when correlating journal entries with the prior process.
 */
export const preDeploySnapshotSchema = z.object({
  version: z.literal(1),
  snapshotAt: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), {
      message: "invalid ISO timestamp",
    }),
  snapshotPid: z.number().int().positive(),
  runningAgents: z.array(
    z.object({
      name: z.string().min(1),
      sessionId: z.string().nullable(),
    }),
  ),
});

export type PreDeploySnapshot = z.infer<typeof preDeploySnapshotSchema>;

/**
 * Canonical on-host path. The daemon imports this when wiring the writer
 * (top of shutdown()) and reader (top of boot path). Lives alongside
 * registry.json / effort-state.json / tasks.db under ~/.clawcode/manager.
 */
export const DEFAULT_PRE_DEPLOY_SNAPSHOT_PATH: string = join(
  homedir(),
  ".clawcode",
  "manager",
  "pre-deploy-snapshot.json",
);

/**
 * Atomically write the running-fleet snapshot.
 *
 * Idiom mirrors `effort-state-store.ts:131-148` verbatim: write to a
 * `<path>.<rand>.tmp` file in the same directory, then `rename()` to the
 * final path. POSIX rename is atomic within a filesystem — readers either
 * see the prior file or the new one, never half-written content.
 *
 * Throws on hard fs errors so the daemon's outer try/catch can warn
 * (non-fatal — boot falls back to static autoStart).
 */
export async function writePreDeploySnapshot(
  filePath: string,
  runningAgents: ReadonlyArray<{ name: string; sessionId: string | null }>,
  log: Logger,
): Promise<void> {
  const writeLog = log.child({ component: "snapshot-restore" });
  const next: PreDeploySnapshot = {
    version: 1,
    snapshotAt: new Date().toISOString(),
    snapshotPid: process.pid,
    runningAgents: [...runningAgents],
  };
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await rename(tmp, filePath);
  writeLog.info(
    { filePath, agentCount: next.runningAgents.length },
    "pre-deploy snapshot written",
  );
}

/**
 * Read the snapshot, validate, stale-guard, filter unknown agents, **delete
 * the file before returning**, and return the set of agent names eligible
 * for boot auto-start override.
 *
 * Tolerance contract:
 *   - Missing file (ENOENT)        → empty set, NO log (silent normal boot)
 *   - Other fs error               → empty set, warn log
 *   - Malformed JSON / schema bad  → empty set, warn log, file deleted
 *   - Stale (> maxAgeHours)        → empty set, warn log, file deleted
 *   - Unknown agent name in entry  → entry dropped with warn log; valid
 *                                    entries still returned
 *
 * Never throws to caller — boot must never block on snapshot.
 *
 * `maxAgeHours` is normalized belt-and-suspenders: any non-finite /
 * non-positive input falls back to 24h (defensive against zod default
 * bypass paths — see 999.6-RESEARCH.md Pitfall 5).
 */
export async function readAndConsumePreDeploySnapshot(
  filePath: string,
  knownAgentNames: ReadonlySet<string>,
  maxAgeHours: number,
  log: Logger,
): Promise<ReadonlySet<string>> {
  const restoreLog = log.child({ component: "snapshot-restore" });

  const safeMaxAge =
    typeof maxAgeHours === "number" &&
    Number.isFinite(maxAgeHours) &&
    maxAgeHours > 0
      ? maxAgeHours
      : 24;

  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // Normal first-boot or post-consume path — no snapshot exists. Silent.
      return new Set<string>();
    }
    restoreLog.warn(
      { filePath, error: (err as Error).message },
      "snapshot read failed — falling back to static autoStart",
    );
    return new Set<string>();
  }

  let parsed: PreDeploySnapshot;
  try {
    const json: unknown = JSON.parse(raw);
    parsed = preDeploySnapshotSchema.parse(json);
  } catch (err) {
    restoreLog.warn(
      { filePath, error: (err as Error).message },
      "snapshot malformed — deleting and falling back to static autoStart",
    );
    await unlink(filePath).catch(() => {
      /* best-effort */
    });
    return new Set<string>();
  }

  const ageMs = Date.now() - Date.parse(parsed.snapshotAt);
  const ageHours = ageMs / (1000 * 60 * 60);
  if (ageHours > safeMaxAge) {
    restoreLog.warn(
      {
        snapshotAgeHours: Number(ageHours.toFixed(1)),
        maxAgeHours: safeMaxAge,
      },
      "discarding stale snapshot (>maxAgeHours) — falling back to static autoStart",
    );
    await unlink(filePath).catch(() => {
      /* best-effort */
    });
    return new Set<string>();
  }

  // Filter snapshot entries to names that still exist in current config.
  // Immutable build — accumulate into a fresh Set, never mutate inputs.
  const restored = new Set<string>();
  for (const entry of parsed.runningAgents) {
    if (knownAgentNames.has(entry.name)) {
      restored.add(entry.name);
    } else {
      restoreLog.warn(
        { agent: entry.name },
        "snapshot references unknown agent — skipping",
      );
    }
  }

  restoreLog.info(
    {
      snapshotAt: parsed.snapshotAt,
      snapshotPid: parsed.snapshotPid,
      agentCount: restored.size,
    },
    `applying pre-deploy snapshot — ${restored.size} agents will be auto-started`,
  );

  // DELETE BEFORE RETURNING (locked decision) — even on success. Prevents
  // infinite auto-revive loops if startAll partial-fails downstream.
  await unlink(filePath).catch((err: unknown) =>
    restoreLog.warn(
      { err: (err as Error).message },
      "snapshot delete failed (will be overwritten next shutdown)",
    ),
  );
  restoreLog.info(
    { deletedSnapshotPath: filePath },
    "snapshot consumed — next restart will honor static autoStart config",
  );

  return restored;
}
