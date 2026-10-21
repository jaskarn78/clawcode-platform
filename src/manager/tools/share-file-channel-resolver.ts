/**
 * Phase 999.36 sub-bug C (D-09, D-10) — pure helper resolving the
 * Discord destination channel for a `clawcode_share_file` invocation.
 *
 * Resolution order:
 *   1. If `channelIdParam` is explicitly provided → use it (operator override).
 *   2. Else if a thread binding exists for `agentName` (interpreted as
 *      `sessionName` for subagent invocations) → use `binding.threadId`.
 *   3. Else fall back to `agentConfig.channels[0]` (regular agent default).
 *   4. Else return undefined → caller refuses with structured error.
 *
 * The (2) path closes the Schwab AIP file-leak failure class. Without
 * it, a subagent in fin-client's thread that calls share-file with
 * its sessionName would either (a) get a "no agent found" error since
 * sessionName is not in the agent configs list, OR (b) if the LLM
 * conflated identity and passed a sibling agent's name from the shared
 * workspace, the file would land in that sibling's primary channel —
 * exactly what happened on 2026-05-06 (file landed in
 * acme-content-creator's channel `000000000000000112` instead of
 * Client A's thread `000000000000000110`). See PHASE.md sub-bug C for the
 * compliance-relevant context — in a different scenario the leaked
 * payload could be PII routed to the wrong audience.
 *
 * Pre-Phase-999.36 behavior is preserved for regular (non-subagent)
 * invocations: when no binding has `sessionName === agentName`, the
 * helper falls through to `agentConfig.channels[0]` exactly as before.
 *
 * NO I/O. The caller passes a pre-loaded `ThreadBindingRegistry` —
 * keeps this helper pure for unit tests.
 */

import type { ThreadBindingRegistry } from "../../discord/thread-types.js";
import { getBindingForSession } from "../../discord/thread-registry.js";

export function resolveShareFileChannel(
  agentName: string,
  channelIdParam: string | undefined,
  threadRegistry: ThreadBindingRegistry,
  agentConfig: { readonly channels: readonly string[] } | undefined,
): string | undefined {
  // (1) Operator override always wins.
  if (channelIdParam !== undefined) return channelIdParam;

  // (2) Subagent-thread binding lookup by sessionName. For subagents,
  // `agentName` is the LLM-supplied sessionName (e.g.
  // `fin-client-sub-OV9rkf`). For regular agents, `agentName` is
  // the agent's config name and getBindingForSession returns undefined
  // (the binding's sessionName field carries the SUBAGENT identity, not
  // the parent), so we fall through to (3) — preserving pre-Phase-999.36
  // behavior.
  const subagentBinding = getBindingForSession(threadRegistry, agentName);
  if (subagentBinding) return subagentBinding.threadId;

  // (3) Regular agent default — first configured channel. May be
  // undefined if the agent has no channels configured (caller refuses
  // with structured error).
  return agentConfig?.channels[0];
}
