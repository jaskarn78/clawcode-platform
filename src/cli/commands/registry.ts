/**
 * Quick task 260419-q2z Task 2 — `clawcode registry repair` offline CLI.
 *
 * Trims trailing garbage from a corrupted registry.json and rewrites it via
 * the atomic writeRegistry pipeline from Task 1. Backs up the raw pre-repair
 * bytes to a timestamped `.corrupt-*.bak` alongside the target file.
 *
 * IMPORTANT: this command is OFFLINE-ONLY. It operates on the file directly —
 * no IPC, no daemon round-trip. The daemon may be up (corrupt registry
 * doesn't always crash the daemon) but the repair is safe to run concurrently
 * because Task 1's atomic rename means the daemon never sees a torn write.
 */
import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";

import { writeRegistry } from "../../manager/registry.js";
import type { Registry } from "../../manager/types.js";
import { cliLog, cliError } from "../output.js";

/**
 * Scan `raw` for the FIRST balanced top-level `{...}` object. Returns
 * `{ start, end }` with `end` pointing one past the closing `}`. Returns
 * `null` when no balanced object is found (unrecoverable).
 *
 * Handles string literals (braces inside strings don't affect depth) and
 * JSON-style escape sequences. Exported with `_` prefix for unit testing.
 */
export function _findFirstBalancedObject(
  raw: string,
): { start: number; end: number } | null {
  let start = -1;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "{") {
      start = i;
      break;
    }
    // Skip leading whitespace / other non-object chars.
  }
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth++;
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        return { start, end: i + 1 };
      }
    }
  }

  return null;
}

/**
 * Dependency bag for the repair action. Tests inject spies for log / error /
 * exit / writeBackup / now to assert behavior without real disk I/O.
 */
export interface RegistryRepairDeps {
  log: (msg: string) => void;
  error: (msg: string) => void;
  exit: (code: number) => void;
  readFile: (path: string) => Promise<string>;
  writeRegistryAtomic: (path: string, registry: Registry) => Promise<void>;
  writeBackup: (path: string, raw: string) => Promise<void>;
  now: () => number;
}

/** Production defaults — atomic writes via Task 1's writeRegistry, real fs ops. */
export function buildDefaultRepairDeps(): RegistryRepairDeps {
  return {
    log: cliLog,
    error: cliError,
    exit: (code) => process.exit(code),
    readFile: (path) => fsReadFile(path, "utf-8"),
    writeRegistryAtomic: writeRegistry,
    writeBackup: (path, raw) => fsWriteFile(path, raw, "utf-8"),
    now: () => Date.now(),
  };
}

/**
 * Repair a (possibly) corrupt registry file in-place. Happy-path no-op when
 * the input already parses. Writes a `.corrupt-<timestamp>.bak` sibling
 * holding the raw pre-repair bytes, then rewrites the main path via the
 * atomic writeRegistry pipeline.
 */
export async function repairAction(opts: {
  readonly path: string;
  readonly deps?: RegistryRepairDeps;
}): Promise<void> {
  const deps = opts.deps ?? buildDefaultRepairDeps();
  const path = opts.path;

  const raw = await deps.readFile(path);

  // Fast-path — already valid.
  try {
    JSON.parse(raw);
    deps.log(`no trailing garbage at ${path}`);
    return;
  } catch {
    // Fall through to repair.
  }

  // Scan for the first balanced object.
  const span = _findFirstBalancedObject(raw);
  if (span === null) {
    deps.error(
      `unrecoverable: no balanced JSON object found in ${path}`,
    );
    deps.exit(1);
    return;
  }

  const clean = raw.slice(span.start, span.end);
  let parsed: Registry;
  try {
    parsed = JSON.parse(clean) as Registry;
  } catch {
    deps.error(
      `unrecoverable: first balanced object in ${path} still fails to parse`,
    );
    deps.exit(1);
    return;
  }

  // Backup raw pre-repair bytes with an ISO-ish timestamp suffix.
  const stamp = new Date(deps.now()).toISOString().replace(/[:.]/g, "-");
  const backupPath = `${path}.corrupt-${stamp}.bak`;
  await deps.writeBackup(backupPath, raw);

  // Rewrite via the atomic pipeline.
  await deps.writeRegistryAtomic(path, parsed);

  const trimmed = raw.length - clean.length;
  const entryCount = Array.isArray(parsed.entries) ? parsed.entries.length : 0;
  deps.log(
    `repaired: trimmed ${trimmed} bytes, ${entryCount} entries preserved (backup at ${backupPath})`,
  );
}

/**
 * Register the `registry` command group on the given Commander program.
 * Currently exposes one subcommand: `repair`.
 */
export function registerRegistryCommand(
  program: Command,
  deps: RegistryRepairDeps = buildDefaultRepairDeps(),
): void {
  const root = program
    .command("registry")
    .description("Registry maintenance utilities");

  root
    .command("repair")
    .description(
      "Trim trailing garbage from a corrupted registry.json (offline, direct file)",
    )
    .option(
      "--path <file>",
      "Path to registry.json",
      join(homedir(), ".clawcode", "manager", "registry.json"),
    )
    .action(async (opts: { path: string }) => {
      try {
        await repairAction({ path: opts.path, deps });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        deps.error(`Error: ${msg}`);
        deps.exit(1);
      }
    });
}
