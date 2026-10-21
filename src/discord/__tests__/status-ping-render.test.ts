/**
 * 999.178 R1 — status-ping renderer tests. Pure text builder: fixed `now`,
 * fixed timezone, no clock/discord dependency.
 */
import { describe, it, expect } from "vitest";

import {
  renderStatusPing,
  isTurnStalled,
  formatClock,
  STATUS_PING_STALL_MS,
  buildStatusPingButtonId,
  parseStatusPingButtonId,
  statedEtaMs,
  type StatusPingView,
} from "../status-ping-render.js";

// 2026-09-25 14:16:40 America/Los_Angeles (PDT, UTC-7) — a fixed instant.
const NOW = Date.parse("2026-09-25T21:16:40Z");
const ASKED_AT = Date.parse("2026-09-25T21:14:00Z"); // 2:14 PM PT
const STARTED_AT = Date.parse("2026-09-25T21:15:00Z"); // 100s before NOW
const TZ = "America/Los_Angeles";

function view(overrides: Partial<StatusPingView>): StatusPingView {
  return {
    running: true,
    nowMs: NOW,
    askedAtMs: ASKED_AT,
    askExcerpt: "401k rollover for the Smiths",
    turnStartedAtMs: STARTED_AT,
    stepLabel: "reading a statement",
    queuedCount: 2,
    lastReplyAtMs: null,
    timeZone: TZ,
    ...overrides,
  };
}

describe("formatClock", () => {
  it("renders Pacific wall-clock time", () => {
    expect(formatClock(ASKED_AT, TZ)).toBe("2:14 PM");
  });
});

describe("renderStatusPing — running", () => {
  it("builds the full working line", () => {
    const out = renderStatusPing(view({}));
    expect(out).toBe(
      "Working on your 2:14 PM ask (401k rollover for the Smiths) · 1m 40s · reading a statement · 2 queued",
    );
  });

  it("prefixes a pre-resolved icon when supplied", () => {
    const out = renderStatusPing(view({ loaderIcon: "<:cc_loader:1>" }));
    expect(out.startsWith("<:cc_loader:1> Working on your 2:14 PM ask")).toBe(true);
  });

  it("omits the step, elapsed and queued clauses when absent", () => {
    const out = renderStatusPing(
      view({ stepLabel: null, turnStartedAtMs: null, queuedCount: 0 }),
    );
    expect(out).toBe("Working on your 2:14 PM ask (401k rollover for the Smiths)");
  });

  it("degrades gracefully with no trigger metadata (self-fired turn)", () => {
    const out = renderStatusPing(
      view({ askedAtMs: null, askExcerpt: null, turnStartedAtMs: null, stepLabel: null, queuedCount: 0 }),
    );
    expect(out).toBe("Working on your ask");
  });

  it("sanitizes and clamps a hostile ask excerpt (no @mention passthrough)", () => {
    const out = renderStatusPing(
      view({
        askExcerpt: "@everyone please review the very long detailed rollover plan now",
        stepLabel: null,
        turnStartedAtMs: null,
        queuedCount: 0,
      }),
    );
    expect(out).not.toContain("@everyone");
    expect(out).toContain("everyone please review");
    // Parenthetical clamped to ~40 chars.
    const paren = out.slice(out.indexOf("(") + 1, out.indexOf(")"));
    expect(paren.length).toBeLessThanOrEqual(40);
  });
});

describe("renderStatusPing — idle / draining", () => {
  it("idle with a last reply", () => {
    const out = renderStatusPing(
      view({ running: false, queuedCount: 0, lastReplyAtMs: Date.parse("2026-09-25T21:31:00Z") }),
    );
    expect(out).toBe("Nothing running. Last reply 2:31 PM.");
  });

  it("idle with no last reply", () => {
    const out = renderStatusPing(view({ running: false, queuedCount: 0, lastReplyAtMs: null }));
    expect(out).toBe("Nothing running.");
  });

  it("idle-with-pending never says 'Nothing running'", () => {
    const out = renderStatusPing(view({ running: false, queuedCount: 3 }));
    expect(out).toContain("3 queued asks draining");
    expect(out).not.toContain("Nothing running");
  });
});

describe("isTurnStalled", () => {
  it("false when progress is fresh or unknown", () => {
    expect(isTurnStalled(null, NOW)).toBe(false);
    expect(isTurnStalled(NOW - 1000, NOW)).toBe(false);
  });
  it("true once past the stall window", () => {
    expect(isTurnStalled(NOW - STATUS_PING_STALL_MS, NOW)).toBe(true);
    expect(isTurnStalled(NOW - STATUS_PING_STALL_MS - 1, NOW)).toBe(true);
  });
});

describe("status-ping button customId", () => {
  it("round-trips", () => {
    const id = buildStatusPingButtonId("stop", "fin-client", "111", "222");
    expect(id).toBe("sping:stop:fin-client:111:222");
    expect(parseStatusPingButtonId(id)).toEqual({
      action: "stop",
      agent: "fin-client",
      triggerMessageId: "111",
      userId: "222",
    });
  });
  it("rejects a foreign / malformed customId", () => {
    expect(parseStatusPingButtonId("ra:1:2")).toBeNull();
    expect(parseStatusPingButtonId("sping:go:a:b:c")).toBeNull();
    expect(parseStatusPingButtonId("sping:stop:a:b")).toBeNull();
  });
});

describe("renderStatusPing — background research (fin-client 2026-09-26)", () => {
  const idle = { running: false, askedAtMs: null, askExcerpt: null, turnStartedAtMs: null, stepLabel: null, queuedCount: 0 } as const;

  it("researchers running, parent idle → progress, never 'Nothing running'", () => {
    const text = renderStatusPing(view({ ...idle, research: { total: 4, done: 3, running: 1, startedAt: NOW - 250_000, writingSince: null } }));
    expect(text).toBe("Researching · 3 of 4 done · 4m 10s");
  });

  it("synthesis turn running → 'Writing up the research' with time since it began", () => {
    const text = renderStatusPing(
      view({ ...idle, selfFiredTurnOpen: true, research: { total: 4, done: 4, running: 0, startedAt: NOW - 400_000, writingSince: NOW - 72_000 } }),
    );
    expect(text).toBe("Writing up the research (4 of 4 done) · 1m 12s");
  });

  it("a self-fired turn with no research → a follow-up is running", () => {
    expect(renderStatusPing(view({ ...idle, selfFiredTurnOpen: true }))).toBe("Working on a follow-up");
  });

  it("a user turn running alongside research notes the research", () => {
    const text = renderStatusPing(view({ research: { total: 4, done: 1, running: 3, startedAt: NOW - 60_000, writingSince: null } }));
    expect(text).toContain("research 1 of 4 done");
    expect(text).toContain("2 queued");
  });

  it("nothing live → unchanged idle line", () => {
    expect(renderStatusPing(view({ ...idle, research: null, selfFiredTurnOpen: false }))).toBe("Nothing running.");
  });
});

describe("renderStatusPing — background work (fin-client 2026-09-26 08:53)", () => {
  const idle = { running: false, askedAtMs: null, askExcerpt: null, turnStartedAtMs: null, stepLabel: null, queuedCount: 0 } as const;

  it("a background task running → says what and for how long, never 'Nothing running'", () => {
    const text = renderStatusPing(
      view({ ...idle, background: [{ description: "Wait for price download", startedAt: NOW - 130_000, lastLine: null }] }),
    );
    expect(text).toBe("In the background: Wait for price download · 2m 10s");
  });

  it("quotes the ETA the agent stated in its last reply, with time left", () => {
    const text = renderStatusPing(
      view({
        ...idle,
        background: [{ description: "Wait for price download", startedAt: NOW - 130_000, lastLine: null }],
        lastReplyAtMs: NOW - 120_000,
        lastReplyText: "Prices are downloading again, which takes about 5 minutes. I'll run Part 2 when it's done.",
      }),
    );
    expect(text).toContain("said ~5 min at 2:14 PM (about 3 min left)");
  });

  it("an ETA already passed says so", () => {
    const text = renderStatusPing(
      view({
        ...idle,
        background: [{ description: "Wait for price download", startedAt: NOW - 600_000, lastLine: null }, { description: "Retry misses", startedAt: NOW, lastLine: null }],
        lastReplyAtMs: NOW - 540_000,
        lastReplyText: "About 5 min.",
      }),
    );
    expect(text).toContain("+1 more");
    expect(text).toContain("(running past it)");
  });

  it("statedEtaMs reads common phrasings and ignores ones with no duration", () => {
    expect(statedEtaMs("takes about 5 minutes")).toBe(300_000);
    expect(statedEtaMs("~10 min left")).toBe(600_000);
    expect(statedEtaMs("roughly 2-3 hours")).toBe(3 * 3_600_000);
    expect(statedEtaMs("in 30 seconds")).toBe(30_000);
    expect(statedEtaMs("Part 2 is still downloading prices")).toBeNull();
    expect(statedEtaMs("in 2026 the rule changed")).toBeNull();
  });
});
