#!/usr/bin/env node
/**
 * Phase 140 — ClawCode v3 `Stop` hook (deterministic delivery fallback).
 *
 * The runnable binary the v3 backend injects via `--settings`
 * (`{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"node <dist>/channels/clawcode-stop-hook.js"}]}]}}`).
 * `claude --channels` fires it at every turn-end and pipes the Stop event JSON
 * on stdin, which includes `last_assistant_message` (the agent's final text).
 *
 * The hook's whole job: tell the daemon the turn ended and hand it that text.
 * The daemon's `AgentChannelBridge.handleTurnComplete` then resolves any
 * STILL-PENDING `awaitReply` with it — so a Discord chat ALWAYS gets a reply
 * even when the model forgot to call `clawcode_ack`. If the agent DID ack, the
 * pending reply is already gone → the daemon-side fallback is a no-op.
 *
 * Routing is by `CLAWCODE_AGENT_NAME` (inherited from the spawn env —
 * authoritative; `cwd` is NOT trusted, it diverges for subagents). Best-effort
 * and non-blocking: any failure exits 0 so a Stop hook never wedges a turn.
 */

import { defaultHookSocketPath, sendTurnCompleteFrame } from "./unix-socket-transport.js";

interface StopHookPayload {
  readonly session_id?: string;
  readonly last_assistant_message?: string;
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
    // Defensive: if stdin never closes, don't hang the turn.
    const t = setTimeout(() => resolve(data), 2_000);
    t.unref?.();
  });
}

async function main(): Promise<void> {
  const agent = process.env.CLAWCODE_AGENT_NAME;
  if (!agent) return; // No identity → can't route. Never break the turn.

  let payload: StopHookPayload = {};
  try {
    const raw = await readStdin();
    if (raw.trim().length > 0) payload = JSON.parse(raw) as StopHookPayload;
  } catch {
    return; // Malformed payload → drop silently.
  }

  const text = (payload.last_assistant_message ?? "").trim();
  if (text.length === 0) return; // No assistant text this turn → nothing to deliver.

  await sendTurnCompleteFrame(defaultHookSocketPath(agent), {
    type: "turn_complete",
    agent,
    session_id: payload.session_id,
    last_assistant_message: payload.last_assistant_message ?? "",
  });
}

// Never throw out of the hook — a non-zero exit / unhandled rejection could
// surface as a turn error in the agent's session.
main().then(
  () => process.exit(0),
  () => process.exit(0),
);
