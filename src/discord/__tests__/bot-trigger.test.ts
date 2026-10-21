/**
 * 999.101 — bot-trigger allowlist decision + prompt wrapper + schema.
 */
import { describe, it, expect } from "vitest";
import {
  decideBotTrigger,
  buildBotTriggerPrompt,
  type BotTriggerConfig,
} from "../bot-trigger.js";

const STRAVA: BotTriggerConfig = {
  author: "Strava",
  cooldownMinutes: 15,
  enabled: true,
};

describe("decideBotTrigger", () => {
  const base = {
    agentName: "client-a-coach",
    authorUsername: "strava",
    authorId: "999",
    lastFiredAt: new Map<string, number>(),
    now: 1_000_000,
  };

  it("no config / empty config / disabled trigger → no-match", () => {
    expect(decideBotTrigger({ ...base, triggers: undefined }).action).toBe("no-match");
    expect(decideBotTrigger({ ...base, triggers: [] }).action).toBe("no-match");
    expect(
      decideBotTrigger({ ...base, triggers: [{ ...STRAVA, enabled: false }] }).action,
    ).toBe("no-match");
  });

  it("username match is case-insensitive; unknown author never fires", () => {
    expect(decideBotTrigger({ ...base, triggers: [STRAVA] }).action).toBe("fired");
    expect(
      decideBotTrigger({ ...base, triggers: [STRAVA], authorUsername: "GitHub" }).action,
    ).toBe("no-match");
  });

  it("authorId (when set) wins over username", () => {
    const byId = { ...STRAVA, authorId: "123" };
    // Right name, wrong id → no-match (id is the stricter contract).
    expect(decideBotTrigger({ ...base, triggers: [byId] }).action).toBe("no-match");
    expect(
      decideBotTrigger({
        ...base,
        triggers: [byId],
        authorUsername: "renamed-bot",
        authorId: "123",
      }).action,
    ).toBe("fired");
  });

  it("cooldown suppresses within the window and reopens after", () => {
    const fired = new Map([["client-a-coach:strava", 1_000_000]]);
    const during = decideBotTrigger({
      ...base,
      triggers: [STRAVA],
      lastFiredAt: fired,
      now: 1_000_000 + 14 * 60_000,
    });
    expect(during.action).toBe("cooldown");
    if (during.action === "cooldown") {
      expect(during.remainingMs).toBe(60_000);
    }
    expect(
      decideBotTrigger({
        ...base,
        triggers: [STRAVA],
        lastFiredAt: fired,
        now: 1_000_000 + 15 * 60_000,
      }).action,
    ).toBe("fired");
  });

  it("cooldown key is per-agent — another agent's stamp does not suppress", () => {
    const fired = new Map([["personal:strava", 1_000_000]]);
    expect(
      decideBotTrigger({ ...base, triggers: [STRAVA], lastFiredAt: fired }).action,
    ).toBe("fired");
  });
});

describe("buildBotTriggerPrompt", () => {
  it("includes content + embed text and the provenance label", () => {
    const p = buildBotTriggerPrompt({
      author: "Strava",
      content: "🚴 Morning Ride · 55.66 mi",
      embedTexts: ["", "Avg 18.2 mph"],
    });
    expect(p).toContain("[AUTOMATED EVENT]");
    expect(p).toContain("'Strava'");
    expect(p).toContain("55.66 mi");
    expect(p).toContain("Avg 18.2 mph");
    expect(p).toContain("verify data via your tools");
  });
});

describe("schema agents[].botTriggers", () => {
  it("fills defaults and rejects malformed entries", async () => {
    const { agentSchema } = await import("../../config/schema.js");
    const minimalAgent = {
      name: "a",
      workspace: "/tmp/a",
      botTriggers: [{ author: "Strava" }],
    };
    const parsed = agentSchema.parse(minimalAgent);
    expect(parsed.botTriggers?.[0]).toMatchObject({
      author: "Strava",
      cooldownMinutes: 15,
      enabled: true,
    });
    expect(() =>
      agentSchema.parse({ ...minimalAgent, botTriggers: [{ author: "" }] }),
    ).toThrow();
    expect(() =>
      agentSchema.parse({
        ...minimalAgent,
        botTriggers: [{ author: "x", cooldownMinutes: 0 }],
      }),
    ).toThrow();
  });
});
