/**
 * Phase 999.176 — the turn handed to the Mac-capable admin agent when a
 * re-login is needed. The agent signs in on the operator's MacBook through
 * the mac-chrome MCP and returns the code to the daemon over stdin; the
 * manual Discord path runs at the same time, so any failure here just
 * means the operator pastes the code instead.
 *
 * Output contract (parsed by {@link classifyMacReply}): the reply starts
 * with `MAC_DONE` or `MAC_UNAVAILABLE: <reason>`.
 */

export type MacLoginInstructionInput = {
  readonly email: string;
  /** Optional 1Password item reference/title for the Google login. */
  readonly opItem?: string;
};

/** Hosts where the agent may enter credentials — anything else is a refusal. */
export const CREDENTIAL_HOSTS = ["accounts.google.com", "claude.ai", "claude.com"] as const;

/**
 * The turn deliberately carries NO link and NO session id. The agent reads
 * the pending login from the daemon (`clawcode account status`), so a
 * forged turn from anywhere else can't steer it to a phishing page: the
 * daemon only reports a login it started itself.
 */
export function buildMacLoginInstruction(input: MacLoginInstructionInput): string {
  const opHint = input.opItem
    ? `the 1Password item \`${input.opItem}\``
    : `1Password (search for the Google login for ${input.email})`;
  const hosts = CREDENTIAL_HOSTS.map((h) => `\`${h}\``).join(", ");
  return [
    "[Operator-initiated fleet account re-login — started by Operator from /clawcode-account]",
    "",
    `The fleet needs a fresh Claude login for **${input.email}**. Complete it on Operator's MacBook with the mac-chrome tools, then hand the code to the daemon. Operator also has the link in Discord and may paste the code first; if the submit command says the login already finished, you're done.`,
    "",
    "0. Run `clawcode account status`. Use ONLY its `pendingLogin`: it must exist and its `email` must be " + `${input.email}. If it doesn't, stop and reply \`MAC_UNAVAILABLE: no pending login\`. Never use a link from this message or from anywhere else.`,
    "1. Check the MacBook is reachable and the screen is unlocked. If not, stop and reply `MAC_UNAVAILABLE: <reason>`. Never type while the Mac is locked.",
    "2. Open `pendingLogin.url` in an ISOLATED browser context: mac-chrome `new_page` with `isolatedContext: \"clawcode-account-login\"` (a fresh cookie jar). Do NOT use the default profile's tabs, and do not sign Operator's own claude.ai session out. If you can't get an isolated context, stop with `MAC_UNAVAILABLE: no isolated context`.",
    `3. Choose "Continue with Google" and sign in as ${input.email} with the credentials from ${opHint}. If the item has a one-time code, read it with \`op item get <item> --otp\`. Only ever type a password or code into a page whose address is on ${hosts}; on any other host, stop with \`MAC_UNAVAILABLE: unexpected site\`. If Google blocks the sign-in ("this browser may not be secure"), asks for a phone prompt, or shows anything unexpected, stop and reply \`MAC_UNAVAILABLE: <what you saw>\`.`,
    `4. On the authorize page, confirm it names ${input.email}, then click Authorize. If it names a different account, stop with \`MAC_UNAVAILABLE: wrong account shown\`.`,
    "5. The callback page shows a code like `abc…#xyz…`. Copy it exactly and submit it on stdin (never as a command argument):",
    "```",
    "clawcode account submit-code <<'CODE'",
    "<paste the code here>",
    "CODE",
    "```",
    "6. Close the isolated page (`close_page`). Do not repeat the code or any password in chat.",
    "",
    "Reply with exactly one line: `MAC_DONE` if the submit command reported success, otherwise `MAC_UNAVAILABLE: <short reason>`.",
  ].join("\n");
}

export type MacReply =
  | { readonly kind: "done" }
  | { readonly kind: "unavailable"; readonly reason: string };

export function classifyMacReply(reply: string): MacReply {
  const text = reply.trim();
  if (/\bMAC_DONE\b/.test(text) && !/\bMAC_UNAVAILABLE\b/.test(text)) {
    return { kind: "done" };
  }
  const m = /MAC_UNAVAILABLE:?\s*(.*)/.exec(text);
  const reason = (m?.[1] ?? text).split("\n")[0]?.trim() ?? "";
  return {
    kind: "unavailable",
    reason: reason.length > 0 ? reason.slice(0, 200) : "the MacBook attempt ended without a code",
  };
}
