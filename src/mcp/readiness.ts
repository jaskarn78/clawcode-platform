import { checkMcpServerHealth } from "./health.js";

/**
 * Minimal MCP server shape consumed by the readiness handshake.
 *
 * Accepts both the zod-inferred `McpServerSchemaConfig` (mutable fields)
 * AND `ResolvedAgentConfig.mcpServers[number]` (all-readonly). The only
 * fields the probe needs are `name`, `command`, `args`, `env`, `optional`.
 */
type ReadinessMcpServer = {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly optional?: boolean;
};

/**
 * Phase 85 Plan 01 — MCP readiness handshake (TOOL-01 + TOOL-04).
 *
 * Pure module that runs JSON-RPC `initialize` against every configured
 * MCP server in parallel (via `checkMcpServerHealth`), classifies each
 * result into ready/failed, and partitions failures into mandatory
 * (gate-blocking) vs optional (advisory).
 *
 * Used by:
 *   - `src/manager/warm-path-check.ts` (the warm-path gate wires this as
 *     `mcpProbe` so the agent stays in `starting` → `failed` when any
 *     mandatory MCP can't respond to `initialize`).
 *   - `src/heartbeat/checks/mcp-reconnect.ts` (the v1.3 heartbeat re-runs
 *     this every tick to detect flaps and drive reconnect transitions).
 *
 * Invariants:
 *   - TOOL-04 pass-through: the error string from `checkMcpServerHealth`
 *     flows into `lastError.message` + the scoped `errors[]` entry
 *     verbatim. No "tool unavailable" wrapping. No rewording. Operators
 *     see the real failure.
 *   - Empty input short-circuits: zero configured servers → `ready:true`
 *     with empty `stateByName`. Never spawns anything.
 *   - No logger dep. No side effects beyond `checkMcpServerHealth` spawns.
 *     Keeps the module unit-testable without mocking a logger.
 */

/**
 * Per-server MCP state tracked by the readiness handshake and (in the
 * heartbeat reconnect path) persisted across ticks.
 *
 * `status` transitions:
 *   ready ↔ degraded     (first flap from ready → degraded)
 *   degraded → failed    (still unhealthy after first-flap tick)
 *   failed → reconnecting → ready  (recovery path — next success flips straight to ready)
 *
 * `failureCount` is the rolling last-N counter the `/clawcode-tools`
 * command reads; `MCP_FAILURE_WINDOW` bounds it. Reset on any success.
 */
/**
 * Phase 94 Plan 01 D-02 — extended status vocabulary for the capability probe.
 *
 * Phase 85's `McpServerState.status` ("ready"|"degraded"|"failed"|"reconnecting")
 * describes connect-test health; this is the orthogonal capability-probe axis,
 * tracking whether a representative tool call against the server actually
 * succeeds. Filter (Plan 94-02) reads this field to decide which tools to
 * surface to the LLM; recovery (Plan 94-03) reads it to pick handlers.
 *
 * The 5-value enum is locked at the contract layer — adding a 6th value
 * cascades through 4 downstream consumers (94-02/03/04/07) and requires
 * an explicit STATE.md decision.
 *
 * Status meanings:
 *   "ready"        — connect ok AND representative call succeeded
 *   "degraded"     — connect ok BUT representative call failed (we know HOW it's broken)
 *   "reconnecting" — connect-test currently transient — bridge state, brief
 *   "failed"       — connect-test itself failed — process down or unreachable
 *   "unknown"      — not yet probed (boot pre-warm-path)
 */
export type CapabilityProbeStatus =
  | "ready"
  | "degraded"
  | "reconnecting"
  | "failed"
  | "unknown";

/**
 * Phase 94 Plan 01 — per-server capability probe snapshot.
 *
 * Persisted alongside the connect-test fields on McpServerState. `error`
 * carries the verbatim transport error (Phase 85 TOOL-04 pass-through);
 * `lastSuccessAt` is sticky across degraded ticks so operators can read
 * "last known good" even when the current probe failed.
 */
export interface CapabilityProbeSnapshot {
  /** ISO8601 — when this probe last ran. */
  readonly lastRunAt: string;
  /** Current capability status (D-02 5-value enum). */
  readonly status: CapabilityProbeStatus;
  /** Verbatim error message from the failed probe (Phase 85 TOOL-04). */
  readonly error?: string;
  /** ISO8601 — most recent ready outcome; preserved across degraded ticks. */
  readonly lastSuccessAt?: string;
}

export type McpServerState = {
  readonly name: string;
  readonly status: "ready" | "degraded" | "failed" | "reconnecting";
  readonly lastSuccessAt: number | null;
  readonly lastFailureAt: number | null;
  readonly lastError: { readonly code?: number; readonly message: string } | null;
  readonly failureCount: number;
  readonly optional: boolean;
  /**
   * Phase 94 Plan 01 — capability probe snapshot. Additive-optional; legacy
   * Phase 85 callers that read McpServerState without consulting this field
   * continue to compile + execute unchanged. Populated by the heartbeat
   * tick's probe orchestrator (src/manager/capability-probe.ts) and on
   * boot via the warm-path gate.
   */
  readonly capabilityProbe?: CapabilityProbeSnapshot;
};

export type McpReadinessReport = {
  /** True iff every mandatory server's status === "ready". */
  readonly ready: boolean;
  readonly stateByName: ReadonlyMap<string, McpServerState>;
  /** Mandatory failures only — these block the warm-path gate. */
  readonly errors: readonly string[];
  /** Optional failures — advisory only, warn-logged by the caller. */
  readonly optionalErrors: readonly string[];
};

/**
 * Default per-server handshake timeout (ms) for the STEADY-STATE path.
 *
 * Used by the heartbeat `mcp-reconnect` check (every 60s), where every
 * MCP server is already warm and answers `initialize` in <100ms. 5s is
 * ample headroom there, and the heartbeat check itself has a hard 20s
 * per-tick budget — a longer per-server timeout would risk blowing it.
 *
 * NOTE: this is intentionally SHORTER than `checkMcpServerHealth`'s own
 * 30s default (src/mcp/health.ts) — the readiness handshake passes this
 * value explicitly, overriding that default. The COLD warm-path gate
 * must NOT use this constant; see `MCP_HANDSHAKE_TIMEOUT_WARMPATH_MS`.
 */
export const MCP_HANDSHAKE_TIMEOUT_MS = 5000;

/**
 * Per-server handshake timeout (ms) for the COLD warm-path gate.
 *
 * The warm-path readiness gate runs at agent boot AND on every warm-path
 * recovery restart. The mandatory `clawcode` MCP server it probes is
 * `command:"clawcode" args:["mcp"]` (config/loader.ts) — a cold Node.js
 * process that boots the full clawcode CLI commander tree, then
 * dynamic-imports the MCP SDK. It is NOT the static Go shim. Under a
 * warm-path RECOVERY (host carrying recovery-storm load) a cold Node
 * boot reproducibly exceeds the 5s steady-state window — the 2026-05-21
 * fin-client incident, where recovery attempts 2 & 3 both failed
 * with "Health check timed out after 5000ms".
 *
 * 20s gives a cold `clawcode mcp` boot generous headroom under load
 * while still failing loudly if the server is genuinely wedged. A
 * genuinely DEAD server (binary missing / crash-on-boot / non-zero
 * exit) fails IMMEDIATELY via `checkMcpServerHealth`'s spawn-error and
 * process-exit branches — independent of this timeout. The timeout only
 * governs the slow-but-alive case, which is exactly the warm-restart
 * latency recovery must survive.
 */
export const MCP_HANDSHAKE_TIMEOUT_WARMPATH_MS = 20_000;

/**
 * Rolling failure window consulted by `/clawcode-tools` for the
 * "last-N consecutive failures" counter. Single source of truth so the
 * heartbeat and the CLI agree on the same bound.
 */
export const MCP_FAILURE_WINDOW = 20;

export type PerformMcpReadinessHandshakeOptions = {
  /** Override the per-server handshake timeout. Defaults to MCP_HANDSHAKE_TIMEOUT_MS. */
  readonly timeoutMs?: number;
  /** Test-only epoch-ms source for deterministic timestamps. */
  readonly now?: () => number;
};

/**
 * Run JSON-RPC `initialize` handshakes against `servers` in parallel.
 *
 * Each `checkMcpServerHealth` call times out on its own; the wrapper
 * aggregates results, partitions errors by mandatory/optional, and
 * returns a frozen report. Safe to call with an empty array (short-
 * circuits without spawning anything).
 */
export async function performMcpReadinessHandshake(
  servers: readonly ReadinessMcpServer[],
  opts: PerformMcpReadinessHandshakeOptions = {},
): Promise<McpReadinessReport> {
  const timeoutMs = opts.timeoutMs ?? MCP_HANDSHAKE_TIMEOUT_MS;
  const now = opts.now ?? (() => Date.now());
  const stateByName = new Map<string, McpServerState>();
  const errors: string[] = [];
  const optionalErrors: string[] = [];

  if (servers.length === 0) {
    return Object.freeze({
      ready: true,
      stateByName,
      errors: Object.freeze([]) as readonly string[],
      optionalErrors: Object.freeze([]) as readonly string[],
    });
  }

  const results = await Promise.all(
    servers.map((s) => checkMcpServerHealth(s, timeoutMs)),
  );

  for (let i = 0; i < servers.length; i++) {
    const s = servers[i]!;
    const r = results[i]!;
    const ts = now();
    const isOptional = s.optional === true;

    if (r.healthy) {
      stateByName.set(
        s.name,
        Object.freeze({
          name: s.name,
          status: "ready",
          lastSuccessAt: ts,
          lastFailureAt: null,
          lastError: null,
          failureCount: 0,
          optional: isOptional,
        }),
      );
      continue;
    }

    // TOOL-04 — preserve the verbatim error message. checkMcpServerHealth
    // is a transport-level probe so it does not carry a JSON-RPC error
    // code; leave `code` undefined. When tool-call failure wiring lands
    // in a future plan, that path WILL populate `code` from the RPC
    // envelope on every failure branch.
    const msg = r.error ?? "unknown error";
    const scoped = `mcp: ${s.name}: ${msg}`;
    stateByName.set(
      s.name,
      Object.freeze({
        name: s.name,
        status: "failed",
        lastSuccessAt: null,
        lastFailureAt: ts,
        lastError: Object.freeze({ message: msg }),
        failureCount: 1,
        optional: isOptional,
      }),
    );

    if (isOptional) {
      optionalErrors.push(scoped);
    } else {
      errors.push(scoped);
    }
  }

  return Object.freeze({
    ready: errors.length === 0,
    stateByName,
    errors: Object.freeze([...errors]) as readonly string[],
    optionalErrors: Object.freeze([...optionalErrors]) as readonly string[],
  });
}
