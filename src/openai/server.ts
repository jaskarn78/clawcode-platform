/**
 * Phase 69 Plan 02 — OpenAI-compatible HTTP server on node:http.
 *
 * Routes:
 *   OPTIONS *                      → 204 + CORS preflight headers.
 *   GET     /v1/models             → list of top-level agents as OpenAI models
 *                                    (no auth — fleet listing is public per
 *                                    CONTEXT "all configured agents appear
 *                                    regardless of key permissions").
 *   POST    /v1/chat/completions   → JSON or SSE completion, bearer-auth.
 *   *                              → 404 OpenAI-shape error.
 *
 * Dependencies are INJECTED via `OpenAiServerConfig`:
 *   - `apiKeysStore`      — from Plan 01 (src/openai/keys.ts)
 *   - `driver`            — an `OpenAiSessionDriver` impl (Plan 03 wires real)
 *   - `agentNames`        — a function returning top-level agent names
 *
 * Zero imports from src/manager/, src/memory/, src/config/ — this module is
 * fully unit-testable in vitest with a :memory: ApiKeysStore and a mock driver.
 *
 * Pitfalls guarded here (see 69-RESEARCH.md):
 *   - Pitfall 2: OpenAI error shape on every 4xx/5xx.
 *   - Pitfall 4/5: SSE framing delegated to stream.ts which sets the right
 *     headers + double-newline terminator.
 *   - Pitfall 6: bearer-key extraction hashes via ApiKeysStore (timing-safe
 *     lookup lives in Plan 01's keys.ts).
 *   - Pitfall 8: translator.ts emits `clientSystemAppend` — we forward it
 *     verbatim to the driver as the systemPrompt APPEND field (NEVER override).
 *   - Pitfall 9: Content-Type check via .toLowerCase().startsWith()
 *     (charset-tolerant).
 *   - Pitfall 10: graceful-shutdown loop — `activeStreams` Set is closed
 *     BEFORE `server.close()`.
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { nanoid } from "nanoid";
import pino, { type Logger } from "pino";

import type { ApiKeysStore } from "./keys.js";
import {
  chatCompletionRequestSchema,
  type ChatCompletionRequest,
  type ChatCompletionToolCall,
  type ClaudeToolChoice,
  type ClaudeToolDef,
  type ClaudeToolResultBlock,
  type ModelsListResponse,
  type OpenAiError,
  type OpenAiImageInput,
  type SdkStreamEvent,
  type TemplateDriverInput,
} from "./types.js";
import {
  NoUserMessageError,
  createStreamingTranslator,
  makeNonStreamResponse,
  newChatCompletionId,
  translateClaudeToolUseToOpenAi,
  translateRequest,
} from "./translator.js";
import { startOpenAiSse, type OpenAiSseHandle } from "./stream.js";
import { isUpstreamTurnError, type UpstreamTurnError } from "./upstream-error.js";
import type { MemoryGateway, StoredMemoryInput } from "./memory-gateway.js";
import type {
  RequestLogger,
  RequestLogRecord,
} from "./request-logger.js";
import { extractCallerIdentity } from "./caller-identity.js";
import { isSubagentOrThreadSession } from "../manager/subagent-name.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Contract for the session driver the server delegates turn execution to.
 * Plan 03 implements this over SessionManager + ConversationStore. Plan 02
 * tests pass a fixture-based mock that replays recorded SDK events.
 */
export interface OpenAiSessionDriver {
  /**
   * Open a session for the bearer key / agent pair and stream SDK events.
   * Caller provides an AbortSignal; when aborted the driver must stop the
   * underlying query promptly.
   */
  dispatch(input: {
    agentName: string;
    keyHash: string;
    lastUserMessage: string;
    /** CAM-01/02 — inline vision attachments (data-URL images). Optional; empty/undefined → text-only. */
    lastUserImages?: OpenAiImageInput[];
    clientSystemAppend: string | null;
    tools: ClaudeToolDef[] | null;
    toolChoice: ClaudeToolChoice | null;
    toolResults: ClaudeToolResultBlock[];
    signal: AbortSignal;
    xRequestId: string;
  }): AsyncIterable<SdkStreamEvent>;
}

/** Configuration for `startOpenAiServer`. Every dependency is injected. */
export interface OpenAiServerConfig {
  port: number;
  host: string;
  maxRequestBodyBytes: number;
  streamKeepaliveMs: number;
  apiKeysStore: ApiKeysStore;
  driver: OpenAiSessionDriver;
  /** Returns the full list of agent names currently configured. */
  agentNames: () => ReadonlyArray<string>;
  /** Optional logger — defaults to a pino child when absent. */
  log?: Logger;
  /**
   * Post-v2.0 hardening — boolean readiness probe for warm-path startup race.
   * Production wires this to `SessionManager.isRunning.bind(sessionManager)`.
   * When absent (test harness path), the wait gate is disabled and the handler
   * dispatches immediately (preserves Plan 02 hermetic tests).
   */
  agentIsRunning?: (agentName: string) => boolean;
  /**
   * Phase 73 Plan 02 — max wait before 503 Retry-After on warm-path race.
   * Default 300ms (tuned down from 2000ms post-persistent-subprocess).
   * Tests override to 50–200ms for speed. Override at runtime via
   * CLAWCODE_OPENAI_READINESS_WAIT_MS env var (see endpoint-bootstrap.ts).
   */
  agentReadinessWaitMs?: number;
  /**
   * Post-v2.0 hardening — poll cadence during the readiness wait window.
   * Default 50ms.
   */
  agentReadinessPollIntervalMs?: number;
  /**
   * Quick task 260419-mvh — JSONL request logger. When set, every request
   * (chat-completion + /v1/models) emits exactly one record on res.on('close').
   * Absent by default so Plan 02 hermetic tests stay hermetic.
   */
  requestLogger?: RequestLogger;
  /**
   * Phase 74 Plan 01 — OpenClaw template driver. Wired when body.model
   * starts with `openclaw:`. When absent, any `openclaw:`-prefixed request
   * returns 501 not_implemented (feature flag). Production wires this
   * unconditionally in endpoint-bootstrap.ts alongside the native driver.
   */
  templateDriver?: OpenAiSessionDriver;
  /**
   * Phase 74 Plan 02 — per-agent config lookup for the denyScopeAll gate.
   * Production wires this to `(name) => sessionManager.getAgentConfig(name) ?? null`.
   * When absent, the gate defaults to permissive (scope='all' reaches any
   * native agent — Phase 69 backwards-compatible behaviour). Only consulted
   * on the clawcode-native branch; the openclaw: template branch bypasses
   * this check entirely (slug is caller-controlled, not a native target).
   *
   * Return shape is a structural subset of ResolvedAgentConfig — the gate
   * reads `security.denyScopeAll`. Anything else on the returned object is
   * ignored (keeps the server hermetic from src/config/schema.ts).
   */
  getAgentConfig?: (name: string) =>
    | {
        security?: { denyScopeAll?: boolean } | undefined;
      }
    | null
    | undefined;
  /**
   * clawdy-v2 #8 — cross-session memory gateway for the `/v1/memory*` REST
   * endpoints (`docs/MEMORY-CONTRACT.md`). Production wires this in
   * endpoint-bootstrap.ts from `SessionManager.getMemoryStore` + `embedText`.
   * When absent, the memory routes return 501 (feature flag — keeps Plan 02
   * hermetic tests and any deployment without the gateway from exposing them).
   */
  memoryGateway?: MemoryGateway;
}

/** Handle returned by `startOpenAiServer`. */
export interface OpenAiServerHandle {
  readonly server: ReturnType<typeof createServer>;
  readonly activeStreams: Set<OpenAiSseHandle>;
  readonly address: { port: number; host: string };
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// CORS + error helpers
// ---------------------------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, x-request-id",
  "Access-Control-Expose-Headers": "x-request-id",
};

/** Build a typed OpenAI error body + status pair (exported for tests). */
export function buildOpenAiError(
  status: number,
  type: OpenAiError["error"]["type"],
  message: string,
  code: string | null = null,
): { status: number; body: OpenAiError } {
  return {
    status,
    body: { error: { message, type, code } },
  };
}

function applyCorsAndXrid(
  res: ServerResponse,
  extra: Record<string, string> = {},
  xRequestId?: string,
): Record<string, string> {
  const headers: Record<string, string> = { ...CORS_HEADERS, ...extra };
  if (xRequestId) headers["x-request-id"] = xRequestId;
  return headers;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  xRequestId?: string,
  extraHeaders?: Record<string, string>,
): void {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  const headers = applyCorsAndXrid(
    res,
    {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload).toString(),
      ...(extraHeaders ?? {}),
    },
    xRequestId,
  );
  res.writeHead(status, headers);
  res.end(payload);
}

function sendError(
  res: ServerResponse,
  status: number,
  type: OpenAiError["error"]["type"],
  message: string,
  code: string | null = null,
  xRequestId?: string,
  extraHeaders?: Record<string, string>,
): void {
  const { body } = buildOpenAiError(status, type, message, code);
  sendJson(res, status, body, xRequestId, extraHeaders);
}

/**
 * Post-v2.0 hardening — bounded poll on `isRunning(agentName)` for the
 * warm-path startup race. Resolves `true` as soon as the probe flips, or
 * `false` when `waitMs` elapses.
 *
 * Pure — takes `isRunning` as a fn param so tests can drive the gate without
 * booting a real SessionManager.
 */
async function waitForAgentReady(
  agentName: string,
  isRunning: (name: string) => boolean,
  waitMs: number,
  pollMs: number,
): Promise<boolean> {
  if (isRunning(agentName)) return true;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    if (isRunning(agentName)) return true;
  }
  return false;
}

/**
 * Post-v2.0 hardening — shared 503 emitter used by the pre-dispatch gate AND
 * the defensive `SessionError not-running` catch in `runNonStreaming`.
 * Keeps the error envelope and Retry-After header consistent in one place.
 */
function sendAgentWarming(
  res: ServerResponse,
  xRequestId?: string,
): void {
  sendError(
    res,
    503,
    "server_error",
    "Agent warming up, retry shortly",
    "agent_warming",
    xRequestId,
    { "Retry-After": "2" },
  );
}

/**
 * Post-v2.0 hardening — classifier for the warm-path defensive catch.
 * Uses `.name === "SessionError"` (not `instanceof`) so session-manager module
 * duplication across build boundaries does not defeat the check.
 */
function isSessionNotRunningError(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.name === "SessionError" &&
    err.message.includes(" is not running")
  );
}

/**
 * The client-facing message for a turn whose model call failed upstream (the
 * CLI completed the turn but the API returned an error). Carries the upstream
 * text — capped by the drivers — so the caller sees the real cause.
 */
function upstreamErrorMessage(err: UpstreamTurnError): string {
  return err.upstreamMessage.length > 0
    ? `Upstream model call failed: ${err.upstreamMessage}`
    : "Upstream model call failed";
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

/** Extract x-request-id header, or generate a fresh nanoid(16). */
function resolveXRequestId(req: IncomingMessage): string {
  const existing = req.headers["x-request-id"];
  if (typeof existing === "string" && existing.length > 0 && existing.length <= 256) {
    return existing;
  }
  if (Array.isArray(existing) && existing[0]) return existing[0];
  return nanoid(16);
}

/** Content-Type check (Pitfall 9 — charset-tolerant). */
function isJsonContentType(req: IncomingMessage): boolean {
  const ct = req.headers["content-type"];
  if (typeof ct !== "string") return false;
  return ct.toLowerCase().startsWith("application/json");
}

/** Read request body with a hard byte cap; rejects with `BodyTooLarge` when exceeded. */
class BodyTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super(`request body exceeded ${limit} bytes`);
    this.name = "BodyTooLargeError";
  }
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        cleanup();
        // Pause the stream but do NOT destroy the socket — the caller needs
        // a live response to send the 413 error body. The caller is
        // responsible for draining any further data from the source (we drop
        // bytes on the floor via the unregistered data handler).
        req.pause();
        reject(new BodyTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

/** Extract the bearer key from `Authorization: Bearer <key>`. Returns null on miss. */
function extractBearer(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (typeof auth !== "string") return null;
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const key = auth.slice(7).trim();
  return key.length > 0 ? key : null;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * Filter out sub/thread agents; return the top-level fleet.
 * Phase 999.19 — uses the central `isSubagentOrThreadSession` predicate so
 * the Phase 999.3 `-via-` delegated pattern is excluded alongside `-sub-`
 * and `-thread-` (the prior `.includes` pair missed `-via-`).
 */
function topLevelAgents(names: ReadonlyArray<string>): ReadonlyArray<string> {
  return names.filter((n) => !isSubagentOrThreadSession(n));
}

function handleOptions(res: ServerResponse, xRequestId: string): void {
  res.writeHead(204, applyCorsAndXrid(res, {}, xRequestId));
  res.end();
}

function handleModels(
  res: ServerResponse,
  config: OpenAiServerConfig,
  xRequestId: string,
  bootEpochSeconds: number,
): void {
  const agents = topLevelAgents(config.agentNames());
  const body: ModelsListResponse = {
    object: "list",
    data: agents.map((id) => ({
      id,
      object: "model",
      created: bootEpochSeconds,
      owned_by: "clawcode",
    })),
  };
  sendJson(res, 200, body, xRequestId);
}

async function handleChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  config: OpenAiServerConfig,
  activeStreams: Set<OpenAiSseHandle>,
  xRequestId: string,
  log: Logger,
  partial: MutableLogRecord,
): Promise<void> {
  // 1. Content-Type (Pitfall 9).
  if (!isJsonContentType(req)) {
    partial.error_type = "invalid_request_error";
    partial.error_code = "invalid_content_type";
    sendError(
      res,
      400,
      "invalid_request_error",
      "Content-Type must be application/json",
      "invalid_content_type",
      xRequestId,
    );
    return;
  }

  // 2. Auth — bearer key required.
  const bearer = extractBearer(req);
  if (bearer === null) {
    partial.error_type = "authentication_error";
    partial.error_code = "missing_key";
    sendError(
      res,
      401,
      "authentication_error",
      "Missing bearer token in Authorization header",
      "missing_key",
      xRequestId,
    );
    return;
  }
  // Quick task 260419-mvh — capture the first 12 chars of the RAW bearer
  // for observability BEFORE the store lookup. Never more, never less.
  partial.bearer_key_prefix = bearer.slice(0, 12);

  const row = config.apiKeysStore.lookupByIncomingKey(bearer);
  if (row === null) {
    partial.error_type = "authentication_error";
    partial.error_code = "invalid_key";
    sendError(
      res,
      401,
      "authentication_error",
      "Invalid or revoked API key",
      "invalid_key",
      xRequestId,
    );
    return;
  }
  partial.agent = row.agent_name;

  // 3. Body read + parse.
  let raw: Buffer;
  try {
    raw = await readBody(req, config.maxRequestBodyBytes);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      partial.error_type = "invalid_request_error";
      partial.error_code = "body_too_large";
      sendError(
        res,
        413,
        "invalid_request_error",
        "Request body too large",
        "body_too_large",
        xRequestId,
      );
      return;
    }
    partial.error_type = "invalid_request_error";
    partial.error_code = "body_read_error";
    sendError(
      res,
      400,
      "invalid_request_error",
      "Failed to read request body",
      "body_read_error",
      xRequestId,
    );
    return;
  }

  let bodyJson: unknown;
  try {
    bodyJson = JSON.parse(raw.toString("utf8"));
  } catch {
    partial.error_type = "invalid_request_error";
    partial.error_code = "body_parse_error";
    sendError(
      res,
      400,
      "invalid_request_error",
      "Request body is not valid JSON",
      "body_parse_error",
      xRequestId,
    );
    return;
  }

  const parseResult = chatCompletionRequestSchema.safeParse(bodyJson);
  if (!parseResult.success) {
    partial.error_type = "invalid_request_error";
    partial.error_code = "body_validation_error";
    // Diagnostic: surface the specific Zod failures in the journal so operators
    // can see WHICH field was wrong without needing body capture. Also attach
    // the raw (pre-Zod) body to the JSONL record — the request-logger's
    // redact() drops this field unless includeBodies=true, so PII is still
    // gated by CLAWCODE_OPENAI_LOG_BODIES.
    const issueSummary = parseResult.error.issues.map((i) => ({
      path: Array.isArray(i.path) ? i.path.join(".") : String(i.path ?? ""),
      code: i.code,
      message: i.message,
    }));
    log.info(
      { request_id: xRequestId, issues: issueSummary },
      "openai /v1/chat/completions body validation failed",
    );
    partial.raw_body = bodyJson as Record<string, unknown>;
    sendError(
      res,
      400,
      "invalid_request_error",
      `Invalid request body: ${parseResult.error.issues.map((i) => i.message).join("; ")}`,
      "body_validation_error",
      xRequestId,
    );
    return;
  }
  const body = parseResult.data as ChatCompletionRequest;
  partial.model = body.model;
  partial.stream = body.stream === true;
  partial.messages_count = body.messages.length;
  partial.messages = body.messages.map((m) => {
    const c = m.content as unknown;
    let text = "";
    if (typeof c === "string") {
      text = c;
    } else if (Array.isArray(c)) {
      // Flatten text-parts for the log record; image_url rendered as markdown.
      const parts: string[] = [];
      for (const p of c) {
        const part = p as { type?: string; text?: unknown; image_url?: unknown };
        if (part && part.type === "text" && typeof part.text === "string") {
          parts.push(part.text);
        } else if (part && part.type === "image_url") {
          const iu = part.image_url;
          const url = typeof iu === "string" ? iu : (iu as { url?: string })?.url;
          if (typeof url === "string") parts.push(`![image](${url})`);
        }
      }
      text = parts.join("\n\n");
    }
    return { role: m.role, content: text };
  });

  // 4. Translate OpenAI request → Claude inputs (moved up from post-scope-check
  //    for Phase 74 — caller-identity extraction needs tools/toolChoice/
  //    toolResults for the template-driver branch).
  let translated;
  try {
    translated = translateRequest(body);
  } catch (err) {
    if (err instanceof NoUserMessageError) {
      partial.error_type = "invalid_request_error";
      partial.error_code = "no_user_message";
      sendError(
        res,
        400,
        "invalid_request_error",
        "messages[] must contain at least one role:'user' entry",
        "no_user_message",
        xRequestId,
      );
      return;
    }
    partial.error_type = "invalid_request_error";
    partial.error_code = "translate_error";
    sendError(
      res,
      400,
      "invalid_request_error",
      "Failed to translate request",
      "translate_error",
      xRequestId,
    );
    return;
  }

  // 5. Phase 74 Plan 01 — caller-identity routing. Runs BEFORE scope-aware
  //    authz so that `openclaw:<slug>[:<tier>]` model ids can reach the
  //    template driver (they are NOT in the knownAgents list, so the
  //    Phase 69 scope-aware check would 404 them). extractCallerIdentity
  //    itself enforces scope='all' for the openclaw-template path —
  //    defense-in-depth against pinned-key impersonation.
  const knownAgents = topLevelAgents(config.agentNames());
  const callerIdentity = extractCallerIdentity(
    body,
    row,
    knownAgents,
    translated.tools,
    translated.toolChoice,
    translated.toolResults,
  );

  if ("error" in callerIdentity) {
    if (callerIdentity.error === "unknown_model") {
      partial.error_type = "invalid_request_error";
      partial.error_code = "unknown_model";
      sendError(
        res,
        404,
        "invalid_request_error",
        `Unknown model: '${body.model}'`,
        "unknown_model",
        xRequestId,
      );
      return;
    }
    // malformed_caller — bad openclaw: syntax OR pinned key trying the
    // template route.
    partial.error_type = "invalid_request_error";
    partial.error_code = "malformed_caller";
    sendError(
      res,
      400,
      "invalid_request_error",
      "Invalid caller identity: model must be 'openclaw:<slug>[:<tier>]' with tier in {sonnet, opus, haiku} and slug matching /^[a-z0-9][a-z0-9_-]{0,63}$/i",
      "malformed_caller",
      xRequestId,
    );
    return;
  }

  // 5a. Phase 74 template path — skip scope-aware authz (extractCallerIdentity
  //     already checked scope='all'), skip warm-path wait (transient handles
  //     don't live in SessionManager), dispatch to the template driver.
  if (callerIdentity.kind === "openclaw-template") {
    partial.agent = `openclaw:${callerIdentity.callerSlug}`;

    if (!config.templateDriver) {
      partial.error_type = "server_error";
      partial.error_code = "template_driver_disabled";
      sendError(
        res,
        501,
        "server_error",
        "OpenClaw template driver not configured on this daemon",
        "template_driver_disabled",
        xRequestId,
      );
      return;
    }

    // Fire-and-forget last-used stamp.
    try {
      config.apiKeysStore.touchLastUsed(row.key_hash);
    } catch (err) {
      log.debug({ err }, "touchLastUsed failed (non-fatal)");
    }

    const ac = new AbortController();
    const onClientClose = (): void => {
      ac.abort();
    };
    req.on("close", onClientClose);
    res.on("close", onClientClose);

    const turnId = newChatCompletionId();
    const templateInput: TemplateDriverInput = {
      agentName: `openclaw:${callerIdentity.callerSlug}`,
      keyHash: row.key_hash,
      callerSlug: callerIdentity.callerSlug,
      tier: callerIdentity.tier,
      soulPrompt: callerIdentity.soulPrompt,
      soulFp: callerIdentity.soulFp,
      lastUserMessage: translated.lastUserMessage,
      lastUserImages: translated.lastUserImages,
      clientSystemAppend: null,
      tools: translated.tools,
      toolChoice: translated.toolChoice,
      toolResults: translated.toolResults,
      signal: ac.signal,
      xRequestId,
    };

    // The template driver reads the TemplateDriverInput shape; the cast
    // below satisfies the OpenAiSessionDriver.dispatch parameter type.
    const driverInput = templateInput as unknown as Parameters<
      OpenAiSessionDriver["dispatch"]
    >[0];
    const templateConfig = { ...config, driver: config.templateDriver };

    if (body.stream) {
      const streamIncludeUsage = body.stream_options?.include_usage === true;
      await runStreaming(
        res,
        templateConfig,
        activeStreams,
        body.model,
        turnId,
        driverInput,
        streamIncludeUsage,
        xRequestId,
        log,
        partial,
      );
      return;
    }
    await runNonStreaming(
      res,
      body.model,
      turnId,
      driverInput,
      templateConfig,
      xRequestId,
      log,
      partial,
    );
    return;
  }

  // 5b. Native path — enforce scope-aware authz exactly as Phase 69 + quick
  //     task 260419-p51 did. body.model is known to be a valid top-level
  //     agent at this point (caller-identity's fast path confirmed).
  //    row.scope is one of:
  //      - "all"            — multi-agent key; allowed on any configured agent.
  //      - "agent:<name>"   — legacy pinned key; allowed only on the bound agent.
  //                           Mismatch → 403 (with no agent-name leak).
  const expectedAgentScope = `agent:${body.model}`;
  if (row.scope === "all") {
    // Stamp the TARGETED agent into the log record — scope="all" means the
    // key has no "owner" agent; the request determines which agent the turn
    // routes to. Overrides the earlier partial.agent = row.agent_name (="*").
    partial.agent = body.model;

    // Phase 74 Plan 02 — denyScopeAll gate. Scope='all' keys cannot target
    // native agents that have opted out via `security.denyScopeAll: true`.
    // The template-driver path (openclaw: prefix) is NOT subject to this
    // check — it was already handled above in branch 5a via
    // extractCallerIdentity() and never reaches this native branch.
    // Defaults to permissive when `getAgentConfig` is absent or returns
    // null/undefined — preserves Phase 69 backwards-compatibility.
    const targetCfg = config.getAgentConfig?.(body.model) ?? null;
    if (targetCfg && targetCfg.security?.denyScopeAll === true) {
      partial.error_type = "permission_error";
      partial.error_code = "agent_forbids_multi_agent_key";
      sendError(
        res,
        403,
        "permission_error",
        "The requested agent does not accept multi-agent bearer keys",
        "agent_forbids_multi_agent_key",
        xRequestId,
      );
      return;
    }
  } else if (row.scope === expectedAgentScope) {
    // Legacy pinned key on its bound agent — partial.agent already set above.
  } else {
    partial.error_type = "permission_error";
    partial.error_code = "agent_mismatch";
    sendError(
      res,
      403,
      "permission_error",
      "API key is not authorized for the requested model",
      "agent_mismatch",
      xRequestId,
    );
    return;
  }

  // 5c. Post-v2.0 hardening — warm-path startup race gate.
  // When `agentIsRunning` is provided (production path), bound the wait on
  // the agent becoming ready before dispatching. Plan 02 tests omit the
  // config field and skip the wait entirely — hermetic path preserved.
  const targetAgentName = body.model;
  if (config.agentIsRunning) {
    const ready = await waitForAgentReady(
      targetAgentName,
      config.agentIsRunning,
      config.agentReadinessWaitMs ?? 300,
      config.agentReadinessPollIntervalMs ?? 50,
    );
    if (!ready) {
      partial.error_type = "server_error";
      partial.error_code = "agent_warming";
      sendAgentWarming(res, xRequestId);
      return;
    }
  }

  // Fire-and-forget last-used stamp.
  try {
    config.apiKeysStore.touchLastUsed(row.key_hash);
  } catch (err) {
    log.debug({ err }, "touchLastUsed failed (non-fatal)");
  }

  // 6. Open AbortController for client-disconnect + shutdown.
  const ac = new AbortController();
  const onClientClose = (): void => {
    // Fire abort on every `close` event from the request. Guarding on
    // res.writableEnded is wrong for SSE: the response remains writable
    // (writableEnded === false) throughout the stream, so every real
    // client-close should always flow through to ac.abort(). If the
    // response is already ended cleanly via emitDone(), abort() on an
    // already-settled AC is a no-op.
    ac.abort();
  };
  req.on("close", onClientClose);
  res.on("close", onClientClose);

  // 7. Dispatch + branch on stream vs non-stream.
  // Quick task 260419-p51: agentName is always body.model (= targetAgentName)
  // so scope='all' keys route to the requested agent, not to "*".
  const turnId = newChatCompletionId();
  const driverInput = {
    agentName: targetAgentName,
    keyHash: row.key_hash,
    lastUserMessage: translated.lastUserMessage,
    lastUserImages: translated.lastUserImages,
    clientSystemAppend: translated.clientSystemAppend,
    tools: translated.tools,
    toolChoice: translated.toolChoice,
    toolResults: translated.toolResults,
    signal: ac.signal,
    xRequestId,
  };

  if (body.stream) {
    // Post-v2.0 hardening — honor stream_options.include_usage when present.
    const streamIncludeUsage = body.stream_options?.include_usage === true;
    await runStreaming(
      res,
      config,
      activeStreams,
      body.model,
      turnId,
      driverInput,
      streamIncludeUsage,
      xRequestId,
      log,
      partial,
    );
    return;
  }

  await runNonStreaming(res, body.model, turnId, driverInput, config, xRequestId, log, partial);
}

/**
 * Non-streaming path: drain the driver to completion, then emit a single
 * `chat.completion` response body. The translator accumulates `collectedText`
 * and `collectedToolCalls` as the stream replays so we can build the final
 * response without a second pass.
 */
async function runNonStreaming(
  res: ServerResponse,
  model: string,
  turnId: string,
  driverInput: Parameters<OpenAiSessionDriver["dispatch"]>[0],
  config: OpenAiServerConfig,
  xRequestId: string,
  log: Logger,
  partial: MutableLogRecord,
): Promise<void> {
  const translator = createStreamingTranslator({ id: turnId, model });
  try {
    for await (const event of config.driver.dispatch(driverInput)) {
      translator.onEvent(event);
    }
  } catch (err) {
    // Post-v2.0 hardening — defensive belt-and-suspenders: if the driver
    // somehow throws SessionError("not running") after the pre-dispatch
    // gate (race, no gate configured, etc.), surface a clean 503 rather
    // than the generic 500 driver_error. OpenAI clients can't distinguish
    // a transient warm-path miss from a permanent failure otherwise.
    if (isSessionNotRunningError(err)) {
      partial.error_type = "server_error";
      partial.error_code = "agent_warming";
      sendAgentWarming(res, xRequestId);
      return;
    }
    // The CLI completed the turn but the model call failed (e.g. the API's
    // `400 … version 2.1.280 or newer is required`). 502 + the upstream text,
    // not an opaque 500 — the caller can act on it and the log names the cause.
    if (isUpstreamTurnError(err)) {
      partial.error_type = "server_error";
      partial.error_code = "upstream_error";
      log.warn({ err }, "upstream model call failed on non-stream path");
      sendError(
        res,
        502,
        "server_error",
        upstreamErrorMessage(err),
        "upstream_error",
        xRequestId,
      );
      return;
    }
    partial.error_type = "server_error";
    partial.error_code = "driver_error";
    log.warn({ err }, "driver failed on non-stream path");
    sendError(
      res,
      500,
      "server_error",
      "Driver failed to produce a response",
      "driver_error",
      xRequestId,
    );
    return;
  }

  const toolCalls: ReadonlyArray<ChatCompletionToolCall> = translator.collectedToolCalls;
  const response = makeNonStreamResponse({
    id: turnId,
    model,
    text: translator.collectedText,
    toolCalls,
    usage: translator.usage,
  });
  // Quick task 260419-mvh — finish_reason mirrors makeNonStreamResponse logic
  // (tool_calls when toolCalls non-empty; stop otherwise). No additional
  // translator state required.
  partial.finish_reason = toolCalls.length > 0 ? "tool_calls" : "stop";
  partial.response_bytes = Buffer.byteLength(JSON.stringify(response));
  sendJson(res, 200, response, xRequestId);
}

/**
 * Streaming path: wrap `res` via `startOpenAiSse`, drive the translator event
 * by event, emit each chunk. On driver error mid-stream, call `emitError` so
 * the client sees a clean termination. Register/deregister on the
 * activeStreams set so the shutdown hook can close in-flight connections.
 *
 * Post-v2.0 hardening note — the primary warm-path guard is the
 * `waitForAgentReady` gate in `handleChatCompletions` (pre-dispatch, before
 * SSE headers are committed). By the time we're in `runStreaming`, SSE is
 * open and any `SessionError not-running` surfaces through the in-stream
 * `emitError` envelope with `agent_warming` code rather than a clean 503.
 * Keeping SSE headers committed immediately is required so keepalive pings
 * can start before the first driver event (see the keepalive test).
 */
async function runStreaming(
  res: ServerResponse,
  config: OpenAiServerConfig,
  activeStreams: Set<OpenAiSseHandle>,
  model: string,
  turnId: string,
  driverInput: Parameters<OpenAiSessionDriver["dispatch"]>[0],
  streamIncludeUsage: boolean,
  xRequestId: string,
  log: Logger,
  partial: MutableLogRecord,
): Promise<void> {
  const streamStart = Date.now();
  let sentFirstChunk = false;
  let emittedBytes = 0;
  // SSE headers need x-request-id too; startOpenAiSse writes its own
  // writeHead call, but we inject the x-request-id here by setting it on the
  // response before write occurs. node:http allows setHeader prior to
  // writeHead.
  res.setHeader("x-request-id", xRequestId);
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    res.setHeader(k, v);
  }

  const handle = startOpenAiSse(res, { keepaliveMs: config.streamKeepaliveMs });
  activeStreams.add(handle);
  handle.onClose(() => {
    activeStreams.delete(handle);
  });

  const translator = createStreamingTranslator({ id: turnId, model });
  try {
    for await (const event of config.driver.dispatch(driverInput)) {
      const chunks = translator.onEvent(event);
      for (const c of chunks) {
        if (!sentFirstChunk) {
          sentFirstChunk = true;
          partial.ttfb_ms = Date.now() - streamStart;
        }
        emittedBytes += Buffer.byteLength(JSON.stringify(c));
        const ok = await handle.emit(c);
        if (!ok) {
          // Client disconnected — abort driver iteration.
          partial.response_bytes = emittedBytes;
          return;
        }
      }
    }
    const finals = translator.finalize({ includeUsage: streamIncludeUsage });
    // Record the terminal chunk's finish_reason for observability.
    const terminal = finals[0] as
      | { choices: Array<{ finish_reason: string | null }> }
      | undefined;
    if (terminal?.choices?.[0]?.finish_reason) {
      partial.finish_reason = terminal.choices[0].finish_reason;
    }
    for (const c of finals) {
      emittedBytes += Buffer.byteLength(JSON.stringify(c));
      await handle.emit(c);
    }
    handle.emitDone();
    partial.response_bytes = emittedBytes;
  } catch (err) {
    // Post-v2.0 hardening — if the driver slipped past the pre-dispatch
    // gate and threw SessionError("not running"), surface the warm-path
    // signal through the in-stream error envelope rather than generic
    // driver_error. Headers are already committed at this point, so we
    // can't write a 503 cleanly — but the `agent_warming` code in the
    // OpenAI error envelope still tells the client this is retryable.
    if (isSessionNotRunningError(err)) {
      partial.error_type = "server_error";
      partial.error_code = "agent_warming";
      log.warn({ err }, "driver SessionError not-running mid-stream (post-gate race)");
      handle.emitError({
        error: {
          message: "Agent warming up, retry shortly",
          type: "server_error",
          code: "agent_warming",
        },
      });
    } else if (isUpstreamTurnError(err)) {
      // Same upstream failure as the non-stream path; headers are committed,
      // so it goes out as the in-stream OpenAI error envelope.
      partial.error_type = "server_error";
      partial.error_code = "upstream_error";
      log.warn({ err }, "upstream model call failed mid-stream");
      handle.emitError({
        error: {
          message: upstreamErrorMessage(err),
          type: "server_error",
          code: "upstream_error",
        },
      });
    } else {
      partial.error_type = "server_error";
      partial.error_code = "driver_error";
      log.warn({ err }, "driver failed mid-stream");
      handle.emitError({
        error: {
          message: "Driver failed mid-stream",
          type: "server_error",
          code: "driver_error",
        },
      });
    }
    partial.response_bytes = emittedBytes;
  } finally {
    activeStreams.delete(handle);
  }
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/**
 * Start the OpenAI HTTP listener. Returns a handle with `close()` that
 * gracefully ends all active SSE streams before closing the server (Pitfall 10).
 *
 * `port: 0` instructs the OS to choose a free ephemeral port — tests use this.
 */
export async function startOpenAiServer(
  config: OpenAiServerConfig,
): Promise<OpenAiServerHandle> {
  const log = config.log ?? pino({ name: "openai-endpoint", level: "info" });
  const bootEpochSeconds = Math.floor(Date.now() / 1000);
  const activeStreams = new Set<OpenAiSseHandle>();

  const server = createServer((req, res) => {
    const xRequestId = resolveXRequestId(req);
    void route(req, res, config, activeStreams, xRequestId, bootEpochSeconds, log);
  });

  return new Promise<OpenAiServerHandle>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      const addr = server.address();
      const boundPort =
        typeof addr === "object" && addr ? addr.port : config.port;
      log.info({ port: boundPort, host: config.host }, "OpenAI endpoint started");
      resolve({
        server,
        activeStreams,
        address: { port: boundPort, host: config.host },
        close: async () => {
          // Pitfall 10: close all active streams FIRST.
          for (const h of activeStreams) {
            try {
              h.close();
            } catch {
              // ignore
            }
          }
          activeStreams.clear();
          await new Promise<void>((r) => server.close(() => r()));
        },
      });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(config.port, config.host);
  });
}

/**
 * Quick task 260419-mvh — mutable per-request log record. Fields are filled
 * by the route handlers as they make progress (auth, body parse, translate,
 * dispatch). `res.on('close')` emits exactly one record via the injected
 * logger, guarded by a `logged` boolean so we never double-emit.
 */
interface MutableLogRecord {
  request_id: string;
  timestamp_iso: string;
  method: string;
  path: string;
  agent: string | null;
  model: string | null;
  stream: boolean | null;
  bearer_key_prefix: string | null;
  messages_count: number | null;
  status_code: number;
  ttfb_ms: number | null;
  total_ms: number;
  response_bytes: number;
  error_type: string | null;
  error_code: string | null;
  finish_reason: string | null;
  // Quick task 260419-mvh follow-up — populated at validation time with the
  // incoming `messages` array. The request-logger's `redact()` drops this
  // field entirely unless `includeBodies=true` (CLAWCODE_OPENAI_LOG_BODIES).
  // Stamped here so opt-in body capture actually has data to pass through;
  // without this, the env var was a no-op.
  messages?: ReadonlyArray<{ readonly role: string; readonly content: string }>;
  // Raw pre-Zod body attached only on 400 body_validation_error so operators
  // can see the exact payload shape the client sent. Also PII-gated through
  // the same `includeBodies` redaction.
  raw_body?: Record<string, unknown>;
}

/**
 * Top-level request router. Exported as `route` at module scope so the
 * handler functions stay small and composable.
 */
// ---------------------------------------------------------------------------
// clawdy-v2 #8 — cross-session memory endpoints (docs/MEMORY-CONTRACT.md v1)
// ---------------------------------------------------------------------------

/**
 * Read + JSON-parse a memory request body, sending the appropriate error
 * response and returning null on any failure (mirrors readBody's size guard +
 * the chat-completions Content-Type/JSON discipline). Returns a plain object on
 * success.
 */
async function readMemoryBody(
  req: IncomingMessage,
  res: ServerResponse,
  config: OpenAiServerConfig,
  xRequestId: string,
): Promise<Record<string, unknown> | null> {
  let raw: Buffer;
  try {
    raw = await readBody(req, config.maxRequestBodyBytes);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      sendError(res, 413, "invalid_request_error", "Request body too large", "body_too_large", xRequestId);
    } else {
      sendError(res, 400, "invalid_request_error", "Failed to read request body", "read_error", xRequestId);
    }
    return null;
  }
  try {
    const json = JSON.parse(raw.toString("utf8")) as unknown;
    if (json === null || typeof json !== "object" || Array.isArray(json)) {
      sendError(res, 400, "invalid_request_error", "Body must be a JSON object", "invalid_json", xRequestId);
      return null;
    }
    return json as Record<string, unknown>;
  } catch {
    sendError(res, 400, "invalid_request_error", "Body must be valid JSON", "invalid_json", xRequestId);
    return null;
  }
}

/**
 * Validate an ingest body into a StoredMemoryInput, or null if it doesn't meet
 * the contract's required shape ({id, savedAt, fact} all non-empty strings).
 * Forward-compatible: an explicit `v` that isn't 1 is rejected; absent `v` is
 * tolerated (the client only emits v:1).
 */
function parseStoredMemoryInput(body: Record<string, unknown>): StoredMemoryInput | null {
  if ("v" in body && body["v"] !== 1) return null;
  const id = body["id"];
  const savedAt = body["savedAt"];
  const fact = body["fact"];
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof savedAt !== "string" || savedAt.length === 0) return null;
  if (typeof fact !== "string" || fact.length === 0) return null;
  const context = body["context"];
  const sourceSessionID = body["sourceSessionID"];
  return {
    id,
    savedAt,
    fact,
    ...(typeof context === "string" ? { context } : {}),
    ...(typeof sourceSessionID === "string" ? { sourceSessionID } : {}),
  };
}

/**
 * Dispatch the `/v1/memory*` routes. Auth reuses the chat-endpoint flow
 * (bearer → lookupByIncomingKey → agent_name) but REQUIRES an agent-scoped key:
 * the memory contract assumes one device == one agent's store, and a
 * `scope='all'` key has no single owning agent (agent_name '*' has no
 * MemoryStore). All handlers are best-effort 200 per the contract (the client
 * degrades to `[]`/ignores the result on any non-2xx).
 */
async function handleMemory(
  req: IncomingMessage,
  res: ServerResponse,
  config: OpenAiServerConfig,
  method: string,
  url: string,
  xRequestId: string,
): Promise<void> {
  if (!config.memoryGateway) {
    sendError(res, 501, "server_error", "Memory endpoints are not enabled", "memory_not_enabled", xRequestId);
    return;
  }
  const gateway: MemoryGateway = config.memoryGateway;

  const bearer = extractBearer(req);
  if (bearer === null) {
    sendError(res, 401, "authentication_error", "Missing bearer token in Authorization header", "missing_key", xRequestId);
    return;
  }
  const row = config.apiKeysStore.lookupByIncomingKey(bearer);
  if (row === null) {
    sendError(res, 401, "authentication_error", "Invalid or revoked API key", "invalid_key", xRequestId);
    return;
  }
  if (row.scope === "all" || row.agent_name === "*") {
    sendError(res, 403, "permission_error", "Memory endpoints require an agent-scoped key", "memory_requires_agent_key", xRequestId);
    return;
  }
  const agentName = row.agent_name;

  // GET /v1/memory — list device-ingested memories (newest first).
  if (method === "GET" && url === "/v1/memory") {
    const memories = gateway.list(agentName);
    sendJson(res, 200, { v: 1, memories }, xRequestId);
    return;
  }

  // POST /v1/memory/ingest — push a distilled memory (idempotent on id).
  if (method === "POST" && url === "/v1/memory/ingest") {
    const body = await readMemoryBody(req, res, config, xRequestId);
    if (body === null) return; // response already sent
    const input = parseStoredMemoryInput(body);
    if (input === null) {
      sendError(res, 400, "invalid_request_error", "Body must include non-empty string `id`, `savedAt`, and `fact`", "invalid_memory", xRequestId);
      return;
    }
    await gateway.ingest(agentName, input);
    sendJson(res, 200, { ok: true }, xRequestId);
    return;
  }

  // PATCH / DELETE /v1/memory/{id}
  if (url.startsWith("/v1/memory/") && url !== "/v1/memory/ingest") {
    const id = decodeURIComponent(url.slice("/v1/memory/".length));
    if (id.length === 0) {
      sendError(res, 404, "not_found_error", "Missing memory id", "missing_id", xRequestId);
      return;
    }
    if (method === "PATCH") {
      const body = await readMemoryBody(req, res, config, xRequestId);
      if (body === null) return;
      const fact = body["fact"];
      if (typeof fact !== "string" || fact.length === 0) {
        sendError(res, 400, "invalid_request_error", "Body must include a non-empty string `fact`", "invalid_fact", xRequestId);
        return;
      }
      const matched = gateway.updateFact(agentName, id, fact);
      sendJson(res, 200, { ok: true, matched }, xRequestId);
      return;
    }
    if (method === "DELETE") {
      const matched = gateway.forget(agentName, id);
      sendJson(res, 200, { ok: true, matched }, xRequestId);
      return;
    }
  }

  sendError(res, 405, "invalid_request_error", "Method Not Allowed", "method_not_allowed", xRequestId);
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  config: OpenAiServerConfig,
  activeStreams: Set<OpenAiSseHandle>,
  xRequestId: string,
  bootEpochSeconds: number,
  log: Logger,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = (req.url ?? "/").split("?")[0] ?? "/";
  const startMs = Date.now();

  // Build the mutable record up front — handlers mutate only what they know.
  const partial: MutableLogRecord = {
    request_id: xRequestId,
    timestamp_iso: new Date(startMs).toISOString(),
    method,
    path: url,
    agent: null,
    model: null,
    stream: null,
    bearer_key_prefix: null,
    messages_count: null,
    status_code: 0,
    ttfb_ms: null,
    total_ms: 0,
    response_bytes: 0,
    error_type: null,
    error_code: null,
    finish_reason: null,
  };

  if (config.requestLogger) {
    let logged = false;
    res.on("close", () => {
      if (logged) return;
      logged = true;
      partial.total_ms = Date.now() - startMs;
      partial.status_code = res.statusCode;
      if (partial.response_bytes === 0) {
        // Best-effort fallback when handlers didn't stamp it.
        const cl = res.getHeader("content-length");
        const n = typeof cl === "string" ? Number.parseInt(cl, 10) : typeof cl === "number" ? cl : 0;
        if (Number.isFinite(n) && n >= 0) partial.response_bytes = n;
      }
      try {
        config.requestLogger!.log(partial as RequestLogRecord);
      } catch {
        // createRequestLogger swallows fs errors internally — belt-and-suspenders.
      }
    });
  }

  try {
    if (method === "OPTIONS") {
      handleOptions(res, xRequestId);
      return;
    }

    if (method === "GET" && url === "/v1/models") {
      handleModels(res, config, xRequestId, bootEpochSeconds);
      return;
    }

    if (method === "POST" && url === "/v1/chat/completions") {
      await handleChatCompletions(
        req,
        res,
        config,
        activeStreams,
        xRequestId,
        log,
        partial,
      );
      return;
    }

    // clawdy-v2 #8 — cross-session memory REST endpoints.
    if (url === "/v1/memory" || url.startsWith("/v1/memory/")) {
      await handleMemory(req, res, config, method, url, xRequestId);
      return;
    }

    sendError(res, 404, "not_found_error", "Not Found", "route_not_found", xRequestId);
  } catch (err) {
    log.error({ err }, "unhandled error in openai route");
    if (!res.writableEnded) {
      sendError(
        res,
        500,
        "server_error",
        "Internal Server Error",
        "unhandled_error",
        xRequestId,
      );
    }
  }
}
