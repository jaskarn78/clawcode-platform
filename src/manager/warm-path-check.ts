import type { EmbeddingService } from "../memory/embedder.js";

/**
 * Phase 56 Plan 01 — composite warm-path readiness check.
 *
 * Aggregates three per-agent signals into one pass/fail verdict:
 *   1. SQLite + sqlite-vec warmup (via `deps.sqliteWarm`).
 *   2. `EmbeddingService.isReady()` + one probe `embed` call.
 *   3. Session plumbing (optional `deps.sessionProbe` — Plan 02 threads a
 *      real session check; Plan 01 defaults to no-op "always ready").
 *
 * Wrapped in a `WARM_PATH_TIMEOUT_MS` (30s) overall budget. On timeout,
 * returns `ready:false` with `errors=["timeout after 30000ms"]`.
 *
 * Never throws — always returns a `WarmPathResult`. Caller (Plan 02)
 * inspects `result.ready` to decide whether to mark the agent `running`.
 *
 * All returned structures are frozen to match the project-wide readonly
 * contract (see `coding-style.md`).
 */

/**
 * Overall warm-path budget (ms).
 *
 * Must comfortably exceed the COLD MCP handshake timeout
 * (`MCP_HANDSHAKE_TIMEOUT_WARMPATH_MS` = 20s, run inside Step 5's
 * `mcpProbe`) PLUS headroom for the sqlite / embedder / session /
 * browser steps. Raised 10s → 30s on 2026-05-21: the old 10s budget
 * would race-kill the work before a cold `clawcode mcp` boot could
 * finish its handshake under warm-path-recovery load — the
 * fin-client recovery-loop incident.
 */
export const WARM_PATH_TIMEOUT_MS = 30_000;

export type WarmPathDurations = {
  readonly sqlite: number;
  readonly embedder: number;
  readonly session: number;
  /**
   * Phase 70 Plan 03 — duration of the optional browser readiness probe.
   * Records 0 when no `browserProbe` dep is supplied.
   */
  readonly browser: number;
  /**
   * Phase 85 Plan 01 TOOL-01 — duration of the optional MCP readiness
   * handshake. Records 0 when no `mcpProbe` dep is supplied.
   */
  readonly mcp: number;
};

export type WarmPathResult = {
  readonly ready: boolean;
  readonly durations_ms: WarmPathDurations;
  readonly total_ms: number;
  readonly errors: readonly string[];
};

export type WarmPathDeps = {
  readonly agent: string;
  readonly sqliteWarm: (
    agent: string,
  ) => Promise<{ memories_ms: number; usage_ms: number; traces_ms: number }>;
  readonly embedder: Pick<EmbeddingService, "isReady" | "embed">;
  /**
   * Optional session probe — Plan 02 wires a real check; when absent, the
   * session step is a no-op and records 0ms.
   */
  readonly sessionProbe?: () => Promise<void>;
  /**
   * Phase 70 Plan 03 — optional browser readiness probe. When provided,
   * the warm-path runs it after the session probe; a failure contributes
   * to the `errors` array and sets `ready:false`, matching the existing
   * sqlite/embedder/session probe pattern. Absent probe means no-op +
   * `durations_ms.browser === 0`.
   */
  readonly browserProbe?: () => Promise<void>;
  /**
   * Phase 85 Plan 01 TOOL-01 — optional MCP readiness handshake probe.
   * Returns an `errors` array of pre-scoped (`mcp: <name>: <reason>`)
   * strings that are pushed verbatim into the composite `errors[]`.
   * Only mandatory-server failures should appear in this list — the
   * caller partitions mandatory vs optional upstream. Absent probe
   * means no-op + `durations_ms.mcp === 0`.
   */
  readonly mcpProbe?: () => Promise<{ readonly errors: readonly string[] }>;
  /** Override timeout for tests. Defaults to `WARM_PATH_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
};

/**
 * Run the composite warm-path readiness check.
 *
 * The implementation splits the work into three sequential steps (sqlite,
 * embedder probe, session probe) and races the entire sequence against a
 * timeout. Each step catches its own error and pushes a scoped message
 * into `errors` so partial failures are attributable.
 */
export async function runWarmPathCheck(
  deps: WarmPathDeps,
): Promise<WarmPathResult> {
  const timeoutMs = deps.timeoutMs ?? WARM_PATH_TIMEOUT_MS;
  const startedAt = performance.now();
  const errors: string[] = [];
  let sqliteMs = 0;
  let embedderMs = 0;
  let sessionMs = 0;
  let browserMs = 0;
  let mcpMs = 0;

  const work = (async () => {
    // Step 1 — SQLite + sqlite-vec warmup.
    try {
      const r = await deps.sqliteWarm(deps.agent);
      sqliteMs = r.memories_ms + r.usage_ms + r.traces_ms;
    } catch (e) {
      errors.push(`sqlite: ${(e as Error).message}`);
    }

    // Step 2 — Embedder readiness + single probe call.
    const embStart = performance.now();
    try {
      if (!deps.embedder.isReady()) {
        errors.push("embedder: not ready");
      } else {
        await deps.embedder.embed("warmup probe");
      }
    } catch (e) {
      errors.push(`embedder: ${(e as Error).message}`);
    }
    embedderMs = performance.now() - embStart;

    // Step 3 — Session probe (Plan 02 wires real value).
    const sessStart = performance.now();
    try {
      if (deps.sessionProbe) await deps.sessionProbe();
    } catch (e) {
      errors.push(`session: ${(e as Error).message}`);
    }
    sessionMs = performance.now() - sessStart;

    // Step 4 — Phase 70 browser probe. Optional: when defaults.browser
    // .warmOnBoot=true the daemon passes an isReady() check; otherwise
    // absent and browserMs stays 0.
    const browserStart = performance.now();
    try {
      if (deps.browserProbe) await deps.browserProbe();
    } catch (e) {
      errors.push(`browser: ${(e as Error).message}`);
    }
    browserMs = deps.browserProbe ? performance.now() - browserStart : 0;

    // Step 5 — Phase 85 Plan 01 TOOL-01 MCP readiness handshake probe.
    // Optional dep; SessionManager wires it when the agent has MCP
    // servers configured. Returned error strings are already scoped
    // (`mcp: <name>: <reason>`) so we push them verbatim into `errors`.
    // Note: this probe never throws — it returns its errors explicitly.
    // If somehow it does throw (defensive), capture the exception with
    // the same `mcp:` prefix so operators still see an mcp-scoped line.
    const mcpStart = performance.now();
    try {
      if (deps.mcpProbe) {
        const { errors: mcpErrors } = await deps.mcpProbe();
        for (const e of mcpErrors) errors.push(e);
      }
    } catch (e) {
      errors.push(`mcp: ${(e as Error).message}`);
    }
    mcpMs = deps.mcpProbe ? performance.now() - mcpStart : 0;
  })();

  let timedOut = false;
  let timerHandle: NodeJS.Timeout | undefined;
  await Promise.race([
    work,
    new Promise<void>((resolve) => {
      timerHandle = setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeoutMs);
    }),
  ]);
  if (timerHandle) clearTimeout(timerHandle);

  if (timedOut) errors.push(`timeout after ${timeoutMs}ms`);

  const total_ms = performance.now() - startedAt;
  const ready = errors.length === 0;

  return Object.freeze({
    ready,
    durations_ms: Object.freeze({
      sqlite: sqliteMs,
      embedder: embedderMs,
      session: sessionMs,
      browser: browserMs,
      mcp: mcpMs,
    }),
    total_ms,
    errors: Object.freeze([...errors]) as readonly string[],
  });
}
