/**
 * Phase 999.117 WS-2 — cross-path delivery de-duplication.
 *
 * WHY THIS EXISTS
 *
 * ClawCode can deliver ONE logical A2A message through more than one path,
 * and each path independently believes it is the delivery:
 *
 *   1. the inbox file, consumed by the InboxSource chokidar watcher
 *   2. the same inbox file, swept later by the heartbeat reconciler
 *   3. the webhook embed, relayed back by bridge.handleAgentMessage
 *   4. the v3 ClawCode-channel push
 *
 * `post_to_agent` writes the inbox record AND posts a webhook embed. The
 * watcher turns the file into a turn; the bridge turns the embed into a
 * second turn, formatted differently (`[Message from X]:` vs
 * `[Agent Message from X]`). Nothing reconciles them. That is why enabling
 * the webhook path made the reported loop WORSE rather than better — it
 * doubled every hop. The v3 push has the same shape: it returns early
 * without retiring the inbox record it just wrote, so the watcher delivers
 * it again.
 *
 * DESIGN — dedupe is the floor, not the cleanup
 *
 * This is deliberately the FIRST thing WS-2 lands, before any restructuring
 * of the producer side. Collapsing four producers into one transport is the
 * right end state, but a restructure's characteristic failure is missing a
 * path — and a missed path silently reintroduces double delivery. Dedupe at
 * the CONSUMER makes that impossible regardless of how many producers exist
 * or which ones a later refactor forgets. The transport/presentation split
 * then becomes a simplification rather than the thing correctness rests on.
 *
 * This is the standard at-least-once + idempotent-consumer pairing. True
 * exactly-once delivery is not achievable in a distributed system; what is
 * achievable is at-least-once delivery plus a consumer that collapses
 * repeats on a stable key. That key is the envelope's `deliveryId`.
 *
 * SCOPE / LIFETIME
 *
 * In-memory, bounded, TTL'd. Not persisted: after a daemon restart a
 * redelivered message SHOULD get through, because a restart is exactly when
 * an in-flight message may have been lost before it reached a turn. The TTL
 * bounds the other direction — an id seen an hour ago must not suppress a
 * genuinely new message that happens to reuse it.
 */

/** Default window in which a repeated deliveryId is treated as a duplicate. */
const DEFAULT_TTL_MS = 3_600_000; // 1 hour

/** Hard cap on tracked ids. FIFO-evicted; far above any real concurrency. */
const DEFAULT_CAP = 4096;

export type DeliveryDedupeOptions = Readonly<{
  ttlMs?: number;
  cap?: number;
  /** Injected clock — production passes `() => Date.now()`. */
  now?: () => number;
}>;

/**
 * Records which delivery ids have already produced a turn.
 *
 * ONE instance per daemon, shared by every consumer. Separate instances
 * would each see a subset of the paths and dedupe nothing across them, which
 * is precisely the bug being fixed.
 */
export class DeliveryDedupe {
  private readonly ttlMs: number;
  private readonly cap: number;
  private readonly now: () => number;
  private readonly seen = new Map<string, number>();

  constructor(options: DeliveryDedupeOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.cap = options.cap ?? DEFAULT_CAP;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Claim a delivery. Returns true when the caller OWNS this delivery and
   * should dispatch a turn; false when another consumer already did.
   *
   * Claim-and-record in one call on purpose: a separate `has()` then `mark()`
   * invites a caller to check, take an await, and let a second consumer slip
   * through the gap. The two inbox consumers can genuinely race — the
   * chokidar watcher and the heartbeat sweep both read the same directory.
   *
   * An absent/empty id is always claimable: legacy on-disk messages predate
   * the envelope, and refusing to deliver them would be a worse failure than
   * an occasional duplicate.
   */
  claim(deliveryId: string | undefined): boolean {
    if (deliveryId === undefined || deliveryId === "") return true;

    const now = this.now();
    const seenAt = this.seen.get(deliveryId);
    if (seenAt !== undefined && now - seenAt < this.ttlMs) {
      return false;
    }

    this.seen.set(deliveryId, now);
    if (this.seen.size > this.cap) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }

  /** Test/diagnostic: number of tracked delivery ids. */
  size(): number {
    return this.seen.size;
  }
}
