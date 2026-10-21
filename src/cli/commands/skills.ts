import type { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { ManagerNotRunningError } from "../../shared/errors.js";
import { cliLog, cliError } from "../output.js";
import {
  loadSkillManifest,
  type LoadSkillManifestResult,
} from "../../manager/skill-loader.js";

/**
 * A single skill catalog entry from the IPC response.
 */
type SkillCatalogEntry = {
  readonly name: string;
  readonly description: string;
  readonly version: string | null;
  readonly path: string;
};

/**
 * Phase 130 Plan 03 T-02 — refused-skill record shape (matches
 * UnloadedSkillEntry in src/manager/skill-loader.ts, mirrored here so the
 * CLI doesn't pull a manager-side import in pure-IPC mode).
 */
type UnloadedSkillRecord = {
  readonly name: string;
  readonly status: "refused-mcp-missing" | "parse-error";
  readonly reason?: string;
  readonly missingMcp?: readonly string[];
};

/**
 * Shape of the "skills" IPC response.
 */
type SkillsResponse = {
  readonly catalog: readonly SkillCatalogEntry[];
  readonly assignments: Record<string, readonly string[]>;
  /** Phase 130 Plan 03 T-02 — per-agent refused skills (Map → plain object on wire). */
  readonly unloadedSkills?: Record<string, readonly UnloadedSkillRecord[]>;
};

/**
 * Truncate a string to maxLen characters, appending "..." if truncated.
 */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) {
    return text;
  }
  return text.slice(0, maxLen) + "...";
}

/**
 * Format skills IPC response as a table.
 * Columns: SKILL, VERSION, DESCRIPTION, AGENTS
 *
 * @param data - The skills IPC response
 * @returns Formatted table string
 */
export function formatSkillsTable(data: SkillsResponse): string {
  if (data.catalog.length === 0) {
    return "No skills registered";
  }

  // Build row data
  type Row = {
    readonly skill: string;
    readonly version: string;
    readonly description: string;
    readonly agents: string;
  };

  const rows: readonly Row[] = data.catalog.map((entry) => {
    // Find agents that have this skill assigned
    const assignedAgents: string[] = [];
    for (const [agentName, skills] of Object.entries(data.assignments)) {
      if (skills.includes(entry.name)) {
        assignedAgents.push(agentName);
      }
    }

    return {
      skill: entry.name,
      version: entry.version ?? "-",
      description: truncate(entry.description, 50),
      agents: assignedAgents.length > 0 ? assignedAgents.join(", ") : "-",
    };
  });

  // Calculate column widths dynamically
  const skillWidth = Math.max(5, ...rows.map((r) => r.skill.length));
  const versionWidth = Math.max(7, ...rows.map((r) => r.version.length));
  const descWidth = Math.max(11, ...rows.map((r) => r.description.length));
  const agentsWidth = Math.max(6, ...rows.map((r) => r.agents.length));

  // Header
  const header = [
    "SKILL".padEnd(skillWidth),
    "VERSION".padEnd(versionWidth),
    "DESCRIPTION".padEnd(descWidth),
    "AGENTS".padEnd(agentsWidth),
  ].join("  ");

  const separator = "-".repeat(
    skillWidth + versionWidth + descWidth + agentsWidth + 6,
  );

  // Format rows
  const formattedRows = rows.map((row) =>
    [
      row.skill.padEnd(skillWidth),
      row.version.padEnd(versionWidth),
      row.description.padEnd(descWidth),
      row.agents.padEnd(agentsWidth),
    ].join("  "),
  );

  return [header, separator, ...formattedRows].join("\n");
}

/**
 * Phase 130 Plan 03 T-02 — emoji + label for per-skill status.
 */
const STATUS_DISPLAY: Record<
  "loaded" | "refused-mcp-missing" | "manifest-missing" | "parse-error",
  { emoji: string; label: string }
> = {
  loaded: { emoji: "✅", label: "loaded" },
  "refused-mcp-missing": { emoji: "⛔", label: "refused-mcp-missing" },
  "manifest-missing": { emoji: "⚠️", label: "manifest-missing" },
  "parse-error": { emoji: "❌", label: "parse-error" },
};

/**
 * Phase 130 Plan 03 T-02 — render the per-agent skills table.
 *
 * Format (one row per skill):
 *   ✅ skill-name [loaded]
 *   ⛔ broken-skill [refused-mcp-missing: 1password]
 *   ⚠️ legacy-skill [manifest-missing]
 *   ❌ malformed-skill [parse-error: <reason>]
 *
 * Exported for test access.
 */
export function formatAgentSkillsStatus(
  agentName: string,
  assignedSkills: readonly string[],
  unloaded: readonly UnloadedSkillRecord[],
): string {
  // eslint-disable-next-line no-console
  console.info(
    "phase130-cli-skills-status",
    JSON.stringify({ agent: agentName, assigned: assignedSkills.length, unloaded: unloaded.length }),
  );

  if (assignedSkills.length === 0) {
    return `Agent ${agentName}: no skills assigned`;
  }
  const unloadedByName = new Map(unloaded.map((u) => [u.name, u]));
  const lines: string[] = [`Agent ${agentName}:`];
  for (const skill of assignedSkills) {
    const u = unloadedByName.get(skill);
    if (u === undefined) {
      lines.push(`  ${STATUS_DISPLAY.loaded.emoji} ${skill} [${STATUS_DISPLAY.loaded.label}]`);
      continue;
    }
    const display = STATUS_DISPLAY[u.status];
    let detail = display.label;
    if (u.status === "refused-mcp-missing" && u.missingMcp && u.missingMcp.length > 0) {
      detail = `${display.label}: ${u.missingMcp.join(", ")}`;
    } else if (u.status === "parse-error" && u.reason !== undefined) {
      detail = `${display.label}: ${u.reason}`;
    }
    lines.push(`  ${display.emoji} ${skill} [${detail}]`);
  }
  return lines.join("\n");
}

/**
 * Phase 130 Plan 03 T-02 — `--validate` pre-flight runs the SAME chokepoint
 * (`loadSkillManifest`) directly against the filesystem WITHOUT IPC, so it
 * works pre-deploy (manager not yet running). Returns a per-skill status
 * line in the same shape as `formatAgentSkillsStatus`.
 *
 * Exported for test access.
 */
export function validateAgentSkills(args: {
  readonly agentName: string;
  readonly skillsRoot: string;
  readonly assignedSkills: readonly string[];
  readonly enabledMcpServers: readonly string[];
}): string {
  // eslint-disable-next-line no-console
  console.info(
    "phase130-cli-skills-status",
    JSON.stringify({
      agent: args.agentName,
      validate: true,
      assigned: args.assignedSkills.length,
    }),
  );

  if (args.assignedSkills.length === 0) {
    return `Agent ${args.agentName}: no skills assigned (validate mode)`;
  }
  const lines: string[] = [`Agent ${args.agentName} (validate mode):`];
  for (const skill of args.assignedSkills) {
    const skillDir = path.join(args.skillsRoot, skill);
    if (!fs.existsSync(skillDir)) {
      lines.push(`  ❓ ${skill} [missing-directory: ${skillDir}]`);
      continue;
    }
    const result: LoadSkillManifestResult = loadSkillManifest(
      skillDir,
      args.enabledMcpServers,
    );
    const display = STATUS_DISPLAY[result.status];
    let detail = display.label;
    if (result.status === "refused-mcp-missing") {
      detail = `${display.label}: ${result.missingMcp.join(", ")}`;
    } else if (result.status === "parse-error") {
      detail = `${display.label}: ${result.reason}`;
    }
    lines.push(`  ${display.emoji} ${skill} [${detail}]`);
  }
  return lines.join("\n");
}

/**
 * Register the `clawcode skills` command.
 *
 * - `clawcode skills` (no args) — legacy fleet-wide catalog table.
 * - `clawcode skills <agent>` — Phase 130 Plan 03 T-02 per-agent status table.
 * - `clawcode skills <agent> --validate` — pre-flight validate without IPC.
 */
export function registerSkillsCommand(program: Command): void {
  program
    .command("skills [agent]")
    .description("Show skills (fleet-wide table) OR per-agent status (with optional --validate)")
    .option("--validate", "Pre-flight validate manifests without affecting agent state")
    .option(
      "--skills-root <path>",
      "Override skills root directory (used by --validate)",
      path.join(os.homedir(), ".clawcode", "skills"),
    )
    .action(async (agent: string | undefined, opts: { validate?: boolean; skillsRoot: string }) => {
      try {
        if (agent === undefined) {
          // Legacy fleet-wide table.
          const result = (await sendIpcRequest(
            SOCKET_PATH,
            "skills",
            {},
          )) as SkillsResponse;
          cliLog(formatSkillsTable(result));
          return;
        }

        // --validate is filesystem-only (no IPC). Useful pre-deploy.
        if (opts.validate === true) {
          // Best-effort: ask IPC for the agent's skill list + enabled MCP
          // servers; fall back to empty arrays if the manager isn't up.
          let assignedSkills: readonly string[] = [];
          const enabledMcp: readonly string[] = [];
          try {
            const r = (await sendIpcRequest(SOCKET_PATH, "skills", { agent })) as SkillsResponse;
            assignedSkills = r.assignments[agent] ?? [];
          } catch (e) {
            if (!(e instanceof ManagerNotRunningError)) throw e;
          }
          cliLog(
            validateAgentSkills({
              agentName: agent,
              skillsRoot: opts.skillsRoot,
              assignedSkills,
              enabledMcpServers: enabledMcp,
            }),
          );
          return;
        }

        // Per-agent live status (consumes Plan 02's unloadedSkills map).
        const result = (await sendIpcRequest(
          SOCKET_PATH,
          "skills",
          { agent },
        )) as SkillsResponse;
        const assigned = result.assignments[agent] ?? [];
        const unloaded = result.unloadedSkills?.[agent] ?? [];
        cliLog(formatAgentSkillsStatus(agent, assigned, unloaded));
      } catch (error) {
        if (error instanceof ManagerNotRunningError) {
          cliError(
            "Manager is not running. Start it with: clawcode start-all (or use --validate for filesystem-only check)",
          );
          process.exit(1);
          return;
        }
        const message =
          error instanceof Error ? error.message : String(error);
        cliError(`Error: ${message}`);
        process.exit(1);
      }
    });
}
