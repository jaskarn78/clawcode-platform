/**
 * Bootstrap status for an agent's first-run detection.
 *
 * - "needed": Agent requires bootstrap walkthrough (no flag file, default/missing SOUL.md)
 * - "complete": Agent has already been bootstrapped (flag file exists or SOUL.md customized)
 * - "skipped": Agent has config-provided soul (bootstrap not applicable)
 */
export type BootstrapStatus = "needed" | "complete" | "skipped";

/**
 * Result produced by the bootstrap walkthrough.
 * Contains the generated identity files to be written to the agent workspace.
 */
export type BootstrapResult = {
  readonly soulContent: string;
  readonly identityContent: string;
  readonly agentName: string;
};

/**
 * Minimal configuration needed for bootstrap detection and prompt generation.
 */
export type BootstrapConfig = {
  readonly workspace: string;
  readonly agentName: string;
  readonly channels: readonly string[];
};

/**
 * Flag file written to workspace after successful bootstrap.
 * Presence of this file prevents re-triggering on subsequent starts.
 */
export const BOOTSTRAP_FLAG_FILE = ".bootstrap-complete";
