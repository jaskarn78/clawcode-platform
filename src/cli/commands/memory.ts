import type { Command } from "commander";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { ManagerNotRunningError } from "../../shared/errors.js";
import { cliLog, cliError } from "../output.js";
import { registerMemoryBackfillCommand } from "./memory-backfill.js";
import { registerMigrateEmbeddingsCommand } from "./memory-migrate-embeddings.js";

/**
 * A single memory search result from the IPC response.
 */
type SearchResultEntry = {
  readonly id: string;
  readonly content: string;
  readonly source: string;
  readonly importance: number;
  readonly accessCount: number;
  readonly tier: string;
  readonly createdAt: string;
  readonly score: number;
  readonly distance: number;
};

/**
 * Shape of the "memory-search" IPC response.
 */
type MemorySearchResponse = {
  readonly results: readonly SearchResultEntry[];
};

/**
 * A single memory list entry from the IPC response.
 */
type MemoryListEntry = {
  readonly id: string;
  readonly content: string;
  readonly source: string;
  readonly importance: number;
  readonly accessCount: number;
  readonly tier: string;
  readonly createdAt: string;
  readonly accessedAt: string;
};

/**
 * Shape of the "memory-list" IPC response.
 */
type MemoryListResponse = {
  readonly entries: readonly MemoryListEntry[];
};

/** Phase 999.119 — integrity counts as returned by `MemoryStore.checkIntegrity`. */
type DoctorIntegrity = Readonly<{
  danglingLinks: number;
  danglingSessionSummaries: number;
  orphanVecV1: number;
  orphanVecV2: number;
  orphanChunkVecV1: number;
  orphanChunkVecV2: number;
  orphanChunkFts: number;
  fkViolations: number;
  memoriesWithoutEmbedding?: number;
  total: number;
}>;

/** Phase 999.119 pass 2 — conversation-session census. */
type DoctorSessions = Readonly<{
  total: number;
  active: number;
  activeEmpty: number;
  staleActive: number;
  emptyTerminated: number;
}>;

/** Phase 999.119 — one agent's row in the "memory-doctor" IPC response. */
type MemoryDoctorAgentResult = Readonly<{
  agent: string;
  error?: string;
  tierCounts?: Readonly<Record<string, number>>;
  coldFiles?: number;
  before?: DoctorIntegrity;
  sessions?: DoctorSessions | null;
  /** Phase 999.119 v2 switch — read space + v2 backfill gaps. */
  embedding?: Readonly<{
    readVersion: "v1" | "v2";
    memoriesMissingV2: number;
    chunksMissingV2: number;
  }>;
  repaired?: Readonly<{ total: number } & Record<string, number>>;
  coldImport?: Readonly<{
    imported: number;
    skipped: number;
    failed: number;
    firstError: string | null;
  }> | null;
  reembed?: Readonly<{ reembedded: number; failed: number; remaining: number }>;
  sessionsRepair?: Readonly<{ closed: number; pruned: number }> | null;
  after?: DoctorIntegrity;
  /** Phase 999.126 — near-duplicate session-summary groups (preview). */
  dedupe?: Readonly<{
    threshold: number;
    summaries: number;
    wouldRemove: number;
    groups: ReadonlyArray<
      Readonly<{
        survivor: Readonly<{ id: string; createdAt: string; sessionId: string | null; importance: number; preview: string }>;
        duplicates: ReadonlyArray<
          Readonly<{ id: string; createdAt: string; sessionId: string | null; similarity: number; preview: string }>
        >;
      }>
    >;
  }>;
  dedupeApplied?: Readonly<{
    groups: number;
    removed: number;
    repointedSessions: number;
    repointedArchives: number;
    failed: number;
    firstError: string | null;
  }>;
}>;

/** Shape of the "memory-doctor" IPC response. */
type MemoryDoctorResponse = Readonly<{
  results: readonly MemoryDoctorAgentResult[];
  repair: boolean;
  dedupe?: boolean;
  dedupeRun?: boolean;
}>;

const day = (iso: string): string => iso.slice(0, 10);
const shortId = (id: string): string => id.slice(0, 8);

/** One-line issue summary for an integrity census (empty string when clean). */
function describeIntegrity(r: DoctorIntegrity): string {
  const parts: string[] = [];
  if (r.danglingLinks) parts.push(`${r.danglingLinks} dangling link rows`);
  if (r.danglingSessionSummaries) parts.push(`${r.danglingSessionSummaries} sessions pointing at deleted summaries`);
  if (r.orphanVecV1 || r.orphanVecV2) parts.push(`${r.orphanVecV1}/${r.orphanVecV2} orphan vectors (v1/v2)`);
  if (r.orphanChunkVecV1 || r.orphanChunkVecV2) parts.push(`${r.orphanChunkVecV1}/${r.orphanChunkVecV2} orphan chunk vectors (v1/v2)`);
  if (r.orphanChunkFts) parts.push(`${r.orphanChunkFts} orphan chunk FTS rows`);
  if (r.fkViolations) parts.push(`${r.fkViolations} FK violations`);
  return parts.join(", ");
}

/**
 * Render the doctor report as one block per agent. Pure — exported for tests.
 */
export function formatDoctorReport(response: MemoryDoctorResponse): string {
  const lines: string[] = [];
  for (const r of response.results) {
    if (r.error) {
      lines.push(`${r.agent}: ERROR — ${r.error}`);
      continue;
    }
    const tiers = r.tierCounts ?? {};
    const tierText = `hot ${tiers.hot ?? 0} / warm ${tiers.warm ?? 0} / cold ${tiers.cold ?? 0}`;
    const issues = r.before ? describeIntegrity(r.before) : "";
    const coldFiles = r.coldFiles ? `, ${r.coldFiles} legacy cold file(s) on disk` : "";
    lines.push(`${r.agent}: ${tierText}${coldFiles}`);
    lines.push(`  integrity: ${issues.length > 0 ? issues : "clean"}`);
    const noVec = r.before?.memoriesWithoutEmbedding ?? 0;
    if (noVec > 0) {
      lines.push(`  embeddings: ${noVec} memories have no vector (invisible to search until re-embedded)`);
    }
    if (r.sessions) {
      const s = r.sessions;
      lines.push(
        `  sessions: ${s.total} total, ${s.active} active (${s.activeEmpty} empty, ${s.staleActive} older than 24h), ${s.emptyTerminated} empty terminated older than 30d`,
      );
    }
    if (r.embedding) {
      const e = r.embedding;
      const gaps =
        e.memoriesMissingV2 + e.chunksMissingV2 > 0
          ? `; v2 backfill missing ${e.memoriesMissingV2} memories, ${e.chunksMissingV2} chunks`
          : "; v2 coverage complete";
      lines.push(`  embeddings: reads ${e.readVersion}${gaps}`);
    }
    if (response.repair) {
      const fixed = r.repaired?.total ?? 0;
      const imp = r.coldImport;
      const importText = imp
        ? `imported ${imp.imported} cold file(s), ${imp.skipped} duplicate(s) removed, ${imp.failed} failed${imp.firstError ? ` (${imp.firstError})` : ""}`
        : "no tier manager — cold import skipped";
      const afterText = r.after ? describeIntegrity(r.after) : "";
      lines.push(`  repaired: ${fixed} row(s) removed/detached; ${importText}`);
      if (r.reembed) {
        lines.push(
          `  re-embedded: ${r.reembed.reembedded} memories (${r.reembed.failed} failed, ${r.reembed.remaining} remaining)`,
        );
      }
      if (r.sessionsRepair) {
        lines.push(
          `  sessions: closed ${r.sessionsRepair.closed} orphaned active, pruned ${r.sessionsRepair.pruned} empty terminated`,
        );
      }
      lines.push(`  after: ${afterText.length > 0 ? afterText : "clean"}`);
    }
    // Phase 999.126 — summary dedupe preview / result.
    if (r.dedupe) {
      const d = r.dedupe;
      if (d.groups.length === 0) {
        lines.push(`  duplicates: none among ${d.summaries} session summaries (threshold ${d.threshold})`);
      } else {
        lines.push(
          `  duplicates: ${d.groups.length} group(s), ${d.wouldRemove} summary row(s) ${r.dedupeApplied ? "collapsed" : "would be collapsed"} (threshold ${d.threshold}, ${d.summaries} summaries scanned)`,
        );
        for (const g of d.groups.slice(0, 20)) {
          lines.push(`    keep ${day(g.survivor.createdAt)} ${shortId(g.survivor.id)} "${g.survivor.preview}"`);
          for (const dup of g.duplicates) {
            lines.push(
              `      drop ${day(dup.createdAt)} ${shortId(dup.id)} (${dup.similarity.toFixed(3)}) "${dup.preview}"`,
            );
          }
        }
        if (d.groups.length > 20) lines.push(`    … and ${d.groups.length - 20} more group(s)`);
        if (!r.dedupeApplied) lines.push(`    (preview only — re-run with --dedupe --run to apply)`);
      }
      if (r.dedupeApplied) {
        const a = r.dedupeApplied;
        lines.push(
          `  deduped: removed ${a.removed} summary row(s) in ${a.groups} group(s); repointed ${a.repointedSessions} session(s), ${a.repointedArchives} archive row(s)` +
            (a.failed > 0 ? `; ${a.failed} group(s) failed${a.firstError ? ` (${a.firstError})` : ""}` : ""),
        );
      }
    }
  }
  if (lines.length === 0) return "No agents with memory stores";
  return lines.join("\n");
}

/**
 * Truncate a string to maxLen characters, appending "..." if truncated.
 */
function truncate(text: string, maxLen: number): string {
  const singleLine = text.replace(/\n/g, " ").trim();
  if (singleLine.length <= maxLen) {
    return singleLine;
  }
  return singleLine.slice(0, maxLen) + "...";
}

/**
 * Format memory search results as a table.
 *
 * @param data - The memory-search IPC response
 * @returns Formatted table string
 */
export function formatSearchResults(data: MemorySearchResponse): string {
  if (data.results.length === 0) {
    return "No results found";
  }

  const rows = data.results.map((r, i) => ({
    rank: String(i + 1),
    score: r.score.toFixed(3),
    content: truncate(r.content, 60),
    source: r.source,
    tier: r.tier,
    importance: r.importance.toFixed(2),
    created: r.createdAt.slice(0, 10),
  }));

  const rankWidth = 4;
  const scoreWidth = 6;
  const contentWidth = Math.max(7, ...rows.map((r) => r.content.length));
  const sourceWidth = Math.max(6, ...rows.map((r) => r.source.length));
  const tierWidth = 4;
  const impWidth = 4;
  const dateWidth = 10;

  const header = [
    "#".padEnd(rankWidth),
    "SCORE".padEnd(scoreWidth),
    "CONTENT".padEnd(contentWidth),
    "SOURCE".padEnd(sourceWidth),
    "TIER".padEnd(tierWidth),
    "IMP".padEnd(impWidth),
    "CREATED".padEnd(dateWidth),
  ].join("  ");

  const separator = "-".repeat(
    rankWidth + scoreWidth + contentWidth + sourceWidth + tierWidth + impWidth + dateWidth + 12,
  );

  const formatted = rows.map((row) =>
    [
      row.rank.padEnd(rankWidth),
      row.score.padEnd(scoreWidth),
      row.content.padEnd(contentWidth),
      row.source.padEnd(sourceWidth),
      row.tier.padEnd(tierWidth),
      row.importance.padEnd(impWidth),
      row.created.padEnd(dateWidth),
    ].join("  "),
  );

  return ["Memory Search Results", "", header, separator, ...formatted].join("\n");
}

/**
 * Format memory list entries as a table.
 *
 * @param data - The memory-list IPC response
 * @returns Formatted table string
 */
export function formatMemoryList(data: MemoryListResponse): string {
  if (data.entries.length === 0) {
    return "No memories found";
  }

  const rows = data.entries.map((e) => ({
    id: e.id.slice(0, 8),
    content: truncate(e.content, 50),
    tier: e.tier,
    importance: e.importance.toFixed(2),
    accesses: String(e.accessCount),
    accessed: e.accessedAt.slice(0, 10),
  }));

  const idWidth = 8;
  const contentWidth = Math.max(7, ...rows.map((r) => r.content.length));
  const tierWidth = 4;
  const impWidth = 4;
  const accessWidth = 7;
  const dateWidth = 10;

  const header = [
    "ID".padEnd(idWidth),
    "CONTENT".padEnd(contentWidth),
    "TIER".padEnd(tierWidth),
    "IMP".padEnd(impWidth),
    "ACCESSES".padEnd(accessWidth),
    "ACCESSED".padEnd(dateWidth),
  ].join("  ");

  const separator = "-".repeat(
    idWidth + contentWidth + tierWidth + impWidth + accessWidth + dateWidth + 10,
  );

  const formatted = rows.map((row) =>
    [
      row.id.padEnd(idWidth),
      row.content.padEnd(contentWidth),
      row.tier.padEnd(tierWidth),
      row.importance.padEnd(impWidth),
      row.accesses.padEnd(accessWidth),
      row.accessed.padEnd(dateWidth),
    ].join("  "),
  );

  return ["Agent Memories", "", header, separator, ...formatted].join("\n");
}

/**
 * A single episode list entry from the IPC response.
 */
type EpisodeListEntry = {
  readonly id: string;
  readonly content: string;
  readonly importance: number;
  readonly tags: readonly string[];
  readonly tier: string;
  readonly createdAt: string;
};

/**
 * Shape of the "episode-list" IPC response.
 */
type EpisodeListResponse = {
  readonly entries: readonly EpisodeListEntry[];
  readonly count: number;
};

/**
 * Parse the episode title from the structured content format "[Episode: {title}]".
 */
function parseEpisodeTitle(content: string): string {
  const match = content.match(/^\[Episode:\s*(.+?)\]/);
  return match ? match[1] : truncate(content, 40);
}

/**
 * Format episode list entries as a table.
 */
export function formatEpisodeList(data: EpisodeListResponse): string {
  if (data.entries.length === 0) {
    return `No episodes recorded (total: ${data.count})`;
  }

  const rows = data.entries.map((e) => ({
    title: truncate(parseEpisodeTitle(e.content), 40),
    importance: e.importance.toFixed(1),
    tags: (e.tags as readonly string[]).filter((t) => t !== "episode").join(", ") || "-",
    date: e.createdAt.slice(0, 19) + "Z",
  }));

  const titleWidth = Math.max(5, ...rows.map((r) => r.title.length));
  const impWidth = 4;
  const tagsWidth = Math.max(4, ...rows.map((r) => r.tags.length));
  const dateWidth = 20;

  const header = [
    "TITLE".padEnd(titleWidth),
    "IMP".padEnd(impWidth),
    "TAGS".padEnd(tagsWidth),
    "DATE".padEnd(dateWidth),
  ].join("  ");

  const separator = "-".repeat(titleWidth + impWidth + tagsWidth + dateWidth + 6);

  const formatted = rows.map((row) =>
    [
      row.title.padEnd(titleWidth),
      row.importance.padEnd(impWidth),
      row.tags.padEnd(tagsWidth),
      row.date.padEnd(dateWidth),
    ].join("  "),
  );

  return [`Episodes (total: ${data.count})`, "", header, separator, ...formatted].join("\n");
}

/**
 * Register the `clawcode memory` command group.
 * Includes `memory search`, `memory list`, and `memory episodes` subcommands.
 */
export function registerMemoryCommand(program: Command): void {
  const memoryCmd = program
    .command("memory")
    .description("Search and browse agent memory");

  memoryCmd
    .command("search <agent> <query>")
    .description("Semantic search an agent's memory")
    .option("--top-k <n>", "Number of results", "10")
    .action(async (agent: string, query: string, opts: { topK: string }) => {
      try {
        const result = (await sendIpcRequest(SOCKET_PATH, "memory-search", {
          agent,
          query,
          topK: parseInt(opts.topK, 10),
        })) as MemorySearchResponse;
        cliLog(formatSearchResults(result));
      } catch (error) {
        if (error instanceof ManagerNotRunningError) {
          cliError("Manager is not running. Start it with: clawcode start-all");
          process.exit(1);
          return;
        }
        const msg = error instanceof Error ? error.message : String(error);
        cliError(`Error: ${msg}`);
        process.exit(1);
      }
    });

  // Phase 999.113 WS-7 (2026-08-28) — consolidation was reachable only from the
  // 03:00 cron, so it could be neither previewed nor staged, and the run that
  // ARCHIVES (moves) a week of daily logs was invisible until after the fact.
  // Preview is the default; running is an explicit opt-in.
  memoryCmd
    .command("consolidate <agent>")
    .description("Preview (default) or run memory consolidation for one agent")
    .option("--run", "Actually consolidate: write digests and archive the digested daily logs", false)
    .action(async (agent: string, opts: { run: boolean }) => {
      try {
        const r = (await sendIpcRequest(SOCKET_PATH, "consolidate-now", {
          agent,
          run: opts.run === true,
        })) as {
          agent: string;
          memoryDir: string;
          enabled: boolean;
          weeklyThreshold: number;
          ran: boolean;
          weeksPending: Array<{ week: string; period: string; files: number }>;
          weeklyDigestsCreated?: number;
          monthlyDigestsCreated?: number;
          filesArchived?: number;
          errors?: string[];
        };
        const lines: string[] = [
          `Agent:     ${r.agent}`,
          `Memory:    ${r.memoryDir}`,
          `Enabled:   ${r.enabled}  (weeklyThreshold ${r.weeklyThreshold})`,
          `Pending:   ${r.weeksPending.length} week(s)`,
        ];
        for (const w of r.weeksPending) {
          lines.push(`  ${w.week}  ${w.period}  ${w.files} daily log(s)`);
        }
        if (!r.ran) {
          lines.push("", "Preview only — nothing written. Re-run with --run to consolidate.");
        } else {
          lines.push(
            "",
            `Weekly digests:  ${r.weeklyDigestsCreated ?? 0}`,
            `Monthly digests: ${r.monthlyDigestsCreated ?? 0}`,
            `Files archived:  ${r.filesArchived ?? 0}`,
          );
          for (const e of r.errors ?? []) lines.push(`  error: ${e}`);
        }
        cliLog(lines.join("\n"));
      } catch (error) {
        if (error instanceof ManagerNotRunningError) {
          cliError("Manager is not running. Start it with: clawcode start-all");
          process.exit(1);
          return;
        }
        const msg = error instanceof Error ? error.message : String(error);
        cliError(`Error: ${msg}`);
        process.exit(1);
      }
    });

  memoryCmd
    .command("list <agent>")
    .description("List recent memories for an agent")
    .option("--limit <n>", "Number of entries", "20")
    .action(async (agent: string, opts: { limit: string }) => {
      try {
        const result = (await sendIpcRequest(SOCKET_PATH, "memory-list", {
          agent,
          limit: parseInt(opts.limit, 10),
        })) as MemoryListResponse;
        cliLog(formatMemoryList(result));
      } catch (error) {
        if (error instanceof ManagerNotRunningError) {
          cliError("Manager is not running. Start it with: clawcode start-all");
          process.exit(1);
          return;
        }
        const msg = error instanceof Error ? error.message : String(error);
        cliError(`Error: ${msg}`);
        process.exit(1);
      }
    });

  // Phase 90 Plan 07 WIRE-06 — `clawcode memory backfill <agent>` subcommand.
  registerMemoryBackfillCommand(memoryCmd);

  // Phase 115 D-08 — `clawcode memory migrate-embeddings <subcommand>`
  // operator surface for the embedding-v2 (bge-small + int8) migration.
  // Subcommands: status / start / re-embed / pause / resume / force-cutover
  // / rollback / v1-dropped. Backed by IPC methods registered in
  // src/ipc/protocol.ts.
  registerMigrateEmbeddingsCommand(memoryCmd);

  // Phase 107 VEC-CLEAN-03 — `clawcode memory cleanup-orphans [-a <agent>]`
  // operator subcommand. Removes vec_memories rows whose memory_id no
  // longer exists in `memories` (orphans accumulated from historical
  // CHECK-constraint table-recreation migrations or any future delete
  // path that bypasses MemoryStore.delete). Daemon-side:
  // src/manager/daemon.ts case "memory-cleanup-orphans" → per-agent
  // store.cleanupOrphans(). Idempotent; safe to re-run.
  memoryCmd
    .command("cleanup-orphans")
    .description(
      "Remove orphan vec_memories rows whose memory_id no longer exists in memories",
    )
    .option(
      "-a, --agent <name>",
      "Filter to one agent (omit for all agents)",
    )
    .action(async (opts: { agent?: string }) => {
      try {
        const params: Record<string, unknown> = {};
        if (opts.agent) params.agent = opts.agent;
        const result = (await sendIpcRequest(
          SOCKET_PATH,
          "memory-cleanup-orphans",
          params,
        )) as {
          results: ReadonlyArray<{
            agent: string;
            removed: number;
            totalAfter: number;
          }>;
        };
        for (const r of result.results) {
          if (r.totalAfter < 0) {
            cliError(`${r.agent}: cleanup failed`);
          } else if (r.removed === 0) {
            cliLog(
              `${r.agent}: no orphans (${r.totalAfter} vec_memories total)`,
            );
          } else {
            cliLog(
              `${r.agent}: removed ${r.removed} orphans (${r.totalAfter} vec_memories remaining)`,
            );
          }
        }
      } catch (error) {
        if (error instanceof ManagerNotRunningError) {
          cliError(
            "Manager is not running. Start it with: clawcode start-all",
          );
          process.exit(1);
          return;
        }
        const msg = error instanceof Error ? error.message : String(error);
        cliError(`Error: ${msg}`);
        process.exit(1);
      }
    });

  memoryCmd
    .command("doctor")
    .description(
      "Check each agent's memory DB for rows that reference deleted memories (dangling links, orphan vectors, detached session summaries); --repair removes them and re-imports legacy cold-archive files",
    )
    .option("-a, --agent <name>", "Filter to one agent (omit for all agents)")
    .option("--repair", "Remove dangling rows, import cold-archive files, optimize")
    .option(
      "--dedupe",
      "Preview near-duplicate session-summary groups (vector similarity + word overlap); nothing is removed",
    )
    .option("--run", "With --dedupe: collapse the groups (re-points sessions at the survivor, deletes the rest)")
    .option("--threshold <n>", "With --dedupe: vector similarity threshold, 0.8-1 (default 0.95)")
    .option("--json", "Print the raw IPC response")
    .action(async (opts: { agent?: string; repair?: boolean; dedupe?: boolean; run?: boolean; threshold?: string; json?: boolean }) => {
      try {
        const params: Record<string, unknown> = {};
        if (opts.agent) params.agent = opts.agent;
        if (opts.repair) params.repair = true;
        if (opts.dedupe) params.dedupe = true;
        if (opts.dedupe && opts.run) params.dedupeRun = true;
        if (opts.threshold !== undefined) {
          const t = Number(opts.threshold);
          if (!Number.isFinite(t) || t < 0.8 || t > 1) {
            cliError("--threshold must be a number between 0.8 and 1");
            process.exit(1);
            return;
          }
          params.dedupeThreshold = t;
        }
        const response = (await sendIpcRequest(
          SOCKET_PATH,
          "memory-doctor",
          params,
        )) as MemoryDoctorResponse;
        if (opts.json) {
          cliLog(JSON.stringify(response, null, 2));
          return;
        }
        cliLog(formatDoctorReport(response));
      } catch (error) {
        if (error instanceof ManagerNotRunningError) {
          cliError(
            "Manager is not running. Start it with: clawcode start-all",
          );
          process.exit(1);
          return;
        }
        const msg = error instanceof Error ? error.message : String(error);
        cliError(`Error: ${msg}`);
        process.exit(1);
      }
    });

  memoryCmd
    .command("episodes <agent>")
    .description("List recent episodes for an agent")
    .option("--count", "Show episode count only")
    .option("--limit <n>", "Number of entries", "10")
    .action(async (agent: string, opts: { count?: boolean; limit: string }) => {
      try {
        const result = (await sendIpcRequest(SOCKET_PATH, "episode-list", {
          agent,
          limit: parseInt(opts.limit, 10),
        })) as EpisodeListResponse;

        if (opts.count) {
          cliLog(`Episodes: ${result.count}`);
          return;
        }

        if (result.entries.length === 0) {
          cliLog(`No episodes recorded for ${agent}`);
          return;
        }

        cliLog(formatEpisodeList(result));
      } catch (error) {
        if (error instanceof ManagerNotRunningError) {
          cliError("Manager is not running. Start it with: clawcode start-all");
          process.exit(1);
          return;
        }
        const msg = error instanceof Error ? error.message : String(error);
        cliError(`Error: ${msg}`);
        process.exit(1);
      }
    });
}
