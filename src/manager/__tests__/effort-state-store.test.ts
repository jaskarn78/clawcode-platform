/**
 * Phase 83 Plan 02 Task 1 — Runtime effort-state persistence tests.
 *
 * Validates the `src/manager/effort-state-store.ts` atomic JSON store
 * that backs EFFORT-03 (runtime effort overrides survive agent restart).
 *
 * Invariants pinned by these tests:
 *   - Round-trip write → read returns the same level
 *   - Missing file → `null` for any agent (not throw)
 *   - Corrupt JSON → `null` + warn (non-fatal)
 *   - Unknown / invalid level → `null` for that agent, others intact
 *   - Two agents can coexist without mutual overwrite
 *   - clearEffortState removes the agent key but leaves siblings
 *   - Atomic temp+rename — writes are visible only after rename
 *   - SessionManager integration: setEffortForAgent persists; startAgent
 *     re-applies the persisted level on boot (EFFORT-03 happy path)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nanoid } from "nanoid";
import {
  readEffortState,
  writeEffortState,
  clearEffortState,
} from "../effort-state-store.js";
import { createMockAdapter, type MockSessionAdapter } from "../session-adapter.js";
import { SessionManager } from "../session-manager.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { BackoffConfig } from "../types.js";

// Mock the warm-path gate so agents transition to "running" without needing
// a real embedder — mirrors the established pattern in session-manager.test.ts.
vi.mock("../warm-path-check.js", async () => {
  const actual = await vi.importActual<typeof import("../warm-path-check.js")>(
    "../warm-path-check.js",
  );
  return {
    ...actual,
    runWarmPathCheck: vi.fn(async () => ({
      ready: true,
      durations_ms: { sqlite: 50, embedder: 80, session: 1, browser: 0 },
      total_ms: 131,
      errors: [],
    })),
  };
});

const TEST_BACKOFF: BackoffConfig = {
  baseMs: 100,
  maxMs: 1000,
  maxRetries: 3,
  stableAfterMs: 500,
};

function makeConfig(
  name: string,
  effort: "low" | "medium" | "high" | "max" = "low",
  workspaceDir?: string,
): ResolvedAgentConfig {
  const ws = workspaceDir ?? "/tmp/test-workspace";
  return {
    name,
    workspace: ws,
    memoryPath: ws,
    channels: [],
    model: "sonnet",
    effort,
    allowedModels: ["haiku", "sonnet", "opus"], // Phase 86 MODEL-01
    greetOnRestart: true, // Phase 89 GREET-07
    greetCoolDownMs: 300_000, // Phase 89 GREET-10
    autoCompactAt: 0.7, // Phase 124 D-06
    memoryAutoLoad: true, // Phase 90 MEM-01
    memoryRetrievalTopK: 5, // Phase 90 MEM-03
    memoryScannerEnabled: true, // Phase 90 MEM-02
    memoryFlushIntervalMs: 900_000, // Phase 90 MEM-04
    memoryCueEmoji: "✅", // Phase 90 MEM-05
    autoIngestAttachments: false, // Phase 999.43 D-09
    ingestionPriority: "medium" as const, // Phase 999.43 D-01 Axis 1
    settingSources: ["project"], // Phase 100 GSD-02
    autoStart: true, // Phase 100 follow-up
    skills: [],
    soul: undefined,
    identity: undefined,
    memory: {
      compactionThreshold: 0.75,
      searchTopK: 10,
      consolidation: { enabled: true, weeklyThreshold: 7, monthlyThreshold: 4, schedule: "0 3 * * *" },
      decay: { halfLifeDays: 30, semanticWeight: 0.7, decayWeight: 0.3 },
      deduplication: { enabled: true, similarityThreshold: 0.85 },
    },
    schedules: [],
    heartbeat: {
      enabled: true,
      intervalSeconds: 60,
      checkTimeoutSeconds: 10,
      contextFill: { warningThreshold: 0.6, criticalThreshold: 0.75 },
    },
    skillsPath: "/tmp/skills",
    admin: false,
    sandbox: { enabled: false, allowRuntimeOp: false },
    subagentModel: undefined,
    threads: { idleTimeoutMinutes: 1440, maxThreadSessions: 10 },
    reactions: false,
    mcpServers: [],
    slashCommands: [],
  };
}

describe("effort-state-store — atomic JSON round-trip (EFFORT-03)", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), `effort-state-${nanoid(6)}-`));
    filePath = join(tmpDir, "effort-state.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writeEffortState → readEffortState round-trips the level", async () => {
    await writeEffortState(filePath, "clawdy", "high");
    const level = await readEffortState(filePath, "clawdy");
    expect(level).toBe("high");
  });

  it("readEffortState returns null for an agent that was never written", async () => {
    await writeEffortState(filePath, "other", "medium");
    const level = await readEffortState(filePath, "does-not-exist");
    expect(level).toBeNull();
  });

  it("readEffortState returns null when the file does not exist", async () => {
    const ghostPath = join(tmpDir, "never-created.json");
    const level = await readEffortState(ghostPath, "clawdy");
    expect(level).toBeNull();
  });

  it("readEffortState returns null (and does not throw) on invalid JSON", async () => {
    await writeFile(filePath, "{this is not json", "utf8");
    const level = await readEffortState(filePath, "clawdy");
    expect(level).toBeNull();
  });

  it("readEffortState returns null for an invalid level, but preserves valid sibling", async () => {
    const raw = {
      version: 1,
      updatedAt: new Date().toISOString(),
      agents: { clawdy: "nonsense", other: "max" },
    };
    await writeFile(filePath, JSON.stringify(raw), "utf8");
    // Quick 260715-j1j review IN-01 — per-entry salvage: the invalid entry
    // returns null (dropped, warn-logged) while the valid SIBLING reads fine
    // DIRECTLY — one bad value no longer rejects the whole record.
    const bad = await readEffortState(filePath, "clawdy");
    expect(bad).toBeNull();
    const good = await readEffortState(filePath, "other");
    expect(good).toBe("max");
  });

  it("IN-01: a write against a file with one invalid sibling keeps the valid entries (no clobber-to-empty)", async () => {
    const raw = {
      version: 1,
      updatedAt: new Date().toISOString(),
      agents: { broken: "not-a-level", healthy: "xhigh" },
    };
    await writeFile(filePath, JSON.stringify(raw), "utf8");
    // Pre-IN-01, readExistingOrEmpty whole-file-rejected → EMPTY → this
    // write dropped "healthy" too. Salvage keeps it.
    await writeEffortState(filePath, "newcomer", "low");
    expect(await readEffortState(filePath, "healthy")).toBe("xhigh");
    expect(await readEffortState(filePath, "newcomer")).toBe("low");
    expect(await readEffortState(filePath, "broken")).toBeNull();
  });

  it("sequential writes to two agents both survive (no mutual overwrite)", async () => {
    await writeEffortState(filePath, "a", "low");
    await writeEffortState(filePath, "b", "max");
    expect(await readEffortState(filePath, "a")).toBe("low");
    expect(await readEffortState(filePath, "b")).toBe("max");
  });

  it("clearEffortState removes the agent key but leaves others", async () => {
    await writeEffortState(filePath, "a", "low");
    await writeEffortState(filePath, "b", "max");
    await clearEffortState(filePath, "a");
    expect(await readEffortState(filePath, "a")).toBeNull();
    expect(await readEffortState(filePath, "b")).toBe("max");
  });

  it("writeEffortState persists all 7 v2.2 effort levels (off, auto, low, medium, high, xhigh, max)", async () => {
    const levels = ["off", "auto", "low", "medium", "high", "xhigh", "max"] as const;
    for (const l of levels) {
      await writeEffortState(filePath, `agent-${l}`, l);
    }
    for (const l of levels) {
      expect(await readEffortState(filePath, `agent-${l}`)).toBe(l);
    }
  });

  it("write is atomic — no lingering .tmp file after success", async () => {
    await writeEffortState(filePath, "clawdy", "high");
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(tmpDir);
    // effect-state.json should exist; no *.tmp siblings
    expect(files).toContain("effort-state.json");
    expect(files.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  });

  it("file shape includes version + updatedAt + agents", async () => {
    await writeEffortState(filePath, "clawdy", "high");
    const raw = JSON.parse(await readFile(filePath, "utf8"));
    expect(raw.version).toBe(1);
    expect(typeof raw.updatedAt).toBe("string");
    expect(raw.agents).toEqual({ clawdy: "high" });
  });

  // Quick 260715-j1j (D13) — ultracode persistence + rollback fail-open.
  it("round-trips 'ultracode' (8th level) through write → read", async () => {
    await writeEffortState(filePath, "clawdy", "ultracode");
    expect(await readEffortState(filePath, "clawdy")).toBe("ultracode");
  });

  it("D13 rollback pin: a persisted 'ultracode' read against the OLD 7-level whole-file schema fails parse (rollback blast radius documented)", async () => {
    // Backward-compat contract: if the deploy is rolled back, the ALREADY-
    // DEPLOYED old binary's bundled store does a WHOLE-FILE parse with a
    // 7-member effortSchema — a persisted "ultracode" for any one agent
    // rejects the entire record and every agent's override resets to its
    // config default (fail direction safe; blast radius documented in the
    // SUMMARY). The per-entry salvage (IN-01, pinned below) only helps code
    // that CARRIES the salvage — it cannot retroactively fix old binaries.
    // Here we reconstruct the pre-260715-j1j whole-file schema EXACTLY as it
    // shipped and prove the rejection actually happens.
    const { z } = await import("zod/v4");
    await writeEffortState(filePath, "clawdy", "ultracode");
    const raw = JSON.parse(await readFile(filePath, "utf8"));
    const oldEffortSchema = z.enum([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "auto",
      "off",
    ]);
    const oldFileSchema = z.object({
      version: z.literal(1),
      updatedAt: z.string(),
      agents: z.record(z.string(), oldEffortSchema),
    });
    const parsed = oldFileSchema.safeParse(raw);
    expect(parsed.success).toBe(false);
    // And the CURRENT store still reads it fine (no self-inflicted damage).
    expect(await readEffortState(filePath, "clawdy")).toBe("ultracode");
  });

  it("D13/IN-01 forward-compat: an UNKNOWN persisted level (future 9th tier) drops only THAT entry — siblings survive", async () => {
    // The salvage direction that DOES work: this code reading a state file
    // written by newer code with a level this effortSchema doesn't know.
    await writeEffortState(filePath, "sibling", "max");
    const raw = JSON.parse(await readFile(filePath, "utf8"));
    raw.agents["future-agent"] = "hyperdrive";
    await writeFile(filePath, JSON.stringify(raw), "utf8");
    expect(await readEffortState(filePath, "future-agent")).toBeNull();
    expect(await readEffortState(filePath, "sibling")).toBe("max");
  });
});

describe("SessionManager ↔ effort-state-store integration (EFFORT-03)", () => {
  // Longer timeout — integration tests do real memory-store init + warm-path
  // gate + stopAll cleanup. 15s accommodates concurrent vitest pressure.
  const INTEGRATION_TIMEOUT_MS = 15_000;
  let tmpDir: string;
  let registryPath: string;
  let effortStatePath: string;
  let adapter: MockSessionAdapter;
  let manager: SessionManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), `sm-effort-${nanoid(6)}-`));
    registryPath = join(tmpDir, "registry.json");
    effortStatePath = join(tmpDir, "effort-state.json");
    adapter = createMockAdapter();
    manager = new SessionManager({
      adapter,
      registryPath,
      backoffConfig: TEST_BACKOFF,
      effortStatePath,
    });
  });

  afterEach(async () => {
    try { await manager.stopAll(); } catch { /* best-effort */ }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it(
    "setEffortForAgent writes to effort-state.json",
    async () => {
      const cfg = makeConfig("clawdy", "low", tmpDir);
      await manager.startAgent("clawdy", cfg);
      manager.setEffortForAgent("clawdy", "max");
      // Fire-and-forget persistence — poll the file for up to ~500ms because
      // writeEffortState does mkdir → writeFile(tmp) → rename which can take a
      // couple event-loop turns.
      let persisted: string | null = null;
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 10));
        persisted = await readEffortState(effortStatePath, "clawdy");
        if (persisted) break;
      }
      expect(persisted).toBe("max");
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "startAgent re-applies persisted effort on boot (persistence beats config default)",
    async () => {
      // Seed the state file with a different level than the config default.
      await writeEffortState(effortStatePath, "clawdy", "max");
      const cfg = makeConfig("clawdy", "low", tmpDir);
      await manager.startAgent("clawdy", cfg);
      // After start, getEffortForAgent should report the persisted level,
      // not the "low" config default.
      expect(manager.getEffortForAgent("clawdy")).toBe("max");
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "startAgent does not crash when effort-state.json is corrupt",
    async () => {
      await writeFile(effortStatePath, "{corrupt", "utf8");
      const cfg = makeConfig("clawdy", "low", tmpDir);
      await expect(manager.startAgent("clawdy", cfg)).resolves.not.toThrow();
      // Fallback: config default survives the corrupt file.
      expect(manager.getEffortForAgent("clawdy")).toBe("low");
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "startAgent does not re-apply when no persisted state exists",
    async () => {
      const cfg = makeConfig("clawdy", "low", tmpDir);
      await manager.startAgent("clawdy", cfg);
      expect(manager.getEffortForAgent("clawdy")).toBe("low");
    },
    INTEGRATION_TIMEOUT_MS,
  );

  // Phase 999.92 follow-up — re-apply MUST happen AFTER warm-path-ready.
  // The Phase 83 EFFORT-03 original placement was pre-warm, which on
  // slow SDK-CLI cold starts produced a benign-but-confusing
  // `[effort] setMaxThinkingTokens(...) failed: Claude Code process
  // exited with code 1` log line (mistakenly attributed to a real
  // crash during 999.92 diagnosis). The ordering invariant: every
  // setEffort invocation triggered by the EFFORT-03 re-apply path
  // observes the agent already in `status: "running"` (which warm-path-
  // ready writes).
  it(
    "startAgent re-applies persisted effort AFTER warm-path-ready (999.92 race fix)",
    async () => {
      await writeEffortState(effortStatePath, "clawdy", "max");
      const cfg = makeConfig("clawdy", "low", tmpDir);

      // Capture each setEffort call alongside the agent's registry
      // status AT THE MOMENT OF the call. Pre-fix, status would be
      // "starting"; post-fix, "running".
      const observedStatusAtEffortCall: string[] = [];
      const originalCreate = adapter.createSession.bind(adapter);
      adapter.createSession = (async (
        cfgArg: Parameters<typeof originalCreate>[0],
      ) => {
        const handle = await originalCreate(cfgArg);
        const originalSetEffort = handle.setEffort.bind(handle);
        handle.setEffort = ((level: Parameters<typeof originalSetEffort>[0]) => {
          // Synchronous registry-state probe at call-time.
          try {
            const { readFileSync } = require("node:fs");
            const reg = JSON.parse(readFileSync(registryPath, "utf8"));
            const entry = reg.entries.find(
              (e: { name: string; status: string }) => e.name === cfgArg.name,
            );
            observedStatusAtEffortCall.push(entry?.status ?? "(no-entry)");
          } catch {
            observedStatusAtEffortCall.push("(registry-unreadable)");
          }
          return originalSetEffort(level);
        }) as typeof originalSetEffort;
        return handle;
      }) as typeof originalCreate;

      await manager.startAgent("clawdy", cfg);

      // At least one setEffort call (the EFFORT-03 re-apply); every
      // observed status must be "running" (post-warm-path-ready).
      expect(observedStatusAtEffortCall.length).toBeGreaterThan(0);
      for (const status of observedStatusAtEffortCall) {
        expect(status).toBe("running");
      }
      // Behavior preserved: persisted level still wins.
      expect(manager.getEffortForAgent("clawdy")).toBe("max");
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
