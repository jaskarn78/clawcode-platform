/**
 * Phase 92 Plan 03 Task 1 (RED) — additive-applier tests.
 *
 * Pins the contract for src/cutover/additive-applier.ts (NOT YET CREATED —
 * tests fail at import time which is the canonical RED gate).
 *
 * Behavioral pins (D-05, D-07):
 *   A1 missing-skill happy-path        — secret-scan pass → rsync → updateAgentSkills → 1 ledger row
 *   A2 missing-skill secret-scan refused — scan refused → no rsync, no yaml, no ledger
 *   A3 missing-memory-file happy-path  — rsync copy → 1 ledger row
 *   A4 missing-upload happy-path       — rsync copy → 1 ledger row
 *   A5 model-not-in-allowlist happy-path — updateAgentConfig({allowedModels: ...}) → 1 ledger row
 *   A6 dry-run                         — apply: false → ZERO writes, no ledger file
 *   A7 destructive-deferral            — input has destructive gaps → deferred count, only additive applied
 *   A8 idempotency                     — re-running with same gaps → zero new ledger rows
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { applyAdditiveFixes, type AdditiveApplierDeps } from "../additive-applier.js";
import type { CutoverGap } from "../types.js";

function makeLog() {
  const log: Record<string, unknown> = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  };
  log.child = vi.fn(() => log as unknown);
  return log as unknown as import("pino").Logger;
}

let tmpRoot: string;
let clawcodeYamlPath: string;
let memoryRoot: string;
let skillsTargetDir: string;
let uploadsTargetDir: string;
let openClawSkillsRoot: string;
let openClawWorkspace: string;
let ledgerPath: string;

const AGENT = "fin-client";

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "cutover-applier-"));
  clawcodeYamlPath = join(tmpRoot, "clawcode.yaml");
  memoryRoot = join(tmpRoot, "agents", AGENT);
  skillsTargetDir = join(tmpRoot, "skills");
  uploadsTargetDir = join(memoryRoot, "uploads", "discord");
  openClawSkillsRoot = join(tmpRoot, "openclaw", "skills");
  openClawWorkspace = join(tmpRoot, "openclaw", "workspace");
  ledgerPath = join(tmpRoot, "manager", "cutover-ledger.jsonl");

  await mkdir(memoryRoot, { recursive: true });
  await mkdir(uploadsTargetDir, { recursive: true });
  await mkdir(skillsTargetDir, { recursive: true });
  await mkdir(openClawSkillsRoot, { recursive: true });
  await mkdir(openClawWorkspace, { recursive: true });

  // Minimal clawcode.yaml — agents seq with one entry, empty skills/allowedModels.
  const yaml =
    "agents:\n" +
    `  - name: ${AGENT}\n` +
    "    skills: []\n" +
    "    allowedModels: []\n";
  await writeFile(clawcodeYamlPath, yaml, "utf8");
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

function makeMissingSkillGap(name = "content-engine"): CutoverGap {
  return {
    kind: "missing-skill",
    identifier: name,
    severity: "additive",
    sourceRef: { skillName: name },
    targetRef: { skills: [] },
  };
}
function makeMissingMemoryGap(path = "memory/2026-04-24-x.md"): CutoverGap {
  return {
    kind: "missing-memory-file",
    identifier: path,
    severity: "additive",
    sourceRef: { path, sourceHash: "src-hash-123" },
    targetRef: { exists: false },
  };
}
function makeMissingUploadGap(filename = "chart.png"): CutoverGap {
  return {
    kind: "missing-upload",
    identifier: filename,
    severity: "additive",
    sourceRef: { filename },
    targetRef: { uploads: [] },
  };
}
function makeModelGap(modelId = "claude-opus-4"): CutoverGap {
  return {
    kind: "model-not-in-allowlist",
    identifier: modelId,
    severity: "additive",
    sourceRef: { modelId },
    targetRef: { allowedModels: ["claude-sonnet-4-6"] },
  };
}
function makeOutdatedMemoryGap(path = "memory/old.md"): CutoverGap {
  return {
    kind: "outdated-memory-file",
    identifier: path,
    severity: "destructive",
    sourceRef: { path, sourceHash: "src-h" },
    targetRef: { path, targetHash: "tgt-h" },
  };
}

type Mocks = {
  updateAgentSkills: ReturnType<typeof vi.fn>;
  updateAgentConfig: ReturnType<typeof vi.fn>;
  scanSkillForSecrets: ReturnType<typeof vi.fn>;
  normalizeSkillFrontmatter: ReturnType<typeof vi.fn>;
  runRsync: ReturnType<typeof vi.fn>;
};

function makeDeps(
  gaps: readonly CutoverGap[],
  apply: boolean,
  overrides: Partial<Mocks> = {},
): { deps: AdditiveApplierDeps; mocks: Mocks } {
  const mocks: Mocks = {
    updateAgentSkills:
      overrides.updateAgentSkills ??
      vi.fn(async () => ({ kind: "updated", persisted: true })),
    updateAgentConfig:
      overrides.updateAgentConfig ??
      vi.fn(async () => ({ kind: "updated", persisted: true })),
    scanSkillForSecrets:
      overrides.scanSkillForSecrets ??
      vi.fn(async () => ({ refused: false })),
    normalizeSkillFrontmatter:
      overrides.normalizeSkillFrontmatter ?? vi.fn(async () => undefined),
    runRsync:
      overrides.runRsync ??
      vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
  };

  const deps: AdditiveApplierDeps = {
    agent: AGENT,
    gaps,
    apply,
    clawcodeYamlPath,
    skillsTargetDir,
    memoryRoot,
    uploadsTargetDir,
    openClawHost: "example-user@10.0.0.3",
    openClawWorkspace,
    openClawSkillsRoot,
    ledgerPath,
    updateAgentSkills:
      mocks.updateAgentSkills as unknown as AdditiveApplierDeps["updateAgentSkills"],
    updateAgentConfig:
      mocks.updateAgentConfig as unknown as AdditiveApplierDeps["updateAgentConfig"],
    scanSkillForSecrets:
      mocks.scanSkillForSecrets as unknown as AdditiveApplierDeps["scanSkillForSecrets"],
    normalizeSkillFrontmatter:
      mocks.normalizeSkillFrontmatter as unknown as AdditiveApplierDeps["normalizeSkillFrontmatter"],
    runRsync: mocks.runRsync as unknown as AdditiveApplierDeps["runRsync"],
    log: makeLog(),
  };

  return { deps, mocks };
}

async function readLedgerLines(): Promise<unknown[]> {
  if (!existsSync(ledgerPath)) return [];
  const txt = await readFile(ledgerPath, "utf8");
  return txt
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// A1 — missing-skill happy-path
// ---------------------------------------------------------------------------

describe("applyAdditiveFixes — A1 missing-skill happy-path", () => {
  it("scans, rsyncs, updates YAML, appends one ledger row", async () => {
    const { deps, mocks } = makeDeps([makeMissingSkillGap("content-engine")], true);
    const outcome = await applyAdditiveFixes(deps);

    expect(outcome.kind).toBe("applied");
    if (outcome.kind === "applied") {
      expect(outcome.gapsApplied).toBe(1);
      expect(outcome.gapsSkipped).toBe(0);
      expect(outcome.destructiveDeferred).toBe(0);
    }
    expect(mocks.scanSkillForSecrets).toHaveBeenCalledTimes(1);
    expect(mocks.normalizeSkillFrontmatter).toHaveBeenCalledTimes(1);
    expect(mocks.runRsync).toHaveBeenCalledTimes(1);
    expect(mocks.updateAgentSkills).toHaveBeenCalledTimes(1);

    const lines = await readLedgerLines();
    expect(lines).toHaveLength(1);
    const row = lines[0] as { action: string; kind: string; identifier: string; agent: string };
    expect(row.action).toBe("apply-additive");
    expect(row.kind).toBe("missing-skill");
    expect(row.identifier).toBe("content-engine");
    expect(row.agent).toBe(AGENT);
  });
});

// ---------------------------------------------------------------------------
// A2 — missing-skill secret-scan refused (ordering pin)
// ---------------------------------------------------------------------------

describe("applyAdditiveFixes — A2 missing-skill secret-scan refused", () => {
  it("refuses BEFORE rsync/updateAgentSkills; no ledger row", async () => {
    const refusedScan = vi.fn(async () => ({
      refused: true,
      reason: "high-entropy",
    }));
    const { deps, mocks } = makeDeps([makeMissingSkillGap("dirty-skill")], true, {
      scanSkillForSecrets: refusedScan,
    });
    const outcome = await applyAdditiveFixes(deps);

    expect(outcome.kind).toBe("secret-scan-refused");
    if (outcome.kind === "secret-scan-refused") {
      expect(outcome.identifier).toBe("dirty-skill");
      expect(outcome.reason).toContain("high-entropy");
    }

    // Critical ordering pin: scanSkillForSecrets called BEFORE rsync/yaml.
    expect(refusedScan).toHaveBeenCalledTimes(1);
    expect(mocks.runRsync).toHaveBeenCalledTimes(0);
    expect(mocks.updateAgentSkills).toHaveBeenCalledTimes(0);

    // No ledger file should have been touched.
    expect(existsSync(ledgerPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A3 — missing-memory-file happy-path
// ---------------------------------------------------------------------------

describe("applyAdditiveFixes — A3 missing-memory-file happy-path", () => {
  it("rsyncs the file and writes one ledger row", async () => {
    const memPath = "memory/2026-04-24-x.md";
    // Simulate rsync's effect — write the target file before returning success
    // so the post-rsync sha256 read succeeds.
    const fakeRsync = vi.fn(async () => {
      const target = join(memoryRoot, memPath);
      await mkdir(join(memoryRoot, "memory"), { recursive: true });
      await writeFile(target, "synthetic memory body\n", "utf8");
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const { deps, mocks } = makeDeps([makeMissingMemoryGap(memPath)], true, {
      runRsync: fakeRsync,
    });
    const outcome = await applyAdditiveFixes(deps);

    expect(outcome.kind).toBe("applied");
    if (outcome.kind === "applied") expect(outcome.gapsApplied).toBe(1);
    expect(mocks.runRsync).toHaveBeenCalledTimes(1);

    const lines = await readLedgerLines();
    expect(lines).toHaveLength(1);
    expect((lines[0] as { kind: string }).kind).toBe("missing-memory-file");
  });
});

// ---------------------------------------------------------------------------
// A4 — missing-upload happy-path
// ---------------------------------------------------------------------------

describe("applyAdditiveFixes — A4 missing-upload happy-path", () => {
  it("rsyncs the upload and writes one ledger row", async () => {
    const upName = "chart.png";
    const fakeRsync = vi.fn(async () => {
      await writeFile(join(uploadsTargetDir, upName), "PNG\n", "utf8");
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const { deps } = makeDeps([makeMissingUploadGap(upName)], true, {
      runRsync: fakeRsync,
    });
    const outcome = await applyAdditiveFixes(deps);
    expect(outcome.kind).toBe("applied");
    const lines = await readLedgerLines();
    expect(lines).toHaveLength(1);
    expect((lines[0] as { kind: string }).kind).toBe("missing-upload");
  });
});

// ---------------------------------------------------------------------------
// A5 — model-not-in-allowlist happy-path
// ---------------------------------------------------------------------------

describe("applyAdditiveFixes — A5 model-not-in-allowlist happy-path", () => {
  it("calls updateAgentConfig with allowedModels patch including the missing model", async () => {
    const { deps, mocks } = makeDeps([makeModelGap("claude-opus-4")], true);
    const outcome = await applyAdditiveFixes(deps);

    expect(outcome.kind).toBe("applied");
    expect(mocks.updateAgentConfig).toHaveBeenCalledTimes(1);
    const call = mocks.updateAgentConfig.mock.calls[0]!;
    // Expected shape: (agent, patch, opts)
    expect(call[0]).toBe(AGENT);
    const patch = call[1] as { allowedModels?: readonly string[] };
    expect(patch.allowedModels).toContain("claude-opus-4");

    const lines = await readLedgerLines();
    expect(lines).toHaveLength(1);
    expect((lines[0] as { kind: string }).kind).toBe("model-not-in-allowlist");
  });
});

// ---------------------------------------------------------------------------
// A6 — dry-run zero-side-effect
// ---------------------------------------------------------------------------

describe("applyAdditiveFixes — A6 dry-run zero side effects", () => {
  it("apply: false produces no writes, no ledger, no rsync, no updates", async () => {
    const { deps, mocks } = makeDeps([makeMissingSkillGap("x")], false);
    const outcome = await applyAdditiveFixes(deps);

    expect(outcome.kind).toBe("dry-run");
    if (outcome.kind === "dry-run") {
      expect(outcome.plannedAdditive).toBe(1);
      expect(outcome.destructiveDeferred).toBe(0);
    }

    expect(mocks.scanSkillForSecrets).toHaveBeenCalledTimes(0);
    expect(mocks.runRsync).toHaveBeenCalledTimes(0);
    expect(mocks.updateAgentSkills).toHaveBeenCalledTimes(0);
    expect(mocks.updateAgentConfig).toHaveBeenCalledTimes(0);
    expect(mocks.normalizeSkillFrontmatter).toHaveBeenCalledTimes(0);

    expect(existsSync(ledgerPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A7 — destructive-deferral
// ---------------------------------------------------------------------------

describe("applyAdditiveFixes — A7 destructive-deferral", () => {
  it("applies only additive gaps; counts destructive separately; never calls destructive primitives", async () => {
    const memPath = "memory/x.md";
    const fakeRsync = vi.fn(async () => {
      await mkdir(join(memoryRoot, "memory"), { recursive: true });
      await writeFile(join(memoryRoot, memPath), "body\n", "utf8");
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const { deps, mocks } = makeDeps(
      [
        makeOutdatedMemoryGap("memory/old.md"),
        makeOutdatedMemoryGap("memory/older.md"),
        makeMissingMemoryGap(memPath),
      ],
      true,
      { runRsync: fakeRsync },
    );
    const outcome = await applyAdditiveFixes(deps);

    expect(outcome.kind).toBe("applied");
    if (outcome.kind === "applied") {
      expect(outcome.gapsApplied).toBe(1);
      expect(outcome.destructiveDeferred).toBe(2);
    }

    // Only the additive gap was rsynced.
    expect(mocks.runRsync).toHaveBeenCalledTimes(1);

    const lines = await readLedgerLines();
    expect(lines).toHaveLength(1);
    expect((lines[0] as { kind: string }).kind).toBe("missing-memory-file");
  });
});

// ---------------------------------------------------------------------------
// A8 — idempotency check-then-act
// ---------------------------------------------------------------------------

describe("applyAdditiveFixes — A8 idempotency check-then-act", () => {
  it("a second apply over already-fixed gaps produces zero new ledger rows", async () => {
    // Pre-seed clawcode.yaml so the missing-skill is "already there".
    const yaml =
      "agents:\n" +
      `  - name: ${AGENT}\n` +
      "    skills:\n" +
      "      - already-there\n" +
      "    allowedModels:\n" +
      "      - claude-opus-4\n";
    await writeFile(clawcodeYamlPath, yaml, "utf8");

    // Pre-create the memory file at the target so it's present.
    const memPath = "memory/already.md";
    await mkdir(join(memoryRoot, "memory"), { recursive: true });
    await writeFile(join(memoryRoot, memPath), "already there", "utf8");

    const gaps: readonly CutoverGap[] = [
      makeMissingSkillGap("already-there"),
      makeModelGap("claude-opus-4"),
      makeMissingMemoryGap(memPath),
    ];

    const { deps, mocks } = makeDeps(gaps, true);
    const outcome = await applyAdditiveFixes(deps);

    expect(outcome.kind).toBe("applied");
    if (outcome.kind === "applied") {
      expect(outcome.gapsApplied).toBe(0);
      expect(outcome.gapsSkipped).toBe(3);
    }
    // No mutating primitives should be called for already-fixed gaps.
    expect(mocks.runRsync).toHaveBeenCalledTimes(0);
    expect(mocks.updateAgentSkills).toHaveBeenCalledTimes(0);
    expect(mocks.updateAgentConfig).toHaveBeenCalledTimes(0);

    // No ledger file created on a fully-skipped run.
    if (existsSync(ledgerPath)) {
      const lines = await readLedgerLines();
      expect(lines).toHaveLength(0);
    }
  });
});
