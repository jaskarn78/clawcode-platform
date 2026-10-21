/**
 * Phase 59 — Task schema registry.
 *
 * Loads all ~/.clawcode/task-schemas/*.yaml at daemon startup, compiles each
 * to Zod v4 via compileJsonSchema, and caches per schema name. Plan 59-02
 * TaskManager pins a CompiledSchema reference at delegate() time so in-flight
 * tasks are immune to hot-reload drift (Pitfall 5).
 *
 * First-boot tolerance: if ~/.clawcode/task-schemas/ does not exist, returns
 * an EMPTY registry without throwing. Agents with no acceptsTasks entries
 * simply get UnauthorizedError responses until operators author schemas.
 * Malformed single files are skipped with warn — they do NOT poison the
 * registry.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import type { ZodTypeAny } from "zod/v4";
import { compileJsonSchema, type JsonSchema } from "./handoff-schema.js";
import { logger } from "../shared/logger.js";

/** Default location — CONTEXT Area 2 locks ~/.clawcode/task-schemas/ as runtime home. */
export const TASK_SCHEMAS_DIR = join(homedir(), ".clawcode", "task-schemas");

export type CompiledSchema = Readonly<{
  readonly name: string;
  readonly input: ZodTypeAny;
  readonly output: ZodTypeAny;
}>;

type RawYamlSchema = {
  name?: unknown;
  description?: unknown;
  input?: unknown;
  output?: unknown;
};

export class SchemaRegistry {
  private readonly cache: ReadonlyMap<string, CompiledSchema>;

  private constructor(cache: Map<string, CompiledSchema>) {
    this.cache = cache;
  }

  static async load(dir: string = TASK_SCHEMAS_DIR): Promise<SchemaRegistry> {
    const log = logger.child({ component: "SchemaRegistry" });
    const cache = new Map<string, CompiledSchema>();

    let entries: string[];
    try {
      const s = await stat(dir);
      if (!s.isDirectory()) {
        log.warn({ dir }, "task-schemas path is not a directory — empty registry");
        return new SchemaRegistry(cache);
      }
      entries = await readdir(dir);
    } catch {
      log.info(
        { dir },
        "task-schemas directory missing — empty registry (first-boot tolerance)",
      );
      return new SchemaRegistry(cache);
    }

    for (const filename of entries) {
      if (!filename.endsWith(".yaml") && !filename.endsWith(".yml")) continue;
      const fullPath = join(dir, filename);
      try {
        const raw = await readFile(fullPath, "utf8");
        const parsed = parseYaml(raw) as RawYamlSchema;
        if (!parsed || typeof parsed.name !== "string" || parsed.name.length === 0) {
          log.warn({ filename }, "schema file missing valid `name` — skipped");
          continue;
        }
        if (!parsed.input || !parsed.output) {
          log.warn(
            { filename, name: parsed.name },
            "schema file missing `input` or `output` — skipped",
          );
          continue;
        }
        const input = compileJsonSchema(parsed.input as JsonSchema);
        const output = compileJsonSchema(parsed.output as JsonSchema);
        cache.set(
          parsed.name,
          Object.freeze({ name: parsed.name, input, output }) as CompiledSchema,
        );
        log.info({ filename, name: parsed.name }, "schema loaded");
      } catch (err) {
        log.warn(
          { filename, err: (err as Error).message },
          "schema file skipped — compile or parse failure",
        );
        // Continue with next file — do not poison the registry.
      }
    }

    log.info({ count: cache.size, dir }, "SchemaRegistry loaded");
    return new SchemaRegistry(cache);
  }

  get(name: string): CompiledSchema | null {
    return this.cache.get(name) ?? null;
  }

  size(): number {
    return this.cache.size;
  }

  names(): readonly string[] {
    return Object.freeze([...this.cache.keys()]);
  }

  /**
   * Test-only factory — builds a SchemaRegistry from pre-compiled entries
   * without touching the filesystem. Plan 59-02 tests use this to avoid
   * mkdtemp + YAML round-trips for every test case.
   */
  static fromEntries(entries: readonly CompiledSchema[]): SchemaRegistry {
    const cache = new Map<string, CompiledSchema>();
    for (const e of entries) cache.set(e.name, e);
    return new SchemaRegistry(cache);
  }
}
