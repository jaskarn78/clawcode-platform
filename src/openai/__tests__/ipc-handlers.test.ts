/**
 * Quick task 260419-p51 — IPC handler tests for multi-agent (--all) keys
 * (P51-MULTI-AGENT-KEY).
 *
 * Focus: the create-key handler's new `all:true` branch + Zod validation on
 * the mutually-exclusive `{agent, all}` fields. Uses a real :memory:
 * ApiKeysStore so we validate the end-to-end persistence path, with a
 * tiny mock `sessionManager` that returns `undefined` for getMemoryStore
 * (revoke-clears-session is covered elsewhere).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { ApiKeysStore } from "../keys.js";
import {
  handleOpenAiKeyCreate,
  openAiKeyCreateRequestSchema,
  type OpenAiKeyIpcDeps,
} from "../ipc-handlers.js";

function makeDeps(agents: ReadonlyArray<string> = ["clawdy", "fin-test", "admin-clawdy"]): {
  deps: OpenAiKeyIpcDeps;
  store: ApiKeysStore;
} {
  const store = new ApiKeysStore(":memory:");
  const deps: OpenAiKeyIpcDeps = {
    apiKeysStore: store,
    sessionManager: {
      // Revoke path isn't exercised in these tests; stub getMemoryStore to
      // always return undefined so the clear-session loop short-circuits.
      getMemoryStore: () => undefined,
    } as unknown as OpenAiKeyIpcDeps["sessionManager"],
    agentNames: () => agents,
  };
  return { deps, store };
}

describe("openAiKeyCreateRequestSchema — discriminated union", () => {
  it("accepts {agent} alone", () => {
    const result = openAiKeyCreateRequestSchema.safeParse({ agent: "clawdy" });
    expect(result.success).toBe(true);
  });

  it("accepts {all:true} alone", () => {
    const result = openAiKeyCreateRequestSchema.safeParse({ all: true });
    expect(result.success).toBe(true);
  });

  it("accepts {agent, label, expiresAt}", () => {
    const result = openAiKeyCreateRequestSchema.safeParse({
      agent: "clawdy",
      label: "laptop",
      expiresAt: Date.now() + 60_000,
    });
    expect(result.success).toBe(true);
  });

  it("accepts {all:true, label, expiresAt}", () => {
    const result = openAiKeyCreateRequestSchema.safeParse({
      all: true,
      label: "fleet",
      expiresAt: Date.now() + 60_000,
    });
    expect(result.success).toBe(true);
  });

  it("rejects {agent, all:true} — mutually exclusive", () => {
    const result = openAiKeyCreateRequestSchema.safeParse({ agent: "clawdy", all: true });
    expect(result.success).toBe(false);
  });

  it("rejects empty payload — neither agent nor all", () => {
    const result = openAiKeyCreateRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects {all:false}", () => {
    const result = openAiKeyCreateRequestSchema.safeParse({ all: false });
    expect(result.success).toBe(false);
  });
});

describe("handleOpenAiKeyCreate — single-agent (back-compat)", () => {
  let deps: OpenAiKeyIpcDeps;
  let store: ApiKeysStore;

  beforeEach(() => {
    const built = makeDeps();
    deps = built.deps;
    store = built.store;
  });

  afterEach(() => {
    store.close();
  });

  it("creates a pinned key with scope='agent:<name>'", () => {
    const response = handleOpenAiKeyCreate(deps, {
      agent: "clawdy",
      label: "pinned-test",
    });
    expect(response.agent).toBe("clawdy");
    expect(response.key).toMatch(/^ck_clawdy_/);
    const rows = store.listKeys();
    expect(rows[0]?.scope).toBe("agent:clawdy");
  });

  it("rejects unknown agent with a clear error", () => {
    expect(() =>
      handleOpenAiKeyCreate(deps, { agent: "nonexistent", label: "x" }),
    ).toThrow(/Unknown agent/);
  });
});

describe("handleOpenAiKeyCreate — --all branch", () => {
  let deps: OpenAiKeyIpcDeps;
  let store: ApiKeysStore;

  beforeEach(() => {
    const built = makeDeps();
    deps = built.deps;
    store = built.store;
  });

  afterEach(() => {
    store.close();
  });

  it("creates an --all key with scope='all' + agent_name='*'", () => {
    const response = handleOpenAiKeyCreate(deps, {
      all: true,
      label: "openclaw-all",
    });
    expect(response.agent).toBe("*");
    expect(response.key).toMatch(/^ck_all_/);
    const rows = store.listKeys();
    expect(rows[0]?.scope).toBe("all");
    expect(rows[0]?.agent_name).toBe("*");
    expect(rows[0]?.label).toBe("openclaw-all");
  });

  it("skips the agent-name validation (no single agent to check)", () => {
    // Even with a strict agentNames() that returns an empty list, --all works.
    const emptyFleet = makeDeps([]);
    expect(() =>
      handleOpenAiKeyCreate(emptyFleet.deps, { all: true, label: "x" }),
    ).not.toThrow();
    emptyFleet.store.close();
  });

  it("--all key honors expiresAt", () => {
    const future = Date.now() + 60_000;
    const response = handleOpenAiKeyCreate(deps, {
      all: true,
      label: "x",
      expiresAt: future,
    });
    expect(response.expiresAt).toBe(future);
  });
});
