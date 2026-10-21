/**
 * Phase 999.164 — the quick lane answers only standalone messages outside the
 * agent's domains. Fixtures are the live roster's MCP servers and skills
 * (2026-09-23) and the real messages from the first three hours live, so the tests
 * start from the populated world the router actually meets.
 */
import { describe, expect, it } from "vitest";
import {
  compileTaskTopics,
  renderDomainDigest,
  renderQuickLaneMap,
  resolveAgentDomains,
  routeQuickLane,
  type AgentRoutingProfile,
} from "../fast-lane-routing.js";

const mcp = (...names: string[]) => names.map((name) => ({ name }));

const PERSONAL: AgentRoutingProfile = {
  name: "personal",
  mcpServers: mcp("brave-search", "playwright", "browserless", "google-workspace", "fal-ai", "smarthome", "strava", "agent-browser", "travel-mcp", "trainingpeaks", "mac-remote-node"),
  skills: ["discord-preview"],
};
const CLIENT_A_PERSONAL: AgentRoutingProfile = {
  name: "client-a-personal",
  mcpServers: mcp("google-workspace-client-a", "brave-search", "playwright", "browserless", "fal-ai", "agent-browser", "travel-mcp", "patchright", "strava-coach", "garmin-coach", "health-db", "transcribe", "trainingpeaks"),
  skills: ["trip-planner", "discord-preview", "shopping-research", "meal-log", "adaptive-coaching", "estate-planning-docs"],
};
const PROJECTS: AgentRoutingProfile = {
  name: "projects",
  mcpServers: mcp("brave-search", "playwright", "browserless", "google-workspace", "fal-ai", "acme-db", "agent-browser", "whatsapp", "reddit", "mac-remote-node"),
  skills: ["discord-preview", "reelforge", "new-reel-broll", "whatsapp-send"],
};
const SHOPPING: AgentRoutingProfile = {
  name: "shopping",
  mcpServers: mcp("playwright-shopping", "brave-search", "1password"),
  skills: ["shopping-order-card", "shopping-watchlist", "shopping-price-compare", "discord-preview", "shopping-site-playbooks", "shopping-checkout"],
};
const ADMIN: AgentRoutingProfile = {
  name: "Admin Clawdy",
  mcpServers: mcp("mac-remote-node", "finnhub", "acme-db", "brave-search", "playwright", "google-workspace", "fal-ai", "browserless", "acme-content", "smarthome", "agent-browser"),
  skills: ["fleet-brief", "discord-preview", "kronos-forecast"],
  admin: true,
};

const route = (profile: AgentRoutingProfile, text: string, isReply = false) =>
  routeQuickLane({ text, isReply, domains: resolveAgentDomains(profile), taskTopics: compileTaskTopics(profile.taskTopics) });

describe("the messages the quick lane got wrong on 2026-09-23 now take the task lane, before any bridge call", () => {
  it("personal: the running question and its follow-up", () => {
    expect(route(PERSONAL, "Should I add more miles to today’s run?")).toMatchObject({ lane: "task", rule: "personal" });
    expect(route(PERSONAL, "You tell me")).toMatchObject({ lane: "task", rule: "context" });
    expect(route(PERSONAL, "Can you check if I can add additional miles to today’s run?")).toMatchObject({ lane: "task" });
  });
  it("nudges and bare references on Admin Clawdy and projects", () => {
    expect(route(ADMIN, "?")).toMatchObject({ lane: "task", rule: "context" });
    expect(route(ADMIN, "This")).toMatchObject({ lane: "task", rule: "context" });
    expect(route(PROJECTS, "?")).toMatchObject({ lane: "task", rule: "context" });
    expect(route(PROJECTS, "Could you start another Claude code tmux session for me on oc server under workspace coding?")).toMatchObject({ lane: "task" });
  });
  it("client-a-personal: today's workout", () => {
    expect(route(CLIENT_A_PERSONAL, "what's the workout for today")).toMatchObject({ lane: "task" });
  });
});

describe("999.174 — follow-ups that point at options the agent listed earlier take the task lane", () => {
  it("#shopping 2026-09-23: the comparison follow-up the quick lane answered with \"I don't have that comparison\"", () => {
    expect(route(SHOPPING, "whats the height difference between option 1 and 2?")).toMatchObject({ lane: "task", rule: "context", matched: "option 1 and 2" });
  });
  it("option, number and ordinal references, on both shopping agents", () => {
    for (const profile of [SHOPPING, CLIENT_A_PERSONAL]) {
      for (const m of [
        "How much heavier is option 2?",
        "Option b or c, which is quieter?",
        "Is #2 lighter than #3?",
        "how tall is the second one",
        "which of those two is wider",
        "What's the width difference between 1 and 3?",
        "Do both of them come in black?",
        "Does number 3 fit a 77mm cooler?",
        "Would the latter one fit in a backpack?",
      ]) {
        expect(route(profile, m), m).toMatchObject({ lane: "task", rule: "context" });
      }
    }
  });
  it("the reference rule is universal: it points at state, not at a domain", () => {
    expect(route(PROJECTS, "Is option 3 faster to build?")).toMatchObject({ lane: "task", rule: "context" });
  });
  it("words that merely contain the shapes stay quick", () => {
    for (const m of [
      "What is an option in finance?",
      "Is optional chaining in ES2020?",
      "What does C# compile to?",
      "How many ounces in a cup?",
      "What are the three branches of government?",
      "Who fought in the two world wars?",
      "Is the first one to reach the summit remembered?",
      "Between 1 and 10, how spicy is a jalapeño?",
      // Code-review probes (2026-09-24): ordinary questions a fleet-wide rule must not take.
      "Is a call option a derivative?",
      "What song was #1 in 1985?",
      "Who has the most #1 hits?",
      "Was Brosnan the first choice for the role?",
      "What other options are there besides chemo?",
      "What's in Chanel No. 5?",
      "What happened between the two world wars?",
      "Who was the second one to walk on the moon?",
      "Between 1 and 9, how hot is a habanero?",
    ]) {
      expect(route(PROJECTS, m), m).toEqual({ lane: "quick", rule: "open" });
    }
  });
});

describe("domains are per agent", () => {
  it("personal owns training via Strava and TrainingPeaks", () => {
    const training = resolveAgentDomains(PERSONAL).find((d) => d.id === "training");
    expect(training?.sources).toEqual(["strava", "trainingpeaks"]);
    expect(resolveAgentDomains(PERSONAL).map((d) => d.id)).toEqual(["training", "calendar-email", "home", "travel", "mac", "media", "web", "systems"]);
  });
  it("client-a-personal owns food and body data through health-db, garmin-coach and meal-log", () => {
    const health = resolveAgentDomains(CLIENT_A_PERSONAL).find((d) => d.id === "health");
    expect(health?.sources).toEqual(["garmin-coach", "health-db", "skill:meal-log", "skill:adaptive-coaching"]);
  });
  it("Admin Clawdy owns the fleet by being admin, markets through finnhub/acme", () => {
    const ids = resolveAgentDomains(ADMIN).map((d) => d.id);
    expect(ids).toContain("fleet");
    expect(ids).toContain("markets");
    expect(ids).not.toContain("training");
  });
  it("the same impersonal question is task on the agent that owns the domain and quick elsewhere", () => {
    const q = "Is it smart to add mileage the week of a half marathon?";
    expect(route(PERSONAL, q)).toMatchObject({ lane: "task", rule: "domain", domain: "training" });
    expect(route(PROJECTS, q)).toEqual({ lane: "quick", rule: "open" });
  });
  it("food questions go to the agent with the meal log", () => {
    expect(route(CLIENT_A_PERSONAL, "How many calories are in a banana?")).toMatchObject({ lane: "task", rule: "domain", domain: "health" });
  });
  it("home and car questions go to the agents with smarthome", () => {
    expect(route(PERSONAL, "Is the Tesla charged?")).toMatchObject({ lane: "task", rule: "domain", domain: "home" });
    expect(route(ADMIN, "Is the Tesla charged?")).toMatchObject({ lane: "task", rule: "domain", domain: "home" });
  });
  it("operator task topics force the task lane", () => {
    const withTopics = { ...PERSONAL, taskTopics: ["Urban Cow", "CIM"] };
    expect(route(withTopics, "How hilly is the Urban Cow course?")).toMatchObject({ lane: "task", rule: "topic" });
    expect(compileTaskTopics([])).toBeNull();
    expect(compileTaskTopics(["a.b"])!.test("aXb")).toBe(false);
  });
});

describe("rules", () => {
  it("greetings, thanks and laughter are quick", () => {
    for (const m of ["thanks!", "Thank you clawdy", "good morning 🌞", "lol", "hi", "how are you?", "thanks again", "What's up?"]) {
      expect(route(PERSONAL, m)).toEqual({ lane: "quick", rule: "social" });
    }
  });
  it("a greeting with a question mark after a silence is a nudge", () => {
    expect(route(PERSONAL, "hello?")).toMatchObject({ lane: "task", rule: "context" });
  });
  it("a greeting plus content is not social", () => {
    expect(route(PERSONAL, "morning run done?")).toMatchObject({ lane: "task" });
  });
  it("confirmations, reactions and choices answer something — task", () => {
    for (const m of ["ok", "Yes", "do it", "👍", "2", "sounds good", "perfect thanks", "nope", "option b"]) {
      expect(route(PERSONAL, m)).toMatchObject({ lane: "task", rule: "answer" });
    }
  });
  it("messages that continue or point back are task", () => {
    for (const m of ["what about tomorrow?", "that's wrong", "And for 10k?", "it didn't work", "any update?", "??", "…"]) {
      expect(route(PROJECTS, m)).toMatchObject({ lane: "task", rule: "context" });
    }
  });
  it("a Discord reply is task — the quick lane never sees the replied-to message", () => {
    expect(route(PROJECTS, "Is a warning like that safe to ignore?", true)).toMatchObject({ lane: "task", rule: "reply" });
    expect(route(PROJECTS, "thanks!", true)).toEqual({ lane: "quick", rule: "social" });
  });
  it("explicit work keeps the v1 action rule", () => {
    expect(route(PROJECTS, "search for a good sushi place")).toMatchObject({ lane: "task", rule: "action" });
  });
  it("first person and anchors to now are task", () => {
    expect(route(PROJECTS, "What should we name the new repo?")).toMatchObject({ lane: "task", rule: "personal" });
    expect(route(PROJECTS, "Is the DMV busy on Sunday?")).toMatchObject({ lane: "task", rule: "temporal" });
    expect(route(PROJECTS, "Anything interesting happening at 5pm?")).toMatchObject({ lane: "task", rule: "temporal" });
  });
  it("live information is task on every agent", () => {
    expect(route(PROJECTS, "What's the weather in Sacramento?")).toMatchObject({ lane: "task", rule: "domain", domain: "web" });
  });
  it("standalone general knowledge stays quick", () => {
    for (const m of ["What's the capital of Australia?", "How many ounces in a cup?", "Who wrote Dune?", "What's 3/4 as a decimal?", "Explain what a haiku is"]) {
      expect(route(PERSONAL, m)).toEqual({ lane: "quick", rule: "open" });
    }
  });
});

describe("digest and map", () => {
  it("the prompt digest names what the full agent can see", () => {
    const digest = renderDomainDigest(resolveAgentDomains(PERSONAL));
    expect(digest).toContain("training, fitness & recovery data (strava, trainingpeaks)");
    expect(digest).toContain("- the web and live information");
  });
  it("the map says what the quick lane answers and what it never does", () => {
    const on = renderQuickLaneMap({ profile: PERSONAL, enabled: true, verificationEnforced: false });
    expect(on).toContain("### personal");
    expect(on).toContain("standalone general-knowledge questions");
    expect(on).toContain("training, fitness & recovery data (strava, trainingpeaks)");
    // 999.164 — no hard block for verification-enforced agents (the /clawcode-quick
    // toggle decides); the map says plainly that quick answers skip verification.
    const fin = renderQuickLaneMap({ profile: { ...PERSONAL, name: "fin-client" }, enabled: true, verificationEnforced: true });
    expect(fin).toContain("Quick lane answers");
    expect(fin).toContain("quick answers go out unverified");
    expect(renderQuickLaneMap({ profile: PERSONAL, enabled: false, verificationEnforced: true })).toContain("Quick lane:** off");
    expect(renderQuickLaneMap({ profile: PERSONAL, enabled: false, verificationEnforced: true })).not.toContain("unverified");
  });
});
