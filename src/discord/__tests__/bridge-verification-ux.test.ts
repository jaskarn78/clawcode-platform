/**
 * 2026-08-27 verification v2 (PR-3) — DiscordBridge delivery-UX seams:
 *   - 🧾 reaction answers from the in-memory ledger store as a REPLY (bot
 *     REST, CV2 payload), never forwards to the agent, dedupes per message;
 *   - no ledger → one-line note pointing at 🔍; 🔍 keeps its legacy forward;
 *   - `ux.ledgerReaction: ""` disables the intercept (🧾 forwards like any emoji);
 *   - thread-aware agent resolution via threadManager.routeMessage;
 *   - chunked deliveries link their message ids to the latest ledger.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { icons } from "../icons.js";
import { evidenceFromToolUse } from "../../manager/evidence-ledger.js";
import { validateClaim } from "../../manager/claim-ledger.js";
import type { TurnLedger } from "../ledger-store.js";

vi.mock("../attachments.js", () => ({
  extractAttachments: vi.fn(),
  downloadAllAttachments: vi.fn(),
  formatAttachmentMetadata: vi.fn(),
  isImageAttachment: vi.fn(),
}));

const CV2_FLAG = 1 << 15;

function makeLedger(over: Partial<TurnLedger> = {}): TurnLedger {
  const evidence = evidenceFromToolUse("WebFetch", "tu1", { url: "https://www.irs.gov/retirement-plans/rmd-faqs" }, 1);
  const claim = {
    ...validateClaim(
      { verdict: "verified", claim: "RMD start age is 73", source: "https://irs.gov/retirement-plans/rmd-faqs" },
      evidence,
      "",
    ),
    id: "c1",
    turnId: "t1",
    at: 1,
  };
  return {
    turnId: "t1",
    agent: "fin-client",
    channelId: "chan-1",
    promptExcerpt: "when does his RMD start",
    evidence,
    claims: [claim],
    deliveredAt: Date.now(),
    messageIds: ["m1"],
    clientFacing: false,
    ...over,
  };
}

describe("DiscordBridge — verification v2 delivery UX (PR-3)", () => {
  const advisorEvents = new EventEmitter();
  const sessionManager = {
    forwardToAgent: vi.fn().mockResolvedValue(undefined),
    streamFromAgent: vi.fn(),
    getAgentConfig: vi.fn().mockReturnValue(undefined),
    advisorEvents,
  };
  const routingTable = {
    channelToAgent: new Map<string, string>([["chan-1", "fin-client"]]),
    agentToChannels: new Map<string, string[]>([["fin-client", ["chan-1"]]]),
  };
  const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  let DiscordBridge: typeof import("../bridge.js").DiscordBridge;
  beforeEach(async () => {
    vi.clearAllMocks();
    sessionManager.getAgentConfig.mockReturnValue(undefined);
    DiscordBridge = (await import("../bridge.js")).DiscordBridge;
  });

  type Internals = {
    handleReaction: (r: unknown, u: unknown, t: string) => Promise<void>;
    ledgerStore: { record: (l: TurnLedger) => void };
    recordChunkedDelivery: (a: unknown) => void;
    client: unknown;
    threadManager: unknown;
  };
  function createBridge() {
    const bridge = new DiscordBridge({
      routingTableRef: { current: routingTable },
      sessionManager: sessionManager as never,
      botToken: "fake-token",
      log: log as never,
    });
    const post = vi.fn().mockResolvedValue({ id: "card-1" });
    (bridge as unknown as Internals).client = { rest: { post } };
    return { bridge, post, internals: bridge as unknown as Internals };
  }
  const user = { bot: false, username: "client-a-user", id: "u-client-a" };
  const reaction = (emoji: string, messageId = "m1", channelId = "chan-1") => ({
    partial: false,
    emoji: { name: emoji, id: null },
    message: { partial: false, id: messageId, channelId, content: "RMDs begin at 73." },
  });

  it("🧾 on a delivered reply posts the ledger card as a reply (CV2, bot REST) and never forwards", async () => {
    const { post, internals } = createBridge();
    internals.ledgerStore.record(makeLedger());
    await internals.handleReaction(reaction("🧾"), user, "add");
    expect(sessionManager.forwardToAgent).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
    const [route, opts] = post.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(route).toContain("chan-1");
    expect(opts.body.message_reference).toMatchObject({ message_id: "m1", fail_if_not_exists: false });
    expect(opts.body.allowed_mentions).toMatchObject({ parse: [] });
    expect(((opts.body.flags as number) & CV2_FLAG) !== 0).toBe(true);
    expect(JSON.stringify(opts.body.components)).toContain("RMD start age is 73");
    expect(JSON.stringify(opts.body.components)).toContain("irs.gov");
  });

  it("🧾 dedupes per message within the window", async () => {
    const { post, internals } = createBridge();
    internals.ledgerStore.record(makeLedger());
    await internals.handleReaction(reaction("🧾"), user, "add");
    await internals.handleReaction(reaction("🧾"), user, "add");
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("🧾 with no ledger posts the one-line note pointing at 🔍 (no forward)", async () => {
    const { post, internals } = createBridge();
    await internals.handleReaction(reaction("🧾", "unknown-msg"), user, "add");
    expect(sessionManager.forwardToAgent).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
    const body = (post.mock.calls[0] as [string, { body: { content: string } }])[1].body;
    expect(body.content).toContain("No verification ledger");
    expect(body.content).toContain("🔍");
  });

  it("🔍 keeps its legacy forward-to-agent semantics", async () => {
    const { post, internals } = createBridge();
    internals.ledgerStore.record(makeLedger());
    await internals.handleReaction(reaction("🔍"), user, "add");
    expect(post).not.toHaveBeenCalled();
    expect(sessionManager.forwardToAgent).toHaveBeenCalledTimes(1);
  });

  it("ux.ledgerReaction: '' disables the intercept — 🧾 forwards like any emoji", async () => {
    sessionManager.getAgentConfig.mockReturnValue({ verification: { ux: { ledgerReaction: "" } } });
    const { post, internals } = createBridge();
    internals.ledgerStore.record(makeLedger());
    await internals.handleReaction(reaction("🧾"), user, "add");
    expect(post).not.toHaveBeenCalled();
    expect(sessionManager.forwardToAgent).toHaveBeenCalledTimes(1);
  });

  it("resolves the agent for a thread channel via threadManager.routeMessage", async () => {
    const { post, internals } = createBridge();
    internals.threadManager = { routeMessage: vi.fn().mockResolvedValue("fin-client") };
    internals.ledgerStore.record(makeLedger({ messageIds: ["tm1"], channelId: "thread-9" }));
    await internals.handleReaction(reaction("🧾", "tm1", "thread-9"), user, "add");
    expect(post).toHaveBeenCalledTimes(1);
    expect((post.mock.calls[0] as [string])[0]).toContain("thread-9");
  });

  it("chunked deliveries link their message ids to the latest id-less ledger", () => {
    const { bridge, internals } = createBridge();
    internals.ledgerStore.record(makeLedger({ messageIds: [] }));
    internals.recordChunkedDelivery({
      agentName: "fin-client",
      channelId: "chan-1",
      kind: "webhook",
      chunks: ["part one", "part two"],
      messageIds: ["w1", "w2"],
    });
    expect(bridge.getLedgerByMessageId("w2")?.turnId).toBe("t1");
    expect(bridge.getRecentLedgers("fin-client", 1)[0]?.messageIds).toEqual(["w1", "w2"]);
  });

  it("legacy verified badge (✅) stands down when verdictReactions is on", async () => {
    // Both 08-26 badge paths: applyVerifiedBadge and removeFinancialPendingMarker.
    const react = vi.fn().mockResolvedValue(undefined);
    const edit = vi.fn().mockResolvedValue(undefined);
    const mkBridge = (verdictReactions: boolean) => {
      sessionManager.getAgentConfig.mockReturnValue({ verification: { ux: { verdictReactions, verifiedBadge: true } } });
      const { bridge, internals } = createBridge();
      (internals as unknown as { client: unknown }).client = {
        rest: { post: vi.fn() },
        channels: { fetch: vi.fn().mockResolvedValue({ messages: { fetch: vi.fn().mockResolvedValue({ content: "answer\u2026", react, edit }) } }) },
      };
      (internals as unknown as { deliveredRefs: { record: (r: unknown) => void } }).deliveredRefs.record({
        kind: "bot", messageId: "m1", channelId: "chan-1", agentName: "fin-client", turnId: "t1", deliveredText: "answer", at: Date.now(),
      });
      return bridge as unknown as {
        applyVerifiedBadge: (a: { agentName: string; turnId: string | null }) => Promise<void>;
        removeFinancialPendingMarker: (a: { agentName: string; messageId: string; channelId: string; verified: boolean }) => Promise<void>;
      };
    };
    // verdict family ON → no ✅ from either legacy site
    const on = mkBridge(true);
    await on.applyVerifiedBadge({ agentName: "fin-client", turnId: "t1" });
    await on.removeFinancialPendingMarker({ agentName: "fin-client", messageId: "m1", channelId: "chan-1", verified: true });
    expect(react).not.toHaveBeenCalled();
    // verdict family OFF → legacy behaviour intact. 999.178 R1 — the badge
    // is the cc_circle_check custom emoji, resolved through the registry.
    react.mockClear();
    icons.setAll([{ id: "9", name: "cc_circle_check" }]);
    const off = mkBridge(false);
    await off.applyVerifiedBadge({ agentName: "fin-client", turnId: "t1" });
    expect(react).toHaveBeenCalledWith("cc_circle_check:9");
    icons.clear();
  });
});
