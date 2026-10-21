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

  const seen = new Set<string>(existing.map((e) => edgeKey(e.from, e.to)));
  const createdAt = now().toISOString();
  const additions: DreamGraphEdge[] = [];
  for (const link of links) {
    const key = edgeKey(link.from, link.to);
    if (seen.has(key)) continue;
    seen.add(key);
    additions.push({ from: link.from, to: link.to, createdAt });
  }

  if (additions.length === 0) return { added: 0 };

  const next: DreamGraphEdgesFile = {
    edges: [...existing, ...additions],
  };
  await atomicWrite(finalPath, JSON.stringify(next, null, 2) + "\n");
  return { added: additions.length };
};
