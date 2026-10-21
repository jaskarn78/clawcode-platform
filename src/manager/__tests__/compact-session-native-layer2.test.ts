/**
 * Phase 999.75 Part B (Layer 2) — `handleCompactSession` native /compact
 * unit tests.
 *
 * Pure-DI: no daemon, no real SDK. Fakes the `sendCompactCommand` +
 * `getContextUsage` seams so the native-compact flow can be exercised
 * deterministically (mirrors the verification spec in the 999.75 Layer-2
 * plan, Section 7.1).
 *
 * Coverage:
 *   - happy path  — /compact dispatched, `tokens_after < tokens_before`,
 *                   `live_reduced:true`.
 *   - pre-flight  — conversation below `minMessagesToCompact` → skip
 *                   ("too_short"), Layer 1 still ran.
 *   - fail-open   — `sendCompactCommand` throws → `live_reduced:false`,
 *                   `ok:true`, live session untouched.
 *   - fail-open   — /compact ran but the window did NOT shrink
 *                   ("no_reduction").
 *   - fail-open   — `getContextUsage` seam not wired → "seam_not_wired".
 *   - fail-open   — `getContextUsage` throws before /compact →
 *                   "tokens_unavailable" + /compact never dispatched.
 */
import { describe, it, expect } from "vitest";
import pino from "pino";

import {
  handleCompactSession,
  type CompactSessionDeps,
} from "../daemon-compact-session-ipc.js";
import type {
  ConversationTurn,
  CompactionResult,
} from "../../memory/compaction.js";

const SILENT_LOG = pino({ level: "silent" });

/** Build a conversation of `n` user/assistant turns. */
function buildConversation(n: number): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (let i = 0; i < n; i++) {
    turns.push({
      timestamp: "2026-05-21T12:00:00Z",
      role: i % 2 === 0 ? "user" : "assistant",
      content: `turn-${i}: discussion content line ${i}, at least 20 chars.`,
    });
  }
  return turns;
}

/** A CompactionResult with a non-empty summary + N memories. */
function fakeCompactionResult(memoriesCreated: number): CompactionResult {
  return {
    logPath: "/tmp/fake-session-log.md",
    summary: "Layer-1 tool-aware summary text (non-empty).",
    memoriesCreated,
  };
}

describe("handleCompactSession — Layer 2 native /compact", () => {
  it("dispatches /compact and reports live_reduced when the window shrinks", async () => {
    const conversation = buildConversation(40);
    let compactForAgentCalls = 0;
    const compactCommands: string[] = [];
    let usageCall = 0;

    const deps: CompactSessionDeps = {
      manager: {
        getSessionHandle: () => ({
          sessionId: "sid-happy",
          hasActiveTurn: () => false,
        }),
        getConversationTurns: () => conversation,
        getContextFillProvider: () => undefined,
        compactForAgent: async () => {
          compactForAgentCalls += 1;
          return fakeCompactionResult(3);
        },
        hasCompactionManager: () => true,
      },
      sendCompactCommand: async (command) => {
        compactCommands.push(command);
        return "compacted";
      },
      getContextUsage: async () => {
        usageCall += 1;
        return { totalTokens: usageCall === 1 ? 80_000 : 20_000 };
      },
      extractMemories: async () => ["a", "b", "c"],
      log: SILENT_LOG,
      daemonReady: true,
    };

    const result = await handleCompactSession({ agent: "happy" }, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.live_reduced).toBe(true);
    expect(result.skip_reason).toBeUndefined();
    expect(result.tokens_before).toBe(80_000);
    expect(result.tokens_after).toBe(20_000);
    expect(result.forked_to).toBeNull();
    expect(result.summary_written).toBe(true);
    expect(result.memories_created).toBe(3);
    // Layer 1 ran exactly once; native /compact dispatched exactly once.
    expect(compactForAgentCalls).toBe(1);
    expect(compactCommands).toEqual(["/compact"]);
  });

  it("skips /compact when the conversation is too short (pre-flight)", async () => {
    // Below the default minMessagesToCompact (12).
    const conversation = buildConversation(6);
    let compactForAgentCalls = 0;
    let compactDispatched = false;

    const deps: CompactSessionDeps = {
      manager: {
        getSessionHandle: () => ({
          sessionId: "sid-short",
          hasActiveTurn: () => false,
        }),
        getConversationTurns: () => conversation,
        getContextFillProvider: () => undefined,
        compactForAgent: async () => {
          compactForAgentCalls += 1;
          return fakeCompactionResult(2);
        },
        hasCompactionManager: () => true,
      },
      sendCompactCommand: async () => {
        compactDispatched = true;
        return "compacted";
      },
      getContextUsage: async () => ({ totalTokens: 5_000 }),
      extractMemories: async () => ["x", "y"],
      log: SILENT_LOG,
      daemonReady: true,
    };

    const result = await handleCompactSession({ agent: "short" }, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.live_reduced).toBe(false);
    expect(result.skip_reason).toBe("too_short");
    expect(result.tokens_after).toBeNull();
    // Layer 1 STILL ran — only Layer 2 was skipped.
    expect(compactForAgentCalls).toBe(1);
    // /compact was NOT dispatched.
    expect(compactDispatched).toBe(false);
  });

  it("respects an explicit minMessagesToCompact override", async () => {
    const conversation = buildConversation(40);
    let compactDispatched = false;

    const deps: CompactSessionDeps = {
      manager: {
        getSessionHandle: () => ({
          sessionId: "sid-override",
          hasActiveTurn: () => false,
        }),
        getConversationTurns: () => conversation,
        getContextFillProvider: () => undefined,
        compactForAgent: async () => fakeCompactionResult(1),
        hasCompactionManager: () => true,
      },
      sendCompactCommand: async () => {
        compactDispatched = true;
        return "compacted";
      },
      getContextUsage: async () => ({ totalTokens: 1_000 }),
      extractMemories: async () => ["z"],
      log: SILENT_LOG,
      daemonReady: true,
      // 40 turns < 100 floor → skip.
      minMessagesToCompact: 100,
    };

    const result = await handleCompactSession({ agent: "override" }, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skip_reason).toBe("too_short");
    expect(compactDispatched).toBe(false);
  });

  it("fails open when sendCompactCommand throws (live session untouched)", async () => {
    const conversation = buildConversation(40);
    let usageCall = 0;

    const deps: CompactSessionDeps = {
      manager: {
        getSessionHandle: () => ({
          sessionId: "sid-throw",
          hasActiveTurn: () => false,
        }),
        getConversationTurns: () => conversation,
        getContextFillProvider: () => undefined,
        compactForAgent: async () => fakeCompactionResult(2),
        hasCompactionManager: () => true,
      },
      sendCompactCommand: async () => {
        throw new Error("compact-dispatch-timeout");
      },
      getContextUsage: async () => {
        usageCall += 1;
        return { totalTokens: 60_000 };
      },
      extractMemories: async () => ["m", "n"],
      log: SILENT_LOG,
      daemonReady: true,
    };

    const result = await handleCompactSession({ agent: "throw" }, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.live_reduced).toBe(false);
    expect(result.skip_reason).toContain("dispatch_failed:");
    expect(result.skip_reason).toContain("compact-dispatch-timeout");
    // tokens_before captured before the dispatch attempt; tokens_after null.
    expect(result.tokens_before).toBe(60_000);
    expect(result.tokens_after).toBeNull();
    // getContextUsage was called once (before) — never reached the "after".
    expect(usageCall).toBe(1);
  });

  it("fails open when sendCompactCommand hangs past the dispatch timeout", async () => {
    const conversation = buildConversation(40);
    let usageCall = 0;

    const deps: CompactSessionDeps = {
      manager: {
        getSessionHandle: () => ({
          sessionId: "sid-hang",
          hasActiveTurn: () => false,
        }),
        getConversationTurns: () => conversation,
        getContextFillProvider: () => undefined,
        compactForAgent: async () => fakeCompactionResult(1),
        hasCompactionManager: () => true,
      },
      // Never resolves — simulates a wedged SDK / dead handle.
      sendCompactCommand: () => new Promise<string>(() => undefined),
      getContextUsage: async () => {
        usageCall += 1;
        return { totalTokens: 70_000 };
      },
      extractMemories: async () => ["h"],
      log: SILENT_LOG,
      daemonReady: true,
      // Tiny timeout so the test does not wait the 5-min default.
      compactDispatchTimeoutMs: 50,
    };

    const result = await handleCompactSession({ agent: "hang" }, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.live_reduced).toBe(false);
    expect(result.skip_reason).toContain("dispatch_failed:");
    expect(result.skip_reason).toContain("timeout");
    expect(result.tokens_before).toBe(70_000);
    expect(result.tokens_after).toBeNull();
    // getContextUsage ran once (before) — the after-read is never reached.
    expect(usageCall).toBe(1);
  });

  it("fails open when /compact runs but the window did not shrink", async () => {
    const conversation = buildConversation(40);
    let usageCall = 0;

    const deps: CompactSessionDeps = {
      manager: {
        getSessionHandle: () => ({
          sessionId: "sid-noshrink",
          hasActiveTurn: () => false,
        }),
        getConversationTurns: () => conversation,
        getContextFillProvider: () => undefined,
        compactForAgent: async () => fakeCompactionResult(1),
        hasCompactionManager: () => true,
      },
      sendCompactCommand: async () => "compacted",
      getContextUsage: async () => {
        usageCall += 1;
        // before === after → no reduction observed.
        return { totalTokens: 45_000 };
      },
      extractMemories: async () => ["q"],
      log: SILENT_LOG,
      daemonReady: true,
    };

    const result = await handleCompactSession({ agent: "noshrink" }, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.live_reduced).toBe(false);
    expect(result.skip_reason).toBe("no_reduction");
    expect(result.tokens_before).toBe(45_000);
    expect(result.tokens_after).toBe(45_000);
    expect(usageCall).toBe(2);
  });

  it("fails open when the native /compact DI seams are not wired", async () => {
    const conversation = buildConversation(40);
    let compactForAgentCalls = 0;

    // No sendCompactCommand / getContextUsage — legacy handle / fixture.
    const deps: CompactSessionDeps = {
      manager: {
        getSessionHandle: () => ({
          sessionId: "sid-legacy",
          hasActiveTurn: () => false,
        }),
        getConversationTurns: () => conversation,
        getContextFillProvider: () => undefined,
        compactForAgent: async () => {
          compactForAgentCalls += 1;
          return fakeCompactionResult(2);
        },
        hasCompactionManager: () => true,
      },
      extractMemories: async () => ["a", "b"],
      log: SILENT_LOG,
      daemonReady: true,
    };

    const result = await handleCompactSession({ agent: "legacy" }, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.live_reduced).toBe(false);
    expect(result.skip_reason).toBe("seam_not_wired");
    // Layer 1 still delivered.
    expect(compactForAgentCalls).toBe(1);
    expect(result.summary_written).toBe(true);
    expect(result.memories_created).toBe(2);
  });

  it("fails open when getContextUsage throws before /compact (no blind dispatch)", async () => {
    const conversation = buildConversation(40);
    let compactDispatched = false;

    const deps: CompactSessionDeps = {
      manager: {
        getSessionHandle: () => ({
          sessionId: "sid-usage-throw",
          hasActiveTurn: () => false,
        }),
        getConversationTurns: () => conversation,
        getContextFillProvider: () => undefined,
        compactForAgent: async () => fakeCompactionResult(1),
        hasCompactionManager: () => true,
      },
      sendCompactCommand: async () => {
        compactDispatched = true;
        return "compacted";
      },
      getContextUsage: async () => {
        throw new Error("context-usage-control-failed");
      },
      extractMemories: async () => ["w"],
      log: SILENT_LOG,
      daemonReady: true,
    };

    const result = await handleCompactSession({ agent: "usage-throw" }, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.live_reduced).toBe(false);
    expect(result.skip_reason).toBe("tokens_unavailable");
    // /compact must NOT be dispatched when we cannot measure the result.
    expect(compactDispatched).toBe(false);
  });

  it("warn-logs and ignores the deprecated upToMessageId field", async () => {
    const conversation = buildConversation(40);
    const warnMessages: string[] = [];
    const warnLog = {
      info: () => undefined,
      warn: (...args: unknown[]) => {
        const last = args[args.length - 1];
        if (typeof last === "string") warnMessages.push(last);
      },
      error: () => undefined,
    };

    const deps: CompactSessionDeps = {
      manager: {
        getSessionHandle: () => ({
          sessionId: "sid-deprecated",
          hasActiveTurn: () => false,
        }),
        getConversationTurns: () => conversation,
        getContextFillProvider: () => undefined,
        compactForAgent: async () => fakeCompactionResult(1),
        hasCompactionManager: () => true,
      },
      sendCompactCommand: async () => "compacted",
      getContextUsage: async () => ({ totalTokens: 30_000 }),
      extractMemories: async () => ["d"],
      log: warnLog,
      daemonReady: true,
      upToMessageId: "stale-uuid-from-old-caller",
    };

    const result = await handleCompactSession({ agent: "deprecated" }, deps);
    expect(result.ok).toBe(true);
    expect(
      warnMessages.some((m) => m.includes("upToMessageId is deprecated")),
    ).toBe(true);
  });
});
