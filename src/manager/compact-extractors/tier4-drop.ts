import type { ConversationTurn } from "../../memory/compaction.js";
import type { DropFilter, ExtractorDeps } from "./types.js";

const TIER4_SENTINEL_FIRED = new Set<string>();

export function resetTier4SentinelTracking(): void {
  TIER4_SENTINEL_FIRED.clear();
}

const HEARTBEAT_PROBE_PATTERNS: readonly RegExp[] = [
  /\[125-01-active-state\]/,
  /\[125-02-active-state\]/,
  /^---\s*ACTIVE STATE\s*---/m,
  /^HEARTBEAT_OK\b/m,
  /^heartbeat probe\b/im,
];

function isHeartbeatProbe(content: string): boolean {
  for (const re of HEARTBEAT_PROBE_PATTERNS) {
    if (re.test(content)) return true;
  }
  return false;
}

const TOOL_USE_RE = /tool_use:\s*([a-zA-Z0-9_.\-]+)(?:\s+args:\s*(\{[^}]*\}|\[[^\]]*\]|"[^"]*"|\S+))?/;
const TOOL_RESULT_OK_RE = /tool_result:\s*([a-zA-Z0-9_.\-]+)\s+(?:ok|success)\b/i;
const TOOL_RESULT_ERR_RE = /tool_result:\s*([a-zA-Z0-9_.\-]+)\s+(?:err(?:or)?|fail(?:ed)?)\b/i;

type ToolKey = { readonly name: string; readonly argsHash: string };

function extractToolKey(content: string): ToolKey | null {
  const m = TOOL_USE_RE.exec(content);
  if (!m) return null;
  return { name: m[1], argsHash: m[2] ?? "" };
}

function toolResultName(content: string): { name: string; ok: boolean } | null {
  const ok = TOOL_RESULT_OK_RE.exec(content);
  if (ok) return { name: ok[1], ok: true };
  const err = TOOL_RESULT_ERR_RE.exec(content);
  if (err) return { name: err[1], ok: false };
  return null;
}

function makeCollapseMarker(
  template: ConversationTurn,
  toolName: string,
  count: number,
): ConversationTurn {
  return Object.freeze({
    timestamp: template.timestamp,
    role: template.role,
    content: `[tier4] tool ${toolName} collapsed across ${count} calls`,
  });
}

export const dropNoiseTurns: DropFilter = (turns, deps) => {
  emitSentinelOnce(deps);

  const heartbeatFiltered: ConversationTurn[] = [];
  for (const t of turns) {
    if (isHeartbeatProbe(t.content)) continue;
    heartbeatFiltered.push(t);
  }

  const failedRetryFiltered = dropFailedThenRetried(heartbeatFiltered);
  const dedupedTools = collapseRepeatedToolCalls(failedRetryFiltered);

  return Object.freeze(dedupedTools);
};

function emitSentinelOnce(deps: ExtractorDeps): void {
  if (TIER4_SENTINEL_FIRED.has(deps.agentName)) return;
  TIER4_SENTINEL_FIRED.add(deps.agentName);
  deps.log.info(
    { agent: deps.agentName, sentinel: "125-02-tier4-drop" },
    "[125-02-tier4-drop] tier4 drop filter active",
  );
}

function dropFailedThenRetried(
  turns: readonly ConversationTurn[],
): ConversationTurn[] {
  const dropIdx = new Set<number>();
  for (let i = 0; i < turns.length; i++) {
    const failed = toolResultName(turns[i].content);
    if (!failed || failed.ok) continue;
    const end = Math.min(turns.length, i + 4);
    for (let j = i + 1; j < end; j++) {
      const later = toolResultName(turns[j].content);
      if (later && later.ok && later.name === failed.name) {
        dropIdx.add(i);
        break;
      }
    }
  }
  return turns.filter((_, idx) => !dropIdx.has(idx));
}

function collapseRepeatedToolCalls(
  turns: readonly ConversationTurn[],
): ConversationTurn[] {
  const seenKeys = new Map<string, number>();
  const firstTurnByKey = new Map<string, ConversationTurn>();

  for (const t of turns) {
    const key = extractToolKey(t.content);
    if (!key) continue;
    const k = `${key.name}::${key.argsHash}`;
    seenKeys.set(k, (seenKeys.get(k) ?? 0) + 1);
    if (!firstTurnByKey.has(k)) firstTurnByKey.set(k, t);
  }

  const kept: ConversationTurn[] = [];
  const inserted = new Set<string>();
  for (const t of turns) {
    const key = extractToolKey(t.content);
    if (!key) {
      kept.push(t);
      continue;
    }
    const k = `${key.name}::${key.argsHash}`;
    const count = seenKeys.get(k) ?? 1;
    if (count <= 1) {
      kept.push(t);
      continue;
    }
    if (inserted.has(k)) continue;
    inserted.add(k);
    const first = firstTurnByKey.get(k) ?? t;
    kept.push(first);
    kept.push(makeCollapseMarker(first, key.name, count));
  }
  return kept;
}
