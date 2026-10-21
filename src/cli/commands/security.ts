import type { Command } from "commander";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { ManagerNotRunningError } from "../../shared/errors.js";
import { cliLog, cliError } from "../output.js";

/**
 * Shape of the security-status IPC response.
 */
export type SecurityStatusResponse = {
  readonly agents: Record<
    string,
    {
      readonly allowlistPatterns: readonly string[];
      readonly allowAlwaysPatterns: readonly string[];
      readonly channelAcls: readonly {
        readonly channelId: string;
        readonly allowedUserIds: readonly string[];
        readonly allowedRoles: readonly string[];
      }[];
    }
  >;
};

/**
 * Format security status data as human-readable output.
 *
 * @param data - The security-status IPC response
 * @returns Formatted output string
 */
export function formatSecurityOutput(data: SecurityStatusResponse): string {
  const agentNames = Object.keys(data.agents);

  if (agentNames.length === 0) {
    return "Security Status\n\nNo security configuration found";
  }

  const lines: string[] = ["Security Status", ""];

  for (const name of agentNames) {
    const agent = data.agents[name];
    lines.push(`Agent: ${name}`);

    // Allowlist patterns
    lines.push("  Allowlist patterns:");
    if (agent.allowlistPatterns.length === 0) {
      lines.push("    (none)");
    } else {
      for (const pattern of agent.allowlistPatterns) {
        lines.push(`    - ${pattern}`);
      }
    }

    // Allow-always patterns
    lines.push("  Allow-always patterns:");
    if (agent.allowAlwaysPatterns.length === 0) {
      lines.push("    (none)");
    } else {
      for (const pattern of agent.allowAlwaysPatterns) {
        lines.push(`    - ${pattern}`);
      }
    }

    // Channel ACLs
    lines.push("  Channel ACLs:");
    if (agent.channelAcls.length === 0) {
      lines.push("    (none)");
    } else {
      for (const acl of agent.channelAcls) {
        const users = acl.allowedUserIds.length > 0 ? acl.allowedUserIds.join(", ") : "none";
        const roles = acl.allowedRoles.length > 0 ? acl.allowedRoles.join(", ") : "none";
        lines.push(`    - Channel ${acl.channelId}: users=[${users}], roles=[${roles}]`);
      }
    }

    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Register the `clawcode security` command.
 * Sends a "security-status" IPC request and displays formatted results.
 */
export function registerSecurityCommand(program: Command): void {
  program
    .command("security")
    .description("Show security status (allowlists, ACLs, approval patterns)")
    .option("--agent <name>", "Filter to a specific agent")
    .action(async (opts: { agent?: string }) => {
      try {
        const params: Record<string, unknown> = {};
        if (opts.agent) {
          params.agent = opts.agent;
        }
        const result = (await sendIpcRequest(
          SOCKET_PATH,
          "security-status",
          params,
        )) as SecurityStatusResponse;
        cliLog(formatSecurityOutput(result));
      } catch (error) {
        if (error instanceof ManagerNotRunningError) {
          cliError(
            "Manager is not running. Start it with: clawcode start-all",
          );
          process.exit(1);
          return;
        }
        const msg = error instanceof Error ? error.message : String(error);
        cliError(`Error: ${msg}`);
        process.exit(1);
      }
    });
}
