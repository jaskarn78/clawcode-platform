/**
 * Phase 999.169 — the scoped supply-chain override. The age guard itself is a
 * CommonJS script; these tests pin its pure allowlist logic and the committed
 * allowlist's shape.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { parseAllowlist } = require("../../../scripts/check-deps-age.cjs") as {
  parseAllowlist: (json: string | null, nowMs: number) => Map<string, { reason: string; expires: string }>;
};

const NOW = Date.parse("2026-09-25T00:00:00Z");

describe("deps-age allowlist", () => {
  it("keeps only unexpired exact entries", () => {
    const m = parseAllowlist(
      JSON.stringify({
        entries: [
          { package: "a@1.0.0", reason: "r", expires: "2026-10-01T00:00:00Z" },
          { package: "b@2.0.0", reason: "r", expires: "2026-09-01T00:00:00Z" },
        ],
      }),
      NOW,
    );
    expect([...m.keys()]).toEqual(["a@1.0.0"]);
  });

  it("a missing file is an empty list", () => {
    expect(parseAllowlist(null, NOW).size).toBe(0);
  });

  it("a malformed entry throws instead of silently changing the guard", () => {
    expect(() => parseAllowlist(JSON.stringify({ entries: [{ package: "a@1" }] }), NOW)).toThrow(/malformed/);
    expect(() => parseAllowlist(JSON.stringify({ entries: [{ package: "a@1", reason: "r", expires: "soon" }] }), NOW)).toThrow(
      /bad expires/,
    );
  });

  it("the committed allowlist names exactly the SDK pair's packages, each with a reason and a near expiry", () => {
    const raw = readFileSync("scripts/deps-age-allow.json", "utf8");
    const doc = JSON.parse(raw) as { entries: Array<{ package: string; reason: string; expires: string }> };
    for (const e of doc.entries) {
      expect(e.package).toMatch(/^@anthropic-ai\/claude-agent-sdk(-[a-z0-9-]+)?@\d+\.\d+\.\d+$/);
      expect(e.reason.length).toBeGreaterThan(20);
      // An allowlist entry is a short bridge over the 7-day window, never a standing exemption.
      expect(Date.parse(e.expires) - NOW).toBeLessThan(14 * 24 * 60 * 60 * 1000);
    }
  });
});
