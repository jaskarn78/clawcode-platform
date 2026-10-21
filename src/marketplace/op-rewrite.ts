/**
 * Phase 90 Plan 06 HUB-05 — 1Password op:// rewrite helper.
 *
 * Probes the operator's 1Password vault via `op item list` and fuzzy-matches
 * credential-looking config fields against existing item titles. When a match
 * is found (substring containment OR Levenshtein distance ≤ 3), proposes an
 * `op://example-vault-21/<title>/<field>` URI for the Discord UI to offer as a
 * confirmation button (D-12, D-16).
 *
 * Graceful degradation: if the `op` binary is absent or not signed in, the
 * listOpItems probe returns an empty array — the UI falls through to literal
 * paste (which itself requires explicit confirmation via the Phase 90 Plan 05
 * secret-scan gate).
 *
 * Pure-function DI (Phase 85 pattern): all I/O injected via the `deps.run`
 * hook. No module-level state. Fully unit-testable with mock execFile.
 *
 * NOTE ON execa: the CLAUDE.md tech stack lists execa, but the repo uses
 * Node's native child_process.execFile directly (Plan 90-04 pivoted away from
 * the `execa` dep — see 90-04-SUMMARY.md Deviation #1). We follow that
 * precedent here.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "pino";

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One 1Password item returned by `op item list`. Only `uuid` + `title` are
 * contractually required; `tags` is optional.
 */
export type OpItemCandidate = Readonly<{
  uuid: string;
  title: string;
  category: string;
  tags?: readonly string[];
}>;

/**
 * Result of proposeOpUri: a fully-formed op:// URI + the confidence tier the
 * matcher used. `distance` is populated only for Levenshtein matches (UI can
 * surface "close match — please verify" when distance > 0).
 */
export type OpRewriteProposal = Readonly<{
  uri: string;
  confidence: "substring" | "levenshtein";
  itemTitle: string;
  distance?: number;
}>;

/**
 * DI struct for listOpItems. Absent → production globals (child_process
 * execFile). Tests pass a `run` stub returning `{stdout, stderr}`.
 */
export type OpRewriteDeps = Readonly<{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run?: (bin: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string } | any>;
  log?: Logger;
}>;

// ---------------------------------------------------------------------------
// Levenshtein distance — pure DP implementation, zero-dep
// ---------------------------------------------------------------------------

/**
 * Classic Levenshtein edit distance (insertions + deletions + substitutions,
 * unit cost each). O(n*m) time, O(n*m) space.
 *
 * Used by proposeOpUri as the second-pass matcher when substring containment
 * fails. Threshold of ≤ 3 is the D-12 cutoff — captures typos and minor
 * variations ("OpenAI Key" vs "OpenAI API") without over-matching.
 */
export function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const m: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0),
  );
  for (let i = 0; i <= a.length; i++) m[i][0] = i;
  for (let j = 0; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      m[i][j] = Math.min(
        m[i - 1][j] + 1,
        m[i][j - 1] + 1,
        m[i - 1][j - 1] + cost,
      );
    }
  }
  return m[a.length][b.length];
}

// ---------------------------------------------------------------------------
// listOpItems — read-only probe of the operator's 1Password vault
// ---------------------------------------------------------------------------

/**
 * Shell out to `op item list --categories=Credential,API --format=json` and
 * return the parsed items. Graceful degradation: ENOENT (op not installed),
 * non-zero exit (not signed in), or malformed JSON all return an empty array
 * so the caller's code path stays linear.
 *
 * Read-only — never creates, modifies, or deletes items.
 */
export async function listOpItems(
  deps?: OpRewriteDeps,
): Promise<readonly OpItemCandidate[]> {
  const run =
    deps?.run ??
    (async (bin: string, args: readonly string[]) => {
      const res = await execFileP(bin, [...args]);
      return { stdout: res.stdout.toString(), stderr: res.stderr.toString() };
    });
  try {
    const { stdout } = await run("op", [
      "item",
      "list",
      "--categories=Credential,API",
      "--format=json",
    ]);
    let arr: unknown;
    try {
      arr = JSON.parse(String(stdout));
    } catch {
      deps?.log?.debug("op item list: malformed JSON output");
      return Object.freeze([]);
    }
    if (!Array.isArray(arr)) {
      return Object.freeze([]);
    }
    const items: OpItemCandidate[] = [];
    for (const raw of arr) {
      if (raw === null || typeof raw !== "object") continue;
      const e = raw as Record<string, unknown>;
      if (typeof e.id !== "string" || typeof e.title !== "string") continue;
      items.push(
        Object.freeze({
          uuid: e.id,
          title: e.title,
          category: typeof e.category === "string" ? e.category : "",
          tags:
            Array.isArray(e.tags) && e.tags.every((t) => typeof t === "string")
              ? Object.freeze([...(e.tags as string[])])
              : undefined,
        }),
      );
    }
    return Object.freeze(items);
  } catch (err) {
    deps?.log?.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "op item list failed (1Password CLI unavailable or not signed in); returning empty candidate list",
    );
    return Object.freeze([]);
  }
}

// ---------------------------------------------------------------------------
// Field-name → op:// field heuristic
// ---------------------------------------------------------------------------

/**
 * Map a ClawCode-common env var name to a typical 1Password Credential-item
 * field name. The operator can always override by typing a custom op:// path;
 * this is just the default suggestion.
 *
 * Examples:
 *   MYSQL_PASSWORD  → password
 *   DB_USER         → username
 *   MYSQL_HOST      → hostname
 *   MYSQL_PORT      → port
 *   GITHUB_TOKEN    → credential
 *   API_KEY         → credential
 *   OPENAI_KEY      → credential
 */
function opFieldFor(envName: string): string {
  const lower = envName.toLowerCase();
  if (lower === "password" || lower.endsWith("_password")) return "password";
  if (
    lower === "user" ||
    lower === "username" ||
    lower.endsWith("_user") ||
    lower.endsWith("_username")
  )
    return "username";
  if (lower === "host" || lower === "hostname" || lower.endsWith("_host"))
    return "hostname";
  if (lower === "port" || lower.endsWith("_port")) return "port";
  // Default for tokens, keys, secrets, and anything else → "credential"
  // (1Password's canonical field for API-style credentials).
  return "credential";
}

// ---------------------------------------------------------------------------
// proposeOpUri — two-pass matcher: substring → Levenshtein
// ---------------------------------------------------------------------------

/**
 * Propose an op:// URI for a sensitive config field by matching its label
 * (or name) against the operator's 1Password item titles.
 *
 * Two-pass matcher per D-12:
 *   1. Substring containment — either the label is a substring of a title,
 *      OR a title is a substring of the label. Case-insensitive.
 *   2. Levenshtein distance ≤ `maxDistance` (default 3) on lowercased
 *      full-string comparison. Best match (lowest distance) wins.
 *
 * Returns null if neither pass finds a candidate — caller falls through to
 * literal paste with explicit confirmation.
 */
export function proposeOpUri(
  fieldName: string,
  fieldLabel: string,
  items: readonly OpItemCandidate[],
  maxDistance: number = 3,
): OpRewriteProposal | null {
  if (items.length === 0) return null;
  const target = fieldLabel.toLowerCase();
  const fallback = fieldName.toLowerCase();

  // Pass 1: substring containment — check both directions.
  for (const item of items) {
    const t = item.title.toLowerCase();
    // Pull the most-specific token from the label (first word) for better
    // matching against titles like "OpenAI API". Still do full-string
    // comparison as a safety net.
    const labelFirst = target.split(/\s+/)[0] ?? target;
    const nameFirst = fallback.split(/[_\s-]/)[0] ?? fallback;
    if (t.includes(target) || target.includes(t)) {
      return Object.freeze({
        uri: `op://example-vault-21/${item.title}/${opFieldFor(fieldName)}`,
        confidence: "substring" as const,
        itemTitle: item.title,
      });
    }
    if (
      labelFirst.length >= 3 &&
      (t.includes(labelFirst) || labelFirst.includes(t))
    ) {
      return Object.freeze({
        uri: `op://example-vault-21/${item.title}/${opFieldFor(fieldName)}`,
        confidence: "substring" as const,
        itemTitle: item.title,
      });
    }
    if (
      nameFirst.length >= 3 &&
      nameFirst !== labelFirst &&
      (t.includes(nameFirst) || nameFirst.includes(t))
    ) {
      return Object.freeze({
        uri: `op://example-vault-21/${item.title}/${opFieldFor(fieldName)}`,
        confidence: "substring" as const,
        itemTitle: item.title,
      });
    }
  }

  // Pass 2: Levenshtein ≤ maxDistance on full lowercased strings.
  let best: { item: OpItemCandidate; distance: number } | null = null;
  for (const item of items) {
    const d = levenshtein(item.title.toLowerCase(), target);
    if (d <= maxDistance && (!best || d < best.distance)) {
      best = { item, distance: d };
    }
  }
  if (best) {
    return Object.freeze({
      uri: `op://example-vault-21/${best.item.title}/${opFieldFor(fieldName)}`,
      confidence: "levenshtein" as const,
      itemTitle: best.item.title,
      distance: best.distance,
    });
  }

  return null;
}
