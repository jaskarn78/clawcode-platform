/**
 * Phase 999.42 capability C D5 — semver bump locus.
 *
 * The patch artifact declares `patchClass`; `applyPatch` computes the new
 * version here; the body's own `version:` must match (LLM hallucination
 * guard). This is a pure module — no I/O — mirroring how Phase 132 split
 * `skill-distiller-fingerprint.ts` / `skill-distiller-eligibility.ts`.
 *
 * Bump mapping (D5):
 *   - patch    — body/steps refinement       → M.m.p   → M.m.p+1
 *   - edit     — trigger/description/tools    → M.m.p   → M.m+1.0
 *   - breaking — incompatible trigger change  → M.m.p   → M+1.0.0
 */

export type PatchClass = "patch" | "edit" | "breaking";

/**
 * Strict semver `M.m.p`. Pre-release / build metadata rejected.
 *
 * NOTE: kept byte-identical to the `SEMVER` constant in
 * `src/plugin-sdk/manifest-schema.ts` — that module does not export it.
 * The two MUST stay in sync; if one changes, change the other.
 */
const SEMVER = /^\d+\.\d+\.\d+$/;

/** Parse a strict-semver string into `[major, minor, patch]`. */
function parseSemver(version: string): [number, number, number] {
  if (!SEMVER.test(version)) {
    throw new Error(
      `skill-patch-version: "${version}" is not strict semver M.m.p`,
    );
  }
  const [major, minor, patch] = version.split(".").map((n) => Number(n));
  return [major!, minor!, patch!];
}

/**
 * Compute the bumped version for a given `patchClass`.
 *
 * Throws if `current` is not strict semver, or if `patchClass` is not one of
 * the three known values (defends the exhaustive switch at runtime).
 */
export function bumpVersion(current: string, patchClass: PatchClass): string {
  const [major, minor, patch] = parseSemver(current);
  switch (patchClass) {
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    case "edit":
      return `${major}.${minor + 1}.0`;
    case "breaking":
      return `${major + 1}.0.0`;
    default: {
      // Exhaustiveness guard — unreachable for a well-typed caller.
      const exhaustive: never = patchClass;
      throw new Error(
        `skill-patch-version: unknown patchClass "${String(exhaustive)}"`,
      );
    }
  }
}

/**
 * Returns `true` iff `proposed` is exactly `bumpVersion(current, patchClass)`.
 *
 * Never throws — a non-semver `current` or `proposed` yields `false`. This is
 * the apply-time guard against an LLM hallucinating the wrong version number
 * in the patch body's frontmatter.
 */
export function validateBumpedVersion(
  current: string,
  proposed: string,
  patchClass: PatchClass,
): boolean {
  if (!SEMVER.test(current) || !SEMVER.test(proposed)) {
    return false;
  }
  try {
    return proposed === bumpVersion(current, patchClass);
  } catch {
    return false;
  }
}
