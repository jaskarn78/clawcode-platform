/**
 * Phase 999.172 — prompt suggestions reach the spawned CLI on BOTH session
 * paths (a daemon restart resumes every session; a create-only spread would
 * silently switch the feature off on the first restart), and only when the
 * session config says so.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildCleanEnv } from "../session-adapter.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "session-adapter.ts");

function bodyOf(source: string, methodSig: string, nextSig: string): string {
  const start = source.lastIndexOf(methodSig);
  expect(start, `method not found: ${methodSig}`).toBeGreaterThan(-1);
  const end = source.indexOf(nextSig, start + methodSig.length);
  expect(end, `boundary not found after ${methodSig}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("999.172 — promptSuggestions create/resume symmetry", () => {
  const source = readFileSync(SRC, "utf-8");
  const OPTION_SPREAD = "...(config.uxFeatures?.promptSuggestions === true ? { promptSuggestions: true } : {})";
  const ENV_ARG = "config.uxFeatures?.promptSuggestions === true,";

  it("createSession carries the option AND the env flag", () => {
    const create = bodyOf(source, "async createSession(", "async resumeSession(");
    expect(create).toContain(OPTION_SPREAD);
    expect(create).toContain(ENV_ARG);
  });

  it("resumeSession carries the option AND the env flag — the restart guard", () => {
    const resume = bodyOf(source, "async resumeSession(", "function stripHandleOnlyFields(");
    expect(resume).toContain(OPTION_SPREAD);
    expect(resume).toContain(ENV_ARG);
  });

  it("stripHandleOnlyFields does NOT strip it (it must reach sdk.query)", () => {
    const strip = bodyOf(source, "function stripHandleOnlyFields(", "return rest;");
    expect(strip).not.toContain("promptSuggestions");
  });
});

describe("buildCleanEnv — promptSuggestions", () => {
  it("omits CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION by default", () => {
    expect(buildCleanEnv().CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION).toBeUndefined();
    expect(buildCleanEnv("true").CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION).toBeUndefined();
  });

  it("sets it to exactly \"true\" when on, alongside toolSearch", () => {
    const env = buildCleanEnv("true", true);
    expect(env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION).toBe("true");
    expect(env.ENABLE_TOOL_SEARCH).toBe("true");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
