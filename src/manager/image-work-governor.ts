/**
 * Process-global image-work governor (Phase: robust auto-ingest, P1-GATE + P1-SHARP).
 *
 * THE canonical gate for ALL CPU-bound image decode work in the daemon. Both the
 * vision pre-pass (`runVisionPrePass` → `resizeImageForVision`) and the auto-ingest
 * drain (`handleAutoIngestAttachment` → `sharp().metadata()` + chart-pass resize)
 * acquire from the SAME two slots. Because the Discord bridge is constructed
 * in-process inside `startDaemon`, this module singleton is genuinely
 * process-global — all N agents + both fan-out paths + the ingest drain share
 * these 2 slots. A per-agent cap would still permit 2 × N_agents concurrent
 * libvips decodes on a 4-core box; only a daemon-global gate bounds the hardware.
 *
 * WHY 2 slots × concurrency(1): 2 active libvips threads daemon-wide leaves 2 of
 * 4 cores for the ~14 claude procs + event loop + 1 embed worker.
 *
 * LANDMINE (design #6): every acquire MUST be paired with a release in a
 * `finally`. With only 2 slots, two leaked slots deadlock the entire image path
 * for the whole daemon. Prefer `withImageWorkSlot()` — it makes the try/finally
 * impossible to forget.
 */

import sharp from "sharp";
import type { Logger } from "pino";

/** Daemon-global concurrent CPU-bound image-decode slots. */
export const MAX_IMAGE_WORK_SLOTS = 2;

/**
 * P1-PIXELGUARD — per-image decompression-bomb cap (~89 MP). Above this the
 * `sharp()` constructor throws synchronously → a clean per-image error instead
 * of a multi-hundred-MB bitmap OOM. Pass as `{ limitInputPixels: MAX_INPUT_PIXELS }`
 * to every `sharp()` constructor on a decode path (resize + metadata).
 */
export const MAX_INPUT_PIXELS = 89_478_485;

/**
 * A minimal fair counting semaphore. FIFO waiter queue: `acquire()` resolves
 * immediately while permits remain, otherwise queues and resolves when a later
 * `release()` hands it a permit. No timeout/cancellation — callers bound their
 * own work (sharp `.timeout()` frees a wedged decode so a slot is never held
 * indefinitely).
 *
 * There is intentionally no shared `Semaphore` reused here: the only other one
 * in the tree (`broker.ts` `AgentSemaphore`) is per-agent and not exported. This
 * one is hand-rolled and module-scoped so a single instance gates the whole box.
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    if (!Number.isInteger(permits) || permits < 1) {
      throw new Error(`Semaphore permits must be a positive integer, got ${permits}`);
    }
    this.available = permits;
  }

  /** Resolves when a slot is held by the caller. Always pair with `release()` in a `finally`. */
  acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** Returns a held slot. Hands it directly to the next waiter (FIFO) if any. */
  release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Permit passes straight to the waiter; available count stays the same.
      next();
      return;
    }
    this.available += 1;
  }

  /** Diagnostics only. */
  get availablePermits(): number {
    return this.available;
  }

  /** Diagnostics only. */
  get queueLength(): number {
    return this.waiters.length;
  }
}

/**
 * The one daemon-global image-work gate. Acquired by the vision pre-pass decode
 * AND the ingest drain decode. Scope each acquisition to the CPU-bound decode
 * ONLY — release BEFORE awaiting any network call (e.g. `callHaikuVision`) so the
 * gate governs compute, not I/O.
 */
export const imageWorkGovernor = new Semaphore(MAX_IMAGE_WORK_SLOTS);

/**
 * Phase 999.154 — for a caller that ALREADY holds a slot (the auto-ingest
 * drain holds one around the whole handler): give it back for the duration of
 * a network wait, then re-acquire before returning, so the gate governs
 * compute, not I/O. Never call without holding a slot.
 */
export async function withImageWorkSlotReleased<T>(fn: () => Promise<T>): Promise<T> {
  imageWorkGovernor.release();
  try {
    return await fn();
  } finally {
    await imageWorkGovernor.acquire();
  }
}

/**
 * Run `fn` while holding one image-work slot, releasing it on EVERY exit path
 * (success, throw, or rejection). This is the safe way to honour landmine #6 —
 * prefer it over manual `acquire()`/`release()`.
 *
 * Scope `fn` to the CPU-bound decode only. Do NOT await network calls inside it.
 */
export async function withImageWorkSlot<T>(fn: () => Promise<T>): Promise<T> {
  await imageWorkGovernor.acquire();
  try {
    return await fn();
  } finally {
    imageWorkGovernor.release();
  }
}

let sharpConfigured = false;

/**
 * Apply the daemon-wide libvips global config. Idempotent — safe to call once at
 * boot from `startDaemon` BEFORE the first agent spawn / first decode.
 *
 * - `concurrency(1)`: one libvips worker thread per operation. Combined with the
 *   2-slot gate that caps active libvips threads daemon-wide at 2.
 * - `cache(false)`: stop libvips retaining decoded tiles between operations
 *   (unbounded RSS growth otherwise on a memory-constrained box).
 */
export function configureSharpAtBoot(log?: Logger): void {
  sharp.concurrency(1);
  sharp.cache(false);
  sharpConfigured = true;
  log?.info(
    { sharpConcurrency: sharp.concurrency(), maxImageWorkSlots: MAX_IMAGE_WORK_SLOTS },
    "sharp_configured_at_boot",
  );
}

/** Diagnostics only — whether `configureSharpAtBoot()` has run. */
export function isSharpConfigured(): boolean {
  return sharpConfigured;
}
