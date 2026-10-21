/**
 * Phase 115 sub-scope 13(b) — consolidation run-log tests.
 *
 * Verifies:
 *   - appendConsolidationRun writes a JSONL row to a temp dir
 *   - listRecentConsolidationRuns reads all rows when present
 *   - listRecentConsolidationRuns returns [] when file is absent (ENOENT)
 *   - Append + list round-trips multiple rows in order
 *   - Robust against a non-JSON line in the middle of the file
 *   - errors[] strings >200 chars are truncated to 200 chars at write time
 *   - limit parameter returns most-recent N
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendConsolidationRun,
  listRecentConsolidationRuns,
  type ConsolidationRunRow,
} from "../consolidation-run-log.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "phase115-runlog-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function row(overrides: Partial<ConsolidationRunRow> = {}): ConsolidationRunRow {
  return {
    run_id: "run-id-default",
    target_agents: ["agent-a"],
    memories_added: 0,
    status: "started",
    errors: [],
    started_at: "2026-05-08T00:00:00.000Z",
    ...overrides,
  };
}

describe("consolidation-run-log", () => {
  it("appendConsolidationRun writes a JSONL row to the override dir", async () => {
    await appendConsolidationRun(row({ run_id: "r1" }), tmpDir);
    const rows = await listRecentConsolidationRuns(50, tmpDir);
    expect(rows).toHaveLength(1);
    expect(rows[0].run_id).toBe("r1");
  });

  it("listRecentConsolidationRuns returns [] when file is absent", async () => {
    const rows = await listRecentConsolidationRuns(50, tmpDir);
    expect(rows).toEqual([]);
  });

  it("round-trips multiple rows in append order", async () => {
    await appendConsolidationRun(row({ run_id: "r1", status: "started" }), tmpDir);
    await appendConsolidationRun(
      row({ run_id: "r1", status: "completed", memories_added: 5 }),
      tmpDir,
    );
    await appendConsolidationRun(row({ run_id: "r2", status: "started" }), tmpDir);
    const rows = await listRecentConsolidationRuns(50, tmpDir);
    expect(rows.map((r) => `${r.run_id}/${r.status}`)).toEqual([
      "r1/started",
      "r1/completed",
      "r2/started",
    ]);
  });

  it("is robust against a non-JSON line in the middle of the file", async () => {
    // Pre-create dir + write a malformed line BETWEEN two valid rows.
    mkdirSync(tmpDir, { recursive: true });
    const file = join(tmpDir, "consolidation-runs.jsonl");
    writeFileSync(
      file,
      `${JSON.stringify(row({ run_id: "r1" }))}\nNOT-JSON-LINE\n${JSON.stringify(row({ run_id: "r2" }))}\n`,
      "utf8",
    );
    const rows = await listRecentConsolidationRuns(50, tmpDir);
    expect(rows.map((r) => r.run_id)).toEqual(["r1", "r2"]);
  });

  it("truncates errors[] strings to 200 chars at write time", async () => {
    const longError = "x".repeat(500);
    await appendConsolidationRun(
      row({ run_id: "r-long", status: "failed", errors: [longError] }),
      tmpDir,
    );
    const rows = await listRecentConsolidationRuns(50, tmpDir);
    expect(rows[0].errors[0]).toBe("x".repeat(200));
  });

  it("limit parameter returns the most-recent N rows", async () => {
    for (let i = 1; i <= 10; i++) {
      await appendConsolidationRun(
        row({
          run_id: `r${i}`,
          status: "started",
          started_at: `2026-05-08T00:00:0${i}.000Z`,
        }),
        tmpDir,
      );
    }
    const rows = await listRecentConsolidationRuns(3, tmpDir);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.run_id)).toEqual(["r8", "r9", "r10"]);
  });

  it("creates parent dirs recursively when override dir does not yet exist", async () => {
    const nested = join(tmpDir, "deep", "nested", "path");
    await appendConsolidationRun(row({ run_id: "deep" }), nested);
    const rows = await listRecentConsolidationRuns(50, nested);
    expect(rows).toHaveLength(1);
    expect(rows[0].run_id).toBe("deep");
  });
});
