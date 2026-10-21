/**
 * 999.171 — live thinking in the status trail, end to end through
 * streamAndPostResponse.
 *
 *   SC-1  an opted-in agent shows `**Thinking · <elapsed>**` over
 *         `-# → thinking · N tokens` before the first tool; elapsed moves with
 *         no tool event; the first tool replaces the line and it is never a ✓.
 *   SC-2  an agent with live thinking off renders byte-identically, even when
 *         thinking frames are emitted for its turn.
 *   SC-3  the /clawcode-ux override flips the very next turn on the same bridge.
 *   SC-4  frames for any other turn id never paint this turn; the sink and the
 *         ticker are gone once the turn ends.
 * Plus the phantom guard, the thinking-only settle (operator decision
 * 2026-09-24: keep the message as `-# Thought for <elapsed>`), and its
 * gate-off and no-thinking counterparts, which still delete.
 *
 * Harness copied from bridge-status-message.test.ts (not imported: that file
 * is the unmodified SC-2 regression guard). Real timers throughout; the clock
 * is real time plus a controllable offset so the repaint scheduler's interval
 * arithmetic still advances between ticks.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Attachment, Collection, Message } from "discord.js";
import { resetClaimSinksForTests } from "../../manager/claim-sink.js";
import {
  emitThinkingTokens,
  hasThinkingSink,
  resetThinkingSinksForTests,
} from "../../manager/thinking-sink.js";
import {
  resetUxFeatureOverridesForTests,
  setUxFeatureOverride,
} from "../../manager/ux-feature-state-store.js";
import { formatDuration } from "../duration-format.js";

/** Every repaint scheduler the bridge creates, so a test can assert it stopped. */
const schedulers = vi.hoisted(() => [] as Array<{ readonly stopped: boolean }>);

vi.mock("../trail-repaint.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../trail-repaint.js")>();
  return {
    ...actual,
    createTrailRepaintScheduler: (
      opts: Parameters<typeof actual.createTrailRepaintScheduler>[0],
    ) => {
      const s = actual.createTrailRepaintScheduler(opts);
      schedulers.push(s);
      return s;
    },
  };
});

vi.mock("../attachments.js", () => ({
  extractAttachments: vi.fn(),
  downloadAllAttachments: vi.fn(),
  formatAttachmentMetadata: vi.fn(),
  isImageAttachment: vi.fn(),
}));

interface SentMessage {
  id: string;
  content: string;
  edits: unknown[];
  deleted: boolean;
  edit: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  react: ReturnType<typeof vi.fn>;
}

function makeMessage(sent: SentMessage[], id = "000000000000000004", sendDelayMs = 0) {
  const attMap = new Map<string, Attachment>();
  const collection = {
    size: 0,
    values: () => attMap.values(),
    [Symbol.iterator]: () => attMap.values(),
    map: <T,>(_fn: (a: Attachment) => T): T[] => [],
  } as unknown as Collection<string, Attachment>;
  const asText = (c: unknown): string => (typeof c === "string" ? c : ((c as { content?: string })?.content ?? ""));
  const send = vi.fn().mockImplementation(async (payload: unknown) => {
    // A slow Discord POST: the message exists only once the send resolves.
    if (sendDelayMs > 0) await new Promise<void>((r) => setTimeout(r, sendDelayMs));
    const content = asText(payload);
    const m: SentMessage = {
      id: `sent-${sent.length + 1}`,
      content,
      edits: [],
      deleted: false,
      edit: vi.fn().mockImplementation(async (c: unknown) => { m.edits.push(asText(c)); return undefined; }),
      delete: vi.fn().mockImplementation(async () => { m.deleted = true; return undefined; }),
      react: vi.fn().mockResolvedValue(undefined),
    };
    sent.push(m);
    return m;
  });
  return {
    content: "think this through: should I move the long run to Sunday",
    channelId: "chan-1",
    id,
    author: { username: "sam", bot: false, id: "u-1" },
    createdAt: new Date("2026-09-24T00:00:00Z"),
    attachments: collection,
    reference: null,
    webhookId: null,
    embeds: [],
    react: vi.fn().mockResolvedValue(undefined),
    channel: { sendTyping: vi.fn(), send },
  } as unknown as Message;
}

function makeTurn(id = "turn-1") {
  return {
    id,
    startSpan: () => ({ end: () => undefined, setAttribute: () => undefined }),
    recordToolCall: () => undefined,
    recordToolResultText: () => undefined,
    recordEvidence: () => undefined,
    recordClaim: () => undefined,
    getEvidence: () => [],
    getClaims: () => [],
    getToolResultText: () => "",
    end: () => undefined,
  } as never;
}

const AGENT = "personal";
const THREAD_SESSION = `${AGENT}-thread-thread-1`;
const TICK_MS = 20;
const UX_BASE = { streamStatus: true, streamStatusMode: "always" as const, liveClaims: true };
const SEPARATE = { ...UX_BASE, statusMessage: "separate" as const };
const ON = { liveThinking: true };
const ANSWER = "Move it to Sunday. Saturday stays easy.";
const TIMING = { tickMs: TICK_MS, firstPaintMinMs: 0 };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const textsOf = (m: SentMessage): string[] => [m.content, ...m.edits.map(String)];
const allText = (sent: SentMessage[]): string => sent.flatMap(textsOf).join("\n");
const lastText = (m: SentMessage): string => String(m.edits.at(-1) ?? m.content);
const writeCount = (sent: SentMessage[]): number =>
  sent.reduce((n, m) => n + 1 + m.edits.length, 0);

type Io = {
  readonly onChunk: (s: string) => void;
  readonly onToolUse: (name: string, input?: unknown) => void;
};

describe("live thinking in the status trail (999.171)", () => {
  let DiscordBridge: typeof import("../bridge.js").DiscordBridge;
  let advisorEvents: EventEmitter;
  const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const routingTable = {
    channelToAgent: new Map([["chan-1", AGENT]]),
    agentToChannels: new Map([[AGENT, ["chan-1"]]]),
  };
  const realNow = Date.now.bind(Date);
  let offset = 0;
  /** When set, the clock stops at this real instant (only safe with no ticker running). */
  let frozenAt: number | null = null;

  // The first bridge import takes ~7 s on this box (and longer under load):
  // do it once, outside the 10 s per-hook default.
  beforeAll(async () => {
    DiscordBridge = (await import("../bridge.js")).DiscordBridge;
  }, 120_000);

  beforeEach(() => {
    vi.clearAllMocks();
    schedulers.length = 0;
    resetClaimSinksForTests();
    resetThinkingSinksForTests();
    resetUxFeatureOverridesForTests();
    offset = 0;
    frozenAt = null;
    vi.spyOn(Date, "now").mockImplementation(() => (frozenAt ?? realNow()) + offset);
    advisorEvents = new EventEmitter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetUxFeatureOverridesForTests();
    resetThinkingSinksForTests();
  });

  function agentConfig(ux: Record<string, unknown>, uxFeatures?: Record<string, boolean>, editIntervalMs = 10) {
    return {
      workspace: "/tmp/personal",
      verification: { ux },
      // A short edit interval keeps catch-up paints inside a few ticks.
      perf: { streaming: { editIntervalMs } },
      ...(uxFeatures ? { uxFeatures } : {}),
    };
  }

  function makeBridge(o: {
    ux: Record<string, unknown>;
    uxFeatures?: Record<string, boolean>;
    /** null = omit the test seam (production defaults: 5 s tick, 5 s floor). */
    timing?: { tickMs?: number; firstPaintMinMs?: number } | null;
    editIntervalMs?: number;
    /** sessionManager.hasActiveTurn (omitted unless a test needs it). */
    hasActiveTurn?: () => boolean;
    /** The thread session's own config: a snapshot of the parent's, taken at thread creation. */
    threadUxFeatures?: Record<string, boolean>;
  }) {
    const cfg = { current: agentConfig(o.ux, o.uxFeatures, o.editIntervalMs) as Record<string, unknown> };
    const threadCfg = agentConfig(o.ux, o.threadUxFeatures, o.editIntervalMs) as Record<string, unknown>;
    const bridge = new DiscordBridge({
      routingTableRef: { current: routingTable },
      sessionManager: {
        forwardToAgent: vi.fn(),
        streamFromAgent: vi.fn(),
        getAgentConfig: vi.fn((name: string) => (name === THREAD_SESSION ? threadCfg : cfg.current)),
        getTraceCollector: vi.fn().mockReturnValue(undefined),
        advisorEvents,
        ...(o.hasActiveTurn ? { hasActiveTurn: vi.fn(o.hasActiveTurn) } : {}),
      } as never,
      botToken: "fake-token",
      log: log as never,
      ...(o.timing === null ? {} : { liveThinkingTiming: o.timing ?? TIMING }),
    });
    (bridge as unknown as { sendResponse: unknown }).sendResponse = vi.fn().mockResolvedValue(undefined);
    return { bridge, cfg };
  }

  function wire(bridge: InstanceType<typeof DiscordBridge>, script: (io: Io) => Promise<string>) {
    const dispatchStream = vi.fn().mockImplementation(
      async (
        _origin: unknown,
        _agent: string,
        _formatted: string,
        onChunk: (s: string) => void,
        options?: { onToolUse?: (n: string, i?: unknown) => void },
      ) => script({ onChunk, onToolUse: (n, i) => options?.onToolUse?.(n, i) }),
    );
    (bridge as unknown as { turnDispatcher: unknown }).turnDispatcher = {
      dispatchStream,
      getLedgerSnapshot: () => ({ evidence: [], claims: [], modelCitedHosts: [] }),
    };
    return dispatchStream;
  }

  async function run(
    bridge: InstanceType<typeof DiscordBridge>,
    sent: SentMessage[],
    turnId = "turn-1",
    messageId?: string,
    sendDelayMs = 0,
  ): Promise<void> {
    await (bridge as never as { streamAndPostResponse: (...a: unknown[]) => Promise<void> })
      .streamAndPostResponse(makeMessage(sent, messageId, sendDelayMs), AGENT, "think this through", makeTurn(turnId));
  }

  /** A message in a Discord thread under chan-1, routed to the thread session. */
  async function runInThread(bridge: InstanceType<typeof DiscordBridge>, sent: SentMessage[]): Promise<void> {
    const message = makeMessage(sent) as unknown as { channelId: string; channel: Record<string, unknown> };
    message.channelId = "thread-1";
    message.channel.isThread = () => true;
    message.channel.parentId = "chan-1";
    await (bridge as never as { streamAndPostResponse: (...a: unknown[]) => Promise<void> })
      .streamAndPostResponse(message, THREAD_SESSION, "think this through", makeTurn("turn-1"));
  }

  /** A thinking-only turn: frames for `turnId`, a pause, then the answer. */
  const thinkingOnly = (turnId: string) => async ({ onChunk }: Io): Promise<string> => {
    emitThinkingTokens(turnId, { estimatedTokens: 800 });
    emitThinkingTokens(turnId, { estimatedTokens: 2_400 });
    await sleep(TICK_MS * 4);
    onChunk(ANSWER);
    await sleep(5);
    return ANSWER;
  };

  it("999.178 R1 thinking-arm: a tool-less thinking turn in AUTO mode (non-topic prompt) still posts a Thinking status", async () => {
    const sent: SentMessage[] = [];
    // AUTO mode + "think this through" (not a financial-topic prompt) means the
    // trail starts UNARMED; the only path to a paint is the thinking-arm. Before
    // R1 this turn painted nothing (the quiet arm needs a tool event).
    const AUTO = { ...SEPARATE, streamStatusMode: "auto" as const };
    const { bridge } = makeBridge({ ux: AUTO, uxFeatures: ON });
    let during = "";
    wire(bridge, async ({ onChunk }) => {
      emitThinkingTokens("turn-1", { estimatedTokens: 800 });
      emitThinkingTokens("turn-1", { estimatedTokens: 2_400 });
      await sleep(TICK_MS * 8);
      during = allText(sent);
      onChunk(ANSWER);
      await sleep(5);
      return ANSWER;
    });
    await run(bridge, sent);
    expect(during).toContain("**Thinking");
  }, 30_000);

  it("SC-1: before the first tool the status shows **Thinking** over the live token line", async () => {
    const sent: SentMessage[] = [];
    const { bridge } = makeBridge({ ux: SEPARATE, uxFeatures: ON });
    let during = "";
    wire(bridge, async ({ onChunk }) => {
      emitThinkingTokens("turn-1", { estimatedTokens: 800 });
      emitThinkingTokens("turn-1", { estimatedTokens: 2_400 });
      await sleep(TICK_MS * 4);
      during = allText(sent);
      onChunk(ANSWER);
      await sleep(5);
      return ANSWER;
    });
    await run(bridge, sent);

    expect(during).toContain("**Thinking");
    expect(during).toContain("-# → thinking · 2.4k tokens");
    // The status message was posted first, before the answer.
    expect(sent[0].content).toContain("**Thinking");
    expect(sent[1].content).toContain("Move it to Sunday");
  }, 30_000);

  it("SC-1: the first tool replaces the thinking line, the header becomes Working, and thinking is never a ✓ line", async () => {
    const sent: SentMessage[] = [];
    const { bridge } = makeBridge({ ux: SEPARATE, uxFeatures: ON });
    let afterTool = "";
    let afterSecondThink = "";
    wire(bridge, async ({ onChunk, onToolUse }) => {
      emitThinkingTokens("turn-1", { estimatedTokens: 2_400 });
      await sleep(TICK_MS * 3);
      onToolUse("WebFetch", { url: "https://www.irs.gov/x" });
      await sleep(TICK_MS * 3);
      afterTool = lastText(sent[0]);
      emitThinkingTokens("turn-1", { estimatedTokens: 3_000 });
      await sleep(TICK_MS * 3);
      afterSecondThink = lastText(sent[0]);
      onToolUse("WebSearch", { query: "long run recovery" });
      await sleep(TICK_MS * 3);
      onChunk(ANSWER);
      await sleep(5);
      return ANSWER;
    });
    await run(bridge, sent);

    expect(afterTool).toContain("→ reading irs.gov…");
    expect(afterTool).toContain("**Working · 1 step");
    expect(afterTool).not.toContain("thinking");
    // think / tool / think: the new think is the current line under the done tool.
    expect(afterSecondThink).toContain("-# ✓ reading irs.gov");
    expect(afterSecondThink).toContain("-# → thinking · 3.0k tokens");
    expect(afterSecondThink).toContain("**Working · 1 step");
    expect(allText(sent)).not.toContain("✓ thinking");
  }, 30_000);

  it("SC-1: elapsed time advances while only thinking is happening (no tool event)", async () => {
    const sent: SentMessage[] = [];
    const { bridge } = makeBridge({ ux: SEPARATE, uxFeatures: ON });
    let headers: string[] = [];
    wire(bridge, async ({ onChunk }) => {
      emitThinkingTokens("turn-1", { estimatedTokens: 800 });
      await sleep(TICK_MS * 3);
      offset = 6_000;
      await sleep(TICK_MS * 4);
      offset = 12_000;
      await sleep(TICK_MS * 4);
      headers = [...allText(sent).matchAll(/\*\*Thinking · ([^*]+)\*\*/g)].map((m) => m[1]!);
      onChunk(ANSWER);
      await sleep(5);
      return ANSWER;
    });
    await run(bridge, sent);

    // Only ONE thinking frame arrived, before the clock moved: every elapsed
    // header after it came from the repaint ticker alone.
    expect(new Set(headers).size).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it("the ticker stops when the turn settles: no edit afterwards, sink gone", async () => {
    const sent: SentMessage[] = [];
    const { bridge } = makeBridge({ ux: SEPARATE, uxFeatures: ON });
    wire(bridge, async ({ onChunk, onToolUse }) => {
      emitThinkingTokens("turn-1", { estimatedTokens: 800 });
      await sleep(TICK_MS * 2);
      onToolUse("WebFetch", { url: "https://www.irs.gov/x" });
      await sleep(TICK_MS * 2);
      onChunk(ANSWER);
      await sleep(5);
      return ANSWER;
    });
    await run(bridge, sent);

    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]!.stopped).toBe(true);
    expect(hasThinkingSink("turn-1")).toBe(false);
    const writes = writeCount(sent);
    offset += 7_000; // a live ticker would now have a new header to paint
    await sleep(TICK_MS * 5);
    expect(writeCount(sent)).toBe(writes);
  }, 30_000);

  it("MD-03: a dispatch that never settles cannot keep the ticker editing past the typing heartbeat's caps", async () => {
    // (a) The turn still reads as active: past the 10 min soft cap it keeps
    // going; the 60 min absolute cap stops it.
    const sentA: SentMessage[] = [];
    const a = makeBridge({ ux: SEPARATE, uxFeatures: ON, hasActiveTurn: () => true });
    const stoppedA: boolean[] = [];
    let writesAfterCapA = -1;
    wire(a.bridge, async ({ onChunk, onToolUse }) => {
      onToolUse("WebFetch", { url: "https://www.irs.gov/x" });
      await sleep(TICK_MS * 3);
      offset = 30 * 60_000;
      await sleep(TICK_MS * 4);
      stoppedA.push(schedulers[0]!.stopped);
      offset = 61 * 60_000;
      await sleep(TICK_MS * 4);
      stoppedA.push(schedulers[0]!.stopped);
      const writes = writeCount(sentA);
      offset = 70 * 60_000; // a live ticker would have a new header to paint
      await sleep(TICK_MS * 5);
      writesAfterCapA = writeCount(sentA) - writes;
      onChunk(ANSWER);
      await sleep(5);
      return ANSWER;
    });
    await run(a.bridge, sentA);
    expect(stoppedA).toEqual([false, true]);
    expect(writesAfterCapA).toBe(0);
    expect(log.warn.mock.calls.some((c) => String(c[1]).includes("hard-capped"))).toBe(true);

    // (b) No turn in flight any more (generator-dead wedge): the soft cap stops it.
    schedulers.length = 0;
    offset = 0;
    const sentB: SentMessage[] = [];
    const b = makeBridge({ ux: SEPARATE, uxFeatures: ON, hasActiveTurn: () => false });
    const stoppedB: boolean[] = [];
    wire(b.bridge, async ({ onChunk, onToolUse }) => {
      onToolUse("WebFetch", { url: "https://www.irs.gov/x" });
      await sleep(TICK_MS * 3);
      offset = 9 * 60_000;
      await sleep(TICK_MS * 4);
      stoppedB.push(schedulers[0]!.stopped);
      offset = 11 * 60_000;
      await sleep(TICK_MS * 4);
      stoppedB.push(schedulers[0]!.stopped);
      onChunk(ANSWER);
      await sleep(5);
      return ANSWER;
    });
    await run(b.bridge, sentB);
    expect(stoppedB).toEqual([false, true]);
  }, 30_000);

  it("LO-03: in separate mode the ticker stops editing the status card once the answer is streaming", async () => {
    const sent: SentMessage[] = [];
    const { bridge } = makeBridge({ ux: SEPARATE, uxFeatures: ON });
    let statusEditsWhileStreaming = -1;
    wire(bridge, async ({ onChunk, onToolUse }) => {
      emitThinkingTokens("turn-1", { estimatedTokens: 800 });
      onToolUse("WebFetch", { url: "https://www.irs.gov/x" });
      await sleep(TICK_MS * 3);
      onChunk(ANSWER); // the answer starts streaming into its own message
      await sleep(TICK_MS * 3);
      const before = sent[0]!.edits.length;
      offset = 61_000; // the header's elapsed moves: a live ticker would repaint it
      await sleep(TICK_MS * 6);
      statusEditsWhileStreaming = sent[0]!.edits.length - before;
      return ANSWER;
    });
    await run(bridge, sent);

    expect(sent[1]!.content).toContain("Move it to Sunday");
    expect(statusEditsWhileStreaming).toBe(0);
    expect(lastText(sent[0]!)).toMatch(/^-# Checked 1 step · /); // settle still rewrites the card
  }, 30_000);

  it("a turn that throws still stops the ticker and drops the sink (finally backstop)", async () => {
    const sent: SentMessage[] = [];
    const { bridge } = makeBridge({ ux: SEPARATE, uxFeatures: ON });
    wire(bridge, async () => {
      emitThinkingTokens("turn-1", { estimatedTokens: 800 });
      await sleep(TICK_MS * 2);
      throw new Error("model backend exploded");
    });
    await run(bridge, sent);

    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]!.stopped).toBe(true);
    expect(hasThinkingSink("turn-1")).toBe(false);
  }, 30_000);

  it("each exit stops the ticker before its next write: the delivery site before drafts, settle before its line", async () => {
    // (a) Delivered answer: drafts are posted after delivery and before settle.
    const sentA: SentMessage[] = [];
    const a = makeBridge({ ux: SEPARATE, uxFeatures: ON });
    const stoppedAtDraft: boolean[] = [];
    (a.bridge as unknown as { sendResponse: unknown }).sendResponse = vi.fn(async () => {
      stoppedAtDraft.push(schedulers[0]!.stopped);
    });
    const withDraft = "Here is the note.\n\n```draft\nSee you Sunday for the long run.\n```";
    wire(a.bridge, async ({ onChunk }) => {
      emitThinkingTokens("turn-1", { estimatedTokens: 800 });
      await sleep(TICK_MS * 2);
      onChunk(withDraft);
      await sleep(5);
      return withDraft;
    });
    await run(a.bridge, sentA);
    expect(stoppedAtDraft).toEqual([true]);

    // (b) Empty response: no delivery site runs, so settle's failure line is
    // the first write after dispatch and must already see a stopped ticker.
    schedulers.length = 0;
    const sentB: SentMessage[] = [];
    const b = makeBridge({ ux: SEPARATE, uxFeatures: ON });
    const settleWrites: Array<[string, boolean]> = [];
    wire(b.bridge, async ({ onToolUse }) => {
      emitThinkingTokens("turn-1", { estimatedTokens: 800 });
      onToolUse("WebFetch", { url: "https://www.irs.gov/x" });
      await sleep(TICK_MS * 3);
      const status = sentB[0]!;
      const orig = status.edit.getMockImplementation() as (c: unknown) => Promise<undefined>;
      status.edit.mockImplementation(async (c: unknown) => {
        settleWrites.push([String(c), schedulers[0]!.stopped]);
        return orig(c);
      });
      return "";
    });
    await run(b.bridge, sentB);
    // 999.178 R1 — the dead "· react 🔍 to retry" text is gone from the settle
    // line. (A no-answer Retry button is deferred as unsafe — see the bridge
    // success-tail comment.)
    expect(settleWrites.at(-1)).toEqual(["-# No answer produced", true]);
  }, 30_000);

  it("LO-02: settle waits for a status post still in flight, so an empty turn gets its failure line", async () => {
    // The ticker's first post is a slow POST; the turn ends empty meanwhile.
    const sent: SentMessage[] = [];
    const { bridge } = makeBridge({ ux: SEPARATE, uxFeatures: ON });
    wire(bridge, async () => {
      emitThinkingTokens("turn-1", { estimatedTokens: 800 });
      await sleep(TICK_MS * 2); // the ticker has started posting the card
      return "";
    });
    await run(bridge, sent, "turn-1", undefined, 300);
    await sleep(400);

    // 999.178 R1 — the dead "· react 🔍 to retry" is gone; the status line is
    // just the one-liner. (A ❌/Retry on no-answer turns is deferred — see the
    // bridge success-tail comment — so no extra message is posted here.)
    expect(sent).toHaveLength(1);
    expect(lastText(sent[0]!)).toBe("-# No answer produced");
  }, 30_000);

  it("LO-02 x MD-02: a thinking-only first post still in flight at settle is kept as the thought line, not deleted", async () => {
    // Settle waits for the in-flight POST; the controller must already count
    // it as its own post by then, or settle reads the latch too early.
    const sent: SentMessage[] = [];
    const { bridge } = makeBridge({ ux: SEPARATE, uxFeatures: ON });
    wire(bridge, async () => {
      emitThinkingTokens("turn-1", { estimatedTokens: 800 });
      await sleep(TICK_MS * 2); // the ticker has started posting the card
      return ANSWER; // delivered through sendResponse; no draft streamed
    });
    await run(bridge, sent, "turn-1", undefined, 300);
    await sleep(400);

    expect(sent).toHaveLength(1);
    expect(lastText(sent[0]!)).toMatch(/^-# Thought for /);
    expect(sent[0]!.deleted).toBe(false);
  }, 30_000);

  it("LO-02: inline mode waits for a slot post still in flight, so an empty turn deletes it", async () => {
    const sent: SentMessage[] = [];
    const { bridge } = makeBridge({ ux: UX_BASE, uxFeatures: ON });
    wire(bridge, async () => {
      emitThinkingTokens("turn-1", { estimatedTokens: 800 });
      await sleep(TICK_MS * 2);
      return "";
    });
    await run(bridge, sent, "turn-1", undefined, 300);
    await sleep(400);

    // 999.178 R1 — the in-flight slot is still deleted on an empty turn. (The
    // no-answer ❌/Retry is deferred — see the bridge success-tail comment — so
    // no extra message is posted.)
    expect(sent).toHaveLength(1);
    expect(sent[0]!.deleted).toBe(true);
  }, 30_000);

  it("SC-2: with live thinking off, a turn renders byte-identically whether or not thinking frames arrive", async () => {
    let sinkSeen = false;
    const script = (withThinking: boolean) => async ({ onChunk, onToolUse }: Io): Promise<string> => {
      if (withThinking) {
        emitThinkingTokens("turn-1", { estimatedTokens: 800 });
        emitThinkingTokens("turn-1", { estimatedTokens: 2_400 });
      }
      await sleep(TICK_MS * 2);
      onToolUse("WebFetch", { url: "https://www.irs.gov/x" });
      if (withThinking) emitThinkingTokens("turn-1", { estimatedTokens: 3_000 });
      await sleep(TICK_MS * 3);
      sinkSeen = sinkSeen || hasThinkingSink("turn-1");
      onChunk(ANSWER);
      await sleep(5);
      return ANSWER;
    };
    // Live thinking is off, so no scheduler runs: freeze the clock so both runs
    // settle with the same duration however slow the box is.
    frozenAt = realNow();
    const plain: SentMessage[] = [];
    const a = makeBridge({ ux: SEPARATE });
    wire(a.bridge, script(false));
    await run(a.bridge, plain);
    await sleep(TICK_MS * 5);

    const withFrames: SentMessage[] = [];
    const b = makeBridge({ ux: SEPARATE });
    wire(b.bridge, script(true));
    await run(b.bridge, withFrames);
    await sleep(TICK_MS * 5);

    const shape = (s: SentMessage[]) => s.map((m) => ({ content: m.content, edits: m.edits, deleted: m.deleted }));
    expect(shape(withFrames)).toEqual(shape(plain));
    expect(allText(withFrames).toLowerCase()).not.toContain("thinking");
    expect(sinkSeen).toBe(false);
    expect(schedulers).toHaveLength(0);
  }, 30_000);

  it("SC-3: the /clawcode-ux override flips the very next turn on the same bridge, both ways", async () => {
    const { bridge, cfg } = makeBridge({ ux: SEPARATE, uxFeatures: { liveThinking: false } });
    setUxFeatureOverride(AGENT, { liveThinking: true });
    wire(bridge, thinkingOnly("turn-1"));
    const first: SentMessage[] = [];
    await run(bridge, first, "turn-1", "000000000000000004");
    expect(allText(first)).toContain("→ thinking · ");

    cfg.current = agentConfig(SEPARATE, { liveThinking: true });
    setUxFeatureOverride(AGENT, { liveThinking: false });
    wire(bridge, thinkingOnly("turn-2"));
    const second: SentMessage[] = [];
    await run(bridge, second, "turn-2", "000000000000000005");
    expect(allText(second).toLowerCase()).not.toContain("thinking");
    expect(second).toHaveLength(1); // the answer only
  }, 30_000);

  describe("MD-01: a thread session follows its parent agent's toggle", () => {
    it("the /clawcode-ux override on the parent turns live thinking on inside its threads", async () => {
      const sent: SentMessage[] = [];
      const { bridge } = makeBridge({ ux: SEPARATE, uxFeatures: { liveThinking: false }, threadUxFeatures: { liveThinking: false } });
      setUxFeatureOverride(AGENT, { liveThinking: true });
      wire(bridge, thinkingOnly("turn-1"));
      await runInThread(bridge, sent);
      expect(allText(sent)).toContain("→ thinking · ");
    }, 30_000);

    it("the documented rollback (/clawcode-ux thinking off on the parent) reaches a thread whose snapshot says on", async () => {
      const sent: SentMessage[] = [];
      const { bridge } = makeBridge({ ux: SEPARATE, uxFeatures: { liveThinking: true }, threadUxFeatures: { liveThinking: true } });
      setUxFeatureOverride(AGENT, { liveThinking: false });
      wire(bridge, thinkingOnly("turn-1"));
      await runInThread(bridge, sent);
      expect(allText(sent).toLowerCase()).not.toContain("thinking");
      expect(schedulers).toHaveLength(0);
    }, 30_000);

    it("a yaml reload of the parent reaches existing threads (their snapshot is not consulted)", async () => {
      const sent: SentMessage[] = [];
      // Thread created while yaml said on; yaml since flipped off + reloaded.
      const { bridge } = makeBridge({ ux: SEPARATE, uxFeatures: { liveThinking: false }, threadUxFeatures: { liveThinking: true } });
      wire(bridge, thinkingOnly("turn-1"));
      await runInThread(bridge, sent);
      expect(allText(sent).toLowerCase()).not.toContain("thinking");
      expect(schedulers).toHaveLength(0);
    }, 30_000);
  });

  it("SC-4: thinking frames for another turn id never change this turn's status message", async () => {
    const sent: SentMessage[] = [];
    const { bridge } = makeBridge({ ux: SEPARATE, uxFeatures: ON });
    let writesAfterForeign = -1;
    wire(bridge, async ({ onChunk, onToolUse }) => {
      onToolUse("WebFetch", { url: "https://www.irs.gov/x" });
      await sleep(TICK_MS * 3);
      const before = writeCount(sent);
      emitThinkingTokens("some-other-turn", { estimatedTokens: 5_000 });
      await sleep(TICK_MS * 4);
      writesAfterForeign = writeCount(sent) - before;
      onChunk(ANSWER);
      await sleep(5);
      return ANSWER;
    });
    await run(bridge, sent);

    expect(writesAfterForeign).toBe(0);
    expect(allText(sent)).not.toContain("5.0k");
    expect(allText(sent)).not.toContain("thinking");
    expect(log.debug.mock.calls.filter((c) => c[1] === "thinking-tokens")).toHaveLength(0);
  }, 30_000);

  it("phantom guard: a thinking-only turn that answers before the 5 s floor posts no status message", async () => {
    const sent: SentMessage[] = [];
    const { bridge } = makeBridge({ ux: SEPARATE, uxFeatures: ON, timing: null });
    let sinkLive = false;
    wire(bridge, async ({ onChunk }) => {
      emitThinkingTokens("turn-1", { estimatedTokens: 800 });
      emitThinkingTokens("turn-1", { estimatedTokens: 2_400 });
      sinkLive = hasThinkingSink("turn-1");
      await sleep(30);
      onChunk(ANSWER);
      await sleep(5);
      return ANSWER;
    });
    await run(bridge, sent);

    expect(sinkLive).toBe(true); // live thinking WAS on; the floor kept it quiet
    expect(sent).toHaveLength(1);
    expect(sent[0].content).toContain("Move it to Sunday");
    expect(allText(sent).toLowerCase()).not.toContain("thinking");
  }, 30_000);

  it("thinking-only settle: a posted status is KEPT and settles to `-# Thought for <elapsed>`", async () => {
    const sent: SentMessage[] = [];
    // Real 5 s floor (seam sets only the tick).
    const { bridge } = makeBridge({ ux: SEPARATE, uxFeatures: ON, timing: { tickMs: TICK_MS } });
    let postedBeforeFloor = -1;
    let postedAfterFloor = -1;
    wire(bridge, async ({ onChunk }) => {
      emitThinkingTokens("turn-1", { estimatedTokens: 800 });
      await sleep(TICK_MS * 3);
      postedBeforeFloor = sent.length;
      offset = 6_000;
      emitThinkingTokens("turn-1", { estimatedTokens: 2_400 });
      await sleep(TICK_MS * 4);
      postedAfterFloor = sent.length;
      offset = 65_000;
      onChunk(ANSWER);
      await sleep(5);
      return ANSWER;
    });
    const t0 = realNow();
    await run(bridge, sent);
    const t1 = realNow();

    expect(postedBeforeFloor).toBe(0);
    expect(postedAfterFloor).toBe(1);
    const status = sent[0];
    const last = lastText(status);
    expect(last).toMatch(/^-# Thought for \S.*$/);
    const lo = Math.round(65_000 / 1000);
    const hi = Math.round((65_000 + (t1 - t0)) / 1000);
    const allowed: string[] = [];
    for (let s = lo; s <= hi; s++) allowed.push(`-# Thought for ${formatDuration(s, { precise: true })}`);
    expect(allowed).toContain(last);
    expect(status.deleted).toBe(false);
    expect(last).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(last).not.toMatch(/[✓→]/u);
    expect(allText(sent)).not.toContain("Checked");
  }, 30_000);

  it("settle gap (verifier repro): a sub-floor think, then a narration-posted card with no tool or claim, is DELETED", async () => {
    // Personal's staged config: always + narrationAsTrail + separate, gate on,
    // real 5 s floor. The think stays under the floor, so live thinking never
    // posts; the short newline-free reply is diverted as a speech item and
    // THAT posts the card. Nothing thinking posted, so settle behaves as it
    // did before this phase: no work, delete.
    const sent: SentMessage[] = [];
    const { bridge } = makeBridge({
      ux: { ...SEPARATE, narrationAsTrail: true },
      uxFeatures: ON,
      timing: { tickMs: TICK_MS },
    });
    const reply = "Done, moved it to Friday.";
    let postedBeforeNarration = -1;
    let postedAfterNarration = -1;
    wire(bridge, async ({ onChunk }) => {
      emitThinkingTokens("turn-1", { estimatedTokens: 185 });
      await sleep(TICK_MS * 3);
      postedBeforeNarration = sent.length;
      onChunk(reply);
      await sleep(TICK_MS * 3);
      postedAfterNarration = sent.length;
      return reply;
    });
    await run(bridge, sent);

    expect(postedBeforeNarration).toBe(0);
    expect(postedAfterNarration).toBe(1);
    expect(sent).toHaveLength(1); // the reply itself went out through sendResponse
    expect(sent[0].deleted).toBe(true);
    expect(allText(sent)).not.toContain("Thought for");
  }, 30_000);

  it("settle gap, race: a ticker paint that only awaited narration's in-flight post is not a live-thinking post", async () => {
    // The floor passes while narration's card is still being POSTed: the
    // ticker's paint waits on that same post. It did not make it, so settle
    // still deletes.
    const sent: SentMessage[] = [];
    const { bridge } = makeBridge({
      ux: { ...SEPARATE, narrationAsTrail: true },
      uxFeatures: ON,
      timing: { tickMs: TICK_MS },
    });
    const reply = "Done, moved it to Friday.";
    wire(bridge, async ({ onChunk }) => {
      emitThinkingTokens("turn-1", { estimatedTokens: 185 });
      await sleep(TICK_MS * 2);
      onChunk(reply); // narration starts posting the card (the POST takes 300 ms)
      await sleep(TICK_MS);
      offset = 6_000; // the floor passes while that post is in flight
      await sleep(TICK_MS * 4);
      await sleep(400); // the post lands
      return reply;
    });
    await run(bridge, sent, "turn-1", undefined, 300);

    expect(sent).toHaveLength(1);
    expect(sent[0].deleted).toBe(true);
    expect(allText(sent)).not.toContain("Thought for");
  }, 30_000);

  it("gate off: a narration-only status message is still deleted at settle, thinking frames or not", async () => {
    const sent: SentMessage[] = [];
    const { bridge } = makeBridge({ ux: { ...SEPARATE, narrationAsTrail: true } });
    let statusPosted = -1;
    wire(bridge, async ({ onChunk }) => {
      onChunk("Checking the notes.");
      await sleep(TICK_MS * 3);
      statusPosted = sent.length;
      emitThinkingTokens("turn-1", { estimatedTokens: 800 });
      emitThinkingTokens("turn-1", { estimatedTokens: 2_400 });
      await sleep(TICK_MS * 3);
      const full = "Checking the notes. Here is the plan.\nMove the long run to Sunday.\nKeep Saturday easy.";
      onChunk(full);
      await sleep(5);
      return full;
    });
    await run(bridge, sent);

    expect(statusPosted).toBe(1);
    expect(sent[0].deleted).toBe(true);
    expect(allText(sent)).not.toContain("Thought for");
  }, 30_000);

  it("gate on but no thinking frames: a narration-only status message is still deleted (keys on thinkingSeen)", async () => {
    const sent: SentMessage[] = [];
    const { bridge } = makeBridge({ ux: { ...SEPARATE, narrationAsTrail: true }, uxFeatures: ON });
    let statusPosted = -1;
    wire(bridge, async ({ onChunk }) => {
      onChunk("Checking the notes.");
      await sleep(TICK_MS * 3);
      statusPosted = sent.length;
      const full = "Checking the notes. Here is the plan.\nMove the long run to Sunday.\nKeep Saturday easy.";
      onChunk(full);
      await sleep(5);
      return full;
    });
    await run(bridge, sent);

    expect(statusPosted).toBe(1);
    expect(sent[0].deleted).toBe(true);
    expect(allText(sent)).not.toContain("Thought for");
  }, 30_000);

  it("a turn with thinking plus a tool settles to the existing Checked line, not Thought for", async () => {
    const sent: SentMessage[] = [];
    const { bridge } = makeBridge({ ux: SEPARATE, uxFeatures: ON });
    wire(bridge, async ({ onChunk, onToolUse }) => {
      emitThinkingTokens("turn-1", { estimatedTokens: 2_400 });
      await sleep(TICK_MS * 2);
      onToolUse("WebFetch", { url: "https://www.irs.gov/x" });
      await sleep(TICK_MS * 2);
      onChunk(ANSWER);
      await sleep(5);
      return ANSWER;
    });
    await run(bridge, sent);

    const last = lastText(sent[0]);
    expect(last).toMatch(/^-# Checked 1 step · \d+s$/);
    expect(allText(sent)).not.toContain("Thought for");
    expect(sent[0].deleted).toBe(false);
  }, 30_000);

  it("journal: one debug `thinking-tokens` line per turn with frames and peak, no text", async () => {
    const sent: SentMessage[] = [];
    const { bridge } = makeBridge({ ux: SEPARATE, uxFeatures: ON });
    wire(bridge, async ({ onChunk }) => {
      emitThinkingTokens("turn-1", { estimatedTokens: 800 });
      emitThinkingTokens("turn-1", { estimatedTokens: 2_400 });
      emitThinkingTokens("turn-1", { estimatedTokens: 1_200 });
      await sleep(TICK_MS * 3);
      onChunk(ANSWER);
      await sleep(5);
      return ANSWER;
    });
    await run(bridge, sent);

    const calls = log.debug.mock.calls.filter((c) => c[1] === "thinking-tokens");
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toEqual({ agent: AGENT, turnId: "turn-1", frames: 3, peakTokens: 2_400 });
  }, 30_000);

  it("a tool event inside the edit interval is caught up when live thinking is on, and dropped as today when off", async () => {
    // Tick far away so only the tool writer's catch-up can paint in time.
    const script = (sent: SentMessage[], seen: { text: string }) => async ({ onChunk, onToolUse }: Io): Promise<string> => {
      onToolUse("WebFetch", { url: "https://www.irs.gov/x" });
      // Wait for the first paint to land, then fire the next tool well inside
      // the 1 s interval, so the tool writer's throttle is what decides.
      while (sent.length === 0) await sleep(2);
      await sleep(5);
      onToolUse("WebSearch", { query: "long run recovery" });
      await sleep(1_300);
      seen.text = lastText(sent[0]!);
      onChunk(ANSWER);
      await sleep(5);
      return ANSWER;
    };
    const onSent: SentMessage[] = [];
    const onSeen = { text: "" };
    const on = makeBridge({ ux: SEPARATE, uxFeatures: ON, timing: { tickMs: 60_000 }, editIntervalMs: 1_000 });
    wire(on.bridge, script(onSent, onSeen));
    await run(on.bridge, onSent);
    expect(onSeen.text).toContain("-# ✓ reading irs.gov");
    expect(onSeen.text).toContain("-# → searching “long run recovery”…");
    expect(onSeen.text).toContain("**Working · 2 steps");

    const offSent: SentMessage[] = [];
    const offSeen = { text: "" };
    const off = makeBridge({ ux: SEPARATE, timing: { tickMs: 60_000 }, editIntervalMs: 1_000 });
    wire(off.bridge, script(offSent, offSeen));
    await run(off.bridge, offSent);
    expect(offSeen.text).toContain("→ reading irs.gov…");
    expect(offSeen.text).not.toContain("searching");
  }, 30_000);

  it("gate: live thinking on while streamStatus is off shows nothing (existing preconditions still apply)", async () => {
    const sent: SentMessage[] = [];
    const { bridge } = makeBridge({
      ux: { streamStatus: false, streamStatusMode: "always", statusMessage: "separate" },
      uxFeatures: ON,
    });
    let sinkLive = true;
    wire(bridge, async ({ onChunk }) => {
      emitThinkingTokens("turn-1", { estimatedTokens: 2_400 });
      sinkLive = hasThinkingSink("turn-1");
      await sleep(TICK_MS * 3);
      onChunk(ANSWER);
      await sleep(5);
      return ANSWER;
    });
    await run(bridge, sent);

    expect(sinkLive).toBe(false);
    expect(schedulers).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(allText(sent).toLowerCase()).not.toContain("thinking");
  }, 30_000);

  it("inline mode: the thinking line rides the shared slot and the answer replaces it", async () => {
    const sent: SentMessage[] = [];
    const { bridge } = makeBridge({ ux: UX_BASE, uxFeatures: ON });
    let during = "";
    wire(bridge, async ({ onChunk }) => {
      emitThinkingTokens("turn-1", { estimatedTokens: 2_400 });
      await sleep(TICK_MS * 3);
      during = allText(sent);
      onChunk(ANSWER);
      await sleep(5);
      return ANSWER;
    });
    await run(bridge, sent);

    expect(during).toContain("→ thinking · 2.4k tokens");
    expect(sent).toHaveLength(1);
    expect(lastText(sent[0])).toContain("Move it to Sunday");
    expect(schedulers[0]!.stopped).toBe(true);
  }, 30_000);
});
