/**
 * Phase 100 follow-up — daemon boot loop respects per-agent autoStart=false.
 *
 * The daemon's auto-start IIFE on `startDaemon` calls `manager.startAll(...)`.
 * For autoStart=false agents the daemon must NOT spawn the SDK session, but
 * the agent's config MUST remain in `configs` so the `start <name>` IPC handler
 * (line 3990 area) can find it via `configs.find((c) => c.name === name)` when
 * the operator manually starts it later.
 *
 * Source-level grep pattern (mirrors daemon-task-store.test.ts) — the runtime
 * surface (Discord, MCP children, embedder warmup) needs ~30s + a token; the
 * structural assertions catch the contract drift without that cost.
 *
 * Tests:
 *   AS-DAEMON-1: the auto-start IIFE filters resolvedAgents by `autoStart !== false`
 *                so dormant agents are NOT passed to manager.startAll on boot.
 *   AS-DAEMON-2: the `start <name>` IPC handler still finds dormant agents via
 *                `configs.find(...)` — operator can bring them up on demand.
 *   AS-DAEMON-3: skipped agents get a structured info log so operators can verify
 *                the skip happened (not a silent failure).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const DAEMON_SRC = readFileSync(
  new URL("../daemon.ts", import.meta.url),
  "utf-8",
);

describe("daemon.ts autoStart boot-loop filter (Phase 100 follow-up)", () => {
  it("AS-DAEMON-1: auto-start path filters resolvedAgents by autoStart before passing to manager.startAll", () => {
    // The auto-start IIFE lives near the bottom of startDaemon and calls
    // `manager.startAll(<filtered>)`. The filter must reference autoStart so
    // a future refactor that swaps to `manager.startAll(resolvedAgents)`
    // (unfiltered) breaks this test loudly.
    //
    // Match patterns: the source must contain a filter that checks the
    // autoStart field BEFORE the auto-start startAll call. Acceptable shapes:
    //   .filter((a) => a.autoStart !== false)
    //   .filter((a) => a.autoStart)
    //   if (cfg.autoStart === false) continue;
    //
    // We pin the most common shape (`autoStart !== false` — true is the
    // implicit default, so we want explicit-false to be the rejection).
    expect(DAEMON_SRC).toMatch(/autoStart\s*!==\s*false|autoStart\s*===\s*false/);
  });

  it("AS-DAEMON-1b: the auto-start IIFE call site no longer passes the unfiltered resolvedAgents to manager.startAll", () => {
    // Find the auto-start IIFE block. It contains the literal log message
    // "all agents auto-started" and lives in startDaemon (NOT routeMethod's
    // start-all IPC, which intentionally takes the unfiltered configs).
    const autoStartLogIdx = DAEMON_SRC.indexOf('"all agents auto-started"');
    expect(autoStartLogIdx).toBeGreaterThan(-1);
    // Look at the 600 chars BEFORE the log line — the startAll call is in
    // there. It must NOT pass `resolvedAgents` directly; it must reference
    // a filtered name (we accept `autoStartAgents` or any name carrying a
    // `.filter` clause referencing autoStart).
    const window = DAEMON_SRC.slice(
      Math.max(0, autoStartLogIdx - 600),
      autoStartLogIdx,
    );
    expect(window).toMatch(/manager\.startAll\(/);
    // The argument to startAll in this window must NOT be the bare
    // `resolvedAgents` identifier — it must be a filtered variable.
    expect(window).not.toMatch(/manager\.startAll\(\s*resolvedAgents\s*\)/);
  });

  it("AS-DAEMON-2: the start <name> IPC handler still resolves configs via configs.find — operator can manually start a dormant agent", () => {
    // The `start` IPC case (NOT start-all) does configs.find((c) => c.name === name).
    // This test pins that the manual-start path is preserved (no filter)
    // so an autoStart=false agent's config is still findable for on-demand
    // boot via `clawcode start <name>`.
    expect(DAEMON_SRC).toMatch(
      /case\s+"start":\s*\{[\s\S]*?configs\.find\(\(c\)\s*=>\s*c\.name\s*===\s*name\)/,
    );
  });

  it("AS-DAEMON-3: structured log when an agent is skipped due to autoStart=false (not a silent skip)", () => {
    // The skip branch must emit log.info (or log.debug) with at least the
    // agent name so operators can see why an agent didn't boot.
    // Acceptable shapes:
    //   log.info({ agent: cfg.name }, "...autoStart=false...")
    //   log.info({ agent }, "skipping ... autoStart=false")
    expect(DAEMON_SRC).toMatch(/autoStart=false|autoStart\s*=\s*false/i);
  });
});
