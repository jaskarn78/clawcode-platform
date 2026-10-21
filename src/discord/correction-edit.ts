/**
 * 999.63c — pure decision core for edit-in-place correction delivery.
 *
 * Operator request (2026-08-26): when the financial-verification gate
 * produces a correction, EDIT the originally delivered Discord message in
 * place (corrected text + a `*— correction applied …*` footer) instead of
 * posting a separate `🔎 Correction` follow-up. The follow-up post remains
 * the fallback for every case where an in-place edit is impossible or
 * unsafe.
 *
 * House shape: pure core + side-effect shell. Everything here is
 * synchronous, deterministic, and discord.js-free so the decision ladder
 * is unit-testable; `DiscordBridge.applyFinancialCorrection` is the thin
 * adapter that fetches/edits/falls back.
 */

import { DRAFT_ONLY_BODY, extractDrafts } from "./draft-extract.js";
import { formatOutboundText } from "./markdown-table-wrap.js";

/**
 * Record of a delivered agent response that is still edit-addressable.
 *
 * Only the v2 final-delivery exit that ends in `messageRef.current.edit(...)`
 * (bot identity, response ≤ 2000 chars) can produce one of these today.
 * The >2000 path re-delivers through the webhook queue and the ids are
 * not retained (`kind: "webhook"` exists so a future webhook-editable leg
 * is an additive change, not a schema migration).
 */
export interface DeliveredMessageRef {
  readonly kind: "bot" | "webhook";
  readonly messageId: string;
  readonly channelId: string;
  readonly agentName: string;
  /** Turn id — `discord:<trigger-snowflake>`, matches Turn.id. */
  readonly turnId: string;
  /** The exact text delivered (post-footer), for the identity guard. */
  readonly deliveredText: string;
  /**
   * 2026-08-27 sweep — the body the correction ops were computed against:
   * post-narration-strip, PRE-annotation, unformatted. `deliveredText` is the
   * formatted, annotated final and can no longer be compared with the
   * dispatcher's raw response (narration strip + table planning changed it),
   * which made every in-place correction fall back to the note.
   */
  readonly bodyText?: string;
  /** The `-#` annotation block appended at delivery (Sources line etc.). */
  readonly annotations?: string;
  /** Table images were attached — an edit would duplicate them as cards. */
  readonly hasImages?: boolean;
  /** ms-epoch at delivery, for age pruning. */
  readonly at: number;
}

/** Refs older than this are prune-on-read (same policy as inFlightTriggers). */
export const DELIVERED_REF_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** Defensive cap — oldest entries evicted first. */
export const DELIVERED_REF_MAX_ENTRIES = 200;

/** Discord hard limit for a single message body. */
export const MAX_EDIT_LENGTH = 2000;

/**
 * C (2026-08-26) — placeholder shown instead of draft streaming for
 * `verification.holdDelivery` agents: nothing unverified ever
 * renders in the channel; the placeholder message becomes the editable
 * surface the verified final text lands on (≤2000-char deliveries).
 */
export const HOLD_PLACEHOLDER = "💠 *working…*";

/**
 * Bounded, age-pruned store of delivered-message refs keyed by turn id.
 * Single-shot: `consume` removes the entry whether or not the caller's
 * edit ultimately succeeds (a second correction for the same turn is not
 * a thing — MAX_VERIFY_HOPS bounds the hop, and a failed edit falls back
 * to a post which must not retry the edit later against stale text).
 */
export class DeliveredMessageRefStore {
  private readonly refs = new Map<string, DeliveredMessageRef>();

  record(ref: DeliveredMessageRef): void {
    this.prune(ref.at);
    this.refs.set(ref.turnId, ref);
    if (this.refs.size > DELIVERED_REF_MAX_ENTRIES) {
      // Map preserves insertion order — evict oldest first.
      const oldest = this.refs.keys().next().value;
      if (oldest !== undefined) this.refs.delete(oldest);
    }
  }

  /** Single-shot lookup: returns the ref (if fresh) and always removes it. */
  consume(turnId: string, now: number): DeliveredMessageRef | undefined {
    const ref = this.refs.get(turnId);
    this.refs.delete(turnId);
    if (!ref) return undefined;
    if (now - ref.at > DELIVERED_REF_MAX_AGE_MS) return undefined;
    return ref;
  }

  /**
   * 999.63d — NON-consuming lookup (same freshness semantics as
   * `consume`, entry left in place). Used by the pending-marker append
   * and the ✅ verified-badge, which must not race the correction-edit
   * path out of its single-shot `consume`.
   */
  peek(turnId: string, now: number): DeliveredMessageRef | undefined {
    const ref = this.refs.get(turnId);
    if (!ref) return undefined;
    if (now - ref.at > DELIVERED_REF_MAX_AGE_MS) {
      this.refs.delete(turnId);
      return undefined;
    }
    return ref;
  }

  get size(): number {
    return this.refs.size;
  }

  private prune(now: number): void {
    const cutoff = now - DELIVERED_REF_MAX_AGE_MS;
    for (const [key, ref] of this.refs) {
      if (ref.at < cutoff) this.refs.delete(key);
    }
  }
}

/**
 * 999.63d — pending-verification marker appended to a flagged delivered
 * message while the corrective hop runs behind it ("verify-behind").
 * `-#` is Discord's small-subtext markdown. Stripped by
 * `removeFinancialPendingMarker` on every hop outcome (stateless
 * endsWith-strip, idempotent).
 */
export const PENDING_MARKER = "\n\n-# Verifying…";

export type PendingMarkerDecision =
  | {
      readonly kind: "append";
      readonly messageId: string;
      readonly channelId: string;
      readonly editText: string;
    }
  | {
      readonly kind: "skip";
      readonly reason:
        | "no-ref"
        | "kind-uneditable"
        | "content-drift"
        | "oversize";
    };

/**
 * 999.63d — pure ladder for the pending-marker append. Every rung that
 * cannot PROVE the append is safe skips (the hop still runs; only the
 * cosmetic marker is lost):
 *   1. no ref (chunked delivery, instant path, aged out) → no-ref
 *   2. non-bot identity → kind-uneditable
 *   3. live message content no longer EQUALS the recorded deliveredText
 *      (a foreign edit landed since delivery) → content-drift
 *   4. content + marker would exceed the Discord limit → oversize
 */
export function decidePendingMarkerAppend(args: {
  readonly ref: DeliveredMessageRef | undefined;
  /** The live Discord message content at append time. */
  readonly liveContent: string;
}): PendingMarkerDecision {
  const { ref, liveContent } = args;
  if (!ref) return { kind: "skip", reason: "no-ref" };
  if (ref.kind !== "bot") return { kind: "skip", reason: "kind-uneditable" };
  if (liveContent !== ref.deliveredText) {
    return { kind: "skip", reason: "content-drift" };
  }
  const editText = `${ref.deliveredText}${PENDING_MARKER}`;
  if (editText.length > MAX_EDIT_LENGTH) {
    return { kind: "skip", reason: "oversize" };
  }
  return {
    kind: "append",
    messageId: ref.messageId,
    channelId: ref.channelId,
    editText,
  };
}

export type CorrectionEditDecision =
  | {
      readonly kind: "edit";
      readonly messageId: string;
      readonly channelId: string;
      /** Fully composed body to write: formatted corrected text + footer. */
      readonly editText: string;
      /**
       * 2026-08-28 — the delivered message carried table PNG cards. The
       * caller re-plans tables on `body` (new cards replace the old ones via
       * `attachments: []`) and appends `tail` (footer + carried annotations).
       */
      readonly replan?: { readonly body: string; readonly tail: string };
    }
  | {
      readonly kind: "fallback";
      readonly reason:
        | "no-ref"
        | "kind-uneditable"
        | "text-mismatch"
        | "oversize";
    };

/**
 * The merged verification footer line (`-# Verified 3 claims · …`).
 *
 * 999.151 dropped the leading glyphs from the footer, so the match is now
 * word-led; the old glyphs stay in the alternation because a correction can
 * land on a message delivered BEFORE that change. Exception heads (`⚠️`,
 * `Cited, not opened`, `N claims unverified`) are deliberately NOT here —
 * `carryAnnotationLines` drops them, since a corrected answer no longer has
 * the exception the line described.
 */
export const VERIFICATION_LINE_RE = /^-# (?:Verified|Re-checked|Checked|✓|🔎|✅) /u;

/** Footer heads that describe a problem the correction has just resolved. */
const EXCEPTION_LINE_RE =
  /^-# (?:⚠️|Cited, not opened|Still verifying|\d+ (?:of \d+ )?claims? (?:unverified|without))/u;

/** `36s`, `4m`, `4m 56s`, `1h 4m` — a duration segment, dropped on carry. */
const DURATION_SEGMENT_RE = /^\d+(?:h|m|s)(?:\s\d+(?:m|s))?$/;

/**
 * 2026-08-28 — rewrite the LAST verification line in a message via `fn`,
 * tolerating a trailing PENDING_MARKER. Pure; unchanged content when no line.
 */
export function replaceVerificationLine(content: string, fn: (line: string) => string): string {
  const pending = content.endsWith(PENDING_MARKER);
  const base = pending ? content.slice(0, -PENDING_MARKER.length) : content;
  const lines = base.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (VERIFICATION_LINE_RE.test(lines[i]!)) {
      const next = fn(lines[i]!);
      if (next === lines[i]) return content;
      lines[i] = next;
      return lines.join("\n") + (pending ? PENDING_MARKER : "");
    }
  }
  return content;
}

/**
 * Annotation lines an in-place correction keeps: the Sources line as is; the
 * merged verification line re-headed `✏️ corrected · <sources>` (counts and
 * seconds dropped — the correction supersedes them); ⚠️ lines dropped.
 */
export function carryAnnotationLines(annotations: string): string[] {
  const out: string[] = [];
  for (const raw of annotations.split("\n")) {
    const l = raw.trim();
    if (!l.startsWith("-# ")) continue;
    if (EXCEPTION_LINE_RE.test(l)) continue;
    if (l.startsWith("-# Sources:")) { out.push(l); continue; }
    if (VERIFICATION_LINE_RE.test(l)) {
      const segs = l
        .replace(VERIFICATION_LINE_RE, "")
        .split(" · ")
        .filter((seg) => !DURATION_SEGMENT_RE.test(seg.trim()));
      const rest = segs.slice(1).join(" · ").trim();
      out.push(rest.length > 0 ? `-# Corrected · ${rest}` : "-# Corrected");
    }
  }
  return out;
}

/**
 * The decision ladder. Every rung that cannot PROVE the edit is safe
 * falls back to the follow-up post (today's behaviour):
 *
 * 1. no ref recorded for the turn (>2000-char delivery, instant path,
 *    voice, restart in between, aged out) → `no-ref`
 * 2. ref not bot-identity (future webhook leg) → `kind-uneditable`
 * 3. delivered text does not start with the gate's pre-footer draft
 *    (belt-and-braces against editing the wrong message; footers are
 *    appended AFTER the gate snapshots the draft, hence startsWith, not
 *    equality) → `text-mismatch`
 * 4. composed corrected body exceeds the Discord limit → `oversize`
 */
export function decideCorrectionEdit(args: {
  readonly ref: DeliveredMessageRef | undefined;
  /** The gate's pre-footer draft snapshot (runner args.response). */
  readonly originalResponse: string;
  /** Corrective reply, WITHOUT the 🔎 prefix. */
  readonly correctedText: string;
  /** Italic footer line, e.g. `*— correction applied (verified rules)*`. */
  readonly footer: string;
}): CorrectionEditDecision {
  const { ref, originalResponse, footer } = args;
  let correctedText = args.correctedText;
  if (!ref) return { kind: "fallback", reason: "no-ref" };
  if (ref.kind !== "bot") return { kind: "fallback", reason: "kind-uneditable" };
  // A message that carried table images cannot be edited in place: the edit
  // would render the corrected table as text cards under the still-attached
  // image. The compact note fallback is the honest path.
  const original = originalResponse.trim();
  if (ref.bodyText !== undefined) {
    // 2026-08-27 sweep — the delivered body may be the original with a
    // narration prefix removed (bridge `divertedNarrationToStrip`). Require
    // that relationship exactly, then remove the SAME prefix from the
    // corrected text so the edit does not reintroduce the narration.
    if (!original.endsWith(ref.bodyText)) return { kind: "fallback", reason: "text-mismatch" };
    const prefix = original.slice(0, original.length - ref.bodyText.length);
    const corrected = correctedText.trim();
    if (prefix.length > 0) {
      if (!corrected.startsWith(prefix)) return { kind: "fallback", reason: "text-mismatch" };
      correctedText = corrected.slice(prefix.length).replace(/^\s+/, "");
    }
  } else if (
    !ref.deliveredText.startsWith(original) &&
    !ref.deliveredText.startsWith(formatOutboundText(original))
  ) {
    return { kind: "fallback", reason: "text-mismatch" };
  }
  // Format the BODY only, then append the footer raw: formatOutboundText
  // strips em-dashes from prose, and the footer's `—` must survive (same
  // reason the advisor footer is appended after the streamed content is
  // already formatted).
  // 2026-08-27 sweep — carry the delivery's Sources line across the edit; a
  // corrected claim is the one the reader most needs to see sourced. Verdict
  // lines are deliberately NOT carried: the correction changed what they said.
  const carried = carryAnnotationLines(ref.annotations ?? "");
  const body = correctedText.trim();
  const tail = `\n\n${footer}` + (carried.length > 0 ? `\n${carried.join("\n")}` : "");
  const editText = formatOutboundText(body) + tail;
  if (editText.length > MAX_EDIT_LENGTH) {
    return { kind: "fallback", reason: "oversize" };
  }
  return {
    kind: "edit",
    messageId: ref.messageId,
    channelId: ref.channelId,
    editText,
    // discord.js keeps attachments when `attachments` is omitted, so the only
    // reason to special-case image messages is that the patched RAW text still
    // holds the markdown table the delivery turned into a PNG — re-plan it.
    ...(ref.hasImages ? { replan: { body, tail } } : {}),
  };
}

export interface CorrectionSplit {
  readonly body: { readonly original: string; readonly corrected: string };
  readonly drafts: ReadonlyArray<{ readonly original: string; readonly corrected: string }>;
}

/**
 * 2026-08-28 — a reply that carried a ```draft fence was delivered as TWO
 * messages (analysis body + the plain draft), but the corrective hop patches
 * the model's full text. Split both texts the way the bridge did at delivery
 * so the body can be matched against the delivered ref and each draft against
 * its own message. `null` when the reply had no drafts or the correction
 * changed the fence structure (then the legacy whole-text path runs).
 */
export function splitCorrectionForDrafts(originalResponse: string, correctedText: string): CorrectionSplit | null {
  const o = extractDrafts(originalResponse);
  if (o.drafts.length === 0) return null;
  const c = extractDrafts(correctedText);
  if (c.drafts.length !== o.drafts.length) return null;
  const bodyOf = (t: string): string => (t.trim().length > 0 ? t : DRAFT_ONLY_BODY);
  return {
    body: { original: bodyOf(o.text), corrected: bodyOf(c.text) },
    drafts: o.drafts.map((d, i) => ({ original: d, corrected: c.drafts[i]! })),
  };
}
