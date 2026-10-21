/**
 * Phase 999.58 Plan 02 T02 — unit tests for the refactored
 * haiku-direct.ts policy dispatcher.
 *
 * Six behaviors:
 *   HT1 — routing="bridge" (default) callHaikuDirect → runHaikuViaBridge
 *         with site default "summarizer".
 *   HT2 — callHaikuVision routes to runHaikuViaBridge with site default
 *         "vision-pre-pass" + imageBase64 + mediaType forwarded.
 *   HT3 — routing="direct" lazy-imports @anthropic-ai/sdk and uses
 *         the legacy OAuth bearer-token cached-client path.
 *   HT4 — `__setHaikuRoutingForTests` toggles the in-process policy.
 *   HT5 — back-compat — consumer-style 3-arg / 5-arg invocation works
 *         with site defaults.
 *   HT6 — routing="bridge" → SDK package import is NEVER triggered.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the bridge helper so we can spy on what callHaikuDirect /
// callHaikuVision forward.
const mockRunHaikuViaBridge = vi.fn();
vi.mock("../../bridge/haiku-via-bridge.js", () => ({
  runHaikuViaBridge: mockRunHaikuViaBridge,
}));

// Mock the SDK and fs helpers so the "direct" rollback path can be
// exercised without touching the real network or filesystem.
const { mockSdkMessagesCreate, MockAnthropic } = vi.hoisted(() => {
  const mockSdkMessagesCreate = vi.fn();
  const MockAnthropic = vi.fn(function MockAnthropicImpl(this: unknown, _opts: unknown) {
    return { messages: { create: mockSdkMessagesCreate } };
  });
  return { mockSdkMessagesCreate, MockAnthropic };
});

vi.mock("@anthropic-ai/sdk", () => ({
  default: MockAnthropic,
}));

const mockReadFile = vi.fn();
vi.mock("node:fs/promises", () => ({
  readFile: mockReadFile,
}));

const {
  callHaikuDirect,
  callHaikuVision,
  configureHaikuRouting,
  __setHaikuRoutingForTests,
  _resetClientForTests,
} = await import("../haiku-direct.js");

const VALID_CREDS = JSON.stringify({
  claudeAiOauth: { accessToken: "sk-ant-oauth-token-test", expiresAt: 9999999999 },
});

function textResponse(text: string) {
  return { content: [{ type: "text", text }] };
}

beforeEach(() => {
  mockRunHaikuViaBridge.mockReset();
  mockSdkMessagesCreate.mockReset();
  MockAnthropic.mockClear();
  mockReadFile.mockReset();
  mockReadFile.mockResolvedValue(VALID_CREDS);
  _resetClientForTests();
  // Default policy at start of each test — bridge (matches
  // production default).
  __setHaikuRoutingForTests("bridge");
});

// ----------------------------------------------------------------
// HT1 — callHaikuDirect default route
// ----------------------------------------------------------------

describe("HT1 — callHaikuDirect (routing=bridge default)", () => {
  it("routes to runHaikuViaBridge with site default 'summarizer'", async () => {
    mockRunHaikuViaBridge.mockResolvedValue({
      text: "bridge-text-output",
      durationMs: 42,
      costUsd: 0.0008,
      succeeded: true,
    });

    const result = await callHaikuDirect("sys", "user prompt", {});
    expect(result).toBe("bridge-text-output");

    expect(mockRunHaikuViaBridge).toHaveBeenCalledTimes(1);
    const args = mockRunHaikuViaBridge.mock.calls[0]![0] as {
      site: string;
      systemPrompt: string;
      userPrompt: string;
      model: string;
    };
    expect(args.site).toBe("summarizer");
    expect(args.systemPrompt).toBe("sys");
    expect(args.userPrompt).toBe("user prompt");
    expect(args.model).toBe("haiku");
  });

  it("forwards opts.maxTokens and opts.signal to the bridge", async () => {
    mockRunHaikuViaBridge.mockResolvedValue({
      text: "ok",
      durationMs: 1,
      costUsd: null,
      succeeded: true,
    });
    const controller = new AbortController();
    await callHaikuDirect("sys", "u", { maxTokens: 4096, signal: controller.signal });
    const args = mockRunHaikuViaBridge.mock.calls[0]![0] as {
      maxTokens?: number;
      signal?: AbortSignal;
    };
    expect(args.maxTokens).toBe(4096);
    expect(args.signal).toBe(controller.signal);
  });

  it("returns empty string when bridge call fails (legacy contract)", async () => {
    mockRunHaikuViaBridge.mockResolvedValue({
      text: "should-be-ignored",
      durationMs: 5,
      costUsd: null,
      succeeded: false,
    });
    const result = await callHaikuDirect("s", "u", {});
    expect(result).toBe("");
  });

  it("uses explicit site arg when provided", async () => {
    mockRunHaikuViaBridge.mockResolvedValue({
      text: "x",
      durationMs: 1,
      costUsd: null,
      succeeded: true,
    });
    await callHaikuDirect("s", "u", {}, "dream-pass");
    const args = mockRunHaikuViaBridge.mock.calls[0]![0] as { site: string };
    expect(args.site).toBe("dream-pass");
  });
});

// ----------------------------------------------------------------
// HT2 — callHaikuVision default route
// ----------------------------------------------------------------

describe("HT2 — callHaikuVision (routing=bridge default)", () => {
  it("routes to runHaikuViaBridge with site default 'vision-pre-pass' + base64 + mediaType", async () => {
    mockRunHaikuViaBridge.mockResolvedValue({
      text: "vision-output",
      durationMs: 13,
      costUsd: 0.001,
      succeeded: true,
    });
    const buf = Buffer.from("PNG-bytes-here", "utf-8");
    const expectedBase64 = buf.toString("base64");

    const result = await callHaikuVision("describe", "what is in this chart?", buf, "image/png", {});
    expect(result).toBe("vision-output");

    const args = mockRunHaikuViaBridge.mock.calls[0]![0] as {
      site: string;
      imageBase64?: string;
      mediaType?: string;
      systemPrompt: string;
      userPrompt: string;
    };
    expect(args.site).toBe("vision-pre-pass");
    expect(args.imageBase64).toBe(expectedBase64);
    expect(args.mediaType).toBe("image/png");
    expect(args.systemPrompt).toBe("describe");
    expect(args.userPrompt).toBe("what is in this chart?");
  });
});

describe("HT2b — callHaikuVision never surfaces a failed bridge call (Phase 999.154 WS-0)", () => {
  it("returns empty string when the bridge refuses image input", async () => {
    mockRunHaikuViaBridge.mockResolvedValue({
      text: "",
      durationMs: 0,
      costUsd: null,
      succeeded: false,
    });
    const result = await callHaikuVision("s", "u", Buffer.from("x"), "image/png", {});
    expect(result).toBe("");
  });
});

// ----------------------------------------------------------------
// HT3 — routing=direct uses lazy SDK path
// ----------------------------------------------------------------

describe("HT3 — routing=direct (legacy SDK rollback)", () => {
  it("lazy-imports @anthropic-ai/sdk and calls messages.create with OAuth token", async () => {
    __setHaikuRoutingForTests("direct");
    mockSdkMessagesCreate.mockResolvedValue(textResponse("direct-route-output"));

    const result = await callHaikuDirect("sys", "user", {});
    expect(result).toBe("direct-route-output");

    expect(MockAnthropic).toHaveBeenCalledTimes(1);
    const sdkConstructorArgs = MockAnthropic.mock.calls[0]![0] as {
      apiKey: string | null;
      authToken: string;
    };
    expect(sdkConstructorArgs.apiKey).toBeNull();
    expect(sdkConstructorArgs.authToken).toBe("sk-ant-oauth-token-test");

    expect(mockRunHaikuViaBridge).not.toHaveBeenCalled();
  });

  it("retries on 401 with a fresh client (defense-in-depth)", async () => {
    __setHaikuRoutingForTests("direct");
    const err = new Error("Unauthorized") as Error & { status: number };
    err.status = 401;
    mockSdkMessagesCreate.mockRejectedValueOnce(err);
    mockSdkMessagesCreate.mockResolvedValueOnce(textResponse("after-retry"));

    const result = await callHaikuDirect("s", "u", {});
    expect(result).toBe("after-retry");
    expect(mockSdkMessagesCreate).toHaveBeenCalledTimes(2);
    expect(MockAnthropic).toHaveBeenCalledTimes(2);
  });
});

// ----------------------------------------------------------------
// HT4 — policy toggle
// ----------------------------------------------------------------

describe("HT4 — __setHaikuRoutingForTests toggles policy", () => {
  it("starts at bridge, flips to direct, flips back to bridge", async () => {
    mockRunHaikuViaBridge.mockResolvedValue({
      text: "bridge",
      durationMs: 1,
      costUsd: null,
      succeeded: true,
    });
    mockSdkMessagesCreate.mockResolvedValue(textResponse("direct"));

    expect(await callHaikuDirect("s", "u", {})).toBe("bridge");

    __setHaikuRoutingForTests("direct");
    expect(await callHaikuDirect("s", "u", {})).toBe("direct");

    __setHaikuRoutingForTests("bridge");
    expect(await callHaikuDirect("s", "u", {})).toBe("bridge");

    // bridge called twice (start + flip-back); direct called once.
    expect(mockRunHaikuViaBridge).toHaveBeenCalledTimes(2);
    expect(mockSdkMessagesCreate).toHaveBeenCalledTimes(1);
  });

  it("configureHaikuRouting also toggles the policy (production hook)", async () => {
    mockSdkMessagesCreate.mockResolvedValue(textResponse("via-config"));
    configureHaikuRouting("direct");
    expect(await callHaikuDirect("s", "u", {})).toBe("via-config");

    mockRunHaikuViaBridge.mockResolvedValue({
      text: "via-config-bridge",
      durationMs: 1,
      costUsd: null,
      succeeded: true,
    });
    configureHaikuRouting("bridge");
    expect(await callHaikuDirect("s", "u", {})).toBe("via-config-bridge");
  });
});

// ----------------------------------------------------------------
// HT5 — back-compat consumer signature
// ----------------------------------------------------------------

describe("HT5 — back-compat consumer signature (default site applied)", () => {
  it("callHaikuDirect(s, u, opts) with no site arg uses 'summarizer'", async () => {
    mockRunHaikuViaBridge.mockResolvedValue({
      text: "ok",
      durationMs: 1,
      costUsd: null,
      succeeded: true,
    });
    await callHaikuDirect("s", "u", { maxTokens: 1024 });
    const args = mockRunHaikuViaBridge.mock.calls[0]![0] as { site: string };
    expect(args.site).toBe("summarizer");
  });

  it("callHaikuVision(s, u, buf, mediaType, opts) with no site arg uses 'vision-pre-pass'", async () => {
    mockRunHaikuViaBridge.mockResolvedValue({
      text: "ok",
      durationMs: 1,
      costUsd: null,
      succeeded: true,
    });
    await callHaikuVision("s", "u", Buffer.from("x"), "image/png", { maxTokens: 1024 });
    const args = mockRunHaikuViaBridge.mock.calls[0]![0] as { site: string };
    expect(args.site).toBe("vision-pre-pass");
  });
});

// ----------------------------------------------------------------
// HT6 — bridge route NEVER triggers the lazy SDK import
// ----------------------------------------------------------------

describe("HT6 — routing=bridge never triggers the lazy SDK import", () => {
  it("MockAnthropic constructor is never invoked when routing=bridge", async () => {
    mockRunHaikuViaBridge.mockResolvedValue({
      text: "from-bridge",
      durationMs: 1,
      costUsd: null,
      succeeded: true,
    });
    // 3 calls on the bridge route.
    await callHaikuDirect("s", "u", {});
    await callHaikuDirect("s", "u", {});
    await callHaikuVision("s", "u", Buffer.from("x"), "image/jpeg", {});
    expect(MockAnthropic).not.toHaveBeenCalled();
    expect(mockSdkMessagesCreate).not.toHaveBeenCalled();
  });
});
