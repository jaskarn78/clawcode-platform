/**
 * Unit tests for the shared dream machinery — specifically
 * `deriveLastTurnAt`, the ConversationStore-backed `lastTurnAt` source.
 *
 * WHY THIS MATTERS:
 *   Before this module the `run-dream-pass` IPC handler resolved
 *   `lastTurnAt` via `(manager as unknown as { getLastTurnAt? }).
 *   getLastTurnAt?.(agent)` — but `SessionManager` has NO `getLastTurnAt`
 *   method, so that expression ALWAYS returned `null`. A dream cron
 *   wired against a null lastTurnAt registers but never fires
 *   (`isAgentIdle(null)` → `no-prior-turn`). `deriveLastTurnAt` is the
 *   real source; these tests pin its behaviour.
 */

import { describe, it, expect, vi } from "vitest";
import type { Logger } from "pino";
import {
  deriveLastTurnAt,
  LAST_TURN_SESSION_SCAN_LIMIT,
  type DreamMachineryManager,
} from "../dream-machinery.js";

/** Minimal pino-shaped logger stub. */
function makeLog(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

type FakeSession = { readonly id: string };
type FakeTurn = { readonly createdAt: string };

/**
 * Build a fake `DreamMachineryManager` whose ConversationStore returns
 * the supplied sessions + per-session turns.
 */
function makeManager(
  sessions: readonly FakeSession[],
  turnsBySession: Readonly<Record<string, readonly FakeTurn[]>>,
  opts: { throwOnList?: boolean; noStore?: boolean } = {},
): DreamMachineryManager {
  const store = {
    listRecentSessions: (_agent: string, _limit: number) => {
      if (opts.throwOnList) throw new Error("boom");
      return sessions;
    },
    getTurnsForSession: (sessionId: string) =>
      turnsBySession[sessionId] ?? [],
  };
  return {
    getMemoryStore: () => undefined,
    getConversationStore: () =>
      opts.noStore
        ? undefined
        : (store as unknown as ReturnType<
            DreamMachineryManager["getConversationStore"]
          >),
  };
}

describe("deriveLastTurnAt", () => {
  it("returns null when the agent has no live ConversationStore", () => {
    const manager = makeManager([], {}, { noStore: true });
    expect(deriveLastTurnAt("agent-a", manager, makeLog())).toBeNull();
  });

  it("returns null when no session has any turns (agent never spoke)", () => {
    const manager = makeManager([{ id: "s1" }, { id: "s2" }], {
      s1: [],
      s2: [],
    });
    // null is the correct "no-prior-turn" signal — a cron must NOT dream
    // an agent that never spoke.
    expect(deriveLastTurnAt("agent-a", manager, makeLog())).toBeNull();
  });

  it("returns the max createdAt across turns in the most recent session", () => {
    const manager = makeManager([{ id: "s1" }], {
      s1: [
        { createdAt: "2026-05-20T01:00:00.000Z" },
        { createdAt: "2026-05-20T03:30:00.000Z" },
        { createdAt: "2026-05-20T02:15:00.000Z" },
      ],
    });
    const result = deriveLastTurnAt("agent-a", manager, makeLog());
    expect(result?.toISOString()).toBe("2026-05-20T03:30:00.000Z");
  });

  it("falls back to a prior session when the newest session is empty (boot edge)", () => {
    // startAgent creates a fresh EMPTY active session at boot. Scanning
    // only the newest session would collapse lastTurnAt to null and the
    // cron would never fire. The scan across recent sessions finds the
    // prior session's last real turn.
    const manager = makeManager([{ id: "fresh" }, { id: "prior" }], {
      fresh: [],
      prior: [
        { createdAt: "2026-05-19T22:00:00.000Z" },
        { createdAt: "2026-05-19T23:45:00.000Z" },
      ],
    });
    const result = deriveLastTurnAt("agent-a", manager, makeLog());
    expect(result?.toISOString()).toBe("2026-05-19T23:45:00.000Z");
  });

  it("ignores unparseable createdAt values", () => {
    const manager = makeManager([{ id: "s1" }], {
      s1: [
        { createdAt: "not-a-date" },
        { createdAt: "2026-05-20T05:00:00.000Z" },
      ],
    });
    const result = deriveLastTurnAt("agent-a", manager, makeLog());
    expect(result?.toISOString()).toBe("2026-05-20T05:00:00.000Z");
  });

  it("is best-effort — a store error yields null, never throws", () => {
    const manager = makeManager([], {}, { throwOnList: true });
    const log = makeLog();
    expect(() => deriveLastTurnAt("agent-a", manager, log)).not.toThrow();
    expect(deriveLastTurnAt("agent-a", manager, log)).toBeNull();
    expect(log.warn).toHaveBeenCalled();
  });

  it("scans at most LAST_TURN_SESSION_SCAN_LIMIT sessions", () => {
    const listRecentSessions = vi.fn(() => []);
    const manager: DreamMachineryManager = {
      getMemoryStore: () => undefined,
      getConversationStore: () =>
        ({
          listRecentSessions,
          getTurnsForSession: () => [],
        }) as unknown as ReturnType<
          DreamMachineryManager["getConversationStore"]
        >,
    };
    deriveLastTurnAt("agent-a", manager, makeLog());
    expect(listRecentSessions).toHaveBeenCalledWith(
      "agent-a",
      LAST_TURN_SESSION_SCAN_LIMIT,
    );
  });
});

/**
 * Phase 999.113 WS-6 — dream run-log rows appended by the machinery's
 * applyDreamResult adapter (the single choke point both the manual IPC
 * trigger and the idle cron flow through). One row per pass, on EVERY
 * outcome; a run-log failure must never affect the apply result.
 *
 * Uses the `dreamRunLogDir` seam so no test ever touches the real
 * ~/.clawcode/manager/dream-runs.jsonl.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach } from "vitest";
import { buildDreamMachinery } from "../dream-machinery.js";
import { listRecentDreamRuns } from "../dream-run-log.js";
import type { DreamPassOutcome, DreamResult } from "../dream-pass.js";

describe("buildDreamMachinery — dream run-log rows (WS-6)", () => {
  let tmpRoot: string;
  let runLogDir: string;
  let memoryRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "ws6-machinery-"));
    runLogDir = join(tmpRoot, "runlog");
    memoryRoot = join(tmpRoot, "memory");
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  const FIXED_NOW = new Date("2026-08-28T10:00:00.000Z");

  function makeMachinery(logDirOverride?: string) {
    return buildDreamMachinery({
      manager: makeManager([], {}),
      resolveMemoryRoot: () => memoryRoot,
      dispatch: async () => {
        throw new Error("dispatch must not be called by applyDreamResult");
      },
      now: () => FIXED_NOW,
      log: makeLog(),
      dreamRunLogDir: logDirOverride ?? runLogDir,
    });
  }

  function completedOutcome(): DreamPassOutcome {
    const result: DreamResult = {
      newWikilinks: [
        { from: "note-a", to: "note-b", rationale: "synthetic-fixture" },
      ],
      promotionCandidates: [],
      themedReflection: "synthetic reflection",
      suggestedConsolidations: [],
    };
    return {
      kind: "completed",
      result,
      durationMs: 4321,
      tokensIn: 10,
      tokensOut: 20,
      model: "haiku",
    };
  }

  it("appends an 'applied' row with wikilinks_added on a successful apply", async () => {
    const machinery = makeMachinery();
    const applied = await machinery.applyDreamResult(
      "agent-a",
      completedOutcome(),
    );
    expect(applied.kind).toBe("applied");

    const rows = await listRecentDreamRuns(10, runLogDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent: "agent-a",
      status: "applied",
      wikilinks_added: 1,
    });
    // No runDreamPass timing recorded in this direct-apply test — the
    // fallback uses the pass's own durationMs + the injected clock.
    expect(rows[0]!.duration_ms).toBe(4321);
    expect(rows[0]!.started_at).toBe(FIXED_NOW.toISOString());
  });

  it("appends a 'failed' row carrying the pass error", async () => {
    const machinery = makeMachinery();
    const applied = await machinery.applyDreamResult("agent-a", {
      kind: "failed",
      error: "parse-failed: Unexpected token",
    });
    // Apply-side behavior unchanged: non-completed outcomes skip.
    expect(applied.kind).toBe("skipped");

    const rows = await listRecentDreamRuns(10, runLogDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent: "agent-a",
      status: "failed",
      reason: "parse-failed: Unexpected token",
    });
  });

  it("appends a 'noop' row for a skipped pass", async () => {
    const machinery = makeMachinery();
    await machinery.applyDreamResult("agent-a", {
      kind: "skipped",
      reason: "disabled",
    });
    const rows = await listRecentDreamRuns(10, runLogDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent: "agent-a",
      status: "noop",
      reason: "pass-skipped: disabled",
    });
  });

  it("a run-log failure never affects the apply result", async () => {
    // Point the run-log at an impossible directory (child of a plain
    // file) so mkdir fails — append swallows, apply must still succeed.
    const machinery = makeMachinery(join(tmpRoot, "blocked", "\0bad"));
    const applied = await machinery.applyDreamResult(
      "agent-a",
      completedOutcome(),
    );
    expect(applied.kind).toBe("applied");
  });
});
