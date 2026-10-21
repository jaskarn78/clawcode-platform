/**
 * Phase 116 F02 — unit tests for resolveSloFor + DEFAULT_MODEL_SLOS.
 *
 * Verifies the four resolution paths the Plan 116-00 T02 action block
 * specifies:
 *   1. agent-override wins (per-agent `perf.slos[]` first_token p50 entry)
 *   2. opus model-default fallback
 *   3. sonnet model-default fallback
 *   4. haiku model-default fallback
 *
 * Also pins the locked threshold values to prevent silent drift — the
 * thresholds are operator-facing in the F03 agent tile grid and any change
 * needs an explicit decision, not a casual edit.
 */

import { describe, it, expect } from "vitest";

import {
  DEFAULT_MODEL_SLOS,
  resolveSloFor,
  type ResolveSloInput,
} from "../slos.js";

describe("DEFAULT_MODEL_SLOS — Phase 116 F02 locked thresholds", () => {
  it("locks the three per-model first-token p50 thresholds verbatim from Plan 116-00 T02", () => {
    expect(DEFAULT_MODEL_SLOS.sonnet.first_token_p50_ms).toBe(6_000);
    expect(DEFAULT_MODEL_SLOS.opus.first_token_p50_ms).toBe(8_000);
    expect(DEFAULT_MODEL_SLOS.haiku.first_token_p50_ms).toBe(2_000);
  });

  it("locks the per-model end-to-end p95 thresholds", () => {
    expect(DEFAULT_MODEL_SLOS.sonnet.end_to_end_p95_ms).toBe(30_000);
    expect(DEFAULT_MODEL_SLOS.opus.end_to_end_p95_ms).toBe(40_000);
    expect(DEFAULT_MODEL_SLOS.haiku.end_to_end_p95_ms).toBe(15_000);
  });

  it("locks the per-model tool_call p95 threshold uniform across models (external-dominated)", () => {
    expect(DEFAULT_MODEL_SLOS.sonnet.tool_call_p95_ms).toBe(30_000);
    expect(DEFAULT_MODEL_SLOS.opus.tool_call_p95_ms).toBe(30_000);
    expect(DEFAULT_MODEL_SLOS.haiku.tool_call_p95_ms).toBe(30_000);
  });

  it("freezes the per-model entries so callers can't mutate the defaults", () => {
    expect(Object.isFrozen(DEFAULT_MODEL_SLOS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_MODEL_SLOS.sonnet)).toBe(true);
    expect(Object.isFrozen(DEFAULT_MODEL_SLOS.opus)).toBe(true);
    expect(Object.isFrozen(DEFAULT_MODEL_SLOS.haiku)).toBe(true);
  });
});

describe("resolveSloFor — agent-override wins over model-default", () => {
  it("returns the override threshold + source: 'agent-override' when perf.slos has a first_token p50 entry", () => {
    const agent: ResolveSloInput = {
      model: "opus",
      perf: {
        slos: [
          {
            segment: "first_token",
            metric: "p50",
            thresholdMs: 12_000,
          },
        ],
      },
    };

    const resolved = resolveSloFor(agent);

    expect(resolved.first_token_p50_ms).toBe(12_000);
    expect(resolved.source).toBe("agent-override");
    expect(resolved.model).toBe("opus");
    // model_defaults still surface the fleet-wide baseline so the UI can
    // render "your override: 12000ms / default: 8000ms" pill.
    expect(resolved.model_defaults).toEqual(DEFAULT_MODEL_SLOS.opus);
  });

  it("ignores non-matching overrides (different segment or metric) and falls back to the model default", () => {
    const agent: ResolveSloInput = {
      model: "sonnet",
      perf: {
        slos: [
          // end_to_end p95 override — should NOT replace first_token p50.
          {
            segment: "end_to_end",
            metric: "p95",
            thresholdMs: 99_999,
          },
          // first_token p95 (wrong metric) — should NOT replace first_token p50.
          {
            segment: "first_token",
            metric: "p95",
            thresholdMs: 99_999,
          },
        ],
      },
    };

    const resolved = resolveSloFor(agent);

    expect(resolved.first_token_p50_ms).toBe(6_000); // sonnet model-default
    expect(resolved.source).toBe("model-default");
  });
});

describe("resolveSloFor — model-default fallback paths", () => {
  it("returns opus default when perf.slos is undefined and model = opus", () => {
    const resolved = resolveSloFor({ model: "opus" });
    expect(resolved.first_token_p50_ms).toBe(8_000);
    expect(resolved.source).toBe("model-default");
    expect(resolved.model).toBe("opus");
  });

  it("returns sonnet default when perf.slos is undefined and model = sonnet", () => {
    const resolved = resolveSloFor({ model: "sonnet" });
    expect(resolved.first_token_p50_ms).toBe(6_000);
    expect(resolved.source).toBe("model-default");
    expect(resolved.model).toBe("sonnet");
  });

  it("returns haiku default when perf.slos is undefined and model = haiku", () => {
    const resolved = resolveSloFor({ model: "haiku" });
    expect(resolved.first_token_p50_ms).toBe(2_000);
    expect(resolved.source).toBe("model-default");
    expect(resolved.model).toBe("haiku");
  });

  it("falls back to model-default when perf is present but perf.slos is undefined", () => {
    const resolved = resolveSloFor({
      model: "opus",
      perf: { slos: undefined },
    });
    expect(resolved.first_token_p50_ms).toBe(8_000);
    expect(resolved.source).toBe("model-default");
  });

  it("falls back to model-default when perf.slos is an empty array", () => {
    const resolved = resolveSloFor({
      model: "sonnet",
      perf: { slos: [] },
    });
    expect(resolved.first_token_p50_ms).toBe(6_000);
    expect(resolved.source).toBe("model-default");
  });
});

describe("resolveSloFor — return value is frozen", () => {
  it("freezes the resolved bundle so callers can't mutate downstream", () => {
    const resolved = resolveSloFor({ model: "sonnet" });
    expect(Object.isFrozen(resolved)).toBe(true);
  });
});
