/**
 * Phase 91 Plan 02 Task 1 — conflict-detector tests (SYNC-06).
 *
 * Pins the pure-function decision matrix from conflict-detector.ts:
 *
 *   C1: First-ever sync (no baseline entry) → CLEAN
 *   C2: destHash === lastWritten[path] + sourceHash drifted → CLEAN
 *   C3: destHash !== lastWritten[path] + sourceHash unchanged → CONFLICT
 *       (the "operator-only edit" case; safer reading of D-11)
 *   C4: Both sides drifted from last-written → CONFLICT
 *   C5: destHash === null (file missing on dest) → CLEAN
 *   C6: Mixed candidate set — verify correct partitioning
 *   C7: detectedAt timestamp uses the `now` argument (deterministic)
 *   C8: Returned result + nested objects are frozen (immutability contract)
 *   C9: PROPERTY: for any (baseline, candidates, now), every candidate path
 *       appears in EXACTLY ONE of cleanFiles or conflicts (the partition
 *       invariant). Hand-rolled randomized check — 200 iterations.
 */

import { describe, it, expect } from "vitest";
import {
  detectConflicts,
  type FileHashPair,
} from "../conflict-detector.js";

const FIXED_NOW = new Date("2026-04-24T20:00:00.000Z");

// ---------------------------------------------------------------------------
// C1: First-ever sync — no entry in lastWrittenHashes
// ---------------------------------------------------------------------------

describe("detectConflicts — first-ever sync (C1)", () => {
  it("classifies a never-synced path as CLEAN", () => {
    const result = detectConflicts(
      {}, // empty baseline
      [
        {
          path: "memory/2026-04-24.md",
          sourceHash: "aaa111",
          destHash: null,
        },
      ],
      FIXED_NOW,
    );
    expect(result.cleanFiles).toEqual(["memory/2026-04-24.md"]);
    expect(result.conflicts).toHaveLength(0);
  });

  it("stays CLEAN even if a dest file already exists but has no baseline", () => {
    // Edge: a file exists on dest without us having written it (manually
    // placed). No baseline → first-ever-sync rule wins; rsync will produce
    // the drift on the NEXT cycle after this one is recorded.
    const result = detectConflicts(
      {},
      [{ path: "manual.md", sourceHash: "a1", destHash: "b2" }],
      FIXED_NOW,
    );
    expect(result.cleanFiles).toEqual(["manual.md"]);
    expect(result.conflicts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// C2: destHash === lastWritten — CLEAN regardless of source drift
// ---------------------------------------------------------------------------

describe("detectConflicts — dest untouched since last write (C2)", () => {
  it("classifies dest-unchanged as CLEAN when source drifted", () => {
    const result = detectConflicts(
      { "MEMORY.md": "WRITTEN" },
      [{ path: "MEMORY.md", sourceHash: "NEW_SRC", destHash: "WRITTEN" }],
      FIXED_NOW,
    );
    expect(result.cleanFiles).toEqual(["MEMORY.md"]);
    expect(result.conflicts).toHaveLength(0);
  });

  it("classifies dest-unchanged as CLEAN when source unchanged (no-op case)", () => {
    const result = detectConflicts(
      { "SOUL.md": "WRITTEN" },
      [{ path: "SOUL.md", sourceHash: "WRITTEN", destHash: "WRITTEN" }],
      FIXED_NOW,
    );
    expect(result.cleanFiles).toEqual(["SOUL.md"]);
    expect(result.conflicts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// C3: destHash drifted, sourceHash unchanged → CONFLICT (safer reading of D-11)
// ---------------------------------------------------------------------------

describe("detectConflicts — operator-only edit, safer D-11 reading (C3)", () => {
  it("classifies operator-only-edit as CONFLICT (prevents silent clobber)", () => {
    const result = detectConflicts(
      { "MEMORY.md": "WRITTEN" },
      [
        {
          path: "MEMORY.md",
          sourceHash: "WRITTEN", // source unchanged since last sync
          destHash: "OPERATOR_EDIT",
        },
      ],
      FIXED_NOW,
    );
    expect(result.cleanFiles).toHaveLength(0);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      path: "MEMORY.md",
      sourceHash: "WRITTEN",
      destHash: "OPERATOR_EDIT",
      resolvedAt: null,
    });
  });
});

// ---------------------------------------------------------------------------
// C4: both sides drifted from last-written → CONFLICT
// ---------------------------------------------------------------------------

describe("detectConflicts — both sides drifted (C4)", () => {
  it("classifies both-sides-drifted as CONFLICT with both hashes recorded", () => {
    const result = detectConflicts(
      { "memory/procedures/newsletter.md": "WRITTEN" },
      [
        {
          path: "memory/procedures/newsletter.md",
          sourceHash: "NEW_SRC",
          destHash: "NEW_DEST",
        },
      ],
      FIXED_NOW,
    );
    expect(result.cleanFiles).toHaveLength(0);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      path: "memory/procedures/newsletter.md",
      sourceHash: "NEW_SRC",
      destHash: "NEW_DEST",
      resolvedAt: null,
    });
  });
});

// ---------------------------------------------------------------------------
// C5: destHash === null (deleted on dest side) → CLEAN
// ---------------------------------------------------------------------------

describe("detectConflicts — dest file deleted (C5)", () => {
  it("classifies dest-null as CLEAN even with a baseline entry", () => {
    // Operator deleted the file on ClawCode side. D-12 treats this as
    // a re-sync signal, not a conflict. rsync will re-create from source.
    const result = detectConflicts(
      { "memory/old.md": "WRITTEN" },
      [{ path: "memory/old.md", sourceHash: "WRITTEN", destHash: null }],
      FIXED_NOW,
    );
    expect(result.cleanFiles).toEqual(["memory/old.md"]);
    expect(result.conflicts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// C6: Mixed candidate set — verify partitioning
// ---------------------------------------------------------------------------

describe("detectConflicts — mixed candidates (C6)", () => {
  it("correctly partitions a mix of CLEAN and CONFLICT cases", () => {
    const baseline: Record<string, string> = {
      "MEMORY.md": "H_MEM",
      "SOUL.md": "H_SOUL",
      "memory/a.md": "H_A",
      "memory/b.md": "H_B",
    };
    const candidates: FileHashPair[] = [
      // first-ever → CLEAN
      { path: "new.md", sourceHash: "SRC_NEW", destHash: null },
      // dest-unchanged → CLEAN
      { path: "MEMORY.md", sourceHash: "SRC_MEM_V2", destHash: "H_MEM" },
      // operator-only edit → CONFLICT
      { path: "SOUL.md", sourceHash: "H_SOUL", destHash: "H_SOUL_OPED" },
      // both sides drifted → CONFLICT
      { path: "memory/a.md", sourceHash: "NEW_SRC_A", destHash: "NEW_DEST_A" },
      // dest-null → CLEAN
      { path: "memory/b.md", sourceHash: "H_B_V2", destHash: null },
    ];
    const result = detectConflicts(baseline, candidates, FIXED_NOW);
    // Copy before sort — result.cleanFiles is frozen.
    expect([...result.cleanFiles].sort()).toEqual(
      ["MEMORY.md", "memory/b.md", "new.md"].sort(),
    );
    expect(result.conflicts.map((c) => c.path).sort()).toEqual(
      ["SOUL.md", "memory/a.md"].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// C7: detectedAt uses the `now` argument
// ---------------------------------------------------------------------------

describe("detectConflicts — detectedAt is deterministic (C7)", () => {
  it("uses the `now` argument for detectedAt (not wall-clock)", () => {
    const customNow = new Date("1999-12-31T23:59:59.999Z");
    const result = detectConflicts(
      { "x.md": "BASE" },
      [{ path: "x.md", sourceHash: "SRC", destHash: "DRIFT" }],
      customNow,
    );
    expect(result.conflicts[0]?.detectedAt).toBe(
      "1999-12-31T23:59:59.999Z",
    );
  });
});

// ---------------------------------------------------------------------------
// C8: immutability
// ---------------------------------------------------------------------------

describe("detectConflicts — immutable returns (C8)", () => {
  it("freezes the result + inner arrays + inner conflict objects", () => {
    const result = detectConflicts(
      { "x.md": "BASE" },
      [{ path: "x.md", sourceHash: "SRC", destHash: "DRIFT" }],
      FIXED_NOW,
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.cleanFiles)).toBe(true);
    expect(Object.isFrozen(result.conflicts)).toBe(true);
    expect(Object.isFrozen(result.conflicts[0])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C9: PROPERTY — every candidate appears exactly once in the output partition
// ---------------------------------------------------------------------------

describe("detectConflicts — partition invariant (C9)", () => {
  it("partitions candidates such that each path appears EXACTLY once", () => {
    // Hand-rolled pseudo-random property check. 200 rounds is more than
    // enough for this decision matrix — only 4 branches per candidate.
    let seed = 0x13579bdf;
    const rand = () => {
      // xorshift32
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0x100000000;
    };

    for (let iter = 0; iter < 200; iter++) {
      const candidateCount = Math.floor(rand() * 20) + 1;
      const baseline: Record<string, string> = {};
      const candidates: FileHashPair[] = [];

      for (let i = 0; i < candidateCount; i++) {
        const path = `file-${iter}-${i}.md`;
        // Decide randomly whether the path has a baseline entry.
        const hasBaseline = rand() < 0.7;
        if (hasBaseline) baseline[path] = `B${i}`;

        // Decide destHash: sometimes null, sometimes equal to baseline,
        // sometimes drifted.
        const destChoice = rand();
        let destHash: string | null;
        if (destChoice < 0.25) destHash = null;
        else if (hasBaseline && destChoice < 0.6) destHash = `B${i}`;
        else destHash = `D${i}_${iter}`;

        // Source hash is independent — sometimes matches baseline,
        // sometimes drifts.
        const sourceHash =
          rand() < 0.5 && hasBaseline ? `B${i}` : `S${i}_${iter}`;
        candidates.push({ path, sourceHash, destHash });
      }

      const result = detectConflicts(baseline, candidates, FIXED_NOW);
      // Copy to mutable arrays (result.cleanFiles is frozen).
      const allOutputs = [
        ...result.cleanFiles,
        ...result.conflicts.map((c) => c.path),
      ];
      const inputPaths = candidates.map((c) => c.path);
      // Same length — no dupes, no drops.
      expect(allOutputs).toHaveLength(inputPaths.length);
      // Same set.
      expect(allOutputs.slice().sort()).toEqual(inputPaths.slice().sort());
      // No overlap.
      const cleanSet = new Set(result.cleanFiles);
      for (const c of result.conflicts) {
        expect(cleanSet.has(c.path)).toBe(false);
      }
    }
  });
});
