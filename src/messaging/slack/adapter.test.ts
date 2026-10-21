import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { SlackAdapter, slackEventToInbound } from "./adapter.js";
import type { SlackEvent, SlackSocketMode } from "./socket-mode.js";
import type { InboundMessage, NeutralQuestion, NeutralAnswers } from "../types.js";
import { pendingPromptRegistry } from "../pending-prompt-registry.js";
import { logger } from "../../shared/logger.js";

function evt(overrides: Partial<SlackEvent> = {}): SlackEvent {
  return {
    type: "message",
    channel: "C1",
    user: "U1",
    text: "hello",
    ts: "1718000000.000100",
    ...overrides,
  };
}

describe("slackEventToInbound", () => {
  it("converts a plain user message", () => {
    const m = slackEventToInbound(evt(), "UBOT");
    expect(m).not.toBeNull();
    expect(m!.platform).toBe("slack");
    expect(m!.channelId).toBe("C1");
    expect(m!.messageId).toBe("1718000000.000100");
    expect(m!.text).toBe("hello");
    expect(m!.isBot).toBe(false);
    expect(m!.ts.getTime()).toBe(1718000000000);
  });

  it("carries thread_ts into threadId", () => {
    const m = slackEventToInbound(evt({ thread_ts: "1717000000.000001" }), "UBOT");
    expect(m!.threadId).toBe("1717000000.000001");
  });

  it("ignores non-message events", () => {
    expect(slackEventToInbound(evt({ type: "reaction_added" }), "UBOT")).toBeNull();
  });

  it("ignores message subtypes (edits/joins/bot_message)", () => {
    expect(slackEventToInbound(evt({ subtype: "message_changed" }), "UBOT")).toBeNull();
    expect(slackEventToInbound(evt({ subtype: "channel_join" }), "UBOT")).toBeNull();
  });

  it("ignores bot-authored messages", () => {
    expect(slackEventToInbound(evt({ bot_id: "B123" }), "UBOT")).toBeNull();
  });

  it("ignores our own messages", () => {
    expect(slackEventToInbound(evt({ user: "UBOT" }), "UBOT")).toBeNull();
  });

  it("ignores empty / whitespace-only text", () => {
    expect(slackEventToInbound(evt({ text: "   " }), "UBOT")).toBeNull();
    expect(slackEventToInbound(evt({ text: undefined }), "UBOT")).toBeNull();
  });

  it("accepts a file_share with files and extracts attachment metadata", () => {
    const m = slackEventToInbound(
      evt({
        subtype: "file_share",
        text: "",
        files: [
          {
            id: "F1",
            name: "shot.png",
            mimetype: "image/png",
            size: 2048,
            url_private: "https://files.slack.com/shot.png",
          },
        ],
      }),
      "UBOT",
    );
    expect(m).not.toBeNull();
    expect(m!.text).toBe("");
    expect(m!.attachments).toHaveLength(1);
    expect(m!.attachments![0]).toMatchObject({
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: 2048,
      url: "https://files.slack.com/shot.png",
    });
    expect(m!.attachments![0].localPath).toBeUndefined();
  });

  it("prefers url_private_download when present", () => {
    const m = slackEventToInbound(
      evt({
        files: [
          { id: "F2", name: "a.pdf", url_private: "u1", url_private_download: "u2" },
        ],
      }),
      "UBOT",
    );
    expect(m!.attachments![0].url).toBe("u2");
  });

  it("still drops non-file_share subtypes even when files are attached", () => {
    expect(
      slackEventToInbound(evt({ subtype: "message_changed", files: [{ id: "F3", url_private: "u" }] }), "UBOT"),
    ).toBeNull();
  });

  it("keeps a plain text message with no attachments", () => {
    const m = slackEventToInbound(evt({ text: "hi", files: [] }), "UBOT");
    expect(m!.attachments).toBeUndefined();
  });
});

describe("SlackAdapter", () => {
  beforeEach(() => vi.restoreAllMocks());

  function mkAdapter() {
    return new SlackAdapter({ botToken: "xoxb-t", appToken: "xapp-t", log: logger });
  }

  it("reports Slack capabilities (no typing, has threads + identity)", () => {
    const caps = mkAdapter().capabilities();
    expect(caps.typingIndicator).toBe(false);
    expect(caps.threads).toBe(true);
    expect(caps.perMessageIdentity).toBe(true);
    expect(caps.reactions).toBe(true);
    expect(caps.editMessages).toBe(true);
    expect(caps.maxMessageLength).toBeGreaterThan(1000);
    // fileDownload is false until files:read is observed at start().
    expect(caps.fileDownload).toBe(false);
  });

  it("translates Discord markdown to Slack mrkdwn on send", async () => {
    const posts: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      posts.push(JSON.parse(init.body as string));
      return { status: 200, headers: { get: () => null }, json: async () => ({ ok: true, ts: "9.9", channel: "C1" }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    await mkAdapter().sendMessage("C1", "**bold** and [t](http://u)");
    expect(posts[0]!.text).toBe("*bold* and <http://u|t>");
  });

  it("enables fileDownload capability when files:read is granted at start", async () => {
    vi.stubGlobal("fetch", scopeFetchMock("chat:write,files:read", []));
    const adapter = mkAdapter();
    vi.spyOn((adapter as unknown as { socket: { start: () => Promise<void> } }).socket, "start").mockResolvedValue();
    await adapter.start();
    expect(adapter.capabilities().fileDownload).toBe(true);
  });

  it("leaves fileDownload disabled when files:read is NOT granted", async () => {
    vi.stubGlobal("fetch", scopeFetchMock("chat:write,chat:write.customize", []));
    const adapter = mkAdapter();
    vi.spyOn((adapter as unknown as { socket: { start: () => Promise<void> } }).socket, "start").mockResolvedValue();
    await adapter.start();
    expect(adapter.capabilities().fileDownload).toBe(false);
  });

  // The full assembly seam: a Slack file event arriving on the socket must flow
  // through onSlackEvent → download → and deliver an ENRICHED message (localPath
  // set) to the registered handler. The pure-function tests above don't cover
  // this wiring (silent-path-bifurcation guard).
  it("downloads an inbound file and delivers an enriched message (localPath set) to the handler", async () => {
    const payload = new TextEncoder().encode("IMGDATA");
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/auth.test")) {
        return {
          status: 200,
          headers: { get: (k: string) => (k.toLowerCase() === "x-oauth-scopes" ? "chat:write,files:read" : null) },
          json: async () => ({ ok: true, user_id: "UBOT" }),
        };
      }
      // url_private GET (no /api/ segment) → return the file bytes.
      return {
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "image/png" : null) },
        arrayBuffer: async () => payload.buffer,
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = mkAdapter();
    const socket = (adapter as unknown as { socket: SlackSocketMode }).socket;
    // Capture the event handler the adapter registers on the socket in start().
    let socketHandler!: (e: SlackEvent) => void;
    vi.spyOn(socket, "onEvent").mockImplementation((h) => {
      socketHandler = h;
    });
    vi.spyOn(socket, "start").mockResolvedValue();

    const received: InboundMessage[] = [];
    adapter.onInbound((m) => received.push(m));
    await adapter.start();
    expect(adapter.capabilities().fileDownload).toBe(true);

    socketHandler(
      evt({
        subtype: "file_share",
        text: "",
        files: [
          { id: "F1", name: "a.png", mimetype: "image/png", size: 7, url_private: "https://files.slack.com/a.png" },
        ],
      }),
    );

    // dispatchWithDownloads is async (download + write) — wait for delivery.
    for (let i = 0; i < 100 && received.length === 0; i++) await new Promise((r) => setTimeout(r, 0));

    expect(received).toHaveLength(1);
    const localPath = received[0].attachments?.[0].localPath;
    expect(localPath).toBeDefined();
    expect(new TextDecoder().decode(await readFile(localPath!))).toBe("IMGDATA");
    await rm(localPath!, { force: true });
  });

  it("sendMessage posts with identity + thread and returns a handle", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
      status: 200,
      headers: { get: () => null },
      json: async () => ({ ok: true, ts: "9.9", channel: "C1" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const handle = await mkAdapter().sendMessage("C1", "hi", {
      identity: { displayName: "Clawdy", iconEmoji: ":robot_face:" },
      threadId: "1700.1",
    });
    expect(handle).toEqual({ channelId: "C1", messageId: "9.9", threadId: "1700.1" });

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.username).toBe("Clawdy");
    expect(body.icon_emoji).toBe(":robot_face:");
    expect(body.thread_ts).toBe("1700.1");
  });

  it("setStatusReaction replaces the prior status emoji (remove old, add new)", async () => {
    const seen: string[] = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const method = url.split("/api/")[1];
      const body = JSON.parse(init.body as string) as { name?: string };
      seen.push(`${method}:${body.name ?? ""}`);
      return { status: 200, headers: { get: () => null }, json: async () => ({ ok: true }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = mkAdapter();
    const handle = { channelId: "C1", messageId: "9.9" };
    await adapter.setStatusReaction(handle, "working");
    await adapter.setStatusReaction(handle, "delivered");

    expect(seen).toEqual([
      "reactions.add:eyes",
      "reactions.remove:eyes",
      "reactions.add:white_check_mark",
    ]);
  });

  // Routes a fetch mock by Slack method, returning auth.test with a given
  // x-oauth-scopes header and capturing chat.postMessage bodies.
  function scopeFetchMock(scopeHeader: string, posts: Record<string, unknown>[]) {
    return vi.fn(async (url: string, init: RequestInit) => {
      const method = url.split("/api/")[1];
      if (method === "auth.test") {
        return {
          status: 200,
          headers: { get: (k: string) => (k.toLowerCase() === "x-oauth-scopes" ? scopeHeader : null) },
          json: async () => ({ ok: true, user_id: "UBOT" }),
        };
      }
      posts.push(JSON.parse(init.body as string));
      return { status: 200, headers: { get: () => null }, json: async () => ({ ok: true, ts: "9.9", channel: "C1" }) };
    });
  }

  it("applies per-agent identity when chat:write.customize is granted", async () => {
    const posts: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", scopeFetchMock("chat:write,chat:write.customize,reactions:write", posts));
    const adapter = mkAdapter();
    vi.spyOn((adapter as unknown as { socket: { start: () => Promise<void> } }).socket, "start").mockResolvedValue();

    await adapter.start();
    expect(adapter.capabilities().perMessageIdentity).toBe(true);
    await adapter.sendMessage("C1", "hi", { identity: { displayName: "Clawdy" } });
    expect(posts[0]!.username).toBe("Clawdy");
  });

  it("omits identity (posts as the app) when chat:write.customize is NOT granted", async () => {
    const posts: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", scopeFetchMock("chat:write,reactions:write", posts));
    const adapter = mkAdapter();
    vi.spyOn((adapter as unknown as { socket: { start: () => Promise<void> } }).socket, "start").mockResolvedValue();

    await adapter.start();
    expect(adapter.capabilities().perMessageIdentity).toBe(false);
    await adapter.sendMessage("C1", "hi", { identity: { displayName: "Clawdy" } });
    expect(posts[0]!.username).toBeUndefined();
    expect(posts[0]!.icon_emoji).toBeUndefined();
  });

  it("setStatusReaction is a no-op when the status is unchanged", async () => {
    const fetchMock = vi.fn(async () => ({
      status: 200,
      headers: { get: () => null },
      json: async () => ({ ok: true }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = mkAdapter();
    const handle = { channelId: "C1", messageId: "9.9" };
    await adapter.setStatusReaction(handle, "working");
    fetchMock.mockClear();
    await adapter.setStatusReaction(handle, "working");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// Phase 145 WS3 (Plan 07) — the Slack mirror of Discord's handleMessage
// pending-prompt intercept (LANDMINE B). A text-fallback ask_user_question
// reply must resolve the blocked tool call via the SHARED registry BEFORE
// turn dispatch — not spawn a spurious turn — and stay fail-closed to the
// operator allowlist. These exercise the real onSlackEvent path (raw event →
// captured socket handler), using the same singleton the adapter imports.
describe("SlackAdapter — ask_user_question text-fallback intercept (Plan 07)", () => {
  beforeEach(() => vi.restoreAllMocks());

  // A started adapter whose captured socket onEvent handler lets a test fire
  // raw Slack message events straight at onSlackEvent. Mirrors the
  // file-download assembly test's harness; botUserId resolves to "UBOT".
  async function startedAdapter(): Promise<{
    fire: (e: SlackEvent) => void;
    received: InboundMessage[];
  }> {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/api/auth.test")) {
          return {
            status: 200,
            headers: { get: (k: string) => (k.toLowerCase() === "x-oauth-scopes" ? "chat:write" : null) },
            json: async () => ({ ok: true, user_id: "UBOT" }),
          };
        }
        return { status: 200, headers: { get: () => null }, json: async () => ({ ok: true }) };
      }),
    );
    const adapter = new SlackAdapter({ botToken: "xoxb-t", appToken: "xapp-t", log: logger });
    const socket = (adapter as unknown as { socket: SlackSocketMode }).socket;
    let fire!: (e: SlackEvent) => void;
    vi.spyOn(socket, "onEvent").mockImplementation((h) => {
      fire = h;
    });
    vi.spyOn(socket, "start").mockResolvedValue();
    const received: InboundMessage[] = [];
    adapter.onInbound((m) => received.push(m));
    await adapter.start();
    return { fire, received };
  }

  const question: NeutralQuestion = {
    id: "q1",
    header: "Pick",
    options: [
      { id: "opt-a", label: "A" },
      { id: "opt-b", label: "B" },
    ],
  };

  it("resolves a pending prompt from an allowlisted operator reply and SUPPRESSES the turn", async () => {
    const { fire, received } = await startedAdapter();
    const answers: NeutralAnswers[] = [];
    pendingPromptRegistry.register({
      promptId: "p-suppress",
      platform: "slack",
      channelId: "C1",
      questions: [question],
      allowlistIds: ["U1"],
      timeoutMs: 60_000,
      resolve: (a) => answers.push(a),
      onTimeout: () => {},
    });

    fire(evt({ user: "U1", channel: "C1", text: "1" }));

    expect(answers).toHaveLength(1);
    expect(answers[0].answers[0]).toEqual({ questionId: "q1", selectedOptionIds: ["opt-a"] });
    expect(received).toHaveLength(0); // turn suppressed
    expect(pendingPromptRegistry.size()).toBe(0); // entry consumed
  });

  it("does NOT resolve for a non-allowlisted sender (fail-closed) — message dispatches normally", async () => {
    const { fire, received } = await startedAdapter();
    pendingPromptRegistry.register({
      promptId: "p-nonop",
      platform: "slack",
      channelId: "C1",
      questions: [question],
      allowlistIds: ["U-OPERATOR"], // the sender U1 is NOT an operator
      timeoutMs: 60_000,
      resolve: () => {},
      onTimeout: () => {},
    });

    fire(evt({ user: "U1", channel: "C1", text: "1" }));

    expect(received).toHaveLength(1); // turn NOT suppressed
    expect(received[0].text).toBe("1");
    expect(pendingPromptRegistry.size()).toBe(1); // prompt still pending
    pendingPromptRegistry.cancel("p-nonop");
  });

  it("does NOT resolve an unparseable operator reply — dispatches normally, prompt stays pending", async () => {
    const { fire, received } = await startedAdapter();
    pendingPromptRegistry.register({
      promptId: "p-garbage",
      platform: "slack",
      channelId: "C1",
      questions: [question],
      allowlistIds: ["U1"],
      timeoutMs: 60_000,
      resolve: () => {},
      onTimeout: () => {},
    });

    fire(evt({ user: "U1", channel: "C1", text: "not a number" }));

    expect(received).toHaveLength(1);
    expect(pendingPromptRegistry.size()).toBe(1);
    pendingPromptRegistry.cancel("p-garbage");
  });

  it("is channel-scoped — a reply in a channel with no pending prompt dispatches normally", async () => {
    const { fire, received } = await startedAdapter();
    pendingPromptRegistry.register({
      promptId: "p-chan",
      platform: "slack",
      channelId: "C1",
      questions: [question],
      allowlistIds: ["U1"],
      timeoutMs: 60_000,
      resolve: () => {},
      onTimeout: () => {},
    });

    fire(evt({ user: "U1", channel: "C2", text: "1" })); // different channel

    expect(received).toHaveLength(1);
    expect(received[0].channelId).toBe("C2");
    expect(pendingPromptRegistry.size()).toBe(1); // C1 prompt untouched
    pendingPromptRegistry.cancel("p-chan");
  });
});
