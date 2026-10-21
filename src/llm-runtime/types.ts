/**
 * LlmRuntimeService types — provider-neutral interface for the primary
 * agent runtime (the LLM that drives every per-agent turn).
 *
 * Phase 136 introduces this seam at `src/llm-runtime/` mirroring the
 * Phase 117 `AdvisorService` pattern at `src/advisor/`. It exists for
 * one reason: Anthropic's 2026-05-14 announcement that programmatic
 * Agent SDK usage splits off from the interactive subscription pool
 * on 2026-06-15 at a flat $200/month cap. ClawCode runs 7 agents 24/7
 * — the cap will deplete in days, not weeks — so the runtime must be
 * pluggable BEFORE the cutover. Phase 136 ships the seam; Phase 137
 * adds the `anthropic-api-key` backend; Phase 138 adds credit
 * telemetry + automatic failover.
 *
 * **Design decision (locked in 136-01-SURVEY.md):** the seam exposes
 * an `SdkModule`-shaped surface, not a flattened service. The Claude
 * Agent SDK returns a `Query` object that carries per-conversation
 * state (`setModel`, `setMaxThinkingTokens`, `setPermissionMode`,
 * `interrupt`, `close`, `streamInput`, `mcpServerStatus`,
 * `setMcpServers`, `initializationResult`, `supportedCommands`) and
 * the existing call sites in `persistent-session-handle.ts` /
 * `session-adapter.ts` hold that Query reference for the entire
 * lifetime of a session. Flattening those mutators into a service
 * singleton would require rewriting both files (~4000 lines) and is
 * out of scope for the hard-deadline track. Phase 141 (Codex) and
 * Phase 142 (OpenRouter) implement the same surface; impedance
 * mismatch with non-Anthropic providers is solved at the adapter
 * layer inside each future backend, not at this seam.
 *
 * **Provider-neutral naming:** the canonical type for the runtime
 * "SDK shape" is `LlmRuntimeSdkModule` re-exported here as a thin
 * widening of `SdkModule` from `src/manager/sdk-types.ts`. The
 * widening adds `forkSession` (currently called on the imported SDK
 * at `src/manager/daemon.ts:3526` and `:10867` but never declared in
 * `SdkModule` — those sites cast through `unknown`). All other
 * runtime types (`SdkQuery`, `SdkQueryOptions`, `SdkStreamMessage`,
 * `SdkUserMessage`, `PermissionMode`, `SlashCommand`) are re-
 * exported from `src/manager/sdk-types.ts` via the barrel
 * (`./index.ts`) so consumers can migrate their imports to the seam
 * incrementally without per-call-site type refactors.
 *
 * See:
 *   - `.planning/phases/136-llm-runtime-multi-backend/136-CONTEXT.md`
 *     §`<decisions>` D-02 — interface shape locked
 *   - `.planning/phases/136-llm-runtime-multi-backend/136-01-PLAN.md`
 *     T-02 — package skeleton spec
 *   - `.planning/phases/136-llm-runtime-multi-backend/136-01-SURVEY.md`
 *     — every SDK call site enumerated; 4 runtime, 3 type-only
 *   - `src/advisor/types.ts` — the Phase 117 template
 *   - `src/manager/sdk-types.ts` — in-repo SDK type mirror (`SdkModule`,
 *     `SdkQuery`, etc.) that this seam widens; canonical for the
 *     existing fleet.
 */

import type {
  GetSessionMessagesOptions,
  SdkModule,
  SdkQuery,
  SdkQueryOptions,
  SessionMessage,
} from "../manager/sdk-types.js";

/**
 * Identifier for a registered LlmRuntime backend.
 *
 * Phase 136 shipped ONLY `"anthropic-agent-sdk"` — the current
 * production runtime extracted verbatim. **Phase 137 Plan 01 widens
 * this union to include `"codex-cli"`** (the Codex CLI binary
 * backend; CONTEXT.md D1). Plan 01 is a SHELL only — the dispatched
 * `CodexAgentCli` class throws a Plan-03 deferral error on
 * `loadSdkModule()`. Plans 02–05 ship the wire-shape implementation.
 *
 * Future phases add `"claude-code-interactive"` (probe-gated,
 * Phase 140), `"openrouter"` (Phase 142). The Zod schema
 * (`llmRuntimeBackendSchema` at `src/config/schema.ts`) is the source
 * of truth for what operators can actually select; this type union
 * is widened in lockstep when each phase lands.
 *
 * See:
 *   - `.planning/phases/137-.../137-CONTEXT.md` §D1
 *   - `src/llm-runtime/llm-runtime-service.ts` factory switch case
 *   - `src/llm-runtime/backends/codex-agent-cli.ts` SHELL backend
 */
export type LlmRuntimeBackend =
  | "anthropic-agent-sdk"
  | "codex-cli"
  | "claude-code-interactive";

/**
 * Fork-session options forwarded to the underlying runtime.
 *
 * Mirrors the shape callers pass at `src/manager/daemon.ts:3526`
 * + `:10867` today — a minimal, additive surface. Phase 117 +
 * Phase 124 both use this for advisor-fork / compaction-fork
 * primitives; the field set widens conservatively.
 *
 * Typed loosely (`unknown`) for runtime-specific fields so the
 * seam stays provider-neutral while preserving the call sites
 * verbatim. Each backend's `forkSession` implementation owns the
 * cast to its provider-native shape.
 */
export type LlmRuntimeForkOptions = Readonly<Record<string, unknown>>;

/**
 * Result of a successful `forkSession` call.
 *
 * The bundled Claude Agent SDK returns `{ sessionId: string }`;
 * future backends (`openai-codex`, `openrouter`) translate from
 * their provider-native shape into this normalised form.
 */
export type LlmRuntimeForkResult = Readonly<{
  sessionId: string;
}>;

/**
 * Provider-neutral SDK-module surface returned by the seam.
 *
 * Widens `SdkModule` (`src/manager/sdk-types.ts:308`) with the
 * `forkSession` method that the daemon already calls. The widening
 * is back-compat: every consumer that holds an `SdkModule` reference
 * continues to compile; the daemon sites that cast through `unknown`
 * for `forkSession` can drop the cast once they import from this
 * seam.
 *
 * Phase 137+ backends (`AnthropicApiKeyBackend`,
 * `ClaudeCodeInteractiveBackend`, `OpenAiCodexBackend`,
 * `OpenRouterBackend`) implement this interface — `query()` returns
 * an `SdkQuery`-shaped async generator with the same mutator
 * methods the Claude Agent SDK exposes today. Non-Anthropic
 * providers stub no-op the mutators that don't translate (e.g.,
 * `setPermissionMode` on Codex) — pre-optimising the cross-provider
 * adaptation is out of scope for Phase 136.
 */
export interface LlmRuntimeSdkModule extends SdkModule {
  /**
   * Fork an existing session into a new session id, optionally with
   * options that the underlying provider supports (system prompt
   * override, model override, etc.). The daemon today calls this for
   * advisor-fork (Phase 117) and compaction-fork (Phase 124 /
   * Phase 125). Phase 141+ backends translate to/from this shape.
   *
   * Mirrors `@anthropic-ai/claude-agent-sdk` `forkSession(id, opts)`
   * — callers in `daemon.ts:3526` + `:10867` invoke this signature
   * today; the SDK exports it on the imported module but `SdkModule`
   * didn't declare it. Phase 136 corrects that.
   */
  forkSession(
    sessionId: string,
    options?: LlmRuntimeForkOptions,
  ): Promise<LlmRuntimeForkResult>;

  /**
   * Phase 999.75 Part A (A1) — read a historical session's JSONL transcript
   * (the real SDK on-disk record, tool blocks verbatim).
   *
   * Mirrors `@anthropic-ai/claude-agent-sdk` `getSessionMessages(id, opts)`
   * (sdk.d.ts:681). The raw SDK module already exports this method — the
   * `anthropic-agent-sdk.ts` backend casts the whole module to
   * `LlmRuntimeSdkModule`, so this is a type-declaration-only widening
   * (same pattern as `forkSession` in Phase 136). The Codex backend stubs
   * it (`[]`), which trips the fail-open path in the compaction reader.
   *
   * Returns user/assistant messages in chronological order, or an empty
   * array when the session file is not found. The `message` field of each
   * `SessionMessage` is typed `unknown` and MUST be narrowed at runtime —
   * see `src/memory/sdk-transcript-reader.ts`.
   */
  getSessionMessages(
    sessionId: string,
    options?: GetSessionMessagesOptions,
  ): Promise<readonly SessionMessage[]>;
}

/**
 * Provider-neutral entry point for the primary agent runtime.
 *
 * The service exposes a single method — `loadSdkModule()` — that
 * returns the runtime's `SdkModule`-compatible shape. Every current
 * consumer (`session-adapter.ts:loadSdk`, `daemon.ts` compaction
 * triggers, `openai/endpoint-bootstrap.ts` template driver) goes
 * through this entry point after Phase 136. Direct
 * `await import("@anthropic-ai/claude-agent-sdk")` calls are
 * forbidden outside `src/llm-runtime/backends/anthropic-agent-sdk.ts`
 * — enforced by the static-grep CI test added in T-06.
 *
 * Single-method surface (rather than `query` / `forkSession` / etc.
 * directly on the service) preserves the existing call-site shape:
 * consumers receive an `SdkModule` reference and continue calling
 * `sdk.query(...)` / `sdk.forkSession(...)` exactly as they do today.
 * Zero refactor on the consuming side. Phase 137 adds a second
 * backend behind the same `loadSdkModule()`; Phase 141+ implement
 * provider-native adaptation inside their own backends.
 */
export interface LlmRuntimeService {
  /**
   * Backend discriminator (e.g. "anthropic-agent-sdk", "claude-code-interactive").
   * All backends already expose this; callers use it to branch v3-specific
   * behavior (e.g. the session adapter skips the initial drain query for the
   * inert v3 module — the daemon doesn't drive v3 turns). Optional so minimal
   * test stubs / wrappers may omit it (→ treated as non-v3, the safe default).
   */
  readonly backendId?: string;
  /**
   * Return the provider-neutral SDK-module shape for the current
   * backend. Cached at the backend level — calling this repeatedly
   * across an agent's lifetime returns the same module reference,
   * matching the `cachedSdk` behaviour at
   * `src/manager/session-adapter.ts:1407` today.
   *
   * Errors surface via the rejected promise; callers handle the
   * same error paths they handle today (e.g.,
   * `"Claude Agent SDK is not installed"` for the
   * `anthropic-agent-sdk` backend when the optional dependency is
   * missing).
   */
  loadSdkModule(): Promise<LlmRuntimeSdkModule>;
  /**
   * Phase 999.84 Plan 01 — optional debug-only PTY write for the
   * discriminating experiment that decides parent-channel turn-trigger fix
   * path (A vs B vs defer-to-C). Implemented only by the v3
   * `claude-code-interactive` backend; other backends omit it.
   *
   * Returns `{ ok: true }` if the write was dispatched, or
   * `{ ok: false, reason }` with `no-supervisor` / `no-write-seam` /
   * backend-specific reasons. Production code paths NEVER call this — it is
   * reachable ONLY through the `CLAWCODE_DEBUG_PTY_WRITE=1` gated daemon IPC
   * handler. See `.planning/phases/999.84-.../999.84-RESEARCH.md`.
   */
  debugWriteToPty?(text: string): { ok: true } | { ok: false; reason: string };
}

/**
 * Constructor-injected dependencies for backend implementations.
 *
 * Backends receive these at construction (factory call in
 * `daemon.ts`) so they're fully testable with mocks. Phase 136
 * ships an empty `deps` for `AnthropicAgentSdkBackend` — the
 * backend's behaviour is identical to the current `loadSdk()` and
 * needs no injected deps. Phase 137 (`AnthropicApiKeyBackend`)
 * extends this shape to inject the API-key resolver.
 *
 * The `logger` field is reserved for Phase 138 credit-telemetry
 * structured-log emission; included in the deps shape now so
 * Phase 137 doesn't need to refactor backend constructors.
 */
export interface LlmRuntimeDeps {
  /**
   * Optional structured logger. When supplied, backends emit
   * boot-time telemetry through it (Phase 136 ships the
   * `phase136-llm-runtime` log key at the factory level). Pino-
   * compatible shape; the daemon's `log` field is the typical
   * production injection.
   */
  readonly logger?: {
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
  };
  /**
   * Phase 137 Plan 04 — per-agent OpenAI credentials resolver.
   *
   * Constructed once per agent in `daemon.ts`'s per-agent factory loop
   * (after the shared `SecretsResolver` boot). Threaded into
   * `CodexAgentCli` so each `CodexQuery` spawn injects the resolved
   * `OPENAI_API_KEY` into the child env.
   *
   * Optional at the type level for back-compat — the Anthropic-Agent-
   * SDK backend (Phase 136) IGNORES this field entirely; only the
   * Codex backend consumes it. When `config.llmRuntime.backend ===
   * "codex-cli"` AND this field is undefined, `CodexAgentCli.loadSdkModule()`
   * throws an operator-actionable error directing the operator to
   * wire `providers.openai.apiKeyPath` in clawcode.yaml.
   *
   * Typed via `unknown`-style indirection (the import is `type`-only
   * + behind an interface) to keep the seam zero-imports for callers
   * that don't construct a Codex backend. The actual class lives at
   * `src/llm-runtime/credentials/openai-credentials.ts`.
   */
  readonly openaiCredentials?: import("./credentials/openai-credentials.js").OpenAiCredentialsResolver;
  /**
   * Phase 138 Plan 05 T-03/T-04 — runtime-state failover override.
   *
   * `createLlmRuntimeService` reads
   * `deps.failoverStateReader?.getActiveBackend(config.name, Date.now())`
   * BEFORE the config-backend `switch` (CONTEXT D3 — override > config).
   * When an unexpired `failover_state` row exists for the agent, the
   * factory dispatches to the override backend on the NEXT turn — no
   * daemon restart, clawcode.yaml untouched.
   *
   * Optional for back-compat: absent → the factory behaves exactly as
   * before (dispatches on `config.llmRuntime.backend`). Production wires
   * the live `FailoverStateStore` (which implements `FailoverStateReader`)
   * via the daemon's per-agent resolver construction loop; unit tests
   * stub a plain object `{ getActiveBackend: vi.fn() }`.
   *
   * Typed via a `type`-only import so the seam stays zero-runtime-import
   * for callers that never construct a failover-aware factory.
   */
  readonly failoverStateReader?: import("../usage/failover-state.js").FailoverStateReader;
  /**
   * Phase 140 Plan 06 Task 10 — the daemon's live `McpProcessTracker`
   * singleton (the `register` + `killAgentGroup` subset).
   *
   * Consumed ONLY by `ClaudeCodeInteractiveBackend` (the v3 native-channels
   * backend): its default `supervisorFactory` registers the spawned
   * `claude --channels` PTY pid via `tracker.register(agent, pid, [])` so the
   * daemon's negative-pid `killAgentGroup` AND the `orphan-claude-reaper`
   * cover the child. Without this, 140-04's default factory falls back to a
   * NO-OP tracker — the spawned child would be unreapable (140-04 Deferred
   * Issue #1, a real safety hole). The Anthropic-Agent-SDK + Codex backends
   * IGNORE this field entirely (their lifecycle is owned elsewhere) — so the
   * wiring is naturally backend-gated to v3.
   *
   * Optional + nullable for back-compat: the daemon's tracker is itself
   * `McpProcessTracker | null` (boot-scan failure / non-Linux / no `/proc`),
   * so absent/null → the backend keeps its no-op fallback and still spawns.
   *
   * Typed via a `type`-only import of the narrow `PtySupervisorTracker`
   * (`Pick<McpProcessTracker, "register" | "killAgentGroup">`) so the seam
   * stays zero-runtime-import for callers that never construct the v3 backend.
   */
  readonly mcpTracker?:
    | import("./supervisors/pty-supervisor.js").PtySupervisorTracker
    | null;
  /**
   * Phase 999.83-02 (Fix A) — per-subagent FIRST-TURN INPUT (the task text).
   *
   * Consumed ONLY by `ClaudeCodeInteractiveBackend` (the v3 native-channels
   * backend): `createLlmRuntimeService` forwards it into the backend's
   * `InteractiveBackendSeams.firstTurnInput`, where the warm-nudge fire loop
   * delivers it as the agent's first real PTY turn-trigger — `\r` (menu
   * dismiss) FIRST, then the task as a separate write, ONCE (Fix B fire-once).
   *
   * The daemon's `registerLlmRuntime` callback sets this from the spawning
   * subagent's `config.task` (only when non-empty). Absent / `null` / `""` →
   * the backend keeps its default warm-nudge (`\r` at all three delays). The
   * Anthropic-Agent-SDK + Codex backends IGNORE this field entirely.
   */
  readonly firstTurnInput?: string | null;
  /**
   * v3-optin — per-agent op:// MCP-env-override resolver (mcpEnvOverrides parity
   * with the v2 SDK path).
   *
   * Consumed ONLY by `ClaudeCodeInteractiveBackend`: in `loadSdkModule` it
   * resolves `config.mcpEnvOverrides` (the vault-scoped op:// tokens the
   * acme agents declare) and merges the resolved values last-wins into the
   * per-server env written to the v3 `.mcp.json`. Mirrors the v2 path in
   * `session-config.ts` (`deps.opEnvResolver`) so a acme agent on v3 gets
   * its Acme-vault-scoped 1Password token instead of the daemon's
   * clawdbot-scoped fleet token.
   *
   * Optional for back-compat: absent (or no `mcpEnvOverrides` / no servers) →
   * the v3 backend writes `config.mcpServers[].env` unchanged (the existing
   * non-acme fleet). The Anthropic-Agent-SDK + Codex backends IGNORE this
   * field entirely. Production wires the daemon's shared resolver (same one
   * `SessionManager` uses); throws propagate (a bad op:// fails the agent start,
   * a loud signal — never silently inherit the wrong-scoped token).
   */
  readonly opEnvResolver?: (
    overrides: Record<string, Record<string, string>>,
    agentName: string,
  ) => Promise<Record<string, Record<string, string>>>;
  /**
   * Phase 999.86 — pre-warmed worker pool. When `true`, the v3 backend skips
   * BOTH the warm-nudge schedule AND the `firstTurnInput` schedule on this
   * resolver invocation, leaving the spawned agent parked on the
   * `--dangerously-load-development-channels` confirmation menu. The pool
   * delivers `\r<message>\n` later via the live supervisor handle when a
   * Discord chat message dispatches. Consumed ONLY by
   * `ClaudeCodeInteractiveBackend`; other backends ignore it.
   */
  readonly deferFirstTurn?: boolean;
  /**
   * Phase 999.98-03 (gap closure) — the daemon-owned LIVE catalog snapshot
   * accessor, the SAME ref the v2/SDK adapter receives (`getCatalogSnapshot`
   * at daemon.ts ~2962, refreshed by the model-monitor cron after each upsert).
   *
   * Consumed ONLY by `ClaudeCodeInteractiveBackend`: in `loadSdkModule` it
   * pre-resolves a `<family>@latest` `config.model` to the newest entitled
   * concrete id (via the pure `resolveLatestModel(model, snapshot)`) BEFORE the
   * pure `resolveModelId` call, so the v3 `claude --model` flag emits a full
   * `claude-*` id — exactly the v2 adapter's pre-resolve composition
   * (`resolveModelId(preResolveModel(config.model))`). Without it the v3 spawn
   * passed the RAW `config.model` to `--model`, so a `model: opus@latest` agent
   * sent the ClawCode-only `@latest` sugar (unresolvable by the CLI) and a
   * `model: fable` agent sent the bare alias `fable` instead of `claude-fable-5`
   * (999.98-VERIFICATION.md SC-5 blocker + SC-1 v3 caveat).
   *
   * Optional for back-compat: absent → the backend reads an empty snapshot
   * (`() => []`), so `<family>@latest` falls back to the pinned alias
   * (`MODEL_ALIAS_MAP[family]`) — the same cold-catalog floor the pure resolver
   * guarantees. The Anthropic-Agent-SDK + Codex backends IGNORE this field.
   *
   * Typed via a `type`-only import so the seam stays zero-runtime-import for
   * callers that never construct the v3 backend.
   */
  readonly getCatalogSnapshot?: () => import("../manager/model-resolver.js").CatalogSnapshot;
}

/**
 * Re-export the in-repo SDK types so consumers can migrate their
 * imports from `../manager/sdk-types.js` to `../llm-runtime/index.js`
 * incrementally. Phase 136 keeps the originals in place — the
 * re-export is the chokepoint for Phase 137+ to swap the underlying
 * type definitions if a future backend diverges from the SDK's
 * shape.
 */
export type {
  GetSessionMessagesOptions,
  SdkModule,
  SdkQuery,
  SdkQueryOptions,
  SessionMessage,
};
