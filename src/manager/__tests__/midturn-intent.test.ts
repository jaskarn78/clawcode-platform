/**
 * Phase 999.100 — mid-turn intent module tests.
 *
 * Pins:
 *   - heuristic fast-path (🧭 marker / whole-message stop verbs / reply-to)
 *   - the <mid-turn-user-steering> envelope shape
 *   - classifier reply parsing (strict-ish JSON extraction + clamping)
 *   - classifyMidturnIntent fail-safe (throw/timeout/garbage → new_task)
 *   - routeMidturnMessage decision table incl. confidence gates, stopIntent
 *     kill-switch, inject-declined fallback, interrupt-failure fallback
 */
import { describe, it, expect, vi } from "vitest";

import {
  detectMidturnHeuristic,
  isStatusPing,
  STATUS_PING_MAX_CHARS,
  frameMidturnSteer,
  parseClassifierReply,
  classifyMidturnIntent,
  routeMidturnMessage,
  resolveSteeringRuntime,
  STEERING_BASELINE,
  MIDTURN_STEER_TAG,
  MIDTURN_LATE_STEER_TAG,
  STOP_VERB_REGEX,
  type MidturnRouteDeps,
} from "../midturn-intent.js";

const SILENT_LOG = { info: () => undefined, warn: () => undefined };

describe("detectMidturnHeuristic", () => {
  it("🧭 leading marker → steer", () => {
    expect(
      detectMidturnHeuristic({ content: "🧭 use the other file", isReplyToInFlightTrigger: false }),
    ).toBe("steer");
  });

  it("whole-message stop verbs → stop", () => {
    for (const msg of ["stop", "Stop!", "cancel that", "nvm", "never mind", "abort", "don't bother"]) {
      expect(detectMidturnHeuristic({ content: msg, isReplyToInFlightTrigger: false })).toBe("stop");
    }
  });

  it("stop verb embedded in a longer sentence does NOT stop", () => {
    for (const msg of [
      "stop by the store later",
      "we should cancel the meeting tomorrow",
      "can you stop the dev server as part of the task",
    ]) {
      expect(detectMidturnHeuristic({ content: msg, isReplyToInFlightTrigger: false })).toBeNull();
    }
  });

  it("reply to the in-flight trigger → steer", () => {
    expect(
      detectMidturnHeuristic({ content: "make it blue instead", isReplyToInFlightTrigger: true }),
    ).toBe("steer");
  });

  it("plain unrelated text → null (falls to LLM leg)", () => {
    expect(
      detectMidturnHeuristic({ content: "what's the weather tomorrow?", isReplyToInFlightTrigger: false }),
    ).toBeNull();
  });

  it("empty / whitespace → null", () => {
    expect(detectMidturnHeuristic({ content: "   ", isReplyToInFlightTrigger: true })).toBeNull();
  });
});

describe("STOP_VERB_REGEX", () => {
  it("is anchored — never matches mid-sentence", () => {
    expect(STOP_VERB_REGEX.test("please stop the bleeding edge deploy and rollback")).toBe(false);
    expect(STOP_VERB_REGEX.test("stop.")).toBe(true);
  });
});

describe("isStatusPing", () => {
  it("matches the listed check-ins", () => {
    for (const msg of [
      "eta",
      "eta?",
      "eta??",
      "eta!",
      "we good?",
      "we good",
      "are we good?",
      "status",
      "status?",
      "still working?",
      "still going?",
      "any update",
      "any updates",
      "any update?",
      "update?",
      "update!",
      "updates?",
      "?",
      "???",
      "meow",
      "you there?",
      "u there?",
      "you around?",
      "how long?",
      "how much longer?",
      "almost done?",
      "ping",
      "hey eta",
      "hey, we good?",
    ]) {
      expect(isStatusPing(msg), msg).toBe(true);
    }
  });

  it("strips a leading @mention", () => {
    expect(isStatusPing("<@123456789> eta?")).toBe(true);
    expect(isStatusPing("<@!123456789> we good?")).toBe(true);
    expect(isStatusPing("<@&987654321> status")).toBe(true);
  });

  it("does NOT match real content that merely starts with a status word", () => {
    for (const msg of [
      "status of smith?",
      "any update on the rollover?",
      "we good on the 401k rebalance?",
      "eta for the plan draft is when?",
      "still working on the wrong file",
    ]) {
      expect(isStatusPing(msg), msg).toBe(false);
    }
  });

  it("does NOT treat continue / stop / acks / greetings / real asks as a ping", () => {
    for (const msg of [
      "continue",
      "stop",
      "keep going but skip section 3",
      "no, the other file",
      "thanks",
      "yes",
      "what's Jordan's birthday?",
      // Bare greetings must reach the agent, not the idle "Nothing running." line.
      "hey",
      "hello",
      "yo",
    ]) {
      expect(isStatusPing(msg), msg).toBe(false);
    }
  });

  it("empty / bare-mention / over-cap → false", () => {
    expect(isStatusPing("")).toBe(false);
    expect(isStatusPing("   ")).toBe(false);
    expect(isStatusPing("<@123456789>")).toBe(false);
    // Over the char cap even though it starts with a keyword.
    expect(isStatusPing("eta" + "!".repeat(STATUS_PING_MAX_CHARS))).toBe(false);
  });
});

describe("frameMidturnSteer", () => {
  it("wraps the formatted message in the pinned envelope tag", () => {
    const framed = frameMidturnSteer("actually make it blue");
    expect(framed.startsWith(`<${MIDTURN_STEER_TAG}>`)).toBe(true);
    expect(framed.endsWith(`</${MIDTURN_STEER_TAG}>`)).toBe(true);
    expect(framed).toContain("actually make it blue");
    expect(framed).toContain("Do NOT restart");
  });
});

describe("parseClassifierReply", () => {
  it("parses a clean JSON object", () => {
    expect(parseClassifierReply('{"intent":"steer","confidence":0.9}')).toEqual({
      intent: "steer",
      confidence: 0.9,
    });
  });

  it("extracts JSON embedded in prose and clamps confidence", () => {
    const out = parseClassifierReply('Sure! {"intent":"stop","confidence":7}');
    expect(out.intent).toBe("stop");
    expect(out.confidence).toBe(1);
  });

  it("throws on a missing/invalid intent", () => {
    expect(() => parseClassifierReply('{"intent":"maybe","confidence":0.5}')).toThrow();
    expect(() => parseClassifierReply("no json here")).toThrow();
  });

  it("non-numeric confidence degrades to 0 instead of throwing", () => {
    expect(parseClassifierReply('{"intent":"steer","confidence":"high"}').confidence).toBe(0);
  });
});

describe("classifyMidturnIntent", () => {
  it("returns the LLM verdict on a clean reply", async () => {
    const out = await classifyMidturnIntent({
      callClassifier: async () => '{"intent":"steer","confidence":0.92}',
      triggerExcerpt: "build the dashboard",
      elapsedInFlightMs: 12_000,
      newMessage: "use dark mode colors",
      timeoutMs: 1000,
      log: SILENT_LOG,
      agentName: "t",
    });
    expect(out).toEqual({ intent: "steer", confidence: 0.92, source: "llm" });
  });

  it("classifier throw → new_task fallback", async () => {
    const out = await classifyMidturnIntent({
      callClassifier: async () => {
        throw new Error("bridge down");
      },
      triggerExcerpt: null,
      elapsedInFlightMs: null,
      newMessage: "x",
      timeoutMs: 1000,
      log: SILENT_LOG,
      agentName: "t",
    });
    expect(out).toEqual({ intent: "new_task", confidence: 0, source: "fallback" });
  });

  it("timeout aborts the call → new_task fallback", async () => {
    const out = await classifyMidturnIntent({
      callClassifier: (_s, _u, opts) =>
        new Promise((_resolve, reject) => {
          opts.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      triggerExcerpt: "x",
      elapsedInFlightMs: 1,
      newMessage: "y",
      timeoutMs: 20,
      log: SILENT_LOG,
      agentName: "t",
    });
    expect(out.intent).toBe("new_task");
    expect(out.source).toBe("fallback");
  });

  it("garbage reply → new_task fallback", async () => {
    const out = await classifyMidturnIntent({
      callClassifier: async () => "IDK lol",
      triggerExcerpt: "x",
      elapsedInFlightMs: 1,
      newMessage: "y",
      timeoutMs: 1000,
      log: SILENT_LOG,
      agentName: "t",
    });
    expect(out.source).toBe("fallback");
  });
});

describe("resolveSteeringRuntime", () => {
  it("undefined → frozen baseline (feature off)", () => {
    expect(resolveSteeringRuntime(undefined)).toEqual(STEERING_BASELINE);
    expect(STEERING_BASELINE.autoClassify).toBe(false);
  });

  it("partial → per-field fill from baseline", () => {
    const out = resolveSteeringRuntime({ autoClassify: true, minConfidence: 0.5 });
    expect(out.autoClassify).toBe(true);
    expect(out.minConfidence).toBe(0.5);
    expect(out.stopIntent).toBe(STEERING_BASELINE.stopIntent);
    expect(out.classifierTimeoutMs).toBe(STEERING_BASELINE.classifierTimeoutMs);
  });
});

// ---------------------------------------------------------------------------
// routeMidturnMessage decision table
// ---------------------------------------------------------------------------

function buildDeps(overrides: Partial<MidturnRouteDeps> = {}): {
  deps: MidturnRouteDeps;
  inject: ReturnType<typeof vi.fn>;
  interruptAgent: ReturnType<typeof vi.fn>;
} {
  const inject = vi.fn(() => ({ injected: true }));
  const interruptAgent = vi.fn(async () => ({ interrupted: true, hadActiveTurn: true }));
  const deps: MidturnRouteDeps = {
    inject,
    interruptAgent,
    callClassifier: async () => '{"intent":"new_task","confidence":0.9}',
    log: SILENT_LOG,
    ...overrides,
  };
  return { deps, inject, interruptAgent };
}

const CFG_ON = resolveSteeringRuntime({ autoClassify: true });

describe("routeMidturnMessage", () => {
  it("heuristic steer (🧭) injects the framed envelope without calling the classifier", async () => {
    const classifier = vi.fn();
    const { deps, inject } = buildDeps({ callClassifier: classifier as never });
    const out = await routeMidturnMessage({
      agentName: "a",
      content: "🧭 tighten the copy",
      formattedMessage: "[Discord message from owner_a] 🧭 tighten the copy",
      isReplyToInFlightTrigger: false,
      triggerExcerpt: "write landing page",
      elapsedInFlightMs: 5000,
      cfg: CFG_ON,
      deps,
    });
    expect(out.action).toBe("steered");
    expect(classifier).not.toHaveBeenCalled();
    expect(inject).toHaveBeenCalledTimes(1);
    const framed = inject.mock.calls[0]?.[0] as string;
    expect(framed).toContain(`<${MIDTURN_STEER_TAG}>`);
    expect(framed).toContain("tighten the copy");
  });

  it("LLM steer above minConfidence injects", async () => {
    const { deps, inject } = buildDeps({
      callClassifier: async () => '{"intent":"steer","confidence":0.9}',
    });
    const out = await routeMidturnMessage({
      agentName: "a",
      content: "actually target Q3 numbers",
      formattedMessage: "actually target Q3 numbers",
      isReplyToInFlightTrigger: false,
      triggerExcerpt: "build the report",
      elapsedInFlightMs: 8000,
      cfg: CFG_ON,
      deps,
    });
    expect(out.action).toBe("steered");
    expect(inject).toHaveBeenCalled();
  });

  it("LLM steer below minConfidence dispatches (queue)", async () => {
    const { deps, inject } = buildDeps({
      callClassifier: async () => '{"intent":"steer","confidence":0.5}',
    });
    const out = await routeMidturnMessage({
      agentName: "a",
      content: "hmm maybe blue?",
      formattedMessage: "hmm maybe blue?",
      isReplyToInFlightTrigger: false,
      triggerExcerpt: null,
      elapsedInFlightMs: null,
      cfg: CFG_ON,
      deps,
    });
    expect(out).toMatchObject({ action: "dispatch", reason: "below-confidence" });
    expect(inject).not.toHaveBeenCalled();
  });

  it("inject declined (turn ended) → dispatch fallback", async () => {
    const { deps } = buildDeps({
      inject: vi.fn(() => ({ injected: false, reason: "idle" })) as never,
    });
    const out = await routeMidturnMessage({
      agentName: "a",
      content: "🧭 go",
      formattedMessage: "go",
      isReplyToInFlightTrigger: false,
      triggerExcerpt: null,
      elapsedInFlightMs: null,
      cfg: CFG_ON,
      deps,
    });
    expect(out).toMatchObject({ action: "dispatch", reason: "inject-declined" });
  });

  it("inject declined → dispatchText carries the late-steer envelope + trigger excerpt", async () => {
    const { deps } = buildDeps({
      inject: vi.fn(() => ({ injected: false, reason: "idle" })) as never,
    });
    const out = await routeMidturnMessage({
      agentName: "a",
      content: "🧭 use the OTHER file",
      formattedMessage: "use the OTHER file",
      isReplyToInFlightTrigger: false,
      triggerExcerpt: "rename the config file",
      elapsedInFlightMs: 4_000,
      cfg: CFG_ON,
      deps,
    });
    expect(out).toMatchObject({ action: "dispatch", reason: "inject-declined" });
    const text = (out as { dispatchText?: string }).dispatchText;
    expect(text).toBeDefined();
    expect(text).toContain(`<${MIDTURN_LATE_STEER_TAG}>`);
    expect(text).toContain(`</${MIDTURN_LATE_STEER_TAG}>`);
    expect(text).toContain("use the OTHER file");
    expect(text).toContain("rename the config file");
  });

  it("inject THREW → same late-steer envelope fallback", async () => {
    const { deps } = buildDeps({
      inject: vi.fn(() => {
        throw new Error("handle gone");
      }) as never,
    });
    const out = await routeMidturnMessage({
      agentName: "a",
      content: "🧭 make it blue",
      formattedMessage: "make it blue",
      isReplyToInFlightTrigger: false,
      triggerExcerpt: null,
      elapsedInFlightMs: null,
      cfg: CFG_ON,
      deps,
    });
    expect(out).toMatchObject({ action: "dispatch", reason: "inject-declined" });
    expect((out as { dispatchText?: string }).dispatchText).toContain(
      `<${MIDTURN_LATE_STEER_TAG}>`,
    );
  });

  it("new_task dispatch carries NO dispatchText", async () => {
    const { deps } = buildDeps({
      callClassifier: vi.fn(async () =>
        JSON.stringify({ intent: "new_task", confidence: 0.9 }),
      ) as never,
    });
    const out = await routeMidturnMessage({
      agentName: "a",
      content: "unrelated question",
      formattedMessage: "unrelated question",
      isReplyToInFlightTrigger: false,
      triggerExcerpt: null,
      elapsedInFlightMs: null,
      cfg: CFG_ON,
      deps,
    });
    expect(out).toMatchObject({ action: "dispatch", reason: "new-task" });
    expect((out as { dispatchText?: string }).dispatchText).toBeUndefined();
  });

  it("heuristic stop interrupts and never dispatches", async () => {
    const { deps, interruptAgent, inject } = buildDeps();
    const out = await routeMidturnMessage({
      agentName: "a",
      content: "stop",
      formattedMessage: "stop",
      isReplyToInFlightTrigger: false,
      triggerExcerpt: null,
      elapsedInFlightMs: null,
      cfg: CFG_ON,
      deps,
    });
    expect(out.action).toBe("stopped");
    expect(interruptAgent).toHaveBeenCalledTimes(1);
    expect(inject).not.toHaveBeenCalled();
  });

  it("stopIntent:false disables BOTH stop sources", async () => {
    const { deps, interruptAgent } = buildDeps();
    const out = await routeMidturnMessage({
      agentName: "a",
      content: "stop",
      formattedMessage: "stop",
      isReplyToInFlightTrigger: false,
      triggerExcerpt: null,
      elapsedInFlightMs: null,
      cfg: resolveSteeringRuntime({ autoClassify: true, stopIntent: false }),
      deps,
    });
    expect(out).toMatchObject({ action: "dispatch", reason: "stop-disabled" });
    expect(interruptAgent).not.toHaveBeenCalled();
  });

  it("LLM stop below stopMinConfidence dispatches instead of interrupting", async () => {
    const { deps, interruptAgent } = buildDeps({
      callClassifier: async () => '{"intent":"stop","confidence":0.8}',
    });
    const out = await routeMidturnMessage({
      agentName: "a",
      content: "eh just leave it I guess",
      formattedMessage: "eh just leave it I guess",
      isReplyToInFlightTrigger: false,
      triggerExcerpt: null,
      elapsedInFlightMs: null,
      cfg: CFG_ON, // stopMinConfidence 0.85
      deps,
    });
    expect(out).toMatchObject({ action: "dispatch", reason: "below-confidence" });
    expect(interruptAgent).not.toHaveBeenCalled();
  });

  it("interrupt failure → dispatch fallback (message not lost)", async () => {
    const { deps } = buildDeps({
      interruptAgent: vi.fn(async () => {
        throw new Error("no handle");
      }) as never,
    });
    const out = await routeMidturnMessage({
      agentName: "a",
      content: "stop",
      formattedMessage: "stop",
      isReplyToInFlightTrigger: false,
      triggerExcerpt: null,
      elapsedInFlightMs: null,
      cfg: CFG_ON,
      deps,
    });
    expect(out).toMatchObject({ action: "dispatch", reason: "stop-failed" });
  });

  it("new_task classification dispatches (today's path)", async () => {
    const { deps, inject, interruptAgent } = buildDeps({
      callClassifier: async () => '{"intent":"new_task","confidence":0.95}',
    });
    const out = await routeMidturnMessage({
      agentName: "a",
      content: "also what's on my calendar tomorrow?",
      formattedMessage: "also what's on my calendar tomorrow?",
      isReplyToInFlightTrigger: false,
      triggerExcerpt: "refactor the auth module",
      elapsedInFlightMs: 60_000,
      cfg: CFG_ON,
      deps,
    });
    expect(out).toMatchObject({ action: "dispatch", reason: "new-task" });
    expect(inject).not.toHaveBeenCalled();
    expect(interruptAgent).not.toHaveBeenCalled();
  });
});
