/**
 * Phase 140 Plan 07 (#14) — per-agent ClawCode channel wiring (daemon-side).
 *
 * The first PRODUCTION instantiation of `AgentChannelBridge` + the Unix-socket
 * listener. Until this lands, daemon→agent channel delivery (cron/a2a/steer to
 * a v3 agent) is dormant — the transport + bridge were built and proven against
 * a mock in Stage 1.5/Plan 03, but nothing wired them together in the daemon.
 *
 * These tests exercise the wiring end-to-end over a REAL Unix domain socket in
 * a tmp dir (no PTY, no real `claude`, no MCP server) and assert BOTH branches
 * of the backend gate (`feedback_silent_path_bifurcation` — a v2 agent must NOT
 * get a socket; a v3 agent MUST).
 *
 * Scope (#14): push + ack + status. The `clawcode_inbox_read` RETURN path is a
 * documented deferred follow-up — this suite pins that an inbox_read relay does
 * NOT strand pending rows as in-flight (the wrong fix would silently consume the
 * inbox with no delivery channel).
 */

import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";

import {
  AgentChannelRegistry,
  wireAgentChannel,
  type WiredAgentChannel,
} from "../agent-channel-registry.js";
import {
  connectChannelServerClient,
  sendProgressFrame,
  type ChannelServerSocketClient,
  type RelayedToolCall,
} from "../../channels/unix-socket-transport.js";
import type { DaemonChannelMessage } from "../../channels/clawcode-channel-server.js";

describe("agent-channel-registry (Phase 140 #14)", () => {
  let tmpDir: string;
  let socketPath: string;
  let hookSocketPath: string;
  let client: ChannelServerSocketClient | null = null;
  let registry: AgentChannelRegistry | null = null;
  let wired: WiredAgentChannel | null = null;

  async function setup(): Promise<void> {
    tmpDir = await mkdtemp(join(tmpdir(), "chan-reg-"));
    socketPath = join(tmpDir, "daemon.sock");
    hookSocketPath = join(tmpDir, "hook.sock");
  }

  afterEach(async () => {
    client?.close();
    client = null;
    if (registry) {
      await registry.closeAll();
      registry = null;
    }
    if (wired) {
      await wired.listener.close();
      await wired.hookListener.close();
      wired = null;
    }
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  /** Wait until a predicate holds or the deadline elapses. */
  async function waitFor(pred: () => boolean, timeoutMs = 2_000): Promise<void> {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  // ── Backend gate (both branches) ────────────────────────────────────────────

  it("GATE — wires a v3 (claude-code-interactive) agent", async () => {
    await setup();
    registry = new AgentChannelRegistry();
    const w = registry.wireForConfig(
      { name: "test-agent", llmRuntime: { backend: "claude-code-interactive" } },
      { socketPath },
    );
    expect(w).not.toBeNull();
    expect(w!.listener.socketPath).toBe(socketPath);
    expect(registry.has("test-agent")).toBe(true);
    expect(registry.agents()).toEqual(["test-agent"]);
  });

  it("GATE — does NOT wire a v2 (anthropic-agent-sdk) agent; no socket created", async () => {
    await setup();
    registry = new AgentChannelRegistry();
    const w = registry.wireForConfig(
      { name: "v2-agent", llmRuntime: { backend: "anthropic-agent-sdk" } },
      { socketPath },
    );
    expect(w).toBeNull();
    expect(registry.has("v2-agent")).toBe(false);
    expect(registry.agents()).toEqual([]);
    // No listener was constructed → the socket file must not exist.
    await expect(stat(socketPath)).rejects.toThrow();
  });

  it("GATE — agent with no llmRuntime backend is treated as non-v3", async () => {
    await setup();
    registry = new AgentChannelRegistry();
    expect(registry.wireForConfig({ name: "bare" }, { socketPath })).toBeNull();
    expect(registry.has("bare")).toBe(false);
  });

  it("GATE — idempotent: wiring the same v3 agent twice returns the same channel", async () => {
    await setup();
    registry = new AgentChannelRegistry();
    const cfg = {
      name: "test-agent",
      llmRuntime: { backend: "claude-code-interactive" as const },
    };
    const first = registry.wireForConfig(cfg, { socketPath });
    const second = registry.wireForConfig(cfg, { socketPath });
    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  // ── End-to-end routing over a real socket ────────────────────────────────────

  it("ROUTES clawcode_ack server→daemon into bridge.handleAck (+ awaitReply)", async () => {
    await setup();
    wired = wireAgentChannel("test-agent", { socketPath });
    client = connectChannelServerClient(socketPath, { onDaemonMessage: () => {} });
    await waitFor(() => wired!.listener.isConnected() && client!.isConnected());

    // Daemon pushes a tracked message carrying a reply correlation.
    const msg: DaemonChannelMessage = {
      type: "a2a",
      message_id: "msg_1",
      content: "ping",
      meta: { reply_correlation_id: "corr_1" },
    };
    wired.bridge.push(msg);
    const replyPromise = wired.bridge.awaitReply("corr_1", 2_000);

    // Agent relays an ack for it.
    const ack: RelayedToolCall = {
      tool: "clawcode_ack",
      input: { message_id: "msg_1", status: "processed", result: "pong" },
    };
    client.relayToolCall(ack);

    await waitFor(() => wired!.bridge.isAcked("msg_1"));
    expect(wired.bridge.isAcked("msg_1")).toBe(true);
    await expect(replyPromise).resolves.toMatchObject({
      message_id: "msg_1",
      result: "pong",
    });
  });

  it("ROUTES a daemon push daemon→server to the agent", async () => {
    await setup();
    const received: DaemonChannelMessage[] = [];
    wired = wireAgentChannel("test-agent", { socketPath });
    client = connectChannelServerClient(socketPath, {
      onDaemonMessage: (m) => received.push(m),
    });
    await waitFor(() => wired!.listener.isConnected());

    wired.bridge.push({
      type: "cron",
      message_id: "cron_1",
      content: "wake up",
    });
    await waitFor(() => received.length === 1);
    expect(received[0]).toMatchObject({ message_id: "cron_1", content: "wake up" });
  });

  it("ROUTES clawcode_status into bridge.handleStatus", async () => {
    await setup();
    wired = wireAgentChannel("test-agent", { socketPath });
    client = connectChannelServerClient(socketPath, { onDaemonMessage: () => {} });
    await waitFor(() => client!.isConnected());

    client.relayToolCall({
      tool: "clawcode_status",
      input: { state: "idle" },
    });
    await waitFor(() => wired!.bridge.getLastStatus() !== null);
    expect(wired.bridge.getLastStatus()).toMatchObject({ state: "idle" });
  });

  it("DEFERRED — clawcode_inbox_read relay does NOT strand pending inbox rows", async () => {
    await setup();
    wired = wireAgentChannel("test-agent", { socketPath });
    client = connectChannelServerClient(socketPath, { onDaemonMessage: () => {} });
    await waitFor(() => client!.isConnected());

    // Enqueue a batched delivery — it sits pending.
    wired.bridge.enqueueInbox({
      type: "memory",
      message_id: "inbox_1",
      content: "remember this",
    });
    expect(wired.bridge.pendingCount()).toBe(1);

    // Agent relays an inbox_read. The return path is deferred (#14 follow-up),
    // so the wiring must NOT flip the row to in-flight (which would strand it
    // with no delivery channel). Give the relay time to land, then assert the
    // row is still pending and nothing went in-flight.
    client.relayToolCall({ tool: "clawcode_inbox_read", input: { max_count: 10 } });
    await new Promise((r) => setTimeout(r, 100));
    expect(wired.bridge.pendingCount()).toBe(1);
    expect(wired.bridge.inFlightCount()).toBe(0);
  });

  // ── Teardown ─────────────────────────────────────────────────────────────────

  it("closeAll() tears down every wired listener and clears the registry", async () => {
    await setup();
    registry = new AgentChannelRegistry();
    const w = registry.wireForConfig(
      { name: "test-agent", llmRuntime: { backend: "claude-code-interactive" } },
      { socketPath },
    );
    expect(w).not.toBeNull();
    client = connectChannelServerClient(socketPath, { onDaemonMessage: () => {} });
    await waitFor(() => w!.listener.isConnected());

    await registry.closeAll();
    expect(registry.agents()).toEqual([]);
    expect(w!.listener.isConnected()).toBe(false);
    // Socket file removed on close → next boot won't trip EADDRINUSE.
    await expect(stat(socketPath)).rejects.toThrow();
  });

  // ── 999.82-03: per-agent teardown for dynamic subagent bridges ──────────────

  it("unwireForAgent() closes the agent's listener + hookListener and removes the entry", async () => {
    await setup();
    registry = new AgentChannelRegistry();
    const w = registry.wireForConfig(
      { name: "sub-agent", llmRuntime: { backend: "claude-code-interactive" } },
      { socketPath, hookSocketPath },
    );
    expect(w).not.toBeNull();
    client = connectChannelServerClient(socketPath, { onDaemonMessage: () => {} });
    await waitFor(() => w!.listener.isConnected());
    expect(registry.has("sub-agent")).toBe(true);

    await registry.unwireForAgent("sub-agent");

    // Entry gone — a dynamic subagent bridge does NOT live for daemon lifetime.
    expect(registry.has("sub-agent")).toBe(false);
    expect(registry.agents()).toEqual([]);
    // Both listeners closed; both socket files removed (no leak per spawn).
    expect(w!.listener.isConnected()).toBe(false);
    await expect(stat(socketPath)).rejects.toThrow();
    await expect(stat(hookSocketPath)).rejects.toThrow();
  });

  it("unwireForAgent() is idempotent — a second call (or an unknown name) is a no-op", async () => {
    await setup();
    registry = new AgentChannelRegistry();
    registry.wireForConfig(
      { name: "sub-agent", llmRuntime: { backend: "claude-code-interactive" } },
      { socketPath, hookSocketPath },
    );

    await registry.unwireForAgent("sub-agent");
    // Double teardown must not throw.
    await expect(registry.unwireForAgent("sub-agent")).resolves.toBeUndefined();
    // Unknown name is a clean no-op.
    await expect(registry.unwireForAgent("never-wired")).resolves.toBeUndefined();
    expect(registry.has("sub-agent")).toBe(false);
  });

  // ── 999.82: progress-frame routing (hook → bridge.onProgress) ────────────────

  it("ROUTES a progress frame on the hook socket into bridge.onProgress WITHOUT resolving awaitReply", async () => {
    await setup();
    wired = wireAgentChannel("test-agent", { socketPath, hookSocketPath });

    // A pending awaitReply that progress must NEVER resolve (delivery truth
    // stays with ack/turn_complete).
    wired.bridge.push({
      type: "a2a",
      message_id: "msg_p",
      content: "do work",
      meta: { reply_correlation_id: "corr_p" },
    });
    const replyPromise = wired.bridge.awaitReply("corr_p", 5_000);

    const seen: string[] = [];
    wired.bridge.registerProgressCallback((text) => seen.push(text));

    // The progress hook fires (short-lived connect → write one frame → close).
    await sendProgressFrame(hookSocketPath, {
      type: "progress",
      agent: "test-agent",
      session_id: "sess_p",
      accumulated_text: "halfway there",
    });

    await waitFor(() => seen.length === 1);
    expect(seen[0]).toBe("halfway there");

    // The pending reply is STILL pending — progress did not resolve it.
    const settled = await Promise.race([
      replyPromise.then(() => "RESOLVED"),
      new Promise<string>((res) => setTimeout(() => res("PENDING"), 100)),
    ]);
    expect(settled).toBe("PENDING");
  });
});
