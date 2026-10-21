/**
 * Phase 89 Plan 01 Task 2 — unit tests for src/manager/restart-greeting.ts
 *
 * Covers the pure greeting helper module:
 *   - classifyRestart (crash-vs-clean signal reduction)
 *   - isForkAgent / isSubagentThread (name-suffix skip predicates)
 *   - sendRestartGreeting (main helper — all skip + happy paths)
 *   - truncation / cool-down / timeout behavior
 *
 * Maps to GREET-02 (fork/thread skip), GREET-03 (crash classifier),
 * GREET-04 (Haiku summary + 10s timeout), GREET-05 (dormancy + empty-state),
 * GREET-06 (webhook delivery + cool-down), GREET-10 (cool-down Map).
 *
 * All deps are DI'd: zero real SDK / Discord / filesystem calls.
 */

import { describe, it, expect, vi } from "vitest";
import type { Logger } from "pino";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type {
  ConversationSession,
  ConversationTurn,
} from "../../memory/conversation-types.js";
import {
  sendRestartGreeting,
  classifyRestart,
  isForkAgent,
  isSubagentThread,
  isApiErrorDominatedSession,
  PLATFORM_ERROR_RECOVERY_MESSAGE,
  buildRestartGreetingPrompt,
  buildCleanRestartEmbed,
  buildCrashRecoveryEmbed,
  CLEAN_EMBED_COLOR,
  CRASH_EMBED_COLOR,
  DESCRIPTION_MAX_CHARS,
  type SendRestartGreetingDeps,
  type WebhookSender,
  type GreetingOutcome,
} from "../restart-greeting.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date("2026-04-23T12:00:00Z").getTime();

function makeConfig(
  overrides: Partial<ResolvedAgentConfig> = {},
): ResolvedAgentConfig {
  return {
    name: "clawdy",
    workspace: "/tmp/clawdy",
    memoryPath: "/tmp/clawdy",
    channels: ["chan-1"],
    model: "sonnet",
    effort: "low",
    allowedModels: ["haiku", "sonnet", "opus"],
    greetOnRestart: true,
    greetCoolDownMs: 300_000,
    autoCompactAt: 0.7, // Phase 124 D-06
    memoryAutoLoad: true, // Phase 90 MEM-01
    memoryRetrievalTopK: 5, // Phase 90 MEM-03
    memoryScannerEnabled: true, // Phase 90 MEM-02
    memoryFlushIntervalMs: 900_000, // Phase 90 MEM-04
    memoryCueEmoji: "✅", // Phase 90 MEM-05
    autoIngestAttachments: false, // Phase 999.43 D-09
    ingestionPriority: "medium" as const, // Phase 999.43 D-01 Axis 1
    settingSources: ["project"], // Phase 100 GSD-02
    autoStart: true, // Phase 100 follow-up
    skills: [],
    soul: undefined,
    identity: undefined,
    memory: {
      compactionThreshold: 0.75,
      searchTopK: 10,
      consolidation: { enabled: true, weeklyThreshold: 7, monthlyThreshold: 4, schedule: "0 3 * * *" },
      decay: { halfLifeDays: 30, semanticWeight: 0.7, decayWeight: 0.3 },
      deduplication: { enabled: true, similarityThreshold: 0.85 },
    },
    schedules: [],
    heartbeat: {
      enabled: true,
      intervalSeconds: 60,
      checkTimeoutSeconds: 10,
      contextFill: { warningThreshold: 0.6, criticalThreshold: 0.75 },
    },
    skillsPath: "/tmp/skills",
    admin: false,
    sandbox: { enabled: false, allowRuntimeOp: false },
    subagentModel: undefined,
    threads: { idleTimeoutMinutes: 1440, maxThreadSessions: 10 },
    webhook: {
      displayName: "Clawdy",
      avatarUrl: "https://av/clawdy.png",
      webhookUrl: "https://discord.com/api/webhooks/123/abc",
    },
    reactions: true,
    mcpServers: [],
    slashCommands: [],
    ...overrides,
  };
}

function makeSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    id: "sess-abc",
    agentName: "clawdy",
    startedAt: new Date(FIXED_NOW - 7_200_000).toISOString(), // 2h ago
    endedAt: new Date(FIXED_NOW - 3_600_000).toISOString(), // 1h ago (not dormant)
    turnCount: 3,
    totalTokens: 300,
    summaryMemoryId: null,
    status: "ended",
    ...overrides,
  };
}

function makeTurn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
  return {
    id: "turn-1",
    sessionId: "sess-abc",
    turnIndex: 0,
    role: "user",
    content: "Hello",
    tokenCount: 10,
    channelId: "chan-1",
    discordUserId: null,
    discordMessageId: null,
    isTrustedChannel: true,
    origin: null,
    instructionFlags: null,
    createdAt: new Date(FIXED_NOW - 3_600_000).toISOString(),
    ...overrides,
  };
}

type StubStore = Readonly<{
  listRecentTerminatedSessions: (
    agentName: string,
    limit: number,
  ) => readonly ConversationSession[];
  getTurnsForSession: (
    sessionId: string,
    limit?: number,
  ) => readonly ConversationTurn[];
}>;

function stubStore(
  recentSessions: readonly ConversationSession[] = [],
  turnsBySession: Record<string, readonly ConversationTurn[]> = {},
): StubStore {
  return {
    listRecentTerminatedSessions: vi.fn((_name: string, _limit: number) => recentSessions),
    getTurnsForSession: vi.fn(
      (sessionId: string, _limit?: number) => turnsBySession[sessionId] ?? [],
    ),
  };
}

function stubLogger(): Logger {
  // Minimal Logger surface used by the helper — warn/info/debug/error only.
  return {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    // `child`/`trace`/`fatal`/`level` etc. not used — cast as Logger.
  } as unknown as Logger;
}

function stubWebhook(
  opts: {
    readonly messageId?: string;
    readonly hasWebhook?: boolean;
    readonly sendRejects?: Error;
  } = {},
): WebhookSender {
  const hasWebhook = opts.hasWebhook ?? true;
  const messageId = opts.messageId ?? "msg-id-123";
  const sendAsAgent = opts.sendRejects
    ? vi.fn().mockRejectedValue(opts.sendRejects)
    : vi.fn().mockResolvedValue(messageId);
  return {
    hasWebhook: vi.fn((_agentName: string) => hasWebhook),
    sendAsAgent,
  };
}

function makeDeps(
  overrides: Partial<SendRestartGreetingDeps> = {},
): SendRestartGreetingDeps {
  return {
    webhookManager: stubWebhook(),
    conversationStore: stubStore([makeSession()], { "sess-abc": [makeTurn()] }),
    summarize: vi.fn().mockResolvedValue("We were debugging the daemon."),
    now: () => FIXED_NOW,
    log: stubLogger(),
    coolDownState: new Map<string, number>(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure predicate tests (no DI needed)
// ---------------------------------------------------------------------------

describe("classifyRestart (GREET-03)", () => {
  it("returns 'clean' when prevConsecutiveFailures === 0", () => {
    expect(classifyRestart(0)).toBe("clean");
  });

  it("returns 'crash-suspected' when prevConsecutiveFailures === 1", () => {
    expect(classifyRestart(1)).toBe("crash-suspected");
  });

  it("returns 'crash-suspected' when prevConsecutiveFailures === 10", () => {
    expect(classifyRestart(10)).toBe("crash-suspected");
  });
});

describe("isForkAgent / isSubagentThread regex (GREET-02)", () => {
  it("isForkAgent('clawdy-fork-AbC123') returns true (6-char nanoid suffix)", () => {
    expect(isForkAgent("clawdy-fork-AbC123")).toBe(true);
  });

  it("isForkAgent('clawdy-forked') returns false (no nanoid suffix)", () => {
    expect(isForkAgent("clawdy-forked")).toBe(false);
  });

  it("isForkAgent('clawdy') returns false (no fork infix)", () => {
    expect(isForkAgent("clawdy")).toBe(false);
  });

  it("isSubagentThread('clawdy-sub-xYz456') returns true", () => {
    expect(isSubagentThread("clawdy-sub-xYz456")).toBe(true);
  });

  it("isSubagentThread('clawdy-subagent') returns false", () => {
    expect(isSubagentThread("clawdy-subagent")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sendRestartGreeting — main helper
// ---------------------------------------------------------------------------

describe("sendRestartGreeting — happy paths", () => {
  it("P1: sends clean-restart embed via sendAsAgent; color=blurple; cool-down written", async () => {
    const deps = makeDeps();
    const result: GreetingOutcome = await sendRestartGreeting(deps, {
      agentName: "clawdy",
      config: makeConfig(),
      restartKind: "clean",
    });
    expect(result).toEqual({ kind: "sent", messageId: "msg-id-123" });
    const sendSpy = deps.webhookManager.sendAsAgent as ReturnType<typeof vi.fn>;
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const [targetAgent, displayName, avatarUrl, embed] = sendSpy.mock.calls[0];
    expect(targetAgent).toBe("clawdy");
    expect(displayName).toBe("Clawdy");
    expect(avatarUrl).toBe("https://av/clawdy.png");
    // EmbedBuilder exposes .data for the serialized properties.
    expect(embed.data.color).toBe(CLEAN_EMBED_COLOR);
    expect(embed.data.description).toMatch(/debugging the daemon/);
    expect(embed.data.footer?.text).toBe("Back online");
    // Cool-down write-back.
    expect(deps.coolDownState.get("clawdy")).toBe(FIXED_NOW);
  });

  it("P2: crash-suspected uses amber color + crash footer", async () => {
    const deps = makeDeps();
    await sendRestartGreeting(deps, {
      agentName: "clawdy",
      config: makeConfig(),
      restartKind: "crash-suspected",
    });
    const sendSpy = deps.webhookManager.sendAsAgent as ReturnType<typeof vi.fn>;
    const embed = sendSpy.mock.calls[0][3];
    expect(embed.data.color).toBe(CRASH_EMBED_COLOR);
    expect(embed.data.footer?.text).toBe("Recovered after unexpected shutdown");
  });
});

describe("sendRestartGreeting — skip paths", () => {
  it("P3: greetOnRestart=false → skipped-disabled; sendAsAgent NOT called; cool-down NOT updated", async () => {
    const deps = makeDeps();
    const result = await sendRestartGreeting(deps, {
      agentName: "clawdy",
      config: makeConfig({ greetOnRestart: false }),
      restartKind: "clean",
    });
    expect(result).toEqual({ kind: "skipped-disabled" });
    expect(deps.webhookManager.sendAsAgent).not.toHaveBeenCalled();
    expect(deps.coolDownState.has("clawdy")).toBe(false);
  });

  it("P4: fork agent name → skipped-fork; no summarize call; no send", async () => {
    const deps = makeDeps();
    const result = await sendRestartGreeting(deps, {
      agentName: "clawdy-fork-AbC123",
      config: makeConfig({ name: "clawdy-fork-AbC123" }),
      restartKind: "clean",
    });
    expect(result).toEqual({ kind: "skipped-fork" });
    expect(deps.summarize).not.toHaveBeenCalled();
    expect(deps.webhookManager.sendAsAgent).not.toHaveBeenCalled();
  });

  it("P5: subagent-thread name → skipped-subagent-thread", async () => {
    const deps = makeDeps();
    const result = await sendRestartGreeting(deps, {
      agentName: "clawdy-sub-xYz456",
      config: makeConfig({ name: "clawdy-sub-xYz456" }),
      restartKind: "clean",
    });
    expect(result).toEqual({ kind: "skipped-subagent-thread" });
  });

  it("P6: config.channels.length === 0 → skipped-no-channel", async () => {
    const deps = makeDeps();
    const result = await sendRestartGreeting(deps, {
      agentName: "clawdy",
      config: makeConfig({ channels: [] }),
      restartKind: "clean",
    });
    expect(result).toEqual({ kind: "skipped-no-channel" });
  });

  it("P7: webhookManager.hasWebhook=false → skipped-no-webhook", async () => {
    const deps = makeDeps({
      webhookManager: stubWebhook({ hasWebhook: false }),
    });
    const result = await sendRestartGreeting(deps, {
      agentName: "clawdy",
      config: makeConfig(),
      restartKind: "clean",
    });
    expect(result).toEqual({ kind: "skipped-no-webhook" });
  });

  it("P8: last session endedAt 8 days ago → skipped-dormant with lastActivityMs", async () => {
    // The dormant candidate must carry turns so the loop picks it as
    // `lastSession`; otherwise the helper short-circuits into the Phase 90.1
    // minimal-embed branch BEFORE the dormancy check fires.
    const eightDaysAgo = FIXED_NOW - 8 * 24 * 3600_000;
    const dormantSession = makeSession({
      endedAt: new Date(eightDaysAgo).toISOString(),
    });
    const deps = makeDeps({
      conversationStore: stubStore([dormantSession], {
        "sess-abc": [makeTurn()],
      }),
    });
    const result = await sendRestartGreeting(deps, {
      agentName: "clawdy",
      config: makeConfig(),
      restartKind: "clean",
    });
    expect(result.kind).toBe("skipped-dormant");
    if (result.kind === "skipped-dormant") {
      expect(result.lastActivityMs).toBe(eightDaysAgo);
    }
  });

  it("P9: listRecentTerminatedSessions returns [] → skipped-empty-state", async () => {
    const deps = makeDeps({
      conversationStore: stubStore([]),
    });
    const result = await sendRestartGreeting(deps, {
      agentName: "clawdy",
      config: makeConfig(),
      restartKind: "clean",
    });
    expect(result).toEqual({ kind: "skipped-empty-state" });
  });

  it("P10: summarize hangs past 10s timeout → skipped-empty-state (no fallback greeting)", async () => {
    const hangingSummarize = vi.fn().mockImplementation(
      (_prompt: string, opts: { signal?: AbortSignal }) =>
        new Promise<string>((_, reject) => {
          opts.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
    );
    const deps = makeDeps({ summarize: hangingSummarize });
    const resultPromise = sendRestartGreeting(deps, {
      agentName: "clawdy",
      config: makeConfig(),
      restartKind: "clean",
      summaryTimeoutMs: 10, // fast for test determinism
    });
    const result = await resultPromise;
    expect(result).toEqual({ kind: "skipped-empty-state" });
    expect(deps.webhookManager.sendAsAgent).not.toHaveBeenCalled();
  });

  it("P11: summarize resolves with '' → skipped-empty-state", async () => {
    const deps = makeDeps({
      summarize: vi.fn().mockResolvedValue(""),
    });
    const result = await sendRestartGreeting(deps, {
      agentName: "clawdy",
      config: makeConfig(),
      restartKind: "clean",
    });
    expect(result).toEqual({ kind: "skipped-empty-state" });
  });

  it("P12: getTurnsForSession returns [] AND no summaryMemoryId → minimal-embed kind:sent", async () => {
    // Phase 90.1 hotfix relaxed D-11 to send a "no prior session to recap"
    // minimal embed instead of silently skipping; Phase 99-D added a
    // summaryMemoryId fallback before that branch fires. With no turns AND
    // no summaryMemoryId, the helper still ends up at the minimal-embed
    // branch — this test pins that the operator sees visible feedback
    // rather than a silent skip on a fully-empty agent.
    const deps = makeDeps({
      conversationStore: stubStore([makeSession()], { "sess-abc": [] }),
    });
    const result = await sendRestartGreeting(deps, {
      agentName: "clawdy",
      config: makeConfig(),
      restartKind: "clean",
    });
    expect(result.kind).toBe("sent");
    const sendAsAgent = (deps.webhookManager as unknown as {
      sendAsAgent: ReturnType<typeof vi.fn>;
    }).sendAsAgent;
    const embedArg = sendAsAgent.mock.calls[0]?.[3];
    expect(embedArg?.data?.description).toMatch(/no prior session to recap/);
  });

  it("P13: cool-down entry 4 min ago + coolDown=5 min → skipped-cool-down (lastGreetingAtMs populated)", async () => {
    const fourMinAgo = FIXED_NOW - 4 * 60 * 1000;
    const coolDownState = new Map<string, number>([["clawdy", fourMinAgo]]);
    const deps = makeDeps({ coolDownState });
    const result = await sendRestartGreeting(deps, {
      agentName: "clawdy",
      config: makeConfig(),
      restartKind: "clean",
    });
    expect(result.kind).toBe("skipped-cool-down");
    if (result.kind === "skipped-cool-down") {
      expect(result.lastGreetingAtMs).toBe(fourMinAgo);
    }
    expect(deps.webhookManager.sendAsAgent).not.toHaveBeenCalled();
  });

  it("P14: cool-down entry 6 min ago + coolDown=5 min → sends; cool-down updated to new now()", async () => {
    const sixMinAgo = FIXED_NOW - 6 * 60 * 1000;
    const coolDownState = new Map<string, number>([["clawdy", sixMinAgo]]);
    const deps = makeDeps({ coolDownState });
    const result = await sendRestartGreeting(deps, {
      agentName: "clawdy",
      config: makeConfig(),
      restartKind: "clean",
    });
    expect(result.kind).toBe("sent");
    expect(coolDownState.get("clawdy")).toBe(FIXED_NOW);
  });
});

describe("sendRestartGreeting — truncation + failure", () => {
  it("P15: summarize returns 600-char string → embed.data.description length === 500; ends with …", async () => {
    const longSummary = "x".repeat(600);
    const deps = makeDeps({
      summarize: vi.fn().mockResolvedValue(longSummary),
    });
    await sendRestartGreeting(deps, {
      agentName: "clawdy",
      config: makeConfig(),
      restartKind: "clean",
    });
    const sendSpy = deps.webhookManager.sendAsAgent as ReturnType<typeof vi.fn>;
    const embed = sendSpy.mock.calls[0][3];
    expect(embed.data.description).toHaveLength(DESCRIPTION_MAX_CHARS);
    expect(embed.data.description.endsWith("\u2026")).toBe(true);
  });

  it("P19: summarize returns 200-char string → embed.data.description length === 200 (no truncation)", async () => {
    const shortSummary = "y".repeat(200);
    const deps = makeDeps({
      summarize: vi.fn().mockResolvedValue(shortSummary),
    });
    await sendRestartGreeting(deps, {
      agentName: "clawdy",
      config: makeConfig(),
      restartKind: "clean",
    });
    const sendSpy = deps.webhookManager.sendAsAgent as ReturnType<typeof vi.fn>;
    const embed = sendSpy.mock.calls[0][3];
    expect(embed.data.description).toHaveLength(200);
    expect(embed.data.description.endsWith("\u2026")).toBe(false);
  });

  it("P18: sendAsAgent rejects → send-failed outcome with error message; cool-down NOT updated", async () => {
    const deps = makeDeps({
      webhookManager: stubWebhook({
        sendRejects: new Error("webhook 401 Unauthorized"),
      }),
    });
    const result = await sendRestartGreeting(deps, {
      agentName: "clawdy",
      config: makeConfig(),
      restartKind: "clean",
    });
    expect(result.kind).toBe("send-failed");
    if (result.kind === "send-failed") {
      expect(result.error).toBe("webhook 401 Unauthorized");
    }
    expect(deps.coolDownState.has("clawdy")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pure embed builders
// ---------------------------------------------------------------------------

describe("buildCleanRestartEmbed / buildCrashRecoveryEmbed", () => {
  it("buildCleanRestartEmbed sets color=0x5865F2 + footer='Back online'", () => {
    const embed = buildCleanRestartEmbed("Clawdy", undefined, "I'm back.");
    expect(embed.data.color).toBe(CLEAN_EMBED_COLOR);
    expect(embed.data.footer?.text).toBe("Back online");
  });

  it("buildCrashRecoveryEmbed sets color=0xFFCC00 + footer='Recovered after unexpected shutdown'", () => {
    const embed = buildCrashRecoveryEmbed("Clawdy", undefined, "Recovered.");
    expect(embed.data.color).toBe(CRASH_EMBED_COLOR);
    expect(embed.data.footer?.text).toBe("Recovered after unexpected shutdown");
  });
});

describe("buildRestartGreetingPrompt", () => {
  it("embeds the agent's webhook displayName + turn markdown + clean-restart phrasing", () => {
    const turns = [makeTurn({ role: "user", content: "Fix the bug." })];
    const prompt = buildRestartGreetingPrompt(turns, makeConfig(), "clean");
    expect(prompt).toContain("Clawdy");
    expect(prompt).toContain("Fix the bug.");
    expect(prompt).toContain("clean restart");
  });

  it("uses 'unexpected shutdown' phrasing for crash-suspected", () => {
    const prompt = buildRestartGreetingPrompt(
      [makeTurn()],
      makeConfig(),
      "crash-suspected",
    );
    expect(prompt).toContain("unexpected shutdown");
  });
});

// ---------------------------------------------------------------------------
// 2026-04-30 fix — API-error-dominated session detector + bypass
// ---------------------------------------------------------------------------

describe("isApiErrorDominatedSession", () => {
  it("returns false for empty turn list", () => {
    expect(isApiErrorDominatedSession([])).toBe(false);
  });

  it("returns false when all turns are normal content", () => {
    const turns = [
      makeTurn({ role: "user", content: "Hello, can you help me?" }),
      makeTurn({ role: "assistant", content: "Sure, what's up?" }),
      makeTurn({ role: "user", content: "Build me a thing." }),
    ];
    expect(isApiErrorDominatedSession(turns)).toBe(false);
  });

  it("returns true when ≥50% of turns match an API-error fingerprint", () => {
    const turns = [
      makeTurn({ role: "assistant", content: "Failed to authenticate. API Error: 403" }),
      makeTurn({ role: "assistant", content: "API Error: 529 overloaded_error" }),
      makeTurn({ role: "user", content: "Hello?" }),
    ];
    expect(isApiErrorDominatedSession(turns)).toBe(true);
  });

  it("detects 'Credit balance is too low' (the operator-observed false positive)", () => {
    const turns = [
      makeTurn({ role: "assistant", content: "Credit balance is too low" }),
      makeTurn({ role: "assistant", content: "Credit balance is too low" }),
    ];
    expect(isApiErrorDominatedSession(turns)).toBe(true);
  });

  it("detects permission_error verbatim Anthropic phrasing", () => {
    const turns = [
      makeTurn({
        role: "assistant",
        content: '{"type":"error","error":{"type":"permission_error","message":"not a member of the organization"}}',
      }),
    ];
    expect(isApiErrorDominatedSession(turns)).toBe(true);
  });

  it("returns false when only 1 of 3 turns is an error (below 50% threshold)", () => {
    const turns = [
      makeTurn({ role: "user", content: "Hello" }),
      makeTurn({ role: "assistant", content: "Working on it..." }),
      makeTurn({ role: "assistant", content: "Failed to authenticate. API Error: 403" }),
    ];
    expect(isApiErrorDominatedSession(turns)).toBe(false);
  });
});

describe("sendRestartGreeting — API-error-dominated session bypass", () => {
  it("uses verbatim PLATFORM_ERROR_RECOVERY_MESSAGE and skips Haiku when prior session is dominated by API errors", async () => {
    const errorTurns = [
      makeTurn({ role: "assistant", content: "Failed to authenticate. API Error: 403" }),
      makeTurn({ role: "assistant", content: "API Error: 529 overloaded_error" }),
      makeTurn({ role: "assistant", content: "Credit balance is too low" }),
    ];
    const summarizeSpy = vi.fn().mockResolvedValue("Haiku should NOT be called");
    const deps = makeDeps({
      conversationStore: stubStore([makeSession()], { "sess-abc": errorTurns }),
      summarize: summarizeSpy,
    });

    const result = await sendRestartGreeting(deps, {
      agentName: "clawdy",
      config: makeConfig(),
      restartKind: "crash-suspected",
    });

    expect(result.kind).toBe("sent");
    expect(summarizeSpy).not.toHaveBeenCalled();
    // Webhook send was called with an embed whose description is the verbatim recovery message
    const sendAsAgent = (deps.webhookManager as unknown as {
      sendAsAgent: ReturnType<typeof vi.fn>;
    }).sendAsAgent;
    const embedArg = sendAsAgent.mock.calls[0]?.[3];
    expect(embedArg?.data?.description).toBe(PLATFORM_ERROR_RECOVERY_MESSAGE);
  });

  it("verbatim recovery message does NOT contain 'Credit balance' (OAuth/Max-friendly)", () => {
    expect(PLATFORM_ERROR_RECOVERY_MESSAGE).not.toContain("Credit balance");
    expect(PLATFORM_ERROR_RECOVERY_MESSAGE).not.toContain("credit balance");
    expect(PLATFORM_ERROR_RECOVERY_MESSAGE.length).toBeLessThanOrEqual(DESCRIPTION_MAX_CHARS);
  });

  it("normal session summarization is unchanged when turns are NOT error-dominated", async () => {
    const normalTurns = [
      makeTurn({ role: "user", content: "Build me a thing." }),
      makeTurn({ role: "assistant", content: "Working on it. Here's the plan." }),
    ];
    const summarizeSpy = vi.fn().mockResolvedValue("I was building a thing.");
    const deps = makeDeps({
      conversationStore: stubStore([makeSession()], { "sess-abc": normalTurns }),
      summarize: summarizeSpy,
    });

    const result = await sendRestartGreeting(deps, {
      agentName: "clawdy",
      config: makeConfig(),
      restartKind: "crash-suspected",
    });

    expect(result.kind).toBe("sent");
    expect(summarizeSpy).toHaveBeenCalledTimes(1);
    const sendAsAgent = (deps.webhookManager as unknown as {
      sendAsAgent: ReturnType<typeof vi.fn>;
    }).sendAsAgent;
    const embedArg = sendAsAgent.mock.calls[0]?.[3];
    expect(embedArg?.data?.description).toBe("I was building a thing.");
  });
});

// ---------------------------------------------------------------------------
// 260501-nxm — cached-summary fast-path API-error guard
// ---------------------------------------------------------------------------
// The fast-path at L483-488 (Phase 99 D-fix) reuses lastSession.summaryMemoryId
// verbatim — but if the cached summary was written BEFORE the 2026-04-30
// isApiErrorDominatedSession guard landed, it can contain platform-error junk
// like "Credit balance is too low". Operator observed this at 10:03 AM on
// 2026-05-01 after `/clawcode-restart Admin Clawdy`. Guard mirrors the
// upstream fingerprint set so write-side and read-side share one source of
// truth.

describe("sendRestartGreeting — cached-summary fast-path API-error guard", () => {
  it("substitutes PLATFORM_ERROR_RECOVERY_MESSAGE when cached summary contains 'Credit balance is too low' (operator-observed 2026-05-01 bug)", async () => {
    const session = makeSession({ summaryMemoryId: "mem_test_001" });
    const summarizeSpy = vi.fn().mockResolvedValue("Haiku should NOT be called");
    const deps = makeDeps({
      conversationStore: stubStore([session], { "sess-abc": [makeTurn()] }),
      summarize: summarizeSpy,
      getMemoryById: vi.fn().mockReturnValue("Credit balance is too low"),
    });

    const result = await sendRestartGreeting(deps, {
      agentName: "clawdy",
      config: makeConfig(),
      restartKind: "clean",
    });

    expect(result.kind).toBe("sent");
    expect(summarizeSpy).not.toHaveBeenCalled();
    const sendAsAgent = (deps.webhookManager as unknown as {
      sendAsAgent: ReturnType<typeof vi.fn>;
    }).sendAsAgent;
    const embedArg = sendAsAgent.mock.calls[0]?.[3];
    expect(embedArg?.data?.description).toBe(PLATFORM_ERROR_RECOVERY_MESSAGE);
  });

  it("preserves the cached summary verbatim when content has no API-error fingerprint (happy-path regression guard)", async () => {
    const session = makeSession({ summaryMemoryId: "mem_test_002" });
    const summarizeSpy = vi.fn().mockResolvedValue("Haiku should NOT be called");
    const deps = makeDeps({
      conversationStore: stubStore([session], { "sess-abc": [makeTurn()] }),
      summarize: summarizeSpy,
      getMemoryById: vi.fn().mockReturnValue("I was building a thing."),
    });

    const result = await sendRestartGreeting(deps, {
      agentName: "clawdy",
      config: makeConfig(),
      restartKind: "clean",
    });

    expect(result.kind).toBe("sent");
    expect(summarizeSpy).not.toHaveBeenCalled();
    const sendAsAgent = (deps.webhookManager as unknown as {
      sendAsAgent: ReturnType<typeof vi.fn>;
    }).sendAsAgent;
    const embedArg = sendAsAgent.mock.calls[0]?.[3];
    expect(embedArg?.data?.description).toBe("I was building a thing.");
  });

  it("substitutes PLATFORM_ERROR_RECOVERY_MESSAGE for any cached summary matching the API_ERROR_FINGERPRINTS array (e.g. 'Failed to authenticate. API Error: 403')", async () => {
    const session = makeSession({ summaryMemoryId: "mem_test_003" });
    const summarizeSpy = vi.fn().mockResolvedValue("Haiku should NOT be called");
    const deps = makeDeps({
      conversationStore: stubStore([session], { "sess-abc": [makeTurn()] }),
      summarize: summarizeSpy,
      getMemoryById: vi
        .fn()
        .mockReturnValue("Failed to authenticate. API Error: 403 — permission_error"),
    });

    const result = await sendRestartGreeting(deps, {
      agentName: "clawdy",
      config: makeConfig(),
      restartKind: "crash-suspected",
    });

    expect(result.kind).toBe("sent");
    expect(summarizeSpy).not.toHaveBeenCalled();
    const sendAsAgent = (deps.webhookManager as unknown as {
      sendAsAgent: ReturnType<typeof vi.fn>;
    }).sendAsAgent;
    const embedArg = sendAsAgent.mock.calls[0]?.[3];
    expect(embedArg?.data?.description).toBe(PLATFORM_ERROR_RECOVERY_MESSAGE);
  });
});

// ---------------------------------------------------------------------------
// Phase 99-D — summaryMemoryId fallback when no candidate has turns
// ---------------------------------------------------------------------------
// Operator-observed: agents whose recent terminated sessions are all
// turn-empty (translator-imported sessions with status='ended' BEFORE turn
// rows reach the DB, OR sessions whose raw turns were pruned by Gap-2
// cleanup post-summarize) used to fall through to the "no prior session to
// recap" minimal embed even when a stored summary memory entry was on hand.
// The 99-D fallback picks the first candidate with `summaryMemoryId` set
// and routes through the existing summaryMemoryId fast-path.

describe("sendRestartGreeting — Phase 99-D summaryMemoryId fallback", () => {
  it("uses cached summary verbatim when ALL recent sessions have zero turns but oldest carries summaryMemoryId", async () => {
    const empty1 = makeSession({ id: "s1", summaryMemoryId: null });
    const empty2 = makeSession({ id: "s2", summaryMemoryId: null });
    const summaryOnly = makeSession({
      id: "s3",
      summaryMemoryId: "mem_99d_001",
      // Older than empty1/empty2 but still well within dormancy.
      startedAt: new Date(FIXED_NOW - 7_200_000).toISOString(),
      endedAt: new Date(FIXED_NOW - 5_400_000).toISOString(),
    });
    const summarizeSpy = vi.fn().mockResolvedValue("Haiku should NOT be called");
    const deps = makeDeps({
      conversationStore: stubStore(
        [empty1, empty2, summaryOnly],
        { s1: [], s2: [], s3: [] },
      ),
      summarize: summarizeSpy,
      getMemoryById: vi.fn().mockReturnValue("Reviewed Q3 plan with the team."),
    });

    const result = await sendRestartGreeting(deps, {
      agentName: "clawdy",
      config: makeConfig(),
      restartKind: "clean",
    });

    expect(result.kind).toBe("sent");
    expect(summarizeSpy).not.toHaveBeenCalled();
    const sendAsAgent = (deps.webhookManager as unknown as {
      sendAsAgent: ReturnType<typeof vi.fn>;
    }).sendAsAgent;
    const embedArg = sendAsAgent.mock.calls[0]?.[3];
    expect(embedArg?.data?.description).toBe("Reviewed Q3 plan with the team.");
  });

  it("falls through to skipped-empty-state minimal embed when NO candidate has turns AND none have summaryMemoryId", async () => {
    const empty1 = makeSession({ id: "s1", summaryMemoryId: null });
    const empty2 = makeSession({ id: "s2", summaryMemoryId: null });
    const summarizeSpy = vi.fn();
    const deps = makeDeps({
      conversationStore: stubStore([empty1, empty2], { s1: [], s2: [] }),
      summarize: summarizeSpy,
      getMemoryById: vi.fn().mockReturnValue(undefined),
    });

    const result = await sendRestartGreeting(deps, {
      agentName: "clawdy",
      config: makeConfig(),
      restartKind: "clean",
    });

    // Existing minimal-embed branch fires — kind=sent with the "no prior
    // session to recap" minimal embed (Phase 90.1 hotfix preserved).
    expect(result.kind).toBe("sent");
    expect(summarizeSpy).not.toHaveBeenCalled();
    const sendAsAgent = (deps.webhookManager as unknown as {
      sendAsAgent: ReturnType<typeof vi.fn>;
    }).sendAsAgent;
    const embedArg = sendAsAgent.mock.calls[0]?.[3];
    expect(embedArg?.data?.description).toMatch(/no prior session to recap/);
  });

  it("ignores summaryMemoryId fallback if getMemoryById is undefined (DI not wired)", async () => {
    const empty1 = makeSession({ id: "s1", summaryMemoryId: "mem_99d_002" });
    const summarizeSpy = vi.fn();
    const deps = makeDeps({
      conversationStore: stubStore([empty1], { s1: [] }),
      summarize: summarizeSpy,
      // no getMemoryById injected
    });

    const result = await sendRestartGreeting(deps, {
      agentName: "clawdy",
      config: makeConfig(),
      restartKind: "clean",
    });

    // Without getMemoryById the helper cannot resolve the summary, so it
    // correctly falls through to the minimal-embed branch.
    expect(result.kind).toBe("sent");
    expect(summarizeSpy).not.toHaveBeenCalled();
    const sendAsAgent = (deps.webhookManager as unknown as {
      sendAsAgent: ReturnType<typeof vi.fn>;
    }).sendAsAgent;
    const embedArg = sendAsAgent.mock.calls[0]?.[3];
    expect(embedArg?.data?.description).toMatch(/no prior session to recap/);
  });

  it("listRecentTerminatedSessions is called with the bumped Phase 99-D limit (25)", async () => {
    const summarizeSpy = vi.fn();
    const listSpy = vi.fn().mockReturnValue([]);
    const deps = makeDeps({
      conversationStore: {
        listRecentTerminatedSessions: listSpy,
        getTurnsForSession: vi.fn(() => []),
      },
      summarize: summarizeSpy,
    });

    await sendRestartGreeting(deps, {
      agentName: "clawdy",
      config: makeConfig(),
      restartKind: "clean",
    });

    expect(listSpy).toHaveBeenCalledWith("clawdy", 25);
  });
});
