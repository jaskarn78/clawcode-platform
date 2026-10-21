/**
 * Phase 95 Plan 02 Task 2 — D-05 dream-log writer (atomic markdown emission).
 *
 * Pure module:
 *   - No SDK imports
 *   - No MEMORY.md writes (operator-curated; pinned by static-grep)
 *   - Atomic temp+rename (Phase 84/91 pattern; mirrors src/sync/sync-state-store.ts)
 *
 * Two surfaces:
 *   - `renderDreamLogSection(entry)` — pure renderer producing the D-05
 *     verbatim markdown block (header + 4 sub-sections + cost/duration footer)
 *   - `writeDreamLog({agentName, memoryRoot, entry})` — writes to
 *     `<memoryRoot>/dreams/YYYY-MM-DD.md` via tmp+rename. Same-day re-runs
 *     APPEND a new ## section preserving the existing file content.
 *
 * The dream log lives inside the workspace memory tree → automatically
 * synced via Phase 91 sync-runner (no extra plumbing per D-05).
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { DreamResult } from "./dream-pass.js";

/**
 * Dream-log entry shape — carries the data the renderer + writer need.
 * `idleMinutes` is supplied by the caller (cron tick measures actual idle
 * at fire time; primitive doesn't recompute).
 */
export interface DreamLogEntry {
  readonly timestamp: Date;
  readonly idleMinutes: number;
  readonly model: string;
  readonly result: DreamResult;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly durationMs: number;
}

export type WriteDreamLogFn = (params: {
  agentName: string;
  memoryRoot: string;
  entry: DreamLogEntry;
}) => Promise<{ logPath: string; appended: boolean }>;

/**
 * Render the D-05 markdown section for a single dream pass.
 *
 * Section template (verbatim from D-05 specifics):
 *   ## [HH:MM UTC] Dream pass (idle Nmin, model=<model>)
 *
 *   **Themed reflection:** ...
 *
 *   **New wikilinks (N):**
 *   - <from> → <to> (<rationale>)
 *   ... or _(none)_ if N=0
 *
 *   **Promotion candidates (N):**
 *   - "<chunkId>" → consider promoting to MEMORY.md (operator review): <rationale>
 *   ... or _(none)_ if N=0
 *
 *   **Suggested consolidations (N):**
 *   - <sources joined "+"> → <newPath> (operator review): <rationale>
 *   ... or _(none)_ if N=0
 *
 *   **Cost:** <tokensIn> in / <tokensOut> out tokens · Duration: <Xs>
 *
 * Time format: HH:MM UTC zero-padded via toISOString().slice(11, 16).
 */
export function renderDreamLogSection(entry: DreamLogEntry): string {
  const iso = entry.timestamp.toISOString();
  const hhmm = iso.slice(11, 16); // "HH:MM"
  const lines: string[] = [];
  lines.push(
    `## [${hhmm} UTC] Dream pass (idle ${entry.idleMinutes}min, model=${entry.model})`,
  );
  lines.push("");
  lines.push(`**Themed reflection:** ${entry.result.themedReflection}`);
  lines.push("");

  // New wikilinks (additive — D-04 auto-applies these)
  const links = entry.result.newWikilinks;
  lines.push(`**New wikilinks (${links.length}):**`);
  if (links.length === 0) {
    lines.push("_(none)_");
  } else {
    for (const link of links) {
      lines.push(`- ${link.from} → ${link.to} (${link.rationale})`);
    }
  }
  lines.push("");

  // Promotion candidates (SURFACED for operator review — never auto-applied)
  const promos = entry.result.promotionCandidates;
  lines.push(`**Promotion candidates (${promos.length}):**`);
  if (promos.length === 0) {
    lines.push("_(none)_");
  } else {
    for (const p of promos) {
      lines.push(
        `- "${p.chunkId}" → consider promoting to MEMORY.md (operator review): ${p.rationale}`,
      );
    }
  }
  lines.push("");

  // Suggested consolidations (SURFACED for operator review — never auto-merged)
  const cons = entry.result.suggestedConsolidations;
  lines.push(`**Suggested consolidations (${cons.length}):**`);
  if (cons.length === 0) {
    lines.push("_(none)_");
  } else {
    for (const c of cons) {
      lines.push(
        `- ${c.sources.join("+")} → ${c.newPath} (operator review): ${c.rationale}`,
      );
    }
  }
  lines.push("");

  // Cost + duration footer
  const durationSec = (entry.durationMs / 1000).toFixed(1);
  lines.push(
    `**Cost:** ${entry.tokensIn} in / ${entry.tokensOut} out tokens · Duration: ${durationSec}s`,
  );

  return lines.join("\n") + "\n";
}

/**
 * Atomic write helper — Phase 84/91 pattern. Writes to `<finalPath>.tmp.<nonce>`
 * then renames atomically. On rename failure, best-effort unlinks the tmp file
 * before propagating the error to the caller.
 */
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

/**
 * Write a dream-log entry to `<memoryRoot>/dreams/YYYY-MM-DD.md`.
 *
 * Behavior:
 *   - First pass of the day: create file with header + section; appended=false
 *   - Subsequent passes same day: read existing file, append a new ## section
 *     preserving prior content byte-for-byte (modulo trailing whitespace
 *     normalization); appended=true
 *
 * Writes are atomic via temp+rename — partial writes never visible to readers.
 * The `dreams/` subdirectory is auto-created via mkdir recursive.
 */
export const writeDreamLog: WriteDreamLogFn = async ({
  agentName,
  memoryRoot,
  entry,
}) => {
  // YYYY-MM-DD bucket (zero-padded by ISO format)
  const dateBucket = entry.timestamp.toISOString().slice(0, 10);
  const dir = `${memoryRoot}/dreams`;
  const finalPath = `${dir}/${dateBucket}.md`;

  await mkdir(dir, { recursive: true });

  let existingContent: string | null = null;
  try {
    existingContent = await readFile(finalPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }

  const newSection = renderDreamLogSection(entry);

  if (existingContent === null) {
    const header = `# Dream log — ${agentName} — ${dateBucket}\n\n`;
    await atomicWrite(finalPath, header + newSection);
    return { logPath: finalPath, appended: false };
  }

  // Same-day append: preserve existing content, separate sections by blank line
  const merged = existingContent.trimEnd() + "\n\n" + newSection;
  await atomicWrite(finalPath, merged);
  return { logPath: finalPath, appended: true };
};
