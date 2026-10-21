import type { BrowserToolOutcome } from "../browser/types.js";
import type {
  NeutralQuestion,
  NeutralAnswers,
} from "../messaging/types.js";

/**
 * Phase 70 — IPC type contracts shared between the daemon and the
 * out-of-process browser MCP server (`clawcode browser-mcp`).
 *
 * This file holds ONLY the type declarations for new IPC methods added
 * as part of Phase 70. Plan 03 wires the daemon-side handler in
 * `src/manager/daemon.ts` and adds `"browser-tool-call"` to the
 * `IPC_METHODS` tuple in `src/ipc/protocol.ts` (the runtime enum).
 *
 * Keeping the type contract separate from the enum avoids forcing Plan 02
 * to touch `protocol.ts` (which is imported broadly) before the daemon
 * handler exists.
 */

/**
 * Parameters for the `browser-tool-call` IPC method.
 *
 * Flow: MCP subprocess (out-of-process) receives a tool call from the
 * Claude SDK over stdio → the handler in `src/browser/mcp-server.ts`
 * packs `{ agent, toolName, args }` into this shape → `sendIpcRequest`
 * hands it to the daemon → the daemon resolves the agent's workspace,
 * fetches the cached BrowserContext from `BrowserManager`, and invokes
 * the matching pure handler from `src/browser/tools.ts`.
 */
export interface IpcBrowserToolCallParams {
  readonly agent: string;
  readonly toolName:
    | "browser_navigate"
    | "browser_screenshot"
    | "browser_click"
    | "browser_fill"
    | "browser_extract"
    | "browser_wait_for";
  readonly args: Record<string, unknown>;
}

/**
 * Result type for the `browser-tool-call` IPC method.
 *
 * The daemon returns the raw `BrowserToolOutcome` from the pure tool
 * handler — the subprocess layer shapes it into an MCP content envelope
 * (text, or text + image for screenshots with inlineBase64).
 */
export type IpcBrowserToolCallResult = BrowserToolOutcome;

/* ------------------------------------------------------------------ */
/*  Phase 71 — Web Search MCP IPC contract                             */
/* ------------------------------------------------------------------ */

/**
 * Parameters for the `search-tool-call` IPC method.
 *
 * Flow (mirrors Phase 70's browser-tool-call):
 *   Claude SDK spawns `clawcode search-mcp` per agent session →
 *   `src/search/mcp-server.ts` receives a tool call over stdio →
 *   packs `{ agent, toolName, args }` into this shape →
 *   `sendIpcRequest(SOCKET_PATH, "search-tool-call", ...)` →
 *   daemon dispatches to `handleSearchToolCall` in
 *   `src/search/daemon-handler.ts`, which calls `webSearch` or
 *   `webFetchUrl` against the daemon-owned BraveClient/ExaClient/fetcher.
 */
export interface IpcSearchToolCallParams {
  readonly agent: string;
  readonly toolName: "web_search" | "web_fetch_url";
  readonly args: Record<string, unknown>;
}

/**
 * Result type for `search-tool-call`. Widened to `unknown` on the success
 * branch to keep the IPC layer shallowly-typed — concrete shapes
 * (`SearchResponse`, `FetchUrlResult`) live in the search module and are
 * re-narrowed by the MCP subprocess when shaping the content envelope.
 */
export type IpcSearchToolCallResult =
  | { readonly ok: true; readonly data: unknown }
  | {
      readonly ok: false;
      readonly error: {
        readonly type: string;
        readonly message: string;
        readonly [k: string]: unknown;
      };
    };

/* ------------------------------------------------------------------ */
/*  Phase 72 — Image Generation MCP IPC contract                       */
/* ------------------------------------------------------------------ */

/**
 * Parameters for the `image-tool-call` IPC method.
 *
 * Flow (mirrors Phase 70/71):
 *   Claude SDK spawns `clawcode image-mcp` per agent session →
 *   `src/image/mcp-server.ts` receives a tool call over stdio →
 *   packs `{ agent, toolName, args }` into this shape →
 *   `sendIpcRequest(SOCKET_PATH, "image-tool-call", ...)` →
 *   daemon dispatches to `handleImageToolCall` in
 *   `src/image/daemon-handler.ts`, which calls `imageGenerate`,
 *   `imageEdit`, or `imageVariations` against the daemon-owned
 *   OpenAI/MiniMax/fal image provider clients.
 */
export interface IpcImageToolCallParams {
  readonly agent: string;
  readonly toolName: "image_generate" | "image_edit" | "image_variations";
  readonly args: Record<string, unknown>;
}

/**
 * Result type for `image-tool-call`. Widened to `unknown` on the success
 * branch to keep the IPC layer shallowly-typed — concrete shapes
 * (`ImageGenerateResult`, `ImageEditResult`, `ImageVariationsResult`)
 * live in the image module and are re-narrowed by the MCP subprocess
 * when shaping the content envelope.
 */
export type IpcImageToolCallResult =
  | { readonly ok: true; readonly data: unknown }
  | {
      readonly ok: false;
      readonly error: {
        readonly type: string;
        readonly message: string;
        readonly [k: string]: unknown;
      };
    };

/* ------------------------------------------------------------------ */
/*  Phase 145 WS3 — platform-neutral ask_user_question IPC contract     */
/* ------------------------------------------------------------------ */

/**
 * Parameters for the `ask-user-question` IPC method.
 *
 * Flow (mirrors the Phase 70/71/72 tool-call round-trips):
 *   Agent turn invokes the `ask_user_question` MCP tool (Plan 04) →
 *   the MCP subprocess packs `{ agent, questions, timeoutMs? }` into this
 *   shape → `sendIpcRequest(SOCKET_PATH, "ask-user-question", ...)` →
 *   the daemon resolves the agent's bound channel + platform, renders a
 *   native prompt (Discord buttons / Slack Block Kit) or the universal text
 *   fallback, and blocks on a daemon-side bounded timeout until the channel
 *   operator answers.
 *
 * `questions` reuses the platform-neutral `NeutralQuestion` shape from
 * messaging/types (≤4 questions, labelled options, multiSelect) so the MCP
 * tool, the IPC boundary, and the adapter renderer all share one contract.
 * `timeoutMs` is advisory — the daemon handler owns the load-bearing bound
 * (the IPC client has no socket timeout, per RESEARCH Pattern 4).
 */
export interface IpcAskUserQuestionParams {
  readonly agent: string;
  readonly questions: readonly NeutralQuestion[];
  readonly timeoutMs?: number;
}

/**
 * Result type for the `ask-user-question` IPC method.
 *
 * Always resolves (never hangs the worker): on success the daemon returns the
 * operator's `NeutralAnswers`; on failure it returns a discriminated reason so
 * the MCP tool can shape a clean tool result (e.g. "the prompt timed out").
 *  - `timeout` — the daemon-side bounded timeout elapsed with no answer.
 *  - `no-operator` — no channel operator is bound / allowed to answer.
 *  - `unsupported` — the agent's platform can neither render natively nor
 *    fall back to text (should be rare; the text fallback is universal).
 * Widened with `string` so Plan 04's daemon handler can surface additional
 * reasons without re-touching this type.
 */
export type IpcAskUserQuestionResult =
  | { readonly ok: true; readonly answers: NeutralAnswers }
  | {
      readonly ok: false;
      readonly reason: "timeout" | "no-operator" | "unsupported" | string;
    };

/* ------------------------------------------------------------------ */
/*  Phase 145 WS2 (Plan 05) — background workflow orchestrator IPC      */
/* ------------------------------------------------------------------ */

/**
 * One step of a workflow spec — a single unit of parallel work.
 *
 * Mirrors `WorkflowStep` in `src/manager/workflow-orchestrator.ts`. Declared
 * here too so the IPC boundary (and the MCP tool's zod input) share the shape
 * without the IPC layer importing the manager module.
 */
export interface IpcWorkflowStep {
  readonly stepId: string;
  readonly prompt: string;
  /**
   * 999.106 QW-2 (worker diet) — optional fail-closed allowlist of MCP server
   * NAMES this step's worker may keep. Resolved as
   * `(step ?? fleet ceiling ?? parent roster) ∩ parent roster` — a step can
   * narrow its tool surface but never grant a server the parent lacks. `[]`
   * = tool-free worker. Absent = inherit (today's behavior).
   */
  readonly mcpServers?: readonly string[];
}

/**
 * The workflow spec carried over IPC. Exactly ONE of the two shapes:
 *   - `steps` — legacy single parallel group (normalized to one wave);
 *   - `waves` — 999.106 W-2 ordered waves: each inner array is a parallel
 *     group, waves run SEQUENTIALLY (wave K's barrier + teardown completes
 *     before wave K+1's first admission). Per-wave ≤8, total ≤24, ≤6 waves.
 * Providing both (or neither) is a malformed spec. The daemon re-validates
 * shape + caps at the IPC boundary before launching any worker.
 */
export interface IpcWorkflowSpec {
  readonly steps?: readonly IpcWorkflowStep[];
  readonly waves?: readonly (readonly IpcWorkflowStep[])[];
}

/**
 * Parameters for the `start-workflow` IPC method.
 *
 * Flow (mirrors the Phase 70/71/72 tool-call round-trips, but FAST-RETURN):
 *   Agent turn invokes the `start_workflow` MCP tool (this plan) →
 *   the MCP subprocess packs `{ agent, spec }` into this shape →
 *   `sendIpcRequest(SOCKET_PATH, "start-workflow", ...)` →
 *   the daemon resolves the agent's config, validates the spec, and calls
 *   `WorkflowOrchestrator.launchWorkflow(agent, spec)` — which allocates a
 *   `wf_…` id synchronously and fans the workers out as a background job.
 *   The daemon RETURNS THE ID IMMEDIATELY (does NOT await worker completion):
 *   the triggering turn settles in seconds, so no turn watchdog ever spans the
 *   workflow (the core SC-2 mechanism).
 */
export interface IpcStartWorkflowParams {
  readonly agent: string;
  /** Hand-written spec. Omitted when launching a named template. */
  readonly spec?: IpcWorkflowSpec;
  /**
   * Phase 999.128 — launch a named template (from `defaults.workflow.templates`
   * merged with the agent's `workflowTemplates`) with `{{param}}` values.
   * Exactly one of `spec` / `template`.
   */
  readonly template?: string;
  readonly params?: Readonly<Record<string, string>>;
}

/**
 * Result type for the `start-workflow` IPC method. The success branch returns
 * the allocated `workflowId` plus a human-readable `message` the MCP tool
 * surfaces to the model ("started wf_…, progress posts to your channel"). On a
 * validation failure (unknown agent, empty / over-cap spec) the daemon returns
 * a discriminated `reason` so the tool can shape a clean isError result —
 * never a crash. Widened with `string` so a later plan can add reasons without
 * re-touching this type.
 */
export type IpcStartWorkflowResult =
  | { readonly ok: true; readonly workflowId: string; readonly message: string }
  | {
      readonly ok: false;
      readonly reason:
        | "unknown-agent"
        | "invalid-spec"
        | "unknown-template"
        | "missing-params"
        | "unknown-params"
        | "invalid-template"
        | string;
      /** Phase 999.128 — human-readable detail for template failures. */
      readonly message?: string;
    };
