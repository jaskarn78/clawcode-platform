/**
 * Phase 999.187 — a scanner given an extra root (an agent whose `memoryPath`
 * puts dated memory files outside `<workspace>/memory`) backfills both.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../store.js";
import { MemoryScanner } from "../memory-scanner.js";

const embed = async (_t: string) => new Float32Array(384).fill(0.1);
const log = { info() {}, warn() {}, debug() {}, error() {}, child() { return log; } } as never;

let tmp: string;
let store: MemoryStore;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "scanner-extra-"));
  store = new MemoryStore(":memory:");
});
afterEach(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("MemoryScanner extra roots", () => {
  it("backfills <workspace>/memory AND the extra memoryDir, without double-counting", async () => {
    const ws = join(tmp, "ws");
    const other = join(tmp, "elsewhere", "memory");
    mkdirSync(join(ws, "memory"), { recursive: true });
    mkdirSync(other, { recursive: true });
    writeFileSync(join(ws, "memory", "2026-09-01.md"), "## A\nin workspace\n");
    writeFileSync(join(other, "2026-09-02-remember-ab12.md"), "## Standing note\nin memoryDir\n");

    const scanner = new MemoryScanner({ store, embed, log }, ws, [other, join(ws, "memory")]);
    const result = await scanner.backfill();
    expect(result.indexed).toBe(2);
    const paths = (store.getDatabase().prepare("SELECT path FROM memory_chunks").all() as { path: string }[]).map((r) => r.path);
    expect(paths).toContain(join(ws, "memory", "2026-09-01.md"));
    expect(paths).toContain(join(other, "2026-09-02-remember-ab12.md"));
  });

  it("with no extra roots behaves exactly as before", async () => {
    const ws = join(tmp, "ws");
    mkdirSync(join(ws, "memory"), { recursive: true });
    writeFileSync(join(ws, "memory", "2026-09-01.md"), "## A\nbody\n");
    const scanner = new MemoryScanner({ store, embed, log }, ws);
    expect((await scanner.backfill()).indexed).toBe(1);
  });
});
