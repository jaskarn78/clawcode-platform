/**
 * Phase 101 T03 — Claude vision OCR backend (Tier 3 fallback per D-01/D-02).
 *
 * Invoked when both Tesseract backends return below the confidence threshold
 * or empty text. Reuses the Phase 113 vision pattern from
 * `src/discord/vision-pre-pass.ts` + `src/manager/haiku-direct.ts` — same
 * OAuth-token Bearer auth, same `createWithAuthRetry` retry semantics.
 *
 * Model selection (D-02):
 *   - `taskHint: undefined | "standard"` → claude-haiku-4-5 (~$0.005/page)
 *   - `taskHint: "high-precision"`       → claude-sonnet-5 (~$0.015/page)
 *
 * Image dimensions are pre-resized to ≤ DIMENSION_MAX_PX (2000px) via sharp
 * before send — direct mitigation for the 2026-04-28 Client C-tax-return
 * many-image / over-2000px failure (canonical issue
 * https://github.com/anthropics/claude-code/issues/49537).
 */

import sharp from "sharp";
import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { OcrBackend, TaskHint } from "../types.js";
import type { OcrResult } from "./tesseract-cli.js";
import { getHaikuRouting } from "../../manager/haiku-direct.js";
import { runHaikuViaBridge } from "../../bridge/haiku-via-bridge.js";
import { isVisionRefusal } from "../../vision/refusal-sentinel.js";

/** Max long-side pixels for any image sent to Claude vision (D-04, T-101-04). */
export const DIMENSION_MAX_PX = 2000;

/** D-02: default Haiku model id. */
export const CLAUDE_VISION_MODEL_DEFAULT = "claude-haiku-4-5";

/** D-02: high-precision Sonnet model id. */
export const CLAUDE_VISION_MODEL_HIGH_PRECISION = "claude-sonnet-5";

const OCR_SYSTEM_PROMPT =
  "You are a precise OCR engine. Transcribe visible page text verbatim.";

const OCR_USER_PROMPT =
  "Transcribe the visible text in this page image verbatim. Preserve tables as Markdown. Return ONLY the transcribed text — no commentary.";

/** Pick the model id for a given task-hint per D-02. */
export function pickVisionModel(hint: TaskHint | undefined): string {
  return hint === "high-precision"
    ? CLAUDE_VISION_MODEL_HIGH_PRECISION
    : CLAUDE_VISION_MODEL_DEFAULT;
}

/** Pick which OcrBackend label is reported in telemetry for a given hint. */
function pickBackendLabel(hint: TaskHint | undefined): OcrBackend {
  return hint === "high-precision" ? "claude-sonnet" : "claude-haiku";
}

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

/** Internal seam — overridable by tests to mock the SDK without OAuth setup. */
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
export function _setVisionClientForTests(client: AnthropicLike | null): void {
  testClientOverride = client;
  cachedClient = null;
  cachedToken = null;
}

/**
 * Run Claude vision OCR on a single page image. Image is resized to
 * DIMENSION_MAX_PX via sharp before send (mitigation for T-101-04).
 */
export async function ocrPageClaudeVision(
  imageBuffer: Buffer,
  opts: { taskHint?: TaskHint; signal?: AbortSignal } = {},
): Promise<OcrResult> {
  // Pre-resize for the API ceiling. `fit: inside` preserves aspect ratio;
  // `withoutEnlargement` avoids upscaling tiny thumbnails.
  const resized = await sharp(imageBuffer)
    .resize({
      width: DIMENSION_MAX_PX,
      height: DIMENSION_MAX_PX,
      fit: "inside",
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();

  // Phase 999.154 — one policy for every Claude-vision call: under the
  // fleet's `haikuDirectRouting: bridge` default, OCR goes through the binary
  // (stream-json image envelope) like every other vision consumer instead of
  // a raw OAuth SDK call. Tests that inject a client keep the direct path.
  if (testClientOverride === null && getHaikuRouting() === "bridge") {
    const result = await runHaikuViaBridge({
      site: "ocr-vision",
      systemPrompt: OCR_SYSTEM_PROMPT,
      userPrompt: OCR_USER_PROMPT,
      model: opts.taskHint === "high-precision" ? "sonnet" : "haiku",
      images: [{ mediaType: "image/png", data: resized.toString("base64") }],
      signal: opts.signal,
    });
    const bridged =
      result.succeeded && !isVisionRefusal(result.text) ? result.text.trim() : "";
    return {
      text: bridged,
      confidence: bridged.length === 0 ? 0 : 1,
      backend: pickBackendLabel(opts.taskHint),
    };
  }

  const client: AnthropicLike =
    testClientOverride ?? ((await getClient()) as unknown as AnthropicLike);
  const model = pickVisionModel(opts.taskHint);

  const response = await client.messages.create(
    {
      model,
      max_tokens: 2048,
      system: OCR_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: resized.toString("base64"),
              },
            },
            { type: "text", text: OCR_USER_PROMPT },
          ],
        },
      ],
    },
    { signal: opts.signal },
  );

  const block = response.content[0];
  const text =
    block && block.type === "text" ? (block as { text: string }).text : "";
  return {
    text: text.trim(),
    // Claude vision has no probabilistic confidence; report 1.0 when text
    // came back, 0 when empty. The orchestrator already treats vision as the
    // last-resort tier so the confidence value is purely informational.
    confidence: text.trim().length === 0 ? 0 : 1,
    backend: pickBackendLabel(opts.taskHint),
  };
}
