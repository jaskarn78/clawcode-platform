/**
 * Phase 138 Plan 05 T-01 — `FailoverStateStore` CRUD tests.
 *
 * Exercises the `failover_state` table (owned + created by the store's
 * constructor) against an in-memory better-sqlite3 handle with an
 * injected deterministic clock.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { FailoverStateStore } from "../failover-state.js";

/** Mutable clock so a single test can advance time deterministically. */
function makeClock(start: number): { now: () => number; set: (t: number) => void } {
  let t = start;
  return { now: () => t, set: (next: number) => (t = next) };
}

describe("FailoverStateStore", () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  it("(a) set then get returns the row", () => {
    const clock = makeClock(1_000);
    const store = new FailoverStateStore({ db, clock: clock.now });
    store.set("clawdy", "codex-cli", "threshold-95");
    const row = store.get("clawdy");
    expect(row).toBeDefined();
    expect(row?.agent).toBe("clawdy");
    expect(row?.active_backend).toBe("codex-cli");
    expect(row?.reason).toBe("threshold-95");
    expect(row?.triggered_at).toBe(1_000);
    expect(row?.expires_at).toBeNull();
  });

  it("(b) set with expiresAt in the past — get returns undefined", () => {
    const clock = makeClock(10_000);
    const store = new FailoverStateStore({ db, clock: clock.now });
    store.set("clawdy", "codex-cli", "threshold-95", 5_000);
    expect(store.get("clawdy")).toBeUndefined();
  });

  it("(c) set with expiresAt null — get returns the row indefinitely", () => {
    const clock = makeClock(1_000);
    const store = new FailoverStateStore({ db, clock: clock.now });
    store.set("clawdy", "codex-cli", "manual", null);
    clock.set(999_999_999);
    expect(store.get("clawdy")?.active_backend).toBe("codex-cli");
  });

  it("(d) set twice for the same agent replaces (single row per PK)", () => {
    const clock = makeClock(1_000);
    const store = new FailoverStateStore({ db, clock: clock.now });
    store.set("clawdy", "codex-cli", "threshold-95");
    clock.set(2_000);
    store.set("clawdy", "anthropic-agent-sdk", "manual", null);
    const row = store.get("clawdy");
    expect(row?.active_backend).toBe("anthropic-agent-sdk");
    expect(row?.reason).toBe("manual");
    expect(row?.triggered_at).toBe(2_000);
    // Only one row total.
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM failover_state")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("(e) clear removes the row", () => {
    const clock = makeClock(1_000);
    const store = new FailoverStateStore({ db, clock: clock.now });
    store.set("clawdy", "codex-cli", "threshold-95", null);
    store.clear("clawdy");
    expect(store.get("clawdy")).toBeUndefined();
  });

  it("(f) listActive filters expired rows", () => {
    const clock = makeClock(10_000);
    const store = new FailoverStateStore({ db, clock: clock.now });
    store.set("alive-null", "codex-cli", "manual", null);
    store.set("alive-future", "codex-cli", "threshold-95", 20_000);
    store.set("dead-past", "codex-cli", "threshold-95", 5_000);
    const active = store.listActive(10_000);
    const names = active.map((r) => r.agent).sort();
    expect(names).toEqual(["alive-future", "alive-null"]);
  });

  it("(g) getActiveBackend returns the backend string or undefined", () => {
    const clock = makeClock(10_000);
    const store = new FailoverStateStore({ db, clock: clock.now });
    store.set("clawdy", "codex-cli", "threshold-95", null);
    expect(store.getActiveBackend("clawdy", 10_000)).toBe("codex-cli");
    expect(store.getActiveBackend("ghost", 10_000)).toBeUndefined();
    // Expired row → undefined.
    store.set("expired", "codex-cli", "threshold-95", 5_000);
    expect(store.getActiveBackend("expired", 10_000)).toBeUndefined();
  });
});
