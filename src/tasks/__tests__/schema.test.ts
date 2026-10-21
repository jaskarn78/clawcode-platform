import { describe, it, expect } from "vitest";
import {
  TASK_STATUSES,
  TERMINAL_STATUSES,
  IN_FLIGHT_STATUSES,
  type TaskStatus,
} from "../types.js";
import {
  TaskRowSchema,
  TriggerStateRowSchema,
  type TaskRow,
} from "../schema.js";
import {
  TaskStoreError,
  IllegalTaskTransitionError,
  TaskNotFoundError,
} from "../errors.js";

/**
 * Build a minimal valid TaskRow with every one of the 15 LIFE-02 fields
 * populated. Tests mutate the returned object to exercise rejection paths.
 */
function validRow(): TaskRow {
  return {
    task_id: "task_abc123",
    task_type: "research.brief",
    caller_agent: "agent-a",
    target_agent: "agent-b",
    causation_id: "trigger:rootid7890",
    parent_task_id: null,
    depth: 0,
    input_digest: "sha256:deadbeef",
    status: "pending",
    started_at: 1700000000000,
    ended_at: null,
    heartbeat_at: 1700000000000,
    result_digest: null,
    error: null,
    chain_token_cost: 0,
  };
}

describe("TASK_STATUSES tuple", () => {
  it("has exactly 8 entries in the locked order", () => {
    expect(TASK_STATUSES).toEqual([
      "pending",
      "running",
      "awaiting_input",
      "complete",
      "failed",
      "cancelled",
      "timed_out",
      "orphaned",
    ]);
    expect(TASK_STATUSES.length).toBe(8);
  });
});

describe("TaskRowSchema", () => {
  it("parses a hand-built row with all 15 LIFE-02 fields and round-trips through JSON", () => {
    const row = validRow();
    const parsed = TaskRowSchema.parse(row);

    // Round-trip through JSON to confirm serializability.
    const json = JSON.stringify(parsed);
    const reparsed = TaskRowSchema.parse(JSON.parse(json));

    expect(reparsed).toEqual(parsed);

    // Verify all 15 fields survived the round-trip.
    const keys = Object.keys(reparsed).sort();
    expect(keys).toEqual(
      [
        "task_id",
        "task_type",
        "caller_agent",
        "target_agent",
        "causation_id",
        "parent_task_id",
        "depth",
        "input_digest",
        "status",
        "started_at",
        "ended_at",
        "heartbeat_at",
        "result_digest",
        "error",
        "chain_token_cost",
      ].sort(),
    );
  });

  it("rejects a row missing task_id", () => {
    const row = validRow() as Record<string, unknown>;
    delete row["task_id"];
    expect(() => TaskRowSchema.parse(row)).toThrow();
  });

  it("rejects a row with depth: -1", () => {
    const row = validRow();
    const bad = { ...row, depth: -1 };
    expect(() => TaskRowSchema.parse(bad)).toThrow();
  });

  it("rejects a row with status: 'bogus'", () => {
    const row = validRow();
    const bad = { ...row, status: "bogus" as unknown as TaskStatus };
    expect(() => TaskRowSchema.parse(bad)).toThrow();
  });

  it("allows parent_task_id, ended_at, result_digest, error to all be null", () => {
    const row = {
      ...validRow(),
      parent_task_id: null,
      ended_at: null,
      result_digest: null,
      error: null,
    };
    const parsed = TaskRowSchema.parse(row);
    expect(parsed.parent_task_id).toBeNull();
    expect(parsed.ended_at).toBeNull();
    expect(parsed.result_digest).toBeNull();
    expect(parsed.error).toBeNull();
  });

  it("applies chain_token_cost: 0 default when omitted", () => {
    const row = validRow() as Record<string, unknown>;
    delete row["chain_token_cost"];
    const parsed = TaskRowSchema.parse(row);
    expect(parsed.chain_token_cost).toBe(0);
  });
});

describe("TriggerStateRowSchema", () => {
  it("parses a row with watermark + null cursor and round-trips", () => {
    const row = {
      source_id: "scheduler",
      last_watermark: "2026-04-15T00:00:00Z",
      cursor_blob: null,
      updated_at: 1700000000000,
    };
    const parsed = TriggerStateRowSchema.parse(row);
    const reparsed = TriggerStateRowSchema.parse(
      JSON.parse(JSON.stringify(parsed)),
    );
    expect(reparsed).toEqual(parsed);
  });

  it("allows both last_watermark and cursor_blob to be null (fresh source)", () => {
    const row = {
      source_id: "webhook-stripe",
      last_watermark: null,
      cursor_blob: null,
      updated_at: 1700000000000,
    };
    const parsed = TriggerStateRowSchema.parse(row);
    expect(parsed.last_watermark).toBeNull();
    expect(parsed.cursor_blob).toBeNull();
  });
});

describe("TERMINAL_STATUSES set", () => {
  it("has exactly 5 members: complete, failed, cancelled, timed_out, orphaned", () => {
    expect(TERMINAL_STATUSES.size).toBe(5);
    expect(TERMINAL_STATUSES.has("complete")).toBe(true);
    expect(TERMINAL_STATUSES.has("failed")).toBe(true);
    expect(TERMINAL_STATUSES.has("cancelled")).toBe(true);
    expect(TERMINAL_STATUSES.has("timed_out")).toBe(true);
    expect(TERMINAL_STATUSES.has("orphaned")).toBe(true);
    expect(TERMINAL_STATUSES.has("running")).toBe(false);
    expect(TERMINAL_STATUSES.has("pending")).toBe(false);
    expect(TERMINAL_STATUSES.has("awaiting_input")).toBe(false);
  });
});

describe("IN_FLIGHT_STATUSES set", () => {
  it("has exactly 2 members: running, awaiting_input", () => {
    expect(IN_FLIGHT_STATUSES.size).toBe(2);
    expect(IN_FLIGHT_STATUSES.has("running")).toBe(true);
    expect(IN_FLIGHT_STATUSES.has("awaiting_input")).toBe(true);
    expect(IN_FLIGHT_STATUSES.has("pending")).toBe(false);
    expect(IN_FLIGHT_STATUSES.has("complete")).toBe(false);
  });
});

describe("TaskStoreError", () => {
  it("sets name, exposes readonly dbPath, formats message with path suffix", () => {
    const err = new TaskStoreError("insert failed", "/tmp/tasks.db");
    expect(err.name).toBe("TaskStoreError");
    expect(err.dbPath).toBe("/tmp/tasks.db");
    expect(err.message).toBe("TaskStore: insert failed (/tmp/tasks.db)");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("IllegalTaskTransitionError", () => {
  it("sets name, exposes readonly from + to, formats message with arrow", () => {
    const err = new IllegalTaskTransitionError("complete", "running");
    expect(err.name).toBe("IllegalTaskTransitionError");
    expect(err.from).toBe("complete");
    expect(err.to).toBe("running");
    expect(err.message).toBe("Illegal task transition: complete → running");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("TaskNotFoundError", () => {
  it("sets name and exposes readonly taskId", () => {
    const err = new TaskNotFoundError("task_xyz");
    expect(err.name).toBe("TaskNotFoundError");
    expect(err.taskId).toBe("task_xyz");
    expect(err.message).toBe("Task not found: task_xyz");
    expect(err).toBeInstanceOf(Error);
  });
});
