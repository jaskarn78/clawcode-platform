/**
 * 999.105 — runtime output-style persistence.
 *
 * Mirrors `effort-state-store.ts` (versioned envelope, atomic tmp+rename,
 * per-entry salvage) with one deliberate difference in the callers: style is
 * restored on BOTH boot paths (startAgentCore AND reconcileRegistry) — the
 * effort template restores only in startAgentCore, which misses the path most
 * agents take on a daemon restart. Copying that verbatim would inherit the
 * bug (999.105 plan WS-1.5).
 *
 * NOT `verbose-state.db`: that is keyed per-CHANNEL; agents are not 1:1 with
 * channels, so a multi-channel agent's style would fragment.
 */

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import type { Logger } from "pino";
import { z } from "zod/v4";
import { OUTPUT_STYLE_IDS, type OutputStyleId } from "./roster.js";

export const DEFAULT_STYLE_STATE_PATH = join(
  homedir(),
  ".clawcode",
  "manager",
  "style-state.json",
);

const styleIdSchema = z.enum(OUTPUT_STYLE_IDS);

const styleStateEnvelopeSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  agents: z.record(z.string(), z.unknown()),
});

export type StyleStateFile = {
  version: 1;
  updatedAt: string;
  agents: Record<string, OutputStyleId>;
};

/** Per-entry salvage: keep valid siblings when one entry is junk. */
function salvageAgentEntries(raw: Record<string, unknown>): {
  agents: Record<string, OutputStyleId>;
  dropped: string[];
} {
  const agents: Record<string, OutputStyleId> = {};
  const dropped: string[] = [];
  for (const [name, value] of Object.entries(raw)) {
    const parsed = styleIdSchema.safeParse(value);
    if (parsed.success) agents[name] = parsed.data;
    else dropped.push(name);
  }
  return { agents, dropped };
}

/**
 * Read the persisted style for `agentName`. `null` in ALL failure modes
 * (missing file is the silent first-boot state; anything else warns).
 */
export async function readStyleState(
  filePath: string,
  agentName: string,
  log?: Logger,
): Promise<OutputStyleId | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    log?.warn(
      { filePath, error: err instanceof Error ? err.message : String(err) },
      "style-state read failed",
    );
    return null;
  }
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    log?.warn(
      { filePath, error: err instanceof Error ? err.message : String(err) },
      "style-state JSON parse failed",
    );
    return null;
  }
  const parsed = styleStateEnvelopeSchema.safeParse(obj);
  if (!parsed.success) {
    log?.warn(
      { filePath, issues: parsed.error.issues.length },
      "style-state file schema invalid, ignoring",
    );
    return null;
  }
  const { agents, dropped } = salvageAgentEntries(parsed.data.agents);
  if (dropped.length > 0) {
    log?.warn(
      { filePath, dropped },
      "style-state: dropped invalid persisted entries; valid siblings kept",
    );
  }
  return agents[agentName] ?? null;
}

/** Atomically persist `style` for `agentName` (read-merge-tmp-rename). */
export async function writeStyleState(
  filePath: string,
  agentName: string,
  style: OutputStyleId,
  log?: Logger,
): Promise<void> {
  const existing = await readExistingOrEmpty(filePath);
  const next: StyleStateFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    agents: { ...existing.agents, [agentName]: style },
  };
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await rename(tmp, filePath);
  log?.debug({ agent: agentName, style }, "style-state persisted");
}

/**
 * Remove `agentName` from the persisted state. Selecting `default` clears
 * rather than storing "default" — the baseline must be the ABSENCE of an
 * override, not a stored value that would inject forever.
 */
export async function clearStyleState(
  filePath: string,
  agentName: string,
  log?: Logger,
): Promise<void> {
  const existing = await readExistingOrEmpty(filePath);
  if (!(agentName in existing.agents)) return;
  const next: StyleStateFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    agents: Object.fromEntries(
      Object.entries(existing.agents).filter(([k]) => k !== agentName),
    ) as Record<string, OutputStyleId>,
  };
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await rename(tmp, filePath);
  log?.debug({ agent: agentName }, "style-state cleared");
}

/** Read-existing helper; corrupt files start fresh (never block writes). */
async function readExistingOrEmpty(filePath: string): Promise<StyleStateFile> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = styleStateEnvelopeSchema.safeParse(JSON.parse(raw));
    if (parsed.success) {
      const { agents } = salvageAgentEntries(parsed.data.agents);
      return { version: 1, updatedAt: parsed.data.updatedAt, agents };
    }
  } catch {
    // fall through to empty
  }
  return { version: 1, updatedAt: "", agents: {} };
}
