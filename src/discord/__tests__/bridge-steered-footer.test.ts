/**
 * 2026-07-31 — steered-reply indicator (999.100 visibility footer).
 *
 * The 🧭 reaction on the steering message already shipped with PR #118;
 * this suite pins the NEW reply-side indicator:
 *   - `steeredIntoFlight` lifecycle (arm / increment / stale-overwrite /
 *     exact-match consume / TTL prune / own-trigger-only clear);
 *   - footer appended at the single mutation point (composes AFTER the
 *     advisor footer, feeds every delivery exit);
 *   - failure paths never over-claim (catch-head clear);
 *   - `tryMidturnRoute` arms the marker + logs `indicated`.
 *
 * Harness mirrors bridge-advisor-footer.test.ts — real DiscordBridge, real
 * private `streamAndPostResponse`, spied `sendResponse`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Message, Collection, Attachment } from "discord.js";

const STEERED_ONE = "\n\n*— steered mid-turn: incorporated your follow-up*";
const steeredMany = (n: number) =>
  `\n\n*— steered mid-turn: incorporated your ${n} follow-ups*`;
// 999.151 — the advisor fact is a grey subtext row now, not italic prose, so
// it lands BELOW the steered line: prose footers first, then the metadata row.
const ADVISOR_ROW = "\n\n-# Advisor consulted (Opus)";

function makeMessage(
  overrides: {
    content?: string;
    channelId?: string;
    messageId?: string;
    referenceMessageId?: string;
  } = {},
): Message {
  const attMap = new Map<string, Attachment>();
  const collection = {
    size: 0,
    values: () => attMap.values(),
    [Symbol.iterator]: () => attMap.values(),
    map: <T>(_fn: (att: Attachment) => T): T[] => [],
  } as unknown as Collection<string, Attachment>;

  const message = {
    content: overrides.content ?? "hello",
    channelId: overrides.channelId ?? "chan-1",
    id: overrides.messageId ?? "msg-1",
    author: { username: "user-a", bot: false, id: "user-1" },
    createdAt: new Date("2026-07-31T00:00:00Z"),
    attachments: collection,
    reference: overrides.referenceMessageId
      ? { messageId: overrides.referenceMessageId }
      : null,
    webhookId: null,
    embeds: [],
    react: vi.fn().mockResolvedValue(undefined),
    reactions: { cache: new Map() },
    client: { user: { id: "bot-1" } },
    channel: {
      sendTyping: vi.fn(),
      send: vi.fn().mockImplementation(async (content: string) => ({
        id: "placeholder-msg",
        edit: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        content,
      })),
      messages: { cache: new Map() },
    },
  };

  return message as unknown as Message;
}

describe("steered-reply indicator — 2026-07-31", () => {
  let DiscordBridge: typeof import("../bridge.js").DiscordBridge;
  let bridge: InstanceType<typeof DiscordBridge>;
  let advisorEvents: EventEmitter;
  let mockSendResponse: ReturnType<typeof vi.fn>;
  let fakeLog: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> };

  const fakeRoutingTable = {
    channelToAgent: new Map([["chan-1", "test-agent"]]),
    agentToChannels: new Map([["test-agent", ["chan-1"]]]),
  };

  function buildTurnDispatcher(
    response: string | Error,
    emit?: { invoked?: boolean; resulted?: boolean },
  ) {
    return {
      dispatchStream: vi.fn().mockImplementation(async () => {
        if (emit?.invoked) {
          advisorEvents.emit("advisor:invoked", {
            agent: "test-agent",
            turnId: "turn-1",
            toolUseId: "tool-1",
          });
        }
        if (emit?.resulted) {
          advisorEvents.emit("advisor:resulted", {
            agent: "test-agent",
            turnId: "turn-1",
            toolUseId: "tool-1",
            kind: "advisor_result",
            text: "advice",
          });
        }
        if (response instanceof Error) throw response;
        return response;
      }),
    };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    advisorEvents = new EventEmitter();
    mockSendResponse = vi.fn().mockResolvedValue(undefined);
    fakeLog = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };

    const mod = await import("../bridge.js");
    DiscordBridge = mod.DiscordBridge;

    bridge = new DiscordBridge({
      routingTableRef: { current: fakeRoutingTable },
      sessionManager: {
        forwardToAgent: vi.fn(),
        streamFromAgent: vi.fn(),
        getAgentConfig: vi
          .fn()
          .mockReturnValue({ workspace: "/tmp/test-agent" }),
        getTraceCollector: vi.fn().mockReturnValue(undefined),
        advisorEvents,
      } as unknown as import("../../manager/session-manager.js").SessionManager,
      botToken: "fake-token",
      log: fakeLog as unknown as import("pino").Logger,
    });

    (bridge as unknown as { sendResponse: typeof mockSendResponse }).sendResponse =
      mockSendResponse;
  });

  // ── Map lifecycle (helper-level) ──────────────────────────────────────────

  it("arm → increment on same trigger; overwrite on a new trigger", () => {
    const b = bridge as any;
    b.noteSteeredIntoFlight("test-agent", "T1", "s1");
    b.noteSteeredIntoFlight("test-agent", "T1", "s2");
    expect(b.steeredIntoFlight.get("test-agent")).toMatchObject({
      triggerMessageId: "T1",
      count: 2,
      lastSteerMessageId: "s2",
    });
    // New trigger → stale leftover replaced with a fresh count-1 entry.
    b.noteSteeredIntoFlight("test-agent", "T2", "s3");
    expect(b.steeredIntoFlight.get("test-agent")).toMatchObject({
      triggerMessageId: "T2",
      count: 1,
    });
  });

  it("consume: exact match returns + deletes; mismatch prunes; TTL prunes", () => {
    const b = bridge as any;
    b.noteSteeredIntoFlight("test-agent", "T1", "s1");
    expect(b.consumeSteeredIntoFlight("test-agent", "T1")).toMatchObject({
      count: 1,
    });
    expect(b.steeredIntoFlight.size).toBe(0);

    // Trigger mismatch → pruned, null.
    b.noteSteeredIntoFlight("test-agent", "T1", "s1");
    expect(b.consumeSteeredIntoFlight("test-agent", "OTHER")).toBeNull();
    expect(b.steeredIntoFlight.size).toBe(0);

    // Expired entry → pruned, null.
    b.steeredIntoFlight.set("test-agent", {
      triggerMessageId: "T1",
      count: 1,
      lastSteerMessageId: "s1",
      armedAt: Date.now() - 3 * 60 * 60 * 1000,
    });
    expect(b.consumeSteeredIntoFlight("test-agent", "T1")).toBeNull();
    expect(b.steeredIntoFlight.size).toBe(0);
  });

  it("clear: deletes only the failing dispatch's own entry", () => {
    const b = bridge as any;
    b.noteSteeredIntoFlight("test-agent", "T2", "s1");
    // An OLD dispatch (T1) failing must not wipe the NEW turn's entry.
    b.clearSteeredIntoFlight("test-agent", "T1");
    expect(b.steeredIntoFlight.get("test-agent")).toBeDefined();
    b.clearSteeredIntoFlight("test-agent", "T2");
    expect(b.steeredIntoFlight.size).toBe(0);
  });

  // ── Footer at the single mutation point ───────────────────────────────────

  it("armed for this dispatch → singular footer; map empty after", async () => {
    const msg = makeMessage({ messageId: "000000000000000026" });
    (bridge as any).turnDispatcher = buildTurnDispatcher("Answer body.");
    (bridge as any).noteSteeredIntoFlight("test-agent", "000000000000000026", "steer-1");

    await (bridge as any).streamAndPostResponse(msg, "test-agent", "hello");

    expect(mockSendResponse).toHaveBeenCalledTimes(1);
    const [, delivered] = mockSendResponse.mock.calls[0]!;
    expect(delivered).toBe(`Answer body.${STEERED_ONE}`);
    expect((bridge as any).steeredIntoFlight.size).toBe(0);
  });

  it("two steers into one turn → plural footer with count", async () => {
    const msg = makeMessage({ messageId: "000000000000000027" });
    (bridge as any).turnDispatcher = buildTurnDispatcher("Answer body.");
    (bridge as any).noteSteeredIntoFlight("test-agent", "000000000000000027", "s1");
    (bridge as any).noteSteeredIntoFlight("test-agent", "000000000000000027", "s2");

    await (bridge as any).streamAndPostResponse(msg, "test-agent", "hello");

    const [, delivered] = mockSendResponse.mock.calls[0]!;
    expect(delivered).toBe(`Answer body.${steeredMany(2)}`);
  });

  it("no entry → response byte-identical (no footer)", async () => {
    const msg = makeMessage({ messageId: "000000000000000028" });
    (bridge as any).turnDispatcher = buildTurnDispatcher("Answer body.");

    await (bridge as any).streamAndPostResponse(msg, "test-agent", "hello");

    const [, delivered] = mockSendResponse.mock.calls[0]!;
    expect(delivered).toBe("Answer body.");
  });

  it("entry armed for a DIFFERENT trigger → no footer AND pruned (stale-footer pin)", async () => {
    const msg = makeMessage({ messageId: "000000000000000029" });
    (bridge as any).turnDispatcher = buildTurnDispatcher("Answer body.");
    (bridge as any).noteSteeredIntoFlight("test-agent", "some-older-turn", "s1");

    await (bridge as any).streamAndPostResponse(msg, "test-agent", "hello");

    const [, delivered] = mockSendResponse.mock.calls[0]!;
    expect(delivered).toBe("Answer body.");
    expect((bridge as any).steeredIntoFlight.size).toBe(0);
  });

  it("composes with the advisor row — steered prose first, advisor metadata row last, all exits get ONE mutated response", async () => {
    const msg = makeMessage({ messageId: "000000000000000030" });
    (bridge as any).turnDispatcher = buildTurnDispatcher("Answer body.", {
      invoked: true,
      resulted: true,
    });
    (bridge as any).noteSteeredIntoFlight("test-agent", "000000000000000030", "s1");

    await (bridge as any).streamAndPostResponse(msg, "test-agent", "hello");

    const [, delivered] = mockSendResponse.mock.calls[0]!;
    expect(delivered).toBe(`Answer body.${STEERED_ONE}${ADVISOR_ROW}`);
  });

  it(">2000-char path receives the steered-augmented text via sendResponse (no silent bifurcation)", async () => {
    const msg = makeMessage({ messageId: "000000000000000031" });
    const longBody = "x".repeat(2050);
    (bridge as any).turnDispatcher = buildTurnDispatcher(longBody);
    (bridge as any).noteSteeredIntoFlight("test-agent", "000000000000000031", "s1");

    await (bridge as any).streamAndPostResponse(msg, "test-agent", "hello");

    const [, delivered] = mockSendResponse.mock.calls[0]!;
    expect(delivered.endsWith(STEERED_ONE.trim().slice(0, -1) + "*")).toBe(
      true,
    );
    expect(delivered.length).toBe(longBody.length + STEERED_ONE.length);
  });

  it("empty response → entry still consumed, no footer, no crash", async () => {
    const msg = makeMessage({ messageId: "000000000000000032" });
    (bridge as any).turnDispatcher = buildTurnDispatcher("");
    (bridge as any).noteSteeredIntoFlight("test-agent", "000000000000000032", "s1");

    await (bridge as any).streamAndPostResponse(msg, "test-agent", "hello");

    expect(mockSendResponse).not.toHaveBeenCalled();
    expect((bridge as any).steeredIntoFlight.size).toBe(0);
  });

  // ── Failure path ──────────────────────────────────────────────────────────

  it("dispatch failure → catch-head clear; a later turn gets no stale footer", async () => {
    const msg = makeMessage({ messageId: "000000000000000033" });
    (bridge as any).turnDispatcher = buildTurnDispatcher(
      new Error("terminal boom"),
    );
    (bridge as any).noteSteeredIntoFlight("test-agent", "000000000000000033", "s1");

    await (bridge as any).streamAndPostResponse(msg, "test-agent", "hello");

    // Entry cleared at the catch head — the failed dispatch never delivered.
    expect((bridge as any).steeredIntoFlight.size).toBe(0);
    expect(mockSendResponse).not.toHaveBeenCalled();

    // A subsequent clean turn (new trigger) delivers WITHOUT any footer.
    const msg2 = makeMessage({ messageId: "000000000000000034" });
    (bridge as any).turnDispatcher = buildTurnDispatcher("Fresh answer.");
    await (bridge as any).streamAndPostResponse(msg2, "test-agent", "hello");
    const [, delivered] = mockSendResponse.mock.calls[0]!;
    expect(delivered).toBe("Fresh answer.");
  });

  // ── Write site: tryMidturnRoute arms + logs `indicated` ───────────────────

  it("tryMidturnRoute steer (heuristic reply-to-trigger) → 🧭 + armed entry + indicated:true log", async () => {
    const b = bridge as any;
    // A running turn triggered by head-msg is in flight.
    b.pushInFlightTrigger("test-agent", {
      messageId: "head-msg",
      channelId: "chan-1",
      excerpt: "original ask",
      startedAt: Date.now(),
    });
    // Steering-capable session mocks.
    const sm = (bridge as any).sessionManager;
    sm.getAgentConfig = vi.fn().mockReturnValue({
      workspace: "/tmp/test-agent",
      steering: {
        autoClassify: true,
        stopIntent: true,
        maxInjectionsPerTurn: 3,
        minConfidence: 0.75,
        stopMinConfidence: 0.85,
        classifierTimeoutMs: 4000,
      },
    });
    sm.hasActiveTurn = vi.fn().mockReturnValue(true);
    sm.hasAttributedStream = vi.fn().mockReturnValue(true);
    sm.injectMidTurn = vi.fn().mockReturnValue({ injected: true });

    // The steer is a Discord REPLY to the running turn's trigger →
    // deterministic heuristic, no classifier call.
    const steerMsg = makeMessage({
      messageId: "steer-msg",
      content: "actually make it monthly",
      referenceMessageId: "head-msg",
    });

    const handled = await b.tryMidturnRoute(
      steerMsg,
      "test-agent",
      "chan-1",
      "actually make it monthly",
      undefined,
    );

    expect(handled).toMatchObject({ handled: true });
    expect((steerMsg as any).react).toHaveBeenCalledWith("🧭");
    expect(b.steeredIntoFlight.get("test-agent")).toMatchObject({
      triggerMessageId: "head-msg",
      count: 1,
      lastSteerMessageId: "steer-msg",
    });
    // The routed log carries the additive `indicated` field.
    const routedCall = fakeLog.info.mock.calls.find(
      (c) => c[1] === "midturn-intent routed",
    );
    expect(routedCall?.[0]).toMatchObject({
      action: "steered",
      indicated: true,
    });
  });
});
