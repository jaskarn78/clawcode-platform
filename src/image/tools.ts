/**
 * Phase 72 — pure tool handlers for `image_generate`, `image_edit`,
 * and `image_variations`.
 *
 * Pattern (mirrors Phase 71's `src/search/tools.ts`):
 *  - Pure functions with explicit dependency injection. Every I/O
 *    boundary (provider clients, workspace writer, cost recorder,
 *    file-read) is a seam the test suite substitutes with `vi.fn()`.
 *    No module-level singletons.
 *  - Never throw. All failure paths return
 *    `{ ok: false, error: ImageError }`. Callers branch on `ok`.
 *  - Every returned envelope is `Object.freeze`d (CLAUDE.md immutability).
 *
 * Plan 02 will wire these handlers into an MCP stdio subprocess + the
 * daemon auto-inject path. This plan ships the handlers in isolation
 * so the behavioural contract is pinned before transport gets built.
 */

import { Buffer } from "node:buffer";
import { readFile as fsReadFile } from "node:fs/promises";
import { z } from "zod/v4";
import type { ImageConfig } from "../config/schema.js";
import { makeImageError, toImageToolError } from "./errors.js";
import type {
  GeneratedImage,
  ImageBackend,
  ImageEditResult,
  ImageError,
  ImageGenerateResult,
  ImageToolOutcome,
  ImageUsageEvent,
  ImageVariationsResult,
} from "./types.js";
import type { ProviderImage, ProviderImageBatch } from "./providers/openai.js";

/** Allowed image sizes per CONTEXT (matches OpenAI Images supported sizes). */
const ALLOWED_SIZES = [
  "256x256",
  "512x512",
  "1024x1024",
  "1024x1792",
  "1792x1024",
] as const;
type AllowedSize = (typeof ALLOWED_SIZES)[number];

const MAX_N = 4;

/**
 * Minimal provider shape — all three concrete clients
 * (openai/minimax/fal) satisfy this. `edit` and `variations` may
 * always return `unsupported_operation` when the backend doesn't
 * support that op (per provider impl).
 */
export interface ImageProvider {
  generate(args: {
    prompt: string;
    size?: string;
    n?: number;
    model?: string;
    style?: string;
  }): Promise<ImageToolOutcome<ProviderImageBatch>>;
  edit(args: {
    imageBytes: Buffer;
    prompt: string;
    maskBytes?: Buffer;
    model?: string;
    size?: string;
    n?: number;
  }): Promise<ImageToolOutcome<ProviderImageBatch>>;
  variations(args: {
    imageBytes: Buffer;
    n?: number;
    model?: string;
    size?: string;
  }): Promise<ImageToolOutcome<ProviderImageBatch>>;
}

/**
 * Workspace-writer dep shape. Matches `writeImageToWorkspace` from
 * `src/image/workspace.ts`. Tests can substitute a `vi.fn()` that
 * returns a fake path without touching disk.
 */
export type WriteImageFn = (
  workspace: string,
  subdir: string,
  bytes: Buffer,
  ext: string,
) => Promise<string>;

/**
 * Cost-recording dep shape. Matches `recordImageUsage` from
 * `src/image/costs.ts`. Failure to record MUST NOT fail the tool —
 * handlers wrap the call in try/catch.
 */
export type RecordCostFn = (event: ImageUsageEvent) => void;

/** File-read dep shape — same signature as `node:fs/promises.readFile`. */
export type ReadFileFn = (path: string) => Promise<Buffer>;

/**
 * Injected dependencies for the image tool handlers.
 *
 * `readFile` defaults to `node:fs/promises.readFile` — tests can swap
 * in a vi.fn() to avoid real disk reads. All other deps are required
 * so handlers can never accidentally hit real backends or disk.
 */
export interface ImageToolDeps {
  readonly config: ImageConfig;
  readonly providers: Readonly<Record<ImageBackend, ImageProvider>>;
  readonly writeImage: WriteImageFn;
  readonly recordCost: RecordCostFn;
  readonly agentWorkspace: string;
  readonly agent: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly readFile?: ReadFileFn;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function fail<T>(error: ImageError): ImageToolOutcome<T> {
  return Object.freeze({ ok: false as const, error });
}

function success<T>(data: T): ImageToolOutcome<T> {
  return Object.freeze({ ok: true as const, data });
}

function isAllowedSize(size: string): size is AllowedSize {
  return (ALLOWED_SIZES as readonly string[]).includes(size);
}

function isAllowedBackend(backend: string): backend is ImageBackend {
  return backend === "openai" || backend === "minimax" || backend === "fal";
}

function isPositiveIntInRange(n: unknown, max: number): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= max;
}

/**
 * Convert provider-returned image bytes into workspace-persisted
 * GeneratedImage records. Invokes `deps.writeImage` for each image,
 * computing per-image cost as `cost_cents / images.length`.
 *
 * Returns a `fail<T>` outcome on writeImage failure (mapped to
 * `internal`); never throws.
 */
async function persistImages<T>(
  images: ReadonlyArray<ProviderImage>,
  totalCostCents: number,
  prompt: string,
  backend: ImageBackend,
  deps: ImageToolDeps,
): Promise<ImageToolOutcome<{ persisted: GeneratedImage[]; total_cost_cents: number }>> {
  const perImageCost =
    images.length > 0 ? Math.round((totalCostCents / images.length) * 100) / 100 : 0;
  const persisted: GeneratedImage[] = [];
  for (const img of images) {
    let path: string;
    try {
      path = await deps.writeImage(
        deps.agentWorkspace,
        deps.config.workspaceSubdir,
        img.bytes,
        "png",
      );
    } catch (err) {
      return fail(toImageToolError(err, "internal", backend));
    }
    const generated: GeneratedImage = img.url
      ? Object.freeze({
          path,
          url: img.url,
          size: img.size,
          backend,
          model: img.model,
          prompt,
          cost_cents: perImageCost,
        })
      : Object.freeze({
          path,
          size: img.size,
          backend,
          model: img.model,
          prompt,
          cost_cents: perImageCost,
        });
    persisted.push(generated);
  }
  return success({ persisted, total_cost_cents: totalCostCents });
}

/**
 * Wrap `recordCost` in try/catch — a failed cost record must NOT fail
 * the tool. Surface non-fatal failures via console.warn (Plan 02
 * adds proper logger wiring).
 */
function safeRecordCost(deps: ImageToolDeps, event: ImageUsageEvent): void {
  try {
    deps.recordCost(event);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[image] cost recording failed:", err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// image_generate
// ---------------------------------------------------------------------------

export async function imageGenerate(
  args: {
    prompt: string;
    size?: string;
    style?: string;
    backend?: string;
    model?: string;
    n?: number;
  },
  deps: ImageToolDeps,
): Promise<ImageToolOutcome<ImageGenerateResult>> {
  // Validate prompt.
  if (!args.prompt || typeof args.prompt !== "string" || args.prompt.length === 0) {
    return fail(makeImageError("invalid_input", "prompt must be a non-empty string"));
  }
  // Validate n (default 1, range 1..4).
  const n = args.n ?? 1;
  if (!isPositiveIntInRange(n, MAX_N)) {
    return fail(
      makeImageError("invalid_input", `n must be an integer in [1, ${MAX_N}]`),
    );
  }
  // Resolve backend (arg > config), validate against union.
  const backendRaw = args.backend ?? deps.config.backend;
  if (typeof backendRaw !== "string" || !isAllowedBackend(backendRaw)) {
    return fail(
      makeImageError("invalid_input", `unknown backend: ${String(args.backend)}`),
    );
  }
  const backend: ImageBackend = backendRaw;
  // Resolve size (default 1024x1024), validate against allowed list.
  const size = args.size ?? "1024x1024";
  if (!isAllowedSize(size)) {
    return fail(
      makeImageError(
        "invalid_input",
        `unsupported size: ${size}. Allowed: ${ALLOWED_SIZES.join(", ")}`,
      ),
    );
  }
  // Resolve model (default = config[backend].model).
  const model = args.model ?? deps.config[backend].model;

  // Look up provider.
  const provider = deps.providers[backend];
  if (!provider) {
    return fail(
      makeImageError("invalid_input", `provider not configured for backend: ${backend}`),
    );
  }

  // Call provider — defence-in-depth try/catch (providers contract NEVER
  // to throw, but a test-substituted vi.fn() might).
  let providerOutcome: ImageToolOutcome<ProviderImageBatch>;
  try {
    providerOutcome = await provider.generate({
      prompt: args.prompt,
      size,
      n,
      model,
      style: args.style,
    });
  } catch (err) {
    return fail(toImageToolError(err, "internal", backend));
  }
  if (!providerOutcome.ok) {
    // Pass error through verbatim (already has backend field).
    return fail(providerOutcome.error);
  }

  // Persist to workspace.
  const persistOutcome = await persistImages(
    providerOutcome.data.images,
    providerOutcome.data.cost_cents,
    args.prompt,
    backend,
    deps,
  );
  if (!persistOutcome.ok) return persistOutcome as ImageToolOutcome<ImageGenerateResult>;

  // Record cost (failure must NOT fail the tool).
  safeRecordCost(deps, {
    agent: deps.agent,
    backend,
    model,
    count: persistOutcome.data.persisted.length,
    cost_cents: persistOutcome.data.total_cost_cents,
    size,
    timestamp: new Date().toISOString(),
    session_id: deps.sessionId,
    turn_id: deps.turnId,
  });

  return success({
    images: Object.freeze(persistOutcome.data.persisted),
    total_cost_cents: persistOutcome.data.total_cost_cents,
  });
}

// ---------------------------------------------------------------------------
// image_edit
// ---------------------------------------------------------------------------

export async function imageEdit(
  args: {
    imagePath: string;
    prompt: string;
    backend?: string;
    maskPath?: string;
    model?: string;
    size?: string;
  },
  deps: ImageToolDeps,
): Promise<ImageToolOutcome<ImageEditResult>> {
  if (!args.imagePath || typeof args.imagePath !== "string" || args.imagePath.length === 0) {
    return fail(makeImageError("invalid_input", "imagePath must be a non-empty string"));
  }
  if (!args.prompt || typeof args.prompt !== "string" || args.prompt.length === 0) {
    return fail(makeImageError("invalid_input", "prompt must be a non-empty string"));
  }
  const backendRaw = args.backend ?? deps.config.backend;
  if (typeof backendRaw !== "string" || !isAllowedBackend(backendRaw)) {
    return fail(
      makeImageError("invalid_input", `unknown backend: ${String(args.backend)}`),
    );
  }
  const backend: ImageBackend = backendRaw;
  const size = args.size ?? "1024x1024";
  if (!isAllowedSize(size)) {
    return fail(
      makeImageError(
        "invalid_input",
        `unsupported size: ${size}. Allowed: ${ALLOWED_SIZES.join(", ")}`,
      ),
    );
  }
  const model = args.model ?? deps.config[backend].model;

  const readFile = deps.readFile ?? fsReadFile;

  let imageBytes: Buffer;
  try {
    imageBytes = await readFile(args.imagePath);
  } catch (err) {
    return fail(
      makeImageError(
        "invalid_input",
        `failed to read imagePath ${args.imagePath}: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }

  let maskBytes: Buffer | undefined;
  if (args.maskPath) {
    try {
      maskBytes = await readFile(args.maskPath);
    } catch (err) {
      return fail(
        makeImageError(
          "invalid_input",
          `failed to read maskPath ${args.maskPath}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }

  const provider = deps.providers[backend];
  if (!provider) {
    return fail(
      makeImageError("invalid_input", `provider not configured for backend: ${backend}`),
    );
  }

  let providerOutcome: ImageToolOutcome<ProviderImageBatch>;
  try {
    providerOutcome = await provider.edit({
      imageBytes,
      prompt: args.prompt,
      maskBytes,
      model,
      size,
    });
  } catch (err) {
    return fail(toImageToolError(err, "internal", backend));
  }
  if (!providerOutcome.ok) {
    // Pass through unsupported_operation, content_policy, etc. verbatim.
    return fail(providerOutcome.error);
  }

  const persistOutcome = await persistImages(
    providerOutcome.data.images,
    providerOutcome.data.cost_cents,
    args.prompt,
    backend,
    deps,
  );
  if (!persistOutcome.ok) return persistOutcome as ImageToolOutcome<ImageEditResult>;

  safeRecordCost(deps, {
    agent: deps.agent,
    backend,
    model,
    count: persistOutcome.data.persisted.length,
    cost_cents: persistOutcome.data.total_cost_cents,
    size,
    timestamp: new Date().toISOString(),
    session_id: deps.sessionId,
    turn_id: deps.turnId,
  });

  return success({
    images: Object.freeze(persistOutcome.data.persisted),
    total_cost_cents: persistOutcome.data.total_cost_cents,
  });
}

// ---------------------------------------------------------------------------
// image_variations
// ---------------------------------------------------------------------------

export async function imageVariations(
  args: {
    imagePath: string;
    n?: number;
    backend?: string;
    model?: string;
    size?: string;
  },
  deps: ImageToolDeps,
): Promise<ImageToolOutcome<ImageVariationsResult>> {
  if (!args.imagePath || typeof args.imagePath !== "string" || args.imagePath.length === 0) {
    return fail(makeImageError("invalid_input", "imagePath must be a non-empty string"));
  }
  const n = args.n ?? 1;
  if (!isPositiveIntInRange(n, MAX_N)) {
    return fail(
      makeImageError("invalid_input", `n must be an integer in [1, ${MAX_N}]`),
    );
  }
  const backendRaw = args.backend ?? deps.config.backend;
  if (typeof backendRaw !== "string" || !isAllowedBackend(backendRaw)) {
    return fail(
      makeImageError("invalid_input", `unknown backend: ${String(args.backend)}`),
    );
  }
  const backend: ImageBackend = backendRaw;
  const size = args.size ?? "1024x1024";
  if (!isAllowedSize(size)) {
    return fail(
      makeImageError(
        "invalid_input",
        `unsupported size: ${size}. Allowed: ${ALLOWED_SIZES.join(", ")}`,
      ),
    );
  }
  const model = args.model ?? deps.config[backend].model;

  const readFile = deps.readFile ?? fsReadFile;
  let imageBytes: Buffer;
  try {
    imageBytes = await readFile(args.imagePath);
  } catch (err) {
    return fail(
      makeImageError(
        "invalid_input",
        `failed to read imagePath ${args.imagePath}: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }

  const provider = deps.providers[backend];
  if (!provider) {
    return fail(
      makeImageError("invalid_input", `provider not configured for backend: ${backend}`),
    );
  }

  let providerOutcome: ImageToolOutcome<ProviderImageBatch>;
  try {
    providerOutcome = await provider.variations({
      imageBytes,
      n,
      model,
      size,
    });
  } catch (err) {
    return fail(toImageToolError(err, "internal", backend));
  }
  if (!providerOutcome.ok) {
    return fail(providerOutcome.error);
  }

  const persistOutcome = await persistImages(
    providerOutcome.data.images,
    providerOutcome.data.cost_cents,
    "(variation)",
    backend,
    deps,
  );
  if (!persistOutcome.ok) return persistOutcome as ImageToolOutcome<ImageVariationsResult>;

  safeRecordCost(deps, {
    agent: deps.agent,
    backend,
    model,
    count: persistOutcome.data.persisted.length,
    cost_cents: persistOutcome.data.total_cost_cents,
    size,
    timestamp: new Date().toISOString(),
    session_id: deps.sessionId,
    turn_id: deps.turnId,
  });

  return success({
    images: Object.freeze(persistOutcome.data.persisted),
    total_cost_cents: persistOutcome.data.total_cost_cents,
  });
}

// ---------------------------------------------------------------------------
// TOOL_DEFINITIONS — the MCP tool schemas Plan 02 will register.
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  readonly name: "image_generate" | "image_edit" | "image_variations";
  readonly description: string;
  readonly schemaBuilder: (z_: typeof z) => Record<string, unknown>;
}

export const TOOL_DEFINITIONS: ReadonlyArray<ToolDefinition> = Object.freeze([
  Object.freeze({
    name: "image_generate" as const,
    description:
      "Generate one or more images from a text prompt. Backends: openai (gpt-image-1 / dall-e-3 / dall-e-2), minimax (image-01), fal (fal-ai/flux-pro). Returns workspace file paths usable with send_attachment for Discord delivery. Cost recorded in `clawcode costs`.",
    schemaBuilder: (z_: typeof z) => ({
      prompt: z_.string().min(1).describe("Image prompt"),
      size: z_
        .enum(["256x256", "512x512", "1024x1024", "1024x1792", "1792x1024"])
        .optional(),
      style: z_.string().optional(),
      backend: z_.enum(["openai", "minimax", "fal"]).optional(),
      model: z_.string().optional(),
      n: z_.number().int().min(1).max(MAX_N).optional(),
    }),
  }),
  Object.freeze({
    name: "image_edit" as const,
    description:
      "Edit an existing image at the given workspace path with a text prompt. Backends with edit support: openai (DALL-E edit), fal (flux image-to-image). MiniMax does not support edit — use openai or fal.",
    schemaBuilder: (z_: typeof z) => ({
      imagePath: z_.string().min(1).describe("Absolute workspace path to source image"),
      prompt: z_.string().min(1).describe("Edit instruction"),
      backend: z_.enum(["openai", "minimax", "fal"]).optional(),
      maskPath: z_.string().min(1).optional(),
      model: z_.string().optional(),
      size: z_
        .enum(["256x256", "512x512", "1024x1024", "1024x1792", "1792x1024"])
        .optional(),
    }),
  }),
  Object.freeze({
    name: "image_variations" as const,
    description:
      "Generate variations of an existing image. Only OpenAI supports variations (DALL-E variations endpoint). MiniMax and fal both return unsupported_operation.",
    schemaBuilder: (z_: typeof z) => ({
      imagePath: z_.string().min(1).describe("Absolute workspace path to source image"),
      n: z_.number().int().min(1).max(MAX_N).optional(),
      backend: z_.enum(["openai", "minimax", "fal"]).optional(),
      model: z_.string().optional(),
      size: z_
        .enum(["256x256", "512x512", "1024x1024", "1024x1792", "1792x1024"])
        .optional(),
    }),
  }),
]);
