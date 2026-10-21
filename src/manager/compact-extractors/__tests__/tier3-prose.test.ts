import { describe, it, expect, beforeEach } from "vitest";
import pino from "pino";
import {
  summarizeAsProse,
  resetTier3SentinelTracking,
  TIER3_FALLBACK,
} from "../tier3-prose.js";
import type { Tier3ProseDeps } from "../tier3-prose.js";
import type { Tier3SummarizeFn } from "../types.js";

function makeLog(sink: { entries: unknown[] }): Tier3ProseDeps["log"] {
  return pino(
    { level: "info" },
    { write: (s) => sink.entries.push(JSON.parse(s)) },
  ) as unknown as Tier3ProseDeps["log"];
}

const SAMPLE_TEXT =
  "[user]: Client A asked about the AUM update for Acme.\n" +
  "[assistant]: I posted the updated AUM figure to the deck.\n" +
  "[user]: confirm the $45M tranche is queued.\n" +
  "[assistant]: tranche queued; lawyer copied.\n";

describe("summarizeAsProse", () => {
  beforeEach(() => {
    resetTier3SentinelTracking();
  });

  it("happy path: returns a prose chunk prefixed with [tier3] prose:", async () => {
    const sink = { entries: [] as unknown[] };
    const summarize: Tier3SummarizeFn = async () =>
      "Client A's AUM update was posted and the $45M tranche was queued. Lawyer was copied on the thread.";
    const out = await summarizeAsProse(SAMPLE_TEXT, {
      summarize,
      log: makeLog(sink),
      agentName: "test-agent-prose-1",
    });
    expect(out).not.toBeNull();
    expect(out).toMatch(/^\[tier3\] prose: /);
    expect(out).toContain("AUM");
    expect(out).toContain("$45M");
  });

  it("haiku timeout: returns the deterministic fallback string", async () => {
    const sink = { entries: [] as unknown[] };
    const summarize: Tier3SummarizeFn = (_p, opts) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve("late prose"), 200);
        opts.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new Error("aborted"));
        });
      });
    const out = await summarizeAsProse(SAMPLE_TEXT, {
      summarize,
      log: makeLog(sink),
      agentName: "test-agent-prose-timeout",
      timeoutMs: 20,
    });
    expect(out).toBe(TIER3_FALLBACK);
    const warns = sink.entries.filter(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        (e as { level?: number }).level === 40,
    );
    expect(warns.length).toBeGreaterThanOrEqual(1);
  });

  it("haiku throws: returns the fallback string + warn logged", async () => {
    const sink = { entries: [] as unknown[] };
    const summarize: Tier3SummarizeFn = async () => {
      throw new Error("simulated haiku failure");
    };
    const out = await summarizeAsProse(SAMPLE_TEXT, {
      summarize,
      log: makeLog(sink),
      agentName: "test-agent-prose-throw",
    });
    expect(out).toBe(TIER3_FALLBACK);
  });

  it("haiku empty response: returns the fallback string", async () => {
    const sink = { entries: [] as unknown[] };
    const summarize: Tier3SummarizeFn = async () => "";
    const out = await summarizeAsProse(SAMPLE_TEXT, {
      summarize,
      log: makeLog(sink),
      agentName: "test-agent-prose-empty",
    });
    expect(out).toBe(TIER3_FALLBACK);
  });

  it("sentinel logged exactly once per agent across 3 invocations", async () => {
    const sink = { entries: [] as unknown[] };
    const summarize: Tier3SummarizeFn = async () => "summary one. summary two.";
    const deps: Tier3ProseDeps = {
      summarize,
      log: makeLog(sink),
      agentName: "test-agent-prose-sentinel",
    };
    await summarizeAsProse(SAMPLE_TEXT, deps);
    await summarizeAsProse(SAMPLE_TEXT, deps);
    await summarizeAsProse(SAMPLE_TEXT, deps);

    const sentinelHits = sink.entries.filter(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        (e as { sentinel?: string; msg?: string }).sentinel ===
          "125-04-tier3-prose" &&
        typeof (e as { msg?: string }).msg === "string" &&
        ((e as { msg: string }).msg).includes(
          "tier3 prose summarizer active",
        ),
    );
    expect(sentinelHits.length).toBe(1);
  });

  it("calls deps.summarize exactly once per non-trivial invocation", async () => {
    const sink = { entries: [] as unknown[] };
    let callCount = 0;
    const summarize: Tier3SummarizeFn = async () => {
      callCount++;
      return "prose result.";
    };
    await summarizeAsProse(SAMPLE_TEXT, {
      summarize,
      log: makeLog(sink),
      agentName: "test-agent-prose-callcount",
    });
    expect(callCount).toBe(1);
  });

  it("empty / too-short input: no Haiku call, returns null", async () => {
    const sink = { entries: [] as unknown[] };
    let callCount = 0;
    const summarize: Tier3SummarizeFn = async () => {
      callCount++;
      return "x";
    };
    const deps: Tier3ProseDeps = {
      summarize,
      log: makeLog(sink),
      agentName: "test-agent-prose-empty-input",
    };
    expect(await summarizeAsProse("", deps)).toBeNull();
    expect(await summarizeAsProse("   ", deps)).toBeNull();
    expect(await summarizeAsProse("[user]: hi", deps)).toBeNull();
    expect(callCount).toBe(0);
  });
});
