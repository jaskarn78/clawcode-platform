/**
 * Phase 999.113 WS-6 — dream run-log tests.
 *
 * Verifies:
 *   - appendDreamRun + listRecentDreamRuns round-trip via the dirOverride seam
 *   - listRecentDreamRuns returns [] when the file is absent (ENOENT)
 *   - tail-bounded read: a file larger than the 64 KiB window still lists
 *     the most-recent rows (and never the oldest ones)
 *   - corrupt (non-JSON) lines are skipped without breaking neighbors
 *   - appendDreamRun NEVER throws when the target dir is unwritable
 *   - `reason` is truncated to 300 chars at the writer
 *
 * Fixtures are fully synthetic — plain agent names + placeholder reasons,
 * nothing secret-shaped.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendDreamRun,
  listRecentDreamRuns,
  DREAM_RUN_REASON_MAX_LENGTH,
  type DreamRunRow,
} from "../dream-run-log.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ws6-dreamrunlog-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function row(overrides: Partial<DreamRunRow> = {}): DreamRunRow {
  return {
    run_id: "run-default",
    agent: "agent-a",
    status: "applied",
    started_at: "2026-08-28T00:00:00.000Z",
    duration_ms: 1234,
    ...overrides,
  };
}

describe("dream-run-log", () => {
  it("appendDreamRun + listRecentDreamRuns round-trips via dirOverride", async () => {
    await appendDreamRun(
      row({ run_id: "r1", status: "applied", wikilinks_added: 3 }),
      tmpDir,
    );
    await appendDreamRun(
      row({ run_id: "r2", status: "failed", reason: "parse-failed: boom" }),
      tmpDir,
    );
    const rows = await listRecentDreamRuns(50, tmpDir);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      run_id: "r1",
      agent: "agent-a",
      status: "applied",
      wikilinks_added: 3,
      duration_ms: 1234,
    });
    expect(rows[1]).toMatchObject({
      run_id: "r2",
      status: "failed",
      reason: "parse-failed: boom",
    });
  });

  it("returns [] when the file is absent (ENOENT)", async () => {
    const rows = await listRecentDreamRuns(50, tmpDir);
    expect(rows).toEqual([]);
  });

  it("tail-bounds the read on a file larger than the window", async () => {
    // Build a file well past the 64 KiB tail window: 2000 rows at ~120
    // bytes each ≈ 240 KiB. The reader must return the NEWEST rows only
    // and must not choke on starting mid-line.
    mkdirSync(tmpDir, { recursive: true });
    const file = join(tmpDir, "dream-runs.jsonl");
    const lines: string[] = [];
    for (let i = 0; i < 2000; i++) {
      lines.push(JSON.stringify(row({ run_id: `run-${i}` })));
    }
    writeFileSync(file, lines.join("\n") + "\n");

    const rows = await listRecentDreamRuns(50, tmpDir);
    expect(rows).toHaveLength(50);
    // Most-recent 50 = run-1950 .. run-1999, in order.
    expect(rows[0]!.run_id).toBe("run-1950");
    expect(rows[49]!.run_id).toBe("run-1999");
    // Nothing from the truncated head of the file.
    expect(rows.some((r) => r.run_id === "run-0")).toBe(false);
  });

  it("skips corrupt lines without losing the neighbors", async () => {
    mkdirSync(tmpDir, { recursive: true });
    const file = join(tmpDir, "dream-runs.jsonl");
    writeFileSync(
      file,
      `${JSON.stringify(row({ run_id: "r1" }))}\n{not-json\n${JSON.stringify(row({ run_id: "r2" }))}\n`,
    );
    const rows = await listRecentDreamRuns(50, tmpDir);
    expect(rows.map((r) => r.run_id)).toEqual(["r1", "r2"]);
  });

  it("appendDreamRun never throws when the dir is unwritable", async () => {
    const lockedDir = join(tmpDir, "locked");
    mkdirSync(lockedDir, { recursive: true });
    chmodSync(lockedDir, 0o444); // read-only — appendFile will EACCES
    try {
      await expect(
        appendDreamRun(row({ run_id: "r-unwritable" }), lockedDir),
      ).resolves.toBeUndefined();
    } finally {
      chmodSync(lockedDir, 0o755); // restore so afterEach rmSync succeeds
    }
  });

  it("truncates reason to the 300-char bound at write time", async () => {
    const longReason = "x".repeat(DREAM_RUN_REASON_MAX_LENGTH + 100);
    await appendDreamRun(
      row({ run_id: "r-long", status: "failed", reason: longReason }),
      tmpDir,
    );
    const rows = await listRecentDreamRuns(50, tmpDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toHaveLength(DREAM_RUN_REASON_MAX_LENGTH);
  });

  it("respects the limit parameter (most-recent N)", async () => {
    for (let i = 0; i < 5; i++) {
      await appendDreamRun(row({ run_id: `r${i}` }), tmpDir);
    }
    const rows = await listRecentDreamRuns(2, tmpDir);
    expect(rows.map((r) => r.run_id)).toEqual(["r3", "r4"]);
  });
});
