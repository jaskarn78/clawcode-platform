/**
 * Phase 95 Plan 01 Task 2 — D-03 dream-pass primitive.
 *
 * Pure-DI module:
 *   - No SDK imports (`dispatch` is dependency-injected; production
 *     wiring at daemon edge in Plan 95-03 wraps TurnDispatcher.dispatch)
 *   - No fs imports (`readFile` is dependency-injected — the daemon
 *     resolves to fs/promises.readFile at the edge)
 *   - No bare zero-arg Date constructor — `currentTime(deps)` helper funnels
 *     a single fallback through `Date.now()` + the integer-arg constructor
 *     (Phase 94-01 capability-probe.ts pattern). Production callers
 *     ALWAYS pass `now`; the fallback exists so DI mistakes don't crash.
 *
 * D-03 contract:
 *   1. If dream.enabled === false → skipped(disabled). Dispatch never called.
 *   2. Else assemble prompt + invoke dispatch.
 *   3. JSON.parse + zod-validate the response.
 *      - Parse failure or schema mismatch → failed (verbatim error).
 *      - Dispatch throw → failed (verbatim err.message — TOOL-04 pattern).
 *      - Otherwise → completed (with metrics: durationMs, tokensIn, tokensOut, model).
 *
 * Idle gating belongs to the cron timer (Plan 95-02), NOT this primitive.
 * Manual triggers (CLI / Discord slash in 95-03) bypass idle gating
 * intentionally — see 95-CONTEXT D-07.
 *
 * The 3-variant DreamPassOutcome union (completed | skipped | failed) is
 * the LOCKED contract for downstream consumers (Plans 95-02 auto-applier
 * exhaustive switch + 95-03 CLI/Discord renderer). Adding a 4th variant
 * cascades through both — pinned by static-grep regression rule.
 */

import { z } from "zod/v4";
import {
  buildDreamPrompt,
  type ConversationSummary,
  type MemoryChunk,
} from "./dream-prompt-builder.js";

/**
 * D-03 structured output schema. Subtle wording / shape changes in the
 * LLM response break downstream auto-apply (Plan 95-02 newWikilinks via
 * Phase 36-41 auto-linker). Pinned shape:
 *   - newWikilinks: from/to/rationale
 *   - promotionCandidates: chunkId/currentPath/rationale/priorityScore (0..100)
 *     PLUS optional action / targetMode for Phase 115 D-10 row-3 detection
 *     (mutating-vs-additive fork). Legacy LLM responses that omit these
 *     fields are treated as additive (Row-2 semantics under D-10).
 *   - themedReflection: free-form narrative
 *   - suggestedConsolidations: sources[]/newPath/rationale
 */
export const dreamResultSchema = z.object({
  newWikilinks: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      rationale: z.string(),
    }),
  ),
  promotionCandidates: z.array(
    z.object({
      chunkId: z.string(),
      currentPath: z.string(),
      rationale: z.string(),
      priorityScore: z.number().min(0).max(100),
      /**
       * Phase 115 D-10 — optional action verb. Legacy schema omitted this
       * field (treated as "add"). When the LLM emits "edit" or "merge",
       * Phase 115 D-10 Row-3 detection routes the candidate to operator-
       * required regardless of priorityScore.
       */
      action: z.enum(["add", "edit", "merge"]).optional(),
      /**
       * Phase 115 D-10 — optional target mode. "overwrite" implies the
       * promotion is mutating (Row-3); "append" or absent implies additive
       * (Row-2 default).
       */
      targetMode: z.enum(["append", "overwrite"]).optional(),
    }),
  ),
  themedReflection: z.string(),
  suggestedConsolidations: z.array(
    z.object({
      sources: z.array(z.string()),
      newPath: z.string(),
      rationale: z.string(),
    }),
  ),
});

export type DreamResult = z.infer<typeof dreamResultSchema>;

/**
 * Locked 3-variant discriminated union. Adding a 4th variant cascades
 * through Plans 95-02 (auto-applier exhaustive switch) and 95-03
 * (CLI/Discord renderer). Pinned by static-grep regression rule (3 entries).
 */
export const dreamPassOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("completed"),
    result: dreamResultSchema,
    durationMs: z.number(),
    tokensIn: z.number(),
    tokensOut: z.number(),
    model: z.string(),
  }),
  z.object({
    kind: z.literal("skipped"),
    reason: z.enum(["agent-active", "disabled"]),
  }),
  z.object({ kind: z.literal("failed"), error: z.string() }),
]);

export type DreamPassOutcome = z.infer<typeof dreamPassOutcomeSchema>;

/**
 * Resolved dream config the dispatch caller cares about. The full
 * `DreamConfig` from src/config/schema.ts has more fields (retentionDays);
 * keep this struct narrow — primitive only needs enabled + model + cadence
 * (cadence travels for log + skip-reason context, not gating logic here).
 */
export interface ResolvedDreamConfig {
  readonly enabled: boolean;
  readonly idleMinutes: number;
  readonly model: string;
  readonly retentionDays?: number;
}

/**
 * Dispatch contract. The daemon-edge wiring (Plan 95-03) maps these
 * fields to TurnDispatcher.dispatch options. We intentionally narrow
 * the surface so this primitive doesn't touch the full Turn / Stream
 * machinery — dream passes are single-shot LLM calls.
 */
export interface DreamDispatchRequest {
  readonly model: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  /** Cap output tokens at 4K per D-03. */
  readonly maxOutputTokens: number;
}

export interface DreamDispatchResponse {
  /** Raw LLM text — JSON.parse'd + zod-validated by runDreamPass. */
  readonly rawText: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
}

export interface DreamPassLog {
  info(msg: string): void;
  /**
   * Phase 107 DREAM-OUT-03 — pino-style structured warn. Accepts either:
   *   - `(obj, msg)` — structured form (preferred): operators grep on
   *     `component=dream-pass action=parse-failed agent=<name>` in journalctl.
   *   - `(msg)` — string-only fallback for legacy callers.
   *
   * Single union signature (NOT TS overloads) so test stubs that only
   * accept `(msg: string)` still satisfy the interface — TS overloads
   * require the implementation to handle every overload shape.
   */
  warn(objOrMsg: Record<string, unknown> | string, msg?: string): void;
  error(msg: string): void;
}

export interface RunDreamPassDeps {
  readonly memoryStore: {
    getRecentChunks(
      agent: string,
      limit: number,
    ): Promise<readonly MemoryChunk[]>;
  };
  readonly conversationStore: {
    getRecentSummaries(
      agent: string,
      limit: number,
    ): Promise<readonly ConversationSummary[]>;
  };
  readonly readFile: (path: string) => Promise<string>;
  readonly dispatch: (req: DreamDispatchRequest) => Promise<DreamDispatchResponse>;
  readonly resolvedDreamConfig: ResolvedDreamConfig;
  /** ~clawcode/.clawcode/agents/<agent>/memory — root for MEMORY.md + graph-edges.json. */
  readonly memoryRoot: string;
  /** DI clock; production wires the daemon's clock at the edge. */
  readonly now?: () => Date;
  readonly log: DreamPassLog;
}

/** D-03 default chunk fetch limit. */
const RECENT_CHUNKS_LIMIT = 30;
/** D-03 default summary fetch limit. */
const RECENT_SUMMARIES_LIMIT = 3;
/** D-03 output token cap. */
const MAX_OUTPUT_TOKENS = 4096;

/**
 * DI-pure clock helper. Production wires `deps.now` at the daemon edge;
 * tests pass a deterministic fixed-time function. The helper isolates
 * the only Date construction call in this module, gated behind the
 * integer-arg signature so the strict static-grep pin holds. Mirrors
 * `currentTime(deps)` in src/manager/capability-probe.ts (Phase 94-01).
 */
function currentTime(deps: { readonly now?: () => Date }): Date {
  if (deps.now !== undefined) return deps.now();
  return new Date(Date.now());
}

/**
 * Run a single dream pass. Returns a 3-variant DreamPassOutcome — never
 * throws. All errors (dispatch errors, JSON parse errors, schema
 * validation errors) are folded into `{kind:'failed', error: <verbatim>}`.
 *
 * `agentName` is opaque — passed verbatim into the system prompt and the
 * memoryStore/conversationStore getters. The daemon-edge wiring (95-03)
 * resolves it to the right SQLite path before calling.
 */
export async function runDreamPass(
  agentName: string,
  deps: RunDreamPassDeps,
): Promise<DreamPassOutcome> {
  if (!deps.resolvedDreamConfig.enabled) {
    deps.log.info(
      `dream-pass: ${agentName} skipped (dream.enabled=false)`,
    );
    return { kind: "skipped", reason: "disabled" };
  }

  const startedAt = currentTime(deps);

  try {
    const recentChunks = await deps.memoryStore.getRecentChunks(
      agentName,
      RECENT_CHUNKS_LIMIT,
    );
    const memoryMd = await deps
      .readFile(`${deps.memoryRoot}/MEMORY.md`)
      .catch(() => "");
    const recentSummaries = await deps.conversationStore.getRecentSummaries(
      agentName,
      RECENT_SUMMARIES_LIMIT,
    );
    const graphEdges = await deps
      .readFile(`${deps.memoryRoot}/graph-edges.json`)
      .catch(() => "{}");

    const { systemPrompt, userPrompt } = buildDreamPrompt({
      recentChunks,
      memoryMd,
      recentSummaries,
      graphEdges,
      agentName,
    });

    const dispatchResp = await deps.dispatch({
      model: deps.resolvedDreamConfig.model,
      systemPrompt,
      userPrompt,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });

    // Phase 99 dream hotfix (2026-04-26): Haiku frequently wraps JSON output
    // in markdown code fences (```json ... ```) AND/OR adds narrative prose
    // ("Picking up where we left off, here's the dream pass: {...}") despite
    // the system prompt explicitly asking for raw JSON.
    // Strategy: locate the first '{', balance braces to find matching '}',
    // extract that substring. Handles both fence-wrapped + prose-wrapped cases.
    // Falls back to original raw text if no balanced object found.
    const extractJsonObject = (raw: string): string => {
      const firstBrace = raw.indexOf("{");
      if (firstBrace === -1) return raw;
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let i = firstBrace; i < raw.length; i++) {
        const ch = raw[i];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (ch === '"') {
          inString = !inString;
          continue;
        }
        if (inString) continue;
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            return raw.slice(firstBrace, i + 1);
          }
        }
      }
      return raw.slice(firstBrace); // unbalanced — let JSON.parse fail with clearer error
    };
    const stripCodeFence = extractJsonObject;

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(stripCodeFence(dispatchResp.rawText));
    } catch (parseErr) {
      const msg =
        parseErr instanceof Error ? parseErr.message : String(parseErr);
      // Phase 107 DREAM-OUT-03 — log warn (not error) with structured fields.
      // Operator surface: parse-failure means "model misbehaved", not a
      // system bug. Cap responsePrefix at 80 chars (Unicode-safe slice via
      // Array.from so emoji + multibyte chars don't get split mid-codepoint).
      const responsePrefix = Array.from(dispatchResp.rawText)
        .slice(0, 80)
        .join("");
      deps.log.warn(
        {
          component: "dream-pass",
          action: "parse-failed",
          responsePrefix,
          agent: agentName,
          err: msg,
        },
        "dream pass returned non-JSON; treating as no-op",
      );
      return { kind: "failed", error: `parse-failed: ${msg}` };
    }

    const validated = dreamResultSchema.safeParse(parsedJson);
    if (!validated.success) {
      const errorText = `dream-result-schema-validation-failed: ${validated.error.message}`;
      deps.log.error(`dream-pass: ${agentName} ${errorText}`);
      return { kind: "failed", error: errorText };
    }

    const durationMs = currentTime(deps).getTime() - startedAt.getTime();
    deps.log.info(
      `dream-pass: ${agentName} completed in ${durationMs}ms (in=${dispatchResp.tokensIn} out=${dispatchResp.tokensOut})`,
    );
    return {
      kind: "completed",
      result: validated.data,
      durationMs,
      tokensIn: dispatchResp.tokensIn,
      tokensOut: dispatchResp.tokensOut,
      model: deps.resolvedDreamConfig.model,
    };
  } catch (err) {
    // TOOL-04 verbatim pass-through (Phase 85): keep the err.message
    // character-for-character. Plan 95-02 auto-applier classifies on
    // the failed-outcome surface; do NOT classify or wrap here.
    const errorText = err instanceof Error ? err.message : String(err);
    deps.log.error(`dream-pass: ${agentName} failed: ${errorText}`);
    return { kind: "failed", error: errorText };
  }
}
