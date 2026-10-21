/**
 * Phase 135 Plan 03 — voice-side ACL enforcement.
 *
 * Wraps the shared `checkChannelAccess` predicate (src/security/acl-parser.ts)
 * for the voice ingress path. Same predicate as the text path — no parallel
 * authorisation route (RESEARCH § Anti-Patterns / CONTEXT.md decision:
 * "Access control: mirror text-channel allowlist + group policy").
 *
 * Plan 01 shipped this file as a pure re-export of `checkChannelAccess`.
 * Plan 03 adds `enforceVoiceChannelAcl` — the voice-bridge call site uses
 * this wrapper so the trust-boundary crossing is greppable + so a future
 * Plan 04+ adding voice-specific ACL nuances (e.g., per-channel
 * speaker-only lists) only has to change this module.
 *
 * Contract:
 *   - `securityPolicies` undefined → allow (no ACL configured = open;
 *     matches the text-path behaviour at bridge.ts:941 where the
 *     `if (this.securityPolicies)` guard short-circuits to allow).
 *   - Policy missing for this agent → allow (same reason).
 *   - `policy.channelAcls` empty → allow (no-ACL = open by default; matches
 *     the text-path behaviour where `policy.channelAcls.length > 0`
 *     gates the check).
 *   - `checkChannelAccess` returns true → allow.
 *   - `checkChannelAccess` returns false → deny + info log (silent drop;
 *     matches text-path SECR-02 "silent ignore").
 *
 * `userRoles` is always `[]` for voice — Discord voice receivers don't
 * carry role context per-utterance, and the text DM path also passes []
 * (bridge.ts:944 hard-codes `[]` for the userRoles arg).
 */
import { checkChannelAccess } from "../../security/acl-parser.js";
import type { SecurityPolicy } from "../../security/types.js";

/** Minimal log surface used by this module — narrows pino's full Logger type. */
type VoiceAclLog = {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
};

/**
 * Phase 135 REVIEW WR-03 — module-level set tracking first-fire-per-agent
 * for the "voice transcript admitted with no channel ACL" warn-once log.
 * Voice has materially higher abuse cost than text (Deepgram + ElevenLabs
 * spend), so we surface un-gated voice agents loudly the first time the
 * path is exercised. Subsequent admissions are silent to avoid log
 * spam.
 *
 * Mutability: a Set is the simplest correct primitive here — fine-grained
 * lifetime (process-scoped) and idempotent .add. Coding-style.md's
 * immutability rule applies to domain data; module-level instrumentation
 * is exempt.
 */
const NO_ACL_WARNED_AGENTS = new Set<string>();

/**
 * Decide whether a voice transcript from `voiceUserId` in `channelId` for
 * `agentName` is allowed to open an agent turn. Returns `true` to allow,
 * `false` to silently drop.
 *
 * Phase 135 Plan 03 wires this at the head of
 * `DiscordBridge.handleVoiceTranscript` (replacing Plan 02's fail-closed
 * env-gate guard + `// TODO(Plan 03)` marker — single atomic commit).
 */
export function enforceVoiceChannelAcl(
  securityPolicies: ReadonlyMap<string, SecurityPolicy> | undefined,
  agentName: string,
  channelId: string,
  voiceUserId: string,
  log: VoiceAclLog,
): boolean {
  if (!securityPolicies) {
    // Phase 135 REVIEW WR-03 — warn-once when the voice path opens for
    // an agent with no securityPolicies registered. The text path has
    // the same allow-when-undefined behaviour, but voice abuse cost
    // (Deepgram STT + ElevenLabs TTS spend) is materially higher.
    // Operators that forgot a `security:` block should see this once
    // per agent at boot time, not on every utterance.
    if (!NO_ACL_WARNED_AGENTS.has(agentName)) {
      NO_ACL_WARNED_AGENTS.add(agentName);
      log.warn(
        { agent: agentName, channel: channelId },
        "voice transcript admitted with no securityPolicies registered — open to all voice-channel members",
      );
    }
    return true;
  }
  const policy = securityPolicies.get(agentName);
  if (!policy || policy.channelAcls.length === 0) {
    // Phase 135 REVIEW WR-03 — same warn-once treatment when policy is
    // missing-for-this-agent or has zero channel ACLs.
    if (!NO_ACL_WARNED_AGENTS.has(agentName)) {
      NO_ACL_WARNED_AGENTS.add(agentName);
      log.warn(
        { agent: agentName, channel: channelId },
        "voice transcript admitted with no channel ACL — open to all voice-channel members",
      );
    }
    return true;
  }
  const allowed = checkChannelAccess(channelId, voiceUserId, [], policy.channelAcls);
  if (!allowed) {
    log.info(
      { agent: agentName, user: voiceUserId, channel: channelId },
      "voice transcript blocked by channel ACL",
    );
    return false;
  }
  return true;
}

/**
 * Phase 135.1 — non-logging ACL predicate for the barge-in speaking-start tap.
 *
 * Same policy resolution as {@link enforceVoiceChannelAcl} but SILENT: the
 * speaking-start event fires on every burst of user audio (many times per
 * utterance), so a deny here must not spam logs or trip the warn-once
 * instrumentation. The authoritative, logged gate still runs at
 * final-transcript dispatch (enforceVoiceChannelAcl), so an unauthorized
 * speaker is denied a turn there regardless; this predicate only decides
 * whether their speech may *interrupt* the agent.
 */
export function isVoiceUserAllowed(
  securityPolicies: ReadonlyMap<string, SecurityPolicy> | undefined,
  agentName: string,
  channelId: string,
  voiceUserId: string,
): boolean {
  if (!securityPolicies) return true;
  const policy = securityPolicies.get(agentName);
  if (!policy || policy.channelAcls.length === 0) return true;
  return checkChannelAccess(channelId, voiceUserId, [], policy.channelAcls);
}

/**
 * Phase 135 REVIEW WR-03 — test-only reset of the warn-once-per-agent
 * set. Production code does not call this; tests use it between cases
 * so each `enforceVoiceChannelAcl` call sees a clean instrumentation
 * state. Exported via the `__test` namespace so the production import
 * surface stays clean.
 */
export const __test = {
  resetNoAclWarnedAgents(): void {
    NO_ACL_WARNED_AGENTS.clear();
  },
};

/**
 * Plan 01 re-export — preserved for any module that imports
 * `checkChannelAccess` from this voice-side facade rather than the
 * security module directly. Same predicate, same signature.
 */
export { checkChannelAccess } from "../../security/acl-parser.js";
