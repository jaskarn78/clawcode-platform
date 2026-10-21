import { describe, it, expect, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverTranscript, fetchTranscript } from "../deliver.js";

const log = () => ({ info: vi.fn(), warn: vi.fn() });

/** Remote tree contents keyed by filename; a missing key throws like `cat` would. */
function remote(files: Record<string, string>) {
  return async (_t: string, path: string) => {
    const name = path.split("/").pop()!;
    if (!(name in files)) throw new Error(`cat: ${path}: No such file or directory`);
    return files[name]!;
  };
}

async function args(over: Record<string, unknown> = {}) {
  const posted: { text: string; reason: string }[] = [];
  const dispatched: string[] = [];
  const workspaceDir = await mkdtemp(join(tmpdir(), "deliver-test-"));
  return {
    posted,
    dispatched,
    a: {
      agent: "state-contract",
      tree: "state-contract",
      job: "Daily_91726",
      root: "/mnt/user/appdata/state-contract",
      sshTarget: "root@unraid.invalid",
      manager: {
        dispatchTurn: async (_agent: string, content: string) => {
          dispatched.push(content);
          return "Standup summary: Qasem's timeline says 9/24; Dio's office is waiting on the packet.";
        },
      },
      bridge: { postCv2ToAgentChannel: async () => ({}) },
      postText: async (_agent: string, text: string, reason: string) => {
        posted.push({ text, reason });
      },
      log: log(),
      workspaceDir,
      ...over,
    } as never,
  };
}

describe("fetchTranscript", () => {
  it("prefers the diarized transcript", async () => {
    const { a } = await args({
      readRemote: remote({ "transcript_speakers.txt": "SPEAKER_00: hi", "transcript.txt": "hi" }),
    });
    const r = await fetchTranscript(a);
    expect(r.kind).toBe("found");
    if (r.kind === "found") expect(r.text).toContain("SPEAKER_00");
  });

  it("falls through to a later shape when an earlier one is blank", async () => {
    const { a } = await args({
      readRemote: remote({ "transcript_speakers.txt": "   ", "transcript.txt": "real words" }),
    });
    const r = await fetchTranscript(a);
    expect(r.kind).toBe("found");
    if (r.kind === "found") expect(r.text).toBe("real words");
  });

  /**
   * 2026-09-17: an 8-second voice message produced transcript.txt AND
   * transcript_timestamped.txt at 0 bytes beside a .done sentinel. The owner
   * was told the file "could not be read back", which sent the investigation
   * after ssh and permissions when the worker had transcribed silence.
   */
  it("calls a 0-byte transcript EMPTY, not missing", async () => {
    const { a } = await args({
      readRemote: remote({ "transcript.txt": "", "transcript_timestamped.txt": "" }),
    });
    const r = await fetchTranscript(a);
    expect(r.kind).toBe("empty");
  });

  it("calls a genuinely absent file missing", async () => {
    const { a } = await args({ readRemote: remote({}) });
    expect((await fetchTranscript(a)).kind).toBe("missing");
  });
});

describe("deliverTranscript", () => {
  it("POSTS the agent's summary — the 2026-09-17 regression", async () => {
    const { a, posted } = await args({
      readRemote: remote({ "transcript.txt": "a real standup transcript" }),
    });
    await deliverTranscript(a);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.text).toContain("Standup summary");
    expect(posted[0]!.reason).toBe("transcript-summary");
  });

  it("tells the agent its reply is posted for it, so it does not double-post", async () => {
    const { a, dispatched } = await args({
      readRemote: remote({ "transcript.txt": "a real standup transcript" }),
    });
    await deliverTranscript(a);
    expect(dispatched[0]).toMatch(/do NOT use any tool to post the summary/i);
    expect(dispatched[0]).toContain("clawcode_share_file");
  });

  it("distinguishes an empty transcript from a missing one in what the owner is told", async () => {
    const empty = await args({ readRemote: remote({ "transcript.txt": "" }) });
    await deliverTranscript(empty.a);
    expect(empty.dispatched[0]).toMatch(/EMPTY/);
    expect(empty.dispatched[0]).toMatch(/silent or too short/);

    const missing = await args({ readRemote: remote({}) });
    await deliverTranscript(missing.a);
    expect(missing.dispatched[0]).toMatch(/no transcript file could be read back/);
  });

  it("still delivers the agent's line on the failure path — the owner must see it", async () => {
    const { a, posted } = await args({ readRemote: remote({}) });
    await deliverTranscript(a);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.reason).toBe("transcript-unusable");
  });

  it("warns instead of crashing when no text sink is wired", async () => {
    const l = log();
    const { a } = await args({
      readRemote: remote({ "transcript.txt": "words" }),
      postText: undefined,
      log: l,
    });
    await expect(deliverTranscript(a)).resolves.toBeUndefined();
    expect(l.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("NOT delivered"));
  });

  it("does not let a delivery failure escape into the watcher", async () => {
    const { a } = await args({
      readRemote: remote({ "transcript.txt": "words" }),
      postText: async () => {
        throw new Error("discord 500");
      },
    });
    await expect(deliverTranscript(a)).resolves.toBeUndefined();
  });
});
