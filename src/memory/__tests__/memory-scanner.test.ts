import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../store.js";
import { MemoryScanner } from "../memory-scanner.js";
import type { Logger } from "pino";

function makeLog(): Logger {
  const fn = () => {};
  const log: any = { info: fn, warn: fn, error: fn, debug: fn };
  log.child = () => log;
  return log as Logger;
}

function deterministicEmbed(text: string): Promise<Float32Array> {
  // Deterministic, test-only — hash into 384 floats. Real embedder is not
  // invoked (DI stub).
  const arr = new Float32Array(384);
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  for (let i = 0; i < 384; i++) {
    arr[i] = ((h + i * 17) % 1000) / 1000;
  }
  return Promise.resolve(arr);
}

describe("MemoryScanner (Phase 90 MEM-02)", () => {
  let tmp: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mem-scanner-"));
    mkdirSync(join(tmp, "memory"), { recursive: true });
    store = new MemoryStore(":memory:");
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* already closed */
    }
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("MEM-02-SCAN1: backfill indexes all memory/**/*.md files", async () => {
    writeFileSync(join(tmp, "memory", "2026-04-24-one.md"), "## A\nfirst body\n");
    writeFileSync(join(tmp, "memory", "2026-04-24-two.md"), "## B\nsecond body\n");
    mkdirSync(join(tmp, "memory", "vault"), { recursive: true });
    writeFileSync(join(tmp, "memory", "vault", "rules.md"), "## Rule\nbe kind\n");

    const scanner = new MemoryScanner(
      { store, embed: deterministicEmbed, log: makeLog() },
      tmp,
    );
    const result = await scanner.backfill();
    expect(result.indexed).toBe(3);
    expect(result.chunks).toBeGreaterThanOrEqual(3);

    const db = store.getDatabase();
    const fileCount = db.prepare("SELECT count(*) AS n FROM memory_files").get() as {
      n: number;
    };
    expect(fileCount.n).toBe(3);
  });

  it("MEM-02-SCAN2: onChange handler indexes a new file (via spy on store)", async () => {
    const insertSpy = vi.spyOn(store, "insertMemoryChunk");
    const scanner = new MemoryScanner(
      { store, embed: deterministicEmbed, log: makeLog() },
      tmp,
    );
    await scanner.start();
    try {
      const newPath = join(tmp, "memory", "2026-04-24-new.md");
      await writeFile(newPath, "## Fresh\nhot off the press\n");
      // awaitWriteFinish stabilityThreshold is 300ms — wait a bit longer
      await new Promise((r) => setTimeout(r, 2000));
      expect(insertSpy).toHaveBeenCalled();
      const anyCall = insertSpy.mock.calls.find((c) => c[0].path === newPath);
      expect(anyCall).toBeDefined();
    } finally {
      await scanner.stop();
    }
  }, 10_000);

  it("MEM-02-SCAN3: onUnlink handler removes chunks via deleteMemoryChunksByPath", async () => {
    const toRemove = join(tmp, "memory", "2026-04-24-doomed.md");
    writeFileSync(toRemove, "## Doomed\nabout to die\n");
    const scanner = new MemoryScanner(
      { store, embed: deterministicEmbed, log: makeLog() },
      tmp,
    );
    await scanner.backfill();

    const deleteSpy = vi.spyOn(store, "deleteMemoryChunksByPath");
    await scanner.start();
    try {
      await rm(toRemove);
      await new Promise((r) => setTimeout(r, 1500));
      const call = deleteSpy.mock.calls.find((c) => c[0] === toRemove);
      expect(call).toBeDefined();
    } finally {
      await scanner.stop();
    }
  }, 10_000);
});
