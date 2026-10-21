/**
 * P2 (memory program, WS-2d) — pinned spawn resolution for the broker's
 * pooled 1Password MCP child.
 *
 * The broker previously spawned `npx -y @takescake/1password-mcp@latest`
 * — the last remaining `@latest` npx chain after the playwright pin:
 * npm/npx intermediary processes per pooled child, registry re-resolution
 * on every respawn (latency + supply-chain hazard), and an outage
 * dependency on npmjs.org for credential access.
 *
 * Runbook (one-time, on-box):
 *   sudo -u clawcode mkdir -p /opt/clawcode-mcp-servers/node/1password-mcp
 *   cd /opt/clawcode-mcp-servers/node/1password-mcp
 *   sudo -u clawcode npm install --no-audit --no-fund @takescake/1password-mcp@<pinned>
 *
 * Fail-open: when the pinned install is absent or unreadable, fall back
 * to the classic npx spawn (credential access must never break because a
 * pin is missing). The resolver reads the package's `bin`/`main` from its
 * package.json so a package-layout change breaks loudly at resolve time
 * (→ npx fallback) instead of spawning a wrong entry file.
 *
 * Pure module with injectable probes for tests.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PINNED_1PASSWORD_MCP_DIR =
  "/opt/clawcode-mcp-servers/node/1password-mcp/node_modules/@takescake/1password-mcp";

export interface BrokerChildSpawn {
  readonly command: string;
  readonly args: readonly string[];
  /** Telemetry discriminator: which path resolved. */
  readonly source: "pinned" | "npx";
}

export function resolveBrokerChildSpawn(probe?: {
  readonly dir?: string;
  readonly exists?: (p: string) => boolean;
  readonly readFile?: (p: string) => string;
}): BrokerChildSpawn {
  const npxFallback: BrokerChildSpawn = {
    command: "npx",
    args: ["-y", "@takescake/1password-mcp@latest"],
    source: "npx",
  };
  const dir = probe?.dir ?? PINNED_1PASSWORD_MCP_DIR;
  const exists = probe?.exists ?? existsSync;
  const read = probe?.readFile ?? ((p: string) => readFileSync(p, "utf-8"));
  try {
    const pkgPath = join(dir, "package.json");
    if (!exists(pkgPath)) return npxFallback;
    const pkg = JSON.parse(read(pkgPath)) as {
      bin?: string | Record<string, string>;
      main?: string;
    };
    const rel =
      typeof pkg.bin === "string"
        ? pkg.bin
        : (pkg.bin && Object.values(pkg.bin)[0]) || pkg.main;
    if (!rel) return npxFallback;
    const entry = join(dir, rel);
    if (!exists(entry)) return npxFallback;
    return { command: "node", args: [entry], source: "pinned" };
  } catch {
    return npxFallback;
  }
}
