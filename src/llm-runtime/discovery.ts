/**
 * Phase 137 Plan 01 — 3-tier CLI binary discovery helper.
 *
 * Generic enough to be reused by Plan 14X (Ollama, Gemini-CLI). Codex-
 * specific defaults (`commonPaths`, error wording at the call site)
 * live in `./backends/codex-agent-cli.ts`; this module owns the
 * resolution algorithm only.
 *
 * Resolution order:
 *   (1) Explicit config path (when provided) — verified with
 *       `existsSync`. Treated as operator-authoritative: if explicit
 *       path is given but doesn't exist on disk, we fall through to
 *       PATH + commonPaths and the error.checked list MUST surface
 *       the explicit path so the operator sees the typo.
 *   (2) PATH lookup via `which <binaryName>` (injectable dep). When
 *       `which` resolves to a non-null absolute path string, that
 *       wins. When it returns null (or throws — which on Linux/macOS
 *       returns non-zero exit when not found), we fall through.
 *   (3) Each entry of `commonPaths` tried in order via `existsSync`.
 *
 * Failure mode: `CliBinaryNotFoundError` with `.checked` listing every
 * path tried — operator pastes the list into a YAML edit and the next
 * `clawcode restart` resolves the misconfig.
 *
 * **DI-only design:** all filesystem + child_process access goes
 * through `DiscoverCliBinaryDeps`. Vitest stubs both. Production
 * callers (Phase 137 Plan 03 `CodexAgentCli`) construct a default
 * deps object inline. NO direct `node:child_process` / `execa`
 * imports here — keeps the helper unit-testable without process
 * fakery and avoids pulling `execa` (not a direct production
 * dependency) into this leaf module.
 *
 * See:
 *   - 137-01-PLAN.md T-01
 *   - 137-CONTEXT.md D1 (CodexBinaryNotFound contract)
 *   - SC1, SC6 (backwards-compat: existing agents resolve to
 *     `anthropic-agent-sdk`, no discovery probe runs for them)
 */

import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Thrown when no resolution tier surfaces an existing absolute path.
 *
 * Generic name (`CliBinaryNotFound`) so Phase 14X Ollama / Gemini-CLI
 * backends reuse this helper. Codex-specific operator messaging
 * (e.g., "set `llmRuntime.codex.pathToCodexExecutable`") lives at the
 * call site in `./backends/codex-agent-cli.ts`.
 *
 * `.checked` enumerates EVERY path probed — operators paste it into
 * an issue or into their YAML edit.
 */
export class CliBinaryNotFoundError extends Error {
  public readonly binaryName: string;
  public readonly checked: readonly string[];

  constructor(binaryName: string, checked: readonly string[]) {
    super(
      `Binary '${binaryName}' not found — checked: ${checked.join(", ")}`,
    );
    this.name = "CliBinaryNotFoundError";
    this.binaryName = binaryName;
    this.checked = checked;
  }
}

/**
 * Injectable filesystem + PATH-probe dependencies.
 *
 * Both fields are optional; the production defaults (Node's
 * `fs.existsSync` and a `which`-via-`execFile` shim) are wired below
 * in {@link discoverCliBinary}. Tests inject stubs to avoid touching
 * the real filesystem.
 */
export interface DiscoverCliBinaryDeps {
  /**
   * Synchronous file-exists check. Production default: Node's
   * `fs.existsSync`. Tests stub with `vi.fn()`.
   */
  readonly existsSync?: (p: string) => boolean;
  /**
   * PATH lookup. Returns the absolute path of the binary as resolved
   * by the OS, or null when the binary is not on PATH.
   *
   * Production default: `execFile("which", [binaryName])` with
   * exit-code-1 mapped to null (the standard POSIX `which` contract).
   * Tests stub with `vi.fn()`.
   */
  readonly which?: (binary: string) => Promise<string | null>;
}

/**
 * Discovery options. `binaryName` is the bare name (e.g., `"codex"`)
 * passed to `which`; `explicitPath` is the operator-supplied YAML
 * value (when present); `commonPaths` is the tier-3 fallback list
 * provided by the caller (Codex defaults at
 * `./backends/codex-agent-cli.ts` `CODEX_DEFAULT_COMMON_PATHS`).
 */
export interface DiscoverCliBinaryOptions {
  readonly binaryName: string;
  readonly explicitPath?: string;
  readonly commonPaths: readonly string[];
}

/**
 * Default `which` shim — runs the POSIX `which` binary via
 * `execFile`. Exit code 0 with stdout = absolute path means resolved;
 * any other outcome (non-zero exit, ENOENT, empty stdout) means not
 * found and we return `null` so the caller can fall through to
 * commonPaths.
 */
async function defaultWhich(binary: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("which", [binary]);
    const resolved = stdout.trim();
    return resolved.length > 0 ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * Resolve an absolute path to a CLI binary via the 3-tier algorithm.
 *
 * @param opts - {@link DiscoverCliBinaryOptions} carrying the binary
 *   name, optional explicit path, and the common-paths fallback list.
 * @param deps - {@link DiscoverCliBinaryDeps}. Production callers
 *   leave this undefined and pick up Node's `fs.existsSync` +
 *   `which`-via-`execFile`. Tests inject stubs.
 * @returns Absolute path on success.
 * @throws {CliBinaryNotFoundError} when no tier resolves. The
 *   `.checked` array enumerates every path probed (explicit when
 *   provided, then the PATH probe, then every commonPaths entry).
 */
export async function discoverCliBinary(
  opts: DiscoverCliBinaryOptions,
  deps?: DiscoverCliBinaryDeps,
): Promise<string> {
  const existsSync = deps?.existsSync ?? fs.existsSync;
  const which = deps?.which ?? defaultWhich;

  const checked: string[] = [];

  // Tier 1 — explicit path from operator config. We log it into the
  // checked list FIRST (before probing) so a missing-file error
  // surfaces the operator's typo at the top of the message.
  if (opts.explicitPath !== undefined) {
    checked.push(opts.explicitPath);
    if (existsSync(opts.explicitPath)) {
      return opts.explicitPath;
    }
  }

  // Tier 2 — PATH lookup via `which <binaryName>`. We always log a
  // single probe entry here (per PLAN T-01 case 4: ".checked.length
  // === 1 + commonPaths.length" when explicit is undefined).
  const probeLabel = `which(${opts.binaryName})`;
  checked.push(probeLabel);
  const fromPath = await which(opts.binaryName);
  if (fromPath !== null && fromPath.length > 0) {
    return fromPath;
  }

  // Tier 3 — common install paths.
  for (const candidate of opts.commonPaths) {
    checked.push(candidate);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new CliBinaryNotFoundError(opts.binaryName, checked);
}
