import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RESEARCHER_FILE_CAP_BYTES,
  ResearchJournal,
  journalDirName,
  recoverInterruptedJournals,
  redactSecrets,
} from "../research-journal.js";
import { ResearchTracker } from "../research-tracker.js";
import { asksToResumeResearch, resetResearchRegistryForTests, setLiveDiscordTurn } from "../research-registry.js";
import { SYNTHETIC, SYNTHETIC_RAW_VALUES } from "./synthetic-secrets.js";

const AGENT = "fin-client";
const MSG = "000000000000000118";
const ORIGIN = { turnId: `discord:${MSG}`, messageId: MSG, channelId: "chan" };
const REPLY_TO = { channelId: "chan", messageId: MSG };

const child = (type: "assistant" | "user", content: unknown[], parent = "toolu_A") => ({
  type,
  parent_tool_use_id: parent,
  message: { content },
});
const started = (taskId: string, toolUseId: string, description = "Screen A: fast-growing leaders") => ({
  type: "system",
  subtype: "task_started",
  task_id: taskId,
  tool_use_id: toolUseId,
  description,
  subagent_type: "researcher",
});
const notified = (taskId: string, status = "completed", summary = "s") => ({
  type: "system",
  subtype: "task_notification",
  task_id: taskId,
  status,
  summary,
  output_file: "/o",
});

function tracker(root: string, extra: Partial<ConstructorParameters<typeof ResearchTracker>[0]> = {}) {
  const delivered: { text: string; replyTo: unknown }[] = [];
  const t = new ResearchTracker({
    agentName: AGENT,
    maxConcurrent: 4,
    holdTimeoutMs: 60 * 60_000,
    stopTask: vi.fn(() => Promise.resolve()),
    deliver: (text, replyTo) => delivered.push({ text, replyTo }),
    journalRoot: root,
    log: { info: () => undefined, warn: () => undefined },
    ...extra,
  });
  return { t, delivered };
}

async function settleJournal(t: ResearchTracker): Promise<void> {
  const sessions = [
    ...(t as unknown as { active: Map<string, { journal: ResearchJournal | null }> }).active.values(),
    ...(t as unknown as { recent: { journal: ResearchJournal | null }[] }).recent,
  ];
  for (const s of sessions) await s.journal?.flushed();
}

afterEach(() => {
  resetResearchRegistryForTests();
  vi.useRealTimers();
});

describe("research findings journal (999.173 polish)", () => {
  it("appends incrementally: findings on top, tool calls with key input + trimmed result, progress", async () => {
    const root = mkdtempSync(join(tmpdir(), "rj-"));
    setLiveDiscordTurn(AGENT, ORIGIN);
    const { t } = tracker(root);
    t.observe(started("a1", "toolu_A"));
    t.observeChild("toolu_A", child("assistant", [
      { type: "text", text: "Looking at revenue growth.\nFINDING: NVDA revenue grew 94% YoY — nvidia.com/ir Q2 FY27" },
      { type: "tool_use", id: "tu1", name: "mcp__finnhub__quote", input: { symbol: "NVDA", token: SYNTHETIC.anthropicKey } },
    ]));
    await settleJournal(t);
    const dir = join(root, journalDirName(Date.now(), MSG));
    const file = join(dir, readdirSync(dir).find((f) => f.startsWith("a1-"))!);
    const first = readFileSync(file, "utf8");
    expect(first).toContain("## Findings so far\n\n- NVDA revenue grew 94% YoY — nvidia.com/ir Q2 FY27");
    expect(first).toContain("note: Looking at revenue growth.");

    t.observeChild("toolu_A", child("user", [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "NVDA 181.2 USD (source https://finnhub.io/q/NVDA)" }] }]));
    t.observe({ type: "system", subtype: "task_progress", task_id: "a1", description: "d", usage: {}, summary: "Comparing margins" });
    await settleJournal(t);
    const second = readFileSync(file, "utf8");
    expect(second).toMatch(/quote "NVDA" → NVDA 181\.2 USD/);
    expect(second).toContain("progress: Comparing margins");
    expect(second).not.toContain(SYNTHETIC.anthropicKey);
    const index = readFileSync(join(dir, "session.md"), "utf8");
    expect(index).toContain("Screen A: fast-growing leaders");
  });

  it("a failure mid-run keeps the findings; the notice names the folder; the card says where notes are", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const root = mkdtempSync(join(tmpdir(), "rj-"));
    setLiveDiscordTurn(AGENT, ORIGIN);
    const cardSnaps: unknown[] = [];
    const { t, delivered } = tracker(root, {
      cardPort: () => ({ post: async (_c, s) => (cardSnaps.push(s), "card-1"), edit: async (_c, _m, s) => void cardSnaps.push(s) }),
      repaintMs: 10,
      noticeSettleMs: 50,
      failureNoticeWaitMs: 100,
    });
    t.observe(started("a1", "toolu_A"));
    t.observeChild("toolu_A", child("assistant", [{ type: "text", text: "FINDING: CRWD margin 78% — 10-Q" }]));
    t.observe(notified("a1", "failed", "You've hit your session limit · resets 5:30pm (America/Los_Angeles)"));
    await vi.advanceTimersByTimeAsync(200);
    await settleJournal(t);
    const rel = `research/${journalDirName(Date.now(), MSG)}/`;
    expect(delivered).toEqual([
      {
        text: `Research couldn't run: the Claude usage limit is reached until 5:30 PM PT. Ask again after that. Partial notes are saved in ${rel}.`,
        replyTo: REPLY_TO,
      },
    ]);
    const dir = join(root, journalDirName(Date.now(), MSG));
    const file = readFileSync(join(dir, readdirSync(dir).find((f) => f.startsWith("a1-"))!), "utf8");
    expect(file).toContain("- CRWD margin 78% — 10-Q");
    expect(file).toContain("Ended: failed (usage limit reached, resets 5:30 PM PT)");
    expect(JSON.parse(readFileSync(join(dir, "session.json"), "utf8")).state).toBe("done");
    const last = cardSnaps[cardSnaps.length - 1] as { savedTo?: string };
    expect(last.savedTo).toBe(rel);
  });

  it("resume: a rerun on the same message, or 'resume research', gets the earlier notes in its launch prompt", async () => {
    const root = mkdtempSync(join(tmpdir(), "rj-"));
    setLiveDiscordTurn(AGENT, ORIGIN);
    const first = tracker(root, { noticeSettleMs: 10, failureNoticeWaitMs: 10 });
    first.t.observe(started("a1", "toolu_A"));
    first.t.observe(notified("a1", "failed", "API error"));
    first.t.failOpen("close");
    await settleJournal(first.t);

    const next = tracker(root);
    await next.t.recoverFromDisk();
    const same = next.t.resumeContextFor(ORIGIN);
    expect(same).toContain(`research/${journalDirName(Date.now(), MSG)}/a1-screen-a-fast-growing-leaders.md (failed: API error)`);
    expect(same).toMatch(/continue from it instead of starting over/);
    const other = { turnId: "discord:000000000000000119", messageId: "000000000000000119", channelId: "chan" };
    expect(next.t.resumeContextFor(other)).toBeNull();
    expect(next.t.resumeContextFor({ ...other, resumeRequested: true })).toContain("a1-screen-a");
    expect(asksToResumeResearch('<channel source="discord" chat_id="1" message_id="2" user="owner_a" ts="x">resume the research please</channel>')).toBe(true);
    expect(asksToResumeResearch('<memory-context>resume research</memory-context>\n<channel source="discord" chat_id="1" message_id="2" user="owner_a" ts="x">what is NVDA at</channel>')).toBe(false);
  });

  it("boot recovery: a journal a crash left running is marked interrupted and the asker is told once", async () => {
    const root = mkdtempSync(join(tmpdir(), "rj-"));
    const name = journalDirName(Date.now(), MSG);
    mkdirSync(join(root, name), { recursive: true });
    const stale = Date.now() - 5 * 60_000;
    writeFileSync(
      join(root, name, "session.json"),
      JSON.stringify({
        version: 1, originMessageId: MSG, originTurnId: ORIGIN.turnId, channelId: "chan", cardMessageId: "card-1",
        startedAt: stale, updatedAt: stale, state: "running",
        researchers: [{ taskId: "a1", description: "Screen A", file: "a1-screen-a.md", status: "running", reason: null, startedAt: stale, endedAt: null }],
      }),
    );
    const edits: unknown[] = [];
    const { t, delivered } = tracker(root, { cardPort: () => ({ post: async () => "x", edit: async (_c, _m, s) => void edits.push(s) }) });
    await t.recoverFromDisk();
    expect(delivered).toEqual([
      { text: `Research on this was interrupted by a restart. Partial notes are saved in research/${name}/. Ask me to resume research to continue from them.`, replyTo: REPLY_TO },
    ]);
    expect(JSON.parse(readFileSync(join(root, name, "session.json"), "utf8")).state).toBe("interrupted");
    expect(edits).toHaveLength(1);
    // A second boot does not repeat it.
    const again = tracker(root);
    await again.t.recoverFromDisk();
    expect(again.delivered).toEqual([]);
    // A journal written seconds ago may belong to a handle still closing: left alone.
    expect(await recoverInterruptedJournals(root, Date.now())).toEqual([]);
  });

  it("caps a researcher file (~200 KB) keeping the head and the tail of its log", async () => {
    const root = mkdtempSync(join(tmpdir(), "rj-"));
    setLiveDiscordTurn(AGENT, ORIGIN);
    const { t } = tracker(root);
    t.observe(started("a1", "toolu_A"));
    for (let i = 0; i < 1500; i++) {
      t.observeChild("toolu_A", child("assistant", [{ type: "text", text: `entry-${i} ${"x".repeat(400)}` }]));
    }
    await settleJournal(t);
    const dir = join(root, journalDirName(Date.now(), MSG));
    const path = join(dir, readdirSync(dir).find((f) => f.startsWith("a1-"))!);
    const text = readFileSync(path, "utf8");
    expect(statSync(path).size).toBeLessThanOrEqual(RESEARCHER_FILE_CAP_BYTES);
    expect(text).toContain("entry-0 ");
    expect(text).toContain("entry-1499 ");
    expect(text).toMatch(/entries omitted/);
  });

  it("redacts secret-shaped strings and env-dump lines", () => {
    expect(redactSecrets(`key ${SYNTHETIC.anthropicKey} and ${SYNTHETIC.bearer} ${SYNTHETIC.passwordPair}`)).toBe(
      `key [redacted] and Bearer [redacted] ${"pass"}word=[redacted]`,
    );
    const out = redactSecrets(`${SYNTHETIC.envDump}\n${SYNTHETIC.opServiceToken} ${SYNTHETIC.githubPat}`);
    for (const raw of SYNTHETIC_RAW_VALUES) expect(out).not.toContain(raw);
    expect(out).toContain("HOME=/home/researcher");
    expect(out).toContain("FINNHUB_API_KEY=[redacted]");
  });

  it("shell output is never journaled (an env dump stays off disk); other results are redacted", async () => {
    const root = mkdtempSync(join(tmpdir(), "rj-"));
    setLiveDiscordTurn(AGENT, ORIGIN);
    const { t } = tracker(root);
    t.observe(started("a1", "toolu_A"));
    t.observeChild("toolu_A", child("assistant", [
      { type: "tool_use", id: "b1", name: "Bash", input: { command: "env" } },
      { type: "tool_use", id: "w1", name: "WebFetch", input: { url: "https://example.invalid/cfg" } },
    ]));
    t.observeChild("toolu_A", child("user", [
      { type: "tool_result", tool_use_id: "b1", content: SYNTHETIC.envDump },
      { type: "tool_result", tool_use_id: "w1", content: [{ type: "text", text: SYNTHETIC.envDump }] },
    ]));
    await settleJournal(t);
    const dir = join(root, journalDirName(Date.now(), MSG));
    const text = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    expect(text).toContain('Bash "env" → (output not saved)');
    expect(text).not.toContain("HOME=/home/researcher\n");
    for (const raw of SYNTHETIC_RAW_VALUES) expect(text).not.toContain(raw);
  });

  it("nothing is written when the tracker has no journal root (research off / no workspace)", async () => {
    const root = mkdtempSync(join(tmpdir(), "rj-"));
    setLiveDiscordTurn(AGENT, ORIGIN);
    const { t } = tracker(root, { journalRoot: undefined });
    t.observe(started("a1", "toolu_A"));
    t.observeChild("toolu_A", child("assistant", [{ type: "text", text: "FINDING: x — y" }]));
    await new Promise((r) => setTimeout(r, 20));
    expect(readdirSync(root)).toEqual([]);
    expect(existsSync(join(root, "research"))).toBe(false);
  });
});
