/**
 * Single source of truth for child-spawn env credential handling.
 *
 * Every child process the daemon spawns (agent SDK sessions, one-shot
 * `claude` helpers, MCP servers, `op` CLI calls) composes its environment
 * through `buildAnthropicSafeEnv`, so the credential policy lives in one
 * place.
 *
 * ## Credential invariant
 *
 * The ambient `ANTHROPIC_API_KEY` is stripped from the inherited
 * `process.env`. Children fall through to OAuth subscription credentials
 * instead of silently billing a metered API key. The only way to keep a key
 * in the returned env is an explicit `extraEnv.ANTHROPIC_API_KEY`.
 *
 * ## extraEnv-spread-last contract
 *
 * `extraEnv` spreads AFTER the strip, so an explicit value always wins. This
 * matters for an MCP server configured like:
 *
 *     mcpServers:
 *       anthropic:
 *         command: npx
 *         args: [-y, "@anthropic-ai/anthropic-mcp"]
 *         env:
 *           ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
 *
 * The config loader expands `${VAR}` before this helper runs, so the call is
 * `buildAnthropicSafeEnv({ ANTHROPIC_API_KEY: "<resolved>" })`. Spreading
 * `extraEnv` before the strip would silently drop the key such a server
 * requires.
 */

import {
  ALLOW_CLAUDEAI_CONNECTORS_ENV_KEY,
  CLAUDEAI_CONNECTORS_DISABLED_ENV,
  CLAUDEAI_CONNECTORS_ENABLED_ENV,
} from "../shared/claudeai-connectors.js";

export function buildAnthropicSafeEnv(
  extraEnv?: Readonly<Record<string, string | undefined>>,
  opts?: {
    // claude.ai connector entitlement. ONLY buildCleanEnv (agent SDK sessions)
    // passes it, from the loader-derived entitlement.
    readonly claudeAiConnectors?: boolean;
  },
): Record<string, string | undefined> {
  const { ANTHROPIC_API_KEY: _stripped, ...base } = process.env;

  const composed = extraEnv ? { ...base, ...extraEnv } : base;
  // Spread LAST so neither an ambient ENABLE_CLAUDEAI_MCP_SERVERS=true nor an
  // extraEnv value can change it: an entitled session gets an explicit enable,
  // everything else the forced disable, unless the named daemon switch is on.
  if (opts?.claudeAiConnectors === true) {
    return { ...composed, ...CLAUDEAI_CONNECTORS_ENABLED_ENV };
  }
  if (process.env[ALLOW_CLAUDEAI_CONNECTORS_ENV_KEY] === "1") return composed;
  return { ...composed, ...CLAUDEAI_CONNECTORS_DISABLED_ENV };
}
