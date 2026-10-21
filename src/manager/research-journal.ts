/**
 * Phase 999.173 polish — research findings journal (daemon-side; researchers
 * have no Write tool).
 *
 * Prod 2026-09-25: three researchers made 351 tool calls in ~6 minutes, hit
 * the account limit and left ZERO saved findings — their work survived only
 * inside transcripts. The tracker now writes, per research session, under the
 * agent's own workspace (owner-isolated):
 *
 *   research/<YYYY-MM-DD>-<originMessageId>/
 *     session.md                 human index (origin, researchers, outcome)
 *     session.json               machine state (boot recovery, resume)
 *     <taskId>-<slug>.md         per researcher: "Findings so far" (the
 *                                researcher's `FINDING: <claim> — <source>`
 *                                lines) on top, then a compact log of its
 *                                notes, tool calls (name + key input + a
 *                                trimmed result or source URL — never full
 *                                payloads) and progress summaries, then how
 *                                it ended.
 *
 * Every event marks the files dirty; a per-file writer rewrites them
 * atomically (tmp + rename), coalescing bursts, so a daemon crash loses at
 * most the last event. Each researcher file is capped (~200 KB) keeping the
 * head and the tail of its log. Text is redacted of secret-shaped strings.
 * Nothing is written when research is off (no tracker → no journal).
 */

import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const RESEARCHER_FILE_CAP_BYTES = 200 * 1024;
const MAX_LOG_ENTRIES = 3000;
const MAX_FINDINGS = 200;
const TEXT_NOTE_MAX = 600;
const KEY_INPUT_MAX = 160;
const RESULT_MAX = 220;
/** Unfinished journals younger than this are offered for resume / recovered at boot. */
export const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;

export type JournalState = "running" | "done" | "timeout" | "interrupted";

export type JournalResearcher = {
  taskId: string;
  description: string;
  file: string;
  status: string;
  reason: string | null;
  startedAt: number;
  endedAt: number | null;
};

export type JournalSessionState = {
  version: 1;
  originMessageId: string;
  originTurnId: string;
  channelId: string | null;
  cardMessageId: string | null;
  startedAt: number;
  updatedAt: number;
  state: JournalState;
  researchers: JournalResearcher[];
};

type ResearcherBody = {
  findings: string[];
  log: string[];
  omitted: number;
  pendingTools: Map<string, { name: string; key: string; at: number }>;
  ended: string | null;
};

const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/\b(sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|ops_[A-Za-z0-9_-]{16,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g, "[redacted]"],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}/g, "[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [redacted]"],
  [/\b(authorization|x-api-key|cookie)(["']?\s*:\s*)[^\n"']{4,}/gi, "$1$2[redacted]"],
  // env-dump lines: FINNHUB_API_KEY=…, OP_SERVICE_ACCOUNT_TOKEN=…, DB_PASSWORD=…
  [/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|_PAT|CREDENTIALS?|AUTH)[A-Z0-9_]*)(\s*=\s*)\S+/g, "$1$2[redacted]"],
  [/\b(password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)(["']?\s*[:=]\s*)(["']?)[^\s"',;]{4,}/gi, "$1$2$3[redacted]"],
];

/** Shell output can be an env dump; only the command is journaled, never its output. */
const OUTPUT_NOT_SAVED = new Set(["Bash", "BashOutput", "TaskOutput"]);

/** Strip secret-shaped substrings before anything reaches disk. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, repl] of SECRET_PATTERNS) out = out.replace(re, repl);
  return out;
}

function oneLine(text: string, max: number): string {
  const flat = redactSecrets(text).replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function slugOf(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return s || "researcher";
}

function hhmmss(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

/** The most useful bit of a tool input: the query, url, symbol, path … */
function keyInput(input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  for (const k of ["query", "q", "url", "symbol", "ticker", "tickers", "file_path", "path", "pattern", "sql", "command", "prompt", "id"]) {
    const v = o[k];
    if (typeof v === "string" && v.length > 0) return oneLine(v, KEY_INPUT_MAX);
    if (Array.isArray(v) && v.length > 0) return oneLine(v.join(", "), KEY_INPUT_MAX);
  }
  return "";
}

function resultSummary(content: unknown): string {
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : ""))
      .join(" ");
  }
  const url = /https?:\/\/[^\s)"'<>]+/.exec(text)?.[0];
  const line = oneLine(text, RESULT_MAX);
  return url && !line.includes(url) ? `${line} (${oneLine(url, 120)})` : line;
}

/** `YYYY-MM-DD-<originMessageId>` */
export function journalDirName(startedAt: number, originMessageId: string): string {
  return `${new Date(startedAt).toISOString().slice(0, 10)}-${originMessageId.replace(/[^0-9A-Za-z_-]/g, "")}`;
}

export type ResearchJournalOptions = Readonly<{
  /** `<agent workspace>/research` */
  root: string;
  originMessageId: string;
  originTurnId: string;
  channelId: string | null;
  startedAt: number;
  now?: () => number;
  log?: Readonly<{ warn: (obj: Record<string, unknown>, msg: string) => void }>;
}>;

export class ResearchJournal {
  readonly dir: string;
  /** Path relative to the agent workspace, for the card / replies / prompts. */
  readonly relativeDir: string;
  private readonly o: ResearchJournalOptions;
  private readonly now: () => number;
  private state: JournalSessionState;
  private readonly bodies = new Map<string, ResearcherBody>();
  private readonly writers = new Map<string, { inFlight: Promise<void> | null; dirty: boolean }>();
  private loaded: Promise<void>;
  private disposed = false;

  constructor(opts: ResearchJournalOptions) {
    this.o = opts;
    this.now = opts.now ?? Date.now;
    const name = journalDirName(opts.startedAt, opts.originMessageId);
    this.dir = join(opts.root, name);
    this.relativeDir = `research/${name}/`;
    this.state = {
      version: 1,
      originMessageId: opts.originMessageId,
      originTurnId: opts.originTurnId,
      channelId: opts.channelId,
      cardMessageId: null,
      startedAt: opts.startedAt,
      updatedAt: opts.startedAt,
      state: "running",
      researchers: [],
    };
    // A rerun on the same message reuses the folder and keeps the earlier researchers.
    this.loaded = readSessionState(this.dir)
      .then((prior) => {
        if (prior) {
          const known = new Set(this.state.researchers.map((r) => r.taskId));
          this.state.researchers = [...prior.researchers.filter((r) => !known.has(r.taskId)), ...this.state.researchers];
          this.state.startedAt = Math.min(prior.startedAt, this.state.startedAt);
        }
      })
      .catch(() => undefined);
  }

  /** Files known so far (relative), for resume prompts and replies. */
  researcherFiles(): string[] {
    return this.state.researchers.map((r) => `${this.relativeDir}${r.file}`);
  }

  setCard(channelId: string, messageId: string): void {
    this.state.cardMessageId = messageId;
    this.state.channelId = channelId;
    this.markSession();
  }

  addResearcher(taskId: string, description: string): void {
    if (this.state.researchers.some((r) => r.taskId === taskId)) return;
    const file = `${taskId}-${slugOf(description)}.md`;
    this.state.researchers.push({ taskId, description: oneLine(description, 200), file, status: "running", reason: null, startedAt: this.now(), endedAt: null });
    this.bodies.set(taskId, { findings: [], log: [], omitted: 0, pendingTools: new Map(), ended: null });
    this.markResearcher(taskId);
    this.markSession();
  }

  /** A researcher's child-lane frame (assistant text / tool_use, user tool_result). */
  onChildFrame(taskId: string, frame: unknown): void {
    const body = this.bodies.get(taskId);
    if (!body) return;
    const f = frame as { type?: string; message?: { content?: unknown } };
    const content = Array.isArray(f.message?.content) ? (f.message!.content as unknown[]) : [];
    let changed = false;
    for (const raw of content) {
      const b = raw as { type?: string; text?: unknown; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown; content?: unknown };
      if (f.type === "assistant" && b.type === "text" && typeof b.text === "string") {
        for (const m of b.text.matchAll(/^\s*FINDING:\s*(.+)$/gim)) {
          const finding = oneLine(m[1]!, 400);
          if (finding && !body.findings.includes(finding) && body.findings.length < MAX_FINDINGS) body.findings.push(finding);
        }
        const note = oneLine(b.text.replace(/^\s*FINDING:.*$/gim, ""), TEXT_NOTE_MAX);
        if (note) this.log(body, `note: ${note}`);
        changed = true;
      } else if (f.type === "assistant" && b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
        body.pendingTools.set(b.id, { name: b.name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, ""), key: keyInput(b.input), at: this.now() });
        changed = true;
      } else if (f.type === "user" && b.type === "tool_result" && typeof b.tool_use_id === "string") {
        const call = body.pendingTools.get(b.tool_use_id);
        body.pendingTools.delete(b.tool_use_id);
        const name = call?.name ?? "tool";
        const key = call?.key ? ` "${call.key}"` : "";
        const res = OUTPUT_NOT_SAVED.has(name) ? "(output not saved)" : resultSummary(b.content);
        this.log(body, `${name}${key}${res ? ` → ${res}` : ""}`);
        changed = true;
      }
    }
    if (changed) this.markResearcher(taskId);
  }

  onProgress(taskId: string, line: string): void {
    const body = this.bodies.get(taskId);
    if (!body || !line) return;
    this.log(body, `progress: ${oneLine(line, 200)}`);
    this.markResearcher(taskId);
  }

  onEnd(taskId: string, status: string, reason: string | null): void {
    const r = this.state.researchers.find((x) => x.taskId === taskId);
    const body = this.bodies.get(taskId);
    if (!r) return;
    r.status = status;
    r.reason = reason;
    r.endedAt = this.now();
    if (body) body.ended = reason ? `${status} (${reason})` : status;
    this.markResearcher(taskId);
    this.markSession();
  }

  setState(state: JournalState): void {
    this.state.state = state;
    for (const r of this.state.researchers) {
      if (r.status === "running" && state !== "running") {
        r.status = state === "interrupted" ? "lost" : "stopped";
        r.endedAt = r.endedAt ?? this.now();
      }
    }
    this.markSession();
  }

  /** Resolves when every pending write has landed (tests, shutdown). */
  async flushed(): Promise<void> {
    await this.loaded;
    for (;;) {
      const pending = [...this.writers.values()].map((w) => w.inFlight).filter((p): p is Promise<void> => p !== null);
      if (pending.length === 0) return;
      await Promise.all(pending);
    }
  }

  dispose(): void {
    this.disposed = true;
  }

  // -------------------------------------------------------------------------

  private log(body: ResearcherBody, entry: string): void {
    body.log.push(`- ${hhmmss(this.now())} ${entry}`);
    if (body.log.length > MAX_LOG_ENTRIES) {
      // Keep the head and the tail; drop from the middle.
      const drop = body.log.length - MAX_LOG_ENTRIES;
      const headKeep = Math.floor(MAX_LOG_ENTRIES * 0.3);
      body.log.splice(headKeep, drop);
      body.omitted += drop;
    }
  }

  private markResearcher(taskId: string): void {
    const r = this.state.researchers.find((x) => x.taskId === taskId);
    if (r) this.schedule(r.file, () => this.renderResearcher(taskId));
  }

  private markSession(): void {
    this.state.updatedAt = this.now();
    this.schedule("session.json", () => `${JSON.stringify(this.state, null, 2)}\n`);
    this.schedule("session.md", () => this.renderSessionIndex());
  }

  /** Per-file coalescing writer: one write in flight, one follow-up if dirtied meanwhile. */
  private schedule(file: string, render: () => string): void {
    if (this.disposed) return;
    const w = this.writers.get(file) ?? { inFlight: null, dirty: false };
    this.writers.set(file, w);
    if (w.inFlight !== null) {
      w.dirty = true;
      return;
    }
    const run = async (): Promise<void> => {
      await this.loaded;
      do {
        w.dirty = false;
        try {
          await writeAtomic(join(this.dir, file), render());
        } catch (err) {
          this.o.log?.warn({ file, error: err instanceof Error ? err.message : String(err) }, "research: journal write failed");
          break;
        }
      } while (w.dirty && !this.disposed);
      w.inFlight = null;
    };
    w.inFlight = run();
  }

  private renderResearcher(taskId: string): string {
    const r = this.state.researchers.find((x) => x.taskId === taskId)!;
    const body = this.bodies.get(taskId) ?? { findings: [], log: [], omitted: 0, pendingTools: new Map(), ended: null };
    const head = [
      `# ${r.description}`,
      "",
      `Researcher \`${r.taskId}\` · started ${new Date(r.startedAt).toISOString()} · ${r.status}${r.reason ? ` (${r.reason})` : ""}`,
      "",
      "## Findings so far",
      "",
      ...(body.findings.length > 0 ? body.findings.map((f) => `- ${f}`) : ["- (none recorded yet)"]),
      "",
      "## Log",
      "",
    ];
    const tail = body.ended ? ["", `Ended: ${body.ended}`, ""] : [""];
    const compose = (log: readonly string[], omitted: number): string => {
      const keep = Math.floor(log.length * 0.3);
      const marker = omitted > 0 ? [`- … ${omitted} entries omitted …`] : [];
      return [...head, ...log.slice(0, keep), ...marker, ...log.slice(keep), ...tail].join("\n");
    };
    let log = body.log;
    let omitted = body.omitted;
    let text = compose(log, omitted);
    // Byte cap: keep the head of the log and its tail, drop from the middle.
    while (Buffer.byteLength(text, "utf8") > RESEARCHER_FILE_CAP_BYTES && log.length > 20) {
      const keep = Math.floor(log.length * 0.3);
      const cut = Math.max(1, Math.floor(log.length * 0.1));
      log = [...log.slice(0, keep), ...log.slice(keep + cut)];
      omitted += cut;
      text = compose(log, omitted);
    }
    return text;
  }

  private renderSessionIndex(): string {
    const s = this.state;
    return [
      `# Research · ${new Date(s.startedAt).toISOString().slice(0, 16).replace("T", " ")} UTC`,
      "",
      `Origin: Discord message \`${s.originMessageId}\` · state: ${s.state}`,
      "",
      "## Researchers",
      "",
      ...(s.researchers.length > 0
        ? s.researchers.map((r) => `- [${r.description}](${r.file}) · ${r.status}${r.reason ? ` (${r.reason})` : ""}`)
        : ["- (none yet)"]),
      "",
    ].join("\n");
  }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const dir = path.slice(0, path.lastIndexOf("/"));
  await mkdir(dir, { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, path);
}

async function readSessionState(dir: string): Promise<JournalSessionState | null> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, "session.json"), "utf8")) as JournalSessionState;
    return parsed?.version === 1 && Array.isArray(parsed.researchers) ? parsed : null;
  } catch {
    return null;
  }
}

/** Journals under `root` updated within `windowMs` (newest first). */
export async function listRecentJournals(
  root: string,
  now: number,
  windowMs: number = RESUME_WINDOW_MS,
): Promise<{ dirName: string; state: JournalSessionState }[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const out: { dirName: string; state: JournalSessionState }[] = [];
  for (const name of names) {
    if (!/^\d{4}-\d{2}-\d{2}-[0-9A-Za-z_-]+$/.test(name)) continue;
    try {
      if (!(await stat(join(root, name))).isDirectory()) continue;
    } catch {
      continue;
    }
    const state = await readSessionState(join(root, name));
    if (state && now - state.updatedAt <= windowMs) out.push({ dirName: name, state });
  }
  return out.sort((a, b) => b.state.updatedAt - a.state.updatedAt);
}

/** True when a journal holds a researcher that did not finish. */
export function isUnfinished(state: JournalSessionState): boolean {
  return state.state !== "done" || state.researchers.some((r) => r.status !== "completed");
}

/**
 * Boot recovery: a journal still `running` belongs to a session the daemon lost
 * (crash / restart). Mark it interrupted on disk and return it.
 */
export async function recoverInterruptedJournals(
  root: string,
  now: number,
  /** A journal written this recently may belong to a handle still shutting down. */
  quietMs = 15_000,
): Promise<{ dirName: string; state: JournalSessionState; lastActiveAt: number }[]> {
  const recovered: { dirName: string; state: JournalSessionState; lastActiveAt: number }[] = [];
  for (const j of await listRecentJournals(root, now)) {
    if (j.state.state !== "running" || now - j.state.updatedAt < quietMs) continue;
    const next: JournalSessionState = {
      ...j.state,
      state: "interrupted",
      updatedAt: now,
      researchers: j.state.researchers.map((r) =>
        r.status === "running" ? { ...r, status: "lost", reason: "interrupted by a restart", endedAt: now } : r,
      ),
    };
    try {
      await writeAtomic(join(root, j.dirName, "session.json"), `${JSON.stringify(next, null, 2)}\n`);
      recovered.push({ dirName: j.dirName, state: next, lastActiveAt: j.state.updatedAt });
    } catch {
      // best-effort
    }
  }
  return recovered;
}
