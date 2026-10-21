/**
 * Plan 117-04 T07 — `AnthropicSdkAdvisor` backend tests.
 *
 * ─────────────────────────────────────────────────────────────────
 * T01 SPIKE FINDING (recorded 2026-05-13, see anthropic-sdk.ts header
 * for the full method + grep evidence)
 * ─────────────────────────────────────────────────────────────────
 *
 * QUESTION: Does the Claude Agent SDK 0.2.132 Options expose a per-
 * request `max_uses` cap for the advisor tool alongside
 * `advisorModel?: string`?
 *
 * RESULT: **Outcome B locked.** The SDK exposes ONLY `advisorModel?:
 * string` at `sdk.d.ts:4930`. Zero matches for `max_uses` / `MaxUses`
 * anywhere in the SDK declarations. The bundled `claude` CLI handles
 * tool-definition fields opaquely.
 *
 * MITIGATION CHOSEN: rely on `AdvisorBudget` per-agent-per-day cap.
 * When the budget is exhausted, the spread-conditional pattern in
 * `session-config.ts:shouldEnableAdvisor` OMITS `advisorModel` from
 * the SDK Options entirely on the next session reload. Soft-cap risk
 * accepted per RESEARCH §13.5 fallback / §7 Q4: inside a single
 * in-flight turn that started before exhaustion, the SDK may invoke
 * the advisor up to the server-side default `max_uses` cap (3) — so
 * the daily count can be exceeded by ≤3 calls per turn beyond the
 * 10/day target.
 *
 * Downstream consumers: T05 spread-conditional pattern documents this
 * acceptance in its doc-comment + RESEARCH §6 Pitfall 3.
 *
 * ─────────────────────────────────────────────────────────────────
 *
 * Coverage (per Plan 117-04 §Tasks T07 + RESEARCH §5 Plan 117-04):
 *   A. `consult()` REJECTS with documented error (Option A guard,
 *      RESEARCH §13.11). The error message MUST mention
 *      `Options.advisorModel` so future operators reading a stack
 *      trace land on the right escape hatch.
 *   B. `id === "native"` — the backend self-identifies for registry
 *      lookup (parallels `LegacyForkAdvisor.id === "fork"` /
 *      `PortableForkAdvisor.id === "portable-fork"` tests).
 *   C. `BackendRegistry.get("native")` returns the registered
 *      AnthropicSdkAdvisor instance after `register(advisor)`.
 *      Confirms registry composition still works uniformly across
 *      the three concrete backends.
 *
 * NOTE: tests for the per-block observer + iteration-parser live in
 * `src/manager/__tests__/session-adapter-advisor-observer.test.ts`
 * (T08) where the mocked `SdkStreamMessage` fixture exercises both
 * paths against the real session-adapter code.
 */

import { describe, it, expect } from "vitest";
import { AnthropicSdkAdvisor } from "../anthropic-sdk.js";
import { BackendRegistry } from "../../registry.js";

describe("AnthropicSdkAdvisor", () => {
  it("consult() throws documented error referencing Options.advisorModel", async () => {
    const advisor = new AnthropicSdkAdvisor();
    await expect(
      advisor.consult({
        agent: "test-agent",
        question: "Should I refactor first?",
        systemPrompt: "...",
        advisorModel: "claude-opus-4-8",
      }),
    ).rejects.toThrow(/not callable.*Options\.advisorModel/i);
  });

  it("consult() error message hints at agent.advisor.backend: fork escape", async () => {
    const advisor = new AnthropicSdkAdvisor();
    await expect(
      advisor.consult({
        agent: "x",
        question: "q",
        systemPrompt: "sp",
        advisorModel: "claude-opus-4-8",
      }),
    ).rejects.toThrow(/agent\.advisor\.backend:\s*fork/i);
  });

  it("id === 'native'", () => {
    expect(new AnthropicSdkAdvisor().id).toBe("native");
  });

  it("registry.get('native') returns the registered instance", () => {
    const registry = new BackendRegistry();
    const advisor = new AnthropicSdkAdvisor();
    registry.register(advisor);
    expect(registry.has("native")).toBe(true);
    expect(registry.get("native")).toBe(advisor);
  });

  it("registry.get('native') throws when no native backend registered", () => {
    const registry = new BackendRegistry();
    expect(() => registry.get("native")).toThrow(/not registered/);
  });
});
