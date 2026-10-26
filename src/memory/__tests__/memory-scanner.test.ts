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

// ---------------------------------------------------------------------------
// Memory overhaul 2026-10-25 (WP4): start() backfills, the backfill waits for
// the store, restarts re-backfill, and a change during indexing is not lost.
// ---------------------------------------------------------------------------
describe("MemoryScanner startup backfill and re-index (WP4)", () => {
  let tmp: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mem-scanner-wp4-"));
    mkdirSync(join(tmp, "memory"), { recursive: true });
    store = new MemoryStore(":memory:");
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* already closed */
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  function indexedPaths(): string[] {
    return (
      store.getDatabase().prepare("SELECT path FROM memory_files").all() as {
        path: string;
      }[]
    ).map((r) => r.path);
  }

  it("start() indexes files that already existed (the watcher uses ignoreInitial)", async () => {
    const pre = join(tmp, "memory", "2026-10-20-1200.md");
    writeFileSync(pre, "## Decisions\nwritten while no scanner ran\n");
    const scanner = new MemoryScanner(
      { store, embed: deterministicEmbed, log: makeLog() },
      tmp,
    );
    await scanner.start();
    try {
      expect(indexedPaths()).toContain(pre);
    } finally {
      await scanner.stop();
    }
  }, 10_000);

  it("defers the backfill while the store is not ready, then runs it on the next start()", async () => {
    const pre = join(tmp, "memory", "2026-10-20.md");
    writeFileSync(pre, "## 10:00:00 [user]\nhello\n");
    let ready = false;
    const embed = vi.fn(deterministicEmbed);
    const scanner = new MemoryScanner(
      { store, embed, log: makeLog(), storeReady: () => ready },
      tmp,
    );
    await scanner.start(); // boot: store missing
    try {
      expect(embed).not.toHaveBeenCalled();
      expect(indexedPaths()).toEqual([]);

      ready = true;
      await scanner.start(); // SessionManager re-arm once the store exists
      expect(indexedPaths()).toContain(pre);
      const embedsAfterBackfill = embed.mock.calls.length;
      expect(embedsAfterBackfill).toBeGreaterThan(0);

      // A third start() is a no-op: no second backfill, no re-embed.
      await scanner.start();
      expect(embed.mock.calls.length).toBe(embedsAfterBackfill);
    } finally {
      await scanner.stop();
    }
  }, 10_000);

  it("stop() then start() backfills again, picking up files written while stopped (sha256-gated)", async () => {
    const first = join(tmp, "memory", "2026-10-21.md");
    writeFileSync(first, "## A\nfirst\n");
    const embed = vi.fn(deterministicEmbed);
    const scanner = new MemoryScanner(
      { store, embed, log: makeLog() },
      tmp,
    );
    await scanner.start();
    await scanner.stop();
    const embedsAfterFirst = embed.mock.calls.length;

    const second = join(tmp, "memory", "2026-10-22.md");
    writeFileSync(second, "## B\nwritten while stopped\n");
    await scanner.start();
    try {
      expect(indexedPaths()).toEqual(expect.arrayContaining([first, second]));
      // Only the new file was embedded; the unchanged one hit the sha gate.
      expect(embed.mock.calls.length).toBe(embedsAfterFirst + 1);
    } finally {
      await scanner.stop();
    }
  }, 10_000);

  it("a change that arrives while the same path is being indexed is re-indexed, not dropped", async () => {
    const path = join(tmp, "memory", "2026-10-23.md");
    writeFileSync(path, "## V1\nversion one\n");
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const embed = vi.fn(async (text: string) => {
      calls++;
      if (calls === 1) await gate; // hold the first index in flight
      return deterministicEmbed(text);
    });
    const scanner = new MemoryScanner(
      { store, embed, log: makeLog() },
      tmp,
    );
    const upsert = (
      scanner as unknown as { handleUpsert: (p: string) => Promise<number | "skipped"> }
    ).handleUpsert.bind(scanner);

    const first = upsert(path);
    await new Promise((r) => setTimeout(r, 20)); // first is now awaiting embed
    writeFileSync(path, "## V2\nversion two\n");
    expect(await upsert(path)).toBe(0); // concurrent event: queued, not run
    release!();
    await first;
    // The queued re-run is fire-and-forget; let it finish.
    await new Promise((r) => setTimeout(r, 100));

    const bodies = (
      store
        .getDatabase()
        .prepare("SELECT body FROM memory_chunks WHERE path = ?")
        .all(path) as { body: string }[]
    ).map((r) => r.body);
    expect(bodies.join("\n")).toContain("version two");
    expect(bodies.join("\n")).not.toContain("version one");
  }, 10_000);
});
