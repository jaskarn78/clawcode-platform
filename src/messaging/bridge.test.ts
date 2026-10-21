import { describe, it, expect, vi } from "vitest";
import { MessagingBridge } from "./bridge.js";
import { buildPlatformRoutingTable } from "./router.js";
import type {
  AgentIdentity,
  InboundMessage,
  MessageHandle,
  MessagingPlatform,
  OutboundOptions,
  PlatformCapabilities,
  TurnStatus,
} from "./types.js";
import type { TurnDispatcher } from "../manager/turn-dispatcher.js";
import { logger } from "../shared/logger.js";

const FULL_CAPS: PlatformCapabilities = {
  editMessages: true,
  reactions: true,
  typingIndicator: false,
  threads: true,
  perMessageIdentity: true,
  fileDownload: true,
  // Phase 145 WS3 — non-optional capability flag; the fake reports false
  // (no askQuestion method on this mock → universal text fallback path).
  interactivePrompt: false,
  maxMessageLength: 100,
};

type SendCall = { channelId: string; text: string; opts?: OutboundOptions };

/** A fake MessagingPlatform that records outbound calls and can emit inbound. */
class FakeAdapter implements MessagingPlatform {
  readonly kind = "slack" as const;
  handler: ((m: InboundMessage) => void) | null = null;
  sends: SendCall[] = [];
  edits: { handle: MessageHandle; text: string }[] = [];
  statuses: { handle: MessageHandle; status: TurnStatus }[] = [];
  typingCalls = 0;
  started = false;
  private seq = 0;

  constructor(private readonly caps: PlatformCapabilities = FULL_CAPS) {}

  capabilities(): PlatformCapabilities {
    return this.caps;
  }
  onInbound(handler: (m: InboundMessage) => void): void {
    this.handler = handler;
  }
  async start(): Promise<void> {
    this.started = true;
  }
  async stop(): Promise<void> {}
  async sendMessage(channelId: string, text: string, opts?: OutboundOptions): Promise<MessageHandle> {
    this.sends.push({ channelId, text, opts });
    this.seq += 1;
    return { channelId, messageId: `ts-${this.seq}`, threadId: opts?.threadId };
  }
  async editMessage(handle: MessageHandle, text: string): Promise<void> {
    this.edits.push({ handle, text });
  }
  async setStatusReaction(handle: MessageHandle, status: TurnStatus): Promise<void> {
    this.statuses.push({ handle, status });
  }
  async startTyping(): Promise<void> {
    this.typingCalls += 1;
  }
  emit(m: InboundMessage): void {
    this.handler?.(m);
  }
}

function fakeDispatcher(impl: {
  response?: string;
  chunks?: string[];
  throws?: boolean;
}): { dispatcher: TurnDispatcher; calls: { origin: any; agent: string; message: string }[] } {
  const calls: { origin: any; agent: string; message: string }[] = [];
  const dispatcher = {
    dispatchStream: async (
      origin: any,
      agent: string,
      message: string,
      onChunk: (acc: string) => void,
    ): Promise<string> => {
      calls.push({ origin, agent, message });
      if (impl.throws) throw new Error("dispatch boom");
      for (const c of impl.chunks ?? []) onChunk(c);
      return impl.response ?? "final answer";
    },
  } as unknown as TurnDispatcher;
  return { dispatcher, calls };
}

function makeBridge(
  adapter: FakeAdapter,
  dispatcher: TurnDispatcher,
  identity?: Partial<AgentIdentity>,
  opts?: { statusReactions?: boolean; workingPlaceholder?: string | null },
) {
  const routingTable = buildPlatformRoutingTable([{ name: "alice", channels: ["C1"] }]);
  return new MessagingBridge({
    adapter,
    routingTableRef: { current: routingTable },
    turnDispatcher: dispatcher,
    identityResolver: (name) => ({ displayName: identity?.displayName ?? name, iconUrl: identity?.iconUrl }),
    statusReactions: opts?.statusReactions,
    workingPlaceholder: opts?.workingPlaceholder,
    log: logger,
  });
}

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: "slack",
    channelId: "C1",
    messageId: "1718000000.000100",
    userId: "U1",
    userName: "human",
    text: "hi agent",
    isBot: false,
    ts: new Date("2026-06-16T00:00:00Z"),
    ...overrides,
  };
}

/** Flush the async handleInbound chain (fired fire-and-forget by the bridge). */
async function settle(predicate: () => boolean, tries = 50): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe("MessagingBridge", () => {
  it("routes a bound-channel message through dispatch; posts a placeholder, then edits in the reply with identity", async () => {
    const adapter = new FakeAdapter();
    const { dispatcher, calls } = fakeDispatcher({ response: "hello back" });
    const bridge = makeBridge(adapter, dispatcher, { displayName: "Clawdy", iconUrl: "http://x/a.png" });
    await bridge.start();

    adapter.emit(inbound());
    await settle(() => adapter.edits.length > 0);

    expect(calls.length).toBe(1);
    expect(calls[0].agent).toBe("alice");
    expect(calls[0].origin.source.kind).toBe("slack");
    expect(calls[0].message).toContain('source="slack"');
    expect(calls[0].message).toContain("hi agent");

    // working placeholder posted with the agent's identity…
    expect(adapter.sends.length).toBe(1);
    expect(adapter.sends[0].text).toBe("_…_");
    expect(adapter.sends[0].opts?.identity?.displayName).toBe("Clawdy");
    expect(adapter.sends[0].opts?.identity?.iconUrl).toBe("http://x/a.png");
    // …then edited into the final reply
    expect(adapter.edits[adapter.edits.length - 1].text).toBe("hello back");
  });

  it("applies NO status reactions by default (uses a placeholder instead)", async () => {
    const adapter = new FakeAdapter();
    const { dispatcher } = fakeDispatcher({ response: "ok" });
    const bridge = makeBridge(adapter, dispatcher);
    await bridge.start();

    adapter.emit(inbound());
    await settle(() => adapter.edits.length > 0);

    expect(adapter.statuses.length).toBe(0); // no 👀/✅ noise
    expect(adapter.sends[0].text).toBe("_…_"); // placeholder posted
    expect(adapter.edits[adapter.edits.length - 1].text).toBe("ok"); // edited to reply
  });

  it("applies queue-state reactions when statusReactions is opted in", async () => {
    const adapter = new FakeAdapter();
    const { dispatcher } = fakeDispatcher({ response: "ok" });
    const bridge = makeBridge(adapter, dispatcher, undefined, { statusReactions: true });
    await bridge.start();

    adapter.emit(inbound());
    await settle(() => adapter.statuses.some((s) => s.status === "delivered"));

    const kinds = adapter.statuses.map((s) => s.status);
    expect(kinds).toContain("working");
    expect(kinds).toContain("delivered");
    expect(adapter.statuses[0].handle.messageId).toBe("1718000000.000100");
  });

  it("replies inside the thread when the inbound message was threaded", async () => {
    const adapter = new FakeAdapter();
    const { dispatcher } = fakeDispatcher({ response: "threaded reply" });
    const bridge = makeBridge(adapter, dispatcher);
    await bridge.start();

    adapter.emit(inbound({ threadId: "1717000000.000001" }));
    await settle(() => adapter.sends.length > 0);

    expect(adapter.sends[0].opts?.threadId).toBe("1717000000.000001");
  });

  it("ignores messages on unbound channels (no dispatch, no send)", async () => {
    const adapter = new FakeAdapter();
    const { dispatcher, calls } = fakeDispatcher({ response: "x" });
    const bridge = makeBridge(adapter, dispatcher);
    await bridge.start();

    adapter.emit(inbound({ channelId: "C-UNBOUND" }));
    await new Promise((r) => setTimeout(r, 20));

    expect(calls.length).toBe(0);
    expect(adapter.sends.length).toBe(0);
  });

  it("ignores bot-authored messages", async () => {
    const adapter = new FakeAdapter();
    const { dispatcher, calls } = fakeDispatcher({ response: "x" });
    const bridge = makeBridge(adapter, dispatcher);
    await bridge.start();

    adapter.emit(inbound({ isBot: true }));
    await new Promise((r) => setTimeout(r, 20));

    expect(calls.length).toBe(0);
    expect(adapter.sends.length).toBe(0);
  });

  it("chunks a reply that exceeds maxMessageLength (head edits placeholder, tail as new sends)", async () => {
    const adapter = new FakeAdapter();
    const long = "z".repeat(250); // maxMessageLength is 100 → 3 chunks
    const { dispatcher } = fakeDispatcher({ response: long });
    const bridge = makeBridge(adapter, dispatcher);
    await bridge.start();

    adapter.emit(inbound());
    await settle(() => adapter.sends.length >= 3);

    // placeholder send + 2 tail chunk sends; head chunk is the placeholder edit
    expect(adapter.sends.length).toBe(3);
    expect(adapter.sends[0].text).toBe("_…_");
    expect(adapter.edits.length).toBe(1);
    const reassembled = adapter.edits[0].text + adapter.sends[1].text + adapter.sends[2].text;
    expect(reassembled).toBe(long);
    for (const s of adapter.sends) expect(s.text.length).toBeLessThanOrEqual(100);
    for (const e of adapter.edits) expect(e.text.length).toBeLessThanOrEqual(100);
  });

  it("on dispatch error, edits the placeholder into an error notice (no failed reaction by default)", async () => {
    const adapter = new FakeAdapter();
    const { dispatcher } = fakeDispatcher({ throws: true });
    const bridge = makeBridge(adapter, dispatcher);
    await bridge.start();

    adapter.emit(inbound());
    await settle(() => adapter.edits.some((e) => e.text.includes("Something went wrong")));

    expect(adapter.sends.length).toBe(1);
    expect(adapter.sends[0].text).toBe("_…_");
    expect(adapter.edits.some((e) => e.text.includes("Something went wrong"))).toBe(true);
    expect(adapter.statuses.length).toBe(0);
  });

  it("degrades cleanly when reactions/typing/edit are unsupported", async () => {
    const adapter = new FakeAdapter({
      editMessages: false,
      reactions: false,
      typingIndicator: false,
      threads: false,
      perMessageIdentity: false,
      fileDownload: false,
      // Phase 145 WS3 — non-optional capability flag (degraded adapter).
      interactivePrompt: false,
      maxMessageLength: 100,
    });
    const { dispatcher } = fakeDispatcher({ response: "plain reply", chunks: ["plain"] });
    const bridge = makeBridge(adapter, dispatcher);
    await bridge.start();

    adapter.emit(inbound());
    await settle(() => adapter.sends.length > 0);

    // no reactions, no progressive edits — just a single final send
    expect(adapter.statuses.length).toBe(0);
    expect(adapter.edits.length).toBe(0);
    expect(adapter.sends.length).toBe(1);
    expect(adapter.sends[0].text).toBe("plain reply");
  });
});
