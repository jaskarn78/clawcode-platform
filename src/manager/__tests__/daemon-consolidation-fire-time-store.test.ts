/**
 * Phase 999.113 WS-3 — static-grep sentinel for the consolidation handler's
 * MemoryStore resolution.
 *
 * WHY A SENTINEL AND NOT A BEHAVIOURAL TEST: the defect lived in a closure
 * built inside `startDaemon`'s agent loop. Instantiating the daemon to reach
 * it would drag in Discord, MCP, the scheduler and per-agent sessions — so the
 * fix would go untested and, being a one-line hoist, could be silently undone.
 * This pins the ONE property that matters: the store is resolved when the cron
 * FIRES, not when the schedule is REGISTERED.
 *
 * The bug it guards: `const memoryStore = manager.getMemoryStore(name)` sat
 * above `handler: async () => {`, i.e. it ran during boot, before
 * `startAgent` -> `initMemory` creates per-agent stores. It captured
 * `undefined` for every agent and `if (!memoryStore) return;` no-op'd silently
 * on every 03:00 tick from 2026-06-19 to 2026-08-28 — no digests, no run-log
 * rows, and nothing in the journal to notice.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const daemonSrc = readFileSync(new URL("../daemon.ts", import.meta.url), "utf8");

/** The consolidation schedule registration block, bounded to its handler. */
function consolidationBlock(): string {
  const start = daemonSrc.indexOf('name: "memory-consolidation"');
  expect(start, "memory-consolidation schedule registration not found").toBeGreaterThan(-1);
  const end = daemonSrc.indexOf("await runConsolidation(", start);
  expect(end, "runConsolidation call not found after the registration").toBeGreaterThan(start);
  return daemonSrc.slice(start, end);
}

describe("daemon consolidation schedule — store resolved at fire time (999.113 WS-3)", () => {
  it("resolves getMemoryStore INSIDE the handler body, never above it", () => {
    const block = consolidationBlock();
    const handlerAt = block.indexOf("handler: async () =>");
    const storeAt = block.indexOf("manager.getMemoryStore(");
    expect(handlerAt, "handler not found in the consolidation block").toBeGreaterThan(-1);
    expect(storeAt, "getMemoryStore not found in the consolidation block").toBeGreaterThan(-1);
    // The whole point: the resolution must come AFTER the handler opens.
    expect(storeAt).toBeGreaterThan(handlerAt);
  });

  it("a missing store at fire time warns instead of returning silently", () => {
    const block = consolidationBlock();
    const guard = block.slice(block.indexOf("if (!memoryStore)"));
    expect(guard.slice(0, 400)).toMatch(/log\.warn\(/);
  });

  it("logs an entry line so 'did consolidation run?' never needs forensics again", () => {
    expect(consolidationBlock()).toContain("consolidation run starting");
    expect(daemonSrc).toContain("consolidation run complete");
  });
});
