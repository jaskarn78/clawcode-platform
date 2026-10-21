import type { Command } from "commander";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH, REGISTRY_PATH } from "../../manager/daemon.js";
import { readRegistry } from "../../manager/registry.js";
import { ManagerNotRunningError } from "../../shared/errors.js";
import type { RegistryEntry } from "../../manager/types.js";
import type { CreditTelemetryPayload } from "../../ipc/protocol.js";
import { cliLog, cliError } from "../output.js";

// ANSI color codes
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RED_BOLD = "\x1b[1;31m";
const YELLOW = "\x1b[33m";
const ORANGE = "\x1b[38;5;208m";
const DIM = "\x1b[2m";
// Phase 56 Plan 02 — WARM-PATH column colors.
const CYAN = "\x1b[36m";
const GRAY = "\x1b[90m";

/**
 * Zone data for an agent, from IPC heartbeat-status or context-zone-status.
 */
export type ZoneInfo = {
  readonly zone: string;
  readonly fillPercentage: number;
};

/**
 * Phase 124 Plan 04 T-01 — compaction telemetry per agent from
 * heartbeat-status. Surfaced as a single sub-line under each agent row so
 * we keep the column layout stable for existing operator muscle memory.
 */
export type CompactionTelemetry = {
  readonly sessionTokens: number | null;
  readonly lastCompactionAt: string | null;
};

/** Pretty-print compaction telemetry for the human-readable footer. */
export function formatCompactionLine(t: CompactionTelemetry): string {
  const tokens = t.sessionTokens === null ? "?" : t.sessionTokens.toLocaleString();
  const last = t.lastCompactionAt === null ? "never" : t.lastCompactionAt;
  return `${DIM}  tokens: ${tokens}  last compaction: ${last}${RESET}`;
}

/**
 * Colorize a zone name with ANSI escape codes.
 */
function colorizeZone(zone: string, fillPercentage: number): string {
  const pct = Math.round(fillPercentage * 100);
  const label = `${zone} ${pct}%`;
  switch (zone) {
    case "green":
      return `${GREEN}${label}${RESET}`;
    case "yellow":
      return `${YELLOW}${label}${RESET}`;
    case "orange":
      return `${ORANGE}${label}${RESET}`;
    case "red":
      return `${RED}${label}${RESET}`;
    default:
      return label;
  }
}

/**
 * Format a duration in milliseconds to a human-readable uptime string.
 * <60s = "Xs", <60m = "Xm Ys", <24h = "Xh Ym", else "Xd Yh"
 */
export function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1_000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }
  if (hours < 24) {
    return `${hours}h ${minutes % 60}m`;
  }
  return `${days}d ${hours % 24}h`;
}

/**
 * Colorize a status string with ANSI escape codes.
 */
function colorizeStatus(status: string): string {
  switch (status) {
    case "running":
      return `${GREEN}${status}${RESET}`;
    case "stopped":
      return `${DIM}${status}${RESET}`;
    case "crashed":
      return `${RED}${status}${RESET}`;
    case "failed":
      return `${RED_BOLD}${status}${RESET}`;
    case "restarting":
    case "starting":
    case "stopping":
      return `${YELLOW}${status}${RESET}`;
    default:
      return status;
  }
}

/**
 * Phase 56 Plan 02 — format a registry entry's warm-path state for the
 * WARM-PATH column. Pure passthrough from server-emitted fields: the CLI
 * does ZERO threshold computation — the server decides ready/failure and
 * we just render the label. Preserves server-emit invariant (dashboard +
 * CLI + Discord share the same registry source of truth).
 */
export function formatWarmPath(entry: RegistryEntry): string {
  // Legacy entries from pre-Phase-56 registry have no field at all —
  // render a dim dash so the column aligns without implying state.
  if (
    entry.warm_path_readiness_ms === undefined ||
    entry.warm_path_readiness_ms === null
  ) {
    return `${GRAY}\u2014${RESET}`;
  }
  // Warm-path errors are opted-in via lastError prefix so the label fires
  // regardless of overall status (e.g., 'failed' agents still surface the
  // warm-path root cause).
  if (entry.lastError?.startsWith("warm-path:")) {
    const msg = entry.lastError.replace(/^warm-path:\s*/, "").slice(0, 20);
    return `${RED}error: ${msg}${RESET}`;
  }
  if (entry.warm_path_ready === true) {
    const ms = Math.round(entry.warm_path_readiness_ms);
    return `${CYAN}ready ${ms}ms${RESET}`;
  }
  return `${YELLOW}starting${RESET}`;
}

/**
 * Format registry entries as a status table.
 * Columns: NAME, STATUS, UPTIME, RESTARTS, and optionally ZONE + WARM-PATH.
 *
 * @param entries - Registry entries to display
 * @param now - Current timestamp (for testability)
 * @param zones - Optional zone data keyed by agent name
 * @returns Formatted table string
 */
export function formatStatusTable(
  entries: readonly RegistryEntry[],
  now?: number,
  zones?: Readonly<Record<string, ZoneInfo>>,
  telemetry?: Readonly<Record<string, CompactionTelemetry>>,
): string {
  if (entries.length === 0) {
    return "No agents configured";
  }

  const currentTime = now ?? Date.now();
  const hasZones = zones !== undefined && Object.keys(zones).length > 0;
  // Phase 56 Plan 02 — show WARM-PATH column when at least one entry has
  // the readiness timing field present. Legacy registries without the
  // field keep the original 4-column layout unchanged.
  const hasWarmPath = entries.some(
    (e) =>
      e.warm_path_readiness_ms !== undefined &&
      e.warm_path_readiness_ms !== null,
  );

  // Calculate column widths
  const nameWidth = Math.max(4, ...entries.map((e) => e.name.length));
  const statusWidth = Math.max(6, ...entries.map((e) => e.status.length));
  const uptimeWidth = 10;
  const restartsWidth = 8;
  const zoneWidth = 12;
  const warmPathWidth = 20;

  // Header
  const headerParts = [
    "NAME".padEnd(nameWidth),
    "STATUS".padEnd(statusWidth),
    "UPTIME".padEnd(uptimeWidth),
    "RESTARTS".padEnd(restartsWidth),
  ];
  if (hasZones) {
    headerParts.push("ZONE".padEnd(zoneWidth));
  }
  if (hasWarmPath) {
    headerParts.push("WARM-PATH".padEnd(warmPathWidth));
  }
  const header = headerParts.join("  ");

  const separator = "-".repeat(header.length);

  // Rows
  const rows = entries.map((entry) => {
    const uptime =
      entry.status === "running" && entry.startedAt !== null
        ? formatUptime(currentTime - entry.startedAt)
        : "-";

    const rowParts = [
      entry.name.padEnd(nameWidth),
      colorizeStatus(entry.status.padEnd(statusWidth)),
      uptime.padEnd(uptimeWidth),
      String(entry.restartCount).padEnd(restartsWidth),
    ];

    if (hasZones) {
      const zoneData = zones![entry.name];
      if (zoneData) {
        rowParts.push(colorizeZone(zoneData.zone, zoneData.fillPercentage));
      } else {
        rowParts.push(`${DIM}-${RESET}`);
      }
    }

    if (hasWarmPath) {
      rowParts.push(formatWarmPath(entry));
    }

    const mainLine = rowParts.join("  ");
    // Phase 124 Plan 04 T-01 — append per-agent compaction telemetry as a
    // dim sub-line. Skipped when telemetry is unavailable to preserve
    // legacy output for the registry-fallback path.
    const t = telemetry?.[entry.name];
    if (t !== undefined) {
      return `${mainLine}\n${formatCompactionLine(t)}`;
    }
    return mainLine;
  });

  return [header, separator, ...rows].join("\n");
}

// ---------------------------------------------------------------------------
// Phase 138 Plan 02 T-03 — credit-telemetry footer block.
//
// `clawcode status` renders a fleet-level footer AFTER the per-agent rows
// when the daemon supplies a `creditTelemetry` field on the
// `heartbeat-status` IPC response (pre-138 daemons omit it → no footer).
// The footer format is referenced verbatim by Plan 03's alert messages —
// keep it stable.
// ---------------------------------------------------------------------------

/** 8-step unicode block ramp for the ASCII sparkline. */
const SPARK_BLOCKS = "▁▂▃▄▅▆▇█";

/**
 * Downsample a 24-day daily-cost array into an 8-char unicode sparkline.
 * Buckets the 24 samples into 8 groups of 3 days and averages each, then
 * maps the average proportionally onto {@link SPARK_BLOCKS}. An all-zero
 * input (no spend in the window) renders as 8 spaces.
 */
export function renderSparkline(samples: readonly number[]): string {
  const max = Math.max(0, ...samples);
  if (max === 0) return " ".repeat(8);
  const out: string[] = [];
  for (let i = 0; i < 8; i++) {
    const slice = samples.slice(i * 3, i * 3 + 3);
    const avg =
      slice.length > 0
        ? slice.reduce((a, b) => a + b, 0) / slice.length
        : 0;
    const idx = Math.min(7, Math.max(0, Math.floor((avg / max) * 8)));
    out.push(SPARK_BLOCKS[idx]!);
  }
  return out.join("");
}

/**
 * Pick the ANSI color for a usage percentage. Buckets match the dashboard
 * `CreditTelemetryPanel` so the terminal + browser surfaces agree:
 * green < 75, yellow 75-89, orange 90-94, red >= 95.
 */
function pctColor(pct: number): string {
  if (pct >= 95) return RED;
  if (pct >= 90) return ORANGE;
  if (pct >= 75) return YELLOW;
  return GREEN;
}

/**
 * Render the fleet credit-telemetry footer as an array of lines. Returns
 * an empty array when there is nothing to show (no payload, or a payload
 * with zero providers) — the caller appends nothing in that case.
 *
 * Footer shape (one header + one dim sub-line per provider):
 *
 *   ⚖️ Credit telemetry (UTC 2026-05-20):
 *     anthropic   $3.20 / $6.67  (48%)  ▁▂▃▄▅▆▇█  [8 turns, 16000 tokens]
 *     openai      $1.10 / $6.67  (16%)  ▁▂▃▄▅▆▇█  [2 turns, 3200 tokens]
 */
export function renderCreditTelemetry(
  payload: CreditTelemetryPayload | undefined,
): string[] {
  if (!payload || payload.providers.length === 0) return [];

  const lines: string[] = [];
  lines.push(`⚖️ Credit telemetry (UTC ${payload.date}):`);

  // Pad provider names so the columns line up.
  const nameWidth = Math.max(
    ...payload.providers.map((p) => p.provider.length),
  );

  for (const p of payload.providers) {
    const cost = p.cost_usd.toFixed(2);
    const cap = p.cap_usd.toFixed(2);
    const pct = Math.round(p.pct);
    const color = pctColor(p.pct);
    const spark = renderSparkline(p.sparkline);
    const tokens = p.tokens_in + p.tokens_out;
    lines.push(
      `${DIM}  ${p.provider.padEnd(nameWidth)}  ` +
        `$${cost} / $${cap}  ` +
        `${color}(${pct}%)${RESET}${DIM}  ` +
        `${spark}  ` +
        `[${p.turn_count} turns, ${tokens} tokens]${RESET}`,
    );
  }

  return lines;
}

/**
 * Register the `clawcode status` command.
 * Sends a "status" IPC request to the daemon and displays a formatted table.
 * Falls back to reading the registry file directly if daemon is not running.
 */
export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show status of all agents")
    .action(async () => {
      try {
        // Try IPC first
        const result = (await sendIpcRequest(SOCKET_PATH, "status", {})) as {
          entries: readonly RegistryEntry[];
        };

        // Fetch zone data (gracefully degrade if unavailable). Phase 124
        // Plan 04 T-01 — same payload now carries `session_tokens` and
        // `last_compaction_at` per agent; bind them through to the table.
        // Phase 138 Plan 02 T-03 — the same payload also carries the
        // fleet-level `creditTelemetry` field; surface it as a footer.
        let zones: Record<string, ZoneInfo> | undefined;
        let telemetry: Record<string, CompactionTelemetry> | undefined;
        let creditTelemetry: CreditTelemetryPayload | undefined;
        try {
          const heartbeatResult = (await sendIpcRequest(SOCKET_PATH, "heartbeat-status", {})) as {
            agents: Record<string, {
              zone?: string;
              fillPercentage?: number;
              session_tokens?: number | null;
              last_compaction_at?: string | null;
            }>;
            creditTelemetry?: CreditTelemetryPayload;
          };
          zones = {};
          telemetry = {};
          for (const [name, data] of Object.entries(heartbeatResult.agents)) {
            if (data.zone && typeof data.fillPercentage === "number") {
              zones[name] = { zone: data.zone, fillPercentage: data.fillPercentage };
            }
            const hasTokens = "session_tokens" in data;
            const hasLast = "last_compaction_at" in data;
            if (hasTokens || hasLast) {
              telemetry[name] = {
                sessionTokens: data.session_tokens ?? null,
                lastCompactionAt: data.last_compaction_at ?? null,
              };
            }
          }
          if (Object.keys(zones).length === 0) zones = undefined;
          if (Object.keys(telemetry).length === 0) telemetry = undefined;
          // Pre-138 daemons omit `creditTelemetry` → footer is skipped.
          creditTelemetry = heartbeatResult.creditTelemetry;
        } catch {
          // Zone / telemetry data not available -- degrade gracefully
        }

        cliLog(formatStatusTable(result.entries, undefined, zones, telemetry));

        // Phase 138 Plan 02 T-03 — fleet credit-telemetry footer, AFTER
        // the per-agent rows. `renderCreditTelemetry` returns [] when the
        // field is absent (pre-138 daemon) or empty — nothing printed.
        const creditLines = renderCreditTelemetry(creditTelemetry);
        if (creditLines.length > 0) {
          cliLog("");
          cliLog(creditLines.join("\n"));
        }
      } catch (error) {
        if (error instanceof ManagerNotRunningError) {
          // Fallback: try reading registry file directly
          try {
            const registry = await readRegistry(REGISTRY_PATH);
            if (registry.entries.length === 0) {
              cliLog("No agents configured");
            } else {
              cliLog(
                `${DIM}(Manager is not running -- showing last known state)${RESET}\n`,
              );
              cliLog(formatStatusTable(registry.entries));
            }
          } catch {
            cliError(
              "Manager is not running. Start it with: clawcode start-all",
            );
            process.exit(1);
          }
          return;
        }
        const message =
          error instanceof Error ? error.message : String(error);
        cliError(`Error: ${message}`);
        process.exit(1);
      }
    });
}
