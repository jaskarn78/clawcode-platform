import { describe, it, expect, vi } from "vitest";

import {
  __testOnly_buildHandler,
  __testOnly_buildMcpResponse,
} from "../mcp-server.js";
import type { ImageToolOutcome } from "../types.js";

/**
 * Phase 72 Plan 02 — MCP-server handler + response-builder tests.
 *
 * Exercises the `__testOnly_*` exports against a mocked `sendIpc` so we
 * validate the forward-to-daemon contract without spinning up a real
 * StdioServerTransport. Mirrors src/search/__tests__/mcp-server.test.ts
 * (Phase 71) where the same pattern is established.
 */

/** Convenience: loosens the mock type for call-arg inspection in tests. */
type IpcMock = ReturnType<typeof vi.fn> & {
  mock: { calls: Array<[string, string, Record<string, unknown>]> };
};

type SendIpcDep = Parameters<typeof __testOnly_buildHandler>[1] extends {
  sendIpc?: infer S;
}
  ? S
  : never;

function makeSuccessOutcome(): ImageToolOutcome<unknown> {
  return {
    ok: true as const,
    data: {
      images: [
        {
          path: "/tmp/workspaces/clawdy/generated-images/fake.png",
          size: "1024x1024",
          backend: "openai",
          model: "gpt-image-1",
          prompt: "a cat",
          cost_cents: 4,
        },
      ],
      total_cost_cents: 4,
    },
  };
}

describe("image mcp-server handler (Phase 72 Plan 02)", () => {
  it("M1: agent missing (no arg, no env) → invalid_argument with isError=true", async () => {
    const sendIpc = vi.fn() as unknown as IpcMock;
    const handler = __testOnly_buildHandler("image_generate", {
      sendIpc: sendIpc as unknown as SendIpcDep,
      env: {},
    });
    const res = await handler({ prompt: "a cat" });
    expect(sendIpc).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.error.type).toBe("invalid_argument");
    expect(parsed.error.message).toMatch(/agent/i);
  });

  it("M2: env.CLAWCODE_AGENT resolves agent and forwards via sendIpc", async () => {
    const sendIpc = vi.fn(
      async () => makeSuccessOutcome(),
    ) as unknown as IpcMock;
    const handler = __testOnly_buildHandler("image_generate", {
      sendIpc: sendIpc as unknown as SendIpcDep,
      env: { CLAWCODE_AGENT: "clawdy" },
    });
    await handler({ prompt: "a cat" });

    expect(sendIpc).toHaveBeenCalledTimes(1);
    const [, method, params] = sendIpc.mock.calls[0];
    expect(method).toBe("image-tool-call");
    expect(params).toEqual({
      agent: "clawdy",
      toolName: "image_generate",
      args: { prompt: "a cat" },
    });
  });

  it("M3: args.agent overrides env.CLAWCODE_AGENT", async () => {
    const sendIpc = vi.fn(
      async () => makeSuccessOutcome(),
    ) as unknown as IpcMock;
    const handler = __testOnly_buildHandler("image_generate", {
      sendIpc: sendIpc as unknown as SendIpcDep,
      env: { CLAWCODE_AGENT: "clawdy" },
    });
    await handler({ agent: "rubi", prompt: "a cat" });

    const [, , params] = sendIpc.mock.calls[0];
    expect((params as { agent: string }).agent).toBe("rubi");
    // `agent` should NOT leak into the inner args payload.
    expect((params as { args: Record<string, unknown> }).args).toEqual({
      prompt: "a cat",
    });
  });

  it("M4: sendIpc ok=true → content[0].text is JSON.stringify(data), isError undefined", async () => {
    const outcome = makeSuccessOutcome();
    const sendIpc = vi.fn(async () => outcome) as unknown as IpcMock;
    const handler = __testOnly_buildHandler("image_generate", {
      sendIpc: sendIpc as unknown as SendIpcDep,
      env: { CLAWCODE_AGENT: "clawdy" },
    });
    const res = await handler({ prompt: "a cat" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toHaveLength(1);
    expect((res.content[0] as { type: string }).type).toBe("text");
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed).toEqual(outcome.ok ? outcome.data : null);
  });

  it("M5: sendIpc ok=false → isError=true with {error} wrapper", async () => {
    const sendIpc = vi.fn(
      async () =>
        ({
          ok: false as const,
          error: {
            type: "rate_limit",
            message: "OpenAI rate limit",
            backend: "openai",
          },
        }) satisfies ImageToolOutcome<unknown>,
    ) as unknown as IpcMock;
    const handler = __testOnly_buildHandler("image_generate", {
      sendIpc: sendIpc as unknown as SendIpcDep,
      env: { CLAWCODE_AGENT: "clawdy" },
    });
    const res = await handler({ prompt: "a cat" });
    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed).toEqual({
      error: {
        type: "rate_limit",
        message: "OpenAI rate limit",
        backend: "openai",
      },
    });
  });

  it("M6: sendIpc throws → isError=true with {error:{type:'internal', message}}", async () => {
    const sendIpc = vi.fn(async () => {
      throw new Error("socket blew up");
    }) as unknown as IpcMock;
    const handler = __testOnly_buildHandler("image_generate", {
      sendIpc: sendIpc as unknown as SendIpcDep,
      env: { CLAWCODE_AGENT: "clawdy" },
    });
    const res = await handler({ prompt: "a cat" });
    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.error.type).toBe("internal");
    expect(parsed.error.message).toContain("socket blew up");
  });

  it("M7: image_edit forwards toolName='image_edit' to daemon", async () => {
    const sendIpc = vi.fn(
      async () => makeSuccessOutcome(),
    ) as unknown as IpcMock;
    const handler = __testOnly_buildHandler("image_edit", {
      sendIpc: sendIpc as unknown as SendIpcDep,
      env: { CLAWCODE_AGENT: "clawdy" },
    });
    await handler({ imagePath: "/x.png", prompt: "make it blue" });
    const [, method, params] = sendIpc.mock.calls[0];
    expect(method).toBe("image-tool-call");
    expect((params as { toolName: string }).toolName).toBe("image_edit");
  });

  it("M8: image_variations forwards toolName='image_variations' to daemon", async () => {
    const sendIpc = vi.fn(
      async () => makeSuccessOutcome(),
    ) as unknown as IpcMock;
    const handler = __testOnly_buildHandler("image_variations", {
      sendIpc: sendIpc as unknown as SendIpcDep,
      env: { CLAWCODE_AGENT: "clawdy" },
    });
    await handler({ imagePath: "/x.png", n: 2 });
    const [, method, params] = sendIpc.mock.calls[0];
    expect(method).toBe("image-tool-call");
    expect((params as { toolName: string }).toolName).toBe("image_variations");
  });

  it("M9: edit/variations also accept args.agent override", async () => {
    const sendIpc = vi.fn(
      async () => makeSuccessOutcome(),
    ) as unknown as IpcMock;
    const handler = __testOnly_buildHandler("image_edit", {
      sendIpc: sendIpc as unknown as SendIpcDep,
      env: { CLAWCODE_AGENT: "clawdy" },
    });
    await handler({ agent: "rubi", imagePath: "/x.png", prompt: "blue" });
    const [, , params] = sendIpc.mock.calls[0];
    expect((params as { agent: string }).agent).toBe("rubi");
    expect((params as { args: Record<string, unknown> }).args).toEqual({
      imagePath: "/x.png",
      prompt: "blue",
    });
  });
});

describe("__testOnly_buildMcpResponse (response shaper)", () => {
  it("MR1: success envelope → single text item with JSON.stringify(data), no isError", () => {
    const data = { images: [{ path: "/x.png" }], total_cost_cents: 4 };
    const res = __testOnly_buildMcpResponse({ ok: true, data });
    expect(res.isError).toBeUndefined();
    expect(res.content).toHaveLength(1);
    expect((res.content[0] as { type: string; text: string }).type).toBe("text");
    expect(JSON.parse((res.content[0] as { text: string }).text)).toEqual(data);
  });

  it("MR2: failure envelope → isError=true with {error} wrapper", () => {
    const error = {
      type: "rate_limit",
      message: "hit the brakes",
      backend: "openai",
    } as const;
    const res = __testOnly_buildMcpResponse({ ok: false, error });
    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed).toEqual({ error });
  });
});
