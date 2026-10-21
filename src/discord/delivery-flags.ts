/**
 * Delivery message flags — 2026-08-28.
 *
 * A bare link in an agent reply makes Discord unfurl a preview card (the
 * "Finnhub - Free realtime APIs…" embed that ate half a phone screen under a
 * two-line answer). The daemon's own Sources links already suppress previews
 * with `<url>`; this applies Discord's SUPPRESS_EMBEDS flag to every agent
 * delivery so a model-written link can't unfurl either. Attachments (table
 * cards, PDFs) are not embeds and still render.
 *
 * Daemon-wide, boot-only (`discord.suppressLinkEmbeds`, default true) — same
 * flippable-knob pattern as table rendering.
 */
// Numeric on purpose: several suites mock "discord.js" with only the class
// under test, and an enum import here would make every send throw in them.
/** discord.js MessageFlags.SuppressEmbeds */
const SUPPRESS_EMBEDS = 1 << 2;

let suppress = true;

export function configureSuppressLinkEmbeds(on: boolean | undefined): void {
  suppress = on ?? true;
}

export function suppressLinkEmbedsEnabled(): boolean {
  return suppress;
}

/** Spread into any discord.js send/edit options: `{ content, ...deliveryFlags() }`. */
export function deliveryFlags(): { flags?: number } {
  return suppress ? { flags: SUPPRESS_EMBEDS } : {};
}
