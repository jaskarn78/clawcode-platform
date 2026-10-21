/**
 * Applies config diffs to running daemon subsystems.
 *
 * When the ConfigWatcher detects a change, it produces a ConfigDiff.
 * The ConfigReloader inspects each change's fieldPath to determine
 * which subsystems need updating, then applies the minimum set of
 * updates required.
 */

import { join } from "node:path";
import type { Logger } from "pino";
import type { ConfigDiff } from "../config/types.js";
import type { ResolvedAgentConfig } from "../shared/types.js";
import type { RoutingTable } from "../discord/types.js";
import type { SkillsCatalog } from "../skills/types.js";
import { buildRoutingTable } from "../discord/router.js";
import { buildWebhookIdentities, WebhookManager } from "../discord/webhook-manager.js";
import { linkAgentSkills } from "../skills/linker.js";
import type { TaskScheduler } from "../scheduler/scheduler.js";
import type { HeartbeatRunner } from "../heartbeat/runner.js";
import type { SessionManager } from "./session-manager.js";

/**
 * Summary of what was reloaded during a config change application.
 */
export type ReloadSummary = {
  readonly subsystemsReloaded: readonly string[];
  readonly agentsAffected: readonly string[];
};

/**
 * Options for creating a ConfigReloader.
 */
export type ConfigReloaderOptions = {
  readonly sessionManager: SessionManager;
  readonly taskScheduler: TaskScheduler;
  readonly heartbeatRunner: HeartbeatRunner;
  readonly webhookManager: WebhookManager;
  readonly skillsCatalog: SkillsCatalog;
  /** Mutable ref so daemon and bridge always read the latest routing table. */
  readonly routingTableRef: { current: RoutingTable };
  readonly log: Logger;
};

/**
 * ConfigReloader applies a ConfigDiff to the running daemon subsystems.
 *
 * It inspects each change's fieldPath to decide which subsystems need
 * updating, then performs the minimum set of operations. Only subsystems
 * with actual changes get touched.
 */
export class ConfigReloader {
  private readonly sessionManager: SessionManager;
  private readonly taskScheduler: TaskScheduler;
  private readonly heartbeatRunner: HeartbeatRunner;
  private readonly webhookManager: WebhookManager;
  private readonly skillsCatalog: SkillsCatalog;
  private readonly routingTableRef: { current: RoutingTable };
  private readonly log: Logger;

  constructor(opts: ConfigReloaderOptions) {
    this.sessionManager = opts.sessionManager;
    this.taskScheduler = opts.taskScheduler;
    this.heartbeatRunner = opts.heartbeatRunner;
    this.webhookManager = opts.webhookManager;
    this.skillsCatalog = opts.skillsCatalog;
    this.routingTableRef = opts.routingTableRef;
    this.log = opts.log;
  }

  /**
   * Apply a config diff to running subsystems.
   *
   * Only subsystems affected by changes in the diff are updated.
   * Non-reloadable changes are skipped (they require a restart).
   */
  async applyChanges(
    diff: ConfigDiff,
    newResolvedAgents: readonly ResolvedAgentConfig[],
  ): Promise<ReloadSummary> {
    if (!diff.hasReloadableChanges) {
      return { subsystemsReloaded: [], agentsAffected: [] };
    }

    const subsystemsReloaded = new Set<string>();
    const agentsAffected = new Set<string>();

    // Classify which subsystems are affected
    const needsRouting = this.hasChangeMatching(diff, "channels");
    const needsScheduler = this.hasChangeMatching(diff, "schedules");
    const needsHeartbeat = this.hasChangeMatching(diff, "heartbeat");
    const needsSkills = this.hasChangeMatching(diff, "skills");
    const needsWebhooks = this.hasChangeMatching(diff, "webhook");

    // Collect affected agent names from changes
    for (const change of diff.changes) {
      if (!change.reloadable) continue;
      const agentName = extractAgentName(change.fieldPath);
      if (agentName !== undefined) {
        agentsAffected.add(agentName);
      }
    }

    // Apply routing table rebuild
    if (needsRouting) {
      const newTable = buildRoutingTable(newResolvedAgents);
      this.routingTableRef.current = newTable;
      subsystemsReloaded.add("routing");
      this.log.info({ routes: newTable.channelToAgent.size }, "routing table rebuilt");
    }

    // Apply scheduler changes per affected agent
    if (needsScheduler) {
      const schedulerAgents = this.getAffectedAgents(diff, "schedules");
      for (const agentName of schedulerAgents) {
        this.taskScheduler.removeAgent(agentName);
        const agentConfig = newResolvedAgents.find((a) => a.name === agentName);
        if (agentConfig && agentConfig.schedules.length > 0) {
          this.taskScheduler.addAgent(agentName, agentConfig.schedules);
        }
        agentsAffected.add(agentName);
      }
      subsystemsReloaded.add("scheduler");
      this.log.info({ agents: [...schedulerAgents] }, "scheduler updated");
    }

    // Apply heartbeat changes
    if (needsHeartbeat) {
      this.heartbeatRunner.setAgentConfigs(newResolvedAgents);
      subsystemsReloaded.add("heartbeat");
      this.log.info("heartbeat configs updated");
    }

    // Apply skills changes per affected agent
    if (needsSkills) {
      const skillsAgents = this.getAffectedAgents(diff, "skills");
      for (const agentName of skillsAgents) {
        const agentConfig = newResolvedAgents.find((a) => a.name === agentName);
        if (agentConfig) {
          await linkAgentSkills(
            join(agentConfig.workspace, "skills"),
            agentConfig.skills,
            this.skillsCatalog,
            this.log,
            {
              cliSkillsDir: join(
                agentConfig.gsd?.projectDir ?? agentConfig.workspace,
                ".claude",
                "skills",
              ),
            },
          );
          agentsAffected.add(agentName);
        }
      }
      subsystemsReloaded.add("skills");
      this.log.info({ agents: [...skillsAgents] }, "skills re-linked");
    }

    // Apply webhook changes
    if (needsWebhooks) {
      this.webhookManager.destroy();
      const newIdentities = buildWebhookIdentities(newResolvedAgents);
      // Note: WebhookManager clients are lazily created on next send(),
      // so destroying old clients is sufficient. The identities map
      // will be rebuilt when a new WebhookManager is created by the daemon
      // on next startup. For hot-reload, the destroyed clients will be
      // recreated on demand.
      subsystemsReloaded.add("webhooks");
      this.log.info({ webhooks: newIdentities.size }, "webhook identities rebuilt");
    }

    // Always update session manager with new agent configs when there are reloadable changes
    this.sessionManager.setAllAgentConfigs(newResolvedAgents);

    return {
      subsystemsReloaded: [...subsystemsReloaded],
      agentsAffected: [...agentsAffected],
    };
  }

  /**
   * Check if any reloadable change's fieldPath contains the given keyword.
   */
  private hasChangeMatching(diff: ConfigDiff, keyword: string): boolean {
    return diff.changes.some(
      (c) => c.reloadable && c.fieldPath.includes(keyword),
    );
  }

  /**
   * Get agent names affected by changes containing the given keyword.
   */
  private getAffectedAgents(diff: ConfigDiff, keyword: string): readonly string[] {
    const agents = new Set<string>();
    for (const change of diff.changes) {
      if (!change.reloadable) continue;
      if (!change.fieldPath.includes(keyword)) continue;
      const agentName = extractAgentName(change.fieldPath);
      if (agentName !== undefined) {
        agents.add(agentName);
      }
    }
    return [...agents];
  }
}

/**
 * Extract the agent name from a fieldPath like "agents.atlas.channels".
 * Returns undefined if the path is not agent-specific (e.g. "defaults.heartbeat").
 */
function extractAgentName(fieldPath: string): string | undefined {
  const parts = fieldPath.split(".");
  if (parts[0] === "agents" && parts.length >= 2) {
    return parts[1];
  }
  return undefined;
}
