/**
 * Phase 69 Plan 03 Task 3 — Daemon-integration tests for the OpenAI endpoint.
 *
 * Focus: ensure the factored `startOpenAiEndpoint` helper honors boot
 * ordering, env overrides, disabled-flag, port-conflict fallback, and
 * graceful-shutdown semantics (Pitfall 10). We do NOT boot the full daemon
 * here — the helper is tested in isolation with mocks for startServer +
 * ApiKeysStore.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  startOpenAiEndpoint,
  type OpenAiEndpointConfig,
  type OpenAiEndpointDeps,
} from "../../openai/endpoint-bootstrap.js";

const SILENT_LOG = pino({ level: "silent" });

function baseConfig(): OpenAiEndpointConfig {
  return {
    enabled: true,
    port: 3101,
    host: "127.0.0.1",
    maxRequestBodyBytes: 1_048_576,
    streamKeepaliveMs: 15_000,
  };
}

/** Build a minimal Deps object with controllable mocks. */
function makeDeps(
  managerDir: string,
  overrides: Partial<OpenAiEndpointDeps> = {},
): {
  deps: OpenAiEndpointDeps;
  order: string[];
  serverCloseMock: ReturnType<typeof vi.fn>;
  apiKeysStoreCloseMock: ReturnType<typeof vi.fn>;
  startServerMock: ReturnType<typeof vi.fn>;
} {
  const order: string[] = [];
  const serverCloseMock = vi.fn(async () => {
    order.push("server.close");
  });
  const apiKeysStoreCloseMock = vi.fn(() => {
    order.push("apiKeysStore.close");
  });

  const startServerMock = vi.fn(
    async (cfg: { port: number; host: string }) => ({
      server: {} as never,
      activeStreams: new Set(),
      address: { port: cfg.port, host: cfg.host },
      close: serverCloseMock,
    }),
  );

  const fakeSessionManager = {
    getMemoryStore: vi.fn(() => undefined),
    getTraceCollector: vi.fn(() => undefined),
    getActiveConversationSessionId: vi.fn(() => undefined),
  } as unknown as OpenAiEndpointDeps["sessionManager"];

  const fakeTurnDispatcher = {
    dispatchStream: vi.fn(),
  } as unknown as OpenAiEndpointDeps["turnDispatcher"];

  const apiKeysStoreFactory = vi.fn((_path: string) => ({
    close: apiKeysStoreCloseMock,
    // Other methods would be used by server.ts, but our startServer mock
    // never actually invokes them — the store is just a handle to pass
    // through.
  })) as unknown as OpenAiEndpointDeps["apiKeysStoreFactory"];

  const deps: OpenAiEndpointDeps = {
    managerDir,
    sessionManager: fakeSessionManager,
    turnDispatcher: fakeTurnDispatcher,
    agentNames: () => ["clawdy"],
    log: SILENT_LOG,
    startServer: startServerMock as unknown as OpenAiEndpointDeps["startServer"],
    apiKeysStoreFactory,
    ...overrides,
  };

  return { deps, order, serverCloseMock, apiKeysStoreCloseMock, startServerMock };
}

describe("startOpenAiEndpoint", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "daemon-openai-"));
    // Clear env vars so tests don't interfere with each other.
    delete process.env.CLAWCODE_OPENAI_PORT;
    delete process.env.CLAWCODE_OPENAI_HOST;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.CLAWCODE_OPENAI_PORT;
    delete process.env.CLAWCODE_OPENAI_HOST;
  });

  it("boot: startOpenAiServer is called with port + host from config", async () => {
    const { deps, startServerMock } = makeDeps(dir);
    const handle = await startOpenAiEndpoint(deps, baseConfig());
    expect(handle.enabled).toBe(true);
    expect(handle.port).toBe(3101);
    expect(handle.host).toBe("127.0.0.1");
    expect(startServerMock).toHaveBeenCalledTimes(1);
    const call = startServerMock.mock.calls[0]?.[0] as { port: number; host: string };
    expect(call.port).toBe(3101);
    expect(call.host).toBe("127.0.0.1");
  });

  it("CLAWCODE_OPENAI_PORT env overrides config port", async () => {
    process.env.CLAWCODE_OPENAI_PORT = "4200";
    const { deps, startServerMock } = makeDeps(dir);
    const handle = await startOpenAiEndpoint(deps, baseConfig());
    expect(handle.port).toBe(4200);
    const call = startServerMock.mock.calls[0]?.[0] as { port: number };
    expect(call.port).toBe(4200);
  });

  it("CLAWCODE_OPENAI_PORT non-integer falls back to config port", async () => {
    process.env.CLAWCODE_OPENAI_PORT = "not-a-number";
    const { deps, startServerMock } = makeDeps(dir);
    await startOpenAiEndpoint(deps, baseConfig());
    const call = startServerMock.mock.calls[0]?.[0] as { port: number };
    expect(call.port).toBe(3101);
  });

  it("CLAWCODE_OPENAI_HOST env overrides config host", async () => {
    process.env.CLAWCODE_OPENAI_HOST = "0.0.0.0";
    const { deps, startServerMock } = makeDeps(dir);
    const handle = await startOpenAiEndpoint(deps, baseConfig());
    expect(handle.host).toBe("0.0.0.0");
    const call = startServerMock.mock.calls[0]?.[0] as { host: string };
    expect(call.host).toBe("0.0.0.0");
  });

  it("config.defaults.openai.enabled === false skips startup (no-op handle)", async () => {
    const { deps, startServerMock, apiKeysStoreCloseMock } = makeDeps(dir);
    const handle = await startOpenAiEndpoint(deps, {
      ...baseConfig(),
      enabled: false,
    });
    expect(handle.enabled).toBe(false);
    expect(startServerMock).not.toHaveBeenCalled();
    // No store was opened either.
    expect(apiKeysStoreCloseMock).not.toHaveBeenCalled();
    // close() is a safe no-op.
    await handle.close();
  });

  it("EADDRINUSE during startup → daemon continues with disabled handle", async () => {
    const { deps, apiKeysStoreCloseMock } = makeDeps(dir, {
      startServer: vi.fn(async () => {
        const err = new Error("listen EADDRINUSE: address already in use") as Error & {
          code: string;
        };
        err.code = "EADDRINUSE";
        throw err;
      }) as unknown as OpenAiEndpointDeps["startServer"],
    });
    const handle = await startOpenAiEndpoint(deps, baseConfig());
    expect(handle.enabled).toBe(false);
    // ApiKeysStore was opened but then closed when listen failed (no leak).
    expect(apiKeysStoreCloseMock).toHaveBeenCalledTimes(1);
    await handle.close();
  });

  it("arbitrary error during startup also degrades gracefully", async () => {
    const { deps } = makeDeps(dir, {
      startServer: vi.fn(async () => {
        throw new Error("some other startup failure");
      }) as unknown as OpenAiEndpointDeps["startServer"],
    });
    const handle = await startOpenAiEndpoint(deps, baseConfig());
    expect(handle.enabled).toBe(false);
  });

  it("shutdown: server.close runs before apiKeysStore.close", async () => {
    const { deps, order } = makeDeps(dir);
    const handle = await startOpenAiEndpoint(deps, baseConfig());
    expect(handle.enabled).toBe(true);
    await handle.close();
    expect(order).toEqual(["server.close", "apiKeysStore.close"]);
  });

  it("shutdown: server.close throwing does not prevent apiKeysStore.close", async () => {
    const { deps, order, serverCloseMock } = makeDeps(dir);
    serverCloseMock.mockImplementationOnce(async () => {
      order.push("server.close");
      throw new Error("server close failed");
    });
    const handle = await startOpenAiEndpoint(deps, baseConfig());
    await handle.close();
    expect(order).toEqual(["server.close", "apiKeysStore.close"]);
  });

  it("handle.apiKeysStore is exposed for IPC/CLI reuse", async () => {
    const { deps } = makeDeps(dir);
    const handle = await startOpenAiEndpoint(deps, baseConfig());
    expect(handle.apiKeysStore).toBeDefined();
  });
});
