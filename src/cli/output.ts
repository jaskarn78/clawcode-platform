/**
 * CLI output helpers. Replaces direct console.log/console.error calls
 * in CLI commands with explicit stdout/stderr writes.
 */

/** Write a line to stdout (user-facing output). */
export function cliLog(message: string): void {
  process.stdout.write(message + "\n");
}

/** Write a line to stderr (error output). */
export function cliError(message: string): void {
  process.stderr.write(message + "\n");
}

/**
 * ANSI color helpers — hand-rolled to avoid chalk/picocolors dep.
 * Respects NO_COLOR env var and falls back to plain text when stdout isn't a TTY.
 */
const ANSI_RESET = "\x1b[0m";
const ANSI_GREEN = "\x1b[32m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_RED = "\x1b[31m";
const ANSI_DIM = "\x1b[2m";

export function colorEnabled(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "0") return true;
  return process.stdout.isTTY === true;
}

function wrap(open: string, text: string): string {
  return colorEnabled() ? open + text + ANSI_RESET : text;
}

export function green(text: string): string { return wrap(ANSI_GREEN, text); }
export function yellow(text: string): string { return wrap(ANSI_YELLOW, text); }
export function red(text: string): string { return wrap(ANSI_RED, text); }
export function dim(text: string): string { return wrap(ANSI_DIM, text); }
