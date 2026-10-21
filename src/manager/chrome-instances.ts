/**
 * Chrome browser-INSTANCE identification.
 *
 * WHY THIS EXISTS (INC-2026-08-09). MemoryGuard paged
 * `⚠️ chrome count 17 over budget 12 (1598MB)`. It was noise: Chrome is
 * multi-process, so one browser spawns ~12 helpers (renderer, gpu, network,
 * storage, audio, zygote, crash handler…). 22 processes were **2 browsers** —
 * one actively working (the shopping agent's headed Chrome) and one dormant
 * pooled instance. The co-located `maxRssMb: 2560` rule correctly did NOT fire
 * (1598 MB), and every kernel pressure metric read exactly zero. The count
 * budget was the only thing that tripped.
 *
 * Worse, the budget was a coin-flip on agent activity: over 144 samples chrome
 * sat at 5 procs idle and 17-19 while shopping worked, and `maxCount: 12` sits
 * exactly between them. The rule fired if and only if the agent did its job.
 *
 * The fix is to count what an operator actually means by "how many browsers are
 * open" — browser-main processes — while leaving every helper in the class for
 * RSS accounting (dropping them would pull ~1.5 GB out of the rollup and blind
 * the maxRssMb rule that actually works).
 */

/** One /proc sample, as collected by memory-guard's census reader. */
export interface ChromeProcLike {
  readonly comm: string;
  readonly args: string;
}

/**
 * True when a chrome-class process is a BROWSER MAIN process rather than one of
 * its helpers.
 *
 * Two discriminators, both verified against live /proc on the fleet host:
 *
 *  1. Helpers always carry `--type=<role>` (zygote, gpu-process, utility,
 *     renderer…) as the first argument after argv[0]. Browser-main never does.
 *  2. Crash handlers are the trap. `chrome_crashpad_handler` carries NO
 *     `--type=`, so rule 1 alone counts it as a browser — turning 2 real
 *     browsers into 4. It must be excluded explicitly.
 *
 * NOTE on the crashpad test: /proc/<pid>/comm truncates at 15 characters, so
 * `chrome_crashpad_handler` arrives as `chrome_crashpad`. An equality check
 * against the full name would never match; `includes` is required.
 */
export function isBrowserInstance(proc: ChromeProcLike): boolean {
  const comm = proc.comm.toLowerCase();
  if (!comm.includes("chrome") && !comm.includes("chromium")) return false;
  if (comm.includes("crashpad")) return false;
  return !/(^|\s)--type=/.test(proc.args);
}

/** Count browser-main processes in a chrome-class process set. */
export function countBrowserInstances(procs: readonly ChromeProcLike[]): number {
  let n = 0;
  for (const p of procs) if (isBrowserInstance(p)) n += 1;
  return n;
}

/**
 * Best-effort owner label for a browser instance, parsed from
 * `--user-data-dir`. This is what turns "4 instances over budget 3" into an
 * actionable line naming which agent to talk to.
 *
 * Known shapes on this fleet:
 *   /home/clawcode/.clawcode/agents/<name>/browser-profile → "<name>"
 *   /tmp/playwright_chromiumdev_profile-*                  → "pooled"
 *   /tmp/agent-browser-chrome-*                            → "agent-browser"
 */
export function chromeOwner(proc: ChromeProcLike): string {
  const m = /--user-data-dir[= ]([^\s]+)/.exec(proc.args);
  if (!m) return "unknown";
  const dir = m[1] ?? "";
  const agent = /\/agents\/([^/]+)\//.exec(dir);
  if (agent?.[1]) return agent[1];
  if (dir.includes("playwright")) return "pooled";
  if (dir.includes("agent-browser-chrome-")) return "agent-browser";
  return "unknown";
}

/**
 * Owner histogram for browser instances only, most common first. Used to build
 * the `Who:` line of an alert so the operator never has to ask "whose Chrome?".
 */
export function chromeOwnerBreakdown(
  procs: readonly ChromeProcLike[],
): readonly { readonly owner: string; readonly instances: number }[] {
  const counts = new Map<string, number>();
  for (const p of procs) {
    if (!isBrowserInstance(p)) continue;
    const owner = chromeOwner(p);
    counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([owner, instances]) => ({ owner, instances }))
    .sort((a, b) => b.instances - a.instances || a.owner.localeCompare(b.owner));
}
