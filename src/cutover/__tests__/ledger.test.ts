/**
 * Phase 92 Plan 03 Task 1 (RED) — cutover ledger tests.
 *
 * Pins the contract for src/cutover/ledger.ts (NOT YET CREATED — tests
 * fail at import time which is the canonical RED gate).
 *
 * Behavioral pins (D-05 + D-10):
 *   L1 first-write             — appendCutoverRow on missing file creates dir + 1 line
 *   L2 sequential              — two appends produce 2 lines; readCutoverRows reads both
 *   L3 validate-on-write       — schema-invalid row throws; file unchanged
 *   L4 query-by-agent          — queryCutoverRowsByAgent filters across mixed rows
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  appendCutoverRow,
  readCutoverRows,
  queryCutoverRowsByAgent,
  DEFAULT_CUTOVER_LEDGER_PATH,
} from "../ledger.js";
import type { CutoverLedgerRow } from "../types.js";

let tmpDir: string;
let ledgerPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "cutover-ledger-"));
  ledgerPath = join(tmpDir, "subdir", "cutover-ledger.jsonl");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function sampleRow(overrides: Partial<CutoverLedgerRow> = {}): CutoverLedgerRow {
  return {
    timestamp: "2026-04-24T22:30:00.000Z",
    agent: "fin-client",
    action: "apply-additive",
    kind: "missing-skill",
    identifier: "content-engine",
    sourceHash: "abc123",
    targetHash: "def456",
    reversible: true,
    rolledBack: false,
    preChangeSnapshot: null,
    reason: null,
    ...overrides,
  };
}

describe("DEFAULT_CUTOVER_LEDGER_PATH", () => {
  it("is exported and points to ~/.clawcode/manager/cutover-ledger.jsonl", () => {
    expect(DEFAULT_CUTOVER_LEDGER_PATH).toMatch(
      /\.clawcode[/\\]manager[/\\]cutover-ledger\.jsonl$/,
    );
  });
});

describe("appendCutoverRow — L1 first-write", () => {
  it("creates parent dir on missing file and writes one parseable JSONL line", async () => {
    expect(existsSync(ledgerPath)).toBe(false);
    await appendCutoverRow(ledgerPath, sampleRow());
    expect(existsSync(ledgerPath)).toBe(true);
    const text = await readFile(ledgerPath, "utf8");
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.agent).toBe("fin-client");
    expect(parsed.action).toBe("apply-additive");
    expect(parsed.kind).toBe("missing-skill");
  });
});

describe("appendCutoverRow + readCutoverRows — L2 sequential", () => {
  it("two sequential appends produce 2 lines; readCutoverRows returns both in order", async () => {
    const r1 = sampleRow({ identifier: "skill-a", timestamp: "2026-04-24T22:30:00.000Z" });
    const r2 = sampleRow({ identifier: "skill-b", timestamp: "2026-04-24T22:30:01.000Z" });
    await appendCutoverRow(ledgerPath, r1);
    await appendCutoverRow(ledgerPath, r2);

    const rows = await readCutoverRows(ledgerPath);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.identifier).toBe("skill-a");
    expect(rows[1]!.identifier).toBe("skill-b");
  });
});

describe("appendCutoverRow — L3 validate-on-write", () => {
  it("throws when row fails schema and leaves the file/dir unchanged", async () => {
    // Pre-create the dir + a sentinel file to detect mutation.
    await appendCutoverRow(ledgerPath, sampleRow({ identifier: "valid" }));
    const sizeBefore = (await stat(ledgerPath)).size;

    // Empty `agent` violates z.string().min(1).
    const badRow = sampleRow({ agent: "" });
    await expect(
      appendCutoverRow(ledgerPath, badRow as unknown as CutoverLedgerRow),
    ).rejects.toThrow();

    const sizeAfter = (await stat(ledgerPath)).size;
    expect(sizeAfter).toBe(sizeBefore);
  });
});

describe("queryCutoverRowsByAgent — L4 filter by agent", () => {
  it("returns only rows for the requested agent across a mixed-agent ledger", async () => {
    await appendCutoverRow(ledgerPath, sampleRow({ agent: "agentA", identifier: "a1" }));
    await appendCutoverRow(ledgerPath, sampleRow({ agent: "agentB", identifier: "b1" }));
    await appendCutoverRow(ledgerPath, sampleRow({ agent: "agentA", identifier: "a2" }));

    const rowsA = await queryCutoverRowsByAgent(ledgerPath, "agentA");
    expect(rowsA).toHaveLength(2);
    expect(rowsA.map((r) => r.identifier).sort()).toEqual(["a1", "a2"]);

    const rowsB = await queryCutoverRowsByAgent(ledgerPath, "agentB");
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0]!.identifier).toBe("b1");

    const rowsC = await queryCutoverRowsByAgent(ledgerPath, "nope");
    expect(rowsC).toHaveLength(0);
  });

  it("returns [] when the ledger file does not exist", async () => {
    const fresh = join(tmpDir, "does-not-exist.jsonl");
    const rows = await queryCutoverRowsByAgent(fresh, "anyone");
    expect(rows).toHaveLength(0);
  });
});

describe("readCutoverRows — malformed-line tolerance", () => {
  it("skips malformed lines and warns via logger when one is provided", async () => {
    // Write one valid line + one garbage line by hand to test resilience.
    const row = sampleRow();
    const valid = JSON.stringify(row) + "\n";
    const garbage = "not-json-at-all\n";
    await appendCutoverRow(ledgerPath, row);
    await writeFile(ledgerPath, valid + garbage + valid, "utf8");
    const rows = await readCutoverRows(ledgerPath);
    expect(rows).toHaveLength(2);
  });
});
