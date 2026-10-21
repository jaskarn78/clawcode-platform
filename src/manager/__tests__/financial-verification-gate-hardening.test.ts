/**
 * 2026-07-31 — verification-whitelist hardening + maxVerifyHops override
 * tests, plus the production-path recording pin.
 *
 * Root cause of the fin-client incident: `Turn.recordToolCallName` was only
 * called from dead code, so the gate saw `verificationToolsCalled: []` on
 * every prod check — and even with recording fixed, case-sensitive
 * matching could never see the SDK-native `WebSearch`.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  VERIFICATION_TOOL_SUBSTRINGS,
  evaluateVerification,
} from "../financial-verification-gate.js";

const FINANCIAL = "The 10-year Treasury yield is 4.25% right now." // 2026-08-27: lone % no longer fires; `yield` corroborates;

function evalWith(
  toolCallNames: readonly string[],
  extra?: { verifyHopCount?: number; maxVerifyHops?: number },
) {
  return evaluateVerification({
    response: FINANCIAL,
    toolCallNames,
    verifyHopCount: extra?.verifyHopCount ?? 0,
    ...(extra?.maxVerifyHops !== undefined
      ? { maxVerifyHops: extra.maxVerifyHops }
      : {}),
  });
}

describe("whitelist hardening — case-insensitive matching", () => {
  it("native `WebSearch` (CamelCase) now counts as verification", () => {
    const r = evalWith(["WebSearch"]);
    expect(r.action).toBe("none");
    expect(r.verificationToolsCalled).toEqual(["WebSearch"]);
  });

  it("mixed-case MCP name `mcp__Finnhub__quote` counts", () => {
    expect(evalWith(["mcp__Finnhub__quote"]).action).toBe("none");
  });

  it("`mcp__brave-search__search` counts via the server-name substring", () => {
    expect(evalWith(["mcp__brave-search__search"]).action).toBe("none");
  });

  it("memory/doc search tools do NOT count (bare `search` deliberately absent)", () => {
    for (const name of [
      "clawcode_memory_search",
      "search_documents",
      "ToolSearch",
      "mcp__memory__search_files",
    ]) {
      const r = evalWith([name]);
      expect(r.action).toBe("re-prompt");
      expect(r.verificationToolsCalled).toEqual([]);
    }
  });

  it("whitelist pins websearch + brave-search entries (static)", () => {
    expect(VERIFICATION_TOOL_SUBSTRINGS).toContain("websearch");
    expect(VERIFICATION_TOOL_SUBSTRINGS).toContain("brave-search");
    expect(VERIFICATION_TOOL_SUBSTRINGS).not.toContain("search");
    expect(VERIFICATION_TOOL_SUBSTRINGS.length).toBeGreaterThan(0);
  });
});

describe("maxVerifyHops override", () => {
  it("0 → telemetry-only: financial+unverified goes straight to hop-exhausted", () => {
    const r = evalWith([], { maxVerifyHops: 0 });
    expect(r.action).toBe("hop-exhausted");
    expect(r.flagged).toBe(false);
  });

  it("2 → a hop-1 corrective can still re-prompt once more", () => {
    expect(evalWith([], { verifyHopCount: 1, maxVerifyHops: 2 }).action).toBe(
      "re-prompt",
    );
    expect(evalWith([], { verifyHopCount: 2, maxVerifyHops: 2 }).action).toBe(
      "hop-exhausted",
    );
  });

  it("omitted → module default of 1 (unchanged D4 bound)", () => {
    expect(evalWith([], { verifyHopCount: 1 }).action).toBe("hop-exhausted");
  });
});

describe("production recording pin", () => {
  it("persistent-session-handle.ts records tool names (tool_use + server_tool_use)", () => {
    // Static pin in the codebase's established style: the 2026-07-31 root
    // cause was exactly this call being absent from the production handle
    // (it lived only in deprecated wrapSdkQuery dead code).
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      join(here, "..", "persistent-session-handle.ts"),
      "utf-8",
    );
    const count = (src.match(/recordToolCallName\(/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });
});
