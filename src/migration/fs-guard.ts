/**
 * Phase 77 MIGR-07 runtime belt-and-suspenders: patches node:fs write APIs
 * to refuse any path resolving under `~/.openclaw/`. Install once at the
 * CLI apply entry point, uninstall on exit (finally block — even on throw).
 *
 * Companion to src/migration/guards.ts::assertReadOnlySource (the static
 * helper). This module wires the helper into the node fs surface at runtime
 * so accidental new-code that forgets to call assertReadOnlySource still
 * cannot write under the source tree.
 *
 * Static guard: a test in `src/cli/commands/__tests__/migrate-openclaw.test.ts`
 * greps src/migration/ for literal `~/.openclaw/` in a write-context call and
 * asserts zero occurrences — catches the "dev hardcoded a source-tree write
 * path" regression before runtime.
 *
 * ### ESM scope caveat (CRITICAL)
 *
 * Node.js ESM module namespace objects (`import * as fs from "node:fs"` and
 * `import { writeFile } from "node:fs/promises"`) are frozen "Module" exotic
 * objects — their property slots are NOT writable or configurable, so we
 * cannot patch `fs.writeFileSync` or `fsp.writeFile` on the namespace.
 *
 * What we CAN patch is the underlying CommonJS module object returned by
 * `require("node:fs")` and `require("node:fs/promises")`. That object IS
 * mutable, and is the SAME underlying object as the default-export:
 *   `import fs from "node:fs"` → same as `require("node:fs")`.
 *
 * Therefore:
 *   - Code that uses `import fs from "node:fs"` (default import) and calls
 *     `fs.writeFileSync(path, ...)` → sees the patched version.
 *   - Code that uses `require("node:fs").writeFileSync(...)` → sees the
 *     patched version.
 *   - Code that uses `import * as fs from "node:fs"` or
 *     `import { writeFileSync } from "node:fs"` → does NOT see the patch
 *     (ESM-frozen bindings).
 *
 * This is imperfect by design — JavaScript doesn't provide a way to
 * retroactively modify ESM named bindings. The static-grep test is the
 * primary MIGR-07 line of defense; the runtime fs-guard catches dynamic
 * path construction that happens to resolve under ~/.openclaw/ in code
 * paths that access fs via default-import or require.
 *
 * DO NOT:
 *   - Patch node:fs read APIs — reads are fine (and necessary for the
 *     openclaw.json reader, sqlite ATTACH, etc.).
 *   - Leave the guard installed past the command boundary — other CLI
 *     subcommands (status, costs, etc.) may legitimately write anywhere.
 *   - Double-wrap — track `installed` state and short-circuit repeat installs.
 *   - Block appendFile to .planning/migration/ledger.jsonl — the ledger
 *     is NOT under ~/.openclaw/; assertReadOnlySource already permits it.
 */
import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { assertReadOnlySource } from "./guards.js";

type FsPathLike = string | Buffer | URL | number;

/**
 * Extracts a filesystem path string from the heterogeneous first-arg types
 * that node:fs write APIs accept. Returns `undefined` for file descriptors
 * (numeric handles — node:fs handles these directly, no path to vet).
 */
function extractPath(pathArg: FsPathLike): string | undefined {
  if (typeof pathArg === "number") return undefined; // fd — no path to check
  if (Buffer.isBuffer(pathArg)) return pathArg.toString("utf8");
  if (pathArg instanceof URL) return fileURLToPath(pathArg);
  if (typeof pathArg === "string") return pathArg;
  return undefined;
}

// Lazy-initialized CJS-form references. These are the SAME objects that
// `import fs from "node:fs"` (default import) binds to — any mutation here
// is visible to callers using default-import or require().
//
// We use createRequire rather than a top-level `import fs from ...` because
// the default-export binding is itself frozen at module init time in strict
// ESM; createRequire gives us an always-mutable reference.
const requireFn = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fsCjs: any = requireFn("node:fs");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fspCjs: any = requireFn("node:fs/promises");

type AsyncWrite = (p: FsPathLike, ...rest: unknown[]) => Promise<unknown>;
type SyncWrite = (p: FsPathLike, ...rest: unknown[]) => unknown;

type Originals = {
  writeFile: AsyncWrite;
  appendFile: AsyncWrite;
  mkdir: AsyncWrite;
  writeFileSync: SyncWrite;
  appendFileSync: SyncWrite;
  mkdirSync: SyncWrite;
};

// Module-scope state — the single source of truth for "is the guard live?".
// Idempotency depends on this flag; never inline.
let installed = false;
let originals: Originals | undefined;

/**
 * Phase 82 OPS-02 — additive allowlist state. Resolved-path exact-match set
 * of paths that bypass the ReadOnlySource check. Empty by default; populated
 * ONLY via installFsGuard({ allowlist: [...] }). Cleared on uninstall.
 *
 * Load-bearing invariants:
 *   - Exact-equality match on resolved paths (NOT startsWith). This means
 *     `~/.openclaw/openclaw.json` in the allowlist does NOT open up
 *     `~/.openclaw/openclaw.json.bak` or any other sibling — the allowlist
 *     is one-path-at-a-time. Phase 82 cutover uses exactly one path.
 *   - `path.resolve()` applied once at install time so subsequent
 *     write attempts can use the same normalizer and match reliably even
 *     when callers pass relative / denormalized path strings.
 *   - `installed` flag still gates double-install — a second installFsGuard
 *     call is a no-op, including any second-call allowlist argument. This
 *     mirrors the existing Phase 77 contract. Uninstall + re-install is the
 *     only way to change allowlist membership.
 */
let allowedPaths: Set<string> = new Set();

/**
 * Check whether `str` (a raw path from fs write call) resolves to an
 * allow-listed path. Uses exact-equality on `path.resolve()` output — NOT
 * prefix match. The allowlist is one-path-granularity per Phase 82.
 */
function isAllowlisted(str: string): boolean {
  if (allowedPaths.size === 0) return false;
  return allowedPaths.has(resolve(str));
}

/**
 * Wrap an fs write function so that the first argument (which may be a
 * string, Buffer, URL, or numeric fd) is extracted and passed through
 * `assertReadOnlySource` BEFORE the original implementation runs.
 *
 * Phase 82 extension: if the resolved path is in `allowedPaths`, the
 * read-only check is SKIPPED and the write proceeds normally. Every other
 * path under `~/.openclaw/` still refuses exactly as before.
 */
function wrapAsync(orig: AsyncWrite): AsyncWrite {
  return (p: FsPathLike, ...rest: unknown[]): Promise<unknown> => {
    // Convert synchronous throws to rejected promises so callers using the
    // Promise-style API always observe rejection (not a sync throw) —
    // matches the contract of node:fs/promises.
    try {
      const str = extractPath(p);
      if (str !== undefined && !isAllowlisted(str)) assertReadOnlySource(str);
    } catch (err) {
      return Promise.reject(err);
    }
    return orig(p, ...rest);
  };
}

function wrapSync(orig: SyncWrite): SyncWrite {
  return (p: FsPathLike, ...rest: unknown[]): unknown => {
    const str = extractPath(p);
    if (str !== undefined && !isAllowlisted(str)) assertReadOnlySource(str);
    return orig(p, ...rest);
  };
}

/**
 * Install the process-scoped fs write interceptor. Idempotent — calling
 * twice is a no-op (tracked via module-scope `installed` flag).
 *
 * Patches six fs entry points on the CJS module objects:
 *   - node:fs/promises  → writeFile / appendFile / mkdir
 *   - node:fs           → writeFileSync / appendFileSync / mkdirSync
 *
 * See the ESM scope caveat in the file header for which import styles
 * are covered.
 *
 * Phase 82 extension: `opts.allowlist` enumerates absolute (or resolvable)
 * paths that bypass the ~/.openclaw/ refuse. Each entry is normalized via
 * `path.resolve()` once at install time; at write time the candidate path
 * is resolved identically and compared for exact equality. Sibling paths
 * (e.g., `<file>.bak`) do NOT share the allowlist exemption.
 *
 * Second-install idempotency still applies — a second installFsGuard(opts)
 * call is a no-op, INCLUDING any opts.allowlist. To change allowlist
 * membership, uninstallFsGuard() then installFsGuard({ allowlist: [...] })
 * again. This matches the existing Phase 77 contract: the first install
 * wins.
 */
export function installFsGuard(opts?: {
  readonly allowlist?: readonly string[];
}): void {
  if (installed) return;
  originals = {
    writeFile: fspCjs.writeFile as AsyncWrite,
    appendFile: fspCjs.appendFile as AsyncWrite,
    mkdir: fspCjs.mkdir as AsyncWrite,
    writeFileSync: fsCjs.writeFileSync as SyncWrite,
    appendFileSync: fsCjs.appendFileSync as SyncWrite,
    mkdirSync: fsCjs.mkdirSync as SyncWrite,
  };

  // Resolve allowlist entries ONCE at install time. Subsequent write
  // attempts use the same path.resolve() normalizer to compare.
  const entries = opts?.allowlist ?? [];
  allowedPaths = new Set(entries.map((p) => resolve(p)));

  // Direct assignment works on CJS module objects (writable + configurable).
  fspCjs.writeFile = wrapAsync(originals.writeFile);
  fspCjs.appendFile = wrapAsync(originals.appendFile);
  fspCjs.mkdir = wrapAsync(originals.mkdir);
  fsCjs.writeFileSync = wrapSync(originals.writeFileSync);
  fsCjs.appendFileSync = wrapSync(originals.appendFileSync);
  fsCjs.mkdirSync = wrapSync(originals.mkdirSync);

  installed = true;
}

/**
 * Restore the original fs write functions. Safe to call even when no
 * install has run (no-op). Always call from a `finally` block so a thrown
 * guard never leaves the interceptor lingering for the next CLI command.
 *
 * Also clears the Phase 82 allowlist state — a subsequent installFsGuard()
 * with no args sees an empty Set, preserving the Phase 77 default-refuse
 * behavior for all paths under ~/.openclaw/.
 */
export function uninstallFsGuard(): void {
  if (!installed || !originals) return;
  fspCjs.writeFile = originals.writeFile;
  fspCjs.appendFile = originals.appendFile;
  fspCjs.mkdir = originals.mkdir;
  fsCjs.writeFileSync = originals.writeFileSync;
  fsCjs.appendFileSync = originals.appendFileSync;
  fsCjs.mkdirSync = originals.mkdirSync;
  originals = undefined;
  installed = false;
  allowedPaths = new Set();
}
