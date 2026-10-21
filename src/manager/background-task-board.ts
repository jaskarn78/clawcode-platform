/**
 * 999.178 — BackgroundTaskBoard: one per session handle.
 *
 * Makes the agent's own background work visible. The CLI runs background
 * Bash tasks (run_in_background, Monitor waits) and non-research subagents
 * detached from any turn; the daemon only knew about turns it dispatched, so
 * a turn that ended with "still downloading prices" left the channel silent
 * and "eta" answered "Nothing running" (fin-client 2026-09-26 08:53).
 *
 * From stream frames only (never model narration) it keeps:
 *   - the live set of background tasks, each tied to the Discord channel of
 *     the turn that started it;
 *   - a small "Working in the background" card per channel, posted once a
 *     task outlives its turn by CARD_DELAY_MS, edited as tasks end, settled
 *     when the last one ends;
 *   - typing while the agent runs a self-fired turn woken by one of these
 *     tasks (the "result is in, now doing the next step" gap).
 *
 * Research subagents are excluded — the ResearchTracker owns those.
 * Everything here is cosmetic: every port call is fire-and-forget and a
 * fault never reaches the stream.
 */

import { RESEARCHER_AGENT_TYPE } from "./research-subagents.js";
import { getLiveDiscordTurn } from "./research-registry.js";

/** A task must outlive its turn this long before the card appears (no flash for quick jobs). */
export const CARD_DELAY_MS = 15_000;
/** Card repaint cadence while tasks run (elapsed moves). */
export const CARD_REPAINT_MS = 15_000;
/** Discord typing lasts ~10 s. */
export const WAKE_TYPING_MS = 8_000;
/** Hard cap on wake-turn typing. */
export const WAKE_TYPING_MAX_MS = 15 * 60 * 1000;
/** A task_notification this recent explains a self-fired turn opening. */
const WAKE_ATTRIBUTION_MS = 30_000;
const DESCRIPTION_MAX = 80;
const LINE_MAX = 90;
const ENDED_KEEP = 20;

export type BackgroundTaskStatus = "running" | "completed" | "failed" | "stopped";

export type BackgroundTaskView = Readonly<{
  taskId: string;
  description: string;
  status: BackgroundTaskStatus;
  startedAt: number;
  endedAt: number | null;
  lastLine: string | null;
}>;

export type BackgroundCardSnapshot = Readonly<{
  tasks: readonly BackgroundTaskView[];
  /** When the card's first task started (elapsed). */
  startedAt: number;
  /** Set once every task on the card has ended. */
  settledAt: number | null;
  now: number;
}>;

export interface BackgroundCardPort {
  /** Post a card in `channelId`, replying to `replyTo` when known; resolves the message id. */
  post(channelId: string, replyTo: string | null, snap: BackgroundCardSnapshot): Promise<string>;
  edit(channelId: string, messageId: string, snap: BackgroundCardSnapshot): Promise<void>;
  typing(channelId: string): Promise<void>;
}

let port: BackgroundCardPort | undefined;
export function setBackgroundCardPort(p: BackgroundCardPort | undefined): void {
  port = p;
}

const boards = new Map<string, BackgroundTaskBoard>();
/** Register an agent's board (the status ping reads it); returns the unregister fn. */
export function registerBackgroundBoard(agentName: string, board: BackgroundTaskBoard): () => void {
  boards.set(agentName, board);
  return () => {
    if (boards.get(agentName) === board) boards.delete(agentName);
  };
}
export function getBackgroundBoard(agentName: string): BackgroundTaskBoard | undefined {
  return boards.get(agentName);
}
export function resetBackgroundBoardsForTests(): void {
  boards.clear();
  port = undefined;
}

type Frame = {
  readonly type?: string;
  readonly subtype?: string;
  readonly task_id?: unknown;
  readonly description?: unknown;
  readonly summary?: unknown;
  readonly status?: unknown;
  readonly subagent_type?: unknown;
  readonly tasks?: unknown;
  readonly origin?: { readonly kind?: unknown } | null;
};

interface TaskRec {
  taskId: string;
  description: string;
  status: BackgroundTaskStatus;
  startedAt: number;
  endedAt: number | null;
  lastLine: string | null;
  channelId: string | null;
  replyTo: string | null;
}

interface Card {
  channelId: string;
  replyTo: string | null;
  taskIds: string[];
  startedAt: number;
  messageId: string | null;
  posting: Promise<void> | null;
  settledAt: number | null;
  showTimer: ReturnType<typeof setTimeout> | null;
  repaint: ReturnType<typeof setInterval> | null;
}

export type BackgroundTaskBoardOptions = Readonly<{
  agentName: string;
  now?: () => number;
  cardPort?: () => BackgroundCardPort | undefined;
  cardDelayMs?: number;
  repaintMs?: number;
  typingMs?: number;
  typingMaxMs?: number;
}>;

function unref(t: { unref?: () => void } | null | undefined): void {
  t?.unref?.();
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

export class BackgroundTaskBoard {
  private readonly o: BackgroundTaskBoardOptions;
  private readonly now: () => number;
  private readonly tasks = new Map<string, TaskRec>();
  /** Researcher / excluded task ids (never shown). */
  private readonly ignored = new Set<string>();
  private readonly cards = new Map<string, Card>();
  /** Most recent notification for a tracked task: its channel, for wake typing. */
  private lastWake: { channelId: string; at: number } | null = null;
  private typingTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(opts: BackgroundTaskBoardOptions) {
    this.o = opts;
    this.now = opts.now ?? Date.now;
  }

  private port(): BackgroundCardPort | undefined {
    return (this.o.cardPort ?? (() => port))();
  }

  /** Stream frames: task_* / background_tasks_changed / result. Never throws. */
  observe(frame: unknown): void {
    if (this.disposed) return;
    try {
      const f = frame as Frame | null | undefined;
      if (f?.type === "result") {
        this.onTurnClosed();
        return;
      }
      if (f?.type !== "system") return;
      switch (f.subtype) {
        case "task_started":
          this.onStarted(f);
          return;
        case "task_progress":
        case "task_updated":
          this.onProgress(f);
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
    } catch {
      // cosmetic — never break the stream
    }
  }

  /** Running tasks, oldest first (for the status ping). */
  running(): readonly BackgroundTaskView[] {
    return [...this.tasks.values()]
      .filter((t) => t.status === "running")
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((t) => this.view(t));
  }

  /**
   * Self-fired turn boundaries. A turn that opens right after one of our
   * tasks notified is the agent acting on that result: type in the task's
   * channel until the turn closes.
   */
  setSelfFiredTurnOpen(open: boolean): void {
    if (this.disposed) return;
    if (!open) {
      this.stopTyping();
      return;
    }
    const wake = this.lastWake;
    this.lastWake = null;
    if (wake === null || this.now() - wake.at > WAKE_ATTRIBUTION_MS) return;
    this.startTyping(wake.channelId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopTyping();
    for (const c of this.cards.values()) this.clearCardTimers(c);
    this.cards.clear();
  }

  // ---------------------------------------------------------------------------

  private onStarted(f: Frame): void {
    const id = typeof f.task_id === "string" ? f.task_id : null;
    if (id === null) return;
    if (f.subagent_type === RESEARCHER_AGENT_TYPE) {
      this.ignored.add(id);
      return;
    }
    const origin = getLiveDiscordTurn(this.o.agentName);
    const desc = typeof f.description === "string" && f.description.trim().length > 0 ? f.description : "background task";
    this.tasks.set(id, {
      taskId: id,
      description: oneLine(desc, DESCRIPTION_MAX),
      status: "running",
      startedAt: this.now(),
      endedAt: null,
      lastLine: null,
      channelId: origin?.channelId ?? null,
      replyTo: origin?.messageId ?? null,
    });
    this.pruneEnded();
  }

  private onProgress(f: Frame): void {
    const t = typeof f.task_id === "string" ? this.tasks.get(f.task_id) : undefined;
    if (!t || t.status !== "running") return;
    if (typeof f.summary === "string" && f.summary.trim().length > 0) t.lastLine = oneLine(f.summary, LINE_MAX);
  }

  private onNotification(f: Frame): void {
    const t = typeof f.task_id === "string" ? this.tasks.get(f.task_id) : undefined;
    if (!t) return;
    const st = f.status === "failed" ? "failed" : f.status === "stopped" ? "stopped" : "completed";
    this.end(t, st);
    if (t.channelId !== null) this.lastWake = { channelId: t.channelId, at: this.now() };
  }

  /** REPLACE semantics: a running task missing from the live set has ended. */
  private onBackgroundSet(f: Frame): void {
    if (!Array.isArray(f.tasks)) return;
    const live = new Set(
      (f.tasks as { task_id?: unknown }[]).map((t) => t?.task_id).filter((id): id is string => typeof id === "string"),
    );
    for (const t of this.tasks.values()) if (t.status === "running" && !live.has(t.taskId)) this.end(t, "completed");
  }

  private end(t: TaskRec, status: BackgroundTaskStatus): void {
    if (t.status !== "running") return;
    t.status = status;
    t.endedAt = this.now();
    if (t.channelId === null) return;
    const c = this.cards.get(t.channelId);
    if (!c || !c.taskIds.includes(t.taskId)) return;
    if (c.taskIds.every((id) => this.tasks.get(id)?.status !== "running")) this.settleCard(c);
    else this.paint(c);
  }

  /**
   * A turn closed (daemon or self-fired). Tasks still running now have
   * outlived the turn that started them: give each channel a card, shown
   * after CARD_DELAY_MS so a quick job never flashes one.
   */
  private onTurnClosed(): void {
    for (const t of this.tasks.values()) {
      if (t.status !== "running" || t.channelId === null) continue;
      let c = this.cards.get(t.channelId);
      if (c && c.settledAt !== null) {
        this.clearCardTimers(c);
        this.cards.delete(t.channelId);
        c = undefined;
      }
      if (!c) {
        c = {
          channelId: t.channelId,
          replyTo: t.replyTo,
          taskIds: [],
          startedAt: t.startedAt,
          messageId: null,
          posting: null,
          settledAt: null,
          showTimer: null,
          repaint: null,
        };
        this.cards.set(t.channelId, c);
        const card = c;
        card.showTimer = setTimeout(() => this.showCard(card), this.o.cardDelayMs ?? CARD_DELAY_MS);
        unref(card.showTimer);
      }
      if (!c.taskIds.includes(t.taskId)) {
        c.taskIds.push(t.taskId);
        c.startedAt = Math.min(c.startedAt, t.startedAt);
        if (c.messageId !== null) this.paint(c);
      }
    }
  }

  private showCard(c: Card): void {
    c.showTimer = null;
    if (this.disposed || this.cards.get(c.channelId) !== c) return;
    if (!c.taskIds.some((id) => this.tasks.get(id)?.status === "running")) {
      this.cards.delete(c.channelId); // everything finished quietly — no card
      return;
    }
    this.paint(c);
    c.repaint = setInterval(() => this.paint(c), this.o.repaintMs ?? CARD_REPAINT_MS);
    unref(c.repaint);
  }

  private settleCard(c: Card): void {
    if (c.showTimer !== null) {
      // Never shown: nothing to settle.
      this.clearCardTimers(c);
      this.cards.delete(c.channelId);
      return;
    }
    c.settledAt = this.now();
    this.clearCardTimers(c);
    this.paint(c);
    this.cards.delete(c.channelId);
  }

  private clearCardTimers(c: Card): void {
    if (c.showTimer !== null) clearTimeout(c.showTimer);
    if (c.repaint !== null) clearInterval(c.repaint);
    c.showTimer = null;
    c.repaint = null;
  }

  private snapshot(c: Card): BackgroundCardSnapshot {
    const tasks = c.taskIds.map((id) => this.tasks.get(id)).filter((t): t is TaskRec => t !== undefined).map((t) => this.view(t));
    return { tasks, startedAt: c.startedAt, settledAt: c.settledAt, now: this.now() };
  }

  private paint(c: Card): void {
    const p = this.port();
    if (p === undefined) return;
    const snap = this.snapshot(c);
    const run = async (): Promise<void> => {
      if (c.messageId === null) {
        if (c.posting === null) {
          c.posting = p.post(c.channelId, c.replyTo, snap).then((id) => {
            c.messageId = id;
          });
          await c.posting;
          return;
        }
        await c.posting;
      }
      if (c.messageId !== null) await p.edit(c.channelId, c.messageId, this.snapshot(c));
    };
    void run().catch(() => undefined);
  }

  private startTyping(channelId: string): void {
    this.stopTyping();
    const p = this.port();
    if (p === undefined) return;
    const startedAt = this.now();
    const beat = (): void => {
      if (this.now() - startedAt >= (this.o.typingMaxMs ?? WAKE_TYPING_MAX_MS)) {
        this.stopTyping();
        return;
      }
      try {
        void p.typing(channelId).catch(() => undefined);
      } catch {
        // cosmetic
      }
    };
    beat();
    this.typingTimer = setInterval(beat, this.o.typingMs ?? WAKE_TYPING_MS);
    unref(this.typingTimer);
  }

  private stopTyping(): void {
    if (this.typingTimer !== null) clearInterval(this.typingTimer);
    this.typingTimer = null;
  }

  private view(t: TaskRec): BackgroundTaskView {
    return {
      taskId: t.taskId,
      description: t.description,
      status: t.status,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      lastLine: t.lastLine,
    };
  }

  /** Keep ended tasks only while a live card may still list them. */
  private pruneEnded(): void {
    const ended = [...this.tasks.values()].filter((t) => t.status !== "running");
    if (ended.length <= ENDED_KEEP) return;
    const onCard = new Set([...this.cards.values()].flatMap((c) => c.taskIds));
    for (const t of ended.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))) {
      if (this.tasks.size <= ENDED_KEEP) break;
      if (!onCard.has(t.taskId)) this.tasks.delete(t.taskId);
    }
  }
}
