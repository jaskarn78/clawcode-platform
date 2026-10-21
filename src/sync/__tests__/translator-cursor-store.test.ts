/**
 * Phase 91 Plan 03 Task 1 — translator-cursor-store tests.
 *
 * Pins the atomic temp+rename + graceful-null semantics for the translator
 * cursor file at ~/.clawcode/manager/conversation-translator-cursor.json.
 *
 * Test shape mirrors src/manager/__tests__/effort-state-store.test.ts — per-test
 * mkdtemp + nanoid filename + afterEach rm so tests are reentrant.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nanoid } from "nanoid";
import {
  DEFAULT_CURSOR,
  readTranslatorCursor,
  writeTranslatorCursor,
  withPerFileCursor,
  type TranslatorCursorFile,
} from "../translator-cursor-store.js";

describe("translator-cursor-store", () => {
  let tmpDir: string;
  let cursorPath: string;
  let warn: ReturnType<typeof vi.fn>;
  let log: { warn: typeof warn; debug: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "translator-cursor-"));
    cursorPath = join(tmpDir, `${nanoid()}.json`);
    warn = vi.fn();
    log = { warn, debug: vi.fn() } as unknown as typeof log;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("CU1: missing file returns DEFAULT_CURSOR (silent)", async () => {
    const got = await readTranslatorCursor(cursorPath, log as never);
    expect(got.version).toBe(1);
    expect(got.lastScanAt).toBe("");
    expect(got.perFileCursor).toEqual({});
    // ENOENT is silent — no warn log
    expect(warn).not.toHaveBeenCalled();
  });

  it("CU2: write then read round-trips same cursor shape", async () => {
    const next: TranslatorCursorFile = {
      version: 1,
      lastScanAt: "2026-04-24T19:00:00.000Z",
      perFileCursor: {
        "/abs/path/a.jsonl": {
          byteOffset: 100,
          lineCount: 5,
          fileSize: 100,
          mtime: "2026-04-24T18:55:00.000Z",
        },
        "/abs/path/b.jsonl": {
          byteOffset: 500,
          lineCount: 12,
          fileSize: 500,
          mtime: "2026-04-24T18:58:00.000Z",
        },
      },
    };
    await writeTranslatorCursor(cursorPath, next, log as never);
    const got = await readTranslatorCursor(cursorPath, log as never);
    expect(got).toEqual(next);
  });

  it("CU3: writeTranslatorCursor uses temp+rename (no lingering .tmp files)", async () => {
    const next: TranslatorCursorFile = {
      version: 1,
      lastScanAt: "2026-04-24T19:00:00.000Z",
      perFileCursor: {},
    };
    await writeTranslatorCursor(cursorPath, next, log as never);
    // No orphan .tmp files should remain in the same directory
    const entries = await readdir(tmpDir);
    const tmpEntries = entries.filter((e) => e.includes(".tmp"));
    expect(tmpEntries).toEqual([]);
    // Canonical file exists
    const canonical = entries.filter((e) => !e.includes(".tmp"));
    expect(canonical).toHaveLength(1);
  });

  it("CU4: corrupt JSON returns DEFAULT_CURSOR + warn logged", async () => {
    await writeFile(cursorPath, "{not json at all", "utf8");
    const got = await readTranslatorCursor(cursorPath, log as never);
    expect(got).toEqual(DEFAULT_CURSOR);
    expect(warn).toHaveBeenCalledOnce();
    // Warn message contains the filePath context
    const callArgs = warn.mock.calls[0]?.[0] as { filePath?: string };
    expect(callArgs?.filePath).toBe(cursorPath);
  });

  it("CU5: invalid schema (negative byteOffset) returns DEFAULT_CURSOR + warn", async () => {
    await writeFile(
      cursorPath,
      JSON.stringify({
        version: 1,
        lastScanAt: "x",
        perFileCursor: {
          "/a": {
            byteOffset: -1,
            lineCount: 0,
            fileSize: 0,
            mtime: "",
          },
        },
      }),
      "utf8",
    );
    const got = await readTranslatorCursor(cursorPath, log as never);
    expect(got).toEqual(DEFAULT_CURSOR);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("CU6: concurrent writes with distinct tmp suffixes both land (last-write-wins)", async () => {
    const a: TranslatorCursorFile = {
      version: 1,
      lastScanAt: "2026-04-24T19:00:00.000Z",
      perFileCursor: {
        "/a.jsonl": {
          byteOffset: 1,
          lineCount: 1,
          fileSize: 1,
          mtime: "t1",
        },
      },
    };
    const b: TranslatorCursorFile = {
      version: 1,
      lastScanAt: "2026-04-24T19:00:01.000Z",
      perFileCursor: {
        "/b.jsonl": {
          byteOffset: 2,
          lineCount: 2,
          fileSize: 2,
          mtime: "t2",
        },
      },
    };
    // Fire both in parallel — no assertion of which lands, but final read
    // MUST return one of them intact (no partial / merged corruption).
    await Promise.all([
      writeTranslatorCursor(cursorPath, a, log as never),
      writeTranslatorCursor(cursorPath, b, log as never),
    ]);
    const got = await readTranslatorCursor(cursorPath, log as never);
    expect([a, b]).toContainEqual(got);
    // And no tmp files remain
    const entries = await readdir(tmpDir);
    const tmpEntries = entries.filter((e) => e.includes(".tmp"));
    expect(tmpEntries).toEqual([]);
  });

  it("CU7: withPerFileCursor returns a new object without mutating input (immutability)", () => {
    const original: TranslatorCursorFile = {
      version: 1,
      lastScanAt: "t0",
      perFileCursor: {
        "/a.jsonl": {
          byteOffset: 1,
          lineCount: 1,
          fileSize: 1,
          mtime: "m1",
        },
      },
    };
    const updated = withPerFileCursor(original, "/b.jsonl", {
      byteOffset: 2,
      lineCount: 2,
      fileSize: 2,
      mtime: "m2",
    });
    // Input NOT mutated
    expect(original.perFileCursor["/b.jsonl"]).toBeUndefined();
    // Output has both
    expect(updated.perFileCursor["/a.jsonl"]).toBeDefined();
    expect(updated.perFileCursor["/b.jsonl"]).toBeDefined();
    // Different reference
    expect(updated).not.toBe(original);
    expect(updated.perFileCursor).not.toBe(original.perFileCursor);
  });
});
