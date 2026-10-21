/**
 * Dedicated embed worker (Phase: robust auto-ingest, P1-EMBED-WORKER).
 *
 * Runs the ONNX embedding work for auto-ingest OFF the main event loop, in a
 * single `worker_threads` worker. During a burst, embedding hundreds of chunks
 * synchronously on the main thread blocks ALL agents' IPC / bridge / stall
 * tracker for seconds (the event-loop-block failure mode). This worker keeps
 * that work isolated; the main thread does only the synchronous better-sqlite3
 * writes.
 *
 * LANDMINES honoured here:
 *  - #1 ONE worker, never a pool. ONE `EmbeddingService` ⇒ ONE resident set of
 *    models (MiniLM V1 + bge-small V2). A pool would load one set PER worker.
 *  - #2 NO database. This worker imports ONLY the embedder (pure ONNX, no DB,
 *    no daemon/session imports — verified side-effect-free). It returns
 *    embeddings as transferable ArrayBuffers; the main thread owns all sqlite.
 *
 * Protocol (main ⇄ worker):
 *   main → worker:  { id, texts: string[], includeV1: boolean }
 *   worker → main:  { type: "ready" }                              (thread up)
 *                   { id, ok: true,  v2: ArrayBuffer[], v1: ArrayBuffer[]|null }
 *                   { id, ok: false, error: string }
 *
 * v2 (bge int8) is computed for every text — it serves BOTH docStore.ingest and
 * crossIngest's v2 write. v1 (MiniLM float32) is computed only when
 * `includeV1` (crossIngest writes v1 unconditionally; it is skipped when no
 * cross-ingest will run). Embeddings are index-aligned with `texts`.
 *
 * Model load is LAZY (first embed). A load failure surfaces as { ok:false } on
 * the first request; the client treats a pre-first-success failure as a boot
 * fail-open (→ inline-on-main) and a post-success crash as a runtime fault
 * (→ respawn + retryable reject). This worker NEVER decides that policy — it
 * just reports per-request success/failure and never exits on a request error.
 */

import { parentPort } from "node:worker_threads";
import { EmbeddingService } from "../memory/embedder.js";

export type EmbedWorkerRequest = {
  readonly id: number;
  readonly texts: readonly string[];
  readonly includeV1: boolean;
};

export type EmbedWorkerResponse =
  | { readonly type: "ready" }
  | {
      readonly id: number;
      readonly ok: true;
      readonly v2: ArrayBuffer[];
      readonly v1: ArrayBuffer[] | null;
    }
  | { readonly id: number; readonly ok: false; readonly error: string };

/** Copy a typed array's bytes into a standalone, transferable ArrayBuffer. */
function toTransferable(arr: Int8Array | Float32Array): ArrayBuffer {
  const out = new ArrayBuffer(arr.byteLength);
  new Uint8Array(out).set(
    new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength),
  );
  return out;
}

// ONE model set for the lifetime of this worker thread.
const embedder = new EmbeddingService();

if (parentPort) {
  const port = parentPort;

  port.on("message", async (msg: EmbedWorkerRequest) => {
    try {
      const v2: ArrayBuffer[] = [];
      for (const text of msg.texts) {
        v2.push(toTransferable(await embedder.embedV2(text)));
      }

      let v1: ArrayBuffer[] | null = null;
      if (msg.includeV1) {
        v1 = [];
        for (const text of msg.texts) {
          v1.push(toTransferable(await embedder.embed(text)));
        }
      }

      const transfers: ArrayBuffer[] = v1 ? [...v2, ...v1] : [...v2];
      const response: EmbedWorkerResponse = { id: msg.id, ok: true, v2, v1 };
      port.postMessage(response, transfers);
    } catch (err) {
      const response: EmbedWorkerResponse = {
        id: msg.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
      port.postMessage(response);
    }
  });

  // Thread is up and listening. Models load lazily on the first request.
  const ready: EmbedWorkerResponse = { type: "ready" };
  port.postMessage(ready);
}
