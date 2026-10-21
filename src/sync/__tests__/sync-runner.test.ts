/**
 * Phase 91 Plan 01 Task 2 — sync-runner tests
 * (SYNC-01 + SYNC-02 + SYNC-05 + SYNC-07).
 *
 * Validates the pure-function DI entry point `syncOnce` + the rsync output
 * parser `parseRsyncStats`. All tests inject a fake RsyncRunner + fake
 * JsonlAppender + fake DestHasher — no real rsync, no real SSH, no
 * filesystem beyond the mkdtemp'd sync-state.json.
 *
 * Pinned invariants:
 *   R1: authoritativeSide=clawcode → paused outcome, rsync NEVER invoked
 *   R2: rsync throws (SSH failure) → failed-ssh outcome + JSONL line
 *   R3: rsync exits non-zero (not 23) → failed-rsync outcome
 *   R4: 2 adds + 1 update parse correctly; JSONL captures counts
 *   R5: zero changes → skipped-no-changes outcome
 *   R6: perFileHashes updates with dest sha256 after sync
 *   R7: EXCLUDE-FILTER REGRESSION — if touchedPaths contains .sqlite or
 *       sessions/ path, syncOnce THROWS (fail loud, not silent data leak)
 *   R8: parseRsyncStats extracts bytesTransferred from --stats output
 *   R9: JSONL entry has {timestamp, cycleId, direction, status} on every
 *       outcome variant
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nanoid } from "nanoid";
import {
  syncOnce,
  parseRsyncStats,
  flattenOutcomeToJsonl,
  type RsyncRunner,
  type JsonlAppender,
  type DestHasher,
  type SyncRunnerDeps,
} from "../sync-runner.js";
import {
  writeSyncState,
  readSyncState,
} from "../sync-state-store.js";
import type {
  SyncJsonlEntry,
  SyncRunOutcome,
  SyncStateFile,
} from "../types.js";

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  } as unknown as import("pino").Logger;
}

function makeState(overrides: Partial<SyncStateFile> = {}): SyncStateFile {
  return {
    version: 1,
    updatedAt: "2026-04-24T19:00:00.000Z",
    authoritativeSide: "openclaw",
    lastSyncedAt: null,
    openClawHost: "example-user@10.0.0.3",
    openClawWorkspace: "/home/example-user/.openclaw/workspace-acme",
    clawcodeWorkspace: "/home/clawcode/.clawcode/agents/acme",
    perFileHashes: {},
    conflicts: [],
    openClawSessionCursor: null,
    ...overrides,
  };
}

type HarnessDeps = {
  deps: SyncRunnerDeps;
  rsyncCalls: string[][];
  jsonlEntries: SyncJsonlEntry[];
  hashedPaths: string[];
  tmpDir: string;
  syncStatePath: string;
  jsonlPath: string;
  filterPath: string;
};

async function makeHarness(
  overrides: {
    rsync?: RsyncRunner;
    hashDest?: DestHasher;
    state?: SyncStateFile;
  } = {},
): Promise<HarnessDeps> {
  const tmpDir = await mkdtemp(join(tmpdir(), `sync-runner-${nanoid(6)}-`));
  const syncStatePath = join(tmpDir, "sync-state.json");
  const jsonlPath = join(tmpDir, "sync.jsonl");
  const filterPath = join(tmpDir, "filter.txt");

  // Seed the state file; tests that need the default can pass an empty state.
  await writeSyncState(syncStatePath, overrides.state ?? makeState());

  const rsyncCalls: string[][] = [];
  const jsonlEntries: SyncJsonlEntry[] = [];
  const hashedPaths: string[] = [];

  const runRsync: RsyncRunner =
    overrides.rsync ??
    (async (args) => {
      rsyncCalls.push([...args]);
      return { stdout: "", stderr: "", exitCode: 0 };
    });

  const appendJsonl: JsonlAppender = async (_path, entry) => {
    jsonlEntries.push(entry);
  };

  const hashDest: DestHasher =
    overrides.hashDest ??
    (async (abs) => {
      hashedPaths.push(abs);
      return "sha256-of-" + abs.split("/").pop();
    });

  const deps: SyncRunnerDeps = {
    syncStatePath,
    filterFilePath: filterPath,
    syncJsonlPath: jsonlPath,
    log: makeLogger(),
    now: () => new Date("2026-04-24T19:30:00.000Z"),
    runRsync,
    appendJsonl,
    hashDest,
  };

  return {
    deps,
    rsyncCalls,
    jsonlEntries,
    hashedPaths,
    tmpDir,
    syncStatePath,
    jsonlPath,
    filterPath,
  };
}

// ---------------------------------------------------------------------------
// R1: authoritativeSide=clawcode → paused, rsync NEVER invoked
// ---------------------------------------------------------------------------

describe("syncOnce — direction-aware pause (D-18)", () => {
  let harness: HarnessDeps;

  afterEach(async () => {
    await rm(harness.tmpDir, { recursive: true, force: true });
  });

  it("returns paused when authoritativeSide=clawcode and never calls rsync", async () => {
    harness = await makeHarness({
      state: makeState({ authoritativeSide: "clawcode" }),
    });
    const outcome = await syncOnce(harness.deps);

    expect(outcome.kind).toBe("paused");
    if (outcome.kind === "paused") {
      expect(outcome.reason).toBe("authoritative-is-clawcode-no-reverse-opt-in");
    }
    expect(harness.rsyncCalls).toHaveLength(0);
    expect(harness.jsonlEntries).toHaveLength(1);
    expect(harness.jsonlEntries[0]?.status).toBe("paused");
  });
});

// ---------------------------------------------------------------------------
// R2: rsync throws (SSH failure) → failed-ssh
// ---------------------------------------------------------------------------

describe("syncOnce — graceful SSH failure (D-04)", () => {
  let harness: HarnessDeps;

  afterEach(async () => {
    await rm(harness.tmpDir, { recursive: true, force: true });
  });

  it("returns failed-ssh when rsync runner throws (network / tunnel down)", async () => {
    harness = await makeHarness({
      rsync: async () => {
        throw new Error("ssh: connect to host 10.0.0.3: No route to host");
      },
    });
    const outcome = await syncOnce(harness.deps);

    expect(outcome.kind).toBe("failed-ssh");
    if (outcome.kind === "failed-ssh") {
      expect(outcome.error).toContain("No route to host");
    }
    expect(harness.jsonlEntries).toHaveLength(1);
    expect(harness.jsonlEntries[0]?.status).toBe("failed-ssh");
  });
});

// ---------------------------------------------------------------------------
// R3: rsync non-zero exit (!= 23) → failed-rsync
// ---------------------------------------------------------------------------

describe("syncOnce — rsync non-zero exit", () => {
  let harness: HarnessDeps;

  afterEach(async () => {
    await rm(harness.tmpDir, { recursive: true, force: true });
  });

  it("returns failed-rsync with preserved exitCode on non-23 failure", async () => {
    harness = await makeHarness({
      rsync: async () => ({
        stdout: "",
        stderr: "rsync: remote command not found\n",
        exitCode: 12,
      }),
    });
    const outcome = await syncOnce(harness.deps);

    expect(outcome.kind).toBe("failed-rsync");
    if (outcome.kind === "failed-rsync") {
      expect(outcome.exitCode).toBe(12);
      expect(outcome.error).toContain("remote command not found");
    }
    expect(harness.jsonlEntries[0]?.status).toBe("failed-rsync");
  });

  it("accepts exit 23 as a soft partial (not failed-rsync)", async () => {
    harness = await makeHarness({
      rsync: async () => ({
        stdout:
          ">f+++++++++ MEMORY.md\n" +
          "Total transferred file size: 27,000 bytes\n",
        stderr: "rsync warning: some files skipped (code 23)\n",
        exitCode: 23,
      }),
    });
    const outcome = await syncOnce(harness.deps);
    expect(outcome.kind).toBe("synced");
  });
});

// ---------------------------------------------------------------------------
// R4: 2 adds + 1 update parse correctly
// ---------------------------------------------------------------------------

describe("syncOnce — successful sync with file changes", () => {
  let harness: HarnessDeps;

  afterEach(async () => {
    await rm(harness.tmpDir, { recursive: true, force: true });
  });

  const RSYNC_OK_STDOUT = [
    "sending incremental file list",
    ">f+++++++++ MEMORY.md",
    ">f+++++++++ memory/2026-04-24.md",
    ">f.st...... SOUL.md",
    "",
    "Number of files: 12",
    "Number of regular files transferred: 3",
    "Total transferred file size: 54,321 bytes",
    "",
  ].join("\n");

  it("returns synced with counts and JSONL entry (R4 + R9)", async () => {
    harness = await makeHarness({
      rsync: async () => ({ stdout: RSYNC_OK_STDOUT, stderr: "", exitCode: 0 }),
    });
    const outcome = await syncOnce(harness.deps);

    expect(outcome.kind).toBe("synced");
    if (outcome.kind === "synced") {
      expect(outcome.filesAdded).toBe(2);
      expect(outcome.filesUpdated).toBe(1);
      expect(outcome.filesRemoved).toBe(0);
      expect(outcome.bytesTransferred).toBe(54321);
      expect(outcome.filesSkippedConflict).toBe(0); // Plan 91-02 will change
    }

    const entry = harness.jsonlEntries[0]!;
    expect(entry.timestamp).toBe("2026-04-24T19:30:00.000Z");
    expect(entry.cycleId).toBe(outcome.cycleId);
    expect(entry.direction).toBe("openclaw-to-clawcode");
    expect(entry.status).toBe("synced");
  });

  it("updates perFileHashes for each touched destination path (R6)", async () => {
    harness = await makeHarness({
      rsync: async () => ({ stdout: RSYNC_OK_STDOUT, stderr: "", exitCode: 0 }),
    });
    await syncOnce(harness.deps);
    const state = await readSyncState(harness.syncStatePath);
    expect(state.perFileHashes["MEMORY.md"]).toBe("sha256-of-MEMORY.md");
    expect(state.perFileHashes["memory/2026-04-24.md"]).toBe(
      "sha256-of-2026-04-24.md",
    );
    expect(state.perFileHashes["SOUL.md"]).toBe("sha256-of-SOUL.md");
    expect(state.lastSyncedAt).toBe("2026-04-24T19:30:00.000Z");
    // Hasher was called with the join of clawcodeWorkspace + relpath.
    expect(
      harness.hashedPaths.some((p) =>
        p.endsWith("/acme/MEMORY.md"),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R5: zero changes → skipped-no-changes
// ---------------------------------------------------------------------------

describe("syncOnce — zero-change cycle", () => {
  let harness: HarnessDeps;

  afterEach(async () => {
    await rm(harness.tmpDir, { recursive: true, force: true });
  });

  it("returns skipped-no-changes when rsync reports no transfers", async () => {
    harness = await makeHarness({
      rsync: async () => ({
        stdout:
          "sending incremental file list\n" +
          "\n" +
          "Number of files: 12\n" +
          "Number of regular files transferred: 0\n" +
          "Total transferred file size: 0 bytes\n",
        stderr: "",
        exitCode: 0,
      }),
    });
    const outcome = await syncOnce(harness.deps);
    expect(outcome.kind).toBe("skipped-no-changes");
    expect(harness.jsonlEntries[0]?.status).toBe("skipped-no-changes");
  });
});

// ---------------------------------------------------------------------------
// R7: EXCLUDE-FILTER REGRESSION — .sqlite / sessions path must fail loud
// ---------------------------------------------------------------------------

describe("syncOnce — exclude-filter regression guard (SYNC-02)", () => {
  let harness: HarnessDeps;

  afterEach(async () => {
    await rm(harness.tmpDir, { recursive: true, force: true });
  });

  it("throws when a .sqlite path leaks into rsync output (filter broken upstream)", async () => {
    harness = await makeHarness({
      rsync: async () => ({
        stdout:
          ">f+++++++++ memories.sqlite\n" +
          "Total transferred file size: 100 bytes\n",
        stderr: "",
        exitCode: 0,
      }),
    });
    await expect(syncOnce(harness.deps)).rejects.toThrow(/filter-file regression.*\.sqlite/);
  });

  it("throws when a sessions/ path leaks into rsync output", async () => {
    harness = await makeHarness({
      rsync: async () => ({
        stdout:
          ">f+++++++++ sessions/2026-04-24.jsonl\n" +
          "Total transferred file size: 100 bytes\n",
        stderr: "",
        exitCode: 0,
      }),
    });
    await expect(syncOnce(harness.deps)).rejects.toThrow(/filter-file regression.*sessions/);
  });
});

// ---------------------------------------------------------------------------
// R8: parseRsyncStats extracts bytesTransferred (including commas)
// ---------------------------------------------------------------------------

describe("parseRsyncStats — --itemize-changes + --stats parser", () => {
  it("extracts bytesTransferred with locale-formatted commas", () => {
    const stdout = [
      ">f+++++++++ MEMORY.md",
      "Total transferred file size: 1,234,567 bytes",
    ].join("\n");
    const parsed = parseRsyncStats(stdout);
    expect(parsed.bytesTransferred).toBe(1234567);
  });

  it("extracts bytesTransferred without commas", () => {
    const stdout = "Total transferred file size: 54321 bytes";
    const parsed = parseRsyncStats(stdout);
    expect(parsed.bytesTransferred).toBe(54321);
  });

  it("returns bytesTransferred=0 when --stats output is missing", () => {
    const parsed = parseRsyncStats(">f+++++++++ MEMORY.md\n");
    expect(parsed.bytesTransferred).toBe(0);
  });

  it("counts deletions from *deleting lines", () => {
    const stdout = [
      "*deleting old-note.md",
      "*deleting memory/stale/",
      ">f+++++++++ new-file.md",
    ].join("\n");
    const parsed = parseRsyncStats(stdout);
    // Directory deletion ignored (trailing slash); only the file counts.
    expect(parsed.filesRemoved).toBe(1);
    expect(parsed.filesAdded).toBe(1);
    expect(parsed.touchedPaths).toContain("old-note.md");
    expect(parsed.touchedPaths).toContain("new-file.md");
  });

  it("skips directory entries (second char 'd')", () => {
    const stdout = [
      "cd+++++++++ memory/",
      ">f+++++++++ memory/note.md",
    ].join("\n");
    const parsed = parseRsyncStats(stdout);
    expect(parsed.filesAdded).toBe(1);
    expect(parsed.touchedPaths).toEqual(["memory/note.md"]);
  });
});

// ---------------------------------------------------------------------------
// R9: JSONL entry shape across all outcome variants
// ---------------------------------------------------------------------------

describe("flattenOutcomeToJsonl — SYNC-07 JSONL contract", () => {
  const start = new Date("2026-04-24T19:30:00.000Z");

  it("synced outcome has counts + bytes + duration", () => {
    const entry = flattenOutcomeToJsonl(
      {
        kind: "synced",
        cycleId: "abc",
        filesAdded: 2,
        filesUpdated: 1,
        filesRemoved: 0,
        filesSkippedConflict: 0,
        bytesTransferred: 12345,
        durationMs: 987,
      },
      start,
    );
    expect(entry.status).toBe("synced");
    expect(entry.filesAdded).toBe(2);
    expect(entry.bytesTransferred).toBe(12345);
    expect(entry.durationMs).toBe(987);
    expect(entry.direction).toBe("openclaw-to-clawcode");
  });

  it("paused outcome has reason", () => {
    const entry = flattenOutcomeToJsonl(
      {
        kind: "paused",
        cycleId: "abc",
        reason: "authoritative-is-clawcode-no-reverse-opt-in",
      },
      start,
    );
    expect(entry.status).toBe("paused");
    expect(entry.reason).toBe("authoritative-is-clawcode-no-reverse-opt-in");
  });

  it("failed-ssh outcome has error + duration", () => {
    const entry = flattenOutcomeToJsonl(
      { kind: "failed-ssh", cycleId: "abc", error: "timeout", durationMs: 42 },
      start,
    );
    expect(entry.status).toBe("failed-ssh");
    expect(entry.error).toBe("timeout");
  });

  it("failed-rsync outcome has exitCode", () => {
    const entry = flattenOutcomeToJsonl(
      {
        kind: "failed-rsync",
        cycleId: "abc",
        error: "bad args",
        durationMs: 42,
        exitCode: 12,
      },
      start,
    );
    expect(entry.status).toBe("failed-rsync");
    expect(entry.exitCode).toBe(12);
  });

  it("skipped-no-changes outcome has duration only", () => {
    const entry = flattenOutcomeToJsonl(
      { kind: "skipped-no-changes", cycleId: "abc", durationMs: 42 },
      start,
    );
    expect(entry.status).toBe("skipped-no-changes");
    expect(entry.durationMs).toBe(42);
    expect(entry.filesAdded).toBeUndefined();
  });

  it("every JSONL entry carries {timestamp, cycleId, direction, status}", () => {
    const outcomes: SyncRunOutcome[] = [
      { kind: "skipped-no-changes", cycleId: "a", durationMs: 1 },
      {
        kind: "paused",
        cycleId: "b",
        reason: "authoritative-is-clawcode-no-reverse-opt-in",
      },
      { kind: "failed-ssh", cycleId: "c", error: "e", durationMs: 1 },
      {
        kind: "failed-rsync",
        cycleId: "d",
        error: "e",
        durationMs: 1,
        exitCode: 2,
      },
      {
        kind: "synced",
        cycleId: "e",
        filesAdded: 1,
        filesUpdated: 0,
        filesRemoved: 0,
        filesSkippedConflict: 0,
        bytesTransferred: 10,
        durationMs: 1,
      },
    ];
    for (const o of outcomes) {
      const e = flattenOutcomeToJsonl(o, start);
      expect(e.timestamp).toBeTruthy();
      expect(e.cycleId).toBe(o.cycleId);
      expect(e.direction).toBe("openclaw-to-clawcode");
      expect(e.status).toBe(o.kind);
    }
  });
});

// ---------------------------------------------------------------------------
// Sanity: rsync args contain SSH hardening flags + filter-file reference
// ---------------------------------------------------------------------------

describe("syncOnce — rsync invocation shape", () => {
  let harness: HarnessDeps;

  afterEach(async () => {
    await rm(harness.tmpDir, { recursive: true, force: true });
  });

  it("passes --filter merge <filterPath> and SSH hardening args", async () => {
    // No override — the default stub harness records into rsyncCalls.
    harness = await makeHarness();
    await syncOnce(harness.deps);
    expect(harness.rsyncCalls).toHaveLength(1);
    const args = harness.rsyncCalls[0]!;
    expect(args).toContain("--filter");
    expect(args.some((a) => a.startsWith("merge "))).toBe(true);
    expect(args).toContain("--delete");
    expect(args).toContain("--itemize-changes");
    expect(args).toContain("--stats");
    expect(args.some((a) => a.includes("BatchMode=yes"))).toBe(true);
    expect(args.some((a) => a.includes("StrictHostKeyChecking=accept-new"))).toBe(true);
    // Source endpoint is example-user@10.0.0.3:<workspace>/
    expect(
      args.some((a) =>
        a.startsWith("example-user@10.0.0.3:/home/example-user/.openclaw"),
      ),
    ).toBe(true);
  });
});
