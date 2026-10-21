import { describe, it, expect, vi } from "vitest";
import {
  retryWithBackoff,
  formatScheduledDeadLetter,
  SCHEDULED_DELIVERY_ATTEMPTS,
  DEAD_LETTER_PREVIEW_CHARS,
} from "../scheduled-delivery.js";

const noSleep = (): Promise<void> => Promise.resolve();

describe("retryWithBackoff", () => {
  it("returns ok on the first success without retrying", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const r = await retryWithBackoff(send, { sleep: noSleep });
    expect(r).toEqual({ ok: true, attempts: 1 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure then succeeds", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("503"))
      .mockResolvedValueOnce(undefined);
    const errors: Array<[number, string]> = [];
    const r = await retryWithBackoff(send, {
      sleep: noSleep,
      onAttemptError: (a, e) => errors.push([a, e]),
    });
    expect(r).toEqual({ ok: true, attempts: 2 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(errors).toEqual([[1, "503"]]);
  });

  it("gives up after the attempt cap and reports the last error", async () => {
    const send = vi.fn().mockRejectedValue(new Error("BASE_TYPE_MAX_LENGTH"));
    const r = await retryWithBackoff(send, { sleep: noSleep });
    expect(r).toEqual({
      ok: false,
      error: "BASE_TYPE_MAX_LENGTH",
      attempts: SCHEDULED_DELIVERY_ATTEMPTS,
    });
    expect(send).toHaveBeenCalledTimes(SCHEDULED_DELIVERY_ATTEMPTS);
  });

  it("waits with exponential backoff between attempts", async () => {
    const send = vi.fn().mockRejectedValue(new Error("x"));
    const waits: number[] = [];
    await retryWithBackoff(send, {
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      baseBackoffMs: 500,
    });
    // Sleeps happen only BETWEEN attempts (not after the last).
    expect(waits).toEqual([500, 1000]);
  });

  it("never throws even when send rejects with a non-Error", async () => {
    const send = vi.fn().mockRejectedValue("plain string boom");
    const r = await retryWithBackoff(send, { attempts: 1, sleep: noSleep });
    expect(r).toEqual({ ok: false, error: "plain string boom", attempts: 1 });
  });
});

describe("formatScheduledDeadLetter", () => {
  it("names the agent, schedule, position, error and a preview", () => {
    const msg = formatScheduledDeadLetter({
      agent: "fin-client",
      label: "recurring:HOTfwrr2",
      error: "Discord 503",
      preview: "Morning book scan: 2 birthdays this week, 1 new account.",
      postIndex: 0,
      postCount: 2,
      attempts: 3,
    });
    expect(msg).toContain("agent: fin-client");
    expect(msg).toContain("schedule: recurring:HOTfwrr2");
    expect(msg).toContain("failed on message 1 of 2");
    expect(msg).toContain("error: Discord 503");
    expect(msg).toContain("Morning book scan");
    // No Unicode emoji glyph leaks from this path (icon rule).
    expect(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(msg)).toBe(false);
  });

  it("collapses whitespace and truncates the preview with an ellipsis", () => {
    const long = "A".repeat(DEAD_LETTER_PREVIEW_CHARS + 50);
    const msg = formatScheduledDeadLetter({
      agent: "a",
      label: "scheduler",
      error: "e",
      preview: `line one\n\nline two   ${long}`,
      postIndex: 1,
      postCount: 3,
      attempts: 3,
    });
    expect(msg).toContain("preview: line one line two");
    expect(msg).toContain("…");
    // The preview segment is bounded.
    const previewLine = msg.split("\n").find((l) => l.startsWith("- preview:"))!;
    expect(previewLine.length).toBeLessThanOrEqual("- preview: ".length + DEAD_LETTER_PREVIEW_CHARS + 1);
  });
});

import { deliverScheduledOutput } from "../scheduled-delivery.js";

describe("deliverScheduledOutput", () => {
  const mocks = () => ({
    sendWebhook: vi.fn().mockResolvedValue(undefined),
    sendBotDirect: vi.fn().mockResolvedValue(undefined),
    deadLetter: vi.fn().mockResolvedValue(undefined),
  });

  it("chunks bot-direct output over 2000 chars into several ≤2000 sends (no truncation)", async () => {
    const m = mocks();
    // 3 paragraphs of ~1500 chars each → must span multiple messages.
    const para = (n: number) => `Para ${n}. ` + "word ".repeat(300).trim();
    const response = [para(1), para(2), para(3)].join("\n\n");
    const res = await deliverScheduledOutput(response, "fin-client", "scheduler", {
      hasWebhook: false,
      ...m,
      sleep: noSleep,
    });
    expect(res.deadLettered).toBe(false);
    expect(m.sendBotDirect.mock.calls.length).toBeGreaterThan(1);
    for (const call of m.sendBotDirect.mock.calls) {
      expect(String(call[0]).length).toBeLessThanOrEqual(2000);
    }
    // Every paragraph survives across the chunks (nothing dropped).
    const joined = m.sendBotDirect.mock.calls.map((c) => String(c[0])).join("\n");
    for (let n = 1; n <= 3; n++) expect(joined).toContain(`Para ${n}.`);
    expect(m.deadLetter).not.toHaveBeenCalled();
  });

  it("posts a ```draft block as its own plain message, separate from the analysis", async () => {
    const m = mocks();
    const response = "The account reconciled fine.\n\n```draft\nHi Alex, all set for Friday.\n```";
    await deliverScheduledOutput(response, "fin-client", "scheduler", {
      hasWebhook: false,
      ...m,
      sleep: noSleep,
    });
    const sent = m.sendBotDirect.mock.calls.map((c) => String(c[0]));
    expect(sent).toContain("The account reconciled fine.");
    // The draft is a clean standalone post — no fence, no analysis text.
    expect(sent).toContain("Hi Alex, all set for Friday.");
    expect(sent.some((s) => s.includes("```"))).toBe(false);
  });

  it("strips icon tokens from client drafts but keeps them in the analysis", async () => {
    const m = mocks();
    // The daemon resolves :cc_x: shortcodes before this runs, so drafts can
    // arrive with rendered <:cc_x:id> tokens as well as raw shortcodes.
    const response =
      "<:cc_bell:111> Birthday tomorrow.\n\n```draft\n<:cc_calendar:222> Happy birthday, Alex! :cc_sparkles:\n```";
    await deliverScheduledOutput(response, "fin-client", "scheduler", {
      hasWebhook: false,
      ...m,
      sleep: noSleep,
    });
    const sent = m.sendBotDirect.mock.calls.map((c) => String(c[0]));
    expect(sent).toContain("<:cc_bell:111> Birthday tomorrow.");
    expect(sent).toContain("Happy birthday, Alex!");
    expect(sent.some((s) => s.includes("Happy birthday") && s.includes("cc_"))).toBe(false);
  });

  it("retries then dead-letters once with the schedule label, abandoning the rest", async () => {
    const m = mocks();
    m.sendBotDirect.mockRejectedValue(new Error("Discord 503"));
    const res = await deliverScheduledOutput("morning book scan", "fin-client", "recurring:HOTfwrr2", {
      hasWebhook: false,
      ...m,
      sleep: noSleep,
    });
    expect(res).toEqual({ posted: 0, deadLettered: true });
    // 3 attempts on the single post, then one dead-letter.
    expect(m.sendBotDirect).toHaveBeenCalledTimes(3);
    expect(m.deadLetter).toHaveBeenCalledTimes(1);
    expect(String(m.deadLetter.mock.calls[0]![0])).toContain("recurring:HOTfwrr2");
    expect(String(m.deadLetter.mock.calls[0]![0])).toContain("Discord 503");
  });

  it("the webhook leg makes one post per logical message (it splits internally)", async () => {
    const m = mocks();
    // Long analysis + a draft: webhook = 1 post for analysis, 1 for the draft.
    const response = "The account reconciled fine.\n\n```draft\nHi Alex.\n```";
    await deliverScheduledOutput(response, "a", "scheduler", {
      hasWebhook: true,
      ...m,
      sleep: noSleep,
    });
    expect(m.sendWebhook).toHaveBeenCalledTimes(2);
    expect(m.sendWebhook.mock.calls[0]![0]).toBe("The account reconciled fine.");
    expect(m.sendWebhook.mock.calls[1]![0]).toBe("Hi Alex.");
    expect(m.sendBotDirect).not.toHaveBeenCalled();
  });
});

import { DeadLetterRateLimiter, DEAD_LETTER_MIN_INTERVAL_MS } from "../scheduled-delivery.js";

describe("DeadLetterRateLimiter", () => {
  it("posts the first failure, suppresses repeats within the window", () => {
    let now = 1_000_000;
    const rl = new DeadLetterRateLimiter(DEAD_LETTER_MIN_INTERVAL_MS, () => now);
    expect(rl.gate("fin", "sched", "boom 1")).toBe("boom 1");
    now += 60_000; // 1 min later, still inside the 30-min window
    expect(rl.gate("fin", "sched", "boom 2")).toBeNull();
    now += 60_000;
    expect(rl.gate("fin", "sched", "boom 3")).toBeNull();
  });

  it("after the window, the next post summarises the suppressed failures", () => {
    let now = 1_000_000;
    const rl = new DeadLetterRateLimiter(30 * 60_000, () => now);
    rl.gate("fin", "sched", "first");
    now += 5 * 60_000;
    const suppressedAt = new Date(now).toISOString();
    rl.gate("fin", "sched", "suppressed a"); // counted
    now += 5 * 60_000;
    rl.gate("fin", "sched", "suppressed b"); // counted
    now += 25 * 60_000; // now past the 30-min window from the first post
    const posted = rl.gate("fin", "sched", "next real post");
    expect(posted).toContain("next real post");
    expect(posted).toContain("+2 more failures suppressed since");
    expect(posted).toContain(suppressedAt);
  });

  it("keys are independent per (agent, schedule)", () => {
    let now = 1_000_000;
    const rl = new DeadLetterRateLimiter(30 * 60_000, () => now);
    expect(rl.gate("fin", "A", "x")).toBe("x");
    // Same agent, different schedule → not throttled.
    expect(rl.gate("fin", "B", "y")).toBe("y");
    // Different agent, same schedule name → not throttled.
    expect(rl.gate("other", "A", "z")).toBe("z");
    // Repeat of the first key IS throttled.
    expect(rl.gate("fin", "A", "again")).toBeNull();
  });

  it("resets the count after a real post (does not double-report)", () => {
    let now = 1_000_000;
    const rl = new DeadLetterRateLimiter(30 * 60_000, () => now);
    rl.gate("fin", "sched", "p1");
    now += 60_000;
    rl.gate("fin", "sched", "s1"); // suppressed, count = 1
    now += 30 * 60_000;
    const p2 = rl.gate("fin", "sched", "p2");
    expect(p2).toContain("+1 more failure suppressed since");
    now += 30 * 60_000 + 1;
    // No suppressions since p2 → clean post, no summary.
    const p3 = rl.gate("fin", "sched", "p3");
    expect(p3).toBe("p3");
  });
});
