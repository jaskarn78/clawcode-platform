/**
 * The Claude Code CLI auto-loads the logged-in claude.ai account's connectors
 * (Gmail, Drive, Calendar, Docs, Strava…) as `mcp__claude_ai_*` tools in EVERY
 * session, regardless of `settingSources: []`. The CLI skips that load when
 * this env var is defined-falsy, so every spawned `claude` env carries it.
 * Leaf module (no imports) so any spawn path can use it without an import chain.
 */
export const CLAUDEAI_CONNECTORS_DISABLED_ENV: Readonly<Record<string, string>> = {
  ENABLE_CLAUDEAI_MCP_SERVERS: "false",
};

/**
 * Explicit enable for an ENTITLED agent session (owner allowed, not admin).
 * Only `buildCleanEnv` may pass the entitlement — see the static sentinel.
 */
export const CLAUDEAI_CONNECTORS_ENABLED_ENV: Readonly<Record<string, string>> = {
  ENABLE_CLAUDEAI_MCP_SERVERS: "true",
};

/** Daemon-env rollback switch: `=1` stops the forced disable (connectors load again). */
export const ALLOW_CLAUDEAI_CONNECTORS_ENV_KEY = "CLAWCODE_ALLOW_CLAUDEAI_CONNECTORS";
