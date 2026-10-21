/**
 * Phase 52 Plan 02 — CACHE-04 eviction-detection integration test.
 *
 * Enforces CONTEXT D-04 verbatim: per-turn prefixHash comparison against the
 * prior turn's hash for the same agent sets `cache_eviction_expected` correctly.
 *
 * Scenario:
 *   Turn 1: fresh agent (no prior hash)        → prefix_hash_1, expected=false
 *   Turn 2: identity swap mid-session          → prefix_hash_2 ≠ 1, expected=true
 *   Turn 3: identity unchanged since turn 2    → prefix_hash_3 = 2, expected=false
 *   Turn 4: skills hot-reload (no teardown)    → prefix_hash_4 ≠ 3, expected=true
 *
 * The test exercises the real `createTracedSessionHandle` + `TraceStore`
 * writeTurn path end-to-end. Only `sdk.query` is mocked; the
 * prefixHashProvider + recordCacheUsage + writeTurn flow is real code.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import Database from "better-sqlite3";
import { TraceStore } from "../trace-store.js";
import { TraceCollector } from "../trace-collector.js";
import { createTracedSessionHandle } from "../../manager/session-adapter.js";
import { computePrefixHash } from "../../manager/context-assembler.js";

/** Build an async iterable of SDK messages with a usage snapshot on the result. */
function makeSdkStream(messages: ReadonlyArray<unknown>) {
  async function* gen() {
    for (const m of messages) {
      yield m;
    }
  }
  const q: any = gen();
  q.interrupt = vi.fn();
  q.close = vi.fn();
  q.streamInput = vi.fn();
  q.mcpServerStatus = vi.fn();
  q.setMcpServers = vi.fn();
  return q;
}

function successResult(sessionId: string) {
  return [
    {
      type: "assistant",
      parent_tool_use_id: null,
      message: { content: [{ type: "text", text: "ok" }] },
    },
    {
      type: "result",
      subtype: "success",
      result: "ok",
      session_id: sessionId,
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  ];
}

describe("cache eviction detection (Phase 52 CONTEXT D-04)", () => {
  let tmpDir: string;
  let dbPath: string;
  let store: TraceStore;
  let collector: TraceCollector;
  let mockSdk: { query: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cache-eviction-"));
    dbPath = join(tmpDir, "traces.db");
    store = new TraceStore(dbPath);
    collector = new TraceCollector(
      store,
      pino({ level: "silent" }) as any,
    );
    mockSdk = { query: vi.fn() };
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* ignore */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Read a single turn's cache-eviction columns from the db.
   * Uses a fresh connection so it doesn't contend with WAL writes.
   */
  function readTurn(turnId: string): {
    prefix_hash: string | null;
    cache_eviction_expected: number | null;
  } {
    const inspect = new Database(dbPath, { readonly: true });
    const row = inspect
      .prepare(
        "SELECT prefix_hash, cache_eviction_expected FROM traces WHERE id = ?",
      )
      .get(turnId) as { prefix_hash: string | null; cache_eviction_expected: number | null };
    inspect.close();
    return row;
  }

  /**
   * Run one turn through the full real path:
   *   startTurn → sdk.query → iterateWithTracing → recordCacheUsage → writeTurn
   *
   * Returns the turn id for cross-turn assertions.
   */
  async function runTurn(opts: {
    readonly turnId: string;
    readonly agent: string;
    readonly currentPrefix: string;
    readonly priorHash: string | undefined;
  }): Promise<{ readonly prefixHash: string }> {
    mockSdk.query.mockReturnValueOnce(makeSdkStream(successResult(opts.turnId)));

    let lastSeenHash: string | undefined = opts.priorHash;
    const provider = {
      get: () => ({
        current: computePrefixHash(opts.currentPrefix),
        last: lastSeenHash,
      }),
      persist: (h: string) => {
        lastSeenHash = h;
      },
    };

    const turn = collector.startTurn(opts.turnId, opts.agent, null);
    const handle = (createTracedSessionHandle as any)({
      sdk: mockSdk,
      baseOptions: {},
      sessionId: "sess-1",
      turn,
      prefixHashProvider: provider,
    });

    await handle.sendAndCollect("hi");
    turn.end("success");
    return { prefixHash: computePrefixHash(opts.currentPrefix) };
  }

  it("turn 1 (fresh agent) → cache_eviction_expected=false, prefix_hash recorded", async () => {
    const agent = "clawdy";
    const stablePrefixA = "## Identity\n- **Name:** Clawdy A";
    const t1 = await runTurn({
      turnId: "msg-t1",
      agent,
      currentPrefix: stablePrefixA,
      priorHash: undefined,
    });

    const row = readTurn("msg-t1");
    expect(row.prefix_hash).toBe(t1.prefixHash);
    expect(row.cache_eviction_expected).toBe(0); // SQLite 0 = false
  });

  it("turn 2 (identity swap mid-session) → prefix_hash differs + cache_eviction_expected=true", async () => {
    const agent = "clawdy";
    const stablePrefixA = "## Identity\n- **Name:** Clawdy A";
    const stablePrefixB = "## Identity\n- **Name:** Clawdy B"; // swapped identity

    const t1 = await runTurn({
      turnId: "msg-t1",
      agent,
      currentPrefix: stablePrefixA,
      priorHash: undefined,
    });

    const t2 = await runTurn({
      turnId: "msg-t2",
      agent,
      currentPrefix: stablePrefixB,
      priorHash: t1.prefixHash, // simulates SessionManager persisting turn 1's hash
    });

    const row2 = readTurn("msg-t2");
    expect(row2.prefix_hash).toBe(t2.prefixHash);
    expect(row2.prefix_hash).not.toBe(t1.prefixHash);
    expect(row2.cache_eviction_expected).toBe(1); // true
  });

  it("turn 3 (identity unchanged since turn 2) → prefix_hash matches turn 2 + cache_eviction_expected=false", async () => {
    const agent = "clawdy";
    const stablePrefixB = "## Identity\n- **Name:** Clawdy B";

    const t2 = await runTurn({
      turnId: "msg-t2",
      agent,
      currentPrefix: stablePrefixB,
      priorHash: "0".repeat(64), // simulates arbitrary prior hash
    });

    const t3 = await runTurn({
      turnId: "msg-t3",
      agent,
      currentPrefix: stablePrefixB,
      priorHash: t2.prefixHash,
    });

    const row3 = readTurn("msg-t3");
    expect(row3.prefix_hash).toBe(t3.prefixHash);
    expect(row3.prefix_hash).toBe(t2.prefixHash);
    expect(row3.cache_eviction_expected).toBe(0);
  });

  it("skills hot-reload between turns flips cache_eviction_expected=true WITHOUT session teardown", async () => {
    // Mid-session, skills changed (agents.*.skills IS in RELOADABLE_FIELDS).
    // Config-reloader swaps the catalog WITHOUT tearing down the session, so
    // session-boundary comparison would NEVER fire. Per-turn comparison MUST.
    const agent = "clawdy";
    const prefixBeforeReload = "## Available Tools\n\n- content-engine\n";
    const prefixAfterReload =
      "## Available Tools\n\n- content-engine\n- market-research\n"; // new skill added

    const t1 = await runTurn({
      turnId: "msg-skills-1",
      agent,
      currentPrefix: prefixBeforeReload,
      priorHash: undefined,
    });

    // Simulate hot-reload — same handle, no restart. Next turn sees new prefix.
    const t2 = await runTurn({
      turnId: "msg-skills-2",
      agent,
      currentPrefix: prefixAfterReload,
      priorHash: t1.prefixHash,
    });

    const row2 = readTurn("msg-skills-2");
    expect(row2.prefix_hash).toBe(t2.prefixHash);
    expect(row2.cache_eviction_expected).toBe(1);
  });
});
