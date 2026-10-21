/**
 * Integration test — real MessagingBridge driving the real SlackAdapter.
 *
 * The other two suites mock the halves separately (bridge↔FakeAdapter,
 * adapter↔mocked-fetch). This connects them: an inbound message flows through
 * the real bridge into the real adapter's `sendMessage`, with only `fetch` and
 * the Socket Mode connection stubbed. It asserts the actual Slack API call body
 * carries the agent's identity + thread — the closest proxy to "it works" we
 * can run without live Slack credentials.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SlackAdapter } from "./adapter.js";
import { MessagingBridge } from "../bridge.js";
import { buildPlatformRoutingTable } from "../router.js";
import type { InboundMessage } from "../types.js";
import type { TurnDispatcher } from "../../manager/turn-dispatcher.js";
import { logger } from "../../shared/logger.js";

type PostBody = Record<string, unknown>;

async function settle(predicate: () => boolean, tries = 50): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe("Slack integration (real bridge → real adapter → Slack API body)", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("posts a placeholder via chat.postMessage (identity + thread_ts), then edits in the reply via chat.update", async () => {
    const posts: PostBody[] = [];
    const updates: PostBody[] = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const method = url.split("/api/")[1];
      const body = JSON.parse(init.body as string) as PostBody;
      if (method === "chat.postMessage") posts.push(body);
      if (method === "chat.update") updates.push(body);
      return {
        status: 200,
        headers: { get: () => null },
        json: async () => ({ ok: true, ts: "9.9", channel: body.channel }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new SlackAdapter({ botToken: "xoxb-t", appToken: "xapp-t", log: logger });
    // Skip the real Socket Mode connection; capture the handler the bridge registers.
    vi.spyOn(adapter, "start").mockResolvedValue(undefined);
    let handler!: (m: InboundMessage) => void;
    const realOnInbound = adapter.onInbound.bind(adapter);
    vi.spyOn(adapter, "onInbound").mockImplementation((h) => {
      handler = h;
      realOnInbound(h);
    });

    // Fake dispatcher: no streaming, returns a final answer.
    const dispatcher = {
      dispatchStream: async (_o: unknown, _a: string, _m: string, _c: (s: string) => void) =>
        "the answer",
    } as unknown as TurnDispatcher;

    const routingTable = buildPlatformRoutingTable([{ name: "clawdy", channels: ["C1"] }]);
    const bridge = new MessagingBridge({
      adapter,
      routingTableRef: { current: routingTable },
      turnDispatcher: dispatcher,
      identityResolver: (name) => ({ displayName: name === "clawdy" ? "Clawdy" : name, iconEmoji: ":robot_face:" }),
      log: logger,
    });
    await bridge.start();

    const inbound: InboundMessage = {
      platform: "slack",
      channelId: "C1",
      messageId: "1718000000.000100",
      userId: "U1",
      userName: "human",
      text: "what's up",
      threadId: "1717000000.000001",
      isBot: false,
      ts: new Date("2026-06-16T00:00:00Z"),
    };
    handler(inbound);

    await settle(() => updates.length > 0);

    // placeholder posted with identity + thread, into the channel
    expect(posts.length).toBe(1);
    expect(posts[0]).toMatchObject({
      channel: "C1",
      username: "Clawdy",
      icon_emoji: ":robot_face:",
      thread_ts: "1717000000.000001",
    });
    // final reply edited into that message
    expect(updates[updates.length - 1]).toMatchObject({ channel: "C1", ts: "9.9", text: "the answer" });
  });

  it("suppresses a redelivered (duplicate) message — only one turn runs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as PostBody;
        return {
          status: 200,
          headers: { get: () => null },
          json: async () => ({ ok: true, ts: "9.9", channel: body.channel }),
        };
      }),
    );

    const adapter = new SlackAdapter({ botToken: "xoxb-t", appToken: "xapp-t", log: logger });
    vi.spyOn(adapter, "start").mockResolvedValue(undefined);
    let handler!: (m: InboundMessage) => void;
    const realOnInbound = adapter.onInbound.bind(adapter);
    vi.spyOn(adapter, "onInbound").mockImplementation((h) => {
      handler = h;
      realOnInbound(h);
    });

    let dispatchCount = 0;
    const dispatcher = {
      dispatchStream: async () => {
        dispatchCount += 1;
        return "answer";
      },
    } as unknown as TurnDispatcher;

    const routingTable = buildPlatformRoutingTable([{ name: "clawdy", channels: ["C1"] }]);
    const bridge = new MessagingBridge({
      adapter,
      routingTableRef: { current: routingTable },
      turnDispatcher: dispatcher,
      identityResolver: (name) => ({ displayName: name }),
      log: logger,
    });
    await bridge.start();

    const inbound: InboundMessage = {
      platform: "slack",
      channelId: "C1",
      messageId: "1718000000.000100",
      userId: "U1",
      userName: "human",
      text: "hi",
      isBot: false,
      ts: new Date("2026-06-16T00:00:00Z"),
    };
    handler(inbound);
    handler(inbound); // redelivery of the same message id
    await settle(() => dispatchCount > 0);
    await new Promise((r) => setTimeout(r, 20));

    expect(dispatchCount).toBe(1);
  });
});
