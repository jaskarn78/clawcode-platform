/**
 * Phase 999.2 Plan 03 — pure-DI handler tests for the `ask-agent` IPC handler.
 *
 * Mirrors the Phase 103 daemon-rate-limit-ipc.ts blueprint: we extract the
 * case-body of `case "ask-agent":` (in src/manager/daemon.ts) into a small
 * pure-DI module so the v2 sync-reply contract can be tested without spawning
 * the full daemon.
 *
 * Pins all four Plan 03 requirements:
 *   - A2A-09: response surfaced when target running
 *   - A2A-10: mirror_to_target_channel posts pre + post webhook embeds; webhook
 *             failure does NOT abort the ask (Pitfall 7)
 *   - A2A-11: dispatchTurn errors propagate (no silent catch)
 *   - A2A-12: offline target → response undefined, dispatchTurn never called
 *
 * Plus Pitfall-4 reply-threading prefix pin (`> reply to {from}:`) and the
 * inbox-write-first invariant (covers offline path + sync path symmetrically).
 */
import { describe, it, expect, vi } from "vitest";
import {
  handleAskAgentIpc,
  buildAskAgentDeps,
} from "../daemon-ask-agent-ipc.js";

describe("handleAskAgentIpc — Phase 999.2 Plan 03 sync-reply", () => {
  it("surfaces target's response when target is running (A2A-09)", async () => {
    const dispatchTurn = vi.fn().mockResolvedValue("answer from fin-client");
    const writeInbox = vi.fn().mockResolvedValue({ messageId: "msg-1" });
    const deps = buildAskAgentDeps({
      runningAgents: ["fin-client"],
      dispatchTurn,
      writeInbox,
    });
    const result = await handleAskAgentIpc(
      { from: "admin-clawdy", to: "fin-client", content: "what's our LTV?" },
      deps,
    );
    expect(result).toMatchObject({
      ok: true,
      messageId: "msg-1",
      response: "answer from fin-client",
    });
    expect(dispatchTurn).toHaveBeenCalledWith("fin-client", "what's our LTV?");
  });

  it("omits response when target is not running (still ok) (A2A-12)", async () => {
    const dispatchTurn = vi.fn();
    const writeInbox = vi.fn().mockResolvedValue({ messageId: "msg-offline" });
    const deps = buildAskAgentDeps({
      runningAgents: [],
      dispatchTurn,
      writeInbox,
    });
    const result = await handleAskAgentIpc(
      { from: "admin-clawdy", to: "fin-client", content: "ping" },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(result.response).toBeUndefined();
    expect(result.messageId).toBe("msg-offline");
    expect(dispatchTurn).not.toHaveBeenCalled();
  });

  it("propagates dispatch errors (no silent catch) (A2A-11)", async () => {
    const dispatchTurn = vi
      .fn()
      .mockRejectedValue(new Error("MCP server unreachable"));
    const writeInbox = vi.fn().mockResolvedValue({ messageId: "msg-err" });
    const deps = buildAskAgentDeps({
      runningAgents: ["fin"],
      dispatchTurn,
      writeInbox,
    });
    await expect(
      handleAskAgentIpc(
        { from: "admin", to: "fin", content: "x" },
        deps,
      ),
    ).rejects.toThrow("MCP server unreachable");
  });

  it("mirror=true posts prompt embed BEFORE dispatch + response embed AFTER dispatch (A2A-10 + Pitfall 4)", async () => {
    const sendAsAgent = vi.fn().mockResolvedValue(undefined);
    const dispatchTurn = vi.fn().mockResolvedValue("the answer body");
    const writeInbox = vi.fn().mockResolvedValue({ messageId: "msg-mir" });
    const deps = buildAskAgentDeps({
      runningAgents: ["fin"],
      dispatchTurn,
      writeInbox,
      webhookManager: {
        hasWebhook: () => true,
        sendAsAgent,
      },
      configs: [
        { name: "admin", webhook: { displayName: "Admin Clawdy" } },
        { name: "fin", webhook: { displayName: "Finance Bot" } },
      ],
    });
    const result = await handleAskAgentIpc(
      {
        from: "admin",
        to: "fin",
        content: "the prompt body",
        mirror_to_target_channel: true,
      },
      deps,
    );

    expect(result.response).toBe("the answer body");
    expect(sendAsAgent).toHaveBeenCalledTimes(2);

    // First call: prompt embed; description should contain the prompt content.
    const firstCallEmbed = sendAsAgent.mock.calls[0][3];
    const firstDesc = firstCallEmbed.data?.description ?? firstCallEmbed.toJSON?.().description;
    expect(firstDesc).toContain("the prompt body");

    // Second call: response embed; description should contain the response AND
    // the verbatim Pitfall-4 reply-threading prefix `> reply to admin:`.
    const secondCallEmbed = sendAsAgent.mock.calls[1][3];
    const secondDesc = secondCallEmbed.data?.description ?? secondCallEmbed.toJSON?.().description;
    expect(secondDesc).toContain("the answer body");
    expect(secondDesc).toContain("> reply to admin:");

    // Order: pre-mirror < dispatchTurn < post-mirror.
    const preOrder = sendAsAgent.mock.invocationCallOrder[0];
    const dispatchOrder = dispatchTurn.mock.invocationCallOrder[0];
    const postOrder = sendAsAgent.mock.invocationCallOrder[1];
    expect(preOrder).toBeLessThan(dispatchOrder);
    expect(dispatchOrder).toBeLessThan(postOrder);
  });

  it("mirror=true + webhook failure does NOT abort the ask (Pitfall 7)", async () => {
    const sendAsAgent = vi
      .fn()
      .mockRejectedValueOnce(new Error("webhook 500"))
      .mockResolvedValueOnce(undefined);
    const dispatchTurn = vi.fn().mockResolvedValue("answer");
    const writeInbox = vi.fn().mockResolvedValue({ messageId: "msg-wf" });
    const warnSpy = vi.fn();
    const deps = buildAskAgentDeps({
      runningAgents: ["fin"],
      dispatchTurn,
      writeInbox,
      webhookManager: {
        hasWebhook: () => true,
        sendAsAgent,
      },
      configs: [{ name: "fin", webhook: { displayName: "Finance Bot" } }],
      log: {
        info: () => {},
        warn: warnSpy,
        error: () => {},
      } as never,
    });

    const result = await handleAskAgentIpc(
      {
        from: "admin",
        to: "fin",
        content: "hi",
        mirror_to_target_channel: true,
      },
      deps,
    );

    // Despite webhook failure, the ask still returned the response.
    expect(result.ok).toBe(true);
    expect(result.response).toBe("answer");
    // dispatchTurn ran even though pre-mirror webhook threw.
    expect(dispatchTurn).toHaveBeenCalled();
    // Warn-log has the best-effort indicator substring.
    const warnMsgs = warnSpy.mock.calls.map((c) => c[1] ?? c[0]);
    expect(
      warnMsgs.some((m: unknown) =>
        typeof m === "string" && m.includes("[ask-agent] mirror prompt webhook failed"),
      ),
    ).toBe(true);
  });

  it("mirror=true + target has no webhook → mirror skipped, ask still succeeds with response", async () => {
    const sendAsAgent = vi.fn();
    const dispatchTurn = vi.fn().mockResolvedValue("answer");
    const writeInbox = vi.fn().mockResolvedValue({ messageId: "msg-nw" });
    const deps = buildAskAgentDeps({
      runningAgents: ["fin"],
      dispatchTurn,
      writeInbox,
      webhookManager: {
        hasWebhook: () => false,
        sendAsAgent,
      },
    });
    const result = await handleAskAgentIpc(
      {
        from: "admin",
        to: "fin",
        content: "hi",
        mirror_to_target_channel: true,
      },
      deps,
    );
    expect(result.response).toBe("answer");
    expect(sendAsAgent).not.toHaveBeenCalled();
  });

  it("mirror=false (default) → no webhook calls regardless of hasWebhook", async () => {
    const sendAsAgent = vi.fn();
    const dispatchTurn = vi.fn().mockResolvedValue("answer");
    const writeInbox = vi.fn().mockResolvedValue({ messageId: "msg-nf" });
    const deps = buildAskAgentDeps({
      runningAgents: ["fin"],
      dispatchTurn,
      writeInbox,
      webhookManager: {
        hasWebhook: () => true,
        sendAsAgent,
      },
    });
    const result = await handleAskAgentIpc(
      { from: "admin", to: "fin", content: "hi" },
      deps,
    );
    expect(result.response).toBe("answer");
    expect(sendAsAgent).not.toHaveBeenCalled();
  });

  describe("bot-direct fallback (Phase 999.12 IPC-02)", () => {
    it("posts response via bot-direct when target has no webhook (IPC-02)", async () => {
      const sendText = vi.fn(async () => {});
      const dispatchTurn = vi.fn().mockResolvedValue("hello back");
      const writeInbox = vi.fn().mockResolvedValue({ messageId: "msg-bd1" });
      const infoSpy = vi.fn();
      const deps = buildAskAgentDeps({
        runningAgents: ["fin-client"],
        dispatchTurn,
        writeInbox,
        webhookManager: {
          hasWebhook: () => false,
          sendAsAgent: vi.fn(),
        },
        configs: [{ name: "fin-client" }],
        log: {
          info: infoSpy,
          warn: () => {},
          error: () => {},
        } as never,
        botDirectSender: { sendText },
        agentChannels: new Map([["fin-client", ["000000000000000110"]]]),
      });

      const result = await handleAskAgentIpc(
        {
          from: "admin-clawdy",
          to: "fin-client",
          content: "hi",
          mirror_to_target_channel: true,
        },
        deps,
      );

      expect(sendText).toHaveBeenCalledTimes(1);
      expect(sendText).toHaveBeenCalledWith("000000000000000110", "hello back");

      // Log shape matches triggerDeliveryFn — pinned for journalctl grep parity.
      const logCalls = infoSpy.mock.calls;
      const hit = logCalls.find(
        (c) =>
          typeof c[0] === "object" &&
          c[0] !== null &&
          (c[0] as Record<string, unknown>).to === "fin-client" &&
          (c[0] as Record<string, unknown>).channel === "000000000000000110" &&
          (c[0] as Record<string, unknown>).responseLength === 10 &&
          c[1] === "agent response sent to Discord",
      );
      expect(hit).toBeDefined();

      expect(result.ok).toBe(true);
      expect(result.response).toBe("hello back");
      expect(result.messageId).toBe("msg-bd1");
    });

    it("logs warn and continues when no webhook and no bot-direct sender (IPC-02b)", async () => {
      const dispatchTurn = vi.fn().mockResolvedValue("dispatched-response");
      const writeInbox = vi.fn().mockResolvedValue({ messageId: "msg-bd2" });
      const deps = buildAskAgentDeps({
        runningAgents: ["fin-client"],
        dispatchTurn,
        writeInbox,
        webhookManager: {
          hasWebhook: () => false,
          sendAsAgent: vi.fn(),
        },
        // botDirectSender intentionally omitted
      });

      const result = await handleAskAgentIpc(
        {
          from: "admin-clawdy",
          to: "fin-client",
          content: "hi",
          mirror_to_target_channel: true,
        },
        deps,
      );

      // dispatchTurn STILL ran; ask did not throw; response surfaced.
      expect(dispatchTurn).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(true);
      expect(result.response).toBe("dispatched-response");
    });

    it("does NOT call bot-direct when mirror_to_target_channel is false (IPC-03 regression pin)", async () => {
      const sendText = vi.fn();
      const dispatchTurn = vi.fn().mockResolvedValue("hello back");
      const writeInbox = vi.fn().mockResolvedValue({ messageId: "msg-bd3" });
      const infoSpy = vi.fn();
      const deps = buildAskAgentDeps({
        runningAgents: ["fin-client"],
        dispatchTurn,
        writeInbox,
        webhookManager: {
          hasWebhook: () => false,
          sendAsAgent: vi.fn(),
        },
        configs: [{ name: "fin-client" }],
        log: {
          info: infoSpy,
          warn: () => {},
          error: () => {},
        } as never,
        botDirectSender: { sendText },
        agentChannels: new Map([["fin-client", ["000000000000000110"]]]),
      });

      // No mirror flag passed (default false).
      const result = await handleAskAgentIpc(
        { from: "admin-clawdy", to: "fin-client", content: "hi" },
        deps,
      );

      expect(sendText).not.toHaveBeenCalled();
      const sentLog = infoSpy.mock.calls.find(
        (c) => c[1] === "agent response sent to Discord",
      );
      expect(sentLog).toBeUndefined();
      expect(result.response).toBe("hello back");
    });

    it("truncates response > 2000 chars to 2000 with ellipsis (IPC-02 truncation)", async () => {
      const sendText = vi.fn(async () => {});
      const longResponse = "x".repeat(2500);
      const dispatchTurn = vi.fn().mockResolvedValue(longResponse);
      const writeInbox = vi.fn().mockResolvedValue({ messageId: "msg-bd4" });
      const deps = buildAskAgentDeps({
        runningAgents: ["fin-client"],
        dispatchTurn,
        writeInbox,
        webhookManager: {
          hasWebhook: () => false,
          sendAsAgent: vi.fn(),
        },
        configs: [{ name: "fin-client" }],
        botDirectSender: { sendText },
        agentChannels: new Map([["fin-client", ["000000000000000110"]]]),
      });

      await handleAskAgentIpc(
        {
          from: "admin-clawdy",
          to: "fin-client",
          content: "hi",
          mirror_to_target_channel: true,
        },
        deps,
      );

      expect(sendText).toHaveBeenCalledTimes(1);
      const call = sendText.mock.calls[0] as unknown as [string, string];
      const sentText = call[1];
      expect(sentText.length).toBe(2000);
      expect(sentText.endsWith("...")).toBe(true);
    });
  });

  it("writeInbox is called BEFORE dispatch and any mirror webhook (offline-path inbox guarantee)", async () => {
    const sendAsAgent = vi.fn().mockResolvedValue(undefined);
    const dispatchTurn = vi.fn().mockResolvedValue("answer");
    const writeInbox = vi.fn().mockResolvedValue({ messageId: "msg-order" });
    const deps = buildAskAgentDeps({
      runningAgents: ["fin"],
      dispatchTurn,
      writeInbox,
      webhookManager: {
        hasWebhook: () => true,
        sendAsAgent,
      },
      configs: [{ name: "fin", webhook: { displayName: "Finance Bot" } }],
    });
    await handleAskAgentIpc(
      {
        from: "admin",
        to: "fin",
        content: "hi",
        mirror_to_target_channel: true,
      },
      deps,
    );

    const inboxOrder = writeInbox.mock.invocationCallOrder[0];
    const dispatchOrder = dispatchTurn.mock.invocationCallOrder[0];
    const preMirrorOrder = sendAsAgent.mock.invocationCallOrder[0];
    const postMirrorOrder = sendAsAgent.mock.invocationCallOrder[1];

    expect(inboxOrder).toBeLessThan(dispatchOrder);
    expect(inboxOrder).toBeLessThan(preMirrorOrder);
    expect(inboxOrder).toBeLessThan(postMirrorOrder);
  });
});

// ---------------------------------------------------------------------------
// Phase 140 #14b(ask) — v3 ClawCode-channel ask branch
//
// feedback_silent_path_bifurcation: pin BOTH branches.
//   - v3 target (getBridge → bridge): push an a2a prompt with reply correlation,
//     awaitReply resolves → response = ack.result; dispatchTurn + webhook NOT
//     called.
//   - v3 timeout: awaitReply rejects → return response-undefined (no throw).
//   - v2 target (no getBridge): dispatchTurn path unchanged.
// ---------------------------------------------------------------------------
describe("handleAskAgentIpc — Phase 140 #14b(ask) v3 channel branch", () => {
  it("v3 target — pushes a2a with reply correlation, returns ack.result; no dispatchTurn/webhook", async () => {
    const push = vi.fn();
    const awaitReply = vi.fn().mockResolvedValue({ result: "v3 answer" });
    const dispatchTurn = vi.fn().mockResolvedValue("SHOULD NOT BE CALLED");
    const sendAsAgent = vi.fn();
    const deps = buildAskAgentDeps({
      runningAgents: ["projects"],
      dispatchTurn,
      writeInbox: vi.fn().mockResolvedValue({ messageId: "ask-1" }),
      webhookManager: { hasWebhook: () => true, sendAsAgent },
      getBridge: (agent) => (agent === "projects" ? { push, awaitReply } : undefined),
    });

    const result = await handleAskAgentIpc(
      { from: "admin-clawdy", to: "projects", content: "status?", mirror_to_target_channel: true },
      deps,
    );

    expect(result).toEqual({ ok: true, messageId: "ask-1", response: "v3 answer" });
    // Content carries the original prompt + an in-context ack instruction (the
    // system prompt alone doesn't reliably make the agent ack — verified live).
    const pushed = push.mock.calls[0]![0] as { type: string; message_id: string; content: string; meta: Record<string, unknown> };
    expect(pushed.type).toBe("a2a");
    expect(pushed.message_id).toBe("ask-1");
    expect(pushed.content).toContain("status?");
    expect(pushed.content).toContain("clawcode_ack");
    expect(pushed.meta).toEqual({ source_agent: "admin-clawdy", reply_correlation_id: "ask-1" });
    expect(awaitReply).toHaveBeenCalledWith("ask-1", 30_000);
    expect(dispatchTurn).not.toHaveBeenCalled();
    expect(sendAsAgent).not.toHaveBeenCalled(); // v2 webhook mirror skipped on v3
  });

  it("v3 reply timeout — awaitReply rejects → response undefined, no throw", async () => {
    const deps = buildAskAgentDeps({
      runningAgents: ["projects"],
      writeInbox: vi.fn().mockResolvedValue({ messageId: "ask-2" }),
      getBridge: () => ({
        push: vi.fn(),
        awaitReply: vi.fn().mockRejectedValue(new Error("timeout")),
      }),
      replyTimeoutMs: 5,
    });

    const result = await handleAskAgentIpc(
      { from: "admin-clawdy", to: "projects", content: "ping" },
      deps,
    );

    expect(result).toEqual({ ok: true, messageId: "ask-2" });
    expect(result.response).toBeUndefined();
  });

  it("v2 target — no getBridge → dispatchTurn path unchanged", async () => {
    const push = vi.fn();
    const dispatchTurn = vi.fn().mockResolvedValue("v2 answer");
    const deps = buildAskAgentDeps({
      runningAgents: ["fin-client"],
      dispatchTurn,
      writeInbox: vi.fn().mockResolvedValue({ messageId: "ask-3" }),
      // bridge only for a DIFFERENT agent → per-target gate, not mere dep presence
      getBridge: (agent) => (agent === "someone-else" ? { push, awaitReply: vi.fn() } : undefined),
    });

    const result = await handleAskAgentIpc(
      { from: "admin-clawdy", to: "fin-client", content: "q" },
      deps,
    );

    expect(push).not.toHaveBeenCalled();
    expect(dispatchTurn).toHaveBeenCalledWith("fin-client", "q");
    expect(result).toMatchObject({ ok: true, messageId: "ask-3", response: "v2 answer" });
  });
});

// ---------------------------------------------------------------------------
// 2026-09-03 — the ask mirrors are AGENT-TO-AGENT embeds.
//
// Regression: after auto-provisioned identities were marked `a2aOnly` (so
// ordinary replies stay on the bot), `hasWebhook` correctly began hiding them
// — but the ask mirrors still asked `hasWebhook`, so ask_agent lost its
// webhook path entirely. Agents reported "no webhook exists to use".
// ---------------------------------------------------------------------------

describe("ask-agent mirrors use the A2A-aware accessor", () => {
  it("mirrors through an A2A-only identity that hasWebhook hides", async () => {
    const sendAsAgent = vi.fn().mockResolvedValue("m1");
    const deps = buildAskAgentDeps({
      runningAgents: ["shopping"],
      dispatchTurn: vi.fn().mockResolvedValue("yes"),
      writeInbox: vi.fn().mockResolvedValue({ messageId: "m" }),
      webhookManager: {
        hasWebhook: () => false, // ordinary-delivery gate says no…
        hasA2aWebhook: () => true, // …but the A2A gate says yes
        sendAsAgent,
      },
    } as never);
    await handleAskAgentIpc(
      { from: "personal", to: "shopping", content: "up?", mirror_to_target_channel: true },
      deps,
    );
    expect(sendAsAgent).toHaveBeenCalled();
  });

  it("does NOT mirror when there is no A2A identity either", async () => {
    const sendAsAgent = vi.fn();
    const deps = buildAskAgentDeps({
      runningAgents: ["shopping"],
      dispatchTurn: vi.fn().mockResolvedValue("yes"),
      writeInbox: vi.fn().mockResolvedValue({ messageId: "m" }),
      webhookManager: {
        hasWebhook: () => false,
        hasA2aWebhook: () => false,
        sendAsAgent,
      },
    } as never);
    await handleAskAgentIpc(
      { from: "personal", to: "shopping", content: "up?", mirror_to_target_channel: true },
      deps,
    );
    expect(sendAsAgent).not.toHaveBeenCalled();
  });

  it("a pre-2026-09-03 manager with no hasA2aWebhook still mirrors", async () => {
    const sendAsAgent = vi.fn().mockResolvedValue("m1");
    const deps = buildAskAgentDeps({
      runningAgents: ["shopping"],
      dispatchTurn: vi.fn().mockResolvedValue("yes"),
      writeInbox: vi.fn().mockResolvedValue({ messageId: "m" }),
      webhookManager: { hasWebhook: () => true, sendAsAgent },
    } as never);
    await handleAskAgentIpc(
      { from: "personal", to: "shopping", content: "up?", mirror_to_target_channel: true },
      deps,
    );
    expect(sendAsAgent).toHaveBeenCalled();
  });
});
