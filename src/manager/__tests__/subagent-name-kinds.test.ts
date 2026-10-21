/**
 * 2026-07-31 memory program F1 — spawn-kind classification matrix.
 * Additive to subagent-name's pinned predicates: `-pool-` and `-fork-`
 * families gain first-class kinds without touching SUBAGENT_NAME_RE.
 */
import { describe, it, expect } from "vitest";
import {
  spawnKindOf,
  isManagedWorkerName,
  isSubagentThreadName,
} from "../subagent-name.js";

describe("spawnKindOf", () => {
  it("classifies each generator family", () => {
    expect(spawnKindOf("fin-client-sub-4XZKL0")).toBe("sub");
    expect(spawnKindOf("fin-client-via-fin-research-57r__G")).toBe("via");
    expect(spawnKindOf("test-agent-pool-Rl31xm")).toBe("pool");
    expect(spawnKindOf("personal-fork-a1b2c3")).toBe("fork");
    // Optimizer eval forks append `-opt` (agent-runner.ts:75).
    expect(spawnKindOf("fin-client-fork-a1b2c3-opt")).toBe("fork");
    // Real prod shape — nanoid alphabet includes `-`/`_`.
    expect(spawnKindOf("fin-client-fork-DZeTH-")).toBe("fork");
    expect(spawnKindOf("general-thread-worker")).toBe("thread");
  });

  it("operator-defined names → agent, even with family words inside", () => {
    for (const name of [
      "personal",
      "fin-client",
      "Admin Clawdy",
      "subaru-fan", // contains 'sub' without the generated shape
      "my-pool-agent", // '-pool-' but no trailing nanoid6 → agent... unless thread-loose?
    ]) {
      // NOTE: '-pool-'/'-fork-' require the anchored trailing nanoid6, so
      // 'my-pool-agent' stays agent.
      expect(spawnKindOf(name)).toBe("agent");
    }
  });

  it("isManagedWorkerName = kind !== agent (superset incl. pool/fork)", () => {
    expect(isManagedWorkerName("test-agent-pool-Rl31xm")).toBe(true);
    expect(isManagedWorkerName("personal-fork-a1b2c3")).toBe(true);
    expect(isManagedWorkerName("fin-client-sub-4XZKL0")).toBe(true);
    expect(isManagedWorkerName("fin-client")).toBe(false);
    // The strict subagent regex still does NOT match pool/fork (pinned
    // behavior — session-reaper coverage changes ride spawnKindOf, not
    // SUBAGENT_NAME_RE).
    expect(isSubagentThreadName("test-agent-pool-Rl31xm")).toBe(false);
    expect(isSubagentThreadName("personal-fork-a1b2c3")).toBe(false);
  });
});
