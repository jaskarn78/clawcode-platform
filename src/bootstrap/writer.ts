import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BootstrapResult } from "./types.js";
import { BOOTSTRAP_FLAG_FILE } from "./types.js";

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
 * Write bootstrap results (SOUL.md and IDENTITY.md) to the agent workspace.
 *
 * Idempotency guard: if .bootstrap-complete already exists, this is a no-op.
 * This prevents accidental overwrites if bootstrap is triggered multiple times.
 *
 * @param result - Bootstrap walkthrough output containing generated content
 * @param workspace - Absolute path to the agent workspace directory
 */
export async function writeBootstrapResults(
  result: BootstrapResult,
  workspace: string,
): Promise<void> {
  const flagPath = join(workspace, BOOTSTRAP_FLAG_FILE);

  // Idempotency guard: do not overwrite if bootstrap already completed
  if (await fileExists(flagPath)) {
    return;
  }

  const soulPath = join(workspace, "SOUL.md");
  const identityPath = join(workspace, "IDENTITY.md");

  await writeFile(soulPath, result.soulContent, "utf-8");
  await writeFile(identityPath, result.identityContent, "utf-8");
}

/**
 * Mark bootstrap as complete by writing a flag file with an ISO timestamp.
 *
 * The presence of this file prevents detectBootstrapNeeded from returning "needed"
 * on subsequent agent starts.
 *
 * @param workspace - Absolute path to the agent workspace directory
 */
export async function markBootstrapComplete(workspace: string): Promise<void> {
  const flagPath = join(workspace, BOOTSTRAP_FLAG_FILE);
  const timestamp = new Date().toISOString();
  await writeFile(flagPath, timestamp, "utf-8");
}
