/**
 * Phase 96 Plan 02 — system-prompt <filesystem_capability> block renderer.
 *
 * Pure module. Mirrors the Phase 94 plan 02 filter-tools-by-capability
 * shape verbatim:
 *   - No SDK imports
 *   - No node:fs imports
 *   - No bare Date constructor (clock via deps.now)
 *   - No logger
 *
 * Produces a 3-section XML-tagged block. Only entries with status='ready'
 * appear in the rendered output (degraded + unknown HIDDEN from LLM —
 * operator inspects via /clawcode-status mutable suffix from 96-05). Empty
 * snapshot strictly produces empty string (cache-stability invariant for
 * v2.5 fixtures without fileAccess declaration; W-4 ambiguity removed —
 * NO minimal placeholder block).
 *
 * Three subsections:
 *   1. ## My workspace (full RW)        — entries under agentWorkspaceRoot
 *   2. ## Operator-shared paths (per ACL) — entries NOT under root with mode='ro'
 *   3. ## Off-limits — do not attempt    — single static line "Anything outside the above."
 *
 * Within subsections 1 + 2, entries are sorted ASCII-ascending by canonical
 * path (deterministic ordering — stable-prefix cache invariant).
 *
 * Flap-stability (D-12 mirror of Phase 94 plan 02):
 *   When a path has 3+ ready ↔ non-ready transitions in a 5-min window,
 *   it's treated as degraded for the rest of the window — excluded from
 *   the rendered block even if currently 'ready'. Prevents prompt-cache
 *   prefix-hash yo-yo on flapping paths.
 *
 * Re-render contract (D-04):
 *   The block re-renders on snapshot changes only (heartbeat tick or
 *   operator force-probe via /clawcode-probe-fs from 96-05). NO Discord
 *   post on capability shift — agent reasons differently next turn from
 *   the updated stable prefix.
 */

import { sep } from "node:path";
import type { FsCapabilitySnapshot } from "../manager/persistent-session-handle.js";

/**
 * 5-minute flap-stability window. LOCKED to match Phase 94 plan 02
 * filterToolsByCapabilityProbe — same number, same semantics. Pinned by
 * static-grep in 96-02-PLAN.md (`grep -q "FS_FLAP_WINDOW_MS = 5 \\* 60 \\* 1000"`).
 */
export const FS_FLAP_WINDOW_MS = 5 * 60 * 1000;

/**
 * 3-transition threshold to mark a path as sticky-degraded for the
 * remainder of the 5-min window. Mirrors Phase 94 plan 02 verbatim.
 */
export const FS_FLAP_TRANSITION_THRESHOLD = 3;

/**
 * Per-path flap-history entry. Caller (production: SessionManager) owns
 * the Map and mutates it across heartbeat ticks. The renderer is read-only
 * over this Map.
 */
export interface FlapHistoryEntry {
  /** ISO8601 — start of the current 5-min flap window. */
  readonly windowStart: string;
  /** Count of ready ↔ non-ready transitions in the current window. */
  readonly transitions: number;
  /** True once `transitions >= FS_FLAP_TRANSITION_THRESHOLD`. */
  readonly stickyDegraded: boolean;
}

/**
 * Renderer options. All optional — production callers wire flapHistory at
 * the assembler edge; tests stub `now` for deterministic timestamps.
 */
export interface RenderFsBlockOptions {
  /** DI'd flap-stability tracker; caller owns mutability across calls. */
  readonly flapHistory?: Map<string, FlapHistoryEntry>;
  /** DI clock; production wires this at the daemon edge. */
  readonly now?: () => Date;
}

/**
 * Pure helper: returns true if the entry should be included in the rendered
 * block. Encapsulates the (status === 'ready') gate AND the sticky-degraded
 * 5-min flap-stability gate.
 *
 * Exported so unit tests + future consumers can pin the behavior without
 * driving the full renderer.
 */
export function isFsEntryAdvertisable(
  canonicalPath: string,
  state: FsCapabilitySnapshot,
  flapHistory: Map<string, FlapHistoryEntry> | undefined,
  now: Date,
): boolean {
  // Hide degraded + unknown — LLM never sees broken or unproven paths.
  if (state.status !== "ready") return false;

  // Sticky-degraded flap-stability — Phase 94 plan 02 mirror.
  // If the path has flapped 3+ times within the 5-min window, exclude it
  // for the remainder of the window so the stable-prefix hash doesn't
  // yo-yo on every heartbeat tick.
  const flap = flapHistory?.get(canonicalPath);
  if (flap?.stickyDegraded === true) {
    const windowStartMs = new Date(flap.windowStart).getTime();
    const elapsed = now.getTime() - windowStartMs;
    if (elapsed >= 0 && elapsed < FS_FLAP_WINDOW_MS) {
      return false;
    }
  }

  return true;
}

/**
 * Internal: determines whether `canonicalPath` is under `agentWorkspaceRoot`
 * (i.e. belongs in the "My workspace" subsection). Uses startsWith with a
 * trailing separator to avoid prefix-collision (e.g. /home/clawcode/.clawcode/agents/fin
 * is NOT under /home/clawcode/.clawcode/agents/acme).
 *
 * D-06 NO startsWith applies to CROSS-WORKSPACE boundary checking. Within
 * the agent's own workspace, startsWith is fine — there's no symlink risk
 * inside the agent's own root because the boot-time canonical-path
 * resolution has already collapsed symlinks.
 */
function isUnderRoot(canonicalPath: string, agentWorkspaceRoot: string): boolean {
  if (canonicalPath === agentWorkspaceRoot) return true;
  // Normalize trailing separator so root + sep doesn't double up.
  const rootWithSep = agentWorkspaceRoot.endsWith(sep)
    ? agentWorkspaceRoot
    : agentWorkspaceRoot + sep;
  return canonicalPath.startsWith(rootWithSep);
}

/**
 * Render the <filesystem_capability> block. Pure — no I/O, no clock
 * (clock comes via options.now).
 *
 * Empty snapshot ⇒ empty string (RF-EMPTY — cache-stability invariant for
 * v2.5 fixtures). When all entries are degraded/unknown/sticky, the block
 * still produces empty string — no informational block to render
 * (downstream operator surface in 96-05 carries the diagnostic).
 *
 * @param snapshot           ReadonlyMap<canonicalPath, FsCapabilitySnapshot>
 *                           keyed by canonical absPath (resolved symlinks).
 * @param agentWorkspaceRoot Canonical absPath of this agent's workspace
 *                           (e.g. /home/clawcode/.clawcode/agents/fin-client).
 * @param options            DI surface (flapHistory, now).
 */
export function renderFilesystemCapabilityBlock(
  snapshot: ReadonlyMap<string, FsCapabilitySnapshot>,
  agentWorkspaceRoot: string,
  options?: RenderFsBlockOptions,
): string {
  // Empty-snapshot short-circuit — preserves v2.5 stable-prefix hash.
  // STRICT empty string per W-4 (no minimal placeholder block).
  if (snapshot.size === 0) return "";

  const now = options?.now !== undefined ? options.now() : new Date(Date.now());
  const myWorkspace: string[] = [];
  const operatorShared: string[] = [];

  // Sort entries deterministically by canonicalPath ASCII-ascending.
  // Within each subsection, entries appear in this order — pinned by RF-SORTED.
  const sortedEntries = Array.from(snapshot.entries()).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  let anyAdvertisable = false;
  for (const [canonicalPath, state] of sortedEntries) {
    if (!isFsEntryAdvertisable(canonicalPath, state, options?.flapHistory, now)) {
      continue;
    }
    anyAdvertisable = true;
    if (isUnderRoot(canonicalPath, agentWorkspaceRoot)) {
      // Subsection 1 — RW implied by section header (no mode suffix on line)
      myWorkspace.push(`- ${canonicalPath}`);
    } else if (state.mode === "ro") {
      // Subsection 2 — RO ACL grant
      operatorShared.push(`- ${canonicalPath} (RO, ACL)`);
    }
    // mode='denied' is unreachable here because status='ready' implies
    // fs.access succeeded, which means mode is 'rw' or 'ro' — never 'denied'.
  }

  // Snapshot non-empty but ALL entries hidden (degraded/unknown/sticky)
  // ⇒ return empty string. Caller's stable prefix is unchanged.
  if (!anyAdvertisable) return "";

  const lines: string[] = [];
  lines.push("<filesystem_capability>");
  lines.push("## My workspace (full RW)");
  if (myWorkspace.length > 0) {
    lines.push(...myWorkspace);
  } else {
    lines.push("- (none)");
  }
  lines.push("");
  lines.push("## Operator-shared paths (per ACL)");
  if (operatorShared.length > 0) {
    lines.push(...operatorShared);
  } else {
    lines.push("- (none)");
  }
  lines.push("");
  lines.push("## Off-limits — do not attempt");
  lines.push("- Anything outside the above.");
  lines.push("</filesystem_capability>");

  return lines.join("\n");
}
