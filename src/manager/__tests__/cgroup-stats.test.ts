import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCgroupMemoryStats } from "../cgroup-stats.js";

describe("readCgroupMemoryStats", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cgroup-stats-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns memoryCurrent + memoryMax + memoryPercent from cgroup files", async () => {
    await writeFile(`${dir}/memory.current`, "21013143552\n");
    await writeFile(`${dir}/memory.max`, "21474836480\n");
    const stats = await readCgroupMemoryStats(dir);
    expect(stats).not.toBeNull();
    expect(stats!.memoryCurrent).toBe(21_013_143_552);
    expect(stats!.memoryMax).toBe(21_474_836_480);
    expect(stats!.memoryPercent).toBeCloseTo(97.85, 1);
    expect(stats!.path).toBe(dir);
  });

  it("returns memoryMax=null and memoryPercent=null when memory.max is 'max'", async () => {
    await writeFile(`${dir}/memory.current`, "12345\n");
    await writeFile(`${dir}/memory.max`, "max\n");
    const stats = await readCgroupMemoryStats(dir);
    expect(stats).not.toBeNull();
    expect(stats!.memoryCurrent).toBe(12345);
    expect(stats!.memoryMax).toBeNull();
    expect(stats!.memoryPercent).toBeNull();
  });

  it("returns null when cgroup directory is missing", async () => {
    const stats = await readCgroupMemoryStats(join(dir, "does-not-exist"));
    expect(stats).toBeNull();
  });

  it("returns null when memory.current is non-numeric", async () => {
    await writeFile(`${dir}/memory.current`, "not-a-number\n");
    await writeFile(`${dir}/memory.max`, "100\n");
    const stats = await readCgroupMemoryStats(dir);
    expect(stats).toBeNull();
  });

  it("handles memoryMax=0 by returning memoryPercent=null (avoid divide-by-zero)", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(`${dir}/memory.current`, "0\n");
    await writeFile(`${dir}/memory.max`, "0\n");
    const stats = await readCgroupMemoryStats(dir);
    expect(stats).not.toBeNull();
    expect(stats!.memoryPercent).toBeNull();
  });

  // 2026-07-31 memory program F2 — high-aware effective ceiling. The
  // percent MUST use min(high, max): measuring against max alone let the
  // workflow admission gate admit into throttle territory once MemoryHigh
  // went live (85%×20G max = 100% of the 17G high line).
  it("F2: memory.high below memory.max drives effectiveCeiling + memoryPercent", async () => {
    await writeFile(`${dir}/memory.current`, "8500000000\n");
    await writeFile(`${dir}/memory.max`, "20000000000\n");
    await writeFile(`${dir}/memory.high`, "17000000000\n");
    const stats = await readCgroupMemoryStats(dir);
    expect(stats).not.toBeNull();
    expect(stats!.memoryHigh).toBe(17_000_000_000);
    expect(stats!.effectiveCeiling).toBe(17_000_000_000);
    expect(stats!.memoryPercent).toBeCloseTo(50, 1);
    // memoryMax preserved for dashboard compat.
    expect(stats!.memoryMax).toBe(20_000_000_000);
  });

  it("F2: memory.high 'max' (unset) falls back to memory.max as the ceiling", async () => {
    await writeFile(`${dir}/memory.current`, "5000000000\n");
    await writeFile(`${dir}/memory.max`, "20000000000\n");
    await writeFile(`${dir}/memory.high`, "max\n");
    const stats = await readCgroupMemoryStats(dir);
    expect(stats!.memoryHigh).toBeNull();
    expect(stats!.effectiveCeiling).toBe(20_000_000_000);
    expect(stats!.memoryPercent).toBeCloseTo(25, 1);
  });

  it("F2: missing memory.high file degrades to max-only (older kernels)", async () => {
    await writeFile(`${dir}/memory.current`, "1000\n");
    await writeFile(`${dir}/memory.max`, "2000\n");
    const stats = await readCgroupMemoryStats(dir);
    expect(stats!.memoryHigh).toBeNull();
    expect(stats!.effectiveCeiling).toBe(2000);
    expect(stats!.memoryPercent).toBeCloseTo(50, 1);
  });

  it("F2: both high and max unbounded → effectiveCeiling null, percent null", async () => {
    await writeFile(`${dir}/memory.current`, "1000\n");
    await writeFile(`${dir}/memory.max`, "max\n");
    await writeFile(`${dir}/memory.high`, "max\n");
    const stats = await readCgroupMemoryStats(dir);
    expect(stats!.effectiveCeiling).toBeNull();
    expect(stats!.memoryPercent).toBeNull();
  });
});
