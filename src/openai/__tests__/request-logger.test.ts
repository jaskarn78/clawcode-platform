/**
 * Quick task 260419-mvh Task 2 — unit tests for src/openai/request-logger.ts.
 *
 * Boundary: temp-dir fs only. No writes to ~/.clawcode/. All spies restored
 * in afterEach.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";

import {
  createRequestLogger,
  type RequestLogRecord,
  type RequestLogger,
} from "../request-logger.js";

const silentLog = pino({ level: "silent" });

function makeRecord(overrides: Partial<RequestLogRecord> = {}): RequestLogRecord {
  return {
    request_id: "rid-1",
    timestamp_iso: "2026-04-19T12:00:00.000Z",
    method: "POST",
    path: "/v1/chat/completions",
    agent: "clawdy",
    model: "clawdy",
    stream: false,
    status_code: 200,
    ttfb_ms: null,
    total_ms: 42,
    bearer_key_prefix: "ck_live_aaa",
    messages_count: 1,
    response_bytes: 128,
    error_type: null,
    error_code: null,
    finish_reason: "stop",
    ...overrides,
  };
}

describe("createRequestLogger", () => {
  let dir: string;
  let logger: RequestLogger | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oai-log-"));
  });

  afterEach(async () => {
    if (logger) {
      await logger.close();
      logger = null;
    }
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("RL-1 — writes one JSON line per record", () => {
    const fixedClock = () => new Date("2026-04-19T10:00:00.000Z");
    logger = createRequestLogger({ dir, clock: fixedClock, log: silentLog });
    logger.log(makeRecord({ request_id: "rid-a" }));
    logger.log(makeRecord({ request_id: "rid-b", status_code: 401 }));
    logger.log(makeRecord({ request_id: "rid-c", stream: true }));

    const filePath = join(dir, "openai-requests-2026-04-19.jsonl");
    expect(existsSync(filePath)).toBe(true);
    const raw = readFileSync(filePath, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].request_id).toBe("rid-a");
    expect(parsed[1].status_code).toBe(401);
    expect(parsed[2].stream).toBe(true);
    // Verify shape on at least one record.
    const r = parsed[0];
    for (const key of [
      "request_id",
      "timestamp_iso",
      "method",
      "path",
      "agent",
      "status_code",
      "ttfb_ms",
      "total_ms",
      "bearer_key_prefix",
      "messages_count",
      "response_bytes",
      "error_type",
      "error_code",
      "finish_reason",
      "stream",
    ]) {
      expect(r).toHaveProperty(key);
    }
  });

  it("RL-2 — bearer_key_prefix is exactly 12 chars and full bearer never leaks", () => {
    const fullBearer =
      "ck_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbb";
    const prefix = fullBearer.slice(0, 12);
    const fixedClock = () => new Date("2026-04-19T10:00:00.000Z");
    logger = createRequestLogger({ dir, clock: fixedClock, log: silentLog });
    logger.log(makeRecord({ bearer_key_prefix: prefix }));

    const raw = readFileSync(
      join(dir, "openai-requests-2026-04-19.jsonl"),
      "utf8",
    );
    const parsed = JSON.parse(raw.split("\n").filter((l) => l.length > 0)[0]!);
    expect(parsed.bearer_key_prefix).toHaveLength(12);
    expect(parsed.bearer_key_prefix).toBe("ck_live_aaaa");
    // Raw file text does not contain the chars beyond the 12-char prefix.
    expect(raw.indexOf("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(-1);
    expect(raw.indexOf("bbbbbbbb")).toBe(-1);
  });

  it("RL-3 — includeBodies:false (default) omits messages array, keeps messages_count", () => {
    const fixedClock = () => new Date("2026-04-19T10:00:00.000Z");
    logger = createRequestLogger({ dir, clock: fixedClock, log: silentLog });
    const record = {
      ...makeRecord({ messages_count: 1 }),
      messages: [{ role: "user", content: "hello world (12)" }],
    };
    logger.log(record);

    const raw = readFileSync(
      join(dir, "openai-requests-2026-04-19.jsonl"),
      "utf8",
    );
    const parsed = JSON.parse(raw.split("\n").filter((l) => l.length > 0)[0]!);
    expect(parsed.messages_count).toBe(1);
    expect(parsed.messages).toBeUndefined();
    // Raw content must not contain the message body either.
    expect(raw.indexOf("hello world (12)")).toBe(-1);
  });

  it("RL-4 — includeBodies:true includes messages verbatim", () => {
    const fixedClock = () => new Date("2026-04-19T10:00:00.000Z");
    logger = createRequestLogger({
      dir,
      clock: fixedClock,
      log: silentLog,
      includeBodies: true,
    });
    const record = {
      ...makeRecord({ messages_count: 1 }),
      messages: [{ role: "user", content: "hello world (12)" }],
    };
    logger.log(record);

    const raw = readFileSync(
      join(dir, "openai-requests-2026-04-19.jsonl"),
      "utf8",
    );
    const parsed = JSON.parse(raw.split("\n").filter((l) => l.length > 0)[0]!);
    expect(parsed.messages).toEqual([{ role: "user", content: "hello world (12)" }]);
  });

  it("RL-5 — appender throw triggers rate-limited warn (1/min), never re-throws", () => {
    let currentMs = 1_000_000_000;
    const clock = () => new Date(currentMs);
    const warnSpy = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeLog = { warn: warnSpy, info: () => {}, error: () => {} } as any;
    // Inject a throwing appender — tests the rate-limit + swallow contract.
    const throwingAppender = vi.fn(() => {
      throw new Error("EACCES");
    });

    logger = createRequestLogger({
      dir,
      clock,
      log: fakeLog,
      appender: throwingAppender,
    });

    // 3 rapid calls within 1 minute — warn should fire ONLY once.
    expect(() => logger!.log(makeRecord())).not.toThrow();
    expect(() => logger!.log(makeRecord())).not.toThrow();
    expect(() => logger!.log(makeRecord())).not.toThrow();
    expect(throwingAppender).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // Advance clock past 60s, call again — warn fires a second time.
    currentMs += 61_000;
    expect(() => logger!.log(makeRecord())).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("RL-6 — log dir is created on first write (recursive)", () => {
    const nested = join(dir, "nested/new");
    const fixedClock = () => new Date("2026-04-19T10:00:00.000Z");
    logger = createRequestLogger({ dir: nested, clock: fixedClock, log: silentLog });
    logger.log(makeRecord());
    expect(existsSync(join(nested, "openai-requests-2026-04-19.jsonl"))).toBe(true);
  });

  it("RL-7 — close() resolves immediately (no writes needed)", async () => {
    const fixedClock = () => new Date("2026-04-19T10:00:00.000Z");
    logger = createRequestLogger({ dir, clock: fixedClock, log: silentLog });
    const started = Date.now();
    await logger.close();
    expect(Date.now() - started).toBeLessThan(100);
    logger = null; // avoid double-close in afterEach
  });

  it("RL-8 — filename uses UTC date (date boundary respected across timezones)", () => {
    // 2026-04-19T23:00:00 UTC → file should be 2026-04-19.jsonl regardless
    // of local TZ.
    const fixedClock = () => new Date("2026-04-19T23:59:59.999Z");
    logger = createRequestLogger({ dir, clock: fixedClock, log: silentLog });
    logger.log(makeRecord());
    expect(existsSync(join(dir, "openai-requests-2026-04-19.jsonl"))).toBe(true);
  });
});
