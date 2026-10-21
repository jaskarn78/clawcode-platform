/**
 * Phase 140 Stage 2 (Plan 03) — Unix-socket NDJSON transport.
 *
 * Exercises the real daemon↔channel-server wire over a Unix domain socket in a
 * tmp dir — no PTY, no real `claude`, no MCP. Proves the round-trip both ways,
 * partial-line reassembly, and the reconnect-on-close failure mode.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer, type Socket } from "node:net";

// 999.83-01 (FIX-D): the dispatch-debug instrumentation logs via the module's
// `logger.child(...)` instance, which has no injection seam. vi.mock is hoisted
// above the module import, so the module under test binds these spies at import
// time. Existing tests don't assert on logs — a stub logger is transparent to
// them. The spies let the dispatch-debug tests observe `log.info` calls.
const logSpies = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../../shared/logger.js", () => ({
  logger: { child: () => logSpies },
}));

import {
  createDaemonChannelListener,
  createDaemonHookListener,
  connectChannelServerClient,
  defaultSocketPath,
  defaultHookSocketPath,
  parseDaemonChannelMessage,
  parseRelayedToolCall,
  parseProgressFrame,
  sendProgressFrame,
  sendTurnCompleteFrame,
  type DaemonSocketListener,
  type DaemonHookListener,
  type ChannelServerSocketClient,
  type RelayedToolCall,
  type ProgressFrame,
  type TurnCompleteFrame,
} from "../unix-socket-transport.js";
import type { DaemonChannelMessage } from "../clawcode-channel-server.js";

const HOME = process.env.HOME ?? "";

describe("unix-socket transport", () => {
  let tmpDir: string;
  let socketPath: string;
  let listener: DaemonSocketListener | null = null;
  let client: ChannelServerSocketClient | null = null;

  async function setup(): Promise<void> {
    tmpDir = await mkdtemp(join(tmpdir(), "chan-sock-"));
    socketPath = join(tmpDir, "daemon.sock");
  }

  afterEach(async () => {
    client?.close();
    client = null;
    if (listener) {
      await listener.close();
      listener = null;
    }
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  /** Wait until a predicate holds or the deadline elapses. */
  async function waitFor(
    pred: () => boolean,
    timeoutMs = 2_000,
  ): Promise<void> {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it("rounds a DaemonChannelMessage daemon → server (deep-equal)", async () => {
    await setup();
    const received: DaemonChannelMessage[] = [];

    listener = createDaemonChannelListener("personal", {
      socketPath,
      onToolCall: () => {},
    });
    client = connectChannelServerClient(socketPath, {
      onDaemonMessage: (m) => received.push(m),
    });

    await waitFor(() => listener!.isConnected());

    const msg: DaemonChannelMessage = {
      type: "a2a",
      message_id: "msg_xyz",
      content: "hello over the wire",
      meta: {
        source_agent: "research",
        priority: "high",
        reply_correlation_id: "req_abc",
      },
    };
    listener.send(msg);

    await waitFor(() => received.length === 1);
    expect(received[0]).toEqual(msg);
  });

  it("relays a clawcode_ack server → daemon", async () => {
    await setup();
    const calls: RelayedToolCall[] = [];

    listener = createDaemonChannelListener("personal", {
      socketPath,
      onToolCall: (c) => calls.push(c),
    });
    client = connectChannelServerClient(socketPath, {
      onDaemonMessage: () => {},
    });

    await waitFor(() => client!.isConnected() && listener!.isConnected());

    const ack: RelayedToolCall = {
      tool: "clawcode_ack",
      input: { message_id: "msg_xyz", status: "processed", result: "done" },
    };
    client.relayToolCall(ack);

    await waitFor(() => calls.length === 1);
    expect(calls[0]).toEqual(ack);
  });

  it("reassembles a message split across two socket writes (partial-line buffer)", async () => {
    await setup();
    const received: DaemonChannelMessage[] = [];

    listener = createDaemonChannelListener("personal", {
      socketPath,
      onToolCall: () => {},
    });
    client = connectChannelServerClient(socketPath, {
      onDaemonMessage: (m) => received.push(m),
    });
    await waitFor(() => listener!.isConnected());

    const msg: DaemonChannelMessage = {
      type: "cron",
      message_id: "msg_split",
      content: "a payload long enough to bother splitting in the middle",
    };
    const line = JSON.stringify(msg) + "\n";
    const mid = Math.floor(line.length / 2);

    // Reach into the daemon's active socket by opening a manual peer is hard;
    // instead drive the daemon's send path twice by writing raw halves through
    // a second client socket connected to the SAME listener is not allowed
    // (one-connection rule). So assert the buffer logic at the parse seam
    // directly AND prove an end-to-end split via the daemon's raw write.
    // The daemon `send()` writes one whole line; to simulate fragmentation we
    // write the two halves on the underlying socket the client is reading.
    // We do that by connecting a raw probe to a SEPARATE throwaway listener.
    await assertSplitReassembly(line, mid);

    // Also prove the live client reassembles a normal whole-line send.
    listener.send(msg);
    await waitFor(() => received.length === 1);
    expect(received[0]).toEqual(msg);
  });

  it("schedules a reconnect when the socket closes", async () => {
    await setup();
    listener = createDaemonChannelListener("personal", {
      socketPath,
      onToolCall: () => {},
    });
    client = connectChannelServerClient(socketPath, {
      onDaemonMessage: () => {},
      reconnectIntervalMs: 50,
    });
    await waitFor(() => client!.isConnected());

    // Drop the daemon → the client's socket closes → reconnect scheduled.
    await listener.close();
    listener = null;

    await waitFor(() => client!.isReconnectScheduled());
    expect(client.isReconnectScheduled()).toBe(true);
  });
});

/**
 * Prove partial-line reassembly end-to-end: stand up a throwaway echo listener,
 * connect the channel client, then write the serialized line in two raw halves
 * directly onto the wire. The client must surface exactly one parsed object.
 */
async function assertSplitReassembly(line: string, mid: number): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "chan-split-"));
  const sp = join(dir, "split.sock");
  let serverSock: Socket | null = null;
  const received: DaemonChannelMessage[] = [];

  const srv = createServer((sock) => {
    serverSock = sock;
  });
  await new Promise<void>((res) => srv.listen(sp, () => res()));

  const c = connectChannelServerClient(sp, {
    onDaemonMessage: (m) => received.push(m),
  });

  try {
    // Wait for the server to accept the client connection.
    const start = Date.now();
    while (!serverSock) {
      if (Date.now() - start > 2_000) throw new Error("no server socket");
      await new Promise((r) => setTimeout(r, 10));
    }

    (serverSock as Socket).write(line.slice(0, mid));
    await new Promise((r) => setTimeout(r, 30));
    expect(received).toHaveLength(0); // partial — nothing parsed yet
    (serverSock as Socket).write(line.slice(mid));

    const t0 = Date.now();
    while (received.length < 1) {
      if (Date.now() - t0 > 2_000) throw new Error("split never reassembled");
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(received[0]?.message_id).toBe("msg_split");
  } finally {
    c.close();
    (serverSock as Socket | null)?.destroy();
    await new Promise<void>((res) => srv.close(() => res()));
    await rm(dir, { recursive: true, force: true });
  }
}

describe("defaultSocketPath", () => {
  it("derives the per-agent socket under ~/.clawcode/channels-state", () => {
    const p = defaultSocketPath("personal");
    expect(p).toBe(
      join(HOME, ".clawcode", "channels-state", "personal", "daemon.sock"),
    );
  });
});

describe("progress frame transport (999.82 streaming)", () => {
  let tmpDir: string;
  let hookSocketPath: string;
  let hookListener: DaemonHookListener | null = null;

  async function setup(): Promise<void> {
    tmpDir = await mkdtemp(join(tmpdir(), "chan-prog-"));
    hookSocketPath = join(tmpDir, "hook.sock");
  }

  afterEach(async () => {
    if (hookListener) {
      await hookListener.close();
      hookListener = null;
    }
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  async function waitFor(
    pred: () => boolean,
    timeoutMs = 2_000,
  ): Promise<void> {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it("parseProgressFrame round-trips a well-formed frame (session_id optional)", () => {
    const withSession = parseProgressFrame({
      type: "progress",
      agent: "personal",
      session_id: "sess-1",
      accumulated_text: "thinking…",
    });
    expect(withSession).toEqual({
      type: "progress",
      agent: "personal",
      session_id: "sess-1",
      accumulated_text: "thinking…",
    });

    const noSession = parseProgressFrame({
      type: "progress",
      agent: "personal",
      accumulated_text: "",
    });
    // Empty accumulated_text is still a structurally-valid frame; the SENDER
    // decides whether to emit (the hook drops empty text — see the hook tests).
    expect(noSession).not.toBeNull();
  });

  it("parseProgressFrame rejects malformed shapes (drop-is-silent)", () => {
    expect(parseProgressFrame(null)).toBeNull();
    expect(parseProgressFrame("nope")).toBeNull();
    expect(parseProgressFrame({ type: "progress" })).toBeNull();
    expect(
      parseProgressFrame({ type: "turn_complete", agent: "x", accumulated_text: "y" }),
    ).toBeNull();
    expect(
      parseProgressFrame({ type: "progress", agent: "", accumulated_text: "y" }),
    ).toBeNull();
    expect(
      parseProgressFrame({ type: "progress", agent: "x", accumulated_text: 42 }),
    ).toBeNull();
  });

  it("sendProgressFrame delivers a frame end-to-end over hook.sock", async () => {
    await setup();
    const progress: ProgressFrame[] = [];

    hookListener = createDaemonHookListener("personal", {
      socketPath: hookSocketPath,
      onTurnComplete: () => {},
      onProgress: (f) => progress.push(f),
    });

    await sendProgressFrame(hookSocketPath, {
      type: "progress",
      agent: "personal",
      session_id: "sess-2",
      accumulated_text: "halfway done",
    });

    await waitFor(() => progress.length === 1);
    expect(progress[0]?.accumulated_text).toBe("halfway done");
    expect(progress[0]?.agent).toBe("personal");
  });

  it("dispatches turn_complete AND progress over ONE socket by frame.type", async () => {
    await setup();
    const progress: ProgressFrame[] = [];
    const complete: TurnCompleteFrame[] = [];

    hookListener = createDaemonHookListener("personal", {
      socketPath: hookSocketPath,
      onTurnComplete: (f) => complete.push(f),
      onProgress: (f) => progress.push(f),
    });

    await sendProgressFrame(hookSocketPath, {
      type: "progress",
      agent: "personal",
      accumulated_text: "step 1",
    });
    await sendTurnCompleteFrame(hookSocketPath, {
      type: "turn_complete",
      agent: "personal",
      last_assistant_message: "all done",
    });

    await waitFor(() => progress.length === 1 && complete.length === 1);
    expect(progress[0]?.accumulated_text).toBe("step 1");
    expect(complete[0]?.last_assistant_message).toBe("all done");
  });

  it("keeps onTurnComplete-only callers working (onProgress optional)", async () => {
    await setup();
    const complete: TurnCompleteFrame[] = [];

    // No onProgress passed — the listener must still construct + route turn_complete.
    hookListener = createDaemonHookListener("personal", {
      socketPath: hookSocketPath,
      onTurnComplete: (f) => complete.push(f),
    });

    await sendTurnCompleteFrame(hookSocketPath, {
      type: "turn_complete",
      agent: "personal",
      last_assistant_message: "legacy path",
    });
    // A progress frame with no onProgress registered is silently dropped — must
    // not throw or wedge the listener.
    await sendProgressFrame(hookSocketPath, {
      type: "progress",
      agent: "personal",
      accumulated_text: "ignored",
    });

    await waitFor(() => complete.length === 1);
    expect(complete[0]?.last_assistant_message).toBe("legacy path");
  });
});

describe("defaultHookSocketPath", () => {
  it("derives the per-agent hook socket under ~/.clawcode/channels-state", () => {
    const p = defaultHookSocketPath("personal");
    expect(p).toBe(
      join(HOME, ".clawcode", "channels-state", "personal", "hook.sock"),
    );
  });
});

describe("dispatch-debug instrumentation (999.83-01 FIX-D)", () => {
  let tmpDir: string;
  let socketPath: string;
  let hookSocketPath: string;
  let listener: DaemonSocketListener | null = null;
  let client: ChannelServerSocketClient | null = null;
  let hookListener: DaemonHookListener | null = null;
  const ENV_KEY = "CLAWCODE_DEBUG_CHANNEL_DISPATCH";
  let savedFlag: string | undefined;

  beforeEach(() => {
    // Save + clear so each test sets the flag deterministically (no leak).
    savedFlag = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
    logSpies.info.mockClear();
    logSpies.warn.mockClear();
    logSpies.debug.mockClear();
    logSpies.error.mockClear();
  });

  afterEach(async () => {
    // Restore the flag exactly (undefined → delete, else assign).
    if (savedFlag === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedFlag;

    client?.close();
    client = null;
    if (listener) {
      await listener.close();
      listener = null;
    }
    if (hookListener) {
      await hookListener.close();
      hookListener = null;
    }
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  async function waitFor(
    pred: () => boolean,
    timeoutMs = 2_000,
  ): Promise<void> {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** All info-log calls tagged with a channel-dispatch-debug message. */
  function dispatchDebugCalls(): Array<{ fields: Record<string, unknown>; msg: string }> {
    return logSpies.info.mock.calls
      .filter(
        (c) =>
          typeof c[1] === "string" &&
          (c[1] as string).startsWith("channel-dispatch-debug"),
      )
      .map((c) => ({ fields: c[0] as Record<string, unknown>, msg: c[1] as string }));
  }

  it("dispatch-debug OFF by default — send() emits no debug log", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "chan-dbg-off-"));
    socketPath = join(tmpDir, "daemon.sock");

    listener = createDaemonChannelListener("personal", {
      socketPath,
      onToolCall: () => {},
    });
    client = connectChannelServerClient(socketPath, { onDaemonMessage: () => {} });
    await waitFor(() => listener!.isConnected());

    listener.send({ type: "a2a", message_id: "m-off", content: "secret body" });

    // Give the write a tick; assert zero dispatch-debug logs.
    await new Promise((r) => setTimeout(r, 30));
    expect(dispatchDebugCalls()).toHaveLength(0);
  });

  it("dispatch-debug ON under flag — push-sent log carries timing/identity only", async () => {
    process.env[ENV_KEY] = "1";
    tmpDir = await mkdtemp(join(tmpdir(), "chan-dbg-on-"));
    socketPath = join(tmpDir, "daemon.sock");

    listener = createDaemonChannelListener("research", {
      socketPath,
      onToolCall: () => {},
    });
    client = connectChannelServerClient(socketPath, { onDaemonMessage: () => {} });
    await waitFor(() => listener!.isConnected());

    listener.send({
      type: "a2a",
      message_id: "m-on",
      content: "this body must never be logged",
    });

    await waitFor(
      () => dispatchDebugCalls().some((c) => c.msg.includes("push-sent")),
    );
    const sent = dispatchDebugCalls().filter((c) => c.msg.includes("push-sent"));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.fields).toMatchObject({
      agent: "research",
      message_id: "m-on",
      type: "a2a",
    });
    expect(typeof sent[0]!.fields.ts).toBe("number");
  });

  it("no body leak — push-sent log omits content/message/result/body keys", async () => {
    process.env[ENV_KEY] = "1";
    tmpDir = await mkdtemp(join(tmpdir(), "chan-dbg-leak-"));
    socketPath = join(tmpDir, "daemon.sock");

    listener = createDaemonChannelListener("personal", {
      socketPath,
      onToolCall: () => {},
    });
    client = connectChannelServerClient(socketPath, { onDaemonMessage: () => {} });
    await waitFor(() => listener!.isConnected());

    listener.send({
      type: "a2a",
      message_id: "m-leak",
      content: "TOP SECRET PAYLOAD",
      meta: { reply_correlation_id: "r-1" },
    });

    await waitFor(
      () => dispatchDebugCalls().some((c) => c.msg.includes("push-sent")),
    );
    const sent = dispatchDebugCalls().find((c) => c.msg.includes("push-sent"))!;
    const keys = Object.keys(sent.fields);
    expect(keys).not.toContain("content");
    expect(keys).not.toContain("message");
    expect(keys).not.toContain("result");
    expect(keys).not.toContain("body");
    expect(keys).not.toContain("meta");
  });

  it("hook frame logged under flag — turn_complete + progress emit hook-frame-recv (no body)", async () => {
    process.env[ENV_KEY] = "1";
    tmpDir = await mkdtemp(join(tmpdir(), "chan-dbg-hook-"));
    hookSocketPath = join(tmpDir, "hook.sock");

    hookListener = createDaemonHookListener("personal", {
      socketPath: hookSocketPath,
      onTurnComplete: () => {},
      onProgress: () => {},
    });

    await sendTurnCompleteFrame(hookSocketPath, {
      type: "turn_complete",
      agent: "personal",
      last_assistant_message: "secret turn output",
    });
    await sendProgressFrame(hookSocketPath, {
      type: "progress",
      agent: "personal",
      accumulated_text: "secret progress text",
    });

    await waitFor(() => {
      const recv = dispatchDebugCalls().filter((c) =>
        c.msg.includes("hook-frame-recv"),
      );
      return recv.length >= 2;
    });

    const recv = dispatchDebugCalls().filter((c) =>
      c.msg.includes("hook-frame-recv"),
    );
    const frameTypes = recv.map((c) => c.fields.frameType);
    expect(frameTypes).toContain("turn_complete");
    expect(frameTypes).toContain("progress");
    for (const c of recv) {
      expect(c.fields).toMatchObject({ agent: "personal" });
      expect(typeof c.fields.ts).toBe("number");
      const keys = Object.keys(c.fields);
      expect(keys).not.toContain("last_assistant_message");
      expect(keys).not.toContain("accumulated_text");
      expect(keys).not.toContain("content");
      expect(keys).not.toContain("body");
    }
  });

  it("no-peer drop path is unchanged — debug log, no dispatch-debug info", async () => {
    process.env[ENV_KEY] = "1";
    tmpDir = await mkdtemp(join(tmpdir(), "chan-dbg-nopeer-"));
    socketPath = join(tmpDir, "daemon.sock");

    listener = createDaemonChannelListener("personal", {
      socketPath,
      onToolCall: () => {},
    });
    // No client connected → send drops with a debug log, no push-sent.
    listener.send({ type: "a2a", message_id: "m-drop", content: "x" });

    await new Promise((r) => setTimeout(r, 30));
    expect(
      dispatchDebugCalls().some((c) => c.msg.includes("push-sent")),
    ).toBe(false);
    expect(logSpies.debug).toHaveBeenCalled();
  });
});

describe("shape validation (drop-is-silent)", () => {
  it("parseDaemonChannelMessage accepts a well-formed message", () => {
    expect(
      parseDaemonChannelMessage({
        type: "a2a",
        message_id: "m1",
        content: "x",
      }),
    ).not.toBeNull();
  });

  it("parseDaemonChannelMessage rejects malformed shapes", () => {
    expect(parseDaemonChannelMessage(null)).toBeNull();
    expect(parseDaemonChannelMessage("nope")).toBeNull();
    expect(parseDaemonChannelMessage({ type: "a2a" })).toBeNull();
    expect(
      parseDaemonChannelMessage({ type: 1, message_id: "m", content: "c" }),
    ).toBeNull();
    expect(
      parseDaemonChannelMessage({
        type: "a2a",
        message_id: "m",
        content: "c",
        meta: "bad",
      }),
    ).toBeNull();
  });

  it("parseRelayedToolCall accepts the three tools and rejects others", () => {
    expect(
      parseRelayedToolCall({
        tool: "clawcode_ack",
        input: { message_id: "m", status: "processed" },
      }),
    ).not.toBeNull();
    expect(
      parseRelayedToolCall({ tool: "clawcode_inbox_read", input: {} }),
    ).not.toBeNull();
    expect(
      parseRelayedToolCall({
        tool: "clawcode_status",
        input: { state: "idle" },
      }),
    ).not.toBeNull();

    expect(parseRelayedToolCall({ tool: "unknown", input: {} })).toBeNull();
    expect(parseRelayedToolCall({ tool: "clawcode_ack" })).toBeNull();
    expect(
      parseRelayedToolCall({ tool: "clawcode_ack", input: { status: "x" } }),
    ).toBeNull();
    expect(parseRelayedToolCall(42)).toBeNull();
  });
});
