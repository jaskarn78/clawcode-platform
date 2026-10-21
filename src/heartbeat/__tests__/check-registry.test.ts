// src/heartbeat/__tests__/check-registry.test.ts
//
// Phase 999.8 Plan 03 — lockstep regression suite for the static heartbeat-check
// registry. Catches three classes of drift:
//   1. Registry size desync (HB-01) — count must equal disk count
//   2. Identity drift (HB-05) — every registered name maps to a real file
//   3. Stowaway drift (HB-05) — every on-disk check file is registered
//
// Pitfall 8 (RESEARCH): use fileURLToPath(import.meta.url) so the test resolves
// the checks directory relative to itself, not relative to vitest's cwd.
import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CHECK_REGISTRY } from "../check-registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const checksDir = join(__dirname, "../checks");

/** Map of registry NAME → expected filename slug. Maintained by hand
 *  alongside check-registry.ts so a missing entry fails this test. */
const EXPECTED_FILENAMES: ReadonlyMap<string, string> = new Map([
  ["attachment-cleanup", "attachment-cleanup.ts"],
  // P1-RESCAN — periodic auto-ingest inbox rescan.
  ["auto-ingest-rescan", "auto-ingest-rescan.ts"],
  ["auto-linker", "auto-linker.ts"],
  ["consolidation", "consolidation.ts"],
  ["context-fill", "context-fill.ts"],
  ["fs-probe", "fs-probe.ts"],
  // Phase 999.47 Plan 02 — fleet-level hourly homelab inventory refresh.
  ["homelab-refresh", "homelab-refresh.ts"],
  ["inbox", "inbox.ts"],
  // Phase 108 — pool liveness probe for OnePasswordMcpBroker.
  ["mcp-broker", "mcp-broker.ts"],
  ["mcp-reconnect", "mcp-reconnect.ts"],
  // Phase 999.122 — read-only memory census for /api/health.
  ["memory-census", "memory-census.ts"],
  // 2026-06-18 — daily-session-log materialiser (consolidation input).
  ["session-log-flush", "session-log-flush.ts"],
  // Phase 999.119 pass 2 — daily conversation_sessions hygiene.
  ["session-retention", "session-retention.ts"],
  // Phase 99-C — drains the per-agent pending session-summary backlog.
  // 2026-09-24 — in-place reconnect of ssh-stdio MCP servers (Mac nodes).
  ["remote-mcp-reconnect", "remote-mcp-reconnect.ts"],
  ["summarize-pending", "summarize-pending.ts"],
  ["task-retention", "task-retention.ts"],
  ["thread-idle", "thread-idle.ts"],
  ["tier-maintenance", "tier-maintenance.ts"],
  ["trace-retention", "trace-retention.ts"],
]);

describe("CHECK_REGISTRY ↔ disk lockstep", () => {
  it("registers all 19 known checks", () => {
    expect(CHECK_REGISTRY).toHaveLength(19);
  });

  it("every CHECK_REGISTRY entry has a unique name", () => {
    const names = CHECK_REGISTRY.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every CHECK_REGISTRY entry corresponds to a file on disk", () => {
    const onDisk = new Set(
      readdirSync(checksDir).filter(
        (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "__tests__",
      ),
    );
    for (const check of CHECK_REGISTRY) {
      const expectedFile = EXPECTED_FILENAMES.get(check.name);
      expect(expectedFile, `unmapped check name '${check.name}'`).toBeDefined();
      expect(onDisk.has(expectedFile!), `missing file ${expectedFile}`).toBe(true);
    }
  });

  it("every check file on disk is registered (drift detector)", () => {
    const onDisk = readdirSync(checksDir).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "__tests__",
    );
    const registered = new Set([...EXPECTED_FILENAMES.values()]);
    for (const f of onDisk) {
      expect(
        registered.has(f),
        `file ${f} is on disk but not in CHECK_REGISTRY — register it in src/heartbeat/check-registry.ts`,
      ).toBe(true);
    }
  });

  it("each registry entry exposes the CheckModule contract", () => {
    for (const check of CHECK_REGISTRY) {
      expect(typeof check.name).toBe("string");
      expect(check.name.length).toBeGreaterThan(0);
      expect(typeof check.execute).toBe("function");
    }
  });
});
