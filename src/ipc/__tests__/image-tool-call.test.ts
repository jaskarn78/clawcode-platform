import { describe, it, expect, vi } from "vitest";
import { Buffer } from "node:buffer";

import { handleImageToolCall } from "../../image/daemon-handler.js";
import type { ImageDaemonHandlerDeps } from "../../image/daemon-handler.js";
import type { ImageConfig } from "../../config/schema.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type {
  ImageBackend,
  ImageProvider,
  ImageToolOutcome,
} from "../../image/types.js";
import type { ProviderImageBatch } from "../../image/providers/openai.js";
import type { UsageTracker } from "../../usage/tracker.js";
import type { IpcImageToolCallParams } from "../types.js";

/**
 * Phase 72 Plan 02 — `image-tool-call` IPC handler tests.
 *
 * Drives the real `handleImageToolCall` against vi.fn() provider clients,
 * a vi.fn() writeImage, and a vi.fn() usageTrackerLookup. No real HTTP,
 * no real disk, no real daemon. Mirrors Phase 71 search-tool-call.test.ts
 * structure.
 *
 * Ten cases pin the handler contract:
 *   D1  — internal when image MCP is globally disabled
 *   D2  — invalid_argument when agent is unknown
 *   D3  — routes image_generate to imageGenerate with per-agent workspace
 *   D4  — routes image_edit to imageEdit
 *   D5  — routes image_variations to imageVariations
 *   D6  — invalid_argument when toolName is unknown
 *   D7  — never throws: pure handler rejection → internal error envelope
 *   D8  — agentWorkspace passed to handler matches resolvedAgent.workspace
 *   D9  — usageTrackerLookup returning undefined → recordCost is a no-op
 *   D10 — usageTrackerLookup returning a tracker → recordCost forwards
 *         the ImageUsageEvent to recordImageUsage(tracker, event)
 */

// --- fixtures --------------------------------------------------------------

const BASE_IMAGE_CFG: ImageConfig = {
  enabled: true,
  backend: "openai",
  openai: { apiKeyEnv: "OPENAI_API_KEY", model: "gpt-image-1" },
  minimax: { apiKeyEnv: "MINIMAX_API_KEY", model: "image-01" },
  fal: { apiKeyEnv: "FAL_API_KEY", model: "fal-ai/flux-pro" },
  maxImageBytes: 10485760,
  timeoutMs: 60000,
  workspaceSubdir: "generated-images",
};

function makeAgent(name: string, workspace?: string): ResolvedAgentConfig {
  return {
    name,
    workspace: workspace ?? `/tmp/${name}`,
    channels: [],
    model: "sonnet",
    effort: "low",
    skills: [],
    skillsPath: "/tmp/skills",
    schedules: [],
    admin: false,
    reactions: true,
    mcpServers: [],
    slashCommands: [],
  } as unknown as ResolvedAgentConfig;
}

function makeProviderBatch(): ImageToolOutcome<ProviderImageBatch> {
  return Object.freeze({
    ok: true as const,
    data: Object.freeze({
      images: Object.freeze([
        Object.freeze({
          bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
          size: "1024x1024",
          model: "gpt-image-1",
        }),
      ]),
      cost_cents: 4,
    }),
  }) satisfies ImageToolOutcome<ProviderImageBatch>;
}

function makeProvider(): ImageProvider {
  return {
    generate: vi.fn(async () => makeProviderBatch()),
    edit: vi.fn(async () => makeProviderBatch()),
    variations: vi.fn(async () => makeProviderBatch()),
  };
}

function makeDeps(
  overrides: Partial<ImageDaemonHandlerDeps> = {},
): ImageDaemonHandlerDeps {
  const providers: Record<ImageBackend, ImageProvider> = {
    openai: makeProvider(),
    minimax: makeProvider(),
    fal: makeProvider(),
  };
  const writeImage = vi.fn(
    async (
      workspace: string,
      subdir: string,
      _bytes: Buffer,
      ext: string,
    ) => `${workspace}/${subdir}/fake-image.${ext}`,
  );
  const usageTrackerLookup = vi.fn(
    (_agent: string): UsageTracker | undefined => undefined,
  );

  return {
    imageConfig: BASE_IMAGE_CFG,
    resolvedAgents: [makeAgent("clawdy", "/tmp/workspaces/clawdy")],
    providers,
    writeImage,
    usageTrackerLookup,
    ...overrides,
  };
}

describe("handleImageToolCall (Phase 72 Plan 02)", () => {
  it("D1: returns internal when image MCP is globally disabled", async () => {
    const deps = makeDeps({
      imageConfig: { ...BASE_IMAGE_CFG, enabled: false },
    });
    const params: IpcImageToolCallParams = {
      agent: "clawdy",
      toolName: "image_generate",
      args: { prompt: "a cat" },
    };
    const outcome = await handleImageToolCall(deps, params);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("internal");
      expect(outcome.error.message).toMatch(/disabled/i);
    }
  });

  it("D2: returns invalid_argument when the agent is unknown", async () => {
    const deps = makeDeps();
    const outcome = await handleImageToolCall(deps, {
      agent: "ghost",
      toolName: "image_generate",
      args: { prompt: "a cat" },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("invalid_argument");
      expect(outcome.error.message).toMatch(/unknown agent/i);
      expect(outcome.error.message).toContain("ghost");
    }
  });

  it("D3: routes image_generate to imageGenerate with per-agent workspace", async () => {
    const deps = makeDeps();
    const outcome = await handleImageToolCall(deps, {
      agent: "clawdy",
      toolName: "image_generate",
      args: { prompt: "a cat in a tophat" },
    });
    expect(outcome.ok).toBe(true);
    const openaiProvider = deps.providers.openai;
    expect(openaiProvider.generate as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(deps.writeImage as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    const [firstWriteWorkspace] = (deps.writeImage as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string, Buffer, string];
    expect(firstWriteWorkspace).toBe("/tmp/workspaces/clawdy");
  });

  it("D4: routes image_edit to imageEdit", async () => {
    const readFile = vi.fn(async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const deps = makeDeps({
      resolvedAgents: [makeAgent("clawdy", "/tmp/workspaces/clawdy")],
    });
    // Need to supply readFile via a wrapper. The handler passes an
    // optional readFile through ImageToolDeps; tests assert on the
    // provider.edit call having been invoked (the handler must route
    // through imageEdit, which reads the source file first).
    // Use fal backend for edit (supported) with an inline readFile dep.
    const outcome = await handleImageToolCall(
      { ...deps, readFile },
      {
        agent: "clawdy",
        toolName: "image_edit",
        args: {
          imagePath: "/tmp/fake-input.png",
          prompt: "make it purple",
          backend: "fal",
        },
      },
    );
    expect(outcome.ok).toBe(true);
    expect(readFile).toHaveBeenCalledWith("/tmp/fake-input.png");
    expect(deps.providers.fal.edit as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });

  it("D5: routes image_variations to imageVariations", async () => {
    const readFile = vi.fn(async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const deps = makeDeps();
    const outcome = await handleImageToolCall(
      { ...deps, readFile },
      {
        agent: "clawdy",
        toolName: "image_variations",
        args: {
          imagePath: "/tmp/fake-input.png",
          n: 2,
        },
      },
    );
    expect(outcome.ok).toBe(true);
    expect(deps.providers.openai.variations as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });

  it("D6: returns invalid_argument for unknown toolName", async () => {
    const deps = makeDeps();
    const outcome = await handleImageToolCall(deps, {
      agent: "clawdy",
      toolName: "image_explode" as unknown as IpcImageToolCallParams["toolName"],
      args: {},
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("invalid_argument");
      expect(outcome.error.message).toMatch(/unknown image tool/i);
      expect(outcome.error.message).toContain("image_explode");
    }
  });

  it("D7: never throws — mock provider rejection → internal error envelope", async () => {
    const failingProvider: ImageProvider = {
      generate: vi.fn(async () => {
        throw new TypeError("boom");
      }),
      edit: vi.fn(),
      variations: vi.fn(),
    };
    const deps = makeDeps({
      providers: {
        openai: failingProvider,
        minimax: makeProvider(),
        fal: makeProvider(),
      },
    });
    const outcome = await handleImageToolCall(deps, {
      agent: "clawdy",
      toolName: "image_generate",
      args: { prompt: "a cat" },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      // imageGenerate's try/catch maps unexpected rejections to "internal"
      expect(outcome.error.type).toBe("internal");
      expect(outcome.error.message).toMatch(/boom/);
    }
  });

  it("D8: agentWorkspace passed to handler matches resolvedAgent.workspace (per-agent isolation)", async () => {
    const deps = makeDeps({
      resolvedAgents: [
        makeAgent("clawdy", "/workspaces/clawdy"),
        makeAgent("rubi", "/workspaces/rubi"),
      ],
    });
    await handleImageToolCall(deps, {
      agent: "rubi",
      toolName: "image_generate",
      args: { prompt: "a cat" },
    });
    const firstCall = (deps.writeImage as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string, Buffer, string];
    expect(firstCall[0]).toBe("/workspaces/rubi");
  });

  it("D9: usageTrackerLookup returning undefined → recordCost is a no-op", async () => {
    const usageTrackerLookup = vi.fn(() => undefined);
    const deps = makeDeps({ usageTrackerLookup });
    const outcome = await handleImageToolCall(deps, {
      agent: "clawdy",
      toolName: "image_generate",
      args: { prompt: "a cat" },
    });
    // The handler should complete successfully (tool returns ok=true) and
    // the tracker lookup was consulted but found nothing. No crash.
    expect(outcome.ok).toBe(true);
    expect(usageTrackerLookup).toHaveBeenCalledWith("clawdy");
  });

  it("D10: usageTrackerLookup returning a tracker → record is called with UsageEvent", async () => {
    const record = vi.fn();
    const fakeTracker = { record } as unknown as UsageTracker;
    const usageTrackerLookup = vi.fn(() => fakeTracker);
    const deps = makeDeps({ usageTrackerLookup });
    const outcome = await handleImageToolCall(deps, {
      agent: "clawdy",
      toolName: "image_generate",
      args: { prompt: "a cat" },
    });
    expect(outcome.ok).toBe(true);
    expect(usageTrackerLookup).toHaveBeenCalledWith("clawdy");
    expect(record).toHaveBeenCalledTimes(1);
    const event = record.mock.calls[0][0];
    // recordImageUsage composes `${backend}:${model}` — this is the
    // fingerprint that proves the handler routed through the pure
    // handler and the costs bridge.
    expect(event.model).toBe("openai:gpt-image-1");
    expect(event.category).toBe("image");
    expect(event.agent).toBe("clawdy");
  });
});
