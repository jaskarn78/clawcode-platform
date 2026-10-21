/**
 * Phase 60 Plan 03 Task 1 — SchedulerSource adapter.
 *
 * Wraps prompt-based cron schedules as a TriggerSource, routing fires
 * through `engine.ingest()` instead of directly through TurnDispatcher.
 *
 * Handler-based schedules (memory consolidation, etc.) are NOT handled
 * here — they remain on the regular TaskScheduler which is called
 * directly from daemon.ts. SchedulerSource only touches prompt-based
 * schedules that produce agent turns.
 *
 * poll(since) computes missed cron ticks between the watermark and now,
 * enabling watermark-based replay on daemon restart (TRIG-06).
 */

import { Cron } from "croner";
import { nanoid } from "nanoid";
import type { Logger } from "pino";

import type { TriggerEvent, TriggerSource } from "./types.js";
import type { RecurringScheduleStore } from "./recurring-schedule-store.js";
import type { ScheduleEntry } from "../scheduler/types.js";
import type { SessionManager } from "../manager/session-manager.js";
import type { TurnDispatcher } from "../manager/turn-dispatcher.js";
import { ManagerError } from "../shared/errors.js";

/** Max horizon for one-shot reminders (30 days). Guards against typos like
 *  '2099-01-01' that would pin the daemon's process timer. */
const REMINDER_MAX_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

/** Phase 999.99 — per-agent cap on runtime recurring schedules. Guards
 *  unbounded creation from an agent looping `schedule_recurring`. */
const MAX_RECURRING_PER_AGENT = 8;

/** Phase 999.99 — minimum effective interval for a recurring schedule (60s).
 *  A tighter cron (e.g. a per-second `* * * * * *`) would hammer the agent +
 *  the delivery surface; the nextRun-diff guard rejects it at registration. */
const MIN_RECURRING_INTERVAL_MS = 60_000;

/**
 * Constructor options for SchedulerSource. The `ingest` callback is
 * bound to `TriggerEngine.ingest` by daemon.ts — the adapter never
 * references the engine directly.
 */
export type SchedulerSourceOptions = Readonly<{
  resolvedAgents: ReadonlyArray<{
    name: string;
    schedules: ReadonlyArray<ScheduleEntry>;
  }>;
  sessionManager: SessionManager;
  turnDispatcher: TurnDispatcher;
  ingest: (event: TriggerEvent) => Promise<void>;
  log: Logger;
  /**
   * Durable store for runtime recurring schedules (Phase 999.99 follow-up).
   * When provided, `addRecurringSchedule` persists + `cancelRecurring` removes,
   * and `restoreFromStore` re-registers them on boot so an agent-created
   * `schedule_recurring` survives a daemon restart. Omitted in tests that only
   * exercise in-memory behavior.
   */
  recurringStore?: RecurringScheduleStore;
}>;

/** Internal record for a prompt-based schedule entry. */
type PromptScheduleEntry = Readonly<{
  agentName: string;
  entry: ScheduleEntry;
}>;

/** Callback registered for cron triggers (used by _triggerForTest). */
type TriggerCallback = () => Promise<void>;

/**
 * SchedulerSource implements TriggerSource for cron-based schedules.
 *
 * - `start()` creates Cron jobs for each enabled prompt-based schedule.
 *   On each fire it builds a TriggerEvent and calls `ingest()`.
 * - `stop()` stops all cron jobs and clears internal state.
 * - `poll(since)` computes missed ticks for replay.
 */
export class SchedulerSource implements TriggerSource {
  readonly sourceId = "scheduler" as const;

  private readonly scheduleEntries: readonly PromptScheduleEntry[];
  private readonly ingestFn: (event: TriggerEvent) => Promise<void>;
  private readonly log: Logger;
  /** Durable store for runtime recurring schedules (undefined → in-memory only). */
  private readonly recurringStore?: RecurringScheduleStore;

  private readonly cronJobs: Cron[] = [];
  private readonly locks = new Map<string, boolean>();
  private readonly triggers = new Map<string, Map<string, TriggerCallback>>();
  /** Phase 100 follow-up — reminderId → callback for `_triggerReminderForTest`. */
  private readonly reminderTriggers = new Map<string, TriggerCallback>();
  /** Phase 999.99 — runtime recurring schedules. Stores the live Cron HANDLE
   *  (cancel needs `job.stop()`), the metadata for `listRecurring()`, and the
   *  callback for `_triggerRecurringForTest`. scheduleId → entry. */
  private readonly recurringSchedules = new Map<
    string,
    {
      job: Cron;
      agentName: string;
      cron: string;
      prompt: string;
      callback: TriggerCallback;
    }
  >();

  constructor(options: SchedulerSourceOptions) {
    this.ingestFn = options.ingest;
    this.log = options.log;
    this.recurringStore = options.recurringStore;

    // Collect only enabled prompt-based schedules (no handler).
    const entries: PromptScheduleEntry[] = [];
    for (const agent of options.resolvedAgents) {
      for (const entry of agent.schedules) {
        if (entry.enabled && entry.prompt && !entry.handler) {
          entries.push({ agentName: agent.name, entry });
        }
      }
    }
    this.scheduleEntries = Object.freeze(entries);
  }

  /** Number of prompt-based schedules registered (for testing). */
  get promptScheduleCount(): number {
    return this.scheduleEntries.length;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Create Cron jobs for each prompt-based schedule. On each fire:
   * 1. Check per-agent lock (sequential execution per agent).
   * 2. Build TriggerEvent with `sourceId="scheduler"`.
   * 3. Call `ingestFn(event)`.
   * 4. Release lock in finally block.
   */
  start(): void {
    for (const { agentName, entry } of this.scheduleEntries) {
      const triggerHandler: TriggerCallback = async (): Promise<void> => {
        // Per-agent sequential lock — mirrors TaskScheduler pattern.
        if (this.locks.get(agentName)) {
          this.log.info(
            { agent: agentName, schedule: entry.name },
            "scheduler-source: skipping (agent locked by another schedule)",
          );
          return;
        }
        this.locks.set(agentName, true);

        try {
          const event: TriggerEvent = {
            sourceId: "scheduler",
            idempotencyKey: `${entry.name}:${Date.now()}`,
            targetAgent: agentName,
            payload: entry.prompt,
            timestamp: Date.now(),
          };
          await this.ingestFn(event);
        } catch (err) {
          this.log.error(
            { agent: agentName, schedule: entry.name, error: (err as Error).message },
            "scheduler-source: ingest failed",
          );
        } finally {
          this.locks.set(agentName, false);
        }
      };

      // Create the cron job
      const job = new Cron(entry.cron, { paused: false }, () => {
        void triggerHandler();
      });
      this.cronJobs.push(job);

      // Register the trigger callback for _triggerForTest
      if (!this.triggers.has(agentName)) {
        this.triggers.set(agentName, new Map());
      }
      this.triggers.get(agentName)!.set(entry.name, triggerHandler);
    }

    this.log.info(
      { scheduleCount: this.scheduleEntries.length },
      "scheduler-source: started",
    );
  }

  /**
   * Stop all cron jobs and clear IN-MEMORY state on daemon shutdown.
   *
   * DURABILITY INVARIANT: this clears the in-memory `recurringSchedules` map but
   * MUST NOT touch `recurringStore` — the persisted file is the source of truth
   * that `restoreFromStore` re-registers from on the next boot. Clearing the
   * store here would silently wipe durability on every restart (the whole point
   * of the feature). Persistence is mutated ONLY by add/cancel.
   */
  stop(): void {
    for (const job of this.cronJobs) {
      job.stop();
    }
    this.cronJobs.length = 0;
    this.triggers.clear();
    this.reminderTriggers.clear();
    this.recurringSchedules.clear();
    this.locks.clear();
  }

  // -----------------------------------------------------------------------
  // addOneShotReminder — Phase 100 follow-up (operator-surfaced 2026-04-27)
  // -----------------------------------------------------------------------

  /**
   * Schedule a one-off reminder. At `fireAt`, a TriggerEvent is built with
   * `sourceId="reminder:<reminderId>"` (per-reminder-scoped to keep the
   * 3-layer dedup pipeline distinct) and ingested through the engine. The
   * delivery callback (wired in commit f984008) then routes the agent's
   * response to its bound delivery surface (typically Discord webhook).
   *
   * In-memory only — daemon restart loses pending reminders. The MCP tool
   * description tells the LLM to caveat accordingly.
   *
   * Throws `ManagerError` for invalid / past / too-far-out fireAt values
   * so the IPC handler surfaces a clean JSON-RPC error instead of a raw
   * runtime crash.
   */
  async addOneShotReminder(opts: {
    readonly fireAt: Date;
    readonly agentName: string;
    readonly prompt: string;
  }): Promise<{ readonly reminderId: string }> {
    const now = Date.now();
    const fireMs = opts.fireAt.getTime();
    if (isNaN(fireMs)) {
      throw new ManagerError(`Invalid fireAt: ${opts.fireAt}`);
    }
    if (fireMs <= now) {
      throw new ManagerError(
        `fireAt must be in the future (got ${opts.fireAt.toISOString()})`,
      );
    }
    if (fireMs > now + REMINDER_MAX_HORIZON_MS) {
      throw new ManagerError(
        `fireAt cannot be more than 30 days in the future (got ${opts.fireAt.toISOString()})`,
      );
    }

    const reminderId = nanoid(8);
    const agentName = opts.agentName;
    const prompt = opts.prompt;

    const reminderCallback: TriggerCallback = async (): Promise<void> => {
      // Per-agent sequential lock — mirrors the recurring schedule path so a
      // reminder doesn't race a long-running scheduled prompt for the same
      // agent. The skip is logged + the watermark intentionally NOT advanced
      // (in-memory-only reminders have no replay anyway).
      if (this.locks.get(agentName)) {
        this.log.info(
          { agent: agentName, reminderId },
          "scheduler-source: reminder skipped (agent locked by another schedule)",
        );
        return;
      }
      this.locks.set(agentName, true);
      try {
        const event: TriggerEvent = {
          sourceId: `reminder:${reminderId}`,
          idempotencyKey: `reminder:${reminderId}`,
          targetAgent: agentName,
          payload: prompt,
          timestamp: Date.now(),
        };
        await this.ingestFn(event);
      } catch (err) {
        this.log.error(
          { agent: agentName, reminderId, error: (err as Error).message },
          "scheduler-source: reminder ingest failed",
        );
      } finally {
        this.locks.set(agentName, false);
      }
    };

    // croner accepts a Date as the first arg for one-shot scheduling. The
    // job auto-stops after the date passes; we keep the handle in cronJobs
    // so `stop()` cleanly tears it down on daemon shutdown.
    const cronJob = new Cron(opts.fireAt, { paused: false }, () => {
      void reminderCallback();
    });
    this.cronJobs.push(cronJob);
    this.reminderTriggers.set(reminderId, reminderCallback);

    this.log.info(
      { agent: agentName, reminderId, fireAt: opts.fireAt.toISOString() },
      "scheduler-source: one-shot reminder scheduled",
    );
    return { reminderId };
  }

  // -----------------------------------------------------------------------
  // addRecurringSchedule — Phase 999.99 (runtime recurring-poll primitive)
  // -----------------------------------------------------------------------

  /**
   * Register a runtime recurring schedule. On each tick, a TriggerEvent is
   * built with `sourceId="recurring:<scheduleId>"` and a PER-TICK
   * idempotencyKey (`recurring:<id>:<ts>`) so the 3-layer dedup pipeline does
   * NOT collapse successive ticks (a static key — like the reminder path's —
   * would dedup every tick after the first). The event is ingested through the
   * engine; the delivery callback (commit f984008) then routes the agent's
   * response to its bound channel as a standalone message — the recurring twin
   * of the reminder/config-cron fix.
   *
   * DURABLE (Phase 999.99 follow-up): when a `recurringStore` is wired, the
   * schedule is persisted after in-memory registration and re-registered on the
   * next boot by `restoreFromStore` — it survives a daemon restart. If the
   * persist write FAILS, the in-memory registration is rolled back and a
   * `ManagerError` is thrown (durability is the whole point — we never report
   * success for a schedule that wouldn't survive a restart). Resume is
   * forward-only: a restart does NOT back-fire ticks missed while the daemon was
   * down (correct for "poll every N min" — no post-downtime thundering herd).
   *
   * `reg.scheduleId` re-uses a persisted id on the restore path (so cancel-by-id
   * survives restart); `reg.persist === false` skips the write (restore is
   * re-registering what's already on disk).
   *
   * Guards (CONTEXT §5 landmines):
   *  - per-agent cap (MAX_RECURRING_PER_AGENT) — unbounded-creation guard.
   *  - construction-time croner guard — `new Cron(pattern)` throws SYNCHRONOUSLY
   *    on a bad pattern (the `every-90` "slash-90" → the June crash-loop
   *    precedent). Both the paused validation probe AND the live job are
   *    wrapped in try/catch →
   *    `ManagerError` so the IPC handler surfaces a clean JSON-RPC error
   *    instead of crashing the daemon.
   *  - min-interval — reject schedules firing more than once per 60s
   *    (nextRun-diff on the probe).
   */
  async addRecurringSchedule(
    opts: {
      readonly cron: string;
      readonly agentName: string;
      readonly prompt: string;
    },
    reg?: { readonly scheduleId?: string; readonly persist?: boolean },
  ): Promise<{ readonly scheduleId: string }> {
    const agentName = opts.agentName;
    const prompt = opts.prompt;

    // (a) PER-AGENT CAP — count this agent's live recurring schedules.
    let agentCount = 0;
    for (const entry of this.recurringSchedules.values()) {
      if (entry.agentName === agentName) agentCount++;
    }
    if (agentCount >= MAX_RECURRING_PER_AGENT) {
      throw new ManagerError(
        `Too many recurring schedules for agent '${agentName}' (max ${MAX_RECURRING_PER_AGENT}). Cancel one first.`,
      );
    }

    // (b) MIN-INTERVAL — build a paused validation probe. `new Cron(pattern)`
    //     throws SYNCHRONOUSLY on a bad pattern (the *\/90 crash vector), so the
    //     probe construction is guarded. Then diff two consecutive nextRun()s.
    let probe: Cron;
    try {
      probe = new Cron(opts.cron, { paused: true });
    } catch (err) {
      throw new ManagerError(`Invalid cron pattern: ${(err as Error).message}`);
    }
    try {
      const a = probe.nextRun();
      const b = a ? probe.nextRun(a) : null;
      if (a && b && b.getTime() - a.getTime() < MIN_RECURRING_INTERVAL_MS) {
        throw new ManagerError(
          `Recurring interval too tight (min 60s between ticks). Pattern '${opts.cron}' fires every ${Math.round((b.getTime() - a.getTime()) / 1000)}s.`,
        );
      }
    } finally {
      probe.stop();
    }

    // (c) id — re-use the persisted id on the restore path so cancel-by-id
    //     survives a restart; otherwise mint a fresh one.
    const scheduleId = reg?.scheduleId ?? nanoid(8);

    // (d) per-agent-locked TriggerCallback — mirrors the reminder callback but
    //     with a PER-TICK idempotencyKey (Date.now()) so the dedup pipeline does
    //     not collapse successive ticks.
    const callback: TriggerCallback = async (): Promise<void> => {
      if (this.locks.get(agentName)) {
        this.log.info(
          { agent: agentName, scheduleId },
          "scheduler-source: recurring tick skipped (agent locked by another schedule)",
        );
        return;
      }
      this.locks.set(agentName, true);
      try {
        const event: TriggerEvent = {
          sourceId: `recurring:${scheduleId}`,
          idempotencyKey: `recurring:${scheduleId}:${Date.now()}`,
          targetAgent: agentName,
          payload: prompt,
          timestamp: Date.now(),
        };
        await this.ingestFn(event);
      } catch (err) {
        this.log.error(
          { agent: agentName, scheduleId, error: (err as Error).message },
          "scheduler-source: recurring ingest failed",
        );
      } finally {
        this.locks.set(agentName, false);
      }
    };

    // (e) CONSTRUCTION GUARD — the live job. croner throws SYNCHRONOUSLY on a
    //     bad pattern; this is the SC-3 guard the reminder Date path lacks
    //     (a Date arg never throws a pattern-parse error). The probe above
    //     already validated the pattern, but the live construction is guarded
    //     too so an edge that the probe survives can never crash the daemon.
    let job: Cron;
    try {
      job = new Cron(opts.cron, { paused: false }, () => {
        void callback();
      });
    } catch (err) {
      throw new ManagerError(`Invalid cron pattern: ${(err as Error).message}`);
    }

    // (f) register
    this.cronJobs.push(job);
    this.recurringSchedules.set(scheduleId, {
      job,
      agentName,
      cron: opts.cron,
      prompt,
      callback,
    });

    // (g) PERSIST — make it durable across restarts. Skipped on the restore path
    //     (`persist === false`: already on disk). If the write FAILS, roll back
    //     the in-memory registration (reusing the same teardown as cancel) and
    //     throw — never report success for a schedule that wouldn't survive a
    //     restart. The store serializes its own writes, so this await is safe.
    if (this.recurringStore && reg?.persist !== false) {
      try {
        await this.recurringStore.add({
          scheduleId,
          agentName,
          cron: opts.cron,
          prompt,
          createdAt: new Date().toISOString(),
        });
      } catch (err) {
        this.teardownRecurringInMemory(scheduleId);
        throw new ManagerError(
          `Failed to persist recurring schedule: ${(err as Error).message}`,
        );
      }
    }

    this.log.info(
      { agent: agentName, scheduleId, cron: opts.cron, durable: Boolean(this.recurringStore) },
      "scheduler-source: recurring schedule registered",
    );
    return { scheduleId };
  }

  /**
   * Tear down a recurring schedule's IN-MEMORY state only: stop the Cron job,
   * splice it out of `cronJobs` (in-place — the field is readonly), delete the
   * registry entry. Returns false for an unknown id. Shared by `cancelRecurring`
   * and the persist-failure rollback in `addRecurringSchedule` so the two never
   * drift. Does NOT touch the durable store.
   */
  private teardownRecurringInMemory(scheduleId: string): boolean {
    const entry = this.recurringSchedules.get(scheduleId);
    if (!entry) return false;
    entry.job.stop();
    const idx = this.cronJobs.indexOf(entry.job);
    if (idx !== -1) this.cronJobs.splice(idx, 1);
    this.recurringSchedules.delete(scheduleId);
    return true;
  }

  /**
   * Cancel a runtime recurring schedule by id. Stops the live Cron job AND
   * removes it from the durable store so it does NOT resurrect on the next boot.
   * Returns `false` for an unknown id (double-cancel is a clean no-op). The store
   * removal is awaited; a store failure is logged (the job is already stopped)
   * rather than thrown — the user-visible cancel still succeeded this session.
   */
  async cancelRecurring(scheduleId: string): Promise<boolean> {
    const entry = this.recurringSchedules.get(scheduleId);
    if (!entry) return false;
    const agentName = entry.agentName;
    this.teardownRecurringInMemory(scheduleId);
    if (this.recurringStore) {
      try {
        await this.recurringStore.remove(scheduleId);
      } catch (err) {
        this.log.warn(
          { agent: agentName, scheduleId, error: (err as Error).message },
          "scheduler-source: recurring schedule stopped but store removal failed (may resurrect on restart)",
        );
      }
    }
    this.log.info(
      { agent: agentName, scheduleId },
      "scheduler-source: recurring schedule cancelled",
    );
    return true;
  }

  /**
   * Re-register persisted runtime recurring schedules on daemon boot. Called
   * AFTER `start()` (which registers the yaml `schedules:`) so durable
   * agent-created schedules resume.
   *
   * CRASH-PROOF BY CONSTRUCTION — the dominant failure lineage here is a bad
   * cron string crashing boot (the `*\/90` croner sync-throw). Therefore:
   *   - `load()` is fail-soft (corrupt file → []),
   *   - each entry re-registers in its OWN try/catch (a malformed / now-invalid /
   *     cap-exceeded entry is skipped + warned, NEVER fatal),
   *   - the whole method is wrapped so it can never reject into the boot path.
   *
   * Resume is forward-only (re-register → future ticks); restored schedules live
   * in `recurringSchedules`, NOT `scheduleEntries`, so `poll()`/replay never
   * back-fires their missed ticks. Schedules whose agent no longer exists are
   * skipped (not pruned — a temporarily-removed agent shouldn't lose them).
   * `persist: false` since the entries are already on disk.
   */
  async restoreFromStore(
    validAgents: ReadonlySet<string>,
  ): Promise<{ restored: number; skipped: number }> {
    if (!this.recurringStore) return { restored: 0, skipped: 0 };
    let restored = 0;
    let skipped = 0;
    try {
      const entries = await this.recurringStore.load();
      for (const e of entries) {
        try {
          if (!validAgents.has(e.agentName)) {
            this.log.warn(
              { agent: e.agentName, scheduleId: e.scheduleId },
              "scheduler-source: skipping restored schedule for unknown agent",
            );
            skipped++;
            continue;
          }
          await this.addRecurringSchedule(
            { cron: e.cron, agentName: e.agentName, prompt: e.prompt },
            { scheduleId: e.scheduleId, persist: false },
          );
          restored++;
        } catch (err) {
          // Per-entry isolation — a bad cron / cap-exceeded / any error skips
          // THIS entry only; the daemon still boots.
          this.log.warn(
            { scheduleId: e.scheduleId, agent: e.agentName, error: (err as Error).message },
            "scheduler-source: skipping malformed restored schedule",
          );
          skipped++;
        }
      }
    } catch (err) {
      // Outer guard — restore must NEVER take down boot.
      this.log.error(
        { error: (err as Error).message },
        "scheduler-source: restoreFromStore failed (continuing without restored schedules)",
      );
    }
    this.log.info({ restored, skipped }, "scheduler-source: recurring schedules restored");
    return { restored, skipped };
  }

  /**
   * Enumerate live runtime recurring schedules in the public shape (omits the
   * Cron handle + callback). Used by the `schedules` IPC handler so
   * `list_schedules` surfaces recurring entries (SC-4). Frozen.
   */
  listRecurring(): ReadonlyArray<{
    readonly scheduleId: string;
    readonly agentName: string;
    readonly cron: string;
    readonly prompt: string;
  }> {
    const out: Array<{
      scheduleId: string;
      agentName: string;
      cron: string;
      prompt: string;
    }> = [];
    for (const [scheduleId, entry] of this.recurringSchedules) {
      out.push({
        scheduleId,
        agentName: entry.agentName,
        cron: entry.cron,
        prompt: entry.prompt,
      });
    }
    return Object.freeze(out);
  }

  // -----------------------------------------------------------------------
  // poll — watermark-based replay (TRIG-06)
  // -----------------------------------------------------------------------

  /**
   * Compute missed cron ticks between `since` (epoch string or null)
   * and now for each prompt-based schedule entry. Returns sorted events
   * suitable for `TriggerEngine.ingest()`.
   *
   * When `since` is null, starts from now (no missed ticks returned).
   */
  async poll(since: string | null): Promise<readonly TriggerEvent[]> {
    const now = Date.now();

    if (since === null) {
      return [];
    }

    const sinceEpoch = parseInt(since, 10);
    if (isNaN(sinceEpoch) || sinceEpoch >= now) {
      return [];
    }

    const sinceDate = new Date(sinceEpoch);
    const nowDate = new Date(now);
    const events: TriggerEvent[] = [];
    const MAX_TICKS_PER_SCHEDULE = 1000;

    for (const { agentName, entry } of this.scheduleEntries) {
      // Create a paused cron to compute next runs
      const tempCron = new Cron(entry.cron, { paused: true });
      let current = sinceDate;
      let tickCount = 0;

      while (tickCount < MAX_TICKS_PER_SCHEDULE) {
        const next = tempCron.nextRun(current);
        if (!next || next > nowDate) {
          break;
        }
        const tickEpoch = next.getTime();
        events.push({
          sourceId: "scheduler",
          idempotencyKey: `${entry.name}:${tickEpoch}`,
          targetAgent: agentName,
          payload: entry.prompt,
          timestamp: tickEpoch,
        });
        // Move past this tick to find the next one
        current = new Date(tickEpoch + 1);
        tickCount++;
      }

      tempCron.stop();
    }

    // Sort by timestamp ascending
    events.sort((a, b) => a.timestamp - b.timestamp);
    return Object.freeze(events);
  }

  // -----------------------------------------------------------------------
  // Test helpers
  // -----------------------------------------------------------------------

  /**
   * Manually trigger a specific schedule's callback (test-only).
   * @internal
   */
  async _triggerForTest(agentName: string, scheduleName: string): Promise<void> {
    const agentTriggers = this.triggers.get(agentName);
    if (!agentTriggers) {
      throw new Error(`No triggers registered for agent '${agentName}'`);
    }
    const trigger = agentTriggers.get(scheduleName);
    if (!trigger) {
      throw new Error(`No trigger for schedule '${scheduleName}' on agent '${agentName}'`);
    }
    await trigger();
  }

  /**
   * Manually trigger a one-shot reminder's callback (test-only). Mirrors
   * `_triggerForTest` but keyed by the reminderId returned from
   * `addOneShotReminder`. Avoids fighting croner's internal setTimeout vs
   * vitest fake timers.
   * @internal
   */
  async _triggerReminderForTest(reminderId: string): Promise<void> {
    const trigger = this.reminderTriggers.get(reminderId);
    if (!trigger) {
      throw new Error(`No reminder registered for id '${reminderId}'`);
    }
    await trigger();
  }

  /**
   * Manually trigger a runtime recurring schedule's callback (test-only).
   * Mirrors `_triggerReminderForTest` but keyed by the scheduleId returned
   * from `addRecurringSchedule`. Avoids fighting croner's internal setTimeout
   * vs vitest fake timers.
   * @internal
   */
  async _triggerRecurringForTest(scheduleId: string): Promise<void> {
    const entry = this.recurringSchedules.get(scheduleId);
    if (!entry) {
      throw new Error(`No recurring schedule registered for id '${scheduleId}'`);
    }
    await entry.callback();
  }
}
