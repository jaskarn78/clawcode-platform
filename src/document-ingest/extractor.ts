/**
 * Phase 101 Plan 02 T03 — structured extraction via Anthropic tool-use (U4).
 *
 * `extractStructured(text, schemaName, opts)` runs an Anthropic `messages.create`
 * call with `tools: [{name: schemaName, input_schema: <zod-derived JSON Schema>}]`
 * + `tool_choice: {type: "tool", name: schemaName}`, then zod-parses the resulting
 * `tool_use.input` block through the registry-resolved zod schema.
 *
 * Model selection (D-02 parity with claude-vision.ts):
 *   - taskHint: undefined | "standard"  → claude-haiku-4-5
 *   - taskHint: "high-precision"        → claude-sonnet-5
 *
 * On zod.parse failure, throws an `IngestError` whose message embeds the
 * missing/invalid fields list so `recordIngestAlert` (T05) can surface them
 * without re-running the parse.
 *
 * OAuth + client caching mirror `src/document-ingest/ocr/claude-vision.ts`
 * verbatim — same `~/.claude/.credentials.json` path, same Anthropic SDK
 * `authToken` shape.
 */

import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import {
  EXTRACTION_SCHEMAS,
  type ExtractionSchemaName,
} from "./schemas/index.js";
import { IngestError } from "./page-batch.js";
import type { TaskHint } from "./types.js";

export { IngestError } from "./page-batch.js";

/** D-02 default extraction model (parity with claude-vision.ts). */
export const EXTRACTOR_MODEL_DEFAULT = "claude-haiku-4-5";

/** D-02 high-precision extraction model. */
export const EXTRACTOR_MODEL_HIGH_PRECISION = "claude-sonnet-5";

/** Pick the extraction model id for a given task-hint per D-02. */
export function pickExtractionModel(hint: TaskHint | undefined): string {
  return hint === "high-precision"
    ? EXTRACTOR_MODEL_HIGH_PRECISION
    : EXTRACTOR_MODEL_DEFAULT;
}

const EXTRACTOR_SYSTEM_PROMPT =
  "You are a precise structured-data extractor. Read the document text and " +
  "call the provided tool with the matching fields. Return only via the tool " +
  "call — never plain text. Use null for fields not present in the document.";

// ---------------------------------------------------------------------------
// Anthropic client wiring (mirrors claude-vision.ts).
// ---------------------------------------------------------------------------

let cachedClient: Anthropic | null = null;
let cachedToken: string | null = null;

async function loadOAuthToken(): Promise<string> {
  const path = join(homedir(), ".claude", ".credentials.json");
  const raw = await readFile(path, "utf-8");
  const creds = JSON.parse(raw) as Record<string, unknown>;
  const oauth = creds["claudeAiOauth"] as Record<string, unknown> | undefined;
  const token = oauth?.["accessToken"];
  if (typeof token !== "string" || token.length === 0) {
    throw new Error(
      "claudeAiOauth.accessToken missing from ~/.claude/.credentials.json",
    );
  }
  return token;
}

async function getClient(): Promise<Anthropic> {
  const token = await loadOAuthToken();
  if (cachedClient && cachedToken === token) return cachedClient;
  cachedClient = new Anthropic({ apiKey: null, authToken: token });
  cachedToken = token;
  return cachedClient;
}

/** Test seam mirroring `_setVisionClientForTests` (claude-vision.ts). */
type AnthropicLike = {
  messages: {
    create: (
      args: Anthropic.MessageCreateParamsNonStreaming,
      opts?: { signal?: AbortSignal },
    ) => Promise<Anthropic.Message>;
  };
};

let testClientOverride: AnthropicLike | null = null;

/** Test-only: inject a fake Anthropic client. Resets to real on null. */
export function _setExtractorClientForTests(client: AnthropicLike | null): void {
  testClientOverride = client;
  cachedClient = null;
  cachedToken = null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ExtractStructuredOptions = {
  readonly taskHint?: TaskHint;
  readonly signal?: AbortSignal;
};

/**
 * Run structured extraction. Returns the zod-validated tool result, typed
 * per the registry entry `EXTRACTION_SCHEMAS[schemaName]`.
 *
 * Throws `IngestError` on validation failure with a "structured extraction
 * failed: <field-path> -> <issue>" message. The error's `missingFields`
 * property carries the ZodError issue paths so `recordIngestAlert` (T05) can
 * forward them as alert metadata.
 */
export async function extractStructured<S extends ExtractionSchemaName>(
  text: string,
  schemaName: S,
  opts: ExtractStructuredOptions = {},
): Promise<z.infer<(typeof EXTRACTION_SCHEMAS)[S]>> {
  const schema = EXTRACTION_SCHEMAS[schemaName];
  if (!schema) {
    throw new IngestError(
      `unknown extraction schema: '${schemaName}' (registered: ${Object.keys(
        EXTRACTION_SCHEMAS,
      ).join(", ")})`,
    );
  }

  // zod 4.3.6 native — no zod-to-json-schema dependency.
  const inputSchema = z.toJSONSchema(schema) as unknown as Record<
    string,
    unknown
  >;

  const client: AnthropicLike =
    testClientOverride ?? ((await getClient()) as unknown as AnthropicLike);

  const model = pickExtractionModel(opts.taskHint);

  const response = await client.messages.create(
    {
      model,
      max_tokens: 4096,
      system: EXTRACTOR_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text }],
        },
      ],
      tools: [
        {
          name: schemaName,
          description:
            `Return the extracted ${schemaName} object matching the input_schema. ` +
            `Fields absent from the document must be null. Do not invent values.`,
          input_schema: inputSchema as unknown as Anthropic.Messages.Tool.InputSchema,
        },
      ],
      tool_choice: { type: "tool", name: schemaName },
    },
    { signal: opts.signal },
  );

  // Find the first tool_use block. Anthropic returns tool_use blocks
  // alongside any optional thinking/text blocks; the forced tool_choice
  // guarantees one exists when the call succeeds.
  const toolBlock = response.content.find(
    (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
  );
  if (!toolBlock) {
    throw new IngestError(
      `structured extraction failed: no tool_use block in response (schema: ${schemaName})`,
    );
  }

  const parseResult = schema.safeParse(toolBlock.input);
  if (!parseResult.success) {
    const issues = parseResult.error.issues;
    const missingFields = issues.map((i) => i.path.join("."));
    const firstIssue = issues[0];
    const detail = firstIssue
      ? `${firstIssue.path.join(".")} -> ${firstIssue.message}`
      : "unknown";
    const err = new IngestError(
      `structured extraction failed: ${detail} (schema: ${schemaName})`,
    );
    // Attach the missingFields list so the alerts pipeline (T05) doesn't need
    // to re-parse to surface it.
    (err as IngestError & { missingFields?: readonly string[] }).missingFields =
      missingFields;
    throw err;
  }

  return parseResult.data as z.infer<(typeof EXTRACTION_SCHEMAS)[S]>;
}
