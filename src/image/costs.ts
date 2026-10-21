/**
 * Phase 72 — image cost estimation + UsageTracker bridge.
 *
 * `estimateImageCost(backend, model, size, n)` is best-effort lookup
 * against published rate cards. Defensive default: unknown
 * backend/model/size combos return 0 cents — never crash the tool path.
 *
 * `recordImageUsage(tracker, event)` wraps `tracker.record({ ... })`
 * with `category: 'image'`, `cost_usd = cost_cents / 100`, and
 * `model = '${backend}:${model}'` so the existing
 * `getCostsByAgentModel` grouping splits image rows by backend+model
 * distinct from token rows in the costs CLI/dashboard.
 *
 * Pricing references (verified 2026-04-19, rates as cents-per-image):
 *  - OpenAI gpt-image-1 (standard): https://openai.com/api/pricing/
 *  - OpenAI dall-e-3 standard:      https://openai.com/api/pricing/
 *  - OpenAI dall-e-2:               https://openai.com/api/pricing/
 *  - MiniMax image-01:              https://www.minimax.chat/document/pricing
 *  - fal.ai flux-pro:               https://fal.ai/models/fal-ai/flux-pro/pricing
 *  - fal.ai flux-schnell:           https://fal.ai/models/fal-ai/flux/schnell/pricing
 */

import type { UsageTracker } from "../usage/tracker.js";
import type { ImageBackend, ImageUsageEvent } from "./types.js";

/**
 * Cents-per-image lookup table indexed by `[backend][model][size]`.
 * `"*"` is a wildcard size key — matched when no exact-size entry exists
 * (used by MiniMax + fal.ai flat-rate models).
 *
 * Frozen at every level — agents can't mutate pricing at runtime.
 */
export const IMAGE_PRICING: Readonly<
  Record<string, Readonly<Record<string, Readonly<Record<string, number>>>>>
> = Object.freeze({
  openai: Object.freeze({
    "gpt-image-1": Object.freeze({
      "256x256": 1,
      "512x512": 2,
      "1024x1024": 4,
      "1024x1792": 8,
      "1792x1024": 8,
    }),
    "dall-e-3": Object.freeze({
      "1024x1024": 4,
      "1024x1792": 8,
      "1792x1024": 8,
    }),
    "dall-e-2": Object.freeze({
      "256x256": 1,
      "512x512": 1,
      "1024x1024": 2,
    }),
  }),
  minimax: Object.freeze({
    "image-01": Object.freeze({
      "*": 1,
    }),
  }),
  fal: Object.freeze({
    "fal-ai/flux-pro": Object.freeze({
      "*": 5,
    }),
    "fal-ai/flux-schnell": Object.freeze({
      "*": 1,
    }),
    "fal-ai/flux/dev/image-to-image": Object.freeze({
      "*": 3,
    }),
  }),
});

/**
 * Best-effort cost estimate in cents. Unknown combos return 0 — image
 * generation must never fail because we couldn't price it.
 */
export function estimateImageCost(
  backend: ImageBackend,
  model: string,
  size: string,
  n: number,
): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  const backendPrices = IMAGE_PRICING[backend];
  if (!backendPrices) return 0;
  const modelPrices = backendPrices[model];
  if (!modelPrices) return 0;
  const perImage =
    modelPrices[size] !== undefined ? modelPrices[size] : modelPrices["*"];
  if (perImage === undefined) return 0;
  return perImage * n;
}

/**
 * Record an image usage event into the existing UsageTracker. Writes a
 * row with `category='image'` and zero token counts so token-cost
 * dashboards aren't polluted.
 *
 * Compose the model column as `${backend}:${model}` so the existing
 * `getCostsByAgentModel` grouping keeps image rows distinct from token
 * rows for the same agent.
 */
export function recordImageUsage(
  tracker: UsageTracker,
  event: ImageUsageEvent,
): void {
  tracker.record({
    agent: event.agent,
    timestamp: event.timestamp,
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: event.cost_cents / 100,
    turns: 0,
    model: `${event.backend}:${event.model}`,
    duration_ms: 0,
    session_id: event.session_id,
    category: "image",
    backend: event.backend,
    count: event.count,
  });
}
