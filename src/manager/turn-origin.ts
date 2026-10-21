/**
 * TurnOrigin — provenance metadata attached to every agent turn.
 *
 * Phase 57 introduces TurnOrigin as the shared contract across all turn
 * sources (Discord messages, scheduler ticks, future Phase 59 handoffs,
 * future Phase 60 triggers). Every persisted trace row carries this blob
 * so `clawcode trace <causation_id>` (Phase 63) can stitch a chain
 * across agents.
 *
 * LOCKED SHAPE — see .planning/phases/57-turndispatcher-foundation/57-CONTEXT.md.
 * Downstream phases pattern-match on `source.kind`; do NOT add new fields
 * here without updating the downstream phase plans first.
 */

import { z } from "zod/v4";
import { nanoid } from "nanoid";

/** The locked turn-source kinds. v2.0 Phase 69 added 'openai-api'; the
 *  multi-platform-messaging phase added 'slack' (see
 *  .planning/multi-platform-messaging-PLAN.md). Downstream phases extend by
 *  REGISTERING a kind, never by inventing a new value without a roadmap update. */
export const SOURCE_KINDS = ["discord", "scheduler", "task", "trigger", "openai-api", "slack"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/**
 * Phase 57 Plan 03: prefix for Discord-originated turnIds. The DiscordBridge
 * migration reuses the Discord message snowflake as the turnId by prepending
 * this prefix — e.g. `discord:000000000000000103`. This preserves pre-v1.8
 * trace-id continuity so operators running `sqlite3 traces.db 'SELECT * FROM
 * traces WHERE id = ?'` with a snowflake can still find rows (after re-keying
 * the query to `'discord:' || snowflake`). See locked_shapes note in
 * 57-01-PLAN.md.
 */
export const DISCORD_SNOWFLAKE_PREFIX = "discord:" as const;

/** Zod schema for the `source` field of TurnOrigin. */
export const TurnOriginSourceSchema = z.object({
  kind: z.enum(SOURCE_KINDS),
  id: z.string().min(1),
});

/**
 * TurnOriginSchema — Zod validator for the TurnOrigin blob stored on every
 * trace row. `parentTurnId` is `null` for root turns, else a non-empty
 * string pointing at the immediate parent turn. `chain` is the inclusive
 * walk from root to current (always at least [rootTurnId]).
 */
export const TurnOriginSchema = z.object({
  source: TurnOriginSourceSchema,
  rootTurnId: z.string().min(1),
  parentTurnId: z.string().min(1).nullable(),
  chain: z.array(z.string().min(1)).min(1),
  causationId: z.string().nullable().default(null), // Phase 60 TRIG-08
});

export type TurnOrigin = z.infer<typeof TurnOriginSchema>;

/** Regex for validating turnIds. Phase 58 task rows + Phase 63 trace walker
 *  rely on this format; change requires milestone-level coordination.
 *  v2.0 Phase 69 extended the prefix union with `openai-api`. */
export const TURN_ID_REGEX = /^(discord|scheduler|task|trigger|openai-api|slack):[a-zA-Z0-9_-]{10,}$/;

/** Generate a new turnId of the form `<kind>:<nanoid(10)>`. 10-char nanoid
 *  matches the pre-existing scheduler convention at `src/scheduler/scheduler.ts:98`.
 *  The regex accepts 10+ so raw Discord snowflakes (17-19 digits) also pass
 *  via `makeRootOriginWithTurnId`. */
export function makeTurnId(kind: SourceKind): string {
  return `${kind}:${nanoid(10)}`;
}

/**
 * Build a root TurnOrigin for a fresh turn with no parent in the chain.
 * Used by TaskScheduler (schedule.name as sourceId), Phase 59 handoffs
 * (taskId), Phase 60 triggers (triggerEventId).
 *
 * Returns a deeply-frozen TurnOrigin — `source`, `chain`, and the outer
 * object are all `Object.freeze`d to match the project's immutability
 * convention.
 */
export function makeRootOrigin(kind: SourceKind, sourceId: string): TurnOrigin {
  const rootTurnId = makeTurnId(kind);
  return Object.freeze({
    source: Object.freeze({ kind, id: sourceId }),
    rootTurnId,
    parentTurnId: null,
    chain: Object.freeze([rootTurnId]),
    causationId: null,
  }) as TurnOrigin;
}

/**
 * Phase 57 Plan 03: build a root TurnOrigin using a caller-supplied turnId.
 *
 * Use case: Discord messages already have a stable id (snowflake) that the
 * trace store has used as `traces.id` since Phase 50. Rather than re-keying
 * by a fresh nanoid (which would break operator queries), DiscordBridge
 * passes the formatted turnId in — `discord:<snowflake>` — and this helper
 * preserves it as `rootTurnId`. `makeRootOrigin` remains the entry point
 * for sources without a stable id (scheduler uses the schedule name but
 * still wants a random nanoid turnId).
 *
 * The caller is responsible for ensuring `turnId` matches TURN_ID_REGEX.
 * This function throws if it doesn't — the error is caught by the Discord
 * bridge's trace-setup try/catch (non-fatal, logs at warn).
 */
export function makeRootOriginWithTurnId(
  kind: SourceKind,
  sourceId: string,
  turnId: string,
): TurnOrigin {
  if (!TURN_ID_REGEX.test(turnId)) {
    throw new Error(
      `makeRootOriginWithTurnId: turnId does not match TURN_ID_REGEX: ${turnId}`,
    );
  }
  return Object.freeze({
    source: Object.freeze({ kind, id: sourceId }),
    rootTurnId: turnId,
    parentTurnId: null,
    chain: Object.freeze([turnId]),
    causationId: null,
  }) as TurnOrigin;
}

/**
 * Phase 60 TRIG-08: build a root TurnOrigin with a causation_id.
 *
 * Trigger-originated turns carry a nanoid causation_id born at ingress
 * (TriggerEngine.ingest). The id flows through TurnOrigin -> trace row ->
 * Phase 63 causation chain walker. Non-trigger origins leave this null
 * (via makeRootOrigin / makeRootOriginWithTurnId).
 */
export function makeRootOriginWithCausation(
  kind: SourceKind,
  sourceId: string,
  causationId: string,
): TurnOrigin {
  const rootTurnId = makeTurnId(kind);
  return Object.freeze({
    source: Object.freeze({ kind, id: sourceId }),
    rootTurnId,
    parentTurnId: null,
    chain: Object.freeze([rootTurnId]),
    causationId,
  }) as TurnOrigin;
}
