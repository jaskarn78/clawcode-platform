/**
 * Phase 91 Plan 02 Task 2 — sync-runner conflict integration tests
 * (SYNC-06 D-11..D-15).
 *
 * Pinned invariants:
 *   SRC1: No conflicts in candidate set → outcome.kind="synced",
 *         alert fetch NEVER invoked, sync-state.conflicts stays empty
 *   SRC2: 2 files conflict → outcome.kind="partial-conflicts",
 *         filesSkippedConflict=2, sync-state.conflicts has 2 entries
 *   SRC3: Each conflicting path appears as --exclude=<path> in the REAL
 *         rsync args (per-FILE skip, not per-CYCLE)
 *   SRC4: Non-conflicting files in the same cycle still transfer
 *         (per-FILE skip discipline; MEMORY.md conflict doesn't block
 *         memory/2026-*.md propagation)
 *   SRC5: Alert fetch errors (network / HTTP) do NOT fail the sync cycle
 *         (outcome still returns partial-conflicts or synced)
 *   SRC6: Two consecutive cycles with the same unresolved conflict fire
 *         the alert BOTH times (D-15: "one embed per cycle", no path-level
 *         suppression — operators need visibility on persistent divergence)
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nanoid } from "nanoid";
import {
  syncOnce,
  type RsyncRunner,
  type JsonlAppender,
  type DestHasher,
  type DryRunRsync,
  type SourceHashProbe,
  type SyncRunnerDeps,
} from "../sync-runner.js";
import { writeSyncState, readSyncState } from "../sync-state-store.js";
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

type Harness = {
  deps: SyncRunnerDeps;
  rsyncCalls: string[][];
  jsonlEntries: SyncJsonlEntry[];
  fetchCalls: Array<{ url: string; init: RequestInit }>;
  dryRunCalls: number;
  tmpDir: string;
  syncStatePath: string;
};

async function makeHarness(params: {
  state: SyncStateFile;
  dryRunCandidates: readonly string[];
  sourceHashes: ReadonlyMap<string, string>;
  destHashes: ReadonlyMap<string, string | null>;
  realRsyncStdout: string;
  realRsyncExit?: number;
  fetchResponse?: { ok: boolean; status: number; bodyJson?: unknown };
  fetchRejects?: Error;
  includeAlertToken?: boolean;
}): Promise<Harness> {
  const tmpDir = await mkdtemp(join(tmpdir(), `src-conflicts-${nanoid(6)}-`));
  const syncStatePath = join(tmpDir, "sync-state.json");
  const jsonlPath = join(tmpDir, "sync.jsonl");
  const filterPath = join(tmpDir, "filter.txt");

  await writeSyncState(syncStatePath, params.state);

  const rsyncCalls: string[][] = [];
  const jsonlEntries: SyncJsonlEntry[] = [];
  const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
  let dryRunCalls = 0;

  const runRsync: RsyncRunner = async (args) => {
    rsyncCalls.push([...args]);
    return {
      stdout: params.realRsyncStdout,
      stderr: "",
      exitCode: params.realRsyncExit ?? 0,
    };
  };

  const appendJsonl: JsonlAppender = async (_path, entry) => {
    jsonlEntries.push(entry);
  };

  const hashDest: DestHasher = async (abs) => {
    // Strip the workspace prefix to get a relpath.
    const prefix = params.state.clawcodeWorkspace + "/";
    const rel = abs.startsWith(prefix) ? abs.slice(prefix.length) : abs;
    const h = params.destHashes.get(rel);
    return h === undefined ? null : h;
  };

  const dryRunRsync: DryRunRsync = async (_base) => {
    dryRunCalls++;
    return {
      candidateRelpaths: params.dryRunCandidates,
      stderr: "",
      exitCode: 0,
    };
  };

  const probeSourceHashes: SourceHashProbe = async () =>
    params.sourceHashes;

  const alertFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), init: init ?? {} });
    if (params.fetchRejects) throw params.fetchRejects;
    const resp = params.fetchResponse ?? { ok: true, status: 200, bodyJson: { id: "msg1" } };
    return {
      ok: resp.ok,
      status: resp.status,
      async json() {
        return resp.bodyJson ?? {};
      },
      async text() {
        return JSON.stringify(resp.bodyJson ?? {});
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const deps: SyncRunnerDeps = {
    syncStatePath,
    filterFilePath: filterPath,
    syncJsonlPath: jsonlPath,
    log: makeLogger(),
    now: () => new Date("2026-04-24T19:30:00.000Z"),
    runRsync,
    appendJsonl,
    hashDest,
    dryRunRsync,
    probeSourceHashes,
    alertBotToken: params.includeAlertToken === false ? undefined : "test-bot-token",
    alertFetch,
  };

  return {
    deps,
    rsyncCalls,
    jsonlEntries,
    fetchCalls,
    get dryRunCalls() {
      return dryRunCalls;
    },
    tmpDir,
    syncStatePath,
  };
}

/**
 * A deterministic flush-microtasks helper — sendConflictAlert is fire-and-
 * forget via `void`, so we give the event loop a turn to resolve the
 * returned Promise before asserting on fetchCalls.
 */
async function flushMicrotasks() {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

// ---------------------------------------------------------------------------
// SRC1: No conflicts → synced, no alert
// ---------------------------------------------------------------------------

describe("syncOnce — no conflicts detected (SRC1)", () => {
  let harness: Harness;
  afterEach(async () => {
    await rm(harness.tmpDir, { recursive: true, force: true });
  });

  it("returns synced + never invokes alert fetch + state.conflicts empty", async () => {
    // Baseline has MEMORY.md@WRITTEN. Dry-run candidates are memory/a.md
    // (new) + MEMORY.md (dest untouched since last write → clean).
    harness = await makeHarness({
      state: makeState({
        perFileHashes: { "MEMORY.md": "WRITTEN" },
      }),
      dryRunCandidates: ["memory/a.md", "MEMORY.md"],
      sourceHashes: new Map([
        ["memory/a.md", "SRC_A"],
        ["MEMORY.md", "SRC_MEM_V2"],
      ]),
      destHashes: new Map([
        ["memory/a.md", null], // doesn't exist on dest
        ["MEMORY.md", "WRITTEN"], // dest untouched
      ]),
      realRsyncStdout: [
        ">f+++++++++ memory/a.md",
        ">f.st...... MEMORY.md",
        "Total transferred file size: 100 bytes",
      ].join("\n"),
    });
    const outcome = await syncOnce(harness.deps);
    expect(outcome.kind).toBe("synced");
    await flushMicrotasks();
    expect(harness.fetchCalls).toHaveLength(0);
    const state = await readSyncState(harness.syncStatePath);
    expect(state.conflicts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// SRC2: 2 conflicts → partial-conflicts + state has 2 conflict entries
// ---------------------------------------------------------------------------

describe("syncOnce — 2 files conflict (SRC2)", () => {
  let harness: Harness;
  afterEach(async () => {
    await rm(harness.tmpDir, { recursive: true, force: true });
  });

  it("returns partial-conflicts with filesSkippedConflict=2 + persists conflicts", async () => {
    harness = await makeHarness({
      state: makeState({
        perFileHashes: {
          "MEMORY.md": "WRITTEN_MEM",
          "SOUL.md": "WRITTEN_SOUL",
          "memory/clean.md": "WRITTEN_C",
        },
      }),
      dryRunCandidates: ["MEMORY.md", "SOUL.md", "memory/clean.md"],
      sourceHashes: new Map([
        ["MEMORY.md", "WRITTEN_MEM"], // operator-only drift (C3 conflict)
        ["SOUL.md", "NEW_SOUL_SRC"], // both drifted (C4 conflict)
        ["memory/clean.md", "WRITTEN_C"], // dest untouched (clean)
      ]),
      destHashes: new Map([
        ["MEMORY.md", "OPERATOR_EDIT_MEM"],
        ["SOUL.md", "OPERATOR_EDIT_SOUL"],
        ["memory/clean.md", "WRITTEN_C"],
      ]),
      realRsyncStdout: [
        ">f.st...... memory/clean.md",
        "Total transferred file size: 50 bytes",
      ].join("\n"),
    });
    const outcome = await syncOnce(harness.deps);

    expect(outcome.kind).toBe("partial-conflicts");
    if (outcome.kind === "partial-conflicts") {
      expect(outcome.filesSkippedConflict).toBe(2);
      expect(outcome.conflicts.map((c) => c.path).sort()).toEqual(
        ["MEMORY.md", "SOUL.md"].sort(),
      );
    }
    const state = await readSyncState(harness.syncStatePath);
    expect(state.conflicts.map((c) => c.path).sort()).toEqual(
      ["MEMORY.md", "SOUL.md"].sort(),
    );
    // JSONL entry logs partial-conflicts status + filesSkippedConflict.
    const entry = harness.jsonlEntries[0]!;
    expect(entry.status).toBe("partial-conflicts");
    expect(entry.filesSkippedConflict).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// SRC3: Conflict paths appear as --exclude=<path> in real rsync args
// ---------------------------------------------------------------------------

describe("syncOnce — --exclude per conflict (SRC3)", () => {
  let harness: Harness;
  afterEach(async () => {
    await rm(harness.tmpDir, { recursive: true, force: true });
  });

  it("appends --exclude=<path> for each conflicting file before invoking rsync", async () => {
    harness = await makeHarness({
      state: makeState({
        perFileHashes: { "MEMORY.md": "WRITTEN_MEM" },
      }),
      dryRunCandidates: ["MEMORY.md"],
      sourceHashes: new Map([["MEMORY.md", "NEW_SRC"]]),
      destHashes: new Map([["MEMORY.md", "OPERATOR_EDIT"]]),
      realRsyncStdout: "Total transferred file size: 0 bytes",
    });
    await syncOnce(harness.deps);
    // rsyncCalls[0] is the REAL rsync (dry-run uses dryRunRsync DI).
    const args = harness.rsyncCalls[0]!;
    expect(args).toContain("--exclude=MEMORY.md");
  });
});

// ---------------------------------------------------------------------------
// SRC4: Non-conflicting files still transfer in the same cycle
// ---------------------------------------------------------------------------

describe("syncOnce — per-FILE skip preserves clean files (SRC4, D-12)", () => {
  let harness: Harness;
  afterEach(async () => {
    await rm(harness.tmpDir, { recursive: true, force: true });
  });

  it("MEMORY.md conflict does NOT block memory/2026-04-24.md transfer", async () => {
    // Baseline: MEMORY.md previously written. memory/2026-04-24.md first-ever.
    harness = await makeHarness({
      state: makeState({
        perFileHashes: { "MEMORY.md": "WRITTEN_MEM" },
      }),
      dryRunCandidates: ["MEMORY.md", "memory/2026-04-24.md"],
      sourceHashes: new Map([
        ["MEMORY.md", "NEW_SRC_MEM"],
        ["memory/2026-04-24.md", "NEW_DAILY"],
      ]),
      destHashes: new Map([
        ["MEMORY.md", "OPERATOR_EDIT"], // conflict
        ["memory/2026-04-24.md", null], // first-ever — clean
      ]),
      realRsyncStdout: [
        ">f+++++++++ memory/2026-04-24.md",
        "Total transferred file size: 2,048 bytes",
      ].join("\n"),
    });
    const outcome = await syncOnce(harness.deps);
    expect(outcome.kind).toBe("partial-conflicts");
    if (outcome.kind === "partial-conflicts") {
      expect(outcome.filesAdded).toBe(1); // memory/2026-04-24.md transferred
      expect(outcome.filesSkippedConflict).toBe(1); // MEMORY.md skipped
      expect(outcome.bytesTransferred).toBe(2048);
    }
    // --exclude only for MEMORY.md; the daily note args are NOT excluded.
    const args = harness.rsyncCalls[0]!;
    expect(args).toContain("--exclude=MEMORY.md");
    expect(args.some((a) => a === "--exclude=memory/2026-04-24.md")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SRC5: Alert failures do not fail the sync cycle
// ---------------------------------------------------------------------------

describe("syncOnce — alert errors do not fail the cycle (SRC5)", () => {
  let harness: Harness;
  afterEach(async () => {
    await rm(harness.tmpDir, { recursive: true, force: true });
  });

  it("fetch rejects (network down) → outcome still partial-conflicts", async () => {
    harness = await makeHarness({
      state: makeState({
        perFileHashes: { "MEMORY.md": "WRITTEN_MEM" },
      }),
      dryRunCandidates: ["MEMORY.md"],
      sourceHashes: new Map([["MEMORY.md", "NEW_SRC"]]),
      destHashes: new Map([["MEMORY.md", "OPERATOR_EDIT"]]),
      realRsyncStdout: "Total transferred file size: 0 bytes",
      fetchRejects: new Error("getaddrinfo ENOTFOUND discord.com"),
    });
    const outcome = await syncOnce(harness.deps);
    // Must return a valid outcome even though Discord is unreachable.
    expect(outcome.kind).toBe("partial-conflicts");
    // JSONL observability is still recorded regardless of alert failure.
    expect(harness.jsonlEntries[0]?.status).toBe("partial-conflicts");
    await flushMicrotasks();
  });

  it("fetch 403 (missing access) → outcome still partial-conflicts", async () => {
    harness = await makeHarness({
      state: makeState({
        perFileHashes: { "MEMORY.md": "WRITTEN_MEM" },
      }),
      dryRunCandidates: ["MEMORY.md"],
      sourceHashes: new Map([["MEMORY.md", "NEW_SRC"]]),
      destHashes: new Map([["MEMORY.md", "OPERATOR_EDIT"]]),
      realRsyncStdout: "Total transferred file size: 0 bytes",
      fetchResponse: { ok: false, status: 403, bodyJson: { message: "Missing Access" } },
    });
    const outcome = await syncOnce(harness.deps);
    expect(outcome.kind).toBe("partial-conflicts");
    await flushMicrotasks();
  });
});

// ---------------------------------------------------------------------------
// SRC6: Consecutive cycles with same unresolved conflict → alert fires each time
// ---------------------------------------------------------------------------

describe("syncOnce — re-alert on persistent conflicts (SRC6, D-15)", () => {
  let harness: Harness;
  afterEach(async () => {
    await rm(harness.tmpDir, { recursive: true, force: true });
  });

  it("fires alert both cycles when same conflict stays unresolved", async () => {
    harness = await makeHarness({
      state: makeState({
        perFileHashes: { "MEMORY.md": "WRITTEN_MEM" },
      }),
      dryRunCandidates: ["MEMORY.md"],
      sourceHashes: new Map([["MEMORY.md", "NEW_SRC"]]),
      destHashes: new Map([["MEMORY.md", "OPERATOR_EDIT"]]),
      realRsyncStdout: "Total transferred file size: 0 bytes",
    });

    await syncOnce(harness.deps);
    await flushMicrotasks();
    const fetchesAfterCycle1 = harness.fetchCalls.length;
    expect(fetchesAfterCycle1).toBe(1);

    // Cycle 2: same unresolved conflict. The state file now has MEMORY.md
    // in conflicts[] from cycle 1 (updateSyncStateConflict is idempotent).
    // Our alerter fires each cycle regardless of whether the conflict
    // already existed — D-15 "one embed per cycle" without path-level
    // suppression.
    await syncOnce(harness.deps);
    await flushMicrotasks();
    expect(harness.fetchCalls.length).toBe(2);

    // state.conflicts still has exactly ONE unresolved MEMORY.md entry
    // (the store's idempotent-append behavior; not 2 duplicate entries).
    const finalState = await readSyncState(harness.syncStatePath);
    const unresolvedMem = finalState.conflicts.filter(
      (c) => c.path === "MEMORY.md" && c.resolvedAt === null,
    );
    expect(unresolvedMem).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// SRC7: Alert only fires when botToken is wired (no-token short-circuits silently)
// ---------------------------------------------------------------------------

describe("syncOnce — alert short-circuits when no botToken (SRC7)", () => {
  let harness: Harness;
  afterEach(async () => {
    await rm(harness.tmpDir, { recursive: true, force: true });
  });

  it("conflicts exist + no alertBotToken → no fetch call, outcome still partial-conflicts", async () => {
    harness = await makeHarness({
      state: makeState({
        perFileHashes: { "MEMORY.md": "WRITTEN_MEM" },
      }),
      dryRunCandidates: ["MEMORY.md"],
      sourceHashes: new Map([["MEMORY.md", "NEW_SRC"]]),
      destHashes: new Map([["MEMORY.md", "OPERATOR_EDIT"]]),
      realRsyncStdout: "Total transferred file size: 0 bytes",
      includeAlertToken: false, // no token
    });
    const outcome = await syncOnce(harness.deps);
    expect(outcome.kind).toBe("partial-conflicts");
    await flushMicrotasks();
    expect(harness.fetchCalls).toHaveLength(0);
  });
});
