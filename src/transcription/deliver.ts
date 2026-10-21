/**
 * 999.143 — deliver a finished transcript into the agent's channel and ask the
 * agent to summarise it.
 *
 * Two things have to happen, in this order, and the order matters: the owner
 * gets the transcript itself (the evidence), and then the agent reads it and
 * says what it MEANS (the point). Posting only a summary loses the record;
 * posting only the file makes the owner do the work.
 *
 * The summary runs as a normal agent turn, so it goes through the agent's own
 * voice, memory and skills rather than being generated here.
 *
 * 🚨 999.149 — `dispatchTurn` RETURNS the agent's reply; it does not post it.
 * Discord-originated turns are delivered by DiscordBridge, which opens them;
 * a self-fired turn like this one has no bridge behind it, so for two business
 * days the transcript landed and the summary was computed, returned, and
 * dropped on the floor. The owner saw a wall of raw transcript and nothing
 * else. We now post the reply ourselves through `deliverAgentText` (formatted,
 * chunked — a standup summary is routinely past Discord's 2000-char ceiling,
 * which is exactly why the long ones vanished).
 *
 * The prompt tells the agent to REPLY with the summary rather than posting it
 * with a tool. Both would double-post, and on 2026-09-17 the agent did choose
 * a tool on the error path — so the instruction is explicit, not implied.
 *
 * 999.156 — the follow-up now FINISHES THE ORIGINAL REQUEST. The bridge
 * records, at download time, which message carried the audio and what its
 * author asked for (request-meta.ts). On completion:
 *   - the transcript is ingested into the agent's document store;
 *   - the follow-up runs as a CHANNEL turn replying to that message (typing
 *     indicator, live streaming, normal delivery) and its prompt carries the
 *     original request verbatim — "summarise" is only the fallback;
 *   - with no recorded request (or the message is gone) it falls back to the
 *     self-fired dispatch + postText path, now with typing shown.
 * The self-fired path was also how state-contract's queue jammed on
 * 2026-09-22 (its summary send was folded into a notification turn); a
 * channel turn owns its queue slot and delivery like any Discord message.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TranscriptRequest } from "./request-meta.js";

const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new"];
/** Discord rejects a message over 2000 chars; a transcript is always a file. */
const SUMMARY_PROMPT_TRANSCRIPT_CHARS = 12_000;

type LogLike = { info(o: unknown, m?: string): void; warn(o: unknown, m?: string): void };

export type DeliverArgs = {
  readonly agent: string;
  readonly tree: string;
  readonly job: string;
  readonly root: string;
  readonly sshTarget: string;
  readonly manager: { dispatchTurn(agent: string, content: string): Promise<string> };
  readonly bridge: {
    shareFileToAgentChannel?(agent: string, path: string, caption?: string): Promise<unknown>;
    postCv2ToAgentChannel(agent: string, spec: unknown): Promise<unknown>;
  };
  /**
   * 999.149 — post the agent's reply into its own channel. Without this the
   * summary is computed and discarded. Optional so the watcher degrades to the
   * old (silent) behaviour rather than crashing if a caller forgets it, but the
   * daemon always supplies it and the absence is warn-logged.
   */
  readonly postText?: (agent: string, text: string, reason: string) => Promise<unknown>;
  readonly log: LogLike;
  /** Injected in tests. */
  readonly readRemote?: (sshTarget: string, path: string) => Promise<string>;
  readonly workspaceDir?: string;
  /** 999.156 — the request that came with the audio (bridge-recorded sidecar). */
  readonly findRequest?: (agent: string, job: string) => Promise<TranscriptRequest | undefined>;
  /**
   * 999.156 — run the follow-up as a channel turn replying to the original
   * message (typing, streaming, bridge delivery). Resolves false when it
   * could not (message deleted, bridge down) so the caller falls back.
   */
  readonly runChannelTurn?: (
    agent: string,
    request: TranscriptRequest,
    prompt: string,
  ) => Promise<boolean>;
  /** 999.156 — enqueue the saved transcript for document-store ingestion. */
  readonly ingest?: (agent: string, path: string, request: TranscriptRequest | undefined) => void;
  /** 999.156 — show typing in the agent's channel while `fn` runs (fallback path). */
  readonly withTyping?: <T>(agent: string, fn: () => Promise<T>) => Promise<T>;
};

/** 999.156 — the follow-up prompt. Exported for tests. */
export function buildFollowUpPrompt(args: {
  readonly agent: string;
  readonly job: string;
  readonly localPath: string;
  readonly excerpt: string;
  readonly truncated: boolean;
  readonly request: TranscriptRequest | undefined;
}): string {
  const asked = args.request?.request.trim() ?? "";
  const who = args.request?.authorName ?? "the owner";
  const task =
    asked.length > 0
      ? [
          `${who} sent this recording with a request. Their exact words:`,
          `<original-request>`,
          asked,
          `</original-request>`,
          ``,
          `Fulfil THAT request using the transcript — it is the whole point of this turn. If the request is only "transcribe this", reply with a summary instead: who spoke, what was decided, what is owed and by whom, and anything that needs an answer.`,
        ]
      : [
          `${who} sent this recording without instructions. Reply with a summary: who spoke, what was decided, what is owed and by whom, and anything that needs an answer. Lead with what matters, not a retelling.`,
        ];
  return [
    `The Unraid transcription pipeline finished "${args.job}".`,
    `The full transcript is saved at ${args.localPath}${args.truncated ? " (the excerpt below is the first part only — read the file for the rest)" : ""} and is being added to your documents, so search_documents will find it later.`,
    ``,
    ...task,
    ``,
    `First share the transcript file with mcp__clawcode__clawcode_share_file (agent='${args.agent}', path='${args.localPath}'). Then write your answer AS YOUR REPLY — it is posted to the channel for you, so do NOT use any tool to post the summary or answer yourself; sharing the file is the only post you make. Do not re-transcribe anything.`,
    ``,
    "Transcript follows.",
    "```",
    args.excerpt,
    "```",
  ].join("\n");
}

function readViaSsh(sshTarget: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // The path is built from operator-configured roots and a job id the worker
    // itself produced (a file stem), never from a chat message.
    execFile("ssh", [...SSH_OPTS, sshTarget, `cat '${path.replace(/'/g, "'\\''")}'`],
      { timeout: 60_000, maxBuffer: 32 << 20 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

/**
 * Prefer the diarized transcript; fall back to the plain one.
 *
 * `missing` vs `empty` is a real distinction, not pedantry: on 2026-09-17 an
 * 8-second voice message produced `transcript.txt` and
 * `transcript_timestamped.txt` at **0 bytes** with a `.done` sentinel beside
 * them, and the owner was told the file "could not be read back" — which
 * pointed the investigation at ssh and permissions when the worker had simply
 * transcribed silence. The failure the owner is told about should be the
 * failure that happened.
 */
export type TranscriptLookup =
  | { readonly kind: "found"; readonly text: string; readonly name: string }
  | { readonly kind: "empty"; readonly name: string }
  | { readonly kind: "missing" };

export async function fetchTranscript(args: DeliverArgs): Promise<TranscriptLookup> {
  const read = args.readRemote ?? readViaSsh;
  const dir = `${args.root}/output/${args.job}`;
  let sawEmpty: string | undefined;
  for (const candidate of ["transcript_speakers.txt", "transcript.txt", "transcript_timestamped.txt"]) {
    try {
      const text = await read(args.sshTarget, `${dir}/${candidate}`);
      if (text.trim()) return { kind: "found", text, name: `${args.job}-${candidate}` };
      // The file exists and is blank — remember it, but keep looking: the
      // worker may have written a later shape with real content.
      sawEmpty ??= candidate;
    } catch {
      /* try the next shape */
    }
  }
  return sawEmpty ? { kind: "empty", name: sawEmpty } : { kind: "missing" };
}

export async function deliverTranscript(args: DeliverArgs): Promise<void> {
  const post = async (text: string, reason: string): Promise<void> => {
    if (!args.postText) {
      args.log.warn({ agent: args.agent, job: args.job, reason }, "no text sink wired — agent reply NOT delivered");
      return;
    }
    await args.postText(args.agent, text, reason).catch((err: unknown) =>
      args.log.warn(
        { agent: args.agent, job: args.job, reason, err: err instanceof Error ? err.message : String(err) },
        "agent reply delivery failed",
      ),
    );
  };

  const found = await fetchTranscript(args);

  if (found.kind !== "found") {
    // Say which failure it was. "Could not be read back" sent the 2026-09-17
    // investigation after ssh when the worker had transcribed 8 seconds of
    // silence into a 0-byte file.
    const what =
      found.kind === "empty"
        ? `finished, but the transcript it produced (${found.name}) is EMPTY — the audio was most likely silent or too short to transcribe`
        : `finished, but no transcript file could be read back from the pipeline`;
    args.log.warn({ agent: args.agent, job: args.job, lookup: found.kind }, "transcript unusable");
    const unusablePrompt =
      `The transcription of "${args.job}" ${what}. ` +
      `Tell the owner plainly, in one line, what happened and that Operator has been flagged. ` +
      `Reply with that line as your message text — do NOT use a tool to post it, it is delivered for you. ` +
      `Do NOT transcribe it locally.`;
    const request = await lookupRequest(args);
    if (request && args.runChannelTurn && (await args.runChannelTurn(args.agent, request, unusablePrompt).catch(() => false))) {
      return;
    }
    const typing = args.withTyping ?? (<T,>(_a: string, fn: () => Promise<T>) => fn());
    const reply = await typing(args.agent, () => args.manager.dispatchTurn(args.agent, unusablePrompt)).catch(() => "");
    await post(reply, "transcript-unusable");
    return;
  }

  // Keep the transcript in the agent's own workspace so it can cite and re-read
  // it later, rather than existing only as a Discord attachment.
  const dir = args.workspaceDir ?? `/home/clawcode/.clawcode/agents/${args.agent}/transcripts`;
  const localPath = join(dir, `${found.name}`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(localPath, found.text, "utf8");
  } catch (err) {
    args.log.warn(
      { agent: args.agent, job: args.job, err: err instanceof Error ? err.message : String(err) },
      "could not save transcript into the agent workspace",
    );
  }

  const excerpt = found.text.slice(0, SUMMARY_PROMPT_TRANSCRIPT_CHARS);
  const truncated = found.text.length > excerpt.length;
  const request = await lookupRequest(args);

  // 999.156 — the transcript joins the agent's documents (retrievable later).
  if (args.ingest) {
    try {
      args.ingest(args.agent, localPath, request);
    } catch (err) {
      args.log.warn(
        { agent: args.agent, job: args.job, err: err instanceof Error ? err.message : String(err) },
        "transcript ingest enqueue failed (non-fatal)",
      );
    }
  }

  const prompt = buildFollowUpPrompt({ agent: args.agent, job: args.job, localPath, excerpt, truncated, request });

  if (request && args.runChannelTurn) {
    const handled = await args.runChannelTurn(args.agent, request, prompt).catch((err: unknown) => {
      args.log.warn(
        { agent: args.agent, job: args.job, err: err instanceof Error ? err.message : String(err) },
        "channel follow-up turn failed — falling back to self-fired dispatch",
      );
      return false;
    });
    if (handled) {
      args.log.info(
        { agent: args.agent, job: args.job, messageId: request.messageId, hadRequest: request.request.trim().length > 0 },
        "transcript follow-up ran as a channel turn",
      );
      return;
    }
  } else if (!request) {
    args.log.info({ agent: args.agent, job: args.job }, "no recorded request for this transcript — summary fallback");
  }

  const typing = args.withTyping ?? (<T,>(_a: string, fn: () => Promise<T>) => fn());
  const reply = await typing(args.agent, () => args.manager.dispatchTurn(args.agent, prompt));
  await post(reply, "transcript-summary");
}

async function lookupRequest(args: DeliverArgs): Promise<TranscriptRequest | undefined> {
  if (!args.findRequest) return undefined;
  try {
    return await args.findRequest(args.agent, args.job);
  } catch (err) {
    args.log.warn(
      { agent: args.agent, job: args.job, err: err instanceof Error ? err.message : String(err) },
      "transcript request lookup failed",
    );
    return undefined;
  }
}
