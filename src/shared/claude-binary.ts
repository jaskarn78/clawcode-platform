/**
 * Phase 999.169 — the ONE place that decides which Claude Code binary ClawCode spawns.
 *
 * The fleet binary is the Agent SDK's OWN bundled binary: SDK 0.3.x ships the
 * matched Claude Code CLI as a platform optional dependency
 * (`@anthropic-ai/claude-agent-sdk-linux-x64/claude`) and names that version in
 * its `package.json` `claudeCodeVersion`. So the exact SDK pin in `package.json`
 * is the single declaration, and bumping the SDK moves the CLI by construction —
 * the operator's lockstep rule (2026-09-24) made structural.
 *
 * `CLAWCODE_CLAUDE_BIN` survives only as an EXPLICIT override (rollback to a
 * hand-installed binary). There is no silent fallback: a missing bundled binary
 * throws `ClaudeBinaryNotFoundError` naming the fix, because a quiet fallback is
 * exactly how the fleet ended up on a stale binary twice (2026-06-01, 2026-09-23).
 *
 * The SDK's own resolver can pick the musl variant on a glibc host (the reason
 * the deploy scripts rename it away); resolving the libc-correct package here and
 * passing it as `pathToClaudeCodeExecutable` removes that ambiguity.
 *
 * Leaf module: node builtins only, so the v3 backend, the manager and the CLI can
 * all import it without an import cycle.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
export const CLAUDE_BINARY_OVERRIDE_ENV = "CLAWCODE_CLAUDE_BIN";

export type ClaudeBinarySource = "override" | "sdk-bundled";

export type InstalledSdk = {
  readonly version: string;
  /** The CLI version this SDK release was built against; null if undeclared. */
  readonly claudeCodeVersion: string | null;
  readonly dir: string;
};

export type ResolvedClaudeBinary = {
  readonly path: string;
  readonly source: ClaudeBinarySource;
  readonly sdk: InstalledSdk | null;
  /** The SDK platform package the binary came from; null for an override. */
  readonly platformPackage: string | null;
};

export class ClaudeBinaryNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeBinaryNotFoundError";
  }
}

export type ClaudeBinaryDeps = {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly isGlibc?: () => boolean;
  /** `require.resolve` from this module's location. */
  readonly resolveModule?: (spec: string) => string;
  readonly readFile?: (path: string) => string;
  readonly exists?: (path: string) => boolean;
};

const SUPPORTED_ARCHES = new Set(["x64", "arm64"]);

let glibcMemo: boolean | undefined;
function detectGlibc(): boolean {
  if (glibcMemo === undefined) {
    const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)
      ?.header;
    glibcMemo = typeof header?.glibcVersionRuntime === "string";
  }
  return glibcMemo;
}

function defaults(deps: ClaudeBinaryDeps): Required<ClaudeBinaryDeps> {
  const req = createRequire(import.meta.url);
  return {
    env: deps.env ?? process.env,
    platform: deps.platform ?? process.platform,
    arch: deps.arch ?? process.arch,
    isGlibc: deps.isGlibc ?? detectGlibc,
    resolveModule: deps.resolveModule ?? ((spec) => req.resolve(spec)),
    readFile: deps.readFile ?? ((p) => readFileSync(p, "utf8")),
    exists: deps.exists ?? existsSync,
  };
}

/** Platform package that carries the bundled binary, or null if unsupported. */
export function platformPackageName(platform: NodeJS.Platform, arch: string, glibc: boolean): string | null {
  if (!SUPPORTED_ARCHES.has(arch)) return null;
  if (platform === "linux") return `${SDK_PACKAGE}-linux-${arch}${glibc ? "" : "-musl"}`;
  if (platform === "darwin") return `${SDK_PACKAGE}-darwin-${arch}`;
  return null;
}

/**
 * The installed SDK's version and matched CLI version. The SDK does not export
 * `./package.json`, so resolve its entry point and read the manifest beside it.
 */
export function readInstalledSdk(deps: ClaudeBinaryDeps = {}): InstalledSdk | null {
  const d = defaults(deps);
  try {
    const dir = dirname(d.resolveModule(SDK_PACKAGE));
    const pkg = JSON.parse(d.readFile(join(dir, "package.json"))) as {
      version?: unknown;
      claudeCodeVersion?: unknown;
    };
    if (typeof pkg.version !== "string") return null;
    return {
      version: pkg.version,
      claudeCodeVersion: typeof pkg.claudeCodeVersion === "string" ? pkg.claudeCodeVersion : null,
      dir,
    };
  } catch {
    return null;
  }
}

/** The override path, or undefined when `CLAWCODE_CLAUDE_BIN` is unset/blank. */
export function readClaudeBinaryOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env[CLAUDE_BINARY_OVERRIDE_ENV];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

/**
 * Which binary to spawn. Override first, else the SDK's own libc-correct
 * platform binary. Throws `ClaudeBinaryNotFoundError` rather than falling back.
 */
export function resolveClaudeBinary(deps: ClaudeBinaryDeps = {}): ResolvedClaudeBinary {
  const d = defaults(deps);
  const sdk = readInstalledSdk(deps);
  const override = readClaudeBinaryOverride(d.env);
  if (override !== undefined) return { path: override, source: "override", sdk, platformPackage: null };

  const pkgName = platformPackageName(d.platform, d.arch, d.isGlibc());
  if (pkgName === null) {
    throw new ClaudeBinaryNotFoundError(
      `No bundled Claude Code binary for ${d.platform}/${d.arch}. ` +
        `Set ${CLAUDE_BINARY_OVERRIDE_ENV} to an installed claude binary.`,
    );
  }
  let pkgDir: string;
  try {
    pkgDir = dirname(d.resolveModule(`${pkgName}/package.json`));
  } catch {
    throw new ClaudeBinaryNotFoundError(
      `The Agent SDK's bundled Claude Code binary is not installed (${pkgName} is missing). ` +
        `Run \`npm ci\` in the ClawCode install dir so the SDK's platform package is present, ` +
        `or set ${CLAUDE_BINARY_OVERRIDE_ENV} to roll back to a hand-installed binary.`,
    );
  }
  const binary = join(pkgDir, "claude");
  if (!d.exists(binary)) {
    throw new ClaudeBinaryNotFoundError(
      `${pkgName} is installed but has no \`claude\` binary at ${binary}. ` +
        `Re-run \`npm ci\`, or set ${CLAUDE_BINARY_OVERRIDE_ENV}.`,
    );
  }
  return { path: binary, source: "sdk-bundled", sdk, platformPackage: pkgName };
}

/** Convenience for spawn sites that only need the path. */
export function claudeBinaryPath(deps: ClaudeBinaryDeps = {}): string {
  return resolveClaudeBinary(deps).path;
}

/** First line of `<bin> --version`, or null on any failure (never throws). */
export function probeBinaryVersion(bin: string): string | null {
  try {
    const first = execFileSync(bin, ["--version"], { timeout: 5000, encoding: "utf8" }).trim().split("\n")[0];
    return first === undefined || first.length === 0 ? null : first;
  } catch {
    return null;
  }
}

/** The fleet binary as the daemon, the deploy gate and `clawcode versions` all see it. */
export type FleetBinaryProbe = {
  /** The binary every spawn uses; null only when resolution failed. */
  readonly pin: string | null;
  readonly source: ClaudeBinarySource | null;
  readonly platformPackage: string | null;
  /** sha256 of the binary file (hex); null if not hashed or unreadable. */
  readonly sha256: string | null;
  /** First line of `--version`, e.g. `2.1.282 (Claude Code)`. */
  readonly version: string | null;
  readonly sdkVersion: string | null;
  /** The CLI version the installed SDK was built against. */
  readonly sdkClaudeCodeVersion: string | null;
  /** Resolution failure (missing bundled binary), verbatim. */
  readonly error: string | null;
};

export type ProbeFleetBinaryDeps = {
  readonly resolve?: () => ResolvedClaudeBinary;
  readonly readSdk?: () => InstalledSdk | null;
  readonly probeVersion?: (bin: string) => string | null;
  /** Hash the binary (default true; ~0.3 s for the 230 MB binary). */
  readonly hash?: boolean;
  readonly hashFile?: (path: string) => string | null;
};

/** Resolve + probe. Never throws: a bad probe must not crash a boot or a gate. */
export function probeFleetBinary(deps: ProbeFleetBinaryDeps = {}): FleetBinaryProbe {
  try {
    const r = (deps.resolve ?? (() => resolveClaudeBinary()))();
    const version = (deps.probeVersion ?? probeBinaryVersion)(r.path);
    return {
      pin: r.path,
      source: r.source,
      platformPackage: r.platformPackage,
      sha256: deps.hash === false ? null : (deps.hashFile ?? sha256File)(r.path),
      version,
      sdkVersion: r.sdk?.version ?? null,
      sdkClaudeCodeVersion: r.sdk?.claudeCodeVersion ?? null,
      error: null,
    };
  } catch (err) {
    const sdk = (deps.readSdk ?? (() => readInstalledSdk()))();
    return {
      pin: null,
      source: null,
      platformPackage: null,
      sha256: null,
      version: null,
      sdkVersion: sdk?.version ?? null,
      sdkClaudeCodeVersion: sdk?.claudeCodeVersion ?? null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Streaming sha256 of a file (1 MiB chunks, sync); null when unreadable. */
export function sha256File(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const hash = createHash("sha256");
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
    return hash.digest("hex");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Binary integrity (999.169 review): the build records the sha256 of the
// bundled binary it resolved; deploy gates and the boot log compare the
// installed binary against it. Anything with write access to node_modules
// could swap the binary — this makes that visible, cheaply.
// ---------------------------------------------------------------------------

export const BINARY_MANIFEST_FILE = "claude-binary.json";

export type ClaudeBinaryManifest = {
  readonly sdkVersion: string;
  readonly claudeCodeVersion: string | null;
  readonly platformPackage: string;
  readonly binaryVersion: string | null;
  readonly sha256: string;
  readonly recordedAt: string;
};

/**
 * Manifest of the SDK-bundled binary (the override is ignored on purpose: the
 * manifest describes what the SDK pin ships). Null when there is nothing to record.
 */
export function buildBinaryManifest(
  deps: ClaudeBinaryDeps & { readonly hashFile?: (p: string) => string | null; readonly now?: () => Date } = {},
): ClaudeBinaryManifest | null {
  try {
    const r = resolveClaudeBinary({ ...deps, env: {} });
    const sha256 = (deps.hashFile ?? sha256File)(r.path);
    if (r.sdk === null || r.platformPackage === null || sha256 === null) return null;
    return {
      sdkVersion: r.sdk.version,
      claudeCodeVersion: r.sdk.claudeCodeVersion,
      platformPackage: r.platformPackage,
      binaryVersion: probeBinaryVersion(r.path),
      sha256,
      recordedAt: (deps.now ?? (() => new Date()))().toISOString(),
    };
  } catch {
    return null;
  }
}

export function writeBinaryManifest(path: string, manifest: ClaudeBinaryManifest): void {
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
}

/** A well-formed manifest, or null (missing, unreadable, malformed). */
export function readBinaryManifest(path: string): ClaudeBinaryManifest | null {
  try {
    const m = JSON.parse(readFileSync(path, "utf8")) as Partial<ClaudeBinaryManifest>;
    if (
      typeof m.sdkVersion !== "string" ||
      typeof m.platformPackage !== "string" ||
      typeof m.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(m.sha256)
    ) {
      return null;
    }
    return m as ClaudeBinaryManifest;
  } catch {
    return null;
  }
}

export type BinaryIntegrityVerdict =
  | { readonly kind: "ok"; readonly sha256: string }
  | { readonly kind: "mismatch"; readonly expected: string; readonly actual: string; readonly path: string | null }
  /** Nothing to compare against (no manifest, override in use, other SDK/platform, unhashed). */
  | { readonly kind: "not-applicable"; readonly reason: string };

export function checkBinaryIntegrity(
  probe: Pick<FleetBinaryProbe, "pin" | "source" | "sha256" | "sdkVersion" | "platformPackage">,
  manifest: ClaudeBinaryManifest | null,
): BinaryIntegrityVerdict {
  if (manifest === null) return { kind: "not-applicable", reason: "no build manifest" };
  if (probe.source !== "sdk-bundled") return { kind: "not-applicable", reason: "CLAWCODE_CLAUDE_BIN override in use" };
  if (probe.sdkVersion !== manifest.sdkVersion || probe.platformPackage !== manifest.platformPackage) {
    return {
      kind: "not-applicable",
      reason: `manifest is for ${manifest.platformPackage}@${manifest.sdkVersion}, installed ${probe.platformPackage ?? "?"}@${probe.sdkVersion ?? "?"}`,
    };
  }
  if (probe.sha256 === null) return { kind: "not-applicable", reason: "installed binary could not be hashed" };
  return probe.sha256 === manifest.sha256
    ? { kind: "ok", sha256: probe.sha256 }
    : { kind: "mismatch", expected: manifest.sha256, actual: probe.sha256, path: probe.pin };
}
