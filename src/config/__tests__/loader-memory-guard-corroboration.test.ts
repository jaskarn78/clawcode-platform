/**
 * WS4 (2026-09-02) — guards the inert-knob failure mode for
 * `defaults.memoryGuard.corroborateWarnings`.
 *
 * This repo's history is knobs that parsed, validated, and did nothing:
 * `block` was never hot-reloadable, `heartbeat.enabled: false` was inert
 * without setAgentConfigs, `allowedModels` hot-reload was a boot snapshot,
 * `plugins:` was decorative on the v2 prod path. A `schema.parse()` assertion
 * would have passed in every one of those cases.
 *
 * `defaults.memoryGuard` is a ONE-place knob — no shared/types mirror, no
 * per-field loader spread — so the risk here is lower than the mcpServers
 * three-place chain. But `defaults.memoryGuard` has NEVER appeared in the live
 * /etc/clawcode/clawcode.yaml, so the read path from a real file has never
 * been exercised in production. These drive the actual loadConfig flow, which
 * is what the daemon's `resolveConfig: () => config.defaults.memoryGuard`
 * closure ultimately dereferences.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../loader.js";

describe("defaults.memoryGuard.corroborateWarnings — loadConfig round-trip", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "clawcode-ws4-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const load = async (lines: readonly string[]) => {
    const cfgPath = join(tmpDir, "clawcode.yaml");
    await writeFile(cfgPath, [...lines, ""].join("\n"), "utf-8");
    return loadConfig(cfgPath);
  };

  it("defaults to ON when the block is absent entirely (the live prod shape)", async () => {
    const loaded = await load([
      "version: 1",
      "agents:",
      "  - name: ws4-fixture",
    ]);
    // Absent block → the runtime falls back to MEMORY_GUARD_DEFAULTS, which
    // is where the ON default is single-sourced. Either an undefined block or
    // an explicit true is correct here; a literal `false` is not.
    expect(loaded.defaults.memoryGuard?.corroborateWarnings).not.toBe(false);
  });

  it("carries an explicit false all the way through loadConfig (the rollback)", async () => {
    const loaded = await load([
      "version: 1",
      "defaults:",
      "  memoryGuard:",
      "    corroborateWarnings: false",
      "agents:",
      "  - name: ws4-fixture",
    ]);
    expect(loaded.defaults.memoryGuard?.corroborateWarnings).toBe(false);
  });

  it("a partial block does NOT discard sibling defaults", async () => {
    // The INC-2026-08-09 landmine: an object-level `??` meant one override
    // silently dropped every sibling in the block.
    const loaded = await load([
      "version: 1",
      "defaults:",
      "  memoryGuard:",
      "    corroborateWarnings: false",
      "agents:",
      "  - name: ws4-fixture",
    ]);
    const mg = loaded.defaults.memoryGuard;
    expect(mg?.corroborateWarnings).toBe(false);
    expect(mg?.alertCooldownMs).toBe(21_600_000);
    expect(mg?.warnPct).toBe(0.8);
    expect(mg?.critPct).toBe(0.9);
  });

  it("rejects a non-boolean rather than coercing it", async () => {
    await expect(
      load([
        "version: 1",
        "defaults:",
        "  memoryGuard:",
        "    corroborateWarnings: maybe",
        "agents:",
        "  - name: ws4-fixture",
      ]),
    ).rejects.toThrow();
  });
});

/**
 * 999.147 — same inert-knob discipline for the tier router. These knobs are
 * the operator's rollback path for a change that deliberately silences most of
 * what #admin-clawdy used to receive, so "it parsed" is not good enough: the
 * value has to survive the real file → loadConfig → `config.defaults.
 * memoryGuard` path the daemon's resolveConfig closure dereferences.
 */
describe("defaults.memoryGuard tiering knobs — loadConfig round-trip", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "clawcode-999147-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const load = async (lines: readonly string[]) => {
    const cfgPath = join(tmpDir, "clawcode.yaml");
    await writeFile(cfgPath, [...lines, ""].join("\n"), "utf-8");
    return loadConfig(cfgPath);
  };

  it("tiering defaults to ON when the block is absent (the live prod shape)", async () => {
    const loaded = await load([
      "version: 1",
      "agents:",
      "  - name: t147-fixture",
    ]);
    expect(loaded.defaults.memoryGuard?.tiering).not.toBe(false);
  });

  it("carries tiering:false through loadConfig — the rollback actually lands", async () => {
    const loaded = await load([
      "version: 1",
      "defaults:",
      "  memoryGuard:",
      "    tiering: false",
      "agents:",
      "  - name: t147-fixture",
    ]);
    expect(loaded.defaults.memoryGuard?.tiering).toBe(false);
  });

  it("carries a per-key tier override, wildcard form included", async () => {
    const loaded = await load([
      "version: 1",
      "defaults:",
      "  memoryGuard:",
      "    alertTiers:",
      '      "total:pct": page',
      '      "class:*:rss": digest',
      "agents:",
      "  - name: t147-fixture",
    ]);
    expect(loaded.defaults.memoryGuard?.alertTiers).toEqual({
      "total:pct": "page",
      "class:*:rss": "digest",
    });
  });

  it("rejects a tier value that is not one of the three", async () => {
    await expect(
      load([
        "version: 1",
        "defaults:",
        "  memoryGuard:",
        "    alertTiers:",
        '      "total:pct": shout',
        "agents:",
        "  - name: t147-fixture",
      ]),
    ).rejects.toThrow();
  });

  it("carries imminence thresholds, and a partial block keeps its siblings", async () => {
    const loaded = await load([
      "version: 1",
      "defaults:",
      "  memoryGuard:",
      "    imminence:",
      "      etaMinutes: 25",
      "agents:",
      "  - name: t147-fixture",
    ]);
    expect(loaded.defaults.memoryGuard?.imminence?.etaMinutes).toBe(25);
    // The sibling defaults must survive — the INC-2026-08-09 object-level `??`
    // landmine, re-checked on a new nested block.
    expect(loaded.defaults.memoryGuard?.imminence?.anonCritPct).toBe(0.85);
    expect(loaded.defaults.memoryGuard?.imminence?.sustainSamples).toBe(2);
  });

  it("rejects an out-of-range threshold rather than silently clamping", async () => {
    await expect(
      load([
        "version: 1",
        "defaults:",
        "  memoryGuard:",
        "    imminence:",
        "      anonCritPct: 4",
        "agents:",
        "  - name: t147-fixture",
      ]),
    ).rejects.toThrow();
  });
});
