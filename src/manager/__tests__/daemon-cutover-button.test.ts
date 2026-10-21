/**
 * Phase 92 Plan 04 Task 1 — daemon cutover-button-action IPC tests (RED).
 *
 * Pins:
 *   D1: IPC routing — daemon-side handleCutoverButtonActionIpc receives
 *       params {customId, ...} and returns a serialized DestructiveButtonOutcome.
 *   D2: customId namespace collision regression — parseCutoverButtonCustomId
 *       returns null for ALL existing prefix shapes (model-confirm:, model-cancel:,
 *       skills-picker:, plugins-picker:, marketplace-skills-confirm:, cancel:,
 *       modal-, skills-action-confirm:, plugin-confirm-x:) and NON-null only
 *       for cutover-* shape. CRITICAL — this is the safety floor that lets
 *       slash-commands.ts route button events with prefix-startsWith filtering
 *       without mis-routing other plans' buttons.
 *   D3: IPC method registration — IPC_METHODS array includes the literal
 *       strings "cutover-verify-summary" and "cutover-button-action".
 */
import { describe, it, expect } from "vitest";

import {
  parseCutoverButtonCustomId,
  CUTOVER_BUTTON_PREFIX,
} from "../../cutover/types.js";
import { IPC_METHODS } from "../../ipc/protocol.js";
import {
  handleCutoverButtonActionIpc,
  type CutoverButtonActionIpcDeps,
} from "../daemon.js";
import pino from "pino";
import type { DestructiveCutoverGap } from "../../cutover/types.js";

describe("Phase 92-04 daemon cutover-button-action IPC", () => {
  it("D1 IPC routing: handleCutoverButtonActionIpc returns serialized outcome", async () => {
    // Stub gap resolver — returns a synthetic outdated-memory-file gap so the
    // button-handler dispatches Defer to the deferred branch (no fs/network IO).
    const synthGap: DestructiveCutoverGap = {
      kind: "outdated-memory-file",
      identifier: "memory/foo.md",
      severity: "destructive",
      sourceRef: { path: "memory/foo.md", sourceHash: "src" },
      targetRef: { path: "memory/foo.md", targetHash: "tgt" },
    };
    const deps: CutoverButtonActionIpcDeps = {
      gapById: async () => synthGap,
      applierDeps: {
        agent: "fin-client",
        clawcodeYamlPath: "/tmp/clawcode.yaml",
        memoryRoot: "/tmp/memory",
        openClawHost: "host",
        openClawWorkspace: "/ws",
        ledgerPath: "/tmp/ledger.jsonl",
        runRsync: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        log: pino({ level: "silent" }),
      },
      log: pino({ level: "silent" }),
    };

    const outcome = await handleCutoverButtonActionIpc(
      { customId: "cutover-fin-client-abc:defer" },
      deps,
    );

    // Defer path: deterministic, no side effects, no ledger writes
    expect(outcome.kind).toBe("deferred");
    if (outcome.kind === "deferred") {
      expect(outcome.agent).toBe("fin-client");
      expect(outcome.gapKind).toBe("outdated-memory-file");
    }
  });

  describe("D2 customId namespace collision regression", () => {
    // EVERY existing prefix shape in the codebase. Adding a new namespace
    // requires extending this list to keep the regression tight.
    const EXISTING_PREFIXES_NULL = [
      "model-confirm:fin:n",
      "model-cancel:fin:n",
      "skills-picker:fin:n",
      "plugins-picker:fin:n",
      "marketplace-skills-confirm:fin:n",
      "cancel:abc",
      "modal-1:fin",
      "skills-action-confirm:fin:n",
      "plugin-confirm-x:fin:n",
    ];

    it.each(EXISTING_PREFIXES_NULL)(
      "returns null for non-cutover prefix: %s",
      (cid) => {
        expect(parseCutoverButtonCustomId(cid)).toBeNull();
      },
    );

    it("returns NON-null for the cutover-fin-client-abc:accept shape", () => {
      const parsed = parseCutoverButtonCustomId(
        "cutover-fin-client-abc:accept",
      );
      expect(parsed).not.toBeNull();
      expect(parsed?.agent).toBe("fin-client");
      expect(parsed?.gapId).toBe("abc");
      expect(parsed?.action).toBe("accept");
    });

    it("returns null for malformed cutover- shapes", () => {
      // Missing colon
      expect(parseCutoverButtonCustomId("cutover-fin-abc")).toBeNull();
      // Invalid action
      expect(parseCutoverButtonCustomId("cutover-fin-abc:bogus")).toBeNull();
      // Missing hyphen between agent and gapId
      expect(parseCutoverButtonCustomId("cutover-onlyagent:accept")).toBeNull();
      // Empty body
      expect(parseCutoverButtonCustomId("cutover-:accept")).toBeNull();
    });

    it("CUTOVER_BUTTON_PREFIX is exactly 'cutover-' (regression pin)", () => {
      expect(CUTOVER_BUTTON_PREFIX).toBe("cutover-");
    });
  });

  it("D3 IPC method registration: IPC_METHODS includes both cutover methods", () => {
    expect(IPC_METHODS).toContain("cutover-verify-summary");
    expect(IPC_METHODS).toContain("cutover-button-action");
  });
});
