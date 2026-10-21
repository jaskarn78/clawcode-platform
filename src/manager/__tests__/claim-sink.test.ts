import { describe, expect, it, beforeEach } from "vitest";
import {
  CLAIM_SINK_TTL_MS,
  emitClaim,
  hasClaimSink,
  registerClaimSink,
  resetClaimSinksForTests,
} from "../claim-sink.js";
import type { ClaimEntry } from "../claim-ledger.js";

const entry = (turnId: string): ClaimEntry => ({
  id: "c1",
  turnId,
  claim: "x",
  verdict: "verified",
  effectiveVerdict: "verified",
  sourceStatus: "in-ledger",
  quoteStatus: "none",
  origin: "tool",
  at: 1,
  ledgerBacked: true,
});

describe("claim-sink", () => {
  beforeEach(() => resetClaimSinksForTests());

  it("delivers to sinks of the right turn only, and unregisters", () => {
    const got: string[] = [];
    const off = registerClaimSink("t1", (e) => got.push(e.turnId), 1000);
    registerClaimSink("t2", (e) => got.push(`other:${e.turnId}`), 1000);
    expect(emitClaim("t1", entry("t1"), 1000)).toBe(1);
    expect(got).toEqual(["t1"]);
    off();
    expect(hasClaimSink("t1")).toBe(false);
    expect(emitClaim("t1", entry("t1"), 1000)).toBe(0);
  });

  it("a throwing sink is isolated; others still receive", () => {
    const got: number[] = [];
    registerClaimSink("t", () => { throw new Error("boom"); }, 1000);
    registerClaimSink("t", () => got.push(1), 1000);
    expect(emitClaim("t", entry("t"), 1000)).toBe(1);
    expect(got).toEqual([1]);
  });

  it("sinks expire after the TTL even if never unregistered", () => {
    registerClaimSink("t", () => undefined, 1000);
    expect(emitClaim("t", entry("t"), 1000 + CLAIM_SINK_TTL_MS + 1)).toBe(0);
    expect(hasClaimSink("t")).toBe(false);
  });
});
