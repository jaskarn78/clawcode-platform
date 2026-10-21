/**
 * Quick task 260419-q2z Task 2 — unit tests for `clawcode registry repair`.
 *
 * Tests the offline repair subcommand against corrupt registry fixtures.
 * Uses real mkdtemp'd files + the real atomic writeRegistry from Task 1
 * (so we also get an integration check that the repair routes through the
 * atomic pipeline, leaving no residual .tmp on disk).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat, writeFile as wf, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { Command } from "commander";

import {
  registerRegistryCommand,
  repairAction,
  buildDefaultRepairDeps,
  _findFirstBalancedObject,
  type RegistryRepairDeps,
} from "../registry.js";

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "registry-repair-test-"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function makeDeps(
  overrides: Partial<RegistryRepairDeps> = {},
): {
  deps: RegistryRepairDeps;
  logs: string[];
  errors: string[];
  exits: number[];
} {
  const logs: string[] = [];
  const errors: string[] = [];
  const exits: number[] = [];
  const base = buildDefaultRepairDeps();
  const deps: RegistryRepairDeps = {
    ...base,
    log: (msg: string) => logs.push(msg),
    error: (msg: string) => errors.push(msg),
    exit: (code: number) => {
      exits.push(code);
    },
    ...overrides,
  };
  return { deps, logs, errors, exits };
}

describe("clawcode registry repair", () => {
  it("repairs the exact outage pattern — valid JSON followed by '0\\n}' trailer", async () => {
    const path = join(testDir, "registry.json");
    const seed =
      '{"entries":[{"name":"clawdy","status":"running"}],"updatedAt":1000}0\n}';
    await wf(path, seed, "utf-8");

    const { deps, logs, errors, exits } = makeDeps();
    await repairAction({ path, deps });

    expect(exits).toEqual([]);
    expect(errors).toEqual([]);
    expect(logs.some((m) => /repaired: trimmed \d+ bytes, 1 entries preserved/.test(m))).toBe(true);

    // Main path now parses cleanly with 1 entry.
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].name).toBe("clawdy");

    // A timestamped .corrupt-*.bak exists.
    const files = await readdir(testDir);
    const corruptBak = files.find((f) => /^registry\.json\.corrupt-.+\.bak$/.test(f));
    expect(corruptBak).toBeDefined();
  });

  it("no-op on already-valid input", async () => {
    const path = join(testDir, "registry.json");
    const good = JSON.stringify(
      { entries: [{ name: "clawdy", status: "running" }], updatedAt: 42 },
      null,
      2,
    );
    await wf(path, good, "utf-8");

    const { deps, logs, errors, exits } = makeDeps();
    await repairAction({ path, deps });

    expect(exits).toEqual([]);
    expect(errors).toEqual([]);
    expect(logs.some((m) => m.includes("no trailing garbage"))).toBe(true);

    // Byte-for-byte identical post-run.
    const after = await readFile(path, "utf-8");
    expect(after).toBe(good);

    // No .corrupt-*.bak created.
    const files = await readdir(testDir);
    expect(files.some((f) => /^registry\.json\.corrupt-.+\.bak$/.test(f))).toBe(false);
  });

  it("exits 1 when no balanced top-level '}' exists", async () => {
    const path = join(testDir, "registry.json");
    await wf(path, "{broken", "utf-8");

    const { deps, errors, exits } = makeDeps();
    await repairAction({ path, deps });

    expect(exits).toEqual([1]);
    expect(errors.some((m) => m.includes("unrecoverable"))).toBe(true);
    expect(errors.some((m) => m.includes("no balanced JSON object found"))).toBe(true);

    // No .corrupt-*.bak since we never attempted recovery.
    const files = await readdir(testDir);
    expect(files.some((f) => /^registry\.json\.corrupt-.+\.bak$/.test(f))).toBe(false);
  });

  it("defaults --path to ~/.clawcode/manager/registry.json when omitted", async () => {
    // We can't actually invoke against the real home dir — just verify the
    // default binding via Commander inspection.
    const program = new Command();
    program.exitOverride();
    // Stub deps so the action doesn't actually run if somehow invoked.
    const { deps } = makeDeps({
      readFile: async () => {
        throw new Error("stub readFile not expected to run in this test");
      },
    });
    registerRegistryCommand(program, deps);

    const registryCmd = program.commands.find((c) => c.name() === "registry");
    expect(registryCmd).toBeDefined();
    const repairCmd = registryCmd?.commands.find((c) => c.name() === "repair");
    expect(repairCmd).toBeDefined();

    const pathOption = repairCmd?.options.find((o) => o.long === "--path");
    expect(pathOption).toBeDefined();
    expect(pathOption?.defaultValue).toBe(
      join(homedir(), ".clawcode", "manager", "registry.json"),
    );
  });

  it("backup file is named with ISO-ish timestamp", async () => {
    const path = join(testDir, "registry.json");
    const seed =
      '{"entries":[],"updatedAt":1}garbage-trailer';
    await wf(path, seed, "utf-8");

    const { deps } = makeDeps({ now: () => 1_713_000_000_000 });
    await repairAction({ path, deps });

    const files = await readdir(testDir);
    const corruptBak = files.find((f) =>
      /^registry\.json\.corrupt-20\d{2}-\d{2}-\d{2}T.*\.bak$/.test(f),
    );
    expect(corruptBak).toBeDefined();
  });

  it("backup contains the RAW pre-repair bytes (not the trimmed ones)", async () => {
    const path = join(testDir, "registry.json");
    const seed = '{"entries":[],"updatedAt":7}TRAILER_GARBAGE_XYZ';
    await wf(path, seed, "utf-8");

    const { deps } = makeDeps();
    await repairAction({ path, deps });

    const files = await readdir(testDir);
    const corruptBak = files.find((f) =>
      /^registry\.json\.corrupt-.+\.bak$/.test(f),
    );
    expect(corruptBak).toBeDefined();
    const raw = await readFile(join(testDir, corruptBak as string), "utf-8");
    expect(raw).toBe(seed);
  });

  it("repair uses the NEW atomic writeRegistry (no residual .tmp after repair)", async () => {
    const path = join(testDir, "registry.json");
    const seed =
      '{"entries":[{"name":"a","status":"running"}],"updatedAt":1}trailing';
    await wf(path, seed, "utf-8");

    const { deps } = makeDeps();
    await repairAction({ path, deps });

    // Atomic pipeline — no .tmp left behind.
    await expect(stat(`${path}.tmp`)).rejects.toThrow();
    // And the main path is clean JSON.
    const raw = await readFile(path, "utf-8");
    JSON.parse(raw); // would throw if still corrupt
  });

  it("implementation never imports sendIpcRequest (offline-only, direct-file mode)", () => {
    const src = readFileSync(
      join(process.cwd(), "src", "cli", "commands", "registry.ts"),
      "utf-8",
    );
    expect(src).not.toContain("sendIpcRequest");
  });
});

// ---------------------------------------------------------------------------
// Pure helper — findFirstBalancedObject
// ---------------------------------------------------------------------------
describe("_findFirstBalancedObject", () => {
  it("finds a simple balanced object at index 0", () => {
    const raw = '{"a":1}';
    const res = _findFirstBalancedObject(raw);
    expect(res).toEqual({ start: 0, end: raw.length });
  });

  it("returns null when no balanced object exists", () => {
    const raw = "{not-closed";
    expect(_findFirstBalancedObject(raw)).toBeNull();
  });

  it("ignores braces inside string literals", () => {
    const raw = '{"msg":"hello {world}","n":1}';
    const res = _findFirstBalancedObject(raw);
    expect(res).toEqual({ start: 0, end: raw.length });
  });

  it("respects escaped quotes inside strings", () => {
    const raw = '{"msg":"he said \\"}\\" to me","n":1}';
    const res = _findFirstBalancedObject(raw);
    expect(res).toEqual({ start: 0, end: raw.length });
  });

  it("stops at the first balanced end and ignores trailing garbage", () => {
    const raw = '{"a":1}TRAILING_GARBAGE';
    const res = _findFirstBalancedObject(raw);
    expect(res).toEqual({ start: 0, end: 7 });
  });
});
