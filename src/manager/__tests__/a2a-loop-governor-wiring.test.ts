/**
 * Phase 999.117 WS-3 — production-wiring regression test.
 *
 * THE BUG THIS PINS: the first cut of the governor keyed `maxHops`,
 * `conversationCap` and `maxConsecutiveAutoReplies` on a conversation id
 * supplied by the CALLER. But `post_to_agent` and `ask_agent` accept only
 * {from, to, message}, and the recipient receives plain `[Message from X]: …`
 * text — it never sees an id, so it cannot thread one back. The envelope had
 * no return path, so in production every message arrived with no id, minted a
 * fresh one, and looked like hop 1 of a brand-new conversation. Three of the
 * four bounds were dead code; only the per-pair rate window fired.
 *
 * The unit tests all passed because they supplied `conversationId` explicitly
 * — they proved the governor bounds a THREADED exchange, not that production
 * threads one. This test drives the real entry point with the exact arguments
 * daemon.ts passes, so the gap cannot reopen.
 */

import { describe, it, expect, vi } from "vitest";
import {
  handlePostToAgentIpc,
  type PostToAgentDeps,
} from "../daemon-post-to-agent-ipc.js";
import {
  LoopGovernor,
  DEFAULT_LOOP_GOVERNOR_CONFIG,
  type LoopGovernorConfig,
} from "../../collaboration/loop-governor.js";

function makeDeps(governor: LoopGovernor): PostToAgentDeps {
  return {
    runningAgents: ["projects", "admin-clawdy"],
    configs: [
      { name: "admin-clawdy", memoryPath: "/tmp/a" },
      { name: "projects", memoryPath: "/tmp/p" },
    ],
    agentChannels: new Map([
      ["projects", ["chan-1"]],
      ["admin-clawdy", ["chan-2"]],
    ]),
    webhookManager: { hasWebhook: () => true, sendAsAgent: vi.fn() },
    writeInbox: vi.fn().mockResolvedValue({ messageId: "m" }),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    loopGovernor: governor,
  } as unknown as PostToAgentDeps;
}

function makeGovernor(overrides: Partial<LoopGovernorConfig> = {}) {
  let t = 1_000_000;
  const governor = new LoopGovernor({
    config: { ...DEFAULT_LOOP_GOVERNOR_CONFIG, ...overrides },
    now: () => t,
  });
  return { governor, advance: (ms: number) => void (t += ms) };
}

/** Exactly the argument shape daemon.ts passes — nothing more. */
function post(deps: PostToAgentDeps, from: string, to: string) {
  return handlePostToAgentIpc({ from, to, message: "hi" }, deps);
}

describe("999.117 WS-3 — bounds fire on the REAL production call shape", () => {
  it("terminates an A↔B ping-pong with NO envelope supplied by the caller", async () => {
    const { governor } = makeGovernor();
    const deps = makeDeps(governor);
    const pair = ["admin-clawdy", "projects"] as const;

    let delivered = 0;
    let blocked = false;
    for (let i = 0; i < 60; i++) {
      try {
        await post(deps, pair[i % 2], pair[(i + 1) % 2]);
        delivered++;
      } catch (err) {
        expect(String(err)).toMatch(/loop guard/);
        blocked = true;
        break;
      }
    }

    // Before the fix this ran all 60 iterations without a single block.
    expect(blocked).toBe(true);
    expect(delivered).toBeLessThanOrEqual(
      DEFAULT_LOOP_GOVERNOR_CONFIG.conversationCap,
    );
  });

  it("keeps a live exchange in ONE conversation with rising hop numbers", async () => {
    const seen: Array<{ conversationId: string; hops: number }> = [];
    const { governor } = makeGovernor({ mode: "shadow" });
    const spy = {
      evaluate: (i: Parameters<LoopGovernor["evaluate"]>[0]) => {
        const v = governor.evaluate(i);
        seen.push({ conversationId: v.conversationId, hops: v.hops });
        return v;
      },
    };
    const deps = makeDeps(spy as unknown as LoopGovernor);
    const pair = ["admin-clawdy", "projects"] as const;

    for (let i = 0; i < 4; i++) {
      await post(deps, pair[i % 2], pair[(i + 1) % 2]);
    }

    // One conversation, not four — and the depth actually advances, which is
    // what makes `maxHops` and `conversationCap` real.
    expect(new Set(seen.map((s) => s.conversationId)).size).toBe(1);
    expect(seen.map((s) => s.hops)).toEqual([1, 2, 3, 4]);
  });

  it("starts a NEW conversation after the pair goes quiet", async () => {
    const seen: string[] = [];
    const { governor, advance } = makeGovernor({
      mode: "shadow",
      conversationIdleMs: 1000,
    });
    const spy = {
      evaluate: (i: Parameters<LoopGovernor["evaluate"]>[0]) => {
        const v = governor.evaluate(i);
        seen.push(v.conversationId);
        return v;
      },
    };
    const deps = makeDeps(spy as unknown as LoopGovernor);

    await post(deps, "admin-clawdy", "projects");
    advance(5000); // longer than conversationIdleMs
    await post(deps, "admin-clawdy", "projects");

    // Two agents talking again an hour later are having a second
    // conversation, not slowly exhausting the first one's budget.
    expect(seen[0]).not.toBe(seen[1]);
  });
});
