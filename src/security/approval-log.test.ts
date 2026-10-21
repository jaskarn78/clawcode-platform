import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ApprovalLog } from "./approval-log.js";
import type { ApprovalAuditEntry } from "./types.js";

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: "info",
  } as unknown as import("pino").Logger;
}

describe("ApprovalLog", () => {
  let tmpDir: string;
  let logPath: string;
  let log: import("pino").Logger;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `approval-log-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    logPath = join(tmpDir, "approval.jsonl");
    log = createMockLogger();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("records an approval entry as JSONL", async () => {
    const approvalLog = new ApprovalLog({ filePath: logPath, log });
    const entry: ApprovalAuditEntry = {
      timestamp: "2026-04-09T20:00:00.000Z",
      agentName: "test-agent",
      command: "npm install express",
      decision: "approved",
      approvedBy: "admin",
    };

    await approvalLog.record(entry);

    const content = await readFile(logPath, "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed).toEqual(entry);
  });

  it("appends multiple entries as separate lines", async () => {
    const approvalLog = new ApprovalLog({ filePath: logPath, log });

    await approvalLog.record({
      timestamp: "2026-04-09T20:00:00.000Z",
      agentName: "agent-a",
      command: "cmd1",
      decision: "approved",
      approvedBy: "admin",
    });
    await approvalLog.record({
      timestamp: "2026-04-09T20:01:00.000Z",
      agentName: "agent-b",
      command: "cmd2",
      decision: "denied",
      approvedBy: "admin",
    });

    const content = await readFile(logPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("loadAllowAlways returns patterns for specific agent", async () => {
    const approvalLog = new ApprovalLog({ filePath: logPath, log });

    await approvalLog.recordAllowAlways("agent-a", "npm *", "admin");
    await approvalLog.recordAllowAlways("agent-b", "git *", "admin");
    await approvalLog.recordAllowAlways("agent-a", "docker *", "admin");

    const patterns = approvalLog.loadAllowAlways("agent-a");
    expect(patterns).toEqual(["npm *", "docker *"]);
  });

  it("loadAllowAlways returns empty array for nonexistent file", () => {
    const approvalLog = new ApprovalLog({
      filePath: join(tmpDir, "nonexistent.jsonl"),
      log,
    });
    const patterns = approvalLog.loadAllowAlways("agent-a");
    expect(patterns).toEqual([]);
  });

  it("loadAllowAlways filters out non-allow-always entries", async () => {
    const approvalLog = new ApprovalLog({ filePath: logPath, log });

    await approvalLog.record({
      timestamp: "2026-04-09T20:00:00.000Z",
      agentName: "agent-a",
      command: "npm install express",
      decision: "approved",
      approvedBy: "admin",
    });
    await approvalLog.recordAllowAlways("agent-a", "npm *", "admin");

    const patterns = approvalLog.loadAllowAlways("agent-a");
    expect(patterns).toEqual(["npm *"]);
  });

  it("recordAllowAlways creates a valid allow-always audit entry", async () => {
    const approvalLog = new ApprovalLog({ filePath: logPath, log });
    await approvalLog.recordAllowAlways("test-agent", "docker build *", "admin-user");

    const content = await readFile(logPath, "utf-8");
    const parsed = JSON.parse(content.trim()) as ApprovalAuditEntry;
    expect(parsed.decision).toBe("allow-always");
    expect(parsed.agentName).toBe("test-agent");
    expect(parsed.command).toBe("docker build *");
    expect(parsed.approvedBy).toBe("admin-user");
    expect(parsed.timestamp).toBeTruthy();
  });
});
