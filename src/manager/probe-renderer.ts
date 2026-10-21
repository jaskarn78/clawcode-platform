/**
 * Phase 94 Plan 07 — pure renderer helpers for the capability-probe surface.
 *
 * Shared between two operator UIs that must show identical content for the
 * same input snapshot:
 *   - `/clawcode-tools` Discord slash (src/discord/slash-commands.ts)
 *   - `clawcode mcp-status` CLI    (src/cli/commands/mcp-status.ts)
 *
 * Exports:
 *   - STATUS_EMOJI: 5-key map (ready|degraded|reconnecting|failed|unknown)
 *   - EMBED_LINE_CAP: Discord embed field-count cap (25)
 *   - recoverySuggestionFor(error): match capability-probe error against the
 *     auto-recovery patterns owned by Plan 94-03; surface what auto-recovery
 *     WOULD do so operators see the planned action without having to dig
 *     through logs. Renderer does NOT trigger recovery itself.
 *   - buildProbeRow(serverName, state, alternatives, now): pure factory
 *     producing a frozen ProbeRowOutput per server. Deterministic over
 *     inputs (cache stability + cross-renderer parity test pin).
 *   - paginateRows(rows, pageSize): pure pagination helper. Splits the row
 *     list into 25-server pages so the embed can ship under Discord's
 *     hard cap of 25 fields per embed (D-11).
 *
 * Static-grep regression pins enforce purity (no fs/SDK/clock/logger
 * imports), 5-status-emoji coverage, and the EMBED_LINE_CAP literal.
 *
 * Recovery-suggestion mapping intentionally duplicates 94-03's
 * RECOVERY_REGISTRY match logic at the surface layer — the renderer
 * surfaces what auto-recovery WOULD do without coupling the slash/CLI
 * code to the recovery handler module graph. If 94-03 patterns change,
 * update both places (the duplication is small and explicit).
 */

import { formatDistance } from "date-fns";
import type { CapabilityProbeStatus } from "../mcp/readiness.js";

/**
 * Per-server capability-probe snapshot shape carried in the
 * `list-mcp-status` IPC payload (Phase 94 Plan 01 extension).
 *
 * Mirrored locally instead of importing the heavyweight readiness module
 * graph — the renderer only needs the probe block fields.
 */
export type ProbeSnapshot = {
  readonly lastRunAt: string;
  readonly status: CapabilityProbeStatus;
  readonly error?: string;
  readonly lastSuccessAt?: string;
};

/**
 * Status → emoji map. All 5 capability-probe statuses are represented;
 * adding a 6th status to the contract requires touching this map and the
 * downstream consumers (Plans 94-02/03/04/07).
 *
 * Pinned by static-grep: `grep -E "ready:|degraded:|reconnecting:|failed:|unknown:" probe-renderer.ts | wc -l` ≥ 5.
 */
export const STATUS_EMOJI: Record<CapabilityProbeStatus, string> = {
  ready: "\u2705",                // ✅
  degraded: "\u{1F7E1}",          // 🟡
  reconnecting: "\u23F3",         // ⏳
  failed: "\u{1F534}",            // 🔴
  unknown: "\u26AA",              // ⚪
};

/**
 * Discord's per-embed field-count cap is 25. The slash renderer paginates
 * via select-menu when the snapshot has more than 25 servers; the CLI
 * doesn't paginate (terminal can scroll).
 *
 * Pinned by static-grep: `grep -q "EMBED_LINE_CAP = 25" probe-renderer.ts`.
 */
export const EMBED_LINE_CAP = 25;

/**
 * Pure: derive the recovery-suggestion string from a capability-probe
 * error message. Matches the auto-recovery handler patterns owned by
 * Plan 94-03 at the renderer surface so operators see what auto-recovery
 * WOULD do.
 *
 * Returns null when:
 *   - error is undefined/empty
 *   - no known pattern matches (operator must inspect verbatim error)
 *
 * Pattern set (kept in sync with 94-03 RECOVERY_REGISTRY):
 *   1. Playwright Chromium missing
 *   2. op:// reference auth failures
 */
export function recoverySuggestionFor(error: string | undefined): string | null {
  if (!error) return null;
  if (/Executable doesn't exist at.*ms-playwright/i.test(error)) {
    return "auto-recovery: npx playwright install chromium";
  }
  if (/op:\/\/.*not authorized|service account/i.test(error)) {
    return "auto-recovery: refresh op:// references";
  }
  return null;
}

/**
 * One row's worth of rendered probe data. Frozen — consumers cannot
 * mutate the alternatives array or the row itself (CLAUDE.md
 * immutability rule).
 */
export interface ProbeRowOutput {
  readonly serverName: string;
  readonly statusEmoji: string;
  readonly status: CapabilityProbeStatus;
  readonly lastSuccessIso: string | null;
  readonly lastSuccessRelative: string | null;
  readonly recoverySuggestion: string | null;
  readonly alternatives: readonly string[];
}

/**
 * Minimal McpServerState-like shape used by the renderer. Both the IPC
 * payload (CLI / slash) and synthetic test snapshots can satisfy it
 * without depending on the full readiness module graph.
 */
export type ProbeRowState = {
  readonly capabilityProbe?: ProbeSnapshot;
};

/**
 * Pure: build one row from raw IPC fields + alternatives lookup.
 *
 * Behavior:
 *   - status defaults to "unknown" when capabilityProbe is absent
 *   - lastSuccessIso preserves the ISO string verbatim (no reformatting)
 *   - lastSuccessRelative is rendered via date-fns formatDistanceToNow
 *     against the caller-supplied `now` (deterministic for tests)
 *   - recoverySuggestion is null for ready servers (we don't suggest
 *     recovery for things that aren't broken)
 *   - alternatives are surfaced ONLY for non-ready servers — for ready
 *     servers the line is information overload, so we drop it
 *
 * Result is Object.freeze'd; the alternatives array is also Object.freeze'd.
 */
export function buildProbeRow(
  serverName: string,
  state: ProbeRowState,
  alternatives: readonly string[],
  now: Date,
): ProbeRowOutput {
  const probe = state.capabilityProbe;
  const status: CapabilityProbeStatus = probe?.status ?? "unknown";
  const statusEmoji = STATUS_EMOJI[status];
  const lastSuccessIso = probe?.lastSuccessAt ?? null;
  let lastSuccessRelative: string | null = null;
  if (lastSuccessIso) {
    const d = new Date(lastSuccessIso);
    const ts = d.getTime();
    if (!Number.isNaN(ts)) {
      // date-fns formatDistance(date, baseDate) — pure, takes both dates
      // explicitly so the renderer is deterministic for tests using a
      // synthetic `now`. Avoid formatDistanceToNow which reads the
      // system clock.
      lastSuccessRelative = formatDistance(d, now, { addSuffix: true });
    }
  }
  const recoverySuggestion =
    status === "ready" ? null : recoverySuggestionFor(probe?.error);
  const altsForRender: readonly string[] =
    status !== "ready" && alternatives.length > 0
      ? Object.freeze<string[]>([...alternatives])
      : Object.freeze<string[]>([]);

  return Object.freeze({
    serverName,
    statusEmoji,
    status,
    lastSuccessIso,
    lastSuccessRelative,
    recoverySuggestion,
    alternatives: altsForRender,
  });
}

/**
 * Pure: split a row list into pages of `pageSize` rows each. Used by the
 * Discord slash renderer to keep each embed under Discord's 25-field cap
 * (D-11). The CLI calls this with pageSize === rows.length so it gets
 * exactly one page.
 *
 * Empty input → `[[]]` (one empty page); callers can render "no servers"
 * messaging when the first page is empty.
 */
export function paginateRows(
  rows: readonly ProbeRowOutput[],
  pageSize: number,
): readonly (readonly ProbeRowOutput[])[] {
  if (rows.length === 0) {
    const emptyPage: readonly ProbeRowOutput[] = Object.freeze<ProbeRowOutput[]>([]);
    return Object.freeze([emptyPage]);
  }
  const pages: ProbeRowOutput[][] = [];
  const size = Math.max(1, pageSize);
  for (let i = 0; i < rows.length; i += size) {
    pages.push(rows.slice(i, i + size));
  }
  const frozenPages: (readonly ProbeRowOutput[])[] = pages.map((p) =>
    Object.freeze<ProbeRowOutput[]>(p),
  );
  return Object.freeze(frozenPages);
}
