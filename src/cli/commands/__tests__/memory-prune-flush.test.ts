/**
 * Memory overhaul 2026-10-25 (WP1): `clawcode memory prune-flush <agent>`
 * CLI tests.
 *
 * DI'd against a stub loadConfig and an `openStores` factory that hands
 * the action a real in-memory MemoryStore + ConversationStore and a real
 * TierManager with a fake embedder, so the delete path (vectors, links,
 * session FK) and the maintenance pass are exercised for real without
 * touching disk, MiniLM or a daemon.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { MemoryStore } from "../../../memory/store.js";
import { ConversationStore } from "../../../memory/conversation-store.js";
import { TierManager } from "../../../memory/tier-manager.js";
import { DEFAULT_TIER_CONFIG } from "../../../memory/tiers.js";
import {
  runMemoryPruneFlushAction,
  planPruneFlush,
  formatPruneFlushPlan,
  registerMemoryPruneFlushCommand,
  type PruneFlushStores,
} from "../memory-prune-flush.js";

function randomEmbedding(): Float32Array {
  const arr = new Float32Array(384);
  let norm = 0;
  for (let i = 0; i < 384; i++) {
    arr[i] = Math.random() * 2 - 1;
    norm += arr[i] * arr[i];
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < 384; i++) arr[i] /= norm;
  return arr;
}

const silent = pino({ level: "silent" });

const CONFIG = {
  agents: [{ name: "agent-x", workspace: "/tmp/ws-agent-x" }],
};

describe("memory prune-flush CLI (WP1)", () => {
  let stdoutCapture: string[];
  let stderrCapture: string[];
  let writeStdoutSpy: ReturnType<typeof vi.spyOn>;
  let writeStderrSpy: ReturnType<typeof vi.spyOn>;
  let memStore: MemoryStore;
  let convStore: ConversationStore;
  let tierManager: TierManager;
  let closed: boolean;
  let stores: PruneFlushStores;

  /** Session ids seeded by `seed()`. */
  let summarizedSession: string;
  let activeSession: string;
  let recentSession: string;
  let rowsBySession: Record<string, string[]>;
  let untaggedRow: string;

  beforeEach(() => {
    stdoutCapture = [];
    stderrCapture = [];
    writeStdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(((chunk: string | Uint8Array) => {
        stdoutCapture.push(typeof chunk === "string" ? chunk : chunk.toString());
        return true;
      }) as typeof process.stdout.write);
    writeStderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(((chunk: string | Uint8Array) => {
        stderrCapture.push(typeof chunk === "string" ? chunk : chunk.toString());
        return true;
      }) as typeof process.stderr.write);

    memStore = new MemoryStore(":memory:", { enabled: false, similarityThreshold: 0.85 });
    convStore = new ConversationStore(memStore.getDatabase());
    tierManager = new TierManager({
      store: memStore,
      embedder: {
        embed: vi.fn().mockResolvedValue(randomEmbedding()),
        warmup: vi.fn().mockResolvedValue(undefined),
        isReady: vi.fn().mockReturnValue(true),
      } as never,
      memoryDir: "/tmp/ws-agent-x/memory",
      tierConfig: DEFAULT_TIER_CONFIG,
      scoringConfig: { semanticWeight: 0.7, decayWeight: 0.3, halfLifeDays: 30 },
      log: silent,
      agentName: "agent-x",
    });
    closed = false;
    stores = {
      memoryStore: memStore,
      conversationStore: convStore,
      tierManager,
      close: () => {
        closed = true;
      },
    };
    seed();
  });

  afterEach(() => {
    writeStdoutSpy.mockRestore();
    writeStderrSpy.mockRestore();
    vi.restoreAllMocks();
    memStore.close();
  });

  function insertFlush(sessionId: string | null, n: number, createdAt?: string): string {
    const tags = sessionId
      ? ["mid-session", `session:${sessionId}`, `flush:${n}`]
      : ["mid-session", `flush:${n}`];
    const entry = memStore.insert(
      { content: `flush ${sessionId ?? "untagged"} ${n}`, source: "conversation", importance: 0.4, tags, skipDedup: true },
      randomEmbedding(),
    );
    if (createdAt) {
      memStore.getDatabase().prepare("UPDATE memories SET created_at = ? WHERE id = ?").run(createdAt, entry.id);
    }
    return entry.id;
  }

  function endAndSummarize(sessionId: string): void {
    convStore.endSession(sessionId);
    const summary = memStore.insert(
      { content: `summary of ${sessionId}`, source: "conversation", tags: ["session-summary", `session:${sessionId}`], skipDedup: true },
      randomEmbedding(),
    );
    convStore.markSummarized(sessionId, summary.id);
  }

  function seed(): void {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    rowsBySession = {};

    // A summarized session with three old flush rows (the prod shape).
    summarizedSession = convStore.startSession("agent-x").id;
    convStore.recordTurn({ sessionId: summarizedSession, role: "user", content: "hi" });
    rowsBySession[summarizedSession] = [1, 2, 3].map((n) => insertFlush(summarizedSession, n, tenDaysAgo));
    endAndSummarize(summarizedSession);

    // A session that is still active: its checkpoints must survive.
    activeSession = convStore.startSession("agent-x").id;
    rowsBySession[activeSession] = [1, 2].map((n) => insertFlush(activeSession, n, tenDaysAgo));

    // A summarized session whose flush row was written just now (keep-days).
    recentSession = convStore.startSession("agent-x").id;
    rowsBySession[recentSession] = [insertFlush(recentSession, 1)];
    endAndSummarize(recentSession);

    // A mid-session row with no session tag at all.
    untaggedRow = insertFlush(null, 1, tenDaysAgo);
  }

  function midSessionCount(): number {
    return memStore.findByTag("mid-session").length;
  }

  function vecCount(id: string): number {
    return (
      memStore.getDatabase().prepare("SELECT COUNT(*) AS n FROM vec_memories WHERE memory_id = ?").get(id) as { n: number }
    ).n;
  }

  it("planPruneFlush classifies rows by their session's summary state and age", () => {
    const plan = planPruneFlush(stores, { keepDays: 0 });
    expect(plan.totalRows).toBe(7);
    expect(plan.totalSessions).toBe(3);
    expect(plan.prunable.map((r) => r.id).sort()).toEqual(
      [...rowsBySession[summarizedSession], ...rowsBySession[recentSession]].sort(),
    );
    expect(plan.prunableSessions).toBe(2);
    expect(plan.keptUnsummarized).toBe(2);
    expect(plan.keptUnsummarizedSessions).toBe(1);
    expect(plan.keptRecent).toBe(0);
    expect(plan.keptNoSession).toBe(1);

    const withKeep = planPruneFlush(stores, { keepDays: 1 });
    expect(withKeep.prunable.map((r) => r.id).sort()).toEqual([...rowsBySession[summarizedSession]].sort());
    expect(withKeep.keptRecent).toBe(1);
  });

  it("dry run (default) prints the counts, deletes nothing and exits 0", async () => {
    const code = await runMemoryPruneFlushAction({
      agentName: "agent-x",
      configPath: "/tmp/fake-clawcode.yaml",
      loadConfigDep: vi.fn().mockResolvedValue(CONFIG),
      openStores: () => stores,
      log: silent,
    });

    expect(code).toBe(0);
    const out = stdoutCapture.join("");
    expect(out).toContain("[DRY RUN] agent-x: 7 mid-session flush row(s) across 3 session(s)");
    expect(out).toContain("prunable (session already summarized): 4 row(s) in 2 session(s)");
    expect(out).toContain("kept (session active or not yet summarized): 2 row(s) in 1 session(s)");
    expect(out).toContain("kept (no session tag or session row missing): 1 row(s)");
    expect(out).toContain("Re-run with --apply");
    expect(midSessionCount()).toBe(7);
    expect(closed).toBe(true);
  });

  it("--apply deletes only rows of summarized sessions (vectors included) and runs maintenance", async () => {
    const maintenanceSpy = vi.spyOn(tierManager, "runMaintenance");
    // Make the stale flush rows hot so maintenance has something to demote.
    for (const id of rowsBySession[summarizedSession]) memStore.updateTier(id, "hot");
    const fact = memStore.insert({ content: "a real fact", source: "manual", importance: 0.8 }, randomEmbedding());
    memStore.getDatabase()
      .prepare("UPDATE memories SET access_count = 5, accessed_at = ? WHERE id = ?")
      .run(new Date().toISOString(), fact.id);

    const code = await runMemoryPruneFlushAction({
      agentName: "agent-x",
      apply: true,
      configPath: "/tmp/fake-clawcode.yaml",
      loadConfigDep: vi.fn().mockResolvedValue(CONFIG),
      openStores: () => stores,
      log: silent,
    });

    expect(code).toBe(0);
    for (const id of [...rowsBySession[summarizedSession], ...rowsBySession[recentSession]]) {
      expect(memStore.getById(id)).toBeNull();
      expect(vecCount(id)).toBe(0);
    }
    for (const id of [...rowsBySession[activeSession], untaggedRow]) {
      expect(memStore.getById(id)).not.toBeNull();
    }
    expect(midSessionCount()).toBe(3);
    // The session rows keep their summary pointer; only checkpoints went.
    expect(convStore.getSession(summarizedSession)!.summaryMemoryId).not.toBeNull();
    expect(maintenanceSpy).toHaveBeenCalledOnce();
    expect(memStore.getById(fact.id)!.tier).toBe("hot");
    const out = stdoutCapture.join("");
    expect(out).toContain("[APPLY] agent-x: 7 mid-session flush row(s)");
    expect(out).toContain("Deleted 4 mid-session flush row(s).");
    expect(out).toMatch(/Tier maintenance: promoted \d+, demoted \d+, cooled \d+, rewarmed \d+, errors 0\./);
    expect(closed).toBe(true);
  });

  it("--keep-days keeps young rows of summarized sessions", async () => {
    const code = await runMemoryPruneFlushAction({
      agentName: "agent-x",
      apply: true,
      keepDays: 1,
      configPath: "/tmp/fake-clawcode.yaml",
      loadConfigDep: vi.fn().mockResolvedValue(CONFIG),
      openStores: () => stores,
      log: silent,
    });

    expect(code).toBe(0);
    expect(memStore.getById(rowsBySession[recentSession][0])).not.toBeNull();
    for (const id of rowsBySession[summarizedSession]) expect(memStore.getById(id)).toBeNull();
    expect(stdoutCapture.join("")).toContain("kept (younger than --keep-days 1): 1 row(s)");
    expect(stdoutCapture.join("")).toContain("Deleted 3 mid-session flush row(s).");
  });

  it("opens the store from the agent's memoryPath (or workspace) like memory backfill does", async () => {
    const openStores = vi.fn().mockReturnValue(stores);
    const code = await runMemoryPruneFlushAction({
      agentName: "agent-x",
      configPath: "/tmp/fake-clawcode.yaml",
      loadConfigDep: vi.fn().mockResolvedValue({
        agents: [
          {
            name: "agent-x",
            workspace: "/tmp/ws-agent-x",
            memoryPath: "/tmp/ws-agent-x/memory/agent-x",
            memory: { tiers: { hotBudget: 7 }, decay: { halfLifeDays: 90 } },
          },
        ],
      }),
      openStores,
      log: silent,
    });

    expect(code).toBe(0);
    expect(openStores).toHaveBeenCalledOnce();
    const args = openStores.mock.calls[0][0];
    expect(args.dbPath).toBe("/tmp/ws-agent-x/memory/agent-x/memory/memories.db");
    expect(args.memoryPath).toBe("/tmp/ws-agent-x/memory/agent-x");
    expect(args.tierConfig).toEqual({ ...DEFAULT_TIER_CONFIG, hotBudget: 7 });
    expect(args.scoringConfig).toEqual({ semanticWeight: 0.7, decayWeight: 0.3, halfLifeDays: 90 });
  });

  it("a session whose summary pointer was detached still counts as summarized while a summary row exists", async () => {
    // summary-dedupe removed the summary the pointer named; a duplicate
    // summary row for the same session survives.
    const s = convStore.startSession("agent-x").id;
    const rows = [1, 2].map((n) => insertFlush(s, n));
    convStore.endSession(s);
    const first = memStore.insert(
      { content: `summary A of ${s}`, source: "conversation", tags: ["session-summary", `session:${s}`], skipDedup: true },
      randomEmbedding(),
    );
    convStore.markSummarized(s, first.id);
    memStore.insert(
      { content: `summary B of ${s}`, source: "conversation", tags: ["session-summary", `session:${s}`], skipDedup: true },
      randomEmbedding(),
    );
    memStore.delete(first.id);
    expect(convStore.getSession(s)!.summaryMemoryId).toBeNull();

    const plan = planPruneFlush(stores, { keepDays: 0 });

    expect(plan.prunable.map((r) => r.id)).toEqual(expect.arrayContaining(rows));
  });

  it("a summarized session with no summary row left keeps its flush rows", async () => {
    const s = convStore.startSession("agent-x").id;
    const rows = [1, 2].map((n) => insertFlush(s, n));
    convStore.endSession(s);
    const only = memStore.insert(
      { content: `summary of ${s}`, source: "conversation", tags: ["session-summary", `session:${s}`], skipDedup: true },
      randomEmbedding(),
    );
    convStore.markSummarized(s, only.id);
    memStore.delete(only.id);

    const plan = planPruneFlush(stores, { keepDays: 0 });

    for (const id of rows) expect(plan.prunable.map((r) => r.id)).not.toContain(id);
    expect(plan.keptUnsummarized).toBe(4);
  });

  it("a row that vanished between plan and delete counts as already gone, not as a failure", async () => {
    const realDelete = memStore.delete.bind(memStore);
    const gone = rowsBySession[summarizedSession][0];
    const flaky: PruneFlushStores = {
      ...stores,
      memoryStore: {
        findByTag: (tag: string) => memStore.findByTag(tag),
        delete: (id: string) => (id === gone ? false : realDelete(id)),
      },
    };

    const code = await runMemoryPruneFlushAction({
      agentName: "agent-x",
      apply: true,
      configPath: "/tmp/fake-clawcode.yaml",
      loadConfigDep: vi.fn().mockResolvedValue(CONFIG),
      openStores: () => flaky,
      log: silent,
    });

    expect(code).toBe(0);
    expect(stdoutCapture.join("")).toContain("Deleted 3 mid-session flush row(s) (1 already gone).");
  });

  it("a failing delete is reported and exits 1", async () => {
    const realDelete = memStore.delete.bind(memStore);
    const bad = rowsBySession[summarizedSession][1];
    const failing: PruneFlushStores = {
      ...stores,
      memoryStore: {
        findByTag: (tag: string) => memStore.findByTag(tag),
        delete: (id: string) => {
          if (id === bad) throw new Error("database is locked");
          return realDelete(id);
        },
      },
    };

    const code = await runMemoryPruneFlushAction({
      agentName: "agent-x",
      apply: true,
      configPath: "/tmp/fake-clawcode.yaml",
      loadConfigDep: vi.fn().mockResolvedValue(CONFIG),
      openStores: () => failing,
      log: silent,
    });

    expect(code).toBe(1);
    expect(memStore.getById(bad)).not.toBeNull();
    expect(stdoutCapture.join("")).toContain("Deleted 3 mid-session flush row(s) (1 failed).");
    expect(closed).toBe(true);
  });

  it("resolves the workspace from defaults.basePath and uses the defaults memory block like the config loader", async () => {
    const openStores = vi.fn().mockReturnValue(stores);
    const code = await runMemoryPruneFlushAction({
      agentName: "agent-x",
      configPath: "/tmp/fake-clawcode.yaml",
      loadConfigDep: vi.fn().mockResolvedValue({
        defaults: {
          basePath: "/srv/agents",
          memory: { tiers: { hotBudget: 9 }, decay: { semanticWeight: 0.6 } },
        },
        agents: [{ name: "agent-x" }],
      }),
      openStores,
      log: silent,
    });

    expect(code).toBe(0);
    const args = openStores.mock.calls[0][0];
    expect(args.memoryPath).toBe("/srv/agents/agent-x");
    expect(args.dbPath).toBe("/srv/agents/agent-x/memory/memories.db");
    expect(args.tierConfig).toEqual({ ...DEFAULT_TIER_CONFIG, hotBudget: 9 });
    expect(args.scoringConfig).toEqual({ semanticWeight: 0.6, decayWeight: 0.3, halfLifeDays: 30 });
  });

  it("refuses to create a database that does not exist (default store opener)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prune-flush-nodb-"));
    try {
      const code = await runMemoryPruneFlushAction({
        agentName: "agent-x",
        configPath: "/tmp/fake-clawcode.yaml",
        loadConfigDep: vi.fn().mockResolvedValue({ agents: [{ name: "agent-x", workspace: dir }] }),
        log: silent,
      });

      expect(code).toBe(1);
      expect(stderrCapture.join("")).toContain("no memory database at");
      expect(existsSync(join(dir, "memory", "memories.db"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("end to end on an on-disk database through the default store opener", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prune-flush-disk-"));
    try {
      mkdirSync(join(dir, "memory"), { recursive: true });
      const dbPath = join(dir, "memory", "memories.db");
      const disk = new MemoryStore(dbPath);
      const conv = new ConversationStore(disk.getDatabase());
      const done = conv.startSession("agent-x").id;
      const live = conv.startSession("agent-x").id;
      const flushIds = [1, 2, 3].map(
        (n) =>
          disk.insert(
            { content: `flush ${n}`, source: "conversation", importance: 0.4, tags: ["mid-session", `session:${done}`, `flush:${n}`], skipDedup: true },
            randomEmbedding(),
          ).id,
      );
      const liveId = disk.insert(
        { content: "live flush", source: "conversation", importance: 0.4, tags: ["mid-session", `session:${live}`, "flush:1"], skipDedup: true },
        randomEmbedding(),
      ).id;
      conv.endSession(done);
      const summary = disk.insert(
        { content: "summary", source: "conversation", tags: ["session-summary", `session:${done}`], skipDedup: true },
        randomEmbedding(),
      );
      conv.markSummarized(done, summary.id);
      disk.updateTier(flushIds[0], "hot");
      disk.close();

      const code = await runMemoryPruneFlushAction({
        agentName: "agent-x",
        apply: true,
        configPath: "/tmp/fake-clawcode.yaml",
        loadConfigDep: vi.fn().mockResolvedValue({ agents: [{ name: "agent-x", workspace: dir }] }),
        log: silent,
      });

      expect(code).toBe(0);
      expect(stdoutCapture.join("")).toContain("Deleted 3 mid-session flush row(s).");
      const check = new MemoryStore(dbPath);
      try {
        for (const id of flushIds) expect(check.getById(id)).toBeNull();
        expect(check.getById(liveId)).not.toBeNull();
        expect(check.getById(summary.id)).not.toBeNull();
        const vecs = check
          .getDatabase()
          .prepare(`SELECT COUNT(*) AS n FROM vec_memories WHERE memory_id IN (${flushIds.map(() => "?").join(",")})`)
          .get(...flushIds) as { n: number };
        expect(vecs.n).toBe(0);
      } finally {
        check.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("agent not in config exits 1 without opening a store", async () => {
    const openStores = vi.fn();
    const code = await runMemoryPruneFlushAction({
      agentName: "ghost",
      configPath: "/tmp/fake-clawcode.yaml",
      loadConfigDep: vi.fn().mockResolvedValue(CONFIG),
      openStores,
      log: silent,
    });

    expect(code).toBe(1);
    expect(stderrCapture.join("")).toMatch(/Agent 'ghost' not in clawcode\.yaml/);
    expect(openStores).not.toHaveBeenCalled();
  });

  it("formatPruneFlushPlan says 'Nothing to prune' when nothing qualifies", () => {
    const text = formatPruneFlushPlan(
      "agent-x",
      {
        totalRows: 2,
        totalSessions: 1,
        prunable: [],
        prunableSessions: 0,
        keptUnsummarized: 2,
        keptUnsummarizedSessions: 1,
        keptRecent: 0,
        keptNoSession: 0,
      },
      { apply: false, keepDays: 0 },
    );
    expect(text).toContain("Nothing to prune.");
    expect(text).not.toContain("--apply");
  });

  it("registers `prune-flush <agent>` with --apply, --keep-days and --config under the given parent", () => {
    const parent = new Command("memory");
    registerMemoryPruneFlushCommand(parent);
    const cmd = parent.commands.find((c) => c.name() === "prune-flush");
    expect(cmd).toBeDefined();
    const optionNames = cmd!.options.map((o) => o.long);
    expect(optionNames).toContain("--apply");
    expect(optionNames).toContain("--keep-days");
    expect(optionNames).toContain("--config");
    expect(cmd!.description()).toMatch(/dry run unless --apply/);
  });
});
