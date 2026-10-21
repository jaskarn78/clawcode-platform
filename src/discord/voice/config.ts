/**
 * Phase 135 Plan 01 — per-agent voice-block resolver.
 *
 * Returns the resolved `voice:` block for an agent name, or null if the
 * agent has no voice config (voice is opt-in per CONTEXT.md decisions:
 * "missing block = no voice for that agent").
 *
 * Plan 02 will widen this to apply hardcoded baselines for omitted
 * optional fields (e.g., model defaults). Plan 01 ships the bare
 * lookup — the schema layer already gates required fields, so a
 * present block is always usable as-is.
 *
 * The `agents` parameter is intentionally typed loose (`AgentWithVoice[]`)
 * so this file doesn't pull the full `Config` type circular-dependency
 * graph. Plan 02 may tighten this to `ResolvedAgentConfig` once the
 * loader resolver layer is plumbed.
 */
import type { VoiceConfigShape } from "./session.js";

/** Minimum shape this file needs from an agent record. */
export type AgentWithVoice = {
  readonly name: string;
  readonly voice?: VoiceConfigShape;
  /**
   * Phase 135 Plan 03 — the resolved agent's memory directory. Used by
   * the manager to construct the per-agent `MinutesTracker` (which
   * persists `voice-minutes.json` under this path). Optional in the
   * type because Plan 01's fixtures use partial agent objects; the
   * loader-produced `ResolvedAgentConfig` always populates it.
   */
  readonly memoryPath?: string;
};

/**
 * Look up the voice config for `agentName`. Returns the agent's voice
 * block verbatim, or null if the agent is unknown or has no voice
 * block.
 */
export function getVoiceCfg(
  agents: readonly AgentWithVoice[],
  agentName: string,
): VoiceConfigShape | null {
  const agent = agents.find((a) => a.name === agentName);
  if (!agent || !agent.voice) return null;
  return agent.voice;
}
