/**
 * Phase 91 Plan 01 Task 1 — sync-state-store tests (SYNC-01 + SYNC-05).
 *
 * Validates the `src/sync/sync-state-store.ts` atomic JSON store that backs
 * continuous-sync persistence. Mirrors the Phase 83 effort-state-store test
 * structure 1:1 — same mkdtemp isolation, same tmp-file absence check, same
 * Zod schema fallback pattern.
 *
 * Invariants pinned:
 *   - Missing file → DEFAULT_SYNC_STATE (not throw)
 *   - Corrupt JSON → DEFAULT_SYNC_STATE + warn
 *   - Invalid schema → DEFAULT_SYNC_STATE + warn
 *   - Round-trip write → read returns deep-equal shape
 *   - Atomic temp+rename — writes are visible only after rename (no .tmp debris)
 *   - updateSyncStateConflict is idempotent (duplicate unresolved = no-op)
 *   - clearSyncStateConflict sets resolvedAt (no actual removal)
 *   - authoritativeSide defaults to "openclaw" on fresh file
 *   - DEFAULT_SYNC_STATE carries the D-01 topology constants verbatim
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nanoid } from "nanoid";
import {
  DEFAULT_SYNC_STATE,
  DEFAULT_SYNC_STATE_PATH,
  DEFAULT_SYNC_JSONL_PATH,
  readSyncState,
  writeSyncState,
  updateSyncStateConflict,
  clearSyncStateConflict,
} from "../sync-state-store.js";
import type { SyncStateFile, SyncConflict } from "../types.js";

function makeWarnLogger() {
  return { warn: vi.fn(), debug: vi.fn() } as unknown as import("pino").Logger & {
    warn: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };
}

function freshState(overrides: Partial<SyncStateFile> = {}): SyncStateFile {
  return {
    ...DEFAULT_SYNC_STATE,
    updatedAt: "2026-04-24T19:00:00.000Z",
    lastSyncedAt: "2026-04-24T18:55:00.000Z",
    perFileHashes: { "MEMORY.md": "abc123" },
    ...overrides,
  };
}

describe("sync-state-store — DEFAULT_SYNC_STATE topology (D-01, D-02)", () => {
  it("defaults authoritativeSide to openclaw (pre-cutover baseline)", () => {
    expect(DEFAULT_SYNC_STATE.authoritativeSide).toBe("openclaw");
  });

  it("DEFAULT_SYNC_STATE_PATH lives under ~/.clawcode/manager/", () => {
    expect(DEFAULT_SYNC_STATE_PATH).toMatch(
      /\/\.clawcode\/manager\/sync-state\.json$/,
    );
  });

  it("DEFAULT_SYNC_JSONL_PATH is co-located with state (Plan 91-05 consumer)", () => {
    expect(DEFAULT_SYNC_JSONL_PATH).toMatch(
      /\/\.clawcode\/manager\/sync\.jsonl$/,
    );
  });

  it("DEFAULT_SYNC_STATE pins the D-01 fin-client topology", () => {
    expect(DEFAULT_SYNC_STATE.openClawHost).toBe("example-user@10.0.0.3");
    expect(DEFAULT_SYNC_STATE.openClawWorkspace).toBe(
      "/home/example-user/.openclaw/workspace-acme",
    );
    expect(DEFAULT_SYNC_STATE.clawcodeWorkspace).toBe(
      "/home/clawcode/.clawcode/agents/acme",
    );
  });
});

describe("sync-state-store — atomic JSON round-trip", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), `sync-state-${nanoid(6)}-`));
    filePath = join(tmpDir, "sync-state.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("readSyncState on missing file returns DEFAULT_SYNC_STATE (no warn)", async () => {
    const log = makeWarnLogger();
    const ghost = join(tmpDir, "never-existed.json");
    const state = await readSyncState(ghost, log);
    expect(state).toEqual(DEFAULT_SYNC_STATE);
    // First-boot path must be silent.
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("readSyncState on corrupt JSON returns DEFAULT_SYNC_STATE + warn", async () => {
    const log = makeWarnLogger();
    await writeFile(filePath, "{this is not json", "utf8");
    const state = await readSyncState(filePath, log);
    expect(state).toEqual(DEFAULT_SYNC_STATE);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("readSyncState on schema-invalid JSON returns DEFAULT_SYNC_STATE + warn", async () => {
    const log = makeWarnLogger();
    // version=2 is not valid — schema literal is 1
    const bogus = {
      version: 2,
      updatedAt: "",
      authoritativeSide: "openclaw",
      lastSyncedAt: null,
      openClawHost: "a",
      openClawWorkspace: "b",
      clawcodeWorkspace: "c",
      perFileHashes: {},
      conflicts: [],
      openClawSessionCursor: null,
    };
    await writeFile(filePath, JSON.stringify(bogus), "utf8");
    const state = await readSyncState(filePath, log);
    expect(state).toEqual(DEFAULT_SYNC_STATE);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("writeSyncState → readSyncState round-trips deep-equal", async () => {
    const original = freshState({
      authoritativeSide: "openclaw",
      perFileHashes: {
        "MEMORY.md": "deadbeef",
        "memory/2026-04-24.md": "cafe1234",
      },
    });
    await writeSyncState(filePath, original);
    const loaded = await readSyncState(filePath);
    expect(loaded).toEqual(original);
  });

  it("writeSyncState uses atomic temp+rename (no lingering .tmp debris)", async () => {
    await writeSyncState(filePath, freshState());
    const files = await readdir(tmpDir);
    expect(files).toContain("sync-state.json");
    expect(files.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  });

  it("writeSyncState persists pretty-printed JSON (diff-friendly on disk)", async () => {
    await writeSyncState(filePath, freshState());
    const raw = await readFile(filePath, "utf8");
    // 2-space indent per effort-state-store convention
    expect(raw).toContain('\n  "version": 1,');
  });

  it("fresh file ('never written') default has authoritativeSide=openclaw", async () => {
    const state = await readSyncState(filePath);
    expect(state.authoritativeSide).toBe("openclaw");
  });
});

describe("sync-state-store — conflict lifecycle (Plan 91-02 + 91-04)", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), `sync-state-conflicts-${nanoid(6)}-`));
    filePath = join(tmpDir, "sync-state.json");
    await writeSyncState(filePath, freshState());
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("updateSyncStateConflict appends a new unresolved conflict", async () => {
    const conflict: SyncConflict = {
      path: "MEMORY.md",
      sourceHash: "aaa",
      destHash: "bbb",
      detectedAt: "2026-04-24T19:10:00.000Z",
      resolvedAt: null,
    };
    await updateSyncStateConflict(filePath, conflict);
    const state = await readSyncState(filePath);
    expect(state.conflicts).toHaveLength(1);
    expect(state.conflicts[0]).toEqual(conflict);
  });

  it("updateSyncStateConflict is idempotent — duplicate unresolved is no-op", async () => {
    const conflict: SyncConflict = {
      path: "MEMORY.md",
      sourceHash: "aaa",
      destHash: "bbb",
      detectedAt: "2026-04-24T19:10:00.000Z",
      resolvedAt: null,
    };
    await updateSyncStateConflict(filePath, conflict);
    await updateSyncStateConflict(filePath, { ...conflict, sourceHash: "different" });
    const state = await readSyncState(filePath);
    expect(state.conflicts).toHaveLength(1);
    // Original kept — not overwritten with the second call.
    expect(state.conflicts[0]?.sourceHash).toBe("aaa");
  });

  it("clearSyncStateConflict sets resolvedAt on matching unresolved entry", async () => {
    const conflict: SyncConflict = {
      path: "MEMORY.md",
      sourceHash: "aaa",
      destHash: "bbb",
      detectedAt: "2026-04-24T19:10:00.000Z",
      resolvedAt: null,
    };
    await updateSyncStateConflict(filePath, conflict);
    await clearSyncStateConflict(filePath, "MEMORY.md");
    const state = await readSyncState(filePath);
    expect(state.conflicts).toHaveLength(1);
    expect(state.conflicts[0]?.resolvedAt).not.toBeNull();
  });

  it("clearSyncStateConflict on unknown path is a no-op (no error)", async () => {
    await expect(
      clearSyncStateConflict(filePath, "never-conflicted.md"),
    ).resolves.not.toThrow();
    const state = await readSyncState(filePath);
    expect(state.conflicts).toHaveLength(0);
  });

  it("after resolution, a fresh conflict for same path is appended (audit trail)", async () => {
    const conflict: SyncConflict = {
      path: "MEMORY.md",
      sourceHash: "aaa",
      destHash: "bbb",
      detectedAt: "2026-04-24T19:10:00.000Z",
      resolvedAt: null,
    };
    await updateSyncStateConflict(filePath, conflict);
    await clearSyncStateConflict(filePath, "MEMORY.md");
    await updateSyncStateConflict(filePath, {
      ...conflict,
      detectedAt: "2026-04-24T19:30:00.000Z",
      sourceHash: "ccc",
      destHash: "ddd",
    });
    const state = await readSyncState(filePath);
    expect(state.conflicts).toHaveLength(2);
  });
});
