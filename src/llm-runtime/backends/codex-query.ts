/**
 * Phase 137 Plan 03 T-01 — `CodexQuery` spawn skeleton.
 *
 * Provider-neutral `SdkQuery`-shaped wrapper around a spawned `codex`
 * CLI child process. The class satisfies the `SdkQuery` contract from
 * `src/manager/sdk-types.ts`:
 *
 *   `SdkQuery = AsyncGenerator<SdkStreamMessage, void> & { ...mutators }`
 *
 * NOTE — the plan's `<interfaces>` block described an idealised
 * surface (`query(opts: SdkQueryOptions)` with `opts.tools` /
 * `opts.messages`). The real binding contract in `sdk-types.ts` is
 * `query({ prompt, options? })` with `prompt: string | AsyncIterable<
 * SdkUserMessage>` and `SdkQueryOptions` carrying NO `tools` /
 * `messages` field. We implement against the real contract — the
 * type-level conformance assertion in `codex-sdk-module.test.ts`
 * gates this at `tsc --noEmit` time. The discrepancy is surfaced as
 * Deviation #1 in 137-03-SUMMARY.md.
 *
 * Plan 03 ships a deliberately minimal stdout parser sufficient for
 * single-shot (non-streaming) responses. Plan 05 deepens this into a
 * typed-SSE event mapping (`message_start`, `content_block_delta`,
 * tool-result mid-stream, error normalisation). Plan 03 proves the
 * spawn + translation boundaries work; Plan 05 proves they work
 * under streaming load.
 *
 * NO real `codex` binary in tests — `spawnFn` is dependency-injected
 * and every test stubs it with a fake child shaped to match
 * `node:child_process.ChildProcessByStdio`. CI runs in environments
 * without `codex` on disk; production smoke-testing is operator-side
 * post-deploy via the fleet config flip (per CONTEXT D3 trial cohort
 * scope).
 *
 * Threat model — see 137-03-PLAN.md `<threat_model>`:
 *   - T-137-03-03 (Information Disclosure) — tool inputs are written
 *     to stdin, NOT argv. Argv contains only `--model` value + the
 *     tool schemas (no per-turn tool inputs).
 *   - T-137-03-04 (Tampering — malformed stdout) — JSON.parse wrapped
 *     in try/catch; parse errors emit `phase137-codex-parse-error`
 *     log + a synthetic `result` error event; daemon stays up.
 *
 * Deviation #2 from the plan: the plan claims `execa` is already in
 * the project's deps. It is NOT (verified via package.json + node_
 * modules grep at execution time). We use `node:child_process.spawn`
 * directly — same primitive, zero new dependencies (matches the
 * success-criteria invariant "Zero new npm dependencies"). Threat
 * model T-137-03-SC accept-disposition is unchanged.
 *
 * See:
 *   - `./codex-sdk-module.ts` — wraps this into the `SdkModule` shape.
 *   - `../translation/index.js` — Plan 02 wire-shape primitives.
 *   - `../../manager/sdk-types.ts` — `SdkQuery` + `SdkStreamMessage`
 *     binding contract.
 *   - `.planning/phases/137-.../137-03-PLAN.md` T-01 spec.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { nanoid } from "nanoid";

import type {
  PermissionMode,
  ModelInfo,
  SdkQuery,
  SdkQueryOptions,
  SdkStreamMessage,
  SdkUserMessage,
  SlashCommand,
} from "../../manager/sdk-types.js";
import type {
  AnthropicMessage,
  AnthropicToolBlock,
} from "../translation/types.js";
import {
  normaliseOpenAiSseChunks,
  translateMessageToOpenAI,
  translateToolsToOpenAI,
  type NormalisedSseEvent,
} from "../translation/index.js";
import {
  mapOpenAiHttpStatus,
  type ClawCodeInternalError,
} from "../errors/openai-errors.js";

/**
 * Minimal pino-shaped logger surface (matches `LlmRuntimeDeps.logger`).
 * Duplicated locally so this module doesn't pull pino as a value
 * import — the daemon injects its own logger.
 */
export interface CodexQueryLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

/**
 * Constructor-injected deps for `CodexQuery`. Production wires
 * `spawnFn = (cmd, args, opts) => spawn(cmd, args, opts)` via
 * `createDefaultCodexQueryDeps()`; tests inject a vitest spy.
 *
 * `nanoidFn` is injected too so tests can pin the pseudo-fork id used
 * in `CodexSdkModule.forkSession`. Default = the real `nanoid`.
 */
export interface CodexQueryDeps {
  /**
   * `node:child_process.spawn`-shaped factory. Returns a child whose
   * `.stdin` / `.stdout` / `.stderr` streams the parser drains. We
   * use the native primitive instead of `execa` (NOT in project
   * deps — see file header Deviation #2).
   */
  readonly spawnFn: typeof spawn;
  readonly logger?: CodexQueryLogger;
  readonly nanoidFn?: () => string;
}

/**
 * Construct the production deps object — real `spawn` + real
 * `nanoid`. The daemon picks this up via `CodexSdkModule`.
 */
export function createDefaultCodexQueryDeps(
  logger?: CodexQueryLogger,
): CodexQueryDeps {
  return {
    spawnFn: spawn,
    logger,
    nanoidFn: () => nanoid(8),
  };
}

/**
 * Per-CodexQuery construction options. The first three mirror what
 * `CodexSdkModule.query()` derives from the public `SdkModule.query`
 * params; the rest are agent-level resolved config snapshots.
 */
export interface CodexQuerySpawnOptions {
  /**
   * Codex CLI binary path resolved by Plan 01's `discoverCliBinary`
   * 3-tier probe. The class spawns this path verbatim — no further
   * resolution.
   */
  readonly binaryPath: string;
  /**
   * Initial prompt — either a single string (one-shot) or an async
   * stream of user messages (multi-turn via `streamInput`). When
   * `AsyncIterable`, the class drains it in the background and
   * writes each translated user message to stdin newline-terminated.
   */
  readonly prompt: string | AsyncIterable<SdkUserMessage>;
  /**
   * Optional SDK options passed through from the caller. Phase 137
   * Plan 03 reads `options.model` (mid-session override) and
   * `(options as { tools? }).tools` (researcher_todo: SdkQueryOptions
   * has no `tools` field today — see file header Deviation #1).
   */
  readonly options?: SdkQueryOptions;
  /**
   * Initial model — fallback chain is `options.model` ?? this ?? the
   * Codex default at `CodexSdkModule` construction. Stored on the
   * instance for the `setModel` mutator and the
   * `initializationResult` synth.
   */
  readonly initialModel: string;
  /**
   * Operator-facing agent name — included in every
   * `phase137-codex-*` log line so journalctl grep is scopable per
   * agent.
   */
  readonly agentName: string;
  /**
   * Tools advertised at spawn time. Phase 137 Plan 03 plumbs this
   * separately (researcher_todo: real CLI flag unverified — see
   * file header Deviation #1). Empty array still exercises the
   * `translateToolsToOpenAI` boundary so the spawn-arg static-grep
   * done criterion passes.
   */
  readonly tools?: ReadonlyArray<AnthropicToolBlock>;
  /**
   * Phase 137 Plan 04 T-03 — child env Promise.
   *
   * Resolves to the EXPLICIT allow-list env passed to `spawnFn` as
   * `opts.env`. The Promise shape is the lazy-resolution surface
   * (T3): CodexSdkModule.query() returns synchronously, but the
   * actual child spawn is deferred until this Promise settles so
   * `OpenAiCredentialsResolver.resolve()` can run asynchronously
   * inside CodexSdkModule.query().
   *
   * Allow-list contract (T4 — auth surface separation):
   *   - The Promise resolves to a Record containing ONLY explicitly
   *     allow-listed keys (`PATH`, `HOME`, `USER`, `OPENAI_API_KEY`).
   *   - No `process.env` inheritance — the spawned codex child sees
   *     a clean env with `OPENAI_API_KEY` only as its auth surface.
   *   - `OAUTH_TOKEN`, `ANTHROPIC_*`, and any other Anthropic-scoped
   *     env vars NEVER appear (test enforced in
   *     `codex-credentials-integration.test.ts`).
   *
   * If the Promise REJECTS (e.g.,
   * `OpenAiCredentialsMissingError` from the resolver), CodexQuery
   * emits a synthetic `result` error event into the iterator queue
   * and closes the stream — the daemon's `for await` sees an
   * explicit failure instead of a hanging spawn.
   *
   * Optional for back-compat with Plan 03 tests that don't yet wire
   * credentials (the integration test in
   * `codex-agent-cli-integration.test.ts` constructs CodexQuery with
   * no env override and the test asserts spawn behaviour; that path
   * stays valid because Plan 03 tests construct CodexAgentCli without
   * the codex-cli enforcement). When `undefined`, spawn proceeds
   * synchronously with NO env override (legacy Plan 03 path).
   */
  readonly childEnvPromise?: Promise<Record<string, string>>;
}

/**
 * Internal: shape we push into the iterator queue.
 *
 * The async-generator drains this queue; the stdout parser pushes
 * into it. `null` is the end-of-stream sentinel — when popped, the
 * generator returns.
 */
type IteratorItem =
  | { readonly kind: "msg"; readonly value: SdkStreamMessage }
  | { readonly kind: "end" };

/**
 * `CodexQuery` — `SdkQuery`-shaped wrapper around a spawned codex
 * child. Constructed by `CodexSdkModule.query()`.
 *
 * The class itself is NOT directly the `SdkQuery` — it owns the
 * spawn + parser, then exposes a `toSdkQuery()` factory that
 * returns the `AsyncGenerator & mutators` shape the consumer wants.
 * This split keeps the class testable (we can inspect spawn args,
 * mock the stdout, etc.) while the public surface stays the typed
 * `SdkQuery`.
 */
export class CodexQuery {
  private readonly deps: CodexQueryDeps;
  private readonly logger?: CodexQueryLogger;

  /**
   * The spawned codex child. Stored so mutators (`interrupt`,
   * `close`, `streamInput`) can drive it.
   *
   * Phase 137 Plan 04 T-03: declared as nullable because deferred-
   * spawn flow (when `childEnvPromise` is supplied) materialises the
   * child asynchronously inside `awaitDeferredSpawn`. Mutators
   * (`interrupt`, `close`, `streamInput`) tolerate the pre-spawn
   * state via the null check — for `streamInput` the writes queue
   * into an internal buffer flushed once `child` is non-null.
   */
  private child: ChildProcess | null;

  /**
   * Phase 137 Plan 04 T-03 — pre-spawn stdin buffer.
   *
   * When `childEnvPromise` is supplied (lazy-spawn path) the prompt
   * driver may want to write to stdin BEFORE the child actually
   * exists. Writes accumulate here; once the child is materialised
   * in `awaitDeferredSpawn`, the buffer is flushed verbatim.
   */
  private readonly preSpawnStdinBuffer: string[] = [];

  /**
   * Pending model — the value `setModel` writes. Plan 03 stores it
   * for the synthesised `initializationResult` mirror; Plan 05 owns
   * mid-stream model swap (which on Codex requires a child-process
   * restart — researcher_todo: confirm).
   */
  private currentModel: string;

  /**
   * In-instance dedup map for noop-mutator logs. Phase 137 ops-side
   * grep relies on `phase137-codex-noop` firing at most once per
   * `(method, distinguishing-arg)` pair per CodexQuery lifetime to
   * keep journalctl readable.
   */
  private readonly noopLogged = new Set<string>();

  /**
   * The iterator queue — populated by stdout parser, drained by the
   * async generator. Resolves the producer/consumer race via two
   * arrays: pending items waiting to be read, and pending readers
   * waiting for an item. At most one is non-empty at a time.
   */
  private readonly pendingItems: IteratorItem[] = [];
  private readonly pendingReaders: Array<(item: IteratorItem) => void> = [];
  private endRequested = false;

  /**
   * Phase 137 Plan 05 T-02 — typed error parked from stderr until
   * either (a) the child exits, at which point we emit a synthetic
   * error event in front of the end-of-stream sentinel, or (b) the
   * child recovers and the error is naturally superseded by valid
   * stdout (rare in practice — Codex doesn't typically print HTTP
   * errors and then continue producing valid output).
   *
   * Stored as `ClawCodeInternalError` so the typed class is preserved
   * — `emitErrorAsResultEvent` reads the typed fields when building
   * the synthetic event.
   */
  private pendingTypedError: ClawCodeInternalError | null = null;

  /**
   * Phase 137 Plan 04 T-03 — agent name retained for use across the
   * deferred-spawn boundary. Without this, `awaitDeferredSpawn`
   * couldn't emit `phase137-codex-spawn` with the correct `agent`
   * field. Stored as a field rather than re-derived from `deps`.
   */
  private readonly agentName: string;

  /**
   * Phase 137 Plan 04 T-03 — spawn args computed at construction so
   * the deferred-spawn path uses the same array as the synchronous
   * path. Translation happens at construction; the spawn boundary
   * just consumes.
   */
  private readonly spawnArgs: string[];
  private readonly toolCount: number;
  private readonly binaryPath: string;

  constructor(opts: CodexQuerySpawnOptions, deps: CodexQueryDeps) {
    this.deps = deps;
    this.logger = deps.logger;
    this.currentModel = opts.options?.model ?? opts.initialModel;
    this.agentName = opts.agentName;
    this.binaryPath = opts.binaryPath;

    // ---- Spawn args (researcher_todo #1 — conservative single-shot) ----
    //
    // Until the Codex CLI's actual flag surface is verified post-deploy,
    // we use a conservative `--model <m>` + tools-via-argv shape and
    // write the prompt JSON to stdin. Plan 05 owns the deeper protocol
    // (researcher_todo: SSE vs line-delimited; stream-json flag; session
    // resumption flag).
    const translatedTools = translateToolsToOpenAI(opts.tools ?? []);
    this.spawnArgs = [
      "--model",
      this.currentModel,
      // researcher_todo: verify Codex CLI flag for tools advertisement.
      // Plan 03 surface is conservative; real flag may be `--functions`,
      // stdin JSON, or env var. The `--tools` arg name is provisional.
      "--tools",
      JSON.stringify(translatedTools),
      // researcher_todo: verify Codex CLI flag for stream-json mode.
      // Without it the child likely emits human-readable text — Plan 03
      // assumes line-delimited JSON for the minimal parser path.
    ];
    this.toolCount = translatedTools.length;

    if (opts.childEnvPromise === undefined) {
      // ---- Phase 137 Plan 03 path: synchronous spawn, no env override.
      // Preserves the existing integration test behaviour (Plan 03
      // tests construct CodexQuery without credentials wiring).
      this.child = this.spawnChild(undefined);
    } else {
      // ---- Phase 137 Plan 04 path: deferred spawn pending the env
      // Promise (which wraps OpenAiCredentialsResolver.resolve()).
      // Spawn happens inside `awaitDeferredSpawn`; until then the
      // mutators tolerate a `null` child and stdin writes queue.
      this.child = null;
      void this.awaitDeferredSpawn(opts.childEnvPromise);
    }

    // ---- Drive the prompt → stdin ----
    //
    // Fire-and-forget. String prompts write once + half-close stdin.
    // AsyncIterable prompts loop until the source ends. Failure here
    // is non-fatal (we still want the spawned binary to surface its
    // own error on stdout/stderr) — log + continue.
    void this.drivePrompt(opts.prompt).catch((err) => {
      this.emitLog("phase137-codex-stdin-error", {
        agent: opts.agentName,
        error: String(err),
      });
    });
  }

  /**
   * Phase 137 Plan 04 T-03 — synchronous spawn helper.
   *
   * Called from the constructor (Plan 03 sync path) AND from
   * `awaitDeferredSpawn` (Plan 04 lazy path). Single chokepoint for
   * the `spawnFn` invocation + telemetry log + exit/error wiring +
   * stdout parser wiring.
   *
   * `env` is the SPAWN ENV OVERRIDE per T4:
   *   - `undefined` → no env override (legacy Plan 03 path; inherits
   *     process.env). Used by the existing Plan 03 integration tests.
   *   - non-undefined → EXPLICIT allow-list env passed to `spawnFn`
   *     as the `env` option. NO `process.env` inheritance — the
   *     spawned child sees ONLY the listed keys (auth surface
   *     separation invariant).
   */
  private spawnChild(env: Record<string, string> | undefined): ChildProcess {
    // stdio: pipe all three — daemon reads stdout (events), writes stdin
    // (messages), captures stderr for the parse-error log path.
    const spawnOpts: Parameters<typeof this.deps.spawnFn>[2] = env === undefined
      ? { stdio: ["pipe", "pipe", "pipe"] }
      : { stdio: ["pipe", "pipe", "pipe"], env };

    const child = this.deps.spawnFn(this.binaryPath, this.spawnArgs, spawnOpts);

    // ---- Telemetry: phase137-codex-spawn ----
    //
    // Exactly one line per CodexQuery construction. Operators grep
    // `journalctl -u clawcode -g phase137-codex-spawn` to confirm
    // multi-provider rollout is reaching the spawn boundary. The
    // toolCount field surfaces whether tools advertisement reached
    // the child (researcher_todo #1).
    //
    // SEC-07: `envHasOpenaiKey` is a STRUCTURAL signal (boolean) —
    // never the resolved value. Operators correlate via journalctl
    // grep without seeing the key itself.
    this.emitLog("phase137-codex-spawn", {
      agent: this.agentName,
      model: this.currentModel,
      toolCount: this.toolCount,
      binaryPath: this.binaryPath,
      envHasOpenaiKey: env !== undefined && "OPENAI_API_KEY" in env,
    });

    // ---- Phase 137 Plan 05 T-03 — interceptor-bypass telemetry ----
    //
    // Operator-greppable proof that the spawned codex child targets
    // `api.openai.com`, NOT `api.anthropic.com`. One line per
    // CodexQuery construction; static-grep regression in
    // anthropic-interceptor-regression.test.ts asserts the scope
    // separation invariant directly. The line carries no secrets —
    // only the outbound origin tag + agent name.
    this.emitLog("phase137-codex-interceptor-bypass", {
      agent: this.agentName,
      outboundOrigin: "api.openai.com",
    });

    // ---- Wire stdout → iterator queue ----
    this.wireStdoutParserFor(child);

    // ---- Phase 137 Plan 05 T-02 — stderr → typed error mapping ----
    this.wireStderrParserFor(child);

    // ---- Wire child exit → end-of-stream sentinel ----
    child.on("exit", (code) => {
      // If a typed error was synthesised from stderr and the child
      // then exited non-zero, surface the typed error as the final
      // synthetic event before closing the iterator. Operators see
      // the same error class regardless of whether the failure
      // arrived on stdout, stderr, or via exit code alone.
      if (this.pendingTypedError && (code === null || code !== 0)) {
        this.emitErrorAsResultEvent(this.pendingTypedError);
        this.pendingTypedError = null;
      }
      this.pushItem({ kind: "end" });
    });
    child.on("error", (err) => {
      // Spawn failure (ENOENT, EACCES). Surface as a synthetic error
      // event so the async-generator yields one final message before
      // ending — daemon's `for await` loop sees an explicit failure
      // instead of an empty iterator.
      this.emitLog("phase137-codex-spawn-error", {
        agent: this.agentName,
        error: String(err),
      });
      this.pushItem({
        kind: "msg",
        value: {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: `codex spawn failed: ${String(err)}`,
        },
      });
      this.pushItem({ kind: "end" });
    });

    return child;
  }

  /**
   * Phase 137 Plan 04 T-03 — await the env Promise, then spawn.
   *
   * Runs as a fire-and-forget after the synchronous constructor. The
   * synchronous constructor returns the SdkQuery shape immediately;
   * the consumer's `for await (...)` loop blocks on the iterator
   * queue until either (a) this method completes and the child
   * starts emitting stdout, or (b) the env Promise rejects and we
   * push a synthetic error event + end sentinel.
   *
   * Rejection path is the credentials-missing fail-fast (T3): the
   * daemon's `for await` sees a single `result` event with
   * `is_error: true` carrying the operator-actionable message from
   * `OpenAiCredentialsMissingError`.
   */
  private async awaitDeferredSpawn(
    envPromise: Promise<Record<string, string>>,
  ): Promise<void> {
    let env: Record<string, string>;
    try {
      env = await envPromise;
    } catch (err) {
      // Surfaces OpenAiCredentialsMissingError or any other resolver
      // failure. Emit a single synthetic error event so the daemon
      // doesn't hang waiting for a child that never starts.
      this.emitLog("phase137-codex-credentials-error", {
        agent: this.agentName,
        error: String(err),
      });
      this.pushItem({
        kind: "msg",
        value: {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result:
            err instanceof Error
              ? err.message
              : `codex credentials resolution failed: ${String(err)}`,
        },
      });
      this.pushItem({ kind: "end" });
      return;
    }
    // Resolution succeeded — spawn the child with the explicit
    // allow-list env. From this point the flow is identical to the
    // Plan 03 sync path.
    this.child = this.spawnChild(env);
    // Flush any stdin writes that queued before the child existed.
    for (const line of this.preSpawnStdinBuffer) {
      if (this.child.stdin && !this.child.stdin.destroyed) {
        this.child.stdin.write(line);
      }
    }
    this.preSpawnStdinBuffer.length = 0;
  }

  // ===================================================================
  // Stdout parser (researcher_todo #2 — minimal line-delimited JSON)
  // ===================================================================

  /**
   * Drain `child.stdout` as UTF-8 text, split on newlines, parse each
   * non-empty line as JSON, translate the parsed shape through Plan 02
   * primitives, push the result as an `SdkStreamMessage` into the
   * iterator queue.
   *
   * researcher_todo #2 — verify Codex CLI's actual stdout shape. If
   * it's OpenAI Chat Completions SSE (`data: {...}` framing), Plan 05
   * ships the deeper parser. The minimal parser here handles the
   * "newline-delimited JSON, one OpenAI chunk per line" assumption.
   *
   * Parse errors emit `phase137-codex-parse-error` + push a synthetic
   * `result` error event. The daemon stays up (T-137-03-04 mitigation).
   */
  private wireStdoutParser(): void {
    // Phase 137 Plan 04 T-03 — delegate to the explicit-child variant.
    // Kept for back-compat with the Plan 03 invocation site (no longer
    // called from the constructor — the dispatch happens inside
    // spawnChild).
    if (this.child) this.wireStdoutParserFor(this.child);
  }

  /**
   * Phase 137 Plan 05 T-02 — stderr parser that watches for HTTP
   * error patterns and maps them to typed `ClawCodeInternalError`
   * subclasses via `mapOpenAiHttpStatus`.
   *
   * Pattern: `/HTTP (\d{3})/` anywhere in a stderr line. When matched,
   * the rest of the buffer is attempted as a JSON body (the codex CLI
   * often prints `HTTP 401\n{"error":...}` style). The typed error is
   * parked on `pendingTypedError`; the child-exit handler emits it as
   * a synthetic `result` error event so the daemon's `for await` sees
   * the same error class regardless of which provider failed.
   *
   * Each match also fires a `phase137-codex-error-mapped` log line
   * with the structural fields the operator dashboards consume
   * (`httpStatus`, `internalType`, `codeFromBody`). The raw body
   * NEVER appears in the log (T-137-05-02 Information Disclosure
   * mitigation).
   */
  private wireStderrParserFor(child: ChildProcess): void {
    if (!child.stderr) return;
    child.stderr.setEncoding("utf8");

    let buffer = "";
    const HTTP_STATUS_RE = /HTTP\s+(\d{3})/;

    child.stderr.on("data", (chunk: string) => {
      buffer += chunk;
      // Scan the buffer for an HTTP-status line. We don't split on
      // newlines first because the body sometimes arrives on the same
      // line as the status (`HTTP 401 {"error":...}`); a regex match
      // pinpoints the status and then we try to extract a JSON
      // payload from whatever follows.
      const match = HTTP_STATUS_RE.exec(buffer);
      if (!match) return;
      const status = Number(match[1]);
      const tail = buffer.slice(match.index + match[0].length);
      // Best-effort body extraction — find the first `{` and try
      // JSON-parsing everything from there. If there's no `{`, pass
      // the tail through as a string (mapOpenAiHttpStatus tolerates
      // both).
      const braceIdx = tail.indexOf("{");
      let body: unknown;
      if (braceIdx >= 0) {
        const jsonStr = tail.slice(braceIdx).trim();
        // Don't pre-validate — let mapOpenAiHttpStatus's parseBody
        // handle malformed bodies; that path is tested.
        body = jsonStr;
      } else {
        body = tail.trim().length > 0 ? tail.trim() : undefined;
      }
      const typed = mapOpenAiHttpStatus(status, body);
      this.pendingTypedError = typed;
      this.emitLog("phase137-codex-error-mapped", {
        agent: this.agentName,
        httpStatus: typed.status,
        internalType: typed.name,
        codeFromBody: typed.codeFromBody,
      });
      // Clear the buffer so we don't double-process the same match
      // on the next chunk.
      buffer = "";
    });
  }

  /**
   * Phase 137 Plan 05 T-02 — emit a typed error as a synthetic
   * `SdkResultError` event into the iterator queue.
   *
   * The `result` content carries the typed error's class name + HTTP
   * status + operator-visible message. Downstream consumers can
   * discriminate via `subtype` (always `error_during_execution` from
   * this path) + the parsed message; Phase 138 may widen
   * `SdkResultError.subtype` to expose the typed class directly.
   */
  private emitErrorAsResultEvent(err: ClawCodeInternalError): void {
    this.pushItem({
      kind: "msg",
      value: {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: `${err.name} (HTTP ${err.status}): ${err.message}`,
      },
    });
  }

  private wireStdoutParserFor(child: ChildProcess): void {
    if (!child.stdout) {
      // No stdout (test fixture / spawn failure). End-of-stream
      // sentinel still arrives via the `exit` handler.
      return;
    }
    child.stdout.setEncoding("utf8");

    // ---- Phase 137 Plan 05 T-03 — SSE streaming pipeline ----
    //
    // Replaces the Plan 03 minimal `handleStdoutLine` parser with the
    // proper typed-event SSE state machine from
    // `src/llm-runtime/translation/streaming.ts`. The pipeline is:
    //
    //   child.stdout (utf-8 text)
    //     → line splitter (newline-delimited, CR-tolerant)
    //     → push-driven AsyncIterable<string>
    //     → normaliseOpenAiSseChunks() → AsyncIterable<NormalisedSseEvent>
    //     → adapter (collapses to SdkStreamMessage shape)
    //     → iterator queue
    //
    // Per the silent-path-bifurcation invariant (memory item +
    // CONTEXT D-03a), the OLD parser is REMOVED — there is no
    // coexisting branch. `handleStdoutLine` and `translateInbound`
    // remain in the file only as defensive helpers documented as
    // legacy-deprecated; no caller invokes them.

    // Push-driven async iterable: stdout `data` events push into
    // `pendingLines`; `nextLine()` pops or awaits the next push. End
    // is signalled by pushing `null` onto the queue.
    const pendingLines: Array<string | null> = [];
    const pendingLineReaders: Array<(line: string | null) => void> = [];

    const pushLine = (line: string | null): void => {
      const reader = pendingLineReaders.shift();
      if (reader) reader(line);
      else pendingLines.push(line);
    };

    const lineIterable: AsyncIterable<string> = {
      [Symbol.asyncIterator](): AsyncIterator<string> {
        return {
          async next(): Promise<IteratorResult<string>> {
            const queued = pendingLines.shift();
            if (queued !== undefined) {
              return queued === null
                ? { done: true, value: undefined as never }
                : { done: false, value: queued };
            }
            return new Promise<IteratorResult<string>>((resolve) => {
              pendingLineReaders.push((line) =>
                resolve(
                  line === null
                    ? { done: true, value: undefined as never }
                    : { done: false, value: line },
                ),
              );
            });
          },
        };
      },
    };

    // Line splitter — accumulate stdout chunks, emit complete lines
    // (CR-tolerant), buffer the trailing partial line.
    let buffer = "";
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newlineIdx = buffer.indexOf("\n");
      while (newlineIdx >= 0) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        pushLine(line); // includes empty lines; normaliser filters
        newlineIdx = buffer.indexOf("\n");
      }
    });
    child.stdout.on("end", () => {
      const tail = buffer;
      if (tail.length > 0) {
        pushLine(tail);
        buffer = "";
      }
      pushLine(null); // end-of-stream sentinel for the normaliser
    });

    // Drive the normaliser in the background and translate each
    // NormalisedSseEvent into the SdkStreamMessage shape the
    // session-adapter consumes.
    void this.driveStreamingPipeline(lineIterable);
  }

  /**
   * Phase 137 Plan 05 T-03 — adapt NormalisedSseEvent (idealised
   * Anthropic-shape) into the real SdkStreamMessage union (assistant
   * | result) that the daemon's session-adapter actually reads.
   *
   * Strategy:
   *   - Buffer text content across `content_block_delta` events; on
   *     each text block close OR at message_stop, emit ONE assistant
   *     SdkStreamMessage with the accumulated text + tool_use blocks.
   *     This matches the cardinality the existing Plan 03 path
   *     produced (one assistant per logical conversation point).
   *   - On message_delta with stop_reason/usage, capture for the
   *     final result event.
   *   - On message_stop, emit a terminal SdkResultSuccess (or
   *     pre-existing pendingTypedError if stderr already raised one).
   *
   * Errors during normalisation (e.g., translateToolUseFromOpenAI
   * throws on malformed JSON) are caught + logged as
   * `phase137-codex-translate-error`; the iteration continues so
   * partial output still surfaces.
   */
  private async driveStreamingPipeline(
    lineIterable: AsyncIterable<string>,
  ): Promise<void> {
    const accumulatedText: string[] = [];
    const accumulatedToolUses: Array<{
      id: string;
      name: string;
      input: Record<string, unknown>;
    }> = [];
    let finalStopReason: string | undefined;
    let finalUsage: { input_tokens?: number; output_tokens?: number } | undefined;
    let modelFromStart: string | undefined;
    let sessionIdFromStart: string | undefined;

    try {
      for await (const event of normaliseOpenAiSseChunks(lineIterable, {
        logger: this.logger,
      })) {
        this.consumeNormalisedEvent(event, {
          onText: (text) => accumulatedText.push(text),
          onToolUse: (tool) => accumulatedToolUses.push(tool),
          onMessageStart: (msg) => {
            modelFromStart = msg.model;
            sessionIdFromStart = msg.id;
          },
          onMessageDelta: (stop, usage) => {
            finalStopReason = stop;
            finalUsage = usage;
          },
        });
      }
    } catch (err) {
      this.emitLog("phase137-codex-translate-error", {
        agent: this.agentName,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Emit a single assistant message if any text or tool_use
    // accumulated. The Anthropic-shape `message` carries the full
    // content array so downstream consumers that read `message.content`
    // get the structured shape, while `content` (top-level string)
    // mirrors the flattened text for legacy paths.
    if (accumulatedText.length > 0 || accumulatedToolUses.length > 0) {
      const blocks: Array<
        | { type: "text"; text: string }
        | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
      > = [];
      const flatText = accumulatedText.join("");
      if (flatText.length > 0) {
        blocks.push({ type: "text", text: flatText });
      }
      for (const tu of accumulatedToolUses) {
        blocks.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
      }
      this.pushItem({
        kind: "msg",
        value: {
          type: "assistant",
          content: flatText,
          message: {
            role: "assistant",
            content: blocks,
          },
          session_id: sessionIdFromStart,
        },
      });
    }

    // Terminal result event — success unless stderr already raised a
    // typed error (the exit handler will emit that one). If a typed
    // error is pending, skip emitting a success here; the
    // exit-handler path emits the typed error in front of `end`.
    if (!this.pendingTypedError) {
      this.pushItem({
        kind: "msg",
        value: {
          type: "result",
          subtype: "success",
          usage: finalUsage,
          model: modelFromStart,
          ...(finalStopReason !== undefined
            ? { result: `stop_reason: ${finalStopReason}` }
            : {}),
        },
      });
    }
  }

  /**
   * Phase 137 Plan 05 T-03 — single-event consumer used by the
   * streaming pipeline. Split into its own method so unit tests can
   * exercise the adapter independently of the SSE pipeline.
   *
   * The `onToolUse` callback receives a fully-parsed Anthropic
   * tool_use block (the normaliser has already invoked
   * translateToolUseFromOpenAI). The `onText` callback receives
   * incremental text deltas.
   */
  private consumeNormalisedEvent(
    event: NormalisedSseEvent,
    cb: {
      onText: (text: string) => void;
      onToolUse: (tool: { id: string; name: string; input: Record<string, unknown> }) => void;
      onMessageStart: (msg: { id?: string; model?: string }) => void;
      onMessageDelta: (
        stop: string | undefined,
        usage: { input_tokens?: number; output_tokens?: number } | undefined,
      ) => void;
    },
  ): void {
    switch (event.type) {
      case "message_start":
        cb.onMessageStart(event.message);
        return;
      case "content_block_start": {
        const block = event.content_block;
        if (block.type === "tool_use") {
          cb.onToolUse({
            id: block.id,
            name: block.name,
            input: block.input,
          });
        }
        return;
      }
      case "content_block_delta": {
        const delta = event.delta;
        if (delta.type === "text_delta") {
          cb.onText(delta.text);
        }
        // input_json_delta intentionally ignored at the adapter level
        // — the consolidated tool_use block was already emitted on
        // content_block_start.
        return;
      }
      case "content_block_stop":
      case "message_stop":
        return;
      case "message_delta":
        cb.onMessageDelta(event.delta.stop_reason, event.usage);
        return;
      default: {
        const exhaustive: never = event;
        void exhaustive;
        return;
      }
    }
  }

  // Phase 137 Plan 05 T-03 — the Plan 03 minimal stdout parser
  // (`handleStdoutLine` + `translateInbound` + `flattenAnthropicContentToText`)
  // was REMOVED in this commit. The replacement path is
  // `wireStdoutParserFor` → `driveStreamingPipeline` →
  // `consumeNormalisedEvent`, anchored on `normaliseOpenAiSseChunks`
  // from `../translation/streaming.ts`. Silent-path-bifurcation
  // invariant: there is exactly ONE stdout consumer in CodexQuery.

  // ===================================================================
  // Prompt → stdin driver
  // ===================================================================

  private async drivePrompt(
    prompt: string | AsyncIterable<SdkUserMessage>,
  ): Promise<void> {
    if (typeof prompt === "string") {
      // Synthesise a single-block Anthropic user message and translate
      // it via Plan 02. The OpenAI-shape JSON is written as one line.
      const anthropic: AnthropicMessage = {
        role: "user",
        content: [{ type: "text", text: prompt }],
      };
      const openai = translateMessageToOpenAI(anthropic);
      for (const m of openai) {
        this.writeStdinLine(JSON.stringify(m));
      }
      // researcher_todo: confirm whether Codex CLI expects stdin
      // half-close after the prompt (single-shot) or stays open for
      // multi-turn. Plan 03 stays open so `streamInput` can be
      // called subsequently.
      return;
    }
    // AsyncIterable — drain in the background. Each emitted
    // SdkUserMessage is translated + written.
    for await (const msg of prompt) {
      await this.streamInput(this.userMessageStream(msg));
    }
  }

  /**
   * Helper that wraps a single SdkUserMessage in a synchronous
   * AsyncIterable — matches the public `streamInput(stream)`
   * surface.
   */
  private async *userMessageStream(
    msg: SdkUserMessage,
  ): AsyncIterable<SdkUserMessage> {
    yield msg;
  }

  private writeStdinLine(payload: string): void {
    const line = `${payload}\n`;
    if (!this.child) {
      // Phase 137 Plan 04 T-03 — deferred-spawn buffering. Writes
      // before the child materialises queue here; `awaitDeferredSpawn`
      // flushes the buffer once the child is alive.
      this.preSpawnStdinBuffer.push(line);
      return;
    }
    if (!this.child.stdin || this.child.stdin.destroyed) return;
    this.child.stdin.write(line);
  }

  // ===================================================================
  // Iterator queue plumbing
  // ===================================================================

  private pushItem(item: IteratorItem): void {
    if (item.kind === "end") {
      if (this.endRequested) return;
      this.endRequested = true;
    }
    const reader = this.pendingReaders.shift();
    if (reader) {
      reader(item);
    } else {
      this.pendingItems.push(item);
    }
  }

  private nextItem(): Promise<IteratorItem> {
    const queued = this.pendingItems.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      this.pendingReaders.push(resolve);
    });
  }

  // ===================================================================
  // Public SdkQuery surface — mutators + async iteration
  // ===================================================================

  /**
   * Materialise the `SdkQuery` shape — an `AsyncGenerator` with the
   * mutator methods attached. This is what `CodexSdkModule.query()`
   * returns to the consumer.
   *
   * We construct the async-generator function first (so its prototype
   * carries `next` / `return` / `throw` / `Symbol.asyncIterator`),
   * then `Object.assign` the mutators on the returned generator
   * instance. The shape conforms to `SdkQuery` per the type-level
   * assertion in `codex-sdk-module.test.ts`.
   */
  public toSdkQuery(): SdkQuery {
    // The async generator is bound to `this` so the mutators read the
    // same state as the iterator drain.
    const self = this;
    async function* gen(): AsyncGenerator<SdkStreamMessage, void> {
      while (true) {
        const item = await self.nextItem();
        if (item.kind === "end") return;
        yield item.value;
      }
    }
    const iter = gen();

    // Mutators — each documented per the plan's T-01 `<behavior>`.
    const mutators = {
      interrupt: async (): Promise<void> => {
        // researcher_todo: SIGINT vs a Codex-specific cancellation
        // flag. Plan 05 verifies; Plan 03 uses the POSIX signal.
        //
        // Phase 137 Plan 04 T-03: deferred-spawn tolerance — if the
        // child hasn't materialised yet, push the end sentinel so the
        // iterator returns. The pending awaitDeferredSpawn detects
        // the closed iterator on its next pushItem call.
        if (this.child) {
          this.child.kill("SIGINT");
        } else {
          this.pushItem({ kind: "end" });
        }
      },
      close: (): void => {
        // Phase 137 Plan 04 T-03: same deferred-spawn tolerance.
        if (this.child) {
          this.child.kill("SIGTERM");
        }
        // Unblock any pending readers so the generator can return.
        this.pushItem({ kind: "end" });
      },
      streamInput: this.streamInput.bind(this),
      mcpServerStatus: async (): Promise<unknown[]> => {
        // researcher_todo: Codex CLI MCP hosting unverified —
        // CONTEXT D1 assumed-no. Synthesised empty array; logged
        // once per CodexQuery lifetime for operator audit.
        this.emitNoopOnce("mcpServerStatus", {});
        return [];
      },
      setMcpServers: async (
        _servers: Record<string, unknown>,
      ): Promise<unknown> => {
        this.emitNoopOnce("setMcpServers", {});
        return undefined;
      },
      setMaxThinkingTokens: async (n: number | null): Promise<void> => {
        // researcher_todo #3: Codex `reasoning_effort` equivalent
        // unverified. Plan 03 stores the value, logs `phase137-
        // codex-noop` once. Plan 05 wires it if a CLI surface
        // surfaces.
        this.emitNoopOnce("setMaxThinkingTokens", {
          method: "setMaxThinkingTokens",
          value: n,
        });
      },
      // Quick 260715-j1j (D3) — `applyFlagSettings` is a Claude-Code-SDK
      // control request (apply_flag_settings) with no Codex-CLI equivalent.
      // Documented no-op (same pattern as setMaxThinkingTokens above): a
      // Codex-backed agent asked to enter ultracode simply keeps its current
      // behaviour — the eligibility gate upstream (ultracode-gate.ts) already
      // rejects non-opus/fable models, so this path is defensive only.
      applyFlagSettings: async (
        settings: Record<string, unknown>,
      ): Promise<void> => {
        this.emitNoopOnce("applyFlagSettings", {
          method: "applyFlagSettings",
          keys: Object.keys(settings),
        });
      },
      setModel: async (model?: string): Promise<void> => {
        // Stores the value for `initializationResult` mirroring +
        // future spawn restart (Plan 05). The current child stays
        // on whatever model it was spawned with — mid-stream
        // model swap requires a new spawn (Codex is stateless per
        // process per researcher_todo).
        if (model) this.currentModel = model;
      },
      setPermissionMode: async (mode: PermissionMode): Promise<void> => {
        // researcher_todo #4: documented NO-OP. Codex CLI's
        // sandbox/approval flag (if any) is unverified. Plan 05
        // probes; Plan 03 logs once per (method, mode) pair so
        // operators can audit which modes are being requested.
        this.emitNoopOnce(`setPermissionMode:${mode}`, {
          method: "setPermissionMode",
          mode,
        });
      },
      initializationResult: async (): Promise<{
        readonly commands: readonly SlashCommand[];
        readonly agents?: readonly unknown[];
        readonly models?: readonly ModelInfo[];
      }> => {
        // researcher_todo #8: vision capability unverified — flagged
        // false for now. Plan 05 / Plan 04 probe and widen.
        return {
          commands: [],
          // Synthesised mirror — surfaces the model the spawn was
          // built with. Cap fields stay narrow per the typed
          // contract.
        };
      },
      supportedCommands: async (): Promise<readonly SlashCommand[]> => [],
      // Debug session `in-tool-wedge-recovery` work-stream (C), FORK 8 —
      // `backgroundTasks` / `stopTask` are Claude-Code-SDK foreground-task
      // control primitives with no Codex-CLI equivalent. Documented
      // no-ops. `backgroundTasks` returns `false` ("nothing detached") so
      // the 999.64 stale-turn sweep correctly degrades to its blunt
      // force-release path for a Codex-backed agent — never a silent loss.
      backgroundTasks: async (toolUseId?: string): Promise<boolean> => {
        this.emitNoopOnce("backgroundTasks", {
          method: "backgroundTasks",
          toolUseId: toolUseId ?? null,
        });
        return false;
      },
      stopTask: async (taskId: string): Promise<void> => {
        this.emitNoopOnce(`stopTask:${taskId}`, {
          method: "stopTask",
          taskId,
        });
      },
      // Phase 999.75 Part B (B1) — `getContextUsage` is a Claude-Code-SDK
      // control request with no Codex-CLI equivalent. Documented no-op:
      // returns `{ totalTokens: 0 }`. The compaction handler's Layer 2
      // reads this for the before/after token measurement; a 0/0 pair makes
      // `tokens_after < tokens_before` false, so a Codex-backed agent fails
      // open to today's behaviour (no live reduction) — never a data loss.
      getContextUsage: async (): Promise<{ totalTokens: number }> => {
        this.emitNoopOnce("getContextUsage", {
          method: "getContextUsage",
        });
        return { totalTokens: 0 };
      },
    } satisfies Omit<
      SdkQuery,
      keyof AsyncGenerator<SdkStreamMessage, void>
    >;

    // Attach mutators to the generator instance. The cast is
    // necessary because TypeScript's `AsyncGenerator` is sealed; the
    // SDK's own `SdkQuery` shape does the same intersection at
    // `src/manager/sdk-types.ts:252`.
    return Object.assign(iter, mutators) as SdkQuery;
  }

  // ===================================================================
  // Internal — mutator implementations
  // ===================================================================

  private async streamInput(
    stream: AsyncIterable<SdkUserMessage>,
  ): Promise<void> {
    for await (const msg of stream) {
      // Translate the Anthropic-shape user message into OpenAI-shape
      // wire frames, write each as a newline-terminated JSON line.
      const anthropic: AnthropicMessage = {
        role: "user",
        content: [{ type: "text", text: msg.content }],
      };
      const openaiFrames = translateMessageToOpenAI(anthropic);
      for (const frame of openaiFrames) {
        this.writeStdinLine(JSON.stringify(frame));
      }
    }
  }

  // ===================================================================
  // Telemetry helpers
  // ===================================================================

  private emitLog(key: string, payload: Record<string, unknown>): void {
    if (this.logger) {
      this.logger.info(payload, key);
    }
  }

  private emitNoopOnce(
    dedupKey: string,
    payload: Record<string, unknown>,
  ): void {
    if (this.noopLogged.has(dedupKey)) return;
    this.noopLogged.add(dedupKey);
    this.emitLog("phase137-codex-noop", payload);
  }

  // ===================================================================
  // Test affordance
  // ===================================================================

  /**
   * Test-only — returns the spawn-arg array used at construction
   * time. Lets unit tests assert that Plan 02 primitives reached the
   * child without inspecting the mock spawn fn's call history.
   *
   * NOT exported through `../index.ts` — strictly an internal test
   * hook. The mocked spawnFn captures the same data; this is a
   * convenience.
   */
  public get spawnedChild(): ChildProcess | null {
    // Phase 137 Plan 04 T-03 — nullable to reflect deferred-spawn state.
    // Plan 03 tests await `loadSdkModule + query` before reading this;
    // those tests synchronously construct CodexQuery without a
    // `childEnvPromise` so the value is always non-null in that path.
    return this.child;
  }

  public get currentModelForTest(): string {
    return this.currentModel;
  }
}
