/**
 * One-shot Haiku call surface — historically backed by direct
 * @anthropic-ai/sdk in-process (Phase 95 + 99 + 113), now dispatches
 * on `bridge.haikuDirectRouting` policy per Phase 999.58 Plan 02
 * (C7):
 *
 *   - "bridge" (default) — routes via `runHaikuViaBridge` to the
 *     pre-spawned `claude` binary, the same binary the agent sessions
 *     use.
 *
 *   - "direct" (operator-flippable rollback) — lazy-imports the
 *     Anthropic-SDK package and uses the legacy in-process OAuth
 *     bearer-token cached client. Preserved as a rollback path so
 *     operators can `clawcode reload` back to the pre-Plan-02
 *     behavior without redeploy.
 *
 * **OAuth billing invariant** (preserved across both routes per
 * advisor-flagged 2026-05-17 + the historic comment block below):
 * sdk.query() spawns a claude subprocess that inherits
 * ANTHROPIC_API_KEY from /etc/clawcode/env and bills the API key
 * account. Both routes here avoid that:
 *   - "bridge" route: `buildSpawnEnv()` in haiku-via-bridge.ts
 *     DELETES ANTHROPIC_API_KEY before spawn; the binary falls
 *     through to ~/.claude/.credentials.json.
 *   - "direct" route: lazy-imported SDK with `authToken` from
 *     ~/.claude/.credentials.json, NEVER passing apiKey.
 *
 * No subprocess. No settingSources. No hooks. No ANTHROPIC_API_KEY
 * issue.
 *
 * Plan 02 D-05 static-grep regression test
 * (`src/bridge/__tests__/static-grep-no-anthropic-sdk-in-haiku-direct.test.ts`)
 * fails CI if the Anthropic-SDK package is ever re-imported at the
 * top level of this file. The lazy `await import(...)` inside the
 * direct-route branch IS allowed — it gates the SDK behind the
 * rollback policy.
 */

// Type-only — compiles to nothing; the static-grep regression test
// allows `import type` lines.
import { isVisionRefusal } from "../vision/refusal-sentinel.js";
import type Anthropic from "@anthropic-ai/sdk";

import type { HaikuBridgeSite } from "../bridge/haiku-via-bridge.js";
import { resolveModelId } from "./model-resolver.js";

/**
 * `maxTokens` overrides the per-call default (text: 2048, vision: 1024).
 * Dream-pass needs ~4096 to fit a full JSON object — without this override,
 * Haiku truncates the output mid-string and the downstream JSON.parse
 * throws "Unterminated string in JSON at position N" (see 2026-05-11
 * dream-pass parse-failed incident, surfaced after the OAuth-cache fix
 * unmasked it).
 */
export type HaikuCallOpts = {
  readonly signal?: AbortSignal;
  readonly maxTokens?: number;
  /** Phase 999.161 v1.1 — one-shot text call with a trimmed CLI startup (see HaikuBridgeArgs). */
  readonly trimmedStartup?: boolean;
};

/**
 * Generic model alias the one-shot surface accepts. Resolved to a pinned model
 * ID via `resolveModelId`. The bridge route can only run Haiku, so non-haiku
 * choices are served by the SDK-direct route (see `callModelDirect`).
 */
export type ModelChoice = "haiku" | "sonnet" | "opus";

export type VisionMediaType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp";

// ----------------------------------------------------------------
// Resolved-routing module state + daemon-installed configuration
// ----------------------------------------------------------------

/**
 * Live routing policy. Defaults to `"bridge"` per Phase 999.58 D-04.
 * The daemon installs the operator's choice at boot via
 * `configureHaikuRouting`, and the config watcher reinstalls it on
 * `bridge.haikuDirectRouting` change without daemon restart.
 */
let resolvedRouting: "bridge" | "direct" = "bridge";

/**
 * Operator-facing install hook — invoked by daemon.ts boot path +
 * onChange closure (Phase 999.58 Plan 02 T02). Hot-reload safe.
 */
/** Phase 999.154 — current routing policy, for other Claude-vision call sites. */
export function getHaikuRouting(): "bridge" | "direct" {
  return resolvedRouting;
}

export function configureHaikuRouting(policy: "bridge" | "direct"): void {
  resolvedRouting = policy;
}

/** Test-only — flip the in-process policy directly without going via the daemon. */
export function __setHaikuRoutingForTests(policy: "bridge" | "direct"): void {
  resolvedRouting = policy;
}

// ----------------------------------------------------------------
// Direct route — legacy in-process SDK path (operator rollback)
// ----------------------------------------------------------------
//
// All state + helpers below this point are exercised ONLY when
// `resolvedRouting === "direct"`. With the default policy ("bridge"),
// `loadOAuthToken` never reads ~/.claude/.credentials.json, the
// Anthropic-SDK package is never dynamically imported, and the
// cached client stays null.

let cachedClient: Anthropic | null = null;
let cachedToken: string | null = null;

async function loadOAuthToken(): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { homedir } = await import("node:os");
  const path = join(homedir(), ".claude", ".credentials.json");
  const raw = await readFile(path, "utf-8");
  const creds = JSON.parse(raw) as Record<string, unknown>;
  const oauth = creds["claudeAiOauth"] as Record<string, unknown> | undefined;
  const token = oauth?.["accessToken"];
  if (typeof token !== "string" || token.length === 0) {
    throw new Error(
      "claudeAiOauth.accessToken missing from ~/.claude/.credentials.json",
    );
  }
  return token;
}

/**
 * Token-identity cache: rebuild the SDK client whenever the access
 * token in `.credentials.json` changes (auto-refresh by spawned
 * `claude` subprocess, manual `claude login`, out-of-band Anthropic-
 * side rotation). The file is tiny (~471B) and page-cached, so
 * re-reading per call is cheaper than the watcher bookkeeping a
 * chokidar/fs.watch path would require.
 *
 * Without this — confirmed via Discord 401 incident 2026-05-11 —
 * the daemon caches a singleton Anthropic client with the *old*
 * token baked into its constructor and replays it forever. Refresh
 * rotates the token in the file but the in-process client never
 * sees the new value; every call after the rotation window hits
 * HTTP 401 "Invalid authentication credentials".
 */
async function getClient(): Promise<Anthropic> {
  // Lazy import — exercised ONLY when resolvedRouting === "direct".
  // The static-grep regression test
  // (src/bridge/__tests__/static-grep-no-anthropic-sdk-in-haiku-direct.test.ts)
  // explicitly ALLOWS this dynamic import (rollback path); it FAILS
  // CI if a top-level value import of the Anthropic-SDK package is
  // re-introduced.
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const token = await loadOAuthToken();
  if (cachedClient && cachedToken === token) return cachedClient;
  cachedClient = new Anthropic({ apiKey: null, authToken: token });
  cachedToken = token;
  return cachedClient;
}

/**
 * Defense-in-depth wrapper: if a request returns 401, invalidate
 * the cached client (in case the token rotated between
 * `loadOAuthToken()` and the SDK's HTTP send), reload, and retry
 * exactly once. Covers the race at rotation boundaries (~every 8h)
 * where the file-read and the API call straddle the refresh event.
 * Non-401 errors propagate unchanged.
 */
async function createWithAuthRetry<T>(
  attempt: (client: Anthropic) => Promise<T>,
): Promise<T> {
  const client = await getClient();
  try {
    return await attempt(client);
  } catch (err) {
    const status = (err as { status?: number } | null)?.status;
    if (status !== 401) throw err;
    cachedClient = null;
    cachedToken = null;
    const retryClient = await getClient();
    return await attempt(retryClient);
  }
}

// ----------------------------------------------------------------
// Direct-route implementations
// ----------------------------------------------------------------

async function callModelDirectViaSdk(
  systemPrompt: string,
  userPrompt: string,
  model: ModelChoice,
  opts: HaikuCallOpts,
): Promise<string> {
  const response = await createWithAuthRetry((client) =>
    client.messages.create(
      {
        model: resolveModelId(model),
        max_tokens: opts.maxTokens ?? 2048,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      },
      { signal: opts.signal },
    ),
  );
  const block = response.content[0];
  return block?.type === "text" ? block.text : "";
}

async function callHaikuVisionViaSdk(
  systemPrompt: string,
  userPrompt: string,
  imageBuffer: Buffer,
  mediaType: VisionMediaType,
  opts: HaikuCallOpts,
): Promise<string> {
  const response = await createWithAuthRetry((client) =>
    client.messages.create(
      {
        model: resolveModelId("haiku"),
        max_tokens: opts.maxTokens ?? 1024,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mediaType,
                  data: imageBuffer.toString("base64"),
                },
              },
              { type: "text", text: userPrompt },
            ],
          },
        ],
      },
      { signal: opts.signal },
    ),
  );
  const block = response.content[0];
  return block?.type === "text" ? block.text : "";
}

// ----------------------------------------------------------------
// Public API — policy-dispatch entry points
// ----------------------------------------------------------------

/**
 * One-shot text-only Haiku call. Returns the first text block
 * content, or empty string if the response has no text content or
 * the call failed.
 *
 * @param site  optional consumer-site tag for telemetry attribution
 *              (default "summarizer"). The 4 consumer sites
 *              (summarizer, vision-pre-pass, dream-pass,
 *              skill-distiller) pass their own tag; legacy callers
 *              get the default.
 */
export async function callHaikuDirect(
  systemPrompt: string,
  userPrompt: string,
  opts: HaikuCallOpts,
  site: HaikuBridgeSite = "summarizer",
  /**
   * Phase 135 Plan 03 — per-call route override.
   *
   * When set, this call uses the specified route regardless of the
   * daemon-wide `resolvedRouting` policy. Used by the voice silence
   * fallback (`src/discord/voice/silence-fallback.ts`) to honor a
   * per-agent `voice.silenceFallbackRoute` setting without flipping
   * the fleet-wide routing for other consumers (summarizer,
   * vision-pre-pass, dream-pass, skill-distiller).
   *
   * Defaults to `undefined` = use the daemon-wide
   * `resolvedRouting` policy (unchanged for all pre-Phase-135
   * call sites).
   */
  routeOverride?: "bridge" | "direct",
): Promise<string> {
  // Delegate to the model-flexible one-shot, pinned to Haiku — preserves the
  // exact legacy contract (bridge-by-default + empty-string-on-failure) that
  // existing callers (summarizer/dream/vision/voice) and tests depend on.
  return callModelDirect(systemPrompt, userPrompt, "haiku", opts, site, routeOverride);
}

/**
 * Phase 142 — one-shot text call on a CHOSEN model.
 *
 * The bridge subprocess is pinned to Haiku (`HAIKU_MODEL_ID`) and is
 * wire-fingerprint-sensitive (its whole purpose is parity with native daemon
 * traffic), so ONLY `"haiku"` takes the bridge route. `"sonnet"`/`"opus"` always
 * use the SDK-direct route — the lazy `@anthropic-ai/sdk` client built with the
 * OAuth `authToken` (billing-safe; never `apiKey`). That is the same documented
 * rollback route used by `callHaikuDirect`'s direct branch, here repurposed as
 * the only path that can run a non-Haiku model.
 *
 * Consumed by the measured optimizer's judge + proposer with the agent's
 * configured `optimizer.model` (default opus) — see daemon `runOptimizationFor`.
 */
export async function callModelDirect(
  systemPrompt: string,
  userPrompt: string,
  model: ModelChoice,
  opts: HaikuCallOpts,
  site: HaikuBridgeSite = "summarizer",
  routeOverride?: "bridge" | "direct",
): Promise<string> {
  const route = routeOverride ?? resolvedRouting;
  // The bridge spawns the `claude` binary, which runs ANY model under the
  // subscription entitlement — including opus/sonnet, which the raw SDK-direct
  // OAuth Messages API throttles (429, model-specific; verified 2026-06-03). So
  // the bridge route serves every model; the SDK-direct route below is the
  // operator rollback and is haiku-only in practice (opus/sonnet 429 there).
  if (route === "bridge") {
    const { runHaikuViaBridge } = await import("../bridge/haiku-via-bridge.js");
    const result = await runHaikuViaBridge({
      site,
      systemPrompt,
      userPrompt,
      model,
      maxTokens: opts.maxTokens,
      trimmedStartup: opts.trimmedStartup,
      signal: opts.signal,
    });
    // Match legacy contract — empty string on failure (callers
    // including daemon-consolidation-auth.test.ts depend on this).
    return result.succeeded ? result.text : "";
  }
  return callModelDirectViaSdk(systemPrompt, userPrompt, model, opts);
}

/**
 * One-shot Haiku vision call. Encodes imageBuffer as base64, sends
 * alongside userPrompt, returns the first text block content.
 *
 * @param site  defaults to "vision-pre-pass" — the only production
 *              consumer (auto-ingest-handler chart-vision via the
 *              chartVisionCall DI seam) doesn't pass `site`.
 */
export async function callHaikuVision(
  systemPrompt: string,
  userPrompt: string,
  imageBuffer: Buffer,
  mediaType: VisionMediaType,
  opts: HaikuCallOpts,
  site: HaikuBridgeSite = "vision-pre-pass",
): Promise<string> {
  if (resolvedRouting === "bridge") {
    const { runHaikuViaBridge } = await import("../bridge/haiku-via-bridge.js");
    const result = await runHaikuViaBridge({
      site,
      systemPrompt,
      userPrompt,
      model: "haiku",
      maxTokens: opts.maxTokens,
      trimmedStartup: opts.trimmedStartup,
      imageBase64: imageBuffer.toString("base64"),
      mediaType,
      signal: opts.signal,
    });
    // Phase 999.154 — never return a "no image received" reply as analysis.
    if (!result.succeeded || isVisionRefusal(result.text)) return "";
    return result.text;
  }
  return callHaikuVisionViaSdk(
    systemPrompt,
    userPrompt,
    imageBuffer,
    mediaType,
    opts,
  );
}

/**
 * Test-only: reset the cached direct-route client + token so tests
 * can re-mock credentials. No-op when routing is "bridge" (no
 * cached state to reset on that route).
 */
export function _resetClientForTests(): void {
  cachedClient = null;
  cachedToken = null;
}
