/**
 * Phase 999.171 — per-agent, per-feature UX overrides, set from Discord with
 * `/clawcode-ux` and persisted across restarts.
 *
 * Generalises the quick-lane store (`fast-lane-state-store.ts`, left as-is
 * with its own file format) from one boolean per agent to one boolean per
 * (agent, feature). Config (`uxFeatures.*`, default off) stays the
 * operator-authored baseline; this file is the override that layers over it.
 * A state file, not a yaml write, for the same reason as the other stores:
 * programmatic yaml edits fight the deploy script.
 *
 * Shared by 999.171 (live thinking), 999.172 (prompt suggestions) and
 * 999.173 (research subagents).
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import type { Logger } from "pino";
import { z } from "zod/v4";
import { ManagerError } from "../shared/errors.js";

export const UX_FEATURES = ["liveThinking", "statusPing", "promptSuggestions", "researchSubagents"] as const;

export type UxFeature = (typeof UX_FEATURES)[number];

/**
 * 999.173 polish — research model choices for the per-agent runtime override
 * (`/clawcode-ux feature:research model:<choice>`). `inherit` = the agent's own
 * model family.
 */
export const RESEARCH_MODEL_CHOICES = ["opus", "sonnet", "haiku", "fable", "inherit"] as const;
export type ResearchModelChoice = (typeof RESEARCH_MODEL_CHOICES)[number];

export type UxFeatureOverrides = Readonly<
  Partial<Record<UxFeature, boolean>> & {
    /** 999.173 polish — runtime research model override (applies at the next researcher launch). */
    researchModel?: ResearchModelChoice;
  }
>;

/** A persisted override key: one feature's on/off, or the research model. */
type OverrideKey = UxFeature | "researchModel";

export type UxFeatureApplies = "next-turn" | "restart" | "not-yet-available";

/** `/clawcode-ux <name>` choice → canonical feature key. */
export const UX_FEATURE_SLASH_NAMES: Readonly<Record<string, UxFeature>> = Object.freeze({
  thinking: "liveThinking",
  ping: "statusPing",
  suggestions: "promptSuggestions",
  research: "researchSubagents",
});

/**
 * Operator-facing label and when a change takes effect.
 *
 * promptSuggestions (999.172) is a session-start option: a toggle applies
 * after the agent restarts. researchSubagents has no consumer in this build,
 * so its toggle is saved but inert until 999.173 flips it to "restart".
 */
export const UX_FEATURE_META: Readonly<
  Record<UxFeature, Readonly<{ label: string; applies: UxFeatureApplies }>>
> = Object.freeze({
  liveThinking: Object.freeze({ label: "Live thinking", applies: "next-turn" as const }),
  // 999.178 R1 — the daemon reads statusPing per message (like liveThinking), so a toggle hits the next turn.
  statusPing: Object.freeze({ label: "Status ping", applies: "next-turn" as const }),
  promptSuggestions: Object.freeze({ label: "Prompt suggestions", applies: "restart" as const }),
  // 999.173 — consumer shipped: a session-start option (agents.researcher).
  researchSubagents: Object.freeze({ label: "Research subagents", applies: "restart" as const }),
});

/** Canonical path — beside the other per-agent state files in the manager dir. */
export const DEFAULT_UX_FEATURE_STATE_PATH = join(homedir(), ".clawcode", "manager", "ux-feature-state.json");

/** One agent's entry: every feature optional, unknown keys rejected. */
const agentEntrySchema = z
  .object({
    liveThinking: z.boolean().optional(),
    statusPing: z.boolean().optional(),
    promptSuggestions: z.boolean().optional(),
    researchSubagents: z.boolean().optional(),
    researchModel: z.enum(RESEARCH_MODEL_CHOICES).optional(),
  })
  .strict();

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

const EMPTY_FILE: StateFile = Object.freeze({ version: 1, updatedAt: "", agents: {} }) as StateFile;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readOrEmpty(filePath: string, log?: Logger): Promise<StateFile> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log?.warn({ filePath, error: errMessage(err) }, "ux-feature-state read failed");
    }
    return EMPTY_FILE;
  }
  try {
    const parsed = fileSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data as StateFile;
    log?.warn({ filePath }, "ux-feature-state envelope invalid — treating as empty");
    return EMPTY_FILE;
  } catch (err) {
    log?.warn({ filePath, error: errMessage(err) }, "ux-feature-state JSON parse failed");
    return EMPTY_FILE;
  }
}

/** The file's text as a v1 state file; undefined when it is not JSON or not a v1 envelope. */
function parseStateText(raw: string): StateFile | undefined {
  try {
    const parsed = fileSchema.safeParse(JSON.parse(raw));
    return parsed.success ? (parsed.data as StateFile) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The WRITE path's read (999.171 REVIEW MD-04). It fails closed, unlike
 * readOrEmpty: a merge-and-write over a file it could not read would replace
 * every other agent's override with this one agent's entry.
 *   - missing file   → empty (first write);
 *   - any other read error (EACCES, EIO, EMFILE, EISDIR…) → refuse the write;
 *   - unparseable (bad JSON or envelope) → move it aside to
 *     `<file>.corrupt-<timestamp>`, kept for the operator, then start fresh.
 * Paths go to the daemon log only; the ManagerError text reaches Discord.
 */
async function readForWrite(filePath: string, log?: Logger): Promise<StateFile> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_FILE;
    log?.warn({ filePath, error: errMessage(err) }, "ux-feature-state unreadable — refusing to overwrite it");
    throw new ManagerError("ux-feature state file could not be read, so it was not overwritten (see daemon log)");
  }
  const parsed = parseStateText(raw);
  if (parsed) return parsed;
  const movedTo = `${filePath}.corrupt-${Date.now()}`;
  try {
    await rename(filePath, movedTo);
  } catch (err) {
    log?.warn({ filePath, movedTo, error: errMessage(err) }, "ux-feature-state corrupt and could not be moved aside — refusing to overwrite it");
    throw new ManagerError("ux-feature state file is corrupt and could not be set aside, so it was not overwritten (see daemon log)");
  }
  log?.warn({ filePath, movedTo }, "ux-feature-state corrupt — moved aside, writing a fresh file");
  return EMPTY_FILE;
}

/**
 * tmp + rename. A failure is logged here with its path and cause; the caller
 * gets a path-free ManagerError, because its text reaches the admin's
 * Discord reply (REVIEW IN-01).
 */
async function writeAtomic(filePath: string, agents: Record<string, unknown>, log?: Logger): Promise<void> {
  const next: StateFile = { version: 1, updatedAt: new Date().toISOString(), agents };
  const tmp = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
    await rename(tmp, filePath);
  } catch (err) {
    // Never leave a stray tmp beside the state file.
    await unlink(tmp).catch(() => undefined);
    log?.warn({ filePath, error: errMessage(err) }, "ux-feature-state write failed");
    throw new ManagerError("could not save the ux-feature state (see daemon log)");
  }
}

/** Validate one agent's raw entry; undefined when it does not parse. */
function parseEntry(entry: unknown): UxFeatureOverrides | undefined {
  const parsed = agentEntrySchema.safeParse(entry);
  return parsed.success ? Object.freeze({ ...parsed.data }) : undefined;
}

/** Every valid agent's overrides. Used at boot to re-apply. */
export async function readAllUxFeatureState(
  filePath: string,
  log?: Logger,
): Promise<Record<string, UxFeatureOverrides>> {
  const file = await readOrEmpty(filePath, log);
  const valid: Array<[string, UxFeatureOverrides]> = [];
  for (const [agent, entry] of Object.entries(file.agents)) {
    const overrides = parseEntry(entry);
    if (overrides) valid.push([agent, overrides]);
    else log?.warn({ agent }, "ux-feature-state entry invalid — dropping this agent only");
  }
  // fromEntries defines own properties, so an agent key can never hit a
  // prototype setter.
  return Object.fromEntries(valid);
}

/**
 * Serialises every write in this process: two concurrent toggles for the same
 * agent would otherwise both read the old file and the second rename would
 * drop the first one's feature.
 */
let writeChain: Promise<unknown> = Promise.resolve();

async function mergeAndWrite(
  filePath: string,
  agentName: string,
  feature: OverrideKey,
  enabled: boolean | ResearchModelChoice,
  log?: Logger,
): Promise<UxFeatureOverrides> {
  const existing = await readForWrite(filePath, log);
  // An invalid entry for this agent is replaced, not carried forward — the
  // write heals it. Other agents' entries are preserved untouched.
  const current = parseEntry(existing.agents[agentName]) ?? {};
  const merged: UxFeatureOverrides = Object.freeze({ ...current, [feature]: enabled });
  await writeAtomic(filePath, { ...existing.agents, [agentName]: merged }, log);
  log?.info({ agent: agentName, feature, enabled }, "ux-feature-state persisted");
  return merged;
}

/**
 * Reset (operator 2026-09-24): drop ONE feature's override for one agent, so
 * config governs it again. Same fail-closed read as a write (an unreadable
 * file refuses, a corrupt one is moved aside first). The agent's entry goes
 * entirely once it holds nothing. Nothing to drop is a no-op: no file is
 * written, not even a fresh one after a corrupt file was moved aside.
 */
async function dropAndWrite(
  filePath: string,
  agentName: string,
  feature: OverrideKey,
  log?: Logger,
): Promise<UxFeatureOverrides | null> {
  const existing = await readForWrite(filePath, log);
  const hasEntry = Object.hasOwn(existing.agents, agentName);
  const valid = hasEntry ? parseEntry(existing.agents[agentName]) : undefined;
  const rest = Object.fromEntries(Object.entries(valid ?? {}).filter(([key]) => key !== feature));
  const remaining: UxFeatureOverrides | null =
    Object.keys(rest).length > 0 ? Object.freeze(rest as UxFeatureOverrides) : null;
  // An invalid entry is dropped (the write heals it); a valid one without the feature is left alone.
  if (!hasEntry || (valid !== undefined && !Object.hasOwn(valid, feature))) return remaining;
  const others = Object.fromEntries(Object.entries(existing.agents).filter(([name]) => name !== agentName));
  await writeAtomic(filePath, remaining ? { ...others, [agentName]: remaining } : others, log);
  log?.info({ agent: agentName, feature }, "ux-feature-state override reset");
  return remaining;
}

/**
 * Drop one feature's persisted override for one agent (serialized with every
 * write). Returns the agent's remaining overrides in the file, or null.
 */
export function clearUxFeatureState(
  filePath: string,
  agentName: string,
  feature: UxFeature,
  log?: Logger,
): Promise<UxFeatureOverrides | null> {
  const run = writeChain.then(() => dropAndWrite(filePath, agentName, feature, log));
  writeChain = run.catch(() => undefined);
  return run;
}

/** Persist one feature for one agent (tmp + rename); returns the agent's merged overrides. */
export function writeUxFeatureState(
  filePath: string,
  agentName: string,
  feature: UxFeature,
  enabled: boolean,
  log?: Logger,
): Promise<UxFeatureOverrides> {
  const run = writeChain.then(() => mergeAndWrite(filePath, agentName, feature, enabled, log));
  // The caller sees a rejection; the chain survives it.
  writeChain = run.catch(() => undefined);
  return run;
}

// ---------------------------------------------------------------------
// In-memory registry — the bridge reads it on every inbound message, so no
// file IO on the hot path. Kept in step with the file: hydrated at boot, and
// set by the IPC handler alongside every write.
// ---------------------------------------------------------------------

const RUNTIME = new Map<string, UxFeatureOverrides>();

export function getUxFeatureOverrides(agentName: string): UxFeatureOverrides | undefined {
  return RUNTIME.get(agentName);
}

export function setUxFeatureOverride(agentName: string, overrides: UxFeatureOverrides | null): void {
  if (overrides === null) RUNTIME.delete(agentName);
  else RUNTIME.set(agentName, Object.freeze({ ...overrides }));
}

/** Load persisted overrides at boot; logs each one so a silent non-apply is visible. */
export async function hydrateUxFeatureOverrides(
  filePath: string,
  log?: Logger,
): Promise<Record<string, UxFeatureOverrides>> {
  const all = await readAllUxFeatureState(filePath, log);
  RUNTIME.clear();
  for (const [agent, overrides] of Object.entries(all)) {
    RUNTIME.set(agent, overrides);
    log?.info({ agent, overrides }, "re-applied persisted ux-feature overrides");
  }
  return all;
}

/**
 * Effective on/off for one feature: a boolean override wins, else config
 * (`=== true`, so absent config means off). Pure map read — safe on the
 * per-message hot path.
 */
export function resolveUxFeature(
  agentName: string,
  feature: UxFeature,
  configFeatures: UxFeatureOverrides | undefined,
): { readonly enabled: boolean; readonly source: "override" | "config" } {
  const override = RUNTIME.get(agentName)?.[feature];
  if (typeof override === "boolean") return { enabled: override, source: "override" };
  return { enabled: configFeatures?.[feature] === true, source: "config" };
}

/** 999.173 polish — persist the research model override for one agent (serialized with every write). */
export function writeResearchModelState(
  filePath: string,
  agentName: string,
  model: ResearchModelChoice,
  log?: Logger,
): Promise<UxFeatureOverrides> {
  const run = writeChain.then(() => mergeAndWrite(filePath, agentName, "researchModel", model, log));
  writeChain = run.catch(() => undefined);
  return run;
}

/** 999.173 polish — drop the research model override; config / default governs again. */
export function clearResearchModelState(
  filePath: string,
  agentName: string,
  log?: Logger,
): Promise<UxFeatureOverrides | null> {
  const run = writeChain.then(() => dropAndWrite(filePath, agentName, "researchModel", log));
  writeChain = run.catch(() => undefined);
  return run;
}

/** The research model a researcher launched now would use when nothing overrides it. */
export const DEFAULT_RESEARCH_MODEL: ResearchModelChoice = "opus";

/**
 * 999.173 polish — effective research model: the runtime override wins, then
 * the agent's `research.model`, then the default (opus). Pure map read — the
 * launch gate calls it on every researcher launch.
 */
export function resolveResearchModel(
  agentName: string,
  configModel: ResearchModelChoice | undefined,
): { readonly model: ResearchModelChoice; readonly source: "override" | "config" | "default" } {
  const override = RUNTIME.get(agentName)?.researchModel;
  if (override !== undefined) return { model: override, source: "override" };
  if (configModel !== undefined) return { model: configModel, source: "config" };
  return { model: DEFAULT_RESEARCH_MODEL, source: "default" };
}

/** Test helper — drop every in-memory override. */
export function resetUxFeatureOverridesForTests(): void {
  RUNTIME.clear();
}
