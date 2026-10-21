import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { parseLines, parseTreeMap, pollTrees } from "../unraid.js";

// Timestamps must be recent: a job whose progress stopped advancing hours ago
// is treated as abandoned, so a 1970 fixture would read as stale.
const nowSec = () => Math.floor(Date.now() / 1000);
const P = (phase: string) =>
  JSON.stringify({ job: "a", phase, audio_seconds: 600, job_started_at: nowSec() - 30, phase_started_at: nowSec() - 10 });

describe("parseTreeMap", () => {
  it("parses the TRANSCRIBE_TREES format", () => {
    const m = parseTreeMap("acme=/mnt/a,client-a-personal=/mnt/b");
    expect(m.get("client-a-personal")).toBe("/mnt/b");
    expect(m.size).toBe(2);
  });
  it("tolerates empty and malformed entries", () => {
    expect(parseTreeMap("").size).toBe(0);
    expect(parseTreeMap(undefined).size).toBe(0);
    expect(parseTreeMap("broken,a=/x").size).toBe(1);
  });
});

describe("parseLines", () => {
  it("reads a running job with its progress", () => {
    const [j] = parseLines(`client-a-personal\tstandup\trun\t${P("transcribing")}`);
    expect(j).toMatchObject({ tree: "client-a-personal", job: "standup", done: false });
    expect(j!.progress?.phase).toBe("transcribing");
  });

  it("reads a finished job", () => {
    const [j] = parseLines(`t\ta\tdone\t${P("done")}`);
    expect(j!.done).toBe(true);
  });

  it("marks a quarantined source as failed", () => {
    const [j] = parseLines("t\ta\tfailed\t-");
    expect(j!.failed).toBeTruthy();
  });

  it("numbers the queue globally — one GPU, one job at a time", () => {
    const jobs = parseLines(["t1\tx\tqueued\t-", "t2\ty\tqueued\t-"].join("\n"));
    expect(jobs.map((j) => j.queuePosition)).toEqual([1, 2]);
  });

  it("survives a half-written progress.json instead of throwing", () => {
    const [j] = parseLines('t\ta\trun\t{"job":"a","pha');
    expect(j!.progress).toBeUndefined();
    expect(j!.done).toBe(false);
  });

  it("ignores blank and malformed lines", () => {
    expect(parseLines("\n\ngarbage\n").length).toBe(0);
  });

  it("keeps same-named jobs in different trees distinct", () => {
    const jobs = parseLines(["a\tcall\trun\t-", "b\tcall\trun\t-"].join("\n"));
    expect(jobs.map((j) => j.tree)).toEqual(["a", "b"]);
  });
});

describe("pollTrees", () => {
  it("makes exactly ONE ssh call for all trees", async () => {
    let calls = 0;
    const ssh = async () => { calls += 1; return "t\ta\trun\t-"; };
    await pollTrees(ssh, parseTreeMap("a=/x,b=/y,c=/z"));
    expect(calls).toBe(1);
  });

  it("does not ssh at all when no trees are configured", async () => {
    let calls = 0;
    const ssh = async () => { calls += 1; return ""; };
    expect(await pollTrees(ssh, new Map())).toEqual([]);
    expect(calls).toBe(0);
  });

  it("quotes tree roots so a hostile path stays DATA, proven by a real shell", async () => {
    // Asserting on the command text is misleading: the dangerous characters do
    // appear in it, harmlessly, inside single quotes. The property that actually
    // matters is what a shell DOES with it — so ask one.
    const hostile = "/mnt/a'; rm -rf /; echo '";
    let cmd = "";
    const ssh = async (args: readonly string[]) => { cmd = args[0]!; return ""; };
    await pollTrees(ssh, parseTreeMap(`evil=${hostile}`));

    // Pull the first quoted root back out of the generated script and let `sh`
    // expand it. If the quoting is sound it round-trips to the literal path and
    // executes nothing.
    const quoted = cmd.slice(cmd.indexOf("for d in ") + 9, cmd.indexOf("/output/*/"));
    const out = await new Promise<string>((resolve, reject) => {
      execFile("sh", ["-c", `printf '%s' ${quoted}`], { timeout: 5000 },
        (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
    });
    expect(out).toBe(hostile);   // data, not commands
  });
});

describe("abandoned and failed jobs (regression 2026-09-16)", () => {
  // A job that died 5 days ago had no .done sentinel and an .error file beside
  // its output. The poller only looked at the failed/ DIRECTORY, so it read as
  // "running" and got a progress card that could never complete.
  const OLD = 1_700_000_000;                 // long past
  const NOW = (OLD + 5 * 86_400) * 1000;

  it("treats a .error beside the output as failed, not running", () => {
    const [j] = parseLines("t\tdead\tfailed\t-", NOW);
    expect(j!.failed).toBeTruthy();
    expect(j!.done).toBe(false);
  });

  it("treats a job whose progress stopped hours ago as abandoned", () => {
    const stale = JSON.stringify({ job: "x", phase: "transcribing", phase_started_at: OLD });
    const [j] = parseLines(`t\tx\trun\t${stale}`, NOW);
    expect(j!.failed).toBeTruthy();
  });

  it("leaves a genuinely recent job alone", () => {
    const fresh = JSON.stringify({ job: "x", phase: "transcribing", phase_started_at: NOW / 1000 - 30 });
    const [j] = parseLines(`t\tx\trun\t${fresh}`, NOW);
    expect(j!.failed).toBeUndefined();
    expect(j!.progress?.phase).toBe("transcribing");
  });

  it("does not call a job stale when it has no timestamp to judge by", () => {
    const [j] = parseLines("t\tx\trun\t-", NOW);
    expect(j!.failed).toBeUndefined();
  });
});
