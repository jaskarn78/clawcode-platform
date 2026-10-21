/**
 * 2026-08-28 — corrections that land in the DRAFT message (the 10:53
 * "Correction (verified figures)" note that could not edit anything because
 * the patched text lived in the separately-posted draft).
 */
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { splitCorrectionForDrafts } from "../correction-edit.js";

const F = "```";

describe("splitCorrectionForDrafts", () => {
  const DRAFT = "Here's what we're buying, $10k each:\n\nGrowth (7):\nRocket Lab (RKLB) - two names changed.";
  const FIXED = DRAFT.replace("two names", "three names");
  it("splits body and drafts the way delivery did; a draft-only reply has the placeholder body", () => {
    const s = splitCorrectionForDrafts(`Draft below:\n\n${F}draft\n${DRAFT}\n${F}`, `Draft below:\n\n${F}draft\n${FIXED}\n${F}`);
    expect(s).not.toBeNull();
    expect(s!.body).toEqual({ original: "Draft below.", corrected: "Draft below." });
    expect(s!.drafts).toEqual([{ original: DRAFT, corrected: FIXED }]);
  });
  it("returns null without drafts or when the fence structure changed", () => {
    expect(splitCorrectionForDrafts("plain", "plain fixed")).toBeNull();
    expect(splitCorrectionForDrafts(`a\n\n${F}draft\nx\n${F}`, "a fixed")).toBeNull();
  });
});

describe("DiscordBridge.applyFinancialCorrection — draft-aware (2026-08-28)", () => {
  const DRAFT = "Here's what we're buying, $10k each:\n\nTwo names changed from yesterday's list after the re-screen.";
  const FIXED = DRAFT.replace("Two names", "Three names");
  const FOOTER = "*— correction applied (verified figures)*";
  const sessionManager = { forwardToAgent: vi.fn(), streamFromAgent: vi.fn(), getAgentConfig: vi.fn(), advisorEvents: new EventEmitter() };
  const routingTable = {
    channelToAgent: new Map<string, string>([["chan-1", "fin-research"]]),
    agentToChannels: new Map<string, string[]>([["fin-research", ["chan-1"]]]),
  };
  const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  let Bridge: typeof import("../bridge.js").DiscordBridge;
  beforeEach(async () => {
    Bridge = (await import("../bridge.js")).DiscordBridge;
  });
  function mk() {
    const bridge = new Bridge({ routingTableRef: { current: routingTable }, sessionManager: sessionManager as never, botToken: "fake-token", log: log as never });
    const edit = vi.fn().mockResolvedValue(undefined);
    const react = vi.fn().mockResolvedValue(undefined);
    const messagesFetch = vi.fn().mockResolvedValue({ edit, react });
    const fetch = vi.fn().mockResolvedValue({ messages: { fetch: messagesFetch } });
    (bridge as unknown as { client: unknown }).client = { channels: { fetch } };
    return { bridge, edit, react, messagesFetch };
  }
  function seedBody(bridge: unknown, turnId: string, deliveredText: string) {
    (bridge as { deliveredRefs: { record: (r: unknown) => void } }).deliveredRefs.record({
      kind: "bot", messageId: "body-msg-1", channelId: "chan-1", agentName: "fin-research", turnId, deliveredText, at: Date.now(),
    });
  }

  it("edits the draft message in place (plain, no footer) and annotates the body when only the draft changed", async () => {
    const { bridge, edit, messagesFetch } = mk();
    const delivered = "Draft below.\n-# Sources: finnhub.io › 4 stock quotes";
    seedBody(bridge, "discord:t9", delivered);
    bridge.recordChunkedDelivery({ agentName: "fin-research", channelId: "chan-1", kind: "bot", chunks: [DRAFT], messageIds: ["draft-msg-1"] });
    const path = await bridge.applyFinancialCorrection({
      agentName: "fin-research", channelId: "chan-1", turnId: "discord:t9",
      originalResponse: `Draft below:\n\n${F}draft\n${DRAFT}\n${F}`,
      correctedText: `Draft below:\n\n${F}draft\n${FIXED}\n${F}`,
      fallbackText: "🔎 Correction (verified figures):\n• Two → Three", footer: FOOTER,
    });
    expect(path).toBe("edit");
    expect(messagesFetch.mock.calls.map((c) => c[0])).toEqual(["draft-msg-1", "body-msg-1"]);
    expect(edit).toHaveBeenCalledTimes(2);
    expect(edit.mock.calls[0]?.[0]).toBe(FIXED); // the draft stays copy-paste clean
    // 999.178 R1 — the pencil glyph renders via the registry; with no set
    // loaded the annotation carries the words only (never a Unicode ✏️).
    expect(edit.mock.calls[1]?.[0]).toBe(`${delivered}\n-# corrected in the draft: Two → Three names changed from…`);
  });

  it("body changed, draft unchanged → the body path runs on body-only text", async () => {
    const { bridge, edit } = mk();
    seedBody(bridge, "discord:t10", "The 10-year is 4.10%.");
    bridge.recordChunkedDelivery({ agentName: "fin-research", channelId: "chan-1", kind: "bot", chunks: [DRAFT], messageIds: ["draft-msg-2"] });
    const path = await bridge.applyFinancialCorrection({
      agentName: "fin-research", channelId: "chan-1", turnId: "discord:t10",
      originalResponse: `The 10-year is 4.10%.\n\n${F}draft\n${DRAFT}\n${F}`,
      correctedText: `The 10-year is 4.31%.\n\n${F}draft\n${DRAFT}\n${F}`,
      fallbackText: "🔎 Correction (verified figures):\n• 4.10% → 4.31%", footer: FOOTER,
    });
    expect(path).toBe("edit");
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit.mock.calls[0]?.[0]).toBe(`The 10-year is 4.31%.\n\n${FOOTER}`);
  });

  it("draft changed but its message is unknown → falls back to the note (never edits the wrong message)", async () => {
    const { bridge, edit } = mk();
    const send = vi.fn().mockResolvedValue(undefined);
    (bridge as unknown as { client: unknown }).client = { channels: { fetch: vi.fn().mockResolvedValue({ send }) } };
    const path = await bridge.applyFinancialCorrection({
      agentName: "fin-research", channelId: "chan-1", turnId: "discord:t11",
      originalResponse: `Draft below:\n\n${F}draft\n${DRAFT}\n${F}`,
      correctedText: `Draft below:\n\n${F}draft\n${FIXED}\n${F}`,
      fallbackText: "🔎 Correction (verified figures):\n• Two → Three", footer: FOOTER,
    });
    expect(path).toBe("post");
    expect(edit).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith("🔎 Correction (verified figures):\n• Two → Three");
  });
});

describe("🧾 button follow-up on chunked deliveries (2026-08-28)", () => {
  const sessionManager = {
    forwardToAgent: vi.fn(), streamFromAgent: vi.fn(),
    getAgentConfig: vi.fn().mockReturnValue({ verification: { ux: { ledgerButton: true } } }),
    advisorEvents: new EventEmitter(),
  };
  const routingTable = {
    channelToAgent: new Map<string, string>([["chan-1", "fin-research"]]),
    agentToChannels: new Map<string, string[]>([["fin-research", ["chan-1"]]]),
  };
  const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const ev = (n: number) => ({ kind: "read" as const, tool: "WebFetch", toolUseId: `tu-${n}`, at: 1, url: `https://www.irs.gov/p${n}`, host: "irs.gov", title: `Page ${n}`, tier: "primary" as const });
  it("edits the LAST chunk with a `Sources · N` row once the ids are linked (bot leg)", async () => {
    const Bridge = (await import("../bridge.js")).DiscordBridge;
    const bridge = new Bridge({ routingTableRef: { current: routingTable }, sessionManager: sessionManager as never, botToken: "fake-token", log: log as never });
    const edit = vi.fn().mockResolvedValue(undefined);
    const messagesFetch = vi.fn().mockResolvedValue({ edit, react: vi.fn() });
    (bridge as unknown as { client: unknown }).client = { channels: { fetch: vi.fn().mockResolvedValue({ messages: { fetch: messagesFetch } }) } };
    (bridge as unknown as { ledgerStore: { record: (l: unknown) => void } }).ledgerStore.record({
      turnId: "t-chunk", agent: "fin-research", channelId: "chan-1", evidence: [ev(1), ev(2), ev(3)], claims: [], deliveredAt: Date.now(), messageIds: [], clientFacing: false,
    });
    bridge.recordChunkedDelivery({ agentName: "fin-research", channelId: "chan-1", kind: "bot", chunks: ["part one", "part two"], messageIds: ["m1", "m2"] });
    await new Promise((r) => setTimeout(r, 20));
    expect(messagesFetch).toHaveBeenCalledWith("m2");
    const payload = edit.mock.calls[0]?.[0] as { components?: unknown[] };
    expect(JSON.stringify(payload.components)).toContain("Sources · 3");
    expect(JSON.stringify(payload.components)).toContain("vsrc:m2");
    expect(payload).not.toHaveProperty("content");
  });
  it("no button for a thin reply (1 source, no claims)", async () => {
    const Bridge = (await import("../bridge.js")).DiscordBridge;
    const bridge = new Bridge({ routingTableRef: { current: routingTable }, sessionManager: sessionManager as never, botToken: "fake-token", log: log as never });
    const edit = vi.fn().mockResolvedValue(undefined);
    (bridge as unknown as { client: unknown }).client = { channels: { fetch: vi.fn().mockResolvedValue({ messages: { fetch: vi.fn().mockResolvedValue({ edit }) } }) } };
    (bridge as unknown as { ledgerStore: { record: (l: unknown) => void } }).ledgerStore.record({
      turnId: "t-thin", agent: "fin-research", channelId: "chan-1", evidence: [ev(1)], claims: [], deliveredAt: Date.now(), messageIds: [], clientFacing: false,
    });
    bridge.recordChunkedDelivery({ agentName: "fin-research", channelId: "chan-1", kind: "bot", chunks: ["only"], messageIds: ["m9"] });
    await new Promise((r) => setTimeout(r, 20));
    expect(edit).not.toHaveBeenCalled();
  });
});
