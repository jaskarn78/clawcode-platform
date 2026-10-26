/**
 * Phase 141 — shared pre-turn `<memory-context>` augmenter.
 *
 * Extracted from `TurnDispatcher.augmentWithMemoryContext` (the v2/SDK path) so
 * the v3 (`claude --channels`) dispatch can get the SAME auto-injected
 * memory-context block. v3 chat bypasses the TurnDispatcher entirely, so before
 * this it received NO automatic memory retrieval (it could still call
 * `memory_recall`/`memory_search`, but lost the v2 reflex). The daemon creates
 * ONE instance and shares it with both the TurnDispatcher and the Discord bridge
 * → identical behavior + a single per-agent cadence counter (no v2/v3 drift).
 *
 * Behavior preserved verbatim from the v2 implementation:
 *  - Fail-open: no retriever, empty query, retriever error, or zero chunks →
 *    the original message is returned unchanged.
 *  - Cadence (context-bloat fix #2-A): retrieval refreshes on turn 1 and then
 *    every `MEMORY_RETRIEVAL_CADENCE_TURNS` turns; intervening turns return the
 *    message unchanged (the agent still carries the last refresh's block). The
 *    counter advances every turn that reaches here.
 *  - `<memory-context source="hybrid-rrf" chunks="N">` wrapper, prepended to the
 *    mutable message suffix (stable prefix cache untouched).
 *  - Best-effort token-count emission via the injected `onTokens` hook.
 */

import type { Logger } from "pino";

import {
  retrievalResultDate,
  retrievalSourceKind,
  type MemoryRetrievalResult,
} from "../memory/memory-retrieval.js";
import { stripChannelEnvelope } from "../shared/channel-envelope.js";

/** Pre-turn hybrid-RRF retriever. Returns [] to opt out (fail-open). */
export type MemoryRetriever = (
  agentName: string,
  query: string,
) => Promise<readonly MemoryRetrievalResult[]>;

/**
 * Context-bloat fix #2-A — memory-context retrieval cadence (turns between
 * refreshes). Mirrors `TurnDispatcher.MEMORY_RETRIEVAL_CADENCE_TURNS` (the v2
 * documented source of truth, value 3); kept module-private here to avoid a
 * runtime import cycle (turn-dispatcher imports `renderMemoryContext` from this
 * module). An agent is v2 XOR v3, so the two cadence counters never overlap.
 */
const MEMORY_RETRIEVAL_CADENCE_TURNS = 3;

/** Embeds a query in the same space the retriever uses (MiniLM v1 is fine). */
export type QueryEmbedder = (query: string) => Promise<Float32Array>;

/**
 * Phase 999.187 — below this cosine between the current query and the query
 * that produced the last injected block, the conversation has moved on and
 * the block is stale: refresh now instead of waiting out the cadence.
 */
export const TOPIC_SHIFT_MIN_COSINE = 0.75;

export type CadenceVerdict = Readonly<{
  refresh: boolean;
  reason: "first" | "cadence" | "topic-shift" | "hold";
}>;

function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/**
 * Phase 999.187 — the ONE cadence rule, shared by the v2 TurnDispatcher and
 * the v3 MemoryContextAugmenter.
 *
 * Context-bloat fix #2-A retrieved on turn 1 and then every K turns, and
 * NOTHING in between. A user who changed subject on turn 2 got no memory
 * for that subject until turn 4, and the block that was in the transcript
 * was about the old subject. This gate keeps the K-turn cap on growth but
 * also refreshes when the query has drifted from the one that produced the
 * last block (cosine below `minCosine`). Without an embedder it behaves
 * exactly as before; an embedder failure holds (fail-open to the old rule).
 */
export class RetrievalCadenceGate {
  private readonly state = new Map<
    string,
    { turnCounter: number; lastRetrievalTurn: number; lastQuery?: Float32Array }
  >();

  constructor(
    private readonly embed?: QueryEmbedder,
    private readonly cadenceTurns: number = MEMORY_RETRIEVAL_CADENCE_TURNS,
    private readonly minCosine: number = TOPIC_SHIFT_MIN_COSINE,
  ) {}

  async shouldRefresh(agentName: string, rawQuery: string): Promise<CadenceVerdict> {
    // WP2 (2026-10-25): compare the user's words, not the Discord envelope.
    // Every Discord query shares the same ~130-char `<channel ...>` prefix,
    // which pulled every pair of queries toward the same vector and muted
    // the topic-shift detection.
    const query = stripChannelEnvelope(rawQuery);
    const st = this.state.get(agentName) ?? { turnCounter: 0, lastRetrievalTurn: 0 };
    st.turnCounter += 1;
    this.state.set(agentName, st);

    let reason: CadenceVerdict["reason"] = "hold";
    let embedding: Float32Array | undefined;
    if (st.lastRetrievalTurn === 0) {
      reason = "first";
    } else if (st.turnCounter - st.lastRetrievalTurn >= this.cadenceTurns) {
      reason = "cadence";
    } else if (this.embed && st.lastQuery && query.length > 0) {
      try {
        embedding = await this.embed(query);
        if (cosine(embedding, st.lastQuery) < this.minCosine) reason = "topic-shift";
      } catch {
        /* embedder failure → the old cadence rule decides */
      }
    }

    if (reason === "hold") return { refresh: false, reason };
    st.lastRetrievalTurn = st.turnCounter;
    if (this.embed && query.length > 0) {
      try {
        st.lastQuery = embedding ?? (await this.embed(query));
      } catch {
        st.lastQuery = undefined;
      }
    }
    return { refresh: true, reason };
  }
}

/**
 * WP2: the provenance suffix of a rendered heading, "(kind, YYYY-MM-DD)" or
 * "(kind)" when no date is known. kind is memory / chunk / document /
 * shared (memory-retrieval.ts MemorySourceKind).
 */
export function memoryContextProvenance(c: MemoryRetrievalResult): string {
  const kind = retrievalSourceKind(c);
  const iso = retrievalResultDate(c);
  return iso ? `(${kind}, ${iso.slice(0, 10)})` : `(${kind})`;
}

/**
 * Render the `<memory-context>` wrapper for a set of retrieved chunks.
 *
 * WP2 (2026-10-25): every heading carries its source kind and date,
 * `### <heading or path> (<kind>, <YYYY-MM-DD>)`, so the model can tell a
 * two-year-old memory from yesterday's note and a flush log from an
 * operator document when two recollections disagree.
 */
export function renderMemoryContext(
  chunks: readonly MemoryRetrievalResult[],
): string {
  const rendered = chunks
    .map((c) => {
      const heading = c.heading ?? c.path;
      return `### ${heading} ${memoryContextProvenance(c)}\n${c.body}`;
    })
    .join("\n\n");
  return `<memory-context source="hybrid-rrf" chunks="${chunks.length}">\n${rendered}\n</memory-context>\n\n`;
}

export interface MemoryContextAugmenterOptions {
  readonly retriever: MemoryRetriever;
  readonly log: Logger;
  /** Phase 999.187 — enables the topic-shift refresh; omitted → pure K-turn cadence. */
  readonly queryEmbedder?: QueryEmbedder;
}

/**
 * Holds the per-agent cadence state + the retriever and produces the augmented
 * message. Used by the v3 dispatch path (the v2 TurnDispatcher keeps its own
 * cadence but shares `renderMemoryContext` so the emitted block is identical).
 */
export class MemoryContextAugmenter {
  private readonly retriever: MemoryRetriever;
  private readonly log: Logger;
  private readonly gate: RetrievalCadenceGate;

  constructor(options: MemoryContextAugmenterOptions) {
    this.retriever = options.retriever;
    this.log = options.log;
    this.gate = new RetrievalCadenceGate(options.queryEmbedder);
  }

  /**
   * Prepend a `<memory-context>` block to `message` (cadence-gated, fail-open).
   * Returns the message unchanged on any opt-out / error path.
   */
  async augment(agentName: string, message: string): Promise<string> {
    // WP2 (2026-10-25): retrieve on the user's words. The v3 chat path
    // hands the whole formatted Discord message here, envelope included.
    const query = stripChannelEnvelope(message);
    if (query.length === 0) return message;
    const verdict = await this.gate.shouldRefresh(agentName, query);
    if (!verdict.refresh) return message;
    try {
      const chunks = await this.retriever(agentName, query);
      if (verdict.reason === "topic-shift") {
        this.log.debug({ agent: agentName, chunks: chunks.length }, "memory-context: refreshed on topic shift");
      }
      if (chunks.length === 0) return message;
      return renderMemoryContext(chunks) + message;
    } catch (err) {
      this.log.warn(
        { agent: agentName, error: (err as Error).message },
        "memory retrieval failed — continuing without context (fail-open)",
      );
      return message;
    }
  }
}
