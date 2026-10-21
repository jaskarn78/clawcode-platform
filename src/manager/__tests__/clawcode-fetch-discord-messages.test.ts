/**
 * Phase 94 Plan 05 Task 1 — TDD RED for clawcode_fetch_discord_messages
 * (TOOL-08 / D-08).
 *
 * The tool is auto-injected for every agent and lets the LLM read prior
 * Discord channel/thread messages — closing the operator-reported context
 * gap (2026-04-25) where an agent could not read a thread's history
 * without a manual paste.
 *
 * Test pins:
 *   FDM-HAPPY         — happy fetch returns the deps-supplied messages array
 *   FDM-LIMIT-DEFAULT — input without limit fans out to fetchMessages with limit=50
 *   FDM-LIMIT-MAX     — input.limit=500 clamps to limit=100 (Discord 100-msg API max)
 *   FDM-THREAD-ID     — same channel_id field accepts a thread snowflake (Discord
 *                       treats threads as channels with parent IDs)
 *   FDM-ERROR-WRAP    — fetchMessages rejects with "403 Missing Access" → returns
 *                       ToolCallError with errorClass="permission" (94-04 reuse)
 */

import { describe, it, expect, vi } from "vitest";
import pino from "pino";
import {
  clawcodeFetchDiscordMessages,
  type DiscordMessageOut,
} from "../tools/clawcode-fetch-discord-messages.js";
import type { ToolCallError } from "../tool-call-error.js";

const silentLog = pino({ level: "silent" });

function makeMessage(overrides: Partial<DiscordMessageOut> = {}): DiscordMessageOut {
  return {
    id: "1",
    author: "owner_a",
    content: "hi",
    ts: "2026-04-25T05:00:00Z",
    attachments: [],
    ...overrides,
  };
}

describe("clawcodeFetchDiscordMessages — TOOL-08 D-08", () => {
  it("FDM-HAPPY: deps.fetchMessages stub return is propagated as output.messages", async () => {
    const fetchMessages = vi.fn(async () => [makeMessage({ id: "1" })]);
    const result = await clawcodeFetchDiscordMessages(
      { channel_id: "abc" },
      { fetchMessages, log: silentLog },
    );

    if ("kind" in result) {
      throw new Error(`expected success, got error: ${result.message}`);
    }
    expect(result.messages.length).toBe(1);
    expect(result.messages[0]?.id).toBe("1");
    expect(result.messages[0]?.author).toBe("owner_a");
  });

  it("FDM-LIMIT-DEFAULT: input WITHOUT limit fans out with options.limit === 50", async () => {
    const fetchMessages = vi.fn(
      async (
        _id: string,
        _opts: { limit?: number; before?: string },
      ): Promise<readonly DiscordMessageOut[]> => [],
    );
    await clawcodeFetchDiscordMessages(
      { channel_id: "abc" },
      { fetchMessages, log: silentLog },
    );
    expect(fetchMessages).toHaveBeenCalledTimes(1);
    const callArgs = fetchMessages.mock.calls[0]!;
    expect(callArgs[0]).toBe("abc");
    expect(callArgs[1].limit).toBe(50);
  });

  it("FDM-LIMIT-MAX: input.limit=500 is clamped to 100 (Discord 100-msg API max)", async () => {
    const fetchMessages = vi.fn(
      async (
        _id: string,
        _opts: { limit?: number; before?: string },
      ): Promise<readonly DiscordMessageOut[]> => [],
    );
    await clawcodeFetchDiscordMessages(
      { channel_id: "abc", limit: 500 },
      { fetchMessages, log: silentLog },
    );
    const callArgs = fetchMessages.mock.calls[0]!;
    expect(callArgs[1].limit).toBe(100);
  });

  it("FDM-THREAD-ID: same channel_id field accepts a thread snowflake (Discord-treats-threads-as-channels)", async () => {
    // Discord treats threads as channels with parent IDs — the same fetch
    // surface works for both. The handler must NOT reject on a snowflake
    // that happens to be a thread.
    const threadSnowflake = "000000000000000104";
    const fetchMessages = vi.fn(async () => [
      makeMessage({ id: "thread-msg-1", content: "in thread" }),
    ]);
    const result = await clawcodeFetchDiscordMessages(
      { channel_id: threadSnowflake },
      { fetchMessages, log: silentLog },
    );
    if ("kind" in result) {
      throw new Error(`expected success on thread snowflake, got error: ${result.message}`);
    }
    expect(result.messages.length).toBe(1);
    expect(fetchMessages).toHaveBeenCalledWith(
      threadSnowflake,
      expect.objectContaining({ limit: 50 }),
    );
  });

  it("FDM-ERROR-WRAP: 403 Missing Access wraps into ToolCallError with errorClass='permission'", async () => {
    const fetchMessages = vi.fn(async () => {
      throw new Error("403 Missing Access");
    });
    const result = await clawcodeFetchDiscordMessages(
      { channel_id: "abc" },
      { fetchMessages, log: silentLog },
    );
    expect("kind" in result).toBe(true);
    const err = result as ToolCallError;
    expect(err.kind).toBe("ToolCallError");
    expect(err.tool).toBe("clawcode_fetch_discord_messages");
    expect(err.errorClass).toBe("permission");
    expect(err.message).toContain("403");
  });
});
