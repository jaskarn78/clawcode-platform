// src/heartbeat/__tests__/discovery.test.ts
//
// Phase 999.8 Plan 03 — discoverChecks is now a back-compat shim around the
// static CHECK_REGISTRY. The pre-Plan-03 tmpdir + readdir tests were testing
// the (broken-in-prod) dynamic-import behaviour; they no longer apply.
import { describe, it, expect } from "vitest";
import { discoverChecks } from "../discovery.js";
import { CHECK_REGISTRY } from "../check-registry.js";

describe("discoverChecks (Phase 999.8 — static registry)", () => {
  it("returns the static CHECK_REGISTRY regardless of checksDir argument", async () => {
    const result = await discoverChecks("/nonexistent/path");
    expect(result).toBe(CHECK_REGISTRY);
  });

  it("returns 18 modules", async () => {
    // Phase 108 — added mcp-broker check (POOL-07).
    // Phase 99-C — added summarize-pending (drains crashed-session summary backlog).
    // Phase 999.47 Plan 02 — added homelab-refresh (hourly inventory poller).
    // 2026-06-18 — added session-log-flush (daily-log materialiser for consolidation).
    // P1-RESCAN — added auto-ingest-rescan (periodic inbox rescan) → 16.
    // Phase 999.119 pass 2 — added session-retention (daily session hygiene) → 17.
    const result = await discoverChecks("/any/path");
    expect(result).toHaveLength(18);
  });

  it("ignores the checksDir parameter (back-compat shim)", async () => {
    const a = await discoverChecks("/a");
    const b = await discoverChecks("/b");
    expect(a).toBe(b);
  });
});
