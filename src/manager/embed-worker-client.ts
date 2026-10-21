/**
 * Main-thread client for the dedicated embed worker (P1-EMBED-WORKER).
 *
 * Owns the single worker's lifecycle and the failure policy the worker itself
 * deliberately does NOT decide (see embed-worker.ts):
 *
 *  - BOOT fail-open (landmine #5): if the worker file is missing on disk, fails
 *    to spawn, or never produces a first success (e.g. ONNX load failure on the
 *    first request), the client degrades to inline-on-main embedding + a loud
 *    alert. A thrown worker-init at boot must NEVER propagate (it would
 *    crash-loop the whole daemon — strictly worse than the incident). Inline
 *    fallback reuses the daemon's existing EmbeddingService singleton, so it
 *    adds NO extra resident model copy.
 *  - RUNTIME crash (landmine #5): if the worker had already succeeded and then
 *    crashes / times out, in-flight work is rejected (retryable) and the worker
 *    is respawned. There is NO inline fallback at runtime under memory pressure
 *    — that would amplify the OOM incident. The ingest queue / rescan retry.
 *  - TIMEOUT (load-bearing): the ingest drain holds a governor permit across the
 *    embed round-trip, so a hung worker with no timeout would leak that permit.
 *    Every request has a hard timeout that rejects + recycles the worker.
 *
 * The "missing on disk" reason is reported distinctly so a build/ship miss
 * (tsup second-entry or deploy rsync line dropped) is a screaming boot log, not
 * a silent 2×-model RSS regression. The daemon's boot assertion reads getMode()
 * right after construction: 'inline' there == the file was missing.
 */

import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Logger } from "pino";
import type { EmbeddingService } from "../memory/embedder.js";
import type {
  EmbedWorkerRequest,
  EmbedWorkerResponse,
} from "./embed-worker.js";

/** Embeddings for one batch of chunk texts, index-aligned with the input. */
export type EmbeddedVersions = {
  /** MiniLM float32 (V1) — null when not requested (no cross-ingest). */
  readonly v1: Float32Array[] | null;
  /** bge-small int8 (V2) — always present; serves docStore.ingest + crossIngest. */
  readonly v2: Int8Array[];
};

/** Minimal worker surface — narrowed so tests can inject a fake. */
export interface WorkerLike {
  postMessage(value: unknown, transferList?: readonly unknown[]): void;
  on(event: "message", cb: (value: EmbedWorkerResponse) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  on(event: "exit", cb: (code: number) => void): void;
  terminate(): unknown;
}

export type EmbedWorkerClientOptions = {
  readonly log: Logger;
  /** Inline-fallback embedder. Daemon passes its existing singleton (no extra copy). */
  readonly getInlineEmbedder: () => EmbeddingService;
  /** Per-request timeout (ms). Bounds how long the drain's governor permit is held. */
  readonly timeoutMs?: number;
  /** Override worker path (tests). Default: resolved dist/cli/embed-worker.js. */
  readonly workerPath?: string;
  /** Override worker factory (tests inject a fake; default: new Worker). */
  readonly createWorker?: (workerPath: string) => WorkerLike;
  /** Optional alert hook fired on fail-open (e.g. Discord admin channel). */
  readonly alert?: (reason: string, info?: unknown) => void;
};

const TAG = "p1-embed-worker";
const DEFAULT_TIMEOUT_MS = 60_000;

/** Retryable embed fault — surfaced to the ingest drain so the queue/rescan retries. */
export class EmbedWorkerError extends Error {
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = "EmbedWorkerError";
  }
}

type Pending = {
  resolve: (v: EmbeddedVersions) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Build-aware resolution of dist/cli/embed-worker.js (sibling of the bundled
 * dist/cli/index.js). Mirrors defaultChannelMcpServerPath: anchor at the
 * src|dist boundary, fall back to the bundle sibling, then process.cwd(); all
 * wrapped so an unavailable import.meta.url (odd vitest configs) cannot throw.
 */
export function resolveEmbedWorkerPath(): string {
  const FILE = "embed-worker.js";
  const candidates: string[] = [];
  try {
    const here = fileURLToPath(import.meta.url);
    const m = here.match(/^(.*?)[\\/](?:src|dist)[\\/]/);
    if (m && m[1]) candidates.push(path.join(m[1], "dist", "cli", FILE));
    // Sibling of the bundled entry (…/dist/cli/index.js → …/dist/cli/embed-worker.js).
    candidates.push(path.join(path.dirname(here), FILE));
  } catch {
    /* import.meta.url unavailable — fall through to cwd */
  }
  candidates.push(path.join(process.cwd(), "dist", "cli", FILE));
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0] ?? path.join(process.cwd(), "dist", "cli", FILE);
}

export class EmbedWorkerClient {
  private readonly log: Logger;
  private readonly getInlineEmbedder: () => EmbeddingService;
  private readonly timeoutMs: number;
  private readonly workerPath: string;
  private readonly createWorker: (workerPath: string) => WorkerLike;
  private readonly alert?: (reason: string, info?: unknown) => void;

  private worker: WorkerLike | null = null;
  private mode: "worker" | "inline" = "inline";
  private everSucceeded = false;
  private failedOpenLogged = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(opts: EmbedWorkerClientOptions) {
    this.log = opts.log;
    this.getInlineEmbedder = opts.getInlineEmbedder;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.workerPath = opts.workerPath ?? resolveEmbedWorkerPath();
    this.createWorker =
      opts.createWorker ?? ((p) => new Worker(p) as unknown as WorkerLike);
    this.alert = opts.alert;
    this.spawn();
  }

  /** 'inline' immediately after construction == worker file missing on disk. */
  getMode(): "worker" | "inline" {
    return this.mode;
  }

  /**
   * Embed `texts` into V2 (always) and V1 (when `includeV1`). Index-aligned with
   * `texts`. Never throws on the boot-fail-open path (returns inline results);
   * throws a retryable EmbedWorkerError on a runtime worker fault so the queue
   * retries.
   */
  async embedBothVersions(
    texts: readonly string[],
    includeV1: boolean,
  ): Promise<EmbeddedVersions> {
    if (texts.length === 0) return { v1: includeV1 ? [] : null, v2: [] };
    // Lazy runtime recovery — a prior runtime respawn may have left the worker
    // null while still in worker-mode. Retry spawn FIRST (before the inline
    // short-circuit) now that memory pressure may have eased; spawn() flips to
    // inline only on a boot/missing-file fault.
    if (this.mode === "worker" && !this.worker) this.spawn();
    if (this.mode === "inline") return this.embedInline(texts, includeV1);
    try {
      const result = await this.requestFromWorker(texts, includeV1);
      this.everSucceeded = true;
      return result;
    } catch (err) {
      if (!this.everSucceeded) {
        // Worker never produced a success → boot fault. Degrade to inline so
        // this request still completes (degraded daemon beats a failed turn).
        this.failOpen("embed_worker_boot_unavailable", err);
        return this.embedInline(texts, includeV1);
      }
      // Runtime fault after a prior success → never inline; queue retries.
      throw err instanceof EmbedWorkerError
        ? err
        : new EmbedWorkerError(
            err instanceof Error ? err.message : String(err),
          );
    }
  }

  private requestFromWorker(
    texts: readonly string[],
    includeV1: boolean,
  ): Promise<EmbeddedVersions> {
    return new Promise<EmbeddedVersions>((resolve, reject) => {
      const worker = this.worker;
      if (!worker) {
        reject(new EmbedWorkerError("embed worker not available"));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.log.warn({ tag: TAG, id }, "embed worker request timed out");
        // A hung worker would leak the drain's governor permit — recycle it.
        this.handleWorkerLoss("timeout", worker);
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        const req: EmbedWorkerRequest = { id, texts: [...texts], includeV1 };
        worker.postMessage(req);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(
          new EmbedWorkerError(
            `embed worker postMessage failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
      }
    });
  }

  private async embedInline(
    texts: readonly string[],
    includeV1: boolean,
  ): Promise<EmbeddedVersions> {
    const embedder = this.getInlineEmbedder();
    const v2: Int8Array[] = [];
    for (const text of texts) v2.push(await embedder.embedV2(text));
    let v1: Float32Array[] | null = null;
    if (includeV1) {
      v1 = [];
      for (const text of texts) v1.push(await embedder.embed(text));
    }
    return { v1, v2 };
  }

  private handleMessage(msg: EmbedWorkerResponse): void {
    if ("type" in msg && msg.type === "ready") return;
    if (!("id" in msg)) return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.ok) {
      pending.resolve({
        v2: msg.v2.map((b) => new Int8Array(b)),
        v1: msg.v1 ? msg.v1.map((b) => new Float32Array(b)) : null,
      });
    } else {
      pending.reject(new EmbedWorkerError(`embed worker error: ${msg.error}`));
    }
  }

  private spawn(): void {
    if (!existsSync(this.workerPath)) {
      // The single screaming build/ship-miss signal. Distinct from ONNX-load.
      this.failOpen("embed_worker_missing_on_disk");
      return;
    }
    try {
      const worker = this.createWorker(this.workerPath);
      this.worker = worker;
      this.mode = "worker";
      // Listeners capture THIS worker so the identity guard in handleWorkerLoss
      // can ignore stale events from a worker we already replaced.
      worker.on("message", (m) => this.handleMessage(m));
      worker.on("error", (e) => this.handleWorkerLoss("error", worker, e));
      worker.on("exit", (code) => {
        if (code !== 0) this.handleWorkerLoss("exit", worker, code);
      });
    } catch (err) {
      if (this.everSucceeded) {
        // RUNTIME respawn failure (e.g. memory pressure). Do NOT fall to inline
        // (landmine #5 — inline-on-main under pressure amplifies the incident).
        // Stay worker-mode with no worker: requests reject retryable and a later
        // request lazily retries spawn when pressure eases.
        this.worker = null;
        this.log.warn(
          { tag: TAG, err: brief(err) },
          "embed worker respawn failed at runtime — staying worker-mode (requests reject retryable; will retry spawn)",
        );
      } else {
        // BOOT spawn failure → fail open to inline (degraded beats crash-loop).
        this.failOpen("embed_worker_spawn_failed", err);
      }
    }
  }

  /**
   * Worker error / exit / timeout: reject in-flight retryable; respawn (runtime)
   * or fail open (boot). `sourceWorker` is the worker that emitted the event.
   */
  private handleWorkerLoss(
    reason: string,
    sourceWorker: WorkerLike | null,
    info?: unknown,
  ): void {
    // Identity guard — a crash emits BOTH 'error' AND 'exit', and terminate()
    // emits a further 'exit'. Without this, a stale event from an
    // already-replaced worker would terminate the freshly-spawned one and
    // cascade (terminate → exit → re-enter) into unbounded respawns.
    if (sourceWorker !== this.worker) return;
    const had = this.worker;
    this.worker = null;
    if (had) {
      try {
        had.terminate();
      } catch {
        /* ignore */
      }
    }
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) {
      clearTimeout(p.timer);
      p.reject(new EmbedWorkerError(`embed worker lost: ${reason}`));
    }
    if (this.everSucceeded) {
      this.log.warn(
        { tag: TAG, reason, info: brief(info) },
        "embed worker lost at runtime — respawning",
      );
      this.spawn();
    } else {
      this.failOpen(reason, info);
    }
  }

  private failOpen(reason: string, info?: unknown): void {
    this.mode = "inline";
    this.worker = null;
    if (!this.failedOpenLogged) {
      this.failedOpenLogged = true;
      this.log.error(
        { tag: TAG, reason, info: brief(info) },
        "embed worker unavailable — failing open to inline-on-main (degraded; reuses the daemon embedder singleton, no extra model copy)",
      );
      this.alert?.(reason, info);
    }
  }
}

function brief(info: unknown): string | undefined {
  if (info === undefined) return undefined;
  if (info instanceof Error) return info.message;
  return String(info);
}
