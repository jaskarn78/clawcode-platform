/** 2026-08-27 PR-1 — per-turn evidence accumulator + lookback. */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { TraceStore } from "../trace-store.js";
import { EVIDENCE_LOOKBACK_MS, TraceCollector } from "../trace-collector.js";
import { EVIDENCE_MAX_PER_TURN, type EvidenceEntry } from "../../manager/evidence-ledger.js";

function ev(over: Partial<EvidenceEntry> & { kind: EvidenceEntry["kind"] }): EvidenceEntry {
  return { tool: "WebFetch", toolUseId: "t", at: 1, tier: "secondary", ...over };
}

describe("Turn evidence + collector lookback", () => {
  let dir: string; let store: TraceStore; let c: TraceCollector;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clawcode-ev-"));
    store = new TraceStore(join(dir, "traces.db"));
    c = new TraceCollector(store, pino({ level: "silent" }));
  });
  afterEach(() => { try { store.close?.(); } catch { /* ignore */ } rmSync(dir, { recursive: true, force: true }); });

  it("records, dedupes by (kind,target) and caps", () => {
    const t = c.startTurn("t1", "a", null);
    t.recordEvidence(ev({ kind: "read", url: "https://irs.gov/x", host: "irs.gov" }));
    t.recordEvidence(ev({ kind: "read", url: "https://irs.gov/x", host: "irs.gov", toolUseId: "other" }));
    expect(t.getEvidence()).toHaveLength(1);
    for (let i = 0; i < EVIDENCE_MAX_PER_TURN + 20; i++) t.recordEvidence(ev({ kind: "found", url: `https://x.com/${i}`, host: "x.com" }));
    expect(t.getEvidence().length).toBeLessThanOrEqual(EVIDENCE_MAX_PER_TURN);
    expect(c.getActiveTurnEvidence("a").some((e) => e.host === "irs.gov")).toBe(true);
  });

  it("no active turn → [] (and no throw)", () => {
    expect(c.getActiveTurnEvidence("nobody")).toEqual([]);
  });

  it("lookback carries the previous turn's opened sources (not search hits), flagged stale, within the TTL", () => {
    const t1 = c.startTurn("t1", "a", null);
    t1.recordEvidence(ev({ kind: "read", url: "https://irs.gov/rmd", host: "irs.gov", tier: "primary" }));
    t1.recordEvidence(ev({ kind: "found", url: "https://x.com/hit", host: "x.com" }));
    t1.end("success");
    const t2 = c.startTurn("t2", "a", null);
    const now = Date.now();
    const seen = c.getActiveTurnEvidence("a", now);
    expect(seen.map((e) => e.url)).toEqual(["https://irs.gov/rmd"]);
    expect(seen[0]?.stale).toBe(true);
    // the current turn re-opening it wins over the stale copy (deduped by key)
    t2.recordEvidence(ev({ kind: "read", url: "https://irs.gov/rmd", host: "irs.gov", tier: "primary" }));
    expect(c.getActiveTurnEvidence("a", now).filter((e) => e.url === "https://irs.gov/rmd")).toHaveLength(1);
    expect(c.getActiveTurnEvidence("a", now).find((e) => e.url === "https://irs.gov/rmd")?.stale).toBeUndefined();
    // expired
    expect(c.getActiveTurnEvidence("a", now + EVIDENCE_LOOKBACK_MS + 1).some((e) => e.stale)).toBe(false);
  });

  it("seedEvidence copies a parent's ledger into a hop turn", () => {
    const t = c.startTurn("hop", "a", null);
    t.seedEvidence([ev({ kind: "document", file: "statement.pdf", tier: "client" })]);
    expect(t.getEvidence()[0]?.file).toBe("statement.pdf");
  });
});
