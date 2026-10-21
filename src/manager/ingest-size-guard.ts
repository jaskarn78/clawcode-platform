/**
 * Input file-size guard for the `ingest-document` IPC handler (C2 — partial
 * mitigation of the OOM fleet-kill).
 *
 * SCOPE (honest): this bounds a single pathological ingest — a runaway
 * multi-GB input file that would be read/decoded wholesale and balloon process
 * RSS. It does NOT bound cumulative RSS growth across a bulk-ingest session
 * (the actual 12–20GB blow-up that trips cgroup OOM). The fleet-kill itself is
 * a systemd policy issue (`OOMPolicy=stop` → SIGTERMs all agents) and is fixed
 * operator-side via `OOMPolicy=continue` + `MemoryMax` review (see RUNBOOK).
 *
 * The document-ingest engine already bounds per-batch work (`MAX_PAGES`,
 * `MAX_BATCH_BYTES=25MB`); this is the missing top-level input cap at the
 * daemon entry, sitting well above the batch size so it only stops genuine
 * runaways.
 */

/** Default ceiling: 100MB — 4× the 25MB batch size, a hard stop on a runaway
 * input without rejecting any realistic document. */
export const DEFAULT_INGEST_MAX_INPUT_BYTES = 100 * 1024 * 1024;

/**
 * Resolve the configured input-size ceiling. Operator override via
 * `CLAWCODE_INGEST_MAX_INPUT_BYTES` (positive integer bytes); any
 * missing/invalid value falls back to the default.
 */
export function resolveIngestMaxInputBytes(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.CLAWCODE_INGEST_MAX_INPUT_BYTES;
  if (raw === undefined) return DEFAULT_INGEST_MAX_INPUT_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_INGEST_MAX_INPUT_BYTES;
  }
  return Math.floor(parsed);
}

/**
 * Throw `makeError(message)` when `sizeBytes` exceeds `maxBytes`. Pure — the
 * caller injects the error factory (daemon passes `ManagerError`) so this stays
 * decoupled from the daemon's error type and is trivially unit-testable.
 */
export function assertIngestSizeWithinLimit(
  sizeBytes: number,
  maxBytes: number,
  filePath: string,
  makeError: (message: string) => Error,
): void {
  if (sizeBytes > maxBytes) {
    throw makeError(
      `file_path '${filePath}' is ${sizeBytes} bytes, exceeding the ingest ceiling of ` +
        `${maxBytes} bytes — refused (C2 input-size guard; raise via ` +
        `CLAWCODE_INGEST_MAX_INPUT_BYTES if intentional)`,
    );
  }
}
