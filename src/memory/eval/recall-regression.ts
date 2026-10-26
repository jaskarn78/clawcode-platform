/**
 * Memory overhaul WP2 (2026-10-25): deterministic recall regression.
 *
 * Planted-fact scenarios for the pre-turn retrieval path, one per defect
 * the WP2 audit verified:
 *   1. envelope-query     a question wrapped in the Discord `<channel ...>`
 *                         envelope still finds a fact the user stated days
 *                         ago in a daily log (the old FTS query held only
 *                         envelope tokens);
 *   2. old-dated-note     a dated note older than the 14-day window is still
 *                         returned when it is the only relevant one (the old
 *                         hard window dropped it);
 *   3. vault-vs-dated     loosely related vault rules do not outrank a more
 *                         relevant dated note (the old additive +0.2 put any
 *                         vault chunk first);
 *   4. flush-flood        500 rows tagged mid-session that match the query
 *                         better than the saved memory do not push it out
 *                         (the old tag filter ran after a top-20 fetch);
 *   5. long-section       a fact in the last paragraph of a 3,000-word H2
 *                         section is retrievable (the old chunker kept ~600
 *                         words per chunk and the embedder sees 200).
 *
 * Pure data and scoring: the caller (src/memory/__tests__/
 * recall-regression-wp2.test.ts) builds a store per scenario, indexes the
 * files with the real MemoryScanner, runs retrieveMemoryChunks with the
 * production arguments and scores the result here. The embedder is the
 * hashed bag-of-words stand-in (hash-embedder.ts) wrapped in the same
 * 200-word truncation MiniLM applies, so the run is deterministic and needs
 * no model download.
 */

import type { EvalFile } from "./recall-eval.js";

const DAY_MS = 86_400_000;

/** A row saved through memory_save (or a flush), inserted before retrieval. */
export interface RegressionMemory {
  readonly content: string;
  readonly tags?: readonly string[];
  readonly importance?: number;
}

export interface RegressionScenario {
  readonly name: string;
  readonly description: string;
  /** Files written under `<workspace>/memory/` (path relative), mtime = now - ageDays. */
  readonly files: readonly EvalFile[];
  readonly memories: readonly RegressionMemory[];
  /** The query exactly as the dispatcher hands it to the retriever. */
  readonly query: string;
  /** Substring that identifies the planted fact in a result body. */
  readonly needle: string;
  /**
   * The planted fact must appear at this 1-based rank or better. 5 (the
   * production topK) means "retrievable": it reaches the injected block.
   */
  readonly maxRank: number;
  /** Every result whose path contains this must rank below the planted fact. */
  readonly mustOutrankPathsContaining?: string;
}

export interface RegressionHit {
  readonly path: string;
  readonly heading: string | null;
  readonly body: string;
}

export interface ScenarioScore {
  readonly name: string;
  readonly passed: boolean;
  /** 1-based rank of the planted fact, or null when it was not returned. */
  readonly rank: number | null;
  readonly problems: readonly string[];
  readonly got: readonly string[];
}

export interface RegressionReport {
  readonly scenarios: readonly ScenarioScore[];
  readonly passed: number;
  /** Fraction of scenarios whose planted fact was returned at all. */
  readonly recall: number;
  /** Mean reciprocal rank of the planted facts (0 for a miss). */
  readonly mrr: number;
}

/** The exclusion list production passes (Phase 115 locked default). */
export const PRODUCTION_EXCLUDE_TAGS: readonly string[] = Object.freeze([
  "session-summary",
  "mid-session",
  "raw-fallback",
]);

/** Fixed clock for the fixtures: 2026-10-26 18:00 UTC. */
export const REGRESSION_NOW = Date.UTC(2026, 9, 26, 18, 0, 0);

let envelopeSeq = 0;

/**
 * Wrap `text` the way `formatDiscordMessage` (src/discord/bridge.ts) does:
 * `<channel source chat_id message_id user ts>`, the words, `</channel>`.
 * Snowflake-like ids and a date make the envelope token-heavy, as in
 * production.
 */
export function discordEnvelope(
  text: string,
  opts: { readonly user?: string; readonly at?: number } = {},
): string {
  envelopeSeq += 1;
  const at = new Date(opts.at ?? REGRESSION_NOW);
  const ts = `${at.toISOString().slice(0, 10)} ${at.toISOString().slice(11, 16)} PDT`;
  const messageId = (1433000000000000000n + BigInt(envelopeSeq)).toString();
  return [
    `<channel source="discord" chat_id="000000000000000001" message_id="${messageId}" user="${opts.user ?? "jas"}" ts="${ts}">`,
    text,
    `</channel>`,
  ].join("\n");
}

/**
 * Wrap an embedder so it sees only the first `maxWords` words, exactly as
 * embedder.ts truncateText does before MiniLM (200 words).
 */
export function truncatingEmbedder<T>(
  embed: (text: string) => Promise<T>,
  maxWords: number,
): (text: string) => Promise<T> {
  return (text: string) => {
    const words = text.split(/\s+/);
    return embed(words.length <= maxWords ? text : words.slice(0, maxWords).join(" "));
  };
}

function isoDate(ageDays: number): string {
  return new Date(REGRESSION_NOW - ageDays * DAY_MS).toISOString().slice(0, 10);
}

/** A daily log in the session-log.ts format, user turns envelope-wrapped. */
function dailyLog(
  ageDays: number,
  turns: readonly { readonly user: string; readonly assistant: string }[],
): EvalFile {
  const date = isoDate(ageDays);
  const at = REGRESSION_NOW - ageDays * DAY_MS;
  const body = turns
    .map((t, i) => {
      const hh = String(9 + i).padStart(2, "0");
      return (
        `\n## ${hh}:14:22 [user]\n${discordEnvelope(t.user, { at })}\n` +
        `\n## ${hh}:14:40 [assistant]\n${t.assistant}\n`
      );
    })
    .join("");
  return { path: `${date}.md`, ageDays, content: `# Session Log: ${date}\n${body}` };
}

/**
 * Background corpus shared by every scenario: two weeks of daily logs with
 * envelope-wrapped user turns on unrelated topics, standing vault rules and
 * a runbook, plus a few saved memories. It gives each ranker something to
 * confuse the planted fact with.
 */
export function backgroundCorpus(): { files: EvalFile[]; memories: RegressionMemory[] } {
  const topics: readonly (readonly [string, string])[] = [
    ["can you summarise the open pull requests", "Three PRs are open: the cache fix, the docs pass and the CI bump."],
    ["what time is the standup tomorrow", "Standup is at 09:30 as usual."],
    ["draft a reply to the landlord about the lease", "Drafted a short reply confirming the lease dates."],
    ["remind me what we decided on the logo colours", "Navy and sand, decided last month."],
    ["how many tickets are still unassigned", "Four tickets are unassigned in the web queue."],
    ["book a table for friday dinner", "Booked a table for four at 19:00 on Friday."],
    ["check the disk usage on the build box", "The build box is at 71 percent disk usage."],
    ["what did the weekly report say about churn", "Churn was flat week over week."],
    ["send the invoice reminder to the printer vendor", "Sent the invoice reminder to the printer vendor."],
    ["is the vpn certificate expiring soon", "The VPN certificate expires in 40 days."],
    ["what is on my calendar this afternoon", "Two meetings: design review and a one to one."],
    ["update the grocery list with oat milk", "Added oat milk to the grocery list."],
  ];
  const files: EvalFile[] = [];
  for (let day = 1; day <= 14; day++) {
    const turns = [0, 1, 2].map((j) => {
      const [user, assistant] = topics[(day * 3 + j) % topics.length]!;
      return { user, assistant };
    });
    files.push(dailyLog(day, turns));
  }
  files.push({
    path: "vault/house-rules.md",
    ageDays: 200,
    content:
      "## Reply style\n\nKeep replies short and plain; no tables unless asked.\n\n" +
      "## Calendar rule\n\nNever accept a meeting before 09:00 without asking first.",
  });
  files.push({
    path: "procedures/vpn.md",
    ageDays: 120,
    content: "## Renewing the VPN certificate\n\nRequest a new certificate from the portal, install it, then restart the client.",
  });
  const memories: RegressionMemory[] = [
    { content: "The user prefers British spelling in written replies." },
    { content: "Weekly report goes out on Mondays before noon." },
    { content: "The printer vendor invoices quarterly." },
  ];
  return { files, memories };
}

/**
 * Deterministic filler prose for the long-section scenario. Each paragraph
 * draws its words from its own small theme (eight words out of the pool),
 * so paragraphs read as distinct topics to the vector ranker, and none of
 * them uses a word from the planted fact or the question.
 */
function fillerParagraphs(paragraphs: number, wordsPerParagraph: number): string[] {
  const pool = [
    "planning", "budget", "timeline", "review", "milestone", "design", "testing", "rollout",
    "feedback", "metrics", "dashboard", "backlog", "sprint", "retro", "estimate", "scope",
    "risk", "owner", "status", "update", "meeting", "notes", "agenda", "priority",
    "customer", "support", "ticket", "release", "branch", "merge", "build", "pipeline",
    "hiring", "onboarding", "laptop", "badge", "office", "parking", "lunch", "travel",
    "website", "banner", "copy", "font", "colour", "layout", "image", "caption",
    "server", "memory", "disk", "network", "latency", "uptime", "alert", "pager",
    "contract", "invoice", "quote", "legal", "signature", "renewal", "discount", "terms",
  ];
  // 32-bit LCG (Math.imul keeps it exact); the high bits are the random ones.
  let seed = 7;
  const next = (): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed >>> 16;
  };
  const out: string[] = [];
  for (let p = 0; p < paragraphs; p++) {
    const theme = Array.from({ length: 8 }, () => pool[next() % pool.length]!);
    const words: string[] = [];
    for (let w = 0; w < wordsPerParagraph; w++) words.push(theme[next() % theme.length]!);
    out.push(`${words.join(" ")}.`);
  }
  return out;
}

/** The five WP2 scenarios. */
export function wp2RegressionScenarios(): readonly RegressionScenario[] {
  // The last paragraph of the section: a short note on one topic, as a
  // person would write it at the end of a long running log.
  const longFact =
    "Alpha vendor escrow: the Alpha vendor keeps its escrow account with Northgate; " +
    "the escrow account ends in 7781 and renews every March, and any change to the " +
    "Alpha vendor escrow needs finance sign-off before the renewal.";
  const longSection =
    `# Session Flush ${isoDate(5)} 14:30\n\n## Project Alpha notes\n\n` +
    fillerParagraphs(50, 60).join("\n\n") +
    `\n\n${longFact}\n`;

  return Object.freeze([
    {
      name: "envelope-query",
      description:
        "An envelope-wrapped question finds the fact the user stated four days ago in an envelope-wrapped daily-log turn.",
      files: [
        dailyLog(4, [
          { user: "check the disk usage on the build box", assistant: "The build box is at 71 percent disk usage." },
          {
            user: "for the record: the staging database password rotation is owned by Priya, every second Tuesday",
            assistant: "Noted.",
          },
          { user: "what time is the standup tomorrow", assistant: "Standup is at 09:30 as usual." },
        ]),
      ],
      memories: [],
      query: discordEnvelope("who owns the staging database password rotation?"),
      needle: "owned by Priya",
      maxRank: 3,
    },
    {
      name: "old-dated-note",
      description:
        "A 45-day-old dated note is returned when it is the only relevant one (soft window, not a drop).",
      files: [
        {
          path: `${isoDate(45)}-1015.md`,
          ageDays: 45,
          content:
            `# Session Flush ${isoDate(45)} 10:15\n\n## Decisions\n\n` +
            "We agreed the Halvorsen contract renewal goes to legal review before anyone signs it.",
        },
      ],
      memories: [],
      query: discordEnvelope("what did we agree about the Halvorsen contract renewal?"),
      needle: "Halvorsen contract renewal goes to legal review",
      maxRank: 5,
    },
    {
      name: "vault-vs-dated",
      description:
        "Vault rules on the same theme (releases, change control) that share no keyword with the question do not outrank a three-day-old note that answers it. Before WP2 any vault chunk in either top-20 got +0.2, six times the largest RRF score, and ranked first.",
      files: [
        {
          path: "vault/change-rules.md",
          ageDays: 90,
          content:
            "## Release freeze\n\nWhat the release freeze means: no release goes out on Fridays after 15:00.\n\n" +
            "## Change approval\n\nThe change board approves every production change; the ticket needs a second reviewer.\n\n" +
            "## Incident updates\n\nDuring an incident, post an update in the status channel every 30 minutes.",
        },
        {
          path: `${isoDate(3)}-1600.md`,
          ageDays: 3,
          content:
            `# Session Flush ${isoDate(3)} 16:00\n\n## Payments deploy rollback\n\n` +
            "If the payments deploy fails, the rollback plan is to revert the release tag and replay the payments queue from the last checkpoint.",
        },
      ],
      memories: [],
      query: discordEnvelope("what is the rollback plan if the payments deploy fails?"),
      needle: "rollback plan is to revert the release tag",
      maxRank: 1,
      mustOutrankPathsContaining: "/memory/vault/",
    },
    {
      name: "flush-flood",
      description:
        "500 mid-session rows that match the query better than the saved memory do not displace it.",
      files: [],
      memories: [
        { content: "Kestrel migration cutover window is Saturday 02:00 UTC, approved by Dana.", importance: 0.7 },
        ...Array.from({ length: 500 }, (_, i) => ({
          content: `Flush ${String(i + 100)}: when is the Kestrel migration cutover window`,
          tags: ["mid-session"],
          importance: 0.4,
        })),
      ],
      query: discordEnvelope("when is the Kestrel migration cutover window?"),
      needle: "approved by Dana",
      maxRank: 5,
    },
    {
      name: "long-section",
      description:
        "A fact in the last paragraph of a 3,000-word H2 section is retrievable.",
      files: [{ path: `${isoDate(5)}-1430.md`, ageDays: 5, content: longSection }],
      memories: [],
      query: discordEnvelope("which escrow account does the Alpha vendor use?"),
      needle: "escrow account ends in 7781",
      maxRank: 5,
    },
  ]);
}

/** Score one scenario's ranked results. */
export function scoreScenario(
  scenario: RegressionScenario,
  results: readonly RegressionHit[],
): ScenarioScore {
  const idx = results.findIndex((r) => r.body.includes(scenario.needle));
  const rank = idx >= 0 ? idx + 1 : null;
  const problems: string[] = [];
  if (rank === null) problems.push(`planted fact not returned (needle "${scenario.needle}")`);
  else if (rank > scenario.maxRank) problems.push(`planted fact at rank ${rank}, floor is ${scenario.maxRank}`);
  if (scenario.mustOutrankPathsContaining && rank !== null) {
    const marker = scenario.mustOutrankPathsContaining;
    results.forEach((r, i) => {
      if (i < idx && r.path.includes(marker)) {
        problems.push(`${r.path} (${r.heading ?? "no heading"}) ranks above the planted fact`);
      }
    });
  }
  return Object.freeze({
    name: scenario.name,
    passed: problems.length === 0,
    rank,
    problems: Object.freeze(problems),
    got: Object.freeze(results.map((r) => `${r.heading ?? r.path}: ${r.body.slice(0, 60)}`)),
  });
}

/** Roll the per-scenario scores into one report. */
export function summarizeRegression(scores: readonly ScenarioScore[]): RegressionReport {
  const n = scores.length;
  const found = scores.filter((s) => s.rank !== null).length;
  const rr = scores.reduce((acc, s) => acc + (s.rank ? 1 / s.rank : 0), 0);
  return Object.freeze({
    scenarios: Object.freeze([...scores]),
    passed: scores.filter((s) => s.passed).length,
    recall: n === 0 ? 0 : found / n,
    mrr: n === 0 ? 0 : rr / n,
  });
}
