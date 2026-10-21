/**
 * Phase 59 — pure authorization checks.
 *
 * Each function composes into TaskManager.delegate (Plan 59-02) BEFORE any I/O.
 * They fail fast with typed errors — no side effects, no log writes (logging
 * happens in the caller). checkCycle is the only function that reads state
 * and it takes a narrow Pick<TaskStore, "get"> so unit tests can mock without
 * SQLite.
 *
 * Canonical call order (see 59-RESEARCH.md "Authorization check order"):
 *   1. checkSelfHandoff(caller, target)           — cheapest
 *   2. registry.get(schemaName) presence          — in-memory
 *   3. payload size <= MAX_PAYLOAD_BYTES          — one JSON.stringify
 *   4. compiledSchema.input.parse(payload)        — full Zod walk
 *   5. checkAllowlist(targetConfig, ...)          — agent config lookup
 *   6. checkDepth + checkCycle                     — DB read walk
 */

import type { TaskRow } from "./schema.js";
import type { TaskStore } from "./store.js";
import {
  SelfHandoffBlockedError,
  DepthExceededError,
  UnauthorizedError,
  CycleDetectedError,
} from "./errors.js";

/** Payload byte cap per HAND-02 (64 KB). Enforced BEFORE Zod parse for fast-fail. */
export const MAX_PAYLOAD_BYTES = 64 * 1024;

export function checkSelfHandoff(caller: string, target: string): void {
  if (caller === target) {
    throw new SelfHandoffBlockedError(caller);
  }
}

export function checkDepth(depth: number, max: number): void {
  if (depth > max) {
    throw new DepthExceededError(depth, max);
  }
}

export function checkAllowlist(
  targetConfig: {
    readonly name: string;
    readonly acceptsTasks?: Readonly<Record<string, readonly string[]>>;
  },
  caller: string,
  schemaName: string,
): void {
  const allowed = targetConfig.acceptsTasks?.[schemaName];
  if (!allowed || !allowed.includes(caller)) {
    throw new UnauthorizedError(caller, targetConfig.name, schemaName);
  }
}

/**
 * Walk the causation chain up to `maxDepth` hops via TaskStore.get. Throws
 * CycleDetectedError if `target` appears as caller_agent OR target_agent in
 * any visited row. Bounded walk — even on malformed/deep chains, stops at
 * maxDepth hops.
 */
export function checkCycle(
  store: Pick<TaskStore, "get">,
  target: string,
  parentTaskId: string | null,
  maxDepth: number,
): void {
  let cursor: string | null = parentTaskId;
  let hops = 0;
  while (cursor !== null && hops < maxDepth) {
    const row: TaskRow | null = store.get(cursor);
    if (!row) break;
    if (row.target_agent === target || row.caller_agent === target) {
      throw new CycleDetectedError(target, cursor);
    }
    cursor = row.parent_task_id;
    hops += 1;
  }
}
