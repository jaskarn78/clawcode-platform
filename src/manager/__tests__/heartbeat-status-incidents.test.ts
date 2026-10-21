/**
 * Phase 999.122 — `heartbeat-status` carries the transition journal's
 * incident summary when a journal is wired, and nothing new otherwise.
 */

import { describe, it, expect } from "vitest";
import { buildHeartbeatStatusPayload } from "../heartbeat-status-builder.js";
import { HeartbeatTransitionJournal } from "../../heartbeat/transition-journal.js";
import type { CheckResult } from "../../heartbeat/types.js";

const T0 = Date.UTC(2026, 8, 5, 12, 0, 0);

function entry(status: CheckResult["status"], message: string) {
  return { result: { status, message }, lastChecked: new Date(T0).toISOString() };
}

describe("buildHeartbeatStatusPayload — incidents", () => {
  it("attaches the 24h incident summary from the journal", () => {
    const journal = new HeartbeatTransitionJournal({ now: () => T0 });
    journal.record("fin", "auto-linker", "healthy", { status: "warning", message: "FK" }, new Date(T0 - 3600_000).toISOString());
    const payload = buildHeartbeatStatusPayload({
      results: new Map([["fin", new Map([["auto-linker", entry("warning", "FK")]])]]),
      zoneStatuses: new Map(),
      getLastCompactionAt: () => null,
      getContextFillProvider: () => undefined,
      transitionJournal: journal,
    });
    expect(payload.incidents).toBeDefined();
    expect(payload.incidents!.transitions).toHaveLength(1);
    expect(payload.incidents!.byAgent).toEqual({
      fin: { warning: 1, critical: 0, recovered: 0, open: ["auto-linker"] },
    });
    expect(payload.agents.fin!.overall).toBe("warning");
  });

  it("omits the key when no journal is wired (pre-999.122 wire shape)", () => {
    const payload = buildHeartbeatStatusPayload({
      results: new Map(),
      zoneStatuses: new Map(),
      getLastCompactionAt: () => null,
      getContextFillProvider: () => undefined,
    });
    expect("incidents" in payload).toBe(false);
  });
});
