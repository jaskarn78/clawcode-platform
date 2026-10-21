/**
 * 999.173 — research options create/resume symmetry pin (same source-structural
 * family as session-adapter-attributed-stream-symmetry.test.ts). A daemon
 * restart resumes every session; if only createSession carried the research
 * options, a restart would silently drop `perTaskStopAffordance` and every
 * interrupt would kill every researcher again.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "session-adapter.ts");

function bodyOf(source: string, methodSig: string, nextSig: string): string {
  const start = source.lastIndexOf(methodSig);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf(nextSig, start + methodSig.length);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("999.173 — research options create/resume symmetry", () => {
  const source = readFileSync(SRC, "utf-8");
  const SDK_SPREAD = "...buildResearchSdkOptions(config.researchSubagents)";
  const HANDLE_SPREAD = "{ researchSubagents: config.researchSubagents }";

  it("createSession carries the research SDK options + handle-only settings", () => {
    const create = bodyOf(source, "async createSession(", "async resumeSession(");
    expect(create).toContain(SDK_SPREAD);
    expect(create).toContain(HANDLE_SPREAD);
  });

  it("resumeSession carries them too (the restart guard)", () => {
    const resume = bodyOf(source, "async resumeSession(", "function stripHandleOnlyFields(");
    expect(resume).toContain(SDK_SPREAD);
    expect(resume).toContain(HANDLE_SPREAD);
  });

  it("stripHandleOnlyFields removes the handle-only settings before sdk.query", () => {
    const strip = bodyOf(source, "function stripHandleOnlyFields(", "export function transformMcpServersForSdk(");
    expect(strip).toContain("researchSubagents: _researchSubagents");
  });

  it("the launch gate rides the shared PreToolUse builder used by both paths", () => {
    const builder = bodyOf(source, "function buildPreToolUseHooksOption(", "function redactSecrets");
    expect(builder).toContain("makeResearchLaunchGateHook(config.name, config.researchSubagents.maxConcurrent, {");
    expect(builder).toContain("allowBash: config.researchSubagents.allowBash");
  });
});
