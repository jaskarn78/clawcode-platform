/**
 * Phase 137 Plan 03 T-01 — CodexQuery unit tests.
 *
 * Six cases from PLAN T-01 `<behavior>`:
 *   (1) Spawn args include translated tools (mock spawnFn captures argv).
 *   (2) Async iteration yields events parsed from mock stdout
 *       (push OpenAI Chat-Completions JSON lines, assert iteration
 *       produces translated SdkStreamMessage events).
 *   (3) `setPermissionMode("plan")` fires `phase137-codex-noop`
 *       exactly once across two calls with the same mode.
 *   (4) `close()` calls `child.kill("SIGTERM")` (mock spy verified).
 *   (5) `streamInput(stream)` writes newline-terminated JSON to
 *       mocked stdin per element of the AsyncIterable.
 *   (6) `initializationResult()` returns the documented synth shape
 *       (empty commands, vision flag not in typed contract — see file
 *       header researcher_todo #8).
 *
 * spawnFn is a vitest spy returning a fake child shaped to match
 * `ChildProcess` enough for CodexQuery to consume. NO real `codex`
 * binary; NO real `node:child_process.spawn` call.
 *
 * See: src/llm-runtime/backends/codex-query.ts (file header documents
 * the Deviation #1/#2 reconciliation with the plan's `<interfaces>`
 * block).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";

import { CodexQuery, type CodexQueryDeps } from "../codex-query.js";
import type { AnthropicToolBlock } from "../../translation/types.js";
import type { SdkUserMessage } from "../../../manager/sdk-types.js";

// ---------------------------------------------------------------
// Fake child factory — minimally satisfies the surface CodexQuery
// reads (`.stdin.write`, `.stdout.setEncoding/on`, `.kill`, exit/
// error events).
// ---------------------------------------------------------------

interface FakeChildController {
  child: EventEmitter & {
    stdin: { write: ReturnType<typeof vi.fn>; destroyed: boolean };
    stdout: Readable;
    stderr: Readable;
    kill: ReturnType<typeof vi.fn>;
  };
  emitStdout: (chunk: string) => void;
  emitStdoutEnd: () => void;
  emitExit: () => void;
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
  const stdoutStream = new Readable({
    read() {
      /* push-driven */
    },
  });
  // setEncoding is what CodexQuery calls — make sure it works.
  stdoutStream.setEncoding("utf8");

  const stderrStream = new Readable({
    read() {
      /* push-driven */
    },
  });

  const child = Object.assign(new EventEmitter(), {
    stdin: { write: stdinWrite, destroyed: false },
    stdout: stdoutStream,
    stderr: stderrStream,
    kill: vi.fn(),
  });

  return {
    child: child as unknown as FakeChildController["child"],
    emitStdout: (chunk: string) => {
      stdoutStream.push(chunk);
    },
    emitStdoutEnd: () => {
      stdoutStream.push(null);
    },
    emitExit: () => {
      // Wait two macro-task ticks so any prior push() to stdout has
      // a chance to flush as a `data` event before the exit handler
      // pushes the end-of-stream sentinel. node:stream's data events
      // are delivered asynchronously even when push() is sync.
      setImmediate(() => {
        setImmediate(() => {
          (child as unknown as EventEmitter).emit("exit", 0);
        });
      });
    },
  };
}

function makeSpawnFn(controller: FakeChildController) {
  return vi.fn((_cmd: string, _args: readonly string[]) => {
    return controller.child as unknown as ReturnType<
      CodexQueryDeps["spawnFn"]
    >;
  }) as unknown as CodexQueryDeps["spawnFn"];
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    entries(): Array<{ key: string; obj: unknown }> {
      return this.info.mock.calls.map((call) => ({
        obj: call[0],
        key: typeof call[1] === "string" ? call[1] : "",
      }));
    },
  };
}

// ---------------------------------------------------------------
// Tests
// ---------------------------------------------------------------

describe("CodexQuery — spawn + translation boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("(1) spawn args carry the OpenAI-shape tools (Plan 02 boundary exercised)", () => {
    const controller = makeFakeChild();
    const spawnFn = makeSpawnFn(controller);
    const logger = makeLogger();

    const tools: AnthropicToolBlock[] = [
      {
        name: "read_file",
        description: "Read a file",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
    ];

    new CodexQuery(
      {
        binaryPath: "/usr/local/bin/codex",
        prompt: "hello",
        initialModel: "gpt-5-codex",
        agentName: "test-agent",
        tools,
      },
      { spawnFn, logger },
    );

    // spawnFn called exactly once.
    expect((spawnFn as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    const call = (spawnFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe("/usr/local/bin/codex");
    const args = call[1] as string[];
    // Translated tools are JSON-stringified inside the --tools arg.
    const toolsArgIdx = args.indexOf("--tools");
    expect(toolsArgIdx).toBeGreaterThanOrEqual(0);
    const toolsJson = JSON.parse(args[toolsArgIdx + 1] ?? "");
    expect(toolsJson).toEqual([
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      },
    ]);
    // Model arg present.
    expect(args).toContain("--model");
    expect(args).toContain("gpt-5-codex");

    // phase137-codex-spawn fires exactly once.
    const spawnLogs = logger
      .entries()
      .filter((e) => e.key === "phase137-codex-spawn");
    expect(spawnLogs).toHaveLength(1);
    expect(spawnLogs[0]!.obj).toMatchObject({
      agent: "test-agent",
      model: "gpt-5-codex",
      toolCount: 1,
      binaryPath: "/usr/local/bin/codex",
    });
  });

  it("(2) async iteration yields translated events from mock stdout", async () => {
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

    // Phase 137 Plan 05 T-03 — Codex stdout is now SSE-shaped (per
    // OpenAI Chat Completions streaming spec). Feed `data: <chunk>\n`
    // lines + `data: [DONE]` terminator; the new SSE normaliser
    // pipeline translates into an SdkAssistantMessage with the
    // accumulated text.
    controller.emitStdout(
      `data: ${JSON.stringify({
        id: "chatcmpl-test",
        model: "gpt-5-codex",
        choices: [{ delta: { role: "assistant", content: "hello from codex" } }],
      })}\n`,
    );
    controller.emitStdout(
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}\n`,
    );
    controller.emitStdout("data: [DONE]\n");
    // Close stdout so the line pipeline emits its end sentinel, then
    // signal child exit.
    controller.emitStdoutEnd();
    controller.emitExit();

    const events = [];
    for await (const ev of sdk) {
      events.push(ev);
    }

    // Expect exactly one assistant event (accumulated text) + one
    // result event (success terminal). Order: assistant before result.
    expect(events.length).toBe(2);
    expect(events[0]).toMatchObject({
      type: "assistant",
      content: "hello from codex",
    });
    expect(events[1]).toMatchObject({ type: "result", subtype: "success" });
  });

  it("(3) setPermissionMode noop fires phase137-codex-noop exactly once per mode", async () => {
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

    await sdk.setPermissionMode("plan");
    await sdk.setPermissionMode("plan");
    await sdk.setPermissionMode("plan");

    const noopLogs = logger
      .entries()
      .filter((e) => e.key === "phase137-codex-noop");
    const planNoops = noopLogs.filter(
      (e) =>
        typeof e.obj === "object" &&
        e.obj !== null &&
        (e.obj as { mode?: unknown }).mode === "plan",
    );
    expect(planNoops).toHaveLength(1);

    // A different mode value uses a different dedup key.
    await sdk.setPermissionMode("acceptEdits");
    const allPermissionLogs = logger
      .entries()
      .filter(
        (e) =>
          e.key === "phase137-codex-noop" &&
          typeof e.obj === "object" &&
          e.obj !== null &&
          (e.obj as { method?: unknown }).method === "setPermissionMode",
      );
    expect(allPermissionLogs).toHaveLength(2);
  });

  it("(4) close() sends SIGTERM and terminates iteration", async () => {
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
    sdk.close();

    expect(controller.child.kill).toHaveBeenCalledWith("SIGTERM");

    // Iteration ends without yielding any messages (close drained
    // the queue with an end sentinel).
    const events = [];
    for await (const ev of sdk) {
      events.push(ev);
    }
    expect(events).toEqual([]);
  });

  it("(5) streamInput writes newline-terminated JSON per element", async () => {
    const controller = makeFakeChild();
    const spawnFn = makeSpawnFn(controller);
    const logger = makeLogger();

    const q = new CodexQuery(
      {
        binaryPath: "/usr/local/bin/codex",
        prompt: "initial",
        initialModel: "gpt-5-codex",
        agentName: "test-agent",
      },
      { spawnFn, logger },
    );
    const sdk = q.toSdkQuery();

    // Capture the writes that happen AFTER construction (the
    // construction-time prompt also writes — separate test asserts
    // that). Reset the mock's call history.
    const stdinWrite = controller.child.stdin.write as unknown as ReturnType<
      typeof vi.fn
    >;
    stdinWrite.mockClear();

    async function* userMessages(): AsyncIterable<SdkUserMessage> {
      yield { type: "user", content: "follow-up 1" };
      yield { type: "user", content: "follow-up 2" };
    }
    await sdk.streamInput(userMessages());

    // Two messages × one OpenAI frame each = 2 writes.
    expect(stdinWrite).toHaveBeenCalledTimes(2);
    const writes = stdinWrite.mock.calls.map((c) => c[0] as string);
    expect(writes[0]!.endsWith("\n")).toBe(true);
    expect(JSON.parse(writes[0]!.trimEnd())).toEqual({
      role: "user",
      content: "follow-up 1",
    });
    expect(JSON.parse(writes[1]!.trimEnd())).toEqual({
      role: "user",
      content: "follow-up 2",
    });
  });

  it("(6) initializationResult() returns the synthesised mirror", async () => {
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
    const init = await sdk.initializationResult();

    // Documented synth shape — empty commands; no fabricated
    // agents/models. researcher_todo #8 (vision) is NOT part of the
    // typed contract — we surface it as a code comment, not a
    // runtime field, per the SdkQuery typed surface.
    expect(init.commands).toEqual([]);
    expect(init.agents).toBeUndefined();
    expect(init.models).toBeUndefined();
  });

  it("interrupt() sends SIGINT to the spawned child", async () => {
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
    await sdk.interrupt();

    expect(controller.child.kill).toHaveBeenCalledWith("SIGINT");
  });

  it("mcpServerStatus returns [] and emits one phase137-codex-noop", async () => {
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

    expect(await sdk.mcpServerStatus()).toEqual([]);
    expect(await sdk.mcpServerStatus()).toEqual([]);

    // Dedup — exactly one mcpServerStatus noop logged across calls.
    const mcpNoops = logger
      .entries()
      .filter(
        (e) =>
          e.key === "phase137-codex-noop" &&
          typeof e.obj === "object" &&
          e.obj !== null &&
          // The dedup key for mcpServerStatus is the bare method
          // name; the payload is empty.
          Object.keys(e.obj as object).length === 0,
      );
    expect(mcpNoops.length).toBe(1);
  });

  it("malformed stdout SSE chunk emits parse-error log; stream continues", async () => {
    // Phase 137 Plan 05 T-03 — the SSE normaliser logs malformed
    // `data: <chunk>` payloads as phase137-codex-parse-error and
    // SKIPS the chunk; subsequent valid chunks still flow through.
    // Cardinality vs. Plan 03: the old parser pushed a synthetic
    // SdkResultError per malformed line; the new pipeline keeps the
    // stream alive so partial output still surfaces. This matches
    // the streaming-resilience invariant (T-137-05-01).
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

    controller.emitStdout("data: {not json\n");
    controller.emitStdout("data: [DONE]\n");
    controller.emitStdoutEnd();
    controller.emitExit();

    const events = [];
    for await (const ev of sdk) {
      events.push(ev);
    }

    // Parse-error log fired (warn channel, not info).
    const parseLogs = logger.warn.mock.calls.filter(
      (c) => c[1] === "phase137-codex-parse-error",
    );
    expect(parseLogs.length).toBe(1);

    // After [DONE] the success terminal still emits (no content, but
    // the SSE normaliser yields the empty message_start/stop pair which
    // the adapter collapses into a single SdkResultSuccess).
    const resultEvents = events.filter(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        (e as { type?: unknown }).type === "result",
    );
    expect(resultEvents.length).toBe(1);
  });
});
