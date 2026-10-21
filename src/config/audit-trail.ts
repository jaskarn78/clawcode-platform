/**
 * JSONL audit trail writer for config changes.
 *
 * Records every config field change as a single JSON line in an
 * append-only file. Creates the parent directory on first write.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type pino from "pino";
import type { ConfigChange, AuditEntry } from "./types.js";

export type AuditTrailOptions = {
  readonly filePath: string;
  readonly log: pino.Logger;
};

export class AuditTrail {
  private readonly filePath: string;
  private readonly log: pino.Logger;
  private dirEnsured = false;

  constructor(opts: AuditTrailOptions) {
    this.filePath = opts.filePath;
    this.log = opts.log;
  }

  /**
   * Record config changes to the JSONL audit file.
   * Each change becomes one line: { timestamp, fieldPath, oldValue, newValue }
   */
  async record(changes: readonly ConfigChange[]): Promise<void> {
    if (changes.length === 0) return;

    await this.ensureDirectory();

    const timestamp = new Date().toISOString();
    const lines = changes.map((change) => {
      const entry: AuditEntry = {
        timestamp,
        fieldPath: change.fieldPath,
        oldValue: change.oldValue,
        newValue: change.newValue,
      };
      return JSON.stringify(entry);
    });

    await appendFile(this.filePath, lines.join("\n") + "\n", "utf-8");

    this.log.info(
      { count: changes.length, file: this.filePath },
      "Recorded config changes to audit trail",
    );
  }

  /**
   * Ensure the parent directory exists, creating it recursively if needed.
   * Only checks once per AuditTrail instance.
   */
  private async ensureDirectory(): Promise<void> {
    if (this.dirEnsured) return;
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    this.dirEnsured = true;
  }
}
