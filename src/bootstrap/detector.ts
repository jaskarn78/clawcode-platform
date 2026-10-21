import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedAgentConfig } from "../shared/types.js";
import type { BootstrapStatus } from "./types.js";
import { BOOTSTRAP_FLAG_FILE } from "./types.js";
import { DEFAULT_SOUL } from "../config/defaults.js";

/**
 * Check if a file exists at the given path.
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect whether an agent needs first-run bootstrap setup.
 *
 * Detection logic:
 * 1. If config.soul is defined, return "skipped" (config-provided soul overrides bootstrap)
 * 2. If .bootstrap-complete flag file exists, return "complete"
 * 3. If SOUL.md doesn't exist or matches DEFAULT_SOUL exactly (trimmed), return "needed"
 * 4. Otherwise return "complete" (user has customized SOUL.md manually)
 *
 * @param config - Resolved agent configuration
 * @returns Bootstrap status for the agent
 */
export async function detectBootstrapNeeded(
  config: ResolvedAgentConfig,
): Promise<BootstrapStatus> {
  // Config-provided soul means no bootstrap needed
  if (config.soul !== undefined) {
    return "skipped";
  }

  const flagPath = join(config.workspace, BOOTSTRAP_FLAG_FILE);

  // Flag file present means bootstrap already completed
  if (await fileExists(flagPath)) {
    return "complete";
  }

  const soulPath = join(config.workspace, "SOUL.md");

  // No SOUL.md means bootstrap is needed
  if (!(await fileExists(soulPath))) {
    return "needed";
  }

  // SOUL.md exists -- check if it matches the default
  const soulContent = await readFile(soulPath, "utf-8");

  if (soulContent.trim() === DEFAULT_SOUL.trim()) {
    return "needed";
  }

  // SOUL.md has been customized by the user
  return "complete";
}
