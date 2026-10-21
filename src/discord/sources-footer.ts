/**
 * Sources footer + verdict marks — the DAEMON-authored verification
 * annotations under a delivered reply. Pure: no discord.js, no Date.
 *
 * Design rules (2026-08-27 verification v2):
 *   - One annotation family: `-#` subtext lines + exactly one verdict reaction.
 *   - Every line is NEWLINE-LED (`\n\n-# ` first, `\n-# ` after) so it survives
 *     `planChunkEdits` and can be stripped by a line-prefix rule.
 *   - FORMAT-STABLE: no em/en dashes, no `|`, no backticks. Exit C edits raw
 *     text while exit B passes `formatOutboundText` → the bytes must be
 *     identical either way. Separator is ` · `.
 *   - Sources come from the EVIDENCE ledger (what tools returned), never from
 *     the model's prose. Search hits nobody opened are not sources.
 */

import { formatDuration } from "./duration-format.js";
import { icons } from "./icons.js";
import type { ClaimEntry } from "../manager/claim-ledger.js";
import type { EvidenceEntry } from "../manager/evidence-ledger.js";

export const SUBTEXT_BLOCK = "\n\n-# ";
export const SUBTEXT_LINE = "\n-# ";
export const SOURCES_PREFIX = "Sources: ";
export const DEFAULT_SOURCES_CHAR_BUDGET = 480;
export const DEFAULT_COMPACT_CHAR_BUDGET = 200;
export const DEFAULT_SOURCES_MAX_LINKS = 3;
export const DEFAULT_SOURCES_MAX_ENTRIES = 5;
export const DEFAULT_COMPACT_BELOW_CHARS = 300;
/** Cap so a footer can never push a ≤2000-char reply into the chunked path. */
export const DISCORD_MESSAGE_MAX = 2000;

export type DeliveryTier = "none" | "compact" | "full" | "client-facing";
export type VerdictReaction = "✅" | "✏️" | "⚠️";

/**
 * Label text for a source: strips markdown breakers and mentions, keeps `_`
 * (a URL path segment often has them — `sanitizeEcho` would drop it).
 */
export function sanitizeLabel(raw: unknown, max = 28): string {
  if (typeof raw !== "string") return "";
  const cleaned = raw
    .replace(/[@`*|>\\[\]()—–]/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tidy = (t: string): string => t.replace(/[\s,;:.\-–—·]+$/u, "").trim();
  if (cleaned.length <= max) return tidy(cleaned);
  // 2026-08-27 — clip at a WORD boundary. A hard slice produced
  // "irs.gov › retirement plan and ira requ", which reads like a typo rather
  // than a truncation. Fall back to the hard cut only when the first word is
  // itself longer than the budget. 2026-08-28 — and never end on punctuation
  // ("SpaceX Stock: IPO Date," shipped with a dangling comma).
  const cut = cleaned.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return tidy(sp >= Math.floor(max * 0.5) ? cut.slice(0, sp) : cut);
}

/** Percent-encode the characters that would break a masked link. */
export function encodeLinkUrl(url: string): string {
  // encodeURIComponent leaves ( ) alone; Discord's masked-link parser does not.
  const map: Record<string, string> = { "(": "%28", ")": "%29", ">": "%3E", "<": "%3C", "|": "%7C" };
  return url.replace(/[()<>|\s]/g, (c) => map[c] ?? encodeURIComponent(c));
}

/** `[irs.gov › RMD FAQs](<https://…>)` — embeds suppressed by the `<>`. */
export function maskedLink(label: string, url: string): string {
  return `[${label}](<${encodeLinkUrl(url)}>)`;
}

function lastPathSegment(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean).pop() ?? "";
    return seg.replace(/[-_]+/g, " ").replace(/\.[a-z0-9]{2,5}$/i, "");
  } catch {
    return "";
  }
}

export interface SourceItem {
  readonly key: string;
  readonly label: string;
  readonly url?: string;
  readonly host?: string;
  readonly rank: number; // lower = earlier
  readonly stale?: boolean;
  /** 2026-08-28 — when the source was consulted (queried groups render `<t:…:t>`). */
  readonly at?: number;
}

/**
 * Select and order sources from the ledgers:
 *   read/document/queried first (opened), then FOUND entries that a verified
 *   claim rests on or that the draft cites; other search hits are excluded.
 */
export function selectSources(
  evidence: readonly EvidenceEntry[],
  claims: readonly ClaimEntry[],
  citedHosts: readonly string[] = [],
): SourceItem[] {
  const claimSources = new Set(claims.filter((c) => c.ledgerBacked).map((c) => c.source ?? c.sourceHost ?? ""));
  const claimHosts = new Set(claims.filter((c) => c.ledgerBacked).map((c) => c.sourceHost ?? ""));
  const cited = new Set(citedHosts);
  const items: SourceItem[] = [];
  const seen = new Set<string>();
  // 2026-08-27 — THIS TURN ONLY. `getActiveTurnEvidence` unions the live turn
  // with a 30-minute lookback of the previous turn's opened sources (flagged
  // `stale`) so a follow-up like "and for Roth?" isn't scored as unsourced by
  // the GATE. That carry-over must never reach the Sources line: an unrelated
  // question ("how many SpaceX shares do I have?") inherited the previous
  // turn's 19 IRS pages and shipped `Sources: irs.gov › RMD FAQs · +18 more`,
  // which is worse than no footer — it attributes an answer to pages that had
  // nothing to do with it. A claim-backed stale entry still counts, because a
  // recorded claim naming it is this turn's own assertion.
  const claimBacked = new Set(
    claims.filter((c) => c.ledgerBacked).flatMap((c) => [c.source ?? "", c.sourceHost ?? ""]),
  );
  const fresh = evidence.filter(
    (e) => e.stale !== true || claimBacked.has(e.url ?? "") || claimBacked.has(e.host ?? ""),
  );
  for (const e of fresh) {
    let key: string;
    let label: string;
    let rank: number;
    if (e.kind === "read" && e.url) {
      key = `u:${e.url}`;
      const seg = e.title ? sanitizeLabel(e.title) : sanitizeLabel(lastPathSegment(e.url));
      label = seg ? `${e.host} › ${seg}` : (e.host ?? e.url);
      rank = 0;
    } else if (e.kind === "document" && e.file) {
      key = `f:${e.file.toLowerCase()}`;
      label = e.asOf ? `${sanitizeLabel(e.file, 40)} (${e.asOf})` : sanitizeLabel(e.file, 40);
      rank = 1;
    } else if (e.kind === "queried" && e.table) {
      key = `t:${e.table}`;
      // A data API (finnhub etc.) carries its host; the CRM does not.
      label = e.host ? `${e.host} › ${sanitizeLabel(e.title ?? e.table, 32)}` : `CRM › ${sanitizeLabel(e.table, 32)}`;
      rank = 2;
    } else if (e.kind === "found" && e.url && e.host) {
      const backed = claimSources.has(e.url) || claimHosts.has(e.host) || cited.has(e.host);
      if (!backed) continue;
      key = `u:${e.url}`;
      const seg = e.title ? sanitizeLabel(e.title) : sanitizeLabel(lastPathSegment(e.url));
      label = seg ? `${e.host} › ${seg}` : e.host;
      rank = 3;
    } else continue;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      key,
      label,
      ...(e.url ? { url: e.url } : {}),
      ...(e.host ? { host: e.host } : {}),
      rank,
      ...(e.stale ? { stale: true } : {}),
      ...(typeof e.at === "number" && e.at > 0 ? { at: e.at } : {}),
    });
  }
  return collapseQueriedByHost(items).sort((a, b) => a.rank - b.rank);
}

/**
 * 2026-08-28 — ten finnhub quotes rendered as ten `finnhub.io › RKLB stock
 * quote · finnhub.io › ASTS stock quote · …` entries. Queried entries on one
 * host collapse to `finnhub.io › 10 stock quotes` (noun from the titles'
 * shared tail after the symbol; "lookups" when they differ).
 *
 * 999.151 — the threshold is TWO, not three. The operator's screenshot showed
 * `finnhub.io › SPCX stock candles · finnhub.io › SPCX stock quote`: one host
 * printed twice, which is exactly the repetition this collapse exists to
 * remove. A shared leading symbol survives the collapse (`2 SPCX lookups`) —
 * it is the most informative word in the label.
 */
export function collapseQueriedByHost(items: readonly SourceItem[]): SourceItem[] {
  const byHost = new Map<string, SourceItem[]>();
  for (const it of items) {
    if (it.rank !== 2 || !it.host || !it.key.startsWith("t:")) continue;
    byHost.set(it.host, [...(byHost.get(it.host) ?? []), it]);
  }
  const out: SourceItem[] = [];
  const collapsed = new Set<string>();
  for (const it of items) {
    const group = it.host ? byHost.get(it.host) : undefined;
    if (!group || group.length < 2 || it.rank !== 2 || !it.key.startsWith("t:")) {
      out.push(it);
      continue;
    }
    if (collapsed.has(it.host!)) continue;
    collapsed.add(it.host!);
    const titles = group.map((g) => g.label.split(" › ")[1] ?? "");
    const tails = titles.map((t) => t.split(" ").slice(1).join(" ").trim());
    const shared = tails.every((t) => t.length > 0 && t === tails[0]) ? tails[0]! : "lookup";
    const noun = shared.endsWith("s") ? shared : `${shared}s`;
    // The leading token is the symbol / entity the lookups were ABOUT; keep it
    // when every entry agrees, drop it when they do not.
    const heads = titles.map((t) => t.split(" ")[0] ?? "");
    const symbol =
      heads.every((h) => h.length > 0 && h === heads[0]) ? `${heads[0]!} ` : "";
    const at = Math.max(0, ...group.map((g) => g.at ?? 0));
    out.push({ key: `g:${it.host}`, label: `${it.host} › ${group.length} ${symbol}${noun}`, host: it.host!, rank: 2, ...(at > 0 ? { at } : {}) });
  }
  return out;
}

export interface SourcesLineOptions {
  readonly budget?: number;
  readonly maxLinks?: number;
  readonly maxEntries?: number;
  /** Compact = one link max, verdict glyph in front. */
  readonly compact?: boolean;
  readonly compactVerified?: boolean;
  /** 2026-08-28 — override the `Sources: ` head ("" for the merged footer line). */
  readonly head?: string;
}

/** Render the Sources line (without its newline lead). "" when nothing to say. */
export function buildSourcesLine(items: readonly SourceItem[], opts: SourcesLineOptions = {}): string {
  if (items.length === 0) return "";
  const budget = opts.budget ?? (opts.compact ? DEFAULT_COMPACT_CHAR_BUDGET : DEFAULT_SOURCES_CHAR_BUDGET);
  const maxLinks = opts.compact ? 1 : (opts.maxLinks ?? DEFAULT_SOURCES_MAX_LINKS);
  const maxEntries = opts.compact ? 1 : (opts.maxEntries ?? DEFAULT_SOURCES_MAX_ENTRIES);
  const head = opts.head ?? (opts.compact ? (opts.compactVerified ? "✓ verified · " : SOURCES_PREFIX) : SOURCES_PREFIX);

  const render = (useLinks: number, entries: number, collapse: boolean): string => {
    let list = items.slice(0, entries);
    if (collapse) {
      const byHost = new Map<string, SourceItem[]>();
      for (const it of items) {
        const k = it.host ?? it.key;
        byHost.set(k, [...(byHost.get(k) ?? []), it]);
      }
      list = [...byHost.entries()].map(([host, group]) =>
        group.length > 1 ? { ...group[0]!, label: `${host} (${group.length})`, url: undefined } : group[0]!,
      ).slice(0, entries);
    }
    // 2026-08-28 — a queried group ("finnhub.io › 9 live quotes") carries the
    // time the quotes were pulled as a Discord timestamp (renders in the
    // reader's local time), so "as of 11:41" comes from the daemon, not the model.
    const parts = list.map((it, i) =>
      it.url && i < useLinks
        ? maskedLink(it.label, it.url)
        : it.label +
          (it.stale ? " (earlier)" : "") +
          (it.key.startsWith("g:") && it.at ? ` · <t:${Math.floor(it.at / 1000)}:t>` : ""),
    );
    const more = items.length - list.length;
    return head + parts.join(" · ") + (more > 0 ? ` · +${more} more` : "");
  };
  // Degrade: links → labels → per-host collapse → fewer entries.
  const attempts: [number, number, boolean][] = [
    [maxLinks, maxEntries, false],
    // 2026-08-27 sweep — the ladder used to jump from [3 links, 5 entries]
    // straight to [0 links, 5 entries]; three realistic IRS URLs (~190 chars
    // each masked) blew the 480 budget and EVERY link went untappable on
    // multi-source turns. Shed entries before shedding links: the operator
    // chose "host › title, tappable" and one tappable link beats five labels.
    [maxLinks, 3, false],
    [2, 3, false],
    [1, 3, false],
    [1, 2, false],
    [0, maxEntries, false],
    [0, maxEntries, true],
    [0, Math.max(1, Math.floor(maxEntries / 2)), true],
    [0, 1, true],
  ];
  for (const [l, e, c] of attempts) {
    const out = render(l, e, c);
    if (out.length <= budget) return out;
  }
  return "";
}

export interface TierInputs {
  readonly responseChars: number;
  readonly claimCount: number;
  readonly evidenceCount: number;
  readonly clientFacing: boolean;
  readonly compactBelowChars?: number;
}

export function decideTier(i: TierInputs): DeliveryTier {
  if (i.clientFacing) return "client-facing";
  if (i.claimCount === 0 && i.evidenceCount === 0) return "none";
  const compactBelow = i.compactBelowChars ?? DEFAULT_COMPACT_BELOW_CHARS;
  // 2026-08-27 sweep — `claimCount <= 1` alone forced compact on every long,
  // well-sourced answer (and on EVERY reply while the fork bug held claims at
  // 0), which is how a 1,900-char reply shipped "Sources: irs.gov › … · +18
  // more". Compact means a short answer with little evidence, nothing else.
  if (i.responseChars <= compactBelow && i.evidenceCount <= 2) return "compact";
  return "full";
}

export interface VerdictInputs {
  readonly claims: readonly ClaimEntry[];
  readonly unmatchedHosts: readonly string[];
  readonly correctionsApplied: number;
  readonly holdTimedOut: boolean;
  readonly evidenceCount: number;
}

export interface VerdictMarks {
  readonly reaction: VerdictReaction | null;
  readonly lines: string[];
  /**
   * 999.151 — the same exception in plain words, with no glyph and no
   * "react X to Y" instruction, for the MERGED footer line. `lines` stays
   * for the legacy (pre-merge) Sources-line path and for callers that
   * render the exception on its own row.
   */
  readonly note: string;
}

/**
 * Precedence: ⚠️ (anything unverified / timed out / cited-but-never-opened)
 * → ✏️ (a correction happened) → ✅ (≥1 claim and all verified) → none.
 */
export function decideVerdictMarks(v: VerdictInputs): VerdictMarks {
  const unverified = v.claims.filter((c) => c.effectiveVerdict === "unverified");
  const counted = v.claims.filter((c) => c.effectiveVerdict !== "not-a-claim");
  // 2026-08-27 — ONE line, at most. Stacked per-claim warnings under an answer
  // read as noise (operator: "alert icons with a bunch of subtext"); the ⚠️
  // reaction marks the message and the 🧾 card carries the detail. Priority:
  // timeout > unverified claims > cited-but-unopened hosts > unsourced claims.
  const lines: string[] = [];
  let note = "";
  const n = (k: number, w: string): string => `${k} ${w}${k === 1 ? "" : "s"}`;
  // 999.178 R1 — the visible warning glyph renders through the `cc_*` set
  // (`icons.prefix` degrades to plain text when the set is not loaded, never
  // to a Unicode glyph). The `reaction` token below stays "⚠️": it is an
  // internal VerdictReaction value that drives logic and is mapped to a
  // `cc_*` reaction only at the point the bridge calls react. The "react 🔍"
  // instruction is a HUMAN-clicked reaction and stays as-is (a Discord user
  // cannot react with another app's emoji).
  const warn = (text: string): string => icons.prefix("warning", text);
  if (v.holdTimedOut) {
    note = "Still verifying · sent before the check finished";
    lines.push(warn("still verifying · sent before the check finished"));
  } else if (unverified.length > 0) {
    note = `${n(unverified.length, "claim")} unverified`;
    lines.push(warn(`${n(unverified.length, "claim")} unverified · react 🔍 to re-check`));
  } else if (v.unmatchedHosts.length > 0) {
    const shown = v.unmatchedHosts.slice(0, 2).map((h) => sanitizeLabel(h, 32)).join(", ");
    const more = v.unmatchedHosts.length > 2 ? ` +${v.unmatchedHosts.length - 2}` : "";
    note = `Cited, not opened: ${shown}${more}`;
    lines.push(warn(`cited, not opened: ${shown}${more}`));
  } else if (counted.length > 0 && v.evidenceCount === 0) {
    note = `${n(counted.length, "claim")} without a consulted source`;
    lines.push(warn(`${n(counted.length, "claim")} without a consulted source · react 🔍 to verify`));
  }
  if (lines.length > 0) return { reaction: "⚠️", lines, note };
  if (v.correctionsApplied > 0 || counted.some((c) => c.effectiveVerdict === "corrected")) {
    return { reaction: "✏️", lines: [], note: "" };
  }
  if (counted.length > 0 && counted.every((c) => c.effectiveVerdict === "verified")) {
    return { reaction: "✅", lines: [], note: "" };
  }
  return { reaction: null, lines: [], note: "" };
}

/**
 * Strip the model's own trailing `Sources:` block (last 30% of the draft,
 * ≤8 lines) and return the hosts it named. Inline parenthetical citations in
 * the body are untouched.
 */
export function stripModelSourcesBlock(text: string): { text: string; citedHosts: string[] } {
  const lines = text.split("\n");
  // 2026-08-28 — the model writes the line as subtext (`-# Sources: …`) or
  // italic (`*Sources: …*`) as often as bare; all are the same block.
  const isLabel = (l: string): boolean =>
    /^\s*(?:-#\s*)?(?:[-*]\s*)?(?:\*\*|__|\*|_)?\s*(?:sources?|references?|citations?)\s*:?\s*(?:\*\*|__|\*|_)?\s*(?::.*)?$/i.test(l) ||
    /^\s*(?:-#\s*)?(?:\*\*|__|\*|_)?\s*sources?\s*:\s*(?:\*\*|__|\*|_)?\s*\S/i.test(l);
  // 2026-08-28 — ANYWHERE outside a fence, not just the trailing 30 %: a
  // block written above a ```draft fence sat mid-reply and survived. The
  // block is the label line plus the run of non-blank lines after it (≤ 8).
  // Candidates: every label line outside a fence, latest first. A candidate
  // is a citation block only if it is BOUNDED (the run of non-blank lines
  // after it ends within 8 lines, at a blank line, a fence, or the end) and
  // it names at least one host — "Sources: intro" heading a 20-line body is
  // prose and stays.
  const labels: number[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i]!)) { inFence = !inFence; continue; }
    if (!inFence && isLabel(lines[i]!)) labels.push(i);
  }
  const hostsIn = (block: string): Set<string> => {
    const hosts = new Set<string>();
    const re = /https?:\/\/(?:www\.)?([a-z0-9.-]+\.[a-z]{2,})/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block)) !== null) hosts.add(m[1]!.toLowerCase());
    const bare = /\b((?:[a-z0-9-]+\.)+(?:gov|org|com|net|edu|io))\b/gi;
    while ((m = bare.exec(block)) !== null) hosts.add(m[1]!.toLowerCase().replace(/^www\./, ""));
    return hosts;
  };
  for (const idx of labels.reverse()) {
    let end = idx + 1;
    while (end < lines.length && lines[end]!.trim().length > 0 && !/^\s*```/.test(lines[end]!)) {
      end++;
      if (end - idx > 8) break;
    }
    if (end - idx > 8) continue; // unbounded → prose, not a citation block
    const hosts = hostsIn(lines.slice(idx, end).join("\n"));
    // 2026-08-28 — a one/two-line block is a citation line even without a
    // host: "Sources: finnhub live quotes 11:01 AM PT · your screenshot" named
    // no TLD and shipped twice (model line + channel line). Longer host-less
    // blocks are still treated as prose.
    if (hosts.size === 0 && end - idx > 2) continue;
    const kept = [...lines.slice(0, idx), ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
    return { text: kept, citedHosts: [...hosts] };
  }
  return { text, citedHosts: [] };
}

export interface AnnotationInputs {
  readonly response: string;
  readonly tier: DeliveryTier;
  readonly sources: readonly SourceItem[];
  readonly marks: VerdictMarks;
  readonly clientFacingSummary?: string;
  readonly sourcesCharBudget?: number;
  /**
   * 2026-08-28 — when present, the footer is ONE merged line
   * (`Verified 3 claims · irs.gov › RMD FAQs · 36s`) instead of a
   * `Sources:` line, and the separate status message is deleted by the caller.
   */
  readonly verification?: VerificationStats;
  /**
   * 999.151 — the advisor fact, as a FIELD. It used to be glued onto the
   * response as italic prose before this function ever saw it
   * (`bridge.ts` advisor footer), which guaranteed two footers in two
   * typographic registers. Travelling as data, it merges into the one line
   * — or becomes the only line when there is no verification to report.
   */
  readonly advisor?: string;
}

/** What the reader is told about the turn's checking, in one line. */
export interface VerificationStats {
  /** Claims recorded (excluding not-a-claim). */
  readonly counted: number;
  /** Claims whose effective verdict is verified or corrected. */
  readonly verified: number;
  /** Tool calls seen while working. */
  readonly steps: number;
  /** Wall-clock seconds from first tool event (or turn start) to delivery. */
  readonly secs: number;
  /** Client-facing tier with every claim verified → ✅ head. */
  readonly clientFacing?: boolean;
}

/**
 * The merged footer line — ONE grey row under the answer.
 *
 * 2026-08-28 folded the status message into the answer. 999.151 (2026-09-17)
 * took the glyphs out: a reply that stacked an italic advisor footer, a ⚠️
 * row, a 🔎 row and a button read as noise ("I don't like all the icons
 * everywhere — think Apple or Google"). What survives is typographic, not
 * decorative: sentence-case words, ` · ` between facts, and exactly one row.
 *
 * Order = importance. An exception (`note`) takes the head — it is the thing
 * the reader must not miss, and the ⚠️ REACTION on the message already
 * carries the alarm, so the line does not repeat it or print a "react 🔍 to
 * re-check" instruction. Otherwise the outcome heads. Then the sources, then
 * the advisor mark, then a readable duration. Stays within `budget`.
 */
export function buildVerificationLine(
  stats: VerificationStats,
  sources: readonly SourceItem[],
  opts: {
    readonly tier: DeliveryTier;
    readonly budget?: number;
    /** Plain-language exception from `decideVerdictMarks` (takes the head). */
    readonly note?: string;
    /** `advisor consulted` / `advisor unavailable (code)`, appended as a fact. */
    readonly advisor?: string;
  },
): string {
  const compact = opts.tier === "compact";
  const budget = opts.budget ?? (compact ? DEFAULT_COMPACT_CHAR_BUDGET : DEFAULT_SOURCES_CHAR_BUDGET);
  const allVerified = stats.counted > 0 && stats.verified >= stats.counted;
  const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;
  const note = (opts.note ?? "").trim();
  let head: string;
  if (note.length > 0) head = note;
  else if (stats.clientFacing && allVerified) head = `Verified ${plural(stats.counted, "claim")} · client-facing`;
  else if (compact) head = allVerified ? "Verified" : "Checked";
  else if (stats.counted > 0 && allVerified) head = `Verified ${plural(stats.counted, "claim")}`;
  else if (stats.counted > 0 && stats.verified > 0) head = `${stats.verified} of ${plural(stats.counted, "claim")} verified`;
  else if (stats.counted > 0) head = `Checked ${plural(stats.counted, "claim")}`;
  else if (stats.steps > 0) head = `Checked ${plural(stats.steps, "step")}`;
  else head = "Checked";
  const advisor = (opts.advisor ?? "").trim();
  const tail =
    (advisor.length > 0 ? ` · ${advisor}` : "") +
    (stats.secs > 0 ? ` · ${formatDuration(stats.secs, { precise: true })}` : "");
  const room = budget - head.length - tail.length - 3;
  const srcPart =
    room > 12 && sources.length > 0
      ? buildSourcesLine(sources, { head: "", maxLinks: 0, maxEntries: compact ? 1 : 3, budget: room })
      : "";
  return head + (srcPart ? ` · ${srcPart}` : "") + tail;
}

export interface AnnotationResult {
  readonly deliveryText: string;
  readonly footer: "appended" | "compact" | "omitted-oversize" | "none";
  readonly footerChars: number;
}

/** Compose `response + verdict lines + sources line`, never exceeding 2000 for a ≤2000 body. */
export function composeDeliveryAnnotations(i: AnnotationInputs): AnnotationResult {
  const advisor = (i.advisor ?? "").trim();
  if (i.tier === "none") {
    // 999.151 — an agent with no verification to report still has an advisor
    // fact to carry, and it belongs in the same grey register as everything
    // else rather than as italic prose above it.
    if (advisor.length === 0) return { deliveryText: i.response, footer: "none", footerChars: 0 };
    const withRow = appendAdvisorSubtext(i.response, advisor);
    if (withRow === i.response) {
      return { deliveryText: i.response, footer: "omitted-oversize", footerChars: 0 };
    }
    return {
      deliveryText: withRow,
      footer: "compact",
      footerChars: withRow.length - i.response.length,
    };
  }
  // The merged line absorbs the exception; only the legacy Sources-line path
  // still renders it as a row of its own.
  const lines: string[] = i.verification ? [] : [...i.marks.lines];
  // The merged line's ✅ head already says "client-facing"; only the legacy
  // Sources-line path prepends the summary as its own line.
  if (i.clientFacingSummary && !i.verification) lines.unshift(i.clientFacingSummary);
  const compact = i.tier === "compact";
  const fullBudget = compact ? DEFAULT_COMPACT_CHAR_BUDGET : (i.sourcesCharBudget ?? DEFAULT_SOURCES_CHAR_BUDGET);
  const sourcesLine = i.verification
    ? buildVerificationLine(i.verification, i.sources, {
        tier: i.tier,
        budget: fullBudget,
        note: i.marks.note,
        ...(advisor ? { advisor } : {}),
      })
    : buildSourcesLine(i.sources, {
        compact,
        compactVerified: compact && i.marks.reaction === "✅",
        budget: fullBudget,
      });
  const all = [...lines, ...(sourcesLine ? [sourcesLine] : [])];
  if (all.length === 0) return { deliveryText: i.response, footer: "none", footerChars: 0 };
  const block = SUBTEXT_BLOCK + all.join(SUBTEXT_LINE);
  const bodyFits = i.response.length <= DISCORD_MESSAGE_MAX;
  if (bodyFits && i.response.length + block.length > DISCORD_MESSAGE_MAX) {
    const compactLine = i.verification
      ? buildVerificationLine(i.verification, i.sources, {
          tier: "compact",
          budget: DEFAULT_COMPACT_CHAR_BUDGET,
          note: i.marks.note,
          ...(advisor ? { advisor } : {}),
        })
      : buildSourcesLine(i.sources, { compact: true, compactVerified: i.marks.reaction === "✅" });
    const small = SUBTEXT_BLOCK + [...lines, ...(compactLine ? [compactLine] : [])].join(SUBTEXT_LINE);
    if (i.response.length + small.length <= DISCORD_MESSAGE_MAX && small.length > SUBTEXT_BLOCK.length) {
      return { deliveryText: i.response + small, footer: "compact", footerChars: small.length };
    }
    return { deliveryText: i.response, footer: "omitted-oversize", footerChars: 0 };
  }
  return { deliveryText: i.response + block, footer: compact ? "compact" : "appended", footerChars: block.length };
}

/**
 * Head of a daemon-authored footer line — the ONE place that knows what our
 * own annotations look like, so `stripVerificationSubtext` (here) and
 * `VERIFICATION_LINE_RE` (correction-edit) cannot drift apart.
 *
 * 999.151 dropped the leading glyphs, so the heads are now words; the old
 * glyphs stay in the alternation because a correction can land on a message
 * that was delivered BEFORE this change and must still recognise its footer.
 */
// 999.178 R1 — a migrated footer line now leads with a `cc_*` custom-emoji
// token (`<:cc_warning:123>`); already-posted messages still carry the old
// Unicode glyphs, so BOTH forms stay in the alternation. Scoped to the
// daemon's own footer icons — a generic `<:cc_\w+:\d+>` would let this
// end-anchored stripper eat agent-authored trailing icon lines.
export const FOOTER_HEAD_ALTERNATION =
  "Verified|Re-checked|Checked|Corrected|Cited, not opened|Still verifying|Verifying|Sources:|Advisor|\\d+ (?:of \\d+ )?claims?\\b|<:cc_(?:warning|search|pencil|circle_check):\\d+>|🔎|✏️|⚠️|✅|✓";

/** Strip every daemon-authored verification subtext line from the END of a text (idempotent). */
export function stripVerificationSubtext(text: string): string {
  const re = new RegExp(`(\\n\\n?-# (?:${FOOTER_HEAD_ALTERNATION})[^\\n]*)+$`, "u");
  return text.replace(re, "").replace(/\s+$/, "");
}

/** Sentence-case a fact that leads its own line ("advisor consulted"). */
function capitalize(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/**
 * 999.151 — the advisor fact as its OWN subtext row, for the deliveries the
 * annotation composer never sees (v3 edit-in-place, agents with the sources
 * footer off, the composer's fail-open path). ONE renderer, so the line is
 * byte-identical wherever it lands. Returns the text unchanged when the row
 * would push a ≤2000-char body over the Discord limit.
 */
export function appendAdvisorSubtext(text: string, note: string): string {
  const trimmed = note.trim();
  if (trimmed.length === 0) return text;
  const row = SUBTEXT_BLOCK + capitalize(trimmed);
  if (text.length <= DISCORD_MESSAGE_MAX && text.length + row.length > DISCORD_MESSAGE_MAX) {
    return text;
  }
  return text + row;
}
