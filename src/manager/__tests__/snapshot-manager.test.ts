/**
 * Phase 999.6 Plan 00 — Wave 0 RED tests for snapshot-manager (SNAP-01..05).
 *
 * These tests pin the behavioral contract for `src/manager/snapshot-manager.ts`
 * BEFORE the module is created. On `npx vitest run`, every assertion here
 * MUST fail at import-time (module not found) — that is the RED state.
 *
 * Wave 1 creates the module and turns these green.
 *
 * Coverage map (per 999.6-RESEARCH.md → Phase Requirements):
 *   - SNAP-01 (writer fires + atomic write)         → describe "writePreDeploySnapshot atomicity"
 *   - SNAP-02 (boot reader + delete + idempotent)   → describe "readAndConsumePreDeploySnapshot happy path"
 *                                                  + describe "readAndConsumePreDeploySnapshot tolerance"
 *   - SNAP-03 (atomic tmp + rename, no half files)  → describe "writePreDeploySnapshot atomicity"
 *   - SNAP-04 (stale-guard >maxAgeHours)            → describe "readAndConsumePreDeploySnapshot stale guard"
 *   - SNAP-05 (operator-visible structured logs)    → assertions inside the above describes
 *
 * Test infra:
 *   - Real fs in `os.tmpdir()` per-test via mkdtemp — no mock fs (mock atomicity
 *     is theatre; only real-fs catches half-rename bugs).
 *   - Pino in-memory transport via `pino({ level: "trace" }, sink)` to capture
 *     log lines as JSON (mirrors daemon-boot-secrets-degraded.test.ts pattern).
 *   - vi.useFakeTimers() to mock Date.now() for stale-guard checks.
 *
 * CLAUDE.md immutability: when constructing arrays in fixtures, use spread —
 * never mutate parsed snapshot objects. Mirrors effort-state-store.ts:138-141.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  access,
  readdir,
  stat,
} from "node:fs/promises";
import { Writable } from "node:stream";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import pino from "pino";

// Wave 0 RED: this import fails because src/manager/snapshot-manager.ts does
// not exist yet. Wave 1 creates it. Suppress tsc complaints with directives
// on each line that trips TS2307 (module-not-found fires on the `from`
// clause, not the `import` keyword) so `npm run typecheck` survives the
// gap. Vitest tolerates the missing module by failing the test file at
// runtime — which is the desired RED state.
import {
  writePreDeploySnapshot,
  readAndConsumePreDeploySnapshot,
  preDeploySnapshotSchema,
  DEFAULT_PRE_DEPLOY_SNAPSHOT_PATH,
} from "../snapshot-manager.js";

/**
 * Build a pino logger that buffers all emitted lines into memory so tests
 * can assert log-shape contracts (component, level, msg, fields).
 */
function makeCapturingLogger(): {
  log: pino.Logger;
  lines: () => Array<Record<string, unknown>>;
} {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  const log = pino({ level: "trace" }, sink);
  return {
    log,
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((s) => s.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

/** Allocate a fresh tmp dir per test; clean up afterwards. */
async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "snapshot-manager-test-"));
}

/** A canonical valid snapshot object — fixture for read tests. */
function makeFixtureSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    snapshotAt: new Date().toISOString(),
    snapshotPid: process.pid,
    runningAgents: [
      { name: "fin-client", sessionId: "a1c3491f-aaaa-bbbb-cccc-ddddeeeeffff" },
      { name: "personal", sessionId: null },
    ],
    ...overrides,
  };
}

describe("snapshot-manager — writePreDeploySnapshot atomicity (SNAP-01, SNAP-03)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes valid JSON matching preDeploySnapshotSchema to filePath", async () => {
    const { log } = makeCapturingLogger();
    const filePath = join(tmpDir, "snapshot.json");
    await writePreDeploySnapshot(
      filePath,
      [
        { name: "fin-client", sessionId: "a1" },
        { name: "personal", sessionId: null },
      ],
      log,
    );
    const raw = await readFile(filePath, "utf8");
    const parsed = preDeploySnapshotSchema.parse(JSON.parse(raw));
    expect(parsed.version).toBe(1);
    expect(parsed.runningAgents).toHaveLength(2);
    expect(parsed.runningAgents[0]?.name).toBe("fin-client");
    expect(parsed.runningAgents[1]?.sessionId).toBeNull();
  });

  it("creates parent directory if missing (mkdir recursive)", async () => {
    const { log } = makeCapturingLogger();
    const nested = join(tmpDir, "deep", "nested", "dir", "snapshot.json");
    await writePreDeploySnapshot(nested, [], log);
    // If mkdir-p didn't run, writeFile would have thrown ENOENT
    const raw = await readFile(nested, "utf8");
    expect(JSON.parse(raw)).toMatchObject({ version: 1, runningAgents: [] });
  });

  it("uses temp file with .tmp suffix during write — no .tmp leftover after success", async () => {
    const { log } = makeCapturingLogger();
    const filePath = join(tmpDir, "snapshot.json");
    await writePreDeploySnapshot(filePath, [{ name: "x", sessionId: null }], log);
    const dirEntries = await readdir(tmpDir);
    // Final file present, no .tmp leftover
    expect(dirEntries).toContain("snapshot.json");
    expect(dirEntries.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  });

  it("renames tmp → final atomically — concurrent readers see ENOENT or schema-valid (never half-written)", async () => {
    const { log } = makeCapturingLogger();
    const filePath = join(tmpDir, "atomic.json");

    // Many parallel write+read iterations. Each read either ENOENTs or parses cleanly.
    const ITERATIONS = 30;
    const results: Array<{ ok: boolean; reason?: string }> = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const writePromise = writePreDeploySnapshot(
        filePath,
        [{ name: `agent-${i}`, sessionId: null }],
        log,
      );
      // Race a read against the in-flight write
      const readPromise = readFile(filePath, "utf8")
        .then((raw) => {
          // Whatever is on disk MUST parse — half-written content would throw.
          const obj = JSON.parse(raw);
          preDeploySnapshotSchema.parse(obj);
          return { ok: true };
        })
        .catch((err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT") return { ok: true, reason: "ENOENT" };
          return { ok: false, reason: err.message };
        });
      const [, readResult] = await Promise.all([writePromise, readPromise]);
      results.push(readResult);
    }

    const corrupt = results.filter((r) => !r.ok);
    expect(corrupt).toEqual([]);
  });

  it("snapshotAt is ISO 8601 string parseable by Date.parse", async () => {
    const { log } = makeCapturingLogger();
    const filePath = join(tmpDir, "snapshot.json");
    await writePreDeploySnapshot(filePath, [], log);
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as { snapshotAt: string };
    expect(typeof parsed.snapshotAt).toBe("string");
    expect(Number.isNaN(Date.parse(parsed.snapshotAt))).toBe(false);
  });

  it("snapshotPid equals process.pid at write time", async () => {
    const { log } = makeCapturingLogger();
    const filePath = join(tmpDir, "snapshot.json");
    await writePreDeploySnapshot(filePath, [], log);
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as { snapshotPid: number };
    expect(parsed.snapshotPid).toBe(process.pid);
  });

  it("runningAgents array preserves order", async () => {
    const { log } = makeCapturingLogger();
    const filePath = join(tmpDir, "snapshot.json");
    const input = [
      { name: "z-third", sessionId: null },
      { name: "a-first", sessionId: null },
      { name: "m-middle", sessionId: "abc" },
    ];
    await writePreDeploySnapshot(filePath, input, log);
    const raw = await readFile(filePath, "utf8");
    const parsed = preDeploySnapshotSchema.parse(JSON.parse(raw));
    expect(parsed.runningAgents.map((a: { name: string }) => a.name)).toEqual([
      "z-third",
      "a-first",
      "m-middle",
    ]);
  });

  it("logs info with component=\"snapshot-restore\" and { filePath, agentCount }", async () => {
    const { log, lines } = makeCapturingLogger();
    const filePath = join(tmpDir, "snapshot.json");
    await writePreDeploySnapshot(
      filePath,
      [
        { name: "a", sessionId: null },
        { name: "b", sessionId: null },
      ],
      log,
    );
    const written = lines().find(
      (l) => l.component === "snapshot-restore" && typeof l.msg === "string",
    );
    expect(written).toBeDefined();
    expect(written?.filePath).toBe(filePath);
    expect(written?.agentCount).toBe(2);
    expect(written?.level).toBe(30); // pino info level
  });
});

describe("snapshot-manager — readAndConsumePreDeploySnapshot happy path (SNAP-02, SNAP-05)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns set of agent names from snapshot when all are in knownAgentNames", async () => {
    const { log } = makeCapturingLogger();
    const filePath = join(tmpDir, "snap.json");
    await writeFile(filePath, JSON.stringify(makeFixtureSnapshot()), "utf8");

    const result = await readAndConsumePreDeploySnapshot(
      filePath,
      new Set(["fin-client", "personal", "other"]),
      24,
      log,
    );
    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(2);
    expect(result.has("fin-client")).toBe(true);
    expect(result.has("personal")).toBe(true);
  });

  it("deletes the snapshot file after successful read (consume semantics)", async () => {
    const { log } = makeCapturingLogger();
    const filePath = join(tmpDir, "snap.json");
    await writeFile(filePath, JSON.stringify(makeFixtureSnapshot()), "utf8");

    await readAndConsumePreDeploySnapshot(
      filePath,
      new Set(["fin-client", "personal"]),
      24,
      log,
    );

    await expect(access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("logs info \"applying pre-deploy snapshot\" with agentCount", async () => {
    const { log, lines } = makeCapturingLogger();
    const filePath = join(tmpDir, "snap.json");
    await writeFile(filePath, JSON.stringify(makeFixtureSnapshot()), "utf8");

    await readAndConsumePreDeploySnapshot(
      filePath,
      new Set(["fin-client", "personal"]),
      24,
      log,
    );

    const applying = lines().find(
      (l) =>
        l.component === "snapshot-restore" &&
        typeof l.msg === "string" &&
        (l.msg as string).toLowerCase().includes("applying pre-deploy snapshot"),
    );
    expect(applying).toBeDefined();
    expect(applying?.agentCount).toBe(2);
    expect(applying?.level).toBe(30);
  });

  it("logs info \"snapshot consumed\" with deletedSnapshotPath after delete", async () => {
    const { log, lines } = makeCapturingLogger();
    const filePath = join(tmpDir, "snap.json");
    await writeFile(filePath, JSON.stringify(makeFixtureSnapshot()), "utf8");

    await readAndConsumePreDeploySnapshot(
      filePath,
      new Set(["fin-client", "personal"]),
      24,
      log,
    );

    const consumed = lines().find(
      (l) =>
        l.component === "snapshot-restore" &&
        typeof l.msg === "string" &&
        (l.msg as string).toLowerCase().includes("snapshot consumed"),
    );
    expect(consumed).toBeDefined();
    expect(consumed?.deletedSnapshotPath).toBe(filePath);
  });

  it("delete happens BEFORE returning the set (caller-throw can't resurrect snapshot)", async () => {
    const { log } = makeCapturingLogger();
    const filePath = join(tmpDir, "snap.json");
    await writeFile(filePath, JSON.stringify(makeFixtureSnapshot()), "utf8");

    // Even if caller never uses the returned set, file must already be gone
    // by the time the promise resolves.
    const _result = await readAndConsumePreDeploySnapshot(
      filePath,
      new Set(["fin-client", "personal"]),
      24,
      log,
    );

    await expect(access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("snapshot-manager — readAndConsumePreDeploySnapshot stale guard (SNAP-04)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("discards snapshot older than maxAgeHours, returns empty set", async () => {
    const { log } = makeCapturingLogger();
    const filePath = join(tmpDir, "snap.json");
    // Snapshot taken 48h ago
    const oldAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    await writeFile(
      filePath,
      JSON.stringify(makeFixtureSnapshot({ snapshotAt: oldAt })),
      "utf8",
    );

    const result = await readAndConsumePreDeploySnapshot(
      filePath,
      new Set(["fin-client", "personal"]),
      24,
      log,
    );
    expect(result.size).toBe(0);
  });

  it("logs warn \"discarding stale snapshot\" with snapshotAgeHours rounded to 1 decimal", async () => {
    const { log, lines } = makeCapturingLogger();
    const filePath = join(tmpDir, "snap.json");
    const oldAt = new Date(Date.now() - 47.2 * 60 * 60 * 1000).toISOString();
    await writeFile(
      filePath,
      JSON.stringify(makeFixtureSnapshot({ snapshotAt: oldAt })),
      "utf8",
    );

    await readAndConsumePreDeploySnapshot(
      filePath,
      new Set(["fin-client", "personal"]),
      24,
      log,
    );

    const stale = lines().find(
      (l) =>
        l.component === "snapshot-restore" &&
        typeof l.msg === "string" &&
        (l.msg as string).toLowerCase().includes("discarding stale snapshot"),
    );
    expect(stale).toBeDefined();
    expect(stale?.level).toBe(40); // warn
    // snapshotAgeHours rounded to 1 decimal
    expect(typeof stale?.snapshotAgeHours).toBe("number");
    const age = stale?.snapshotAgeHours as number;
    // Rounding to 1 decimal → string repr should have at most 1 fractional digit
    expect(age).toBeCloseTo(47.2, 0);
    const fractional = age.toString().split(".")[1] ?? "";
    expect(fractional.length).toBeLessThanOrEqual(1);
  });

  it("deletes the stale snapshot file", async () => {
    const { log } = makeCapturingLogger();
    const filePath = join(tmpDir, "snap.json");
    const oldAt = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
    await writeFile(
      filePath,
      JSON.stringify(makeFixtureSnapshot({ snapshotAt: oldAt })),
      "utf8",
    );

    await readAndConsumePreDeploySnapshot(
      filePath,
      new Set(["fin-client", "personal"]),
      24,
      log,
    );

    await expect(access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("respects custom maxAgeHours (1h threshold discards a 2h-old snapshot)", async () => {
    const { log } = makeCapturingLogger();
    const filePath = join(tmpDir, "snap.json");
    const oldAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await writeFile(
      filePath,
      JSON.stringify(makeFixtureSnapshot({ snapshotAt: oldAt })),
      "utf8",
    );

    const result = await readAndConsumePreDeploySnapshot(
      filePath,
      new Set(["fin-client", "personal"]),
      1,
      log,
    );
    expect(result.size).toBe(0);
  });

  it("fresh snapshot (just-written) is NOT discarded with maxAgeHours=24", async () => {
    const { log } = makeCapturingLogger();
    const filePath = join(tmpDir, "snap.json");
    await writeFile(
      filePath,
      JSON.stringify(makeFixtureSnapshot()),
      "utf8",
    );

    const result = await readAndConsumePreDeploySnapshot(
      filePath,
      new Set(["fin-client", "personal"]),
      24,
      log,
    );
    expect(result.size).toBe(2);
  });
});

describe("snapshot-manager — readAndConsumePreDeploySnapshot tolerance (SNAP-02 idempotency)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("missing file (ENOENT) returns empty set, no warn log, file remains absent", async () => {
    const { log, lines } = makeCapturingLogger();
    const filePath = join(tmpDir, "does-not-exist.json");

    const result = await readAndConsumePreDeploySnapshot(
      filePath,
      new Set(["any"]),
      24,
      log,
    );
    expect(result.size).toBe(0);
    // No warn-level lines emitted on first-boot ENOENT (silent path)
    const warns = lines().filter((l) => l.level === 40);
    expect(warns).toEqual([]);
    await expect(access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("malformed JSON returns empty set, logs warn \"snapshot malformed\", deletes file", async () => {
    const { log, lines } = makeCapturingLogger();
    const filePath = join(tmpDir, "snap.json");
    await writeFile(filePath, "{not json at all", "utf8");

    const result = await readAndConsumePreDeploySnapshot(
      filePath,
      new Set(["any"]),
      24,
      log,
    );
    expect(result.size).toBe(0);
    const malformed = lines().find(
      (l) =>
        l.component === "snapshot-restore" &&
        typeof l.msg === "string" &&
        (l.msg as string).toLowerCase().includes("malformed"),
    );
    expect(malformed).toBeDefined();
    expect(malformed?.level).toBe(40);
    await expect(access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("schema-invalid (missing version field) returns empty set, logs warn, deletes file", async () => {
    const { log, lines } = makeCapturingLogger();
    const filePath = join(tmpDir, "snap.json");
    // Valid JSON, invalid schema (no version)
    await writeFile(
      filePath,
      JSON.stringify({
        snapshotAt: new Date().toISOString(),
        snapshotPid: process.pid,
        runningAgents: [],
      }),
      "utf8",
    );

    const result = await readAndConsumePreDeploySnapshot(
      filePath,
      new Set(["any"]),
      24,
      log,
    );
    expect(result.size).toBe(0);
    const warned = lines().find(
      (l) => l.component === "snapshot-restore" && l.level === 40,
    );
    expect(warned).toBeDefined();
    await expect(access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("schema-invalid (version=2) rejected — pin literal(1)", async () => {
    const { log } = makeCapturingLogger();
    const filePath = join(tmpDir, "snap.json");
    await writeFile(
      filePath,
      JSON.stringify(makeFixtureSnapshot({ version: 2 })),
      "utf8",
    );

    const result = await readAndConsumePreDeploySnapshot(
      filePath,
      new Set(["fin-client", "personal"]),
      24,
      log,
    );
    expect(result.size).toBe(0);
    await expect(access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("snapshot referencing agent not in knownAgentNames drops that entry, includes valid entries, warn-logs each drop", async () => {
    const { log, lines } = makeCapturingLogger();
    const filePath = join(tmpDir, "snap.json");
    await writeFile(
      filePath,
      JSON.stringify(
        makeFixtureSnapshot({
          runningAgents: [
            { name: "still-here", sessionId: null },
            { name: "deleted-agent", sessionId: null },
          ],
        }),
      ),
      "utf8",
    );

    const result = await readAndConsumePreDeploySnapshot(
      filePath,
      new Set(["still-here"]),
      24,
      log,
    );
    expect(result.size).toBe(1);
    expect(result.has("still-here")).toBe(true);
    expect(result.has("deleted-agent")).toBe(false);

    const dropWarn = lines().find(
      (l) =>
        l.component === "snapshot-restore" &&
        typeof l.msg === "string" &&
        (l.msg as string).toLowerCase().includes("unknown agent"),
    );
    expect(dropWarn).toBeDefined();
    expect(dropWarn?.level).toBe(40);
  });

  it("all entries unknown → returns empty set, file still deleted", async () => {
    const { log } = makeCapturingLogger();
    const filePath = join(tmpDir, "snap.json");
    await writeFile(
      filePath,
      JSON.stringify(
        makeFixtureSnapshot({
          runningAgents: [
            { name: "ghost-1", sessionId: null },
            { name: "ghost-2", sessionId: null },
          ],
        }),
      ),
      "utf8",
    );

    const result = await readAndConsumePreDeploySnapshot(
      filePath,
      new Set(["completely-different"]),
      24,
      log,
    );
    expect(result.size).toBe(0);
    await expect(access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("snapshot-manager — DEFAULT_PRE_DEPLOY_SNAPSHOT_PATH constant", () => {
  it("ends with .clawcode/manager/pre-deploy-snapshot.json", () => {
    expect(DEFAULT_PRE_DEPLOY_SNAPSHOT_PATH).toMatch(
      /\.clawcode[\\/]manager[\\/]pre-deploy-snapshot\.json$/,
    );
  });

  it("is absolute path under homedir()", () => {
    expect(DEFAULT_PRE_DEPLOY_SNAPSHOT_PATH.startsWith(homedir())).toBe(true);
  });
});
