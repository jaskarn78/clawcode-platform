import { describe, it, expect, beforeEach, vi } from "vitest";
import { Command } from "commander";

// Mock the IPC client BEFORE importing the command module so that the
// `sendIpcRequest` reference in latency.ts is the mocked version.
vi.mock("../../../ipc/client.js", () => ({
  sendIpcRequest: vi.fn(),
}));

import {
  registerLatencyCommand,
  formatLatencyTable,
  formatFirstTokenBlock,
} from "../latency.js";
import { sendIpcRequest } from "../../../ipc/client.js";
import type { LatencyReport } from "../../../performance/types.js";

const mockedSendIpcRequest = vi.mocked(sendIpcRequest);

function makeReport() {
  return {
    agent: "alpha",
    since: "2026-04-12T00:00:00.000Z",
    segments: [
      { segment: "end_to_end", p50: 1000, p95: 2000, p99: 3000, count: 10 },
      { segment: "first_token", p50: 400, p95: 800, p99: 1200, count: 10 },
      { segment: "context_assemble", p50: 50, p95: 100, p99: 150, count: 10 },
      { segment: "tool_call", p50: 75, p95: 150, p99: 225, count: 20 },
    ],
  };
}

/**
 * Phase 54 Plan 04 — build a LatencyReport with 6 segments + a first_token
 * headline. Used by the Phase 54 tests below.
 */
function makePhase54Report(
  overrides?: Partial<LatencyReport["first_token_headline"]>,
): LatencyReport {
  return {
    agent: "alpha",
    since: "2026-04-12T00:00:00.000Z",
    segments: [
      {
        segment: "end_to_end",
        p50: 1000,
        p95: 2000,
        p99: 3000,
        count: 10,
        slo_status: "healthy",
        slo_threshold_ms: 6000,
        slo_metric: "p95",
      },
      {
        segment: "first_token",
        p50: 400,
        p95: 800,
        p99: 1200,
        count: 10,
        slo_status: "healthy",
        slo_threshold_ms: 2000,
        slo_metric: "p50",
      },
      {
        segment: "first_visible_token",
        p50: 450,
        p95: 900,
        p99: 1300,
        count: 10,
        slo_threshold_ms: null,
        slo_metric: null,
      },
      {
        segment: "context_assemble",
        p50: 50,
        p95: 100,
        p99: 150,
        count: 10,
        slo_status: "healthy",
        slo_threshold_ms: 300,
        slo_metric: "p95",
      },
      {
        segment: "tool_call",
        p50: 75,
        p95: 150,
        p99: 225,
        count: 20,
        slo_status: "healthy",
        slo_threshold_ms: 1500,
        slo_metric: "p95",
      },
      {
        segment: "typing_indicator",
        p50: 80,
        p95: 200,
        p99: 350,
        count: 15,
        slo_status: "healthy",
        slo_threshold_ms: 500,
        slo_metric: "p95",
      },
    ],
    first_token_headline: {
      p50: 400,
      p95: 800,
      p99: 1200,
      count: 10,
      slo_status: "healthy",
      slo_threshold_ms: 2000,
      slo_metric: "p50",
      ...overrides,
    },
  };
}

describe("clawcode latency", () => {
  let program: Command;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockedSendIpcRequest.mockResolvedValue(makeReport());
    program = new Command();
    program.exitOverride(); // stop commander from process.exit on errors
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    registerLatencyCommand(program);
  });

  it("invokes IPC latency method with agent and since defaulting to 24h", async () => {
    await program.parseAsync(["node", "clawcode", "latency", "alpha"]);
    expect(mockedSendIpcRequest).toHaveBeenCalledWith(
      expect.any(String),
      "latency",
      expect.objectContaining({ agent: "alpha", all: false, since: "24h" }),
    );
  });

  it("passes --since 7d through to IPC", async () => {
    await program.parseAsync(["node", "clawcode", "latency", "alpha", "--since", "7d"]);
    expect(mockedSendIpcRequest).toHaveBeenCalledWith(
      expect.any(String),
      "latency",
      expect.objectContaining({ agent: "alpha", since: "7d" }),
    );
  });

  it("emits json output with --json flag", async () => {
    await program.parseAsync(["node", "clawcode", "latency", "alpha", "--json"]);
    const combined = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    const report = makeReport();
    expect(combined).toContain(JSON.stringify(report, null, 2));
  });

  it("aggregates across all agents with --all flag", async () => {
    await program.parseAsync(["node", "clawcode", "latency", "--all"]);
    expect(mockedSendIpcRequest).toHaveBeenCalledWith(
      expect.any(String),
      "latency",
      expect.objectContaining({ all: true, since: "24h" }),
    );
  });

  it("renders percentile table with four canonical segments", async () => {
    await program.parseAsync(["node", "clawcode", "latency", "alpha"]);
    const combined = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(combined).toContain("end_to_end");
    expect(combined).toContain("first_token");
    expect(combined).toContain("context_assemble");
    expect(combined).toContain("tool_call");
    expect(combined).toMatch(/p50/i);
    expect(combined).toMatch(/p95/i);
    expect(combined).toMatch(/p99/i);
    expect(combined.toLowerCase()).toContain("count");
  });

  it("renders ms unit suffix on numeric cells", async () => {
    await program.parseAsync(["node", "clawcode", "latency", "alpha"]);
    const combined = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(combined).toContain("ms");
  });
});

/**
 * Phase 54 Plan 04 — First Token block + 6-row segments table tests.
 */
describe("clawcode latency — First Token block (Phase 54)", () => {
  it("formatLatencyTable prints a 'First Token Latency' block above the segments table", () => {
    const report = makePhase54Report();
    const out = formatLatencyTable(report);
    const firstTokenIdx = out.indexOf("First Token Latency");
    const tableHeaderIdx = out.indexOf("Latency for alpha");
    expect(firstTokenIdx).toBeGreaterThanOrEqual(0);
    expect(tableHeaderIdx).toBeGreaterThan(firstTokenIdx);
    // The block carries p50/p95/p99 + count
    expect(out).toMatch(/p50:\s*400 ms/);
    expect(out).toMatch(/p95:\s*800 ms/);
    expect(out).toMatch(/p99:\s*1,200 ms/);
    expect(out).toMatch(/count:\s*10/);
  });

  it("formatLatencyTable renders ONLY the segments table when first_token_headline is absent (backward compat)", () => {
    // Pre-Phase-54 shape — no first_token_headline.
    const preReport = makeReport() as unknown as LatencyReport;
    const out = formatLatencyTable(preReport);
    expect(out).not.toContain("First Token Latency");
    expect(out).toContain("Latency for alpha");
  });

  it("tags the First Token line with [BREACH] when slo_status === 'breach'", () => {
    const report = makePhase54Report({ slo_status: "breach", p50: 3000 });
    const out = formatFirstTokenBlock(report);
    expect(out).toContain("[BREACH]");
    expect(out).toContain("3,000 ms");
  });

  it("tags the First Token line with '(warming up — N turns)' when slo_status === 'no_data' (cold start)", () => {
    const report = makePhase54Report({
      slo_status: "no_data",
      count: 3,
      p50: null,
      p95: null,
      p99: null,
    });
    const out = formatFirstTokenBlock(report);
    expect(out).toContain("warming up");
    expect(out).toContain("3 turns");
  });

  it("SEGMENT_DISPLAY_ORDER contains 6 names in CONTEXT Specifics #1 order (renders 6 rows)", () => {
    const report = makePhase54Report();
    const out = formatLatencyTable(report);
    // All 6 canonical segment names appear in the table body.
    expect(out).toContain("end_to_end");
    expect(out).toContain("first_token");
    expect(out).toContain("first_visible_token");
    expect(out).toContain("context_assemble");
    expect(out).toContain("tool_call");
    expect(out).toContain("typing_indicator");
    // Order check: end_to_end before first_token before first_visible_token ...
    const idx = (s: string) => out.indexOf(s);
    expect(idx("end_to_end")).toBeLessThan(idx("first_token"));
    // Use lastIndexOf for first_token so we don't match the First Token block header.
    const firstTokenRowIdx = out.lastIndexOf("first_token");
    const firstVisibleIdx = out.indexOf("first_visible_token");
    expect(firstTokenRowIdx).toBeLessThan(firstVisibleIdx);
    expect(firstVisibleIdx).toBeLessThan(idx("context_assemble"));
    expect(idx("context_assemble")).toBeLessThan(idx("tool_call"));
    expect(idx("tool_call")).toBeLessThan(idx("typing_indicator"));
  });

  it("formatLatencyTable emits 6 data rows (header + separator + 6 rows)", () => {
    const report = makePhase54Report();
    const out = formatLatencyTable(report);
    // Count distinct segment-name rows — each begins with a canonical name.
    const canonical = [
      "end_to_end",
      "first_token",
      "first_visible_token",
      "context_assemble",
      "tool_call",
      "typing_indicator",
    ];
    for (const name of canonical) {
      // Regex anchored with leading space/start to match the data row only,
      // not a JSON key or the First Token header string.
      const rowMatch = out.match(new RegExp(`^${name}\\s`, "m"));
      expect(rowMatch, `row for ${name}`).not.toBeNull();
    }
  });

  it("--json output preserves first_token_headline on the response (raw passthrough)", async () => {
    const report = makePhase54Report();
    mockedSendIpcRequest.mockResolvedValue(report);
    const program = new Command();
    program.exitOverride();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    registerLatencyCommand(program);
    await program.parseAsync([
      "node",
      "clawcode",
      "latency",
      "alpha",
      "--json",
    ]);
    const combined = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(combined).toContain('"first_token_headline"');
    expect(combined).toContain('"slo_status": "healthy"');
    logSpy.mockRestore();
  });

  it("--all output shows the First Token block per agent (each agent's block above its table)", async () => {
    const a = { ...makePhase54Report(), agent: "alpha" };
    const b = { ...makePhase54Report(), agent: "bravo" };
    mockedSendIpcRequest.mockResolvedValue([a, b]);
    const program = new Command();
    program.exitOverride();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    registerLatencyCommand(program);
    await program.parseAsync(["node", "clawcode", "latency", "--all"]);
    const combined = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(combined).toContain("First Token Latency (alpha)");
    expect(combined).toContain("First Token Latency (bravo)");
    // Each table still renders.
    expect(combined).toContain("Latency for alpha");
    expect(combined).toContain("Latency for bravo");
    logSpy.mockRestore();
  });
});
