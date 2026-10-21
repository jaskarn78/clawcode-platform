#!/usr/bin/env node
/**
 * Phase 141 WS-2 (Option B) — ClawCode v3 `PreToolUse` Bash allowlist hook.
 *
 * The runnable binary the v3 backend injects via `--settings` ONLY for a
 * locked-down agent (non-empty `security.allowlist`):
 *   {"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command",
 *     "command":"node <dist>/channels/clawcode-bash-allowlist-hook.js"}]}]}}
 *
 * `claude` fires it before every Bash tool call and pipes the PreToolUse event
 * JSON on stdin (`{tool_name, tool_input:{command}}`). The hook denies any Bash
 * command not matching the agent's allowlist (`CLAWCODE_BASH_ALLOWLIST` env, a
 * JSON array of glob patterns) using the SAME `matchCommand` semantics the v2
 * approval path uses — so v3 gets deny-by-default Bash WITHOUT touching any other
 * tool. A hook `deny` takes precedence over `bypassPermissions` and is
 * headless-safe (the model sees a denial and continues; no prompt → no PTY hang).
 *
 * Why a hook and not `--permission-mode dontAsk`: dontAsk auto-denies EVERY
 * prompting tool (Write/Edit/WebFetch + the clawcode MCP tools incl.
 * clawcode_ack), which breaks the agent. v2's allowlist gates Bash ONLY — this
 * hook reproduces that exactly. See 141-WS2-SECURITY.md.
 *
 * FAIL-CLOSED: the hook is registered ONLY when an allowlist exists, so a missing
 * or unparseable `CLAWCODE_BASH_ALLOWLIST`, or an unreadable tool call, is a
 * misconfiguration → DENY (allowing-all would silently defeat the gate). A
 * non-Bash tool (should never reach here given the matcher) is always allowed.
 */

import { matchCommand } from "../security/allowlist-matcher.js";

interface PreToolUsePayload {
  readonly tool_name?: string;
  readonly tool_input?: { readonly command?: string };
}

export interface BashAllowlistDecision {
  readonly deny: boolean;
  readonly reason?: string;
}

/**
 * Pure decision logic (exported for unit tests). Returns `{deny:true,reason}` to
 * block, `{deny:false}` to allow. Gates Bash only; fails closed on a malformed
 * allowlist.
 */
export function decideBashAllowlist(
  toolName: string | undefined,
  command: string | undefined,
  patternsJson: string | undefined,
): BashAllowlistDecision {
  // Never block a non-Bash tool (the PreToolUse matcher already scopes to Bash;
  // this is defense-in-depth so the hook can't accidentally gate Read/Write/MCP).
  if (toolName !== "Bash") return { deny: false };

  let patterns: string[];
  try {
    const parsed: unknown = JSON.parse(patternsJson ?? "");
    if (!Array.isArray(parsed)) {
      return { deny: true, reason: "bash allowlist misconfigured (not an array)" };
    }
    patterns = parsed.filter((p): p is string => typeof p === "string");
  } catch {
    return { deny: true, reason: "bash allowlist missing or unparseable" };
  }

  const cmd = (command ?? "").trim();
  if (cmd.length === 0) return { deny: false }; // nothing to run → nothing to gate

  if (matchCommand(cmd, patterns).allowed) return { deny: false };
  return {
    deny: true,
    reason: `Command not permitted by this agent's security.allowlist: ${cmd}`,
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
    const t = setTimeout(() => resolve(data), 2_000);
    t.unref?.();
  });
}

function emitDeny(reason: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
}

async function main(): Promise<void> {
  let payload: PreToolUsePayload = {};
  let parsedOk = false;
  try {
    const raw = await readStdin();
    if (raw.trim().length > 0) {
      payload = JSON.parse(raw) as PreToolUsePayload;
      parsedOk = true;
    }
  } catch {
    parsedOk = false;
  }

  // Could not read the tool call at all → fail closed (only Bash reaches this
  // hook, and we cannot confirm it is allowed).
  if (!parsedOk) {
    emitDeny("bash allowlist hook could not parse the tool call");
    return;
  }

  const decision = decideBashAllowlist(
    payload.tool_name,
    payload.tool_input?.command,
    process.env.CLAWCODE_BASH_ALLOWLIST,
  );
  if (decision.deny) emitDeny(decision.reason ?? "denied by bash allowlist");
  // allow → no output (PreToolUse with no decision falls through to the normal
  // permission flow, which under bypassPermissions runs the command).
}

// Always exit 0 — the deny decision is carried in the JSON, not the exit code.
// A non-zero exit / unhandled rejection could surface as a turn error.
//
// Flush stdout BEFORE exiting: `process.exit` can tear the process down before
// libuv drains a piped stdout write, truncating the deny JSON. A truncated/empty
// hook output reads as "no decision" and (under bypassPermissions) falls through
// to ALLOW — fail-OPEN on a security gate. The empty-write callback fires only
// once all prior writes (the deny payload) have drained.
function exitAfterFlush(): void {
  process.stdout.write("", () => process.exit(0));
}
main().then(exitAfterFlush, exitAfterFlush);
