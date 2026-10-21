import { describe, it, expect, beforeEach } from "vitest";
import pino from "pino";
import type { ConversationTurn } from "../../../memory/compaction.js";
import {
  partitionForVerbatim,
  resetTier1SentinelTracking,
} from "../tier1-verbatim.js";
import type { ExtractorDeps } from "../types.js";

function makeDeps(overrides: Partial<ExtractorDeps> = {}): ExtractorDeps {
  const log = pino({ level: "silent" }) as unknown as ExtractorDeps["log"];
  return Object.freeze({
    preserveLastTurns: 10,
    preserveVerbatimPatterns: [],
    clock: () => new Date(0),
    log,
    agentName: "agent-t1",
    ...overrides,
  });
}

function turn(role: "user" | "assistant", content: string): ConversationTurn {
  return Object.freeze({
    role,
    content,
    timestamp: "2026-05-14T00:00:00Z",
  });
}

describe("partitionForVerbatim (Tier 1)", () => {
  beforeEach(() => resetTier1SentinelTracking());

  it("preserves last N=10 turns by default", () => {
    const deps = makeDeps();
    const turns = Array.from({ length: 25 }, (_, i) =>
      turn(i % 2 === 0 ? "user" : "assistant", `turn ${i}`),
    );
    const { preserved, toCompact } = partitionForVerbatim(turns, deps);
    expect(preserved.length).toBeGreaterThanOrEqual(10);
    const last10 = turns.slice(-10);
    for (const t of last10) expect(preserved).toContain(t);
    expect(toCompact.length).toBeLessThanOrEqual(15);
  });

  it("preserves the last 3 operator (user) messages even if outside N", () => {
    const deps = makeDeps({ preserveLastTurns: 2 });
    const turns: ConversationTurn[] = [
      turn("user", "u1"),
      turn("assistant", "a1"),
      turn("user", "u2"),
      turn("assistant", "a2"),
      turn("user", "u3"),
      turn("assistant", "a3"),
      turn("assistant", "a4"),
      turn("assistant", "a5"),
    ];
    const { preserved } = partitionForVerbatim(turns, deps);
    expect(preserved).toContain(turns[0]);
    expect(preserved).toContain(turns[2]);
    expect(preserved).toContain(turns[4]);
  });

  it("preserves SOUL.md / IDENTITY.md marker turns", () => {
    const deps = makeDeps({ preserveLastTurns: 1 });
    const turns = [
      turn("assistant", "Loaded SOUL.md identity at boot"),
      turn("user", "filler 1"),
      turn("user", "filler 2"),
      turn("user", "filler 3"),
      turn("assistant", "Loaded IDENTITY.md frontmatter"),
      turn("assistant", "final"),
    ];
    const { preserved } = partitionForVerbatim(turns, deps);
    expect(preserved).toContain(turns[0]);
    expect(preserved).toContain(turns[4]);
  });

  it("preserves daily-notes/<date> path mentions", () => {
    const deps = makeDeps({ preserveLastTurns: 1 });
    const turns = [
      turn("assistant", "Wrote daily-notes/2026-05-14/client-a-sync.md"),
      turn("user", "noise"),
      turn("user", "more noise"),
      turn("assistant", "final"),
    ];
    const { preserved } = partitionForVerbatim(turns, deps);
    expect(preserved).toContain(turns[0]);
  });

  it("honors custom preserveVerbatimPatterns (SC-8: AUM / $)", () => {
    const deps = makeDeps({
      preserveLastTurns: 1,
      preserveVerbatimPatterns: [/\bAUM\b/, /\$[0-9]/],
    });
    const turns = [
      turn("user", "client has $45M AUM under management"),
      turn("assistant", "noted"),
      turn("user", "noise"),
      turn("user", "more noise"),
      turn("user", "last operator"),
      turn("assistant", "done"),
    ];
    const { preserved } = partitionForVerbatim(turns, deps);
    expect(preserved).toContain(turns[0]);
  });

  it("default empty patterns produces no extra preservation beyond rules", () => {
    const deps = makeDeps({ preserveLastTurns: 2 });
    const turns = [
      turn("user", "ordinary line"),
      turn("assistant", "ordinary reply"),
      turn("user", "third"),
      turn("assistant", "fourth"),
      turn("assistant", "fifth"),
    ];
    const { preserved, toCompact } = partitionForVerbatim(turns, deps);
    expect(preserved.length + toCompact.length).toBe(turns.length);
  });

  it("partitions are disjoint and union to input", () => {
    const deps = makeDeps();
    const turns = Array.from({ length: 30 }, (_, i) =>
      turn(i % 3 === 0 ? "user" : "assistant", `t${i} content`),
    );
    const { preserved, toCompact } = partitionForVerbatim(turns, deps);
    const ps = new Set(preserved);
    const ts = new Set(toCompact);
    for (const t of preserved) expect(ts.has(t)).toBe(false);
    expect(preserved.length + toCompact.length).toBe(turns.length);
    for (const t of turns) expect(ps.has(t) || ts.has(t)).toBe(true);
  });
});
