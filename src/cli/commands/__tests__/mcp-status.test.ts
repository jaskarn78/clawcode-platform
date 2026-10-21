/**
 * Phase 85 Plan 03 — `clawcode mcp-status` CLI subcommand tests.
 *
 * Pure-function tests for the table formatter + a registration test that
 * confirms commander picks up the new subcommand with its --agent option.
 *
 * Note on naming deviation (Rule 3 — blocking):
 *   The plan called for `clawcode tools`, but `src/cli/commands/tools.ts`
 *   already exists (Phase 55 — per-tool call latency with p50/p95/p99 SLO
 *   reporting). Reusing that name would delete the Phase 55 feature.
 *   The subcommand ships as `clawcode mcp-status` — parallels the existing
 *   `mcp-servers` command and keeps a clear namespace.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Command } from "commander";

vi.mock("../../../ipc/client.js", () => ({
  sendIpcRequest: vi.fn(),
}));

import {
  formatMcpStatusTable,
  registerMcpStatusCommand,
  type McpStatusResponse,
} from "../mcp-status.js";
import { sendIpcRequest } from "../../../ipc/client.js";

const mockedSendIpcRequest = vi.mocked(sendIpcRequest);

describe("formatMcpStatusTable", () => {
  it("returns 'No MCP servers configured for x' on empty servers", () => {
    const out = formatMcpStatusTable({ agent: "x", servers: [] });
    expect(out).toBe("No MCP servers configured for x");
  });

  it("renders a 6-column table (AGENT / SERVER / STATUS / LAST SUCCESS / FAILURES / LAST ERROR) with one row per server", () => {
    const now = Date.now();
    const resp: McpStatusResponse = {
      agent: "clawdy",
      servers: [
        {
          name: "1password",
          status: "ready",
          lastSuccessAt: now - 12_000,
          lastFailureAt: null,
          failureCount: 0,
          optional: false,
          lastError: null,
        },
        {
          name: "browser",
          status: "degraded",
          lastSuccessAt: now - 60_000,
          lastFailureAt: now - 1_000,
          failureCount: 1,
          optional: false,
          lastError: "rpc timeout",
        },
        {
          name: "search",
          status: "failed",
          lastSuccessAt: null,
          lastFailureAt: now,
          failureCount: 3,
          optional: false,
          lastError: "Failed to start: ENOENT",
        },
      ],
    };
    const out = formatMcpStatusTable(resp, now);
    // Headers present.
    expect(out).toContain("AGENT");
    expect(out).toContain("SERVER");
    expect(out).toContain("STATUS");
    expect(out).toContain("LAST SUCCESS");
    expect(out).toContain("FAILURES");
    expect(out).toContain("LAST ERROR");
    // Verbatim status strings (no rewording).
    expect(out).toContain("ready");
    expect(out).toContain("degraded");
    expect(out).toContain("failed");
    // Exactly 3 data rows (header + separator + 3 data rows = 5 lines).
    const lines = out.split("\n");
    // Header + separator + 3 data rows = 5 non-empty lines.
    expect(lines.filter((l) => l.length > 0)).toHaveLength(5);
  });

  it("TOOL-04 CLI end-to-end — renders verbatim lastError text in the last-error column", () => {
    const out = formatMcpStatusTable({
      agent: "clawdy",
      servers: [
        {
          name: "search",
          status: "failed",
          lastSuccessAt: null,
          lastFailureAt: Date.now(),
          failureCount: 3,
          optional: false,
          lastError: "Failed to start: ENOENT",
        },
      ],
    });
    expect(out).toContain("Failed to start: ENOENT");
  });

  it("renders relative last-success timestamps (1m ago for 65 seconds back)", () => {
    const now = Date.now();
    const out = formatMcpStatusTable(
      {
        agent: "clawdy",
        servers: [
          {
            name: "1password",
            status: "ready",
            lastSuccessAt: now - 65_000,
            lastFailureAt: null,
            failureCount: 0,
            optional: false,
            lastError: null,
          },
        ],
      },
      now,
    );
    expect(out).toContain("1m ago");
  });

  it("renders 'never' when lastSuccessAt is null", () => {
    const out = formatMcpStatusTable({
      agent: "clawdy",
      servers: [
        {
          name: "search",
          status: "failed",
          lastSuccessAt: null,
          lastFailureAt: Date.now(),
          failureCount: 3,
          optional: false,
          lastError: "boom",
        },
      ],
    });
    expect(out).toContain("never");
  });

  it("annotates optional servers with '(opt)' suffix in the SERVER column", () => {
    const out = formatMcpStatusTable({
      agent: "clawdy",
      servers: [
        {
          name: "image",
          status: "failed",
          lastSuccessAt: null,
          lastFailureAt: Date.now(),
          failureCount: 1,
          optional: true,
          lastError: "no api key",
        },
      ],
    });
    expect(out).toContain("image (opt)");
  });
});

// ----------------------------------------------------------------------
// Phase 94 Plan 07 — capability-probe column tests + cross-renderer parity
// ----------------------------------------------------------------------

describe("Phase 94 Plan 07 — formatMcpStatusTable capability probe column", () => {
  it("CLI-CAP-EMOJI — surfaces all 5 capability-probe status emojis (✅ 🟡 ⏳ 🔴 ⚪) when the IPC payload carries one of each", () => {
    const now = Date.now();
    const lastGoodIso = new Date(now - 60_000).toISOString();
    const out = formatMcpStatusTable(
      {
        agent: "clawdy",
        servers: [
          {
            name: "ready-srv",
            status: "ready",
            lastSuccessAt: now,
            lastFailureAt: null,
            failureCount: 0,
            optional: false,
            lastError: null,
            capabilityProbe: { lastRunAt: new Date(now).toISOString(), status: "ready", lastSuccessAt: lastGoodIso },
          },
          {
            name: "degraded-srv",
            status: "degraded",
            lastSuccessAt: now - 60_000,
            lastFailureAt: now - 1_000,
            failureCount: 1,
            optional: false,
            lastError: "rpc timeout",
            capabilityProbe: { lastRunAt: new Date(now).toISOString(), status: "degraded", error: "rpc timeout", lastSuccessAt: lastGoodIso },
          },
          {
            name: "reconn-srv",
            status: "reconnecting",
            lastSuccessAt: null,
            lastFailureAt: now,
            failureCount: 2,
            optional: false,
            lastError: "transient",
            capabilityProbe: { lastRunAt: new Date(now).toISOString(), status: "reconnecting", error: "transient" },
          },
          {
            name: "failed-srv",
            status: "failed",
            lastSuccessAt: null,
            lastFailureAt: now,
            failureCount: 5,
            optional: false,
            lastError: "process down",
            capabilityProbe: { lastRunAt: new Date(now).toISOString(), status: "failed", error: "process down" },
          },
          {
            name: "unknown-srv",
            status: "ready",
            lastSuccessAt: now,
            lastFailureAt: null,
            failureCount: 0,
            optional: false,
            lastError: null,
            // capabilityProbe omitted → unknown emoji ⚪
          },
        ],
      },
      now,
    );
    // Each emoji must appear in the rendered table.
    expect(out).toContain("\u2705"); // ✅ ready
    expect(out).toContain("\u{1F7E1}"); // 🟡 degraded
    expect(out).toContain("\u23F3"); // ⏳ reconnecting
    expect(out).toContain("\u{1F534}"); // 🔴 failed
    expect(out).toContain("\u26AA"); // ⚪ unknown
  });

  it("renders 'Healthy alternatives:' line for a degraded server with cross-agent alternatives + the recovery suggestion for the Playwright pattern", () => {
    const now = Date.now();
    const out = formatMcpStatusTable(
      {
        agent: "fin-tax",
        servers: [
          {
            name: "browser",
            status: "degraded",
            lastSuccessAt: now - 60_000,
            lastFailureAt: now - 1_000,
            failureCount: 1,
            optional: false,
            lastError: "Executable doesn't exist at /home/clawcode/.cache/ms-playwright/chromium-1187/chrome-linux/chrome",
            capabilityProbe: {
              lastRunAt: new Date(now).toISOString(),
              status: "degraded",
              error: "Executable doesn't exist at /home/clawcode/.cache/ms-playwright/chromium-1187/chrome-linux/chrome",
              lastSuccessAt: new Date(now - 3_600_000).toISOString(),
            },
            alternatives: ["fin-client", "general"],
          },
        ],
      },
      now,
    );
    expect(out).toContain("Healthy alternatives:");
    expect(out).toContain("fin-client");
    expect(out).toContain("general");
    expect(out).toContain("auto-recovery: npx playwright install chromium");
  });

  it("does NOT render the alternatives line for a ready server even when the IPC payload carries them", () => {
    const now = Date.now();
    const out = formatMcpStatusTable(
      {
        agent: "clawdy",
        servers: [
          {
            name: "browser",
            status: "ready",
            lastSuccessAt: now - 5_000,
            lastFailureAt: null,
            failureCount: 0,
            optional: false,
            lastError: null,
            capabilityProbe: {
              lastRunAt: new Date(now).toISOString(),
              status: "ready",
              lastSuccessAt: new Date(now - 5_000).toISOString(),
            },
            alternatives: ["fin-client", "general"],
          },
        ],
      },
      now,
    );
    expect(out).not.toContain("Healthy alternatives");
  });
});

describe("Phase 94 Plan 07 — REG-SINGLE-DATA-SOURCE static-grep regression", () => {
  it("/clawcode-tools and mcp-status both read only from list-mcp-status IPC (no second cache or jsonl source)", async () => {
    const fs = await import("node:fs");
    const slashContent = fs.readFileSync("src/discord/slash-commands.ts", "utf8");
    const cliContent = fs.readFileSync("src/cli/commands/mcp-status.ts", "utf8");
    // Both must reference the IPC method.
    expect(slashContent).toMatch(/["']list-mcp-status["']/);
    expect(cliContent).toMatch(/["']list-mcp-status["']/);
    // Neither must read mcp-probe-state.jsonl directly (post-incident
    // analysis ledger is NOT a real-time UI source).
    expect(slashContent).not.toContain("mcp-probe-state.jsonl");
    expect(cliContent).not.toContain("mcp-probe-state.jsonl");
  });
});

describe("Phase 94 Plan 07 — CLI-EMBED-PARITY cross-renderer content equivalence", () => {
  it("CLI text output and Discord buildProbeRow output share the same per-server content (server name, status, last-good ISO, alternatives) for the same snapshot", async () => {
    const now = Date.now();
    const nowDate = new Date(now);
    const lastGoodIso = new Date(now - 30_000).toISOString();
    const snapshot: McpStatusResponse = {
      agent: "clawdy",
      servers: [
        {
          name: "browser",
          status: "degraded",
          lastSuccessAt: now - 30_000,
          lastFailureAt: now - 1_000,
          failureCount: 2,
          optional: false,
          lastError: "rpc timeout",
          capabilityProbe: {
            lastRunAt: new Date(now).toISOString(),
            status: "degraded",
            error: "rpc timeout",
            lastSuccessAt: lastGoodIso,
          },
          alternatives: ["fin-client"],
        },
        {
          name: "1password",
          status: "ready",
          lastSuccessAt: now - 5_000,
          lastFailureAt: null,
          failureCount: 0,
          optional: false,
          lastError: null,
          capabilityProbe: {
            lastRunAt: new Date(now).toISOString(),
            status: "ready",
            lastSuccessAt: new Date(now - 5_000).toISOString(),
          },
          alternatives: [],
        },
      ],
    };
    const cliOut = formatMcpStatusTable(snapshot, now);

    // Render the embed-side via the same shared helper the slash uses.
    const { buildProbeRow } = await import("../../../manager/probe-renderer.js");
    const embedRows = snapshot.servers.map((s) =>
      buildProbeRow(
        s.name,
        { capabilityProbe: s.capabilityProbe },
        s.alternatives ?? [],
        nowDate,
      ),
    );

    // Per-server content equivalence: every meaningful field a row carries
    // should also appear in the CLI output.
    for (const row of embedRows) {
      // Server name.
      expect(cliOut).toContain(row.serverName);
      // Status text.
      expect(cliOut).toContain(row.status);
      // Status emoji parity.
      expect(cliOut).toContain(row.statusEmoji);
      // Last-good ISO appears only for non-ready (gates the detail block) but
      // the CLI table also surfaces ISO via the detail block when present.
      if (row.lastSuccessIso && row.status !== "ready") {
        expect(cliOut).toContain(row.lastSuccessIso);
      }
      // Alternatives only surface for non-ready servers.
      for (const alt of row.alternatives) {
        expect(cliOut).toContain(alt);
      }
    }
  });
});

describe("registerMcpStatusCommand", () => {
  let program: Command;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    registerMcpStatusCommand(program);
  });

  it("registers a 'mcp-status' command with a required --agent / -a option", () => {
    const cmd = program.commands.find((c) => c.name() === "mcp-status");
    expect(cmd).toBeDefined();
    const optionLongs = cmd!.options.map((o) => o.long);
    expect(optionLongs).toContain("--agent");
    const agentOpt = cmd!.options.find((o) => o.long === "--agent");
    expect(agentOpt).toBeDefined();
    expect(agentOpt!.required).toBe(true);
  });
});
