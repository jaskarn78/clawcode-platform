/**
 * Phase 90 Plan 04 HUB-01/HUB-03/HUB-06 — pure-function HTTP client for the
 * clawhub.ai skill registry. Uses Node 22's native `globalThis.fetch` (no new
 * npm dep); injectable via a `ClawhubClientDeps` struct for hermetic tests.
 *
 * Two operations:
 *   - fetchClawhubSkills({baseUrl, query?, cursor?, authToken?}) — lists
 *     skills, cursor-paginated (D-03). Returns `{items, nextCursor}` matching
 *     the shape probed from https://clawhub.ai/api/v1/skills on 2026-04-24.
 *   - downloadClawhubSkill({downloadUrl, stagingDir, authToken?}) — streams
 *     the tar.gz to `<stagingDir>/skill.tar.gz`, extracts via `tar -xzf` into
 *     `<stagingDir>/extracted/`, returns the file list.
 *
 * Error classes (discriminated so the installer can map to outcome variants):
 *   - ClawhubRateLimitedError  (429 with Retry-After)
 *   - ClawhubAuthRequiredError (401/403)
 *   - ClawhubManifestInvalidError (malformed response body)
 *
 * Canary blueprint (Phase 85 performMcpReadinessHandshake pattern): zero
 * module-level state, all I/O DI'd through `deps.fetch`, static User-Agent
 * reads package.json at import time once. No logger — caller logs after
 * catching the typed errors.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir as mkdirP, writeFile as writeFileP } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// User-Agent: read package.json once at import time so every request attributes
// rate-limit quotas back to a specific ClawCode release (D-02).
// ---------------------------------------------------------------------------

const PKG_VERSION: string = (() => {
  try {
    const pkgJson = readFileSync(
      new URL("../../package.json", import.meta.url),
      "utf8",
    );
    const parsed = JSON.parse(pkgJson) as { version?: string };
    return parsed.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

const USER_AGENT = `ClawCode/${PKG_VERSION} (clawcode-marketplace)`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One skill item in the ClawHub `/api/v1/skills` list response.
 *
 * Required fields (always present per D-01 probe): id, name, description,
 * version, author, downloadUrl. Optional fields vary by backend version —
 * consumers must defensively handle undefined on non-core fields.
 */
export type ClawhubSkillListItem = Readonly<{
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  downloadUrl: string;
  manifestUrl?: string;
  rating?: number;
  downloadCount?: number;
  category?: string;
  tags?: readonly string[];
  createdAt?: string;
  updatedAt?: string;
}>;

/**
 * Response body shape of `GET /api/v1/skills?q=...&cursor=...`.
 * Verified via live probe 2026-04-24: empty registry returns
 * `{"items":[],"nextCursor":null}` — exact field names preserved.
 */
export type ClawhubSkillsResponse = Readonly<{
  items: readonly ClawhubSkillListItem[];
  nextCursor: string | null;
}>;

/**
 * DI struct. Absent → production globals. Present → test overrides. Never
 * store these on a module singleton — pass through every call site.
 */
export type ClawhubClientDeps = Readonly<{
  fetch: typeof globalThis.fetch;
}>;

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/**
 * 429 from the registry with a Retry-After window. `retryAfterMs` is the
 * parsed header value in milliseconds — caller should stash it in the cache
 * negative entry so subsequent picks within the window fail fast without a
 * round-trip.
 */
export class ClawhubRateLimitedError extends Error {
  public readonly retryAfterMs: number;
  constructor(retryAfterMs: number, message: string) {
    super(message);
    this.name = "ClawhubRateLimitedError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * 401/403 from the registry — either the token is absent (public endpoint
 * returned unauth despite being unauthenticated — unusual but possible under
 * heavy load) or the supplied token is rejected. Plan 90-06 adds the
 * interactive re-auth flow; for Plan 04 the installer surfaces this as the
 * `auth-required` outcome variant and lets the operator handle it.
 */
export class ClawhubAuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClawhubAuthRequiredError";
  }
}

/**
 * Response body did not match the expected shape — malformed JSON, missing
 * `items[]`, corrupt tarball, missing SKILL.md. Distinguished from a plain
 * HTTP error so the installer returns the `manifest-invalid` outcome.
 */
export class ClawhubManifestInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClawhubManifestInvalidError";
  }
}

/**
 * Phase 93 Plan 03 — registry returned 404 for the requested manifest URL.
 *
 * Distinguished from ClawhubManifestInvalidError (which signals a malformed
 * BODY): the 404 case means the manifest doesn't exist at all — the
 * registry lists the plugin in /api/v1/plugins but hasn't published a
 * manifest for it (e.g. hivemind as of 2026-04-24 — every probed URL shape
 * returns 404; see RESEARCH §Pitfall 5 for the 13-URL probe table).
 *
 * Sibling (NOT subclass) of ClawhubManifestInvalidError so the install
 * pipeline can route 404s to a clearer manifest-unavailable outcome variant
 * without conflating "registry can't serve this" with "registry served a
 * malformed payload".
 *
 * Carries `manifestUrl` so the Discord renderer can surface the exact URL
 * that 404'd (operator can probe it manually with curl) and `status` for
 * future-proofing if other not-found-style status codes need routing here.
 */
export class ClawhubManifestNotFoundError extends Error {
  public readonly manifestUrl: string;
  public readonly status: number;
  constructor(manifestUrl: string, status: number, message: string) {
    super(message);
    this.name = "ClawhubManifestNotFoundError";
    this.manifestUrl = manifestUrl;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse Retry-After header (seconds) into ms, fallback 60s. */
function parseRetryAfter(res: Response): number {
  const raw = res.headers.get("Retry-After");
  if (raw !== null) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n * 1000;
  }
  return 60_000;
}

function buildHeaders(authToken: string | undefined): HeadersInit {
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
  };
  if (authToken !== undefined && authToken.length > 0) {
    headers.Authorization = `Bearer ${authToken}`;
  }
  return headers;
}

/**
 * Walk a directory recursively, returning absolute file paths (files only,
 * no directories). Used by downloadClawhubSkill to enumerate the extracted
 * tarball contents for the caller's audit.
 */
async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function recurse(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        await recurse(p);
      } else if (e.isFile()) {
        out.push(p);
      }
    }
  }
  await recurse(root);
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * GET <baseUrl>/api/v1/skills?q=<query>&cursor=<cursor>
 *
 * Query semantics (D-04): ClawHub backend handles vector search; we just
 * URL-encode and forward.
 *
 * Cursor semantics (D-03): opaque string from a prior response's
 * `nextCursor`. Null → no more pages.
 *
 * Error-mapping (HUB-06 install-outcome fuel):
 *   - 429 → ClawhubRateLimitedError (+ Retry-After in ms)
 *   - 401|403 → ClawhubAuthRequiredError
 *   - other !ok → generic Error with status text
 *   - body missing items[] → ClawhubManifestInvalidError
 */
export async function fetchClawhubSkills(
  args: Readonly<{
    baseUrl: string;
    query?: string;
    cursor?: string;
    authToken?: string;
    deps?: ClawhubClientDeps;
  }>,
): Promise<ClawhubSkillsResponse> {
  const fetchFn = args.deps?.fetch ?? globalThis.fetch;
  // Append "/api/v1/skills" to whatever path baseUrl already has (so a
  // baseUrl of "http://localhost/mock" yields "/mock/api/v1/skills", and
  // the canonical "https://clawhub.ai" yields "/api/v1/skills"). Trailing
  // slash handled either way.
  const trimmedBase = args.baseUrl.replace(/\/+$/, "");
  const params = new URLSearchParams();
  if (args.query !== undefined && args.query.length > 0) {
    params.set("q", args.query);
  }
  if (args.cursor !== undefined && args.cursor.length > 0) {
    params.set("cursor", args.cursor);
  }
  const qs = params.toString();
  const urlStr = `${trimmedBase}/api/v1/skills${qs.length > 0 ? `?${qs}` : ""}`;

  const res = await fetchFn(urlStr, {
    headers: buildHeaders(args.authToken),
  });

  if (res.status === 429) {
    const retryAfterMs = parseRetryAfter(res);
    throw new ClawhubRateLimitedError(
      retryAfterMs,
      `clawhub: rate-limited (retry in ${retryAfterMs}ms)`,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new ClawhubAuthRequiredError(
      `clawhub: auth required (status ${res.status})`,
    );
  }
  if (!res.ok) {
    throw new Error(`clawhub: ${res.status} ${res.statusText}`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new ClawhubManifestInvalidError(
      `clawhub: response is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (
    body === null ||
    typeof body !== "object" ||
    !Array.isArray((body as { items?: unknown }).items)
  ) {
    throw new ClawhubManifestInvalidError(
      "clawhub: malformed response (no items[])",
    );
  }
  const parsed = body as ClawhubSkillsResponse;
  return Object.freeze({
    items: Object.freeze(parsed.items.map((i) => Object.freeze(i))),
    nextCursor: parsed.nextCursor ?? null,
  });
}

/**
 * Download + extract one ClawHub skill package.
 *
 * Contract:
 *   1. `<stagingDir>` is created recursively.
 *   2. Response body (assumed tar.gz) is written to
 *      `<stagingDir>/skill.tar.gz`.
 *   3. `<stagingDir>/extracted/` is created and populated via
 *      `tar -xzf <tar> -C <extracted>`.
 *   4. Returns the full list of extracted file paths (audit trail for
 *      the caller's secret-scan pipeline).
 *
 * Caller MUST own cleanup of `stagingDir` in a try/finally (D-07).
 *
 * Extraction uses the host `tar` via execa (Node 22 LTS ships with tar on
 * every supported platform). Keeps this module dependency-free against the
 * Node ecosystem's tar packages (pure-JS tar is slow + binary-corruption-
 * prone vs the battle-tested system tar).
 */
export async function downloadClawhubSkill(
  args: Readonly<{
    downloadUrl: string;
    stagingDir: string;
    authToken?: string;
    deps?: ClawhubClientDeps;
  }>,
): Promise<{ extractedDir: string; files: readonly string[] }> {
  const fetchFn = args.deps?.fetch ?? globalThis.fetch;

  const res = await fetchFn(args.downloadUrl, {
    headers: buildHeaders(args.authToken),
  });

  if (res.status === 429) {
    throw new ClawhubRateLimitedError(
      parseRetryAfter(res),
      `clawhub download: rate-limited`,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new ClawhubAuthRequiredError(
      `clawhub download: auth required (${res.status})`,
    );
  }
  if (!res.ok) {
    throw new Error(`clawhub download: ${res.status} ${res.statusText}`);
  }

  await mkdirP(args.stagingDir, { recursive: true });
  const tarPath = join(args.stagingDir, "skill.tar.gz");
  const bytes = Buffer.from(await res.arrayBuffer());
  await writeFileP(tarPath, bytes);

  const extractedDir = join(args.stagingDir, "extracted");
  await mkdirP(extractedDir, { recursive: true });

  try {
    await execFileP("tar", ["-xzf", tarPath, "-C", extractedDir]);
  } catch (err) {
    throw new ClawhubManifestInvalidError(
      `clawhub download: tar extraction failed (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  const files = await walkFiles(extractedDir);
  return { extractedDir, files: Object.freeze(files) };
}

// ---------------------------------------------------------------------------
// Phase 90 Plan 05 HUB-02 — ClawHub plugin registry.
//
// Parallel to fetchClawhubSkills + downloadClawhubSkill but for plugin
// packages that map to ClawCode `mcpServers` entries (not skill dirs).
//
// Shape note (2026-04-24 live probe of https://clawhub.ai/api/v1/plugins):
//   { "items": [{ name, displayName, summary, latestVersion, runtimeId,
//                 ownerHandle, family, executesCode, capabilityTags[],
//                 channel, verificationTier, ... }], nextCursor: string|null }
//
// The list endpoint returns PACKAGE-LEVEL metadata (browsable catalog);
// the per-package MANIFEST (with command/args/env) is fetched separately
// via downloadClawhubPluginManifest against a package-specific URL. The
// exact manifest URL shape is not enumerated by clawhub yet; we model it
// as an opaque `manifestUrl` field populated downstream from the list
// response (when ClawHub backfills it) or constructed from `runtimeId`.
// Until the registry publishes that URL, the install pipeline returns
// `manifest-invalid` and the Discord UI surfaces the error gracefully.
// ---------------------------------------------------------------------------

/**
 * One plugin item in the ClawHub `/api/v1/plugins` list response.
 *
 * Defensive types: only `name` + `latestVersion` are contractually required;
 * everything else is best-effort surfaced in the Discord picker. If the
 * registry omits `manifestUrl`, the installer falls back to a runtimeId-
 * derived URL (see installClawhubPlugin below).
 */
export type ClawhubPluginListItem = Readonly<{
  name: string;
  latestVersion: string;
  displayName?: string;
  summary?: string;
  description?: string;
  runtimeId?: string;
  ownerHandle?: string;
  family?: string;
  channel?: string;
  capabilityTags?: readonly string[];
  manifestUrl?: string;
}>;

/**
 * Response body shape of `GET /api/v1/plugins?q=...&cursor=...`.
 * Cursor pagination parallels the skills endpoint (D-03).
 */
export type ClawhubPluginsResponse = Readonly<{
  items: readonly ClawhubPluginListItem[];
  nextCursor: string | null;
}>;

/**
 * Plugin manifest JSON shape — per-package. Fetched by manifestUrl (or
 * derived URL). Mirrors the spec in 90-05-PLAN.md interfaces block.
 *
 * `env.<name>.required` is the gate on install-time config collection:
 * missing + no default → outcome "config-missing".
 *
 * `config.fields[]` drives the Discord ModalBuilder (≤5 fields) OR the
 * serial follow-up prompt flow (>5 fields) per D-13.
 */
export type ClawhubPluginManifest = Readonly<{
  name: string;
  description: string;
  version: string;
  command: string;
  args: readonly string[];
  env: Readonly<
    Record<
      string,
      Readonly<{
        default?: string | null;
        required: boolean;
        sensitive: boolean;
        description?: string;
      }>
    >
  >;
  config?: Readonly<{
    fields: readonly Readonly<{
      name: string;
      label: string;
      type: "short" | "paragraph";
      placeholder?: string;
      pattern?: string;
      sensitive: boolean;
    }>[];
  }>;
  dependencies?: Readonly<{ mcpServers?: readonly string[] }>;
}>;

/**
 * GET <baseUrl>/api/v1/plugins?q=<query>&cursor=<cursor>
 *
 * Mirrors fetchClawhubSkills byte-for-byte modulo the URL path + response
 * typing. See fetchClawhubSkills for URL / auth / error-mapping details.
 */
export async function fetchClawhubPlugins(
  args: Readonly<{
    baseUrl: string;
    query?: string;
    cursor?: string;
    authToken?: string;
    deps?: ClawhubClientDeps;
  }>,
): Promise<ClawhubPluginsResponse> {
  const fetchFn = args.deps?.fetch ?? globalThis.fetch;
  const trimmedBase = args.baseUrl.replace(/\/+$/, "");
  const params = new URLSearchParams();
  if (args.query !== undefined && args.query.length > 0) {
    params.set("q", args.query);
  }
  if (args.cursor !== undefined && args.cursor.length > 0) {
    params.set("cursor", args.cursor);
  }
  const qs = params.toString();
  const urlStr = `${trimmedBase}/api/v1/plugins${qs.length > 0 ? `?${qs}` : ""}`;

  const res = await fetchFn(urlStr, {
    headers: buildHeaders(args.authToken),
  });

  if (res.status === 429) {
    const retryAfterMs = parseRetryAfter(res);
    throw new ClawhubRateLimitedError(
      retryAfterMs,
      `clawhub plugins: rate-limited (retry in ${retryAfterMs}ms)`,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new ClawhubAuthRequiredError(
      `clawhub plugins: auth required (status ${res.status})`,
    );
  }
  if (!res.ok) {
    throw new Error(`clawhub plugins: ${res.status} ${res.statusText}`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new ClawhubManifestInvalidError(
      `clawhub plugins: response is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (
    body === null ||
    typeof body !== "object" ||
    !Array.isArray((body as { items?: unknown }).items)
  ) {
    throw new ClawhubManifestInvalidError(
      "clawhub plugins: malformed response (no items[])",
    );
  }
  const parsed = body as ClawhubPluginsResponse;
  return Object.freeze({
    items: Object.freeze(parsed.items.map((i) => Object.freeze(i))),
    nextCursor: parsed.nextCursor ?? null,
  });
}

/**
 * Download + validate one ClawHub plugin manifest. Unlike skills (tarball)
 * plugins are JSON manifests — zero filesystem staging needed; the entire
 * install pipeline works from the parsed manifest + operator-supplied
 * configInputs.
 *
 * Contract:
 *   - 429 → ClawhubRateLimitedError (retryAfterMs)
 *   - 401/403 → ClawhubAuthRequiredError
 *   - other !ok → generic Error with status text
 *   - body missing required fields (name, command) → ClawhubManifestInvalidError
 */
export async function downloadClawhubPluginManifest(
  args: Readonly<{
    manifestUrl: string;
    authToken?: string;
    deps?: ClawhubClientDeps;
  }>,
): Promise<ClawhubPluginManifest> {
  const fetchFn = args.deps?.fetch ?? globalThis.fetch;

  const res = await fetchFn(args.manifestUrl, {
    headers: buildHeaders(args.authToken),
  });

  if (res.status === 429) {
    throw new ClawhubRateLimitedError(
      parseRetryAfter(res),
      `clawhub plugin manifest: rate-limited`,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new ClawhubAuthRequiredError(
      `clawhub plugin manifest: auth required (${res.status})`,
    );
  }
  // Phase 93 Plan 03 — distinguish 404 (registry has not published a
  // manifest for this listed plugin) from malformed-body errors. Lands
  // BEFORE the generic !res.ok fallthrough so 404s never surface as
  // "manifest is invalid" anymore. See RESEARCH §Pitfall 5.
  if (res.status === 404) {
    throw new ClawhubManifestNotFoundError(
      args.manifestUrl,
      404,
      `clawhub plugin manifest: 404 Not Found at ${args.manifestUrl}`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `clawhub plugin manifest: ${res.status} ${res.statusText}`,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new ClawhubManifestInvalidError(
      `clawhub plugin manifest: invalid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  if (
    body === null ||
    typeof body !== "object" ||
    typeof (body as { name?: unknown }).name !== "string" ||
    typeof (body as { command?: unknown }).command !== "string"
  ) {
    throw new ClawhubManifestInvalidError(
      "clawhub plugin manifest: missing required name/command",
    );
  }
  const m = body as ClawhubPluginManifest;
  return Object.freeze({
    name: m.name,
    description: m.description ?? "",
    version: m.version ?? "0.0.0",
    command: m.command,
    args: Object.freeze([...(m.args ?? [])]),
    env: Object.freeze({ ...(m.env ?? {}) }),
    ...(m.config !== undefined ? { config: m.config } : {}),
    ...(m.dependencies !== undefined ? { dependencies: m.dependencies } : {}),
  });
}
