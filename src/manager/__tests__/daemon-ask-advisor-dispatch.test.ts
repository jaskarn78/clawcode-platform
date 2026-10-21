/**
 * Plan 117-07 T04 — `handleAskAdvisor` dispatch tests.
 *
 * Covers the IPC handler body extracted from the `case "ask-advisor":`
 * switch arm in `src/manager/daemon.ts` (Plan 117-07 T02). The handler
 * has TWO branches:
 *   1. native backend → short-circuit response (RESEARCH §13.11), no
 *      call into `AdvisorService.ask`.
 *   2. fork backend   → dispatch via `AdvisorService.ask({agent,
 *      question})`; return `{answer, budget_remaining, backend}`.
 *
 * Coverage (Plan 117-07 §Tasks T04 assertions A–D):
 *   - **A (fork dispatch):** Agent with `advisor.backend: "fork"` →
 *     `advisorService.ask` invoked exactly once with `{agent, question}`;
 *     return shape `{answer, budget_remaining, backend: "fork"}`.
 *   - **B (native short-circuit):** Agent with `advisor.backend: "native"`
 *     → `advisorService.ask` NOT called; return `answer` contains
 *     "runs in-session" (case-insensitive); `budget_remaining` reads
 *     from `advisorBudget.getRemaining(agent)`; `backend: "native"`.
 *   - **C (default native):** Agent with NO advisor config → resolves
 *     to "native" via `resolveAdvisorBackend` fall-through to defaults;
 *     same short-circuit as B.
 *   - **D (response shape preservation):** All three keys (`answer`,
 *     `budget_remaining`, `backend`) present + exactly named.
 *
 * The extracted handler is exported from `daemon.ts` as
 * `handleAskAdvisor` so this suite can drive it directly without
 * standing up the full daemon. Mocks: `AdvisorService.ask` (`vi.fn`),
 * `AdvisorBudget.getRemaining` (`vi.fn`), `manager.getAgentConfig`
 * (`vi.fn` returning the agent-config slice).
 */

import { describe, it, expect, vi } from "vitest";
import { handleAskAdvisor } from "../daemon.js";
import type { AdvisorService } from "../../advisor/types.js";
import type { AdvisorBudget } from "../../usage/advisor-budget.js";
import type { SessionManager } from "../session-manager.js";

/**
 * Build a fake `SessionManager` exposing only `getAgentConfig` — the
 * only `SessionManager` method `handleAskAdvisor` touches.
 */
function makeFakeManager(
  cfg: { advisor?: { backend?: string } } | undefined,
): SessionManager {
  return {
    getAgentConfig: vi.fn(() => cfg),
  } as unknown as SessionManager;
}

/**
 * Build a fake `AdvisorBudget` exposing only `getRemaining`.
 */
function makeFakeBudget(remaining: number): AdvisorBudget {
  return {
    getRemaining: vi.fn(() => remaining),
  } as unknown as AdvisorBudget;
}

/**
 * Build a stub `AdvisorService` whose `ask` returns the supplied shape.
 */
function makeStubService(
  result: { answer: string; budgetRemaining: number; backend: "native" | "fork" },
): AdvisorService {
  return {
    ask: vi.fn(async () => result),
  };
}

describe("handleAskAdvisor — dispatch (Plan 117-07 T04)", () => {
  it(
    "A (fork dispatch): agent with advisor.backend='fork' → AdvisorService.ask invoked once; response shape preserved",
    async () => {
      const manager = makeFakeManager({ advisor: { backend: "fork" } });
      const advisorBudget = makeFakeBudget(9);
      const advisorService = makeStubService({
        answer: "Refactor before adding features.",
        budgetRemaining: 8,
        backend: "fork",
      });

      const out = await handleAskAdvisor(
        {
          manager,
          advisorService,
          advisorBudget,
          advisorDefaults: { advisor: { backend: "native" } },
        },
        { agent: "atlas", question: "Should I refactor first?" },
      );

      // AdvisorService.ask called exactly once with the right args.
      expect(advisorService.ask).toHaveBeenCalledTimes(1);
      expect(advisorService.ask).toHaveBeenCalledWith({
        agent: "atlas",
        question: "Should I refactor first?",
      });
      // Budget's getRemaining NOT used for fork path — service owns budget.
      expect(advisorBudget.getRemaining).not.toHaveBeenCalled();
      // Response shape: 3 fields, correctly named, correctly populated.
      expect(out).toStrictEqual({
        answer: "Refactor before adding features.",
        budget_remaining: 8,
        backend: "fork",
      });
    },
  );

  it(
    "B (native short-circuit): agent with advisor.backend='native' → AdvisorService.ask NOT called; short-circuit response with budget_remaining from AdvisorBudget",
    async () => {
      const manager = makeFakeManager({ advisor: { backend: "native" } });
      const advisorBudget = makeFakeBudget(7);
      const advisorService = makeStubService({
        // Should NEVER be returned — proves we short-circuited.
        answer: "SHOULD-NOT-REACH",
        budgetRemaining: -999,
        backend: "fork",
      });

      const out = await handleAskAdvisor(
        {
          manager,
          advisorService,
          advisorBudget,
          // Defaults irrelevant when per-agent says native.
          advisorDefaults: { advisor: { backend: "fork" } },
        },
        { agent: "atlas", question: "What now?" },
      );

      // AdvisorService.ask MUST NOT be called for native short-circuit.
      expect(advisorService.ask).not.toHaveBeenCalled();
      // Budget.getRemaining IS called for the native budget_remaining field.
      expect(advisorBudget.getRemaining).toHaveBeenCalledTimes(1);
      expect(advisorBudget.getRemaining).toHaveBeenCalledWith("atlas");
      // Response shape: short-circuit explanatory answer.
      expect(out.answer).toMatch(/runs in-session/i);
      expect(out.budget_remaining).toBe(7);
      expect(out.backend).toBe("native");
    },
  );

  it(
    "C (default native): agent with no advisor config → resolves to 'native' via defaults fall-through; short-circuits identically to B",
    async () => {
      // Agent config exists but has no `advisor` field at all.
      const manager = makeFakeManager({});
      const advisorBudget = makeFakeBudget(10);
      const advisorService = makeStubService({
        answer: "SHOULD-NOT-REACH",
        budgetRemaining: -999,
        backend: "fork",
      });

      const out = await handleAskAdvisor(
        {
          manager,
          advisorService,
          advisorBudget,
          // Defaults also empty — resolver falls through to hardcoded
          // "native" baseline at `resolveAdvisorBackend` in loader.ts.
          advisorDefaults: undefined,
        },
        { agent: "atlas", question: "..." },
      );

      expect(advisorService.ask).not.toHaveBeenCalled();
      expect(out.answer).toMatch(/runs in-session/i);
      expect(out.budget_remaining).toBe(10);
      expect(out.backend).toBe("native");
    },
  );

  it(
    "C2 (defaults selects native): per-agent omitted, defaults.advisor.backend='native' → same short-circuit",
    async () => {
      const manager = makeFakeManager({});
      const advisorBudget = makeFakeBudget(3);
      const advisorService = makeStubService({
        answer: "SHOULD-NOT-REACH",
        budgetRemaining: -999,
        backend: "fork",
      });

      const out = await handleAskAdvisor(
        {
          manager,
          advisorService,
          advisorBudget,
          advisorDefaults: { advisor: { backend: "native" } },
        },
        { agent: "beta", question: "?" },
      );

      expect(advisorService.ask).not.toHaveBeenCalled();
      expect(out.backend).toBe("native");
      expect(out.budget_remaining).toBe(3);
    },
  );

  it(
    "C3 (defaults selects fork): per-agent omitted, defaults.advisor.backend='fork' → dispatch via AdvisorService.ask",
    async () => {
      const manager = makeFakeManager({});
      const advisorBudget = makeFakeBudget(5);
      const advisorService = makeStubService({
        answer: "Default fork answer.",
        budgetRemaining: 4,
        backend: "fork",
      });

      const out = await handleAskAdvisor(
        {
          manager,
          advisorService,
          advisorBudget,
          advisorDefaults: { advisor: { backend: "fork" } },
        },
        { agent: "gamma", question: "Q?" },
      );

      // Defaults flipping to fork → service IS called.
      expect(advisorService.ask).toHaveBeenCalledTimes(1);
      expect(out).toStrictEqual({
        answer: "Default fork answer.",
        budget_remaining: 4,
        backend: "fork",
      });
    },
  );

  it(
    "D (response shape preservation): native + fork branches both return the exact 3-key shape {answer, budget_remaining, backend}",
    async () => {
      // Native branch.
      const nativeOut = await handleAskAdvisor(
        {
          manager: makeFakeManager({ advisor: { backend: "native" } }),
          advisorService: makeStubService({
            answer: "x",
            budgetRemaining: 0,
            backend: "fork",
          }),
          advisorBudget: makeFakeBudget(7),
          advisorDefaults: undefined,
        },
        { agent: "a", question: "q" },
      );
      expect(Object.keys(nativeOut).sort()).toStrictEqual([
        "answer",
        "backend",
        "budget_remaining",
      ]);

      // Fork branch.
      const forkOut = await handleAskAdvisor(
        {
          manager: makeFakeManager({ advisor: { backend: "fork" } }),
          advisorService: makeStubService({
            answer: "hi",
            budgetRemaining: 3,
            backend: "fork",
          }),
          advisorBudget: makeFakeBudget(7),
          advisorDefaults: undefined,
        },
        { agent: "a", question: "q" },
      );
      expect(Object.keys(forkOut).sort()).toStrictEqual([
        "answer",
        "backend",
        "budget_remaining",
      ]);
    },
  );

  it(
    "E (per-agent overrides defaults): per-agent.advisor.backend='fork' AND defaults.advisor.backend='native' → per-agent wins → dispatch",
    async () => {
      const manager = makeFakeManager({ advisor: { backend: "fork" } });
      const advisorBudget = makeFakeBudget(8);
      const advisorService = makeStubService({
        answer: "per-agent override wins",
        budgetRemaining: 7,
        backend: "fork",
      });

      const out = await handleAskAdvisor(
        {
          manager,
          advisorService,
          advisorBudget,
          advisorDefaults: { advisor: { backend: "native" } },
        },
        { agent: "atlas", question: "?" },
      );

      expect(advisorService.ask).toHaveBeenCalledTimes(1);
      expect(out.backend).toBe("fork");
      expect(out.answer).toBe("per-agent override wins");
    },
  );

  // ── 2026-08-02 — fork-caller quarantine ────────────────────────────────
  // Forks are the advisor MECHANISM; a fork consulting its own advisor
  // forked the fork and crashed on the LlmRuntime resolver gap ("No
  // LlmRuntime resolver registered", 3× the week of 07-27). The handler
  // refuses fork-kind callers regardless of config cascade.

  it("E (fork-caller quarantine): a -fork- session gets a refusal; AdvisorService.ask never called, no budget charged", async () => {
    const manager = makeFakeManager({ advisor: { backend: "fork" } });
    const advisorBudget = makeFakeBudget(10);
    const advisorService = makeStubService({
      answer: "SHOULD-NOT-REACH",
      budgetRemaining: -999,
      backend: "fork",
    });

    const out = await handleAskAdvisor(
      { manager, advisorService, advisorBudget, advisorDefaults: undefined },
      {
        agent: "state-contract-fork-Ji7iEh",
        question: "Should I restructure the doc?",
      },
    );

    expect(advisorService.ask).not.toHaveBeenCalled();
    expect(out.answer).toContain("unavailable inside forked sessions");
    expect(out.budget_remaining).toBe(10);
    expect(out.backend).toBe("fork");
  });

  it("E2: optimizer fork names (`-fork-<id>-opt`) are quarantined too", async () => {
    const manager = makeFakeManager(undefined);
    const advisorBudget = makeFakeBudget(4);
    const advisorService = makeStubService({
      answer: "SHOULD-NOT-REACH",
      budgetRemaining: -999,
      backend: "fork",
    });

    const out = await handleAskAdvisor(
      {
        manager,
        advisorService,
        advisorBudget,
        advisorDefaults: { advisor: { backend: "fork" } },
      },
      { agent: "fin-client-fork-a1b2c3-opt", question: "q" },
    );

    expect(advisorService.ask).not.toHaveBeenCalled();
    expect(out.answer).toContain("unavailable inside forked sessions");
  });

  it("E3: subagent-thread sessions (`-sub-`) are NOT forks — advisor access unchanged", async () => {
    const manager = makeFakeManager({ advisor: { backend: "fork" } });
    const advisorBudget = makeFakeBudget(6);
    const advisorService = makeStubService({
      answer: "consult ok",
      budgetRemaining: 5,
      backend: "fork",
    });

    const out = await handleAskAdvisor(
      { manager, advisorService, advisorBudget, advisorDefaults: undefined },
      { agent: "fin-client-sub-4XZKL0", question: "q" },
    );

    expect(advisorService.ask).toHaveBeenCalledTimes(1);
    expect(out.answer).toBe("consult ok");
  });
});
