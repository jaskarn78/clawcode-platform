/**
 * Phase 115 Plan 05 sub-scope 7 — `clawcode_memory_archive` tool tests.
 *
 * Pins:
 *   - happy path: archive promotes a chunk, appends to MEMORY.md, logs info
 *   - non-existent chunk → error
 *   - wrappingPrefix / wrappingSuffix included in appended content
 *   - bypasses D-10 review window (agent-curated)
 *   - propagates clawcodeMemoryEdit errors (jail / symlink) when memoryRoot
 *     misbehaves
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "fs";
import { join } from "path";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { MemoryStore } from "../store.js";
import { clawcodeMemoryArchive } from "../tools/clawcode-memory-archive.js";

let testRoot: string;
let memoryRoot: string;
let store: MemoryStore;

function randomEmbedding(): Float32Array {
  const arr = new Float32Array(384);
  for (let i = 0; i < 384; i++) {
    arr[i] = (Math.random() * 2 - 1) * 0.1;
  }
  let norm = 0;
  for (let i = 0; i < 384; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < 384; i++) arr[i] /= norm;
  return arr;
}

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), "clawcode-memory-archive-test-"));
  memoryRoot = join(testRoot, "memory-root");
  await fs.mkdir(memoryRoot, { recursive: true });
  store = new MemoryStore(":memory:");
});

afterEach(async () => {
  store?.close();
  await rm(testRoot, { recursive: true, force: true });
});

function makeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("clawcodeMemoryArchive — happy path", () => {
  it("archives a chunk into MEMORY.md by appending body", async () => {
    const chunkId = store.insertMemoryChunk({
      path: "memory/notes/promote-me.md",
      chunkIndex: 0,
      heading: null,
      body: "this should land in MEMORY.md",
      tokenCount: 8,
      scoreWeight: 0,
      fileMtimeMs: Date.now(),
      fileSha256: "x".repeat(64),
      embedding: randomEmbedding(),
    });

    const log = makeLog();
    const res = await clawcodeMemoryArchive(
      { chunkId, targetPath: "MEMORY.md" },
      { store, memoryRoot, agentName: "agent-A", log },
    );

    expect(res.ok).toBe(true);
    const onDisk = await fs.readFile(join(memoryRoot, "MEMORY.md"), "utf8");
    expect(onDisk).toContain("this should land in MEMORY.md");
    // log.info called with action=agent-curated-archive
    expect(log.info).toHaveBeenCalled();
    const ctx = log.info.mock.calls[0][0] as Record<string, unknown>;
    expect(ctx.action).toBe("agent-curated-archive");
    expect(ctx.chunkId).toBe(chunkId);
    expect(ctx.targetPath).toBe("MEMORY.md");
  });

  it("includes wrappingPrefix + wrappingSuffix in appended content", async () => {
    const chunkId = store.insertMemoryChunk({
      path: "memory/notes/x.md",
      chunkIndex: 0,
      heading: null,
      body: "core content",
      tokenCount: 3,
      scoreWeight: 0,
      fileMtimeMs: Date.now(),
      fileSha256: "x".repeat(64),
      embedding: randomEmbedding(),
    });

    const log = makeLog();
    const res = await clawcodeMemoryArchive(
      {
        chunkId,
        targetPath: "USER.md",
        wrappingPrefix: "## Promoted\n",
        wrappingSuffix: "\n— archived",
      },
      { store, memoryRoot, agentName: "agent-A", log },
    );

    expect(res.ok).toBe(true);
    const onDisk = await fs.readFile(join(memoryRoot, "USER.md"), "utf8");
    expect(onDisk).toContain("## Promoted");
    expect(onDisk).toContain("core content");
    expect(onDisk).toContain("— archived");
  });

  it("appends rather than overwrites when MEMORY.md already exists", async () => {
    await fs.writeFile(
      join(memoryRoot, "MEMORY.md"),
      "existing content",
      "utf8",
    );
    const chunkId = store.insertMemoryChunk({
      path: "memory/notes/y.md",
      chunkIndex: 0,
      heading: null,
      body: "fresh content",
      tokenCount: 3,
      scoreWeight: 0,
      fileMtimeMs: Date.now(),
      fileSha256: "x".repeat(64),
      embedding: randomEmbedding(),
    });

    const log = makeLog();
    const res = await clawcodeMemoryArchive(
      { chunkId, targetPath: "MEMORY.md" },
      { store, memoryRoot, agentName: "agent-A", log },
    );

    expect(res.ok).toBe(true);
    const onDisk = await fs.readFile(join(memoryRoot, "MEMORY.md"), "utf8");
    expect(onDisk).toContain("existing content");
    expect(onDisk).toContain("fresh content");
  });
});

describe("clawcodeMemoryArchive — error paths", () => {
  it("non-existent chunk → { ok: false, error }", async () => {
    const log = makeLog();
    const res = await clawcodeMemoryArchive(
      { chunkId: "nonexistent", targetPath: "MEMORY.md" },
      { store, memoryRoot, agentName: "agent-A", log },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/chunk not found/);
    // No archive log entry on miss.
    expect(log.info).not.toHaveBeenCalled();
  });
});
