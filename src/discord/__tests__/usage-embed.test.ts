/**
 * Phase 103 OBS-07 — usage-embed module unit tests.
 *
 * Pins the pure /clawcode-usage panel renderer:
 *   - 5 renderBar tests (50% / 0% / 100% / undefined / clamping)
 *   - buildUsageEmbed: empty graceful, color triage, field order, overage
 *     status-line, surpassedThreshold field, unknown-type tolerance, footer
 *   - token breakdown: cache-aware "In" headline (token-accuracy fix 2026-06-11)
 *
 * Pitfall closures pinned:
 *   - Pitfall 7: empty snapshots → "No usage data yet" (NOT empty embed)
 *   - Pitfall 9: surpassedThreshold is OPTIONAL NUMBER, rendered as separate
 *     field when defined
 *   - Pitfall 10: rateLimitType "unknown" tolerated without throw
 *   - Open Q3: overage rendered as status-line, NOT a progress bar
 *
 * Test file is pure (no Discord client) — buildUsageEmbed accepts plain
 * snapshot literals + returns an EmbedBuilder whose .data shape we assert.
 */
import { describe, it, expect } from "vitest";
import { buildUsageEmbed, renderBar } from "../usage-embed.js";
import type { UsageTokens } from "../usage-embed.js";
import type { RateLimitSnapshot } from "../../usage/rate-limit-tracker.js";

function snap(overrides: Partial<RateLimitSnapshot>): RateLimitSnapshot {
  return Object.freeze({
    rateLimitType: "five_hour",
    status: "allowed" as const,
    utilization: undefined,
    resetsAt: undefined,
    surpassedThreshold: undefined,
    overageStatus: undefined,
    overageResetsAt: undefined,
    overageDisabledReason: undefined,
    isUsingOverage: undefined,
    recordedAt: Date.now(),
    ...overrides,
  });
}

// Token fixture — all seven fields default to 0 so each test sets only the
// halves it cares about. The embed makes every field required (the cache
// halves and turns/duration arrived with the 2026-06-11 token-accuracy fix).
function tokens(overrides: Partial<UsageTokens> = {}): UsageTokens {
  return {
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    turns: 0,
    duration_ms: 0,
    ...overrides,
  };
}

describe("renderBar (OBS-07)", () => {
  it("renders 50% bar exactly", () => {
    expect(renderBar(0.5)).toBe("▓▓▓▓▓░░░░░ 50%");
  });

  it("renders 0% as all empty", () => {
    expect(renderBar(0)).toBe("░░░░░░░░░░ 0%");
  });

  it("renders 100% as all filled", () => {
    expect(renderBar(1)).toBe("▓▓▓▓▓▓▓▓▓▓ 100%");
  });

  it("renders undefined as 10 dashes + two spaces + n/a", () => {
    // Exact equivalent: "─".repeat(10) + "  n/a"
    expect(renderBar(undefined)).toBe("──────────  n/a");
  });

  it("clamps values >1 to 100%", () => {
    expect(renderBar(1.5)).toBe("▓▓▓▓▓▓▓▓▓▓ 100%");
  });
});

describe("buildUsageEmbed (OBS-07)", () => {
  it("renders 'No usage data yet' description on empty snapshots (Pitfall 7)", () => {
    const e = buildUsageEmbed({ agent: "test", snapshots: [], now: Date.now() });
    expect(e.data.description).toContain("No usage data yet");
    expect(e.data.title).toBe("📊 Usage — test");
  });

  it("color is green when all snapshots allowed", () => {
    const e = buildUsageEmbed({
      agent: "test",
      snapshots: [
        snap({ rateLimitType: "five_hour", status: "allowed", utilization: 0.3 }),
        snap({ rateLimitType: "seven_day", status: "allowed", utilization: 0.5 }),
      ],
      now: Date.now(),
    });
    expect(e.data.color).toBe(3066993);
  });

  it("color is yellow when any allowed_warning (and no rejected)", () => {
    const e = buildUsageEmbed({
      agent: "test",
      snapshots: [
        snap({ rateLimitType: "five_hour", status: "allowed_warning", utilization: 0.85 }),
        snap({ rateLimitType: "seven_day", status: "allowed", utilization: 0.5 }),
      ],
      now: Date.now(),
    });
    expect(e.data.color).toBe(15844367);
  });

  it("color is red when any rejected (overrides allowed_warning)", () => {
    const e = buildUsageEmbed({
      agent: "test",
      snapshots: [
        snap({ rateLimitType: "five_hour", status: "allowed_warning" }),
        snap({ rateLimitType: "seven_day", status: "rejected" }),
      ],
      now: Date.now(),
    });
    expect(e.data.color).toBe(15158332);
  });

  it("renders 4 bar fields in canonical order", () => {
    const e = buildUsageEmbed({
      agent: "test",
      snapshots: [
        // intentionally unordered input — renderer must enforce canonical order
        snap({ rateLimitType: "seven_day_sonnet", status: "allowed", utilization: 0.1 }),
        snap({ rateLimitType: "five_hour", status: "allowed", utilization: 0.2 }),
        snap({ rateLimitType: "seven_day_opus", status: "allowed", utilization: 0.3 }),
        snap({ rateLimitType: "seven_day", status: "allowed", utilization: 0.4 }),
      ],
      now: Date.now(),
    });
    const fieldNames = e.data.fields?.map((f) => f.name) ?? [];
    // Canonical order: five_hour, seven_day, seven_day_opus, seven_day_sonnet
    expect(fieldNames[0]).toContain("5-hour session");
    expect(fieldNames[1]).toContain("7-day weekly");
    expect(fieldNames[2]).toContain("Opus weekly");
    expect(fieldNames[3]).toContain("Sonnet weekly");
  });

  it("renders overage as status-line not bar (Open Q3)", () => {
    const e = buildUsageEmbed({
      agent: "test",
      snapshots: [
        snap({
          rateLimitType: "overage",
          status: "allowed",
          isUsingOverage: true,
          overageStatus: "allowed",
          overageResetsAt: Date.now() + 86_400_000,
        }),
      ],
      now: Date.now(),
    });
    const overageField = e.data.fields?.find((f) => f.name.includes("Overage"));
    expect(overageField).toBeDefined();
    expect(overageField?.value).toContain("using credits");
    // Crucially: NOT a progress bar
    expect(overageField?.value).not.toMatch(/▓+░+/);
  });

  it("renders surpassedThreshold field when defined (Pitfall 9)", () => {
    const e = buildUsageEmbed({
      agent: "test",
      snapshots: [
        snap({
          rateLimitType: "five_hour",
          status: "allowed_warning",
          surpassedThreshold: 0.75,
        }),
      ],
      now: Date.now(),
    });
    const thresholdField = e.data.fields?.find((f) => f.name.includes("Threshold"));
    expect(thresholdField?.value).toContain("75%");
  });

  it("does NOT render threshold field when surpassedThreshold undefined", () => {
    const e = buildUsageEmbed({
      agent: "test",
      snapshots: [snap({ rateLimitType: "five_hour", status: "allowed" })],
      now: Date.now(),
    });
    const thresholdField = e.data.fields?.find((f) => f.name.includes("Threshold"));
    expect(thresholdField).toBeUndefined();
  });

  it("treats rateLimitType:'unknown' gracefully (Pitfall 10)", () => {
    const e = buildUsageEmbed({
      agent: "test",
      snapshots: [snap({ rateLimitType: "unknown", status: "allowed" })],
      now: Date.now(),
    });
    // Unknown types are NOT in TYPE_ORDER and NOT overage — they're silently
    // omitted from the bar grid but the embed still renders (no throw).
    expect(e.data.color).toBe(3066993);
  });

  it("footer carries the PT date + snapshot staleness when snapshots exist", () => {
    const e = buildUsageEmbed({
      agent: "test",
      snapshots: [snap({ rateLimitType: "five_hour", status: "allowed" })],
      now: Date.UTC(2026, 5, 11, 18, 0, 0), // 11:00 PT on Jun 11 2026
    });
    expect(e.data.footer?.text).toContain("(PT)");
    expect(e.data.footer?.text).toContain("Jun 11");
    expect(e.data.footer?.text).toContain("snapshot");
  });

  it("footer says the bars are live from Anthropic when they are", () => {
    const e = buildUsageEmbed({
      agent: "test",
      snapshots: [snap({ rateLimitType: "five_hour", status: "allowed" })],
      now: Date.UTC(2026, 8, 26, 18, 0, 0),
      source: "anthropic",
    });
    expect(e.data.footer?.text).toContain("live from Anthropic");
    expect(e.data.footer?.text).not.toContain("snapshot");
  });
});

describe("buildUsageEmbed token breakdown (cache-aware, current Pacific day)", () => {
  it("headline 'In' sums fresh + cache-read + cache-write, not fresh-only", () => {
    // The whole point of the 2026-06-11 token-accuracy fix: on a cache-heavy
    // Opus agent cache reads are ~90% of real input. The headline must be the
    // TRUE API-metered total, with the breakdown keeping it honest.
    const e = buildUsageEmbed({
      agent: "test",
      snapshots: [snap({ rateLimitType: "five_hour", status: "allowed", utilization: 0.2 })],
      now: Date.now(),
      daily: tokens({
        tokens_in: 2000, // fresh / uncached half
        cache_read_tokens: 90000,
        cache_creation_tokens: 8000,
        tokens_out: 5000,
        cost_usd: 1.2345,
        turns: 42,
        duration_ms: 4_320_000, // 72 min
      }),
    });
    const tok = (e.data.fields ?? []).find((f) => f.name === "Tokens · Today (PT)");
    expect(tok).toBeDefined();
    // total in = 2000 + 90000 + 8000 = 100000 → compact "100.0K" headline
    expect(tok?.value).toContain("100.0K");
    // out headline also compacted
    expect(tok?.value).toContain("5.0K");
    // breakdown sub-line carries the comma-grouped halves
    expect(tok?.value).toContain("fresh 2,000");
    expect(tok?.value).toContain("cache-read 90,000");
    expect(tok?.value).toContain("cache-write 8,000");
    // cache-hit gauge: 90000 / 100000 = 90%
    expect(tok?.value).toContain("90%");
    expect(tok?.value).toContain("from cache");
  });

  it("renders a separate cost & activity line (cost ≥ $1 → 2dp, turns, active time)", () => {
    const e = buildUsageEmbed({
      agent: "test",
      snapshots: [],
      now: Date.now(),
      daily: tokens({ tokens_in: 1, cost_usd: 1.2345, turns: 42, duration_ms: 4_320_000 }),
    });
    const cost = (e.data.fields ?? []).find(
      (f) => f.name === "Cost & activity · Today (PT)",
    );
    expect(cost).toBeDefined();
    expect(cost?.value).toContain("$1.23"); // ≥ $1 → 2 decimals
    expect(cost?.value).toContain("42 turns");
    expect(cost?.value).toContain("~1h 12m"); // 72 min of active time
  });

  it("renders sub-$1 cost with 4 decimals", () => {
    const e = buildUsageEmbed({
      agent: "test",
      snapshots: [],
      now: Date.now(),
      daily: tokens({ tokens_in: 10, cost_usd: 0.0421 }),
    });
    const cost = (e.data.fields ?? []).find(
      (f) => f.name === "Cost & activity · Today (PT)",
    );
    expect(cost?.value).toContain("$0.0421");
  });

  it("labels buckets as the current Pacific day, with NO weekly field", () => {
    const e = buildUsageEmbed({
      agent: "test",
      snapshots: [],
      now: Date.now(),
      daily: tokens({ tokens_in: 10, tokens_out: 5 }),
    });
    const names = (e.data.fields ?? []).map((f) => f.name);
    expect(names).toContain("Tokens · Today (PT)");
    expect(names).toContain("Cost & activity · Today (PT)");
    // current-day only by design — the weekly bucket was dropped 2026-06-11
    expect(names.some((n) => /week/i.test(n))).toBe(false);
  });

  it("renders the token panel with NO snapshots (API-key auth) and a PT-date footer", () => {
    const e = buildUsageEmbed({
      agent: "test",
      snapshots: [],
      now: Date.now(),
      daily: tokens({ tokens_in: 999, tokens_out: 1, cost_usd: 0.01 }),
    });
    // NOT the "no data" path — token data is real data.
    expect(e.data.description).toBeUndefined();
    expect((e.data.fields ?? []).some((f) => f.name === "Tokens · Today (PT)")).toBe(true);
    // Footer is ALWAYS set now (the PT calendar date); only the
    // snapshot-staleness suffix is snapshot-gated — so a token-only panel
    // carries a footer WITHOUT it (and no Math.min-of-empty crash).
    expect(e.data.footer?.text).toContain("(PT)");
    expect(e.data.footer?.text).not.toContain("snapshot");
  });

  it("counts a cache-only day as real data (not 'No usage data yet')", () => {
    // A backfilled / cache-dominated day can have fresh + out = 0 but a huge
    // cache-read total — that is still real usage, not an empty panel.
    const e = buildUsageEmbed({
      agent: "test",
      snapshots: [],
      now: Date.now(),
      daily: tokens({ cache_read_tokens: 500000 }),
    });
    expect(e.data.description).toBeUndefined();
    expect((e.data.fields ?? []).some((f) => f.name === "Tokens · Today (PT)")).toBe(true);
  });

  it("shows 'No usage data yet' when snapshots AND all token halves are zero", () => {
    const e = buildUsageEmbed({
      agent: "test",
      snapshots: [],
      now: Date.now(),
      daily: tokens(), // all zero, including the cache halves
    });
    expect(e.data.description).toContain("No usage data yet");
  });

  it("omits the token fields entirely when the daily fetch failed (undefined)", () => {
    const e = buildUsageEmbed({
      agent: "test",
      snapshots: [snap({ rateLimitType: "five_hour", status: "allowed" })],
      now: Date.now(),
      // daily omitted — its IPC fetch rejected
    });
    const names = (e.data.fields ?? []).map((f) => f.name);
    expect(names.some((n) => n.startsWith("Tokens ·"))).toBe(false);
    expect(names.some((n) => n.startsWith("Cost & activity"))).toBe(false);
  });
});
