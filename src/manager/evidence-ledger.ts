/**
 * Evidence ledger — deterministic, daemon-side record of every SOURCE a turn
 * actually consulted, derived from tool events rather than from anything the
 * model says.
 *
 * WHY. Until now the only "sources" surface was the `Sources:` line the model
 * chose to write, and the only "verified" signal for figures was that a
 * whitelisted tool NAME fired somewhere in the turn. Neither can tell a cited
 * page that was opened from one that was never fetched — the strongest
 * hallucination signal available. This module turns the two production tool
 * seams (tool_use input, tool_result text) into typed `EvidenceEntry`s that the
 * verification gate, the claim ledger and the Sources footer all read.
 *
 * Shapes are pinned to what prod actually emits (fin-client transcripts,
 * 2026-08-26):
 *   - `WebSearch`  → local tool_result TEXT beginning `Web search results for
 *     query: "…"` with a `Links: [{"title":…,"url":…}, …]` JSON array.
 *   - `WebFetch`   → the URL lives in the tool_use INPUT (`url`); the result is a
 *     model summary of the page.
 *   - brave `search` → tool_result TEXT `{"result":[{"title","url","description"}]}`
 *     (/opt/clawcode-mcp-servers/python/brave_search.py).
 *   - `mysql_query` → SQL in the INPUT; one `queried` entry per table.
 *   - `ingest_document` / `Read` under a client documents dir → `document`.
 *
 * Pure: no I/O, no Date, no global state. Every parser is total — malformed
 * input yields [] and never throws into the message path.
 */

import { PRIMARY_SOURCE_HOSTS } from "./financial-rule-claim-classifier.js";

export type EvidenceKind = "read" | "found" | "queried" | "document";
export type EvidenceTier = "primary" | "secondary" | "client";

export interface EvidenceEntry {
  readonly kind: EvidenceKind;
  /** SDK tool name as recorded (e.g. `WebFetch`, `mcp__brave-search__search`). */
  readonly tool: string;
  readonly toolUseId: string;
  /** ms epoch supplied by the caller (this module never reads the clock). */
  readonly at: number;
  /** Normalized URL (web kinds). */
  readonly url?: string;
  /** www-stripped lowercase host (web kinds). */
  readonly host?: string;
  /** Page title from a search result. Stored, rendered only after sanitising. */
  readonly title?: string;
  /** Search query (found). */
  readonly query?: string;
  /** Table name (queried). */
  readonly table?: string;
  /** Document basename (document). Never a directory. */
  readonly file?: string;
  /** ISO date parsed from a document filename when present. */
  readonly asOf?: string;
  /** Whether a claim resting on this entry counts as primary-sourced. */
  readonly tier: EvidenceTier;
  /** Set on entries carried over from the previous turn (lookback). */
  readonly stale?: boolean;
}

/** Bounds — evidence is model-adjacent input; everything is capped. */
export const EVIDENCE_MAX_PER_TURN = 200;
export const EVIDENCE_PARSE_MAX_CHARS = 32_768;
export const EVIDENCE_URL_MAX_CHARS = 512;
export const EVIDENCE_TITLE_MAX_CHARS = 120;
export const EVIDENCE_QUERY_MAX_CHARS = 120;
/** A search returns up to ~10 links; anything beyond this is noise. */
export const EVIDENCE_MAX_FOUND_PER_RESULT = 20;

/** Default directories whose `Read`s count as client documents. */
export const DEFAULT_DOCUMENT_DIRS: readonly string[] = Object.freeze([
  "documents",
  "clients",
]);

export interface EvidenceOptions {
  /** Extra hosts treated as primary, on top of PRIMARY_SOURCE_HOSTS. */
  readonly primaryHosts?: readonly string[];
  /** Path segments under which a `Read` counts as a client document. */
  readonly documentDirs?: readonly string[];
}

const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|ref)$/i;

/**
 * Normalize a URL for matching: https only, lowercase host, www stripped,
 * tracking params and fragment dropped, trailing slash trimmed. Returns null
 * for anything that is not an http(s) URL (javascript:, data:, mailto: …).
 */
export function normalizeUrl(raw: unknown): { url: string; host: string } | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > EVIDENCE_URL_MAX_CHARS * 4) return null;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (host.length === 0) return null;
  const params = new URLSearchParams();
  for (const [k, v] of u.searchParams) {
    if (!TRACKING_PARAMS.test(k)) params.append(k, v);
  }
  const qs = params.toString();
  let path = u.pathname.replace(/\/+$/, "");
  if (path.length === 0) path = "";
  const url = `https://${host}${path}${qs ? `?${qs}` : ""}`.slice(0, EVIDENCE_URL_MAX_CHARS);
  return { url, host };
}

/** Bare hostname → canonical lowercase www-stripped form, or null. */
export function normalizeHost(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const h = raw.trim().toLowerCase().replace(/^www\./, "");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h) ? h : null;
}

export function tierForHost(host: string, opts?: EvidenceOptions): EvidenceTier {
  const primary = [...PRIMARY_SOURCE_HOSTS, ...(opts?.primaryHosts ?? [])];
  return primary.some((p) => host === p || host.endsWith(`.${p}`)) ? "primary" : "secondary";
}

/** Trailing path segment only — a client path can carry a household name. */
function safeBasename(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const last = raw.split(/[\\/]/).pop() ?? "";
  return last.replace(/[\r\n\t]/g, " ").trim().slice(0, 120);
}

/** `2026-04-30` or `20260430` anywhere in a filename → ISO date. */
export function asOfFromFilename(name: string): string | undefined {
  const iso = /(20\d{2})-(\d{2})-(\d{2})/.exec(name);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const compact = /(20\d{2})(\d{2})(\d{2})/.exec(name);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  return undefined;
}

function isUnderDocumentDir(path: string, dirs: readonly string[]): boolean {
  const segs = path.split(/[\\/]/).map((s) => s.toLowerCase());
  return dirs.some((d) => segs.includes(d.toLowerCase()));
}

/**
 * Table identifiers from `FROM` / `JOIN` / `UPDATE` / `INSERT INTO` clauses.
 * Backticks, quotes and schema prefixes are stripped; subqueries are skipped.
 * Linear, bounded; returns [] for anything odd.
 */
export function tablesFromSql(sql: unknown): string[] {
  if (typeof sql !== "string" || sql.length === 0) return [];
  const text = sql.slice(0, EVIDENCE_PARSE_MAX_CHARS);
  const out = new Set<string>();
  const re = /\b(?:from|join|update|into)\s+([`"']?[A-Za-z_][A-Za-z0-9_]*[`"']?(?:\.[`"']?[A-Za-z_][A-Za-z0-9_]*[`"']?)?)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const ident = m[1]!.replace(/[`"']/g, "");
    const name = ident.includes(".") ? ident.split(".").pop()! : ident;
    if (name.length > 0 && name.length <= 64) out.add(name.toLowerCase());
    if (out.size >= 32) break;
  }
  return [...out];
}

function truncate(s: unknown, max: number): string | undefined {
  if (typeof s !== "string") return undefined;
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 0 ? t.slice(0, max) : undefined;
}

function lower(name: string): string {
  return name.toLowerCase();
}

/**
 * Evidence available at the tool_use seam (the model's INPUT to a tool).
 */
export function evidenceFromToolUse(
  toolName: string,
  toolUseId: string,
  input: unknown,
  at: number,
  opts?: EvidenceOptions,
): EvidenceEntry[] {
  const n = lower(toolName);
  const obj = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : undefined;
  if (!obj) return [];

  if (n.includes("webfetch") || n.includes("web_fetch")) {
    const norm = normalizeUrl(obj.url);
    if (!norm) return [];
    return [{ kind: "read", tool: toolName, toolUseId, at, url: norm.url, host: norm.host, tier: tierForHost(norm.host, opts) }];
  }
  // 2026-08-28 — market-data APIs. `mcp__finnhub__stock_quote({symbol})` is
  // how a price reaches a reply; without an evidence entry the model's
  // citation of finnhub reconciled as "cited, not opened" (false ⚠️).
  if (n.includes("finnhub") || n.includes("stock_quote") || n.includes("bond_yield") || n.includes("market_data") || n.includes("market-data")) {
    const symbol = typeof obj.symbol === "string" ? obj.symbol.toUpperCase().replace(/[^A-Z0-9.^-]/g, "").slice(0, 12) : "";
    const op = (toolName.split("__").pop() ?? "quote").replace(/_/g, " ");
    const title = symbol ? `${symbol} ${op}` : op;
    const host = n.includes("finnhub") ? "finnhub.io" : "market-data";
    return [{ kind: "queried", tool: toolName, toolUseId, at, table: title, title, host, tier: "secondary" }];
  }
  if (n.includes("mysql_query") || n.includes("acme-db")) {
    return tablesFromSql(obj.sql).map((table) => ({
      kind: "queried" as const, tool: toolName, toolUseId, at, table, tier: "client" as const,
    }));
  }
  if (n.includes("ingest_document")) {
    const file = safeBasename(obj.file_path);
    if (file.length === 0 || isArtifactFile(file)) return [];
    const asOf = asOfFromFilename(file);
    return [{ kind: "document", tool: toolName, toolUseId, at, file, ...(asOf ? { asOf } : {}), tier: "client" }];
  }
  if (n === "read") {
    const path = typeof obj.file_path === "string" ? obj.file_path : "";
    if (!isUnderDocumentDir(path, opts?.documentDirs ?? DEFAULT_DOCUMENT_DIRS)) return [];
    const file = safeBasename(path);
    if (file.length === 0 || isArtifactFile(file)) return [];
    const asOf = asOfFromFilename(file);
    return [{ kind: "document", tool: toolName, toolUseId, at, file, ...(asOf ? { asOf } : {}), tier: "client" }];
  }
  return [];
}

/**
 * Extract the first balanced JSON array that starts at `start` (index of `[`).
 * String-aware so a `]` inside a title does not end the scan. Returns null
 * when unbalanced within the parse budget.
 */
function balancedArrayAt(text: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  const end = Math.min(text.length, start + EVIDENCE_PARSE_MAX_CHARS);
  for (let i = start; i < end; i++) {
    const c = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function linksToEvidence(
  items: unknown,
  toolName: string,
  toolUseId: string,
  at: number,
  query: string | undefined,
  opts?: EvidenceOptions,
): EvidenceEntry[] {
  if (!Array.isArray(items)) return [];
  const out: EvidenceEntry[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    if (out.length >= EVIDENCE_MAX_FOUND_PER_RESULT) break;
    if (raw === null || typeof raw !== "object") continue;
    const item = raw as { url?: unknown; title?: unknown };
    const norm = normalizeUrl(item.url);
    if (!norm || seen.has(norm.url)) continue;
    seen.add(norm.url);
    const title = truncate(item.title, EVIDENCE_TITLE_MAX_CHARS);
    out.push({
      kind: "found", tool: toolName, toolUseId, at, url: norm.url, host: norm.host,
      ...(title ? { title } : {}), ...(query ? { query } : {}), tier: tierForHost(norm.host, opts),
    });
  }
  return out;
}

/**
 * Evidence available at the tool_result seam (what the tool RETURNED).
 */
export function evidenceFromToolResult(
  toolName: string,
  toolUseId: string,
  resultText: unknown,
  at: number,
  opts?: EvidenceOptions,
): EvidenceEntry[] {
  if (typeof resultText !== "string" || resultText.length === 0) return [];
  const n = lower(toolName);
  const text = resultText.slice(0, EVIDENCE_PARSE_MAX_CHARS);

  if (n.includes("websearch") || n.includes("web_search")) {
    const q = /query:\s*"([^"\n]{1,200})"/.exec(text);
    const query = truncate(q?.[1], EVIDENCE_QUERY_MAX_CHARS);
    const idx = text.indexOf("Links:");
    if (idx < 0) return [];
    const open = text.indexOf("[", idx);
    if (open < 0) return [];
    const arr = balancedArrayAt(text, open);
    if (!arr) return [];
    try {
      return linksToEvidence(JSON.parse(arr), toolName, toolUseId, at, query, opts);
    } catch {
      return [];
    }
  }
  if (n.includes("brave") || n.endsWith("__search") || n === "search") {
    const start = text.indexOf("{");
    if (start < 0) return [];
    try {
      const parsed = JSON.parse(text.slice(start)) as { result?: unknown; results?: unknown };
      return linksToEvidence(parsed.result ?? parsed.results, toolName, toolUseId, at, undefined, opts);
    } catch {
      // brave may return a bare array
      const open = text.indexOf("[");
      if (open < 0) return [];
      const arr = balancedArrayAt(text, open);
      if (!arr) return [];
      try {
        return linksToEvidence(JSON.parse(arr), toolName, toolUseId, at, undefined, opts);
      } catch {
        return [];
      }
    }
  }
  return [];
}

/** Dedupe key: one entry per (kind, url|table|file). */
export function evidenceKey(e: EvidenceEntry): string {
  return `${e.kind}|${e.url ?? e.table ?? e.file ?? ""}`;
}

/** Hosts and URLs the DRAFT cites (http(s) URLs + bare primary-host mentions). */
/**
 * 2026-08-27 — hosts that are DELIVERY surfaces, not sources. A link to the
 * PDF the agent just uploaded (Discord CDN) or filed (Drive) is not a citation
 * the agent should have "opened"; flagging them produced "⚠️ cited but never
 * opened: cdn.discordapp.com" under a reply whose actual sources were fine.
 */
export const NON_SOURCE_HOSTS: readonly string[] = Object.freeze([
  "cdn.discordapp.com",
  "media.discordapp.net",
  "discord.com",
  "discordapp.com",
  "drive.google.com",
  "docs.google.com",
  "dropbox.com",
  "localhost",
  "127.0.0.1",
]);

export function isNonSourceHost(host: string): boolean {
  const h = host.toLowerCase();
  return NON_SOURCE_HOSTS.some((n) => h === n || h.endsWith(`.${n}`));
}

/**
 * Files the agent PRODUCES are not sources for its claims: a rendered plan,
 * a chart script, a stylesheet. Client records (statements, filings, the
 * facts JSON) are what the `document` kind is for.
 */
const ARTIFACT_FILE_RE = /\.(?:py|js|mjs|cjs|ts|tsx|sh|html?|css|scss|ya?ml|toml|ini|log|lock|map|svg)$/i;

export function isArtifactFile(name: string): boolean {
  return ARTIFACT_FILE_RE.test(name);
}

export function extractCitations(draft: unknown): { urls: string[]; hosts: string[] } {
  if (typeof draft !== "string" || draft.length === 0) return { urls: [], hosts: [] };
  const text = draft.slice(0, EVIDENCE_PARSE_MAX_CHARS);
  const urls = new Set<string>();
  const hosts = new Set<string>();
  const urlRe = /https?:\/\/[^\s<>()\]"']+/gi;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(text)) !== null) {
    const norm = normalizeUrl(m[0].replace(/[.,;:!?)]+$/, ""));
    if (norm && !isNonSourceHost(norm.host)) {
      urls.add(norm.url);
      hosts.add(norm.host);
    }
    if (urls.size >= 50) break;
  }
  const bareRe = /\b((?:[a-z0-9-]+\.)+(?:gov|org|com|net|edu))\b(?!\S*@)/gi;
  while ((m = bareRe.exec(text)) !== null) {
    const h = normalizeHost(m[1]);
    if (h && (h.endsWith(".gov") || PRIMARY_SOURCE_HOSTS.some((p) => h === p || h.endsWith(`.${p}`)))) {
      hosts.add(h);
    }
    if (hosts.size >= 50) break;
  }
  return { urls: [...urls], hosts: [...hosts] };
}

export interface CitationReconciliation {
  /** Cited URLs/hosts that appear in the evidence (read, found, queried, document). */
  readonly matched: string[];
  /** Cited hosts the turn never opened or found — the hallucination signal. */
  readonly unmatchedHosts: string[];
}

/**
 * Cross-check what the draft cites against what the turn consulted. Host-level
 * matching is deliberate: a citation to `irs.gov/retirement-plans/x` counts as
 * matched when any irs.gov page was opened or found this turn — the
 * claim-level check (claim ledger) is the one that demands the exact page.
 */
export function reconcileCitations(
  cited: { urls: readonly string[]; hosts: readonly string[] },
  evidence: readonly EvidenceEntry[],
): CitationReconciliation {
  const evidenceHosts = new Set(evidence.map((e) => e.host).filter((h): h is string => typeof h === "string"));
  const evidenceUrls = new Set(evidence.map((e) => e.url).filter((u): u is string => typeof u === "string"));
  const matched: string[] = [];
  const unmatched = new Set<string>();
  for (const u of cited.urls) {
    if (evidenceUrls.has(u)) matched.push(u);
    else {
      const h = normalizeUrl(u)?.host;
      if (h && evidenceHosts.has(h)) matched.push(u);
      else if (h) unmatched.add(h);
    }
  }
  for (const h of cited.hosts) {
    if (evidenceHosts.has(h)) {
      if (!matched.includes(h)) matched.push(h);
    } else unmatched.add(h);
  }
  return { matched, unmatchedHosts: [...unmatched].slice(0, 5) };
}
