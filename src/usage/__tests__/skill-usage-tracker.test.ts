/**
 * Phase 53 Plan 03 — SkillUsageTracker tests.
 *
 * Covers the in-memory per-agent ring buffer + extractSkillMentions helper.
 * All state lives in-process; no SQLite, no filesystem.
 */

import { describe, it, expect } from "vitest";
import {
  SkillUsageTracker,
  extractSkillMentions,
} from "../skill-usage-tracker.js";

describe("SkillUsageTracker", () => {
  it("Test 1: new tracker starts empty for any agent", () => {
    const tracker = new SkillUsageTracker({ capacity: 20 });
    const window = tracker.getWindow("agent-a");
    expect(window.turns).toBe(0);
    expect(window.agent).toBe("agent-a");
    expect(window.capacity).toBe(20);
    expect(window.recentlyUsed.size).toBe(0);
  });

  it("Test 2: recordTurn adds one turn to agent's ring buffer", () => {
    const tracker = new SkillUsageTracker({ capacity: 20 });
    tracker.recordTurn("agent-a", {
      mentionedSkills: ["search-first", "content-engine"],
    });
    const window = tracker.getWindow("agent-a");
    expect(window.turns).toBe(1);
  });

  it("Test 3: getRecentlyUsedSkills aggregates mentions across turns", () => {
    const tracker = new SkillUsageTracker({ capacity: 20 });
    tracker.recordTurn("agent-a", {
      mentionedSkills: ["search-first", "content-engine"],
    });
    const used = tracker.getRecentlyUsedSkills("agent-a");
    expect(used.has("search-first")).toBe(true);
    expect(used.has("content-engine")).toBe(true);
    expect(used.size).toBe(2);
  });

  it("Test 4: ring buffer caps at capacity (oldest evicted)", () => {
    const tracker = new SkillUsageTracker({ capacity: 5 });
    for (let i = 0; i < 10; i++) {
      tracker.recordTurn("agent-a", { mentionedSkills: [`skill-${i}`] });
    }
    const window = tracker.getWindow("agent-a");
    expect(window.turns).toBe(5);
    // Only the most recent 5 skills remain (skill-5 through skill-9)
    expect(window.recentlyUsed.has("skill-0")).toBe(false);
    expect(window.recentlyUsed.has("skill-4")).toBe(false);
    expect(window.recentlyUsed.has("skill-5")).toBe(true);
    expect(window.recentlyUsed.has("skill-9")).toBe(true);
  });

  it("Test 5: per-agent isolation — recording on agent-a does not affect agent-b", () => {
    const tracker = new SkillUsageTracker({ capacity: 20 });
    tracker.recordTurn("agent-a", { mentionedSkills: ["skill-1"] });
    tracker.recordTurn("agent-a", { mentionedSkills: ["skill-2"] });
    expect(tracker.getWindow("agent-a").turns).toBe(2);
    expect(tracker.getWindow("agent-b").turns).toBe(0);
  });

  it("Test 6: getWindow returns frozen object + frozen Set", () => {
    const tracker = new SkillUsageTracker({ capacity: 20 });
    tracker.recordTurn("agent-a", { mentionedSkills: ["skill-1"] });
    const window = tracker.getWindow("agent-a");
    expect(Object.isFrozen(window)).toBe(true);
    expect(Object.isFrozen(window.recentlyUsed)).toBe(true);
    // Independence: subsequent recordTurn calls do not mutate the snapshot
    // we already captured (getWindow builds a fresh Set each call).
    tracker.recordTurn("agent-a", { mentionedSkills: ["skill-2"] });
    expect(window.recentlyUsed.has("skill-2")).toBe(false);
    expect(window.recentlyUsed.has("skill-1")).toBe(true);
  });

  it("Test 7: capacity floor — constructor throws RangeError when capacity < 5", () => {
    expect(() => new SkillUsageTracker({ capacity: 4 })).toThrow(RangeError);
    expect(() => new SkillUsageTracker({ capacity: 0 })).toThrow(RangeError);
    expect(() => new SkillUsageTracker({ capacity: 5 })).not.toThrow();
  });

  it("Test 8: resetAgent drops that agent's buffer (per-agent scoped)", () => {
    const tracker = new SkillUsageTracker({ capacity: 20 });
    tracker.recordTurn("agent-a", { mentionedSkills: ["skill-1"] });
    tracker.recordTurn("agent-b", { mentionedSkills: ["skill-2"] });
    tracker.resetAgent("agent-a");
    expect(tracker.getWindow("agent-a").turns).toBe(0);
    expect(tracker.getWindow("agent-b").turns).toBe(1);
  });
});

describe("extractSkillMentions", () => {
  const catalog = ["search-first", "content-engine", "market-research"];

  it("Test 9: word-boundary match returns mentioned skills", () => {
    const text = "I will use search-first and content-engine for this.";
    const mentions = extractSkillMentions(text, catalog);
    expect(mentions).toContain("search-first");
    expect(mentions).toContain("content-engine");
    expect(mentions).not.toContain("market-research");
  });

  it("Test 10: substring match is NOT a mention (word-boundary guard)", () => {
    const text = "subsearch-firstline should NOT match search-first here";
    const mentions = extractSkillMentions(text, ["search-first"]);
    // "search-first" DOES appear as a standalone in the tail of the sentence,
    // so this specific text returns it. A pure-substring variant ensures no match.
    const pureSubstring = "subsearch-firstline is unrelated";
    const noMatch = extractSkillMentions(pureSubstring, ["search-first"]);
    expect(noMatch).toEqual([]);
    // The mixed text returns only the standalone usage.
    expect(mentions).toContain("search-first");
  });

  it("Test 11: dedup — identical mention only appears once", () => {
    const text = "search-first search-first, search-first!";
    const mentions = extractSkillMentions(text, ["search-first"]);
    expect(mentions).toEqual(["search-first"]);
  });

  it("Test 12: case-insensitive matching", () => {
    const text = "Use SEARCH-FIRST and Content-Engine";
    const mentions = extractSkillMentions(text, catalog);
    expect(mentions).toContain("search-first");
    expect(mentions).toContain("content-engine");
  });

  it("Test 13: empty text returns empty array", () => {
    expect(extractSkillMentions("", catalog)).toEqual([]);
  });

  it("Test 14: empty catalog returns empty array", () => {
    expect(extractSkillMentions("search-first is here", [])).toEqual([]);
  });

  it("Test 15: returns frozen array", () => {
    const mentions = extractSkillMentions("search-first", catalog);
    expect(Object.isFrozen(mentions)).toBe(true);
  });
});
