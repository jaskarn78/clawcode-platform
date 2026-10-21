/**
 * Phase 125 Plan 04 SC-6 — Latency regression sentinel.
 *
 * In-process pipeline overhead budget. Production first-token latency
 * (the 30-60s baseline observed 2026-05-13 on a 6h-deep fin-client
 * session) includes worker swap + Haiku network round-trip and CANNOT be
 * measured in a unit test. What we CAN measure is the pure-CPU pipeline
 * overhead: partitionForVerbatim + Tier 4 drop + Tier 2 (stubbed 0ms) +
 * Tier 3 (stubbed 0ms) + payload truncation, all running against the
 * synthetic 6h replay fixture. SC-6 budget for the in-process portion is
 * < 500ms.
 *
 * # Post-deploy SC-6 verification (manual, deferred):
 * # 1. ssh clawdy "journalctl -u clawcode --since '24h ago' -g '125-04-tier3-prose'"
 * #    → confirm Tier 3 fired in production at least once.
 * # 2. clawcode usage fin-client --last 5  (after first auto-compact post-deploy)
 * #    → confirm first-token latency < 8s.
 * # 3. Compare against the 30-60s baseline recorded in 124-BACKLOG-SOURCE.md
 * #    (2026-05-13 observation).
 *
 * Two assertions:
 *   - pipeline overhead < 500ms (the in-process budget).
 *   - reduction_pct >= 40 (sanity gate inherited from SC-3 — full pipeline
 *     maintains the byte-reduction floor). The sidecar baseline JSON is
 *     rewritten on every run with the live numbers.
 */

import { describe, it, expect } from "vitest";
import pino from "pino";
import { readFileSync, writeFileSync } from "node:fs";
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

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const BASELINE_JSON_PATH = join(
  __dirname,
  "fixtures",
  "latency-baseline.json",
);

const STUB_TIER2_YAML = `activeClients: [Acme]
decisions: []
standingRulesChanged: []
inFlightTasks: []
drivePathsTouched: ["clients/Acme/"]
criticalNumbers:
  - context: "Acme AUM"
    value: "$45M"
`;

const STUB_TIER3_PROSE =
  "Agent worked through fin-client routine; AUM update posted, $45M tranche queued.";

function makeLog(): ExtractorDeps["log"] {
  return pino({ level: "silent" }) as unknown as ExtractorDeps["log"];
}

function turnsToText(turns: readonly ConversationTurn[]): string {
  return turns.map((t) => `[${t.role}]: ${t.content}`).join("\n");
}

describe("SC-6 latency regression sentinel", () => {
  it("pipeline overhead < 500ms on synthetic 6h replay (in-process budget)", async () => {
    resetTier1SentinelTracking();
    resetTier4SentinelTracking();
    resetTier2SentinelTracking();
    resetTier3SentinelTracking();

    const turns = buildSyntheticReplay();
    expect(turns.length).toBeGreaterThanOrEqual(400);

    const deps: ExtractorDeps = {
      preserveLastTurns: 10,
      preserveVerbatimPatterns: [/\bAUM\b/, /\$[0-9]/],
      clock: () => new Date(0),
      log: makeLog(),
      agentName: "latency-sentinel-agent",
    };

    const start = performance.now();
    const { preserved, toCompact } = partitionForVerbatim(turns, deps);
    const toCompactText = turnsToText(toCompact);
    const extract = buildTieredExtractor({
      preserveLastTurns: deps.preserveLastTurns,
      preserveVerbatimPatterns: deps.preserveVerbatimPatterns,
      preservedTurns: preserved,
      clock: deps.clock,
      log: deps.log,
      agentName: deps.agentName,
      tier2Summarize: async () => STUB_TIER2_YAML,
      tier3Summarize: async () => STUB_TIER3_PROSE,
    });
    const chunks = await extract(toCompactText);
    const elapsedMs = performance.now() - start;

    const rawTextBytes = turnsToText(turns).length;
    const postChunkBytes = chunks.join("\n").length;
    const reductionPct = Math.round(
      ((rawTextBytes - postChunkBytes) / rawTextBytes) * 100,
    );

    // Pin the live numbers into the sidecar so operators reading the
    // baseline JSON see what the pipeline actually achieves today.
    const baseline = JSON.parse(readFileSync(BASELINE_JSON_PATH, "utf8")) as {
      raw_text_bytes: number;
      post_extraction_bytes: number;
      reduction_pct: number;
      production_baseline_first_token_ms: number;
      production_target_first_token_ms: number;
      recorded_at: string;
      fixture_path: string;
      note: string;
    };
    baseline.raw_text_bytes = rawTextBytes;
    baseline.post_extraction_bytes = postChunkBytes;
    baseline.reduction_pct = reductionPct;
    writeFileSync(
      BASELINE_JSON_PATH,
      JSON.stringify(baseline, null, 2) + "\n",
      "utf8",
    );

    console.log(
      `[125-04 SC-6] pipeline overhead: ${elapsedMs.toFixed(1)}ms ` +
        `(budget 500ms)`,
    );
    console.log(
      `[125-04 SC-6] reduction: ${rawTextBytes} → ${postChunkBytes} bytes ` +
        `(${reductionPct}%)`,
    );
    console.log(
      `[125-04 SC-6] prod baseline first-token: ` +
        `${baseline.production_baseline_first_token_ms}ms → target ` +
        `${baseline.production_target_first_token_ms}ms (deferred to deploy)`,
    );

    expect(elapsedMs).toBeLessThan(500);
    expect(reductionPct).toBeGreaterThanOrEqual(40);
  });

  it("baseline JSON sidecar exists with all required fields", () => {
    const baseline = JSON.parse(readFileSync(BASELINE_JSON_PATH, "utf8")) as {
      recorded_at: string;
      fixture_path: string;
      raw_text_bytes: number;
      post_extraction_bytes: number;
      reduction_pct: number;
      production_baseline_first_token_ms: number;
      production_target_first_token_ms: number;
      note: string;
    };
    expect(baseline.recorded_at).toBeTruthy();
    expect(baseline.fixture_path).toBe("synthetic-6h-replay.json");
    expect(baseline.production_baseline_first_token_ms).toBe(30000);
    expect(baseline.production_target_first_token_ms).toBe(8000);
    expect(baseline.note).toContain("clawcode usage");
    expect(typeof baseline.raw_text_bytes).toBe("number");
    expect(typeof baseline.reduction_pct).toBe("number");
  });
});
