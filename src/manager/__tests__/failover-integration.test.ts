/**
 * Phase 138 Plan 06 T-01 — end-to-end failover integration test.
 *
 * This is the PHASE-138 KEYSTONE test: it wires Plans 01-05 together and
 * proves the full pipeline in isolation —
 *
 *   seed `provider_usage` (real spend) + `provider_alert_state`
 *   (a real 95% crossing row, the Plan 03 → Plan 05 signal)
 *     → real `FailoverController.tick()` (Plan 05)
 *       → real `FailoverStateStore.set` writes a real `failover_state`
 *         row (Plan 05)
 *         → real `createLlmRuntimeService(config, { failoverStateReader })`
 *           reads that row BEFORE the dispatch switch (Plan 04 keystone +
 *           Plan 05 T-03)
 *             → asserts the returned backend is the FALLBACK.
 *
 * There is NO parallel mock of the failover path — the test drives the
 * REAL `FailoverController` over a REAL `FailoverStateStore` over a real
 * in-memory SQLite db, then invokes the REAL factory. This is the
 * `feedback_silent_path_bifurcation` invariant: prove the production
 * wiring, not a dead emitter.
 *
 * Cost containment (CONTEXT known_constraints): ALL wire surfaces are
 * `vi.mock`/`vi.fn` stubbed. No real provider API is hit. The threshold
 * crossing is SIMULATED by direct SQL seeding — `provider_usage` rows are
 * inserted to reach a desired cumulative cost, and `provider_alert_state`
 * `threshold=95` rows mark the saturated provider. No real `croner`
 * timer fires — the cron tick is invoked synchronously via
 * `controller.tick()`.
 *
 * 8 scenarios (CONTEXT-locked, plan T4):
 *   (a) Below 95%        → no failover, configured backend used.
 *   (b) 95% on anthropic → failover row + codex-cli backend returned.
 *   (c) 95% on openai    → failover row + anthropic backend returned.
 *   (d) 95% no chain     → no failover row, configured backend (warn).
 *   (e) Persists across a simulated daemon restart.
 *   (f) Expires at UTC midnight.
 *   (g) Manual override never auto-expires.
 *   (h) Two agents on the same saturated provider fail over independently.
 *
 * See:
 *   - `.planning/phases/138-.../138-06-PLAN.md` T-01
 *   - `src/manager/failover-controller.ts`     — FailoverController
 *   - `src/usage/failover-state.ts`            — FailoverStateStore
 *   - `src/llm-runtime/llm-runtime-service.ts` — createLlmRuntimeService
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

import { FailoverStateStore } from "../../usage/failover-state.js";
import {
  FailoverController,
  type FailoverAgentConfig,
} from "../failover-controller.js";
import { createLlmRuntimeService } from "../../llm-runtime/llm-runtime-service.js";
import { AnthropicAgentSdkBackend } from "../../llm-runtime/backends/anthropic-agent-sdk.js";
import { CodexAgentCli } from "../../llm-runtime/backends/codex-agent-cli.js";
import type { LlmRuntimeBackend } from "../../llm-runtime/types.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";

// ────────────────────────────────────────────────────────────────────
// Schema — verbatim from CONTEXT D2 / the Plan 01-05 table owners.
// ────────────────────────────────────────────────────────────────────

/** `provider_usage` — Plan 01's per-agent spend table. */
const PROVIDER_USAGE_DDL = `
CREATE TABLE IF NOT EXISTS provider_usage (
  date         TEXT NOT NULL,
  provider     TEXT NOT NULL,
  model        TEXT NOT NULL,
  tokens_in    INTEGER NOT NULL DEFAULT 0,
  tokens_out   INTEGER NOT NULL DEFAULT 0,
  cost_usd     REAL NOT NULL DEFAULT 0,
  turn_count   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (date, provider, model)
);
`;

/** `provider_alert_state` — Plan 03's fleet-level threshold-dedup table. */
const PROVIDER_ALERT_STATE_DDL = `
CREATE TABLE IF NOT EXISTS provider_alert_state (
  date         TEXT NOT NULL,
  provider     TEXT NOT NULL,
  threshold    INTEGER NOT NULL,
  fired_at     INTEGER NOT NULL,
  PRIMARY KEY (date, provider, threshold)
);
`;

/** Today's UTC YYYY-MM-DD — the saturation read scopes to the current day. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** A deterministic daily cap so a seeded cost maps to a known pct. */
const DAILY_CAP_USD = 100;

// ────────────────────────────────────────────────────────────────────
// Pipeline builder — wires Plans 01-05 over one in-memory db.
// ────────────────────────────────────────────────────────────────────

/**
 * Build the full failover pipeline over a single in-memory SQLite db.
 * Returns the live `FailoverStateStore`, a `FailoverController`, and the
 * raw db handle for direct seeding.
 *
 * `readSaturatedProviders` mirrors the daemon wiring verbatim
 * (`daemon.ts` line 8732) — a `SELECT DISTINCT provider FROM
 * provider_alert_state WHERE date = ? AND threshold = 95`. This is the
 * REAL Plan 03 → Plan 05 signal path, not a stub set.
 */
function buildPipeline(opts: {
  db: DatabaseType;
  agents: readonly FailoverAgentConfig[];
  clock?: () => number;
}) {
  const { db, agents } = opts;
  // The store OWNS `failover_state` — its constructor creates the table.
  const failoverStateStore = new FailoverStateStore({ db });

  // Stubbed Discord surface — fire-and-forget; no real webhook is hit.
  const webhookSend = vi.fn().mockResolvedValue(undefined);
  const webhookManager = { send: webhookSend };

  // Logger stub — lets scenarios assert the `phase138-failover-triggered`
  // controller-layer telemetry tag.
  const logger = { info: vi.fn(), warn: vi.fn() };

  const controller = new FailoverController({
    failoverStateStore,
    // The REAL production saturation read — `provider_alert_state`
    // today's `threshold=95` rows (daemon.ts:8732 verbatim).
    readSaturatedProviders: () => {
      const rows = db
        .prepare(
          "SELECT DISTINCT provider FROM provider_alert_state " +
            "WHERE date = ? AND threshold = 95",
        )
        .all(todayUtc()) as { provider: string }[];
      return new Set(rows.map((r) => r.provider));
    },
    resolveAgents: () => agents,
    clock: opts.clock,
    webhookManager,
    logger,
  });

  return { db, failoverStateStore, controller, webhookManager, webhookSend, logger };
}

/**
 * Seed `provider_usage` rows so the cumulative `cost_usd` for a provider
 * reaches `costPerTurn * turnCount`. Direct SQL — the simulated-depletion
 * seam (no real spend, no API calls).
 */
function seedTurns(
  db: DatabaseType,
  provider: string,
  model: string,
  costPerTurn: number,
  turnCount: number,
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO provider_usage
       (date, provider, model, tokens_in, tokens_out, cost_usd, turn_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (date, provider, model) DO UPDATE SET
       cost_usd   = cost_usd + excluded.cost_usd,
       turn_count = turn_count + excluded.turn_count,
       updated_at = excluded.updated_at`,
  ).run(
    todayUtc(),
    provider,
    model,
    1000 * turnCount,
    500 * turnCount,
    costPerTurn * turnCount,
    turnCount,
    now,
    now,
  );
}

/**
 * Mark a provider as having crossed the 95% line — seed a real
 * `provider_alert_state` `threshold=95` row (the Plan 03 → Plan 05
 * signal that `readSaturatedProviders` reads). This is the row
 * `ThresholdAlerter.evaluate` would write in production once the seeded
 * `provider_usage` cumulative cost crosses 95% of the cap.
 */
function seedSaturation(db: DatabaseType, provider: string): void {
  db.prepare(
    `INSERT INTO provider_alert_state (date, provider, threshold, fired_at)
     VALUES (?, ?, 95, ?)
     ON CONFLICT (date, provider, threshold) DO NOTHING`,
  ).run(todayUtc(), provider, Date.now());
}

/** Compute a provider's seeded cumulative spend as a pct of the cap. */
function pctOfCap(db: DatabaseType, provider: string): number {
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM provider_usage " +
        "WHERE date = ? AND provider = ?",
    )
    .get(todayUtc(), provider) as { total: number };
  return (row.total / DAILY_CAP_USD) * 100;
}

/**
 * Minimal `ResolvedAgentConfig` for the factory. Only the fields
 * `createLlmRuntimeService` + the backend constructors touch matter;
 * the rest is shape-satisfying. Pattern lifted verbatim from
 * `llm-runtime-service-failover.test.ts`.
 */
function makeConfig(
  name: string,
  backend: LlmRuntimeBackend,
  failoverChain: readonly LlmRuntimeBackend[] = [],
): ResolvedAgentConfig {
  return {
    name,
    workspace: "/tmp/clawcode-test",
    memoryPath: "/tmp/clawcode-test",
    channels: [],
    model: "sonnet",
    effort: "low",
    allowedModels: ["haiku", "sonnet", "opus"],
    greetOnRestart: true,
    greetCoolDownMs: 300_000,
    autoCompactAt: 0.7,
    memoryRetrievalTopK: 0,
    memoryRetrievalExcludeTags: [],
    memoryScannerEnabled: false,
    memoryFlushIntervalMs: 60_000,
    memoryCueEmoji: "✅",
    autoIngestAttachments: false,
    ingestionPriority: "medium" as const,
    excludeDynamicSections: false,
    cacheBreakpointPlacement: "after-skills",
    autoStart: false,
    skills: [],
    marketplaceSources: [],
    capabilityMode: "open",
    perTurnAllowList: [],
    allowList: [],
    capabilityProbeBatchSize: 4,
    capabilityProbeCacheTtlMs: 300_000,
    capabilityProbeRetryAfterMs: 30_000,
    mcpServers: [],
    slashCommands: [],
    llmRuntime: { backend, failoverChain },
  } as unknown as ResolvedAgentConfig;
}

/** Count emissions of a structured-log message on a `vi.fn()` info spy. */
function emitCount(
  logger: { info: ReturnType<typeof vi.fn> },
  msg: string,
): number {
  return logger.info.mock.calls.filter((c) => c[1] === msg).length;
}

// ────────────────────────────────────────────────────────────────────

describe("Phase 138 failover integration — end-to-end pipeline", () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(PROVIDER_USAGE_DDL);
    db.exec(PROVIDER_ALERT_STATE_DDL);
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  // ── threshold-based failover ───────────────────────────────────────

  describe("threshold-based failover", () => {
    it("(a) below 95% — no failover row, configured backend used", async () => {
      // Seed real spend WELL below the cap — 40% of $100.
      seedTurns(db, "anthropic", "claude-sonnet", 4, 10); // $40 → 40%
      expect(pctOfCap(db, "anthropic")).toBeLessThan(95);
      // No `provider_alert_state` threshold=95 row → provider not saturated.

      const agents: FailoverAgentConfig[] = [
        {
          name: "research",
          backend: "anthropic-agent-sdk",
          failoverChain: ["codex-cli"],
        },
      ];
      const { failoverStateStore, controller } = buildPipeline({ db, agents });

      await controller.tick();

      // No saturation → no failover row written.
      expect(failoverStateStore.listAll()).toHaveLength(0);

      // The factory dispatches to the CONFIGURED backend.
      const svc = createLlmRuntimeService(
        makeConfig("research", "anthropic-agent-sdk", ["codex-cli"]),
        { failoverStateReader: failoverStateStore, logger: { info: vi.fn(), warn: vi.fn() } },
      );
      expect(svc).toBeInstanceOf(AnthropicAgentSdkBackend);
    });

    it("(b) 95% on anthropic with chain=[codex-cli] → failover row + CodexAgentCli", async () => {
      // Seed real cumulative spend that crosses 95% of the $100 cap.
      seedTurns(db, "anthropic", "claude-sonnet", 4, 24); // $96 → 96%
      expect(pctOfCap(db, "anthropic")).toBeGreaterThanOrEqual(95);
      // The Plan 03 → Plan 05 signal: a real `threshold=95` row.
      seedSaturation(db, "anthropic");

      const agents: FailoverAgentConfig[] = [
        {
          name: "research",
          backend: "anthropic-agent-sdk",
          failoverChain: ["codex-cli"],
        },
      ];
      const { failoverStateStore, controller, logger } = buildPipeline({
        db,
        agents,
      });

      // Drive the REAL controller — reads saturation, evaluates, writes
      // a REAL failover_state row.
      await controller.tick();

      // A real failover_state row was inserted.
      const row = failoverStateStore.get("research");
      expect(row).toMatchObject({
        agent: "research",
        active_backend: "codex-cli",
        reason: "threshold-95",
      });
      expect(row?.expires_at).not.toBeNull();

      // The controller emitted the layer-correct telemetry tag.
      expect(emitCount(logger, "phase138-failover-triggered")).toBe(1);

      // The REAL factory, reading the REAL store, returns the FALLBACK.
      const svc = createLlmRuntimeService(
        makeConfig("research", "anthropic-agent-sdk", ["codex-cli"]),
        { failoverStateReader: failoverStateStore, logger: { info: vi.fn(), warn: vi.fn() } },
      );
      expect(svc).toBeInstanceOf(CodexAgentCli);
    });

    it("(c) 95% on openai with chain=[anthropic-agent-sdk] → failover row + AnthropicAgentSdkBackend", async () => {
      // openai-side saturation — a codex-cli agent flips to anthropic.
      seedTurns(db, "openai", "gpt-5-codex", 5, 20); // $100 → 100%
      expect(pctOfCap(db, "openai")).toBeGreaterThanOrEqual(95);
      seedSaturation(db, "openai");

      const agents: FailoverAgentConfig[] = [
        {
          name: "projects",
          backend: "codex-cli",
          failoverChain: ["anthropic-agent-sdk"],
        },
      ];
      const { failoverStateStore, controller } = buildPipeline({ db, agents });

      await controller.tick();

      expect(failoverStateStore.get("projects")).toMatchObject({
        active_backend: "anthropic-agent-sdk",
        reason: "threshold-95",
      });

      const svc = createLlmRuntimeService(
        makeConfig("projects", "codex-cli", ["anthropic-agent-sdk"]),
        { failoverStateReader: failoverStateStore, logger: { info: vi.fn(), warn: vi.fn() } },
      );
      expect(svc).toBeInstanceOf(AnthropicAgentSdkBackend);
    });

    it("(d) 95% with empty failoverChain → warn-only, no failover row, configured backend", async () => {
      seedTurns(db, "anthropic", "claude-sonnet", 5, 20); // $100 → 100%
      seedSaturation(db, "anthropic");

      const agents: FailoverAgentConfig[] = [
        {
          name: "research",
          backend: "anthropic-agent-sdk",
          failoverChain: [], // no chain — warn-only.
        },
      ];
      const { failoverStateStore, controller, logger } = buildPipeline({
        db,
        agents,
      });

      await controller.tick();

      // No row written — the saturated agent has no chain.
      expect(failoverStateStore.listAll()).toHaveLength(0);
      // The warn-only telemetry tag fired.
      expect(
        logger.warn.mock.calls.some(
          (c) => c[1] === "phase138-failover-no-chain",
        ),
      ).toBe(true);

      // The factory still dispatches to the configured backend.
      const svc = createLlmRuntimeService(
        makeConfig("research", "anthropic-agent-sdk", []),
        { failoverStateReader: failoverStateStore, logger: { info: vi.fn(), warn: vi.fn() } },
      );
      expect(svc).toBeInstanceOf(AnthropicAgentSdkBackend);
    });
  });

  // ── persistence + expiry ───────────────────────────────────────────

  describe("persistence + expiry", () => {
    it("(e) failover persists across a simulated daemon restart", async () => {
      seedTurns(db, "anthropic", "claude-sonnet", 4, 24); // $96 → 96%
      seedSaturation(db, "anthropic");

      const agents: FailoverAgentConfig[] = [
        {
          name: "research",
          backend: "anthropic-agent-sdk",
          failoverChain: ["codex-cli"],
        },
      ];
      const first = buildPipeline({ db, agents });
      await first.controller.tick();
      expect(first.failoverStateStore.get("research")?.active_backend).toBe(
        "codex-cli",
      );

      // Simulate a daemon restart: the `:memory:` db handle stays open
      // (the durable-on-disk SQLite file would survive a real restart);
      // a FRESH FailoverStateStore re-attaches to it. The row persists.
      const restartedStore = new FailoverStateStore({ db });
      expect(restartedStore.get("research")).toMatchObject({
        agent: "research",
        active_backend: "codex-cli",
        reason: "threshold-95",
      });

      // The factory reading the restarted store still returns the
      // fallback — the override survived the restart.
      const svc = createLlmRuntimeService(
        makeConfig("research", "anthropic-agent-sdk", ["codex-cli"]),
        { failoverStateReader: restartedStore, logger: { info: vi.fn(), warn: vi.fn() } },
      );
      expect(svc).toBeInstanceOf(CodexAgentCli);
    });

    it("(f) failover expires at UTC midnight — factory dispatches the configured backend", async () => {
      seedTurns(db, "anthropic", "claude-sonnet", 4, 24); // $96 → 96%
      seedSaturation(db, "anthropic");

      const agents: FailoverAgentConfig[] = [
        {
          name: "research",
          backend: "anthropic-agent-sdk",
          failoverChain: ["codex-cli"],
        },
      ];
      const { failoverStateStore, controller } = buildPipeline({ db, agents });
      await controller.tick();

      const row = failoverStateStore.get("research");
      const expiresAt = row?.expires_at;
      expect(expiresAt).toBeTruthy();

      // Advance the wall clock PAST the override's expiry instant. The
      // factory calls `Date.now()` directly + the reader filters on
      // `expires_at > now` — so a fake clock past expiry makes the
      // override invisible.
      vi.useFakeTimers();
      vi.setSystemTime(new Date((expiresAt as number) + 1));

      // The store's reader now sees the row as expired → undefined.
      expect(
        failoverStateStore.getActiveBackend("research", Date.now()),
      ).toBeUndefined();

      // The factory dispatches to the CONFIGURED backend (override gone).
      const svc = createLlmRuntimeService(
        makeConfig("research", "anthropic-agent-sdk", ["codex-cli"]),
        { failoverStateReader: failoverStateStore, logger: { info: vi.fn(), warn: vi.fn() } },
      );
      expect(svc).toBeInstanceOf(AnthropicAgentSdkBackend);
    });

    it("(g) manual `failover set` override never auto-expires", () => {
      // A manual override — null expiry, written directly via the store
      // (mirrors the `clawcode failover set` CLI write).
      const failoverStateStore = new FailoverStateStore({ db });
      failoverStateStore.set("research", "codex-cli", "manual", null);

      // Advance the clock FAR into the future — well past any UTC
      // midnight a threshold-95 row would have expired at.
      vi.useFakeTimers();
      vi.setSystemTime(new Date(Date.now() + 365 * 24 * 3600_000));

      // The manual override is still active.
      expect(
        failoverStateStore.getActiveBackend("research", Date.now()),
      ).toBe("codex-cli");

      // The factory still returns the manual fallback a year later.
      const svc = createLlmRuntimeService(
        makeConfig("research", "anthropic-agent-sdk", ["codex-cli"]),
        { failoverStateReader: failoverStateStore, logger: { info: vi.fn(), warn: vi.fn() } },
      );
      expect(svc).toBeInstanceOf(CodexAgentCli);
    });
  });

  // ── multi-agent ────────────────────────────────────────────────────

  describe("multi-agent", () => {
    it("(h) two agents on the same saturated provider fail over independently", async () => {
      seedTurns(db, "openai", "gpt-5-codex", 5, 20); // $100 → 100%
      seedSaturation(db, "openai");

      // The trial cohort: `research` + `projects`, both on codex-cli
      // with an anthropic fallback chain.
      const agents: FailoverAgentConfig[] = [
        {
          name: "research",
          backend: "codex-cli",
          failoverChain: ["anthropic-agent-sdk"],
        },
        {
          name: "projects",
          backend: "codex-cli",
          failoverChain: ["anthropic-agent-sdk"],
        },
      ];
      const { failoverStateStore, controller } = buildPipeline({ db, agents });

      await controller.tick();

      // TWO distinct failover_state rows — one per agent (PK is `agent`).
      const rows = failoverStateStore.listAll();
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.agent).sort()).toEqual([
        "projects",
        "research",
      ]);
      for (const r of rows) {
        expect(r.active_backend).toBe("anthropic-agent-sdk");
        expect(r.reason).toBe("threshold-95");
      }

      // Both factory calls return the fallback backend independently.
      const researchSvc = createLlmRuntimeService(
        makeConfig("research", "codex-cli", ["anthropic-agent-sdk"]),
        { failoverStateReader: failoverStateStore, logger: { info: vi.fn(), warn: vi.fn() } },
      );
      const projectsSvc = createLlmRuntimeService(
        makeConfig("projects", "codex-cli", ["anthropic-agent-sdk"]),
        { failoverStateReader: failoverStateStore, logger: { info: vi.fn(), warn: vi.fn() } },
      );
      expect(researchSvc).toBeInstanceOf(AnthropicAgentSdkBackend);
      expect(projectsSvc).toBeInstanceOf(AnthropicAgentSdkBackend);
    });
  });
});
