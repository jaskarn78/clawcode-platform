/**
 * WP3 (2026-10-25) — re-mirror documents whose memory mirror is missing.
 *
 * `document_chunks` is what the search_documents tool reads; the per-turn
 * retriever and clawcode_memory_search read `memory_chunks` under
 * `document:<slug>`. The mirror is written best-effort at ingest time, so a
 * memory-store hiccup leaves a document that only search_documents can
 * find (the live system had 13,458 document chunks and 665 mirror rows).
 *
 * The inbox rescan check calls `remirrorMissingDocuments` every cycle with a
 * small per-cycle cap: for each source with chunks but no
 * `document:<slug>` ledger row, the document text is rebuilt from its
 * stored chunks, re-chunked to about 300 words with the contextual header,
 * embedded (v1 and v2) and written through `crossIngestToMemory`.
 */

import { basename } from "node:path";
import type { Logger } from "pino";
import type { DocumentStore } from "../documents/store.js";
import type { MemoryStore } from "../memory/store.js";
import { reassembleChunkedText } from "../documents/chunker.js";
import {
  chunkForMirror,
  stripChunkHeader,
  type DocumentChunkContext,
} from "../documents/chunk-context.js";
import { computeDocSlug } from "./index.js";
import { crossIngestToMemory, MigrationPhaseStore } from "./cross-ingest.js";

/** Default number of documents re-mirrored per rescan cycle. */
export const DEFAULT_REMIRROR_PER_CYCLE = 10;

export type RemirrorEmbed = (
  texts: readonly string[],
) => Promise<{ readonly v1: Float32Array[]; readonly v2: Int8Array[] }>;

export type RemirrorDeps = {
  readonly agent: string;
  readonly docStore: DocumentStore;
  readonly memoryStore: MemoryStore;
  readonly embed: RemirrorEmbed;
  readonly logger?: Logger;
  readonly maxDocuments?: number;
};

export type RemirrorResult = {
  /** Sources with chunks that were checked for a mirror. */
  readonly checked: number;
  /** Sources that had no mirror before this run. */
  readonly missing: number;
  readonly remirrored: number;
  readonly failed: number;
};

/** The memory_chunks path for a source. */
export function mirrorPathFor(source: string): string {
  return `document:${computeDocSlug(source)}`;
}

/**
 * Original filename for a source: the stored `documents.filename` when
 * present, else the basename with the inbox `<timestamp>-` prefix removed.
 */
export function displayFilenameFor(source: string, stored?: string | null): string {
  if (typeof stored === "string" && stored.trim().length > 0) return stored.trim();
  return basename(source).replace(/^\d{10,}-/, "");
}

/** Sources (chunk order) whose `document:<slug>` mirror ledger row is missing. */
export function findDocumentsMissingMirror(
  docStore: DocumentStore,
  memoryStore: MemoryStore,
): readonly string[] {
  const out: string[] = [];
  for (const source of docStore.listSources()) {
    if (memoryStore.getMemoryFileSha256(mirrorPathFor(source)) === null) out.push(source);
  }
  return Object.freeze(out);
}

/**
 * Rebuild the document text from its stored chunks (headers stripped,
 * overlap removed) and mirror it. Returns the number of mirror rows written.
 */
export async function remirrorDocument(
  source: string,
  deps: Pick<RemirrorDeps, "agent" | "docStore" | "memoryStore" | "embed">,
): Promise<number> {
  const stored = deps.docStore.getChunksForSource(source);
  if (stored.length === 0) return 0;
  const row = deps.docStore.getDocumentRow(source);
  const text = reassembleChunkedText(stored.map((c) => stripChunkHeader(c.content)));
  if (text.trim().length === 0) return 0;
  const ctx: DocumentChunkContext = {
    filename: displayFilenameFor(source, row?.filename),
    uploadedAt: row?.ingested_at ?? null,
    userName: row?.user_name ?? null,
    channelName: row?.channel_name ?? null,
  };
  const chunks = chunkForMirror(text, ctx);
  if (chunks.length === 0) return 0;
  const { v1, v2 } = await deps.embed(chunks.map((c) => c.content));
  const result = await crossIngestToMemory({
    agent: deps.agent,
    docSlug: computeDocSlug(source),
    heading: ctx.filename,
    chunks,
    precomputedV1: v1,
    precomputedV2: v2,
    memoryStore: deps.memoryStore,
    migrationPhaseStore: new MigrationPhaseStore(deps.memoryStore, deps.agent),
  });
  return result.chunksWritten;
}

/**
 * Re-mirror up to `maxDocuments` documents whose mirror is missing. Never
 * throws: a failing document is logged and counted, the rest continue.
 */
export async function remirrorMissingDocuments(deps: RemirrorDeps): Promise<RemirrorResult> {
  const max = deps.maxDocuments ?? DEFAULT_REMIRROR_PER_CYCLE;
  const missing = findDocumentsMissingMirror(deps.docStore, deps.memoryStore);
  const checked = deps.docStore.listSources().length;
  let remirrored = 0;
  let failed = 0;
  for (const source of missing.slice(0, Math.max(0, max))) {
    try {
      const written = await remirrorDocument(source, deps);
      if (written > 0) remirrored++;
    } catch (err) {
      failed++;
      deps.logger?.warn(
        {
          tag: "wp3-remirror",
          agent: deps.agent,
          source,
          err: err instanceof Error ? err.message : String(err),
        },
        "document re-mirror failed (will retry next cycle)",
      );
    }
  }
  if (remirrored > 0 || failed > 0) {
    deps.logger?.info(
      { tag: "wp3-remirror", agent: deps.agent, checked, missing: missing.length, remirrored, failed },
      "document re-mirror pass",
    );
  }
  return Object.freeze({ checked, missing: missing.length, remirrored, failed });
}
