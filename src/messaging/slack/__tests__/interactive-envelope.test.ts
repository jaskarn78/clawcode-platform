/**
 * Phase 145 WS3 (Plan 07) — Slack interactive-envelope dispatch + the pure
 * interactive parser + the Block Kit builder.
 *
 * LANDMINE A (RESEARCH Pitfall 3): Socket Mode delivers a `block_actions`
 * click as a SEPARATE `type:"interactive"` envelope (no nested `event`), which
 * `SlackSocketMode.onFrame` previously ACK'd then DROPPED — only `events_api`
 * was dispatched. This suite proves:
 *   - onFrame dispatches a `type:"interactive"` envelope to the registered
 *     `onInteractive` handler (was dropped), still ACKing it first
 *   - events_api / hello / disconnect dispatch is unchanged (no regression)
 *   - slackInteractiveToNeutralAnswer parses payload.actions[] keyed on the
 *     issued promptId (null on a promptId mismatch — anti-forgery T-145-20) and
 *     surfaces payload.user.id for the allowlist check
 *   - buildSlackAskBlocks emits a valid blocks[] for ≤4 questions + labelled
 *     options (+ a multi-select element for multiSelect)
 *
 * Pure / synthetic — no live WebSocket.
 */
import { describe, it, expect, vi } from "vitest";
import { WebSocket } from "ws";
import { SlackSocketMode } from "../socket-mode.js";
import {
  slackInteractiveToNeutralAnswer,
  buildSlackAskBlocks,
  type SlackInteractivePayload,
} from "../interactive.js";
import type { NeutralQuestion } from "../../types.js";
import { logger } from "../../../shared/logger.js";

// ── A fake WebSocket that captures sends + lets the test drive onFrame ────────
function mkSocketMode() {
  const sock = new SlackSocketMode("xapp-t", logger);
  const sent: string[] = [];
  // Inject a fake open ws so onFrame's ACK path (readyState OPEN) runs.
  const fakeWs = {
    readyState: WebSocket.OPEN,
    send: (data: string) => sent.push(data),
  };
  (sock as unknown as { ws: unknown }).ws = fakeWs;
  // onFrame is private — reach it for synthetic frame injection.
  const onFrame = (raw: string) =>
    (sock as unknown as { onFrame: (d: Buffer) => void }).onFrame(Buffer.from(raw));
  return { sock, sent, onFrame };
}

describe("SlackSocketMode interactive-envelope dispatch (LANDMINE A)", () => {
  it("dispatches a type:'interactive' envelope to the onInteractive handler (was dropped)", () => {
    const { sock, onFrame } = mkSocketMode();
    const seen: SlackInteractivePayload[] = [];
    sock.onInteractive((p) => seen.push(p));

    const payload: SlackInteractivePayload = {
      type: "block_actions",
      user: { id: "U-OP" },
      actions: [{ action_id: "pp:PID1:q0", value: "opt-a" }],
    };
    onFrame(JSON.stringify({ type: "interactive", envelope_id: "E1", payload }));

    expect(seen).toHaveLength(1);
    expect(seen[0].user?.id).toBe("U-OP");
    expect(seen[0].actions?.[0]?.action_id).toBe("pp:PID1:q0");
  });

  it("ACKs the interactive envelope (envelope_id) BEFORE dispatch (no ACK regression)", () => {
    const { sock, sent, onFrame } = mkSocketMode();
    let ackSeenAtDispatch = false;
    sock.onInteractive(() => {
      // By the time the handler runs the ACK must already have been sent.
      ackSeenAtDispatch = sent.length === 1;
    });
    onFrame(
      JSON.stringify({
        type: "interactive",
        envelope_id: "E2",
        payload: { type: "block_actions", user: { id: "U" }, actions: [] },
      }),
    );
    expect(sent).toContain(JSON.stringify({ envelope_id: "E2" }));
    expect(ackSeenAtDispatch).toBe(true);
  });

  it("a throwing interactive handler is non-fatal (caught, no rethrow)", () => {
    const { sock, onFrame } = mkSocketMode();
    sock.onInteractive(() => {
      throw new Error("boom");
    });
    expect(() =>
      onFrame(
        JSON.stringify({
          type: "interactive",
          envelope_id: "E3",
          payload: { type: "block_actions", user: { id: "U" }, actions: [] },
        }),
      ),
    ).not.toThrow();
  });

  it("still dispatches events_api to the event handler (no regression)", () => {
    const { sock, onFrame } = mkSocketMode();
    const events: unknown[] = [];
    sock.onEvent((e) => events.push(e));
    onFrame(
      JSON.stringify({
        type: "events_api",
        envelope_id: "E4",
        payload: { event: { type: "message", channel: "C1", user: "U1", text: "hi", ts: "1.1" } },
      }),
    );
    expect(events).toHaveLength(1);
  });

  it("does NOT route events_api to the interactive handler (and vice-versa)", () => {
    const { sock, onFrame } = mkSocketMode();
    const events: unknown[] = [];
    const interactives: unknown[] = [];
    sock.onEvent((e) => events.push(e));
    sock.onInteractive((p) => interactives.push(p));

    onFrame(
      JSON.stringify({
        type: "events_api",
        envelope_id: "E5",
        payload: { event: { type: "message", channel: "C1", user: "U1", text: "hi", ts: "1.1" } },
      }),
    );
    onFrame(
      JSON.stringify({
        type: "interactive",
        envelope_id: "E6",
        payload: { type: "block_actions", user: { id: "U" }, actions: [] },
      }),
    );

    expect(events).toHaveLength(1);
    expect(interactives).toHaveLength(1);
  });

  it("hello + disconnect frames are not dispatched to either handler", () => {
    const { sock, onFrame } = mkSocketMode();
    const events: unknown[] = [];
    const interactives: unknown[] = [];
    sock.onEvent((e) => events.push(e));
    sock.onInteractive((p) => interactives.push(p));
    // Avoid the real reconnect timer on `disconnect`.
    vi.spyOn(sock as unknown as { reconnect: () => void }, "reconnect").mockImplementation(() => {});

    onFrame(JSON.stringify({ type: "hello" }));
    onFrame(JSON.stringify({ type: "disconnect", reason: "warning" }));

    expect(events).toHaveLength(0);
    expect(interactives).toHaveLength(0);
  });
});

describe("slackInteractiveToNeutralAnswer (parser + anti-forgery)", () => {
  const questions: readonly NeutralQuestion[] = [
    {
      id: "real-question-id-0",
      header: "Pick one",
      options: [
        { id: "opt-a", label: "A" },
        { id: "opt-b", label: "B" },
      ],
    },
    {
      id: "real-question-id-1",
      header: "Pick many",
      multiSelect: true,
      options: [
        { id: "x", label: "X" },
        { id: "y", label: "Y" },
        { id: "z", label: "Z" },
      ],
    },
  ];

  it("parses a single-select button action into a NeutralAnswers keyed by the real questionId", () => {
    const payload: SlackInteractivePayload = {
      type: "block_actions",
      user: { id: "U-OP" },
      actions: [{ action_id: "pp:PID1:q0", value: "opt-b" }],
    };
    const res = slackInteractiveToNeutralAnswer(payload, "PID1", questions);
    expect(res).not.toBeNull();
    expect(res!.userId).toBe("U-OP");
    expect(res!.answers.answers).toEqual([
      { questionId: "real-question-id-0", selectedOptionIds: ["opt-b"] },
    ]);
  });

  it("parses a multi-static-select action (selected_options[].value) for a multiSelect question", () => {
    const payload: SlackInteractivePayload = {
      type: "block_actions",
      user: { id: "U-OP" },
      actions: [
        {
          action_id: "pp:PID1:q1",
          selected_options: [{ value: "x" }, { value: "z" }],
        },
      ],
    };
    const res = slackInteractiveToNeutralAnswer(payload, "PID1", questions);
    expect(res).not.toBeNull();
    expect(res!.answers.answers).toEqual([
      { questionId: "real-question-id-1", selectedOptionIds: ["x", "z"] },
    ]);
  });

  it("returns null when the action_id promptId does NOT match the issued promptId (anti-forgery)", () => {
    const payload: SlackInteractivePayload = {
      type: "block_actions",
      user: { id: "U-OP" },
      actions: [{ action_id: "pp:WRONG:q0", value: "opt-a" }],
    };
    expect(slackInteractiveToNeutralAnswer(payload, "PID1", questions)).toBeNull();
  });

  it("ignores the Submit button action (no selection produced) but is not null", () => {
    const payload: SlackInteractivePayload = {
      type: "block_actions",
      user: { id: "U-OP" },
      actions: [{ action_id: "pp:PID1:__submit__" }],
    };
    const res = slackInteractiveToNeutralAnswer(payload, "PID1", questions);
    expect(res).not.toBeNull();
    expect(res!.isSubmit).toBe(true);
    expect(res!.answers.answers).toHaveLength(0);
  });

  it("returns null on a malformed action_id (wrong prefix / no tokens)", () => {
    const payload: SlackInteractivePayload = {
      type: "block_actions",
      user: { id: "U-OP" },
      actions: [{ action_id: "garbage", value: "opt-a" }],
    };
    expect(slackInteractiveToNeutralAnswer(payload, "PID1", questions)).toBeNull();
  });

  it("returns null when there is no user id (cannot allowlist-check)", () => {
    const payload: SlackInteractivePayload = {
      type: "block_actions",
      actions: [{ action_id: "pp:PID1:q0", value: "opt-a" }],
    };
    expect(slackInteractiveToNeutralAnswer(payload, "PID1", questions)).toBeNull();
  });

  it("drops out-of-token-range questions (q5 has no question) → null", () => {
    const payload: SlackInteractivePayload = {
      type: "block_actions",
      user: { id: "U-OP" },
      actions: [{ action_id: "pp:PID1:q5", value: "opt-a" }],
    };
    expect(slackInteractiveToNeutralAnswer(payload, "PID1", questions)).toBeNull();
  });
});

describe("buildSlackAskBlocks (Block Kit render)", () => {
  const four: readonly NeutralQuestion[] = [0, 1, 2, 3].map((i) => ({
    id: `q-${i}`,
    header: `Question ${i}`,
    text: i === 0 ? "body text" : undefined,
    options: [
      { id: `o-${i}-a`, label: `A${i}` },
      { id: `o-${i}-b`, label: `B${i}`, description: "blurb" },
    ],
  }));

  it("emits a section + an actions block per question, plus a Submit button", () => {
    const blocks = buildSlackAskBlocks("PID1", four);
    const sections = blocks.filter((b) => b.type === "section");
    const actions = blocks.filter((b) => b.type === "actions");
    expect(sections).toHaveLength(4);
    // 4 question action blocks + 1 submit action block.
    expect(actions).toHaveLength(5);
    // The submit button action_id encodes the promptId + the submit token.
    const submit = JSON.stringify(blocks[blocks.length - 1]);
    expect(submit).toContain("pp:PID1:__submit__");
  });

  it("encodes single-select options as buttons whose value is the optionId", () => {
    const blocks = buildSlackAskBlocks("PID1", [
      { id: "q-0", header: "Pick", options: [{ id: "opt-a", label: "A" }, { id: "opt-b", label: "B" }] },
    ]);
    const action = blocks.find((b) => b.type === "actions") as unknown as {
      elements: Array<{ type: string; action_id?: string; value?: string }>;
    };
    expect(action.elements.every((e) => e.type === "button")).toBe(true);
    expect(action.elements.map((e) => e.value)).toEqual(["opt-a", "opt-b"]);
    expect(action.elements[0].action_id).toBe("pp:PID1:q0");
  });

  it("encodes a multiSelect question as a single multi_static_select element", () => {
    const blocks = buildSlackAskBlocks("PID1", [
      {
        id: "q-0",
        header: "Pick many",
        multiSelect: true,
        options: [
          { id: "x", label: "X" },
          { id: "y", label: "Y" },
        ],
      },
    ]);
    const action = blocks.find((b) => b.type === "actions") as unknown as {
      elements: Array<{ type: string; action_id?: string; options?: unknown[] }>;
    };
    expect(action.elements).toHaveLength(1);
    expect(action.elements[0].type).toBe("multi_static_select");
    expect(action.elements[0].action_id).toBe("pp:PID1:q0");
    expect(action.elements[0].options).toHaveLength(2);
  });

  it("caps the batch at 4 questions", () => {
    const five: readonly NeutralQuestion[] = [0, 1, 2, 3, 4].map((i) => ({
      id: `q-${i}`,
      header: `Q${i}`,
      options: [{ id: `o${i}`, label: `L${i}` }],
    }));
    const blocks = buildSlackAskBlocks("PID1", five);
    expect(blocks.filter((b) => b.type === "section")).toHaveLength(4);
  });
});
