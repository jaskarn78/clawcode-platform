import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import pino from "pino";
import {
  TodoMirror,
  renderTodoCard,
  parseTodoItems,
  MAX_RENDER_LENGTH,
  type TodoItem,
  type TodoCardEditor,
} from "../todo-mirror.js";

const log = pino({ level: "silent" });

function makeFixture(opts: { enabled?: boolean; minItems?: number; noEditor?: boolean } = {}) {
  const updates: string[] = [];
  let flushes = 0;
  let editorsCreated = 0;
  const editor: TodoCardEditor = {
    update: (t) => {
      updates.push(t);
    },
    flush: async () => {
      flushes += 1;
    },
  };
  const mirror = new TodoMirror({
    logger: log,
    makeEditor: () => {
      if (opts.noEditor) return null;
      editorsCreated += 1;
      return editor;
    },
    getConfig: (agent) =>
      // Unknown agents are DISABLED — this is the worker/dream suppression.
      agent === "projects"
        ? { enabled: opts.enabled ?? true, minItems: opts.minItems ?? 2 }
        : { enabled: false, minItems: 2 },
    idleTimeoutMs: 50,
  });
  return {
    mirror,
    updates,
    flushCount: () => flushes,
    editorCount: () => editorsCreated,
  };
}

const todos = (...statuses: TodoItem["status"][]): TodoItem[] =>
  statuses.map((status, i) => ({ content: `Step ${i + 1}`, status }));

describe("TodoMirror — one card, edited in place", () => {
  it("seeds ONE editor on the first qualifying list and edits it thereafter", () => {
    const f = makeFixture();
    f.mirror.onTodoUpdate("projects", todos("in_progress", "pending", "pending"));
    f.mirror.onTodoUpdate("projects", todos("completed", "in_progress", "pending"));
    f.mirror.onTodoUpdate("projects", todos("completed", "completed", "in_progress"));

    expect(f.editorCount()).toBe(1); // one message, three renders
    expect(f.updates).toHaveLength(3);
    expect(f.updates[0]).toContain("0/3");
    expect(f.updates[2]).toContain("2/3");
  });

  it("finalizes on turn complete and starts a NEW card for the next task", async () => {
    const f = makeFixture();
    f.mirror.onTodoUpdate("projects", todos("in_progress", "pending"));
    await f.mirror.onTurnComplete("projects");
    expect(f.flushCount()).toBe(1);
    expect(f.mirror.hasLiveCard("projects")).toBe(false);

    f.mirror.onTodoUpdate("projects", todos("in_progress", "pending"));
    expect(f.editorCount()).toBe(2); // fresh message, not an edit of the old record
  });

  it("idle TTL finalizes and evicts so the map cannot grow", async () => {
    const f = makeFixture();
    f.mirror.onTodoUpdate("projects", todos("in_progress", "pending"));
    await new Promise((r) => setTimeout(r, 120));
    expect(f.flushCount()).toBe(1);
    expect(f.mirror.hasLiveCard("projects")).toBe(false);
  });
});

describe("TodoMirror — the multi-step gate", () => {
  it("a single-item list never creates a card (minItems floor)", () => {
    const f = makeFixture();
    f.mirror.onTodoUpdate("projects", todos("in_progress"));
    expect(f.editorCount()).toBe(0);
  });

  it("but a LIVE card keeps rendering even if the list shrinks below the floor", () => {
    const f = makeFixture();
    f.mirror.onTodoUpdate("projects", todos("in_progress", "pending"));
    f.mirror.onTodoUpdate("projects", todos("completed"));
    expect(f.updates).toHaveLength(2);
  });

  it("disabled agents and UNKNOWN session names are silent", () => {
    const f = makeFixture();
    // Workflow worker session name — no config entry → disabled by construction.
    f.mirror.onTodoUpdate("projects-sub-a1b2c3", todos("in_progress", "pending"));
    // Unknown agent entirely.
    f.mirror.onTodoUpdate("dream-pass", todos("in_progress", "pending"));
    expect(f.editorCount()).toBe(0);
  });

  it("stays silent when no editable surface exists (no webhook, no bot edit)", () => {
    const f = makeFixture({ noEditor: true });
    f.mirror.onTodoUpdate("projects", todos("in_progress", "pending"));
    expect(f.updates).toHaveLength(0);
    // and does not retry-spam the factory on every update
    f.mirror.onTodoUpdate("projects", todos("completed", "pending"));
    expect(f.updates).toHaveLength(0);
  });

  it("a throwing editor is swallowed — the mirror is cosmetic", () => {
    const mirror = new TodoMirror({
      logger: log,
      makeEditor: () => ({
        update: () => {
          throw new Error("boom");
        },
        flush: async () => {},
      }),
      getConfig: () => ({ enabled: true, minItems: 2 }),
    });
    expect(() =>
      mirror.onTodoUpdate("projects", todos("in_progress", "pending")),
    ).not.toThrow();
  });
});

describe("renderTodoCard", () => {
  it("renders the three states distinctly with a progress header", () => {
    const out = renderTodoCard([
      { content: "Explore project context", status: "completed" },
      { content: "Propose approaches", status: "in_progress", activeForm: "Proposing approaches" },
      { content: "Write design doc", status: "pending" },
    ]);
    expect(out).toContain("📋 **Task plan** - 1/3");
    expect(out).toContain("☑ ~~Explore project context~~");
    expect(out).toContain("🔄 **Proposing approaches**"); // activeForm preferred mid-flight
    expect(out).toContain("☐ Write design doc");
  });

  it("flips the header to ✅ when everything is done", () => {
    const out = renderTodoCard([
      { content: "a", status: "completed" },
      { content: "b", status: "completed" },
    ]);
    expect(out).toContain("✅ **Task plan** - 2/2 done");
  });

  it("never exceeds the render cap — completed items collapse first", () => {
    const many: TodoItem[] = Array.from({ length: 40 }, (_, i) => ({
      content: `A fairly long descriptive step title number ${i} with detail`,
      status: i < 30 ? ("completed" as const) : ("pending" as const),
    }));
    const out = renderTodoCard(many);
    expect(out.length).toBeLessThanOrEqual(MAX_RENDER_LENGTH);
    expect(out).toContain("earlier step(s) done");
    // The pending tail — the actionable part — survives the collapse.
    expect(out).toContain("number 39");
  });

  it("contains no em dash (outbound formatter fixed-point discipline)", () => {
    const out = renderTodoCard(todos("completed", "in_progress", "pending"));
    expect(out).not.toContain("—");
  });
});

describe("parseTodoItems", () => {
  it("accepts the TodoWrite shape and defaults unknown statuses to pending", () => {
    const items = parseTodoItems([
      { content: "a", status: "completed" },
      { content: "b", status: "banana" },
      { content: "c", status: "in_progress", activeForm: "doing c" },
    ]);
    expect(items).toEqual([
      { content: "a", status: "completed" },
      { content: "b", status: "pending" },
      { content: "c", status: "in_progress", activeForm: "doing c" },
    ]);
  });

  it("rejects garbage rather than throwing", () => {
    expect(parseTodoItems(null)).toBeNull();
    expect(parseTodoItems("todos")).toBeNull();
    expect(parseTodoItems([])).toBeNull();
    expect(parseTodoItems([{ status: "completed" }])).toBeNull(); // no content
  });

  it("skips malformed entries but keeps the valid ones", () => {
    const items = parseTodoItems([{ content: "ok", status: "pending" }, 42, null, { x: 1 }]);
    expect(items).toHaveLength(1);
  });
});
