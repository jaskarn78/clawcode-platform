/**
 * Phase 91 Plan 02 Task 2 — conflict-alerter (SYNC-06 D-15).
 *
 * Fire-and-forget Discord embed sender for sync-cycle conflict alerts.
 *
 * One embed per sync cycle (NOT per file) lists all files flagged as
 * conflicts that cycle — paths + short hashes + a `clawcode sync resolve`
 * hint — and lands in the admin-clawdy channel (channelId
 * `000000000000000115`). The sync-runner calls this AFTER persisting
 * conflicts to sync-state.json and appending the JSONL observability line,
 * wrapped in `void ... .catch(log.warn)` so Discord availability never
 * blocks a sync-cycle's success signal.
 *
 * Why bot-direct, not webhook (Phase 90.1 precedent):
 *   - The webhook auto-provisioner is broken (Phase 90.1 post-mortem).
 *   - admin-clawdy doesn't have a per-agent identity — it's a monitoring
 *     target, bot identity is the honest presentation.
 *   - One hardcoded channelId + one bot token is simpler than provisioning
 *     a webhook just for the sync runner.
 *
 * Failure modes:
 *   - conflicts.length === 0          → {sent:false, reason:"no-conflicts"}
 *   - empty botToken                  → {sent:false, reason:"no-bot-token"}
 *   - fetch rejects (DNS / timeout)   → {sent:false, reason:"network-error"}
 *   - fetch resolves non-2xx          → {sent:false, reason:"http-error"}
 *
 * Every non-send path logs a pino warn (caller's logger) so operators can
 * diagnose "why didn't I get an alert?" without tail-chasing silent paths.
 */

import type { Logger } from "pino";
import type { SyncConflict } from "./types.js";

/**
 * D-15 / 91-CONTEXT §specifics: admin-clawdy channel — same target used
 * by the Phase 90.1 bot-direct restart greeting fallback. Hardcoded here
 * (not a SyncStateFile field) because this is a DEPLOYMENT constant, not
 * a per-cycle runtime value. If the monitoring channel ever moves, bump
 * this constant + deploy; no state migration needed.
 */
export const ADMIN_CLAWDY_CHANNEL_ID = "000000000000000115";

/**
 * Discord embed field cap — API rejects messages with >25 fields. When
 * more than 25 files conflict in a cycle (extremely unlikely for the
 * fin-client workspace but we code for correctness), the first 25
 * render; the operator sees the full list via sync-state.json.conflicts[].
 */
export const DISCORD_EMBED_FIELD_CAP = 25;

/** Red — matches the "something diverged" visual convention. */
export const CONFLICT_EMBED_COLOR = 15158332;

export type ConflictAlertDeps = Readonly<{
  /** Discord bot token from env (DISCORD_BOT_TOKEN). Empty string = skip. */
  readonly botToken: string;
  /** Target channel. Defaults to ADMIN_CLAWDY_CHANNEL_ID in the runner. */
  readonly channelId: string;
  readonly log: Logger;
  /** DI for tests — defaults to globalThis.fetch. */
  readonly fetchImpl?: typeof fetch;
  /** DI for tests — defaults to new Date(). */
  readonly now?: () => Date;
}>;

export type ConflictAlertResult =
  | { readonly sent: true; readonly messageId: string }
  | {
      readonly sent: false;
      readonly reason:
        | "no-conflicts"
        | "no-bot-token"
        | "http-error"
        | "network-error";
      readonly detail?: string;
    };

/**
 * Send one embed summarizing all conflicts in this sync cycle.
 *
 * The caller wraps this in `void sendConflictAlert(...).catch(log.warn)` —
 * sync-cycle success MUST NOT depend on Discord availability.
 *
 * D-15 semantics — one embed per cycle. If the SAME file stays conflicted
 * across multiple cycles, this function still fires each cycle. Re-alerts
 * are acceptable noise: operators need visibility on persistent divergence.
 * Suppression (alert-once-per-path) is explicitly NOT implemented — keeps
 * the alerter stateless + lets operators see the conflict is still there.
 */
export async function sendConflictAlert(
  conflicts: readonly SyncConflict[],
  cycleId: string,
  deps: ConflictAlertDeps,
): Promise<ConflictAlertResult> {
  if (conflicts.length === 0) {
    return { sent: false, reason: "no-conflicts" };
  }
  if (!deps.botToken || deps.botToken.trim().length === 0) {
    deps.log.warn({ cycleId }, "conflict-alert: no bot token; skipping");
    return { sent: false, reason: "no-bot-token" };
  }

  const fetchFn = deps.fetchImpl ?? fetch;
  const nowFn = deps.now ?? (() => new Date());

  // Cap fields at Discord's 25-field hard limit. The embed also has a
  // 6000-char total budget + 256/1024 char caps on name/value; our short
  // 8-char hashes + path-slice keep us well under those.
  const renderedFields = conflicts
    .slice(0, DISCORD_EMBED_FIELD_CAP)
    .map((c) => ({
      name: c.path.slice(0, 256),
      value: `src: \`${c.sourceHash.slice(0, 8)}\` · dest: \`${c.destHash.slice(0, 8)}\``,
      inline: false,
    }));

  const count = conflicts.length;
  const embed = {
    title: `Sync conflicts detected (${count} file${count === 1 ? "" : "s"})`,
    description:
      "The following files were edited on both sides since the last sync — ClawCode has stopped syncing them to prevent data loss.\n\n" +
      "Run `clawcode sync resolve <path> --side openclaw|clawcode` to resolve each.",
    fields: renderedFields,
    footer: { text: `cycle ${cycleId} · ${nowFn().toISOString()}` },
    color: CONFLICT_EMBED_COLOR,
  };

  const url = `https://discord.com/api/v10/channels/${deps.channelId}/messages`;

  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: {
        Authorization: `Bot ${deps.botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ embeds: [embed] }),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.log.warn({ err, cycleId }, "conflict-alert: network error");
    return { sent: false, reason: "network-error", detail };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable>");
    deps.log.warn(
      { status: res.status, body, cycleId },
      "conflict-alert: http error",
    );
    return {
      sent: false,
      reason: "http-error",
      detail: `${res.status}: ${body.slice(0, 200)}`,
    };
  }

  // Discord responds with the created message object — id field is a
  // snowflake string. On parse failure, we still succeeded the send.
  const json = (await res.json().catch(() => ({}))) as { id?: string };
  return { sent: true, messageId: json.id ?? "unknown" };
}
