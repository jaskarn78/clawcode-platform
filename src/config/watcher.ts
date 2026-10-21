/**
 * Config file watcher with debounced reload.
 *
 * Watches clawcode.yaml for changes using chokidar, debounces rapid edits,
 * validates the new config, computes a field-level diff, records to the
 * audit trail, and notifies the onChange callback with the diff and
 * resolved agents.
 */

import { watch, type FSWatcher } from "chokidar";
import type pino from "pino";
import { loadConfig, resolveAllAgents, type OpRefResolver } from "./loader.js";
import { diffConfigs } from "./differ.js";
import { AuditTrail } from "./audit-trail.js";
import type { ConfigDiff } from "./types.js";
import type { Config } from "./schema.js";
import type { ResolvedAgentConfig } from "../shared/types.js";

export type ConfigWatcherOptions = {
  readonly configPath: string;
  readonly auditTrailPath: string;
  /**
   * Notification fires AFTER the watcher's internal `currentConfig` is
   * updated to `newConfig`. The daemon updates its own `let config` ref
   * from `newConfig` so consumers reading `config.defaults.<dial>` from
   * inside long-lived closures (e.g. the 60s reaper tick in
   * `daemon.ts:onTickAfter`) pick up yaml edits without a daemon
   * restart. The bug this signature change fixes:
   * `const config = await loadConfig(...)` in daemon.ts captured a
   * boot-time snapshot; the reaper closures read `config.defaults`
   * forever, so yaml hot-reload of `subagentReaper` /
   * `orphanClaudeReaper` was effectively a no-op until restart.
   */
  readonly onChange: (
    diff: ConfigDiff,
    resolvedAgents: ResolvedAgentConfig[],
    newConfig: Config,
  ) => Promise<void>;
  readonly log: pino.Logger;
  /** Debounce interval in milliseconds. Defaults to 500. */
  readonly debounceMs?: number;
  /**
   * Optional 1Password `op://` resolver threaded into `resolveAllAgents`
   * on reload. Daemon boot MUST pass `defaultOpRefResolver` so that any
   * newly-added mcpServers env with `op://` refs get substituted before
   * the reloaded agents reach the spawn layer. Tests omit it.
   */
  readonly opRefResolver?: OpRefResolver;
};

export class ConfigWatcher {
  private readonly configPath: string;
  private readonly onChange: ConfigWatcherOptions["onChange"];
  private readonly log: pino.Logger;
  private readonly debounceMs: number;
  private readonly auditTrail: AuditTrail;
  private readonly opRefResolver: OpRefResolver | undefined;

  private currentConfig: Config | undefined;
  private watcher: FSWatcher | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(opts: ConfigWatcherOptions) {
    this.configPath = opts.configPath;
    this.onChange = opts.onChange;
    this.log = opts.log;
    this.debounceMs = opts.debounceMs ?? 500;
    this.opRefResolver = opts.opRefResolver;
    this.auditTrail = new AuditTrail({
      filePath: opts.auditTrailPath,
      log: opts.log,
    });
  }

  /**
   * Load initial config and start watching for changes.
   */
  async start(): Promise<void> {
    this.currentConfig = await loadConfig(this.configPath);
    this.log.info({ path: this.configPath }, "Config watcher started");

    this.watcher = watch(this.configPath, {
      persistent: true,
      ignoreInitial: true,
    });

    this.watcher.on("change", () => {
      this.scheduleReload();
    });
  }

  /**
   * Stop watching for changes.
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
    this.log.info("Config watcher stopped");
  }

  /**
   * Get the current validated config.
   * Throws if start() has not been called.
   */
  getCurrentConfig(): Config {
    if (this.currentConfig === undefined) {
      throw new Error("ConfigWatcher not started — call start() first");
    }
    return this.currentConfig;
  }

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
  }

  /**
   * Reload the config file, diff against current, and notify if changed.
   */
  private async reload(): Promise<void> {
    let newConfig: Config;

    try {
      newConfig = await loadConfig(this.configPath);
    } catch (err) {
      this.log.error(
        { err, path: this.configPath },
        "Config reload failed — keeping previous config",
      );
      return;
    }

    if (this.currentConfig === undefined) return;

    const diff = diffConfigs(this.currentConfig, newConfig);

    if (diff.changes.length === 0) {
      this.log.debug("Config reloaded but no changes detected");
      return;
    }

    // Warn about non-reloadable changes
    for (const change of diff.changes) {
      if (!change.reloadable) {
        this.log.warn(
          { fieldPath: change.fieldPath, oldValue: change.oldValue, newValue: change.newValue },
          `Config field '${change.fieldPath}' changed but requires daemon restart to take effect`,
        );
      }
    }

    // Record to audit trail
    await this.auditTrail.record(diff.changes);

    // Update stored config
    const previousConfig = this.currentConfig;
    this.currentConfig = newConfig;

    // Resolve agents and notify — pass through the configured op:// resolver
    // so hot-reloads that touch mcpServers env get their secrets resolved
    // before the spawn layer sees them. Matches the boot path in daemon.ts.
    // Graceful degradation: a bad op:// ref disables just that one MCP for
    // the affected agent and logs the reason; the reload continues so other
    // unrelated config changes still take effect.
    const resolvedAgents = resolveAllAgents(
      newConfig,
      this.opRefResolver,
      (info) => {
        this.log.error(
          { agent: info.agent, server: info.server, reason: info.message },
          // Covers MCP-server env AND voice keys (server:"voice") — INC-2026-06-04 WS-A9.
          "secret resolution failed on reload — feature disabled for agent (MCP server or voice)",
        );
      },
    );

    try {
      await this.onChange(diff, resolvedAgents, newConfig);
    } catch (err) {
      this.log.error({ err }, "onChange callback failed");
    }
  }
}
