/**
 * Ledger card — the full per-claim verification record for one delivered
 * reply, rendered as a Components-v2 spec for the existing raw renderer
 * (`cv2-renderer.ts`: text + separator blocks only, ≤40 blocks, ≤4000 chars
 * per text block). Pure.
 *
 * Reached by the `🧾 Sources · N claims` button (ephemeral) and the 🧾
 * reaction (posted as a reply). Never triggers a model turn.
 */

import type { ClaimEntry } from "../manager/claim-ledger.js";
import type { EvidenceEntry } from "../manager/evidence-ledger.js";
import { sanitizeLabel } from "./sources-footer.js";
import type { Cv2Block, Cv2Spec } from "./cv2-renderer.js";
import type { RecallRecord } from "../manager/recall-footer.js";

/** customId prefix for the `🧾 Sources · N claims` button (router guard in slash-commands). */
export const VSRC_PREFIX = "vsrc:";

export const CARD_MAX_CLAIMS = 25;
export const CARD_MAX_SOURCES = 12;
export const CARD_TEXT_BLOCK_MAX = 1800;
export const CARD_ACCENT = Object.freeze({
  verified: 0x57f287,
  corrected: 0xfee75c,
  unverified: 0xed4245,
  none: 0x99aab5,
});

export interface LedgerCardInput {
  readonly agent: string;
  readonly promptExcerpt?: string;
  readonly at?: string; // HH:MM already formatted by the caller (no Date here)
  readonly claims: readonly ClaimEntry[];
  readonly evidence: readonly EvidenceEntry[];
  /** Phase 999.133 — memories/notes the pre-turn retrieval placed in context. */
  readonly recall?: RecallRecord;
}

export const CARD_MAX_RECALL = 10;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Number of recalled items (memories + notes + documents). */
export function recallCount(recall: RecallRecord | undefined): number {
  return recall ? recall.memories.length + recall.notes.length + recall.documents.length : 0;
}

/** "3 memories · 1 note" style summary for headers and labels. */
export function recallSummary(recall: RecallRecord): string {
  const parts: string[] = [];
  if (recall.memories.length) parts.push(plural(recall.memories.length, "memory", "memories"));
  if (recall.notes.length) parts.push(plural(recall.notes.length, "note", "notes"));
  if (recall.documents.length) parts.push(plural(recall.documents.length, "document", "documents"));
  return parts.join(" · ");
}

/**
 * Phase 999.133 — the 🧾 button label. Verification sources first, then the
 * recall count; recall alone reads `Sources · 🧠 5`. Discord caps labels at
 * 80 chars; this never exceeds ~24.
 */
export function sourcesButtonLabel(nSources: number, recall: RecallRecord | undefined): string {
  const r = recallCount(recall);
  if (nSources > 0 && r > 0) return `Sources · ${nSources} · ${r} recalled`;
  if (nSources > 0) return `Sources · ${nSources}`;
  return `Sources · ${r} recalled`;
}

function recallDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** The "Recalled from memory" lines (empty when nothing was recalled). */
export function recallLines(recall: RecallRecord | undefined): string[] {
  if (!recall || recallCount(recall) === 0) return [];
  const lines: string[] = [`**Recalled from memory** · ${recallSummary(recall)}`];
  let shown = 0;
  for (const m of recall.memories) {
    if (shown >= CARD_MAX_RECALL) break;
    const d = recallDate(m.createdAt);
    lines.push(`-# 🧠 ${d ? `${d} · ` : ""}${sanitizeLabel(m.snippet || m.id, 120)}`);
    shown += 1;
  }
  for (const n of [...recall.notes, ...recall.documents]) {
    if (shown >= CARD_MAX_RECALL) break;
    lines.push(`-# 📎 ${sanitizeLabel(n.path, 40)}${n.heading ? ` › ${sanitizeLabel(n.heading, 60)}` : ""}`);
    shown += 1;
  }
  const total = recallCount(recall);
  if (total > shown) lines.push(`-# +${total - shown} more`);
  return lines;
}

function glyph(c: ClaimEntry): string {
  switch (c.effectiveVerdict) {
    case "verified": return "✓";
    case "corrected": return "✏️";
    case "not-a-claim": return "·";
    default: return "?";
  }
}

function sourceLabel(c: ClaimEntry): string {
  if (c.sourceStatus === "none") return "no source";
  const host = c.sourceHost ?? sanitizeLabel(c.source, 40);
  return c.sourceStatus === "not-consulted" ? `${host} (not opened this turn)` : host;
}

/** Split lines into text blocks under the per-block cap. */
function packBlocks(lines: readonly string[], max = CARD_TEXT_BLOCK_MAX): string[] {
  const blocks: string[] = [];
  let cur = "";
  for (const l of lines) {
    if (cur.length + l.length + 1 > max) {
      if (cur) blocks.push(cur);
      cur = l.slice(0, max);
    } else cur = cur ? `${cur}\n${l}` : l;
  }
  if (cur) blocks.push(cur);
  return blocks;
}

export function buildLedgerCardSpec(i: LedgerCardInput): Cv2Spec {
  const counted = i.claims.filter((c) => c.effectiveVerdict !== "not-a-claim");
  const verified = counted.filter((c) => c.effectiveVerdict === "verified").length;
  const corrected = counted.filter((c) => c.effectiveVerdict === "corrected").length;
  const unverified = counted.filter((c) => c.effectiveVerdict === "unverified").length;
  const accent =
    unverified > 0 ? CARD_ACCENT.unverified : corrected > 0 ? CARD_ACCENT.corrected : verified > 0 ? CARD_ACCENT.verified : CARD_ACCENT.none;

  // Phase 999.133 — a recall-only card (no verification this turn) is a
  // plain "Sources" card: header, what was recalled, nothing about claims.
  const recallOnly = counted.length === 0 && i.evidence.length === 0 && recallCount(i.recall) > 0;
  if (recallOnly) {
    const rHead: string[] = [`**Sources · ${sanitizeLabel(i.agent, 40)}**`];
    const rMeta: string[] = [];
    if (i.promptExcerpt) rMeta.push(`"${sanitizeLabel(i.promptExcerpt, 70)}"`);
    rMeta.push("no verification this turn");
    if (i.at) rMeta.push(i.at);
    rHead.push(`-# ${rMeta.join(" · ")}`);
    const rBlocks: Cv2Block[] = [];
    for (const b of packBlocks(rHead)) rBlocks.push({ type: "text", content: b });
    rBlocks.push({ type: "separator", divider: true, spacing: 1 });
    for (const b of packBlocks(recallLines(i.recall))) rBlocks.push({ type: "text", content: b });
    return { accentColor: CARD_ACCENT.none, blocks: rBlocks.slice(0, 40) };
  }

  const head: string[] = [`**Verification · ${sanitizeLabel(i.agent, 40)}**`];
  const meta: string[] = [];
  if (i.promptExcerpt) meta.push(`"${sanitizeLabel(i.promptExcerpt, 70)}"`);
  meta.push(`${counted.length} claim${counted.length === 1 ? "" : "s"}`);
  if (verified) meta.push(`${verified} verified`);
  if (corrected) meta.push(`${corrected} corrected`);
  if (unverified) meta.push(`${unverified} unverified`);
  if (i.at) meta.push(i.at);
  head.push(`-# ${meta.join(" · ")}`);

  const claimLines: string[] = [];
  for (const c of counted.slice(0, CARD_MAX_CLAIMS)) {
    const text = c.effectiveVerdict === "corrected" && c.correction
      ? `${sanitizeLabel(c.claim, 120)} → ${sanitizeLabel(c.correction, 120)}`
      : sanitizeLabel(c.claim, 120);
    claimLines.push(`${glyph(c)} **${text}**`);
    const q = c.quote ? ` · "${sanitizeLabel(c.quote, 140)}"` : "";
    const stale = c.origin === "hop" ? " · checked after posting" : "";
    claimLines.push(`-# ${sourceLabel(c)}${q}${stale}`);
  }
  if (counted.length > CARD_MAX_CLAIMS) claimLines.push(`-# +${counted.length - CARD_MAX_CLAIMS} more`);
  if (counted.length === 0) claimLines.push("-# No claims were recorded for this answer.");

  // 2026-08-27 sweep — this turn's sources only. Lookback evidence (previous
  // turn's pages, flagged stale) stays out unless a recorded claim names it;
  // the Sources line already applies the same rule.
  const claimBacked = new Set(counted.flatMap((c) => [c.source ?? "", c.sourceHost ?? ""]));
  const own = i.evidence.filter(
    (e) => e.stale !== true || claimBacked.has(e.url ?? "") || claimBacked.has(e.host ?? ""),
  );
  const read = own.filter((e) => e.kind === "read");
  const found = own.filter((e) => e.kind === "found");
  const crm = own.filter((e) => e.kind === "queried");
  const docs = own.filter((e) => e.kind === "document");
  const srcLines: string[] = ["**Sources consulted**"];
  const lab = (e: EvidenceEntry): string => {
    if (e.url && e.host) return `${e.host} › ${sanitizeLabel(e.title ?? e.url.split("/").filter(Boolean).pop() ?? e.host, 36)}${e.stale ? " (earlier)" : ""}`;
    if (e.file) return e.asOf ? `${sanitizeLabel(e.file, 40)} (as of ${e.asOf})` : sanitizeLabel(e.file, 40);
    return sanitizeLabel(e.table ?? "", 32);
  };
  if (read.length) srcLines.push(`-# 📖 read · ${read.slice(0, CARD_MAX_SOURCES).map(lab).join(" · ")}${read.length > CARD_MAX_SOURCES ? ` · +${read.length - CARD_MAX_SOURCES} more` : ""}`);
  if (found.length) {
    const queries = [...new Set(found.map((e) => e.query).filter((q): q is string => !!q))].slice(0, 3);
    srcLines.push(`-# 🔎 found · ${queries.length ? queries.map((q) => `"${sanitizeLabel(q, 50)}"`).join(" · ") + ` (${found.length} results)` : `${found.length} results`}`);
  }
  if (crm.length) srcLines.push(`-# 🗂️ CRM · ${[...new Set(crm.map(lab))].slice(0, CARD_MAX_SOURCES).join(" · ")}`);
  if (docs.length) srcLines.push(`-# 📄 document · ${docs.slice(0, CARD_MAX_SOURCES).map(lab).join(" · ")}`);
  if (own.length === 0) srcLines.push("-# No sources were consulted for this answer.");

  const blocks: Cv2Block[] = [];
  for (const b of packBlocks(head)) blocks.push({ type: "text", content: b });
  blocks.push({ type: "separator", divider: true, spacing: 1 });
  for (const b of packBlocks(claimLines)) blocks.push({ type: "text", content: b });
  blocks.push({ type: "separator", divider: true, spacing: 1 });
  for (const b of packBlocks(srcLines)) blocks.push({ type: "text", content: b });
  // Phase 999.133 — recalled memory rides the same card, last section.
  const rLines = recallLines(i.recall);
  if (rLines.length > 0) {
    blocks.push({ type: "separator", divider: true, spacing: 1 });
    for (const b of packBlocks(rLines)) blocks.push({ type: "text", content: b });
  }
  return { accentColor: accent, blocks: blocks.slice(0, 40) };
}

/** Plain-text fallback (ephemeral reply when the CV2 flag combo is rejected). */
export function buildLedgerPlainText(i: LedgerCardInput): string {
  const spec = buildLedgerCardSpec(i);
  return spec.blocks
    .map((b) => (b.type === "text" ? b.content : "────────"))
    .join("\n")
    .slice(0, 1900);
}
