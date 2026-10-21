/**
 * renderGoalReply — pure /clawcode-goal ephemeral copy. Locks the set/status/
 * clear wording + the running-vs-idle branches without a Discord pipeline.
 */
import { describe, it, expect } from "vitest";
import { renderGoalReply } from "../slash-commands.js";

describe("renderGoalReply", () => {
  it("goal-set: confirms + echoes the condition (server value wins)", () => {
    const out = renderGoalReply("goal-set", "personal", "do X", {
      ok: true,
      replaced: false,
      condition: "all tests pass",
    });
    expect(out).toContain("Goal set for **personal**");
    expect(out).toContain("all tests pass");
    expect(out).toContain("action:clear");
  });

  it("goal-set: notes a replacement", () => {
    const out = renderGoalReply("goal-set", "personal", undefined, {
      replaced: true,
      condition: "x",
    });
    expect(out).toContain("replaced");
  });

  it("goal-clear: distinguishes was-running from nothing-to-clear", () => {
    expect(
      renderGoalReply("goal-clear", "personal", undefined, { wasRunning: true, condition: "x" }),
    ).toContain("Cleared **personal**");
    expect(
      renderGoalReply("goal-clear", "personal", undefined, { wasRunning: false }),
    ).toContain("No active goal");
  });

  it("goal-status running: shows turn, elapsed, last reason", () => {
    const out = renderGoalReply("goal-status", "personal", undefined, {
      running: true,
      turns: 4,
      elapsedMs: 7 * 60_000,
      lastReason: "1 test still failing",
      condition: "tests pass",
    });
    expect(out).toContain("turn 4");
    expect(out).toContain("~7m");
    expect(out).toContain("1 test still failing");
  });

  it("goal-status idle: prompts to set one", () => {
    const out = renderGoalReply("goal-status", "personal", undefined, { running: false });
    expect(out).toContain("No active goal");
    expect(out).toContain("condition:");
  });
});
