/**
 * Phase 142 — eval-set schema + loader tests.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evalSetSchema, evalTaskSchema, loadEvalSet } from "../eval-set.js";

describe("Phase 142 — eval-set schema", () => {
  it("parses a valid eval set and defaults weight to 1", () => {
    const r = evalSetSchema.parse({
      tasks: [{ id: "t1", prompt: "hi", successCriteria: "greets back" }],
    });
    expect(r.tasks).toHaveLength(1);
    expect(r.tasks[0].weight).toBe(1);
  });

  it("keeps the optional expectSubstrings hard check + custom weight", () => {
    const r = evalTaskSchema.parse({
      id: "t",
      prompt: "weather?",
      successCriteria: "reports current temp",
      expectSubstrings: ["degrees"],
      weight: 2,
    });
    expect(r.expectSubstrings).toEqual(["degrees"]);
    expect(r.weight).toBe(2);
  });

  it("strips an unknown field like expectToolUsed (not in v1 schema)", () => {
    const r = evalTaskSchema.parse({
      id: "t",
      prompt: "p",
      successCriteria: "c",
      expectToolUsed: ["search"],
    });
    expect((r as Record<string, unknown>).expectToolUsed).toBeUndefined();
  });

  it("rejects an empty task list (an eval set with no tasks is meaningless)", () => {
    expect(() => evalSetSchema.parse({ tasks: [] })).toThrow();
  });

  it("rejects a task missing successCriteria (the judge needs a target)", () => {
    expect(() =>
      evalSetSchema.parse({ tasks: [{ id: "t", prompt: "p" }] }),
    ).toThrow();
  });

  it("rejects a non-positive weight", () => {
    expect(() =>
      evalTaskSchema.parse({ id: "t", prompt: "p", successCriteria: "c", weight: 0 }),
    ).toThrow();
  });
});

describe("Phase 142 — loadEvalSet", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "evalset-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads + validates a YAML eval set", async () => {
    const p = join(dir, "eval.yaml");
    await writeFile(
      p,
      'tasks:\n  - id: t1\n    prompt: "hi"\n    successCriteria: "greets back"\n',
    );
    const set = await loadEvalSet(p);
    expect(set.tasks[0].id).toBe("t1");
    expect(set.tasks[0].weight).toBe(1);
  });

  it("loads a JSON eval set (yaml.parse accepts JSON)", async () => {
    const p = join(dir, "eval.json");
    await writeFile(
      p,
      JSON.stringify({ tasks: [{ id: "j", prompt: "p", successCriteria: "c" }] }),
    );
    const set = await loadEvalSet(p);
    expect(set.tasks[0].id).toBe("j");
  });

  it("throws a contextual error for a missing file", async () => {
    await expect(loadEvalSet(join(dir, "nope.yaml"))).rejects.toThrow(
      /failed to read eval set/,
    );
  });

  it("throws a contextual error (with path) for an invalid shape", async () => {
    const p = join(dir, "bad.yaml");
    await writeFile(p, "tasks: []\n");
    await expect(loadEvalSet(p)).rejects.toThrow(/invalid/);
  });
});
