/**
 * Phase 78 CONF-01 — an agent's SOUL / IDENTITY text, by 3-branch precedence:
 *
 *   explicit file (`soulFile` / `identityFile`, absolute path)
 *     → `<workspace>/SOUL.md` / `<workspace>/IDENTITY.md`
 *     → inline config string (`soul` / `identity`)
 *
 * Silent fall-through on read errors at every step: a configured file pointing
 * at a deleted path must not crash session boot; it falls through to the
 * workspace file, then the inline string. An empty file falls through too.
 *
 * Shared by agent sessions (session-config.ts) and the OpenAI endpoint's
 * transient path (endpoint-bootstrap.ts) so the two cannot drift — the endpoint
 * once read only the inline `soul`, so every `soulFile` agent answered over the
 * API with no persona at all.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedAgentConfig } from "../shared/types.js";

async function readFirstPresent(
  file: string | undefined,
  workspaceFile: string,
  inline: string | undefined,
): Promise<string> {
  let content = "";
  if (file) {
    try {
      content = await readFile(file, "utf-8");
    } catch {
      // Configured but unreadable — fall through to the workspace file.
    }
  }
  if (!content) {
    try {
      content = await readFile(workspaceFile, "utf-8");
    } catch {
      // No file in the workspace — fall through to the inline string.
    }
  }
  return content || (inline ?? "");
}

export function readSoulContent(
  config: Pick<ResolvedAgentConfig, "soulFile" | "workspace" | "soul">,
): Promise<string> {
  return readFirstPresent(
    config.soulFile,
    join(config.workspace, "SOUL.md"),
    config.soul,
  );
}

export function readIdentityContent(
  config: Pick<ResolvedAgentConfig, "identityFile" | "workspace" | "identity">,
): Promise<string> {
  return readFirstPresent(
    config.identityFile,
    join(config.workspace, "IDENTITY.md"),
    config.identity,
  );
}
