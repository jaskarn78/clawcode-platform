/**
 * Phase 88 Plan 01 MKT-02 — read-only marketplace catalog.
 *
 * Unions ClawCode local skills (scanned from `localSkillsPath` via
 * Phase 83+ `scanSkillsDirectory`) with every configured legacy source
 * (scanned via Phase 84 `discoverOpenclawSkills`) into a single
 * deduplicated, alphabetically-sorted `MarketplaceEntry[]` ready for
 * Plan 02's Discord `/clawcode-skills-browse` picker.
 *
 * Contract:
 *   - Local entries win on name collision (Plan 02 must never show two
 *     rows with the same skill name; ambiguity breaks the install flow).
 *   - Only legacy skills classified `p1` OR `p2` are advertised;
 *     `deprecate` is NEVER shown (hard gate — deprecated skills must
 *     not be reachable from the install UI).
 *   - `unknown` classification is also skipped (pre-curated P1/P2 list
 *     is the only v2.2 marketplace source; unknown skills need operator
 *     review before they surface).
 *   - Non-existent source paths degrade gracefully: log.warn + continue.
 *     `discoverOpenclawSkills` already handles this (returns []); we
 *     wrap any remaining read errors in a try/catch so a hostile
 *     filesystem can never throw past the loader.
 *   - Output is sorted alphabetically by name (deterministic Discord
 *     menu ordering across reloads; stable `customId` seeds).
 *
 * Scope:
 *   - Read-only. Does NOT invoke secret-scan, copier, or ledger.
 *     Install-time gates live in `install-single-skill.ts` (Task 2).
 *   - Does NOT compute source hashes. Hash computation is deferred to
 *     install time where it feeds the idempotency gate (cheaper: one
 *     hash per install, not per browse).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import {
  discoverOpenclawSkills,
  type SkillClassification,
} from "../migration/skills-discovery.js";
import { SCOPE_TAGS } from "../migration/skills-scope-tags.js";
import type { ResolvedMarketplaceSources } from "../shared/types.js";
import { scanSkillsDirectory } from "../skills/scanner.js";
import {
  ClawhubAuthRequiredError,
  ClawhubRateLimitedError,
  fetchClawhubSkills,
  type ClawhubSkillListItem,
} from "./clawhub-client.js";

/**
 * One advertised skill in the browser-facing catalog.
 *
 * `source` discriminates local vs legacy: Discord menu renders the label
 * prefix, and the install handler uses the same field to route scope-tag
 * classification + skillDir provenance.
 */
export type MarketplaceEntry = Readonly<{
  name: string;
  description: string;
  category: "acme" | "personal" | "fleet";
  /**
   * Phase 88 MKT-02 + Phase 90 Plan 04 HUB-01 — source discriminant.
   *
   * - "local"                                    → local skills directory
   * - { path, label? }                           → legacy filesystem source
   *                                                (OpenClaw skill library)
   * - { kind: "clawhub", baseUrl, downloadUrl,   → ClawHub registry source;
   *     authToken?, version }                      skillDir is "" until
   *                                                install-time staging
   *                                                (Plan 90-04 Task 2).
   */
  source:
    | "local"
    | Readonly<{ path: string; label?: string }>
    | Readonly<{
        kind: "clawhub";
        baseUrl: string;
        downloadUrl: string;
        authToken?: string;
        version: string;
      }>;
  /**
   * Absolute path to the skill's source directory (used by install-time
   * copier). Empty string for ClawHub entries — the installer resolves
   * this by downloading + extracting into a staging dir.
   */
  skillDir: string;
  /** Only set for legacy-source entries — local ones are curated. */
  classification?: SkillClassification;
}>;

export type LoadMarketplaceCatalogOpts = Readonly<{
  /** Absolute, already-expandHome'd path to the ClawCode local skills dir. */
  localSkillsPath: string;
  /**
   * Phase 88 MKT-02 + Phase 90 Plan 04 HUB-01 — discriminated-union source
   * list. Legacy entries (kind: "legacy") carry a filesystem path; ClawHub
   * entries (kind: "clawhub") carry a registry baseUrl. Plan 90-04 Task 2
   * adds the ClawHub branch to the loader body.
   *
   * Backward-compat note: older callers passing a plain `{path, label?}[]`
   * (pre-Phase-90 shape) are still accepted — the loader's legacy branch
   * accepts either `kind: "legacy"` OR the bare shape (produced by
   * resolveMarketplaceSources for v2.2 configs where kind is implicit).
   */
  sources:
    | ResolvedMarketplaceSources
    | readonly { path: string; label?: string }[];
  log?: Logger;
  /**
   * Phase 93 Plan 02 D-93-02-1 — when sources contains no `kind:"clawhub"`
   * entry AND this field is provided, the loader synthesizes a public
   * (no authToken) ClawHub source before the iteration loop. Honors
   * existing cacheTtlMs default. Back-compat: undefined → no-op.
   */
  defaultClawhubBaseUrl?: string;
}>;

const DESCRIPTION_CAP = 100; // Discord StringSelectMenuOption description cap
const DESCRIPTION_FALLBACK = "(no description available)";

/**
 * Truncate a description to the StringSelectMenuOption 100-char cap used
 * by Phase 86 Plan 03's picker. Single-line (collapses internal
 * whitespace). Preserves short descriptions verbatim.
 */
function truncateDescription(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (collapsed.length <= DESCRIPTION_CAP) return collapsed;
  // Reserve 3 chars for the ellipsis so the total stays at DESCRIPTION_CAP.
  return `${collapsed.slice(0, DESCRIPTION_CAP - 3)}...`;
}

/**
 * Extract the first non-heading, non-frontmatter line of a SKILL.md body
 * as a description. Returns DESCRIPTION_FALLBACK on read failure or when
 * the file has no usable body text. Used for legacy sources where the
 * Phase 84 discovery layer does not parse frontmatter (it hashes + filters
 * only).
 */
async function readLegacyDescription(skillDir: string): Promise<string> {
  const skillMd = join(skillDir, "SKILL.md");
  let content: string;
  try {
    content = await readFile(skillMd, "utf8");
  } catch {
    return DESCRIPTION_FALLBACK;
  }
  // Strip frontmatter if present (matches Phase 84 transformer regex).
  const withoutFrontmatter = content.replace(/^---\n(?:[\s\S]*?\n)?---\n*/, "");
  const lines = withoutFrontmatter.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // Skip markdown headings — the body's first paragraph is more useful.
    // An all-hash line like "# frontend-design" is redundant with `name`.
    if (/^#+\s/.test(trimmed)) continue;
    return trimmed;
  }
  return DESCRIPTION_FALLBACK;
}

/**
 * Convert a ClawHub list item into a MarketplaceEntry. ClawHub skills
 * default to the `fleet` category because the registry's `category` field
 * is free-form (productivity, ai, etc.) and doesn't map cleanly onto the
 * Phase 84 scope tags (acme/personal/fleet). The scope gate
 * (canLinkSkillToAgent) enforces the narrower check at install time.
 */
function clawhubItemToEntry(
  item: ClawhubSkillListItem,
  src: Readonly<{
    kind: "clawhub";
    baseUrl: string;
    authToken?: string;
    cacheTtlMs?: number;
  }>,
): MarketplaceEntry {
  const sourceDescriptor: MarketplaceEntry["source"] = Object.freeze({
    kind: "clawhub" as const,
    baseUrl: src.baseUrl,
    downloadUrl: item.downloadUrl,
    version: item.version,
    ...(src.authToken !== undefined ? { authToken: src.authToken } : {}),
  });
  return Object.freeze({
    name: item.name,
    description: truncateDescription(item.description || DESCRIPTION_FALLBACK),
    category: "fleet" as const,
    source: sourceDescriptor,
    skillDir: "", // Resolved at install-time via downloadClawhubSkill staging.
  });
}

/**
 * Load the unioned marketplace catalog for a given local skills dir and
 * set of legacy sources.
 *
 * Algorithm:
 *   1. Scan the local skills dir via `scanSkillsDirectory` (Phase 83+).
 *      Each local `SkillEntry` becomes a `MarketplaceEntry` with
 *      source:"local" and category derived from `SCOPE_TAGS` (default fleet).
 *   2. For each legacy source, call `discoverOpenclawSkills` (Phase 84).
 *      Keep only entries whose classification is "p1" or "p2".
 *      Skip entries whose name is already in the dedup Map — local wins.
 *   3. Sort alphabetically by name and freeze the array for downstream
 *      consumers.
 */
export async function loadMarketplaceCatalog(
  opts: LoadMarketplaceCatalogOpts,
): Promise<readonly MarketplaceEntry[]> {
  const byName = new Map<string, MarketplaceEntry>();

  // --- Step 1: local skills -----------------------------------------
  let localCatalog: Awaited<ReturnType<typeof scanSkillsDirectory>>;
  try {
    localCatalog = await scanSkillsDirectory(opts.localSkillsPath, opts.log);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.log?.warn(
      { localSkillsPath: opts.localSkillsPath, err: msg },
      "loadMarketplaceCatalog: failed to scan local skills; continuing with legacy sources only",
    );
    localCatalog = new Map();
  }

  for (const [name, entry] of localCatalog) {
    const category = SCOPE_TAGS.get(name) ?? "fleet";
    byName.set(name, {
      name,
      description: truncateDescription(entry.description || DESCRIPTION_FALLBACK),
      category,
      source: "local",
      skillDir: entry.path,
    });
  }

  // --- Step 2: legacy + clawhub sources (union; local wins on collision) --
  // Phase 90 Plan 04 HUB-01 — discriminate on `kind`. ClawHub entries
  // trigger a cursor-less first-page fetch via `fetchClawhubSkills`; each
  // item becomes a MarketplaceEntry with source.kind="clawhub" and
  // skillDir="" (install-time staging resolves the actual directory).
  //
  // Error handling matches HUB-CAT-4/HUB-CAT-5 behavior:
  //   - ClawhubRateLimitedError → log.warn + skip (zero entries from this
  //     source this call); caller's cache marks the 429 window
  //     (integration deferred to Plan 90-05 /clawcode-skills-browse).
  //   - ClawhubAuthRequiredError → log.warn + skip (ditto; operator
  //     eventually re-auths via Plan 90-06).
  //   - Other errors → log.warn + skip (no source kills the whole catalog).

  // Phase 93 Plan 02 D-93-02-1 — auto-inject default ClawHub source when:
  //   (a) opts.defaultClawhubBaseUrl is provided AND
  //   (b) opts.sources contains no kind:"clawhub" entry.
  // Synthetic source is appended (after locals, before legacy/explicit
  // sources are processed). Public access only — no authToken. opts.sources
  // is NEVER mutated; we build a new array for the iteration.
  // `opts.sources` is a union of two readonly array shapes. `Array.from`
  // can't pick a single overload across the union, so spread into a new
  // array typed as the union's element type. Behaviour is identical to
  // `Array.from(opts.sources)` — same iteration order, same elements.
  type SourceElement = (typeof opts.sources)[number];
  const sourcesArr: SourceElement[] = [...(opts.sources as readonly SourceElement[])];
  const hasExplicitClawhub = sourcesArr.some(
    (s) =>
      typeof s === "object" &&
      s !== null &&
      "kind" in s &&
      (s as { kind?: unknown }).kind === "clawhub",
  );
  if (
    opts.defaultClawhubBaseUrl !== undefined &&
    opts.defaultClawhubBaseUrl.length > 0 &&
    !hasExplicitClawhub
  ) {
    sourcesArr.push(
      Object.freeze({
        kind: "clawhub" as const,
        baseUrl: opts.defaultClawhubBaseUrl,
      }) as unknown as (typeof opts.sources)[number],
    );
    opts.log?.info(
      { baseUrl: opts.defaultClawhubBaseUrl },
      "loadMarketplaceCatalog: auto-injecting default clawhub source",
    );
  }

  for (const source of sourcesArr) {
    // ClawHub branch — fetch the first page of skills and union.
    if ("kind" in source && source.kind === "clawhub") {
      try {
        const resp = await fetchClawhubSkills({
          baseUrl: source.baseUrl,
          ...(source.authToken !== undefined
            ? { authToken: source.authToken }
            : {}),
        });
        for (const item of resp.items) {
          // Defensive: skip entries whose `name` is missing/empty. The
          // ClawHub registry treats `name` as required but real-world
          // 2026-05-04 traffic surfaced an item with `name === undefined`
          // (caught by the daemon error log: "Cannot read properties of
          // undefined (reading 'localeCompare')" at the Step-3 sort).
          // Skipping at ingestion keeps the sort total + the operator
          // still sees the rest of the catalog instead of an empty list.
          if (typeof item.name !== "string" || item.name.length === 0) {
            opts.log?.warn(
              { source: source.baseUrl, item: { ...item, name: item.name } },
              "loadMarketplaceCatalog: clawhub item missing name; skipping",
            );
            continue;
          }
          // Local wins — skip if name collision.
          if (byName.has(item.name)) continue;
          byName.set(item.name, clawhubItemToEntry(item, source));
        }
      } catch (err) {
        if (err instanceof ClawhubRateLimitedError) {
          opts.log?.warn(
            { retryAfterMs: err.retryAfterMs, source: source.baseUrl },
            "loadMarketplaceCatalog: clawhub rate-limited; skipping source",
          );
        } else if (err instanceof ClawhubAuthRequiredError) {
          opts.log?.warn(
            { source: source.baseUrl },
            "loadMarketplaceCatalog: clawhub auth-required; skipping source",
          );
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          opts.log?.warn(
            { source: source.baseUrl, err: msg },
            "loadMarketplaceCatalog: clawhub fetch failed; skipping source",
          );
        }
      }
      continue;
    }
    // Narrow to the legacy shape. Works for both {kind:"legacy", path,
    // label?} and the pre-Phase-90 {path, label?} bare shape.
    const legacy = source as { path: string; label?: string };

    let discovered: Awaited<ReturnType<typeof discoverOpenclawSkills>>;
    try {
      discovered = await discoverOpenclawSkills(legacy.path);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      opts.log?.warn(
        { source: legacy.path, err: msg },
        "loadMarketplaceCatalog: failed to read source; continuing",
      );
      continue;
    }

    for (const skill of discovered) {
      // Filter: only p1/p2 surface to the marketplace.
      if (skill.classification !== "p1" && skill.classification !== "p2") {
        continue;
      }
      // Local wins — skip if name collision.
      if (byName.has(skill.name)) continue;

      const description = await readLegacyDescription(skill.path);
      const category = SCOPE_TAGS.get(skill.name) ?? "fleet";
      const sourceDescriptor =
        legacy.label !== undefined
          ? Object.freeze({ path: legacy.path, label: legacy.label })
          : Object.freeze({ path: legacy.path });
      byName.set(skill.name, {
        name: skill.name,
        description: truncateDescription(description),
        category,
        source: sourceDescriptor,
        skillDir: skill.path,
        classification: skill.classification,
      });
    }
  }

  // --- Step 3: deterministic sort -----------------------------------
  // Defensive: filter out entries with missing `name` BEFORE the sort.
  // Step 1 + Step 2 ingestion already filter on `name`, but a future
  // source path could regress; a missing name here would crash the
  // entire operator-facing /clawcode-skills-browse with an opaque
  // "Cannot read properties of undefined (reading 'localeCompare')".
  const entries = [...byName.values()]
    .filter((e) => typeof e.name === "string" && e.name.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
  return Object.freeze(entries);
}
