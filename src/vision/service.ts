/**
 * Phase 999.154 — VisionService: failover chain + health canary.
 *
 * `analyzeBatch` walks the configured provider chain, skipping unhealthy
 * providers (except the terminal `ocr-only`, which cannot fail). A transport
 * failure or an all-null result on a non-empty batch counts against the
 * provider's health and the next provider is tried. If nothing produces
 * analysis the caller gets all-null results — truthful "no vision", never an
 * exception and never fiction.
 */

import type { Logger } from "pino";
import { CANARY_IMAGE, CANARY_TOKEN } from "./canary.js";
import { VisionHealth, type HealthTransition } from "./health.js";
import type {
  ImageAnalysis,
  LabeledImage,
  VisionCallOptions,
  VisionProvider,
  VisionProviderId,
} from "./types.js";

const TAG = "phase999.154-vision";

export type VisionBatchResult = {
  readonly results: ReadonlyArray<ImageAnalysis | null>;
  /** Provider that produced `results`, or "none" when every provider failed. */
  readonly providerId: VisionProviderId | "none";
};

export type VisionServiceDeps = {
  readonly providers: ReadonlyArray<VisionProvider>;
  /** Provider instances used for canary runs (telemetry site); defaults to `providers`. */
  readonly canaryProviders?: ReadonlyArray<VisionProvider>;
  readonly log: Logger;
  readonly onHealthTransition?: (t: HealthTransition) => void;
};

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class VisionService {
  readonly health: VisionHealth;
  private canaryTimer: ReturnType<typeof setInterval> | null = null;
  private canaryFirst: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: VisionServiceDeps) {
    this.health = new VisionHealth((t) => {
      const level = t.healthy ? "info" : "error";
      deps.log[level](
        { tag: TAG, provider: t.provider, healthy: t.healthy, reason: t.reason },
        t.healthy
          ? "vision provider recovered"
          : "vision provider UNHEALTHY — failing over (images ingest OCR-only until it recovers)",
      );
      deps.onHealthTransition?.(t);
    });
  }

  get providerIds(): ReadonlyArray<VisionProviderId> {
    return this.deps.providers.map((p) => p.id);
  }

  async analyzeBatch(
    images: ReadonlyArray<LabeledImage>,
    opts: VisionCallOptions = {},
  ): Promise<VisionBatchResult> {
    if (images.length === 0) return { results: [], providerId: "none" };
    for (const provider of this.deps.providers) {
      if (provider.id !== "ocr-only" && !this.health.isHealthy(provider.id)) continue;
      try {
        const results = await provider.analyzeBatch(images, opts);
        if (provider.id === "ocr-only") return { results, providerId: provider.id };
        const analyzed = results.filter((r) => r !== null).length;
        if (analyzed === 0) {
          this.health.markFailure(provider.id, "no image in the batch produced a valid analysis");
          this.deps.log.warn(
            { tag: TAG, provider: provider.id, images: images.length },
            "vision batch produced no valid analyses — trying next provider",
          );
          continue;
        }
        this.health.markSuccess(provider.id);
        this.deps.log.info(
          { tag: TAG, provider: provider.id, images: images.length, analyzed },
          "vision batch complete",
        );
        return { results, providerId: provider.id };
      } catch (err) {
        if (opts.signal?.aborted) break;
        this.health.markFailure(provider.id, errMessage(err));
        this.deps.log.warn(
          { tag: TAG, provider: provider.id, err: errMessage(err) },
          "vision provider failed — trying next provider",
        );
      }
    }
    return { results: images.map(() => null), providerId: "none" };
  }

  /**
   * Run the fixture through every non-terminal provider, healthy or not (so an
   * unhealthy provider can recover). Returns provider → passed.
   */
  async runCanary(): Promise<ReadonlyMap<VisionProviderId, boolean>> {
    const outcome = new Map<VisionProviderId, boolean>();
    const providers = this.deps.canaryProviders ?? this.deps.providers;
    for (const provider of providers) {
      if (provider.id === "ocr-only") continue;
      let passed = false;
      let reason = "canary text not found in analysis";
      try {
        const [analysis] = await provider.analyzeBatch([CANARY_IMAGE]);
        const haystack = analysis
          ? [analysis.summary, ...analysis.text].join(" ")
          : "";
        passed = haystack.includes(CANARY_TOKEN);
        if (analysis === null) reason = "canary produced no valid analysis";
      } catch (err) {
        reason = errMessage(err);
      }
      if (passed) this.health.markSuccess(provider.id);
      else this.health.markFailure(provider.id, `canary: ${reason}`);
      this.deps.log[passed ? "info" : "warn"](
        { tag: TAG, provider: provider.id, passed, ...(passed ? {} : { reason }) },
        passed ? "vision canary passed" : "vision canary FAILED",
      );
      outcome.set(provider.id, passed);
    }
    return outcome;
  }

  /** Start the periodic canary (first run after `initialDelayMs`). Timers are unref'd. */
  startCanary(intervalMs: number, initialDelayMs = 60_000): void {
    this.stopCanary();
    if (intervalMs <= 0) return;
    const fire = (): void => {
      void this.runCanary().catch((err: unknown) => {
        this.deps.log.warn({ tag: TAG, err: errMessage(err) }, "vision canary run threw");
      });
    };
    this.canaryFirst = setTimeout(fire, initialDelayMs);
    (this.canaryFirst as { unref?: () => void }).unref?.();
    this.canaryTimer = setInterval(fire, intervalMs);
    (this.canaryTimer as { unref?: () => void }).unref?.();
  }

  stopCanary(): void {
    if (this.canaryFirst !== null) clearTimeout(this.canaryFirst);
    if (this.canaryTimer !== null) clearInterval(this.canaryTimer);
    this.canaryFirst = null;
    this.canaryTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Process singleton (configured once at daemon boot)
// ---------------------------------------------------------------------------

let current: VisionService | null = null;

export function configureVisionService(service: VisionService | null): void {
  current?.stopCanary();
  current = service;
}

/** The configured service, or null before boot / in tests that don't set one. */
export function getVisionService(): VisionService | null {
  return current;
}
