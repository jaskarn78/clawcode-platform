/**
 * Phase 140 Plan 07 — v3 channel END-TO-END integration test.
 *
 * Unlike the per-component unit tests (which mock the bridge), this wires the
 * PRODUCTION components together over a REAL Unix domain socket and drives the
 * REAL IPC handlers, proving the full daemon→agent path:
 *
 *   handlePostToAgentIpc / handleAskAgentIpc
 *        │  getBridge → AgentChannelRegistry.get(agent)?.bridge   (production seam)
 *        ▼
 *   AgentChannelBridge.push / awaitReply        (real state machine)
 *        │  ChannelMessageSink → DaemonSocketListener.send
 *        ▼
 *   ~/…/daemon.sock  (REAL unix socket, tmp dir)
 *        ▼
 *   connectChannelServerClient   (the agent-side channel client — what the
 *        │                        in-agent clawcode-channel MCP server uses)
 *        ▼
 *   onDaemonMessage → (simulated agent) relays clawcode_ack back over the wire
 *
 * The only thing NOT real here is the `claude --channels` subprocess + its LLM
 * turn: the "agent" is simulated by a socket client that receives the pushed
 * message and (for ask-agent) relays a `clawcode_ack`. That subprocess +
 * agent-prompt behavior is the operator-observed canary; everything ELSE on the
 * path is the production component, exercised for real.
 */

import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";

import { AgentChannelRegistry } from "../agent-channel-registry.js";
import {
  connectChannelServerClient,
  type ChannelServerSocketClient,
} from "../../channels/unix-socket-transport.js";
import type { DaemonChannelMessage } from "../../channels/clawcode-channel-server.js";
import {
  handlePostToAgentIpc,
  type PostToAgentDeps,
} from "../daemon-post-to-agent-ipc.js";
import {
  handleAskAgentIpc,
  buildAskAgentDeps,
} from "../daemon-ask-agent-ipc.js";

const V3_CONFIG = {
  name: "v3-agent",
  llmRuntime: { backend: "claude-code-interactive" as const },
};

describe("v3 channel end-to-end (real socket + real handlers)", () => {
  let tmpDir: string;
  let socketPath: string;
  let registry: AgentChannelRegistry | null = null;
  let client: ChannelServerSocketClient | null = null;

  async function setup(): Promise<void> {
    tmpDir = await mkdtemp(join(tmpdir(), "v3-e2e-"));
    socketPath = join(tmpDir, "daemon.sock");
    registry = new AgentChannelRegistry();
    registry.wireForConfig(V3_CONFIG, { socketPath });
  }

  afterEach(async () => {
    client?.close();
    client = null;
    if (registry) {
      await registry.closeAll();
      registry = null;
    }
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  async function waitFor(pred: () => boolean, timeoutMs = 2_000): Promise<void> {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** PostToAgentDeps wired to the live registry + stubbed v2 cascade. */
  function postDeps(sendAsAgent: () => void): PostToAgentDeps {
    return {
      runningAgents: ["v3-agent"],
      configs: [{ name: "v3-agent", memoryPath: tmpDir }],
      agentChannels: new Map([["v3-agent", ["chan"]]]),
      webhookManager: { hasWebhook: () => true, sendAsAgent: async () => void sendAsAgent() },
      writeInbox: async () => ({ messageId: "e2e-post-1" }),
      log: { info: () => {}, warn: () => {}, error: () => {} },
      // The PRODUCTION seam: resolve the live bridge from the registry.
      getBridge: (agent) => registry!.get(agent)?.bridge,
    };
  }

  it("post_to_agent → bridge.push → agent receives the a2a over the real socket", async () => {
    await setup();
    const received: DaemonChannelMessage[] = [];
    client = connectChannelServerClient(socketPath, {
      onDaemonMessage: (m) => received.push(m),
    });
    await waitFor(() => registry!.get("v3-agent")!.listener.isConnected());

    let webhookCalls = 0;
    const res = await handlePostToAgentIpc(
      { from: "admin", to: "v3-agent", message: "hello v3" },
      postDeps(() => {
        webhookCalls += 1;
      }),
    );

    expect(res).toEqual({ ok: true, delivered: true, messageId: "e2e-post-1" });
    await waitFor(() => received.length === 1);
    expect(received[0]).toMatchObject({
      type: "a2a",
      message_id: "e2e-post-1",
      content: "hello v3",
      meta: { source_agent: "admin" },
    });
    // v2 webhook cascade bypassed for the v3 target.
    expect(webhookCalls).toBe(0);
  });

  it("ask_agent → push → agent acks with result → handler returns the response", async () => {
    await setup();
    // Simulated agent: on receiving an a2a carrying a reply correlation, relay a
    // clawcode_ack with a result — exactly what the real agent's MCP server does
    // when it finishes the prompted work.
    client = connectChannelServerClient(socketPath, {
      onDaemonMessage: (m) => {
        if (m.type === "a2a" && m.meta?.reply_correlation_id) {
          client!.relayToolCall({
            tool: "clawcode_ack",
            input: { message_id: m.message_id, status: "processed", result: `echo:${m.content}` },
          });
        }
      },
    });
    await waitFor(() => registry!.get("v3-agent")!.listener.isConnected());

    const deps = buildAskAgentDeps({
      runningAgents: ["v3-agent"],
      writeInbox: async () => ({ messageId: "e2e-ask-1" }),
      getBridge: (agent) => registry!.get(agent)?.bridge,
      replyTimeoutMs: 2_000,
    });

    const res = await handleAskAgentIpc(
      { from: "admin", to: "v3-agent", content: "ping" },
      deps,
    );

    expect(res).toEqual({ ok: true, messageId: "e2e-ask-1", response: "echo:ping" });
  });

  it("ask_agent → no ack within deadline → response undefined (degraded, no throw)", async () => {
    await setup();
    // Agent connects but NEVER acks.
    client = connectChannelServerClient(socketPath, { onDaemonMessage: () => {} });
    await waitFor(() => registry!.get("v3-agent")!.listener.isConnected());

    const deps = buildAskAgentDeps({
      runningAgents: ["v3-agent"],
      writeInbox: async () => ({ messageId: "e2e-ask-2" }),
      getBridge: (agent) => registry!.get(agent)?.bridge,
      replyTimeoutMs: 150,
    });

    const res = await handleAskAgentIpc(
      { from: "admin", to: "v3-agent", content: "ping" },
      deps,
    );

    expect(res).toEqual({ ok: true, messageId: "e2e-ask-2" });
    expect(res.response).toBeUndefined();
  });

  it("registry teardown closes the socket (no leak for the next boot)", async () => {
    await setup();
    client = connectChannelServerClient(socketPath, { onDaemonMessage: () => {} });
    await waitFor(() => registry!.get("v3-agent")!.listener.isConnected());

    await registry!.closeAll();
    registry = null; // afterEach won't double-close
    await expect(stat(socketPath)).rejects.toThrow();
  });
});
