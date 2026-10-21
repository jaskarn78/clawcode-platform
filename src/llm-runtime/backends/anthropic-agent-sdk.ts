/**
 * `AnthropicAgentSdkBackend` — current production runtime, extracted
 * from `src/manager/session-adapter.ts:loadSdk` (lines 1407–1426).
 *
 * Phase 136: this is the ONLY file in `src/` outside its own
 * `__tests__/` that's permitted to `await import("@anthropic-ai/
 * claude-agent-sdk")`. Enforced by the static-grep CI test at
 * `src/llm-runtime/__tests__/static-grep-no-direct-sdk.test.ts`
 * (T-06). Every other call site goes through `LlmRuntimeService.
 * loadSdkModule()`.
 *
 * **Caching contract** (load-bearing): the module reference is
 * cached at the class instance level. The daemon constructs one
 * `AnthropicAgentSdkBackend` per agent at boot via
 * `createLlmRuntimeService`, so per-agent caches share the
 * underlying Node ESM dynamic-import cache (one process-wide module
 * object) and we keep memory flat — same effective behaviour as
 * the previous `let cachedSdk: SdkModule | null = null;` at
 * `session-adapter.ts:1407`.
 *
 * **Error message verbatim:** the not-installed error message is
 * the exact string the previous `loadSdk()` threw — preserved so
 * operator-facing error matchers (CI smoke tests, dashboards) keep
 * working.
 *
 * Phase 137 adds `AnthropicApiKeyBackend` alongside this file. The
 * shape is identical (`loadSdkModule()` returns an
 * `LlmRuntimeSdkModule`); Phase 137 swaps the underlying transport
 * from the bundled Agent SDK CLI binary to direct API-key auth via
 * `@anthropic-ai/sdk`.
 */

import type { ResolvedAgentConfig } from "../../shared/types.js";
import { resolveClaudeBinary } from "../../shared/claude-binary.js";
import type {
  LlmRuntimeDeps,
  LlmRuntimeService,
  LlmRuntimeSdkModule,
} from "../types.js";

/**
 * claude.ai connectors (Gmail, Drive, Docs, Strava, …) are OFF unless a session
 * opts in. Without `ENABLE_CLAUDEAI_MCP_SERVERS=false` the CLI auto-loads the
 * operator's connectors as tools in EVERY agent session — `settingSources: []`
 * does not stop it (verified in prod transcripts, including the acme
 * agents). Entitled agents opt in by setting the key explicitly in their
 * session env (e.g. "true"); an explicit value is never overridden here.
 */
export const CLAUDEAI_CONNECTORS_ENV = "ENABLE_CLAUDEAI_MCP_SERVERS";

/**
 * Phase 999.169 — pin by construction. Every `query` that leaves this
 * chokepoint:
 *   - without `pathToClaudeCodeExecutable` gets the fleet binary
 *     (`resolveClaudeBinary()`: the SDK's own bundled binary, or the explicit
 *     `CLAWCODE_CLAUDE_BIN` override). Per-call-site pin spreads are gone, so a
 *     new spawn site cannot forget the pin — the 2026-06-01 and 2026-09-23
 *     outages were both a site that forgot.
 *   - has claude.ai connectors OFF by default: `ENABLE_CLAUDEAI_MCP_SERVERS`
 *     is set to "false" unless the caller's env sets it explicitly (entitled
 *     agents opt in with "true" — left untouched). The SDK builds the child env
 *     as `options.env ? {...options.env} : {...process.env}` (a provided env
 *     REPLACES process.env), so a provided env is kept whole plus the default,
 *     and an absent env becomes `{...process.env, key: "false"}` — exactly what
 *     the SDK would have inherited, plus the default.
 *
 * Resolution happens per call so a missing binary fails that spawn loudly
 * (`ClaudeBinaryNotFoundError`) instead of the SDK silently picking a
 * different one.
 */
export function withPinnedClaudeBinary(
  sdk: LlmRuntimeSdkModule,
  resolvePath: () => string = () => resolveClaudeBinary().path,
): LlmRuntimeSdkModule {
  const query: LlmRuntimeSdkModule["query"] = (params) => {
    const options = params.options ?? {};
    const explicit = typeof options.env?.[CLAUDEAI_CONNECTORS_ENV] === "string";
    const env = explicit
      ? options.env
      : { ...(options.env ?? process.env), [CLAUDEAI_CONNECTORS_ENV]: "false" };
    const pinned = options.pathToClaudeCodeExecutable ?? resolvePath();
    return sdk.query({ ...params, options: { ...options, env, pathToClaudeCodeExecutable: pinned } });
  };
  return { ...sdk, query };
}

/**
 * Module-level cache shared across all `AnthropicAgentSdkBackend`
 * instances in this process AND every free-function consumer of
 * `loadAnthropicAgentSdkModule()`. Node's dynamic-import cache
 * already deduplicates the module — this cache exists so we resolve
 * the Promise<LlmRuntimeSdkModule> exactly once per process and
 * avoid the SdkModule-shape cast per call.
 *
 * Type intentionally widened to `unknown` at import time then cast
 * to `LlmRuntimeSdkModule` on first resolve — matches the pre-
 * existing pattern at `src/manager/session-adapter.ts:1419`
 * (`cachedSdk = sdk as unknown as SdkModule`).
 */
let cachedModule: LlmRuntimeSdkModule | null = null;

/**
 * Free-function chokepoint for the Anthropic Agent SDK dynamic
 * import.
 *
 * The class-based `AnthropicAgentSdkBackend.loadSdkModule()`
 * delegates here. Legacy call sites (`session-adapter.ts:loadSdk`,
 * `daemon.ts` compaction triggers, `openai/endpoint-bootstrap.ts`)
 * also call this directly during the Phase 136 migration, before
 * Phase 137 threads `LlmRuntimeService` through DI for those sites.
 *
 * Exporting both shapes keeps the migration patch small (T-04
 * touches only the 4 import lines, not the surrounding wiring) while
 * preserving the future-pattern: Phase 137 callers receive an
 * `LlmRuntimeService` reference and call `service.loadSdkModule()`.
 * The free function is the back-compat ramp.
 */
export async function loadAnthropicAgentSdkModule(): Promise<LlmRuntimeSdkModule> {
  if (cachedModule) {
    return cachedModule;
  }
  try {
    // The ONLY @anthropic-ai/claude-agent-sdk import in src/
    // outside __tests__/. Static-grep CI test (T-06) enforces.
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    cachedModule = withPinnedClaudeBinary(sdk as unknown as LlmRuntimeSdkModule);
    return cachedModule;
  } catch {
    // Verbatim error message from the prior loadSdk() at
    // src/manager/session-adapter.ts:1422 — operator-facing string
    // preserved so existing error matchers keep working.
    throw new Error(
      "Claude Agent SDK is not installed. Run: npm install @anthropic-ai/claude-agent-sdk",
    );
  }
}

export class AnthropicAgentSdkBackend implements LlmRuntimeService {
  readonly backendId = "anthropic-agent-sdk" as const;

  constructor(
    /**
     * Stored for Phase 137+ — the API-key backend reads
     * `config.llmRuntime.backend === "anthropic-api-key"` to pick
     * its auth path. Phase 136 doesn't read this field but keeps it
     * for backend-introspection in tests + future construction-site
     * symmetry.
     */
    private readonly config: ResolvedAgentConfig,
    /**
     * Reserved for Phase 138 credit-telemetry logging.
     */
    private readonly deps: LlmRuntimeDeps,
  ) {
    // Reference both fields to satisfy --noUnusedParameters even
    // when neither is used today. Cheap, explicit, no behaviour.
    void this.config;
    void this.deps;
  }

  async loadSdkModule(): Promise<LlmRuntimeSdkModule> {
    return loadAnthropicAgentSdkModule();
  }
}

/**
 * Test-only reset hook. Vitest call sites reset the module-level
 * cache between specs so a fresh `import()` resolves under
 * `vi.mock("@anthropic-ai/claude-agent-sdk", ...)`.
 *
 * NOT exported through `../index.ts` — strictly an internal test
 * affordance. Phase 137 keeps this pattern for its own backend
 * tests.
 */
export function __resetCachedModuleForTests(): void {
  cachedModule = null;
}
