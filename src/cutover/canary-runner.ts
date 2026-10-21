/**
 * Phase 92 Plan 05 — Dual-entry canary runner (CUT-08, D-08).
 *
 * For each `CanaryPrompt` (from `synthesizeCanaryPrompts`), invoke the
 * cutover candidate via BOTH production entry points:
 *
 *   1. Discord bot path — `deps.dispatchStream(...)` against the canary
 *      channel. In production this wraps `TurnDispatcher.dispatchStream`
 *      with `origin = makeRootOrigin('discord', CANARY_CHANNEL_ID)`. In
 *      tests it's a `vi.fn()` stub.
 *
 *   2. API path — `deps.fetchApi(url, body)` POSTs an OpenAI-shape
 *      `{model: "clawcode/<agent>", messages: [{role:"user", content}]}`
 *      to `http://localhost:3101/v1/chat/completions` (Phase 73). In
 *      production this wraps Node 22's native `fetch`. In tests it's a
 *      `vi.fn()` stub.
 *
 * 20 prompts × 2 paths = 40 invocations per run. Each invocation has a
 * 30s timeout (D-08). Timeout = failure (status="failed-timeout") and the
 * runner moves on to the next path/prompt — no batch abort.
 *
 * Pass criteria per invocation:
 *   - API:         HTTP 200 + non-empty response text
 *   - Discord bot: non-empty reply within timeout
 *
 * Results are sorted by (intent ASC, path ASC) for deterministic output
 * ordering. ANY failure → passRate < 100 → Plan 92-06's set-authoritative
 * gate writes `cutover_ready: false`.
 *
 * Output is written via `canary-report-writer.writeCanaryReport` to
 * `<outputDir>/CANARY-REPORT.md` (atomic temp+rename).
 */

import type { Logger } from "pino";
import {
  CANARY_TIMEOUT_MS,
  type CanaryInvocationResult,
  type CanaryPrompt,
  type CanaryRunOutcome,
} from "./types.js";
import { writeCanaryReport } from "./canary-report-writer.js";

/**
 * DI shape — Discord bot path. Production wires
 * `(args) => turnDispatcher.dispatchStream(makeRootOrigin('discord',
 * CANARY_CHANNEL_ID), args.agentName, args.prompt, () => {})`.
 *
 * Returns the final accumulated reply text (or empty string for an
 * empty/no-op response).
 */
export type CanaryDispatchStreamFn = (args: {
  readonly agentName: string;
  readonly prompt: string;
  readonly origin: unknown;
}) => Promise<{ readonly text: string }>;

/**
 * DI shape — API path. Production wires native `fetch` with a JSON POST
 * to `http://localhost:3101/v1/chat/completions`. Returns the HTTP status
 * code + the response text already extracted from the OpenAI choices[0]
 * shape (or the raw body if not JSON).
 */
export type CanaryFetchApiFn = (
  url: string,
  body: unknown,
) => Promise<{
  readonly status: number;
  readonly text: string;
  readonly json?: unknown;
}>;

export type CanaryRunnerDeps = {
  readonly agent: string;
  readonly prompts: readonly CanaryPrompt[];
  readonly canaryChannelId: string;
  readonly apiEndpoint: string;
  readonly timeoutMs?: number;
  readonly outputDir: string;
  readonly dispatchStream: CanaryDispatchStreamFn;
  readonly fetchApi: CanaryFetchApiFn;
  readonly now?: () => Date;
  readonly log: Logger;
};

/**
 * Run a full canary cycle. Per-prompt: invoke Discord bot path then API
 * path sequentially (sequential to avoid Discord-side rate-limit
 * tripwires; the canary is a one-shot pre-cutover gate, not throughput-
 * sensitive). Each path gets its own 30s timeout via `raceWithTimeout`.
 */
export async function runCanary(
  deps: CanaryRunnerDeps,
): Promise<CanaryRunOutcome> {
  const start = Date.now();
  if (deps.prompts.length === 0) {
    return { kind: "no-prompts", agent: deps.agent };
  }
  const timeoutMs = deps.timeoutMs ?? CANARY_TIMEOUT_MS;

  const results: CanaryInvocationResult[] = [];
  for (const cp of deps.prompts) {
    // Discord bot path
    results.push(await runOneDiscordPath(cp, deps, timeoutMs));
    // API path
    results.push(await runOneApiPath(cp, deps, timeoutMs));
  }

  // Sort by (intent ASC, path ASC) for deterministic output order.
  // Spread + sort — NEVER mutate `results` in-place ahead of writing.
  const sorted: CanaryInvocationResult[] = [...results].sort((a, b) =>
    a.intent === b.intent
      ? a.path.localeCompare(b.path)
      : a.intent.localeCompare(b.intent),
  );

  const passed = sorted.filter((r) => r.status === "passed").length;
  const passRate = sorted.length === 0 ? 0 : (passed / sorted.length) * 100;

  const reportRes = await writeCanaryReport({
    agent: deps.agent,
    results: sorted,
    outputDir: deps.outputDir,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  const reportPath =
    reportRes.kind === "written" ? reportRes.reportPath : "";

  return {
    kind: "ran",
    agent: deps.agent,
    results: sorted,
    passRate,
    reportPath,
    durationMs: Date.now() - start,
  };
}

async function runOneDiscordPath(
  cp: CanaryPrompt,
  deps: CanaryRunnerDeps,
  timeoutMs: number,
): Promise<CanaryInvocationResult> {
  const t0 = Date.now();
  try {
    const result = await raceWithTimeout(
      deps.dispatchStream({
        agentName: deps.agent,
        prompt: cp.prompt,
        origin: {
          kind: "cutover-canary-discord",
          channelId: deps.canaryChannelId,
          agent: deps.agent,
        },
      }),
      timeoutMs,
    );
    if (result === "__canary_timeout__") {
      return makeResult(
        cp,
        "discord-bot",
        "failed-timeout",
        0,
        Date.now() - t0,
        `timeout after ${timeoutMs}ms`,
      );
    }
    const text = result.text ?? "";
    if (text.trim().length === 0) {
      return makeResult(
        cp,
        "discord-bot",
        "failed-empty",
        0,
        Date.now() - t0,
        null,
      );
    }
    return makeResult(
      cp,
      "discord-bot",
      "passed",
      text.length,
      Date.now() - t0,
      null,
    );
  } catch (err) {
    return makeResult(
      cp,
      "discord-bot",
      "failed-error",
      0,
      Date.now() - t0,
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function runOneApiPath(
  cp: CanaryPrompt,
  deps: CanaryRunnerDeps,
  timeoutMs: number,
): Promise<CanaryInvocationResult> {
  const t0 = Date.now();
  try {
    const body = {
      model: `clawcode/${deps.agent}`,
      messages: [{ role: "user", content: cp.prompt }],
    };
    const result = await raceWithTimeout(
      deps.fetchApi(deps.apiEndpoint, body),
      timeoutMs,
    );
    if (result === "__canary_timeout__") {
      return makeResult(
        cp,
        "api",
        "failed-timeout",
        0,
        Date.now() - t0,
        `timeout after ${timeoutMs}ms`,
      );
    }
    if (result.status < 200 || result.status >= 300) {
      return makeResult(
        cp,
        "api",
        "failed-error",
        0,
        Date.now() - t0,
        `status ${result.status}`,
      );
    }
    const text = result.text ?? "";
    if (text.trim().length === 0) {
      return makeResult(cp, "api", "failed-empty", 0, Date.now() - t0, null);
    }
    return makeResult(
      cp,
      "api",
      "passed",
      text.length,
      Date.now() - t0,
      null,
    );
  } catch (err) {
    return makeResult(
      cp,
      "api",
      "failed-error",
      0,
      Date.now() - t0,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Race a promise against a setTimeout-based timer. Returns the resolved
 * value on win, or the literal sentinel "__canary_timeout__" on timeout.
 *
 * Uses a sentinel string (rather than a thrown error) so the caller
 * doesn't have to discriminate on rejected-vs-resolved — timeout is a
 * normal control-flow path here, not an exceptional one.
 *
 * The setTimeout handle is cleared in `finally` so the event loop drains
 * cleanly even on the success path. R3 test pins fake-timer behavior.
 */
async function raceWithTimeout<T>(
  p: Promise<T>,
  ms: number,
): Promise<T | "__canary_timeout__"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<"__canary_timeout__">((resolve) => {
    timer = setTimeout(() => resolve("__canary_timeout__"), ms);
  });
  try {
    return await Promise.race([p, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function makeResult(
  cp: CanaryPrompt,
  path: "discord-bot" | "api",
  status: CanaryInvocationResult["status"],
  responseChars: number,
  durationMs: number,
  error: string | null,
): CanaryInvocationResult {
  return {
    intent: cp.intent,
    prompt: cp.prompt,
    path,
    status,
    responseChars,
    durationMs,
    error,
  };
}
