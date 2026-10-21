/**
 * Phase 999.14 — MCP-10 GREEN: confirmPrompt helper.
 *
 * Tiny readline-based yes/no prompt for destructive CLI subcommands.
 * Extracted into its own module so tests can vi.mock("../../prompts.js")
 * cleanly without wrestling with raw stdin.
 */

import { createInterface } from "node:readline";

/**
 * Prompt the operator with a yes/no question. Returns true on "y"/"yes"
 * (case-insensitive), false otherwise. The readline interface is closed
 * before the promise resolves so no listeners leak.
 */
export async function confirmPrompt(message: string): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await new Promise<string>((resolve) =>
      rl.question(`${message} `, resolve),
    );
    return answer.trim().toLowerCase().startsWith("y");
  } finally {
    rl.close();
  }
}
