/**
 * Phase 63 Plan 03 -- CLI `clawcode trace <causation_id>` command.
 *
 * Walks the entire causation chain across all agents by:
 *   1. Querying tasks.db (read-only) for task rows matching the causation_id
 *   2. Scanning per-agent traces.db files for trace rows whose turn_origin
 *      JSON contains the matching causationId
 *   3. Building a unified tree from task parent_task_id links and
 *      TurnOrigin.parentTurnId chains
 *   4. Rendering the tree with box-drawing characters
 *
 * OBS-04: trigger_id and task_id are extracted from TurnOrigin.source.id
 * (no new write-side work needed):
 *   - source.kind === "trigger" -> triggerId = source.id
 *   - source.kind === "task"    -> taskId    = source.id
 *
 * OBS-05: cumulative chain_token_cost shown at root level.
 *
 * Opens SQLite in read-only mode -- no running daemon needed.
 */

import type { Command } from "commander";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import Database from "better-sqlite3";
import { TurnOriginSchema } from "../../manager/turn-origin.js";
import { formatTokenCount, formatDuration } from "./triggers.js";
import { cliLog, cliError } from "../output.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChainNode = {
  readonly type: "trigger" | "turn" | "task";
  readonly agent: string;
  readonly turnId: string | null;
  readonly taskId: string | null;
  readonly triggerId: string | null;
  readonly status: string;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly durationMs: number | null;
  readonly tokenCost: number;
  readonly depth: number;
  readonly children: readonly ChainNode[];
};

export type ChainResult = {
  readonly causationId: string;
  readonly totalTokenCost: number;
  readonly root: ChainNode | null;
  readonly nodes: readonly ChainNode[];
};

// ---------------------------------------------------------------------------
// Internal mutable node type for tree building
// ---------------------------------------------------------------------------

type MutableChainNode = {
  type: "trigger" | "turn" | "task";
  agent: string;
  turnId: string | null;
  taskId: string | null;
  triggerId: string | null;
  status: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  tokenCost: number;
  depth: number;
  children: MutableChainNode[];
  /** Internal: for linking parent -> child during tree build. */
  _parentKey: string | null;
  /** Internal: unique key for this node. */
  _nodeKey: string;
};

// ---------------------------------------------------------------------------
// Raw row types
// ---------------------------------------------------------------------------

type TaskRawRow = {
  readonly task_id: string;
  readonly task_type: string;
  readonly caller_agent: string;
  readonly target_agent: string;
  readonly causation_id: string;
  readonly parent_task_id: string | null;
  readonly depth: number;
  readonly input_digest: string;
  readonly status: string;
  readonly started_at: number;
  readonly ended_at: number | null;
  readonly heartbeat_at: number;
  readonly result_digest: string | null;
  readonly error: string | null;
  readonly chain_token_cost: number;
};

type TraceRawRow = {
  readonly id: string;
  readonly agent: string;
  readonly started_at: string;
  readonly ended_at: string;
  readonly total_ms: number;
  readonly status: string;
  readonly turn_origin: string | null;
};

// ---------------------------------------------------------------------------
// discoverAgentTracesDbs
// ---------------------------------------------------------------------------

/**
 * Discover all per-agent traces.db files under the agents base directory.
 *
 * @param agentsBasePath Base directory containing agent subdirectories
 * @returns Array of { agent, dbPath } for agents that have a traces.db
 */
export function discoverAgentTracesDbs(
  agentsBasePath: string,
): readonly { readonly agent: string; readonly dbPath: string }[] {
  if (!existsSync(agentsBasePath)) {
    return [];
  }

  const entries = readdirSync(agentsBasePath);
  const results: { agent: string; dbPath: string }[] = [];

  for (const entry of entries) {
    const entryPath = join(agentsBasePath, entry);
    try {
      if (!statSync(entryPath).isDirectory()) continue;
    } catch {
      continue;
    }

    const tracesDbPath = join(entryPath, "traces.db");
    if (existsSync(tracesDbPath)) {
      results.push({ agent: entry, dbPath: tracesDbPath });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// walkCausationChain
// ---------------------------------------------------------------------------

/**
 * Walk the entire causation chain across tasks.db and per-agent traces.db.
 *
 * @param opts.tasksDbPath Path to daemon-scoped tasks.db
 * @param opts.agentsBasePath Path to agents directory (each subdir may have traces.db)
 * @param opts.causationId The causation_id to walk
 * @returns ChainResult with unified tree + flat nodes array
 * @throws Error if tasksDbPath doesn't exist
 */
export function walkCausationChain(opts: {
  readonly tasksDbPath: string;
  readonly agentsBasePath: string;
  readonly causationId: string;
}): ChainResult {
  // 1. Validate tasks.db exists
  if (!existsSync(opts.tasksDbPath)) {
    throw new Error(`tasks.db not found at ${opts.tasksDbPath}`);
  }

  // 2. Query task rows from tasks.db
  const tasksDb = new Database(opts.tasksDbPath, {
    readonly: true,
    fileMustExist: true,
  });

  let taskRows: readonly TaskRawRow[];
  try {
    taskRows = tasksDb
      .prepare(
        "SELECT * FROM tasks WHERE causation_id = ? ORDER BY depth ASC, started_at ASC",
      )
      .all(opts.causationId) as TaskRawRow[];
  } finally {
    tasksDb.close();
  }

  // 3. Discover and query per-agent traces.db files
  const agentDbs = discoverAgentTracesDbs(opts.agentsBasePath);
  const traceRows: Array<TraceRawRow & { readonly _parsedOriginSourceKind: string | null; readonly _parsedOriginSourceId: string | null; readonly _parsedParentTurnId: string | null }> = [];

  for (const { dbPath } of agentDbs) {
    let db: InstanceType<typeof Database> | null = null;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      const rows = db
        .prepare(
          `SELECT id, agent, started_at, ended_at, total_ms, status, turn_origin
           FROM traces
           WHERE turn_origin LIKE '%"causationId":"' || ? || '"%'
           ORDER BY started_at ASC`,
        )
        .all(opts.causationId) as TraceRawRow[];

      for (const row of rows) {
        let sourceKind: string | null = null;
        let sourceId: string | null = null;
        let parentTurnId: string | null = null;

        if (row.turn_origin) {
          try {
            const parsed = JSON.parse(row.turn_origin);
            const validated = TurnOriginSchema.safeParse(parsed);
            if (validated.success) {
              sourceKind = validated.data.source.kind;
              sourceId = validated.data.source.id;
              parentTurnId = validated.data.parentTurnId;
            }
          } catch {
            // Malformed turn_origin -- skip parsing, treat as untyped turn
          }
        }

        traceRows.push({
          ...row,
          _parsedOriginSourceKind: sourceKind,
          _parsedOriginSourceId: sourceId,
          _parsedParentTurnId: parentTurnId,
        });
      }
    } catch {
      // Agent traces.db might be corrupt or locked -- silently skip
    } finally {
      db?.close();
    }
  }

  // 4. If no data found, return empty result
  if (taskRows.length === 0 && traceRows.length === 0) {
    return {
      causationId: opts.causationId,
      totalTokenCost: 0,
      root: null,
      nodes: [],
    };
  }

  // 5. Build mutable nodes from task rows
  const allNodes: MutableChainNode[] = [];
  const nodeByKey = new Map<string, MutableChainNode>();

  for (const task of taskRows) {
    const node: MutableChainNode = {
      type: "task",
      agent: task.target_agent,
      turnId: null,
      taskId: task.task_id,
      triggerId: null,
      status: task.status,
      startedAt: task.started_at,
      endedAt: task.ended_at,
      durationMs:
        task.ended_at !== null ? task.ended_at - task.started_at : null,
      tokenCost: task.chain_token_cost,
      depth: task.depth,
      children: [],
      _parentKey: task.parent_task_id
        ? `task:${task.parent_task_id}`
        : null,
      _nodeKey: `task:${task.task_id}`,
    };
    allNodes.push(node);
    nodeByKey.set(node._nodeKey, node);
  }

  // 6. Build mutable nodes from trace rows
  for (const trace of traceRows) {
    const startedAtMs = new Date(trace.started_at).getTime();
    const endedAtMs = new Date(trace.ended_at).getTime();

    const isTrigger = trace._parsedOriginSourceKind === "trigger";
    const isTask = trace._parsedOriginSourceKind === "task";

    const node: MutableChainNode = {
      type: isTrigger ? "trigger" : "turn",
      agent: trace.agent,
      turnId: trace.id,
      taskId: isTask ? trace._parsedOriginSourceId : null,
      triggerId: isTrigger ? trace._parsedOriginSourceId : null,
      status: trace.status,
      startedAt: startedAtMs,
      endedAt: endedAtMs,
      durationMs: trace.total_ms,
      tokenCost: 0,
      depth: 0, // Will be set during tree building
      children: [],
      _parentKey: trace._parsedParentTurnId
        ? `turn:${trace._parsedParentTurnId}`
        : null,
      _nodeKey: `turn:${trace.id}`,
    };
    allNodes.push(node);
    nodeByKey.set(node._nodeKey, node);
  }

  // 7. Build tree by linking children to parents
  // Strategy:
  //   a) Task -> parent task: task._parentKey = "task:<parent_task_id>"
  //   b) Turn -> parent turn: turn._parentKey = "turn:<parentTurnId>"
  //   c) Task-delegated turn: a turn with source.kind="task" and source.id=<task_id>
  //      becomes a child of the task node with matching task_id
  //   d) Task from trigger turn: a task whose caller matches the trigger turn's agent
  //      and has no parent_task_id, becomes a child of the trigger turn

  // Link task-delegated turns to their parent tasks
  for (const node of allNodes) {
    if (node.type === "turn" && node.taskId) {
      // This turn is processing a task — attach it as child of the task
      const taskKey = `task:${node.taskId}`;
      const parentTask = nodeByKey.get(taskKey);
      if (parentTask) {
        parentTask.children.push(node);
        node._parentKey = taskKey; // mark as linked
        continue;
      }
    }
  }

  // Link child tasks to parent tasks
  for (const node of allNodes) {
    if (node.type === "task" && node._parentKey) {
      const parent = nodeByKey.get(node._parentKey);
      if (parent) {
        // Check not already added
        if (!parent.children.includes(node)) {
          parent.children.push(node);
        }
        continue;
      }
    }
  }

  // Link root tasks (depth 0, no parent task) to trigger turns
  const triggerNodes = allNodes.filter((n) => n.type === "trigger");
  const rootTasks = allNodes.filter(
    (n) =>
      n.type === "task" &&
      n.depth === 0 &&
      !allNodes.some((p) => p.children.includes(n)),
  );

  for (const task of rootTasks) {
    // Find the trigger turn whose agent matches the task's caller
    // OR just the first trigger turn if there's only one
    const matchingTrigger =
      triggerNodes.find((t) => t.agent === task.agent) ??
      triggerNodes[0];
    if (matchingTrigger && !matchingTrigger.children.includes(task)) {
      matchingTrigger.children.push(task);
    }
  }

  // 8. Find root node: prefer trigger node, then depth-0 task
  let root: MutableChainNode | null =
    triggerNodes[0] ??
    allNodes.find(
      (n) => n.type === "task" && n.depth === 0,
    ) ??
    allNodes[0] ??
    null;

  // 9. Assign depth recursively
  if (root) {
    assignDepth(root, 0);
  }

  // 10. Compute total token cost from task nodes only
  const totalTokenCost = allNodes
    .filter((n) => n.type === "task")
    .reduce((sum, n) => sum + n.tokenCost, 0);

  // 11. Freeze nodes and return
  const frozenNodes = allNodes.map(freezeNode);
  const frozenRoot = root ? freezeNode(root) : null;

  return {
    causationId: opts.causationId,
    totalTokenCost,
    root: frozenRoot,
    nodes: frozenNodes,
  };
}

function assignDepth(node: MutableChainNode, depth: number): void {
  node.depth = depth;
  for (const child of node.children) {
    assignDepth(child, depth + 1);
  }
}

function freezeNode(node: MutableChainNode): ChainNode {
  return Object.freeze({
    type: node.type,
    agent: node.agent,
    turnId: node.turnId,
    taskId: node.taskId,
    triggerId: node.triggerId,
    status: node.status,
    startedAt: node.startedAt,
    endedAt: node.endedAt,
    durationMs: node.durationMs,
    tokenCost: node.tokenCost,
    depth: node.depth,
    children: Object.freeze(node.children.map(freezeNode)),
  });
}

// ---------------------------------------------------------------------------
// ANSI color helpers
// ---------------------------------------------------------------------------

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** Terminal statuses that show red. */
const RED_STATUSES = new Set(["failed", "timed_out", "cancelled", "orphaned"]);

/** In-flight statuses that show yellow. */
const YELLOW_STATUSES = new Set(["running", "pending", "awaiting_input"]);

function colorStatus(status: string): string {
  if (status === "complete") return `${GREEN}${status}${RESET}`;
  if (RED_STATUSES.has(status)) return `${RED}${status}${RESET}`;
  if (YELLOW_STATUSES.has(status)) return `${YELLOW}${status}${RESET}`;
  return status;
}

// ---------------------------------------------------------------------------
// formatChainTree
// ---------------------------------------------------------------------------

/**
 * Format a chain result as a box-drawing tree.
 *
 * @param result ChainResult from walkCausationChain
 * @returns Formatted tree string
 */
export function formatChainTree(result: ChainResult): string {
  if (result.root === null) {
    return `No chain found for causation_id: ${result.causationId}`;
  }

  const lines: string[] = [];

  // Summary line
  lines.push(
    `Chain ${result.causationId} | ${result.nodes.length} nodes | ${formatTokenCount(result.totalTokenCost)} total tokens`,
  );

  // Render root node
  lines.push(formatNodeLine(result.root));

  // Render children recursively
  renderChildren(result.root.children, "", lines);

  return lines.join("\n");
}

function truncateId(id: string | null, maxLen: number = 12): string {
  if (id === null) return "?";
  if (id.length <= maxLen) return id;
  return id.slice(0, maxLen - 3) + "...";
}

function formatNodeLine(node: ChainNode): string {
  const duration =
    node.durationMs !== null
      ? formatDuration(node.startedAt, node.endedAt)
      : "running";
  const tokenStr =
    node.tokenCost > 0 ? `${formatTokenCount(node.tokenCost)} tokens` : "";

  if (node.type === "trigger") {
    const id = node.triggerId ?? truncateId(node.turnId);
    const parts = [`trigger:${id}`, `(${node.agent}`, `${colorStatus(node.status)}`, `${duration}`];
    if (tokenStr) parts.push(tokenStr);
    return parts.join(", ").replace("(", "(").replace(/,\s*$/, "") + ")";
  }

  if (node.type === "task") {
    const id = truncateId(node.taskId);
    const parts = [
      `task:${id}`,
      `(${node.agent}`,
      `${colorStatus(node.status)}`,
      `${duration}`,
    ];
    if (tokenStr) parts.push(tokenStr);
    return parts.join(", ").replace(/,\s*$/, "") + ")";
  }

  // type === "turn"
  const id = truncateId(node.turnId);
  const parts = [
    `turn:${id}`,
    `(${node.agent}`,
    `${colorStatus(node.status)}`,
    `${duration}`,
  ];
  if (tokenStr) parts.push(tokenStr);
  return parts.join(", ").replace(/,\s*$/, "") + ")";
}

function renderChildren(
  children: readonly ChainNode[],
  prefix: string,
  lines: string[],
): void {
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    const isLast = i === children.length - 1;
    const connector = isLast ? "└── " : "├── ";
    const childPrefix = isLast ? `${prefix}    ` : `${prefix}│   `;

    lines.push(`${prefix}${connector}${formatNodeLine(child)}`);
    renderChildren(child.children, childPrefix, lines);
  }
}

// ---------------------------------------------------------------------------
// formatChainJson
// ---------------------------------------------------------------------------

/**
 * Format a chain result as pretty-printed JSON.
 *
 * @param result ChainResult from walkCausationChain
 * @returns JSON string
 */
export function formatChainJson(result: ChainResult): string {
  return JSON.stringify(result, null, 2);
}

// ---------------------------------------------------------------------------
// registerTraceCommand
// ---------------------------------------------------------------------------

/** Default path to tasks.db */
const defaultTasksDbPath = join(
  homedir(),
  ".clawcode",
  "manager",
  "tasks.db",
);

/** Default path to agents directory */
const defaultAgentsDir = join(homedir(), ".clawcode", "agents");

/**
 * Register the `clawcode trace <causation_id>` command.
 *
 * @param program Commander program instance
 */
export function registerTraceCommand(program: Command): void {
  program
    .command("trace <causation_id>")
    .description("Walk a causation chain across all agents")
    .option("--json", "Output as JSON")
    .option("--db <path>", "Path to tasks.db", defaultTasksDbPath)
    .option(
      "--agents-dir <path>",
      "Path to agents directory",
      defaultAgentsDir,
    )
    .action(
      async (
        causationId: string,
        opts: {
          json?: boolean;
          db: string;
          agentsDir: string;
        },
      ) => {
        try {
          const result = walkCausationChain({
            tasksDbPath: opts.db,
            agentsBasePath: opts.agentsDir,
            causationId,
          });

          if (opts.json) {
            cliLog(formatChainJson(result));
          } else {
            cliLog(formatChainTree(result));
          }
        } catch (error) {
          cliError(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          );
          process.exit(1);
        }
      },
    );
}
