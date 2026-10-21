/**
 * Read-only-source guard for skill migration.
 *
 * `assertReadOnlySource` is invoked from the fs-write interceptor in
 * `fs-guard.ts`: any write that resolves under `~/.openclaw/` (the legacy
 * source tree skills are migrated FROM) is refused.
 *
 * DO NOT add side effects here: guards are read-side-only.
 */

import { homedir } from "node:os";
import { resolve, sep } from "node:path";

/**
 * Thrown by assertReadOnlySource when a write target resolves under
 * `~/.openclaw/`. Carries the resolved path so the fs-interceptor can record
 * it before bubbling to the CLI.
 */
export class ReadOnlySourceError extends Error {
  readonly attemptedPath: string;
  constructor(attemptedPath: string) {
    super(`migrator refused write under ~/.openclaw/: ${attemptedPath}`);
    this.name = "ReadOnlySourceError";
    this.attemptedPath = attemptedPath;
  }
}

/**
 * Throws `ReadOnlySourceError` if `targetPath` resolves under `~/.openclaw/`.
 *
 * Similar-prefix paths like `~/.openclaw-backup/foo` are NOT under the ban;
 * the check uses `startsWith(forbidden + sep)` and an exact-equality branch.
 */
export function assertReadOnlySource(targetPath: string): void {
  const resolved = resolve(targetPath);
  const forbidden = resolve(homedir(), ".openclaw");
  if (resolved === forbidden || resolved.startsWith(forbidden + sep)) {
    throw new ReadOnlySourceError(resolved);
  }
}
