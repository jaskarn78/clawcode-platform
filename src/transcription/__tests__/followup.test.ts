/**
 * 999.156 — a finished transcript FINISHES THE ORIGINAL REQUEST as a channel
 * turn, and the transcript is ingested; with no recorded request it falls back
 * to a typed self-fired summary.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtemp, readdir, utimes, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverTranscript, buildFollowUpPrompt } from "../deliver.js";
import {
  findTranscriptRequest,
  isTranscribable,
  requestMetaDir,
  sweepTranscriptRequests,
  writeTranscriptRequest,
  type TranscriptRequest,
} from "../request-meta.js";

const REQUEST: TranscriptRequest = {
  v: 1,
  agent: "state-contract",
  channelId: "chan-sc",
  messageId: "msg-audio",
  authorId: "u-client-a",
  authorName: "clientAhin",
  request: "Pull out every deadline Suma mentioned and draft the follow-up email to Qasem.",
  filename: "Daily_92226.m4a",
  localPath: "/mem/inbox/attachments/1790095686604-Daily_92226.m4a",
  at: "2026-09-22T16:48:06.000Z",
};

async function setup(over: Record<string, unknown> = {}) {
  const posted: { text: string; reason: string }[] = [];
  const dispatched: string[] = [];
  const channelTurns: Array<{ request: TranscriptRequest; prompt: string }> = [];
  const ingested: string[] = [];
  const typed: string[] = [];
  const workspaceDir = await mkdtemp(join(tmpdir(), "followup-"));
  const a = {
    agent: "state-contract",
    tree: "state-contract",
    job: "1790095686604-Daily_92226",
    root: "/mnt/user/appdata/state-contract",
    sshTarget: "root@unraid.invalid",
    manager: {
      dispatchTurn: async (_agent: string, content: string) => {
        dispatched.push(content);
        return "summary";
      },
    },
    bridge: { postCv2ToAgentChannel: async () => ({}) },
    postText: async (_agent: string, text: string, reason: string) => {
      posted.push({ text, reason });
    },
    readRemote: async () => "SPEAKER_00: Suma: the packet is due Friday.",
    log: { info: vi.fn(), warn: vi.fn() },
    workspaceDir,
    findRequest: async () => REQUEST,
    runChannelTurn: async (_agent: string, request: TranscriptRequest, prompt: string) => {
      channelTurns.push({ request, prompt });
      return true;
    },
    ingest: (_agent: string, path: string) => {
      ingested.push(path);
    },
    withTyping: async <T,>(agent: string, fn: () => Promise<T>) => {
      typed.push(agent);
      return fn();
    },
    ...over,
  };
  return { a: a as never, posted, dispatched, channelTurns, ingested, typed };
}

describe("deliverTranscript — 999.156 follow-up", () => {
  it("runs a channel turn replying to the audio message, with the original request verbatim", async () => {
    const t = await setup();
    await deliverTranscript(t.a);
    expect(t.channelTurns).toHaveLength(1);
    expect(t.channelTurns[0]!.request.messageId).toBe("msg-audio");
    expect(t.channelTurns[0]!.prompt).toContain(REQUEST.request);
    expect(t.channelTurns[0]!.prompt).toContain("Fulfil THAT request");
    // The bridge delivered it — nothing self-fired, nothing double-posted.
    expect(t.dispatched).toHaveLength(0);
    expect(t.posted).toHaveLength(0);
  });

  it("ingests the saved transcript into the document store", async () => {
    const t = await setup();
    await deliverTranscript(t.a);
    expect(t.ingested).toHaveLength(1);
    expect(t.ingested[0]).toMatch(/1790095686604-Daily_92226-transcript_speakers\.txt$/);
  });

  it("falls back to a TYPED self-fired turn when the channel turn cannot run", async () => {
    const t = await setup({ runChannelTurn: async () => false });
    await deliverTranscript(t.a);
    expect(t.typed).toEqual(["state-contract"]);
    expect(t.dispatched).toHaveLength(1);
    expect(t.dispatched[0]).toContain(REQUEST.request); // request still honoured
    expect(t.posted.map((p) => p.reason)).toEqual(["transcript-summary"]);
  });

  it("with no recorded request, asks for a summary", async () => {
    const t = await setup({ findRequest: async () => undefined });
    await deliverTranscript(t.a);
    expect(t.channelTurns).toHaveLength(0);
    expect(t.dispatched[0]).toContain("without instructions");
    expect(t.typed).toEqual(["state-contract"]);
  });

  it("an unusable transcript is reported through the channel turn too", async () => {
    const t = await setup({ readRemote: async () => "   " });
    await deliverTranscript(t.a);
    expect(t.channelTurns).toHaveLength(1);
    expect(t.channelTurns[0]!.prompt).toContain("EMPTY");
    expect(t.ingested).toHaveLength(0);
  });

  it("a throwing channel turn falls back instead of escaping into the watcher", async () => {
    const t = await setup({
      runChannelTurn: async () => {
        throw new Error("discord 500");
      },
    });
    await expect(deliverTranscript(t.a)).resolves.toBeUndefined();
    expect(t.dispatched).toHaveLength(1);
  });

  it("buildFollowUpPrompt treats an audio-only message as a summary request", () => {
    const p = buildFollowUpPrompt({
      agent: "a",
      job: "j",
      localPath: "/x",
      excerpt: "e",
      truncated: false,
      request: { ...REQUEST, request: "  " },
    });
    expect(p).toContain("without instructions");
    expect(p).not.toContain("<original-request>");
  });
});

describe("request-meta sidecars", () => {
  it("round-trips by exact job stem, and matches a converted copy by original name", async () => {
    const mem = await mkdtemp(join(tmpdir(), "reqmeta-"));
    await writeTranscriptRequest(mem, { ...REQUEST, localPath: `${mem}/inbox/attachments/1790095686604-Daily_92226.m4a` });
    expect((await findTranscriptRequest(mem, "1790095686604-Daily_92226"))?.messageId).toBe("msg-audio");
    expect((await findTranscriptRequest(mem, "1790095686604-Daily_92226.m4a"))?.messageId).toBe("msg-audio");
    // Agent ffmpeg'd it to Daily_92226.wav before submitting.
    expect((await findTranscriptRequest(mem, "Daily_92226"))?.messageId).toBe("msg-audio");
    expect(await findTranscriptRequest(mem, "Other_Meeting")).toBeUndefined();
  });

  it("sidecars live outside the inbox (the ingest rescan never sees them) and expire", async () => {
    const mem = await mkdtemp(join(tmpdir(), "reqmeta-"));
    await mkdir(join(mem, "inbox", "attachments"), { recursive: true });
    await writeTranscriptRequest(mem, { ...REQUEST, localPath: `${mem}/inbox/attachments/x.m4a` });
    expect(await readdir(join(mem, "inbox", "attachments"))).toEqual([]);
    const f = join(requestMetaDir(mem), "x.json");
    const old = (Date.now() - 8 * 86_400_000) / 1000;
    await utimes(f, old, old);
    await writeFile(join(requestMetaDir(mem), "fresh.json"), "{}");
    expect(await sweepTranscriptRequests(mem)).toBe(1);
  });

  it("isTranscribable covers audio/video mimes and extensions", () => {
    expect(isTranscribable("audio/x-m4a", "a.m4a")).toBe(true);
    expect(isTranscribable(null, "Voice Memo.m4a")).toBe(true);
    expect(isTranscribable("video/quicktime", "clip.mov")).toBe(true);
    expect(isTranscribable("image/png", "a.png")).toBe(false);
  });
});
