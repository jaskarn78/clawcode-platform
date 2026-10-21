/**
 * Phase 138 Plan 01 T-04 — `phase138-usage` per-turn hook.
 *
 * The hook fires from the UNIFIED per-turn usage callback
 * (`session-manager.ts`) for BOTH backends — Anthropic Agent SDK and
 * Codex CLI route their `result`-message usage through the same
 * `UsageCallback`. `buildProviderUsageHook` wraps a
 * `ProviderUsageTracker` + logger and returns a per-turn function.
 *
 * Proves the 3 cases from the PLAN `<action>` block plus the
 * backend→provider mapping:
 *   (T-04a) supplying a tracker → `recordTurn` is called with the
 *           right provider + model + tokens.
 *   (T-04b) the hook is a no-op when the tracker is absent (no throw).
 *   (T-04c) the `phase138-usage` log line carries ONLY the allow-list
 *           fields — no apiKeyPath, no message bodies, no secrets
 *           (Info-Disclosure threat T-138-01-01).
 *   - `backendToProvider` maps `codex-cli` → `openai`, everything
 *     else → `anthropic`.
 *
 * See:
 *   - `src/usage/provider-usage-hook.ts`
 *   - `.planning/phases/138-.../138-01-PLAN.md` T-04 <behavior>
 */

import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { ProviderUsageTracker } from "../provider-usage-tracker.js";
import {
  backendToProvider,
  buildProviderUsageHook,
  PHASE138_USAGE_LOG_KEY,
} from "../provider-usage-hook.js";

const FIXED_MILLIS = Date.parse("2026-05-20T12:00:00.000Z");

describe("backendToProvider", () => {
  it("maps codex-cli → openai", () => {
    expect(backendToProvider("codex-cli")).toBe("openai");
  });

  it("maps anthropic-agent-sdk → anthropic", () => {
    expect(backendToProvider("anthropic-agent-sdk")).toBe("anthropic");
  });

  it("maps undefined (Phase 136 baseline) → anthropic", () => {
    expect(backendToProvider(undefined)).toBe("anthropic");
  });

  it("maps an unknown backend id → anthropic (safe default)", () => {
    expect(backendToProvider("some-future-backend")).toBe("anthropic");
  });
});

describe("buildProviderUsageHook", () => {
  function makeTracker(): ProviderUsageTracker {
    return new ProviderUsageTracker(new Database(":memory:"), () => FIXED_MILLIS);
  }

  it("(T-04a) calls recordTurn with the right provider + model + tokens", () => {
    const tracker = makeTracker();
    const recordSpy = vi.spyOn(tracker, "recordTurn");
    const hook = buildProviderUsageHook({
      tracker,
      agent: "agent-a",
      backend: "codex-cli",
    });
    hook({
      tokens_in: 1000,
      tokens_out: 500,
      cost_usd: 0.1,
      turns: 1,
      model: "gpt-5-codex",
      duration_ms: 1234,
    });
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "agent-a",
        provider: "openai",
        model: "gpt-5-codex",
        tokensIn: 1000,
        tokensOut: 500,
      }),
    );
  });

  it("(T-04a2) maps the anthropic backend to provider 'anthropic'", () => {
    const tracker = makeTracker();
    const recordSpy = vi.spyOn(tracker, "recordTurn");
    const hook = buildProviderUsageHook({
      tracker,
      agent: "agent-b",
      backend: "anthropic-agent-sdk",
    });
    hook({
      tokens_in: 10,
      tokens_out: 10,
      cost_usd: 0,
      turns: 1,
      model: "sonnet",
      duration_ms: 1,
    });
    expect(recordSpy).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "anthropic", model: "sonnet" }),
    );
  });

  it("(T-04b) is a no-op when the tracker is absent — does not throw", () => {
    const hook = buildProviderUsageHook({
      tracker: undefined,
      agent: "agent-a",
      backend: "codex-cli",
    });
    expect(() =>
      hook({
        tokens_in: 1,
        tokens_out: 1,
        cost_usd: 0,
        turns: 1,
        model: "gpt-5-codex",
        duration_ms: 1,
      }),
    ).not.toThrow();
  });

  it("(T-04b2) does not throw even when recordTurn itself fails", () => {
    const tracker = makeTracker();
    vi.spyOn(tracker, "recordTurn").mockImplementation(() => {
      throw new Error("simulated DB failure");
    });
    const logger = { info: vi.fn(), warn: vi.fn() };
    const hook = buildProviderUsageHook({
      tracker,
      agent: "agent-a",
      backend: "codex-cli",
      logger,
    });
    expect(() =>
      hook({
        tokens_in: 1,
        tokens_out: 1,
        cost_usd: 0,
        turns: 1,
        model: "gpt-5-codex",
        duration_ms: 1,
      }),
    ).not.toThrow();
  });

  it("(T-04c) emits phase138-usage with ONLY the allow-list fields", () => {
    const tracker = makeTracker();
    const logger = { info: vi.fn(), warn: vi.fn() };
    // Inject the fixed clock (mirrors T-04c2 below) so the `date` field
    // is deterministic — production derives it via
    // `new Date(clock()).toISOString().slice(0, 10)` (UTC). With
    // FIXED_MILLIS = 2026-05-20T12:00:00Z that resolves to "2026-05-20".
    const hook = buildProviderUsageHook({
      tracker,
      agent: "agent-a",
      backend: "codex-cli",
      logger,
      clock: () => FIXED_MILLIS,
    });
    hook({
      tokens_in: 1000,
      tokens_out: 500,
      cost_usd: 0.1,
      turns: 1,
      model: "gpt-5-codex",
      duration_ms: 42,
    });
    expect(logger.info).toHaveBeenCalledTimes(1);
    const [payload, msg] = logger.info.mock.calls[0]!;
    expect(msg).toBe(PHASE138_USAGE_LOG_KEY);
    expect(msg).toBe("phase138-usage");

    // Exact allow-list — no extra keys, no secrets.
    const allowed = [
      "agent",
      "provider",
      "model",
      "tokens_in",
      "tokens_out",
      "cost_usd",
      "turn_count",
      "date",
    ].sort();
    expect(Object.keys(payload as object).sort()).toEqual(allowed);

    const p = payload as Record<string, unknown>;
    expect(p.agent).toBe("agent-a");
    expect(p.provider).toBe("openai");
    expect(p.model).toBe("gpt-5-codex");
    expect(p.tokens_in).toBe(1000);
    expect(p.tokens_out).toBe(500);
    expect(p.turn_count).toBe(1);
    expect(typeof p.cost_usd).toBe("number");
    expect(p.date).toBe("2026-05-20");

    // Explicit secret-leak assertions.
    expect(p).not.toHaveProperty("apiKeyPath");
    expect(p).not.toHaveProperty("OPENAI_API_KEY");
    expect(p).not.toHaveProperty("messages");
    expect(p).not.toHaveProperty("system");
  });

  it("(T-04c2) emits the log line even when the tracker is absent", () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const hook = buildProviderUsageHook({
      tracker: undefined,
      agent: "agent-a",
      backend: "anthropic-agent-sdk",
      logger,
      clock: () => FIXED_MILLIS,
    });
    hook({
      tokens_in: 10,
      tokens_out: 5,
      cost_usd: 0,
      turns: 1,
      model: "sonnet",
      duration_ms: 1,
    });
    // Operator-side visibility preserved — log fires, turn_count is 0
    // (no tracker to return a count).
    expect(logger.info).toHaveBeenCalledTimes(1);
    const [payload] = logger.info.mock.calls[0]!;
    expect((payload as Record<string, unknown>).provider).toBe("anthropic");
    expect((payload as Record<string, unknown>).turn_count).toBe(0);
  });
});
