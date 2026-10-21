/**
 * 999.172 — handle-level routing of `prompt_suggestion` (the safety gate).
 *
 * At the createPersistentSessionHandle boundary (attributed stream on):
 *  - a Discord-user sendAndStream turn's suggestion is offered under THAT
 *    turn's id, and pairs with the bridge's reply record;
 *  - a send() / sendAndCollect() turn — cron, IPC, ask-agent (the Event
 *    Dossier's `clawcode send personal` wakes) — is dropped
 *    `no-discord-turn`, even right after a Discord turn;
 *  - a self-fired turn's suggestion is dropped `orphan`;
 *  - the handle reports the session-start options it was built with.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { createPersistentSessionHandle } from "../persistent-session-handle.js";
import {
  registerSuggestionReply,
  resetSuggestionSinkForTests,
  setSuggestionDropLogger,
  type SuggestionDropEvent,
} from "../suggestion-sink.js";
import type { SdkModule, SdkQuery, SdkStreamMessage } from "../sdk-types.js";
import type { Turn } from "../../performance/trace-collector.js";

function createFakeQuery() {
  const pending: SdkStreamMessage[] = [];
  const waiters: Array<(r: IteratorResult<SdkStreamMessage>) => void> = [];
  let streamEnded = false;
  const next = (): Promise<IteratorResult<SdkStreamMessage>> =>
    new Promise((resolve) => {
      const m = pending.shift();
      if (m !== undefined) return resolve({ value: m, done: false });
      if (streamEnded) return resolve({ value: undefined as unknown as SdkStreamMessage, done: true });
      waiters.push(resolve);
    });
  const push = (msg: SdkStreamMessage): void => {
    const w = waiters.shift();
    if (w) return w({ value: msg, done: false });
    pending.push(msg);
  };
  const query = {
    [Symbol.asyncIterator]() {
      return { next };
    },
    next,
    return: async () => ({ value: undefined, done: true as const }),
    interrupt: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => {
      streamEnded = true;
      for (const w of waiters.splice(0)) w({ value: undefined as unknown as SdkStreamMessage, done: true });
    }),
    streamInput: vi.fn(() => Promise.resolve()),
    mcpServerStatus: vi.fn(() => Promise.resolve([])),
    setMcpServers: vi.fn(() => Promise.resolve(undefined)),
    setMaxThinkingTokens: vi.fn(() => Promise.resolve(undefined)),
    setModel: vi.fn(() => Promise.resolve(undefined)),
    setPermissionMode: vi.fn(() => Promise.resolve(undefined)),
    backgroundTasks: vi.fn(() => Promise.resolve(true)),
    stopTask: vi.fn(() => Promise.resolve()),
  } as unknown as SdkQuery;
  return { query, push };
}

function buildHarness() {
  let controller: ReturnType<typeof createFakeQuery> | null = null;
  const query = vi.fn(() => {
    controller = createFakeQuery();
    return controller.query;
  });
  return {
    sdkMock: { query } as unknown as SdkModule,
    queryFn: query,
    ctrl: () => {
      if (!controller) throw new Error("query not yet invoked");
      return controller;
    },
  };
}

function fakeTurn(id: string): Turn {
  const span = { end: () => undefined, setMetadata: () => undefined };
  return {
    id,
    startSpan: () => span,
    recordToolCallName: () => undefined,
    recordCacheUsage: () => undefined,
  } as unknown as Turn;
}

const notification = () =>
  ({ type: "system", subtype: "task_notification", task_id: "t" }) as unknown as SdkStreamMessage;
const assistant = (text: string) =>
  ({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text }] } }) as unknown as SdkStreamMessage;
const result = (text: string, opts: { origin?: string } = {}) =>
  ({
    type: "result",
    subtype: "success",
    result: text,
    session_id: "sess-1",
    ...(opts.origin ? { origin: { kind: opts.origin } } : {}),
  }) as unknown as SdkStreamMessage;
const suggestion = (text: string) =>
  ({ type: "prompt_suggestion", suggestion: text, uuid: "u", session_id: "sess-1" }) as unknown as SdkStreamMessage;

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

function attributedHandle(sdkMock: SdkModule, extra: Record<string, unknown> = {}) {
  return createPersistentSessionHandle(
    sdkMock,
    { model: "sonnet", attributedStream: true, onOrphanTurnOutput: vi.fn(), ...extra },
    "sess-1",
    undefined,
    undefined,
    undefined,
    undefined,
    "personal",
  );
}

function captureDrops(): SuggestionDropEvent[] {
  const drops: SuggestionDropEvent[] = [];
  setSuggestionDropLogger((ev) => drops.push(ev));
  return drops;
}

afterEach(() => {
  resetSuggestionSinkForTests();
});

describe("persistent-session-handle — prompt suggestion routing (999.172)", () => {
  it("a Discord sendAndStream turn's suggestion reaches the reply record for THAT turn", async () => {
    const { sdkMock, ctrl } = buildHarness();
    const handle = attributedHandle(sdkMock);
    await settle();
    const attach = vi.fn();
    registerSuggestionReply("discord:111", { agentName: "personal", messageId: "m1", attach });

    const reply = handle.sendAndStream("q", () => undefined, fakeTurn("discord:111"));
    await settle();
    ctrl().push(assistant("Lisbon, great."));
    ctrl().push(result("Lisbon, great."));
    await reply;
    ctrl().push(suggestion("Which neighbourhood?"));
    await settle();

    expect(attach).toHaveBeenCalledWith("Which neighbourhood?");
    await handle.close();
  });

  it("an ask-agent / cron turn (sendAndCollect — an Event Dossier wake) is dropped no-discord-turn", async () => {
    const { sdkMock, ctrl } = buildHarness();
    const handle = attributedHandle(sdkMock);
    await settle();
    const drops = captureDrops();
    const attach = vi.fn();
    // A Discord reply is on record for an EARLIER turn; the wake must not reach it.
    registerSuggestionReply("discord:111", { agentName: "personal", messageId: "m1", attach });

    const wake = handle.sendAndCollect(
      "EVENT INGEST (collector). slug=chicago-marathon-2026 — 3 new email(s) saved",
      fakeTurn("ipc:ask-agent-1"),
    );
    await settle();
    ctrl().push(assistant("Ingested."));
    ctrl().push(result("Ingested."));
    await wake;
    ctrl().push(suggestion("Chase the bib email?"));
    await settle();

    expect(attach).not.toHaveBeenCalled();
    expect(drops).toEqual([expect.objectContaining({ agentName: "personal", reason: "no-discord-turn" })]);
    await handle.close();
  });

  it("a send() turn is dropped no-discord-turn too", async () => {
    const { sdkMock, ctrl } = buildHarness();
    const handle = attributedHandle(sdkMock);
    await settle();
    const drops = captureDrops();
    const sent = handle.send("cron tick");
    await settle();
    ctrl().push(assistant("ok"));
    ctrl().push(result("ok"));
    await sent;
    ctrl().push(suggestion("next?"));
    await settle();
    expect(drops.map((d) => d.reason)).toEqual(["no-discord-turn"]);
    await handle.close();
  });

  it("reviewer's race at the handle: a cron/dossier turn closes, a Discord turn opens+closes, the late frame is dropped ambiguous", async () => {
    const { sdkMock, ctrl } = buildHarness();
    const handle = attributedHandle(sdkMock);
    await settle();
    const drops = captureDrops();
    const attach = vi.fn();
    registerSuggestionReply("discord:222", { agentName: "personal", messageId: "m2", attach });

    const wake = handle.sendAndCollect("EVENT DROP DUE (event_tick). slug=chicago-marathon-2026 drop=race-eve");
    await settle();
    ctrl().push(assistant("posted"));
    ctrl().push(result("posted"));
    await wake;
    const reply = handle.sendAndStream("q", () => undefined, fakeTurn("discord:222"));
    await settle();
    ctrl().push(assistant("user answer"));
    ctrl().push(result("user answer"));
    await reply;
    ctrl().push(suggestion("Post the race-eve card again?")); // the wake's late suggestion
    await settle();

    expect(attach).not.toHaveBeenCalled();
    expect(drops.map((d) => d.reason)).toEqual(["ambiguous"]);
    await handle.close();
  });

  it("a self-fired turn right after a Discord turn is dropped (never decorates the Discord reply)", async () => {
    const { sdkMock, ctrl } = buildHarness();
    const handle = attributedHandle(sdkMock);
    await settle();
    const drops = captureDrops();
    const attach = vi.fn();
    registerSuggestionReply("discord:111", { agentName: "personal", messageId: "m1", attach });

    const reply = handle.sendAndStream("q", () => undefined, fakeTurn("discord:111"));
    await settle();
    ctrl().push(assistant("a"));
    ctrl().push(result("a"));
    await reply;
    // A background completion wakes the agent before the suggestion lands.
    ctrl().push(notification());
    ctrl().push(assistant("bg done"));
    ctrl().push(result("bg done", { origin: "task-notification" }));
    ctrl().push(suggestion("late"));
    await settle();

    expect(attach).not.toHaveBeenCalled();
    // Two unresolved closes in the window: dropped as ambiguous before the orphan check.
    expect(drops.map((d) => d.reason)).toEqual(["ambiguous"]);
    await handle.close();
  });

  it("reports the session-start options it was built with", async () => {
    const off = buildHarness();
    const h1 = attributedHandle(off.sdkMock);
    expect(h1.getStartedUxFeatures?.()).toEqual({ promptSuggestions: false });
    await h1.close();

    const on = buildHarness();
    const h2 = attributedHandle(on.sdkMock, { promptSuggestions: true });
    expect(h2.getStartedUxFeatures?.()).toEqual({ promptSuggestions: true });
    // …and the option really reaches sdk.query.
    const opts = (on.queryFn.mock.calls[0] as unknown as [{ options: Record<string, unknown> }])[0].options;
    expect(opts.promptSuggestions).toBe(true);
    await h2.close();
  });
});
