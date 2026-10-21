/**
 * Phase 72 — fal.ai client (flux-pro / flux-schnell / flux/dev/image-to-image).
 *
 * Endpoints (synchronous queue-API wrapper):
 *   POST https://fal.run/<model>                               (generate)
 *   POST https://fal.run/fal-ai/flux/dev/image-to-image        (edit)
 *
 * Auth: `Authorization: Key <FAL_API_KEY>` header (note: "Key", not "Bearer").
 *
 * Response shape (typical):
 *   { images: [{ url, content_type, width, height }], seed, ... }
 *
 * fal.ai supports generate + edit (image-to-image). Variations always
 * returns `unsupported_operation` (per 72-CONTEXT D-02).
 *
 * Same lazy-env, never-throw, frozen-envelope discipline as OpenAI.
 */

import { Buffer } from "node:buffer";
import type {
  ImageBackend,
  ImageToolOutcome,
} from "../types.js";
import type { ImageConfig } from "../../config/schema.js";
import { makeImageError, toImageToolError } from "../errors.js";
import { estimateImageCost } from "../costs.js";
import type {
  ProviderImage,
  ProviderImageBatch,
} from "./openai.js";

const BACKEND: ImageBackend = "fal";
const FAL_BASE = "https://fal.run";
const FAL_EDIT_MODEL = "fal-ai/flux/dev/image-to-image";

export interface FalGenerateArgs {
  readonly prompt: string;
  readonly size?: string;
  readonly n?: number;
  readonly model?: string;
}

export interface FalEditArgs {
  readonly imageBytes: Buffer;
  readonly prompt: string;
  readonly model?: string;
  readonly size?: string;
}

export interface FalImageClient {
  generate(args: FalGenerateArgs): Promise<ImageToolOutcome<ProviderImageBatch>>;
  edit(args: FalEditArgs): Promise<ImageToolOutcome<ProviderImageBatch>>;
  variations(): Promise<ImageToolOutcome<ProviderImageBatch>>;
}

interface FalImageItem {
  url?: string;
  content_type?: string;
  width?: number;
  height?: number;
}

interface FalResponse {
  images?: FalImageItem[];
  detail?: string | { msg?: string };
}

/** Convert a `WxH` size string into fal.ai's `image_size` token. */
function deriveFalSize(size: string): string {
  const [w, h] = size.split("x").map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(w) || !Number.isFinite(h)) return "square_hd";
  if (w === h) {
    return w >= 1024 ? "square_hd" : "square";
  }
  if (w > h) {
    return w >= 1024 ? "landscape_16_9" : "landscape_4_3";
  }
  return h >= 1024 ? "portrait_16_9" : "portrait_4_3";
}

function mapHttpError(
  status: number,
  body: string,
): ImageToolOutcome<ProviderImageBatch> {
  if (status === 429) {
    return Object.freeze({
      ok: false as const,
      error: makeImageError("rate_limit", "fal.ai rate limit exceeded", {
        backend: BACKEND,
        status,
      }),
    });
  }
  if (status >= 400 && status < 500) {
    const lower = body.toLowerCase();
    if (lower.includes("nsfw") || lower.includes("safety")) {
      return Object.freeze({
        ok: false as const,
        error: makeImageError(
          "content_policy",
          "fal.ai safety filter rejected the prompt",
          { backend: BACKEND, status },
        ),
      });
    }
    return Object.freeze({
      ok: false as const,
      error: makeImageError("invalid_input", `fal.ai API HTTP ${status}: ${body.slice(0, 200)}`, {
        backend: BACKEND,
        status,
      }),
    });
  }
  return Object.freeze({
    ok: false as const,
    error: makeImageError("backend_unavailable", `fal.ai API HTTP ${status}`, {
      backend: BACKEND,
      status,
    }),
  });
}

export function createFalImageClient(
  config: ImageConfig,
  env: NodeJS.ProcessEnv = process.env,
): FalImageClient {
  function readApiKey(): string | undefined {
    const key = env[config.fal.apiKeyEnv];
    return key && key.length > 0 ? key : undefined;
  }

  async function fetchBytes(
    url: string,
    apiKey: string,
  ): Promise<ImageToolOutcome<Buffer>> {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Key ${apiKey}` },
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (err) {
      return Object.freeze({
        ok: false as const,
        error: toImageToolError(err, "network", BACKEND),
      });
    }
    if (!res.ok) {
      return Object.freeze({
        ok: false as const,
        error: makeImageError(
          "backend_unavailable",
          `fal.ai image fetch HTTP ${res.status}`,
          { backend: BACKEND, status: res.status },
        ),
      });
    }
    let buf: ArrayBuffer;
    try {
      buf = await res.arrayBuffer();
    } catch (err) {
      return Object.freeze({
        ok: false as const,
        error: toImageToolError(err, "internal", BACKEND),
      });
    }
    if (buf.byteLength > config.maxImageBytes) {
      return Object.freeze({
        ok: false as const,
        error: makeImageError(
          "size_limit",
          `fal.ai image exceeded maxImageBytes (${buf.byteLength} > ${config.maxImageBytes})`,
          { backend: BACKEND },
        ),
      });
    }
    return Object.freeze({ ok: true as const, data: Buffer.from(buf) });
  }

  async function callFal(
    model: string,
    body: Record<string, unknown>,
    apiKey: string,
  ): Promise<ImageToolOutcome<FalResponse>> {
    let res: Response;
    try {
      res = await fetch(`${FAL_BASE}/${model}`, {
        method: "POST",
        headers: {
          Authorization: `Key ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (err) {
      return Object.freeze({
        ok: false as const,
        error: toImageToolError(err, "network", BACKEND),
      });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const mapped = mapHttpError(res.status, text);
      return mapped as ImageToolOutcome<FalResponse>;
    }
    try {
      const json = (await res.json()) as FalResponse;
      return Object.freeze({ ok: true as const, data: json });
    } catch (err) {
      return Object.freeze({
        ok: false as const,
        error: toImageToolError(err, "internal", BACKEND),
      });
    }
  }

  async function generate(
    args: FalGenerateArgs,
  ): Promise<ImageToolOutcome<ProviderImageBatch>> {
    const apiKey = readApiKey();
    if (!apiKey) {
      return Object.freeze({
        ok: false as const,
        error: makeImageError(
          "invalid_input",
          `missing fal.ai API key (env var ${config.fal.apiKeyEnv} is unset)`,
          { backend: BACKEND },
        ),
      });
    }
    const model = args.model ?? config.fal.model;
    const size = args.size ?? "1024x1024";
    const n = args.n ?? 1;

    const body = {
      prompt: args.prompt,
      image_size: deriveFalSize(size),
      num_images: n,
    };

    const callOutcome = await callFal(model, body, apiKey);
    if (!callOutcome.ok) return callOutcome as ImageToolOutcome<ProviderImageBatch>;
    const json = callOutcome.data;

    const items = json.images ?? [];
    if (items.length === 0) {
      return Object.freeze({
        ok: false as const,
        error: makeImageError("internal", "fal.ai returned empty images list", {
          backend: BACKEND,
        }),
      });
    }

    const decoded: ProviderImage[] = [];
    for (const item of items) {
      if (!item.url) {
        return Object.freeze({
          ok: false as const,
          error: makeImageError("internal", "fal.ai image missing url", {
            backend: BACKEND,
          }),
        });
      }
      const fetched = await fetchBytes(item.url, apiKey);
      if (!fetched.ok) return fetched as ImageToolOutcome<ProviderImageBatch>;
      decoded.push(Object.freeze({ bytes: fetched.data, size, model, url: item.url }));
    }

    return Object.freeze({
      ok: true as const,
      data: Object.freeze({
        images: Object.freeze(decoded),
        cost_cents: estimateImageCost(BACKEND, model, size, n),
      }),
    });
  }

  async function edit(
    args: FalEditArgs,
  ): Promise<ImageToolOutcome<ProviderImageBatch>> {
    const apiKey = readApiKey();
    if (!apiKey) {
      return Object.freeze({
        ok: false as const,
        error: makeImageError(
          "invalid_input",
          `missing fal.ai API key (env var ${config.fal.apiKeyEnv} is unset)`,
          { backend: BACKEND },
        ),
      });
    }
    const model = args.model ?? FAL_EDIT_MODEL;
    const size = args.size ?? "1024x1024";

    // fal.ai accepts data URIs for image_url. Build one from imageBytes.
    const dataUri = `data:image/png;base64,${args.imageBytes.toString("base64")}`;
    const body = {
      prompt: args.prompt,
      image_url: dataUri,
      strength: 0.85,
      num_images: 1,
      image_size: deriveFalSize(size),
    };

    const callOutcome = await callFal(model, body, apiKey);
    if (!callOutcome.ok) return callOutcome as ImageToolOutcome<ProviderImageBatch>;
    const json = callOutcome.data;

    const items = json.images ?? [];
    if (items.length === 0) {
      return Object.freeze({
        ok: false as const,
        error: makeImageError("internal", "fal.ai edit returned empty images list", {
          backend: BACKEND,
        }),
      });
    }

    const decoded: ProviderImage[] = [];
    for (const item of items) {
      if (!item.url) {
        return Object.freeze({
          ok: false as const,
          error: makeImageError("internal", "fal.ai edit image missing url", {
            backend: BACKEND,
          }),
        });
      }
      const fetched = await fetchBytes(item.url, apiKey);
      if (!fetched.ok) return fetched as ImageToolOutcome<ProviderImageBatch>;
      decoded.push(Object.freeze({ bytes: fetched.data, size, model, url: item.url }));
    }

    return Object.freeze({
      ok: true as const,
      data: Object.freeze({
        images: Object.freeze(decoded),
        cost_cents: estimateImageCost(BACKEND, model, size, 1),
      }),
    });
  }

  async function variations(): Promise<ImageToolOutcome<ProviderImageBatch>> {
    return Object.freeze({
      ok: false as const,
      error: makeImageError(
        "unsupported_operation",
        "fal.ai does not support image_variations. Backends with variations support: openai.",
        { backend: BACKEND },
      ),
    });
  }

  return { generate, edit, variations };
}
