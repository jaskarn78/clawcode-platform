/**
 * Phase 96 Plan 03 — D-07 / D-08 auto-injected directory listing tool.
 *
 * The tool is auto-injected for every agent (alongside Phase 94's
 * `clawcode_fetch_discord_messages` and `clawcode_share_file`). It lets
 * the LLM drill into directories the system-prompt block (96-02)
 * advertises at the path-root level — Phase 96 closes the "I see the
 * path is RO but I can't see WHAT'S in it" gap.
 *
 * Token-guarded:
 *   - depth max 3, default 1 (immediate children)
 *   - entries max 500 per call (truncation message at limit)
 *   - case-sensitive substring glob filter
 *
 * Boundary-checked through 96-01's `checkFsCapability(path, snapshot)` —
 * single-source-of-truth (D-06). Out-of-allowlist refusals carry
 * alternatives via `findAlternativeFsAgents` (D-08) — when fin-client
 * can't read /home/X but admin-clawdy can, the LLM gets that hint
 * structured into the ToolCallError.
 *
 * DI-pure module:
 *   - No node:fs imports — production wires node:fs/promises.readdir +
 *     node:fs/promises.stat at the daemon edge.
 *   - No discord.js imports.
 *   - Uses node:path (pure string ops) only for joining child paths
 *     during recursion — not a side-effect dep, no I/O.
 *
 * Failures wrap via Phase 94's `wrapMcpToolError` from tool-call-error.ts.
 * The 5-value ErrorClass enum is LOCKED (transient | auth | quota |
 * permission | unknown) — NOT extended in this plan. Mapping:
 *   - boundary refusal → 'permission'
 *   - depth/entries-exceeded → 'unknown' with rich suggestion
 *   - readdir EACCES (race) → 'permission' (regex-based via classifier)
 *   - readdir ENOENT / other → 'unknown' (verbatim message preserved)
 */

import { join } from "node:path";
import type { Logger } from "pino";
import { wrapMcpToolError, type ToolCallError } from "../tool-call-error.js";
import type {
  FsCapabilityMode,
  FsCapabilitySnapshot,
} from "../persistent-session-handle.js";

/**
 * D-07 token-guard constants. LOCKED — pinned by static-grep regression
 * tests in 96-03-PLAN.md acceptance criteria. Adjusting requires explicit
 * STATE.md decision because consumers (96-02 system-prompt block,
 * verifier) reference these limits.
 */
export const MAX_LIST_FILES_DEPTH = 3;
export const MAX_LIST_FILES_ENTRIES = 500;

/**
 * Pinned truncation message (CONTEXT.md "Claude's Discretion"). Exposed as
 * a module export so the system-prompt renderer (96-02) can show the same
 * wording to operators in the operator-truth display.
 */
export const LIST_FILES_TRUNCATION_MESSAGE =
  "[...truncated, use glob filter or specific subpath]";

/**
 * Tool input shape — JSON-Schema-validated by the SDK before reaching the
 * handler. depth has a schema-level max=3 too so misbehaving prompts get
 * rejected client-side BEFORE entering the handler; the handler still
 * defends in depth as a belt-and-suspenders check.
 */
export interface ListFilesInput {
  readonly path: string;
  /** 0 = just the root listing; 1 = immediate children; max 3. Default 1. */
  readonly depth?: number;
  /** Case-sensitive substring filter applied to entry names. */
  readonly glob?: string;
}

/**
 * One listing entry. Files carry size + mtime (ISO8601); directories carry
 * only name + type (no size — directory size is OS-specific and cheap to
 * skip; mtime is also less interesting for directories in this use case).
 */
export interface ListFilesEntry {
  readonly name: string;
  readonly type: "file" | "dir";
  /** File only: byte size from fs.stat. */
  readonly size?: number;
  /** File only: ISO8601 modified-time from fs.stat. */
  readonly mtime?: string;
}

export interface ListFilesOutput {
  readonly entries: readonly ListFilesEntry[];
  /** True when collection hit MAX_LIST_FILES_ENTRIES; suggests refining glob/path. */
  readonly truncated: boolean;
}

/**
 * Pure-DI deps surface. Production wires:
 *   - checkFsCapability → curried `checkFsCapability(rawPath, snapshot, fsDeps)`
 *     from `src/manager/fs-capability.ts` (96-01)
 *   - readdir → node:fs/promises.readdir(path, {withFileTypes:true})
 *   - stat → node:fs/promises.stat(absPath) mapped to {size, mtime}
 *   - findAlternativeFsAgents → curried `findAlternativeFsAgents(absPath, deps)`
 *     with deps from agent registry
 *   - getFsCapabilitySnapshot → SessionHandle.getFsCapabilitySnapshot.bind(handle)
 *   - log → pino logger
 *
 * Tests stub everything; no production-side imports leak in.
 */
export interface ListFilesDeps {
  /** D-06 single-source-of-truth boundary — MUST be called BEFORE readdir. */
  readonly checkFsCapability: (
    rawPath: string,
    snapshot: ReadonlyMap<string, FsCapabilitySnapshot>,
  ) => Promise<
    | {
        readonly allowed: true;
        readonly canonicalPath: string;
        readonly mode: FsCapabilityMode;
      }
    | { readonly allowed: false; readonly reason: string }
  >;
  /**
   * Read a directory; returns Dirent-shaped objects with isFile()/isDirectory()
   * methods. Production wraps node:fs/promises.readdir(path, {withFileTypes:true}).
   */
  readonly readdir: (path: string) => Promise<
    ReadonlyArray<{
      readonly name: string;
      isFile: () => boolean;
      isDirectory: () => boolean;
    }>
  >;
  /**
   * stat a file — {size, mtime}. Production wraps node:fs/promises.stat
   * (selecting the two fields needed). Only called for files (not dirs).
   */
  readonly stat: (path: string) => Promise<{
    readonly size: number;
    readonly mtime: Date;
  }>;
  /** D-08 cross-agent alternatives lookup for permission-class refusals. */
  readonly findAlternativeFsAgents: (absPath: string) => readonly string[];
  /** Snapshot accessor — wraps SessionHandle.getFsCapabilitySnapshot. */
  readonly getFsCapabilitySnapshot: () => ReadonlyMap<
    string,
    FsCapabilitySnapshot
  >;
  readonly log: Logger;
}

/**
 * Tool definition shape — the keys the SDK tool registry expects. NO
 * `mcpServer` attribution: built-in helper, so the Plan 94-02 capability-
 * probe filter never removes it.
 *
 * Description is ABSTRACT — never references `/home/clawcode/...` or any
 * other deployment-specific path. The agent's fileAccess allowlist
 * (resolved per-agent via 96-01) is the runtime authority.
 */
export const CLAWCODE_LIST_FILES_DEF = {
  name: "clawcode_list_files",
  description:
    "List directory entries inside a path the agent has read access to. " +
    "Returns {entries: [{name, type, size?, mtime?}], truncated}. " +
    "Refuses paths outside the agent's fileAccess allowlist (returns " +
    "ToolCallError with errorClass='permission' and a suggestion to ask " +
    "the operator to extend fileAccess in clawcode.yaml or to consult " +
    "another agent that already has the path in scope). " +
    "depth defaults to 1 (immediate children); max 3. entries cap at " +
    "500 per call (truncated=true at limit). glob match is case-sensitive " +
    "substring (Linux fs is case-sensitive). " +
    "Use this to discover what's inside an operator-shared path before " +
    "calling Read/clawcode_share_file on a specific entry.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Absolute path inside the agent's fileAccess allowlist; canonicalized internally (symlinks resolved, .. collapsed)",
      },
      depth: {
        type: "number",
        minimum: 0,
        maximum: MAX_LIST_FILES_DEPTH,
        description: `Recursion depth (0 = root listing only, default 1, max ${MAX_LIST_FILES_DEPTH})`,
      },
      glob: {
        type: "string",
        description:
          "Case-sensitive substring filter — entry name must contain this string",
      },
    },
    required: ["path"],
  },
} as const;

/**
 * Build the suggestion for a depth/entries token-guard refusal — `unknown`
 * errorClass with rich actionable text the LLM can use to retry with a
 * narrower request.
 */
function depthExceededSuggestionFor() {
  return () =>
    `depth max is ${MAX_LIST_FILES_DEPTH}; use a more specific subpath`;
}

/**
 * Build the suggestion for a permission-class refusal — D-08. Suggestion
 * mentions both fix paths (operator extends fileAccess; or another agent
 * has the path) and embeds the alternatives inline so the LLM sees the
 * names verbatim.
 */
function permissionSuggestionFor(alternatives: readonly string[]) {
  const altText =
    alternatives.length > 0
      ? `; alternatives: [${alternatives.join(", ")}]`
      : "";
  return () =>
    `Ask operator to add to clawcode.yaml fileAccess, or check if another agent has it in scope${altText}`;
}

/**
 * Pure handler. Always returns a value — never throws (LLM tool-result
 * contract). Failures wrap via Phase 94 `wrapMcpToolError`.
 *
 * Order:
 *   1. Validate depth (range check + default)
 *   2. checkFsCapability(path, snapshot) — D-06 boundary BEFORE readdir
 *   3. If refused: build permission ToolCallError carrying alternatives
 *   4. Recurse into listAtDepth, accumulating entries up to MAX
 *   5. Apply glob filter (case-sensitive substring) inline during enum
 *   6. Return {entries: frozen, truncated} or wrap any thrown fs error
 */
export async function clawcodeListFiles(
  input: ListFilesInput,
  deps: ListFilesDeps,
): Promise<ListFilesOutput | ToolCallError> {
  // 1. Validate depth — defend in depth even though SDK schema enforces it.
  const depth = input.depth ?? 1;
  if (depth < 0 || depth > MAX_LIST_FILES_DEPTH) {
    return wrapMcpToolError(
      new Error(
        `depth ${depth} out of range — depth max is ${MAX_LIST_FILES_DEPTH}; use a more specific subpath`,
      ),
      {
        tool: CLAWCODE_LIST_FILES_DEF.name,
        suggestionFor: depthExceededSuggestionFor(),
      },
    );
  }

  // 2. D-06 single-source-of-truth boundary check — MUST run BEFORE any
  //    deps.readdir call. Phase 94's regex-based classifier maps EACCES /
  //    permission-denied messages to errorClass='permission' on its own.
  const snapshot = deps.getFsCapabilitySnapshot();
  const boundary = await deps.checkFsCapability(input.path, snapshot);

  // 3. Boundary refused → permission-class ToolCallError carrying
  //    alternatives. We MUST NOT call deps.readdir.
  if (!boundary.allowed) {
    const alternatives = deps.findAlternativeFsAgents(input.path);
    const refused = wrapMcpToolError(
      new Error(
        `path ${input.path} is outside this agent's fileAccess allowlist (permission denied: ${boundary.reason})`,
      ),
      {
        tool: CLAWCODE_LIST_FILES_DEF.name,
        findAlternatives: () => alternatives,
        suggestionFor: permissionSuggestionFor(alternatives),
      },
    );
    return refused;
  }

  // 4. Recurse with token guards. Collect into a mutable array; freeze on
  //    return. truncated=true the moment we hit MAX_LIST_FILES_ENTRIES.
  const collected: ListFilesEntry[] = [];
  let truncated = false;
  try {
    truncated = await listAtDepth(
      boundary.canonicalPath,
      depth,
      collected,
      input.glob,
      deps,
    );
  } catch (err) {
    // Any thrown fs error here (ENOENT / EACCES race / etc) wraps via
    // Phase 94 classifier — EACCES becomes 'permission' (regex match);
    // ENOENT and others become 'unknown'.
    return wrapMcpToolError(err as Error | string, {
      tool: CLAWCODE_LIST_FILES_DEF.name,
    });
  }

  // 5. Freeze and return. Entries beyond MAX are NOT included; truncated
  //    flag tells the LLM to refine glob/path.
  const sliced = collected.slice(0, MAX_LIST_FILES_ENTRIES);
  return Object.freeze({
    entries: Object.freeze(sliced),
    truncated,
  });
}

/**
 * Recursive enumeration helper. Returns true when MAX_LIST_FILES_ENTRIES
 * was hit (caller sets truncated=true). Side-effect on `collected` is
 * intentional — accumulator pattern keeps the recursion simple and the
 * entry cap deterministic across nested directories.
 *
 * Depth semantics:
 *   `levelsLeft` counts the TOTAL readdir calls allowed including the
 *   one this function is about to make. So:
 *     - levelsLeft=1 → readdir at absPath, NO recursion into subdirs
 *     - levelsLeft=2 → readdir at absPath, recurse with levelsLeft=1
 *     - levelsLeft=3 → readdir at absPath, recurse with levelsLeft=2
 *
 *   Caller passes `depth` directly; depth=1 (the default) means "list the
 *   root, don't recurse"; depth=3 means "root + 2 levels of recursion",
 *   yielding at most 3 readdir calls along any single path. depth=0 is
 *   accepted by the schema (validated against negative bounds) and means
 *   "no readdir at all" — returns an empty entry list.
 *
 * Algorithm:
 *   1. If levelsLeft < 1 → return (no readdir; depth=0 caller).
 *   2. readdir(absPath) → array of dirents
 *   3. For each dirent:
 *      a. Apply case-sensitive glob filter if provided (name.includes).
 *      b. If file: stat → push {name, type:'file', size, mtime}.
 *      c. If dir: push {name, type:'dir'} (no size/mtime); if levelsLeft
 *         > 1, recurse with levelsLeft-1.
 *      d. If collected.length >= MAX → return true (truncated).
 */
async function listAtDepth(
  absPath: string,
  levelsLeft: number,
  collected: ListFilesEntry[],
  glob: string | undefined,
  deps: ListFilesDeps,
): Promise<boolean> {
  // depth=0 → no readdir at all. Empty entries returned via accumulator.
  if (levelsLeft < 1) {
    return false;
  }

  // Defense: if collector already at the cap (e.g. set by a prior sibling
  // dir's recursion), short-circuit so we don't call readdir spuriously.
  if (collected.length >= MAX_LIST_FILES_ENTRIES) {
    return true;
  }

  const dirents = await deps.readdir(absPath);

  for (const dirent of dirents) {
    if (collected.length >= MAX_LIST_FILES_ENTRIES) {
      return true;
    }

    const isFile = dirent.isFile();
    const isDir = dirent.isDirectory();
    // Apply glob filter — case-sensitive substring (Linux fs is case-
    // sensitive; production target Linux). Per CONTEXT.md Open Question 6:
    // picomatch NOT in deps; substring fallback is good enough for v1.
    if (glob !== undefined && glob !== "" && !dirent.name.includes(glob)) {
      // We still might recurse INTO a non-matching directory because users
      // commonly want to find files under a parent that doesn't itself match.
      // But the entry list reflects only matches; recursion below is gated
      // separately on levelsLeft.
      if (isDir && levelsLeft > 1) {
        const childPath = join(absPath, dirent.name);
        const childTruncated = await listAtDepth(
          childPath,
          levelsLeft - 1,
          collected,
          glob,
          deps,
        );
        if (childTruncated) return true;
      }
      continue;
    }

    if (isFile) {
      // Read size + mtime via deps.stat — failures here propagate up to
      // the caller's wrapMcpToolError (Phase 94 classifier maps EACCES
      // to 'permission', other failures to 'unknown').
      const childPath = join(absPath, dirent.name);
      const stat = await deps.stat(childPath);
      collected.push(
        Object.freeze({
          name: dirent.name,
          type: "file" as const,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
        }),
      );
    } else if (isDir) {
      collected.push(
        Object.freeze({
          name: dirent.name,
          type: "dir" as const,
        }),
      );
      // Recurse if depth budget allows. Decrementing levelsLeft ensures
      // the recursion guard refuses depth exhaustion — protects against
      // 100-level deep symlink chain DoS scenarios (the canonical-path
      // resolution in checkFsCapability already collapses simple symlinks
      // but the depth cap is the ultimate guard).
      if (levelsLeft > 1) {
        const childPath = join(absPath, dirent.name);
        const childTruncated = await listAtDepth(
          childPath,
          levelsLeft - 1,
          collected,
          glob,
          deps,
        );
        if (childTruncated) return true;
      }
    }
    // Non-file/non-dir dirents (sockets, devices, etc.) silently skipped —
    // out of scope for v1.
  }

  return collected.length >= MAX_LIST_FILES_ENTRIES;
}
