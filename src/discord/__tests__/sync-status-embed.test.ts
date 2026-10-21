/**
 * Phase 91 Plan 05 SYNC-08 — buildSyncStatusEmbed unit tests.
 *
 * Pins the /clawcode-sync-status embed shape + colour rules + conflict cap.
 *
 * Covered scenarios:
 *   E1  happy path: synced + no conflicts → green, no ⚠️ in title
 *   E2  one conflict → red, singular "conflict" in title
 *   E3  five conflicts → red, plural "conflicts" in title
 *   E4  thirty conflicts → exactly 25 fields + trailing "… N more" fact
 *   E5  lastCycle=null → "never-run" in description + yellow colour
 *   E6  failed-ssh with no conflicts → yellow colour (not red)
 *   E7  formatBytes coverage (0, 1500, 524_288_000, etc.)
 *   E8  formatDuration coverage (500, 1400, 61_000, 612_000)
 *   E9  resolve-hint appears in description IFF conflicts > 0
 *   E10 authoritativeSide="clawcode" shows post-cutover direction
 *   E11 footer shows cycleId + timestamp when lastCycle present
 *   E12 footer shows "never run" hint when lastCycle=null
 *   E13 description relative-time suffix — "3m ago" when 3 minutes old
 */

import { describe, it, expect } from "vitest";
import {
  buildSyncStatusEmbed,
  formatBytes,
  formatDuration,
  EMBED_COLOR_CONFLICT,
  EMBED_COLOR_HAPPY,
  EMBED_COLOR_WARN,
  DISCORD_EMBED_FIELD_CAP,
  type SyncStatusEmbedInput,
  type LastCycleSummary,
} from "../sync-status-embed.js";
import type { SyncConflict } from "../../sync/types.js";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date("2026-04-24T20:00:00.000Z");

function mkConflict(path: string, srcPrefix = "aa", destPrefix = "bb"): SyncConflict {
  return {
    path,
    sourceHash: `${srcPrefix}${"0".repeat(62)}`,
    destHash: `${destPrefix}${"0".repeat(62)}`,
    detectedAt: "2026-04-24T19:55:00.000Z",
    resolvedAt: null,
  };
}

function mkLastCycle(overrides: Partial<LastCycleSummary> = {}): LastCycleSummary {
  return {
    cycleId: "cyc-abc123",
    status: "synced",
    filesAdded: 0,
    filesUpdated: 2,
    filesRemoved: 0,
    filesSkippedConflict: 0,
    bytesTransferred: 3200,
    durationMs: 1400,
    timestamp: "2026-04-24T19:58:00.000Z",
    ...overrides,
  };
}

function mkInput(overrides: Partial<SyncStatusEmbedInput> = {}): SyncStatusEmbedInput {
  return {
    authoritativeSide: "openclaw",
    lastSyncedAt: "2026-04-24T19:58:00.000Z",
    conflicts: [],
    lastCycle: mkLastCycle(),
    now: FIXED_NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// E1-E3: conflict count → title + colour
// ---------------------------------------------------------------------------

describe("Phase 91 Plan 05 — buildSyncStatusEmbed: conflict count → title + colour", () => {
  it("E1: happy path → green colour, no ⚠️ in title, no 'conflict' in title", () => {
    const embed = buildSyncStatusEmbed(mkInput());
    expect(embed.data.color).toBe(EMBED_COLOR_HAPPY);
    expect(embed.data.title).toBe("🔄 Sync status — fin-client");
    expect(embed.data.title).not.toContain("⚠️");
    expect(embed.data.title).not.toContain("conflict");
  });

  it("E2: 1 conflict → red colour, singular 'conflict' in title", () => {
    const embed = buildSyncStatusEmbed(
      mkInput({ conflicts: [mkConflict("MEMORY.md")] }),
    );
    expect(embed.data.color).toBe(EMBED_COLOR_CONFLICT);
    expect(embed.data.title).toContain("⚠️");
    expect(embed.data.title).toContain("1 conflict");
    expect(embed.data.title).not.toContain("1 conflicts");
  });

  it("E3: 5 conflicts → red colour, plural 'conflicts' in title", () => {
    const conflicts = [
      mkConflict("memory/a.md"),
      mkConflict("memory/b.md"),
      mkConflict("memory/c.md"),
      mkConflict("memory/d.md"),
      mkConflict("memory/e.md"),
    ];
    const embed = buildSyncStatusEmbed(mkInput({ conflicts }));
    expect(embed.data.color).toBe(EMBED_COLOR_CONFLICT);
    expect(embed.data.title).toContain("5 conflicts");
  });
});

// ---------------------------------------------------------------------------
// E4: field cap at DISCORD_EMBED_FIELD_CAP (25) with truncation marker
// ---------------------------------------------------------------------------

describe("Phase 91 Plan 05 — buildSyncStatusEmbed: field cap", () => {
  it("E4a: exactly 25 conflicts → 25 fields, no truncation marker", () => {
    const conflicts = Array.from({ length: 25 }, (_, i) =>
      mkConflict(`memory/c${i}.md`),
    );
    const embed = buildSyncStatusEmbed(mkInput({ conflicts }));
    expect(embed.data.fields).toHaveLength(25);
    // no "… N more" terminal field
    const names = embed.data.fields?.map((f) => f.name) ?? [];
    expect(names.some((n) => n === "…")).toBe(false);
  });

  it("E4b: 30 conflicts → 25 fields total (24 conflicts + 1 '… N more' marker)", () => {
    const conflicts = Array.from({ length: 30 }, (_, i) =>
      mkConflict(`memory/c${i}.md`),
    );
    const embed = buildSyncStatusEmbed(mkInput({ conflicts }));
    expect(embed.data.fields).toHaveLength(DISCORD_EMBED_FIELD_CAP);

    const fields = embed.data.fields ?? [];
    const last = fields[fields.length - 1]!;
    expect(last.name).toBe("…");
    expect(last.value).toContain("more conflict"); // "6 more conflicts"
    // Remaining = total - (cap - 1) = 30 - 24 = 6
    expect(last.value).toContain("6 more conflicts");
  });
});

// ---------------------------------------------------------------------------
// E5/E6: lastCycle variations → colour + description
// ---------------------------------------------------------------------------

describe("Phase 91 Plan 05 — buildSyncStatusEmbed: lastCycle variations", () => {
  it("E5: lastCycle=null → yellow colour + 'never-run' in description", () => {
    const embed = buildSyncStatusEmbed(
      mkInput({ lastCycle: null, lastSyncedAt: null }),
    );
    expect(embed.data.color).toBe(EMBED_COLOR_WARN);
    expect(embed.data.description).toContain("never-run");
  });

  it("E6: failed-ssh + no conflicts → yellow colour (NOT red)", () => {
    const embed = buildSyncStatusEmbed(
      mkInput({
        conflicts: [],
        lastCycle: mkLastCycle({
          status: "failed-ssh",
          error: "ssh: connect to host 10.0.0.3 port 22: Connection refused",
        }),
      }),
    );
    expect(embed.data.color).toBe(EMBED_COLOR_WARN);
    expect(embed.data.color).not.toBe(EMBED_COLOR_CONFLICT);
    expect(embed.data.description).toContain("failed-ssh");
  });

  it("E6b: paused + no conflicts → yellow colour", () => {
    const embed = buildSyncStatusEmbed(
      mkInput({
        conflicts: [],
        lastCycle: mkLastCycle({
          status: "paused",
          reason: "authoritative-is-clawcode-no-reverse-opt-in",
        }),
      }),
    );
    expect(embed.data.color).toBe(EMBED_COLOR_WARN);
  });

  it("E6c: skipped-no-changes + no conflicts → green (counts as happy)", () => {
    const embed = buildSyncStatusEmbed(
      mkInput({
        conflicts: [],
        lastCycle: mkLastCycle({ status: "skipped-no-changes" }),
      }),
    );
    expect(embed.data.color).toBe(EMBED_COLOR_HAPPY);
  });
});

// ---------------------------------------------------------------------------
// E7-E8: formatBytes + formatDuration edge cases
// ---------------------------------------------------------------------------

describe("Phase 91 Plan 05 — formatBytes", () => {
  it("E7a: 0 bytes → '0 B'", () => {
    expect(formatBytes(0)).toBe("0 B");
  });
  it("E7b: sub-KB → plain bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
  });
  it("E7c: 1500 → '1.5 KB'", () => {
    expect(formatBytes(1500)).toBe("1.5 KB");
  });
  it("E7d: 524_288_000 → '500.0 MB'", () => {
    expect(formatBytes(524_288_000)).toBe("500.0 MB");
  });
  it("E7e: 2.5 GB → '2.50 GB'", () => {
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.50 GB");
  });
});

describe("Phase 91 Plan 05 — formatDuration", () => {
  it("E8a: 500ms → '500ms'", () => {
    expect(formatDuration(500)).toBe("500ms");
  });
  it("E8b: 1400ms → '1.4s'", () => {
    expect(formatDuration(1400)).toBe("1.4s");
  });
  it("E8c: 61_000ms → '1m 1s'", () => {
    expect(formatDuration(61_000)).toBe("1m 1s");
  });
  it("E8d: 612_345ms → '10m 12s'", () => {
    expect(formatDuration(612_345)).toBe("10m 12s");
  });
});

// ---------------------------------------------------------------------------
// E9: resolve-hint in description (IFF conflicts > 0)
// ---------------------------------------------------------------------------

describe("Phase 91 Plan 05 — resolve-hint in description", () => {
  it("E9a: zero conflicts → NO resolve hint", () => {
    const embed = buildSyncStatusEmbed(mkInput({ conflicts: [] }));
    expect(embed.data.description).not.toContain("clawcode sync resolve");
  });

  it("E9b: conflicts > 0 → resolve hint present", () => {
    const embed = buildSyncStatusEmbed(
      mkInput({ conflicts: [mkConflict("MEMORY.md")] }),
    );
    expect(embed.data.description).toContain("clawcode sync resolve");
    expect(embed.data.description).toContain("--side openclaw|clawcode");
  });
});

// ---------------------------------------------------------------------------
// E10: authoritativeSide=clawcode → post-cutover direction string
// ---------------------------------------------------------------------------

describe("Phase 91 Plan 05 — authoritativeSide direction rendering", () => {
  it("E10a: openclaw → 'openclaw → clawcode'", () => {
    const embed = buildSyncStatusEmbed(mkInput({ authoritativeSide: "openclaw" }));
    expect(embed.data.description).toContain("openclaw → clawcode");
  });

  it("E10b: clawcode → 'clawcode → openclaw (post-cutover)'", () => {
    const embed = buildSyncStatusEmbed(mkInput({ authoritativeSide: "clawcode" }));
    expect(embed.data.description).toContain("clawcode → openclaw");
    expect(embed.data.description).toContain("post-cutover");
  });
});

// ---------------------------------------------------------------------------
// E11/E12: footer contents
// ---------------------------------------------------------------------------

describe("Phase 91 Plan 05 — footer rendering", () => {
  it("E11: lastCycle present → footer shows cycleId + timestamp", () => {
    const embed = buildSyncStatusEmbed(mkInput());
    expect(embed.data.footer?.text).toContain("cyc-abc123");
    expect(embed.data.footer?.text).toContain("2026-04-24T19:58:00.000Z");
  });

  it("E12: lastCycle=null → footer shows 'Sync has not run yet' hint", () => {
    const embed = buildSyncStatusEmbed(mkInput({ lastCycle: null }));
    expect(embed.data.footer?.text).toContain("Sync has not run yet");
  });
});

// ---------------------------------------------------------------------------
// E13: relative-time suffix
// ---------------------------------------------------------------------------

describe("Phase 91 Plan 05 — relative-time suffix in description", () => {
  it("E13a: 3 minutes old → '(3m ago)'", () => {
    const embed = buildSyncStatusEmbed(
      mkInput({
        lastCycle: mkLastCycle({ timestamp: "2026-04-24T19:57:00.000Z" }),
        // FIXED_NOW - 3m = 19:57:00
      }),
    );
    expect(embed.data.description).toContain("(3m ago)");
  });

  it("E13b: 2h old → '(2h ago)'", () => {
    const embed = buildSyncStatusEmbed(
      mkInput({
        lastCycle: mkLastCycle({ timestamp: "2026-04-24T18:00:00.000Z" }),
        // FIXED_NOW - 2h = 18:00:00
      }),
    );
    expect(embed.data.description).toContain("(2h ago)");
  });

  it("E13c: timestamp in the future (clock skew) → NO suffix", () => {
    const embed = buildSyncStatusEmbed(
      mkInput({
        lastCycle: mkLastCycle({ timestamp: "2026-04-24T21:00:00.000Z" }),
        // FIXED_NOW + 1h — defensive; renders no suffix
      }),
    );
    // Description contains "Last cycle: **synced**" with no "(... ago)"
    const descLine = embed.data.description?.split("\n")[1] ?? "";
    expect(descLine).not.toMatch(/\(\-?\d+[smhd] ago\)/);
  });
});

// ---------------------------------------------------------------------------
// Happy-path field contents (spot-check the 6 stat fields)
// ---------------------------------------------------------------------------

describe("Phase 91 Plan 05 — happy-path stat fields", () => {
  it("renders all 6 inline stat fields with expected values", () => {
    const embed = buildSyncStatusEmbed(
      mkInput({
        lastCycle: mkLastCycle({
          filesAdded: 1,
          filesUpdated: 2,
          filesRemoved: 3,
          bytesTransferred: 1500,
          durationMs: 1400,
        }),
      }),
    );
    const fields = embed.data.fields ?? [];
    const byName: Record<string, string> = {};
    for (const f of fields) byName[f.name] = f.value;
    expect(byName["Files added"]).toBe("1");
    expect(byName["Files updated"]).toBe("2");
    expect(byName["Files removed"]).toBe("3");
    expect(byName["Bytes transferred"]).toBe("1.5 KB");
    expect(byName["Duration"]).toBe("1.4s");
    expect(byName["Conflicts"]).toBe("0");
    expect(fields).toHaveLength(6);
  });

  it("renders Error field when lastCycle has `error` populated", () => {
    const embed = buildSyncStatusEmbed(
      mkInput({
        lastCycle: mkLastCycle({
          status: "failed-ssh",
          error: "ssh: Connection refused",
        }),
      }),
    );
    const fields = embed.data.fields ?? [];
    const errField = fields.find((f) => f.name === "Error");
    expect(errField).toBeDefined();
    expect(errField!.value).toContain("Connection refused");
  });
});

// ---------------------------------------------------------------------------
// Conflict field rendering — path + short hashes
// ---------------------------------------------------------------------------

describe("Phase 91 Plan 05 — conflict fields shape", () => {
  it("renders path + 8-char short hashes in conflict fields", () => {
    const conflict = mkConflict(
      "memory/procedures/newsletter-workflow.md",
      "abc12345",
      "def67890",
    );
    const embed = buildSyncStatusEmbed(mkInput({ conflicts: [conflict] }));
    const fields = embed.data.fields ?? [];
    expect(fields).toHaveLength(1);
    const f = fields[0]!;
    expect(f.name).toContain("memory/procedures/newsletter-workflow.md");
    expect(f.value).toContain("abc12345");
    expect(f.value).toContain("def67890");
    // short-hash discipline — full 64-char hash must NOT leak
    expect(f.value).not.toContain("abc12345" + "0".repeat(56));
  });
});
