/**
 * Phase 92 Plan 01 Task 1 (RED) — Mission Control history ingestor tests.
 *
 * Pins the contract for `ingestMissionControlHistory(deps)` defined in
 * the plan's <interfaces> block + D-11 amendment. All 6 tests fail at
 * this stage because src/cutover/mc-history-ingestor.ts does not yet
 * exist (RED gate).
 *
 * Behavioral pins:
 *   M1: empty bearer token → {kind:'missing-bearer-token'} + zero fetch calls
 *   M2: happy path — fetch /api/agents → /api/openclaw/sessions →
 *       /api/openclaw/sessions/{id}/history per session, write JSONL,
 *       all entries carry origin:"mc"
 *   M3: cursor — second run reads <stagingDir>/mc-cursor.json and skips
 *       sessions whose updatedAt < cursor; cursor advanced
 *   M4: idempotent — same (sessionId, sequenceIndex) tuples never duplicated
 *   M5: agent filter — no MC agent matches gateway_agent_id →
 *       {kind:'agent-not-found-in-mc'} + NO history fetches
 *   M6: 503 graceful — sessions endpoint returns 503 with gateway error body →
 *       {kind:'mc-gateway-503'} and the bearer-token literal does NOT appear
 *       in the returned error string (regression pin)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  ingestMissionControlHistory,
  type McFetchFn,
  type McIngestDeps,
} from "../mc-history-ingestor.js";
import type { McIngestOutcome } from "../types.js";

const TEST_BEARER = "test-bearer-token-value";
const TEST_BASE = "http://mc.test:4000";

function makeLog() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  } as unknown as import("pino").Logger;
}

/**
 * Build a Response-shape stub. We model only the fields the ingestor
 * actually consumes (ok, status, statusText, json, text). text() defaults
 * to JSON.stringify(body) so the 503-with-message test can include the
 * gateway phrase.
 */
function makeResponse(opts: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  body?: unknown;
  textBody?: string;
}): Awaited<ReturnType<McFetchFn>> {
  const status = opts.status ?? 200;
  const ok = opts.ok ?? (status >= 200 && status < 300);
  const body = opts.body ?? null;
  const textBody = opts.textBody ?? (typeof body === "string" ? body : JSON.stringify(body));
  return {
    ok,
    status,
    statusText: opts.statusText ?? (ok ? "OK" : "Error"),
    json: async () => body,
    text: async () => textBody,
  };
}

/** Helper: produce N synthetic MC sessions matching the fin-client agent. */
function makeMcSessions(n: number, baseTime = Date.UTC(2026, 3, 20)) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      sessionId: `s-${i}`,
      key: `session-key-${i}`,
      kind: "direct",
      label: `Direct: chat-${i}`,
      displayName: `Chat ${i}`,
      updatedAt: new Date(baseTime + i * 60_000).toISOString(),
      defaults: {
        modelProvider: "anthropic",
        model: "claude-sonnet-4-6",
        contextTokens: 200000,
      },
    });
  }
  return out;
}

/** Helper: produce N synthetic history records for a session. */
function makeMcHistory(_sessionId: string, n: number) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `msg-${i}`,
      ts: new Date(Date.UTC(2026, 3, 20, 12, 0, i)).toISOString(),
      model: "claude-sonnet-4-6",
    });
  }
  return out;
}

let stagingDir: string;
beforeEach(async () => {
  stagingDir = await mkdtemp(join(tmpdir(), "cutover-mc-"));
});
afterEach(async () => {
  await rm(stagingDir, { recursive: true, force: true });
});

function baseDeps(overrides: Partial<McIngestDeps> = {}): McIngestDeps {
  return {
    agent: "fin-client",
    gatewayAgentId: "fin-client",
    mcBaseUrl: TEST_BASE,
    bearerToken: TEST_BEARER,
    stagingDir,
    fetchFn: vi.fn() as unknown as McFetchFn,
    log: makeLog(),
    ...overrides,
  };
}

describe("ingestMissionControlHistory — M1 missing bearer token", () => {
  it("returns {kind:'missing-bearer-token'} and never calls fetchFn", async () => {
    const fetchFn = vi.fn() as unknown as McFetchFn;
    const outcome = await ingestMissionControlHistory(
      baseDeps({ bearerToken: "", fetchFn }),
    );
    expect(outcome.kind).toBe("missing-bearer-token");
    if (outcome.kind === "missing-bearer-token") {
      expect(outcome.agent).toBe("fin-client");
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("ingestMissionControlHistory — M2 happy path", () => {
  it("fetches /api/agents → /api/openclaw/sessions → per-session history, writes JSONL with origin:'mc'", async () => {
    const sessions = makeMcSessions(2);
    const fetchFn = vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      // Bearer header is present
      expect(init.headers["Authorization"]).toBe(`Bearer ${TEST_BEARER}`);
      if (url.endsWith("/api/agents")) {
        return makeResponse({
          body: [{ id: "a-1", gateway_agent_id: "fin-client", name: "fin" }],
        });
      }
      if (url.endsWith("/api/openclaw/sessions") || url.endsWith("/api/openclaw/status")) {
        return makeResponse({ body: sessions });
      }
      const matchHistory = url.match(/\/api\/openclaw\/sessions\/([^/]+)\/history$/);
      if (matchHistory) {
        const sid = decodeURIComponent(matchHistory[1] as string);
        return makeResponse({ body: makeMcHistory(sid, 3) });
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as McFetchFn;

    const outcome: McIngestOutcome = await ingestMissionControlHistory(
      baseDeps({ fetchFn }),
    );

    expect(outcome.kind).toBe("ingested");
    if (outcome.kind === "ingested") {
      expect(outcome.sessionsProcessed).toBe(2);
      expect(outcome.newEntries).toBe(6); // 2 sessions × 3 entries
      expect(outcome.totalEntries).toBe(6);
      const raw = await readFile(outcome.jsonlPath, "utf8");
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      expect(lines).toHaveLength(6);
      // Every line carries origin:"mc"
      for (const line of lines) {
        const parsed = JSON.parse(line) as { origin: string; sessionId: string; sequenceIndex: number };
        expect(parsed.origin).toBe("mc");
        expect(typeof parsed.sessionId).toBe("string");
        expect(typeof parsed.sequenceIndex).toBe("number");
      }
    }
  });
});

describe("ingestMissionControlHistory — M3 cursor advances on rerun", () => {
  it("second run reads mc-cursor.json and skips sessions with updatedAt < cursor; reports no-changes", async () => {
    const sessions = makeMcSessions(2);
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith("/api/agents")) {
        return makeResponse({
          body: [{ id: "a-1", gateway_agent_id: "fin-client" }],
        });
      }
      if (url.includes("/api/openclaw/sessions") && !url.includes("/history")) {
        return makeResponse({ body: sessions });
      }
      const matchHistory = url.match(/\/sessions\/([^/]+)\/history$/);
      if (matchHistory) {
        return makeResponse({ body: makeMcHistory(matchHistory[1] as string, 2) });
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as McFetchFn;

    const first = await ingestMissionControlHistory(baseDeps({ fetchFn }));
    expect(first.kind).toBe("ingested");

    // Cursor file present after first run
    const cursorPath = join(stagingDir, "mc-cursor.json");
    const cursorRaw = await readFile(cursorPath, "utf8");
    const cursor = JSON.parse(cursorRaw) as { lastUpdatedAt: string };
    expect(typeof cursor.lastUpdatedAt).toBe("string");

    // Second run: same sessions, all updatedAt <= cursor → no-changes.
    // We re-use the fetch stub which still returns same sessions; ingestor
    // should filter them by cursor.
    const second = await ingestMissionControlHistory(baseDeps({ fetchFn }));
    expect(second.kind).toBe("no-changes");
    if (second.kind === "no-changes") {
      expect(second.totalEntries).toBe(4);
    }
  });
});

describe("ingestMissionControlHistory — M4 idempotent on rerun", () => {
  it("same (sessionId, sequenceIndex) tuples never duplicated across runs", async () => {
    // Use sessions whose updatedAt is the SAME on rerun — but we mutate to
    // force fresh updatedAt by using a now() that advances. Even with the
    // cursor advanced, history with new updatedAt would be re-fetched,
    // BUT the in-memory dedup-by-key gate prevents duplicate writes.
    let now = Date.UTC(2026, 3, 20, 12);
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith("/api/agents")) {
        return makeResponse({
          body: [{ id: "a-1", gateway_agent_id: "fin-client" }],
        });
      }
      if (url.includes("/api/openclaw/sessions") && !url.includes("/history")) {
        // Sessions always come back with FUTURE updatedAt to force re-fetch
        const ts = new Date(now).toISOString();
        now += 60_000;
        return makeResponse({
          body: [
            {
              sessionId: "s-1",
              kind: "direct",
              label: "L",
              updatedAt: ts,
              defaults: { model: "m" },
            },
          ],
        });
      }
      const matchHistory = url.match(/\/sessions\/([^/]+)\/history$/);
      if (matchHistory) {
        // Same history records returned on every call
        return makeResponse({
          body: [
            { role: "user", content: "hi", ts: "2026-04-20T12:00:00.000Z" },
            { role: "assistant", content: "hello", ts: "2026-04-20T12:00:01.000Z" },
          ],
        });
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as McFetchFn;

    const first = await ingestMissionControlHistory(baseDeps({ fetchFn }));
    expect(first.kind).toBe("ingested");
    if (first.kind === "ingested") {
      expect(first.newEntries).toBe(2);
    }

    // Second run: history identical → dedup gate fires → newEntries=0
    const second = await ingestMissionControlHistory(baseDeps({ fetchFn }));
    expect(second.kind === "no-changes" || (second.kind === "ingested" && (second as { newEntries: number }).newEntries === 0)).toBe(true);

    // JSONL file is still 2 lines
    const path = join(stagingDir, "mc-history.jsonl");
    const raw = await readFile(path, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(2);
  });
});

describe("ingestMissionControlHistory — M5 agent not found in MC", () => {
  it("returns {kind:'agent-not-found-in-mc'} when gateway_agent_id has no match; no history fetches", async () => {
    let historyFetchCount = 0;
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith("/api/agents")) {
        return makeResponse({
          body: [{ id: "a-1", gateway_agent_id: "some-other-agent" }],
        });
      }
      if (url.includes("/history")) {
        historyFetchCount += 1;
      }
      return makeResponse({ body: [] });
    }) as unknown as McFetchFn;

    const outcome = await ingestMissionControlHistory(
      baseDeps({ fetchFn, gatewayAgentId: "fin-client" }),
    );
    expect(outcome.kind).toBe("agent-not-found-in-mc");
    if (outcome.kind === "agent-not-found-in-mc") {
      expect(outcome.gatewayAgentId).toBe("fin-client");
    }
    expect(historyFetchCount).toBe(0);

    // No JSONL written
    const path = join(stagingDir, "mc-history.jsonl");
    let exists = true;
    try { await access(path); } catch { exists = false; }
    expect(exists).toBe(false);
  });
});

describe("ingestMissionControlHistory — M6 503 gateway + token NOT in error", () => {
  it("returns {kind:'mc-gateway-503'} on /sessions 503; the bearer token literal does not appear in the error string", async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith("/api/agents")) {
        return makeResponse({
          body: [{ id: "a-1", gateway_agent_id: "fin-client" }],
        });
      }
      if (url.includes("/api/openclaw/sessions") && !url.includes("/history")) {
        return makeResponse({
          ok: false,
          status: 503,
          statusText: "Service Unavailable",
          textBody: '{"error":"Failed to connect to OpenClaw Gateway"}',
          body: { error: "Failed to connect to OpenClaw Gateway" },
        });
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as McFetchFn;

    const outcome = await ingestMissionControlHistory(baseDeps({ fetchFn }));
    expect(outcome.kind).toBe("mc-gateway-503");
    if (outcome.kind === "mc-gateway-503") {
      expect(outcome.error).toContain("Failed to connect to OpenClaw Gateway");
      // SECURITY regression pin: token literal NEVER in error string
      expect(outcome.error).not.toContain(TEST_BEARER);
      expect(outcome.error).not.toContain("MC_API_TOKEN");
    }
  });
});
