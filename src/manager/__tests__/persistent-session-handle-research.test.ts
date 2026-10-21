/**
 * 999.173 — research subagents at the createPersistentSessionHandle boundary.
 *
 *  - The launch gate admits researchers only while a Discord-user
 *    `sendAndStream` turn is live — an Event Dossier wake (sendAndCollect with
 *    the real "EVENT INGEST (collector)" text) is denied.
 *  - The probe's frame sequence: interim self-fired turn folds (nothing
 *    posted), the synthesis is delivered as a reply to the originating message.
 *  - Researcher frames never swallow the user's next reply.
 *  - A compaction swap fails open (folded text delivered, never dropped).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { createPersistentSessionHandle } from "../persistent-session-handle.js";
import type { SdkModule, SdkQuery, SdkStreamMessage } from "../sdk-types.js";
import { makeResearchLaunchGateHook, RESEARCH_DENY_NOT_USER_TURN } from "../research-launch-gate.js";
import { resetResearchRegistryForTests } from "../research-registry.js";
import type { ResearchSessionConfig } from "../research-subagents.js";
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
  const controllers: ReturnType<typeof createFakeQuery>[] = [];
  const query = vi.fn(() => {
    const c = createFakeQuery();
    controllers.push(c);
    return c.query;
  });
  return { sdkMock: { query } as unknown as SdkModule, ctrl: () => controllers[controllers.length - 1]! };
}

const f = (o: Record<string, unknown>) => o as unknown as SdkStreamMessage;
const init = () => f({ type: "system", subtype: "init" });
const assistant = (text: string, parent: string | null = null) =>
  f({ type: "assistant", parent_tool_use_id: parent, message: { content: [{ type: "text", text }] } });
const result = (text: string, origin?: string) =>
  f({ type: "result", subtype: "success", result: text, session_id: "s", ...(origin ? { origin: { kind: origin } } : {}) });
const started = (taskId: string, toolUseId: string) =>
  f({ type: "system", subtype: "task_started", task_id: taskId, tool_use_id: toolUseId, description: `q ${taskId}`, subagent_type: "researcher", is_backgrounded: true });
const notified = (taskId: string) =>
  f({ type: "system", subtype: "task_notification", task_id: taskId, status: "completed", summary: "s", output_file: "/o" });

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

const RESEARCH: ResearchSessionConfig = {
  model: "sonnet",
  effort: "medium",
  maxTurns: 25,
  maxConcurrent: 4,
  holdTimeoutMs: 20 * 60_000,
  deniedTools: [],
  allowBash: false,
  usageGuard: { reduceAt: 0.7, blockAt: 0.85 },
  budgets: { maxToolCalls: 60, maxSessionToolCalls: 180, maxMinutes: 15 },
  autoRoute: false,
};
const MSG_ID = "000000000000000118";
const CHANNEL = "000000000000000106";
/** A Turn stand-in: real id + channelId, every other member a no-op (spans included). */
function fakeTurn(id: string, channelId: string): Turn {
  const noopSpan: unknown = new Proxy({}, { get: () => () => noopSpan });
  return new Proxy(
    { id, channelId },
    {
      get: (target, prop) =>
        prop in target ? (target as Record<string | symbol, unknown>)[prop] : () => noopSpan,
    },
  ) as unknown as Turn;
}
const discordTurn = fakeTurn(`discord:${MSG_ID}`, CHANNEL);

const researcherCall = () =>
  ({
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: { subagent_type: "researcher", description: "d", prompt: "p" },
    session_id: "s",
    transcript_path: "/t",
    cwd: "/",
  }) as unknown as PreToolUseHookInput;

function makeHandle() {
  const h = buildHarness();
  const sink = vi.fn();
  const handle = createPersistentSessionHandle(
    h.sdkMock,
    { model: "sonnet", attributedStream: true, onOrphanTurnOutput: sink, researchSubagents: RESEARCH },
    "sess-1",
    undefined,
    undefined,
    undefined,
    undefined,
    "personal",
  );
  return { ...h, sink, handle };
}

afterEach(() => resetResearchRegistryForTests());

describe("999.173 — research at the handle boundary", () => {
  it("launch gate: DENIED during an Event Dossier wake, ALLOWED during a Discord-user turn", async () => {
    const { ctrl, handle } = makeHandle();
    const gate = makeResearchLaunchGateHook("personal", 4);
    const sig = { signal: new AbortController().signal };
    await settle();

    // Dossier collector wake → `clawcode send personal` → sendAndCollect.
    const wake = handle.sendAndCollect(
      "EVENT INGEST (collector). slug=chicago-marathon-2026 — 3 new email(s) saved under events/chicago-marathon-2026/emails/",
    );
    await settle();
    const denied = await gate(researcherCall(), "toolu_w", sig);
    expect(denied).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: RESEARCH_DENY_NOT_USER_TURN },
    });
    ctrl().push(init());
    ctrl().push(result("ingested"));
    await wake;

    // A real Discord message → sendAndStream with a discord:<snowflake> turn id.
    const ask = handle.sendAndStream("deep dive the Chicago course weather", () => undefined, discordTurn);
    await settle();
    expect(await gate(researcherCall(), "toolu_A", sig)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow", updatedInput: { model: "opus" } },
    });
    ctrl().push(init());
    ctrl().push(result("Launched researchers"));
    await ask;

    // After the turn ends, the live turn is cleared again.
    expect(await gate(researcherCall(), "toolu_late", sig)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    await handle.close();
  });

  it("launch gate: a self-fired wake turn running ahead of a queued user message cannot fan out", async () => {
    const { ctrl, handle } = makeHandle();
    const gate = makeResearchLaunchGateHook("personal", 4);
    const sig = { signal: new AbortController().signal };
    await settle();
    // A self-fired turn is streaming.
    ctrl().push(notified("x1"));
    ctrl().push(init());
    ctrl().push(assistant("working on a background thing"));
    await settle();
    // The user's message is dispatched meanwhile (queued in the CLI).
    const ask = handle.sendAndStream("deep dive X", () => undefined, discordTurn);
    await settle();
    expect(await gate(researcherCall(), "toolu_wake", sig)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    // The wake turn ends; the user's own turn runs — now researchers may start.
    ctrl().push(result("background done", "task-notification"));
    ctrl().push(init());
    await settle();
    expect(await gate(researcherCall(), "toolu_user", sig)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
    ctrl().push(result("launched"));
    await ask;
    await handle.close();
  });

  it("probe sequence: interim turn folds, synthesis replies to the origin, raw researcher text never posts", async () => {
    const { ctrl, handle, sink } = makeHandle();
    const gate = makeResearchLaunchGateHook("personal", 4);
    const sig = { signal: new AbortController().signal };
    await settle();

    const ask = handle.sendAndStream("deep dive X", () => undefined, discordTurn);
    await settle();
    await gate(researcherCall(), "toolu_A", sig);
    await gate(researcherCall(), "toolu_B", sig);
    ctrl().push(init());
    ctrl().push(started("a1", "toolu_A"));
    ctrl().push(started("a2", "toolu_B"));
    ctrl().push(result("Launched two researchers"));
    expect(await ask).toBe("Launched two researchers");

    // Researchers stream while the parent is idle.
    ctrl().push(assistant("RAW RESEARCHER A", "toolu_A"));
    ctrl().push(assistant("RAW RESEARCHER B", "toolu_B"));
    // First completion wakes the parent: interim filler.
    ctrl().push(notified("a1"));
    ctrl().push(init());
    ctrl().push(assistant("Mercury done, Venus still running"));
    ctrl().push(result("Mercury done, Venus still running", "task-notification"));
    await settle();
    expect(sink).not.toHaveBeenCalled();

    // Second completion: the synthesis.
    ctrl().push(notified("a2"));
    ctrl().push(init());
    ctrl().push(assistant("The synthesis"));
    ctrl().push(result("The synthesis", "task-notification"));
    await settle();
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]![0]).toMatchObject({
      text: "The synthesis",
      replyTo: { channelId: CHANNEL, messageId: MSG_ID },
    });
    for (const call of sink.mock.calls) expect(call[0].text).not.toMatch(/RAW RESEARCHER/);
    await handle.close();
  });

  it("a user message during research still gets its own streamed reply", async () => {
    const { ctrl, handle } = makeHandle();
    const gate = makeResearchLaunchGateHook("personal", 4);
    await settle();
    const ask = handle.sendAndStream("deep dive", () => undefined, discordTurn);
    await settle();
    await gate(researcherCall(), "toolu_A", { signal: new AbortController().signal });
    ctrl().push(init());
    ctrl().push(started("a1", "toolu_A"));
    ctrl().push(result("launched"));
    await ask;

    ctrl().push(assistant("researcher streaming", "toolu_A"));
    await settle();
    const chunks: string[] = [];
    const second = handle.sendAndStream("unrelated quick question", (acc) => chunks.push(acc), fakeTurn("discord:000000000000000119", CHANNEL));
    await settle();
    ctrl().push(init());
    ctrl().push(assistant("researcher still streaming", "toolu_A"));
    ctrl().push(assistant("quick answer"));
    ctrl().push(result("quick answer"));
    expect(await second).toBe("quick answer");
    await handle.close();
  });

  it("compaction swap fails open: folded interim text is delivered as a reply, never dropped", async () => {
    const { ctrl, handle, sink } = makeHandle();
    const gate = makeResearchLaunchGateHook("personal", 4);
    await settle();
    const ask = handle.sendAndStream("deep dive", () => undefined, discordTurn);
    await settle();
    await gate(researcherCall(), "toolu_A", { signal: new AbortController().signal });
    await gate(researcherCall(), "toolu_B", { signal: new AbortController().signal });
    ctrl().push(init());
    ctrl().push(started("a1", "toolu_A"));
    ctrl().push(started("a2", "toolu_B"));
    ctrl().push(result("launched"));
    await ask;
    ctrl().push(notified("a1"));
    ctrl().push(init());
    ctrl().push(assistant("partial findings"));
    ctrl().push(result("partial findings", "task-notification"));
    await settle();
    expect(sink).not.toHaveBeenCalled();

    await handle.swap!("sess-2");
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]![0]).toMatchObject({
      text: "partial findings",
      replyTo: { channelId: CHANNEL, messageId: MSG_ID },
    });
    await handle.close();
  });

  it("research off: self-fired output delivers exactly as before (no replyTo, no folding)", async () => {
    const h = buildHarness();
    const sink = vi.fn();
    const handle = createPersistentSessionHandle(
      h.sdkMock,
      { model: "sonnet", attributedStream: true, onOrphanTurnOutput: sink },
      "sess-1",
      undefined,
      undefined,
      undefined,
      undefined,
      "personal",
    );
    await settle();
    h.ctrl().push(started("a1", "toolu_A"));
    h.ctrl().push(notified("a1"));
    h.ctrl().push(init());
    h.ctrl().push(assistant("bg output"));
    h.ctrl().push(result("bg output", "task-notification"));
    await settle();
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]![0]).not.toHaveProperty("replyTo");
    await handle.close();
  });
});
