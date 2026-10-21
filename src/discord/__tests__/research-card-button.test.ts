import { describe, expect, it, vi } from "vitest";
import {
  handleResearchButton,
  RESEARCH_ENDED_TEXT,
  RESEARCH_NOT_YOURS_TEXT,
  RESEARCH_NOTHING_RUNNING_TEXT,
  RESEARCH_STOP_PROMPT,
  type ResearchButtonInteractionLike,
} from "../research-card-button.js";
import { encodeResearchStatusId, encodeResearchStopId, encodeResearchStopSelectId } from "../research-card.js";
import { makeResearchCardPort } from "../research-card-port.js";
import type { ResearchCardSessionView } from "../../manager/research-registry.js";

const KEY = "0a1b2c3d";
const SESSION: ResearchCardSessionView = {
  key: KEY,
  agentName: "personal",
  origin: { turnId: "discord:999", messageId: "999", channelId: "chan" },
  startedAt: 0,
  tasks: [
    { index: 0, taskId: "a1", description: "Weather", status: "completed", lastLine: null, startedAt: 0, endedAt: 60_000 },
    { index: 1, taskId: "a2", description: "Elevation", status: "running", lastLine: "Reading PDF", startedAt: 0, endedAt: null },
  ],
};

function interaction(customId: string, userId = "sam", authorId = "sam") {
  const replies: { content: string; flags?: number }[] = [];
  const i: ResearchButtonInteractionLike = {
    customId,
    user: { id: userId },
    channel: { messages: { fetch: vi.fn(async () => ({ author: { id: authorId } })) } },
    reply: vi.fn(async (o: { content: string; flags?: number }) => {
      replies.push(o);
    }),
  };
  return { i, replies };
}

function deps(stopOk = true) {
  const stopTask = vi.fn(async () => stopOk);
  return {
    stopTask,
    d: {
      getSessionHandle: vi.fn(() => ({ stopTask })),
      findSession: (k: string) => (k === KEY ? SESSION : undefined),
      now: () => 90_000,
      log: { info: vi.fn(), warn: vi.fn() },
    },
  };
}

describe("research card controls (999.173 polish)", () => {
  function selectInteraction(value: string, userId = "sam", authorId = "sam") {
    const updates: { content: string; components: unknown[] }[] = [];
    const base = interaction(encodeResearchStopSelectId(KEY), userId, authorId);
    const i: ResearchButtonInteractionLike = {
      ...base.i,
      values: [value],
      update: vi.fn(async (o: { content: string; components: unknown[] }) => {
        updates.push(o);
      }),
    };
    return { i, updates, replies: base.replies };
  }

  it("Status: ephemeral detail of every researcher", async () => {
    const { i, replies } = interaction(encodeResearchStatusId(KEY));
    await handleResearchButton(i, deps().d);
    expect(replies[0]!.flags).toBe(64);
    expect(replies[0]!.content).toContain("2. Elevation · running");
  });

  it("Stop…: ephemeral 'Stop which researcher?' with a select of the running ones + Stop all", async () => {
    const { i, replies } = interaction(encodeResearchStopId(KEY));
    await handleResearchButton(i, deps().d);
    const r = replies[0] as { content: string; flags?: number; components?: { components: { options: { value: string }[] }[] }[] };
    expect(r.flags).toBe(64);
    expect(r.content).toBe(RESEARCH_STOP_PROMPT);
    expect(r.components![0]!.components[0]!.options.map((o) => o.value)).toEqual(["1", "all"]);
  });

  it("Stop… when nothing runs says so", async () => {
    const { i, replies } = interaction(encodeResearchStopId(KEY));
    const d = deps().d;
    const done = { ...SESSION, tasks: SESSION.tasks.map((t) => ({ ...t, status: "completed" as const })) };
    await handleResearchButton(i, { ...d, findSession: () => done });
    expect(replies[0]!.content).toBe(RESEARCH_NOTHING_RUNNING_TEXT);
  });

  it("picking one stops exactly that researcher by TASK id and edits the ephemeral to one line", async () => {
    const { i, updates } = selectInteraction("1");
    const { d, stopTask } = deps();
    await handleResearchButton(i, d);
    expect(stopTask).toHaveBeenCalledTimes(1);
    expect(stopTask).toHaveBeenCalledWith("a2");
    expect(updates).toEqual([{ content: "Stopped: Elevation", components: [] }]);
  });

  it("Stop all stops every running researcher", async () => {
    const running = {
      ...SESSION,
      tasks: [
        ...SESSION.tasks,
        { index: 2, taskId: "a3", description: "Hotels", status: "running" as const, lastLine: null, startedAt: 0, endedAt: null },
      ],
    };
    const { i, updates } = selectInteraction("all");
    const { d, stopTask } = deps();
    await handleResearchButton(i, { ...d, findSession: () => running });
    expect((stopTask.mock.calls as unknown as string[][]).map((c) => c[0]).sort()).toEqual(["a2", "a3"]);
    expect(updates[0]!.content).toBe("Stopped all 2 researchers.");
  });

  it("Stop… and the picker are refused to anyone but the asker", async () => {
    const menu = interaction(encodeResearchStopId(KEY), "someone", "sam");
    const { d, stopTask } = deps();
    await handleResearchButton(menu.i, d);
    expect(menu.replies[0]!.content).toBe(RESEARCH_NOT_YOURS_TEXT);
    const pick = selectInteraction("1", "someone", "sam");
    await handleResearchButton(pick.i, d);
    expect(stopTask).not.toHaveBeenCalled();
    expect(pick.updates[0]!.content).toBe(RESEARCH_NOT_YOURS_TEXT);
  });

  it("a finished researcher, a malformed choice, or an ended research is a polite no-op", async () => {
    const finished = selectInteraction("0");
    const { d, stopTask } = deps();
    await handleResearchButton(finished.i, d);
    expect(finished.updates[0]!.content).toMatch(/already finished/);
    const junk = selectInteraction("x");
    await handleResearchButton(junk.i, d);
    expect(junk.updates[0]!.content).toMatch(/not recognised/);
    const gone = interaction(encodeResearchStopId("ffffffff"));
    await handleResearchButton(gone.i, d);
    expect(gone.replies[0]!.content).toBe(RESEARCH_ENDED_TEXT);
    expect(stopTask).not.toHaveBeenCalled();
  });

  it("never throws, even when the reply itself fails", async () => {
    const { i } = interaction(encodeResearchStatusId(KEY));
    (i.reply as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("expired"));
    await expect(handleResearchButton(i, deps().d)).resolves.toBeUndefined();
  });
});

describe("research card port (999.173)", () => {
  it("posts as a reply to the origin (no pings, no previews) and edits in place", async () => {
    const rest = { post: vi.fn(async () => ({ id: "card-9" })), patch: vi.fn(async () => ({})) };
    const port = makeResearchCardPort(rest);
    const snap = { session: SESSION, interim: null, settled: null, now: 30_000 };
    expect(await port.post("chan", snap)).toBe("card-9");
    const [route, opts] = rest.post.mock.calls[0]! as unknown as [string, { body: Record<string, unknown> }];
    expect(route).toBe("/channels/chan/messages");
    expect(opts.body).toMatchObject({
      allowed_mentions: { parse: [] },
      message_reference: { message_id: "999", fail_if_not_exists: false },
      flags: 4,
    });
    expect(String(opts.body.content)).toMatch(/^\*\*Researching · 1 running/);
    await port.edit("chan", "card-9", { ...snap, settled: { at: 60_000, outcome: "done" } });
    const [editRoute, editOpts] = rest.patch.mock.calls[0]! as unknown as [string, { body: { components: unknown[] } }];
    expect(editRoute).toBe("/channels/chan/messages/card-9");
    expect(editOpts.body.components).toEqual([]);
  });
});
