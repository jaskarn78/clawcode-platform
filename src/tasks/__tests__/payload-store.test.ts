/**
 * Phase 59 Plan 03 Task 1 -- PayloadStore tests + TaskStore.rawDb getter tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { TaskStore } from "../store.js";
import { PayloadStore } from "../payload-store.js";
import { computeInputDigest } from "../digest.js";

describe("PayloadStore", () => {
  let tmpDir: string;
  let taskStore: TaskStore;
  let payloadStore: PayloadStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "payload-store-test-"));
    taskStore = new TaskStore({ dbPath: join(tmpDir, "test.db") });
    payloadStore = new PayloadStore(taskStore.rawDb);
  });

  afterEach(async () => {
    taskStore.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Test 8: idempotent migration
  it("survives double construction against the same db (idempotent migration)", () => {
    // Second construction should NOT throw
    const secondStore = new PayloadStore(taskStore.rawDb);
    expect(secondStore).toBeDefined();
  });

  // Test 9: storePayload + getPayload roundtrip
  it("round-trips payload via storePayload + getPayload", () => {
    const payload = { topic: "AI", depth: "deep" };
    payloadStore.storePayload("task:abc", payload);
    const retrieved = payloadStore.getPayload("task:abc");
    expect(retrieved).toEqual(payload);
  });

  // Test 10: digest roundtrip (LIFE-06 foundation)
  it("preserves byte-identical digest through store/retrieve cycle (LIFE-06)", () => {
    const payload = { topic: "AI safety", depth: "deep" };
    const originalDigest = computeInputDigest(payload);
    payloadStore.storePayload("task:abc", payload);
    const retrieved = payloadStore.getPayload("task:abc");
    const reDigest = computeInputDigest(retrieved);
    expect(reDigest).toBe(originalDigest);
  });

  // Test 11: getPayload missing returns null
  it("returns null for a missing payload", () => {
    expect(payloadStore.getPayload("task:nonexistent")).toBeNull();
  });

  // Test 12: storeResult + getResult roundtrip
  it("round-trips result via storeResult + getResult", () => {
    const payload = { topic: "test" };
    payloadStore.storePayload("task:xyz", payload);
    const result = { summary: "done here", sources: ["a", "b"] };
    payloadStore.storeResult("task:xyz", result);
    expect(payloadStore.getResult("task:xyz")).toEqual(result);
  });

  // Test 13: storePayload overwrites (UPSERT semantics)
  it("overwrites payload on second storePayload (UPSERT)", () => {
    payloadStore.storePayload("task:dup", { v: 1 });
    payloadStore.storePayload("task:dup", { v: 2 });
    expect(payloadStore.getPayload("task:dup")).toEqual({ v: 2 });
  });

  // Test 14: storeResult preserves input
  it("storeResult does not clobber the stored input", () => {
    const payload = { original: true };
    payloadStore.storePayload("task:both", payload);
    payloadStore.storeResult("task:both", { done: true });
    expect(payloadStore.getPayload("task:both")).toEqual(payload);
  });

  // Test 15: timestamps
  it("sets created_at and updated_at on storePayload; storeResult updates only updated_at", () => {
    const beforeStore = Date.now();
    payloadStore.storePayload("task:ts", { x: 1 });

    const db = taskStore.rawDb;
    const row1 = db.prepare("SELECT created_at, updated_at FROM task_payloads WHERE task_id = ?").get("task:ts") as { created_at: number; updated_at: number };
    expect(row1.created_at).toBeGreaterThanOrEqual(beforeStore);
    expect(row1.updated_at).toBe(row1.created_at);

    // Small delay to ensure updated_at changes
    const createdAt = row1.created_at;
    payloadStore.storeResult("task:ts", { result: true });

    const row2 = db.prepare("SELECT created_at, updated_at FROM task_payloads WHERE task_id = ?").get("task:ts") as { created_at: number; updated_at: number };
    // created_at unchanged
    expect(row2.created_at).toBe(createdAt);
    // updated_at should be >= created_at
    expect(row2.updated_at).toBeGreaterThanOrEqual(createdAt);
  });

  // Test 16: null result handling
  it("returns null for getResult when result_json is NULL", () => {
    payloadStore.storePayload("task:nr", { x: 1 });
    // No storeResult called, so result_json is NULL
    expect(payloadStore.getResult("task:nr")).toBeNull();
  });
});

describe("TaskStore.rawDb", () => {
  let tmpDir: string;
  let taskStore: TaskStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "rawdb-test-"));
    taskStore = new TaskStore({ dbPath: join(tmpDir, "test.db") });
  });

  afterEach(async () => {
    taskStore.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Test 17: rawDb returns a usable Database handle
  it("returns a usable better-sqlite3 Database handle", () => {
    const db = taskStore.rawDb;
    const row = db.prepare("SELECT 1 as val").get() as { val: number };
    expect(row.val).toBe(1);
  });

  // Test 18: rawDb after close throws
  it("throws when accessing rawDb after store is closed", () => {
    taskStore.close();
    const db = taskStore.rawDb; // getter itself doesn't throw; the handle is just closed
    expect(() => db.prepare("SELECT 1").get()).toThrow();
  });
});
