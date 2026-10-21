/**
 * Phase 127 — daemon-side stream-stall callback factory.
 *
 * Bridges the narrow `onStreamStall` boundary declared on AgentSessionConfig
 * ({@link AgentSessionConfig.onStreamStall}, payload: `{lastUsefulTokenAgeMs,
 * thresholdMs}`) to the two operator-visible sinks specified in BACKLOG.md
 * §"On trip":
 *   1. Single-line Discord notification in the agent's own channel via
 *      `webhookManager.send(agentName, content)`.
 *   2. JSONL row in `{memoryDir}/events.jsonl` via
 *      `sessionLogger.recordStall(...)` so Phase 124/125 compaction
 *      extractors can surface "N stalls this week" in the active-state
 *      header.
 *
 * Both sinks are fire-and-forget: a Discord 5xx, a webhook 401, or a fs
 * EACCES MUST NOT prevent supervisor recovery. Failures are logged at
 * `warn` level and swallowed (Phase 89 fire-and-forget canary precedent).
 *
 * The factory closes over per-agent metadata available at the wiring
 * site (agentName, model, effort) and the per-agent SessionLogger looked
 * up at trip time (NOT factory time — the SessionLogger is created in
 * `AgentMemoryManager.initMemory` which runs AFTER session-config
 * builds; a closure-captured reference would be stale).
 *
 * NOTE on payload enrichment (Plan 02 deviation from prescribed shape):
 * Plan 02 T-01 + T-02 prescribed a wider `onStreamStall` payload than
 * the AgentSessionConfig boundary actually carries
 * (`lastUsefulTokenAgeMs + thresholdMs` only — the tracker doesn't know
 * agent/turn metadata). We enrich INSIDE this factory rather than
 * widening the boundary type — the boundary is intentionally narrow
 * (per Plan 01 D-03 single-chokepoint design) and the enrichment
 * happens once at the daemon-side wiring layer.
 *
 * `advisorActive` is hard-coded `false` pending D-07 follow-up (Plan 01
 * deferred advisor-pause integration with AdvisorService); the field
 * ships with the schema so Phase 124/125 extractors can read it from
 * day one without a JSONL format migration when the integration lands.
 *
 * `sessionName` / `turnId` are populated from the sessionId provider
 * closure when reachable; empty string otherwise. The closure
 * approach (rather than a stable closure-captured value at factory
 * time) is required because sessionId is set AFTER `createSession`
 * returns — see SessionManager.startAgent lines 956-968 where
 * `sessionIdRef.current` is assigned post-adapter.createSession.
 */

import type { WebhookManager } from "../discord/webhook-manager.js";
import type { SessionLogger } from "../memory/session-log.js";
import type { Logger } from "pino";

/**
 * Verbatim Discord notification text per BACKLOG.md line 19. Em-dash is
 * U+2014 (NOT the ASCII "--" or U+2013 en-dash). Tests assert this exact
 * string — any paraphrasing breaks STALL-04 and any future grep-based
 * monitoring (`journalctl | grep "stream stall — turn aborted"`).
 */
export const STREAM_STALL_DISCORD_MESSAGE =
  "⚠️ stream stall — turn aborted, send the message again";

/**
 * Narrow payload the tracker hands to the callback (matches
 * AgentSessionConfig.onStreamStall signature in {@link
 * src/manager/types.ts}).
 */
export type StreamStallCallbackPayload = {
  readonly lastUsefulTokenAgeMs: number;
  readonly thresholdMs: number;
};

/**
 * Dependencies for {@link makeStreamStallCallback}. The factory closes
 * over the per-agent immutable fields (name, model, effort) and uses
 * the providers for late-binding to the per-agent SessionLogger +
 * current sessionId, both of which can change across the agent's
 * lifetime (sessionId rotates on every resume; sessionLogger is created
 * after initMemory).
 */
export type StreamStallCallbackDeps = {
  /** Per-agent immutable fields. */
  readonly agentName: string;
  readonly model: string;
  readonly effort: string;
  /**
   * Discord sink — `WebhookManager.send(agentName, content)`. Optional:
   * during daemon boot or in tests, no webhookManager may be wired. The
   * callback then silently skips the Discord sink (log+swallow); the
   * sessionLogger sink still fires.
   */
  readonly webhookManager?: WebhookManager;
  /**
   * Late-binding lookup for the per-agent SessionLogger. Resolved at
   * trip time so a stall during/after `initMemory` finds the writer
   * regardless of construction ordering. Returns `undefined` when no
   * logger is available — the callback then logs+swallows.
   */
  readonly sessionLoggerProvider: () => SessionLogger | undefined;
  /**
   * Late-binding lookup for the current SDK sessionId (rotates on
   * resume). Returns empty string when no session is active. Optional —
   * when omitted the JSONL row carries `sessionName: ""`.
   */
  readonly sessionIdProvider?: () => string;
  /**
   * Optional logger for the fire-and-forget catch handlers. Falls back
   * to console.warn at the call sites (no hard dependency on pino in
   * tests).
   */
  readonly log?: Logger;
};

/**
 * Build a per-agent stall callback. Pure factory — no side effects
 * until the returned callback is invoked.
 */
export function makeStreamStallCallback(
  deps: StreamStallCallbackDeps,
): (payload: StreamStallCallbackPayload) => void {
  return (payload: StreamStallCallbackPayload): void => {
    // Discord sink — fire-and-forget. WebhookManager.send is the
    // "post to this agent's own channel" path (signature:
    // `send(agentName, content): Promise<void>`). sendAsAgent is the
    // A2A path that requires an EmbedBuilder + sender identity — wrong
    // shape for an operator notification originating from the agent
    // itself.
    // 999.178 R1 — this notice is DELIBERATELY webhook-only; do NOT add a
    // bot-direct fallback for webhook-less agents (fin-client et al.). One
    // stall trip both fires this callback AND aborts the turn with a
    // `no-useful-tokens` wedge that the bridge recovers: a no-tool stall
    // AUTO-RE-RUNS silently, and a mutating wedge posts the bridge's own notice
    // + Retry button (999.178 R1, works bot-direct). A bot-direct leg here would
    // tell Client A to "send the message again" DURING a silent auto-rerun (he
    // resends → duplicate turn) and double the notice on the mutating path. The
    // bridge's failure UX is the bot-direct path; this leg stays webhook-only.
    const wm = deps.webhookManager;
    if (wm !== undefined && wm.hasWebhook(deps.agentName)) {
      wm.send(deps.agentName, STREAM_STALL_DISCORD_MESSAGE).catch(
        (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (deps.log !== undefined) {
            deps.log.warn(
              { agent: deps.agentName, err: msg },
              "phase127 stall Discord notification failed",
            );
          } else {
            // Test paths without a pino logger — observational only.
            // eslint-disable-next-line no-console
            console.warn(
              "phase127-stall-discord-failed",
              JSON.stringify({ agent: deps.agentName, err: msg }),
            );
          }
        },
      );
    }

    // Session-log sink — fire-and-forget. Late-bind the logger so a
    // stall fired before initMemory completes (improbable but
    // structurally possible) doesn't crash on a captured-undefined
    // reference.
    const logger = deps.sessionLoggerProvider();
    if (logger !== undefined) {
      logger
        .recordStall({
          agentName: deps.agentName,
          sessionName: deps.sessionIdProvider?.() ?? "",
          turnId: "", // Per-turn identity not reachable at this boundary
          // — see module JSDoc. Phase 124/125 extractors handle empty
          // string fields as "unknown" without special-casing.
          lastUsefulTokenAgeMs: payload.lastUsefulTokenAgeMs,
          thresholdMs: payload.thresholdMs,
          advisorActive: false, // D-07 deferred per module JSDoc.
          model: deps.model,
          effort: deps.effort,
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (deps.log !== undefined) {
            deps.log.warn(
              { agent: deps.agentName, err: msg },
              "phase127 stall sessionLog.recordStall failed",
            );
          } else {
            // eslint-disable-next-line no-console
            console.warn(
              "phase127-stall-sessionlog-failed",
              JSON.stringify({ agent: deps.agentName, err: msg }),
            );
          }
        });
    }
  };
}
