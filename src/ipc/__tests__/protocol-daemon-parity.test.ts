/**
 * Phase 116-postdeploy 2026-05-12 — sentinel test against IPC allowlist drift.
 *
 * The drift bug class:
 *   Daemon ships a new IPC handler (`case "xyz":` in one of the two
 *   `switch (method)` blocks in daemon.ts) but the protocol-level
 *   allowlist at `src/ipc/protocol.ts` (`IPC_METHODS` array) doesn't
 *   include the new method name. The Zod schema at
 *   `ipcRequestSchema.method = z.enum(IPC_METHODS)` then rejects the
 *   request as `Invalid Request` before the dispatcher ever reaches
 *   the case handler. The handler appears reachable in source — it is
 *   not in production.
 *
 * Known historical instances:
 *   1. Phase 999.15  → `mcp-tracker` returned "Invalid Request" post-deploy
 *      (carried in STATE.md "Open Bugs (post-999.15 deploy)" for weeks).
 *   2. Phase 115-08  → `tool-latency-audit` returned "Invalid Request"
 *      (surfaced during the Phase 999.7 audit on 2026-05-11).
 *   3. Phase 116-postdeploy 2026-05-11 → `list-rate-limit-snapshots-fleet`
 *      returned "Invalid Request" on the live /api/usage probe
 *      (commit `ec530d7` allowlisted it after the deploy).
 *
 * This test pins the invariant:
 *   Every `case "xyz":` in either `switch (method) { ... }` block in
 *   `src/manager/daemon.ts` must have a matching string entry in
 *   `IPC_METHODS` from `src/ipc/protocol.ts`.
 *
 * Nested switches inside the IPC switch (e.g. `switch (row.status)` for
 * task-state-machine values, `switch (period)` for time-period buckets)
 * are skipped — only cases that live at depth-1 inside the IPC switch
 * itself are part of the invariant.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { IPC_METHODS } from "../protocol.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const DAEMON_PATH = path.join(REPO_ROOT, "src", "manager", "daemon.ts");

/**
 * Values that appear inside nested switches inside the IPC switch but
 * are NOT themselves IPC method names. These come from the daemon's
 * `switch (period)` (today/weekly/total/etc — `case "costs"` usage
 * aggregator) and `switch (row.status)` (cancelled/complete/failed/etc
 * — task state machine reconciliation). The brace-counting extractor
 * below can't reliably tell case-block closing braces apart from
 * nested-switch closing braces, so we maintain an explicit exclusion
 * list and document the intent.
 *
 * If you add a NEW real IPC method whose name collides with one of
 * these values, REMOVE it from this list (the forcing function).
 */
const KNOWN_NON_IPC_CASE_VALUES = new Set<string>([
  // Task-state-machine values inside `switch (row.status)` at ~line 5594
  "cancelled",
  "complete",
  "failed",
  "orphaned",
  "pending",
  "running",
  // Period values inside `switch (period)` at ~lines 8517 + 9582
  "daily",
  "month",
  "session",
  "today",
  "total",
  "week",
  "weekly",
]);

/**
 * Extract case method literals from the two `switch (method) { ... }`
 * blocks in daemon.ts. Filters out the well-known non-IPC values that
 * appear inside nested switches (see `KNOWN_NON_IPC_CASE_VALUES`).
 *
 * Phase 120 Plan 04 — extended to also extract `if (method === "...")`
 * dispatch form. Original case-only extractor missed `tool-latency-audit`
 * (Phase 115-08, dispatched at `daemon.ts:4084` via the `if`-form) and
 * `skill-create` (Phase 47-ish, same form). Same silent-path-bifurcation
 * class as the existing case-form drift this test was built to prevent.
 */
function extractIpcCases(daemonSrc: string): readonly string[] {
  const lines = daemonSrc.split("\n");
  const cases = new Set<string>();
  let inIpcSwitch = false;
  let switchDepth = 0; // 1 = we're inside the outer IPC switch

  const switchOpenRe = /\bswitch\s*\(\s*method\s*\)\s*\{/;
  const caseRe = /^\s*case\s+"([a-z][a-z0-9-]*)"\s*:/;
  // Phase 120 Plan 04 — `if (method === "...")` dispatch form. Some daemon
  // handlers landed via this form (Phase 115-08 tool-latency-audit; older
  // Phase 47 skill-create; OAuth helpers; cutover button). Whole-file scan
  // — these `if` blocks live OUTSIDE the `switch (method) { ... }` blocks.
  // Same z.enum() schema-rejection class if missing from IPC_METHODS.
  const ifMethodRe = /^\s*if\s*\(\s*method\s*===\s*"([a-z][a-z0-9-]*)"/;

  for (const line of lines) {
    // Phase 120 — `if (method === "...")` form lives outside the switch.
    const ifMatch = ifMethodRe.exec(line);
    if (ifMatch && !KNOWN_NON_IPC_CASE_VALUES.has(ifMatch[1]!)) {
      cases.add(ifMatch[1]!);
    }

    if (!inIpcSwitch && switchOpenRe.test(line)) {
      inIpcSwitch = true;
      switchDepth = 1;
      continue;
    }

    if (!inIpcSwitch) continue;

    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;

    const m = caseRe.exec(line);
    if (m && !KNOWN_NON_IPC_CASE_VALUES.has(m[1]!)) {
      cases.add(m[1]!);
    }

    switchDepth += opens - closes;

    // Did this line close the entire IPC switch?
    if (switchDepth <= 0) {
      inIpcSwitch = false;
      switchDepth = 0;
    }
  }

  return Array.from(cases).sort();
}

describe("IPC allowlist parity with daemon switch cases", () => {
  const daemonSrc = readFileSync(DAEMON_PATH, "utf-8");
  const ipcCases = extractIpcCases(daemonSrc);
  const allowlist = new Set<string>(IPC_METHODS);

  it("extracts at least 100 IPC cases from daemon.ts (sanity)", () => {
    // The daemon has 100+ IPC methods spanning Phase 33 through 116.
    // If the extractor returns < 50 cases, the regex/state-machine has
    // regressed and the assertion below is meaningless.
    expect(ipcCases.length).toBeGreaterThan(50);
  });

  it("every IPC case in daemon.ts is in IPC_METHODS allowlist", () => {
    const drift = ipcCases.filter((m) => !allowlist.has(m));

    if (drift.length > 0) {
      const msg = [
        "",
        "DRIFT: the following daemon.ts `switch (method)` cases are NOT in",
        "the IPC_METHODS allowlist at src/ipc/protocol.ts. The Zod schema",
        "at ipcRequestSchema rejects them as `Invalid Request` before the",
        "case handler ever runs.",
        "",
        ...drift.map((m) => `  - "${m}"`),
        "",
        "Add each of these as a string entry in IPC_METHODS, with a brief",
        "provenance comment (phase / plan / quick task) matching the",
        "surrounding style.",
        "",
      ].join("\n");
      throw new Error(msg);
    }

    expect(drift).toEqual([]);
  });
});
