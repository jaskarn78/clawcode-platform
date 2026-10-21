/**
 * Phase 142 — forked agent-runner ORCHESTRATION CONTRACT tests.
 *
 * IMPORTANT: these mock SessionManager and verify only the wiring (fork config
 * overrides, headless, teardown discipline, unique names). They DO NOT verify
 * that a real forked SDK session loads only the candidate skills — that is the
 * load-bearing isolation assumption, proven by scripts/isolation-spike.ts run
 * LIVE, not here. Green here == "the mock matches our assumption".
 */
import { describe, it, expect, vi } from "vitest";
import { makeForkedAgentRunner, type EvalSessionManager } from "../agent-runner.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";

const parent = {
  name: "research",
  soul: "you are research",
  model: "opus",
  effort: "high",
  workspace: "/live/ws",
  memoryPath: "/live/mem",
  skills: ["live-skill"],
  channels: ["chan1"],
} as unknown as ResolvedAgentConfig;

function fakeSM(over: Partial<EvalSessionManager> = {}): EvalSessionManager & {
  startAgent: ReturnType<typeof vi.fn>;
  dispatchTurn: ReturnType<typeof vi.fn>;
  stopAgent: ReturnType<typeof vi.fn>;
} {
  return {
    startAgent: vi.fn(async () => {}),
    dispatchTurn: vi.fn(async () => "agent reply"),
    stopAgent: vi.fn(async () => {}),
    ...over,
  } as never;
}

describe("Phase 142 — makeForkedAgentRunner (orchestration contract)", () => {
  it("forks a headless, isolated session pinned to the candidate workspace + skills", async () => {
    const sm = fakeSM();
    const run = makeForkedAgentRunner({
      sessionManager: sm,
      parentConfig: parent,
      workspace: "/tmp/cand",
      skillNames: ["alpha", "beta"],
      memoryPath: "/tmp/optmem",
    });
    const r = await run("hello there");

    expect(r.response).toBe("agent reply");
    expect(sm.startAgent).toHaveBeenCalledTimes(1);
    const [forkName, cfg] = sm.startAgent.mock.calls[0] as [string, ResolvedAgentConfig];
    expect(forkName).toMatch(/^research-fork-.+-opt$/);
    expect(cfg.channels).toEqual([]); // headless — no Discord bindings
    expect(cfg.workspace).toBe("/tmp/cand"); // candidate-skills cwd
    expect(cfg.gsd).toBeUndefined(); // so resolveSessionCwd === workspace
    expect(cfg.memoryPath).toBe("/tmp/optmem"); // isolated throwaway memory
    expect(cfg.settingSources).toEqual(["project"]); // load skills from cwd only
    expect(cfg.skills).toEqual(["alpha", "beta"]);
    expect(sm.dispatchTurn).toHaveBeenCalledWith(forkName, "hello there");
    expect(sm.stopAgent).toHaveBeenCalledWith(forkName);
  });

  it("ALWAYS tears down the session, even when the turn throws (no PID leak)", async () => {
    const sm = fakeSM({
      dispatchTurn: vi.fn(async () => {
        throw new Error("turn boom");
      }),
    });
    const run = makeForkedAgentRunner({
      sessionManager: sm,
      parentConfig: parent,
      workspace: "/tmp/cand",
      skillNames: [],
      memoryPath: "/tmp/optmem",
    });
    await expect(run("hi")).rejects.toThrow("turn boom");
    expect(sm.stopAgent).toHaveBeenCalledTimes(1);
  });

  it("uses a unique fork name per call, never the live agent's name", async () => {
    const sm = fakeSM();
    const run = makeForkedAgentRunner({
      sessionManager: sm,
      parentConfig: parent,
      workspace: "/tmp/cand",
      skillNames: [],
      memoryPath: "/tmp/optmem",
    });
    await run("a");
    await run("b");
    const n1 = sm.startAgent.mock.calls[0][0] as string;
    const n2 = sm.startAgent.mock.calls[1][0] as string;
    expect(n1).not.toBe(n2);
    expect(n1).not.toBe("research");
  });

  it("swallows a teardown (stopAgent) failure — it must not mask the response", async () => {
    const sm = fakeSM({
      stopAgent: vi.fn(async () => {
        throw new Error("stop boom");
      }),
    });
    const run = makeForkedAgentRunner({
      sessionManager: sm,
      parentConfig: parent,
      workspace: "/tmp/cand",
      skillNames: [],
      memoryPath: "/tmp/optmem",
      log: () => {},
    });
    const r = await run("hi");
    expect(r.response).toBe("agent reply");
  });
});

describe("Phase 142 fix — LlmRuntime resolver registration + tool-free fork", () => {
  it("registers the fork resolver BEFORE startAgent and unregisters AFTER stopAgent", async () => {
    // This is the exact invariant the original 0%-score bug violated: the fork
    // name was never registered, so getLlmRuntime threw in the adapter ctor.
    const order: string[] = [];
    const sm = fakeSM({
      startAgent: vi.fn(async () => {
        order.push("startAgent");
      }),
      dispatchTurn: vi.fn(async () => {
        order.push("dispatchTurn");
        return "agent reply";
      }),
      stopAgent: vi.fn(async () => {
        order.push("stopAgent");
      }),
    });
    const registered: Array<{
      forkName: string;
      cfg: ResolvedAgentConfig;
      parent: string;
    }> = [];
    const run = makeForkedAgentRunner({
      sessionManager: sm,
      parentConfig: parent,
      workspace: "/tmp/cand",
      skillNames: ["alpha"],
      memoryPath: "/tmp/optmem",
      registerLlmRuntime: (forkName, cfg, p) => {
        order.push("register");
        registered.push({ forkName, cfg, parent: p });
      },
      unregisterLlmRuntime: () => {
        order.push("unregister");
      },
    });
    await run("hi");

    expect(order).toEqual([
      "register",
      "startAgent",
      "dispatchTurn",
      "stopAgent",
      "unregister",
    ]);
    // The resolver is built from the FORK config (candidate skills + tool-free),
    // keyed by the SAME name startAgent receives — isolation depends on it.
    expect(registered).toHaveLength(1);
    expect(registered[0].forkName).toMatch(/^research-fork-.+-opt$/);
    expect(registered[0].forkName).toBe(sm.startAgent.mock.calls[0][0]);
    expect(registered[0].cfg.skills).toEqual(["alpha"]);
    expect(registered[0].cfg.mcpServers).toEqual([]);
    expect(registered[0].parent).toBe("research");
  });

  it("strips mcpServers so the eval fork runs tool-free", async () => {
    const sm = fakeSM();
    const run = makeForkedAgentRunner({
      sessionManager: sm,
      parentConfig: parent,
      workspace: "/tmp/cand",
      skillNames: [],
      memoryPath: "/tmp/optmem",
    });
    await run("hi");
    const [, cfg] = sm.startAgent.mock.calls[0] as [string, ResolvedAgentConfig];
    expect(cfg.mcpServers).toEqual([]);
  });

  it("unregisters the resolver even if startAgent throws, and skips stopAgent", async () => {
    const order: string[] = [];
    const sm = fakeSM({
      startAgent: vi.fn(async () => {
        order.push("startAgent");
        throw new Error("start boom");
      }),
      stopAgent: vi.fn(async () => {
        order.push("stopAgent");
      }),
    });
    const run = makeForkedAgentRunner({
      sessionManager: sm,
      parentConfig: parent,
      workspace: "/tmp/cand",
      skillNames: [],
      memoryPath: "/tmp/optmem",
      registerLlmRuntime: () => order.push("register"),
      unregisterLlmRuntime: () => order.push("unregister"),
    });
    await expect(run("hi")).rejects.toThrow("start boom");
    // no session was created → nothing to stop, but the registry MUST be cleaned
    expect(order).toEqual(["register", "startAgent", "unregister"]);
    expect(sm.stopAgent).not.toHaveBeenCalled();
  });
});

describe("Phase 142 follow-up — scoped MCP tool surface (fail-closed allowlist)", () => {
  const parentWithMcp = {
    ...parent,
    mcpServers: [
      { name: "finnhub" },
      { name: "brave-search" },
      { name: "acme-content" },
    ],
  } as unknown as ResolvedAgentConfig;

  const mkRun = (evalMcpServers?: readonly string[]) => {
    const sm = fakeSM();
    const run = makeForkedAgentRunner({
      sessionManager: sm,
      parentConfig: parentWithMcp,
      workspace: "/tmp/cand",
      skillNames: [],
      memoryPath: "/tmp/optmem",
      evalMcpServers,
    });
    return { sm, run };
  };
  const forkServers = (sm: ReturnType<typeof fakeSM>): string[] => {
    const [, cfg] = sm.startAgent.mock.calls[0] as [string, ResolvedAgentConfig];
    return (cfg.mcpServers ?? []).map((s) => s.name);
  };

  it("defaults to TOOL-FREE (mcpServers: []) when evalMcpServers is unset", async () => {
    const { sm, run } = mkRun(undefined);
    await run("hi");
    expect(forkServers(sm)).toEqual([]);
  });

  it("grants ONLY allowlisted servers that are also attached (fail-closed intersection)", async () => {
    // "google-workspace" is listed but NOT attached → dropped; "acme-content"
    // is attached but NOT listed → dropped.
    const { sm, run } = mkRun(["finnhub", "google-workspace"]);
    await run("hi");
    expect(forkServers(sm)).toEqual(["finnhub"]);
  });

  it("never grants an attached-but-unlisted (write) server", async () => {
    const { sm, run } = mkRun(["finnhub", "brave-search"]);
    await run("hi");
    const names = forkServers(sm);
    expect(names).toEqual(["finnhub", "brave-search"]);
    expect(names).not.toContain("acme-content");
  });
});
