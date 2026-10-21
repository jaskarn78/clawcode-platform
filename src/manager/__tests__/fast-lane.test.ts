/**
 * Phase 999.161 (v1.1) — the fast lane never answers what it should not: the
 * rule pre-filter routes obvious work to the task lane for free, the quick
 * answer bails on the sentinel, on an empty reply and on "I can't check that"
 * shapes, and the continuity recap is rendered once and cleared.
 */
import { describe, expect, it } from "vitest";
import {
  NEEDS_TASK_LANE,
  QuickLaneRecentBuffer,
  buildQuickSystemPrompt,
  buildQuickUserPrompt,
  looksLikeDeflection,
  looksLikeNonAnswer,
  parseQuickAnswer,
  quickLaneFooter,
  ruleSaysTask,
  truncateForDiscord,
} from "../fast-lane.js";

describe("rule pre-filter", () => {
  it("routes explicit work and depth requests to the task lane without a bridge call", () => {
    for (const m of ["deploy the fleet", "check my calendar for tomorrow", "explain it properly", "run the tests", "look up the price", "https://example.com what is this"]) {
      expect(ruleSaysTask(m)).toBe(true);
    }
  });
  it("lets plain questions through to the quick answer", () => {
    for (const m of ["what's your take on the plan?", "who won?", "thanks!", "is that the same as last time?", "how's it going?"]) {
      expect(ruleSaysTask(m)).toBe(false);
    }
  });
});

describe("quick answer", () => {
  it("bails to the task lane on the sentinel, an empty reply, or a non-answer", () => {
    expect(parseQuickAnswer(`I'd need to check. ${NEEDS_TASK_LANE}`)).toEqual({ kind: "needs-task-lane", reason: "sentinel" });
    expect(parseQuickAnswer("   ")).toEqual({ kind: "needs-task-lane", reason: "empty" });
    expect(parseQuickAnswer("I can't access your calendar from here, but I'd guess Tuesday.")).toEqual({ kind: "needs-task-lane", reason: "non-answer" });
    expect(parseQuickAnswer("Let me check the tracker and get back to you.")).toEqual({ kind: "needs-task-lane", reason: "non-answer" });
    expect(parseQuickAnswer("Yes — Tuesday works.")).toEqual({ kind: "answer", text: "Yes — Tuesday works." });
  });
  it("bails on a deflection — the live 2026-09-23 reply to the running question", () => {
    const live = "That depends on how you're feeling! If you've got energy left, your legs feel good, and you're not running on fumes, adding a bit more can feel great. What's your gut telling you? 🏃";
    expect(parseQuickAnswer(live)).toEqual({ kind: "needs-task-lane", reason: "deflection" });
    for (const t of ["It’s up to you!", "That depends.", "Honestly it depends on your goals.", "Listen to your body on this one."]) {
      expect(looksLikeDeflection(t)).toBe(true);
    }
  });
  it("the deflection check stays quiet on general answers that mention a dependency", () => {
    for (const t of [
      "It depends on the altitude: water boils at 100 °C at sea level and lower as you climb.",
      "Canberra.",
      "Doing well, thanks — how about you?",
      // Seen in the no-thinking eval: a correct answer with a caveat in its second sentence.
      "8 fluid ounces in a cup (US standard). If you meant weight rather than volume, that depends on what you're measuring.",
    ]) {
      expect(looksLikeDeflection(t)).toBe(false);
    }
  });
  it("the non-answer heuristic stays quiet on ordinary prose", () => {
    for (const t of [
      "Doing well, thanks — how about you?",
      "Two options: the 7:10 or the 9:40. The earlier one is cheaper.",
      "Same plan as last week, just with the long run moved to Sunday.",
    ]) {
      expect(looksLikeNonAnswer(t)).toBe(false);
    }
  });
  it("truncates at a sentence boundary under the Discord limit", () => {
    const long = `${"A sentence that goes on. ".repeat(120)}`;
    const t = truncateForDiscord(long, 500);
    expect(t.length).toBeLessThanOrEqual(500);
    expect(t.endsWith("…")).toBe(true);
    expect(truncateForDiscord("short")).toBe("short");
  });
  it("system prompt carries persona, hot memories and the bail-out rule", () => {
    const p = buildQuickSystemPrompt({ agentName: "personal", soul: "Dry wit.", identity: "Name: Clawdy", hotMemories: ["Operator prefers terse answers"] });
    expect(p).toContain("Dry wit.");
    expect(p).toContain("Name: Clawdy");
    expect(p).toContain("Operator prefers terse answers");
    expect(p).toContain(NEEDS_TASK_LANE);
    expect(p).toContain("DO something");
    expect(p).not.toContain("What your full session can see");
  });
  it("system prompt names what the full session can see and marks hot memories as background (999.164)", () => {
    const p = buildQuickSystemPrompt({
      agentName: "personal",
      soul: undefined,
      identity: undefined,
      hotMemories: ["Operator is training for the Urban Cow half"],
      canSee: "- training, fitness & recovery data (strava, trainingpeaks, training engine)",
    });
    expect(p).toContain("What your full session can see and this quick lane cannot");
    expect(p).toContain("training, fitness & recovery data (strava, trainingpeaks, training engine)");
    expect(p).toContain("not their current state");
    expect(p).toContain("A generic answer to a personal question is a wrong answer");
  });
  it("user prompt includes recent turns in order, capped", () => {
    const u = buildQuickUserPrompt({ message: "and now?", recentTurns: Array.from({ length: 9 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `t${i}` })) });
    expect(u).not.toContain("t2");
    expect(u).toContain("t8");
    expect(u.endsWith("User: and now?")).toBe(true);
  });
  it("footer names the lane and the time", () => {
    expect(quickLaneFooter(2340)).toBe("quick lane · 2.3s");
  });
});

describe("recap buffer", () => {
  it("renders the recent exchanges once, then clears", () => {
    const b = new QuickLaneRecentBuffer(2);
    b.push("a", "q1", "a1", 1000);
    b.push("a", "q2", "a2", 2000);
    b.push("a", "q3", "a3", 3000);
    expect(b.size("a")).toBe(2);
    const r = b.drain("a", 4000);
    expect(r).toContain("q2");
    expect(r).toContain("q3");
    expect(r).not.toContain("q1");
    expect(b.drain("a", 4000)).toBe("");
  });
  it("drops stale entries", () => {
    const b = new QuickLaneRecentBuffer(4, 1000);
    b.push("a", "old", "x", 0);
    expect(b.drain("a", 5000)).toBe("");
  });
});

describe("agentSchema.fastLane", () => {
  it("is ON for every agent by default (999.164), fills defaults, and ignores the v1 classifier knobs", async () => {
    const { agentSchema, fastLaneSchema } = await import("../../config/schema.js");
    const defaults = { enabled: true, model: "haiku", answerTimeoutMs: 15_000, maxTokens: 500, maxMessageChars: 400 };
    // No block at all → the loader resolves the lane's defaults (on); an empty block parses the same.
    expect(agentSchema.parse({ name: "a", workspace: "/tmp/a" }).fastLane).toBeUndefined();
    expect(fastLaneSchema.parse({})).toEqual(defaults);
    expect(agentSchema.parse({ name: "a", workspace: "/tmp/a", fastLane: {} }).fastLane).toEqual(defaults);
    // Config can still turn it off per agent.
    expect(agentSchema.parse({ name: "a", workspace: "/tmp/a", fastLane: { enabled: false } }).fastLane?.enabled).toBe(false);
    // Operator task topics pass through.
    expect(agentSchema.parse({ name: "a", workspace: "/tmp/a", fastLane: { taskTopics: ["Urban Cow"] } }).fastLane?.taskTopics).toEqual(["Urban Cow"]);
    // v1-era knobs in an existing yaml are stripped, not rejected.
    const legacy = agentSchema.parse({ name: "a", workspace: "/tmp/a", fastLane: { enabled: true, classifierTimeoutMs: 8_000, minConfidence: 0.8 } });
    expect(legacy.fastLane).not.toHaveProperty("classifierTimeoutMs");
    expect(agentSchema.safeParse({ name: "a", workspace: "/tmp/a", fastLane: { enabled: true, model: "opus" } }).success).toBe(false);
  });
});
