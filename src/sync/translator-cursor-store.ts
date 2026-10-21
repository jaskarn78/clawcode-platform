/**
 * Phase 91 Plan 03 — Conversation-turn translator cursor persistence (SYNC-04).
 *
 * Persists the per-file byte/line cursor tracking what has already been
 * translated from OpenClaw `sessions/*.jsonl` into ClawCode's
 * ConversationStore. Mirrors the Phase 83 effort-state-store pattern verbatim
 * (atomic temp+rename, graceful null fallback on corruption, zod-guarded
 * schema) so the two runtime JSON files behave consistently for operators
 * poking around in `~/.clawcode/manager/`.
 *
 * File shape (D-07):
 *
 * ```json
 * {
 *   "version": 1,
 *   "lastScanAt": "2026-04-24T19:00:00.000Z",
 *   "perFileCursor": {
 *     "/home/clawcode/.clawcode/manager/openclaw-sessions-staging/abc123.jsonl": {
 *       "byteOffset": 12345,
 *       "lineCount": 42,
 *       "fileSize": 12345,
 *       "mtime": "2026-04-24T18:55:00.000Z"
 *     }
 *   }
 * }
 * ```
 *
 * Invariants pinned by __tests__/translator-cursor-store.test.ts:
 *   - Missing file → DEFAULT_CURSOR (silent — first-boot path is normal)
 *   - Round-trip write → read returns the same cursor shape
 *   - Corrupt JSON → DEFAULT_CURSOR + warn
 *   - Invalid schema (negative byteOffset etc.) → DEFAULT_CURSOR + warn
 *   - Atomic temp+rename — tmp file in same dir, cleaned via rename
 *   - Immutable — writeTranslatorCursor builds a new object, never mutates
 *
 * DO NOT:
 *   - Extend sync-state.json with translator cursor — this is intentionally
 *     a SEPARATE file (D-07) so the 5-min workspace-sync timer and the
 *     hourly translator timer don't contend on a shared JSON file.
 */

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import type { Logger } from "pino";
import { z } from "zod/v4";

/** Canonical on-disk path for the translator cursor (D-07). */
export const DEFAULT_TRANSLATOR_CURSOR_PATH = join(
  homedir(),
  ".clawcode",
  "manager",
  "conversation-translator-cursor.json",
);

const perFileCursorEntrySchema = z.object({
  byteOffset: z.number().int().nonnegative(),
  lineCount: z.number().int().nonnegative(),
  fileSize: z.number().int().nonnegative(),
  mtime: z.string(),
});

const translatorCursorFileSchema = z.object({
  version: z.literal(1),
  lastScanAt: z.string(),
  perFileCursor: z.record(z.string(), perFileCursorEntrySchema),
});

export type PerFileCursorEntry = z.infer<typeof perFileCursorEntrySchema>;
export type TranslatorCursorFile = z.infer<typeof translatorCursorFileSchema>;

/** Frozen fresh-state cursor returned on every failure mode. */
export const DEFAULT_CURSOR: TranslatorCursorFile = Object.freeze({
  version: 1,
  lastScanAt: "",
  perFileCursor: Object.freeze({}),
}) as TranslatorCursorFile;

/**
 * Read the translator cursor from disk. Returns DEFAULT_CURSOR on any
 * failure mode (missing file, parse error, schema invalid). Missing file
 * is silent — normal first-boot path. Other failures log a warn so
 * operators see real corruption.
 */
export async function readTranslatorCursor(
  filePath: string,
  log?: Logger,
): Promise<TranslatorCursorFile> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return DEFAULT_CURSOR;
    }
    const msg = err instanceof Error ? err.message : String(err);
    log?.warn({ filePath, error: msg }, "translator-cursor: read failed");
    return DEFAULT_CURSOR;
  }

  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.warn(
      { filePath, error: msg },
      "translator-cursor: JSON parse failed, using default",
    );
    return DEFAULT_CURSOR;
  }

  const parsed = translatorCursorFileSchema.safeParse(obj);
  if (!parsed.success) {
    log?.warn(
      { filePath, issues: parsed.error.issues.length },
      "translator-cursor: schema invalid, using default",
    );
    return DEFAULT_CURSOR;
  }

  return parsed.data;
}

/**
 * Atomically write the translator cursor to disk using temp+rename.
 *
 * Guarantees:
 *   - Directory created recursively if missing.
 *   - Tmp file lives in the SAME directory (atomic rename within fs).
 *   - 12-hex-byte random suffix so concurrent writers do not clobber each
 *     other's tmp files (the rename itself is a last-write-wins race; the
 *     tmp suffix just prevents corruption on the way in).
 *   - Input MUST be a fresh object — this function does NOT mutate the
 *     caller's cursor (project immutability convention).
 */
export async function writeTranslatorCursor(
  filePath: string,
  next: TranslatorCursorFile,
  log?: Logger,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await rename(tmp, filePath);
  log?.debug(
    { filePath, fileCount: Object.keys(next.perFileCursor).length },
    "translator-cursor: persisted",
  );
}

/**
 * Update a single file's cursor entry and return a NEW TranslatorCursorFile
 * (immutable — never mutates the input). Useful for translator inner-loop
 * bookkeeping before the final atomic write.
 */
export function withPerFileCursor(
  cursor: TranslatorCursorFile,
  path: string,
  entry: PerFileCursorEntry,
): TranslatorCursorFile {
  return Object.freeze({
    version: 1,
    lastScanAt: cursor.lastScanAt,
    perFileCursor: Object.freeze({
      ...cursor.perFileCursor,
      [path]: Object.freeze({ ...entry }),
    }),
  }) as TranslatorCursorFile;
}
