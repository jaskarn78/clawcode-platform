/**
 * 999.178 R1 — bridge wiring for the status ping and the queued-ask restore.
 * The acceptance bars ("ETA answered with no model turn", "0 queued asks lost")
 * rest on this code, so exercise the private methods directly against a mock
 * sessionManager (same approach as bridge-live-thinking.test.ts).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { registerResearchTracker } from "../../manager/research-registry.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { upsertQueuedAsk } from "../../manager/coalesced-queue-store.js";
import { resetUxFeatureOverridesForTests } from "../../manager/ux-feature-state-store.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let DiscordBridge: any;

const AGENT = "personal";
const CHAN = "chan-1";
const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
const routingTable = {
  channelToAgent: new Map([[CHAN, AGENT]]),
  agentToChannels: new Map([[AGENT, [CHAN]]]),
};

let dir: string;

function makeSessionManager(o: {
  running: boolean;
  statusPing?: boolean;
  startedAt?: number;
  lastActivityAt?: number;
  attributedStream?: boolean;
  orphanOpen?: boolean;
}) {
  return {
    getAgentConfig: vi.fn(() => ({ uxFeatures: { statusPing: o.statusPing ?? true } })),
    hasActiveTurn: vi.fn(() => o.running),
    isOrphanTurnOpen: vi.fn(() => o.orphanOpen ?? false),
    getTurnStartedAt: vi.fn(() => o.startedAt ?? null),
    getLastTurnActivityAt: vi.fn(() => o.lastActivityAt ?? null),
    hasAttributedStream: vi.fn(() => o.attributedStream ?? true),
    isRunning: vi.fn(() => true),
    injectMidTurn: vi.fn(() => ({ injected: true })),
  } as never;
}

function makeBridge(sessionManager: never, statePath?: string) {
  const bridge = new DiscordBridge({
    routingTableRef: { current: routingTable },
    sessionManager,
    botToken: "fake-token",
    log: log as never,
    ...(statePath ? { coalescedQueueStatePath: statePath } : {}),
  });
  // Never touch the network from a unit test.
  bridge.client = { channels: { fetch: vi.fn().mockRejectedValue(new Error("offline")) } };
  return bridge;
}

interface FakeMessage {
  content: string;
  id: string;
  channelId: string;
  author: { id: string; username: string; bot: boolean };
  createdTimestamp: number;
  attachments: { size: number };
  channel: { isThread: () => boolean };
  reply: ReturnType<typeof vi.fn>;
}

function makeMessage(content: string, id = "msg-1"): FakeMessage {
  return {
    content,
    id,
    channelId: CHAN,
    author: { id: "u-1", username: "sam", bot: false },
    createdTimestamp: Date.parse("2026-09-25T21:14:00Z"),
    attachments: { size: 0 },
    channel: { isThread: () => false },
    reply: vi.fn().mockResolvedValue({ id: "reply-1" }),
  };
}

beforeAll(async () => {
  DiscordBridge = (await import("../bridge.js")).DiscordBridge;
}, 120_000);

beforeEach(async () => {
  vi.clearAllMocks();
  resetUxFeatureOverridesForTests();
  dir = await mkdtemp(join(tmpdir(), "sping-"));
});
afterEach(async () => {
  resetUxFeatureOverridesForTests();
  await rm(dir, { recursive: true, force: true });
});

describe("tryStatusPing", () => {
  it("running: answers 'Working on your…' from the live state with NO model turn", async () => {
    const sm = makeSessionManager({ running: true, startedAt: Date.now() - 60_000 });
    const bridge = makeBridge(sm);
    const spr = vi.spyOn(bridge, "streamAndPostResponse").mockResolvedValue(undefined);
    const msg = makeMessage("eta?");

    const handled = await bridge.tryStatusPing(msg as never, AGENT, CHAN);

    expect(handled).toBe(true);
    expect(msg.reply).toHaveBeenCalledTimes(1);
    expect(msg.reply.mock.calls[0][0].content).toContain("Working on your");
    // allowed_mentions locked down, and never a model turn.
    expect(msg.reply.mock.calls[0][0].allowedMentions).toEqual({ repliedUser: false, parse: [] });
    expect(spr).not.toHaveBeenCalled();
  });

  it("idle: answers 'Nothing running.'", async () => {
    const bridge = makeBridge(makeSessionManager({ running: false }));
    const msg = makeMessage("we good?");
    const handled = await bridge.tryStatusPing(msg as never, AGENT, CHAN);
    expect(handled).toBe(true);
    expect(msg.reply.mock.calls[0][0].content).toContain("Nothing running.");
  });

  it("a self-fired turn (research synthesis) running → never 'Nothing running'", async () => {
    const bridge = makeBridge(makeSessionManager({ running: false, orphanOpen: true }));
    const msg = makeMessage("eta");
    expect(await bridge.tryStatusPing(msg as never, AGENT, CHAN)).toBe(true);
    const content = msg.reply.mock.calls[0][0].content as string;
    expect(content).not.toContain("Nothing running");
    expect(content).toContain("Working on a follow-up");
  });

  it("live research is reported from the agent's research tracker", async () => {
    const unregister = registerResearchTracker(AGENT, {
      occupiedSlots: () => 0,
      occupiedSlotsFor: () => 0,
      noteApprovedLaunch: () => undefined,
      sessionForKey: () => undefined,
      statusView: () => ({ total: 4, done: 4, running: 0, startedAt: Date.now() - 300_000, writingSince: Date.now() - 60_000 }),
    });
    try {
      const bridge = makeBridge(makeSessionManager({ running: false, orphanOpen: true }));
      const msg = makeMessage("eta");
      await bridge.tryStatusPing(msg as never, AGENT, CHAN);
      expect(msg.reply.mock.calls[0][0].content).toContain("Writing up the research (4 of 4 done)");
      expect(msg.reply.mock.calls[0][0].components).toBeUndefined(); // never Stop on research
    } finally {
      unregister();
    }
  });

  it("flag off: returns false and never replies (falls through to normal dispatch)", async () => {
    const bridge = makeBridge(makeSessionManager({ running: true, statusPing: false }));
    const msg = makeMessage("eta?");
    const handled = await bridge.tryStatusPing(msg as never, AGENT, CHAN);
    expect(handled).toBe(false);
    expect(msg.reply).not.toHaveBeenCalled();
  });

  it("non-ping content: returns false and never replies", async () => {
    const bridge = makeBridge(makeSessionManager({ running: true }));
    const msg = makeMessage("please rebalance the 401k into VTI");
    const handled = await bridge.tryStatusPing(msg as never, AGENT, CHAN);
    expect(handled).toBe(false);
    expect(msg.reply).not.toHaveBeenCalled();
  });

  it("message with an attachment is never a ping", async () => {
    const bridge = makeBridge(makeSessionManager({ running: true }));
    const msg = makeMessage("eta?");
    (msg as { attachments: { size: number } }).attachments.size = 1;
    expect(await bridge.tryStatusPing(msg as never, AGENT, CHAN)).toBe(false);
  });
});

describe("restoreQueuedAsks", () => {
  it("re-seats persisted asks into the coalescer and the queued count", async () => {
    const statePath = join(dir, "coalesced-queue.json");
    const now = Date.now();
    await upsertQueuedAsk(statePath, { agentName: AGENT, messageId: "m1", channelId: CHAN, content: "any update?", receivedAt: now - 1000, kind: "coalesced" });
    await upsertQueuedAsk(statePath, { agentName: AGENT, messageId: "m2", channelId: CHAN, content: "we good?", receivedAt: now - 500, kind: "coalesced" });

    const bridge = makeBridge(makeSessionManager({ running: false }), statePath);
    await bridge.restoreQueuedAsks();

    expect(bridge.messageCoalescer.getPendingCount(AGENT)).toBe(2);
    expect(bridge.queuedAskCount(AGENT, null)).toBe(2);
  });

  it("is idempotent — a second call does not double-add", async () => {
    const statePath = join(dir, "coalesced-queue.json");
    await upsertQueuedAsk(statePath, { agentName: AGENT, messageId: "m1", channelId: CHAN, content: "eta?", receivedAt: Date.now(), kind: "coalesced" });
    const bridge = makeBridge(makeSessionManager({ running: false }), statePath);
    await bridge.restoreQueuedAsks();
    await bridge.restoreQueuedAsks();
    expect(bridge.messageCoalescer.getPendingCount(AGENT)).toBe(1);
  });
});
