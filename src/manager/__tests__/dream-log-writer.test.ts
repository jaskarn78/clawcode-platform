import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Phase 95 Plan 02 Task 1 — writeDreamLog atomic markdown emission tests (RED).
 *
 * Pin D-05 contract:
 *   - L1: no prior file → atomic create with header + section; appended=false
 *   - L2: existing same-day file → APPENDS new ## section, preserves prior
 *         content; appended=true
 *   - L3: tmp+rename pattern (file lands on .tmp.<nonce> first then renamed)
 *   - L4: rename failure → tmp file cleanup attempted; error propagates
 *   - L5: renderDreamLogSection matches D-05 specifics verbatim (header
 *         shape, sub-bullets, cost+duration footer)
 *   - L6: dreams subdirectory auto-created via mkdir recursive (deeply nested
 *         memoryRoot)
 *   - L7: timestamps zero-padded UTC HH:MM; date bucket YYYY-MM-DD
 *
 * Module under test does not exist yet — imports fail (RED).
 */

import {
  writeDreamLog,
  renderDreamLogSection,
  type DreamLogEntry,
} from "../dream-log-writer.js";
import type { DreamResult } from "../dream-pass.js";

const SAMPLE_RESULT: DreamResult = {
  newWikilinks: [
    {
      from: "memory/2026-04-25-cutover-fix.md",
      to: "memory/2026-04-22-phase91-deploy.md",
      rationale: "workspace path drift recurring pattern",
    },
  ],
  promotionCandidates: [
    {
      chunkId: "chunk-routing",
      currentPath: "memory/vault/openclaw-routing.md",
      rationale: "Referenced 4 times in last 24h",
      priorityScore: 80,
    },
  ],
  themedReflection:
    "Recent activity centered on cutover verification debugging.",
  suggestedConsolidations: [
    {
      sources: ["memory/a.md", "memory/b.md"],
      newPath: "memory/consolidations/deploy.md",
      rationale: "Same incident; consolidate for clean recall",
    },
  ],
};

function buildEntry(overrides: Partial<DreamLogEntry> = {}): DreamLogEntry {
  return {
    timestamp: overrides.timestamp ?? new Date("2026-04-25T03:07:42.000Z"),
    idleMinutes: overrides.idleMinutes ?? 35,
    model: overrides.model ?? "haiku",
    result: overrides.result ?? SAMPLE_RESULT,
    tokensIn: overrides.tokensIn ?? 12_400,
    tokensOut: overrides.tokensOut ?? 1_800,
    durationMs: overrides.durationMs ?? 4_200,
  };
}

const tmpDirs: string[] = [];

afterEach(async () => {
  for (const d of tmpDirs) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs.length = 0;
  vi.restoreAllMocks();
});

async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dream-log-test-"));
  tmpDirs.push(dir);
  return dir;
}

describe("writeDreamLog — D-05 atomic markdown emission", () => {
  it("L1: no prior file — creates dreams/<date>.md with header + section, appended=false", async () => {
    const memoryRoot = await makeTmp();
    const out = await writeDreamLog({
      agentName: "atlas",
      memoryRoot,
      entry: buildEntry(),
    });
    expect(out.appended).toBe(false);
    expect(out.logPath).toBe(`${memoryRoot}/dreams/2026-04-25.md`);
    const content = await readFile(out.logPath, "utf8");
    expect(content.startsWith("# Dream log — atlas — 2026-04-25\n")).toBe(true);
    expect(content).toContain("## [03:07 UTC] Dream pass");
    expect(content).toContain("Recent activity centered on cutover");
  });

  it("L2: existing same-day file — APPENDS new ## section preserving prior content; appended=true", async () => {
    const memoryRoot = await makeTmp();
    // First pass
    await writeDreamLog({
      agentName: "atlas",
      memoryRoot,
      entry: buildEntry({ timestamp: new Date("2026-04-25T03:07:42.000Z") }),
    });
    // Second pass — same day
    const out = await writeDreamLog({
      agentName: "atlas",
      memoryRoot,
      entry: buildEntry({ timestamp: new Date("2026-04-25T15:30:00.000Z") }),
    });
    expect(out.appended).toBe(true);
    const content = await readFile(out.logPath, "utf8");
    // Both sections present; header only once
    const headerMatches = content.match(/^# Dream log/gm) ?? [];
    expect(headerMatches.length).toBe(1);
    expect(content).toContain("## [03:07 UTC] Dream pass");
    expect(content).toContain("## [15:30 UTC] Dream pass");
    // First section content not destroyed
    expect(content.indexOf("## [03:07 UTC]")).toBeLessThan(
      content.indexOf("## [15:30 UTC]"),
    );
  });

  it("L3: tmp+rename pattern — final file appears with correct content; no .tmp file lingers", async () => {
    // ESM doesn't permit spying on node:fs/promises exports. Verify the
    // tmp+rename pattern via observable filesystem state: after a
    // successful write, the final path exists with correct content AND
    // no `.tmp.*` siblings remain in the dreams/ directory.
    const memoryRoot = await makeTmp();
    const out = await writeDreamLog({
      agentName: "atlas",
      memoryRoot,
      entry: buildEntry(),
    });
    expect(out.logPath).toBe(`${memoryRoot}/dreams/2026-04-25.md`);
    const content = await readFile(out.logPath, "utf8");
    expect(content).toContain("# Dream log — atlas — 2026-04-25");
    // No tmp-file leakage from successful writes
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(`${memoryRoot}/dreams`);
    const tmpLeaks = entries.filter((n) => n.includes(".tmp"));
    expect(tmpLeaks).toEqual([]);
  });

  it("L4: rename failure — tmp file cleaned up; error propagates (verified via read-only dir)", async () => {
    // Force rename failure by writing to a directory that does not exist
    // at the rename target's parent. We make memoryRoot/dreams a FILE
    // instead of a directory by pre-creating a same-named file blocking
    // the mkdir+rename path. (Cross-platform safer than chmod tricks.)
    //
    // Strategy: create memoryRoot, then create memoryRoot/dreams as a
    // FILE (not directory). mkdir({recursive:true}) on an existing FILE
    // throws ENOTDIR — exercising the error path. tmp write never
    // happens because mkdir fails first.
    //
    // For an authentic rename-failure exercise, we mock the rename via
    // a wrapped fixture: write a stub finalPath as a directory so
    // rename(tmp, finalPath) fails with EISDIR.
    const memoryRoot = await makeTmp();
    const dir = `${memoryRoot}/dreams`;
    await mkdir(dir, { recursive: true });
    // Pre-create the target final path AS A DIRECTORY (rename(tmp, dir)
    // fails on most filesystems when target is a non-empty dir).
    const finalPath = `${dir}/2026-04-25.md`;
    await mkdir(finalPath, { recursive: true });
    // Place a file inside so rename can't replace
    await writeFile(`${finalPath}/.keep`, "x", "utf8");
    await expect(
      writeDreamLog({
        agentName: "atlas",
        memoryRoot,
        entry: buildEntry(),
      }),
    ).rejects.toThrow();
    // After the rejection, no .tmp.* file should linger in dreams/
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir);
    const tmpLeaks = entries.filter((n) => n.endsWith(".md") === false && n.includes(".tmp"));
    expect(tmpLeaks).toEqual([]);
  });

  it("L5: renderDreamLogSection matches D-05 specifics verbatim", () => {
    const md = renderDreamLogSection(buildEntry());
    // Header shape
    expect(md).toMatch(/^## \[03:07 UTC\] Dream pass \(idle 35min, model=haiku\)/);
    // Themed reflection
    expect(md).toContain("**Themed reflection:**");
    expect(md).toContain("Recent activity centered on cutover");
    // New wikilinks section
    expect(md).toContain("**New wikilinks (1):**");
    expect(md).toContain(
      "- memory/2026-04-25-cutover-fix.md → memory/2026-04-22-phase91-deploy.md",
    );
    // Promotion candidates SURFACED
    expect(md).toContain("**Promotion candidates (1):**");
    expect(md).toContain("consider promoting");
    expect(md).toContain("operator review");
    // Suggested consolidations SURFACED
    expect(md).toContain("**Suggested consolidations (1):**");
    expect(md).toContain("memory/a.md+memory/b.md → memory/consolidations/deploy.md");
    // Cost + Duration footer
    expect(md).toContain("**Cost:** 12400 in / 1800 out tokens");
    expect(md).toContain("Duration: 4.2s");
  });

  it("L5b: empty sections render _(none)_", () => {
    const empty: DreamResult = {
      newWikilinks: [],
      promotionCandidates: [],
      themedReflection: "Quiet day.",
      suggestedConsolidations: [],
    };
    const md = renderDreamLogSection(buildEntry({ result: empty }));
    expect(md).toContain("**New wikilinks (0):**");
    expect(md).toContain("**Promotion candidates (0):**");
    expect(md).toContain("**Suggested consolidations (0):**");
    expect(md.match(/_\(none\)_/g)?.length).toBe(3);
  });

  it("L6: dreams subdirectory auto-created via mkdir recursive (deeply nested memoryRoot)", async () => {
    const memoryRoot = join(await makeTmp(), "deep", "nest", "memory");
    // Don't pre-create — writeDreamLog must mkdir -p
    const out = await writeDreamLog({
      agentName: "atlas",
      memoryRoot,
      entry: buildEntry(),
    });
    expect(out.logPath).toBe(`${memoryRoot}/dreams/2026-04-25.md`);
    const content = await readFile(out.logPath, "utf8");
    expect(content).toContain("# Dream log");
  });

  it("L7: HH:MM zero-padded UTC; date bucket YYYY-MM-DD zero-padded", async () => {
    const memoryRoot = await makeTmp();
    // Time with single-digit hour and minute and month/day
    const out = await writeDreamLog({
      agentName: "atlas",
      memoryRoot,
      entry: buildEntry({ timestamp: new Date("2026-01-05T03:07:42.000Z") }),
    });
    expect(out.logPath.endsWith("2026-01-05.md")).toBe(true);
    const content = await readFile(out.logPath, "utf8");
    expect(content).toContain("## [03:07 UTC]");
    expect(content).toContain("# Dream log — atlas — 2026-01-05");
  });
});
