import type { Command } from "commander";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { ManagerNotRunningError } from "../../shared/errors.js";
import { cliLog, cliError } from "../output.js";

/**
 * A single webhook entry from the IPC response.
 */
type WebhookEntry = {
  readonly agent: string;
  readonly displayName: string;
  readonly avatarUrl?: string;
  readonly hasWebhookUrl: boolean;
  /**
   * 2026-09-03 — identity usable ONLY for agent-to-agent embeds. Auto-
   * provisioned for agents with no `webhook:` block; ordinary replies from
   * those agents stay on the bot. Absent from a pre-2026-09-03 daemon.
   */
  readonly a2aOnly?: boolean;
  readonly source?: "config" | "auto-provisioned";
};

/**
 * Shape of the "webhooks" IPC response.
 */
type WebhooksResponse = {
  readonly webhooks: readonly WebhookEntry[];
};

/**
 * Format webhooks IPC response as a table.
 *
 * @param data - The webhooks IPC response
 * @returns Formatted table string
 */
export function formatWebhooksTable(data: WebhooksResponse): string {
  if (data.webhooks.length === 0) {
    return "No webhook identities configured";
  }

  type Row = {
    readonly agent: string;
    readonly displayName: string;
    readonly avatar: string;
    readonly status: string;
  };

  const rows: readonly Row[] = data.webhooks.map((entry) => ({
    agent: entry.agent,
    displayName: entry.displayName,
    avatar: entry.avatarUrl ? "yes" : "no",
    // "a2a-only" is the load-bearing distinction: the identity exists, but
    // only agent-to-agent embeds may wear it. Reporting it as plain "active"
    // would imply the agent's ordinary replies come from it too.
    status: !entry.hasWebhookUrl
      ? "no url"
      : entry.a2aOnly === true
        ? "a2a-only"
        : "active",
  }));

  const agentWidth = Math.max(5, ...rows.map((r) => r.agent.length));
  const nameWidth = Math.max(12, ...rows.map((r) => r.displayName.length));
  const avatarWidth = 6;
  const statusWidth = 6;

  const header = [
    "AGENT".padEnd(agentWidth),
    "DISPLAY NAME".padEnd(nameWidth),
    "AVATAR".padEnd(avatarWidth),
    "STATUS".padEnd(statusWidth),
  ].join("  ");

  const separator = "-".repeat(agentWidth + nameWidth + avatarWidth + statusWidth + 6);

  const formattedRows = rows.map((row) =>
    [
      row.agent.padEnd(agentWidth),
      row.displayName.padEnd(nameWidth),
      row.avatar.padEnd(avatarWidth),
      row.status.padEnd(statusWidth),
    ].join("  "),
  );

  return ["Webhook Identities", "", header, separator, ...formattedRows].join("\n");
}

/**
 * Register the `clawcode webhooks` command.
 * Sends a "webhooks" IPC request and displays a formatted table.
 */
export function registerWebhooksCommand(program: Command): void {
  program
    .command("webhooks")
    .description("Show configured webhook identities")
    .action(async () => {
      try {
        const result = (await sendIpcRequest(
          SOCKET_PATH,
          "webhooks",
          {},
        )) as WebhooksResponse;
        cliLog(formatWebhooksTable(result));
      } catch (error) {
        if (error instanceof ManagerNotRunningError) {
          cliError(
            "Manager is not running. Start it with: clawcode start-all",
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
