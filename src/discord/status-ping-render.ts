/**
 * 999.178 R1 — status-ping renderer.
 *
 * The daemon answers a short check-in ("eta", "we good?") from the live turn
 * state with NO model turn (see `isStatusPing` in midturn-intent.ts). This
 * module is the pure text builder for that reply — no discord.js, no Date.now,
 * no icon registry: the caller passes a snapshot and a pre-resolved icon.
 *
 *   running:  "⟳ Working on your 2:14 PM ask (401k rollover) · 1m 40s · reading a statement · 2 queued"
 *   draining: "⟳ 2 queued asks draining — nothing running yet."
 *   idle:     "Nothing running. Last reply 2:31 PM."
 *   research: "⟳ Researching · 3 of 4 done · 4m 10s"
 *   writing:  "⟳ Writing up the research (4 of 4 done) · 1m 12s"
 *   bg:       "⟳ In the background: Wait for price download · 2m 10s · said ~5 min at 8:53 AM (about 3 min left)"
 *
 * Every free-text fragment (the ask excerpt, the step label) is sanitized and
 * length-clamped so a pasted @mention or markdown breaker can never ride out
 * of the running turn's original message into this reply.
 */

import { formatDuration } from "./duration-format.js";
import { clipItem, sanitizeEcho } from "./hold-status.js";

/** No new event for this long ⇒ offer Continue/Stop on the ping reply. */
export const STATUS_PING_STALL_MS = 3 * 60_000;

/** customId prefix for the stalled-ping Continue/Stop buttons. */
export const STATUS_PING_BUTTON_PREFIX = "sping:";

export type StatusPingAction = "continue" | "stop";

/**
 * customId = `sping:<action>:<agent>:<triggerMessageId>:<userId>`. The agent
 * and trigger id let the handler refuse a stale turn; the userId gates the
 * click to the person who asked. Encoded/parsed here so the shape is pinned by
 * one test. Agent names and snowflakes never contain ":".
 */
export function buildStatusPingButtonId(
  action: StatusPingAction,
  agent: string,
  triggerMessageId: string,
  userId: string,
): string {
  return `${STATUS_PING_BUTTON_PREFIX}${action}:${agent}:${triggerMessageId}:${userId}`;
}

export function parseStatusPingButtonId(
  customId: string,
): { action: StatusPingAction; agent: string; triggerMessageId: string; userId: string } | null {
  if (!customId.startsWith(STATUS_PING_BUTTON_PREFIX)) return null;
  const rest = customId.slice(STATUS_PING_BUTTON_PREFIX.length);
  const parts = rest.split(":");
  if (parts.length !== 4) return null;
  const [action, agent, triggerMessageId, userId] = parts;
  if (action !== "continue" && action !== "stop") return null;
  if (!agent || !triggerMessageId || !userId) return null;
  return { action, agent, triggerMessageId, userId };
}

/** First ~N chars of the originating ask, shown in parentheses. */
export const ASK_EXCERPT_MAX_CHARS = 40;

export type StatusPingView = Readonly<{
  /** A turn is in flight for this agent right now. */
  running: boolean;
  nowMs: number;
  /** When the originating message was SENT (message.createdTimestamp), not turn start. */
  askedAtMs: number | null;
  /** The originating message's raw content; sanitized + clamped here. */
  askExcerpt: string | null;
  /** Turn start, for the elapsed clause. */
  turnStartedAtMs: number | null;
  /** Current step/tool label from the live trail, when available (optional). */
  stepLabel: string | null;
  /** Asks waiting behind this turn (depth-1 queued + coalescer pending). */
  queuedCount: number;
  /** Last delivered reply, for the idle line. */
  lastReplyAtMs: number | null;
  /**
   * Background research for this agent (researchers running, or the
   * synthesis being written). Null/absent when none is live.
   */
  research?: Readonly<{
    total: number;
    done: number;
    running: number;
    startedAt: number;
    writingSince: number | null;
  }> | null;
  /** The agent is running a turn it started itself (a research wake, a follow-up). */
  selfFiredTurnOpen?: boolean;
  /** The agent's own background work still running (downloads, waits), oldest first. */
  background?: readonly Readonly<{ description: string; startedAt: number; lastLine: string | null }>[];
  /** Text of the agent's last reply in this channel, mined for a stated ETA ("about 5 minutes"). */
  lastReplyText?: string | null;
  /** Pre-resolved inline icon (e.g. `icons.inline("loader")`), or "" for text-only. */
  loaderIcon?: string;
  /** IANA zone; defaults to Pacific to match the rest of ClawCode's lines. */
  timeZone?: string;
}>;

const DEFAULT_TIME_ZONE = "America/Los_Angeles";

/** "2:14 PM" in the operator's zone (no seconds, no zone suffix — inline use). */
export function formatClock(ms: number, timeZone: string = DEFAULT_TIME_ZONE): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(new Date(ms));
}

/** Sanitize + clamp the ask to its first ~40 chars at a word boundary. */
function clampExcerpt(raw: string): string {
  const clean = clipItem(sanitizeEcho(raw, 80));
  if (clean.length <= ASK_EXCERPT_MAX_CHARS) return clean;
  const cut = clean.slice(0, ASK_EXCERPT_MAX_CHARS);
  const sp = cut.lastIndexOf(" ");
  return (sp > 16 ? cut.slice(0, sp) : cut).replace(/[.!?,;:\s]+$/, "");
}

/** Prefix the pre-resolved icon (a space between) when one was supplied. */
function withIcon(icon: string | undefined, text: string): string {
  return icon && icon.length > 0 ? `${icon} ${text}` : text;
}

/**
 * True once the running turn has shown no new progress for `stallMs`.
 * Pure so the caller can decide whether to attach Continue/Stop without a clock.
 */
export function isTurnStalled(
  lastProgressAtMs: number | null,
  nowMs: number,
  stallMs: number = STATUS_PING_STALL_MS,
): boolean {
  if (lastProgressAtMs === null) return false;
  return nowMs - lastProgressAtMs >= stallMs;
}

function elapsedSince(startMs: number, nowMs: number): string {
  return formatDuration(Math.max(0, Math.round((nowMs - startMs) / 1000)), { precise: true });
}

/** "Researching · 3 of 4 done · 4m 10s" / "Writing up the research (4 of 4 done) · 1m 12s". */
function researchLine(r: NonNullable<StatusPingView["research"]>, selfFiredOpen: boolean, nowMs: number): string {
  if (r.running === 0 && r.done > 0) {
    const verb = selfFiredOpen ? "Writing up the research" : "Research done, writing it up next";
    const since = r.writingSince ?? r.startedAt;
    return [`${verb} (${r.done} of ${r.total} done)`, elapsedSince(since, nowMs)].filter((p) => p.length > 0).join(" · ");
  }
  return ["Researching", `${r.done} of ${r.total} done`, elapsedSince(r.startedAt, nowMs)].filter((p) => p.length > 0).join(" · ");
}

const ETA_RE =
  /(?:\b(?:about|around|roughly|approximately|approx\.?|under|another|takes?|in)\b|~)\s*~?\s*(\d+(?:\.\d+)?)(?:\s*(?:-|–|to)\s*(\d+(?:\.\d+)?))?\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/i;

/** An ETA the agent stated in its own words: ms from when it said it, or null. */
export function statedEtaMs(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = ETA_RE.exec(text);
  if (!m) return null;
  const n = Number(m[2] ?? m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[3]!.toLowerCase();
  const mult = unit.startsWith("h") ? 3_600_000 : unit.startsWith("m") ? 60_000 : 1_000;
  return n * mult;
}

function shortDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min >= 60) return `${Math.round(min / 60)} h`;
  return min >= 1 ? `${min} min` : "under a minute";
}

/** "said ~5 min at 8:53 AM (about 3 min left)" / "(running past it)". */
function etaClause(v: StatusPingView, tz: string): string | null {
  const eta = statedEtaMs(v.lastReplyText);
  if (eta === null || v.lastReplyAtMs === null) return null;
  const left = v.lastReplyAtMs + eta - v.nowMs;
  const said = `said ~${shortDuration(eta)} at ${formatClock(v.lastReplyAtMs, tz)}`;
  return left > 30_000 ? `${said} (about ${shortDuration(left)} left)` : `${said} (running past it)`;
}

function backgroundLine(v: StatusPingView, tz: string): string | null {
  const bg = v.background ?? [];
  if (bg.length === 0) return null;
  const head = bg[0]!;
  const desc = clipItem(sanitizeEcho(head.description, 80));
  const parts = [`In the background: ${desc}`, elapsedSince(head.startedAt, v.nowMs)];
  if (head.lastLine) parts.push(clipItem(sanitizeEcho(head.lastLine, 64)));
  if (bg.length > 1) parts.push(`+${bg.length - 1} more`);
  const eta = etaClause(v, tz);
  if (eta) parts.push(eta);
  return parts.filter((p) => p.length > 0).join(" · ");
}

export function renderStatusPing(v: StatusPingView): string {
  const tz = v.timeZone ?? DEFAULT_TIME_ZONE;
  const queued =
    v.queuedCount > 0 ? `${v.queuedCount} queued` : null;
  const research = v.research ?? null;

  // No turn of the user's is running, but the agent is not idle: background
  // research, or a turn the agent started itself (its synthesis). Never
  // "Nothing running" then (fin-client 2026-09-26).
  if (!v.running && research !== null) {
    return withIcon(v.loaderIcon, [researchLine(research, v.selfFiredTurnOpen === true, v.nowMs), ...(queued ? [queued] : [])].join(" · "));
  }
  const bgLine = backgroundLine(v, tz);
  if (!v.running && v.selfFiredTurnOpen === true) {
    return withIcon(v.loaderIcon, ["Working on a follow-up", ...(bgLine ? [bgLine] : []), ...(queued ? [queued] : [])].join(" · "));
  }
  if (!v.running && bgLine !== null) {
    return withIcon(v.loaderIcon, [bgLine, ...(queued ? [queued] : [])].join(" · "));
  }

  if (!v.running) {
    // Idle, but a restore-before-sweep window can leave asks queued with no
    // turn in flight yet — never claim "nothing running" then.
    if (v.queuedCount > 0) {
      return withIcon(
        v.loaderIcon,
        `${v.queuedCount} queued ask${v.queuedCount === 1 ? "" : "s"} draining — nothing running yet.`,
      );
    }
    const last =
      v.lastReplyAtMs !== null ? ` Last reply ${formatClock(v.lastReplyAtMs, tz)}.` : "";
    return `Nothing running.${last}`;
  }

  // Running.
  const lead =
    v.askedAtMs !== null
      ? `Working on your ${formatClock(v.askedAtMs, tz)} ask`
      : "Working on your ask";
  const excerpt = v.askExcerpt ? clampExcerpt(v.askExcerpt) : "";
  const head = excerpt.length > 0 ? `${lead} (${excerpt})` : lead;

  const parts: string[] = [head];
  if (v.turnStartedAtMs !== null) {
    const secs = Math.max(0, Math.round((v.nowMs - v.turnStartedAtMs) / 1000));
    const elapsed = formatDuration(secs, { precise: true });
    if (elapsed.length > 0) parts.push(elapsed);
  }
  if (v.stepLabel) {
    const step = clipItem(sanitizeEcho(v.stepLabel, 64));
    if (step.length > 0) parts.push(step);
  }
  if (research !== null) parts.push(`research ${research.done} of ${research.total} done`);
  if (queued) parts.push(queued);

  return withIcon(v.loaderIcon, parts.join(" · "));
}
