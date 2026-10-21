import { describe, it, expect, beforeEach } from "vitest";
import pino from "pino";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as fsPromises from "node:fs/promises";
import type { ConversationTurn } from "../../../memory/compaction.js";
import { writeActiveStateYaml, readActiveStateYaml } from "../../active-state/yaml-writer.js";
import { buildActiveStateBlock } from "../../active-state/builder.js";
import type { Tier2Facts } from "../types.js";
import {
  buildTieredExtractor,
  partitionForVerbatim,
} from "../index.js";
import { resetTier1SentinelTracking } from "../tier1-verbatim.js";
import { resetTier4SentinelTracking } from "../tier4-drop.js";
import { resetTier2SentinelTracking } from "../tier2-haiku.js";
import type { ExtractorDeps } from "../types.js";
import {
  buildSyntheticReplay,
  buildSyntheticSdkTranscript,
} from "./fixtures/build-fixture.js";
import {
  readToolAwareTurns,
  toolAwareTurnsToText,
} from "../../../memory/sdk-transcript-reader.js";

function makeLog(sink: { entries: unknown[] }): ExtractorDeps["log"] {
  return pino(
    { level: "info" },
    { write: (s) => sink.entries.push(JSON.parse(s)) },
  ) as unknown as ExtractorDeps["log"];
}

function turnsToText(turns: readonly ConversationTurn[]): string {
  return turns.map((t) => `[${t.role}]: ${t.content}`).join("\n");
}

describe("compact-extractors seam integration", () => {
  beforeEach(() => {
    resetTier1SentinelTracking();
    resetTier4SentinelTracking();
    resetTier2SentinelTracking();
  });

  it("end-to-end: ≥40% byte reduction on synthetic 6-hour replay (SC-3)", async () => {
    const sink = { entries: [] as unknown[] };
    const log = makeLog(sink);
    const turns = buildSyntheticReplay();
    expect(turns.length).toBeGreaterThanOrEqual(400);

    const deps: ExtractorDeps = {
      preserveLastTurns: 10,
      preserveVerbatimPatterns: [/\bAUM\b/, /\$[0-9]/],
      clock: () => new Date(0),
      log,
      agentName: "fin-client-fixture",
    };

    const { preserved, toCompact } = partitionForVerbatim(turns, deps);
    expect(preserved.length + toCompact.length).toBe(turns.length);

    const toCompactText = turnsToText(toCompact);
    const extract = buildTieredExtractor({
      preserveLastTurns: deps.preserveLastTurns,
      preserveVerbatimPatterns: deps.preserveVerbatimPatterns,
      preservedTurns: preserved,
      clock: deps.clock,
      log: deps.log,
      agentName: deps.agentName,
    });
    const facts = await extract(toCompactText);

    const preCompactBytes = toCompactText.length;
    const postCompactBytes = facts
      .filter((f) => !f.startsWith("[user]") && !f.startsWith("[assistant]"))
      .concat(
        facts.filter(
          (f) => f.startsWith("[user]") || f.startsWith("[assistant]"),
        ),
      )
      .filter((f) => !preserved.some((p) => `[${p.role}]: ${p.content}` === f))
      .join("\n").length;

    const savedRatio = (preCompactBytes - postCompactBytes) / preCompactBytes;
    expect(savedRatio).toBeGreaterThanOrEqual(0.4);
  });

  it("last-N marker survives compaction (Tier 1 regression)", async () => {
    const sink = { entries: [] as unknown[] };
    const log = makeLog(sink);
    const baseTurns = buildSyntheticReplay();
    const MARKER = "MARKER-TOKEN-7H3K9";
    const withMarker: ConversationTurn[] = [...baseTurns];
    const markerIdx = withMarker.length - 3;
    withMarker[markerIdx] = Object.freeze({
      timestamp: withMarker[markerIdx].timestamp,
      role: "assistant",
      content: `${MARKER}: this is the marker turn`,
    });

    const deps: ExtractorDeps = {
      preserveLastTurns: 10,
      preserveVerbatimPatterns: [],
      clock: () => new Date(0),
      log,
      agentName: "marker-agent",
    };
    const { preserved, toCompact } = partitionForVerbatim(withMarker, deps);
    expect(preserved.some((t) => t.content.includes(MARKER))).toBe(true);
    expect(toCompact.some((t) => t.content.includes(MARKER))).toBe(false);

    const extract = buildTieredExtractor({
      preserveLastTurns: deps.preserveLastTurns,
      preserveVerbatimPatterns: deps.preserveVerbatimPatterns,
      preservedTurns: preserved,
      clock: deps.clock,
      log: deps.log,
      agentName: deps.agentName,
    });
    const facts = await extract(turnsToText(toCompact));
    expect(facts.some((f) => f.includes(MARKER))).toBe(true);
  });

  it("SC-8 fixture: AUM and $-prefixed values land in preserved", () => {
    const sink = { entries: [] as unknown[] };
    const log = makeLog(sink);
    const baseTurns = buildSyntheticReplay();
    const injected: ConversationTurn[] = [...baseTurns];
    for (let i = 0; i < 5; i++) {
      injected.splice(
        20 + i * 4,
        0,
        Object.freeze({
          timestamp: "2026-05-14T08:00:00Z",
          role: "user",
          content: `the client AUM stands at ${i} billion`,
        }),
      );
    }
    for (let i = 0; i < 3; i++) {
      injected.splice(
        40 + i * 5,
        0,
        Object.freeze({
          timestamp: "2026-05-14T08:00:00Z",
          role: "assistant",
          content: `wire $45M tranche ${i}`,
        }),
      );
    }

    const deps: ExtractorDeps = {
      preserveLastTurns: 10,
      preserveVerbatimPatterns: [/\bAUM\b/, /\$[0-9]/],
      clock: () => new Date(0),
      log,
      agentName: "sc8-agent",
    };
    const { preserved } = partitionForVerbatim(injected, deps);
    const aumCount = preserved.filter((t) => /\bAUM\b/.test(t.content)).length;
    const dollarCount = preserved.filter((t) => /\$[0-9]/.test(t.content)).length;
    expect(aumCount).toBeGreaterThanOrEqual(5);
    expect(dollarCount).toBeGreaterThanOrEqual(3);
  });

  it("tier2 wired: structured facts appear ahead of tier4 chunks (Plan 03)", async () => {
    const sink = { entries: [] as unknown[] };
    const log = makeLog(sink);
    const turns = buildSyntheticReplay().slice(0, 80);
    const { preserved, toCompact } = partitionForVerbatim(turns, {
      preserveLastTurns: 10,
      preserveVerbatimPatterns: [],
      clock: () => new Date(0),
      log,
      agentName: "tier2-wired-agent",
    });

    let onTier2Called = false;
    const cannedYaml = `activeClients: [Acme]
decisions:
  - decision: "Move AUM threshold to $45M"
    context: "agreed with Client A"
standingRulesChanged: []
inFlightTasks: []
drivePathsTouched: ["clients/Acme/"]
criticalNumbers:
  - context: "Acme AUM"
    value: "$45M"
`;

    const extract = buildTieredExtractor({
      preserveLastTurns: 10,
      preserveVerbatimPatterns: [],
      preservedTurns: preserved,
      clock: () => new Date(0),
      log,
      agentName: "tier2-wired-agent",
      tier2Summarize: async () => cannedYaml,
      onTier2Facts: async () => {
        onTier2Called = true;
      },
    });
    const facts = await extract(turnsToText(toCompact));
    expect(facts.some((f) => f.includes("[tier2] activeClient: Acme"))).toBe(
      true,
    );
    expect(facts.some((f) => f.includes("[tier2] criticalNumber: $45M"))).toBe(
      true,
    );
    expect(onTier2Called).toBe(true);

    // Layout: [preservedFacts..., tier2Chunks..., tier4Chunks...].
    // Preserved facts share the `[user]:`/`[assistant]:` prefix; tier4 turns
    // do too — distinguish by Set membership against the preserved list.
    const preservedSet = new Set(
      preserved.map((p) => `[${p.role}]: ${p.content}`),
    );
    const firstTier2 = facts.findIndex((f) => f.startsWith("[tier2]"));
    const firstTier4 = facts.findIndex(
      (f) =>
        (f.startsWith("[user]:") || f.startsWith("[assistant]:")) &&
        !preservedSet.has(f),
    );
    expect(firstTier2).toBeGreaterThanOrEqual(0);
    if (firstTier4 >= 0) {
      const lastTier2 = facts
        .map((f, i) => (f.startsWith("[tier2]") ? i : -1))
        .filter((i) => i >= 0)
        .pop()!;
      expect(lastTier2).toBeLessThan(firstTier4);
    }
  });

  it("tier2 failure (haiku throws): seam still produces Plan 02 output", async () => {
    const sink = { entries: [] as unknown[] };
    const log = makeLog(sink);
    const turns = buildSyntheticReplay().slice(0, 50);
    const { preserved, toCompact } = partitionForVerbatim(turns, {
      preserveLastTurns: 10,
      preserveVerbatimPatterns: [],
      clock: () => new Date(0),
      log,
      agentName: "tier2-fail-agent",
    });

    const extract = buildTieredExtractor({
      preserveLastTurns: 10,
      preserveVerbatimPatterns: [],
      preservedTurns: preserved,
      clock: () => new Date(0),
      log,
      agentName: "tier2-fail-agent",
      tier2Summarize: async () => {
        throw new Error("simulated haiku failure");
      },
    });
    const facts = await extract(turnsToText(toCompact));
    expect(facts.length).toBeGreaterThan(0);
    expect(facts.some((f) => f.startsWith("[tier2]"))).toBe(false);
  });

  it("end-to-end: tier2 YAML written to disk with active client merged in (SC-4)", async () => {
    const sink = { entries: [] as unknown[] };
    const log = makeLog(sink);
    const baseDir = await mkdtemp(join(tmpdir(), "tier2-yaml-"));
    try {
      const cannedYaml = `activeClients: [Acme]
decisions: []
standingRulesChanged: []
inFlightTasks: []
drivePathsTouched: ["clients/Acme/"]
criticalNumbers:
  - context: "Acme AUM"
    value: "$45M"
`;
      const onTier2Facts = async (facts: Tier2Facts): Promise<void> => {
        const block = buildActiveStateBlock({
          recentOperatorMessages: ["look at clients/Other/file"],
          recentAgentTurns: [],
          agentName: "sc4-agent",
          clock: () => new Date("2026-05-14T15:00:00Z"),
          tier2Facts: facts,
        });
        await writeActiveStateYaml("sc4-agent", block, {
          baseDir,
          fs: fsPromises,
          clock: () => new Date("2026-05-14T15:00:00Z"),
        });
      };

      const turns = buildSyntheticReplay().slice(0, 30);
      const extract = buildTieredExtractor({
        preserveLastTurns: 10,
        preserveVerbatimPatterns: [],
        preservedTurns: [],
        clock: () => new Date(0),
        log,
        agentName: "sc4-agent",
        tier2Summarize: async () => cannedYaml,
        onTier2Facts,
      });
      const facts = await extract(turnsToText(turns));

      // Memory.db chunks: integration with compaction.ts:151 means each chunk
      // becomes a memory row. We assert chunk count > 0 to prove D-04 growth.
      expect(facts.length).toBeGreaterThan(0);
      expect(facts.some((f) => f.startsWith("[tier2]"))).toBe(true);

      // YAML side-effect: operator-inspectable file exists, parses, and the
      // tier2-derived client wins over the heuristic.
      const yamlPath = join(baseDir, "sc4-agent", "state", "active-state.yaml");
      const raw = await readFile(yamlPath, "utf8");
      expect(raw).toContain("Acme");
      const roundTripped = await readActiveStateYaml("sc4-agent", {
        baseDir,
        fs: fsPromises,
      });
      expect(roundTripped?.primaryClient).toBe("Acme");
      expect(
        roundTripped?.driveFoldersTouched.includes("clients/Acme/"),
      ).toBe(true);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it("sentinel proof: [125-02-tier1-filter] and [125-02-tier4-drop] each log once", async () => {
    const sink = { entries: [] as unknown[] };
    const log = makeLog(sink);
    const deps: ExtractorDeps = {
      preserveLastTurns: 5,
      preserveVerbatimPatterns: [],
      clock: () => new Date(0),
      log,
      agentName: "sentinel-agent-unique-1",
    };
    const turns = buildSyntheticReplay().slice(0, 50);

    const { preserved, toCompact } = partitionForVerbatim(turns, deps);
    const extract = buildTieredExtractor({
      preserveLastTurns: deps.preserveLastTurns,
      preserveVerbatimPatterns: deps.preserveVerbatimPatterns,
      preservedTurns: preserved,
      clock: deps.clock,
      log: deps.log,
      agentName: deps.agentName,
    });
    await extract(turnsToText(toCompact));
    await extract(turnsToText(toCompact));

    const tier1Hits = sink.entries.filter(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        (e as { sentinel?: string }).sentinel === "125-02-tier1-filter",
    );
    const tier4Hits = sink.entries.filter(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        (e as { sentinel?: string }).sentinel === "125-02-tier4-drop",
    );
    expect(tier1Hits.length).toBe(1);
    expect(tier4Hits.length).toBe(1);
  });
});

/**
 * Phase 999.75 Part A (A5) — tier extractors driven through the tool-aware
 * SDK transcript converter.
 *
 * These tests prove the tiers fire on the REAL tool blocks that
 * `getSessionMessages` returns. Before Part A, compaction fed the extractors
 * final-text-only `ConversationStore` turns where `tool_use:` / `tool_result:`
 * markers never appear — Tier 3 + Tier 4 were silent no-ops. The path under
 * test is: `SessionMessage[]` → `readToolAwareTurns` → `toolAwareTurnsToText`
 * → `buildTieredExtractor`. An end-to-end test of this path could not exist
 * before Part A because the converter (`sdk-transcript-reader.ts`) did not
 * exist.
 */
describe("compact-extractors seam — tool-aware SDK transcript path (999.75)", () => {
  beforeEach(() => {
    resetTier1SentinelTracking();
    resetTier4SentinelTracking();
    resetTier2SentinelTracking();
  });

  it("Tier 3: a base64 tool_use payload from the SDK transcript collapses to a [tier3] stub", async () => {
    const sink = { entries: [] as unknown[] };
    const log = makeLog(sink);
    const messages = buildSyntheticSdkTranscript();

    const turns = await readToolAwareTurns({
      sessionId: "fixture-session-7",
      dir: "/tmp/fixture",
      getSessionMessages: async () => messages,
      agentName: "tool-aware-tier3-agent",
      log,
    });
    expect(turns).not.toBeNull();
    const text = toolAwareTurnsToText(turns!);
    // Sanity: the raw transcript text still carries the bulky base64 payload.
    expect(text).toContain("tool_use: read_pdf");
    expect(text.length).toBeGreaterThan(4096);

    const extract = buildTieredExtractor({
      preserveLastTurns: 0,
      preserveVerbatimPatterns: [],
      preservedTurns: [],
      clock: () => new Date(0),
      log,
      agentName: "tool-aware-tier3-agent",
    });
    const facts = await extract(text);

    // The bulky read_pdf tool_use is collapsed to a deterministic stub and
    // the base64 bytes are GONE — the no-op-certifying fixture never proved
    // this because its markers were ConversationStore text the daemon never
    // actually fed the extractor.
    expect(facts.some((f) => f.includes("[tier3] tool_use: read_pdf"))).toBe(
      true,
    );
    expect(facts.some((f) => f.includes("TWFuIGlz"))).toBe(false);
  });

  it("Tier 4: a failed-then-retried tool_result pair from the SDK transcript is dropped", async () => {
    const sink = { entries: [] as unknown[] };
    const log = makeLog(sink);
    const messages = buildSyntheticSdkTranscript();

    const turns = await readToolAwareTurns({
      sessionId: "fixture-session-7",
      dir: "/tmp/fixture",
      getSessionMessages: async () => messages,
      agentName: "tool-aware-tier4-agent",
      log,
    });
    expect(turns).not.toBeNull();
    const text = toolAwareTurnsToText(turns!);
    // Sanity: the converter rendered both the failed and the ok result.
    expect(text).toContain("tool_result: fetch_url error");
    expect(text).toContain("tool_result: fetch_url ok");

    const extract = buildTieredExtractor({
      preserveLastTurns: 0,
      preserveVerbatimPatterns: [],
      preservedTurns: [],
      clock: () => new Date(0),
      log,
      agentName: "tool-aware-tier4-agent",
    });
    const facts = await extract(text);

    // The failed fetch_url result is dropped (the retry succeeded within
    // 4 turns); the successful result survives.
    expect(facts.some((f) => /tool_result: fetch_url error/.test(f))).toBe(
      false,
    );
    expect(facts.some((f) => /tool_result: fetch_url ok/.test(f))).toBe(true);
  });

  it("converter → extractor: the SDK transcript reduces vs its raw text", async () => {
    const sink = { entries: [] as unknown[] };
    const log = makeLog(sink);
    const messages = buildSyntheticSdkTranscript();

    const turns = await readToolAwareTurns({
      sessionId: "fixture-session-7",
      dir: "/tmp/fixture",
      getSessionMessages: async () => messages,
      agentName: "tool-aware-reduce-agent",
      log,
    });
    const text = toolAwareTurnsToText(turns!);
    const extract = buildTieredExtractor({
      preserveLastTurns: 0,
      preserveVerbatimPatterns: [],
      preservedTurns: [],
      clock: () => new Date(0),
      log,
      agentName: "tool-aware-reduce-agent",
    });
    const facts = await extract(text);
    // Tier 3 collapsing the base64 payload alone guarantees a large
    // reduction — the extracted chunks are far smaller than the raw text.
    expect(facts.join("\n").length).toBeLessThan(text.length);
  });
});
