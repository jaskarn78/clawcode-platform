import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SlackWebClient, slackApiCall, SlackApiError } from "./web-api.js";

type Json = Record<string, unknown>;

function mockResponse(status: number, body: Json, headers: Record<string, string> = {}) {
  return {
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  };
}

describe("slackApiCall", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.useRealTimers());

  it("POSTs to the right method URL with a bearer token and JSON body", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      mockResponse(200, { ok: true, result: 1 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await slackApiCall("chat.postMessage", "xoxb-tok", { channel: "C1" });
    expect(res.ok).toBe(true);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer xoxb-tok");
    expect(JSON.parse(init.body as string)).toEqual({ channel: "C1" });
  });

  it("throws SlackApiError on a non-benign ok:false", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => mockResponse(200, { ok: false, error: "channel_not_found" })));
    await expect(slackApiCall("chat.postMessage", "t", {})).rejects.toBeInstanceOf(SlackApiError);
  });

  it("treats benign errors (already_reacted) as success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => mockResponse(200, { ok: false, error: "already_reacted" })));
    const res = await slackApiCall("reactions.add", "t", {});
    expect(res.ok).toBe(false);
    expect(res.error).toBe("already_reacted");
  });

  it("retries once on HTTP 429 honoring Retry-After, then succeeds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(429, { ok: false }, { "retry-after": "1" }))
      .mockResolvedValueOnce(mockResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const p = slackApiCall("chat.postMessage", "t", {});
    await vi.advanceTimersByTimeAsync(1000);
    const res = await p;
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("SlackWebClient", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("authTestUserId returns the bot user id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => mockResponse(200, { ok: true, user_id: "UBOT" })));
    const client = new SlackWebClient("xoxb-tok");
    expect(await client.authTestUserId()).toBe("UBOT");
  });

  it("postMessage sends identity + thread_ts and disables unfurling", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      mockResponse(200, { ok: true, ts: "1.2", channel: "C1" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new SlackWebClient("xoxb-tok");

    const res = await client.postMessage({
      channel: "C1",
      text: "hi",
      username: "Clawdy",
      iconUrl: "http://x/a.png",
      threadTs: "1700.0001",
    });
    expect(res).toEqual({ ts: "1.2", channel: "C1" });

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toMatchObject({
      channel: "C1",
      text: "hi",
      username: "Clawdy",
      icon_url: "http://x/a.png",
      thread_ts: "1700.0001",
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  it("postMessage prefers icon_emoji when no iconUrl is given", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      mockResponse(200, { ok: true, ts: "1.2", channel: "C1" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new SlackWebClient("xoxb-tok");
    await client.postMessage({ channel: "C1", text: "hi", iconEmoji: ":robot_face:" });

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.icon_emoji).toBe(":robot_face:");
    expect(body.icon_url).toBeUndefined();
  });

  it("updateMessage targets chat.update with channel+ts", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      mockResponse(200, { ok: true }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new SlackWebClient("xoxb-tok");
    await client.updateMessage({ channel: "C1", ts: "1.2", text: "edited" });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://slack.com/api/chat.update");
    expect(JSON.parse(init.body as string)).toEqual({ channel: "C1", ts: "1.2", text: "edited" });
  });

  it("downloadFile fetches url_private with the bot token and returns bytes", async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      status: 200,
      headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "image/png" : null) },
      arrayBuffer: async () => payload.buffer,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new SlackWebClient("xoxb-tok");
    const bytes = await client.downloadFile("https://files.slack.com/x.png", 1024);
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://files.slack.com/x.png");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer xoxb-tok");
  });

  it("downloadFile rejects an HTML login page (missing files:read / expired URL)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
        arrayBuffer: async () => new ArrayBuffer(0),
      })),
    );
    const client = new SlackWebClient("xoxb-tok");
    await expect(client.downloadFile("https://files.slack.com/x.png", 1024)).rejects.toThrow(/HTML/);
  });

  it("downloadFile rejects a file over the size cap", async () => {
    const big = new Uint8Array(2048);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? "2048" : "image/png") },
        arrayBuffer: async () => big.buffer,
      })),
    );
    const client = new SlackWebClient("xoxb-tok");
    await expect(client.downloadFile("https://files.slack.com/x.png", 1024)).rejects.toThrow(/too large/);
  });

  it("downloadFile throws on HTTP error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 403, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) })),
    );
    const client = new SlackWebClient("xoxb-tok");
    await expect(client.downloadFile("https://files.slack.com/x.png", 1024)).rejects.toThrow(/HTTP 403/);
  });
});
