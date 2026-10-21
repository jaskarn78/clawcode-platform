/**
 * Every `run:` block in `.github/workflows/*.yml` must be valid bash.
 *
 * A stray quote in a run block (999.169 review: `}"` at the end of the lockstep
 * guard step) parses fine as YAML and only fails when GitHub executes it —
 * breaking every master push. `bash -n` catches it before merge. Steps with a
 * non-bash `shell:` (step, job `defaults.run.shell`, or workflow
 * `defaults.run.shell`) are skipped.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW_DIR = ".github/workflows";

type Step = { name?: string; run?: unknown; shell?: string };
type Job = { steps?: Step[]; defaults?: { run?: { shell?: string } } };
type Workflow = { jobs?: Record<string, Job>; defaults?: { run?: { shell?: string } } };

function isBash(shell: string | undefined): boolean {
  return shell === undefined || /^bash\b/.test(shell.trim());
}

function collectRunBlocks(file: string, text: string): Array<{ label: string; script: string }> {
  const wf = parse(text) as Workflow;
  const out: Array<{ label: string; script: string }> = [];
  for (const [jobName, job] of Object.entries(wf.jobs ?? {})) {
    const jobShell = job.defaults?.run?.shell ?? wf.defaults?.run?.shell;
    for (const [i, step] of (job.steps ?? []).entries()) {
      if (typeof step.run !== "string") continue;
      if (!isBash(step.shell ?? jobShell)) continue;
      out.push({ label: `${file} › ${jobName} › ${step.name ?? `step ${i}`}`, script: step.run });
    }
  }
  return out;
}

function bashSyntaxError(script: string): string | null {
  // GitHub expressions are substituted before bash sees the script; a
  // placeholder keeps them from reading as bash syntax.
  const neutral = script.replace(/\$\{\{[\s\S]*?\}\}/g, "GH_EXPR");
  const r = spawnSync("bash", ["-n"], { input: neutral, encoding: "utf8" });
  return r.status === 0 ? null : (r.stderr || `bash -n exit ${r.status}`).trim();
}

const files = readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f));
const blocks = files.flatMap((f) => collectRunBlocks(f, readFileSync(join(WORKFLOW_DIR, f), "utf8")));

describe("GitHub workflow run blocks are valid bash", () => {
  it("finds run blocks (the scan is not blind)", () => {
    expect(blocks.length).toBeGreaterThan(2);
    expect(blocks.some((b) => b.label.includes("go-build.yml"))).toBe(true);
  });

  it.each(blocks.map((b) => [b.label, b.script] as const))("%s", (_label, script) => {
    expect(bashSyntaxError(script)).toBeNull();
  });

  it("the checker itself rejects the 999.169 stray-quote shape", () => {
    expect(bashSyntaxError('grep -q x f || {\n  exit 1\n}"')).not.toBeNull();
  });

  it("skips non-bash shells", () => {
    const yml = "jobs:\n  a:\n    steps:\n      - run: 'Write-Host \"(\"'\n        shell: pwsh\n      - run: echo ok\n";
    expect(collectRunBlocks("x.yml", yml).map((b) => b.script)).toEqual(["echo ok"]);
  });
});
