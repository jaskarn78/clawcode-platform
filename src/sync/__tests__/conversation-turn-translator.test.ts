/**
 * Phase 91 Plan 03 Task 2 — conversation-turn-translator tests.
 *
 * Pins: origin_id derivation, text-only content extraction (D-08),
 * mid-write skip (D-06), UNIQUE-index idempotency, graceful parse-error
 * recovery (D-10), incremental cursor advancement, session-row
 * deduplication.
 *
 * ConversationStore is exercised AGAINST A REAL in-memory sqlite database
 * (via MemoryStore + ConversationStore) so the UNIQUE index behaviour
 * matches production exactly. This is faster than mocking the raw sqlite
 * surface and pins the integration contract.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm, utimes, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nanoid } from "nanoid";
import type { Logger } from "pino";
import { MemoryStore } from "../../memory/store.js";
import { ConversationStore } from "../../memory/conversation-store.js";
import {
  translateAllSessions,
  computeTurnOriginId,
  computeClawcodeSessionId,
  extractTextContent,
  sha256Hex,
  MID_WRITE_SKIP_MS,
  type TranslatorDeps,
} from "../conversation-turn-translator.js";

/**
 * Build a minimal pino-shaped logger with vi.fn stubs. Signature-compatible
 * with Logger for translator DI without needing the real pino heavy-weight.
 */
function makeLogger(): Logger {
  const fn = vi.fn();
  return {
    warn: fn,
    debug: fn,
    info: fn,
    error: fn,
    trace: fn,
    fatal: fn,
    child: () => makeLogger(),
  } as unknown as Logger;
}

/** Build one OpenClaw session.jsonl file at `absPath` with the given events. */
async function writeSessionFile(
  absPath: string,
  sessionId: string,
  events: ReadonlyArray<object>,
  mtimeOffsetMs = 120_000,
): Promise<void> {
  const sessionHeader = {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd: "/tmp/test",
  };
  const lines = [sessionHeader, ...events]
    .map((e) => JSON.stringify(e))
    .join("\n");
  await writeFile(absPath, lines, "utf8");
  // Force mtime well in the past so D-06 mid-write skip does NOT fire
  // (defaults to 2 minutes ago — comfortably past the 60s threshold).
  const past = new Date(Date.now() - mtimeOffsetMs);
  await utimes(absPath, past, past);
}

describe("conversation-turn-translator", () => {
  let tmpDir: string;
  let sessionsDir: string;
  let cursorPath: string;
  let memStore: MemoryStore;
  let convStore: ConversationStore;
  let log: Logger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "turn-translator-"));
    sessionsDir = join(tmpDir, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    cursorPath = join(tmpDir, "cursor.json");
    memStore = new MemoryStore(":memory:", {
      enabled: false,
      similarityThreshold: 0.85,
    });
    convStore = new ConversationStore(memStore.getDatabase());
    log = makeLogger();
  });

  afterEach(async () => {
    memStore?.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeDeps(): TranslatorDeps {
    return {
      sessionsDir,
      conversationStore: convStore,
      cursorPath,
      agentName: "fin-client",
      log,
    };
  }

  it("CT1: computeTurnOriginId is deterministic and shaped openclaw-session-<16-hex>", () => {
    const id1 = computeTurnOriginId("abc123", 0);
    const id2 = computeTurnOriginId("abc123", 0);
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^openclaw-session-[0-9a-f]{16}$/);
    // Different inputs → different outputs
    expect(computeTurnOriginId("abc123", 1)).not.toBe(id1);
    expect(computeTurnOriginId("abc124", 0)).not.toBe(id1);
  });

  it("CT2: extractTextContent returns string verbatim for string input", () => {
    expect(extractTextContent("hello world")).toBe("hello world");
    expect(extractTextContent("")).toBe("");
  });

  it("CT3: extractTextContent drops tool_use, keeps only text blocks (D-08)", () => {
    const content = [
      { type: "text", text: "a" },
      { type: "tool_use", id: "t1", name: "Read", input: {} },
      { type: "text", text: "b" },
    ];
    expect(extractTextContent(content)).toBe("a\nb");
  });

  it("CT4: extractTextContent drops thinking + tool_result blocks (D-08)", () => {
    const content = [
      { type: "thinking", content: "secret internal reasoning" },
      { type: "text", text: "visible" },
      { type: "tool_result", tool_use_id: "t1", content: "tool output" },
    ];
    expect(extractTextContent(content)).toBe("visible");
  });

  it("CT5: files with mtime within 60s of now are SKIPPED (D-06)", async () => {
    const abs = join(sessionsDir, "recent.jsonl");
    await writeSessionFile(
      abs,
      "recent-sess",
      [
        {
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "hi" }] },
        },
      ],
      30_000, // 30s ago — WITHIN the 60s mid-write threshold
    );
    const outcome = await translateAllSessions(makeDeps());
    expect(outcome.sessionsSkippedMidWrite).toBe(1);
    expect(outcome.turnsInserted).toBe(0);
    // Confirm mtime was indeed within the skip window
    expect(MID_WRITE_SKIP_MS).toBe(60_000);
  });

  it("CT6: 3 user+assistant messages → turnsInserted=3 in ConversationStore", async () => {
    const abs = join(sessionsDir, "s1.jsonl");
    await writeSessionFile(abs, "s1", [
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      },
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "how are you?" }] },
      },
    ]);
    const outcome = await translateAllSessions(makeDeps());
    expect(outcome.turnsInserted).toBe(3);
    expect(outcome.sessionsScanned).toBe(1);

    // Verify rows landed in the DB
    const clawcodeSessionId = computeClawcodeSessionId("s1");
    const turns = convStore.getTurnsForSession(clawcodeSessionId);
    expect(turns).toHaveLength(3);
    expect(turns[0].role).toBe("user");
    expect(turns[0].content).toBe("hi");
    expect(turns[1].role).toBe("assistant");
    expect(turns[1].content).toBe("hello");
    expect(turns[2].role).toBe("user");
    expect(turns[2].content).toBe("how are you?");
  });

  it("CT7: re-running translator on same file → turnsSkippedDuplicate; zero new DB rows", async () => {
    const abs = join(sessionsDir, "s2.jsonl");
    await writeSessionFile(abs, "s2", [
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "one" }] },
      },
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "two" }] },
      },
    ]);
    const first = await translateAllSessions(makeDeps());
    expect(first.turnsInserted).toBe(2);

    // Wipe the cursor to force the translator to re-scan (so the
    // UNIQUE-index gate is what prevents duplicates, not the cursor).
    await rm(cursorPath, { force: true });

    const second = await translateAllSessions(makeDeps());
    // Full re-scan — every turn hits the UNIQUE(session_id, turn_index, role)
    // constraint and registers as a duplicate-skip, not a fresh insert.
    expect(second.turnsInserted).toBe(0);
    expect(second.turnsSkippedDuplicate).toBe(2);

    // DB still has exactly 2 rows — no duplication
    const clawcodeSessionId = computeClawcodeSessionId("s2");
    const turns = convStore.getTurnsForSession(clawcodeSessionId);
    expect(turns).toHaveLength(2);
  });

  it("CT8: custom/session/model-change/tool_use-only lines count in turnsSkippedNonText", async () => {
    const abs = join(sessionsDir, "s3.jsonl");
    await writeSessionFile(abs, "s3", [
      { type: "model_change", provider: "anthropic-api", modelId: "claude-opus-4-8" },
      { type: "thinking_level_change", thinkingLevel: "off" },
      { type: "custom", customType: "model-snapshot", data: {} },
      {
        type: "message",
        message: { role: "system", content: "system prompt" },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }],
        },
      },
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "real" }] },
      },
    ]);
    const outcome = await translateAllSessions(makeDeps());
    expect(outcome.turnsInserted).toBe(1);
    // model_change + thinking_level_change + custom + system-role + tool_use-only = 5 non-text
    expect(outcome.turnsSkippedNonText).toBe(5);
  });

  it("CT9: malformed JSONL line → parse error counted; subsequent lines still processed (D-10)", async () => {
    const abs = join(sessionsDir, "s4.jsonl");
    const headerLine = JSON.stringify({
      type: "session",
      version: 3,
      id: "s4",
      timestamp: new Date().toISOString(),
      cwd: "/t",
    });
    const goodA = JSON.stringify({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "A" }] },
    });
    const garbage = "{not json;;";
    const goodB = JSON.stringify({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "B" }] },
    });
    await writeFile(
      abs,
      [headerLine, goodA, garbage, goodB].join("\n"),
      "utf8",
    );
    const past = new Date(Date.now() - 120_000);
    await utimes(abs, past, past);

    const outcome = await translateAllSessions(makeDeps());
    expect(outcome.sessionsSkippedParseError).toBeGreaterThanOrEqual(1);
    // Both good messages still landed
    expect(outcome.turnsInserted).toBe(2);
  });

  it("CT10: cursor persists with byteOffset + lineCount + fileSize + mtime after run", async () => {
    const abs = join(sessionsDir, "s5.jsonl");
    await writeSessionFile(abs, "s5", [
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "x" }] },
      },
    ]);
    await translateAllSessions(makeDeps());
    const { readTranslatorCursor } = await import("../translator-cursor-store.js");
    const cursor = await readTranslatorCursor(cursorPath, log);
    expect(cursor.perFileCursor[abs]).toBeDefined();
    const entry = cursor.perFileCursor[abs];
    expect(entry.byteOffset).toBeGreaterThan(0);
    expect(entry.lineCount).toBeGreaterThan(0);
    expect(entry.fileSize).toBeGreaterThan(0);
    expect(entry.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(cursor.lastScanAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("CT11: second run with same cursor + no file changes → zero session reads, zero inserts", async () => {
    const abs = join(sessionsDir, "s6.jsonl");
    await writeSessionFile(abs, "s6", [
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "x" }] },
      },
    ]);
    const first = await translateAllSessions(makeDeps());
    expect(first.sessionsScanned).toBe(1);
    expect(first.turnsInserted).toBe(1);

    // Second run WITHOUT modifying the file — cursor's size+mtime match
    // so the translator skips it entirely (sessionsScanned==0).
    const second = await translateAllSessions(makeDeps());
    expect(second.sessionsScanned).toBe(0);
    expect(second.turnsInserted).toBe(0);
    expect(second.turnsSkippedDuplicate).toBe(0);
  });

  it("CT12: incremental append — file grew by 2 lines → translator processes only the new 2", async () => {
    const abs = join(sessionsDir, "s7.jsonl");
    await writeSessionFile(abs, "s7", [
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "one" }] },
      },
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "two" }] },
      },
    ]);
    const first = await translateAllSessions(makeDeps());
    expect(first.turnsInserted).toBe(2);

    // Append two more message events (preserve existing content, append new
    // lines, update mtime to 2 minutes ago so mid-write skip does NOT fire).
    const appendA = JSON.stringify({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "three" }] },
    });
    const appendB = JSON.stringify({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "four" }] },
    });
    const { readFile, appendFile } = await import("node:fs/promises");
    // Append on its own line
    const existing = await readFile(abs, "utf8");
    await writeFile(abs, existing + "\n" + appendA + "\n" + appendB, "utf8");
    const past = new Date(Date.now() - 120_000);
    await utimes(abs, past, past);
    // silence the unused import warning
    void appendFile;

    const second = await translateAllSessions(makeDeps());
    expect(second.turnsInserted).toBe(2);
    expect(second.sessionsScanned).toBe(1);
    // Zero duplicate reports — cursor fast-forwarded past already-inserted
    expect(second.turnsSkippedDuplicate).toBe(0);

    // DB should have 4 rows total
    const clawcodeSessionId = computeClawcodeSessionId("s7");
    const turns = convStore.getTurnsForSession(clawcodeSessionId);
    expect(turns).toHaveLength(4);
    expect(turns.map((t) => t.content)).toEqual([
      "one",
      "two",
      "three",
      "four",
    ]);
  });

  it("CT13: origin column stores deterministic openclaw-session-<hash16> for each turn", async () => {
    const abs = join(sessionsDir, "s8.jsonl");
    await writeSessionFile(abs, "s8", [
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "x" }] },
      },
    ]);
    await translateAllSessions(makeDeps());
    const clawcodeSessionId = computeClawcodeSessionId("s8");
    const turns = convStore.getTurnsForSession(clawcodeSessionId);
    expect(turns).toHaveLength(1);
    expect(turns[0].origin).toBe(computeTurnOriginId("s8", 0));
    expect(turns[0].origin).toMatch(/^openclaw-session-[0-9a-f]{16}$/);
  });

  it("CT14: missing sessionsDir returns zeroed outcome without throwing", async () => {
    const deps: TranslatorDeps = {
      ...makeDeps(),
      sessionsDir: join(tmpDir, "does-not-exist"),
    };
    const outcome = await translateAllSessions(deps);
    expect(outcome.sessionsScanned).toBe(0);
    expect(outcome.turnsInserted).toBe(0);
    // Warn logged for the unreadable dir
    expect(log.warn).toHaveBeenCalled();
  });

  it("CT15: sha256Hex produces stable 64-char hex digest", () => {
    const h = sha256Hex("hello");
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]+$/);
    expect(sha256Hex("hello")).toBe(h);
  });
});
