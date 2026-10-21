/**
 * Phase 92 Plan 06 — Verify pipeline orchestrator (CUT-09).
 *
 * Orchestrates Plans 92-01..05 end-to-end into a single operator-facing flow:
 *
 *   1. ingestDiscordHistory     → JSONL staging
 *   2. runSourceProfiler        → AGENT-PROFILE.json
 *   3. probeTargetCapability    → TARGET-CAPABILITY.json
 *   4. diffAgentVsTarget        → CutoverGap[]   (pure)
 *   5. applyAdditiveFixes       → AdditiveApplyOutcome (dry-run unless --apply-additive)
 *   6. canary (synthesize → run) → CanaryInvocationResult[] (only if zero
 *                                  destructive gaps remaining AND opted in)
 *   7. writeCutoverReport       → CUTOVER-REPORT.md
 *
 * Sequential — no parallelism. Halts on first FAIL but ALWAYS emits a report
 * if it gets past phase 4 (so the operator has a CUTOVER-REPORT.md to inspect
 * even on partial-failure paths). VP6 invocationCallOrder pins the sequence.
 *
 * All primitives are dependency-injected via VerifyPipelineDeps so tests pass
 * vi.fn() stubs and production wires the real Plans 92-01..05 modules.
 */

import { readFile } from "node:fs/promises";
import type { Logger } from "pino";

import type {
  AdditiveApplyOutcome,
  AgentProfile,
  CanaryInvocationResult,
  CutoverGap,
  TargetCapability,
  VerifyOutcome,
} from "./types.js";

import type { ingestDiscordHistory } from "./discord-ingestor.js";
import type { runSourceProfiler } from "./source-profiler.js";
import type { probeTargetCapability } from "./target-probe.js";
import type { diffAgentVsTarget } from "./diff-engine.js";
import type { applyAdditiveFixes } from "./additive-applier.js";
import type { runCanary } from "./canary-runner.js";
import type { synthesizeCanaryPrompts } from "./canary-synthesizer.js";
import type { writeCutoverReport } from "./report-writer.js";

/**
 * VerifyPipelineDeps — DI surface for all 7 phase functions + sub-deps maps
 * for the per-phase primitives that need them.
 *
 * The `*Deps` fields are `Omit<Parameters<...>[0], "agent">` shaped — the
 * pipeline injects `agent` consistently across all phases so callers don't
 * have to thread it through every sub-deps object manually.
 */
export type VerifyPipelineDeps = {
  readonly agent: string;
  readonly applyAdditive: boolean;
  readonly runCanaryOnReady: boolean;
  readonly outputDir: string;
  readonly stagingDir: string;
  // Phase functions (Plans 92-01..05 + the report writer from this plan).
  readonly ingestDiscordHistory: typeof ingestDiscordHistory;
  readonly runSourceProfiler: typeof runSourceProfiler;
  readonly probeTargetCapability: typeof probeTargetCapability;
  readonly diffAgentVsTarget: typeof diffAgentVsTarget;
  readonly applyAdditiveFixes: typeof applyAdditiveFixes;
  readonly synthesizeCanaryPrompts: typeof synthesizeCanaryPrompts;
  readonly runCanary: typeof runCanary;
  readonly writeCutoverReport: typeof writeCutoverReport;
  // Per-phase sub-deps. Tests pass empty objects; production wires real
  // primitive args. The agent + per-phase computed fields (gaps, prompts,
  // etc.) are added by the pipeline so sub-deps stay reusable across runs.
  readonly ingestDeps: Omit<
    Parameters<typeof ingestDiscordHistory>[0],
    "agent"
  >;
  readonly profileDeps: Omit<
    Parameters<typeof runSourceProfiler>[0],
    "agent"
  >;
  readonly probeDeps: Omit<Parameters<typeof probeTargetCapability>[0], "agent">;
  readonly applierDeps: Omit<
    Parameters<typeof applyAdditiveFixes>[0],
    "agent" | "gaps" | "apply"
  >;
  readonly canaryDeps: Omit<
    Parameters<typeof runCanary>[0],
    "agent" | "prompts"
  >;
  readonly synthesizerDeps: Omit<
    Parameters<typeof synthesizeCanaryPrompts>[0],
    "agent" | "topIntents"
  >;
  readonly log: Logger;
};

/**
 * Run one full verify cycle. Returns a `VerifyOutcome` discriminated union;
 * the CLI wrapper exhaustively switches on `outcome.kind` for exit codes.
 *
 * Phase ordering is sequential and gated — any phase failure short-circuits
 * the rest WITH the exception that writeCutoverReport always runs once we've
 * computed gaps (so the operator always has a report to inspect).
 */
export async function runVerifyPipeline(
  deps: VerifyPipelineDeps,
): Promise<VerifyOutcome> {
  const { agent, log } = deps;

  // ------------------------------------------------------------------------
  // 1. Ingest
  // ------------------------------------------------------------------------
  const ingestRes = await deps.ingestDiscordHistory({
    ...deps.ingestDeps,
    agent,
  });
  if (ingestRes.kind !== "ingested" && ingestRes.kind !== "no-changes") {
    log.warn(
      { ingest: ingestRes.kind },
      "verify-pipeline: ingest failed — bubbling up",
    );
    return {
      kind: "ingest-failed",
      agent,
      error: JSON.stringify(ingestRes),
    };
  }

  // ------------------------------------------------------------------------
  // 2. Profile
  // ------------------------------------------------------------------------
  const profileRes = await deps.runSourceProfiler({
    ...deps.profileDeps,
    agent,
  });
  if (profileRes.kind !== "profiled") {
    return {
      kind: "profile-failed",
      agent,
      error: JSON.stringify(profileRes),
    };
  }

  // ------------------------------------------------------------------------
  // 3. Probe
  // ------------------------------------------------------------------------
  const probeRes = await deps.probeTargetCapability({
    ...deps.probeDeps,
    agent,
  });
  if (probeRes.kind !== "probed") {
    return {
      kind: "probe-failed",
      agent,
      error: JSON.stringify(probeRes),
    };
  }

  // ------------------------------------------------------------------------
  // 4. Diff (pure — no I/O — but we need the profile + capability JSON loaded)
  // ------------------------------------------------------------------------
  let profile: AgentProfile;
  let capability: TargetCapability;
  try {
    profile = JSON.parse(
      await readFile(profileRes.profilePath, "utf8"),
    ) as AgentProfile;
    capability = JSON.parse(
      await readFile(probeRes.capabilityPath, "utf8"),
    ) as TargetCapability;
  } catch (err) {
    return {
      kind: "diff-failed",
      agent,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const gaps: readonly CutoverGap[] = deps.diffAgentVsTarget(
    profile,
    capability,
  );
  const destructiveCount = gaps.filter((g) => g.severity === "destructive")
    .length;

  // ------------------------------------------------------------------------
  // 5. Apply additive (always called — dry-run when applyAdditive=false)
  // ------------------------------------------------------------------------
  const additiveOutcome: AdditiveApplyOutcome = await deps.applyAdditiveFixes({
    ...deps.applierDeps,
    agent,
    gaps,
    apply: deps.applyAdditive,
  });

  // Surface short-circuiting failure modes from the applier as outcome.
  // (dry-run / applied / destructive-gaps-deferred are all "continue".)
  if (
    additiveOutcome.kind === "secret-scan-refused" ||
    additiveOutcome.kind === "yaml-write-failed" ||
    additiveOutcome.kind === "rsync-failed"
  ) {
    return {
      kind: "additive-apply-failed",
      agent,
      error: JSON.stringify(additiveOutcome),
      identifier: additiveOutcome.identifier,
    };
  }

  // ------------------------------------------------------------------------
  // 6. Canary — only if zero destructive gaps remaining AND caller opted in
  //    (destructive gaps guarantee cutover_ready: false anyway, so running
  //    the canary battery would be wasted compute + Discord rate-limit budget)
  // ------------------------------------------------------------------------
  let canaryResults: readonly CanaryInvocationResult[] | null = null;
  if (destructiveCount === 0 && deps.runCanaryOnReady) {
    const synthRes = await deps.synthesizeCanaryPrompts({
      ...deps.synthesizerDeps,
      agent,
      topIntents: profile.topIntents,
    });
    if (synthRes.kind !== "synthesized") {
      // Still emit a report so the operator sees the outcome.
      await deps.writeCutoverReport({
        agent,
        gaps,
        canaryResults: null,
        additiveOutcome,
        outputDir: deps.outputDir,
      });
      return {
        kind: "canary-failed",
        agent,
        error: `synth: ${JSON.stringify(synthRes)}`,
      };
    }
    const canaryRes = await deps.runCanary({
      ...deps.canaryDeps,
      agent,
      prompts: synthRes.prompts,
    });
    if (canaryRes.kind === "ran") {
      canaryResults = canaryRes.results;
    } else {
      await deps.writeCutoverReport({
        agent,
        gaps,
        canaryResults: null,
        additiveOutcome,
        outputDir: deps.outputDir,
      });
      return {
        kind: "canary-failed",
        agent,
        error: JSON.stringify(canaryRes),
      };
    }
  }

  // ------------------------------------------------------------------------
  // 7. Report (always — even when canary was skipped or failed mid-run)
  // ------------------------------------------------------------------------
  const reportRes = await deps.writeCutoverReport({
    agent,
    gaps,
    canaryResults,
    additiveOutcome,
    outputDir: deps.outputDir,
  });
  if (reportRes.kind !== "written") {
    return {
      kind: "report-write-failed",
      agent,
      error: reportRes.error,
    };
  }

  const passRate =
    canaryResults === null || canaryResults.length === 0
      ? 0
      : (canaryResults.filter((r) => r.status === "passed").length /
          canaryResults.length) *
        100;

  if (reportRes.cutoverReady) {
    return {
      kind: "verified-ready",
      agent,
      reportPath: reportRes.reportPath,
      gapCount: 0,
      canaryPassRate: passRate,
    };
  }
  return {
    kind: "verified-not-ready",
    agent,
    reportPath: reportRes.reportPath,
    gapCount: gaps.length,
    destructiveCount,
    canaryPassRate: passRate,
    reason:
      destructiveCount > 0
        ? "destructive-gaps-remaining"
        : canaryResults === null
          ? "canary-not-run"
          : "canary-pass-rate-below-100",
  };
}
