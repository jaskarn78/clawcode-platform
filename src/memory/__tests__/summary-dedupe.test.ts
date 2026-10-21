/**
 * Phase 999.126 — near-duplicate session-summary collapse.
 */

import { describe, it, expect, afterEach } from "vitest";
import { MemoryStore } from "../store.js";
import { ConversationStore } from "../conversation-store.js";
import {
  applySummaryDedupe,
  findSummaryDuplicateGroups,
  wordOverlap,
} from "../summary-dedupe.js";

/** Orthogonal unit vectors (sin-based seeds are all mutually similar; these are not). */
function unit(index: number, lean: { index: number; weight: number } | null = null): Float32Array {
  const v = new Float32Array(384);
  v[index] = 1;
  if (lean) v[lean.index] = lean.weight;
  let norm = 0;
  for (let i = 0; i < 384; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm);
  for (let i = 0; i < 384; i++) v[i] = v[i]! / norm;
  return v;
}

const SUMMARY_A =
  "Client A asked about the Garmin token refresh; we agreed to rotate it before Sept 12 and to log the weekly block on Sundays.";
const SUMMARY_A2 =
  "Client A asked about the Garmin token refresh. We agreed to rotate it before Sept 12 and log the weekly block on Sundays.";
const SUMMARY_B = "Operator reviewed the sump pump wiring diagram and picked the 12V relay for the bedroom AC controller.";

describe("summary dedupe", () => {
  let store: MemoryStore;
  let conv: ConversationStore;

  function setup(): void {
    store = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
    conv = new ConversationStore(store.getDatabase());
  }
  afterEach(() => store?.close());

  function seedSummary(content: string, vec: Float32Array, sessionId: string, importance: number, at: string): string {
    const e = store.insert(
      { content, source: "conversation", importance, tags: ["session-summary", `session:${sessionId}`], skipDedup: true },
      vec,
    );
    store
      .getDatabase()
      .prepare("UPDATE memories SET created_at = ?, updated_at = ?, accessed_at = ? WHERE id = ?")
      .run(at, at, at, e.id);
    const s = conv.startSession("agent-a");
    store
      .getDatabase()
      .prepare("UPDATE conversation_sessions SET id = ?, summary_memory_id = ?, status = 'summarized' WHERE id = ?")
      .run(sessionId, e.id, s.id);
    return e.id;
  }

  it("wordOverlap is Jaccard over 3+ char tokens", () => {
    expect(wordOverlap(SUMMARY_A, SUMMARY_A2)).toBeGreaterThan(0.8);
    expect(wordOverlap(SUMMARY_A, SUMMARY_B)).toBeLessThan(0.2);
    expect(wordOverlap("", "")).toBe(1);
  });

  it("groups near-identical summaries, keeps the most important (then newest) as survivor, ignores distinct ones", () => {
    setup();
    const older = seedSummary(SUMMARY_A, unit(1), "s1", 0.5, "2026-08-01T10:00:00.000Z");
    const newer = seedSummary(SUMMARY_A2, unit(1, { index: 2, weight: 0.1 }), "s2", 0.5, "2026-08-02T10:00:00.000Z");
    const distinct = seedSummary(SUMMARY_B, unit(3), "s3", 0.9, "2026-08-03T10:00:00.000Z");
    // A plain memory with the same vector must never be grouped (not a summary).
    store.insert({ content: SUMMARY_A, source: "manual", importance: 0.5, tags: ["note"], skipDedup: true }, unit(1));

    const preview = findSummaryDuplicateGroups(store);
    expect(preview.summaries).toBe(3);
    expect(preview.groups).toHaveLength(1);
    expect(preview.wouldRemove).toBe(1);
    const g = preview.groups[0]!;
    expect(g.survivor.id).toBe(newer); // equal importance → newest wins
    expect(g.survivor.sessionId).toBe("s2");
    expect(g.duplicates.map((d) => d.id)).toEqual([older]);
    expect(g.duplicates[0]!.similarity).toBeGreaterThan(0.95);
    expect(g.duplicates[0]!.sessionId).toBe("s1");
    expect(preview.groups.some((x) => x.survivor.id === distinct || x.duplicates.some((d) => d.id === distinct))).toBe(false);
  });

  it("the word-overlap guard keeps vector-near but textually different summaries apart", () => {
    setup();
    seedSummary(SUMMARY_A, unit(1), "s1", 0.5, "2026-08-01T10:00:00.000Z");
    seedSummary(SUMMARY_B, unit(1, { index: 2, weight: 0.05 }), "s2", 0.5, "2026-08-02T10:00:00.000Z");
    expect(findSummaryDuplicateGroups(store).groups).toHaveLength(0);
    expect(findSummaryDuplicateGroups(store, { wordOverlapMin: 0 }).groups).toHaveLength(1);
  });

  it("apply re-points sessions and archives at the survivor, unions tags, takes the max importance, deletes the rest", () => {
    setup();
    const older = seedSummary(SUMMARY_A, unit(1), "s1", 0.9, "2026-08-01T10:00:00.000Z");
    const newer = seedSummary(SUMMARY_A2, unit(1, { index: 2, weight: 0.1 }), "s2", 0.5, "2026-08-02T10:00:00.000Z");
    const db = store.getDatabase();
    db.prepare(
      `INSERT INTO session_archive (session_id, agent_name, started_at, ended_at, turn_count, total_tokens, summary_memory_id, archived_at, archived_from, has_untrusted_turn, full_text)
       VALUES ('s2', 'agent-a', '2026-08-02T09:00:00.000Z', '2026-08-02T10:00:00.000Z', 3, 100, ?, '2026-08-02T11:00:00.000Z', 'summary-only', 0, ?)`,
    ).run(newer, SUMMARY_A2);

    const preview = findSummaryDuplicateGroups(store);
    expect(preview.groups[0]!.survivor.id).toBe(older); // higher importance wins
    const result = applySummaryDedupe(store, preview.groups);
    expect(result).toEqual({ groups: 1, removed: 1, repointedSessions: 1, repointedArchives: 1, failed: 0, firstError: null });

    expect(store.getById(newer)).toBeNull();
    const survivor = store.getById(older)!;
    expect([...survivor.tags].sort()).toEqual(["session-summary", "session:s1", "session:s2"]);
    expect(survivor.importance).toBe(0.9);
    expect(conv.getSession("s2")?.summaryMemoryId).toBe(older);
    expect(conv.getSession("s1")?.summaryMemoryId).toBe(older);
    const archive = db.prepare("SELECT summary_memory_id AS id FROM session_archive WHERE session_id = 's2'").get() as { id: string };
    expect(archive.id).toBe(older);
    expect(store.checkIntegrity().fkViolations).toBe(0);
    expect(findSummaryDuplicateGroups(store).groups).toHaveLength(0);
  });
});
