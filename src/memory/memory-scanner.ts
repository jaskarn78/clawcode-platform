/**
 * Phase 90 MEM-02 — workspace memory file scanner.
 *
 * Watches `{workspace}/memory/**\/*.md` via chokidar + maintains the
 * `memory_chunks` + `vec_memory_chunks` + `memory_chunks_fts` +
 * `memory_files` tables in sync. Provides a `backfill()` one-shot for the
 * initial index + continuous upsert on add/change/unlink events.
 *
 * Idempotent: on change, re-indexes by deleting-then-inserting (avoids the
 * partial-chunk drift that a diff-based approach would risk).
 *
 * Excludes:
 *   - memory/subagent-*       — Plan 90-03 territory
 *   - MEMORY.md root file     — Plan 90-01 auto-loads into stable prefix
 *   - HEARTBEAT.md / heartbeat.log — operational state, not memory
 *
 * DI'd via MemoryScannerDeps so tests don't touch the real MiniLM embedder
 * or @huggingface/transformers. Mirrors the Phase 85 pure-function DI shape
 * (performMcpReadinessHandshake).
 */

import chokidar from "chokidar";
import type { FSWatcher } from "chokidar";
import { readFile, stat, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Logger } from "pino";
import type { MemoryStore } from "./store.js";
import { chunkMarkdownByH2, scoreWeightForPath } from "./memory-chunks.js";

/** Signature for the embed function — matches EmbeddingService.embed. */
export type EmbedFn = (text: string) => Promise<Float32Array>;

export type MemoryScannerDeps = Readonly<{
  store: MemoryStore;
  embed: EmbedFn;
  log: Logger;
  /**
   * Memory overhaul 2026-10-25 (WP4): gate for the backfill that start()
   * runs. The daemon constructs scanners before the per-agent MemoryStore
   * exists (its `store` is a lazy no-op proxy until then); backfilling at
   * that point would embed every file and discard the result. When this
   * returns false the backfill is deferred to the next start() call
   * (SessionManager calls start() again once the store exists).
   * Omitted means "ready".
   */
  storeReady?: () => boolean;
}>;

/**
 * Returns true if `absPath` should be indexed as a memory chunk source.
 * Exported for test visibility.
 */
export function shouldIndexMemoryPath(absPath: string): boolean {
  if (!absPath.endsWith(".md")) return false;
  // Subagent files carry transient context — Plan 90-03 handles those.
  if (/\/memory\/subagent-/.test(absPath)) return false;
  // Root MEMORY.md is handled by Plan 90-01 (stable prefix auto-load).
  if (/\/MEMORY\.md$/i.test(absPath) && !/\/memory\/.+MEMORY\.md$/i.test(absPath)) {
    return false;
  }
  // Operational artifacts — not memory content.
  if (/\/HEARTBEAT\.md$/i.test(absPath)) return false;
  return true;
}

/**
 * Result of a backfill run — indexed = file count, chunks = total chunk
 * rows inserted across those files, skipped = files whose sha256 matched
 * the on-disk content (no re-embed).
 */
export type BackfillResult = Readonly<{
  indexed: number;
  chunks: number;
  skipped: number;
}>;

export class MemoryScanner {
  private watcher: FSWatcher | null = null;
  /** Resolves when the current watcher emitted "ready". */
  private watcherReady: Promise<void> | null = null;
  private readonly indexing: Set<string> = new Set();
  /**
   * WP4: paths whose change arrived while they were being indexed. The
   * in-flight upsert re-runs them when it finishes instead of dropping the
   * event (the re-run is sha256-gated, so an unchanged file is cheap).
   */
  private readonly rerun: Set<string> = new Set();
  /** WP4: the startup backfill completed for the current watcher. */
  private startupBackfillDone = false;
  private startupBackfill: Promise<void> | null = null;
  /** WP4: set by stop() so a running backfill ends at the next file. */
  private stopRequested = false;
  /** WP4: the last backfill() ended early because stop() was called. */
  private lastBackfillInterrupted = false;

  constructor(
    private readonly deps: MemoryScannerDeps,
    private readonly workspacePath: string,
    /**
     * Phase 999.187 — extra directories to watch + backfill, for agents whose
     * `memoryPath` puts dated memory files outside `<workspace>/memory`.
     */
    private readonly extraRoots: readonly string[] = [],
  ) {}

  /** All roots this scanner covers: `<workspace>/memory` plus any extras. */
  private roots(): readonly string[] {
    const primary = join(this.workspacePath, "memory");
    const extras = this.extraRoots.filter((r) => r !== primary);
    return [primary, ...extras];
  }

  /**
   * Start the chokidar watcher. Calls are idempotent — a second start() is
   * a no-op so daemon re-init (e.g. after config reload) doesn't leak
   * watchers.
   *
   * Memory overhaul 2026-10-25 (WP4): once chokidar is ready, start() runs
   * backfill() (sha256-gated, so files already indexed cost a read and a
   * hash) and resolves when it finishes. The watcher uses ignoreInitial, so
   * without this, files written while no watcher or no store existed were
   * never indexed. When `deps.storeReady` reports false the backfill is
   * deferred, and a later start() call (watcher already running) runs it.
   * A failed backfill is logged and retried by the next start().
   *
   * chokidar 5.x dropped glob-pattern support — we watch the memory/
   * directory recursively and filter via `ignored` + shouldIndexMemoryPath
   * in the handlers. The dir-level watch correctly fires for nested paths
   * (e.g. memory/vault/rules.md) without needing explicit sub-watchers.
   */
  async start(): Promise<void> {
    this.stopRequested = false;
    if (!this.watcher) this.openWatcher();
    await this.watcherReady;
    await this.runStartupBackfill();
  }

  /** Create the chokidar watcher and its handlers (no await). */
  private openWatcher(): void {
    const memoryDir = join(this.workspacePath, "memory");
    const watchRoots = this.roots();
    // Dot-files excluded via `ignored`; non-.md / non-indexable files are
    // filtered in the handlers via shouldIndexMemoryPath (chokidar 5.x
    // path-based `ignored` is brittle against stats-less early events).
    this.watcher = chokidar.watch([...watchRoots], {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      ignored: (p: string) => /\/\.[^/]+$/.test(p),
    });
    this.watcher.on("add", (p) => {
      void this.handleUpsert(p).catch((err) =>
        this.deps.log.warn(
          { err: (err as Error).message, path: p },
          "memory-scanner: add failed",
        ),
      );
    });
    this.watcher.on("change", (p) => {
      void this.handleUpsert(p).catch((err) =>
        this.deps.log.warn(
          { err: (err as Error).message, path: p },
          "memory-scanner: change failed",
        ),
      );
    });
    this.watcher.on("unlink", (p) => {
      try {
        if (!shouldIndexMemoryPath(p)) return;
        this.deps.store.deleteMemoryChunksByPath(p);
        this.deps.log.debug(
          { path: p },
          "memory-scanner: unlinked chunks for removed file",
        );
      } catch (err) {
        this.deps.log.warn(
          { err: (err as Error).message, path: p },
          "memory-scanner: unlink failed",
        );
      }
    });
    // Wait for the initial scan to complete before returning. Without this,
    // tests (and callers issuing an immediate write after start()) race
    // against the pre-ready buffering window and can miss the add event.
    // Stored so a concurrent start() awaits the same ready signal.
    const watcher = this.watcher;
    this.watcherReady = new Promise<void>((resolve) => {
      watcher.once("ready", () => resolve());
    }).then(() => {
      this.deps.log.info(
        { workspace: this.workspacePath, memoryDir, extraRoots: this.extraRoots },
        "memory-scanner: watching memory/**/*.md",
      );
    });
  }

  /**
   * WP4: run the startup backfill once per watcher, when the store is
   * ready. Concurrent callers share the in-flight run.
   */
  private async runStartupBackfill(): Promise<void> {
    if (this.startupBackfillDone) return;
    if (this.deps.storeReady && !this.deps.storeReady()) {
      this.deps.log.debug(
        { workspace: this.workspacePath },
        "memory-scanner: store not ready, backfill deferred to the next start()",
      );
      return;
    }
    if (!this.startupBackfill) {
      this.startupBackfill = (async () => {
        try {
          const result = await this.backfill();
          if (!this.lastBackfillInterrupted) this.startupBackfillDone = true;
          this.deps.log.info(
            { workspace: this.workspacePath, ...result },
            "memory-scanner: startup backfill complete",
          );
        } catch (err) {
          this.deps.log.warn(
            { workspace: this.workspacePath, err: (err as Error).message },
            "memory-scanner: startup backfill failed (retried on next start)",
          );
        } finally {
          this.startupBackfill = null;
        }
      })();
    }
    await this.startupBackfill;
  }

  /** Stop the watcher. Safe to call even if start() was never invoked. */
  async stop(): Promise<void> {
    // WP4: end a running backfill at the next file, and backfill again on
    // the next start() (files may change while nothing is watching).
    this.stopRequested = true;
    this.startupBackfillDone = false;
    if (this.watcher) {
      const watcher = this.watcher;
      this.watcher = null;
      this.watcherReady = null;
      await watcher.close();
    }
  }

  /**
   * Index every eligible memory/**\/*.md file under the workspace. Skips
   * files whose sha256 matches what's already indexed (idempotent boot).
   *
   * Returns per-file counts so callers (CLI `clawcode memory backfill`)
   * can display a result summary.
   */
  async backfill(): Promise<BackfillResult> {
    const seen = new Set<string>();
    const files: string[] = [];
    for (const root of this.roots()) {
      for (const f of await this.enumerateMarkdownFiles(root)) {
        if (seen.has(f)) continue;
        seen.add(f);
        files.push(f);
      }
    }
    let chunks = 0;
    let indexed = 0;
    let skipped = 0;
    this.lastBackfillInterrupted = false;
    for (const p of files) {
      // WP4: stop() during a startup backfill ends it here. Never set for a
      // standalone backfill() (CLI), which does not start a watcher.
      if (this.stopRequested) {
        this.lastBackfillInterrupted = true;
        break;
      }
      if (!shouldIndexMemoryPath(p)) continue;
      const outcome = await this.handleUpsert(p);
      if (outcome === "skipped") {
        skipped++;
      } else {
        indexed++;
        chunks += outcome;
      }
    }
    return Object.freeze({ indexed, chunks, skipped });
  }

  /**
   * Re-index a single file. Returns the new chunk count (or "skipped" if
   * the on-disk content hashes to what's already stored).
   *
   * Serialized via `this.indexing` so rapid-fire chokidar fires on the
   * same path don't race into double-insert territory (awaitWriteFinish
   * suppresses most but not all).
   */
  private async handleUpsert(absPath: string): Promise<number | "skipped"> {
    if (!shouldIndexMemoryPath(absPath)) return 0;
    if (this.indexing.has(absPath)) {
      // WP4: queue a re-run instead of dropping the event.
      this.rerun.add(absPath);
      return 0;
    }
    this.indexing.add(absPath);
    try {
      const content = await readFile(absPath, "utf-8");
      const sha = createHash("sha256").update(content).digest("hex");

      const existingSha = this.deps.store.getMemoryFileSha256(absPath);
      if (existingSha === sha) {
        return "skipped";
      }

      const st = await stat(absPath);
      const chunks = chunkMarkdownByH2(content);
      const weight = scoreWeightForPath(absPath);

      // Reindex = delete-then-insert (atomic per-path; store method wraps
      // in a transaction). Partial failure after delete leaves the file
      // unindexed — acceptable, next chokidar tick (or backfill) recovers.
      this.deps.store.deleteMemoryChunksByPath(absPath);

      if (chunks.length === 0) {
        // Empty file — track the hash so we don't re-process, but skip
        // the embed call. memory_files row is NOT written (insertMemoryChunk
        // is the only writer), so next scan WILL re-read. Minor cost, not
        // a correctness issue for MEM-02 success criteria.
        return 0;
      }

      let inserted = 0;
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        const textToEmbed = (c.heading ? `${c.heading}\n\n` : "") + c.body;
        const embedding = await this.deps.embed(textToEmbed);
        this.deps.store.insertMemoryChunk({
          path: absPath,
          chunkIndex: i,
          heading: c.heading,
          body: c.body,
          tokenCount: c.tokenCount,
          scoreWeight: weight,
          fileMtimeMs: st.mtimeMs,
          fileSha256: sha,
          embedding,
        });
        inserted++;
      }
      this.deps.log.debug(
        { path: absPath, chunks: inserted },
        "memory-scanner: indexed file",
      );
      return inserted;
    } finally {
      this.indexing.delete(absPath);
      if (this.rerun.delete(absPath)) {
        void this.handleUpsert(absPath).catch((err) =>
          this.deps.log.warn(
            { err: (err as Error).message, path: absPath },
            "memory-scanner: re-index after concurrent change failed",
          ),
        );
      }
    }
  }

  /**
   * Recursively enumerate *.md files under `root`. No node_modules / .git
   * guards needed — memory/ is a curated subtree — but errors (missing
   * dir) return [] rather than throwing so first-boot agents with no
   * memory/ yet still start cleanly.
   */
  private async enumerateMarkdownFiles(root: string): Promise<readonly string[]> {
    const out: string[] = [];
    try {
      await walk(root, out);
    } catch {
      return [];
    }
    return out;
  }
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries: Array<{
    name: string;
    isDirectory: () => boolean;
    isFile: () => boolean;
  }>;
  try {
    entries = (await readdir(dir, { withFileTypes: true })) as unknown as Array<{
      name: string;
      isDirectory: () => boolean;
      isFile: () => boolean;
    }>;
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = join(dir, e.name as string);
    if (e.isDirectory()) {
      await walk(abs, out);
    } else if (e.isFile() && abs.endsWith(".md")) {
      out.push(abs);
    }
  }
}
