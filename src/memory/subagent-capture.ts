/**
 * Phase 90 MEM-06 — subagent final-report capture to memory/.
 *
 * Closes the Apr 23 "do you recall the Opus subagent you spawned?" crisis:
 * when a parent agent's Task(...) tool returns, its last assistant turn
 * (the subagent's final report) was previously discarded. MEM-06 writes
 * it to {workspace}/memory/YYYY-MM-DD-subagent-<slug>.md with frontmatter
 * (spawned_at, duration_ms, subagent_type, task_description, return_summary).
 *
 * D-33: slug = first 40 chars of task_description, lowercased + hyphenated
 * + stripped of non-[a-z0-9-].
 * D-34: content shape = frontmatter (5 fields) + "## Task" + "## Return Summary".
 * D-35 (exclusion): gsd-* subagents are SKIPPED — GSD has its own planning
 * artifacts under .planning/ and would spam memory/ if captured here.
 *
 * Same-day slug collision handling (Claude's discretion per plan §specifics):
 * if the target path already exists, append a nanoid(4) suffix. Prevents
 * "two researcher calls on the same task description" from overwriting
 * each other.
 *
 * Like memory-flush and memory-cue, this module uses atomicWriteFile from
 * memory-flush.ts — three writers, one atomic-write discipline.
 */

import { join } from "node:path";
import { stat } from "node:fs/promises";
import { nanoid } from "nanoid";
import type { Logger } from "pino";
import { atomicWriteFile } from "./memory-flush.js";

/**
 * D-35 — gsd-* subagent types are excluded from memory capture. These are
 * GSD internal agents (gsd-planner, gsd-researcher, gsd-executor, ...)
 * whose output belongs in .planning/ SUMMARY + STATE artifacts, not the
 * agent's memory stream.
 *
 * A `/^gsd-/` prefix is exact-match by design: a user writing a skill
 * called "gsd-helper" as their own subagent WOULD be excluded; that
 * collision is preferred over a more lenient regex that could accidentally
 * capture gsd-* orchestration output.
 */
export function isGsdSubagent(subagent_type: string): boolean {
  return /^gsd-/.test(subagent_type);
}

/**
 * D-33 slug transformer. Pipeline:
 *   1. lowercase
 *   2. drop non-[a-z0-9\s-]
 *   3. trim edges
 *   4. collapse whitespace runs to single hyphens
 *   5. collapse hyphen runs to single hyphen
 *   6. cap at 40 chars
 *   7. trim trailing hyphen (avoids "foo-bar-.md" artifacts)
 *
 * Returns "" when input has no a-z0-9 content (caller substitutes
 * fallback slug "subagent").
 */
export function subagentSlug(task_description: string): string {
  return task_description
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 40)
    .replace(/-+$/, "");
}

/**
 * Write the captured subagent return to the parent agent's memory/
 * directory. Returns the file path on success, null when the subagent
 * was excluded by D-35.
 */
export async function captureSubagentReturn(
  args: Readonly<{
    workspacePath: string;
    subagent_type: string;
    task_description: string;
    return_summary: string;
    spawned_at_iso: string;
    duration_ms: number;
    log: Logger;
  }>,
): Promise<string | null> {
  if (isGsdSubagent(args.subagent_type)) {
    args.log.debug(
      { subagent_type: args.subagent_type },
      "subagent capture skipped (gsd-* exclusion)",
    );
    return null;
  }

  const date = args.spawned_at_iso.slice(0, 10);
  const baseSlug = subagentSlug(args.task_description) || "subagent";
  let path = join(
    args.workspacePath,
    "memory",
    `${date}-subagent-${baseSlug}.md`,
  );

  // Collision handling — if the target exists (same task description, same
  // day), append a nanoid suffix so neither write clobbers the other.
  try {
    await stat(path);
    path = join(
      args.workspacePath,
      "memory",
      `${date}-subagent-${baseSlug}-${nanoid(4)}.md`,
    );
  } catch {
    /* does not exist — primary path is free */
  }

  const body = `---
type: subagent-return
spawned_at: ${args.spawned_at_iso}
duration_ms: ${args.duration_ms}
subagent_type: ${args.subagent_type}
task_description: ${JSON.stringify(args.task_description)}
---

## Task

${args.task_description}

## Return Summary

${args.return_summary}
`;
  await atomicWriteFile(path, body);
  args.log.info(
    { path, subagent_type: args.subagent_type },
    "subagent return captured",
  );
  return path;
}
