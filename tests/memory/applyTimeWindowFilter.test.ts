/**
 * Phase 101 Plan 03 Task 1 (CF-1) — regression guard for the
 * `applyTimeWindowFilter` allow-list extension that exempts `document:`
 * paths from the 14-day expiry so U6 cross-ingested document chunks
 * survive Phase 90 RRF retrieval after the standard session-note window.
 *
 * Existing /memory/vault/ and /memory/procedures/ allow-list branches MUST
 * continue to work unchanged. The exemption is strictly the `document:`
 * prefix (with the colon) — `documentary_*` filenames are NOT exempted.
 */
import { describe, it, expect } from "vitest";
import { applyTimeWindowFilter } from "../../src/memory/memory-chunks.js";

describe("applyTimeWindowFilter — CF-1 document: prefix allow-list (Phase 101)", () => {
  // Fixed `now` for determinism across runs.
  const NOW = Date.UTC(2026, 4, 16); // 2026-05-16
  const ONE_DAY_MS = 86_400_000;

  it("CF-1-TW1: vault path retained when 365 days old (existing allow-list regression guard)", () => {
    const chunks = [
      {
        path: "/ws/memory/vault/rules.md",
        file_mtime_ms: NOW - 365 * ONE_DAY_MS,
      },
    ];
    const filtered = applyTimeWindowFilter(chunks, 14, NOW);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].path).toBe("/ws/memory/vault/rules.md");
  });

  it("CF-1-TW2: procedures path retained when 100 days old (existing allow-list regression guard)", () => {
    const chunks = [
      {
        path: "/ws/memory/procedures/runbook.md",
        file_mtime_ms: NOW - 100 * ONE_DAY_MS,
      },
    ];
    const filtered = applyTimeWindowFilter(chunks, 14, NOW);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].path).toBe("/ws/memory/procedures/runbook.md");
  });

  it("CF-1-TW3: document:<slug> path retained when 30 days old (new CF-1 allow-list)", () => {
    const chunks = [
      {
        path: "document:client-c-2024-tax-return",
        file_mtime_ms: NOW - 30 * ONE_DAY_MS,
      },
    ];
    const filtered = applyTimeWindowFilter(chunks, 14, NOW);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].path).toBe("document:client-c-2024-tax-return");
  });

  it("CF-1-TW4: `document:` exact prefix required — `documentary_film_notes.md` NOT exempted when old", () => {
    const chunks = [
      {
        path: "documentary_film_notes.md",
        file_mtime_ms: NOW - 30 * ONE_DAY_MS,
      },
    ];
    const filtered = applyTimeWindowFilter(chunks, 14, NOW);
    expect(filtered).toHaveLength(0);
  });

  it("CF-1-TW5: generic session path filtered when older than `days`", () => {
    const chunks = [
      {
        path: "/agents/foo/notes/2026-04-01-session.md",
        file_mtime_ms: NOW - 30 * ONE_DAY_MS,
      },
    ];
    const filtered = applyTimeWindowFilter(chunks, 14, NOW);
    expect(filtered).toHaveLength(0);
  });
});
