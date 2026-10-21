/**
 * Phase 125 Plan 02 — D-01 single extractor seam.
 *
 * Both daemon dispatch sites (`daemon.ts` heartbeat auto-trigger + manual IPC
 * `compact-session` case) import `buildTieredExtractor` and call it ONCE per
 * compaction. Future plans (03 Haiku, 04 prose) evolve the pipeline inside
 * this module without touching daemon.ts.
 *
 * Tier ordering (per CONTEXT D-01/D-09 + advisor reconciliation):
 *   - Tier 1 partition runs UPSTREAM at the daemon callsite (full
 *     ConversationTurn[] visible there). Result `preserved` is threaded
 *     into this builder as `preservedTurns`; `toCompact` is what
 *     `compactForAgent` flushes to the daily log and feeds back into the
 *     `extractMemoriesFn(text)` callback as concatenated text.
 *   - Tier 4 (drop) runs INSIDE this callback on the parsed `toCompact`
 *     fragment; preserved turns NEVER enter the drop filter.
 *   - Tier 2 (Plan 03) / Tier 3 (Plan 04) are no-ops in Wave 2.
 *
 * Output format: `[role]: content` lines, in stable order
 *   `[...preservedAsFacts, ...tier4Kept]`. The preserved facts ride at the
 *   head so the summary-prepend on the fork carries them verbatim.
 */
import type { ConversationTurn } from "../../memory/compaction.js";
import { dropNoiseTurns } from "./tier4-drop.js";
import {
  extractStructuredFacts,
  tier2FactsToChunks,
} from "./tier2-haiku.js";
import { truncateLargePayloads } from "./tier3-payload-truncator.js";
import { summarizeAsProse } from "./tier3-prose.js";
import type { BuildExtractorDeps, ExtractMemoriesFn } from "./types.js";

const DEFAULT_MAX_CHUNKS = 50;

const TURN_LINE_RE = /^\[(user|assistant)\]:\s?(.*)$/;

function turnsFromConcatenatedText(text: string): readonly ConversationTurn[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  const turns: ConversationTurn[] = [];
  let current: { role: "user" | "assistant"; buf: string[] } | null = null;

  const flush = (): void => {
    if (!current) return;
    turns.push(
      Object.freeze({
        timestamp: "",
        role: current.role,
        content: current.buf.join("\n"),
      }),
    );
    current = null;
  };

  for (const line of lines) {
    const m = TURN_LINE_RE.exec(line);
    if (m) {
      flush();
      current = { role: m[1] as "user" | "assistant", buf: [m[2]] };
    } else if (current) {
      current.buf.push(line);
    }
  }
  flush();
  return turns;
}

function turnToFact(t: ConversationTurn): string {
  return `[${t.role}]: ${t.content}`;
}

export function buildTieredExtractor(
  deps: BuildExtractorDeps,
): ExtractMemoriesFn {
  const maxChunks = deps.maxChunks ?? DEFAULT_MAX_CHUNKS;

  return async (text: string): Promise<readonly string[]> => {
    const parsedTurns = turnsFromConcatenatedText(text);

    const dropped = dropNoiseTurns(parsedTurns, {
      preserveLastTurns: deps.preserveLastTurns,
      preserveVerbatimPatterns: deps.preserveVerbatimPatterns,
      clock: deps.clock,
      log: deps.log,
      agentName: deps.agentName,
    });

    const preservedFacts = deps.preservedTurns
      .map(turnToFact)
      .filter((s) => s.length > 0);

    // Tier 2 (Plan 03) — Haiku-driven structured extraction. Optional;
    // when `tier2Summarize` is absent (tests, back-compat) we fall through
    // to Plan 02 behavior. Failure modes inside `extractStructuredFacts`
    // return null — compaction never fails because Tier 2 failed.
    let tier2Chunks: readonly string[] = [];
    if (deps.tier2Summarize) {
      const facts = await extractStructuredFacts(text, {
        summarize: deps.tier2Summarize,
        log: deps.log,
        agentName: deps.agentName,
        timeoutMs: deps.tier2TimeoutMs,
      });
      if (facts) {
        tier2Chunks = tier2FactsToChunks(facts);
        if (deps.onTier2Facts) {
          try {
            await deps.onTier2Facts(facts);
          } catch (err) {
            deps.log.warn(
              {
                agent: deps.agentName,
                sentinel: "125-03-tier2-haiku",
                error: (err as Error).message,
              },
              "[125-03-tier2-haiku] onTier2Facts side-effect failed (non-fatal)",
            );
          }
        }
      }
    }

    // Tier 3 (Plan 04) — payload truncation + prose summary of the
    // residual region (post-Tier-4-drop). Bulky tool_use/tool_result
    // payloads collapse to deterministic stubs BEFORE the prose call so
    // Haiku never sees base64 PDFs. The prose string is a SINGLE chunk
    // that lands ahead of the verbatim Tier 4 chunks; on Haiku
    // failure/timeout `summarizeAsProse` returns the fallback string,
    // which is itself a valid summary — compaction degrades gracefully.
    const truncated = truncateLargePayloads(dropped);

    let tier3Chunk: string | null = null;
    if (deps.tier3Summarize) {
      const tier3Text = truncated.map(turnToFact).join("\n");
      tier3Chunk = await summarizeAsProse(tier3Text, {
        summarize: deps.tier3Summarize,
        log: deps.log,
        agentName: deps.agentName,
        timeoutMs: deps.tier3TimeoutMs,
      });
    }

    const tier4Facts = truncated
      .map(turnToFact)
      .filter((s) => s.length > 20);

    // Order matters: preserved → tier2 facts → tier3 prose → tier4 turns.
    // High-value structured + prose summaries ride ahead of raw turns so
    // they survive the `maxChunks` cap.
    const combined = [
      ...preservedFacts,
      ...tier2Chunks,
      ...(tier3Chunk ? [tier3Chunk] : []),
      ...tier4Facts,
    ].slice(0, maxChunks);
    return Object.freeze(combined);
  };
}

export { partitionForVerbatim } from "./tier1-verbatim.js";
export type { ExtractMemoriesFn, ExtractorDeps, PartitionResult } from "./types.js";
