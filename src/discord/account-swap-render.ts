/**
 * Phase 999.176 — pure text renderers for `/clawcode-account`. No Discord
 * objects here, so every screen is unit-testable.
 */

import type { CredentialSummary } from "../account/credential-slots.js";
import type { AccountStatusView } from "../account/account-service.js";
import type { SwapBootResult } from "../account/pending-swap.js";

/** "default_claude_max_20x" → "Max 20x"; falls back to subscription type. */
export function formatTier(s: Pick<CredentialSummary, "rateLimitTier" | "subscriptionType">): string {
  const m = /max_(\d+x)/i.exec(s.rateLimitTier ?? "");
  if (m?.[1]) return `Max ${m[1]}`;
  if (s.subscriptionType) return s.subscriptionType;
  return "unknown tier";
}

export function formatAccess(expiresAt: number | null, now: number): string {
  if (expiresAt === null) return "no token";
  const hours = (expiresAt - now) / 3_600_000;
  return hours > 0 ? `access valid ${hours.toFixed(1)}h` : "access expired (refresh decides)";
}

export function renderStatus(view: AccountStatusView, now: number): string {
  const emailOf = (name: string | null): string =>
    view.configured.find((c) => c.name === name)?.email ?? "unconfigured";
  const lines = [
    "## Fleet Claude account",
    view.activeSlot === null
      ? "**Live:** ⚠️ unlabeled — label it once with the ssh tool before switching."
      : `**Live:** \`${view.activeSlot}\` · ${emailOf(view.activeSlot)} · ${formatTier(view.live)} · ${formatAccess(view.live.expiresAt, now)}`,
    "",
  ];
  if (view.configured.length === 0) {
    lines.push("No account slots are configured (`defaults.accountSwap.slots`).");
    return lines.join("\n");
  }
  for (const slot of view.slots) {
    const email = emailOf(slot.name);
    if (!slot.present) {
      lines.push(`• \`${slot.name}\` · ${email} — not saved yet (switching will ask you to sign in)`);
      continue;
    }
    const tag =
      slot.name === view.activeSlot
        ? slot.matchesLive
          ? "live · rollback copy current"
          : "live · saved copy is behind (refreshed on switch)"
        : "idle · checked when you switch";
    lines.push(`• \`${slot.name}\` · ${email} · ${formatTier(slot)} — ${tag}`);
  }
  lines.push("", "-# Switching checks the saved login first, and restarts the whole fleet only after you confirm.");
  return lines.join("\n");
}

/** Render untrusted text inert: no links, no mentions, no formatting. */
export function inlineCode(text: string): string {
  const clean = text.replace(/[`\r\n]/g, " ").trim().slice(0, 200);
  return `\`${clean.length > 0 ? clean : "no detail"}\``;
}

export type MacLine =
  | { readonly kind: "none" }
  | { readonly kind: "trying" }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "done" };

function macLineText(mac: MacLine): string | null {
  switch (mac.kind) {
    case "none":
      return null;
    case "trying":
      return "🖥️ Signing in on your MacBook… (you can paste the code yourself at any time)";
    case "unavailable":
      return `🖥️ MacBook couldn't finish: ${inlineCode(mac.reason)}. Use the link below.`;
    case "done":
      return "🖥️ MacBook submitted the code — checking it…";
  }
}

export function renderLogin(input: {
  readonly target: string;
  readonly email: string;
  readonly why: string;
  readonly url: string;
  readonly expiresAt: number;
  readonly mac: MacLine;
}): string {
  const lines = [
    `## Sign in again: \`${input.target}\``,
    `The saved login for **${input.email}** can't be used (${input.why}).`,
    "",
  ];
  const mac = macLineText(input.mac);
  if (mac !== null) lines.push(mac, "");
  lines.push(
    `1. [Open the sign-in page](<${input.url}>) and sign in as **${input.email}**.`,
    "2. Copy the code it shows, press **Enter code**, and paste it.",
    "",
    `-# Link expires <t:${Math.floor(input.expiresAt / 1000)}:R>. Nothing changes on the fleet until you confirm the switch.`,
  );
  return lines.join("\n");
}

export function renderConfirm(input: {
  readonly target: string;
  readonly email: string;
  readonly summary: CredentialSummary;
  readonly fromSlot: string | null;
  readonly fromTier: string;
  readonly runningAgents: number;
  readonly busyAgents: readonly string[];
  readonly freshLogin: boolean;
  /** False when the credential's account could not be read back (label only). */
  readonly emailVerified?: boolean;
}): string {
  const tier = formatTier(input.summary);
  const lines = [
    `## Switch fleet to \`${input.target}\`?`,
    input.freshLogin
      ? `✅ Signed in as **${input.email}** · ${tier}`
      : `✅ Saved login for **${input.email}** works · ${tier}`,
  ];
  if (input.emailVerified === false) {
    lines.push("-# The login works, but its account couldn't be read back; the email shown is the slot's configured label.");
  }
  if (input.fromTier !== tier) {
    lines.push(`⚠️ Plan changes: **${input.fromTier} → ${tier}**.`);
  }
  lines.push(
    "",
    `Switching restarts the whole fleet (${input.runningAgents} running agents; they resume on their own).`,
  );
  lines.push(
    input.busyAgents.length > 0
      ? `⏳ **Mid-turn right now:** ${input.busyAgents.join(", ")}. Those turns will be cut off.`
      : "No agent is mid-turn right now.",
  );
  if (input.fromSlot !== null) {
    lines.push(`-# The current \`${input.fromSlot}\` login is saved first, so you can switch back.`);
  }
  return lines.join("\n");
}

export function renderBootReport(input: {
  readonly result: SwapBootResult;
  readonly live: CredentialSummary;
  readonly liveEmail: string | null;
  readonly probeOk: boolean | null;
  readonly runningAgents: number;
  readonly now: number;
}): string {
  const r = input.result;
  if (!r.ok) {
    return [
      `## ❌ Account switch to \`${r.to}\` failed`,
      `${r.error ?? "unknown error"}`,
      "The live login was not changed; the fleet restarted on the same account.",
    ].join("\n");
  }
  if (!r.changed) {
    return `## Account switch: already on \`${r.to}\` — nothing changed.`;
  }
  const probe =
    input.probeOk === null
      ? "⏭️ auth check skipped"
      : input.probeOk
        ? "✅ test call to Claude succeeded on the new account"
        : "⚠️ test call to Claude FAILED — check `journalctl -u clawcode` for `authentication_error`, or roll back";
  return [
    `## 🔁 Fleet switched: \`${r.from}\` → \`${r.to}\``,
    `**Live:** ${input.liveEmail ?? r.to} · ${formatTier(input.live)} · ${formatAccess(input.live.expiresAt, input.now)}`,
    probe,
    `${input.runningAgents} agents running.`,
    `-# Requested by <@${r.requestedBy}>.`,
  ].join("\n");
}
