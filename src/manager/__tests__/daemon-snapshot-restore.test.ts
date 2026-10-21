/**
 * Phase 999.6 Plan 00 — Wave 0 RED tests for daemon.ts snapshot wiring.
 *
 * Source-grep tests on the literal text of `src/manager/daemon.ts` (mirrors
 * `daemon-autoStart-boot-loop.test.ts` Phase 100 follow-up pattern). All five
 * SNAP-WIRE-* assertions MUST fail until Wave 1 wires the daemon — the
 * substrings simply do not exist in daemon.ts at this point.
 *
 * Why source-grep over end-to-end boot tests: the daemon's runtime surface
 * (Discord, MCP children, embedder warmup, sockets) needs ~30s + a token to
 * exercise. Structural assertions catch contract drift in milliseconds and
 * give Wave 1 unambiguous textual targets to satisfy.
 *
 * Wiring contract (per 999.6-RESEARCH.md Examples 4 + 5):
 *
 *   shutdown() body — TOP, before drain:
 *     await writePreDeploySnapshot(
 *       PRE_DEPLOY_SNAPSHOT_PATH,
 *       manager.getRunningAgents().map((name) => ({ name, sessionId: ... })),
 *       log,
 *     );
 *
 *   boot path — between "manager daemon started" log and the autoStartAgents filter:
 *     const restored = await readAndConsumePreDeploySnapshot(
 *       PRE_DEPLOY_SNAPSHOT_PATH,
 *       knownAgentNames,
 *       config.defaults.preDeploySnapshotMaxAgeHours ?? 24,
 *       log,
 *     );
 *
 *   import:
 *     import { ... } from "./snapshot-manager.js";
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const DAEMON_SRC = readFileSync(
  new URL("../daemon.ts", import.meta.url),
  "utf-8",
);

describe("daemon.ts pre-deploy snapshot wiring (Phase 999.6)", () => {
  it("SNAP-WIRE-1: shutdown() invokes writePreDeploySnapshot BEFORE manager.drain", () => {
    // The snapshot writer MUST run at the top of shutdown() — before drain
    // begins settling sessions and before stopAll evicts entries from the
    // sessions map. If it runs later, getRunningAgents() returns a partial
    // (or empty) set and the snapshot is wrong.
    const shutdownIdx = DAEMON_SRC.indexOf("const shutdown = async");
    expect(shutdownIdx).toBeGreaterThan(0);

    const writeIdx = DAEMON_SRC.indexOf("writePreDeploySnapshot(", shutdownIdx);
    const drainIdx = DAEMON_SRC.indexOf("manager.drain(", shutdownIdx);

    // Both wiring anchors must exist after the shutdown declaration
    expect(writeIdx).toBeGreaterThan(shutdownIdx);
    expect(drainIdx).toBeGreaterThan(shutdownIdx);
    // Writer must come BEFORE drain
    expect(writeIdx).toBeLessThan(drainIdx);
  });

  it("SNAP-WIRE-2: boot path calls readAndConsumePreDeploySnapshot BEFORE the autoStartAgents filter", () => {
    // The snapshot reader must execute before resolvedAgents.filter so the
    // filter can union the snapshot's restored set into autoStartAgents.
    const readIdx = DAEMON_SRC.indexOf("readAndConsumePreDeploySnapshot(");
    expect(readIdx).toBeGreaterThan(0);

    // Find the filter that builds autoStartAgents (anchor matches the existing
    // shape from daemon.ts:4337 — `resolvedAgents.filter((cfg)`).
    const filterIdx = DAEMON_SRC.indexOf("resolvedAgents.filter((cfg)", readIdx);
    expect(filterIdx).toBeGreaterThan(readIdx);
  });

  it("SNAP-WIRE-3: snapshot reader receives preDeploySnapshotMaxAgeHours from config.defaults", () => {
    // The reader's third arg must be sourced from config.defaults so the
    // operator-tunable threshold (per 999.6-CONTEXT.md SNAP-04) flows
    // through. A bare literal 24 here would pass SNAP-04 but defeat the
    // configurability requirement.
    expect(DAEMON_SRC).toMatch(
      /readAndConsumePreDeploySnapshot\([^)]*config\.defaults\.preDeploySnapshotMaxAgeHours/,
    );
  });

  it("SNAP-WIRE-4: shutdown writer uses manager.getRunningAgents() (NOT a registry.json read)", () => {
    // The source of truth at shutdown is the in-memory sessions map, not
    // the persisted registry — registry can include `crashed`/`restarting`
    // entries we explicitly do NOT want to auto-revive (per CONTEXT.md
    // filter rules). Pin the in-memory call site in the writer's locality.
    const shutdownIdx = DAEMON_SRC.indexOf("const shutdown = async");
    const writeIdx = DAEMON_SRC.indexOf("writePreDeploySnapshot(", shutdownIdx);
    expect(writeIdx).toBeGreaterThan(0);

    const window = DAEMON_SRC.slice(writeIdx, writeIdx + 600);
    expect(window).toMatch(/manager\.getRunningAgents\(\)/);
    // Negative: no registry.json read in the writer's neighborhood.
    expect(window).not.toMatch(/readFile.*registry\.json/);
  });

  it("SNAP-WIRE-5: daemon imports from ../snapshot-manager (resolved relative to manager dir)", () => {
    // The wiring depends on the snapshot-manager module. Pin the import so
    // a future refactor that moves the module elsewhere fails this test.
    expect(DAEMON_SRC).toMatch(/from\s+["']\.\/snapshot-manager(\.js)?["']/);
  });
});
