import { accessSync, constants } from "node:fs";
import { resolve } from "node:path";

const SYSTEM_CONFIG = "/etc/clawcode/clawcode.yaml";

/**
 * Resolve clawcode.yaml config path. When the user passes an explicit `-c`,
 * use it as-is. When using the default relative "clawcode.yaml", check CWD
 * first, then the system config location (/etc/clawcode/clawcode.yaml).
 */
export function resolveConfigPath(
  cliValue: string,
  { needsWrite = false }: { needsWrite?: boolean } = {},
): string {
  if (cliValue !== "clawcode.yaml") {
    return cliValue;
  }

  const cwdPath = resolve(cliValue);
  const mode = needsWrite
    ? constants.R_OK | constants.W_OK
    : constants.R_OK;

  try {
    accessSync(cwdPath, mode);
    return cwdPath;
  } catch {
    // CWD copy missing or not accessible — try system location
  }

  try {
    accessSync(SYSTEM_CONFIG, mode);
    return SYSTEM_CONFIG;
  } catch {
    // Neither location accessible — return CWD path so the caller
    // gets the original error with a meaningful path in the message
  }

  return cwdPath;
}
