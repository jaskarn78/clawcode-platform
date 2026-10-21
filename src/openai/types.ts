/**
 * Phase 69 Plan 02 — OpenAI wire-format schemas + TS types.
 *
 * Exports Zod v4 schemas for INCOMING request shapes (validated at the HTTP
 * boundary) and pure TypeScript types for OUTGOING response shapes (we build
 * these, we don't validate them). Also exports Claude-side intermediate types
 * that `src/openai/translator.ts` produces from OpenAI inputs.
 *
 * Design rules enforced here (cross-referenced to 69-RESEARCH.md Pitfalls):
 *
 *   - Pitfall 2: OpenAI SDK validators are STRICT on required top-level fields
 *     (`id`, `object`, `created`, `model`). Every response/chunk TS type marks
 *     them all required. `created` is epoch SECONDS, never milliseconds.
 *   - Pitfall 2: `usage` on streaming chunks is OMITTED by default — clients
 *     that want it send `stream_options.include_usage: true`. We reflect that
 *     as an optional field on `ChatCompletionChunk` (absent by default).
 *   - Pitfall 2: `passthrough()` on the incoming request so OpenAI's own
 *     extension fields (e.g. `reasoning_effort`, `service_tier`) don't trip
 *     the parser. We never read them; we just don't block them.
 *   - Pitfall 3: role appears once on first streaming chunk — enforced in
 *     translator.ts; the delta type permits optional `role`.
 *   - Pitfall 4: SSE framing is stream.ts's responsibility; types carry the
 *     shape only.
 *   - Pitfall 8: `clientSystemAppend` flows into `systemPrompt.append` — NEVER
 *     overrides the stable prefix (prompt-cache preservation).
 *
 * Also re-exports the SdkStreamEvent shape the translator consumes from the
 * Claude Agent SDK — a minimal copy of the subset of fields we actually touch.
 * The server receives these events from the injected OpenAiSessionDriver (the
 * mock in tests; the real SessionManager-backed driver in Plan 03).
 */

import { z } from "zod/v4";
import { MODEL_ALIAS_CATALOG } from "../shared/model-catalog.js";

// ---------------------------------------------------------------------------
// Incoming request schemas (Zod — validated at boundary)
// ---------------------------------------------------------------------------

/**
 * OpenAI tool-call delta inside an `assistant` message (when the client
 * re-sends prior assistant turns). We accept the shape but do not consume
 * these historical tool_calls — the underlying Claude session already has
 * them via `resume:`. Presence is tolerated for spec conformance.
 */
const assistantToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

/**
 * Chat message discriminated union on `role`:
 *   - `system`, `user`  — `content` required string
 *   - `assistant`       — `content` nullable string, optional `tool_calls`
 *   - `tool`            — `tool_call_id` required, `content` required string
 *
 * Zod v4 uses `z.discriminatedUnion` with each option as an object whose
 * `role` field is a literal. `.passthrough()` is intentionally NOT set on the
 * branches — the outer request schema passes through, per Pitfall 2.
 */
/**
 * OpenAI content-parts — the multi-modal shape where `content` is an array of
 * typed parts rather than a single string. OpenClaw and most modern OpenAI-
 * compatible clients (LangChain, Vercel AI SDK) emit this form. Supported
 * part types: `text` (always), `image_url` (accepted — translator concats
 * the url as markdown-style for now; full vision wiring is follow-up work).
 * Unknown part types are accepted via passthrough and ignored downstream.
 */
const textContentPartSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});
const imageUrlContentPartSchema = z.object({
  type: z.literal("image_url"),
  image_url: z.union([
    z.string(),
    z.object({ url: z.string(), detail: z.string().optional() }).passthrough(),
  ]),
});
const contentPartSchema = z.union([
  textContentPartSchema,
  imageUrlContentPartSchema,
  z.object({ type: z.string() }).passthrough(), // tolerate future part kinds
]);

/** Accepts legacy `string` OR OpenAI multi-modal `array<ContentPart>` shape. */
const stringOrPartsSchema = z.union([z.string(), z.array(contentPartSchema)]);

export const chatMessageSchema = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("system"),
    content: stringOrPartsSchema,
  }),
  z.object({
    role: z.literal("user"),
    content: stringOrPartsSchema,
  }),
  z.object({
    role: z.literal("assistant"),
    content: stringOrPartsSchema.nullable(),
    tool_calls: z.array(assistantToolCallSchema).optional(),
  }),
  z.object({
    role: z.literal("tool"),
    tool_call_id: z.string(),
    content: stringOrPartsSchema,
  }),
]);

export type ChatMessage = z.infer<typeof chatMessageSchema>;

/**
 * OpenAI tool definition — `{type:"function", function:{name, description?, parameters?}}`.
 * `parameters` is a JSON Schema object; we pass it through as-is.
 */
export const toolDefSchema = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.any()).optional(),
  }),
});

export type ToolDef = z.infer<typeof toolDefSchema>;

/**
 * `tool_choice`: literal "auto"/"none"/"required" OR a named function selector.
 */
export const toolChoiceSchema = z.union([
  z.literal("auto"),
  z.literal("none"),
  z.literal("required"),
  z.object({
    type: z.literal("function"),
    function: z.object({
      name: z.string().min(1),
    }),
  }),
]);

export type ToolChoice = z.infer<typeof toolChoiceSchema>;

/**
 * `stream_options` — tiny sub-object used only by clients that want the
 * streaming `usage` final chunk (Pitfall 2).
 */
export const streamOptionsSchema = z.object({
  include_usage: z.boolean().optional(),
});

/**
 * Chat Completion request body (`POST /v1/chat/completions`).
 *
 * `.passthrough()` allows OpenAI-spec extension fields (reasoning_effort,
 * service_tier, user, presence_penalty, etc.) to flow through without
 * blocking. Our translator consumes only the fields it understands.
 */
export const chatCompletionRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(chatMessageSchema).min(1),
    stream: z.boolean().default(false),
    temperature: z.number().min(0).max(2).optional(),
    tools: z.array(toolDefSchema).optional(),
    tool_choice: toolChoiceSchema.optional(),
    stream_options: streamOptionsSchema.optional(),
  })
  .passthrough();

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;

// ---------------------------------------------------------------------------
// Outgoing response TS types (we build, never validate)
// ---------------------------------------------------------------------------

/** Final-form tool_call object in a non-streaming response `message`. */
export interface ChatCompletionToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/** Partial tool_call delta in a streaming chunk. */
export interface ChatCompletionToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

/** Token-usage sub-object. */
export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/**
 * Non-streaming response shape for `POST /v1/chat/completions`.
 *
 * Required top-level fields (Pitfall 2): `id`, `object`, `created`, `model`,
 * `choices`, `usage`. `system_fingerprint` is present and explicitly `null`
 * (OpenAI's own responses do the same when no fingerprint is available).
 */
export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: ChatCompletionToolCall[];
    };
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter";
    logprobs: null;
  }>;
  usage: ChatCompletionUsage;
  system_fingerprint: null;
}

/**
 * Streaming chunk shape for `POST /v1/chat/completions` with `stream:true`.
 *
 * Delta rules (Pitfall 3): `role` appears on the first chunk only. Middle
 * chunks carry `content` or `tool_calls` deltas. Final chunk carries an empty
 * delta `{}` plus `finish_reason`. `usage` is absent unless the client
 * requested `stream_options.include_usage` — in which case it arrives in a
 * separate trailing chunk with `choices: []` (Plan 02 does not implement that
 * trailing chunk yet; the type permits it for Plan 03 extension).
 */
export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: "assistant";
      content?: string;
      tool_calls?: ChatCompletionToolCallDelta[];
    };
    finish_reason: "stop" | "length" | "tool_calls" | null;
  }>;
  usage?: ChatCompletionUsage;
  /**
   * ClawCode namespaced extension — carries voice `status`/`tool` liveness
   * payloads on an otherwise-empty chunk (`choices: []`). Strict OpenAI clients
   * ignore unknown fields, so this is non-breaking; clients that care read it.
   * Present only on voice liveness frames (emitEvent), never on content chunks.
   */
  x_clawcode_event?: { type: string; [k: string]: unknown };
}

/**
 * OpenAI error envelope. Every 4xx/5xx response body matches this shape.
 * `code` is `null` when no machine code applies.
 */
export interface OpenAiError {
  error: {
    message: string;
    type:
      | "invalid_request_error"
      | "authentication_error"
      | "permission_error"
      | "not_found_error"
      | "server_error"
      | "rate_limit_exceeded";
    code: string | null;
  };
}

/** `GET /v1/models` response. `owned_by` is always `"clawcode"`. */
export interface ModelsListResponse {
  object: "list";
  data: Array<{
    id: string;
    object: "model";
    created: number;
    owned_by: "clawcode";
  }>;
}

// ---------------------------------------------------------------------------
// Claude-side intermediate types (translator output → driver input)
// ---------------------------------------------------------------------------

/**
 * Claude `tool_choice` as consumed by the Claude Agent SDK.
 *
 * Mapping (Pattern 4 in 69-RESEARCH.md):
 *   OpenAI `"auto"`     → `{type:"auto"}`
 *   OpenAI `"none"`     → `{type:"none"}`
 *   OpenAI `"required"` → `{type:"any"}`
 *   OpenAI named        → `{type:"tool", name}`
 */
export type ClaudeToolChoice =
  | { type: "auto" }
  | { type: "none" }
  | { type: "any" }
  | { type: "tool"; name: string };

/** Claude tool definition. `input_schema` is the OpenAI `parameters` JSON Schema. */
export interface ClaudeToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * Claude `tool_result` block — produced from a client `role:"tool"` message.
 * `tool_use_id` matches the OpenAI `tool_call_id` on the inbound message.
 */
export interface ClaudeToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

// ---------------------------------------------------------------------------
// SDK stream event shape (minimal — translator.ts consumes this subset)
// ---------------------------------------------------------------------------

/**
 * Subset of `@anthropic-ai/claude-agent-sdk` stream message types that
 * translator.ts needs. Mirrors the real SDK shape (see
 * `src/manager/session-adapter.ts` for the full usage) — translator.ts
 * treats these as pure values, never introspecting beyond these fields.
 *
 * Recorded as JSON in `__tests__/fixtures/sdk-stream-*.json` for replay tests.
 */
export type SdkStreamEvent =
  | {
      type: "stream_event";
      event:
        | {
            type: "content_block_start";
            index: number;
            content_block:
              | { type: "text" }
              | { type: "tool_use"; id: string; name: string; input?: unknown };
          }
        | {
            type: "content_block_delta";
            index: number;
            delta:
              | { type: "text_delta"; text: string }
              | { type: "input_json_delta"; partial_json: string };
          }
        | {
            type: "content_block_stop";
            index: number;
          };
    }
  | {
      type: "assistant";
      message: {
        content: Array<
          | { type: "text"; text: string }
          | { type: "tool_use"; id: string; name: string; input: unknown }
        >;
      };
      session_id?: string;
      parent_tool_use_id: string | null;
    }
  | {
      type: "result";
      session_id: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
      };
      is_error?: boolean;
      subtype?: string;
    }
  // Voice §4 — synthetic event the OpenAI driver injects (voice path only) when
  // the session handle reports a tool start (client `tool_use` OR server-side
  // `server_tool_use` e.g. web_search). The translator IGNORES it (not a
  // stream_event) so the content stream stays clean — no spurious tool_calls;
  // the voice-events classifier consumes it to emit an `event: tool` label.
  | {
      type: "voice_tool";
      name: string;
    };

/**
 * Claude usage shape as emitted on the `result` message. Translator maps this
 * to OpenAI `usage`:
 *
 *   prompt_tokens     = input_tokens + cache_read_input_tokens
 *   completion_tokens = output_tokens
 *   total_tokens      = prompt_tokens + completion_tokens
 */
export interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
}

// ---------------------------------------------------------------------------
// Phase 74 Plan 01 — Caller-identity routing for the OpenClaw-backend path.
// ---------------------------------------------------------------------------

/** Namespace prefix that distinguishes template-driver requests from native routing. */
export const OPENCLAW_PREFIX = "openclaw:" as const;

/** Tier token (second colon-segment) → concrete Claude model id.
 *  The tier SET (which aliases the OpenAI-compatible endpoint exposes) is a
 *  policy decision kept here; the id VALUES derive from the model catalog. The
 *  `haiku` tier pins a dated snapshot via the catalog's `tierId` (the executor
 *  uses the undated alias); `sonnet` follows the catalog pin (claude-sonnet-5). */
export const TIER_MODEL_MAP = {
  sonnet: MODEL_ALIAS_CATALOG.sonnet.id,
  opus: MODEL_ALIAS_CATALOG.opus.id,
  haiku: MODEL_ALIAS_CATALOG.haiku.tierId,
} as const;
export type Tier = keyof typeof TIER_MODEL_MAP;

/** Output of extractCallerIdentity — discriminator between native + template. */
export type CallerIdentity =
  | { readonly kind: "clawcode-native"; readonly agentName: string }
  | {
      readonly kind: "openclaw-template";
      readonly callerSlug: string;                      // regex-validated, safe for file paths + logs
      readonly tier: Tier;                              // sonnet | opus | haiku (defaults to sonnet)
      readonly soulPrompt: string;                      // may be empty string
      readonly soulFp: string;                          // sha256(soulPrompt).slice(0,16) — 16 hex chars
      readonly tools: ClaudeToolDef[] | null;           // Phase 69 translator output, unchanged
      readonly toolChoice: ClaudeToolChoice | null;
      readonly toolResults: ClaudeToolResultBlock[];    // pass-through (OpenAI tool role replies)
    };

/**
 * CAM-01/02 (Phase 6 multimodal) — a decoded, validated inline image
 * attachment for a user turn. `data` is RAW base64 (the `data:<mime>;base64,`
 * prefix stripped); `mediaType` is one of the SUPPORTED_IMAGE_MEDIA_TYPES.
 * Produced by `translateRequest` from OpenAI `image_url` parts and threaded
 * to the session handle as an Anthropic `image` content block. Structurally
 * compatible with `SendImageInput` (src/manager/session-adapter.ts) — kept as
 * an OpenAI-local type so server.ts stays free of src/manager imports.
 */
export interface OpenAiImageInput {
  readonly mediaType: string;
  readonly data: string;
}

/**
 * Shape the template driver receives from server.ts on the openclaw-template
 * branch. Carries BOTH the native OpenAiSessionDriver.dispatch fields
 * (agentName, keyHash, lastUserMessage, clientSystemAppend, tools, toolChoice,
 * toolResults, signal, xRequestId) AND the template-specific fields
 * (callerSlug, tier, soulPrompt, soulFp) so the server can pass a single object
 * that satisfies the driver interface at both layers.
 */
export interface TemplateDriverInput {
  readonly agentName: string;                           // `openclaw:${callerSlug}` for log attribution
  readonly keyHash: string;                             // row.key_hash (64 hex)
  readonly callerSlug: string;
  readonly tier: Tier;
  readonly soulPrompt: string;
  readonly soulFp: string;
  readonly lastUserMessage: string;                     // from Phase 69 translateRequest
  readonly lastUserImages?: readonly OpenAiImageInput[]; // CAM-01/02 inline vision attachments (optional; empty/undefined → text-only)
  readonly clientSystemAppend: string | null;           // ignored by template driver; kept for OpenAiSessionDriver conformance
  readonly tools: ClaudeToolDef[] | null;
  readonly toolChoice: ClaudeToolChoice | null;
  readonly toolResults: ClaudeToolResultBlock[];
  readonly signal: AbortSignal;
  readonly xRequestId: string;
}
