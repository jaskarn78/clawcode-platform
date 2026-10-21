import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isErrorSummary, MIN_USABLE_SUMMARY_CHARS } from "../error-guard.js";
import { MemoryStore } from "../store.js";
import type { EmbeddingService } from "../embedder.js";
import type { ConsolidationConfig } from "../schema.js";
import {
  detectUnconsolidatedWeeks,
  detectUnconsolidatedMonths,
  buildWeeklySummarizationPrompt,
  buildMonthlySummarizationPrompt,
  writeWeeklyDigest,
  writeMonthlyDigest,
  archiveDailyLogs,
  archiveWeeklyDigests,
  runConsolidation,
} from "../consolidation.js";
import type { ConsolidationDeps, WeekGroup, MonthGroup } from "../consolidation.js";

function randomEmbedding(): Float32Array {
  const arr = new Float32Array(384);
  for (let i = 0; i < 384; i++) {
    arr[i] = Math.random() * 2 - 1;
  }
  return arr;
}

function createMockEmbedder(): EmbeddingService {
  return {
    embed: vi.fn().mockResolvedValue(randomEmbedding()),
    warmup: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
  } as unknown as EmbeddingService;
}

function createMockSummarize(): (prompt: string) => Promise<string> {
  return vi.fn().mockResolvedValue(
    "## Key Facts\n- Fact 1\n\n## Decisions Made\n- Decision 1\n\n## Topics Discussed\n- Topic 1\n\n## Important Context\n- Context 1",
  );
}

function createTestDeps(memoryDir: string): ConsolidationDeps {
  return {
    memoryDir,
    memoryStore: new MemoryStore(":memory:"),
    embedder: createMockEmbedder(),
    summarize: createMockSummarize(),
    // Phase 115 sub-scope 13(b) — redirect run-log writes into the same
    // tmpdir as memoryDir so the test never leaks rows into the real
    // ~/.clawcode/manager/consolidation-runs.jsonl on the host. Rule 3 —
    // pre-existing test infrastructure didn't know about run-log writes.
    runLogDirOverride: memoryDir,
  };
}

/**
 * Helper to create daily log files in tempDir.
 * dates should be in YYYY-MM-DD format.
 */
function createDailyLogs(dir: string, dates: readonly string[]): void {
  for (const date of dates) {
    const filePath = join(dir, `${date}.md`);
    writeFileSync(filePath, `# Session Log: ${date}\n\n## 10:00:00 [user]\nSome content for ${date}\n`);
  }
}

describe("isErrorSummary", () => {
  it("detects credit balance errors", () => {
    expect(isErrorSummary("Credit balance is too low to complete this request.")).toBe(true);
  });

  it("detects API error codes", () => {
    expect(isErrorSummary("API Error: 402 — request rejected")).toBe(true);
    expect(isErrorSummary("API Error: 429 rate limit")).toBe(true);
  });

  it("detects authentication errors", () => {
    expect(isErrorSummary("Failed to authenticate with the API.")).toBe(true);
    expect(isErrorSummary("authentication_error: invalid token")).toBe(true);
    expect(isErrorSummary("permission_error returned by server")).toBe(true);
  });

  it("returns false for valid summary text", () => {
    expect(isErrorSummary("## Key Facts\n- Worked on memory consolidation")).toBe(false);
    expect(isErrorSummary("This week the team focused on improving the agent pipeline.")).toBe(false);
  });

  // 2026-08-28 (Phase 999.113 WS-5) — this block previously asserted
  // `isErrorSummary("") === false`, i.e. it PINNED an empty summarizer result
  // as usable digest content. `summarizeWithHaiku` returns "" on every bridge
  // failure, and `runConsolidation` archives (renames) the week's live daily
  // logs once a digest is written — so the pinned behaviour traded real memory
  // for an empty file. The guard now rejects absent/degenerate output.
  it("treats absent or degenerate output as unusable (the empty-digest data-loss path)", () => {
    expect(isErrorSummary("")).toBe(true);
    expect(isErrorSummary("   \n\t  ")).toBe(true);
    expect(isErrorSummary("ok")).toBe(true);
    expect(isErrorSummary("x".repeat(MIN_USABLE_SUMMARY_CHARS - 1))).toBe(true);
    expect(isErrorSummary("x".repeat(MIN_USABLE_SUMMARY_CHARS))).toBe(false);
    // Non-string inputs reach here from untyped call sites; never usable.
    expect(isErrorSummary(undefined as unknown as string)).toBe(true);
  });
});

describe("Consolidation Pipeline", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "consolidation-test-"));
  });

  afterEach(() => {
    // Best effort cleanup (tests use temp dirs)
  });

  describe("detectUnconsolidatedWeeks", () => {
    it("returns ISO week groups with 7+ daily log files when no weekly digest exists", () => {
      // ISO week 2 of 2026: Mon Jan 5 - Sun Jan 11
      const dates = [
        "2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08",
        "2026-01-09", "2026-01-10", "2026-01-11",
      ];
      createDailyLogs(tempDir, dates);

      const weeks = detectUnconsolidatedWeeks(tempDir, 7);
      expect(weeks).toHaveLength(1);
      expect(weeks[0].year).toBe(2026);
      expect(weeks[0].week).toBe(2);
      expect(weeks[0].files).toHaveLength(7);
    });

    it("returns empty when weekly digest already exists (idempotent)", () => {
      // ISO week 2 of 2026: Mon Jan 5 - Sun Jan 11
      const dates = [
        "2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08",
        "2026-01-09", "2026-01-10", "2026-01-11",
      ];
      createDailyLogs(tempDir, dates);

      // Create existing digest
      const digestDir = join(tempDir, "digests");
      mkdirSync(digestDir, { recursive: true });
      writeFileSync(join(digestDir, "weekly-2026-W02.md"), "# Weekly Digest\n");

      const weeks = detectUnconsolidatedWeeks(tempDir, 7);
      expect(weeks).toHaveLength(0);
    });

    it("does not return groups below threshold", () => {
      // Only 5 days in a week
      const dates = [
        "2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09",
      ];
      createDailyLogs(tempDir, dates);

      const weeks = detectUnconsolidatedWeeks(tempDir, 7);
      expect(weeks).toHaveLength(0);
    });

    it("handles ISO week year boundary correctly (Dec 29-31 can be week 1 of next year)", () => {
      // Dec 29, 2025 is ISO week 1 of 2026 (Monday Dec 29, 2025)
      // ISO week 1 of 2026: Mon Dec 29 2025 - Sun Jan 4 2026
      const dates = [
        "2025-12-29", "2025-12-30", "2025-12-31",
        "2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04",
      ];
      createDailyLogs(tempDir, dates);

      const weeks = detectUnconsolidatedWeeks(tempDir, 7);
      expect(weeks).toHaveLength(1);
      // ISO week year is 2026 for this week, even though some dates are in calendar year 2025
      expect(weeks[0].year).toBe(2026);
      expect(weeks[0].week).toBe(1);
    });

    it("skips the in-progress (current) ISO week — never digests/archives active logs", () => {
      // now = 2026-06-18 (mid-June). Past week (Jun 8-10) is eligible; the
      // current week's logs (Jun 15-18, including `now`) must be skipped so
      // consolidation never archives the active week.
      const now = new Date("2026-06-18T12:00:00.000Z");
      createDailyLogs(tempDir, ["2026-06-08", "2026-06-09", "2026-06-10"]);
      createDailyLogs(tempDir, ["2026-06-15", "2026-06-16", "2026-06-17", "2026-06-18"]);

      const weeks = detectUnconsolidatedWeeks(tempDir, 1, now);
      const files = weeks.flatMap((w) => w.files);
      expect(files).toContain("2026-06-08.md"); // past week still detected
      expect(files).not.toContain("2026-06-18.md"); // current week excluded
      expect(files).not.toContain("2026-06-15.md");
    });
  });

  describe("detectUnconsolidatedMonths", () => {
    it("returns months with 4+ weekly digests when no monthly digest exists", () => {
      const digestDir = join(tempDir, "digests");
      mkdirSync(digestDir, { recursive: true });

      // 4 weekly digests whose week START falls in January 2026
      // Weeks 2, 3, 4, 5 of 2026 all start in January
      writeFileSync(join(digestDir, "weekly-2026-W02.md"), "# Week 2\n");
      writeFileSync(join(digestDir, "weekly-2026-W03.md"), "# Week 3\n");
      writeFileSync(join(digestDir, "weekly-2026-W04.md"), "# Week 4\n");
      writeFileSync(join(digestDir, "weekly-2026-W05.md"), "# Week 5\n");

      const months = detectUnconsolidatedMonths(tempDir, 4);
      expect(months).toHaveLength(1);
      expect(months[0].year).toBe(2026);
      expect(months[0].month).toBe(1);
      expect(months[0].digestFiles).toHaveLength(4);
    });

    it("returns empty when monthly digest already exists (idempotent)", () => {
      const digestDir = join(tempDir, "digests");
      mkdirSync(digestDir, { recursive: true });

      writeFileSync(join(digestDir, "weekly-2026-W02.md"), "# Week 2\n");
      writeFileSync(join(digestDir, "weekly-2026-W03.md"), "# Week 3\n");
      writeFileSync(join(digestDir, "weekly-2026-W04.md"), "# Week 4\n");
      writeFileSync(join(digestDir, "weekly-2026-W05.md"), "# Week 5\n");

      // Monthly digest already exists
      writeFileSync(join(digestDir, "monthly-2026-01.md"), "# Monthly Digest Jan\n");

      const months = detectUnconsolidatedMonths(tempDir, 4);
      expect(months).toHaveLength(0);
    });

    it("does not return groups below threshold", () => {
      const digestDir = join(tempDir, "digests");
      mkdirSync(digestDir, { recursive: true });

      // Only 3 weekly digests
      writeFileSync(join(digestDir, "weekly-2026-W02.md"), "# Week 2\n");
      writeFileSync(join(digestDir, "weekly-2026-W03.md"), "# Week 3\n");
      writeFileSync(join(digestDir, "weekly-2026-W04.md"), "# Week 4\n");

      const months = detectUnconsolidatedMonths(tempDir, 4);
      expect(months).toHaveLength(0);
    });
  });

  describe("buildWeeklySummarizationPrompt", () => {
    it("includes all daily log content and requests structured extraction", () => {
      const dailyLogs = [
        { date: "2026-01-05", content: "Log content for Monday" },
        { date: "2026-01-06", content: "Log content for Tuesday" },
      ];

      const prompt = buildWeeklySummarizationPrompt(dailyLogs);

      // Should contain date headers and content
      expect(prompt).toContain("2026-01-05");
      expect(prompt).toContain("2026-01-06");
      expect(prompt).toContain("Log content for Monday");
      expect(prompt).toContain("Log content for Tuesday");

      // Should request structured extraction (D-06, D-14)
      expect(prompt).toContain("Key Facts");
      expect(prompt).toContain("Decisions Made");
      expect(prompt).toContain("Topics Discussed");
      expect(prompt).toContain("Important Context");
    });

    it("truncates proportionally when content exceeds 30000 chars", () => {
      const longContent = "A".repeat(20000);
      const dailyLogs = [
        { date: "2026-01-05", content: longContent },
        { date: "2026-01-06", content: longContent },
      ];

      const prompt = buildWeeklySummarizationPrompt(dailyLogs);

      // Prompt should be under a reasonable limit
      expect(prompt.length).toBeLessThan(35000);
      // Should note truncation
      expect(prompt).toContain("truncat");
    });
  });

  describe("buildMonthlySummarizationPrompt", () => {
    it("synthesizes weekly digests into monthly themes", () => {
      const weeklyDigests = [
        { week: "W02", content: "Week 2 digest content" },
        { week: "W03", content: "Week 3 digest content" },
      ];

      const prompt = buildMonthlySummarizationPrompt(weeklyDigests);
      expect(prompt).toContain("W02");
      expect(prompt).toContain("W03");
      expect(prompt).toContain("Week 2 digest content");
      expect(prompt).toContain("Week 3 digest content");
    });
  });

  describe("writeWeeklyDigest", () => {
    it("creates markdown file and inserts SQLite entry with source=consolidation, importance=0.7", async () => {
      const deps = createTestDeps(tempDir);
      const weekGroup: WeekGroup = {
        year: 2026,
        week: 2,
        startDate: "2026-01-05",
        endDate: "2026-01-11",
        files: ["2026-01-05.md", "2026-01-06.md"],
      };

      const digest = await writeWeeklyDigest(deps, weekGroup, "## Key Facts\n- Test fact\n");

      // Check markdown file was created
      const digestPath = join(tempDir, "digests", "weekly-2026-W02.md");
      expect(existsSync(digestPath)).toBe(true);
      const content = readFileSync(digestPath, "utf-8");
      expect(content).toContain("Key Facts");

      // Check digest return
      expect(digest.year).toBe(2026);
      expect(digest.week).toBe(2);
      expect(digest.period).toBe("weekly");

      // Check SQLite entry via listRecent
      const entries = deps.memoryStore.listRecent(10);
      const consolidationEntry = entries.find((e) => e.source === "consolidation");
      expect(consolidationEntry).toBeDefined();
      expect(consolidationEntry!.importance).toBe(0.7);
      expect(consolidationEntry!.tags).toContain("weekly-digest");
      expect(consolidationEntry!.tags).toContain("2026-W02");

      // Check embedder was called
      expect(deps.embedder.embed).toHaveBeenCalled();

      deps.memoryStore.close();
    });
  });

  describe("writeMonthlyDigest", () => {
    it("creates markdown file and inserts SQLite entry with source=consolidation, importance=0.8", async () => {
      const deps = createTestDeps(tempDir);
      const monthGroup: MonthGroup = {
        year: 2026,
        month: 1,
        digestFiles: ["weekly-2026-W02.md", "weekly-2026-W03.md"],
      };

      const digest = await writeMonthlyDigest(deps, monthGroup, "## Monthly Themes\n- Theme 1\n");

      // Check markdown file was created
      const digestPath = join(tempDir, "digests", "monthly-2026-01.md");
      expect(existsSync(digestPath)).toBe(true);
      const content = readFileSync(digestPath, "utf-8");
      expect(content).toContain("Monthly Themes");

      // Check digest return
      expect(digest.year).toBe(2026);
      expect(digest.month).toBe(1);
      expect(digest.period).toBe("monthly");

      // Check SQLite entry
      const entries = deps.memoryStore.listRecent(10);
      const consolidationEntry = entries.find((e) => e.source === "consolidation");
      expect(consolidationEntry).toBeDefined();
      expect(consolidationEntry!.importance).toBe(0.8);
      expect(consolidationEntry!.tags).toContain("monthly-digest");
      expect(consolidationEntry!.tags).toContain("2026-01");

      deps.memoryStore.close();
    });
  });

  describe("archiveDailyLogs", () => {
    it("moves files to memory/archive/YYYY/ and deletes from session_logs", async () => {
      const store = new MemoryStore(":memory:");

      // Create daily log files
      const dates = ["2026-01-05", "2026-01-06"];
      createDailyLogs(tempDir, dates);

      // Record session logs in the store
      for (const date of dates) {
        store.recordSessionLog({
          date,
          filePath: join(tempDir, `${date}.md`),
          entryCount: 1,
        });
      }

      const files = dates.map((d) => join(tempDir, `${d}.md`));
      const count = await archiveDailyLogs(tempDir, store, files);

      expect(count).toBe(2);

      // Files should be gone from original location
      expect(existsSync(join(tempDir, "2026-01-05.md"))).toBe(false);
      expect(existsSync(join(tempDir, "2026-01-06.md"))).toBe(false);

      // Files should exist in archive
      expect(existsSync(join(tempDir, "archive", "2026", "2026-01-05.md"))).toBe(true);
      expect(existsSync(join(tempDir, "archive", "2026", "2026-01-06.md"))).toBe(true);

      // Session logs should be deleted from the store
      const remainingDates = store.getSessionLogDates();
      expect(remainingDates).toHaveLength(0);

      store.close();
    });

    it("preserves original file content unmodified", async () => {
      const store = new MemoryStore(":memory:");
      const date = "2026-01-05";
      const originalContent = `# Session Log: ${date}\n\nSome unique content here.\n`;
      const filePath = join(tempDir, `${date}.md`);
      writeFileSync(filePath, originalContent);

      store.recordSessionLog({
        date,
        filePath,
        entryCount: 1,
      });

      await archiveDailyLogs(tempDir, store, [filePath]);

      const archivedContent = readFileSync(
        join(tempDir, "archive", "2026", `${date}.md`),
        "utf-8",
      );
      expect(archivedContent).toBe(originalContent);

      store.close();
    });
  });

  describe("runConsolidation (orchestration)", () => {
    it("produces no duplicate digests when run twice (idempotent)", async () => {
      const deps = createTestDeps(tempDir);

      // Create 7 daily logs in ISO week 2 of 2026
      const dates = [
        "2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08",
        "2026-01-09", "2026-01-10", "2026-01-11",
      ];
      createDailyLogs(tempDir, dates);

      // Record in session_logs
      for (const date of dates) {
        deps.memoryStore.recordSessionLog({
          date,
          filePath: join(tempDir, `${date}.md`),
          entryCount: 1,
        });
      }

      const config: ConsolidationConfig = {
        enabled: true,
        weeklyThreshold: 7,
        monthlyThreshold: 4,
        schedule: "0 3 * * *",
      };

      // First run
      const result1 = await runConsolidation(deps, config);
      expect(result1.weeklyDigestsCreated).toBe(1);

      // Second run should produce no new digests (idempotent)
      const result2 = await runConsolidation(deps, config);
      expect(result2.weeklyDigestsCreated).toBe(0);
      expect(result2.monthlyDigestsCreated).toBe(0);

      deps.memoryStore.close();
    });

    it("runs weekly consolidation before monthly", async () => {
      const deps = createTestDeps(tempDir);

      const config: ConsolidationConfig = {
        enabled: true,
        weeklyThreshold: 7,
        monthlyThreshold: 4,
        schedule: "0 3 * * *",
      };

      // Create enough weekly digests to trigger monthly, plus daily logs for weekly
      const digestDir = join(tempDir, "digests");
      mkdirSync(digestDir, { recursive: true });

      // 4 existing weekly digests for January 2026
      writeFileSync(join(digestDir, "weekly-2026-W02.md"), "# Week 2\n");
      writeFileSync(join(digestDir, "weekly-2026-W03.md"), "# Week 3\n");
      writeFileSync(join(digestDir, "weekly-2026-W04.md"), "# Week 4\n");
      writeFileSync(join(digestDir, "weekly-2026-W05.md"), "# Week 5\n");

      const result = await runConsolidation(deps, config);

      // Should have created a monthly digest
      expect(result.monthlyDigestsCreated).toBe(1);

      deps.memoryStore.close();
    });

    it("skips weekly digest and records error when summarize returns API error text", async () => {
      const deps = createTestDeps(tempDir);
      (deps.summarize as ReturnType<typeof vi.fn>).mockResolvedValue(
        "Credit balance is too low to complete this request.",
      );

      const dates = [
        "2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08",
        "2026-01-09", "2026-01-10", "2026-01-11",
      ];
      createDailyLogs(tempDir, dates);
      for (const date of dates) {
        deps.memoryStore.recordSessionLog({
          date,
          filePath: join(tempDir, `${date}.md`),
          entryCount: 1,
        });
      }

      const config: ConsolidationConfig = {
        enabled: true,
        weeklyThreshold: 7,
        monthlyThreshold: 4,
        schedule: "0 3 * * *",
      };

      const result = await runConsolidation(deps, config);

      expect(result.weeklyDigestsCreated).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("no usable content");

      const digestDir = join(tempDir, "digests");
      const files = existsSync(digestDir) ? readdirSync(digestDir) : [];
      expect(files.filter((f) => f.startsWith("weekly-"))).toHaveLength(0);

      deps.memoryStore.close();
    });

    it("skips monthly digest and records error when summarize returns API error text", async () => {
      const deps = createTestDeps(tempDir);
      (deps.summarize as ReturnType<typeof vi.fn>).mockResolvedValue(
        "API Error: 402 — Credit balance is too low.",
      );

      const digestDir = join(tempDir, "digests");
      mkdirSync(digestDir, { recursive: true });
      writeFileSync(join(digestDir, "weekly-2026-W02.md"), "# Week 2\n");
      writeFileSync(join(digestDir, "weekly-2026-W03.md"), "# Week 3\n");
      writeFileSync(join(digestDir, "weekly-2026-W04.md"), "# Week 4\n");
      writeFileSync(join(digestDir, "weekly-2026-W05.md"), "# Week 5\n");

      const config: ConsolidationConfig = {
        enabled: true,
        weeklyThreshold: 7,
        monthlyThreshold: 4,
        schedule: "0 3 * * *",
      };

      const result = await runConsolidation(deps, config);

      expect(result.monthlyDigestsCreated).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("no usable content");

      const files = readdirSync(digestDir);
      expect(files.filter((f) => f.startsWith("monthly-"))).toHaveLength(0);

      deps.memoryStore.close();
    });

    it("collects errors without stopping partial consolidation", async () => {
      const deps = createTestDeps(tempDir);

      // Make summarize fail
      (deps.summarize as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("LLM unavailable"));

      // Create 7 daily logs
      const dates = [
        "2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08",
        "2026-01-09", "2026-01-10", "2026-01-11",
      ];
      createDailyLogs(tempDir, dates);

      for (const date of dates) {
        deps.memoryStore.recordSessionLog({
          date,
          filePath: join(tempDir, `${date}.md`),
          entryCount: 1,
        });
      }

      const config: ConsolidationConfig = {
        enabled: true,
        weeklyThreshold: 7,
        monthlyThreshold: 4,
        schedule: "0 3 * * *",
      };

      const result = await runConsolidation(deps, config);

      // Should have errors but not throw
      expect(result.errors.length).toBeGreaterThan(0);

      deps.memoryStore.close();
    });
  });
});
