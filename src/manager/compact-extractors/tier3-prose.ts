/**
 * Phase 125 Plan 04 — Tier 3 prose summary.
 *
 * Everything in the compactable set that isn't structured-extracted (Tier 2)
 * or dropped (Tier 4) collapses to a 2–3 sentence prose summary. Final tier
 * before drop. Per BACKLOG-SOURCE §"TIER 3 — PROSE SUMMARY", this is where
 * the bulk of byte reduction comes from after Tier 4.
 *
 * Mirrors `extractStructuredFacts` (tier2-haiku.ts):
 *   - DI'd `summarize` callback + AbortController timeout.
 *   - 30s timeout matching session-summarizer.ts.
 *   - Sentinel `[125-04-tier3-prose]` logged once per agent per process.
 *   - Never throws — on failure returns the deterministic fallback string
 *     (still a valid summary; compaction degrades gracefully).
 *
 * Cost discipline: per-compaction (not per-turn) and bounded by the 5-min
 * auto-trigger cooldown. Empty / trivially-small input short-circuits with
 * no Haiku call.
 */

import type { Logger } from "pino";

export const TIER3_TIMEOUT_MS = 30_000;
export const TIER3_FALLBACK =
  "[125-04-tier3-prose] compaction summary unavailable (Haiku fallback)";
const MIN_TEXT_CHARS = 40;
const MAX_PROMPT_CHARS = 8_000;

const TIER3_SENTINEL_FIRED = new Set<string>();

export function resetTier3SentinelTracking(): void {
  TIER3_SENTINEL_FIRED.clear();
}

export type Tier3SummarizeFn = (
  prompt: string,
  opts: { readonly signal?: AbortSignal },
) => Promise<string>;

export type Tier3ProseDeps = Readonly<{
  summarize: Tier3SummarizeFn;
  log: Logger;
  agentName: string;
  timeoutMs?: number;
}>;

function emitSentinelOnce(deps: Tier3ProseDeps): void {
  if (TIER3_SENTINEL_FIRED.has(deps.agentName)) return;
  TIER3_SENTINEL_FIRED.add(deps.agentName);
  deps.log.info(
    { agent: deps.agentName, sentinel: "125-04-tier3-prose" },
    "[125-04-tier3-prose] tier3 prose summarizer active",
  );
}

function buildPrompt(text: string): string {
  let payload = text;
  if (payload.length > MAX_PROMPT_CHARS) {
    payload =
      "[...older turns truncated for prompt-size cap]\n" +
      payload.slice(payload.length - MAX_PROMPT_CHARS);
  }
  return `Summarize the following conversation turns in 2-3 sentences. Focus on what was done and what state the conversation left things in. NO bullet points, NO YAML, NO headers — flowing prose only. Maximum 3 sentences.

# Conversation segment

${payload}
`;
}

function stripFallbackToOneLine(raw: string): string {
  const trimmed = raw.trim();
  // Squash internal newlines so the prose stays a single chunk in the
  // `memory.db` row and reads cleanly in the rolling summary.
  return trimmed.replace(/\s+\n+\s*/g, " ").replace(/\s{2,}/g, " ");
}

/**
 * Summarize `text` as 2–3 sentences of prose via Haiku.
 *
 * Never throws. On empty/short input, returns null without invoking Haiku
 * (cost discipline). On timeout / Haiku error / empty Haiku response,
 * returns the deterministic fallback string so the pipeline still emits a
 * Tier 3 row.
 */
export async function summarizeAsProse(
  text: string,
  deps: Tier3ProseDeps,
): Promise<string | null> {
  if (typeof text !== "string" || text.trim().length < MIN_TEXT_CHARS) {
    return null;
  }

  emitSentinelOnce(deps);

  const timeoutMs = deps.timeoutMs ?? TIER3_TIMEOUT_MS;
  const prompt = buildPrompt(text);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let raw: string;
  try {
    raw = await Promise.race([
      deps.summarize(prompt, { signal: controller.signal }),
      new Promise<string>((_, reject) => {
        controller.signal.addEventListener("abort", () =>
          reject(new Error("tier3 haiku timeout after " + timeoutMs + "ms")),
        );
      }),
    ]);
  } catch (err) {
    deps.log.warn(
      {
        agent: deps.agentName,
        sentinel: "125-04-tier3-prose",
        error: (err as Error).message,
      },
      "[125-04-tier3-prose] haiku failed, using fallback prose",
    );
    return TIER3_FALLBACK;
  } finally {
    clearTimeout(timer);
  }

  if (!raw || raw.trim().length === 0) {
    deps.log.warn(
      { agent: deps.agentName, sentinel: "125-04-tier3-prose" },
      "[125-04-tier3-prose] haiku returned empty content, using fallback prose",
    );
    return TIER3_FALLBACK;
  }

  return `[tier3] prose: ${stripFallbackToOneLine(raw)}`;
}
