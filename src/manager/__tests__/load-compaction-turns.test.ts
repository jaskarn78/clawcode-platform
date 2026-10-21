/**
 * Phase 999.75 Part A (A4) — `loadCompactionTurns` fail-open + happy-path tests.
 *
 * `loadCompactionTurns` is the shared helper both daemon compaction call
 * sites (heartbeat auto-trigger + manual IPC) use to feed the tier extractors
 * the real SDK JSONL transcript (tool blocks verbatim). The contract under
 * test:
 *   - Happy path: SDK transcript → `[role]: content` text with tool markers.
 *   - Fail-open: `getSessionMessages` throws → returns `null` so the daemon
 *     degrades to the existing `ConversationStore` extractor input.
 *   - Fail-open: no active session / no resolved config → `null`.
 *
 * Exported from `daemon.ts` so this suite drives it directly without
 * standing up the full daemon.
 */
import { describe, it, expect, vi } from "vitest";
import pino from "pino";
import type { Logger } from "pino";
import { loadCompactionTurns } from "../daemon.js";
import type { SessionMessage } from "../sdk-types.js";

function silentLog(): Logger {
  return pino({ level: "silent" });
}

function txtMsg(
  type: "user" | "assistant",
  blocks: unknown,
): SessionMessage {
  return {
    type,
    uuid: `u-${Math.random()}`,
    session_id: "sess-1",
    message: { role: type, content: blocks },
    parent_tool_use_id: null,
  };
}

describe("loadCompactionTurns", () => {
  it("happy path: renders the SDK transcript with tool markers intact", async () => {
    const messages: SessionMessage[] = [
      txtMsg("assistant", [{ type: "text", text: "starting work" }]),
      txtMsg("assistant", [
        { type: "tool_use", id: "t1", name: "Read", input: { file: "x.ts" } },
      ]),
      txtMsg("user", [
        { type: "tool_result", tool_use_id: "t1", content: "file body" },
      ]),
    ];
    const getSessionMessages = vi.fn(async () => messages);

    const text = await loadCompactionTurns({
      agentName: "agent-a",
      manager: {
        getSdkSessionId: () => "sess-1",
      },
      sdk: { getSessionMessages },
      config: { workspace: "/home/agent-a/workspace" },
      log: silentLog(),
    });

    expect(text).not.toBeNull();
    expect(text).toContain('[assistant]: tool_use: Read args: {"file":"x.ts"}');
    expect(text).toContain("[user]: tool_result: Read ok file body");
    // dir resolved from workspace (no gsd override).
    expect(getSessionMessages).toHaveBeenCalledWith("sess-1", {
      dir: "/home/agent-a/workspace",
    });
  });

  it("prefers gsd.projectDir over workspace for the dir option", async () => {
    const getSessionMessages = vi.fn(async () => [
      txtMsg("assistant", [{ type: "text", text: "hi" }]),
    ]);
    await loadCompactionTurns({
      agentName: "gsd-agent",
      manager: { getSdkSessionId: () => "sess-9" },
      sdk: { getSessionMessages },
      config: {
        gsd: { projectDir: "/projects/gsd" },
        workspace: "/home/gsd-agent/workspace",
      },
      log: silentLog(),
    });
    expect(getSessionMessages).toHaveBeenCalledWith("sess-9", {
      dir: "/projects/gsd",
    });
  });

  it("fail-open: returns null when getSessionMessages throws", async () => {
    const getSessionMessages = vi.fn(async () => {
      throw new Error("transcript read failed");
    });
    const text = await loadCompactionTurns({
      agentName: "agent-b",
      manager: { getSdkSessionId: () => "sess-2" },
      sdk: { getSessionMessages },
      config: { workspace: "/ws" },
      log: silentLog(),
    });
    expect(text).toBeNull();
  });

  it("fail-open: returns null when there is no active session", async () => {
    const getSessionMessages = vi.fn(async () => []);
    const text = await loadCompactionTurns({
      agentName: "agent-c",
      manager: { getSdkSessionId: () => undefined },
      sdk: { getSessionMessages },
      config: { workspace: "/ws" },
      log: silentLog(),
    });
    expect(text).toBeNull();
    // No session → never even calls getSessionMessages.
    expect(getSessionMessages).not.toHaveBeenCalled();
  });

  it("fail-open: returns null when the agent config is absent", async () => {
    const getSessionMessages = vi.fn(async () => []);
    const text = await loadCompactionTurns({
      agentName: "agent-d",
      manager: { getSdkSessionId: () => "sess-4" },
      sdk: { getSessionMessages },
      config: undefined,
      log: silentLog(),
    });
    expect(text).toBeNull();
    expect(getSessionMessages).not.toHaveBeenCalled();
  });

  it("fail-open: returns null when the transcript is empty (Codex stub)", async () => {
    const getSessionMessages = vi.fn(async () => []);
    const text = await loadCompactionTurns({
      agentName: "codex-agent",
      manager: { getSdkSessionId: () => "sess-5" },
      sdk: { getSessionMessages },
      config: { workspace: "/ws" },
      log: silentLog(),
    });
    expect(text).toBeNull();
  });
});
