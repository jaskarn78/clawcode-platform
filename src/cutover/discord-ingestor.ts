/**
 * Phase 92 Plan 01 — Discord history ingestor.
 *
 * Paginates `plugin:discord:fetch_messages` across the channels declared
 * in `agents[name].channels[]` for an agent and emits a JSONL staging
 * file at `<stagingDir>/discord-history.jsonl`. Idempotent by Discord
 * `message_id` (D-01 + Phase 80 origin_id pattern — re-running across
 * the same channels never duplicates lines).
 *
 * Pure DI module — see `IngestDeps`. Production wraps `deps.fetchMessages`
 * around the SDK MCP tool; tests pass `vi.fn()` with canned pages. The
 * ingestor itself imports zero SDK code and never calls `process.exit` —
 * those concerns belong to the CLI wrapper in
 * `src/cli/commands/cutover-ingest.ts`.
 *
 * Pagination contract (D-Claude's-Discretion):
 *   - Discord page size: 100 messages per request
 *   - Inter-request sleep: 500ms BETWEEN requests (not before first, not
 *     after last). Honored by tests pinning sleep call count = pages-1.
 *   - Depth caps: `--depth-msgs N` is the binding cap; `--depth-days`
 *     accepted for forward-compat (logging only — Plan 92-04+ enforces).
 */
import { mkdir, readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import {
  discordHistoryEntrySchema,
  type DiscordHistoryEntry,
  type DiscordIngestOutcome,
} from "./types.js";

/** Discord-page-size constant pinned per D-Claude's-Discretion. */
const DISCORD_PAGE_SIZE = 100;
/** Inter-request sleep budget per D-Claude's-Discretion. */
const DISCORD_INTER_REQUEST_SLEEP_MS = 500;
/** Default cap when caller doesn't pass `--depth-msgs`. */
const DEFAULT_DEPTH_MSGS = 10000;

/**
 * Production wires this around `plugin:discord:fetch_messages`. Pages are
 * returned in whatever order the underlying tool produces; the ingestor
 * sorts by `ts` ASC before write so JSONL is always oldest→newest.
 */
export type DiscordFetchMessagesFn = (args: {
  chat_id: string;
  before?: string;
  limit: number;
}) => Promise<{ messages: readonly DiscordHistoryEntry[]; hasMore: boolean }>;

export type DiscordIngestDeps = {
  readonly agent: string;
  readonly channels: readonly string[];
  readonly stagingDir: string;
  readonly depthMsgs?: number;
  readonly depthDays?: number; // accepted for forward-compat; not enforced this plan
  readonly fetchMessages: DiscordFetchMessagesFn;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
  readonly log: Logger;
};

/**
 * Backwards-compatibility alias. Discord-only callers may continue importing
 * `IngestDeps`; new callers (post D-11) prefer the explicit
 * `DiscordIngestDeps` name to disambiguate from the MC ingestor's deps.
 */
export type IngestDeps = DiscordIngestDeps;

/**
 * Run one ingest cycle. Always returns a `DiscordIngestOutcome`; never
 * throws in the happy path. Discord-fetch errors are caught and surfaced
 * as `{kind: "discord-fetch-failed"}` so the CLI wrapper can map them to
 * an exit code without unwinding the stack.
 *
 * D-11: each emitted JSONL entry carries `origin: "discord"` (injected
 * pre-parse) so the profiler can discriminate when reading the merged
 * mc + discord corpus. The dedup key remains `message_id` per Phase 80
 * origin_id idempotency convention.
 */
export async function ingestDiscordHistory(deps: DiscordIngestDeps): Promise<DiscordIngestOutcome> {
  const startMs = (deps.now ?? (() => new Date()))().getTime();

  if (deps.channels.length === 0) {
    return { kind: "no-channels", agent: deps.agent };
  }

  await mkdir(deps.stagingDir, { recursive: true });
  const jsonlPath = join(deps.stagingDir, "discord-history.jsonl");
  const sleep = deps.sleep ?? defaultSleep;

  // Read existing JSONL into a Set for dedup on rerun (Phase 80 origin_id).
  const existingIds = new Set<string>();
  try {
    const existing = await readFile(jsonlPath, "utf8");
    for (const line of existing.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const entry = JSON.parse(line) as { message_id?: unknown };
        if (typeof entry.message_id === "string") {
          existingIds.add(entry.message_id);
        }
      } catch {
        // Malformed line — skip silently; idempotency is best-effort.
      }
    }
  } catch {
    // ENOENT — first run, nothing to dedup against.
  }

  const depthMsgs = deps.depthMsgs ?? DEFAULT_DEPTH_MSGS;
  const newEntries: DiscordHistoryEntry[] = [];
  let totalNew = 0;
  let totalSeen = existingIds.size;
  let channelsProcessed = 0;

  for (const channelId of deps.channels) {
    let before: string | undefined = undefined;
    let fetchedThisChannel = 0;
    let firstRequest = true;

    // Per-channel pagination loop. Bounded by:
    //   1. Empty page (no more history)
    //   2. depthMsgs cap reached for this channel
    //   3. fetchMessages throws (returns failure outcome)
    while (true) {
      if (!firstRequest) {
        await sleep(DISCORD_INTER_REQUEST_SLEEP_MS);
      }
      firstRequest = false;

      const remaining = Math.max(0, depthMsgs - fetchedThisChannel);
      if (remaining === 0) break;
      const limit = Math.min(DISCORD_PAGE_SIZE, remaining);

      let page;
      try {
        page = await deps.fetchMessages({ chat_id: channelId, before, limit });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          kind: "discord-fetch-failed",
          agent: deps.agent,
          channelId,
          error: msg,
          durationMs: Date.now() - startMs,
        };
      }

      if (page.messages.length === 0) break;

      for (const raw of page.messages) {
        // D-11: inject origin literal pre-parse so the schema's
        // discriminated union (historyEntrySchema) can narrow on it
        // when the profiler reads the JSONL back.
        const candidate = { origin: "discord" as const, ...(raw as Record<string, unknown>) };
        const parsed = discordHistoryEntrySchema.safeParse(candidate);
        if (!parsed.success) continue;
        if (existingIds.has(parsed.data.message_id)) continue;
        existingIds.add(parsed.data.message_id);
        newEntries.push(parsed.data);
        totalNew += 1;
        totalSeen += 1;
      }

      fetchedThisChannel += page.messages.length;

      // Stop conditions:
      //   - Server says no more history.
      //   - Page came back smaller than asked-for limit (Discord's signal
      //     that we're at the tail of history).
      if (!page.hasMore || page.messages.length < limit) break;
      before = page.messages[page.messages.length - 1]?.message_id;
    }

    channelsProcessed += 1;
  }

  if (totalNew === 0) {
    return {
      kind: "no-changes",
      agent: deps.agent,
      totalMessages: totalSeen,
      durationMs: Date.now() - startMs,
      jsonlPath,
    };
  }

  // Sort oldest→newest by ts before append for deterministic JSONL ordering.
  // Immutability rule (CLAUDE.md): never mutate the input array — spread first.
  const sorted = [...newEntries].sort((a, b) => a.ts.localeCompare(b.ts));
  const jsonlChunk = sorted.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await appendFile(jsonlPath, jsonlChunk, "utf8");

  return {
    kind: "ingested",
    agent: deps.agent,
    channelsProcessed,
    newMessages: totalNew,
    totalMessages: totalSeen,
    durationMs: Date.now() - startMs,
    jsonlPath,
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
