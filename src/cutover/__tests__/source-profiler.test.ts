/**
 * Phase 92 Plan 01 Task 1 (RED) — source-profiler tests (D-11 amended).
 *
 * Pins the contract for `runSourceProfiler(deps)` defined in the plan's
 * <interfaces> block and the D-11 amendment. All 6 tests fail at this
 * stage because src/cutover/source-profiler.ts does not yet exist (RED).
 *
 * Behavioral pins (D-11 — profiler reads UNION of mc + discord JSONLs):
 *   P1: empty staging (both JSONLs absent) → {kind:'no-history'}, zero dispatcher calls
 *   P2 (P-BOTH): 50 mc + 50 discord entries (under chunk threshold) → ONE
 *       dispatch call → 7-key output; the prompt passed to dispatch contains
 *       BOTH "origin":"mc" and "origin":"discord" markers
 *   P3 (P-CHUNK): chunkThresholdMsgs=4 + 8 entries spread across 60 days →
 *       ≥2 dispatcher calls; merged output unions tools across chunks
 *   P4 (P-DEDUP): duplicate (sessionId, sequenceIndex) for mc and duplicate
 *       (channel_id, message_id) for discord are deduped before dispatch;
 *       messagesProcessed reflects dedup count
 *   P5 (P-DET): two runs over identical input produce byte-identical
 *       AGENT-PROFILE.json (sorted keys + sorted arrays + count-summed
 *       topIntents)
 *   P6 (P-CRON): mc entries with kind:"cron" produce topIntents prefixed
 *       "cron:"; merged output preserves the prefix and sort order
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  runSourceProfiler,
  type ProfileDeps,
} from "../source-profiler.js";
import {
  PROFILER_CHUNK_THRESHOLD_MSGS,
  type DiscordHistoryEntry,
  type McHistoryEntry,
} from "../types.js";

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

function makeDiscordMessages(n: number, channelId = "c1"): DiscordHistoryEntry[] {
  const out: DiscordHistoryEntry[] = [];
  for (let i = 0; i < n; i++) {
    const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + i * 1000).toISOString();
    out.push({
      origin: "discord",
      message_id: `dm-${i}`,
      channel_id: channelId,
      author_id: "u-1",
      author_name: "alice",
      ts,
      content: `discord msg ${i}`,
      attachments: [],
      is_bot: false,
    });
  }
  return out;
}

function makeMcEntries(
  n: number,
  opts: { sessionId?: string; kind?: McHistoryEntry["kind"]; baseTs?: number } = {},
): McHistoryEntry[] {
  const sessionId = opts.sessionId ?? "s-1";
  const kind = opts.kind ?? "direct";
  const baseTs = opts.baseTs ?? Date.UTC(2026, 1, 1);
  const out: McHistoryEntry[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      origin: "mc",
      sessionId,
      sequenceIndex: i,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `mc msg ${i}`,
      model: "claude-sonnet-4-6",
      ts: new Date(baseTs + i * 1000).toISOString(),
      kind,
      label: "L",
    });
  }
  return out;
}

async function seedJsonl(dir: string, name: string, entries: readonly object[]): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  const lines = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length > 0 ? "\n" : "");
  await writeFile(path, lines, "utf8");
  return path;
}

const CANONICAL_PROFILE_TEXT = JSON.stringify({
  tools: ["Bash", "Read"],
  skills: ["content-engine"],
  mcpServers: ["browser"],
  memoryRefs: [],
  models: ["anthropic-api/claude-sonnet-4-6"],
  uploads: [],
  topIntents: [{ intent: "portfolio-analysis", count: 47 }],
});

let stagingDir: string;
let outputDir: string;

beforeEach(async () => {
  stagingDir = await mkdtemp(join(tmpdir(), "cutover-profile-stg-"));
  outputDir = await mkdtemp(join(tmpdir(), "cutover-profile-out-"));
});

afterEach(async () => {
  await rm(stagingDir, { recursive: true, force: true });
  await rm(outputDir, { recursive: true, force: true });
});

function defaultJsonlPaths(): readonly string[] {
  return [
    join(stagingDir, "mc-history.jsonl"),
    join(stagingDir, "discord-history.jsonl"),
  ];
}

function baseDeps(overrides: Partial<ProfileDeps> = {}): ProfileDeps {
  const dispatch = vi.fn(async () => CANONICAL_PROFILE_TEXT);
  return {
    agent: "fin-client",
    historyJsonlPaths: defaultJsonlPaths(),
    outputDir,
    dispatcher: { dispatch: dispatch as unknown as ProfileDeps["dispatcher"]["dispatch"] },
    log: makeLog(),
    ...overrides,
  };
}

describe("runSourceProfiler — P1 no history", () => {
  it("returns {kind:'no-history'} when both JSONLs absent and never calls dispatcher", async () => {
    const dispatch = vi.fn();
    const outcome = await runSourceProfiler(
      baseDeps({
        dispatcher: { dispatch: dispatch as unknown as ProfileDeps["dispatcher"]["dispatch"] },
      }),
    );
    expect(outcome.kind).toBe("no-history");
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("runSourceProfiler — P2 both origins single chunk", () => {
  it("50 mc + 50 discord runs ONE dispatch and prompt contains BOTH origins", async () => {
    await seedJsonl(stagingDir, "mc-history.jsonl", makeMcEntries(50));
    await seedJsonl(stagingDir, "discord-history.jsonl", makeDiscordMessages(50));

    const dispatch = vi.fn(async () => CANONICAL_PROFILE_TEXT);
    const outcome = await runSourceProfiler(
      baseDeps({
        dispatcher: { dispatch: dispatch as unknown as ProfileDeps["dispatcher"]["dispatch"] },
      }),
    );

    expect(outcome.kind).toBe("profiled");
    expect(dispatch).toHaveBeenCalledTimes(1);
    if (outcome.kind === "profiled") {
      expect(outcome.chunksProcessed).toBe(1);
      expect(outcome.messagesProcessed).toBe(100);
      const raw = await readFile(outcome.profilePath, "utf8");
      const parsed = JSON.parse(raw);
      expect(Object.keys(parsed).sort()).toEqual([
        "memoryRefs",
        "mcpServers",
        "models",
        "skills",
        "tools",
        "topIntents",
        "uploads",
      ].sort());
    }

    // The prompt passed to dispatch should reference both origins so the
    // LLM sees the discriminator.
    const calls = (dispatch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    // dispatcher.dispatch(origin, agentName, message, options) — message is at index 2
    const promptStr = calls[0]?.[2] as string;
    expect(typeof promptStr).toBe("string");
    expect(promptStr).toContain("mc ");
    expect(promptStr).toContain("discord ");
  });
});

describe("runSourceProfiler — P3 chunked across 30-day windows", () => {
  it("8 entries spread across 60 days with chunkThresholdMsgs=4 → ≥2 dispatcher calls; tools merged", async () => {
    const total = 8;
    const span = 60 * 86400 * 1000;
    const baseTs = Date.UTC(2026, 0, 1);
    const mc = makeMcEntries(total, { baseTs });
    mc.forEach((m, i) => {
      m.ts = new Date(baseTs + Math.floor((i * span) / total)).toISOString();
      m.sequenceIndex = i;
    });
    await seedJsonl(stagingDir, "mc-history.jsonl", mc);

    let callIdx = 0;
    const dispatch = vi.fn(async () => {
      const tools = callIdx === 0 ? ["Bash"] : ["Read"];
      const intents = callIdx === 0
        ? [{ intent: "portfolio-analysis", count: 30 }]
        : [{ intent: "portfolio-analysis", count: 17 }, { intent: "writing", count: 5 }];
      callIdx += 1;
      return JSON.stringify({
        tools,
        skills: [],
        mcpServers: [],
        memoryRefs: [],
        models: [],
        uploads: [],
        topIntents: intents,
      });
    });

    const outcome = await runSourceProfiler(
      baseDeps({
        chunkThresholdMsgs: 4,
        dispatcher: { dispatch: dispatch as unknown as ProfileDeps["dispatcher"]["dispatch"] },
      }),
    );

    expect(outcome.kind).toBe("profiled");
    expect(dispatch.mock.calls.length).toBeGreaterThanOrEqual(2);
    if (outcome.kind === "profiled") {
      expect(outcome.chunksProcessed).toBeGreaterThanOrEqual(2);
      const merged = JSON.parse(await readFile(outcome.profilePath, "utf8")) as {
        tools: string[];
        topIntents: Array<{ intent: string; count: number }>;
      };
      expect(merged.tools).toEqual(["Bash", "Read"]);
      expect(merged.topIntents[0]).toEqual({ intent: "portfolio-analysis", count: 47 });
    }
  });

  it("PROFILER_CHUNK_THRESHOLD_MSGS constant equals 50000", () => {
    expect(PROFILER_CHUNK_THRESHOLD_MSGS).toBe(50000);
  });
});

describe("runSourceProfiler — P4 dedup across origins", () => {
  it("duplicate mc (sessionId, sequenceIndex) and duplicate discord (channel_id, message_id) deduped before dispatch", async () => {
    const mc = makeMcEntries(5);
    // Duplicate the first MC entry — same (sessionId, sequenceIndex)
    const mcWithDup = [...mc, mc[0]];
    const discord = makeDiscordMessages(5);
    // Duplicate the first discord entry — same (channel_id, message_id)
    const discordWithDup = [...discord, discord[0]];

    await seedJsonl(stagingDir, "mc-history.jsonl", mcWithDup);
    await seedJsonl(stagingDir, "discord-history.jsonl", discordWithDup);

    const dispatch = vi.fn(async () => CANONICAL_PROFILE_TEXT);
    const outcome = await runSourceProfiler(
      baseDeps({
        dispatcher: { dispatch: dispatch as unknown as ProfileDeps["dispatcher"]["dispatch"] },
      }),
    );

    expect(outcome.kind).toBe("profiled");
    if (outcome.kind === "profiled") {
      // 5 mc + 5 discord = 10 unique (each duplicate dropped)
      expect(outcome.messagesProcessed).toBe(10);
    }
  });
});

describe("runSourceProfiler — P5 deterministic byte-identical output", () => {
  it("two runs over identical input produce byte-identical AGENT-PROFILE.json", async () => {
    await seedJsonl(stagingDir, "mc-history.jsonl", makeMcEntries(20));
    await seedJsonl(stagingDir, "discord-history.jsonl", makeDiscordMessages(20));

    const out1Dir = await mkdtemp(join(tmpdir(), "cutover-det-1-"));
    const out2Dir = await mkdtemp(join(tmpdir(), "cutover-det-2-"));
    try {
      const dispatch1 = vi.fn(async () => CANONICAL_PROFILE_TEXT);
      const o1 = await runSourceProfiler(
        baseDeps({
          outputDir: out1Dir,
          dispatcher: { dispatch: dispatch1 as unknown as ProfileDeps["dispatcher"]["dispatch"] },
        }),
      );
      const dispatch2 = vi.fn(async () => CANONICAL_PROFILE_TEXT);
      const o2 = await runSourceProfiler(
        baseDeps({
          outputDir: out2Dir,
          dispatcher: { dispatch: dispatch2 as unknown as ProfileDeps["dispatcher"]["dispatch"] },
        }),
      );

      expect(o1.kind).toBe("profiled");
      expect(o2.kind).toBe("profiled");
      if (o1.kind === "profiled" && o2.kind === "profiled") {
        const outputBytes1 = await readFile(o1.profilePath);
        const outputBytes2 = await readFile(o2.profilePath);
        expect(outputBytes1).toEqual(outputBytes2);
      }
    } finally {
      await rm(out1Dir, { recursive: true, force: true });
      await rm(out2Dir, { recursive: true, force: true });
    }
  });
});

describe("runSourceProfiler — P6 cron-prefixed intents preserved", () => {
  it("mc entries with kind:'cron' yield topIntents prefixed 'cron:' in merged output", async () => {
    const cronEntries = makeMcEntries(5, { sessionId: "s-cron", kind: "cron" });
    const directEntries = makeMcEntries(5, {
      sessionId: "s-direct",
      kind: "direct",
      baseTs: Date.UTC(2026, 1, 2),
    });
    await seedJsonl(stagingDir, "mc-history.jsonl", [...cronEntries, ...directEntries]);

    const dispatch = vi.fn(async () =>
      JSON.stringify({
        tools: [],
        skills: [],
        mcpServers: [],
        memoryRefs: [],
        models: [],
        uploads: [],
        topIntents: [
          { intent: "cron:acme-db-sync", count: 12 },
          { intent: "portfolio-analysis", count: 47 },
        ],
      }),
    );

    const outcome = await runSourceProfiler(
      baseDeps({
        dispatcher: { dispatch: dispatch as unknown as ProfileDeps["dispatcher"]["dispatch"] },
      }),
    );

    expect(outcome.kind).toBe("profiled");
    if (outcome.kind === "profiled") {
      const parsed = JSON.parse(await readFile(outcome.profilePath, "utf8")) as {
        topIntents: Array<{ intent: string; count: number }>;
      };
      // Must preserve the cron: prefix
      const intents = parsed.topIntents.map((t) => t.intent);
      expect(intents).toContain("cron:acme-db-sync");
      expect(intents).toContain("portfolio-analysis");
      // Sorted by count DESC: portfolio-analysis (47) before cron:acme-db-sync (12)
      expect(parsed.topIntents[0]?.intent).toBe("portfolio-analysis");
      expect(parsed.topIntents[1]?.intent).toBe("cron:acme-db-sync");
    }
  });
});
