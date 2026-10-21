/**
 * Phase 137 Plan 05 T-02 — CodexQuery error-injection tests.
 *
 * Asserts that when the spawned codex child emits a `HTTP <status>`
 * line on stderr (with optional JSON body) and then exits non-zero,
 * the CodexQuery iterator yields a synthetic Anthropic-shaped error
 * event AND the `phase137-codex-error-mapped` telemetry log fires
 * with the typed internal class name + status.
 *
 * All four documented HTTP error codes are exercised end-to-end
 * (401, 429, 500, 503) PLUS the rate_limit / billing 429 subtype
 * discriminator.
 *
 * NO real codex binary; NO real network — spawnFn is a vitest spy
 * returning a fake child whose stderr is a `Readable` we push into
 * directly.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";

import { CodexQuery, type CodexQueryDeps } from "../codex-query.js";

interface FakeChildController {
  child: EventEmitter & {
    stdin: { write: ReturnType<typeof vi.fn>; destroyed: boolean };
    stdout: Readable;
    stderr: Readable;
    kill: ReturnType<typeof vi.fn>;
  };
  emitStderr: (chunk: string) => void;
  emitExit: (code: number) => void;
}

function makeFakeChild(): FakeChildController {
  const stdinSink = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  const stdinWrite = vi.fn((chunk: string) => {
    stdinSink.write(chunk);
    return true;
  });
  const stdoutStream = new Readable({ read() {} });
  stdoutStream.setEncoding("utf8");
  const stderrStream = new Readable({ read() {} });

  const child = Object.assign(new EventEmitter(), {
    stdin: { write: stdinWrite, destroyed: false },
    stdout: stdoutStream,
    stderr: stderrStream,
    kill: vi.fn(),
  });

  return {
    child: child as unknown as FakeChildController["child"],
    emitStderr: (chunk: string) => {
      stderrStream.push(chunk);
    },
    emitExit: (code: number) => {
      setImmediate(() => {
        setImmediate(() => {
          (child as unknown as EventEmitter).emit("exit", code);
        });
      });
    },
  };
}

function makeSpawnFn(controller: FakeChildController) {
  return vi.fn(() => {
    return controller.child as unknown as ReturnType<
      CodexQueryDeps["spawnFn"]
    >;
  }) as unknown as CodexQueryDeps["spawnFn"];
}

function makeLogger() {
  const info = vi.fn<(obj: unknown, msg?: string) => void>();
  const warn = vi.fn<(obj: unknown, msg?: string) => void>();
  return { info, warn };
}

describe("CodexQuery — stderr HTTP error mapping (Plan 05 T-02)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function runWithStderr(
    stderr: string,
  ): Promise<{
    events: unknown[];
    errorLogs: Array<{ obj: unknown; msg?: string }>;
  }> {
    const controller = makeFakeChild();
    const spawnFn = makeSpawnFn(controller);
    const logger = makeLogger();
    const q = new CodexQuery(
      {
        binaryPath: "/usr/local/bin/codex",
        prompt: "hi",
        initialModel: "gpt-5-codex",
        agentName: "test-agent",
      },
      { spawnFn, logger },
    );
    const sdk = q.toSdkQuery();
    controller.emitStderr(stderr);
    controller.emitExit(1);
    const events: unknown[] = [];
    for await (const ev of sdk) events.push(ev);
    const errorLogs = logger.info.mock.calls
      .filter((c) => c[1] === "phase137-codex-error-mapped")
      .map((c) => ({ obj: c[0], msg: c[1] }));
    return { events, errorLogs };
  }

  it("(1) HTTP 401 → AuthenticationError synthetic event + error-mapped log", async () => {
    const { events, errorLogs } = await runWithStderr(
      'HTTP 401\n{"error":{"type":"invalid_api_key"}}',
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
    });
    expect((events[0] as { result: string }).result).toContain(
      "AuthenticationError",
    );
    expect((events[0] as { result: string }).result).toContain("401");

    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0]!.obj).toMatchObject({
      httpStatus: 401,
      internalType: "AuthenticationError",
      codeFromBody: "invalid_api_key",
    });
  });

  it("(2) HTTP 429 + insufficient_quota → RateLimitError; log carries codeFromBody", async () => {
    const { events, errorLogs } = await runWithStderr(
      'HTTP 429\n{"error":{"type":"insufficient_quota"}}',
    );
    expect((events[0] as { result: string }).result).toContain(
      "RateLimitError",
    );
    expect(errorLogs[0]!.obj).toMatchObject({
      httpStatus: 429,
      internalType: "RateLimitError",
      codeFromBody: "insufficient_quota",
    });
  });

  it("(3) HTTP 500 → ProviderServerError", async () => {
    const { events, errorLogs } = await runWithStderr("HTTP 500 internal error");
    expect((events[0] as { result: string }).result).toContain(
      "ProviderServerError",
    );
    expect(errorLogs[0]!.obj).toMatchObject({
      httpStatus: 500,
      internalType: "ProviderServerError",
    });
  });

  it("(4) HTTP 503 → ProviderUnavailableError", async () => {
    const { events, errorLogs } = await runWithStderr("HTTP 503 overloaded");
    expect((events[0] as { result: string }).result).toContain(
      "ProviderUnavailableError",
    );
    expect(errorLogs[0]!.obj).toMatchObject({
      httpStatus: 503,
      internalType: "ProviderUnavailableError",
    });
  });

  it("(5) stderr WITHOUT HTTP pattern → no error-mapped log fires", async () => {
    const controller = makeFakeChild();
    const spawnFn = makeSpawnFn(controller);
    const logger = makeLogger();
    const q = new CodexQuery(
      {
        binaryPath: "/usr/local/bin/codex",
        prompt: "hi",
        initialModel: "gpt-5-codex",
        agentName: "test-agent",
      },
      { spawnFn, logger },
    );
    const sdk = q.toSdkQuery();
    controller.emitStderr("just some debug noise on stderr");
    controller.emitExit(0); // clean exit
    const events: unknown[] = [];
    for await (const ev of sdk) events.push(ev);

    expect(events).toEqual([]); // no synthetic error
    const errorLogs = logger.info.mock.calls.filter(
      (c) => c[1] === "phase137-codex-error-mapped",
    );
    expect(errorLogs).toHaveLength(0);
  });

  it("(6) phase137-codex-interceptor-bypass log fires exactly once with api.openai.com origin", async () => {
    const controller = makeFakeChild();
    const spawnFn = makeSpawnFn(controller);
    const logger = makeLogger();
    new CodexQuery(
      {
        binaryPath: "/usr/local/bin/codex",
        prompt: "hi",
        initialModel: "gpt-5-codex",
        agentName: "trial-agent",
      },
      { spawnFn, logger },
    );
    const bypassLogs = logger.info.mock.calls.filter(
      (c) => c[1] === "phase137-codex-interceptor-bypass",
    );
    expect(bypassLogs).toHaveLength(1);
    expect(bypassLogs[0]![0]).toMatchObject({
      agent: "trial-agent",
      outboundOrigin: "api.openai.com",
    });
  });
});
