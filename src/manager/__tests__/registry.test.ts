import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, readFile, stat, writeFile as wf } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  readRegistry,
  writeRegistry,
  updateEntry,
  createEntry,
  mutateRegistry,
  EMPTY_REGISTRY,
  reconcileRegistry,
  STOPPED_SUBAGENT_REAP_TTL_MS,
  _setFsyncForTests,
  type PrunedEntry,
} from "../registry.js";
import type { Registry, RegistryEntry } from "../types.js";
import { logger } from "../../shared/logger.js";

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "registry-test-"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("EMPTY_REGISTRY", () => {
  it("has empty entries and 0 updatedAt", () => {
    expect(EMPTY_REGISTRY.entries).toEqual([]);
    expect(EMPTY_REGISTRY.updatedAt).toBe(0);
  });
});

describe("createEntry", () => {
  it("creates an entry with default values", () => {
    const entry = createEntry("researcher");
    expect(entry.name).toBe("researcher");
    expect(entry.status).toBe("stopped");
    expect(entry.sessionId).toBeNull();
    expect(entry.startedAt).toBeNull();
    expect(entry.restartCount).toBe(0);
    expect(entry.consecutiveFailures).toBe(0);
    expect(entry.lastError).toBeNull();
    expect(entry.lastStableAt).toBeNull();
  });

  it("Phase 56 — defaults warm_path_ready=false and warm_path_readiness_ms=null", () => {
    const entry = createEntry("warm-defaults");
    expect(entry.warm_path_ready).toBe(false);
    expect(entry.warm_path_readiness_ms).toBeNull();
  });

  // clawdy-v2-stability (2026-04-19)
  it("defaults stoppedAt to null (field populated by stopAgent on transition)", () => {
    const entry = createEntry("sub-entry");
    expect(entry.stoppedAt).toBeNull();
  });
});

describe("readRegistry", () => {
  it("returns EMPTY_REGISTRY when file does not exist", async () => {
    const path = join(testDir, "nonexistent.json");
    const registry = await readRegistry(path);
    expect(registry).toEqual(EMPTY_REGISTRY);
  });

  it("returns parsed Registry when file exists with valid JSON", async () => {
    const path = join(testDir, "registry.json");
    const data: Registry = {
      entries: [createEntry("agent-1")],
      updatedAt: 12345,
    };
    await writeRegistry(path, data);
    const registry = await readRegistry(path);
    expect(registry.entries).toHaveLength(1);
    expect(registry.entries[0].name).toBe("agent-1");
    expect(registry.updatedAt).toBe(12345);
  });

  it("throws ManagerError on corrupt JSON", async () => {
    const path = join(testDir, "registry.json");
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(path, "not valid json{{{", "utf-8");
    await expect(readRegistry(path)).rejects.toThrow("Corrupt registry file");
  });
});

describe("writeRegistry", () => {
  it("writes valid JSON to the specified path", async () => {
    const path = join(testDir, "registry.json");
    const data: Registry = {
      entries: [createEntry("writer")],
      updatedAt: 99999,
    };
    await writeRegistry(path, data);
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.entries[0].name).toBe("writer");
  });

  it("uses atomic write (tmp file should not remain)", async () => {
    const path = join(testDir, "registry.json");
    await writeRegistry(path, EMPTY_REGISTRY);
    // tmp file should be renamed away
    const tmpPath = `${path}.tmp`;
    await expect(stat(tmpPath)).rejects.toThrow();
  });

  it("creates parent directories if they do not exist", async () => {
    const path = join(testDir, "nested", "deep", "registry.json");
    await writeRegistry(path, EMPTY_REGISTRY);
    const raw = await readFile(path, "utf-8");
    expect(JSON.parse(raw)).toEqual(EMPTY_REGISTRY);
  });

  it("roundtrips with readRegistry", async () => {
    const path = join(testDir, "registry.json");
    const entry = createEntry("roundtrip-agent");
    const original: Registry = { entries: [entry], updatedAt: 42 };
    await writeRegistry(path, original);
    const read = await readRegistry(path);
    expect(read).toEqual(original);
  });
});

describe("updateEntry", () => {
  it("returns a new Registry with the updated entry", () => {
    const entry = createEntry("agent-1");
    const registry: Registry = { entries: [entry], updatedAt: 100 };
    const updated = updateEntry(registry, "agent-1", { status: "running", sessionId: "sess-123" });
    expect(updated.entries[0].status).toBe("running");
    expect(updated.entries[0].sessionId).toBe("sess-123");
    expect(updated.entries[0].name).toBe("agent-1");
  });

  it("does not mutate the original registry", () => {
    const entry = createEntry("agent-1");
    const registry: Registry = { entries: [entry], updatedAt: 100 };
    const updated = updateEntry(registry, "agent-1", { status: "running" });
    // Original unchanged
    expect(registry.entries[0].status).toBe("stopped");
    // Updated is new object
    expect(updated).not.toBe(registry);
    expect(updated.entries).not.toBe(registry.entries);
    expect(updated.entries[0]).not.toBe(registry.entries[0]);
  });

  it("updates updatedAt timestamp", () => {
    const registry: Registry = { entries: [createEntry("a")], updatedAt: 100 };
    const updated = updateEntry(registry, "a", { status: "starting" });
    expect(updated.updatedAt).toBeGreaterThan(100);
  });

  it("throws for non-existing agent", () => {
    const registry: Registry = { entries: [createEntry("a")], updatedAt: 100 };
    expect(() => updateEntry(registry, "nonexistent", { status: "running" })).toThrow();
  });

  it("preserves other entries unchanged", () => {
    const registry: Registry = {
      entries: [createEntry("a"), createEntry("b")],
      updatedAt: 100,
    };
    const updated = updateEntry(registry, "a", { status: "running" });
    expect(updated.entries[1]).toEqual(createEntry("b"));
  });

  it("Phase 56 — accepts warm_path_ready + warm_path_readiness_ms updates", () => {
    const registry: Registry = {
      entries: [createEntry("warm-target")],
      updatedAt: 100,
    };
    const updated = updateEntry(registry, "warm-target", {
      warm_path_ready: true,
      warm_path_readiness_ms: 127,
    });
    expect(updated.entries[0].warm_path_ready).toBe(true);
    expect(updated.entries[0].warm_path_readiness_ms).toBe(127);
  });
});

describe("reconcileRegistry", () => {
  const mkEntry = (name: string): RegistryEntry => createEntry(name);
  /**
   * Sub/thread entries need status="running" to survive the TTL reap path
   * (added 2026-04-19 for clawdy-v2-stability). Pre-TTL tests that called
   * `mkEntry` for sub/thread rows effectively created stopped-with-null-stoppedAt
   * entries, which the new reap logic (correctly) prunes as legacy zombies.
   * Use this helper when the test intends to represent a live subagent/thread.
   */
  const mkLiveSubEntry = (name: string): RegistryEntry => ({
    ...createEntry(name),
    status: "running",
  });

  it("returns input unchanged (reference equality) for an empty registry", () => {
    const result = reconcileRegistry(EMPTY_REGISTRY, new Set<string>());
    expect(result.registry).toBe(EMPTY_REGISTRY);
    expect(result.pruned).toEqual([]);
  });

  it("returns input unchanged when all entries are configured", () => {
    const registry: Registry = {
      entries: [mkEntry("clawdy"), mkEntry("admin-clawdy")],
      updatedAt: 100,
    };
    const known = new Set<string>(["clawdy", "admin-clawdy"]);
    const result = reconcileRegistry(registry, known);
    expect(result.registry).toBe(registry);
    expect(result.pruned).toEqual([]);
  });

  it("prunes an unknown entry with reason 'unknown-agent' and preserves order of kept entries", () => {
    const registry: Registry = {
      entries: [mkEntry("clawdy"), mkEntry("ghost-agent"), mkEntry("admin-clawdy")],
      updatedAt: 100,
    };
    const known = new Set<string>(["clawdy", "admin-clawdy"]);
    const result = reconcileRegistry(registry, known);
    expect(result.pruned).toEqual<readonly PrunedEntry[]>([
      { name: "ghost-agent", reason: "unknown-agent" },
    ]);
    expect(result.registry.entries.map((e) => e.name)).toEqual([
      "clawdy",
      "admin-clawdy",
    ]);
  });

  it("rename scenario — 'Admin Clawdy' pruned, 'admin-clawdy' retained", () => {
    const registry: Registry = {
      entries: [mkEntry("Admin Clawdy"), mkEntry("admin-clawdy")],
      updatedAt: 100,
    };
    const known = new Set<string>(["admin-clawdy"]);
    const result = reconcileRegistry(registry, known);
    expect(result.pruned).toEqual<readonly PrunedEntry[]>([
      { name: "Admin Clawdy", reason: "unknown-agent" },
    ]);
    expect(result.registry.entries.map((e) => e.name)).toEqual(["admin-clawdy"]);
  });

  it("retains a live subagent entry when its parent is configured", () => {
    const registry: Registry = {
      entries: [mkLiveSubEntry("atlas-sub-abc123")],
      updatedAt: 100,
    };
    const known = new Set<string>(["atlas"]);
    const result = reconcileRegistry(registry, known);
    expect(result.pruned).toEqual([]);
    expect(result.registry).toBe(registry);
  });

  it("prunes an orphaned subagent (unknown parent)", () => {
    const registry: Registry = {
      entries: [mkEntry("ghost-sub-xyz")],
      updatedAt: 100,
    };
    const known = new Set<string>(["atlas"]);
    const result = reconcileRegistry(registry, known);
    expect(result.pruned).toEqual<readonly PrunedEntry[]>([
      { name: "ghost-sub-xyz", reason: "orphaned-subagent" },
    ]);
    expect(result.registry.entries).toEqual([]);
  });

  it("retains a live thread entry when its parent is configured", () => {
    const registry: Registry = {
      entries: [mkLiveSubEntry("clawdy-thread-1234")],
      updatedAt: 100,
    };
    const known = new Set<string>(["clawdy"]);
    const result = reconcileRegistry(registry, known);
    expect(result.pruned).toEqual([]);
    expect(result.registry).toBe(registry);
  });

  it("prunes an orphaned thread (unknown parent)", () => {
    const registry: Registry = {
      entries: [mkEntry("ghost-thread-567")],
      updatedAt: 100,
    };
    const known = new Set<string>(["clawdy"]);
    const result = reconcileRegistry(registry, known);
    expect(result.pruned).toEqual<readonly PrunedEntry[]>([
      { name: "ghost-thread-567", reason: "orphaned-thread" },
    ]);
    expect(result.registry.entries).toEqual([]);
  });

  it("mixed real-world scenario prunes in registry order and keeps live entries", () => {
    const registry: Registry = {
      entries: [
        mkEntry("clawdy"),
        mkEntry("Admin Clawdy"),
        mkEntry("admin-clawdy"),
        mkLiveSubEntry("clawdy-sub-abc"),
        mkLiveSubEntry("ghost-sub-def"),
        mkLiveSubEntry("clawdy-thread-1"),
        mkLiveSubEntry("ghost-thread-2"),
      ],
      updatedAt: 100,
    };
    const known = new Set<string>(["clawdy", "admin-clawdy"]);
    const result = reconcileRegistry(registry, known);
    expect(result.registry.entries.map((e) => e.name)).toEqual([
      "clawdy",
      "admin-clawdy",
      "clawdy-sub-abc",
      "clawdy-thread-1",
    ]);
    expect(result.pruned).toEqual<readonly PrunedEntry[]>([
      { name: "Admin Clawdy", reason: "unknown-agent" },
      { name: "ghost-sub-def", reason: "orphaned-subagent" },
      { name: "ghost-thread-2", reason: "orphaned-thread" },
    ]);
  });

  it("is immutable — original registry and entries array untouched when pruning occurs", () => {
    const originalEntries: readonly RegistryEntry[] = [
      mkEntry("clawdy"),
      mkEntry("ghost-agent"),
    ];
    const registry: Registry = {
      entries: originalEntries,
      updatedAt: 100,
    };
    const known = new Set<string>(["clawdy"]);
    const result = reconcileRegistry(registry, known);
    // Original array and registry untouched
    expect(registry.entries).toBe(originalEntries);
    expect(registry.entries.map((e) => e.name)).toEqual(["clawdy", "ghost-agent"]);
    expect(registry.updatedAt).toBe(100);
    // Returned registry is a new object
    expect(result.registry).not.toBe(registry);
    expect(result.registry.entries).not.toBe(registry.entries);
  });

  it("bumps updatedAt when pruning occurs", () => {
    const before = Date.now();
    const registry: Registry = {
      entries: [mkEntry("ghost")],
      updatedAt: 100,
    };
    const known = new Set<string>(["clawdy"]);
    const result = reconcileRegistry(registry, known);
    expect(result.registry.updatedAt).toBeGreaterThan(100);
    expect(result.registry.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it("treats empty-parent '-sub-foo' as orphaned-subagent (never matched against known agents)", () => {
    const registry: Registry = {
      entries: [mkEntry("-sub-foo")],
      updatedAt: 100,
    };
    // Even if the empty string were somehow in the set, it must not be treated as a live parent.
    const known = new Set<string>(["", "clawdy"]);
    const result = reconcileRegistry(registry, known);
    expect(result.pruned).toEqual<readonly PrunedEntry[]>([
      { name: "-sub-foo", reason: "orphaned-subagent" },
    ]);
    expect(result.registry.entries).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // clawdy-v2-stability (2026-04-19) — TTL-based reap for stopped sub/thread
  // entries. Before this fix, stopAgent left permanent "gravestones" in the
  // registry that the dashboard SSE loop hit every memory poll, generating
  // "Memory store not found" log spam at level 50.
  // -------------------------------------------------------------------------
  describe("stopped sub/thread TTL reap", () => {
    const NOW = 2_000_000_000_000; // deterministic epoch
    const TTL = STOPPED_SUBAGENT_REAP_TTL_MS;

    /** Helper: sub/thread entry with status+stoppedAt injected. */
    const stoppedSub = (name: string, stoppedAt: number | null | undefined): RegistryEntry => ({
      ...createEntry(name),
      status: "stopped",
      stoppedAt,
    });

    it("prunes a stopped subagent whose stoppedAt is older than the TTL", () => {
      const registry: Registry = {
        entries: [stoppedSub("clawdy-sub-abc", NOW - TTL - 1)],
        updatedAt: 100,
      };
      const known = new Set<string>(["clawdy"]);
      const result = reconcileRegistry(registry, known, { now: NOW });
      expect(result.pruned).toEqual<readonly PrunedEntry[]>([
        { name: "clawdy-sub-abc", reason: "stale-subagent" },
      ]);
      expect(result.registry.entries).toEqual([]);
    });

    it("retains a stopped subagent whose stoppedAt is within the TTL (recently stopped)", () => {
      const registry: Registry = {
        entries: [stoppedSub("clawdy-sub-recent", NOW - 1000)],
        updatedAt: 100,
      };
      const known = new Set<string>(["clawdy"]);
      const result = reconcileRegistry(registry, known, { now: NOW });
      expect(result.pruned).toEqual([]);
      expect(result.registry).toBe(registry); // reference-equal on clean pass
    });

    it("prunes a stopped subagent with stoppedAt exactly at the TTL boundary", () => {
      const registry: Registry = {
        entries: [stoppedSub("clawdy-sub-boundary", NOW - TTL)],
        updatedAt: 100,
      };
      const known = new Set<string>(["clawdy"]);
      const result = reconcileRegistry(registry, known, { now: NOW });
      expect(result.pruned).toEqual<readonly PrunedEntry[]>([
        { name: "clawdy-sub-boundary", reason: "stale-subagent" },
      ]);
    });

    it("prunes a legacy stopped subagent with missing stoppedAt (treat as long-stopped)", () => {
      const registry: Registry = {
        entries: [stoppedSub("clawdy-sub-legacy", undefined)],
        updatedAt: 100,
      };
      const known = new Set<string>(["clawdy"]);
      const result = reconcileRegistry(registry, known, { now: NOW });
      expect(result.pruned).toEqual<readonly PrunedEntry[]>([
        { name: "clawdy-sub-legacy", reason: "stale-subagent" },
      ]);
      expect(result.registry.entries).toEqual([]);
    });

    it("prunes a legacy stopped subagent with null stoppedAt (same as missing)", () => {
      const registry: Registry = {
        entries: [stoppedSub("clawdy-sub-null", null)],
        updatedAt: 100,
      };
      const known = new Set<string>(["clawdy"]);
      const result = reconcileRegistry(registry, known, { now: NOW });
      expect(result.pruned).toEqual<readonly PrunedEntry[]>([
        { name: "clawdy-sub-null", reason: "stale-subagent" },
      ]);
    });

    it("retains a running subagent regardless of stoppedAt", () => {
      const runningSub: RegistryEntry = {
        ...createEntry("clawdy-sub-running"),
        status: "running",
        // Even if stoppedAt is ancient (from a prior stop → restart cycle),
        // the current status is "running" so the entry must be kept.
        stoppedAt: NOW - TTL - 10_000_000,
      };
      const registry: Registry = { entries: [runningSub], updatedAt: 100 };
      const known = new Set<string>(["clawdy"]);
      const result = reconcileRegistry(registry, known, { now: NOW });
      expect(result.pruned).toEqual([]);
      expect(result.registry).toBe(registry);
    });

    it("prunes a stale thread entry with the 'stale-thread' reason", () => {
      const registry: Registry = {
        entries: [stoppedSub("clawdy-thread-xyz", NOW - TTL - 1)],
        updatedAt: 100,
      };
      const known = new Set<string>(["clawdy"]);
      const result = reconcileRegistry(registry, known, { now: NOW });
      expect(result.pruned).toEqual<readonly PrunedEntry[]>([
        { name: "clawdy-thread-xyz", reason: "stale-thread" },
      ]);
    });

    it("does NOT TTL-reap the parent agent even when it is stopped for ages", () => {
      // Parent agents represent configured agents and the operator expects
      // them to persist across daemon boots regardless of stopped-age.
      const registry: Registry = {
        entries: [stoppedSub("clawdy", NOW - TTL - 999_999)],
        updatedAt: 100,
      };
      const known = new Set<string>(["clawdy"]);
      const result = reconcileRegistry(registry, known, { now: NOW });
      expect(result.pruned).toEqual([]);
      expect(result.registry).toBe(registry);
    });

    it("orphaned-subagent takes precedence over stale-subagent (unknown parent reason wins)", () => {
      // If the parent is gone AND the entry is stopped beyond TTL, the
      // orphan reason is more informative — record that, not the stale TTL.
      const registry: Registry = {
        entries: [stoppedSub("gone-sub-xyz", NOW - TTL - 1)],
        updatedAt: 100,
      };
      const known = new Set<string>(["clawdy"]); // "gone" is not here
      const result = reconcileRegistry(registry, known, { now: NOW });
      expect(result.pruned).toEqual<readonly PrunedEntry[]>([
        { name: "gone-sub-xyz", reason: "orphaned-subagent" },
      ]);
    });

    it("mixed scenario: one stale-sub, one stale-thread, one fresh-sub, parent kept", () => {
      const registry: Registry = {
        entries: [
          mkEntry("clawdy"),
          stoppedSub("clawdy-sub-stale", NOW - TTL - 1),
          stoppedSub("clawdy-thread-stale", NOW - TTL - 1),
          stoppedSub("clawdy-sub-fresh", NOW - 1000),
        ],
        updatedAt: 100,
      };
      const known = new Set<string>(["clawdy"]);
      const result = reconcileRegistry(registry, known, { now: NOW });
      expect(result.registry.entries.map((e) => e.name)).toEqual([
        "clawdy",
        "clawdy-sub-fresh",
      ]);
      expect(result.pruned).toEqual<readonly PrunedEntry[]>([
        { name: "clawdy-sub-stale", reason: "stale-subagent" },
        { name: "clawdy-thread-stale", reason: "stale-thread" },
      ]);
      expect(result.registry.updatedAt).toBe(NOW);
    });

    it("custom reapTtlMs overrides the default (shorter TTL for aggressive reap)", () => {
      const registry: Registry = {
        entries: [stoppedSub("clawdy-sub-a", NOW - 5000)],
        updatedAt: 100,
      };
      const known = new Set<string>(["clawdy"]);
      // Default TTL would keep this (stoppedAt is only 5s old). Custom 1s TTL reaps.
      const result = reconcileRegistry(registry, known, { now: NOW, reapTtlMs: 1000 });
      expect(result.pruned).toEqual<readonly PrunedEntry[]>([
        { name: "clawdy-sub-a", reason: "stale-subagent" },
      ]);
    });
  });

  // clawdy-v2-stability follow-up (2026-04-19) — phantom reaping at daemon boot.
  // A subagent process cannot survive a daemon restart, so any sub/thread entry
  // that was still marked non-stopped when the prior daemon exited is a phantom
  // the moment the new daemon starts. The `pruneNonStoppedSubagents` flag enables
  // the boot-time sweep; without the flag, behavior is unchanged (back-compat).
  describe("pruneNonStoppedSubagents (boot-time phantom reap)", () => {
    const NOW = 1_000_000_000;
    const runningSub = (name: string): RegistryEntry => ({
      ...createEntry(name),
      status: "running",
      startedAt: NOW - 10_000,
    });
    const startingSub = (name: string): RegistryEntry => ({
      ...createEntry(name),
      status: "starting",
      startedAt: NOW - 10_000,
    });

    it("flag=false (default): non-stopped subagent with known parent is retained", () => {
      const registry: Registry = {
        entries: [runningSub("clawdy-sub-abc")],
        updatedAt: 100,
      };
      const known = new Set<string>(["clawdy"]);
      const result = reconcileRegistry(registry, known, { now: NOW });
      expect(result.pruned).toEqual([]);
      expect(result.registry).toBe(registry);
    });

    it("flag=true: running subagent with known parent pruned as phantom-subagent", () => {
      const registry: Registry = {
        entries: [runningSub("clawdy-sub-abc")],
        updatedAt: 100,
      };
      const known = new Set<string>(["clawdy"]);
      const result = reconcileRegistry(registry, known, {
        now: NOW,
        pruneNonStoppedSubagents: true,
      });
      expect(result.pruned).toEqual<readonly PrunedEntry[]>([
        { name: "clawdy-sub-abc", reason: "phantom-subagent" },
      ]);
      expect(result.registry.entries).toEqual([]);
    });

    it("flag=true: starting subagent also classified as phantom", () => {
      const registry: Registry = {
        entries: [startingSub("clawdy-sub-xyz")],
        updatedAt: 100,
      };
      const known = new Set<string>(["clawdy"]);
      const result = reconcileRegistry(registry, known, {
        now: NOW,
        pruneNonStoppedSubagents: true,
      });
      expect(result.pruned).toEqual<readonly PrunedEntry[]>([
        { name: "clawdy-sub-xyz", reason: "phantom-subagent" },
      ]);
    });

    it("flag=true: running thread with known parent pruned as phantom-thread", () => {
      const registry: Registry = {
        entries: [
          { ...createEntry("clawdy-thread-1"), status: "running" },
        ],
        updatedAt: 100,
      };
      const known = new Set<string>(["clawdy"]);
      const result = reconcileRegistry(registry, known, {
        now: NOW,
        pruneNonStoppedSubagents: true,
      });
      expect(result.pruned).toEqual<readonly PrunedEntry[]>([
        { name: "clawdy-thread-1", reason: "phantom-thread" },
      ]);
    });

    it("flag=true: orphaned non-stopped subagent still pruned as orphaned-subagent (orphan precedence preserved)", () => {
      // Parent missing wins over phantom status — the operator wants the more
      // informative reason.
      const registry: Registry = {
        entries: [runningSub("gone-sub-xyz")],
        updatedAt: 100,
      };
      const known = new Set<string>(["clawdy"]); // "gone" is not configured
      const result = reconcileRegistry(registry, known, {
        now: NOW,
        pruneNonStoppedSubagents: true,
      });
      expect(result.pruned).toEqual<readonly PrunedEntry[]>([
        { name: "gone-sub-xyz", reason: "orphaned-subagent" },
      ]);
    });

    it("flag=true: stopped-within-TTL subagent still retained (phantom check only applies to non-stopped)", () => {
      const registry: Registry = {
        entries: [
          {
            ...createEntry("clawdy-sub-fresh"),
            status: "stopped",
            stoppedAt: NOW - 1000,
          },
        ],
        updatedAt: 100,
      };
      const known = new Set<string>(["clawdy"]);
      const result = reconcileRegistry(registry, known, {
        now: NOW,
        pruneNonStoppedSubagents: true,
      });
      expect(result.pruned).toEqual([]);
      expect(result.registry).toBe(registry);
    });

    it("flag=true: parent agent marked running is NEVER phantom-pruned (rule 1 exempts parents)", () => {
      const registry: Registry = {
        entries: [{ ...createEntry("clawdy"), status: "running" }],
        updatedAt: 100,
      };
      const known = new Set<string>(["clawdy"]);
      const result = reconcileRegistry(registry, known, {
        now: NOW,
        pruneNonStoppedSubagents: true,
      });
      expect(result.pruned).toEqual([]);
      expect(result.registry).toBe(registry);
    });

    it("flag=true: mixed boot state — 2 phantoms + 1 legacy zombie + 1 configured parent", () => {
      const registry: Registry = {
        entries: [
          { ...createEntry("clawdy"), status: "running" }, // parent — kept
          runningSub("clawdy-sub-phantom-a"),              // phantom-subagent
          { ...createEntry("clawdy-thread-phantom-b"), status: "starting" }, // phantom-thread
          createEntry("clawdy-sub-legacy"),                // legacy null-stoppedAt zombie → stale
        ],
        updatedAt: 100,
      };
      const known = new Set<string>(["clawdy"]);
      const result = reconcileRegistry(registry, known, {
        now: NOW,
        pruneNonStoppedSubagents: true,
      });
      expect(result.registry.entries.map((e) => e.name)).toEqual(["clawdy"]);
      expect(result.pruned).toEqual<readonly PrunedEntry[]>([
        { name: "clawdy-sub-phantom-a", reason: "phantom-subagent" },
        { name: "clawdy-thread-phantom-b", reason: "phantom-thread" },
        { name: "clawdy-sub-legacy", reason: "stale-subagent" },
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// 260419-q2z Fix C — atomic writeRegistry + readRegistry recovery path.
// ---------------------------------------------------------------------------
describe("260419-q2z — writeRegistry atomic write + .bak pre-write backup", () => {
  it("writeRegistry copies existing path to path.bak BEFORE overwriting (second write leaves .bak of FIRST write)", async () => {
    const path = join(testDir, "registry.json");
    const first: Registry = { entries: [createEntry("first")], updatedAt: 1 };
    const second: Registry = { entries: [createEntry("second")], updatedAt: 2 };

    // First write — no prior file, no .bak created.
    await writeRegistry(path, first);
    const bakAfterFirst = `${path}.bak`;
    await expect(stat(bakAfterFirst)).rejects.toThrow();

    // Second write — existing path copied to .bak BEFORE overwrite.
    await writeRegistry(path, second);
    const bakRaw = await readFile(bakAfterFirst, "utf-8");
    const bakParsed = JSON.parse(bakRaw);
    expect(bakParsed.entries[0].name).toBe("first");
    expect(bakParsed.updatedAt).toBe(1);

    // Main path reflects the SECOND write.
    const mainRaw = await readFile(path, "utf-8");
    expect(JSON.parse(mainRaw).entries[0].name).toBe("second");
  });

  it("writeRegistry does not create .bak when path does not yet exist", async () => {
    const path = join(testDir, "fresh.json");
    await writeRegistry(path, EMPTY_REGISTRY);
    await expect(stat(`${path}.bak`)).rejects.toThrow();
  });
});

describe("260419-q2z — fsync best-effort", () => {
  afterEach(() => {
    _setFsyncForTests(null);
  });

  it("writeRegistry succeeds on a mount where fsync is rejected (EINVAL)", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      _setFsyncForTests(() => {
        const err = new Error("bad fd") as NodeJS.ErrnoException;
        err.code = "EINVAL";
        return Promise.reject(err);
      });

      const path = join(testDir, "einval.json");
      const data: Registry = { entries: [createEntry("einval-agent")], updatedAt: 7 };

      // Must not throw even though fsync rejects.
      await writeRegistry(path, data);

      const raw = await readFile(path, "utf-8");
      expect(JSON.parse(raw).entries[0].name).toBe("einval-agent");

      // Warn logged with the exact fsync-skipped phrase.
      const calls = warnSpy.mock.calls.map((c) => JSON.stringify(c));
      expect(calls.some((s) => s.includes("fsync skipped"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("260419-q2z — readRegistry recovery from .bak and .tmp", () => {
  it("recovers from .bak when path is corrupt JSON", async () => {
    const path = join(testDir, "registry.json");
    const validBak: Registry = { entries: [createEntry("bak-winner")], updatedAt: 500 };
    await wf(path, "{not valid", "utf-8");
    await wf(`${path}.bak`, JSON.stringify(validBak, null, 2), "utf-8");

    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const registry = await readRegistry(path);
      expect(registry.entries[0].name).toBe("bak-winner");
      expect(registry.updatedAt).toBe(500);
      const calls = warnSpy.mock.calls.map((c) => JSON.stringify(c));
      expect(calls.some((s) => s.includes("recovered from .bak"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("prefers path over .bak when BOTH are valid", async () => {
    const path = join(testDir, "registry.json");
    const valid: Registry = { entries: [createEntry("main-winner")], updatedAt: 2 };
    const bak: Registry = { entries: [createEntry("bak-loser")], updatedAt: 1 };
    await wf(path, JSON.stringify(valid, null, 2), "utf-8");
    await wf(`${path}.bak`, JSON.stringify(bak, null, 2), "utf-8");

    const registry = await readRegistry(path);
    expect(registry.entries[0].name).toBe("main-winner");
  });

  it("recovers from .tmp when path is corrupt AND .bak is absent (mid-rename crash)", async () => {
    const path = join(testDir, "registry.json");
    const validTmp: Registry = { entries: [createEntry("tmp-winner")], updatedAt: 9 };
    await wf(path, "garbage{{", "utf-8");
    await wf(`${path}.tmp`, JSON.stringify(validTmp, null, 2), "utf-8");

    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const registry = await readRegistry(path);
      expect(registry.entries[0].name).toBe("tmp-winner");
      const calls = warnSpy.mock.calls.map((c) => JSON.stringify(c));
      expect(calls.some((s) => s.includes("recovered from .tmp"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("throws ManagerError with repair hint when path AND .bak AND .tmp are all corrupt", async () => {
    const path = join(testDir, "registry.json");
    await wf(path, "{garbage", "utf-8");
    await wf(`${path}.bak`, "also broken", "utf-8");
    await wf(`${path}.tmp`, "{still broken", "utf-8");

    await expect(readRegistry(path)).rejects.toThrow(/Corrupt registry file at /);
    await expect(readRegistry(path)).rejects.toThrow(/clawcode registry repair/);
  });

  it("regression — recovers from .bak when path was truncated mid-write (today's outage shape)", async () => {
    const path = join(testDir, "registry.json");
    const truncated = '{"entries":[{"name":"clawdy","status":"running"';
    const validBak: Registry = {
      entries: [createEntry("recovered-clawdy")],
      updatedAt: 777,
    };
    await wf(path, truncated, "utf-8");
    await wf(`${path}.bak`, JSON.stringify(validBak, null, 2), "utf-8");

    const registry = await readRegistry(path);
    expect(registry.entries[0].name).toBe("recovered-clawdy");
    expect(registry.updatedAt).toBe(777);
  });
});

describe("260419-q2z — writeRegistry concurrent-safety light check", () => {
  it("completes even when tmp file already exists from a prior interrupted write", async () => {
    const path = join(testDir, "registry.json");
    const tmpPath = `${path}.tmp`;
    // Pre-create stale tmp garbage.
    await wf(tmpPath, "{{stale-garbage", "utf-8");

    const data: Registry = { entries: [createEntry("survivor")], updatedAt: 42 };
    await writeRegistry(path, data);

    // No residual tmp after the write.
    await expect(stat(tmpPath)).rejects.toThrow();
    // Main path holds the NEW registry.
    const raw = await readFile(path, "utf-8");
    expect(JSON.parse(raw).entries[0].name).toBe("survivor");
  });
});

describe("Phase 56 — backward compatibility for pre-warm-path registries", () => {
  it("readRegistry parses an entry missing warm_path_* fields (undefined === not-ready)", async () => {
    const path = join(testDir, "legacy.json");
    // Simulate a pre-Phase-56 registry: no warm_path_ready / warm_path_readiness_ms keys.
    const legacyJson = JSON.stringify({
      entries: [
        {
          name: "legacy-agent",
          status: "running",
          sessionId: "sess-legacy",
          startedAt: 1_700_000_000_000,
          restartCount: 0,
          consecutiveFailures: 0,
          lastError: null,
          lastStableAt: 1_700_000_000_000,
        },
      ],
      updatedAt: 1_700_000_000_000,
    });
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(path, legacyJson, "utf-8");

    const registry = await readRegistry(path);
    expect(registry.entries).toHaveLength(1);
    const entry = registry.entries[0];
    expect(entry.name).toBe("legacy-agent");
    // Optional fields absent → undefined, which consumers treat as not-ready.
    expect(entry.warm_path_ready).toBeUndefined();
    expect(entry.warm_path_readiness_ms).toBeUndefined();
    // The Partial<RegistryEntry> contract: the type must permit absence.
    const treatedAsReady = entry.warm_path_ready ?? false;
    expect(treatedAsReady).toBe(false);
  });
});

describe("mutateRegistry — concurrent lost-update guard", () => {
  // The bug this closes: workflow fan-out spawned worker sessions concurrently,
  // two SessionManager.startAgent calls each did readRegistry → updateEntry →
  // writeRegistry, both read the same base snapshot, and the second write
  // clobbered the first's entry — the clobbered worker then threw "Agent
  // '<name>' not found in registry" (registry.ts updateEntry). mutateRegistry
  // serializes the whole read-modify-write behind a per-path promise chain.

  it("serializes N concurrent read-modify-writes so every entry survives", async () => {
    const path = join(testDir, "registry.json");
    const N = 12;

    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        mutateRegistry(path, (current) => ({
          entries: [...current.entries, createEntry(`agent-${i}`)],
          updatedAt: current.updatedAt + 1,
        })),
      ),
    );

    const final = await readRegistry(path);
    const names = final.entries.map((e) => e.name).sort();
    // Not one lost: all N concurrent appends are present.
    expect(final.entries).toHaveLength(N);
    expect(names).toEqual(
      Array.from({ length: N }, (_, i) => `agent-${i}`).sort(),
    );
  });

  it("control: raw readRegistry→writeRegistry concurrently LOSES entries (proves the test detects the race)", async () => {
    const path = join(testDir, "registry.json");
    const N = 12;

    // The exact pre-fix pattern, WITHOUT the lock. The setTimeout(0) yield
    // forces every read to observe the same empty base before any write lands,
    // so the lost-update is deterministic — last writer wins, the rest vanish.
    await Promise.all(
      Array.from({ length: N }, async (_, i) => {
        const current = await readRegistry(path);
        await new Promise((r) => setTimeout(r, 0));
        await writeRegistry(path, {
          entries: [...current.entries, createEntry(`agent-${i}`)],
          updatedAt: current.updatedAt + 1,
        });
      }),
    );

    const final = await readRegistry(path);
    // Far fewer than N survive — this is the bug mutateRegistry eliminates.
    // (Asserting < N rather than === 1 keeps the test robust to scheduler
    // timing while still proving entries were clobbered.)
    expect(final.entries.length).toBeLessThan(N);
  });

  it("skips the write when the mutator returns the same reference (no-op)", async () => {
    const path = join(testDir, "registry.json");
    await mutateRegistry(path, (current) => ({
      entries: [...current.entries, createEntry("a")],
      updatedAt: current.updatedAt + 1,
    }));
    const before = await readRegistry(path);

    // No-op mutator returns the input unchanged → write skipped, updatedAt held.
    const result = await mutateRegistry(path, (current) => current);
    const after = await readRegistry(path);

    expect(result).toEqual(before);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.entries).toHaveLength(1);
  });

  it("normalizes the path key so different spellings of one file share the lock", async () => {
    const path = join(testDir, "registry.json");
    // Same file, un-normalized spelling. resolve() must collapse both to one
    // chain key — otherwise the two spellings bifurcate and lose-update.
    const dotted = `${testDir}/./registry.json`;
    const N = 8;

    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        mutateRegistry(i % 2 === 0 ? path : dotted, (current) => ({
          entries: [...current.entries, createEntry(`agent-${i}`)],
          updatedAt: current.updatedAt + 1,
        })),
      ),
    );

    const final = await readRegistry(path);
    expect(final.entries).toHaveLength(N);
  });
});
