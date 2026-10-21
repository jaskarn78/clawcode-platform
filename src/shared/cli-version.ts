/**
 * Claude Code CLI version parsing + comparison.
 *
 * Phase 999.159 — WHY THIS EXISTS. Anthropic enforces a per-model MINIMUM CLI
 * version, and it enforces it against the version the client CLAIMS on the
 * wire. Ship code whose model pins need a newer CLI than the installed binary
 * and every turn fails with `400 ... does not support this model; version
 * 2.1.280 or newer is required` — a per-turn outage with no local signal.
 *
 * That happened twice with an identical shape:
 *   - 2026-09-01: binary 2.1.158 → 2.1.257 for Fable 5.1; the claimed version
 *     stayed 2.1.158 and every `claude-fable-5-1` turn 400'd.
 *   - 2026-09-22: binary 2.1.257 → 2.1.280 for Opus 5.5; same shape, every
 *     `claude-opus-5-5` turn 400'd.
 *
 * Both times the requirement was recorded only as a CODE COMMENT ("Requires
 * CLI >= 2.1.280. Bump the binary BEFORE this ships"). A comment is not a
 * control. `minCliVersion` in `MODEL_ALIAS_CATALOG` makes the requirement data,
 * and this module makes it comparable so the daemon can refuse to boot on a
 * binary that cannot serve the configured models.
 *
 * Leaf module — imports NOTHING from the project, so config/manager/cli can all
 * import it without a cycle (same discipline as `model-catalog.ts`).
 */

/**
 * The shape `claude --version` emits: `"2.1.280 (Claude Code)"`.
 *
 * Parses AT MOST three segments — `MAJOR.MINOR.PATCH` — and ignores everything
 * after them.
 *
 * 🚨 The 3-segment cap is deliberate, and it is the fix for a bug this function
 * shipped with. The wire `cc_version` carries a per-build suffix
 * (`2.1.158.7ab`) which is NOT a version-ordering component and is NOT
 * derivable — it only ever comes from a wire capture. A greedy numeric run
 * parses that as `[2, 1, 158, 7]`, which then compares GREATER than the floor
 * `2.1.158` — a build suffix silently promoting a version. Capping at three
 * makes the suffix irrelevant whether or not it starts with a digit.
 *
 * `minCliVersion` in the catalog is `MAJOR.MINOR.PATCH` by contract, and every
 * observed Anthropic floor ("version 2.1.280 or newer is required") is too, so
 * three segments is the whole comparable surface.
 */
export function parseCliVersion(raw: string): readonly number[] | null {
  const match = /(\d+(?:\.\d+)*)/.exec(raw.trim());
  if (match === null) return null;
  const parts = match[1]!
    .split(".")
    .slice(0, 3)
    .map((p) => Number.parseInt(p, 10));
  if (parts.length === 0 || parts.some((n) => Number.isNaN(n))) return null;
  return Object.freeze(parts);
}

/**
 * Numeric, segment-wise comparison. Returns <0 / 0 / >0 like a sort
 * comparator, or `null` when either side is unparseable — callers must decide
 * what an unknown version means rather than getting a silent `0`.
 *
 * 🚨 This is the two-digit trap the outages hid behind: a naive string compare
 * puts `"2.1.9"` ABOVE `"2.1.280"` because `"9" > "2"` lexically. Segments are
 * compared as NUMBERS. Missing segments read as 0, so `2.1` === `2.1.0`.
 */
export function compareCliVersions(a: string, b: string): number | null {
  const pa = parseCliVersion(a);
  const pb = parseCliVersion(b);
  if (pa === null || pb === null) return null;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

/**
 * `true` when `installed` is at least `minimum`, `false` when it is older, and
 * `null` when either is unparseable.
 *
 * `null` is NOT a pass. The caller decides — the boot guard treats it as
 * "cannot prove compatibility" and warns loudly rather than failing the fleet
 * on an unprobeable binary (a failed `--version` probe must never be the thing
 * that keeps 8 agents down).
 */
export function cliVersionSatisfies(installed: string, minimum: string): boolean | null {
  const cmp = compareCliVersions(installed, minimum);
  return cmp === null ? null : cmp >= 0;
}

/** Normalized `MAJOR.MINOR.PATCH` form for logs, or the raw string if unparseable. */
export function formatCliVersion(raw: string): string {
  const parsed = parseCliVersion(raw);
  return parsed === null ? raw : parsed.join(".");
}
