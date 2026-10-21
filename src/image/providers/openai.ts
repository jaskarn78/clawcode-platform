/**
 * Phase 72 — OpenAI Images API client (DALL-E 2 / 3 / gpt-image-1).
 *
 * Endpoints:
 *   POST https://api.openai.com/v1/images/generations  (JSON)
 *   POST https://api.openai.com/v1/images/edits        (multipart)
 *   POST https://api.openai.com/v1/images/variations   (multipart)
 *
 * Auth: `Authorization: Bearer <OPENAI_API_KEY>` header.
 *
 * Design rules (per 72-CONTEXT + CLAUDE.md):
 *  - NEVER throws — every path returns an `ImageToolOutcome<...>`.
 *  - Lazy API-key read: `createOpenAiImageClient(config, env)` does NOT
 *    read the key at construction. Each method reads
 *    `env[config.openai.apiKeyEnv]` so missing keys at daemon boot
 *    surface as `invalid_input` on the first actual call.
 *  - Frozen envelopes: every returned object is `Object.freeze`d.
 *  - Zero npm deps: native `fetch`, native `FormData`, native `Blob`
 *    (Node 22 has all three built-in).
 *
 * Response shape: requested via `response_format: "b64_json"` so we
 * don't have to chase a transient hosted URL — base64 decodes directly
 * into the Buffer that workspace.ts atomic-writes to disk.
 */

import { Buffer } from "node:buffer";
import type {
  ImageBackend,
  ImageToolOutcome,
} from "../types.js";
import type { ImageConfig } from "../../config/schema.js";
import { makeImageError, toImageToolError } from "../errors.js";
import { estimateImageCost } from "../costs.js";

const BACKEND: ImageBackend = "openai";
const ENDPOINT_GENERATE = "https://api.openai.com/v1/images/generations";
const ENDPOINT_EDIT = "https://api.openai.com/v1/images/edits";
const ENDPOINT_VARIATIONS = "https://api.openai.com/v1/images/variations";

/** Single decoded image returned by a provider call. */
export interface ProviderImage {
  readonly bytes: Buffer;
  readonly size: string;
  readonly model: string;
  readonly url?: string;
}

/** Aggregate provider-call result (fed back into tools.ts for workspace write). */
export interface ProviderImageBatch {
  readonly images: ReadonlyArray<ProviderImage>;
  readonly cost_cents: number;
}

export interface OpenAiGenerateArgs {
  readonly prompt: string;
  readonly size?: string;
  readonly n?: number;
  readonly model?: string;
  readonly style?: string;
}

export interface OpenAiEditArgs {
  readonly imageBytes: Buffer;
  readonly prompt: string;
  readonly maskBytes?: Buffer;
  readonly model?: string;
  readonly size?: string;
  readonly n?: number;
}

export interface OpenAiVariationsArgs {
  readonly imageBytes: Buffer;
  readonly n?: number;
  readonly model?: string;
  readonly size?: string;
}

export interface OpenAiImageClient {
  generate(args: OpenAiGenerateArgs): Promise<ImageToolOutcome<ProviderImageBatch>>;
  edit(args: OpenAiEditArgs): Promise<ImageToolOutcome<ProviderImageBatch>>;
  variations(args: OpenAiVariationsArgs): Promise<ImageToolOutcome<ProviderImageBatch>>;
}

interface OpenAiImageItem {
  b64_json?: string;
  url?: string;
  revised_prompt?: string;
}

interface OpenAiImageResponse {
  data?: OpenAiImageItem[];
  error?: { message?: string; code?: string; type?: string };
}

/** Map an HTTP error response body into our error taxonomy. */
function mapHttpError(
  status: number,
  body: string,
  retryAfter: number | undefined,
): ImageToolOutcome<ProviderImageBatch> {
  // 429 → rate_limit
  if (status === 429) {
    return Object.freeze({
      ok: false as const,
      error: makeImageError("rate_limit", "OpenAI rate limit exceeded", {
        backend: BACKEND,
        status,
        ...(retryAfter !== undefined ? { details: { retryAfter } } : {}),
      }),
    });
  }
  // Inspect body for content-policy markers (DALL-E returns 400 with
  // "content_policy_violation" or "safety system" copy).
  const lower = body.toLowerCase();
  if (
    status === 400 &&
    (lower.includes("content_policy_violation") ||
      lower.includes("safety system") ||
      lower.includes("safety filter"))
  ) {
    return Object.freeze({
      ok: false as const,
      error: makeImageError("content_policy", "OpenAI safety filter rejected the prompt", {
        backend: BACKEND,
        status,
      }),
    });
  }
  // 4xx → invalid_input (auth, bad args, bad model)
  if (status >= 400 && status < 500) {
    return Object.freeze({
      ok: false as const,
      error: makeImageError("invalid_input", `OpenAI API HTTP ${status}: ${body.slice(0, 200)}`, {
        backend: BACKEND,
        status,
      }),
    });
  }
  // 5xx → backend_unavailable
  return Object.freeze({
    ok: false as const,
    error: makeImageError("backend_unavailable", `OpenAI API HTTP ${status}`, {
      backend: BACKEND,
      status,
    }),
  });
}

/** Decode the JSON response into a frozen ProviderImageBatch. */
function decodeResponse(
  body: OpenAiImageResponse,
  size: string,
  model: string,
  n: number,
): ImageToolOutcome<ProviderImageBatch> {
  const items = body.data ?? [];
  if (items.length === 0) {
    return Object.freeze({
      ok: false as const,
      error: makeImageError("internal", "OpenAI returned empty image list", {
        backend: BACKEND,
      }),
    });
  }
  const decoded: ProviderImage[] = [];
  for (const item of items) {
    if (!item.b64_json || item.b64_json.length === 0) {
      return Object.freeze({
        ok: false as const,
        error: makeImageError("internal", "OpenAI image missing b64_json field", {
          backend: BACKEND,
        }),
      });
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(item.b64_json, "base64");
    } catch (err) {
      return Object.freeze({ ok: false as const, error: toImageToolError(err, "internal", BACKEND) });
    }
    const img: ProviderImage = item.url
      ? Object.freeze({ bytes, size, model, url: item.url })
      : Object.freeze({ bytes, size, model });
    decoded.push(img);
  }
  const cost_cents = estimateImageCost(BACKEND, model, size, n);
  return Object.freeze({
    ok: true as const,
    data: Object.freeze({
      images: Object.freeze(decoded),
      cost_cents,
    }),
  });
}

/**
 * Factory. Construction is zero-cost: no network, no env read, no
 * validation beyond what Zod already did on `config`.
 */
export function createOpenAiImageClient(
  config: ImageConfig,
  env: NodeJS.ProcessEnv = process.env,
): OpenAiImageClient {
  function readApiKey(): string | undefined {
    const key = env[config.openai.apiKeyEnv];
    return key && key.length > 0 ? key : undefined;
  }

  async function generate(
    args: OpenAiGenerateArgs,
  ): Promise<ImageToolOutcome<ProviderImageBatch>> {
    const apiKey = readApiKey();
    if (!apiKey) {
      return Object.freeze({
        ok: false as const,
        error: makeImageError(
          "invalid_input",
          `missing OpenAI API key (env var ${config.openai.apiKeyEnv} is unset)`,
          { backend: BACKEND },
        ),
      });
    }
    const model = args.model ?? config.openai.model;
    const size = args.size ?? "1024x1024";
    const n = args.n ?? 1;

    const reqBody: Record<string, unknown> = {
      model,
      prompt: args.prompt,
      n,
      size,
      response_format: "b64_json",
    };
    if (args.style) reqBody.style = args.style;

    let res: Response;
    try {
      res = await fetch(ENDPOINT_GENERATE, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (err) {
      return Object.freeze({
        ok: false as const,
        error: toImageToolError(err, "network", BACKEND),
      });
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const retryAfterHeader = res.headers.get("retry-after");
      const retryAfter = retryAfterHeader
        ? Number.parseInt(retryAfterHeader, 10)
        : undefined;
      return mapHttpError(
        res.status,
        body,
        Number.isFinite(retryAfter) ? retryAfter : undefined,
      );
    }

    let body: OpenAiImageResponse;
    try {
      body = (await res.json()) as OpenAiImageResponse;
    } catch (err) {
      return Object.freeze({
        ok: false as const,
        error: toImageToolError(err, "internal", BACKEND),
      });
    }

    return decodeResponse(body, size, model, n);
  }

  async function postMultipart(
    endpoint: string,
    form: FormData,
    apiKey: string,
  ): Promise<ImageToolOutcome<Response>> {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
        body: form,
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      return Object.freeze({ ok: true as const, data: res });
    } catch (err) {
      return Object.freeze({
        ok: false as const,
        error: toImageToolError(err, "network", BACKEND),
      });
    }
  }

  async function edit(
    args: OpenAiEditArgs,
  ): Promise<ImageToolOutcome<ProviderImageBatch>> {
    const apiKey = readApiKey();
    if (!apiKey) {
      return Object.freeze({
        ok: false as const,
        error: makeImageError(
          "invalid_input",
          `missing OpenAI API key (env var ${config.openai.apiKeyEnv} is unset)`,
          { backend: BACKEND },
        ),
      });
    }
    const model = args.model ?? "dall-e-2";
    const size = args.size ?? "1024x1024";
    const n = args.n ?? 1;

    const form = new FormData();
    form.append("model", model);
    form.append("prompt", args.prompt);
    form.append("n", String(n));
    form.append("size", size);
    form.append("response_format", "b64_json");
    form.append(
      "image",
      new Blob([new Uint8Array(args.imageBytes)], { type: "image/png" }),
      "image.png",
    );
    if (args.maskBytes) {
      form.append(
        "mask",
        new Blob([new Uint8Array(args.maskBytes)], { type: "image/png" }),
        "mask.png",
      );
    }

    const sendOutcome = await postMultipart(ENDPOINT_EDIT, form, apiKey);
    if (!sendOutcome.ok) return sendOutcome as ImageToolOutcome<ProviderImageBatch>;
    const res = sendOutcome.data;

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const retryAfterHeader = res.headers.get("retry-after");
      const retryAfter = retryAfterHeader
        ? Number.parseInt(retryAfterHeader, 10)
        : undefined;
      return mapHttpError(
        res.status,
        body,
        Number.isFinite(retryAfter) ? retryAfter : undefined,
      );
    }

    let body: OpenAiImageResponse;
    try {
      body = (await res.json()) as OpenAiImageResponse;
    } catch (err) {
      return Object.freeze({
        ok: false as const,
        error: toImageToolError(err, "internal", BACKEND),
      });
    }
    return decodeResponse(body, size, model, n);
  }

  async function variations(
    args: OpenAiVariationsArgs,
  ): Promise<ImageToolOutcome<ProviderImageBatch>> {
    const apiKey = readApiKey();
    if (!apiKey) {
      return Object.freeze({
        ok: false as const,
        error: makeImageError(
          "invalid_input",
          `missing OpenAI API key (env var ${config.openai.apiKeyEnv} is unset)`,
          { backend: BACKEND },
        ),
      });
    }
    const model = args.model ?? "dall-e-2";
    const size = args.size ?? "1024x1024";
    const n = args.n ?? 1;

    const form = new FormData();
    form.append("model", model);
    form.append("n", String(n));
    form.append("size", size);
    form.append("response_format", "b64_json");
    form.append(
      "image",
      new Blob([new Uint8Array(args.imageBytes)], { type: "image/png" }),
      "image.png",
    );

    const sendOutcome = await postMultipart(ENDPOINT_VARIATIONS, form, apiKey);
    if (!sendOutcome.ok) return sendOutcome as ImageToolOutcome<ProviderImageBatch>;
    const res = sendOutcome.data;

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const retryAfterHeader = res.headers.get("retry-after");
      const retryAfter = retryAfterHeader
        ? Number.parseInt(retryAfterHeader, 10)
        : undefined;
      return mapHttpError(
        res.status,
        body,
        Number.isFinite(retryAfter) ? retryAfter : undefined,
      );
    }

    let body: OpenAiImageResponse;
    try {
      body = (await res.json()) as OpenAiImageResponse;
    } catch (err) {
      return Object.freeze({
        ok: false as const,
        error: toImageToolError(err, "internal", BACKEND),
      });
    }
    return decodeResponse(body, size, model, n);
  }

  return { generate, edit, variations };
}
