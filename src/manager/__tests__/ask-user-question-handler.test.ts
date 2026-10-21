/**
 * Phase 145 WS3 (Plan 04) Task 3 — daemon-layer ask-user-question handler.
 *
 * Pins the branch selection (Discord-native vs text-fallback), the fail-closed
 * operator-allowlist gate (T-145-10), the register-before-post ordering, and
 * the daemon-owned bounded timeout that ALWAYS settles the worker (T-145-11) —
 * with injected fakes (no daemon, no Discord client, no Slack socket).
 */

import { describe, it, expect, vi } from "vitest";
import {
  handleAskUserQuestion,
  renderNumberedText,
  type AskUserQuestionDeps,
  type AskAgentBinding,
} from "../ask-user-question-handler.js";
import { PendingPromptRegistry } from "../../messaging/pending-prompt-registry.js";
import type {
  IpcAskUserQuestionParams,
  IpcAskUserQuestionResult,
} from "../../ipc/types.js";
import type { NeutralQuestion, NeutralAnswers } from "../../messaging/types.js";

const Q: NeutralQuestion = {
  id: "q1",
  header: "Proceed?",
  options: [
    { id: "yes", label: "Yes" },
    { id: "no", label: "No" },
  ],
};

const DISCORD_AGENT: AskAgentBinding = { name: "alice", channels: ["dch-1"] };
const SLACK_AGENT: AskAgentBinding = {
  name: "bob",
  slack: { channels: ["sch-1"] },
};
const NO_CHANNEL_AGENT: AskAgentBinding = { name: "ghost" };

const OPERATOR = ["op-1"];

const noopLog = { error: vi.fn(), info: vi.fn() };

function makeDeps(
  over: Partial<AskUserQuestionDeps> = {},
): AskUserQuestionDeps {
  return {
    agents: [DISCORD_AGENT, SLACK_AGENT, NO_CHANNEL_AGENT],
    registry: new PendingPromptRegistry(),
    allowlistIds: OPERATOR,
    newPromptId: () => "prompt-fixed",
    defaultTimeoutMs: 10_000,
    maxTimeoutMs: 60_000,
    renderNative: vi.fn(async () => null),
    postText: vi.fn(async () => undefined),
    log: noopLog,
    ...over,
  };
}

const params = (
  agent: string,
  questions: readonly NeutralQuestion[] = [Q],
  timeoutMs?: number,
): IpcAskUserQuestionParams => ({ agent, questions, timeoutMs });

describe("handleAskUserQuestion — validation + resolution gates", () => {
  it("returns invalid-request for an empty question batch", async () => {
    const r = await handleAskUserQuestion(makeDeps(), params("alice", []));
    expect(r).toEqual({ ok: false, reason: "invalid-request" });
  });

  it("returns invalid-request for more than 4 questions", async () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ ...Q, id: `q${i}` }));
    const r = await handleAskUserQuestion(makeDeps(), params("alice", five));
    expect(r).toEqual({ ok: false, reason: "invalid-request" });
  });

  it("returns unknown-agent when the agent is not bound", async () => {
    const r = await handleAskUserQuestion(makeDeps(), params("nobody"));
    expect(r).toEqual({ ok: false, reason: "unknown-agent" });
  });

  it("FAIL-CLOSED: empty allowlist → no-operator (before any post/render)", async () => {
    const renderNative = vi.fn(async () => null);
    const postText = vi.fn(async () => undefined);
    const deps = makeDeps({ allowlistIds: [], renderNative, postText });
    const r = await handleAskUserQuestion(deps, params("alice"));
    expect(r).toEqual({ ok: false, reason: "no-operator" });
    // No prompt was ever surfaced.
    expect(renderNative).not.toHaveBeenCalled();
    expect(postText).not.toHaveBeenCalled();
  });

  it("returns no-channel when the agent has neither a Discord nor Slack binding", async () => {
    const r = await handleAskUserQuestion(makeDeps(), params("ghost"));
    expect(r).toEqual({ ok: false, reason: "no-channel" });
  });
});

describe("handleAskUserQuestion — Discord-native branch", () => {
  it("routes a Discord-bound agent to renderNative and round-trips the answer", async () => {
    const answer: NeutralAnswers = {
      answers: [{ questionId: "q1", selectedOptionIds: ["yes"] }],
    };
    const renderNative = vi.fn(async () => answer);
    const postText = vi.fn(async () => undefined);
    const deps = makeDeps({ renderNative, postText });

    const r = await handleAskUserQuestion(deps, params("alice"));

    expect(renderNative).toHaveBeenCalledTimes(1);
    expect(renderNative).toHaveBeenCalledWith(
      "dch-1",
      [Q],
      OPERATOR,
      10_000,
      "prompt-fixed",
    );
    // Discord path does NOT use the text fallback.
    expect(postText).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: true, answers: answer } satisfies IpcAskUserQuestionResult);
  });

  it("returns a clean timeout when renderNative resolves null (no answer)", async () => {
    const deps = makeDeps({ renderNative: vi.fn(async () => null) });
    const r = await handleAskUserQuestion(deps, params("alice"));
    expect(r).toEqual({ ok: false, reason: "timeout" });
  });
});

describe("handleAskUserQuestion — Slack text-fallback branch", () => {
  it("posts numbered text AND registers a pending prompt for a Slack-bound agent", async () => {
    const registry = new PendingPromptRegistry();
    const registerSpy = vi.spyOn(registry, "register");
    const postText = vi.fn(async () => undefined);
    const deps = makeDeps({ registry, postText });

    // The handler will block on the registry/timeout; race it against a short
    // fake answer delivered through the registry to prove the round-trip.
    const answer: NeutralAnswers = {
      answers: [{ questionId: "q1", selectedOptionIds: ["no"] }],
    };
    const resultP = handleAskUserQuestion(deps, params("bob"));

    // Let the synchronous register + post fire.
    await Promise.resolve();
    expect(postText).toHaveBeenCalledTimes(1);
    expect(postText).toHaveBeenCalledWith(
      "slack",
      "sch-1",
      "bob",
      expect.stringContaining("1. Proceed?"),
    );
    expect(registerSpy).toHaveBeenCalledTimes(1);
    const regArg = registerSpy.mock.calls[0][0];
    expect(regArg.platform).toBe("slack");
    expect(regArg.channelId).toBe("sch-1");
    expect(regArg.allowlistIds).toEqual(OPERATOR);

    // Deliver the operator answer through the registry (the Plan-07 Slack
    // intercept will call tryResolve; here we drive it directly).
    const resolved = registry.tryResolve("slack", "sch-1", "op-1", "2");
    expect(resolved.resolved).toBe(true);

    const r = await resultP;
    expect(r).toEqual({ ok: true, answers: answer });
  });

  it("returns a clean timeout (and cancels the entry) when the Slack post fails", async () => {
    const registry = new PendingPromptRegistry();
    const cancelSpy = vi.spyOn(registry, "cancel");
    const deps = makeDeps({
      registry,
      postText: vi.fn(async () => {
        throw new Error("slack down");
      }),
    });
    const r = await handleAskUserQuestion(deps, params("bob"));
    expect(r).toEqual({ ok: false, reason: "timeout" });
    expect(cancelSpy).toHaveBeenCalledWith("prompt-fixed");
  });
});

describe("handleAskUserQuestion — daemon-owned timeout", () => {
  it("never hangs: resolves to a clean timeout when no one answers (real short bound)", async () => {
    // Slack agent, postText succeeds but no reply ever arrives → the bounded
    // timeout must settle the worker.
    const deps = makeDeps({
      defaultTimeoutMs: 30,
      maxTimeoutMs: 30,
      postText: vi.fn(async () => undefined),
    });
    const start = Date.now();
    const r = await handleAskUserQuestion(deps, params("bob"));
    expect(r).toEqual({ ok: false, reason: "timeout" });
    // Settled in roughly the bound, not hung.
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it("caps a caller-supplied timeoutMs at maxTimeoutMs (passed to renderNative)", async () => {
    const renderNative: AskUserQuestionDeps["renderNative"] = vi.fn(
      async () => null,
    );
    const deps = makeDeps({ renderNative, maxTimeoutMs: 5_000 });
    await handleAskUserQuestion(deps, params("alice", [Q], 999_999));
    // 4th positional arg (index 3) is timeoutMs.
    const calls = (renderNative as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][3]).toBe(5_000);
  });
});

describe("renderNumberedText (pure)", () => {
  it("numbers questions + options and adds a single-question reply hint", () => {
    const text = renderNumberedText([Q]);
    expect(text).toContain("**1. Proceed?**");
    expect(text).toContain("1. Yes");
    expect(text).toContain("2. No");
    expect(text).toContain("Reply with the option number.");
  });

  it("marks a multiSelect question + uses the per-line hint for a batch", () => {
    const multi: NeutralQuestion = { ...Q, id: "qm", multiSelect: true };
    const text = renderNumberedText([Q, multi]);
    expect(text).toContain("comma-separated");
    expect(text).toContain("one line per question");
  });
});
