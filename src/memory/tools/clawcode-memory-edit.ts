/**
 * Phase 115 Plan 05 sub-scope 7 — `clawcode_memory_edit` MCP tool.
 *
 * Implements the Anthropic memory_20250818 contract on the agent's Tier 1
 * markdown files. Modes:
 *   - `view`        — read the file; ENOENT → empty string with ok:true.
 *   - `create`      — write file (overwrites existing).
 *   - `append`      — concatenate content onto the existing body.
 *   - `str_replace` — find oldStr in the file and replace with newStr.
 *
 * SECURITY (D-10 threat model rows 1+2):
 *   - Path is JAILED to <memoryRoot> via z.enum(["MEMORY.md", "USER.md"]).
 *     Operator-curated identity files (SOUL.md, IDENTITY.md) are NOT in the
 *     enum: those are operator-only (writing to SOUL would let an agent
 *     rewrite its own personality; that's a Rule 4 architectural ask, out
 *     of scope here).
 *   - Runtime jail check via `relative(memRoot, candidate).startsWith("..")`
 *     — defense-in-depth even though the zod enum already locks the path.
 *   - lstat() check refuses to write through symlinks. Symlink at the
 *     candidate path → error + log.error with action=memory-edit-symlink-blocked.
 *   - Path traversal attempts emit log.error with action=memory-edit-jail-escape.
 *
 * Per-agent isolation: memoryRoot is resolved daemon-side from
 * `cfg.memoryPath ?? cfg.workspace` (Phase 75 SHARED-01 pattern), so the
 * tool can only ever touch the calling agent's filesystem.
 */

import { z } from "zod/v4";
import { promises as fs } from "fs";
import { resolve, normalize, relative } from "path";

/**
 * Phase 115 D-10 threat model row 1 — path enum locks valid filenames.
 * SOUL.md + IDENTITY.md are intentionally NOT included: they're operator-
 * curated identity files that should never be agent-mutated (Rule 4 — out
 * of scope for this tool).
 */
export const EDIT_INPUT_SCHEMA = z.object({
  path: z.enum(["MEMORY.md", "USER.md"]),
  mode: z.enum(["view", "create", "str_replace", "append"]),
  oldStr: z.string().optional(), // for str_replace
  newStr: z.string().optional(), // for str_replace
  content: z.string().optional(), // for create / append
});

export type EditInput = z.infer<typeof EDIT_INPUT_SCHEMA>;

export interface EditDeps {
  /** Absolute path of the agent's memory root (e.g. ~/.clawcode/agents/<name>). */
  readonly memoryRoot: string;
  readonly agentName: string;
  readonly log?: {
    readonly warn?: (obj: Record<string, unknown>, msg?: string) => void;
    readonly error?: (obj: Record<string, unknown>, msg?: string) => void;
  };
}

export interface EditResult {
  readonly ok: boolean;
  readonly after?: string;
  readonly error?: string;
}

/**
 * Phase 115 Plan 05 sub-scope 7 — `clawcode_memory_edit` tool body.
 *
 * Returns `{ ok: false, error }` on any failure (jail escape, symlink,
 * missing oldStr, write error). Never throws on the security path —
 * security violations are logged and surfaced as errors to the agent so
 * the LLM gets a clean signal it must not retry the path.
 */
export async function clawcodeMemoryEdit(
  input: EditInput,
  deps: EditDeps,
): Promise<EditResult> {
  const parsed = EDIT_INPUT_SCHEMA.parse(input);

  // Jail enforcement.
  const memRoot = normalize(resolve(deps.memoryRoot));
  const candidate = normalize(resolve(memRoot, parsed.path));
  const rel = relative(memRoot, candidate);
  if (rel.startsWith("..") || rel.startsWith("/") || rel.includes("\0")) {
    deps.log?.error?.(
      {
        component: "clawcode-memory-edit",
        agent: deps.agentName,
        path: parsed.path,
        resolved: candidate,
        action: "memory-edit-jail-escape",
      },
      "[security] clawcode_memory_edit jail escape attempt blocked",
    );
    return { ok: false, error: "path outside memory root not allowed" };
  }

  // Symlink check — the file (if it exists) MUST NOT be a symlink.
  // ENOENT is fine (file may not exist yet on `create` / `append`).
  try {
    const st = await fs.lstat(candidate);
    if (st.isSymbolicLink()) {
      deps.log?.error?.(
        {
          component: "clawcode-memory-edit",
          agent: deps.agentName,
          path: parsed.path,
          action: "memory-edit-symlink-blocked",
        },
        "[security] clawcode_memory_edit symlink blocked",
      );
      return { ok: false, error: "symlinks not allowed in memory root" };
    }
  } catch (err: unknown) {
    if ((err as { code?: string })?.code !== "ENOENT") {
      throw err;
    }
  }

  switch (parsed.mode) {
    case "view": {
      try {
        const text = await fs.readFile(candidate, "utf8");
        return { ok: true, after: text };
      } catch (err: unknown) {
        if ((err as { code?: string })?.code === "ENOENT") {
          return { ok: true, after: "" };
        }
        throw err;
      }
    }

    case "create": {
      if (typeof parsed.content !== "string") {
        return { ok: false, error: "create requires content" };
      }
      await fs.writeFile(candidate, parsed.content, "utf8");
      return { ok: true, after: parsed.content };
    }

    case "append": {
      if (typeof parsed.content !== "string") {
        return { ok: false, error: "append requires content" };
      }
      let existing = "";
      try {
        existing = await fs.readFile(candidate, "utf8");
      } catch (err: unknown) {
        if ((err as { code?: string })?.code !== "ENOENT") {
          throw err;
        }
      }
      const next = existing + parsed.content;
      await fs.writeFile(candidate, next, "utf8");
      return { ok: true, after: next };
    }

    case "str_replace": {
      if (typeof parsed.oldStr !== "string" || typeof parsed.newStr !== "string") {
        return { ok: false, error: "str_replace requires oldStr and newStr" };
      }
      let existing: string;
      try {
        existing = await fs.readFile(candidate, "utf8");
      } catch (err: unknown) {
        if ((err as { code?: string })?.code === "ENOENT") {
          return { ok: false, error: "file not found" };
        }
        throw err;
      }
      if (!existing.includes(parsed.oldStr)) {
        return { ok: false, error: "oldStr not found in file" };
      }
      const next = existing.replace(parsed.oldStr, parsed.newStr);
      await fs.writeFile(candidate, next, "utf8");
      return { ok: true, after: next };
    }
  }
}
