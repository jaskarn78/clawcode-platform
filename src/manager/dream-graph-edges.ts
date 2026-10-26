/**
 * Dream-pass wikilink writer — append-and-dedupe persistence into
 * `<memoryRoot>/graph-edges.json`. Pure-DI module: callers inject `now()`
 * for deterministic createdAt timestamps; fs is imported directly (matches
 * dream-log-writer.ts since both are file-emission edges).
 *
 * The dream-pass primitive reads this file back in on the next pass to
 * surface "existing wikilinks" context to the LLM (see
 * dream-pass.ts:222-224). The writer is deliberately tolerant of missing
 * or malformed prior content — a corrupt file is overwritten cleanly with
 * the new edge set rather than crashing the daemon.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

export interface DreamGraphEdge {
  readonly from: string;
  readonly to: string;
  readonly createdAt: string;
}

export interface DreamGraphEdgesFile {
  readonly edges: readonly DreamGraphEdge[];
}

export type AppendDreamWikilinksFn = (params: {
  readonly memoryRoot: string;
  readonly links: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  readonly now: () => Date;
}) => Promise<{ readonly added: number }>;

const FILE_NAME = "graph-edges.json";

/**
 * Hard cap on persisted edges. The file is read back into the dream prompt
 * on every pass (and is the first section the prompt builder degrades when
 * over budget), so unbounded growth (680 KB on the live host) only feeds
 * the model re-proposals of edges it can no longer see. Oldest edges are
 * dropped first; the file is append-ordered so "oldest" is the head.
 */
export const MAX_GRAPH_EDGES = 2000;

function edgeKey(from: string, to: string): string {
  return `${from} ${to}`;
}

async function atomicWrite(finalPath: string, content: string): Promise<void> {
  const tmp = `${finalPath}.tmp.${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, content, "utf8");
  try {
    await rename(tmp, finalPath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export const appendDreamWikilinks: AppendDreamWikilinksFn = async ({
  memoryRoot,
  links,
  now,
}) => {
  if (links.length === 0) return { added: 0 };

  await mkdir(memoryRoot, { recursive: true });
  const finalPath = `${memoryRoot}/${FILE_NAME}`;

  let existing: readonly DreamGraphEdge[] = [];
  try {
    const raw = await readFile(finalPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<DreamGraphEdgesFile>;
    if (parsed && Array.isArray(parsed.edges)) {
      existing = parsed.edges.filter(
        (e): e is DreamGraphEdge =>
          typeof e?.from === "string" &&
          typeof e?.to === "string" &&
          typeof e?.createdAt === "string",
      );
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      // Malformed JSON or read error — treat as empty so we overwrite cleanly
      // rather than failing the whole dream apply. The dream-pass primitive
      // takes the same tolerant stance when reading this file.
      existing = [];
    }
  }

  // Dedupe what is already on disk (earlier writers appended without this
  // pass, so a file can carry repeats). First occurrence wins so the
  // original createdAt survives.
  const seen = new Set<string>();
  const deduped: DreamGraphEdge[] = [];
  for (const e of existing) {
    const key = edgeKey(e.from, e.to);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(e);
  }

  const createdAt = now().toISOString();
  const additions: DreamGraphEdge[] = [];
  for (const link of links) {
    const key = edgeKey(link.from, link.to);
    if (seen.has(key)) continue;
    seen.add(key);
    additions.push({ from: link.from, to: link.to, createdAt });
  }

  let edges: DreamGraphEdge[] = [...deduped, ...additions];
  const overflow = edges.length - MAX_GRAPH_EDGES;
  if (overflow > 0) edges = edges.slice(overflow);

  const changed =
    additions.length > 0 || deduped.length !== existing.length || overflow > 0;
  if (!changed) return { added: 0 };

  const next: DreamGraphEdgesFile = { edges };
  await atomicWrite(finalPath, JSON.stringify(next, null, 2) + "\n");
  // Additions sit at the tail, so only a pass proposing more than the cap
  // on its own loses any of them; report the ones that were persisted.
  return { added: Math.min(additions.length, edges.length) };
};
