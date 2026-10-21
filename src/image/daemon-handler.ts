/**
 * Phase 72 Plan 02 — daemon-side handler for the `image-tool-call` IPC
 * method. Pure dispatcher over a small `{config, providers, writeImage,
 * usageTrackerLookup}` deps bag, mirroring Phase 71's
 * `src/search/daemon-handler.ts` pattern.
 *
 * Contract:
 *   - Disabled guard → `internal` error when `imageConfig.enabled=false`.
 *   - Agent resolution → `invalid_argument` when `params.agent` is unknown.
 *   - Unknown toolName → `invalid_argument` with the offending name in the
 *     message.
 *   - Dispatch → `imageGenerate` / `imageEdit` / `imageVariations` from
 *     `./tools.ts`, injecting:
 *       * `config`              from deps.imageConfig
 *       * `providers`           from deps.providers
 *       * `writeImage`          from deps.writeImage (defaults to
 *                               `writeImageToWorkspace`)
 *       * `recordCost`          adapter over deps.usageTrackerLookup —
 *                               lookup tracker for the agent, forward the
 *                               event via `recordImageUsage`; when the
 *                               lookup returns `undefined` (agent not
 *                               running, memory manager not initialized)
 *                               the recordCost is a no-op so the tool
 *                               still succeeds.
 *       * `agentWorkspace`      from resolvedAgent.workspace (per-agent
 *                               isolation — two agents writing concurrent
 *                               images land in different workspace subdirs)
 *       * `agent` + `sessionId` agent name + a fallback session id used
 *                               only if the handler ever gets invoked
 *                               without a trace. The daemon doesn't weave
 *                               session-id into the IPC envelope; image
 *                               cost rows identify by agent+timestamp.
 *       * `readFile`            optional — forwarded when deps.readFile
 *                               is supplied (tests use this to avoid
 *                               disk; production omits it so tools.ts
 *                               falls back to fs/promises.readFile).
 *   - NEVER throws — any unexpected rejection inside the dispatch is
 *     caught and mapped to `{type: "internal"}`. The pure tool handlers
 *     already contract never-throw, but this is defence-in-depth for
 *     the IPC boundary.
 *
 * Unlike the browser handler, image has:
 *   - No per-agent persistent state → no saveAgentState trigger.
 *   - No resident warm-path → no isReady()/warm() branch (HTTP clients).
 *
 * Providers (openai/minimax/fal) are daemon-owned and constructed at
 * boot in `src/manager/daemon.ts`. Missing API keys are handled lazily
 * inside each provider method (returns `invalid_input`), so daemon boot
 * stays cheap even when OPENAI_API_KEY / MINIMAX_API_KEY / FAL_API_KEY
 * are unset.
 */

import { imageGenerate, imageEdit, imageVariations } from "./tools.js";
import type { ImageToolDeps, ReadFileFn } from "./tools.js";
import { recordImageUsage } from "./costs.js";
import { writeImageToWorkspace } from "./workspace.js";
import type { ImageConfig } from "../config/schema.js";
import type {
  ImageBackend,
  ImageProvider,
  ImageToolOutcome,
  ImageUsageEvent,
} from "./types.js";
import type { ResolvedAgentConfig } from "../shared/types.js";
import type { IpcImageToolCallParams } from "../ipc/types.js";
import type { UsageTracker } from "../usage/tracker.js";

export interface ImageDaemonHandlerDeps {
  readonly imageConfig: ImageConfig;
  readonly resolvedAgents: readonly ResolvedAgentConfig[];
  readonly providers: Record<ImageBackend, ImageProvider>;
  /**
   * Callback-based tracker lookup — keeps the handler agent-agnostic.
   * Returns `undefined` when the agent isn't running (tracker DB not
   * open); the handler treats that as a recordCost no-op so a tool call
   * mid-startup still succeeds.
   */
  readonly usageTrackerLookup: (agent: string) => UsageTracker | undefined;
  /** Optional override for tests — defaults to writeImageToWorkspace. */
  readonly writeImage?: typeof writeImageToWorkspace;
  /**
   * Optional override for tests — forwarded into the tool handler's
   * ImageToolDeps.readFile seam so tests can avoid touching disk.
   */
  readonly readFile?: ReadFileFn;
}

export async function handleImageToolCall(
  deps: ImageDaemonHandlerDeps,
  params: IpcImageToolCallParams,
): Promise<ImageToolOutcome<unknown>> {
  const { imageConfig, resolvedAgents, providers } = deps;
  const { agent, toolName, args } = params;

  // 1. Disabled guard → internal
  if (!imageConfig.enabled) {
    return Object.freeze({
      ok: false as const,
      error: Object.freeze({
        type: "internal" as const,
        message:
          "image MCP disabled (defaults.image.enabled=false); set it to true to use image_generate / image_edit / image_variations",
      }),
    });
  }

  // 2. Agent resolution → invalid_argument
  const resolvedAgent = resolvedAgents.find((a) => a.name === agent);
  if (!resolvedAgent) {
    return Object.freeze({
      ok: false as const,
      error: Object.freeze({
        type: "invalid_argument" as const,
        message: `unknown agent: ${agent}`,
      }),
    });
  }

  // 3. Build per-call ImageToolDeps.
  const writeImage = deps.writeImage ?? writeImageToWorkspace;
  const recordCost = (event: ImageUsageEvent): void => {
    const tracker = deps.usageTrackerLookup(agent);
    if (!tracker) return; // no-op when agent not running
    recordImageUsage(tracker, event);
  };

  const toolDeps: ImageToolDeps = Object.freeze({
    config: imageConfig,
    providers,
    writeImage,
    recordCost,
    agentWorkspace: resolvedAgent.workspace,
    agent,
    // No trace session id is threaded through the IPC envelope. Image
    // cost rows identify by agent + timestamp; a stable fallback keeps
    // the UsageEvent shape valid.
    sessionId: "ipc",
    readFile: deps.readFile,
  });

  try {
    switch (toolName) {
      case "image_generate":
        return await imageGenerate(
          args as {
            prompt: string;
            size?: string;
            style?: string;
            backend?: string;
            model?: string;
            n?: number;
          },
          toolDeps,
        );
      case "image_edit":
        return await imageEdit(
          args as {
            imagePath: string;
            prompt: string;
            backend?: string;
            maskPath?: string;
            model?: string;
            size?: string;
          },
          toolDeps,
        );
      case "image_variations":
        return await imageVariations(
          args as {
            imagePath: string;
            n?: number;
            backend?: string;
            model?: string;
            size?: string;
          },
          toolDeps,
        );
      default: {
        // Exhaustiveness check — the union is closed to the three tools.
        const unknownTool: string = toolName;
        return Object.freeze({
          ok: false as const,
          error: Object.freeze({
            type: "invalid_argument" as const,
            message: `unknown image tool: ${unknownTool}`,
          }),
        });
      }
    }
  } catch (err) {
    // The tool handlers catch their own errors — this is the IPC
    // boundary's last line of defence.
    const message = err instanceof Error ? err.message : String(err);
    return Object.freeze({
      ok: false as const,
      error: Object.freeze({
        type: "internal" as const,
        message,
      }),
    });
  }
}
