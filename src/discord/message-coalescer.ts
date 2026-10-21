/**
 * Phase 100 follow-up — per-agent pending-message coalescer.
 *
 * Operator-reported bug 2026-04-28: rapid-fire messages while the agent is
 * busy hit `SerialTurnQueue.QUEUE_FULL` (depth-1) and get ❌-reacted instead
 * of being processed. Coalescer buffers messages per agent at the bridge
 * layer (upstream of SerialTurnQueue) so the depth-1 queue never overflows.
 *
 * Semantics:
 *   - addMessage(agentName, content, messageId) — appends to agent's pending list
 *   - takePending(agentName) — atomically returns ALL pending messages for the
 *     agent + clears the list. Caller dispatches the joined payload as ONE turn.
 *   - requeue(agentName, messages) — Phase 999.11: prepends messages back into
 *     the buffer WITHOUT enforcing perAgentCap (these messages were already
 *     accepted once on initial addMessage; re-checking the cap on push-back
 *     would silently drop them).
 *
 * No persistence: in-memory only. Daemon restart drops pending messages
 * (acceptable — operator can resend after restart, and restart is rare).
 *
 * Per-agent cap: optional safety bound (default 50 pending messages) to
 * prevent runaway memory if dispatch is broken. When cap is hit, falls back
 * to the existing QUEUE_FULL → ❌ behavior at the bridge layer.
 */

/** A single pending message captured by the coalescer. */
export type CoalescedMessage = Readonly<{
  content: string;
  messageId: string;
  receivedAt: number;
}>;

/** Default per-agent buffer cap — guards against runaway memory. */
export const DEFAULT_PER_AGENT_CAP = 50;

export class MessageCoalescer {
  private readonly pending = new Map<string, CoalescedMessage[]>();
  private readonly perAgentCap: number;

  constructor(opts?: { readonly perAgentCap?: number }) {
    this.perAgentCap = opts?.perAgentCap ?? DEFAULT_PER_AGENT_CAP;
  }

  /**
   * Append a message to the agent's pending buffer.
   *
   * @returns true if added, false if cap reached (caller should fall back to ❌)
   */
  addMessage(agentName: string, content: string, messageId: string): boolean {
    const list = this.pending.get(agentName) ?? [];
    if (list.length >= this.perAgentCap) return false;
    // Immutable append — create a new list rather than mutating the existing array.
    const next: CoalescedMessage[] = [
      ...list,
      { content, messageId, receivedAt: Date.now() },
    ];
    this.pending.set(agentName, next);
    return true;
  }

  /**
   * Atomically remove and return all pending messages for an agent.
   * Returns empty array if agent has none pending.
   */
  takePending(agentName: string): readonly CoalescedMessage[] {
    const list = this.pending.get(agentName) ?? [];
    this.pending.delete(agentName);
    return list;
  }

  /**
   * Phase 999.11 — push messages back into the buffer without enforcing
   * perAgentCap.
   *
   * Used by the bridge's drain block when the hasActiveTurn gate fires or
   * the depth cap is hit — the messages came OUT of the buffer (via
   * takePending) and need to go back in for the next drain attempt. The
   * cap was already enforced on initial addMessage, so re-checking here
   * would silently drop accepted messages.
   *
   * Prepends so re-queued messages drain first on next take (FIFO across
   * the original arrival order is preserved because the original take
   * already drained them in order).
   */
  requeue(
    agentName: string,
    messages: ReadonlyArray<CoalescedMessage>,
  ): void {
    if (messages.length === 0) return;
    const list = this.pending.get(agentName) ?? [];
    // Immutable concat — create a new array with re-queued messages at the head.
    const next: CoalescedMessage[] = [...messages, ...list];
    this.pending.set(agentName, next);
  }

  /** Test/debug inspector — does not mutate state. */
  getPendingCount(agentName: string): number {
    return this.pending.get(agentName)?.length ?? 0;
  }

  /** 999.155 — agents with at least one buffered message (stranded-drain sweep). */
  agentsWithPending(): readonly string[] {
    return [...this.pending.entries()].filter(([, l]) => l.length > 0).map(([a]) => a);
  }

  /** 999.155 — the most recent buffered message, without taking it. */
  peekLast(agentName: string): CoalescedMessage | undefined {
    const list = this.pending.get(agentName);
    return list && list.length > 0 ? list[list.length - 1] : undefined;
  }
}
