/**
 * Goal-loop engine — the autonomous "run until the goal is met" core behind
 * the `/clawcode-goal` Discord slash command. Mirrors Claude Code's own
 * `/goal` semantics (shipped CC v2.1.139): the agent works one turn, an
 * independent fast judge decides whether the natural-language CONDITION is
 * satisfied by what the agent surfaced, and if not the loop feeds the judge's
 * reason back and runs another turn — until the condition is met or the loop
 * is cancelled.
 *
 * DESIGN — this module is PURE and transport-agnostic. It knows nothing about
 * Discord, the channel bridge, IPC, or which model judges. Everything that
 * touches the outside world is injected via `GoalLoopDeps`:
 *   - `driveTurn(directive)` — send ONE directive to the agent, return the
 *     agent's reply text (the daemon wires this to bridge.push + awaitReply,
 *     or dispatchTurn for v2 agents).
 *   - `evaluate(...)`         — the judge (wired to callHaikuDirect).
 *   - `onProgress(...)`       — progress sink (wired to a Discord channel post).
 *   - `signal`               — AbortSignal for `/clawcode-goal clear`.
 * That keeps the load-bearing control flow unit-testable in isolation, with
 * zero mocks of the daemon (per the "prove the engine first" build order).
 *
 * GUARDRAILS — per the operator's choice the limits are SOFT: a condition may
 * carry natural-language clauses ("…or stop after 20 turns / 2 hours") and the
 * judge enforces them (it receives the current turn number + elapsed time).
 * The only HARD limits here are a runaway CIRCUIT-BREAKER (`backstopMaxTurns`
 * / `backstopDeadlineMs`) that exists solely to stop a pathological loop when
 * the judge itself malfunctions — there is no human at a terminal to Ctrl-C an
 * unattended daemon. In normal use the soft clauses stop the loop far sooner
 * and the backstop never trips.
 */

/** The judge's verdict for one turn. */
export type GoalVerdict = Readonly<{
  /** True when the CONDITION (incl. any soft stop-clauses) is satisfied. */
  met: boolean;
  /** Short human reason — surfaced to the channel and fed into the next turn. */
  reason: string;
}>;

/** One completed iteration of the loop. */
export type GoalIteration = Readonly<{
  turn: number;
  /** The agent's reply text the judge evaluated (empty if the turn produced none). */
  reply: string;
  verdict: GoalVerdict;
}>;

/** Progress emitted after each turn is judged. */
export type GoalProgress = Readonly<{
  turn: number;
  verdict: GoalVerdict;
  /** Elapsed wall-clock since the loop started, ms. */
  elapsedMs: number;
}>;

/** Input handed to the judge for one turn. */
export type GoalEvaluateInput = Readonly<{
  condition: string;
  /** The agent's reply this turn (what the judge is allowed to see). */
  latestReply: string;
  /** 1-based turn number — lets the judge honor "stop after N turns" clauses. */
  turn: number;
  /** Elapsed wall-clock ms — lets the judge honor "stop after T" clauses. */
  elapsedMs: number;
  /** Prior iterations (most recent last) for context. */
  history: readonly GoalIteration[];
}>;

export type GoalLoopDeps = Readonly<{
  /**
   * Drive ONE turn: deliver `directive` to the agent and resolve with its
   * reply text. Rejects on timeout / agent-not-running / interrupt. The engine
   * treats a non-abort rejection as a hard stop (status "error") rather than
   * spinning a wedged agent.
   */
  driveTurn: (directive: string) => Promise<string>;
  /** The completion judge. Should never throw — return met:false on its own errors. */
  evaluate: (input: GoalEvaluateInput) => Promise<GoalVerdict>;
  /** Called once per turn, after judging. Best-effort; must not throw. */
  onProgress: (progress: GoalProgress) => void;
  /** Cancellation — `/clawcode-goal clear` aborts this. */
  signal: AbortSignal;
  /** Runaway circuit-breaker: absolute turn ceiling (NOT the soft UX limit). */
  backstopMaxTurns: number;
  /** Runaway circuit-breaker: absolute wall-clock ceiling from start, ms. */
  backstopDeadlineMs: number;
  /** Injectable clock (tests pass a fake; prod passes Date.now). */
  now: () => number;
}>;

export type GoalOutcome =
  | Readonly<{ status: "met"; turns: number; reason: string; history: readonly GoalIteration[] }>
  | Readonly<{ status: "cancelled"; turns: number; history: readonly GoalIteration[] }>
  | Readonly<{ status: "backstop"; turns: number; reason: string; history: readonly GoalIteration[] }>
  | Readonly<{ status: "error"; turns: number; error: string; history: readonly GoalIteration[] }>;

/**
 * Build the directive sent to the agent for turn `turn`. The first turn states
 * the goal; later turns replay the judge's most recent reason so the agent
 * course-corrects. Both ask the agent to surface EVIDENCE in its reply —
 * because the judge only sees the reply, not the agent's tool transcript, the
 * condition can only be proven by what the agent chooses to surface (the same
 * constraint Claude Code's `/goal` has).
 */
export function buildDirective(
  condition: string,
  turn: number,
  lastVerdict: GoalVerdict | undefined,
): string {
  const evidenceAsk =
    "Take concrete action this turn, then in your reply summarize exactly what " +
    "you did and include the EVIDENCE that shows progress (command output, test " +
    "results, file diffs, links). The completion check only sees this reply, not " +
    "your tool calls — so if you don't surface the proof, it cannot count it.";
  if (turn === 1 || lastVerdict === undefined) {
    return `🎯 GOAL: ${condition}\n\nStart working toward this goal now. ${evidenceAsk}`;
  }
  return (
    `🎯 GOAL (still in progress): ${condition}\n\n` +
    `The completion check reviewed your last turn and said: "${lastVerdict.reason}"\n\n` +
    `Continue toward the goal, addressing that feedback. ${evidenceAsk}`
  );
}

/** True when an error means "the loop was cancelled", not "the turn failed". */
function isAbortError(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (err instanceof Error) {
    // The channel bridge throws ChannelReplyInterruptedError into a pending
    // awaitReply on /clawcode-interrupt; AbortError is the generic shape.
    return err.name === "ChannelReplyInterruptedError" || err.name === "AbortError";
  }
  return false;
}

/**
 * Run the goal loop to completion. Resolves with a terminal {@link GoalOutcome};
 * never rejects (all failure modes are encoded as outcomes so the caller can
 * report them uniformly to Discord).
 */
export async function runGoalLoop(
  condition: string,
  deps: GoalLoopDeps,
): Promise<GoalOutcome> {
  const history: GoalIteration[] = [];
  const start = deps.now();
  let lastVerdict: GoalVerdict | undefined;

  for (let turn = 1; ; turn++) {
    if (deps.signal.aborted) {
      return { status: "cancelled", turns: history.length, history };
    }
    // Runaway circuit-breaker — checked BEFORE spending another turn.
    if (turn > deps.backstopMaxTurns) {
      return {
        status: "backstop",
        turns: history.length,
        reason: `runaway stop: exceeded ${deps.backstopMaxTurns}-turn safety ceiling without the goal being met`,
        history,
      };
    }
    const elapsedBefore = deps.now() - start;
    if (elapsedBefore > deps.backstopDeadlineMs) {
      return {
        status: "backstop",
        turns: history.length,
        reason: `runaway stop: exceeded ${Math.round(deps.backstopDeadlineMs / 60_000)}-minute safety ceiling`,
        history,
      };
    }

    const directive = buildDirective(condition, turn, lastVerdict);

    let reply: string;
    try {
      reply = await deps.driveTurn(directive);
    } catch (err) {
      if (isAbortError(err, deps.signal)) {
        return { status: "cancelled", turns: history.length, history };
      }
      // A real turn failure (timeout / agent gone) — stop rather than spin a
      // wedged agent. The operator sees why.
      return {
        status: "error",
        turns: history.length,
        error: err instanceof Error ? err.message : String(err),
        history,
      };
    }

    // Cancelled while the turn was in flight (race between abort and resolve).
    if (deps.signal.aborted) {
      return { status: "cancelled", turns: history.length, history };
    }

    const verdict = await deps.evaluate({
      condition,
      latestReply: reply,
      turn,
      elapsedMs: deps.now() - start,
      history,
    });

    const iteration: GoalIteration = { turn, reply, verdict };
    history.push(iteration);
    // Progress is best-effort — a throwing sink must not break the loop.
    try {
      deps.onProgress({ turn, verdict, elapsedMs: deps.now() - start });
    } catch {
      /* swallow — cosmetic channel post failure never aborts the goal */
    }

    if (verdict.met) {
      return { status: "met", turns: turn, reason: verdict.reason, history };
    }
    lastVerdict = verdict;
  }
}
