/**
 * Phase 999.164 — runtime on/off for the quick lane, set from Discord with
 * `/clawcode-quick` and persisted across restarts.
 *
 * Same shape as `verification-state-store.ts` (and effort-state before it): an
 * operator flips a per-AGENT setting from chat, it must survive `systemctl
 * restart`, and it is re-applied on boot. Config (`fastLane.enabled`, default
 * on) stays the operator-authored baseline; this file is the override that
 * layers over it. A state file, not a yaml write, for the same reason as those
 * stores: programmatic yaml edits fight the deploy script.
 *
 * Replaces a hard-coded guard for verification-enforced agents (Operator,
 * 2026-09-23: "configure a slash command toggle and have it enabled for all by
 * default") — the operator decides per agent instead.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import type { Logger } from "pino";
import { z } from "zod/v4";

/** Canonical path — beside verification-state.json in the manager dir. */
export const DEFAULT_FAST_LANE_STATE_PATH = join(homedir(), ".clawcode", "manager", "fast-lane-state.json");

export interface FastLaneOverride {
  readonly enabled: boolean;
}

const overrideSchema = z.object({ enabled: z.boolean() });

/** Envelope strict, entries validated one by one — a bad entry drops only that agent. */
const fileSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  agents: z.record(z.string(), z.unknown()),
});

interface StateFile {
  version: 1;
  updatedAt: string;
  agents: Record<string, unknown>;
}

async function readOrEmpty(filePath: string, log?: Logger): Promise<StateFile> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log?.warn({ filePath, error: err instanceof Error ? err.message : String(err) }, "fast-lane-state read failed");
    }
    return { version: 1, updatedAt: "", agents: {} };
  }
  try {
    const parsed = fileSchema.safeParse(JSON.parse(raw));
    return parsed.success ? (parsed.data as StateFile) : { version: 1, updatedAt: "", agents: {} };
  } catch (err) {
    log?.warn({ filePath, error: err instanceof Error ? err.message : String(err) }, "fast-lane-state JSON parse failed");
    return { version: 1, updatedAt: "", agents: {} };
  }
}

async function writeAtomic(filePath: string, agents: Record<string, unknown>): Promise<void> {
  const next: StateFile = { version: 1, updatedAt: new Date().toISOString(), agents };
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await rename(tmp, filePath);
}

/** Every valid override. Used at boot to re-apply. */
export async function readAllFastLaneState(filePath: string, log?: Logger): Promise<Record<string, FastLaneOverride>> {
  const file = await readOrEmpty(filePath, log);
  const out: Record<string, FastLaneOverride> = {};
  for (const [agent, entry] of Object.entries(file.agents)) {
    const parsed = overrideSchema.safeParse(entry);
    if (parsed.success) out[agent] = parsed.data;
    else log?.warn({ agent }, "fast-lane-state entry invalid — dropping this agent only");
  }
  return out;
}

/** Persist one agent's override (tmp + rename). */
export async function writeFastLaneState(
  filePath: string,
  agentName: string,
  override: FastLaneOverride,
  log?: Logger,
): Promise<FastLaneOverride> {
  const existing = await readOrEmpty(filePath, log);
  await writeAtomic(filePath, { ...existing.agents, [agentName]: { enabled: override.enabled } });
  log?.info({ agent: agentName, enabled: override.enabled }, "fast-lane-state persisted");
  return { enabled: override.enabled };
}

/** Drop one agent's override, returning it to whatever config says. */
export async function clearFastLaneState(filePath: string, agentName: string, log?: Logger): Promise<void> {
  const existing = await readOrEmpty(filePath, log);
  if (!(agentName in existing.agents)) return;
  const { [agentName]: _dropped, ...rest } = existing.agents;
  await writeAtomic(filePath, rest);
  log?.info({ agent: agentName }, "fast-lane-state cleared");
}

// ---------------------------------------------------------------------
// In-memory registry — the bridge reads it on every inbound message, so no
// file IO on the hot path. Kept in step with the file: hydrated at boot, and
// set by the IPC handler alongside every write.
// ---------------------------------------------------------------------

const RUNTIME = new Map<string, FastLaneOverride>();

export function getFastLaneOverride(agentName: string): FastLaneOverride | undefined {
  return RUNTIME.get(agentName);
}

export function setFastLaneOverride(agentName: string, override: FastLaneOverride | null): void {
  if (override === null) RUNTIME.delete(agentName);
  else RUNTIME.set(agentName, override);
}

/** Load persisted overrides at boot; logs each one so a silent non-apply is visible. */
export async function hydrateFastLaneOverrides(filePath: string, log?: Logger): Promise<Record<string, FastLaneOverride>> {
  const all = await readAllFastLaneState(filePath, log);
  RUNTIME.clear();
  for (const [agent, override] of Object.entries(all)) {
    RUNTIME.set(agent, override);
    log?.info({ agent, enabled: override.enabled }, "re-applied persisted fast-lane override");
  }
  return all;
}

/** Effective on/off: the runtime override wins, else config (which defaults on). */
export function resolveFastLaneEnabled(
  override: FastLaneOverride | undefined,
  configEnabled: boolean | undefined,
): { readonly enabled: boolean; readonly source: "override" | "config" } {
  if (override) return { enabled: override.enabled, source: "override" };
  return { enabled: configEnabled === true, source: "config" };
}
