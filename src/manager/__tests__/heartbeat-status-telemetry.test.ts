import { describe, it, expect } from "vitest";
import {
  buildHeartbeatStatusPayload,
  estimateSessionTokens,
} from "../heartbeat-status-builder.js";
import { CompactionEventLog } from "../compaction-event-log.js";
import type { CheckResult } from "../../heartbeat/types.js";
import {
  CreditTelemetryPayloadSchema,
  type CreditTelemetryPayload,
} from "../../ipc/protocol.js";

function makeCheckResult(status: "healthy" | "warning" | "critical", message: string): { result: CheckResult; lastChecked: string } {
  return {
    result: { status, message },
    lastChecked: "2026-05-14T20:00:00.000Z",
  };
}

function makeProvider(ratio: number) {
  return { getContextFillPercentage: () => ratio };
}

describe("buildHeartbeatStatusPayload — telemetry surface", () => {
  it("includes session_tokens (rounded from ratio) per agent", () => {
    const results = new Map([
      ["alpha", new Map([["context-fill", makeCheckResult("healthy", "ok")]])],
    ]);
    const zones = new Map();
    const log = new CompactionEventLog();
    const providers = new Map([["alpha", makeProvider(0.5)]]);

    const payload = buildHeartbeatStatusPayload({
      results,
      zoneStatuses: zones,
      getLastCompactionAt: (a) => log.getLastCompactionAt(a),
      getContextFillProvider: (a) => providers.get(a),
    });

    // 0.5 ratio × 200_000 chars / 4 chars-per-token = 25_000 tokens
    expect(payload.agents.alpha.session_tokens).toBe(25_000);
  });

  it("session_tokens is null when no fill provider is wired", () => {
    const results = new Map([
      ["alpha", new Map([["context-fill", makeCheckResult("healthy", "ok")]])],
    ]);
    const payload = buildHeartbeatStatusPayload({
      results,
      zoneStatuses: new Map(),
      getLastCompactionAt: () => null,
      getContextFillProvider: () => undefined,
    });
    expect(payload.agents.alpha.session_tokens).toBeNull();
  });

  it("last_compaction_at is null when no event recorded", () => {
    const results = new Map([
      ["alpha", new Map([["context-fill", makeCheckResult("healthy", "ok")]])],
    ]);
    const payload = buildHeartbeatStatusPayload({
      results,
      zoneStatuses: new Map(),
      getLastCompactionAt: () => null,
      getContextFillProvider: () => undefined,
    });
    expect(payload.agents.alpha.last_compaction_at).toBeNull();
  });

  it("last_compaction_at reflects the most recent recorded ISO", () => {
    const log = new CompactionEventLog();
    log.record("alpha", "2026-05-14T19:50:00.000Z");
    log.record("alpha", "2026-05-14T20:05:00.000Z");

    const results = new Map([
      ["alpha", new Map([["context-fill", makeCheckResult("healthy", "ok")]])],
    ]);

    const payload = buildHeartbeatStatusPayload({
      results,
      zoneStatuses: new Map(),
      getLastCompactionAt: (a) => log.getLastCompactionAt(a),
      getContextFillProvider: () => undefined,
    });

    expect(payload.agents.alpha.last_compaction_at).toBe("2026-05-14T20:05:00.000Z");
  });

  it("emits per-agent isolation — other agents have null", () => {
    const log = new CompactionEventLog();
    log.record("alpha", "2026-05-14T20:00:00.000Z");

    const results = new Map([
      ["alpha", new Map([["context-fill", makeCheckResult("healthy", "ok")]])],
      ["beta", new Map([["context-fill", makeCheckResult("healthy", "ok")]])],
    ]);

    const payload = buildHeartbeatStatusPayload({
      results,
      zoneStatuses: new Map(),
      getLastCompactionAt: (a) => log.getLastCompactionAt(a),
      getContextFillProvider: () => undefined,
    });

    expect(payload.agents.alpha.last_compaction_at).toBe("2026-05-14T20:00:00.000Z");
    expect(payload.agents.beta.last_compaction_at).toBeNull();
  });

  it("preserves existing surface (checks, overall, zone, fillPercentage)", () => {
    const results = new Map([
      ["alpha", new Map([
        ["context-fill", makeCheckResult("warning", "Context fill: 55%")],
      ])],
    ]);
    const zones = new Map([
      ["alpha", { zone: "yellow" as const, fillPercentage: 0.55 }],
    ]);

    const payload = buildHeartbeatStatusPayload({
      results,
      zoneStatuses: zones,
      getLastCompactionAt: () => null,
      getContextFillProvider: () => undefined,
    });

    expect(payload.agents.alpha.zone).toBe("yellow");
    expect(payload.agents.alpha.fillPercentage).toBe(0.55);
    expect(payload.agents.alpha.overall).toBe("warning");
    expect(payload.agents.alpha.checks).toHaveProperty("context-fill");
  });

  it("estimateSessionTokens handles edge cases", () => {
    expect(estimateSessionTokens(undefined)).toBeNull();
    expect(estimateSessionTokens(makeProvider(0))).toBe(0);
    expect(estimateSessionTokens(makeProvider(1))).toBe(50_000);
  });
});

// ---------------------------------------------------------------------------
// Phase 138 Plan 02 T-02 — `creditTelemetry` widening of the
// `heartbeat-status` payload. The builder attaches a fleet-aggregate
// `creditTelemetry` field WHEN an aggregator is wired, and omits the key
// entirely when none is — backwards-compat for pre-138 consumers.
// ---------------------------------------------------------------------------

/** A schema-valid fixture credit-telemetry payload. */
function makeCreditTelemetryFixture(): CreditTelemetryPayload {
  return {
    date: "2026-05-20",
    providers: [
      {
        provider: "anthropic",
        cost_usd: 3.2,
        cap_usd: 6.67,
        pct: 47.97,
        tokens_in: 12_000,
        tokens_out: 4_000,
        turn_count: 8,
        models: [
          {
            model: "claude-sonnet-4-6",
            tokens_in: 12_000,
            tokens_out: 4_000,
            cost_usd: 3.2,
          },
        ],
        sparkline: new Array<number>(24).fill(0).map((_, i) => i * 0.1),
        agents: ["alpha", "beta"],
      },
    ],
  };
}

describe("buildHeartbeatStatusPayload — credit telemetry (Phase 138-02)", () => {
  const baseResults = new Map([
    ["alpha", new Map([["context-fill", makeCheckResult("healthy", "ok")]])],
  ]);

  it("(T-02a) includes creditTelemetry when an aggregator is provided", () => {
    const fixture = makeCreditTelemetryFixture();
    const payload = buildHeartbeatStatusPayload({
      results: baseResults,
      zoneStatuses: new Map(),
      getLastCompactionAt: () => null,
      getContextFillProvider: () => undefined,
      providerTelemetryAggregator: { snapshot: () => fixture },
    });
    expect(payload.creditTelemetry).toEqual(fixture);
  });

  it("(T-02b) omits the creditTelemetry key when no aggregator is provided", () => {
    const payload = buildHeartbeatStatusPayload({
      results: baseResults,
      zoneStatuses: new Map(),
      getLastCompactionAt: () => null,
      getContextFillProvider: () => undefined,
    });
    expect("creditTelemetry" in payload).toBe(false);
    expect(payload.creditTelemetry).toBeUndefined();
  });

  it("(T-02c) CreditTelemetryPayloadSchema.parse accepts a valid fixture", () => {
    const fixture = makeCreditTelemetryFixture();
    expect(() => CreditTelemetryPayloadSchema.parse(fixture)).not.toThrow();
  });

  it("(T-02d) CreditTelemetryPayloadSchema.parse rejects a 23-length sparkline", () => {
    const fixture = makeCreditTelemetryFixture();
    const invalid = {
      ...fixture,
      providers: [
        {
          ...fixture.providers[0]!,
          sparkline: new Array<number>(23).fill(0),
        },
      ],
    };
    expect(() => CreditTelemetryPayloadSchema.parse(invalid)).toThrow();
  });
});
