/**
 * Phase 103 OBS-07 — pure /clawcode-usage panel renderer.
 *
 * Mirrors the Claude iOS app's session/weekly usage view: 5-hour rolling
 * window, 7-day weekly limit, optional Opus + Sonnet carve-outs, overage
 * state as status-line. Per Research Open Q3 the overage row is rendered
 * as a status-line (not a bar) because it's a credit-pool model, not a
 * percentage.
 *
 * Pure module — accepts plain snapshots, returns EmbedBuilder. Tests
 * construct snapshot literals directly without standing up Discord
 * client. Pattern verbatim from src/discord/sync-status-embed.ts.
 *
 * Color triage matches the operator-surface vocabulary:
 *   - green   (3066993)  — all snapshots `allowed`
 *   - yellow  (15844367) — any `allowed_warning` (and none `rejected`)
 *   - red     (15158332) — any `rejected`
 *
 * Pitfall 9 closure — surpassedThreshold is OPTIONAL NUMBER, not bool;
 * rendered as a separate field when defined.
 *
 * Pitfall 7 closure — empty snapshots render "No usage data yet" rather
 * than an empty embed (graceful for non-OAuth-Max sessions or pre-first-
 * turn agents).
 *
 * Pitfall 10 closure — rateLimitType strings outside the canonical 5-value
 * set (five_hour, seven_day, seven_day_opus, seven_day_sonnet, overage)
 * are silently omitted from the bar grid; the renderer never throws.
 */
import { EmbedBuilder } from "discord.js";
import { formatDistanceToNow } from "date-fns";
import type { RateLimitSnapshot } from "../usage/rate-limit-tracker.js";

const COLOR_HAPPY = 3066993;
const COLOR_WARN = 15844367;
const COLOR_REJECT = 15158332;
const BAR_WIDTH = 10;

const TYPE_ORDER = [
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
] as const;

const TYPE_LABELS: Record<string, string> = {
  five_hour: "5-hour session",
  seven_day: "7-day weekly",
  seven_day_opus: "Opus weekly",
  seven_day_sonnet: "Sonnet weekly",
  overage: "Overage",
};

const STATUS_EMOJI: Record<string, string> = {
  allowed: "🟢",
  allowed_warning: "🟡",
  rejected: "🔴",
};

/**
 * Render a 10-char Unicode progress bar.
 *   utilization=0.5      → "▓▓▓▓▓░░░░░ 50%"
 *   utilization=0        → "░░░░░░░░░░ 0%"
 *   utilization=1        → "▓▓▓▓▓▓▓▓▓▓ 100%"
 *   utilization=undefined → "──────────  n/a"
 *
 * Values >1 clamp to 100%; values <0 clamp to 0%.
 */
export function renderBar(utilization: number | undefined): string {
  if (utilization === undefined) {
    return "─".repeat(BAR_WIDTH) + "  n/a";
  }
  const clamped = Math.max(0, Math.min(1, utilization));
  const filled = Math.round(clamped * BAR_WIDTH);
  const pct = Math.round(clamped * 100);
  return "▓".repeat(filled) + "░".repeat(BAR_WIDTH - filled) + ` ${pct}%`;
}

/**
 * Choose the embed color based on the worst-status across all snapshots.
 * Worst-wins: rejected > allowed_warning > allowed.
 */
function pickColor(snapshots: readonly RateLimitSnapshot[]): number {
  // Worst-wins: rejected returns early; otherwise we only ever escalate
  // from "allowed" to "allowed_warning". The previous `worst !== "rejected"`
  // guard was dead code (the early return above means `worst` is never
  // "rejected" at this point), and TS6.0 flagged it as TS2367.
  let worst: "allowed" | "allowed_warning" = "allowed";
  for (const s of snapshots) {
    if (s.status === "rejected") return COLOR_REJECT;
    if (s.status === "allowed_warning") {
      worst = "allowed_warning";
    }
  }
  return worst === "allowed_warning" ? COLOR_WARN : COLOR_HAPPY;
}

function formatReset(resetsAt: number | undefined): string {
  if (resetsAt === undefined) return "unknown";
  return formatDistanceToNow(resetsAt, { addSuffix: true });
}

/**
 * Token usage totals for one Pacific day. Carries the full breakdown the
 * panel renders. `tokens_in` is FRESH/uncached input only (matching the
 * usage_events column); the true API-metered input is
 * tokens_in + cache_read_tokens + cache_creation_tokens — on a cache-heavy
 * agent the cache halves dominate, so the headline uses the sum.
 */
export type UsageTokens = Readonly<{
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  turns: number;
  duration_ms: number;
}>;

/**
 * Format an integer token count with `en-US` thousands separators. The
 * locale is pinned so the grouping separator is deterministic across
 * machines/CI (bare toLocaleString() is locale-dependent).
 */
function formatTokens(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/**
 * Compact a token count for the scannable headline: 6091 → "6.1K",
 * 15_412_003 → "15.4M". Sub-1000 values render verbatim.
 */
function formatCompact(n: number): string {
  const v = Math.round(n);
  if (v < 1000) return String(v);
  if (v < 1_000_000) return `${(v / 1000).toFixed(1)}K`;
  if (v < 1_000_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  return `${(v / 1_000_000_000).toFixed(2)}B`;
}

/**
 * Format USD cost — 2 decimals at/above $1 ("$46.20"), 4 decimals below so
 * sub-cent agent spend stays legible ("$0.0042").
 */
function formatCost(usd: number): string {
  return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

/**
 * Human "active time" from summed turn durations: "~45s", "~19m", "~1h 12m".
 */
function formatActive(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `~${totalSec}s`;
  const totalMin = Math.round(totalSec / 60);
  if (totalMin < 60) return `~${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `~${h}h ${m}m` : `~${h}h`;
}

const GAUGE_WIDTH = 10;

/**
 * Cache-hit gauge — filled blocks ∝ the cache-read share of total input:
 *   "▰▰▰▰▰▰▰▰▰▱ 93%"
 * Zeroed (no NaN) when there is no input. Clamped to [0,1].
 */
function renderCacheGauge(cacheRead: number, totalIn: number): string {
  const frac = totalIn > 0 ? Math.max(0, Math.min(1, cacheRead / totalIn)) : 0;
  const filled = Math.round(frac * GAUGE_WIDTH);
  const pct = Math.round(frac * 100);
  return "▰".repeat(filled) + "▱".repeat(GAUGE_WIDTH - filled) + ` ${pct}%`;
}

export type BuildUsageEmbedInput = Readonly<{
  agent: string;
  snapshots: readonly RateLimitSnapshot[];
  now: number;
  // Token totals for the CURRENT Pacific day only. The caller computes the
  // DST-correct Pacific midnight→now window and passes the aggregate as an
  // explicit half-open UTC range to the daemon, so "Today" means the
  // operator's local Pacific calendar day. Omitted when the fetch failed
  // (e.g. agent not running) — the token section is then simply not rendered.
  daily?: UsageTokens;
  // "anthropic" when the bars came from Anthropic's live `/usage` endpoint
  // (2026-09-26); the footer then says so instead of a snapshot age.
  source?: "anthropic" | "tracked";
}>;

export function buildUsageEmbed(input: BuildUsageEmbedInput): EmbedBuilder {
  const { agent, snapshots, daily } = input;
  const embed = new EmbedBuilder().setTitle(`📊 Usage — ${agent}`);

  // Token data counts as real data even when there are no rate-limit
  // snapshots — API-key auth never fires rate_limit_event, but tokens are
  // still tracked. So the "no data" guard requires BOTH to be absent. Cache
  // tokens count too (a backfilled day can be cache-dominated).
  const hasTokenData =
    daily !== undefined &&
    (daily.tokens_in > 0 ||
      daily.tokens_out > 0 ||
      daily.cache_read_tokens > 0 ||
      daily.cache_creation_tokens > 0);

  if (snapshots.length === 0 && !hasTokenData) {
    // Pitfall 7 — graceful "no data" path. Honest message rather than
    // empty embed (operator may be on API-key auth where rate_limit_event
    // never fires).
    embed
      .setColor(COLOR_HAPPY)
      .setDescription(
        "No usage data yet. Either no turns have run since the daemon started, or this session is not authenticated via OAuth Max.",
      );
    return embed;
  }

  // Color triages on rate-limit status when snapshots exist; token-only
  // panels (API-key auth) have no utilisation signal, so default to green.
  embed.setColor(snapshots.length > 0 ? pickColor(snapshots) : COLOR_HAPPY);

  // 4 standard buckets as bars, in canonical order.
  for (const t of TYPE_ORDER) {
    const s = snapshots.find((x) => x.rateLimitType === t);
    if (!s) continue;
    const emoji = STATUS_EMOJI[s.status] ?? "⚪";
    const value = `\`${renderBar(s.utilization)}\` · resets ${formatReset(s.resetsAt)}`;
    embed.addFields({
      name: `${TYPE_LABELS[t]} — ${emoji}`,
      value,
      inline: false,
    });
  }

  // Overage as status-line (Open Q3) — credit pool, not percentage.
  const overage = snapshots.find((x) => x.rateLimitType === "overage");
  if (overage) {
    const overageStateBits: string[] = [];
    if (overage.overageStatus !== undefined) {
      overageStateBits.push(`status: ${overage.overageStatus}`);
    }
    if (overage.isUsingOverage) {
      overageStateBits.push("using credits");
    }
    if (overage.overageDisabledReason !== undefined) {
      overageStateBits.push(`disabled: ${overage.overageDisabledReason}`);
    }
    overageStateBits.push(`resets ${formatReset(overage.overageResetsAt)}`);
    const emoji = STATUS_EMOJI[overage.status] ?? "⚪";
    embed.addFields({
      name: `${TYPE_LABELS.overage} — ${emoji}`,
      value: overageStateBits.join(" · "),
      inline: false,
    });
  }

  // Pitfall 9 — surpassedThreshold rendered as separate field when ANY
  // snapshot just crossed a threshold. Only the most recent crossing.
  const crossed = snapshots.find((s) => s.surpassedThreshold !== undefined);
  if (crossed && crossed.surpassedThreshold !== undefined) {
    const pct = Math.round(crossed.surpassedThreshold * 100);
    embed.addFields({
      name: "⚠ Threshold crossed",
      value: `${crossed.rateLimitType}: just exceeded ${pct}%`,
      inline: false,
    });
  }

  // Token usage for the current Pacific day. "Tokens In" is the TRUE
  // API-metered input — fresh + cache-read + cache-write — shown with a
  // cache-hit gauge and a precise breakdown, because on a cache-heavy agent
  // the cache reads (re-fed system prompt + history each turn) dominate input
  // and a fresh-only headline reads ~20x too low. The breakdown keeps it
  // honest: the big number is real, and the sub-line shows where it comes from.
  if (daily !== undefined) {
    const fresh = daily.tokens_in;
    const cacheRead = daily.cache_read_tokens;
    const cacheWrite = daily.cache_creation_tokens;
    const totalIn = fresh + cacheRead + cacheWrite;

    embed.addFields({
      name: "Tokens · Today (PT)",
      value:
        `📥 In  **${formatCompact(totalIn)}**  ` +
        `\`${renderCacheGauge(cacheRead, totalIn)}\` from cache\n` +
        `📤 Out **${formatCompact(daily.tokens_out)}**\n` +
        `\`└\` in = fresh ${formatTokens(fresh)} · ` +
        `cache-read ${formatTokens(cacheRead)} · ` +
        `cache-write ${formatTokens(cacheWrite)}`,
      inline: false,
    });

    embed.addFields({
      name: "Cost & activity · Today (PT)",
      value:
        `💵 **${formatCost(daily.cost_usd)}**  ·  ` +
        `🔁 ${formatTokens(daily.turns)} turns  ·  ` +
        `⏱ ${formatActive(daily.duration_ms)} active`,
      inline: false,
    });
  }

  // Footer: ground "Today" in the operator's Pacific calendar date, and
  // (when OAuth-Max snapshots exist) the staleness diagnostic. Guarded on
  // snapshots.length so a token-only panel never calls Math.min() on an empty
  // array (→ Infinity → invalid date).
  const ptDate = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(input.now));
  let footerText = `${ptDate} (PT)`;
  if (input.source === "anthropic") {
    footerText += " · live from Anthropic";
  } else if (snapshots.length > 0) {
    const oldestRecordedAt = Math.min(...snapshots.map((s) => s.recordedAt));
    footerText += ` · snapshot ${formatDistanceToNow(oldestRecordedAt, { addSuffix: true })}`;
  }
  embed.setFooter({ text: footerText });

  return embed;
}
