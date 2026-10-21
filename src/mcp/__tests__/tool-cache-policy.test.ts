/**
 * Phase 115 Plan 07 T02 — tool-cache-policy unit tests.
 *
 * Verifies:
 *   - DEFAULT_TOOL_CACHE_POLICY locks the per-tool TTL + strategy table.
 *   - isReadOnlySql accepts SELECT/WITH/SHOW/DESCRIBE/EXPLAIN, rejects all
 *     write keywords AND CTE-then-write patterns.
 *   - buildCacheKey produces the SAME key across agents for cross-agent
 *     strategy (web_search) — proves cross-agent sharing is wired.
 *   - buildCacheKey produces DIFFERENT keys across agents for per-agent
 *     strategy (search_documents) — proves Phase 90 isolation.
 *   - stampCachedResponse wraps the data with `cached.age_ms` + `source`.
 *   - stableStringify is order-insensitive (`{a, b}` and `{b, a}` → same key).
 *   - resolveToolCachePolicy applies operator overrides.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_TOOL_CACHE_POLICY,
  buildCacheKey,
  isReadOnlySql,
  stampCachedResponse,
  resolveToolCachePolicy,
} from "../tool-cache-policy.js";

describe("DEFAULT_TOOL_CACHE_POLICY (Phase 115 Plan 07 T02)", () => {
  it("web_search / brave_search / exa_search are cross-agent at 300s", () => {
    expect(DEFAULT_TOOL_CACHE_POLICY.web_search!.keyStrategy).toBe("cross-agent");
    expect(DEFAULT_TOOL_CACHE_POLICY.web_search!.ttlSeconds).toBe(300);
    expect(DEFAULT_TOOL_CACHE_POLICY.brave_search!.keyStrategy).toBe("cross-agent");
    expect(DEFAULT_TOOL_CACHE_POLICY.brave_search!.ttlSeconds).toBe(300);
    expect(DEFAULT_TOOL_CACHE_POLICY.exa_search!.keyStrategy).toBe("cross-agent");
    expect(DEFAULT_TOOL_CACHE_POLICY.exa_search!.ttlSeconds).toBe(300);
  });

  it("search_documents is per-agent at 1800s (Phase 90 isolation)", () => {
    const p = DEFAULT_TOOL_CACHE_POLICY.search_documents!;
    expect(p.keyStrategy).toBe("per-agent");
    expect(p.ttlSeconds).toBe(1800);
  });

  it("mysql_query is per-agent at 60s with isReadOnlySql gate", () => {
    const p = DEFAULT_TOOL_CACHE_POLICY.mysql_query!;
    expect(p.keyStrategy).toBe("per-agent");
    expect(p.ttlSeconds).toBe(60);
    expect(p.cacheable).toBeDefined();
    expect(p.cacheable!({ query: "SELECT * FROM users" })).toBe(true);
    expect(p.cacheable!({ query: "INSERT INTO users (n) VALUES (1)" })).toBe(false);
  });

  it("google_workspace_*_get tools are per-agent at 300s", () => {
    expect(DEFAULT_TOOL_CACHE_POLICY.google_workspace_drive_get!.keyStrategy).toBe("per-agent");
    expect(DEFAULT_TOOL_CACHE_POLICY.google_workspace_drive_get!.ttlSeconds).toBe(300);
    expect(DEFAULT_TOOL_CACHE_POLICY.google_workspace_calendar_get!.keyStrategy).toBe("per-agent");
    expect(DEFAULT_TOOL_CACHE_POLICY.google_workspace_gmail_get!.keyStrategy).toBe("per-agent");
  });

  it("image_generate / spawn_subagent_thread are no-cache (TTL 0)", () => {
    expect(DEFAULT_TOOL_CACHE_POLICY.image_generate!.ttlSeconds).toBe(0);
    expect(DEFAULT_TOOL_CACHE_POLICY.image_generate!.keyStrategy).toBe("no-cache");
    expect(DEFAULT_TOOL_CACHE_POLICY.spawn_subagent_thread!.ttlSeconds).toBe(0);
    expect(DEFAULT_TOOL_CACHE_POLICY.spawn_subagent_thread!.keyStrategy).toBe("no-cache");
  });

  it("policy table is frozen (operator-side overrides go through resolveToolCachePolicy)", () => {
    expect(Object.isFrozen(DEFAULT_TOOL_CACHE_POLICY)).toBe(true);
  });
});

describe("isReadOnlySql (write-pattern detector)", () => {
  it("accepts SELECT", () => {
    expect(isReadOnlySql("SELECT * FROM users")).toBe(true);
    expect(isReadOnlySql("  select id from t  ")).toBe(true);
  });

  it("accepts WITH (CTE)", () => {
    expect(isReadOnlySql("WITH foo AS (SELECT 1) SELECT * FROM foo")).toBe(true);
  });

  it("accepts SHOW / DESCRIBE / EXPLAIN", () => {
    expect(isReadOnlySql("SHOW TABLES")).toBe(true);
    expect(isReadOnlySql("DESCRIBE users")).toBe(true);
    expect(isReadOnlySql("EXPLAIN SELECT * FROM users")).toBe(true);
  });

  it("rejects INSERT", () => {
    expect(isReadOnlySql("INSERT INTO users (id) VALUES (1)")).toBe(false);
    expect(isReadOnlySql("  insert into t values(1)")).toBe(false);
  });

  it("rejects UPDATE", () => {
    expect(isReadOnlySql("UPDATE users SET name = 'x' WHERE id = 1")).toBe(false);
  });

  it("rejects DELETE", () => {
    expect(isReadOnlySql("DELETE FROM users WHERE id = 1")).toBe(false);
  });

  it("rejects DROP / ALTER / TRUNCATE / GRANT / REVOKE", () => {
    expect(isReadOnlySql("DROP TABLE users")).toBe(false);
    expect(isReadOnlySql("ALTER TABLE users ADD COLUMN x INT")).toBe(false);
    expect(isReadOnlySql("TRUNCATE users")).toBe(false);
    expect(isReadOnlySql("GRANT SELECT ON db.* TO user")).toBe(false);
    expect(isReadOnlySql("REVOKE INSERT ON db.* FROM user")).toBe(false);
  });

  it("rejects CTE-then-write — the CRITICAL case", () => {
    // `WITH foo AS (SELECT 1) UPDATE bar SET x = 1 ...` — leading WITH passes
    // shape check but actual statement mutates state. Defence-in-depth check
    // catches the inner write keyword.
    expect(isReadOnlySql("WITH foo AS (SELECT 1) UPDATE bar SET x = 1")).toBe(false);
    expect(isReadOnlySql("WITH x AS (SELECT 1) DELETE FROM y WHERE id = 1")).toBe(false);
    expect(isReadOnlySql("WITH x AS (SELECT 1) INSERT INTO y VALUES (2)")).toBe(false);
  });

  it("rejects empty / whitespace-only queries", () => {
    expect(isReadOnlySql("")).toBe(false);
    expect(isReadOnlySql("   ")).toBe(false);
  });

  it("rejects EXEC / CALL / MERGE", () => {
    expect(isReadOnlySql("EXEC sp_users")).toBe(false);
    expect(isReadOnlySql("CALL my_proc()")).toBe(false);
    expect(isReadOnlySql("MERGE INTO t USING s ON t.id = s.id")).toBe(false);
  });

  it("accepts queries containing words that look like writes only as substrings of identifiers", () => {
    // `updated_at` column name — the word `update` does NOT appear with word
    // boundaries on both sides, so the regex must not flag it.
    expect(isReadOnlySql("SELECT updated_at FROM users")).toBe(true);
    expect(isReadOnlySql("SELECT * FROM insertions WHERE id = 1")).toBe(true);
  });
});

describe("buildCacheKey — keying strategies", () => {
  it("cross-agent: produces SAME key for two agents with same args", () => {
    const k1 = buildCacheKey(
      "web_search",
      { q: "claude" },
      "agent1",
      "cross-agent",
    );
    const k2 = buildCacheKey(
      "web_search",
      { q: "claude" },
      "agent2",
      "cross-agent",
    );
    expect(k1).toBe(k2);
  });

  it("per-agent: produces DIFFERENT keys for two agents with same args", () => {
    const k1 = buildCacheKey(
      "search_documents",
      { q: "memo" },
      "agent1",
      "per-agent",
    );
    const k2 = buildCacheKey(
      "search_documents",
      { q: "memo" },
      "agent2",
      "per-agent",
    );
    expect(k1).not.toBe(k2);
  });

  it("per-agent: same agent + same args → same key", () => {
    const k1 = buildCacheKey(
      "search_documents",
      { q: "memo", k: 5 },
      "agent1",
      "per-agent",
    );
    const k2 = buildCacheKey(
      "search_documents",
      { q: "memo", k: 5 },
      "agent1",
      "per-agent",
    );
    expect(k1).toBe(k2);
  });

  it("arg-order-insensitive: { a, b } and { b, a } → same key", () => {
    const k1 = buildCacheKey(
      "web_search",
      { a: 1, b: 2 },
      "agent1",
      "cross-agent",
    );
    const k2 = buildCacheKey(
      "web_search",
      { b: 2, a: 1 },
      "agent1",
      "cross-agent",
    );
    expect(k1).toBe(k2);
  });

  it("nested object args also stable-stringify (deep order-insensitive)", () => {
    const k1 = buildCacheKey(
      "search_documents",
      { q: "x", filter: { source: "wiki", tag: "ops" } },
      "agent1",
      "per-agent",
    );
    const k2 = buildCacheKey(
      "search_documents",
      { filter: { tag: "ops", source: "wiki" }, q: "x" },
      "agent1",
      "per-agent",
    );
    expect(k1).toBe(k2);
  });

  it("different tool names → different keys", () => {
    const k1 = buildCacheKey("web_search", { q: "x" }, "agent1", "cross-agent");
    const k2 = buildCacheKey("brave_search", { q: "x" }, "agent1", "cross-agent");
    expect(k1).not.toBe(k2);
  });

  it("key prefix includes tool name (per-agent format includes agent prefix)", () => {
    const cross = buildCacheKey("web_search", { q: "x" }, "agentA", "cross-agent");
    expect(cross.startsWith("web_search:")).toBe(true);
    expect(cross).not.toContain("agentA");

    const per = buildCacheKey(
      "search_documents",
      { q: "x" },
      "agentA",
      "per-agent",
    );
    expect(per.startsWith("search_documents:agentA:")).toBe(true);
  });
});

describe("stampCachedResponse — staleness wrap", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-08T06:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("wraps data with cached.age_ms + source", () => {
    const fiveSecondsAgo = Date.now() - 5_000;
    const stamped = stampCachedResponse({ rows: [1, 2] }, fiveSecondsAgo);
    expect(stamped.cached.source).toBe("tool-cache");
    expect(stamped.cached.age_ms).toBe(5_000);
    expect(stamped.data).toEqual({ rows: [1, 2] });
  });

  it("clamps negative age to 0 (created_at slightly in future for clock skew)", () => {
    const stamped = stampCachedResponse({ x: 1 }, Date.now() + 100);
    expect(stamped.cached.age_ms).toBe(0);
  });

  it("envelope is frozen", () => {
    const stamped = stampCachedResponse({ x: 1 }, Date.now() - 1000);
    expect(Object.isFrozen(stamped)).toBe(true);
    expect(Object.isFrozen(stamped.cached)).toBe(true);
  });
});

describe("resolveToolCachePolicy — operator overrides", () => {
  it("returns baseline default when no override", () => {
    const p = resolveToolCachePolicy("web_search");
    expect(p.ttlSeconds).toBe(300);
    expect(p.keyStrategy).toBe("cross-agent");
  });

  it("falls through to no-cache stub for unknown tools", () => {
    const p = resolveToolCachePolicy("unknown_tool");
    expect(p.ttlSeconds).toBe(0);
    expect(p.keyStrategy).toBe("no-cache");
  });

  it("operator can shorten TTL", () => {
    const p = resolveToolCachePolicy("web_search", {
      web_search: { ttlSeconds: 60 },
    });
    expect(p.ttlSeconds).toBe(60);
    expect(p.keyStrategy).toBe("cross-agent"); // strategy unchanged
  });

  it("operator can flip strategy", () => {
    const p = resolveToolCachePolicy("web_search", {
      web_search: { keyStrategy: "per-agent" },
    });
    expect(p.keyStrategy).toBe("per-agent");
    expect(p.ttlSeconds).toBe(300); // ttl unchanged
  });

  it("operator override preserves the cacheable predicate (mysql_query)", () => {
    const p = resolveToolCachePolicy("mysql_query", {
      mysql_query: { ttlSeconds: 30 },
    });
    expect(p.ttlSeconds).toBe(30);
    expect(p.cacheable).toBeDefined();
    expect(p.cacheable!({ query: "SELECT 1" })).toBe(true);
    expect(p.cacheable!({ query: "DELETE FROM x" })).toBe(false);
  });
});
