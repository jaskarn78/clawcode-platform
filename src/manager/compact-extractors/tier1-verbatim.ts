import type { ConversationTurn } from "../../memory/compaction.js";
import type { ExtractorDeps, VerbatimGate } from "./types.js";

const TIER1_SENTINEL_FIRED = new Set<string>();

export function resetTier1SentinelTracking(): void {
  TIER1_SENTINEL_FIRED.clear();
}

const SYSTEM_MARKER_RE = /(SOUL|IDENTITY)\.md\b/;
const DAILY_NOTES_RE = /daily-notes\/\d{4}-\d{2}-\d{2}/;

function matchesAnyPattern(
  content: string,
  patterns: readonly RegExp[],
): boolean {
  for (const re of patterns) {
    if (re.test(content)) return true;
  }
  return false;
}

function isLoadBearing(
  turn: ConversationTurn,
  patterns: readonly RegExp[],
): boolean {
  if (SYSTEM_MARKER_RE.test(turn.content)) return true;
  if (DAILY_NOTES_RE.test(turn.content)) return true;
  if (matchesAnyPattern(turn.content, patterns)) return true;
  return false;
}

export const partitionForVerbatim: VerbatimGate = (turns, deps) => {
  emitSentinelOnce(deps);

  const total = turns.length;
  const n = Math.max(0, Math.min(deps.preserveLastTurns, total));
  const lastNStart = total - n;

  const preservedSet = new Set<number>();

  for (let i = lastNStart; i < total; i++) preservedSet.add(i);

  let userKept = 0;
  for (let i = total - 1; i >= 0 && userKept < 3; i--) {
    if (turns[i].role === "user") {
      preservedSet.add(i);
      userKept++;
    }
  }

  for (let i = 0; i < total; i++) {
    if (isLoadBearing(turns[i], deps.preserveVerbatimPatterns)) {
      preservedSet.add(i);
    }
  }

  const preserved: ConversationTurn[] = [];
  const toCompact: ConversationTurn[] = [];
  for (let i = 0; i < total; i++) {
    if (preservedSet.has(i)) preserved.push(turns[i]);
    else toCompact.push(turns[i]);
  }

  return Object.freeze({
    preserved: Object.freeze(preserved),
    toCompact: Object.freeze(toCompact),
  });
};

function emitSentinelOnce(deps: ExtractorDeps): void {
  if (TIER1_SENTINEL_FIRED.has(deps.agentName)) return;
  TIER1_SENTINEL_FIRED.add(deps.agentName);
  deps.log.info(
    { agent: deps.agentName, sentinel: "125-02-tier1-filter" },
    "[125-02-tier1-filter] tier1 verbatim gate active",
  );
}
