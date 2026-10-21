/**
 * Phase 96 Plan 01 Task 3 — resolveFileAccess loader helper tests.
 *
 * Merges defaults + per-agent override, expands the literal `{agent}`
 * token to the actual agent name, canonicalizes via path.resolve,
 * deduplicates.
 *
 * Tests pin:
 *   - LFA-1   merge + token expansion + canonical resolve + dedupe
 *   - LFA-2   empty agent override → just resolved defaults
 *   - LFA-3   undefined agent + undefined defaults → empty array
 *   - LFA-4   token expansion is global (replaces ALL occurrences)
 */
import { describe, it, expect } from "vitest";

import { resolveFileAccess } from "../loader.js";

describe("resolveFileAccess — Phase 96 D-05 token expansion + dedup", () => {
  it("LFA-1: merge defaults + per-agent override; expand {agent}; dedupe", () => {
    const result = resolveFileAccess(
      "fin-client",
      { fileAccess: ["/home/example-user/.openclaw/workspace-acme/"] },
      { fileAccess: ["/home/clawcode/.clawcode/agents/{agent}/"] },
    );
    expect(result).toEqual([
      "/home/clawcode/.clawcode/agents/fin-client",
      "/home/example-user/.openclaw/workspace-acme",
    ]);
  });

  it("LFA-2: empty agent override → just resolved defaults with token expansion", () => {
    const result = resolveFileAccess(
      "clawdy",
      undefined,
      { fileAccess: ["/home/clawcode/.clawcode/agents/{agent}/"] },
    );
    expect(result).toEqual(["/home/clawcode/.clawcode/agents/clawdy"]);
  });

  it("LFA-3: undefined agent + undefined defaults → empty array", () => {
    const result = resolveFileAccess("x", undefined, undefined);
    expect(result).toEqual([]);
  });

  it("LFA-4: token expansion replaces ALL occurrences", () => {
    const result = resolveFileAccess(
      "alpha",
      { fileAccess: ["/data/{agent}/cache/{agent}/file"] },
      { fileAccess: [] },
    );
    expect(result).toEqual(["/data/alpha/cache/alpha/file"]);
  });

  it("LFA-5: dedupe — same path declared in defaults and per-agent merges to one entry", () => {
    const result = resolveFileAccess(
      "x",
      { fileAccess: ["/shared/path"] },
      { fileAccess: ["/shared/path"] },
    );
    expect(result).toEqual(["/shared/path"]);
    expect(result.length).toBe(1);
  });
});
