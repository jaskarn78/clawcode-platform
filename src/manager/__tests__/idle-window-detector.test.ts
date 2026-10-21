import { describe, it, expect } from "vitest";

/**
 * Phase 95 Plan 01 Task 1 — idle-window detector primitive tests (RED).
 *
 * Pin D-01 invariants:
 *   - I1: lastTurnAt=null → idle=false, reason='no-prior-turn'
 *   - I2: now - lastTurnAt < 5min hard floor → idle=false, 'active'
 *   - I3: now - lastTurnAt < idleMinutes*60s but > 5min → idle=false, 'active'
 *   - I4: now - lastTurnAt > idleMinutes*60s → idle=true, 'idle-threshold-met'
 *   - I5: now - lastTurnAt > 6h hard ceiling → idle=true, 'idle-ceiling-bypass'
 *   - I6: findIdleAgents filters disabled (enabled=false) agents
 *   - I7: findIdleAgents returns names of all enabled+idle agents
 *
 * Module under test does not exist yet — imports fail (RED).
 */

import {
  isAgentIdle,
  findIdleAgents,
  IDLE_HARD_FLOOR_MS,
  IDLE_HARD_CEILING_MS,
} from "../idle-window-detector.js";

const FIXED_NOW = new Date("2026-04-25T12:00:00.000Z");
const now = (): Date => FIXED_NOW;

describe("isAgentIdle — D-01 silence detector primitive", () => {
  it("I-CONST: hard floor and ceiling literals match D-01 spec", () => {
    expect(IDLE_HARD_FLOOR_MS).toBe(5 * 60 * 1000);
    expect(IDLE_HARD_CEILING_MS).toBe(6 * 60 * 60 * 1000);
  });

  it("I1: lastTurnAt=null → idle=false, reason='no-prior-turn'", () => {
    const result = isAgentIdle({
      lastTurnAt: null,
      idleMinutes: 30,
      now,
    });
    expect(result.idle).toBe(false);
    expect(result.reason).toBe("no-prior-turn");
  });

  it("I2: elapsed < 5min hard floor → idle=false, reason='active' (regardless of idleMinutes)", () => {
    // 4 minutes elapsed — below the 5-min hard floor
    const lastTurnAt = new Date(FIXED_NOW.getTime() - 4 * 60 * 1000);
    const result = isAgentIdle({
      lastTurnAt,
      idleMinutes: 1, // even with idleMinutes=1, hard floor wins
      now,
    });
    expect(result.idle).toBe(false);
    expect(result.reason).toBe("active");
  });

  it("I3: 5min < elapsed < idleMinutes*60s → idle=false, reason='active'", () => {
    // 10 minutes elapsed; idleMinutes=30 → not yet idle
    const lastTurnAt = new Date(FIXED_NOW.getTime() - 10 * 60 * 1000);
    const result = isAgentIdle({
      lastTurnAt,
      idleMinutes: 30,
      now,
    });
    expect(result.idle).toBe(false);
    expect(result.reason).toBe("active");
  });

  it("I4: elapsed > idleMinutes*60s → idle=true, reason='idle-threshold-met'", () => {
    // 35 minutes elapsed; idleMinutes=30 → idle
    const lastTurnAt = new Date(FIXED_NOW.getTime() - 35 * 60 * 1000);
    const result = isAgentIdle({
      lastTurnAt,
      idleMinutes: 30,
      now,
    });
    expect(result.idle).toBe(true);
    expect(result.reason).toBe("idle-threshold-met");
  });

  it("I5: elapsed > 6h hard ceiling → idle=true, reason='idle-ceiling-bypass'", () => {
    // 7 hours elapsed; even with idleMinutes=999 (impossible but enforces ceiling)
    const lastTurnAt = new Date(FIXED_NOW.getTime() - 7 * 60 * 60 * 1000);
    const result = isAgentIdle({
      lastTurnAt,
      // Use a value above what the ceiling would normally fire at —
      // ceiling fires regardless. Use a still-valid threshold (< 6h)
      // and confirm ceiling-bypass kicks in.
      idleMinutes: 360, // 6 hours = ceiling — elapsed 7h > 6h
      now,
    });
    expect(result.idle).toBe(true);
    expect(result.reason).toBe("idle-ceiling-bypass");
  });
});

describe("findIdleAgents — fleet sweep filter (D-06)", () => {
  it("I6: filters disabled agents (dream.enabled=false → never returned even if idle)", () => {
    // Agent A: enabled, idle (35min elapsed, threshold 30) → should be returned
    // Agent B: disabled, idle (same elapsed) → should NOT be returned
    const lastTurnAt = new Date(FIXED_NOW.getTime() - 35 * 60 * 1000);
    const agents = [
      {
        name: "agent-a",
        lastTurnAt,
        dreamConfig: { enabled: true, idleMinutes: 30 },
      },
      {
        name: "agent-b",
        lastTurnAt,
        dreamConfig: { enabled: false, idleMinutes: 30 },
      },
    ];
    const result = findIdleAgents(agents, now);
    expect(result).toEqual(["agent-a"]);
  });

  it("I7: returns names of all enabled+idle agents (stable order, mixed states)", () => {
    const longIdle = new Date(FIXED_NOW.getTime() - 35 * 60 * 1000);
    const active = new Date(FIXED_NOW.getTime() - 1 * 60 * 1000); // 1min — still active
    const ceilingBypass = new Date(FIXED_NOW.getTime() - 7 * 60 * 60 * 1000); // > 6h
    const agents = [
      {
        name: "alpha",
        lastTurnAt: longIdle,
        dreamConfig: { enabled: true, idleMinutes: 30 },
      },
      {
        name: "beta",
        lastTurnAt: active,
        dreamConfig: { enabled: true, idleMinutes: 30 },
      },
      {
        name: "gamma",
        lastTurnAt: ceilingBypass,
        dreamConfig: { enabled: true, idleMinutes: 360 },
      },
      {
        name: "delta",
        lastTurnAt: longIdle,
        dreamConfig: { enabled: false, idleMinutes: 30 },
      },
      {
        name: "epsilon",
        lastTurnAt: null,
        dreamConfig: { enabled: true, idleMinutes: 30 },
      },
    ];
    const result = findIdleAgents(agents, now);
    expect(result).toEqual(["alpha", "gamma"]);
  });
});
