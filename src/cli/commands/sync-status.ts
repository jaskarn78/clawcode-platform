/**
 * Phase 91 Plan 04 — `clawcode sync status` subcommand.
 *
 * Reads `~/.clawcode/manager/sync-state.json` + tails the last JSONL cycle
 * from `~/.clawcode/manager/sync.jsonl` and emits a human/machine-parseable
 * summary on stdout. Exits 0 in ALL normal cases (including missing state,
 * missing log) — `status` is informational, it never signals failure.
 *
 * Output shape (JSON, always):
 *
 *   {
 *     "authoritativeSide": "openclaw",
 *     "lastSyncedAt": "2026-04-24T19:30:00.000Z",
 *     "conflictCount": 0,
 *     "conflicts": [ { "path": "...", "detectedAt": "..." } ],
 *     "lastCycle": { "cycleId": "...", "status": "synced", ... } | null
 *   }
 *
 * Consumed by:
 *   - Operators running the command directly (pipe to jq)
 *   - Plan 91-05 `/clawcode-sync-status` Discord slash (reads state via the
 *     same sync-state-store reader, not this CLI output)
 *
 * Exit codes:
 *   0 — always (informational)
 */
import type { Command } from "commander";
import { readFile } from "node:fs/promises";
import pino from "pino";
import type { Logger } from "pino";
import {
  DEFAULT_SYNC_JSONL_PATH,
  DEFAULT_SYNC_STATE_PATH,
  readSyncState,
} from "../../sync/sync-state-store.js";
import { DEPRECATION_ROLLBACK_WINDOW_MS } from "../../sync/types.js";
import { cliLog } from "../output.js";

export type RunSyncStatusArgs = Readonly<{
  syncStatePath?: string;
  syncJsonlPath?: string;
  log?: Logger;
  /** DI — override readFile for hermetic tests. */
  readFileImpl?: typeof readFile;
  /** DI — override the clock for deterministic rollback-window math (Phase 96 D-11). */
  now?: () => Date;
}>;

/**
 * Read sync state + last JSONL entry; emit a summary JSON on stdout.
 * Returns the CLI exit code so tests can assert without spawning subprocesses.
 */
export async function runSyncStatusAction(
  args: RunSyncStatusArgs,
): Promise<number> {
  const log: Logger =
    args.log ?? (pino({ level: "warn" }) as unknown as Logger);
  const statePath = args.syncStatePath ?? DEFAULT_SYNC_STATE_PATH;
  const jsonlPath = args.syncJsonlPath ?? DEFAULT_SYNC_JSONL_PATH;
  const readImpl = args.readFileImpl ?? readFile;

  const state = await readSyncState(statePath, log);

  // Tail the last JSONL line — defensively, since the log may not exist
  // yet on a fresh install (first sync hasn't run).
  let lastCycle: unknown = null;
  try {
    const raw = await readImpl(jsonlPath, "utf8");
    const text: string = typeof raw === "string" ? raw : String(raw);
    const lines = text.split("\n").filter((l: string) => l.trim().length > 0);
    if (lines.length > 0) {
      const last = lines[lines.length - 1];
      if (last !== undefined) {
        try {
          lastCycle = JSON.parse(last);
        } catch {
          // Malformed last line — operators' concern, not ours; leave null.
        }
      }
    }
  } catch {
    // ENOENT / read error — first-boot path, silent.
  }

  // Phase 96 D-11 — when authoritativeSide=deprecated, compute rollback
  // window remaining (or "EXPIRED") for operator visibility. Math.ceil so
  // 6.x days remaining renders as "7 days" (round up) — matches the
  // operator-friendly framing.
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  let deprecationBlock: {
    deprecatedAt: string | null;
    rollbackWindow: string;
  } | null = null;
  if (state.authoritativeSide === "deprecated") {
    const now = args.now?.() ?? new Date();
    const deprecatedAt = state.deprecatedAt ?? null;
    let rollbackWindow = "(unknown — deprecatedAt missing)";
    if (deprecatedAt !== null) {
      const elapsedMs = now.getTime() - new Date(deprecatedAt).getTime();
      const remainingMs = DEPRECATION_ROLLBACK_WINDOW_MS - elapsedMs;
      if (remainingMs > 0) {
        const days = Math.ceil(remainingMs / ONE_DAY_MS);
        rollbackWindow = `${days} days remaining`;
      } else {
        rollbackWindow = "EXPIRED";
      }
    }
    deprecationBlock = { deprecatedAt, rollbackWindow };
  }

  const summary = {
    authoritativeSide: state.authoritativeSide,
    ...(deprecationBlock !== null
      ? {
          deprecation: {
            deprecatedAt: deprecationBlock.deprecatedAt,
            // Human-readable phrase containing literal "rollback window: N days remaining"
            // so operators (and tests) see the window math at a glance. Phase 96 D-11.
            "rollback window": deprecationBlock.rollbackWindow,
          },
        }
      : {}),
    lastSyncedAt: state.lastSyncedAt,
    openClawHost: state.openClawHost,
    openClawWorkspace: state.openClawWorkspace,
    clawcodeWorkspace: state.clawcodeWorkspace,
    conflictCount: state.conflicts.filter((c) => c.resolvedAt === null).length,
    conflicts: state.conflicts
      .filter((c) => c.resolvedAt === null)
      .map((c) => ({
        path: c.path,
        detectedAt: c.detectedAt,
        sourceHash: c.sourceHash.slice(0, 12),
        destHash: c.destHash.slice(0, 12),
      })),
    perFileHashCount: Object.keys(state.perFileHashes).length,
    lastCycle,
  };

  cliLog(JSON.stringify(summary, null, 2));
  return 0;
}

export function registerSyncStatusCommand(parent: Command): void {
  parent
    .command("status")
    .description(
      "Print sync-state.json summary + last sync.jsonl cycle (JSON output)",
    )
    .action(async () => {
      const code = await runSyncStatusAction({});
      process.exit(code);
    });
}
