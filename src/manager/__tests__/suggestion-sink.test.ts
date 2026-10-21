/**
 * Phase 999.172 — prompt-suggestion rendezvous + routing.
 *
 * The CLI emits `prompt_suggestion` after `result` (measured ~1 s on 2.1.280,
 * ~11 s on 2.1.282); the bridge records the delivered reply after table
 * planning / hold verification. Either can arrive first, so the sink pairs
 * them per turn id, and a suggestion with no reply record expires (journaled
 * `no-reply-record`: chunked replies, v3, non-Discord turns).
 *
 * `routePromptSuggestion` is the safety gate: only a daemon turn started by
 * sendAndStream (a Discord-user turn with a turn id) is offered. Everything
 * else — self-fired/orphan turns, send()/sendAndCollect() turns (cron, IPC,
 * ask-agent: the Event Dossier's tick and collector wakes), superseded
 * suggestions — is dropped with a reason.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SUGGESTION_SINK_TTL_MS,
  offerPromptSuggestion,
  registerSuggestionReply,
  resetSuggestionSinkForTests,
  routePromptSuggestion,
  setSuggestionDropLogger,
  type SuggestionDropEvent,
} from "../suggestion-sink.js";

afterEach(() => {
  resetSuggestionSinkForTests();
});

function captureDrops(): SuggestionDropEvent[] {
  const drops: SuggestionDropEvent[] = [];
  setSuggestionDropLogger((ev) => drops.push(ev));
  return drops;
}

describe("rendezvous", () => {
  it("suggestion first, then the reply record → attach fires once with the suggestion", () => {
    const attach = vi.fn();
    offerPromptSuggestion("discord:1", "What next?", { agentName: "personal" }, 1_000);
    registerSuggestionReply("discord:1", { agentName: "personal", messageId: "m1", attach }, 2_000);
    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith("What next?");
  });

  it("reply record first, then the suggestion (the ~11 s case) → attach fires", () => {
    const attach = vi.fn();
    registerSuggestionReply("discord:2", { agentName: "personal", messageId: "m2", attach }, 1_000);
    offerPromptSuggestion("discord:2", "Book it", { agentName: "personal" }, 12_000);
    expect(attach).toHaveBeenCalledWith("Book it");
  });

  it("pairs are consumed: a second suggestion for the same turn does not re-attach", () => {
    const attach = vi.fn();
    registerSuggestionReply("discord:3", { agentName: "personal", messageId: "m3", attach }, 0);
    offerPromptSuggestion("discord:3", "one", { agentName: "personal" }, 10);
    offerPromptSuggestion("discord:3", "two", { agentName: "personal" }, 20);
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it("a suggestion whose reply never records expires with `no-reply-record`", () => {
    const drops = captureDrops();
    offerPromptSuggestion("discord:4", "orphaned", { agentName: "personal" }, 0);
    // Any later sink call sweeps.
    registerSuggestionReply("discord:other", { agentName: "personal", messageId: "x", attach: vi.fn() }, SUGGESTION_SINK_TTL_MS + 1);
    expect(drops).toEqual([expect.objectContaining({ turnId: "discord:4", agentName: "personal", reason: "no-reply-record" })]);
  });

  it("a reply record with no suggestion expires silently (most replies get none)", () => {
    const drops = captureDrops();
    const attach = vi.fn();
    registerSuggestionReply("discord:5", { agentName: "personal", messageId: "m5", attach }, 0);
    offerPromptSuggestion("discord:5", "too late", { agentName: "personal" }, SUGGESTION_SINK_TTL_MS + 1);
    expect(attach).not.toHaveBeenCalled();
    // The late suggestion is now waiting on its own; the stale record left no drop entry.
    expect(drops).toEqual([]);
  });

  it("an attach that throws (sync or async) never escapes the sink", async () => {
    registerSuggestionReply("discord:6", { agentName: "a", messageId: "m", attach: () => { throw new Error("boom"); } }, 0);
    expect(() => offerPromptSuggestion("discord:6", "x", { agentName: "a" }, 1)).not.toThrow();
    registerSuggestionReply("discord:7", { agentName: "a", messageId: "m", attach: () => Promise.reject(new Error("async boom")) }, 0);
    expect(() => offerPromptSuggestion("discord:7", "x", { agentName: "a" }, 1)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe("routePromptSuggestion — the safety gate", () => {
  const lookup = (map: Record<number, string>) => (token: number): string | undefined => map[token];

  it("offers a Discord sendAndStream turn by its turn id", () => {
    expect(
      routePromptSuggestion(
        { suggestion: "What next?", attribution: { kind: "daemon", token: 7 }, superseded: false },
        lookup({ 7: "discord:123" }),
      ),
    ).toEqual({ kind: "offer", turnId: "discord:123", suggestion: "What next?" });
  });

  it("drops a send()/sendAndCollect() turn (cron, IPC, ask-agent — Event Dossier wakes) as no-discord-turn", () => {
    expect(
      routePromptSuggestion(
        { suggestion: "Chase the bib email?", attribution: { kind: "daemon", token: 8 }, superseded: false },
        lookup({}),
      ),
    ).toEqual({ kind: "drop", reason: "no-discord-turn" });
  });

  it("drops a self-fired (orphan) turn", () => {
    expect(
      routePromptSuggestion({ suggestion: "x", attribution: { kind: "orphan", token: null }, superseded: false }, lookup({})),
    ).toEqual({ kind: "drop", reason: "orphan" });
  });

  it("drops a suggestion superseded by a newer send or turn", () => {
    expect(
      routePromptSuggestion(
        { suggestion: "x", attribution: { kind: "daemon", token: 7 }, superseded: true },
        lookup({ 7: "discord:1" }),
      ),
    ).toEqual({ kind: "drop", reason: "superseded" });
  });

  it("drops an ambiguous frame (another close in the window may own it)", () => {
    expect(
      routePromptSuggestion(
        { suggestion: "x", attribution: { kind: "daemon", token: 7 }, superseded: false, ambiguous: true },
        lookup({ 7: "discord:1" }),
      ),
    ).toEqual({ kind: "drop", reason: "ambiguous" });
  });

  it("drops when no turn has closed yet", () => {
    expect(routePromptSuggestion({ suggestion: "x", attribution: null, superseded: false }, lookup({}))).toEqual({
      kind: "drop",
      reason: "no-turn",
    });
  });

  it("drops an empty or non-string suggestion", () => {
    expect(
      routePromptSuggestion({ suggestion: "   ", attribution: { kind: "daemon", token: 7 }, superseded: false }, lookup({ 7: "d" })),
    ).toEqual({ kind: "drop", reason: "empty" });
    expect(
      routePromptSuggestion(
        { suggestion: 5 as unknown as string, attribution: { kind: "daemon", token: 7 }, superseded: false },
        lookup({ 7: "d" }),
      ),
    ).toEqual({ kind: "drop", reason: "empty" });
  });
});
