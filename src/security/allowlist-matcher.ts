/**
 * Pattern-based command matching against allowlists.
 *
 * Supports glob-style patterns where * matches any sequence of characters.
 * Used by the execution approval system to check commands before running.
 */

import type { CommandCheckResult } from "./types.js";

/**
 * Convert a glob pattern (with * wildcards) to a RegExp.
 * Escapes all regex special characters except *, which becomes .*.
 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const regexStr = "^" + escaped.replace(/\*/g, ".*") + "$";
  return new RegExp(regexStr);
}

/**
 * Check a command string against a list of glob patterns.
 * Returns { allowed: true, matchedPattern } if any pattern matches,
 * or { allowed: false } if none match.
 *
 * An empty patterns array denies all commands.
 */
export function matchCommand(
  command: string,
  patterns: readonly string[],
): CommandCheckResult {
  for (const pattern of patterns) {
    const regex = globToRegExp(pattern);
    if (regex.test(command)) {
      return { allowed: true, matchedPattern: pattern };
    }
  }
  return { allowed: false };
}

/**
 * Stateful allowlist matcher that combines static patterns
 * with dynamically added allow-always patterns.
 */
export class AllowlistMatcher {
  private readonly staticPatterns: readonly string[];
  private readonly allowAlwaysPatterns: string[] = [];

  constructor(staticPatterns: readonly string[]) {
    this.staticPatterns = staticPatterns;
  }

  /**
   * Check a command against both static and allow-always patterns.
   */
  check(command: string): CommandCheckResult {
    const allPatterns = [...this.staticPatterns, ...this.allowAlwaysPatterns];
    return matchCommand(command, allPatterns);
  }

  /**
   * Add a pattern to the allow-always list (runtime persistence).
   */
  addAllowAlways(pattern: string): void {
    this.allowAlwaysPatterns.push(pattern);
  }

  /**
   * Return current allow-always patterns.
   */
  getAllowAlwaysPatterns(): readonly string[] {
    return [...this.allowAlwaysPatterns];
  }
}
