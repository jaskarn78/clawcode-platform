/**
 * 999.156 — remember WHY an audio/video file was sent, so the finished
 * transcript can finish the job.
 *
 * The transcription pipeline names a job after the file it was handed, and
 * agents hand it the inbox copy the bridge downloaded (`<ts>-<name>.<ext>`),
 * so the job id IS the inbox stem. At download time the bridge writes a small
 * sidecar keyed by that stem — which Discord message carried the file and
 * what its author asked for. When the job completes, the watcher looks it up
 * and runs a turn that fulfils that request, replying to that message.
 *
 * Sidecars live beside (not inside) the inbox so the auto-ingest rescan never
 * sees them, and are swept after SIDECAR_TTL_DAYS.
 */

import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

export const SIDECAR_TTL_DAYS = 7;
/** Requests longer than this are stored truncated (a request, not a document). */
const MAX_REQUEST_CHARS = 4_000;

export type TranscriptRequest = {
  readonly v: 1;
  readonly agent: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly authorId: string;
  readonly authorName: string;
  /** The text the author sent WITH the file ("" when they sent only audio). */
  readonly request: string;
  readonly filename: string;
  readonly localPath: string;
  readonly at: string;
};

export function requestMetaDir(memoryPath: string): string {
  return join(memoryPath, "inbox", "attachment-meta");
}

/** Stem of a path/filename: basename without its last extension. */
export function stemOf(name: string): string {
  const base = basename(name);
  return base.slice(0, base.length - extname(base).length);
}

const TRANSCRIBABLE_EXT = new Set([
  ".m4a", ".mp3", ".wav", ".ogg", ".oga", ".opus", ".flac", ".aac", ".webm", ".mp4", ".mov", ".mkv", ".m4v",
]);

export function isTranscribable(contentType: string | null, filename: string): boolean {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.startsWith("audio/") || ct.startsWith("video/")) return true;
  return TRANSCRIBABLE_EXT.has(extname(filename).toLowerCase());
}

export async function writeTranscriptRequest(
  memoryPath: string,
  meta: Omit<TranscriptRequest, "v">,
): Promise<void> {
  const dir = requestMetaDir(memoryPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const body: TranscriptRequest = {
    v: 1,
    ...meta,
    request: meta.request.length > MAX_REQUEST_CHARS ? `${meta.request.slice(0, MAX_REQUEST_CHARS)}…` : meta.request,
  };
  await writeFile(join(dir, `${stemOf(meta.localPath)}.json`), JSON.stringify(body), { mode: 0o600 });
}

function parse(raw: string): TranscriptRequest | undefined {
  try {
    const v = JSON.parse(raw) as TranscriptRequest;
    return v && v.v === 1 && typeof v.messageId === "string" && typeof v.channelId === "string"
      ? v
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Find the request behind a transcription job. Exact stem first (the agent
 * submitted the inbox file); otherwise match the ORIGINAL name without the
 * `<ts>-` prefix (the agent converted/copied the file before submitting),
 * newest first.
 */
export async function findTranscriptRequest(
  memoryPath: string,
  job: string,
): Promise<TranscriptRequest | undefined> {
  const dir = requestMetaDir(memoryPath);
  const jobStem = stemOf(job);
  try {
    return parse(await readFile(join(dir, `${jobStem}.json`), "utf8"));
  } catch {
    /* fall through to fuzzy */
  }
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return undefined;
  }
  const wanted = jobStem.replace(/^\d+-/, "").toLowerCase();
  if (wanted.length === 0) return undefined;
  const candidates: Array<{ meta: TranscriptRequest; at: number }> = [];
  for (const e of entries) {
    if (!e.endsWith(".json")) continue;
    const s = e.slice(0, -5);
    const name = s.replace(/^\d+-/, "").toLowerCase();
    if (name !== wanted && !name.endsWith(`-${wanted}`) && !wanted.endsWith(`-${name}`)) continue;
    try {
      const meta = parse(await readFile(join(dir, e), "utf8"));
      if (meta) candidates.push({ meta, at: Date.parse(meta.at) || 0 });
    } catch {
      /* unreadable sidecar — skip */
    }
  }
  candidates.sort((a, b) => b.at - a.at);
  return candidates[0]?.meta;
}

export async function sweepTranscriptRequests(
  memoryPath: string,
  ttlDays: number = SIDECAR_TTL_DAYS,
  now: number = Date.now(),
): Promise<number> {
  const dir = requestMetaDir(memoryPath);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const e of entries) {
    const full = join(dir, e);
    try {
      const st = await stat(full);
      if (st.isFile() && now - st.mtimeMs > ttlDays * 86_400_000) {
        await unlink(full);
        removed++;
      }
    } catch {
      /* raced */
    }
  }
  return removed;
}
