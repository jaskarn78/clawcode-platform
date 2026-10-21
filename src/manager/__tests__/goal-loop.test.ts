/**
 * Goal-loop engine + judge unit tests — pure, no daemon / Discord / model.
 * Proves the load-bearing control flow before any transport is wired:
 *   - completes when the judge says met (and stops driving turns)
 *   - feeds the judge's reason into the next directive
 *   - soft stop-clause completion (judge returns met:true) ends the loop
 *   - /clawcode-goal clear (AbortSignal) cancels — before, between, and during a turn
 *   - runaway circuit-breaker trips on turn ceiling and on wall-clock deadline
 *   - a hard turn failure stops (status error) instead of spinning
 *   - judge verdict parser tolerates fences / prose / junk and never reads as met
 */
import { describe, it, expect, vi } from "vitest";
import {
  runGoalLoop,
  buildDirective,
  type GoalLoopDeps,
  type GoalVerdict,
  type GoalProgress,
} from "../goal-loop.js";
import {
  parseVerdict,
  buildJudgeUserPrompt,
  evaluateGoal,
  type JudgeModelCall,
} from "../goal-evaluator.js";

/** Build deps with sensible defaults; override per test. */
function makeDeps(over: Partial<GoalLoopDeps> = {}): GoalLoopDeps {
  let t = 0;
  return {
    driveTurn: vi.fn(async () => "did some work"),
    evaluate: vi.fn(async () => ({ met: true, reason: "done" }) as GoalVerdict),
    onProgress: vi.fn(),
    signal: new AbortController().signal,
    backstopMaxTurns: 100,
    backstopDeadlineMs: 60 * 60_000,
    now: () => (t += 1000), // advances 1s per call — deterministic, no real clock
    ...over,
  };
}

describe("runGoalLoop", () => {
  it("returns met on the first turn the judge approves, and stops driving", async () => {
    const driveTurn = vi.fn(async () => "all tests green");
    const evaluate = vi
      .fn<GoalLoopDeps["evaluate"]>()
      .mockResolvedValueOnce({ met: false, reason: "2 failing" })
      .mockResolvedValueOnce({ met: false, reason: "1 failing" })
      .mockResolvedValueOnce({ met: true, reason: "all green" });

    const out = await runGoalLoop("tests pass", makeDeps({ driveTurn, evaluate }));

    expect(out.status).toBe("met");
    if (out.status === "met") {
      expect(out.turns).toBe(3);
      expect(out.reason).toBe("all green");
      expect(out.history).toHaveLength(3);
    }
    // Drove exactly 3 turns — did NOT keep going after met.
    expect(driveTurn).toHaveBeenCalledTimes(3);
    expect(evaluate).toHaveBeenCalledTimes(3);
  });

  it("feeds the judge's previous reason into the next turn's directive", async () => {
    const directives: string[] = [];
    const driveTurn = vi.fn(async (d: string) => {
      directives.push(d);
      return "worked";
    });
    const evaluate = vi
      .fn<GoalLoopDeps["evaluate"]>()
      .mockResolvedValueOnce({ met: false, reason: "lint errors remain" })
      .mockResolvedValueOnce({ met: true, reason: "clean" });

    await runGoalLoop("lint clean", makeDeps({ driveTurn, evaluate }));

    expect(directives[0]).toContain("Start working toward this goal");
    expect(directives[1]).toContain("lint errors remain"); // reason replayed
    expect(directives[1]).toContain("still in progress");
  });

  it("emits progress once per judged turn", async () => {
    const progress: GoalProgress[] = [];
    const evaluate = vi
      .fn<GoalLoopDeps["evaluate"]>()
      .mockResolvedValueOnce({ met: false, reason: "nope" })
      .mockResolvedValueOnce({ met: true, reason: "yep" });
    await runGoalLoop("x", makeDeps({ evaluate, onProgress: (p) => progress.push(p) }));
    expect(progress.map((p) => p.turn)).toEqual([1, 2]);
    expect(progress[1].verdict.met).toBe(true);
  });

  it("treats a soft stop-clause as completion (judge returns met:true)", async () => {
    // The engine has no notion of the clause — the JUDGE enforces it. Simulate
    // the judge firing the clause on turn 4.
    const evaluate = vi.fn(async (i: { turn: number }) =>
      i.turn >= 4
        ? { met: true, reason: "stopped per your 'after 4 turns' clause" }
        : { met: false, reason: "still working" },
    );
    const out = await runGoalLoop("do X or stop after 4 turns", makeDeps({ evaluate }));
    expect(out.status).toBe("met");
    if (out.status === "met") expect(out.reason).toContain("clause");
  });

  it("cancels immediately when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const driveTurn = vi.fn(async () => "x");
    const out = await runGoalLoop("x", makeDeps({ signal: ac.signal, driveTurn }));
    expect(out.status).toBe("cancelled");
    expect(driveTurn).not.toHaveBeenCalled();
  });

  it("cancels mid-turn when driveTurn rejects with an interrupt error", async () => {
    const ac = new AbortController();
    const driveTurn = vi.fn(async () => {
      ac.abort();
      const e = new Error("aborted: /clawcode-interrupt");
      e.name = "ChannelReplyInterruptedError";
      throw e;
    });
    const out = await runGoalLoop("x", makeDeps({ signal: ac.signal, driveTurn }));
    expect(out.status).toBe("cancelled");
  });

  it("trips the runaway backstop on the turn ceiling", async () => {
    const evaluate = vi.fn(async () => ({ met: false, reason: "never" }) as GoalVerdict);
    const out = await runGoalLoop("impossible", makeDeps({ evaluate, backstopMaxTurns: 5 }));
    expect(out.status).toBe("backstop");
    if (out.status === "backstop") {
      expect(out.turns).toBe(5); // ran 5 turns, then the 6th was refused
      expect(out.reason).toContain("5-turn");
    }
  });

  it("trips the runaway backstop on the wall-clock deadline", async () => {
    // now() advances 10 min per call; deadline 25 min → trips after a couple turns.
    let t = 0;
    const out = await runGoalLoop(
      "slow",
      makeDeps({
        evaluate: vi.fn(async () => ({ met: false, reason: "slow" }) as GoalVerdict),
        backstopMaxTurns: 1000,
        backstopDeadlineMs: 25 * 60_000,
        now: () => (t += 10 * 60_000),
      }),
    );
    expect(out.status).toBe("backstop");
    if (out.status === "backstop") expect(out.reason).toContain("minute");
  });

  it("stops with status error on a hard turn failure (does not spin)", async () => {
    const driveTurn = vi.fn(async () => {
      throw new Error("agent not running");
    });
    const out = await runGoalLoop("x", makeDeps({ driveTurn }));
    expect(out.status).toBe("error");
    if (out.status === "error") expect(out.error).toContain("agent not running");
    expect(driveTurn).toHaveBeenCalledTimes(1); // stopped, not retried
  });

  it("never lets a throwing progress sink break the loop", async () => {
    const evaluate = vi
      .fn<GoalLoopDeps["evaluate"]>()
      .mockResolvedValueOnce({ met: false, reason: "n" })
      .mockResolvedValueOnce({ met: true, reason: "y" });
    const out = await runGoalLoop(
      "x",
      makeDeps({
        evaluate,
        onProgress: () => {
          throw new Error("discord post failed");
        },
      }),
    );
    expect(out.status).toBe("met");
  });
});

describe("buildDirective", () => {
  it("turn 1 states the goal and asks for evidence", () => {
    const d = buildDirective("ship it", 1, undefined);
    expect(d).toContain("ship it");
    expect(d).toContain("EVIDENCE");
    expect(d).toContain("Start working");
  });
  it("later turns replay the last verdict reason", () => {
    const d = buildDirective("ship it", 3, { met: false, reason: "build broke" });
    expect(d).toContain("build broke");
    expect(d).toContain("still in progress");
  });
});

describe("parseVerdict (judge output tolerance)", () => {
  it("parses a clean single-line object", () => {
    expect(parseVerdict('{"met": true, "reason": "all green"}')).toEqual({
      met: true,
      reason: "all green",
    });
  });
  it("strips code fences and leading prose", () => {
    const raw = 'Sure!\n```json\n{"met": false, "reason": "1 test failing"}\n```';
    expect(parseVerdict(raw)).toEqual({ met: false, reason: "1 test failing" });
  });
  it("coerces stringy met values", () => {
    expect(parseVerdict('{"met":"yes","reason":"ok"}').met).toBe(true);
    expect(parseVerdict('{"met":"false","reason":"no"}').met).toBe(false);
  });
  it("NEVER reads garbage as met — falls back to not-met with a diagnostic", () => {
    expect(parseVerdict("the goal is definitely complete!").met).toBe(false);
    expect(parseVerdict("").met).toBe(false);
    expect(parseVerdict("{not json").met).toBe(false);
  });
  it("defaults a missing reason sensibly", () => {
    expect(parseVerdict('{"met": true}')).toEqual({ met: true, reason: "goal met" });
    expect(parseVerdict('{"met": false}')).toEqual({ met: false, reason: "not yet met" });
  });
});

describe("evaluateGoal", () => {
  const input = {
    condition: "tests pass",
    latestReply: "ran vitest, all 12 green",
    turn: 2,
    elapsedMs: 120_000,
    history: [],
  };
  it("passes a transcript-faithful prompt to the model and parses its verdict", async () => {
    const callModel = vi.fn<JudgeModelCall>(async () => '{"met": true, "reason": "12 green shown"}');
    const v = await evaluateGoal(input, callModel);
    expect(v).toEqual({ met: true, reason: "12 green shown" });
    const userPrompt = callModel.mock.calls[0][1];
    expect(userPrompt).toContain("tests pass");
    expect(userPrompt).toContain("ran vitest, all 12 green");
    expect(userPrompt).toContain("CURRENT TURN: 2");
  });
  it("resolves to not-met when the model call throws (never propagates)", async () => {
    const callModel = vi.fn(async () => {
      throw new Error("rate limited");
    });
    const v = await evaluateGoal(input, callModel);
    expect(v.met).toBe(false);
    expect(v.reason).toContain("rate limited");
  });
});

describe("buildJudgeUserPrompt", () => {
  it("renders empty reply explicitly", () => {
    const p = buildJudgeUserPrompt({
      condition: "x",
      latestReply: "",
      turn: 1,
      elapsedMs: 0,
      history: [],
    });
    expect(p).toContain("produced no reply");
  });
});
