import { join } from "node:path";
import type * as fsPromisesModule from "node:fs/promises";
import YAML from "yaml";
import type { ActiveStateBlock } from "./types.js";

export const ACTIVE_STATE_SENTINEL = "[125-01-active-state]";

export type YamlWriterDeps = {
  readonly baseDir: string;
  readonly fs: typeof fsPromisesModule;
  readonly clock: () => Date;
};

function renderYaml(block: ActiveStateBlock): string {
  const payload = {
    primaryClient: block.primaryClient,
    inFlightTasks: [...block.inFlightTasks],
    standingRulesAddedToday: [...block.standingRulesAddedToday],
    driveFoldersTouched: [...block.driveFoldersTouched],
    lastOperatorMessages: [...block.lastOperatorMessages],
    lastAgentCommitments: [...block.lastAgentCommitments],
    generatedAt: block.generatedAt,
  };
  const body = YAML.stringify(payload, { lineWidth: 0 });
  return `# sentinel: "${ACTIVE_STATE_SENTINEL}"\n${body}`;
}

function activeStatePath(baseDir: string, agent: string): string {
  return join(baseDir, agent, "state", "active-state.yaml");
}

export async function writeActiveStateYaml(
  agent: string,
  block: ActiveStateBlock,
  deps: YamlWriterDeps,
): Promise<string> {
  const finalPath = activeStatePath(deps.baseDir, agent);
  const dir = join(deps.baseDir, agent, "state");
  await deps.fs.mkdir(dir, { recursive: true });
  const ts = deps.clock().getTime();
  const tmpPath = `${finalPath}.${ts}.${process.pid}.tmp`;
  const content = renderYaml(block);
  await deps.fs.writeFile(tmpPath, content, "utf8");
  await deps.fs.rename(tmpPath, finalPath);
  return finalPath;
}

export async function readActiveStateYaml(
  agent: string,
  deps: Pick<YamlWriterDeps, "baseDir" | "fs">,
): Promise<ActiveStateBlock | null> {
  const filePath = activeStatePath(deps.baseDir, agent);
  let raw: string;
  try {
    raw = await deps.fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = YAML.parse(raw) as Partial<ActiveStateBlock> | null;
    if (!parsed || typeof parsed !== "object") return null;
    return Object.freeze({
      primaryClient:
        typeof parsed.primaryClient === "string" ? parsed.primaryClient : null,
      inFlightTasks: Object.freeze(
        Array.isArray(parsed.inFlightTasks)
          ? parsed.inFlightTasks.filter((x): x is string => typeof x === "string")
          : [],
      ),
      standingRulesAddedToday: Object.freeze(
        Array.isArray(parsed.standingRulesAddedToday)
          ? parsed.standingRulesAddedToday.filter(
              (x): x is string => typeof x === "string",
            )
          : [],
      ),
      driveFoldersTouched: Object.freeze(
        Array.isArray(parsed.driveFoldersTouched)
          ? parsed.driveFoldersTouched.filter(
              (x): x is string => typeof x === "string",
            )
          : [],
      ),
      lastOperatorMessages: Object.freeze(
        Array.isArray(parsed.lastOperatorMessages)
          ? parsed.lastOperatorMessages.filter(
              (x): x is string => typeof x === "string",
            )
          : [],
      ),
      lastAgentCommitments: Object.freeze(
        Array.isArray(parsed.lastAgentCommitments)
          ? parsed.lastAgentCommitments.filter(
              (x): x is string => typeof x === "string",
            )
          : [],
      ),
      generatedAt:
        typeof parsed.generatedAt === "string" ? parsed.generatedAt : "",
    });
  } catch {
    return null;
  }
}

export function renderActiveStateForPrompt(block: ActiveStateBlock): string {
  const lines: string[] = [];
  lines.push("ACTIVE STATE (auto-maintained)");
  lines.push(`- Today's primary client: ${block.primaryClient ?? "(none)"}`);
  if (block.inFlightTasks.length > 0) {
    lines.push("- In-flight tasks:");
    for (const t of block.inFlightTasks) lines.push(`  - ${t}`);
  }
  if (block.standingRulesAddedToday.length > 0) {
    lines.push("- Standing rules added today:");
    for (const r of block.standingRulesAddedToday) lines.push(`  - ${r}`);
  }
  if (block.driveFoldersTouched.length > 0) {
    lines.push("- Drive folders touched:");
    for (const f of block.driveFoldersTouched) lines.push(`  - ${f}`);
  }
  if (block.lastOperatorMessages.length > 0) {
    lines.push("- Latest operator feedback (verbatim):");
    for (const m of block.lastOperatorMessages) lines.push(`  > ${m}`);
  }
  return lines.join("\n");
}
