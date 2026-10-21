/**
 * Steer-subagent orchestrator (auto-steer feature, 2026-05-23).
 *
 * Mid-flight subagent redirection without cancel-and-respawn. Two paths
 * call this:
 *
 *   Path A (in-thread auto-steer) — bridge.ts thread-route branch. When a
 *     human operator posts in a subagent thread WHILE the subagent has
 *     an active turn, the bridge calls `prepareSubagentSteer` to
 *     interrupt the in-flight turn + reset the relay gates, then wraps
 *     the operator's message with the `<operator-steering>` frame and
 *     proceeds with normal turn dispatch.
 *
 *   Path B (parent-triggered) — `steer_subagent` MCP tool the parent
 *     agent calls when the operator gives steer guidance in the parent's
 *     own main channel. Daemon IPC handler calls
 *     `prepareSubagentSteer` then posts the framed guidance into the
 *     subagent's thread (marked as a pending-steer message so bridge
 *     accepts the bot-authored post and dispatches it).
 *
 * Pure orchestrator with injected dependencies (no Discord client, no
 * registry file path) so unit tests can pass `vi.fn()` for each dep.
 *
 * Steps performed by `prepareSubagentSteer`:
 *
 *   1. Look up the binding for `threadId`. Refuse:
 *      - `no-binding`  → threadId is not a known subagent thread
 *      - `terminal`    → binding already has `completedAt` set; the
 *                        subagent is done and should not be steered
 *      - `not-subagent`→ binding exists but is operator-defined (not
 *                        `*-sub-*` / `*-via-*`); steer is a subagent
 *                        concept only
 *   2. Interrupt the subagent's in-flight turn. Safe when idle
 *      (`hadActiveTurn=false`, `interrupted=false` — both paths still
 *      proceed; an idle subagent just gets the steer as its next turn).
 *   3. Reset the relay gates so the gated quiescence-relay (Phase
 *      bdf2cdc3 + the 2026-05-23 fix) doesn't fire on the
 *      half-delivered, now-interrupted turn. The next genuine
 *      completion re-arms the gates (subagent_complete OR the spawner's
 *      post-delivery stamp for follow-up turns).
 *
 * Dispatch is intentionally OUT OF SCOPE for this helper — Path A
 * proceeds with bridge's normal `turnDispatcher.dispatchStream` flow
 * after the prep, and Path B posts a framed message into the thread
 * that bridge then picks up. Both rely on the existing Discord →
 * bridge → dispatcher pipeline so the steer is never a special-case
 * dispatch path.
 *
 * The `<operator-steering>` frame text is exposed as a helper so both
 * paths produce byte-identical wrapping.
 */

import type { Logger } from "pino";
import type { ThreadBinding } from "../discord/thread-types.js";
import { isSubagentThreadName } from "./subagent-name.js";

/**
 * Post-interrupt clear-wait policy (2026-05-23 fix to the auto-steer
 * dispatch race).
 *
 * `handle.interrupt()` is fire-and-forget — the SDK aborts at its
 * next yield point, which can lag tens of ms behind the call when a
 * tool call is mid-execution. If `dispatchStream` (or the
 * spawner's `streamFromAgent`) fires immediately after `interrupt()`,
 * it races the still-aborting turn and either:
 *   - Throws / rejects the new dispatch (session busy)
 *   - Queues silently behind the abort (typing indicator doesn't fire
 *     until the abort completes — which can be after the operator
 *     re-sends the message)
 *
 * Fix: poll `hasActiveTurn` at `STEER_CLEAR_POLL_MS` intervals for up
 * to `STEER_CLEAR_MAX_WAIT_MS` before letting the caller dispatch.
 * Existing `/clawcode-steer` slash handler shipped this pattern;
 * `prepareSubagentSteer` now owns it so bridge auto-steer (Path A)
 * and the `steer_subagent` MCP tool (Path B) inherit the same wait.
 *
 * Constants exported so the slash handler can re-use them — single
 * source of truth across all three steer surfaces.
 */
export const STEER_CLEAR_POLL_MS = 50;
export const STEER_CLEAR_MAX_WAIT_MS = 2000;

export type PrepareSteerResult =
  | {
      readonly ok: true;
      readonly sessionName: string;
      readonly parentChannelId: string;
      readonly parentAgentName: string;
      readonly interrupted: boolean;
      readonly hadActiveTurn: boolean;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "no-binding"
        | "terminal"
        | "not-subagent"
        | "interrupt-failed"
        | "gate-reset-failed";
      readonly detail?: string;
    };

export type PrepareSteerDeps = {
  /** Reads the binding for a threadId. Returns undefined if no binding. */
  readonly getBinding: (threadId: string) => Promise<ThreadBinding | undefined>;
  /**
   * Interrupts the subagent's in-flight turn. Production binds
   * `sessionManager.interruptAgent(sessionName)`. Safe to call when
   * idle — returns `{ interrupted: false, hadActiveTurn: false }`.
   */
  readonly interruptAgent: (sessionName: string) => Promise<{
    readonly interrupted: boolean;
    readonly hadActiveTurn: boolean;
  }>;
  /**
   * Synchronous query: is the subagent's SDK turn currently in flight?
   * Production binds `sessionManager.hasActiveTurn(sessionName)`. Used
   * by the post-interrupt poll loop to gate the caller's dispatch
   * until the abort has actually settled — closes the race where
   * `interrupt()` returns immediately but the SDK is still aborting a
   * tool call.
   */
  readonly hasActiveTurn: (sessionName: string) => boolean;
  /**
   * Async sleep — used by the post-interrupt poll loop. Production
   * binds `(ms) => new Promise((r) => setTimeout(r, ms))`. Tests
   * inject a no-op `() => Promise.resolve()` so the loop runs
   * instantly and the deadline-exhausted branch can be exercised.
   */
  readonly sleep: (ms: number) => Promise<void>;
  /**
   * Atomically clears the relay gates on the binding. Production binds
   * `resetSteerGates(THREAD_REGISTRY_PATH, threadId)`.
   */
  readonly resetSteerGates: (
    threadId: string,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  readonly log: Logger;
};

/**
 * Bridge auto-steer trigger predicate. Pure boolean so the AND-clause
 * in `bridge.ts` is unit-testable — a typo in any gate would otherwise
 * silently degrade to "no steer ever fires" (or worse, "every casual
 * check-in fires") with the orchestrator + mutator tests still passing.
 *
 * Returns true when ALL FOUR gates pass:
 *  - `isSubagentThread` — bridge resolved the thread to a `*-sub-*` /
 *    `*-via-*` session name; non-subagent threads are out of scope.
 *  - `isAcceptedAuthor` — message is from a human operator. Pre-computed
 *    by the bridge: `!message.author.bot && message.webhookId === null`.
 *    Path-B forwarded bot posts are NOT accepted here — their body is
 *    already framed with `<operator-steering>` by the IPC handler, so
 *    re-wrapping would double-frame. They flow through the bridge's
 *    normal dispatch instead.
 *  - `hasActiveTurn` — the subagent is currently turning. An idle
 *    subagent doesn't need an interrupt; the message becomes the next
 *    user turn through the normal dispatch path.
 *  - `hasSteerMarker` (2026-05-24) — operator opt-in marker. ANY human
 *    message in a subagent thread used to trigger the wrap, which
 *    killed in-flight tool work on every casual check-in ("still
 *    going?"). Now: bridge wraps only when the operator explicitly
 *    signals intent via a leading 🧭 emoji (`hasLeadingSteerMarker`).
 *    Without the marker, the message dispatches as-is and queues
 *    behind the active turn via the SDK's turn lock — same as the
 *    pre-auto-steer behavior.
 *
 * The function is intentionally trivial — its value is being a single
 * source of truth for the trigger condition so refactors can't quietly
 * desync the gates from the test.
 */
export function shouldAutoSteer(args: {
  readonly isSubagentThread: boolean;
  readonly isAcceptedAuthor: boolean;
  readonly hasActiveTurn: boolean;
  readonly hasSteerMarker: boolean;
}): boolean {
  return (
    args.isSubagentThread &&
    args.isAcceptedAuthor &&
    args.hasActiveTurn &&
    args.hasSteerMarker
  );
}

/**
 * Steer-marker emoji (compass needle, U+1F9ED) — leading character of
 * the operator's message that signals intent to redirect a running
 * subagent. Single source of truth so bridge + tests + docs reference
 * the same codepoint.
 *
 * Rationale for the marker design: pre-2026-05-24 auto-steer triggered
 * on ANY human message during an active turn, killing in-flight tool
 * work on every casual check-in. The 🧭 marker makes steer intent
 * explicit while staying lightweight — no slash command typing, just a
 * single emoji prefix the operator can copy/paste or use a keyboard
 * shortcut for.
 */
export const STEER_MARKER_EMOJI = "🧭";

/**
 * Returns `true` when `content`, after trimming leading whitespace,
 * begins with the steer-marker emoji (`🧭`, U+1F9ED). Used by the
 * bridge auto-steer trigger to require explicit operator opt-in.
 *
 * Pure function — no I/O, no logging, no side effects. Empty / undefined
 * / whitespace-only input returns `false`.
 *
 * The 🧭 emoji is a 2-char UTF-16 surrogate pair in JavaScript
 * (`🧭`). `String.prototype.startsWith` handles this
 * correctly because the surrogate pair is contiguous; we don't need
 * the unicode regex flag.
 */
export function hasLeadingSteerMarker(content: string | undefined | null): boolean {
  if (!content) return false;
  return content.trimStart().startsWith(STEER_MARKER_EMOJI);
}

/**
 * Wraps operator guidance with the `<operator-steering>` frame so the
 * model recognises mid-task redirection vs. a fresh task. Single source
 * so Path A and Path B produce byte-identical framing.
 *
 * The frame text is deliberately specific — "integrate this with what
 * you've already done" — so the model doesn't restart from scratch.
 */
export function frameSteeringGuidance(guidance: string): string {
  return [
    "<operator-steering>",
    "The operator has updated the directive mid-task. Your previous work in this thread is preserved — apply this guidance to the in-progress task. Do NOT restart from scratch; integrate this with what you've already done.",
    "",
    "New directive:",
    guidance.trim(),
    "</operator-steering>",
  ].join("\n");
}

/**
 * Performs the prep steps (lookup + interrupt + gate reset). Returns
 * metadata callers (bridge / IPC handler) use to drive the next stage.
 *
 * NEVER throws — every failure mode folds into `{ ok: false, reason }`
 * so the caller (which is often in the middle of an async Discord
 * event handler) can log + skip without crashing.
 */
export async function prepareSubagentSteer(args: {
  readonly threadId: string;
  readonly deps: PrepareSteerDeps;
}): Promise<PrepareSteerResult> {
  const { threadId, deps } = args;

  let binding: ThreadBinding | undefined;
  try {
    binding = await deps.getBinding(threadId);
  } catch (err) {
    deps.log.warn(
      {
        component: "steer-subagent",
        action: "binding-read-failed",
        threadId,
        err: (err as Error).message,
      },
      "steer prep — binding read failed",
    );
    return { ok: false, reason: "no-binding", detail: (err as Error).message };
  }
  if (!binding) {
    return { ok: false, reason: "no-binding" };
  }
  if (binding.completedAt !== undefined && binding.completedAt !== null) {
    return { ok: false, reason: "terminal" };
  }
  if (!isSubagentThreadName(binding.sessionName)) {
    return { ok: false, reason: "not-subagent" };
  }

  let interrupted = false;
  let hadActiveTurn = false;
  try {
    const result = await deps.interruptAgent(binding.sessionName);
    interrupted = result.interrupted;
    hadActiveTurn = result.hadActiveTurn;
  } catch (err) {
    deps.log.warn(
      {
        component: "steer-subagent",
        action: "interrupt-failed",
        threadId,
        sessionName: binding.sessionName,
        err: (err as Error).message,
      },
      "steer prep — interrupt failed (non-fatal; gate reset + dispatch still attempted)",
    );
    return {
      ok: false,
      reason: "interrupt-failed",
      detail: (err as Error).message,
    };
  }

  // Poll-until-clear (2026-05-23) — close the dispatch race.
  // `interrupt()` fires async; the SDK aborts at the next yield point.
  // Without this wait, the caller's dispatch races the still-aborting
  // turn and the operator's first steer gets silently queued (typing
  // indicator doesn't fire until the abort settles — symptom: "I have
  // to reprint it for the typing indicator to appear"). Mirrors the
  // existing `/clawcode-steer` slash handler's poll loop exactly.
  //
  // Only polls when we actually interrupted an active turn — an idle
  // subagent has nothing to wait for. Caps at STEER_CLEAR_MAX_WAIT_MS
  // (2s) so a wedged subagent doesn't block the operator's prep
  // indefinitely; on deadline the caller dispatches anyway and the
  // SDK queues the new turn behind the still-aborting one.
  let cleared = !hadActiveTurn;
  let waitedMs = 0;
  if (hadActiveTurn) {
    const deadline = Date.now() + STEER_CLEAR_MAX_WAIT_MS;
    const start = Date.now();
    // Read once before the loop, then re-read after each sleep. Avoids
    // a double-read at the top of the loop (one for the while
    // condition, one for the final `cleared` decision) — single read
    // per cycle keeps the test assertions clean.
    let stillActive = deps.hasActiveTurn(binding.sessionName);
    while (stillActive && Date.now() < deadline) {
      await deps.sleep(STEER_CLEAR_POLL_MS);
      stillActive = deps.hasActiveTurn(binding.sessionName);
    }
    cleared = !stillActive;
    waitedMs = Date.now() - start;
    if (!cleared) {
      deps.log.warn(
        {
          component: "steer-subagent",
          action: "clear-wait-deadline",
          threadId,
          sessionName: binding.sessionName,
          waitedMs,
          maxWaitMs: STEER_CLEAR_MAX_WAIT_MS,
        },
        "steer prep — turn did not clear within deadline; caller will dispatch anyway (queue behind abort)",
      );
    } else {
      deps.log.info(
        {
          component: "steer-subagent",
          action: "clear-wait-cleared",
          threadId,
          sessionName: binding.sessionName,
          waitedMs,
        },
        "steer prep — in-flight turn cleared after interrupt",
      );
    }
  }

  const gateReset = await deps.resetSteerGates(threadId);
  if (!gateReset.ok) {
    deps.log.warn(
      {
        component: "steer-subagent",
        action: "gate-reset-failed",
        threadId,
        sessionName: binding.sessionName,
        reason: gateReset.reason,
      },
      "steer prep — gate reset failed (the quiescence-relay may fire on the interrupted turn's stamp)",
    );
    return {
      ok: false,
      reason: "gate-reset-failed",
      detail: gateReset.reason,
    };
  }

  deps.log.info(
    {
      component: "steer-subagent",
      action: "prepared",
      threadId,
      sessionName: binding.sessionName,
      interrupted,
      hadActiveTurn,
    },
    "steer prep — interrupted + gates reset; ready for dispatch",
  );

  return {
    ok: true,
    sessionName: binding.sessionName,
    parentChannelId: binding.parentChannelId,
    parentAgentName: binding.agentName,
    interrupted,
    hadActiveTurn,
  };
}
