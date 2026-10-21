/**
 * Phase 59 Plan 03 Task 4 -- End-to-end integration test proving full
 * 5-step handoff roundtrip (ROADMAP success criteria 1-5).
 *
 * APPROACH: TaskManager integration test (not daemon integration). Uses a
 * real TaskStore + PayloadStore + SchemaRegistry (via fromEntries) with mock
 * TurnDispatcher + EscalationBudget. This proves all Phase 59 modules
 * compose correctly end-to-end without the heavyweight daemon startup.
 *
 * The IPC layer (daemon.ts routing) is proven by the unit tests in Task 3.
 * This test focuses on the handoff lifecycle observable from agent code.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { TaskStore } from "../store.js";
import { PayloadStore } from "../payload-store.js";
import {
  TaskManager,
  MAX_HANDOFF_DEPTH,
  type DelegateRequest,
} from "../task-manager.js";
import { SchemaRegistry, type CompiledSchema } from "../schema-registry.js";
import { compileJsonSchema } from "../handoff-schema.js";
import { computeInputDigest } from "../digest.js";
import type { TurnDispatcher } from "../../manager/turn-dispatcher.js";
import type { EscalationBudget } from "../../usage/budget.js";
import {
  ValidationError,
  UnauthorizedError,
  CycleDetectedError,
  DepthExceededError,
  SelfHandoffBlockedError,
} from "../errors.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTestSchema(): CompiledSchema {
  const input = compileJsonSchema({
    type: "object",
    properties: {
      topic: { type: "string", minLength: 3 },
      depth: { type: "string", enum: ["shallow", "medium", "deep"] },
    },
    required: ["topic", "depth"],
  });
  const output = compileJsonSchema({
    type: "object",
    properties: {
      summary: { type: "string", minLength: 5 },
      sources: { type: "array", items: { type: "string" } },
    },
    required: ["summary"],
  });
  return Object.freeze({ name: "research.brief", input, output });
}

function mockDispatcher(): TurnDispatcher & { dispatch: ReturnType<typeof vi.fn> } {
  const dispatch = vi.fn(async () => "response-text");
  return { dispatch } as unknown as TurnDispatcher & { dispatch: typeof dispatch };
}

function mockBudget(): EscalationBudget & { recordUsage: ReturnType<typeof vi.fn> } {
  const recordUsage = vi.fn();
  return { recordUsage } as unknown as EscalationBudget & { recordUsage: typeof recordUsage };
}

/**
 * Agent config lookup with many agents for depth-chain tests.
 * agent-0 through agent-9 all accept research.brief from any other agent.
 */
function broadGetAgentConfig(name: string) {
  if (name.startsWith("agent-")) {
    // Each agent accepts research.brief from all others
    const allAgents = Array.from({ length: 10 }, (_, i) => `agent-${i}`);
    return {
      name,
      model: "sonnet" as const,
      acceptsTasks: { "research.brief": allAgents.filter(n => n !== name) },
    };
  }
  return null;
}

function validRequest(overrides: Partial<DelegateRequest> = {}): DelegateRequest {
  return {
    caller: "agent-0",
    target: "agent-1",
    schema: "research.brief",
    payload: { topic: "AI safety", depth: "deep" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Phase 59 E2E -- ROADMAP success criteria 1-5", () => {
  let tmpDir: string;
  let taskStore: TaskStore;
  let payloadStore: PayloadStore;
  let dispatcher: ReturnType<typeof mockDispatcher>;
  let budget: ReturnType<typeof mockBudget>;
  let manager: TaskManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "phase59-e2e-"));
    taskStore = new TaskStore({ dbPath: join(tmpDir, "tasks.db") });
    payloadStore = new PayloadStore(taskStore.rawDb);
    dispatcher = mockDispatcher();
    budget = mockBudget();

    const registry = SchemaRegistry.fromEntries([makeTestSchema()]);
    manager = new TaskManager({
      store: taskStore,
      turnDispatcher: dispatcher,
      schemaRegistry: registry,
      escalationBudget: budget,
      getAgentConfig: broadGetAgentConfig,
      storePayload: (id, p) => payloadStore.storePayload(id, p),
      getStoredPayload: (id) => payloadStore.getPayload(id),
      storeResult: (id, r) => payloadStore.storeResult(id, r),
      getStoredResult: (id) => payloadStore.getResult(id),
    });
  });

  afterEach(async () => {
    taskStore.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ROADMAP success criterion 1: full happy path roundtrip
  it("Test 1: agent A delegates to B, B completes, A gets result-back turn", async () => {
    // Step 1: A delegates
    const resp = await manager.delegate(validRequest());
    expect(resp.task_id).toBeDefined();
    expect(typeof resp.task_id).toBe("string");

    // Step 2: Row should be in running state
    const row = taskStore.get(resp.task_id);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("running");

    // Step 3: B's turn was dispatched (mock called)
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    const [, agentName, message] = dispatcher.dispatch.mock.calls[0]!;
    expect(agentName).toBe("agent-1");
    expect(message).toContain("research.brief");
    expect(message).toContain("AI safety");

    // Step 4: B calls task_complete with cost
    await manager.completeTask(
      resp.task_id,
      { summary: "All done here", sources: ["a.com"] },
      500,
    );

    // Step 5: Row should be complete
    const completedRow = taskStore.get(resp.task_id);
    expect(completedRow!.status).toBe("complete");

    // Step 6: A's result-back turn was dispatched
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
    const [, resultAgentName, resultMessage] = dispatcher.dispatch.mock.calls[1]!;
    expect(resultAgentName).toBe("agent-0");
    expect(resultMessage).toContain("complete");

    // Step 7: Payload and result stored
    expect(payloadStore.getPayload(resp.task_id)).toEqual({ topic: "AI safety", depth: "deep" });
    expect(payloadStore.getResult(resp.task_id)).toEqual({ summary: "All done here", sources: ["a.com"] });
  });

  // ROADMAP success criterion 2: payload validation rejects
  it("Test 2: schema mismatch and oversize payload are rejected", async () => {
    // Missing required field "depth"
    await expect(
      manager.delegate(validRequest({ payload: { topic: "AI safety" } })),
    ).rejects.toThrow(ValidationError);

    // Oversize payload
    const oversizePayload = { topic: "x".repeat(100_000), depth: "deep" };
    await expect(
      manager.delegate(validRequest({ payload: oversizePayload })),
    ).rejects.toThrow(ValidationError);
  });

  // ROADMAP success criterion 3: deadline firing
  it("Test 3: task times out after deadline_ms", async () => {
    const now = Date.now();
    const resp = await manager.delegate(
      validRequest({ deadline_ms: now + 50 }),
    );

    // Wait for the timeout to fire
    await new Promise((r) => setTimeout(r, 150));

    const row = taskStore.get(resp.task_id);
    expect(row!.status).toBe("timed_out");
  });

  // ROADMAP success criterion 4: authorization rejections
  it("Test 4a: unknown target agent is rejected", async () => {
    await expect(
      manager.delegate(validRequest({ target: "unknown-bot" })),
    ).rejects.toThrow(UnauthorizedError);
  });

  it("Test 4b: target not in caller's allowlist is rejected", async () => {
    // Create a manager with a strict allowlist
    const strictConfig = (name: string) => {
      const configs: Record<string, { name: string; model: "sonnet" | "opus" | "haiku"; acceptsTasks: Record<string, string[]> }> = {
        "agent-0": { name: "agent-0", model: "sonnet", acceptsTasks: {} },
        "agent-1": {
          name: "agent-1",
          model: "sonnet",
          acceptsTasks: { "research.brief": ["agent-9"] }, // only agent-9 allowed
        },
      };
      return configs[name] ?? null;
    };
    const strictManager = new TaskManager({
      store: taskStore,
      turnDispatcher: dispatcher,
      schemaRegistry: SchemaRegistry.fromEntries([makeTestSchema()]),
      escalationBudget: budget,
      getAgentConfig: strictConfig,
      storePayload: (id, p) => payloadStore.storePayload(id, p),
      getStoredPayload: (id) => payloadStore.getPayload(id),
    });

    // agent-0 tries to delegate to agent-1 but only agent-9 is allowed
    await expect(
      strictManager.delegate(validRequest()),
    ).rejects.toThrow(UnauthorizedError);
  });

  it("Test 4c: exceeding max depth is rejected", async () => {
    // Use unique agent pairs for each hop: agent-0 -> agent-1 -> agent-2 -> ...
    // This avoids cycle detection while building a chain that exceeds depth.
    // Need MAX_HANDOFF_DEPTH + 1 hops to fill depths 0..MAX_HANDOFF_DEPTH,
    // then the (MAX_HANDOFF_DEPTH + 2)th delegation has depth > MAX and is rejected.
    let parentId: string | null = null;
    for (let i = 0; i <= MAX_HANDOFF_DEPTH; i++) {
      const caller = `agent-${i}`;
      const target = `agent-${i + 1}`;
      const resp = await manager.delegate(
        validRequest({ caller, target, parentTaskId: parentId }),
      );
      parentId = resp.task_id;
    }

    // The next delegation should exceed depth (depth = MAX_HANDOFF_DEPTH + 1 > MAX_HANDOFF_DEPTH)
    const lastCaller = `agent-${MAX_HANDOFF_DEPTH + 1}`;
    const lastTarget = `agent-${MAX_HANDOFF_DEPTH + 2}`;

    await expect(
      manager.delegate(validRequest({
        caller: lastCaller,
        target: lastTarget,
        parentTaskId: parentId,
      })),
    ).rejects.toThrow(DepthExceededError);
  });

  it("Test 4d: self-handoff is rejected", async () => {
    await expect(
      manager.delegate(validRequest({ caller: "agent-1", target: "agent-1" })),
    ).rejects.toThrow(SelfHandoffBlockedError);
  });

  it("Test 4e: cycle detection rejects circular chains", async () => {
    // A (agent-0) -> B (agent-1)
    const resp1 = await manager.delegate(
      validRequest({ caller: "agent-0", target: "agent-1" }),
    );

    // B (agent-1) -> A (agent-0) with parent = resp1 => cycle!
    await expect(
      manager.delegate(validRequest({
        caller: "agent-1",
        target: "agent-0",
        parentTaskId: resp1.task_id,
      })),
    ).rejects.toThrow(CycleDetectedError);
  });

  // ROADMAP success criterion 5: retry preserves digest + LIFE-05 budget
  it("Test 5: retry on failed task preserves input_digest and charges original caller", async () => {
    // Delegate
    const resp = await manager.delegate(validRequest());
    const originalRow = taskStore.get(resp.task_id)!;
    const originalDigest = originalRow.input_digest;

    // Force to failed state
    taskStore.transition(resp.task_id, "failed", { error: "agent-1 crashed" });

    // Retry
    const retryResp = await manager.retry(resp.task_id);
    expect(retryResp.task_id).not.toBe(resp.task_id);

    // Verify input_digest is identical
    const retryRow = taskStore.get(retryResp.task_id)!;
    expect(retryRow.input_digest).toBe(originalDigest);

    // Verify the same payload is used
    const retryPayload = payloadStore.getPayload(retryResp.task_id);
    const originalPayload = payloadStore.getPayload(resp.task_id);
    expect(retryPayload).toEqual(originalPayload);
    expect(computeInputDigest(retryPayload)).toBe(originalDigest);

    // Complete the retried task with cost to trigger LIFE-05 budget attribution
    await manager.completeTask(
      retryResp.task_id,
      { summary: "Retry done", sources: [] },
      1000,
    );

    // LIFE-05: budget attribution goes to original caller
    expect(budget.recordUsage).toHaveBeenCalled();
    const budgetCalls = budget.recordUsage.mock.calls;
    const callerCharge = budgetCalls.find(
      (c: unknown[]) => c[0] === "agent-0",
    );
    expect(callerCharge).toBeDefined();
  });
});
