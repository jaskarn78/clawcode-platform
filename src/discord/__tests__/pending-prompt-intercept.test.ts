/**
 * Phase 145 WS3 (Plan 04) Task 1 — pure pending-prompt registry + text-reply
 * parser + fail-closed operator allowlist + daemon-owned timeout.
 *
 * These cover the SC-3 text-fallback intercept landmine (RESEARCH Pitfall 4):
 * the registry resolves a blocked `ask_user_question` tool call from an
 * operator's parsed reply instead of spawning a spurious turn, and refuses
 * everyone else. All synthetic — no Discord client, no model, no IPC.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  PendingPromptRegistry,
  parseTextReply,
  isOperator,
} from "../../messaging/pending-prompt-registry.js";
import type {
  NeutralQuestion,
  NeutralAnswers,
} from "../../messaging/types.js";

const SINGLE: NeutralQuestion = {
  id: "q1",
  header: "Pick a colour",
  options: [
    { id: "red", label: "Red" },
    { id: "green", label: "Green" },
    { id: "blue", label: "Blue" },
  ],
};

const MULTI: NeutralQuestion = {
  id: "qm",
  header: "Pick toppings",
  multiSelect: true,
  options: [
    { id: "cheese", label: "Cheese" },
    { id: "mush", label: "Mushroom" },
    { id: "olive", label: "Olive" },
  ],
};

const OPERATOR = "op-123";
const STRANGER = "rando-999";

describe("parseTextReply (pure)", () => {
  it("maps a single-select numbered reply to the option id (1-based)", () => {
    expect(parseTextReply([SINGLE], "2")).toEqual({
      answers: [{ questionId: "q1", selectedOptionIds: ["green"] }],
    });
  });

  it("maps a multiSelect comma reply to multiple option ids", () => {
    expect(parseTextReply([MULTI], "1,3")).toEqual({
      answers: [{ questionId: "qm", selectedOptionIds: ["cheese", "olive"] }],
    });
  });

  it("maps a multiSelect space-separated reply", () => {
    expect(parseTextReply([MULTI], "2 3")).toEqual({
      answers: [{ questionId: "qm", selectedOptionIds: ["mush", "olive"] }],
    });
  });

  it("rejects an out-of-range index", () => {
    expect(parseTextReply([SINGLE], "9")).toBeNull();
  });

  it("rejects a garbage / non-numeric reply", () => {
    expect(parseTextReply([SINGLE], "purple")).toBeNull();
  });

  it("rejects an empty reply", () => {
    expect(parseTextReply([SINGLE], "   ")).toBeNull();
  });

  it("rejects multiple picks for a single-select question", () => {
    expect(parseTextReply([SINGLE], "1,2")).toBeNull();
  });

  it("rejects a duplicate pick in a multiSelect reply", () => {
    expect(parseTextReply([MULTI], "1,1")).toBeNull();
  });

  it("parses a multi-question batch (one line per question)", () => {
    expect(parseTextReply([SINGLE, MULTI], "1\n2,3")).toEqual({
      answers: [
        { questionId: "q1", selectedOptionIds: ["red"] },
        { questionId: "qm", selectedOptionIds: ["mush", "olive"] },
      ],
    });
  });

  it("rejects a batch reply with a wrong line count", () => {
    expect(parseTextReply([SINGLE, MULTI], "1")).toBeNull();
  });

  it("rejects an empty question batch", () => {
    expect(parseTextReply([], "1")).toBeNull();
  });
});

describe("isOperator (fail-closed)", () => {
  it("denies everyone when the allowlist is empty", () => {
    expect(isOperator([], OPERATOR)).toBe(false);
  });

  it("allows an id in the allowlist", () => {
    expect(isOperator([OPERATOR], OPERATOR)).toBe(true);
  });

  it("denies an id not in the allowlist", () => {
    expect(isOperator([OPERATOR], STRANGER)).toBe(false);
  });
});

describe("PendingPromptRegistry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function register(
    reg: PendingPromptRegistry,
    opts: {
      channelId?: string;
      allowlistIds?: readonly string[];
      questions?: readonly NeutralQuestion[];
      timeoutMs?: number;
    } = {},
  ) {
    const resolve = vi.fn<(a: NeutralAnswers) => void>();
    const onTimeout = vi.fn();
    reg.register({
      promptId: "p1",
      platform: "discord",
      channelId: opts.channelId ?? "chan-A",
      questions: opts.questions ?? [SINGLE],
      allowlistIds: opts.allowlistIds ?? [OPERATOR],
      timeoutMs: opts.timeoutMs ?? 600_000,
      resolve,
      onTimeout,
    });
    return { resolve, onTimeout };
  }

  it("tryResolve resolves on operator + parseable reply, invoking the stored resolve", () => {
    const reg = new PendingPromptRegistry();
    const { resolve } = register(reg);

    const result = reg.tryResolve("discord", "chan-A", OPERATOR, "3");
    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.answers).toEqual({
        answers: [{ questionId: "q1", selectedOptionIds: ["blue"] }],
      });
    }
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({
      answers: [{ questionId: "q1", selectedOptionIds: ["blue"] }],
    });
    // Entry cleared after resolve.
    expect(reg.size()).toBe(0);
  });

  it("tryResolve returns resolved:false when no pending prompt for the channel (falls through)", () => {
    const reg = new PendingPromptRegistry();
    register(reg, { channelId: "chan-A" });

    const result = reg.tryResolve("discord", "chan-OTHER", OPERATOR, "1");
    expect(result.resolved).toBe(false);
    // The chan-A entry is untouched.
    expect(reg.size()).toBe(1);
  });

  it("tryResolve ignores a non-operator reply (does NOT resolve, entry stays)", () => {
    const reg = new PendingPromptRegistry();
    const { resolve } = register(reg);

    const result = reg.tryResolve("discord", "chan-A", STRANGER, "1");
    expect(result.resolved).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
    expect(reg.size()).toBe(1);
  });

  it("tryResolve returns resolved:false on an operator garbage reply (does not eat the message)", () => {
    const reg = new PendingPromptRegistry();
    register(reg);

    const result = reg.tryResolve("discord", "chan-A", OPERATOR, "not-a-number");
    expect(result.resolved).toBe(false);
    // Entry stays so the prompt can still be answered / time out.
    expect(reg.size()).toBe(1);
  });

  it("empty allowlist → fail-closed (no one resolves)", () => {
    const reg = new PendingPromptRegistry();
    register(reg, { allowlistIds: [] });

    expect(reg.tryResolve("discord", "chan-A", OPERATOR, "1").resolved).toBe(
      false,
    );
  });

  it("times out cleanly: onTimeout fires, the entry is removed, resolve is not called", () => {
    vi.useFakeTimers();
    const reg = new PendingPromptRegistry();
    const { resolve, onTimeout } = register(reg, { timeoutMs: 1_000 });

    expect(reg.size()).toBe(1);
    vi.advanceTimersByTime(1_000);

    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
    expect(reg.size()).toBe(0);
  });

  it("a resolved prompt does NOT later fire its timeout (idempotent settle)", () => {
    vi.useFakeTimers();
    const reg = new PendingPromptRegistry();
    const { onTimeout } = register(reg, { timeoutMs: 1_000 });

    expect(reg.tryResolve("discord", "chan-A", OPERATOR, "1").resolved).toBe(
      true,
    );
    vi.advanceTimersByTime(2_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("cancel(promptId) clears the entry + timer without firing onTimeout", () => {
    vi.useFakeTimers();
    const reg = new PendingPromptRegistry();
    const { onTimeout } = register(reg, { timeoutMs: 1_000 });

    reg.cancel("p1");
    expect(reg.size()).toBe(0);
    vi.advanceTimersByTime(2_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("registering a second prompt for the same channel cancels the first's timer", () => {
    vi.useFakeTimers();
    const reg = new PendingPromptRegistry();
    const first = register(reg, { channelId: "chan-A", timeoutMs: 1_000 });
    // Re-register same channel.
    const second = register(reg, { channelId: "chan-A", timeoutMs: 5_000 });

    vi.advanceTimersByTime(1_000);
    // The first prompt's timer was cleared on re-register → never fires.
    expect(first.onTimeout).not.toHaveBeenCalled();
    expect(reg.size()).toBe(1);

    vi.advanceTimersByTime(4_000);
    expect(second.onTimeout).toHaveBeenCalledTimes(1);
  });
});
