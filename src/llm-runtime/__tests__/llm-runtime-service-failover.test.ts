/**
 * Phase 138 Plan 05 T-03 — `createLlmRuntimeService` failover override.
 *
 * The factory reads `deps.failoverStateReader?.getActiveBackend(
 * config.name, Date.now())` BEFORE the config-backend `switch`. When the
 * reader returns a backend ID, dispatch uses that (CONTEXT D3 — runtime
 * override > config); otherwise behaviour is unchanged.
 *
 * Cases pinned:
 *   (a) No reader → dispatches to `config.llmRuntime.backend`.
 *   (b) Reader returns undefined → dispatches to the configured backend.
 *   (c) Reader returns "anthropic-agent-sdk" while config is "codex-cli"
 *       → dispatches to AnthropicAgentSdkBackend.
 *   (d) Reader returns "codex-cli" while config is "anthropic-agent-sdk"
 *       → dispatches to CodexAgentCli.
 *   (e) Override path emits `phase138-failover-active`; non-override
 *       path does NOT.
 *
 * See:
 *   - `.planning/phases/138-.../138-05-PLAN.md` T-03
 *   - `src/usage/failover-state.ts` — FailoverStateReader interface
 */

import { describe, it, expect, vi } from "vitest";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { LlmRuntimeBackend } from "../types.js";
import { createLlmRuntimeService } from "../llm-runtime-service.js";
import { AnthropicAgentSdkBackend } from "../backends/anthropic-agent-sdk.js";
import { CodexAgentCli } from "../backends/codex-agent-cli.js";

function makeConfig(
  name: string,
  backend: LlmRuntimeBackend,
): ResolvedAgentConfig {
  return {
    name,
    workspace: "/tmp/clawcode-test",
    memoryPath: "/tmp/clawcode-test",
    channels: [],
    model: "sonnet",
    effort: "low",
    allowedModels: ["haiku", "sonnet", "opus"],
    greetOnRestart: true,
    greetCoolDownMs: 300_000,
    autoCompactAt: 0.7,
    memoryRetrievalTopK: 0,
    memoryRetrievalExcludeTags: [],
    memoryScannerEnabled: false,
    memoryFlushIntervalMs: 60_000,
    memoryCueEmoji: "✅",
    autoIngestAttachments: false,
    ingestionPriority: "medium" as const,
    excludeDynamicSections: false,
    cacheBreakpointPlacement: "after-skills",
    autoStart: false,
    skills: [],
    marketplaceSources: [],
    capabilityMode: "open",
    perTurnAllowList: [],
    allowList: [],
    capabilityProbeBatchSize: 4,
    capabilityProbeCacheTtlMs: 300_000,
    capabilityProbeRetryAfterMs: 30_000,
    mcpServers: [],
    slashCommands: [],
    llmRuntime: { backend, failoverChain: [] },
  } as unknown as ResolvedAgentConfig;
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

/** Count emissions of a given structured-log message string. */
function emitCount(
  logger: { info: ReturnType<typeof vi.fn> },
  msg: string,
): number {
  return logger.info.mock.calls.filter((call) => call[1] === msg).length;
}

describe("createLlmRuntimeService — failover override", () => {
  it("(a) no failoverStateReader → dispatches to the configured backend", () => {
    const svc = createLlmRuntimeService(
      makeConfig("agent-a", "anthropic-agent-sdk"),
      { logger: makeLogger() },
    );
    expect(svc).toBeInstanceOf(AnthropicAgentSdkBackend);
  });

  it("(b) reader returns undefined → dispatches to the configured backend", () => {
    const reader = { getActiveBackend: vi.fn().mockReturnValue(undefined) };
    const svc = createLlmRuntimeService(
      makeConfig("agent-b", "codex-cli"),
      { logger: makeLogger(), failoverStateReader: reader },
    );
    expect(svc).toBeInstanceOf(CodexAgentCli);
    expect(reader.getActiveBackend).toHaveBeenCalledWith(
      "agent-b",
      expect.any(Number),
    );
  });

  it("(c) override anthropic-agent-sdk over codex-cli config → AnthropicAgentSdkBackend", () => {
    const reader = {
      getActiveBackend: vi.fn().mockReturnValue("anthropic-agent-sdk"),
    };
    const svc = createLlmRuntimeService(
      makeConfig("agent-c", "codex-cli"),
      { logger: makeLogger(), failoverStateReader: reader },
    );
    expect(svc).toBeInstanceOf(AnthropicAgentSdkBackend);
  });

  it("(d) override codex-cli over anthropic-agent-sdk config → CodexAgentCli", () => {
    const reader = {
      getActiveBackend: vi.fn().mockReturnValue("codex-cli"),
    };
    const svc = createLlmRuntimeService(
      makeConfig("agent-d", "anthropic-agent-sdk"),
      { logger: makeLogger(), failoverStateReader: reader },
    );
    expect(svc).toBeInstanceOf(CodexAgentCli);
  });

  it("(e) override path emits phase138-failover-active; non-override does NOT", () => {
    // Override active.
    const overrideLogger = makeLogger();
    createLlmRuntimeService(makeConfig("agent-e1", "anthropic-agent-sdk"), {
      logger: overrideLogger,
      failoverStateReader: {
        getActiveBackend: vi.fn().mockReturnValue("codex-cli"),
      },
    });
    expect(emitCount(overrideLogger, "phase138-failover-active")).toBe(1);
    // The phase136 line still fires with the CONFIGURED backend.
    expect(emitCount(overrideLogger, "phase136-llm-runtime")).toBe(1);

    // No override → no failover-active line.
    const plainLogger = makeLogger();
    createLlmRuntimeService(makeConfig("agent-e2", "anthropic-agent-sdk"), {
      logger: plainLogger,
      failoverStateReader: {
        getActiveBackend: vi.fn().mockReturnValue(undefined),
      },
    });
    expect(emitCount(plainLogger, "phase138-failover-active")).toBe(0);

    // Override that matches the configured backend → no failover-active
    // line (override !== configured is the gate).
    const sameLogger = makeLogger();
    createLlmRuntimeService(makeConfig("agent-e3", "codex-cli"), {
      logger: sameLogger,
      failoverStateReader: {
        getActiveBackend: vi.fn().mockReturnValue("codex-cli"),
      },
    });
    expect(emitCount(sameLogger, "phase138-failover-active")).toBe(0);
  });
});
