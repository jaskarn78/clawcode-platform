/**
 * Phase 125 Plan 03 — Tier 2 Haiku invocation harness.
 *
 * Mirrors `summarizeSession` (src/memory/session-summarizer.ts:180+) for the
 * DI'd `summarize` callback + AbortController-driven timeout + non-fatal
 * fallback. The structural difference is the output: instead of prose, we
 * parse the result through `parseTier2Output`. On timeout, parse failure,
 * empty input, or empty Haiku response, we return `null` — the seam
 * proceeds with Plan 02 (Tier 1 + Tier 4) output as designed (D-03
 * "Tier 2 is enrichment, not gate").
 *
 * Sentinel `[125-03-tier2-haiku]` is logged once per agent per process
 * lifetime, matching the `TIER4_SENTINEL_FIRED` pattern in `tier4-drop.ts`.
 */

import type { Logger } from "pino";
import { buildTier2ExtractionPrompt } from "./tier2-prompt.js";
import { parseTier2Output } from "./tier2-parser.js";
import type { Tier2Facts, Tier2SummarizeFn } from "./types.js";

export const TIER2_TIMEOUT_MS = 30_000;
const MIN_TEXT_CHARS = 40;

const TIER2_SENTINEL_FIRED = new Set<string>();

export function resetTier2SentinelTracking(): void {
  TIER2_SENTINEL_FIRED.clear();
}

export type Tier2ExtractDeps = Readonly<{
  summarize: Tier2SummarizeFn;
  log: Logger;
  agentName: string;
  timeoutMs?: number;
}>;

function emitSentinelOnce(deps: Tier2ExtractDeps): void {
  if (TIER2_SENTINEL_FIRED.has(deps.agentName)) return;
  TIER2_SENTINEL_FIRED.add(deps.agentName);
  deps.log.info(
    { agent: deps.agentName, sentinel: "125-03-tier2-haiku" },
    "[125-03-tier2-haiku] tier2 haiku extractor active",
  );
}

/**
 * Extract structured facts from a compacted-region text via Haiku.
 *
 * Cost discipline (D-03): early-returns null without invoking Haiku if the
 * input is empty or trivially small. Auto-trigger cooldown (Phase 124-04,
 * 5 min) already bounds the per-compaction spend; this guard prevents
 * pathological cases (zero-turn auto-trigger).
 *
 * All failure modes return `null`. Never throws.
 */
export async function extractStructuredFacts(
  text: string,
  deps: Tier2ExtractDeps,
): Promise<Tier2Facts | null> {
  if (typeof text !== "string" || text.trim().length < MIN_TEXT_CHARS) {
    return null;
  }

  emitSentinelOnce(deps);

  const timeoutMs = deps.timeoutMs ?? TIER2_TIMEOUT_MS;
  const prompt = buildTier2ExtractionPrompt(text);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let raw: string;
  try {
    raw = await Promise.race([
      deps.summarize(prompt, { signal: controller.signal }),
      new Promise<string>((_, reject) => {
        controller.signal.addEventListener("abort", () =>
          reject(new Error("tier2 haiku timeout after " + timeoutMs + "ms")),
        );
      }),
    ]);
  } catch (err) {
    deps.log.warn(
      {
        agent: deps.agentName,
        sentinel: "125-03-tier2-haiku",
        error: (err as Error).message,
      },
      "[125-03-tier2-haiku] haiku failed, falling back to null",
    );
    return null;
  } finally {
    clearTimeout(timer);
  }

  if (!raw || raw.trim().length === 0) {
    deps.log.warn(
      { agent: deps.agentName, sentinel: "125-03-tier2-haiku" },
      "[125-03-tier2-haiku] haiku returned empty content, falling back to null",
    );
    return null;
  }

  const facts = parseTier2Output(raw);
  if (!facts) {
    deps.log.warn(
      { agent: deps.agentName, sentinel: "125-03-tier2-haiku" },
      "[125-03-tier2-haiku] haiku output unparseable, falling back to null",
    );
    return null;
  }

  return facts;
}

/**
 * Flatten `Tier2Facts` into the `readonly string[]` chunks the
 * `ExtractMemoriesFn` contract requires. Each high-value fact becomes one
 * `memory.db` chunk via the existing `MemoryStore.addMemoryChunks` path
 * (compaction.ts:151). Stable string templates so RRF retrieval can match
 * on intent ("decision:", "rule:", etc.).
 *
 * Pure function — exposed for unit testing.
 */
export function tier2FactsToChunks(facts: Tier2Facts): readonly string[] {
  const out: string[] = [];

  for (const client of facts.activeClients) {
    out.push(`[tier2] activeClient: ${client}`);
  }
  for (const d of facts.decisions) {
    const ctx = d.context.length > 0 ? ` (${d.context})` : "";
    out.push(`[tier2] decision: ${d.decision}${ctx}`);
  }
  for (const r of facts.standingRulesChanged) {
    const when = r.changedAt.length > 0 ? ` @ ${r.changedAt}` : "";
    out.push(`[tier2] standingRule: ${r.rule}${when}`);
  }
  for (const t of facts.inFlightTasks) {
    const state = t.state.length > 0 ? ` — ${t.state}` : "";
    out.push(`[tier2] inFlightTask: ${t.task}${state}`);
  }
  for (const p of facts.drivePathsTouched) {
    out.push(`[tier2] drivePath: ${p}`);
  }
  for (const n of facts.criticalNumbers) {
    const ctx = n.context.length > 0 ? ` (${n.context})` : "";
    out.push(`[tier2] criticalNumber: ${n.value}${ctx}`);
  }

  return Object.freeze(out);
}
