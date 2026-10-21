/**
 * Phase 72 — MiniMax image-01 client.
 *
 * Endpoint: `POST https://api.minimax.chat/v1/image_generation`
 * Auth:     `Authorization: Bearer <MINIMAX_API_KEY>` header
 *
 * Response shape (typical):
 *   { data: { image_urls: string[] } }
 *
 * MiniMax is generate-only. Edit + variations always return
 * `unsupported_operation` with a helpful message naming the backends
 * that DO support each op (per 72-CONTEXT D-02).
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

const BACKEND: ImageBackend = "minimax";
const ENDPOINT = "https://api.minimax.chat/v1/image_generation";

export interface MiniMaxGenerateArgs {
  readonly prompt: string;
  readonly size?: string;
  readonly n?: number;
  readonly model?: string;
}

export interface MiniMaxImageClient {
  generate(args: MiniMaxGenerateArgs): Promise<ImageToolOutcome<ProviderImageBatch>>;
  edit(args: { imageBytes: Buffer; prompt: string }): Promise<ImageToolOutcome<ProviderImageBatch>>;
  variations(args: { imageBytes: Buffer; n?: number }): Promise<ImageToolOutcome<ProviderImageBatch>>;
}

interface MiniMaxResponse {
  data?: { image_urls?: string[] };
  base_resp?: { status_code?: number; status_msg?: string };
}

/** Convert a `WxH` size string into MiniMax's `aspect_ratio` token. */
function deriveAspect(size: string): string {
  const [w, h] = size.split("x").map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return "1:1";
  }
  if (w === h) return "1:1";
  if (w > h) {
    const ratio = w / h;
    if (Math.abs(ratio - 16 / 9) < 0.1) return "16:9";
    if (Math.abs(ratio - 4 / 3) < 0.1) return "4:3";
    if (Math.abs(ratio - 3 / 2) < 0.1) return "3:2";
    return "16:9";
  }
  // h > w
  const ratio = h / w;
  if (Math.abs(ratio - 16 / 9) < 0.1) return "9:16";
  if (Math.abs(ratio - 4 / 3) < 0.1) return "3:4";
  if (Math.abs(ratio - 3 / 2) < 0.1) return "2:3";
  return "9:16";
}

/** Map a non-2xx response into our error taxonomy. */
function mapHttpError(
  status: number,
  body: string,
): ImageToolOutcome<ProviderImageBatch> {
  if (status === 429) {
    return Object.freeze({
      ok: false as const,
      error: makeImageError("rate_limit", "MiniMax rate limit exceeded", {
        backend: BACKEND,
        status,
      }),
    });
  }
  if (status >= 400 && status < 500) {
    const lower = body.toLowerCase();
    if (
      lower.includes("safety") ||
      lower.includes("policy") ||
      lower.includes("forbidden content")
    ) {
      return Object.freeze({
        ok: false as const,
        error: makeImageError(
          "content_policy",
          "MiniMax safety filter rejected the prompt",
          { backend: BACKEND, status },
        ),
      });
    }
    return Object.freeze({
      ok: false as const,
      error: makeImageError("invalid_input", `MiniMax API HTTP ${status}: ${body.slice(0, 200)}`, {
        backend: BACKEND,
        status,
      }),
    });
  }
  return Object.freeze({
    ok: false as const,
    error: makeImageError("backend_unavailable", `MiniMax API HTTP ${status}`, {
      backend: BACKEND,
      status,
    }),
  });
}

export function createMiniMaxImageClient(
  config: ImageConfig,
  env: NodeJS.ProcessEnv = process.env,
): MiniMaxImageClient {
  function readApiKey(): string | undefined {
    const key = env[config.minimax.apiKeyEnv];
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
        headers: { Authorization: `Bearer ${apiKey}` },
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
          `MiniMax image fetch HTTP ${res.status}`,
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
          `MiniMax image exceeded maxImageBytes (${buf.byteLength} > ${config.maxImageBytes})`,
          { backend: BACKEND },
        ),
      });
    }
    return Object.freeze({ ok: true as const, data: Buffer.from(buf) });
  }

  async function generate(
    args: MiniMaxGenerateArgs,
  ): Promise<ImageToolOutcome<ProviderImageBatch>> {
    const apiKey = readApiKey();
    if (!apiKey) {
      return Object.freeze({
        ok: false as const,
        error: makeImageError(
          "invalid_input",
          `missing MiniMax API key (env var ${config.minimax.apiKeyEnv} is unset)`,
          { backend: BACKEND },
        ),
      });
    }
    const model = args.model ?? config.minimax.model;
    const size = args.size ?? "1024x1024";
    const n = args.n ?? 1;

    const reqBody = {
      model,
      prompt: args.prompt,
      n,
      aspect_ratio: deriveAspect(size),
      response_format: "url" as const,
    };

    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
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
      return mapHttpError(res.status, body);
    }

    let body: MiniMaxResponse;
    try {
      body = (await res.json()) as MiniMaxResponse;
    } catch (err) {
      return Object.freeze({
        ok: false as const,
        error: toImageToolError(err, "internal", BACKEND),
      });
    }

    // MiniMax can return non-2xx semantics inside a 200 envelope via
    // base_resp.status_code (their gateway pattern). Map to taxonomy.
    if (body.base_resp && body.base_resp.status_code && body.base_resp.status_code !== 0) {
      return Object.freeze({
        ok: false as const,
        error: makeImageError(
          "invalid_input",
          `MiniMax error ${body.base_resp.status_code}: ${body.base_resp.status_msg ?? "unknown"}`,
          { backend: BACKEND },
        ),
      });
    }

    const urls = body.data?.image_urls ?? [];
    if (urls.length === 0) {
      return Object.freeze({
        ok: false as const,
        error: makeImageError("internal", "MiniMax returned empty image_urls list", {
          backend: BACKEND,
        }),
      });
    }

    const decoded: ProviderImage[] = [];
    for (const url of urls) {
      const fetched = await fetchBytes(url, apiKey);
      if (!fetched.ok) return fetched as ImageToolOutcome<ProviderImageBatch>;
      decoded.push(Object.freeze({ bytes: fetched.data, size, model, url }));
    }

    return Object.freeze({
      ok: true as const,
      data: Object.freeze({
        images: Object.freeze(decoded),
        cost_cents: estimateImageCost(BACKEND, model, size, n),
      }),
    });
  }

  // edit + variations always return unsupported_operation (frozen).
  async function edit(): Promise<ImageToolOutcome<ProviderImageBatch>> {
    return Object.freeze({
      ok: false as const,
      error: makeImageError(
        "unsupported_operation",
        "MiniMax does not support image_edit. Backends with edit support: openai, fal.",
        { backend: BACKEND },
      ),
    });
  }

  async function variations(): Promise<ImageToolOutcome<ProviderImageBatch>> {
    return Object.freeze({
      ok: false as const,
      error: makeImageError(
        "unsupported_operation",
        "MiniMax does not support image_variations. Backends with variations support: openai.",
        { backend: BACKEND },
      ),
    });
  }

  return { generate, edit, variations };
}
