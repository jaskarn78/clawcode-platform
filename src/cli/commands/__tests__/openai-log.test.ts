/**
 * Quick task 260419-mvh Task 2 — unit tests for `clawcode openai-log tail`.
 *
 * Tests the CLI subcommand in isolation with a fixture JSONL file — no
 * real daemon, no real ~/.clawcode/.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";

import {
  registerOpenAiLogCommand,
  type OpenAiLogCommandDeps,
} from "../openai-log.js";
import type { RequestLogRecord } from "../../../openai/request-logger.js";

function makeRecord(overrides: Partial<RequestLogRecord>): RequestLogRecord {
  return {
    request_id: "rid-x",
    timestamp_iso: "2026-04-19T12:00:00.000Z",
    method: "POST",
    path: "/v1/chat/completions",
    agent: "clawdy",
    model: "clawdy",
    stream: false,
    status_code: 200,
    ttfb_ms: null,
    total_ms: 42,
    bearer_key_prefix: "ck_live_aaaa",
    messages_count: 1,
    response_bytes: 128,
    error_type: null,
    error_code: null,
    finish_reason: "stop",
    ...overrides,
  };
}

function writeFixture(dir: string, date: string, records: RequestLogRecord[]): void {
  const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(join(dir, `openai-requests-${date}.jsonl`), lines);
}

function makeDeps(dir: string, now: Date): {
  deps: OpenAiLogCommandDeps;
  logs: string[];
  errors: string[];
  exits: number[];
} {
  const logs: string[] = [];
  const errors: string[] = [];
  const exits: number[] = [];
  const deps: OpenAiLogCommandDeps = {
    log: (msg) => logs.push(msg),
    error: (msg) => errors.push(msg),
    exit: (code) => {
      exits.push(code);
    },
    now: () => now,
    dir,
  };
  return { deps, logs, errors, exits };
}

async function invokeTail(
  deps: OpenAiLogCommandDeps,
  args: string[],
): Promise<void> {
  const program = new Command();
  // Prevent commander from calling process.exit on validation errors.
  program.exitOverride();
  registerOpenAiLogCommand(program, deps);
  await program.parseAsync(["node", "clawcode", "openai-log", "tail", ...args]);
}

describe("clawcode openai-log tail", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oai-log-cli-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("CLI-1 — filters by --agent", async () => {
    const now = new Date("2026-04-19T12:30:00.000Z");
    writeFixture(dir, "2026-04-19", [
      makeRecord({ request_id: "r-clawdy-1", agent: "clawdy", timestamp_iso: "2026-04-19T12:20:00.000Z" }),
      makeRecord({ request_id: "r-clawdy-2", agent: "clawdy", timestamp_iso: "2026-04-19T12:25:00.000Z" }),
      makeRecord({ request_id: "r-assistant-1", agent: "assistant", timestamp_iso: "2026-04-19T12:25:00.000Z" }),
    ]);
    const { deps, logs } = makeDeps(dir, now);

    await invokeTail(deps, ["--agent", "clawdy", "--since", "1h"]);

    const all = logs.join("\n");
    expect(all).toContain("r-clawdy-1");
    expect(all).toContain("r-clawdy-2");
    expect(all).not.toContain("r-assistant-1");
  });

  it("CLI-2 — --since filters out older records", async () => {
    const now = new Date("2026-04-19T12:30:00.000Z");
    writeFixture(dir, "2026-04-19", [
      makeRecord({
        request_id: "r-recent",
        timestamp_iso: "2026-04-19T12:00:00.000Z", // 30 min ago
      }),
      makeRecord({
        request_id: "r-old",
        timestamp_iso: "2026-04-19T10:00:00.000Z", // 2h30min ago
      }),
    ]);
    const { deps, logs } = makeDeps(dir, now);

    await invokeTail(deps, ["--since", "1h"]);

    const all = logs.join("\n");
    expect(all).toContain("r-recent");
    expect(all).not.toContain("r-old");
  });

  it("CLI-3 — --json emits raw JSON lines only (no table framing)", async () => {
    const now = new Date("2026-04-19T12:30:00.000Z");
    writeFixture(dir, "2026-04-19", [
      makeRecord({ request_id: "r-json-1" }),
    ]);
    const { deps, logs } = makeDeps(dir, now);

    await invokeTail(deps, ["--since", "1h", "--json"]);

    const all = logs.join("\n");
    // No padded columns / --- divider in JSON mode.
    expect(all).not.toMatch(/^-+\s+-+/m);
    // Every non-empty line must parse as JSON.
    for (const line of logs) {
      if (line.trim().length === 0) continue;
      expect(() => JSON.parse(line)).not.toThrow();
    }
    const parsed = JSON.parse(logs[0]!);
    expect(parsed.request_id).toBe("r-json-1");
  });

  it("CLI-4 — no records → 'No requests logged.', exit 0", async () => {
    const now = new Date("2026-04-19T12:30:00.000Z");
    const { deps, logs, exits } = makeDeps(dir, now);

    await invokeTail(deps, ["--since", "1h"]);

    expect(logs.join("\n")).toContain("No requests logged.");
    expect(exits).not.toContain(1);
  });

  it("CLI-5 — default table output has padded columns + divider", async () => {
    const now = new Date("2026-04-19T12:30:00.000Z");
    writeFixture(dir, "2026-04-19", [
      makeRecord({
        request_id: "r-tbl-1",
        timestamp_iso: "2026-04-19T12:20:00.000Z",
      }),
    ]);
    const { deps, logs } = makeDeps(dir, now);

    await invokeTail(deps, ["--since", "1h"]);

    // First line is the header line, second is the `-`-divider, subsequent
    // lines are data. Exact rendering mirrors openai-key's renderListTable.
    const nonEmpty = logs.join("\n").split("\n").filter((l) => l.length > 0);
    expect(nonEmpty.length).toBeGreaterThanOrEqual(3);
    expect(nonEmpty[1]).toMatch(/^-+(\s+-+)*$/);
    // Header includes the expected columns.
    expect(nonEmpty[0]).toContain("request_id");
    expect(nonEmpty[0]).toContain("agent");
    expect(nonEmpty[0]).toContain("status");
    // Data row contains the request_id.
    expect(nonEmpty[2]).toContain("r-tbl-1");
  });

  it("CLI-6 — --since 48h reads today + yesterday's files", async () => {
    const now = new Date("2026-04-19T12:30:00.000Z");
    writeFixture(dir, "2026-04-19", [
      makeRecord({
        request_id: "r-today",
        timestamp_iso: "2026-04-19T11:00:00.000Z",
      }),
    ]);
    writeFixture(dir, "2026-04-18", [
      makeRecord({
        request_id: "r-yesterday",
        timestamp_iso: "2026-04-18T15:00:00.000Z",
      }),
    ]);
    const { deps, logs } = makeDeps(dir, now);

    await invokeTail(deps, ["--since", "48h"]);

    const all = logs.join("\n");
    expect(all).toContain("r-today");
    expect(all).toContain("r-yesterday");
  });

  it("CLI-7 — invalid --since → error + exit 1", async () => {
    const now = new Date("2026-04-19T12:30:00.000Z");
    const { deps, errors, exits } = makeDeps(dir, now);

    await invokeTail(deps, ["--since", "notaduration"]);

    expect(errors.length).toBeGreaterThan(0);
    expect(exits).toContain(1);
  });
});
