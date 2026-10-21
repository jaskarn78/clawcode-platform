import { describe, it, expect } from "vitest";
import { buildActiveStateBlock } from "../builder.js";
import type { BuildActiveStateInput } from "../types.js";
import type { ConversationTurn } from "../../../memory/conversation-types.js";

function makeTurn(overrides: Partial<ConversationTurn> & {
  role: ConversationTurn["role"];
  content: string;
  createdAt: string;
}): ConversationTurn {
  return Object.freeze({
    id: overrides.id ?? "t",
    sessionId: overrides.sessionId ?? "s",
    turnIndex: overrides.turnIndex ?? 0,
    role: overrides.role,
    content: overrides.content,
    tokenCount: overrides.tokenCount ?? null,
    channelId: overrides.channelId ?? null,
    discordUserId: overrides.discordUserId ?? null,
    discordMessageId: overrides.discordMessageId ?? null,
    isTrustedChannel: overrides.isTrustedChannel ?? false,
    origin: overrides.origin ?? null,
    instructionFlags: overrides.instructionFlags ?? null,
    createdAt: overrides.createdAt,
  });
}

const fixedClock = () => new Date("2026-05-14T15:00:00Z");

describe("buildActiveStateBlock", () => {
  it("extracts primaryClient from clients/<name>/ token in operator messages", () => {
    const input: BuildActiveStateInput = {
      recentOperatorMessages: [
        "look at clients/Acme/AUM-report.xlsx please",
      ],
      recentAgentTurns: [],
      agentName: "fin-client",
      clock: fixedClock,
    };
    const block = buildActiveStateBlock(input);
    expect(block.primaryClient).toBe("Acme");
  });

  it("parses in-flight commitments from assistant turns (I'll / next: / TODO:)", () => {
    const input: BuildActiveStateInput = {
      recentOperatorMessages: [],
      recentAgentTurns: [
        makeTurn({
          role: "assistant",
          content: "I'll draft the email now.\nnext: send to Client A for review",
          createdAt: "2026-05-14T14:00:00Z",
        }),
        makeTurn({
          role: "assistant",
          content: "TODO: reconcile the AUM figures with the CRM",
          createdAt: "2026-05-14T14:30:00Z",
        }),
      ],
      agentName: "fin-client",
      clock: fixedClock,
    };
    const block = buildActiveStateBlock(input);
    expect(block.inFlightTasks.length).toBeGreaterThan(0);
    const joined = block.inFlightTasks.join(" | ");
    expect(joined).toMatch(/TODO: reconcile/);
    expect(joined).toMatch(/I'll draft the email|next: send to Client A/);
  });

  it("filters standingRulesAddedToday by today's date boundary (local)", () => {
    const yesterday = makeTurn({
      role: "user",
      content: "from now on, always cite the source",
      createdAt: "2026-05-13T12:00:00Z",
    });
    const today = makeTurn({
      role: "user",
      content: "rule: never email Client A after 8pm PT",
      createdAt: "2026-05-14T10:00:00Z",
    });
    const block = buildActiveStateBlock({
      recentOperatorMessages: [],
      recentAgentTurns: [yesterday, today],
      agentName: "x",
      clock: fixedClock,
    });
    const joined = block.standingRulesAddedToday.join(" | ");
    expect(joined).toMatch(/never email Client A/);
    expect(joined).not.toMatch(/cite the source/);
  });

  it("preserves last 3 operator messages verbatim, oldest-first", () => {
    const msgs = ["msg-1", "msg-2", "msg-3", "msg-4", "msg-5"];
    const block = buildActiveStateBlock({
      recentOperatorMessages: msgs,
      recentAgentTurns: [],
      agentName: "x",
      clock: fixedClock,
    });
    expect(block.lastOperatorMessages).toEqual(["msg-3", "msg-4", "msg-5"]);
  });

  it("returns a frozen, well-formed block on empty input without throwing", () => {
    const block = buildActiveStateBlock({
      recentOperatorMessages: [],
      recentAgentTurns: [],
      agentName: "x",
      clock: fixedClock,
    });
    expect(Object.isFrozen(block)).toBe(true);
    expect(block.primaryClient).toBeNull();
    expect(block.inFlightTasks).toEqual([]);
    expect(block.standingRulesAddedToday).toEqual([]);
    expect(block.driveFoldersTouched).toEqual([]);
    expect(block.lastOperatorMessages).toEqual([]);
    expect(block.lastAgentCommitments).toEqual([]);
    expect(block.generatedAt).toBe("2026-05-14T15:00:00.000Z");
  });

  it("caps total rendered fields under 50 lines", () => {
    const manyRules = Array.from({ length: 30 }, (_, i) =>
      makeTurn({
        role: "user",
        content: `rule: rule-${i}`,
        createdAt: "2026-05-14T01:00:00Z",
        id: `r-${i}`,
      }),
    );
    const manyAssistant = Array.from({ length: 30 }, (_, i) =>
      makeTurn({
        role: "assistant",
        content: `I'll do thing-${i}`,
        createdAt: "2026-05-14T02:00:00Z",
        id: `a-${i}`,
      }),
    );
    const manyFolders = makeTurn({
      role: "assistant",
      content: Array.from({ length: 20 }, (_, i) => `clients/C${i}/notes.md`).join("\n"),
      createdAt: "2026-05-14T03:00:00Z",
      id: "folders",
    });
    const ops = Array.from({ length: 20 }, (_, i) => `op-msg-${i}`);
    const block = buildActiveStateBlock({
      recentOperatorMessages: ops,
      recentAgentTurns: [...manyRules, ...manyAssistant, manyFolders],
      agentName: "x",
      clock: fixedClock,
    });
    const total =
      3 +
      block.inFlightTasks.length +
      block.standingRulesAddedToday.length +
      block.driveFoldersTouched.length +
      block.lastOperatorMessages.length +
      block.lastAgentCommitments.length;
    expect(total).toBeLessThanOrEqual(50);
  });

  it("captures drive folders via clients/<name>/ regex across recent turns", () => {
    const block = buildActiveStateBlock({
      recentOperatorMessages: [],
      recentAgentTurns: [
        makeTurn({
          role: "assistant",
          content: "Read clients/Acme/notes.md and clients/Beta/plan.md",
          createdAt: "2026-05-14T11:00:00Z",
        }),
      ],
      agentName: "x",
      clock: fixedClock,
    });
    expect(block.driveFoldersTouched).toEqual(
      expect.arrayContaining(["clients/Acme/", "clients/Beta/"]),
    );
  });
});
