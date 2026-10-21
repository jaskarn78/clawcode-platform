/**
 * Phase 100 follow-up — resolve op:// URIs in MCP env overrides at agent-start
 * via 1Password CLI shell-out.
 *
 * Daemon-only path: uses the daemon's process OP_SERVICE_ACCOUNT_TOKEN
 * (clawdbot, full-fleet scope) to fetch a NARROWER vault-scoped service
 * account token (e.g., a Acme-only SA token whose source-of-truth is
 * stored as a credential in the clawdbot vault). The resolved value is
 * injected into the spawned MCP subprocess; the daemon's full-scope token
 * never leaves the daemon process.
 *
 * Why a separate resolver and not the existing config/loader.ts opRefResolver:
 *   - The config-load resolver is sync (`execSync`) and runs once at boot
 *     for shared mcpServers[].env. The override resolver is async, per-
 *     agent, runs at agent-start, and layers on top of the already-resolved
 *     defaults.mcpServers env so the ACME token replaces the clawdbot
 *     token before subprocess spawn.
 *   - DI-pure (opRead injectee) keeps the resolver unit-testable without a
 *     live `op` CLI. Production wires `child_process.spawn("op", ["read",
 *     uri])` at the daemon edge — see daemon.ts.
 *
 * Security invariants:
 *   - Resolved secret values NEVER appear in log lines (only envKey + opUri,
 *     both of which are operator-controlled config, not secrets).
 *   - Empty resolution throws (defense in depth — a zero-length token would
 *     silently flip the agent into "fail open" mode where the MCP child
 *     subprocess inherits literally nothing for OP_SERVICE_ACCOUNT_TOKEN).
 *   - Resolution failure throws — agent should fail to start rather than
 *     fall back to the daemon's full-scope token.
 */

import { buildAnthropicSafeEnv } from "./spawn-env.js";

/**
 * Strict op:// reference matcher. Mirrors the shape used elsewhere in the
 * codebase but tighter on what counts as a valid path component (vault and
 * item names may contain spaces, mixed case, hyphens, underscores; the
 * field component is a single segment after the last `/`).
 *
 * Accepts: `op://example-vault-21/Acme Service Account/credential`
 * Rejects: `op://`, `op://example-vault-26`, `not-an-op-ref`
 */
const OP_REF_RE = /^op:\/\/[A-Za-z0-9_\- /]+(?:\/[A-Za-z0-9_\- ]+)+$/;

export type OpReadFn = (uri: string) => Promise<string>;

export interface ResolveDeps {
  readonly opRead: OpReadFn;
  readonly log?: {
    readonly warn: (...args: unknown[]) => void;
    readonly info: (...args: unknown[]) => void;
  };
}

/**
 * Resolve `op://...` references inside per-server env override maps.
 *
 * Input shape: `{ [serverName]: { [envKey]: value } }` where `value` is
 * either an `op://` URI or a literal pass-through string.
 *
 * Output shape: same keys, with op:// values replaced by the result of
 * `deps.opRead(uri)`. Literal values pass through unchanged.
 *
 * @throws if any opRead invocation rejects, returns an empty string, or if
 *   the override map is malformed (defensive — schema layer rejects most of
 *   these but the resolver is also DI-callable from tests).
 */
export async function resolveMcpEnvOverrides(
  overrides: Record<string, Record<string, string>>,
  deps: ResolveDeps,
): Promise<Record<string, Record<string, string>>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [serverName, envMap] of Object.entries(overrides)) {
    out[serverName] = {};
    for (const [envKey, value] of Object.entries(envMap)) {
      if (OP_REF_RE.test(value)) {
        let resolved: string;
        try {
          resolved = await deps.opRead(value);
        } catch (err) {
          // Wrapping layer carries the OP URI (operator config — not a
          // secret) for debuggability. The underlying err.message MAY echo
          // CLI noise but never carries a successful resolution result
          // (we wrap before opRead returns anything useful).
          const reason = err instanceof Error ? err.message : String(err);
          throw new Error(
            `Failed to resolve op:// reference for MCP env override ${serverName}.${envKey}=${value}: ${reason}`,
            { cause: err instanceof Error ? err : undefined },
          );
        }
        if (!resolved || resolved.length === 0) {
          throw new Error(
            `Failed to resolve op:// reference for MCP env override ${serverName}.${envKey}=${value}: op read returned empty string`,
          );
        }
        out[serverName]![envKey] = resolved;
        // Audit log: structured fields ONLY. NEVER include the resolved
        // secret value — operator can correlate via journalctl using
        // (agentName via caller) + envKey + opUri.
        deps.log?.info(
          {
            serverName,
            envKey,
            opUri: value,
            resolved: true,
            resolvedAt: new Date().toISOString(),
          },
          "op-env-resolver: resolved op:// reference",
        );
      } else {
        // Literal value — pass through unchanged (immutable copy).
        out[serverName]![envKey] = value;
      }
    }
  }
  return out;
}

/**
 * Production opRead implementation — shells out to the 1Password CLI via
 * `child_process.spawn("op", ["read", uri])`. The daemon's process env
 * (which carries the clawdbot OP_SERVICE_ACCOUNT_TOKEN) is inherited so
 * the `op` CLI authenticates as the daemon's service account.
 *
 * Zero new dependencies — uses Node's built-in `node:child_process` per
 * the operator constraint (no execa, no @1password/sdk).
 *
 * Timeout: 10s (matches the existing config-load defaultOpRefResolver
 * pattern). Trims trailing newline.
 *
 * @throws on any failure (op CLI missing, not signed in, item / field not
 *   found, timeout). Caller wraps with envKey context.
 */
export function defaultOpReadShellOut(uri: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Lazy require to keep the module pure-import safe in tests.
    void import("node:child_process")
      .then(({ spawn }) => {
        const proc = spawn("op", ["read", uri], {
          // Phase 999.87 — credential isolation. `op` CLI doesn't talk to
          // Anthropic; the strip still applies as
          // defense-in-depth (no inherited ANTHROPIC_API_KEY in the
          // subprocess env). The daemon's OP_SERVICE_ACCOUNT_TOKEN
          // survives because the helper never strips it.
          env: buildAnthropicSafeEnv(),
          // Inherit stdio for auth interactivity? No — the daemon's SA
          // token is in env, no interactive prompt is expected. Pipe
          // stdout/stderr so we capture failure reasons.
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
          proc.kill("SIGKILL");
          reject(new Error(`op read timed out after 10s for ${uri}`));
        }, 10_000);
        proc.stdout?.on("data", (b: Buffer) => {
          stdout += b.toString();
        });
        proc.stderr?.on("data", (b: Buffer) => {
          stderr += b.toString();
        });
        proc.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        proc.on("close", (code) => {
          clearTimeout(timer);
          if (code !== 0) {
            reject(
              new Error(`op read exited ${code}: ${stderr.trim() || "(no stderr)"}`),
            );
          } else {
            resolve(stdout.trim());
          }
        });
      })
      .catch(reject);
  });
}

/**
 * INC-2026-08-08 — production `op service-account ratelimit` shell-out.
 *
 * Sibling of `defaultOpReadShellOut` above and deliberately its twin: SAME env
 * construction (`buildAnthropicSafeEnv()` — no proxy, ANTHROPIC_API_KEY
 * stripped, the daemon's OP_SERVICE_ACCOUNT_TOKEN preserved so `op`
 * authenticates as the daemon's service account), SAME 10s SIGKILL timeout,
 * SAME stderr-on-nonzero error shape. Only the argv differs, so env behaviour
 * stays single-sourced across every `op` invocation the daemon makes.
 *
 * Returns RAW stdout — parsing lives in `ratelimit-monitor-cron.ts` so this
 * stays a thin, mockable process seam.
 *
 * NOT routed through the on-box `op-cached` wrapper: that funnel is a
 * URI-keyed cache for `op read`, and `service-account ratelimit` has no URI
 * and is not a read.
 */
export function defaultOpRatelimitShellOut(): Promise<string> {
  return new Promise((resolve, reject) => {
    // Lazy require to keep the module pure-import safe in tests.
    void import("node:child_process")
      .then(({ spawn }) => {
        const proc = spawn("op", ["service-account", "ratelimit"], {
          env: buildAnthropicSafeEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
          proc.kill("SIGKILL");
          reject(new Error("op service-account ratelimit timed out after 10s"));
        }, 10_000);
        proc.stdout?.on("data", (b: Buffer) => {
          stdout += b.toString();
        });
        proc.stderr?.on("data", (b: Buffer) => {
          stderr += b.toString();
        });
        proc.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        proc.on("close", (code) => {
          clearTimeout(timer);
          if (code !== 0) {
            reject(
              new Error(
                `op service-account ratelimit exited ${code}: ${stderr.trim() || "(no stderr)"}`,
              ),
            );
          } else {
            // NOT trimmed — the parser is line-oriented and trims per line.
            resolve(stdout);
          }
        });
      })
      .catch(reject);
  });
}
