/**
 * Phase 999.99 follow-up — durable persistence for RUNTIME recurring schedules.
 *
 * `SchedulerSource.addRecurringSchedule` (the `schedule_recurring` MCP tool)
 * registered cron jobs IN MEMORY ONLY → every agent-created schedule silently
 * died on the next daemon restart. Operator-defined `schedules:` in
 * `/etc/clawcode/clawcode.yaml` survive, but agents can't write that root-owned
 * file. This store is the agent-self-service durable path: a daemon-owned JSON
 * file the daemon writes on add/cancel and re-registers from on boot.
 *
 * Persistence file lives alongside the other manager stores at
 * `~/.clawcode/manager/recurring-schedules.json`, versioned + atomically written
 * (mirrors `effort-state-store.ts` / the v2.1 yaml-writer tmp+rename pattern):
 *
 * ```json
 * {
 *   "version": 1,
 *   "updatedAt": "2026-06-19T22:00:00.000Z",
 *   "schedules": [
 *     { "scheduleId": "a1b2c3d4", "agentName": "personal",
 *       "cron": "*\/18 * * * *", "prompt": "...", "createdAt": "..." }
 *   ]
 * }
 * ```
 *
 * Invariants (pinned by __tests__/recurring-schedule-store.test.ts):
 *   - Missing file → `[]` (no throw, no warn — fresh first boot).
 *   - Corrupt JSON / invalid schema → `[]` + warn (the daemon MUST boot anyway —
 *     a hand-edited or version-skewed file can never crash startup; this is the
 *     same `*\/90` croner-crash failure class the scheduler guards against).
 *   - Writes are serialized through a self-NON-poisoning chain so one failed
 *     write surfaces to ITS caller but never wedges subsequent add/cancel.
 *   - `<path>.<rand>.tmp` + `rename()` for atomicity (tmp in the same dir).
 */

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import type { Logger } from "pino";
import { z } from "zod/v4";

/** Canonical file path — sibling of effort-state.json / advisor-budget.db. */
export const DEFAULT_RECURRING_SCHEDULE_PATH = join(
  homedir(),
  ".clawcode",
  "manager",
  "recurring-schedules.json",
);

const storedScheduleSchema = z.object({
  scheduleId: z.string().min(1),
  agentName: z.string().min(1),
  cron: z.string().min(1),
  prompt: z.string().min(1),
  createdAt: z.string(),
});

/** One persisted runtime recurring schedule. */
export type StoredRecurringSchedule = z.infer<typeof storedScheduleSchema>;

const fileSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  schedules: z.array(storedScheduleSchema),
});

type ScheduleFile = z.infer<typeof fileSchema>;

const noop = (): void => {};

/**
 * Daemon-owned durable store for runtime recurring schedules. Constructed once
 * in the daemon and injected into {@link SchedulerSource}. All mutating ops are
 * serialized so a read-modify-write can never lose a concurrent update.
 */
export class RecurringScheduleStore {
  private readonly filePath: string;
  private readonly log?: Logger;
  /** Always-resolved tail so a failed write never poisons the chain. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(opts: { filePath?: string; log?: Logger } = {}) {
    this.filePath = opts.filePath ?? DEFAULT_RECURRING_SCHEDULE_PATH;
    this.log = opts.log;
  }

  /**
   * Read all persisted schedules. Fail-soft in EVERY failure mode (missing file,
   * corrupt JSON, invalid schema) → returns `[]` so a bad file can never block
   * boot. A missing file is the expected fresh state (silent); any other failure
   * warns so operators see real corruption.
   */
  async load(): Promise<StoredRecurringSchedule[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.log?.warn(
          { filePath: this.filePath, error: (err as Error).message },
          "recurring-schedule-store read failed — treating as empty",
        );
      }
      return [];
    }
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch (err) {
      this.log?.warn(
        { filePath: this.filePath, error: (err as Error).message },
        "recurring-schedule-store JSON parse failed — treating as empty",
      );
      return [];
    }
    // Envelope must be {version:1, schedules:[...]}; entries are validated
    // INDIVIDUALLY so one hand-edited / version-skewed entry drops only itself
    // (not the whole durable set) — matching restoreFromStore's per-entry
    // resilience + the project's "one bad entry can't nuke everything" lineage.
    const envelope = z
      .object({ version: z.literal(1), schedules: z.array(z.unknown()) })
      .safeParse(obj);
    if (!envelope.success) {
      this.log?.warn(
        { filePath: this.filePath, issues: envelope.error.issues.length },
        "recurring-schedule-store envelope invalid — treating as empty",
      );
      return [];
    }
    const out: StoredRecurringSchedule[] = [];
    let dropped = 0;
    for (const candidate of envelope.data.schedules) {
      const p = storedScheduleSchema.safeParse(candidate);
      if (p.success) out.push(p.data);
      else dropped++;
    }
    if (dropped > 0) {
      this.log?.warn(
        { filePath: this.filePath, dropped },
        "recurring-schedule-store: dropped malformed entries (kept the rest)",
      );
    }
    return out;
  }

  /** Upsert a schedule by `scheduleId` (replaces any existing entry with that id). */
  async add(entry: StoredRecurringSchedule): Promise<void> {
    return this.enqueue(async () => {
      const cur = await this.load();
      const next: ScheduleFile = {
        version: 1,
        updatedAt: new Date().toISOString(),
        schedules: [
          ...cur.filter((s) => s.scheduleId !== entry.scheduleId),
          entry,
        ],
      };
      await this.atomicWrite(next);
      this.log?.debug({ scheduleId: entry.scheduleId, agent: entry.agentName }, "recurring schedule persisted");
    });
  }

  /** Remove a schedule by id. No-op (still rewrites) when the id is absent. */
  async remove(scheduleId: string): Promise<void> {
    return this.enqueue(async () => {
      const cur = await this.load();
      const next: ScheduleFile = {
        version: 1,
        updatedAt: new Date().toISOString(),
        schedules: cur.filter((s) => s.scheduleId !== scheduleId),
      };
      await this.atomicWrite(next);
      this.log?.debug({ scheduleId }, "recurring schedule removed from store");
    });
  }

  // -----------------------------------------------------------------------
  // internals
  // -----------------------------------------------------------------------

  /**
   * Serialize `op` after the previous op SETTLES (resolve OR reject). The tail
   * is kept always-resolved so one op's rejection never wedges later callers;
   * `op`'s own rejection is still surfaced to ITS caller via the returned
   * promise (the persist-failure-rolls-back path in SchedulerSource needs that).
   */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.tail.then(op, op);
    this.tail = run.then(noop, noop);
    return run as Promise<T>;
  }

  private async atomicWrite(data: ScheduleFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await rename(tmp, this.filePath);
  }
}
