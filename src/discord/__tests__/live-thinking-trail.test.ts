/**
 * 999.171 — per-turn live-thinking controller.
 *
 * One controller per rendered turn: it subscribes to that turn's thinking
 * frames, shows them as the trail's current `→ thinking · N tokens` line,
 * and drives the repaint ticker so elapsed time keeps moving while nothing
 * else happens. It owns the phantom-notification guard (a thinking-only turn
 * posts nothing before the first-paint floor, and never once the answer has
 * started streaming) and writes one journal summary per turn.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StatusTrail } from "../hold-status.js";
import { startLiveThinking } from "../live-thinking-trail.js";
import {
  emitThinkingTokens,
  hasThinkingSink,
  resetThinkingSinksForTests,
} from "../../manager/thinking-sink.js";

const TICK_MS = 100;
const INTERVAL_MS = 750;

interface SetupOpts {
  readonly armed?: boolean;
  readonly draft?: boolean;
  readonly beyond?: boolean;
  readonly surface?: boolean;
  readonly firstPaintMinMs?: number;
  readonly turnId?: string;
  readonly paintThrows?: boolean;
  readonly summaryThrows?: boolean;
  readonly softMaxLifetimeMs?: number;
  readonly maxLifetimeMs?: number;
}

/**
 * The bridge's side of the contract, as mutable state. The default paint
 * behaves like paintTrail: it records the last edit time and, having posted
 * the status message, a painted surface now exists.
 */
function setup(opts: SetupOpts = {}) {
  const trail = new StatusTrail();
  const state = {
    armed: opts.armed ?? true,
    draft: opts.draft ?? false,
    beyond: opts.beyond ?? false,
    surface: opts.surface ?? false,
    startedAt: Date.now(),
    lastPaintAt: 0,
    /** sessionManager.hasActiveTurn; a function so a test can make it throw. */
    turnActive: (): boolean => true,
  };
  const paintTrail = vi.fn(async () => {
    if (opts.paintThrows === true) throw new Error("discord edit failed");
    state.lastPaintAt = Date.now();
    state.surface = true;
  });
  const onLifetimeCap = vi.fn();
  const onSummary = vi.fn((_s: { frames: number; peakTokens: number }) => {
    if (opts.summaryThrows === true) throw new Error("logger down");
  });
  const handle = startLiveThinking({
    turnId: opts.turnId ?? "turn-1",
    trail,
    paintTrail,
    isArmed: () => state.armed,
    isDraftStarted: () => state.draft,
    hasActivityBeyondThinking: () => state.beyond,
    hasPaintedSurface: () => state.surface,
    elapsedMs: () => Date.now() - state.startedAt,
    intervalMs: INTERVAL_MS,
    lastPaintAt: () => state.lastPaintAt,
    tickMs: TICK_MS,
    firstPaintMinMs: opts.firstPaintMinMs ?? 0,
    softMaxLifetimeMs: opts.softMaxLifetimeMs ?? 600_000,
    maxLifetimeMs: opts.maxLifetimeMs ?? 3_600_000,
    isTurnActive: () => state.turnActive(),
    onLifetimeCap,
    onSummary,
  });
  return { trail, state, paintTrail, onSummary, onLifetimeCap, handle };
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetThinkingSinksForTests();
});

afterEach(() => {
  vi.useRealTimers();
  resetThinkingSinksForTests();
});

describe("startLiveThinking", () => {
  it("registers a thinking sink for its turn and removes it on stop()", () => {
    const h = setup();
    expect(hasThinkingSink("turn-1")).toBe(true);
    h.handle.stop();
    expect(hasThinkingSink("turn-1")).toBe(false);
  });

  it("a thinking frame sets the trail's thinking line and paints within the interval", async () => {
    const h = setup();
    emitThinkingTokens("turn-1", { estimatedTokens: 2400 });
    expect(h.trail.thinkingSeen).toBe(true);
    expect(h.trail.renderSubtext("Thinking")).toContain("-# → thinking · 2.4k tokens");
    await advance(INTERVAL_MS);
    expect(h.paintTrail).toHaveBeenCalled();
    h.handle.stop();
  });

  it("a thinking-only turn with nothing posted stays silent below the first-paint floor, then the next tick paints", async () => {
    const h = setup({ firstPaintMinMs: 5_000 });
    emitThinkingTokens("turn-1", { estimatedTokens: 800 });
    await advance(4_900);
    expect(h.paintTrail).not.toHaveBeenCalled();
    await advance(200); // elapsed passes 5 s; the next 100 ms tick paints
    expect(h.paintTrail).toHaveBeenCalledTimes(1);
    h.handle.stop();
  });

  it("once a status surface exists, thinking-only paints are not delayed by the floor", async () => {
    const h = setup({ firstPaintMinMs: 5_000, surface: true });
    emitThinkingTokens("turn-1", { estimatedTokens: 800 });
    await advance(0);
    expect(h.paintTrail).toHaveBeenCalledTimes(1);
    h.handle.stop();
  });

  it("an unarmed trail is never painted by the controller", async () => {
    const h = setup({ armed: false, beyond: true, surface: true });
    emitThinkingTokens("turn-1", { estimatedTokens: 800 });
    h.handle.requestPaint();
    await advance(TICK_MS * 10);
    expect(h.paintTrail).not.toHaveBeenCalled();
    h.handle.stop();
  });

  it("after the draft started, thinking frames are counted but change nothing and request no paint", async () => {
    const h = setup({ draft: true, surface: true });
    emitThinkingTokens("turn-1", { estimatedTokens: 800 });
    emitThinkingTokens("turn-1", { estimatedTokens: 1_200 });
    await advance(TICK_MS * 5);
    expect(h.trail.thinkingSeen).toBe(false);
    expect(h.trail.renderSubtext("Working")).toBe("**Working**");
    expect(h.paintTrail).not.toHaveBeenCalled();
    h.handle.stop();
    expect(h.onSummary).toHaveBeenCalledWith({ frames: 2, peakTokens: 1_200 });
  });

  it("never makes a FIRST thinking-only post once the answer has started streaming", async () => {
    // A short think under the floor, then the answer streams. A tick past
    // 5 s must not post a new status message below the streaming answer.
    const h = setup({ firstPaintMinMs: 5_000 });
    emitThinkingTokens("turn-1", { estimatedTokens: 185 });
    await advance(3_000);
    h.state.draft = true;
    await advance(4_000);
    expect(h.paintTrail).not.toHaveBeenCalled();
    h.handle.stop();
  });

  it("LO-03: once the answer draft starts, the ticker stops repainting (the trail is frozen then), but frames still count", async () => {
    const h = setup({ beyond: true, surface: true });
    await advance(INTERVAL_MS * 2);
    expect(h.paintTrail).toHaveBeenCalled();
    h.state.draft = true; // the answer is streaming into its own message
    await advance(TICK_MS * 2);
    const atDraft = h.paintTrail.mock.calls.length;
    vi.setSystemTime(Date.now() + 61_000); // a new elapsed header a live ticker would paint
    await advance(TICK_MS * 50);
    expect(h.paintTrail.mock.calls.length).toBe(atDraft);
    // Not a full stop: the sink stays, so the journal still counts late frames.
    expect(hasThinkingSink("turn-1")).toBe(true);
    emitThinkingTokens("turn-1", { estimatedTokens: 900 });
    h.handle.stop();
    expect(h.onSummary).toHaveBeenCalledWith({ frames: 1, peakTokens: 900 });
  });

  it("with no activity at all (no thinking, tools or claims) the ticker never paints", async () => {
    const h = setup({ surface: true });
    await advance(TICK_MS * 10);
    expect(h.paintTrail).not.toHaveBeenCalled();
    h.handle.stop();
  });

  it("with tool activity the ticker keeps repainting, so elapsed moves during a long tool", async () => {
    const h = setup({ beyond: true, surface: true });
    await advance(INTERVAL_MS * 4);
    // One paint per interval at most: the 100 ms ticks inside it coalesce.
    expect(h.paintTrail.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(h.paintTrail.mock.calls.length).toBeLessThanOrEqual(5);
    h.handle.stop();
  });

  it("requestPaint() is the throttled catch-up entry: a request inside the interval paints once, later", async () => {
    const h = setup({ beyond: true, surface: true });
    h.state.lastPaintAt = Date.now(); // the tool writer just painted
    h.handle.requestPaint();
    h.handle.requestPaint();
    await advance(INTERVAL_MS - 50);
    expect(h.paintTrail).not.toHaveBeenCalled();
    await advance(60);
    expect(h.paintTrail).toHaveBeenCalledTimes(1);
    h.handle.stop();
  });

  it("stop() is idempotent, ends the ticker, and reports one summary with frames and peak", async () => {
    const h = setup({ beyond: true, surface: true });
    emitThinkingTokens("turn-1", { estimatedTokens: 800 });
    emitThinkingTokens("turn-1", { estimatedTokens: 2_400 });
    emitThinkingTokens("turn-1", { estimatedTokens: 300 }); // a new block restarts its count
    await advance(INTERVAL_MS);
    h.handle.stop();
    h.handle.stop();
    const paintsAtStop = h.paintTrail.mock.calls.length;
    emitThinkingTokens("turn-1", { estimatedTokens: 9_000 });
    h.handle.requestPaint();
    await advance(TICK_MS * 20);
    expect(h.paintTrail.mock.calls.length).toBe(paintsAtStop);
    expect(h.onSummary).toHaveBeenCalledTimes(1);
    expect(h.onSummary).toHaveBeenCalledWith({ frames: 3, peakTokens: 2_400 });
  });

  it("a turn that never received a thinking frame writes no summary", () => {
    const h = setup();
    h.handle.stop();
    expect(h.onSummary).not.toHaveBeenCalled();
  });

  it("thinking frames for another turn id never touch this trail (SC-4)", async () => {
    const h = setup({ surface: true });
    emitThinkingTokens("turn-other", { estimatedTokens: 5_000 });
    await advance(TICK_MS * 10);
    expect(h.trail.thinkingSeen).toBe(false);
    expect(h.trail.renderSubtext("Working")).not.toContain("5.0k");
    expect(h.paintTrail).not.toHaveBeenCalled();
    h.handle.stop();
    expect(h.onSummary).not.toHaveBeenCalled();
  });

  describe("postedThinkingOnly (what the settle keys on)", () => {
    it("latches when the controller's own floor-passing paint made the first post, and stays readable after stop()", async () => {
      const h = setup({ firstPaintMinMs: 5_000 });
      emitThinkingTokens("turn-1", { estimatedTokens: 800 });
      await advance(4_900);
      expect(h.handle.postedThinkingOnly).toBe(false);
      await advance(200);
      expect(h.paintTrail).toHaveBeenCalledTimes(1);
      expect(h.handle.postedThinkingOnly).toBe(true);
      h.handle.stop();
      expect(h.handle.postedThinkingOnly).toBe(true);
    });

    it("stays false when another path (narration, a tool, a claim) posted the surface while thinking was under the floor", async () => {
      const h = setup({ firstPaintMinMs: 5_000 });
      emitThinkingTokens("turn-1", { estimatedTokens: 800 });
      await advance(2_000);
      h.state.surface = true; // narration-as-trail posted the card
      await advance(6_000); // past the floor: the ticker now edits that card
      expect(h.paintTrail).toHaveBeenCalled();
      h.handle.stop();
      expect(h.handle.postedThinkingOnly).toBe(false);
    });

    it("stays false when the first post carried tool or claim activity", async () => {
      const h = setup({ beyond: true });
      emitThinkingTokens("turn-1", { estimatedTokens: 800 });
      await advance(INTERVAL_MS * 2);
      expect(h.paintTrail).toHaveBeenCalled();
      h.handle.stop();
      expect(h.handle.postedThinkingOnly).toBe(false);
    });
  });

  describe("lifetime caps (the typing heartbeat's soft / absolute semantics)", () => {
    const CAPS = { softMaxLifetimeMs: 10_000, maxLifetimeMs: 60_000 } as const;

    it("past the soft cap the ticker keeps going while the turn is active, and stops once it is not", async () => {
      const h = setup({ beyond: true, surface: true, ...CAPS });
      emitThinkingTokens("turn-1", { estimatedTokens: 800 });
      await advance(12_000);
      const paints = h.paintTrail.mock.calls.length;
      await advance(2_000);
      expect(h.paintTrail.mock.calls.length).toBeGreaterThan(paints); // active: still repainting
      expect(h.onLifetimeCap).not.toHaveBeenCalled();
      h.state.turnActive = () => false; // the dispatch never settled, but no turn is running: wedged
      await advance(TICK_MS * 2);
      const atCap = h.paintTrail.mock.calls.length;
      await advance(TICK_MS * 50);
      expect(h.paintTrail.mock.calls.length).toBe(atCap);
      expect(h.onLifetimeCap).toHaveBeenCalledTimes(1);
      expect(hasThinkingSink("turn-1")).toBe(false);
      expect(h.onSummary).toHaveBeenCalledTimes(1);
      h.handle.stop(); // the bridge's own stop later is a no-op
      expect(h.onSummary).toHaveBeenCalledTimes(1);
    });

    it("past the absolute cap the ticker stops even though the turn still reads as active", async () => {
      const h = setup({ beyond: true, surface: true, ...CAPS });
      await advance(59_000);
      expect(h.onLifetimeCap).not.toHaveBeenCalled();
      await advance(2_000);
      const atCap = h.paintTrail.mock.calls.length;
      await advance(TICK_MS * 50);
      expect(h.paintTrail.mock.calls.length).toBe(atCap);
      expect(h.onLifetimeCap).toHaveBeenCalledTimes(1);
    });

    it("an unarmed or idle ticker self-stops at the cap too (the check runs before the paint guards)", async () => {
      const h = setup({ armed: false, ...CAPS });
      await advance(61_000);
      expect(h.paintTrail).not.toHaveBeenCalled();
      expect(h.onLifetimeCap).toHaveBeenCalledTimes(1);
      expect(hasThinkingSink("turn-1")).toBe(false);
    });

    it("a throwing turn-activity probe past the soft cap stops the ticker instead of escaping", async () => {
      const h = setup({ beyond: true, surface: true, ...CAPS });
      h.state.turnActive = () => {
        throw new Error("session manager gone");
      };
      await advance(11_000);
      expect(h.onLifetimeCap).toHaveBeenCalledTimes(1);
      const atCap = h.paintTrail.mock.calls.length;
      await advance(TICK_MS * 20);
      expect(h.paintTrail.mock.calls.length).toBe(atCap);
    });
  });

  it("a failing paint or summary never escapes the controller", async () => {
    const h = setup({ beyond: true, surface: true, paintThrows: true, summaryThrows: true });
    expect(() => emitThinkingTokens("turn-1", { estimatedTokens: 800 })).not.toThrow();
    await advance(INTERVAL_MS * 2);
    expect(h.paintTrail).toHaveBeenCalled();
    expect(() => h.handle.stop()).not.toThrow();
    expect(h.onSummary).toHaveBeenCalledTimes(1);
  });
});
