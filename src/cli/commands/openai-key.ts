/**
 * Phase 69 Plan 03 Task 4 — `clawcode openai-key` CLI subcommand (OPENAI-04).
 *
 * Provides three subcommands:
 *   - `create <agent> [--label X] [--expires 30d|never]` — generates a bearer
 *     key, prints it EXACTLY ONCE to stdout with a security warning, persists
 *     the SHA-256 hash to ~/.clawcode/manager/api-keys.db.
 *   - `list` — tabular view of all keys (label, agent, hash prefix, created,
 *     last used, status). Never prints plaintext.
 *   - `revoke <identifier>` — disable by full key / hex prefix ≥8 / label.
 *
 * IPC-first, direct-DB fallback: when the daemon is up, the CLI delegates
 * via the socket so the already-opened ApiKeysStore handles the write (one
 * writer is safest for SQLite WAL). When the daemon is down (ECONNREFUSED
 * / ENOENT / ManagerNotRunningError), the CLI opens api-keys.db directly
 * — WAL mode + short writes are safe for a quick offline write.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import type { Command } from "commander";

import { sendIpcRequest } from "../../ipc/client.js";
import { ManagerNotRunningError } from "../../shared/errors.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { cliLog, cliError } from "../output.js";
import { ApiKeysStore, type ApiKeyRow } from "../../openai/keys.js";
import type {
  OpenAiKeyCreateRequest,
  OpenAiKeyCreateResponse,
  OpenAiKeyListResponse,
  OpenAiKeyRevokeRequest,
  OpenAiKeyRevokeResponse,
  OpenAiKeyRow,
} from "../../openai/ipc-handlers.js";

const MANAGER_DIR = join(homedir(), ".clawcode", "manager");
const API_KEYS_DB_PATH = join(MANAGER_DIR, "api-keys.db");

// ---------------------------------------------------------------------------
// Duration parsing — "30d" / "6h" / "48h" / "365d" / "never"
// ---------------------------------------------------------------------------

/**
 * Parse a human-friendly duration string into milliseconds.
 * `"never"` returns `null` (no expiry). Invalid input throws.
 */
export function parseDuration(input: string): number | null {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "never" || trimmed === "") return null;
  const match = /^(\d+)\s*([smhd])$/.exec(trimmed);
  if (!match) {
    throw new Error(
      `Invalid --expires value: '${input}'. Use '30d', '6h', '48h', or 'never'.`,
    );
  }
  const n = Number.parseInt(match[1] ?? "", 10);
  const unit = match[2];
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid --expires value: '${input}' (non-positive)`);
  }
  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };
  const mult = multipliers[unit ?? ""];
  if (mult === undefined) {
    throw new Error(`Invalid --expires unit in '${input}'`);
  }
  return n * mult;
}

// ---------------------------------------------------------------------------
// IPC-with-fallback helper
// ---------------------------------------------------------------------------

/**
 * Try IPC first; on `ManagerNotRunningError` or connection-refused codes,
 * fall back to `directCall`. Any other error from the IPC path is re-thrown.
 */
async function ipcThenDirectFallback<T>(
  ipcCall: () => Promise<T>,
  directCall: () => Promise<T> | T,
): Promise<T> {
  try {
    return await ipcCall();
  } catch (err) {
    if (err instanceof ManagerNotRunningError) {
      return await directCall();
    }
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ECONNREFUSED" || code === "ENOENT") {
      return await directCall();
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Table formatter (list subcommand)
// ---------------------------------------------------------------------------

function formatIso(ms: number | null): string {
  if (ms === null) return "—";
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

function computeStatus(row: { disabled_at: number | null; expires_at: number | null }): string {
  if (row.disabled_at !== null) return "disabled";
  if (row.expires_at !== null && row.expires_at <= Date.now()) return "expired";
  return "active";
}

/**
 * Render agent_name for the CLI — the `"*"` sentinel used by scope='all' keys
 * is rendered as "(all)" everywhere end-users see it.
 */
function displayAgent(agentName: string): string {
  return agentName === "*" ? "(all)" : agentName;
}

function renderListTable(rows: ReadonlyArray<OpenAiKeyRow | ApiKeyRow>): string {
  // Quick task 260419-p51 — new "Scope" column between Agent and Hash.
  const header = ["Label", "Agent", "Scope", "Hash", "Created", "Last Used", "Expires", "Status"];
  const data = rows.map((r) => [
    r.label ?? "",
    displayAgent(r.agent_name),
    r.scope,
    r.key_hash.slice(0, 8),
    formatIso(r.created_at),
    formatIso(r.last_used_at),
    formatIso(r.expires_at),
    computeStatus(r),
  ]);
  const allRows = [header, ...data];
  const widths = header.map((_, col) =>
    Math.max(...allRows.map((r) => (r[col] ?? "").length)),
  );
  const sep = "  ";
  const lines = allRows.map((r) =>
    r.map((cell, i) => (cell ?? "").padEnd(widths[i] ?? 0)).join(sep).trimEnd(),
  );
  const divider = widths.map((w) => "-".repeat(w)).join(sep);
  return [lines[0], divider, ...lines.slice(1)].join("\n");
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

/** `create` subcommand — IPC path. Forwards the discriminated-union payload verbatim. */
async function runCreateIpc(
  req: OpenAiKeyCreateRequest,
): Promise<OpenAiKeyCreateResponse> {
  // Pass the union through verbatim — IPC server re-validates with the Zod schema.
  const payload: Record<string, unknown> = {
    label: req.label,
    expiresAt: req.expiresAt,
  };
  if (req.all === true) {
    payload["all"] = true;
  } else {
    payload["agent"] = req.agent;
  }
  const result = await sendIpcRequest(SOCKET_PATH, "openai-key-create", payload);
  return result as OpenAiKeyCreateResponse;
}

/** `create` subcommand — direct DB fallback. Handles both single-agent and --all. */
function runCreateDirect(
  req: OpenAiKeyCreateRequest,
): OpenAiKeyCreateResponse {
  const store = new ApiKeysStore(API_KEYS_DB_PATH);
  try {
    const { key, row } = req.all === true
      ? store.createAllKey({ label: req.label, expiresAt: req.expiresAt })
      : store.createKey(req.agent, { label: req.label, expiresAt: req.expiresAt });
    return {
      key,
      keyHash: row.key_hash,
      agent: row.agent_name,
      label: row.label,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  } finally {
    store.close();
  }
}

/** `list` subcommand — IPC path. */
async function runListIpc(): Promise<OpenAiKeyListResponse> {
  const result = await sendIpcRequest(SOCKET_PATH, "openai-key-list", {});
  return result as OpenAiKeyListResponse;
}

/** `list` subcommand — direct DB fallback. */
function runListDirect(): OpenAiKeyListResponse {
  const store = new ApiKeysStore(API_KEYS_DB_PATH);
  try {
    const rows = store.listKeys();
    return { rows: rows.map((r) => ({ ...r })) };
  } finally {
    store.close();
  }
}

/** `revoke` subcommand — IPC path. */
async function runRevokeIpc(
  req: OpenAiKeyRevokeRequest,
): Promise<OpenAiKeyRevokeResponse> {
  const result = await sendIpcRequest(SOCKET_PATH, "openai-key-revoke", {
    identifier: req.identifier,
  });
  return result as OpenAiKeyRevokeResponse;
}

/** `revoke` subcommand — direct DB fallback (does NOT clear session mappings). */
function runRevokeDirect(
  req: OpenAiKeyRevokeRequest,
): OpenAiKeyRevokeResponse {
  const store = new ApiKeysStore(API_KEYS_DB_PATH);
  try {
    const revoked = store.revokeKey(req.identifier);
    return { revoked };
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// Test-injectable dependency bag
// ---------------------------------------------------------------------------

/** Dependencies for the registered commands. Tests inject mocks here. */
export interface OpenAiKeyCommandDeps {
  runCreate: (req: OpenAiKeyCreateRequest) => Promise<OpenAiKeyCreateResponse>;
  runList: () => Promise<OpenAiKeyListResponse>;
  runRevoke: (req: OpenAiKeyRevokeRequest) => Promise<OpenAiKeyRevokeResponse>;
  log: (message: string) => void;
  error: (message: string) => void;
  exit: (code: number) => void;
}

/** Build the default (production) deps bag — IPC-first, DB fallback. */
export function buildDefaultDeps(): OpenAiKeyCommandDeps {
  return {
    runCreate: (req) =>
      ipcThenDirectFallback(
        () => runCreateIpc(req),
        () => runCreateDirect(req),
      ),
    runList: () =>
      ipcThenDirectFallback(
        () => runListIpc(),
        () => runListDirect(),
      ),
    runRevoke: (req) =>
      ipcThenDirectFallback(
        () => runRevokeIpc(req),
        () => runRevokeDirect(req),
      ),
    log: cliLog,
    error: cliError,
    exit: (code) => process.exit(code),
  };
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function registerOpenAiKeyCommand(
  program: Command,
  deps: OpenAiKeyCommandDeps = buildDefaultDeps(),
): void {
  const root = program
    .command("openai-key")
    .description("Manage bearer keys for the OpenAI-compatible endpoint");

  root
    .command("create [agent]")
    .description(
      "Create a new bearer key. Provide an agent name for a pinned key, or --all for a multi-agent key (prints the key ONCE).",
    )
    .option("--all", "Scope the key to ALL configured agents (P51-MULTI-AGENT-KEY)")
    .option("--label <name>", "Human-readable label (optional)")
    .option("--expires <duration>", "Expiry duration like 30d, 6h, or 'never'", "never")
    .action(
      async (
        agent: string | undefined,
        opts: { all?: boolean; label?: string; expires: string },
      ) => {
        try {
          // Quick task 260419-p51 — mutual exclusion on agent vs --all.
          if (agent && opts.all) {
            deps.error(
              "Error: specify one of <agent> or --all, not both.",
            );
            deps.exit(1);
            return;
          }
          if (!agent && !opts.all) {
            deps.error(
              "Error: specify an <agent> name or pass --all for a multi-agent key.",
            );
            deps.exit(1);
            return;
          }

          let expiresAt: number | undefined;
          const ms = parseDuration(opts.expires);
          if (ms !== null) {
            expiresAt = Date.now() + ms;
          }

          const req: OpenAiKeyCreateRequest = opts.all
            ? { all: true, label: opts.label, expiresAt }
            : { agent: agent as string, label: opts.label, expiresAt };

          const response = await deps.runCreate(req);
          const lines: string[] = [];
          lines.push(`Key:     ${response.key}`);
          // Render the "*" sentinel as "(all)" for end-users.
          lines.push(
            `Agent:   ${response.agent === "*" ? "(all)" : response.agent}`,
          );
          lines.push(`Label:   ${response.label ?? "(none)"}`);
          lines.push(
            `Expires: ${response.expiresAt === null ? "never" : new Date(response.expiresAt).toISOString()}`,
          );
          lines.push(`Hash:    ${response.keyHash.slice(0, 8)}...`);
          lines.push("");
          lines.push("Store this key securely — it will not be shown again.");
          deps.log(lines.join("\n"));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          deps.error(`Error: ${msg}`);
          deps.exit(1);
        }
      },
    );

  root
    .command("list")
    .description("List all bearer keys (never shows plaintext)")
    .action(async () => {
      try {
        const response = await deps.runList();
        if (response.rows.length === 0) {
          deps.log("No keys yet. Create one with `clawcode openai-key create <agent>`.");
          return;
        }
        deps.log(renderListTable(response.rows));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        deps.error(`Error: ${msg}`);
        deps.exit(1);
      }
    });

  root
    .command("revoke <identifier>")
    .description(
      "Revoke a bearer key by full key, 8+ hex-prefix of the hash, or label",
    )
    .action(async (identifier: string) => {
      try {
        const response = await deps.runRevoke({ identifier });
        if (response.revoked) {
          deps.log("Revoked.");
        } else {
          deps.log("No matching key found.");
          deps.exit(1);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        deps.error(`Error: ${msg}`);
        deps.exit(1);
      }
    });
}
