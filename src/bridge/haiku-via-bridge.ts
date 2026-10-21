/**
 * Phase 999.58 Plan 02 (C7) — `runHaikuViaBridge`
 * ------------------------------------------------
 *
 * Single-turn `claude` binary invocation that replaces the in-process
 * Anthropic-SDK calls previously living in
 * `src/manager/haiku-direct.ts`. Spawns the pre-installed `claude`
 * binary in `--print --output-format stream-json --input-format
 * stream-json` mode, pipes one user-turn JSON payload into stdin,
 * reads NDJSON from stdout, accumulates assistant text + result-event
 * cost, and resolves to a `HaikuBridgeResult`.
 *
 * **Load-bearing OAuth billing invariant** (advisor-flagged
 * 2026-05-17, documented at `src/manager/haiku-direct.ts:1-11`):
 * `buildSpawnEnv()` DELETES `ANTHROPIC_API_KEY` from the spawn env
 * BEFORE handing it to the child. This forces the spawned binary to
 * fall through to `~/.claude/.credentials.json` for OAuth bearer-
 * token auth — preserving the subscription-billing path that the
 * legacy SDK route depended on. Without the delete the binary would
 * inherit the daemon's `/etc/clawcode/env` ANTHROPIC_API_KEY and bill
 * the wrong account.
 *
 * NO Anthropic-SDK package import here — the module is wire-
 * layer-only. Only Node built-ins + pino.
 *
 * Per-call telemetry log line `phase999.58-haiku-direct` emits
 * `{site, model, durationMs, costUsd, succeeded}` for every
 * invocation across all four consumer sites
 * (summarizer / vision-pre-pass / dream-pass / skill-distiller).
 * D-06 latency budget verified by the test fixture's synthetic
 * p95 ≤ 500ms gate (B8).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import pino, { type Logger } from "pino";
// Spawn-env credential composition delegates to the single-source-of-truth
// helper in src/manager/spawn-env.ts.
import { buildAnthropicSafeEnv } from "../manager/spawn-env.js";
import { resolveModelId } from "../manager/model-resolver.js";
// P3 (3a) — spawn governance for this raw-spawn path (slot + pid census +
// hard per-site timeouts).
import {
  withBridgeSpawnSlot,
  registerBridgeChild,
  unregisterBridgeChild,
  childTimeoutMsForSite,
} from "./bridge-spawn-governor.js";

let log: Logger = pino({ name: "phase999.58-haiku-direct" });

/**
 * Test-only: replace the module-scoped logger so tests can capture
 * structured log calls without needing to intercept pino's fd-level
 * writeSync path. Production code never calls this — pino's default
 * destination is correct.
 */
export function _setLoggerForTests(logger: Logger): void {
  log = logger;
}

/** Test-only: restore the production logger. */
export function _resetLoggerForTests(): void {
  log = pino({ name: "phase999.58-haiku-direct" });
}

/**
 * Consumer site identifiers for telemetry attribution. Extend this
 * union when wiring a new consumer (each name surfaces in the
 * `{site}` field of the per-call telemetry line).
 *
 * - `summarizer`     — session summarizer (Phase 99)
 * - `vision-pre-pass`— chart-vision pre-pass (Phase 113)
 * - `dream-pass`     — memory consolidation dispatch (Phase 95)
 * - `skill-distiller`— phase132 skill-distiller Haiku worker
 *                      (daemon.ts:3436)
 */
export type HaikuBridgeSite =
  | "summarizer"
  | "vision-pre-pass"
  | "dream-pass"
  | "skill-distiller"
  | "voice-fallback"
  // Phase 999.100 — mid-turn intent classifier (steer / new_task / stop).
  | "midturn-intent"
  // INC-2026-08-10 — editorial pass over a finished workflow's worker results,
  // producing the brief PDF's title / bottom line / per-step condensation.
  | "workflow-report"
  // Phase 999.154 — batched structured image analysis for auto-ingest, the
  // vision health canary, and Claude-vision OCR routed through the binary.
  | "ingest-vision"
  | "vision-canary"
  | "ocr-vision"
  | "fast-lane"
  // 999.231 — the fact-check reviewer: one trimmed, tool-less call per draft.
  | "fact-check";

/** Phase 999.154 — one image block for a multimodal bridge call. */
export type BridgeImage = {
  readonly mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  /** Raw base64 (no data: prefix). */
  readonly data: string;
  /**
   * Optional text block emitted immediately BEFORE the image. Batched calls
   * MUST label every image: measured 2026-09-22, an unlabeled 9-image batch
   * came back misaligned on near-duplicates; labeled batches aligned 2/2.
   */
  readonly label?: string;
};

export type HaikuBridgeArgs = {
  readonly site: HaikuBridgeSite;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  // Phase 142 — the bridge can run ANY model the binary supports. The wire
  // network behaviour is the binary's regardless of `--model`. `resolveModelId("haiku")` ===
  // `HAIKU_MODEL_ID`, so the existing haiku consumers (summarizer/dream/vision/
  // voice/skill-distiller) are byte-identical; only a non-haiku caller (the
  // optimizer judge/proposer) takes a different `--model`. NOTE: the raw
  // SDK-direct OAuth route (callModelDirect's "direct" branch) 429s for
  // opus/sonnet — the binary path here is the ONLY working non-haiku route.
  readonly model: "haiku" | "sonnet" | "opus";
  readonly maxTokens?: number;
  /**
   * Phase 999.154 — multimodal input. When non-empty the call switches to
   * `--input-format stream-json` with a full user envelope (text prompt,
   * then each image preceded by its label). Text-only calls are unchanged
   * (plain-text stdin — the E2BIG fix).
   */
  readonly images?: ReadonlyArray<BridgeImage>;
  /** Legacy single-image form; folded into `images` by `resolveImages`. */
  readonly imageBase64?: string;
  readonly mediaType?:
    | "image/png"
    | "image/jpeg"
    | "image/gif"
    | "image/webp";
  readonly signal?: AbortSignal;
  /**
   * Phase 999.161 v1.1 — trimmed CLI startup for one-shot text calls: skip
   * settings (hooks, plugins, output style), MCP servers and tool schemas.
   * Measured on clawdy as the daemon user: 3.8 s → 2.3 s per call. Opt-in
   * per call site (the fast lane sets it); never for a call that relies on
   * settings-provided behaviour.
   */
  readonly trimmedStartup?: boolean;
};

export type HaikuBridgeResult = {
  readonly text: string;
  readonly durationMs: number;
  readonly costUsd: number | null;
  readonly succeeded: boolean;
};

// ----------------------------------------------------------------
// Binary path resolution + cache
// ----------------------------------------------------------------

let cachedBinaryPath: string | null = null;
let cachedFallbackWarned = false;

/**
 * Resolves the `claude` binary path. Cascade per
 * `999.58-backlog.md §A3`:
 *   1. `which claude` on PATH
 *   2. `~/.local/bin/claude`
 *   3. `/usr/local/bin/claude`
 *   4. `/opt/claude/bin/claude`
 *   5. SDK-bundled binary at
 *      `node_modules/<sdk-package>/cli` (bundled binary)
 *
 * Result is module-scope cached; resets via
 * `_resetBinaryPathCacheForTests()`. The final fallback emits a
 * `phase999.58-haiku-direct {fallback:true,path}` warn ONCE per
 * cache lifetime.
 */
export function resolveBinaryPath(): string {
  if (cachedBinaryPath !== null) return cachedBinaryPath;

  // 1. PATH lookup via `which`.
  try {
    const whichOut = execFileSync("which", ["claude"], {
      encoding: "utf-8",
    }).trim();
    if (whichOut.length > 0 && existsSync(whichOut)) {
      cachedBinaryPath = whichOut;
      return cachedBinaryPath;
    }
  } catch {
    // `which` exits non-zero when not found — fall through to
    // the static cascade below.
  }

  // 2-4. Static fallback list.
  const candidates = [
    join(homedir(), ".local", "bin", "claude"),
    "/usr/local/bin/claude",
    "/opt/claude/bin/claude",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cachedBinaryPath = candidate;
      return cachedBinaryPath;
    }
  }

  // 5. SDK-bundled binary — final fallback. Resolve relative to
  // this module's location: src/bridge/haiku-via-bridge.{ts,js} →
  // walk up to project root → node_modules/@anthropic-ai/...
  try {
    const here = fileURLToPath(import.meta.url);
    // .../src/bridge/haiku-via-bridge.js → .../src/bridge → .../src → .../
    const projectRoot = dirname(dirname(dirname(here)));
    const sdkBundled = join(
      projectRoot,
      "node_modules",
      "@anthropic-ai",
      "claude-agent-sdk-linux-x64",
      "cli",
    );
    if (existsSync(sdkBundled)) {
      cachedBinaryPath = sdkBundled;
      if (!cachedFallbackWarned) {
        log.warn(
          {
            tag: "phase999.58-haiku-direct",
            fallback: true,
            path: sdkBundled,
          },
          "claude binary path fallback — SDK-bundled cli",
        );
        cachedFallbackWarned = true;
      }
      return cachedBinaryPath;
    }
  } catch {
    // import.meta.url unavailable (e.g. odd vitest config) — fall
    // through and hard-fail below with a clear message.
  }

  // Nothing found. Cache `claude` as the last-ditch attempt so
  // spawn can surface the actual ENOENT instead of throwing here.
  cachedBinaryPath = "claude";
  return cachedBinaryPath;
}

/** Test-only: clear the resolved-path + fallback-warned caches. */
export function _resetBinaryPathCacheForTests(): void {
  cachedBinaryPath = null;
  cachedFallbackWarned = false;
}

// ----------------------------------------------------------------
// Spawn env shaping — OAuth billing preservation invariant
// ----------------------------------------------------------------

/**
 * Builds the env handed to the spawned `claude` binary. The ANTHROPIC_API_KEY
 * strip is LOAD-BEARING: without it the spawned binary inherits the daemon's
 * `ANTHROPIC_API_KEY` and bills the API-key account instead of the OAuth
 * subscription. The strip lives in `buildAnthropicSafeEnv`.
 */
export function buildSpawnEnv(): NodeJS.ProcessEnv {
  return buildAnthropicSafeEnv() as NodeJS.ProcessEnv;
}

// ----------------------------------------------------------------
// Stream-json message accumulator
// ----------------------------------------------------------------

/**
 * Accumulates text from `assistant` events and cost from `result`
 * events. Tolerates non-JSON noise lines (logs them at trace) so a
 * malformed stream-json frame doesn't fail the whole call — the
 * `succeeded` flag is set by the child's exit code, not by JSON
 * shape.
 */
/**
 * Max length of the captured `failureReason`. Bounded like `stderrTail`.
 */
const FAILURE_REASON_MAX_LENGTH = 300;

/**
 * The `model` value the CLI stamps on error envelopes it generates itself
 * (verified 2026-08-28 against a forced over-context call). A `<synthetic>`
 * assistant message is never model output — it is the CLI reporting its own
 * failure on stdout, which is why `stderrTail` is empty for this whole class
 * of failure. Capturing it is therefore compatible with the T-999.58-12
 * information-disclosure mitigation: real response content still never
 * reaches the log.
 */
const SYNTHETIC_MODEL_MARKER = "<synthetic>";

function accumulateNdjsonLine(
  line: string,
  acc: {
    text: string;
    costUsd: number | null;
    failureReason: string | null;
    resultSubtype: string | null;
    resultIsError: boolean;
  },
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return; // tolerate non-JSON keep-alive or banner lines
  }
  if (parsed === null || typeof parsed !== "object") return;
  const obj = parsed as Record<string, unknown>;
  const type = obj.type;

  if (type === "assistant") {
    const message = obj.message as Record<string, unknown> | undefined;
    const content = message?.content;
    // A `<synthetic>` model stamp means the CLI authored this envelope to
    // report its own failure (e.g. "Prompt is too long ..."). Route it to
    // failureReason instead of the response accumulator so the operator
    // gets a diagnosis without response content ever being logged.
    const isSynthetic = message?.model === SYNTHETIC_MODEL_MARKER;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          block !== null &&
          typeof block === "object" &&
          (block as Record<string, unknown>).type === "text"
        ) {
          const text = (block as Record<string, unknown>).text;
          if (typeof text === "string") {
            if (isSynthetic) {
              acc.failureReason = (acc.failureReason ?? "") + text;
            } else {
              acc.text += text;
            }
          }
        }
      }
    }
    if (acc.failureReason !== null) {
      acc.failureReason = acc.failureReason.slice(0, FAILURE_REASON_MAX_LENGTH);
    }
    return;
  }

  if (type === "result") {
    const cost = obj.total_cost_usd;
    if (typeof cost === "number" && Number.isFinite(cost)) {
      acc.costUsd = cost;
    }
    // A failure that exits 1 WITHOUT emitting a `<synthetic>` assistant block
    // would otherwise still log as `exitCode:1, stderrTail:""` — i.e. the very
    // shape this capture exists to eliminate. Record non-content signals off
    // the result frame as a fallback so every failure carries *something*.
    // `subtype` is unreliable on its own (an over-context failure reports
    // subtype "success"), which is exactly why it is kept as a labelled
    // breadcrumb rather than used to infer success/failure.
    if (typeof obj.subtype === "string") {
      acc.resultSubtype = obj.subtype;
    }
    if (obj.is_error === true) {
      acc.resultIsError = true;
    }
  }
}

// ----------------------------------------------------------------
// Single-turn JSON payload builder
// ----------------------------------------------------------------

/**
 * Phase 999.154 — normalize the legacy single-image fields and `images` into
 * one list. Empty ⇒ text-only call.
 */
export function resolveImages(args: HaikuBridgeArgs): ReadonlyArray<BridgeImage> {
  if (args.images !== undefined && args.images.length > 0) return args.images;
  if (args.imageBase64 !== undefined && args.mediaType !== undefined) {
    return [{ mediaType: args.mediaType, data: args.imageBase64 }];
  }
  return [];
}

/**
 * Build the stream-json user envelope for a multimodal call.
 *
 * The envelope MUST carry `parent_tool_use_id` and `session_id`: the fu6-era
 * builder omitted them and the binary silently rejected the line (SessionStart
 * hooks ran, then exit 1 with no output). With both fields present the image
 * round-trips — verified on CLI 2.1.257 (prod pin) and 2.1.278, 2026-09-22.
 */
export function buildUserTurnJson(
  userPrompt: string,
  images: ReadonlyArray<BridgeImage>,
): string {
  const content: Array<Record<string, unknown>> = [];
  if (userPrompt.length > 0) content.push({ type: "text", text: userPrompt });
  for (const img of images) {
    if (img.label !== undefined && img.label.length > 0) {
      content.push({ type: "text", text: img.label });
    }
    content.push({
      type: "image",
      source: { type: "base64", media_type: img.mediaType, data: img.data },
    });
  }
  return JSON.stringify({
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    session_id: "",
  });
}

// ----------------------------------------------------------------
// Public API — runHaikuViaBridge
// ----------------------------------------------------------------

/**
 * Spawns the resolved `claude` binary, pipes a single-turn payload
 * to stdin, reads stream-json NDJSON from stdout, and resolves to a
 * `HaikuBridgeResult`. Emits exactly one `phase999.58-haiku-direct`
 * telemetry line per invocation (success OR failure).
 *
 * Failure semantics match the legacy `callHaikuDirect` contract
 * (empty string on failure — per
 * `src/manager/__tests__/daemon-consolidation-auth.test.ts`):
 * non-zero exit OR abort signal resolves to
 * `{text:"", succeeded:false}`. Caller decides what to do with
 * `succeeded:false`.
 */
export async function runHaikuViaBridge(
  args: HaikuBridgeArgs,
): Promise<HaikuBridgeResult> {
  // P3 (3a) — bridge spawn governance: FIFO slot (soft-timeout fail-open)
  // around the whole spawn+await; pid registry + hard child timeout are
  // wired at the spawn site inside. See bridge-spawn-governor.ts.
  return withBridgeSpawnSlot(args.site ?? "summarizer", log, () =>
    runHaikuViaBridgeInner(args),
  );
}

/** Phase 999.161 v1.1 — argv that makes a one-shot spawn skip settings/hooks/plugins and MCP. */
export const TRIMMED_STARTUP_ARGS: readonly string[] = ["--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'];

async function runHaikuViaBridgeInner(
  args: HaikuBridgeArgs,
): Promise<HaikuBridgeResult> {
  const t0 = performance.now();
  const binPath = resolveBinaryPath();
  // resolveModelId("haiku") === HAIKU_MODEL_ID, so haiku callers are unchanged.
  const modelId = resolveModelId(args.model);
  // Phase 999.161 v1.2 — on a trimmed one-shot, also skip the CLI's
  // non-essential startup traffic (feature-flag fetch, telemetry, update and
  // plugin-archive checks): measured on clawdy as the daemon user, the trimmed
  // spawn drops from 2.4 s to 1.3–1.5 s — what remains is the API round trip.
  const env: NodeJS.ProcessEnv = args.trimmedStartup
    ? { ...buildSpawnEnv(), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }
    : buildSpawnEnv();
  const acc = {
    text: "",
    costUsd: null as number | null,
    failureReason: null as string | null,
    resultSubtype: null as string | null,
    resultIsError: false,
  };
  // Phase 999.58-fu6 (2026-05-18): args.maxTokens is accepted on the
  // input args interface for forward-compat but is NOT plumbed through
  // to the claude CLI — the binary doesn't accept `--max-tokens` as a
  // command-line flag (verified against `claude --help` on the deployed
  // 2.1.142 binary; valid limit flags are only `--effort` and
  // `--max-budget-usd`). Callers' max-token intent is currently
  // advisory; the binary uses its model-specific default. To enforce
  // a per-call cap, move max_tokens into the JSON stream-json input
  // body — separate follow-up.
  void args.maxTokens;

  // userPrompt delivery: TEXT-mode stdin (no --input-format, no positional
  // arg). See the `child.stdin.write` below.
  //
  // History: Phase 999.58-fu6 (2026-05-18) moved the prompt to a POSITIONAL
  // arg after the stream-json *stdin* path (`--input-format=stream-json` +
  // `{type:"user",message:{...}}`) was silently rejected by the binary
  // (needs `parent_tool_use_id` etc.). But a positional arg has an ARG_MAX
  // ceiling: large dream / summary / consolidation prompts overflow it and
  // `spawn` throws `E2BIG` ("Argument list too long") — verified on prod
  // 2026-06-18 (a 300KB positional arg → E2BIG; a real dream-pass logged
  // `err:"spawn E2BIG"`). The fix is PLAIN-TEXT stdin: with `--print` and no
  // positional arg the binary reads the prompt from stdin directly. This is
  // NOT the stream-json stdin path — no `--input-format`, no envelope — so it
  // sidesteps the fu6 rejection. Validated on the deployed 2.1.181 binary:
  // 300KB stdin prompt → clean result, and stdin + `--system-prompt` together
  // still read stdin as the user turn.
  //
  // Phase 999.154 — multimodal calls take the stream-json stdin path with a
  // full envelope (see buildUserTurnJson). `--tools ""` keeps a vision call a
  // pure one-shot: the model must answer from the pixels it was handed, never
  // go looking for a file path mentioned in the prompt.
  const images = resolveImages(args);
  const multimodal = images.length > 0;

  const childArgs = [
    "--print",
    // --verbose required when --print + --output-format=stream-json.
    "--verbose",
    "--output-format",
    "stream-json",
    "--model",
    modelId,
    // --system-prompt (NOT --system; --system doesn't exist).
    "--system-prompt",
    args.systemPrompt,
    // NOTE: userPrompt is NOT a positional arg — it is piped to stdin in
    // text mode (see child.stdin.write below). This is the E2BIG fix.
    ...(multimodal ? ["--input-format", "stream-json", "--tools", ""] : []),
    // Phase 999.161 v1.1 — see HaikuBridgeArgs.trimmedStartup. `--tools ""` is
    // already on the multimodal path above.
    ...(args.trimmedStartup ? TRIMMED_STARTUP_ARGS : []),
    ...(args.trimmedStartup && !multimodal ? ["--tools", ""] : []),
  ];

  let child: ChildProcess;
  try {
    child = spawn(binPath, childArgs, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (spawnErr) {
    const durationMs = performance.now() - t0;
    log.info(
      {
        tag: "phase999.58-haiku-direct",
        site: args.site,
        model: modelId,
        durationMs,
        costUsd: null,
        succeeded: false,
        err: spawnErr instanceof Error ? spawnErr.message : String(spawnErr),
      },
      "haiku-direct bridge spawn failed",
    );
    return { text: "", durationMs, costUsd: null, succeeded: false };
  }

  // Wire abort signal — SIGTERM the child on abort.
  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
    if (!child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Child may have already exited between the abort event
        // and the kill call — swallow.
      }
    }
  };
  if (args.signal !== undefined) {
    if (args.signal.aborted) {
      onAbort();
    } else {
      args.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  // Deliver userPrompt via TEXT-mode stdin (see childArgs note above) — the
  // E2BIG fix. Large prompts that overflow ARG_MAX as a positional arg pipe
  // cleanly through stdin. Write the prompt, then end() so the binary sees
  // EOF and proceeds. The `error` handler swallows EPIPE for the case where
  // the child exits (or is SIGTERM'd on abort) before draining stdin.
  if (child.stdin) {
    child.stdin.on("error", () => {
      // EPIPE / write-after-end when the child exits early — non-fatal;
      // the exit code + abort flag below already determine success.
    });
    child.stdin.write(
      multimodal
        ? `${buildUserTurnJson(args.userPrompt, images)}\n`
        : args.userPrompt,
    );
    child.stdin.end();
  }

  // Stream stdout NDJSON.
  if (child.stdout) {
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => accumulateNdjsonLine(line, acc));
  }

  // Collect stderr for the failure log line (no prompt content).
  let stderrTail = "";
  if (child.stderr) {
    child.stderr.on("data", (chunk: Buffer | string) => {
      const next = stderrTail + chunk.toString();
      // Keep only last 512 chars — bounded memory for long-running
      // failure stderr; not log-emitted unless succeeded:false.
      stderrTail = next.length > 512 ? next.slice(-512) : next;
    });
  }

  // P3 (3a) — census registration + hard per-site child timeout. The
  // timeout is the property this path never had: SIGTERM at the site
  // ceiling, SIGKILL 10s later (reaper choreography), timers unref'd so
  // they can never hold a shutdown open.
  if (typeof child.pid === "number") registerBridgeChild(child.pid);
  const hardTimeoutMs = childTimeoutMsForSite(args.site ?? "summarizer");
  let timedOut = false;
  const termTimer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGTERM");
    } catch {
      /* already exited */
    }
    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already exited */
      }
    }, 10_000);
    (killTimer as { unref?: () => void }).unref?.();
  }, hardTimeoutMs);
  (termTimer as { unref?: () => void }).unref?.();

  const exitCode: number = await new Promise((resolve) => {
    child.on("close", (code) => resolve(code ?? -1));
    child.on("error", () => resolve(-1));
  });

  clearTimeout(termTimer);
  if (typeof child.pid === "number") unregisterBridgeChild(child.pid);
  if (timedOut) {
    log.warn(
      { tag: "bridge-spawn-governor", site: args.site, hardTimeoutMs },
      "haiku-direct child hit the hard timeout and was terminated",
    );
  }

  if (args.signal !== undefined) {
    args.signal.removeEventListener("abort", onAbort);
  }

  const durationMs = performance.now() - t0;
  const succeeded = exitCode === 0 && !aborted;

  log.info(
    {
      tag: "phase999.58-haiku-direct",
      site: args.site,
      model: modelId,
      durationMs,
      costUsd: acc.costUsd,
      succeeded,
      ...(multimodal ? { imageCount: images.length } : {}),
      // Per T-999.58-12 information-disclosure mitigation: no
      // prompt content, no response content. Only stderr tail on
      // failure (operator-debuggable, bounded) — plus, when the CLI
      // reported the failure on STDOUT as a `<synthetic>` envelope,
      // its own reason. Without the latter this entire failure class
      // logs as `exitCode:1, stderrTail:""` and is undiagnosable
      // (2026-08-28: hid a 14-day Admin Clawdy dream outage).
      ...(succeeded
        ? {}
        : {
            exitCode,
            stderrTail,
            ...(acc.failureReason !== null
              ? { failureReason: acc.failureReason }
              : {}),
            ...(acc.resultSubtype !== null
              ? { resultSubtype: acc.resultSubtype }
              : {}),
            ...(acc.resultIsError ? { resultIsError: true } : {}),
          }),
    },
    succeeded
      ? "haiku-direct bridge call complete"
      : "haiku-direct bridge call failed",
  );

  return {
    text: succeeded ? acc.text : "",
    durationMs,
    costUsd: acc.costUsd,
    succeeded,
  };
}
