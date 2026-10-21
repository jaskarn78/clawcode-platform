/**
 * Phase 999.173 — per-agent research state shared across layers.
 *
 * WHY A MODULE-LEVEL REGISTRY (same reasoning as thinking-sink.ts): the
 * launch-gate hook is built in session-adapter before the handle exists, the
 * research tracker lives inside the handle, and the card's buttons are
 * dispatched from the slash-command handler. Threading references through
 * every layer would touch the whole dispatch path; each side registers here
 * under the agent name instead.
 *
 * Two slots per agent:
 *   - `liveTurn`: the Discord-user turn in flight RIGHT NOW (set by the handle
 *     for the duration of a `sendAndStream` whose turn id is a
 *     `discord:<snowflake>` id; null otherwise). The launch gate reads it to
 *     tell a real user request from a cron / IPC / ask-agent / self-fired turn.
 *   - `tracker`: the handle's ResearchTracker (for the gate's concurrency
 *     count and the card's Stop / Status buttons).
 *
 * Both setters are identity-checked on clear so a closing handle can never
 * wipe a successor's registration.
 */

export type ResearchOrigin = Readonly<{
  /** The dispatch turn id, e.g. `discord:000000000000000118`. */
  turnId: string;
  /** The Discord message the user sent (the reply target for the synthesis). */
  messageId: string;
  /** The channel it was sent in; null when the turn carried none. */
  channelId: string | null;
  /** The user asked to resume / continue earlier research (resume context at launch). */
  resumeRequested?: boolean;
}>;

/** "resume research", "continue the research", "pick up the research where it stopped" … */
const RESUME_RE = /\b(resume|continue|pick up|carry on|finish)\b[^.\n]{0,40}\bresearch\b|\bresearch\b[^.\n]{0,20}\b(resume|continue)\b/i;

/**
 * Whether the USER's own text (inside the Discord `<channel …>` envelope, not
 * the injected memory / context around it) asks to resume research.
 */
export function asksToResumeResearch(message: string): boolean {
  const blocks = [...message.matchAll(/<channel source="discord"[^>]*>([\s\S]*?)<\/channel>/g)];
  const text = blocks.length > 0 ? blocks[blocks.length - 1]![1]! : message.slice(0, 500);
  return RESUME_RE.test(text);
}

/** What the gate and the card buttons need from a tracker. */
export type ToolCallCount = Readonly<{
  /** Tool calls this researcher has made, including this one. */
  task: number;
  /** Tool calls across all researchers of its request, including this one. */
  session: number;
  /** False when the task is unknown to the tracker (never started, or not a researcher). */
  known: boolean;
}>;

export interface ResearchTrackerPort {
  /** Resume context appended to a researcher's launch prompt (null = none). */
  resumeContextFor?(origin: ResearchOrigin): string | null;
  /** Current tool-call counts for a researcher task (does not count). */
  toolCallsFor?(taskId: string): ToolCallCount;
  /** Count one allowed researcher tool call; returns the new counts. */
  countToolCall?(taskId: string): ToolCallCount;
  /** A budget guard fired for this task's request (card header note). */
  noteBudgetReached?(taskId: string): void;
  /** Researchers running or approved-and-starting (all origins). */
  occupiedSlots(): number;
  /** Researchers running or approved-and-starting for ONE origin (Discord turn id). */
  occupiedSlotsFor(turnId: string): number;
  /**
   * Record an approved launch (the tool_use id) until its task_started arrives.
   * `usageLimited`: the usage guard reduced this launch (card header note).
   */
  noteApprovedLaunch(toolUseId: string, origin: ResearchOrigin, opts?: Readonly<{ usageLimited?: boolean }>): void;
  /** The card session a button belongs to, if still known. */
  sessionForKey(key: string): ResearchCardSessionView | undefined;
  /** The newest live research, for a status ping (null when none). */
  statusView?(): ResearchStatusView | null;
}

/** The live research, as a status ping reports it. */
export type ResearchStatusView = Readonly<{
  total: number;
  done: number;
  running: number;
  startedAt: number;
  /** Set while the synthesis turn is being written. */
  writingSince: number | null;
}>;

export type ResearchCardTaskView = Readonly<{
  index: number;
  taskId: string;
  description: string;
  status: "running" | "completed" | "failed" | "stopped" | "lost";
  lastLine: string | null;
  startedAt: number;
  endedAt: number | null;
}>;

export type ResearchCardSessionView = Readonly<{
  key: string;
  agentName: string;
  origin: ResearchOrigin;
  startedAt: number;
  tasks: readonly ResearchCardTaskView[];
}>;

type LiveTurn = Readonly<{ origin: ResearchOrigin; eligible: () => boolean }>;
const liveTurns = new Map<string, LiveTurn>();
const trackers = new Map<string, ResearchTrackerPort>();

const DISCORD_TURN_RE = /^discord:(\d{15,25})(?::|$)/;

/**
 * The originating Discord message id of a dispatch turn id, or null when the
 * turn did not come from a Discord user message (voice, cron, IPC, dashboard,
 * scheduler — anything without a `discord:<snowflake>` id).
 */
export function discordMessageIdOf(turnId: string | null | undefined): string | null {
  if (typeof turnId !== "string") return null;
  const m = DISCORD_TURN_RE.exec(turnId);
  return m ? m[1]! : null;
}

/**
 * Mark a Discord-user turn live for `agentName`. `eligible` is consulted at
 * gate time: the handle passes "no self-fired turn is open on the stream", so
 * a wake turn still running ahead of the queued user message cannot borrow
 * the user's turn to fan out.
 */
export function setLiveDiscordTurn(
  agentName: string,
  origin: ResearchOrigin,
  eligible: () => boolean = () => true,
): () => void {
  const rec: LiveTurn = { origin, eligible };
  liveTurns.set(agentName, rec);
  return () => {
    if (liveTurns.get(agentName) === rec) liveTurns.delete(agentName);
  };
}

export function getLiveDiscordTurn(agentName: string): ResearchOrigin | undefined {
  const rec = liveTurns.get(agentName);
  if (rec === undefined) return undefined;
  try {
    return rec.eligible() ? rec.origin : undefined;
  } catch {
    return undefined;
  }
}

export function registerResearchTracker(agentName: string, tracker: ResearchTrackerPort): () => void {
  trackers.set(agentName, tracker);
  return () => {
    if (trackers.get(agentName) === tracker) trackers.delete(agentName);
  };
}

export function getResearchTracker(agentName: string): ResearchTrackerPort | undefined {
  return trackers.get(agentName);
}

/** Find the card session a button key belongs to, across agents. */
export function findResearchSession(key: string): ResearchCardSessionView | undefined {
  for (const t of trackers.values()) {
    const s = t.sessionForKey(key);
    if (s) return s;
  }
  return undefined;
}

/** Test helper. */
export function resetResearchRegistryForTests(): void {
  liveTurns.clear();
  trackers.clear();
}
