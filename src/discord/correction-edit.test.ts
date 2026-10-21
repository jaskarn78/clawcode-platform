/**
 * 999.63c — pure decision core for edit-in-place correction delivery.
 *
 * Fixture discipline: verbatim prod strings from the 2026-08-26 incident
 * (same convention as the financial-verification test family).
 */
import { describe, it, expect } from "vitest";
import {
  replaceVerificationLine,
  carryAnnotationLines,
  DeliveredMessageRefStore,
  decideCorrectionEdit,
  DELIVERED_REF_MAX_AGE_MS,
  DELIVERED_REF_MAX_ENTRIES,
  MAX_EDIT_LENGTH,
  type DeliveredMessageRef,
} from "./correction-edit.js";

/** Verbatim incident rollover claim (pre-footer draft, ≤2000 chars). */
const INCIDENT_DRAFT =
  "Once you separate from Acme Corp, we open a Acme Brokerage Rollover IRA and " +
  "transfer the 401(k) in kind. Nothing is sold, no tax event is " +
  "triggered, and the old account closes itself when the transfer " +
  "completes. Your only step is signing.";

/** Verbatim incident correction (the replacement text). */
const INCIDENT_CORRECTED =
  "You do not have to quit, retire, or wait. You are 65, and your 401(k) " +
  "unlocked at 59 and a half. Federal law lets a plan release your money " +
  "to an IRA while you are still working and still contributing.";

const FOOTER = "*— correction applied (verified rules)*";

function ref(overrides: Partial<DeliveredMessageRef> = {}): DeliveredMessageRef {
  return {
    kind: "bot",
    messageId: "m1",
    channelId: "c1",
    agentName: "fin-client",
    turnId: "discord:t1",
    deliveredText: INCIDENT_DRAFT,
    at: 1_000_000,
    ...overrides,
  };
}

describe("DeliveredMessageRefStore", () => {
  it("record + consume round-trips and is single-shot", () => {
    const store = new DeliveredMessageRefStore();
    store.record(ref());
    expect(store.consume("discord:t1", 1_000_001)).toMatchObject({
      messageId: "m1",
    });
    expect(store.consume("discord:t1", 1_000_001)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("consume removes the entry even when it returns undefined (aged out)", () => {
    const store = new DeliveredMessageRefStore();
    store.record(ref());
    const later = 1_000_000 + DELIVERED_REF_MAX_AGE_MS + 1;
    expect(store.consume("discord:t1", later)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("record prunes aged entries and enforces the size cap oldest-first", () => {
    const store = new DeliveredMessageRefStore();
    for (let i = 0; i < DELIVERED_REF_MAX_ENTRIES + 5; i++) {
      store.record(ref({ turnId: `discord:t${i}`, at: 2_000_000 + i }));
    }
    expect(store.size).toBe(DELIVERED_REF_MAX_ENTRIES);
    // The 5 oldest were evicted.
    expect(store.consume("discord:t0", 2_000_100)).toBeUndefined();
    expect(store.consume("discord:t4", 2_000_100)).toBeUndefined();
    expect(store.consume("discord:t5", 2_000_100)).toBeDefined();
  });
});

describe("decideCorrectionEdit ladder", () => {
  it("happy path → edit with formatted body + raw footer (em-dash survives)", () => {
    const d = decideCorrectionEdit({
      ref: ref(),
      originalResponse: INCIDENT_DRAFT,
      correctedText: INCIDENT_CORRECTED,
      footer: FOOTER,
    });
    expect(d.kind).toBe("edit");
    if (d.kind !== "edit") return;
    expect(d.messageId).toBe("m1");
    expect(d.channelId).toBe("c1");
    expect(d.editText.endsWith(`\n\n${FOOTER}`)).toBe(true);
    // formatOutboundText strips em-dashes from prose — the footer's `—`
    // must survive because it is appended AFTER formatting.
    expect(d.editText).toContain("—");
  });

  it("deliveredText with an appended advisor footer still matches (startsWith, not equality)", () => {
    const d = decideCorrectionEdit({
      ref: ref({
        deliveredText:
          INCIDENT_DRAFT + "\n\n*— consulted advisor (Opus) before responding*",
      }),
      originalResponse: INCIDENT_DRAFT,
      correctedText: INCIDENT_CORRECTED,
      footer: FOOTER,
    });
    expect(d.kind).toBe("edit");
  });

  it("no ref → fallback no-ref", () => {
    const d = decideCorrectionEdit({
      ref: undefined,
      originalResponse: INCIDENT_DRAFT,
      correctedText: INCIDENT_CORRECTED,
      footer: FOOTER,
    });
    expect(d).toEqual({ kind: "fallback", reason: "no-ref" });
  });

  it("webhook-kind ref → fallback kind-uneditable (future-proof)", () => {
    const d = decideCorrectionEdit({
      ref: ref({ kind: "webhook" }),
      originalResponse: INCIDENT_DRAFT,
      correctedText: INCIDENT_CORRECTED,
      footer: FOOTER,
    });
    expect(d).toEqual({ kind: "fallback", reason: "kind-uneditable" });
  });

  it("delivered text from a DIFFERENT turn → fallback text-mismatch", () => {
    const d = decideCorrectionEdit({
      ref: ref({ deliveredText: "A totally different answer about SGOV." }),
      originalResponse: INCIDENT_DRAFT,
      correctedText: INCIDENT_CORRECTED,
      footer: FOOTER,
    });
    expect(d).toEqual({ kind: "fallback", reason: "text-mismatch" });
  });

  it("corrected body over the Discord limit → fallback oversize", () => {
    const d = decideCorrectionEdit({
      ref: ref(),
      originalResponse: INCIDENT_DRAFT,
      correctedText: "x".repeat(MAX_EDIT_LENGTH + 1),
      footer: FOOTER,
    });
    expect(d).toEqual({ kind: "fallback", reason: "oversize" });
  });

  it("body exactly at the limit boundary accounts for the footer", () => {
    // Body that alone fits but with footer exceeds 2000 → oversize.
    const body = "x".repeat(MAX_EDIT_LENGTH - FOOTER.length + 1);
    const d = decideCorrectionEdit({
      ref: ref(),
      originalResponse: INCIDENT_DRAFT,
      correctedText: body,
      footer: FOOTER,
    });
    expect(d).toEqual({ kind: "fallback", reason: "oversize" });
  });
});

/**
 * 999.63d — peek + pending-marker ladder.
 */
import {
  PENDING_MARKER,
  decidePendingMarkerAppend,
} from "./correction-edit.js";

describe("DeliveredMessageRefStore.peek (999.63d)", () => {
  const ref = (turnId: string, at: number): DeliveredMessageRef => ({
    kind: "bot",
    messageId: "m1",
    channelId: "c1",
    agentName: "fin-client",
    turnId,
    deliveredText: "delivered",
    at,
  });

  it("is non-consuming: peek then consume both hit", () => {
    const store = new DeliveredMessageRefStore();
    store.record(ref("t1", 1000));
    expect(store.peek("t1", 2000)?.messageId).toBe("m1");
    expect(store.peek("t1", 2000)?.messageId).toBe("m1");
    expect(store.consume("t1", 2000)?.messageId).toBe("m1");
    expect(store.peek("t1", 2000)).toBeUndefined();
  });

  it("age-prunes on peek like consume", () => {
    const store = new DeliveredMessageRefStore();
    store.record(ref("t1", 1000));
    expect(
      store.peek("t1", 1000 + DELIVERED_REF_MAX_AGE_MS + 1),
    ).toBeUndefined();
    expect(store.size).toBe(0);
  });
});

describe("decidePendingMarkerAppend (999.63d)", () => {
  const base: DeliveredMessageRef = {
    kind: "bot",
    messageId: "m1",
    channelId: "c1",
    agentName: "fin-client",
    turnId: "t1",
    deliveredText: "The rollover unlocks at 59½ per the plan terms.",
    at: 1000,
  };

  it("appends marker to an unchanged bot message", () => {
    const d = decidePendingMarkerAppend({
      ref: base,
      liveContent: base.deliveredText,
    });
    expect(d).toEqual({
      kind: "append",
      messageId: "m1",
      channelId: "c1",
      editText: `${base.deliveredText}${PENDING_MARKER}`,
    });
  });

  it("no ref → skip no-ref", () => {
    expect(decidePendingMarkerAppend({ ref: undefined, liveContent: "x" })).toEqual({
      kind: "skip",
      reason: "no-ref",
    });
  });

  it("webhook kind → skip kind-uneditable", () => {
    const d = decidePendingMarkerAppend({
      ref: { ...base, kind: "webhook" },
      liveContent: base.deliveredText,
    });
    expect(d).toEqual({ kind: "skip", reason: "kind-uneditable" });
  });

  it("live content drifted (foreign edit) → skip content-drift", () => {
    const d = decidePendingMarkerAppend({
      ref: base,
      liveContent: `${base.deliveredText} EDITED`,
    });
    expect(d).toEqual({ kind: "skip", reason: "content-drift" });
  });

  it("content + marker over the Discord limit → skip oversize", () => {
    const big = "x".repeat(2000 - PENDING_MARKER.length + 1);
    const d = decidePendingMarkerAppend({
      ref: { ...base, deliveredText: big },
      liveContent: big,
    });
    expect(d).toEqual({ kind: "skip", reason: "oversize" });
  });

  it("marker fits exactly at the limit → append", () => {
    const exact = "x".repeat(2000 - PENDING_MARKER.length);
    const d = decidePendingMarkerAppend({
      ref: { ...base, deliveredText: exact },
      liveContent: exact,
    });
    expect(d.kind).toBe("append");
  });
});

describe("2026-08-27 sweep — annotations survive a correction; narration-stripped bodies still edit in place", () => {
  const base = { kind: "bot" as const, messageId: "m1", channelId: "c1", agentName: "fin-client", turnId: "t1", at: 1 };
  it("re-appends the Sources line after the correction footer", () => {
    const original = "The limit is $23,500.";
    const ref = { ...base, deliveredText: `${original}\n\n-# Sources: [irs.gov › limits](<https://irs.gov/l>)`, bodyText: original,
      annotations: "-# ⚠️ unverified: something\n-# Sources: [irs.gov › limits](<https://irs.gov/l>)" };
    const d = decideCorrectionEdit({ ref, originalResponse: original, correctedText: "The limit is $24,500.", footer: "*— correction applied*" });
    expect(d.kind).toBe("edit");
    const text = (d as { editText: string }).editText;
    expect(text).toBe("The limit is $24,500.\n\n*— correction applied*\n-# Sources: [irs.gov › limits](<https://irs.gov/l>)");
    expect(text).not.toContain("⚠️ unverified"); // verdict lines are not carried
  });
  it("a narration-stripped body still edits in place, and the edit does not reintroduce the narration", () => {
    const narration = "Checking the limits first.";
    const body = "The limit is $23,500.";
    const original = `${narration} ${body}`;
    const ref = { ...base, deliveredText: body, bodyText: body, annotations: "" };
    const d = decideCorrectionEdit({ ref, originalResponse: original, correctedText: `${narration} The limit is $24,500.`, footer: "*— fixed*" });
    expect(d.kind).toBe("edit");
    expect((d as { editText: string }).editText).toBe("The limit is $24,500.\n\n*— fixed*");
  });
  it("a message that carried table images falls back to the note", () => {
    // 2026-08-28 — discord.js keeps attachments on a content edit; the image
    // case is EDITED with a table re-plan instead of falling back to a note.
    const ref = { ...base, deliveredText: "x", bodyText: "x", hasImages: true, annotations: "\n\n-# Verified 1 claim · irs.gov › a · 3s" };
    const d = decideCorrectionEdit({ ref, originalResponse: "x", correctedText: "y", footer: "f" });
    expect(d.kind).toBe("edit");
    if (d.kind === "edit") {
      expect(d.replan).toEqual({ body: "y", tail: "\n\nf\n-# Corrected · irs.gov › a" });
      expect(d.editText).toBe("y\n\nf\n-# Corrected · irs.gov › a");
    }
  });
});

describe("2026-08-28 — merged verification line: replace + carry", () => {
  it("replaceVerificationLine rewrites the LAST verification line and tolerates the pending marker", () => {
    const c = "Body.\n\n-# Checked 4 steps · irs.gov › x · 9s" + PENDING_MARKER;
    const out = replaceVerificationLine(c, (l) => l.replace(/^-# Checked\b/u, "-# Re-checked"));
    expect(out).toBe("Body.\n\n-# Re-checked 4 steps · irs.gov › x · 9s" + PENDING_MARKER);
    expect(replaceVerificationLine("no line here", (l) => `${l}x`)).toBe("no line here");
  });
  it("999.151 — still matches a message delivered BEFORE the glyphs were dropped", () => {
    const legacy = "Body.\n\n-# 🔎 checked 4 steps · irs.gov › x · 9s";
    expect(replaceVerificationLine(legacy, (l) => `${l}!`)).toBe(`${legacy}!`);
    expect(carryAnnotationLines("\n\n-# 🔎 checked 2 steps · 4s")).toEqual(["-# Corrected"]);
  });
  it("carryAnnotationLines keeps Sources, re-heads the verification line, drops the exception row and the duration", () => {
    expect(carryAnnotationLines("\n\n-# 1 claim unverified · irs.gov › RMD FAQs · 36s\n-# Verified 3 claims · irs.gov › RMD FAQs · finnhub.io › 9 live quotes · 36s"))
      .toEqual(["-# Corrected · irs.gov › RMD FAQs · finnhub.io › 9 live quotes"]);
    // A humanised duration is a duration too — it must not survive the carry.
    expect(carryAnnotationLines("\n\n-# Verified 1 claim · irs.gov › a · 4m 56s"))
      .toEqual(["-# Corrected · irs.gov › a"]);
    expect(carryAnnotationLines("\n\n-# Sources: irs.gov › a")).toEqual(["-# Sources: irs.gov › a"]);
    expect(carryAnnotationLines("\n\n-# Checked 2 steps · 4s")).toEqual(["-# Corrected"]);
  });
});
