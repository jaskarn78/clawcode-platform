/**
 * Phase 94 Plan 05 — TOOL-08 / D-08 auto-injected Discord message fetcher.
 *
 * The tool is auto-injected for every agent (alongside the existing
 * clawcode/browser/search/image MCPs). It lets the LLM read prior
 * channel/thread messages — closing the operator-reported context gap
 * (2026-04-25 fin-client screenshot) where an agent could not access
 * a thread's history without a manual paste.
 *
 * DI-pure module. No fs imports, no discord.js imports, no clock
 * construction. The production daemon edge wires `deps.fetchMessages` to
 * the Claude Agent SDK Discord plugin's `plugin:discord:fetch_messages`
 * surface OR to discord.js `client.channels.fetch().messages.fetch()`.
 * Tests stub via vi.fn().
 *
 * Internal failures (Discord 401/403/429, network, etc) wrap into the
 * Plan 94-04 ToolCallError shape so the LLM receives a structured
 * failure and adapts naturally — it does NOT see a raw exception.
 *
 * Limit semantics:
 *   - default: 50
 *   - max: 100 (Discord API caps at 100 per request; pagination via
 *     `before=<message_id>` is the API-compliant path for older history)
 *
 * Threads vs channels: Discord treats threads as channels with parent
 * IDs. The same `channel_id` field accepts either snowflake; permission
 * gating is enforced server-side by Discord.
 */

import type { Logger } from "pino";
import { wrapMcpToolError, type ToolCallError } from "../tool-call-error.js";

export interface FetchDiscordMessagesInput {
  readonly channel_id: string;
  /** Default 50. Clamped to [1, 100] (Discord API limit). */
  readonly limit?: number;
  /** Message snowflake — fetch messages older than this ID. */
  readonly before?: string;
}

export interface DiscordMessageOut {
  readonly id: string;
  /** Username (not user ID) — agent-readable. */
  readonly author: string;
  readonly content: string;
  /** ISO8601 timestamp. */
  readonly ts: string;
  readonly attachments: readonly { readonly filename: string; readonly url: string }[];
}

export interface FetchDiscordMessagesOutput {
  readonly messages: readonly DiscordMessageOut[];
}

export interface FetchDiscordMessagesDeps {
  /**
   * Production wires this to the SDK Discord plugin's
   * `plugin:discord:fetch_messages` surface OR to discord.js
   * `client.channels.fetch(id).messages.fetch({limit, before})` mapped to
   * the DiscordMessageOut shape.
   */
  readonly fetchMessages: (
    channelId: string,
    options: { limit?: number; before?: string },
  ) => Promise<readonly DiscordMessageOut[]>;
  readonly log: Logger;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * Tool definition shape — exactly the keys the SDK tool registry expects.
 * NO `mcpServer` attribution: this tool is built-in (not MCP-backed), so
 * the Plan 94-02 capability-probe filter never removes it from the
 * LLM-visible tool list.
 */
export const CLAWCODE_FETCH_DISCORD_MESSAGES_DEF = {
  name: "clawcode_fetch_discord_messages",
  description:
    "Fetch the most recent messages from a Discord channel or thread (Discord treats threads as channels). " +
    "Use channel_id for either. Limit defaults to 50, max 100. " +
    "Use before=<message_id> to page back further when N > 100 needed.",
  input_schema: {
    type: "object",
    properties: {
      channel_id: {
        type: "string",
        description: "Discord channel or thread ID (snowflake)",
      },
      limit: {
        type: "number",
        minimum: 1,
        maximum: MAX_LIMIT,
        description: "Number of messages to fetch (1-100; default 50)",
      },
      before: {
        type: "string",
        description: "Message snowflake — fetch messages older than this ID",
      },
    },
    required: ["channel_id"],
  },
} as const;

/**
 * Pure handler. Always returns a value — never throws (LLM tool-result
 * contract). Failures wrap via Plan 94-04 wrapMcpToolError.
 */
export async function clawcodeFetchDiscordMessages(
  input: FetchDiscordMessagesInput,
  deps: FetchDiscordMessagesDeps,
): Promise<FetchDiscordMessagesOutput | ToolCallError> {
  const requested = input.limit ?? DEFAULT_LIMIT;
  // Clamp to Discord 100-msg API max + minimum 1.
  const limit = Math.max(1, Math.min(MAX_LIMIT, requested));

  try {
    const messages = await deps.fetchMessages(input.channel_id, {
      limit,
      ...(input.before !== undefined ? { before: input.before } : {}),
    });
    // Freeze each message + the wrapper output (CLAUDE.md immutability).
    const frozenMessages = Object.freeze(
      messages.map((m) =>
        Object.freeze({
          id: m.id,
          author: m.author,
          content: m.content,
          ts: m.ts,
          attachments: Object.freeze([...m.attachments]),
        }),
      ),
    );
    return Object.freeze({ messages: frozenMessages });
  } catch (err) {
    return wrapMcpToolError(err as Error | string, {
      tool: CLAWCODE_FETCH_DISCORD_MESSAGES_DEF.name,
    });
  }
}
