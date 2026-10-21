import { describe, it, expect } from "vitest";
import { formatCostsTable } from "./costs.js";
import type { CostByAgentModel } from "../../usage/types.js";

describe("formatCostsTable", () => {
  it("formats a table with agent, model, tokens, and cost columns", () => {
    const rows: CostByAgentModel[] = [
      { agent: "test-agent", model: "sonnet", tokens_in: 50000, tokens_out: 10000, cost_usd: 0.30 },
      { agent: "test-agent", model: "haiku", tokens_in: 100000, tokens_out: 20000, cost_usd: 0.05 },
    ];

    const output = formatCostsTable(rows);

    expect(output).toContain("Agent");
    expect(output).toContain("Model");
    expect(output).toContain("Tokens In");
    expect(output).toContain("Tokens Out");
    expect(output).toContain("Cost");
    expect(output).toContain("test-agent");
    expect(output).toContain("sonnet");
    expect(output).toContain("haiku");
  });

  it("shows total row at bottom", () => {
    const rows: CostByAgentModel[] = [
      { agent: "agent-a", model: "sonnet", tokens_in: 1000, tokens_out: 500, cost_usd: 0.10 },
      { agent: "agent-b", model: "opus", tokens_in: 2000, tokens_out: 1000, cost_usd: 0.50 },
    ];

    const output = formatCostsTable(rows);
    expect(output).toContain("TOTAL");
    expect(output).toContain("0.60");
  });

  it("handles empty rows gracefully", () => {
    const output = formatCostsTable([]);
    expect(output).toContain("No cost data");
  });

  // ---------------------------------------------------------------------
  // Phase 72 Plan 02 — Category column (CT1-CT5).
  //
  // Image generation cost rows flow through the same `usage_events`
  // SQLite table as token-usage rows. The daemon-side
  // `getCostsByAgentModel` query (Plan 01) selects `category` so the
  // CLI can distinguish image spend from token spend. The CLI table
  // shape mirrors that split: legacy NULL/undefined categories display
  // as "tokens", Phase-72 image rows as "image".
  // ---------------------------------------------------------------------
  it("CT1: header includes 'Category' column when rows have category field", () => {
    const rows: CostByAgentModel[] = [
      { agent: "clawdy", model: "haiku", tokens_in: 150000, tokens_out: 25000, cost_usd: 0.0688, category: "tokens" },
    ];
    const output = formatCostsTable(rows);
    expect(output).toContain("Category");
  });

  it("CT2: rows with category null/undefined display as 'tokens' (back-compat)", () => {
    const rows: CostByAgentModel[] = [
      { agent: "clawdy", model: "haiku", tokens_in: 150000, tokens_out: 25000, cost_usd: 0.0688 },
      { agent: "clawdy", model: "sonnet", tokens_in: 1000, tokens_out: 500, cost_usd: 0.01, category: null },
    ];
    const output = formatCostsTable(rows);
    // Both legacy rows should show "tokens" in the category column.
    const tokensMatches = output.match(/tokens/g) ?? [];
    expect(tokensMatches.length).toBeGreaterThanOrEqual(2);
  });

  it("CT3: rows with category='image' display as 'image' with composite model", () => {
    const rows: CostByAgentModel[] = [
      { agent: "clawdy", model: "openai:gpt-image-1", tokens_in: 0, tokens_out: 0, cost_usd: 0.12, category: "image" },
    ];
    const output = formatCostsTable(rows);
    expect(output).toContain("image");
    expect(output).toContain("openai:gpt-image-1");
  });

  it("CT4: TOTAL row still appears at bottom when rows have category field", () => {
    const rows: CostByAgentModel[] = [
      { agent: "clawdy", model: "haiku", tokens_in: 100000, tokens_out: 20000, cost_usd: 0.05, category: "tokens" },
      { agent: "clawdy", model: "openai:gpt-image-1", tokens_in: 0, tokens_out: 0, cost_usd: 0.12, category: "image" },
    ];
    const output = formatCostsTable(rows);
    expect(output).toContain("TOTAL");
    // 0.05 + 0.12 = 0.17
    expect(output).toContain("0.1700");
  });

  it("CT5: mixed-category breakdown — both token and image rows appear (IMAGE-04)", () => {
    const rows: CostByAgentModel[] = [
      { agent: "clawdy", model: "haiku", tokens_in: 150000, tokens_out: 25000, cost_usd: 0.0688, category: "tokens" },
      { agent: "clawdy", model: "openai:gpt-image-1", tokens_in: 0, tokens_out: 0, cost_usd: 0.12, category: "image" },
      { agent: "clawdy", model: "fal:fal-ai/flux-pro", tokens_in: 0, tokens_out: 0, cost_usd: 0.05, category: "image" },
    ];
    const output = formatCostsTable(rows);
    // All three rows must surface the distinct model identifiers:
    expect(output).toContain("haiku");
    expect(output).toContain("openai:gpt-image-1");
    expect(output).toContain("fal:fal-ai/flux-pro");
    // Categories must be distinguishable in the output:
    expect(output).toMatch(/tokens/);
    expect(output).toMatch(/image/);
  });
});
