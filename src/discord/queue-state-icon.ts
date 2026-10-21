/**
 * Phase 119 A2A-03 / D-04 — queue-state icon state machine.
 *
 * Typed state enum with per-channel mutex serialization, 200ms debounce,
 * and bounded retry budget (≤3) on Discord rate-limit responses.
 *
 * Why this module exists today:
 *
 *   The pre-119 bridge.ts added queue-state emojis inline via
 *   `message.react(...)` and never removed the prior emoji on transition.
 *   Operators observed ⏳ stuck mid-turn AND double-emoji moments when two
 *   bursty enqueue events fired near-simultaneously. The 999.45 backlog
 *   item captured the source spec for the four-state model
 *   (⏳ → 👍 → ✅/❌), and Plan 119-03 ports it into a typed, mutex-guarded
 *   helper so bridge.ts owns NO emoji tracking state anymore.
 *
 * Contract this module enforces:
 *
 *   1. States: QUEUED (⏳), IN_FLIGHT (👍), DELIVERED (✅), FAILED (❌).
 *   2. Per-channel mutex — transitions on the same channel serialize.
 *      Different channels run in parallel (no cross-channel blocking).
 *   3. 200ms debounce — bursts of transitions collapse to the latest
 *      target. Discord's per-channel reaction rate-limit is the budget;
 *      200ms is the safe collapse window.
 *   4. Atomic remove-prior-then-add-new sequence inside the mutex, so
 *      operators never observe two queue-state emojis on the same
 *      message.
 *   5. Bounded retry — ≤3 attempts on Discord rate-limit (429) errors
 *      with exponential backoff (200ms, 500ms, 1000ms). After 3 failures
 *      the helper logs give-up and leaves the icon in whatever state
 *      Discord most recently accepted.
 *   6. Sticky terminal states — once DELIVERED or FAILED, further
 *      transitions no-op. Prevents the heartbeat-sweep "downgrade race"
 *      where a stale sweep tries to reset ✅ back to ⏳.
 *   7. Idempotent — transitioning to the current state is a no-op (no
 *      Discord API calls).
 *
 * Out of scope (Phase 117 / handshake / advisor):
 *
 *   This module owns ONLY the queue-state reactions. Other reactions
 *   on the same message (💭 advisor-consulted, 👋 admin-handshake) use
 *   different code paths and different mutex domains. Do NOT refactor
 *   those through this module — they have different semantics and
 *   different rate-limit budgets.
 */

import type { IconName } from "./icons.js";

export type QueueState = "QUEUED" | "IN_FLIGHT" | "DELIVERED" | "FAILED";

/**
 * 999.178 R1 — the queue-state reactions render through the `cc_*` icon set,
 * never Unicode (the operator's locked icon rule). This maps each state to its icon
 * NAME; the caller resolves the name to a `cc_name:id` reaction identifier
 * through the registry and, when the icon is not loaded, the transition is
 * skipped (no reaction) rather than falling back to a Unicode glyph.
 *
 * ⏳→hourglass, running→loader, done→circle_check, failed→circle_x.
 */
export const QUEUE_STATE_ICON: Readonly<Record<QueueState, IconName>> = {
  QUEUED: "hourglass",
  IN_FLIGHT: "loader",
  DELIVERED: "circle_check",
  FAILED: "circle_x",
};

const TERMINAL_STATES: ReadonlySet<QueueState> = new Set([
  "DELIVERED",
  "FAILED",
]);

/**
 * 999.178 R1 — the key a reaction identifier occupies in discord.js's
 * `message.reactions.cache`. A custom emoji (`cc_hourglass:123`, or a bare
 * `name:id`) is cached by its ID; a Unicode glyph is cached by itself. Pure
 * so the bridge's remove-by-id path is unit-tested without a live message.
 */
export function reactionCacheKey(identifier: string): string {
  const colon = identifier.lastIndexOf(":");
  return colon >= 0 ? identifier.slice(colon + 1) : identifier;
}

export type DiscordChannelHandle = Readonly<{
  addReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
  removeReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
}>;

// ---------------------------------------------------------------------------
// Module-scoped state — per-channel.
//
// `channelMutex` chains in-flight transitions so the same channel serializes.
// `channelLastState` remembers the prior emoji to remove on the next
// transition (bridge.ts no longer tracks this).
// `channelPendingTarget` keeps the latest debounced target; if a newer
// transition lands during the 200ms wait, the older one no-ops.
//
// State key is `${channelId}:${messageId}` so per-message tracking survives
// when the same channel hosts overlapping turns (rare; the queue is depth-1
// per channel, but defensive keying prevents future surprise).
// ---------------------------------------------------------------------------

type ChannelKey = string;

const channelMutex = new Map<ChannelKey, Promise<void>>();
const channelLastState = new Map<ChannelKey, QueueState>();
const channelPendingTarget = new Map<ChannelKey, QueueState>();

function makeKey(channelId: string, messageId: string): ChannelKey {
  return `${channelId}:${messageId}`;
}

const DEBOUNCE_MS = 200;
const RETRY_BACKOFFS_MS: readonly number[] = [200, 500, 1000];
const MAX_RETRY_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { httpStatus?: number; status?: number; code?: number };
  return e.httpStatus === 429 || e.status === 429 || e.code === 429;
}

async function callWithRetry(
  fn: () => Promise<void>,
  emoji: string,
  channelId: string,
  messageId: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await fn();
      return true;
    } catch (err) {
      if (!isRateLimitError(err)) {
        // Non-rate-limit error — single attempt, surface up so the caller
        // can decide. Reaction failures must never abort delivery (bridge
        // catches and logs); rethrowing here lets the caller distinguish
        // give-up-after-retry vs. one-shot-failure if needed.
        throw err;
      }
      if (attempt < MAX_RETRY_ATTEMPTS - 1) {
        await sleep(RETRY_BACKOFFS_MS[attempt]!);
      }
    }
  }
  // Exhausted budget — give up without updating state.
  // eslint-disable-next-line no-console
  console.warn(
    `[A2A-03] icon-transition-give-up channelId=${channelId} messageId=${messageId} emoji=${emoji}`,
  );
  return false;
}

/**
 * Transition the queue-state icon for a (channelId, messageId) pair.
 *
 * The mutex prevents two transitions on the same channel/message from
 * interleaving. The 200ms debounce collapses bursts to the latest target.
 * The retry budget bounds the helper so it can't stall the delivery pipe.
 *
 * Reaction failures NEVER throw to the caller — operator-visual UX is
 * decorative, NOT a precondition for message delivery. (The single
 * non-rate-limit error path inside `callWithRetry` does throw, but the
 * outer try/catch below swallows it for the same reason.)
 */
export async function transitionQueueState(
  channelId: string,
  messageId: string,
  target: QueueState,
  discord: DiscordChannelHandle,
  /**
   * 999.178 R1 — resolve a queue state to its `cc_name:id` reaction
   * identifier through the icon registry. `undefined` when the icon is not
   * loaded; the transition is then skipped entirely (no reaction, no state
   * tracking) — never a Unicode fallback. Injected so the module stays free
   * of the process-wide registry singleton and unit-testable.
   */
  resolveReaction: (state: QueueState) => string | undefined,
): Promise<void> {
  const key = makeKey(channelId, messageId);

  // Sticky terminal check FIRST — guard before joining the mutex queue.
  // A heartbeat-sweep retry that lands AFTER circle_check should be cheap (no
  // mutex acquisition, no debounce wait, no Discord API call).
  const priorPeek = channelLastState.get(key);
  if (priorPeek && TERMINAL_STATES.has(priorPeek)) {
    // eslint-disable-next-line no-console
    console.info(
      `[A2A-03] terminal-sticky-noop channelId=${channelId} messageId=${messageId} priorState=${priorPeek} attempted=${target}`,
    );
    return;
  }

  // Resolve the target icon up front. A missing icon (set not loaded) means
  // NO reaction and NO state change — degrade to nothing, never to Unicode.
  const targetEmoji = resolveReaction(target);
  if (targetEmoji === undefined) {
    return;
  }

  // Debounce — newest target wins. Subsequent transitions overwrite this
  // BEFORE acquiring the mutex; only the latest target survives the
  // 200ms wait.
  channelPendingTarget.set(key, target);

  const prevMutex = channelMutex.get(key) ?? Promise.resolve();
  const run = prevMutex.then(async () => {
    // Wait the debounce window. During this wait, if another transition
    // overwrites pendingTarget, the earlier one no-ops on its post-wait
    // re-read.
    await sleep(DEBOUNCE_MS);

    const latestPending = channelPendingTarget.get(key);
    if (latestPending !== target) {
      // A newer transition won the debounce — this one no-ops. The newer
      // transition's mutex slot will run next and handle its own debounce.
      return;
    }

    // Re-check terminal sticky inside the mutex (a prior transition in the
    // same mutex chain may have landed DELIVERED while this one waited).
    const prior = channelLastState.get(key);
    if (prior && TERMINAL_STATES.has(prior)) {
      // eslint-disable-next-line no-console
      console.info(
        `[A2A-03] terminal-sticky-noop-in-mutex channelId=${channelId} messageId=${messageId} priorState=${prior} attempted=${target}`,
      );
      return;
    }

    // Idempotent — same-state transition is a no-op (skips both Discord
    // API calls). This is the heartbeat-resend-while-already-QUEUED case.
    if (prior === target) {
      return;
    }

    // Atomic transition: remove prior (if any), then add new. Inside the
    // mutex so no other transition for this channel can interleave.
    try {
      let priorRemoved = true;
      if (prior !== undefined) {
        // Resolve the prior icon to remove it. If its icon is not loaded
        // (nothing was ever added for that state), there is nothing to remove.
        const priorEmoji = resolveReaction(prior);
        if (priorEmoji !== undefined) {
          priorRemoved = await callWithRetry(
            () => discord.removeReaction(channelId, messageId, priorEmoji),
            priorEmoji,
            channelId,
            messageId,
          );
        }
      }
      const added = await callWithRetry(
        () => discord.addReaction(channelId, messageId, targetEmoji),
        targetEmoji,
        channelId,
        messageId,
      );
      // Only update lastState if the add actually landed. If the add
      // gave up after the retry budget, the operator's Discord view
      // still shows the prior emoji (or none) — keep our model
      // consistent with what Discord actually accepted.
      if (added) {
        channelLastState.set(key, target);
      } else if (!priorRemoved) {
        // Both calls gave up — don't touch state.
      }
    } catch {
      // Non-rate-limit error — swallow. UX is decorative.
    }
  });

  channelMutex.set(key, run);
  // Don't await the mutex chain itself for cleanup — the next transition
  // will replace the slot. Just await this slot's completion.
  await run;
}

/**
 * Test-only reset. Module-scoped state survives across vitest `describe`
 * blocks; tests MUST call this in `beforeEach` so prior-test transitions
 * don't leak. Production callers never invoke this.
 */
export function _resetQueueStateMemory(): void {
  channelMutex.clear();
  channelLastState.clear();
  channelPendingTarget.clear();
}
