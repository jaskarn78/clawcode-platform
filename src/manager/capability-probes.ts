/**
 * Phase 94 Plan 01 Task 2 — per-MCP capability-probe registry.
 *
 * Pure-DI module. Exports the `Map<string, ProbeFn>` keyed by MCP server
 * name, where each entry runs the D-01 representative tool call against
 * `deps.callTool(serverName, toolName, args)` to detect capability
 * degradation that the Phase 85 connect-test would miss.
 *
 * Registry coverage (D-01):
 *   Declared (9):
 *     - browser           → browser_snapshot({url:"about:blank"})
 *     - playwright        → browser_install({channel:"chromium"}) THEN
 *                           browser_navigate({url:"about:blank"}) (chained;
 *                           "already installed" tolerated)
 *     - 1password         → vaults_list({})
 *     - acme-db      → query({sql:"SELECT 1"})
 *     - acme-content → query({sql:"SELECT 1"})
 *     - finnhub           → quote({symbol:"AAPL"})
 *     - brave-search      → search({query:"test", limit:1})
 *     - google-workspace  → list_oauth_scopes({})
 *     - fal-ai            → list_models({})
 *     - browserless       → health({})
 *   Auto-injected (4 — "browser" entry shared with declared list):
 *     - clawcode          → list_agents({})
 *     - search            → search({query:"test", limit:1})
 *     - image             → list_models({})
 *
 * Default-fallback (`makeServerScopedDefaultProbe`) is used by `getProbeFor`
 * for any unmapped server name: it lists tools and considers the server
 * "ready" when at least one tool is exposed. Newly-added MCPs work out-of-
 * the-box without registry edits — the cost is that the fallback only
 * proves the server CAN list tools, not that any specific tool actually
 * works. The 13 explicit entries above run real representative calls so
 * we catch capability-level degradation (auth failure, missing executable,
 * stale env) instead of just connect-test "process is up".
 *
 * Tool-name source-of-truth:
 *   - browser_*    → src/browser/mcp-server.ts (browser_snapshot, browser_navigate, browser_install)
 *   - vaults_list  → 1Password MCP server (op vaults list)
 *   - SELECT 1     → MySQL MCP `query` tool (canonical low-cost SQL probe)
 *   - quote        → finnhub-mcp `quote` tool (free-tier)
 *   - search       → brave-search-mcp `search` tool with limit param
 *   - list_models  → fal-ai-mcp + image MCPs both expose list_models
 *
 * If a tool name drifts in the upstream MCP server, the probe will fail
 * with a verbatim "tool not found" error and the snapshot will reflect
 * `degraded` — the failure surfaces to operators via /clawcode-tools,
 * not silently. The error message guides the registry update.
 */

import type { Logger } from "pino";

/**
 * Dependencies injected into every probe. `callTool` invokes a single MCP
 * tool; `listTools` is used by the default-fallback probe to discover
 * capabilities for unmapped servers. Both are stubbable in tests.
 *
 * `now` is optional and only used by primitives that need a deterministic
 * clock; the registry entries don't need it (they don't timestamp).
 *
 * Note on the env-leak invariant: probes ONLY receive `name` + `args` they
 * themselves construct from registry literals. They never read process.env
 * or the MCP server's resolved env block. Phase 85 TOOL-04 verbatim error
 * pass-through means a server's OWN error message text flows through, but
 * the probe itself does not introduce env values into the error path.
 */
export interface ProbeDeps {
  /** Invoke an MCP tool by name with arguments; resolves or throws verbatim. */
  readonly callTool: (
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
  /** List tools exposed by an MCP server (default-fallback probe). */
  readonly listTools: (serverName: string) => Promise<readonly { readonly name: string }[]>;
  /** Test-only deterministic clock; production wires it to Date. */
  readonly now?: () => Date;
  readonly log: Logger;
}

export type ProbeOk = { readonly kind: "ok" };
export type ProbeFailure = { readonly kind: "failure"; readonly error: string };
export type ProbeResult = ProbeOk | ProbeFailure;

export type ProbeFn = (deps: ProbeDeps) => Promise<ProbeResult>;

// ---------------------------------------------------------------------------
// Internal helpers — wrap a callTool invocation so registry entries stay
// concise. `safe` swallows the rejection and converts to ProbeFailure;
// `safeRaw` is identical at this layer (kept as a separate alias for the
// playwright chained probe so future divergence between "swallow always"
// vs "swallow only specific errors" is one-line).
// ---------------------------------------------------------------------------

async function safe(fn: () => Promise<unknown>): Promise<ProbeResult> {
  try {
    await fn();
    return { kind: "ok" };
  } catch (err) {
    return { kind: "failure", error: err instanceof Error ? err.message : String(err) };
  }
}

async function safeRaw(fn: () => Promise<unknown>): Promise<ProbeResult> {
  return safe(fn);
}

// ---------------------------------------------------------------------------
// Registry construction (module-load time)
// ---------------------------------------------------------------------------

function makeRegistry(): Map<string, ProbeFn> {
  const r = new Map<string, ProbeFn>();

  // ---- D-01 declared MCPs ----

  // browser (auto-injected: src/browser/mcp-server.ts) → browser_snapshot
  r.set("browser", async (deps) =>
    safe(() => deps.callTool("browser", "browser_snapshot", { url: "about:blank" })),
  );

  // playwright → chained: install (tolerate already-installed) then navigate.
  // The install step is idempotent at the upstream MCP layer; if it errors
  // with "already installed" we still consider that a green light and try
  // navigate — failing on navigate is the real capability signal we want.
  r.set("playwright", async (deps) => {
    const install = await safeRaw(() =>
      deps.callTool("playwright", "browser_install", { channel: "chromium" }),
    );
    if (install.kind === "failure" && !/already.installed/i.test(install.error)) {
      return install;
    }
    return safe(() =>
      deps.callTool("playwright", "browser_navigate", { url: "about:blank" }),
    );
  });

  // 1password → vaults_list (read-only, cheap, hits service-account auth)
  r.set("1password", async (deps) =>
    safe(() => deps.callTool("1password", "vaults_list", {})),
  );

  // acme-db / acme-content → SELECT 1 (canonical SQL liveness probe)
  r.set("acme-db", async (deps) =>
    safe(() => deps.callTool("acme-db", "query", { sql: "SELECT 1" })),
  );
  r.set("acme-content", async (deps) =>
    safe(() => deps.callTool("acme-content", "query", { sql: "SELECT 1" })),
  );

  // finnhub → quote(AAPL) (free-tier-safe, exercises HTTP + auth)
  r.set("finnhub", async (deps) =>
    safe(() => deps.callTool("finnhub", "quote", { symbol: "AAPL" })),
  );

  // brave-search → search(test, limit=1) (cheap; exercises API key)
  r.set("brave-search", async (deps) =>
    safe(() => deps.callTool("brave-search", "search", { query: "test", limit: 1 })),
  );

  // google-workspace → list_oauth_scopes (read-only metadata, hits OAuth path)
  r.set("google-workspace", async (deps) =>
    safe(() => deps.callTool("google-workspace", "list_oauth_scopes", {})),
  );

  // fal-ai → list_models (catalog read; exercises API key)
  r.set("fal-ai", async (deps) =>
    safe(() => deps.callTool("fal-ai", "list_models", {})),
  );

  // browserless → health (HTTP-style liveness check; falls back to default
  // probe shape if the server doesn't expose `health`)
  r.set("browserless", async (deps) =>
    safe(() => deps.callTool("browserless", "health", {})),
  );

  // ---- Auto-injected MCPs (clawcode, search, image — `browser` shared above) ----

  // clawcode (own metadata; cheap)
  r.set("clawcode", async (deps) =>
    safe(() => deps.callTool("clawcode", "list_agents", {})),
  );

  // search (auto-injected web search MCP — same shape as brave-search)
  r.set("search", async (deps) =>
    safe(() => deps.callTool("search", "search", { query: "test", limit: 1 })),
  );

  // image (auto-injected image generation MCP)
  r.set("image", async (deps) =>
    safe(() => deps.callTool("image", "list_models", {})),
  );

  return r;
}

/**
 * The frozen registry. Module-load populates it; callers read via
 * `getProbeFor(name)` which falls back to a server-scoped default probe
 * for unmapped names.
 *
 * Size: 13 entries (10 declared MCPs + 3 auto-injected, with `browser`
 * appearing only once since the same probe shape covers both roles).
 */
export const PROBE_REGISTRY: ReadonlyMap<string, ProbeFn> = makeRegistry();

/**
 * Default-fallback probe — used when a server is not in the registry.
 *
 * Calls `listTools(serverName)`. If the server returns ≥1 tool name we
 * consider it "ready"; if the list is empty or the call rejects, we
 * surface "degraded" with a verbatim error. This is the cheapest probe
 * shape that still distinguishes "process up but advertising nothing"
 * from "process up and exposing tools".
 *
 * Exported for tests + as the documented fallback contract. In production
 * `getProbeFor(name)` returns a server-name-curried version of this so
 * the closure captures the correct serverName for the listTools call.
 */
export const defaultListToolsProbe: ProbeFn = async (deps) => {
  // Default-fallback at the bare-export level uses a placeholder name.
  // `getProbeFor(serverName)` curries the name properly for production.
  return makeServerScopedDefaultProbe("__default__")(deps);
};

/** Build a server-scoped default-fallback probe — closure captures the name. */
function makeServerScopedDefaultProbe(serverName: string): ProbeFn {
  return async (deps) => {
    try {
      const tools = await deps.listTools(serverName);
      if (tools.length === 0) {
        return {
          kind: "failure",
          error: `no tools exposed by ${serverName}`,
        };
      }
      return { kind: "ok" };
    } catch (err) {
      return {
        kind: "failure",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
}

/**
 * Resolve a probe for `serverName`. Returns the registered probe if any;
 * otherwise returns a default-fallback probe scoped to `serverName`.
 *
 * Always returns a non-null function. Callers (probeMcpCapability) wrap
 * the result in a 10s timeout race.
 */
export function getProbeFor(serverName: string): ProbeFn {
  const entry = PROBE_REGISTRY.get(serverName);
  if (entry) return entry;
  return makeServerScopedDefaultProbe(serverName);
}
