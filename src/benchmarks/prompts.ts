/**
 * Bench prompt-set loader (Plan 51-02).
 *
 * `loadPrompts` is the ONLY entry point through which the bench YAML prompt
 * set enters the system. The file schema is:
 *
 *   prompts:
 *     - id: "no-tool-short-reply"
 *       prompt: "Say hi."
 *       description: "Baseline — no tool calls, short reply."
 *     - id: "single-tool-call"
 *       prompt: "Look up my favorite color."
 *
 * Every read/parse/validation failure throws `BenchmarkConfigError` (with
 * the offending path) so operators can locate the broken artifact. Returns
 * a frozen `readonly PromptDefinition[]`.
 *
 * SECURITY: prompt strings eventually become real LLM messages against
 * Anthropic OAuth. We don't execute prompt content; we only schema-validate
 * shape. Empty `id` or empty `prompt` are rejected at parse time.
 */

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod/v4";

import { BenchmarkConfigError } from "./types.js";

/**
 * A single prompt definition. `description` is optional (human-readable
 * label for the pretty printer); `id` and `prompt` are required.
 */
const promptDefinitionSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  description: z.string().optional(),
});

/**
 * Top-level file shape. A bench run requires AT LEAST one prompt — an
 * empty `prompts: []` is rejected so operators catch the config mistake
 * immediately rather than seeing a silent clean-run.
 */
const promptsFileSchema = z.object({
  prompts: z.array(promptDefinitionSchema).min(1),
});

/** Inferred `PromptDefinition` — one entry in the YAML `prompts:` array. */
export type PromptDefinition = z.infer<typeof promptDefinitionSchema>;

/**
 * Load and validate a bench prompts YAML file. Returns a frozen array of
 * `PromptDefinition`. Always throws `BenchmarkConfigError` (with the path)
 * on read failure, YAML parse failure, or schema violation. If the file
 * lacks a `prompts:` key OR it's empty OR any entry has an empty `id`/
 * `prompt`, throws a `BenchmarkConfigError` with a diagnostic message.
 *
 * @param path - Absolute or relative path to prompts.yaml.
 */
export function loadPrompts(path: string): readonly PromptDefinition[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown read error";
    throw new BenchmarkConfigError(`read failed: ${msg}`, path);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown parse error";
    throw new BenchmarkConfigError(`yaml parse failed: ${msg}`, path);
  }

  const result = promptsFileSchema.safeParse(parsed ?? {});
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new BenchmarkConfigError(`schema invalid: ${issues}`, path);
  }

  return Object.freeze(result.data.prompts.map((p) => Object.freeze(p)));
}
