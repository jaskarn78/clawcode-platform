import { describe, it, expect } from "vitest";
import { buildActiveStateBlock } from "../builder.js";
import type { BuildActiveStateInput } from "../types.js";
import type { Tier2Facts } from "../../compact-extractors/types.js";

const fixedClock = () => new Date("2026-05-14T15:00:00Z");

function emptyFacts(overrides: Partial<Tier2Facts>): Tier2Facts {
  return Object.freeze({
    activeClients: Object.freeze(overrides.activeClients ?? []),
    decisions: Object.freeze(overrides.decisions ?? []),
    standingRulesChanged: Object.freeze(overrides.standingRulesChanged ?? []),
    inFlightTasks: Object.freeze(overrides.inFlightTasks ?? []),
    drivePathsTouched: Object.freeze(overrides.drivePathsTouched ?? []),
    criticalNumbers: Object.freeze(overrides.criticalNumbers ?? []),
  });
}

describe("buildActiveStateBlock — tier2 merge", () => {
  it("tier2 primaryClient wins over heuristic when present", () => {
    const input: BuildActiveStateInput = {
      recentOperatorMessages: ["look at clients/Acme/file please"],
      recentAgentTurns: [],
      agentName: "fin-client",
      clock: fixedClock,
      tier2Facts: emptyFacts({ activeClients: ["Acme"] }),
    };
    const block = buildActiveStateBlock(input);
    expect(block.primaryClient).toBe("Acme");
  });

  it("tier2 inFlightTasks merge with heuristic (dedupe + LLM first)", () => {
    const input: BuildActiveStateInput = {
      recentOperatorMessages: [],
      recentAgentTurns: [
        Object.freeze({
          id: "t1",
          sessionId: "s",
          turnIndex: 0,
          role: "assistant",
          content: "I'll send the memo at noon",
          tokenCount: null,
          channelId: null,
          discordUserId: null,
          discordMessageId: null,
          isTrustedChannel: false,
          origin: null,
          instructionFlags: null,
          createdAt: "2026-05-14T14:00:00Z",
        }),
      ],
      agentName: "fin-client",
      clock: fixedClock,
      tier2Facts: emptyFacts({
        inFlightTasks: [
          Object.freeze({ task: "Draft tranche memo", state: "blocked on legal" }),
        ],
      }),
    };
    const block = buildActiveStateBlock(input);
    expect(block.inFlightTasks.length).toBeGreaterThanOrEqual(2);
    expect(block.inFlightTasks[0]).toContain("Draft tranche memo");
  });

  it("tier2 absent → heuristic-only behavior (Plan 01 back-compat)", () => {
    const input: BuildActiveStateInput = {
      recentOperatorMessages: ["look at clients/Acme/file please"],
      recentAgentTurns: [],
      agentName: "fin-client",
      clock: fixedClock,
    };
    const block = buildActiveStateBlock(input);
    expect(block.primaryClient).toBe("Acme");
  });

  it("tier2 standingRulesChanged merged with today-filtered heuristic", () => {
    const input: BuildActiveStateInput = {
      recentOperatorMessages: ["rule: always cc client_a"],
      recentAgentTurns: [],
      agentName: "fin-client",
      clock: fixedClock,
      tier2Facts: emptyFacts({
        standingRulesChanged: [
          Object.freeze({
            rule: "never deploy on friday",
            changedAt: "2026-05-14T12:00:00Z",
          }),
        ],
      }),
    };
    const block = buildActiveStateBlock(input);
    expect(
      block.standingRulesAddedToday.some((r) =>
        r.includes("never deploy on friday"),
      ),
    ).toBe(true);
    expect(
      block.standingRulesAddedToday.some((r) => r.includes("always cc client_a")),
    ).toBe(true);
  });

  it("tier2 drivePathsTouched merged with heuristic clients/<name>/", () => {
    const input: BuildActiveStateInput = {
      recentOperatorMessages: [],
      recentAgentTurns: [
        Object.freeze({
          id: "t1",
          sessionId: "s",
          turnIndex: 0,
          role: "assistant",
          content: "Reading clients/Acme/notes.md",
          tokenCount: null,
          channelId: null,
          discordUserId: null,
          discordMessageId: null,
          isTrustedChannel: false,
          origin: null,
          instructionFlags: null,
          createdAt: "2026-05-14T14:00:00Z",
        }),
      ],
      agentName: "fin-client",
      clock: fixedClock,
      tier2Facts: emptyFacts({
        drivePathsTouched: ["clients/Acme/", "drive/research/"],
      }),
    };
    const block = buildActiveStateBlock(input);
    expect(block.driveFoldersTouched).toContain("clients/Acme/");
    expect(block.driveFoldersTouched).toContain("clients/Acme/");
    expect(block.driveFoldersTouched).toContain("drive/research/");
  });
});
