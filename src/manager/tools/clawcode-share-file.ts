/**
 * Phase 94 Plan 05 + Phase 96 Plan 04 — auto-injected Discord file-share helper.
 *
 * The tool is auto-injected for every agent and turns the file-sharing
 * system-prompt directive (Plan 94-06 + Phase 96 D-10 extension) from prose
 * into action: agents stop emitting "see /home/clawcode/output.png" and
 * instead upload to Discord, returning the CDN URL the user can click.
 *
 * Phase 96 extensions (D-09 + D-12):
 *   1. outputDir-aware path resolution — when input.path is RELATIVE and
 *      outputDirTemplate + agentWorkspaceRoot + resolveCtx are all wired,
 *      the relative path is anchored under resolveOutputDir(template, ctx).
 *      Files anywhere in fileAccess remain shareable; outputDir is the
 *      DEFAULT landing for relative paths.
 *   2. classifyShareFileError — pure helper mapping the D-12 4-class
 *      taxonomy (size/missing/permission/transient) onto Phase 94's locked
 *      5-value ErrorClass enum (size/missing → unknown with rich suggestion;
 *      permission → permission; transient → transient). NO enum extension.
 *
 * DI-pure module. No fs imports, no discord.js imports, no clock
 * construction. Production wires:
 *   - allowedRoots → [agent.workspacePath, agent.memoryPath].filter(Boolean)
 *   - outputDirTemplate → resolveOutputDirTemplate(agent, cfg, defaults)
 *   - resolveCtx → () => ({agent, channelName, clientSlug, now}) from current TurnDispatcher origin
 *   - sendViaWebhook → webhook-manager (Phase 1.6)
 *   - sendViaBot → bot-direct fallback (Phase 90.1) — used when webhook
 *     fails or admin-clawdy / untrusted channels lack webhooks
 *   - currentChannelId → derived from current TurnDispatcher origin
 *   - stat → fs.promises.stat mapped to {size, isFile}
 *
 * Security boundary: path validation refuses anything outside
 * allowedRoots. Without this gate, a bad-actor LLM could pipe
 * /etc/passwd through Discord. allowedRoots is the only acceptable
 * upload surface.
 *
 * Discord 25MB free-tier upload cap is enforced. Higher caps require
 * Nitro per-channel (outside the bot's control).
 *
 * Internal failures wrap via Plan 94-04 wrapMcpToolError + Phase 96
 * classifyShareFileError. The 5-value ErrorClass enum is LOCKED at
 * (transient | auth | quota | permission | unknown) — no `size` or
 * `missing` values introduced (Pitfall 3 + Pitfall 7 from RESEARCH.md).
 */

import { resolve, sep, basename, isAbsolute, join } from "node:path";
import type { Logger } from "pino";
import { wrapMcpToolError, type ToolCallError, type ErrorClass } from "../tool-call-error.js";
import { resolveOutputDir } from "../resolve-output-dir.js";

export interface ShareFileInput {
  readonly path: string;
  readonly caption?: string;
}

export interface ShareFileOutput {
  /** Discord CDN URL the user can click. */
  readonly url: string;
  readonly filename: string;
  readonly sizeBytes: number;
  /**
   * UX-A (2026-08-26) — the posted share message's id/channel, when the
   * upload surface reports them. Additive-optional: legacy surfaces that
   * return only `{url}` keep working. The daemon uses these to mark a
   * previous share of the same document as superseded.
   */
  readonly messageId?: string;
  readonly channelId?: string;
}

export interface ShareFileDeps {
  /**
   * Allowed upload roots — paths must resolve to a location inside one
   * of these (security boundary). Production wires
   * [agent.workspacePath, agent.memoryPath].
   */
  readonly allowedRoots: readonly string[];
  /** Phase 1.6 webhook upload surface — primary path. */
  readonly sendViaWebhook: (
    channelId: string,
    file: { path: string; filename: string; caption?: string },
  ) => Promise<{ url: string; messageId?: string; channelId?: string }>;
  /** Phase 90.1 bot-direct upload — fallback when webhook fails. */
  readonly sendViaBot: (
    channelId: string,
    file: { path: string; filename: string; caption?: string },
  ) => Promise<{ url: string; messageId?: string; channelId?: string }>;
  /**
   * Inferred from the current dispatch context (TurnDispatcher origin).
   * Returns undefined when the agent is not currently bound to a
   * channel — the tool refuses with a structured error so the LLM
   * surfaces the missing context.
   */
  readonly currentChannelId: () => string | undefined;
  /** Stat indirection — DI-pure (no fs imports in this module). */
  readonly stat: (path: string) => Promise<{ size: number; isFile: boolean }>;
  readonly log: Logger;
  /**
   * Phase 96 D-09 — optional outputDir template (e.g. "clients/{client_slug}/{date}/").
   * When set alongside agentWorkspaceRoot + resolveCtx, RELATIVE input paths
   * are anchored under resolveOutputDir(template, ctx, {agentWorkspaceRoot}).
   * Absolute input paths bypass outputDir entirely (treated as fileAccess
   * paths via existing allowedRoots check).
   */
  readonly outputDirTemplate?: string;
  /** Phase 96 D-09 — agent workspace root for outputDir anchoring. */
  readonly agentWorkspaceRoot?: string;
  /**
   * Phase 96 D-09 — runtime ctx provider for outputDir token expansion.
   * Called per share invocation so {date} is fresh and {client_slug} can
   * change per conversation. When omitted, outputDir resolution is skipped.
   */
  readonly resolveCtx?: () => {
    agent: string;
    channelName?: string;
    clientSlug?: string;
    now?: Date;
  };
}

/**
 * Discord free-tier upload cap. Higher caps require Nitro per-channel.
 * Pinned by static-grep regression test.
 */
export const DISCORD_FILE_SIZE_LIMIT = 25 * 1024 * 1024;

/**
 * Tool definition shape. NO mcpServer attribution: built-in helper, so
 * the Plan 94-02 capability-probe filter never removes it.
 *
 * The example path '/home/clawcode/...' below appears as a NEGATIVE
 * pattern — the directive instructs agents NOT to surface those raw
 * paths to the user; instead, call this tool to get a CDN URL.
 */
export const CLAWCODE_SHARE_FILE_DEF = {
  name: "clawcode_share_file",
  description:
    "Upload a file from the agent's workspace to the Discord channel/thread the agent is currently answering in. " +
    "Returns the CDN URL the user can click. " +
    "Use this WHENEVER the user wants a file — never tell the user a local path " +
    "(e.g. /home/clawcode/...). " +
    "Path must be absolute and inside the agent's workspace or memory directory, " +
    "OR relative — relative paths are resolved against the agent's outputDir " +
    "(typically 'clients/{client_slug}/{date}/' for client-scoped agents).",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Absolute path inside agent workspace or memoryPath, OR relative path resolved against agent outputDir",
      },
      caption: {
        type: "string",
        description: "Optional caption sent alongside the file",
      },
    },
    required: ["path"],
  },
} as const;

/**
 * Phase 96 D-12 classification result. The errorClass field uses Phase 94's
 * locked 5-value enum (transient|auth|quota|permission|unknown) — D-12's
 * 4-class taxonomy (size/missing/permission/transient) maps onto these:
 *   size       → 'unknown' + suggestion mentioning 25MB Discord limit
 *   missing    → 'unknown' + suggestion 'file not found at /path/X'
 *   permission → 'permission' + fileAccess allowlist hint (D-08)
 *   transient  → 'transient' + 'retry in 30s' hint
 *
 * NO enum extension (Pitfall 3 + Pitfall 7 from RESEARCH.md).
 */
interface ShareFileErrorClassification {
  readonly errorClass: ErrorClass;
  readonly suggestion: string;
}

/**
 * Pure helper: classify a share-file failure into Phase 94's 5-value enum
 * + per-class suggestion text. NO side effects — no logging, no Date,
 * regex-only.
 *
 * Order matters: permission BEFORE size (a /etc/passwd refusal returns
 * EACCES which would otherwise classify as transient at the OS layer).
 * size BEFORE missing (a 25MB error is more specific than ENOENT).
 */
export function classifyShareFileError(
  err: unknown,
): ShareFileErrorClassification {
  const msg = err instanceof Error ? err.message : String(err);

  // PERMISSION first — outside-allowlist refusals + EACCES.
  if (/EACCES|permission denied|outside.*allowlist|outside.*workspace|refused by clawcode_share_file|permission/i.test(msg)) {
    return {
      errorClass: "permission",
      suggestion:
        "path is outside this agent's fileAccess allowlist; ask operator to add to clawcode.yaml fileAccess, or check if another agent has it in scope",
    };
  }

  // SIZE → unknown (NO enum drift) + 25MB Discord limit hint.
  if (/exceeds the Discord 25MB|exceeds.*25.MB|file.*size.*limit|too large/i.test(msg)) {
    // Try to extract the actual MB number for a sharper suggestion.
    const mbMatch = msg.match(/is\s*(\d+(?:\.\d+)?)\s*MB/i);
    const sizeStr = mbMatch ? `file is ${mbMatch[1]} MB` : "file size exceeds";
    return {
      errorClass: "unknown",
      suggestion: `${sizeStr}; Discord limit is 25MB — compress or split the file`,
    };
  }

  // MISSING → unknown (NO enum drift) + file-not-found hint.
  if (/ENOENT|no such file|not a regular file/i.test(msg)) {
    // Extract path if present in the verbatim message.
    const pathMatch = msg.match(/'([^']+)'/);
    const pathHint = pathMatch ? pathMatch[1] : "the path";
    return {
      errorClass: "unknown",
      suggestion: `file not found at ${pathHint} — verify the path and re-run`,
    };
  }

  // TRANSIENT → transient + retry hint.
  if (/rate.?limit|429|5\d{2}|timeout|ECONNRESET|webhook.*failed/i.test(msg)) {
    return {
      errorClass: "transient",
      suggestion: "Discord upload failed (rate limit or 5xx) — retry in 30s",
    };
  }

  return { errorClass: "unknown", suggestion: msg };
}

/**
 * Pure path-validation: returns true iff `absPath` is the same as a
 * resolved allowedRoot OR sits below it (using OS path separator).
 *
 * No I/O. Resolves each root once per call (handles ~ expansion +
 * relative root paths in tests).
 */
export function isPathInsideRoots(
  absPath: string,
  allowedRoots: readonly string[],
): boolean {
  for (const root of allowedRoots) {
    const normRoot = resolve(root);
    if (absPath === normRoot) return true;
    if (absPath.startsWith(normRoot + sep)) return true;
  }
  return false;
}

/**
 * Wrap an error into a ToolCallError using Phase 96 D-12 classification.
 * The classifyShareFileError pure helper drives the suggestion text;
 * wrapMcpToolError handles the rest of the schema (kind / message /
 * alternatives / errorClass via its own auto-classifier).
 *
 * NOTE: wrapMcpToolError ALSO classifies the message via its own regex.
 * For most cases (permission / unknown / size→unknown / missing→unknown)
 * the auto-classified errorClass agrees with our taxonomy. The
 * `transient` case for upload retries (429 → wrapMcpToolError says
 * 'quota'; share-file says 'transient' because the LLM should retry,
 * not re-authenticate) is normalized at the call site (see catch block
 * at end of clawcodeShareFile).
 */
function wrapShareFileError(err: Error | string): ToolCallError {
  const { suggestion } = classifyShareFileError(err);
  return wrapMcpToolError(err, {
    tool: CLAWCODE_SHARE_FILE_DEF.name,
    suggestionFor: () => suggestion,
  });
}

/**
 * Pure handler. Always returns a value — never throws (LLM tool-result
 * contract). Failures wrap via Plan 94-04 wrapMcpToolError + Phase 96 D-12
 * classifyShareFileError.
 *
 * Order:
 *   1. outputDir resolution (if input.path is relative + outputDir wired)
 *   2. Path validation (no I/O cost paid for refused paths)
 *   3. stat → filesize check (fail-fast on oversize)
 *   4. currentChannelId resolved (refuse with structured error if absent)
 *   5. webhook upload → on failure → bot-direct fallback → on failure → wrap
 */
export async function clawcodeShareFile(
  input: ShareFileInput,
  deps: ShareFileDeps,
): Promise<ShareFileOutput | ToolCallError> {
  // Phase 96 D-09: relative path → resolve under agent outputDir.
  // Order matters: resolution happens BEFORE the path-validation gate so the
  // outputDir-anchored absolute path is what gets checked against allowedRoots.
  // Absolute input paths bypass outputDir entirely (passed through verbatim).
  let inputPath = input.path;
  if (
    !isAbsolute(input.path) &&
    deps.outputDirTemplate &&
    deps.agentWorkspaceRoot &&
    deps.resolveCtx
  ) {
    const ctx = deps.resolveCtx();
    const resolved = resolveOutputDir(
      deps.outputDirTemplate,
      ctx,
      { agentWorkspaceRoot: deps.agentWorkspaceRoot },
    );
    if (resolved.warnings.length > 0) {
      // Operator-actionable diagnostics (e.g. {client_slug} fallback fired).
      try {
        deps.log.warn(
          { warnings: resolved.warnings, template: deps.outputDirTemplate, agent: ctx.agent },
          "outputDir resolution produced warnings",
        );
      } catch {
        // Logger threw — swallow.
      }
    }
    // join keeps path separator semantics correct on Windows + POSIX.
    inputPath = join(resolved.resolved, input.path);
  }

  const absPath = resolve(inputPath);

  // 1. Security boundary — refuse paths outside allowedRoots BEFORE any I/O.
  if (!isPathInsideRoots(absPath, deps.allowedRoots)) {
    return wrapShareFileError(
      new Error(
        `Path ${absPath} is outside the agent workspace; refused by clawcode_share_file (permission denied)`,
      ),
    );
  }

  // 2. Stat — file must exist and be a regular file.
  let stat: { size: number; isFile: boolean };
  try {
    stat = await deps.stat(absPath);
  } catch (err) {
    return wrapShareFileError(err as Error | string);
  }

  if (!stat.isFile) {
    return wrapShareFileError(new Error(`${absPath} is not a regular file`));
  }

  // 3. Discord 25MB cap — Phase 96 D-12 size suggestion.
  if (stat.size > DISCORD_FILE_SIZE_LIMIT) {
    const sizeMb = (stat.size / 1024 / 1024).toFixed(1);
    return wrapShareFileError(
      new Error(
        `File ${basename(absPath)} is ${sizeMb} MB; exceeds the Discord 25MB upload limit — compress or split the file`,
      ),
    );
  }

  // 4. Current channel must be known — agent must be inside a dispatch context.
  const channelId = deps.currentChannelId();
  if (!channelId) {
    return wrapShareFileError(
      new Error(
        "no current channel — clawcode_share_file requires an active Discord dispatch context to determine the upload destination",
      ),
    );
  }

  const filename = basename(absPath);
  const fileArg = {
    path: absPath,
    filename,
    ...(input.caption !== undefined ? { caption: input.caption } : {}),
  };

  // 5. Webhook → bot-direct fallback (Phase 90.1).
  try {
    const result = await deps.sendViaWebhook(channelId, fileArg);
    return Object.freeze({
      url: result.url,
      filename,
      sizeBytes: stat.size,
      ...(result.messageId !== undefined ? { messageId: result.messageId } : {}),
      ...(result.channelId !== undefined ? { channelId: result.channelId } : {}),
    });
  } catch (webhookErr) {
    // Best-effort log; never break the wrap path.
    try {
      deps.log.warn(
        { err: (webhookErr as Error)?.message, tool: CLAWCODE_SHARE_FILE_DEF.name },
        "webhook send failed; falling back to bot-direct",
      );
    } catch {
      // Logger threw — swallow.
    }
    try {
      const result = await deps.sendViaBot(channelId, fileArg);
      return Object.freeze({
        url: result.url,
        filename,
        sizeBytes: stat.size,
        ...(result.messageId !== undefined ? { messageId: result.messageId } : {}),
        ...(result.channelId !== undefined ? { channelId: result.channelId } : {}),
      });
    } catch (botErr) {
      // BOTH webhook + bot-direct failed — classify the bot error (the last
      // attempt). For 429/5xx/timeout patterns this lands as 'transient' even
      // though wrapMcpToolError's auto-classifier maps "429" → quota. Override
      // to 'transient' for upload-time failures so the LLM sees 'retry in 30s'
      // rather than 'authenticate' — Phase 96 D-12 explicit taxonomy.
      const wrapped = wrapShareFileError(botErr as Error | string);
      const ourClass = classifyShareFileError(botErr as Error).errorClass;
      if (ourClass === "transient" && wrapped.errorClass !== "transient") {
        return Object.freeze({
          ...wrapped,
          errorClass: "transient" as const,
        });
      }
      return wrapped;
    }
  }
}
