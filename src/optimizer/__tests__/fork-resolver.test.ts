/**
 * Phase 142 fix — optimizer fork-resolver factory tests.
 *
 * Exercises the REAL daemon-edge registration logic (extracted into
 * `makeOptimizerForkResolver`) rather than a re-hand-wired copy — closing the
 * blind spot that let the original integration bug ship: the daemon edge that
 * registers the fork's LlmRuntime resolver was never unit-tested (the runner
 * tests mock SessionManager; the isolation spike used raw SDK query()).
 */
import { describe, it, expect, vi } from "vitest";
import { makeOptimizerForkResolver } from "../fork-resolver.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type {
  AgentLlmRuntimeResolver,
  LlmRuntimeDeps,
} from "../../llm-runtime/index.js";

const evalCfg = {
  name: "research-fork-abc123-opt",
  skills: ["alpha"],
  mcpServers: [],
} as unknown as ResolvedAgentConfig;

const sentinel = (() => ({})) as unknown as AgentLlmRuntimeResolver;

describe("Phase 142 fix — makeOptimizerForkResolver", () => {
  it("registers a resolver built from the FORK config, keyed by fork name, inheriting parent creds", () => {
    const registry = new Map<string, AgentLlmRuntimeResolver>();
    const createResolver = vi.fn(
      (_config: ResolvedAgentConfig, _deps: LlmRuntimeDeps): AgentLlmRuntimeResolver =>
        sentinel,
    );
    const creds = {} as unknown as NonNullable<LlmRuntimeDeps["openaiCredentials"]>;

    const r = makeOptimizerForkResolver({
      registry,
      createResolver,
      logger: undefined,
      openaiCredentialsFor: (p) => (p === "research" ? creds : undefined),
      failoverStateReader: undefined,
      mcpTracker: null,
    });

    r.registerLlmRuntime("research-fork-abc123-opt", evalCfg, "research");

    expect(createResolver).toHaveBeenCalledTimes(1);
    const [cfgArg, depsArg] = createResolver.mock.calls[0];
    // built from the FORK config (candidate skills + tool-free), NOT the parent
    expect(cfgArg).toBe(evalCfg);
    // inherits the PARENT agent's OpenAI credentials
    expect(depsArg.openaiCredentials).toBe(creds);
    // opEnvResolver intentionally omitted — the eval fork strips mcpServers
    expect("opEnvResolver" in depsArg).toBe(false);
    // registered under the fork name
    expect(registry.get("research-fork-abc123-opt")).toBe(sentinel);
  });

  it("unregisterLlmRuntime removes the fork's resolver", () => {
    const registry = new Map<string, AgentLlmRuntimeResolver>();
    const r = makeOptimizerForkResolver({
      registry,
      createResolver: (_c: ResolvedAgentConfig, _d: LlmRuntimeDeps) => sentinel,
      logger: undefined,
      openaiCredentialsFor: () => undefined,
      failoverStateReader: undefined,
      mcpTracker: null,
    });

    r.registerLlmRuntime("fork-x", evalCfg, "research");
    expect(registry.has("fork-x")).toBe(true);
    r.unregisterLlmRuntime("fork-x");
    expect(registry.has("fork-x")).toBe(false);
  });

  // Phase 142 follow-up — opEnvResolver is wired ONLY for a tool-capable fork
  // (so allowlisted MCP servers get op:// creds); omitted for the tool-free fork.
  const evalCfgWithTools = {
    name: "research-fork-xyz-opt",
    skills: ["alpha"],
    mcpServers: [{ name: "finnhub" }],
  } as unknown as ResolvedAgentConfig;
  const opEnvResolver = (async (o: Record<string, Record<string, string>>) =>
    o) as NonNullable<LlmRuntimeDeps["opEnvResolver"]>;

  const makeWithOpEnv = () => {
    const registry = new Map<string, AgentLlmRuntimeResolver>();
    const createResolver = vi.fn(
      (_c: ResolvedAgentConfig, _d: LlmRuntimeDeps): AgentLlmRuntimeResolver => sentinel,
    );
    const r = makeOptimizerForkResolver({
      registry,
      createResolver,
      logger: undefined,
      openaiCredentialsFor: () => undefined,
      failoverStateReader: undefined,
      mcpTracker: null,
      opEnvResolver,
    });
    return { r, createResolver };
  };

  it("wires opEnvResolver ONLY when the fork has a scoped tool surface", () => {
    const { r, createResolver } = makeWithOpEnv();
    r.registerLlmRuntime("research-fork-xyz-opt", evalCfgWithTools, "research");
    const [, depsArg] = createResolver.mock.calls[0];
    expect(depsArg.opEnvResolver).toBe(opEnvResolver);
  });

  it("omits opEnvResolver for a tool-free fork even when one is provided", () => {
    const { r, createResolver } = makeWithOpEnv();
    r.registerLlmRuntime("research-fork-abc123-opt", evalCfg, "research"); // evalCfg.mcpServers === []
    const [, depsArg] = createResolver.mock.calls[0];
    expect("opEnvResolver" in depsArg).toBe(false);
  });
});
