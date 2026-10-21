/**
 * Phase 92 Plan 05 — Canary report writer (CUT-08).
 *
 * Pure function that takes `CanaryInvocationResult[]` and writes a
 * markdown CANARY-REPORT.md with:
 *
 *   - YAML frontmatter pinned for Plan 92-06 consumption: `canary_pass_rate`,
 *     `total_invocations`, `total_prompts`, `total_paths`, `passed`,
 *     `failed`, `agent`, `generated_at` (ISO 8601).
 *   - Per-prompt markdown table with the EXACT column header pinned by P2:
 *     `| intent | prompt | discord-bot | api | discord-bot-ms | api-ms |`
 *
 * Atomic temp+rename via `fs.rename` (Phase 84/91 pattern). The .tmp
 * suffix is unique-randomized so concurrent writers (defensive — there
 * shouldn't be any since the canary is one-shot) don't collide. Final
 * file appears at the canonical path only after rename succeeds; on
 * failure no .tmp lingers (try/finally with best-effort unlink).
 */

import { mkdir, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { CanaryInvocationResult, CanaryReportOutcome } from "./types.js";

export type CanaryReportDeps = {
  readonly agent: string;
  readonly results: readonly CanaryInvocationResult[];
  readonly outputDir: string;
  readonly now?: () => Date;
};

/**
 * Write the canary report. Returns a `CanaryReportOutcome` — never
 * throws on a normal write-failed path; only programmer errors (e.g.
 * mkdir EACCES due to filesystem misconfiguration) bubble up.
 */
export async function writeCanaryReport(
  deps: CanaryReportDeps,
): Promise<CanaryReportOutcome> {
  const tmpToCleanup: string[] = [];
  try {
    const generatedAt = (deps.now ?? (() => new Date()))().toISOString();
    const total = deps.results.length;
    const passed = deps.results.filter((r) => r.status === "passed").length;
    const failed = total - passed;
    // canary_pass_rate is rounded to one decimal place (Plan 92-06 reads
    // this as a number and applies `>= 100` for the gate; whole-number
    // happy paths produce integer-valued YAML which parses cleanly).
    const passRate =
      total === 0 ? 0 : Math.round((passed / total) * 1000) / 10;

    // Group by intent. Each intent contributes 2 results (discord-bot + api)
    // — this aggregator pairs them into a single table row per intent.
    const byIntent = new Map<
      string,
      {
        prompt: string;
        discord?: CanaryInvocationResult;
        api?: CanaryInvocationResult;
      }
    >();
    for (const r of deps.results) {
      const cur = byIntent.get(r.intent) ?? { prompt: r.prompt };
      if (r.path === "discord-bot") cur.discord = r;
      else cur.api = r;
      byIntent.set(r.intent, cur);
    }
    // total_prompts is the count of unique intents (not invocations / 2 —
    // the runner could in theory emit one path per prompt; using the map
    // size is the canonical count).
    const totalPrompts = byIntent.size;

    const frontmatter = [
      "---",
      `agent: ${deps.agent}`,
      `generated_at: ${generatedAt}`,
      `total_prompts: ${totalPrompts}`,
      `total_paths: 2`,
      `total_invocations: ${total}`,
      `passed: ${passed}`,
      `failed: ${failed}`,
      `canary_pass_rate: ${passRate}`,
      "---",
      "",
    ].join("\n");

    const tableHeader =
      "| intent | prompt | discord-bot | api | discord-bot-ms | api-ms |\n" +
      "| --- | --- | --- | --- | --- | --- |";

    const truncate = (s: string, n: number): string =>
      s.length > n ? s.slice(0, n - 1) + "\u2026" : s;

    // Spread + sort — never mutate the byIntent iteration order in place.
    const rows = [...byIntent.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([intent, agg]) => {
        // Escape any literal `|` characters in the prompt so they don't break
        // markdown table parsing; collapse newlines to spaces.
        const promptCell = truncate(
          agg.prompt.replace(/\|/g, "\\|").replace(/\r?\n/g, " "),
          80,
        );
        const dStatus = agg.discord?.status ?? "—";
        const aStatus = agg.api?.status ?? "—";
        const dMs =
          agg.discord !== undefined ? String(agg.discord.durationMs) : "—";
        const aMs =
          agg.api !== undefined ? String(agg.api.durationMs) : "—";
        return `| ${intent} | ${promptCell} | ${dStatus} | ${aStatus} | ${dMs} | ${aMs} |`;
      })
      .join("\n");

    const body =
      frontmatter +
      "# Cutover Canary Report\n\n" +
      `Agent: \`${deps.agent}\`  \n` +
      `Generated: ${generatedAt}  \n` +
      `Pass rate: **${passRate}%** (${passed}/${total} invocations across ${totalPrompts} prompts × 2 paths)\n\n` +
      tableHeader +
      "\n" +
      rows +
      "\n";

    await mkdir(deps.outputDir, { recursive: true });
    const outPath = join(deps.outputDir, "CANARY-REPORT.md");
    const tmp = `${outPath}.${randomBytes(6).toString("hex")}.tmp`;
    tmpToCleanup.push(tmp);
    await writeFile(tmp, body, "utf8");
    await rename(tmp, outPath);
    // Successful rename consumes the tmp inode — nothing to clean up.
    tmpToCleanup.length = 0;

    return {
      kind: "written",
      agent: deps.agent,
      reportPath: outPath,
      passRate,
    };
  } catch (err) {
    // Best-effort cleanup of any lingering tmp file.
    for (const tmp of tmpToCleanup) {
      try {
        await unlink(tmp);
      } catch {
        /* ignore — file may not exist if writeFile was the failure */
      }
    }
    return {
      kind: "write-failed",
      agent: deps.agent,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
