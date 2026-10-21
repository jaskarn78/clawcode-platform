/**
 * Phase 69 Plan 03 Task 3 — Daemon-integration bootstrap for the OpenAI endpoint.
 *
 * Exposes `startOpenAiEndpoint(deps, config)` — a self-contained helper that
 * the daemon (src/manager/daemon.ts) calls after SessionManager + ConversationStore
 * are ready. Factored out so tests can exercise boot ordering, env overrides,
 * EADDRINUSE handling, and shutdown semantics without booting the full daemon.
 *
 * Contract:
 *
 *   - Read `config.defaults.openai` (port/host/maxRequestBodyBytes/streamKeepaliveMs).
 *   - Honor `CLAWCODE_OPENAI_HOST` / `CLAWCODE_OPENAI_PORT` env overrides. `PORT`
 *     parses as integer; non-parseable → fall back to config value.
 *   - `config.defaults.openai.enabled === false` short-circuits: returns a
 *     disabled handle with a no-op `close()`. Logs `{enabled:false}`.
 *   - EADDRINUSE during `startOpenAiServer.listen()` is NON-FATAL: log warn +
 *     return a disabled handle. Daemon boot continues (mirrors dashboard pattern
 *     at src/manager/daemon.ts:1184-1189).
 *   - On clean start: return `OpenAiEndpointHandle` with `close()` that
 *     (1) iterates `activeStreams` and closes each, then (2) closes the server,
 *     then (3) closes `apiKeysStore` (Pitfall 10 — graceful shutdown).
 *
 * The helper constructs the ApiKeysStore + the OpenAiSessionDriver internally
 * so the daemon only has to provide the primitives (sessionManager,
 * turnDispatcher, agentNames function, log). This keeps daemon.ts diff minimal
 * and the unit-test surface tight.
 */

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { Logger } from "pino";

import { ApiKeysStore } from "./keys.js";
import {
  createOpenAiSessionDriver,
  type AgentBaseOptions,
} from "./driver.js";
import { ApiKeySessionIndex } from "./session-index.js";
import { createRequestLogger, type RequestLogger } from "./request-logger.js";
import { TransientSessionCache } from "./transient-session-cache.js";
import { createOpenClawTemplateDriver } from "./template-driver.js";
import { sha256Hex } from "./caller-identity.js";
import { TIER_MODEL_MAP } from "./types.js";
import type { OpenAiSessionDriver } from "./server.js";
import type { SessionManager } from "../manager/session-manager.js";
import { resolveExecutorModelForGates } from "../manager/model-resolver.js";
import { readSoulContent } from "../manager/persona-files.js";
import type { TurnDispatcher } from "../manager/turn-dispatcher.js";
import { isSubagentOrThreadSession } from "../manager/subagent-name.js";
import { createMemoryGateway } from "../manager/openai-memory-gateway.js";
import type { SdkModule } from "../manager/sdk-types.js";
import { TurnLossMonitor } from "../manager/turn-loss-monitor.js";
import { normalizeSloModel, DEFAULT_MODEL_SLOS, type SloModel } from "../performance/slos.js";

/** Config block consumed by the helper — mirrors `openaiEndpointSchema`. */
export interface OpenAiEndpointConfig {
  readonly enabled: boolean;
  readonly port: number;
  readonly host: string;
  readonly maxRequestBodyBytes: number;
  readonly streamKeepaliveMs: number;
}

/** Dependency bag injected by daemon.ts. */
export interface OpenAiEndpointDeps {
  readonly managerDir: string;
  readonly sessionManager: SessionManager;
  /**
   * Phase 140 Plan 05 — VESTIGIAL. The native driver was re-pointed off the
   * live `TurnDispatcher.dispatchStream` seam onto its own transient
   * masking-backed session (under v3 the live chat agent is a `claude
   * --channels` session with no in-process Query). This field is retained only
   * for interface stability with daemon.ts's existing call site; the bootstrap
   * no longer forwards it to any driver. Drop it when daemon.ts is next touched.
   */
  readonly turnDispatcher: TurnDispatcher;
  readonly agentNames: () => ReadonlyArray<string>;
  readonly log: Logger;
  /**
   * Injected factory for `startOpenAiServer` — tests override to inject an
   * EADDRINUSE-throwing mock or a handle with observable close() order. The
   * default is the real `startOpenAiServer` from `./server.js`.
   */
  readonly startServer?: typeof import("./server.js").startOpenAiServer;
  /** Injected factory for ApiKeysStore — tests pass a `:memory:` path stub. */
  readonly apiKeysStoreFactory?: (dbPath: string) => ApiKeysStore;
  /**
   * Quick task 260419-mvh — injected request logger for tests. Absent in
   * production: the helper builds a default logger pointing at managerDir
   * and honoring CLAWCODE_OPENAI_LOG_DIR / CLAWCODE_OPENAI_LOG_BODIES.
   */
  readonly requestLogger?: RequestLogger;
  /**
   * Phase 74 Plan 01 — SdkModule handle the OpenClawTemplateDriver uses for
   * spawning transient persistent SDK sessions. Optional for backwards-
   * compatibility with existing callers (daemon.ts wiring is additive): when
   * absent, the template driver is NOT wired and `openclaw:`-prefixed
   * requests receive 501 template_driver_disabled.
   */
  readonly sdk?: SdkModule;
}

/** Returned handle — `enabled:false` means startup was skipped or failed. */
export interface OpenAiEndpointHandle {
  readonly enabled: boolean;
  readonly port?: number;
  readonly host?: string;
  /**
   * Exposed so IPC / CLI handlers can reuse the already-opened store
   * without re-opening the SQLite file.
   */
  readonly apiKeysStore?: ApiKeysStore;
  /**
   * Phase 74 Plan 02 — exposed for admin / observability. Daemon shutdown
   * relies on `close()` draining this internally; external callers only
   * need it for size probes / metrics.
   */
  readonly transientCache?: TransientSessionCache;
  close(): Promise<void>;
}

const NOOP_HANDLE: OpenAiEndpointHandle = {
  enabled: false,
  close: async () => {
    /* no-op */
  },
};

/**
 * Env-var override reader. `CLAWCODE_OPENAI_PORT` parses as integer; anything
 * non-integer (empty, NaN, negative, >65535) falls back to the config value.
 */
function resolveEnvOverrides(config: OpenAiEndpointConfig): {
  port: number;
  host: string;
} {
  const hostEnv = process.env.CLAWCODE_OPENAI_HOST;
  const host = hostEnv && hostEnv.length > 0 ? hostEnv : config.host;
  const portEnv = process.env.CLAWCODE_OPENAI_PORT;
  let port = config.port;
  if (portEnv) {
    const parsed = Number.parseInt(portEnv, 10);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
      port = parsed;
    }
  }
  return { port, host };
}

/**
 * Phase 73 Plan 02 — parse CLAWCODE_OPENAI_READINESS_WAIT_MS env override.
 *
 * Returns undefined (server uses its 300ms default) when absent or invalid.
 * Returns a bounded integer in [0, 60_000] when valid. Logs a warn on
 * invalid values so operators see why their override was ignored. Exported
 * for unit tests to pin the parse contract without booting an endpoint.
 */
export function parseReadinessWaitMs(
  raw: string | undefined,
  log?: { warn: (obj: Record<string, unknown>, msg?: string) => void },
): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || n > 60_000) {
    log?.warn(
      { raw, default: 300 },
      "CLAWCODE_OPENAI_READINESS_WAIT_MS invalid — using default 300ms",
    );
    return undefined;
  }
  return n;
}

/** Detect EADDRINUSE across Node error surface shapes. */
function isAddrInUse(err: unknown): boolean {
  if (err && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (code === "EADDRINUSE") return true;
    const message =
      (err as { message?: unknown }).message instanceof String ||
      typeof (err as { message?: unknown }).message === "string"
        ? String((err as { message: string }).message)
        : "";
    if (message.includes("EADDRINUSE")) return true;
  }
  return false;
}

/**
 * Start the OpenAI HTTP endpoint after SessionManager + ConversationStore are
 * ready. Returns a handle whose `close()` is safe to call during daemon
 * shutdown.
 */
/**
 * Narrow a full ResolvedAgentConfig down to the minimal shape the OpenAI server
 * reads (keeps server.ts hermetic from the config module). Returns null for an
 * unknown agent.
 *
 * SILENT-PATH-BIFURCATION GUARD: this MUST forward every field server.ts
 * consults — today only `security.denyScopeAll` (the denyScopeAll 403 gate).
 * Unit-tested so the mapping can't drift from what the server reads.
 *
 * `openaiVoice` is deliberately NOT forwarded: the voice full-session route
 * was unwired from the endpoint on 2026-09-23 (feature unfinished), so an
 * `openaiVoice` block in the yaml is inert here.
 */
export function mapAgentConfigForServer(
  cfg: import("../shared/types.js").ResolvedAgentConfig | null | undefined,
):
  | {
      security?: { denyScopeAll?: boolean } | undefined;
    }
  | null {
  if (!cfg) return null;
  return {
    security: cfg.security
      ? { denyScopeAll: cfg.security.denyScopeAll }
      : undefined,
  };
}

type BaseOptionsConfig = Pick<
  import("../shared/types.js").ResolvedAgentConfig,
  "model" | "soul" | "soulFile" | "workspace"
>;

/**
 * The concrete SDK model id for an agent, resolved exactly like the CLI-version
 * boot guard does (`resolveExecutorModelForGates`): `<family>@latest` → that
 * family's catalog pin, an alias → its id. The old `cfg.model as Tier` cast
 * looked the raw value up in `TIER_MODEL_MAP`, so every `opus@latest` /
 * `fable@latest` / pinned-alias agent got `model: undefined` and silently ran
 * the CLI's default model.
 */
export function agentModelFromConfig(
  cfg: Pick<BaseOptionsConfig, "model"> | null | undefined,
): string {
  return resolveExecutorModelForGates(cfg?.model ?? "sonnet");
}

/**
 * The native driver's per-agent base options, from the agent's resolved config.
 *
 * The soul resolves by the same precedence agent sessions use
 * (`readSoulContent`: soulFile → <workspace>/SOUL.md → inline soul). Reading
 * only the inline `soul` left every `soulFile` agent with an empty system
 * prompt over the API. Read per request, so a SOUL.md edit changes `soulFp` and
 * the next request gets a fresh handle.
 */
export async function agentBaseOptionsFromConfig(
  cfg: BaseOptionsConfig | null | undefined,
): Promise<AgentBaseOptions> {
  const soulPrompt = cfg ? await readSoulContent(cfg) : "";
  return {
    soulPrompt,
    model: agentModelFromConfig(cfg),
    soulFp: sha256Hex(soulPrompt).slice(0, 16),
  };
}

export async function startOpenAiEndpoint(
  deps: OpenAiEndpointDeps,
  config: OpenAiEndpointConfig,
): Promise<OpenAiEndpointHandle> {
  const { log } = deps;

  if (!config.enabled) {
    log.info({ enabled: false }, "OpenAI endpoint disabled via config");
    return NOOP_HANDLE;
  }

  const { port, host } = resolveEnvOverrides(config);

  // Open the daemon-level api-keys store exactly once; close it on shutdown.
  const apiKeysPath = join(deps.managerDir, "api-keys.db");
  const apiKeysStore = deps.apiKeysStoreFactory
    ? deps.apiKeysStoreFactory(apiKeysPath)
    : new ApiKeysStore(apiKeysPath);

  // Phase 74 Plan 01 — build the OpenClaw template driver + its transient
  // session cache. If `deps.sdk` is absent (daemon.ts not yet threading the
  // SDK through), dynamically import it here — mirrors the loadSdk() pattern
  // in session-adapter.ts so the template driver always has a live SDK
  // handle in production. Tests inject deps.sdk explicitly. Operator can
  // tune the LRU cap and idle TTL via env vars (defaults: 32 handles,
  // 30 minutes). Auth-gated downstream — only scope='all' bearer + openclaw:
  // prefix reach the template driver (extractCallerIdentity enforces both).
  const templateCacheSize =
    Number.parseInt(
      process.env.CLAWCODE_OPENCLAW_TEMPLATE_CACHE_SIZE ?? "32",
      10,
    ) || 32;
  const templateTtlMs =
    Number.parseInt(
      process.env.CLAWCODE_OPENCLAW_TEMPLATE_TTL_MS ??
        String(30 * 60 * 1000),
      10,
    ) || 30 * 60 * 1000;
  const transientCache = new TransientSessionCache({
    maxSize: templateCacheSize,
    ttlMs: templateTtlMs,
    log,
  });
  let templateSdk: SdkModule | undefined = deps.sdk;
  if (!templateSdk) {
    try {
      // Phase 138 Plan 04 T-03 — route the openclaw template driver's
      // SDK load through the `src/llm-runtime/` factory seam.
      //
      // The openclaw template driver has NO per-agent identity — it
      // serves `openclaw:<slug>` callers routed to the first
      // top-level agent's tracker DB (see the routing below) and uses
      // the DEFAULT backend. It is therefore NOT a per-agent
      // failover-aware path: it resolves via `createLlmRuntimeService`
      // with a synthetic system config rather than the daemon's
      // per-agent resolver registry. Failover (138-05) does not apply
      // to the template driver. The synthetic config carries only the
      // three fields the factory reads (`name`, `model`, optional
      // `llmRuntime`); with no `llmRuntime` block it defaults to
      // `anthropic-agent-sdk` — byte-identical to the prior direct
      // free-function load. The not-installed catch + warn-log
      // behaviour is preserved verbatim.
      const { createLlmRuntimeService } = await import(
        "../llm-runtime/index.js"
      );
      const syntheticSystemConfig = {
        name: "openclaw-template-driver",
        model: "sonnet",
      } as unknown as import("../shared/types.js").ResolvedAgentConfig;
      templateSdk = await createLlmRuntimeService(syntheticSystemConfig, {
        logger: log,
      }).loadSdkModule();
    } catch (err) {
      log.warn(
        { err: (err as Error).message },
        "openclaw template driver disabled — @anthropic-ai/claude-agent-sdk not available",
      );
    }
  }
  // Phase 140 Plan 05 — build the production native OpenAiSessionDriver.
  //
  // Under v3 the live chat agent is a `claude --channels` session with no
  // in-process Query, so the native driver can no longer dispatch through the
  // live `TurnDispatcher.dispatchStream` seam. It is re-pointed onto its OWN
  // transient masking-backed session (subscription pool — masking stays as the
  // OpenAI billing substrate; CONTEXT 140 LOCKED). The drain-then-handle
  // materialization + cache mirror the template driver above.
  //
  // The native cache is a DEDICATED instance (NOT shared with `transientCache`
  // above): native = per-bearer-per-agent OpenAI traffic; template =
  // per-bearer-per-slug arbitrary callers. A shared LRU would let one workload
  // evict the other's hot handles, defeating the first_token cache.
  const nativeCacheSize =
    Number.parseInt(
      process.env.CLAWCODE_OPENAI_NATIVE_CACHE_SIZE ?? "32",
      10,
    ) || 32;
  const nativeTtlMs =
    Number.parseInt(
      process.env.CLAWCODE_OPENAI_NATIVE_TTL_MS ?? String(30 * 60 * 1000),
      10,
    ) || 30 * 60 * 1000;
  const nativeTransientCache = new TransientSessionCache({
    maxSize: nativeCacheSize,
    ttlMs: nativeTtlMs,
    log,
  });
  const ensureTransientCwd = (p: string): void => {
    try {
      mkdirSync(p, { recursive: true });
    } catch (err) {
      log.warn(
        { err: (err as Error).message, path: p },
        "ensureCwd: mkdir failed (non-fatal, SDK will surface spawn error)",
      );
    }
  };
  // `getAgentBaseOptions` — the native-path analog of extractCallerIdentity,
  // resolved server-side by agent name from the daemon's resolved config. The
  // soul/system prompt + model id feed the masking-backed handle; soulFp keys
  // the cache so a soul edit forces a fresh handle.
  const getAgentBaseOptions = (agentName: string): Promise<AgentBaseOptions> =>
    agentBaseOptionsFromConfig(deps.sessionManager.getAgentConfig(agentName));
  // Phase 140 Plan 06 Task 11 — the v3 turn-loss watchdog for daemon-initiated
  // OpenAI-native turns. Constructed ONCE here (bootstrap runs once per daemon;
  // the monitor is keyed by turn id so a single instance covers every agent).
  //
  // Integration-point decision: the native OpenAI driver is the v3
  // daemon-initiated turn whose lifecycle the daemon FULLY observes (post-140-05
  // it runs on its own transient masking-backed session — the live-chat-agent
  // `TurnDispatcher` seam was removed). The two other 140-05 candidates do not
  // apply: the ClawCode channel push→ack path (`AgentChannelBridge`) is not
  // instantiated in production yet (Stage-2 socket server unwired), and hooking
  // `TraceCollector.startTurn` at the class level would silently cover the v2
  // human-Discord masking path. So we arm/cancel from `driver.ts` (see its
  // `turnLossMonitor` dep) — a v3-only observer, NOT the v2 turn path.
  //
  // p99 source = the per-model SLO from `src/performance/slos.ts` (the
  // constraint's named source). `DEFAULT_MODEL_SLOS[model].end_to_end_p95_ms`
  // is a p95; the monitor's own floor provenance uses p99 ≈ p95 × 1.5, so we
  // return p95 × 1.5 as the per-agent p99 ESTIMATE and the monitor applies its
  // own × 3 → deadline = p95 × 4.5 (sonnet 135s / opus 180s / haiku 67.5s).
  // Deterministic + no TraceStore failure surface in the OpenAI hot path; a
  // missing/invalid model falls through to the monitor's TURN_LOSS_FLOOR_MS.
  const turnLossMonitor = new TurnLossMonitor({
    getEndToEndP99Ms: (agentName: string): number | null => {
      try {
        const cfg = deps.sessionManager.getAgentConfig(agentName);
        // Phase 999.114 — was `cfg?.model as SloModel`, which silently returned
        // null for any value that is not a bare family name. With historical
        // pins selectable ("opus-4-6", "fable-5") and `<family>@latest` tracks,
        // that miss became the common case, not the edge case. Normalize to the
        // family bucket instead of casting.
        const raw = cfg?.model;
        if (!raw) return null;
        const model = normalizeSloModel(raw);
        if (!(model in DEFAULT_MODEL_SLOS)) return null;
        return DEFAULT_MODEL_SLOS[model].end_to_end_p95_ms * 1.5;
      } catch {
        // Telemetry must never fault the turn — fall back to the monitor floor.
        return null;
      }
    },
  });

  const driver: OpenAiSessionDriver = templateSdk
    ? createOpenAiSessionDriver({
        sessionManager: deps.sessionManager,
        sdk: templateSdk,
        transientCache: nativeTransientCache,
        getAgentBaseOptions,
        turnLossMonitor,
        sessionIndexFor: (agentName: string) => {
          const store = deps.sessionManager.getMemoryStore(agentName);
          if (!store) {
            throw new Error(
              `OpenAi endpoint: no MemoryStore for agent '${agentName}' — cannot build ApiKeySessionIndex`,
            );
          }
          return new ApiKeySessionIndex(store.getDatabase());
        },
        traceCollectorFor: (agentName: string) =>
          deps.sessionManager.getTraceCollector(agentName) ?? null,
        ensureCwd: ensureTransientCwd,
        // Phase 140 Plan 05 — restore native OpenAI usage attribution. The
        // pre-re-point path dispatched through the agent's MAIN session handle
        // (usageCallback wired by SessionManager); the transient handle has no
        // ambient callback, so without this hook native OpenAI cost rows would
        // silently disappear. Route to the agent's OWN UsageTracker — the
        // agent is concrete here (unlike the template path's fleet anchor).
        // Non-fatal: a missing tracker (boot race) skips the row (Pitfall 8).
        onUsage: (agentName, usage, sessionId, elapsedMs) => {
          try {
            const tracker = deps.sessionManager.getUsageTracker(agentName);
            if (!tracker) return;
            // Same resolution the handle was spawned with, so the cost row
            // names the model that actually ran (the old tier cast recorded
            // `undefined` for every `@latest` agent).
            const model = agentModelFromConfig(
              deps.sessionManager.getAgentConfig(agentName),
            );
            const u = (usage ?? {}) as {
              tokens_in?: number;
              tokens_out?: number;
              cost_usd?: number;
            };
            tracker.record({
              agent: agentName,
              timestamp: new Date().toISOString(),
              tokens_in: u.tokens_in ?? 0,
              tokens_out: u.tokens_out ?? 0,
              cost_usd: u.cost_usd ?? 0,
              turns: 1,
              model,
              duration_ms: elapsedMs,
              session_id: sessionId,
            });
          } catch (err) {
            log.warn(
              { err, agent: agentName },
              "openai native usage tracker.record failed (non-fatal)",
            );
          }
        },
        log,
      })
    : {
        // SDK not installed — degraded mode. The endpoint still boots; native
        // dispatch surfaces a clear error (mirrors the template driver's
        // graceful-disable below). Production always has the SDK present.
        dispatch() {
          throw new Error(
            "OpenAi native driver disabled — @anthropic-ai/claude-agent-sdk not available",
          );
        },
      };

  const templateDriver = templateSdk
    ? createOpenClawTemplateDriver({
        sdk: templateSdk,
        cache: transientCache,
        log,
        // Phase 74 hotfix — without ensureCwd the SDK subprocess tries to
        // chdir to a non-existent directory and dies with a misleading "Claude
        // Code executable not found" error. Pre-create the transient cwd
        // idempotently on every first-handle-materialization.
        ensureCwd: (p) => {
          try {
            mkdirSync(p, { recursive: true });
          } catch (err) {
            log.warn(
              { err: (err as Error).message, path: p },
              "ensureCwd: mkdir failed (non-fatal, SDK will surface spawn error)",
            );
          }
        },
        // Phase 74 Plan 02 — caller-attributed cost rows. Every completed
        // transient turn fires this callback; we route UsageTracker.record
        // with agent='openclaw:<slug>' (tier encoded in the model field,
        // not the agent field — matches CONTEXT D-04: one cost row per
        // caller, not per (caller, tier)).
        //
        // NOTE: UsageTracker instances are PER-AGENT. Transient sessions
        // have no native agent, so we route to the first top-level agent's
        // tracker DB. The `agent` column keeps openclaw rows distinguishable
        // from native rows at query time — getCostsByAgentModel groups by
        // (agent, model), so each caller slug forms its own row regardless
        // of which DB file holds the row. When no top-level agent exists
        // yet (e.g. daemon boot race), tracker.record is skipped — cost
        // accounting is non-critical (Pitfall 8).
        onUsage: (input, usage, sessionId, elapsedMs) => {
          try {
            const names = deps.agentNames();
            // Phase 999.19 — central predicate also excludes the -via-
            // delegated pattern so a delegated session can't be picked
            // as the fleet cost anchor.
            const fleetAnchor = names.find(
              (n) => !isSubagentOrThreadSession(n),
            );
            const tracker = fleetAnchor
              ? deps.sessionManager.getUsageTracker(fleetAnchor)
              : undefined;
            if (!tracker) return; // No tracker — non-fatal skip.
            const u = (usage ?? {}) as {
              tokens_in?: number;
              tokens_out?: number;
              cost_usd?: number;
            };
            tracker.record({
              agent: `openclaw:${input.callerSlug}`,
              timestamp: new Date().toISOString(),
              tokens_in: u.tokens_in ?? 0,
              tokens_out: u.tokens_out ?? 0,
              cost_usd: u.cost_usd ?? 0,
              turns: 1,
              model: TIER_MODEL_MAP[input.tier],
              duration_ms: elapsedMs,
              session_id: sessionId,
            });
          } catch (err) {
            log.warn(
              { err, callerSlug: input.callerSlug },
              "tracker.record failed (non-fatal)",
            );
          }
        },
      })
    : undefined;

  const startServer = deps.startServer ?? (await import("./server.js")).startOpenAiServer;

  // clawdy-v2 #8 — cross-session memory gateway for the /v1/memory* endpoints.
  // One instance for the server; its methods resolve the per-agent store +
  // embedder by name on each call (the bearer key's agent_name).
  const memoryGateway = createMemoryGateway({
    getStore: (name: string) => deps.sessionManager.getMemoryStore(name),
    embed: (text: string) => deps.sessionManager.embedText(text),
  });

  // Phase 73 Plan 02 — env override (undefined → server uses its 300ms default).
  const readinessWaitMs = parseReadinessWaitMs(
    process.env.CLAWCODE_OPENAI_READINESS_WAIT_MS,
    log,
  );

  // Quick task 260419-mvh — build the default request logger when tests don't
  // inject one. Honors CLAWCODE_OPENAI_LOG_DIR (defaults to managerDir) and
  // CLAWCODE_OPENAI_LOG_BODIES (opt-in PII capture; default false).
  const requestLogger =
    deps.requestLogger ??
    createRequestLogger({
      dir: process.env.CLAWCODE_OPENAI_LOG_DIR ?? deps.managerDir,
      includeBodies: process.env.CLAWCODE_OPENAI_LOG_BODIES === "true",
      log,
    });

  let handle: Awaited<ReturnType<typeof startServer>>;
  try {
    handle = await startServer({
      port,
      host,
      maxRequestBodyBytes: config.maxRequestBodyBytes,
      streamKeepaliveMs: config.streamKeepaliveMs,
      apiKeysStore,
      driver,
      agentNames: deps.agentNames,
      log,
      // Phase 73 Plan 02 — warm-path startup race: handler polls isRunning
      // up to agentReadinessWaitMs (default 300ms post persistent-subprocess)
      // before responding 503 Retry-After rather than 500 driver_error.
      agentIsRunning: deps.sessionManager.isRunning.bind(deps.sessionManager),
      // Phase 74 Plan 02 — per-agent config lookup for the denyScopeAll
      // gate. scope='all' bearer keys targeting an agent with
      // `security.denyScopeAll: true` receive 403
      // agent_forbids_multi_agent_key. Returns null when the agent is not
      // registered on this daemon (falls through to the Phase 69
      // agent_mismatch path, not the denyScopeAll 403). Narrows
      // ResolvedAgentConfig down to the minimum shape the server reads —
      // keeps server.ts hermetic from the config module.
      getAgentConfig: (name: string) =>
        mapAgentConfigForServer(deps.sessionManager.getAgentConfig(name)),
      ...(readinessWaitMs !== undefined
        ? { agentReadinessWaitMs: readinessWaitMs }
        : {}),
      // Quick task 260419-mvh — JSONL request feed for diagnostics.
      requestLogger,
      // Phase 74 Plan 01 — template driver for openclaw: prefixed requests.
      ...(templateDriver ? { templateDriver } : {}),
      // clawdy-v2 #8 — cross-session memory REST endpoints.
      memoryGateway,
    });
  } catch (err) {
    if (isAddrInUse(err)) {
      log.warn(
        { port, host, error: (err as Error).message },
        "OpenAI endpoint port in use — set CLAWCODE_OPENAI_PORT to a different port; continuing without endpoint",
      );
    } else {
      log.error(
        { port, host, error: (err as Error).message },
        "OpenAI endpoint failed to start — continuing without endpoint",
      );
    }
    // Keep apiKeysStore open? No — if the listener failed, close the store so
    // we don't leak the SQLite handle. CLI operations that need the store
    // will open it directly (the fallback path).
    try {
      apiKeysStore.close();
    } catch {
      /* non-fatal */
    }
    // Quick task 260419-mvh — close the logger so future-async writes don't
    // keep a stale handle behind us. Current impl is a no-op but good hygiene.
    try {
      await requestLogger.close();
    } catch {
      /* non-fatal */
    }
    // Phase 74 Plan 01 — drain the transient cache even on start failure so
    // no SDK subprocesses leak (they won't exist yet on a listen() failure
    // but belt-and-suspenders; closeAll() is idempotent + safe on empty).
    try {
      await transientCache.closeAll();
    } catch {
      /* non-fatal */
    }
    return NOOP_HANDLE;
  }

  log.info({ port: handle.address.port, host: handle.address.host }, "OpenAI endpoint started");

  return {
    enabled: true,
    port: handle.address.port,
    host: handle.address.host,
    apiKeysStore,
    transientCache,
    close: async () => {
      // Phase 74 Plan 02 shutdown order (extends Phase 69 Pitfall 10):
      //   1. Drain transient cache  — in-flight openclaw-template turns
      //                                finish cleanly OR abort with
      //                                AbortError; SDK subprocesses are
      //                                terminated before the server yanks
      //                                sockets out from under them. Matches
      //                                the quick task 260419-q2z graceful
      //                                shutdown contract for persistent
      //                                sessions (the daemon calls
      //                                SessionManager.drain before us).
      //   2. activeStreams + server  — Phase 69 Pitfall 10: all active SSE
      //                                handles close cleanly, then
      //                                server.close() completes.
      //   3. apiKeysStore           — SQLite handle released after clients
      //                                stop issuing requests.
      //   4. requestLogger          — JSONL file handle flushed last.
      try {
        const size = transientCache.size();
        if (size > 0) {
          log.info(
            { cacheSize: size },
            "draining OpenClaw transient session cache",
          );
        }
        await transientCache.closeAll();
      } catch (err) {
        log.warn(
          { err: (err as Error).message },
          "OpenAI endpoint transient-session-cache close failed (non-fatal)",
        );
      }
      try {
        await handle.close();
      } catch (err) {
        log.warn(
          { err: (err as Error).message },
          "OpenAI endpoint server close failed (non-fatal)",
        );
      }
      try {
        apiKeysStore.close();
      } catch (err) {
        log.warn(
          { err: (err as Error).message },
          "OpenAI endpoint api-keys-store close failed (non-fatal)",
        );
      }
      try {
        await requestLogger.close();
      } catch (err) {
        log.warn(
          { err: (err as Error).message },
          "OpenAI endpoint request-logger close failed (non-fatal)",
        );
      }
    },
  };
}
