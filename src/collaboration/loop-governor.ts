/**
 * Phase 999.117 WS-3 — the A2A loop governor.
 *
 * WHY THIS EXISTS
 *
 * Before this module ClawCode had exactly one loop guard in the entire
 * agent-to-agent path: "never ack an ack". That stops an acknowledgment
 * chain and nothing else. A genuine exchange — A asks B, B answers and asks
 * a follow-up, A answers and asks a follow-up — had no hop count, no TTL, no
 * conversation identity, no per-pair budget and no kill switch. Two agents
 * each behaving correctly could ping-pong until someone noticed the token
 * bill or the turn queue jammed. That is the "endless communication loop"
 * the operator reported, and no amount of prompt wording fixes it: the
 * agents are not malfunctioning, the system simply never told them to stop.
 *
 * DESIGN — four independent bounds, defence in depth
 *
 * Every bound is deliberately redundant with the others, because each one
 * fails in a different way:
 *
 *   1. maxHops                  depth of a single conversation (TTL / max
 *                               hop count). Catches a long chain even when
 *                               each individual step looks reasonable.
 *   2. maxConsecutiveAutoReplies  how many times an ordered pair may bounce
 *                               back-to-back without a third party or a
 *                               human intervening (AutoGen's
 *                               `max_consecutive_auto_reply`). Catches a
 *                               tight two-agent oscillation early, before
 *                               the hop ceiling.
 *   3. pair rate window         messages per ordered pair per window
 *                               (RFC 3834's "at most one auto-response per
 *                               sender per period", generalised). Catches a
 *                               fast storm that resets conversation ids.
 *   4. conversationCap          unconditional ceiling on total messages in
 *                               one conversation, independent of hops
 *                               (LangGraph's `recursion_limit`). The last
 *                               kill switch — it does not care WHY.
 *
 * Bound 4 is the one that must never be removed. Bounds 1–3 all reason about
 * structure, and structure can be gamed by an agent that mints a fresh
 * conversation id or alternates targets. Bound 4 just counts.
 *
 * A tripped bound opens a CIRCUIT BREAKER on the ordered pair for a
 * cooldown, so a wedged pair stops re-tripping every message and the
 * operator gets one alert instead of hundreds.
 *
 * MODES
 *
 *   "enforce"  (default) verdicts are acted on — traffic is suppressed.
 *   "shadow"   verdicts are computed and reported but ALWAYS allowed. Use to
 *              measure real traffic before tightening. Kept as the documented
 *              rollback for an over-tight threshold.
 *   "off"      no evaluation at all.
 *
 * PURITY / STATE
 *
 * The governor owns bounded in-memory counters keyed by conversation and by
 * ordered pair. It is NOT persisted: a daemon restart resets the counters,
 * which is the right failure mode (a restart is exactly when you want
 * blocked traffic to get one more chance). All maps are FIFO-capped so a
 * long-lived daemon cannot leak. The clock is injected so tests do not
 * sleep.
 */

import type { InboxMessageKind } from "./types.js";

/** Which bound rejected a message. */
export type LoopRule =
  | "max-hops"
  | "consecutive-auto-replies"
  | "pair-rate"
  | "conversation-cap"
  | "breaker-open";

/** The governor's answer for one prospective message. */
export type LoopVerdict = Readonly<{
  /** Whether the message may be delivered. Always true in shadow/off mode. */
  allow: boolean;
  /**
   * Whether a bound actually tripped. In shadow mode this is true while
   * `allow` stays true — that gap is the whole point of shadow mode.
   */
  tripped: boolean;
  /** Which bound tripped. Undefined when nothing tripped. */
  rule?: LoopRule;
  /** Operator-facing explanation, safe to surface in Discord. */
  detail?: string;
  /** Resolved conversation id this verdict was computed against. */
  conversationId: string;
  /** Hop number this message would occupy. */
  hops: number;
}>;

export type LoopGovernorConfig = Readonly<{
  mode: "enforce" | "shadow" | "off";
  /** Max hops in one conversation. Default 6. */
  maxHops: number;
  /** Max back-to-back messages on one ordered pair. Default 3. */
  maxConsecutiveAutoReplies: number;
  /** Rate window length in ms. Default 300_000 (5 min). */
  pairWindowMs: number;
  /** Max messages per ordered pair per window. Default 5. */
  pairWindowMax: number;
  /** Unconditional per-conversation message ceiling. Default 12. */
  conversationCap: number;
  /** How long a tripped pair stays suppressed, ms. Default 900_000 (15 min). */
  breakerCooldownMs: number;
  /**
   * Silence after which a pair's next message starts a NEW conversation.
   * Default 600_000 (10 min).
   *
   * This is what makes the derived conversation key usable: two agents that
   * exchange a few messages, go quiet, then talk again about something else
   * are having two conversations, not one long one that slowly exhausts
   * `conversationCap`. Too short and a slow deliberate exchange resets its
   * own depth counter; too long and unrelated traffic shares a budget.
   */
  conversationIdleMs: number;
}>;

/**
 * Researched defaults. Sources are recorded in the phase plan §4; the short
 * version is that every multi-agent framework that solved this converged on
 * "a small depth limit plus an unconditional ceiling", and the numbers below
 * are the conservative end of that range.
 */
export const DEFAULT_LOOP_GOVERNOR_CONFIG: LoopGovernorConfig = {
  mode: "enforce",
  maxHops: 6,
  maxConsecutiveAutoReplies: 3,
  pairWindowMs: 300_000,
  pairWindowMax: 5,
  conversationCap: 12,
  breakerCooldownMs: 900_000,
  conversationIdleMs: 600_000,
};

/** Input for one evaluation. */
export type LoopGovernorInput = Readonly<{
  from: string;
  to: string;
  kind: InboxMessageKind;
  /** RFC 3834 — machine-generated traffic. */
  autoSubmitted: boolean;
  /**
   * Explicit thread id, when the caller genuinely has one.
   *
   * ABSENT IS THE NORMAL CASE. The `post_to_agent` / `ask_agent` tool schemas
   * expose only {from, to, message}, and the recipient sees the message as
   * plain `[Message from X]: …` text — it never sees a conversation id, so it
   * cannot echo one back. The envelope therefore has no return path through
   * the LLM, and anything keyed on a caller-supplied id would be dead code in
   * production: every message would look like hop 1 of a brand-new
   * conversation, leaving only the per-pair rate limit alive.
   *
   * So when this is absent the governor derives the conversation ITSELF from
   * the unordered pair plus a recency window (see `resolveConversation`).
   * That needs zero cooperation from either agent, which is the only way a
   * bound of this kind can be trusted.
   */
  conversationId?: string;
  /** Explicit hop number. Absent → derived from the conversation bucket. */
  hops?: number;
}>;

export type LoopGovernorDeps = Readonly<{
  config: LoopGovernorConfig;
  /** Injected clock. Production passes `() => Date.now()`. */
  now: () => number;
  /**
   * Fired ONCE when a pair's breaker opens, never on subsequent suppressed
   * messages. Wire to the fleet-alert surface so the operator learns about a
   * wedged pair without being buried by it.
   */
  onBreakerOpen?: (event: BreakerOpenEvent) => void;
}>;

export type BreakerOpenEvent = Readonly<{
  from: string;
  to: string;
  conversationId: string;
  rule: LoopRule;
  detail: string;
  openedAt: number;
  reopensAt: number;
}>;

/** Bound on how many conversations / pairs we track. FIFO-evicted. */
const TRACKING_CAP = 2048;

/**
 * Composite-key separator. NUL, not a space or a dash: agent names are
 * operator-chosen and DO contain spaces in production ("Admin Clawdy"), so a
 * printable separator makes keys ambiguous - pairKey("a", "b c") and
 * pairKey("a b", "c") would collide and silently share a budget. NUL cannot
 * appear in a name.
 */
const KEY_SEP = "\u0000";

type ConversationState = { count: number; maxHops: number };
type PairState = { consecutive: number; window: number[]; breakerUntil: number };
/** Derived-conversation bucket for an unordered pair. */
type PairConversation = { id: string; lastAt: number };

/** FIFO-evict the oldest key once a map exceeds the cap. */
function capMap(map: Map<string, unknown>): void {
  if (map.size <= TRACKING_CAP) return;
  const oldest = map.keys().next().value;
  if (oldest !== undefined) map.delete(oldest);
}

/** Ordered-pair key. Direction matters: A→B and B→A are separate budgets. */
function pairKey(from: string, to: string): string {
  return `${from}${KEY_SEP}${to}`;
}

/**
 * UNordered-pair key - direction-independent, so A->B and B->A share one
 * conversation bucket.
 *
 * A conversation spans both directions by definition, so the derived bucket
 * must not care who is currently speaking. The rate window and the breaker DO
 * care, and keep using the ordered `pairKey` above.
 */
function conversationPairKey(a: string, b: string): string {
  return [a, b].sort().join(KEY_SEP);
}

export class LoopGovernor {
  private readonly config: LoopGovernorConfig;
  private readonly now: () => number;
  private readonly onBreakerOpen: LoopGovernorDeps["onBreakerOpen"];

  private readonly conversations = new Map<string, ConversationState>();
  private readonly pairs = new Map<string, PairState>();
  /** Last sender seen on a conversation — drives the consecutive counter. */
  private readonly lastSender = new Map<string, string>();
  /**
   * Derived-conversation buckets, keyed by UNORDERED pair. This is what makes
   * the depth bounds real: production callers supply no conversation id, so
   * without this every message would be hop 1 of a brand-new conversation and
   * three of the four bounds would be dead code.
   */
  private readonly pairConversations = new Map<string, PairConversation>();

  constructor(deps: LoopGovernorDeps) {
    this.config = deps.config;
    this.now = deps.now;
    this.onBreakerOpen = deps.onBreakerOpen;
  }

  /**
   * Evaluate one prospective message, recording it against the budgets.
   *
   * Call EXACTLY ONCE per message, at the single point where delivery is
   * decided. Calling it twice double-counts and will trip early; not calling
   * it means the message is unbounded. In `enforce` mode a false `allow`
   * means the caller must not deliver.
   */
  evaluate(input: LoopGovernorInput): LoopVerdict {
    if (this.config.mode === "off") {
      return {
        allow: true,
        tripped: false,
        conversationId: input.conversationId ?? "",
        hops: input.hops ?? 1,
      };
    }

    const verdict = this.check(input);
    // Shadow mode measures without acting: report the trip, allow the
    // traffic. This is how a threshold gets tuned against real load instead
    // of against a guess.
    if (this.config.mode === "shadow" && !verdict.allow) {
      return { ...verdict, allow: true };
    }
    return verdict;
  }

  /** Current breaker state for a pair — for the operator panel. */
  isBreakerOpen(from: string, to: string): boolean {
    const pair = this.pairs.get(pairKey(from, to));
    return pair !== undefined && pair.breakerUntil > this.now();
  }

  /** Operator escape hatch: clear a pair's breaker and counters. */
  reset(from: string, to: string): void {
    this.pairs.delete(pairKey(from, to));
  }

  /** Test/diagnostic: number of tracked conversations. */
  trackedConversations(): number {
    return this.conversations.size;
  }

  /**
   * Phase 999.117 WS-6 — the thresholds actually in force.
   *
   * Reports the governor's OWN resolved config rather than re-reading YAML,
   * so a knob that silently failed to apply shows up as a discrepancy the
   * operator can see. Several config knobs in this codebase were documented
   * as hot-reloadable and were not; "what is the daemon really running with"
   * should never require inference.
   */
  describeConfig(): LoopGovernorConfig {
    return { ...this.config };
  }

  /**
   * Phase 999.117 WS-6 — currently-suppressed pairs, for the operator panel.
   * Expired breakers are filtered out rather than reported as open.
   */
  listOpenBreakers(): readonly {
    from: string;
    to: string;
    reopensAt: number;
  }[] {
    const now = this.now();
    const open: { from: string; to: string; reopensAt: number }[] = [];
    for (const [key, pair] of this.pairs) {
      if (pair.breakerUntil <= now) continue;
      const [from, to] = key.split(KEY_SEP);
      open.push({ from: from ?? key, to: to ?? "", reopensAt: pair.breakerUntil });
    }
    return open;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Resolve which conversation this message belongs to, and how deep it is.
   *
   * An explicit id from the caller always wins. Otherwise the conversation is
   * DERIVED from the unordered pair plus a recency window: while A and B keep
   * talking within `conversationIdleMs` of each other they stay in one
   * bucket, and the hop number is simply how many messages that bucket has
   * already seen. After a silence the next message opens a new bucket.
   *
   * This exists because the envelope has no return path. `post_to_agent` and
   * `ask_agent` accept only {from, to, message}, and the recipient sees the
   * message as plain `[Message from X]: …` text — it never sees a
   * conversation id, so it cannot thread one back. Anything keyed on a
   * caller-supplied id is therefore always hop 1 of a fresh conversation in
   * production, which silently disables `maxHops`, `conversationCap` AND
   * `maxConsecutiveAutoReplies` and leaves only the per-pair rate window
   * alive. Deriving server-side needs zero cooperation from either agent.
   */
  private resolveConversation(
    input: LoopGovernorInput,
    now: number,
  ): { conversationId: string; hops: number } {
    if (input.conversationId !== undefined) {
      const known = this.conversations.get(input.conversationId);
      return {
        conversationId: input.conversationId,
        hops: input.hops ?? (known ? known.count + 1 : 1),
      };
    }

    const key = conversationPairKey(input.from, input.to);
    const bucket = this.pairConversations.get(key);
    const live =
      bucket !== undefined && now - bucket.lastAt <= this.config.conversationIdleMs;
    const conversationId = live ? bucket.id : `${key}${KEY_SEP}${now}`;
    const known = this.conversations.get(conversationId);
    return {
      conversationId,
      hops: input.hops ?? (known ? known.count + 1 : 1),
    };
  }

  private check(input: LoopGovernorInput): LoopVerdict {
    const { from, to } = input;
    const now = this.now();
    const { conversationId, hops } = this.resolveConversation(input, now);
    const key = pairKey(from, to);
    const pair = this.pairs.get(key) ?? {
      consecutive: 0,
      window: [],
      breakerUntil: 0,
    };

    // A pair whose breaker is open is suppressed without further evaluation
    // and WITHOUT re-alerting — one alert per wedge, not one per message.
    if (pair.breakerUntil > now) {
      return {
        allow: false,
        tripped: true,
        rule: "breaker-open",
        detail:
          `${from} → ${to} is paused until ` +
          `${new Date(pair.breakerUntil).toISOString()} after a loop guard tripped.`,
        conversationId,
        hops,
      };
    }

    const convo = this.conversations.get(conversationId) ?? {
      count: 0,
      maxHops: 0,
    };

    // Prune the rate window before counting.
    const windowStart = now - this.config.pairWindowMs;
    const window = pair.window.filter((t) => t > windowStart);

    // Consecutive run: the same sender messaging the same target again with
    // nobody else intervening on this conversation.
    const consecutive =
      this.lastSender.get(conversationId) === from ? pair.consecutive + 1 : 1;

    const tripped = this.firstBreach({
      hops,
      convoCount: convo.count + 1,
      consecutive,
      windowCount: window.length + 1,
      autoSubmitted: input.autoSubmitted,
      from,
      to,
    });

    // Commit the counters regardless of the verdict: a suppressed attempt
    // still happened, and letting it go uncounted would let a blocked pair
    // reset its own budget by retrying.
    this.conversations.set(conversationId, {
      count: convo.count + 1,
      maxHops: Math.max(convo.maxHops, hops),
    });
    capMap(this.conversations);
    this.lastSender.set(conversationId, from);
    capMap(this.lastSender);
    // Refresh the derived-conversation bucket so the NEXT message on this
    // pair joins the same conversation rather than opening a new one.
    this.pairConversations.set(conversationPairKey(from, to), {
      id: conversationId,
      lastAt: now,
    });
    capMap(this.pairConversations);

    const nextPair: PairState = {
      consecutive,
      window: [...window, now],
      breakerUntil: tripped ? now + this.config.breakerCooldownMs : 0,
    };
    this.pairs.set(key, nextPair);
    capMap(this.pairs);

    if (!tripped) {
      return { allow: true, tripped: false, conversationId, hops };
    }

    // Alert once, on the transition into the open state.
    this.onBreakerOpen?.({
      from,
      to,
      conversationId,
      rule: tripped.rule,
      detail: tripped.detail,
      openedAt: now,
      reopensAt: nextPair.breakerUntil,
    });

    return {
      allow: false,
      tripped: true,
      rule: tripped.rule,
      detail: tripped.detail,
      conversationId,
      hops,
    };
  }

  /**
   * First bound to breach, in escalating order of how specific the signal is.
   * Order matters only for which rule gets reported; any breach suppresses.
   */
  private firstBreach(ctx: {
    hops: number;
    convoCount: number;
    consecutive: number;
    windowCount: number;
    autoSubmitted: boolean;
    from: string;
    to: string;
  }): { rule: LoopRule; detail: string } | undefined {
    const c = this.config;
    const pairLabel = `${ctx.from} → ${ctx.to}`;

    if (ctx.consecutive > c.maxConsecutiveAutoReplies) {
      return {
        rule: "consecutive-auto-replies",
        detail:
          `${pairLabel} exchanged ${ctx.consecutive} messages back-to-back ` +
          `with no other participant (limit ${c.maxConsecutiveAutoReplies}).`,
      };
    }
    if (ctx.hops > c.maxHops) {
      return {
        rule: "max-hops",
        detail:
          `Conversation reached hop ${ctx.hops} (limit ${c.maxHops}). ` +
          `Continue it with a fresh request rather than another reply.`,
      };
    }
    // RFC 3834's rule is that auto-submitted mail must not TRIGGER a
    // response - not that it consumes the responder's budget. Every genuine
    // message here generates a reverse-direction ack, so charging acks
    // against the rate window would let a brisk but perfectly legitimate
    // exchange trip on its own receipts. An ack also cannot loop: it is
    // gated from ever becoming a turn. Exempt it.
    if (!ctx.autoSubmitted && ctx.windowCount > c.pairWindowMax) {
      return {
        rule: "pair-rate",
        detail:
          `${pairLabel} sent ${ctx.windowCount} messages in ` +
          `${Math.round(c.pairWindowMs / 60_000)} minutes (limit ${c.pairWindowMax}).`,
      };
    }
    if (ctx.convoCount > c.conversationCap) {
      return {
        rule: "conversation-cap",
        detail:
          `Conversation reached ${ctx.convoCount} total messages ` +
          `(hard cap ${c.conversationCap}).`,
      };
    }
    return undefined;
  }
}
