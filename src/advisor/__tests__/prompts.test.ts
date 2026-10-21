import { describe, it, expect } from "vitest";
import { buildAdvisorSystemPrompt } from "../prompts.js";

/**
 * Parity baseline frozen from `src/manager/daemon.ts:9836–9841` BEFORE
 * the Plan 117-03 extraction. Any change to `buildAdvisorSystemPrompt`
 * MUST update both sides of this comparison or the extraction in
 * Plan 117-03 will silently drift the agent-facing prompt.
 *
 * Original construction:
 *   const systemPrompt = [
 *     `You are an advisor to agent "${agentName}". Provide concise, actionable guidance.`,
 *     ...(memoryContext
 *       ? ["\nRelevant context from agent's memory:", memoryContext]
 *       : []),
 *   ].join("\n");
 */
function frozenExpected(agent: string, memoryContext?: string | null): string {
  return [
    `You are an advisor to agent "${agent}". Provide concise, actionable guidance.`,
    ...(memoryContext
      ? ["\nRelevant context from agent's memory:", memoryContext]
      : []),
  ].join("\n");
}

describe("buildAdvisorSystemPrompt", () => {
  it("returns a non-empty string containing the agent name and expected phrasing (no memory)", () => {
    const out = buildAdvisorSystemPrompt("test-agent", null);
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("test-agent");
    expect(out).toContain("Provide concise, actionable guidance");
  });

  it("matches the daemon.ts:9836 baseline for null memoryContext", () => {
    expect(buildAdvisorSystemPrompt("test-agent", null)).toBe(
      frozenExpected("test-agent", null),
    );
  });

  it("matches the daemon.ts:9836 baseline for undefined memoryContext", () => {
    expect(buildAdvisorSystemPrompt("test-agent", undefined)).toBe(
      frozenExpected("test-agent", undefined),
    );
  });

  it("omits the memory section for an empty memoryContext string (matches existing short-circuit)", () => {
    const out = buildAdvisorSystemPrompt("test-agent", "");
    expect(out).toBe(frozenExpected("test-agent", ""));
    expect(out).not.toContain("Relevant context from agent's memory:");
  });

  it("includes the memory section when memoryContext is non-empty", () => {
    const memory = "[1] remembered fact about postgres";
    const out = buildAdvisorSystemPrompt("clawdy", memory);
    expect(out).toBe(frozenExpected("clawdy", memory));
    expect(out).toContain("Relevant context from agent's memory:");
    expect(out).toContain(memory);
  });

  it("interpolates the agent name into the opening line exactly", () => {
    const out = buildAdvisorSystemPrompt("agent-with-dashes-123", null);
    expect(out.startsWith(`You are an advisor to agent "agent-with-dashes-123".`)).toBe(true);
  });
});
