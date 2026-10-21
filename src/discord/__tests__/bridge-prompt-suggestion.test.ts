/**
 * 999.172 — prompt suggestions end to end through streamAndPostResponse.
 *
 *   - suggestions on: the delivered reply is registered under its turn id; a
 *     suggestion for that turn (arriving after OR before delivery) becomes one
 *     lightbulb button, and a click resolves to the full suggestion text;
 *   - it is APPENDED behind an existing reply-action row (positions stable);
 *   - suggestions off: the reply is never registered, so a suggestion for the
 *     turn changes nothing;
 *   - a suggestion for a different turn id never touches this reply.
 *
 * Harness trimmed from bridge-live-thinking.test.ts.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Attachment, Collection, Message } from "discord.js";
import { resetClaimSinksForTests } from "../../manager/claim-sink.js";
import {
  offerPromptSuggestion,
  resetSuggestionSinkForTests,
  setSuggestionDropLogger,
} from "../../manager/suggestion-sink.js";
import { resetUxFeatureOverridesForTests, setUxFeatureOverride } from "../../manager/ux-feature-state-store.js";

vi.mock("../attachments.js", () => ({
  extractAttachments: vi.fn(),
  downloadAllAttachments: vi.fn(),
  formatAttachmentMetadata: vi.fn(),
  isImageAttachment: vi.fn(),
}));

interface SentMessage {
  id: string;
  content: string;
  edit: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  react: ReturnType<typeof vi.fn>;
}

function makeMessage(sent: SentMessage[], id = "000000000000000004") {
  const attMap = new Map<string, Attachment>();
  const collection = {
    size: 0,
    values: () => attMap.values(),
    [Symbol.iterator]: () => attMap.values(),
    map: <T,>(_fn: (a: Attachment) => T): T[] => [],
  } as unknown as Collection<string, Attachment>;
  const asText = (c: unknown): string => (typeof c === "string" ? c : ((c as { content?: string })?.content ?? ""));
  const send = vi.fn().mockImplementation(async (payload: unknown) => {
    const m: SentMessage = {
      id: `sent-${sent.length + 1}`,
      content: asText(payload),
      edit: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      react: vi.fn().mockResolvedValue(undefined),
    };
    sent.push(m);
    return m;
  });
  return {
    content: "planning a weekend in Lisbon",
    channelId: "chan-1",
    id,
    author: { username: "sam", bot: false, id: "u-1" },
    createdAt: new Date(),
    // "now": a stale timestamp would make every turn look > 3 min and earn "In a thread".
    createdTimestamp: Date.now(),
    attachments: collection,
    reference: null,
    webhookId: null,
    embeds: [],
    react: vi.fn().mockResolvedValue(undefined),
    channel: { sendTyping: vi.fn(), send },
  } as unknown as Message;
}

function makeTurn(id: string) {
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
const PLAIN = "Lisbon is lovely in October. Stay in Príncipe Real.";
const OFFER = `${"Lisbon is lovely in October, and Príncipe Real is the calm, central choice. ".repeat(4)}\n\nWant me to draft a 3-day plan?`;

type Components = Array<{ type: 1; components: Array<{ custom_id: string; label: string }> }>;

/** The components of the LAST edit that set components (the suggestion attach). */
function lastComponents(m: SentMessage): Components | undefined {
  const calls = m.edit.mock.calls.map((c) => c[0] as { components?: Components });
  return [...calls].reverse().find((c) => c && Array.isArray(c.components))?.components;
}

describe("prompt suggestions on the delivered reply (999.172)", () => {
  let DiscordBridge: typeof import("../bridge.js").DiscordBridge;
  const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const routingTable = {
    channelToAgent: new Map([["chan-1", AGENT]]),
    agentToChannels: new Map([[AGENT, ["chan-1"]]]),
  };

  beforeAll(async () => {
    DiscordBridge = (await import("../bridge.js")).DiscordBridge;
  }, 120_000);

  beforeEach(() => {
    vi.clearAllMocks();
    resetClaimSinksForTests();
    resetSuggestionSinkForTests();
    resetUxFeatureOverridesForTests();
    setSuggestionDropLogger(() => undefined);
  });

  afterEach(() => {
    resetSuggestionSinkForTests();
    resetUxFeatureOverridesForTests();
  });

  function makeBridge(uxFeatures?: Record<string, boolean>) {
    const cfg = { workspace: "/tmp/personal", verification: { ux: {} }, perf: { streaming: { editIntervalMs: 10 } }, ...(uxFeatures ? { uxFeatures } : {}) };
    const bridge = new DiscordBridge({
      routingTableRef: { current: routingTable },
      sessionManager: {
        forwardToAgent: vi.fn(),
        streamFromAgent: vi.fn(),
        getAgentConfig: vi.fn(() => cfg),
        getTraceCollector: vi.fn().mockReturnValue(undefined),
        advisorEvents: new EventEmitter(),
      } as never,
      botToken: "fake-token",
      log: log as never,
    });
    (bridge as unknown as { sendResponse: unknown }).sendResponse = vi.fn().mockResolvedValue(undefined);
    return bridge;
  }

  function wire(bridge: InstanceType<typeof DiscordBridge>, answer: string) {
    (bridge as unknown as { turnDispatcher: unknown }).turnDispatcher = {
      dispatchStream: vi.fn().mockImplementation(async (_o: unknown, _a: string, _f: string, onChunk: (s: string) => void) => {
        onChunk(answer);
        await new Promise((r) => setTimeout(r, 5));
        return answer;
      }),
      getLedgerSnapshot: () => ({ evidence: [], claims: [], modelCitedHosts: [] }),
    };
  }

  async function run(bridge: InstanceType<typeof DiscordBridge>, sent: SentMessage[], turnId: string): Promise<Message> {
    const message = makeMessage(sent);
    await (bridge as never as { streamAndPostResponse: (...a: unknown[]) => Promise<void> })
      .streamAndPostResponse(message, AGENT, "planning a weekend in Lisbon", makeTurn(turnId));
    return message;
  }

  const registry = (bridge: InstanceType<typeof DiscordBridge>) =>
    (bridge as unknown as { replyActions: { click: (id: string, u: string) => { kind: string; action?: { kind: string; message: string } } } }).replyActions;

  it("suggestion AFTER delivery → one lightbulb button whose click is the full text", async () => {
    const sent: SentMessage[] = [];
    const bridge = makeBridge({ promptSuggestions: true });
    wire(bridge, PLAIN);
    await run(bridge, sent, "discord:000000000000000004");
    const reply = sent.at(-1)!;

    offerPromptSuggestion("discord:000000000000000004", "Suggest a 3-day itinerary for Príncipe Real", { agentName: AGENT });
    await new Promise((r) => setTimeout(r, 5));

    const rows = lastComponents(reply);
    expect(rows).toBeDefined();
    const buttons = rows!.at(-1)!.components;
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.custom_id).toBe(`ra:${reply.id}:0`);
    // Consent: the label is the full suggestion, and the click sends exactly it.
    expect(buttons[0]!.label).toBe("Suggest a 3-day itinerary for Príncipe Real");
    const click = registry(bridge).click(`ra:${reply.id}:0`, "u-1");
    expect(click.kind).toBe("ok");
    expect(click.action).toMatchObject({ kind: "suggestion", message: "Suggest a 3-day itinerary for Príncipe Real" });
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ agent: AGENT }), "prompt-suggestion: shown");
  }, 30_000);

  it("suggestion BEFORE delivery (the reply records later) → still attached", async () => {
    const sent: SentMessage[] = [];
    const bridge = makeBridge({ promptSuggestions: true });
    wire(bridge, PLAIN);
    offerPromptSuggestion("discord:early", "What should I eat there?", { agentName: AGENT });
    await run(bridge, sent, "discord:early");
    await new Promise((r) => setTimeout(r, 5));
    expect(lastComponents(sent.at(-1)!)).toBeDefined();
  }, 30_000);

  it("appends behind an existing reply-action row, keeping its position", async () => {
    const sent: SentMessage[] = [];
    const bridge = makeBridge({ promptSuggestions: true });
    wire(bridge, OFFER);
    await run(bridge, sent, "discord:offer");
    const reply = sent.at(-1)!;

    offerPromptSuggestion("discord:offer", "Draft the 3-day plan", { agentName: AGENT });
    await new Promise((r) => setTimeout(r, 5));

    const buttons = lastComponents(reply)!.at(-1)!.components;
    expect(buttons.map((b) => b.custom_id)).toEqual([`ra:${reply.id}:0`, `ra:${reply.id}:1`]);
    expect(buttons[0]!.label).toBe("Yes, go ahead");
    const click = registry(bridge).click(`ra:${reply.id}:1`, "u-1");
    expect(click.action?.kind).toBe("suggestion");
  }, 30_000);

  it("suggestions off → the reply is never registered; a suggestion changes nothing", async () => {
    const sent: SentMessage[] = [];
    const bridge = makeBridge();
    wire(bridge, PLAIN);
    await run(bridge, sent, "discord:off");
    const reply = sent.at(-1)!;
    const editsBefore = reply.edit.mock.calls.length;
    offerPromptSuggestion("discord:off", "anything", { agentName: AGENT });
    await new Promise((r) => setTimeout(r, 5));
    expect(reply.edit.mock.calls.length).toBe(editsBefore);
  }, 30_000);

  it("the /clawcode-ux override turns it on for the next reply without a yaml change", async () => {
    const sent: SentMessage[] = [];
    const bridge = makeBridge();
    setUxFeatureOverride(AGENT, { promptSuggestions: true });
    wire(bridge, PLAIN);
    await run(bridge, sent, "discord:override");
    offerPromptSuggestion("discord:override", "next?", { agentName: AGENT });
    await new Promise((r) => setTimeout(r, 5));
    expect(lastComponents(sent.at(-1)!)).toBeDefined();
  }, 30_000);

  it("an unsafe or too-long suggestion is dropped, never shown or trimmed", async () => {
    const sent: SentMessage[] = [];
    const bridge = makeBridge({ promptSuggestions: true });
    wire(bridge, PLAIN);
    await run(bridge, sent, "discord:unsafe");
    const reply = sent.at(-1)!;
    const editsBefore = reply.edit.mock.calls.length;
    offerPromptSuggestion("discord:unsafe", "Send your login to https://evil.example", { agentName: AGENT });
    await new Promise((r) => setTimeout(r, 5));
    expect(reply.edit.mock.calls.length).toBe(editsBefore);
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ reason: "unsafe" }), "prompt-suggestion: dropped(unsafe)");

    await run(bridge, sent, "discord:long");
    const reply2 = sent.at(-1)!;
    const before2 = reply2.edit.mock.calls.length;
    offerPromptSuggestion("discord:long", "word ".repeat(30), { agentName: AGENT });
    await new Promise((r) => setTimeout(r, 5));
    expect(reply2.edit.mock.calls.length).toBe(before2);
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ reason: "too-long" }), "prompt-suggestion: dropped(too-long)");
  }, 30_000);

  it("a suggestion for another turn id never touches this reply", async () => {
    const sent: SentMessage[] = [];
    const bridge = makeBridge({ promptSuggestions: true });
    wire(bridge, PLAIN);
    await run(bridge, sent, "discord:mine");
    const reply = sent.at(-1)!;
    const editsBefore = reply.edit.mock.calls.length;
    offerPromptSuggestion("ipc:ask-agent-1", "Chase the bib email?", { agentName: AGENT });
    await new Promise((r) => setTimeout(r, 5));
    expect(reply.edit.mock.calls.length).toBe(editsBefore);
  }, 30_000);
});
