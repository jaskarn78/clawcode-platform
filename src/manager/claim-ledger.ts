/**
 * Claim ledger — per-turn record of the claims the model VERIFIED, as
 * recorded through the `verify_claim` tool, validated by the daemon against
 * the evidence ledger.
 *
 * THE RULE THAT MAKES THIS TRUSTWORTHY: a claim can only be "verified" or
 * "corrected" against a source the turn actually consulted (present in the
 * evidence ledger). The model cannot launder a claim by naming a page it never
 * opened — the daemon downgrades it to `unverified` with `sourceStatus:
 * "not-consulted"`, and tells the model so, which makes fetching the page the
 * cheapest path to a ✓.
 *
 * Pure: no I/O, no Date, no global state. Every text field is sanitized and
 * capped here, once, so downstream renderers can trust the shape.
 */

import { normalizeHost, normalizeUrl, tierForHost, type EvidenceEntry, type EvidenceTier } from "./evidence-ledger.js";

export type ClaimVerdict = "verified" | "corrected" | "unverified" | "not-a-claim";
export type ClaimClass = "figure" | "rule" | "product-term";
export type ClaimAudience = "internal" | "client";
export type ClaimSourceStatus = "in-ledger" | "not-consulted" | "none";
export type ClaimQuoteStatus = "verbatim" | "not-found" | "none";
export type ClaimOrigin = "tool" | "hop";

export const CLAIM_TEXT_MAX_CHARS = 300;
export const CLAIM_SOURCE_MAX_CHARS = 512;
export const CLAIM_QUOTE_MAX_CHARS = 300;
export const CLAIMS_MAX_PER_TURN = 40;

/** What the tool / hop supplies. */
export interface VerifyClaimParams {
  readonly claim: string;
  readonly verdict: ClaimVerdict;
  readonly source?: string;
  readonly quote?: string;
  readonly correction?: string;
  readonly class?: ClaimClass;
  readonly audience?: ClaimAudience;
  readonly origin?: ClaimOrigin;
}

export interface ClaimEntry {
  readonly id: string;
  readonly turnId: string;
  readonly claim: string;
  readonly class?: ClaimClass;
  readonly audience?: ClaimAudience;
  /** As asserted by the model / hop. */
  readonly verdict: ClaimVerdict;
  /** Daemon-adjusted: the verdict that counts. */
  readonly effectiveVerdict: ClaimVerdict;
  readonly source?: string;
  readonly sourceHost?: string;
  readonly sourceStatus: ClaimSourceStatus;
  readonly sourceTier?: EvidenceTier;
  readonly quote?: string;
  readonly quoteStatus: ClaimQuoteStatus;
  readonly correction?: string;
  readonly origin: ClaimOrigin;
  readonly at: number;
  /** True when the source is in the evidence ledger (renderers gate on this). */
  readonly ledgerBacked: boolean;
}

export interface ValidateClaimOptions {
  /** Rules-class claims need a primary or client-tier source (default true). */
  readonly requirePrimaryForRules?: boolean;
  /** Treat `found` (search hit, never opened) as a consulted source (default false). */
  readonly countFoundAsRead?: boolean;
  /** Extra primary hosts. */
  readonly primaryHosts?: readonly string[];
}

const VERDICTS: readonly ClaimVerdict[] = ["verified", "corrected", "unverified", "not-a-claim"];
const CLASSES: readonly ClaimClass[] = ["figure", "rule", "product-term"];
const AUDIENCES: readonly ClaimAudience[] = ["internal", "client"];

/** Strip control chars / newlines, collapse whitespace, cap. */
export function sanitizeClaimText(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function isClaimVerdict(v: unknown): v is ClaimVerdict {
  return typeof v === "string" && (VERDICTS as readonly string[]).includes(v);
}
export function isClaimClass(v: unknown): v is ClaimClass {
  return typeof v === "string" && (CLASSES as readonly string[]).includes(v);
}
export function isClaimAudience(v: unknown): v is ClaimAudience {
  return typeof v === "string" && (AUDIENCES as readonly string[]).includes(v);
}

/**
 * Where a model-supplied `source` string lands in the evidence ledger.
 *   - exact normalized URL against ANY evidence entry;
 *   - host-level match only against consulted kinds (read/document/queried),
 *     or against `found` when `countFoundAsRead`;
 *   - `table:<name>` / bare table name against queried entries;
 *   - a document basename against document entries.
 */
export function matchSource(
  source: string,
  evidence: readonly EvidenceEntry[],
  opts?: ValidateClaimOptions,
): { status: ClaimSourceStatus; host?: string; tier?: EvidenceTier; normalized?: string } {
  const s = source.trim();
  if (s.length === 0) return { status: "none" };

  const consultedKinds = new Set<EvidenceEntry["kind"]>(["read", "document", "queried"]);
  if (opts?.countFoundAsRead) consultedKinds.add("found");

  const url = normalizeUrl(s);
  if (url) {
    const exact = evidence.find((e) => e.url === url.url);
    if (exact) return { status: "in-ledger", host: url.host, tier: exact.tier, normalized: url.url };
    const byHost = evidence.find((e) => e.host === url.host && consultedKinds.has(e.kind));
    if (byHost) return { status: "in-ledger", host: url.host, tier: byHost.tier, normalized: url.url };
    return { status: "not-consulted", host: url.host, tier: tierForHost(url.host, opts), normalized: url.url };
  }

  const table = /^table:\s*([A-Za-z0-9_.]{1,64})$/i.exec(s)?.[1]?.toLowerCase();
  const bareTable = table ?? (/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(s) ? s.toLowerCase() : undefined);
  if (bareTable) {
    const q = evidence.find((e) => e.kind === "queried" && e.table === bareTable);
    if (q) return { status: "in-ledger", tier: "client", normalized: `table:${bareTable}` };
  }

  const base = s.split(/[\\/]/).pop() ?? s;
  const doc = evidence.find((e) => e.kind === "document" && e.file?.toLowerCase() === base.toLowerCase());
  if (doc) return { status: "in-ledger", tier: "client", normalized: base };

  const host = normalizeHost(s);
  if (host) {
    const byHost = evidence.find((e) => e.host === host && consultedKinds.has(e.kind));
    if (byHost) return { status: "in-ledger", host, tier: byHost.tier, normalized: host };
    return { status: "not-consulted", host, tier: tierForHost(host, opts), normalized: host };
  }
  return { status: "not-consulted", normalized: base.slice(0, CLAIM_SOURCE_MAX_CHARS) };
}

/** Soft check: is the quote verbatim (whitespace-collapsed) in this turn's tool text? */
export function quoteStatusFor(quote: string | undefined, toolResultText: string): ClaimQuoteStatus {
  if (!quote) return "none";
  if (toolResultText.length === 0) return "not-found";
  const hay = toolResultText.replace(/\s+/g, " ").toLowerCase();
  return hay.includes(quote.replace(/\s+/g, " ").toLowerCase()) ? "verbatim" : "not-found";
}

/**
 * Validate a claim against the evidence. Returns everything except the
 * identity fields (`id`, `turnId`, `at`) the caller assigns.
 */
export function validateClaim(
  params: VerifyClaimParams,
  evidence: readonly EvidenceEntry[],
  toolResultText: string,
  opts?: ValidateClaimOptions,
): Omit<ClaimEntry, "id" | "turnId" | "at"> {
  const claim = sanitizeClaimText(params.claim, CLAIM_TEXT_MAX_CHARS);
  const verdict: ClaimVerdict = isClaimVerdict(params.verdict) ? params.verdict : "unverified";
  const cls = isClaimClass(params.class) ? params.class : undefined;
  const audience = isClaimAudience(params.audience) ? params.audience : undefined;
  const quote = sanitizeClaimText(params.quote, CLAIM_QUOTE_MAX_CHARS) || undefined;
  const correction = sanitizeClaimText(params.correction, CLAIM_TEXT_MAX_CHARS) || undefined;
  const sourceRaw = sanitizeClaimText(params.source, CLAIM_SOURCE_MAX_CHARS);
  const origin: ClaimOrigin = params.origin === "hop" ? "hop" : "tool";

  const match = matchSource(sourceRaw, evidence, opts);
  const requirePrimary = opts?.requirePrimaryForRules ?? true;

  let effective: ClaimVerdict = verdict;
  if (verdict === "verified" || verdict === "corrected") {
    if (match.status !== "in-ledger") effective = "unverified";
    else if (cls === "rule" && requirePrimary && match.tier === "secondary") effective = "unverified";
  }

  const ledgerBacked = match.status === "in-ledger";
  return {
    claim,
    ...(cls ? { class: cls } : {}),
    ...(audience ? { audience } : {}),
    verdict,
    effectiveVerdict: effective,
    ...(match.normalized ? { source: match.normalized } : {}),
    ...(match.host ? { sourceHost: match.host } : {}),
    sourceStatus: match.status,
    ...(match.tier ? { sourceTier: match.tier } : {}),
    ...(quote ? { quote } : {}),
    quoteStatus: quoteStatusFor(quote, toolResultText),
    ...(correction ? { correction } : {}),
    origin,
    ledgerBacked,
  };
}

/**
 * The hint the tool returns to the model when a claim was downgraded — the
 * feedback loop that makes laundering pointless and fetching cheap.
 */
export function hintFor(
  entry: Omit<ClaimEntry, "id" | "turnId" | "at">,
  evidence: readonly EvidenceEntry[],
): string | undefined {
  if (entry.effectiveVerdict === entry.verdict) return undefined;
  const consulted = [...new Set(evidence.filter((e) => e.kind !== "found").map((e) => e.host ?? e.file ?? e.table).filter(Boolean))].slice(0, 4);
  const where = consulted.length > 0 ? ` Sources you did open this turn: ${consulted.join(", ")}.` : "";
  if (entry.sourceStatus === "none") return `No source given; a claim without a consulted source is recorded as unverified.${where}`;
  if (entry.sourceStatus === "not-consulted") {
    const what = entry.sourceHost ?? entry.source ?? "that source";
    return `${what} was not opened this turn, so the claim is recorded as unverified. WebFetch it (or cite a page you did open) and record again.${where}`;
  }
  if (entry.class === "rule" && entry.sourceTier === "secondary") {
    return `${entry.sourceHost ?? "that source"} is not a primary source; a rule/eligibility claim needs irs.gov, dol.gov, ssa.gov, ecfr.gov or the client's own documents.${where}`;
  }
  return undefined;
}
