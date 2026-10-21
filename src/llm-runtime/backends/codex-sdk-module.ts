/**
 * Phase 137 Plan 03 T-02 — `CodexSdkModule` synthesises the
 * `LlmRuntimeSdkModule` shape backed by spawned `codex` CLI calls.
 *
 * The Phase 136 seam contract (`src/llm-runtime/types.ts`) is:
 *
 *   `LlmRuntimeSdkModule extends SdkModule` widening with
 *   `forkSession(sessionId, options?): Promise<LlmRuntimeForkResult>`.
 *
 *   `SdkModule = { query({ prompt, options? }): SdkQuery }`.
 *
 * `CodexSdkModule.query()` spins up a `CodexQuery` per call and
 * returns the materialised `SdkQuery` from `toSdkQuery()`. Each call
 * spawns a fresh child — matching the Anthropic-Agent-SDK semantics
 * (one Query == one conversation == one underlying child).
 *
 * `forkSession()` is a researcher_todo #1 no-op — Codex CLI's
 * session model is unverified at Plan 03 time. We mint a pseudo-id
 * `${sourceSessionId}-fork-${nanoid(8)}` and emit a
 * `phase137-codex-noop` log line so operators can audit how often
 * this surface is exercised before Plan 05 wires the real
 * session-resumption mechanism (if any).
 *
 * Threat model — see 137-03-PLAN.md `<threat_model>`:
 *   - T-137-03-02 (Spoofing) — accept; binary trust = operator-
 *     deployed package.
 *   - T-137-03-06 (Privilege) — `setPermissionMode` no-op surfaces
 *     in `CodexQuery`; this module does not introduce new
 *     permission surface.
 *
 * See:
 *   - `./codex-query.ts` — the per-conversation spawn wrapper.
 *   - `../types.ts` — `LlmRuntimeSdkModule` widening shape.
 *   - `.planning/phases/137-.../137-03-PLAN.md` T-02 spec.
 */

import type { ResolvedAgentConfig } from "../../shared/types.js";
import type {
  SdkQuery,
  SdkQueryOptions,
  SdkUserMessage,
} from "../../manager/sdk-types.js";
import type {
  GetSessionMessagesOptions,
  LlmRuntimeDeps,
  LlmRuntimeForkOptions,
  LlmRuntimeForkResult,
  LlmRuntimeSdkModule,
  SessionMessage,
} from "../types.js";
import type { AnthropicToolBlock } from "../translation/types.js";
import { CodexQuery, type CodexQueryDeps } from "./codex-query.js";
import type { OpenAiCredentialsResolver } from "../credentials/openai-credentials.js";

/**
 * Default Codex model — CONTEXT D1 says gpt-5-codex. Operator
 * override flows through `config.llmRuntime.codex.model` once the
 * schema lands (T-03 widens `llmRuntimeCodexConfigSchema`); until
 * then the constant default ships verbatim.
 *
 * researcher_todo #7 — confirm `gpt-5-codex` is the current model
 * id at deploy time. If renamed/deprecated, the override path is
 * already in place; only this constant needs updating.
 */
export const CODEX_DEFAULT_MODEL = "gpt-5-codex";

/**
 * `CodexSdkModule` — implements `LlmRuntimeSdkModule`.
 *
 * One instance per agent (cached at the `CodexAgentCli` instance
 * level — mirrors the `AnthropicAgentSdkBackend` cache contract).
 * Each `query()` spawns a fresh `CodexQuery`; `forkSession()` is a
 * no-op pseudo-id (researcher_todo #1).
 */
export class CodexSdkModule implements LlmRuntimeSdkModule {
  constructor(
    private readonly config: ResolvedAgentConfig,
    private readonly deps: LlmRuntimeDeps,
    private readonly binaryPath: string,
    private readonly queryDeps: CodexQueryDeps,
    /**
     * Phase 137 Plan 04 T-03 — per-agent OpenAI credentials resolver.
     *
     * Passed in from `CodexAgentCli` (which receives it via
     * `LlmRuntimeDeps.openaiCredentials`). Threaded into each
     * `CodexQuery` spawn so the resolved key is injected into the
     * child's env as `OPENAI_API_KEY`. Resolution is LAZY at first
     * `CodexQuery` spawn — daemon boot doesn't block on it. The
     * resolver is non-optional here because `CodexAgentCli.loadSdkModule()`
     * has already asserted it before constructing the module.
     */
    private readonly openaiCredentials: OpenAiCredentialsResolver,
  ) {
    void this.config;
    void this.deps;
  }

  /**
   * Spawn a new Codex conversation. Returns an `SdkQuery`-shaped
   * AsyncGenerator the daemon's session-adapter consumes via
   * `for await`.
   *
   * Tools advertisement: `(options as any).tools` — `SdkQueryOptions`
   * has no `tools` field in `sdk-types.ts` today (researcher_todo
   * #1, see Deviation #1 in `codex-query.ts`). Plan 05 may widen
   * `SdkQueryOptions` once Codex's actual tool-advertisement
   * surface is verified.
   */
  query(params: {
    prompt: string | AsyncIterable<SdkUserMessage>;
    options?: SdkQueryOptions;
  }): SdkQuery {
    // Resolve the initial model — `options.model` wins, then the
    // agent's resolved-config Codex model (once T-03 wires it),
    // then the constant default.
    const codexCfg = this.config.llmRuntime?.codex as
      | { readonly model?: string }
      | undefined;
    const initialModel =
      params.options?.model ?? codexCfg?.model ?? CODEX_DEFAULT_MODEL;

    // Surface the tools list with a loose cast — see
    // `codex-query.ts` Deviation #1 (SdkQueryOptions has no `tools`
    // field; researcher_todo for Plan 05 to widen).
    const tools = (
      params.options as
        | { readonly tools?: ReadonlyArray<AnthropicToolBlock> }
        | undefined
    )?.tools;

    // Phase 137 Plan 04 T-03 — build the deferred env Promise.
    //
    // The Promise wraps `OpenAiCredentialsResolver.resolve()` and
    // returns an EXPLICIT allow-list env (T4 — auth surface
    // separation). The spawned codex child sees ONLY:
    //   - PATH (so the binary can locate node/python/etc. if needed)
    //   - HOME (1Password CLI + Codex auth fallbacks read this)
    //   - USER (some libs log this; benign)
    //   - OPENAI_API_KEY (the resolved OpenAI key)
    //
    // NO `OAUTH_TOKEN`, NO `ANTHROPIC_*`, NO `CLAUDE_*` — Anthropic
    // OAuth bearer tokens NEVER reach the OpenAI Codex child. The
    // integration test in `codex-credentials-integration.test.ts`
    // asserts the absence directly.
    //
    // Resolution is LAZY — the Promise is constructed here but
    // SecretsResolver.resolve() inside it doesn't fire until
    // CodexQuery's `awaitDeferredSpawn` awaits the Promise. Synchronous
    // `query()` return preserves the SdkQuery contract.
    const credentialsResolver = this.openaiCredentials;
    const childEnvPromise = (async (): Promise<Record<string, string>> => {
      const apiKey = await credentialsResolver.resolve();
      const env: Record<string, string> = {
        OPENAI_API_KEY: apiKey,
      };
      // Whitelist the process-env keys the spawned child legitimately
      // needs. Read at spawn time (not boot) so a re-spawned daemon
      // picks up new PATHs. NEVER inherit `process.env` wholesale —
      // that path would expose `OAUTH_TOKEN` / `ANTHROPIC_*` to the
      // OpenAI child (T-137-04-03 mitigation).
      const PATH = process.env.PATH;
      if (typeof PATH === "string" && PATH.length > 0) env.PATH = PATH;
      const HOME = process.env.HOME;
      if (typeof HOME === "string" && HOME.length > 0) env.HOME = HOME;
      const USER = process.env.USER;
      if (typeof USER === "string" && USER.length > 0) env.USER = USER;
      return env;
    })();
    // Attach a no-op `.catch` so an unhandled-rejection trap doesn't
    // fire when the daemon's `for await` loop hasn't started yet. The
    // rejection is observed inside `CodexQuery.awaitDeferredSpawn`
    // and surfaced as a synthetic error event into the iterator queue
    // (lazy-fail per T3).
    childEnvPromise.catch(() => {});

    const cq = new CodexQuery(
      {
        binaryPath: this.binaryPath,
        prompt: params.prompt,
        options: params.options,
        initialModel,
        agentName: this.config.name,
        tools,
        childEnvPromise,
      },
      this.queryDeps,
    );
    return cq.toSdkQuery();
  }

  /**
   * Fork an existing session — Plan 03 NO-OP.
   *
   * researcher_todo #1: Codex CLI's session-resumption surface is
   * unverified. The current behaviour mints a pseudo-fork id by
   * suffixing the source id with `nanoid(8)` and logs the event for
   * operator audit. Plan 05 wires the real surface if Codex exposes
   * one; otherwise the no-op is the long-term Phase 137 disposition.
   *
   * The daemon today calls `forkSession` from `daemon.ts:3526`
   * (advisor-fork, Phase 117) and `:10867` (compaction-fork,
   * Phase 124/125). Neither path is on the user-facing critical
   * path for Codex trial-cohort agents (per CONTEXT D3) — research/
   * projects agents don't currently advisor-fork on the Codex
   * provider.
   */
  async forkSession(
    sessionId: string,
    _options?: LlmRuntimeForkOptions,
  ): Promise<LlmRuntimeForkResult> {
    const nanoidFn = this.queryDeps.nanoidFn;
    const suffix = nanoidFn ? nanoidFn() : "deferred";
    const fakeId = `${sessionId}-fork-${suffix}`;
    if (this.deps.logger) {
      this.deps.logger.info(
        {
          method: "forkSession",
          sourceSessionId: sessionId,
          fakeId,
        },
        "phase137-codex-noop",
      );
    }
    return { sessionId: fakeId };
  }

  /**
   * Read a session transcript — Phase 999.75 Part A (A1) STUB.
   *
   * Codex CLI does not expose an SDK-JSONL transcript in the
   * `getSessionMessages` shape (its session model is unverified —
   * researcher_todo #1, same caveat as `forkSession`). Returning `[]`
   * trips the documented fail-open path in
   * `src/memory/sdk-transcript-reader.ts` (`readToolAwareTurns` → `null`),
   * so a Codex-backed agent's compaction degrades to the existing
   * `ConversationStore` extractor input with no behaviour change.
   */
  async getSessionMessages(
    sessionId: string,
    _options?: GetSessionMessagesOptions,
  ): Promise<readonly SessionMessage[]> {
    if (this.deps.logger) {
      this.deps.logger.info(
        { method: "getSessionMessages", sourceSessionId: sessionId },
        "phase137-codex-noop",
      );
    }
    return [];
  }
}
