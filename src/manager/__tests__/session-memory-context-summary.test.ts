/**
 * Memory overhaul 2026-10-25 (WP4): AgentMemoryManager writes the final
 * session summary into context-summary.md with a `Generated: <ISO>` line, so
 * the next boot's "Context Summary (from previous session)" block holds a
 * real summary instead of nothing (or the zone-snapshot placeholder).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { AgentMemoryManager } from "../session-memory.js";
import { loadLatestSummary } from "../../memory/context-summary.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";

const silentLog = pino({ level: "silent" });

function makeConfig(workspace: string, name: string): ResolvedAgentConfig {
  return {
    name,
    model: "sonnet",
    effort: "medium",
    workspace,
    memoryPath: workspace,
    systemPrompt: "",
    channels: [],
    memory: { compactionThreshold: 0.8 },
  } as unknown as ResolvedAgentConfig;
}

const vec = (): Float32Array => new Float32Array(384).fill(0.1);

describe("AgentMemoryManager.saveSessionSummaryAsContextSummary (WP4)", () => {
  let tmp: string;
  let mgr: AgentMemoryManager;
  const name = "alice";

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ctx-summary-wp4-"));
    mgr = new AgentMemoryManager(silentLog);
    mgr.initMemory(name, makeConfig(tmp, name));
  });

  afterEach(async () => {
    for (const n of Array.from(mgr.memoryStores.keys())) mgr.cleanupMemory(n);
    await rm(tmp, { recursive: true, force: true });
  });

  /** End a session and attach a summary row, as summarizeSession does. */
  function summarizedSession(
    content: string,
    extraTags: readonly string[] = [],
  ): { sessionId: string; memoryId: string } {
    const conv = mgr.conversationStores.get(name)!;
    const mem = mgr.memoryStores.get(name)!;
    const session = conv.startSession(name);
    conv.recordTurn({ sessionId: session.id, role: "user", content: "hi" });
    conv.endSession(session.id);
    const entry = mem.insert(
      {
        content,
        source: "conversation",
        importance: 0.78,
        tags: ["session-summary", `session:${session.id}`, ...extraTags],
        skipDedup: true,
      },
      vec(),
    );
    conv.markSummarized(session.id, entry.id);
    return { sessionId: session.id, memoryId: entry.id };
  }

  it("writes the session summary with a Generated: <ISO> first line", async () => {
    const { sessionId } = summarizedSession(
      "## Decisions\n- staging and prod share one database\n\n## Open Threads\n- rotate the key",
    );
    const at = new Date("2026-10-26T17:30:00.000Z");

    const outcome = await mgr.saveSessionSummaryAsContextSummary(name, tmp, sessionId, at);

    expect(outcome).toBe("written");
    const body = await loadLatestSummary(join(tmp, "memory"));
    expect(body).toBeDefined();
    expect(body!.split("\n")[0]).toBe("Generated: 2026-10-26T17:30:00.000Z");
    expect(body).toContain("staging and prod share one database");
    expect(body).toContain("## Open Threads");
    const raw = await readFile(join(tmp, "memory", "context-summary.md"), "utf8");
    expect(raw).toContain("**Agent:** alice");
  });

  it("does not bump the summary row's access_count", async () => {
    const { sessionId, memoryId } = summarizedSession("## Decisions\n- x");
    const db = mgr.memoryStores.get(name)!.getDatabase();
    const before = (db.prepare("SELECT access_count FROM memories WHERE id = ?").get(memoryId) as {
      access_count: number;
    }).access_count;
    await mgr.saveSessionSummaryAsContextSummary(name, tmp, sessionId);
    const after = (db.prepare("SELECT access_count FROM memories WHERE id = ?").get(memoryId) as {
      access_count: number;
    }).access_count;
    expect(after).toBe(before);
  });

  it("prefers the row the session points at over another summary row for the same session", async () => {
    const { sessionId } = summarizedSession("## Decisions\n- THE-LINKED-SUMMARY");
    // A duplicate written later by a racing summarizer (crash vs stop path).
    mgr.memoryStores.get(name)!.insert(
      {
        content: "## Decisions\n- THE-DUPLICATE",
        source: "conversation",
        tags: ["session-summary", `session:${sessionId}`],
        skipDedup: true,
      },
      vec(),
    );
    await mgr.saveSessionSummaryAsContextSummary(name, tmp, sessionId);
    const body = await loadLatestSummary(join(tmp, "memory"));
    expect(body).toContain("THE-LINKED-SUMMARY");
    expect(body).not.toContain("THE-DUPLICATE");
  });

  it("ignores mid-session flush rows that share the session tag", async () => {
    const conv = mgr.conversationStores.get(name)!;
    const session = conv.startSession(name);
    mgr.memoryStores.get(name)!.insert(
      {
        content: "mid-session flush body",
        source: "conversation",
        tags: ["mid-session", `session:${session.id}`, "flush:1"],
        skipDedup: true,
      },
      vec(),
    );
    const outcome = await mgr.saveSessionSummaryAsContextSummary(name, tmp, session.id);
    expect(outcome).toBe("no-summary");
    expect(existsSync(join(tmp, "memory", "context-summary.md"))).toBe(false);
  });

  it("leaves the previous file alone for a raw-turn fallback summary", async () => {
    await mkdir(join(tmp, "memory"), { recursive: true });
    await mgr.saveContextSummary(name, tmp, "PREVIOUS SUMMARY", {
      generatedAt: "2026-10-25T08:00:00.000Z",
    });
    const { sessionId } = summarizedSession("### user 10:00\nraw dump", ["raw-fallback"]);

    const outcome = await mgr.saveSessionSummaryAsContextSummary(name, tmp, sessionId);

    expect(outcome).toBe("raw-fallback");
    const body = await loadLatestSummary(join(tmp, "memory"));
    expect(body).toContain("PREVIOUS SUMMARY");
  });

  it("returns no-summary for a session that was never summarized, and no-store for an unknown agent", async () => {
    const conv = mgr.conversationStores.get(name)!;
    const session = conv.startSession(name);
    conv.endSession(session.id);
    expect(await mgr.saveSessionSummaryAsContextSummary(name, tmp, session.id)).toBe(
      "no-summary",
    );
    expect(await mgr.saveSessionSummaryAsContextSummary("ghost", tmp, session.id)).toBe(
      "no-store",
    );
  });

  it("returns failed (never throws) when the summary file cannot be written", async () => {
    const { sessionId } = summarizedSession("## Decisions\n- y");
    // A regular file where the memory directory should be.
    const blocked = join(tmp, "blocked");
    await writeFile(blocked, "not a directory");
    expect(await mgr.saveSessionSummaryAsContextSummary(name, blocked, sessionId)).toBe(
      "failed",
    );
  });
});

describe("AgentMemoryManager.saveContextSummary generatedAt option (WP4)", () => {
  let tmp: string;
  let mgr: AgentMemoryManager;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ctx-summary-opt-"));
    mgr = new AgentMemoryManager(silentLog);
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("keeps the old layout when no timestamp is passed", async () => {
    await mgr.saveContextSummary("bob", tmp, "plain body");
    expect(await loadLatestSummary(join(tmp, "memory"))).toBe("plain body");
  });

  it("puts Generated: <ISO> on the first body line when a timestamp is passed", async () => {
    await mgr.saveContextSummary("bob", tmp, "plain body", {
      generatedAt: "2026-10-26T00:00:00.000Z",
    });
    expect(await loadLatestSummary(join(tmp, "memory"))).toBe(
      "Generated: 2026-10-26T00:00:00.000Z\n\nplain body",
    );
  });
});
