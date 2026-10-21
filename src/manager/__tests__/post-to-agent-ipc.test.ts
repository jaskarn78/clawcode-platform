/**
 * Quick 260511-pw2 — sentinel + behavior tests for the post-to-agent IPC
 * handler.
 *
 * Anti-pattern guard (feedback_silent_path_bifurcation.md):
 *   The reason-tagged "post-to-agent skipped" logs are observable only by
 *   absence. A grep-only test would have shipped Phase 115-08 green. These
 *   tests are FUNCTIONAL sentinels — they invoke handlePostToAgentIpc
 *   with synthesized failure conditions and assert each reason tag fires
 *   with the documented log message.
 *
 *   The static-grep sentinel below (Sentinel A) ALSO pins the production
 *   caller chain: `case "post-to-agent":` in daemon.ts must `await import`
 *   the handler so a future refactor cannot silently bifurcate the path
 *   (e.g., land logging on a function the daemon never calls).
 */
import { beforeEach, describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  handlePostToAgentIpc,
  type PostToAgentDeps,
} from "../daemon-post-to-agent-ipc.js";
import {
  _resetNoWebhookFallbacks,
  snapshotNoWebhookFallbacks,
} from "../fleet-stats.js";

// ---------------------------------------------------------------------------
// Test fixture builders
// ---------------------------------------------------------------------------

function makeLog() {
  const calls: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const record = (obj: unknown, msg: unknown) => {
    calls.push({
      obj: obj as Record<string, unknown>,
      msg: String(msg),
    });
  };
  return {
    log: {
      info: record,
      warn: record,
      error: record,
    },
    calls,
  };
}

function makeDeps(overrides: Partial<PostToAgentDeps> = {}): {
  deps: PostToAgentDeps;
  calls: ReturnType<typeof makeLog>["calls"];
  writeInbox: ReturnType<typeof vi.fn>;
  sendAsAgent: ReturnType<typeof vi.fn>;
} {
  const writeInbox = vi.fn().mockResolvedValue({ messageId: "inbox-msg-1" });
  const sendAsAgent = vi.fn().mockResolvedValue("webhook-msg-1");
  const { log, calls } = makeLog();
  const deps: PostToAgentDeps = {
    runningAgents: ["projects"],
    configs: [
      {
        name: "admin-clawdy",
        memoryPath: "/tmp/admin-clawdy",
        webhook: { displayName: "Admin Clawdy" },
      },
      {
        name: "projects",
        memoryPath: "/tmp/projects",
        webhook: { displayName: "Projects" },
      },
    ],
    agentChannels: new Map([["projects", ["chan-1"]]]),
    webhookManager: {
      hasWebhook: () => true,
      sendAsAgent,
    },
    writeInbox,
    log,
    ...overrides,
  };
  return { deps, calls, writeInbox, sendAsAgent };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("handlePostToAgentIpc — happy path", () => {
  it("delivers via webhook when target has channels + webhook + is reachable", async () => {
    const { deps, calls, writeInbox, sendAsAgent } = makeDeps();
    const result = await handlePostToAgentIpc(
      { from: "admin-clawdy", to: "projects", message: "hi" },
      deps,
    );
    expect(result).toEqual({
      ok: true,
      delivered: true,
      messageId: "inbox-msg-1",
      via: "webhook",
    });
    expect(writeInbox).toHaveBeenCalledTimes(1);
    expect(sendAsAgent).toHaveBeenCalledTimes(1);
    // No skipped logs on the happy path.
    expect(calls.filter((c) => c.msg === "post-to-agent skipped")).toHaveLength(
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// Skip path 1: target-not-found (throws — validation contract preserved)
// ---------------------------------------------------------------------------

describe("handlePostToAgentIpc — target-not-found", () => {
  it("throws ManagerError AND logs reason=target-not-found", async () => {
    const { deps, calls } = makeDeps({ configs: [] });
    await expect(
      handlePostToAgentIpc(
        { from: "admin-clawdy", to: "nobody", message: "x" },
        deps,
      ),
    ).rejects.toThrow(/Target agent 'nobody' not found/);
    const hit = calls.find(
      (c) =>
        c.msg === "post-to-agent skipped" &&
        c.obj["reason"] === "target-not-found",
    );
    expect(hit).toBeDefined();
  });

  // Phase 999.117 WS-0 — a bare "not found" gave the sending LLM nothing to
  // correct with, so it guessed again or gave up silently. One prod agent is
  // literally named "Admin Clawdy" (space + capitals), making `to: "admin"`
  // the natural guess — and it failed with no hint.
  it("lists valid agents so the sender can self-correct", async () => {
    const { deps } = makeDeps();
    await expect(
      handlePostToAgentIpc(
        { from: "admin-clawdy", to: "nobody", message: "x" },
        deps,
      ),
    ).rejects.toThrow(/Valid agents: .*'projects'/);
  });

  // Phase 999.117 WS-5 superseded the WS-0 "did you mean" for this case: the
  // name now RESOLVES rather than failing with a suggestion. Suggesting was
  // only ever a consolation prize for an addressing scheme that could not
  // handle the fleet's own agent names.
  it("resolves a kebab-case spelling of a spaced, capitalised name", async () => {
    const { deps, writeInbox } = makeDeps({
      configs: [
        { name: "Admin Clawdy", memoryPath: "/mem/admin" },
        { name: "projects", memoryPath: "/mem/projects" },
      ],
      agentChannels: new Map([["Admin Clawdy", ["chan-admin"]]]),
    });
    const res = await handlePostToAgentIpc(
      { from: "projects", to: "admin-clawdy", message: "x" },
      deps,
    );
    expect(res.ok).toBe(true);
    // The inbox write must use the RESOLVED name, not the caller's spelling —
    // otherwise the message lands in a directory nothing watches.
    expect(writeInbox).toHaveBeenCalledWith(
      expect.objectContaining({ to: "Admin Clawdy" }),
    );
  });

  it("refuses to guess between two similarly-named agents", async () => {
    const { deps } = makeDeps({
      configs: [
        { name: "fin-research", memoryPath: "/mem/a" },
        { name: "fin-client", memoryPath: "/mem/b" },
      ],
    });
    await expect(
      handlePostToAgentIpc({ from: "projects", to: "fin", message: "x" }, deps),
    ).rejects.toThrow(/ambiguous/);
  });

  it("names the competing candidates rather than picking one", async () => {
    // A wrong pick is worse than a failure — the sender acts on it and
    // nobody can tell the message went to the wrong agent.
    const { deps } = makeDeps({
      configs: [
        { name: "fin-research", memoryPath: "/mem/a" },
        { name: "fin-client", memoryPath: "/mem/b" },
      ],
    });
    await expect(
      handlePostToAgentIpc({ from: "projects", to: "fin", message: "x" }, deps),
    ).rejects.toThrow(/'fin-research'/);
  });
});

// ---------------------------------------------------------------------------
// Phase 999.117 WS-0 — `via` names the mechanism that actually ran
//
// `delivered: true` was being rendered by the MCP wrapper as "Message
// delivered to X via their Discord channel" on EVERY success. That is false
// on the bot-direct rung: the recipient's bridge drops bot-authored
// non-webhook messages, so the post is operator-visible only and the turn
// comes from the inbox watcher. 61 such dispatches on prod in one week, each
// misreported to the sending agent. These tests pin which rung set which
// `via`, so the wrapper can never drift back into claiming a delivery that
// did not happen.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Phase 999.117 WS-3 — loop governance at the delivery point
//
// The governor is only worth anything if it sits on the ONE path every A2A
// message takes, and if a blocked message leaves NO inbox record — otherwise
// the watcher delivers it anyway and the bound is decorative.
// ---------------------------------------------------------------------------

describe("handlePostToAgentIpc — loop governor (999.117 WS-3)", () => {
  const allowAll = {
    evaluate: () => ({
      allow: true,
      tripped: false,
      conversationId: "conv-stub",
      hops: 1,
    }),
  };
  const blockAll = {
    evaluate: () => ({
      allow: false,
      tripped: true,
      rule: "max-hops",
      detail: "Conversation reached hop 7 (limit 6).",
      conversationId: "conv-stub",
      hops: 7,
    }),
  };

  it("blocks a message that breaches a bound — and writes NO inbox record", async () => {
    const { deps, writeInbox, sendAsAgent } = makeDeps({ loopGovernor: blockAll });
    await expect(
      handlePostToAgentIpc(
        { from: "admin-clawdy", to: "projects", message: "again?" },
        deps,
      ),
    ).rejects.toThrow(/loop guard \(max-hops\)/);
    // The critical assertion: no inbox file. A suppressed message that still
    // lands on disk gets delivered by the watcher regardless, which would
    // make the whole bound cosmetic.
    expect(writeInbox).not.toHaveBeenCalled();
    expect(sendAsAgent).not.toHaveBeenCalled();
  });

  it("tells the sender not to retry", async () => {
    // The sender is an LLM mid-turn. A soft `delivered: false` reads as
    // "try again later" and it would — which is the loop. The error text
    // has to be an unambiguous stop signal.
    const { deps } = makeDeps({ loopGovernor: blockAll });
    await expect(
      handlePostToAgentIpc(
        { from: "admin-clawdy", to: "projects", message: "again?" },
        deps,
      ),
    ).rejects.toThrow(/Do not retry/);
  });

  it("passes the envelope to the governor so it can see conversation depth", async () => {
    const evaluate = vi
      .fn()
      .mockReturnValue({ allow: true, tripped: false, conversationId: "conv-42", hops: 4 });
    const { deps } = makeDeps({ loopGovernor: { evaluate } });
    await handlePostToAgentIpc(
      {
        from: "admin-clawdy",
        to: "projects",
        message: "hi",
        conversationId: "conv-42",
        hops: 4,
      },
      deps,
    );
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "admin-clawdy",
        to: "projects",
        conversationId: "conv-42",
        hops: 4,
      }),
    );
  });

  it("mints a conversation id and starts at hop 1 for a fresh exchange", async () => {
    // The handler must NOT mint an id — it passes undefined so the governor
    // can derive one from the pair. Minting here is precisely the defect that
    // made three of the four bounds dead code in production.
    const evaluate = vi
      .fn()
      .mockReturnValue({ allow: true, tripped: false, conversationId: "derived", hops: 1 });
    const { deps, writeInbox } = makeDeps({ loopGovernor: { evaluate } });
    await handlePostToAgentIpc(
      { from: "admin-clawdy", to: "projects", message: "hi" },
      deps,
    );
    expect(evaluate.mock.calls[0][0].conversationId).toBeUndefined();
    // ...and the governor's resolved identity is what gets persisted.
    expect(writeInbox).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "derived", hops: 1 }),
    );
  });

  it("threads the envelope onto the persisted message", async () => {
    // If the envelope is dropped at the write, every hop looks like hop 1
    // and the depth bound can never fire — the same silent-bifurcation shape
    // that made `kind` inert for daemon-written acks until 2026-07-16.
    const evaluate = vi
      .fn()
      .mockReturnValue({ allow: true, tripped: false, conversationId: "conv-9", hops: 3 });
    const { deps, writeInbox } = makeDeps({ loopGovernor: { evaluate } });
    await handlePostToAgentIpc(
      {
        from: "admin-clawdy",
        to: "projects",
        message: "hi",
        conversationId: "conv-9",
        hops: 3,
      },
      deps,
    );
    expect(writeInbox).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv-9", hops: 3 }),
    );
  });

  it("no governor wired → unchanged behaviour (back-compat)", async () => {
    const { deps, writeInbox } = makeDeps(); // no loopGovernor
    const res = await handlePostToAgentIpc(
      { from: "admin-clawdy", to: "projects", message: "hi" },
      deps,
    );
    expect(res.delivered).toBe(true);
    expect(writeInbox).toHaveBeenCalledTimes(1);
  });
});

describe("handlePostToAgentIpc — via (999.117 WS-0)", () => {
  it("webhook rung reports via=webhook", async () => {
    const { deps } = makeDeps();
    const res = await handlePostToAgentIpc(
      { from: "admin-clawdy", to: "projects", message: "hi" },
      deps,
    );
    expect(res).toMatchObject({ delivered: true, via: "webhook" });
  });

  it("bot-direct rung reports via=bot-direct (NOT a channel delivery)", async () => {
    const sendText = vi.fn().mockResolvedValue(undefined);
    const { deps } = makeDeps({
      webhookManager: { hasWebhook: () => false, sendAsAgent: vi.fn() },
      botDirectSender: { sendText },
    });
    const res = await handlePostToAgentIpc(
      { from: "admin-clawdy", to: "projects", message: "hi" },
      deps,
    );
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ delivered: true, via: "bot-direct" });
  });

  it("inbox-only rung reports via=inbox", async () => {
    const { deps } = makeDeps({ agentChannels: new Map() });
    const res = await handlePostToAgentIpc(
      { from: "admin-clawdy", to: "projects", message: "hi" },
      deps,
    );
    expect(res).toMatchObject({ delivered: false, via: "inbox" });
  });
});

// ---------------------------------------------------------------------------
// Skip path 2: inbox-write-failed (throws — floor of delivery contract)
// ---------------------------------------------------------------------------

describe("handlePostToAgentIpc — inbox-write-failed", () => {
  it("throws ManagerError AND logs reason=inbox-write-failed", async () => {
    const writeInbox = vi.fn().mockRejectedValue(new Error("EACCES /tmp"));
    const { deps, calls } = makeDeps({ writeInbox });
    await expect(
      handlePostToAgentIpc(
        { from: "admin-clawdy", to: "projects", message: "x" },
        deps,
      ),
    ).rejects.toThrow(/Inbox write failed/);
    const hit = calls.find(
      (c) =>
        c.msg === "post-to-agent skipped" &&
        c.obj["reason"] === "inbox-write-failed",
    );
    expect(hit).toBeDefined();
    expect(hit?.obj["error"]).toBe("EACCES /tmp");
  });
});

// ---------------------------------------------------------------------------
// Skip path 3: no-target-channels (inbox-only)
// ---------------------------------------------------------------------------

describe("handlePostToAgentIpc — no-target-channels", () => {
  it("returns inbox-only AND logs reason=no-target-channels", async () => {
    const { deps, calls, sendAsAgent } = makeDeps({
      agentChannels: new Map(), // empty routing
    });
    const result = await handlePostToAgentIpc(
      { from: "admin-clawdy", to: "projects", message: "x" },
      deps,
    );
    expect(result).toEqual({
      ok: true,
      delivered: false,
      messageId: "inbox-msg-1",
      reason: "no-target-channels",
      via: "inbox",
    });
    expect(sendAsAgent).not.toHaveBeenCalled();
    const hit = calls.find(
      (c) =>
        c.msg === "post-to-agent skipped" &&
        c.obj["reason"] === "no-target-channels",
    );
    expect(hit).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Skip path 4: no-webhook (inbox-only)
// ---------------------------------------------------------------------------

describe("handlePostToAgentIpc — no-webhook", () => {
  it("returns inbox-only AND logs reason=no-webhook", async () => {
    const { deps, calls, sendAsAgent } = makeDeps({
      webhookManager: { hasWebhook: () => false, sendAsAgent: vi.fn() },
    });
    const result = await handlePostToAgentIpc(
      { from: "admin-clawdy", to: "projects", message: "x" },
      deps,
    );
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("no-webhook");
    expect(sendAsAgent).not.toHaveBeenCalled();
    const hit = calls.find(
      (c) =>
        c.msg === "post-to-agent skipped" && c.obj["reason"] === "no-webhook",
    );
    expect(hit).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Skip path 5: webhook-send-failed (inbox-only)
// ---------------------------------------------------------------------------

describe("handlePostToAgentIpc — webhook-send-failed", () => {
  it("returns inbox-only AND logs reason=webhook-send-failed when sendAsAgent throws", async () => {
    const sendAsAgent = vi.fn().mockRejectedValue(new Error("Discord 503"));
    const { deps, calls } = makeDeps({
      webhookManager: { hasWebhook: () => true, sendAsAgent },
    });
    const result = await handlePostToAgentIpc(
      { from: "admin-clawdy", to: "projects", message: "x" },
      deps,
    );
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("webhook-send-failed");
    const hit = calls.find(
      (c) =>
        c.msg === "post-to-agent skipped" &&
        c.obj["reason"] === "webhook-send-failed",
    );
    expect(hit).toBeDefined();
    expect(hit?.obj["error"]).toBe("Discord 503");
  });
});

// ---------------------------------------------------------------------------
// Skip path 6: target-not-running (secondary log when webhook also failed)
// ---------------------------------------------------------------------------

describe("handlePostToAgentIpc — target-not-running secondary log", () => {
  it("logs reason=target-not-running in addition to the primary reason when target offline", async () => {
    const { deps, calls } = makeDeps({
      runningAgents: [], // target offline
      webhookManager: { hasWebhook: () => false, sendAsAgent: vi.fn() },
    });
    const result = await handlePostToAgentIpc(
      { from: "admin-clawdy", to: "projects", message: "x" },
      deps,
    );
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("no-webhook");
    // Primary skip log
    const primary = calls.find((c) => c.obj["reason"] === "no-webhook");
    expect(primary).toBeDefined();
    // Secondary skip log — operator visibility for "inbox written but
    // heartbeat reconciler can't dispatch a turn to a dead process".
    const secondary = calls.find(
      (c) => c.obj["reason"] === "target-not-running",
    );
    expect(secondary).toBeDefined();
    expect(secondary?.obj["primaryReason"]).toBe("no-webhook");
  });

  it("does NOT log target-not-running when target IS running", async () => {
    const { deps, calls } = makeDeps({
      runningAgents: ["projects"],
      webhookManager: { hasWebhook: () => false, sendAsAgent: vi.fn() },
    });
    await handlePostToAgentIpc(
      { from: "admin-clawdy", to: "projects", message: "x" },
      deps,
    );
    const secondary = calls.find(
      (c) => c.obj["reason"] === "target-not-running",
    );
    expect(secondary).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 119 A2A-01 — bot-direct fallback rung (mirrors daemon-ask-agent-ipc.ts
// IPC-02 pattern). Inserts between the no-webhook skip and the inbox-only
// return: when there is no webhook AND a channel is bound for the target AND
// botDirectSender is wired, dispatch via the bot client and return delivered.
// ---------------------------------------------------------------------------

describe("handlePostToAgentIpc — bot-direct fallback (A2A-01)", () => {
  it("delivers via botDirectSender when no webhook + bound channel + sender wired", async () => {
    const sendText = vi.fn().mockResolvedValue(undefined);
    const { deps, calls, sendAsAgent } = makeDeps({
      webhookManager: { hasWebhook: () => false, sendAsAgent: vi.fn() },
      botDirectSender: { sendText },
    });
    const result = await handlePostToAgentIpc(
      { from: "admin-clawdy", to: "projects", message: "hello" },
      deps,
    );
    expect(result).toEqual({
      ok: true,
      delivered: true,
      messageId: "inbox-msg-1",
      via: "bot-direct",
    });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith("chan-1", "hello");
    expect(sendAsAgent).not.toHaveBeenCalled();
    const hit = calls.find(
      (c) =>
        c.msg === "[A2A-01] bot-direct dispatch" &&
        c.obj["agent"] === "projects" &&
        c.obj["channel"] === "chan-1" &&
        c.obj["reason"] === "bot-direct-fallback",
    );
    expect(hit).toBeDefined();
  });

  it("falls through to inbox when botDirectSender throws", async () => {
    const sendText = vi.fn().mockRejectedValue(new Error("Discord 500"));
    const { deps } = makeDeps({
      webhookManager: { hasWebhook: () => false, sendAsAgent: vi.fn() },
      botDirectSender: { sendText },
    });
    const result = await handlePostToAgentIpc(
      { from: "admin-clawdy", to: "projects", message: "x" },
      deps,
    );
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("no-webhook");
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("does NOT call botDirectSender when no bound channel — falls through to inbox", async () => {
    const sendText = vi.fn();
    const { deps } = makeDeps({
      webhookManager: { hasWebhook: () => false, sendAsAgent: vi.fn() },
      botDirectSender: { sendText },
      agentChannels: new Map([["projects", []]]),
    });
    const result = await handlePostToAgentIpc(
      { from: "admin-clawdy", to: "projects", message: "x" },
      deps,
    );
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("no-target-channels");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("does NOT call botDirectSender when webhook IS present (webhook path wins)", async () => {
    const sendText = vi.fn();
    const sendAsAgent = vi.fn().mockResolvedValue("ok");
    const { deps } = makeDeps({
      webhookManager: { hasWebhook: () => true, sendAsAgent },
      botDirectSender: { sendText },
    });
    const result = await handlePostToAgentIpc(
      { from: "admin-clawdy", to: "projects", message: "x" },
      deps,
    );
    expect(result.delivered).toBe(true);
    expect(sendAsAgent).toHaveBeenCalledTimes(1);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("does NOT attempt bot-direct when botDirectSender is unwired (undefined)", async () => {
    const { deps, sendAsAgent } = makeDeps({
      webhookManager: { hasWebhook: () => false, sendAsAgent: vi.fn() },
    });
    const result = await handlePostToAgentIpc(
      { from: "admin-clawdy", to: "projects", message: "x" },
      deps,
    );
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("no-webhook");
    expect(sendAsAgent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Sentinel A — static grep that pins the production caller chain.
//
// Asserts:
//   1. daemon.ts `case "post-to-agent":` body dynamically imports the new
//      handler. Without this, future refactors could silently bifurcate the
//      path (Phase 115-08 anti-pattern).
//   2. The handler module emits all six reason tags. Without this, a future
//      refactor could remove a log line and the diagnostic surface degrades
//      silently.
// ---------------------------------------------------------------------------

describe("Sentinel A — production caller chain pinned", () => {
  const repoRoot = join(__dirname, "..", "..", "..");
  const daemonSrc = readFileSync(
    join(repoRoot, "src/manager/daemon.ts"),
    "utf8",
  );
  const handlerSrc = readFileSync(
    join(repoRoot, "src/manager/daemon-post-to-agent-ipc.ts"),
    "utf8",
  );

  it("daemon.ts case post-to-agent imports daemon-post-to-agent-ipc.js", () => {
    // Grep for the dynamic import in the post-to-agent case body. The
    // `case "post-to-agent":` block must reach the new handler — anything
    // else is a silent-path bifurcation.
    expect(daemonSrc).toMatch(
      /case "post-to-agent":[\s\S]*?await import\(["']\.\/daemon-post-to-agent-ipc\.js["']\)/,
    );
  });

  it("handler emits all six reason tags", () => {
    const required = [
      "target-not-found",
      "inbox-write-failed",
      "no-target-channels",
      "no-webhook",
      "webhook-send-failed",
      "target-not-running",
    ];
    for (const reason of required) {
      expect(handlerSrc).toContain(`"${reason}"`);
    }
    // All log messages use the SAME substrate string so operators can grep
    // ONE phrase to inventory every skip.
    const skippedCount = (
      handlerSrc.match(/"post-to-agent skipped"/g) ?? []
    ).length;
    expect(skippedCount).toBeGreaterThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// Phase 119 D-05 — no-webhook-fallback counter wiring.
//
// Two call sites in the handler. Bot-direct success increments once; inbox-
// only return with a resolved channel increments once. Webhook success does
// NOT increment. Bot-direct success does NOT also fire the inbox path
// (no double-counting).
// ---------------------------------------------------------------------------
describe("handlePostToAgentIpc — no_webhook_fallbacks_total counter (D-05)", () => {
  beforeEach(() => {
    _resetNoWebhookFallbacks();
  });

  it("bot-direct success increments counter exactly once for (agent, channel)", async () => {
    const sendText = vi.fn().mockResolvedValue(undefined);
    const { deps } = makeDeps({
      webhookManager: { hasWebhook: () => false, sendAsAgent: vi.fn() },
      botDirectSender: { sendText },
    });
    await handlePostToAgentIpc(
      { from: "admin-clawdy", to: "projects", message: "hi" },
      deps,
    );
    const snap = snapshotNoWebhookFallbacks();
    expect(snap["projects:chan-1"]).toBe(1);
    // Bot-direct success means inbox-only path NOT entered — no double-count.
    expect(Object.values(snap).reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("bot-direct sendText throws → falls through to inbox; counter increments exactly ONCE (no double-count)", async () => {
    const sendText = vi.fn().mockRejectedValue(new Error("Discord 500"));
    const { deps } = makeDeps({
      webhookManager: { hasWebhook: () => false, sendAsAgent: vi.fn() },
      botDirectSender: { sendText },
    });
    await handlePostToAgentIpc(
      { from: "admin-clawdy", to: "projects", message: "x" },
      deps,
    );
    const snap = snapshotNoWebhookFallbacks();
    expect(snap["projects:chan-1"]).toBe(1);
    expect(Object.values(snap).reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("no-webhook + no botDirectSender → inbox-only path increments counter once", async () => {
    const { deps } = makeDeps({
      webhookManager: { hasWebhook: () => false, sendAsAgent: vi.fn() },
    });
    await handlePostToAgentIpc(
      { from: "admin-clawdy", to: "projects", message: "x" },
      deps,
    );
    const snap = snapshotNoWebhookFallbacks();
    expect(snap["projects:chan-1"]).toBe(1);
  });

  it("webhook-send-failed → inbox-only path increments counter once", async () => {
    const sendAsAgent = vi.fn().mockRejectedValue(new Error("Discord 503"));
    const { deps } = makeDeps({
      webhookManager: { hasWebhook: () => true, sendAsAgent },
    });
    await handlePostToAgentIpc(
      { from: "admin-clawdy", to: "projects", message: "x" },
      deps,
    );
    const snap = snapshotNoWebhookFallbacks();
    expect(snap["projects:chan-1"]).toBe(1);
  });

  it("webhook success does NOT increment counter", async () => {
    const { deps } = makeDeps();
    await handlePostToAgentIpc(
      { from: "admin-clawdy", to: "projects", message: "x" },
      deps,
    );
    const snap = snapshotNoWebhookFallbacks();
    expect(Object.keys(snap)).toHaveLength(0);
  });

  it("no-target-channels → inbox-only path with no channelId; counter NOT incremented (channelId absent)", async () => {
    const { deps } = makeDeps({
      agentChannels: new Map(), // no channels resolved
    });
    await handlePostToAgentIpc(
      { from: "admin-clawdy", to: "projects", message: "x" },
      deps,
    );
    const snap = snapshotNoWebhookFallbacks();
    // No channel resolvable → counter would key on empty string. Skip
    // increment when channelId is undefined (counter measures fallbacks
    // per channel; a request with no resolvable channel can't have one).
    expect(Object.keys(snap)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Sentinel B — silent-path-bifurcation guard for the counter call sites.
//
// The counter call lives at exactly TWO sites in daemon-post-to-agent-ipc.ts:
//   1. bot-direct rung success branch
//   2. inboxOnlyResponse helper body
// A future refactor that adds a third increment site or removes one breaks
// the D-05 contract (over/under-counting on the dashboard tile). Pin the
// count to exactly 2 so the regression surfaces in CI, not in production.
// ---------------------------------------------------------------------------
describe("Sentinel B — incrementNoWebhookFallback call-site count pinned", () => {
  const repoRoot = join(__dirname, "..", "..", "..");
  const handlerSrc = readFileSync(
    join(repoRoot, "src/manager/daemon-post-to-agent-ipc.ts"),
    "utf8",
  );
  it("daemon-post-to-agent-ipc.ts has exactly 2 incrementNoWebhookFallback call sites", () => {
    const calls = (
      handlerSrc.match(/incrementNoWebhookFallback\(/g) ?? []
    ).length;
    expect(calls).toBe(2);
  });
  it("handler imports the counter helper from fleet-stats", () => {
    expect(handlerSrc).toMatch(
      /from\s+["']\.\/fleet-stats\.js["']|import\s+\{[^}]*incrementNoWebhookFallback/,
    );
  });
});

// ---------------------------------------------------------------------------
// Phase 140 #14b — v3 ClawCode-channel delivery branch
//
// feedback_silent_path_bifurcation: pin BOTH branches.
//   - v3 target (getBridge returns a bridge) → bridge.push fires with an "a2a"
//     event; the webhook cascade is SKIPPED; inbox-write floor still ran.
//   - v2 target (getBridge returns undefined / absent) → NO push; the webhook
//     cascade runs exactly as before. A test that asserted only the v3 branch
//     would let a regression that always-pushes (or never-pushes) ship green.
// ---------------------------------------------------------------------------
describe("handlePostToAgentIpc — Phase 140 #14b v3 channel branch", () => {
  it("v3 target — pushes an a2a channel event, skips webhook, inbox floor still ran", async () => {
    const push = vi.fn();
    const { deps, writeInbox, sendAsAgent } = makeDeps({
      getBridge: (agent) => (agent === "projects" ? { push } : undefined),
    });

    const res = await handlePostToAgentIpc(
      { from: "admin-clawdy", to: "projects", message: "live ping" },
      deps,
    );

    expect(res).toEqual({ ok: true, delivered: true, messageId: "inbox-msg-1", via: "v3-channel" });
    // Inbox-write floor ran first (persistent record).
    expect(writeInbox).toHaveBeenCalledTimes(1);
    // Channel push fired with the right shape, reusing the inbox messageId.
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith({
      type: "a2a",
      message_id: "inbox-msg-1",
      content: "live ping",
      meta: { source_agent: "admin-clawdy" },
    });
    // The v2 webhook cascade was bypassed entirely.
    expect(sendAsAgent).not.toHaveBeenCalled();
  });

  it("v2 target — getBridge returns undefined → no push, webhook cascade unchanged", async () => {
    const push = vi.fn();
    const { deps, sendAsAgent } = makeDeps({
      // A bridge exists for some OTHER agent, but not the target — proves the
      // gate is per-target, not mere presence of the getBridge dep.
      getBridge: (agent) => (agent === "someone-else" ? { push } : undefined),
    });

    const res = await handlePostToAgentIpc(
      { from: "admin-clawdy", to: "projects", message: "hi" },
      deps,
    );

    expect(push).not.toHaveBeenCalled();
    // Unchanged v2 behavior: webhook delivery happened.
    expect(sendAsAgent).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ ok: true, delivered: true, messageId: "inbox-msg-1", via: "webhook" });
  });

  it("no getBridge dep at all — cascade unchanged (back-compat)", async () => {
    const { deps, sendAsAgent } = makeDeps(); // no getBridge override
    const res = await handlePostToAgentIpc(
      { from: "admin-clawdy", to: "projects", message: "hi" },
      deps,
    );
    expect(sendAsAgent).toHaveBeenCalledTimes(1);
    expect(res.delivered).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WS-0 quick 260716-u5h — acks are channel notifications, never turn inputs.
// The A2A webhook embed and the v3 bridge push both end as TURNS on the
// recipient (bridge forwards A2A embeds; the v3 push lands in chat) — the
// 2026-07-16 Admin Clawdy self-echo incident. Acks must bypass both and go
// bot-direct plain text (bridge drops plain bot posts).
// ---------------------------------------------------------------------------
describe("WS-0 quick 260716-u5h — kind 'ack' delivery (notification-only)", () => {
  beforeEach(() => {
    _resetNoWebhookFallbacks();
  });

  it("ack goes bot-direct plain text — NO webhook embed, NO v3 push; inbox audit record still written", async () => {
    const push = vi.fn();
    const sendText = vi.fn().mockResolvedValue(undefined);
    const { deps, sendAsAgent, writeInbox } = makeDeps({
      botDirectSender: { sendText },
      getBridge: () => ({ push }),
    });

    const res = await handlePostToAgentIpc(
      { from: "projects", to: "admin-clawdy", message: "✅ projects processed your message", kind: "ack" },
      { ...deps, agentChannels: new Map([["admin-clawdy", ["chan-admin"]]]) },
    );

    expect(writeInbox).toHaveBeenCalledTimes(1);
    expect(writeInbox.mock.calls[0][0].kind).toBe("ack");
    expect(sendText).toHaveBeenCalledWith("chan-admin", "✅ projects processed your message");
    expect(sendAsAgent).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: true, delivered: true, messageId: "inbox-msg-1", via: "bot-direct" });
  });

  it("ack falls back to the config channels when the routing table has no binding", async () => {
    const sendText = vi.fn().mockResolvedValue(undefined);
    const { deps } = makeDeps({
      botDirectSender: { sendText },
      configs: [
        { name: "projects", memoryPath: "/tmp/projects" },
        { name: "admin-clawdy", memoryPath: "/tmp/admin-clawdy", channels: ["cfg-chan"] },
      ],
      agentChannels: new Map(),
    });

    const res = await handlePostToAgentIpc(
      { from: "projects", to: "admin-clawdy", message: "ack!", kind: "ack" },
      deps,
    );

    expect(sendText).toHaveBeenCalledWith("cfg-chan", "ack!");
    expect(res.delivered).toBe(true);
  });

  it("ack with no bot-direct sender → delivered:false, reason ack-notification-only (never the webhook)", async () => {
    const { deps, sendAsAgent, calls } = makeDeps();

    const res = await handlePostToAgentIpc(
      { from: "admin-clawdy", to: "projects", message: "ack!", kind: "ack" },
      deps,
    );

    expect(sendAsAgent).not.toHaveBeenCalled();
    expect(res).toEqual({
      ok: true,
      delivered: false,
      messageId: "inbox-msg-1",
      reason: "ack-notification-only",
      // Phase 999.117 WS-0 — deliberately NO `via` here. The other rungs
      // name a transport that will drive a turn; an ack never does (it is
      // drained as a receipt). Tagging this "inbox" would import exactly the
      // kind of small lie `via` exists to remove. `reason` already says
      // precisely what happened.
    });
    expect(
      calls.some(
        (c) => c.msg === "post-to-agent skipped" && c.obj.reason === "ack-notification-only",
      ),
    ).toBe(true);
  });

  it("ack bot-direct failure degrades to delivered:false without throwing", async () => {
    const sendText = vi.fn().mockRejectedValue(new Error("discord 500"));
    const { deps } = makeDeps({ botDirectSender: { sendText } });

    const res = await handlePostToAgentIpc(
      { from: "admin-clawdy", to: "projects", message: "ack!", kind: "ack" },
      deps,
    );

    expect(res.delivered).toBe(false);
    expect(res.reason).toBe("ack-notification-only");
  });

  it("kind 'message' (and absent kind) is untouched by the ack branch — webhook cascade unchanged", async () => {
    const { deps, sendAsAgent } = makeDeps();
    const res = await handlePostToAgentIpc(
      { from: "admin-clawdy", to: "projects", message: "hi", kind: "message" },
      deps,
    );
    expect(sendAsAgent).toHaveBeenCalledTimes(1);
    expect(res.delivered).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WS-0 quick 260716-u5h — self-targeted post short-circuits to channel-only.
// A self-post means "put this in MY channel"; the inbox record and the v3
// push would both echo back into the agent as its own turn (2026-07-16
// Admin Clawdy incident chain: self-post → inbox turn → ack → turn → …).
// ---------------------------------------------------------------------------
describe("WS-0 quick 260716-u5h — self-target short-circuit (channel-only)", () => {
  beforeEach(() => {
    _resetNoWebhookFallbacks();
  });

  it("self-post delivers via plain-text webhook send — NO inbox write, NO A2A embed, NO v3 push", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const push = vi.fn();
    const { deps, sendAsAgent, writeInbox } = makeDeps({
      webhookManager: { hasWebhook: () => true, sendAsAgent: vi.fn(), send },
      getBridge: () => ({ push }),
    });

    const res = await handlePostToAgentIpc(
      { from: "admin-clawdy", to: "admin-clawdy", message: "background result: sync clean" },
      deps,
    );

    expect(send).toHaveBeenCalledWith("admin-clawdy", "background result: sync clean");
    expect(writeInbox).not.toHaveBeenCalled();
    expect(sendAsAgent).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
    expect(res.delivered).toBe(true);
    expect(res.messageId).toMatch(/^self-/);
  });

  it("self-post falls back to bot-direct when the webhook has no plain send", async () => {
    const sendText = vi.fn().mockResolvedValue(undefined);
    const { deps, writeInbox } = makeDeps({
      webhookManager: { hasWebhook: () => false, sendAsAgent: vi.fn() },
      botDirectSender: { sendText },
      agentChannels: new Map([["admin-clawdy", ["chan-admin"]]]),
    });

    const res = await handlePostToAgentIpc(
      { from: "admin-clawdy", to: "admin-clawdy", message: "hi me" },
      deps,
    );

    expect(sendText).toHaveBeenCalledWith("chan-admin", "hi me");
    expect(writeInbox).not.toHaveBeenCalled();
    expect(res.delivered).toBe(true);
  });

  it("self-post webhook failure degrades to bot-direct (config-channels fallback)", async () => {
    const send = vi.fn().mockRejectedValue(new Error("webhook 500"));
    const sendText = vi.fn().mockResolvedValue(undefined);
    const { deps } = makeDeps({
      webhookManager: { hasWebhook: () => true, sendAsAgent: vi.fn(), send },
      botDirectSender: { sendText },
      configs: [
        { name: "admin-clawdy", memoryPath: "/tmp/admin-clawdy", channels: ["cfg-chan"] },
      ],
      agentChannels: new Map(),
    });

    const res = await handlePostToAgentIpc(
      { from: "admin-clawdy", to: "admin-clawdy", message: "hi me" },
      deps,
    );

    expect(sendText).toHaveBeenCalledWith("cfg-chan", "hi me");
    expect(res.delivered).toBe(true);
  });

  it("self-post with no route → delivered:false, reason self-target-no-delivery, STILL no inbox write", async () => {
    const { deps, writeInbox, calls } = makeDeps({
      webhookManager: { hasWebhook: () => false, sendAsAgent: vi.fn() },
      agentChannels: new Map(),
    });

    const res = await handlePostToAgentIpc(
      { from: "admin-clawdy", to: "admin-clawdy", message: "hi me" },
      deps,
    );

    expect(writeInbox).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
    expect(res.delivered).toBe(false);
    expect(res.reason).toBe("self-target-no-delivery");
    expect(
      calls.some(
        (c) => c.msg === "post-to-agent skipped" && c.obj.reason === "self-target-no-delivery",
      ),
    ).toBe(true);
  });

  it("a self-ACK also short-circuits (no consumer to inform — no inbox record)", async () => {
    const sendText = vi.fn().mockResolvedValue(undefined);
    const { deps, writeInbox } = makeDeps({
      webhookManager: { hasWebhook: () => false, sendAsAgent: vi.fn() },
      botDirectSender: { sendText },
      agentChannels: new Map([["admin-clawdy", ["chan-admin"]]]),
    });

    const res = await handlePostToAgentIpc(
      { from: "admin-clawdy", to: "admin-clawdy", message: "✅ ack myself", kind: "ack" },
      deps,
    );

    expect(writeInbox).not.toHaveBeenCalled();
    expect(res.delivered).toBe(true);
  });

  it("cross-agent posts are untouched — inbox floor still written first", async () => {
    const { deps, writeInbox, sendAsAgent } = makeDeps();

    const res = await handlePostToAgentIpc(
      { from: "admin-clawdy", to: "projects", message: "hi" },
      deps,
    );

    expect(writeInbox).toHaveBeenCalledTimes(1);
    expect(sendAsAgent).toHaveBeenCalledTimes(1);
    expect(res.messageId).toBe("inbox-msg-1");
  });
});
