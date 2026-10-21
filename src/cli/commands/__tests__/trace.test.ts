/**
 * Phase 63 Plan 03 Task 1 -- CLI `clawcode trace` tests.
 *
 * Tests pure functions: discoverAgentTracesDbs, walkCausationChain,
 * formatChainTree, formatChainJson. Creates temp SQLite DBs with tasks +
 * per-agent traces tables for end-to-end chain walk tests.
 */

import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import {
  discoverAgentTracesDbs,
  walkCausationChain,
  formatChainTree,
  formatChainJson,
  type ChainNode,
  type ChainResult,
} from "../trace.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  const dir = join(tmpdir(), `trace-test-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Create a tasks.db with the 15-field schema matching src/tasks/store.ts.
 */
function createTasksDb(
  dir: string,
  tasks: Array<{
    task_id: string;
    task_type: string;
    caller_agent: string;
    target_agent: string;
    causation_id: string;
    parent_task_id?: string | null;
    depth: number;
    input_digest: string;
    status: string;
    started_at: number;
    ended_at?: number | null;
    heartbeat_at: number;
    result_digest?: string | null;
    error?: string | null;
    chain_token_cost: number;
  }>,
): string {
  const dbPath = join(dir, "tasks.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      task_id          TEXT PRIMARY KEY,
      task_type        TEXT NOT NULL,
      caller_agent     TEXT NOT NULL,
      target_agent     TEXT NOT NULL,
      causation_id     TEXT NOT NULL,
      parent_task_id   TEXT,
      depth            INTEGER NOT NULL CHECK(depth >= 0),
      input_digest     TEXT NOT NULL,
      status           TEXT NOT NULL CHECK(status IN
                        ('pending','running','awaiting_input',
                         'complete','failed','cancelled','timed_out','orphaned')),
      started_at       INTEGER NOT NULL,
      ended_at         INTEGER,
      heartbeat_at     INTEGER NOT NULL,
      result_digest    TEXT,
      error            TEXT,
      chain_token_cost INTEGER NOT NULL DEFAULT 0 CHECK(chain_token_cost >= 0)
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_causation_id ON tasks(causation_id);
  `);

  const insertTask = db.prepare(
    `INSERT INTO tasks (task_id, task_type, caller_agent, target_agent, causation_id,
     parent_task_id, depth, input_digest, status, started_at, ended_at, heartbeat_at,
     result_digest, error, chain_token_cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const t of tasks) {
    insertTask.run(
      t.task_id,
      t.task_type,
      t.caller_agent,
      t.target_agent,
      t.causation_id,
      t.parent_task_id ?? null,
      t.depth,
      t.input_digest,
      t.status,
      t.started_at,
      t.ended_at ?? null,
      t.heartbeat_at,
      t.result_digest ?? null,
      t.error ?? null,
      t.chain_token_cost,
    );
  }

  db.close();
  return dbPath;
}

/**
 * Create a per-agent traces.db with the trace-store schema.
 */
function createTracesDb(
  agentDir: string,
  traces: Array<{
    id: string;
    agent: string;
    started_at: string;
    ended_at: string;
    total_ms: number;
    discord_channel_id?: string | null;
    status: string;
    turn_origin?: string | null;
  }>,
): string {
  const dbPath = join(agentDir, "traces.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS traces (
      id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      total_ms INTEGER NOT NULL,
      discord_channel_id TEXT,
      status TEXT NOT NULL,
      cache_read_input_tokens INTEGER,
      cache_creation_input_tokens INTEGER,
      input_tokens INTEGER,
      prefix_hash TEXT,
      cache_eviction_expected INTEGER,
      turn_origin TEXT
    );
  `);

  const insertTrace = db.prepare(
    `INSERT INTO traces (id, agent, started_at, ended_at, total_ms, discord_channel_id, status, turn_origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const t of traces) {
    insertTrace.run(
      t.id,
      t.agent,
      t.started_at,
      t.ended_at,
      t.total_ms,
      t.discord_channel_id ?? null,
      t.status,
      t.turn_origin ?? null,
    );
  }

  db.close();
  return dbPath;
}

// ---------------------------------------------------------------------------
// discoverAgentTracesDbs
// ---------------------------------------------------------------------------

describe("discoverAgentTracesDbs", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("finds both agent traces.db files", () => {
    const dir = makeTempDir();
    tempDirs.push(dir);

    const agentADir = join(dir, "agent-a");
    const agentBDir = join(dir, "agent-b");
    mkdirSync(agentADir, { recursive: true });
    mkdirSync(agentBDir, { recursive: true });

    createTracesDb(agentADir, []);
    createTracesDb(agentBDir, []);

    const result = discoverAgentTracesDbs(dir);
    expect(result.length).toBe(2);
    const agents = result.map((r) => r.agent).sort();
    expect(agents).toEqual(["agent-a", "agent-b"]);
  });

  it("skips agents without traces.db", () => {
    const dir = makeTempDir();
    tempDirs.push(dir);

    const agentADir = join(dir, "agent-a");
    const agentBDir = join(dir, "agent-b");
    mkdirSync(agentADir, { recursive: true });
    mkdirSync(agentBDir, { recursive: true });

    // Only agent-a has a traces.db
    createTracesDb(agentADir, []);

    const result = discoverAgentTracesDbs(dir);
    expect(result.length).toBe(1);
    expect(result[0]!.agent).toBe("agent-a");
  });

  it("returns empty array when agents directory does not exist", () => {
    const dir = makeTempDir();
    tempDirs.push(dir);

    const result = discoverAgentTracesDbs(join(dir, "nonexistent"));
    expect(result.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// walkCausationChain
// ---------------------------------------------------------------------------

describe("walkCausationChain", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("walks a simple chain: trigger -> task -> delegated turn, with children", () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const now = Date.now();
    const causationId = "test-chain-001";

    // Create tasks.db with a root task and a child task
    const tasksDbPath = createTasksDb(dir, [
      {
        task_id: "task:root-001",
        task_type: "handoff",
        caller_agent: "acquisition",
        target_agent: "research",
        causation_id: causationId,
        parent_task_id: null,
        depth: 0,
        input_digest: "sha256:aaa",
        status: "complete",
        started_at: now - 5000,
        ended_at: now - 1000,
        heartbeat_at: now - 5000,
        chain_token_cost: 1200,
      },
    ]);

    // Create per-agent traces
    const agentsDir = join(dir, "agents");
    const acqDir = join(agentsDir, "acquisition");
    const resDir = join(agentsDir, "research");
    mkdirSync(acqDir, { recursive: true });
    mkdirSync(resDir, { recursive: true });

    // Trigger turn in acquisition agent
    const triggerOrigin = JSON.stringify({
      source: { kind: "trigger", id: "cron:daily-report" },
      rootTurnId: "trigger:abc1234567",
      parentTurnId: null,
      chain: ["trigger:abc1234567"],
      causationId,
    });

    createTracesDb(acqDir, [
      {
        id: "trigger:abc1234567",
        agent: "acquisition",
        started_at: new Date(now - 6000).toISOString(),
        ended_at: new Date(now - 4500).toISOString(),
        total_ms: 1500,
        status: "complete",
        turn_origin: triggerOrigin,
      },
    ]);

    // Delegated turn in research agent
    const taskOrigin = JSON.stringify({
      source: { kind: "task", id: "task:root-001" },
      rootTurnId: "trigger:abc1234567",
      parentTurnId: "trigger:abc1234567",
      chain: ["trigger:abc1234567", "task:Ym8n3qR4Sz"],
      causationId,
    });

    createTracesDb(resDir, [
      {
        id: "task:Ym8n3qR4Sz",
        agent: "research",
        started_at: new Date(now - 4000).toISOString(),
        ended_at: new Date(now - 2000).toISOString(),
        total_ms: 2000,
        status: "complete",
        turn_origin: taskOrigin,
      },
    ]);

    const result = walkCausationChain({
      tasksDbPath,
      agentsBasePath: agentsDir,
      causationId,
    });

    expect(result.causationId).toBe(causationId);
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.root).not.toBeNull();
    // Tree nesting works: root trigger has children
    expect(result.root!.children.length).toBeGreaterThan(0);
    // Total token cost reflects task rows
    expect(result.totalTokenCost).toBe(1200);
  });

  it("extracts triggerId from TurnOrigin.source.id when kind='trigger'", () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const now = Date.now();
    const causationId = "trigger-extract-001";

    const tasksDbPath = createTasksDb(dir, []);

    const agentsDir = join(dir, "agents");
    const acqDir = join(agentsDir, "acquisition");
    mkdirSync(acqDir, { recursive: true });

    const triggerOrigin = JSON.stringify({
      source: { kind: "trigger", id: "cron:daily-report" },
      rootTurnId: "trigger:TrigAbc1234",
      parentTurnId: null,
      chain: ["trigger:TrigAbc1234"],
      causationId,
    });

    createTracesDb(acqDir, [
      {
        id: "trigger:TrigAbc1234",
        agent: "acquisition",
        started_at: new Date(now - 5000).toISOString(),
        ended_at: new Date(now - 3000).toISOString(),
        total_ms: 2000,
        status: "complete",
        turn_origin: triggerOrigin,
      },
    ]);

    const result = walkCausationChain({
      tasksDbPath,
      agentsBasePath: agentsDir,
      causationId,
    });

    // Find the trigger node
    const triggerNode = result.nodes.find((n) => n.type === "trigger");
    expect(triggerNode).toBeDefined();
    expect(triggerNode!.triggerId).toBe("cron:daily-report");
  });

  it("extracts taskId from TurnOrigin.source.id when kind='task'", () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const now = Date.now();
    const causationId = "task-extract-001";

    const tasksDbPath = createTasksDb(dir, []);

    const agentsDir = join(dir, "agents");
    const resDir = join(agentsDir, "research");
    mkdirSync(resDir, { recursive: true });

    const taskOrigin = JSON.stringify({
      source: { kind: "task", id: "task:parent-123" },
      rootTurnId: "trigger:root123456",
      parentTurnId: "trigger:root123456",
      chain: ["trigger:root123456", "task:childTurn01"],
      causationId,
    });

    createTracesDb(resDir, [
      {
        id: "task:childTurn01",
        agent: "research",
        started_at: new Date(now - 4000).toISOString(),
        ended_at: new Date(now - 2000).toISOString(),
        total_ms: 2000,
        status: "complete",
        turn_origin: taskOrigin,
      },
    ]);

    const result = walkCausationChain({
      tasksDbPath,
      agentsBasePath: agentsDir,
      causationId,
    });

    // Find the turn node (source.kind === "task" -> type="turn")
    const turnNode = result.nodes.find((n) => n.type === "turn");
    expect(turnNode).toBeDefined();
    expect(turnNode!.taskId).toBe("task:parent-123");
  });

  it("returns null root when no matching causation_id", () => {
    const dir = makeTempDir();
    tempDirs.push(dir);

    const tasksDbPath = createTasksDb(dir, []);
    const agentsDir = join(dir, "agents");
    mkdirSync(agentsDir, { recursive: true });

    const result = walkCausationChain({
      tasksDbPath,
      agentsBasePath: agentsDir,
      causationId: "nonexistent-chain",
    });

    expect(result.root).toBeNull();
    expect(result.nodes.length).toBe(0);
  });

  it("throws when tasks.db is missing", () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const agentsDir = join(dir, "agents");
    mkdirSync(agentsDir, { recursive: true });

    expect(() =>
      walkCausationChain({
        tasksDbPath: join(dir, "nonexistent.db"),
        agentsBasePath: agentsDir,
        causationId: "any",
      }),
    ).toThrow(/not found/);
  });

  it("silently skips agents without traces.db", () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const causationId = "skip-test-001";

    const tasksDbPath = createTasksDb(dir, [
      {
        task_id: "task:alone-001",
        task_type: "handoff",
        caller_agent: "admin",
        target_agent: "ghost",
        causation_id: causationId,
        depth: 0,
        input_digest: "sha256:bbb",
        status: "complete",
        started_at: Date.now() - 5000,
        ended_at: Date.now() - 1000,
        heartbeat_at: Date.now() - 5000,
        chain_token_cost: 500,
      },
    ]);

    const agentsDir = join(dir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    // No agent directories at all

    // Should not throw — just returns task nodes without trace data
    const result = walkCausationChain({
      tasksDbPath,
      agentsBasePath: agentsDir,
      causationId,
    });

    expect(result.nodes.length).toBe(1);
    expect(result.root).not.toBeNull();
    expect(result.totalTokenCost).toBe(500);
  });

  it("calculates cumulative token cost across all task nodes", () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const now = Date.now();
    const causationId = "cost-test-001";

    const tasksDbPath = createTasksDb(dir, [
      {
        task_id: "task:cost-001",
        task_type: "handoff",
        caller_agent: "admin",
        target_agent: "research",
        causation_id: causationId,
        parent_task_id: null,
        depth: 0,
        input_digest: "sha256:ccc",
        status: "complete",
        started_at: now - 5000,
        ended_at: now - 3000,
        heartbeat_at: now - 5000,
        chain_token_cost: 800,
      },
      {
        task_id: "task:cost-002",
        task_type: "handoff",
        caller_agent: "research",
        target_agent: "studio",
        causation_id: causationId,
        parent_task_id: "task:cost-001",
        depth: 1,
        input_digest: "sha256:ddd",
        status: "complete",
        started_at: now - 3000,
        ended_at: now - 1000,
        heartbeat_at: now - 3000,
        chain_token_cost: 600,
      },
    ]);

    const agentsDir = join(dir, "agents");
    mkdirSync(agentsDir, { recursive: true });

    const result = walkCausationChain({
      tasksDbPath,
      agentsBasePath: agentsDir,
      causationId,
    });

    expect(result.totalTokenCost).toBe(1400); // 800 + 600
  });
});

// ---------------------------------------------------------------------------
// formatChainTree
// ---------------------------------------------------------------------------

describe("formatChainTree", () => {
  it("returns 'No chain found' when root is null", () => {
    const result: ChainResult = {
      causationId: "missing-chain",
      totalTokenCost: 0,
      root: null,
      nodes: [],
    };
    const output = formatChainTree(result);
    expect(output).toContain("No chain found for causation_id: missing-chain");
  });

  it("produces box-drawing output with correct indentation", () => {
    const root: ChainNode = {
      type: "trigger",
      agent: "acquisition",
      turnId: "trigger:abc1234567",
      taskId: null,
      triggerId: "cron:daily",
      status: "complete",
      startedAt: 1000000,
      endedAt: 1004500,
      durationMs: 4500,
      tokenCost: 0,
      depth: 0,
      children: [
        {
          type: "task",
          agent: "research",
          turnId: null,
          taskId: "task:generate-report-abc",
          triggerId: null,
          status: "complete",
          startedAt: 1001000,
          endedAt: 1004000,
          durationMs: 3000,
          tokenCost: 1200,
          depth: 1,
          children: [
            {
              type: "turn",
              agent: "research",
              turnId: "task:Ym8n3qR4Sz",
              taskId: "task:generate-report-abc",
              triggerId: null,
              status: "complete",
              startedAt: 1001500,
              endedAt: 1003500,
              durationMs: 2000,
              tokenCost: 0,
              depth: 2,
              children: [],
            },
          ],
        },
      ],
    };

    const result: ChainResult = {
      causationId: "abc123def",
      totalTokenCost: 1200,
      root,
      nodes: [root, root.children[0]!, root.children[0]!.children[0]!],
    };

    const output = formatChainTree(result);

    // Summary line
    expect(output).toContain("Chain abc123def");
    expect(output).toContain("3 nodes");
    expect(output).toContain("1.2K total tokens");

    // Box-drawing characters present
    expect(output).toContain("trigger:");
    expect(output).toContain("task:");

    // Tree structure chars
    expect(output).toMatch(/[└├│]/);
  });

  it("includes triggerId in trigger node display", () => {
    const root: ChainNode = {
      type: "trigger",
      agent: "acquisition",
      turnId: "trigger:abc1234567",
      taskId: null,
      triggerId: "cron:daily-report",
      status: "complete",
      startedAt: 1000000,
      endedAt: 1004500,
      durationMs: 4500,
      tokenCost: 0,
      depth: 0,
      children: [],
    };

    const result: ChainResult = {
      causationId: "test-trigger-id",
      totalTokenCost: 0,
      root,
      nodes: [root],
    };

    const output = formatChainTree(result);
    expect(output).toContain("cron:daily-report");
  });
});

// ---------------------------------------------------------------------------
// formatChainJson
// ---------------------------------------------------------------------------

describe("formatChainJson", () => {
  it("outputs valid JSON from chain result", () => {
    const root: ChainNode = {
      type: "trigger",
      agent: "acquisition",
      turnId: "trigger:abc1234567",
      taskId: null,
      triggerId: "cron:daily",
      status: "complete",
      startedAt: 1000000,
      endedAt: 1004500,
      durationMs: 4500,
      tokenCost: 0,
      depth: 0,
      children: [],
    };

    const result: ChainResult = {
      causationId: "json-test",
      totalTokenCost: 0,
      root,
      nodes: [root],
    };

    const json = formatChainJson(result);
    const parsed = JSON.parse(json);
    expect(parsed.causationId).toBe("json-test");
    expect(parsed.root.type).toBe("trigger");
    expect(parsed.root.triggerId).toBe("cron:daily");
  });

  it("handles null root in JSON output", () => {
    const result: ChainResult = {
      causationId: "empty-json",
      totalTokenCost: 0,
      root: null,
      nodes: [],
    };

    const json = formatChainJson(result);
    const parsed = JSON.parse(json);
    expect(parsed.root).toBeNull();
    expect(parsed.nodes).toEqual([]);
  });
});
