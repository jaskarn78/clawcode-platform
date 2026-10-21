/**
 * Phase 999.188 — apply a dream-pass promotion run into MEMORY.md.
 *
 * This is the step Phase 115 D-10 designed and never wired: the veto store
 * scheduled rows, nothing ever ticked, and no code turned a candidate into
 * text in MEMORY.md. `promoteCandidates` is that code. Pure-DI: the caller
 * supplies the chunk resolver, the file reader and the (jailed) append.
 *
 * Rules:
 *   - Text comes from the LIVE chunk when the id still resolves, else from
 *     the snapshot the applier stored at schedule time. Both missing →
 *     `chunk-missing`, skipped.
 *   - A body already present in MEMORY.md (exact trimmed substring) is
 *     `already-present`, skipped — re-running a dream never duplicates.
 *   - MEMORY.md has a hard prompt cap (INJECTED_MEMORY_MAX_CHARS). A section
 *     that would push the file past `capChars` is `memory-at-cap`, skipped:
 *     promoting into an over-cap file only feeds the truncation that
 *     triggers priority passes in the first place.
 *   - `edit` / `merge` / `overwrite` candidates carry no replacement text in
 *     the dream schema, so there is nothing to overwrite WITH. They are
 *     appended like additive ones and flagged `downgraded` so the operator
 *     can see the dream wanted a rewrite.
 *   - The section is `## <heading>` + body + one italic provenance line
 *     (source path, run id, date) so a reader of MEMORY.md knows where it
 *     came from and can prune it.
 *
 * Outcome: `ok` when at least one candidate was written OR every skip was
 * benign (already present). Zero writes with a cap or missing-chunk skip is
 * a failure the veto store records on the row (`expired` + applyError).
 */

import type { VetoStorePromotion, VetoStoreRow } from "./dream-veto-store.js";

export type PromoteSkipReason = "chunk-missing" | "already-present" | "memory-at-cap" | "append-failed";

export interface PromotedCandidate {
  readonly chunkId: string;
  readonly currentPath: string;
  readonly heading: string;
  readonly chars: number;
  /** A mutating candidate written as an append (no replacement text exists). */
  readonly downgraded: boolean;
}

export interface SkippedCandidate {
  readonly chunkId: string;
  readonly currentPath: string;
  readonly reason: PromoteSkipReason;
  readonly detail?: string;
}

export interface PromoteResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly promoted: readonly PromotedCandidate[];
  readonly skipped: readonly SkippedCandidate[];
  /** MEMORY.md length after the run (chars). */
  readonly memoryChars: number;
}

export interface PromoteDeps {
  /** Live chunk lookup (the agent's MemoryStore); null when the id is gone. */
  readonly resolveChunk: (
    chunkId: string,
  ) => { readonly heading: string | null; readonly body: string } | null;
  /** Current MEMORY.md text; "" when the file does not exist. */
  readonly readMemory: () => Promise<string>;
  /** Jailed append onto MEMORY.md (clawcodeMemoryEdit mode=append). */
  readonly appendMemory: (content: string) => Promise<{ ok: boolean; error?: string }>;
  /** Hard cap for MEMORY.md (INJECTED_MEMORY_MAX_CHARS or the agent override). */
  readonly capChars: number;
  readonly now: () => Date;
}

function headingFor(c: VetoStorePromotion, live: { heading: string | null } | null): string {
  const h = (live?.heading ?? c.heading ?? "").trim();
  if (h.length > 0) return h;
  const base = c.currentPath.split("/").pop() ?? c.currentPath;
  return base.replace(/\.md$/i, "");
}

/** Render one promoted section. Exported for the tests and the report. */
export function renderPromotedSection(
  heading: string,
  body: string,
  meta: { readonly currentPath: string; readonly runId: string; readonly date: string },
): string {
  return (
    `\n\n## ${heading}\n\n${body.trim()}\n\n` +
    `_Promoted by the dream pass from ${meta.currentPath} (run ${meta.runId}, ${meta.date})._\n`
  );
}

export async function promoteCandidates(row: VetoStoreRow, deps: PromoteDeps): Promise<PromoteResult> {
  const promoted: PromotedCandidate[] = [];
  const skipped: SkippedCandidate[] = [];
  let memory = await deps.readMemory();
  const date = deps.now().toISOString().slice(0, 10);

  for (const c of row.candidates) {
    let live: { heading: string | null; body: string } | null = null;
    try {
      live = deps.resolveChunk(c.chunkId);
    } catch {
      live = null;
    }
    const body = (live?.body ?? c.body ?? "").trim();
    if (body.length === 0) {
      skipped.push({ chunkId: c.chunkId, currentPath: c.currentPath, reason: "chunk-missing" });
      continue;
    }
    if (memory.includes(body)) {
      skipped.push({ chunkId: c.chunkId, currentPath: c.currentPath, reason: "already-present" });
      continue;
    }
    const heading = headingFor(c, live);
    const section = renderPromotedSection(heading, body, { currentPath: c.currentPath, runId: row.runId, date });
    if (memory.length + section.length > deps.capChars) {
      skipped.push({
        chunkId: c.chunkId,
        currentPath: c.currentPath,
        reason: "memory-at-cap",
        detail: `${memory.length + section.length} > ${deps.capChars} chars`,
      });
      continue;
    }
    const res = await deps.appendMemory(section);
    if (!res.ok) {
      skipped.push({ chunkId: c.chunkId, currentPath: c.currentPath, reason: "append-failed", detail: res.error });
      continue;
    }
    memory += section;
    promoted.push({
      chunkId: c.chunkId,
      currentPath: c.currentPath,
      heading,
      chars: section.length,
      downgraded: c.action === "edit" || c.action === "merge" || c.targetMode === "overwrite",
    });
  }

  const benign = skipped.every((s) => s.reason === "already-present");
  const ok = promoted.length > 0 || benign;
  const error = ok
    ? undefined
    : "nothing promoted: " +
      skipped.map((s) => `${s.reason}${s.detail ? ` (${s.detail})` : ""}`).join("; ");
  return Object.freeze({ ok, ...(error ? { error } : {}), promoted: Object.freeze(promoted), skipped: Object.freeze(skipped), memoryChars: memory.length });
}

/** One-line channel report after a run applies. */
export function formatPromoteReport(agent: string, runId: string, result: PromoteResult): string {
  const n = result.promoted.length;
  const parts: string[] = [];
  if (n > 0) {
    parts.push(`Dream pass promoted ${n} ${n === 1 ? "note" : "notes"} into MEMORY.md: ${result.promoted.map((p) => p.heading).join(", ")}`);
  } else {
    parts.push("Dream pass promoted nothing");
  }
  const counts = new Map<PromoteSkipReason, number>();
  for (const s of result.skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  const skips = [...counts.entries()].map(([r, k]) => `${k} ${r}`).join(", ");
  if (skips) parts.push(`skipped ${skips}`);
  const downgraded = result.promoted.filter((p) => p.downgraded).length;
  if (downgraded > 0) parts.push(`${downgraded} wanted an edit and were appended instead`);
  return `-# ${parts.join(" · ")} · run ${runId.slice(0, 8)} · ${agent}`;
}
