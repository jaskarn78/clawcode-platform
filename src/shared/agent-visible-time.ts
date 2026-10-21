/**
 * Phase 999.13 — Agent-visible timestamp rendering.
 *
 * Single source of truth for converting UTC → operator-local TZ at
 * the daemon's prompt-emission boundary. Internal storage (DB rows,
 * structured event keys, heartbeat NDJSON) stays UTC; only agent-
 * visible TEXT goes through this helper.
 *
 * TZ resolution chain: configTz → process.env.TZ → host TZ.
 * HOST_TZ captured ONCE at module load — operators wanting live
 * change should set defaults.timezone (config knob).
 *
 * Format: "YYYY-MM-DD HH:mm:ss ZZZ" via Intl.DateTimeFormat +
 * formatToParts. ZZZ is the locale-formatted TZ abbreviation
 * (PDT, PST, EST, UTC). DST handled automatically by Node 22 ICU.
 *
 * Bad IANA TZ falls back to UTC (warn-log NOT emitted here — that's
 * the schema layer's job at config-load time via Plan 02 refinement).
 */

const HOST_TZ = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
})();

/**
 * Resolve the operator-local TZ for an agent.
 * Chain: configTz → process.env.TZ → host TZ (captured at module load).
 */
export function resolveAgentTimezone(
  configTz: string | undefined,
): string {
  return configTz ?? process.env.TZ ?? HOST_TZ;
}

/**
 * Render a UTC instant as "YYYY-MM-DD HH:mm:ss ZZZ" in the given TZ.
 *
 * Accepts both `Date` and ISO `string` inputs. Returns "invalid date"
 * for unparseable strings (no throw). Falls back to UTC rendering
 * when given a bad IANA TZ name (Pitfall 6 — operator typo like
 * "Pacific/LosAngeles" instead of "America/Los_Angeles").
 *
 * When `tz` is omitted, uses HOST_TZ (captured at module load — set
 * `defaults.timezone` in clawcode.yaml for explicit operator override).
 */
export function renderAgentVisibleTimestamp(
  date: Date | string,
  tz?: string,
): string {
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return "invalid date";
  const timeZone = tz ?? HOST_TZ;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZone,
      timeZoneName: "short",
    }).formatToParts(d);
  } catch {
    // Bad IANA TZ — fall back to UTC.
    if (timeZone === "UTC") {
      // Last resort — manual ISO assembly to avoid infinite recursion if Intl is broken.
      const iso = d.toISOString();
      return iso.replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
    }
    return renderAgentVisibleTimestamp(d, "UTC");
  }
  const m: Record<string, string> = {};
  for (const p of parts) m[p.type] = p.value;
  // Node 22 emits "24" for midnight in some locales; normalize to "00".
  const hh = m.hour === "24" ? "00" : m.hour;
  return `${m.year}-${m.month}-${m.day} ${hh}:${m.minute}:${m.second} ${m.timeZoneName}`;
}
