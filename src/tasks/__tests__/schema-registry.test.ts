/**
 * Phase 59 Plan 01 Task 3 — SchemaRegistry YAML loader tests.
 *
 * Tests:
 *   1. Happy path: 2 valid YAML files compile + index
 *   2. End-to-end parse through compiled Zod (input/output)
 *   3. Missing directory → empty registry (no throw)
 *   4. Empty directory → empty registry
 *   5. Non-yaml files ignored
 *   6. Malformed YAML skipped, valid siblings still load
 *   7. Missing input/output section skipped
 *   8. Unsupported JSON Schema construct skipped
 *   9. TASK_SCHEMAS_DIR default path under homedir
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SchemaRegistry, TASK_SCHEMAS_DIR } from "../schema-registry.js";

const researchBriefYaml = `
name: research.brief
description: Research brief task.
input:
  type: object
  required: [topic]
  properties:
    topic: { type: string, minLength: 3 }
    depth: { type: string, enum: [shallow, medium, deep] }
output:
  type: object
  required: [summary]
  properties:
    summary: { type: string, minLength: 10 }
`;

const acmeFollowupYaml = `
name: acme.followup
description: Client follow-up task.
input:
  type: object
  required: [clientId]
  properties:
    clientId: { type: string }
    priority: { type: string, enum: [low, high] }
output:
  type: object
  required: [sent]
  properties:
    sent: { type: boolean }
`;

describe("SchemaRegistry", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "schema-registry-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("Test 1: happy path — 2 valid YAML files loaded", async () => {
    await writeFile(join(tmpDir, "research.brief.yaml"), researchBriefYaml, "utf8");
    await writeFile(join(tmpDir, "acme.followup.yaml"), acmeFollowupYaml, "utf8");

    const reg = await SchemaRegistry.load(tmpDir);
    expect(reg.size()).toBe(2);
    expect(reg.names()).toContain("research.brief");
    expect(reg.names()).toContain("acme.followup");

    const rb = reg.get("research.brief");
    expect(rb).not.toBeNull();
    expect(rb!.name).toBe("research.brief");
    expect(typeof rb!.input.parse).toBe("function");
    expect(typeof rb!.output.parse).toBe("function");

    expect(reg.get("unknown")).toBeNull();
  });

  it("Test 2: end-to-end parse through compiled Zod", async () => {
    await writeFile(join(tmpDir, "research.brief.yaml"), researchBriefYaml, "utf8");
    const reg = await SchemaRegistry.load(tmpDir);
    const compiled = reg.get("research.brief");
    expect(compiled).not.toBeNull();

    // Valid input
    expect(compiled!.input.parse({ topic: "AI safety", depth: "deep" })).toEqual({
      topic: "AI safety",
      depth: "deep",
    });
    // minLength violation
    expect(() => compiled!.input.parse({ topic: "hi" })).toThrow();
    // .strict() unknown-key rejection
    expect(() => compiled!.input.parse({ topic: "okay now", extra: "x" })).toThrow();
  });

  it("Test 3: missing directory → empty registry (no throw)", async () => {
    const reg = await SchemaRegistry.load("/nonexistent/path/definitely-not-there");
    expect(reg.size()).toBe(0);
    expect(reg.names()).toEqual([]);
  });

  it("Test 4: empty directory → empty registry", async () => {
    const reg = await SchemaRegistry.load(tmpDir);
    expect(reg.size()).toBe(0);
  });

  it("Test 5: non-yaml files ignored", async () => {
    await writeFile(join(tmpDir, "notes.txt"), "hello\n", "utf8");
    await writeFile(join(tmpDir, "research.brief.yaml"), researchBriefYaml, "utf8");
    const reg = await SchemaRegistry.load(tmpDir);
    expect(reg.size()).toBe(1);
    expect(reg.get("research.brief")).not.toBeNull();
  });

  it("Test 6: malformed YAML skipped, valid sibling still loads", async () => {
    await writeFile(join(tmpDir, "broken.yaml"), "name: [\n:unclosed", "utf8");
    await writeFile(join(tmpDir, "research.brief.yaml"), researchBriefYaml, "utf8");
    const reg = await SchemaRegistry.load(tmpDir);
    expect(reg.size()).toBe(1);
    expect(reg.get("research.brief")).not.toBeNull();
  });

  it("Test 7: YAML missing input/output section is skipped", async () => {
    const partial = `
name: partial.only
description: No input or output.
`;
    await writeFile(join(tmpDir, "partial.yaml"), partial, "utf8");
    const reg = await SchemaRegistry.load(tmpDir);
    expect(reg.size()).toBe(0);
    expect(reg.get("partial.only")).toBeNull();
  });

  it("Test 8: unsupported JSON Schema construct skipped (compile fails)", async () => {
    const bad = `
name: bad.schema
description: Uses an unsupported type.
input:
  type: wizard
output:
  type: object
  required: []
  properties: {}
`;
    await writeFile(join(tmpDir, "bad.yaml"), bad, "utf8");
    const reg = await SchemaRegistry.load(tmpDir);
    expect(reg.size()).toBe(0);
  });

  it("Test 9: TASK_SCHEMAS_DIR default path format", () => {
    // Just verify it ends in .clawcode/task-schemas — homedir() prefix varies by test env.
    expect(TASK_SCHEMAS_DIR).toContain(".clawcode");
    expect(TASK_SCHEMAS_DIR).toContain("task-schemas");
  });
});
