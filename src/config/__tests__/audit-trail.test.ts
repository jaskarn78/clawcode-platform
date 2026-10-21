import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuditTrail } from "../audit-trail.js";
import pino from "pino";
import type { ConfigChange } from "../types.js";

const log = pino({ level: "silent" });

describe("AuditTrail", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "audit-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes JSONL format with one line per change", async () => {
    const filePath = join(tmpDir, "audit.jsonl");
    const audit = new AuditTrail({ filePath, log });

    const changes: readonly ConfigChange[] = [
      { fieldPath: "agents.researcher.channels", oldValue: ["123"], newValue: ["123", "456"], reloadable: true },
      { fieldPath: "defaults.model", oldValue: "sonnet", newValue: "opus", reloadable: false },
    ];

    await audit.record(changes);

    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);

    const entry1 = JSON.parse(lines[0]);
    expect(entry1.fieldPath).toBe("agents.researcher.channels");
    expect(entry1.oldValue).toEqual(["123"]);
    expect(entry1.newValue).toEqual(["123", "456"]);
    expect(entry1.timestamp).toBeDefined();
    expect(() => new Date(entry1.timestamp)).not.toThrow();

    const entry2 = JSON.parse(lines[1]);
    expect(entry2.fieldPath).toBe("defaults.model");
  });

  it("appends to existing file", async () => {
    const filePath = join(tmpDir, "audit.jsonl");
    const audit = new AuditTrail({ filePath, log });

    const changes1: readonly ConfigChange[] = [
      { fieldPath: "agents.researcher.channels", oldValue: ["a"], newValue: ["b"], reloadable: true },
    ];
    const changes2: readonly ConfigChange[] = [
      { fieldPath: "defaults.model", oldValue: "sonnet", newValue: "haiku", reloadable: false },
    ];

    await audit.record(changes1);
    await audit.record(changes2);

    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("creates directory if missing", async () => {
    const nestedDir = join(tmpDir, "deep", "nested");
    const filePath = join(nestedDir, "audit.jsonl");
    const audit = new AuditTrail({ filePath, log });

    const changes: readonly ConfigChange[] = [
      { fieldPath: "agents.coder.skills", oldValue: [], newValue: ["search"], reloadable: true },
    ];

    await audit.record(changes);

    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.fieldPath).toBe("agents.coder.skills");
  });

  it("each line is valid JSON with required fields", async () => {
    const filePath = join(tmpDir, "audit.jsonl");
    const audit = new AuditTrail({ filePath, log });

    const changes: readonly ConfigChange[] = [
      { fieldPath: "agents.researcher.model", oldValue: "sonnet", newValue: "opus", reloadable: false },
    ];

    await audit.record(changes);

    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");

    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty("timestamp");
      expect(parsed).toHaveProperty("fieldPath");
      expect(parsed).toHaveProperty("oldValue");
      expect(parsed).toHaveProperty("newValue");
      // timestamp is ISO8601
      expect(new Date(parsed.timestamp).toISOString()).toBe(parsed.timestamp);
    }
  });

  it("handles empty changes array gracefully", async () => {
    const filePath = join(tmpDir, "audit.jsonl");
    const audit = new AuditTrail({ filePath, log });

    await audit.record([]);

    // File should not exist or be empty since no changes were recorded
    try {
      const content = await readFile(filePath, "utf-8");
      expect(content).toBe("");
    } catch {
      // File not created is also acceptable
    }
  });
});
