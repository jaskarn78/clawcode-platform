/**
 * Plan 117-05 — `PortableForkAdvisor` scaffold tests.
 *
 * The scaffold has no logic to exercise; the contract is:
 *   (a) `id` is the `"portable-fork"` literal (matches `BackendId`).
 *   (b) `consult()` rejects with the documented Phase 118 deferred error.
 *
 * See:
 *   - `src/advisor/backends/portable-fork.ts` (file-level docs for the
 *     intended Phase 118 implementation scope).
 *   - `.planning/phases/117-claude-code-advisor-pattern-multi-backend-scaffold-anthropic/117-RESEARCH.md`
 *     §5 Plan 117-05 — single test asserts `consult()` throws.
 */

import { describe, it, expect } from "vitest";
import { PortableForkAdvisor } from "../portable-fork.js";

describe("PortableForkAdvisor", () => {
  it("consult() throws the documented Phase 118 error", async () => {
    const advisor = new PortableForkAdvisor();
    await expect(
      advisor.consult({
        agent: "x",
        question: "q",
        systemPrompt: "sp",
        advisorModel: "claude-opus-4-8",
      }),
    ).rejects.toThrow(/PortableForkAdvisor not implemented.*Phase 118/i);
  });

  it("id === 'portable-fork'", () => {
    expect(new PortableForkAdvisor().id).toBe("portable-fork");
  });
});
