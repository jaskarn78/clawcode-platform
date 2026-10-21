/**
 * Phase 59 -- TaskManager: the handoff control plane.
 *
 * Composes Plan 59-01 primitives (errors, digest, schema-registry, authorize)
 * with Phase 58 TaskStore + Phase 57 TurnDispatcher to deliver async-ticket
 * handoffs (HAND-01) with all required safety checks (HAND-02 through HAND-07,
 * LIFE-05, LIFE-06).
 *
 * Class is daemon-scoped -- one instance wired in Plan 59-03 daemon.ts. All
 * methods are safe to call concurrently from different agent sessions
 * (writes flow through TaskStore's single-writer handle).
 *
 * See .planning/phases/59-cross-agent-rpc-handoffs/59-RESEARCH.md for:
 *   - Pitfall 1 (async-ticket -- delegate returns without awaiting dispatch)
 *   - Pitfall 3 (digest determinism -- computeInputDigest via canonicalStringify)
 *   - Pitfall 4 (AbortSignal threaded through DispatchOptions.signal)
 *   - Pitfall 5 (pinned CompiledSchema per task -- no hot-reload drift)
 *   - Pitfall 6 (cost attribution -- single accounting dimension to caller)
 *   - Pitfall 7 (task_complete as the structured-result handoff point)
 *   - Pitfall 8 (retry charges original caller, not operator)
 */

import { nanoid } from "nanoid";
import type { ConfigModel } from "../shared/model-catalog.js";
import type { Logger } from "pino";
import type { TaskStore } from "./store.js";
import type { TaskRow } from "./schema.js";
import type { TaskStatus } from "./types.js";
import type { TurnDispatcher } from "../manager/turn-dispatcher.js";
import type { TurnOrigin } from "../manager/turn-origin.js";
import type { EscalationBudget } from "../usage/budget.js";
import { SchemaRegistry, type CompiledSchema } from "./schema-registry.js";
import { computeInputDigest } from "./digest.js";
import {
  checkSelfHandoff,
  checkDepth,
  checkAllowlist,
  checkCycle,
  MAX_PAYLOAD_BYTES,
} from "./authorize.js";
import {
  ValidationError,
  UnauthorizedError,
  DeadlineExceededError,
  TaskNotFoundError,
} from "./errors.js";
import { logger } from "../shared/logger.js";

/** LOCKED -- max chain depth (Open Question 4, RESEARCH). */
export const MAX_HANDOFF_DEPTH = 5;

export type DelegateRequest = Readonly<{
  caller: string;
  target: string;
  schema: string;
  payload: unknown;
  deadline_ms?: number;
  budgetOwner?: string;
  parentTaskId?: string | null;
}>;

export type DelegateResponse = Readonly<{ task_id: string }>;

export type StatusResponse = Readonly<{
  task_id: string;
  status: TaskStatus;
  error?: string;
  result?: unknown;
}>;

type AgentConfigShape = {
  readonly name: string;
  // Phase 999.98 — Category A executor path: widened to include "fable" and the
  // four `<family>@latest` literals (D11). This shape is a structural subset of
  // ResolvedAgentConfig (whose `model` now admits `@latest`); the task router
  // reads `name`/`acceptsTasks`, not `model`, so the sugar passes through inert.
  readonly model: ConfigModel;
  readonly acceptsTasks?: Readonly<Record<string, readonly string[]>>;
};

export type TaskManagerOptions = Readonly<{
  store: TaskStore;
  turnDispatcher: TurnDispatcher;
  schemaRegistry: SchemaRegistry;
  escalationBudget: EscalationBudget;
  getAgentConfig: (name: string) => AgentConfigShape | null;
  /** Plan 59-03 injects the real payload store; tests plant inline. */
  getStoredPayload?: (taskId: string) => unknown | null;
  getStoredResult?: (taskId: string) => unknown | null;
  /** Plan 59-03 supplies real storage; tests use Maps. */
  storePayload?: (taskId: string, payload: unknown) => void;
  storeResult?: (taskId: string, result: unknown) => void;
  log?: Logger;
  now?: () => number;
}>;

export class TaskManager {
  private readonly opts: TaskManagerOptions;
  private readonly log: Logger;
  private readonly now: () => number;

  /** In-flight AbortControllers keyed by task_id -- cleaned on terminal transition. */
  private readonly inflight = new Map<string, AbortController>();

  /** Pinned CompiledSchema per task_id -- immune to hot-reload (Pitfall 5). */
  private readonly pinned = new Map<string, CompiledSchema>();

  /** Effective deadlines per task_id (absolute wall-clock ms). Children inherit. */
  private readonly deadlines = new Map<string, number>();

  /** Active timeout handles so cancel()/complete() can clear them. */
  private readonly timers = new Map<string, NodeJS.Timeout>();

  /** Tracks budgetOwner overrides -- key: taskId, value: override agent name. */
  private readonly budgetOwners = new Map<string, string>();

  constructor(options: TaskManagerOptions) {
    this.opts = options;
    this.log = (options.log ?? logger).child({ component: "TaskManager" });
    this.now = options.now ?? Date.now;
  }

  get schemaCount(): number {
    return this.opts.schemaRegistry.size();
  }

  /**
   * Quick 260511-pw3 — schema introspection for cross-agent senders.
   *
   * Returns the schemas `target` accepts, filtered against the fleet-wide
   * registry, with `callerAllowed` indicating whether `caller` is on each
   * schema's per-target allowlist (`acceptsTasks[schema]`).
   *
   * Two-layer model recap:
   *   - Fleet registry: ~/.clawcode/task-schemas/<name>.yaml (a schema
   *     EXISTS in the system).
   *   - Per-agent allowlist: agent config `acceptsTasks: { schema: [callers] }`
   *     (this target ACCEPTS this schema from these callers).
   *   Both must be satisfied for `delegate_task` to succeed.
   *
   * Used by the `list_agent_schemas` MCP tool so the sender's LLM can
   * introspect before calling `delegate_task` instead of taking a blind
   * shot at an unknown schema (the failure mode Admin Clawdy hit on
   * 2026-05-11 with `bug.report`).
   */
  listSchemasForAgent(caller: string, target: string): readonly {
    readonly name: string;
    readonly callerAllowed: boolean;
    readonly registered: boolean;
  }[] {
    const targetConfig = this.opts.getAgentConfig(target);
    if (!targetConfig) return [];
    const accepts = targetConfig.acceptsTasks ?? {};
    const out: {
      name: string;
      callerAllowed: boolean;
      registered: boolean;
    }[] = [];
    for (const [name, allowedCallers] of Object.entries(accepts)) {
      out.push({
        name,
        callerAllowed: allowedCallers.includes(caller),
        registered: this.opts.schemaRegistry.get(name) !== null,
      });
    }
    return Object.freeze(out);
  }

  /**
   * Quick 260511-pw3 — accepted-schemas list for a target, regardless of
   * caller. Used as the `data.acceptedSchemas` payload on
   * `delegate_task` unknown_schema errors so the sender's LLM can choose a
   * valid schema on retry. Intersects per-agent `acceptsTasks` with the
   * fleet registry — a schema declared in config but missing the YAML
   * file is NOT actually delegatable.
   */
  acceptedSchemasForTarget(target: string): readonly string[] {
    const targetConfig = this.opts.getAgentConfig(target);
    if (!targetConfig) return Object.freeze([]);
    const accepts = targetConfig.acceptsTasks ?? {};
    const intersected = Object.keys(accepts).filter(
      (name) => this.opts.schemaRegistry.get(name) !== null,
    );
    return Object.freeze(intersected);
  }

  /**
   * HAND-01 async-ticket delegation. Runs the 6-step authorization BEFORE
   * any row is written. Returns synchronously once the row is inserted and
   * B's turn is dispatched -- NEVER awaits B's response (Pitfall 1).
   */
  async delegate(req: DelegateRequest): Promise<DelegateResponse> {
    // Step 1 -- self-handoff (HAND-07)
    checkSelfHandoff(req.caller, req.target);

    // Step 2 -- schema exists (HAND-02 "unknown_schema")
    const compiled = this.opts.schemaRegistry.get(req.schema);
    if (!compiled) {
      throw new ValidationError("unknown_schema", `schema '${req.schema}' not in registry`, {
        schema: req.schema,
      });
    }

    // Step 3 -- payload size cap (HAND-02 "payload_too_large", Pitfall 2)
    const serialized = JSON.stringify(req.payload);
    const size = Buffer.byteLength(serialized ?? "", "utf8");
    if (size > MAX_PAYLOAD_BYTES) {
      throw new ValidationError(
        "payload_too_large",
        `payload size ${size} exceeds MAX_PAYLOAD_BYTES=${MAX_PAYLOAD_BYTES}`,
        { size, max: MAX_PAYLOAD_BYTES },
      );
    }

    // Step 4 -- Zod schema parse (HAND-02 "schema_mismatch", HAND-06 strict)
    try {
      compiled.input.parse(req.payload);
    } catch (err) {
      throw new ValidationError("schema_mismatch", "input payload failed schema validation", {
        schema: req.schema,
        zodIssues: (err as { issues?: unknown }).issues ?? String(err),
      });
    }

    // Step 5 -- allowlist (HAND-04)
    const targetConfig = this.opts.getAgentConfig(req.target);
    if (!targetConfig) {
      throw new UnauthorizedError(req.caller, req.target, req.schema);
    }
    checkAllowlist(targetConfig, req.caller, req.schema);

    // Step 6 -- depth + cycle (HAND-05)
    const parentTaskId = req.parentTaskId ?? null;
    const parentRow = parentTaskId ? this.opts.store.get(parentTaskId) : null;
    if (parentTaskId && !parentRow) {
      throw new ValidationError("unknown_schema", `parentTaskId '${parentTaskId}' not found`, {
        parentTaskId,
      });
    }
    const newDepth = parentRow ? parentRow.depth + 1 : 0;
    checkDepth(newDepth, MAX_HANDOFF_DEPTH);
    checkCycle(this.opts.store, req.target, parentTaskId, MAX_HANDOFF_DEPTH);

    // ------------------------------------------------------------------
    // All checks passed -- build the row.
    // ------------------------------------------------------------------
    const taskId = `task:${nanoid(10)}`;
    const inputDigest = computeInputDigest(req.payload);
    const rootCausationId = parentRow ? parentRow.causation_id : taskId;
    const nowMs = this.now();

    const row: TaskRow = {
      task_id: taskId,
      task_type: req.schema,
      caller_agent: req.caller,
      target_agent: req.target,
      causation_id: rootCausationId,
      parent_task_id: parentTaskId,
      depth: newDepth,
      input_digest: inputDigest,
      status: "pending",
      started_at: nowMs,
      ended_at: null,
      heartbeat_at: nowMs,
      result_digest: null,
      error: null,
      chain_token_cost: 0,
    };

    this.opts.store.insert(row);
    this.opts.storePayload?.(taskId, req.payload);

    // Pin the CompiledSchema for this task's lifetime (Pitfall 5).
    this.pinned.set(taskId, compiled);

    // Track budgetOwner override if provided.
    if (req.budgetOwner) {
      this.budgetOwners.set(taskId, req.budgetOwner);
    }

    // Set up AbortController + optional deadline timer (HAND-03, Pitfall 4).
    const controller = new AbortController();
    this.inflight.set(taskId, controller);

    // Effective deadline: explicit > parent's > undefined.
    const parentDeadline = parentTaskId ? this.deadlines.get(parentTaskId) : undefined;
    const effectiveDeadline = req.deadline_ms ?? parentDeadline;
    if (effectiveDeadline !== undefined) {
      this.deadlines.set(taskId, effectiveDeadline);
      const remaining = effectiveDeadline - nowMs;
      if (remaining <= 0) {
        // Already past deadline -- transition immediately.
        this.handleTimeout(taskId, effectiveDeadline);
      } else {
        const timer = setTimeout(() => {
          this.handleTimeout(taskId, effectiveDeadline);
        }, remaining);
        timer.unref();
        this.timers.set(taskId, timer);
      }
    }

    // Build TurnOrigin for B's turn. TurnOrigin (zod-inferred) is a non-readonly
    // type, but Object.freeze produces Readonly<T>; cast away the readonly
    // modifier — runtime immutability is preserved by the freezes themselves
    // and the consumer (TurnDispatcher.dispatch) only reads from origin.
    const childOrigin: TurnOrigin = Object.freeze({
      source: Object.freeze({ kind: "task" as const, id: taskId }),
      rootTurnId: rootCausationId,
      parentTurnId: parentRow ? parentRow.causation_id : null,
      chain: Object.freeze([
        ...(parentRow?.causation_id ? [parentRow.causation_id] : []),
        taskId,
      ]),
      // Phase 60 TRIG-08 — TurnOrigin schema requires causationId (default
      // null for non-trigger flows). Tasks aren't trigger-driven.
      causationId: null,
    }) as unknown as TurnOrigin;

    // Transition pending -> running BEFORE dispatch (row is "live" while B executes).
    this.opts.store.transition(taskId, "running", { heartbeat_at: nowMs } as Record<string, unknown>);

    // Dispatch -- DO NOT await. Pitfall 1: HAND-01 async-ticket semantics.
    // Error handling flows through a catch that transitions the row to "failed".
    const promptText = this.formatDelegatePrompt(req.schema, req.payload);
    void this.opts.turnDispatcher
      // Cast options to include `signal` -- Plan 59-03 extends DispatchOptions.
      .dispatch(childOrigin, req.target, promptText, {
        signal: controller.signal,
      } as Parameters<TurnDispatcher["dispatch"]>[3])
      .catch((err: unknown) => this.handleDispatchError(taskId, err));

    this.log.info(
      {
        taskId,
        caller: req.caller,
        target: req.target,
        schema: req.schema,
        causationId: rootCausationId,
        depth: newDepth,
        deadlineMs: effectiveDeadline,
      },
      "task delegated",
    );

    return Object.freeze({ task_id: taskId });
  }

  /**
   * B calls this (via MCP task_complete in Plan 59-03) to deliver the
   * structured result. Validates against pinned output schema, transitions
   * to complete, records cost attribution, dispatches result-back turn to A.
   */
  async completeTask(
    taskId: string,
    resultPayload: unknown,
    chainTokenCost: number = 0,
  ): Promise<void> {
    const row = this.opts.store.get(taskId);
    if (!row) throw new TaskNotFoundError(taskId);

    const compiled = this.pinned.get(taskId);
    if (!compiled) {
      throw new ValidationError("output_invalid", `no pinned schema for task ${taskId}`, {
        taskId,
      });
    }

    try {
      compiled.output.parse(resultPayload);
    } catch (err) {
      throw new ValidationError("output_invalid", "result payload failed schema validation", {
        taskId,
        schema: row.task_type,
        zodIssues: (err as { issues?: unknown }).issues ?? String(err),
      });
    }

    const resultDigest = computeInputDigest(resultPayload);
    const nowMs = this.now();
    this.opts.store.transition(taskId, "complete", {
      ended_at: nowMs,
      result_digest: resultDigest,
      chain_token_cost: chainTokenCost,
    });
    this.opts.storeResult?.(taskId, resultPayload);

    // LIFE-05 cost attribution -- charge the caller (or budgetOwner override).
    const chargeAgent = this.budgetOwners.get(taskId) ?? row.caller_agent;
    const targetConfig = this.opts.getAgentConfig(row.target_agent);
    const model = targetConfig?.model ?? "haiku";
    if (chainTokenCost > 0) {
      this.opts.escalationBudget.recordUsage(chargeAgent, model, chainTokenCost);
    }

    this.clearInflight(taskId);

    // Dispatch result-back turn to A -- fresh TurnOrigin with kind:"task".
    const resultOrigin: TurnOrigin = Object.freeze({
      source: Object.freeze({ kind: "task" as const, id: taskId }),
      rootTurnId: row.causation_id,
      parentTurnId: row.causation_id,
      chain: Object.freeze([row.causation_id, taskId]),
      causationId: null,
    }) as unknown as TurnOrigin;
    const message = this.formatCompleteMessage(row.task_type, resultPayload);
    void this.opts.turnDispatcher
      .dispatch(resultOrigin, row.caller_agent, message)
      .catch((err: unknown) => {
        this.log.warn(
          { taskId, err: (err as Error).message },
          "result-back dispatch failed",
        );
      });

    this.log.info(
      { taskId, caller: row.caller_agent, chainTokenCost, chargeAgent },
      "task completed",
    );
  }

  /** Operator / agent cancels a running task. Transitions to 'cancelled'. */
  async cancel(taskId: string, cancellerName: string = "operator"): Promise<void> {
    const row = this.opts.store.get(taskId);
    if (!row) throw new TaskNotFoundError(taskId);

    const controller = this.inflight.get(taskId);
    controller?.abort();

    const nowMs = this.now();
    // transition() will throw IllegalTaskTransitionError if row is already terminal.
    this.opts.store.transition(taskId, "cancelled", {
      ended_at: nowMs,
      error: `cancelled by ${cancellerName}`,
    });

    this.clearInflight(taskId);

    const cancelOrigin: TurnOrigin = Object.freeze({
      source: Object.freeze({ kind: "task" as const, id: taskId }),
      rootTurnId: row.causation_id,
      parentTurnId: row.causation_id,
      chain: Object.freeze([row.causation_id, taskId]),
      causationId: null,
    }) as unknown as TurnOrigin;
    const message = `Task '${row.task_type}' was CANCELLED by ${cancellerName}`;
    void this.opts.turnDispatcher
      .dispatch(cancelOrigin, row.caller_agent, message)
      .catch((err: unknown) => {
        this.log.warn({ taskId, err: (err as Error).message }, "cancel dispatch failed");
      });

    this.log.info({ taskId, cancellerName }, "task cancelled");
  }

  /**
   * LIFE-06 retry -- re-dispatches a failed/cancelled/timed-out task with
   * the IDENTICAL input payload against the ORIGINAL caller. Pitfall 3
   * digest byte-compare, Pitfall 8 budget charged to original caller.
   */
  async retry(taskId: string): Promise<DelegateResponse> {
    const row = this.opts.store.get(taskId);
    if (!row) throw new TaskNotFoundError(taskId);

    // Must be a terminal non-complete state -- complete tasks have already
    // delivered results; running tasks aren't retryable.
    const retryable: readonly TaskStatus[] = ["failed", "cancelled", "timed_out", "orphaned"];
    if (!retryable.includes(row.status)) {
      throw new ValidationError(
        "schema_mismatch",
        `task ${taskId} status '${row.status}' is not retryable (must be one of: ${retryable.join(", ")})`,
        { taskId, status: row.status },
      );
    }

    const stored = this.opts.getStoredPayload?.(taskId);
    if (stored === null || stored === undefined) {
      throw new ValidationError("schema_mismatch", `stored payload for ${taskId} is missing`, {
        taskId,
      });
    }
    const recomputed = computeInputDigest(stored);
    if (recomputed !== row.input_digest) {
      throw new ValidationError(
        "schema_mismatch",
        "retry digest mismatch -- payload must be byte-identical",
        { taskId, expected: row.input_digest, got: recomputed },
      );
    }

    // Re-delegate as a fresh task -- same caller, same target, same schema,
    // same payload. New task_id; original parent chain preserved.
    // Pitfall 8 -- charges the original caller, not any operator identity.
    return this.delegate({
      caller: row.caller_agent,
      target: row.target_agent,
      schema: row.task_type,
      payload: stored,
      parentTaskId: row.parent_task_id,
    });
  }

  getStatus(taskId: string): StatusResponse {
    const row = this.opts.store.get(taskId);
    if (!row) throw new TaskNotFoundError(taskId);
    return Object.freeze({
      task_id: taskId,
      status: row.status,
      ...(row.error ? { error: row.error } : {}),
      ...(row.status === "complete"
        ? { result: this.opts.getStoredResult?.(taskId) ?? undefined }
        : {}),
    } as StatusResponse);
  }

  // ---------- private helpers ----------

  private formatDelegatePrompt(schemaName: string, payload: unknown): string {
    return (
      `You have been delegated task '${schemaName}'. When done, call ` +
      `the \`task_complete\` MCP tool with your structured result.\n\n` +
      `Input payload:\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``
    );
  }

  private formatCompleteMessage(schemaName: string, result: unknown): string {
    return (
      `Task '${schemaName}' completed. Result:\n\`\`\`json\n` +
      `${JSON.stringify(result, null, 2)}\n\`\`\``
    );
  }

  private handleTimeout(taskId: string, deadlineMs: number): void {
    const row = this.opts.store.get(taskId);
    if (!row) return;
    // Only transition if still in-flight.
    if (row.status !== "running" && row.status !== "awaiting_input") return;

    const controller = this.inflight.get(taskId);
    controller?.abort();

    const nowMs = this.now();
    try {
      this.opts.store.transition(taskId, "timed_out", {
        ended_at: nowMs,
        error: `deadline exceeded (${deadlineMs}ms)`,
      });
    } catch (err) {
      this.log.warn(
        { taskId, err: (err as Error).message },
        "timeout transition failed",
      );
      return;
    }

    this.clearInflight(taskId);

    const timeoutOrigin: TurnOrigin = Object.freeze({
      source: Object.freeze({ kind: "task" as const, id: taskId }),
      rootTurnId: row.causation_id,
      parentTurnId: row.causation_id,
      chain: Object.freeze([row.causation_id, taskId]),
      causationId: null,
    }) as unknown as TurnOrigin;
    const message = `Task '${row.task_type}' TIMED OUT after ${deadlineMs}ms`;
    void this.opts.turnDispatcher
      .dispatch(timeoutOrigin, row.caller_agent, message)
      .catch((err: unknown) => {
        this.log.warn({ taskId, err: (err as Error).message }, "timeout dispatch failed");
      });
  }

  private handleDispatchError(taskId: string, err: unknown): void {
    const row = this.opts.store.get(taskId);
    if (!row || row.status !== "running") return;
    const message = (err as Error)?.message ?? String(err);
    const nowMs = this.now();
    try {
      this.opts.store.transition(taskId, "failed", {
        ended_at: nowMs,
        error: message,
      });
    } catch {
      /* Already terminal -- ignore. */
    }
    this.clearInflight(taskId);
    this.log.warn({ taskId, error: message }, "task dispatch failed");
  }

  private clearInflight(taskId: string): void {
    this.inflight.delete(taskId);
    this.pinned.delete(taskId);
    this.budgetOwners.delete(taskId);
    const timer = this.timers.get(taskId);
    if (timer) clearTimeout(timer);
    this.timers.delete(taskId);
    // deadlines map retained for observability; not memory-bounded in v1.8.
  }
}
