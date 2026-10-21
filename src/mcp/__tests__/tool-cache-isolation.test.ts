/**
 * Phase 115 Plan 07 T03 — tool-cache-isolation tests.
 *
 * BLOCKING-CRITICAL invariant verification:
 *   - web_search: cross-agent shared (public data) — second agent's call
 *     hits the first agent's cache row. ONE row in tool_cache with
 *     `agent_or_null = NULL`.
 *   - search_documents: per-agent isolated (Phase 90 lock) — second
 *     agent's call MISSES the first agent's cache. TWO rows in tool_cache
 *     with distinct `agent_or_null` values.
 *
 * Plus:
 *   - mysql_query: SELECT cached, INSERT/UPDATE/DELETE never cached.
 *   - bypass_cache: true → forces fresh upstream call regardless of cache state.
 *   - Cache hit returns wrapped { cached: { age_ms, source }, data }.
 *   - Cache miss returns raw upstream response (unwrapped).
 *   - Cache survives across upstream call boundaries (persistent storage).
 *
 * The runtime SQL assertions over `agent_or_null` are the load-bearing
 * proof — greps over source code show INTENT, but only this test
 * verifies BEHAVIOR.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ToolCacheStore } from "../tool-cache-store.js";
import {
  dispatchTool,
  type ToolCacheTraceRecorder,
} from "../tool-dispatch.js";

interface FakeRecorder extends ToolCacheTraceRecorder {
  hits: Array<{ agent: string; tool: string }>;
  misses: Array<{ agent: string; tool: string }>;
}

function makeRecorder(): FakeRecorder {
  return {
    hits: [],
    misses: [],
    recordToolCacheHit(agent, tool) {
      this.hits.push({ agent, tool });
    },
    recordToolCacheMiss(agent, tool) {
      this.misses.push({ agent, tool });
    },
  };
}

describe("dispatchTool isolation (Phase 115 Plan 07 T03)", () => {
  let tmp: string;
  let dbPath: string;
  let store: ToolCacheStore;
  let recorder: FakeRecorder;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "tool-cache-isolation-test-"));
    dbPath = join(tmp, "tool-cache.db");
    store = new ToolCacheStore({ path: dbPath });
    recorder = makeRecorder();
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  // ── BLOCKING-CRITICAL TESTS ─────────────────────────────────────────

  it("CROSS-AGENT: two agents call web_search with same args → SHARED cache (one row, agent_or_null = NULL)", async () => {
    let upstreamCalls = 0;
    const upstream = async () => {
      upstreamCalls++;
      return { hits: [{ url: "https://example.com" }] };
    };

    // Agent A
    const r1 = (await dispatchTool({
      tool: "web_search",
      args: { query: "claude code" },
      agentName: "agentA",
      cacheStore: store,
      maxSizeMb: 100,
      upstream,
      traceCollector: recorder,
    })) as { hits: unknown[] };

    // Agent B — same args. SHOULD HIT agent A's cached row.
    const r2 = (await dispatchTool({
      tool: "web_search",
      args: { query: "claude code" },
      agentName: "agentB",
      cacheStore: store,
      maxSizeMb: 100,
      upstream,
      traceCollector: recorder,
    })) as { cached?: unknown; data?: { hits: unknown[] } } & {
      hits?: unknown[];
    };

    // Upstream ran exactly ONCE — second call hit the cache.
    expect(upstreamCalls).toBe(1);

    // Agent A's response is the raw upstream return (miss).
    expect((r1 as { hits: unknown[] }).hits).toBeDefined();

    // Agent B's response is wrapped in CacheStamped envelope (hit).
    expect((r2 as { cached?: unknown }).cached).toBeDefined();
    expect((r2 as { data?: unknown }).data).toEqual({
      hits: [{ url: "https://example.com" }],
    });

    // Trace recorder saw 1 miss + 1 hit.
    expect(recorder.misses).toHaveLength(1);
    expect(recorder.hits).toHaveLength(1);
    expect(recorder.hits[0]!.agent).toBe("agentB"); // agent B got the hit

    // SQL assertion: ONE row, agent_or_null = NULL (cross-agent shared).
    const db = new Database(dbPath);
    const rows = db
      .prepare("SELECT agent_or_null, tool FROM tool_cache WHERE tool = 'web_search'")
      .all() as Array<{ agent_or_null: string | null; tool: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agent_or_null).toBeNull(); // ← THE LOAD-BEARING ASSERTION
    db.close();
  });

  it("PER-AGENT: two agents call search_documents with same args → ISOLATED caches (two rows, distinct agent_or_null)", async () => {
    let upstreamCalls = 0;
    const upstream = async () => {
      upstreamCalls++;
      return { results: [{ chunk_id: `c${upstreamCalls}` }] };
    };

    // Agent A
    const r1 = (await dispatchTool({
      tool: "search_documents",
      args: { query: "memo", limit: 5 },
      agentName: "agentA",
      cacheStore: store,
      maxSizeMb: 100,
      upstream,
      traceCollector: recorder,
    })) as { results: Array<{ chunk_id: string }> };

    // Agent B — same args, but per-agent strategy means DIFFERENT key.
    // SHOULD MISS, upstream runs again.
    const r2 = (await dispatchTool({
      tool: "search_documents",
      args: { query: "memo", limit: 5 },
      agentName: "agentB",
      cacheStore: store,
      maxSizeMb: 100,
      upstream,
      traceCollector: recorder,
    })) as { results: Array<{ chunk_id: string }> };

    // Upstream ran TWICE — distinct keys per agent.
    expect(upstreamCalls).toBe(2);

    // Both responses are raw upstream returns (no `cached` envelope).
    expect((r1 as { cached?: unknown }).cached).toBeUndefined();
    expect((r2 as { cached?: unknown }).cached).toBeUndefined();

    // Each agent got its own upstream call result.
    expect(r1.results[0]!.chunk_id).toBe("c1");
    expect(r2.results[0]!.chunk_id).toBe("c2");

    // Trace recorder saw 2 misses, 0 hits.
    expect(recorder.misses).toHaveLength(2);
    expect(recorder.hits).toHaveLength(0);

    // SQL assertion: TWO rows, distinct agent_or_null per agent.
    const db = new Database(dbPath);
    const rows = db
      .prepare(
        "SELECT agent_or_null FROM tool_cache WHERE tool = 'search_documents' ORDER BY agent_or_null",
      )
      .all() as Array<{ agent_or_null: string | null }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.agent_or_null).toBe("agentA");
    expect(rows[1]!.agent_or_null).toBe("agentB");
    db.close();
  });

  it("PER-AGENT: agent A's second identical search_documents call HITS its own cache", async () => {
    let upstreamCalls = 0;
    const upstream = async () => {
      upstreamCalls++;
      return { results: [{ chunk_id: `c${upstreamCalls}` }] };
    };

    await dispatchTool({
      tool: "search_documents",
      args: { query: "memo" },
      agentName: "agentA",
      cacheStore: store,
      maxSizeMb: 100,
      upstream,
    });

    const r2 = (await dispatchTool({
      tool: "search_documents",
      args: { query: "memo" },
      agentName: "agentA",
      cacheStore: store,
      maxSizeMb: 100,
      upstream,
    })) as { cached?: unknown; data?: { results: unknown[] } };

    expect(upstreamCalls).toBe(1);
    expect(r2.cached).toBeDefined();
  });

  // ── mysql_query write-pattern tests ──────────────────────────────────

  it("mysql_query SELECT is cached (read pattern)", async () => {
    let upstreamCalls = 0;
    const upstream = async () => {
      upstreamCalls++;
      return { rows: [{ id: 1 }] };
    };

    await dispatchTool({
      tool: "mysql_query",
      args: { query: "SELECT * FROM users WHERE id = 1" },
      agentName: "agentA",
      cacheStore: store,
      maxSizeMb: 100,
      upstream,
    });

    const r2 = (await dispatchTool({
      tool: "mysql_query",
      args: { query: "SELECT * FROM users WHERE id = 1" },
      agentName: "agentA",
      cacheStore: store,
      maxSizeMb: 100,
      upstream,
    })) as { cached?: unknown };

    expect(upstreamCalls).toBe(1);
    expect(r2.cached).toBeDefined();
  });

  it("M5: mysql_query is PER-AGENT isolated — agent A's cached SELECT does NOT serve agent B", async () => {
    // mysql_query is keyStrategy:"per-agent" (acme-db rows can be
    // client/credential-sensitive — see tool-cache.ts credential note). The
    // future caching proxy relies on this isolation: a cached read for one
    // agent must NEVER leak to another. Two agents, identical query → TWO
    // upstream calls + TWO distinct per-agent rows (agent_or_null = agentName).
    let upstreamCalls = 0;
    const upstream = async () => {
      upstreamCalls++;
      return { rows: [{ id: 1, secret: "client-pii" }] };
    };

    const rA = (await dispatchTool({
      tool: "mysql_query",
      args: { query: "SELECT * FROM clients WHERE id = 1" },
      agentName: "fin-client",
      cacheStore: store,
      maxSizeMb: 100,
      upstream,
    })) as { rows?: unknown[] };

    const rB = (await dispatchTool({
      tool: "mysql_query",
      args: { query: "SELECT * FROM clients WHERE id = 1" },
      agentName: "fin-tax",
      cacheStore: store,
      maxSizeMb: 100,
      upstream,
    })) as { cached?: unknown; rows?: unknown[] };

    // Agent B MISSED agent A's row → upstream ran twice, B's result is raw
    // (unwrapped), NOT a CacheStamped hit.
    expect(upstreamCalls).toBe(2);
    expect((rA as { rows?: unknown[] }).rows).toBeDefined();
    expect((rB as { cached?: unknown }).cached).toBeUndefined();
    expect((rB as { rows?: unknown[] }).rows).toBeDefined();

    // Two distinct per-agent rows, each stamped with its own agent (never NULL
    // — a NULL row would be cross-agent shared, an isolation breach).
    const db = new Database(dbPath);
    const rows = db
      .prepare(
        "SELECT agent_or_null FROM tool_cache WHERE tool = 'mysql_query' ORDER BY agent_or_null",
      )
      .all() as Array<{ agent_or_null: string | null }>;
    db.close();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.agent_or_null)).toEqual([
      "fin-client",
      "fin-tax",
    ]);
    expect(rows.every((r) => r.agent_or_null !== null)).toBe(true);
  });

  it("M5: a same-agent repeat of agent A's SELECT serves the cached row (hit), proving the proxy can rely on cache reuse", async () => {
    let upstreamCalls = 0;
    const upstream = async () => {
      upstreamCalls++;
      return { rows: [{ id: 7 }] };
    };
    const args = { query: "SELECT name FROM clients WHERE id = 7" };

    await dispatchTool({
      tool: "mysql_query",
      args,
      agentName: "fin-client",
      cacheStore: store,
      maxSizeMb: 100,
      upstream,
    });
    const hit = (await dispatchTool({
      tool: "mysql_query",
      args,
      agentName: "fin-client",
      cacheStore: store,
      maxSizeMb: 100,
      upstream,
    })) as { cached?: { source?: string }; data?: unknown };

    expect(upstreamCalls).toBe(1); // second call served from cache
    expect(hit.cached).toBeDefined();
    expect(hit.cached!.source).toBe("tool-cache");
    expect(hit.data).toEqual({ rows: [{ id: 7 }] });
  });

  it("mysql_query INSERT is NEVER cached", async () => {
    let upstreamCalls = 0;
    const upstream = async () => {
      upstreamCalls++;
      return { affected: 1 };
    };

    await dispatchTool({
      tool: "mysql_query",
      args: { query: "INSERT INTO users (n) VALUES ('alice')" },
      agentName: "agentA",
      cacheStore: store,
      maxSizeMb: 100,
      upstream,
    });
    await dispatchTool({
      tool: "mysql_query",
      args: { query: "INSERT INTO users (n) VALUES ('alice')" },
      agentName: "agentA",
      cacheStore: store,
      maxSizeMb: 100,
      upstream,
    });

    expect(upstreamCalls).toBe(2);

    const db = new Database(dbPath);
    const rows = db
      .prepare("SELECT COUNT(*) AS n FROM tool_cache WHERE tool = 'mysql_query'")
      .get() as { n: number };
    expect(rows.n).toBe(0); // No row created for INSERT
    db.close();
  });

  it("mysql_query UPDATE is NEVER cached", async () => {
    let upstreamCalls = 0;
    const upstream = async () => {
      upstreamCalls++;
      return { affected: 1 };
    };

    await dispatchTool({
      tool: "mysql_query",
      args: { query: "UPDATE users SET name = 'bob' WHERE id = 1" },
      agentName: "agentA",
      cacheStore: store,
      maxSizeMb: 100,
      upstream,
    });
    await dispatchTool({
      tool: "mysql_query",
      args: { query: "UPDATE users SET name = 'bob' WHERE id = 1" },
      agentName: "agentA",
      cacheStore: store,
      maxSizeMb: 100,
      upstream,
    });

    expect(upstreamCalls).toBe(2);
  });

  it("mysql_query DELETE is NEVER cached", async () => {
    let upstreamCalls = 0;
    const upstream = async () => {
      upstreamCalls++;
      return { affected: 1 };
    };

    await dispatchTool({
      tool: "mysql_query",
      args: { query: "DELETE FROM users WHERE id = 1" },
      agentName: "agentA",
      cacheStore: store,
      maxSizeMb: 100,
      upstream,
    });
    await dispatchTool({
      tool: "mysql_query",
      args: { query: "DELETE FROM users WHERE id = 1" },
      agentName: "agentA",
      cacheStore: store,
      maxSizeMb: 100,
      upstream,
    });

    expect(upstreamCalls).toBe(2);
  });

  it("mysql_query CTE-then-write is NEVER cached", async () => {
    let upstreamCalls = 0;
    const upstream = async () => {
      upstreamCalls++;
      return { affected: 1 };
    };

    // The trap pattern — leading WITH passes shape check but inner UPDATE
    // mutates state. isReadOnlySql's defence-in-depth check catches this.
    await dispatchTool({
      tool: "mysql_query",
      args: {
        query: "WITH x AS (SELECT 1 AS n) UPDATE bar SET y = (SELECT n FROM x)",
      },
      agentName: "agentA",
      cacheStore: store,
      maxSizeMb: 100,
      upstream,
    });
    await dispatchTool({
      tool: "mysql_query",
      args: {
        query: "WITH x AS (SELECT 1 AS n) UPDATE bar SET y = (SELECT n FROM x)",
      },
      agentName: "agentA",
      cacheStore: store,
      maxSizeMb: 100,
      upstream,
    });

    expect(upstreamCalls).toBe(2);
  });

  // ── Bypass + image_generate tests ────────────────────────────────────

  it("bypass_cache: true forces fresh upstream call (no read, no write)", async () => {
    let upstreamCalls = 0;
    const upstream = async () => {
      upstreamCalls++;
      return { rows: [{ id: upstreamCalls }] };
    };

    // Plant a row that would otherwise hit.
    await dispatchTool({
      tool: "web_search",
      args: { query: "x" },
      agentName: "agentA",
      cacheStore: store,
      maxSizeMb: 100,
      upstream,
    });
    expect(upstreamCalls).toBe(1);

    // Same args + bypass_cache — should run upstream AGAIN.
    const r = (await dispatchTool({
      tool: "web_search",
      args: { query: "x", bypass_cache: true },
      agentName: "agentA",
      cacheStore: store,
      maxSizeMb: 100,
      upstream,
    })) as { rows?: Array<{ id: number }>; cached?: unknown };

    expect(upstreamCalls).toBe(2);
    // Bypass returns RAW upstream — no cached envelope.
    expect(r.cached).toBeUndefined();
    expect(r.rows![0]!.id).toBe(2);
  });

  it("image_generate is NEVER cached (no-cache strategy)", async () => {
    let upstreamCalls = 0;
    const upstream = async () => {
      upstreamCalls++;
      return { url: `https://img.example/${upstreamCalls}.png` };
    };

    await dispatchTool({
      tool: "image_generate",
      args: { prompt: "a cat" },
      agentName: "agentA",
      cacheStore: store,
      maxSizeMb: 100,
      upstream,
    });
    const r2 = (await dispatchTool({
      tool: "image_generate",
      args: { prompt: "a cat" },
      agentName: "agentA",
      cacheStore: store,
      maxSizeMb: 100,
      upstream,
    })) as { cached?: unknown };

    expect(upstreamCalls).toBe(2);
    expect(r2.cached).toBeUndefined();

    const db = new Database(dbPath);
    const rows = db
      .prepare(
        "SELECT COUNT(*) AS n FROM tool_cache WHERE tool = 'image_generate'",
      )
      .get() as { n: number };
    expect(rows.n).toBe(0);
    db.close();
  });

  it("spawn_subagent_thread is NEVER cached (no-cache strategy)", async () => {
    let upstreamCalls = 0;
    const upstream = async () => {
      upstreamCalls++;
      return { thread_id: `t${upstreamCalls}` };
    };

    await dispatchTool({
      tool: "spawn_subagent_thread",
      args: { task: "summarize" },
      agentName: "agentA",
      cacheStore: store,
      maxSizeMb: 100,
      upstream,
    });
    await dispatchTool({
      tool: "spawn_subagent_thread",
      args: { task: "summarize" },
      agentName: "agentA",
      cacheStore: store,
      maxSizeMb: 100,
      upstream,
    });

    expect(upstreamCalls).toBe(2);
  });

  // ── Cache stamping shape tests ───────────────────────────────────────

  it("cache hit returns { cached: { age_ms, source: 'tool-cache' }, data }", async () => {
    const upstream = async () => ({ payload: "first" });

    await dispatchTool({
      tool: "web_search",
      args: { query: "x" },
      agentName: "agentA",
      cacheStore: store,
      maxSizeMb: 100,
      upstream,
    });

    // Wait a tiny moment so age_ms is non-zero.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const hit = (await dispatchTool({
      tool: "web_search",
      args: { query: "x" },
      agentName: "agentA",
      cacheStore: store,
      maxSizeMb: 100,
      upstream,
    })) as { cached: { age_ms: number; source: string }; data: unknown };

    expect(hit.cached).toBeDefined();
    expect(hit.cached.source).toBe("tool-cache");
    expect(hit.cached.age_ms).toBeGreaterThanOrEqual(0);
    expect(hit.data).toEqual({ payload: "first" });
  });

  it("cache miss returns RAW upstream result (no cached envelope)", async () => {
    const upstream = async () => ({ rows: [1, 2, 3] });

    const result = (await dispatchTool({
      tool: "web_search",
      args: { query: "fresh" },
      agentName: "agentA",
      cacheStore: store,
      maxSizeMb: 100,
      upstream,
    })) as { cached?: unknown; rows?: number[] };

    expect(result.cached).toBeUndefined();
    expect(result.rows).toEqual([1, 2, 3]);
  });

  // ── Operator-policy override tests ───────────────────────────────────

  it("operator-override: setting web_search ttlSeconds=0 bypasses the cache", async () => {
    let upstreamCalls = 0;
    const upstream = async () => {
      upstreamCalls++;
      return { x: upstreamCalls };
    };

    const userPolicy = { web_search: { ttlSeconds: 0 } };

    await dispatchTool({
      tool: "web_search",
      args: { q: "y" },
      agentName: "agentA",
      cacheStore: store,
      maxSizeMb: 100,
      userPolicy,
      upstream,
    });
    await dispatchTool({
      tool: "web_search",
      args: { q: "y" },
      agentName: "agentA",
      cacheStore: store,
      maxSizeMb: 100,
      userPolicy,
      upstream,
    });
    // Both calls bypass — ttlSeconds: 0.
    expect(upstreamCalls).toBe(2);
  });

  it("operator-override: flipping search_documents to cross-agent shares across agents", async () => {
    let upstreamCalls = 0;
    const upstream = async () => {
      upstreamCalls++;
      return { results: [`r${upstreamCalls}`] };
    };

    // Override search_documents to cross-agent (operator decides corpus is shared).
    const userPolicy = {
      search_documents: { keyStrategy: "cross-agent" as const },
    };

    await dispatchTool({
      tool: "search_documents",
      args: { q: "memo" },
      agentName: "agentA",
      cacheStore: store,
      maxSizeMb: 100,
      userPolicy,
      upstream,
    });
    const r2 = (await dispatchTool({
      tool: "search_documents",
      args: { q: "memo" },
      agentName: "agentB",
      cacheStore: store,
      maxSizeMb: 100,
      userPolicy,
      upstream,
    })) as { cached?: unknown };

    // Upstream ran ONCE; agent B got agent A's cached row.
    expect(upstreamCalls).toBe(1);
    expect(r2.cached).toBeDefined();

    // SQL assertion: ONE row, agent_or_null = NULL (cross-agent flip).
    const db = new Database(dbPath);
    const rows = db
      .prepare(
        "SELECT agent_or_null FROM tool_cache WHERE tool = 'search_documents'",
      )
      .all() as Array<{ agent_or_null: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agent_or_null).toBeNull();
    db.close();
  });
});
