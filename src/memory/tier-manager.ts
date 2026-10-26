/**
 * TierManager orchestrates all tier transitions for memory storage.
 *
 * Manages the hot tier (promote/demote), the cold tier, legacy cold-file
 * import, and full maintenance cycles.
 *
 * Phase 999.119 (2026-09-05) — cold is a tier INSIDE SQLite, not a
 * markdown file. The previous design (D-14) wrote a `archive/cold/*.md`
 * file and DELETED the row from `memories` + `vec_memories`. Nothing in
 * the runtime ever read those files back (no caller of `rewarmFromCold`
 * outside tests), so "cold" meant "gone from every search path": the
 * agent silently forgot anything not retrieved for ~4 months. fin-research
 * had already lost 118 memories that way. Cold rows now keep their vector
 * and remain searchable (relevance decay already ranks them below fresh
 * memories); they are only excluded from hot promotion and from the
 * auto-linker's candidate scan, and a search/retrieval touch re-warms them
 * lazily on the next cycle.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import { extractWikilinks } from "./graph.js";
import {
  shouldPromoteToHot,
  shouldDemoteToWarm,
  shouldArchiveToCold,
  hasSessionDerivedTag,
} from "./tiers.js";
import type { TierConfig } from "./tiers.js";
import { scoreAndRank, type ScoringConfig } from "./relevance.js";
import type { MemoryStore } from "./store.js";
import type { EmbeddingService } from "./embedder.js";
import type { MemoryEntry, SearchResult } from "./types.js";
import type { Logger } from "pino";

/** Dependencies injected into TierManager for testability. */
export type TierManagerDeps = {
  readonly store: MemoryStore;
  readonly embedder: EmbeddingService;
  readonly memoryDir: string;
  readonly tierConfig: TierConfig;
  readonly scoringConfig: ScoringConfig;
  readonly log: Logger;
  /** Phase 999.119 — stamped on every log line so fleet logs are attributable. */
  readonly agentName?: string;
};

/** Result of a maintenance cycle. */
export type MaintenanceResult = {
  readonly demoted: number;
  readonly archived: number;
  readonly promoted: number;
  /** Phase 999.119 — cold rows brought back to warm because they were used. */
  readonly rewarmed: number;
  /** Phase 999.119 — per-row failures (each isolated; the cycle continues). */
  readonly errors: number;
  readonly firstError: string | null;
};

/** Result of importing legacy `archive/cold/*.md` files back into SQLite. */
export type ColdImportResult = {
  readonly imported: number;
  /** File whose row already exists in the store (file removed). */
  readonly skipped: number;
  readonly failed: number;
  readonly firstError: string | null;
};

/** Least-recently-used warm rows examined per cold pass. */
const COLD_SCAN_LIMIT = 1000;

/** Expected vector width for `vec_memories`. */
const EMBEDDING_DIMS = 384;

const ZERO_MAINTENANCE: MaintenanceResult = Object.freeze({
  demoted: 0,
  archived: 0,
  promoted: 0,
  rewarmed: 0,
  errors: 0,
  firstError: null,
});

/**
 * Convert a Float32Array embedding to a base64 string for cold archival.
 */
export function embeddingToBase64(embedding: Float32Array): string {
  const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  return buffer.toString("base64");
}

/**
 * Convert a base64 string back to a Float32Array embedding.
 *
 * Copies into a fresh, 4-byte-aligned ArrayBuffer: `Buffer.from(base64)`
 * may hand back a slice of Node's shared pool at an arbitrary byte offset,
 * and a Float32Array view over an unaligned offset throws RangeError.
 */
export function base64ToEmbedding(base64: string): Float32Array {
  const bytes = new Uint8Array(Buffer.from(base64, "base64"));
  return new Float32Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 4));
}

/**
 * Generate a filesystem-safe slug from memory content.
 * Takes first 40 chars, lowercases, replaces non-alphanumeric with hyphens, trims hyphens.
 */
export function generateColdSlug(content: string): string {
  const truncated = content.slice(0, 40);
  const slug = truncated
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug;
}

/** Frontmatter written by `exportColdArchive` (and the pre-999.119 archiver). */
type ColdFrontmatter = {
  id: string;
  source: string;
  importance: number;
  access_count: number;
  tags: string[];
  created_at: string;
  updated_at: string;
  accessed_at: string;
  embedding_base64?: string;
};

type ParsedColdArchive = Readonly<{
  frontmatter: ColdFrontmatter;
  content: string;
}>;

/** Parse a cold-archive markdown file: YAML frontmatter + `# Memory:` header + body. */
function parseColdArchive(raw: string, filePath: string): ParsedColdArchive {
  // Parse YAML frontmatter (between first and second ---)
  const parts = raw.split("---");
  if (parts.length < 3) {
    throw new Error(`Invalid cold archive format: ${filePath}`);
  }
  const frontmatter = yamlParse(parts[1]) as ColdFrontmatter;
  if (!frontmatter || typeof frontmatter.id !== "string" || frontmatter.id.length === 0) {
    throw new Error(`Cold archive has no id: ${filePath}`);
  }
  // Extract content from markdown body (after second ---, skip header line)
  const bodyRaw = parts.slice(2).join("---").trim();
  const lines = bodyRaw.split("\n");
  const contentLines = lines.filter((line) => !line.startsWith("# Memory:"));
  const content = contentLines.join("\n").trim();
  return Object.freeze({ frontmatter, content });
}

/**
 * TierManager class orchestrating all tier transitions.
 */
export class TierManager {
  private readonly store: MemoryStore;
  private readonly embedder: EmbeddingService;
  private readonly memoryDir: string;
  private readonly tierConfig: TierConfig;
  private readonly scoringConfig: ScoringConfig;
  private readonly log: Logger;
  private readonly coldDir: string;
  private readonly agentName: string | undefined;

  constructor(deps: TierManagerDeps) {
    this.store = deps.store;
    this.embedder = deps.embedder;
    this.memoryDir = deps.memoryDir;
    this.tierConfig = deps.tierConfig;
    this.scoringConfig = deps.scoringConfig;
    this.log = deps.log;
    this.coldDir = join(deps.memoryDir, "archive", "cold");
    this.agentName = deps.agentName;
  }

  /** Log-context prefix — `{ agent }` when known, `{}` otherwise. */
  private ctx(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return this.agentName ? { agent: this.agentName, ...extra } : extra;
  }

  /**
   * Move a warm memory to the cold tier.
   *
   * Phase 999.119 — the row and its embedding stay in SQLite (see the
   * module doc). Returns true if the row changed tier, false if the store
   * is closed, the row is already cold, or the row no longer exists.
   */
  archiveToCold(entry: MemoryEntry): boolean {
    if (!this.store.isOpen()) return false;
    if (entry.tier === "cold") return false;
    const changed = this.store.updateTier(entry.id, "cold");
    if (changed) {
      this.log.info(this.ctx({ id: entry.id }), "memory moved to cold tier");
    }
    return changed;
  }

  /**
   * Write a memory to `archive/cold/<id>-<slug>.md` in the legacy cold
   * format (YAML frontmatter + base64 embedding) WITHOUT removing it from
   * the store. Operator export path; also what `importColdArchives`
   * reads back. Returns the file path, or null when the memory has no
   * embedding to persist.
   */
  exportColdArchive(entry: MemoryEntry): string | null {
    const embedding = this.store.getEmbedding(entry.id);
    if (!embedding) {
      this.log.warn(this.ctx({ id: entry.id }), "no embedding found for cold export, skipping");
      return null;
    }

    const slug = generateColdSlug(entry.content);
    const fileName = `${entry.id}-${slug}.md`;
    mkdirSync(this.coldDir, { recursive: true });
    const filePath = join(this.coldDir, fileName);

    const frontmatter = {
      id: entry.id,
      source: entry.source,
      importance: entry.importance,
      access_count: entry.accessCount,
      tags: [...entry.tags],
      created_at: entry.createdAt,
      updated_at: entry.updatedAt,
      accessed_at: entry.accessedAt,
      tier: "cold",
      archived_at: new Date().toISOString(),
      embedding_base64: embeddingToBase64(embedding),
    };

    const markdown = `---\n${yamlStringify(frontmatter)}---\n\n# Memory: ${entry.content.slice(0, 80)}\n\n${entry.content}\n`;
    writeFileSync(filePath, markdown, "utf-8");
    return filePath;
  }

  /** True when a memory row with this id exists (no access bump). */
  private rowExists(id: string): boolean {
    return (
      this.store
        .getDatabase()
        .prepare("SELECT 1 FROM memories WHERE id = ?")
        .get(id) !== undefined
    );
  }

  /** Insert a parsed cold archive as a row (memories + vec + wikilinks). */
  private insertFromArchive(
    parsed: ParsedColdArchive,
    embedding: Float32Array,
    tier: "warm" | "cold",
    accessCount: number,
  ): { id: string; now: string } {
    const db = this.store.getDatabase();
    const now = new Date().toISOString();
    const fm = parsed.frontmatter;
    const id = fm.id;

    db.transaction(() => {
      db.prepare(
        `INSERT INTO memories (id, content, source, importance, access_count, tags, created_at, updated_at, accessed_at, tier)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        parsed.content,
        fm.source,
        fm.importance,
        accessCount,
        JSON.stringify(fm.tags ?? []),
        fm.created_at,
        now,
        tier === "warm" ? now : (fm.accessed_at ?? fm.created_at),
        tier,
      );
      db.prepare("INSERT INTO vec_memories (memory_id, embedding) VALUES (?, ?)").run(id, embedding);

      // Re-extract graph edges from the archived content
      const targets = extractWikilinks(parsed.content);
      if (targets.length > 0) {
        const stmts = this.store.getGraphStatements();
        for (const targetId of targets) {
          const exists = stmts.checkMemoryExists.get(targetId);
          if (exists) {
            stmts.insertLink.run(id, targetId, targetId, now);
          }
        }
      }
    })();

    return { id, now };
  }

  /**
   * Re-warm a legacy cold archive file back into SQLite as a warm memory.
   *
   * Reads the archive, re-embeds the content for a fresh vector,
   * inserts with tier='warm', preserves original access_count + 1,
   * and deletes the cold file. If the row already exists in the store
   * (Phase 999.119 in-DB cold, or a crash between export and delete) it
   * is simply set back to warm and the file removed.
   */
  async rewarmFromCold(filePath: string): Promise<MemoryEntry> {
    const parsed = parseColdArchive(readFileSync(filePath, "utf-8"), filePath);
    const fm = parsed.frontmatter;

    if (this.rowExists(fm.id)) {
      this.store.updateTier(fm.id, "warm");
      unlinkSync(filePath);
      this.log.info(this.ctx({ id: fm.id, path: filePath }), "cold archive already in store — set warm, file removed");
      const row = this.store
        .getDatabase()
        .prepare(
          `SELECT id, content, source, importance, access_count, tags, created_at, updated_at, accessed_at, tier, source_turn_ids
           FROM memories WHERE id = ?`,
        )
        .get(fm.id) as {
        id: string; content: string; source: string; importance: number; access_count: number;
        tags: string; created_at: string; updated_at: string; accessed_at: string; tier: string;
        source_turn_ids: string | null;
      };
      return Object.freeze({
        id: row.id,
        content: row.content,
        source: row.source as MemoryEntry["source"],
        importance: row.importance,
        accessCount: row.access_count,
        tags: Object.freeze(JSON.parse(row.tags) as string[]),
        embedding: null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        accessedAt: row.accessed_at,
        tier: "warm" as const,
        sourceTurnIds: row.source_turn_ids ? Object.freeze(JSON.parse(row.source_turn_ids) as string[]) : null,
      });
    }

    // Re-embed for fresh vector
    const embedding = await this.embedder.embed(parsed.content);
    // Access count is archived count + 1 (the search hit that triggered re-warm)
    const accessCount = (fm.access_count ?? 0) + 1;
    const { id, now } = this.insertFromArchive(parsed, embedding, "warm", accessCount);

    unlinkSync(filePath);
    this.log.info(this.ctx({ id, path: filePath }), "memory re-warmed from cold");

    return Object.freeze({
      id,
      content: parsed.content,
      source: fm.source as MemoryEntry["source"],
      importance: fm.importance,
      accessCount,
      tags: Object.freeze([...(fm.tags ?? [])]),
      embedding,
      createdAt: fm.created_at,
      updatedAt: now,
      accessedAt: now,
      tier: "warm" as const,
      sourceTurnIds: null,
    });
  }

  /** Number of legacy `archive/cold/*.md` files still on disk. */
  coldArchiveFileCount(): number {
    if (!existsSync(this.coldDir)) return 0;
    return readdirSync(this.coldDir).filter((f) => f.endsWith(".md")).length;
  }

  /**
   * Phase 999.119 — bring every legacy `archive/cold/*.md` file back into
   * SQLite as a cold-tier row using the embedding stored in the file (no
   * model needed, so this is safe from the CLI). A file whose row already
   * exists is removed as a duplicate. Files that cannot be parsed or carry
   * no usable embedding are left in place and counted as failed.
   */
  importColdArchives(): ColdImportResult {
    if (!existsSync(this.coldDir)) {
      return Object.freeze({ imported: 0, skipped: 0, failed: 0, firstError: null });
    }
    let imported = 0;
    let skipped = 0;
    let failed = 0;
    let firstError: string | null = null;

    const files = readdirSync(this.coldDir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const filePath = join(this.coldDir, file);
      try {
        const parsed = parseColdArchive(readFileSync(filePath, "utf-8"), filePath);
        if (this.rowExists(parsed.frontmatter.id)) {
          unlinkSync(filePath);
          skipped++;
          continue;
        }
        const b64 = parsed.frontmatter.embedding_base64;
        const embedding = b64 ? base64ToEmbedding(b64) : null;
        if (!embedding || embedding.length !== EMBEDDING_DIMS) {
          throw new Error(
            `no usable embedding (${embedding ? embedding.length : 0} dims) in ${file}`,
          );
        }
        this.insertFromArchive(
          parsed,
          embedding,
          "cold",
          parsed.frontmatter.access_count ?? 0,
        );
        unlinkSync(filePath);
        imported++;
      } catch (err) {
        failed++;
        if (firstError === null) {
          firstError = err instanceof Error ? err.message : String(err);
        }
      }
    }

    if (imported > 0 || failed > 0) {
      this.log.info(
        this.ctx({ imported, skipped, failed, firstError }),
        "legacy cold archives imported into the store as cold-tier rows",
      );
    }
    return Object.freeze({ imported, skipped, failed, firstError });
  }

  /**
   * Refresh the hot tier: re-warm used cold rows, demote stale hot
   * memories, promote qualifying warm memories.
   *
   * Selects top hotBudget candidates by combined relevance score.
   */
  refreshHotTier(): { demoted: number; promoted: number; rewarmed: number } {
    // Skip if a concurrent agent stop/restart closed the store. Tier
    // maintenance runs on the heartbeat, independent of the lifecycle lock,
    // so it can race cleanupMemory's store.close(). Nothing to maintain on a
    // closed store.
    if (!this.store.isOpen()) return { demoted: 0, promoted: 0, rewarmed: 0 };
    const now = new Date();
    let demoted = 0;
    let promoted = 0;

    // Step 0 (Phase 999.119): cold rows touched inside the hot-access
    // window were used — bring them back to warm so they can compete for
    // promotion again.
    const windowStart = new Date(
      now.getTime() - this.tierConfig.hotAccessWindowDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    const rewarmed = this.store.rewarmRecentlyAccessedCold(windowStart);
    if (rewarmed > 0) {
      this.log.info(this.ctx({ rewarmed }), "re-warmed recently accessed cold memories");
    }

    // Step 1: Demote stale hot memories back to warm. Memory overhaul
    // 2026-10-25 (WP1): session-derived rows (SESSION_DERIVED_TAGS) are
    // demoted on sight as well, so rows promoted before the promotion
    // scan excluded them free their slots on the next cycle instead of
    // waiting out hotDemotionDays.
    const hotMemories = this.store.listByTier("hot", 1000);
    for (const mem of hotMemories) {
      if (hasSessionDerivedTag(mem.tags)) {
        this.store.updateTier(mem.id, "warm");
        demoted++;
        this.log.info(this.ctx({ id: mem.id }), "demoted hot -> warm (session-derived)");
        continue;
      }
      if (shouldDemoteToWarm(mem.accessedAt, now, this.tierConfig)) {
        this.store.updateTier(mem.id, "warm");
        demoted++;
        this.log.info(this.ctx({ id: mem.id }), "demoted hot -> warm (stale)");
      }
    }

    // Step 2: Get warm candidates that qualify for promotion. Phase
    // 100-fu adds a graph-centrality signal so heavy-linked hubs (e.g.
    // fin-client style nodes referenced by many turn summaries) can
    // promote even when their direct access_count is low.
    //
    // Phase 999.8 follow-up (2026-04-30) — scan window 5000, ordered by
    // backlink_count DESC so hubs surface first when the cap IS reached.
    // Phase 999.119 — the backlink count now rides on the candidate row
    // (one JOIN) instead of one COUNT(*) per candidate.
    // WP1 — the store query already excludes session-derived rows, so
    // neither the access path nor the centrality path can promote them.
    const warmMemories = this.store.listWarmCandidatesForPromotion(5000);
    const qualifyingWarm = warmMemories.filter((mem) =>
      shouldPromoteToHot(
        mem.accessCount,
        mem.accessedAt,
        now,
        this.tierConfig,
        mem.backlinkCount,
      ),
    );

    if (qualifyingWarm.length === 0) {
      return { demoted, promoted, rewarmed };
    }

    // Score qualifying candidates using scoreAndRank
    const searchResults: readonly SearchResult[] = qualifyingWarm.map((mem) =>
      Object.freeze({
        ...mem,
        distance: 0, // Not doing vector search, just scoring by relevance
      }),
    );

    const ranked = scoreAndRank(searchResults, this.scoringConfig, now);

    // Count current hot memories (not demoted)
    const currentHot = this.store.listByTier("hot", 1000);
    const slotsAvailable = Math.max(0, this.tierConfig.hotBudget - currentHot.length);

    // Promote top candidates up to available slots
    const toPromote = ranked.slice(0, slotsAvailable);
    for (const candidate of toPromote) {
      this.store.updateTier(candidate.id, "hot");
      promoted++;
      this.log.info(this.ctx({ id: candidate.id, score: candidate.combinedScore }), "promoted warm -> hot");
    }

    return { demoted, promoted, rewarmed };
  }

  /**
   * Get current hot-tier memories sorted by importance descending.
   * Returns a frozen array of frozen MemoryEntry objects.
   *
   * WP1 — session-derived rows (SESSION_DERIVED_TAGS) are never returned,
   * even when a row still carries tier='hot' from before the promotion
   * scan excluded them; the next refreshHotTier demotes those.
   */
  getHotMemories(): readonly MemoryEntry[] {
    const hot = this.store
      .listByTier("hot", 1000)
      .filter((mem) => !hasSessionDerivedTag(mem.tags));
    const sorted = [...hot].sort((a, b) => b.importance - a.importance);
    return Object.freeze(sorted);
  }

  /**
   * Phase 52 Plan 02 — stable_token for the top-3 hot-tier memories.
   *
   * Returns a deterministic sha256 hex over the sorted `id:accessedAt`
   * signatures of the top-3 hot memories. The context-assembler compares
   * this across turns to decide whether hot-tier enters the cacheable stable
   * prefix (token matches) or falls into the mutable suffix for one turn
   * (token differs from the prior turn's).
   *
   * Empty hot-tier → sha256("") — a known constant that matches the
   * empty-case path used by the assembler.
   */
  getHotMemoriesStableToken(): string {
    const hotMems = this.getHotMemories().slice(0, 3);
    const signature = hotMems
      .map((m) => `${m.id}:${m.accessedAt ?? m.createdAt}`)
      .sort()
      .join("|");
    return createHash("sha256").update(signature, "utf8").digest("hex");
  }

  /**
   * Run a full maintenance cycle: re-warm, demote, cold, promote.
   *
   * Step 0: Re-warm cold rows that were used recently
   * Step 1: Demote stale hot -> warm
   * Step 2: Move decayed, non-hub warm rows -> cold (oldest-accessed first)
   * Step 3: Promote qualifying warm -> hot
   *
   * Phase 999.119 — every per-row operation is isolated: a failure is
   * counted in `errors` (first message kept) and the cycle continues, so
   * one bad row can no longer abort maintenance for the whole agent.
   */
  runMaintenance(): MaintenanceResult {
    // Skip cleanly if a concurrent stop/restart closed the store (heartbeat
    // races the lifecycle close) — avoids "db not open" on the queries below.
    if (!this.store.isOpen()) {
      return ZERO_MAINTENANCE;
    }
    const now = new Date();
    let errors = 0;
    let firstError: string | null = null;
    const record = (err: unknown): void => {
      errors++;
      if (firstError === null) {
        firstError = err instanceof Error ? err.message : String(err);
      }
    };

    // Step 0 + 1 + 3: Refresh hot tier (re-warm, demotion, promotion)
    let hotResult = { demoted: 0, promoted: 0, rewarmed: 0 };
    try {
      hotResult = this.refreshHotTier();
    } catch (err) {
      record(err);
    }

    // Step 2: decayed warm -> cold. Least-recently-used first, and
    // structural hubs (>= centralityPromoteThreshold backlinks) are never
    // cooled — they are the memories the graph walk keeps landing on.
    let archived = 0;
    try {
      const candidates = this.store.listColdArchiveCandidates(COLD_SCAN_LIMIT);
      for (const mem of candidates) {
        if (mem.backlinkCount >= this.tierConfig.centralityPromoteThreshold) continue;
        if (!shouldArchiveToCold(mem.importance, mem.accessedAt, now, this.tierConfig)) continue;
        try {
          if (this.archiveToCold(mem)) archived++;
        } catch (err) {
          record(err);
        }
      }
    } catch (err) {
      record(err);
    }

    // Re-run promotion after the cold pass (warm pool changed)
    let promoResult = { demoted: 0, promoted: 0, rewarmed: 0 };
    try {
      promoResult = this.refreshHotTier();
    } catch (err) {
      record(err);
    }

    this.store.optimize();

    const result: MaintenanceResult = Object.freeze({
      demoted: hotResult.demoted + promoResult.demoted,
      archived,
      promoted: hotResult.promoted + promoResult.promoted,
      rewarmed: hotResult.rewarmed + promoResult.rewarmed,
      errors,
      firstError,
    });
    if (errors > 0) {
      this.log.warn(this.ctx({ ...result }), "maintenance cycle complete with errors");
    } else {
      this.log.info(this.ctx({ ...result }), "maintenance cycle complete");
    }
    return result;
  }
}
