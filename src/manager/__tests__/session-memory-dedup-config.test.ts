/**
 * Memory overhaul 2026-10-25 (WP5) - the agent's resolved
 * `memory.deduplication` reaches the MemoryStore built by
 * AgentMemoryManager.initMemory. Before, the store was constructed with no
 * config, so the YAML knob silently did nothing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { AgentMemoryManager } from "../session-memory.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";

const silentLog = pino({ level: "silent" });

function axis(i: number): Float32Array {
  const v = new Float32Array(384);
  v[i] = 1;
  return v;
}

/** Unit vector at cosine `c` to axis(0). */
function nearAxis0(c: number): Float32Array {
  const v = new Float32Array(384);
  v[0] = c;
  v[1] = Math.sqrt(1 - c * c);
  return v;
}

function makeConfig(
  workspace: string,
  name: string,
  deduplication?: { enabled: boolean; similarityThreshold: number },
): ResolvedAgentConfig {
  return {
    name,
    model: "sonnet",
    effort: "medium",
    workspace,
    memoryPath: workspace,
    systemPrompt: "",
    channels: [],
    memory: {
      compactionThreshold: 0.8,
      ...(deduplication ? { deduplication } : {}),
    },
  } as unknown as ResolvedAgentConfig;
}

describe("AgentMemoryManager.initMemory wires memory.deduplication", () => {
  let tmp: string;
  let mgr: AgentMemoryManager;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "wp5-dedup-config-"));
    mgr = new AgentMemoryManager(silentLog);
  });

  afterEach(async () => {
    for (const name of Array.from(mgr.memoryStores.keys())) {
      mgr.cleanupMemory(name);
    }
    await rm(tmp, { recursive: true, force: true });
  });

  it("enabled: false stores two rows for a duplicate embedding", () => {
    mgr.initMemory("off", makeConfig(join(tmp, "off"), "off", { enabled: false, similarityThreshold: 0.85 }));
    const store = mgr.memoryStores.get("off")!;
    store.insert({ content: "same fact", source: "manual" }, axis(0));
    const second = store.insertWithStatus({ content: "same fact", source: "manual" }, axis(0));
    expect(second.status).toBe("created");
    expect(store.listRecent(10)).toHaveLength(2);
  });

  it("the configured threshold decides the supersede band", () => {
    // 0.80 cosine: below the 0.85 default, inside a 0.75 threshold.
    mgr.initMemory("loose", makeConfig(join(tmp, "loose"), "loose", { enabled: true, similarityThreshold: 0.75 }));
    const loose = mgr.memoryStores.get("loose")!;
    loose.insert({ content: "v1", source: "manual" }, axis(0));
    expect(loose.insertWithStatus({ content: "v2", source: "manual" }, nearAxis0(0.8)).status).toBe("superseded");

    mgr.initMemory("default", makeConfig(join(tmp, "default"), "default"));
    const dflt = mgr.memoryStores.get("default")!;
    dflt.insert({ content: "v1", source: "manual" }, axis(0));
    expect(dflt.insertWithStatus({ content: "v2", source: "manual" }, nearAxis0(0.8)).status).toBe("created");
  });
});
