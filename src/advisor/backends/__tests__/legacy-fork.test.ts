/**
 * Parity + invariant tests for `LegacyForkAdvisor` and the underlying
 * `forkAdvisorConsult()` primitive extracted from `daemon.ts:9843–9854`
 * in Plan 117-03.
 *
 * Pattern: `src/manager/escalation.test.ts:1–16` — mock `SessionManager`
 * with `vi.fn()` covering `forkSession`, `dispatchTurn`, `stopAgent`.
 *
 * Coverage (per Plan 117-03 §Verification + RESEARCH §5):
 *   A. Happy path — `consult()` returns `{ answer }` matching the
 *      mock `dispatchTurn` return; `forkSession` called with parent
 *      agent + modelOverride + systemPromptOverride; `dispatchTurn`
 *      called with fork name + question; `stopAgent` called with
 *      fork name in `finally`.
 *   B. Regression — try/finally stopAgent invariant: when
 *      `dispatchTurn` rejects, `consult()` propagates the rejection
 *      AND `stopAgent` is still called. This is the most important
 *      behavioral guarantee preserved by the extraction.
 *   C. `id === "fork"` — the backend self-identifies as the legacy
 *      fork backend for registry lookup.
 *
 * EXTRACTION_BASELINE — verbatim copy of the pre-117-03 fork body
 * from `src/manager/daemon.ts:9843–9854` (the source of truth this
 * test pins behavior against; do not delete during reviewer diff
 * comparison):
 *
 *   const fork = await manager.forkSession(agentName, {
 *     modelOverride: "opus" as const,
 *     systemPromptOverride: systemPrompt,
 *   });
 *
 *   let answer: string;
 *   try {
 *     answer = await manager.dispatchTurn(fork.forkName, question);
 *   } finally {
 *     // Always clean up the fork
 *     await manager.stopAgent(fork.forkName).catch(() => {});
 *   }
 *
 * (System-prompt assembly + memory-context retrieval + budget +
 * truncation lived in the surrounding IPC handler in pre-117-03
 * code; those concerns are NOT part of forkAdvisorConsult and are
 * NOT covered here — see `src/advisor/__tests__/service.test.ts`.)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { LegacyForkAdvisor, AdvisorTimeoutError } from "../legacy-fork.js";
import { forkAdvisorConsult } from "../../../manager/daemon.js";
import type { SessionManager } from "../../../manager/session-manager.js";

function createMockSessionManager() {
  return {
    forkSession: vi.fn().mockResolvedValue({
      forkName: "agent-fork-abc",
      parentAgent: "agent",
      sessionId: "sess-1",
    }),
    dispatchTurn: vi.fn().mockResolvedValue("advice text"),
    stopAgent: vi.fn().mockResolvedValue(undefined),
    getMemoryStore: vi.fn().mockReturnValue(null),
    getEmbedder: vi.fn(),
  } as unknown as SessionManager;
}

const DEFAULT_ARGS = {
  agent: "agent",
  question: "q",
  systemPrompt: "sp",
  advisorModel: "opus",
};

describe("LegacyForkAdvisor", () => {
  let mockManager: SessionManager;
  let advisor: LegacyForkAdvisor;

  beforeEach(() => {
    mockManager = createMockSessionManager();
    advisor = new LegacyForkAdvisor(mockManager);
  });

  // Assertion C — id surface
  it("identifies as the legacy fork backend (id === 'fork')", () => {
    expect(advisor.id).toBe("fork");
  });

  // Assertion A — happy path parity
  describe("consult() — happy path", () => {
    it("returns the raw answer from dispatchTurn (no truncation)", async () => {
      const result = await advisor.consult(DEFAULT_ARGS);
      expect(result).toEqual({ answer: "advice text" });
    });

    it("forks the parent agent with the supplied advisorModel + systemPrompt", async () => {
      await advisor.consult({
        agent: "agent",
        question: "should I refactor?",
        systemPrompt: "You are an advisor to agent \"agent\".",
        advisorModel: "opus",
      });
      expect(mockManager.forkSession).toHaveBeenCalledTimes(1);
      expect(mockManager.forkSession).toHaveBeenCalledWith("agent", {
        modelOverride: "opus",
        systemPromptOverride: "You are an advisor to agent \"agent\".",
      });
    });

    it("dispatches one turn carrying the question to the fork", async () => {
      await advisor.consult({
        ...DEFAULT_ARGS,
        question: "should I refactor?",
      });
      expect(mockManager.dispatchTurn).toHaveBeenCalledTimes(1);
      // 4-arg shape: the backend threads its deadline signal into the turn
      // (the primitive itself still calls dispatchTurn with two args).
      expect(mockManager.dispatchTurn).toHaveBeenCalledWith(
        "agent-fork-abc",
        "should I refactor?",
        undefined,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it("calls stopAgent(forkName) in finally on the happy path", async () => {
      await advisor.consult(DEFAULT_ARGS);
      expect(mockManager.stopAgent).toHaveBeenCalledTimes(1);
      expect(mockManager.stopAgent).toHaveBeenCalledWith("agent-fork-abc");
    });
  });

  // Assertion B — try/finally invariant (the parity-critical regression)
  describe("consult() — try/finally stopAgent invariant", () => {
    it("still calls stopAgent when dispatchTurn rejects, then re-throws", async () => {
      const boom = new Error("dispatchTurn boom");
      (mockManager.dispatchTurn as ReturnType<typeof vi.fn>).mockRejectedValue(
        boom,
      );

      await expect(advisor.consult(DEFAULT_ARGS)).rejects.toThrow(
        "dispatchTurn boom",
      );

      // The invariant: even after dispatchTurn throws, stopAgent fires.
      expect(mockManager.stopAgent).toHaveBeenCalledTimes(1);
      expect(mockManager.stopAgent).toHaveBeenCalledWith("agent-fork-abc");
    });

    it("swallows stopAgent errors after a successful dispatch (parity with daemon .catch(() => {}))", async () => {
      (mockManager.stopAgent as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("stopAgent failed"),
      );
      // Should NOT reject — the legacy code wraps stopAgent in `.catch(() => {})`
      const result = await advisor.consult(DEFAULT_ARGS);
      expect(result).toEqual({ answer: "advice text" });
      expect(mockManager.stopAgent).toHaveBeenCalledTimes(1);
    });
  });

  // Per-consult deadline (999.106 QW-4). A wedged consult used to hold a
  // full forked claude session for as long as the turn refused to settle.
  describe("consult() — per-consult deadline", () => {
    /** dispatchTurn that only settles when the threaded signal aborts. */
    function abortAwareDispatch() {
      return vi.fn(
        (
          _name: string,
          _message: string,
          _turn: unknown,
          options?: { readonly signal?: AbortSignal },
        ) =>
          new Promise<string>((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => {
              const err = new Error("Aborted: interrupt deadline exceeded");
              err.name = "AbortError";
              reject(err);
            });
          }),
      );
    }

    it("aborts the turn and stops the fork when the deadline passes", async () => {
      (mockManager as { dispatchTurn: unknown }).dispatchTurn = abortAwareDispatch();
      // Grace far beyond the test window: the backstop provably cannot fire,
      // so passing means the signal reached the turn.
      const bounded = new LegacyForkAdvisor(mockManager, 10, 60_000);

      const err = await bounded.consult(DEFAULT_ARGS).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(AdvisorTimeoutError);
      expect((err as AdvisorTimeoutError).code).toBe("advisor_timeout");
      // The abort rejects the turn, so the primitive's own finally stops the
      // fork — exactly once, no backstop needed.
      expect(mockManager.stopAgent).toHaveBeenCalledTimes(1);
      expect(mockManager.stopAgent).toHaveBeenCalledWith("agent-fork-abc");
    });

    it("honours a per-consult timeoutMs over the constructor default (2026-08-27 advisor.forkTimeoutMs)", async () => {
      (mockManager as { dispatchTurn: unknown }).dispatchTurn = abortAwareDispatch();
      // Constructor default is generous; the per-consult bound is tiny — the
      // tiny one must win, and the error must report it.
      const bounded = new LegacyForkAdvisor(mockManager, 60_000, 60_000);
      const err = await bounded.consult({ ...DEFAULT_ARGS, timeoutMs: 10 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AdvisorTimeoutError);
      expect((err as Error).message).toContain("exceeded 10ms");
      expect(mockManager.stopAgent).toHaveBeenCalledWith("agent-fork-abc");
    });

    it("stops the fork via the backstop when the turn ignores the abort", async () => {
      (mockManager as { dispatchTurn: unknown }).dispatchTurn = vi.fn(
        () => new Promise<string>(() => {}),
      );
      const bounded = new LegacyForkAdvisor(mockManager, 10, 20);

      await expect(bounded.consult(DEFAULT_ARGS)).rejects.toBeInstanceOf(
        AdvisorTimeoutError,
      );
      expect(mockManager.stopAgent).toHaveBeenCalledWith("agent-fork-abc");
    });

    it("stops a fork that only materialises after the backstop gave up", async () => {
      (mockManager as { forkSession: unknown }).forkSession = vi.fn(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  forkName: "agent-fork-late",
                  parentAgent: "agent",
                  sessionId: "sess-late",
                }),
              60,
            ),
          ),
      );
      const bounded = new LegacyForkAdvisor(mockManager, 10, 20);

      await expect(bounded.consult(DEFAULT_ARGS)).rejects.toBeInstanceOf(
        AdvisorTimeoutError,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockManager.stopAgent).toHaveBeenCalledWith("agent-fork-late");
    });

    it("leaves a consult that beats the deadline untouched", async () => {
      const bounded = new LegacyForkAdvisor(mockManager, 50_000);

      const result = await bounded.consult(DEFAULT_ARGS);

      expect(result).toEqual({ answer: "advice text" });
      const options = (mockManager.dispatchTurn as ReturnType<typeof vi.fn>).mock
        .calls[0]![3] as { readonly signal: AbortSignal };
      expect(options.signal.aborted).toBe(false);
      expect(mockManager.stopAgent).toHaveBeenCalledTimes(1);
    });
  });

  // Cross-check: the standalone function (without the class wrapper) has
  // the same behavior. LegacyForkAdvisor is a pure adapter — if these
  // diverge, the adapter has gained behavior it shouldn't.
  describe("forkAdvisorConsult() — direct function parity", () => {
    it("produces the same result the class wrapper would (no adapter logic)", async () => {
      const direct = await forkAdvisorConsult(mockManager, DEFAULT_ARGS);
      expect(direct).toEqual({ answer: "advice text" });
    });

    it("preserves the try/finally invariant at the function level", async () => {
      (mockManager.dispatchTurn as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("boom"),
      );
      await expect(
        forkAdvisorConsult(mockManager, DEFAULT_ARGS),
      ).rejects.toThrow("boom");
      expect(mockManager.stopAgent).toHaveBeenCalledTimes(1);
    });
  });
});
