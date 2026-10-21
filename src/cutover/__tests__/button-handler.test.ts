/**
 * Phase 92 Plan 04 Task 1 — button-handler tests (RED).
 *
 * Pins:
 *   B1: Accept-applies — applyDestructiveFix called with gap; returns
 *                        accepted-applied with the row from the applier
 *   B2: Reject-logs    — appendCutoverRow called with reject-destructive
 *                        action; applyDestructiveFix NEVER called
 *   B3: Defer-noop     — appendCutoverRow NEVER called; applyDestructiveFix
 *                        NEVER called; outcome.kind === "deferred"
 *   B4: invalid-customId (non-cutover prefix) — outcome.kind === "invalid-customId";
 *                        no side effects
 *   B5: gap-not-found — customId valid but gapById returns null →
 *                        outcome.kind === "invalid-customId"; no side effects
 *   B6: Accept-but-applier-fails — outcome.kind === "accepted-apply-failed";
 *                        ledger row appended for failure-audit (action:
 *                        "apply-destructive", reason: "failed: <error>") so
 *                        operators can see attempted-but-failed applies in
 *                        the audit trail. Decision: log it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import pino from "pino";

import { handleCutoverButtonInteraction } from "../button-handler.js";
import type { ButtonHandlerDeps } from "../button-handler.js";
import type {
  DestructiveCutoverGap,
  CutoverLedgerRow,
} from "../types.js";

// Mock the applier + ledger modules — both come from `../destructive-applier.js`
// and `../ledger.js`. Hoisted vi.mock with factory captures mutable refs.
const applyDestructiveFixMock = vi.fn();
const appendCutoverRowMock = vi.fn();

vi.mock("../destructive-applier.js", () => ({
  applyDestructiveFix: (...args: unknown[]) => applyDestructiveFixMock(...args),
}));

vi.mock("../ledger.js", () => ({
  appendCutoverRow: (...args: unknown[]) => appendCutoverRowMock(...args),
}));

const TEST_AGENT = "fin-client";
const TEST_GAP_ID = "abc123def456";

const synthGap: DestructiveCutoverGap = {
  kind: "outdated-memory-file",
  identifier: "memory/foo.md",
  severity: "destructive",
  sourceRef: { path: "memory/foo.md", sourceHash: "src-hash-x" },
  targetRef: { path: "memory/foo.md", targetHash: "tgt-hash-y" },
};

const validRow: CutoverLedgerRow = {
  timestamp: "2026-04-25T01:00:00Z",
  agent: TEST_AGENT,
  action: "apply-destructive",
  kind: "outdated-memory-file",
  identifier: "memory/foo.md",
  sourceHash: "src-hash-x",
  targetHash: "tgt-hash-y",
  reversible: true,
  rolledBack: false,
  preChangeSnapshot: "H4sIAAAAAA==",
  reason: null,
};

function makeInteraction(customId: string): {
  customId: string;
  user: { id: string };
} {
  return {
    customId,
    user: { id: "operator-1" },
  };
}

function makeDeps(): ButtonHandlerDeps {
  return {
    applierDeps: {
      agent: TEST_AGENT,
      clawcodeYamlPath: "/tmp/clawcode.yaml",
      memoryRoot: "/tmp/memory",
      openClawHost: "openclaw.example",
      openClawWorkspace: "/openclaw/ws",
      ledgerPath: "/tmp/ledger.jsonl",
      runRsync: vi.fn(),
      log: pino({ level: "silent" }),
    },
    gapById: vi.fn(async (agent: string, gapId: string) => {
      if (agent === TEST_AGENT && gapId === TEST_GAP_ID) return synthGap;
      return null;
    }),
    log: pino({ level: "silent" }),
  };
}

describe("handleCutoverButtonInteraction", () => {
  beforeEach(() => {
    applyDestructiveFixMock.mockReset();
    appendCutoverRowMock.mockReset();
  });

  it("B1 Accept-applies: invokes applyDestructiveFix; returns accepted-applied", async () => {
    applyDestructiveFixMock.mockResolvedValue({ kind: "applied", row: validRow });
    const deps = makeDeps();
    const customId = `cutover-${TEST_AGENT}-${TEST_GAP_ID}:accept`;

    const outcome = await handleCutoverButtonInteraction(
      makeInteraction(customId) as never,
      deps,
    );

    expect(outcome.kind).toBe("accepted-applied");
    if (outcome.kind === "accepted-applied") {
      expect(outcome.agent).toBe(TEST_AGENT);
      expect(outcome.gapKind).toBe("outdated-memory-file");
      expect(outcome.identifier).toBe("memory/foo.md");
      expect(outcome.ledgerRow).toEqual(validRow);
    }
    expect(applyDestructiveFixMock).toHaveBeenCalledTimes(1);
    // Applier owns its own ledger row write — handler does NOT double-append on success
    expect(appendCutoverRowMock).toHaveBeenCalledTimes(0);
  });

  it("B2 Reject-logs: appendCutoverRow called once; applyDestructiveFix NEVER called", async () => {
    const deps = makeDeps();
    const customId = `cutover-${TEST_AGENT}-${TEST_GAP_ID}:reject`;

    const outcome = await handleCutoverButtonInteraction(
      makeInteraction(customId) as never,
      deps,
    );

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.ledgerRow.action).toBe("reject-destructive");
      expect(outcome.ledgerRow.reversible).toBe(true);
      expect(outcome.ledgerRow.preChangeSnapshot).toBeNull();
      expect(outcome.ledgerRow.reason).toMatch(/operator-rejected/i);
    }
    expect(appendCutoverRowMock).toHaveBeenCalledTimes(1);
    expect(applyDestructiveFixMock).toHaveBeenCalledTimes(0);
  });

  it("B3 Defer-noop: NO appendCutoverRow, NO applyDestructiveFix", async () => {
    const deps = makeDeps();
    const customId = `cutover-${TEST_AGENT}-${TEST_GAP_ID}:defer`;

    const outcome = await handleCutoverButtonInteraction(
      makeInteraction(customId) as never,
      deps,
    );

    expect(outcome.kind).toBe("deferred");
    expect(appendCutoverRowMock).toHaveBeenCalledTimes(0);
    expect(applyDestructiveFixMock).toHaveBeenCalledTimes(0);
  });

  it("B4 invalid-customId (non-cutover prefix): no side effects", async () => {
    const deps = makeDeps();
    const customId = "model-confirm:fin:nonce-abc";

    const outcome = await handleCutoverButtonInteraction(
      makeInteraction(customId) as never,
      deps,
    );

    expect(outcome.kind).toBe("invalid-customId");
    expect(appendCutoverRowMock).toHaveBeenCalledTimes(0);
    expect(applyDestructiveFixMock).toHaveBeenCalledTimes(0);
  });

  it("B5 gap-not-found: customId parses but gapById returns null → invalid-customId", async () => {
    const deps = makeDeps();
    const customId = `cutover-${TEST_AGENT}-not-a-real-gap:accept`;

    const outcome = await handleCutoverButtonInteraction(
      makeInteraction(customId) as never,
      deps,
    );

    expect(outcome.kind).toBe("invalid-customId");
    expect(appendCutoverRowMock).toHaveBeenCalledTimes(0);
    expect(applyDestructiveFixMock).toHaveBeenCalledTimes(0);
  });

  it("B6 Accept-but-applier-fails: outcome accepted-apply-failed + audit row appended", async () => {
    applyDestructiveFixMock.mockResolvedValue({
      kind: "failed",
      error: "rsync exit 1: connection refused",
    });
    const deps = makeDeps();
    const customId = `cutover-${TEST_AGENT}-${TEST_GAP_ID}:accept`;

    const outcome = await handleCutoverButtonInteraction(
      makeInteraction(customId) as never,
      deps,
    );

    expect(outcome.kind).toBe("accepted-apply-failed");
    if (outcome.kind === "accepted-apply-failed") {
      expect(outcome.error).toContain("rsync exit 1");
    }
    // Audit row pinned: failed apply IS logged for operator visibility
    expect(appendCutoverRowMock).toHaveBeenCalledTimes(1);
    const auditRow = appendCutoverRowMock.mock.calls[0]![1] as CutoverLedgerRow;
    expect(auditRow.action).toBe("apply-destructive");
    expect(auditRow.reason).toContain("failed:");
    expect(auditRow.reversible).toBe(false);
    expect(auditRow.preChangeSnapshot).toBeNull();
  });
});
