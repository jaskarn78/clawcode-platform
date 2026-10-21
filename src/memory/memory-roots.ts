/**
 * Phase 999.187 — one resolver for every memory path an agent reads or writes.
 *
 * WHY. Five code paths used to derive the agent's memory files independently:
 * the prompt loaded `<workspace>/MEMORY.md`, the `clawcode_memory_edit` tool
 * wrote `<memoryPath>/MEMORY.md`, the cue writer and the mid-session flush
 * wrote under `<workspace>/memory`, the daily session log and consolidation
 * used `<memoryPath>/memory`, and the dream pass used `memoryPath ?? workspace`.
 * They agree only when `memoryPath` is unset. On prod, `client-a-personal` and
 * `state-contract` set `memoryPath: <workspace>/memory`, so the agent edited a
 * MEMORY.md the prompt never loaded; fin-client hit the same split on
 * 2026-08-26 and was hand-patched with `memoryAutoLoadPath`.
 *
 * RULE. There is exactly one Tier 1 directory per agent:
 *   - `memoryAutoLoadPath` set → the directory that file lives in;
 *   - else `memoryPath` (loader fills it from `workspace` when omitted).
 * MEMORY.md and USER.md are read from and written to that directory, by the
 * prompt loader, the edit and archive tools, the dream pass and the dashboard
 * snapshot alike. Dated memory files (`memory/*.md`) live under
 * `<memoryPath>/memory`, where the daily session log and consolidation already
 * put them; the cue writer and the flush timer now write there too.
 *
 * `legacyMemoryMdPath` / `legacyUserMdPath` name the pre-999.187 prompt
 * locations when they differ from the canonical ones. The prompt loader
 * falls back to them (with a warning) when the canonical file is absent, so
 * an agent whose curated memory still sits in the shared workspace keeps
 * it until the file is moved.
 *
 * Pure: no I/O.
 */

import { dirname, join, resolve } from "node:path";

export interface MemoryRootsInput {
  readonly workspace: string;
  readonly memoryPath?: string | null;
  readonly memoryAutoLoadPath?: string | null;
}

export interface MemoryRoots {
  /** Directory holding MEMORY.md and USER.md (the Tier 1 curated files). */
  readonly tier1Dir: string;
  readonly memoryMdPath: string;
  readonly userMdPath: string;
  /** Directory of dated memory files: daily logs, cues, flushes, digests/. */
  readonly memoryDir: string;
  /** Pre-999.187 prompt location for MEMORY.md when it differs, else null. */
  readonly legacyMemoryMdPath: string | null;
  /** Pre-999.187 location for USER.md when it differs, else null. */
  readonly legacyUserMdPath: string | null;
}

function nonEmpty(v: string | null | undefined): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

export function resolveMemoryRoots(input: MemoryRootsInput): MemoryRoots {
  const workspace = resolve(input.workspace);
  const memoryPath = nonEmpty(input.memoryPath);
  const autoLoad = nonEmpty(input.memoryAutoLoadPath);
  const stateRoot = memoryPath ? resolve(memoryPath) : workspace;
  const tier1Dir = autoLoad ? dirname(resolve(autoLoad)) : stateRoot;
  const memoryMdPath = autoLoad ? resolve(autoLoad) : join(tier1Dir, "MEMORY.md");
  const userMdPath = join(tier1Dir, "USER.md");
  const memoryDir = join(stateRoot, "memory");
  const legacyMemoryMd = join(workspace, "MEMORY.md");
  const legacyUserMd = join(workspace, "USER.md");
  return Object.freeze({
    tier1Dir,
    memoryMdPath,
    userMdPath,
    memoryDir,
    legacyMemoryMdPath: legacyMemoryMd === memoryMdPath ? null : legacyMemoryMd,
    legacyUserMdPath: legacyUserMd === userMdPath ? null : legacyUserMd,
  });
}

/**
 * True when `dir` is `root` or lies beneath it. Used by the daemon to decide
 * whether the memory scanner's `<workspace>/memory` watch already covers the
 * agent's `memoryDir`, or a second watch root is needed.
 */
export function isWithinDir(root: string, dir: string): boolean {
  const r = resolve(root);
  const d = resolve(dir);
  return d === r || d.startsWith(r.endsWith("/") ? r : r + "/");
}
