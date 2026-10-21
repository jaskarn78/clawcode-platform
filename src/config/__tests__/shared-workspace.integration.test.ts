/**
 * Phase 75 Plan 03 — Shared-Workspace Runtime Support (integration).
 *
 * End-to-end verification that the Plan 01 (schema + ResolvedAgentConfig
 * contract) + Plan 02 (runtime consumer wire-up) work against a real
 * temp filesystem. Proves:
 *   - SHARED-02: 2 agents with shared basePath + distinct memoryPath get
 *     isolated memories.db, inbox/, and on-disk files (distinct inodes).
 *   - SHARED-03: 5-agent acme family (fin-client, fin-research,
 *     fin-playground, fin-tax, acme-content-creator) sharing one
 *     workspace maintain full pairwise isolation across memory + inbox.
 *   - Plan 01 conflict guard fires at schema.safeParse AND loadConfig.
 *
 * Design notes:
 *   - Zero-vector Float32Array(384) embeddings — assertions use tag-based
 *     queries, not vector similarity.
 *   - `skipDedup: true` on all inserts — avoids dedup-layer interference.
 *   - Stores closed via mgr.cleanupMemory() before rm(tempDir) to release
 *     SQLite file handles (Linux permits unlink of open files, but cleanup
 *     is good hygiene and matches the session-memory-warmup.test.ts pattern).
 *   - No daemon / chokidar watcher — this is a pure-function integration
 *     test. Chokidar behavior under shared basePath is covered by the
 *     existing inbox-source unit tests.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { loadConfig, resolveAllAgents } from "../loader.js";
import { configSchema } from "../schema.js";
import { AgentMemoryManager } from "../../manager/session-memory.js";
import {
  createMessage,
  writeMessage,
  readMessages,
} from "../../collaboration/inbox.js";
import { ConfigValidationError } from "../../shared/errors.js";

const silentLog = pino({ level: "silent" });
const EMPTY_EMBEDDING = new Float32Array(384);

/** Acme agent names — must match REQUIREMENTS.md line 17 verbatim. */
const FIN_AGENTS = [
  "fin-client",
  "fin-research",
  "fin-playground",
  "fin-tax",
  "acme-content-creator",
] as const;

describe("Phase 75 — Shared-Workspace Runtime Support (integration)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "p75-shared-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("2-agent minimum (SHARED-02)", () => {
    it("resolves two agents sharing basePath with distinct memoryPath", async () => {
      const sharedWs = join(tempDir, "shared-workspace");
      const memA = join(tempDir, "mem-a");
      const memB = join(tempDir, "mem-b");
      const yaml = `version: 1
agents:
  - name: agent-a
    workspace: ${sharedWs}
    memoryPath: ${memA}
    channels: []
  - name: agent-b
    workspace: ${sharedWs}
    memoryPath: ${memB}
    channels: []
`;
      const configPath = join(tempDir, "clawcode.yaml");
      await writeFile(configPath, yaml, "utf-8");
      const config = await loadConfig(configPath);
      const resolved = resolveAllAgents(config);

      expect(resolved).toHaveLength(2);
      expect(resolved[0].workspace).toBe(resolved[1].workspace);
      expect(resolved[0].memoryPath).not.toBe(resolved[1].memoryPath);
      expect(resolved[0].memoryPath).toBe(memA);
      expect(resolved[1].memoryPath).toBe(memB);
    });

    // MemoryStore init runs sqlite-vec extension load + multi-table schema
    // migration + prepared-statement setup; 2 inits can exceed 5s default under
    // parallel test load. 15s is safe for cold-start + full auto-link path.
    it("memories inserted into agent A do not appear in agent B (tag query)", async () => {
      const sharedWs = join(tempDir, "shared-workspace");
      const memA = join(tempDir, "mem-a");
      const memB = join(tempDir, "mem-b");
      const yaml = `version: 1
agents:
  - name: agent-a
    workspace: ${sharedWs}
    memoryPath: ${memA}
    channels: []
  - name: agent-b
    workspace: ${sharedWs}
    memoryPath: ${memB}
    channels: []
`;
      const configPath = join(tempDir, "clawcode.yaml");
      await writeFile(configPath, yaml, "utf-8");
      const config = await loadConfig(configPath);
      const resolved = resolveAllAgents(config);

      const mgr = new AgentMemoryManager(silentLog);
      mgr.initMemory("agent-a", resolved[0]);
      mgr.initMemory("agent-b", resolved[1]);

      try {
        const storeA = mgr.memoryStores.get("agent-a");
        const storeB = mgr.memoryStores.get("agent-b");
        expect(storeA).toBeDefined();
        expect(storeB).toBeDefined();

        storeA!.insert(
          {
            content: "agent-a-only memory",
            source: "manual",
            importance: 1.0,
            tags: ["p75-iso-a"],
            skipDedup: true,
          },
          EMPTY_EMBEDDING,
        );

        // Agent A's store sees it.
        expect(storeA!.findByTag("p75-iso-a")).toHaveLength(1);
        // Agent B's store does NOT.
        expect(storeB!.findByTag("p75-iso-a")).toHaveLength(0);

        // On-disk witness: distinct inodes prove two real files.
        const inoA = (await stat(join(memA, "memory", "memories.db"))).ino;
        const inoB = (await stat(join(memB, "memory", "memories.db"))).ino;
        expect(inoA).not.toBe(inoB);
      } finally {
        mgr.cleanupMemory("agent-a");
        mgr.cleanupMemory("agent-b");
      }
    }, 15_000);

    it("inbox messages for agent A do not land in agent B's inbox", async () => {
      const sharedWs = join(tempDir, "shared-workspace");
      const memA = join(tempDir, "mem-a");
      const memB = join(tempDir, "mem-b");
      const yaml = `version: 1
agents:
  - name: agent-a
    workspace: ${sharedWs}
    memoryPath: ${memA}
    channels: []
  - name: agent-b
    workspace: ${sharedWs}
    memoryPath: ${memB}
    channels: []
`;
      const configPath = join(tempDir, "clawcode.yaml");
      await writeFile(configPath, yaml, "utf-8");
      const config = await loadConfig(configPath);
      const resolved = resolveAllAgents(config);

      const inboxA = join(resolved[0].memoryPath, "inbox");
      const inboxB = join(resolved[1].memoryPath, "inbox");

      await writeMessage(
        inboxA,
        createMessage("external", "agent-a", "hello agent-a"),
      );

      const msgsA = await readMessages(inboxA);
      const msgsB = await readMessages(inboxB);

      expect(msgsA).toHaveLength(1);
      expect(msgsA[0].content).toBe("hello agent-a");
      expect(msgsA[0].to).toBe("agent-a");
      expect(msgsB).toHaveLength(0);
    });
  });

  describe("Acme family — 5-agent shared basePath (SHARED-03)", () => {
    async function buildAcmeConfig(): Promise<{
      readonly sharedWs: string;
      readonly memoryPaths: readonly string[];
      readonly configPath: string;
    }> {
      const sharedWs = join(tempDir, "acme-workspace");
      const memoryPaths = FIN_AGENTS.map((name) =>
        join(tempDir, `mem-${name}`),
      );
      const agentBlocks = FIN_AGENTS.map(
        (name, i) => `  - name: ${name}
    workspace: ${sharedWs}
    memoryPath: ${memoryPaths[i]}
    channels: []`,
      ).join("\n");
      const yaml = `version: 1
agents:
${agentBlocks}
`;
      const configPath = join(tempDir, "clawcode.yaml");
      await writeFile(configPath, yaml, "utf-8");
      return { sharedWs, memoryPaths, configPath };
    }

    it("resolveAllAgents returns 5 agents with 1 shared workspace + 5 distinct memoryPaths", async () => {
      const { configPath, sharedWs, memoryPaths } = await buildAcmeConfig();
      const config = await loadConfig(configPath);
      const resolved = resolveAllAgents(config);

      expect(resolved).toHaveLength(5);
      expect(new Set(resolved.map((r) => r.workspace)).size).toBe(1);
      expect(resolved[0].workspace).toBe(sharedWs);
      expect(new Set(resolved.map((r) => r.memoryPath)).size).toBe(5);

      // Every resolved memoryPath matches the YAML-declared value.
      for (let i = 0; i < FIN_AGENTS.length; i++) {
        expect(resolved[i].name).toBe(FIN_AGENTS[i]);
        expect(resolved[i].memoryPath).toBe(memoryPaths[i]);
      }
    });

    // 5 MemoryStore inits each run the full schema-migration dance (WAL,
    // sqlite-vec load, conversation_turns_fts backfill), plus each insert
    // triggers the eager auto-linker which does KNN queries across the DB.
    // 5000ms is tight under cold-start; bump to 20s for safety.
    it("5 agents maintain full pairwise memory isolation", async () => {
      const { configPath } = await buildAcmeConfig();
      const config = await loadConfig(configPath);
      const resolved = resolveAllAgents(config);

      const mgr = new AgentMemoryManager(silentLog);
      for (let i = 0; i < FIN_AGENTS.length; i++) {
        mgr.initMemory(FIN_AGENTS[i], resolved[i]);
      }

      try {
        // On-disk witness: 5 distinct inodes.
        const inodes = await Promise.all(
          FIN_AGENTS.map((name) =>
            stat(join(tempDir, `mem-${name}`, "memory", "memories.db")).then(
              (s) => s.ino,
            ),
          ),
        );
        expect(new Set(inodes).size).toBe(5);

        // Insert a uniquely-tagged memory into each agent's store.
        for (const name of FIN_AGENTS) {
          const store = mgr.memoryStores.get(name);
          expect(store).toBeDefined();
          store!.insert(
            {
              content: `memory-for-${name}`,
              source: "manual",
              importance: 1.0,
              tags: [`isolation-test-${name}`],
              skipDedup: true,
            },
            EMPTY_EMBEDDING,
          );
        }

        // Pairwise check: every agent sees its own tag, no one else sees any.
        for (const selfName of FIN_AGENTS) {
          const selfStore = mgr.memoryStores.get(selfName)!;
          expect(selfStore.findByTag(`isolation-test-${selfName}`)).toHaveLength(
            1,
          );
          for (const otherName of FIN_AGENTS) {
            if (otherName === selfName) continue;
            const otherStore = mgr.memoryStores.get(otherName)!;
            expect(
              otherStore.findByTag(`isolation-test-${selfName}`),
            ).toHaveLength(0);
          }
        }
      } finally {
        for (const name of FIN_AGENTS) {
          mgr.cleanupMemory(name);
        }
      }
    }, 20_000);

    it("inbox routing: fin-client → fin-research delivers only to fin-research's inbox", async () => {
      const { configPath } = await buildAcmeConfig();
      const config = await loadConfig(configPath);
      const resolved = resolveAllAgents(config);

      const byName = new Map(resolved.map((r) => [r.name, r]));
      const researchInbox = join(
        byName.get("fin-research")!.memoryPath,
        "inbox",
      );

      await writeMessage(
        researchInbox,
        createMessage(
          "fin-client",
          "fin-research",
          "market intel hand-off",
        ),
      );

      // fin-research sees exactly 1 message.
      const researchMsgs = await readMessages(researchInbox);
      expect(researchMsgs).toHaveLength(1);
      expect(researchMsgs[0].from).toBe("fin-client");
      expect(researchMsgs[0].to).toBe("fin-research");
      expect(researchMsgs[0].content).toBe("market intel hand-off");

      // Every other agent's inbox stays empty.
      for (const name of FIN_AGENTS) {
        if (name === "fin-research") continue;
        const otherInbox = join(byName.get(name)!.memoryPath, "inbox");
        const otherMsgs = await readMessages(otherInbox);
        expect(otherMsgs).toHaveLength(0);
      }
    });
  });

  describe("Conflict detection (Plan 01 guard)", () => {
    it("configSchema rejects two agents with identical memoryPath — error names both agents", () => {
      const result = configSchema.safeParse({
        version: 1,
        agents: [
          {
            name: "fin-client",
            memoryPath: "/tmp/shared/memA",
            channels: [],
          },
          {
            name: "fin-research",
            memoryPath: "/tmp/shared/memA",
            channels: [],
          },
        ],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        const text = result.error.issues.map((i) => i.message).join(" | ");
        expect(text).toMatch(/memoryPath conflict/i);
        expect(text).toContain("fin-client");
        expect(text).toContain("fin-research");
      }
    });

    it("loadConfig throws ConfigValidationError on memoryPath conflict in YAML", async () => {
      const yaml = `version: 1
agents:
  - name: fin-client
    memoryPath: /tmp/shared/memA
    channels: []
  - name: fin-research
    memoryPath: /tmp/shared/memA
    channels: []
`;
      const configPath = join(tempDir, "clawcode.yaml");
      await writeFile(configPath, yaml, "utf-8");

      await expect(loadConfig(configPath)).rejects.toThrow(
        ConfigValidationError,
      );

      // And the thrown error surfaces both conflicting agent names.
      try {
        await loadConfig(configPath);
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toMatch(/memoryPath conflict/i);
        expect(msg).toContain("fin-client");
        expect(msg).toContain("fin-research");
      }
    });

    it("5 agents with distinct memoryPath values parse successfully (positive control)", () => {
      const result = configSchema.safeParse({
        version: 1,
        agents: [
          {
            name: "fin-client",
            memoryPath: "/tmp/shared/memA",
            channels: [],
          },
          {
            name: "fin-research",
            memoryPath: "/tmp/shared/memB",
            channels: [],
          },
          {
            name: "fin-playground",
            memoryPath: "/tmp/shared/memC",
            channels: [],
          },
          {
            name: "fin-tax",
            memoryPath: "/tmp/shared/memD",
            channels: [],
          },
          {
            name: "acme-content-creator",
            memoryPath: "/tmp/shared/memE",
            channels: [],
          },
        ],
      });

      expect(result.success).toBe(true);
    });
  });
});
