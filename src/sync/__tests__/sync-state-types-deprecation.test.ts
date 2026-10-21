/**
 * Phase 96 Plan 06 — sync-state schema deprecation tests (D-11).
 *
 * Validates the 3-value `authoritativeSide` Zod enum extension AND the
 * additive `deprecatedAt` optional ISO field on syncStateFileSchema. Pinned
 * invariants (W-2: ALL Zod literal acceptance_criteria pins use grep -F):
 *
 *   SST-3VALUE-ENUM           — authoritativeSide accepts "deprecated" + rejects unknown
 *   SST-DEPRECATED-AT-OPTIONAL — deprecatedAt is optional ISO; non-ISO rejected
 *   SST-V24-COMPAT            — v2.4 fixtures (no deprecatedAt) parse unchanged (additive non-breaking)
 *   SST-WINDOW-CONST          — DEPRECATION_ROLLBACK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000 (= 604800000 ms)
 *   SST-WINDOW-MATH           — 5 days into window → 2 days remaining; 8 days into window → expired
 *   SST-IMMUTABLE             — schema parse output is plain readonly-friendly object (Zod returns POJO)
 *
 * Mirrors the Phase 91 sync-state-store.test.ts shape — no external I/O,
 * pure schema parsing only. Tests fail until src/sync/types.ts is extended.
 */
import { describe, it, expect } from "vitest";
import {
  syncStateFileSchema,
  DEPRECATION_ROLLBACK_WINDOW_MS,
  type SyncStateFile,
} from "../types.js";

// ---------------------------------------------------------------------------
// SST-3VALUE-ENUM — authoritativeSide is a 3-value enum (W-2 pinned in plan)
// ---------------------------------------------------------------------------

describe("syncStateFileSchema — 3-value authoritativeSide enum (Phase 96 D-11)", () => {
  // additive/backward.compat — v2.4 fixtures parse unchanged (SST-V24-COMPAT pin)

  function baseV24Fixture(authoritativeSide: string): unknown {
    return {
      version: 1,
      updatedAt: "2026-04-24T19:00:00.000Z",
      authoritativeSide,
      lastSyncedAt: null,
      openClawHost: "example-user@10.0.0.3",
      openClawWorkspace: "/home/example-user/.openclaw/workspace-acme",
      clawcodeWorkspace: "/home/clawcode/.clawcode/agents/acme",
      perFileHashes: {},
      conflicts: [],
      openClawSessionCursor: null,
    };
  }

  it("accepts authoritativeSide = 'openclaw'", () => {
    const parsed = syncStateFileSchema.safeParse(baseV24Fixture("openclaw"));
    expect(parsed.success).toBe(true);
  });

  it("accepts authoritativeSide = 'clawcode'", () => {
    const parsed = syncStateFileSchema.safeParse(baseV24Fixture("clawcode"));
    expect(parsed.success).toBe(true);
  });

  it("accepts authoritativeSide = 'deprecated' (Phase 96 D-11 third value)", () => {
    const parsed = syncStateFileSchema.safeParse(baseV24Fixture("deprecated"));
    expect(parsed.success).toBe(true);
  });

  it("rejects authoritativeSide = 'invalid-value' (closed enum)", () => {
    const parsed = syncStateFileSchema.safeParse(baseV24Fixture("invalid-value"));
    expect(parsed.success).toBe(false);
  });

  it("rejects authoritativeSide = '' (empty string)", () => {
    const parsed = syncStateFileSchema.safeParse(baseV24Fixture(""));
    expect(parsed.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SST-DEPRECATED-AT-OPTIONAL — additive optional ISO field
// ---------------------------------------------------------------------------

describe("syncStateFileSchema — deprecatedAt optional ISO field (Phase 96 D-11)", () => {
  function baseDeprecatedFixture(deprecatedAt?: unknown): unknown {
    const fixture: Record<string, unknown> = {
      version: 1,
      updatedAt: "2026-04-25T16:00:00.000Z",
      authoritativeSide: "deprecated",
      lastSyncedAt: null,
      openClawHost: "example-user@10.0.0.3",
      openClawWorkspace: "/home/example-user/.openclaw/workspace-acme",
      clawcodeWorkspace: "/home/clawcode/.clawcode/agents/acme",
      perFileHashes: {},
      conflicts: [],
      openClawSessionCursor: null,
    };
    if (deprecatedAt !== undefined) {
      fixture.deprecatedAt = deprecatedAt;
    }
    return fixture;
  }

  it("parses deprecated state WITHOUT deprecatedAt (additive optional)", () => {
    const parsed = syncStateFileSchema.safeParse(baseDeprecatedFixture());
    expect(parsed.success).toBe(true);
  });

  it("parses deprecated state WITH valid ISO deprecatedAt", () => {
    const parsed = syncStateFileSchema.safeParse(
      baseDeprecatedFixture("2026-04-25T16:00:00.000Z"),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.deprecatedAt).toBe("2026-04-25T16:00:00.000Z");
    }
  });

  it("rejects deprecatedAt = 'not-an-iso-string' (non-ISO refused)", () => {
    const parsed = syncStateFileSchema.safeParse(
      baseDeprecatedFixture("not-an-iso-string"),
    );
    expect(parsed.success).toBe(false);
  });

  it("rejects deprecatedAt = 12345 (non-string refused)", () => {
    const parsed = syncStateFileSchema.safeParse(baseDeprecatedFixture(12345));
    expect(parsed.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SST-V24-COMPAT — v2.4 sync-state.json fixtures parse unchanged (backward.compat)
// ---------------------------------------------------------------------------

describe("syncStateFileSchema — v2.4 backward.compat (additive non-breaking)", () => {
  // additive change: existing v2.4 sync-state.json files (no deprecatedAt field)
  // parse unchanged. Pinned by SST-V24-COMPAT.

  it("parses v2.4 fixture #1 (authoritativeSide=openclaw, no deprecatedAt)", () => {
    const v24Fixture = {
      version: 1,
      updatedAt: "2026-04-20T10:00:00.000Z",
      authoritativeSide: "openclaw",
      lastSyncedAt: "2026-04-20T09:55:00.000Z",
      openClawHost: "example-user@10.0.0.3",
      openClawWorkspace: "/home/example-user/.openclaw/workspace-acme",
      clawcodeWorkspace: "/home/clawcode/.clawcode/agents/acme",
      perFileHashes: { "MEMORY.md": "abc123" },
      conflicts: [],
      openClawSessionCursor: null,
    };
    const parsed = syncStateFileSchema.safeParse(v24Fixture);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.authoritativeSide).toBe("openclaw");
      expect(parsed.data.deprecatedAt).toBeUndefined();
    }
  });

  it("parses v2.4 fixture #2 (authoritativeSide=clawcode post-cutover, no deprecatedAt)", () => {
    const v24Fixture = {
      version: 1,
      updatedAt: "2026-04-22T14:00:00.000Z",
      authoritativeSide: "clawcode",
      lastSyncedAt: "2026-04-22T13:55:00.000Z",
      openClawHost: "example-user@10.0.0.3",
      openClawWorkspace: "/home/example-user/.openclaw/workspace-acme",
      clawcodeWorkspace: "/home/clawcode/.clawcode/agents/acme",
      perFileHashes: { "MEMORY.md": "abc123", "SOUL.md": "def456" },
      conflicts: [],
      openClawSessionCursor: null,
    };
    const parsed = syncStateFileSchema.safeParse(v24Fixture);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.authoritativeSide).toBe("clawcode");
      expect(parsed.data.deprecatedAt).toBeUndefined();
    }
  });

  it("parses v2.4 fixture #3 (authoritativeSide=openclaw with conflicts, no deprecatedAt)", () => {
    const v24Fixture = {
      version: 1,
      updatedAt: "2026-04-23T16:00:00.000Z",
      authoritativeSide: "openclaw",
      lastSyncedAt: "2026-04-23T15:55:00.000Z",
      openClawHost: "example-user@10.0.0.3",
      openClawWorkspace: "/home/example-user/.openclaw/workspace-acme",
      clawcodeWorkspace: "/home/clawcode/.clawcode/agents/acme",
      perFileHashes: { "MEMORY.md": "abc123" },
      conflicts: [
        {
          path: "memory/2026-04-23.md",
          sourceHash: "src1",
          destHash: "dst1",
          detectedAt: "2026-04-23T15:00:00.000Z",
          resolvedAt: null,
        },
      ],
      openClawSessionCursor: "cursor-001",
    };
    const parsed = syncStateFileSchema.safeParse(v24Fixture);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.authoritativeSide).toBe("openclaw");
      expect(parsed.data.deprecatedAt).toBeUndefined();
      expect(parsed.data.conflicts).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// SST-WINDOW-CONST — exported constant equals 7 days in ms (= 604800000)
// ---------------------------------------------------------------------------

describe("DEPRECATION_ROLLBACK_WINDOW_MS — 7-day rollback window constant (Phase 96 D-11)", () => {
  // SST-WINDOW-CONST pin: 604800000 ms (7 * 24 * 60 * 60 * 1000)

  it("DEPRECATION_ROLLBACK_WINDOW_MS equals 7 * 24 * 60 * 60 * 1000", () => {
    expect(DEPRECATION_ROLLBACK_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("DEPRECATION_ROLLBACK_WINDOW_MS literal value equals 604800000 ms", () => {
    expect(DEPRECATION_ROLLBACK_WINDOW_MS).toBe(604800000);
  });
});

// ---------------------------------------------------------------------------
// SST-WINDOW-MATH — window-remaining calculation invariants
// ---------------------------------------------------------------------------

describe("DEPRECATION_ROLLBACK_WINDOW_MS — window-math invariants (Phase 96 D-11)", () => {
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;

  it("5 days elapsed → 2 days remaining (within window)", () => {
    const deprecatedAt = new Date("2026-04-25T16:00:00.000Z").getTime();
    const now = new Date("2026-04-30T16:00:00.000Z").getTime(); // exactly 5 days later
    const remainingMs = DEPRECATION_ROLLBACK_WINDOW_MS - (now - deprecatedAt);
    const remainingDays = Math.floor(remainingMs / ONE_DAY_MS);
    expect(remainingDays).toBe(2);
    expect(remainingMs).toBeGreaterThan(0);
  });

  it("8 days elapsed → window expired (negative remaining)", () => {
    const deprecatedAt = new Date("2026-04-25T16:00:00.000Z").getTime();
    const now = new Date("2026-05-03T16:00:00.000Z").getTime(); // 8 days later
    const remainingMs = DEPRECATION_ROLLBACK_WINDOW_MS - (now - deprecatedAt);
    expect(remainingMs).toBeLessThan(0);
  });

  it("0 days elapsed → 7 days remaining (full window)", () => {
    const deprecatedAt = new Date("2026-04-25T16:00:00.000Z").getTime();
    const now = deprecatedAt;
    const remainingMs = DEPRECATION_ROLLBACK_WINDOW_MS - (now - deprecatedAt);
    expect(remainingMs).toBe(DEPRECATION_ROLLBACK_WINDOW_MS);
  });
});

// ---------------------------------------------------------------------------
// SST-IMMUTABLE — schema returns POJO, immutability via convention not freeze
// ---------------------------------------------------------------------------

describe("syncStateFileSchema — immutability convention (Phase 91 reuse)", () => {
  // Phase 91 contract: writeSyncState NEVER mutates passed-in SyncStateFile.
  // Phase 96 reuses the same convention. Schema parse output is a plain JS
  // object; immutability is callsite discipline (object spread for updates).

  it("schema parse returns plain object — fields are accessible", () => {
    const fixture = {
      version: 1,
      updatedAt: "2026-04-25T16:00:00.000Z",
      authoritativeSide: "deprecated",
      deprecatedAt: "2026-04-25T16:00:00.000Z",
      lastSyncedAt: null,
      openClawHost: "example-user@10.0.0.3",
      openClawWorkspace: "/home/example-user/.openclaw/workspace-acme",
      clawcodeWorkspace: "/home/clawcode/.clawcode/agents/acme",
      perFileHashes: {},
      conflicts: [],
      openClawSessionCursor: null,
    };
    const parsed = syncStateFileSchema.safeParse(fixture);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // Phase 96 convention: spread to create new state, never mutate
      const next: SyncStateFile = {
        ...parsed.data,
        authoritativeSide: "openclaw",
      };
      // Original parsed data still has 'deprecated' — spread created a copy
      expect(parsed.data.authoritativeSide).toBe("deprecated");
      expect(next.authoritativeSide).toBe("openclaw");
    }
  });
});
