/**
 * WS-5 (2026-08-28) — `clawcode secrets {status|invalidate [uri]|refresh [uri]}`.
 *
 * Operator surface for the daemon-side `op://` secret cache (SecretsResolver).
 * The `secrets-status` / `secrets-invalidate` IPC methods have existed since
 * Phase 104 but had no CLI; WS-5 adds the `secrets-refresh` method and this
 * command exposes all three.
 *
 *   status              — counter snapshot. The two numbers that matter for the
 *                         1Password read budget are `op reads` (reads SPENT
 *                         since boot, retries included) and `LKG fresh-served`
 *                         (reads NOT spent — served from last-known-good under
 *                         defaults.secrets.lkgFreshMs).
 *   invalidate [uri]    — drop the in-memory cache entry (or all). NOTE: with
 *                         lkgFreshMs > 0 the next resolve may fresh-serve the
 *                         last-known-good value again — use `refresh` for a
 *                         rotation.
 *   refresh [uri]       — the ROTATION path: drop cache + last-known-good entry
 *                         and read live now. Exit 1 if any refresh failed.
 *
 * Mirrors `clawcode tool-cache` (subcommand layout) and `clawcode
 * broker-status` (IPC call + ManagerNotRunningError handling). SEC-07: no
 * subcommand ever prints a resolved value — only URIs, counters, timestamps
 * and failure reasons.
 */

import type { Command } from "commander";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { ManagerNotRunningError } from "../../shared/errors.js";
import { cliLog, cliError } from "../output.js";
import type {
  SecretsInvalidateResponse,
  SecretsRefreshAllResponse,
  SecretsRefreshOutcomeWire,
  SecretsStatusResponse,
} from "../../ipc/protocol.js";

/** IPC failure branch shared by the invalidate + refresh handlers. */
type IpcRejected = { readonly ok: false; readonly error: string };

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

function isRejected(res: unknown): res is IpcRejected {
  return (
    typeof res === "object" &&
    res !== null &&
    (res as { ok?: unknown }).ok === false &&
    typeof (res as { error?: unknown }).error === "string"
  );
}

/** Render the `secrets-status` snapshot as an aligned key/value block. Pure. */
export function formatSecretsStatus(res: SecretsStatusResponse): string {
  const rows: readonly (readonly [string, string])[] = [
    ["cache entries", String(res.cacheSize)],
    ["hits / misses", `${res.hits} / ${res.misses}`],
    ["op reads", `${res.opReads}  (1Password reads since boot, retries included)`],
    ["LKG fresh-served", `${res.lkgFreshServed}  (served from last-known-good, no op read)`],
    ["env-fallback served", String(res.envFallbackServed)],
    ["stale served", String(res.staleServed)],
    ["retries", String(res.retries)],
    ["rate-limit hits", String(res.rateLimitHits)],
    ["breaker open", res.breakerOpen ? "YES — op reads suppressed" : "no"],
    ["last refreshed", res.lastRefreshedAt ?? "-"],
    ["last failure", res.lastFailureAt ?? "-"],
    ["last failure reason", res.lastFailureReason ?? "-"],
  ];
  const keyW = Math.max(...rows.map(([k]) => k.length));
  return [
    "Secrets cache (daemon)",
    ...rows.map(([k, v]) => `  ${k.padEnd(keyW)}  ${v}`),
  ].join("\n");
}

/** Render one refresh outcome line. Pure. */
export function formatRefreshOutcome(o: SecretsRefreshOutcomeWire): string {
  return o.ok
    ? `✓ ${o.uri} refreshed (live read)`
    : `✗ ${o.uri} FAILED: ${o.reason ?? "unknown reason"}`;
}

/** Render the refresh-all response: one line per URI + a totals line. Pure. */
export function formatRefreshAll(res: SecretsRefreshAllResponse): string {
  if (res.total === 0) {
    return "No secrets held by the daemon — nothing to refresh";
  }
  const lines = res.results.map(formatRefreshOutcome);
  const summary = `refreshed ${res.total - res.failed}/${res.total} live` +
    (res.failed > 0 ? ` (${res.failed} FAILED)` : "");
  return [...lines, "", summary].join("\n");
}

export function registerSecretsCommand(program: Command): void {
  const cmd = program
    .command("secrets")
    .description(
      "Inspect / manage the daemon-side op:// secret cache (1Password read budget)",
    );

  cmd
    .command("status")
    .description(
      "Print cache counters — `op reads` = 1Password reads spent, `LKG fresh-served` = reads avoided",
    )
    .option("--json", "Emit JSON instead of the human-readable block")
    .action(async (opts: { json?: boolean }) => {
      try {
        const res = await callIpc<SecretsStatusResponse>("secrets-status", {});
        cliLog(opts.json ? JSON.stringify(res, null, 2) : formatSecretsStatus(res));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        cliError(`Error: ${msg}`);
        process.exit(1);
      }
    });

  cmd
    .command("invalidate [uri]")
    .description(
      "Drop the in-memory cache entry for [uri] (op://…), or every entry when omitted. " +
        "For a ROTATION use `refresh` — with lkgFreshMs > 0 an invalidated entry can be fresh-served again.",
    )
    .action(async (uri?: string) => {
      try {
        const params: Record<string, unknown> = uri ? { uri } : {};
        const res = await callIpc<SecretsInvalidateResponse | IpcRejected>(
          "secrets-invalidate",
          params,
        );
        if (isRejected(res)) {
          cliError(`Error: ${res.error}`);
          process.exit(1);
          return;
        }
        cliLog(
          res.invalidated === "all"
            ? "invalidated every cached secret (next resolve reads live or fresh-serves LKG)"
            : `invalidated ${res.invalidated}`,
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        cliError(`Error: ${msg}`);
        process.exit(1);
      }
    });

  cmd
    .command("refresh [uri]")
    .description(
      "ROTATION path: drop cache + last-known-good for [uri] (op://…) — or for every secret when omitted — " +
        "and read live now. Exit 1 if any read failed.",
    )
    .action(async (uri?: string) => {
      try {
        const params: Record<string, unknown> = uri ? { uri } : {};
        const res = await callIpc<
          SecretsRefreshOutcomeWire | SecretsRefreshAllResponse | IpcRejected
        >("secrets-refresh", params);
        if (isRejected(res)) {
          cliError(`Error: ${res.error}`);
          process.exit(1);
          return;
        }
        if ("refreshed" in res) {
          cliLog(formatRefreshAll(res));
          if (!res.ok) process.exit(1);
          return;
        }
        cliLog(formatRefreshOutcome(res));
        if (!res.ok) process.exit(1);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        cliError(`Error: ${msg}`);
        process.exit(1);
      }
    });
}
