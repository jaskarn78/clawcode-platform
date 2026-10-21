/**
 * 999.103 WS-1 — live TodoWrite checklist mirrored into an agent's channel.
 *
 * Claude Code sessions maintain a todo list via the built-in TodoWrite tool on
 * multi-step tasks. This module mirrors that list into ONE Discord message per
 * task, edited in place as items get checked off — the same experience the
 * Claude Code UI gives, in the agent's channel.
 *
 * THE TRIGGER IS THE TOOL. The model only reaches for TodoWrite on multi-step
 * work (its own system prompt says so), so mirror-on-TodoWrite IS the
 * multi-step discriminator. No classifier. The `minItems` floor (default 2)
 * keeps a degenerate single-item list from spawning a card.
 *
 * Modeled on `AutoIngestProgress` (src/manager/auto-ingest-progress.ts), the
 * proven edit-in-place shape: DI'd editor, pure logic, seed-once, best-effort
 * edits, idle-finalize timer.
 *
 * Invariants:
 *  - EDIT-ONLY. One card per task; every update is an edit. Terminal state is
 *    an edit too (Discord edits don't push-notify — the anti-flood choice).
 *  - COSMETIC. This module never touches delivery truth (pendingReplies / ack /
 *    turn_complete). It renders, nothing else. Same contract the progress
 *    stream pins in unix-socket-transport.ts:283-285.
 *  - The card owns its OWN message id (inside its own editor closure) — never
 *    the prose streamer's. The progress plumbing is single-slot
 *    (agent-channel-bridge.ts:166); this deliberately does not go near it.
 *  - Self-capped render: `sendReturningId` does NOT chunk — anything over 2000
 *    chars is silently truncated at the webhook (webhook-manager.ts:107-112),
 *    so the renderer stays under MAX_RENDER_LENGTH by collapsing completed
 *    items, never by mid-line truncation.
 */

import type { Logger } from "pino";

/** One TodoWrite item, as the tool's input carries it. */
export interface TodoItem {
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed";
  /** Present-continuous label ("Running tests"); optional in the tool input. */
  readonly activeForm?: string;
}

/**
 * Editor surface — `ProgressiveMessageEditor` satisfies this structurally
 * (same contract as AutoIngestProgress.ProgressEditor). NOTE: `flush()` takes
 * no argument — it sends the LATEST `update()` text, so a final render must
 * `update(text)` THEN `flush()`.
 */
export interface TodoCardEditor {
  update(text: string): void;
  flush(): Promise<void>;
}

export interface TodoMirrorAgentConfig {
  readonly enabled: boolean;
  readonly minItems: number;
}

export type TodoMirrorDeps = {
  readonly logger: Logger;
  /**
   * Editor factory for one card. Returns null when the agent has no editable
   * surface (no webhook and no bot-direct edit) — the mirror then stays silent
   * for that agent. Called at card creation, once per card.
   */
  readonly makeEditor: (agent: string) => TodoCardEditor | null;
  /**
   * Live config lookup. An UNKNOWN agent name must return `{enabled: false}` —
   * that is what suppresses workflow-worker sessions (`<parent>-sub-<id>`),
   * dream sessions and every other synthetic session name for free: they have
   * no config entry, so they are disabled by construction.
   */
  readonly getConfig: (agent: string) => TodoMirrorAgentConfig;
  /** Idle finalize / TTL window. Default 10 min (a task can pause on a tool). */
  readonly idleTimeoutMs?: number;
  readonly now?: () => number;
};

/** Keep well under Discord's 2000 hard cap (sendReturningId truncates, silently). */
export const MAX_RENDER_LENGTH = 1800;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
const TAG = "todo-mirror";

/** Per-agent live card. */
type Card = {
  readonly editor: TodoCardEditor;
  items: readonly TodoItem[];
  finalized: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

/** Defensive bound on items rendered — TodoWrite lists are humanly short. */
const MAX_ITEMS = 50;

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/**
 * Render the checklist. Pure; exported for tests.
 *
 * Over-budget lists collapse their OLDEST completed items into one summary
 * line first (they carry the least information), then clip pending tails.
 */
export function renderTodoCard(items: readonly TodoItem[]): string {
  const total = items.length;
  const done = items.filter((i) => i.status === "completed").length;
  const allDone = done === total && total > 0;

  const header = allDone
    ? `✅ **Task plan** - ${done}/${total} done`
    : `📋 **Task plan** - ${done}/${total}`;

  const lines: string[] = [];
  for (const item of items.slice(0, MAX_ITEMS)) {
    // in_progress renders the activeForm when present - "Running tests" reads
    // better mid-flight than the imperative "Run tests".
    if (item.status === "completed") {
      lines.push(`☑ ~~${clip(item.content, 90)}~~`);
    } else if (item.status === "in_progress") {
      lines.push(`🔄 **${clip(item.activeForm ?? item.content, 90)}**`);
    } else {
      lines.push(`☐ ${clip(item.content, 90)}`);
    }
  }
  if (items.length > MAX_ITEMS) lines.push(`… +${items.length - MAX_ITEMS} more`);

  // Collapse oldest completed lines until the render fits.
  let out = [header, ...lines].join("\n");
  if (out.length > MAX_RENDER_LENGTH) {
    let collapsed = 0;
    while (out.length > MAX_RENDER_LENGTH && lines.length > 1) {
      const idx = lines.findIndex((l) => l.startsWith("☑"));
      if (idx === -1) break;
      lines.splice(idx, 1);
      collapsed += 1;
      out = [header, `☑ ~~… ${collapsed} earlier step(s) done~~`, ...lines].join("\n");
    }
    // Last resort (pathological single lines): hard trim at a line boundary.
    if (out.length > MAX_RENDER_LENGTH) {
      out = out.slice(0, MAX_RENDER_LENGTH);
      const lastNl = out.lastIndexOf("\n");
      if (lastNl > 0) out = out.slice(0, lastNl);
    }
  }
  return out;
}

/** Lenient validation of a TodoWrite `tool_input.todos` payload. */
export function parseTodoItems(raw: unknown): TodoItem[] | null {
  if (!Array.isArray(raw)) return null;
  const out: TodoItem[] = [];
  for (const entry of raw.slice(0, MAX_ITEMS * 2)) {
    if (typeof entry !== "object" || entry === null) continue;
    const o = entry as Record<string, unknown>;
    if (typeof o.content !== "string" || o.content.trim() === "") continue;
    const status =
      o.status === "in_progress" || o.status === "completed" ? o.status : "pending";
    out.push({
      content: o.content.slice(0, 500),
      status,
      ...(typeof o.activeForm === "string" ? { activeForm: o.activeForm.slice(0, 500) } : {}),
    });
  }
  return out.length > 0 ? out : null;
}

export class TodoMirror {
  private readonly cards = new Map<string, Card>();
  private readonly idleTimeoutMs: number;

  constructor(private readonly deps: TodoMirrorDeps) {
    this.idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  /**
   * A TodoWrite call was observed for `agent`. Creates the card on the first
   * qualifying list, edits it on every later one. Best-effort throughout — a
   * mirror failure must never affect the turn.
   */
  onTodoUpdate(agent: string, rawTodos: unknown): void {
    try {
      const cfg = this.deps.getConfig(agent);
      if (!cfg.enabled) return;
      const items = parseTodoItems(rawTodos);
      if (!items) return;

      let card = this.cards.get(agent);

      // A fresh task after a finalized card starts a NEW card (new message):
      // the old one is a completed record, not a live surface.
      if (card?.finalized) {
        this.clearTimer(card);
        this.cards.delete(agent);
        card = undefined;
      }

      if (!card) {
        // The minItems floor gates card CREATION only. Once live, updates
        // always render (a list can legitimately shrink mid-task).
        if (items.length < cfg.minItems) return;
        const editor = this.deps.makeEditor(agent);
        if (!editor) {
          this.deps.logger.debug({ tag: TAG, agent }, "no editable surface - todo card skipped");
          return;
        }
        card = { editor, items, finalized: false, timer: null };
        this.cards.set(agent, card);
      } else {
        card.items = items;
      }

      card.editor.update(renderTodoCard(card.items));
      this.armIdleTimer(agent, card);
    } catch (err: unknown) {
      this.deps.logger.warn(
        { tag: TAG, agent, err: err instanceof Error ? err.message : String(err) },
        "todo mirror update failed (cosmetic - turn unaffected)",
      );
    }
  }

  /**
   * The agent's turn ended. Final-render + flush the live card, then retire it
   * so the next task gets a fresh message. No card → no-op.
   */
  async onTurnComplete(agent: string): Promise<void> {
    const card = this.cards.get(agent);
    if (!card || card.finalized) return;
    card.finalized = true;
    this.clearTimer(card);
    try {
      card.editor.update(renderTodoCard(card.items));
      await card.editor.flush();
    } catch (err: unknown) {
      this.deps.logger.warn(
        { tag: TAG, agent, err: err instanceof Error ? err.message : String(err) },
        "todo card finalize failed (cosmetic)",
      );
    }
  }

  /** Test/introspection: is there a live card for this agent? */
  hasLiveCard(agent: string): boolean {
    const c = this.cards.get(agent);
    return c !== undefined && !c.finalized;
  }

  private armIdleTimer(agent: string, card: Card): void {
    this.clearTimer(card);
    card.timer = setTimeout(() => {
      // Idle TTL: finalize AND evict so the map cannot grow unbounded — the
      // AutoIngestProgress lesson. Fire-and-forget by design.
      void this.onTurnComplete(agent).then(() => this.cards.delete(agent));
    }, this.idleTimeoutMs);
    card.timer.unref?.();
  }

  private clearTimer(card: Card): void {
    if (card.timer) {
      clearTimeout(card.timer);
      card.timer = null;
    }
  }
}

// ── Module-level sink (v2/SDK capture seam) ─────────────────────────────────
//
// The v2 block loop (persistent-session-handle.ts) is many layers below the
// daemon; threading a sink through four constructor signatures buys nothing
// over the established module-setter pattern (cf. configureHaikuRouting).
// The daemon sets this once at boot with a closure over its late-bound
// TodoMirror ref; the handle calls emitTodoUpdate per TodoWrite block.
// Null sink (tests, CLI tools importing the handle) → no-op.

let globalSink: ((agent: string, todos: unknown) => void) | null = null;

/** Daemon boot: route v2-path TodoWrite observations into the mirror. */
export function setGlobalTodoSink(
  fn: ((agent: string, todos: unknown) => void) | null,
): void {
  globalSink = fn;
}

/** v2 capture entry point — best-effort, never throws. */
export function emitTodoUpdate(agent: string, todos: unknown): void {
  try {
    globalSink?.(agent, todos);
  } catch {
    // Cosmetic path — a mirror failure must never break the message loop.
  }
}
