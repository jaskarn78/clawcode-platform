import { nanoid } from "nanoid";
import type { ResolvedAgentConfig } from "../shared/types.js";

/**
 * Options for forking an agent session.
 */
export type ForkOptions = {
  readonly systemPromptOverride?: string;
  readonly modelOverride?: "sonnet" | "opus" | "haiku";
};

/**
 * Result of a session fork operation.
 */
export type ForkResult = {
  readonly forkName: string;
  readonly parentAgent: string;
  readonly sessionId: string;
};

/**
 * Build a unique name for a forked session.
 * Format: {agentName}-fork-{nanoid6}
 */
export function buildForkName(agentName: string): string {
  return `${agentName}-fork-${nanoid(6)}`;
}

/** Matches the suffix appended by {@link buildForkName}. */
const FORK_SUFFIX_RE = /-fork-[A-Za-z0-9_-]{6}$/;

/**
 * The owning agent behind a session name — `fin-client-fork-iotYXl` →
 * `fin-client`; a non-fork name is returned unchanged.
 *
 * 2026-08-27: a forked session carries the FORK name in `CLAWCODE_AGENT`, so
 * every identity-scoped IPC arm that looks something up per agent (trace
 * collector, active turn, evidence) misses — the collector is only ever
 * registered under the base name. That silently dropped every `verify_claim`
 * made from a fork ("no active turn to attach this claim to"), which is how
 * a fully-sourced turn still delivered with a bare unverified marker.
 */
export function baseAgentName(sessionName: string): string {
  return sessionName.replace(FORK_SUFFIX_RE, "");
}

/**
 * Build the config for a forked session from the parent agent's config.
 * The fork inherits the parent config but:
 * - Gets a new unique name
 * - Has no channel bindings (headless)
 * - Can override system prompt and model
 * - Includes a fork context section in the soul
 *
 * Returns a new object -- never mutates the parent config.
 */
export function buildForkConfig(
  parentConfig: ResolvedAgentConfig,
  forkName: string,
  options?: ForkOptions,
): ResolvedAgentConfig {
  const forkContext = [
    "\n\n## Fork Context",
    `This session was forked from agent "${parentConfig.name}".`,
    `Fork name: ${forkName}`,
    "You have inherited the parent agent's context up to this point.",
    "You are now operating independently.",
    // 2026-08-27 — a fork IS the advisor mechanism (defaults.advisor.backend:
    // fork), so `ask_advisor` is refused inside one. The refusal was only ever
    // discovered by CALLING it: the model burned a tool round-trip and the
    // refusal text landed in the transcript, which the operator saw as a
    // failure. Say it up front instead. (The tool cannot be unregistered
    // per-session: the MCP server has no per-agent identity at startup — see
    // CLAUDE.md, "Architectural deferral — MCP ask_advisor tool gating".)
    "Do NOT call the `ask_advisor` tool in this session: a forked session is " +
      "itself the advisor mechanism, so the call is refused. Reason it out here.",
  ].join("\n");

  return {
    ...parentConfig,
    name: forkName,
    channels: [], // Forked sessions are headless -- no Discord bindings
    soul: (options?.systemPromptOverride ?? parentConfig.soul ?? "") + forkContext,
    model: options?.modelOverride ?? parentConfig.model,
    schedules: [], // Forked sessions don't inherit scheduled tasks
    slashCommands: [], // No slash commands for forks
    // Phase 83 Plan 02 EFFORT-06 — fork quarantine.
    //
    // buildForkConfig takes the PARENT'S ResolvedAgentConfig, not the
    // parent's live SessionHandle. The parent's runtime override
    // (setEffort called via /clawcode-effort) is NOT visible here by
    // design — ResolvedAgentConfig carries only the config default.
    // The explicit assignment below pins this invariant: any refactor
    // that accidentally threads runtime state into fork config will
    // need to delete this line, at which point fork-effort-quarantine.test.ts
    // fires RED. PITFALLS.md §Pitfall 3 (fork inheritance cost spike).
    // Quick 260715-j1j (D9) — ultracode → xhigh clamp: forks are headless
    // (no channel, no operator) and must never inherit the native-Workflow
    // orchestration mode; they keep the equivalent thinking budget only.
    effort: parentConfig.effort === "ultracode" ? "xhigh" : parentConfig.effort,
    // Quick 260715-j1j review CR-03 — native-Workflow TOOL quarantine. The
    // effort clamp above removes only the orchestration MODE; an opted-in
    // parent's resolved disallowedTools had "Workflow" SUBTRACTED (D5), so a
    // plain spread would hand the fork live native-Workflow tool access — the
    // exact July-14 stall-kill exposure the fleet block exists to prevent,
    // on a headless session where every stall notice is invisible. Union
    // "Workflow" back in (immutable new array; Set dedupes when the parent
    // never opted in / the floor already carries it) and drop the inherited
    // opt-in flag so the steer conditionals stay fail-closed too.
    nativeWorkflow: false,
    disallowedTools: Array.from(
      new Set([...(parentConfig.disallowedTools ?? []), "Workflow"]),
    ),
  };
}
