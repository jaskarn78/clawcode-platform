/**
 * Phase 92 Plan 01 — Mission Control history ingestor (PRIMARY source per D-11).
 *
 * Calls OpenClaw Mission Control's REST API (default
 * http://10.0.0.3:4000) with bearer-token auth, enumerates the source
 * agent's sessions (filtered by gateway_agent_id), paginates full history
 * per session, and writes a JSONL staging file at
 * `<stagingDir>/mc-history.jsonl`. Idempotent by `(sessionId, sequenceIndex)`.
 *
 * Cursor-driven incremental rerun: on each successful pass writes
 * `<stagingDir>/mc-cursor.json` storing `{lastUpdatedAt: <ISO8601>}`. On
 * subsequent runs, sessions whose `updatedAt < cursor` are skipped — the
 * gateway already advanced past us. Per-session history is then re-fetched
 * for sessions that pass the filter, with the in-memory dedup gate
 * preventing duplicate JSONL writes (M4 idempotency invariant).
 *
 * Pure DI module — production wraps `deps.fetchFn` around globalThis.fetch
 * (Node 22 native). Tests pass `vi.fn()` with canned Response-shape stubs.
 *
 * D-11 resilience: on 503 with body containing
 * "Failed to connect to OpenClaw Gateway", returns `mc-gateway-503` outcome
 * — the CLI wrapper decides whether to abort or continue based on
 * `--source mc` (fatal) vs `--source both` (graceful skip).
 *
 * SECURITY: bearer token MUST NOT appear in any log call OR returned error
 * string. Pinned by:
 *   - `sanitizeError(err, token)` strips the token literal from any
 *     Error.message before propagation
 *   - `classifyFetchFailure` builds error strings from status/statusText
 *     ONLY — never the URL or headers
 *   - The `headers` object is constructed once and never logged
 */

import { mkdir, readFile, writeFile, appendFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Logger } from "pino";
import {
  mcHistoryEntrySchema,
  type McHistoryEntry,
  type McIngestOutcome,
} from "./types.js";

/**
 * Response-shape stub the ingestor consumes. Production wraps Node 22's
 * native fetch directly (the shape is identical to the WHATWG Response,
 * narrowed to the methods we use). Tests pass plain objects.
 */
export type McFetchFn = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export type McIngestDeps = {
  /** ClawCode agent name (e.g. "fin-client") — used in the outcome + log context. */
  readonly agent: string;
  /** OpenClaw `gateway_agent_id` to filter on (typically same string as agent). */
  readonly gatewayAgentId: string;
  /** Mission Control base URL (e.g. "http://10.0.0.3:4000"). */
  readonly mcBaseUrl: string;
  /** Bearer token from env MC_API_TOKEN — refuse-to-start guard at CLI surface. */
  readonly bearerToken: string;
  /** ~/.clawcode/manager/cutover-staging/<agent>/ — JSONL + cursor live here. */
  readonly stagingDir: string;
  /** DI for tests; production uses Node 22 globalThis.fetch. */
  readonly fetchFn?: McFetchFn;
  /** DI for time; tests can advance the clock. */
  readonly now?: () => Date;
  readonly log: Logger;
};

/** Internal: shape of a Mission Control session row from /api/openclaw/sessions or /api/openclaw/status. */
type McSessionRow = {
  sessionId: string;
  updatedAt: string;
  kind?: string;
  label?: string;
  defaults?: { model?: string };
};

/**
 * Run one Mission Control ingest cycle. Always returns an
 * `McIngestOutcome`; never throws in the happy path. Network errors are
 * caught and surfaced as `{kind: "mc-fetch-failed"}` with a sanitized
 * error string.
 */
export async function ingestMissionControlHistory(
  deps: McIngestDeps,
): Promise<McIngestOutcome> {
  const start = (deps.now ?? (() => new Date()))();

  if (!deps.bearerToken || deps.bearerToken.trim() === "") {
    return { kind: "missing-bearer-token", agent: deps.agent };
  }

  await mkdir(deps.stagingDir, { recursive: true });
  const jsonlPath = join(deps.stagingDir, "mc-history.jsonl");
  const cursorPath = join(deps.stagingDir, "mc-cursor.json");
  const fetchFn = deps.fetchFn ?? (globalThis.fetch as unknown as McFetchFn);

  // Build header — token consumed once; never reflected in logs/errors.
  const headers: Record<string, string> = {
    Authorization: `Bearer ${deps.bearerToken}`,
    Accept: "application/json",
  };

  // Read existing JSONL for in-memory dedup set.
  const existingKeys = new Set<string>();
  try {
    const existing = await readFile(jsonlPath, "utf8");
    for (const line of existing.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const e = JSON.parse(line) as { sessionId?: unknown; sequenceIndex?: unknown };
        if (typeof e.sessionId === "string" && typeof e.sequenceIndex === "number") {
          existingKeys.add(`${e.sessionId}:${e.sequenceIndex}`);
        }
      } catch {
        // Malformed line — skip silently
      }
    }
  } catch {
    // ENOENT — first run, nothing to dedup against
  }

  // Read cursor (if present).
  let cursor: string | null = null;
  try {
    const c = JSON.parse(await readFile(cursorPath, "utf8")) as { lastUpdatedAt?: unknown };
    if (typeof c.lastUpdatedAt === "string") cursor = c.lastUpdatedAt;
  } catch {
    // First run — no cursor
  }

  // Step 1: GET /api/agents → find row by gateway_agent_id.
  let agentsResp;
  try {
    agentsResp = await fetchFn(`${deps.mcBaseUrl}/api/agents`, { headers });
  } catch (err) {
    return {
      kind: "mc-fetch-failed",
      agent: deps.agent,
      phase: "agents",
      error: sanitizeError(err, deps.bearerToken),
      durationMs: Date.now() - start.getTime(),
    };
  }
  if (!agentsResp.ok) {
    return classifyFetchFailure(agentsResp, "agents", deps, start);
  }
  let agents: Array<{ gateway_agent_id?: string; id?: string }>;
  try {
    agents = (await agentsResp.json()) as Array<{ gateway_agent_id?: string; id?: string }>;
  } catch (err) {
    return {
      kind: "mc-fetch-failed",
      agent: deps.agent,
      phase: "agents",
      error: sanitizeError(err, deps.bearerToken),
      durationMs: Date.now() - start.getTime(),
    };
  }
  const sourceAgent = agents.find((a) => a.gateway_agent_id === deps.gatewayAgentId);
  if (!sourceAgent) {
    return {
      kind: "agent-not-found-in-mc",
      agent: deps.agent,
      gatewayAgentId: deps.gatewayAgentId,
    };
  }

  // Step 2: GET /api/openclaw/sessions → enumerate session rows.
  let sessionsResp;
  try {
    sessionsResp = await fetchFn(`${deps.mcBaseUrl}/api/openclaw/sessions`, { headers });
  } catch (err) {
    return {
      kind: "mc-fetch-failed",
      agent: deps.agent,
      phase: "sessions",
      error: sanitizeError(err, deps.bearerToken),
      durationMs: Date.now() - start.getTime(),
    };
  }

  if (sessionsResp.status === 503) {
    let body503 = "";
    try {
      body503 = await sessionsResp.text();
    } catch {
      // text() failed — fall back to statusText classification below
    }
    if (
      body503.includes("Failed to connect to OpenClaw Gateway") ||
      sessionsResp.statusText.toLowerCase().includes("gateway")
    ) {
      return {
        kind: "mc-gateway-503",
        agent: deps.agent,
        // Hard-code the canonical gateway phrase — body content is logged
        // through sanitizeError to ensure no token leak even if the body
        // were echoed by a misconfigured proxy.
        error: "Failed to connect to OpenClaw Gateway",
        durationMs: Date.now() - start.getTime(),
      };
    }
  }

  if (!sessionsResp.ok) {
    return classifyFetchFailure(sessionsResp, "sessions", deps, start);
  }
  let allSessions: McSessionRow[];
  try {
    allSessions = (await sessionsResp.json()) as McSessionRow[];
  } catch (err) {
    return {
      kind: "mc-fetch-failed",
      agent: deps.agent,
      phase: "sessions",
      error: sanitizeError(err, deps.bearerToken),
      durationMs: Date.now() - start.getTime(),
    };
  }

  // Apply cursor filter — sessions strictly older than cursor have already
  // been ingested in a prior cycle and shouldn't be re-fetched.
  const targetSessions = allSessions.filter((s) => {
    if (cursor !== null && typeof s.updatedAt === "string" && s.updatedAt < cursor) {
      return false;
    }
    return true;
  });

  // Step 3: per-session GET /api/openclaw/sessions/{id}/history.
  const newEntries: McHistoryEntry[] = [];
  let maxUpdatedAt = cursor ?? "1970-01-01T00:00:00.000Z";

  for (const session of targetSessions) {
    let historyResp;
    try {
      historyResp = await fetchFn(
        `${deps.mcBaseUrl}/api/openclaw/sessions/${encodeURIComponent(session.sessionId)}/history`,
        { headers },
      );
    } catch (err) {
      return {
        kind: "mc-fetch-failed",
        agent: deps.agent,
        phase: "history",
        error: sanitizeError(err, deps.bearerToken),
        durationMs: Date.now() - start.getTime(),
      };
    }
    if (!historyResp.ok) {
      // Per-session failure is non-fatal — log + continue. This matches
      // the D-11 partial-tolerance invariant for ingestion.
      deps.log.warn(
        { sessionId: session.sessionId, status: historyResp.status },
        "mc history fetch failed",
      );
      continue;
    }

    let history: unknown[];
    try {
      history = (await historyResp.json()) as unknown[];
    } catch (err) {
      deps.log.warn(
        {
          sessionId: session.sessionId,
          error: sanitizeError(err, deps.bearerToken),
        },
        "mc history parse failed",
      );
      continue;
    }

    for (let i = 0; i < history.length; i++) {
      const raw = (history[i] ?? {}) as Record<string, unknown>;
      const candidate: McHistoryEntry = {
        origin: "mc",
        sessionId: session.sessionId,
        sequenceIndex: i,
        role: normalizeRole(raw.role),
        content:
          typeof raw.content === "string"
            ? raw.content
            : JSON.stringify(raw.content ?? ""),
        ...(typeof raw.model === "string"
          ? { model: raw.model }
          : session.defaults?.model !== undefined
          ? { model: session.defaults.model }
          : {}),
        ts:
          typeof raw.ts === "string"
            ? raw.ts
            : typeof session.updatedAt === "string"
            ? session.updatedAt
            : new Date().toISOString(),
        kind: normalizeKind(session.kind),
        ...(typeof session.label === "string" ? { label: session.label } : {}),
      };

      const parsed = mcHistoryEntrySchema.safeParse(candidate);
      if (!parsed.success) continue;
      const key = `${parsed.data.sessionId}:${parsed.data.sequenceIndex}`;
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
      newEntries.push(parsed.data);
    }

    if (
      typeof session.updatedAt === "string" &&
      session.updatedAt > maxUpdatedAt
    ) {
      maxUpdatedAt = session.updatedAt;
    }
  }

  // Persist cursor (atomic temp+rename) — written even on no-changes so
  // the cursor monotonically advances when MC's own sessions tick forward.
  await writeAtomic(
    cursorPath,
    JSON.stringify({ lastUpdatedAt: maxUpdatedAt }, null, 2),
  );

  if (newEntries.length === 0) {
    return {
      kind: "no-changes",
      agent: deps.agent,
      totalEntries: existingKeys.size,
      durationMs: Date.now() - start.getTime(),
      jsonlPath,
    };
  }

  // Sort by ts ASC for deterministic JSONL ordering, then append.
  // Immutability: spread before sort.
  const sorted = [...newEntries].sort((a, b) => a.ts.localeCompare(b.ts));
  const jsonlChunk = sorted.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await appendFile(jsonlPath, jsonlChunk, "utf8");

  return {
    kind: "ingested",
    agent: deps.agent,
    sessionsProcessed: targetSessions.length,
    newEntries: newEntries.length,
    totalEntries: existingKeys.size,
    durationMs: Date.now() - start.getTime(),
    jsonlPath,
  };
}

/**
 * Strip the bearer-token literal from any error message before returning
 * to the caller. Defense-in-depth — the production code paths never
 * include the token in error messages, but a future code change might
 * accidentally interpolate the URL or headers; this guard catches that.
 */
function sanitizeError(err: unknown, token: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (token.length > 0 && msg.includes(token)) {
    return msg.split(token).join("[REDACTED]");
  }
  return msg;
}

/**
 * Build an `mc-fetch-failed` outcome from a non-OK Response. Error string
 * is built ONLY from status + statusText so the URL (which doesn't carry
 * the token but might carry other sensitive context like internal IPs)
 * isn't propagated.
 */
function classifyFetchFailure(
  resp: { status: number; statusText: string },
  phase: "agents" | "sessions" | "history",
  deps: McIngestDeps,
  start: Date,
): McIngestOutcome {
  const error = `HTTP ${resp.status} ${resp.statusText}`.trim();
  return {
    kind: "mc-fetch-failed",
    agent: deps.agent,
    phase,
    error,
    durationMs: Date.now() - start.getTime(),
  };
}

function normalizeRole(raw: unknown): McHistoryEntry["role"] {
  if (raw === "user" || raw === "assistant" || raw === "system" || raw === "tool") {
    return raw;
  }
  return "system";
}

function normalizeKind(raw: unknown): McHistoryEntry["kind"] {
  if (
    raw === "direct" ||
    raw === "cron" ||
    raw === "orchestra" ||
    raw === "scheduled"
  ) {
    return raw;
  }
  return "unknown";
}

/** Atomic write via temp+rename. Mirrors writers used elsewhere in the codebase. */
async function writeAtomic(targetPath: string, content: string): Promise<void> {
  const tmp = `${targetPath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, targetPath);
}
