/**
 * Phase 137 Plan 01 — `CodexAgentCli` SHELL backend.
 *
 * Implements `LlmRuntimeService` so the Phase 136 factory can dispatch
 * `config.llmRuntime.backend === "codex-cli"` to a real constructor.
 * Every method that does real work throws a documented Plan-03
 * deferral error — Plans 02–05 fill those in:
 *   - Plan 02: translation layer (Anthropic ↔ Codex message shape).
 *   - Plan 03: stdio spawn + Query synthesis.
 *   - Plan 04: per-provider credentials.
 *   - Plan 05: end-to-end production wiring.
 *
 * **What Plan 01 DOES do:**
 *   1. Resolves the codex binary path at construction via
 *      `discoverCliBinary` (3-tier: explicit → PATH → commonPaths).
 *      The Promise is stored on the instance; discovery is fire-and-
 *      forget at construction so daemon boot doesn't block on the
 *      probe. The first `loadSdkModule()` call awaits it — that's
 *      where misconfig surfaces with the operator-actionable
 *      `CliBinaryNotFoundError` listing every checked path.
 *   2. Emits one `phase137-codex-backend` structured log line per
 *      construction so operators can grep journalctl during the
 *      Plan 02–05 rollout. Mirrors the Phase 136
 *      `phase136-llm-runtime` cadence (one line per factory call).
 *   3. Exposes the canonical default `commonPaths` array
 *      (`CODEX_DEFAULT_COMMON_PATHS`) for Plan 03 tests + operator
 *      documentation.
 *
 * **What Plan 01 does NOT do:**
 *   - Spawn the codex binary (Plan 03).
 *   - Translate Anthropic message shape (Plan 02).
 *   - Stream tokens or tool calls (Plan 03).
 *   - Map provider errors (Plan 03 / 04).
 *   - Thread the service into session-adapter (Phase 138+).
 *
 * Threat model: see 137-01-PLAN.md `<threat_model>`. No new attack
 * surface in Plan 01 — discovery is a read-only filesystem probe + a
 * `which`-via-execFile call against an operator-controlled binary
 * name (constant `"codex"`).
 *
 * See:
 *   - `../discovery.ts` — the 3-tier resolution algorithm.
 *   - `../llm-runtime-service.ts` — factory switch case.
 *   - `137-01-PLAN.md` T-03 — behavior + test expectations.
 */

import { homedir } from "node:os";
import path from "node:path";

import type { ResolvedAgentConfig } from "../../shared/types.js";
import type {
  LlmRuntimeDeps,
  LlmRuntimeSdkModule,
  LlmRuntimeService,
} from "../types.js";
import {
  discoverCliBinary,
  type DiscoverCliBinaryDeps,
} from "../discovery.js";
import {
  CodexSdkModule,
} from "./codex-sdk-module.js";
import {
  createDefaultCodexQueryDeps,
  type CodexQueryDeps,
} from "./codex-query.js";
import type { OpenAiCredentialsResolver } from "../credentials/openai-credentials.js";

/**
 * Default tier-3 fallback paths probed when neither
 * `config.llmRuntime.codex.pathToCodexExecutable` nor `which codex`
 * resolves. Order matters — `/usr/local/bin/codex` first (the OpenAI
 * Codex installer default on Linux/macOS), then the user-local
 * fallback. Frozen so callers can pass the constant directly without
 * copying.
 *
 * researcher_todo (137-01-PLAN.md): homebrew on macOS installs to
 * `/opt/homebrew/bin/codex`. Plan 03's research pass should verify
 * the canonical install path on each supported platform and widen
 * this list if needed. For now the two entries cover the documented
 * cases.
 */
export const CODEX_DEFAULT_COMMON_PATHS: readonly string[] = Object.freeze([
  "/usr/local/bin/codex",
  path.join(homedir(), ".local", "bin", "codex"),
  // researcher_todo: verify homebrew path on macOS — /opt/homebrew/bin/codex
]);

/**
 * The Codex CLI backend. Plan 01 is a SHELL — methods that drive the
 * wire throw a documented deferral error. Construction is fully
 * implemented (discovery + telemetry) so the factory dispatch can
 * cross the threshold from "unselectable" to "selectable but inert."
 */
export class CodexAgentCli implements LlmRuntimeService {
  readonly backendId = "codex-cli" as const;

  /**
   * Discovery probe promise. Started at construction (fire-and-
   * forget) so daemon boot isn't blocked by `which` execution. The
   * first call to `loadSdkModule()` awaits this; if discovery threw
   * `CliBinaryNotFoundError`, that error surfaces there with the
   * full `.checked` list.
   */
  private readonly binaryPathPromise: Promise<string>;

  /**
   * Phase 137 Plan 03 T-03 — per-instance CodexSdkModule cache.
   *
   * The first `loadSdkModule()` call awaits discovery + constructs
   * the module; subsequent calls return the cached reference.
   * Mirrors the `AnthropicAgentSdkBackend` cache contract — one
   * module per agent per process. Each `module.query()` still
   * spawns a fresh `codex` child (the cache is on the module shell,
   * not on the conversation).
   */
  private cachedSdkModule: CodexSdkModule | null = null;

  /**
   * Phase 137 Plan 03 T-03 — query-deps injection seam.
   *
   * Production passes `createDefaultCodexQueryDeps(deps.logger)`
   * which uses `node:child_process.spawn` + real `nanoid`.
   * Integration tests inject a vitest-friendly stub here so the
   * full `loadSdkModule → query → spawn` chain runs without a real
   * binary on disk.
   */
  private readonly queryDeps: CodexQueryDeps;

  constructor(
    private readonly config: ResolvedAgentConfig,
    private readonly deps: LlmRuntimeDeps,
    /**
     * Optional discovery deps for unit tests. Production callers
     * (the factory) leave this undefined and pick up the production
     * defaults (`fs.existsSync` + `which`-via-`execFile`) in
     * `discoverCliBinary`.
     */
    private readonly discoveryDeps?: DiscoverCliBinaryDeps,
    /**
     * Phase 137 Plan 03 T-03 — optional query-deps injection. The
     * factory (production) leaves this undefined; the
     * codex-agent-cli-integration.test.ts integration test passes a
     * mocked `spawnFn` so the full path runs without a real codex
     * binary on disk.
     */
    queryDeps?: CodexQueryDeps,
  ) {
    const explicitPath = config.llmRuntime?.codex?.pathToCodexExecutable;
    const telemetry = {
      agent: config.name,
      backend: "codex-cli" as const,
      model: config.model,
      explicitPath,
    };
    if (deps.logger) {
      deps.logger.info(telemetry, "phase137-codex-backend");
    } else {
      // eslint-disable-next-line no-console
      console.info("phase137-codex-backend", JSON.stringify(telemetry));
    }

    // Kick off discovery. We deliberately do NOT await — the daemon
    // boot path must not block on `which`. The first `loadSdkModule`
    // call awaits this. Attach a no-op `.catch` so the unhandled-
    // rejection trap doesn't fire when an operator misconfigures the
    // path and the test never calls `loadSdkModule` (e.g., construction-
    // only tests). The real error surfaces when `loadSdkModule()`
    // awaits and re-throws.
    this.binaryPathPromise = discoverCliBinary(
      {
        binaryName: "codex",
        explicitPath,
        commonPaths: CODEX_DEFAULT_COMMON_PATHS,
      },
      discoveryDeps,
    );
    // Swallow the unhandled-rejection signal — the promise is
    // observed via `loadSdkModule()` when (and if) called.
    this.binaryPathPromise.catch(() => {});

    // Phase 137 Plan 03 T-03 — capture queryDeps. Production picks
    // up the default (spawn + nanoid) when the caller (factory)
    // doesn't inject; tests pass a mocked spawnFn.
    this.queryDeps =
      queryDeps ?? createDefaultCodexQueryDeps(deps.logger);
  }

  /**
   * Phase 137 Plan 03 T-03 — returns a working CodexSdkModule.
   *
   * Replaces the Plan-01 deferral error. The first call awaits
   * `binaryPathPromise` (Plan 01 discovery), constructs the module,
   * caches it, and returns. Subsequent calls return the cached
   * reference — one CodexSdkModule per CodexAgentCli per process,
   * mirroring the AnthropicAgentSdkBackend cache contract.
   *
   * Discovery errors (`CliBinaryNotFoundError`) surface here on
   * first call, NOT during construction (daemon boot stays
   * non-blocking — see file header for the rationale).
   */
  async loadSdkModule(): Promise<LlmRuntimeSdkModule> {
    if (this.cachedSdkModule) {
      return this.cachedSdkModule;
    }

    // Phase 137 Plan 04 T-03 — operator-actionable assertion.
    //
    // When this backend is selected (codex-cli), the daemon's
    // per-agent factory loop MUST construct an
    // `OpenAiCredentialsResolver` and thread it through
    // `LlmRuntimeDeps.openaiCredentials`. If that wiring is missing,
    // we fail loud — at first `loadSdkModule()` call (NOT at
    // construction, per T3 lazy-fail). Surfacing here keeps daemon
    // boot non-blocking for agents that never flip to codex-cli.
    //
    // The error message tells the operator exactly what to edit:
    // `clawcode.yaml` → `defaults.providers.openai.apiKeyPath` (or
    // the per-agent override). The daemon-side construction code
    // owns the wire-up; the message points the operator at the YAML
    // surface, not the daemon internals.
    const credentials = this.deps.openaiCredentials;
    if (!credentials) {
      throw new Error(
        `CodexAgentCli for agent "${this.config.name}" requires ` +
          "openaiCredentials in deps. Set " +
          "`providers.openai.apiKeyPath` under `defaults.providers.openai` " +
          "(fleet-wide) or `agents.<name>.providers.openai` (per-agent " +
          "override) in clawcode.yaml, then run `clawcode reload`. " +
          "If the field is set but this error still fires, the daemon " +
          "per-agent factory loop is not wiring " +
          "OpenAiCredentialsResolver — file a bug.",
      );
    }

    // Surfaces CliBinaryNotFoundError if all three tiers failed —
    // operator pastes `.checked` into the YAML edit and
    // `clawcode restart` resolves.
    const binaryPath = await this.binaryPathPromise;
    this.cachedSdkModule = new CodexSdkModule(
      this.config,
      this.deps,
      binaryPath,
      this.queryDeps,
      credentials,
    );
    return this.cachedSdkModule;
  }
}

/**
 * Phase 137 Plan 04 T-03 — type re-export. Callers (daemon's
 * per-agent factory loop) construct `OpenAiCredentialsResolver` from
 * `src/llm-runtime/credentials/openai-credentials.js`; the type
 * indirection here keeps `codex-agent-cli.ts`'s import surface tidy.
 */
export type { OpenAiCredentialsResolver } from "../credentials/openai-credentials.js";
