import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBootstrapResults, markBootstrapComplete } from "../writer.js";
import { buildBootstrapPrompt } from "../prompt-builder.js";
import { BOOTSTRAP_FLAG_FILE } from "../types.js";
import type { BootstrapResult, BootstrapConfig } from "../types.js";

describe("writeBootstrapResults", () => {
  const tempDirs: string[] = [];

  async function makeTempWorkspace(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "bootstrap-writer-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("writes SOUL.md and IDENTITY.md with correct content", async () => {
    const workspace = await makeTempWorkspace();
    const result: BootstrapResult = {
      soulContent: "# My Soul\nI am creative and bold.",
      identityContent: "# Identity\n- Name: TestBot",
      agentName: "test-bot",
    };

    await writeBootstrapResults(result, workspace);

    const soul = await readFile(join(workspace, "SOUL.md"), "utf-8");
    const identity = await readFile(join(workspace, "IDENTITY.md"), "utf-8");

    expect(soul).toBe(result.soulContent);
    expect(identity).toBe(result.identityContent);
  });

  it("skips writing when .bootstrap-complete already exists", async () => {
    const workspace = await makeTempWorkspace();
    await writeFile(join(workspace, BOOTSTRAP_FLAG_FILE), "already done", "utf-8");
    await writeFile(join(workspace, "SOUL.md"), "original soul", "utf-8");

    const result: BootstrapResult = {
      soulContent: "# New Soul",
      identityContent: "# New Identity",
      agentName: "test-bot",
    };

    await writeBootstrapResults(result, workspace);

    // Original file should be unchanged
    const soul = await readFile(join(workspace, "SOUL.md"), "utf-8");
    expect(soul).toBe("original soul");
  });
});

describe("markBootstrapComplete", () => {
  const tempDirs: string[] = [];

  async function makeTempWorkspace(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "bootstrap-mark-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("creates flag file with ISO timestamp", async () => {
    const workspace = await makeTempWorkspace();

    await markBootstrapComplete(workspace);

    const content = await readFile(join(workspace, BOOTSTRAP_FLAG_FILE), "utf-8");
    // Should be a valid ISO date string
    expect(new Date(content.trim()).toISOString()).toBe(content.trim());
  });
});

describe("buildBootstrapPrompt", () => {
  it("includes agent name in the prompt", () => {
    const config: BootstrapConfig = {
      workspace: "/tmp/test",
      agentName: "creative-bot",
      channels: ["#art", "#design"],
    };

    const prompt = buildBootstrapPrompt(config);

    expect(prompt).toContain("creative-bot");
  });

  it("includes channel names in the prompt", () => {
    const config: BootstrapConfig = {
      workspace: "/tmp/test",
      agentName: "helper",
      channels: ["#general", "#support"],
    };

    const prompt = buildBootstrapPrompt(config);

    expect(prompt).toContain("#general");
    expect(prompt).toContain("#support");
  });

  it("includes SOUL.md and IDENTITY.md instructions", () => {
    const config: BootstrapConfig = {
      workspace: "/tmp/test",
      agentName: "bot",
      channels: ["#test"],
    };

    const prompt = buildBootstrapPrompt(config);

    expect(prompt).toContain("SOUL.md");
    expect(prompt).toContain("IDENTITY.md");
  });

  it("includes guidance for distinctive personality", () => {
    const config: BootstrapConfig = {
      workspace: "/tmp/test",
      agentName: "bot",
      channels: ["#test"],
    };

    const prompt = buildBootstrapPrompt(config);

    expect(prompt.toLowerCase()).toContain("personality");
  });
});
