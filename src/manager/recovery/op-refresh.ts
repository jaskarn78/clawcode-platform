/**
 * Phase 94 Plan 03 — D-05 pattern 2: op:// auth-error refresh recovery.
 *
 * Trigger: error matches op:// auth-error regex (not authorized, service
 * account expired, token expired). Action: re-run `op read` for every
 * op:// reference in the server's env, swap the resolved env back via
 * deps.writeEnvForServer. SDK respawns subprocess on env update OR caller
 * follows up with subprocess-restart.
 *
 * DI-pure: opRead + readEnvForServer + writeEnvForServer all come in via
 * deps. Production wires real `op` CLI invocation at the daemon edge.
 */

import type { RecoveryHandler, RecoveryOutcome } from "./types.js";

/**
 * Match op:// references that are auth-related. The pattern is intentionally
 * permissive — D-05 spec lists three known auth-error fingerprints from the
 * 1Password CLI:
 *   - "op://example-vault-3 authorized"
 *   - "op://example-vault-4 account" (expired credential)
 *   - "op://example-vault-5 expired"
 */
const OP_AUTH_RE =
  /op:\/\/.*not authorized|op:\/\/.*service account|op:\/\/.*token expired/i;

/**
 * Pattern that extracts op:// references from env values. Captures the
 * fully-qualified reference shape: `op://<vault>/<item>/<field>`.
 */
const OP_REF_RE = /op:\/\/[a-zA-Z0-9_\-/]+/g;

export const opRefreshHandler: RecoveryHandler = {
  name: "op-refresh",
  priority: 20,
  matches(error: string): boolean {
    return OP_AUTH_RE.test(error);
  },
  async recover(serverName, deps): Promise<RecoveryOutcome> {
    const startNow = (deps.now ?? (() => new Date()))();
    const startMs = startNow.getTime();
    try {
      const env = deps.readEnvForServer(serverName);
      const newEnv: Record<string, string> = {};
      let resolvedCount = 0;
      for (const [key, value] of Object.entries(env)) {
        if (typeof value !== "string") {
          // Defensive — env values should always be strings. Pass through.
          newEnv[key] = value as unknown as string;
          continue;
        }
        if (!value.includes("op://")) {
          // Literal env value — pass through unchanged (immutability).
          newEnv[key] = value;
          continue;
        }
        const refs = value.match(OP_REF_RE) ?? [];
        if (refs.length === 0) {
          newEnv[key] = value;
          continue;
        }
        // Re-resolve every op:// reference. Replace verbatim into the value
        // string (handles both bare "op://..." and embedded "Bearer op://..."
        // shapes).
        let resolved = value;
        for (const ref of refs) {
          // Phase 999.10 plan 03 (SEC-05) — drop the cached value FIRST.
          // The whole reason this handler is firing is that the value the
          // MCP child received was stale (auth-error). If deps.opRead is
          // backed by SecretsResolver (production wiring), it would
          // otherwise hit the cache and serve back the same stale value.
          // The optional `?.` keeps pre-999.10 deps (without invalidate)
          // working unchanged — see REC-OP-REFRESH-INV-02 back-compat test.
          deps.invalidate?.(ref);
          const fresh = await deps.opRead(ref);
          resolved = resolved.replace(ref, fresh);
          resolvedCount++;
        }
        newEnv[key] = resolved;
      }
      await deps.writeEnvForServer(serverName, newEnv);
      const endMs = (deps.now ?? (() => new Date()))().getTime();
      return {
        kind: "recovered",
        serverName,
        handlerName: "op-refresh",
        durationMs: Math.max(0, endMs - startMs),
        note: `op:// references re-resolved (${resolvedCount} refs)`,
      };
    } catch (err) {
      // op read failed (CLI unauthenticated / network / ref doesn't exist)
      // OR writeEnvForServer failed (config write error). Either way, a
      // transient retry probably won't help — terminal give-up. Operator
      // sees the verbatim error in the recovery ledger + admin alert.
      const reason = err instanceof Error ? err.message : String(err);
      return {
        kind: "give-up",
        serverName,
        handlerName: "op-refresh",
        reason,
      };
    }
  },
};
