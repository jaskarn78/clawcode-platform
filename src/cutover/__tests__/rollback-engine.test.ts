/**
 * Phase 92 GAP CLOSURE — rollback engine LIFO rewind tests.
 *
 * Pins:
 *   RB1: LIFO order — newest applied row reverts first
 *   RB2: Idempotency — re-running rollback over already-rewound rows
 *        yields zero new reverts
 *   RB3: Filters by agent + ledgerTo (older rows untouched)
 *   RB4: Destructive snapshot restore — gunzip+base64 round-trip
 *   RB5: Append-only — every revert appends a NEW rollback row with
 *        reason="rollback-of:<origTimestamp>"
 *   RB6: dryRun=true → no filesystem mutations + no ledger appends, but
 *        rewoundCount still reflects what WOULD be rewound
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import type { Logger } from "pino";

import {
  runRollbackEngine,
  ROLLBACK_OF_REASON_PREFIX,
  type RollbackEngineDeps,
  type YamlWriteOutcome,
} from "../rollback-engine.js";
import { appendCutoverRow } from "../ledger.js";
import type { CutoverLedgerRow } from "../types.js";

const silentLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => silentLog,
} as unknown as Logger;

describe("rollback-engine LIFO rewind (gap closure)", () => {
  let tempDir: string;
  let ledgerPath: string;
  let memoryRoot: string;
  let uploadsTargetDir: string;
  let skillsTargetDir: string;
  let clawcodeYamlPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rollback-engine-"));
    ledgerPath = join(tempDir, "cutover-ledger.jsonl");
    memoryRoot = join(tempDir, "memory");
    uploadsTargetDir = join(tempDir, "uploads", "discord");
    skillsTargetDir = join(tempDir, "skills");
    clawcodeYamlPath = join(tempDir, "clawcode.yaml");
    await mkdir(memoryRoot, { recursive: true });
    await mkdir(uploadsTargetDir, { recursive: true });
    await mkdir(skillsTargetDir, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  function makeDeps(
    overrides: Partial<RollbackEngineDeps> = {},
  ): RollbackEngineDeps {
    const ok: YamlWriteOutcome = { kind: "updated" };
    return {
      agent: "fin-client",
      ledgerTo: "2026-04-01T00:00:00Z",
      ledgerPath,
      clawcodeYamlPath,
      memoryRoot,
      uploadsTargetDir,
      skillsTargetDir,
      dryRun: false,
      removeAgentSkill: vi.fn(async () => ok),
      removeAgentAllowedModel: vi.fn(async () => ok),
      log: silentLog,
      ...overrides,
    };
  }

  it("RB1: reverts newest applied row first (LIFO)", async () => {
    // Three rows in chronological order; rollback should reverse them
    // newest-first.
    const rows: CutoverLedgerRow[] = [
      {
        timestamp: "2026-04-10T00:00:00.000Z",
        agent: "fin-client",
        action: "apply-additive",
        kind: "missing-memory-file",
        identifier: "memory/a.md",
        sourceHash: null,
        targetHash: null,
        reversible: true,
        rolledBack: false,
        preChangeSnapshot: null,
        reason: null,
      },
      {
        timestamp: "2026-04-15T00:00:00.000Z",
        agent: "fin-client",
        action: "apply-additive",
        kind: "missing-memory-file",
        identifier: "memory/b.md",
        sourceHash: null,
        targetHash: null,
        reversible: true,
        rolledBack: false,
        preChangeSnapshot: null,
        reason: null,
      },
      {
        timestamp: "2026-04-20T00:00:00.000Z",
        agent: "fin-client",
        action: "apply-additive",
        kind: "missing-memory-file",
        identifier: "memory/c.md",
        sourceHash: null,
        targetHash: null,
        reversible: true,
        rolledBack: false,
        preChangeSnapshot: null,
        reason: null,
      },
    ];
    for (const r of rows) await appendCutoverRow(ledgerPath, r);

    // Create the target files so unlink succeeds.
    for (const id of ["memory/a.md", "memory/b.md", "memory/c.md"]) {
      const p = join(memoryRoot, id);
      await mkdir(join(memoryRoot, "memory"), { recursive: true });
      await writeFile(p, "x");
    }

    const unlinkOrder: string[] = [];
    const result = await runRollbackEngine(
      makeDeps({
        unlinkFile: async (p) => {
          unlinkOrder.push(p);
        },
      }),
    );

    expect(result.rewoundCount).toBe(3);
    // LIFO: c → b → a
    expect(unlinkOrder.map((p) => p.split("/").pop())).toEqual([
      "c.md",
      "b.md",
      "a.md",
    ]);
  });

  it("RB2: idempotency — second run is a no-op", async () => {
    const row: CutoverLedgerRow = {
      timestamp: "2026-04-15T00:00:00.000Z",
      agent: "fin-client",
      action: "apply-additive",
      kind: "missing-memory-file",
      identifier: "memory/x.md",
      sourceHash: null,
      targetHash: null,
      reversible: true,
      rolledBack: false,
      preChangeSnapshot: null,
      reason: null,
    };
    await appendCutoverRow(ledgerPath, row);

    const r1 = await runRollbackEngine(
      makeDeps({ unlinkFile: async () => undefined }),
    );
    expect(r1.rewoundCount).toBe(1);

    const r2 = await runRollbackEngine(
      makeDeps({ unlinkFile: async () => undefined }),
    );
    expect(r2.rewoundCount).toBe(0);
    expect(r2.skippedAlreadyRewound).toBe(1);
  });

  it("RB3: filters by agent + ledgerTo (older rows untouched)", async () => {
    const rows: CutoverLedgerRow[] = [
      // OLDER than ledgerTo → should NOT be rewound
      {
        timestamp: "2026-03-15T00:00:00.000Z",
        agent: "fin-client",
        action: "apply-additive",
        kind: "missing-memory-file",
        identifier: "memory/old.md",
        sourceHash: null,
        targetHash: null,
        reversible: true,
        rolledBack: false,
        preChangeSnapshot: null,
        reason: null,
      },
      // Different agent → should NOT be rewound
      {
        timestamp: "2026-04-15T00:00:00.000Z",
        agent: "other-agent",
        action: "apply-additive",
        kind: "missing-memory-file",
        identifier: "memory/other.md",
        sourceHash: null,
        targetHash: null,
        reversible: true,
        rolledBack: false,
        preChangeSnapshot: null,
        reason: null,
      },
      // MATCHES → should be rewound
      {
        timestamp: "2026-04-15T00:00:00.000Z",
        agent: "fin-client",
        action: "apply-additive",
        kind: "missing-memory-file",
        identifier: "memory/match.md",
        sourceHash: null,
        targetHash: null,
        reversible: true,
        rolledBack: false,
        preChangeSnapshot: null,
        reason: null,
      },
    ];
    for (const r of rows) await appendCutoverRow(ledgerPath, r);

    const unlinked: string[] = [];
    const result = await runRollbackEngine(
      makeDeps({
        unlinkFile: async (p) => {
          unlinked.push(p);
        },
      }),
    );

    expect(result.rewoundCount).toBe(1);
    expect(unlinked).toHaveLength(1);
    expect(unlinked[0]).toContain("match.md");
  });

  it("RB4: destructive outdated-memory-file restored from gz+b64 snapshot", async () => {
    const original = Buffer.from("ORIGINAL CONTENT v1");
    const snapshot = gzipSync(original).toString("base64");

    const row: CutoverLedgerRow = {
      timestamp: "2026-04-15T00:00:00.000Z",
      agent: "fin-client",
      action: "apply-destructive",
      kind: "outdated-memory-file",
      identifier: "memory/foo.md",
      sourceHash: "abc",
      targetHash: "def",
      reversible: true,
      rolledBack: false,
      preChangeSnapshot: snapshot,
      reason: null,
    };
    await appendCutoverRow(ledgerPath, row);

    const writes: { path: string; data: Buffer }[] = [];
    const result = await runRollbackEngine(
      makeDeps({
        writeFileAtomic: async (p, d) => {
          writes.push({ path: p, data: d });
        },
      }),
    );

    expect(result.rewoundCount).toBe(1);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.data.toString("utf8")).toBe("ORIGINAL CONTENT v1");
    expect(writes[0]!.path).toContain("foo.md");
  });

  it("RB5: appends rollback row with rollback-of:<ts> reason marker", async () => {
    const row: CutoverLedgerRow = {
      timestamp: "2026-04-15T00:00:00.000Z",
      agent: "fin-client",
      action: "apply-additive",
      kind: "missing-memory-file",
      identifier: "memory/x.md",
      sourceHash: null,
      targetHash: null,
      reversible: true,
      rolledBack: false,
      preChangeSnapshot: null,
      reason: null,
    };
    await appendCutoverRow(ledgerPath, row);

    await runRollbackEngine(
      makeDeps({ unlinkFile: async () => undefined }),
    );

    const ledgerText = await readFile(ledgerPath, "utf8");
    expect(ledgerText).toContain(`${ROLLBACK_OF_REASON_PREFIX}2026-04-15`);
    // The original apply row is UNCHANGED — append-only invariant.
    const lines = ledgerText
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]!.action).toBe("apply-additive");
    expect(lines[1]!.action).toBe("rollback");
  });

  it("RB6: dryRun=true → no fs mutations + no ledger appends, but counts reflected", async () => {
    const row: CutoverLedgerRow = {
      timestamp: "2026-04-15T00:00:00.000Z",
      agent: "fin-client",
      action: "apply-additive",
      kind: "missing-memory-file",
      identifier: "memory/x.md",
      sourceHash: null,
      targetHash: null,
      reversible: true,
      rolledBack: false,
      preChangeSnapshot: null,
      reason: null,
    };
    await appendCutoverRow(ledgerPath, row);
    const ledgerBefore = await readFile(ledgerPath, "utf8");

    const unlinkSpy = vi.fn();
    const result = await runRollbackEngine(
      makeDeps({ dryRun: true, unlinkFile: unlinkSpy }),
    );

    expect(result.rewoundCount).toBe(1);
    expect(unlinkSpy).not.toHaveBeenCalled();
    const ledgerAfter = await readFile(ledgerPath, "utf8");
    expect(ledgerAfter).toBe(ledgerBefore);
  });
});
