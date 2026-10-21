/**
 * Phase 999.98 Plan 01 Task 3 — Fable SLO no-throw + bucket unit pins.
 *
 * `resolveSloFor` does `DEFAULT_MODEL_SLOS[agent.model]` with NO fallback, so a
 * missing fable entry throws at dashboard render. These tests assert against the
 * ALIAS form `"fable"` — the representation `agent.model` actually carries — NOT
 * a resolved id, so they pin the production lookup path.
 */

import { describe, it, expect } from "vitest";

import {
  DEFAULT_MODEL_SLOS,
  resolveSloFor,
  type ResolveSloInput,
} from "../slos.js";

describe("SLOs — Fable entry (Phase 999.98 D6)", () => {
  it("DEFAULT_MODEL_SLOS carries a fable bucket (cloned from opus)", () => {
    expect(DEFAULT_MODEL_SLOS.fable).toEqual({
      first_token_p50_ms: 8_000,
      end_to_end_p95_ms: 40_000,
      tool_call_p95_ms: 30_000,
    });
  });

  it("resolveSloFor({ model: 'fable' }) does NOT throw and returns the fable bucket", () => {
    const input: ResolveSloInput = { model: "fable" };
    expect(() => resolveSloFor(input)).not.toThrow();
    const resolved = resolveSloFor(input);
    expect(resolved.model).toBe("fable");
    expect(resolved.first_token_p50_ms).toBe(8_000);
    expect(resolved.model_defaults).toEqual({
      first_token_p50_ms: 8_000,
      end_to_end_p95_ms: 40_000,
      tool_call_p95_ms: 30_000,
    });
  });

  it("a per-agent override still wins for a fable agent (source = agent-override)", () => {
    const input: ResolveSloInput = {
      model: "fable",
      perf: {
        slos: [{ segment: "first_token", metric: "p50", thresholdMs: 5_000 }],
      },
    };
    const resolved = resolveSloFor(input);
    expect(resolved.first_token_p50_ms).toBe(5_000);
    expect(resolved.source).toBe("agent-override");
    // model_defaults still reflects the fable bucket, not the override.
    expect(resolved.model_defaults.first_token_p50_ms).toBe(8_000);
  });

  // Sonnet 5 — the `sonnet-4-6` escape-hatch pin shares the sonnet SLO bucket
  // (normalizeSloModel maps it to `sonnet`; no new bucket, no no-fallback throw).
  it("resolveSloFor({ model: 'sonnet-4-6' }) buckets as sonnet and does NOT throw", () => {
    const input: ResolveSloInput = { model: "sonnet-4-6" };
    expect(() => resolveSloFor(input)).not.toThrow();
    const resolved = resolveSloFor(input);
    expect(resolved.model).toBe("sonnet");
    expect(resolved.model_defaults).toEqual(DEFAULT_MODEL_SLOS.sonnet);
  });
});
