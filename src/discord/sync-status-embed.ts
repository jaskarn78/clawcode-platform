/**
 * Phase 91 Plan 05 SYNC-08 — /clawcode-sync-status Discord slash EmbedBuilder.
 *
 * Pure function + helpers for rendering the OpenClaw ↔ ClawCode sync state as
 * a Discord EmbedBuilder. Mirrors the Phase 85 /clawcode-tools blueprint: all
 * logic lives in a pure (zero I/O) module consumed by the inline slash handler
 * in slash-commands.ts after fetching the snapshot via the daemon-routed
 * `list-sync-status` IPC method.
 *
 * Colour vocabulary (Phase 91-02 precedent):
 *   - EMBED_COLOR_HAPPY    = 3066993  (Discord green) — last cycle succeeded
 *                                                     AND no open conflicts
 *   - EMBED_COLOR_CONFLICT = 15158332 (Discord red)   — one or more open
 *                                                     conflicts (reuse the
 *                                                     CONFLICT_EMBED_COLOR
 *                                                     from Phase 91-02
 *                                                     sync/conflict-alerter.ts
 *                                                     so the conflict-alert
 *                                                     embed and the status
 *                                                     embed speak the same
 *                                                     visual language)
 *   - EMBED_COLOR_WARN     = 15844367 (Discord yellow) — last cycle was not
 *                                                      synced (failed-ssh,
 *                                                      failed-rsync, paused,
 *                                                      never-run) but no
 *                                                      operator-facing
 *                                                      conflicts exist
 *
 * Rationale for a dedicated embed module (vs inline in slash-commands.ts):
 *   - Unit-testable in isolation (16 tests here vs threading Discord mocks
 *     through the slash handler test suite).
 *   - Reusable by future dashboard / CLI renderers that want the same
 *     visual vocabulary without reaching through the slash-command surface.
 *   - Keeps slash-commands.ts focused on dispatch, not rendering.
 *
 * Field cap — Discord's embed field limit is 25. For sync, that's an upper
 * bound on per-conflict detail fields; we slice to 25 with a terminal fact
 * "… N more conflicts" field only when we've truncated so the operator
 * knows the list isn't complete.
 */

import { EmbedBuilder } from "discord.js";
import type { SyncConflict } from "../sync/types.js";

/** Phase 91-02 blueprint — red = divergence hazard signal. */
export const EMBED_COLOR_CONFLICT = 15158332;

/** Discord green — happy path (synced + zero unresolved conflicts). */
export const EMBED_COLOR_HAPPY = 3066993;

/** Discord yellow — non-conflict warning (paused, failed-ssh, never-run). */
export const EMBED_COLOR_WARN = 15844367;

/** Discord's per-embed field cap. */
export const DISCORD_EMBED_FIELD_CAP = 25;

/**
 * Flat summary of the last sync.jsonl line, as returned by the `list-sync-status`
 * IPC method. Fields are optional because different SyncRunOutcome variants
 * (paused, failed-ssh) populate different subsets; the status string is the
 * discriminator.
 */
export type LastCycleSummary = Readonly<{
  cycleId: string;
  status: string;
  filesAdded?: number;
  filesUpdated?: number;
  filesRemoved?: number;
  filesSkippedConflict?: number;
  bytesTransferred?: number;
  durationMs: number;
  timestamp: string;
  error?: string;
  reason?: string;
}>;

/**
 * Input shape for buildSyncStatusEmbed — pure snapshot, no I/O.
 *
 * `now` is injected (not read from `Date.now()`) so tests pin relative-time
 * output deterministically.
 */
export type SyncStatusEmbedInput = Readonly<{
  authoritativeSide: "openclaw" | "clawcode";
  lastSyncedAt: string | null;
  conflicts: readonly SyncConflict[];
  lastCycle: LastCycleSummary | null;
  now: Date;
}>;

/**
 * Build the /clawcode-sync-status EmbedBuilder from a persisted-state snapshot.
 *
 * Contract:
 *   - Zero I/O (pure function). No `Date.now()`, no `readFile`, no network.
 *   - Deterministic output for a given input.
 *   - Colour driven by conflict count first, last-cycle status second.
 *   - Title adapts to conflict presence ("🔄 Sync status" vs "⚠️ Sync status
 *     — fin-client (N conflicts)").
 *   - Resolve-command hint appears in the description ONLY when conflicts > 0
 *     (operators don't need the hint on happy-path cycles).
 *   - Conflict detail fields cap at DISCORD_EMBED_FIELD_CAP (25). If more
 *     exist, a terminal "… N more conflicts" field replaces the last visible
 *     conflict entry so the operator knows the list is truncated (vs assuming
 *     only 25 conflicts exist in sync-state.json).
 */
export function buildSyncStatusEmbed(
  input: SyncStatusEmbedInput,
): EmbedBuilder {
  const conflictCount = input.conflicts.length;
  const hasConflicts = conflictCount > 0;
  const lastCycleStatus = input.lastCycle?.status ?? "never-run";

  const color = hasConflicts
    ? EMBED_COLOR_CONFLICT
    : lastCycleStatus === "synced" || lastCycleStatus === "skipped-no-changes"
      ? EMBED_COLOR_HAPPY
      : EMBED_COLOR_WARN;

  const title = hasConflicts
    ? `⚠️ Sync status — fin-client (${conflictCount} conflict${conflictCount === 1 ? "" : "s"})`
    : "🔄 Sync status — fin-client";

  const direction =
    input.authoritativeSide === "openclaw"
      ? "openclaw → clawcode"
      : "clawcode → openclaw (post-cutover)";

  const descriptionLines: string[] = [
    `Authoritative: **${input.authoritativeSide}** (${direction})`,
    `Last cycle: **${lastCycleStatus}**${relativeTimeSuffix(
      input.lastCycle?.timestamp,
      input.now,
    )}`,
  ];

  if (hasConflicts) {
    descriptionLines.push("");
    descriptionLines.push(
      "**Resolve via** `clawcode sync resolve <path> --side openclaw|clawcode`",
    );
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(descriptionLines.join("\n"))
    .setColor(color);

  if (hasConflicts) {
    // Truncate to the 25-field cap; if we've had to truncate, the last
    // visible slot becomes a "… N more conflicts" fact so operators see
    // an honest cap indicator instead of an implicit ceiling.
    const visible = conflictCount <= DISCORD_EMBED_FIELD_CAP
      ? input.conflicts
      : input.conflicts.slice(0, DISCORD_EMBED_FIELD_CAP - 1);
    for (const c of visible) {
      embed.addFields({
        name: `📄 ${truncate(c.path, 256)}`,
        value: `src: \`${shortHash(c.sourceHash)}\` · dest: \`${shortHash(c.destHash)}\``,
        inline: false,
      });
    }
    if (conflictCount > DISCORD_EMBED_FIELD_CAP) {
      const remaining = conflictCount - (DISCORD_EMBED_FIELD_CAP - 1);
      embed.addFields({
        name: "…",
        value: `${remaining} more conflict${remaining === 1 ? "" : "s"} (see sync-state.json)`,
        inline: false,
      });
    }
  } else if (input.lastCycle) {
    const lc = input.lastCycle;
    embed.addFields(
      { name: "Files added",       value: String(lc.filesAdded ?? 0),            inline: true },
      { name: "Files updated",     value: String(lc.filesUpdated ?? 0),          inline: true },
      { name: "Files removed",     value: String(lc.filesRemoved ?? 0),          inline: true },
      { name: "Bytes transferred", value: formatBytes(lc.bytesTransferred ?? 0), inline: true },
      { name: "Duration",          value: formatDuration(lc.durationMs),         inline: true },
      { name: "Conflicts",         value: "0",                                    inline: true },
    );
    if (lc.error) {
      embed.addFields({ name: "Error", value: truncate(lc.error, 1024), inline: false });
    }
    if (lc.reason) {
      embed.addFields({ name: "Reason", value: truncate(lc.reason, 1024), inline: false });
    }
  }

  if (input.lastCycle) {
    embed.setFooter({
      text: `cycle ${input.lastCycle.cycleId} · ${input.lastCycle.timestamp}`,
    });
  } else {
    embed.setFooter({
      text: "Sync has not run yet — systemd timer or `clawcode sync run-once`",
    });
  }

  return embed;
}

/**
 * Human-friendly byte count: 0 B · 512 B · 1.5 KB · 500.0 MB · 2.34 GB.
 *
 * Discrete case at 0 avoids " 0 B" odd edge (round-trip tests pin "0 B").
 */
export function formatBytes(n: number): string {
  if (n === 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Human-friendly duration: 45ms · 1.4s · 1m 1s · 12m 34s.
 *
 * Sub-second values render as ms (no decimal) — more readable than "0.3s"
 * for the common "cycle was a no-op" path.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${min}m ${sec}s`;
}

/**
 * Compute the " (3m ago)" suffix for description "Last cycle: X" lines.
 * Returns "" when there's no timestamp or the delta is negative (clock
 * skew — defensive, never renders "(-2s ago)" in the embed).
 */
function relativeTimeSuffix(ts: string | undefined, now: Date): string {
  if (!ts) return "";
  const parsed = new Date(ts).getTime();
  if (Number.isNaN(parsed)) return "";
  const diffMs = now.getTime() - parsed;
  if (diffMs < 0) return "";
  if (diffMs < 60_000) return ` (${Math.floor(diffMs / 1000)}s ago)`;
  if (diffMs < 3_600_000) return ` (${Math.floor(diffMs / 60_000)}m ago)`;
  if (diffMs < 86_400_000) return ` (${Math.floor(diffMs / 3_600_000)}h ago)`;
  return ` (${Math.floor(diffMs / 86_400_000)}d ago)`;
}

/** First 8 hex chars of a sha256 — enough for operator recognition. */
function shortHash(hex: string): string {
  return hex.slice(0, 8);
}

/** Trim any long string (path, error) to `max` chars with ellipsis. */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
