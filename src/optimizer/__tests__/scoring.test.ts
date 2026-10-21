/**
 * Phase 142 — scoring (pure) tests.
 */
import { describe, it, expect } from "vitest";
import { passesSubstrings, aggregateScore } from "../scoring.js";
import type { EvalTask } from "../eval-set.js";
import type { TaskScore } from "../types.js";

const task = (over: Partial<EvalTask> = {}): EvalTask => ({
  id: "t",
  prompt: "p",
  successCriteria: "c",
  weight: 1,
  ...over,
});

describe("Phase 142 — passesSubstrings", () => {
  it("is true when no expectSubstrings (judge-only task)", () => {
    expect(passesSubstrings(task(), "anything")).toBe(true);
  });
  it("is true when all substrings present (case-insensitive)", () => {
    expect(
      passesSubstrings(task({ expectSubstrings: ["London", "Degrees"] }), "it is 12 degrees in london"),
    ).toBe(true);
  });
  it("is false when any substring missing", () => {
    expect(
      passesSubstrings(task({ expectSubstrings: ["London", "humidity"] }), "it is 12 degrees in london"),
    ).toBe(false);
  });
});

describe("Phase 142 — aggregateScore", () => {
  const ts = (over: Partial<TaskScore>): TaskScore => ({
    taskId: "t",
    weight: 1,
    samples: 1,
    passes: 1,
    score: 1,
    ...over,
  });
  it("is the weighted mean of per-task scores", () => {
    const r = aggregateScore([
      ts({ taskId: "a", weight: 1, score: 1 }),
      ts({ taskId: "b", weight: 3, score: 0 }),
    ]);
    expect(r).toBeCloseTo(0.25); // (1*1 + 3*0) / 4
  });
  it("is 0 for an empty list", () => {
    expect(aggregateScore([])).toBe(0);
  });
  it("is 0 when total weight is 0 (no divide-by-zero)", () => {
    expect(aggregateScore([ts({ weight: 0, score: 1 })])).toBe(0);
  });
});
