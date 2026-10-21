/**
 * Phase 103 Plan 01 OBS-02 — SessionManager compaction counter mirror.
 *
 * Pins the in-memory per-agent compaction counter that backs `/clawcode-status`
 * "🧹 Compactions: N" rendering. The counter is a Map<agent, number> on
 * SessionManager, bumped ONLY on `CompactionManager.compact()` resolve via the
 * canonical `compactForAgent` wrapper. Reject path leaves the counter
 * unchanged (Pitfall 3 — compactions reflect SUCCESSFUL flushes only).
 *
 * In-memory only; resets on daemon restart (Open Q4 — informational counter,
 * not persistence-worthy).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createMockAdapter } from "../session-adapter.js";
import { SessionManager } from "../session-manager.js";
import type { CompactionResult } from "../../memory/compaction.js";

const OK_RESULT: CompactionResult = Object.freeze({
  logPath: "/tmp/log.jsonl",
  memoriesCreated: 3,
  summary: "stub",
});

/**
 * Build a thin SessionManager and inject a stub CompactionManager directly
 * into `memory.compactionManagers` for the named agent. The stub's `compact`
 * method either resolves with OK_RESULT or rejects with the given error.
 *
 * Bypasses real adapter / registry / memory init — we only exercise the
 * compactForAgent wrapper + counter mirror.
 */
async function buildSessionManagerWithStubCompaction(opts: {
  agents: readonly string[];
  rejectFor?: string; // when set, that agent's compact() rejects
}): Promise<{ sm: SessionManager; compactSpies: Map<string, ReturnType<typeof vi.fn>>; cleanup: () => Promise<void> }> {
  const adapter = createMockAdapter();
  const tmpDir = await mkdtemp(join(tmpdir(), "compaction-counter-"));
  const registryPath = join(tmpDir, "registry.json");
  const sm = new SessionManager({ adapter, registryPath });

  const compactSpies = new Map<string, ReturnType<typeof vi.fn>>();
  for (const agent of opts.agents) {
    const compactFn = vi.fn(async (): Promise<CompactionResult> => {
      if (opts.rejectFor === agent) {
        throw new Error("boom");
      }
      return OK_RESULT;
    });
    compactSpies.set(agent, compactFn);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const memory = (sm as any).memory as { compactionManagers: Map<string, unknown> };
    memory.compactionManagers.set(agent, {
      compact: compactFn,
    });
  }

  const cleanup = async (): Promise<void> => {
    await rm(tmpDir, { recursive: true, force: true });
  };

  return { sm, compactSpies, cleanup };
}

describe("SessionManager compaction counter (OBS-02)", () => {
  let cleanup: (() => Promise<void>) | undefined;

  beforeEach(() => {
    cleanup = undefined;
  });

  // Vitest's afterEach inside beforeEach won't auto-fire; we use a tiny
  // helper that swaps cleanup at use-site instead.
  const setup = async (opts: {
    agents: readonly string[];
    rejectFor?: string;
  }): Promise<SessionManager> => {
    const built = await buildSessionManagerWithStubCompaction(opts);
    cleanup = built.cleanup;
    return built.sm;
  };

  afterEach(async () => {
    if (cleanup) await cleanup();
  });

  it("returns 0 before any compaction", async () => {
    const sm = await setup({ agents: ["agent-a"] });
    expect(sm.getCompactionCountForAgent("agent-a")).toBe(0);
  });

  it("increments to 1 after one successful compactForAgent resolve", async () => {
    const sm = await setup({ agents: ["agent-a"] });
    await sm.compactForAgent("agent-a", [], async () => []);
    expect(sm.getCompactionCountForAgent("agent-a")).toBe(1);
  });

  it("increments to 2 after two successful compactions", async () => {
    const sm = await setup({ agents: ["agent-a"] });
    await sm.compactForAgent("agent-a", [], async () => []);
    await sm.compactForAgent("agent-a", [], async () => []);
    expect(sm.getCompactionCountForAgent("agent-a")).toBe(2);
  });

  it("does NOT increment on rejection (Pitfall 3)", async () => {
    const sm = await setup({ agents: ["agent-a"], rejectFor: "agent-a" });
    await expect(sm.compactForAgent("agent-a", [], async () => []))
      .rejects.toThrow("boom");
    expect(sm.getCompactionCountForAgent("agent-a")).toBe(0);
  });

  it("counts are isolated per agent", async () => {
    const sm = await setup({ agents: ["agent-a", "agent-b"] });
    await sm.compactForAgent("agent-a", [], async () => []);
    expect(sm.getCompactionCountForAgent("agent-a")).toBe(1);
    expect(sm.getCompactionCountForAgent("agent-b")).toBe(0);
  });
});

