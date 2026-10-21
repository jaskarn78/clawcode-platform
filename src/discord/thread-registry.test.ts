import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  readThreadRegistry,
  writeThreadRegistry,
  addBinding,
  removeBinding,
  updateActivity,
  getBindingForThread,
  getBindingForSession,
  getBindingsForAgent,
  EMPTY_THREAD_REGISTRY,
} from "./thread-registry.js";
import type { ThreadBinding, ThreadBindingRegistry } from "./thread-types.js";

const makeBinding = (overrides: Partial<ThreadBinding> = {}): ThreadBinding => ({
  threadId: "thread-1",
  parentChannelId: "channel-1",
  agentName: "agent-a",
  sessionName: "agent-a-thread-thread-1",
  createdAt: 1000,
  lastActivity: 1000,
  ...overrides,
});

describe("thread-registry", () => {
  let tmpDir: string;
  let registryPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "thread-reg-"));
    registryPath = join(tmpDir, "thread-bindings.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("EMPTY_THREAD_REGISTRY", () => {
    it("has empty bindings and zero updatedAt", () => {
      expect(EMPTY_THREAD_REGISTRY.bindings).toEqual([]);
      expect(EMPTY_THREAD_REGISTRY.updatedAt).toBe(0);
    });
  });

  describe("readThreadRegistry", () => {
    it("returns EMPTY_THREAD_REGISTRY when file does not exist", async () => {
      const result = await readThreadRegistry(registryPath);
      expect(result).toEqual(EMPTY_THREAD_REGISTRY);
    });

    it("throws on corrupt JSON", async () => {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(registryPath, "not valid json", "utf-8");
      await expect(readThreadRegistry(registryPath)).rejects.toThrow(
        /Corrupt thread registry/,
      );
    });

    it("reads valid registry file", async () => {
      const registry: ThreadBindingRegistry = {
        bindings: [makeBinding()],
        updatedAt: 2000,
      };
      const { writeFile } = await import("node:fs/promises");
      await writeFile(registryPath, JSON.stringify(registry), "utf-8");

      const result = await readThreadRegistry(registryPath);
      expect(result.bindings).toHaveLength(1);
      expect(result.bindings[0].threadId).toBe("thread-1");
    });
  });

  describe("writeThreadRegistry", () => {
    it("writes JSON atomically with tmp+rename pattern", async () => {
      const registry: ThreadBindingRegistry = {
        bindings: [makeBinding()],
        updatedAt: 3000,
      };
      await writeThreadRegistry(registryPath, registry);

      const raw = await readFile(registryPath, "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.bindings).toHaveLength(1);
      expect(parsed.updatedAt).toBe(3000);
    });

    it("creates parent directories if they do not exist", async () => {
      const deepPath = join(tmpDir, "nested", "dir", "registry.json");
      const registry: ThreadBindingRegistry = {
        bindings: [],
        updatedAt: 0,
      };
      await writeThreadRegistry(deepPath, registry);

      const raw = await readFile(deepPath, "utf-8");
      expect(JSON.parse(raw)).toEqual(registry);
    });
  });

  describe("addBinding", () => {
    it("adds a new binding to an empty registry", () => {
      const binding = makeBinding();
      const result = addBinding(EMPTY_THREAD_REGISTRY, binding);

      expect(result.bindings).toHaveLength(1);
      expect(result.bindings[0]).toEqual(binding);
      expect(result.updatedAt).toBeGreaterThan(0);
    });

    it("throws if threadId already exists", () => {
      const binding = makeBinding();
      const registry = addBinding(EMPTY_THREAD_REGISTRY, binding);

      expect(() => addBinding(registry, binding)).toThrow(
        /already exists/,
      );
    });

    it("does not mutate the original registry", () => {
      const binding = makeBinding();
      const original = EMPTY_THREAD_REGISTRY;
      addBinding(original, binding);

      expect(original.bindings).toHaveLength(0);
    });
  });

  describe("removeBinding", () => {
    it("removes a binding by threadId", () => {
      const binding = makeBinding();
      const registry = addBinding(EMPTY_THREAD_REGISTRY, binding);
      const result = removeBinding(registry, "thread-1");

      expect(result.bindings).toHaveLength(0);
    });

    it("returns unchanged registry if threadId not found", () => {
      const binding = makeBinding();
      const registry = addBinding(EMPTY_THREAD_REGISTRY, binding);
      const result = removeBinding(registry, "nonexistent");

      expect(result.bindings).toHaveLength(1);
      expect(result.bindings[0].threadId).toBe("thread-1");
    });

    it("does not mutate the original registry", () => {
      const binding = makeBinding();
      const registry = addBinding(EMPTY_THREAD_REGISTRY, binding);
      removeBinding(registry, "thread-1");

      expect(registry.bindings).toHaveLength(1);
    });
  });

  describe("updateActivity", () => {
    it("updates lastActivity timestamp for a threadId", () => {
      const binding = makeBinding({ lastActivity: 1000 });
      const registry = addBinding(EMPTY_THREAD_REGISTRY, binding);
      const result = updateActivity(registry, "thread-1", 5000);

      expect(result.bindings[0].lastActivity).toBe(5000);
    });

    it("returns unchanged registry if threadId not found", () => {
      const binding = makeBinding({ lastActivity: 1000 });
      const registry = addBinding(EMPTY_THREAD_REGISTRY, binding);
      const result = updateActivity(registry, "nonexistent", 5000);

      expect(result.bindings[0].lastActivity).toBe(1000);
    });

    it("does not mutate the original registry", () => {
      const binding = makeBinding({ lastActivity: 1000 });
      const registry = addBinding(EMPTY_THREAD_REGISTRY, binding);
      updateActivity(registry, "thread-1", 5000);

      expect(registry.bindings[0].lastActivity).toBe(1000);
    });
  });

  describe("getBindingForThread", () => {
    it("returns binding for a threadId", () => {
      const binding = makeBinding();
      const registry = addBinding(EMPTY_THREAD_REGISTRY, binding);
      const result = getBindingForThread(registry, "thread-1");

      expect(result).toEqual(binding);
    });

    it("returns undefined if threadId not found", () => {
      const result = getBindingForThread(EMPTY_THREAD_REGISTRY, "thread-1");
      expect(result).toBeUndefined();
    });
  });

  describe("getBindingsForAgent", () => {
    it("returns all bindings for a given agentName", () => {
      const b1 = makeBinding({ threadId: "t1", agentName: "agent-a" });
      const b2 = makeBinding({ threadId: "t2", agentName: "agent-b" });
      const b3 = makeBinding({ threadId: "t3", agentName: "agent-a" });

      let registry = addBinding(EMPTY_THREAD_REGISTRY, b1);
      registry = addBinding(registry, b2);
      registry = addBinding(registry, b3);

      const result = getBindingsForAgent(registry, "agent-a");
      expect(result).toHaveLength(2);
      expect(result.every((b) => b.agentName === "agent-a")).toBe(true);
    });

    it("returns empty array if no bindings for agent", () => {
      const result = getBindingsForAgent(EMPTY_THREAD_REGISTRY, "agent-a");
      expect(result).toEqual([]);
    });
  });

  // Phase 999.36 sub-bug C (D-09, D-10) — sessionName lookup for the
  // share-file routing fix. The subagent's sessionName (e.g.
  // `fin-client-sub-OV9rkf`) is the LLM-supplied identity in
  // clawcode_share_file invocations from a subagent context. This helper
  // disambiguates correctly when two bindings share an agentName but have
  // distinct sessionNames.
  describe("getBindingForSession", () => {
    it("returns the binding when a binding with matching sessionName exists", () => {
      const binding = makeBinding({
        threadId: "t1",
        agentName: "fin-client",
        sessionName: "fin-client-sub-OV9rkf",
      });
      const registry = addBinding(EMPTY_THREAD_REGISTRY, binding);

      const result = getBindingForSession(registry, "fin-client-sub-OV9rkf");
      expect(result).toEqual(binding);
    });

    it("returns undefined when no binding has the given sessionName", () => {
      const binding = makeBinding({
        threadId: "t1",
        agentName: "fin-client",
        sessionName: "fin-client-sub-OV9rkf",
      });
      const registry = addBinding(EMPTY_THREAD_REGISTRY, binding);

      const result = getBindingForSession(registry, "fin-client-sub-other");
      expect(result).toBeUndefined();
    });

    it("returns undefined for empty registry", () => {
      const result = getBindingForSession(EMPTY_THREAD_REGISTRY, "any-session");
      expect(result).toBeUndefined();
    });

    it("disambiguates two bindings with same agentName but different sessionName", () => {
      // Pinned the exact failure class: in shared-workspace agent pairs
      // the subagent's sessionName is the unique identity, NOT agentName.
      // Returning the wrong binding here would route the file to the
      // wrong thread.
      const b1 = makeBinding({
        threadId: "t1",
        agentName: "fin-client",
        sessionName: "fin-client-sub-OV9rkf",
      });
      const b2 = makeBinding({
        threadId: "t2",
        agentName: "fin-client", // same agentName
        sessionName: "fin-client-sub-different",
      });
      let registry = addBinding(EMPTY_THREAD_REGISTRY, b1);
      registry = addBinding(registry, b2);

      const result1 = getBindingForSession(
        registry,
        "fin-client-sub-OV9rkf",
      );
      expect(result1?.threadId).toBe("t1");

      const result2 = getBindingForSession(
        registry,
        "fin-client-sub-different",
      );
      expect(result2?.threadId).toBe("t2");
    });
  });
});
