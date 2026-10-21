import { describe, it, expect } from "vitest";
import {
  parseTodoFrame,
  parseProgressFrame,
  parseTurnCompleteFrame,
  type TodoFrame,
} from "../unix-socket-transport.js";

/**
 * 999.103 WS-1 — the TodoFrame rides the SAME hook.sock as turn_complete and
 * progress, discriminated by `type`. These pin (a) the round-trip, (b) that the
 * three parsers never claim each other's frames — the dispatch order in the
 * listener depends on that mutual exclusivity.
 */
describe("parseTodoFrame", () => {
  const valid: TodoFrame = {
    type: "todo",
    agent: "projects",
    session_id: "abc",
    todos: [{ content: "Step 1", status: "in_progress" }],
  };

  it("round-trips a valid frame through JSON (the wire format)", () => {
    const parsed = parseTodoFrame(JSON.parse(JSON.stringify(valid)));
    expect(parsed).not.toBeNull();
    expect(parsed!.agent).toBe("projects");
    expect(parsed!.todos).toHaveLength(1);
  });

  it("rejects a frame without an agent (identity is mandatory)", () => {
    expect(parseTodoFrame({ type: "todo", agent: "", todos: [] })).toBeNull();
    expect(parseTodoFrame({ type: "todo", todos: [] })).toBeNull();
  });

  it("rejects non-array todos", () => {
    expect(parseTodoFrame({ type: "todo", agent: "a", todos: "nope" })).toBeNull();
    expect(parseTodoFrame({ type: "todo", agent: "a" })).toBeNull();
  });

  it("rejects garbage without throwing", () => {
    expect(parseTodoFrame(null)).toBeNull();
    expect(parseTodoFrame("todo")).toBeNull();
    expect(parseTodoFrame(42)).toBeNull();
  });

  it("mutual exclusivity: no parser claims another's frame", () => {
    const progress = { type: "progress", agent: "a", accumulated_text: "hi" };
    const complete = { type: "turn_complete", agent: "a", last_assistant_message: "done" };

    expect(parseTodoFrame(progress)).toBeNull();
    expect(parseTodoFrame(complete)).toBeNull();
    expect(parseProgressFrame(valid)).toBeNull();
    expect(parseTurnCompleteFrame(valid)).toBeNull();
  });
});
