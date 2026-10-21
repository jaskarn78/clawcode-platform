/**
 * Phase 999.173 — ResearchTracker: one per session handle.
 *
 * Follows the background researcher tasks launched from Discord messages,
 * from stream events only (never model narration). Research is tracked PER
 * ORIGIN: every user message that launches researchers gets its own session
 * (card, folded text, timers, final reply). Tasks are mapped to their session
 * by the approval the launch gate recorded for their tool_use id (else the
 * live Discord turn at task_started).
 *
 * What happens to the parent's self-fired output:
 *   - FOLD   into session S while S has researchers running OR a completion
 *            wake owed: each completion (task_notification) wakes the parent
 *            once, and those wakes queue behind whatever turn is running. The
 *            filler they write ("Mercury done, Venus still running" — or, as
 *            the 2026-09-25 probe showed, "waiting for the comparison" AFTER
 *            every researcher had already ended) goes to S's card.
 *   - REPLY  when S has nothing running and no wake owed: that output is S's
 *            synthesis, delivered as a reply to S's originating message.
 *   - PASS   when the output is not a research wake, or cannot be attributed
 *            to exactly one session (two live sessions and no attribution):
 *            ordinary delivery. Fail open — never fold into the wrong card.
 *
 * Attribution: every task_notification observed while research is live is
 * queued (its session, or null for a non-research task). A self-fired
 * `result` frame (origin task-notification, observed BEFORE the turn's output
 * is routed, so an EMPTY wake still counts) pops the head: that is the wake
 * the output belongs to. When the queue is empty (unsignaled turn, or the CLI
 * folded two wakes into one turn) the output goes to the single live session
 * if there is exactly one, else it passes.
 *
 * Fail open, never drop: compaction swap, close, dead generator → settle every
 * session and deliver what is folded. Hold timeout, no synthesis within
 * SYNTHESIS_WAIT_MS, or a wake count that never settles (STRAGGLER_QUIET_MS of
 * quiet) → STOP that session's still-running researchers (the SDK would keep
 * them running untracked, past the cap), then settle and deliver. The
 * fallback timers never fire while a self-fired turn is running.
 *
 * Owned by the HANDLE, not the per-epoch demux, so it outlives an epoch swap
 * (which itself kills the researchers — reported as "lost").
 *
 * Also the concurrency backstop: the cap is global across sessions; a
 * researcher that starts while it is already reached is stopped immediately
 * (the launch gate normally prevents it).
 */

import { randomBytes } from "node:crypto";
import { createTrailRepaintScheduler, type TrailRepaintScheduler } from "../discord/trail-repaint.js";
import { RESEARCHER_AGENT_TYPE } from "./research-subagents.js";
import {
  getLiveDiscordTurn,
  type ResearchCardSessionView,
  type ResearchCardTaskView,
  type ResearchOrigin,
  type ResearchStatusView,
  type ResearchTrackerPort,
} from "./research-registry.js";
import {
  getResearchCardPort,
  type ResearchCardOutcome,
  type ResearchCardPort,
  type ResearchCardSnapshot,
} from "./research-card-sink.js";
import { join } from "node:path";
import {
  ResearchJournal,
  isUnfinished,
  listRecentJournals,
  recoverInterruptedJournals,
  type JournalSessionState,
} from "./research-journal.js";
import {
  CAP_REASON,
  TIMEOUT_REASON,
  classifyFailure,
  failureNotice,
  topReason,
  type FailureReason,
} from "./research-failure.js";

/** How long an approved launch may wait for its task_started. */
export const APPROVAL_TTL_MS = 2 * 60 * 1000;
/** After a session's last researcher ends, how long to wait for its synthesis turn. */
export const SYNTHESIS_WAIT_MS = 3 * 60 * 1000;
/** All researchers ended but a wake still seems owed: deliver the latest output after this much quiet. */
export const STRAGGLER_QUIET_MS = 45 * 1000;
/** Every researcher ended without a result: how long to wait for the parent before the daemon's own notice. */
export const FAILURE_NOTICE_WAIT_MS = 60 * 1000;
/** After the last owed wake closes with no output, let a held output land before noticing. */
export const NOTICE_SETTLE_MS = 5 * 1000;
/** Discord's typing indicator lasts ~10 s; refresh it this often while the synthesis is written. */
export const SYNTHESIS_TYPING_MS = 8_000;
/** Hard cap on synthesis typing (a wedged turn must never type forever). */
export const SYNTHESIS_TYPING_MAX_MS = 15 * 60 * 1000;
/** Card repaint cadence (elapsed moves; edits coalesce). */
export const CARD_REPAINT_MS = 5_000;
/** Researcher tool_use ids remembered for child-lane routing. */
const LANE_MEMORY_CAP = 200;
/** Task → session index size (ended sessions stay reachable for late frames). */
const TASK_INDEX_CAP = 500;
/** Recently ended sessions kept for late frames and button clicks. */
const RECENT_CAP = 10;
const WAKE_QUEUE_CAP = 100;
const INTERIM_MAX_CHARS = 160;

export type OrphanRoute =
  | Readonly<{ kind: "pass" }>
  | Readonly<{ kind: "fold" }>
  | Readonly<{ kind: "reply"; replyTo: Readonly<{ channelId: string; messageId: string }> }>;

export type FailOpenDelivery = (
  text: string,
  replyTo: Readonly<{ channelId: string; messageId: string }> | null,
) => void;

type TaskStatus = ResearchCardTaskView["status"];

interface TaskRec {
  index: number;
  taskId: string;
  toolUseId: string | null;
  description: string;
  status: TaskStatus;
  lastLine: string | null;
  startedAt: number;
  endedAt: number | null;
  /** Why it ended without finishing (failed / stopped / timed out); null otherwise. */
  reason: FailureReason | null;
  /** Tool calls counted by the research hook. */
  toolCalls: number;
  /** Wall-clock cap timer (research.maxMinutes). */
  wallClock: ReturnType<typeof setTimeout> | null;
}

interface Session {
  key: string;
  origin: ResearchOrigin;
  startedAt: number;
  tasks: Map<string, TaskRec>;
  folded: string[];
  /** Researcher completions whose self-fired wake turn has not closed yet. */
  pendingWakes: number;
  /** A launch for this origin was reduced by the usage guard (card header note). */
  usageLimited: boolean;
  /** Findings journal (absent when the tracker has no journal root). */
  journal: ResearchJournal | null;
  /** Tool calls across all of this session's researchers. */
  toolCalls: number;
  /** A budget guard fired (card header note "budget reached"). */
  budgetReached: boolean;
  settled: { at: number; outcome: ResearchCardOutcome } | null;
  cardMessageId: string | null;
  cardPosting: Promise<void> | null;
  lastPaintAt: number;
  scheduler: TrailRepaintScheduler | null;
  holdTimer: ReturnType<typeof setTimeout> | null;
  synthesisTimer: ReturnType<typeof setTimeout> | null;
  stragglerTimer: ReturnType<typeof setTimeout> | null;
  noticeTimer: ReturnType<typeof setTimeout> | null;
  /** When the latest folded output arrived (stale-filler guard). */
  lastFoldAt: number;
  /** Every researcher ended and the synthesis turn is running: since when. */
  writingSince: number | null;
  /** Typing refresh while the synthesis is written. */
  typingTimer: ReturnType<typeof setInterval> | null;
}

type Frame = {
  readonly type?: string;
  readonly subtype?: string;
  readonly task_id?: unknown;
  readonly tool_use_id?: unknown;
  readonly description?: unknown;
  readonly subagent_type?: unknown;
  readonly summary?: unknown;
  readonly last_tool_name?: unknown;
  readonly status?: unknown;
  readonly patch?: { readonly status?: unknown };
  readonly tasks?: unknown;
  readonly origin?: { readonly kind?: unknown };
};

export type ResearchTrackerLogger = Readonly<{
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
}>;

export type ResearchTrackerOptions = Readonly<{
  agentName: string;
  maxConcurrent: number;
  holdTimeoutMs: number;
  stopTask: (taskId: string) => Promise<unknown> | unknown;
  /**
   * Stop the task a tool_use started, deferring until its task id is known
   * (the handle's TaskIdMap). Used for launches approved but not yet started
   * when a session times out. Absent → those are left to the approval TTL.
   */
  stopForToolUse?: (toolUseId: string) => void;
  deliver: FailOpenDelivery;
  now?: () => number;
  cardPort?: () => ResearchCardPort | undefined;
  repaintMs?: number;
  synthesisWaitMs?: number;
  stragglerQuietMs?: number;
  failureNoticeWaitMs?: number;
  noticeSettleMs?: number;
  /** Synthesis typing refresh / cap (tests). */
  typingMs?: number;
  typingMaxMs?: number;
  /**
   * `<agent workspace>/research` — where findings journals are written.
   * Absent → no journal (tests that do not care, or an agent without a cwd).
   */
  journalRoot?: string;
  /** research.maxMinutes: stop a researcher running longer than this. Absent → no cap. */
  maxResearcherMs?: number;
  log?: ResearchTrackerLogger;
}>;

const consoleLog: ResearchTrackerLogger = {
  info: (obj, msg) => console.info(JSON.stringify({ component: "research", msg, ...obj })),
  warn: (obj, msg) => console.warn(JSON.stringify({ component: "research", msg, ...obj })),
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** Wake attribution: undefined = no queued wake; null = a non-research wake. */
type Attribution = Session | null | undefined;

export class ResearchTracker implements ResearchTrackerPort {
  private readonly o: ResearchTrackerOptions;
  private readonly now: () => number;
  private readonly log: ResearchTrackerLogger;
  /** Live sessions, one per originating Discord message (turn id). */
  private readonly active = new Map<string, Session>();
  /** Recently ended sessions, so late frames and button clicks still find them. */
  private readonly recent: Session[] = [];
  /** task id → its session (live or recently ended). */
  private readonly taskIndex = new Map<string, Session>();
  private readonly approvals = new Map<string, { origin: ResearchOrigin; at: number; usageLimited: boolean }>();
  private readonly researcherLanes = new Set<string>();
  /** One entry per task_notification observed while research is live, in stream order. */
  private readonly wakeQueue: (Session | null)[] = [];
  /** The wake whose output routeOrphanOutput is about to receive. */
  private pendingAttribution: Attribution = undefined;
  /** A self-fired parent turn is running right now (fallback timers wait for it). */
  private selfFiredOpen = false;
  /** researcher tool_use id → its session + task (child-lane frames → journal). */
  private readonly laneTask = new Map<string, { s: Session; taskId: string }>();
  /** Recent journals on disk (resume context), newest first. Loaded by recoverFromDisk. */
  private recentJournals: { dirName: string; state: JournalSessionState }[] = [];
  private disposed = false;

  constructor(opts: ResearchTrackerOptions) {
    this.o = opts;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? consoleLog;
  }

  // ---------------------------------------------------------------------------
  // Launch gate port
  // ---------------------------------------------------------------------------

  /** Global across sessions: researchers running + launches approved but not yet started. */
  occupiedSlots(): number {
    this.sweepApprovals();
    return this.runningCount() + this.approvals.size;
  }

  occupiedSlotsFor(turnId: string): number {
    this.sweepApprovals();
    const s = this.active.get(turnId);
    let n = s ? this.outstanding(s) : 0;
    for (const a of this.approvals.values()) if (a.origin.turnId === turnId) n++;
    return n;
  }

  noteApprovedLaunch(toolUseId: string, origin: ResearchOrigin, opts: Readonly<{ usageLimited?: boolean }> = {}): void {
    this.sweepApprovals();
    const usageLimited = opts.usageLimited === true;
    this.approvals.set(toolUseId, { origin, at: this.now(), usageLimited });
    this.rememberLane(toolUseId);
    const s = this.active.get(origin.turnId);
    if (s && usageLimited && !s.usageLimited) {
      s.usageLimited = true;
      this.requestPaint(s);
    }
  }

  sessionForKey(key: string): ResearchCardSessionView | undefined {
    const s = [...this.active.values(), ...this.recent].find((r) => r.key === key);
    return s ? this.view(s) : undefined;
  }

  // ---------------------------------------------------------------------------
  // Stream
  // ---------------------------------------------------------------------------

  /** A researcher's lanes are detached background work: never a daemon turn's frames. */
  isDetachedChild(parentToolUseId: string): boolean {
    return this.researcherLanes.has(parentToolUseId);
  }

  toolCallsFor(taskId: string): { task: number; session: number; known: boolean } {
    const s = this.taskIndex.get(taskId);
    const t = s?.tasks.get(taskId);
    return s && t ? { task: t.toolCalls, session: s.toolCalls, known: true } : { task: 0, session: 0, known: false };
  }

  countToolCall(taskId: string): { task: number; session: number; known: boolean } {
    const s = this.taskIndex.get(taskId);
    const t = s?.tasks.get(taskId);
    if (!s || !t) return { task: 0, session: 0, known: false };
    t.toolCalls += 1;
    s.toolCalls += 1;
    return { task: t.toolCalls, session: s.toolCalls, known: true };
  }

  noteBudgetReached(taskId: string): void {
    const s = this.taskIndex.get(taskId);
    if (!s || s.budgetReached) return;
    s.budgetReached = true;
    this.log.warn({ agent: this.o.agentName, key: s.key, taskId }, "research: budget reached");
    this.requestPaint(s);
  }

  /** A child-lane frame (researcher text, tool calls, tool results) → its journal. */
  observeChild(parentToolUseId: string, frame: unknown): void {
    if (this.disposed) return;
    const hit = this.laneTask.get(parentToolUseId);
    if (!hit) return;
    try {
      hit.s.journal?.onChildFrame(hit.taskId, frame);
    } catch (err) {
      this.log.warn({ agent: this.o.agentName, error: err instanceof Error ? err.message : String(err) }, "research: journal child frame failed");
    }
  }

  /**
   * Resume context for a launch: the notes of earlier research on the same
   * message (a rerun), or — when the user asked to resume — of the most recent
   * unfinished research. Null when there is nothing to continue from.
   */
  resumeContextFor(origin: ResearchOrigin & { resumeRequested?: boolean }): string | null {
    const unfinished = this.recentJournals.filter((j) => isUnfinished(j.state));
    const same = unfinished.filter((j) => j.state.originMessageId === origin.messageId);
    const pick = same.length > 0 ? same : origin.resumeRequested ? unfinished.slice(0, 1) : [];
    const files = pick.flatMap((j) =>
      j.state.researchers.map((r) => `research/${j.dirName}/${r.file} (${r.status}${r.reason ? `: ${r.reason}` : ""})`),
    );
    if (files.length === 0) return null;
    return (
      "Earlier research on this was cut short. Its notes are saved in your workspace:\n" +
      files.map((f) => `- ${f}`).join("\n") +
      "\nRead the file that matches your sub-question first (its Findings section is at the top) and continue from it instead of starting over."
    );
  }

  /**
   * Boot / handle start: load recent journals (resume context) and recover any
   * the daemon lost mid-run (crash): mark them interrupted, settle their card,
   * and tell the asker once — for research lost within the last hour.
   */
  async recoverFromDisk(): Promise<void> {
    const root = this.o.journalRoot;
    if (root === undefined) return;
    const now = this.now();
    try {
      const recovered = await recoverInterruptedJournals(root, now);
      this.recentJournals = await listRecentJournals(root, now);
      for (const r of recovered) {
        if (now - r.lastActiveAt > 60 * 60 * 1000) continue;
        const replyTo = r.state.channelId ? { channelId: r.state.channelId, messageId: r.state.originMessageId } : null;
        this.log.warn({ agent: this.o.agentName, dir: r.dirName }, "research: recovered a journal interrupted by a restart");
        this.o.deliver(
          `Research on this was interrupted by a restart. Partial notes are saved in research/${r.dirName}/. Ask me to resume research to continue from them.`,
          replyTo,
        );
        const port = (this.o.cardPort ?? getResearchCardPort)();
        if (port && r.state.channelId && r.state.cardMessageId) {
          const tasks = r.state.researchers.map((x, index) => ({
            index,
            taskId: x.taskId,
            description: x.description,
            status: (x.status === "completed" || x.status === "failed" || x.status === "stopped" ? x.status : "lost") as ResearchCardTaskView["status"],
            lastLine: null,
            startedAt: x.startedAt,
            endedAt: x.endedAt,
          }));
          void Promise.resolve(
            port.edit(r.state.channelId, r.state.cardMessageId, {
              session: { key: "00000000", agentName: this.o.agentName, origin: { turnId: r.state.originTurnId, messageId: r.state.originMessageId, channelId: r.state.channelId }, startedAt: r.state.startedAt, tasks },
              interim: null,
              settled: { at: r.lastActiveAt, outcome: "interrupted" },
              reason: "interrupted by a restart",
              savedTo: `research/${r.dirName}/`,
              now,
            }),
          ).catch(() => undefined);
        }
      }
    } catch (err) {
      this.log.warn({ agent: this.o.agentName, error: err instanceof Error ? err.message : String(err) }, "research: journal recovery failed");
    }
  }

  observe(frame: unknown): void {
    if (this.disposed) return;
    const f = frame as Frame | null | undefined;
    try {
      if (f?.type === "result") {
        this.onResult(f);
        return;
      }
      if (f?.type !== "system") return;
      switch (f.subtype) {
        case "task_started":
          this.onStarted(f);
          return;
        case "task_progress":
          this.onProgress(f);
          return;
        case "task_updated":
          this.onUpdated(f);
          return;
        case "task_notification":
          this.onNotification(f);
          return;
        case "background_tasks_changed":
          this.onBackgroundSet(f);
          return;
        default:
          return;
      }
    } catch (err) {
      this.log.warn({ agent: this.o.agentName, error: err instanceof Error ? err.message : String(err) }, "research: tracker observe failed");
    }
  }

  /**
   * A self-fired output the handle does NOT route here (an error result, an
   * abandoned turn's late text): drop the wake attribution so it cannot attach
   * to a later, unrelated output.
   */
  skipOrphanOutput(): void {
    this.pendingAttribution = undefined;
  }

  /** Decide the fate of one self-fired parent output. */
  routeOrphanOutput(text: string): OrphanRoute {
    const attributed = this.pendingAttribution;
    this.pendingAttribution = undefined;
    if (this.disposed || this.active.size === 0) return { kind: "pass" };
    const s = this.resolveTarget(attributed);
    if (s === null) return { kind: "pass" };
    const outstanding = this.outstanding(s);
    if (outstanding > 0 || s.pendingWakes > 0) {
      s.folded.push(text);
      s.lastFoldAt = this.now();
      this.log.info(
        { agent: this.o.agentName, key: s.key, outstanding, pendingWakes: s.pendingWakes },
        "research: folded",
      );
      if (outstanding === 0) this.armStragglerTimer(s);
      this.requestPaint(s);
      return { kind: "fold" };
    }
    const replyTo = this.replyTarget(s);
    this.endSession(s, "done");
    this.log.info({ agent: this.o.agentName, key: s.key, reply: replyTo !== null }, "research: delivered");
    return replyTo === null ? { kind: "pass" } : { kind: "reply", replyTo };
  }

  /**
   * The handle reports self-fired turn boundaries. While one is open the
   * fallback timers never fire — a long synthesis turn (extended thinking can
   * be silent for a minute) must not be pre-empted by its own filler.
   */
  setSelfFiredTurnOpen(open: boolean): void {
    this.selfFiredOpen = open;
    this.syncWriting();
  }

  /**
   * A user message the CLI folded into the running self-fired turn took that
   * turn's result (the demux's merge path): the output was delivered as the
   * reply to the USER's message, not through routeOrphanOutput. If it was the
   * synthesis (every researcher ended), the research is answered — end the
   * session so the fallback timer never re-posts stale filler minutes later
   * (fin-client 2026-09-26: "Only the free-fundamentals one is still
   * running" posted 2.5 min after the synthesis landed).
   */
  absorbSelfFiredOutput(): void {
    const attributed = this.pendingAttribution;
    this.pendingAttribution = undefined;
    if (this.disposed || this.active.size === 0) return;
    const s = this.resolveTarget(attributed);
    if (s === null || this.outstanding(s) > 0 || this.completedCount(s) === 0) return;
    this.log.info({ agent: this.o.agentName, key: s.key }, "research: synthesis delivered in the user's turn");
    s.folded = [];
    this.endSession(s, "done");
  }

  /** What a status ping should say about research (null when none is live). */
  statusView(): ResearchStatusView | null {
    let s: Session | undefined;
    for (const x of this.active.values()) if (s === undefined || x.startedAt > s.startedAt) s = x;
    if (s === undefined || s.tasks.size === 0) return null;
    return {
      total: s.tasks.size,
      done: this.completedCount(s),
      running: this.outstanding(s),
      startedAt: s.startedAt,
      writingSince: s.writingSince,
    };
  }

  /** True while every researcher of S has ended with a result and its synthesis is still owed. */
  private awaitingSynthesis(s: Session): boolean {
    return this.active.get(s.origin.turnId) === s && this.outstanding(s) === 0 && this.completedCount(s) > 0;
  }

  /**
   * The synthesis turn is running: say so on the card and keep the channel
   * typing, so the user never sees a silent channel between "all researchers
   * done" and the answer. Typing only while a self-fired turn is actually
   * open (an idle parent owes nothing visible yet).
   */
  private syncWriting(): void {
    for (const s of this.active.values()) {
      const writing = this.selfFiredOpen && this.awaitingSynthesis(s);
      if (writing && s.typingTimer === null) {
        if (s.writingSince === null) {
          s.writingSince = this.now();
          this.requestPaint(s);
        }
        this.startTyping(s);
      } else if (!writing && s.typingTimer !== null) {
        this.stopTyping(s);
      }
    }
  }

  private startTyping(s: Session): void {
    this.stopTyping(s);
    const port = (this.o.cardPort ?? getResearchCardPort)();
    const channelId = s.origin.channelId;
    if (port?.typing === undefined || channelId === null) return;
    const startedAt = this.now();
    const beat = (): void => {
      if (this.now() - startedAt >= (this.o.typingMaxMs ?? SYNTHESIS_TYPING_MAX_MS)) {
        this.stopTyping(s);
        return;
      }
      try {
        void port.typing!(channelId).catch(() => undefined);
      } catch {
        // typing is cosmetic — never break the tracker
      }
    };
    beat();
    s.typingTimer = setInterval(beat, this.o.typingMs ?? SYNTHESIS_TYPING_MS);
    unref(s.typingTimer);
  }

  private stopTyping(s: Session): void {
    if (s.typingTimer !== null) clearInterval(s.typingTimer);
    s.typingTimer = null;
  }

  /** Swap / close / generator-dead: the researchers are gone. Settle every session and deliver. */
  failOpen(reason: string): void {
    for (const s of [...this.active.values()]) {
      for (const t of s.tasks.values()) {
        if (t.status === "running") {
          t.status = "lost";
          t.endedAt = this.now();
        }
      }
      this.log.warn({ agent: this.o.agentName, key: s.key, reason }, "research: fail-open");
      this.deliverFolded(s, "all");
      this.endSession(s, "interrupted");
    }
    this.approvals.clear();
  }

  /** Terminal (handle close). Idempotent. */
  dispose(reason = "close"): void {
    if (this.disposed) return;
    this.failOpen(reason);
    this.disposed = true;
    for (const r of this.recent) r.scheduler?.stop();
  }

  // ---------------------------------------------------------------------------
  // Frame handlers
  // ---------------------------------------------------------------------------

  private onStarted(f: Frame): void {
    const taskId = str(f.task_id);
    if (taskId === null || this.taskIndex.has(taskId)) return;
    const toolUseId = str(f.tool_use_id);
    const approved = toolUseId !== null ? this.approvals.get(toolUseId) : undefined;
    const isResearcher = f.subagent_type === RESEARCHER_AGENT_TYPE || approved !== undefined;
    if (!isResearcher) return;
    if (toolUseId !== null) {
      this.approvals.delete(toolUseId);
      this.rememberLane(toolUseId);
    }
    const origin = approved?.origin ?? getLiveDiscordTurn(this.o.agentName) ?? null;
    if (origin === null) {
      this.log.warn({ agent: this.o.agentName, taskId }, "research: researcher started with no originating Discord turn — not tracked");
      return;
    }
    const s = this.active.get(origin.turnId) ?? this.startSession(origin);
    if (approved?.usageLimited) s.usageLimited = true;
    if (toolUseId !== null) this.laneTask.set(toolUseId, { s, taskId });
    const rec: TaskRec = {
      index: s.tasks.size,
      taskId,
      toolUseId,
      description: str(f.description) ?? "Researching",
      status: "running",
      lastLine: null,
      startedAt: this.now(),
      endedAt: null,
      reason: null,
      toolCalls: 0,
      wallClock: null,
    };
    s.tasks.set(taskId, rec);
    if (this.o.maxResearcherMs !== undefined) {
      rec.wallClock = setTimeout(() => this.onWallClock(s, rec), this.o.maxResearcherMs);
      unref(rec.wallClock);
    }
    this.indexTask(taskId, s);
    s.journal?.addResearcher(taskId, rec.description);
    this.clearTimer(s, "synthesisTimer");
    this.clearTimer(s, "stragglerTimer");
    if (this.runningCount() > this.o.maxConcurrent) {
      this.log.warn({ agent: this.o.agentName, taskId, max: this.o.maxConcurrent }, "research: over the cap — stopping");
      rec.reason = CAP_REASON;
      this.stop(taskId);
    }
    this.log.info({ agent: this.o.agentName, key: s.key, taskId, running: this.runningCount() }, "research: started");
    this.requestPaint(s);
  }

  private onProgress(f: Frame): void {
    const hit = this.taskOf(f);
    if (!hit) return;
    const summary = str(f.summary);
    const tool = str(f.last_tool_name);
    if (summary !== null) hit.t.lastLine = oneLine(summary, 90);
    else if (tool !== null) hit.t.lastLine = `using ${tool.replace(/^mcp__[^_]+__/, "")}`;
    if (summary !== null) hit.s.journal?.onProgress(hit.t.taskId, summary);
    this.requestPaint(hit.s);
  }

  private onUpdated(f: Frame): void {
    const hit = this.taskOf(f);
    if (!hit) return;
    const st = f.patch?.status;
    if (st === "completed") this.end(hit.t, "completed");
    else if (st === "failed") this.end(hit.t, "failed");
    else if (st === "killed") this.end(hit.t, "stopped");
    else return;
    if (st !== "completed" && hit.t.reason === null) hit.t.reason = classifyFailure(st === "killed" ? "stopped" : "failed", undefined);
    this.afterEnd(hit.s);
  }

  private onNotification(f: Frame): void {
    const hit = this.taskOf(f);
    if (hit) {
      const st = f.status;
      this.end(hit.t, st === "failed" ? "failed" : st === "stopped" ? "stopped" : "completed", true);
      if (st === "failed" || st === "stopped") {
        // A reason the tracker set itself (timeout, cap) wins over the generic
        // "stopped"; a failure's own summary always wins (it names the cause).
        const parsed = classifyFailure(String(st), f.summary);
        if (st === "failed" || hit.t.reason === null) hit.t.reason = parsed;
      } else {
        hit.t.reason = null;
      }
    }
    // Every notification wakes the parent once (possibly queued behind the
    // turn running now). Queue it — attributed to a LIVE research session, or
    // null for any other task (a non-research wake must not pop a research
    // entry). Only while research is live, so stale entries never linger.
    if (this.active.size === 0) return;
    const owner = hit !== undefined && this.active.get(hit.s.origin.turnId) === hit.s ? hit.s : null;
    this.wakeQueue.push(owner);
    if (this.wakeQueue.length > WAKE_QUEUE_CAP) this.wakeQueue.shift();
    if (owner !== null) {
      owner.pendingWakes += 1;
      this.afterEnd(owner);
    } else if (hit) {
      // A late completion for an ENDED session: just repaint its settled card.
      this.requestPaint(hit.s);
    }
  }

  /** A self-fired wake turn is closing: pop the wake it pays and remember whose output follows. */
  private onResult(f: Frame): void {
    if (f.origin?.kind !== "task-notification") {
      // A daemon (user) turn's result: no self-fired output follows it.
      this.pendingAttribution = undefined;
      return;
    }
    if (this.wakeQueue.length === 0) {
      this.pendingAttribution = undefined;
      return;
    }
    const owner = this.wakeQueue.shift()!;
    this.pendingAttribution = owner;
    if (owner === null) return;
    if (owner.pendingWakes > 0) owner.pendingWakes -= 1;
    if (owner.stragglerTimer !== null && this.outstanding(owner) === 0) this.armStragglerTimer(owner);
    // Every researcher ended without a result and the last owed wake just
    // closed: if its output does not arrive as a reply in the next moments
    // (it errored — the parent is usually rate-limited too), post the notice.
    if (this.outstanding(owner) === 0 && owner.pendingWakes === 0 && this.completedCount(owner) === 0) {
      this.armNoticeTimer(owner, this.o.noticeSettleMs ?? NOTICE_SETTLE_MS);
    }
  }

  /** REPLACE semantics: a running researcher missing from the live set has ended. */
  private onBackgroundSet(f: Frame): void {
    if (!Array.isArray(f.tasks)) return;
    const live = new Set(
      (f.tasks as { task_id?: unknown }[]).map((t) => t?.task_id).filter((id): id is string => typeof id === "string"),
    );
    for (const s of [...this.active.values()]) {
      let changed = false;
      for (const t of s.tasks.values()) {
        if (t.status === "running" && !live.has(t.taskId)) {
          this.end(t, "completed");
          changed = true;
        }
      }
      if (changed) this.afterEnd(s);
    }
  }

  private end(t: TaskRec, status: TaskStatus, authoritative = false): void {
    if (t.status !== "running" && !authoritative) return;
    t.status = status;
    t.endedAt = t.endedAt ?? this.now();
    if (t.wallClock !== null) {
      clearTimeout(t.wallClock);
      t.wallClock = null;
    }
  }

  /** research.maxMinutes: stop a researcher that runs too long. Its journal keeps its work. */
  private onWallClock(s: Session, t: TaskRec): void {
    t.wallClock = null;
    if (t.status !== "running") return;
    this.log.warn({ agent: this.o.agentName, key: s.key, taskId: t.taskId }, "research: wall-clock cap — stopping researcher");
    this.stop(t.taskId);
    t.reason = TIMEOUT_REASON;
    this.end(t, "stopped", true);
    this.afterEnd(s);
  }

  private afterEnd(s: Session): void {
    for (const t of s.tasks.values()) {
      if (t.status !== "running") s.journal?.onEnd(t.taskId, t.status, t.reason?.text ?? null);
    }
    this.requestPaint(s);
    if (this.active.get(s.origin.turnId) !== s || this.outstanding(s) > 0) return;
    if (this.completedCount(s) > 0) this.armSynthesisTimer(s);
    else this.armNoticeTimer(s, this.o.failureNoticeWaitMs ?? FAILURE_NOTICE_WAIT_MS);
    this.syncWriting();
  }

  /**
   * Which live session a self-fired output belongs to, or null (pass).
   * A queued wake is authoritative; with no queued wake, only an unambiguous
   * single live session may take it.
   */
  private resolveTarget(attributed: Attribution): Session | null {
    if (attributed === null) return null;
    if (attributed !== undefined) {
      return this.active.get(attributed.origin.turnId) === attributed ? attributed : null;
    }
    // Every active session is either running or awaiting its synthesis, so
    // exactly one active session is unambiguous; two or more is not.
    if (this.active.size === 1) return this.active.values().next().value!;
    this.log.warn({ agent: this.o.agentName, active: this.active.size }, "research: self-fired output not attributable — delivering as-is");
    return null;
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  private startSession(origin: ResearchOrigin): Session {
    const s: Session = {
      key: randomBytes(4).toString("hex"),
      origin,
      startedAt: this.now(),
      tasks: new Map(),
      folded: [],
      pendingWakes: 0,
      usageLimited: false,
      toolCalls: 0,
      budgetReached: false,
      journal:
        this.o.journalRoot !== undefined
          ? new ResearchJournal({
              root: this.o.journalRoot,
              originMessageId: origin.messageId,
              originTurnId: origin.turnId,
              channelId: origin.channelId,
              startedAt: this.now(),
              now: this.now,
              log: this.log,
            })
          : null,
      settled: null,
      cardMessageId: null,
      cardPosting: null,
      lastPaintAt: 0,
      scheduler: null,
      holdTimer: null,
      synthesisTimer: null,
      stragglerTimer: null,
      noticeTimer: null,
      lastFoldAt: 0,
      writingSince: null,
      typingTimer: null,
    };
    s.holdTimer = setTimeout(() => this.onHoldTimeout(s), this.o.holdTimeoutMs);
    unref(s.holdTimer);
    this.active.set(origin.turnId, s);
    return s;
  }

  private onHoldTimeout(s: Session): void {
    if (this.active.get(s.origin.turnId) !== s) return;
    this.log.warn({ agent: this.o.agentName, key: s.key, outstanding: this.outstanding(s) }, "research: hold timeout — stopping researchers, delivering what is folded");
    this.stopOutstanding(s);
    if (!this.deliverFolded(s, "all") && this.completedCount(s) === 0) this.deliverNotice(s);
    this.endSession(s, "timeout");
  }

  /**
   * Every researcher ended without a result. Unless the parent answers first
   * (routeOrphanOutput → reply ends the session and clears this timer), the
   * daemon posts one model-free reply to the asker. Never while a self-fired
   * turn is running (that may be the parent's answer).
   */
  private armNoticeTimer(s: Session, delayMs: number): void {
    this.clearTimer(s, "noticeTimer");
    s.noticeTimer = setTimeout(() => {
      if (this.active.get(s.origin.turnId) !== s) return;
      if (this.selfFiredOpen) {
        this.armNoticeTimer(s, delayMs);
        return;
      }
      if (this.outstanding(s) > 0 || this.completedCount(s) > 0) return;
      if (!this.deliverFolded(s, "latest")) this.deliverNotice(s);
      this.endSession(s, "done");
    }, delayMs);
    unref(s.noticeTimer);
  }

  /** The daemon's own short reply for a research that produced nothing. */
  private deliverNotice(s: Session): void {
    const reason = topReason([...s.tasks.values()].map((t) => t.reason));
    const text = failureNotice(reason, s.journal?.relativeDir);
    if (text === null) return;
    this.log.warn({ agent: this.o.agentName, key: s.key, reason: reason?.code }, "research: every researcher failed — posting a notice");
    try {
      this.o.deliver(text, this.replyTarget(s));
    } catch (err) {
      this.log.warn({ agent: this.o.agentName, error: err instanceof Error ? err.message : String(err) }, "research: notice delivery threw");
    }
  }

  private armSynthesisTimer(s: Session): void {
    this.clearTimer(s, "synthesisTimer");
    s.synthesisTimer = setTimeout(() => {
      if (this.active.get(s.origin.turnId) !== s) return;
      if (this.selfFiredOpen) {
        this.armSynthesisTimer(s);
        return;
      }
      this.log.warn({ agent: this.o.agentName, key: s.key }, "research: no synthesis arrived — delivering the latest output");
      this.stopOutstanding(s);
      this.deliverSynthesisFallback(s);
      this.endSession(s, "done");
    }, this.o.synthesisWaitMs ?? SYNTHESIS_WAIT_MS);
    unref(s.synthesisTimer);
  }

  /**
   * Every researcher of S has ended but its wake count says a turn is still
   * owed (the CLI can fold two wakes into one turn). Once the stream stays
   * quiet, the latest folded output is the synthesis. Re-armed by each wake.
   */
  private armStragglerTimer(s: Session): void {
    this.clearTimer(s, "stragglerTimer");
    s.stragglerTimer = setTimeout(() => {
      if (this.active.get(s.origin.turnId) !== s) return;
      if (this.selfFiredOpen) {
        this.armStragglerTimer(s);
        return;
      }
      this.log.warn(
        { agent: this.o.agentName, key: s.key, pendingWakes: s.pendingWakes },
        "research: wake count never settled — delivering the latest output",
      );
      this.stopOutstanding(s);
      this.deliverSynthesisFallback(s);
      this.endSession(s, "done");
    }, this.o.stragglerQuietMs ?? STRAGGLER_QUIET_MS);
    unref(s.stragglerTimer);
  }

  private clearTimer(s: Session, which: "holdTimer" | "synthesisTimer" | "stragglerTimer" | "noticeTimer"): void {
    const t = s[which];
    if (t !== null) clearTimeout(t);
    s[which] = null;
  }

  /**
   * A session ending on a timeout must not leave researchers running: once it
   * ends they are untracked, invisible to the global cap, and their late wakes
   * would land as plain posts. Stop the running ones by task id, and the
   * approved-but-not-started ones by tool_use id (deferred until their task id
   * is known).
   */
  private stopOutstanding(s: Session): void {
    for (const t of s.tasks.values()) {
      if (t.status !== "running") continue;
      this.stop(t.taskId);
      t.status = "stopped";
      t.endedAt = this.now();
      t.reason = TIMEOUT_REASON;
    }
    for (const [toolUseId, a] of [...this.approvals]) {
      if (a.origin.turnId !== s.origin.turnId) continue;
      this.approvals.delete(toolUseId);
      try {
        this.o.stopForToolUse?.(toolUseId);
      } catch {
        // best-effort
      }
    }
  }

  private endSession(s: Session, outcome: ResearchCardOutcome): void {
    this.stopTyping(s);
    this.clearTimer(s, "holdTimer");
    this.clearTimer(s, "synthesisTimer");
    this.clearTimer(s, "stragglerTimer");
    this.clearTimer(s, "noticeTimer");
    for (const t of s.tasks.values()) {
      if (t.wallClock !== null) {
        clearTimeout(t.wallClock);
        t.wallClock = null;
      }
    }
    s.settled = { at: this.now(), outcome };
    if (s.journal) {
      for (const t of s.tasks.values()) {
        if (t.status !== "running") s.journal.onEnd(t.taskId, t.status, t.reason?.text ?? null);
      }
      s.journal.setState(outcome === "done" ? "done" : outcome);
      void this.refreshJournalIndex(s);
    }
    if (this.active.get(s.origin.turnId) === s) this.active.delete(s.origin.turnId);
    for (let i = 0; i < this.wakeQueue.length; i++) {
      if (this.wakeQueue[i] === s) this.wakeQueue[i] = null;
    }
    if (this.active.size === 0) this.wakeQueue.length = 0;
    this.recent.unshift(s);
    while (this.recent.length > RECENT_CAP) this.recent.pop()?.scheduler?.stop();
    // Final paint: request now, then stop the ticker once it lands.
    this.requestPaint(s, true);
  }

  /**
   * "all" when the research was cut short (partial findings may be spread over
   * several interim turns); "latest" when it finished (earlier outputs are
   * filler, the last one is the synthesis).
   */
  /** Returns whether anything was delivered. */
  private deliverFolded(s: Session, which: "all" | "latest"): boolean {
    if (s.folded.length === 0) return false;
    const text = which === "all" ? s.folded.join("\n\n") : s.folded[s.folded.length - 1]!;
    s.folded = [];
    try {
      this.o.deliver(text, this.replyTarget(s));
    } catch (err) {
      this.log.warn({ agent: this.o.agentName, error: err instanceof Error ? err.message : String(err) }, "research: fail-open delivery threw");
    }
    return true;
  }

  /**
   * The synthesis never arrived: deliver the latest folded output only if it
   * was written after the last researcher ended (it may be the synthesis).
   * Older filler ("two still running") would be false by now — post a plain
   * "finished, notes saved" line instead.
   */
  private deliverSynthesisFallback(s: Session): void {
    let lastEnd = 0;
    for (const t of s.tasks.values()) lastEnd = Math.max(lastEnd, t.endedAt ?? 0);
    if (s.folded.length > 0 && s.lastFoldAt >= lastEnd) {
      this.deliverFolded(s, "latest");
      return;
    }
    s.folded = [];
    const n = s.tasks.size;
    const saved = s.journal ? ` Notes are saved in ${s.journal.relativeDir}` : "";
    const text = `Research finished (${this.completedCount(s)} of ${n}), but I didn't get to write it up.${saved} Ask me to summarize it.`;
    try {
      this.o.deliver(text, this.replyTarget(s));
    } catch (err) {
      this.log.warn({ agent: this.o.agentName, error: err instanceof Error ? err.message : String(err) }, "research: fallback delivery threw");
    }
  }

  private replyTarget(s: Session): Readonly<{ channelId: string; messageId: string }> | null {
    return s.origin.channelId !== null ? { channelId: s.origin.channelId, messageId: s.origin.messageId } : null;
  }

  // ---------------------------------------------------------------------------
  // Card
  // ---------------------------------------------------------------------------

  private requestPaint(s: Session, final = false): void {
    const port = (this.o.cardPort ?? getResearchCardPort)();
    if (port === undefined || s.origin.channelId === null) return;
    if (s.scheduler === null) {
      s.scheduler = createTrailRepaintScheduler({
        paint: () => this.paint(s, port),
        intervalMs: this.o.repaintMs ?? CARD_REPAINT_MS,
        tickMs: this.o.repaintMs ?? CARD_REPAINT_MS,
        lastPaintAt: () => s.lastPaintAt,
        now: this.now,
        onError: (err) =>
          this.log.warn({ agent: this.o.agentName, error: err instanceof Error ? err.message : String(err) }, "research: card paint failed"),
      });
      s.scheduler.start();
    }
    s.scheduler.request();
    if (final || s.settled !== null) {
      // Let the settle paint land, then stop ticking.
      const stopAfter = setTimeout(() => s.scheduler?.stop(), (this.o.repaintMs ?? CARD_REPAINT_MS) * 2 + 50);
      unref(stopAfter);
    }
  }

  private async paint(s: Session, port: ResearchCardPort): Promise<void> {
    const channelId = s.origin.channelId;
    if (channelId === null) return;
    const snapshot: ResearchCardSnapshot = {
      session: this.view(s),
      interim: s.folded.length > 0 ? oneLine(s.folded[s.folded.length - 1]!, INTERIM_MAX_CHARS) : null,
      settled: s.settled ?? (s.writingSince !== null ? null : this.displaySettled(s)),
      ...(s.settled === null && s.writingSince !== null ? { writingSince: s.writingSince } : {}),
      reason: topReason([...s.tasks.values()].map((t) => t.reason))?.text ?? null,
      ...(s.journal ? { savedTo: s.journal.relativeDir } : {}),
      notes:
        s.settled === null && this.outstanding(s) > 0
          ? [
              ...(s.usageLimited ? ["limited to 1 near usage limit"] : []),
              ...(s.budgetReached ? ["budget reached"] : []),
            ]
          : [],
      now: this.now(),
    };
    s.lastPaintAt = this.now();
    if (s.cardMessageId === null) {
      if (s.cardPosting === null) {
        s.cardPosting = port.post(channelId, snapshot).then((id) => {
          s.cardMessageId = id;
          s.journal?.setCard(channelId, id);
        });
      }
      await s.cardPosting;
      return;
    }
    await port.edit(channelId, s.cardMessageId, snapshot);
  }

  private view(s: Session): ResearchCardSessionView {
    return {
      key: s.key,
      agentName: this.o.agentName,
      origin: s.origin,
      startedAt: s.startedAt,
      tasks: [...s.tasks.values()].map((t) => ({
        index: t.index,
        taskId: t.taskId,
        description: t.description,
        status: t.status,
        lastLine: t.lastLine,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private taskOf(f: Frame): { s: Session; t: TaskRec } | undefined {
    const id = str(f.task_id);
    if (id === null) return undefined;
    const s = this.taskIndex.get(id);
    const t = s?.tasks.get(id);
    return s && t ? { s, t } : undefined;
  }

  private indexTask(taskId: string, s: Session): void {
    this.taskIndex.set(taskId, s);
    while (this.taskIndex.size > TASK_INDEX_CAP) {
      const oldest = this.taskIndex.keys().next();
      if (oldest.done) break;
      this.taskIndex.delete(oldest.value);
    }
  }

  /**
   * The card settles as soon as nothing runs, whatever the mix of outcomes —
   * even while the session still waits for the parent's synthesis (the
   * 2026-09-25 prod card stuck at "Researching · 0 running").
   */
  private displaySettled(s: Session): ResearchCardSnapshot["settled"] {
    if (s.tasks.size === 0 || this.outstanding(s) > 0) return null;
    let at = s.startedAt;
    for (const t of s.tasks.values()) at = Math.max(at, t.endedAt ?? at);
    return { at, outcome: "done" };
  }

  /** After a session ends, refresh the resume index from disk (its journal is final). */
  private async refreshJournalIndex(s: Session): Promise<void> {
    const root = this.o.journalRoot;
    if (root === undefined || !s.journal) return;
    try {
      await s.journal.flushed();
      this.recentJournals = await listRecentJournals(root, this.now());
    } catch {
      // best-effort
    }
  }

  private completedCount(s: Session): number {
    let n = 0;
    for (const t of s.tasks.values()) if (t.status === "completed") n++;
    return n;
  }

  private outstanding(s: Session): number {
    let n = 0;
    for (const t of s.tasks.values()) if (t.status === "running") n++;
    return n;
  }

  /** Researchers running across every live session (the cap is global). */
  private runningCount(): number {
    let n = 0;
    for (const s of this.active.values()) n += this.outstanding(s);
    return n;
  }

  private stop(taskId: string): void {
    try {
      void Promise.resolve(this.o.stopTask(taskId)).catch(() => {
        /* best-effort */
      });
    } catch {
      // best-effort
    }
  }

  private sweepApprovals(): void {
    const cutoff = this.now() - APPROVAL_TTL_MS;
    for (const [id, a] of this.approvals) if (a.at < cutoff) this.approvals.delete(id);
  }

  private rememberLane(toolUseId: string): void {
    this.researcherLanes.delete(toolUseId);
    this.researcherLanes.add(toolUseId);
    while (this.researcherLanes.size > LANE_MEMORY_CAP) {
      const oldest = this.researcherLanes.values().next();
      if (oldest.done) break;
      this.researcherLanes.delete(oldest.value);
    }
  }
}

function unref(timer: ReturnType<typeof setTimeout>): void {
  (timer as { unref?: () => void }).unref?.();
}
