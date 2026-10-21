/**
 * JSONL approval audit log writer and allow-always persistence.
 *
 * Records every approval decision as a single JSON line in an
 * append-only file. Supports loading previously persisted allow-always
 * patterns per agent.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type pino from "pino";
import type { ApprovalAuditEntry } from "./types.js";

export type ApprovalLogOptions = {
  readonly filePath: string;
  readonly log: pino.Logger;
};

export class ApprovalLog {
  private readonly filePath: string;
  private readonly log: pino.Logger;
  private dirEnsured = false;

  constructor(opts: ApprovalLogOptions) {
    this.filePath = opts.filePath;
    this.log = opts.log;
  }

  /**
   * Record an approval decision to the JSONL audit file.
   */
  async record(entry: ApprovalAuditEntry): Promise<void> {
    await this.ensureDirectory();
    const line = JSON.stringify(entry) + "\n";
    await appendFile(this.filePath, line, "utf-8");
    this.log.info(
      { agent: entry.agentName, command: entry.command, decision: entry.decision },
      "Recorded approval decision",
    );
  }

  /**
   * Load all allow-always patterns for a specific agent from the log.
   * Reads the full JSONL file and filters for allow-always entries
   * matching the given agent name. Returns the command patterns.
   */
  loadAllowAlways(agentName: string): string[] {
    let content: string;
    try {
      // Synchronous read not available with fs/promises, use sync
      const { readFileSync } = require("node:fs");
      content = readFileSync(this.filePath, "utf-8") as string;
    } catch {
      return [];
    }

    const patterns: string[] = [];
    const lines = content.split("\n").filter((line) => line.trim().length > 0);

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as ApprovalAuditEntry;
        if (
          entry.decision === "allow-always" &&
          entry.agentName === agentName
        ) {
          patterns.push(entry.command);
        }
      } catch {
        // Skip malformed lines
      }
    }

    return patterns;
  }

  /**
   * Record an allow-always decision for an agent with a specific pattern.
   * The pattern is stored in the command field for retrieval by loadAllowAlways.
   */
  async recordAllowAlways(
    agentName: string,
    pattern: string,
    approvedBy: string,
  ): Promise<void> {
    const entry: ApprovalAuditEntry = {
      timestamp: new Date().toISOString(),
      agentName,
      command: pattern,
      decision: "allow-always",
      approvedBy,
    };
    await this.record(entry);
  }

  /**
   * Ensure the parent directory exists, creating it recursively if needed.
   * Only checks once per ApprovalLog instance.
   */
  private async ensureDirectory(): Promise<void> {
    if (this.dirEnsured) return;
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    this.dirEnsured = true;
  }
}
