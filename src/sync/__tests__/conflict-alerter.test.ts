/**
 * Phase 91 Plan 02 Task 2 — conflict-alerter tests (SYNC-06 D-15).
 *
 * Pinned invariants:
 *   A1: conflicts.length === 0 → {sent:false, reason:"no-conflicts"}, no fetch
 *   A2: empty botToken → {sent:false, reason:"no-bot-token"}, no fetch
 *   A3: fetch → 200 JSON{id} → {sent:true, messageId:"..."}
 *   A4: fetch → non-2xx → {sent:false, reason:"http-error", detail:"<code>:..."}
 *   A5: fetch rejects → {sent:false, reason:"network-error", detail:err.message}
 *   A6: POST URL embeds the admin-clawdy channel ID literally
 *   A7: >25 conflicts → embed.fields capped at 25 (Discord API limit)
 *   A8: Authorization header uses `Bot <token>` format + sends POST
 *   A9: `clawcode sync resolve` hint appears in description
 */

import { describe, it, expect, vi } from "vitest";
import {
  sendConflictAlert,
  ADMIN_CLAWDY_CHANNEL_ID,
  DISCORD_EMBED_FIELD_CAP,
  CONFLICT_EMBED_COLOR,
} from "../conflict-alerter.js";
import type { SyncConflict } from "../types.js";

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  } as unknown as import("pino").Logger;
}

function makeConflict(overrides: Partial<SyncConflict> = {}): SyncConflict {
  return {
    path: "memory/test.md",
    sourceHash: "aaaabbbbccccdddd",
    destHash: "1111222233334444",
    detectedAt: "2026-04-24T20:00:00.000Z",
    resolvedAt: null,
    ...overrides,
  };
}

// Minimal fetch stub — lets us assert the request shape + control the response.
function makeFetchStub(
  response: { ok: boolean; status: number; bodyJson?: unknown; bodyText?: string },
): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const res = {
      ok: response.ok,
      status: response.status,
      async json() {
        return response.bodyJson ?? {};
      },
      async text() {
        return response.bodyText ?? "";
      },
    };
    return res as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

// ---------------------------------------------------------------------------
// A1: no conflicts → early-return
// ---------------------------------------------------------------------------

describe("sendConflictAlert — zero conflicts (A1)", () => {
  it("returns no-conflicts without invoking fetch", async () => {
    const { fetchImpl, calls } = makeFetchStub({ ok: true, status: 200 });
    const result = await sendConflictAlert([], "cyc1", {
      botToken: "t",
      channelId: ADMIN_CLAWDY_CHANNEL_ID,
      log: makeLogger(),
      fetchImpl,
    });
    expect(result).toEqual({ sent: false, reason: "no-conflicts" });
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// A2: missing bot token → early-return
// ---------------------------------------------------------------------------

describe("sendConflictAlert — missing bot token (A2)", () => {
  it("returns no-bot-token when botToken is empty string", async () => {
    const { fetchImpl, calls } = makeFetchStub({ ok: true, status: 200 });
    const log = makeLogger();
    const result = await sendConflictAlert([makeConflict()], "cyc1", {
      botToken: "",
      channelId: ADMIN_CLAWDY_CHANNEL_ID,
      log,
      fetchImpl,
    });
    expect(result).toEqual({ sent: false, reason: "no-bot-token" });
    expect(calls).toHaveLength(0);
    expect(log.warn).toHaveBeenCalled();
  });

  it("returns no-bot-token when botToken is whitespace only", async () => {
    const { fetchImpl } = makeFetchStub({ ok: true, status: 200 });
    const result = await sendConflictAlert([makeConflict()], "cyc1", {
      botToken: "   ",
      channelId: ADMIN_CLAWDY_CHANNEL_ID,
      log: makeLogger(),
      fetchImpl,
    });
    expect(result).toEqual({ sent: false, reason: "no-bot-token" });
  });
});

// ---------------------------------------------------------------------------
// A3: successful send
// ---------------------------------------------------------------------------

describe("sendConflictAlert — successful send (A3)", () => {
  it("returns {sent:true, messageId} on 200 with JSON id", async () => {
    const { fetchImpl, calls } = makeFetchStub({
      ok: true,
      status: 200,
      bodyJson: { id: "snowflake-1234567890" },
    });
    const result = await sendConflictAlert([makeConflict()], "cyc1", {
      botToken: "real-bot-token",
      channelId: ADMIN_CLAWDY_CHANNEL_ID,
      log: makeLogger(),
      fetchImpl,
    });
    expect(result).toEqual({
      sent: true,
      messageId: "snowflake-1234567890",
    });
    expect(calls).toHaveLength(1);
  });

  it("falls back messageId to 'unknown' if body has no id field", async () => {
    const { fetchImpl } = makeFetchStub({
      ok: true,
      status: 200,
      bodyJson: {},
    });
    const result = await sendConflictAlert([makeConflict()], "cyc1", {
      botToken: "t",
      channelId: ADMIN_CLAWDY_CHANNEL_ID,
      log: makeLogger(),
      fetchImpl,
    });
    expect(result).toEqual({ sent: true, messageId: "unknown" });
  });
});

// ---------------------------------------------------------------------------
// A4: non-2xx HTTP response
// ---------------------------------------------------------------------------

describe("sendConflictAlert — HTTP error (A4)", () => {
  it("returns http-error + detail on 403 (missing perms)", async () => {
    const { fetchImpl } = makeFetchStub({
      ok: false,
      status: 403,
      bodyText: '{"message":"Missing Access","code":50001}',
    });
    const log = makeLogger();
    const result = await sendConflictAlert([makeConflict()], "cyc1", {
      botToken: "t",
      channelId: ADMIN_CLAWDY_CHANNEL_ID,
      log,
      fetchImpl,
    });
    expect(result.sent).toBe(false);
    if (!result.sent) {
      expect(result.reason).toBe("http-error");
      expect(result.detail).toContain("403");
      expect(result.detail).toContain("Missing Access");
    }
    expect(log.warn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// A5: fetch rejects (network)
// ---------------------------------------------------------------------------

describe("sendConflictAlert — network error (A5)", () => {
  it("returns network-error + detail when fetch rejects", async () => {
    const fetchImpl: typeof fetch = (async () => {
      throw new Error("getaddrinfo ENOTFOUND discord.com");
    }) as unknown as typeof fetch;
    const log = makeLogger();
    const result = await sendConflictAlert([makeConflict()], "cyc1", {
      botToken: "t",
      channelId: ADMIN_CLAWDY_CHANNEL_ID,
      log,
      fetchImpl,
    });
    expect(result.sent).toBe(false);
    if (!result.sent) {
      expect(result.reason).toBe("network-error");
      expect(result.detail).toContain("ENOTFOUND");
    }
    expect(log.warn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// A6: URL embeds admin-clawdy channelId (000000000000000115)
// ---------------------------------------------------------------------------

describe("sendConflictAlert — URL shape (A6)", () => {
  it("POSTs to /api/v10/channels/<channelId>/messages", async () => {
    const { fetchImpl, calls } = makeFetchStub({ ok: true, status: 200, bodyJson: { id: "x" } });
    await sendConflictAlert([makeConflict()], "cyc1", {
      botToken: "t",
      channelId: ADMIN_CLAWDY_CHANNEL_ID,
      log: makeLogger(),
      fetchImpl,
    });
    expect(calls[0]?.url).toBe(
      `https://discord.com/api/v10/channels/${ADMIN_CLAWDY_CHANNEL_ID}/messages`,
    );
    // Sanity: the literal channelId constant is the one from the plan.
    expect(ADMIN_CLAWDY_CHANNEL_ID).toBe("000000000000000115");
  });
});

// ---------------------------------------------------------------------------
// A7: >25 conflicts → fields cap at 25
// ---------------------------------------------------------------------------

describe("sendConflictAlert — field cap (A7)", () => {
  it("caps embed.fields at DISCORD_EMBED_FIELD_CAP (25)", async () => {
    const { fetchImpl, calls } = makeFetchStub({ ok: true, status: 200, bodyJson: { id: "x" } });
    const many: SyncConflict[] = Array.from({ length: 30 }, (_, i) =>
      makeConflict({ path: `f${i}.md`, sourceHash: `src${i}aa`, destHash: `dst${i}bb` }),
    );
    await sendConflictAlert(many, "cyc1", {
      botToken: "t",
      channelId: ADMIN_CLAWDY_CHANNEL_ID,
      log: makeLogger(),
      fetchImpl,
    });
    const body = JSON.parse((calls[0]?.init.body as string) ?? "{}");
    expect(body.embeds).toHaveLength(1);
    expect(body.embeds[0].fields).toHaveLength(DISCORD_EMBED_FIELD_CAP);
    expect(body.embeds[0].fields).toHaveLength(25);
    // Title still reflects the full count (30), not the rendered count (25).
    expect(body.embeds[0].title).toContain("30 file");
  });
});

// ---------------------------------------------------------------------------
// A8: Authorization header + POST method + body shape
// ---------------------------------------------------------------------------

describe("sendConflictAlert — request shape (A8)", () => {
  it("uses `Bot <token>` Authorization header + POST + JSON content-type", async () => {
    const { fetchImpl, calls } = makeFetchStub({ ok: true, status: 200, bodyJson: { id: "x" } });
    await sendConflictAlert([makeConflict()], "cyc1", {
      botToken: "my-real-bot-token",
      channelId: ADMIN_CLAWDY_CHANNEL_ID,
      log: makeLogger(),
      fetchImpl,
    });
    expect(calls[0]?.init.method).toBe("POST");
    const headers = (calls[0]?.init.headers ?? {}) as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bot my-real-bot-token");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse((calls[0]?.init.body as string) ?? "{}");
    expect(body.embeds[0].color).toBe(CONFLICT_EMBED_COLOR);
  });
});

// ---------------------------------------------------------------------------
// A9: embed carries `clawcode sync resolve` hint
// ---------------------------------------------------------------------------

describe("sendConflictAlert — embed content (A9)", () => {
  it("renders paths + short hashes + resolve-command hint", async () => {
    const { fetchImpl, calls } = makeFetchStub({ ok: true, status: 200, bodyJson: { id: "x" } });
    await sendConflictAlert(
      [
        makeConflict({
          path: "MEMORY.md",
          sourceHash: "abcdef0123456789",
          destHash: "1122334455667788",
        }),
      ],
      "cyc-xyz",
      {
        botToken: "t",
        channelId: ADMIN_CLAWDY_CHANNEL_ID,
        log: makeLogger(),
        fetchImpl,
        now: () => new Date("2026-04-24T20:30:00.000Z"),
      },
    );
    const body = JSON.parse((calls[0]?.init.body as string) ?? "{}");
    const embed = body.embeds[0];
    expect(embed.description).toContain("clawcode sync resolve");
    expect(embed.fields[0].name).toBe("MEMORY.md");
    // Short (8-char) hashes in the value.
    expect(embed.fields[0].value).toContain("abcdef01");
    expect(embed.fields[0].value).toContain("11223344");
    // Footer includes cycleId + deterministic timestamp.
    expect(embed.footer.text).toContain("cyc-xyz");
    expect(embed.footer.text).toContain("2026-04-24T20:30:00.000Z");
  });
});
