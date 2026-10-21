import { join } from "node:path";
import type { CheckModule, CheckResult } from "../types.js";
import { readMessages, markProcessed, resolveKind } from "../../collaboration/inbox.js";
// Quick task 260521-4sa (999.64) + debug `stale-turn-watchdog-miss` —
// thresholds single-sourced so the runner-level fleet-wide sweep and this
// inbox-check watchdog can never drift apart. See stale-turn-thresholds.ts.
import {
  TURN_STALE_WARNING_THRESHOLD_MS,
  resolveForceReleaseThresholdMs,
} from "../stale-turn-thresholds.js";

/**
 * Reconciler staleness threshold in milliseconds.
 * When InboxSource is active (primary path), the heartbeat inbox check
 * only processes messages older than this threshold. Set to 2x the
 * default heartbeat interval (60s) = 120s. Messages newer than this
 * are left for InboxSource's chokidar watcher to handle.
 */
const RECONCILER_STALE_THRESHOLD_MS = 120_000;

/**
 * Module-level flag toggled by daemon.ts when InboxSource is registered.
 * When true, this check operates in reconciler/fallback mode — only
 * processing stale messages that InboxSource likely missed.
 */
let inboxSourceActive = false;

/**
 * Mark InboxSource as active, demoting this heartbeat check to
 * reconciler/fallback mode. Called from daemon.ts after InboxSource
 * registration (Phase 61 TRIG-04).
 */
export function setInboxSourceActive(active: boolean): void {
  inboxSourceActive = active;
}

/**
 * Inbox heartbeat check for async message delivery.
 *
 * When InboxSource is NOT active (legacy mode): discovers ALL unprocessed
 * messages and delivers them — full primary delivery path.
 *
 * When InboxSource IS active (reconciler mode): only processes messages
 * older than RECONCILER_STALE_THRESHOLD_MS (120s). Recent messages are
 * left for InboxSource's chokidar watcher. This prevents the race
 * condition where both InboxSource and heartbeat try to process the same
 * file simultaneously (Research Pitfall 7).
 */
const inboxCheck: CheckModule = {
  name: "inbox",

  async execute(context): Promise<CheckResult> {
    const { agentName, sessionManager } = context;

    // Phase 999.12 HB-02 — short-circuit when a turn is in flight. Mid-turn
    // the inbox is in active drain by design; running the check here only
    // manufactures false-positive timeout alerts. Best-effort heuristic
    // (Pitfall 3): a turn started immediately after this check returns
    // healthy is harmless — failed dispatches are retried next tick.
    //
    // Quick task 260521-4sa (999.64) — stale-lock watchdog. An SDK turn that
    // hangs without settling holds the per-agent turn-in-flight lock forever,
    // so this branch silently skips every subsequent inbound message. The
    // watchdog measures SDK-message activity age and: force-releases a lock
    // stale past the force-release threshold (then falls through to drain),
    // warns past the warning threshold, and otherwise leaves a genuinely
    // active turn untouched.
    if (sessionManager.hasActiveTurn(agentName)) {
      // Prefer the per-message activity timestamp; fall back to turn-start
      // for legacy handles or a turn that produced zero messages.
      const lastActivityAt =
        sessionManager.getLastTurnActivityAt(agentName) ??
        sessionManager.getTurnStartedAt(agentName);

      // Cannot measure (legacy handle, both slots null) — treat as fresh and
      // keep the existing healthy skip rather than risk a false force-release.
      if (lastActivityAt === null) {
        return {
          status: "healthy",
          message: "skipped: turn in flight",
          metadata: { skipped: true, reason: "active-turn" },
        };
      }

      const staleMs = Date.now() - lastActivityAt;

      // Phase 999.114 — per-agent threshold, not the bare 300s baseline. This
      // is the TOP-LEVEL-agent force-release path (the runner sweep is the
      // subagent-coverage twin), so it is the one that actually capped
      // fin-research: raising its streamStallTimeoutMs to 600s bought only
      // ~300s because THIS check fired first and force-released the turn
      // before the clean stall abort could. Both paths must move together or
      // the cap survives in whichever one was missed. Fail-safe: a
      // throwing/absent accessor degrades to the baseline.
      let stallTimeoutMs: number | undefined;
      try {
        stallTimeoutMs =
          sessionManager.getAgentConfig(agentName)?.streamStallTimeoutMs;
      } catch {
        stallTimeoutMs = undefined;
      }
      const forceReleaseThresholdMs =
        resolveForceReleaseThresholdMs(stallTimeoutMs);

      if (staleMs > forceReleaseThresholdMs) {
        // Capture the prior turn's start BEFORE the release clears the slot.
        const priorTurnStartedAt = sessionManager.getTurnStartedAt(agentName);
        const released = sessionManager.forceReleaseTurn(agentName);
        if (released) {
          // Forensic line — mirrors the phase127-stream-stall structured-log
          // idiom so existing journalctl greps catch this label.
          console.warn(
            "phase999.64-stale-lock-force-release",
            JSON.stringify({
              agent: agentName,
              priorTurnStartedAt,
              staleMs,
              // Phase 999.114 — the threshold ACTUALLY applied for this agent.
              forceReleaseThresholdMs,
            }),
          );
        }
        // Do NOT return — fall through to the message-drain logic below so a
        // queued inbound message dispatches THIS tick (BACKLOG optional).
      } else if (staleMs > TURN_STALE_WARNING_THRESHOLD_MS) {
        return {
          status: "warning",
          message: `turn-stale: no SDK activity for ${staleMs}ms`,
          metadata: { skipped: true, reason: "turn-stale", staleMs },
        };
      } else {
        // Genuinely active turn — recent SDK activity. Untouched.
        return {
          status: "healthy",
          message: "skipped: turn in flight",
          metadata: { skipped: true, reason: "active-turn" },
        };
      }
    }

    // 1. Get agent config from sessionManager to find workspace path
    const agentConfig = sessionManager.getAgentConfig(agentName);
    if (!agentConfig) {
      return { status: "healthy", message: "No config available" };
    }

    // 2. Build inbox path: {memoryPath}/inbox/
    // Phase 75 SHARED-01 — memoryPath (not workspace) so shared-workspace
    // agents discover only their own inbox, never a sibling agent's.
    const inboxDir = join(agentConfig.memoryPath, "inbox");

    // 3. Read all unprocessed messages via readMessages()
    const allMessages = await readMessages(inboxDir);

    // 4. In reconciler mode, filter to stale messages only
    const now = Date.now();
    const messages = inboxSourceActive
      ? allMessages.filter(msg => (now - msg.timestamp) >= RECONCILER_STALE_THRESHOLD_MS)
      : allMessages;

    const skippedByReconciler = allMessages.length - messages.length;

    // 5. If no messages to process, return healthy
    if (messages.length === 0) {
      const mode = inboxSourceActive ? "reconciler" : "primary";
      return {
        status: "healthy",
        message: inboxSourceActive
          ? `Reconciler mode: no stale messages (${skippedByReconciler} recent, left for InboxSource)`
          : "No pending messages",
        metadata: { pending: 0, mode, skippedByReconciler },
      };
    }

    // 6. For each message, deliver to agent via dispatchTurn (per D-07)
    //    Format: "[Message from {from}]: {content}"
    //    After successful delivery, markProcessed (per D-08)
    let delivered = 0;
    let failed = 0;
    let acksSuppressed = 0;
    let duplicates = 0;
    for (const msg of messages) {
      // WS-0 (quick 260716-u5h) — ack messages are an audit record, not an
      // LLM turn. The ack already reached the sender's CHANNEL via the
      // post-to-agent delivery cascade; dispatching the inbox copy as a turn
      // fed agents their own machinery output (the 2026-07-16 Admin Clawdy
      // self-echo incident). markProcessed WITHOUT dispatch, and skip the
      // ack-emitter (it no-ops on acks anyway — never ack an ack).
      if (resolveKind(msg) === "ack") {
        try {
          await markProcessed(inboxDir, msg.id);
          acksSuppressed++;
        } catch {
          failed++;
        }
        continue;
      }
      // Phase 999.117 WS-2 — cross-path dedupe. The watcher and this sweep
      // read the same directory and can genuinely race; the webhook relay is
      // a third claimant on the same logical message. First claim wins.
      const deliveryId = msg.deliveryId ?? msg.id;
      if (context.deliveryDedupe && !context.deliveryDedupe.claim(deliveryId)) {
        try {
          await markProcessed(inboxDir, msg.id);
          duplicates++;
        } catch {
          failed++;
        }
        continue;
      }
      try {
        const formatted = `[Message from ${msg.from}]: ${msg.content}`;
        await sessionManager.dispatchTurn(agentName, formatted);
        await markProcessed(inboxDir, msg.id);
        delivered++;
        // Quick 260520-r70 — markProcessed succeeded: emit the
        // agent-to-agent ack via the SHARED hook (same emitter instance
        // InboxSource holds — no bifurcation). Fire-and-forget: the
        // `void` marks the intentional non-await and the emitter never
        // rejects (inbox-ack.ts guarantee), so an ack failure can never
        // demote this delivery or fail the heartbeat tick. When
        // markProcessed throws above, control jumps to the catch and
        // the ack is correctly never invoked.
        void context.inboxAckEmitter?.(msg, agentName);
      } catch {
        failed++;
        // Delivery failed -- don't mark processed so it retries next heartbeat cycle
      }
    }

    // 7. Return status based on delivery results
    const mode = inboxSourceActive ? "reconciler" : "primary";
    if (failed > 0) {
      return {
        status: "warning",
        message: inboxSourceActive
          ? `Reconciler: delivered ${delivered}/${messages.length} stale messages (${failed} failed, ${skippedByReconciler} recent skipped)`
          : `Delivered ${delivered}/${messages.length} messages (${failed} failed)`,
        metadata: { delivered, failed, duplicates, pending: messages.length, mode, skippedByReconciler, acksSuppressed },
      };
    }

    return {
      status: "healthy",
      message: inboxSourceActive
        ? `Reconciler: delivered ${delivered} stale message(s) (${skippedByReconciler} recent skipped)`
        : `Delivered ${delivered} message(s)`,
      metadata: { delivered, duplicates, pending: 0, mode, skippedByReconciler, acksSuppressed },
    };
  },
};

export default inboxCheck;
