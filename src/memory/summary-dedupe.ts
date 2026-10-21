/**
 * Phase 999.126 — collapse near-duplicate session summaries.
 *
 * WHY. Every session end (and every crash recovery, and every re-summarise
 * after a restart) writes a `session-summary` memory. Over months the same
 * conversation ends up summarised two or three times, and a routine day
 * produces summaries that differ only in the date. The insert-time dedup
 * (`checkForDuplicate`, 0.85 on v1) never sees them: session summaries are
 * inserted with `skipDedup` so a summary is never merged into an unrelated
 * memory. The result is a `conversations` search where the top five hits
 * are the same week said five ways.
 *
 * WHAT. `findSummaryDuplicateGroups` walks the summaries, asks the v1 KNN
 * for each one's neighbours among the OTHER summaries, and forms groups
 * (union-find) from pairs that clear BOTH a vector similarity threshold
 * (default 0.95) and a word-overlap guard (Jaccard ≥ 0.5), so two
 * genuinely different days that merely share a routine are never
 * collapsed. `applySummaryDedupe` keeps one survivor per group (highest
 * importance, then newest), re-points every `conversation_sessions` and
 * `session_archive` row at it, unions the tags (so the collapsed sessions'
 * `session:<id>` tags stay findable), and deletes the rest through the
 * FK-safe `store.delete`.
 *
 * The doctor exposes this as a PREVIEW by default; nothing is removed
 * until the operator passes `--run`.
 */

import type { MemoryStore } from "./store.js";

export const DEFAULT_SUMMARY_DEDUPE_THRESHOLD = 0.95;
export const SUMMARY_WORD_OVERLAP_MIN = 0.5;
/** Neighbours asked of the KNN per summary (self + up to five candidates). */
const KNN_K = 6;
const PREVIEW_CHARS = 100;

export interface SummaryDuplicate {
  readonly id: string;
  readonly createdAt: string;
  readonly sessionId: string | null;
  readonly similarity: number;
  readonly preview: string;
}

export interface SummaryDuplicateGroup {
  readonly survivor: Readonly<{
    id: string;
    createdAt: string;
    sessionId: string | null;
    importance: number;
    preview: string;
  }>;
  readonly duplicates: readonly SummaryDuplicate[];
}

export interface SummaryDedupePreview {
  readonly threshold: number;
  readonly summaries: number;
  readonly groups: readonly SummaryDuplicateGroup[];
  readonly wouldRemove: number;
}

export interface SummaryDedupeResult {
  readonly groups: number;
  readonly removed: number;
  readonly repointedSessions: number;
  readonly repointedArchives: number;
  readonly failed: number;
  readonly firstError: string | null;
}

export interface FindSummaryDuplicatesOptions {
  readonly threshold?: number;
  readonly wordOverlapMin?: number;
}

function sessionIdOf(tags: readonly string[]): string | null {
  const tag = tags.find((t) => t.startsWith("session:"));
  return tag ? tag.slice("session:".length) : null;
}

function previewOf(content: string): string {
  const line = content.replace(/\s+/g, " ").trim();
  return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS - 1)}…` : line;
}

const WORD = /[\p{L}\p{N}]{3,}/gu;

/** Jaccard overlap of the two texts' word sets (3+ char tokens, lowercased). */
export function wordOverlap(a: string, b: string): number {
  const wa = new Set((a.toLowerCase().match(WORD) ?? []));
  const wb = new Set((b.toLowerCase().match(WORD) ?? []));
  if (wa.size === 0 && wb.size === 0) return 1;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter += 1;
  const union = wa.size + wb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Minimal union-find over string ids. */
class Groups {
  private readonly parent = new Map<string, string>();
  find(x: string): string {
    let root = x;
    while (this.parent.get(root) !== undefined && this.parent.get(root) !== root) {
      root = this.parent.get(root)!;
    }
    // Path compression.
    let cur = x;
    while (cur !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
  add(x: string): void {
    if (!this.parent.has(x)) this.parent.set(x, x);
  }
}

/**
 * Find the groups of near-duplicate session summaries. Read-only.
 * Uses the v1 vector space (the dedup space; every memory has a v1 row).
 */
export function findSummaryDuplicateGroups(
  store: MemoryStore,
  options: FindSummaryDuplicatesOptions = {},
): SummaryDedupePreview {
  const threshold = options.threshold ?? DEFAULT_SUMMARY_DEDUPE_THRESHOLD;
  const overlapMin = options.wordOverlapMin ?? SUMMARY_WORD_OVERLAP_MIN;
  const summaries = store.findByTag("session-summary");
  const byId = new Map(summaries.map((m) => [m.id, m]));
  const groups = new Groups();
  const bestSimilarity = new Map<string, number>();

  for (const m of summaries) {
    groups.add(m.id);
    const vec = store.getEmbedding(m.id);
    if (!vec) continue;
    for (const hit of store.searchMemoriesVec(vec, KNN_K)) {
      if (hit.memory_id === m.id) continue;
      const other = byId.get(hit.memory_id);
      if (!other) continue; // not a summary
      const similarity = 1 - hit.distance;
      if (similarity < threshold) continue;
      if (wordOverlap(m.content, other.content) < overlapMin) continue;
      groups.add(other.id);
      groups.union(m.id, other.id);
      const key = [m.id, other.id].sort().join("|");
      bestSimilarity.set(key, Math.max(bestSimilarity.get(key) ?? 0, similarity));
    }
  }

  const members = new Map<string, string[]>();
  for (const m of summaries) {
    const root = groups.find(m.id);
    members.set(root, [...(members.get(root) ?? []), m.id]);
  }

  const out: SummaryDuplicateGroup[] = [];
  for (const ids of members.values()) {
    if (ids.length < 2) continue;
    const entries = ids.map((id) => byId.get(id)!);
    // Survivor: highest importance, then newest.
    const [survivor, ...rest] = [...entries].sort((a, b) => {
      if (b.importance !== a.importance) return b.importance - a.importance;
      return b.createdAt.localeCompare(a.createdAt);
    });
    const duplicates = rest
      .map((d) => {
        const key = [survivor!.id, d.id].sort().join("|");
        return Object.freeze({
          id: d.id,
          createdAt: d.createdAt,
          sessionId: sessionIdOf(d.tags),
          similarity: bestSimilarity.get(key) ?? threshold,
          preview: previewOf(d.content),
        });
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    out.push(
      Object.freeze({
        survivor: Object.freeze({
          id: survivor!.id,
          createdAt: survivor!.createdAt,
          sessionId: sessionIdOf(survivor!.tags),
          importance: survivor!.importance,
          preview: previewOf(survivor!.content),
        }),
        duplicates: Object.freeze(duplicates),
      }),
    );
  }
  out.sort((a, b) => b.duplicates.length - a.duplicates.length || b.survivor.createdAt.localeCompare(a.survivor.createdAt));

  return Object.freeze({
    threshold,
    summaries: summaries.length,
    groups: Object.freeze(out),
    wouldRemove: out.reduce((n, g) => n + g.duplicates.length, 0),
  });
}

/**
 * Collapse the groups: re-point sessions and archive rows at the survivor,
 * union the tags, take the max importance, delete the duplicates. One
 * transaction per group so a failure leaves the other groups applied and
 * this one untouched.
 */
export function applySummaryDedupe(
  store: MemoryStore,
  groups: readonly SummaryDuplicateGroup[],
): SummaryDedupeResult {
  const db = store.getDatabase();
  const repointSessions = db.prepare(
    "UPDATE conversation_sessions SET summary_memory_id = ? WHERE summary_memory_id = ?",
  );
  const repointArchive = db.prepare(
    "UPDATE session_archive SET summary_memory_id = ? WHERE summary_memory_id = ?",
  );
  const readTags = db.prepare("SELECT tags, importance FROM memories WHERE id = ?");
  const writeTags = db.prepare(
    "UPDATE memories SET tags = ?, importance = ?, updated_at = ? WHERE id = ?",
  );

  let applied = 0;
  let removed = 0;
  let repointedSessions = 0;
  let repointedArchives = 0;
  let failed = 0;
  let firstError: string | null = null;

  for (const group of groups) {
    try {
      db.transaction(() => {
        const survivorRow = readTags.get(group.survivor.id) as
          | { tags: string; importance: number }
          | undefined;
        if (!survivorRow) throw new Error(`survivor ${group.survivor.id} no longer exists`);
        const tags = new Set<string>(JSON.parse(survivorRow.tags) as string[]);
        let importance = survivorRow.importance;
        for (const dup of group.duplicates) {
          const dupRow = readTags.get(dup.id) as { tags: string; importance: number } | undefined;
          if (!dupRow) continue; // already gone
          for (const t of JSON.parse(dupRow.tags) as string[]) tags.add(t);
          importance = Math.max(importance, dupRow.importance);
          repointedSessions += repointSessions.run(group.survivor.id, dup.id).changes;
          try {
            repointedArchives += repointArchive.run(group.survivor.id, dup.id).changes;
          } catch {
            /* a bare DB without session_archive */
          }
          if (store.delete(dup.id)) removed += 1;
        }
        writeTags.run(
          JSON.stringify([...tags]),
          importance,
          new Date().toISOString(),
          group.survivor.id,
        );
      })();
      applied += 1;
    } catch (err) {
      failed += 1;
      firstError ??= err instanceof Error ? err.message : String(err);
    }
  }

  return Object.freeze({
    groups: applied,
    removed,
    repointedSessions,
    repointedArchives,
    failed,
    firstError,
  });
}
