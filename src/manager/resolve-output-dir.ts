/**
 * Phase 96 Plan 04 — D-09 outputDir template token resolver.
 *
 * PURE module. No I/O, no logger, no SDK imports, no node:fs imports, no
 * bare-arg Date constructor (uses ctx.now or deps.now). Pinned by static-grep
 * regression: `! grep -E "from \"node:fs|from \"@anthropic-ai/claude-agent-sdk"
 * src/manager/resolve-output-dir.ts`.
 *
 * Tokens (resolved at write-time per call with FRESH ctx):
 *   {date}          → YYYY-MM-DD via toISOString slice
 *   {agent}         → ctx.agent
 *   {channel_name}  → ctx.channelName (Discord channel slug)
 *   {client_slug}   → ctx.clientSlug; if undefined → 'unknown-client' + warning
 *
 * Result anchored under agentWorkspaceRoot via path.join + path.resolve.
 * Path traversal blocked (no `..`, no leading `/`). After expansion, if the
 * resolved absolute path escapes agentWorkspaceRoot, the result clamps back
 * to root and emits a warning.
 *
 * INTRA-WORKSPACE boundary uses startsWith(root + sep) — D-06 forbids
 * startsWith for CROSS-workspace ACL boundary, but this is contained
 * within agent workspace root (no symlink risk, single trust domain).
 *
 * Immutability: result + warnings array Object.freeze'd. CLAUDE.md invariant.
 */

import { resolve as pathResolve, sep, isAbsolute, join } from "node:path";

export interface ResolveOutputDirContext {
  /** Agent name (for {agent} token). */
  readonly agent: string;
  /** Discord channel slug (for {channel_name} token). */
  readonly channelName?: string;
  /** Client slug (for {client_slug} token). */
  readonly clientSlug?: string;
  /** Override clock for tests; production passes a real Date. */
  readonly now?: Date;
}

export interface ResolveOutputDirDeps {
  /** Agent workspace root — output must resolve to a path under this. */
  readonly agentWorkspaceRoot: string;
  /** Optional clock injection — falls back to ctx.now or new Date(). */
  readonly now?: () => Date;
}

export interface ResolveOutputDirResult {
  /** Final absolute path resolved under agentWorkspaceRoot. */
  readonly resolved: string;
  /**
   * Operator-actionable warnings (e.g. missing client_slug → fallback;
   * path-traversal attempted → clamped to root). Frozen array; empty when
   * resolution was clean.
   */
  readonly warnings: readonly string[];
}

/**
 * Fallback value when {client_slug} token is present but ctx.clientSlug
 * is undefined. Operator can grep logs for "unknown-client" to detect
 * missed fills (e.g. agent didn't extract client name from conversation).
 */
export const CLIENT_SLUG_FALLBACK = "unknown-client";

/**
 * Format a Date as YYYY-MM-DD via toISOString slice. Pure: no locale
 * dependencies, no timezone variance.
 */
function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Resolve a D-09 outputDir template into a final absolute path under
 * agentWorkspaceRoot. Pure function: same input → same output.
 *
 * Order:
 *   1. Expand each token in turn, accumulating warnings for fallbacks.
 *   2. Refuse leading `/` or `..` patterns BEFORE filesystem join.
 *   3. Join under agentWorkspaceRoot, resolve canonically.
 *   4. Defense-in-depth: if resolved path escapes root, clamp to root.
 *
 * @param template  Raw template string from clawcode.yaml (loader returns it verbatim)
 * @param ctx       Per-call context (agent, channel, client, optional clock)
 * @param deps      Static deps (workspace root, optional clock)
 * @returns         Frozen {resolved, warnings} pair
 */
export function resolveOutputDir(
  template: string,
  ctx: ResolveOutputDirContext,
  deps: ResolveOutputDirDeps,
): ResolveOutputDirResult {
  const warnings: string[] = [];
  // Clock resolution: ctx.now wins (per-call freshness); deps.now is daemon-
  // wide injection; final fallback only used when neither is provided
  // (production daemon edge always wires deps.now to avoid this branch).
  const now = ctx.now ?? deps.now?.() ?? new Date();

  let expanded = template;

  // {date}
  expanded = expanded.replace(/\{date\}/g, formatDate(now));

  // {agent}
  expanded = expanded.replace(/\{agent\}/g, ctx.agent);

  // {channel_name}
  if (expanded.includes("{channel_name}")) {
    if (ctx.channelName === undefined) {
      expanded = expanded.replace(/\{channel_name\}/g, "unknown-channel");
      warnings.push(
        "channel_name token present but ctx.channelName undefined; fell back to unknown-channel",
      );
    } else {
      expanded = expanded.replace(/\{channel_name\}/g, ctx.channelName);
    }
  }

  // {client_slug} — D-09 fallback to CLIENT_SLUG_FALLBACK + warning
  if (expanded.includes("{client_slug}")) {
    if (ctx.clientSlug === undefined) {
      expanded = expanded.replace(/\{client_slug\}/g, CLIENT_SLUG_FALLBACK);
      warnings.push(
        `client_slug token present but ctx.clientSlug undefined; fell back to ${CLIENT_SLUG_FALLBACK}`,
      );
    } else {
      expanded = expanded.replace(/\{client_slug\}/g, ctx.clientSlug);
    }
  }

  // Path-traversal protection: refuse leading `/` (absolute) or `..` segments.
  // This check runs AFTER token expansion so a malicious clientSlug like
  // '../../etc' cannot smuggle a traversal through the data plane.
  if (isAbsolute(expanded) || expanded.includes("..")) {
    warnings.push(
      `path traversal attempted in template (${template}) or resolved value (${expanded}); clamping to agent workspace root`,
    );
    return Object.freeze({
      resolved: pathResolve(deps.agentWorkspaceRoot),
      warnings: Object.freeze([...warnings]),
    });
  }

  // Anchor under agentWorkspaceRoot.
  const joined = join(deps.agentWorkspaceRoot, expanded);
  const resolvedAbs = pathResolve(joined);
  const rootAbs = pathResolve(deps.agentWorkspaceRoot);

  // Defense-in-depth: even after `..` blocked above, a constructed string
  // might still resolve outside root (edge case via symlink-style segments).
  // INTRA-WORKSPACE startsWith is acceptable here — D-06 forbids startsWith
  // for CROSS-workspace ACL boundary, this is contained within agent root.
  if (resolvedAbs !== rootAbs && !resolvedAbs.startsWith(rootAbs + sep)) {
    warnings.push(
      `resolved path escaped agent workspace root; clamping to root`,
    );
    return Object.freeze({
      resolved: rootAbs,
      warnings: Object.freeze([...warnings]),
    });
  }

  return Object.freeze({
    resolved: resolvedAbs,
    warnings: Object.freeze([...warnings]),
  });
}
