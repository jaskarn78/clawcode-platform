/**
 * 2026-08-27 — separate verification status message
 * (`verification.ux.statusMessage: "separate"`).
 *
 * Operator report: "I only saw the verify status updates briefly and then
 * they were immediately replaced/edited with the content." The trail and the
 * answer shared ONE slot message, so the answer necessarily destroyed the
 * trail. These tests pin the split:
 *
 *   - the trail gets its OWN message, distinct from the answer message;
 *   - it is posted as soon as the topic gate arms (no 3-event / 20 s wait);
 *   - it settles to a one-line summary at delivery and is never overwritten
 *     by a paint still in flight;
 *   - a turn that armed but did no verification work deletes it;
 *   - "inline" (the default) keeps the legacy shared-slot behaviour.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Attachment, Collection, Message } from "discord.js";
import { emitClaim, resetClaimSinksForTests } from "../../manager/claim-sink.js";

vi.mock("../attachments.js", () => ({
  extractAttachments: vi.fn(),
  downloadAllAttachments: vi.fn(),
  formatAttachmentMetadata: vi.fn(),
  isImageAttachment: vi.fn(),
}));

interface SentMessage {
  id: string;
  content: string;
  edits: unknown[];
  deleted: boolean;
  edit: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  react: ReturnType<typeof vi.fn>;
}

function makeMessage(sent: SentMessage[]) {
  const attMap = new Map<string, Attachment>();
  const collection = {
    size: 0,
    values: () => attMap.values(),
    [Symbol.iterator]: () => attMap.values(),
    map: <T,>(_fn: (a: Attachment) => T): T[] => [],
  } as unknown as Collection<string, Attachment>;
  const asText = (c: unknown): string => (typeof c === "string" ? c : ((c as { content?: string })?.content ?? ""));
  const send = vi.fn().mockImplementation(async (payload: unknown) => {
    const content = asText(payload);
    const m: SentMessage = {
      id: `sent-${sent.length + 1}`,
      content,
      edits: [],
      deleted: false,
      edit: vi.fn().mockImplementation(async (c: unknown) => { m.edits.push(asText(c)); return undefined; }),
      delete: vi.fn().mockImplementation(async () => { m.deleted = true; return undefined; }),
      react: vi.fn().mockResolvedValue(undefined),
    };
    sent.push(m);
    return m;
  });
  return {
    content: "what is the 2026 401(k) contribution limit and the RMD age",
    channelId: "chan-1",
    id: "000000000000000004",
    author: { username: "client-a", bot: false, id: "u-1" },
    createdAt: new Date("2026-08-27T00:00:00Z"),
    attachments: collection,
    reference: null,
    webhookId: null,
    embeds: [],
    react: vi.fn().mockResolvedValue(undefined),
    channel: { sendTyping: vi.fn(), send },
  } as unknown as Message;
}

const UX_BASE = { streamStatus: true, streamStatusMode: "always" as const, liveClaims: true };

/**
 * `turn` is a PARAMETER of streamAndPostResponse (handleMessage builds it and
 * passes it down). The claim sink registers under `turn.id`, so a test that
 * omits it silently loses every claim line.
 */
function makeTurn(id = "turn-1") {
  return {
    id,
    startSpan: () => ({ end: () => undefined, setAttribute: () => undefined }),
    recordToolCall: () => undefined,
    recordToolResultText: () => undefined,
    recordEvidence: () => undefined,
    recordClaim: () => undefined,
    getEvidence: () => [],
    getClaims: () => [],
    getToolResultText: () => "",
    end: () => undefined,
  } as never;
}

describe("separate verification status message", () => {
  let DiscordBridge: typeof import("../bridge.js").DiscordBridge;
  let advisorEvents: EventEmitter;
  const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const routingTable = {
    channelToAgent: new Map([["chan-1", "fin-client"]]),
    agentToChannels: new Map([["fin-client", ["chan-1"]]]),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    resetClaimSinksForTests();
    advisorEvents = new EventEmitter();
    DiscordBridge = (await import("../bridge.js")).DiscordBridge;
  });

  function makeBridge(ux: Record<string, unknown>) {
    const bridge = new DiscordBridge({
      routingTableRef: { current: routingTable },
      sessionManager: {
        forwardToAgent: vi.fn(),
        streamFromAgent: vi.fn(),
        getAgentConfig: vi.fn().mockReturnValue({
          workspace: "/tmp/fin",
          verification: { enforced: true, ux },
        }),
        getTraceCollector: vi.fn().mockReturnValue(undefined),
        advisorEvents,
      } as never,
      botToken: "fake-token",
      log: log as never,
    });
    (bridge as unknown as { sendResponse: unknown }).sendResponse = vi.fn().mockResolvedValue(undefined);
    return bridge;
  }

  /** Drives a turn: emits tool activity + claims, then streams the answer. */
  function wireDispatcher(
    bridge: InstanceType<typeof DiscordBridge>,
    opts: { answer: string; claims?: number; tools?: boolean },
  ) {
    const dispatchStream = vi.fn().mockImplementation(
      async (
        _origin: unknown,
        _agent: string,
        _formatted: string,
        onChunk: (s: string) => void,
        options?: { onToolUse?: (n: string, i?: unknown) => void; turnId?: string },
      ) => {
        if (opts.tools !== false) {
          options?.onToolUse?.("WebFetch", { url: "https://www.irs.gov/retirement-plans" });
          options?.onToolUse?.("WebSearch", { query: "2026 401k limit" });
        }
        for (let i = 0; i < (opts.claims ?? 0); i++) {
          emitClaim("turn-1", {
            id: `c${i + 1}`,
            turnId: "turn-1",
            claim: `claim number ${i + 1}`,
            verdict: "verified",
            effectiveVerdict: "verified",
            sourceStatus: "in-ledger",
            sourceHost: "irs.gov",
            quoteStatus: "absent",
            origin: "tool",
            at: Date.now(),
            ledgerBacked: true,
          } as never);
        }
        onChunk(opts.answer);
        await new Promise((r) => setTimeout(r, 5));
        return opts.answer;
      },
    );
    (bridge as unknown as { turnDispatcher: unknown }).turnDispatcher = {
      dispatchStream,
      getLedgerSnapshot: () => ({ evidence: [], claims: [], modelCitedHosts: [] }),
    };
    return dispatchStream;
  }

  it("posts the trail in its OWN message, distinct from the answer message", async () => {
    const sent: SentMessage[] = [];
    const msg = makeMessage(sent);
    const bridge = makeBridge({ ...UX_BASE, statusMessage: "separate" });
    wireDispatcher(bridge, { answer: "The 2026 limit is $24,500.", claims: 2 });

    await (bridge as never as { streamAndPostResponse: (...a: unknown[]) => Promise<void> })
      .streamAndPostResponse(msg, "fin-client", "what is the 2026 401(k) limit and RMD age", makeTurn());

    // Two distinct messages: the status message first, then the answer slot.
    expect(sent.length).toBeGreaterThanOrEqual(2);
    const status = sent[0];
    const answer = sent[1];
    expect(status.id).not.toBe(answer.id);
    // The answer message must never have carried trail text.
    const answerTexts = [answer.content, ...answer.edits.map(String)].join("\n");
    expect(answerTexts).not.toContain("🔎 working");
    expect(answerTexts).toContain("$24,500");
    // The status message carried the trail and never the answer.
    const statusTexts = [status.content, ...status.edits.map(String)].join("\n");
    // 999.151 — a bold text header, no leading emoji.
    expect(statusTexts).toContain("**Working");
    expect(statusTexts).not.toContain("$24,500");
  }, 30_000);

  it("paints on the FIRST tool event, and never on the topic gate alone (no phantom notification)", async () => {
    // A turn that never touches a tool has nothing to verify: no status
    // message at all, so nothing is posted-then-deleted on the phone.
    const quiet: SentMessage[] = [];
    const bridgeQ = makeBridge({ ...UX_BASE, statusMessage: "separate" });
    wireDispatcher(bridgeQ, { answer: "ok", claims: 0, tools: false });
    await (bridgeQ as never as { streamAndPostResponse: (...a: unknown[]) => Promise<void> })
      .streamAndPostResponse(makeMessage(quiet), "fin-client", "2026 401(k) limit?", makeTurn());
    expect(quiet.every((m) => !m.content.includes("Working"))).toBe(true);

    // The first tool event paints immediately — no 3-event / 20 s wait.
    const sent: SentMessage[] = [];
    const bridge = makeBridge({ ...UX_BASE, statusMessage: "separate" });
    wireDispatcher(bridge, { answer: "ok", claims: 0 });
    await (bridge as never as { streamAndPostResponse: (...a: unknown[]) => Promise<void> })
      .streamAndPostResponse(makeMessage(sent), "fin-client", "2026 401(k) limit?", makeTurn());
    expect(sent[0].content).toMatch(/\*\*Working · \d+ steps?(?: · [\dhms ]+)?\*\*/);
  }, 30_000);

  it("settles to a one-line summary when claims were recorded", async () => {
    const sent: SentMessage[] = [];
    const msg = makeMessage(sent);
    const bridge = makeBridge({ ...UX_BASE, statusMessage: "separate" });
    wireDispatcher(bridge, { answer: "The 2026 limit is $24,500.", claims: 3 });

    await (bridge as never as { streamAndPostResponse: (...a: unknown[]) => Promise<void> })
      .streamAndPostResponse(msg, "fin-client", "2026 401(k) limit and RMD age?", makeTurn());

    const status = sent[0];
    const last = String(status.edits.at(-1) ?? status.content);
    expect(last).toMatch(/^-# Verified 3 of 3 claims · \d+s$/);
    expect(status.deleted).toBe(false);
    // While working, the header carried the phase and count.
    expect([status.content, ...status.edits.map(String)].join("\n")).toMatch(/\*\*Verifying · 3 claims(?: · [\dhms ]+)?\*\*/);
  }, 30_000);

  it("a tool-only turn settles to one grey line (never leaves the working trail standing)", async () => {
    const sent: SentMessage[] = [];
    const msg = makeMessage(sent);
    const bridge = makeBridge({ ...UX_BASE, statusMessage: "separate" });
    wireDispatcher(bridge, { answer: "Short answer.", claims: 0 }); // tools, no claims

    await (bridge as never as { streamAndPostResponse: (...a: unknown[]) => Promise<void> })
      .streamAndPostResponse(msg, "fin-client", "2026 401(k) limit?", makeTurn());

    const status = sent[0];
    const last = String(status.edits.at(-1) ?? status.content);
    expect(last).toMatch(/^-# Checked 2 steps · \d+s$/);
    expect(last).not.toContain("→"); // no in-progress arrow after delivery
    expect(status.deleted).toBe(false);
  }, 30_000);

  it("a failed turn leaves a one-line ⚠️ instead of vanishing", async () => {
    const sent: SentMessage[] = [];
    const msg = makeMessage(sent);
    const bridge = makeBridge({ ...UX_BASE, statusMessage: "separate" });
    (bridge as unknown as { turnDispatcher: unknown }).turnDispatcher = {
      dispatchStream: vi.fn().mockImplementation(
        async (_o: unknown, _a: string, _f: string, _c: unknown, options?: { onToolUse?: (n: string, i?: unknown) => void }) => {
          options?.onToolUse?.("WebFetch", { url: "https://www.irs.gov/x" });
          await new Promise((r) => setTimeout(r, 5));
          return ""; // empty response
        },
      ),
      getLedgerSnapshot: () => ({ evidence: [], claims: [], modelCitedHosts: [] }),
    };

    await (bridge as never as { streamAndPostResponse: (...a: unknown[]) => Promise<void> })
      .streamAndPostResponse(msg, "fin-client", "2026 401(k) limit?", makeTurn());

    const status = sent.find((m) => m.content.includes("Working"));
    expect(status).toBeDefined();
    const last = String(status!.edits.at(-1) ?? status!.content);
    // 999.178 R1 — the dead "react 🔍 to retry" text is gone; the status line is
    // just the one-liner. (A no-answer Retry button is deferred as unsafe — see
    // the bridge success-tail comment — so no extra message is posted here.)
    expect(last).toBe("-# No answer produced");
    expect(status!.deleted).toBe(false);
  }, 30_000);

  it("narration shown as status items is NOT duplicated into the answer", async () => {
    const sent: SentMessage[] = [];
    const msg = makeMessage(sent);
    const bridge = makeBridge({ ...UX_BASE, narrationAsTrail: true, statusMessage: "separate" });
    const NARRATION = "client-b's LLP retirement comparison - on it. First I'll pull the verified 2026 limits file.";
    const ANSWER =
      "**Solo 401(k) is the answer.** 2026 max is $72,000, the employee deferral is $24,500, and the setup deadline is 12/31 — well past the narration fragment cap.";
    (bridge as unknown as { turnDispatcher: unknown }).turnDispatcher = {
      dispatchStream: vi.fn().mockImplementation(
        async (
          _o: unknown,
          _a: string,
          _f: string,
          onChunk: (s: string) => void,
          options?: { onToolUse?: (n: string, i?: unknown) => void },
        ) => {
          // The editor is handed ACCUMULATED text, exactly as in production.
          // A genuine progress fragment is followed by real tool work — that
          // is what distinguishes it from an answer's opening words.
          onChunk(NARRATION);
          await new Promise((r) => setTimeout(r, 5));
          options?.onToolUse?.("WebFetch", { url: "https://www.irs.gov/x" });
          onChunk(`${NARRATION} ${ANSWER}`);
          await new Promise((r) => setTimeout(r, 5));
          return `${NARRATION} ${ANSWER}`;
        },
      ),
      getLedgerSnapshot: () => ({ evidence: [], claims: [], modelCitedHosts: [] }),
    };

    await (bridge as never as { streamAndPostResponse: (...a: unknown[]) => Promise<void> })
      .streamAndPostResponse(msg, "fin-client", "2026 401(k) limit and RMD age?", makeTurn());

    const status = sent[0];
    const answer = sent[1];
    expect(answer).toBeDefined();
    const statusText = [status.content, ...status.edits.map(String)].join("\n");
    const answerText = [answer.content, ...answer.edits.map(String)].join("\n");
    // The narration is a status item...
    expect(statusText).toContain("client-b's LLP retirement comparison");
    // ...and appears NOWHERE in the answer message.
    expect(answerText).not.toContain("client-b's LLP retirement comparison");
    expect(answerText).not.toContain("First I'll pull");
    expect(answerText).toContain("Solo 401(k) is the answer");
  }, 30_000);

  it("renders status items as clipped subtext lines under a bold header", async () => {
    const sent: SentMessage[] = [];
    const msg = makeMessage(sent);
    const bridge = makeBridge({ ...UX_BASE, statusMessage: "separate" });
    wireDispatcher(bridge, { answer: "done", claims: 0 });

    await (bridge as never as { streamAndPostResponse: (...a: unknown[]) => Promise<void> })
      .streamAndPostResponse(msg, "fin-client", "2026 401(k) limit and RMD age?", makeTurn());

    const statusText = [sent[0].content, ...sent[0].edits.map(String)].join("\n");
    expect(statusText).toMatch(/\*\*Working · \d+ steps?(?: · [\dhms ]+)?\*\*/);
    expect(statusText).toContain("-# → ");
    // No item runs past the clip budget (+ glyph prefix).
    for (const line of statusText.split("\n").filter((l) => l.startsWith("-# "))) {
      expect(line.length).toBeLessThanOrEqual(64 + 8);
    }
  }, 30_000);

  it("no reaction on a clean verified turn; ✏️/⚠️ still react", async () => {
    const { decideVerdictMarks } = await import("../sources-footer.js");
    const verified = decideVerdictMarks({ claims: [], unmatchedHosts: [], correctionsApplied: 0, holdTimedOut: false, evidenceCount: 3 });
    expect(verified.reaction).toBeNull(); // nothing to flag
    const corrected = decideVerdictMarks({ claims: [], unmatchedHosts: [], correctionsApplied: 1, holdTimedOut: false, evidenceCount: 3 });
    expect(corrected.reaction).toBe("✏️");
    const unopened = decideVerdictMarks({ claims: [], unmatchedHosts: ["example.com"], correctionsApplied: 0, holdTimedOut: false, evidenceCount: 1 });
    expect(unopened.reaction).toBe("⚠️");
    // The bridge additionally suppresses a ✅ verdict — pinned statically so
    // the "no green checkmark on every message" decision can't regress.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../bridge.ts", import.meta.url), "utf8");
    expect(src).toContain('marks.reaction !== "✅" ? marks.reaction : null');
  }, 30_000);

  it("an answer's opening is NEVER stripped when no tool followed it", async () => {
    const sent: SentMessage[] = [];
    const msg = makeMessage(sent);
    const bridge = makeBridge({ ...UX_BASE, narrationAsTrail: true, statusMessage: "separate" });
    // Reproduces the shipped defect: the model streams "Y", then the rest of a
    // plain answer, with NO tool calls at all. "Y" matched the narration
    // detector and its removal shipped "es. Every trading day...".
    const ANSWER = "Yes. Every trading day for two weeks, 72 accounts, written 7:39-7:40 AM PT on T+1.";
    (bridge as unknown as { turnDispatcher: unknown }).turnDispatcher = {
      dispatchStream: vi.fn().mockImplementation(
        async (_o: unknown, _a: string, _f: string, onChunk: (s: string) => void) => {
          onChunk("Y");
          await new Promise((r) => setTimeout(r, 5));
          onChunk(ANSWER);
          await new Promise((r) => setTimeout(r, 5));
          return ANSWER;
        },
      ),
      getLedgerSnapshot: () => ({ evidence: [], claims: [], modelCitedHosts: [] }),
    };

    await (bridge as never as { streamAndPostResponse: (...a: unknown[]) => Promise<void> })
      .streamAndPostResponse(msg, "fin-client", "are the daily Acme Brokerage deliveries working?", makeTurn());

    const texts = sent.flatMap((m) => [m.content, ...m.edits.map(String)]);
    expect(texts.join("\n")).toContain("Yes. Every trading day");
    // Anchor to the START of a rendered message: "Yes. …" legitimately
    // CONTAINS "es. …", so a substring check can never catch the defect.
    for (const t of texts) expect(t.trimStart()).not.toMatch(/^es\. Every trading day/);
  }, 30_000);

  it("a ```draft block is posted as its own plain message after the analysis", async () => {
    const sent: SentMessage[] = [];
    const msg = makeMessage(sent);
    const bridge = makeBridge({ ...UX_BASE, statusMessage: "separate" });
    const sendResponse = vi.fn().mockResolvedValue(undefined);
    (bridge as unknown as { sendResponse: unknown }).sendResponse = sendResponse;
    const DRAFT = "Happy Friday Steven! Quick FYI, everything is up. Reach out if you need anything!";
    wireDispatcher(bridge, { answer: `**Too small - skip it.** Two positions are red.\n\nDraft below.\n\n\`\`\`draft\n${DRAFT}\n\`\`\``, claims: 0 });

    await (bridge as never as { streamAndPostResponse: (...a: unknown[]) => Promise<void> })
      .streamAndPostResponse(msg, "fin-client", "draft a note to Steven about tax loss harvesting", makeTurn());

    // The FINAL analysis message never contains the draft or a fence (the
    // streamed preview may have shown the fence mid-turn - that's fine).
    const answer = sent.find((m) => [m.content, ...m.edits.map(String)].join("\n").includes("Too small"));
    expect(answer).toBeDefined();
    const finalEdit = answer!.edits.at(-1);
    const finalText = typeof finalEdit === "string" ? finalEdit : ((finalEdit as { content?: string })?.content ?? answer!.content);
    expect(finalText).toContain("Too small");
    expect(finalText).not.toContain("Happy Friday");
    expect(finalText).not.toContain("```");
    // ...and the draft went out on its own, verbatim, via the delivery queue.
    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse.mock.calls[0]![1]).toBe(DRAFT);
  }, 30_000);

  it("inline mode (default) keeps the legacy shared slot — one message carries both", async () => {
    const sent: SentMessage[] = [];
    const msg = makeMessage(sent);
    const bridge = makeBridge({ ...UX_BASE }); // no statusMessage → inline
    wireDispatcher(bridge, { answer: "The 2026 limit is $24,500.", claims: 2 });

    await (bridge as never as { streamAndPostResponse: (...a: unknown[]) => Promise<void> })
      .streamAndPostResponse(msg, "fin-client", "2026 401(k) limit and RMD age?", makeTurn());

    // Legacy behaviour: a single slot message, which ends up holding the answer.
    expect(sent).toHaveLength(1);
    const all = [sent[0].content, ...sent[0].edits.map(String)].join("\n");
    expect(all).toContain("$24,500");
  }, 30_000);
});

describe("footer fold (2026-08-28) — the status message is deleted once the answer carries the merged line", () => {
  let DiscordBridge2: typeof import("../bridge.js").DiscordBridge;
  const log2 = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const routing2 = {
    channelToAgent: new Map([["chan-1", "fin-client"]]),
    agentToChannels: new Map([["fin-client", ["chan-1"]]]),
  };
  beforeEach(async () => {
    resetClaimSinksForTests();
    DiscordBridge2 = (await import("../bridge.js")).DiscordBridge;
  });
  const ev = (n: number) => ({
    kind: "read" as const, tool: "WebFetch", toolUseId: `tu-${n}`, at: 1, url: `https://www.irs.gov/p${n}`, host: "irs.gov", title: `Page ${n}`, tier: "primary" as const,
  });
  const claim = (n: number) => ({
    id: `c${n}`, turnId: "turn-1", claim: `claim ${n}`, verdict: "verified", effectiveVerdict: "verified", source: `https://www.irs.gov/p${n}`, sourceHost: "irs.gov",
    sourceStatus: "in-ledger", quoteStatus: "absent", origin: "tool", at: 1, ledgerBacked: true,
  });

  it("full tier: one `-# ✓ N claims verified · sources · Ns` line in the answer, status message deleted, no Sources: line", async () => {
    const sent: SentMessage[] = [];
    const msg = makeMessage(sent);
    const bridge = new DiscordBridge2({
      routingTableRef: { current: routing2 },
      sessionManager: {
        forwardToAgent: vi.fn(), streamFromAgent: vi.fn(),
        getAgentConfig: vi.fn().mockReturnValue({ workspace: "/tmp/fin", verification: { enforced: true, ux: { ...UX_BASE, statusMessage: "separate", sourcesFooter: "claims", ledgerButton: true } } }),
        getTraceCollector: vi.fn().mockReturnValue(undefined), advisorEvents: new EventEmitter(),
      } as never,
      botToken: "fake-token", log: log2 as never,
    });
    (bridge as unknown as { sendResponse: unknown }).sendResponse = vi.fn().mockResolvedValue(undefined);
    const answer = "**The 2026 limit is $24,500.**";
    (bridge as unknown as { turnDispatcher: unknown }).turnDispatcher = {
      dispatchStream: vi.fn().mockImplementation(async (_o: unknown, _a: string, _f: string, onChunk: (s: string) => void, options?: { onToolUse?: (n: string, i?: unknown) => void }) => {
        options?.onToolUse?.("WebFetch", { url: "https://www.irs.gov/p1" });
        onChunk(answer);
        await new Promise((r) => setTimeout(r, 5));
        return answer;
      }),
      getLedgerSnapshot: () => ({ evidence: [ev(1), ev(2), ev(3)], claims: [claim(1), claim(2), claim(3)], modelCitedHosts: [] }),
    };
    await (bridge as never as { streamAndPostResponse: (...a: unknown[]) => Promise<void> })
      .streamAndPostResponse(msg, "fin-client", "2026 401(k) limit?", makeTurn());
    const status = sent[0];
    expect(status.deleted).toBe(true);
    const answerMsg = sent[1];
    const final = String(answerMsg.edits.at(-1) ?? answerMsg.content);
    expect(final).toMatch(/\n\n-# Verified 3 claims · irs\.gov › Page 1 · irs\.gov › Page 2 · irs\.gov › Page 3 · \d+s$/);
    expect(final).not.toContain("Sources:");
    expect(final).not.toContain("](<");
  }, 30_000);
});
