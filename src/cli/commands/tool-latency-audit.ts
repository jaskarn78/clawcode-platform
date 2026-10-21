/**
 * Phase 115 Plan 08 T03 — `clawcode tool-latency-audit` CLI.
 *
 * Operator-facing inspection surface for the split-latency methodology
 * audit landed in T01 + the tool_use_rate measurement gate landed in T02.
 *
 * Renders, for each agent (or one filtered):
 *   - tool_use_rate           — fraction of turns with ≥1 tool_use block
 *   - tool_execution_ms_p50   — pure-execution latency (per-tool sum / turn)
 *   - tool_roundtrip_ms_p50   — full wall-clock incl. LLM resume
 *   - parallel_tool_call_rate — fraction of turns with parallel batch ≥2
 *   - subScope6BGate          — gate decision for plan 115-09 sub-scope 6-B
 *
 * Threshold per CONTEXT D-12: <30% tool_use_rate across the fleet
 * → SHIP sub-scope 6-B in plan 115-09; ≥30% → DEFER.
 *
 * IPC route: `tool-latency-audit` (handler in src/manager/daemon.ts).
 *
 * Pinned by static-grep regression:
 *   - "30%"  / "0.30" — threshold provenance (T03 Verification line 364)
 *   - "SHIP" / "DEFER" — gate-decision tokens
 */

import { Command } from "commander";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { ManagerNotRunningError } from "../../shared/errors.js";
import { cliError, cliLog } from "../output.js";

/**
 * D-12 starting threshold — sub-scope 6-B (1h-TTL direct-SDK fast-path) ships
 * when the fleet average tool_use_rate is BELOW this value.
 * Knob, not a constant — plan 115-09 may refine based on Wave-2 data.
 *
 * 30% provenance: starting threshold per CONTEXT D-12. Claude pick, not
 * research-backed.
 */
export const SUB_SCOPE_6B_THRESHOLD = 0.3;

export interface ToolLatencyAuditRow {
  readonly agent: string;
  readonly turnsTotal: number;
  readonly turnsWithTools: number;
  readonly toolUseRate: number;
  readonly toolExecutionMsP50: number | null;
  readonly toolRoundtripMsP50: number | null;
  readonly parallelToolCallRate: number | null;
  readonly subScope6BGate:
    | "below-30%-threshold"     // SHIP (per-agent only, fleet avg may differ)
    | "above-30%-threshold"     // DEFER
    | "no-data";
}

export interface ToolLatencyAuditResponse {
  readonly computed_at: string;
  readonly windowHours: number;
  readonly rows: ReadonlyArray<ToolLatencyAuditRow>;
  readonly fleetGate: {
    readonly fleet_avg_tool_use_rate: number | null;
    readonly threshold: number;
    readonly decision: "ship-6B" | "defer-6B" | "no-signal";
    readonly agentsCounted: number;
  };
}

async function callIpc<T>(
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  try {
    return (await sendIpcRequest(SOCKET_PATH, method, params)) as T;
  } catch (error) {
    if (error instanceof ManagerNotRunningError) {
      cliError("Manager is not running. Start it with: clawcode start-all");
      process.exit(1);
    }
    throw error;
  }
}

function formatPercent(value: number | null): string {
  if (value === null) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

function formatMs(value: number | null): string {
  if (value === null) return "—";
  if (value < 1000) return `${value} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

function renderTable(res: ToolLatencyAuditResponse): string {
  const lines: string[] = [];
  lines.push(
    `Tool-latency audit · computed ${res.computed_at} · window ${res.windowHours}h`,
  );
  lines.push("");
  if (res.rows.length === 0) {
    lines.push("No agent data yet — run a few Discord turns first.");
    return lines.join("\n");
  }

  // Header
  lines.push(
    `${"agent".padEnd(28)}${"turns".padStart(8)}${"tool%".padStart(8)}${"  exec p50".padStart(12)}${"  roundtrip p50".padStart(18)}${"  par%".padStart(8)}${"  6-B gate".padStart(36)}`,
  );
  lines.push("-".repeat(120));

  for (const r of res.rows) {
    lines.push(
      `${r.agent.padEnd(28)}${String(r.turnsTotal).padStart(8)}${formatPercent(r.toolUseRate).padStart(8)}${formatMs(r.toolExecutionMsP50).padStart(12)}${formatMs(r.toolRoundtripMsP50).padStart(18)}${formatPercent(r.parallelToolCallRate).padStart(8)}${`  ${r.subScope6BGate}`.padStart(36)}`,
    );
  }

  lines.push("");
  lines.push("Sub-scope 6-B gate (CONTEXT D-12):");
  if (res.fleetGate.fleet_avg_tool_use_rate === null) {
    lines.push(
      `  fleet avg: — (no signal — agents counted: ${res.fleetGate.agentsCounted})`,
    );
    lines.push(`  decision: ${res.fleetGate.decision.toUpperCase()}`);
  } else {
    const gateValue = formatPercent(res.fleetGate.fleet_avg_tool_use_rate);
    const thresholdValue = formatPercent(res.fleetGate.threshold);
    const decisionUpper =
      res.fleetGate.decision === "ship-6B" ? "SHIP" : "DEFER";
    lines.push(
      `  fleet avg: ${gateValue} (threshold ${thresholdValue}; agents counted: ${res.fleetGate.agentsCounted})`,
    );
    lines.push(`  decision for plan 115-09 sub-scope 6-B: ${decisionUpper}`);
  }
  lines.push("");
  lines.push(
    "Notes: 30% threshold is starting (per D-12); may be refined by plan 115-09.",
  );
  lines.push(
    "  exec p50 is pure tool execution; roundtrip p50 includes LLM resume.",
  );
  lines.push(
    "  par% = fraction of turns with parallel batch (parallel_tool_call_count >= 2).",
  );

  return lines.join("\n");
}

/**
 * Register the `tool-latency-audit` top-level command.
 * Wired in `src/cli/index.ts` at the same level as `tool-cache`.
 */
export function registerToolLatencyAuditCommand(program: Command): void {
  program
    .command("tool-latency-audit")
    .description(
      "Phase 115 sub-scope 17(a/b/c) + 6-A — per-agent tool execution / round-trip latency split + tool_use_rate. Gate decision for plan 115-09 sub-scope 6-B (1h-TTL fast-path SHIP/DEFER).",
    )
    .option("--window-hours <n>", "rolling window in hours", "24")
    .option("--agent <name>", "limit to one agent")
    .option("--json", "Emit JSON instead of human-readable table")
    .action(
      async (opts: {
        windowHours?: string;
        agent?: string;
        json?: boolean;
      }) => {
        try {
          const windowHours = parseInt(opts.windowHours ?? "24", 10);
          if (!Number.isFinite(windowHours) || windowHours < 1) {
            cliError("--window-hours must be a positive integer");
            process.exit(1);
            return;
          }
          const params: Record<string, unknown> = { windowHours };
          if (opts.agent) params.agent = opts.agent;
          const res = await callIpc<ToolLatencyAuditResponse>(
            "tool-latency-audit",
            params,
          );
          if (opts.json) {
            cliLog(JSON.stringify(res, null, 2));
          } else {
            cliLog(renderTable(res));
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          cliError(`Error: ${msg}`);
          process.exit(1);
        }
      },
    );
}
