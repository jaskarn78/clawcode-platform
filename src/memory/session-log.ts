import { appendFile, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * SessionLogger writes daily markdown session log files.
 *
 * Each day gets a separate file at {memoryDir}/YYYY-MM-DD.md.
 * Entries are appended with timestamp, role, and content.
 *
 * Phase 127 — also writes structured event rows (e.g. `recordStall`) to a
 * sibling `events.jsonl` file in the same memoryDir. The two writers stay
 * separate so the daily markdown remains human-readable (no JSON blobs
 * mixed in) and JSONL consumers (Phase 124/125 compaction extractors)
 * can `readlines + JSON.parse` without markdown-aware preprocessing.
 */
export class SessionLogger {
  private readonly memoryDir: string;

  constructor(memoryDir: string) {
    this.memoryDir = memoryDir;
    // Ensure directory exists
    if (!existsSync(memoryDir)) {
      mkdirSync(memoryDir, { recursive: true });
    }
  }

  /**
   * Phase 127 — record a stream-stall event in the session JSONL.
   *
   * Appends a single JSONL row to `{memoryDir}/events.jsonl`:
   * `{type: "stall", reason: "no-useful-tokens-timeout", timestamp, ...payload}`.
   *
   * Phase 124/125 compaction extractors consume this file as a stall
   * pattern indicator in the active-state header so operators can see
   * "agent had N stalls this week" without scraping logs. The format is
   * intentionally narrow + flat — adding a new event type later means
   * adding a new method here, not generalising this one.
   *
   * Fire-and-forget at the call site: the awaitable shape exists for
   * tests that assert call ordering, but daemon callers MUST `.catch`
   * the rejection so a transient fs error doesn't break supervisor
   * recovery (Phase 89 canary precedent).
   */
  async recordStall(payload: {
    readonly agentName: string;
    readonly sessionName: string;
    readonly turnId: string;
    readonly lastUsefulTokenAgeMs: number;
    readonly thresholdMs: number;
    readonly advisorActive: boolean;
    readonly model: string;
    readonly effort: string;
  }): Promise<void> {
    const row = {
      type: "stall" as const,
      reason: "no-useful-tokens-timeout" as const,
      timestamp: new Date().toISOString(),
      ...payload,
    };
    const filePath = join(this.memoryDir, "events.jsonl");
    await appendFile(filePath, JSON.stringify(row) + "\n", "utf-8");
  }

  /**
   * Append a single entry to the daily log file.
   * Creates the file with a header if it does not yet exist.
   */
  async appendEntry(
    timestamp: string,
    role: "user" | "assistant",
    content: string,
  ): Promise<void> {
    const date = extractDate(timestamp);
    const time = extractTime(timestamp);
    const filePath = this.getFilePath(date);
    const entry = `\n## ${time} [${role}]\n${content}\n`;

    if (!existsSync(filePath)) {
      const header = `# Session Log: ${date}\n`;
      await writeFile(filePath, header + entry, "utf-8");
    } else {
      await appendFile(filePath, entry, "utf-8");
    }
  }

  /**
   * Flush multiple conversation entries to today's log file.
   * Returns the file path for tracking in the session_logs table.
   */
  async flushConversation(
    entries: ReadonlyArray<{
      readonly timestamp: string;
      readonly role: "user" | "assistant";
      readonly content: string;
    }>,
  ): Promise<string> {
    if (entries.length === 0) {
      const today = new Date().toISOString().slice(0, 10);
      return this.getFilePath(today);
    }

    const date = extractDate(entries[0].timestamp);
    const filePath = this.getFilePath(date);

    for (const entry of entries) {
      await this.appendEntry(entry.timestamp, entry.role, entry.content);
    }

    return filePath;
  }

  /** Get the file path for a given date. */
  private getFilePath(date: string): string {
    return join(this.memoryDir, `${date}.md`);
  }
}

/** Extract YYYY-MM-DD from an ISO timestamp. */
function extractDate(timestamp: string): string {
  return timestamp.slice(0, 10);
}

/** Extract HH:MM:SS from an ISO timestamp. */
function extractTime(timestamp: string): string {
  const match = timestamp.match(/(\d{2}:\d{2}:\d{2})/);
  return match ? match[1] : "00:00:00";
}
