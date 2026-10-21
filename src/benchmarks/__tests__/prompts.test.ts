import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPrompts } from "../prompts.js";
import { BenchmarkConfigError } from "../types.js";

describe("loadPrompts", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "prompts-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeYaml(name: string, body: string): string {
    const p = join(tmp, name);
    writeFileSync(p, body, "utf-8");
    return p;
  }

  it("parses a well-formed prompts.yaml into a frozen typed array", () => {
    const path = writeYaml(
      "prompts.yaml",
      `prompts:
  - id: "no-tool-short"
    prompt: "Say hi."
    description: "Baseline — no tools, short reply."
  - id: "memory-lookup"
    prompt: "Recall my favorite color."
`,
    );
    const result = loadPrompts(path);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: "no-tool-short",
      prompt: "Say hi.",
      description: "Baseline — no tools, short reply.",
    });
    expect(result[1]).toEqual({
      id: "memory-lookup",
      prompt: "Recall my favorite color.",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0])).toBe(true);
  });

  it("throws BenchmarkConfigError when the file is missing", () => {
    const missingPath = join(tmp, "nope.yaml");
    try {
      loadPrompts(missingPath);
      expect.fail("expected loadPrompts to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BenchmarkConfigError);
      expect((err as BenchmarkConfigError).path).toBe(missingPath);
      expect((err as BenchmarkConfigError).message).toContain("read failed");
    }
  });

  it("throws BenchmarkConfigError when `prompts` key is missing", () => {
    const path = writeYaml("empty.yaml", "version: 1\n");
    try {
      loadPrompts(path);
      expect.fail("expected loadPrompts to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BenchmarkConfigError);
      expect((err as BenchmarkConfigError).message.toLowerCase()).toContain(
        "prompts",
      );
    }
  });

  it("rejects an empty prompts array (must have at least 1)", () => {
    const path = writeYaml("empty-prompts.yaml", "prompts: []\n");
    try {
      loadPrompts(path);
      expect.fail("expected loadPrompts to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BenchmarkConfigError);
      expect((err as BenchmarkConfigError).message.toLowerCase()).toContain(
        "schema invalid",
      );
    }
  });

  it("rejects a prompt entry with an empty id or empty prompt string", () => {
    const pathEmptyId = writeYaml(
      "empty-id.yaml",
      `prompts:
  - id: ""
    prompt: "nonempty"
`,
    );
    expect(() => loadPrompts(pathEmptyId)).toThrow(BenchmarkConfigError);

    const pathEmptyPrompt = writeYaml(
      "empty-prompt.yaml",
      `prompts:
  - id: "nonempty"
    prompt: ""
`,
    );
    expect(() => loadPrompts(pathEmptyPrompt)).toThrow(BenchmarkConfigError);
  });
});
