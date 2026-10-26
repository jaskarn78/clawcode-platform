/**
 * WP3 (2026-10-25): the rescan check's re-mirror pass runs for every agent
 * with a document store (ingest flag on or off), detached from the check,
 * one pass per agent at a time, and only while the ingest queue is idle.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryStore } from "../../../memory/store.js";
import { DocumentStore } from "../../../documents/store.js";
import { chunkWithContext } from "../../../documents/chunk-context.js";
import type { SessionManager } from "../../../manager/session-manager.js";
import type { CheckContext } from "../../types.js";
import autoIngestRescanCheck, {
  lastRemirrorResult,
  runRemirrorForAgent,
  startRemirrorForAgent,
} from "../auto-ingest-rescan.js";
import type { RemirrorEmbed } from "../../../document-ingest/remirror.js";
import { autoIngestQueue } from "../../../manager/auto-ingest-queue.js";
import pino from "pino";

const embed: RemirrorEmbed = async (texts) => ({
  v1: texts.map(() => new Float32Array(384).fill(0.01)),
  v2: texts.map(() => new Int8Array(384).fill(1)),
});

let memory: MemoryStore;
let docs: DocumentStore;

function sm(agentConfig: unknown): SessionManager {
  return {
    getAgentConfig: () => agentConfig,
    getDocumentStore: () => docs,
    getMemoryStore: () => memory,
    getEmbedder: () => ({
      embed: async () => new Float32Array(384).fill(0.01),
      embedV2: async () => new Int8Array(384).fill(1),
    }),
  } as unknown as SessionManager;
}

function mirrorCount(): number {
  return (
    memory.getDatabase().prepare("SELECT COUNT(*) AS n FROM memory_chunks WHERE path LIKE 'document:%'").get() as {
      n: number;
    }
  ).n;
}

beforeEach(() => {
  memory = new MemoryStore(":memory:");
  docs = new DocumentStore(memory.getDatabase());
  const chunks = chunkWithContext("orphan document text without a mirror", { filename: "orphan.txt" });
  docs.ingest("/ws/orphan.txt", chunks, chunks.map(() => new Int8Array(384)));
});
afterEach(() => memory.close());

describe("auto-ingest-rescan re-mirror", () => {
  it("re-mirrors for an agent with the ingest flag off", async () => {
    const manager = sm({ autoIngestAttachments: false, memoryPath: undefined });
    const r = await runRemirrorForAgent("agent-off", manager, embed);
    expect(r).toMatchObject({ missing: 1, remirrored: 1 });
    expect(mirrorCount()).toBe(1);
  });

  it("runs one detached pass per agent at a time and records the result", async () => {
    const manager = sm({ autoIngestAttachments: false });
    const first = startRemirrorForAgent("agent-x", manager, embed);
    expect(first).not.toBeNull();
    expect(startRemirrorForAgent("agent-x", manager, embed)).toBeNull();
    await first;
    expect(lastRemirrorResult("agent-x")).toMatchObject({ remirrored: 1 });
    expect(startRemirrorForAgent("agent-x", manager, embed)).not.toBeNull();
  });

  it("the check starts the pass without waiting and stays healthy for flag-off agents", async () => {
    const manager = sm({ autoIngestAttachments: false });
    const result = await autoIngestRescanCheck.execute({
      agentName: "agent-check",
      sessionManager: manager,
    } as unknown as CheckContext);
    expect(result.status).toBe("healthy");
    // The detached pass finishes shortly after.
    for (let i = 0; i < 100 && mirrorCount() === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(mirrorCount()).toBe(1);
  });

  it("skips when the agent has no open stores", async () => {
    const manager = {
      getDocumentStore: () => undefined,
      getMemoryStore: () => undefined,
    } as unknown as SessionManager;
    expect(await runRemirrorForAgent("none", manager, embed)).toBeNull();
  });
});

describe("auto-ingest-rescan re-mirror embedder choice", () => {
  it("uses the queue's worker embedder when wired, not the inline one", async () => {
    const workerCalls: Array<[number, boolean]> = [];
    autoIngestQueue.init({
      runHandler: async () => undefined,
      logger: pino({ level: "silent" }),
      getDocumentStore: () => undefined,
      listIngestAgents: () => [],
      embedBoth: async (texts, includeV1) => {
        workerCalls.push([texts.length, includeV1]);
        return {
          v1: texts.map(() => new Float32Array(384).fill(0.01)),
          v2: texts.map(() => new Int8Array(384).fill(1)),
        };
      },
    });
    let inlineCalls = 0;
    const manager = {
      getDocumentStore: () => docs,
      getMemoryStore: () => memory,
      getEmbedder: () => {
        inlineCalls++;
        throw new Error("inline embedder must not be used");
      },
    } as unknown as SessionManager;
    const r = await runRemirrorForAgent("agent-worker", manager);
    expect(r).toMatchObject({ remirrored: 1 });
    expect(workerCalls).toEqual([[1, true]]);
    expect(inlineCalls).toBe(0);
  });
});
