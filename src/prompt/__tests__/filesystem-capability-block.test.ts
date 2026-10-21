/**
 * Phase 96 Plan 02 Task 1 (RED) — filesystem-capability-block pure renderer.
 *
 * 10 tests pin the rendering contract:
 *   RF-EMPTY              — empty snapshot ⇒ empty string (v2.5 cache-stability)
 *   RF-MY-WORKSPACE       — entry under agentWorkspaceRoot ⇒ "My workspace" section
 *   RF-OPERATOR-SHARED    — entry NOT under root with mode=ro ⇒ "Operator-shared" section
 *   RF-OFF-LIMITS-ALWAYS  — when block renders, "Off-limits" subsection ALWAYS present
 *   RF-DEGRADED-HIDDEN    — degraded entry excluded from rendered output
 *   RF-UNKNOWN-HIDDEN     — unknown entry excluded (conservative — don't advertise unproven)
 *   RF-IDEMPOTENT         — same input ⇒ deep-equal output (cache-stability)
 *   RF-SORTED             — entries within subsection sorted ASCII-asc by canonicalPath
 *   RF-FLAP-STICKY        — sticky-degraded path within 5-min window ⇒ excluded
 *   RF-BUDGET             — 10 ready entries ⇒ output ≤ 2000 chars (~500 tokens)
 *
 * Contract: the renderer is PURE (no fs / SDK / Date) and consumes a
 * ReadonlyMap<canonicalPath, FsCapabilitySnapshot> + agent workspace root +
 * optional flap-history Map. Empty snapshot strictly produces empty string —
 * NO minimal placeholder block (W-4 ambiguity removed in PLAN.md).
 */

import { describe, expect, it } from "vitest";
import {
  FS_FLAP_TRANSITION_THRESHOLD,
  FS_FLAP_WINDOW_MS,
  type FlapHistoryEntry,
  isFsEntryAdvertisable,
  renderFilesystemCapabilityBlock,
} from "../filesystem-capability-block.js";
import type { FsCapabilitySnapshot } from "../../manager/persistent-session-handle.js";

const AGENT_ROOT = "/home/clawcode/.clawcode/agents/fin-client";
const FIXED_NOW = new Date("2026-04-25T18:30:00Z");

function ready(modeOverride: "rw" | "ro" = "ro"): FsCapabilitySnapshot {
  return {
    status: "ready",
    mode: modeOverride,
    lastProbeAt: "2026-04-25T18:29:00Z",
    lastSuccessAt: "2026-04-25T18:29:00Z",
  };
}

function degraded(): FsCapabilitySnapshot {
  return {
    status: "degraded",
    mode: "denied",
    lastProbeAt: "2026-04-25T18:29:00Z",
    error: "EACCES: permission denied",
  };
}

function unknown(): FsCapabilitySnapshot {
  return {
    status: "unknown",
    mode: "denied",
    lastProbeAt: "2026-04-25T18:29:00Z",
  };
}

describe("renderFilesystemCapabilityBlock — Phase 96 Plan 02 (D-02)", () => {
  it("RF-EMPTY: empty snapshot ⇒ empty string (v2.5 cache-stability invariant; NO minimal placeholder block)", () => {
    const snapshot = new Map<string, FsCapabilitySnapshot>();
    const out = renderFilesystemCapabilityBlock(snapshot, AGENT_ROOT, {
      now: () => FIXED_NOW,
    });
    expect(out).toBe("");
  });

  it("RF-MY-WORKSPACE: ready entry under agentWorkspaceRoot ⇒ My workspace (full RW) subsection", () => {
    const snapshot = new Map<string, FsCapabilitySnapshot>([
      [AGENT_ROOT, ready("rw")],
    ]);
    const out = renderFilesystemCapabilityBlock(snapshot, AGENT_ROOT, {
      now: () => FIXED_NOW,
    });
    expect(out).toContain("<filesystem_capability>");
    expect(out).toContain("</filesystem_capability>");
    expect(out).toContain("## My workspace (full RW)");
    expect(out).toContain(`- ${AGENT_ROOT}`);
  });

  it("RF-OPERATOR-SHARED: ready RO entry NOT under root ⇒ Operator-shared paths subsection", () => {
    const sharedPath = "/home/example-user/.openclaw/workspace-acme";
    const snapshot = new Map<string, FsCapabilitySnapshot>([
      [sharedPath, ready("ro")],
    ]);
    const out = renderFilesystemCapabilityBlock(snapshot, AGENT_ROOT, {
      now: () => FIXED_NOW,
    });
    expect(out).toContain("## Operator-shared paths (per ACL)");
    expect(out).toContain(`- ${sharedPath} (RO, ACL)`);
  });

  it("RF-OFF-LIMITS-ALWAYS: when subsections 1+2 BOTH have entries, Off-limits subsection STILL renders", () => {
    const snapshot = new Map<string, FsCapabilitySnapshot>([
      [AGENT_ROOT, ready("rw")],
      ["/home/example-user/.openclaw/workspace-acme", ready("ro")],
    ]);
    const out = renderFilesystemCapabilityBlock(snapshot, AGENT_ROOT, {
      now: () => FIXED_NOW,
    });
    expect(out).toContain("## Off-limits — do not attempt");
    expect(out).toContain("- Anything outside the above.");
  });

  it("RF-DEGRADED-HIDDEN: degraded entry excluded from rendered block (LLM never sees broken paths)", () => {
    const sharedPath = "/home/example-user/.openclaw/workspace-acme";
    const snapshot = new Map<string, FsCapabilitySnapshot>([
      [AGENT_ROOT, ready("rw")],
      [sharedPath, degraded()],
    ]);
    const out = renderFilesystemCapabilityBlock(snapshot, AGENT_ROOT, {
      now: () => FIXED_NOW,
    });
    expect(out).not.toContain(sharedPath);
    expect(out).not.toContain("workspace-acme");
  });

  it("RF-UNKNOWN-HIDDEN: status='unknown' entry excluded (conservative — don't advertise unproven)", () => {
    const sharedPath = "/home/example-user/.openclaw/workspace-coding";
    const snapshot = new Map<string, FsCapabilitySnapshot>([
      [AGENT_ROOT, ready("rw")],
      [sharedPath, unknown()],
    ]);
    const out = renderFilesystemCapabilityBlock(snapshot, AGENT_ROOT, {
      now: () => FIXED_NOW,
    });
    expect(out).not.toContain("workspace-coding");
  });

  it("RF-IDEMPOTENT: same inputs ⇒ deep-equal outputs across two calls (cache-stability)", () => {
    const sharedPath = "/home/example-user/.openclaw/workspace-acme";
    const snapshot = new Map<string, FsCapabilitySnapshot>([
      [AGENT_ROOT, ready("rw")],
      [sharedPath, ready("ro")],
    ]);
    const out1 = renderFilesystemCapabilityBlock(snapshot, AGENT_ROOT, {
      now: () => FIXED_NOW,
    });
    const out2 = renderFilesystemCapabilityBlock(snapshot, AGENT_ROOT, {
      now: () => FIXED_NOW,
    });
    expect(out1).toEqual(out2);
    expect(out1).toBe(out2);
  });

  it("RF-SORTED: 3 ready Operator-shared entries rendered in ASCII-ascending order (deterministic for cache-stability)", () => {
    const snapshot = new Map<string, FsCapabilitySnapshot>([
      ["/zeta/path", ready("ro")],
      ["/alpha/path", ready("ro")],
      ["/middle/path", ready("ro")],
    ]);
    const out = renderFilesystemCapabilityBlock(snapshot, AGENT_ROOT, {
      now: () => FIXED_NOW,
    });
    const alphaIdx = out.indexOf("/alpha/path");
    const middleIdx = out.indexOf("/middle/path");
    const zetaIdx = out.indexOf("/zeta/path");
    expect(alphaIdx).toBeGreaterThan(-1);
    expect(middleIdx).toBeGreaterThan(alphaIdx);
    expect(zetaIdx).toBeGreaterThan(middleIdx);
  });

  it("RF-FLAP-STICKY: sticky-degraded path within 5-min window ⇒ excluded even if currently 'ready'", () => {
    const sharedPath = "/home/example-user/.openclaw/workspace-acme";
    const snapshot = new Map<string, FsCapabilitySnapshot>([
      [AGENT_ROOT, ready("rw")],
      [sharedPath, ready("ro")],
    ]);
    // Build a flap-history entry that's BOTH sticky-degraded AND inside the
    // 5-min window (windowStart 2 minutes ago, FIXED_NOW = 18:30:00Z).
    const flapHistory = new Map<string, FlapHistoryEntry>([
      [
        sharedPath,
        Object.freeze({
          windowStart: "2026-04-25T18:28:00Z", // 2min before FIXED_NOW
          transitions: 4,
          stickyDegraded: true,
        }),
      ],
    ]);
    const out = renderFilesystemCapabilityBlock(snapshot, AGENT_ROOT, {
      now: () => FIXED_NOW,
      flapHistory,
    });
    expect(out).not.toContain("workspace-acme");
    // 5-min window + 3-transition threshold pinned by exported constants
    expect(FS_FLAP_WINDOW_MS).toBe(5 * 60 * 1000);
    expect(FS_FLAP_TRANSITION_THRESHOLD).toBe(3);
  });

  it("RF-BUDGET: 10 ready entries ⇒ rendered output ≤ 2000 chars (~500 tokens — Phase 53 stable-prefix invariant)", () => {
    const entries: Array<[string, FsCapabilitySnapshot]> = [];
    for (let i = 0; i < 5; i++) {
      entries.push([`${AGENT_ROOT}/sub-${i}`, ready("rw")]);
    }
    for (let i = 0; i < 5; i++) {
      entries.push([`/home/operator/shared-path-${i}`, ready("ro")]);
    }
    const snapshot = new Map<string, FsCapabilitySnapshot>(entries);
    const out = renderFilesystemCapabilityBlock(snapshot, AGENT_ROOT, {
      now: () => FIXED_NOW,
    });
    expect(out.length).toBeLessThanOrEqual(2000);
    // sanity: block rendered (not empty) and contains all sections
    expect(out).toContain("## My workspace (full RW)");
    expect(out).toContain("## Operator-shared paths (per ACL)");
    expect(out).toContain("## Off-limits");
  });
});

// ── isFsEntryAdvertisable helper coverage (auxiliary unit pin) ───────────
describe("isFsEntryAdvertisable — pure helper used by the renderer", () => {
  it("returns true for status='ready' with no flap history", () => {
    expect(
      isFsEntryAdvertisable("/some/path", ready("ro"), undefined, FIXED_NOW),
    ).toBe(true);
  });

  it("returns false for status='degraded'", () => {
    expect(
      isFsEntryAdvertisable("/some/path", degraded(), undefined, FIXED_NOW),
    ).toBe(false);
  });

  it("returns false for sticky-degraded entry within 5-min window even when status='ready'", () => {
    const flapHistory = new Map<string, FlapHistoryEntry>([
      [
        "/some/path",
        Object.freeze({
          windowStart: "2026-04-25T18:28:00Z",
          transitions: 4,
          stickyDegraded: true,
        }),
      ],
    ]);
    expect(
      isFsEntryAdvertisable("/some/path", ready("ro"), flapHistory, FIXED_NOW),
    ).toBe(false);
  });
});
