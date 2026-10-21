import { afterEach, describe, expect, it } from "vitest";
import type { PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import {
  DEFAULT_USAGE_GUARD,
  USAGE_REDUCED_DENY_TEXT,
  evaluateUsageGuard,
  formatResetAt,
  setResearchUsageProvider,
  usageDenyText,
  usageStatusLine,
  type UsageSnapshotLike,
} from "../research-usage-guard.js";
import { decideResearchLaunch } from "../research-launch-gate.js";
import { registerResearchTracker, resetResearchRegistryForTests, setLiveDiscordTurn } from "../research-registry.js";
import { ResearchTracker } from "../research-tracker.js";

const NOW = Date.UTC(2026, 8, 25, 21, 0, 0); // 2:00 PM PT
const RESET_530 = Date.UTC(2026, 8, 26, 0, 30, 0); // 5:30 PM PT on 09-25

const snap = (o: Partial<UsageSnapshotLike>): UsageSnapshotLike => ({
  rateLimitType: "five_hour",
  status: "allowed",
  utilization: 0.1,
  resetsAt: RESET_530,
  recordedAt: NOW - 60_000,
  ...o,
});

afterEach(() => {
  setResearchUsageProvider(undefined);
  resetResearchRegistryForTests();
});

describe("usage guard bands (999.173 polish)", () => {
  it("below reduceAt → normal", () => {
    expect(evaluateUsageGuard([snap({ utilization: 0.5 })], NOW).band).toBe("normal");
  });
  it("≥ reduceAt → reduce", () => {
    expect(evaluateUsageGuard([snap({ utilization: 0.72 })], NOW).band).toBe("reduce");
  });
  it("≥ blockAt → block, with the reset time", () => {
    const s = evaluateUsageGuard([snap({ utilization: 0.9 })], NOW);
    expect(s).toMatchObject({ band: "block", limited: false, resetsAt: RESET_530 });
  });
  it("already limited (rejected) → block even with low utilization", () => {
    expect(evaluateUsageGuard([snap({ status: "rejected", utilization: undefined })], NOW)).toMatchObject({
      band: "block",
      limited: true,
    });
  });
  it("the worst window wins: weekly at 88% blocks even when the 5-hour window is fine", () => {
    const s = evaluateUsageGuard(
      [snap({ utilization: 0.2 }), snap({ rateLimitType: "seven_day", utilization: 0.88, resetsAt: RESET_530 + 86_400_000 })],
      NOW,
    );
    expect(s).toMatchObject({ band: "block", window: "seven_day" });
  });
  it("freshest snapshot per window wins across agents", () => {
    const s = evaluateUsageGuard([snap({ utilization: 0.95, recordedAt: NOW - 3_600_000 }), snap({ utilization: 0.4, recordedAt: NOW - 60_000 })], NOW);
    expect(s.band).toBe("normal");
  });
  it("custom thresholds", () => {
    expect(evaluateUsageGuard([snap({ utilization: 0.6 })], NOW, { reduceAt: 0.5, blockAt: 0.6 }).band).toBe("block");
  });
});

describe("usage guard signal quality (999.173 polish)", () => {
  it("no data at all → unknown (fail open)", () => {
    expect(evaluateUsageGuard([], NOW).band).toBe("unknown");
    expect(evaluateUsageGuard([snap({ rateLimitType: "overage", utilization: 0.99 })], NOW).band).toBe("unknown");
  });
  it("a window that already reset counts as 0 %", () => {
    expect(evaluateUsageGuard([snap({ utilization: 0.99, resetsAt: NOW - 1 })], NOW).band).toBe("normal");
    expect(evaluateUsageGuard([snap({ status: "rejected", resetsAt: NOW - 1 })], NOW).band).toBe("normal");
  });
  it("a stale snapshot with no reset time is ignored", () => {
    expect(evaluateUsageGuard([snap({ utilization: 0.99, resetsAt: undefined, recordedAt: NOW - 7 * 3_600_000 })], NOW).band).toBe("unknown");
  });
  it("allowed with no utilization carries no signal", () => {
    expect(evaluateUsageGuard([snap({ utilization: undefined })], NOW).band).toBe("unknown");
  });
});

describe("usage guard texts (999.173 polish)", () => {
  it("deny text names the reset time and tells the model to answer inline", () => {
    expect(formatResetAt(RESET_530)).toBe("5:30 PM PT");
    const near = usageDenyText(evaluateUsageGuard([snap({ utilization: 0.9 })], NOW), NOW);
    expect(near).toContain("90% used (resets 5:30 PM PT)");
    expect(near).toMatch(/Answer inline/);
    expect(near).toMatch(/research is paused/);
    const hit = usageDenyText(evaluateUsageGuard([snap({ status: "rejected" })], NOW), NOW);
    expect(hit).toContain("The Claude usage limit is reached (resets 5:30 PM PT).");
  });
  it("status line for each band", () => {
    const t = DEFAULT_USAGE_GUARD;
    expect(usageStatusLine(evaluateUsageGuard([], NOW), t, NOW)).toBe("Usage guard: no usage data yet, launches allowed (reduce at 70%, block at 85%).");
    expect(usageStatusLine(evaluateUsageGuard([snap({ utilization: 0.72 })], NOW), t, NOW)).toBe(
      "Usage guard: 72% of the 5-hour window, resets 5:30 PM PT — limited to 1 researcher per request (reduce at 70%, block at 85%).",
    );
    expect(usageStatusLine(evaluateUsageGuard([snap({ status: "rejected" })], NOW), t, NOW)).toBe(
      "Usage guard: limit reached, resets 5:30 PM PT — research paused (reduce at 70%, block at 85%).",
    );
  });
});

describe("usage guard in the launch gate (999.173 polish)", () => {
  const AGENT = "fin-client";
  const ORIGIN = { turnId: "discord:000000000000000118", messageId: "000000000000000118", channelId: "c" };
  const ORIGIN_B = { turnId: "discord:000000000000000119", messageId: "000000000000000119", channelId: "c" };
  const launch = () =>
    ({
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "researcher" },
      tool_use_id: "tu",
      session_id: "s",
      transcript_path: "/t",
      cwd: "/",
    }) as unknown as PreToolUseHookInput;
  const tracker = () => {
    const t = new ResearchTracker({
      agentName: AGENT,
      maxConcurrent: 4,
      holdTimeoutMs: 60_000,
      stopTask: () => undefined,
      deliver: () => undefined,
      log: { info: () => undefined, warn: () => undefined },
    });
    registerResearchTracker(AGENT, t);
    return t;
  };

  it("block band denies every launch with the reset time", () => {
    tracker();
    setLiveDiscordTurn(AGENT, ORIGIN);
    setResearchUsageProvider(() => [snap({ utilization: 0.9, recordedAt: Date.now() - 1000, resetsAt: Date.now() + 3_600_000 })]);
    const d = decideResearchLaunch(AGENT, 4, launch(), "t1");
    expect(d.kind).toBe("deny");
    expect((d as { reason: string }).reason).toMatch(/resets .* PT/);
  });

  it("reduce band: at most 1 researcher per origin, another origin still gets its one", () => {
    const t = tracker();
    setResearchUsageProvider(() => [snap({ utilization: 0.75, recordedAt: Date.now() - 1000, resetsAt: Date.now() + 3_600_000 })]);
    setLiveDiscordTurn(AGENT, ORIGIN);
    expect(decideResearchLaunch(AGENT, 4, launch(), "a1").kind).toBe("allow");
    const second = decideResearchLaunch(AGENT, 4, launch(), "a2");
    expect(second).toEqual({ kind: "deny", reason: USAGE_REDUCED_DENY_TEXT });
    setLiveDiscordTurn(AGENT, ORIGIN_B);
    expect(decideResearchLaunch(AGENT, 4, launch(), "b1").kind).toBe("allow");
    // The card for the reduced origin says so.
    t.observe({ type: "system", subtype: "task_started", task_id: "x1", tool_use_id: "a1", description: "d", subagent_type: "researcher" });
    const view = (t as unknown as { active: Map<string, { usageLimited: boolean }> }).active.get(ORIGIN.turnId)!;
    expect(view.usageLimited).toBe(true);
  });

  it("normal band: the normal cap applies", () => {
    tracker();
    setLiveDiscordTurn(AGENT, ORIGIN);
    setResearchUsageProvider(() => [snap({ utilization: 0.3, recordedAt: Date.now() - 1000, resetsAt: Date.now() + 3_600_000 })]);
    for (const id of ["a", "b", "c", "d"]) expect(decideResearchLaunch(AGENT, 4, launch(), id).kind).toBe("allow");
    expect(decideResearchLaunch(AGENT, 4, launch(), "e").kind).toBe("deny");
  });

  it("no usage data → fail open", () => {
    tracker();
    setLiveDiscordTurn(AGENT, ORIGIN);
    setResearchUsageProvider(() => []);
    expect(decideResearchLaunch(AGENT, 4, launch(), "a1").kind).toBe("allow");
    setResearchUsageProvider(() => {
      throw new Error("tracker db gone");
    });
    expect(decideResearchLaunch(AGENT, 4, launch(), "a2").kind).toBe("allow");
  });
});

describe("usage guard account epoch (2026-09-26 fix)", () => {
  // The prod data that wrongly blocked research: the old admin account's
  // overage-inclusive weekly window (92%, resets Sep 30 09:00Z, recorded on
  // 09-24) lingered in usage.db after the swap to the main account, whose
  // weekly window resets Oct 1 20:00Z.
  const now = Date.parse("2026-09-26T14:38:00Z");
  const OLD_WEEK = Date.parse("2026-09-30T09:00:00Z");
  const NEW_WEEK = Date.parse("2026-10-01T20:00:00Z");
  const FIVE_H = Date.parse("2026-09-26T16:20:00Z");

  it("ignores a previous account's weekly windows (different weekly reset)", () => {
    const state = evaluateUsageGuard(
      [
        snap({ rateLimitType: "seven_day_overage_included", status: "allowed_warning", utilization: 0.92, resetsAt: OLD_WEEK, recordedAt: Date.parse("2026-09-24T20:57:00Z") }),
        snap({ rateLimitType: "seven_day", status: "allowed_warning", utilization: 0.74, resetsAt: OLD_WEEK, recordedAt: Date.parse("2026-09-25T23:09:00Z") }),
        snap({ rateLimitType: "seven_day", status: "allowed_warning", utilization: 0.29, resetsAt: NEW_WEEK, recordedAt: Date.parse("2026-09-26T09:08:00Z") }),
        snap({ rateLimitType: "five_hour", status: "allowed", utilization: undefined, resetsAt: FIVE_H, recordedAt: now - 7 * 60_000 }),
      ],
      now,
    );
    expect(state.band).toBe("normal");
    expect(state.utilization).toBe(0.29);
  });

  it("a signal not refreshed in 24h is ignored even with a future reset (fails open)", () => {
    const state = evaluateUsageGuard(
      [snap({ rateLimitType: "seven_day", status: "allowed_warning", utilization: 0.92, resetsAt: NEW_WEEK, recordedAt: now - 30 * 60 * 60_000 })],
      now,
    );
    expect(state.band).toBe("unknown");
  });

  it("the live account's own high weekly usage still blocks", () => {
    const state = evaluateUsageGuard(
      [snap({ rateLimitType: "seven_day", status: "allowed_warning", utilization: 0.9, resetsAt: NEW_WEEK, recordedAt: now - 60_000 })],
      now,
    );
    expect(state.band).toBe("block");
  });
});
