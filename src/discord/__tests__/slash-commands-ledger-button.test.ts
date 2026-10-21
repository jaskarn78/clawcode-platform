/**
 * 2026-08-27 verification v2 (PR-3) — `vsrc:<messageId>` button handler:
 * ephemeral CV2 ledger card from the bridge's in-memory store; graceful
 * "no longer available" when the ledger expired; strict-prefix router guard.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { MessageFlags } from "discord.js";
import { SlashCommandHandler } from "../slash-commands.js";
import { VSRC_PREFIX } from "../ledger-card.js";
import { evidenceFromToolUse } from "../../manager/evidence-ledger.js";
import { validateClaim } from "../../manager/claim-ledger.js";
import type { RoutingTable } from "../types.js";
import type { SessionManager } from "../../manager/session-manager.js";

const CV2_FLAG = 1 << 15;
const evidence = evidenceFromToolUse("WebFetch", "tu1", { url: "https://www.irs.gov/retirement-plans/rmd-faqs" }, 1);
const ledger = {
  turnId: "t1",
  agent: "fin-client",
  channelId: "fin-chan",
  promptExcerpt: "when does his RMD start",
  evidence,
  claims: [{
    ...validateClaim({ verdict: "verified", claim: "RMD start age is 73", source: "https://irs.gov/retirement-plans/rmd-faqs" }, evidence, ""),
    id: "c1", turnId: "t1", at: 1,
  }],
  deliveredAt: 0,
  messageIds: ["m1"],
  clientFacing: false,
};

function makeInteraction(customId: string) {
  return {
    customId,
    user: { id: "client-a", username: "client-a" },
    channelId: "fin-chan",
    reply: vi.fn().mockResolvedValue(undefined),
  };
}
type Invoker = { handleLedgerButton: (i: unknown) => Promise<void> };
function makeHandler(withBridge = true) {
  const routingTable: RoutingTable = {
    channelToAgent: new Map([["fin-chan", "fin-client"]]),
    agentToChannels: new Map([["fin-client", ["fin-chan"]]]),
  };
  const handler = new SlashCommandHandler({
    routingTable,
    sessionManager: { getAgentConfig: vi.fn().mockReturnValue(undefined) } as unknown as SessionManager,
    resolvedAgents: [{ name: "fin-client", admin: false }],
    botToken: "fake-token",
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    ...(withBridge
      ? { getBridge: () => ({ getLedgerByMessageId: (id: string) => (id === "m1" ? ledger : undefined) }) }
      : {}),
  } as never);
  return handler as unknown as Invoker;
}

describe("handleLedgerButton (vsrc:)", () => {
  it("replies EPHEMERALLY with the CV2 ledger card", async () => {
    const int = makeInteraction(`${VSRC_PREFIX}m1`);
    await makeHandler().handleLedgerButton(int);
    expect(int.reply).toHaveBeenCalledTimes(1);
    const arg = int.reply.mock.calls[0]![0] as { flags: number; components: unknown[] };
    expect((arg.flags & MessageFlags.Ephemeral) !== 0).toBe(true);
    expect((arg.flags & CV2_FLAG) !== 0).toBe(true);
    expect(JSON.stringify(arg.components)).toContain("RMD start age is 73");
  });
  it("expired / unknown ledger → ephemeral 'no longer available' note", async () => {
    const int = makeInteraction(`${VSRC_PREFIX}gone`);
    await makeHandler().handleLedgerButton(int);
    const arg = int.reply.mock.calls[0]![0] as { flags: number; content: string };
    expect(arg.flags).toBe(MessageFlags.Ephemeral);
    expect(arg.content).toContain("no longer available");
    expect(arg.content).toContain("🔍");
  });
  it("no bridge wired (v3 / tests) → same graceful note, never throws", async () => {
    const int = makeInteraction(`${VSRC_PREFIX}m1`);
    await expect(makeHandler(false).handleLedgerButton(int)).resolves.toBeUndefined();
    expect(int.reply).toHaveBeenCalledTimes(1);
  });
  it("router guards on the strict prefix (static pin)", () => {
    const src = readFileSync(new URL("../slash-commands.ts", import.meta.url), "utf8");
    expect(src).toContain("interaction.customId.startsWith(VSRC_PREFIX)");
    expect(VSRC_PREFIX).toBe("vsrc:");
  });
});

describe("handleLedgerButton — direct getLedger (2026-08-28)", () => {
  it("resolves through getLedger even when the channel is unknown to the routing table (threads) and logs the click", async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const handler = new SlashCommandHandler({
      routingTable: { channelToAgent: new Map(), agentToChannels: new Map() },
      sessionManager: { getAgentConfig: vi.fn().mockReturnValue(undefined) } as unknown as SessionManager,
      resolvedAgents: [{ name: "fin-client", admin: false }],
      botToken: "fake-token",
      log,
      getLedger: (id: string) => (id === "m1" ? ledger : undefined),
    } as never) as unknown as Invoker;
    const i = makeInteraction("vsrc:m1");
    i.channelId = "thread-9";
    await handler.handleLedgerButton(i);
    const payload = i.reply.mock.calls[0]?.[0] as { content?: string; components?: unknown };
    expect(payload.content ?? "").not.toContain("no longer available");
    expect(payload.components).toBeDefined();
    const click = log.info.mock.calls.find((c) => (c[0] as { tag?: string })?.tag === "phase999.63-ledger-click");
    expect(click?.[0]).toMatchObject({ source: "direct", claims: 1, messageId: "m1", channelId: "thread-9" });
  });
});

// ── Phase 999.133 — the card carries the recalled memory ────────────────
describe("handleLedgerButton — recall (Phase 999.133)", () => {
  it("renders the Recalled section for a ledger that carries a recall", async () => {
    const replies: unknown[] = [];
    const withRecall = {
      ...ledger,
      recall: { at: 0, memories: [{ id: "m1", createdAt: "2026-06-12T17:00:00.000Z", snippet: "Zaid wants 40% SGOV" }], notes: [], documents: [] },
    };
    const handler = new SlashCommandHandler({
      routingTable: { channelToAgent: new Map(), agentToChannels: new Map() } as unknown as RoutingTable,
      sessionManager: {} as unknown as SessionManager,
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
      getLedger: (id: string) => (id === "m1" ? (withRecall as never) : undefined),
    } as never) as unknown as Invoker;
    const i = {
      customId: `${VSRC_PREFIX}m1`,
      channelId: "unknown-thread",
      user: { id: "u1" },
      reply: async (payload: unknown) => {
        replies.push(payload);
      },
    };
    await handler.handleLedgerButton(i);
    expect(replies).toHaveLength(1);
    expect(JSON.stringify(replies[0])).toContain("Recalled from memory");
    expect(JSON.stringify(replies[0])).toContain("Zaid wants 40% SGOV");
  });
});
