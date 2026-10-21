/**
 * Phase 999.171 — per-turn thinking-token sink registry. Keyed by TURN id so
 * frames from one turn can never paint another turn's status trail.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  THINKING_SINK_TTL_MS,
  emitThinkingTokens,
  hasThinkingSink,
  registerThinkingSink,
  resetThinkingSinksForTests,
  type ThinkingTokensEvent,
} from "../thinking-sink.js";

describe("thinking-sink", () => {
  beforeEach(() => resetThinkingSinksForTests());

  it("delivers to the registered sink for that turn with a timestamp", () => {
    const got: ThinkingTokensEvent[] = [];
    registerThinkingSink("t1", (ev) => got.push(ev), 1000);
    expect(emitThinkingTokens("t1", { estimatedTokens: 2400 }, 1500)).toBe(1);
    expect(got).toEqual([{ estimatedTokens: 2400, at: 1500 }]);
  });

  it("does not deliver to sinks of a different turn", () => {
    const got: ThinkingTokensEvent[] = [];
    registerThinkingSink("t1", (ev) => got.push(ev), 1000);
    expect(emitThinkingTokens("t2", { estimatedTokens: 50 }, 1000)).toBe(0);
    expect(got).toEqual([]);
  });

  it("a throwing sink is isolated; a second sink still receives and emit never throws", () => {
    const got: number[] = [];
    registerThinkingSink("t", () => {
      throw new Error("renderer fault");
    }, 1000);
    registerThinkingSink("t", (ev) => got.push(ev.estimatedTokens), 1000);
    expect(() => emitThinkingTokens("t", { estimatedTokens: 185 }, 1000)).not.toThrow();
    expect(emitThinkingTokens("t", { estimatedTokens: 186 }, 1000)).toBe(1);
    expect(got).toEqual([185, 186]);
  });

  it("rejects invalid token counts without calling any sink", () => {
    let calls = 0;
    registerThinkingSink("t", () => {
      calls++;
    }, 1000);
    expect(emitThinkingTokens("t", { estimatedTokens: Number.NaN }, 1000)).toBe(0);
    expect(emitThinkingTokens("t", { estimatedTokens: -1 }, 1000)).toBe(0);
    expect(emitThinkingTokens("t", { estimatedTokens: Number.POSITIVE_INFINITY }, 1000)).toBe(0);
    expect(emitThinkingTokens("t", { estimatedTokens: "12" as unknown as number }, 1000)).toBe(0);
    expect(emitThinkingTokens("t", null as unknown as { estimatedTokens: number }, 1000)).toBe(0);
    expect(calls).toBe(0);
    expect(emitThinkingTokens("t", { estimatedTokens: 0 }, 1000)).toBe(1);
    expect(calls).toBe(1);
  });

  it("unregister removes the sink and is idempotent", () => {
    const off = registerThinkingSink("t", () => undefined, 1000);
    expect(hasThinkingSink("t")).toBe(true);
    off();
    off();
    expect(hasThinkingSink("t")).toBe(false);
    expect(emitThinkingTokens("t", { estimatedTokens: 10 }, 1000)).toBe(0);
  });

  it("unregistering one sink leaves the other sink for the same turn", () => {
    const got: string[] = [];
    const offA = registerThinkingSink("t", () => got.push("a"), 1000);
    registerThinkingSink("t", () => got.push("b"), 1000);
    offA();
    expect(emitThinkingTokens("t", { estimatedTokens: 1 }, 1000)).toBe(1);
    expect(got).toEqual(["b"]);
  });

  it("sinks older than the TTL are swept on the next emit", () => {
    registerThinkingSink("t", () => undefined, 1000);
    expect(emitThinkingTokens("t", { estimatedTokens: 1 }, 1000 + THINKING_SINK_TTL_MS + 1)).toBe(0);
    expect(hasThinkingSink("t")).toBe(false);
  });

  it("sinks older than the TTL are swept on the next register (any turn)", () => {
    registerThinkingSink("old", () => undefined, 1000);
    registerThinkingSink("new", () => undefined, 1000 + THINKING_SINK_TTL_MS + 1);
    expect(hasThinkingSink("old")).toBe(false);
    expect(hasThinkingSink("new")).toBe(true);
  });

  it("LO-01: a turn longer than 10 minutes keeps its sink, even with other turns registering meanwhile", () => {
    const MIN = 60_000;
    const got: number[] = [];
    registerThinkingSink("long", (ev) => got.push(ev.estimatedTokens), 1000);
    registerThinkingSink("other-agent-turn", () => undefined, 1000 + 11 * MIN); // global sweep
    expect(emitThinkingTokens("long", { estimatedTokens: 5 }, 1000 + 11 * MIN)).toBe(1);
    expect(emitThinkingTokens("long", { estimatedTokens: 6 }, 1000 + 45 * MIN)).toBe(1);
    expect(got).toEqual([5, 6]);
  });

  it("LO-01: the TTL outlasts the live-thinking controller's absolute cap (60 min), so it only reaps missed unregisters", () => {
    expect(THINKING_SINK_TTL_MS).toBeGreaterThan(60 * 60_000);
  });

  it("the event handed to sinks is frozen so one sink cannot alter what the next sees", () => {
    const seen: ThinkingTokensEvent[] = [];
    registerThinkingSink("t", (ev) => {
      seen.push(ev);
      (ev as { estimatedTokens: number }).estimatedTokens = 999_999;
    }, 1000);
    registerThinkingSink("t", (ev) => seen.push(ev), 1000);
    emitThinkingTokens("t", { estimatedTokens: 42 }, 1000);
    expect(seen.map((e) => e.estimatedTokens)).toEqual([42, 42]);
    expect(Object.isFrozen(seen[0])).toBe(true);
  });
});
