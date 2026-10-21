/**
 * Phase 999.8 Plan 01 — pure handler for the `memory-graph` IPC method.
 *
 * Lifts the previously-hardcoded `LIMIT 500` to a configurable cap with a
 * default of 5000 and an inclusive range of [1, 50000] (D-CAP-01..D-CAP-04).
 *
 * Design notes:
 *   - Mirrors the inline `typeof params.x === "number"` coercion pattern
 *     established at `daemon.ts:4724` (memory-lookup). The project has
 *     no shared number-validator helper today and the plan
 *     explicitly forbids introducing one.
 *   - Uses parameterized `LIMIT ?` binding — better-sqlite3 binds JS
 *     numbers as integers, so there is no SQL-injection risk and the
 *     value flows through cleanly.
 *   - The dashboard route at `src/dashboard/server.ts:269` continues to
 *     send only `{ agent }` and silently picks up the new 5000 default
 *     (CAP-04). No frontend changes required.
 *
 * Exporting this as a pure function (taking the live `Database` rather
 * than a `MemoryStore`) keeps it cheap to test against `:memory:` and
 * avoids dragging the full MemoryStore migration chain into the unit
 * test fixture. The daemon switch-case at `daemon.ts::case "memory-graph"`
 * is now a one-line dispatch onto this helper, mirroring the
 * `handleSetModelIpc` extraction pattern.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import { ManagerError } from "../shared/errors.js";

/** Default cap when the caller omits `limit`. Raised from 500 → 5000 (D-CAP-01). */
export const MEMORY_GRAPH_DEFAULT_LIMIT = 5000;
/** Inclusive lower bound on `limit` (D-CAP-03). */
export const MEMORY_GRAPH_MIN_LIMIT = 1;
/** Inclusive upper bound on `limit` (D-CAP-03). */
export const MEMORY_GRAPH_MAX_LIMIT = 50000;

export interface MemoryGraphNode {
  readonly id: string;
  readonly content: string;
  readonly source: string;
  readonly importance: number;
  readonly accessCount: number;
  readonly tags: readonly string[];
  readonly createdAt: string;
  readonly tier: string;
}

export interface MemoryGraphLink {
  readonly source: string;
  readonly target: string;
  readonly text: string;
}

export interface MemoryGraphResult {
  readonly nodes: readonly MemoryGraphNode[];
  readonly links: readonly MemoryGraphLink[];
}

interface MemoryRow {
  id: string;
  content: string;
  source: string;
  importance: number;
  access_count: number;
  tags: string;
  created_at: string;
  tier: string | null;
}

interface LinkRow {
  source_id: string;
  target_id: string;
  link_text: string;
}

/**
 * Resolve the effective `LIMIT ?` value from raw IPC params.
 *
 * Coercion semantics (D-CAP-02): non-number `limit` values silently fall
 * back to the default. Only numeric values that fall outside the
 * inclusive [1, 50000] range — or are non-integers (NaN, 1.5, etc.) —
 * raise `ManagerError`. This matches the memory-lookup precedent at
 * daemon.ts:4724 where a string-typed param simply takes the default
 * branch rather than crashing the IPC.
 */
function resolveLimit(rawLimit: unknown): number {
  const candidate =
    typeof rawLimit === "number" ? rawLimit : MEMORY_GRAPH_DEFAULT_LIMIT;
  if (
    !Number.isInteger(candidate) ||
    candidate < MEMORY_GRAPH_MIN_LIMIT ||
    candidate > MEMORY_GRAPH_MAX_LIMIT
  ) {
    throw new ManagerError(
      `Invalid limit param: ${candidate} (must be integer in [${MEMORY_GRAPH_MIN_LIMIT}, ${MEMORY_GRAPH_MAX_LIMIT}])`,
    );
  }
  return candidate;
}

/**
 * Pure handler for the `memory-graph` IPC method.
 *
 * @param params IPC param bag — reads `limit?: number` (optional). The
 *               `agent` param is validated upstream in the daemon
 *               switch-case before this helper is invoked, so it is
 *               not re-validated here.
 * @param db     The live agent memory database. Caller is responsible
 *               for resolving the per-agent store.
 */
export function handleMemoryGraphIpc(
  params: Record<string, unknown>,
  db: DatabaseType,
): MemoryGraphResult {
  const limit = resolveLimit(params.limit);

  const memories = db
    .prepare(
      `
        SELECT id, content, source, importance, access_count, tags,
               created_at, tier
        FROM memories
        ORDER BY created_at DESC
        LIMIT ?
      `,
    )
    .all(limit) as MemoryRow[];

  const nodeIds = [...new Set(memories.map((m) => m.id))];
  const placeholders = nodeIds.map(() => "?").join(",") || "NULL";
  const allLinks = db
    .prepare(
      `
        SELECT source_id, target_id, link_text
        FROM memory_links
        WHERE source_id IN (${placeholders})
          AND target_id IN (${placeholders})
      `,
    )
    .all(...nodeIds, ...nodeIds) as LinkRow[];

  return {
    nodes: memories.map((m) => ({
      id: m.id,
      content: m.content,
      source: m.source,
      importance: m.importance,
      accessCount: m.access_count,
      tags: JSON.parse(m.tags) as string[],
      createdAt: m.created_at,
      tier: m.tier ?? "warm",
    })),
    links: allLinks.map((l) => ({
      source: l.source_id,
      target: l.target_id,
      text: l.link_text,
    })),
  };
}
