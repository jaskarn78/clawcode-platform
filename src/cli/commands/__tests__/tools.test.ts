/**
 * Phase 55 Plan 03 — `clawcode tools` CLI formatter tests.
 *
 * Exercises the pure-function formatters (no IPC, no daemon):
 *   - formatToolsTable: headers + column order, [SLOW] sigil on breach rows,
 *     "No tool-call data" empty state.
 *   - formatFleetTools: blank-line separators, empty fleet fallback.
 *   - Command registration: program picks up --since / --all / --json.
 *
 * Mirrors src/cli/commands/__tests__/cache.test.ts in structure.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Command } from "commander";

// Mock the IPC client BEFORE importing the command module so the
// `sendIpcRequest` reference in tools.ts is the mocked version.
vi.mock("../../../ipc/client.js", () => ({
  sendIpcRequest: vi.fn(),
}));

import {
  formatToolsTable,
  formatFleetTools,
  registerToolsCommand,
  type ToolsReport,
  type AugmentedToolRow,
} from "../tools.js";
import { sendIpcRequest } from "../../../ipc/client.js";

const mockedSendIpcRequest = vi.mocked(sendIpcRequest);

function makeRow(overrides: Partial<AugmentedToolRow> = {}): AugmentedToolRow {
  return Object.freeze({
    tool_name: "memory_lookup",
    p50: 80,
    p95: 200,
    p99: 350,
    count: 15,
    slo_status: "healthy" as const,
    slo_threshold_ms: 1500,
    slo_metric: "p95" as const,
    ...overrides,
  });
}

function makeReport(overrides: Partial<ToolsReport> = {}): ToolsReport {
  return Object.freeze({
    agent: "atlas",
    since: "2026-04-13T00:00:00.000Z",
    tools: Object.freeze([
      makeRow({
        tool_name: "search_documents",
        p50: 400,
        p95: 800,
        p99: 1200,
        count: 12,
      }),
      makeRow({
        tool_name: "memory_lookup",
        p50: 80,
        p95: 200,
        p99: 350,
        count: 35,
      }),
    ]),
    ...overrides,
  });
}

describe("formatToolsTable", () => {
  it("renders all 6 column headers in canonical order (Tool / p50 / p95 / p99 / Count / SLO)", () => {
    const out = formatToolsTable(makeReport());
    expect(out).toContain("Tool");
    expect(out).toContain("p50");
    expect(out).toContain("p95");
    expect(out).toContain("p99");
    expect(out).toContain("Count");
    expect(out).toContain("SLO");
  });

  it("renders one data row per tool — slowest first (SQL-layer p95 DESC sort preserved)", () => {
    const out = formatToolsTable(makeReport());
    expect(out).toContain("search_documents");
    expect(out).toContain("memory_lookup");
    // search_documents (p95=800) must appear BEFORE memory_lookup (p95=200).
    const sdIdx = out.indexOf("search_documents");
    const mlIdx = out.indexOf("memory_lookup");
    expect(sdIdx).toBeLessThan(mlIdx);
  });

  it("tags rows with slo_status='breach' using the [SLOW] sigil in the SLO column", () => {
    const breached = makeReport({
      tools: Object.freeze([
        makeRow({ tool_name: "slow_tool", p95: 3000, slo_status: "breach" }),
      ]),
    });
    const out = formatToolsTable(breached);
    expect(out).toContain("[SLOW]");
    expect(out).toContain("slow_tool");
  });

  it("renders 'ok' in the SLO column for healthy rows (no sigil)", () => {
    const healthy = makeReport({
      tools: Object.freeze([
        makeRow({ tool_name: "fast_tool", p95: 50, slo_status: "healthy" }),
      ]),
    });
    const out = formatToolsTable(healthy);
    expect(out).toContain("ok");
    expect(out).not.toContain("[SLOW]");
  });

  it("renders the em-dash placeholder for rows with slo_status='no_data'", () => {
    const empty = makeReport({
      tools: Object.freeze([
        makeRow({ tool_name: "cold_tool", p95: null, count: 0, slo_status: "no_data" }),
      ]),
    });
    const out = formatToolsTable(empty);
    expect(out).toContain("cold_tool");
    expect(out).toContain("—");
  });

  it("renders counts with locale thousand separators", () => {
    const big = makeReport({
      tools: Object.freeze([
        makeRow({ tool_name: "memory_lookup", count: 12345 }),
      ]),
    });
    const out = formatToolsTable(big);
    expect(out).toContain("12,345");
  });

  it("renders 'No tool-call data' when tools array is empty", () => {
    const out = formatToolsTable(makeReport({ tools: Object.freeze([]) }));
    expect(out).toContain("No tool-call data for atlas");
    expect(out).not.toContain("Tool");
  });

  it("renders ms unit suffix on numeric cells", () => {
    const out = formatToolsTable(makeReport());
    expect(out).toContain("ms");
  });

  it("renders the agent name and 'since' window in the header", () => {
    const out = formatToolsTable(
      makeReport({ agent: "beacon", since: "2026-04-12T00:00:00.000Z" }),
    );
    expect(out).toContain("Tool-call latency for beacon");
    expect(out).toContain("2026-04-12T00:00:00.000Z");
  });
});

describe("formatFleetTools", () => {
  it("renders one block per report separated by blank lines", () => {
    const out = formatFleetTools([
      makeReport({ agent: "atlas" }),
      makeReport({ agent: "beacon" }),
    ]);
    expect(out).toContain("Tool-call latency for atlas");
    expect(out).toContain("Tool-call latency for beacon");
    expect(out.split("\n\n").length).toBeGreaterThanOrEqual(2);
  });

  it("renders fallback when reports array is empty", () => {
    const out = formatFleetTools([]);
    expect(out).toBe("No tool-call data for any agent.");
  });

  it("handles a single-element fleet (edge case — --all with one running agent)", () => {
    const out = formatFleetTools([makeReport()]);
    expect(out).toContain("Tool-call latency for atlas");
  });
});

describe("clawcode tools — command registration", () => {
  let program: Command;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockedSendIpcRequest.mockResolvedValue(makeReport());
    program = new Command();
    program.exitOverride();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    registerToolsCommand(program);
  });

  it("exposes a `tools` command with --since / --all / --json options", () => {
    const cmd = program.commands.find((c) => c.name() === "tools");
    expect(cmd).toBeDefined();
    const optionNames = cmd!.options.map((o) => o.long);
    expect(optionNames).toContain("--since");
    expect(optionNames).toContain("--all");
    expect(optionNames).toContain("--json");
  });

  it("invokes IPC tools method with agent and since defaulting to 24h", async () => {
    await program.parseAsync(["node", "clawcode", "tools", "atlas"]);
    expect(mockedSendIpcRequest).toHaveBeenCalledWith(
      expect.any(String),
      "tools",
      expect.objectContaining({ agent: "atlas", all: false, since: "24h" }),
    );
  });

  it("passes --since 7d through to IPC", async () => {
    await program.parseAsync(["node", "clawcode", "tools", "atlas", "--since", "7d"]);
    expect(mockedSendIpcRequest).toHaveBeenCalledWith(
      expect.any(String),
      "tools",
      expect.objectContaining({ agent: "atlas", since: "7d" }),
    );
  });

  it("emits json output with --json flag", async () => {
    await program.parseAsync(["node", "clawcode", "tools", "atlas", "--json"]);
    const combined = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(combined).toContain(JSON.stringify(makeReport(), null, 2));
  });

  it("aggregates across all agents with --all flag", async () => {
    mockedSendIpcRequest.mockResolvedValue([makeReport({ agent: "atlas" }), makeReport({ agent: "beacon" })]);
    await program.parseAsync(["node", "clawcode", "tools", "--all"]);
    expect(mockedSendIpcRequest).toHaveBeenCalledWith(
      expect.any(String),
      "tools",
      expect.objectContaining({ all: true, since: "24h" }),
    );
    const combined = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(combined).toContain("Tool-call latency for atlas");
    expect(combined).toContain("Tool-call latency for beacon");
  });
});
