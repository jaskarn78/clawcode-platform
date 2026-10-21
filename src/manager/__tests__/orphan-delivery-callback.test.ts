/**
 * WS-1 (999.99 structural delivery) — orphan-delivery callback unit tests.
 *
 * Post-review contract (999.99 adversarial review):
 *   - webhook leg requires hasWebhook(agent) === true
 *   - webhook-less agents fall back to botDirectSend(channelId, content)
 *   - neither sink → warn-logged drop (grep ws1-orphan-delivery)
 *   - isError payloads are SUPPRESSED (logged, never posted)
 *   - sends are serialized per agent (tail promise — ordering pinned)
 */
import { describe, it, expect, vi } from "vitest";
import {
  makeOrphanDeliveryCallback,
  ORPHAN_OUTPUT_PREFIX,
} from "../orphan-delivery-callback.js";
import type { WebhookManager } from "../../discord/webhook-manager.js";
import { icons } from "../../discord/icons.js";

const payload = (text = "background result") => ({
  text,
  originKind: "task-notification" as string | null,
  isError: false,
  classification: "orphan-signaled" as const,
});

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

function makeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as import("pino").Logger;
}

function makeWm(send: ReturnType<typeof vi.fn>, has = true): WebhookManager {
  return {
    send,
    hasWebhook: vi.fn().mockReturnValue(has),
  } as unknown as WebhookManager;
}

describe("WS-1 — makeOrphanDeliveryCallback", () => {
  it("posts to the agent's own channel with the ⏱️ prefix", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const cb = makeOrphanDeliveryCallback({
      agentName: "Admin Clawdy",
      webhookManagerProvider: () => makeWm(send),
      log: makeLog(),
    });

    cb(payload("Sync clean — all 11 files uploaded"));
    await settle();

    expect(send).toHaveBeenCalledWith(
      "Admin Clawdy",
      `${ORPHAN_OUTPUT_PREFIX}Sync clean — all 11 files uploaded`,
    );
  });

  it("late-binds the webhookManager: unwired at factory time, wired at delivery time → delivers", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    let wm: WebhookManager | undefined;
    const cb = makeOrphanDeliveryCallback({
      agentName: "a",
      webhookManagerProvider: () => wm,
      log: makeLog(),
    });
    // Boot window closes; the manager gets wired AFTER the factory ran.
    wm = makeWm(send);

    cb(payload());
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("no webhookManager and no bot-direct at delivery time → warn-logged drop, never a throw", async () => {
    const log = makeLog();
    const cb = makeOrphanDeliveryCallback({
      agentName: "a",
      webhookManagerProvider: () => undefined,
      log,
    });
    expect(() => cb(payload())).not.toThrow();
    await settle();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ dropped: true }),
      expect.stringContaining("ws1-orphan-delivery"),
    );
  });

  it("webhook send rejection is swallowed + warn-logged (fire-and-forget)", async () => {
    const log = makeLog();
    const send = vi.fn().mockRejectedValue(new Error("discord 500"));
    const cb = makeOrphanDeliveryCallback({
      agentName: "a",
      webhookManagerProvider: () => makeWm(send),
      log,
    });
    expect(() => cb(payload())).not.toThrow();
    await settle();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: "discord 500" }),
      expect.stringContaining("delivery failed"),
    );
  });

  it("999.99 review — webhook-less agent falls back to bot-direct sendText(channelId, …)", async () => {
    const wmSend = vi.fn().mockResolvedValue(undefined);
    const botSend = vi.fn().mockResolvedValue("msg-id");
    const cb = makeOrphanDeliveryCallback({
      agentName: "client-a-health",
      webhookManagerProvider: () => makeWm(wmSend, /* hasWebhook */ false),
      botDirectSendProvider: () => botSend,
      channelIdProvider: () => "chan-health",
      log: makeLog(),
    });

    cb(payload("workout summary ready"));
    await settle();

    expect(wmSend).not.toHaveBeenCalled();
    expect(botSend).toHaveBeenCalledWith(
      "chan-health",
      `${ORPHAN_OUTPUT_PREFIX}workout summary ready`,
    );
  });

  // --- 2026-09-10 fin-client post-transcription incident -------------
  //
  // The bot-direct leg handed the whole payload to `sendText`, which issues
  // ONE channel.send. Discord rejects >2000 chars with BASE_TYPE_MAX_LENGTH,
  // so every long self-fired turn was warn-logged and dropped. Prod journal
  // 2026-07-24..09-10: 15 failures, ALL this error, smallest at 2004 chars —
  // and every one of the 100 deliveries took this leg, because no fleet agent
  // declares webhook.displayName so `hasWebhook()` is false fleet-wide.
  describe("bot-direct leg splits oversize output (2026-09-10 incident)", () => {
    /**
     * Prose of EXACTLY `chars` characters, with newline boundaries so the
     * splitter has its preferred cut points. Over-generates then slices —
     * the lengths in these test names are the real prod payload sizes and
     * must be exact, not approximate.
     */
    const longText = (chars: number) => {
      const line = (i: number) => `line ${String(i).padStart(4, "0")} ${"x".repeat(37)}`;
      let out = "";
      for (let i = 0; out.length < chars; i++) out += `${line(i)}\n`;
      return out.slice(0, chars);
    };

    const deliverViaBotDirect = async (text: string) => {
      const botSend = vi.fn().mockResolvedValue("msg-id");
      const cb = makeOrphanDeliveryCallback({
        agentName: "fin-client",
        webhookManagerProvider: () => makeWm(vi.fn(), /* hasWebhook */ false),
        botDirectSendProvider: () => botSend,
        channelIdProvider: () => "chan-finacq",
        log: makeLog(),
      });
      cb(payload(text));
      await settle();
      return botSend;
    };

    it("2297-char payload (the exact incident) posts in chunks, none over 2000", async () => {
      const botSend = await deliverViaBotDirect(longText(2297));

      expect(botSend.mock.calls.length).toBeGreaterThan(1);
      for (const [channelId, chunk] of botSend.mock.calls) {
        expect(channelId).toBe("chan-finacq");
        expect(chunk.length).toBeLessThanOrEqual(2000);
      }
    });

    it("2004 chars — the smallest real drop — still splits rather than failing", async () => {
      const botSend = await deliverViaBotDirect(longText(2004));

      expect(botSend.mock.calls.length).toBeGreaterThan(1);
      for (const [, chunk] of botSend.mock.calls) {
        expect(chunk.length).toBeLessThanOrEqual(2000);
      }
    });

    it("the ⏱️ prefix rides the first chunk only", async () => {
      const botSend = await deliverViaBotDirect(longText(5000));
      const chunks = botSend.mock.calls.map(([, c]) => c as string);

      expect(chunks[0].startsWith(ORPHAN_OUTPUT_PREFIX)).toBe(true);
      for (const chunk of chunks.slice(1)) {
        expect(chunk.startsWith(ORPHAN_OUTPUT_PREFIX)).toBe(false);
      }
    });

    it("chunks are sent sequentially and in order (no interleaving)", async () => {
      const order: string[] = [];
      let inFlight = 0;
      const botSend = vi.fn(async (_c: string, chunk: string) => {
        expect(inFlight).toBe(0); // previous send must have settled
        inFlight++;
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        order.push(chunk.slice(0, 12));
        return "msg-id";
      });
      const cb = makeOrphanDeliveryCallback({
        agentName: "fin-client",
        webhookManagerProvider: () => makeWm(vi.fn(), false),
        botDirectSendProvider: () => botSend,
        channelIdProvider: () => "chan-finacq",
        log: makeLog(),
      });

      cb(payload(longText(6000)));
      await new Promise((r) => setTimeout(r, 50));

      const sent = botSend.mock.calls.map(([, c]) => (c as string).slice(0, 12));
      expect(order).toEqual(sent);
    });

    it("reassembles to the original text (nothing dropped between chunks)", async () => {
      const text = longText(4500);
      const botSend = await deliverViaBotDirect(text);
      const rejoined = botSend.mock.calls
        .map(([, c]) => c as string)
        .join("\n")
        .replace(ORPHAN_OUTPUT_PREFIX, "");

      // The splitter trims whitespace at cut points, so compare on
      // whitespace-insensitive content rather than byte equality.
      expect(rejoined.replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""));
    });

    it("short output still posts as exactly one message (no behavior change)", async () => {
      const botSend = await deliverViaBotDirect("workout summary ready");

      expect(botSend).toHaveBeenCalledTimes(1);
      expect(botSend).toHaveBeenCalledWith(
        "chan-finacq",
        `${ORPHAN_OUTPUT_PREFIX}workout summary ready`,
      );
    });

    it("a mid-sequence send rejection is swallowed + warn-logged, never thrown", async () => {
      const log = makeLog();
      const botSend = vi
        .fn()
        .mockResolvedValueOnce("msg-id")
        .mockRejectedValue(new Error("Invalid Form Body"));
      const cb = makeOrphanDeliveryCallback({
        agentName: "fin-client",
        webhookManagerProvider: () => makeWm(vi.fn(), false),
        botDirectSendProvider: () => botSend,
        channelIdProvider: () => "chan-finacq",
        log,
      });

      expect(() => cb(payload(longText(5000)))).not.toThrow();
      await settle();

      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: "Invalid Form Body" }),
        expect.stringContaining("delivery failed"),
      );
    });
  });

  it("999.99 review — isError payloads are suppressed (logged, never posted)", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const log = makeLog();
    const cb = makeOrphanDeliveryCallback({
      agentName: "a",
      webhookManagerProvider: () => makeWm(send),
      log,
    });

    cb({
      text: "Aborted: interrupt deadline exceeded",
      originKind: null,
      isError: true,
      classification: "abandoned-daemon",
    });
    await settle();

    expect(send).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ suppressed: true }),
      expect.stringContaining("suppressed"),
    );
  });

  it("999.99 review — sends are serialized per agent (second waits for the first)", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => (releaseFirst = r));
    const send = vi
      .fn()
      .mockImplementationOnce(async (_a: string, c: string) => {
        order.push(`start:${c.slice(-1)}`);
        await firstGate;
        order.push(`end:${c.slice(-1)}`);
      })
      .mockImplementationOnce(async (_a: string, c: string) => {
        order.push(`start:${c.slice(-1)}`);
        order.push(`end:${c.slice(-1)}`);
      });
    const cb = makeOrphanDeliveryCallback({
      agentName: "a",
      webhookManagerProvider: () => makeWm(send),
      log: makeLog(),
    });

    cb(payload("1"));
    cb(payload("2"));
    await settle();
    // Second send must NOT have started while the first is in flight.
    expect(order).toEqual(["start:1"]);
    releaseFirst();
    await settle();
    expect(order).toEqual(["start:1", "end:1", "start:2", "end:2"]);
  });

  it("999.178 R1 — extracts a ```draft block: analysis carries ⏱️, the draft is posted plain", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const cb = makeOrphanDeliveryCallback({
      agentName: "a",
      webhookManagerProvider: () => makeWm(send),
      log: makeLog(),
    });

    cb(payload("The account reconciled fine.\n\n```draft\nHi Alex, all set for Friday.\n```"));
    await settle();

    expect(send).toHaveBeenCalledTimes(2);
    // Analysis first, with the self-fired marker.
    expect(send).toHaveBeenNthCalledWith(1, "a", `${ORPHAN_OUTPUT_PREFIX}The account reconciled fine.`);
    // Draft second, copy-paste clean: no ⏱️ prefix, no fence.
    expect(send).toHaveBeenNthCalledWith(2, "a", "Hi Alex, all set for Friday.");
  });

  it("999.178 R1 — strips icon shortcodes from the draft (client-facing)", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const cb = makeOrphanDeliveryCallback({
      agentName: "a",
      webhookManagerProvider: () => makeWm(send),
      log: makeLog(),
    });

    cb(payload("Done.\n\n```draft\n:cc_calendar: See you Friday, Alex.\n```"));
    await settle();

    expect(send).toHaveBeenNthCalledWith(2, "a", "See you Friday, Alex.");
  });

  it("999.178 R1 — a draft-only orphan still posts a lead + the clean draft", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const cb = makeOrphanDeliveryCallback({
      agentName: "a",
      webhookManagerProvider: () => makeWm(send),
      log: makeLog(),
    });

    cb(payload("```draft\nHappy birthday!\n```"));
    await settle();

    expect(send).toHaveBeenNthCalledWith(1, "a", `${ORPHAN_OUTPUT_PREFIX}Draft below.`);
    expect(send).toHaveBeenNthCalledWith(2, "a", "Happy birthday!");
  });
});

describe("WS-1 — cc_* icon shortcodes (999.178 R1)", () => {
  it("resolves :cc_name: (and strips unknown) in self-fired output before posting", async () => {
    icons.setAll([{ id: "42", name: "cc_bookmark" }]);
    const send = vi.fn().mockResolvedValue(undefined);
    const cb = makeOrphanDeliveryCallback({
      agentName: "a",
      webhookManagerProvider: () => makeWm(send),
      log: makeLog(),
    });
    cb(payload("Saved :cc_bookmark: the fact :cc_unknown: gone"));
    await settle();
    expect(send).toHaveBeenCalledWith(
      "a",
      `${ORPHAN_OUTPUT_PREFIX}Saved <:cc_bookmark:42> the fact gone`,
    );
    icons.clear();
  });
});
