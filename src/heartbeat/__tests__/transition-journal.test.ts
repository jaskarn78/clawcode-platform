/**
 * Phase 999.122 — heartbeat status-transition journal.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HeartbeatTransitionJournal } from "../transition-journal.js";

const T0 = Date.UTC(2026, 8, 5, 12, 0, 0);
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

describe("HeartbeatTransitionJournal", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("records status changes only: a first healthy observation is silent, a first warning is not", () => {
    const j = new HeartbeatTransitionJournal({ now: () => T0 });
    expect(j.record("a", "inbox", undefined, { status: "healthy", message: "ok" }, iso(0))).toBeNull();
    const first = j.record("a", "auto-linker", undefined, { status: "warning", message: "FK" }, iso(0));
    expect(first).toEqual({ timestamp: iso(0), agent: "a", check: "auto-linker", from: null, to: "warning", message: "FK" });
    // Same status again: nothing.
    expect(j.record("a", "auto-linker", "warning", { status: "warning", message: "FK" }, iso(1000))).toBeNull();
    // Recovery is a transition.
    const back = j.record("a", "auto-linker", "warning", { status: "healthy", message: "ok" }, iso(2000));
    expect(back?.from).toBe("warning");
    expect(back?.to).toBe("healthy");
    expect(j.all()).toHaveLength(2);
  });

  it("after a restart (previous unknown) it closes a journaled warning on the first healthy tick and never re-opens a still-warning one", () => {
    const j = new HeartbeatTransitionJournal({ now: () => T0 });
    j.record("fin", "memory-census", "healthy", { status: "warning", message: "118 cold files" }, iso(-3600_000));
    // Restart: runner has no previous status. Still warning → no new entry.
    expect(j.record("fin", "memory-census", undefined, { status: "warning", message: "118 cold files" }, iso(0))).toBeNull();
    // Now healthy → recovery journaled, from the journaled warning.
    const back = j.record("fin", "memory-census", undefined, { status: "healthy", message: "clean" }, iso(1000));
    expect(back).toMatchObject({ from: "warning", to: "healthy" });
    expect(j.summary(24 * 3600_000).byAgent.fin?.open).toEqual([]);
    expect(j.latestStatus("fin", "memory-census")).toBe("healthy");
    // A check the journal never saw stays silent on a healthy first tick.
    expect(j.record("fin", "inbox", undefined, { status: "healthy", message: "ok" }, iso(2000))).toBeNull();
  });

  it("truncates long messages", () => {
    const j = new HeartbeatTransitionJournal({ now: () => T0 });
    const t = j.record("a", "c", "healthy", { status: "warning", message: "x".repeat(1000) }, iso(0));
    expect(t?.message).toHaveLength(300);
  });

  it("rate-limits journal logging per (agent, check) with the cooldown", () => {
    const j = new HeartbeatTransitionJournal({ now: () => T0, logCooldownMs: 600_000 });
    expect(j.shouldLog("a", "c", T0)).toBe(true);
    expect(j.shouldLog("a", "c", T0 + 1_000)).toBe(false);
    expect(j.shouldLog("a", "other", T0 + 1_000)).toBe(true);
    expect(j.shouldLog("a", "c", T0 + 600_000)).toBe(true);
  });

  it("summarises a window with per-agent counts and the checks still open", () => {
    let now = T0;
    const j = new HeartbeatTransitionJournal({ now: () => now });
    // An old warning outside the 24h window that never recovered → still open.
    j.record("fin", "tier-maintenance", "healthy", { status: "warning", message: "old" }, iso(-30 * 3600_000));
    j.record("fin", "auto-linker", "healthy", { status: "warning", message: "FK" }, iso(-3600_000));
    j.record("fin", "auto-linker", "warning", { status: "healthy", message: "ok" }, iso(-1800_000));
    j.record("adm", "inbox", "healthy", { status: "critical", message: "timeout" }, iso(-600_000));
    now = T0;
    const s = j.summary(24 * 3600_000);
    expect(s.since).toBe(iso(-24 * 3600_000));
    expect(s.transitions.map((t) => `${t.agent}:${t.check}:${t.to}`)).toEqual([
      "fin:auto-linker:warning",
      "fin:auto-linker:healthy",
      "adm:inbox:critical",
    ]);
    expect(s.byAgent).toEqual({
      adm: { warning: 0, critical: 1, recovered: 0, open: ["inbox"] },
      fin: { warning: 1, critical: 0, recovered: 1, open: ["tier-maintenance"] },
    });
  });

  it("persists to JSONL, reloads within retention, and drops torn lines", () => {
    dir = mkdtempSync(join(tmpdir(), "hb-journal-"));
    const path = join(dir, "manager", "heartbeat-transitions.jsonl");
    const a = new HeartbeatTransitionJournal({ now: () => T0, persistPath: path });
    a.record("a", "c", "healthy", { status: "warning", message: "one" }, iso(-60 * 3600_000)); // outside 48h
    a.record("a", "c", "warning", { status: "healthy", message: "two" }, iso(-1000));
    // Every transition is appended; retention applies on reload.
    expect(readFileSync(path, "utf-8").split("\n").filter(Boolean)).toHaveLength(2);
    // Append a torn line by hand.
    writeFileSync(path, readFileSync(path, "utf-8") + '{"timestamp":"2026-09-05T11:59', { flag: "w" });
    const b = new HeartbeatTransitionJournal({ now: () => T0, persistPath: path });
    expect(b.all().map((t) => t.message)).toEqual(["two"]);
  });

  it("rewrites the file when it has accumulated far more lines than the ring keeps", () => {
    dir = mkdtempSync(join(tmpdir(), "hb-journal-"));
    const path = join(dir, "heartbeat-transitions.jsonl");
    const stale = Array.from({ length: 1200 }, (_, i) =>
      JSON.stringify({ timestamp: iso(-72 * 3600_000 - i), agent: "a", check: "c", from: "healthy", to: "warning", message: "old" }),
    );
    const fresh = JSON.stringify({ timestamp: iso(-1000), agent: "a", check: "c", from: "warning", to: "healthy", message: "fresh" });
    writeFileSync(path, [...stale, fresh].join("\n") + "\n");
    const j = new HeartbeatTransitionJournal({ now: () => T0, persistPath: path });
    expect(j.all()).toHaveLength(1);
    expect(readFileSync(path, "utf-8").split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("bounds the ring by maxEntries, keeping the newest", () => {
    const j = new HeartbeatTransitionJournal({ now: () => T0, maxEntries: 3 });
    for (let i = 0; i < 5; i++) {
      j.record("a", `c${i}`, "healthy", { status: "warning", message: String(i) }, iso(i));
    }
    expect(j.all().map((t) => t.message)).toEqual(["2", "3", "4"]);
  });

  it("reports a persistence failure through onError instead of throwing", () => {
    dir = mkdtempSync(join(tmpdir(), "hb-journal-"));
    // A regular file where a directory is needed → mkdir fails with ENOTDIR.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory");
    const errors: string[] = [];
    const j = new HeartbeatTransitionJournal({
      now: () => T0,
      persistPath: join(blocker, "sub", "journal.jsonl"),
      onError: (e) => errors.push(e.message),
    });
    expect(() => j.record("a", "c", "healthy", { status: "warning", message: "m" }, iso(0))).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(j.all()).toHaveLength(1);
  });
});
