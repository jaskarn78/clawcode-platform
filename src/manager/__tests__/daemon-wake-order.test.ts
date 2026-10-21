/**
 * Phase 999.25 — wake-order sort behavior.
 *
 * Pins the sort comparator used in `src/manager/daemon.ts` boot path so
 * boot order matches operator's `wakeOrder` priority (lower first;
 * undefined boots LAST in YAML order via stable sort).
 *
 * The comparator is inlined at the daemon call site (no extracted helper)
 * so this test reproduces it verbatim. The static-grep test below pins
 * that the daemon's source contains the same shape.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type AgentLike = { readonly name: string; readonly wakeOrder?: number };

// Verbatim copy of the comparator at src/manager/daemon.ts (sortedAutoStartAgents).
function sortByWakeOrder<T extends AgentLike>(agents: readonly T[]): T[] {
  return [...agents].sort(
    (a, b) => (a.wakeOrder ?? Infinity) - (b.wakeOrder ?? Infinity),
  );
}

describe("Phase 999.25 — wakeOrder sort behavior", () => {
  it("agents with wakeOrder boot before agents without", () => {
    const input: AgentLike[] = [
      { name: "alpha" },
      { name: "admin", wakeOrder: 1 },
      { name: "beta" },
    ];
    const sorted = sortByWakeOrder(input);
    expect(sorted.map((a) => a.name)).toEqual(["admin", "alpha", "beta"]);
  });

  it("lower wakeOrder boots first", () => {
    const input: AgentLike[] = [
      { name: "third", wakeOrder: 3 },
      { name: "first", wakeOrder: 1 },
      { name: "second", wakeOrder: 2 },
    ];
    const sorted = sortByWakeOrder(input);
    expect(sorted.map((a) => a.name)).toEqual(["first", "second", "third"]);
  });

  it("ties preserve YAML order (stable sort)", () => {
    const input: AgentLike[] = [
      { name: "first-tier-one", wakeOrder: 1 },
      { name: "second-tier-one", wakeOrder: 1 },
      { name: "third-tier-one", wakeOrder: 1 },
    ];
    const sorted = sortByWakeOrder(input);
    expect(sorted.map((a) => a.name)).toEqual([
      "first-tier-one",
      "second-tier-one",
      "third-tier-one",
    ]);
  });

  it("unordered agents preserve YAML order among themselves", () => {
    const input: AgentLike[] = [
      { name: "u1" },
      { name: "u2" },
      { name: "u3" },
      { name: "u4" },
    ];
    const sorted = sortByWakeOrder(input);
    expect(sorted.map((a) => a.name)).toEqual(["u1", "u2", "u3", "u4"]);
  });

  it("all undefined → identical to input order (regression pin: today's behavior)", () => {
    const input: AgentLike[] = [
      { name: "a" },
      { name: "b" },
      { name: "c" },
      { name: "d" },
      { name: "e" },
    ];
    const sorted = sortByWakeOrder(input);
    expect(sorted).toEqual(input);
  });

  it("operator's example: admin → fin-client → research/fin-research → rest", () => {
    const input: AgentLike[] = [
      { name: "misc-3" },
      { name: "fin-research", wakeOrder: 3 },
      { name: "admin-clawdy", wakeOrder: 1 },
      { name: "misc-1" },
      { name: "fin-client", wakeOrder: 2 },
      { name: "research", wakeOrder: 3 },
      { name: "misc-2" },
    ];
    const sorted = sortByWakeOrder(input);
    expect(sorted.map((a) => a.name)).toEqual([
      "admin-clawdy",
      "fin-client",
      // ties keep YAML order: fin-research listed before research in input
      "fin-research",
      "research",
      // undefined keeps YAML order: misc-3, misc-1, misc-2
      "misc-3",
      "misc-1",
      "misc-2",
    ]);
  });

  it("zero is a valid wakeOrder (boots even before 1)", () => {
    const input: AgentLike[] = [
      { name: "one", wakeOrder: 1 },
      { name: "zero", wakeOrder: 0 },
      { name: "two", wakeOrder: 2 },
    ];
    const sorted = sortByWakeOrder(input);
    expect(sorted.map((a) => a.name)).toEqual(["zero", "one", "two"]);
  });

  it("negative wakeOrder is allowed (priority semantics: lower first)", () => {
    const input: AgentLike[] = [
      { name: "normal", wakeOrder: 1 },
      { name: "ultra", wakeOrder: -100 },
    ];
    const sorted = sortByWakeOrder(input);
    expect(sorted.map((a) => a.name)).toEqual(["ultra", "normal"]);
  });
});

describe("Phase 999.25 — daemon source-grep pin", () => {
  it("daemon.ts contains the wakeOrder sort comparator at the auto-start call site", () => {
    // Static guard: a future refactor that drops the sort or changes the
    // comparator shape (e.g. flips `??` direction or removes Infinity sentinel)
    // breaks this test BEFORE production boot order regresses.
    const daemonPath = join(__dirname, "../daemon.ts");
    const source = readFileSync(daemonPath, "utf-8");

    // Must reference wakeOrder
    expect(source).toMatch(/wakeOrder/);
    // Must apply Infinity sentinel for undefined ordering
    expect(source).toMatch(/wakeOrder\s*\?\?\s*Infinity/);
    // Must produce sortedAutoStartAgents (variable consumed by startAll)
    expect(source).toMatch(/sortedAutoStartAgents/);
    // Must call startAll on the SORTED array, not the unfiltered/unsorted one
    expect(source).toMatch(/startAll\(sortedAutoStartAgents\)/);
  });
});
