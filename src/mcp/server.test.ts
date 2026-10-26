import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { TOOL_DEFINITIONS, invokeWithCache } from "./server.js";
import { TraceCollector, type Turn } from "../performance/trace-collector.js";
import type { TraceStore } from "../performance/trace-store.js";

describe("TOOL_DEFINITIONS", () => {
  it("defines agent_status tool", () => {
    expect(TOOL_DEFINITIONS.agent_status).toBeDefined();
    expect(TOOL_DEFINITIONS.agent_status.description).toContain("status");
    expect(TOOL_DEFINITIONS.agent_status.ipcMethod).toBe("status");
  });

  it("defines send_message tool", () => {
    expect(TOOL_DEFINITIONS.send_message).toBeDefined();
    expect(TOOL_DEFINITIONS.send_message.description).toContain("message");
    expect(TOOL_DEFINITIONS.send_message.ipcMethod).toBe("send-message");
  });

  it("defines list_schedules tool", () => {
    expect(TOOL_DEFINITIONS.list_schedules).toBeDefined();
    expect(TOOL_DEFINITIONS.list_schedules.description).toContain("scheduled");
    expect(TOOL_DEFINITIONS.list_schedules.ipcMethod).toBe("schedules");
  });

  it("defines list_webhooks tool", () => {
    expect(TOOL_DEFINITIONS.list_webhooks).toBeDefined();
    expect(TOOL_DEFINITIONS.list_webhooks.description).toContain("webhook");
    expect(TOOL_DEFINITIONS.list_webhooks.ipcMethod).toBe("webhooks");
  });

  it("defines list_agents tool", () => {
    expect(TOOL_DEFINITIONS.list_agents).toBeDefined();
    expect(TOOL_DEFINITIONS.list_agents.ipcMethod).toBe("status");
  });

  it("has exactly 39 tools defined", () => {
    // Count guard — bump deliberately when adding/removing a TOOL_DEFINITIONS
    // entry.
    // 32 = 30 existing + 2 (schedule_recurring, cancel_schedule) — Phase 999.99
    // 33 = +1 ask_user_question — Phase 145 WS3 (Plan 04 added the entry but
    //      left this guard stale-red at 32)
    // 34 = +1 start_workflow — Phase 145 WS2 (Plan 05)
    // 36 = +1 trainingpeaks_connect_link — 999.142 (removed again in the public build)
    // 38 = +2 workflow_status, cancel_workflow — 999.165
    // 40 = +2 steer_workflow, edit_workflow — 999.165 slice 3
    // 39 = -1 trainingpeaks_connect_link (public build has no training subsystem)
    // 41 = +2 clawcode_memory_forget, clawcode_memory_update (memory overhaul WP5)
    expect(Object.keys(TOOL_DEFINITIONS).length).toBe(41);
  });

  it("defines clawcode_memory_forget + clawcode_memory_update tools (memory overhaul WP5)", () => {
    expect(TOOL_DEFINITIONS.clawcode_memory_forget.ipcMethod).toBe("clawcode-memory-forget");
    expect(TOOL_DEFINITIONS.clawcode_memory_forget.description).toContain("forgotten");
    expect(TOOL_DEFINITIONS.clawcode_memory_update.ipcMethod).toBe("clawcode-memory-update");
    expect(TOOL_DEFINITIONS.clawcode_memory_update.description).toContain("superseded");
  });

  it("defines schedule_recurring tool", () => {
    expect(TOOL_DEFINITIONS.schedule_recurring).toBeDefined();
    expect(TOOL_DEFINITIONS.schedule_recurring.description).toContain("recurring");
    expect(TOOL_DEFINITIONS.schedule_recurring.ipcMethod).toBe("schedule-recurring");
  });

  it("defines workflow_status + cancel_workflow tools (999.165)", () => {
    expect(TOOL_DEFINITIONS.workflow_status.ipcMethod).toBe("workflow-status");
    expect(TOOL_DEFINITIONS.cancel_workflow.ipcMethod).toBe("cancel-workflow");
    expect(TOOL_DEFINITIONS.steer_workflow.ipcMethod).toBe("steer-workflow");
    expect(TOOL_DEFINITIONS.edit_workflow.ipcMethod).toBe("edit-workflow");
  });

  it("defines start_workflow tool", () => {
    expect(TOOL_DEFINITIONS.start_workflow).toBeDefined();
    expect(TOOL_DEFINITIONS.start_workflow.description).toContain("workflow");
    expect(TOOL_DEFINITIONS.start_workflow.ipcMethod).toBe("start-workflow");
  });

  it("defines cancel_schedule tool", () => {
    expect(TOOL_DEFINITIONS.cancel_schedule).toBeDefined();
    expect(TOOL_DEFINITIONS.cancel_schedule.description).toContain("recurring");
    expect(TOOL_DEFINITIONS.cancel_schedule.ipcMethod).toBe("cancel-schedule");
  });

  it("defines archive_thread tool", () => {
    expect(TOOL_DEFINITIONS.archive_thread).toBeDefined();
    expect(TOOL_DEFINITIONS.archive_thread.description).toContain("Archive");
    expect(TOOL_DEFINITIONS.archive_thread.ipcMethod).toBe("archive-discord-thread");
  });

  it("defines schedule_reminder tool", () => {
    expect(TOOL_DEFINITIONS.schedule_reminder).toBeDefined();
    expect(TOOL_DEFINITIONS.schedule_reminder.description).toContain("reminder");
    expect(TOOL_DEFINITIONS.schedule_reminder.ipcMethod).toBe("schedule-reminder");
  });

  it("defines ask_advisor tool", () => {
    expect(TOOL_DEFINITIONS.ask_advisor).toBeDefined();
    expect(TOOL_DEFINITIONS.ask_advisor.description).toContain("advice");
    expect(TOOL_DEFINITIONS.ask_advisor.ipcMethod).toBe("ask-advisor");
  });

  it("defines spawn_subagent_thread tool", () => {
    expect(TOOL_DEFINITIONS.spawn_subagent_thread).toBeDefined();
    expect(TOOL_DEFINITIONS.spawn_subagent_thread.description).toContain("subagent");
    expect(TOOL_DEFINITIONS.spawn_subagent_thread.ipcMethod).toBe("spawn-subagent-thread");
  });

  // Phase 59 handoff tools
  it("defines delegate_task tool with delegate-task IPC method", () => {
    expect(TOOL_DEFINITIONS.delegate_task).toBeDefined();
    expect(TOOL_DEFINITIONS.delegate_task.ipcMethod).toBe("delegate-task");
  });

  it("defines task_status tool with task-status IPC method", () => {
    expect(TOOL_DEFINITIONS.task_status).toBeDefined();
    expect(TOOL_DEFINITIONS.task_status.ipcMethod).toBe("task-status");
  });

  it("defines cancel_task tool with cancel-task IPC method", () => {
    expect(TOOL_DEFINITIONS.cancel_task).toBeDefined();
    expect(TOOL_DEFINITIONS.cancel_task.ipcMethod).toBe("cancel-task");
  });

  it("defines task_complete tool with task-complete IPC method", () => {
    expect(TOOL_DEFINITIONS.task_complete).toBeDefined();
    expect(TOOL_DEFINITIONS.task_complete.ipcMethod).toBe("task-complete");
  });
});

// ---------------------------------------------------------------------------
// Phase 55 Plan 02 — invokeWithCache behaviour (tool cache + bypass + stability)
// ---------------------------------------------------------------------------

function createMockStore(): TraceStore {
  return {
    writeTurn: vi.fn(),
    pruneOlderThan: vi.fn().mockReturnValue(0),
    close: vi.fn(),
    getPercentiles: vi.fn().mockReturnValue([]),
  } as unknown as TraceStore;
}

function createMockLogger(): any {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function makeTurn(): Turn {
  const collector = new TraceCollector(createMockStore(), createMockLogger());
  return collector.startTurn("msg-cache-1", "alpha", null);
}

describe("invokeWithCache (Phase 55)", () => {
  it("Test 1: first memory_lookup populates cache; second identical call hits cache (<=5ms)", async () => {
    const turn = makeTurn();
    const raw = vi.fn().mockResolvedValue({ results: ["real"] });
    const deps = {
      getActiveTurn: () => turn,
      getAgentPerfTools: () => ({
        maxConcurrent: 10,
        idempotent: ["memory_lookup", "search_documents", "memory_list", "memory_graph"],
      }),
    };

    // First call — miss
    const r1 = await invokeWithCache("memory_lookup", "alpha", { q: "foo" }, raw, deps);
    expect(r1).toEqual({ results: ["real"] });
    expect(raw).toHaveBeenCalledTimes(1);

    // Second call — hit, no second raw invocation
    const startHit = Date.now();
    const r2 = await invokeWithCache("memory_lookup", "alpha", { q: "foo" }, raw, deps);
    const hitElapsed = Date.now() - startHit;
    expect(raw).toHaveBeenCalledTimes(1); // no second raw call
    expect(r2).toEqual({ results: ["real"] });
    expect(hitElapsed).toBeLessThanOrEqual(5);
    expect(turn.toolCache.hitCount()).toBe(1);
  });

  it("Test 2: different args = different cache entries, no spurious hit", async () => {
    const turn = makeTurn();
    const raw = vi
      .fn()
      .mockResolvedValueOnce({ q: "foo" })
      .mockResolvedValueOnce({ q: "bar" });
    const deps = {
      getActiveTurn: () => turn,
      getAgentPerfTools: () => ({
        maxConcurrent: 10,
        idempotent: ["memory_lookup"],
      }),
    };

    await invokeWithCache("memory_lookup", "alpha", { q: "foo" }, raw, deps);
    await invokeWithCache("memory_lookup", "alpha", { q: "bar" }, raw, deps);
    expect(raw).toHaveBeenCalledTimes(2);
    expect(turn.toolCache.hitCount()).toBe(0);
  });

  it("Test 3: non-idempotent tool (memory_save) NEVER hits cache even with identical args", async () => {
    const turn = makeTurn();
    const raw = vi.fn().mockResolvedValue({ id: "mem-1" });
    const deps = {
      getActiveTurn: () => turn,
      getAgentPerfTools: () => ({
        maxConcurrent: 10,
        idempotent: ["memory_lookup", "search_documents"], // memory_save NOT whitelisted
      }),
    };

    await invokeWithCache("memory_save", "alpha", { content: "x" }, raw, deps);
    await invokeWithCache("memory_save", "alpha", { content: "x" }, raw, deps);
    await invokeWithCache("memory_save", "alpha", { content: "x" }, raw, deps);
    expect(raw).toHaveBeenCalledTimes(3);
    expect(turn.toolCache.hitCount()).toBe(0);
  });

  it("Test 4: arg-order stability — {q:'x',limit:5} and {limit:5,q:'x'} share a cache entry", async () => {
    const turn = makeTurn();
    const raw = vi.fn().mockResolvedValue({ results: ["stable"] });
    const deps = {
      getActiveTurn: () => turn,
      getAgentPerfTools: () => ({
        maxConcurrent: 10,
        idempotent: ["memory_lookup"],
      }),
    };

    await invokeWithCache("memory_lookup", "alpha", { q: "x", limit: 5 }, raw, deps);
    await invokeWithCache("memory_lookup", "alpha", { limit: 5, q: "x" }, raw, deps);
    expect(raw).toHaveBeenCalledTimes(1); // second call is a cache hit
    expect(turn.toolCache.hitCount()).toBe(1);
  });

  it("Test 5: config-driven whitelist — test-only override makes memory_save cacheable", async () => {
    const turn = makeTurn();
    const raw = vi.fn().mockResolvedValue({ id: "mem-1" });
    const deps = {
      getActiveTurn: () => turn,
      getAgentPerfTools: () => ({
        maxConcurrent: 10,
        idempotent: ["memory_save"], // adversarial — shows whitelist is config-driven
      }),
    };

    await invokeWithCache("memory_save", "alpha", { content: "x" }, raw, deps);
    await invokeWithCache("memory_save", "alpha", { content: "x" }, raw, deps);
    expect(raw).toHaveBeenCalledTimes(1);
    expect(turn.toolCache.hitCount()).toBe(1);
  });

  it("bypasses cache when no turn available (getActiveTurn returns null)", async () => {
    const raw = vi.fn().mockResolvedValue({ r: "ok" });
    const deps = {
      getActiveTurn: () => null,
      getAgentPerfTools: () => ({
        maxConcurrent: 10,
        idempotent: ["memory_lookup"],
      }),
    };
    await invokeWithCache("memory_lookup", "alpha", { q: "x" }, raw, deps);
    await invokeWithCache("memory_lookup", "alpha", { q: "x" }, raw, deps);
    expect(raw).toHaveBeenCalledTimes(2);
  });

  it("bypasses cache when deps is undefined (backward-compat for stdio MCP path)", async () => {
    const raw = vi.fn().mockResolvedValue({ r: "ok" });
    await invokeWithCache("memory_lookup", "alpha", { q: "x" }, raw, undefined);
    await invokeWithCache("memory_lookup", "alpha", { q: "x" }, raw, undefined);
    expect(raw).toHaveBeenCalledTimes(2);
  });

  it("uses IDEMPOTENT_TOOL_DEFAULTS when getAgentPerfTools returns undefined", async () => {
    const turn = makeTurn();
    const raw = vi.fn().mockResolvedValue({ r: "ok" });
    const deps = {
      getActiveTurn: () => turn,
      getAgentPerfTools: () => undefined,
    };
    await invokeWithCache("memory_lookup", "alpha", { q: "x" }, raw, deps);
    await invokeWithCache("memory_lookup", "alpha", { q: "x" }, raw, deps);
    // memory_lookup is in the defaults → 1 call
    expect(raw).toHaveBeenCalledTimes(1);
  });

  it("handler failures do not poison the cache", async () => {
    const turn = makeTurn();
    const raw = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ results: ["real"] });
    const deps = {
      getActiveTurn: () => turn,
      getAgentPerfTools: () => ({
        maxConcurrent: 10,
        idempotent: ["memory_lookup"],
      }),
    };
    await expect(
      invokeWithCache("memory_lookup", "alpha", { q: "x" }, raw, deps),
    ).rejects.toThrow("boom");
    // Second call — must re-invoke real handler (cache empty because first threw)
    const r2 = await invokeWithCache("memory_lookup", "alpha", { q: "x" }, raw, deps);
    expect(r2).toEqual({ results: ["real"] });
    expect(raw).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// v1.7 cleanup — invokeWithCache concurrency-gate integration
// ---------------------------------------------------------------------------
describe("invokeWithCache + acquireToolSlot (v1.7 cleanup)", () => {
  it("calls acquireToolSlot before rawCall and releases after, even on error", async () => {
    const events: string[] = [];
    const raw = async (): Promise<{ ok: true }> => {
      events.push("raw");
      return { ok: true };
    };
    const deps = {
      acquireToolSlot: async (agent: string): Promise<() => void> => {
        events.push(`acquire:${agent}`);
        return () => events.push(`release:${agent}`);
      },
    };
    await invokeWithCache("memory_lookup", "alpha", { q: "x" }, raw, deps);
    expect(events).toEqual(["acquire:alpha", "raw", "release:alpha"]);
  });

  it("releases slot on error (finally semantics)", async () => {
    const events: string[] = [];
    const raw = async (): Promise<unknown> => {
      events.push("raw");
      throw new Error("boom");
    };
    const deps = {
      acquireToolSlot: async (): Promise<() => void> => {
        events.push("acquire");
        return () => events.push("release");
      },
    };
    await expect(
      invokeWithCache("memory_lookup", "alpha", { q: "x" }, raw, deps),
    ).rejects.toThrow("boom");
    expect(events).toEqual(["acquire", "raw", "release"]);
  });

  it("skips acquireToolSlot entirely on cache hit (fast path)", async () => {
    const cacheStore = new Map<string, unknown>();
    const turn = {
      toolCache: {
        get: (tool: string, args: unknown) => cacheStore.get(`${tool}|${JSON.stringify(args)}`),
        set: (tool: string, args: unknown, v: unknown) =>
          cacheStore.set(`${tool}|${JSON.stringify(args)}`, v),
        hitCount: () => 0,
      },
    } as unknown as import("../performance/trace-collector.js").Turn;

    let acquireCount = 0;
    const deps = {
      getActiveTurn: () => turn,
      getAgentPerfTools: () => ({
        maxConcurrent: 10,
        idempotent: ["memory_lookup"] as readonly string[],
      }),
      acquireToolSlot: async (): Promise<() => void> => {
        acquireCount += 1;
        return () => {};
      },
    };
    const raw = vi
      .fn<() => Promise<{ r: string }>>()
      .mockResolvedValue({ r: "v1" });

    // First call: miss → raw + acquire + release
    await invokeWithCache("memory_lookup", "alpha", { q: "x" }, raw, deps);
    expect(raw).toHaveBeenCalledTimes(1);
    expect(acquireCount).toBe(1);

    // Second identical call: hit → no raw, no acquire
    await invokeWithCache("memory_lookup", "alpha", { q: "x" }, raw, deps);
    expect(raw).toHaveBeenCalledTimes(1);
    expect(acquireCount).toBe(1); // unchanged — cache hit bypassed gate
  });

  it("falls through without gate when acquireToolSlot is undefined (backward compat)", async () => {
    const raw = vi.fn().mockResolvedValue({ ok: true });
    await invokeWithCache("memory_lookup", "alpha", { q: "x" }, raw, undefined);
    expect(raw).toHaveBeenCalledTimes(1);
  });
});

// Phase 999.2 Plan 02 — MCP tool aliases (D-RNX-01..04)
//
// Pins:
//   1. Canonical names ask_agent / post_to_agent are registered.
//   2. Old names send_message / send_to_agent remain registered as deprecated
//      aliases whose description starts with [DEPRECATED — use {new} instead].
//   3. Canonical name appears BEFORE the alias in the source file (insertion
//      order = tools/list iteration order — controls LLM picking heuristic
//      per D-RNX-04 verified against
//      node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:67-69).
describe("Phase 999.2 Plan 02 — MCP tool aliases", () => {
  const serverSource = readFileSync("src/mcp/server.ts", "utf8");

  it("ask_agent is registered (canonical name)", () => {
    expect(serverSource).toMatch(/server\.tool\(\s*"ask_agent"/);
  });

  it("send_message is registered as DEPRECATED alias (description prefix pinned)", () => {
    const m = serverSource.match(
      /server\.tool\(\s*"send_message",\s*\n?\s*"\[DEPRECATED — use ask_agent instead\]/,
    );
    expect(
      m,
      "send_message tool description must start with [DEPRECATED — use ask_agent instead]",
    ).not.toBeNull();
  });

  it("ask_agent is registered BEFORE send_message (insertion order = tools/list order)", () => {
    const askAt = serverSource.search(/server\.tool\(\s*"ask_agent"/);
    const sendAt = serverSource.search(/server\.tool\(\s*"send_message"/);
    expect(askAt).toBeGreaterThan(-1);
    expect(sendAt).toBeGreaterThan(-1);
    expect(
      askAt,
      "ask_agent must be registered before send_message",
    ).toBeLessThan(sendAt);
  });

  it("post_to_agent is registered (canonical name)", () => {
    expect(serverSource).toMatch(/server\.tool\(\s*"post_to_agent"/);
  });

  it("send_to_agent is registered as DEPRECATED alias (description prefix pinned)", () => {
    const m = serverSource.match(
      /server\.tool\(\s*"send_to_agent",\s*\n?\s*"\[DEPRECATED — use post_to_agent instead\]/,
    );
    expect(
      m,
      "send_to_agent tool description must start with [DEPRECATED — use post_to_agent instead]",
    ).not.toBeNull();
  });

  it("post_to_agent is registered BEFORE send_to_agent (insertion order = tools/list order)", () => {
    const postAt = serverSource.search(/server\.tool\(\s*"post_to_agent"/);
    const sendAt = serverSource.search(/server\.tool\(\s*"send_to_agent"/);
    expect(postAt).toBeGreaterThan(-1);
    expect(sendAt).toBeGreaterThan(-1);
    expect(
      postAt,
      "post_to_agent must be registered before send_to_agent",
    ).toBeLessThan(sendAt);
  });
});

// ---------------------------------------------------------------------------
// Phase 999.2 Plan 03 — ask_agent sync-reply MCP wrapper
//
// The pure-DI handler tests in src/manager/__tests__/ask-agent-ipc.test.ts
// pin the IPC contract (response field populated when target running, error
// propagation, mirror webhook calls). This block pins the MCP-wrapper-side
// SHAPE — the exact text templates surfaced to the calling LLM:
//
//   1. mirror_to_target_channel: z.boolean().default(false) added to schema
//   2. `${input.to} replied:` text template rendered when response present
//      (D-SYN-02 — the 2026-04-29 smoking-gun bug fix)
//   3. `is not running — no synchronous reply` template when response absent
//      (D-SYN-03 — explicit offline path)
//   4. `Failed to ask ${input.to}: ${msg}` template on caught error
//      (D-SYN-05 — error propagation surface)
//
// Static-grep is sufficient because the templates are deterministic strings;
// the IPC contract is already pinned upstream by the pure-DI handler tests.
// ---------------------------------------------------------------------------
describe("Phase 999.2 Plan 03 — ask_agent sync-reply MCP wrapper", () => {
  const serverSource = readFileSync("src/mcp/server.ts", "utf8");

  it("askAgentSchema includes mirror_to_target_channel: z.boolean().default(false)", () => {
    expect(serverSource).toContain(
      "mirror_to_target_channel: z.boolean().default(false)",
    );
  });

  it("ask_agent MCP wrapper renders target reply with `${input.to} replied:` template (A2A-09 — fixes 2026-04-29 smoking-gun bug)", () => {
    // The wrapper used to destructure {ok, messageId} and silently discard
    // result.response. Plan 03 surfaces the response in the tool-result text.
    expect(serverSource).toMatch(/\$\{[^}]+\} replied:/);
    // And the line must reference result.response (not just any random text):
    expect(serverSource).toMatch(/result\.response/);
  });

  it("ask_agent MCP wrapper renders offline-explicit text when response is undefined (A2A-12)", () => {
    expect(serverSource).toContain(
      "is not running — no synchronous reply",
    );
  });

  it("ask_agent MCP wrapper renders `Failed to ask ${input.to}: ${msg}` on dispatch error (A2A-11)", () => {
    expect(serverSource).toMatch(/Failed to ask \$\{[^}]+\}:/);
  });
});
