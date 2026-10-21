/**
 * Phase 116-03 F26 — agent-block patcher for clawcode.yaml.
 *
 * Mutates one `agents[i]` block in place via the yaml Document AST, preserving
 * comments + key order on every node the patch DIDN'T touch. Mirrors the
 * atomic temp+rename pattern from `src/migration/yaml-writer.ts` so chokidar
 * watchers see exactly one change event.
 *
 * Contract:
 *   - outcome: "updated"      — agent matched, fields merged, file rewritten
 *   - outcome: "no-op"        — agent matched but every field already matches
 *     the requested value (file bytes unchanged, no rename fires)
 *   - outcome: "not-found"    — agent name absent from the `agents:` seq
 *   - outcome: "file-not-found" — clawcode.yaml does not exist at the path
 *
 * The handler classifies each changed field path via
 * `src/config/types.ts:RELOADABLE_FIELDS` so the caller can report what will
 * hot-reload vs. what requires `clawcode restart <agent>`.
 *
 * DO NOT:
 *   - Use writeFile to the dest directly — chokidar race + half-written state.
 *   - Reorder keys on the agent map — operator's column order is load-bearing.
 *
 * Validation contract (quick 260715-j1j review CR-02): the caller (daemon
 * IPC) Zod-validates the PARTIAL before invoking this writer, and this
 * writer additionally runs the FULL `configSchema.safeParse` on the patched
 * document BEFORE writing anything to disk (no tmp-file leak — the check
 * precedes the write). This protects every cross-field invariant on
 * `configSchema.superRefine` (e.g. D7: `effort: ultracode` requires
 * `nativeWorkflow: true`) that a per-agent partial parse cannot see — a
 * field-valid patch that yields a config `loadConfig` would REJECT must fail
 * HERE, loudly, instead of writing a YAML that breaks the next daemon boot.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { parseDocument, YAMLSeq, YAMLMap, isMap } from "yaml";
import { RELOADABLE_FIELDS } from "./types.js";
import { configSchema } from "./schema.js";
import { ConfigValidationError } from "../shared/errors.js";

/** Mutable fs-dispatch holder for test interception (mirrors yaml-writer). */
export const patcherFs: {
  readFile: typeof readFile;
  writeFile: typeof writeFile;
  rename: typeof rename;
  unlink: typeof unlink;
} = { readFile, writeFile, rename, unlink };

export type PatchAgentInYamlArgs = Readonly<{
  existingConfigPath: string;
  agentName: string;
  /** Partial agent block — only listed keys are merged. Top-level only. */
  partial: Readonly<Record<string, unknown>>;
  /** DI for test determinism — defaults to process.pid. */
  pid?: number;
}>;

export type PatchAgentInYamlResult =
  | {
      readonly outcome: "updated";
      readonly destPath: string;
      readonly targetSha256: string;
      /** Field paths that changed AND are classified hot-reloadable. */
      readonly hotReloadedFields: readonly string[];
      /** Field paths that changed AND require an agent restart. */
      readonly restartRequiredFields: readonly string[];
    }
  | {
      readonly outcome: "no-op";
      readonly destPath: string;
      readonly reason: string;
    }
  | { readonly outcome: "not-found"; readonly reason: string }
  | { readonly outcome: "file-not-found"; readonly reason: string }
  /**
   * Quick 260715-j1j review CR-02 — the patched document fails the FULL
   * `configSchema` parse (cross-field superRefine invariants included).
   * NOTHING was written to disk; `reason` carries the zod issue list for
   * the caller to surface (dashboard toast / IPC error envelope).
   */
  | { readonly outcome: "invalid"; readonly reason: string };

/**
 * Classify a field path against the daemon's RELOADABLE_FIELDS set.
 *
 * Mirrors `src/config/differ.ts:classifyField` but operates on agent-scoped
 * paths (`agents.<name>.<field>`) — we expand the same wildcard match
 * (`agents.*.<field>`) the differ uses so a write classification is
 * identical to what the reload path would compute on the chokidar tick.
 */
function isFieldReloadable(fieldPath: string): boolean {
  const pathParts = fieldPath.split(".");
  for (const pattern of RELOADABLE_FIELDS) {
    const patternParts = pattern.split(".");
    if (pathParts.length < patternParts.length) continue;
    let ok = true;
    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i] === "*") continue;
      if (patternParts[i] !== pathParts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

export async function patchAgentInYaml(
  args: PatchAgentInYamlArgs,
): Promise<PatchAgentInYamlResult> {
  const pid = args.pid ?? process.pid;

  if (!existsSync(args.existingConfigPath)) {
    return {
      outcome: "file-not-found",
      reason: `clawcode.yaml not found at ${args.existingConfigPath}`,
    };
  }

  const existingText = await patcherFs.readFile(
    args.existingConfigPath,
    "utf8",
  );
  const doc = parseDocument(existingText, { prettyErrors: true });
  const contents = doc.contents;
  if (!(contents instanceof YAMLMap)) {
    throw new Error(
      `clawcode.yaml top-level is not a map: ${args.existingConfigPath}`,
    );
  }
  const rootMap = contents as unknown as YAMLMap<unknown, unknown>;
  const agentsSeq = rootMap.get("agents") as unknown;
  if (!(agentsSeq instanceof YAMLSeq)) {
    return {
      outcome: "not-found",
      reason: `no agents: seq in ${args.existingConfigPath}`,
    };
  }

  // Find the target agent block by name.
  let target: YAMLMap | null = null;
  for (const item of agentsSeq.items) {
    if (!isMap(item)) continue;
    const nameNode = (item as YAMLMap).get("name");
    if (typeof nameNode === "string" && nameNode === args.agentName) {
      target = item as YAMLMap;
      break;
    }
  }

  if (target === null) {
    return {
      outcome: "not-found",
      reason: `agent '${args.agentName}' not in agents: seq`,
    };
  }

  // Apply patch — mutate in place, recording which fields actually changed.
  // We compare via JSON-serialized form so deep arrays / objects detect drift.
  const changedFields: string[] = [];
  const agentMap = target as unknown as YAMLMap<unknown, unknown>;
  for (const [key, newValue] of Object.entries(args.partial)) {
    const currentNode = agentMap.get(key);
    const currentJson =
      currentNode === undefined ? undefined : doc.createNode(currentNode).toJSON();
    const newJson = newValue;
    if (JSON.stringify(currentJson) === JSON.stringify(newJson)) {
      continue;
    }
    // `set` REPLACES the value, preserving the key + its comment. For nested
    // structures (channels[], mcpServers[]) we round-trip via createNode so
    // the YAML serializer emits the same flow style as a fresh insert.
    agentMap.set(key, doc.createNode(newValue));
    changedFields.push(key);
  }

  if (changedFields.length === 0) {
    return {
      outcome: "no-op",
      destPath: args.existingConfigPath,
      reason: "all fields already match requested values",
    };
  }

  // Quick 260715-j1j review CR-02 — validate the FULL patched document
  // against configSchema BEFORE writing anything. A per-agent partial parse
  // (the daemon's pre-check) cannot see cross-field superRefine invariants
  // (D7 ultracode↔nativeWorkflow pairing, memoryPath conflicts, delegate
  // targets, …); without this check a field-valid patch could write a YAML
  // that the chokidar reload rejects AND the next daemon boot fails on
  // (loadConfig throws → whole fleet down). Runs pre-write, so a rejection
  // leaks no tmp file and leaves the on-disk YAML byte-identical.
  const patchedJson: unknown = doc.toJSON();
  const validation = configSchema.safeParse(patchedJson);
  if (!validation.success) {
    const issues = new ConfigValidationError(validation.error, patchedJson)
      .issues;
    return {
      outcome: "invalid",
      reason: `patched config fails full-config validation (nothing written): ${issues.join("; ")}`,
    };
  }

  // Serialize + atomic write.
  const newText = doc.toString({ lineWidth: 0 });
  const destDir = dirname(args.existingConfigPath);
  const tmpPath = join(destDir, `.clawcode.yaml.${pid}.${Date.now()}.tmp`);
  await patcherFs.writeFile(tmpPath, newText, "utf8");
  try {
    await patcherFs.rename(tmpPath, args.existingConfigPath);
  } catch (err) {
    try {
      await patcherFs.unlink(tmpPath);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }

  // Classify what hot-reloads vs. what needs restart.
  const hotReloadedFields: string[] = [];
  const restartRequiredFields: string[] = [];
  for (const field of changedFields) {
    const path = `agents.*.${field}`;
    if (isFieldReloadable(path)) {
      hotReloadedFields.push(field);
    } else {
      restartRequiredFields.push(field);
    }
  }

  const targetSha256 = createHash("sha256")
    .update(newText, "utf8")
    .digest("hex");

  return {
    outcome: "updated",
    destPath: args.existingConfigPath,
    targetSha256,
    hotReloadedFields,
    restartRequiredFields,
  };
}
