/**
 * 999.151 — how long something took, in words a person reads at a glance.
 *
 * Its own module because BOTH annotation families need it and neither should
 * depend on the other: the live status card (`hold-status.ts`) puts elapsed
 * time in its header, and the delivered reply's footer (`sources-footer.ts`)
 * ends on the turn's duration. `sources-footer.ts` is documented as pure — no
 * discord.js, no `Date` — and this module keeps that promise: every input is
 * a number the caller measured.
 */

/** Below this the status header says nothing — a 2s turn does not need a clock. */
export const ELAPSED_HEADER_FLOOR_SECS = 5;

/**
 * `296s` (what the footer used to print) makes the reader do arithmetic;
 * `4m 56s` does not.
 *   - under a minute  → `36s`
 *   - under an hour   → `4m`, or `4m 56s` when `precise`
 *   - beyond          → `1h 4m`
 */
export function formatDuration(
  seconds: number,
  opts: { readonly precise?: boolean } = {},
): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const mins = Math.floor(total / 60);
  if (mins < 60) {
    const rem = total % 60;
    return opts.precise === true && rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
  }
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}

/** Status-header elapsed: silent for the first few seconds, coarse after that. */
export function formatElapsed(elapsedMs: number): string {
  const secs = Math.round(elapsedMs / 1000);
  return secs < ELAPSED_HEADER_FLOOR_SECS ? "" : formatDuration(secs);
}
