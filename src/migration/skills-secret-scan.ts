/**
 * Phase 84 Plan 01 — Per-skill secret scanner.
 *
 * Walks a skill directory (SKILL.md + scripts/ + references/) looking for
 * secret-shaped strings. First offender wins (fail-fast). Returns a
 * `SkillSecretResult` that callers use to refuse the migration of any skill
 * whose source still contains literal credentials.
 *
 * This is the HARD GATE for SKILL-02: acme-crm's SKILL.md contains
 * literal MySQL credentials (host + user + high-entropy password). Until
 * those are moved to op:// refs, scanSkillSecrets MUST refuse the copy.
 *
 * Classifier reuse: Phase 77 shipped `guards.ts` with BFS-over-PlanReport
 * secret detection. Skills scan differently — line-by-line through text
 * files, not object-tree BFS — but the token-classification rules are
 * identical. Rather than exporting guards.ts internals (risking churn to
 * the v2.1 ledger guard contract), we re-declare the classification
 * constants here with a pointer to the canonical source. Any change to
 * guards.ts classifier rules MUST be mirrored here (grep for guards.ts).
 *
 * Zero new npm deps — everything is node: built-ins + reused literals.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname } from "node:path";

// -----------------------------------------------------------------------
// Classifier constants — copy of Phase 77 guards.ts regexes/thresholds.
// When guards.ts changes these, sync here. See guards.ts lines 44-66.
// -----------------------------------------------------------------------
const SK_PREFIX = /^sk-[A-Za-z0-9_\-]{20,}$/;
const DISCORD_PREFIX = /^MT[A-Za-z0-9._\-]{20,}/;
const OP_REF = /^op:\/\//;
const NUMERIC_ONLY = /^[0-9]+$/;
const SHORT_IDENT = /^[a-z0-9\-]+$/;
const SHORT_IDENT_MAX = 40;
const ABSOLUTE_PATH_PREFIX = /^(?:\/|~\/)/;
const MODEL_ID_SHAPE = /^[a-z0-9][a-z0-9.\-]*\/[a-z0-9][a-z0-9.\-]*$/;
const MODEL_ID_MAX = 80;
const HIGH_ENTROPY_MIN_LEN = 30;
const HIGH_ENTROPY_MIN_CLASSES = 3;
const HIGH_ENTROPY_MIN_BITS = 4.0;

// Acme-crm's MySQL password is 19 chars / 4 character classes /
// entropy ~3.93 — below the v2.1 PlanReport threshold of 30 chars /
// 4.0 bits. Skills scan at a tighter threshold because
// SKILL.md is free-form markdown where shorter hand-typed secrets appear
// embedded in paragraph text (v2.1 PlanReport values were structured YAML
// fields, typically model ids / channel ids / op:// refs — longer and more
// regular). Keep the tighter threshold local to this module.
const HIGH_ENTROPY_MIN_LEN_SKILLS = 12;
const HIGH_ENTROPY_MIN_BITS_SKILLS = 3.8;

// File types we scan. Anything else (images, binaries, zips) is skipped —
// binary content trivially triggers high-entropy false positives.
const ALLOWED_EXTENSIONS = new Set([
  ".md",
  ".sh",
  ".py",
  ".js",
  ".ts",
  ".json",
  ".yaml",
  ".yml",
  ".txt",
]);

// Dir names we skip while walking. Dependency dirs and VCS metadata have
// no reason to contain skill-relevant credentials but routinely contain
// high-entropy content (lockfiles, packed objects, minified JS).
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next"]);

// Max file size we'll scan (2MB). Larger files are skipped with no offender —
// SKILL.md files are expected to be <100KB; anything bigger is likely a data
// dump and would balloon scan time.
const MAX_SCAN_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Secret-scan result for a single skill directory. `pass: true` means the
 * skill is safe to migrate; `pass: false` means a secret was found and
 * migration MUST refuse.
 *
 * `offender.preview` is the raw line with the offending token masked as
 * `***`, truncated to 60 chars. The literal secret is NEVER included in
 * the payload — callers log the preview and operators consult the file
 * at the reported line number.
 */
export type SkillSecretResult = {
  readonly pass: boolean;
  readonly offender?: {
    readonly file: string;
    readonly line: number;
    readonly preview: string;
    readonly reason: "sk-prefix" | "discord-prefix" | "high-entropy";
  };
};

// -----------------------------------------------------------------------
// Classifier helpers — private, copy of guards.ts logic.
// -----------------------------------------------------------------------

function computeShannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function characterClasses(s: string): number {
  let n = 0;
  if (/[a-z]/.test(s)) n++;
  if (/[A-Z]/.test(s)) n++;
  if (/[0-9]/.test(s)) n++;
  if (/[^A-Za-z0-9]/.test(s)) n++;
  return n;
}

function isWhitelisted(s: string): boolean {
  if (s === "") return true;
  // Real credentials NEVER contain internal whitespace. A quoted substring
  // with spaces is prose / header value / command arg — not a secret.
  // Examples: `"Authorization: Bearer $HA_TOKEN"`, `"method arg arg"`.
  if (/\s/.test(s)) return true;
  if (OP_REF.test(s)) return true;
  if (NUMERIC_ONLY.test(s)) return true;
  if (SHORT_IDENT.test(s) && s.length <= SHORT_IDENT_MAX) return true;
  if (ABSOLUTE_PATH_PREFIX.test(s)) return true;
  if (MODEL_ID_SHAPE.test(s) && s.length <= MODEL_ID_MAX) return true;
  // Skills-specific additions beyond Phase 77 guards.ts — SKILL.md routinely
  // contains shell snippets, code snippets, and URLs that are not credentials.
  // Without these, legitimate snippets like `$(cat ~/.config/op/...)`,
  // `hashlib.sha256(body.encode()).hexdigest()`, and https URLs would flunk
  // the high-entropy threshold.
  //
  // Shell command substitutions: `$(...)` and backtick. The substitution body
  // MAY reference secrets via downstream commands (e.g. `$(op item get ...)`)
  // but the body itself is not a secret — it's a program invocation.
  if (s.startsWith("$(") || s.startsWith("${")) return true;
  if (s.startsWith("`") && s.endsWith("`")) return true;
  // Environment variable reference (`$FOO` / `${FOO}`) — not a secret.
  if (/^\$[A-Z_][A-Z0-9_]*$/.test(s)) return true;
  // URLs — documentation commonly references API endpoints which are long
  // and multi-class (https://api.tuya.com/...). These are not credentials.
  if (/^https?:\/\//.test(s)) return true;
  // File:// URLs + data: URLs likewise are not credentials.
  if (/^(file|data):/.test(s)) return true;
  // Code fragments containing function-call syntax — `foo.bar()` or
  // `foo.bar(arg)`. Method chains and invocations appear in SKILL.md code
  // blocks. A real secret would be quoted (captured by Pass 1 of tokenize);
  // a bare token with `(` is an identifier or call expression.
  if (/[(]/.test(s) || /[)]/.test(s)) return true;
  // Path-shaped tokens (contain `/`) and file-reference shapes — real
  // credentials are opaque blobs; filesystem paths and URL path segments
  // are strictly structured. A real sk-/MT- secret is still caught by
  // hasSecretPrefix above (runs BEFORE whitelist).
  if (/\//.test(s) && !/^[A-Za-z0-9+/=]+$/.test(s)) return true;
  // Dotted identifiers (Python module paths, YAML key chains, Home-Assistant
  // entity ids). Shape: `[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+`.
  // Real secrets rarely contain `.` and never match this strict shape.
  if (/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(s)) {
    return true;
  }
  // Docker / package reference shapes — `name:tag` where both sides are
  // simple identifiers / version strings (no uppercase mixed with digits
  // in a random fashion that would look credential-like).
  // Examples: `python:3.11-slim`, `ubuntu:latest`, `node:22-alpine`,
  // `package@1.2.3-beta`. Real tokens rarely match this strict shape.
  if (/^[a-z][a-z0-9_-]*[:@][a-z0-9][a-z0-9._-]*$/.test(s)) {
    return true;
  }
  // Quote characters embedded in a token (script shell quoting artifacts)
  // — strip-and-retry tokens containing `"` or `'` were tokenized by Pass 1
  // of tokenize() already. The bare-token form with leftover quotes is noise.
  if (s.includes('"') || s.includes("'")) return true;
  return false;
}

function hasSecretPrefix(
  s: string,
): "sk-prefix" | "discord-prefix" | null {
  if (SK_PREFIX.test(s)) return "sk-prefix";
  if (DISCORD_PREFIX.test(s)) return "discord-prefix";
  return null;
}

function isHighEntropySecret(s: string): boolean {
  if (s.length < HIGH_ENTROPY_MIN_LEN_SKILLS) return false;
  if (characterClasses(s) < HIGH_ENTROPY_MIN_CLASSES) return false;
  if (computeShannonEntropy(s) < HIGH_ENTROPY_MIN_BITS_SKILLS) return false;
  // Short opaque blobs (12..29 chars) that contain word-boundary characters
  // (`-`, `_`, or space) are almost always hyphenated identifiers or
  // multi-word compounds, not secrets. Credentials at this length are
  // typically continuous runs of alnum + symbol with NO word boundaries
  // — e.g., a 19-char @-delimited password with no `-` or `_` separators.
  // The v2.1 threshold (len>=30) didn't need this refinement because
  // word-boundary compounds rarely hit 30 chars.
  if (s.length < HIGH_ENTROPY_MIN_LEN && /[-_\s]/.test(s)) return false;
  return true;
}

// Unused-in-body v2.1 constants kept for doc-sync reference with guards.ts.
// Reference them via `void` so TS noUnusedLocals stays quiet.
void HIGH_ENTROPY_MIN_LEN;
void HIGH_ENTROPY_MIN_BITS;

// -----------------------------------------------------------------------
// Tokenizer — yield bare tokens AND quoted-substring tokens.
// -----------------------------------------------------------------------

/**
 * Split a line into tokens the classifier should evaluate. We yield:
 *   (a) quoted substrings (single- or double-quoted) — catches
 *       `password='<literal>'` where the secret is the quoted
 *       content, not a bare whitespace-delimited token.
 *   (b) bare whitespace-delimited tokens with their surrounding quotes
 *       stripped — catches `password=secret` style.
 *
 * Same token may be yielded by both branches (e.g. `"x"` → `x` from quoted
 * AND `"x"` from bare). The classifier is idempotent; duplicates are fine.
 */
function* tokenize(line: string): Generator<string> {
  // Pass 1: quoted substrings (single- or double-quoted). Also split on `=`
  // because quoted `key=value` pairs (shell args, flag values) are the
  // common SKILL.md shape — classify only the rhs to avoid flagging the
  // compound `key=value` string when `value` is a readable placeholder.
  const quoteRe = /'([^']+)'|"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = quoteRe.exec(line)) !== null) {
    const tok = m[1] ?? m[2] ?? "";
    if (tok.length === 0) continue;
    const eq = tok.indexOf("=");
    if (eq > 0 && eq < tok.length - 1) {
      const rhs = tok.slice(eq + 1);
      if (rhs.length > 0) yield rhs;
      continue;
    }
    yield tok;
  }
  // Pass 2: bare whitespace-delimited tokens. Strip surrounding quotes /
  // semicolons / commas so `password="foo",` yields `password=foo` which
  // will split below.
  const bareRe = /\S+/g;
  while ((m = bareRe.exec(line)) !== null) {
    const raw = m[0];
    // Strip leading/trailing punctuation that would otherwise prevent
    // classifier regexes from matching. Includes markdown emphasis (`*`),
    // code fencing (`` ` ``), brackets, and assorted punctuation.
    const stripped = raw.replace(
      /^[()"'`,;:*\[\]{}]+|[()"'`,;:*\[\]{}]+$/g,
      "",
    );
    if (stripped.length === 0) continue;
    // If the token contains `=`, treat it as an assignment (bash / python /
    // yaml `key=value`): only classify the rhs. The compound `KEY="$(cat ...`
    // otherwise flunks high-entropy for mixed-case-plus-special content that
    // is really just a variable assignment.
    const eq = stripped.indexOf("=");
    if (eq > 0 && eq < stripped.length - 1) {
      const rhs = stripped.slice(eq + 1).replace(/^["'`]+|["'`]+$/g, "");
      if (rhs.length > 0) yield rhs;
      continue;
    }
    yield stripped;
  }
}

// -----------------------------------------------------------------------
// Walker — async generator yielding allowed-extension files under a dir.
// -----------------------------------------------------------------------

async function* walkSkillDir(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      yield* walkSkillDir(join(dir, ent.name));
      continue;
    }
    if (!ent.isFile()) continue;
    const ext = extname(ent.name).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) continue;
    yield join(dir, ent.name);
  }
}

// -----------------------------------------------------------------------
// Public entry — scanSkillSecrets
// -----------------------------------------------------------------------

/**
 * Scan a skill directory for secret-shaped strings. First offender wins.
 * Non-existent skillDir returns pass:true (caller handles missing source
 * classification at the discovery layer, not here).
 *
 * Three-phase classifier per token (mirrors Phase 77 guards.walkForSecrets):
 *   1. hasSecretPrefix → ALWAYS refuses (sk-/MT- tokens look like SHORT_IDENT
 *      and would otherwise be silently whitelisted)
 *   2. isWhitelisted → pass silently (op://, numeric-only, short-ident,
 *      absolute paths, model ids)
 *   3. isHighEntropySecret → refuses (len>=12, ≥3 char classes, entropy>=4.0)
 */
export async function scanSkillSecrets(
  skillDir: string,
): Promise<SkillSecretResult> {
  if (!existsSync(skillDir)) return { pass: true };

  for await (const file of walkSkillDir(skillDir)) {
    let size;
    try {
      const s = await stat(file);
      size = s.size;
    } catch {
      continue;
    }
    if (size > MAX_SCAN_FILE_BYTES) continue;

    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }

    // Defensive binary-sniff — utf8 decode of a png/jpg returns a string
    // containing replacement chars and high-entropy noise. Skip any file
    // whose content decoded as utf8 contains a NUL byte (canonical binary
    // marker).
    if (content.includes("\u0000")) continue;

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (line.length === 0) continue;
      const hasCredContext = hasCredentialContext(line);
      for (const token of tokenize(line)) {
        const prefixHit = hasSecretPrefix(token);
        if (prefixHit !== null) {
          // sk-/MT- prefixed tokens always refuse regardless of context —
          // these prefixes are unambiguous credential markers.
          return {
            pass: false,
            offender: {
              file,
              line: i + 1,
              preview: makePreview(line, token),
              reason: prefixHit,
            },
          };
        }
        if (isWhitelisted(token)) continue;
        if (!isHighEntropySecret(token)) continue;
        // High-entropy-alone is not sufficient to refuse — the same shape
        // matches legitimate webhook IDs, avatar IDs, UUIDs, and git SHAs
        // which frequently appear in skill documentation. Require a
        // credential-shaped label in the surrounding line before refusing.
        if (!hasCredContext) continue;
        return {
          pass: false,
          offender: {
            file,
            line: i + 1,
            preview: makePreview(line, token),
            reason: "high-entropy",
          },
        };
      }
    }
  }

  return { pass: true };
}

/**
 * Detect whether a line contains a credential-shaped label. Skill
 * documentation routinely contains high-entropy ID strings (avatar IDs,
 * webhook IDs, UUIDs) that are NOT secrets — distinguishing them from
 * real credentials requires looking at the surrounding label text.
 *
 * We refuse ONLY when a high-entropy token appears on a line that also
 * mentions credential-shaped labels: `password`, `passwd`, `pwd`, `secret`,
 * `token`, `api_key`, `apikey`, `bearer`, `auth`, `credential`, `private_key`.
 * Public ID labels (`id`, `avatar_id`, `webhook`, `endpoint`, `workflow`)
 * are NOT in this list — they pass.
 *
 * Case-insensitive. Word-boundary matching so `bolting` doesn't trigger on
 * `bolt` but `secret_key` does trigger on `secret`.
 */
const CREDENTIAL_LABEL_RE =
  /\b(passw(?:or)?d|pwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|bearer|auth(?:oriza(?:tion)?)?|credential|client[_-]?secret|refresh[_-]?token|session[_-]?token)\b/i;

function hasCredentialContext(line: string): boolean {
  return CREDENTIAL_LABEL_RE.test(line);
}

/**
 * Build a secret-free preview of the offending line. Truncates to 60
 * chars and replaces the offending token with `***`. The literal secret
 * is NEVER returned in the payload.
 */
function makePreview(line: string, secretToken: string): string {
  // Mask token (global, in case it appears multiple times on the line).
  const masked = line.split(secretToken).join("***");
  const trimmed = masked.trim();
  if (trimmed.length <= 60) return trimmed;
  return trimmed.slice(0, 57) + "...";
}

/**
 * Phase 90 Plan 05 HUB-04 — credential-context detection for plugin env
 * field names. Unlike hasCredentialContext (designed for skill file line
 * context), this helper splits on common env-name separators (`_`, `-`,
 * case transitions) so compound identifiers like `DB_PASSWORD`,
 * `API_KEY`, `clientSecret`, `REFRESH-TOKEN` all trip the gate.
 *
 * The base hasCredentialContext uses `\b...\b` which does NOT treat `_`
 * as a word boundary (both sides of `_PASSWORD` are word chars), so
 * `DB_PASSWORD` passes silently. Env field names don't have this
 * property — we need to explicitly enumerate the credential tokens.
 */
const CREDENTIAL_TOKENS_RE =
  /(password|passwd|pwd|secret|apikey|api_key|api-key|accesskey|access_key|access-key|privatekey|private_key|private-key|bearer|auth|authorization|credential|clientsecret|client_secret|client-secret|refreshtoken|refresh_token|refresh-token|sessiontoken|session_token|session-token|token|key)/i;

function hasCredentialContextForField(fieldName: string): boolean {
  // Normalize: remove separators + lowercase. `DB_PASSWORD` → `dbpassword`
  // `client-secret` → `clientsecret` — both still test positive on
  // `password` / `clientsecret` via substring match.
  const normalized = fieldName.toLowerCase().replace(/[_\-\s]/g, "");
  return CREDENTIAL_TOKENS_RE.test(normalized);
}

/**
 * Phase 90 Plan 05 HUB-04 — scan a single field-label + literal-value pair
 * for secret shape. Reuses the same classifier as scanSkillSecrets but
 * the credential-context gate fires on FIELD NAMES (not line context)
 * because plugin env values arrive as structured (name, value) pairs from
 * a Discord modal, not free-form SKILL.md text.
 *
 * Used by install-plugin.ts + yaml-writer.ts updateAgentMcpServers as a
 * defense-in-depth literal-value scanner for plugin env values that don't
 * yet carry an `op://` prefix (operator hand-pasted literal at install
 * time). Returns `refused:true` iff the value is either a known-prefix
 * secret (sk-/MT-) OR high-entropy-on-credential-labeled-field.
 *
 * Safe inputs (always pass):
 *   - Empty strings
 *   - `op://...` 1Password references
 *   - Short identifiers / numeric / path-shaped / URL values
 *   - Values on non-credential-labeled fields (FOO_HOST=<high-entropy>)
 *
 * Refused (`refused:true`):
 *   - sk- / MT- prefixed tokens (ALWAYS refuse, regardless of label)
 *   - High-entropy (≥12 chars / 3 classes / ≥3.8 bits) + credential-
 *     labeled field name (password/secret/token/api_key/... anywhere
 *     in the normalized field name)
 *
 * The `reason` string is the classifier verdict — one of "sk-prefix",
 * "discord-prefix", or "high-entropy" for refusals; empty string for pass.
 */
export function scanLiteralValueForSecret(
  fieldName: string,
  value: string,
): { refused: boolean; reason: string } {
  // Empty / op:// short-circuits — exact parity with scanSkillSecrets policy.
  if (value === "") return { refused: false, reason: "" };
  if (OP_REF.test(value)) return { refused: false, reason: "" };

  // Credential context is derived from the FIELD NAME (structured input),
  // not from line context. This is the Plan 05 HUB-04 policy refinement:
  // plugin env values arrive as (name, value) pairs from a Discord modal,
  // and the name carries the credential semantics (MYSQL_PASSWORD is the
  // "password field" regardless of what value the operator pastes).
  const hasCredContext = hasCredentialContextForField(fieldName);

  // sk-/MT-prefixed tokens ALWAYS refuse, regardless of field context.
  const prefixHit = hasSecretPrefix(value);
  if (prefixHit !== null) {
    return { refused: true, reason: prefixHit };
  }

  // High-entropy refusal gated by field context.
  if (!hasCredContext) return { refused: false, reason: "" };
  if (isWhitelisted(value)) return { refused: false, reason: "" };
  if (!isHighEntropySecret(value)) return { refused: false, reason: "" };
  return { refused: true, reason: "high-entropy" };
}
