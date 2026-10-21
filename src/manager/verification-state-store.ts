/**
 * 999.63d/7 — runtime overrides for the verification trail, set from
 * Discord and persisted across restarts.
 *
 * Mirrors `effort-state-store.ts` rather than `verbose-state.db`: like
 * effort, this is an operator flipping a per-AGENT setting from chat that
 * must survive `systemctl restart` and be re-applied on boot. Verbose is
 * per-CHANNEL and intentionally ephemeral, which is the wrong shape here.
 *
 * WHY A STATE FILE AND NOT A YAML WRITE. Programmatic yaml edits would
 * fight the deploy script and the /etc-vs-/opt config decoy. Config stays
 * the operator-authored baseline; this file is the runtime override that
 * layers over it, exactly as effort does.
 *
 * WHAT IS DELIBERATELY NOT HERE: the verification VOCABULARY. This store
 * carries the display mode and the profile NAME. A profile's terms — and
 * the separate vocabulary behind the corrective-hop classifiers — stay in
 * reviewed, deployed code. Someone should not be able to weaken the gate
 * that catches client-facing errors by typing in a channel.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import type { Logger } from "pino";
import { z } from "zod/v4";

import {
  TOPIC_PROFILE_NAMES,
  type TopicProfileName,
} from "./topic-profiles.js";

/** Canonical path — sits beside effort-state.json, same manager dir. */
export const DEFAULT_VERIFICATION_STATE_PATH = join(
  homedir(),
  ".clawcode",
  "manager",
  "verification-state.json",
);

export const TRAIL_MODES = ["always", "topic", "auto"] as const;
export type TrailMode = (typeof TRAIL_MODES)[number];

export interface VerificationOverride {
  readonly mode?: TrailMode;
  readonly profile?: TopicProfileName;
}

const overrideSchema = z.object({
  mode: z.enum(TRAIL_MODES).optional(),
  profile: z.enum(TOPIC_PROFILE_NAMES).optional(),
});

/**
 * Envelope validated strictly; per-agent values kept `unknown` and
 * validated individually so one bad entry drops only that agent rather
 * than resetting every override — the effort-state IN-01 precedent.
 */
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

const EMPTY: StateFile = { version: 1, updatedAt: "", agents: {} };

async function readOrEmpty(filePath: string, log?: Logger): Promise<StateFile> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      log?.warn(
        { filePath, error: err instanceof Error ? err.message : String(err) },
        "verification-state read failed",
      );
    }
    return { ...EMPTY, agents: {} };
  }
  try {
    const parsed = fileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return { ...EMPTY, agents: {} };
    return parsed.data as StateFile;
  } catch (err) {
    log?.warn(
      { filePath, error: err instanceof Error ? err.message : String(err) },
      "verification-state JSON parse failed",
    );
    return { ...EMPTY, agents: {} };
  }
}

/** Read one agent's override. Returns null when absent or unreadable. */
export async function readVerificationState(
  filePath: string,
  agentName: string,
  log?: Logger,
): Promise<VerificationOverride | null> {
  const file = await readOrEmpty(filePath, log);
  const entry = file.agents[agentName];
  if (entry === undefined) return null;
  const parsed = overrideSchema.safeParse(entry);
  if (!parsed.success) {
    log?.warn(
      { agent: agentName },
      "verification-state entry invalid — dropping this agent only",
    );
    return null;
  }
  if (parsed.data.mode === undefined && parsed.data.profile === undefined) {
    return null;
  }
  return parsed.data;
}

/** Read every valid override. Used at boot to re-apply and to report. */
export async function readAllVerificationState(
  filePath: string,
  log?: Logger,
): Promise<Record<string, VerificationOverride>> {
  const file = await readOrEmpty(filePath, log);
  const out: Record<string, VerificationOverride> = {};
  for (const [agent, entry] of Object.entries(file.agents)) {
    const parsed = overrideSchema.safeParse(entry);
    if (!parsed.success) continue;
    if (parsed.data.mode === undefined && parsed.data.profile === undefined) {
      continue;
    }
    out[agent] = parsed.data;
  }
  return out;
}

/**
 * Merge a partial override for one agent. Fields left undefined keep
 * their persisted value, so setting the profile does not silently reset
 * the mode. Atomic tmp+rename, same as effort-state.
 */
export async function writeVerificationState(
  filePath: string,
  agentName: string,
  patch: VerificationOverride,
  log?: Logger,
): Promise<VerificationOverride> {
  const existing = await readOrEmpty(filePath, log);
  const prevParsed = overrideSchema.safeParse(existing.agents[agentName]);
  const prev: VerificationOverride = prevParsed.success ? prevParsed.data : {};
  const merged: VerificationOverride = {
    ...(patch.mode ?? prev.mode ? { mode: patch.mode ?? prev.mode } : {}),
    ...(patch.profile ?? prev.profile
      ? { profile: patch.profile ?? prev.profile }
      : {}),
  };
  const next: StateFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    agents: { ...existing.agents, [agentName]: merged },
  };
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await rename(tmp, filePath);
  log?.info({ agent: agentName, ...merged }, "verification-state persisted");
  return merged;
}

/** Drop one agent's override, returning it to whatever config says. */
export async function clearVerificationState(
  filePath: string,
  agentName: string,
  log?: Logger,
): Promise<void> {
  const existing = await readOrEmpty(filePath, log);
  if (!(agentName in existing.agents)) return;
  const agents = { ...existing.agents };
  delete agents[agentName];
  const next: StateFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    agents,
  };
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await rename(tmp, filePath);
  log?.info({ agent: agentName }, "verification-state cleared");
}

// ---------------------------------------------------------------------
// In-memory runtime registry.
//
// The bridge consults the override on EVERY inbound message, so it cannot
// do file IO per turn. The file is the durable record; this map is what
// the hot path reads. They are kept in step by writing both together:
// `hydrateVerificationOverrides` at boot, and the IPC handler on each set.
//
// Same shape as the effort-state re-apply on boot — the operator flips it
// in chat once and it survives `systemctl restart`.
// ---------------------------------------------------------------------

const RUNTIME = new Map<string, VerificationOverride>();

/** Synchronous read for the per-message hot path. */
export function getVerificationOverride(
  agentName: string,
): VerificationOverride | undefined {
  return RUNTIME.get(agentName);
}

/** Update the in-memory registry. Call alongside a file write. */
export function setVerificationOverride(
  agentName: string,
  override: VerificationOverride | null,
): void {
  if (override === null) RUNTIME.delete(agentName);
  else RUNTIME.set(agentName, override);
}

/**
 * Load persisted overrides into the registry at boot. Returns what was
 * re-applied so the caller can log it — the effort-state precedent logs
 * "re-applied persisted effort override" per agent, and an override that
 * silently fails to re-apply is exactly the class of bug this codebase
 * keeps hitting.
 */
export async function hydrateVerificationOverrides(
  filePath: string,
  log?: Logger,
): Promise<Record<string, VerificationOverride>> {
  const all = await readAllVerificationState(filePath, log);
  RUNTIME.clear();
  for (const [agent, override] of Object.entries(all)) {
    RUNTIME.set(agent, override);
    log?.info(
      { agent, ...override },
      "re-applied persisted verification override",
    );
  }
  return all;
}
