import { describe, it, expect, vi } from "vitest";
import pino from "pino";
import {
  synthesizeReport,
  coerceSynthesis,
  extractJsonObject,
  buildSynthesisPrompt,
  MAX_TOTAL_CHARS,
} from "../synthesize-report.js";
import type { ReportDoc } from "../../../reports/types.js";

const log = pino({ level: "silent" });

const doc = (steps: ReportDoc["steps"]): ReportDoc => ({
  workflowId: "wf_x",
  agentName: "fin-client",
  generatedAt: 0,
  steps,
});

const twoStepDoc = doc([
  { stepId: "revenue-quality", status: "done", result: "Margins fell 640bps." },
  { stepId: "synergy-model", status: "failed", error: "upstream 502" },
]);

describe("synthesizeReport — every failure publishes unedited", () => {
  it("returns null on an empty response (callModelDirect's failure contract)", async () => {
    // callModelDirect resolves "" rather than throwing, so a truthiness check
    // is the only thing standing between a bridge failure and a broken report.
    const out = await synthesizeReport(twoStepDoc, { logger: log, callModel: async () => "" });
    expect(out).toBeNull();
  });

  it("returns null when the model throws", async () => {
    const out = await synthesizeReport(twoStepDoc, {
      logger: log,
      callModel: async () => {
        throw new Error("bridge spawn failed");
      },
    });
    expect(out).toBeNull();
  });

  it("returns null on unparseable output", async () => {
    const out = await synthesizeReport(twoStepDoc, {
      logger: log,
      callModel: async () => "Sure! Here is my analysis of the workflow.",
    });
    expect(out).toBeNull();
  });

  it("parses a well-formed response", async () => {
    const payload = {
      title: "Meridian Systems",
      dek: "Four workstreams.",
      bluf: "Cheaper than it looks.",
      keyFindings: ["Margin down 640bps."],
      perStep: { "revenue-quality": "Margins fell." },
      risks: ["Synergy case unquantified."],
      nextSteps: ["Re-run the synergy step."],
    };
    const out = await synthesizeReport(twoStepDoc, {
      logger: log,
      callModel: async () => JSON.stringify(payload),
    });
    expect(out).toMatchObject(payload);
  });
});

describe("extractJsonObject — tolerates the shapes models actually emit", () => {
  it("reads a bare object", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });
  it("reads a fenced object", () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it("reads an object behind a line of commentary", () => {
    // Losing the whole edit to one stray preamble line is a bad trade.
    expect(extractJsonObject('Here you go:\n{"a":1}')).toEqual({ a: 1 });
  });
  it("returns null for genuine prose", () => {
    expect(extractJsonObject("I could not complete this analysis.")).toBeNull();
  });
});

describe("coerceSynthesis — validation is field-by-field, not all-or-nothing", () => {
  const ids = ["a", "b"];

  it("keeps the good fields and drops the malformed ones", () => {
    const out = coerceSynthesis(
      { bluf: "Solid.", keyFindings: "not an array", perStep: 42 },
      ids,
    );
    expect(out).toEqual({ bluf: "Solid." });
  });

  it("drops a hallucinated stepId so no section appears for a step that never ran", () => {
    const out = coerceSynthesis({ perStep: { a: "real", ghost: "invented" } }, ids);
    expect(out?.perStep).toEqual({ a: "real" });
  });

  it("returns null when NOTHING survives, rather than an empty object", () => {
    // An empty object reads downstream as "synthesis succeeded".
    expect(coerceSynthesis({ nope: 1 }, ids)).toBeNull();
    expect(coerceSynthesis({ keyFindings: [] }, ids)).toBeNull();
    expect(coerceSynthesis(null, ids)).toBeNull();
    expect(coerceSynthesis("a string", ids)).toBeNull();
  });

  it("clamps oversized fields instead of rejecting them", () => {
    const out = coerceSynthesis({ title: "x".repeat(500) }, ids);
    expect(out?.title?.length).toBe(120);
  });

  it("drops empty and non-string list items", () => {
    const out = coerceSynthesis({ keyFindings: ["real", "", null, 7, "  "] }, ids);
    expect(out?.keyFindings).toEqual(["real"]);
  });
});

describe("buildSynthesisPrompt", () => {
  it("caps total input so a wide workflow cannot blow the window", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      stepId: `s${i}`,
      status: "done",
      result: "x".repeat(50_000),
    }));
    const prompt = buildSynthesisPrompt(doc(many));
    expect(prompt.length).toBeLessThan(MAX_TOTAL_CHARS * 1.6);
    expect(prompt).toContain("truncated for the editing pass");
  });

  it("names the exact stepIds the model must key perStep on", () => {
    const prompt = buildSynthesisPrompt(twoStepDoc);
    expect(prompt).toContain("revenue-quality, synergy-model");
  });

  it("presents a failed step as a finding, not as missing input", () => {
    expect(buildSynthesisPrompt(twoStepDoc)).toContain("upstream 502");
  });

  it("does not truncate a short step", () => {
    expect(buildSynthesisPrompt(twoStepDoc)).not.toContain("truncated for the editing pass");
  });
});
