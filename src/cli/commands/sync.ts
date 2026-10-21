/**
 * Phase 91 Plan 04 + Phase 96 Plan 06 — `clawcode sync` top-level command group.
 *
 * Registers the operator-facing subcommands that drive the OpenClaw ↔ ClawCode
 * fin-client workspace sync system (Plans 91-01 / 91-02 / 91-03) plus
 * Phase 96 D-11 mirror-deprecation surface (Plan 96-06):
 *
 *   clawcode sync status              — pretty-print sync-state.json + last cycle
 *   clawcode sync run-once            — synchronous one-shot syncOnce() invocation
 *                                       (exits 2 when authoritativeSide=deprecated)
 *   clawcode sync resolve <path>      — operator conflict resolution (D-14)
 *   clawcode sync set-authoritative   — direction flip (D-17 / D-19)
 *                                       (refuses deprecated → clawcode forward-cutover)
 *   clawcode sync start --reverse     — opt-in ClawCode→OpenClaw (D-18)
 *   clawcode sync stop                — halt reverse sync
 *   clawcode sync finalize            — Day-7 cleanup prompt (D-20)
 *   clawcode sync translate-sessions  — hourly translator entry point (91-03)
 *   clawcode sync disable-timer       — Phase 96 D-11 — deprecate Phase 91 mirror
 *   clawcode sync re-enable-timer     — Phase 96 D-11 — restore within 7-day window
 *
 * Mirrors the Phase 90 memory-backfill.ts DI pattern: each subcommand exports
 * its action as a pure async function (`run*Action`) that returns the process
 * exit code. The thin `register*Command` wrappers are the only place that
 * touches `process.exit`, keeping the action functions hermetic for tests.
 */
import type { Command } from "commander";
import { registerSyncStatusCommand } from "./sync-status.js";
import { registerSyncRunOnceCommand } from "./sync-run-once.js";
import { registerSyncResolveCommand } from "./sync-resolve.js";
import { registerSyncSetAuthoritativeCommand } from "./sync-set-authoritative.js";
import { registerSyncReverseCommand } from "./sync-reverse.js";
import { registerSyncFinalizeCommand } from "./sync-finalize.js";
import { registerSyncTranslateSessionsCommand } from "./sync-translate-sessions.js";
import { registerSyncDisableTimerCommand } from "./sync-disable-timer.js";
import { registerSyncReEnableTimerCommand } from "./sync-re-enable-timer.js";

/**
 * Attach the `sync` command group (and all its subcommands) to `parent`.
 *
 * Called from src/cli/index.ts alongside the other `register*Command`
 * functions. No side effects beyond command registration — safe to call
 * from tests via `const c = new Command(); registerSyncCommand(c);` and
 * then inspect `c.commands` to verify wiring.
 */
export function registerSyncCommand(parent: Command): void {
  const sync = parent
    .command("sync")
    .description(
      "OpenClaw ↔ ClawCode fin-client workspace sync — status, resolve, cutover, deprecation",
    );

  // status / run-once / translate-sessions — read-only + single-cycle shapes
  registerSyncStatusCommand(sync);
  registerSyncRunOnceCommand(sync);
  registerSyncTranslateSessionsCommand(sync);

  // resolve / set-authoritative / reverse / finalize — mutating operator ops
  registerSyncResolveCommand(sync);
  registerSyncSetAuthoritativeCommand(sync);
  registerSyncReverseCommand(sync);
  registerSyncFinalizeCommand(sync);

  // Phase 96 D-11 — Phase 91 mirror deprecation surface
  //
  // Subcommand routing (full implementations in sibling files):
  //   - disable-timer: idempotent flip to authoritativeSide=deprecated;
  //     invokes `systemctl --user disable clawcode-sync-acme.timer`
  //     (graceful when unit absent — RESEARCH.md Pitfall 6)
  //   - re-enable-timer: rollback within 7-day window
  //     (DEPRECATION_ROLLBACK_WINDOW_MS); invokes
  //     `systemctl --user enable --now clawcode-sync-acme.timer`
  //   - run-once when deprecated → process.exit(2) (real refusal,
  //     NOT graceful skip; bypasses systemd's SuccessExitStatus=1)
  //   - set-authoritative refuses "cannot forward-cutover from deprecated"
  //     state-machine guard (operator must re-enable-timer or fresh setup first)
  registerSyncDisableTimerCommand(sync);
  registerSyncReEnableTimerCommand(sync);
}
