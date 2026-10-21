/**
 * Phase 90 Plan 04 Task 1 — schema extension tests (HUB-SCH-1..2).
 *
 * Scoped to this plan to avoid collision with Plan 90-01's concurrent
 * schema.test.ts edits (parallel Wave 1 sibling). Verifies:
 *
 *   HUB-SCH-1  defaultsSchema.parse({}) emits clawhubBaseUrl="https://clawhub.ai"
 *              and clawhubCacheTtlMs=600_000 (D-05 10-minute default).
 *   HUB-SCH-2  marketplaceSources array accepts the new kind:"clawhub"
 *              variant AND still accepts legacy path-based entries
 *              (backward-compat for v2.1/v2.2 migrated configs).
 */
import { describe, it, expect } from "vitest";
import { defaultsSchema } from "../../config/schema.js";

describe("defaultsSchema — ClawHub extension (Phase 90 Plan 04 HUB-SCH-1..2)", () => {
  it("HUB-SCH-1: empty defaults → clawhubBaseUrl='https://clawhub.ai' + clawhubCacheTtlMs=600_000", () => {
    const result = defaultsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.clawhubBaseUrl).toBe("https://clawhub.ai");
      expect(result.data.clawhubCacheTtlMs).toBe(600_000);
    }
  });

  it("HUB-SCH-2a: marketplaceSources accepts legacy path-based entries (v2.2 compat)", () => {
    const result = defaultsSchema.safeParse({
      marketplaceSources: [
        { path: "~/.openclaw/skills", label: "OpenClaw legacy" },
        { path: "/absolute/path" },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.marketplaceSources).toHaveLength(2);
      // First entry: path + label
      const first = result.data.marketplaceSources?.[0];
      expect(first && "path" in first && first.path).toBe("~/.openclaw/skills");
    }
  });

  it("HUB-SCH-2b: marketplaceSources accepts new kind:'clawhub' entries", () => {
    const result = defaultsSchema.safeParse({
      marketplaceSources: [
        {
          kind: "clawhub",
          baseUrl: "https://clawhub.ai",
          authToken: "op://example-vault-21/ClawHub Token/credential",
          cacheTtlMs: 120_000,
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const entry = result.data.marketplaceSources?.[0];
      expect(entry && "kind" in entry && entry.kind).toBe("clawhub");
      if (entry && "kind" in entry && entry.kind === "clawhub") {
        expect(entry.baseUrl).toBe("https://clawhub.ai");
        expect(entry.authToken).toBe("op://example-vault-21/ClawHub Token/credential");
        expect(entry.cacheTtlMs).toBe(120_000);
      }
    }
  });

  it("HUB-SCH-2c: mixed legacy + clawhub entries coexist in same array", () => {
    const result = defaultsSchema.safeParse({
      marketplaceSources: [
        { path: "~/.openclaw/skills" },
        { kind: "clawhub", baseUrl: "https://clawhub.ai" },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.marketplaceSources).toHaveLength(2);
    }
  });

  it("HUB-SCH-2d: clawhub entry rejects invalid baseUrl", () => {
    const result = defaultsSchema.safeParse({
      marketplaceSources: [{ kind: "clawhub", baseUrl: "not-a-url" }],
    });
    expect(result.success).toBe(false);
  });
});
