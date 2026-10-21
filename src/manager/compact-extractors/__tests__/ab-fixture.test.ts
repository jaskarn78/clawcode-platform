/**
 * Phase 125 Plan 04 SC-5 — A/B fuzzy fixture (20-prompt corpus, >=90%).
 *
 * Acknowledged limitation: this is a STRUCTURAL test (does the post-
 * compaction context contain the expected keywords?), not a BEHAVIORAL
 * test (does the live agent generate the same response?). End-to-end
 * agent-level A/B requires a deployed live agent and is deferred to the
 * post-deploy verification window (see 125-04-PLAN.md T-02.4). The
 * structural test is the local-verifiable proxy and is gate-passable.
 *
 * The test:
 *   1. Builds a synthetic "pre-compaction" turn corpus = the 6h replay
 *      fixture + injected operator+assistant turns covering the SC-5
 *      categories (client-name = Acme; task-state = lawyer/closing
 *      date, $45M close note; feedback-rule = "never deploy fri",
 *      "chart axis" rules).
 *   2. Runs the corpus through partitionForVerbatim + buildTieredExtractor
 *      with canned Tier 2 (YAML facts) and Tier 3 (prose summary) outputs
 *      so the test is deterministic + offline (no Haiku, no network).
 *   3. For each of 20 prompts loaded from ab-pre.json / ab-post.json,
 *      checks whether all expected_keywords are present in BOTH the pre
 *      view (raw concatenated source text) AND the post view (the
 *      post-compaction chunk list).
 *   4. Asserts aggregate agreement >= 18/20 (>= 90%) and prints a
 *      per-category breakdown to stdout for operator visibility.
 */

import { describe, it, expect } from "vitest";
import pino from "pino";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConversationTurn } from "../../../memory/compaction.js";
import { buildTieredExtractor, partitionForVerbatim } from "../index.js";
import { resetTier1SentinelTracking } from "../tier1-verbatim.js";
import { resetTier4SentinelTracking } from "../tier4-drop.js";
import { resetTier2SentinelTracking } from "../tier2-haiku.js";
import { resetTier3SentinelTracking } from "../tier3-prose.js";
import type { ExtractorDeps } from "../types.js";
import { buildSyntheticReplay } from "./fixtures/build-fixture.js";

type AbPrompt = Readonly<{
  id: string;
  category: "client-name" | "task-state" | "feedback-rule";
  prompt: string;
  expected_keywords: readonly string[];
}>;

type AbFixture = Readonly<{ prompts: readonly AbPrompt[] }>;

const __dirname = fileURLToPath(new URL(".", import.meta.url));

function loadFixture(name: string): AbFixture {
  const raw = readFileSync(join(__dirname, "fixtures", name), "utf8");
  return JSON.parse(raw) as AbFixture;
}

function makeLog(): ExtractorDeps["log"] {
  return pino({ level: "silent" }) as unknown as ExtractorDeps["log"];
}

function turnsToText(turns: readonly ConversationTurn[]): string {
  return turns.map((t) => `[${t.role}]: ${t.content}`).join("\n");
}

function keywordsPresent(text: string, keywords: readonly string[]): boolean {
  const haystack = text.toLowerCase();
  for (const k of keywords) {
    if (!haystack.includes(k.toLowerCase())) return false;
  }
  return true;
}

/**
 * Inject SC-5-relevant turns into the synthetic replay so the pre-corpus
 * actually contains the keywords each prompt is testing. Without this the
 * test would be unfalsifiable — pre and post would both fail every prompt.
 */
function buildPreCorpus(): readonly ConversationTurn[] {
  const base = buildSyntheticReplay();
  const ts = "2026-05-14T10:00:00Z";
  const injected: ConversationTurn[] = [
    Object.freeze({
      timestamp: ts,
      role: "user",
      content: "Client A: clients/Acme/ term-sheet needs updating",
    }),
    Object.freeze({
      timestamp: ts,
      role: "assistant",
      content: "Updating clients/Acme/ term-sheet now.",
    }),
    Object.freeze({
      timestamp: ts,
      role: "user",
      content: "Draft the $45M close note for the tranche.",
    }),
    Object.freeze({
      timestamp: ts,
      role: "assistant",
      content: "Drafted the $45M close note; tranche queued.",
    }),
    Object.freeze({
      timestamp: ts,
      role: "user",
      content: "Lawyer responded — they need the revised closing date.",
    }),
    Object.freeze({
      timestamp: ts,
      role: "user",
      content: "Standing rule: never deploy fri — Client A 2026-05-14.",
    }),
    Object.freeze({
      timestamp: ts,
      role: "user",
      content: "New chart rule: axis labels must include units.",
    }),
    Object.freeze({
      timestamp: ts,
      role: "user",
      content: "Another chart rule: axis ticks every 5 units.",
    }),
  ];
  return Object.freeze([...injected, ...base, ...injected]);
}

/**
 * Build the canned Tier 2 YAML output that Haiku would have produced for
 * the injected SC-5 corpus. This is what the production pipeline would
 * extract; we hand it in directly to keep the test offline.
 */
const CANNED_TIER2_YAML = `activeClients: [Acme]
decisions:
  - decision: "Move tranche to $45M close"
    context: "agreed with Client A"
standingRulesChanged:
  - rule: "never deploy fri"
    changedAt: "2026-05-14"
  - rule: "chart axis labels must include units"
    changedAt: "2026-05-14"
  - rule: "chart axis ticks every 5 units"
    changedAt: "2026-05-14"
inFlightTasks:
  - task: "term-sheet update"
    state: "in progress"
  - task: "close note for Acme tranche"
    state: "drafted, awaiting Client A"
  - task: "respond to lawyer with revised closing date"
    state: "blocked on Client A"
drivePathsTouched: ["clients/Acme/"]
criticalNumbers:
  - context: "Acme tranche close"
    value: "$45M"
`;

const CANNED_TIER3_PROSE =
  "Updated the clients/Acme/ term-sheet and drafted the $45M close note for the tranche. " +
  "Lawyer asked for the revised closing date; Client A added a standing rule to never deploy fri and new chart axis rules.";

describe("SC-5 A/B fuzzy fixture (20-prompt corpus)", () => {
  it("post-compaction keyword survival >= 90% (18/20)", async () => {
    resetTier1SentinelTracking();
    resetTier4SentinelTracking();
    resetTier2SentinelTracking();
    resetTier3SentinelTracking();

    const pre = loadFixture("ab-pre.json");
    const post = loadFixture("ab-post.json");
    expect(pre.prompts.length).toBe(20);
    expect(post.prompts.length).toBe(20);

    // Cross-check fixture shape: pre/post prompt IDs must match.
    for (let i = 0; i < pre.prompts.length; i++) {
      expect(pre.prompts[i].id).toBe(post.prompts[i].id);
    }

    const corpus = buildPreCorpus();
    const preText = turnsToText(corpus);

    const deps: ExtractorDeps = {
      preserveLastTurns: 10,
      preserveVerbatimPatterns: [/\bAUM\b/, /\$[0-9]/, /\bClientA\b/],
      clock: () => new Date(0),
      log: makeLog(),
      agentName: "ab-fixture-agent",
    };

    const { preserved, toCompact } = partitionForVerbatim(corpus, deps);
    const toCompactText = turnsToText(toCompact);

    const extract = buildTieredExtractor({
      preserveLastTurns: deps.preserveLastTurns,
      preserveVerbatimPatterns: deps.preserveVerbatimPatterns,
      preservedTurns: preserved,
      clock: deps.clock,
      log: deps.log,
      agentName: deps.agentName,
      tier2Summarize: async () => CANNED_TIER2_YAML,
      tier3Summarize: async () => CANNED_TIER3_PROSE,
    });
    const postChunks = await extract(toCompactText);

    const postText = [
      ...preserved.map((t) => `[${t.role}]: ${t.content}`),
      ...postChunks,
    ].join("\n");

    type Result = Readonly<{
      id: string;
      category: AbPrompt["category"];
      pre: boolean;
      post: boolean;
      agree: boolean;
    }>;
    const results: Result[] = pre.prompts.map((p) => {
      const inPre = keywordsPresent(preText, p.expected_keywords);
      const inPost = keywordsPresent(postText, p.expected_keywords);
      return Object.freeze({
        id: p.id,
        category: p.category,
        pre: inPre,
        post: inPost,
        agree: inPre && inPost,
      });
    });

    const agreeCount = results.filter((r) => r.agree).length;
    const byCat: Record<AbPrompt["category"], { agree: number; total: number }> =
      {
        "client-name": { agree: 0, total: 0 },
        "task-state": { agree: 0, total: 0 },
        "feedback-rule": { agree: 0, total: 0 },
      };
    for (const r of results) {
      byCat[r.category].total++;
      if (r.agree) byCat[r.category].agree++;
    }

    // Operator-visible breakdown.
    console.log("[125-04 A/B] aggregate agreement:", agreeCount, "/ 20");
    for (const cat of Object.keys(byCat) as AbPrompt["category"][]) {
      console.log(
        `[125-04 A/B] ${cat}: ${byCat[cat].agree} / ${byCat[cat].total}`,
      );
    }
    const failed = results.filter((r) => !r.agree);
    if (failed.length > 0) {
      console.log(
        "[125-04 A/B] failed prompts:",
        failed.map((r) => `${r.id}(pre=${r.pre},post=${r.post})`).join(", "),
      );
    }

    expect(agreeCount).toBeGreaterThanOrEqual(18);
  });
});
