/**
 * Phase 999.114 — the stream-stall cascade actually REACHES a fable agent.
 *
 * The 2026-08-21 fin-research incident root cause was that it did not: the
 * loader cast the resolved model down to (haiku|sonnet|opus), so a fable agent
 * "simply finds no defaults.modelOverrides entry" and fell through to the
 * 180000 fleet default — which is why it logged sourcedFrom:"default".
 */
import { describe, it, expect } from "vitest";
import { configSchema } from "../schema.js";
import { resolveAllAgents } from "../loader.js";

function resolve(agents: readonly Record<string, unknown>[], defaults = {}) {
  const cfg = configSchema.parse({
    version: 1,
    discord: { botToken: "x" },
    slack: { botToken: "x", appToken: "x", signingSecret: "x" },
    defaults: { basePath: "/tmp/agents", ...defaults },
    agents: agents.map((a) => ({ soul: "s", identity: "i", ...a })),
  } as never);
  return resolveAllAgents(cfg as never) as unknown as ReadonlyArray<{
    name: string;
    streamStallTimeoutMs: number;
  }>;
}

const stallOf = (
  rows: ReadonlyArray<{ name: string; streamStallTimeoutMs: number }>,
  name: string,
) => rows.find((r) => r.name === name)!.streamStallTimeoutMs;

describe("stream-stall cascade — fable", () => {
  it("a fable agent gets the family floor with NO yaml edit", () => {
    const rows = resolve([{ name: "a", model: "fable" }]);
    expect(stallOf(rows, "a")).toBe(600_000);
  });

  it("covers every way of selecting fable — alias, @latest track, historical pin", () => {
    const rows = resolve([
      { name: "pin", model: "fable" },
      { name: "latest", model: "fable@latest" },
      { name: "old", model: "fable-5" },
    ]);
    expect(stallOf(rows, "pin")).toBe(600_000);
    expect(stallOf(rows, "latest")).toBe(600_000);
    expect(stallOf(rows, "old")).toBe(600_000);
  });

  it("leaves every other family on the 180s baseline (no fleet-wide change)", () => {
    const rows = resolve([
      { name: "o", model: "opus" },
      { name: "o46", model: "opus-4-6" },
      { name: "s", model: "sonnet" },
      { name: "h", model: "haiku" },
    ]);
    for (const n of ["o", "o46", "s", "h"]) {
      expect(stallOf(rows, n)).toBe(180_000);
    }
  });

  it("an EXPLICIT per-agent value wins exactly — including one BELOW the floor", () => {
    // Fast dead-stream detection is a legitimate operator choice; the floor
    // must lift the DEFAULT, never overrule what the operator wrote.
    const rows = resolve([
      { name: "low", model: "fable", streamStallTimeoutMs: 60_000 },
      { name: "high", model: "fable", streamStallTimeoutMs: 900_000 },
    ]);
    expect(stallOf(rows, "low")).toBe(60_000);
    expect(stallOf(rows, "high")).toBe(900_000);
  });

  it("an explicit defaults.modelOverrides.fable entry wins over the floor", () => {
    const rows = resolve([{ name: "a", model: "fable" }], {
      modelOverrides: { fable: { streamStallTimeoutMs: 240_000 } },
    });
    expect(stallOf(rows, "a")).toBe(240_000);
  });

  it("modelOverrides is reachable for fable at all (the original bug)", () => {
    // Pre-999.114 the loader cast the model to (haiku|sonnet|opus), so this
    // entry was DEAD and the agent silently got 180000.
    const rows = resolve([{ name: "a", model: "fable" }], {
      modelOverrides: { fable: { streamStallTimeoutMs: 300_000 } },
    });
    expect(stallOf(rows, "a")).not.toBe(180_000);
    expect(stallOf(rows, "a")).toBe(300_000);
  });

  it("a raised fleet baseline still applies to fable when it exceeds the floor", () => {
    const rows = resolve([{ name: "a", model: "fable" }], {
      streamStallTimeoutMs: 900_000,
    });
    expect(stallOf(rows, "a")).toBe(900_000);
  });

  it("a LOWERED fleet baseline cannot push fable back under its floor", () => {
    // The floor is a Math.max against the baseline, not a `??` fallback —
    // `defaults.streamStallTimeoutMs` is always populated (.default(180_000)),
    // so a `??` chain would have made the floor dead code.
    const rows = resolve([{ name: "a", model: "fable" }], {
      streamStallTimeoutMs: 120_000,
    });
    expect(stallOf(rows, "a")).toBe(600_000);
  });
});
