import type { Command } from "commander";
import { createInterface } from "node:readline";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse, stringify } from "yaml";
import { cliLog, cliError } from "../output.js";
import { loadConfig, resolveAllAgents } from "../../config/loader.js";
import { createWorkspaces } from "../../agent/workspace.js";
import { resolveConfigPath } from "../../config/resolve-path.js";

// Phase 999.98 — Category B operator-pick surface: widened to include "fable"
// so an operator can select Fable when creating an agent via the CLI.
const VALID_MODELS = ["sonnet", "opus", "haiku", "fable"] as const;
type ValidModel = (typeof VALID_MODELS)[number];

/**
 * Prompt the user with a question and return their answer.
 */
function ask(
  rl: ReturnType<typeof createInterface>,
  question: string,
): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

/**
 * Prompt for a required field — keeps asking until non-empty.
 */
async function askRequired(
  rl: ReturnType<typeof createInterface>,
  question: string,
): Promise<string> {
  let answer = "";
  while (answer === "") {
    answer = await ask(rl, question);
    if (answer === "") {
      cliLog("  This field is required.");
    }
  }
  return answer;
}

/**
 * Prompt yes/no — returns boolean. Default is provided in brackets.
 */
async function askYesNo(
  rl: ReturnType<typeof createInterface>,
  question: string,
  defaultValue: boolean,
): Promise<boolean> {
  const hint = defaultValue ? "[Y/n]" : "[y/N]";
  const answer = await ask(rl, `${question} ${hint}: `);
  if (answer === "") return defaultValue;
  return answer.toLowerCase().startsWith("y");
}

/**
 * Register the `clawcode agent-create` command.
 * Interactive wizard that prompts for agent details, updates config YAML,
 * initializes the workspace, and optionally starts the agent.
 */
export function registerAgentCreateCommand(program: Command): void {
  program
    .command("agent-create")
    .description("Create a new agent interactively")
    .option("-c, --config <path>", "Path to config file", "clawcode.yaml")
    .action(async (opts: { config: string }) => {
      const configPath = resolveConfigPath(opts.config, { needsWrite: true });
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      try {
        cliLog("");
        cliLog("  ClawCode Agent Setup");
        cliLog("  ====================");
        cliLog("");

        // --- Required fields ---

        const name = await askRequired(rl, "Agent name: ");

        // Check for duplicate
        try {
          const existingConfig = await loadConfig(configPath);
          const existingAgents = resolveAllAgents(existingConfig);
          if (existingAgents.find((a) => a.name === name)) {
            cliError(`Error: Agent '${name}' already exists in ${configPath}`);
            rl.close();
            process.exit(1);
            return;
          }
        } catch {
          // Config doesn't exist yet or can't be parsed — will handle below
        }

        const channelId = await askRequired(rl, "Discord channel ID: ");

        cliLog("");
        cliLog("  Describe who this agent is — their personality, expertise,");
        cliLog("  and how they should behave. This becomes the agent's soul.");
        cliLog("");
        const soulText = await askRequired(rl, "Soul/personality: ");

        // --- Model ---

        cliLog("");
        let model: ValidModel = "sonnet";
        const modelInput = await ask(
          rl,
          "Model (sonnet/opus/haiku/fable) [sonnet]: ",
        );
        if (modelInput !== "") {
          if (!VALID_MODELS.includes(modelInput as ValidModel)) {
            cliError(
              `Invalid model '${modelInput}'. Must be one of: ${VALID_MODELS.join(", ")}`,
            );
            rl.close();
            process.exit(1);
            return;
          }
          model = modelInput as ValidModel;
        }

        // --- Identity (optional) ---

        cliLog("");
        cliLog("  Optional: Give the agent a display identity.");
        cliLog("");
        const displayName = await ask(rl, "Display name (or press Enter to use agent name): ");
        const emoji = await ask(rl, "Emoji (e.g. 🤖, or press Enter to skip): ");

        // --- Workspace ---

        const defaultWorkspace = join(homedir(), ".clawcode", "agents", name);
        const workspaceInput = await ask(
          rl,
          `Workspace path [${defaultWorkspace}]: `,
        );
        const workspace = workspaceInput || defaultWorkspace;

        // --- Optional features ---

        cliLog("");
        cliLog("  Optional features:");
        cliLog("");

        const wantSchedules = await askYesNo(rl, "  Add scheduled tasks (cron)?", false);
        let schedules: Array<{ name: string; cron: string; prompt: string }> = [];
        if (wantSchedules) {
          cliLog("  Add schedules (empty name to finish):");
          let adding = true;
          while (adding) {
            const scheduleName = await ask(rl, "    Schedule name: ");
            if (scheduleName === "") {
              adding = false;
              continue;
            }
            const cron = await askRequired(rl, "    Cron expression (e.g. 0 9 * * *): ");
            const prompt = await askRequired(rl, "    Prompt to send: ");
            schedules.push({ name: scheduleName, cron, prompt });
          }
        }

        const wantEscalation = await askYesNo(rl, "  Enable model escalation (Sonnet → Opus)?", false);
        let escalationBudget: Record<string, Record<string, number>> | undefined;
        if (wantEscalation) {
          const dailyLimit = await ask(rl, "    Daily Opus token limit [50000]: ");
          escalationBudget = {
            daily: { opus: Number(dailyLimit) || 50000 },
          };
        }

        const isAdmin = await askYesNo(rl, "  Make this an admin agent?", false);

        const wantWebhook = await askYesNo(rl, "  Use webhook identity (custom name/avatar)?", false);
        let webhook: { name: string; avatar?: string } | undefined;
        if (wantWebhook) {
          const webhookName = await ask(rl, `    Webhook display name [${displayName || name}]: `);
          const avatarUrl = await ask(rl, "    Avatar URL (or press Enter to skip): ");
          webhook = {
            name: webhookName || displayName || name,
            ...(avatarUrl ? { avatar: avatarUrl } : {}),
          };
        }

        // --- Additional channels ---

        const wantMoreChannels = await askYesNo(rl, "  Bind to additional Discord channels?", false);
        const channels = [channelId];
        if (wantMoreChannels) {
          cliLog("  Add channel IDs (empty to finish):");
          let adding = true;
          while (adding) {
            const extraChannel = await ask(rl, "    Channel ID: ");
            if (extraChannel === "") {
              adding = false;
            } else {
              channels.push(extraChannel);
            }
          }
        }

        rl.close();

        // --- Build agent config ---

        const newAgent: Record<string, unknown> = {
          name,
          channels,
          soul: soulText,
        };

        if (model !== "sonnet") {
          newAgent.model = model;
        }
        if (workspace !== defaultWorkspace) {
          newAgent.workspace = workspace;
        }
        if (displayName || emoji) {
          newAgent.identity = [
            displayName ? `Name: ${displayName}` : "",
            emoji ? `Emoji: ${emoji}` : "",
          ].filter(Boolean).join("\n");
        }
        if (schedules.length > 0) {
          newAgent.schedules = schedules;
        }
        if (escalationBudget) {
          newAgent.escalationBudget = escalationBudget;
        }
        if (isAdmin) {
          newAgent.admin = true;
        }
        if (webhook) {
          newAgent.webhook = webhook;
        }

        // --- Update config YAML ---

        cliLog("");
        const content = await readFile(configPath, "utf-8");
        const parsed = parse(content) as { agents: Array<Record<string, unknown>> };
        parsed.agents.push(newAgent);
        await writeFile(configPath, stringify(parsed, { lineWidth: 120 }));
        cliLog(`Agent '${name}' added to ${configPath}`);

        // --- Initialize workspace ---

        cliLog("Initializing workspace...");
        await mkdir(workspace, { recursive: true });

        const config = await loadConfig(configPath);
        const resolvedAgents = resolveAllAgents(config);
        const thisAgent = resolvedAgents.filter((a) => a.name === name);

        if (thisAgent.length > 0) {
          const results = await createWorkspaces(thisAgent);
          for (const result of results) {
            if (result.filesWritten.length > 0) {
              cliLog(`  Created: ${result.path}`);
              for (const file of result.filesWritten) {
                cliLog(`    - ${file}`);
              }
            }
          }
        }

        // --- Summary ---

        cliLog("");
        cliLog("  Agent ready!");
        cliLog("");
        cliLog(`  Name:        ${name}`);
        cliLog(`  Model:       ${model}`);
        cliLog(`  Channels:    ${channels.join(", ")}`);
        cliLog(`  Workspace:   ${workspace}`);
        if (displayName) cliLog(`  Display:     ${displayName} ${emoji || ""}`);
        if (schedules.length > 0) cliLog(`  Schedules:   ${schedules.length}`);
        if (escalationBudget) cliLog(`  Escalation:  enabled (Opus)`);
        if (isAdmin) cliLog(`  Admin:       yes`);
        if (webhook) cliLog(`  Webhook:     ${webhook.name}`);
        cliLog("");
        cliLog("  Start with:");
        cliLog(`    clawcode start ${name}`);
        cliLog("");
        cliLog("  Or start all agents:");
        cliLog("    clawcode start-all");
        cliLog("");
      } catch (error) {
        rl.close();
        const message =
          error instanceof Error ? error.message : String(error);
        cliError(`Error: ${message}`);
        process.exit(1);
      }
    });
}
