/**
 * Phase 999.154 WS-2 — answer a multi-message upload ONCE.
 *
 * Discord caps a message at 10 attachments, so a 25-image upload arrives as
 * three messages and used to get three partial replies. A message "leads" a
 * burst when it carries exactly the 10-attachment ceiling (a continuation is
 * likely) or images with no text. While the burst is open, later messages
 * from the same author in the same channel announce themselves on arrival
 * (before their downloads finish) and hand their formatted text + images to
 * the leader, which dispatches one turn for all of them.
 *
 * The leader waits for `quietMs` of silence with no member still preparing,
 * never longer than `maxWaitMs` unless a member is mid-download (hard ceiling
 * 3 × maxWaitMs). A member that misses the window just dispatches its own
 * turn as before — gathering can delay, it can never drop.
 *
 * Hand-off is two-phase: a member's `contribute()` resolves `true` only once
 * the leader has COMMITTED (merged it into its turn). If the leader fails
 * after opening the burst it ABORTS, every waiting member resolves `false`
 * and dispatches itself. A leader that neither commits nor aborts (a bug)
 * is caught by a watchdog that releases the members the same way.
 */

import type { TurnImageSource } from "../vision/turn-images.js";

export const DISCORD_MAX_ATTACHMENTS = 10;

export type BurstContribution = {
  readonly messageId: string;
  readonly text: string;
  readonly sources: readonly TurnImageSource[];
};

export type BurstTiming = { readonly quietMs: number; readonly maxWaitMs: number };

export type BurstLeader = {
  /** Resolves with the members' contributions (arrival order) once the burst closes. */
  wait(): Promise<readonly BurstContribution[]>;
  /** The leader merged the contributions into its turn — members may stand down. */
  commit(): void;
  /** The leader failed — close the burst; every member dispatches itself. */
  abort(): void;
};

export type BurstMember = {
  /**
   * Resolves true once the leader committed this contribution into its turn;
   * false ⇒ the member must dispatch its own turn (missed the window, or the
   * leader aborted).
   */
  contribute(c: Omit<BurstContribution, "messageId">): Promise<boolean>;
  /** The member is not joining after all (e.g. it was routed elsewhere). */
  abandon(): void;
};

/** Release members if a closed burst's leader never commits or aborts. */
export const COMMIT_WATCHDOG_MS = 60_000;

type Burst = {
  readonly leaderId: string;
  readonly startedAt: number;
  lastActivity: number;
  readonly pending: Set<string>;
  readonly contributions: BurstContribution[];
  /** Per-contribution settle callbacks (index-aligned with `contributions`). */
  readonly settles: Array<(taken: boolean) => void>;
  /** "open" → "closed" (wait resolved) → "committed" | "aborted". */
  outcome: "pending" | "committed" | "aborted";
  closed: boolean;
  resolve: ((c: readonly BurstContribution[]) => void) | null;
  timer: ReturnType<typeof setTimeout> | null;
  readonly timing: BurstTiming;
};

export function shouldLeadBurst(args: {
  readonly attachmentCount: number;
  readonly imageCount: number;
  readonly text: string;
}): boolean {
  if (args.attachmentCount >= DISCORD_MAX_ATTACHMENTS) return true;
  return args.imageCount > 0 && args.text.trim().length === 0;
}

export class BurstGatherer {
  private readonly bursts = new Map<string, Burst>();

  constructor(private readonly now: () => number = Date.now) {}

  static key(channelId: string, authorId: string): string {
    return `${channelId}:${authorId}`;
  }

  isOpen(key: string): boolean {
    const b = this.bursts.get(key);
    return b !== undefined && !b.closed;
  }

  /** Open a burst led by `leaderId`. Call on arrival, BEFORE downloading. */
  open(key: string, leaderId: string, timing: BurstTiming): BurstLeader {
    const t = this.now();
    const burst: Burst = {
      leaderId,
      startedAt: t,
      lastActivity: t,
      pending: new Set(),
      contributions: [],
      settles: [],
      outcome: "pending",
      closed: false,
      resolve: null,
      timer: null,
      timing,
    };
    this.bursts.set(key, burst);
    const promise = new Promise<readonly BurstContribution[]>((resolve) => {
      burst.resolve = resolve;
    });
    this.schedule(key, burst);
    return {
      wait: () => promise,
      commit: () => this.settle(key, burst, "committed"),
      abort: () => this.settle(key, burst, "aborted"),
    };
  }

  private settle(key: string, burst: Burst, outcome: "committed" | "aborted"): void {
    if (burst.outcome !== "pending") return;
    burst.outcome = outcome;
    if (!burst.closed) this.close(key, burst);
    const taken = outcome === "committed";
    for (const s of burst.settles.splice(0)) s(taken);
  }

  /** A message arrived while a burst is open for its author+channel. Null ⇒ none open. */
  announce(key: string, messageId: string): BurstMember | null {
    const burst = this.bursts.get(key);
    if (burst === undefined || burst.closed || burst.leaderId === messageId) return null;
    burst.pending.add(messageId);
    burst.lastActivity = this.now();
    this.schedule(key, burst);
    return {
      contribute: (c) => {
        burst.pending.delete(messageId);
        if (burst.closed || burst.outcome !== "pending") return Promise.resolve(false);
        return new Promise<boolean>((resolve) => {
          burst.contributions.push({ messageId, ...c });
          burst.settles.push(resolve);
          burst.lastActivity = this.now();
          this.schedule(key, burst);
        });
      },
      abandon: () => {
        burst.pending.delete(messageId);
        if (!burst.closed) this.schedule(key, burst);
      },
    };
  }

  private schedule(key: string, burst: Burst): void {
    if (burst.closed) return;
    if (burst.timer !== null) clearTimeout(burst.timer);
    const t = this.now();
    const { quietMs, maxWaitMs } = burst.timing;
    const elapsed = t - burst.startedAt;
    const quietFor = t - burst.lastActivity;
    const hardCeiling = elapsed >= maxWaitMs * 3;
    const settled = burst.pending.size === 0 && (quietFor >= quietMs || elapsed >= maxWaitMs);
    if (settled || hardCeiling) {
      this.close(key, burst);
      return;
    }
    const nextQuiet = Math.max(0, quietMs - quietFor);
    const nextMax = Math.max(0, maxWaitMs - elapsed);
    const delay = Math.max(20, Math.min(nextQuiet, burst.pending.size > 0 ? maxWaitMs * 3 - elapsed : nextMax));
    burst.timer = setTimeout(() => this.schedule(key, burst), delay);
    (burst.timer as { unref?: () => void }).unref?.();
  }

  private close(key: string, burst: Burst): void {
    burst.closed = true;
    if (burst.timer !== null) clearTimeout(burst.timer);
    burst.timer = null;
    if (this.bursts.get(key) === burst) this.bursts.delete(key);
    burst.resolve?.([...burst.contributions]);
    burst.resolve = null;
    if (burst.outcome === "pending" && burst.settles.length > 0) {
      const watchdog = setTimeout(() => this.settle(key, burst, "aborted"), COMMIT_WATCHDOG_MS);
      (watchdog as { unref?: () => void }).unref?.();
    }
  }
}
