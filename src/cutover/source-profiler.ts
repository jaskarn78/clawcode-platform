/**
 * Phase 92 Plan 01 — Source-agent behavior profiler (D-11 amended).
 *
 * Reads BOTH staging JSONLs (mc-history.jsonl + discord-history.jsonl)
 * produced by the ingestors, deduplicates across origins via the
 * discriminated-union key, runs ONE OR MORE TurnDispatcher.dispatch
 * passes (chunked by ≤30-day windows when entries > 50000), and merges
 * the partial AgentProfile outputs into a single deterministic
 * AGENT-PROFILE.json.
 *
 * Pure DI module — `deps.dispatcher` is `Pick<TurnDispatcher, "dispatch">`.
 * Tests pass `vi.fn(async () => CANONICAL_PROFILE_TEXT)`. Production wires
 * the real TurnDispatcher constructed at daemon boot.
 *
 * D-11 invariants:
 *   - Reads N JSONL paths (mc + discord), not a single path
 *   - Dedup keys are origin-specific:
 *       (origin="mc",      sessionId, sequenceIndex)
 *       (origin="discord", channel_id, message_id)
 *   - Cron-prefixed intents (LLM emits "cron:<intent>" for MC entries
 *     where kind==="cron") are preserved through merge — see P-CRON test
 *   - Output is byte-deterministic: sorted keys via replacer, sorted
 *     arrays, count-summed topIntents sorted by count DESC then intent
 *     alphabetical
 *
 * Output: <outputDir>/AGENT-PROFILE.json (atomic temp+rename).
 */

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Logger } from "pino";
import type { TurnOrigin } from "../manager/turn-origin.js";
import { makeRootOrigin } from "../manager/turn-origin.js";
import {
  agentProfileSchema,
  historyEntrySchema,
  PROFILER_CHUNK_THRESHOLD_MSGS,
  type AgentProfile,
  type HistoryEntry,
  type ProfileOutcome,
} from "./types.js";

/**
 * The narrowed dispatcher surface the profiler needs. Mirrors
 * TurnDispatcher.dispatch signature:
 *   dispatch(origin, agentName, message, options?) → Promise<string>
 *
 * Tests stub via `vi.fn(async () => string)` — argument shape is enforced
 * by structural typing only, so tests can pass anything that returns a
 * Promise<string>.
 */
export type ProfilerDispatchFn = (
  origin: TurnOrigin,
  agentName: string,
  message: string,
  options?: unknown,
) => Promise<string>;

export type ProfileDeps = {
  /** ClawCode agent name (e.g. "fin-client") — used in the outcome + prompt context. */
  readonly agent: string;
  /**
   * Array of staging JSONL paths to read. Typically:
   *   [<staging>/mc-history.jsonl, <staging>/discord-history.jsonl]
   * Missing files are silently skipped (the source corpus is the union of
   * whichever files exist).
   */
  readonly historyJsonlPaths: readonly string[];
  /** Output directory for AGENT-PROFILE.json. Created if missing. */
  readonly outputDir: string;
  /** TurnDispatcher (or a structural test stub) — dispatch() called once per chunk. */
  readonly dispatcher: { dispatch: ProfilerDispatchFn };
  /** Profiler agent name (default: "clawdy"). */
  readonly profilerAgent?: string;
  /** Override the chunk threshold (default: PROFILER_CHUNK_THRESHOLD_MSGS=50000). Tests use small values. */
  readonly chunkThresholdMsgs?: number;
  readonly log: Logger;
};

const PROFILER_SYSTEM_PROMPT = `You are a behavior profiler. Read this conversation history (entries from EITHER OpenClaw Mission Control sessions [origin:"mc"] OR Discord channels [origin:"discord"]) and emit a single JSON object with EXACTLY these 7 keys:
- tools: string[] (tool names invoked)
- skills: string[] (skill names referenced)
- mcpServers: string[] (MCP server names invoked)
- memoryRefs: string[] (memory file paths referenced)
- models: string[] (model identifiers used; for mc entries the per-turn model field is authoritative)
- uploads: string[] (filenames of attachments shared)
- topIntents: {intent: string, count: number}[] (top user intents by frequency)

For mc entries with kind:"cron", cluster their intents UNDER THE SAME prefix "cron:<intent-name>" — these are scheduled-runner intents and must be visible separately from user-initiated intents.

Output ONLY the JSON, no prose. Use sorted arrays. topIntents sorted by count DESC.`;

/**
 * Run one profile cycle. Returns a ProfileOutcome — never throws in the
 * happy path. Dispatcher errors and schema-validation failures are
 * surfaced as outcome variants so the CLI wrapper can map them to exit
 * codes without unwinding.
 */
export async function runSourceProfiler(deps: ProfileDeps): Promise<ProfileOutcome> {
  const start = new Date();

  // Read all configured JSONLs (mc + discord) and dedup via origin-specific
  // key. Files that don't exist are silently skipped — the union shrinks
  // when --source was single-sided.
  const seen = new Set<string>();
  const entries: HistoryEntry[] = [];
  for (const path of deps.historyJsonlPaths) {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      continue; // ENOENT — single-source ingest scenario
    }
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(line);
      } catch {
        continue; // Malformed line — skip
      }
      const parsed = historyEntrySchema.safeParse(parsedJson);
      if (!parsed.success) continue;
      const e = parsed.data;
      const key =
        e.origin === "mc"
          ? `mc:${e.sessionId}:${e.sequenceIndex}`
          : `discord:${e.channel_id}:${e.message_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(e);
    }
  }

  if (entries.length === 0) {
    return {
      kind: "no-history",
      agent: deps.agent,
      jsonlPaths: deps.historyJsonlPaths,
    };
  }

  // Sort by ts ASC for chronological chunking. Immutability: in-place sort
  // on the local array is safe — the array was constructed locally above.
  entries.sort((a, b) => a.ts.localeCompare(b.ts));

  const threshold = deps.chunkThresholdMsgs ?? PROFILER_CHUNK_THRESHOLD_MSGS;
  const chunks: HistoryEntry[][] =
    entries.length <= threshold ? [entries] : chunkBy30DayWindows(entries);

  const partials: AgentProfile[] = [];
  for (const chunk of chunks) {
    const prompt = PROFILER_SYSTEM_PROMPT + "\n\n" + buildChunkPrompt(chunk);
    const origin = makeRootOrigin("scheduler", `cutover-profiler:${deps.agent}`);
    let response: string;
    try {
      response = await deps.dispatcher.dispatch(
        origin,
        deps.profilerAgent ?? "clawdy",
        prompt,
      );
    } catch (err) {
      return {
        kind: "dispatcher-failed",
        agent: deps.agent,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start.getTime(),
      };
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(extractJsonObject(response));
    } catch (err) {
      return {
        kind: "schema-validation-failed",
        agent: deps.agent,
        error: err instanceof Error ? err.message : String(err),
        rawResponse: response.slice(0, 4000),
      };
    }
    const parsed = agentProfileSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return {
        kind: "schema-validation-failed",
        agent: deps.agent,
        error: parsed.error.message,
        rawResponse: response.slice(0, 4000),
      };
    }
    partials.push(parsed.data);
  }

  const merged = mergeProfiles(partials);

  await mkdir(deps.outputDir, { recursive: true });
  const outPath = join(deps.outputDir, "AGENT-PROFILE.json");
  const json = JSON.stringify(merged, sortedKeysReplacer(), 2);
  const tmp = `${outPath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, json, "utf8");
  await rename(tmp, outPath);

  return {
    kind: "profiled",
    agent: deps.agent,
    chunksProcessed: chunks.length,
    messagesProcessed: entries.length,
    profilePath: outPath,
    durationMs: Date.now() - start.getTime(),
  };
}

/**
 * Split entries into chunks bounded by ≤30-day windows starting at the
 * first entry's timestamp. New chunk begins as soon as an entry is more
 * than 30 days after the current window's start.
 *
 * Pre-condition: `entries` sorted by ts ASC.
 */
function chunkBy30DayWindows(entries: readonly HistoryEntry[]): HistoryEntry[][] {
  const WINDOW_MS = 30 * 86400 * 1000;
  const chunks: HistoryEntry[][] = [];
  let current: HistoryEntry[] = [];
  let windowStart =
    entries[0]?.ts !== undefined ? new Date(entries[0].ts).getTime() : Date.now();
  for (const e of entries) {
    const t = new Date(e.ts).getTime();
    if (t - windowStart > WINDOW_MS && current.length > 0) {
      chunks.push(current);
      current = [];
      windowStart = t;
    }
    current.push(e);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Render a chunk of entries as a single-line-per-entry prompt body. The
 * leading prefix (`mc ` or `discord `) is what the test (P2) asserts on
 * to confirm the LLM sees both origins.
 */
function buildChunkPrompt(chunk: readonly HistoryEntry[]): string {
  const lines = chunk.map((e) => {
    if (e.origin === "mc") {
      return `[${e.ts}] mc session=${e.sessionId} kind=${e.kind} role=${e.role}: ${e.content}`;
    }
    return `[${e.ts}] discord channel=${e.channel_id} author=${e.author_name ?? e.author_id}: ${e.content}`;
  });
  return "Messages:\n" + lines.join("\n");
}

/**
 * Extract a JSON object from a possibly-fenced LLM response. If the
 * response is wrapped in ```json ... ``` fences, return the inner; else
 * return the whole text trimmed.
 */
function extractJsonObject(text: string): string {
  const fence = text.match(/```(?:json)?\s*\n([\s\S]+?)\n```/);
  return (fence?.[1] ?? text).trim();
}

/**
 * Merge N AgentProfile partials. String arrays are unioned + sorted.
 * topIntents are count-summed across partials, then sorted by count DESC
 * (ties broken by intent alphabetical), then truncated to top 20.
 *
 * Cron-prefixed intents (e.g. "cron:acme-db-sync") are preserved
 * verbatim — they sort alongside non-cron intents by count, so a cron
 * intent with count > a direct intent will appear above it (per P-CRON
 * canonical ordering).
 */
function mergeProfiles(parts: readonly AgentProfile[]): AgentProfile {
  const u = (k: keyof AgentProfile): string[] =>
    [...new Set(parts.flatMap((p) => p[k] as string[]))].sort();

  const intentCounts = new Map<string, number>();
  for (const p of parts) {
    for (const ti of p.topIntents) {
      intentCounts.set(ti.intent, (intentCounts.get(ti.intent) ?? 0) + ti.count);
    }
  }

  return {
    tools: u("tools"),
    skills: u("skills"),
    mcpServers: u("mcpServers"),
    memoryRefs: u("memoryRefs"),
    models: u("models"),
    uploads: u("uploads"),
    topIntents: [...intentCounts.entries()]
      .map(([intent, count]) => ({ intent, count }))
      .sort((a, b) => b.count - a.count || a.intent.localeCompare(b.intent))
      .slice(0, 20),
  };
}

/**
 * JSON.stringify replacer that sorts object keys lexicographically. Pure
 * — never mutates the input. Required for the P-DET byte-determinism
 * invariant — without sorted keys, JSON.stringify's output order depends
 * on insertion order which varies between merge runs.
 */
function sortedKeysReplacer(): (key: string, value: unknown) => unknown {
  return (_key, value) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value as object).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return value;
  };
}
