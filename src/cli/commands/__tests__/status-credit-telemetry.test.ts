/**
 * Phase 138 Plan 02 T-03 — `renderCreditTelemetry` CLI footer pinning.
 *
 * `clawcode status` renders a fleet-level credit-telemetry footer block
 * AFTER the per-agent rows. Proves the 6 cases from the PLAN T-03
 * `<action>` block:
 *   (a) Header line + one line per provider.
 *   (b) All-zero sparkline → 8 spaces.
 *   (c) Mixed sparkline samples → 8 unicode-block chars from BLOCKS.
 *   (d) pct ≥ 95 includes the ANSI red escape.
 *   (e) Empty providers array → no output (return []).
 *   (f) Missing `creditTelemetry` field is the absence path — covered
 *       by (e) since the caller passes an empty list / skips the call.
 *
 * Pure-function tests — no IPC, no daemon. The fixture payloads conform
 * to `CreditTelemetryPayload` from `src/ipc/protocol.ts`.
 *
 * See:
 *   - `src/cli/commands/status.ts` — `renderCreditTelemetry`.
 *   - `.planning/phases/138-.../138-02-PLAN.md` T-03 <behavior>.
 */

import { describe, it, expect } from "vitest";
import { renderCreditTelemetry } from "../status.js";
import type { CreditTelemetryPayload } from "../../../ipc/protocol.js";

/** Build a credit-telemetry payload from partial provider specs. */
function makePayload(
  providers: Array<{
    provider: "anthropic" | "openai";
    cost_usd: number;
    cap_usd: number;
    pct: number;
    sparkline?: number[];
    turn_count?: number;
    tokens_in?: number;
    tokens_out?: number;
  }>,
): CreditTelemetryPayload {
  return {
    date: "2026-05-20",
    providers: providers.map((p) => ({
      provider: p.provider,
      cost_usd: p.cost_usd,
      cap_usd: p.cap_usd,
      pct: p.pct,
      tokens_in: p.tokens_in ?? 0,
      tokens_out: p.tokens_out ?? 0,
      turn_count: p.turn_count ?? 0,
      models: [],
      sparkline: p.sparkline ?? new Array<number>(24).fill(0),
      agents: [],
    })),
  };
}

describe("renderCreditTelemetry", () => {
  it("(a) renders 1 header line + 1 line per provider", () => {
    const payload = makePayload([
      { provider: "anthropic", cost_usd: 3.2, cap_usd: 6.67, pct: 48 },
      { provider: "openai", cost_usd: 1.1, cap_usd: 6.67, pct: 16 },
    ]);
    const lines = renderCreditTelemetry(payload);
    expect(lines).toHaveLength(3); // header + 2 providers
    expect(lines[0]).toContain("Credit telemetry");
    expect(lines[0]).toContain("2026-05-20");
    expect(lines[1]).toContain("anthropic");
    expect(lines[2]).toContain("openai");
  });

  it("(b) all-zero sparkline renders as 8 spaces", () => {
    const payload = makePayload([
      {
        provider: "anthropic",
        cost_usd: 0,
        cap_usd: 6.67,
        pct: 0,
        sparkline: new Array<number>(24).fill(0),
      },
    ]);
    const lines = renderCreditTelemetry(payload);
    // The provider line contains 8 consecutive spaces for the sparkline.
    expect(lines[1]).toContain("        ");
  });

  it("(c) mixed sparkline samples → 8 unicode-block chars", () => {
    const ramp = Array.from({ length: 24 }, (_, i) => i); // 0..23
    const payload = makePayload([
      { provider: "anthropic", cost_usd: 5, cap_usd: 6.67, pct: 75, sparkline: ramp },
    ]);
    const lines = renderCreditTelemetry(payload);
    const BLOCKS = "▁▂▃▄▅▆▇█";
    // At least one block glyph must appear in the rendered line.
    const blockCount = [...lines[1]!].filter((ch) => BLOCKS.includes(ch))
      .length;
    expect(blockCount).toBeGreaterThanOrEqual(1);
    // The highest bucket (last 3 ramp samples → avg 22) maps to the
    // top glyph since 22/23 ≈ 0.96 → floor(0.96*8)=7 → '█'.
    expect(lines[1]).toContain("█");
  });

  it("(d) pct >= 95 includes the ANSI red escape", () => {
    const payload = makePayload([
      { provider: "anthropic", cost_usd: 6.5, cap_usd: 6.67, pct: 97 },
    ]);
    const lines = renderCreditTelemetry(payload);
    expect(lines[1]).toContain("\x1b[31m");
  });

  it("(d2) pct < 75 uses green, not red", () => {
    const payload = makePayload([
      { provider: "anthropic", cost_usd: 1.0, cap_usd: 6.67, pct: 15 },
    ]);
    const lines = renderCreditTelemetry(payload);
    expect(lines[1]).toContain("\x1b[32m"); // green
    expect(lines[1]).not.toContain("\x1b[31m"); // not red
  });

  it("(e) empty providers array → no output", () => {
    const payload = makePayload([]);
    expect(renderCreditTelemetry(payload)).toEqual([]);
  });

  it("(f) undefined payload → no output", () => {
    expect(renderCreditTelemetry(undefined)).toEqual([]);
  });
});
