/**
 * Phase 101 Plan 04 — Local cross-encoder reranker (U9, D-04).
 *
 * Wraps the Phase 90 hybrid-RRF retrieval output with a `Xenova/bge-reranker-base`
 * pass that re-scores the top-N candidates as `(query, passage)` pairs and keeps
 * the final top-K. Uses the existing `@huggingface/transformers` ONNX runtime
 * (same runtime as the embedder — zero new runtime dependency).
 *
 * Threat model (PLAN 04 register):
 *   - T-101-12 (DoS via reranker latency): mitigated by Promise.race timeout;
 *     fallback returns raw RRF order. Caller logs `reranker-fallback reason=timeout`.
 *   - T-101-13 (adversarial model swap): mitigated by hardcoding the model id
 *     (`Xenova/bge-reranker-base` primary; `onnx-community/bge-reranker-v2-m3-ONNX`
 *     documented fallback). Model id is NOT config-driven.
 *   - T-101-14 (info disclosure via reranker logs): mitigated by only logging
 *     scores + counts + timings — NEVER the query or passage text.
 *
 * Wave-0 gate (D-04): the smoke test in `tests/memory/reranker-smoke.test.ts`
 * MUST verify `pipeline('text-classification', 'Xenova/bge-reranker-base')` loads
 * end-to-end on the dev box before any integration code is wired. If the smoke
 * fails, U9 splits to Phase 101.5 and Plan 04 closes with a deferred SUMMARY.
 */

import { pipeline } from "@huggingface/transformers";

/** Primary cross-encoder reranker model. Hardcoded per T-101-13. */
export const PRIMARY_MODEL = "Xenova/bge-reranker-base";

/**
 * Documented fallback if the primary model lacks ONNX assets on Hugging Face.
 * NOT auto-selected by `loadReranker()` — operator opts in via a follow-up plan
 * (Phase 101.5) after a Wave-0 gate failure.
 */
export const FALLBACK_MODEL = "onnx-community/bge-reranker-v2-m3-ONNX";

/**
 * Lazy-loaded reranker pipeline (the @huggingface/transformers `pipeline()`
 * factory returns a callable Pipeline instance). Cached per-process so the
 * ~100MB model weights aren't re-loaded on every retrieval turn.
 *
 * Typed as `any` because the upstream `AllTasks['text-classification']`
 * type is awkward to express at the call site — we only consume the
 * callable signature `(inputs) => Promise<Array<{score, label}>>`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pipeline: any | null = null;

/**
 * Load the reranker pipeline (idempotent). First call downloads the ONNX
 * weights (~100MB) to `~/.cache/huggingface/` on cold cache; subsequent
 * calls return the cached instance.
 *
 * `dtype: "q8"` selects the int8-quantized ONNX weights for ~3x lower
 * memory + faster inference at minimal precision loss for reranker scoring.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadReranker(modelId: string = PRIMARY_MODEL): Promise<any> {
  if (_pipeline) return _pipeline;
  _pipeline = await pipeline("text-classification", modelId, { dtype: "q8" });
  return _pipeline;
}

/**
 * Daemon boot hook — fire-and-forget warm of the reranker pipeline so the
 * first operator turn doesn't pay the cold-load cost (~2-5s on warm cache,
 * ~30s on first-ever download).
 *
 * Non-throwing by design: the caller (`src/manager/daemon.ts` boot
 * sequence) invokes via `void warmupReranker().catch(...)` so a failed
 * warm doesn't crash the daemon — retrieval will simply load lazily on
 * the first turn (with the timeout fallback covering the worst case).
 */
export async function warmupReranker(): Promise<void> {
  const p = await loadReranker();
  // Single-pair warmup primes the ONNX session + tokenizer caches.
  await p([{ text: "warmup", text_pair: "warmup" }]);
}

/**
 * Test-only escape hatch. Forces the next `loadReranker()` call to re-load
 * from disk. NOT exported via barrel; consumed by smoke + integration tests.
 */
export function _resetRerankerForTests(): void {
  _pipeline = null;
}

/**
 * Phase 101 Plan 04 (T02 follow-up) — env-override applicator. Wraps a
 * config block from YAML with the `CLAWCODE_RERANKER_ENABLED=false`
 * emergency disable flag.
 *
 * Behavior:
 *   - `CLAWCODE_RERANKER_ENABLED=false` + cfg present → returns cfg with
 *     `enabled: false` (force-disable on the next retrieval turn).
 *   - `CLAWCODE_RERANKER_ENABLED=false` + cfg undefined → returns undefined
 *     (back-compat: pre-101-04 path stays disabled).
 *   - env var unset / any other value (including "true") → passes cfg
 *     through unchanged.
 *
 * The emergency env override is the operator's mid-incident knob — unlike
 * the `clawcode reload` YAML path it doesn't require daemon liveness, so
 * an operator can disable rerank via systemd env without a config edit.
 *
 * Mirrors operator preference for flippable rollback paths (Phase 110
 * shimRuntime, Phase 117 advisor backend). Wired by daemon.ts at the
 * `setRerankerConfigResolver` call site so a single resolver closure
 * handles both YAML + env signals.
 */
export type RerankerConfigBlock = Readonly<{
  enabled: boolean;
  topNToRerank: number;
  finalTopK: number;
  timeoutMs: number;
}>;

export function applyRerankerEnvOverride(
  cfg: RerankerConfigBlock | undefined,
  env: NodeJS.ProcessEnv = process.env,
): RerankerConfigBlock | undefined {
  if (env.CLAWCODE_RERANKER_ENABLED === "false") {
    return cfg ? { ...cfg, enabled: false } : undefined;
  }
  return cfg;
}

/**
 * Minimal structural shape a rerank candidate needs to satisfy. Compatible
 * with both `MemoryRetrievalResult` (which carries `body`) and the legacy
 * RRF-shape pseudocode that names the field `content`. Accept either; the
 * caller in `memory-retrieval.ts` passes the field explicitly via the
 * `getText` accessor below to avoid the union-narrowing dance.
 */
export type RerankableCandidate = Readonly<{ readonly body?: string; readonly content?: string }>;

/**
 * Logger shape — debug/info/warn at minimum. Matches pino's interface
 * without taking a hard dependency on pino in this module (which is
 * imported by both the daemon and the dashboard SPA's vitest path).
 */
export type RerankerLogger = Readonly<{
  info?: (obj: Record<string, unknown>, msg?: string) => void;
  warn?: (obj: Record<string, unknown>, msg?: string) => void;
}>;

/**
 * Optional DI hook so integration tests can inject a synthetic scorer
 * (fake "score this pair" function) without monkey-patching
 * `@huggingface/transformers`. Production callers omit this and get the
 * real `loadReranker()`-backed pipeline.
 *
 * Receives the raw `[{text, text_pair}, ...]` payload and MUST return
 * `[{score, label}, ...]` in input order.
 */
export type RerankFn = (
  pairs: ReadonlyArray<{ text: string; text_pair: string }>,
) => Promise<ReadonlyArray<{ score: number; label?: string }>>;

export type RerankTopOptions<T extends RerankableCandidate> = Readonly<{
  /** Final number of candidates to return. */
  topK: number;
  /** Per-call timeout. Default 500ms. */
  timeoutMs?: number;
  /** Optional logger for fallback/applied events. */
  logger?: RerankerLogger;
  /** Test DI hook — synthetic scorer. */
  rerankFn?: RerankFn;
  /**
   * Field accessor — extract the passage text from a candidate. Defaults to
   * `c.body ?? c.content ?? ""` so `MemoryRetrievalResult` (body) and the
   * legacy RRF-shape pseudocode (content) both work without TypeScript
   * union narrowing at every call site.
   */
  getText?: (c: T) => string;
}>;

/**
 * Re-score `candidates` against `query` with the bge-reranker-base cross-encoder
 * and return the top-K by descending relevance score. Graceful degradation:
 * on timeout or runtime error, returns `candidates.slice(0, topK)` in their
 * original order and logs a `reranker-fallback` event with the reason.
 *
 * No content/query text is ever logged (T-101-14 mitigation).
 */
export async function rerankTop<T extends RerankableCandidate>(
  query: string,
  candidates: readonly T[],
  opts: RerankTopOptions<T>,
): Promise<readonly T[]> {
  if (candidates.length === 0) return candidates;
  const timeoutMs = opts.timeoutMs ?? 500;
  const getText = opts.getText ?? ((c: T) => c.body ?? c.content ?? "");
  const started = Date.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let timeoutHandle: any = null;
  try {
    const pairs = candidates.map((c) => ({ text: query, text_pair: getText(c) }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scorer: RerankFn = opts.rerankFn ?? (async (p) => (await (await loadReranker())(p)) as any);
    const scoresPromise = scorer(pairs);
    const scores = (await Promise.race([
      scoresPromise,
      new Promise<never>((_, rej) => {
        timeoutHandle = setTimeout(
          () => rej(new Error("reranker-timeout")),
          timeoutMs,
        );
      }),
    ])) as ReadonlyArray<{ score: number }>;
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (scores.length !== candidates.length) {
      throw new Error(
        `reranker-score-count-mismatch expected=${candidates.length} got=${scores.length}`,
      );
    }
    const scored = candidates.map((c, i) => ({ c, s: scores[i].score }));
    scored.sort((a, b) => b.s - a.s);
    const kept = Math.min(opts.topK, candidates.length);
    opts.logger?.info?.(
      {
        phase: "phase101-ingest",
        event: "reranker-applied",
        n: candidates.length,
        kept,
        latency_ms: Date.now() - started,
      },
      "reranker applied",
    );
    return Object.freeze(scored.slice(0, kept).map((x) => x.c));
  } catch (err) {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    const reason = (err as Error).message ?? "unknown";
    opts.logger?.warn?.(
      {
        phase: "phase101-ingest",
        event: "reranker-fallback",
        reason,
        latency_ms: Date.now() - started,
      },
      "reranker fallback to RRF order",
    );
    return Object.freeze(candidates.slice(0, opts.topK));
  }
}
