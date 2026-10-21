/**
 * Phase 59 Plan 01 Task 1 — digest.ts + errors.ts (handoff-error extensions) tests.
 *
 * 14 tests total:
 *   1-7: computeInputDigest behavior (determinism, format, normalization)
 *   8-13: 6 new Phase 59 handoff error class shapes
 *   14: Phase 58 error preservation (no regression)
 */

import { describe, it, expect } from "vitest";
import { computeInputDigest } from "../digest.js";
import {
  ValidationError,
  UnauthorizedError,
  CycleDetectedError,
  DepthExceededError,
  SelfHandoffBlockedError,
  DeadlineExceededError,
  // Phase 58 classes — preservation check
  TaskStoreError,
  IllegalTaskTransitionError,
  TaskNotFoundError,
} from "../errors.js";

describe("computeInputDigest", () => {
  it("Test 1: produces byte-identical output regardless of key insertion order", () => {
    const a = computeInputDigest({ a: 1, b: 2 });
    const b = computeInputDigest({ b: 2, a: 1 });
    expect(a).toBe(b);
  });

  it("Test 2: returns sha256:<64 lowercase hex> formatted string", () => {
    const digest = computeInputDigest({ any: "value" });
    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("Test 3: normalizes undefined to null (canonical semantics)", () => {
    const withUndef = computeInputDigest({ x: undefined, y: null });
    const withNull = computeInputDigest({ x: null, y: null });
    expect(withUndef).toBe(withNull);
  });

  it("Test 4: sorts keys recursively in nested objects", () => {
    const a = computeInputDigest({ outer: { b: 2, a: 1 } });
    const b = computeInputDigest({ outer: { a: 1, b: 2 } });
    expect(a).toBe(b);
  });

  it("Test 5: preserves array order (arrays are order-significant)", () => {
    const forward = computeInputDigest([1, 2, 3]);
    const reverse = computeInputDigest([3, 2, 1]);
    expect(forward).not.toBe(reverse);
  });

  it("Test 6: handles primitives (string, number, boolean)", () => {
    const s = computeInputDigest("hello");
    const n = computeInputDigest(42);
    const b = computeInputDigest(true);
    expect(s).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(n).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(b).toMatch(/^sha256:[a-f0-9]{64}$/);
    // All three distinct
    expect(new Set([s, n, b]).size).toBe(3);
  });

  it('Test 7: empty object digest equals sha256 of literal "{}"', () => {
    // Computed via: node -e 'console.log(require("crypto").createHash("sha256").update("{}").digest("hex"))'
    const expected = "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
    expect(computeInputDigest({})).toBe(expected);
  });
});

describe("Phase 59 handoff error classes", () => {
  it("Test 8: ValidationError carries reason + frozen details + formatted message", () => {
    const err = new ValidationError("payload_too_large", "size=70000 > 64KB", { size: 70000 });
    expect(err.name).toBe("ValidationError");
    expect(err.reason).toBe("payload_too_large");
    expect(err.details["size"]).toBe(70000);
    expect(Object.isFrozen(err.details)).toBe(true);
    expect(err.message).toContain("Validation failed");
    expect(err.message).toContain("payload_too_large");
  });

  it("Test 8b: ValidationError details defaults to {} when omitted", () => {
    const err = new ValidationError("unknown_schema", "nope");
    expect(Object.isFrozen(err.details)).toBe(true);
    expect(Object.keys(err.details)).toHaveLength(0);
  });

  it("Test 9: UnauthorizedError carries caller/target/schema and message includes all three", () => {
    const err = new UnauthorizedError("A", "B", "research.brief");
    expect(err.name).toBe("UnauthorizedError");
    expect(err.caller).toBe("A");
    expect(err.target).toBe("B");
    expect(err.schema).toBe("research.brief");
    expect(err.message).toContain("A");
    expect(err.message).toContain("B");
    expect(err.message).toContain("research.brief");
  });

  it("Test 10: CycleDetectedError — name + target + foundAtTaskId", () => {
    const err = new CycleDetectedError("agentB", "task_xyz");
    expect(err.name).toBe("CycleDetectedError");
    expect(err.target).toBe("agentB");
    expect(err.foundAtTaskId).toBe("task_xyz");
    expect(err.message).toContain("agentB");
    expect(err.message).toContain("task_xyz");
  });

  it("Test 11: DepthExceededError — depth and max readable in message", () => {
    const err = new DepthExceededError(7, 5);
    expect(err.name).toBe("DepthExceededError");
    expect(err.depth).toBe(7);
    expect(err.max).toBe(5);
    expect(err.message).toContain("7");
    expect(err.message).toContain("5");
  });

  it("Test 12: SelfHandoffBlockedError — name + agent", () => {
    const err = new SelfHandoffBlockedError("clawdy");
    expect(err.name).toBe("SelfHandoffBlockedError");
    expect(err.agent).toBe("clawdy");
    expect(err.message).toContain("clawdy");
  });

  it("Test 13: DeadlineExceededError — name + taskId + deadlineMs", () => {
    const err = new DeadlineExceededError("task_abc", 60000);
    expect(err.name).toBe("DeadlineExceededError");
    expect(err.taskId).toBe("task_abc");
    expect(err.deadlineMs).toBe(60000);
    expect(err.message).toContain("task_abc");
    expect(err.message).toContain("60000");
  });
});

describe("Phase 58 error preservation (no regression)", () => {
  it("Test 14: TaskStoreError / IllegalTaskTransitionError / TaskNotFoundError still construct", () => {
    const store = new TaskStoreError("db locked", "/tmp/tasks.db");
    expect(store.name).toBe("TaskStoreError");
    expect(store.dbPath).toBe("/tmp/tasks.db");

    const trans = new IllegalTaskTransitionError("complete", "running");
    expect(trans.name).toBe("IllegalTaskTransitionError");
    expect(trans.from).toBe("complete");
    expect(trans.to).toBe("running");

    const nf = new TaskNotFoundError("task_missing");
    expect(nf.name).toBe("TaskNotFoundError");
    expect(nf.taskId).toBe("task_missing");
  });
});
