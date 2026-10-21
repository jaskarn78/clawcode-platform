/**
 * Phase 92 Plan 03 — `clawcode cutover apply-additive` subcommand.
 *
 * Reads CUTOVER-GAPS.json from the diff output directory (Plan 92-02), filters
 * to additive kinds, and applies fixes via `applyAdditiveFixes` with production
 * primitives wired in:
 *   - updateAgentSkills / updateAgentConfig from src/migration/yaml-writer.ts
 *   - scanSkillSecrets from src/migration/skills-secret-scan.ts
 *   - normalizeSkillFrontmatter from src/migration/skills-transformer.ts
 *   - rsync via node:child_process.execFile (zero new deps)
 *
 * Default invocation is DRY-RUN (apply: false). The `--apply` flag is opt-in
 * per D-07 (three-tier safety: dry-run default → --apply auto-applies the 4
 * additive kinds → destructive ALWAYS gated, NEVER auto).
 *
 * Exit code policy:
 *   - applied / dry-run                  → 0
 *   - no-gaps-file / secret-scan-refused → 1
 *   - yaml-write-failed / rsync-failed   → 1
 */
import type { Command } from "commander";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import pino, { type Logger } from "pino";

import {
  applyAdditiveFixes,
  type AdditiveApplierDeps,
  type RsyncResult,
  type SecretScanResult,
  type YamlWriteResult,
} from "../../cutover/additive-applier.js";
import { DEFAULT_CUTOVER_LEDGER_PATH } from "../../cutover/ledger.js";
import type { CutoverGap, AdditiveApplyOutcome } from "../../cutover/types.js";
import {
  updateAgentSkills,
  updateAgentConfig,
} from "../../migration/yaml-writer.js";
import { scanSkillSecrets } from "../../migration/skills-secret-scan.js";
import { normalizeSkillFrontmatter as normalizeSkillFrontmatterPure } from "../../migration/skills-transformer.js";
import { cliError, cliLog } from "../output.js";

export type RunCutoverApplyAdditiveArgs = Readonly<{
  agent: string;
  apply?: boolean;
  /** Override CUTOVER-GAPS.json path. Default: latest report dir. */
  gapsPath?: string;
  /** Override cutover-ledger.jsonl path. */
  ledgerPath?: string;
  /** Override clawcode.yaml path. Default: ~/.clawcode/clawcode.yaml. */
  clawcodeYamlPath?: string;
  /** Override skills target dir. Default: ~/.clawcode/skills/. */
  skillsTargetDir?: string;
  /** Override agent memoryRoot. Default: ~/.clawcode/agents/<agent>/. */
  memoryRoot?: string;
  /** Override OpenClaw SSH host. */
  openClawHost?: string;
  /** Override OpenClaw workspace path. */
  openClawWorkspace?: string;
  /** Override OpenClaw skills root path. */
  openClawSkillsRoot?: string;
  log?: Logger;
}>;

/**
 * Run one cutover apply-additive cycle. Returns the process exit code.
 *
 * Production wiring of Phase 84/86/91 primitives. Tests construct
 * AdditiveApplierDeps directly with vi.fn() stubs and call
 * applyAdditiveFixes — they bypass this CLI wrapper entirely.
 */
export async function runCutoverApplyAdditiveAction(
  args: RunCutoverApplyAdditiveArgs,
): Promise<number> {
  const log = args.log ?? (pino({ level: "info" }) as unknown as Logger);

  const gapsPath =
    args.gapsPath ??
    join(
      homedir(),
      ".clawcode",
      "manager",
      "cutover-reports",
      args.agent,
      "latest",
      "CUTOVER-GAPS.json",
    );

  if (!existsSync(gapsPath)) {
    const outcome: AdditiveApplyOutcome = {
      kind: "no-gaps-file",
      agent: args.agent,
      gapsPath,
    };
    cliLog(JSON.stringify(outcome, null, 2));
    return 1;
  }

  let gaps: readonly CutoverGap[];
  try {
    const raw = await readFile(gapsPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      cliError(`cutover apply-additive: expected JSON array at ${gapsPath}`);
      return 1;
    }
    gaps = parsed as readonly CutoverGap[];
  } catch (err) {
    cliError(
      `cutover apply-additive: failed to read ${gapsPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 1;
  }

  const clawcodeYamlPath =
    args.clawcodeYamlPath ?? join(homedir(), ".clawcode", "clawcode.yaml");
  const skillsTargetDir =
    args.skillsTargetDir ?? join(homedir(), ".clawcode", "skills");
  const memoryRoot =
    args.memoryRoot ?? join(homedir(), ".clawcode", "agents", args.agent);
  const uploadsTargetDir = join(memoryRoot, "uploads", "discord");
  const ledgerPath = args.ledgerPath ?? DEFAULT_CUTOVER_LEDGER_PATH;
  const openClawHost = args.openClawHost ?? "example-user@10.0.0.3";
  const openClawWorkspace =
    args.openClawWorkspace ?? "/home/example-user/.openclaw/workspace-acme";
  const openClawSkillsRoot =
    args.openClawSkillsRoot ?? "/home/example-user/.openclaw/skills";

  // ----- Production primitives wiring ----------------------------------

  const updateAgentSkillsAdapter = async (
    agent: string,
    nextSkills: readonly string[],
    opts: { clawcodeYamlPath: string },
  ): Promise<YamlWriteResult> => {
    // The Phase 86 atomic writer takes one skill at a time with op: add|remove.
    // Read current YAML to compute the delta and call updateAgentSkills per
    // skill that needs to be added. For the additive applier we only ever ADD
    // (the gap is "missing-skill"), so iterate the new entries that aren't in
    // the previous list. The applier passes a sorted superset; we diff against
    // an empty placeholder by dispatching add for each entry until the writer
    // reports no-op (idempotency-safe).
    let lastResult: { outcome: string; reason?: string } = { outcome: "no-op" };
    for (const skill of nextSkills) {
      const r = await updateAgentSkills({
        existingConfigPath: opts.clawcodeYamlPath,
        agentName: agent,
        skillName: skill,
        op: "add",
      });
      lastResult = r;
      if (r.outcome === "not-found" || r.outcome === "file-not-found") break;
    }
    return mapYamlOutcome(lastResult.outcome, lastResult.reason);
  };

  const updateAgentConfigAdapter = async (
    agent: string,
    patch: Readonly<Record<string, unknown>>,
    opts: { clawcodeYamlPath: string },
  ): Promise<YamlWriteResult> => {
    const r = await updateAgentConfig({
      existingConfigPath: opts.clawcodeYamlPath,
      agentName: agent,
      patch,
    });
    return mapYamlOutcome(r.outcome, "reason" in r ? r.reason : undefined);
  };

  const scanSkillForSecretsAdapter = async (
    skillDir: string,
  ): Promise<SecretScanResult> => {
    const result = await scanSkillSecrets(skillDir);
    if (result.pass) return { refused: false };
    return {
      refused: true,
      reason: result.offender?.reason ?? "secret detected",
    };
  };

  const normalizeSkillFrontmatterAdapter = async (
    skillDir: string,
  ): Promise<void> => {
    // Phase 84 normalizeSkillFrontmatter is a pure string transform on a
    // single SKILL.md content. The CLI wrapper's role is to read SKILL.md
    // (if present) and rewrite it via the transform. The dir-level operation
    // is intentionally idempotent: missing SKILL.md silently no-ops.
    const skillMdPath = join(skillDir, "SKILL.md");
    if (!existsSync(skillMdPath)) return;
    const { writeFile } = await import("node:fs/promises");
    const content = await readFile(skillMdPath, "utf8");
    const skillName = skillDir.split("/").filter(Boolean).pop() ?? "skill";
    const next = normalizeSkillFrontmatterPure(content, skillName);
    if (next !== content) {
      await writeFile(skillMdPath, next, "utf8");
    }
  };

  const runRsyncAdapter = async (
    rsyncArgs: readonly string[],
  ): Promise<RsyncResult> => {
    return await new Promise<RsyncResult>((resolve) => {
      const child = execFile(
        "rsync",
        rsyncArgs as string[],
        { maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const exitCode =
            err && typeof (err as NodeJS.ErrnoException).code === "number"
              ? ((err as NodeJS.ErrnoException).code as unknown as number)
              : err
                ? 1
                : 0;
          resolve({
            stdout: stdout?.toString() ?? "",
            stderr: stderr?.toString() ?? "",
            exitCode,
          });
        },
      );
      child.on("error", () => {
        /* callback above handles error path */
      });
    });
  };

  const deps: AdditiveApplierDeps = {
    agent: args.agent,
    gaps,
    apply: args.apply ?? false,
    clawcodeYamlPath,
    skillsTargetDir,
    memoryRoot,
    uploadsTargetDir,
    openClawHost,
    openClawWorkspace,
    openClawSkillsRoot,
    ledgerPath,
    updateAgentSkills: updateAgentSkillsAdapter,
    updateAgentConfig: updateAgentConfigAdapter,
    scanSkillForSecrets: scanSkillForSecretsAdapter,
    normalizeSkillFrontmatter: normalizeSkillFrontmatterAdapter,
    runRsync: runRsyncAdapter,
    log,
  };

  const outcome = await applyAdditiveFixes(deps);
  cliLog(JSON.stringify(outcome, null, 2));

  if (outcome.kind === "applied" || outcome.kind === "dry-run") return 0;
  return 1;
}

function mapYamlOutcome(
  outcome: string,
  reason: string | undefined,
): YamlWriteResult {
  if (outcome === "updated") return { kind: "updated", persisted: true };
  if (outcome === "no-op") return { kind: "no-op", persisted: true };
  if (outcome === "not-found")
    return { kind: "not-found", reason: reason ?? "agent or file not found" };
  if (outcome === "file-not-found")
    return { kind: "file-not-found", reason: reason ?? "yaml not found" };
  if (outcome === "refused")
    return { kind: "refused", reason: reason ?? "schema/secret-scan refusal" };
  return { kind: "refused", reason: `unknown outcome: ${outcome}` };
}

export function registerCutoverApplyAdditiveCommand(parent: Command): void {
  parent
    .command("apply-additive")
    .description(
      "Apply the 4 additive CutoverGap kinds (missing-memory-file, missing-upload, missing-skill, model-not-in-allowlist). Default: dry-run. Use --apply to write.",
    )
    .requiredOption("--agent <name>", "Agent")
    .option(
      "--apply",
      "Actually perform writes (without this flag, runs in dry-run mode)",
      false,
    )
    .option("--gaps-file <path>", "Override CUTOVER-GAPS.json path")
    .option(
      "--ledger-path <path>",
      "Override cutover-ledger.jsonl path",
      DEFAULT_CUTOVER_LEDGER_PATH,
    )
    .option("--clawcode-yaml <path>", "Override clawcode.yaml path")
    .action(
      async (opts: {
        agent: string;
        apply?: boolean;
        gapsFile?: string;
        ledgerPath?: string;
        clawcodeYaml?: string;
      }) => {
        const code = await runCutoverApplyAdditiveAction({
          agent: opts.agent,
          apply: opts.apply ?? false,
          ...(opts.gapsFile !== undefined ? { gapsPath: opts.gapsFile } : {}),
          ...(opts.ledgerPath !== undefined
            ? { ledgerPath: opts.ledgerPath }
            : {}),
          ...(opts.clawcodeYaml !== undefined
            ? { clawcodeYamlPath: opts.clawcodeYaml }
            : {}),
        });
        process.exit(code);
      },
    );
}
