/**
 * Phase 62 Plan 02 — chokidar-based hot-reload watcher for policies.yaml.
 *
 * Watches .clawcode/policies.yaml for changes via chokidar, re-parses +
 * validates + compiles, swaps the PolicyEvaluator atomically via onReload
 * callback, and logs every reload attempt to a JSONL audit trail.
 *
 * Boot behavior: start() reads and validates the policy file. If the file
 * is invalid, throws PolicyValidationError (daemon must refuse to start
 * per POL-01). If the file doesn't exist, starts with empty rules.
 *
 * Hot-reload behavior: invalid edits keep the old evaluator and call onError.
 * Debounce prevents rapid file saves from causing multiple reloads.
 *
 * Follows the ConfigWatcher pattern from src/config/watcher.ts.
 */

import { readFile } from "node:fs/promises";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { watch, type FSWatcher } from "chokidar";
import type pino from "pino";

import { loadPolicies, PolicyValidationError } from "./policy-loader.js";
import type { CompiledRule } from "./policy-loader.js";
import { PolicyEvaluator } from "./policy-evaluator.js";
import { diffPolicies } from "./policy-differ.js";
import type { PolicyDiff } from "./policy-differ.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PolicyWatcherOptions = {
  readonly policyPath: string;
  readonly auditPath: string;
  readonly onReload: (evaluator: PolicyEvaluator, diff: PolicyDiff) => void;
  readonly onError?: (error: Error) => void;
  readonly log: pino.Logger;
  readonly debounceMs?: number;
  readonly configuredAgents?: ReadonlySet<string>;
};

/**
 * Shape of each line in the JSONL audit trail.
 */
export type PolicyAuditEntry = {
  readonly timestamp: string;
  readonly action: "reload" | "boot";
  readonly diff: PolicyDiff | null;
  readonly status: "success" | "error";
  readonly error?: string;
};

// ---------------------------------------------------------------------------
// PolicyWatcher
// ---------------------------------------------------------------------------

export class PolicyWatcher {
  private readonly policyPath: string;
  private readonly auditPath: string;
  private readonly onReload: PolicyWatcherOptions["onReload"];
  private readonly onError: PolicyWatcherOptions["onError"];
  private readonly log: pino.Logger;
  private readonly debounceMs: number;
  private readonly configuredAgents: ReadonlySet<string>;

  private currentRules: readonly CompiledRule[] = [];
  private currentEvaluator: PolicyEvaluator | undefined;
  private watcher: FSWatcher | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private auditDirEnsured = false;

  constructor(opts: PolicyWatcherOptions) {
    this.policyPath = opts.policyPath;
    this.auditPath = opts.auditPath;
    this.onReload = opts.onReload;
    this.onError = opts.onError;
    this.log = opts.log;
    this.debounceMs = opts.debounceMs ?? 500;
    this.configuredAgents = opts.configuredAgents ?? new Set();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Load initial policy and start watching for changes.
   *
   * @returns The initial PolicyEvaluator.
   * @throws PolicyValidationError if policies.yaml exists but is invalid
   *   (boot rejection per POL-01).
   */
  async start(): Promise<PolicyEvaluator> {
    let content: string | null = null;

    try {
      content = await readFile(this.policyPath, "utf-8");
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.log.info(
          { path: this.policyPath },
          "no policies.yaml found — starting with empty rules",
        );
      } else {
        throw err;
      }
    }

    let rules: readonly CompiledRule[];
    if (content !== null) {
      try {
        rules = loadPolicies(content);
      } catch (err) {
        if (err instanceof PolicyValidationError) {
          throw new PolicyValidationError(
            `FATAL: policies.yaml invalid -- daemon cannot start: ${err.message}`,
            err.issues,
          );
        }
        throw err;
      }
    } else {
      rules = [];
    }

    this.currentRules = rules;
    this.currentEvaluator = new PolicyEvaluator(rules, this.configuredAgents);

    // Write boot audit entry
    await this.writeAuditEntry({
      timestamp: new Date().toISOString(),
      action: "boot",
      diff: null,
      status: "success",
    });

    this.log.info(
      { path: this.policyPath, ruleCount: rules.length },
      "policy watcher started",
    );

    // Start chokidar watcher
    this.watcher = watch(this.policyPath, {
      persistent: true,
      ignoreInitial: true,
    });

    this.watcher.on("change", () => {
      this.scheduleReload();
    });

    return this.currentEvaluator;
  }

  /**
   * Stop watching for changes and clear the debounce timer.
   */
  async stop(): Promise<void> {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.watcher !== undefined) {
      await this.watcher.close();
      this.watcher = undefined;
    }
    this.log.info("policy watcher stopped");
  }

  /**
   * Get the current PolicyEvaluator.
   * Throws if start() has not been called.
   */
  getCurrentEvaluator(): PolicyEvaluator {
    if (this.currentEvaluator === undefined) {
      throw new Error("PolicyWatcher not started — call start() first");
    }
    return this.currentEvaluator;
  }

  // -------------------------------------------------------------------------
  // Internal — debounce + reload
  // -------------------------------------------------------------------------

  /**
   * Schedule a debounced reload. Resets the timer on each call.
   */
  private scheduleReload(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.reload();
    }, this.debounceMs);
    // Unref so the timer doesn't keep the process alive
    this.debounceTimer.unref();
  }

  /**
   * Reload the policy file, validate, diff, and swap evaluator atomically.
   */
  private async reload(): Promise<void> {
    let content: string;
    try {
      content = await readFile(this.policyPath, "utf-8");
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.log.warn(
        { err: error, path: this.policyPath },
        "policies.yaml reload failed -- keeping previous policy: " + error.message,
      );
      await this.writeAuditEntry({
        timestamp: new Date().toISOString(),
        action: "reload",
        diff: null,
        status: "error",
        error: error.message,
      });
      this.onError?.(error);
      return;
    }

    let newRules: readonly CompiledRule[];
    try {
      newRules = loadPolicies(content);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.log.warn(
        { err: error, path: this.policyPath },
        "policies.yaml reload failed -- keeping previous policy: " + error.message,
      );
      await this.writeAuditEntry({
        timestamp: new Date().toISOString(),
        action: "reload",
        diff: null,
        status: "error",
        error: error.message,
      });
      this.onError?.(error);
      return;
    }

    // Compute diff
    const diff = diffPolicies(this.currentRules, newRules);

    // Create new evaluator atomically
    const newEvaluator = new PolicyEvaluator(newRules, this.configuredAgents);

    // Swap state
    const oldRules = this.currentRules;
    this.currentRules = newRules;
    this.currentEvaluator = newEvaluator;

    // Write success audit entry
    await this.writeAuditEntry({
      timestamp: new Date().toISOString(),
      action: "reload",
      diff,
      status: "success",
    });

    this.log.info(
      {
        added: diff.added.length,
        removed: diff.removed.length,
        modified: diff.modified.length,
      },
      "policies.yaml reloaded successfully",
    );

    // Notify callback
    try {
      this.onReload(newEvaluator, diff);
    } catch (err) {
      this.log.error({ err }, "onReload callback failed");
    }
  }

  // -------------------------------------------------------------------------
  // Internal — JSONL audit trail
  // -------------------------------------------------------------------------

  /**
   * Append a single JSON line to the audit trail file.
   * Creates parent directory on first write.
   */
  private async writeAuditEntry(entry: PolicyAuditEntry): Promise<void> {
    await this.ensureAuditDirectory();
    const line = JSON.stringify(entry) + "\n";
    await appendFile(this.auditPath, line, "utf-8");
  }

  /**
   * Ensure the audit trail parent directory exists.
   * Only checks once per PolicyWatcher instance.
   */
  private async ensureAuditDirectory(): Promise<void> {
    if (this.auditDirEnsured) return;
    const dir = dirname(this.auditPath);
    await mkdir(dir, { recursive: true });
    this.auditDirEnsured = true;
  }
}
