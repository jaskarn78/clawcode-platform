/**
 * 999.175 — the native driver passes client tools through as REAL tools.
 *
 * Field report (2026-09-24, Mac): `peekaboo agent … --model clawcode/personal`
 * → "Task completed in 17.9s with ⚒ 0 tools". The driver only wrote the tool
 * names into the prompt. Here the fake session handle plays the Claude Code
 * CLI: it connects an MCP client to the in-process server the driver passed in
 * `mcpServers.c` and calls the client's tool mid-turn, exactly as the CLI does.
 */
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  API_KEY_SESSIONS_MIGRATION_SQL,
  API_KEY_SESSIONS_MIGRATION_V2_SQL,
  ApiKeySessionIndex,
} from "../session-index.js";
import { createOpenAiSessionDriver, type OpenAiSessionDriverDeps } from "../driver.js";
import { TransientSessionCache } from "../transient-session-cache.js";
import type { ClaudeToolDef, ClaudeToolResultBlock, SdkStreamEvent } from "../types.js";
import type { SessionHandle } from "../../manager/session-adapter.js";
import type { SdkModule } from "../../manager/sdk-types.js";

const APP: ClaudeToolDef = { name: "app", description: "Launch or focus an app.", input_schema: { type: "object", properties: { app: { type: "string" } }, required: ["app"] } };
const SEE: ClaudeToolDef = { name: "see", description: "Describe an app window.", input_schema: { type: "object", properties: { app: { type: "string" } } } };

type Turn = (ctx: { message: string; emit: (s: string) => void; call: (name: string, args: object) => Promise<string>; signal?: AbortSignal }) => Promise<void>;

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
});

function harness(script: Turn) {
  const handleOptions: Array<Record<string, unknown>> = [];
  const drainOptions: Array<Record<string, unknown>> = [];
  const sent: string[] = [];
  /** Every tool result the fake CLI received, recorded before any abort check. */
  const toolResultsSeen: string[] = [];
  const db = new Database(":memory:");
  db.exec(API_KEY_SESSIONS_MIGRATION_SQL);
  db.exec(API_KEY_SESSIONS_MIGRATION_V2_SQL);
  const sdk = {
    query: vi.fn((args: { options: Record<string, unknown> }) => {
      drainOptions.push(args.options);
      return { async *[Symbol.asyncIterator]() { yield { type: "result", session_id: "sess-tools" } as never; } };
    }),
  } as unknown as SdkModule;

  const createHandle = ((_sdk: SdkModule, options: Record<string, unknown>, sessionId: string) => {
    handleOptions.push(options);
    let client: Promise<Client> | null = null;
    const mcp = (options.mcpServers as Record<string, { instance?: { connect: (t: unknown) => Promise<void> } }> | undefined)?.c;
    const connectClient = (): Promise<Client> =>
      (client ??= (async () => {
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await mcp!.instance!.connect(serverSide);
        const c = new Client({ name: "fake-cli", version: "1.0.0" });
        await c.connect(clientSide);
        clients.push(c);
        return c;
      })());
    return {
      sessionId,
      sendAndStream: vi.fn(async (message: string, onChunk: (acc: string) => void, _turn?: unknown, opts?: { signal?: AbortSignal }) => {
        sent.push(message);
        let acc = "";
        await script({
          message,
          signal: opts?.signal,
          emit: (s) => {
            acc += s;
            onChunk(acc);
          },
          call: async (name, args) => {
            const r = await (await connectClient()).callTool({ name, arguments: args as Record<string, unknown> });
            const text = (r.content as Array<{ text: string }>)[0]!.text;
            toolResultsSeen.push(text);
            if (opts?.signal?.aborted) throw new Error("aborted");
            return text;
          },
        });
        return acc;
      }),
      close: vi.fn(async () => {}),
    } as unknown as SessionHandle;
  }) as unknown as OpenAiSessionDriverDeps["createHandle"];

  const deps: OpenAiSessionDriverDeps = {
    sessionManager: { getActiveConversationSessionId: () => "sess-tools" } as unknown as OpenAiSessionDriverDeps["sessionManager"],
    sessionIndexFor: () => new ApiKeySessionIndex(db),
    traceCollectorFor: () => null,
    sdk,
    transientCache: new TransientSessionCache({ maxSize: 8, ttlMs: 0 }),
    getAgentBaseOptions: async () => ({ soulPrompt: "SOUL", model: "claude-opus-5-5", soulFp: "0123456789abcdef" }),
    createHandle,
    ensureCwd: vi.fn(),
  };
  return { driver: createOpenAiSessionDriver(deps), handleOptions, drainOptions, sent, toolResultsSeen };
}

function request(overrides: { message?: string; tools?: ClaudeToolDef[] | null; toolResults?: ClaudeToolResultBlock[]; toolChoice?: { type: "none" } | null } = {}) {
  const ac = new AbortController();
  return {
    ac,
    input: {
      agentName: "personal",
      keyHash: "a".repeat(64),
      lastUserMessage: overrides.message ?? "Open the Calculator app, then report what number is shown on its display.",
      clientSystemAppend: null,
      tools: overrides.tools === undefined ? [APP, SEE] : overrides.tools,
      toolChoice: overrides.toolChoice ?? null,
      toolResults: overrides.toolResults ?? [],
      signal: ac.signal,
      xRequestId: "req-1",
    },
  };
}

async function collect(it: AsyncIterable<SdkStreamEvent>): Promise<SdkStreamEvent[]> {
  const out: SdkStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const texts = (events: SdkStreamEvent[]) =>
  events.flatMap((e) => (e.type === "stream_event" && e.event.type === "content_block_delta" && e.event.delta.type === "text_delta" ? [e.event.delta.text] : []));
const toolUses = (events: SdkStreamEvent[]) =>
  events.flatMap((e) => (e.type === "stream_event" && e.event.type === "content_block_start" && e.event.content_block.type === "tool_use" ? [e.event.content_block] : []));
const toolArgs = (events: SdkStreamEvent[]) =>
  events.flatMap((e) => (e.type === "stream_event" && e.event.type === "content_block_delta" && e.event.delta.type === "input_json_delta" ? [e.event.delta.partial_json] : []));

const calculatorTurn: Turn = async ({ emit, call }) => {
  emit("Opening Calculator.");
  const shown = await call("app", { app: "Calculator" });
  emit(` The display shows ${shown}.`);
};

describe("native driver — client tools are real tools (999.175)", () => {
  it("returns the model's tool call as tool_use events and parks the turn", async () => {
    const h = harness(calculatorTurn);
    const r1 = request();
    const events = await collect(h.driver.dispatch(r1.input));

    expect(texts(events)).toEqual(["Opening Calculator."]);
    expect(toolUses(events)).toEqual([{ type: "tool_use", id: expect.stringMatching(/^call_/), name: "app" }]);
    expect(toolArgs(events)).toEqual(['{"app":"Calculator"}']);
    expect(events.at(-1)).toMatchObject({ type: "result", session_id: "sess-tools" });

    // The prompt no longer carries the tool names as text.
    expect(h.sent[0]).not.toMatch(/Client-declared tools/);
    // Built-ins off, client server on the handle only, stream-close timeout lifted.
    expect(h.handleOptions[0]).toMatchObject({ tools: [], mcpServers: { c: { type: "sdk", name: "c" } } });
    expect((h.handleOptions[0]!.env as Record<string, string>).CLAUDE_CODE_STREAM_CLOSE_TIMEOUT).toBe(String(6 * 60_000));
    expect(h.drainOptions[0]!.mcpServers).toEqual({});
  });

  it("resumes the SAME turn when the client returns the result", async () => {
    const h = harness(calculatorTurn);
    const r1 = request();
    const first = await collect(h.driver.dispatch(r1.input));
    r1.ac.abort(); // the server aborts on response close — must not touch the parked turn
    const callId = toolUses(first)[0]!.id;

    const r2 = request({ toolResults: [{ type: "tool_result", tool_use_id: callId, content: "1337" }] });
    const second = await collect(h.driver.dispatch(r2.input));

    expect(texts(second)).toEqual([" The display shows 1337."]);
    expect(toolUses(second)).toEqual([]);
    expect(second.at(-1)).toMatchObject({ type: "result" });
    expect(h.sent).toHaveLength(1); // one turn, continued — not a new message
    expect(h.handleOptions).toHaveLength(1); // cache hit
  });

  it("carries a second tool call in the continuation's response", async () => {
    const h = harness(async ({ emit, call }) => {
      await call("app", { app: "Calculator" });
      const shown = await call("see", { app: "Calculator" });
      emit(`It shows ${shown}.`);
    });
    const first = await collect(h.driver.dispatch(request().input));
    const second = await collect(
      h.driver.dispatch(request({ toolResults: [{ type: "tool_result", tool_use_id: toolUses(first)[0]!.id, content: "opened" }] }).input),
    );
    expect(toolUses(second).map((t) => t.name)).toEqual(["see"]);
    const third = await collect(
      h.driver.dispatch(request({ toolResults: [{ type: "tool_result", tool_use_id: toolUses(second)[0]!.id, content: "0" }] }).input),
    );
    expect(texts(third)).toEqual(["It shows 0."]);
  });

  it("a new message supersedes a parked turn: the parked call fails, the new turn runs", async () => {
    const h = harness(async ({ message, emit, call }) => {
      if (message.startsWith("Open")) {
        await call("app", { app: "Calculator" });
        emit("never reached");
        return;
      }
      emit("Fresh answer.");
    });
    await collect(h.driver.dispatch(request().input));
    const next = await collect(h.driver.dispatch(request({ message: "Never mind, what time is it?" }).input));
    expect(texts(next)).toEqual(["Fresh answer."]);
    expect(h.sent).toHaveLength(2);
    // The parked call was failed with the reason, and the old turn was interrupted.
    expect(h.toolResultsSeen).toEqual(["Superseded by a new request."]);
  });

  it("a parallel batch goes out as two tool_calls in one response", async () => {
    const h = harness(async ({ emit, call }) => {
      const [a, b] = await Promise.all([call("app", { app: "Calculator" }), call("see", { app: "Calculator" })]);
      emit(`${a} / ${b}`);
    });
    const first = await collect(h.driver.dispatch(request().input));
    expect(toolUses(first).map((t) => t.name).sort()).toEqual(["app", "see"]);
    const results = toolUses(first).map((t) => ({ type: "tool_result" as const, tool_use_id: t.id, content: t.name }));
    const second = await collect(h.driver.dispatch(request({ toolResults: results }).input));
    expect(texts(second).join("")).toMatch(/app|see/);
  });

  it("a retried continuation takes over the turn and the first request ends with an error, not a hang", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness(async ({ emit, call }) => {
      const shown = await call("app", { app: "Calculator" });
      emit(`Shows ${shown}.`);
      await gate; // still running when the retry lands
      emit(" Done.");
    });
    const first = await collect(h.driver.dispatch(request().input));
    const results = [{ type: "tool_result" as const, tool_use_id: toolUses(first)[0]!.id, content: "1337" }];

    const original = collect(h.driver.dispatch(request({ toolResults: results }).input));
    await vi.waitFor(() => expect(h.toolResultsSeen).toEqual(["1337"]));
    const retry = collect(h.driver.dispatch(request({ toolResults: results }).input));
    await expect(original).rejects.toThrow("Replaced by a retried request.");
    release();
    const retried = await retry;
    expect(texts(retried).join("")).toBe("Shows 1337. Done.");
    expect(h.sent).toHaveLength(1); // same turn throughout
  });

  it("a retry whose missed response ended in new tool calls gets those calls again", async () => {
    const h = harness(async ({ emit, call }) => {
      await call("app", { app: "Calculator" });
      const shown = await call("see", { app: "Calculator" });
      emit(`It shows ${shown}.`);
    });
    const first = await collect(h.driver.dispatch(request().input));
    const results = [{ type: "tool_result" as const, tool_use_id: toolUses(first)[0]!.id, content: "opened" }];
    const missed = await collect(h.driver.dispatch(request({ toolResults: results }).input));
    const again = await collect(h.driver.dispatch(request({ toolResults: results }).input));
    expect(toolUses(again)).toEqual(toolUses(missed));
    const done = await collect(
      h.driver.dispatch(request({ toolResults: [{ type: "tool_result", tool_use_id: toolUses(again)[0]!.id, content: "0" }] }).input),
    );
    expect(texts(done)).toEqual(["It shows 0."]);
  });

  it("superseding a turn that is streaming to a request ends that request with an error", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness(async ({ message, emit, call }) => {
      if (!message.startsWith("Open")) return emit("Fresh answer.");
      await call("app", { app: "Calculator" });
      emit("Working");
      await gate;
    });
    const first = await collect(h.driver.dispatch(request().input));
    const streaming = collect(
      h.driver.dispatch(request({ toolResults: [{ type: "tool_result", tool_use_id: toolUses(first)[0]!.id, content: "ok" }] }).input),
    );
    await vi.waitFor(() => expect(h.toolResultsSeen).toEqual(["ok"]));
    const fresh = collect(h.driver.dispatch(request({ message: "Never mind, what time is it?" }).input));
    await expect(streaming).rejects.toThrow("Superseded by a new request.");
    release();
    expect(texts(await fresh)).toEqual(["Fresh answer."]);
  });

  it("tool results with no parked call (restart, timeout) go in as text", async () => {
    const h = harness(async ({ emit }) => emit("Noted."));
    const events = await collect(
      h.driver.dispatch(request({ toolResults: [{ type: "tool_result", tool_use_id: "call_gone", content: "Display: 42" }] }).input),
    );
    expect(texts(events)).toEqual(["Noted."]);
    expect(h.sent[0]).toContain("[call_gone] Display: 42");
  });

  it("tool_choice none and tool-less requests keep the old text-only path", async () => {
    const h = harness(async ({ emit }) => emit("ok"));
    await collect(h.driver.dispatch(request({ toolChoice: { type: "none" } }).input));
    expect(h.sent[0]).toContain("(Client-declared tools: app, see)");
    expect(h.handleOptions[0]!.tools).toBeUndefined();
    expect(h.handleOptions[0]!.mcpServers).toEqual({});
  });
});
