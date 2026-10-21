/**
 * Phase 90 MEM-06 — subagent-capture unit tests.
 *
 * Verifies:
 *   S1: subagentSlug returns a 40-char cap + hyphenated + safe chars
 *   S2: isGsdSubagent + captureSubagentReturn skips gsd-* (D-35)
 *   S3: captureSubagentReturn writes memory/YYYY-MM-DD-subagent-<slug>.md
 *   S4: slug collision same-day → second write gets a nanoid suffix
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import {
  isGsdSubagent,
  subagentSlug,
  captureSubagentReturn,
} from "../subagent-capture.js";

const silentLog = pino({ level: "silent" });

describe("isGsdSubagent (Phase 90 MEM-06 D-35)", () => {
  it("returns true for gsd-planner / gsd-researcher / gsd-executor", () => {
    expect(isGsdSubagent("gsd-planner")).toBe(true);
    expect(isGsdSubagent("gsd-researcher")).toBe(true);
    expect(isGsdSubagent("gsd-executor-phase-90")).toBe(true);
  });

  it("returns false for non-gsd subagent types", () => {
    expect(isGsdSubagent("researcher")).toBe(false);
    expect(isGsdSubagent("planner")).toBe(false);
    expect(isGsdSubagent("Code Reviewer")).toBe(false);
  });
});

describe("subagentSlug (Phase 90 MEM-06 D-33)", () => {
  it("MEM-06-S1: lowercases + hyphenates + caps at 40 chars", () => {
    const s = subagentSlug("Research Phase 90 architecture patterns and summarize");
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s).toMatch(/^[a-z0-9-]+$/);
    expect(s.startsWith("research-phase-90")).toBe(true);
  });

  it("strips special chars (emojis, punctuation)", () => {
    const s = subagentSlug("🔍 Research: the quick brown fox? — (2026).");
    expect(s).toMatch(/^[a-z0-9-]+$/);
    expect(s).not.toContain(":");
    expect(s).not.toContain("(");
  });

  it("collapses runs of hyphens + trims trailing hyphen", () => {
    const s = subagentSlug("foo----bar—baz");
    expect(s).not.toContain("--");
    expect(s.endsWith("-")).toBe(false);
  });

  it("returns empty string when input contains only non-alphanum", () => {
    expect(subagentSlug("!@#$%^")).toBe("");
  });
});

describe("captureSubagentReturn (Phase 90 MEM-06)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "subagent-"));
  });

  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("MEM-06-S2: gsd-* subagent is SKIPPED — returns null, no file written", async () => {
    const out = await captureSubagentReturn({
      workspacePath: tmp,
      subagent_type: "gsd-planner",
      task_description: "Plan Phase 90",
      return_summary: "Plan complete",
      spawned_at_iso: "2026-04-24T18:30:00.000Z",
      duration_ms: 12345,
      log: silentLog,
    });
    expect(out).toBeNull();
    expect(existsSync(join(tmp, "memory"))).toBe(false);
  });

  it("MEM-06-S3: happy path — writes memory/YYYY-MM-DD-subagent-<slug>.md with frontmatter", async () => {
    const out = await captureSubagentReturn({
      workspacePath: tmp,
      subagent_type: "researcher",
      task_description: "Research Phase 90 architecture patterns",
      return_summary: "Found 3 relevant patterns: RRF, chokidar watcher, atomic write.",
      spawned_at_iso: "2026-04-24T18:30:00.000Z",
      duration_ms: 8765,
      log: silentLog,
    });
    expect(out).not.toBeNull();
    expect(out).toMatch(/memory\/2026-04-24-subagent-research-phase-90[a-z0-9-]*\.md$/);
    const body = readFileSync(out!, "utf8");
    expect(body).toContain("type: subagent-return");
    expect(body).toContain("spawned_at: 2026-04-24T18:30:00.000Z");
    expect(body).toContain("duration_ms: 8765");
    expect(body).toContain("subagent_type: researcher");
    expect(body).toContain("Research Phase 90 architecture patterns");
    expect(body).toContain("Found 3 relevant patterns");
  });

  it("MEM-06-S4: slug collision same-day → second write gets nanoid suffix", async () => {
    const args = {
      workspacePath: tmp,
      subagent_type: "researcher",
      task_description: "Same task name",
      return_summary: "first",
      spawned_at_iso: "2026-04-24T18:30:00.000Z",
      duration_ms: 1000,
      log: silentLog,
    };
    const a = await captureSubagentReturn(args);
    const b = await captureSubagentReturn({ ...args, return_summary: "second" });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
    const dir = readdirSync(join(tmp, "memory"));
    expect(dir.length).toBe(2);
  });

  it("falls back to 'subagent' slug when task_description produces empty slug", async () => {
    const out = await captureSubagentReturn({
      workspacePath: tmp,
      subagent_type: "researcher",
      task_description: "!@#$%^",
      return_summary: "body",
      spawned_at_iso: "2026-04-24T18:30:00.000Z",
      duration_ms: 1,
      log: silentLog,
    });
    expect(out).not.toBeNull();
    expect(out).toMatch(/2026-04-24-subagent-subagent\.md$/);
  });
});
