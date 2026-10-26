/**
 * Unit tests for the shared dream machinery — specifically
 * `deriveLastTurnAt`, the ConversationStore-backed `lastTurnAt` source.
 *
 * WHY THIS MATTERS:
 *   Before this module the `run-dream-pass` IPC handler resolved
 *   `lastTurnAt` via `(manager as unknown as { getLastTurnAt? }).
 *   getLastTurnAt?.(agent)` — but `SessionManager` has NO `getLastTurnAt`
 *   method, so that expression ALWAYS returned `null`. A dream cron
 *   wired against a null lastTurnAt registers but never fires
 *   (`isAgentIdle(null)` → `no-prior-turn`). `deriveLastTurnAt` is the
 *   real source; these tests pin its behaviour.
 */

import { describe, it, expect, vi } from "vitest";
import type { Logger } from "pino";
import {
  deriveLastTurnAt,
  LAST_TURN_SESSION_SCAN_LIMIT,
  type DreamMachineryManager,
} from "../dream-machinery.js";

/** Minimal pino-shaped logger stub. */
function makeLog(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

type FakeSession = { readonly id: string };
type FakeTurn = { readonly createdAt: string };

/**
 * Build a fake `DreamMachineryManager` whose ConversationStore returns
 * the supplied sessions + per-session turns.
 */
function makeManager(
  sessions: readonly FakeSession[],
  turnsBySession: Readonly<Record<string, readonly FakeTurn[]>>,
  opts: { throwOnList?: boolean; noStore?: boolean } = {},
): DreamMachineryManager {
  const store = {
    listRecentSessions: (_agent: string, _limit: number) => {
      if (opts.throwOnList) throw new Error("boom");
      return sessions;
    },
    getTurnsForSession: (sessionId: string) =>
      turnsBySession[sessionId] ?? [],
  };
  return {
    getMemoryStore: () => undefined,
    getConversationStore: () =>
      opts.noStore
        ? undefined
        : (store as unknown as ReturnType<
            DreamMachineryManager["getConversationStore"]
          >),
  };
}

describe("deriveLastTurnAt", () => {
  it("returns null when the agent has no live ConversationStore", () => {
    const manager = makeManager([], {}, { noStore: true });
    expect(deriveLastTurnAt("agent-a", manager, makeLog())).toBeNull();
  });

  it("returns null when no session has any turns (agent never spoke)", () => {
    const manager = makeManager([{ id: "s1" }, { id: "s2" }], {
      s1: [],
      s2: [],
    });
    // null is the correct "no-prior-turn" signal — a cron must NOT dream
    // an agent that never spoke.
    expect(deriveLastTurnAt("agent-a", manager, makeLog())).toBeNull();
  });

  it("returns the max createdAt across turns in the most recent session", () => {
    const manager = makeManager([{ id: "s1" }], {
      s1: [
        { createdAt: "2026-05-20T01:00:00.000Z" },
        { createdAt: "2026-05-20T03:30:00.000Z" },
        { createdAt: "2026-05-20T02:15:00.000Z" },
      ],
    });
    const result = deriveLastTurnAt("agent-a", manager, makeLog());
    expect(result?.toISOString()).toBe("2026-05-20T03:30:00.000Z");
  });

  it("falls back to a prior session when the newest session is empty (boot edge)", () => {
    // startAgent creates a fresh EMPTY active session at boot. Scanning
    // only the newest session would collapse lastTurnAt to null and the
    // cron would never fire. The scan across recent sessions finds the
    // prior session's last real turn.
    const manager = makeManager([{ id: "fresh" }, { id: "prior" }], {
      fresh: [],
      prior: [
        { createdAt: "2026-05-19T22:00:00.000Z" },
        { createdAt: "2026-05-19T23:45:00.000Z" },
      ],
    });
    const result = deriveLastTurnAt("agent-a", manager, makeLog());
    expect(result?.toISOString()).toBe("2026-05-19T23:45:00.000Z");
  });

  it("ignores unparseable createdAt values", () => {
    const manager = makeManager([{ id: "s1" }], {
      s1: [
        { createdAt: "not-a-date" },
        { createdAt: "2026-05-20T05:00:00.000Z" },
      ],
    });
    const result = deriveLastTurnAt("agent-a", manager, makeLog());
    expect(result?.toISOString()).toBe("2026-05-20T05:00:00.000Z");
  });

  it("is best-effort — a store error yields null, never throws", () => {
    const manager = makeManager([], {}, { throwOnList: true });
    const log = makeLog();
    expect(() => deriveLastTurnAt("agent-a", manager, log)).not.toThrow();
    expect(deriveLastTurnAt("agent-a", manager, log)).toBeNull();
    expect(log.warn).toHaveBeenCalled();
  });

  it("scans at most LAST_TURN_SESSION_SCAN_LIMIT sessions", () => {
    const listRecentSessions = vi.fn(() => []);
    const manager: DreamMachineryManager = {
      getMemoryStore: () => undefined,
      getConversationStore: () =>
        ({
          listRecentSessions,
          getTurnsForSession: () => [],
        }) as unknown as ReturnType<
          DreamMachineryManager["getConversationStore"]
        >,
    };
    deriveLastTurnAt("agent-a", manager, makeLog());
    expect(listRecentSessions).toHaveBeenCalledWith(
      "agent-a",
      LAST_TURN_SESSION_SCAN_LIMIT,
    );
  });
});

/**
 * Phase 999.113 WS-6 — dream run-log rows appended by the machinery's
 * applyDreamResult adapter (the single choke point both the manual IPC
 * trigger and the idle cron flow through). One row per pass, on EVERY
 * outcome; a run-log failure must never affect the apply result.
 *
 * Uses the `dreamRunLogDir` seam so no test ever touches the real
 * ~/.clawcode/manager/dream-runs.jsonl.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach } from "vitest";
import { buildDreamMachinery } from "../dream-machinery.js";
import { listRecentDreamRuns } from "../dream-run-log.js";
import type { DreamPassOutcome, DreamResult } from "../dream-pass.js";

describe("buildDreamMachinery — dream run-log rows (WS-6)", () => {
  let tmpRoot: string;
  let runLogDir: string;
  let memoryRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "ws6-machinery-"));
    runLogDir = join(tmpRoot, "runlog");
    memoryRoot = join(tmpRoot, "memory");
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  const FIXED_NOW = new Date("2026-08-28T10:00:00.000Z");

  function makeMachinery(logDirOverride?: string) {
    return buildDreamMachinery({
      manager: makeManager([], {}),
      resolveMemoryRoot: () => memoryRoot,
      dispatch: async () => {
        throw new Error("dispatch must not be called by applyDreamResult");
      },
      now: () => FIXED_NOW,
      log: makeLog(),
      dreamRunLogDir: logDirOverride ?? runLogDir,
    });
  }

  function completedOutcome(): DreamPassOutcome {
    const result: DreamResult = {
      newWikilinks: [
        { from: "note-a", to: "note-b", rationale: "synthetic-fixture" },
      ],
      promotionCandidates: [],
      themedReflection: "synthetic reflection",
      suggestedConsolidations: [],
    };
    return {
      kind: "completed",
      result,
      durationMs: 4321,
      tokensIn: 10,
      tokensOut: 20,
      model: "haiku",
    };
  }

  it("appends an 'applied' row with wikilinks_added on a successful apply", async () => {
    const machinery = makeMachinery();
    const applied = await machinery.applyDreamResult(
      "agent-a",
      completedOutcome(),
    );
    expect(applied.kind).toBe("applied");

    const rows = await listRecentDreamRuns(10, runLogDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent: "agent-a",
      status: "applied",
      wikilinks_added: 1,
    });
    // No runDreamPass timing recorded in this direct-apply test — the
    // fallback uses the pass's own durationMs + the injected clock.
    expect(rows[0]!.duration_ms).toBe(4321);
    expect(rows[0]!.started_at).toBe(FIXED_NOW.toISOString());
  });

  it("appends a 'failed' row carrying the pass error", async () => {
    const machinery = makeMachinery();
    const applied = await machinery.applyDreamResult("agent-a", {
      kind: "failed",
      error: "parse-failed: Unexpected token",
    });
    // Apply-side behavior unchanged: non-completed outcomes skip.
    expect(applied.kind).toBe("skipped");

    const rows = await listRecentDreamRuns(10, runLogDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent: "agent-a",
      status: "failed",
      reason: "parse-failed: Unexpected token",
    });
  });

  it("appends a 'noop' row for a skipped pass", async () => {
    const machinery = makeMachinery();
    await machinery.applyDreamResult("agent-a", {
      kind: "skipped",
      reason: "disabled",
    });
    const rows = await listRecentDreamRuns(10, runLogDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent: "agent-a",
      status: "noop",
      reason: "pass-skipped: disabled",
    });
  });

  it("a run-log failure never affects the apply result", async () => {
    // Point the run-log at an impossible directory (child of a plain
    // file) so mkdir fails — append swallows, apply must still succeed.
    const machinery = makeMachinery(join(tmpRoot, "blocked", "\0bad"));
    const applied = await machinery.applyDreamResult(
      "agent-a",
      completedOutcome(),
    );
    expect(applied.kind).toBe("applied");
  });
});

/**
 * WP7 (memory overhaul, 2026-10-25): novelty gate, last-pass record,
 * reflection digest, real idle minutes, real model in the run log, and the
 * dream pass not reading its own artifacts. The live host ran 50 to 80
 * dream passes a day per idle agent; these pin the behavior that stops it.
 */
import { existsSync, readFileSync } from "node:fs";
import {
  DREAM_PASS_FLOOR_MS,
  hasNewMemorySince,
  isDreamArtifactPath,
  type DreamMachineryDeps,
} from "../dream-machinery.js";
import { readLastDreamPass } from "../dream-last-pass.js";
import type { MemoryStore } from "../../memory/store.js";

describe("isDreamArtifactPath", () => {
  it("matches the dream log and the reflection digest, nothing else", () => {
    expect(isDreamArtifactPath("/w/memory/dreams/2026-10-25.md")).toBe(true);
    expect(isDreamArtifactPath("/w/memory/memory/digests/dream-2026-10-25.md")).toBe(true);
    expect(isDreamArtifactPath("digests/dream-2026-10-25.md")).toBe(true);
    expect(isDreamArtifactPath("/w/memory/memory/digests/weekly-2026-W42.md")).toBe(false);
    expect(isDreamArtifactPath("/w/memory/memory/2026-10-25.md")).toBe(false);
    expect(isDreamArtifactPath("/w/memory/memory/2026-10-25-remember-ab12.md")).toBe(false);
  });
});

describe("hasNewMemorySince", () => {
  const since = Date.parse("2026-10-25T10:00:00.000Z");
  const older = new Date(since - 60_000);
  const newer = new Date(since + 60_000);

  function store(opts: {
    chunks?: ReadonlyArray<{ path: string; lastModified: Date }>;
    memories?: ReadonlyArray<{ createdAt: string; tags: readonly string[] }>;
    throws?: boolean;
  }) {
    return {
      // Honors `limit` like the real store, so the scan window is tested.
      listRecentMemoryChunks: (limit: number) => {
        if (opts.throws) throw new Error("db closed");
        return (opts.chunks ?? []).slice(0, limit);
      },
      listRecent: (limit: number) => (opts.memories ?? []).slice(0, limit),
    };
  }

  it("is false when nothing was written after the last pass", () => {
    expect(
      hasNewMemorySince(
        store({
          chunks: [{ path: "/m/2026-10-24.md", lastModified: older }],
          memories: [{ createdAt: older.toISOString(), tags: [] }],
        }),
        since,
      ),
    ).toBe(false);
  });

  it("is true for a newer daily-log chunk", () => {
    expect(
      hasNewMemorySince(store({ chunks: [{ path: "/m/2026-10-25.md", lastModified: newer }] }), since),
    ).toBe(true);
  });

  it("is true for a newer memories row", () => {
    expect(
      hasNewMemorySince(store({ memories: [{ createdAt: newer.toISOString(), tags: ["manual"] }] }), since),
    ).toBe(true);
  });

  it("ignores the dream's own artifacts so a pass never re-triggers itself", () => {
    expect(
      hasNewMemorySince(
        store({
          chunks: [
            { path: "/m/digests/dream-2026-10-25.md", lastModified: newer },
            { path: "/m/dreams/2026-10-25.md", lastModified: newer },
            { path: "/m/2026-10-24.md", lastModified: older },
          ],
        }),
        since,
      ),
    ).toBe(false);
  });

  it("ignores mid-session flush rows (periodic re-summaries, not new information)", () => {
    expect(
      hasNewMemorySince(
        store({
          memories: [
            { createdAt: newer.toISOString(), tags: ["mid-session", "session:s1", "flush:3"] },
            { createdAt: older.toISOString(), tags: ["manual"] },
          ],
        }),
        since,
      ),
    ).toBe(false);
  });

  it("fails open on a store error", () => {
    expect(hasNewMemorySince(store({ throws: true }), since)).toBe(true);
  });

  it("looks past a day's worth of dream-log chunks to find a newer real chunk", () => {
    // One chunk per dream-log section, all sharing the file's mtime, sorted
    // ahead of a real daily-log chunk written after the last pass.
    const dreamLog = Array.from({ length: 80 }, () => ({
      path: "/w/memory/dreams/2026-10-25.md",
      lastModified: new Date(since + 120_000),
    }));
    expect(
      hasNewMemorySince(
        store({ chunks: [...dreamLog, { path: "/w/memory/2026-10-25.md", lastModified: newer }] }),
        since,
      ),
    ).toBe(true);
  });
});

describe("buildDreamMachinery: novelty gate, last-pass record, digest, idle minutes (WP7)", () => {
  let tmpRoot: string;
  let runLogDir: string;
  let memoryRoot: string;
  let memoryDir: string;
  const T0 = new Date("2026-08-28T10:00:00.000Z");
  let clock: Date;
  const now = () => clock;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "wp7-machinery-"));
    runLogDir = join(tmpRoot, "runlog");
    memoryRoot = join(tmpRoot, "tier1");
    memoryDir = join(tmpRoot, "tier1", "memory");
    clock = T0;
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  type StoreRows = {
    chunks: Array<{ id: string; path: string; body: string; lastModified: Date }>;
    memories: Array<{ createdAt: string; tags: string[] }>;
  };

  function makeDeps(
    rows: StoreRows | null,
    opts: {
      lastTurnAt?: Date;
      dispatch?: DreamMachineryDeps["dispatch"];
      resolveMemoryDir?: (agent: string) => string;
    } = {},
  ): DreamMachineryDeps {
    const memoryStore =
      rows === null
        ? undefined
        : ({
            listRecentMemoryChunks: (limit: number) => rows.chunks.slice(0, limit),
            listRecent: (limit: number) => rows.memories.slice(0, limit),
            getById: () => null,
          } as unknown as MemoryStore);
    const turns = opts.lastTurnAt ? [{ createdAt: opts.lastTurnAt.toISOString() }] : [];
    const conversationStore = {
      listRecentSessions: () => [{ id: "s1" }],
      getTurnsForSession: () => turns,
      listRecentTerminatedSessions: () => [],
    };
    return {
      manager: {
        getMemoryStore: () => memoryStore,
        getConversationStore: () =>
          conversationStore as unknown as ReturnType<DreamMachineryManager["getConversationStore"]>,
      },
      resolveMemoryRoot: () => memoryRoot,
      resolveMemoryDir: opts.resolveMemoryDir,
      dispatch:
        opts.dispatch ??
        (async () => {
          throw new Error("dispatch must not be called");
        }),
      now,
      log: makeLog(),
      dreamRunLogDir: runLogDir,
    };
  }

  function outcome(overrides: { reflection?: string; model?: string } = {}): DreamPassOutcome {
    return {
      kind: "completed",
      result: {
        newWikilinks: [],
        promotionCandidates: [],
        themedReflection: overrides.reflection ?? "The agent spent the day on deploy debugging.",
        suggestedConsolidations: [],
      },
      durationMs: 100,
      tokensIn: 10,
      tokensOut: 20,
      model: overrides.model ?? "haiku",
    };
  }

  it("gate: an agent that never dreamt is not skipped", async () => {
    const m = buildDreamMachinery(makeDeps({ chunks: [], memories: [] }));
    expect(await m.noveltyGate("agent-a")).toEqual({ skip: false, reason: "no-prior-pass" });
  });

  it("gate: after an applied pass, skips until memory is written, then runs again", async () => {
    const rows: StoreRows = {
      chunks: [{ id: "c1", path: "/m/2026-08-27.md", body: "old", lastModified: new Date(T0.getTime() - 3_600_000) }],
      memories: [{ createdAt: new Date(T0.getTime() - 3_600_000).toISOString(), tags: [] }],
    };
    const m = buildDreamMachinery(makeDeps(rows));
    const applied = await m.applyDreamResult("agent-a", outcome());
    expect(applied.kind).toBe("applied");

    // Record landed in the manager dir (persists across daemon restarts).
    expect(await readLastDreamPass("agent-a", runLogDir)).toBe(T0.toISOString());

    // Next tick, nothing new: skip.
    clock = new Date(T0.getTime() + 30 * 60_000);
    expect(await m.noveltyGate("agent-a")).toEqual({
      skip: true,
      reason: "no-new-memory",
      lastPassAt: T0.toISOString(),
    });

    // The digest the pass just wrote is indexed as a chunk: still skip.
    rows.chunks.unshift({
      id: "d1",
      path: join(memoryDir, "digests", "dream-2026-08-28.md"),
      body: "reflection",
      lastModified: new Date(T0.getTime() + 1),
    });
    expect((await m.noveltyGate("agent-a")).skip).toBe(true);

    // A mid-session flush row is not novelty either.
    rows.memories.unshift({ createdAt: new Date(T0.getTime() + 60_000).toISOString(), tags: ["mid-session"] });
    expect((await m.noveltyGate("agent-a")).skip).toBe(true);

    // A real daily-log chunk written after the pass: run.
    rows.chunks.unshift({ id: "c2", path: "/m/2026-08-28.md", body: "new", lastModified: new Date(T0.getTime() + 120_000) });
    expect(await m.noveltyGate("agent-a")).toMatchObject({ skip: false, reason: "new-memory" });
  });

  it("gate: a saved memory row written after the pass counts as novelty", async () => {
    const rows: StoreRows = { chunks: [], memories: [] };
    const m = buildDreamMachinery(makeDeps(rows));
    await m.applyDreamResult("agent-a", outcome());
    clock = new Date(T0.getTime() + 30 * 60_000);
    expect((await m.noveltyGate("agent-a")).skip).toBe(true);
    rows.memories.unshift({ createdAt: new Date(T0.getTime() + 5_000).toISOString(), tags: ["manual"] });
    expect(await m.noveltyGate("agent-a")).toMatchObject({ skip: false, reason: "new-memory" });
  });

  it("gate: the 6-hour floor lets an idle agent dream again without new memory", async () => {
    const m = buildDreamMachinery(makeDeps({ chunks: [], memories: [] }));
    await m.applyDreamResult("agent-a", outcome());
    clock = new Date(T0.getTime() + DREAM_PASS_FLOOR_MS - 1);
    expect((await m.noveltyGate("agent-a")).skip).toBe(true);
    clock = new Date(T0.getTime() + DREAM_PASS_FLOOR_MS);
    expect(await m.noveltyGate("agent-a")).toMatchObject({ skip: false, reason: "floor-elapsed" });
  });

  it("gate: survives a daemon restart through the manager-dir record", async () => {
    const first = buildDreamMachinery(makeDeps({ chunks: [], memories: [] }));
    await first.applyDreamResult("agent-a", outcome());
    // Fresh machinery (new in-memory cache), same manager dir.
    const second = buildDreamMachinery(makeDeps({ chunks: [], memories: [] }));
    clock = new Date(T0.getTime() + 60 * 60_000);
    expect(await second.noveltyGate("agent-a")).toEqual({
      skip: true,
      reason: "no-new-memory",
      lastPassAt: T0.toISOString(),
    });
  });

  it("gate: fails open when the agent has no memory store", async () => {
    const m = buildDreamMachinery(makeDeps({ chunks: [], memories: [] }));
    await m.applyDreamResult("agent-a", outcome());
    const noStore = buildDreamMachinery(makeDeps(null));
    clock = new Date(T0.getTime() + 60 * 60_000);
    expect(await noStore.noveltyGate("agent-a")).toMatchObject({ skip: false, reason: "no-memory-store" });
  });

  it("gate: a failed or skipped pass does not count as a pass", async () => {
    const m = buildDreamMachinery(makeDeps({ chunks: [], memories: [] }));
    await m.applyDreamResult("agent-a", { kind: "failed", error: "parse-failed" });
    await m.applyDreamResult("agent-a", { kind: "skipped", reason: "disabled" });
    expect(await m.noveltyGate("agent-a")).toEqual({ skip: false, reason: "no-prior-pass" });
    expect(await readLastDreamPass("agent-a", runLogDir)).toBeNull();
  });

  it("digest: the themed reflection of an applied pass lands under <memoryDir>/digests as a dated H2 section", async () => {
    const m = buildDreamMachinery(makeDeps({ chunks: [], memories: [] }, { resolveMemoryDir: () => memoryDir }));
    await m.applyDreamResult("agent-a", outcome({ reflection: "First reflection of the day." }));
    const digestPath = join(memoryDir, "digests", "dream-2026-08-28.md");
    expect(existsSync(digestPath)).toBe(true);
    const content = readFileSync(digestPath, "utf8");
    expect(content).toContain("# Dream reflections: agent-a, 2026-08-28");
    expect(content).toContain("## Dream reflection 2026-08-28 10:00 UTC (agent-a, model=haiku)");
    expect(content).toContain("First reflection of the day.");

    clock = new Date(T0.getTime() + 4 * 3_600_000);
    await m.applyDreamResult("agent-a", outcome({ reflection: "Second reflection.", model: "sonnet" }));
    const after = readFileSync(digestPath, "utf8");
    expect(after.match(/^# Dream reflections/gm)).toHaveLength(1);
    expect(after).toContain("## Dream reflection 2026-08-28 14:00 UTC (agent-a, model=sonnet)");
    expect(after).toContain("First reflection of the day.");
    expect(after).toContain("Second reflection.");
  });

  it("digest: falls back to <memoryRoot>/memory when no resolver is wired, and skips a blank reflection", async () => {
    const m = buildDreamMachinery(makeDeps({ chunks: [], memories: [] }));
    await m.applyDreamResult("agent-a", outcome({ reflection: "   " }));
    expect(existsSync(join(memoryRoot, "memory", "digests"))).toBe(false);
    await m.applyDreamResult("agent-a", outcome({ reflection: "Something happened." }));
    expect(existsSync(join(memoryRoot, "memory", "digests", "dream-2026-08-28.md"))).toBe(true);
  });

  it("idle minutes: the dream log header records minutes since the last turn when the caller supplies none", async () => {
    const lastTurnAt = new Date(T0.getTime() - 90 * 60_000 - 30_000);
    const m = buildDreamMachinery(makeDeps({ chunks: [], memories: [] }, { lastTurnAt }));
    const applied = await m.applyDreamResult("agent-a", outcome());
    expect(applied.kind).toBe("applied");
    const log = readFileSync(join(memoryRoot, "dreams", "2026-08-28.md"), "utf8");
    expect(log).toContain("Dream pass (idle 90min, model=haiku)");
  });

  it("idle minutes: a value measured by the cron tick wins over the derived one", async () => {
    const lastTurnAt = new Date(T0.getTime() - 90 * 60_000);
    const m = buildDreamMachinery(makeDeps({ chunks: [], memories: [] }, { lastTurnAt }));
    await m.applyDreamResult("agent-a", outcome(), false, 47);
    const log = readFileSync(join(memoryRoot, "dreams", "2026-08-28.md"), "utf8");
    expect(log).toContain("Dream pass (idle 47min, model=haiku)");
  });

  it("run log: the applied row carries the model that served the pass", async () => {
    const m = buildDreamMachinery(makeDeps({ chunks: [], memories: [] }));
    await m.applyDreamResult("agent-a", outcome({ model: "sonnet" }));
    const rows = await listRecentDreamRuns(10, runLogDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "applied", model: "sonnet" });
  });

  it("runDreamPass: the pass does not read its own dream log or reflection digest as recent chunks", async () => {
    const prompts: string[] = [];
    const dispatch: DreamMachineryDeps["dispatch"] = async (req) => {
      prompts.push(req.userPrompt);
      return {
        rawText: JSON.stringify({
          newWikilinks: [],
          promotionCandidates: [],
          themedReflection: "",
          suggestedConsolidations: [],
        }),
        tokensIn: 1,
        tokensOut: 1,
      };
    };
    const rows: StoreRows = {
      chunks: [
        { id: "d1", path: join(memoryDir, "digests", "dream-2026-08-27.md"), body: "PRIOR-REFLECTION", lastModified: T0 },
        { id: "l1", path: join(memoryRoot, "dreams", "2026-08-27.md"), body: "PRIOR-DREAM-LOG", lastModified: T0 },
        { id: "c1", path: join(memoryDir, "2026-08-27.md"), body: "REAL-DAILY-LOG", lastModified: T0 },
      ],
      memories: [],
    };
    const m = buildDreamMachinery(makeDeps(rows, { dispatch }));
    const out = await m.runDreamPass("agent-a", "haiku");
    expect(out.kind).toBe("completed");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("REAL-DAILY-LOG");
    expect(prompts[0]).not.toContain("PRIOR-REFLECTION");
    expect(prompts[0]).not.toContain("PRIOR-DREAM-LOG");
  });
  it("gate: a pass recorded by another machinery instance (a manual IPC pass) is seen without a restart", async () => {
    const rows: StoreRows = { chunks: [], memories: [] };
    // The cron builds one machinery and keeps it; each manual IPC call
    // builds its own. The cron instance must see the manual pass.
    const cron = buildDreamMachinery(makeDeps(rows));
    await cron.applyDreamResult("agent-a", outcome());
    clock = new Date(T0.getTime() + 5 * 3_600_000);
    const manual = buildDreamMachinery(makeDeps(rows));
    await manual.applyDreamResult("agent-a", outcome());
    // 5h after the first pass but only 1h after the manual one: the floor
    // is measured from the manual pass.
    clock = new Date(T0.getTime() + 6 * 3_600_000);
    expect(await cron.noveltyGate("agent-a")).toEqual({
      skip: true,
      reason: "no-new-memory",
      lastPassAt: new Date(T0.getTime() + 5 * 3_600_000).toISOString(),
    });
  });

  it("gate: the record is the pass start, so memory written while the model ran still counts", async () => {
    const rows: StoreRows = { chunks: [], memories: [] };
    const dispatch: DreamMachineryDeps["dispatch"] = async () => {
      // A user turn lands (daily-log chunk indexed) while the model runs.
      rows.chunks.unshift({
        id: "mid",
        path: join(memoryDir, "2026-08-28.md"),
        body: "written during the pass",
        lastModified: new Date(T0.getTime() + 30_000),
      });
      clock = new Date(T0.getTime() + 60_000);
      return {
        rawText: JSON.stringify({
          newWikilinks: [],
          promotionCandidates: [],
          themedReflection: "r",
          suggestedConsolidations: [],
        }),
        tokensIn: 1,
        tokensOut: 1,
      };
    };
    const m = buildDreamMachinery(makeDeps(rows, { dispatch }));
    const out = await m.runDreamPass("agent-a", "haiku");
    expect(out.kind).toBe("completed");
    expect((await m.applyDreamResult("agent-a", out)).kind).toBe("applied");
    expect(await readLastDreamPass("agent-a", runLogDir)).toBe(T0.toISOString());
    clock = new Date(T0.getTime() + 30 * 60_000);
    expect(await m.noveltyGate("agent-a")).toMatchObject({ skip: false, reason: "new-memory" });
  });

  it("runDreamPass: the dispatcher's reported model reaches the outcome and the run log", async () => {
    const dispatch: DreamMachineryDeps["dispatch"] = async (req) => ({
      rawText: JSON.stringify({
        newWikilinks: [],
        promotionCandidates: [],
        themedReflection: "r",
        suggestedConsolidations: [],
      }),
      tokensIn: 1,
      tokensOut: 1,
      model: req.model,
    });
    const m = buildDreamMachinery(makeDeps({ chunks: [], memories: [] }, { dispatch }));
    const out = await m.runDreamPass("agent-a", "opus");
    expect(out.kind === "completed" && out.model).toBe("opus");
    await m.applyDreamResult("agent-a", out);
    const rows = await listRecentDreamRuns(10, runLogDir);
    expect(rows[0]).toMatchObject({ status: "applied", model: "opus" });
  });
});
