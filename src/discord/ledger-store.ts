/**
 * Verification ledger store — per delivered reply: the evidence + claims
 * snapshot at delivery, linked to the Discord message id(s) that carried it,
 * so a 🧾 reaction or button can answer without a model turn. In-memory
 * (2h / 200, same shape/limits as DeliveredMessageRefStore) with an optional
 * durable backing (`LedgerPersistenceLike`, sqlite in ledger-store-sqlite.ts)
 * consulted on a memory miss so the button survives a restart. This file has
 * no sqlite import — the persistence is injected.
 */

import type { ClaimEntry } from "../manager/claim-ledger.js";
import type { EvidenceEntry } from "../manager/evidence-ledger.js";
import type { RecallRecord } from "../manager/recall-footer.js";

export const LEDGER_MAX_AGE_MS = 2 * 60 * 60 * 1000;
export const LEDGER_MAX_ENTRIES = 200;
/** How long after delivery an id-less ledger may still adopt chunk ids. */
export const LEDGER_LINK_LATEST_WINDOW_MS = 5 * 60 * 1000;

export interface TurnLedger {
  readonly turnId: string;
  readonly agent: string;
  readonly channelId: string | null;
  readonly promptExcerpt?: string;
  readonly evidence: readonly EvidenceEntry[];
  readonly claims: readonly ClaimEntry[];
  readonly deliveredAt: number;
  readonly messageIds: readonly string[];
  readonly clientFacing: boolean;
  /**
   * Phase 999.133 — what the pre-turn retrieval put in front of the model
   * (memories, notes, documents). Rides the same 🧾 Sources button and card
   * as the verification ledger; present on its own for non-verified agents.
   */
  readonly recall?: RecallRecord;
}

/**
 * Durable backing for the store. Every method is best-effort: implementations
 * must not throw (the store guards anyway — memory always wins).
 */
export interface LedgerPersistenceLike {
  upsert(ledger: TurnLedger): void;
  link(turnId: string, messageIds: readonly string[]): void;
  byMessageId(messageId: string): TurnLedger | undefined;
  updateClaims(turnId: string, claims: readonly ClaimEntry[]): void;
}

export interface VerificationLedgerStoreOptions {
  readonly persist?: LedgerPersistenceLike;
}

export class VerificationLedgerStore {
  private readonly byTurn = new Map<string, TurnLedger>();
  private readonly byMessage = new Map<string, string>();
  private readonly cardPostedFor = new Map<string, number>();
  private readonly persist: LedgerPersistenceLike | undefined;

  constructor(options: VerificationLedgerStoreOptions = {}) {
    this.persist = options.persist;
  }

  record(ledger: TurnLedger, now: number = Date.now()): void {
    this.prune(now);
    this.byTurn.set(ledger.turnId, ledger);
    for (const id of ledger.messageIds) this.byMessage.set(id, ledger.turnId);
    if (this.byTurn.size > LEDGER_MAX_ENTRIES) {
      const oldest = [...this.byTurn.entries()].sort((a, b) => a[1].deliveredAt - b[1].deliveredAt)[0];
      if (oldest) this.drop(oldest[0]);
    }
    this.withPersist((p) => p.upsert(ledger));
  }

  /**
   * Link more message ids (e.g. chunked delivery ids that arrive later).
   * Always forwarded to persistence, even on a memory miss, so a turn that
   * only survives on disk (post-restart) still learns its ids.
   */
  linkMessages(turnId: string, messageIds: readonly string[]): void {
    const cur = this.byTurn.get(turnId);
    if (cur) {
      const merged = [...new Set([...cur.messageIds, ...messageIds])];
      this.byTurn.set(turnId, { ...cur, messageIds: merged });
      for (const id of messageIds) this.byMessage.set(id, turnId);
    }
    this.withPersist((p) => p.link(turnId, messageIds));
  }

  /**
   * Link message ids to the agent's most recent ledger that has none yet
   * (chunked deliveries learn their ids after the fact, from the delivery
   * queue). Only within a short window so a stale ledger never adopts ids.
   * Candidates come from memory only — a restart inside the window loses
   * the adoption, which is an acceptable edge.
   */
  linkLatest(
    agent: string,
    messageIds: readonly string[],
    now: number = Date.now(),
    windowMs = LEDGER_LINK_LATEST_WINDOW_MS,
  ): boolean {
    const cand = [...this.byTurn.values()]
      .filter((l) => l.agent === agent && l.messageIds.length === 0 && now - l.deliveredAt <= windowMs)
      .sort((a, b) => b.deliveredAt - a.deliveredAt)[0];
    if (!cand) return false;
    this.linkMessages(cand.turnId, messageIds);
    return true;
  }

  get(turnId: string, now: number = Date.now()): TurnLedger | undefined {
    const l = this.byTurn.get(turnId);
    if (!l) return undefined;
    if (now - l.deliveredAt > LEDGER_MAX_AGE_MS) {
      this.drop(turnId);
      return undefined;
    }
    return l;
  }

  /**
   * Memory first; on a miss (never recorded here, or past the 2h memory TTL)
   * fall through to persistence. The persisted hit is returned as-is and NOT
   * re-cached — memory stays a bounded recent window.
   */
  byMessageId(messageId: string, now: number = Date.now()): TurnLedger | undefined {
    const turnId = this.byMessage.get(messageId);
    const fromMemory = turnId ? this.get(turnId, now) : undefined;
    if (fromMemory) return fromMemory;
    return this.withPersist((p) => p.byMessageId(messageId));
  }

  /**
   * Replace a turn's claims snapshot wholesale (post-hoc hop refresh) in
   * memory and on disk. Unknown turn → silent no-op in both.
   */
  updateClaims(turnId: string, claims: readonly ClaimEntry[]): void {
    const cur = this.byTurn.get(turnId);
    if (cur) this.byTurn.set(turnId, { ...cur, claims });
    this.withPersist((p) => p.updateClaims(turnId, claims));
  }

  /** Recent ledgers for an agent, newest first (memory only). */
  recent(agent: string, limit = 5, now: number = Date.now()): TurnLedger[] {
    this.prune(now);
    return [...this.byTurn.values()]
      .filter((l) => l.agent === agent)
      .sort((a, b) => b.deliveredAt - a.deliveredAt)
      .slice(0, limit);
  }

  /** True when a card was already posted for this message within the window. */
  markCardPosted(messageId: string, now: number = Date.now(), windowMs = 10 * 60 * 1000): boolean {
    const last = this.cardPostedFor.get(messageId);
    if (last !== undefined && now - last < windowMs) return false;
    this.cardPostedFor.set(messageId, now);
    return true;
  }

  size(): number {
    return this.byTurn.size;
  }

  private drop(turnId: string): void {
    const l = this.byTurn.get(turnId);
    if (!l) return;
    for (const id of l.messageIds) this.byMessage.delete(id);
    this.byTurn.delete(turnId);
  }

  private prune(now: number): void {
    for (const [id, l] of this.byTurn) if (now - l.deliveredAt > LEDGER_MAX_AGE_MS) this.drop(id);
    for (const [id, at] of this.cardPostedFor) if (now - at > LEDGER_MAX_AGE_MS) this.cardPostedFor.delete(id);
  }

  /** Persistence is best-effort: a throwing backing never reaches the caller. */
  private withPersist<T>(fn: (p: LedgerPersistenceLike) => T): T | undefined {
    if (!this.persist) return undefined;
    try {
      return fn(this.persist);
    } catch {
      return undefined;
    }
  }
}
