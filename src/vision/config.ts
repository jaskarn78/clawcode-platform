/**
 * Phase 999.154 — `defaults.imageIngest` resolution + service construction.
 */

import type { Logger } from "pino";
import { createBridgeHaikuProvider } from "./providers/bridge-haiku.js";
import { createOcrOnlyProvider } from "./providers/ocr-only.js";
import { VisionService } from "./service.js";
import type { VisionProvider, VisionProviderId } from "./types.js";

export type ResolvedImageIngestConfig = {
  readonly provider: ReadonlyArray<VisionProviderId>;
  readonly batchSize: number;
  readonly canaryIntervalMin: number;
  readonly dedupe: { readonly exact: boolean; readonly nearDupHamming: number };
  readonly archive: {
    readonly enabled: boolean;
    readonly sidePx: number;
    readonly ttlDays: number;
  };
};

export const IMAGE_INGEST_DEFAULTS: ResolvedImageIngestConfig = Object.freeze({
  provider: Object.freeze(["bridge-haiku", "ocr-only"] as const),
  batchSize: 10,
  canaryIntervalMin: 60,
  dedupe: Object.freeze({ exact: true, nearDupHamming: 6 }),
  archive: Object.freeze({ enabled: true, sidePx: 1568, ttlDays: 90 }),
});

type PartialImageIngest = {
  readonly provider?: ReadonlyArray<VisionProviderId>;
  readonly batchSize?: number;
  readonly canaryIntervalMin?: number;
  readonly dedupe?: { readonly exact?: boolean; readonly nearDupHamming?: number };
  readonly archive?: {
    readonly enabled?: boolean;
    readonly sidePx?: number;
    readonly ttlDays?: number;
  };
};

export function resolveImageIngestConfig(
  raw: PartialImageIngest | undefined,
): ResolvedImageIngestConfig {
  const d = IMAGE_INGEST_DEFAULTS;
  const chain = raw?.provider && raw.provider.length > 0 ? raw.provider : d.provider;
  // The terminal fallback is always present so the chain can never be empty.
  const provider = chain.includes("ocr-only") ? chain : [...chain, "ocr-only" as const];
  return {
    provider,
    batchSize: raw?.batchSize ?? d.batchSize,
    canaryIntervalMin: raw?.canaryIntervalMin ?? d.canaryIntervalMin,
    dedupe: {
      exact: raw?.dedupe?.exact ?? d.dedupe.exact,
      nearDupHamming: raw?.dedupe?.nearDupHamming ?? d.dedupe.nearDupHamming,
    },
    archive: {
      enabled: raw?.archive?.enabled ?? d.archive.enabled,
      sidePx: raw?.archive?.sidePx ?? d.archive.sidePx,
      ttlDays: raw?.archive?.ttlDays ?? d.archive.ttlDays,
    },
  };
}

function buildProvider(
  id: VisionProviderId,
  batchSize: number,
  site: "ingest-vision" | "vision-canary",
): VisionProvider {
  switch (id) {
    case "bridge-haiku":
      return createBridgeHaikuProvider({ maxBatch: batchSize, site });
    case "ocr-only":
      return createOcrOnlyProvider();
  }
}

export function buildVisionService(
  cfg: ResolvedImageIngestConfig,
  log: Logger,
): VisionService {
  return new VisionService({
    providers: cfg.provider.map((id) => buildProvider(id, cfg.batchSize, "ingest-vision")),
    canaryProviders: cfg.provider.map((id) => buildProvider(id, 1, "vision-canary")),
    log,
  });
}
