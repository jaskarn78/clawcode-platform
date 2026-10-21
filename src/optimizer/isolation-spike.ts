/**
 * Phase 142 — ISOLATION SPIKE (run LIVE; GATES P3/P4).
 *
 * THE load-bearing assumption of this whole phase: a forked session with
 * `workspace = candidate-dir` + `gsd: undefined` + `settingSources: ["project"]`
 * loads ONLY the skills in `<candidate-dir>/.claude/skills` — not the agent's
 * live `~/.claude` / project skills. Our half of that wiring is confirmed in
 * session-adapter.ts:1481-1529; the SDK's actual skill resolution is NOT, and a
 * mock cannot prove it. This probe proves or kills it with ONE real forked run.
 *
 * It is an exported function (NOT auto-run) — invoke it from a context that has
 * a live `SessionManager` (e.g. a one-off daemon IPC handler or boot script).
 * See ISOLATION-SPIKE.md for the run procedure + pass/fail criteria.
 *
 * Method: stage a candidate dir containing ONLY a sentinel skill (deliberately
 * NOT the agent's live skills), fork against it, and ask the agent to list its
 * skills + emit the sentinel's phrase. ISOLATED iff the sentinel is visible AND
 * no live skill name leaks into the answer.
 */
import { stageCandidateSkills } from "./candidate-skills.js";
import { makeForkedAgentRunner, type EvalSessionManager } from "./agent-runner.js";
import type { ResolvedAgentConfig } from "../shared/types.js";

export const SENTINEL_NAME = "optimizer-isolation-sentinel";
export const SENTINEL_PHRASE = "ISOLATION-SPIKE-OK-7Q2";

const SENTINEL_SKILL_MD = [
  "---",
  `name: ${SENTINEL_NAME}`,
  "description: Phase 142 isolation spike sentinel. Loaded only from the candidate skills dir.",
  "---",
  "",
  `When asked to confirm the isolation sentinel, reply with this exact phrase: ${SENTINEL_PHRASE}`,
  "",
].join("\n");

export type IsolationVerdict = "ISOLATED" | "LEAKED" | "INCONCLUSIVE";

export type IsolationSpikeResult = {
  readonly response: string;
  /** The candidate-dir sentinel skill was visible to the forked session. */
  readonly sentinelLoaded: boolean;
  /** Live skills that leaked into the forked session (should be empty). */
  readonly liveSkillsLeaked: string[];
  readonly verdict: IsolationVerdict;
};

/** Pure classifier — exported so the probe's analysis is unit-testable. */
export function classifyIsolation(
  response: string,
  liveSkillNames: readonly string[],
): IsolationSpikeResult {
  const sentinelLoaded =
    response.includes(SENTINEL_PHRASE) || response.includes(SENTINEL_NAME);
  const liveSkillsLeaked = liveSkillNames.filter((s) => s.length > 0 && response.includes(s));
  let verdict: IsolationVerdict;
  if (liveSkillsLeaked.length > 0) verdict = "LEAKED";
  else if (sentinelLoaded) verdict = "ISOLATED";
  else verdict = "INCONCLUSIVE";
  return { response, sentinelLoaded, liveSkillsLeaked, verdict };
}

/**
 * Run the live isolation spike. Requires a live SessionManager + an agent
 * config that HAS some live skills (so a leak is detectable).
 */
export async function runIsolationSpike(deps: {
  readonly sessionManager: EvalSessionManager;
  readonly parentConfig: ResolvedAgentConfig;
  readonly memoryPath: string;
  readonly log?: (obj: Record<string, unknown>, msg: string) => void;
}): Promise<IsolationSpikeResult> {
  const staged = await stageCandidateSkills({
    // Deliberately empty source + only the sentinel override: the candidate set
    // is ONLY the sentinel — NOT the agent's live skills.
    sourceSkillsRoot: "/nonexistent-optimizer-spike-source",
    skillNames: [],
    overrides: [{ op: "write", name: SENTINEL_NAME, skillMd: SENTINEL_SKILL_MD }],
  });
  try {
    const run = makeForkedAgentRunner({
      sessionManager: deps.sessionManager,
      parentConfig: deps.parentConfig,
      workspace: staged.workspace,
      skillNames: staged.skillNames,
      memoryPath: deps.memoryPath,
      log: deps.log,
    });
    const prompt = [
      "List the EXACT names of every skill currently available to you, one per line.",
      `Then, if a skill named "${SENTINEL_NAME}" is available to you, follow its`,
      "instruction and output its confirmation phrase.",
    ].join(" ");
    const { response } = await run(prompt);
    const result = classifyIsolation(response, deps.parentConfig.skills ?? []);
    deps.log?.(
      {
        verdict: result.verdict,
        sentinelLoaded: result.sentinelLoaded,
        liveSkillsLeaked: result.liveSkillsLeaked,
      },
      "optimizer: isolation spike result",
    );
    return result;
  } finally {
    await staged.dispose();
  }
}
