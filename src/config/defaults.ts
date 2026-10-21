import { homedir } from "node:os";

/**
 * Default base path for agent workspaces.
 */
export const DEFAULT_BASE_PATH = "~/.clawcode/agents";

/**
 * Default SOUL.md content for new agents.
 * Inspired by OpenClaw's behavioral philosophy -- establishes core principles,
 * boundaries, and continuity patterns.
 */
export const DEFAULT_SOUL = `# SOUL.md - Who You Are

## Core Principles

**Be genuinely helpful.** Skip filler phrases. Actions over words.

**Have opinions.** You're allowed to disagree, prefer things, and push back when something seems wrong.

**Be resourceful.** Try to figure it out before asking. Read files, check context, search for answers.

**Earn trust through competence.** Be careful with external actions. Be bold with internal ones.

## Boundaries

- Private information stays private
- When in doubt, ask before acting externally
- Never send half-baked responses

## Continuity

Each session starts fresh. Your workspace files are your memory. Read them. Update them.

## Memory Lookup

When you call \`memory_lookup\` without setting \`scope\`, the handler searches your long-term memories first and automatically widens to conversation history (past session summaries + raw turns) if nothing matches. You can still pin a scope explicitly — \`scope="memories"\` stays in long-term knowledge only, \`scope="conversations"\` limits to past chats, \`scope="all"\` searches both — but the default does the right thing. If a lookup returns empty, trust the result; the fallback has already tried everywhere.
`;

/**
 * Default IDENTITY.md template with {{name}} placeholder.
 * The placeholder is replaced with the agent's name at workspace creation time.
 */
export const DEFAULT_IDENTITY_TEMPLATE = `# IDENTITY.md - Who Am I?

- **Name:** {{name}}
- **Role:** AI assistant
- **Vibe:** Competent, direct, helpful without being performative
`;

/**
 * Phase 999.47 D-03 (SC-5) — verbatim pointer line every agent's MEMORY.md
 * must contain so the autoload window surfaces the canonical homelab
 * inventory on every turn.
 *
 * This is a single-sourced constant — both the forward path
 * (`src/agent/workspace.ts` initial MEMORY.md write) and the operator-gated
 * backfill (`scripts/homelab/seed-memory-pointer.sh`) reference the SAME
 * string, so the two surfaces cannot drift.
 *
 * Do NOT paraphrase. The em-dash and trailing text are part of the contract
 * with the seeder script's `grep -Fxq` exact-line idempotency check.
 */
export const HOMELAB_POINTER_LINE =
  "- [Homelab inventory](/home/clawcode/homelab/INVENTORY.md) — canonical source of truth for hosts, VMs, containers, access";

/**
 * Phase 999.47 D-03 — default MEMORY.md content emitted on agent workspace
 * creation. Mirrors the layout the seeder script writes when an existing
 * agent has no MEMORY.md (`# Memory\n\n<pointer>\n`) so the two paths
 * converge on the same byte layout.
 */
export const DEFAULT_MEMORY_TEMPLATE = `# Memory

${HOMELAB_POINTER_LINE}
`;

/**
 * Replace {{name}} placeholders in a template string with the agent name.
 */
export function renderIdentity(template: string, agentName: string): string {
  return template.replaceAll("{{name}}", agentName);
}

/**
 * Expand a leading ~ in a filepath to the user's home directory.
 * Node.js fs does NOT expand ~ -- this is a shell feature.
 */
export function expandHome(filepath: string): string {
  if (filepath.startsWith("~/") || filepath === "~") {
    return filepath.replace("~", homedir());
  }
  return filepath;
}

