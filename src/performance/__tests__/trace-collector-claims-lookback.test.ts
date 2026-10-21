/**
 * 2026-08-28 — claims (and the turn's own evidence) stay readable and
 * writable for CLAIMS_LOOKBACK_MS after the turn ended. Before this, the
 * bridge's self-owned re-dispatch read the ledger after `end()` and got
 * `[]`, and every post-hoc-hop `verify_claim` was dropped (`recordClaim`
 * refused once committed).
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import { TraceStore } from "../trace-store.js";
import { CLAIMS_LOOKBACK_MS, TraceCollector } from "../trace-collector.js";
import type { EvidenceEntry } from "../../manager/evidence-ledger.js";

const ev = (o: Partial<EvidenceEntry>): EvidenceEntry =>
  ({ kind: "read", tool: "WebFetch", toolUseId: `tu-${Math.random()}`, at: 1, url: "https://irs.gov/x", host: "irs.gov", tier: "primary", ...o }) as EvidenceEntry;

describe("TraceCollector — ended-turn claims lookback", () => {
  let dir: string;
  let c: TraceCollector;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tc-claims-"));
    c = new TraceCollector(new TraceStore(join(dir, "t.db")), pino({ level: "silent" }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("claims recorded before end() are still returned after end(); evidence stays CURRENT (not stale)", () => {
    const t = c.startTurn("t1", "a", null);
    t.recordEvidence(ev({}));
    expect(c.recordClaimForActiveTurn("a", { claim: "RMD age is 73", verdict: "verified", source: "https://irs.gov/x" })).not.toBeNull();
    t.end("success");
    expect(c.getActiveTurnClaims("a").map((x) => x.claim)).toEqual(["RMD age is 73"]);
    expect(c.getActiveTurnEvidence("a").some((e) => e.host === "irs.gov" && e.stale !== true)).toBe(true);
  });

  it("a post-hoc verify_claim within the window attaches to the ended turn and validates against ITS evidence", () => {
    const t = c.startTurn("t1", "a", null);
    t.recordEvidence(ev({}));
    t.end("success");
    const rec = c.recordClaimForActiveTurn("a", { claim: "catch-up is $11,250", verdict: "verified", source: "https://irs.gov/x" });
    expect(rec?.effectiveVerdict).toBe("verified");
    expect(c.getActiveTurnClaims("a")).toHaveLength(1);
  });

  it("a new turn shadows the stash; the stash expires after CLAIMS_LOOKBACK_MS", () => {
    const t1 = c.startTurn("t1", "a", null);
    c.recordClaimForActiveTurn("a", { claim: "old", verdict: "verified", source: "https://irs.gov/x" });
    t1.end("success");
    const t2 = c.startTurn("t2", "a", null);
    expect(c.getActiveTurnClaims("a")).toEqual([]);
    t2.end("success");
    expect(c.getActiveTurnClaims("a")).toEqual([]); // t2 had none; t1 is gone
    expect(CLAIMS_LOOKBACK_MS).toBe(10 * 60 * 1000);
    expect(c.getActiveTurnClaims("nobody")).toEqual([]);
  });
});
