/**
 * GoalManager — the daemon-side owner of running goal loops (Phase 2 wiring
 * for `/clawcode-goal`). One instance is constructed at daemon boot; the goal
 * IPC handlers call `start` / `clear` / `status` on it.
 *
 * Responsibilities:
 *   - hold at most ONE active goal per agent (a new goal replaces the old);
 *   - drive each turn through the channel bridge (push + awaitReply, modeled on
 *     daemon-ask-agent-ipc.ts) or `dispatchTurn` for v2/SDK agents;
 *   - judge each turn with the injected model call (Haiku by default);
 *   - post progress + the final outcome to the agent's Discord channel;
 *   - cancel cleanly on `/clawcode-goal clear` (abort + cancelPendingReplies).
 *
 * Everything external is injected via {@link GoalManagerDeps} so the manager is
 * unit-testable without a live daemon, bridge, model, or Discord.
 */
import { runGoalLoop, type GoalOutcome, type GoalProgress } from "./goal-loop.js";
import { evaluateGoal } from "./goal-evaluator.js";

/** Minimal bridge surface the goal turn-driver needs (structural). */
export type GoalBridgeLike = Readonly<{
  push: (msg: {
    type: string;
    message_id: string;
    content: string;
    meta?: Record<string, unknown>;
  }) => void;
  awaitReply: (correlationId: string, timeoutMs?: number) => Promise<{ result?: string }>;
  cancelPendingReplies?: (reason: string) => number;
}>;

export type GoalConfig = Readonly<{
  /** Runaway circuit-breaker: absolute turn ceiling. */
  backstopMaxTurns: number;
  /** Runaway circuit-breaker: absolute wall-clock ceiling, ms. */
  backstopDeadlineMs: number;
  /** Per-turn awaitReply timeout, ms. Generous — goal turns do real work. */
  turnTimeoutMs: number;
}>;

export type GoalManagerDeps = Readonly<{
  /** v3/channel agents → bridge; undefined for v2/SDK agents. */
  getBridge: (agent: string) => GoalBridgeLike | undefined;
  /** v2/SDK turn drive — returns the agent's reply. */
  dispatchTurn: (agent: string, content: string) => Promise<string | undefined>;
  /** The judge model call: (system, user) → raw text. Never throws (returns "" on failure). */
  callModel: (system: string, user: string) => Promise<string>;
  /** Post a plain message to the agent's bound channel (progress + outcome). */
  sendToChannel: (agent: string, text: string) => Promise<void>;
  /** Correlation-id generator (nanoid in prod). */
  newCorrelationId: () => string;
  /** Injectable clock. */
  now: () => number;
  log: Readonly<{
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
  }>;
  config: GoalConfig;
}>;

export type GoalStatus =
  | Readonly<{ running: false }>
  | Readonly<{
      running: true;
      condition: string;
      turns: number;
      lastReason: string;
      startedAt: number;
      elapsedMs: number;
    }>;

type ActiveGoal = {
  readonly agent: string;
  readonly condition: string;
  readonly startedAt: number;
  readonly controller: AbortController;
  turns: number;
  lastReason: string;
};

/** In-context ack instruction (the Phase 140-12 finding: the message itself must
 * tell the agent to ack with its result, or it just replies in chat and the
 * synchronous awaitReply never resolves). */
function ackInstruction(messageId: string): string {
  return (
    `\n\n[REPLY REQUIRED — when this turn's work is done, call the clawcode_ack tool ` +
    `with message_id "${messageId}", status "processed", and put your full progress ` +
    `summary + evidence in "result". The completion check only sees your clawcode_ack ` +
    `result, not your tool calls.]`
  );
}

export function formatProgress(condition: string, p: GoalProgress): string {
  const mark = p.verdict.met ? "✅" : "⏳";
  return `${mark} **Goal · turn ${p.turn}** — ${p.verdict.reason}`;
}

export function formatOutcome(condition: string, outcome: GoalOutcome): string {
  switch (outcome.status) {
    case "met":
      return `🎯 **Goal accomplished** in ${outcome.turns} turn(s): ${outcome.reason}\n> _${condition}_`;
    case "cancelled":
      return `🛑 **Goal cleared** after ${outcome.turns} turn(s).\n> _${condition}_`;
    case "backstop":
      return `⚠️ **Goal stopped** (${outcome.reason}) after ${outcome.turns} turn(s). Refine the condition or re-arm.\n> _${condition}_`;
    case "error":
      return `❌ **Goal halted** after ${outcome.turns} turn(s): ${outcome.error}\n> _${condition}_`;
  }
}

export class GoalManager {
  private readonly active = new Map<string, ActiveGoal>();

  constructor(private readonly deps: GoalManagerDeps) {}

  /** Start (or replace) the goal for `agent`. Returns whether one was replaced. */
  start(agent: string, condition: string): { replaced: boolean } {
    const replaced = this.active.has(agent);
    if (replaced) this.cancel(agent, "replaced by a new goal");

    const record: ActiveGoal = {
      agent,
      condition,
      startedAt: this.deps.now(),
      controller: new AbortController(),
      turns: 0,
      lastReason: "",
    };
    this.active.set(agent, record);
    // Fire-and-forget — the loop runs in the background and posts to the channel.
    void this.run(record);
    return { replaced };
  }

  /** Stop the agent's goal, if any. Returns whether one was running. */
  clear(agent: string): { wasRunning: boolean; condition?: string } {
    const existing = this.active.get(agent);
    if (!existing) return { wasRunning: false };
    this.cancel(agent, "/clawcode-goal clear");
    return { wasRunning: true, condition: existing.condition };
  }

  status(agent: string): GoalStatus {
    const g = this.active.get(agent);
    if (!g) return { running: false };
    return {
      running: true,
      condition: g.condition,
      turns: g.turns,
      lastReason: g.lastReason,
      startedAt: g.startedAt,
      elapsedMs: this.deps.now() - g.startedAt,
    };
  }

  /** Abort the active loop for `agent` and unblock any in-flight awaitReply. */
  private cancel(agent: string, reason: string): void {
    const existing = this.active.get(agent);
    if (!existing) return;
    existing.controller.abort();
    // Unblock a loop parked in awaitReply right now (v3 mid-turn cancel).
    try {
      this.deps.getBridge(agent)?.cancelPendingReplies?.(reason);
    } catch (err) {
      this.deps.log.warn(
        { agent, err: err instanceof Error ? err.message : String(err) },
        "[goal] cancelPendingReplies failed (loop will still abort)",
      );
    }
    // run()'s finally deletes the record (identity-guarded against a replace).
  }

  private async run(record: ActiveGoal): Promise<void> {
    const { deps } = this;
    let outcome: GoalOutcome;
    try {
      outcome = await runGoalLoop(record.condition, {
        driveTurn: (directive) => this.driveTurn(record.agent, directive),
        evaluate: (input) => evaluateGoal(input, deps.callModel),
        onProgress: (p) => {
          record.turns = p.turn;
          record.lastReason = p.verdict.reason;
          void deps
            .sendToChannel(record.agent, formatProgress(record.condition, p))
            .catch(() => {
              /* cosmetic channel post — never breaks the loop */
            });
        },
        signal: record.controller.signal,
        backstopMaxTurns: deps.config.backstopMaxTurns,
        backstopDeadlineMs: deps.config.backstopDeadlineMs,
        now: deps.now,
      });
    } catch (err) {
      // runGoalLoop never throws by contract, but be defensive — a thrown loop
      // must not leave a zombie active record.
      deps.log.warn(
        { agent: record.agent, err: err instanceof Error ? err.message : String(err) },
        "[goal] loop threw unexpectedly",
      );
      outcome = {
        status: "error",
        turns: record.turns,
        error: err instanceof Error ? err.message : String(err),
        history: [],
      };
    } finally {
      // Identity guard: only clear if THIS record still owns the slot — a
      // replace (start over a running goal) installs a new record, and the old
      // loop's teardown must not delete the new one.
      if (this.active.get(record.agent) === record) {
        this.active.delete(record.agent);
      }
    }

    await deps
      .sendToChannel(record.agent, formatOutcome(record.condition, outcome))
      .catch(() => {
        /* best-effort outcome notice */
      });
  }

  /** Drive one turn: bridge push+awaitReply (v3) or dispatchTurn (v2). */
  private async driveTurn(agent: string, directive: string): Promise<string> {
    const bridge = this.deps.getBridge(agent);
    if (bridge) {
      const corrId = this.deps.newCorrelationId();
      bridge.push({
        type: "a2a",
        message_id: corrId,
        content: directive + ackInstruction(corrId),
        meta: { reply_correlation_id: corrId, source_agent: "goal-loop" },
      });
      const ack = await bridge.awaitReply(corrId, this.deps.config.turnTimeoutMs);
      return ack.result ?? "";
    }
    // v2/SDK fallback — no mid-turn cancel (abort takes effect after the turn).
    return (await this.deps.dispatchTurn(agent, directive)) ?? "";
  }
}
