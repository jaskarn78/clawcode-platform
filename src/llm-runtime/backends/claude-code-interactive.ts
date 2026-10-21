/**
 * Phase 140 — `ClaudeCodeInteractiveBackend` (v3) native-channels backend.
 *
 * Implements `LlmRuntimeService` so the Phase 136 factory can dispatch
 * `config.llmRuntime.backend === "claude-code-interactive"` to a real
 * constructor. This is the v3 "native channels" runtime: each interactive
 * chat agent becomes a real `claude --channels` session that owns Discord I/O
 * through the official Channels plugin, and the daemon supervises lifecycle +
 * pushes daemon-originated events through the ClawCode MCP channel.
 *
 * **What Plan 01 (Stage 1) shipped:**
 *   1. `claude` binary discovery at construction (fire-and-forget; first
 *      `loadSdkModule()` awaits it). Mirrors `CodexAgentCli` exactly.
 *   2. One `phase140-claude-channels` structured log line per construction.
 *   3. An inert `FakeChannelsSdkModule` whose `query()` never drives a turn
 *      (the agent's own `claude --channels` session does) and whose
 *      control-plane mutators throw `V3UnsupportedMutatorError`.
 *
 * **What Plan 04 (Stage 2, THIS change) adds — "selectable+inert" →
 * "spawns a real (supervised) PTY + reads its transcript":**
 *   1. `loadSdkModule()` (first call) awaits binary discovery, writes the
 *      per-agent `.mcp.json` wiring the clawcode-channel MCP server, then
 *      constructs + `spawn()`s a `PtySupervisor` (Plan 02) with the channels
 *      argv `claude --dangerously-load-development-channels
 *      server:clawcode-channel plugin:discord@claude-plugins-official
 *      --mcp-config <path>`, and caches the module. The inert `Query` is
 *      unchanged (the daemon never drives turns under v3).
 *   2. `getSessionMessages` reads the on-disk `claude --channels` JSONL
 *      transcript via the real Agent SDK's `getSessionMessages` (routed
 *      through the `loadAnthropicAgentSdkModule()` seam — 140-01-SUMMARY:
 *      `transcript_adapter_required: false`, it is the standard Claude Code
 *      JSONL `src/memory/sdk-transcript-reader.ts` already parses). Fail-open
 *      (`[]`) on any error, preserving the compaction reader's documented
 *      fallback.
 *   3. The two Plan-03-deferred nits: the dead unused mutator-thrower closure
 *      in `makeInertQuery` is removed; `forkSession` REJECTS (`Promise.reject`)
 *      instead of a synchronous `throw`, matching the query mutators' catch
 *      semantics.
 *
 * **What this does NOT do (CONTEXT scope fence — masking stays):**
 *   - Touch `src/bridge/`, the SDK backend, or `persistent-session-handle.ts`.
 *   - Cut any production agent over (operator-gated, Stage 3+).
 *   - Wire the supervisor factory's `McpProcessTracker` into the daemon's
 *     per-agent loop (production wire-up + tracker resolution is a follow-up;
 *     see the `supervisorFactory` seam note + SUMMARY Deferred Issues).
 *
 * See:
 *   - `../llm-runtime-service.ts` — factory switch case.
 *   - `./codex-agent-cli.ts` — the reference SHELL/spawn pattern this mirrors.
 *   - `../supervisors/pty-supervisor.ts` — the Plan 02 PtySupervisor.
 *   - `../../channels/clawcode-channel-mcp-server.ts` — the MCP server `.mcp.json`
 *     points at (Plan 03), + its `CLAWCODE_*` env contract.
 *   - `./anthropic-agent-sdk.ts` — `loadAnthropicAgentSdkModule()` (the ONLY
 *     direct SDK import chokepoint; this file routes through it).
 *   - `.planning/phases/140-claudecode-interactive-channels-backend/` — phase.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { EffortLevel } from "../../config/schema.js";
import type {
  LlmRuntimeDeps,
  LlmRuntimeForkOptions,
  LlmRuntimeForkResult,
  LlmRuntimeSdkModule,
  LlmRuntimeService,
} from "../types.js";
import type {
  GetSessionMessagesOptions,
  PermissionMode,
  SdkContextUsage,
  ModelInfo,
  SdkQuery,
  SdkStreamMessage,
  SessionMessage,
  SlashCommand,
} from "../../manager/sdk-types.js";
import {
  discoverCliBinary,
  type DiscoverCliBinaryDeps,
} from "../discovery.js";
import { V3UnsupportedMutatorError } from "../errors/v3-unsupported-mutator.js";
import {
  PtySupervisor,
  defaultPtySpawn,
  type PtySpawnFn,
  type PtySupervisorLogger,
  type PtySupervisorTracker,
} from "../supervisors/pty-supervisor.js";
import {
  SessionIdTracker,
  type ListSessionsFn,
} from "../supervisors/session-id-tracker.js";
import { MANAGER_SOCKET_PATH } from "../../config/loader.js";
import { mintAgentTokenIfAvailable } from "../../manager/agent-identity-token.js";
// Single-source-of-truth child-spawn env credential helper (strips
// ANTHROPIC_API_KEY). `buildV3SpawnEnv` composes over it so v3 agents get the
// same credential policy as the SDK path's `buildCleanEnv`.
import { buildAnthropicSafeEnv } from "../../manager/spawn-env.js";
import { loadAnthropicAgentSdkModule } from "./anthropic-agent-sdk.js";
// Phase 999.98-03 (gap closure) — the SAME pure model resolvers the v2/SDK
// adapter uses (session-adapter.ts preResolveModel + resolveModelId). Reused,
// NOT re-implemented: `resolveLatestModel` collapses `<family>@latest` over the
// injected catalog snapshot (pinned-alias floor on a cold/empty snapshot);
// `resolveModelId` then maps aliases (incl. `fable`→`claude-fable-5`) to full
// `claude-*` ids. Both bodies stay pure (no IO/async) — the snapshot is passed in.
import {
  resolveModelId,
  resolveLatestModel,
} from "../../manager/model-resolver.js";
import { claudeBinaryPath } from "../../shared/claude-binary.js";

/** The fleet binary if it resolves; undefined lets discovery fall back. */
function fleetClaudeBinaryOrUndefined(): string | undefined {
  try {
    return claudeBinaryPath();
  } catch {
    return undefined;
  }
}

/**
 * Tier-3 fallback paths probed when neither an explicit config path nor
 * `which claude` resolves. Order matters — the npm-global / installer default
 * first, then the user-local install location. Frozen so callers can pass the
 * constant directly.
 */
export const CLAUDE_DEFAULT_COMMON_PATHS: readonly string[] = Object.freeze([
  "/usr/local/bin/claude",
  path.join(homedir(), ".local", "bin", "claude"),
  path.join(homedir(), ".claude", "local", "claude"),
]);

/**
 * The transcript-read seam. Production resolves the real Agent SDK module's
 * `getSessionMessages` (via the `loadAnthropicAgentSdkModule()` chokepoint —
 * NOT a direct `@anthropic-ai/claude-agent-sdk` import, which the Phase-136
 * static-grep CI forbids outside `anthropic-agent-sdk.ts`). Tests inject a
 * fake reading a fixture JSONL. Mirrors the SDK signature
 * (`getSessionMessages(id, opts)` — sdk.d.ts:681).
 */
export type ReadSessionMessagesFn = (
  sessionId: string,
  options?: GetSessionMessagesOptions,
) => Promise<readonly SessionMessage[]>;

/** Optional construction seams for `FakeChannelsSdkModule` (test injection). */
export interface FakeChannelsSdkModuleSeams {
  /**
   * Reads a historical session's JSONL transcript. Defaults to the real Agent
   * SDK's `getSessionMessages` resolved lazily via the seam chokepoint.
   */
  readonly readSessionMessages?: ReadSessionMessagesFn;
}

/**
 * Default transcript reader — lazily loads the real Agent SDK module through
 * the `loadAnthropicAgentSdkModule()` chokepoint and delegates to its
 * `getSessionMessages`. Lazy so a session that merely constructs the inert
 * module never forces the SDK import.
 */
function defaultReadSessionMessages(): ReadSessionMessagesFn {
  return async (sessionId, options) => {
    const sdk = await loadAnthropicAgentSdkModule();
    return sdk.getSessionMessages(sessionId, options);
  };
}

/**
 * An inert `LlmRuntimeSdkModule` for the v3 backend.
 *
 * The daemon does NOT drive Discord turns under v3 — the agent's own
 * `claude --channels` session does — so the `Query` returned by `query()`
 * yields nothing and completes only when `close()` is called. Control-plane
 * mutators reject with `V3UnsupportedMutatorError`; read-only introspection
 * returns benign empty values so a session that merely *constructs* this
 * module doesn't fault. `getSessionMessages` reads the real on-disk transcript
 * (fail-open to `[]`).
 */
export class FakeChannelsSdkModule implements LlmRuntimeSdkModule {
  private readonly readSessionMessages: ReadSessionMessagesFn;

  constructor(
    private readonly agent: string,
    seams?: FakeChannelsSdkModuleSeams,
  ) {
    this.readSessionMessages =
      seams?.readSessionMessages ?? defaultReadSessionMessages();
  }

  query(_params: {
    prompt: string | AsyncIterable<unknown>;
    options?: unknown;
  }): SdkQuery {
    void _params;
    return makeInertQuery(this.agent);
  }

  forkSession(
    _sessionId: string,
    _options?: LlmRuntimeForkOptions,
  ): Promise<LlmRuntimeForkResult> {
    void _sessionId;
    void _options;
    // Compaction-fork (Phase 124) / advisor-fork (Phase 117) have no live
    // in-process Query to fork under v3. Stage 2+ replaces these with
    // transcript replay (`getSessionMessages`, below) + a programmatic
    // one-shot; until then, fail loud. REJECT (not a sync `throw`) so callers
    // catch it the same way they catch the query mutators' rejections.
    return Promise.reject(new V3UnsupportedMutatorError("forkSession", this.agent));
  }

  /**
   * Read the on-disk `claude --channels` JSONL transcript for `sessionId`.
   *
   * 140-01-SUMMARY (`transcript_adapter_required: false`) verified that
   * `claude --channels` writes the standard Claude Code JSONL — the exact
   * shape `src/memory/sdk-transcript-reader.ts:extractContentBlocks` consumes
   * — so no adapter is needed; the real Agent SDK's `getSessionMessages`
   * (routed through the seam) reads it directly. This unblocks compaction-fork
   * transcript replay + advisor transcript replay.
   *
   * Fail-open: any error (SDK not installed, session-store unavailable, read
   * throws) returns `[]`, preserving the compaction reader's documented
   * fallback path (an empty transcript trips `readToolAwareTurns`'s fail-open
   * to the ConversationStore extractor input — safe, just degraded).
   */
  async getSessionMessages(
    sessionId: string,
    options?: GetSessionMessagesOptions,
  ): Promise<readonly SessionMessage[]> {
    try {
      return await this.readSessionMessages(sessionId, options);
    } catch {
      // Fail-open — an absent/unreadable transcript must not fault the
      // compaction reader; it falls back to the ConversationStore input.
      return [];
    }
  }
}

/**
 * Build an inert `SdkQuery`: an async generator that yields no stream
 * messages and resolves when `close()` is called, with the SDK's control-
 * plane surface attached. Mutators reject; read-only methods return benign
 * empties so construction-time introspection (MCP warm-path, command
 * enumeration) doesn't fault.
 */
function makeInertQuery(agent: string): SdkQuery {
  let resolveClose: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });

  async function* gen(): AsyncGenerator<SdkStreamMessage, void> {
    // The daemon never drives Discord turns under v3 — wait for close().
    await closed;
  }

  const q = gen() as SdkQuery;

  // Control-plane mutators — no live target under v3. Fail loud.
  // EXCEPT q.interrupt — the daemon's own phase127 stream-stall recovery
  // calls interrupt() on any session whose stream goes idle for 180s,
  // including v3 sessions whose inert SDK module never produces tokens by
  // design. Rejecting from q.interrupt under v3 surfaced as an unhandled
  // rejection at fireInterruptOnce (observed live 2026-05-27 dev-daemon
  // crash) — the documented `.catch` chain at
  // persistent-session-handle.ts:792 didn't catch the rejection (suspected
  // microtask race when the rejection arrives before the catch attaches
  // OR a divergent execution path under tsx). Returning a resolved promise
  // is semantically correct: there is no in-process Query to interrupt
  // under v3; real session abort is handled by the PTY supervisor's own
  // crash/restart loop. Other mutators stay loud because they signal
  // genuine misuse (someone trying to mutate state that doesn't exist).
  q.interrupt = (): Promise<void> => Promise.resolve();
  q.streamInput = (): Promise<void> => Promise.reject(new V3UnsupportedMutatorError("streamInput", agent));
  q.setMcpServers = (): Promise<unknown> => Promise.reject(new V3UnsupportedMutatorError("setMcpServers", agent));
  q.setMaxThinkingTokens = (): Promise<void> => Promise.reject(new V3UnsupportedMutatorError("setMaxThinkingTokens", agent));
  q.setModel = (): Promise<void> => Promise.reject(new V3UnsupportedMutatorError("setModel", agent));
  // 999.105 WS-0.1 — applyFlagSettings was ABSENT from this stub list, and
  // `gen() as SdkQuery` is a type assertion (no tsc conformance gate), so a
  // caller on a v3 agent got a raw TypeError that fire-and-forget `.catch()`
  // does not contain. Reject typed like the other unsupported mutators.
  // (Also: the SDK's applyFlagSettings({outputStyle}) is a proven silent
  // no-op even on v2 — 999.105 spike F1 — so nothing should call it anyway.)
  q.applyFlagSettings = (): Promise<void> => Promise.reject(new V3UnsupportedMutatorError("applyFlagSettings", agent));
  q.setPermissionMode = (_mode: PermissionMode): Promise<void> => {
    void _mode;
    return Promise.reject(new V3UnsupportedMutatorError("setPermissionMode", agent));
  };
  q.backgroundTasks = (): Promise<boolean> => Promise.reject(new V3UnsupportedMutatorError("backgroundTasks", agent));
  q.stopTask = (): Promise<void> => Promise.reject(new V3UnsupportedMutatorError("stopTask", agent));

  // Read-only introspection — benign empties (no fault on construction).
  q.mcpServerStatus = (): Promise<unknown[]> => Promise.resolve([]);
  q.initializationResult = (): Promise<{
    readonly commands: readonly SlashCommand[];
    readonly agents?: readonly unknown[];
    readonly models?: readonly ModelInfo[];
  }> => Promise.resolve({ commands: [] });
  q.supportedCommands = (): Promise<readonly SlashCommand[]> => Promise.resolve([]);
  q.getContextUsage = (): Promise<SdkContextUsage> => Promise.resolve({ totalTokens: 0 });

  // close() completes the inert generator. The cast-through is the SDK's own
  // contract (close is synchronous void).
  q.close = (): void => {
    resolveClose();
  };

  return q;
}

/**
 * The narrow supervisor surface `loadSdkModule` drives: launch the PTY child
 * once. Production wraps `PtySupervisor` (`spawn()`); tests inject a fake that
 * records construction args + counts spawns. Kept minimal so the unit test
 * runs without node-pty / a real binary / a real TTY.
 */
export interface ChannelSpawnSeam {
  /** Launch the supervised `claude --channels` child (fresh session). */
  spawn(): Promise<void>;
  /**
   * Phase 140 parity — write to the child's stdin (the PTY). Used for the
   * post-spawn warm-nudge that triggers the agent's first turn so its
   * `clawcode-channel` MCP client connects (claude connects channel MCP servers
   * lazily on first turn — Plan-07 caveat #2). Optional: a fake seam may omit it.
   */
  write?(data: string): void;
  /**
   * Phase 141 (C) — terminal stop. Transitions the supervisor to `"stopped"`,
   * detaches its exit listener (so the kill does NOT trigger a respawn), and
   * group-kills the PTY child. `stopAgent` calls this BEFORE its own
   * killAgentGroup so v3 subagents die cleanly instead of resurrecting. The real
   * `PtySupervisor` implements it; fake test seams may omit it (optional).
   */
  stop?(): Promise<void>;
}

/** Options handed to the supervisor factory (the channels argv + spawn env). */
export interface ChannelSupervisorFactoryOptions {
  readonly agent: string;
  /** Channels argv — `argv[0]` ends in `claude` (orphan-reaper coverage). */
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Optional structured logger (boot telemetry / supervision logs). */
  readonly logger?: PtySupervisorLogger;
  /**
   * Phase 140 Plan 07 — synchronous resume-id getter passed straight through to
   * `PtySupervisor.getResumeSessionId` so a restart appends `--resume <id>`.
   * Backed by the `SessionIdTracker` cache (140-04 Deferred #2). `undefined`
   * keeps the pre-seam behavior (every spawn fresh).
   */
  readonly getResumeSessionId?: () => string | null;
}

/**
 * Construction seams for `ClaudeCodeInteractiveBackend`.
 *
 * Production leaves these undefined and picks up the real PtySupervisor +
 * `~/.clawcode/channels-state/<agent>` + the dist-sibling MCP server path.
 * The unit test injects a fake supervisor (no PTY), a tmp channels-state dir,
 * and a deterministic MCP server path so it asserts wiring without a real
 * binary/TTY/socket.
 */
export interface InteractiveBackendSeams {
  /**
   * Build the channel-spawn supervisor. Defaults to a `PtySupervisor`.
   *
   * Phase 140 Plan 06 Task 10 resolved the prior production wire-up gap: the
   * default factory now prefers the daemon's live `McpProcessTracker`
   * (injected via `LlmRuntimeDeps.mcpTracker`) so the spawned PTY pid is
   * registered for `killAgentGroup` + `orphan-claude-reaper` coverage. When
   * neither `deps.mcpTracker` nor `seams.tracker` is supplied (e.g. non-Linux
   * / no `/proc`), it falls back to a no-op tracker so the backend still
   * spawns (degraded reap coverage, never a crash).
   */
  readonly supervisorFactory?: (
    options: ChannelSupervisorFactoryOptions,
  ) => ChannelSpawnSeam;
  /** Per-agent channels-state dir. Defaults to `~/.clawcode/channels-state/<agent>`. */
  readonly channelsStateDir?: (agent: string) => string;
  /** Absolute path to the built channel MCP server. Defaults to the dist sibling. */
  readonly channelMcpServerPath?: () => string;
  /**
   * Optional process-tracker for the default supervisor factory (test-only
   * seam). Production injects the live tracker via `LlmRuntimeDeps.mcpTracker`
   * instead; when both are present `deps.mcpTracker` WINS (the daemon path is
   * authoritative). Kept for the Plan-04 unit tests that predate the deps
   * wiring.
   */
  readonly tracker?: PtySupervisorTracker;
  /**
   * Optional pty spawn seam for the default supervisor factory (test-only).
   * Production leaves this undefined → `defaultPtySpawn()` (node-pty). The
   * unit suite injects a fake so it can exercise the REAL
   * `defaultSupervisorFactory` (including its tracker selection) without the
   * native addon / a real TTY.
   */
  readonly spawnPty?: PtySpawnFn;
  /**
   * Phase 140 Plan 07 — session-listing function for the resume-id tracker
   * (140-04 Deferred #2). Production lazy-imports the SDK's `listSessions`; the
   * unit suite injects a fake so the resume seam is exercised without the SDK
   * or a real transcript store.
   */
  readonly listSessions?: ListSessionsFn;
  /**
   * Phase 140 Plan 07 — schedules a post-spawn resume-id refresh. Production
   * uses an unref'd `setTimeout`; tests inject a synchronous runner so the
   * refresh fires deterministically. Called once per delay in
   * `RESUME_REFRESH_DELAYS_MS`.
   */
  readonly scheduleResumeRefresh?: (fn: () => void, ms: number) => void;
  /**
   * Phase 140 parity — command for the v3 `clawcode` TOOL server (`clawcode mcp`).
   * `undefined` → default (`node <daemon-cli-entry> mcp`). `null` → omit the
   * clawcode server entirely (unit tests that don't want it). An object →
   * exact command/args (tests / non-standard installs).
   */
  readonly clawcodeMcpCommand?:
    | { readonly command: string; readonly args: readonly string[] }
    | null;
  /**
   * Phase 140 parity (caveat #2) — post-spawn warm-nudge prompt written to the
   * agent's PTY to trigger its first turn (connecting the channel). `undefined`
   * → `DEFAULT_WARM_NUDGE`. `null` → disable (no warm turn; channel connects on
   * the agent's first real Discord turn instead — saves one turn per spawn).
   * A string → custom nudge. Each nudge costs one cheap LLM turn per spawn.
   */
  readonly warmNudge?: string | null;
  /**
   * Phase 999.83-02 (Fix A + Fix B) — per-subagent FIRST-TURN INPUT: the task
   * text delivered as the agent's first real PTY turn-trigger.
   *
   * When this is a NON-EMPTY string, the warm-nudge fire loop schedules TWO PTY
   * writes at the FIRST warm-nudge delay only: the menu-dismiss `\r` FIRST (its
   * job is unchanged — approve the `--dangerously-load-development-channels`
   * confirmation menu), then the task as a SEPARATE second write. The task is
   * NEVER the first PTY keystroke, so it can't be mis-keyed into the menu
   * (threat T-999.83-02-TTY / A1). It also does NOT re-fire at 20s/45s
   * (fire-once, Fix B — a side-effecting delegated task must not run 3×,
   * T-999.83-02-DUP).
   *
   * PRECEDENCE: a non-empty `firstTurnInput` TAKES PRECEDENCE over `warmNudge`
   * for the fire schedule (the `\r`-then-task single-fire path); `warmNudge` is
   * ignored in that case. `undefined` / `null` / `""` → today's behavior
   * (DEFAULT_WARM_NUDGE / the `warmNudge` seam at all three delays).
   *
   * The channel reply path is UNCHANGED — the subagent still returns its result
   * via clawcode_ack / the Stop-hook turn_complete fallback over the channel.
   */
  readonly firstTurnInput?: string | null;
  /**
   * Phase 140 — Model A opt-in: include `plugin:discord` in the channels argv so
   * the agent owns its OWN Discord bot. Defaults to `false` (Model B — the daemon
   * owns the single gateway and routes over the channel). The single-agent dev
   * env sets `true`.
   */
  readonly includeDiscordPlugin?: boolean;
  /**
   * Phase 141 (#4) — v3 PTY permission mode. Threaded from
   * `config.llmRuntime.permissionMode` (llm-runtime-service.ts) into
   * `buildChannelsArgv` as `--permission-mode`. Undefined → the argv builder
   * applies the `bypassPermissions` default (v2 SDK parity).
   */
  readonly permissionMode?: string;
  /**
   * Phase 999.86 — pre-warmed worker pool support. When `true`, `loadSdkModule`
   * skips BOTH the warm-nudge schedule AND the `firstTurnInput` schedule. The
   * supervisor + channel still come up; the agent stays parked on the
   * `--dangerously-load-development-channels` confirmation menu, waiting for
   * the pool's external `supervisor.write("\r<message>\n")` to land. That
   * single write IS the menu-dismiss + first-turn task — the reliable
   * fresh-spawn trigger pattern 999.83 proved, deferred to dispatch time so
   * the cold-start latency is paid in the background instead of per message.
   *
   * Precedence: `deferFirstTurn: true` wins over `firstTurnInput` and
   * `warmNudge`. `undefined` / `false` → today's behavior.
   */
  readonly deferFirstTurn?: boolean;
}

/** Default per-agent channels-state dir: `~/.clawcode/channels-state/<agent>`. */
function defaultChannelsStateDir(agent: string): string {
  return path.join(homedir(), ".clawcode", "channels-state", agent);
}

/**
 * Resolve the built channel MCP server (`dist/channels/clawcode-channel-mcp-server.js`)
 * relative to THIS compiled module. At runtime this file is
 * `<dist>/llm-runtime/backends/claude-code-interactive.js`, so the server is
 * two dirs up + `channels/...` — install-location-agnostic (works under
 * `/opt/clawcode/dist` and a local checkout). Falls back to a project-relative
 * `dist/...` guess if `import.meta.url` is unavailable (odd vitest config).
 */
function defaultChannelMcpServerPath(): string {
  // Phase 140 (live-E2E finding): the BUILT server always lives at
  // `<repo>/dist/channels/clawcode-channel-mcp-server.js`. The old logic did
  // `dirname×3` from import.meta.url, which is wrong both under tsx (yields a
  // `src/…​.js` that doesn't exist — only the `.ts` does) AND under the bundled
  // dist layout (the backend is bundled into `dist/cli/index.js`, not 3 levels
  // under `dist`). Anchor on the repo root (trim at the `/src/` or `/dist/`
  // boundary) and target `dist/channels`; verify the candidate exists.
  const FILE = "clawcode-channel-mcp-server.js";
  const candidates: string[] = [];
  try {
    const here = fileURLToPath(import.meta.url);
    const m = here.match(/^(.*?)[\\/](?:src|dist)[\\/]/);
    if (m && m[1]) candidates.push(path.join(m[1], "dist", "channels", FILE));
    candidates.push(
      path.join(path.dirname(path.dirname(path.dirname(here))), "channels", FILE),
    );
  } catch {
    /* import.meta.url unavailable — fall through to cwd */
  }
  candidates.push(path.join(process.cwd(), "dist", "channels", FILE));
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0] ?? path.join(process.cwd(), "dist", "channels", FILE);
}

/**
 * Resolve a built `dist/channels/<file>` hook — install-agnostic anchoring,
 * same strategy as {@link defaultChannelMcpServerPath}. Shared by the `Stop`
 * hook (deterministic delivery fallback) and the `PostToolUse` progress hook
 * (Phase 999.82 block-level streaming); both are injected via `--settings`.
 */
function resolveDistChannelHook(file: string): string {
  const candidates: string[] = [];
  try {
    const here = fileURLToPath(import.meta.url);
    const m = here.match(/^(.*?)[\\/](?:src|dist)[\\/]/);
    if (m && m[1]) candidates.push(path.join(m[1], "dist", "channels", file));
    candidates.push(
      path.join(path.dirname(path.dirname(path.dirname(here))), "channels", file),
    );
  } catch {
    /* import.meta.url unavailable — fall through to cwd */
  }
  candidates.push(path.join(process.cwd(), "dist", "channels", file));
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0] ?? path.join(process.cwd(), "dist", "channels", file);
}

/**
 * Resolve the built `Stop` hook (`dist/channels/clawcode-stop-hook.js`). This is
 * the deterministic delivery fallback: the v3 backend injects it via
 * `--settings` so every v3 agent signals turn-end to the daemon (see
 * clawcode-stop-hook.ts).
 */
function defaultStopHookPath(): string {
  return resolveDistChannelHook("clawcode-stop-hook.js");
}

/**
 * Resolve the built `PostToolUse` progress hook
 * (`dist/channels/clawcode-progress-hook.js`). Phase 999.82 — block-level
 * streaming: fires per tool call mid-turn and ships accumulated assistant text
 * to the daemon over `hook.sock` (see clawcode-progress-hook.ts).
 */
function defaultProgressHookPath(): string {
  return resolveDistChannelHook("clawcode-progress-hook.js");
}

/**
 * Resolve the built `PreToolUse` Bash-allowlist hook
 * (`dist/channels/clawcode-bash-allowlist-hook.js`). Phase 141 WS-2 (Option B) —
 * registered ONLY for a locked-down agent (non-empty `security.allowlist`); fires
 * on Bash tool calls and denies any command not matching the allowlist
 * (`CLAWCODE_BASH_ALLOWLIST` env), reusing the v2 `matchCommand` semantics.
 */
function defaultBashAllowlistHookPath(): string {
  return resolveDistChannelHook("clawcode-bash-allowlist-hook.js");
}

/**
 * Build the `--settings` JSON-string that registers the v3 hooks. Merged (not
 * replacing) on top of the agent's workspace settings — `--settings` loads
 * ADDITIONAL settings per `claude --help`, so registering `Stop` AND
 * `PostToolUse` in one merged JSON is correct. Both hook commands run the built
 * script under the SAME node that runs the daemon (absolute paths; the agent
 * spawn env carries `CLAWCODE_AGENT_NAME` the hooks route by).
 *
 *   - `Stop`        — deterministic turn-end delivery fallback (Phase 140).
 *   - `PostToolUse` — block-level progress stream (Phase 999.82).
 *   - `PreToolUse` (Bash matcher, Phase 141 WS-2 Option B) — only when
 *     `registerBashAllowlistHook` is true (a locked-down agent with a
 *     `security.allowlist`). Gates Bash ONLY: the hook denies any command not on
 *     the agent's allowlist (delivered via `CLAWCODE_BASH_ALLOWLIST` in the spawn
 *     env), reusing the v2 `matchCommand` semantics. A hook deny takes precedence
 *     over `bypassPermissions` and is headless-safe (no prompt → no PTY hang), so
 *     the agent keeps deny-by-default Bash WITHOUT losing any non-Bash/MCP tool
 *     (v2 parity — v2's allowlist gates Bash only). `dontAsk` was rejected: it
 *     auto-denies EVERY prompting tool (Write/Edit/WebFetch + clawcode MCP incl.
 *     clawcode_ack), which would break the agent. See 141-WS2-SECURITY.md.
 */
function buildHookSettings(registerBashAllowlistHook = false): string {
  const stopCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(defaultStopHookPath())}`;
  const progressCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(defaultProgressHookPath())}`;
  const hooks: Record<string, unknown> = {
    Stop: [{ hooks: [{ type: "command", command: stopCommand }] }],
    PostToolUse: [{ hooks: [{ type: "command", command: progressCommand }] }],
  };
  if (registerBashAllowlistHook) {
    const allowlistCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(defaultBashAllowlistHookPath())}`;
    hooks.PreToolUse = [
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: allowlistCommand }],
      },
    ];
  }
  return JSON.stringify({ hooks });
}

/** Build the channels argv launched through the PTY (CONTEXT build scope). */
/**
 * Phase 140 parity — channel-protocol system prompt appended to every v3 agent.
 *
 * Teaches the agent the ClawCode-channel contract so it behaves correctly BY
 * DEFAULT (closes Plan-07 caveat #1, where the agent only acked when a message
 * explicitly told it to): process channel notifications, call `clawcode_ack`
 * with the `reply_correlation_id` so synchronous callers (ask-agent / subagent
 * relay) get a reply, surface progress on long work, and use the `clawcode`
 * tool server (spawn_subagent_thread / post_to_agent / memory / ask_advisor)
 * the same way a managed v2 agent does. Identity/soul still comes from the
 * workspace `CLAUDE.md` (claude auto-discovers it from cwd).
 */
/**
 * The channel-protocol contract injected via `--append-system-prompt`.
 *
 * TOPOLOGY-DEPENDENT (the bug fixed 2026-05-26 was a single shared string that
 * claimed a Discord plugin even for Model B, where the agent has none — so the
 * agent replied conversationally into a chat that doesn't exist and never
 * acked, leaving the daemon's `awaitReply` to time out and Discord stuck on
 * "typing…"):
 *
 *  - **Model B** (`includeDiscordPlugin: false`, the fleet default): the agent
 *    has NO direct Discord connection. EVERY message — including ordinary user
 *    chat — arrives over `clawcode-channel`. Phase 141 A1: the contract is
 *    **reply-as-text-by-default** — the agent writes its answer as the final
 *    assistant message and the Phase-140 Stop hook delivers it
 *    (`handleTurnComplete`), with NO `clawcode_ack` round-trip (that extra
 *    tool_result→model round-trip cost 3.7–12.7s/turn of discarded trailing
 *    prose). `clawcode_ack` is reserved for CORRELATED control traffic, whose
 *    call sites (e.g. `daemon-ask-agent-ipc.ts`) inject an explicit in-band
 *    ack instruction into the message body that overrides the text default —
 *    so a synchronous a2a/ask caller still receives a correlated reply.
 *  - **Model A** (`includeDiscordPlugin: true`, dev / per-agent opt-in): the
 *    agent owns `plugin:discord` and replies to users there directly. `ack` is
 *    only for `clawcode-channel` control traffic (a2a ask / subagent relay).
 *
 * The agent sees daemon pushes as a `<channel source="clawcode" type="..."
 * message_id="...">payload</channel>` envelope (see `clawcode-channel-server.ts`
 * `toChannelNotification` — `meta.message_id` is flattened to a tag attribute),
 * so the ack target is "the `message_id` from the `<channel>` tag".
 */
// Quick 260715-j1j (D11) — exported for the steer-conditional test pins
// (test-only export precedent: createTracedSessionHandle in session-adapter).
export function buildChannelProtocolPrompt(
  includeDiscordPlugin: boolean,
  nativeWorkflow: boolean,
  // 999.103 WS-2 — superpowers dormancy gate for v3 agents (whose soul comes
  // from the workspace CLAUDE.md, not session-config's prompt build — the v2
  // twin of this line lives in session-config.ts). Default false keeps every
  // non-canary prompt byte-identical (prompt-cache prefix stability).
  hasSuperpowers = false,
): string {
  // Quick 260715-j1j (D11) — workflow steer, conditional on the per-agent
  // nativeWorkflow opt-in. Non-opted agents keep the 260714-mkq sentence
  // VERBATIM (byte-identical — pinned by session-config-workflow-steer.test.ts);
  // opted-in agents get the inverted, bounded variant. Shared by Model A and
  // Model B below so the two prompts can never drift.
  // 999.103 WS-2 — dormancy sentence, shared by Model A and Model B below so
  // the two prompts can never drift (same pattern as workflowSteer).
  const superpowersSteer = hasSuperpowers
    ? [
        "The superpowers plugin (brainstorming / writing-plans / executing-plans)",
        "is installed but OFF by default: invoke its skills ONLY when the operator",
        "explicitly asks (e.g. \"use superpowers\", \"brainstorm this\", \"write a",
        "plan\"). For ordinary multi-step work, plan with your built-in todo list",
        "instead - the operator sees it live in this channel.",
      ]
    : [];
  const workflowSteer = nativeWorkflow
    ? [
        "The native in-session Workflow tool is PERMITTED for this agent for",
        "in-turn parallel lanes — keep concurrent lanes ≤4 (bounded fan-out).",
        "Still prefer the `mcp__clawcode__start_workflow` tool for long-running",
        "background work that must survive the turn — it returns immediately and",
        "posts progress + results to your channel.",
      ]
    : [
        "For background fan-out (several independent tasks in parallel), use the",
        "`mcp__clawcode__start_workflow` tool — it returns immediately and posts",
        "progress + results to your channel; do NOT use the native in-session",
        "Workflow tool, whose lanes are killed when your turn ends.",
      ];
  if (includeDiscordPlugin) {
    // Model A — the agent has its own Discord bot for user chat.
    return [
      "You are running as a ClawCode v3 agent connected to two channels: your own",
      "Discord plugin (your user-facing chat — reply to users there directly) and",
      "the `clawcode-channel` MCP server (the daemon's control channel). Daemon",
      "events arrive as a `<channel source=\"clawcode\" type=\"...\" message_id=\"...\">`",
      "envelope. When you receive one (an a2a ask or a subagent-completion relay),",
      "do the requested work and then call the `clawcode_ack` tool with that exact",
      "`message_id` from the tag, a `status` of \"processed\", and your answer in",
      "`result` — this is how synchronous callers receive your reply. Use the",
      "`clawcode` MCP tools (spawn_subagent_thread, post_to_agent, ask_agent,",
      "memory_save/lookup, ask_advisor, delegate_task) exactly as a managed agent",
      "would — they reach the daemon over the manager socket.",
      // quick task 260714-mkq — workflow steer (parallel to the SDK Discord
      // steer). The v3 path had zero workflow mentions.
      ...workflowSteer,
      ...superpowersSteer,
    ].join(" ");
  }
  // Model B (DEFAULT) — the agent has NO Discord connection of its own.
  // Phase 141 A1: reply-as-text-by-default. The agent's FINAL assistant message
  // is delivered by the Stop hook (handleTurnComplete) — no `clawcode_ack`
  // round-trip, which removes the wasted trailing turn (3.7–12.7s/turn). Two
  // framings matter: (1) the answer must be the LAST thing the turn emits as
  // plain text — a turn ending on a bare tool call emits no final text and the
  // Stop hook drops empty → the reply silently times out; (2) correlated
  // control traffic (a2a/ask) carries its OWN in-band ack instruction that
  // overrides this default, so it still acks with the right message_id.
  return [
    "You are a ClawCode v3 agent. Messages reach you over the `clawcode-channel`",
    "MCP server as a",
    "`<channel source=\"clawcode\" type=\"...\" message_id=\"...\">payload</channel>`",
    "envelope. To reply, just write your COMPLETE answer as your normal final",
    "message — the system automatically delivers your last assistant message back",
    "to whoever messaged you. You do NOT need to call any tool to reply, and you do",
    "NOT need to repeat the message_id.",
    "ALWAYS finish your turn with your full answer in PLAIN TEXT, even when you used",
    "tools mid-turn (memory, search, etc.): a turn that ends on a bare tool call",
    "with no closing text delivers nothing. Write the answer last.",
    "EXCEPTION — correlated control traffic: some messages explicitly instruct you",
    "to call the `clawcode_ack` tool with a specific `message_id` (e.g. an",
    "agent-to-agent ask). When a message says that, do exactly what it says — call",
    "`clawcode_ack` with that `message_id`, `status` \"processed\", and your answer in",
    "`result` — because that caller receives ONLY your ack result, not your reply",
    "text. For ordinary user chat (no such instruction), just answer in plain text.",
    "Use the `clawcode` MCP tools (spawn_subagent_thread, post_to_agent, ask_agent,",
    "memory_save/lookup, ask_advisor, delegate_task) exactly as a managed agent",
    "would — they reach the daemon over the manager socket.",
    // quick task 260714-mkq — workflow steer (parallel to the SDK Discord
    // steer). The v3 path had zero workflow mentions.
    // Quick 260715-j1j (D11) — now conditional on nativeWorkflow (shared
    // `workflowSteer` above, same for Model A).
    ...workflowSteer,
    ...superpowersSteer,
  ].join(" ");
}

/**
 * Phase 140 parity — build the v3 agent's spawn env.
 *
 * Transforms over the daemon env:
 *  0. CREDENTIAL BASE. The env is composed over `buildAnthropicSafeEnv()` — the
 *     same single source of truth the SDK path's `buildCleanEnv` uses. It
 *     strips `ANTHROPIC_API_KEY` so the spawned binary falls through to OAuth.
 *  1. Strip nested `CLAUDE*` markers. A normal daemon has none (no-op in prod),
 *     but if the daemon is ever launched under a Claude Code session (dev), the
 *     inherited `CLAUDECODE`/`CLAUDE_CODE_*` markers make the spawned
 *     `claude --channels` suppress its interactive TUI and never start its turn
 *     loop. Auth comes from `~/.claude/.credentials.json` (a file), not env, so
 *     stripping these is safe.
 *  2. Merge a per-agent `channels-state/<agent>/.env` on top (KEY=VALUE lines).
 *     This is how an agent gets its OWN `DISCORD_BOT_TOKEN` so its
 *     `plugin:discord` connects as a distinct bot from the daemon's gateway bot
 *     (required for the 2-bot topology). Matches the gate3-canary convention.
 *
 * EXPORTED for the regression unit test.
 */
export function buildV3SpawnEnv(
  stateDir: string,
  agent: string,
  bashAllowlist?: readonly string[],
  activityStyle?: "natural" | "raw" | "off",
): Record<string, string | undefined> {
  // Credential base (single source of truth, shared with the SDK path).
  const base = buildAnthropicSafeEnv();
  // Strip nested CLAUDE* markers AFTER the credential base (buildAnthropicSafeEnv
  // leaves them untouched).
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(base)) {
    if (k.startsWith("CLAUDE") || k === "CLAUDECODE") continue;
    env[k] = v;
  }
  // Phase 141 — v3 streaming activity level for the PostToolUse progress hook
  // (clawcode-progress-hook reads CLAWCODE_ACTIVITY_STYLE). Always set so an agent
  // without config still gets the "natural" humanized default. Decoupled from the
  // /clawcode-verbose advisor flag.
  env.CLAWCODE_ACTIVITY_STYLE = activityStyle ?? "natural";
  // Phase 141 WS-2 (Option B) — deliver the agent's Bash allowlist to the
  // PreToolUse Bash hook (clawcode-bash-allowlist-hook). The hook is a child of
  // `claude` and inherits this env; it denies any Bash command not matching these
  // glob patterns (v2 `matchCommand` semantics). Only set when the agent is
  // locked down; absent ⇒ the hook isn't registered (buildHookSettings) so no
  // gate fires. (Patterns are not secret — leaking to MCP children is harmless.)
  if (bashAllowlist !== undefined && bashAllowlist.length > 0) {
    env.CLAWCODE_BASH_ALLOWLIST = JSON.stringify(bashAllowlist);
  }
  // Phase 140 (live-E2E finding): claude does NOT reliably propagate the
  // `.mcp.json` per-server `env` block to MCP subprocesses in the interactive
  // PTY spawn (it does under `--print`, not here). So inject the CLAWCODE_*
  // identity into CLAUDE'S OWN env — every MCP server claude spawns inherits the
  // parent env, so the channel server (CLAWCODE_AGENT_NAME/_DAEMON_SOCKET), the
  // clawcode tool server + shims (CLAWCODE_AGENT/_MANAGER_SOCK) all resolve their
  // identity. Belt-and-suspenders with the .mcp.json env block.
  env.CLAWCODE_AGENT_NAME = agent;
  env.CLAWCODE_DAEMON_SOCKET = path.join(stateDir, "daemon.sock");
  env.CLAWCODE_AGENT = agent;
  env.CLAWCODE_MANAGER_SOCK = MANAGER_SOCKET_PATH;
  // C3 — per-agent capability token (HMAC(daemonSecret, agent)). The clawcode
  // MCP shim sends it with every memory/document/conversation IPC call so the
  // daemon can reject cross-agent impersonation. Minted from the daemon's
  // in-memory secret; null (omitted) until the secret is initialised → the
  // daemon gate then fails open for this agent (no regression).
  const v3AgentToken = mintAgentTokenIfAvailable(agent);
  if (v3AgentToken !== null) {
    env.CLAWCODE_AGENT_TOKEN = v3AgentToken;
  }
  // Phase 140 (live-E2E finding, cont.) — Model A `plugin:discord` needs two
  // more things in claude's OWN env, for the SAME reason CLAWCODE_* are injected
  // here: claude does not reliably propagate the `.mcp.json` per-server `env`
  // block to MCP subprocesses in the interactive PTY spawn.
  //   1. DISCORD_STATE_DIR — without it the plugin (server.ts:37) falls back to
  //      the SHARED `~/.claude/channels/discord` store, breaking per-agent
  //      isolation (the agent's bot token + access.json + pairings all leak into
  //      the global store / collide with the operator's own sessions). The
  //      .mcp.json sets this per-server, but it isn't reliably propagated — so
  //      inject it into the parent env (every MCP child inherits it).
  //   2. `~/.bun/bin` on PATH — the plugin's MCP server runs via `bun`; if the
  //      daemon's inherited PATH lacks bun's conventional install dir, the
  //      Discord MCP server fails to start ("0 ready … 1 failed" in
  //      mcp-reconnect) and the v3 agent never connects to Discord. No-op when
  //      bun is already on PATH (e.g. prod systemd) — the includes() guard.
  env.DISCORD_STATE_DIR = stateDir;
  const bunBin = path.join(homedir(), ".bun", "bin");
  const pathParts = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  if (!pathParts.includes(bunBin)) {
    pathParts.push(bunBin);
    env.PATH = pathParts.join(path.delimiter);
  }
  try {
    const raw = readFileSync(path.join(stateDir, ".env"), "utf-8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (t.length === 0 || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq <= 0) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      env[key] = val;
    }
  } catch {
    // No per-agent .env — most agents share the daemon bot. Fine.
  }
  return env;
}

/**
 * Phase 141 (A3) — map the agent's `effort` config to a `claude --effort <level>`
 * CLI flag for the v3 PTY spawn. Returns null to OMIT the flag.
 *
 * The v2/SDK path applies effort in-process via `setMaxThinkingTokens`
 * (`effort-mapping.ts`). The v3 interactive backend REJECTS that mutator (the
 * in-process SDK module is inert — the real session is a PTY), so effort was
 * previously SILENTLY IGNORED on v3 → the spawned `claude` ran at its CLI default
 * (measured ≈ `high`) extended thinking on every turn. That uncontrolled thinking
 * is the Phase-141 root cause of the v3↔SDK latency gap (see 141-GATE0-FINDINGS.md);
 * threading effort onto the spawn restores the dial (A/B: low≈17s vs high≈42s).
 *
 * CLI (claude 2.1.158) accepts low/medium/high/xhigh/max; rejects off/auto. So:
 *   - low/medium/high/xhigh/max → pass through (all CLI-valid)
 *   - auto → null (omit; fall back to the CLI default)
 *   - off  → "low" (the CLI has no thinking-off; low is the minimal supported budget)
 *   - ultracode → "xhigh" (Quick 260715-j1j D10 — v3 gets NO ultracode
 *     semantics in v1: the literal "ultracode" must never reach the pinned
 *     CLI (prod pin 2.1.158 predates it), so the flag clamps to the budget
 *     equivalent. v2's runtime applyFlagSettings path owns real activation.)
 *
 * Isolated to the v3 backend on purpose — the shared SDK `effort-mapping` (tokens)
 * is untouched, preserving v2 null-diff.
 */
function mapEffortToCliFlag(effort: EffortLevel): string | null {
  switch (effort) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return effort;
    case "off":
      return "low";
    case "auto":
      return null;
    case "ultracode":
      return "xhigh";
  }
}

function buildChannelsArgv(
  binaryPath: string,
  mcpConfigPath: string,
  includeDiscordPlugin: boolean,
  effort: EffortLevel,
  model: string | undefined,
  permissionMode: string | undefined,
  disallowedTools: readonly string[] | undefined,
  securityAllowlist: readonly string[] | undefined,
  plugins: readonly string[] | undefined,
  settingSources: readonly ("project" | "user" | "local")[] | undefined,
  // Quick 260715-j1j (D11) — per-agent native-Workflow opt-in, threaded into
  // buildChannelProtocolPrompt so the v3 steer flips to the bounded permitted
  // variant for opted-in agents (non-opted prompts stay byte-identical).
  nativeWorkflow: boolean,
): readonly string[] {
  // Phase 141 WS-2 (Option B) — a locked-down agent (non-empty `security.allowlist`)
  // keeps its permissive permission mode (default `bypassPermissions`) so every
  // non-Bash + MCP tool keeps working (v2 parity), and instead gets a PreToolUse
  // Bash hook (registered in `buildHookSettings` below) that denies any command
  // not on the allowlist — deny-by-default for Bash, headless-safe, gating Bash
  // ONLY. The allowlist patterns reach that hook via `CLAWCODE_BASH_ALLOWLIST` in
  // the spawn env (`buildV3SpawnEnv`). NOTE: `dontAsk` was rejected — it auto-denies
  // EVERY prompting tool (Write/Edit/WebFetch + clawcode MCP incl. clawcode_ack),
  // which would break the agent (141-WS2-SECURITY.md).
  const hasAllowlist =
    securityAllowlist !== undefined && securityAllowlist.length > 0;
  // argv[0] is the resolved `claude` binary (ends in `claude` →
  // orphan-claude-reaper's CLAUDE_ARGV0_RE matches).
  //
  // Phase 140-09 (live-E2E finding): use `--channels`, NOT
  // `--dangerously-load-development-channels`. The dev flag shows an INTERACTIVE
  // confirmation prompt ("1. I am using this for local development / 2. Exit")
  // that a headless daemon-spawned PTY hangs on forever — never reaching the
  // turn loop, so the channel never connects. Plain `--channels` accepts a
  // `server:`-tagged channel from `--mcp-config` with no prompt (verified live).
  //
  // `--append-system-prompt` carries the channel-protocol contract (parity /
  // caveat #1); identity/soul comes from the workspace CLAUDE.md.
  //
  // Phase 140 Model B (DEFAULT): `plugin:discord` is OMITTED — the daemon owns
  // the single Discord gateway and routes messages to the agent over the
  // ClawCode channel (push + awaitReply, wired in bridge.ts). Model A (agent
  // owns its own Discord bot) opts IN via `includeDiscordPlugin: true` — used by
  // the single-agent dev env. (Follow-up: surface this as a per-agent config
  // field so the fleet can migrate A→B agent-by-agent.)
  const channelTags = [
    ...(includeDiscordPlugin
      ? ["server:clawcode-channel", "plugin:discord@claude-plugins-official"]
      : ["server:clawcode-channel"]),
    // dashboard-rework — per-agent enabled plugins (deduped against discord).
    ...pluginChannelTags(plugins).filter(
      (t) => t !== "plugin:discord@claude-plugins-official",
    ),
  ];
  return [
    binaryPath,
    // Phase 140-12 (live-E2E PROOF): `--dangerously-load-development-channels`,
    // NOT plain `--channels`. A `server:`-tagged channel is NOT on claude's
    // approved-channels allowlist, so plain `--channels` loads clawcode-channel
    // as an MCP server (socket connects) but NOT as a TURN-SOURCE channel →
    // pushed messages never trigger a turn. The dev flag approves it as a
    // channel; its one-time confirmation prompt is dismissed by the warm-nudge
    // sending Enter (DEFAULT_WARM_NUDGE = "\r"). Verified live: daemon push →
    // agent turn → clawcode_ack.
    "--dangerously-load-development-channels",
    ...channelTags,
    "--mcp-config",
    mcpConfigPath,
    // Phase 140 (live-E2E finding): `--strict-mcp-config` — use ONLY the servers
    // the daemon wrote to this `.mcp.json` (clawcode-channel + clawcode + shims),
    // IGNORING the agent workspace's `.claude/settings.json` mcpServers. Without
    // this, claude auto-loads workspace servers (e.g. `npx -y @1password/...`
    // which fetches from npm) and HANGS at startup → MCP init never completes →
    // the channel never connects. The v3 backend is the single source of truth
    // for the agent's MCP surface.
    "--strict-mcp-config",
    // Workspace isolation — restrict which setting TIERS the PTY auto-loads to the
    // agent's configured `settingSources` (loader default ["project"]), mirroring
    // the v2/SDK path (session-adapter.ts). WITHOUT this the CLI also auto-loads
    // GLOBAL ~/.claude/{settings.json,skills/,commands/,CLAUDE.md} — shared across
    // EVERY v3 agent on the host — so an agent would inherit config / skills /
    // commands / identity from OUTSIDE its own workspace. `project` loads only the
    // agent's own workspace `.claude/`; operators opt an agent into `user`
    // per-agent (e.g. Admin Clawdy GSD commands) via `config.settingSources`.
    ...(settingSources && settingSources.length > 0
      ? (["--setting-sources", settingSources.join(",")] as const)
      : []),
    // Phase 141 (A3) — thread the agent's `effort` config to the PTY as `--effort`
    // so v3 agents can be dialed below the CLI default (≈high). Omitted for `auto`.
    ...((): readonly string[] => {
      const flag = mapEffortToCliFlag(effort);
      return flag ? (["--effort", flag] as const) : [];
    })(),
    // Phase 141 — thread the agent's `model` config to the PTY as `--model`.
    // Without this the v3 spawn omitted --model entirely → the configured model
    // (e.g. `sonnet`) was IGNORED and the agent ran on the claude CLI default
    // (same class of bug as the effort gap). v2/SDK agents honor `model` via
    // setModel; v3 honors it at spawn here. Omitted when unset (CLI default).
    //
    // Phase 999.98-03 (gap closure) — `model` arrives here ALREADY RESOLVED to a
    // full `claude-*` id by the caller's `resolveModelForSpawn()` (alias +
    // `<family>@latest` both collapsed, the same way the v2 adapter pre-resolves).
    // The CLI's `--model` understands full ids + its own native aliases
    // (sonnet/opus/haiku) but NOT the ClawCode-only `fable` alias or `@latest`
    // sugar — resolving upstream guarantees neither reaches the flag.
    ...(model ? (["--model", model] as const) : []),
    // Phase 141 (#4) — headless PTY must NOT stall on a permission prompt (no
    // TTY to answer it). ALWAYS emit `--permission-mode`, defaulting to
    // `bypassPermissions` (parity with the v2 SDK path's hardcoded mode at
    // session-adapter.ts:1312/1469). `--settings` MERGES the workspace
    // .claude/settings.json, but this explicit flag makes the mode config-driven
    // rather than dependent on that file being present. Operators override
    // per-agent via `llmRuntime.permissionMode`. Phase 141 WS-2 (Option B): a
    // locked-down agent stays on this mode — its Bash allowlist is enforced by the
    // PreToolUse Bash hook (registered below), NOT by switching modes.
    "--permission-mode",
    permissionMode ?? "bypassPermissions",
    // Phase 141 (#7) — honor the agent's disallowedTools (Layer-1 tool blocklist;
    // schema.ts:637 "blast-radius if Layer 1 disallowedTools is bypassed"). v2
    // forwards config.disallowedTools to the SDK disallowedTools option
    // (session-adapter.ts:1343/1496); v3 had NO slot → a locked-down agent
    // migrated to v3 silently lost its blocklist. Emitted BEFORE --settings so
    // claude's variadic `<tools...>` stops at the next flag. Omitted when empty.
    ...(disallowedTools && disallowedTools.length > 0
      ? ["--disallowedTools", ...disallowedTools]
      : []),
    // Phase 140 + 999.82 — inject the v3 hooks. `Stop` (turn-end deterministic
    // delivery fallback, so an un-acked reply still reaches the user) AND
    // `PostToolUse` (block-level progress stream → live Discord editor). Both go
    // in one merged JSON; `--settings` MERGES additional settings (per `claude
    // --help`) — the workspace `.claude/settings.json` still loads. See
    // clawcode-stop-hook.ts + clawcode-progress-hook.ts.
    "--settings",
    buildHookSettings(hasAllowlist),
    "--append-system-prompt",
    buildChannelProtocolPrompt(
      includeDiscordPlugin,
      nativeWorkflow,
      // 999.103 WS-2 — same superpowers-ref detection as session-config.ts.
      (plugins ?? []).some((p) => p.startsWith("superpowers@")),
    ),
  ];
}

/** One MCP server entry written into the v3 `.mcp.json`. */
interface V3McpServerEntry {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Build the v3 agent's MCP server set for parity with a v2 (SDK) agent.
 *
 * Returns the agent's resolved `config.mcpServers` (search/image/browser shims +
 * any custom servers) verbatim — the SAME entries a v2 agent's SDK session
 * receives. The v3-only `clawcode-channel` server is appended separately by
 * `writeAgentMcpConfig`.
 *
 * `config.mcpEnvOverrides` (the vault-scoped op:// tokens the acme agents
 * declare) are applied last-wins onto the matching server's env when the caller
 * passes the already-resolved `resolvedEnvOverrides` map — the daemon resolves
 * it via `opEnvResolver` in `loadSdkModule`, mirroring the v2 SDK path in
 * `session-config.ts` (`effectiveMcpServers`). Absent → the common fleet's env
 * from `config.mcpServers[].env` is used unchanged (the non-acme fleet).
 */
function buildV3McpServers(
  config: ResolvedAgentConfig,
  clawcodeEntry: { readonly command: string; readonly args: readonly string[] } | null,
  resolvedEnvOverrides?: Record<string, Record<string, string>>,
): V3McpServerEntry[] {
  // Defensive `?? []` — production always populates `mcpServers`, but a partial
  // config (or a future caller) must not crash the spawn. Per-server env starts
  // from the shared block (clawdbot-resolved); any per-agent override key
  // replaces it last-wins (parity with session-config.ts effectiveMcpServers).
  const servers: V3McpServerEntry[] = (config.mcpServers ?? []).map((s) => {
    const override = resolvedEnvOverrides?.[s.name];
    return {
      name: s.name,
      command: s.command,
      args: s.args,
      env: override ? { ...s.env, ...override } : s.env,
    };
  });

  // The clawcode TOOL server — the 50+ tools a v2 agent gets in-process
  // (spawn_subagent_thread, post_to_agent, ask_agent, memory, advisor, …). For
  // v3 it runs as a subprocess (`clawcode mcp`) reaching the daemon over the
  // manager IPC socket. Named "clawcode" so tool names match v2 exactly
  // (`mcp__clawcode__*`). CLAWCODE_AGENT is the agent's AUTHORITATIVE identity
  // (the server overrides self-reported caller params with it — anti-impersonation,
  // same env-trust model the shims already use). CLAWCODE_MANAGER_SOCK points at
  // the daemon IPC socket.
  if (clawcodeEntry) {
    const clawcodeEnv: Record<string, string> = {
      CLAWCODE_AGENT: config.name,
      CLAWCODE_MANAGER_SOCK: MANAGER_SOCKET_PATH,
    };
    // C3 — capability token (belt-and-suspenders with claude's-own-env
    // injection; the PTY path does not always forward this .mcp.json env).
    const clawcodeToken = mintAgentTokenIfAvailable(config.name);
    if (clawcodeToken !== null) {
      clawcodeEnv.CLAWCODE_AGENT_TOKEN = clawcodeToken;
    }
    servers.push({
      name: "clawcode",
      command: clawcodeEntry.command,
      args: clawcodeEntry.args,
      env: clawcodeEnv,
    });
  }

  return servers;
}

/**
 * Write the per-agent `.mcp.json` and return its absolute path (the
 * `--mcp-config` value).
 *
 * Phase 140 parity: the v3 agent gets the SAME MCP surface a v2 (SDK) agent does
 * — the resolved `config.mcpServers` set (search/image/browser shims, the
 * clawcode tool server, any custom servers) PLUS the v3-only `clawcode-channel`
 * (daemon→agent push). `extraServers` is `this.config.mcpServers` written
 * through verbatim (same commands/args/env a v2 agent's SDK session receives).
 *
 * Threat T-140-04-01 (info-disclosure): the file lives under the agent's
 * channels-state dir (mode `0o700`, home-owned) and is itself `0o600`. The shim
 * / custom server env may carry resolved tokens — the SAME exposure as the
 * v2 spawn env (owner-only). The discord plugin is loaded via the argv
 * (`plugin:discord@...`), not embedded here.
 */
/**
 * Phase 999.84 Plan 05 — resolve a claude-plugins-official plugin's MCP server
 * entries from `~/.claude/plugins/installed_plugins.json` + the plugin's own
 * `.mcp.json`, with `${CLAUDE_PLUGIN_ROOT}` substituted to the absolute install
 * path. Returns `null` on any failure (plugin not installed, files missing,
 * malformed JSON) — the v3 spawn proceeds without the plugin's MCP entries
 * rather than crashing on a soft dependency.
 *
 * The plugin reference shape is `<plugin>@<marketplace>` (e.g.
 * `discord@claude-plugins-official`). The installed_plugins.json registry's
 * keys match this shape verbatim. The newest version (last entry in the
 * array) wins when multiple installs exist (mirrors claude's own resolution
 * order).
 */
export function resolveInstalledPluginMcpServers(
  pluginRef: string,
  /** Optional test-only override — production uses `homedir()`. */
  claudeHome?: string,
): Record<string, { command: string; args: string[]; env: Record<string, string> }> | null {
  try {
    const baseHome = claudeHome ?? homedir();
    const registryPath = path.join(baseHome, ".claude", "plugins", "installed_plugins.json");
    if (!existsSync(registryPath)) return null;
    const registry = JSON.parse(readFileSync(registryPath, "utf-8")) as {
      plugins?: Record<
        string,
        ReadonlyArray<{ installPath?: string; version?: string }>
      >;
    };
    const entries = registry.plugins?.[pluginRef];
    if (!entries || entries.length === 0) return null;
    // Pick the LAST entry — claude's installed_plugins.json appends new
    // versions and resolves the newest. Production case (today) has a single
    // entry; pin the picker for the multi-version case so a future install
    // doesn't silently revert to v0 just because it sorted last alphabetically.
    const installPath = entries[entries.length - 1]?.installPath;
    if (typeof installPath !== "string" || installPath.length === 0) return null;

    const pluginMcpPath = path.join(installPath, ".mcp.json");
    if (!existsSync(pluginMcpPath)) return null;
    const raw = readFileSync(pluginMcpPath, "utf-8");
    // Substitute ${CLAUDE_PLUGIN_ROOT} before JSON.parse so it works whether
    // the placeholder is used in `command`, `args`, or `env` values. The
    // installPath is the same absolute string claude itself substitutes when
    // loading via the plugin loader (we just inline-do it here because
    // --strict-mcp-config blocks the plugin loader's auto-merge).
    const substituted = raw.split("${CLAUDE_PLUGIN_ROOT}").join(installPath);
    const plugin = JSON.parse(substituted) as {
      mcpServers?: Record<
        string,
        { command?: string; args?: readonly string[]; env?: Record<string, string> }
      >;
    };
    if (!plugin.mcpServers) return null;

    const out: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {};
    for (const [name, entry] of Object.entries(plugin.mcpServers)) {
      if (typeof entry.command !== "string") continue;
      out[name] = {
        command: entry.command,
        args: Array.isArray(entry.args) ? [...entry.args] : [],
        env: entry.env ? { ...entry.env } : {},
      };
    }
    return out;
  } catch {
    // Fail-open: a malformed registry or .mcp.json should NOT crash the
    // agent spawn — the plugin just doesn't load. Operator sees plugin
    // missing in process tree + can re-bootstrap independently.
    return null;
  }
}

// dashboard-rework — per-agent native plugin enablement. `agents[].plugins` are
// `<plugin>@<marketplace>` refs. These pure helpers turn that list into the v3
// spawn pieces (channel tags + inlined plugin MCP servers), mirroring the proven
// Discord-plugin path. Invalid refs are dropped (defense-in-depth — the same
// charset the dashboard validates before install).
const PLUGIN_REF_RE = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+$/;

/** `plugin:<ref>` channel tags for the v3 `--channels` argv (invalid refs skipped). */
export function pluginChannelTags(plugins: readonly string[] | undefined): string[] {
  return (plugins ?? []).filter((r) => PLUGIN_REF_RE.test(r)).map((r) => `plugin:${r}`);
}

/** Merge the resolved MCP servers of each enabled plugin (clawcode-channel never overridden). */
export function resolveAgentPluginMcpServers(
  plugins: readonly string[] | undefined,
  claudeHome?: string,
): Record<string, { command: string; args: string[]; env: Record<string, string> }> {
  const out: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {};
  for (const ref of plugins ?? []) {
    if (!PLUGIN_REF_RE.test(ref)) continue;
    const servers = resolveInstalledPluginMcpServers(ref, claudeHome);
    if (!servers) continue;
    for (const [name, entry] of Object.entries(servers)) {
      if (name === "clawcode-channel") continue; // daemon's channel transport wins
      out[name] = entry;
    }
  }
  return out;
}

function writeAgentMcpConfig(args: {
  readonly agent: string;
  readonly stateDir: string;
  readonly serverPath: string;
  /** Parity — the agent's resolved MCP set (shims + clawcode + custom). */
  readonly extraServers?: readonly V3McpServerEntry[];
  /**
   * Phase 999.84 Plan 05 — when true, inject the
   * `discord@claude-plugins-official` plugin's MCP server entries into the
   * daemon-written `.mcp.json` so they survive the `--strict-mcp-config` flag
   * (which otherwise blocks the plugin loader's auto-merge of the plugin's
   * own .mcp.json). Required for Model A to actually start the plugin's
   * server.ts under bun.
   */
  readonly includeDiscordPlugin?: boolean;
  /** dashboard-rework — per-agent enabled plugins (`<plugin>@<marketplace>` refs). */
  readonly plugins?: readonly string[];
}): string {
  const { agent, stateDir, serverPath, extraServers = [], includeDiscordPlugin = false, plugins = [] } = args;
  // Owner-only — the .mcp.json + socket are control paths (mirrors the
  // transport's `mkdirSync(..., { mode: 0o700 })`).
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });

  const socketPath = path.join(stateDir, "daemon.sock");
  const servers: Record<
    string,
    { command: string; args: string[]; env: Record<string, string> }
  > = {};

  // Parity: the same shim + custom MCP servers a v2 agent receives, verbatim.
  for (const s of extraServers) {
    servers[s.name] = {
      command: s.command,
      args: [...s.args],
      env: { ...s.env },
    };
  }

  // v3-only: the ClawCode channel (daemon→agent push). Always present; wins on
  // any name collision so the channel transport is never shadowed.
  servers["clawcode-channel"] = {
    command: "node",
    args: [serverPath],
    env: {
      // Spec env table — per-agent socket + identity (read by
      // `clawcode-channel-mcp-server.ts:readChannelEnv`).
      CLAWCODE_DAEMON_SOCKET: socketPath,
      CLAWCODE_AGENT_NAME: agent,
    },
  };

  // Phase 999.84 Plan 05 — inject the discord plugin's MCP server entries when
  // Model A is enabled. --strict-mcp-config blocks claude's plugin-loader auto-
  // merge, so we resolve the plugin manually and add the entries to the
  // daemon-written .mcp.json. If the plugin isn't installed (resolver returns
  // null), proceed without — the argv flag stays present but no MCP server
  // spawns. Operator-visible degradation, not a fatal error.
  // clawcode-channel WINS on collision (preserved above); plugin entries do
  // NOT override it.
  if (includeDiscordPlugin) {
    const pluginServers = resolveInstalledPluginMcpServers(
      "discord@claude-plugins-official",
    );
    if (pluginServers !== null) {
      for (const [name, entry] of Object.entries(pluginServers)) {
        if (name === "clawcode-channel") continue; // preserve daemon's channel
        // Phase 999.84 Plan 05 (v2) — inject DISCORD_STATE_DIR pointing at
        // the agent's PER-AGENT state dir so plugin:discord's bun child
        // reads its token + access.json from there (not the global
        // ~/.claude/channels/discord/ which is owned by the operator's
        // own claude-code tmux sessions). Without this override, every v3
        // agent's plugin:discord would race for the SAME bot token,
        // colliding with the operator's interactive sessions AND with
        // any other v3 agent on the same host. The operator drops
        // <stateDir>/.env (DISCORD_BOT_TOKEN=...) + <stateDir>/access.json
        // (allowlist) under the agent's channels-state dir. Pre-existing
        // entries in the plugin's own .mcp.json env are PRESERVED — the
        // override appends DISCORD_STATE_DIR without dropping its other
        // env vars.
        const pluginEntry =
          name === "discord"
            ? {
                ...entry,
                env: { ...entry.env, DISCORD_STATE_DIR: stateDir },
              }
            : entry;
        servers[name] = pluginEntry;
      }
    }
  }

  // dashboard-rework — inline the MCP servers of each per-agent enabled plugin
  // (--strict-mcp-config blocks the plugin loader's auto-merge, same as discord).
  // clawcode-channel is never overridden (the helper skips it).
  for (const [name, entry] of Object.entries(resolveAgentPluginMcpServers(plugins))) {
    if (name === "clawcode-channel") continue;
    servers[name] = entry;
  }

  const mcpConfig = { mcpServers: servers };
  const mcpConfigPath = path.join(stateDir, ".mcp.json");
  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  return mcpConfigPath;
}

/**
 * Phase 140 Plan 07 — post-spawn resume-id refresh schedule. A freshly-spawned
 * `claude` child writes its session JSONL within a second or two; we refresh the
 * tracker a few times over the first ~30s so the cached id is warm well before
 * any crash→restart. Bounded one-shots (NOT an interval) — no long-lived timer.
 */
const RESUME_REFRESH_DELAYS_MS = [2_000, 8_000, 30_000] as const;

/**
 * Phase 140 parity (caveat #2) — delay before the post-spawn warm-nudge. claude
 * connects channel MCP servers LAZILY on the first turn, so a freshly-spawned
 * idle agent's channel is dormant and daemon pushes drop. This nudge triggers
 * one cheap first turn (the agent calls `clawcode_status`) which connects the
 * channel + registers readiness, so cold-start pushes land. ~5s lets claude boot.
 */
const WARM_NUDGE_DELAYS_MS = [5_000, 20_000, 45_000] as const;

/**
 * Default warm-nudge = Enter (CR). Its job is to DISMISS the one-time
 * `--dangerously-load-development-channels` confirmation prompt ("1. I am using
 * this for local development / 2. Exit" — option 1 pre-selected), which approves
 * `server:clawcode-channel` as a turn-source. Once approved, the channel
 * connects and DAEMON PUSHES trigger turns directly — no status-prompt turn is
 * needed (and a long prompt typed at the menu would mis-key it). Verified live.
 */
const DEFAULT_WARM_NUDGE = "\r";

/** Production session-lister — lazy-imports the SDK so non-v3 boots don't pay. */
const defaultListSessions: ListSessionsFn = async (options) => {
  const { listSessions } = await import("@anthropic-ai/claude-agent-sdk");
  // includeWorktrees:false — the resume id MUST come from THIS agent's project
  // dir, not a sibling git worktree. `listSessions` defaults includeWorktrees to
  // true; left on, an agent whose workspace is inside a multi-worktree repo
  // (e.g. this very `v3-channels-migration` branch) could resume the newest
  // session from the WRONG worktree.
  return listSessions({ ...options, includeWorktrees: false });
};

/** Production refresh scheduler — unref'd one-shot (never holds the loop open). */
const defaultScheduleResumeRefresh = (fn: () => void, ms: number): void => {
  const t = setTimeout(fn, ms);
  t.unref?.();
};

/**
 * Default command for the v3 `clawcode` tool server: re-run the daemon's OWN CLI
 * entry with the `mcp` subcommand (`node <cli-entry> mcp`). `process.argv[1]` is
 * the daemon's entry in prod (`/opt/clawcode/dist/cli/index.js`) and dev (tsx).
 */
const defaultClawcodeMcpCommand = (): {
  command: string;
  args: readonly string[];
} => {
  // Phase 140-12 (live-E2E finding): must be a NODE-runnable JS entry. Using
  // `process.argv[1]` is wrong under tsx (it's `src/cli/index.ts` → `node` can't
  // run a `.ts` → the clawcode tool server fails to start). Anchor on the repo
  // root and point at the BUILT `dist/cli/index.js mcp`, existsSync-gated.
  const candidates: string[] = [];
  try {
    const here = fileURLToPath(import.meta.url);
    const m = here.match(/^(.*?)[\\/](?:src|dist)[\\/]/);
    if (m && m[1]) candidates.push(path.join(m[1], "dist", "cli", "index.js"));
  } catch {
    /* fall through */
  }
  candidates.push(path.join(process.cwd(), "dist", "cli", "index.js"));
  const entry = candidates.find((c) => existsSync(c)) ?? candidates[0]!;
  return { command: process.execPath, args: [entry, "mcp"] };
};

/**
 * The v3 native-channels backend. Construction (discovery + telemetry) is
 * non-blocking; the first `loadSdkModule()` writes the per-agent channel
 * config, spawns the supervised `claude --channels` PTY, and caches the inert
 * module. The daemon never drives Discord turns under v3 — the `Query` is
 * inert; the agent's own session owns the turn loop.
 */
/**
 * Phase 999.84 Plan 01 — module-level registry of live PTY supervisors
 * keyed by agent name. Populated by `loadSdkModule()` after each successful
 * `supervisor.spawn()`. Read by `debugWriteToPtyForAgent()` so the daemon's
 * IPC handler can reach the ACTIVE supervisor without depending on which
 * backend instance the per-call resolver returns
 * (`createAgentLlmRuntimeResolver` returns a fresh instance per invocation —
 * Phase 138 failover semantics — so the instance-level `liveSupervisor`
 * field is null on every IPC-resolved instance).
 *
 * Most-recent-write-wins: if an agent restarts and its supervisor is
 * re-created, the new supervisor REPLACES the previous map entry. The map
 * grows by ONE entry per unique v3 agent name (bounded by agent count) and
 * shrinks only when explicitly cleared — there is currently no
 * unregister path because the existing supervisor handle remains valid for
 * the lifetime of the daemon (PtySupervisor wraps respawn internally).
 *
 * Exported ONLY to make `debugWriteToPtyForAgent()` and the test reset hook
 * reachable; production code paths never read this map directly.
 */
export const liveSupervisorByAgent = new Map<string, ChannelSpawnSeam>();

/**
 * Phase 999.84 Plan 01 — daemon-IPC-facing free function that writes `text`
 * to the live `claude --channels` PTY's stdin for `agent`. Looks up the
 * registry populated by `loadSdkModule()` rather than going through the
 * Phase 138 resolver (which returns fresh backend instances per call —
 * those instances' `liveSupervisor` is always null).
 *
 * Returns the same `{ ok: true }` / `{ ok: false, reason }` shape as the
 * instance method `debugWriteToPty()`. The IPC handler in daemon.ts hard-
 * gates this behind `CLAWCODE_DEBUG_PTY_WRITE=1`; this function does NOT
 * check the gate (the daemon does).
 */
export function debugWriteToPtyForAgent(
  agent: string,
  text: string,
): { ok: true } | { ok: false; reason: string } {
  const supervisor = liveSupervisorByAgent.get(agent);
  if (supervisor === undefined) {
    return { ok: false, reason: "no-supervisor" };
  }
  if (typeof supervisor.write !== "function") {
    return { ok: false, reason: "no-write-seam" };
  }
  supervisor.write(text);
  return { ok: true };
}

export class ClaudeCodeInteractiveBackend implements LlmRuntimeService {
  readonly backendId = "claude-code-interactive" as const;

  private readonly binaryPathPromise: Promise<string>;
  private cachedSdkModule: FakeChannelsSdkModule | null = null;
  private readonly seams: InteractiveBackendSeams;
  /**
   * Phase 999.84 Plan 01 — live PTY supervisor handle for the discriminating
   * experiment. Set after `supervisor.spawn()` succeeds in `loadSdkModule()`.
   * Stays `null` until this instance's loadSdkModule has been called.
   *
   * **Important** — the daemon-side IPC handler does NOT use this field;
   * `createAgentLlmRuntimeResolver` returns a FRESH backend instance per
   * call (Phase 138 failover semantics), so the IPC's resolver call yields
   * a new instance whose `liveSupervisor` is null. The ACTIVE supervisor
   * (created by the session-manager's first-instance backend during agent
   * startup) is reachable via the module-level `liveSupervisorByAgent`
   * registry below, populated alongside this field on every successful
   * spawn.
   */
  private liveSupervisor: ChannelSpawnSeam | null = null;

  constructor(
    private readonly config: ResolvedAgentConfig,
    private readonly deps: LlmRuntimeDeps,
    /** Optional discovery deps for unit tests; production leaves undefined. */
    discoveryDeps?: DiscoverCliBinaryDeps,
    /** Optional PTY/channel/transcript seams for unit tests. */
    seams?: InteractiveBackendSeams,
  ) {
    this.seams = seams ?? {};

    const telemetry = {
      agent: config.name,
      backend: "claude-code-interactive" as const,
      model: config.model,
    };
    if (deps.logger) {
      deps.logger.info(telemetry, "phase140-claude-channels");
    } else {
      // eslint-disable-next-line no-console
      console.info("phase140-claude-channels", JSON.stringify(telemetry));
    }

    // Fire-and-forget discovery — daemon boot must not block on `which`. The
    // first `loadSdkModule()` awaits this; `CliBinaryNotFoundError` (with the
    // full `.checked` list) surfaces there, not at construction.
    //
    // researcher_todo (Stage 3): thread an explicit
    // `llmRuntime.claude.pathToClaudeExecutable` config field through here
    // (mirrors `llmRuntime.codex.pathToCodexExecutable`). For now we rely on
    // PATH + CLAUDE_DEFAULT_COMMON_PATHS only.
    this.binaryPathPromise = discoverCliBinary(
      {
        binaryName: "claude",
        // Fleet binary (999.169): the same resolver every SDK spawn uses —
        // the Agent SDK's bundled, version-matched binary or the explicit
        // CLAWCODE_CLAUDE_BIN override. Leaf module, so no import cycle.
        // v3 keeps discovery's PATH + CLAUDE_DEFAULT_COMMON_PATHS tiers as its
        // fallback (its tested contract; v3 has no production agents).
        explicitPath: fleetClaudeBinaryOrUndefined(),
        commonPaths: CLAUDE_DEFAULT_COMMON_PATHS,
      },
      discoveryDeps,
    );
    this.binaryPathPromise.catch(() => {});
  }

  /**
   * v3-optin — resolve this agent's `config.mcpEnvOverrides` (op:// vault tokens)
   * via the injected `deps.opEnvResolver`, mirroring the v2 SDK path
   * (`session-config.ts`). Returns undefined (→ no merge) when the agent declares
   * no overrides, no resolver is wired, or it has no MCP servers — i.e. the
   * non-acme fleet. Throws propagate (a bad op:// fails the agent start, a
   * loud signal — never silently inherit the wrong-scoped token).
   */
  private async resolveAgentMcpEnvOverrides(): Promise<
    Record<string, Record<string, string>> | undefined
  > {
    const overrides = this.config.mcpEnvOverrides;
    const resolver = this.deps.opEnvResolver;
    if (!overrides || !resolver || (this.config.mcpServers ?? []).length === 0) {
      return undefined;
    }
    // Convert the readonly-Record shape on the resolved config to a mutable
    // plain Record for the resolver call (it returns a fresh mutable copy — we
    // never write back to the input). Mirrors session-config.ts:1097.
    const mutableInput: Record<string, Record<string, string>> = {};
    for (const [serverName, envMap] of Object.entries(overrides)) {
      mutableInput[serverName] = { ...envMap };
    }
    return resolver(mutableInput, this.config.name);
  }

  /**
   * Phase 999.98-03 (gap closure) — resolve `config.model` to the FULL `claude-*`
   * id the CLI's `--model` flag understands, mirroring the v2/SDK adapter's
   * `resolveModelId(preResolveModel(config.model))` composition exactly:
   *   1. `<family>@latest` → newest entitled concrete id via `resolveLatestModel`
   *      over the live daemon catalog snapshot (pinned-alias floor when cold).
   *   2. The result (or a plain alias / id) → `resolveModelId`, which maps
   *      aliases — including `fable`→`claude-fable-5` — to full ids and passes
   *      concrete ids through unchanged.
   *
   * Undefined (`config.model` unset) stays undefined so the spawn omits `--model`
   * entirely (the CLI default — unchanged from the pre-fix behavior).
   *
   * NOTE the v2↔v3 asymmetry is inherent, not a defect: a running v3 PTY's
   * `--model` is fixed at spawn, so a live catalog flip is picked up only on the
   * NEXT respawn (v2 re-reads the snapshot per createSession/per-turn). Both
   * paths agree on the resolved id at (re)spawn time.
   *
   * Reads the snapshot at call-time (the live daemon ref via `deps.getCatalogSnapshot`,
   * defaulting to an empty snapshot when unwired). Pure helpers; no IO here.
   */
  private resolveModelForSpawn(): string | undefined {
    const raw = this.config.model;
    if (raw === undefined) return undefined;
    const snapshot = (this.deps.getCatalogSnapshot ?? (() => []))();
    const preResolved = raw.endsWith("@latest")
      ? resolveLatestModel(raw, snapshot)
      : raw;
    return resolveModelId(preResolved);
  }

  async loadSdkModule(): Promise<LlmRuntimeSdkModule> {
    if (this.cachedSdkModule) {
      return this.cachedSdkModule;
    }

    // Surface CliBinaryNotFoundError if all three tiers failed. MUST precede
    // the channel-config write + spawn so a misconfigured path never spawns a
    // half-wired child.
    const binaryPath = await this.binaryPathPromise;

    // 1. Write the per-agent .mcp.json + derive the channels argv.
    const stateDir =
      this.seams.channelsStateDir?.(this.config.name) ??
      defaultChannelsStateDir(this.config.name);
    const serverPath =
      this.seams.channelMcpServerPath?.() ?? defaultChannelMcpServerPath();
    // Phase 999.84 Plan 05 — Model A requires the plugin's MCP server to
    // appear in the daemon-written .mcp.json (the only servers --strict-mcp-
    // config permits). The same `includeDiscordPlugin` flag that toggles the
    // argv tag below ALSO toggles the plugin's MCP server injection. Compute
    // once for consistency between the two paths.
    const useModelA = this.seams.includeDiscordPlugin ?? false;
    // v3-optin — resolve per-agent mcpEnvOverrides (op:// vault tokens) BEFORE
    // building the server set, so acme agents get their vault-scoped token
    // merged into the written .mcp.json (parity with the v2 SDK path).
    const resolvedEnvOverrides = await this.resolveAgentMcpEnvOverrides();
    const mcpConfigPath = writeAgentMcpConfig({
      agent: this.config.name,
      stateDir,
      serverPath,
      // Parity — give the v3 agent the same resolved MCP surface as a v2 agent
      // (search/image/browser shims, custom servers) PLUS the clawcode tool
      // server (with CLAWCODE_AGENT identity), appended by buildV3McpServers.
      extraServers: buildV3McpServers(
        this.config,
        this.seams.clawcodeMcpCommand === undefined
          ? defaultClawcodeMcpCommand()
          : this.seams.clawcodeMcpCommand,
        resolvedEnvOverrides,
      ),
      includeDiscordPlugin: useModelA,
      plugins: this.config.plugins, // dashboard-rework — per-agent enabled plugins
    });
    const argv = buildChannelsArgv(
      binaryPath,
      mcpConfigPath,
      useModelA, // Model B default; dev env / Model A opts in
      this.config.effort, // Phase 141 (A3) — dial thinking budget on the PTY spawn
      this.resolveModelForSpawn(), // Phase 141 honored the model; 999.98-03 RESOLVES it (alias/@latest → full claude-* id) so `--model` never sees `fable`/`opus@latest` raw

      this.seams.permissionMode, // Phase 141 (#4) — v3 permission mode (defaults to bypassPermissions)
      this.config.disallowedTools, // Phase 141 (#7) — honor disallowedTools (Layer-1 blocklist; was dropped on v3)
      this.config.security?.allowlist?.map((e) => e.pattern), // Phase 141 WS-2 — deny-by-default Bash allowlist (dontAsk + permissions.allow)
      this.config.plugins, // dashboard-rework — per-agent enabled plugins → plugin:<ref> tags
      this.config.settingSources, // Workspace isolation — restrict setting tiers to the agent's own workspace (parity with v2 settingSources)
      this.config.nativeWorkflow === true, // Quick 260715-j1j (D11) — flips the v3 workflow steer for opted-in agents (fail-closed on omission)
    );
    // Resolve cwd like the SDK path's `ensureSessionCwd` (session-adapter.ts):
    // `gsd.projectDir` overrides `workspace` (e.g. a GSD agent → its sandbox),
    // and `workspace` is loader-REQUIRED (ResolvedAgentConfig.workspace: string)
    // so there is no daemon-cwd fallback. The old `?? process.cwd()` both ignored
    // the gsd override AND risked dropping a v3 agent into the DAEMON's shared cwd
    // if workspace were ever unset — keep v3 agents in their OWN workspace/sandbox.
    const cwd = this.config.gsd?.projectDir ?? this.config.workspace;

    // 1b. Phase 140 Plan 07 (140-04 Deferred #2) — resume-id tracker. Caches the
    //     latest `claude` session id for this agent's project dir so a
    //     supervisor restart appends `--resume <id>` instead of starting fresh.
    //     The getter is synchronous (PtySupervisor's contract); the cache is
    //     refreshed asynchronously after spawn (below). Fail-safe: a cold/failed
    //     tracker returns null → fresh spawn (pre-seam behavior).
    const resumeTracker = new SessionIdTracker({
      cwd,
      listSessions: this.seams.listSessions ?? defaultListSessions,
      log: this.deps.logger,
    });

    // 2. Construct + start the supervisor (real PtySupervisor by default).
    const factory =
      this.seams.supervisorFactory ?? this.defaultSupervisorFactory();
    const supervisor = factory({
      agent: this.config.name,
      argv,
      cwd,
      // Parity — per-agent spawn env: nested CLAUDE* stripped + the agent's own
      // channels-state/.env merged (its DISCORD_BOT_TOKEN → distinct bot).
      env: buildV3SpawnEnv(
        stateDir,
        this.config.name,
        this.config.security?.allowlist?.map((e) => e.pattern), // Phase 141 WS-2 (Option B) — PreToolUse Bash hook allowlist
        this.config.perf?.streaming?.activity, // Phase 141 — v3 streaming activity level (natural|raw|off)
      ),
      logger: this.deps.logger
        ? {
            info: this.deps.logger.info.bind(this.deps.logger),
            warn: this.deps.logger.warn.bind(this.deps.logger),
            // LlmRuntimeDeps.logger has no `error`; route through `warn`.
            error: this.deps.logger.warn.bind(this.deps.logger),
          }
        : undefined,
      // Phase 140 Plan 07 — wire the resume seam (was hardcoded undefined).
      getResumeSessionId: () => resumeTracker.get(),
    });
    await supervisor.spawn();
    // Phase 999.84 Plan 01 — capture the live supervisor for the debug PTY
    // write seam. AFTER `spawn()` resolves so the handle is post-init.
    // Mirror to BOTH the instance field (instance-method consumers + tests)
    // and the module-level registry (`debugWriteToPtyForAgent` lookup — the
    // daemon IPC's only resolver since the Phase 138 per-call resolver
    // returns fresh backend instances whose `liveSupervisor` is null).
    this.liveSupervisor = supervisor;
    liveSupervisorByAgent.set(this.config.name, supervisor);

    // 2b. Prime the resume-id cache off the hot path. Bounded one-shot refreshes
    //     over the child's first ~30s so the id is warm before any restart.
    const scheduleRefresh =
      this.seams.scheduleResumeRefresh ?? defaultScheduleResumeRefresh;
    for (const delayMs of RESUME_REFRESH_DELAYS_MS) {
      scheduleRefresh(() => void resumeTracker.refresh(), delayMs);
    }

    // 2c. Phase 140 parity (caveat #2) — warm-nudge the agent's first turn so
    //     its channel MCP client connects (claude connects channels lazily). A
    //     null seam disables it (channel connects on the first real turn instead).
    const warmNudge =
      this.seams.warmNudge === undefined ? DEFAULT_WARM_NUDGE : this.seams.warmNudge;
    this.deps.logger?.info(
      { agent: this.config.name, hasWrite: Boolean(supervisor.write), warmNudge: warmNudge !== null },
      "phase140-warm-nudge-setup",
    );
    // Phase 999.86 — pre-warmed worker pool: skip BOTH the warm-nudge AND
    // firstTurnInput schedules. The agent stays parked on the dev-channels
    // confirmation menu; the pool's external supervisor.write delivers the
    // \r + message later (single fresh-spawn trigger write).
    const deferFirstTurn = this.seams.deferFirstTurn === true;
    // Phase 999.83-02 (Fix A) — when a non-empty firstTurnInput (subagent task)
    // is present it OVERRIDES the warm-nudge schedule: deliver the task as the
    // first real PTY turn-trigger AFTER dismissing the dev-channels menu, ONCE.
    const firstTurnInput =
      typeof this.seams.firstTurnInput === "string" &&
      this.seams.firstTurnInput.length > 0
        ? this.seams.firstTurnInput
        : null;

    if (deferFirstTurn) {
      this.deps.logger?.info(
        { agent: this.config.name },
        "phase99986-worker-deferred-spawn",
      );
    } else if (firstTurnInput !== null && supervisor.write) {
      // SUBAGENT COLD-START FIX (supersedes Fix A's single-fire PTY task write).
      // The previous code fired the menu-dismiss \r + the task ONCE at ~5s. Under
      // cold-start the `--dangerously-load-development-channels` confirmation menu
      // is not rendered by 5s, the \r is lost (no retry), the menu never
      // dismisses, the channel MCP never connects, and the spawner's
      // waitForChannelConnection times out at 60s → the delegated turn is
      // abandoned (the systematic test-agent-sub-* cold-start hang).
      //
      // Fix: the PTY writes HERE are ONLY the idempotent menu-dismiss \r,
      // retried at 5/20/45s (one lands AFTER the menu renders, exactly like the
      // warm-nudge branch below). This branch no longer types the task at a
      // blind ~5s (a long prompt typed at a not-yet-dismissed menu mis-keys it —
      // see DEFAULT_WARM_NUDGE doc). The TASK is delivered by the SPAWNER as a
      // self-submitting PTY write that is GATED on the channel actually
      // connecting (subagent-thread-spawner.ts `debugWriteToPtyForAgent` after
      // `waitForChannelConnection`) — a channel push that carries the task can
      // land in the connect→ready gap and never surface as a turn (observed
      // live: 2/3 fresh subagents under load connected but never turned). One
      // trigger ⇒ no double-run (the T-999.83-02-DUP concern only applied when
      // BOTH a PTY task AND channel content were live; here the channel push for
      // a task spawn carries content "").
      const writeNudge = supervisor.write.bind(supervisor);
      for (const ms of WARM_NUDGE_DELAYS_MS) {
        scheduleRefresh(() => {
          this.deps.logger?.info(
            { agent: this.config.name, delayMs: ms, kind: "menu-dismiss-retry" },
            "phase99983-first-turn-input-fire",
          );
          writeNudge(DEFAULT_WARM_NUDGE);
        }, ms);
      }
    } else if (warmNudge !== null && supervisor.write) {
      const writeNudge = supervisor.write.bind(supervisor);
      // Retry at several delays — a single blind write can land before claude
      // finishes booting (esp. under a busy daemon) and be lost; Model B has no
      // plugin:discord first-turn trigger, so the nudge MUST bootstrap the
      // channel. Extra nudges after connect are harmless (idempotent status turn).
      for (const ms of WARM_NUDGE_DELAYS_MS) {
        scheduleRefresh(() => {
          this.deps.logger?.info(
            { agent: this.config.name, delayMs: ms },
            "phase140-warm-nudge-fire",
          );
          writeNudge(warmNudge);
        }, ms);
      }
    }

    // 3. Cache the inert module (the daemon never drives turns under v3).
    this.cachedSdkModule = new FakeChannelsSdkModule(this.config.name);
    return this.cachedSdkModule;
  }

  /**
   * Phase 999.84 Plan 01 — discriminating experiment seam. Writes `text`
   * directly to the live `claude --channels` PTY's stdin via the captured
   * supervisor's `write` method. Returns:
   *   - `{ ok: true }` when the write was dispatched
   *   - `{ ok: false, reason: "no-supervisor" }` when `loadSdkModule()` has
   *     not yet run (no spawn happened)
   *   - `{ ok: false, reason: "no-write-seam" }` when the supervisor is a fake
   *     without a `write` method (test-only path)
   *
   * Production code paths NEVER call this — it exists ONLY for the
   * `CLAWCODE_DEBUG_PTY_WRITE=1` gated IPC handler that decides whether the
   * 999.83 PTY-first-turn pattern (proven for fresh subagents) ALSO triggers
   * turns for an already-running v3 parent. See `999.84-RESEARCH.md`.
   */
  debugWriteToPty(text: string): { ok: true } | { ok: false; reason: string } {
    const supervisor = this.liveSupervisor;
    if (supervisor === null) {
      return { ok: false, reason: "no-supervisor" };
    }
    if (typeof supervisor.write !== "function") {
      return { ok: false, reason: "no-write-seam" };
    }
    supervisor.write(text);
    this.deps.logger?.info(
      { agent: this.config.name, textLength: text.length },
      "phase99984-debug-pty-write",
    );
    return { ok: true };
  }

  /**
   * Default factory wrapping the real `PtySupervisor`.
   *
   * Phase 140 Plan 06 Task 10 — tracker selection precedence:
   *   1. `deps.mcpTracker` (the daemon's live `McpProcessTracker`) — the
   *      PRODUCTION path. Registering the PTY pid here gives the spawned
   *      `claude --channels` child `killAgentGroup` + `orphan-claude-reaper`
   *      coverage (closes 140-04 Deferred Issue #1).
   *   2. `seams.tracker` — the Plan-04 test-only seam (predates the deps
   *      wiring). `deps.mcpTracker` WINS when both are present.
   *   3. A no-op tracker — back-compat for an agent constructed with neither
   *      (non-Linux / no `/proc`). Degraded reap coverage, never a crash.
   *
   * `spawnPty` defaults to `defaultPtySpawn()` (node-pty); the unit suite
   * injects a fake via `seams.spawnPty` to exercise THIS factory (and its
   * tracker selection) without the native addon.
   */
  private defaultSupervisorFactory(): (
    options: ChannelSupervisorFactoryOptions,
  ) => ChannelSpawnSeam {
    const tracker: PtySupervisorTracker =
      this.deps.mcpTracker ??
      this.seams.tracker ?? {
        register: async () => {},
        killAgentGroup: async () => {},
      };
    const spawnPty = this.seams.spawnPty ?? defaultPtySpawn();
    return (options) =>
      new PtySupervisor({
        agent: options.agent,
        argv: options.argv,
        cwd: options.cwd,
        env: options.env,
        spawnPty,
        tracker,
        log: options.logger ?? {
          info: () => {},
          warn: () => {},
          error: () => {},
        },
        now: () => Date.now(),
        scheduleRestart: (cb, ms) => {
          const t = setTimeout(cb, ms);
          t.unref?.();
          return { cancel: () => clearTimeout(t) };
        },
        // 140-01 resume seam — Phase 140 Plan 07 wires the real getter from the
        // SessionIdTracker (passed through factory options by loadSdkModule).
        // Undefined only when a caller builds the factory without it (e.g. a
        // bare unit harness) → first spawn fresh. Live kill→respawn-resume proof
        // remains operator-canary work.
        getResumeSessionId: options.getResumeSessionId,
      });
  }
}
