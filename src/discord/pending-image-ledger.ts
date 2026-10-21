/**
 * Phase 999.154 WS-2 — side-channel for a turn's images.
 *
 * Images are NOT threaded through the message coalescer (its storm-fix
 * history makes it the last place to add payload). Instead the bridge records
 * `{agent, messageId → image sources}` here at arrival; at dispatch the images
 * for every message folded into the turn are read from the durable inbox by
 * path. A QUEUE_FULL-coalesced message keeps its entry until its combined
 * dispatch merges it; entries expire after TTL so nothing leaks.
 */

import type { TurnImageSource } from "../vision/turn-images.js";

const DEFAULT_TTL_MS = 30 * 60_000;

type Entry = { readonly sources: readonly TurnImageSource[]; readonly at: number };

export class PendingImageLedger {
  private readonly byAgent = new Map<string, Map<string, Entry>>();

  constructor(
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  add(agent: string, messageId: string, sources: readonly TurnImageSource[]): void {
    if (sources.length === 0) return;
    this.evict();
    let perAgent = this.byAgent.get(agent);
    if (perAgent === undefined) {
      perAgent = new Map();
      this.byAgent.set(agent, perAgent);
    }
    const prev = perAgent.get(messageId)?.sources ?? [];
    perAgent.set(messageId, { sources: [...prev, ...sources], at: this.now() });
  }

  /** Sources recorded for `messageId` (peek — does not remove). */
  get(agent: string, messageId: string): readonly TurnImageSource[] {
    this.evict();
    return this.byAgent.get(agent)?.get(messageId)?.sources ?? [];
  }

  release(agent: string, messageId: string): void {
    const perAgent = this.byAgent.get(agent);
    perAgent?.delete(messageId);
    if (perAgent?.size === 0) this.byAgent.delete(agent);
  }

  /** Move `fromIds`' sources (in order) onto `targetId` — combined dispatch. */
  mergeInto(agent: string, targetId: string, fromIds: readonly string[]): void {
    for (const id of fromIds) {
      if (id === targetId) continue;
      const sources = this.get(agent, id);
      if (sources.length === 0) continue;
      this.add(agent, targetId, sources);
      this.release(agent, id);
    }
  }

  size(): number {
    let n = 0;
    for (const m of this.byAgent.values()) n += m.size;
    return n;
  }

  private evict(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [agent, perAgent] of this.byAgent) {
      for (const [id, entry] of perAgent) {
        if (entry.at < cutoff) perAgent.delete(id);
      }
      if (perAgent.size === 0) this.byAgent.delete(agent);
    }
  }
}
