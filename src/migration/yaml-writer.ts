/**
 * Atomic YAML editors for clawcode.yaml. Uses the `yaml` package's Document
 * AST to preserve comments + key ordering across a round-trip.
 *
 * Write pipeline (every editor):
 *   1. parseDocument(existingText) — preserves every comment and key order.
 *   2. Mutate only the targeted node (agent model / skills / mcpServers /
 *      remove-agent).
 *   3. Serialize via doc.toString({ lineWidth: 0 }) — no line wrapping so
 *      long op:// URLs don't get broken mid-string.
 *   4. Atomic write: tmpPath in the same dir, then fs.rename to dest. Rename
 *      is atomic on the same filesystem, so file watchers see exactly one
 *      change event.
 *   5. On failure after the tmp write: unlink tmp before re-throwing.
 *
 * DO NOT:
 *   - Use writeFile on the dest directly — watcher race + half-written state.
 *   - Use rename across filesystems — atomicity lost.
 *   - Reorder top-level keys — operator key order is load-bearing UX.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { parseDocument, YAMLSeq, YAMLMap } from "yaml";
import { modelSchema, mcpServerSchema, agentSchema } from "../config/schema.js";
import { scanLiteralValueForSecret } from "./skills-secret-scan.js";
import { MODEL_ALIASES } from "../shared/model-catalog.js";

/**
 * Mutable fs-dispatch holder — the ESM-safe pattern used by
 * migrateOpenclawHandlers in the CLI layer. Tests monkey-patch properties
 * to intercept writeFile/rename/unlink without vi.spyOn against frozen
 * node:fs/promises exports. Exported for test visibility only; production
 * code must never mutate this.
 */
export const writerFs: {
  readFile: typeof readFile;
  writeFile: typeof writeFile;
  rename: typeof rename;
  unlink: typeof unlink;
} = { readFile, writeFile, rename, unlink };

// ---------------------------------------------------------------------------
// Phase 81 Plan 01 — removeAgentFromConfig.
//
// Mirror-image of writeClawcodeYaml. Removes one agent entry from the
// `agents:` seq (by name), preserves every other node + comment via the
// Document AST, and writes back via the same atomic temp+rename pattern.
//
// Contract:
//   - outcome: "removed" — agent was present and is now gone
//   - outcome: "not-found" — clawcode.yaml exists, file is valid, agent is
//       NOT in the seq; file bytes unchanged; no rename fires
//   - outcome: "file-not-found" — clawcode.yaml does not exist at path;
//       no side effects
//   - throws — rename failure (tmp unlinked, error re-thrown); yaml
//       top-level not a map (structural corruption — operator must fix)
//
// DO NOT:
//   - Re-run the Phase 78 secret scan — we are REMOVING nodes, not inserting
//     new operator-input-ish scalars. Existing nodes were already validated
//     when they landed via writeClawcodeYaml.
//   - Trigger the Phase 78 unmappable-model gate — same rationale.
//   - Reorder surviving agents — splice preserves order.
// ---------------------------------------------------------------------------

export type RemoveAgentFromConfigArgs = Readonly<{
  existingConfigPath: string;
  agentName: string;
  /** DI for test determinism — unused currently but mirrors writer shape. */
  ts?: () => string;
  /** DI for test determinism — defaults to process.pid. */
  pid?: number;
}>;

export type RemoveAgentFromConfigResult =
  | {
      readonly outcome: "removed";
      readonly destPath: string;
      readonly targetSha256: string;
    }
  | { readonly outcome: "not-found"; readonly reason: string }
  | { readonly outcome: "file-not-found"; readonly reason: string };

export async function removeAgentFromConfig(
  args: RemoveAgentFromConfigArgs,
): Promise<RemoveAgentFromConfigResult> {
  const pid = args.pid ?? process.pid;

  if (!existsSync(args.existingConfigPath)) {
    return {
      outcome: "file-not-found",
      reason: `clawcode.yaml not found at ${args.existingConfigPath}`,
    };
  }

  const existingText = await writerFs.readFile(
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
      reason: `no agents seq in clawcode.yaml`,
    };
  }
  // Items is the YAMLSeq's internal ordered array. Splicing is safe because
  // parseDocument returned an owned Document instance — this is the ONLY
  // reference to the seq, so a positional splice removes exactly one agent
  // without aliasing surprises.
  const items = (agentsSeq as YAMLSeq).items as unknown as Array<unknown>;
  const idx = items.findIndex((it) => {
    if (it === null || typeof it !== "object") return false;
    const maybeMap = it as { get?: (k: string) => unknown };
    if (typeof maybeMap.get !== "function") return false;
    const name = maybeMap.get("name");
    return name === args.agentName;
  });
  if (idx < 0) {
    return {
      outcome: "not-found",
      reason: `agent '${args.agentName}' not in agents seq`,
    };
  }
  items.splice(idx, 1);

  const newText = doc.toString({ lineWidth: 0 });

  // Atomic temp+rename — identical pattern to writeClawcodeYaml. Same-dir
  // tmp preserves filesystem atomicity on rename.
  const destDir = dirname(args.existingConfigPath);
  const tmpPath = join(
    destDir,
    `.clawcode.yaml.${pid}.${Date.now()}.tmp`,
  );
  await writerFs.writeFile(tmpPath, newText, "utf8");
  try {
    await writerFs.rename(tmpPath, args.existingConfigPath);
  } catch (err) {
    try {
      await writerFs.unlink(tmpPath);
    } catch {
      // already gone or never created — best-effort cleanup
    }
    throw err;
  }

  const targetSha256 = createHash("sha256")
    .update(newText, "utf8")
    .digest("hex");
  return {
    outcome: "removed",
    destPath: args.existingConfigPath,
    targetSha256,
  };
}

// ---------------------------------------------------------------------------
// Phase 86 Plan 02 MODEL-04 — updateAgentModel.
//
// Rewrites ONE agent's `model:` scalar in-place using the same
// parseDocument → mutate → atomic temp+rename pipeline as
// writeClawcodeYaml / removeAgentFromConfig. The daemon IPC set-model
// handler calls this AFTER the live SDK swap succeeds so the change
// survives a daemon restart.
//
// Contract:
//   outcome: "updated"        — agent found, model changed, file rewritten
//   outcome: "no-op"          — agent found, model already equals newModel, zero writes
//   outcome: "not-found"      — clawcode.yaml valid but agent missing from agents: seq
//   outcome: "file-not-found" — clawcode.yaml does not exist
//   outcome: "refused"        — newModel not in modelSchema enum (defense-in-depth)
//   throws                    — rename failure (tmp unlinked), structural YAML corruption
//
// DO NOT:
//   - Re-run the Phase 78 secret scan — we're rewriting ONE scalar, not
//     inserting new operator-input-ish fields. Secret scan scope stays
//     on net-new agent inserts per yaml-writer.ts policy.
//   - Re-run the unmappable-model gate — newModel is always a valid
//     modelSchema alias by this point (daemon validates; self-guard below
//     via modelSchema.safeParse as defense-in-depth).
//   - Trigger a chokidar reload side-effect — `agents.*.model` is
//     NON_RELOADABLE (types.ts); the live swap is owned by Plan 01's
//     SessionHandle.setModel, persistence is for the next boot only.
// ---------------------------------------------------------------------------

export type UpdateAgentModelArgs = Readonly<{
  existingConfigPath: string;
  agentName: string;
  /** Validated against modelSchema inside; string at boundary for caller ergonomics. */
  newModel: string;
  /** DI for test determinism — defaults to process.pid. */
  pid?: number;
}>;

export type UpdateAgentModelResult =
  | {
      readonly outcome: "updated";
      readonly destPath: string;
      readonly targetSha256: string;
    }
  | { readonly outcome: "no-op"; readonly reason: string }
  | { readonly outcome: "not-found"; readonly reason: string }
  | { readonly outcome: "file-not-found"; readonly reason: string }
  | {
      readonly outcome: "refused";
      readonly reason: string;
      readonly step: "invalid-model";
    };

export async function updateAgentModel(
  args: UpdateAgentModelArgs,
): Promise<UpdateAgentModelResult> {
  const pid = args.pid ?? process.pid;

  // --- Gate: defense-in-depth modelSchema validation ----------------
  // Daemon validates modelParam before calling into here, but a future
  // caller could slip through with an invalid alias. Self-guard keeps
  // the contract honest and the error path typed.
  const parsed = modelSchema.safeParse(args.newModel);
  if (!parsed.success) {
    return {
      outcome: "refused",
      // Phase 999.114 — DERIVED. This literal was two revisions stale (it never
      // gained "fable") — proof that hand-listed model strings drift silently.
      // The GATE itself was always correct: it validates against the shared
      // `modelSchema`, so it already accepted every alias the enum accepted;
      // only the message lied about which ones.
      reason:
        `Invalid model '${args.newModel}'. Must be one of: ` +
        `${[...MODEL_ALIASES].join(", ")} (or <family>@latest)`,
      step: "invalid-model",
    };
  }
  const validatedModel = parsed.data;

  // --- Gate: file presence ------------------------------------------
  if (!existsSync(args.existingConfigPath)) {
    return {
      outcome: "file-not-found",
      reason: `clawcode.yaml not found at ${args.existingConfigPath}`,
    };
  }

  // --- Read + parse (Document AST preserves comments + order) ------
  const existingText = await writerFs.readFile(
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
      reason: `no agents seq in clawcode.yaml`,
    };
  }
  const items = (agentsSeq as YAMLSeq).items as unknown as Array<unknown>;
  const idx = items.findIndex((it) => {
    if (it === null || typeof it !== "object") return false;
    const maybeMap = it as { get?: (k: string) => unknown };
    if (typeof maybeMap.get !== "function") return false;
    const name = maybeMap.get("name");
    return name === args.agentName;
  });
  if (idx < 0) {
    return {
      outcome: "not-found",
      reason: `agent '${args.agentName}' not in agents seq`,
    };
  }

  const agentMap = items[idx] as {
    get?: (k: string) => unknown;
    set?: (k: string, v: unknown) => void;
  };
  if (
    typeof agentMap.get !== "function" ||
    typeof agentMap.set !== "function"
  ) {
    throw new Error(
      `agent '${args.agentName}' entry is not a map at agents[${idx}]`,
    );
  }

  // --- Idempotency: no-op when already at target model --------------
  const currentModel = agentMap.get("model");
  if (currentModel === validatedModel) {
    return {
      outcome: "no-op",
      reason: `agent '${args.agentName}' model already ${validatedModel}`,
    };
  }

  // --- Mutate ONE scalar (preserves all sibling fields + comments) --
  agentMap.set("model", validatedModel);

  // --- Serialize with no line-wrap ---------------------------------
  const newText = doc.toString({ lineWidth: 0 });

  // --- Atomic temp+rename — identical pattern to writeClawcodeYaml -
  const destDir = dirname(args.existingConfigPath);
  const tmpPath = join(
    destDir,
    `.clawcode.yaml.${pid}.${Date.now()}.tmp`,
  );
  await writerFs.writeFile(tmpPath, newText, "utf8");
  try {
    await writerFs.rename(tmpPath, args.existingConfigPath);
  } catch (err) {
    try {
      await writerFs.unlink(tmpPath);
    } catch {
      // best-effort — tmp may already be gone
    }
    throw err;
  }

  const targetSha256 = createHash("sha256")
    .update(newText, "utf8")
    .digest("hex");
  return {
    outcome: "updated",
    destPath: args.existingConfigPath,
    targetSha256,
  };
}

// ---------------------------------------------------------------------------
// Phase 88 Plan 01 Task 2 — updateAgentSkills.
//
// Atomic append/remove of a skill name on `agents[*].skills`. Mirrors the
// `updateAgentModel` structural template verbatim (parseDocument → find-
// by-name → YAMLSeq mutate → toString({lineWidth:0}) → tmp+rename →
// sha256 witness). The Phase 88 `installSingleSkill` consumer calls this
// AFTER the copier succeeds so the skill appears in the agent's
// `skills:` list on the next daemon boot. Non-rollback policy matches
// the Phase 86 MODEL-04 contract: copy is the irreversible downstream
// effect; YAML persist failure surfaces as persist_error to the caller.
//
// Contract (outcome matrix):
//   "updated"        — skill appended/removed; file rewritten
//   "no-op"          — idempotent (add on present, remove on absent)
//   "not-found"      — clawcode.yaml valid but agent missing from seq
//   "file-not-found" — clawcode.yaml does not exist
//   throws           — rename failure (tmp unlinked), structural YAML corruption
//
// DO NOT:
//   - Validate skillName against any catalog here — the caller (install-
//     single-skill.ts) owns catalog resolution. Writer treats skillName
//     as an opaque string (keeps cross-module coupling narrow).
//   - Re-run the secret scan — rewriting ONE string node (not inserting
//     operator-input YAML), same rationale as updateAgentModel.
// ---------------------------------------------------------------------------

export type UpdateAgentSkillsArgs = Readonly<{
  existingConfigPath: string;
  agentName: string;
  skillName: string;
  op: "add" | "remove";
  /** DI for test determinism — defaults to process.pid. */
  pid?: number;
}>;

export type UpdateAgentSkillsResult =
  | {
      readonly outcome: "updated";
      readonly destPath: string;
      readonly targetSha256: string;
    }
  | { readonly outcome: "no-op"; readonly reason: string }
  | { readonly outcome: "not-found"; readonly reason: string }
  | { readonly outcome: "file-not-found"; readonly reason: string };

export async function updateAgentSkills(
  args: UpdateAgentSkillsArgs,
): Promise<UpdateAgentSkillsResult> {
  const pid = args.pid ?? process.pid;

  // --- Gate: file presence ------------------------------------------
  if (!existsSync(args.existingConfigPath)) {
    return {
      outcome: "file-not-found",
      reason: `clawcode.yaml not found at ${args.existingConfigPath}`,
    };
  }

  // --- Read + parse (Document AST preserves comments + order) ------
  const existingText = await writerFs.readFile(
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
      reason: `no agents seq in clawcode.yaml`,
    };
  }
  const items = (agentsSeq as YAMLSeq).items as unknown as Array<unknown>;
  const idx = items.findIndex((it) => {
    if (it === null || typeof it !== "object") return false;
    const maybeMap = it as { get?: (k: string) => unknown };
    if (typeof maybeMap.get !== "function") return false;
    const name = maybeMap.get("name");
    return name === args.agentName;
  });
  if (idx < 0) {
    return {
      outcome: "not-found",
      reason: `agent '${args.agentName}' not in agents seq`,
    };
  }

  const agentMap = items[idx] as {
    get?: (k: string) => unknown;
    set?: (k: string, v: unknown) => void;
  };
  if (
    typeof agentMap.get !== "function" ||
    typeof agentMap.set !== "function"
  ) {
    throw new Error(
      `agent '${args.agentName}' entry is not a map at agents[${idx}]`,
    );
  }

  // --- Locate or initialize the agent's skills: seq ----------------
  let skillsSeq = agentMap.get("skills");
  if (!(skillsSeq instanceof YAMLSeq)) {
    // Either missing or a scalar (unusual — would fail configSchema, but
    // defensive). Initialize to an empty seq so the mutation below works.
    skillsSeq = new YAMLSeq();
    agentMap.set("skills", skillsSeq);
  }
  const seq = skillsSeq as YAMLSeq;

  // Snapshot the current skill names (extract scalar values from seq items).
  const seqItems = seq.items as unknown as Array<unknown>;
  const currentSkills = seqItems.map((node) => {
    // node may be a Scalar (has .value) or a bare string (older yaml stream shape).
    if (node !== null && typeof node === "object") {
      const maybe = node as { value?: unknown };
      if ("value" in maybe) return String(maybe.value);
    }
    return String(node);
  });

  // --- Idempotency gate ---------------------------------------------
  const alreadyPresent = currentSkills.includes(args.skillName);
  if (args.op === "add" && alreadyPresent) {
    return {
      outcome: "no-op",
      reason: `agent '${args.agentName}' skill '${args.skillName}' already present`,
    };
  }
  if (args.op === "remove" && !alreadyPresent) {
    return {
      outcome: "no-op",
      reason: `agent '${args.agentName}' skill '${args.skillName}' not in list`,
    };
  }

  // --- Mutate -------------------------------------------------------
  if (args.op === "add") {
    seq.add(args.skillName);
  } else {
    // remove: find and splice. Matches on the scalar value.
    const removeIdx = currentSkills.indexOf(args.skillName);
    if (removeIdx >= 0) {
      seqItems.splice(removeIdx, 1);
    }
  }

  // --- Serialize with no line-wrap ---------------------------------
  const newText = doc.toString({ lineWidth: 0 });

  // --- Atomic temp+rename ------------------------------------------
  const destDir = dirname(args.existingConfigPath);
  const tmpPath = join(
    destDir,
    `.clawcode.yaml.${pid}.${Date.now()}.tmp`,
  );
  await writerFs.writeFile(tmpPath, newText, "utf8");
  try {
    await writerFs.rename(tmpPath, args.existingConfigPath);
  } catch (err) {
    try {
      await writerFs.unlink(tmpPath);
    } catch {
      // best-effort — tmp may already be gone
    }
    throw err;
  }

  const targetSha256 = createHash("sha256")
    .update(newText, "utf8")
    .digest("hex");
  return {
    outcome: "updated",
    destPath: args.existingConfigPath,
    targetSha256,
  };
}

// ---------------------------------------------------------------------------
// Phase 90 Plan 05 HUB-04 — updateAgentMcpServers.
//
// Atomic add/remove of one MCP-server entry on `agents[*].mcpServers`.
// Third atomic YAML writer — mirrors updateAgentModel + updateAgentSkills
// structural template verbatim (parseDocument → find-by-name → YAMLSeq
// mutate → toString({lineWidth:0}) → tmp+rename → sha256 witness).
//
// The Phase 90 plugin installer (install-plugin.ts) calls this AFTER the
// plugin manifest is normalized to a ClawCode `mcpServerSchema` entry so
// the new server appears in the agent's `mcpServers:` list on the next
// daemon boot. Plugin hot-reload is DEFERRED per Phase 90 CONTEXT (D-5
// flag) — the operator must restart the agent after install.
//
// Contract (outcome matrix):
//   "updated"        — entry appended / replaced / removed; file rewritten
//   "no-op"          — idempotent (add on byte-identical entry; remove on absent)
//   "not-found"      — clawcode.yaml valid but agent missing from seq
//   "file-not-found" — clawcode.yaml does not exist
//   "refused"        — entry failed mcpServerSchema validation (step:invalid-entry)
//                      OR env value failed literal secret-scan (step:secret-scan)
//   throws           — rename failure (tmp unlinked), structural YAML corruption
//
// DO NOT:
//   - Treat scalar string elements as a ClawCode-native install target. The
//     mcpServers seq accepts a union of (YAMLMap | scalar-string-ref); add
//     always emits a YAMLMap. Remove matches by .name on YAMLMap AND by
//     scalar equality on strings so operator-edited string-refs are
//     removable symmetrically.
//   - Re-emit secret scan when the value is an `op://` reference — those
//     are explicitly safe. Plain env literals carry the classifier.
// ---------------------------------------------------------------------------

export type UpdateAgentMcpServersArgs = Readonly<{
  existingConfigPath: string;
  agentName: string;
  entry: Readonly<{
    name: string;
    command: string;
    args: readonly string[];
    env: Readonly<Record<string, string>>;
    optional?: boolean;
  }>;
  op: "add" | "remove";
  /** DI for test determinism — defaults to process.pid. */
  pid?: number;
}>;

export type UpdateAgentMcpServersResult =
  | {
      readonly outcome: "updated";
      readonly destPath: string;
      readonly targetSha256: string;
    }
  | { readonly outcome: "no-op"; readonly reason: string }
  | { readonly outcome: "not-found"; readonly reason: string }
  | { readonly outcome: "file-not-found"; readonly reason: string }
  | {
      readonly outcome: "refused";
      readonly reason: string;
      readonly step: "secret-scan" | "invalid-entry";
    };

export async function updateAgentMcpServers(
  args: UpdateAgentMcpServersArgs,
): Promise<UpdateAgentMcpServersResult> {
  const pid = args.pid ?? process.pid;

  // --- Gate: schema validation (defense-in-depth) --------------------
  // The caller (install-plugin.ts normalizePluginManifest) is expected to
  // hand in a valid shape; this self-guard catches future callers that
  // slip through with an invalid entry.
  const schemaCheck = mcpServerSchema.safeParse({
    name: args.entry.name,
    command: args.entry.command,
    args: [...args.entry.args],
    env: { ...args.entry.env },
    optional: args.entry.optional ?? false,
  });
  if (!schemaCheck.success) {
    return {
      outcome: "refused",
      reason: `invalid entry: ${schemaCheck.error.message.slice(0, 200)}`,
      step: "invalid-entry",
    };
  }

  // --- Gate: literal-value secret scan (ADD only) --------------------
  // Remove is a no-op from the secret perspective (we're DELETING bytes,
  // not inserting). Skip for remove to keep the happy-path cheap.
  if (args.op === "add") {
    for (const [k, v] of Object.entries(args.entry.env)) {
      const scan = scanLiteralValueForSecret(k, v);
      if (scan.refused) {
        return {
          outcome: "refused",
          reason: `env.${k}: ${scan.reason}`,
          step: "secret-scan",
        };
      }
    }
  }

  // --- Gate: file presence ------------------------------------------
  if (!existsSync(args.existingConfigPath)) {
    return {
      outcome: "file-not-found",
      reason: `clawcode.yaml not found at ${args.existingConfigPath}`,
    };
  }

  // --- Read + parse (Document AST preserves comments + order) ------
  const existingText = await writerFs.readFile(
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
      reason: `no agents seq in clawcode.yaml`,
    };
  }
  const items = (agentsSeq as YAMLSeq).items as unknown as Array<unknown>;
  const idx = items.findIndex((it) => {
    if (it === null || typeof it !== "object") return false;
    const maybeMap = it as { get?: (k: string) => unknown };
    if (typeof maybeMap.get !== "function") return false;
    const name = maybeMap.get("name");
    return name === args.agentName;
  });
  if (idx < 0) {
    return {
      outcome: "not-found",
      reason: `agent '${args.agentName}' not in agents seq`,
    };
  }

  const agentMap = items[idx] as {
    get?: (k: string) => unknown;
    set?: (k: string, v: unknown) => void;
  };
  if (
    typeof agentMap.get !== "function" ||
    typeof agentMap.set !== "function"
  ) {
    throw new Error(
      `agent '${args.agentName}' entry is not a map at agents[${idx}]`,
    );
  }

  // --- Locate or initialize the mcpServers seq ---------------------
  let mcpSeq = agentMap.get("mcpServers");
  if (!(mcpSeq instanceof YAMLSeq)) {
    mcpSeq = new YAMLSeq();
    agentMap.set("mcpServers", mcpSeq);
  }
  const seq = mcpSeq as YAMLSeq;
  const mcpSeqItems = seq.items as unknown as Array<unknown>;

  // --- Find existing element by .name (YAMLMap) or scalar equality --
  // A mcpServers entry may be a YAMLMap (inline def) OR a scalar string
  // (reference to top-level `mcpServers:` map keyed by name). Handle both.
  function getNameOfItem(node: unknown): string | undefined {
    if (node !== null && typeof node === "object") {
      const maybeMap = node as {
        get?: (k: string) => unknown;
        value?: unknown;
      };
      if (typeof maybeMap.get === "function") {
        const nm = maybeMap.get("name");
        return typeof nm === "string" ? nm : undefined;
      }
      if ("value" in maybeMap && typeof maybeMap.value === "string") {
        return maybeMap.value;
      }
    }
    if (typeof node === "string") return node;
    return undefined;
  }
  const existingIdx = mcpSeqItems.findIndex(
    (it) => getNameOfItem(it) === args.entry.name,
  );

  if (args.op === "remove") {
    if (existingIdx < 0) {
      return {
        outcome: "no-op",
        reason: `agent '${args.agentName}' mcpServer '${args.entry.name}' not present`,
      };
    }
    mcpSeqItems.splice(existingIdx, 1);
  } else {
    // ADD: build a new YAMLMap for the entry.
    const newMap = new YAMLMap();
    newMap.set("name", args.entry.name);
    newMap.set("command", args.entry.command);
    const argsSeq = new YAMLSeq();
    for (const a of args.entry.args) argsSeq.add(a);
    newMap.set("args", argsSeq);
    const envMap = new YAMLMap();
    for (const [k, v] of Object.entries(args.entry.env)) envMap.set(k, v);
    newMap.set("env", envMap);
    if (args.entry.optional === true) {
      newMap.set("optional", true);
    }

    if (existingIdx >= 0) {
      // Byte-identical idempotency check. Compare serialized forms of
      // old vs new YAMLMap — if equal, treat as no-op (matches Phase 86
      // MODEL-04 and Phase 88 MKT-04 precedents).
      const existing = mcpSeqItems[existingIdx];
      const oldSerialized =
        existing instanceof YAMLMap
          ? existing.toString()
          : String(
              (existing as { value?: unknown } | null)?.value ?? existing,
            );
      const newSerialized = newMap.toString();
      if (oldSerialized === newSerialized) {
        return {
          outcome: "no-op",
          reason: `agent '${args.agentName}' mcpServer '${args.entry.name}' byte-identical`,
        };
      }
      mcpSeqItems[existingIdx] = newMap;
    } else {
      seq.add(newMap);
    }
  }

  // --- Serialize with no line-wrap ---------------------------------
  const newText = doc.toString({ lineWidth: 0 });

  // --- Atomic temp+rename ------------------------------------------
  const destDir = dirname(args.existingConfigPath);
  const tmpPath = join(
    destDir,
    `.clawcode.yaml.${pid}.${Date.now()}.tmp`,
  );
  await writerFs.writeFile(tmpPath, newText, "utf8");
  try {
    await writerFs.rename(tmpPath, args.existingConfigPath);
  } catch (err) {
    try {
      await writerFs.unlink(tmpPath);
    } catch {
      // best-effort — tmp may already be gone
    }
    throw err;
  }

  const targetSha256 = createHash("sha256")
    .update(newText, "utf8")
    .digest("hex");
  return {
    outcome: "updated",
    destPath: args.existingConfigPath,
    targetSha256,
  };
}

// ---------------------------------------------------------------------------
// Phase 90 Plan 07 WIRE-01..04 — updateAgentConfig.
//
// Fourth atomic YAML writer in the series (after updateAgentModel,
// updateAgentSkills, updateAgentMcpServers). Unlike its siblings which
// each target ONE field, this one is a generic patcher: apply an arbitrary
// Partial<AgentConfig> patch to a single agent entry atomically. Used by
// Plan 07 to apply the fin-client wiring (effort + allowedModels +
// greetOnRestart + greetCoolDownMs + heartbeat + mcpServers) in one call.
//
// Defense in depth:
//   1. Defense-in-depth schema validation — agentSchema.safeParse on the
//      MERGED agent object (existing + patch). Catches runtime type errors
//      the call site might miss.
//   2. Literal secret scan — walk the patch (including nested) looking for
//      plain strings that are NOT op:// refs. Any credential-context string
//      refuses with step: "secret-scan".
//   3. Idempotency — diff each patch key against the current YAMLMap value;
//      no-op when no key actually changed (JSON-stable comparison).
//
// Contract:
//   "updated"        — patch applied; file rewritten
//   "no-op"          — every patch key already matched current value
//   "not-found"      — agent missing from agents: seq
//   "file-not-found" — clawcode.yaml does not exist
//   "refused"        — schema validation failed OR literal secret detected
//   throws           — rename failure (tmp unlinked), structural YAML corruption
// ---------------------------------------------------------------------------

export type UpdateAgentConfigArgs = Readonly<{
  existingConfigPath: string;
  agentName: string;
  /** Partial agent config — validated against agentSchema when merged. */
  patch: Readonly<Record<string, unknown>>;
  /** DI for test determinism — defaults to process.pid. */
  pid?: number;
}>;

export type UpdateAgentConfigResult =
  | {
      readonly outcome: "updated";
      readonly destPath: string;
      readonly targetSha256: string;
      readonly keysChanged: readonly string[];
    }
  | { readonly outcome: "no-op"; readonly reason: string }
  | { readonly outcome: "not-found"; readonly reason: string }
  | { readonly outcome: "file-not-found"; readonly reason: string }
  | {
      readonly outcome: "refused";
      readonly reason: string;
      readonly step: "invalid-patch" | "secret-scan";
    };

/**
 * Walk a patch object (arbitrary depth) and check every plain-string value
 * against the Phase 84 literal-secret gate. Returns `undefined` if clean;
 * a `{reason}` object if any value looks secret-like.
 *
 * `op://` references are always safe (they're 1Password resolvers).
 */
function scanPatchForLiteralSecrets(
  patch: Readonly<Record<string, unknown>>,
): { reason: string } | undefined {
  for (const [key, val] of Object.entries(patch)) {
    const refused = scanValueRecursive(key, val);
    if (refused) return refused;
  }
  return undefined;
}

function scanValueRecursive(
  key: string,
  val: unknown,
): { reason: string } | undefined {
  if (typeof val === "string") {
    if (val.startsWith("op://")) return undefined;
    const scan = scanLiteralValueForSecret(key, val);
    if (scan.refused) return { reason: `${key}: ${scan.reason}` };
    return undefined;
  }
  if (Array.isArray(val)) {
    for (const el of val) {
      const refused = scanValueRecursive(key, el);
      if (refused) return refused;
    }
    return undefined;
  }
  if (val !== null && typeof val === "object") {
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      const refused = scanValueRecursive(k, v);
      if (refused) return refused;
    }
    return undefined;
  }
  return undefined;
}

/**
 * Convert a plain-JS value into a yaml-lib node, preserving the seq/map
 * distinction + nesting. Used when mutating a YAMLMap so nested objects
 * + arrays round-trip correctly.
 */
function buildYamlNode(value: unknown): unknown {
  if (Array.isArray(value)) {
    const seq = new YAMLSeq();
    for (const el of value) seq.add(buildYamlNode(el));
    return seq;
  }
  if (value !== null && typeof value === "object") {
    const m = new YAMLMap();
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      m.set(k, buildYamlNode(v));
    }
    return m;
  }
  return value;
}

export async function updateAgentConfig(
  args: UpdateAgentConfigArgs,
): Promise<UpdateAgentConfigResult> {
  const pid = args.pid ?? process.pid;

  // --- Gate: file presence ------------------------------------------
  if (!existsSync(args.existingConfigPath)) {
    return {
      outcome: "file-not-found",
      reason: `clawcode.yaml not found at ${args.existingConfigPath}`,
    };
  }

  // --- Read + parse (Document AST preserves comments + order) ------
  const existingText = await writerFs.readFile(
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
      reason: `no agents seq in clawcode.yaml`,
    };
  }
  const items = (agentsSeq as YAMLSeq).items as unknown as Array<unknown>;
  const idx = items.findIndex((it) => {
    if (it === null || typeof it !== "object") return false;
    const maybeMap = it as { get?: (k: string) => unknown };
    if (typeof maybeMap.get !== "function") return false;
    const name = maybeMap.get("name");
    return name === args.agentName;
  });
  if (idx < 0) {
    return {
      outcome: "not-found",
      reason: `agent '${args.agentName}' not in agents seq`,
    };
  }

  const agentMap = items[idx] as YAMLMap;
  if (!(agentMap instanceof YAMLMap)) {
    throw new Error(
      `agent '${args.agentName}' entry is not a map at agents[${idx}]`,
    );
  }

  // --- Gate: defense-in-depth schema validation ---------------------
  // Serialize the agent node to plain JS, merge the patch, and run
  // agentSchema.safeParse. Catches invalid patch values (e.g. effort:
  // "banana") before we rewrite the file.
  const currentJs = (agentMap.toJSON() as Record<string, unknown>) ?? {};
  const merged: Record<string, unknown> = { ...currentJs };
  for (const [k, v] of Object.entries(args.patch)) merged[k] = v;

  const schemaCheck = agentSchema.safeParse(merged);
  if (!schemaCheck.success) {
    const firstIssue = schemaCheck.error.issues[0];
    const issueDesc = firstIssue
      ? `${firstIssue.path.join(".")}: ${firstIssue.message}`
      : "validation failed";
    return {
      outcome: "refused",
      reason: `invalid patch: ${issueDesc}`,
      step: "invalid-patch",
    };
  }

  // --- Gate: literal-value secret scan across the patch -------------
  const secretRefused = scanPatchForLiteralSecrets(args.patch);
  if (secretRefused) {
    return {
      outcome: "refused",
      reason: secretRefused.reason,
      step: "secret-scan",
    };
  }

  // --- Mutate ONLY the keys that actually changed -------------------
  // JSON-stable comparison tolerates YAMLMap vs plain-object shape drift
  // (agentMap.toJSON() returned a plain obj; patch values are plain).
  const keysChanged: string[] = [];
  for (const [k, v] of Object.entries(args.patch)) {
    const existing = currentJs[k];
    if (JSON.stringify(existing) === JSON.stringify(v)) continue;
    agentMap.set(k, buildYamlNode(v));
    keysChanged.push(k);
  }

  if (keysChanged.length === 0) {
    return {
      outcome: "no-op",
      reason: `all patch keys already match current values`,
    };
  }

  // --- Serialize with no line-wrap ---------------------------------
  const newText = doc.toString({ lineWidth: 0 });

  // --- Atomic temp+rename ------------------------------------------
  const destDir = dirname(args.existingConfigPath);
  const tmpPath = join(
    destDir,
    `.clawcode.yaml.${pid}.${Date.now()}.tmp`,
  );
  await writerFs.writeFile(tmpPath, newText, "utf8");
  try {
    await writerFs.rename(tmpPath, args.existingConfigPath);
  } catch (err) {
    try {
      await writerFs.unlink(tmpPath);
    } catch {
      // best-effort — tmp may already be gone
    }
    throw err;
  }

  const targetSha256 = createHash("sha256")
    .update(newText, "utf8")
    .digest("hex");
  return {
    outcome: "updated",
    destPath: args.existingConfigPath,
    targetSha256,
    keysChanged: Object.freeze(keysChanged),
  };
}
