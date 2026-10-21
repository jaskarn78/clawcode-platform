/**
 * 999.143 — read the state of every transcription tree on Unraid in ONE call.
 *
 * The naive version is an ssh per job per tick. This does a single `find` across
 * all roots and streams back one line per job, because the watcher ticks every
 * few seconds and an ssh handshake per job would cost more than the work.
 *
 * Read-only: this never writes to the trees. Submission stays with the
 * `transcribe` MCP, which is the sanctioned path and already has the guardrails.
 */
import { execFile } from "node:child_process";
import type { Observed } from "./reconcile.js";
import type { WorkerProgress } from "./progress.js";

export type TreeMap = ReadonlyMap<string, string>;   // tree name -> /mnt/... root

export type SshRunner = (args: readonly string[]) => Promise<string>;

const SSH_OPTS = [
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=8",
  "-o", "StrictHostKeyChecking=accept-new",
];

export function defaultSsh(target: string): SshRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile("ssh", [...SSH_OPTS, target, ...args], { timeout: 25_000, maxBuffer: 4 << 20 },
        (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
    });
}

/**
 * One shell command for every tree. Emits, per job directory:
 *   <tree>\t<job>\t<done|run>\t<progress json or ->
 * and per inbox file (not yet started):
 *   <tree>\t<stem>\tqueued\t-
 */
function script(trees: TreeMap): string {
  const parts: string[] = [];
  for (const [name, root] of trees) {
    // `root` comes from operator config, not from a request; still quoted.
    const r = `'${root.replace(/'/g, "'\\''")}'`;
    const t = `'${name.replace(/'/g, "'\\''")}'`;
    parts.push(
      // A job is: done (sentinel), failed (the worker left an .error beside the
      // output), or running. Checking only the failed/ directory missed the
      // .error case, so a job that died days ago looked perpetually in-flight
      // and got a progress card that would never complete.
      `for d in ${r}/output/*/; do [ -d "$d" ] || continue; b=$(basename "$d");` +
      ` if [ -f "$d/$b.done" ]; then s=done;` +
      ` elif ls "$d"/*.error >/dev/null 2>&1; then s=failed;` +
      ` else s=run; fi;` +
      ` p='-'; [ -f "$d/progress.json" ] && p=$(tr -d '\\n' < "$d/progress.json");` +
      ` printf '%s\\t%s\\t%s\\t%s\\n' ${t} "$b" "$s" "$p"; done;`,
      // Files still sitting in the inbox have not been picked up yet.
      `for f in ${r}/inbox/*; do [ -f "$f" ] || continue; b=$(basename "$f"); b=\${b%.*};` +
      ` printf '%s\\t%s\\tqueued\\t-\\n' ${t} "$b"; done;`,
      // A quarantined source means the job failed.
      `for f in ${r}/failed/*; do [ -f "$f" ] || continue; b=$(basename "$f"); b=\${b%.*};` +
      ` printf '%s\\t%s\\tfailed\\t-\\n' ${t} "$b"; done;`,
    );
  }
  return parts.join(" ");
}

/**
 * A "running" job whose progress stopped advancing hours ago is abandoned — the
 * worker was restarted mid-job, or the container was rebuilt. Reporting it as
 * live gives the owner a card that never finishes.
 */
const STALE_AFTER_SECONDS = 4 * 3600;

export function parseLines(out: string, now: number = Date.now()): Observed[] {
  const jobs: Observed[] = [];
  const queued: Observed[] = [];
  for (const line of out.split("\n")) {
    const [tree, job, status, payload] = line.split("\t");
    if (!tree || !job || !status) continue;
    let progress: WorkerProgress | undefined;
    if (payload && payload !== "-") {
      try {
        progress = JSON.parse(payload) as WorkerProgress;
      } catch {
        progress = undefined;         // a half-written file; next tick will have it
      }
    }
    if (status === "failed") {
      jobs.push({ tree, job, done: false, failed: "the pipeline could not transcribe this recording" });
    } else if (status === "done") {
      jobs.push({ tree, job, done: true, progress });
    } else if (status === "queued") {
      queued.push({ tree, job, done: false, progress });
    } else {
      const startedAt = progress?.phase_started_at;
      const stale = startedAt !== undefined && now / 1000 - startedAt > STALE_AFTER_SECONDS;
      if (stale) {
        jobs.push({ tree, job, done: false, failed: "the pipeline stopped working on this recording" });
      } else {
        jobs.push({ tree, job, done: false, progress });
      }
    }
  }
  // The GPU runs one job at a time across ALL trees, so the queue is global and
  // position is simply where you sit in it.
  queued.forEach((q, i) => jobs.push({ ...q, queuePosition: i + 1 }));
  return jobs;
}

export async function pollTrees(ssh: SshRunner, trees: TreeMap): Promise<Observed[]> {
  if (trees.size === 0) return [];
  return parseLines(await ssh([script(trees)]));
}

/** Parse `TRANSCRIBE_TREES` ("name=/path,name2=/path2") into a map. */
export function parseTreeMap(spec: string | undefined): TreeMap {
  const m = new Map<string, string>();
  for (const pair of (spec ?? "").split(",")) {
    const [name, path] = pair.split("=");
    if (name?.trim() && path?.trim()) m.set(name.trim(), path.trim());
  }
  return m;
}
