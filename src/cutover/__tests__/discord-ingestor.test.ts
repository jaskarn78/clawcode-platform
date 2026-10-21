/**
 * Phase 92 Plan 01 Task 1 (RED) — Discord-ingestor tests.
 *
 * Pins the contract for `ingestDiscordHistory(deps)` defined in the
 * plan's <interfaces> block. All 6 tests fail at this stage because
 * src/cutover/discord-ingestor.ts does not yet exist (RED gate).
 *
 * Behavioral pins:
 *   I1: empty channels[] → {kind: "no-channels"} + zero fetchMessages calls
 *   I2: 1 channel + 250-msg history paginates 3 times, writes 250 JSONL lines
 *   I3: sleeps 500ms BETWEEN requests (count = pageCount - 1 = 2)
 *   I4: idempotent — second run with same history adds zero new lines
 *   I5: fetchMessages throw → {kind: "discord-fetch-failed"} + JSONL unchanged
 *   I6: respects --depth-msgs 50 cap (1 page, 50 msgs, no further pagination)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  ingestDiscordHistory,
  type DiscordFetchMessagesFn,
  type DiscordIngestDeps,
} from "../discord-ingestor.js";
import type { DiscordHistoryEntry, DiscordIngestOutcome } from "../types.js";

function makeLog() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  } as unknown as import("pino").Logger;
}

function makeMessages(n: number, channelId: string): DiscordHistoryEntry[] {
  // Deterministic synthetic messages — id includes channelId for assertion
  // clarity and `ts` is unique per index to allow oldest→newest sort checks.
  // D-11: `origin: "discord"` is the discriminator literal threaded through
  // the merged-corpus profiler.
  const out: DiscordHistoryEntry[] = [];
  for (let i = 0; i < n; i++) {
    const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    out.push({
      origin: "discord",
      message_id: `m-${channelId}-${i}`,
      channel_id: channelId,
      author_id: "u-1",
      author_name: "alice",
      ts,
      content: `msg ${i}`,
      attachments: [],
      is_bot: false,
    });
  }
  return out;
}

/**
 * Build a stub fetchMessages that paginates a static corpus 100 at a time.
 * The cursor advances based on the `before` arg matching message_id.
 */
function pagedFetch(corpus: readonly DiscordHistoryEntry[]): DiscordFetchMessagesFn {
  // Newest-first iteration would be more faithful to Discord's real API,
  // but the ingestor is order-agnostic (it sorts by ts before append) — use
  // simple offset semantics keyed on the previous-page tail message_id.
  const byIndex = corpus.slice();
  return vi.fn(async ({ before, limit }: { chat_id: string; before?: string; limit: number }) => {
    let startIdx = 0;
    if (before !== undefined) {
      const found = byIndex.findIndex((m) => m.message_id === before);
      startIdx = found >= 0 ? found + 1 : byIndex.length;
    }
    const slice = byIndex.slice(startIdx, startIdx + limit);
    const hasMore = startIdx + slice.length < byIndex.length;
    return { messages: slice, hasMore };
  }) as unknown as DiscordFetchMessagesFn;
}

let stagingDir: string;
beforeEach(async () => {
  stagingDir = await mkdtemp(join(tmpdir(), "cutover-ingest-"));
});
afterEach(async () => {
  await rm(stagingDir, { recursive: true, force: true });
});

function baseDeps(overrides: Partial<DiscordIngestDeps> = {}): DiscordIngestDeps {
  return {
    agent: "fin-client",
    channels: ["c1"],
    stagingDir,
    fetchMessages: pagedFetch([]),
    sleep: async () => {},
    log: makeLog(),
    ...overrides,
  };
}

describe("ingestDiscordHistory — I1 empty channels", () => {
  it("returns {kind:'no-channels'} and never calls fetchMessages", async () => {
    const fetchMessages = vi.fn() as unknown as DiscordFetchMessagesFn;
    const outcome = await ingestDiscordHistory(
      baseDeps({ channels: [], fetchMessages }),
    );
    expect(outcome.kind).toBe("no-channels");
    if (outcome.kind === "no-channels") {
      expect(outcome.agent).toBe("fin-client");
    }
    expect(fetchMessages).not.toHaveBeenCalled();
  });
});

describe("ingestDiscordHistory — I2 paginates 250 msgs over 3 pages", () => {
  it("writes 250 JSONL lines and reports newMessages=250", async () => {
    const corpus = makeMessages(250, "c1");
    const fetchMessages = pagedFetch(corpus);
    const outcome: DiscordIngestOutcome = await ingestDiscordHistory(
      baseDeps({ fetchMessages }),
    );

    expect(outcome.kind).toBe("ingested");
    if (outcome.kind === "ingested") {
      expect(outcome.channelsProcessed).toBe(1);
      expect(outcome.newMessages).toBe(250);
      expect(outcome.totalMessages).toBe(250);
      const raw = await readFile(outcome.jsonlPath, "utf8");
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      expect(lines).toHaveLength(250);
    }

    // 3 pages = ceil(250/100). I3 below pins the inter-request count.
    expect(fetchMessages).toHaveBeenCalledTimes(3);
  });
});

describe("ingestDiscordHistory — I3 sleeps BETWEEN requests only", () => {
  it("for 3 pages calls sleep exactly 2 times (not before first, not after last)", async () => {
    const corpus = makeMessages(250, "c1");
    const sleepSpy = vi.fn<NonNullable<DiscordIngestDeps["sleep"]>>(async () => {});
    await ingestDiscordHistory(
      baseDeps({ fetchMessages: pagedFetch(corpus), sleep: sleepSpy }),
    );
    expect(sleepSpy).toHaveBeenCalledTimes(2);
    // Sleep duration must equal the documented 500ms inter-request constant.
    const calls = sleepSpy.mock.calls.map((c) => c[0]);
    expect(calls.every((ms) => ms === 500)).toBe(true);
  });
});

describe("ingestDiscordHistory — I4 idempotent on rerun", () => {
  it("second run with same corpus reports {kind:'no-changes'} and adds zero lines", async () => {
    const corpus = makeMessages(250, "c1");
    const first = await ingestDiscordHistory(
      baseDeps({ fetchMessages: pagedFetch(corpus) }),
    );
    expect(first.kind).toBe("ingested");

    const second = await ingestDiscordHistory(
      baseDeps({ fetchMessages: pagedFetch(corpus) }),
    );
    expect(second.kind).toBe("no-changes");
    if (second.kind === "no-changes") {
      expect(second.totalMessages).toBe(250);
      const raw = await readFile(second.jsonlPath, "utf8");
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      expect(lines).toHaveLength(250); // unchanged
    }
  });
});

describe("ingestDiscordHistory — I5 fetch error", () => {
  it("returns {kind:'discord-fetch-failed'} with channelId+error and leaves JSONL unchanged", async () => {
    const fetchMessages = vi.fn(async () => {
      throw new Error("rate-limited");
    }) as unknown as DiscordFetchMessagesFn;

    const outcome = await ingestDiscordHistory(
      baseDeps({ fetchMessages }),
    );
    expect(outcome.kind).toBe("discord-fetch-failed");
    if (outcome.kind === "discord-fetch-failed") {
      expect(outcome.channelId).toBe("c1");
      expect(outcome.error).toMatch(/rate-limited/);
    }

    // No JSONL file written (or empty).
    const path = join(stagingDir, "discord-history.jsonl");
    let exists = true;
    let lines = 0;
    try {
      const raw = await readFile(path, "utf8");
      lines = raw.split("\n").filter((l) => l.trim().length > 0).length;
    } catch {
      exists = false;
    }
    expect(exists ? lines : 0).toBe(0);
  });
});

describe("ingestDiscordHistory — I6 respects --depth-msgs cap", () => {
  it("with depthMsgs:50 fetches one page, returns newMessages=50, no further pagination", async () => {
    const corpus = makeMessages(500, "c1");
    const fetchMessages = pagedFetch(corpus);
    const outcome = await ingestDiscordHistory(
      baseDeps({ depthMsgs: 50, fetchMessages }),
    );
    expect(outcome.kind).toBe("ingested");
    if (outcome.kind === "ingested") {
      expect(outcome.newMessages).toBe(50);
    }
    // Only ONE fetch call — the 50-msg cap binds before pagination triggers.
    expect(fetchMessages).toHaveBeenCalledTimes(1);
    // limit forwarded must be 50 (min(100, depth))
    const firstCall = (fetchMessages as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect((firstCall?.[0] as { limit: number }).limit).toBe(50);
  });
});
