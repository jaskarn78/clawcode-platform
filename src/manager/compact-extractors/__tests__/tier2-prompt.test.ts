import { describe, it, expect } from "vitest";
import {
  buildTier2ExtractionPrompt,
  MAX_PROMPT_CHARS,
} from "../tier2-prompt.js";

describe("buildTier2ExtractionPrompt", () => {
  it("mentions every required key in the schema block", () => {
    const prompt = buildTier2ExtractionPrompt("[user]: hello");
    for (const key of [
      "activeClients",
      "decisions",
      "standingRulesChanged",
      "inFlightTasks",
      "drivePathsTouched",
      "criticalNumbers",
    ]) {
      expect(prompt).toContain(key);
    }
  });

  it("includes an ONLY YAML guardrail (no prose, no JSON, no fences)", () => {
    const prompt = buildTier2ExtractionPrompt("[user]: hi");
    expect(prompt).toContain("ONLY a single YAML block");
    expect(prompt).toContain("Do NOT emit prose");
    expect(prompt).toContain("do NOT emit JSON");
    expect(prompt).toContain("do NOT wrap in markdown fences");
  });

  it("stays well under 8000 chars for small inputs (Haiku context budget)", () => {
    const prompt = buildTier2ExtractionPrompt("[user]: short turn");
    expect(prompt.length).toBeLessThan(8000);
  });

  it("truncates from the head when input exceeds MAX_PROMPT_CHARS", () => {
    const filler = "x".repeat(MAX_PROMPT_CHARS + 1_000);
    const prompt = buildTier2ExtractionPrompt(filler);
    expect(prompt).toContain("[...older turns truncated for prompt-size cap]");
    expect(prompt.length).toBeLessThan(MAX_PROMPT_CHARS + 4_000);
  });

  it("is deterministic given the same input", () => {
    const a = buildTier2ExtractionPrompt("[user]: deterministic");
    const b = buildTier2ExtractionPrompt("[user]: deterministic");
    expect(a).toBe(b);
  });
});
