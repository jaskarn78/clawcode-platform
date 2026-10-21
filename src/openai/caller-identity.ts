/**
 * Phase 74 Plan 01 — Caller-identity discriminator (pure module).
 *
 * Given a parsed `ChatCompletionRequest` + the authenticated `ApiKeyRow` +
 * the set of known (native) agent names, decides whether the request should
 * route to the existing Phase 69 ClawCode-native driver or to the NEW
 * OpenClawTemplateDriver (Plan 01). Returns a discriminator or an error tag.
 *
 * Routing rules (74-CONTEXT D-01/D-02/D-03):
 *
 *   1. If body.model literally matches a configured top-level agent name →
 *      { kind: "clawcode-native", agentName }. This preserves Phase 69's
 *      exact behavior for current `fin-test`, `test-agent`, `admin-clawdy`
 *      traffic.
 *
 *   2. If body.model starts with "openclaw:" → parse `<slug>[:<tier>]`:
 *        - slug must match /^[a-z0-9][a-z0-9_-]{0,63}$/i
 *        - tier optional (defaults to "sonnet"); must be one of
 *          {sonnet, opus, haiku} when present
 *        - row.scope MUST be "all" (scope='all' bearer keys are the only
 *          admission surface for template traffic — pinned keys cannot
 *          impersonate an OpenClaw-side caller).
 *        - SOUL extracted from first message[role=system]; empty when absent.
 *      On any failure → { error: "malformed_caller" }.
 *
 *   3. Anything else (unknown literal, no prefix) → { error: "unknown_model" }.
 *
 * Pitfall 4 guard: this module NEVER reads body.workspace, body.cwd, or
 * body.metadata.workspace — caller-supplied workspace hints are ignored by
 * design.
 */

import crypto from "node:crypto";
import type {
  CallerIdentity,
  ChatCompletionRequest,
  ClaudeToolChoice,
  ClaudeToolDef,
  ClaudeToolResultBlock,
  Tier,
} from "./types.js";
import { OPENCLAW_PREFIX } from "./types.js";
import type { ApiKeyRow } from "./keys.js";

/**
 * Slug admission regex. Deliberately permissive on case for convenience while
 * still rejecting path-traversal payloads (no `/`, no `.`, no `..`). The 1-64
 * length bound keeps slugs loggable / safe as a directory-name component
 * without further escaping.
 */
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/** Admitted tier tokens — MUST match keys of TIER_MODEL_MAP exactly. */
const VALID_TIERS: ReadonlySet<string> = new Set(["sonnet", "opus", "haiku"]);

/**
 * Pure SHA-256(utf8) hex helper — used as the SOUL fingerprint for cache
 * keying. Returns the full lowercase hex digest; the cache module slices
 * the first 16 chars to keep keys short + readable.
 */
export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Extract the SOUL prompt text from the first `system` message in the
 * request. Supports both string-form content AND the OpenAI multi-modal
 * array-of-parts form (concats all `{type:"text"}` parts with "\n\n").
 * Returns "" when no system message is present.
 */
function extractSoulPrompt(body: ChatCompletionRequest): string {
  const firstSystem = body.messages.find((m) => m.role === "system");
  if (!firstSystem) return "";
  const c = firstSystem.content as unknown;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const parts: string[] = [];
    for (const p of c as Array<{ type?: string; text?: unknown }>) {
      if (p && p.type === "text" && typeof p.text === "string") {
        parts.push(p.text);
      }
    }
    return parts.join("\n\n");
  }
  return "";
}

/**
 * Caller-identity discriminator. Pure — no I/O, no side effects.
 *
 * @param body Parsed ChatCompletionRequest (post-Zod).
 * @param row Authenticated ApiKeyRow (from lookupByIncomingKey).
 * @param knownAgents Top-level agent names (from server's agentNames()
 *                    filtered through topLevelAgents()).
 * @param translatedTools Phase 69 translator output (passthrough to template).
 * @param translatedToolChoice Phase 69 translator output.
 * @param translatedToolResults Phase 69 translator output.
 */
export function extractCallerIdentity(
  body: ChatCompletionRequest,
  row: ApiKeyRow,
  knownAgents: ReadonlyArray<string>,
  translatedTools: ClaudeToolDef[] | null,
  translatedToolChoice: ClaudeToolChoice | null,
  translatedToolResults: ClaudeToolResultBlock[],
): CallerIdentity | { readonly error: "unknown_model" | "malformed_caller" } {
  // Fast path: literal agent match → native (Phase 69 behavior preserved).
  if (knownAgents.includes(body.model)) {
    return { kind: "clawcode-native", agentName: body.model };
  }

  // Not a known agent — must start with "openclaw:" to reach template path.
  if (!body.model.startsWith(OPENCLAW_PREFIX)) {
    return { error: "unknown_model" };
  }

  // scope='all' is REQUIRED for the template route — defense-in-depth against
  // pinned keys trying to impersonate an OpenClaw-side caller.
  if (row.scope !== "all") {
    return { error: "malformed_caller" };
  }

  const rest = body.model.slice(OPENCLAW_PREFIX.length);
  if (rest.length === 0) return { error: "malformed_caller" };

  const parts = rest.split(":");
  if (parts.length > 2) return { error: "malformed_caller" };

  const slugRaw = parts[0];
  const tierRaw = parts[1]; // may be undefined
  if (!slugRaw || !SLUG_RE.test(slugRaw)) {
    return { error: "malformed_caller" };
  }
  if (tierRaw !== undefined && !VALID_TIERS.has(tierRaw)) {
    return { error: "malformed_caller" };
  }
  const tier: Tier = (tierRaw ?? "sonnet") as Tier;

  const soulPrompt = extractSoulPrompt(body);
  const soulFp = sha256Hex(soulPrompt).slice(0, 16);

  return {
    kind: "openclaw-template",
    callerSlug: slugRaw,
    tier,
    soulPrompt,
    soulFp,
    tools: translatedTools,
    toolChoice: translatedToolChoice,
    toolResults: translatedToolResults,
  };
}
