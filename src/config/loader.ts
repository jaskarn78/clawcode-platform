import { execSync } from "node:child_process";
// Phase 999.114 — catalog-derived alias type for the resolved allowedModels.
import { type ConfigModel } from "../shared/model-catalog.js";
import { existsSync } from "node:fs";
import { readFile, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { configSchema, fastLaneSchema } from "./schema.js";
import { expandHome } from "./defaults.js";
import { ConfigFileNotFoundError, ConfigValidationError } from "../shared/errors.js";
import { computeCrossOwnerForbiddenPaths } from "../channels/owner-fs-guard-hook.js";
import type {
  Config,
  AgentConfig,
  DefaultsConfig,
  McpServerSchemaConfig,
  SystemPromptDirective,
} from "./schema.js";
import type {
  ResolvedAgentConfig,
  ResolvedMarketplaceSource,
  ResolvedMarketplaceSources,
} from "../shared/types.js";
// Phase 145 WS2 — single-source the absolute turn-duration default from the
// tracker (a zero-import leaf module, so no import cycle). The
// maxTurnDurationMs cascade falls back to this exact constant so a fleet with
// no override keeps the existing 20-min ceiling byte-for-byte.
import { DEFAULT_MAX_TURN_DURATION_MS } from "../manager/stream-stall-tracker.js";
// 2026-07-31 — verify-gate coverage guard (leaf-pure modules, same import
// direction as stream-stall-tracker above).
import { VERIFICATION_TOOL_SUBSTRINGS } from "../manager/financial-verification-gate.js";
import { deriveFamily, resolveModelId } from "../manager/model-resolver.js";
import { familyStallFloorMs } from "../shared/model-catalog.js";
import {
  checkVerificationToolCoverage,
  isVerificationEnforced,
} from "../manager/financial-verification-policy.js";
import { mergeTemplates } from "../manager/workflow-templates.js";
import { resolveClaudeAiConnectorsEntitlement } from "./claudeai-connectors-entitlement.js";

// ---------------------------------------------------------------------------
// Phase 110 Stage 0b — install paths + command resolver for the alternate
// MCP shim runtimes the loader auto-injects on operator opt-in via
// `defaults.shimRuntime.<type>`.
//
// STATIC_SHIM_PATH: the Go binary deployed by Wave 2's CI artifact
// bundling. The shim is a single binary that dispatches on `--type
// <search|image|browser>` (mirrors Phase 108 broker shim's `--type`
// pattern at `src/cli/commands/mcp-broker-shim.ts`).
//
// PYTHON_SHIM_PATH: reserved path for a future FastMCP-based Python
// translator. The Python translator does NOT exist in Stage 0b; the
// constant is defined together with STATIC so widening the schema enum
// to "python" does not require another loader change later.
//
// The `resolveShimCommand` helper is exported because
// `src/manager/daemon.ts`'s fleet-stats IPC handler builds proc-scan
// regex patterns from the SAME command/args shape so /api/fleet-stats
// can match the running shim children. Both call-sites must agree on
// the spawn shape per runtime, otherwise the dashboard goes blind when
// an operator flips a flag.
//
// Crash-fallback (LOCKED): no try/catch around the alternate-runtime
// path, no pre-detection of binary existence. If a "static" spawn
// fails the operator's tooling surfaces the failure directly — the
// operator-locked decision is fail-loud, not silent degradation.
// ---------------------------------------------------------------------------
// Phase 110 Stage 0b — install root is `/opt/clawcode/` on the canonical
// production host (clawdy). That directory is `example-user:clawcode 0775` so the
// deploy user writes without sudo while the clawcode daemon (group
// `clawcode`) reads+executes. Matches /opt/clawcode/dist, /opt/clawcode/
// scripts, /opt/clawcode/clawcode.yaml convention. /usr/local/bin was the
// planner's initial guess and would have required sudo grants we don't have.
//
// CLAWCODE_STATIC_SHIM_PATH / CLAWCODE_PYTHON_SHIM_PATH env overrides
// allow a parallel dev daemon (running as a different user, on a
// different config) to exercise an alternate binary location without
// rebuilding or touching production. Default values match the canonical
// install. The override is intentional defense-in-depth — same pattern
// as CLAWCODE_MANAGER_SOCK on the IPC side.
export const STATIC_SHIM_PATH =
  process.env.CLAWCODE_STATIC_SHIM_PATH ??
  "/opt/clawcode/bin/clawcode-mcp-shim";
export const PYTHON_SHIM_PATH =
  process.env.CLAWCODE_PYTHON_SHIM_PATH ??
  "/opt/clawcode/bin/clawcode-mcp-shim.py";

// Phase 110 Stage 0b — daemon IPC socket path (mirrors
// `SOCKET_PATH` in src/manager/daemon.ts:1638). Recomputed inline
// rather than imported because daemon.ts already imports from
// loader.ts and the resulting cycle would break tsup bundling. The
// Go shim's IPC client (internal/shim/ipc/client.go SocketPath) has
// the same default; this constant is what the loader injects via
// CLAWCODE_MANAGER_SOCK as defense-in-depth, so a future relocation
// of MANAGER_DIR cannot silently break alternate-runtime shims that
// were spawned with the old default baked in.
//
// MUST honor CLAWCODE_MANAGER_DIR identically to daemon.ts MANAGER_DIR.
// When the daemon's manager dir moves (e.g. for a parallel dev
// instance), the loader's injected env must follow so the shim
// children dial the actual bound socket. This was the dev-instance
// bug found 2026-05-06: dev daemon bound /home/example-user/.clawcode-dev-
// 110/manager/clawcode.sock but loader injected the canonical
// /home/example-user/.clawcode/manager/clawcode.sock — Go shim ENOENT'd
// → exit 75 → warm-path failed.
//
// Both sides MUST stay aligned with daemon.ts SOCKET_PATH. Drift is
// caught by:
//   - Go side: TestSocketPathDefaultMatchesDaemonConvention
//   - TS side: shim-runtime-env-injection assertions in
//     src/config/__tests__/loader.test.ts
const _managerDirForSocket =
  process.env.CLAWCODE_MANAGER_DIR ?? join(homedir(), ".clawcode", "manager");
export const MANAGER_SOCKET_PATH = join(_managerDirForSocket, "clawcode.sock");

export type ShimType = "search" | "image" | "browser";
export type ShimRuntime = "node" | "static" | "python";

/**
 * Phase 110 Stage 0b — resolve the command/args pair the loader emits
 * (and `src/manager/daemon.ts`'s fleet-stats proc-scan must match) for
 * a given shim type + runtime selector.
 *
 * Pure function; returns a fresh object on every call. Callers that
 * embed the result in a longer-lived structure spread `args`
 * (`[...result.args]`) so subsequent mutations don't leak into shared
 * literal references — matches the immutability discipline in CLAUDE.md.
 *
 * The "node" branch is the default-only fallthrough — exhaustiveness
 * over the schema-bound `ShimRuntime` union means any future widening
 * surfaces here as a missing case at compile time.
 */
/**
 * P2 (memory program) — per-agent `clawcode mcp` sidecar spawn resolver.
 *
 * "bundled" (default) keeps the classic `clawcode mcp` spawn — the full
 * 4.4 MB CLI bundle (~246 MB RSS per agent). "slim" spawns the esbuild
 * standalone entry (`dist/channels/clawcode-mcp-standalone.js`, built by
 * `build:channels`, shipped inside the channels dir the deploy already
 * stages) under plain `node` — MCP SDK + IPC client only.
 *
 * Fail-open: when the dial says "slim" but the built file is absent
 * (dev tree runs from src/, or a partial deploy), fall back to bundled
 * with a `p2-sidecar-resolver` warn — an agent must never boot without
 * its clawcode MCP tools. Probe seams are injectable for tests.
 */
export function resolveClawcodeMcpSpawn(
  dial: "bundled" | "slim",
  probe?: {
    readonly standalonePath?: string;
    readonly exists?: (p: string) => boolean;
  },
): { readonly command: string; readonly args: readonly string[] } {
  if (dial !== "slim") {
    return { command: "clawcode", args: ["mcp"] };
  }
  const standalonePath =
    probe?.standalonePath ??
    fileURLToPath(
      new URL("../channels/clawcode-mcp-standalone.js", import.meta.url),
    );
  const exists = probe?.exists ?? existsSync;
  if (!exists(standalonePath)) {
    console.warn(
      "p2-sidecar-resolver",
      JSON.stringify({
        dial,
        standalonePath,
        note: "slim clawcode-mcp entry missing on disk — falling back to bundled",
      }),
    );
    return { command: "clawcode", args: ["mcp"] };
  }
  return { command: "node", args: [standalonePath] };
}

export function resolveShimCommand(
  type: ShimType,
  runtime: ShimRuntime,
): { readonly command: string; readonly args: readonly string[] } {
  switch (runtime) {
    case "static":
      return {
        command: STATIC_SHIM_PATH,
        args: ["--type", type],
      };
    case "python":
      return {
        command: "python3",
        args: [PYTHON_SHIM_PATH, "--type", type],
      };
    case "node":
    default:
      return {
        command: "clawcode",
        args: [`${type}-mcp`],
      };
  }
}

/**
 * P5 (Phase 110 "Stage 0c", operator-unlocked 2026-08-03) — broker shim
 * runtime resolver. "static" spawns the Go binary's `--type 1password`
 * byte-pipe (near-zero RSS); "node" is the classic full-CLI-bundle
 * `clawcode mcp-broker-shim` (~240 MB RSS per agent), retained as the
 * explicit rollback path. Env contract identical on both
 * (OP_SERVICE_ACCOUNT_TOKEN + CLAWCODE_AGENT; broker socket defaults
 * same-user on both sides).
 */
export function resolveBrokerShimCommand(
  runtime: "node" | "static",
): { readonly command: string; readonly args: readonly string[] } {
  return runtime === "static"
    ? { command: STATIC_SHIM_PATH, args: ["--type", "1password"] }
    : { command: "clawcode", args: ["mcp-broker-shim", "--pool", "1password"] };
}

/**
 * Resolves a 1Password `op://example-vault/item/field` reference to its secret value.
 *
 * Returns the resolved secret on success, OR throws if resolution fails
 * (e.g. op CLI missing, not signed in, item not found). Implementations
 * MUST be synchronous so `resolveAgentConfig` stays pure-sync — matches the
 * `execSync` pattern used for Discord.botToken in `src/manager/daemon.ts`.
 *
 * Tests can inject a pure (no I/O) implementation to avoid subprocess calls.
 * Daemon code injects `defaultOpRefResolver` (runs `op read <ref>`).
 */
export type OpRefResolver = (ref: string) => string;

/**
 * Default `op://` resolver — shells out to the 1Password CLI.
 *
 * Runs `op read "<ref>"` via `execSync` with a 10s timeout. Mirrors the
 * existing botToken resolver in daemon.ts. Trims trailing newline.
 *
 * Throws on any failure (missing op CLI, not signed in, item/field missing,
 * timeout). Callers SHOULD wrap the invocation in a try/catch at the boot
 * boundary and surface a clear error to the operator — same pattern
 * daemon.ts uses for the Discord botToken resolution.
 */
export function defaultOpRefResolver(ref: string): string {
  return execSync(`op read "${ref}"`, { encoding: "utf-8", timeout: 10_000 }).trim();
}

/**
 * Recognizes a 1Password secret-reference URI.
 *
 * `op://example-vault/item/field` is the canonical form. We only check the scheme
 * prefix and reject the literal `op://` placeholder (no body). Anything
 * else that starts with `op://` is handed to the resolver verbatim so it
 * can produce its own "malformed ref" error if needed.
 */
function isOpRef(value: string): boolean {
  return value.startsWith("op://") && value.length > "op://".length;
}

/**
 * Load and validate a clawcode.yaml config file.
 *
 * @param configPath - Path to the YAML config file
 * @returns Validated Config object
 * @throws ConfigFileNotFoundError if the file does not exist
 * @throws ConfigValidationError if the file fails schema validation
 */
export async function loadConfig(configPath: string): Promise<Config> {
  const expandedPath = expandHome(configPath);

  let rawText: string;
  try {
    rawText = await readFile(expandedPath, "utf-8");
  } catch {
    throw new ConfigFileNotFoundError(configPath);
  }

  const rawConfig: unknown = parseYaml(rawText);
  const result = configSchema.safeParse(rawConfig);

  if (!result.success) {
    throw new ConfigValidationError(result.error, rawConfig);
  }

  return result.data;
}

/**
 * Resolve an agent config by merging with top-level defaults.
 * Returns a new object -- never mutates inputs.
 *
 * @param agent - Raw agent config from the parsed YAML
 * @param defaults - Top-level defaults section
 * @returns Fully resolved agent config
 */
/**
 * Callback invoked when resolving an MCP server's env fails (typically an
 * `op://` reference pointing at a missing 1Password item or field). When
 * present, `resolveAgentConfig` skips the failing MCP server instead of
 * throwing — one bad credential does not take out unrelated agents. When
 * omitted, the pre-existing throw behavior is preserved (migration + CLI
 * list tooling rely on strict failure to surface config errors loudly).
 */
export type McpResolutionErrorHandler = (info: {
  readonly agent: string;
  readonly server: string;
  readonly message: string;
}) => void;

/**
 * claude.ai connector entitlement for one agent: `{claudeAiConnectors: true}`
 * when entitled, `{}` otherwise. A refused opt-in is warned, never silently
 * honoured.
 */
function resolveConnectorFields(
  agent: AgentConfig,
  defaults: DefaultsConfig,
): { claudeAiConnectors?: true } {
  const decision = resolveClaudeAiConnectorsEntitlement(
    {
      name: agent.name,
      claudeAiConnectors: agent.claudeAiConnectors,
      owner: agent.owner,
      admin: agent.admin,
    },
    defaults.claudeAiConnectors?.allowedOwners ?? [],
  );
  if (decision.refusedReason !== undefined) {
    console.warn(
      `[config] agents.${agent.name}.claudeAiConnectors: true refused — ${decision.refusedReason}. ` +
        "The agent runs with claude.ai connectors disabled.",
    );
  }
  return decision.entitled ? { claudeAiConnectors: true } : {};
}

export function resolveAgentConfig(
  agent: AgentConfig,
  defaults: DefaultsConfig,
  sharedMcpServers: Record<string, McpServerSchemaConfig> = {},
  /**
   * Optional 1Password secret-reference resolver. When set, every MCP
   * server env value that matches `op://...` is substituted with the
   * resolver's return value before being handed to the spawn layer.
   *
   * When omitted, `op://...` values pass through unchanged (backward-
   * compatible with tests and tools that can't reach a 1Password backend).
   * Daemon boot MUST pass `defaultOpRefResolver` — otherwise MCP children
   * receive literal `op://...` strings in env and fail (e.g. MySQL driver
   * calls `dns.lookup("op://...")` → ENOTFOUND).
   */
  opRefResolver?: OpRefResolver,
  /**
   * Optional handler invoked when an MCP server's env resolution fails.
   * When provided, the failing MCP is excluded from `mcpServers` in the
   * returned config (graceful degradation — one bad ref doesn't crash the
   * daemon). When omitted, the resolution error propagates (pre-existing
   * behavior used by migration tooling + `clawcode list` that want to
   * surface any config drift loudly).
   */
  onMcpResolutionError?: McpResolutionErrorHandler,
): ResolvedAgentConfig {
  // Resolve heartbeat:
  //   - agent.heartbeat === false → disable but keep global config values
  //   - agent.heartbeat === true / undefined → use global config as-is
  //   - agent.heartbeat === { enabled?, every?, model?, prompt? } → object
  //     shape (Phase 90 Plan 07 WIRE-02, used by fin-client for the
  //     50-minute OpenClaw-style heartbeat). The daemon-level heartbeat
  //     runner still consumes `defaults.heartbeat` for intervalSeconds +
  //     contextFill; the per-agent object carries operator-specified
  //     cadence/prompt/model that downstream consumers read separately.
  const heartbeatConfig = (() => {
    const h = agent.heartbeat;
    if (h === false) return { ...defaults.heartbeat, enabled: false };
    // Phase 100 follow-up — propagate per-agent extended fields (every,
    // model) so downstream surfaces (capability manifest) can render the
    // operator-specified cadence instead of just the global intervalSeconds.
    if (typeof h === "object" && h !== null) {
      const enabled = "enabled" in h && h.enabled === false ? false : defaults.heartbeat.enabled;
      const every = h.every;
      const model = h.model;
      return { ...defaults.heartbeat, enabled, ...(every ? { every } : {}), ...(model ? { model } : {}) };
    }
    return defaults.heartbeat;
  })();

  // Resolve MCP servers: string refs -> shared lookup, objects -> passthrough
  const resolvedMcpMap = new Map<string, McpServerSchemaConfig>();
  for (const entry of agent.mcpServers ?? []) {
    if (typeof entry === "string") {
      const shared = sharedMcpServers[entry];
      if (!shared) {
        throw new Error(
          `MCP server "${entry}" not found in shared mcpServers definitions for agent "${agent.name}"`,
        );
      }
      resolvedMcpMap.set(shared.name, shared);
    } else {
      resolvedMcpMap.set(entry.name, entry);
    }
  }
  // Auto-inject the clawcode MCP server so every agent gets memory_lookup,
  // spawn_subagent_thread, ask_advisor, etc. — unless explicitly overridden.
  if (!resolvedMcpMap.has("clawcode")) {
    // P2 (memory program) — sidecar runtime dial. "slim" swaps the classic
    // full-CLI-bundle spawn (~246 MB RSS) for the esbuild standalone entry
    // (MCP SDK + IPC client only). Fail-open: when the dial says slim but
    // the built file is absent (dev tree, partial deploy), fall back to
    // bundled with a warn — an agent must never boot without its clawcode
    // MCP tools.
    const clawcodeMcpSpawn = resolveClawcodeMcpSpawn(
      defaults.sidecarRuntime?.clawcodeMcp ?? "bundled",
    );
    resolvedMcpMap.set("clawcode", {
      name: "clawcode",
      command: clawcodeMcpSpawn.command,
      args: [...clawcodeMcpSpawn.args],
      env: {},
      // Phase 85 TOOL-01 — clawcode MCP is mandatory (default false).
      optional: false,
      // Phase 999.162 (WS-1) — no server-level `alwaysLoad` here any more.
      // Phase 999.54 D-03a pinned the whole server so the hot-path tools
      // (spawn_subagent_thread, post_to_agent, ask_advisor, memory_lookup)
      // would not cost a ToolSearch round-trip on first use — but the pin
      // loaded all ~48 clawcode schemas (~78 KB) into every request of every
      // agent. Those four tools now pin themselves per-tool via
      // `_meta["anthropic/alwaysLoad"]` (src/mcp/server.ts); the rest defer.
      // Operator rollback to the 999.54 behaviour: declare `clawcode` inline
      // in the agent's `mcpServers:` block with `alwaysLoad: true` — that
      // populates resolvedMcpMap BEFORE the `has("clawcode")` gate above and
      // skips this auto-inject. NON-RELOADABLE per D-04: agent restart.
    });
  }

  // Auto-inject 1Password MCP when OP_SERVICE_ACCOUNT_TOKEN is available,
  // giving agents secure credential access without hardcoded secrets.
  //
  // Phase 108 — route through the daemon-managed broker. Each agent's MCP
  // client spawns `clawcode mcp-broker-shim --pool 1password`; the shim
  // hashes the literal client-side, sends {agent, tokenHash} handshake to
  // the daemon's mcp-broker.sock, then becomes a byte-transparent stdio
  // bridge. The daemon broker owns ONE pooled `@takescake/1password-mcp`
  // child per unique service-account token — N agents → 1 (or few)
  // children. Mirrors the existing browser-mcp / search-mcp / image-mcp
  // pattern. Token-literal redaction (Phase 104 SEC-07): the literal
  // never crosses the socket; broker logs only `tokenHash`.
  //
  // Existing yaml-defined `1password` entries that point at the legacy
  // npx command get rewritten to the broker shim. Per-agent token
  // overrides flow through the merged env (broker grabs the literal at
  // handshake time via daemon's tokenHashToRawToken map).
  // P5 (Stage 0c) — broker shim runtime dial, same cascade + node-warn
  // discipline as resolveRuntime below.
  const brokerRuntime: "node" | "static" =
    agent.shimRuntime?.broker ?? defaults.shimRuntime?.broker ?? "static";
  if (brokerRuntime === "node") {
    console.warn(
      "phase110-shim-resolver",
      JSON.stringify({
        agent: agent.name,
        type: "1password",
        runtime: "node",
        sourcedFrom:
          agent.shimRuntime?.broker !== undefined ? "agent" : "defaults",
        note: "Node broker shim (~240 MB RSS) selected — rollback path; flip to static when the emergency is over",
      }),
    );
  }
  const brokerShimCmd = resolveBrokerShimCommand(brokerRuntime);
  const existing1p = resolvedMcpMap.get("1password");
  const isLegacy1pCmd =
    existing1p?.command === "npx" &&
    Array.isArray(existing1p.args) &&
    existing1p.args.some((a) => typeof a === "string" && a.includes("1password-mcp"));
  if (existing1p && isLegacy1pCmd) {
    resolvedMcpMap.set("1password", {
      ...existing1p,
      command: brokerShimCmd.command,
      args: [...brokerShimCmd.args],
      env: {
        ...(existing1p.env ?? {}),
        // Audit log identity (decision §5) — broker tags every
        // dispatched call with `agent` so operators can grep journalctl
        // per agent.
        CLAWCODE_AGENT: agent.name,
      },
    });
  } else if (!resolvedMcpMap.has("1password") && process.env.OP_SERVICE_ACCOUNT_TOKEN) {
    resolvedMcpMap.set("1password", {
      name: "1password",
      command: brokerShimCmd.command,
      args: [...brokerShimCmd.args],
      env: {
        // Token literal flows shim → handshake → broker → child spawn
        // env. Shim hashes it client-side; literal never lands in any
        // log line (Phase 104 SEC-07).
        OP_SERVICE_ACCOUNT_TOKEN: process.env.OP_SERVICE_ACCOUNT_TOKEN,
        CLAWCODE_AGENT: agent.name,
      },
      // Phase 85 TOOL-01 — 1Password MCP is mandatory when auto-injected.
      optional: false,
    });
  }

  // Phase 70/71/72 + Phase 110 Stage 0b — auto-inject browser/search/image
  // MCP servers so every agent gets the corresponding tool surface. Each
  // shim type's command/args branches on `defaults.shimRuntime.<type>`
  // (default "static" — the Go binary; see resolveRuntime below). The
  // per-runtime command/args mapping lives in resolveShimCommand (kept in
  // this module so `src/manager/fleet-stats.ts`'s proc-scan patterns stay
  // in sync with what the loader actually spawns).
  //
  // Crash-fallback (LOCKED): no try/catch around the alternate-runtime
  // path, no pre-detection of binary existence. If a "static" spawn
  // fails, the operator's tooling surfaces the failure directly — the
  // operator-locked decision is fail-loud, not silent degradation.
  // Phase 110 Stage 0b — env injection helper for auto-injected shims.
  // Always sets CLAWCODE_AGENT (every runtime needs it). Adds
  // CLAWCODE_MANAGER_SOCK as defense-in-depth for non-`node` runtimes —
  // the Go binary's SocketPath() default (~/.clawcode/manager/clawcode.sock)
  // already matches the daemon's binding, but explicit env injection
  // survives any future relocation of MANAGER_DIR without a Go-side
  // rebuild. Node runtime imports the constant directly, so no env
  // override is needed (and would be redundant).
  const buildShimEnv = (runtime: ShimRuntime): Record<string, string> => {
    const env: Record<string, string> = { CLAWCODE_AGENT: agent.name };
    if (runtime !== "node") {
      env.CLAWCODE_MANAGER_SOCK = MANAGER_SOCKET_PATH;
    }
    return env;
  };

  // Phase 110 Stage 0b — per-agent shimRuntime override fall-through.
  // Resolution order: per-agent setting → defaults → "static" baseline
  // (2026-07-31: baseline flipped from "node" — the Stage 0b rollout was
  // meant to land the fleet on the Go binary, but the "node" fallback let
  // unflagged agents silently spawn three ~240 MB Node shims each).
  // Per-agent override is what makes canary rollout work: flip ONE agent
  // without touching the fleet default. The override survives
  // agent-restart because the loader re-resolves on every spawn.
  //
  // "node" is the emergency-rollback runtime and stays fully supported,
  // but it can now only be reached via explicit YAML — every node
  // resolution emits a `phase110-shim-resolver` warn (one line per shim
  // type, mirrors the phase145-maxturn-resolver shape) so runtime drift
  // like the 2026-07-31 incident can never be silent again.
  const resolveRuntime = (type: ShimType): ShimRuntime => {
    const runtime =
      agent.shimRuntime?.[type] ?? defaults.shimRuntime?.[type] ?? "static";
    if (runtime === "node") {
      const sourcedFrom =
        agent.shimRuntime?.[type] !== undefined ? "agent" : "defaults";
      console.warn(
        "phase110-shim-resolver",
        JSON.stringify({
          agent: agent.name,
          type,
          runtime,
          sourcedFrom,
          note: "Node shim (~240 MB RSS) selected — rollback path; flip to static when the emergency is over",
        }),
      );
    }
    return runtime;
  };

  const browserEnabled = defaults.browser?.enabled !== false;
  if (browserEnabled && !resolvedMcpMap.has("browser")) {
    const runtime = resolveRuntime("browser");
    const { command, args } = resolveShimCommand("browser", runtime);
    resolvedMcpMap.set("browser", {
      name: "browser",
      command,
      args: [...args],
      env: buildShimEnv(runtime),
      // Phase 85 TOOL-01 — browser MCP is mandatory when auto-injected.
      optional: false,
    });
  }

  const searchEnabled = defaults.search?.enabled !== false;
  if (searchEnabled && !resolvedMcpMap.has("search")) {
    const runtime = resolveRuntime("search");
    const { command, args } = resolveShimCommand("search", runtime);
    resolvedMcpMap.set("search", {
      name: "search",
      command,
      args: [...args],
      env: buildShimEnv(runtime),
      // Phase 85 TOOL-01 — search MCP is mandatory when auto-injected.
      optional: false,
    });
  }

  const imageEnabled = defaults.image?.enabled !== false;
  if (imageEnabled && !resolvedMcpMap.has("image")) {
    const runtime = resolveRuntime("image");
    const { command, args } = resolveShimCommand("image", runtime);
    resolvedMcpMap.set("image", {
      name: "image",
      command,
      args: [...args],
      env: buildShimEnv(runtime),
      // Phase 85 TOOL-01 — image MCP is mandatory when auto-injected.
      optional: false,
    });
  }

  // Two-stage env resolution per MCP server:
  //   (1) `${VAR}` interpolation against process.env — supports things like
  //       `${OPENAI_API_KEY}` for non-secret passthrough;
  //   (2) `op://example-vault/item/field` resolution via the injected 1Password
  //       resolver. The passthrough branch keeps existing tests + offline
  //       flows working without a live op CLI.
  // Daemon boot wires `defaultOpRefResolver` so real agents get real
  // secrets instead of a literal op://... string crashing the MCP child
  // at DNS-lookup time.
  //
  // Graceful degradation: if a caller provides `onMcpResolutionError`,
  // a single MCP's env failure (e.g. bad op:// ref) logs + excludes that
  // MCP from this agent's list instead of throwing the entire config
  // load. Agents that don't reference the failing MCP are unaffected.
  // Build into a mutable local; the field on ResolvedAgentConfig is the
  // readonly view — `push`ing here is fine, the readonly modifier applies
  // to consumers of the resolved config, not to construction.
  const mcpServers: Array<ResolvedAgentConfig["mcpServers"][number]> = [];
  for (const s of resolvedMcpMap.values()) {
    try {
      const env = Object.fromEntries(
        Object.entries(s.env ?? {}).map(([k, v]) => [
          k,
          resolveMcpEnvValue(v, opRefResolver, { serverName: s.name, varName: k }),
        ]),
      );
      mcpServers.push({
        name: s.name,
        command: s.command,
        args: [...s.args],
        env,
        // Phase 85 TOOL-01 — default to false for auto-injected servers
        // (clawcode/1password/browser/search/image) and for any entry where
        // the schema's default did not fire (e.g., string references to
        // top-level shared definitions that used the old shape). Explicitly
        // configured `optional: true` flows through unchanged.
        optional: s.optional === true,
        // Phase 100 follow-up — operator-curated annotations propagated so
        // the capability manifest can render "name (description — pattern)".
        // Both fields optional; undefined when YAML omitted them.
        ...(s.description ? { description: s.description } : {}),
        ...(s.accessPattern ? { accessPattern: s.accessPattern } : {}),
        // Phase 999.54 (D-01a) — propagate yaml-declared alwaysLoad from
        // mcpServerSchema (Plan 01) into ResolvedAgentConfig.mcpServers[].
        // Spread-conditional preserves byte-stable deep-equality for the
        // existing fleet (RESEARCH.md Pitfall 3). `=== true` matches the
        // `s.optional === true` strict-boolean idiom one line above (line
        // 486) — avoids accidental coercion of stringly-typed values.
        ...(s.alwaysLoad === true ? { alwaysLoad: true as const } : {}),
        // INC-2026-08-11 — probe throttle. Spread-conditional like the fields
        // above so the existing fleet stays byte-stable when it is omitted.
        // Without THIS line the knob parses and validates and then vanishes
        // here, and the throttle is inert with no error anywhere.
        ...(typeof s.minProbeIntervalMs === "number" && s.minProbeIntervalMs > 0
          ? { minProbeIntervalMs: s.minProbeIntervalMs }
          : {}),
      });
    } catch (err) {
      if (!onMcpResolutionError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      onMcpResolutionError({ agent: agent.name, server: s.name, message });
    }
  }

  // Phase 999.54 (D-05a) — emit one structured log per agent listing
  // servers marked alwaysLoad: true. Operator grep target on clawdy
  // systemd journal: `journalctl -u clawcode | grep phase999.54-resolver`.
  // Single line per agent at resolution time; quiet when no servers
  // are marked (empty list → no log line, keeps fleet logs clean).
  const alwaysLoadServers = mcpServers
    .filter((s) => s.alwaysLoad === true)
    .map((s) => s.name);
  if (alwaysLoadServers.length > 0) {
    console.info(
      "phase999.54-resolver",
      JSON.stringify({
        agent: agent.name,
        alwaysLoadServers,
      }),
    );
  }

  const resolvedWorkspace =
    agent.workspace ?? join(expandHome(defaults.basePath), agent.name);

  // Phase 127 — stream-stall supervisor threshold resolver cascade.
  // Precedence (highest → lowest):
  //   1. agent.streamStallTimeoutMs (operator-pinned per-agent override)
  //   2. defaults.modelOverrides[resolved.model].streamStallTimeoutMs
  //      (operator-tuned per-model override — Opus longer for advisor
  //      consults, Haiku shorter for fast turns)
  //   3. defaults.streamStallTimeoutMs (fleet-wide baseline, 180000ms
  //      enforced by schema default-then-optional combo)
  //   4. Hardcoded 180000ms fallback (defensive — required because the
  //      schema field is .optional() at the type level, so the runtime
  //      value MAY be undefined when migrated configs predate Phase 127)
  // quick task 260521-3or — the tracker is now tool-aware (tool-execution
  // time is excluded from the stall via tracker pause/resume), so the
  // 15r 600_000 band-aid was reverted back to the 180_000 baseline; a
  // genuinely dead stream still trips at the 3-min mark.
  // Emits a single `phase127-resolver` log line per agent at resolution
  // time so operators can `journalctl -u clawcode | grep phase127-resolver`
  // and see which side of the cascade fed the active threshold. Mirrors
  // the Phase 999.54-02 D-05a `phase999.54-resolver` precedent (single
  // structured-log emission per agent, JSON-stringified payload, grep-
  // friendly key).
  // Phase 999.98 kept `modelOverrides` 3-only and CAST the resolved model down
  // to (haiku|sonnet|opus), so a fable agent "simply finds no override entry".
  // That is the documented cause of a live incident — fin-research's 180s stall
  // watchdog fired with `streamStallTimeoutMs` unreachable for fable.
  //
  // Phase 999.114 — the key set now includes `fable`, and the lookup NORMALIZES
  // to the family. Two reasons that matters: Fable 5.1 is the slowest model in
  // the lineup (Anthropic's own comparative-latency row) so it is the one most
  // likely to need a raised ceiling; and historical pins are now selectable, so
  // an `opus-4-6` agent must read the `opus` entry rather than silently falling
  // through to the fleet default.
  const resolvedModelForStallCascade =
    deriveFamily(resolveModelId(agent.model ?? defaults.model)) ?? "sonnet";
  // Phase 999.114 — an EXPLICIT operator value (per-agent, or a per-family
  // modelOverrides entry) is honored EXACTLY as written, including a value
  // LOWER than the family floor: fast dead-stream detection is a legitimate
  // operator choice and this resolver must not silently overrule it.
  const explicitStallTimeoutMs =
    agent.streamStallTimeoutMs ??
    defaults.modelOverrides?.[resolvedModelForStallCascade]?.streamStallTimeoutMs;
  const fleetStallTimeoutMs = defaults.streamStallTimeoutMs ?? 180_000;
  // Phase 999.114 — the per-family FLOOR. Applied with Math.max against the
  // fleet baseline rather than as a `??` fallback, because
  // `defaults.streamStallTimeoutMs` is `.default(180_000)` and therefore ALWAYS
  // populated — a family value below it in a `??` chain would be DEAD CODE.
  // That is precisely the bug that made `defaults.modelOverrides.fable`
  // unreachable for the agent it was written for.
  const familyFloorMs = familyStallFloorMs(resolvedModelForStallCascade);
  const streamStallTimeoutMs =
    explicitStallTimeoutMs ?? Math.max(fleetStallTimeoutMs, familyFloorMs);
  const streamStallSourcedFrom:
    | "agent"
    | `modelOverrides.${string}`
    | `familyFloor.${string}`
    | "default" =
    agent.streamStallTimeoutMs !== undefined
      ? "agent"
      : defaults.modelOverrides?.[resolvedModelForStallCascade]
            ?.streamStallTimeoutMs !== undefined
        ? `modelOverrides.${resolvedModelForStallCascade}`
        : // Name the floor explicitly so `grep phase127-resolver` still answers
          // "why is this agent's threshold what it is?" in one line.
          familyFloorMs > fleetStallTimeoutMs
          ? `familyFloor.${resolvedModelForStallCascade}`
          : "default";
  console.info(
    "phase127-resolver",
    JSON.stringify({
      agent: agent.name,
      threshold: streamStallTimeoutMs,
      sourcedFrom: streamStallSourcedFrom,
    }),
  );

  // Phase 145 WS2 — absolute turn-duration ceiling cascade. Byte-for-byte
  // parallel to the streamStallTimeoutMs cascade above (same
  // resolvedModelForStallCascade narrow), single-sourcing the 20-min floor
  // from the tracker's DEFAULT_MAX_TURN_DURATION_MS so a fleet with no
  // override is byte-identical. Plan 03 reads ResolvedAgentConfig.max
  // TurnDurationMs at the createStreamStallTracker call site
  // (persistent-session-handle.ts) to lift the ceiling for long workers.
  // Emits a single `phase145-maxturn-resolver` structured-log line per agent
  // (mirrors the phase127-resolver shape) so operators can grep which side of
  // the cascade fed the active ceiling.
  const maxTurnDurationMs =
    agent.maxTurnDurationMs ??
    defaults.modelOverrides?.[resolvedModelForStallCascade]
      ?.maxTurnDurationMs ??
    defaults.maxTurnDurationMs ??
    DEFAULT_MAX_TURN_DURATION_MS;
  const maxTurnSourcedFrom: "agent" | `modelOverrides.${string}` | "default" =
    agent.maxTurnDurationMs !== undefined
      ? "agent"
      : defaults.modelOverrides?.[resolvedModelForStallCascade]
            ?.maxTurnDurationMs !== undefined
        ? `modelOverrides.${resolvedModelForStallCascade}`
        : "default";
  console.info(
    "phase145-maxturn-resolver",
    JSON.stringify({
      agent: agent.name,
      maxTurnDurationMs,
      sourcedFrom: maxTurnSourcedFrom,
    }),
  );

  // Phase 145 WS1 — subagent permission-hook gate. Cascade:
  // agent ?? defaults ?? false. Default OFF keeps the fleet byte-stable;
  // Plan 02 reads ResolvedAgentConfig.subagentPermissionGate (threaded into
  // AgentSessionConfig below) to decide whether to register the PreToolUse
  // hook in the SDK adapter.
  const subagentPermissionGate =
    agent.subagentPermissionGate ?? defaults.subagentPermissionGate ?? false;

  // WS-1 (999.99 structural delivery) — turn-attributed stream gate.
  // Cascade: agent.delivery ?? defaults.delivery ?? false. Resolved to a
  // plain boolean here; the return spread below OMITS the field when false
  // so the non-canary fleet's resolved shape stays byte-identical.
  const deliveryAttributedStream =
    agent.delivery?.attributedStream ??
    defaults.delivery?.attributedStream ??
    false;

  // Quick 260715-j1j (D7) — resolve-time guard mirroring the configSchema
  // superRefine: the RESOLVED effort (agent ?? defaults cascade) may only be
  // "ultracode" when the agent opted into nativeWorkflow. Catches a
  // defaults-level `effort: ultracode` flooring onto a non-opted agent —
  // the schema-level check only sees the per-agent field.
  const resolvedEffort = agent.effort ?? defaults.effort;
  if (resolvedEffort === "ultracode" && agent.nativeWorkflow !== true) {
    throw new Error(
      `agent "${agent.name}": effort: ultracode requires nativeWorkflow: true on the same agent (ultracode orchestrates via the native Workflow tool, which stays fleet-blocked without the opt-in).`,
    );
  }

  // Quick 260715-j1j (D5) — fleet-wide deny-list floor, then the single-name
  // subtraction for opted-in agents: `nativeWorkflow: true` removes EXACTLY
  // "Workflow" from this agent's resolved list. Never a general per-agent
  // disallowedTools surface; every other entry (and every other agent's
  // list) stays byte-identical. Immutable — filter returns a new array.
  const disallowedToolsFloor = defaults.disallowedTools ?? [
    "ScheduleWakeup",
    "CronCreate",
    "AskUserQuestion",
  ];
  const floorAfterWorkflowOptOut =
    agent.nativeWorkflow === true
      ? disallowedToolsFloor.filter((tool) => tool !== "Workflow")
      : disallowedToolsFloor;
  // WS-0 (quick 260716-u5h) — per-agent ADDITIVE union. Floor first (order
  // preserved), agent additions appended in YAML order, deduped. When the
  // agent omits the field the floor passes through untouched — the entire
  // non-opted fleet resolves byte-identically to the pre-WS-0 shape. An
  // explicit per-agent "Workflow" entry re-adds the tool AFTER the
  // nativeWorkflow subtraction — a deliberate "explicit block wins" edge
  // (see the schema field doc).
  const resolvedDisallowedTools =
    agent.disallowedTools && agent.disallowedTools.length > 0
      ? [...new Set([...floorAfterWorkflowOptOut, ...agent.disallowedTools])]
      : floorAfterWorkflowOptOut;

  // 2026-07-31 — financial-verification per-knob cascade (agent ??
  // defaults). Block emitted only when at least one field resolved
  // concrete — the untouched fleet's resolved configs stay byte-identical;
  // the runner falls back to VERIFICATION_BUDGET_DEFAULTS when
  // the block is absent. RELOADABLE (deliberately NOT in
  // NON_RELOADABLE_FIELDS; the runner's resolver closure re-reads live
  // config per gate call).
  const resolvedVerification = (() => {
    // 2026-08-26 rename — `verification` is canonical; `financialVerification`
    // is the deprecated alias kept alive so a not-yet-migrated yaml keeps
    // resolving. agentSchema is NON-STRICT, so an unmigrated key would
    // otherwise be dropped in silence rather than rejected loudly.
    // Per-SIDE resolution (agent alias falls back to agent alias, defaults
    // to defaults) so the existing agent ?? defaults cascade below is
    // untouched by the aliasing.
    const agentV = agent.verification ?? agent.financialVerification;
    const defaultsV =
      defaults.verification ?? defaults.financialVerification;
    const enforced =
      agentV?.enforced ??
      defaultsV?.enforced;
    const maxVerifyHops =
      agentV?.maxVerifyHops ??
      defaultsV?.maxVerifyHops;
    const skipIfTurnMsOver =
      agentV?.skipIfTurnMsOver ??
      defaultsV?.skipIfTurnMsOver;
    const shrinkIfTurnMsOver =
      agentV?.shrinkIfTurnMsOver ??
      defaultsV?.shrinkIfTurnMsOver;
    const deferMs =
      agentV?.deferMs ??
      defaultsV?.deferMs;
    // C (2026-08-26) — hold-mode knobs, same per-knob cascade.
    const holdDelivery =
      agentV?.holdDelivery ??
      defaultsV?.holdDelivery;
    const holdTimeoutMs =
      agentV?.holdTimeoutMs ??
      defaultsV?.holdTimeoutMs;
    // 999.63b — rule-claims sub-block, same per-knob cascade.
    const ruleClaimsEnabled =
      agentV?.ruleClaims?.enabled ??
      defaultsV?.ruleClaims?.enabled;
    const ruleClaimsMaxVerifyHops =
      agentV?.ruleClaims?.maxVerifyHops ??
      defaultsV?.ruleClaims?.maxVerifyHops;
    const ruleClaims =
      ruleClaimsEnabled === undefined && ruleClaimsMaxVerifyHops === undefined
        ? undefined
        : {
            ...(ruleClaimsEnabled !== undefined
              ? { enabled: ruleClaimsEnabled }
              : {}),
            ...(ruleClaimsMaxVerifyHops !== undefined
              ? { maxVerifyHops: ruleClaimsMaxVerifyHops }
              : {}),
          };
    // 999.63d — verified-streaming UX sub-block, same per-knob cascade.
    const uxStreamStatus =
      agentV?.ux?.streamStatus ??
      defaultsV?.ux?.streamStatus;
    const uxStreamStatusMode =
      agentV?.ux?.streamStatusMode ??
      defaultsV?.ux?.streamStatusMode;
    const uxNarrationAsTrail =
      agentV?.ux?.narrationAsTrail ??
      defaultsV?.ux?.narrationAsTrail;
    const ux_sourcesFooter = agentV?.ux?.sourcesFooter ?? defaultsV?.ux?.sourcesFooter;
    const ux_verdictReactions = agentV?.ux?.verdictReactions ?? defaultsV?.ux?.verdictReactions;
    const ux_modelSourcesLine = agentV?.ux?.modelSourcesLine ?? defaultsV?.ux?.modelSourcesLine;
    const ux_ledgerButton = agentV?.ux?.ledgerButton ?? defaultsV?.ux?.ledgerButton;
    const ux_ledgerReaction = agentV?.ux?.ledgerReaction ?? defaultsV?.ux?.ledgerReaction;
    const ux_liveClaims = agentV?.ux?.liveClaims ?? defaultsV?.ux?.liveClaims;
    const ux_statusMessage = agentV?.ux?.statusMessage ?? defaultsV?.ux?.statusMessage;
    const ux_unverifiedNotice = agentV?.ux?.unverifiedNotice ?? defaultsV?.ux?.unverifiedNotice;
    const ux_compactBelowChars = agentV?.ux?.compactBelowChars ?? defaultsV?.ux?.compactBelowChars;
    const ux_sourcesCharBudget = agentV?.ux?.sourcesCharBudget ?? defaultsV?.ux?.sourcesCharBudget;
    const uxPendingMarker =
      agentV?.ux?.pendingMarker ??
      defaultsV?.ux?.pendingMarker;
    const uxVerifiedBadge =
      agentV?.ux?.verifiedBadge ??
      defaultsV?.ux?.verifiedBadge;
    // 999.63d/6 — topic block. Whole-block cascade (not per-knob): a
    // profile and the terms that widen it are one unit; inheriting a
    // profile name from defaults while taking extraTerms from the agent
    // would silently mix two vocabularies.
    const topic = agentV?.topic ?? defaultsV?.topic;
    const ux =
      uxStreamStatus === undefined &&
      uxStreamStatusMode === undefined &&
      uxNarrationAsTrail === undefined &&
      ux_sourcesFooter === undefined &&
      ux_verdictReactions === undefined &&
      ux_modelSourcesLine === undefined &&
      ux_ledgerButton === undefined &&
      ux_ledgerReaction === undefined &&
      ux_liveClaims === undefined &&
      ux_statusMessage === undefined &&
      ux_unverifiedNotice === undefined &&
      ux_compactBelowChars === undefined &&
      ux_sourcesCharBudget === undefined &&
      uxPendingMarker === undefined &&
      uxVerifiedBadge === undefined
        ? undefined
        : {
            ...(uxStreamStatus !== undefined
              ? { streamStatus: uxStreamStatus }
              : {}),
            ...(uxStreamStatusMode !== undefined
              ? { streamStatusMode: uxStreamStatusMode }
              : {}),
            ...(uxNarrationAsTrail !== undefined
              ? { narrationAsTrail: uxNarrationAsTrail }
              : {}),
            ...(ux_sourcesFooter !== undefined ? { sourcesFooter: ux_sourcesFooter } : {}),
            ...(ux_verdictReactions !== undefined ? { verdictReactions: ux_verdictReactions } : {}),
            ...(ux_modelSourcesLine !== undefined ? { modelSourcesLine: ux_modelSourcesLine } : {}),
            ...(ux_ledgerButton !== undefined ? { ledgerButton: ux_ledgerButton } : {}),
            ...(ux_ledgerReaction !== undefined ? { ledgerReaction: ux_ledgerReaction } : {}),
            ...(ux_liveClaims !== undefined ? { liveClaims: ux_liveClaims } : {}),
            ...(ux_statusMessage !== undefined ? { statusMessage: ux_statusMessage } : {}),
            ...(ux_unverifiedNotice !== undefined ? { unverifiedNotice: ux_unverifiedNotice } : {}),
            ...(ux_compactBelowChars !== undefined ? { compactBelowChars: ux_compactBelowChars } : {}),
            ...(ux_sourcesCharBudget !== undefined ? { sourcesCharBudget: ux_sourcesCharBudget } : {}),
            ...(uxPendingMarker !== undefined
              ? { pendingMarker: uxPendingMarker }
              : {}),
            ...(uxVerifiedBadge !== undefined
              ? { verifiedBadge: uxVerifiedBadge }
              : {}),
          };
    if (
      enforced === undefined &&
      maxVerifyHops === undefined &&
      skipIfTurnMsOver === undefined &&
      shrinkIfTurnMsOver === undefined &&
      deferMs === undefined &&
      ruleClaims === undefined &&
      holdDelivery === undefined &&
      holdTimeoutMs === undefined &&
      topic === undefined &&
      ux === undefined
    ) {
      return undefined;
    }
    return {
      ...(enforced !== undefined ? { enforced } : {}),
      ...(maxVerifyHops !== undefined ? { maxVerifyHops } : {}),
      ...(skipIfTurnMsOver !== undefined ? { skipIfTurnMsOver } : {}),
      ...(shrinkIfTurnMsOver !== undefined ? { shrinkIfTurnMsOver } : {}),
      ...(deferMs !== undefined ? { deferMs } : {}),
      ...(ruleClaims !== undefined ? { ruleClaims } : {}),
      ...(holdDelivery !== undefined ? { holdDelivery } : {}),
      ...(holdTimeoutMs !== undefined ? { holdTimeoutMs } : {}),
      ...(topic !== undefined ? { topic } : {}),
      ...(ux !== undefined ? { ux } : {}),
    };
  })();

  // phase999.63-coverage-resolver — warn when an ENFORCED agent's resolved
  // toolset can never satisfy the verification whitelist (the gate would
  // be silently inert / permanently re-prompting). Fires at boot AND on
  // every reload because the config-watcher re-resolves all agents.
  // Mirrors the phase145-maxturn-resolver console-line precedent.
  if (
    isVerificationEnforced(
      agent.name,
      resolvedVerification?.enforced,
    )
  ) {
    const coverage = checkVerificationToolCoverage({
      mcpServerNames: [...resolvedMcpMap.keys()],
      disallowedTools: resolvedDisallowedTools,
      verificationSubstrings: VERIFICATION_TOOL_SUBSTRINGS,
    });
    if (!coverage.covered) {
      console.warn(
        "phase999.63-coverage-resolver",
        JSON.stringify({
          agent: agent.name,
          mcpServers: [...resolvedMcpMap.keys()],
          whitelist: VERIFICATION_TOOL_SUBSTRINGS,
          note: "financial verification is enforced but no reachable tool can ever match the whitelist — the gate cannot succeed for this agent",
        }),
      );
    }
  }

  return {
    name: agent.name,
    // Phase 999.117 WS-5 — normalise to [] so addressing never branches on
    // undefined.
    aliases: agent.aliases ?? [],
    workspace: resolvedWorkspace,
    // Phase 75 SHARED-01 — per-agent runtime state dir (memories.db, traces.db,
    // inbox/, heartbeat.log, memory/). Fallback to resolvedWorkspace for the 10
    // dedicated-workspace agents — zero behavior change. Expansion via
    // expandHome handles `~/...` and passes `./relative` + absolute paths
    // through unchanged. Only expand when explicitly set; the fallback path
    // inherits whatever resolvedWorkspace already is.
    memoryPath: agent.memoryPath ? expandHome(agent.memoryPath) : resolvedWorkspace,
    // Phase 78 CONF-01 — file-pointer SOUL/IDENTITY expansion. Conditional:
    // only expand when the raw field is set (otherwise leave undefined so
    // session-config.ts skips the soulFile branch in its precedence chain).
    soulFile: agent.soulFile ? expandHome(agent.soulFile) : undefined,
    identityFile: agent.identityFile ? expandHome(agent.identityFile) : undefined,
    channels: agent.channels,
    // Multi-platform messaging — pass the optional Slack binding through
    // verbatim (channel ids + per-message identity). undefined when the agent
    // has no `slack:` block. See .planning/multi-platform-messaging-PLAN.md.
    slack: agent.slack,
    model: agent.model ?? defaults.model,
    // Quick 260715-j1j — resolved above (D7 guard needs the value pre-return).
    effort: resolvedEffort,
    // Quick 260715-j1j (D5) — spread-conditional: the field is OMITTED for the entire non-opted fleet so
    // resolved-config deep-equality pins stay byte-identical. Consumers gate
    // on `=== true` (fail-closed).
    ...(agent.nativeWorkflow === true ? { nativeWorkflow: true as const } : {}),
    // Phase 86 MODEL-01 — resolve per-agent allowlist against fleet-wide default.
    // `defaults.allowedModels` is always populated (z default factory), so
    // consumers always see a concrete array — no downstream optional-chain
    // needed. Discord picker + SessionManager allowlist guard read this.
    // Phase 999.98 — Category E kept this cast-narrowed to (haiku|sonnet|opus)
    // so the picker could never surface Fable.
    // Phase 999.114 REVERSES that: the operator asked for every tier and every
    // historical pin to be selectable from Discord. The cast is now the full
    // catalog-derived `ModelAlias`, so what the schema accepts, what the loader
    // resolves, and what the picker renders are the SAME set — the previous
    // narrow cast silently truncated a fable/opus-4-6 entry an operator had
    // legitimately written into clawcode.yaml.
    allowedModels: (agent.allowedModels ??
      defaults.allowedModels) as readonly ConfigModel[],
    // Phase 89 GREET-07 / GREET-10 — defaults.X is always populated (zod
    // default), so the falsy-free `??` fallback is safe.
    greetOnRestart: agent.greetOnRestart ?? defaults.greetOnRestart,
    greetCoolDownMs: agent.greetCoolDownMs ?? defaults.greetCoolDownMs,
    // Phase 124 Plan 02 D-06 — per-agent auto-compaction trigger ratio
    // cascades over defaults; both are populated by zod (defaults via
    // .default(0.7), agent leaves undefined when omitted). Plan 125
    // consumes this to gate auto-compaction firing.
    autoCompactAt: resolveAutoCompactAt(agent, defaults),
    // Phase 125 Plan 02 — verbatim-gate knobs. preserveLastTurns ALWAYS
    // resolves (default 10); preserveVerbatimPatterns is undefined when
    // neither side provides entries (back-compat — non-Acme agents).
    preserveLastTurns: resolvePreserveLastTurns(agent, defaults),
    preserveVerbatimPatterns: resolvePreserveVerbatimPatterns(agent, defaults),
    // Phase 96 D-05 — propagate per-agent fileAccess into ResolvedAgentConfig
    // so daemon IPC handler (probe-fs / list-fs-status) and downstream
    // consumers see the per-agent override. When the agent omits the field,
    // we leave it undefined; the daemon's resolveFileAccess(agent, cfg, defaults)
    // falls back to defaults.fileAccess (always populated by zod default).
    // Bug fix 2026-04-25: 96-01 added the schema field but never extended the
    // ResolvedAgentConfig type or this resolver, so per-agent fileAccess
    // never reached the daemon — only defaults.fileAccess was visible.
    fileAccess: agent.fileAccess,
    // Phase 96 D-09 — propagate per-agent outputDir template (LITERAL string,
    // tokens preserved). Runtime resolveOutputDir expands at write time.
    outputDir: agent.outputDir,
    // Phase 999.99 — surface the fleet-wide SDK deny-list onto every primary
    // agent's ResolvedAgentConfig. `defaults.disallowedTools` is `.optional()`
    // on top of `.default([...])`, so the parsed value is `undefined` when the
    // `defaults:` block omits the key — the `?? ["ScheduleWakeup", "CronCreate"]`
    // floor materializes the deny-list at consumption time (same pattern as the
    // streamStallTimeoutMs `?? 180_000` cascade). There is NO per-agent
    // `disallowedTools` override surface today (AgentConfig has no such field):
    // the subagent spawner is the only OTHER writer, and it UNIONs (not
    // clobbers) this default with the recursion guard. Always-populated by
    // design — the non-empty floor passes the session-adapter `length > 0`
    // spread-conditional gate cleanly, so byte-stability holds (the value is
    // the intended fleet-wide change, not an idiom break).
    // Phase 145 WS3 — "AskUserQuestion" added to the resolver floor, kept in
    // sync with the schema `.default([...])` (the non-rendering built-in,
    // replaced by the MCP ask_user_question tool in Plan 04). Propagates to
    // ClawCode subagents via the 999.99 spawner union (no spawner edit needed).
    // Quick 260715-j1j (D5) — floor + per-agent "Workflow" subtraction now
    // computed above the return (resolvedDisallowedTools) so the nativeWorkflow
    // opt-out is applied in exactly one place.
    disallowedTools: resolvedDisallowedTools,
    // 999.103 WS-1 — TodoWrite mirror knob, whole-object cascade (agent ??
    // defaults). Spread-conditional so the untouched fleet stays byte-stable.
    // THIRD of the three places this knob must exist (schema + shared/types +
    // here) — miss one and it parses, validates, and silently does nothing.
    ...(agent.todoMirror ?? defaults.todoMirror
      ? { todoMirror: agent.todoMirror ?? defaults.todoMirror }
      : {}),
    // 999.105 — output-style baseline, whole-value cascade (agent ?? defaults),
    // spread-conditional for fleet byte-stability. THREE-place rule: schema +
    // shared/types + this spread — miss one and the knob is silently inert.
    ...(agent.outputStyle ?? defaults.outputStyle
      ? { outputStyle: agent.outputStyle ?? defaults.outputStyle }
      : {}),
    // Phase 999.13 DELEG-02 — propagate per-agent delegates map verbatim
    // (configSchema.superRefine has already validated that every target
    // points to a known agent name). UNDEFINED when the agent omits the
    // field — back-compat with the existing 15-agent fleet.
    delegates: agent.delegates,
    // Owner/tenant tag for cross-agent isolation (2026-06-27) — propagated
    // verbatim; Phase 999.187: falls back to `defaults.owner` when the agent
    // omits it; UNDEFINED when both are omitted (untenanted, no boundary).
    owner: agent.owner ?? defaults.owner,
    // claude.ai connector entitlement — derived; spread-conditional so agents
    // without an entitlement keep a byte-identical resolved config.
    ...resolveConnectorFields(agent, defaults),
    // Phase 100 GSD-02 — default settingSources to ["project"] when omitted.
    // Pitfall 3 (.min(1)) prevents `[]` from reaching here, so a populated
    // array always has at least one source. Plan 02 reads this in
    // session-adapter.ts to replace the hardcoded `settingSources: ["project"]`.
    settingSources: agent.settingSources ?? ["project"],
    // Phase 100 GSD-04 — gsd.projectDir undefined → resolved gsd undefined;
    // gsd.projectDir set → expandHome() applied (handles ~/... paths). Plan
    // 02 reads `config.gsd?.projectDir ?? config.workspace` for the SDK cwd.
    gsd: agent.gsd?.projectDir
      ? { projectDir: expandHome(agent.gsd.projectDir) }
      : undefined,
    // Phase 100 follow-up — dream config propagation. Same root-cause
    // shape as the Phase 100 settingSources / gsd.projectDir and Phase
    // 96 fileAccess fixes: agentSchema parsed `dream` but the resolver
    // dropped it, so daemon.getResolvedDreamConfig saw `undefined` and
    // silently disabled auto-fire (and manual /clawcode-dream logged
    // "skipped — dream.enabled=false" even when the yaml had
    // enabled: true). Resolution: agent.dream wins when set, otherwise
    // fall back to defaults.dream (default-bearing zod schema, always
    // populated). Per-field merge handled by the schema parse layer
    // (defaults.dream has all three fields with zod defaults filled);
    // we just thread the resolved object through.
    dream: agent.dream ?? defaults.dream,
    // Per-agent VOICE profile for the OpenAI endpoint (opt-in). Per-agent only
    // (no defaults cascade) — thread the raw block through verbatim.
    openaiVoice: agent.openaiVoice,
    // Phase 142 — agent-optimizer config. Same resolve shape as `dream`: the
    // per-agent override wins when set, otherwise fall back to the
    // default-bearing `defaults.optimizer` (always populated). Threaded here so
    // the daemon's optimizer trigger sees the resolved block, not undefined
    // (same root-cause class as the Phase 100 dream-drop fix above).
    optimizer: agent.optimizer ?? defaults.optimizer,
    // Phase 999.47 Plan 02 — homelab refresh tick config. Fleet-level
    // (no per-agent override surface today), so we read directly from
    // defaults.homelab. UNDEFINED when defaults.homelab is omitted from
    // clawcode.yaml — the heartbeat check falls back to documented
    // constants in that case.
    homelab: defaults.homelab,
    // Phase 90 MEM-01 — agent-level memoryAutoLoad beats defaults.memoryAutoLoad;
    // undefined falls back to defaults (zod default = true). Cannot use `??`
    // here: `false ?? true` would (correctly) yield false, but `undefined ??
    // true` yields true — keep explicit check for readability and symmetry
    // with the greetOnRestart pattern above.
    memoryAutoLoad:
      agent.memoryAutoLoad !== undefined
        ? agent.memoryAutoLoad
        : defaults.memoryAutoLoad,
    // Phase 90 MEM-01 — memoryAutoLoadPath is NOT in defaults (per-agent only).
    // Expanded via expandHome when set (handles ~/... paths); undefined when
    // unset so session-config.ts falls back to `{workspace}/MEMORY.md`.
    memoryAutoLoadPath: agent.memoryAutoLoadPath
      ? expandHome(agent.memoryAutoLoadPath)
      : undefined,
    // Phase 90 MEM-03 — per-agent top-K beats defaults.memoryRetrievalTopK.
    // defaults.* is always populated (zod default 5), so `??` fallback is safe
    // since topK=0 would be invalid (positive int constraint).
    memoryRetrievalTopK:
      agent.memoryRetrievalTopK ?? defaults.memoryRetrievalTopK,
    // Phase 999.124 — recall footer: agent override beats the fleet default.
    memoryRecallFooter: agent.memoryRecallFooter ?? defaults.memoryRecallFooter ?? true,
    // Phase 999.133 — recall display: agent override, fleet default, else the button.
    memoryRecallDisplay: agent.memoryRecallDisplay ?? defaults.memoryRecallDisplay ?? "button",
    // Phase 999.127 — weekly digest: agent override beats the fleet default; absent = on.
    memoryDigest: {
      enabled: agent.memoryDigest?.enabled ?? defaults.memoryDigest?.enabled ?? true,
    },
    // Phase 127 — pre-resolved above via the cascade
    // (agent → defaults.modelOverrides[model] → defaults.streamStallTimeoutMs →
    // 180000 fallback). The `phase127-resolver` structured log line has
    // already been emitted; here we just thread the resolved value into
    // ResolvedAgentConfig so consumers (persistent-session-handle.ts +
    // wrapSdkQuery) can read it without re-running the cascade.
    streamStallTimeoutMs,
    // Phase 145 WS2 — pre-resolved above via the maxTurnDurationMs cascade
    // (agent → defaults.modelOverrides[model] → defaults → 20-min default).
    // The `phase145-maxturn-resolver` line has already been emitted; thread
    // the value so buildSessionConfig → AgentSessionConfig → session-adapter
    // can carry it as a handle-only field (Plan 03 reads it at the tracker).
    maxTurnDurationMs,
    // Phase 145 WS1 — pre-resolved above (agent ?? defaults ?? false). Plan 02
    // reads this (threaded into AgentSessionConfig) to gate hook registration.
    subagentPermissionGate,
    // WS-1 (999.99 structural delivery) — spread-conditional OMIT when false
    // (byte-stable fleet); buildSessionConfig threads it into
    // AgentSessionConfig.attributedStream.
    ...(deliveryAttributedStream === true
      ? { deliveryAttributedStream: true as const }
      : {}),
    // BUGFIX (2026-06-26) — carry the per-agent advisor override block onto
    // ResolvedAgentConfig so `handleAskAdvisor` / capability resolution honor
    // `agents.<name>.advisor.backend` (it read `getAgentConfig().advisor`,
    // which was previously always undefined → the per-agent override was
    // silently dropped and every agent fell through to defaults). Spread-
    // conditional so agents without an override stay byte-identical.
    ...(agent.advisor !== undefined ? { advisor: agent.advisor } : {}),
    // Phase 115 sub-scope 3 — per-agent token budget beats defaults. Both
    // sides are positive-int constrained by zod (min 500); `??` fallback is
    // safe since 0 is already excluded. Pre-115 left this knob dead — Phase
    // 115 Plan 01 lit it up by also wiring it through getMemoryRetrieverFor
    // Agent (see SessionManager).
    memoryRetrievalTokenBudget:
      agent.memoryRetrievalTokenBudget ?? defaults.memoryRetrievalTokenBudget,
    // Phase 999.123 — fact-check step: agent override, else the fleet mode
    // (`on` forces it; `auto` and `off` leave it off).
    workflowVerifyFigures:
      agent.workflowVerifyFigures ?? defaults.workflow?.output?.verifyFigures === "on",
    // Phase 999.128 — named templates: per-agent entries override fleet ones by name.
    workflowTemplates: mergeTemplates(defaults.workflow?.templates, agent.workflowTemplates),
    // Phase 115 sub-scope 4 — per-agent exclusion list fully replaces
    // defaults (does NOT merge). Use `!== undefined` (not `??`) because an
    // empty agent array means "operator explicitly disabled filtering for
    // this agent" — it MUST beat the locked default, not fall back. Spread
    // the arrays so callers can't mutate the per-agent or defaults reference
    // through the resolved config.
    memoryRetrievalExcludeTags:
      agent.memoryRetrievalExcludeTags !== undefined
        ? [...agent.memoryRetrievalExcludeTags]
        : [...defaults.memoryRetrievalExcludeTags],
    // Phase 115 sub-scope 2 — per-agent excludeDynamicSections beats defaults.
    // Use explicit `!== undefined` check (NOT `??`) because operator can set
    // `agent.excludeDynamicSections: false` and that MUST beat
    // `defaults.excludeDynamicSections: true`.
    excludeDynamicSections:
      agent.excludeDynamicSections !== undefined
        ? agent.excludeDynamicSections
        : defaults.excludeDynamicSections,
    // Phase 115 sub-scope 5 (Plan 04) — per-agent cacheBreakpointPlacement
    // beats defaults. Both sides are zod-validated as enum literals so `??`
    // is safe; explicit `!== undefined` retained for symmetry with the
    // surrounding excludeDynamicSections / memoryScannerEnabled patterns.
    // The agent field is .optional() and the defaults field is default-
    // bearing, so the resolved value is always one of the two enum values.
    cacheBreakpointPlacement:
      agent.cacheBreakpointPlacement !== undefined
        ? agent.cacheBreakpointPlacement
        : defaults.cacheBreakpointPlacement,
    // Phase 90 MEM-02 — scanner gate. Use explicit `!== undefined` check so
    // `memoryScannerEnabled: false` in an agent yaml wins over a true default
    // (mirrors memoryAutoLoad shape).
    memoryScannerEnabled:
      agent.memoryScannerEnabled !== undefined
        ? agent.memoryScannerEnabled
        : defaults.memoryScannerEnabled,
    // Phase 90 MEM-04 — per-agent flush cadence beats defaults. Both sides
    // are positive-int constrained by zod so `??` cannot smuggle a zero.
    memoryFlushIntervalMs:
      agent.memoryFlushIntervalMs ?? defaults.memoryFlushIntervalMs,
    // Phase 90 MEM-05 — per-agent cue emoji beats defaults.memoryCueEmoji
    // (zod-populated default "✅").
    memoryCueEmoji: agent.memoryCueEmoji ?? defaults.memoryCueEmoji,
    // Phase 999.43 D-09 — per-agent autoIngestAttachments beats defaults.
    // Use explicit `!== undefined` check (NOT `??`) because operator can
    // set `agent.autoIngestAttachments: false` and that MUST beat
    // `defaults.autoIngestAttachments: true`. Mirrors the memoryAutoLoad
    // / memoryScannerEnabled / autoStart precedent above.
    autoIngestAttachments:
      agent.autoIngestAttachments !== undefined
        ? agent.autoIngestAttachments
        : defaults.autoIngestAttachments,
    // Phase 999.43 D-01 Axis 1 — per-agent ingestionPriority beats defaults.
    // Both sides are zod enum literals; explicit `!== undefined` for
    // symmetry with autoIngestAttachments above (a bare `??` would also
    // be safe but the explicit form reads more clearly).
    ingestionPriority:
      agent.ingestionPriority !== undefined
        ? agent.ingestionPriority
        : defaults.ingestionPriority,
    // Phase 100 follow-up — autoStart precedence:
    //   explicit agent.autoStart (true|false) wins over defaults.autoStart;
    //   defaults.autoStart is zod-defaulted to true, so the resolved value
    //   is always a concrete boolean (never undefined).
    // We use an explicit `!== undefined` check (NOT `??`) because the
    // operator can set `agent.autoStart: false` and that MUST beat
    // `defaults.autoStart: true` — `false ?? true` would (correctly) yield
    // false, but the explicit form mirrors the memoryAutoLoad / greetOnRestart
    // shape elsewhere in this resolver and reads more clearly.
    autoStart:
      agent.autoStart !== undefined ? agent.autoStart : defaults.autoStart,
    // Phase 999.25 — wakeOrder pass-through (no defaults.X fallback).
    // undefined → boot-last-in-yaml-order semantics handled by the sort
    // step in daemon.ts (`a.wakeOrder ?? Infinity`).
    wakeOrder: agent.wakeOrder,
    skills: agent.skills.length > 0 ? agent.skills : defaults.skills,
    // dashboard-rework — per-agent native plugins (no defaults fallback).
    plugins: agent.plugins ?? [],
    soul: agent.soul,
    identity: agent.identity,
    memory: agent.memory ?? defaults.memory,
    skillsPath: expandHome(defaults.skillsPath),
    heartbeat: heartbeatConfig,
    schedules: agent.schedules,
    admin: agent.admin ?? false,
    sandbox: resolveSandbox(agent, defaults),
    // Phase 999.98 — `subagentModel` is a subagent surface, NOT the primary
    // executor path: cast-narrow to keep the resolved type 3-only (per the
    // 3-only decision; do not widen a subagent surface just because the wider
    // schema-derived value flows here). The agent-level field shares modelSchema
    // which now admits "fable".
    subagentModel: agent.subagentModel as
      | "sonnet"
      | "opus"
      | "haiku"
      | undefined,
    threads: agent.threads ?? defaults.threads,
    webhook: agent.webhook ?? undefined,
    reactions: agent.reactions ?? true,
    security: agent.security ?? undefined,
    escalationBudget: agent.escalationBudget ?? undefined,
    contextBudgets: agent.contextBudgets ?? undefined,
    toolSearch: agent.toolSearch ?? undefined,
    // Phase 999.173 — research knobs, verbatim (defaults applied at session build).
    ...(agent.research !== undefined ? { research: agent.research } : {}),
    // Phase 999.164 — no `fastLane:` block means the lane's defaults (ON).
    fastLane: agent.fastLane ?? fastLaneSchema.parse({}),
    // Phase 999.171 — agent-level only (no defaults key); omitted = all off.
    uxFeatures: {
      liveThinking: agent.uxFeatures?.liveThinking === true,
      statusPing: agent.uxFeatures?.statusPing === true,
      promptSuggestions: agent.uxFeatures?.promptSuggestions === true,
      researchSubagents: agent.uxFeatures?.researchSubagents === true,
    },
    mcpServers,
    // Phase 100 follow-up — propagate per-agent mcpEnvOverrides through to
    // the resolved config VERBATIM (op:// resolution is deferred to agent-
    // start in src/manager/op-env-resolver.ts so the daemon's `op read`
    // happens once, async, with the daemon's clawdbot token in scope).
    // Loader stays sync-pure — no shell-out here. Undefined when the agent
    // omitted the field; existing 15-agent fleet behavior unchanged.
    ...(agent.mcpEnvOverrides
      ? { mcpEnvOverrides: agent.mcpEnvOverrides }
      : {}),
    slashCommands: agent.slashCommands,
    perf: agent.perf ?? defaults.perf ?? undefined,
    vision: agent.vision ?? undefined,
    // 999.101 — bot-trigger allowlist, verbatim pass-through (zod fills
    // cooldownMinutes/enabled defaults at parse).
    botTriggers: agent.botTriggers ?? undefined,
    // Phase 999.100 — mid-turn steering per-field cascade:
    //   agents.<n>.steering.<field> ?? defaults.steering.<field> ?? baseline.
    // Always emitted fully-resolved (see ResolvedAgentConfig.steering doc:
    // resolving HERE avoids the 2026-06-26 advisor silent-drop class).
    // Baseline values single-sourced with STEERING_BASELINE in
    // src/manager/midturn-intent.ts — schema-side zod defaults match.
    // RELOADABLE — bridge reads the resolved block per message.
    steering: (() => {
      const a = agent.steering;
      const d = defaults.steering;
      return {
        autoClassify: a?.autoClassify ?? d?.autoClassify ?? false,
        stopIntent: a?.stopIntent ?? d?.stopIntent ?? true,
        maxInjectionsPerTurn:
          a?.maxInjectionsPerTurn ?? d?.maxInjectionsPerTurn ?? 3,
        minConfidence: a?.minConfidence ?? d?.minConfidence ?? 0.75,
        stopMinConfidence:
          a?.stopMinConfidence ?? d?.stopMinConfidence ?? 0.85,
        // 2026-08-02 — 12000 in lockstep with steeringConfigSchema default
        // + STEERING_BASELINE (cold haiku-direct ~5.2s; 4s killed consults).
        classifierTimeoutMs:
          a?.classifierTimeoutMs ?? d?.classifierTimeoutMs ?? 12_000,
      };
    })(),
    // Phase 115 sub-scope 14 — propagate `debug` block from agentSchema
    // into the resolved type. UNDEFINED for the existing fleet (the field
    // is fully optional + omitted in every agent yaml). Plan 02 T01 leaves
    // both gates active (hardcoded allowlist OR flag); Plan 02 T03 removes
    // the allowlist so the flag is sole gate. The schema's nested
    // `dumpBaseOptionsOnSpawn` carries a zod default of `false`, so when
    // an operator declares `debug: {}` (empty block), the parsed value is
    // `{ dumpBaseOptionsOnSpawn: false }` — explicit-off rather than absent.
    debug: agent.debug,
    // Phase 136 — LlmRuntime backend resolution. Cascade:
    //   agents.<n>.llmRuntime.backend → defaults.llmRuntime.backend → "anthropic-agent-sdk"
    // Always populated post-resolve so downstream consumers (the
    // createLlmRuntimeService factory in daemon.ts) read it
    // unconditionally. NON_RELOADABLE — see src/config/types.ts.
    llmRuntime: {
      backend:
        agent.llmRuntime?.backend ??
        defaults.llmRuntime?.backend ??
        "anthropic-agent-sdk",
      // Phase 138 Plan 05 D4 — failover-chain cascade. Whole-block
      // per-knob fall-through: per-agent override wins, else defaults,
      // else empty (no failover). Mirrors the `backend` cascade above.
      failoverChain:
        agent.llmRuntime?.failoverChain ??
        defaults.llmRuntime?.failoverChain ??
        [],
      // Phase 999.84 Plan 04 — Model A opt-in cascade. Per-agent override
      // wins, else defaults, else undefined (Model B — buildChannelsArgv
      // reads `?? false` at the backend seam). NON_RELOADABLE.
      includeDiscordPlugin:
        agent.llmRuntime?.includeDiscordPlugin ??
        defaults.llmRuntime?.includeDiscordPlugin,
      // Phase 141 (#4) — v3 permission-mode cascade. Per-agent override wins,
      // else defaults, else undefined (buildChannelsArgv applies the
      // `bypassPermissions` default at the spawn). NON_RELOADABLE.
      permissionMode:
        agent.llmRuntime?.permissionMode ??
        defaults.llmRuntime?.permissionMode,
      // Phase 999.86 — warm worker pool cascade. Per-agent overrides
      // (size / maxConcurrent) win field-by-field over defaults. Returns
      // `undefined` when neither side sets the block, so the daemon's
      // pool boot fills the per-agent defaults (size=1, maxConcurrent=3).
      warmPool: (() => {
        const a = agent.llmRuntime?.warmPool;
        const d = defaults.llmRuntime?.warmPool;
        if (a === undefined && d === undefined) return undefined;
        return {
          size: a?.size ?? d?.size,
          maxConcurrent: a?.maxConcurrent ?? d?.maxConcurrent,
        };
      })(),
    },
    // Phase 999.63 Plan 04 — financial-verification enforcement override
    // cascade (CONTEXT.md D6). Per-knob `??` fall-through (per-agent wins
    // over defaults). The whole block is emitted ONLY when `enforced`
    // resolves to a concrete boolean — emitting an empty `{}` would still
    // work (the resolver reads `.enforced` and falls through on undefined),
    // but the per-knob shape keeps `{ enforced: false }` on `defaults`
    // from being silently dropped when an agent sets an empty `{}`. Mirrors
    // the `llmRuntime` per-knob cascade above and the `providers` block
    // below. RELOADABLE — see src/config/types.ts (deliberately NOT in
    // NON_RELOADABLE_FIELDS).
    verification: resolvedVerification,
    // Phase 137 Plan 04 — per-provider credentials cascade.
    //
    // Resolution: per-agent override wins over fleet-wide defaults;
    // when both are absent the field is `undefined`, which the
    // `OpenAiCredentialsResolver` surfaces as
    // `OpenAiCredentialsMissingError` on the agent's first Codex turn
    // (lazy fail per T3 — daemon boot stays non-blocking for agents
    // that never flip to codex-cli).
    //
    // Mirrors the Phase 117 advisor per-field cascade pattern. The
    // block is only emitted into ResolvedAgentConfig when at least
    // one provider entry resolves — keeps the type narrow + avoids
    // empty-object noise in test factories.
    //
    // NO secret resolution here: the `op://` → resolved-value
    // substitution happens at first spawn inside
    // `OpenAiCredentialsResolver.resolve()`, NOT at config load. This
    // is deliberate — it lets non-trial agents (Anthropic backend)
    // boot without the OpenAI key being warm in the cache. See
    // `.planning/phases/137-.../137-04-PLAN.md` T3 for rationale.
    providers: (() => {
      // Phase 137 — OpenAI credentials cascade (per-agent over defaults,
      // per-knob, no whole-block fall-through).
      const apiKeyPath =
        agent.providers?.openai?.apiKeyPath ??
        defaults.providers?.openai?.apiKeyPath;
      // Phase 138 D6 — per-provider daily cost cap cascade. Same per-knob
      // precedence. The DEFAULT_DAILY_CAP_USD fallback is applied at the
      // CONSUMER (Plans 02-04), NOT here — a missing field must stay
      // distinguishable from an explicit cap, so an undefined value
      // propagates verbatim.
      const openaiCapUsd =
        agent.providers?.openai?.dailyCapUsd ??
        defaults.providers?.openai?.dailyCapUsd;
      const anthropicCapUsd =
        agent.providers?.anthropic?.dailyCapUsd ??
        defaults.providers?.anthropic?.dailyCapUsd;

      const openai =
        apiKeyPath !== undefined || openaiCapUsd !== undefined
          ? {
              ...(apiKeyPath !== undefined ? { apiKeyPath } : {}),
              ...(openaiCapUsd !== undefined ? { dailyCapUsd: openaiCapUsd } : {}),
            }
          : undefined;
      const anthropic =
        anthropicCapUsd !== undefined
          ? { dailyCapUsd: anthropicCapUsd }
          : undefined;

      // Omit the whole block when nothing resolved — preserves the
      // pre-Phase-138 "providers undefined" shape for configs that set
      // neither credentials nor caps.
      if (openai === undefined && anthropic === undefined) return undefined;
      return {
        ...(openai !== undefined ? { openai } : {}),
        ...(anthropic !== undefined ? { anthropic } : {}),
      } as const;
    })(),
    // Phase 135 Plan 02 — voice block propagation. The Plan 01 schema
    // landed `agentSchema.voice` but the resolver did NOT propagate it
    // into ResolvedAgentConfig, so the runtime never saw the field.
    // Plan 02 needs the resolved voice block to construct VoiceManager
    // (auto-join channel selection, ElevenLabs/Deepgram keys). NO
    // defaults cascade — voice is opt-in per-agent per CONTEXT.md
    // ("missing block = no voice for that agent"); fleet-wide
    // defaults.voice is deferred to v3.0.1.
    //
    // Phase 135 Plan 03 — voice keys op:// resolution. Both
    // `deepgramKey` and `elevenLabsKey` may be `op://...` URIs. When
    // `opRefResolver` is set, substitute the resolved value here so
    // VoiceManager.join() sees a literal Deepgram / ElevenLabs API key
    // (NOT the op:// URI). When omitted, op:// values pass through (test
    // / offline-tool behaviour mirrors the MCP env path). Resolution
    // failures throw with context per the Phase 999.10 loud-fail
    // invariant — bad ref at boot = agent does not start.
    // INC-2026-06-04 (WS-A9) — voice is an OPTIONAL integration; a transient op
    // failure resolving its keys must NOT crash the daemon. Mirror the MCP-env
    // graceful-degradation contract: when a degradation handler is present
    // (daemon boot / hot-reload), disable voice for THIS agent and surface via
    // the handler; when absent (migration tooling / `clawcode list`), preserve
    // the Phase 999.10 loud-fail. After the op cap blew, this loud-throw was
    // the SECONDARY crash mode — 14 boots died here on voice.deepgramKey.
    voice: ((): ResolvedAgentConfig["voice"] => {
      if (!agent.voice) return undefined;
      try {
        return {
          ...agent.voice,
          deepgramKey: resolveVoiceKey(
            agent.voice.deepgramKey,
            opRefResolver,
            { agentName: agent.name, fieldName: "deepgramKey" },
          ),
          elevenLabsKey: resolveVoiceKey(
            agent.voice.elevenLabsKey,
            opRefResolver,
            { agentName: agent.name, fieldName: "elevenLabsKey" },
          ),
        };
      } catch (err) {
        if (!onMcpResolutionError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        onMcpResolutionError({ agent: agent.name, server: "voice", message });
        return undefined;
      }
    })(),
  };
}

/**
 * Resolve a content value that may be inline text or a file path.
 *
 * Resolution logic:
 * 1. If the value contains a newline, it's inline content -- return as-is
 * 2. If the value looks like a file path (starts with /, ./, ~/) and the file exists, read it
 * 3. Otherwise return as-is (treat as inline content)
 *
 * @param value - Inline content string or file path
 * @returns Resolved content string
 */
export async function resolveContent(value: string): Promise<string> {
  // Inline content: contains newlines
  if (value.includes("\n")) {
    return value;
  }

  // File path: starts with /, ./, or ~/
  if (/^[.~\/]/.test(value)) {
    const expandedPath = expandHome(value);
    if (await fileExists(expandedPath)) {
      return readFile(expandedPath, "utf-8");
    }
  }

  // Default: treat as inline content
  return value;
}

/**
 * Resolve all agents in a config by merging with defaults.
 *
 * @param config - Validated config object
 * @param opRefResolver - Optional 1Password `op://` resolver. When set,
 *   every MCP server env value of the form `op://...` is substituted
 *   before being returned. Daemon boot MUST pass `defaultOpRefResolver`
 *   so MCP children receive resolved secrets; omitting it keeps the
 *   existing passthrough behavior used by tests and offline tooling.
 * @returns Array of fully resolved agent configs
 */
export function resolveAllAgents(
  config: Config,
  opRefResolver?: OpRefResolver,
  onMcpResolutionError?: McpResolutionErrorHandler,
): ResolvedAgentConfig[] {
  const sharedMcpServers = config.mcpServers ?? {};
  const resolved = config.agents.map((agent) =>
    resolveAgentConfig(
      agent,
      config.defaults,
      sharedMcpServers,
      opRefResolver,
      onMcpResolutionError,
    ),
  );
  // Cross-owner filesystem guard (2026-06-27) — derive each agent's forbidden
  // cross-owner dir prefixes from the FULL fleet (needs every agent's owner +
  // dirs). This is the only point where all resolved agents are known;
  // buildSessionConfig threads the result to the PreToolUse owner-FS-guard hook.
  // Untenanted/admin agents get no entry → byte-identical config (no hook).
  return resolved.map((a) => {
    const crossOwnerForbiddenPaths = computeCrossOwnerForbiddenPaths(a, resolved);
    return crossOwnerForbiddenPaths.length > 0
      ? { ...a, crossOwnerForbiddenPaths }
      : a;
  });
}

/**
 * Phase 88 MKT-02 + Phase 90 Plan 04 HUB-01 — expand
 * `defaults.marketplaceSources` into a discriminated union of
 * `ResolvedMarketplaceSource` entries. Pure helper: caller controls when
 * to invoke (typically once per daemon boot, or lazily in the
 * /clawcode-skills-browse handler). Missing / undefined field yields `[]`;
 * explicit `[]` yields `[]`.
 *
 * Legacy entries (path-based, v2.2 shape) get `kind: "legacy"` with `~/...`
 * paths expanded via `expandHome`. ClawHub entries (Phase 90) pass through
 * as `kind: "clawhub"` with baseUrl/authToken/cacheTtlMs verbatim — no
 * filesystem expansion needed (the path portion is a URL, not a home-
 * relative path).
 */
export function resolveMarketplaceSources(
  config: Config,
): ResolvedMarketplaceSources {
  const raw = config.defaults.marketplaceSources;
  if (!raw || raw.length === 0) return [];
  return raw.map((src): ResolvedMarketplaceSource => {
    // Discriminate on presence of `kind` — the legacy variant omits the
    // discriminator (v2.2 shape is backward-compatible by design).
    if ("kind" in src && src.kind === "clawhub") {
      const clawhub: ResolvedMarketplaceSource = {
        kind: "clawhub",
        baseUrl: src.baseUrl,
        ...(src.authToken !== undefined ? { authToken: src.authToken } : {}),
        ...(src.cacheTtlMs !== undefined ? { cacheTtlMs: src.cacheTtlMs } : {}),
      };
      return Object.freeze(clawhub);
    }
    // Legacy branch — v2.2-compatible path entry. Cast-narrow via a
    // positive type check because the zod union omits the discriminator
    // on the legacy variant; `!("kind" in src)` is semantically correct
    // but TS narrowing on "absent key" is weaker than on present key.
    const legacyRaw = src as { path: string; label?: string };
    const legacy: ResolvedMarketplaceSource =
      legacyRaw.label !== undefined
        ? { kind: "legacy", path: expandHome(legacyRaw.path), label: legacyRaw.label }
        : { kind: "legacy", path: expandHome(legacyRaw.path) };
    return Object.freeze(legacy);
  });
}

/**
 * Resolve ${VAR_NAME} patterns in a string against process.env.
 * Unresolvable vars become empty string (no throw).
 *
 * @param value - String potentially containing ${VAR_NAME} patterns
 * @returns String with all ${...} patterns replaced by env values
 */
export function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
    return process.env[varName] ?? "";
  });
}

/**
 * Resolve an MCP server env value through both `${VAR}` interpolation and
 * `op://example-vault/item/field` 1Password reference substitution.
 *
 * Order matters: `${VAR}` expansion runs first so a value like
 * `${SECRET_REF}` can expand to `op://...` and then get resolved. If the
 * resulting string starts with `op://` and an `opRefResolver` is provided,
 * the resolver is invoked and its return value replaces the string. When
 * no resolver is provided, `op://` values pass through unchanged (matches
 * the legacy behavior before the resolver was added — keeps tests and
 * offline tools working without a live 1Password CLI).
 *
 * Resolution errors are wrapped with context (server name + var name) so
 * operators can tell which env entry failed. The underlying resolver's
 * message is preserved in the wrapped error's `cause`.
 */
export function resolveMcpEnvValue(
  raw: string,
  opRefResolver: OpRefResolver | undefined,
  ctx: { readonly serverName: string; readonly varName: string },
): string {
  const interpolated = resolveEnvVars(raw);
  if (!opRefResolver || !isOpRef(interpolated)) {
    return interpolated;
  }
  try {
    return opRefResolver(interpolated);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to resolve 1Password reference for mcpServers.${ctx.serverName}.env.${ctx.varName} (${interpolated}): ${message}`,
      { cause: err instanceof Error ? err : undefined },
    );
  }
}

/**
 * Phase 135 Plan 03 — voice key op:// resolution.
 *
 * Mirrors `resolveMcpEnvValue` but scoped to per-agent
 * `voice.deepgramKey` / `voice.elevenLabsKey`. The `secrets-collector`
 * Zone 5 walker (Plan 01) already added both fields to the warm-up set
 * that `SecretsResolver.preResolveAll` resolves at boot — this helper
 * substitutes the cached value into the resolved agent config so
 * VoiceManager.join() reads a literal API key instead of an op:// URI.
 *
 * Behaviour:
 *   - No resolver → passthrough (test / offline tool).
 *   - Non-op:// value → passthrough (literal secret in yaml — still
 *     permitted by `voiceConfigSchema` for local dev; production
 *     should always use op://).
 *   - op:// value + resolver → resolver invoked; throws on failure
 *     (Phase 999.10 loud-fail invariant — bad ref = agent doesn't
 *     start).
 */
export function resolveVoiceKey(
  raw: string,
  opRefResolver: OpRefResolver | undefined,
  ctx: { readonly agentName: string; readonly fieldName: "deepgramKey" | "elevenLabsKey" },
): string {
  const interpolated = resolveEnvVars(raw);
  if (!opRefResolver || !isOpRef(interpolated)) {
    return interpolated;
  }
  try {
    return opRefResolver(interpolated);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to resolve 1Password reference for agents[${ctx.agentName}].voice.${ctx.fieldName} (${interpolated}): ${message}`,
      { cause: err instanceof Error ? err : undefined },
    );
  }
}

/**
 * Phase 94 TOOL-10 / D-10 — resolved directive shape.
 *
 * Carries only what the prompt assembler needs: the directive's stable key
 * (used for ordering + downstream telemetry) and its verbatim text. The
 * `enabled` flag is folded into filtering — disabled directives are
 * dropped from the resolver output entirely so consumers never see them.
 */
export interface ResolvedDirective {
  readonly key: string;
  readonly text: string;
}

/**
 * Phase 94 TOOL-10 / D-10 — per-key merge of agent override over fleet
 * defaults, returning the enabled directives in deterministic order.
 *
 * Pure function — no I/O, no clock, no SDK. Safe to call per-turn from
 * the prompt assembler. Returns a frozen array of frozen objects so
 * downstream code can't mutate either the list or its entries
 * (CLAUDE.md immutability invariant).
 *
 * Merge logic:
 *   for each key in {keys(defaults) ∪ keys(agentOverride)}:
 *     enabled = override?.enabled ?? defaults?.enabled ?? false
 *     text    = override?.text    ?? defaults?.text    ?? ""
 *     keep iff enabled && text !== ""
 *   sort by key (alphabetical) for prompt-cache hash stability.
 *
 * Per-key merge means an operator can disable the file-sharing directive
 * for one agent without dropping the cross-agent-routing directive — the
 * unspecified default flows through. This is the contract pinned by
 * REG-OVERRIDE-PARTIAL.
 */
export function resolveSystemPromptDirectives(
  agentOverride:
    | Record<string, { enabled?: boolean; text?: string }>
    | undefined,
  defaults: Record<string, SystemPromptDirective>,
): readonly ResolvedDirective[] {
  const keys = new Set<string>([
    ...Object.keys(defaults),
    ...Object.keys(agentOverride ?? {}),
  ]);

  const merged: { key: string; text: string }[] = [];
  for (const key of keys) {
    const d = defaults[key];
    const o = agentOverride?.[key];
    const enabled = o?.enabled ?? d?.enabled ?? false;
    const text = o?.text ?? d?.text ?? "";
    if (enabled && text !== "") {
      merged.push({ key, text });
    }
  }

  // Deterministic alphabetical order — required for prompt-cache hash
  // stability. Same input must produce byte-identical output across
  // processes (REG-DETERMINISTIC).
  merged.sort((a, b) => a.key.localeCompare(b.key));

  return Object.freeze(
    merged.map((m) => Object.freeze({ key: m.key, text: m.text })),
  );
}

/**
 * Phase 94 TOOL-10 — render the resolved directive list into the verbatim
 * text block prepended to the assembler's stable prefix.
 *
 * Returns "" when no directives are enabled (REG-ASSEMBLER-EMPTY-WHEN-
 * DISABLED — operators who opt out of every default see a clean stable
 * prefix WITHOUT marker comments, deterministic for prompt-cache hash).
 *
 * Block format: directive texts joined by "\n\n" (one blank line between
 * adjacent directives). No XML wrappers, no marker headings — the LLM
 * sees plain operator instructions at the start of its context.
 */
export function renderSystemPromptDirectiveBlock(
  directives: readonly ResolvedDirective[],
): string {
  if (directives.length === 0) return "";
  return directives.map((d) => d.text).join("\n\n");
}

/**
 * Phase 999.13 DELEG-02 — canonical text constants for the per-agent
 * "Specialist Delegation" directive. Constants live here (next to the
 * Phase 94 directive renderer) so static-grep regression tests pin the
 * verbatim wording against silent drift.
 *
 * Block format when rendered (single specialty example):
 *   ## Specialist Delegation
 *   For tasks matching a specialty below, delegate via the spawn-subagent-thread skill:
 *   - research → fin-research
 *   Verify the target is at opus/high before delegating; if mismatch, surface to operator and stop. The subthread posts its summary back to your channel when done.
 *
 * NEVER paraphrase. The Wave 0 RED test `delegates-canonical-text` pins
 * these constants byte-exactly.
 */
export const DELEGATES_DIRECTIVE_HEADER =
  "## Specialist Delegation\nFor tasks matching a specialty below, delegate via the spawn-subagent-thread skill:";
export const DELEGATES_DIRECTIVE_FOOTER =
  "Verify the target is at opus/high before delegating; if mismatch, surface to operator and stop. The subthread posts its summary back to your channel when done.";

/**
 * Phase 999.13 DELEG-02 / DELEG-04 — render the per-agent specialty →
 * target-agent map into the canonical "## Specialist Delegation" block
 * appended at the END of the assembler's stable prefix.
 *
 * Returns "" when delegates is undefined OR `{}` — empty short-circuits
 * with NO header, NO whitespace pollution. This is critical for prompt-
 * cache hash stability: agents without delegates render byte-identically
 * to the no-delegates baseline (CA-FS-2 / REG-DETERMINISTIC analog).
 *
 * Specialty keys are sorted alphabetically — required for prompt-cache
 * hash stability across daemon boots (Object.keys insertion order is not
 * spec-guaranteed for non-integer keys; explicit sort matches the
 * `resolveSystemPromptDirectives` pattern at line 653).
 */
export function renderDelegatesBlock(
  delegates: Readonly<Record<string, string>> | undefined,
): string {
  if (!delegates) return "";
  const keys = Object.keys(delegates);
  if (keys.length === 0) return "";
  // Alphabetical sort — required for prompt-cache hash stability (REG-DETERMINISTIC).
  keys.sort();
  const lines = keys.map((k) => `- ${k} → ${delegates[k]}`);
  return [
    DELEGATES_DIRECTIVE_HEADER,
    ...lines,
    DELEGATES_DIRECTIVE_FOOTER,
  ].join("\n");
}

/**
 * Phase 96 D-05 — resolve fileAccess paths for an agent.
 *
 * Merges defaults + per-agent override (additive — agent paths APPEND to
 * defaults), expands the literal `{agent}` token to the actual agent name,
 * canonicalizes via path.resolve (collapses `..`, no leading relative),
 * and deduplicates.
 *
 * NOTE: this helper does NOT perform fs.realpath (no I/O at this layer).
 * The runFsProbe primitive (src/manager/fs-probe.ts) handles realpath at
 * probe time; resolveFileAccess only handles syntactic canonicalization.
 *
 * @param agentName    Concrete agent name (substituted into `{agent}` token)
 * @param agentCfg     Per-agent override (may omit `fileAccess`)
 * @param defaultsCfg  Fleet-wide default (always populated by zod default)
 * @returns Deduplicated readonly array of canonical absPaths
 */
export function resolveFileAccess(
  agentName: string,
  agentCfg: { readonly fileAccess?: readonly string[] } | undefined,
  defaultsCfg: { readonly fileAccess?: readonly string[] } | undefined,
): readonly string[] {
  const merged = [
    ...(defaultsCfg?.fileAccess ?? []),
    ...(agentCfg?.fileAccess ?? []),
  ];
  const expanded = merged.map((p) => p.replace(/\{agent\}/g, agentName));
  const canonical = expanded.map((p) => pathResolve(p));
  return Array.from(new Set(canonical));
}

/**
 * Phase 96 D-09 — resolve outputDir template for an agent.
 *
 * Returns the LITERAL template string (per-agent override beats defaults;
 * else fallback to 'outputs/{date}/'). Loader does NOT expand tokens —
 * runtime resolveOutputDir(template, ctx, deps) expands at write time
 * with fresh per-call ctx. Loader-time expansion would freeze {date} at
 * config-load time (wrong on the second day) and would pin {client_slug}
 * to the load-time value (wrong across multiple client conversations).
 *
 * Distinct from src/manager/resolve-output-dir.ts:resolveOutputDir — this
 * loader helper just merges templates; the runtime helper expands them.
 *
 * @param _agentName   Agent name (currently unused — reserved for future
 *                     {agent}-token expansion if needed at loader layer)
 * @param agentCfg     Per-agent override (may omit `outputDir`)
 * @param defaultsCfg  Fleet-wide default (always populated by zod default)
 * @returns The merged outputDir template string (tokens preserved verbatim)
 */
export function resolveOutputDirTemplate(
  _agentName: string,
  agentCfg: { readonly outputDir?: string } | undefined,
  defaultsCfg: { readonly outputDir?: string } | undefined,
): string {
  return agentCfg?.outputDir ?? defaultsCfg?.outputDir ?? "outputs/{date}/";
}

// ---------------------------------------------------------------------------
// Phase 117 Plan 06 — advisor resolvers (per-agent → defaults → baseline).
//
// Mirror the inner `resolveRuntime` fall-through pattern at :392 and the
// module-level `resolveOutputDirTemplate` style above (`agent ??
// defaults ?? baseline`). Each function is exported because the call sites
// live in OTHER files shipped by later plans in this phase:
//   - Plan 117-04: `src/manager/session-adapter.ts` reads
//     resolveAdvisorModel(agent, defaults) to wire `Options.advisorModel`.
//   - Plan 117-07: `src/manager/daemon.ts` ask-advisor IPC handler reads
//     resolveAdvisorBackend(agent, defaults) to gate dispatch (native vs
//     fork) at the IPC boundary.
//   - Plan 117-08: capability manifest reads the same backend to surface
//     it on the per-agent capability surface.
//   - Plan 117-04/07: resolveAdvisorMaxUsesPerRequest sets the per-agent
//     budget cap; resolveAdvisorCaching feeds the Anthropic prompt-cache
//     toggle (enabled+ttl) wired into Options at session create/resume.
//
// Type guard on backend: the resolver narrows to `"native" | "fork"` (the
// SCHEMA's enum) even though `BackendId` in `src/advisor/types.ts` admits
// `"portable-fork"`. That third value is rejected at schema parse time
// (Plan 117-06 T05), so it can never reach this resolver from a loaded
// config. The defensive narrowing (`v === "fork" ? "fork" : "native"`)
// guards against future type drift between BackendId and the schema enum.
//
// Hardcoded baselines:
//   - backend:           "native" (Phase 117 spec — the swap is the upgrade)
//   - model:             "opus"   (SDK alias; resolveAdvisorModel in
//                                  `src/manager/model-resolver.ts` from
//                                  Plan 117-02 canonicalises at call time)
//   - maxUsesPerRequest: 3        (Anthropic example budget)
//   - caching:           {enabled:true, ttl:"5m"} (Anthropic-recommended
//                                  for ≥3 advisor calls per conversation)
// ---------------------------------------------------------------------------

/**
 * Resolve the advisor backend for an agent. Falls through:
 *   per-agent.advisor.backend → defaults.advisor.backend → "native".
 *
 * Returns the schema-narrowed enum `"native" | "fork"`. The third
 * `BackendId` value `"portable-fork"` is rejected at config parse time
 * (Plan 117-05/118 scaffold), so this resolver never returns it.
 */
export function resolveAdvisorBackend(
  agent: { advisor?: { backend?: string } } | undefined,
  defaults: { advisor?: { backend?: string } } | undefined,
): "native" | "fork" {
  const v = agent?.advisor?.backend ?? defaults?.advisor?.backend ?? "native";
  return v === "fork" ? "fork" : "native";
}

/**
 * Resolve the advisor model alias for an agent. Falls through:
 *   per-agent.advisor.model → defaults.advisor.model → "opus".
 *
 * The string is the operator-supplied alias (e.g. `"opus"`, `"sonnet"`)
 * NOT the canonical SDK id. Plan 117-02's resolver in
 * `src/manager/model-resolver.ts` canonicalises `"opus"` →
 * `"claude-opus-4-8"` at the SDK call site.
 */
export function resolveAdvisorModel(
  agent: { advisor?: { model?: string } } | undefined,
  defaults: { advisor?: { model?: string } } | undefined,
): string {
  return agent?.advisor?.model ?? defaults?.advisor?.model ?? "opus";
}

/**
 * Resolve the per-request advisor call budget for an agent. Falls through:
 *   per-agent.advisor.maxUsesPerRequest →
 *     defaults.advisor.maxUsesPerRequest → 3.
 *
 * Schema enforces range 1–10 at parse time, so any value reaching this
 * resolver is in-range. Plan 117-04/07 consumers gate dispatch on this
 * count before each invocation; once exhausted within a single user
 * request, the IPC handler returns a budget-error to the model.
 */
export function resolveAdvisorMaxUsesPerRequest(
  agent: { advisor?: { maxUsesPerRequest?: number } } | undefined,
  defaults: { advisor?: { maxUsesPerRequest?: number } } | undefined,
): number {
  return (
    agent?.advisor?.maxUsesPerRequest ??
    defaults?.advisor?.maxUsesPerRequest ??
    3
  );
}

/**
 * Resolve the advisor prompt-cache toggle for an agent. Falls through
 * per-field — `enabled` and `ttl` are resolved independently so an
 * operator can override one without re-specifying the other:
 *   enabled: per-agent → defaults → true
 *   ttl:     per-agent → defaults → "5m"
 *
 * Anthropic's recommended default for ≥3 advisor invocations per
 * conversation; see Phase 117 CONTEXT.md.
 */
export function resolveAdvisorCaching(
  agent:
    | { advisor?: { caching?: { enabled?: boolean; ttl?: "5m" | "1h" } } }
    | undefined,
  defaults:
    | { advisor?: { caching?: { enabled?: boolean; ttl?: "5m" | "1h" } } }
    | undefined,
): { enabled: boolean; ttl: "5m" | "1h" } {
  return {
    enabled:
      agent?.advisor?.caching?.enabled ??
      defaults?.advisor?.caching?.enabled ??
      true,
    ttl:
      agent?.advisor?.caching?.ttl ?? defaults?.advisor?.caching?.ttl ?? "5m",
  };
}

/**
 * Phase 124 Plan 02 D-06 — resolve the auto-compaction trigger ratio for an
 * agent. Falls through:
 *   per-agent['auto-compact-at'] → defaults['auto-compact-at'] → 0.7.
 *
 * Schema enforces range 0..1 at parse time, so any value reaching this
 * resolver is in-range. Plan 125 consumes the resolved value to decide
 * when to fire auto-compaction; Phase 124 only ships the schema + this
 * resolver so `clawcode reload` picks up YAML edits without a daemon
 * restart (the loader re-resolves on every config-watcher fire).
 */
export function resolveAutoCompactAt(
  agent: { "auto-compact-at"?: number } | undefined,
  defaults: { "auto-compact-at"?: number } | undefined,
): number {
  return (
    agent?.["auto-compact-at"] ??
    defaults?.["auto-compact-at"] ??
    0.7
  );
}

/**
 * Resolve the per-agent OS-sandbox config. Falls through:
 *   agents.*.sandbox → defaults.sandbox → {enabled:false, allowRuntimeOp:false}.
 *
 * Object-level fallback (NOT field-level merge): a per-agent `sandbox` block
 * fully replaces the defaults block — matching how operators reason about a
 * security toggle ("this agent is sandboxed, with these knobs"). Schema
 * `.default(false)` fills omitted sub-fields within whichever block wins.
 * NON_RELOADABLE — the resolved plan is frozen into the spawn at boot.
 */
export function resolveSandbox(
  agent: { sandbox?: { enabled?: boolean; allowRuntimeOp?: boolean } } | undefined,
  defaults: { sandbox?: { enabled?: boolean; allowRuntimeOp?: boolean } } | undefined,
): { enabled: boolean; allowRuntimeOp: boolean } {
  const src = agent?.sandbox ?? defaults?.sandbox;
  return {
    enabled: src?.enabled ?? false,
    allowRuntimeOp: src?.allowRuntimeOp ?? false,
  };
}

/**
 * Phase 125 Plan 02 — resolve the per-agent verbatim-gate count. Cascades
 * agent → defaults → 10 (Phase 125 BACKLOG-SOURCE Tier 1 default).
 */
export function resolvePreserveLastTurns(
  agent: { preserveLastTurns?: number } | undefined,
  defaults: { preserveLastTurns?: number } | undefined,
): number {
  return agent?.preserveLastTurns ?? defaults?.preserveLastTurns ?? 10;
}

/**
 * Phase 125 Plan 02 (SC-8) — compile per-agent verbatim regex patterns once
 * at config-resolve. Invalid regex throws (caller surfaces as a config-load
 * error, NOT a silent at-runtime failure). The merge is per-agent-overrides-
 * defaults (full replacement, not concatenation — matches the cascade
 * convention used elsewhere in this loader).
 */
export function resolvePreserveVerbatimPatterns(
  agent: { preserveVerbatimPatterns?: readonly string[] } | undefined,
  defaults: { preserveVerbatimPatterns?: readonly string[] } | undefined,
): readonly RegExp[] | undefined {
  const raw = agent?.preserveVerbatimPatterns ?? defaults?.preserveVerbatimPatterns;
  if (!raw || raw.length === 0) return undefined;
  const compiled: RegExp[] = [];
  for (const p of raw) {
    try {
      compiled.push(new RegExp(p));
    } catch (err) {
      throw new Error(
        `preserveVerbatimPatterns: invalid regex ${JSON.stringify(p)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return Object.freeze(compiled);
}

/**
 * Check if a file exists at the given path.
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
