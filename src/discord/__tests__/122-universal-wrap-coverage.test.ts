import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Phase 122 — universal-wiring sentinel. Long-term regression mechanism per
 * CONTEXT D-04 / SC-1. For each canonical Discord send chokepoint, locate a
 * stable anchor (function/method declaration or distinctive string) and
 * assert wrapMarkdownTablesInCodeFence appears within a small line window
 * after the anchor. A future commit that removes the wrap from any anchored
 * region trips this test.
 *
 * NOT a behavioral test — purely structural. Pairs with the per-chokepoint
 * unit tests (markdown-table-wrap, webhook-manager.sendAsAgent) which prove
 * the wrap WORKS; this test proves the wrap is STILL THERE.
 *
 * Inheritance note: daemon-ask-agent-ipc.ts:286 (999.12 mirror) and
 * daemon-post-to-agent-ipc.ts:220 (Phase 119 A2A-01) call
 * botDirectSender.sendText — they inherit the wrap from the inline
 * BotDirectSender impl in daemon.ts. The test anchors that impl, not the
 * call sites, per advisor guidance.
 */

const REPO_ROOT = process.cwd();

function readSource(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

/**
 * Returns true if `needle` appears in `source` within `windowLines` lines
 * AFTER the line containing `anchor`. Anchor MUST be unique in the file —
 * otherwise the test passes for the wrong reason.
 */
function hasNeedleWithinWindow(
  source: string,
  anchor: string,
  needle: string,
  windowLines: number,
): { found: boolean; anchorOccurrences: number } {
  const lines = source.split("\n");
  const anchorIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(anchor)) anchorIndices.push(i);
  }
  if (anchorIndices.length === 0) return { found: false, anchorOccurrences: 0 };
  for (const idx of anchorIndices) {
    const end = Math.min(lines.length, idx + windowLines + 1);
    for (let j = idx; j < end; j++) {
      if (lines[j].includes(needle)) {
        return { found: true, anchorOccurrences: anchorIndices.length };
      }
    }
  }
  return { found: false, anchorOccurrences: anchorIndices.length };
}

// Phase 999.79 (2026-05-23) — chokepoint helper renamed from
// `wrapMarkdownTablesInCodeFence` to `formatOutboundText`, which
// composes the wrap with `stripEmDashes`. The same coverage
// invariant applies: every outbound chokepoint must call the
// universal formatter. `wrapMarkdownTablesInCodeFence` is still
// exported as the underlying wrap helper (composed inside
// `formatOutboundText`) but is no longer called directly at any
// chokepoint.
const WRAP_CALL = "formatOutboundText";

describe("Phase 122 — universal wrap coverage (static-grep sentinel)", () => {
  it("UWC-1: webhook-manager.ts imports the wrap helper", () => {
    const src = readSource("src/discord/webhook-manager.ts");
    expect(src).toContain(`from "./markdown-table-wrap.js"`);
    expect(src).toContain(WRAP_CALL);
  });

  it("UWC-2: WebhookManager.send wraps content (Phase 100 follow-up, pinned)", () => {
    const src = readSource("src/discord/webhook-manager.ts");
    const result = hasNeedleWithinWindow(
      src,
      "async send(agentName: string, content: string)",
      WRAP_CALL,
      30,
    );
    expect(result.anchorOccurrences).toBe(1);
    expect(result.found).toBe(true);
  });

  it("UWC-3: WebhookManager.attemptSendAsAgent wraps embed.description (Phase 122)", () => {
    const src = readSource("src/discord/webhook-manager.ts");
    const result = hasNeedleWithinWindow(
      src,
      "private async attemptSendAsAgent",
      WRAP_CALL,
      30,
    );
    expect(result.anchorOccurrences).toBe(1);
    expect(result.found).toBe(true);
  });

  it("UWC-4: bridge.ts imports the wrap helper", () => {
    const src = readSource("src/discord/bridge.ts");
    expect(src).toContain(`from "./markdown-table-wrap.js"`);
  });

  it("UWC-5: bridge.sendDirect wraps the channel.send fallback (Phase 122)", () => {
    const src = readSource("src/discord/bridge.ts");
    const result = hasNeedleWithinWindow(
      src,
      "private async sendDirect(",
      WRAP_CALL,
      40,
    );
    expect(result.anchorOccurrences).toBe(1);
    expect(result.found).toBe(true);
  });

  it("UWC-6: bridge.ts chunked plain-send path (line 736 region) still wraps (Phase 100 follow-up)", () => {
    // Anchor on the distinctive `if ("send" in channel && typeof channel.send === "function") {`
    // pattern inside the message-handler turn loop (NOT sendDirect). Two
    // such anchors exist in this file — verify the wrap appears near at
    // least one (the existing Phase 100-fu site).
    const src = readSource("src/discord/bridge.ts");
    // Use the wrapped-then-send pattern directly: const wrapped = formatOutboundText
    // (Phase 999.79 — renamed from `wrapMarkdownTablesInCodeFence`.)
    expect(src).toMatch(/const wrapped = formatOutboundText\(/);
  });

  it("UWC-7: daemon.ts imports the wrap helper for the inline BotDirectSender", () => {
    const src = readSource("src/manager/daemon.ts");
    expect(src).toContain(`from "../discord/markdown-table-wrap.js"`);
  });

  it("UWC-8: inline BotDirectSender.sendText in daemon.ts wraps content (Phase 122)", () => {
    const src = readSource("src/manager/daemon.ts");
    // Anchor: the inline impl uses `async sendText(channelId, content)` —
    // a unique signature in this file (the daemon.ts also has a
    // `await bot.sendText(channelId, truncated)` call site which uses
    // different surrounding text, so the anchor stays unique).
    const result = hasNeedleWithinWindow(
      src,
      "async sendText(channelId, content)",
      WRAP_CALL,
      15,
    );
    expect(result.anchorOccurrences).toBe(1);
    expect(result.found).toBe(true);
  });

  it("UWC-9: inline BotDirectSender.sendEmbed in daemon.ts wraps embed.description (Phase 122)", () => {
    const src = readSource("src/manager/daemon.ts");
    const result = hasNeedleWithinWindow(
      src,
      "async sendEmbed(channelId, embed)",
      WRAP_CALL,
      15,
    );
    expect(result.anchorOccurrences).toBe(1);
    expect(result.found).toBe(true);
  });

  it("UWC-10: daemon-ask-agent-ipc.ts mirror path stays a thin caller (inherits wrap via botDirectSender.sendText)", () => {
    // Per CONTEXT D-06 + advisor: the call site does NOT wrap; the daemon.ts
    // inline impl does. This test ASSERTS the call site is a plain
    // .sendText(channelId, truncated) — if a future commit "helpfully"
    // wraps here too, that's double-wrap (still idempotent but defeats the
    // single-chokepoint model). Pin the shape so future drift is visible.
    const src = readSource("src/manager/daemon-ask-agent-ipc.ts");
    expect(src).toContain("await deps.botDirectSender.sendText(channelId, truncated)");
    // And the wrap helper is NOT imported here (chokepoint-only).
    expect(src).not.toContain(`from "../discord/markdown-table-wrap.js"`);
  });

  it("UWC-11: daemon-post-to-agent-ipc.ts A2A-01 bot-direct rung stays a thin caller (Phase 119)", () => {
    const src = readSource("src/manager/daemon-post-to-agent-ipc.ts");
    expect(src).toContain("await deps.botDirectSender.sendText(channelId, message)");
    expect(src).not.toContain(`from "../discord/markdown-table-wrap.js"`);
  });

  // 2026-08-27 — the two legs that shipped RAW tables (client-a: "fix the table
  // so it's readable"): the delivery queue's bot fallback and exit C.
  it("UWC-T1: delivery-queue deliverFn plans tables (images + formatOutboundText) for BOTH legs", () => {
    const src = readSource("src/manager/daemon.ts");
    const result = hasNeedleWithinWindow(
      src,
      "deliverFn: async (agentName: string, channelId: string, content: string) => {",
      "planOutboundTables(content",
      8,
    );
    expect(result.anchorOccurrences).toBe(1);
    expect(result.found).toBe(true);
    // The bot leg must send the PLANNED text, never the raw content.
    const leg = src.slice(src.indexOf("deliverFn: async (agentName"), src.indexOf("delivery queue initialized"));
    expect(leg).toContain("splitKeepingAnnotations(plan.text");
    expect(leg).not.toContain("send(content)");
  });

  it("UWC-T2: bridge exit C (bot edit-in-place) plans tables before the final edit", () => {
    const src = readSource("src/discord/bridge.ts");
    const result = hasNeedleWithinWindow(src, "const rawDeliveryText = deliveryText;", "planOutboundTables(deliveryText", 6);
    expect(result.anchorOccurrences).toBe(1);
    expect(result.found).toBe(true);
  });

  it("UWC-T3: WebhookManager.sendWithFiles wraps like send()", () => {
    const src = readSource("src/discord/webhook-manager.ts");
    const result = hasNeedleWithinWindow(src, "async sendWithFiles(", "formatOutboundText(content)", 8);
    expect(result.anchorOccurrences).toBe(1);
    expect(result.found).toBe(true);
  });
});
