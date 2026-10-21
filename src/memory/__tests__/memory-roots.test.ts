/**
 * Phase 999.187 — the memory-root resolver is the single rule every memory
 * reader and writer follows. These cases are the prod shapes from the
 * 2026-09-16 staged yaml.
 */
import { describe, it, expect } from "vitest";
import { isWithinDir, resolveMemoryRoots } from "../memory-roots.js";

describe("resolveMemoryRoots", () => {
  it("plain agent: everything under the workspace", () => {
    const r = resolveMemoryRoots({ workspace: "/a/personal" });
    expect(r.tier1Dir).toBe("/a/personal");
    expect(r.memoryMdPath).toBe("/a/personal/MEMORY.md");
    expect(r.userMdPath).toBe("/a/personal/USER.md");
    expect(r.memoryDir).toBe("/a/personal/memory");
    expect(r.legacyMemoryMdPath).toBeNull();
    expect(r.legacyUserMdPath).toBeNull();
  });

  it("memoryPath = <workspace>/memory (client-a-personal): prompt and edit tool agree", () => {
    const r = resolveMemoryRoots({
      workspace: "/a/client-a-personal",
      memoryPath: "/a/client-a-personal/memory",
    });
    // The edit tool wrote here before; the prompt now loads the same file.
    expect(r.memoryMdPath).toBe("/a/client-a-personal/memory/MEMORY.md");
    expect(r.userMdPath).toBe("/a/client-a-personal/memory/USER.md");
    // Daily logs and consolidation already used <memoryPath>/memory.
    expect(r.memoryDir).toBe("/a/client-a-personal/memory/memory");
    expect(r.legacyMemoryMdPath).toBe("/a/client-a-personal/MEMORY.md");
  });

  it("shared workspace + per-agent memoryPath + memoryAutoLoadPath (fin-client)", () => {
    const r = resolveMemoryRoots({
      workspace: "/a/acme",
      memoryPath: "/a/acme/memory/fin-client",
      memoryAutoLoadPath: "/a/acme/memory/fin-client/MEMORY.md",
    });
    expect(r.tier1Dir).toBe("/a/acme/memory/fin-client");
    expect(r.userMdPath).toBe("/a/acme/memory/fin-client/USER.md");
    expect(r.memoryDir).toBe("/a/acme/memory/fin-client/memory");
    expect(r.legacyMemoryMdPath).toBe("/a/acme/MEMORY.md");
  });

  it("memoryAutoLoadPath elsewhere pins the Tier 1 dir to that file's directory", () => {
    const r = resolveMemoryRoots({
      workspace: "/a/voice",
      memoryAutoLoadPath: "/a/personal/MEMORY.md",
    });
    expect(r.tier1Dir).toBe("/a/personal");
    expect(r.userMdPath).toBe("/a/personal/USER.md");
    expect(r.memoryDir).toBe("/a/voice/memory");
  });

  it("empty strings count as unset", () => {
    const r = resolveMemoryRoots({ workspace: "/a/x", memoryPath: "", memoryAutoLoadPath: " " });
    expect(r.tier1Dir).toBe("/a/x");
  });
});

describe("isWithinDir", () => {
  it("matches the root itself and descendants only", () => {
    expect(isWithinDir("/a/ws/memory", "/a/ws/memory")).toBe(true);
    expect(isWithinDir("/a/ws/memory", "/a/ws/memory/fin-x/memory")).toBe(true);
    expect(isWithinDir("/a/ws/memory", "/a/ws/memory2")).toBe(false);
    expect(isWithinDir("/a/ws/memory", "/a/other")).toBe(false);
  });
});
