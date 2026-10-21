/**
 * Phase 130 Plan 03 T-01 — boot-time Discord notification for refused skills.
 *
 * One batched webhook message per agent when `unloadedSkillsByAgent` has any
 * entries. Fire-and-forget per Phase 89 canary precedent — webhook failures
 * are logged via `.catch(...)` but never block boot.
 *
 * Format (single line):
 *   ⚠️ unloaded skills: <name> (missing MCP: <mcp1>, <mcp2>), <name2> (manifest parse error)
 *
 * One Discord message per agent. Skills without webhook identities skip
 * silently (no error log — webhook identity is a deploy-time choice).
 *
 * Per `feedback_silent_path_bifurcation.md`: this is the ONLY emitter of
 * the unloaded-skills Discord notification. The CLI surface (Plan 03 T-02)
 * renders the same data via stdout, not Discord — no duplication.
 */
import type { Logger } from "pino";
import type { WebhookManager } from "../discord/webhook-manager.js";
import type { UnloadedSkillEntry } from "./skill-loader.js";

/**
 * Format one agent's unloaded-skills array into a single Discord message line.
 * Pure — no side effects. Exported for test access.
 */
export function formatUnloadedSkillsMessage(
  unloaded: readonly UnloadedSkillEntry[],
): string {
  const parts = unloaded.map((s) => {
    if (s.status === "refused-mcp-missing") {
      const list = (s.missingMcp ?? []).join(", ");
      return `${s.name} (missing MCP: ${list})`;
    }
    if (s.status === "parse-error") {
      return `${s.name} (manifest parse error)`;
    }
    // Future statuses get a generic fallback; current taxonomy is exhaustive
    // but keeping the default branch defends against schema drift.
    return s.name;
  });
  return `⚠️ unloaded skills: ${parts.join(", ")}`;
}

/**
 * Emit a boot-time Discord notification per agent with non-empty
 * unloaded-skills entries. Fire-and-forget — does NOT block on webhook
 * delivery. Webhook failures land in the optional pino logger (warn level)
 * with structured fields `{agent, err}`; fall back to console.warn when
 * no logger is supplied (test paths).
 *
 * Returns nothing — the function is intentionally side-effectful and
 * resolves before any of the spawned `webhookManager.send` promises do.
 * Callers should not await it.
 */
export function notifyUnloadedSkills(deps: {
  readonly unloadedSkillsByAgent: ReadonlyMap<string, readonly UnloadedSkillEntry[]>;
  readonly webhookManager: WebhookManager;
  readonly log?: Logger;
}): void {
  for (const [agentName, unloaded] of deps.unloadedSkillsByAgent.entries()) {
    if (unloaded.length === 0) continue;
    if (!deps.webhookManager.hasWebhook(agentName)) {
      // No webhook configured for this agent — emit a structured log instead
      // so operators still see the refusal at boot.
      // eslint-disable-next-line no-console
      console.warn(
        "phase130-skill-load-notify-skipped",
        JSON.stringify({
          agent: agentName,
          reason: "no webhook configured",
          unloaded: unloaded.map((s) => s.name),
        }),
      );
      continue;
    }
    const message = formatUnloadedSkillsMessage(unloaded);
    // Fire-and-forget per Phase 89 canary precedent. The `.catch` handler
    // is the only error sink — boot continues regardless.
    deps.webhookManager.send(agentName, message).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (deps.log !== undefined) {
        deps.log.warn(
          { agent: agentName, err: msg },
          "phase130 unloaded-skills Discord notification failed",
        );
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          "phase130-skill-load-notify-failed",
          JSON.stringify({ agent: agentName, err: msg }),
        );
      }
    });
  }
}
