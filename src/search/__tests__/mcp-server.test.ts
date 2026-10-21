import { describe, it, expect, vi } from "vitest";

import {
  __testOnly_buildHandler,
  __testOnly_buildMcpResponse,
} from "../mcp-server.js";
import type { SearchToolOutcome } from "../types.js";

/**
 * Phase 71 Plan 02 — MCP-server handler + response-builder tests.
 *
 * Exercises the `__testOnly_*` exports against a mocked `sendIpc` so we
 * validate the forward-to-daemon contract without spinning up a real
 * StdioServerTransport. Mirrors src/browser/__tests__/mcp-server.test.ts
 * (Phase 70) where the same pattern is established.
 */

/** Convenience: loosens the mock type for call-arg inspection in tests. */
type IpcMock = ReturnType<typeof vi.fn> & {
  mock: { calls: Array<[string, string, Record<string, unknown>]> };
};

describe("search mcp-server handler (Phase 71 Plan 02)", () => {
  it("M1: forwards web_search call via sendIpc with {agent, toolName, args}", async () => {
    const sendIpc = vi.fn(async () =>
      ({ ok: true as const, data: { results: [], total: 0, provider: "brave", query: "x" } }) satisfies SearchToolOutcome,
    ) as unknown as IpcMock;
    const handler = __testOnly_buildHandler("web_search", {
      sendIpc: sendIpc as unknown as Parameters<typeof __testOnly_buildHandler>[1] extends { sendIpc?: infer S } ? S : never,
      env: { CLAWCODE_AGENT: "clawdy" },
    });
    await handler({ query: "x" });

    expect(sendIpc).toHaveBeenCalledTimes(1);
    const [, method, params] = sendIpc.mock.calls[0];
    expect(method).toBe("search-tool-call");
    expect(params).toEqual({
      agent: "clawdy",
      toolName: "web_search",
      args: { query: "x" },
    });
  });

  it("M2: args.agent overrides env.CLAWCODE_AGENT", async () => {
    const sendIpc = vi.fn(async () =>
      ({ ok: true as const, data: {} }) satisfies SearchToolOutcome,
    ) as unknown as IpcMock;
    const handler = __testOnly_buildHandler("web_search", {
      sendIpc: sendIpc as unknown as Parameters<typeof __testOnly_buildHandler>[1] extends { sendIpc?: infer S } ? S : never,
      env: { CLAWCODE_AGENT: "from-env" },
    });
    await handler({ agent: "from-arg", query: "q" });

    const [, , params] = sendIpc.mock.calls[0];
    expect((params as { agent: string }).agent).toBe("from-arg");
    // `agent` should NOT leak into the inner args payload.
    expect((params as { args: Record<string, unknown> }).args).toEqual({ query: "q" });
  });

  it("M3: neither arg nor env → invalid_argument with isError=true", async () => {
    const sendIpc = vi.fn() as unknown as IpcMock;
    const handler = __testOnly_buildHandler("web_search", {
      sendIpc: sendIpc as unknown as Parameters<typeof __testOnly_buildHandler>[1] extends { sendIpc?: infer S } ? S : never,
      env: {},
    });
    const res = await handler({ query: "q" });

    expect(sendIpc).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.error.type).toBe("invalid_argument");
    expect(parsed.error.message).toMatch(/agent/i);
  });

  it("M4: sendIpc throws → isError=true with {error:{type:'internal', message}}", async () => {
    const sendIpc = vi.fn(async () => {
      throw new Error("socket blew up");
    }) as unknown as IpcMock;
    const handler = __testOnly_buildHandler("web_search", {
      sendIpc: sendIpc as unknown as Parameters<typeof __testOnly_buildHandler>[1] extends { sendIpc?: infer S } ? S : never,
      env: { CLAWCODE_AGENT: "clawdy" },
    });
    const res = await handler({ query: "q" });
    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.error.type).toBe("internal");
    expect(parsed.error.message).toContain("socket blew up");
  });

  it("M5: sendIpc ok=true → content[0].text is JSON.stringify(data), isError undefined", async () => {
    const data = { results: [{ title: "T", url: "u", snippet: "s" }], total: 1, provider: "brave", query: "q" };
    const sendIpc = vi.fn(async () =>
      ({ ok: true as const, data }) satisfies SearchToolOutcome,
    ) as unknown as IpcMock;
    const handler = __testOnly_buildHandler("web_search", {
      sendIpc: sendIpc as unknown as Parameters<typeof __testOnly_buildHandler>[1] extends { sendIpc?: infer S } ? S : never,
      env: { CLAWCODE_AGENT: "clawdy" },
    });
    const res = await handler({ query: "q" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toHaveLength(1);
    expect((res.content[0] as { type: string }).type).toBe("text");
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed).toEqual(data);
  });

  it("M6: sendIpc ok=false → isError=true with {error} wrapper", async () => {
    const sendIpc = vi.fn(async () =>
      ({
        ok: false as const,
        error: { type: "rate_limit", message: "429", retryAfter: 30 },
      }) satisfies SearchToolOutcome,
    ) as unknown as IpcMock;
    const handler = __testOnly_buildHandler("web_search", {
      sendIpc: sendIpc as unknown as Parameters<typeof __testOnly_buildHandler>[1] extends { sendIpc?: infer S } ? S : never,
      env: { CLAWCODE_AGENT: "clawdy" },
    });
    const res = await handler({ query: "q" });
    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed).toEqual({
      error: { type: "rate_limit", message: "429", retryAfter: 30 },
    });
  });
});

describe("__testOnly_buildMcpResponse (response shaper)", () => {
  it("success envelope → single text item, no isError", () => {
    const data = { foo: "bar" };
    const res = __testOnly_buildMcpResponse({ ok: true, data });
    expect(res.isError).toBeUndefined();
    expect(res.content).toHaveLength(1);
    expect((res.content[0] as { type: string; text: string }).type).toBe("text");
    expect(JSON.parse((res.content[0] as { text: string }).text)).toEqual(data);
  });

  it("failure envelope → isError=true with {error} wrapper", () => {
    const error = { type: "network", message: "DNS failed" } as const;
    const res = __testOnly_buildMcpResponse({ ok: false, error });
    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed).toEqual({ error });
  });
});
