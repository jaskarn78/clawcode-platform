/**
 * WP3 (2026-10-25): full document deletion for the delete_document tool.
 *
 * Before WP3 the tool removed only `document_chunks` and their vectors. The
 * `documents` provenance row survived (so the rescan treated the file as
 * ingested and an identical re-send was recorded as a duplicate of the
 * deleted original), and the `document:<slug>` memory mirror kept surfacing
 * the deleted text in <memory-context> and clawcode_memory_search.
 *
 * `purgeDocument` removes, in order:
 *   1. the chunks, vectors and `documents` rows (the source's own row and
 *      rows recorded as exact duplicates of it), via DocumentStore;
 *   2. the memory mirror at `document:<computeDocSlug(source)>`;
 *   3. the inbox copies of the source and its duplicates, but only files
 *      inside the agent's own inbox directory. Without this the 10-minute
 *      rescan would see an inbox file younger than 24 h with no documents
 *      row and ingest it again, undoing the delete;
 *   4. the archived image copy, only when it sits inside the agent's
 *      archive directory and no remaining documents row points at it.
 * Files outside those two directories (manual ingests of workspace files)
 * are never touched.
 */

import { unlink } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { DocumentStore } from "./store.js";
import type { MemoryStore } from "../memory/store.js";
import { computeDocSlug } from "../document-ingest/index.js";

export type PurgeDocumentArgs = {
  readonly docStore: DocumentStore;
  /** Absent when the agent's memory store is not open; the mirror is then left alone. */
  readonly memoryStore?: MemoryStore;
  readonly source: string;
  /** The agent's `<memoryPath>/inbox/attachments`; files inside it may be removed. */
  readonly inboxDir?: string;
  /** The agent's image archive directory; files inside it may be removed. */
  readonly archiveDir?: string;
  /** Test seam. Defaults to fs/promises unlink. */
  readonly unlinkFn?: (path: string) => Promise<void>;
};

export type PurgeDocumentResult = {
  readonly chunksDeleted: number;
  readonly documentRowsDeleted: number;
  readonly memoryChunksDeleted: number;
  readonly filesRemoved: readonly string[];
};

/** True when `target` resolves to a path strictly inside `dir`. */
export function isInsideDir(target: string, dir: string | undefined): boolean {
  if (!dir) return false;
  const rel = relative(resolve(dir), resolve(target));
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

export async function purgeDocument(args: PurgeDocumentArgs): Promise<PurgeDocumentResult> {
  const { docStore, source } = args;
  const unlinkFn = args.unlinkFn ?? ((p: string) => unlink(p));

  const row = docStore.getDocumentRow(source);
  const duplicates = docStore.listDuplicatesOf(source);
  const chunksDeleted = docStore.deleteDocument(source);
  const documentRowsDeleted = (row ? 1 : 0) + duplicates.length;

  const memoryChunksDeleted = args.memoryStore
    ? args.memoryStore.deleteMemoryChunksByPath(`document:${computeDocSlug(source)}`)
    : 0;

  const filesRemoved: string[] = [];
  const tryUnlink = async (path: string): Promise<void> => {
    try {
      await unlinkFn(path);
      filesRemoved.push(path);
    } catch {
      // Already gone (24 h cleanup) or unreadable: nothing to do.
    }
  };

  for (const path of [source, ...duplicates.map((d) => d.source)]) {
    if (isInsideDir(path, args.inboxDir)) await tryUnlink(path);
  }

  const imagePaths = new Set<string>();
  if (row?.source_image_path) imagePaths.add(row.source_image_path);
  for (const d of duplicates) if (d.source_image_path) imagePaths.add(d.source_image_path);
  for (const path of imagePaths) {
    if (!isInsideDir(path, args.archiveDir)) continue;
    if (docStore.countImagePathReferences(path) > 0) continue;
    await tryUnlink(path);
  }

  return Object.freeze({
    chunksDeleted,
    documentRowsDeleted,
    memoryChunksDeleted,
    filesRemoved: Object.freeze(filesRemoved),
  });
}
