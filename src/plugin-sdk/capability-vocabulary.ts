/**
 * Phase 130 — closed capability vocabulary for skill + MCP-tool manifests.
 *
 * Each capability maps to an operator-observable risk surface. Operators
 * grep `capabilities: ["filesystem"]` in SKILL.md to understand the skill's
 * blast radius before authorising it on a fleet agent.
 *
 * This vocabulary is INTENTIONALLY closed (Zod `z.enum`). Adding a new
 * capability requires a deliberate code change here + a docs update —
 * exactly the friction we want when expanding the trust surface.
 *
 * See `.planning/phases/130-manifest-driven-plugin-sdk/130-CONTEXT.md` D-04.
 */
export const CAPABILITY_VOCABULARY = [
  "filesystem",            // read/write files outside the agent workspace
  "network",               // arbitrary HTTP(S) egress
  "llm-call",              // additional Anthropic API calls beyond the agent turn
  "discord-post",          // send messages via webhook
  "discord-read",          // read Discord channel messages
  "cross-agent-delegate",  // post_to_agent or spawn_subagent_thread
  "subagent-spawn",        // delegate_task / spawn_subagent_thread (in-agent)
  "memory-write",          // memory.db writes
  "memory-read",           // memory.db reads
  "secret-access",         // 1Password / op:// secret resolution
  "mcp-tool-use",          // calls MCP tools beyond the agent's normal set
  "schedule-cron",         // creates cron entries
  "config-mutate",         // edits clawcode.yaml
] as const;

export type Capability = (typeof CAPABILITY_VOCABULARY)[number];
