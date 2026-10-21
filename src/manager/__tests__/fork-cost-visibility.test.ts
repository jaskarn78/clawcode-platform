/**
 * Phase 81 Plan 03 — FORK-02 regression.
 *
 * Proves fork-to-Opus turns surface in `clawcode costs` via
 * UsageTracker.getCostsByAgentModel + formatCostsTable. No budget
 * ceiling enforced. Parameterized over the 4 primary OpenClaw model
 * families (Haiku, Sonnet, MiniMax, Gemini).
 *
 * REGRESSION-ONLY: this plan does NOT modify src/usage/tracker.ts,
 * src/cli/commands/costs.ts, or src/manager/fork.ts. If any assertion
 * here fails in a future refactor, cost-visibility for fork-to-Opus
 * migrated-agent turns has drifted.
 *
 * Phase 81 CONTEXT.md line 40: "After a forked-to-Opus turn, `clawcode
 * costs --agent <name>` returns a row with model matching `opus-*`
 * prefix, non-zero token cost, `agent` column = migrated agent's name."
 *
 * v1.5 forkSession names forks as `<parent>-fork-<nanoid6>`. The
 * UsageTracker row MUST carry that literal fork name in the `agent`
 * column (NOT collapsed to the parent). Phase 74's transient OpenAI
 * endpoint uses `openclaw:<slug>` — that is a different code path and
 * out of scope for this phase.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageTracker } from "../../usage/tracker.js";
import { formatCostsTable } from "../../cli/commands/costs.js";
import type { CostByAgentModel } from "../../usage/types.js";

/**
 * Post-migration model strings. `primary` is what a post-migration
 * UsageEvent.model carries for parent turns. `opus` is what the
 * fork-to-Opus turn carries — always the `claude-opus-*` family
 * (Phase 81 CONTEXT.md line 40 pins the `opus-*` prefix).
 *
 * UsageEvent.model is `string` (not an enum — see src/usage/types.ts:31),
 * so we can record real model ids like `claude-haiku-4-5` on the event
 * even though ResolvedAgentConfig.model is enum-restricted. This mirrors
 * the production path where the SDK records pinned model IDs via
 * resolveModelId().
 */
const PRIMARY_MODELS = [
  { label: "Haiku",   primary: "claude-haiku-4-5",   opus: "claude-opus-4-8" },
  { label: "Sonnet",  primary: "claude-sonnet-4-6",  opus: "claude-opus-4-8" },
  { label: "MiniMax", primary: "minimax-m2",         opus: "claude-opus-4-8" },
  { label: "Gemini",  primary: "gemini-2.5-flash",   opus: "claude-opus-4-8" },
] as const;

describe("Phase 81 FORK-02 — fork-to-Opus cost visibility regression", () => {
  let tmp: string;
  let tracker: UsageTracker;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "p81-fork-cost-"));
    tracker = new UsageTracker(join(tmp, "usage.db"));
  });

  afterEach(() => {
    tracker.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("UsageTracker records fork and parent turns distinctly (getCostsByAgentModel returns 2 rows)", () => {
    tracker.record({
      agent: "migrated-haiku",
      timestamp: "2026-04-21T10:00:00",
      tokens_in: 100,
      tokens_out: 200,
      cost_usd: 0.001,
      turns: 1,
      model: "claude-haiku-4-5",
      duration_ms: 500,
      session_id: "s-parent",
    });
    tracker.record({
      agent: "migrated-haiku-fork-abc123",
      timestamp: "2026-04-21T10:05:00",
      tokens_in: 500,
      tokens_out: 1000,
      cost_usd: 0.05,
      turns: 1,
      model: "claude-opus-4-8",
      duration_ms: 2000,
      session_id: "s-fork",
    });

    const rows = tracker.getCostsByAgentModel(
      "2026-04-21T00:00:00",
      "2026-04-22T00:00:00",
    );
    expect(rows.length).toBe(2);

    const opusRow = rows.find((r) => r.model.startsWith("claude-opus"));
    expect(opusRow).toBeDefined();
    expect(opusRow!.cost_usd).toBeGreaterThan(0);
    expect(opusRow!.cost_usd).toBeCloseTo(0.05);
    expect(opusRow!.tokens_in).toBe(500);
    expect(opusRow!.tokens_out).toBe(1000);
  });

  it("FORK-02 — fork agent column is literal fork name, NOT collapsed to parent", () => {
    tracker.record({
      agent: "migrated-haiku",
      timestamp: "2026-04-21T10:00:00",
      tokens_in: 100,
      tokens_out: 200,
      cost_usd: 0.001,
      turns: 1,
      model: "claude-haiku-4-5",
      duration_ms: 500,
      session_id: "s-parent",
    });
    tracker.record({
      agent: "migrated-haiku-fork-abc123",
      timestamp: "2026-04-21T10:05:00",
      tokens_in: 500,
      tokens_out: 1000,
      cost_usd: 0.05,
      turns: 1,
      model: "claude-opus-4-8",
      duration_ms: 2000,
      session_id: "s-fork",
    });

    const rows = tracker.getCostsByAgentModel(
      "2026-04-21T00:00:00",
      "2026-04-22T00:00:00",
    );
    const opusRows = rows.filter((r) => r.model.startsWith("claude-opus"));
    expect(opusRows.length).toBe(1);
    // The critical invariant: agent column carries the fork name literally.
    // `clawcode costs --agent migrated-haiku-fork-abc123` must return this row.
    expect(opusRows[0]!.agent).toBe("migrated-haiku-fork-abc123");
    expect(opusRows[0]!.agent).not.toBe("migrated-haiku");
  });

  it("FORK-02 — both parent and fork rows retrievable for migrated agent (prefix match)", () => {
    tracker.record({
      agent: "migrated-haiku",
      timestamp: "2026-04-21T10:00:00",
      tokens_in: 100,
      tokens_out: 200,
      cost_usd: 0.001,
      turns: 1,
      model: "claude-haiku-4-5",
      duration_ms: 500,
      session_id: "s-parent",
    });
    tracker.record({
      agent: "migrated-haiku-fork-abc123",
      timestamp: "2026-04-21T10:05:00",
      tokens_in: 500,
      tokens_out: 1000,
      cost_usd: 0.05,
      turns: 1,
      model: "claude-opus-4-8",
      duration_ms: 2000,
      session_id: "s-fork",
    });

    const rows = tracker.getCostsByAgentModel(
      "2026-04-21T00:00:00",
      "2026-04-22T00:00:00",
    );
    const agentPrefix = rows.filter((r) => r.agent.startsWith("migrated-haiku"));
    expect(agentPrefix.length).toBe(2);

    // Verify distinct (agent, model) tuples — the GROUP BY in
    // tracker.ts:249 guarantees uniqueness over (agent, model, category).
    const tuples = new Set(agentPrefix.map((r) => `${r.agent}|${r.model}`));
    expect(tuples.size).toBe(2);
  });

  it("formatCostsTable renders both parent and fork rows with TOTAL", () => {
    const synthetic: CostByAgentModel[] = [
      {
        agent: "migrated-haiku",
        category: "tokens",
        model: "claude-haiku-4-5",
        tokens_in: 100,
        tokens_out: 200,
        cost_usd: 0.001,
      },
      {
        agent: "migrated-haiku-fork-abc123",
        category: "tokens",
        model: "claude-opus-4-8",
        tokens_in: 500,
        tokens_out: 1000,
        cost_usd: 0.05,
      },
    ];
    const out = formatCostsTable(synthetic);
    // Both parent and fork agent names must be present in rendered output.
    expect(out).toContain("migrated-haiku");
    expect(out).toContain("migrated-haiku-fork-abc123");
    // Both model strings must be rendered as-is (opus prefix visible to operator).
    expect(out).toContain("claude-haiku-4-5");
    expect(out).toContain("claude-opus-4-8");
    // TOTAL row pinned — formatCostsTable appends a totals row (costs.ts:39).
    expect(out).toContain("TOTAL");
    // Dollar-formatted costs visible.
    expect(out).toContain("$0.0010");
    expect(out).toContain("$0.0500");
  });

  it("no budget ceiling — UsageTracker source has no BudgetExceededError / canEscalate references (grep-verified)", () => {
    // FORK-02 invariant: the UsageTracker.record path has NO budget-gate
    // integration. Budget enforcement lives in src/manager/escalation.ts
    // (EscalationMonitor.escalate, lines 110-120) and is only armed when
    // budgetOptions is explicitly passed — migrated agents have
    // escalationBudget:undefined → no budgetConfigs → gate never fires.
    //
    // This static-grep regression pins the invariant against drift: if a
    // future refactor adds budget checks into tracker.ts, this test fails
    // and forces explicit consideration of the migrated-agent ceiling.
    const trackerSource = readFileSync("src/usage/tracker.ts", "utf8");
    expect(trackerSource).not.toMatch(/BudgetExceededError/);
    expect(trackerSource).not.toMatch(/canEscalate/);
  });

  for (const { label, primary, opus } of PRIMARY_MODELS) {
    it(`[${label}] parent (${primary}) + fork (${opus}) rows surface via getCostsByAgentModel`, () => {
      const parent = `migrated-${label.toLowerCase()}`;
      const fork = `${parent}-fork-xyz789`;

      tracker.record({
        agent: parent,
        timestamp: "2026-04-21T10:00:00",
        tokens_in: 100,
        tokens_out: 200,
        cost_usd: 0.001,
        turns: 1,
        model: primary,
        duration_ms: 500,
        session_id: `s-parent-${label}`,
      });
      tracker.record({
        agent: fork,
        timestamp: "2026-04-21T10:05:00",
        tokens_in: 500,
        tokens_out: 1000,
        cost_usd: 0.05,
        turns: 1,
        model: opus,
        duration_ms: 2000,
        session_id: `s-fork-${label}`,
      });

      const rows = tracker.getCostsByAgentModel(
        "2026-04-21T00:00:00",
        "2026-04-22T00:00:00",
      );
      const found = rows.filter((r) => r.agent === parent || r.agent === fork);
      expect(found.length).toBe(2);

      // The fork row carries an opus-prefix model regardless of primary.
      const forkRow = found.find((r) => r.agent === fork);
      expect(forkRow).toBeDefined();
      expect(forkRow!.model).toBe(opus);
      expect(forkRow!.model.startsWith("claude-opus")).toBe(true);
      expect(forkRow!.cost_usd).toBeCloseTo(0.05);
    });
  }

  it("Phase 74 alternate contract — v1.5 persistent fork does NOT use 'openclaw:<slug>' agent shape", () => {
    // Phase 74's transient-routing code path records agent='openclaw:<slug>'
    // for the OpenAI-compatible endpoint transient sessions. This plan
    // tests the v1.5 persistent fork path, which uses the literal
    // `<parent>-fork-<id>` name. Pinned here so a future refactor doesn't
    // silently collapse fork rows into the Phase 74 shape.
    tracker.record({
      agent: "migrated-haiku-fork-zzz123",
      timestamp: "2026-04-21T11:00:00",
      tokens_in: 10,
      tokens_out: 20,
      cost_usd: 0.0002,
      turns: 1,
      model: "claude-opus-4-8",
      duration_ms: 300,
      session_id: "s-z",
    });

    const rows = tracker.getCostsByAgentModel(
      "2026-04-21T00:00:00",
      "2026-04-22T00:00:00",
    );
    for (const r of rows) {
      expect(r.agent.startsWith("openclaw:")).toBe(false);
    }
    // The fork row carries the v1.5 literal fork name.
    expect(rows.some((r) => r.agent === "migrated-haiku-fork-zzz123")).toBe(true);
  });

  it("getCostsByAgentModel returns distinct (agent, model) pairs for parameterized fleet", () => {
    // Simulate the full 4-primary fleet + forks in a single DB.
    for (const { label, primary, opus } of PRIMARY_MODELS) {
      const parent = `migrated-${label.toLowerCase()}`;
      tracker.record({
        agent: parent,
        timestamp: "2026-04-21T10:00:00",
        tokens_in: 50,
        tokens_out: 100,
        cost_usd: 0.001,
        turns: 1,
        model: primary,
        duration_ms: 200,
        session_id: `s-p-${label}`,
      });
      tracker.record({
        agent: `${parent}-fork-${label.toLowerCase().slice(0, 6)}`,
        timestamp: "2026-04-21T10:05:00",
        tokens_in: 200,
        tokens_out: 400,
        cost_usd: 0.02,
        turns: 1,
        model: opus,
        duration_ms: 1000,
        session_id: `s-f-${label}`,
      });
    }

    const rows = tracker.getCostsByAgentModel(
      "2026-04-21T00:00:00",
      "2026-04-22T00:00:00",
    );
    // 4 parents + 4 forks = 8 distinct (agent, model) tuples
    expect(rows.length).toBe(8);

    // 4 fork rows all carry opus-prefix model
    const forkRows = rows.filter((r) => r.agent.includes("-fork-"));
    expect(forkRows.length).toBe(4);
    for (const r of forkRows) {
      expect(r.model.startsWith("claude-opus")).toBe(true);
    }

    // formatCostsTable renders the full fleet with TOTAL
    const table = formatCostsTable(rows);
    expect(table).toContain("TOTAL");
    for (const { label } of PRIMARY_MODELS) {
      expect(table).toContain(`migrated-${label.toLowerCase()}`);
    }
  });
});
