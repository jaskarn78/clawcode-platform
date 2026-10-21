/**
 * LegacyForkAdvisor — wraps the extracted `forkAdvisorConsult()` primitive
 * as an `AdvisorBackend` implementation. This is the operator rollback
 * path for Phase 117 — agents whose `advisor.backend` is set to `"fork"`
 * (default is `"native"` once Plan 117-06 lands the config schema) take
 * the same code path as pre-117 production: fork the agent under an
 * Opus override, dispatch one turn, kill the fork.
 *
 * The real fork logic lives in `src/manager/daemon.ts:forkAdvisorConsult`
 * (extracted in Plan 117-03 T02 from the inline body that previously
 * lived at `daemon.ts:9843–9854`). This class is a thin adapter — it
 * exists so:
 *   1. The provider-neutral `AdvisorService` can dispatch to legacy
 *      behavior through the same `AdvisorBackend.consult({...})` shape
 *      as the native and (future) portable backends.
 *   2. `BackendId === "fork"` resolves to a real callable in the
 *      registry (Plan 117-02 / 117-06 wiring).
 *
 * Plan reference: CONTEXT.md `<scope>` —
 *   "`LegacyForkAdvisor` — wraps today's daemon fork logic extracted
 *    into a function. Preserves current behavior as the rollback path."
 *
 * RESEARCH §3 file map row for `src/advisor/backends/legacy-fork.ts`.
 *
 * Circular-dependency note (RESEARCH §3, Plan 117-03 T03 step 4):
 *   `legacy-fork.ts` imports `forkAdvisorConsult` from
 *   `src/manager/daemon.ts`. `daemon.ts` imports nothing from
 *   `src/advisor/backends/` and only depends on `src/advisor/prompts.ts`
 *   for the system-prompt builder — so the dep graph is a tree:
 *
 *     legacy-fork.ts → daemon.ts → advisor/prompts.ts
 *
 *   No cycle exists. If a future change adds `daemon.ts → backends/*`
 *   the escape hatch documented in the plan is to move
 *   `forkAdvisorConsult` into a new file `src/manager/fork-advisor.ts`
 *   and re-export from daemon.ts.
 */

import type { AdvisorBackend } from "./types.js";
import type { BackendId } from "../types.js";
import type { SessionManager } from "../../manager/session-manager.js";
import { forkAdvisorConsult } from "../../manager/daemon.js";

/**
 * Per-consult deadline. Without it a wedged consult holds a full forked
 * `claude` session for as long as the turn refuses to settle — only the
 * 10/day `AdvisorBudget` bounded it, and the fork reaper that would
 * eventually collect the session defaults off.
 */
export const ADVISOR_FORK_TIMEOUT_MS = 600_000;

/**
 * Grace granted to the graceful abort path before the hard backstop fires.
 * Must exceed `INTERRUPT_DEADLINE_MS` (2s, `persistent-session-handle.ts`)
 * — that is how long the turn loop takes to reject after the signal aborts.
 * Too small and the backstop always wins, leaving the graceful path dead.
 */
export const ADVISOR_FORK_ABORT_GRACE_MS = 5_000;

/**
 * Thrown when a consult blows its deadline. `code` is a forward-compatible
 * identifier: fork-backend errors reach the caller through the IPC error
 * envelope today, not through the native `advisor unavailable (<code>)`
 * footer, which is fed only by SDK stream events.
 */
export class AdvisorTimeoutError extends Error {
  readonly code = "advisor_timeout";

  constructor(agent: string, timeoutMs: number, options?: { cause?: unknown }) {
    super(
      `Advisor consult for agent '${agent}' exceeded ${timeoutMs}ms — ` +
        "fork aborted and stopped.",
      options,
    );
    this.name = "AdvisorTimeoutError";
  }
}

/**
 * `SessionManager` view handed to `forkAdvisorConsult` so the deadline can
 * reach a primitive that lives in `daemon.ts` and takes no signal:
 *   - `dispatchTurn` carries the consult's abort signal, so the turn loop
 *     rejects on timeout and the primitive's own `finally` stops the fork;
 *   - `forkSession` reports the fork name, so the backstop can stop a fork
 *     that materialises after the consult was abandoned.
 *
 * `Object.create` keeps every method the primitive might grow reachable,
 * and each override delegates with `manager` as the receiver so no call
 * ever runs against the derived object.
 */
function instrumentForConsult(
  manager: SessionManager,
  signal: AbortSignal,
  onForkCreated: (forkName: string) => void,
): SessionManager {
  const overrides: Pick<
    SessionManager,
    "forkSession" | "dispatchTurn" | "stopAgent"
  > = {
    forkSession: async (agentName, options) => {
      const fork = await manager.forkSession(agentName, options);
      onForkCreated(fork.forkName);
      return fork;
    },
    dispatchTurn: (name, message, turn, options) =>
      manager.dispatchTurn(name, message, turn, {
        ...options,
        signal: options?.signal
          ? AbortSignal.any([options.signal, signal])
          : signal,
      }),
    stopAgent: (name) => manager.stopAgent(name),
  };
  return Object.assign(Object.create(manager) as SessionManager, overrides);
}

/**
 * `AdvisorBackend` implementation that dispatches via the legacy
 * `forkSession` + `dispatchTurn` + `stopAgent` primitive.
 *
 * The backend itself owns no state — it forwards `consult()` to
 * `forkAdvisorConsult(this.manager, args)` under a per-consult
 * deadline (`ADVISOR_FORK_TIMEOUT_MS`). The injected `manager` is
 * the daemon-wide `SessionManager` singleton (constructed in
 * `daemon.ts:bootstrap` and registered into the `BackendRegistry` by
 * Plan 117-06/117-07).
 */
export class LegacyForkAdvisor implements AdvisorBackend {
  readonly id: BackendId = "fork";

  constructor(
    private readonly manager: SessionManager,
    private readonly timeoutMs: number = ADVISOR_FORK_TIMEOUT_MS,
    private readonly abortGraceMs: number = ADVISOR_FORK_ABORT_GRACE_MS,
  ) {}

  /**
   * Perform one fork-based advisor consultation, bounded by `timeoutMs`.
   *
   * Dispatch behavior is the pre-117 inline IPC body — see
   * `forkAdvisorConsult` in `src/manager/daemon.ts` for the contract
   * (try/finally stopAgent invariant, no truncation/budget here). The
   * deadline is layered on top: the signal aborts the turn, which makes
   * the primitive's `finally` stop the fork; the backstop covers the
   * window the signal cannot reach (a `forkSession` that never returns
   * never reaches `dispatchTurn`). Either way the consult rejects with
   * `AdvisorTimeoutError` instead of holding the session.
   *
   * Returns the raw (untruncated) answer; the caller — today the IPC
   * handler in `daemon.ts:ask-advisor`, Plan 117-07 the
   * `AdvisorService` — owns truncation and budget recording.
   */
  async consult(args: {
    agent: string;
    question: string;
    systemPrompt: string;
    advisorModel: string;
    timeoutMs?: number;
  }): Promise<{ answer: string }> {
    const deadline = new AbortController();
    let forkName: string | null = null;
    let abandoned = false;
    const timeoutMs = args.timeoutMs ?? this.timeoutMs;

    const abortTimer = setTimeout(() => deadline.abort(), timeoutMs);
    let backstopTimer: ReturnType<typeof setTimeout> | undefined;

    const consult = forkAdvisorConsult(
      instrumentForConsult(this.manager, deadline.signal, (name) => {
        forkName = name;
        // The fork can surface after the backstop already gave up.
        if (abandoned) void this.manager.stopAgent(name).catch(() => {});
      }),
      args,
    );
    // The backstop rejects the race; the abandoned consult must not land as
    // an unhandled rejection whenever it eventually settles.
    void consult.catch(() => {});

    const backstop = new Promise<never>((_resolve, reject) => {
      backstopTimer = setTimeout(() => {
        abandoned = true;
        if (forkName !== null) void this.manager.stopAgent(forkName).catch(() => {});
        reject(new AdvisorTimeoutError(args.agent, timeoutMs));
      }, timeoutMs + this.abortGraceMs);
    });

    try {
      return await Promise.race([consult, backstop]);
    } catch (err) {
      if (err instanceof AdvisorTimeoutError) throw err;
      // Graceful path: the abort rejected the turn and the primitive
      // already stopped the fork — report it as the timeout it is.
      if (deadline.signal.aborted) {
        throw new AdvisorTimeoutError(args.agent, timeoutMs, { cause: err });
      }
      throw err;
    } finally {
      clearTimeout(abortTimer);
      if (backstopTimer !== undefined) clearTimeout(backstopTimer);
    }
  }
}
