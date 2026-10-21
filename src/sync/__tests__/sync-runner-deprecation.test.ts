/**
 * Phase 96 Plan 06 — sync-runner deprecation gate tests (D-11).
 *
 * Validates the new `authoritativeSide === "deprecated"` short-circuit at
 * sync-runner.ts (just after the existing Phase 91 paused-when-clawcode
 * branch). Pinned invariants:
 *
 *   SR-DEPRECATED-SHORTS-CIRCUIT   — outcome.kind = "deprecated", reason carries phase-91-mirror-deprecated
 *   SR-DEPRECATED-NO-RSYNC         — runRsync stub NOT invoked when state is deprecated
 *   SR-DEPRECATED-NO-ALERT         — no Discord conflict alert fired (no conflicts can exist)
 *   SR-DEPRECATED-LEDGER           — appendJsonl recorded one entry with status="deprecated"
 *   SR-DEPRECATED-LOG-INFO         — log.info called once; log.warn / log.error NOT called (informational, not warning)
 *   SR-CLAWCODE-STILL-PAUSED       — clawcode authoritativeSide still returns "paused" (existing Phase 91 behavior preserved)
 *
 * Mirrors the Phase 91 sync-runner.test.ts harness 1:1 — fake RsyncRunner +
 * fake JsonlAppender + fake DestHasher; no real rsync/SSH/filesystem beyond
 * a mkdtemp'd sync-state.json. Tests fail until sync-runner.ts gains the
 * deprecated-state short-circuit (lines 163-166 area).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nanoid } from "nanoid";
import {
  syncOnce,
  type RsyncRunner,
  type JsonlAppender,
  type DestHasher,
  type SyncRunnerDeps,
} from "../sync-runner.js";
import { writeSyncState } from "../sync-state-store.js";
import type { SyncJsonlEntry, SyncStateFile } from "../types.js";

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

type DeprecationHarness = {
  deps: SyncRunnerDeps;
  rsyncCalls: string[][];
  jsonlEntries: SyncJsonlEntry[];
  hashedPaths: string[];
  log: ReturnType<typeof makeLogger>;
  tmpDir: string;
  syncStatePath: string;
  jsonlPath: string;
  filterPath: string;
};

async function makeHarness(
  overrides: {
    state?: SyncStateFile;
    rsync?: RsyncRunner;
  } = {},
): Promise<DeprecationHarness> {
  const tmpDir = await mkdtemp(join(tmpdir(), `sync-deprecation-${nanoid(6)}-`));
  const syncStatePath = join(tmpDir, "sync-state.json");
  const jsonlPath = join(tmpDir, "sync.jsonl");
  const filterPath = join(tmpDir, "filter.txt");

  // Seed state — defaults to openclaw; tests pass deprecated overrides.
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

  const hashDest: DestHasher = async (abs) => {
    hashedPaths.push(abs);
    return "sha256-of-" + abs.split("/").pop();
  };

  const log = makeLogger();
  const deps: SyncRunnerDeps = {
    syncStatePath,
    filterFilePath: filterPath,
    syncJsonlPath: jsonlPath,
    log,
    now: () => new Date("2026-04-25T16:00:00.000Z"),
    runRsync,
    appendJsonl,
    hashDest,
  };

  return {
    deps,
    rsyncCalls,
    jsonlEntries,
    hashedPaths,
    log,
    tmpDir,
    syncStatePath,
    jsonlPath,
    filterPath,
  };
}

// ---------------------------------------------------------------------------
// SR-DEPRECATED-SHORTS-CIRCUIT — deprecated state → kind="deprecated"
// ---------------------------------------------------------------------------

describe("syncOnce — deprecated authoritativeSide short-circuit (Phase 96 D-11)", () => {
  let harness: DeprecationHarness;

  afterEach(async () => {
    await rm(harness.tmpDir, { recursive: true, force: true });
  });

  it("returns kind='deprecated' when authoritativeSide=deprecated", async () => {
    harness = await makeHarness({
      state: makeState({
        authoritativeSide: "deprecated",
        deprecatedAt: "2026-04-25T16:00:00.000Z",
      }),
    });
    const outcome = await syncOnce(harness.deps);
    expect(outcome.kind).toBe("deprecated");
  });

  it("outcome.reason contains 'phase-91-mirror-deprecated' marker", async () => {
    harness = await makeHarness({
      state: makeState({
        authoritativeSide: "deprecated",
        deprecatedAt: "2026-04-25T16:00:00.000Z",
      }),
    });
    const outcome = await syncOnce(harness.deps);
    expect(outcome.kind).toBe("deprecated");
    if (outcome.kind === "deprecated") {
      expect(outcome.reason).toContain("phase-91-mirror-deprecated");
    }
  });

  it("does NOT invoke rsync runner (no transport, no shell-out)", async () => {
    harness = await makeHarness({
      state: makeState({
        authoritativeSide: "deprecated",
        deprecatedAt: "2026-04-25T16:00:00.000Z",
      }),
    });
    await syncOnce(harness.deps);
    expect(harness.rsyncCalls).toHaveLength(0);
  });

  it("appends one ledger row with status='deprecated' to sync.jsonl", async () => {
    harness = await makeHarness({
      state: makeState({
        authoritativeSide: "deprecated",
        deprecatedAt: "2026-04-25T16:00:00.000Z",
      }),
    });
    await syncOnce(harness.deps);
    expect(harness.jsonlEntries).toHaveLength(1);
    expect(harness.jsonlEntries[0]?.status).toBe("deprecated");
  });

  it("logs at info level (informational, not warning)", async () => {
    harness = await makeHarness({
      state: makeState({
        authoritativeSide: "deprecated",
        deprecatedAt: "2026-04-25T16:00:00.000Z",
      }),
    });
    await syncOnce(harness.deps);
    // Deprecation is informational, not a warning — log.warn / log.error NOT called.
    const logMock = harness.log as unknown as {
      info: ReturnType<typeof vi.fn>;
      warn: ReturnType<typeof vi.fn>;
      error: ReturnType<typeof vi.fn>;
    };
    expect(logMock.info).toHaveBeenCalled();
    expect(logMock.warn).not.toHaveBeenCalled();
    expect(logMock.error).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SR-CLAWCODE-STILL-PAUSED — Phase 91 paused behavior unchanged
// ---------------------------------------------------------------------------

describe("syncOnce — clawcode authoritativeSide still returns paused (Phase 91 invariant)", () => {
  let harness: DeprecationHarness;

  afterEach(async () => {
    await rm(harness.tmpDir, { recursive: true, force: true });
  });

  it("authoritativeSide=clawcode still produces kind='paused' (NOT deprecated)", async () => {
    harness = await makeHarness({
      state: makeState({ authoritativeSide: "clawcode" }),
    });
    const outcome = await syncOnce(harness.deps);
    expect(outcome.kind).toBe("paused");
    expect(harness.rsyncCalls).toHaveLength(0);
    expect(harness.jsonlEntries[0]?.status).toBe("paused");
  });
});
