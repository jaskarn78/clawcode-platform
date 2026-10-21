/** SUPPRESS_EMBEDS on every agent delivery (2026-08-28). */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { MessageFlags } from "discord.js";
import { configureSuppressLinkEmbeds, deliveryFlags } from "../delivery-flags.js";

describe("deliveryFlags", () => {
  it("defaults on, can be switched off at boot", () => {
    configureSuppressLinkEmbeds(undefined);
    expect(deliveryFlags()).toEqual({ flags: MessageFlags.SuppressEmbeds });
    configureSuppressLinkEmbeds(false);
    expect(deliveryFlags()).toEqual({});
    configureSuppressLinkEmbeds(true);
  });
  it("every delivery leg spreads deliveryFlags() (static pins)", () => {
    const bridge = readFileSync(new URL("../bridge.ts", import.meta.url), "utf8");
    const exitC = bridge.slice(bridge.indexOf("const rawDeliveryText = deliveryText;"), bridge.indexOf("recordLedger([messageRef.current.id]);"));
    expect((exitC.match(/\.\.\.deliveryFlags\(\)/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(bridge).toContain("channel.send({ content: wrapped, ...deliveryFlags() })");
    const webhook = readFileSync(new URL("../webhook-manager.ts", import.meta.url), "utf8");
    expect(webhook).toContain("...(deliveryFlags() as { flags?: never })");
    const daemon = readFileSync(new URL("../../manager/daemon.ts", import.meta.url), "utf8");
    const leg = daemon.slice(daemon.indexOf("deliverFn: async (agentName"), daemon.indexOf("delivery queue initialized"));
    expect(leg).toContain("...deliveryFlags()");
    expect(daemon).toContain("configureSuppressLinkEmbeds(config.discord?.suppressLinkEmbeds)");
  });
  it("the 🧾 button needs 2+ sources or a recorded claim — never a `0` label (static pin)", () => {
    const bridge = readFileSync(new URL("../bridge.ts", import.meta.url), "utf8");
    expect(bridge).toMatch(/const ledgerButtonOn =[\s\S]{0,300}\(nSources >= 2 \|\| nClaims >= 1\) &&/);
    expect(bridge).not.toMatch(/setLabel\(`Sources · \$\{nClaims\}/);
  });
});
