import { describe, it, expect, beforeEach } from "vitest";
import pino from "pino";
import {
  extractStructuredFacts,
  resetTier2SentinelTracking,
  tier2FactsToChunks,
} from "../tier2-haiku.js";
import type { Tier2ExtractDeps } from "../tier2-haiku.js";
import type { Tier2SummarizeFn } from "../types.js";

function makeLog(sink: { entries: unknown[] }): Tier2ExtractDeps["log"] {
  return pino(
    { level: "info" },
    { write: (s) => sink.entries.push(JSON.parse(s)) },
  ) as unknown as Tier2ExtractDeps["log"];
}

const SAMPLE_TEXT =
  "[user]: tell client_a the AUM is $45M\n" +
  "[assistant]: I'll draft the email tonight.\n" +
  "[user]: clients/Acme/tranche.md is ready\n" +
  "[assistant]: noted.\n".repeat(5);

const VALID_YAML = `activeClients: [Acme]
decisions:
  - decision: "Move AUM threshold to $45M"
    context: "agreed with Client A"
standingRulesChanged: []
inFlightTasks:
  - task: "Draft email"
    state: "in progress"
drivePathsTouched: ["clients/Acme/"]
criticalNumbers:
  - context: "Acme AUM"
    value: "$45M"
`;

describe("extractStructuredFacts", () => {
  beforeEach(() => {
    resetTier2SentinelTracking();
  });

  it("happy path: valid YAML response → populated facts", async () => {
    const sink = { entries: [] as unknown[] };
    const summarize: Tier2SummarizeFn = async () => VALID_YAML;
    const facts = await extractStructuredFacts(SAMPLE_TEXT, {
      summarize,
      log: makeLog(sink),
      agentName: "test-agent-1",
    });
    expect(facts).not.toBeNull();
    expect(facts?.activeClients).toEqual(["Acme"]);
    expect(facts?.criticalNumbers[0]?.value).toBe("$45M");
  });

  it("haiku timeout: throws after timeout → returns null + warn logged", async () => {
    const sink = { entries: [] as unknown[] };
    const summarize: Tier2SummarizeFn = (_p, opts) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve(VALID_YAML), 200);
        opts.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new Error("aborted"));
        });
      });
    const facts = await extractStructuredFacts(SAMPLE_TEXT, {
      summarize,
      log: makeLog(sink),
      agentName: "test-agent-timeout",
      timeoutMs: 20,
    });
    expect(facts).toBeNull();
    const warns = sink.entries.filter(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        (e as { level?: number }).level === 40,
    );
    expect(warns.length).toBeGreaterThanOrEqual(1);
  });

  it("haiku malformed YAML → null + warn logged", async () => {
    const sink = { entries: [] as unknown[] };
    const summarize: Tier2SummarizeFn = async () =>
      "activeClients: [unterminated\ndecisions: not-an-array";
    const facts = await extractStructuredFacts(SAMPLE_TEXT, {
      summarize,
      log: makeLog(sink),
      agentName: "test-agent-malformed",
    });
    expect(facts).toBeNull();
  });

  it("haiku prose-only response (no YAML) → null", async () => {
    const sink = { entries: [] as unknown[] };
    const summarize: Tier2SummarizeFn = async () =>
      "Sorry, I couldn't extract anything meaningful.";
    const facts = await extractStructuredFacts(SAMPLE_TEXT, {
      summarize,
      log: makeLog(sink),
      agentName: "test-agent-prose",
    });
    expect(facts).toBeNull();
  });

  it("haiku empty response → null + warn logged", async () => {
    const sink = { entries: [] as unknown[] };
    const summarize: Tier2SummarizeFn = async () => "";
    const facts = await extractStructuredFacts(SAMPLE_TEXT, {
      summarize,
      log: makeLog(sink),
      agentName: "test-agent-empty",
    });
    expect(facts).toBeNull();
  });

  it("sentinel logged exactly once per agent across 3 invocations", async () => {
    const sink = { entries: [] as unknown[] };
    const summarize: Tier2SummarizeFn = async () => VALID_YAML;
    const deps: Tier2ExtractDeps = {
      summarize,
      log: makeLog(sink),
      agentName: "test-agent-sentinel",
    };
    await extractStructuredFacts(SAMPLE_TEXT, deps);
    await extractStructuredFacts(SAMPLE_TEXT, deps);
    await extractStructuredFacts(SAMPLE_TEXT, deps);

    const sentinelHits = sink.entries.filter(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        (e as { sentinel?: string; msg?: string }).sentinel ===
          "125-03-tier2-haiku" &&
        typeof (e as { msg?: string }).msg === "string" &&
        ((e as { msg: string }).msg).includes("tier2 haiku extractor active"),
    );
    expect(sentinelHits.length).toBe(1);
  });

  it("empty / too-short input → no Haiku call, no spend, null", async () => {
    const sink = { entries: [] as unknown[] };
    let callCount = 0;
    const summarize: Tier2SummarizeFn = async () => {
      callCount++;
      return VALID_YAML;
    };
    const deps: Tier2ExtractDeps = {
      summarize,
      log: makeLog(sink),
      agentName: "test-agent-cost",
    };
    expect(await extractStructuredFacts("", deps)).toBeNull();
    expect(await extractStructuredFacts("   ", deps)).toBeNull();
    expect(await extractStructuredFacts("[user]: hi", deps)).toBeNull();
    expect(callCount).toBe(0);
  });
});

describe("tier2FactsToChunks", () => {
  it("flattens facts into stable string chunks", () => {
    const chunks = tier2FactsToChunks({
      activeClients: Object.freeze(["Acme"]),
      decisions: Object.freeze([
        Object.freeze({ decision: "ship it", context: "client_a ok" }),
      ]),
      standingRulesChanged: Object.freeze([
        Object.freeze({ rule: "never deploy fri", changedAt: "2026-05-14" }),
      ]),
      inFlightTasks: Object.freeze([
        Object.freeze({ task: "draft memo", state: "blocked" }),
      ]),
      drivePathsTouched: Object.freeze(["clients/Acme/"]),
      criticalNumbers: Object.freeze([
        Object.freeze({ context: "AUM", value: "$45M" }),
      ]),
    });
    expect(chunks).toContain("[tier2] activeClient: Acme");
    expect(chunks).toContain("[tier2] decision: ship it (client_a ok)");
    expect(chunks).toContain(
      "[tier2] standingRule: never deploy fri @ 2026-05-14",
    );
    expect(chunks).toContain("[tier2] inFlightTask: draft memo — blocked");
    expect(chunks).toContain("[tier2] drivePath: clients/Acme/");
    expect(chunks).toContain("[tier2] criticalNumber: $45M (AUM)");
  });
});
