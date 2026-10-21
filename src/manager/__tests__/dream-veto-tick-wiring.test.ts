/**
 * Phase 999.188 — static sentinel: the veto tick and the D-10 priority
 * hooks have production callers in daemon.ts. Phase 115 shipped the veto
 * store with no tick, so scheduled promotions stayed pending forever; this
 * test fails if that wiring is ever dropped again.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DAEMON = join(process.cwd(), "src", "manager", "daemon.ts");

describe("dream veto tick wiring (999.188)", () => {
  const src = readFileSync(DAEMON, "utf-8");
  it("daemon registers the veto tick once", () => {
    expect(src.match(/registerDreamVetoTick\(\{/g)?.length).toBe(1);
  });
  it("daemon stops the veto tick at shutdown", () => {
    expect(src).toMatch(/dreamVetoTick\?\.stop\(\)/);
  });
  it("daemon passes the priority counter and priority applier to the dream cron", () => {
    expect(src).toMatch(/truncationEventCounter:\s*\{/);
    expect(src).toMatch(/applyDreamResultPriority:/);
  });
  it("daemon hands the machinery ONE veto store and the channel poster", () => {
    expect(src.match(/createDreamVetoStore\(\)/g)?.length).toBeGreaterThanOrEqual(1);
    expect(src).toMatch(/vetoStore:\s*dreamVetoStore/);
    expect(src).toMatch(/postToAgent:\s*postDreamTextToAgent/);
  });
  it("approve-dream-run IPC exists", () => {
    expect(src).toMatch(/case "approve-dream-run"/);
  });
});
