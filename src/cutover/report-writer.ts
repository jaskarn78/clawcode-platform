/**
 * Phase 92 Plan 06 — CUTOVER-REPORT.md writer + reader (CUT-09 + D-09).
 *
 * `writeCutoverReport` aggregates `CutoverGap[]` (from Plan 92-02 diff engine),
 * `CanaryInvocationResult[]` (from Plan 92-05 canary runner), and the
 * `AdditiveApplyOutcome` (from Plan 92-03 applier) into a markdown report
 * with a YAML frontmatter pinned for downstream consumption.
 *
 * `readCutoverReport` parses the frontmatter back into a structured shape via
 * `cutoverReportFrontmatterSchema`. Used by the Phase 91 set-authoritative
 * precondition gate (Plan 92-06 modification of sync-set-authoritative.ts).
 *
 * Pinned invariants:
 *   - Frontmatter fields: agent, cutover_ready, report_generated_at,
 *     gap_count, additive_gap_count, destructive_gap_count, canary_pass_rate,
 *     canary_total_invocations
 *   - Final non-blank line of the markdown is literally `Cutover ready: true`
 *     or `Cutover ready: false` (E-LITERAL test pin)
 *   - cutover_ready: true iff (gaps.length === 0 AND canaryResults !== null
 *     AND passRate === 100). A clean diff without a passing canary is NOT
 *     cutover-ready (CUT-09 contract).
 *   - Atomic temp+rename via fs.rename with nanoid suffix; best-effort tmp
 *     unlink on failure. Mirrors Phase 84/91 markdown writer discipline.
 */

import {
  mkdir,
  writeFile,
  rename,
  unlink,
  readFile,
} from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { parse as yamlParse } from "yaml";

import {
  cutoverReportFrontmatterSchema,
  type AdditiveApplyOutcome,
  type CanaryInvocationResult,
  type CutoverGap,
  type CutoverReportFrontmatter,
} from "./types.js";

export type CutoverReportDeps = {
  readonly agent: string;
  readonly gaps: readonly CutoverGap[];
  /** null when canary was skipped (e.g. destructive gaps remaining). */
  readonly canaryResults: readonly CanaryInvocationResult[] | null;
  readonly additiveOutcome: AdditiveApplyOutcome | null;
  readonly outputDir: string;
  readonly now?: () => Date;
};

export type WriteCutoverReportResult =
  | { kind: "written"; reportPath: string; cutoverReady: boolean }
  | { kind: "write-failed"; error: string };

/**
 * Write CUTOVER-REPORT.md atomically (temp+rename). Returns the resolved path
 * + the cutover_ready boolean. Never throws — write-failed is surfaced as a
 * variant of the return union.
 */
export async function writeCutoverReport(
  deps: CutoverReportDeps,
): Promise<WriteCutoverReportResult> {
  const tmpToCleanup: string[] = [];
  try {
    const generatedAt = (deps.now ?? (() => new Date()))().toISOString();
    const additiveCount = deps.gaps.filter((g) => g.severity === "additive")
      .length;
    const destructiveCount = deps.gaps.filter(
      (g) => g.severity === "destructive",
    ).length;

    const totalInvocations = deps.canaryResults?.length ?? 0;
    const passed =
      deps.canaryResults?.filter((r) => r.status === "passed").length ?? 0;
    // Round to one decimal place for stable serialization (matches CANARY-REPORT.md).
    const passRate =
      totalInvocations === 0
        ? 0
        : Math.round((passed / totalInvocations) * 1000) / 10;

    // cutover_ready true ONLY when: zero gaps remaining AND canary ran AND
    // passRate === 100. canaryResults === null masks the "canary skipped"
    // case so it can never be "ready" — Plan 92-06 contract.
    const cutoverReady =
      deps.gaps.length === 0 &&
      deps.canaryResults !== null &&
      totalInvocations > 0 &&
      passRate === 100;

    const fm: CutoverReportFrontmatter = {
      agent: deps.agent,
      cutover_ready: cutoverReady,
      report_generated_at: generatedAt,
      gap_count: deps.gaps.length,
      additive_gap_count: additiveCount,
      destructive_gap_count: destructiveCount,
      canary_pass_rate: passRate,
      canary_total_invocations: totalInvocations,
    };

    // Build action items / explanation block based on what's blocking the gate.
    const reasonLines: string[] = [];
    if (destructiveCount > 0) {
      reasonLines.push(
        `- ${destructiveCount} destructive gap(s) — address via /clawcode-cutover-verify in admin-clawdy`,
      );
    }
    if (additiveCount > 0) {
      reasonLines.push(
        `- ${additiveCount} additive gap(s) — run \`clawcode cutover apply-additive --apply --agent ${deps.agent}\``,
      );
    }
    if (deps.canaryResults === null) {
      reasonLines.push(
        `- Canary not run — re-run \`clawcode cutover verify --agent ${deps.agent}\` after addressing gaps`,
      );
    } else if (passRate < 100) {
      reasonLines.push(
        `- Canary pass rate ${passRate}% (${passed}/${totalInvocations}) — investigate failures in CANARY-REPORT.md`,
      );
    }

    const fmYaml = [
      "---",
      `agent: ${fm.agent}`,
      `cutover_ready: ${fm.cutover_ready}`,
      `report_generated_at: ${fm.report_generated_at}`,
      `gap_count: ${fm.gap_count}`,
      `additive_gap_count: ${fm.additive_gap_count}`,
      `destructive_gap_count: ${fm.destructive_gap_count}`,
      `canary_pass_rate: ${fm.canary_pass_rate}`,
      `canary_total_invocations: ${fm.canary_total_invocations}`,
      "---",
    ].join("\n");

    const summaryLines = [
      `# Cutover Report — ${deps.agent}`,
      "",
      `Generated: ${generatedAt}`,
      "",
      "## Summary",
      "",
      `- **Gaps remaining:** ${deps.gaps.length} (additive: ${additiveCount}, destructive: ${destructiveCount})`,
      `- **Canary:** ${
        deps.canaryResults === null
          ? "not run"
          : `${passed}/${totalInvocations} passed (${passRate}%)`
      }`,
      deps.additiveOutcome
        ? `- **Additive applier outcome:** \`${deps.additiveOutcome.kind}\``
        : "",
    ].filter((l) => l !== "");

    const actionBlock =
      reasonLines.length === 0
        ? ["", "## Status", "", "All checks pass. Cutover is ready to proceed.", ""]
        : ["", "## Action Items", "", ...reasonLines, ""];

    const gapBlock = [
      "## Gap Detail",
      "",
      deps.gaps.length === 0
        ? "(none)"
        : deps.gaps
            .map(
              (g) =>
                `- **${g.kind}** \`${g.identifier}\` (${g.severity})`,
            )
            .join("\n"),
      "",
    ];

    // The literal end-of-document line — pinned by E-LITERAL test. Both this
    // line AND the frontmatter cutover_ready flag are derived from the same
    // boolean, so they always agree.
    const literalLine = `Cutover ready: ${cutoverReady}`;

    const body =
      [fmYaml, "", ...summaryLines, ...actionBlock, ...gapBlock, literalLine, ""].join(
        "\n",
      );

    await mkdir(deps.outputDir, { recursive: true });
    const outPath = join(deps.outputDir, "CUTOVER-REPORT.md");
    const tmp = `${outPath}.${randomBytes(6).toString("hex")}.tmp`;
    tmpToCleanup.push(tmp);
    await writeFile(tmp, body, "utf8");
    await rename(tmp, outPath);
    tmpToCleanup.length = 0;

    return { kind: "written", reportPath: outPath, cutoverReady };
  } catch (err) {
    for (const tmp of tmpToCleanup) {
      try {
        await unlink(tmp);
      } catch {
        /* ignore */
      }
    }
    return {
      kind: "write-failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export type ReadCutoverReportResult =
  | { kind: "read"; frontmatter: CutoverReportFrontmatter; raw: string }
  | { kind: "missing" }
  | { kind: "invalid"; error: string };

/**
 * Read CUTOVER-REPORT.md back into a structured shape. Used by Phase 91's
 * sync-set-authoritative.ts precondition check. Never throws — missing /
 * invalid are surfaced as outcome variants.
 */
export async function readCutoverReport(
  filePath: string,
): Promise<ReadCutoverReportResult> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return { kind: "missing" };
  }
  const fmMatch = raw.match(/^---\n([\s\S]+?)\n---\n/);
  if (!fmMatch) {
    return { kind: "invalid", error: "no frontmatter" };
  }
  let parsedYaml: unknown;
  try {
    parsedYaml = yamlParse(fmMatch[1]!);
  } catch (err) {
    return {
      kind: "invalid",
      error: `yaml parse: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const parsed = cutoverReportFrontmatterSchema.safeParse(parsedYaml);
  if (!parsed.success) {
    return {
      kind: "invalid",
      error: `schema: ${parsed.error.message}`,
    };
  }
  return { kind: "read", frontmatter: parsed.data, raw };
}
