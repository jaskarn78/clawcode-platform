/**
 * Phase 92 Plan 02 — Target capability probe (CUT-03).
 *
 * DI-PURE — all I/O is injected via `ProbeDeps`. The CLI wrapper at
 * src/cli/commands/cutover-probe.ts is the production caller that wires
 * loadConfig, listMcpStatus (via IpcClient), and readWorkspaceInventory.
 *
 * Reads the THREE sources defined by D-03:
 *   1. clawcode.yaml        — via deps.loadConfig (skills, mcpServers,
 *                              model, allowedModels, memoryAutoLoad)
 *   2. workspace inventory  — via deps.readWorkspaceInventory (MEMORY.md
 *                              hash, memory tree md hashes, uploads/discord
 *                              filenames, skills dir names)
 *   3. live MCP runtime     — via deps.listMcpStatus (Phase 85 IPC payload
 *                              normalized into `McpServerSnapshot[]`)
 *
 * NO-LEAK invariant (regression-pinned):
 *   The probe extracts MCP env KEY NAMES via Object.keys(env) — VALUES
 *   are NEVER read, copied, or serialized. The output JSON contains
 *   `envKeys: ["STRIPE_SECRET_KEY"]` but never the literal token value.
 *
 * Output: <outputDir>/TARGET-CAPABILITY.json (atomic temp+rename).
 *
 * Static-grep purity pins:
 *   ! grep -E "agentCfg\\.mcpServers\\[.*\\]\\.env\\[" src/cutover/target-probe.ts
 *   ! grep "JSON.stringify.*env"                       src/cutover/target-probe.ts
 *   grep "envKeys: Object.keys"                        src/cutover/target-probe.ts
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Logger } from "pino";
import {
  type ProbeOutcome,
  type TargetCapability,
  targetCapabilitySchema,
} from "./types.js";

/**
 * Phase 85 list-mcp-status IPC payload narrowed to fields the probe consumes.
 *
 * Note: the production list-mcp-status IPC returns `status` as
 * `"ready" | "degraded" | "failed" | "reconnecting" | "unknown"`. The CLI
 * wrapper at cutover-probe.ts is responsible for mapping that vocabulary
 * into the `"healthy" | "warning" | "critical" | "unknown"` vocabulary the
 * probe + TargetCapability schema expect. Tests pass already-normalized
 * snapshots directly — this keeps the probe pure-DI.
 */
export type McpServerSnapshot = {
  readonly name: string;
  readonly status: "healthy" | "warning" | "critical" | "unknown";
  readonly lastError: string | null;
  readonly failureCount: number;
  /**
   * KEY NAMES ONLY — values redacted. The IPC payload reuses this same
   * key-name discipline; the probe never sees raw env values from the daemon.
   */
  readonly envKeys: readonly string[];
};

/**
 * Workspace inventory shape — produced by the CLI wrapper's filesystem walk
 * (defaultReadWorkspaceInventory) or by tests passing a synthetic value.
 *
 * Memory file paths are RELATIVE to `memoryRoot` (e.g. "memory/x.md"), and
 * sha256 hashes are SHA-256 hex digests of file contents. Filenames in
 * `uploads` are bare (no path), matching the convention from Phase 91 sync.
 */
export type WorkspaceInventory = {
  readonly memoryFiles: readonly { readonly path: string; readonly sha256: string }[];
  readonly memoryMdSha256: string | null;
  readonly uploads: readonly string[];
  readonly skillsInstalled: readonly string[];
};

/**
 * Loose Config-shape — narrows to fields the probe consumes. Avoids a
 * direct dependency on the full Config schema so tests can pass synthetic
 * objects without materializing every required field.
 */
export type ProbeConfigShape = {
  readonly agents?: ReadonlyArray<{
    readonly name: string;
    readonly skills?: readonly string[];
    readonly mcpServers?: ReadonlyArray<
      | string
      | {
          readonly name: string;
          readonly env?: Readonly<Record<string, string>>;
        }
    >;
    readonly model?: string;
    readonly allowedModels?: readonly string[];
    readonly memoryAutoLoad?: boolean;
    readonly memoryPath?: string;
    readonly workspace?: string;
    readonly channels?: readonly string[];
    readonly schedules?: ReadonlyArray<unknown>;
  }>;
};

/**
 * DI surface for the probe. The CLI wrapper closes over the daemon socket
 * and config path; tests pass `vi.fn()` stubs for each I/O slot.
 */
export type ProbeDeps = {
  readonly agent: string;
  readonly outputDir: string;
  readonly loadConfig: () => Promise<ProbeConfigShape>;
  readonly listMcpStatus: (
    agent: string,
  ) => Promise<readonly McpServerSnapshot[]>;
  readonly readWorkspaceInventory: (
    agent: string,
    memoryRoot: string,
  ) => Promise<WorkspaceInventory>;
  readonly now?: () => Date;
  readonly log: Logger;
};

/**
 * Default memory-root resolver — agents that don't carry an explicit
 * `memoryPath` fall back to `~/.clawcode/agents/<agent>` (mirrors the
 * convention from Phase 75 SHARED-01). Pure (env-read-only) — kept here
 * so the CLI wrapper stays thin.
 */
function defaultMemoryRoot(agent: string): string {
  const home =
    process.env.HOME ??
    process.env.USERPROFILE ??
    "/home/clawcode";
  return join(home, ".clawcode", "agents", agent);
}

/**
 * Run one probe cycle. Returns a `ProbeOutcome` discriminated union; the
 * CLI wrapper exhaustively switches on `outcome.kind` for exit-code policy.
 *
 * Failure mapping:
 *   - loadConfig rejects                 → yaml-load-failed
 *   - agent missing from config.agents   → agent-not-found
 *   - readWorkspaceInventory rejects     → yaml-load-failed (with phase prefix)
 *   - listMcpStatus rejects              → ipc-failed
 *   - schema validation fails            → yaml-load-failed (with schema prefix)
 *
 * The collapse of inventory-failures into yaml-load-failed keeps the
 * outcome surface tractable for Plan 92-06's report writer (3 failure
 * kinds total).
 */
export async function probeTargetCapability(
  deps: ProbeDeps,
): Promise<ProbeOutcome> {
  const startDate = (deps.now ?? (() => new Date()))();
  const startMs = startDate.getTime();

  // ------------------------------------------------------------------------
  // 1. Load clawcode.yaml.
  // ------------------------------------------------------------------------
  let config: ProbeConfigShape;
  try {
    config = await deps.loadConfig();
  } catch (err) {
    return {
      kind: "yaml-load-failed",
      agent: deps.agent,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const agents = config.agents ?? [];
  const agentCfg = agents.find((a) => a.name === deps.agent);
  if (agentCfg === undefined) {
    return { kind: "agent-not-found", agent: deps.agent };
  }

  // ------------------------------------------------------------------------
  // 2. Resolve memory root + read workspace inventory.
  // ------------------------------------------------------------------------
  const memoryRoot = agentCfg.memoryPath ?? defaultMemoryRoot(deps.agent);

  let inventory: WorkspaceInventory;
  try {
    inventory = await deps.readWorkspaceInventory(deps.agent, memoryRoot);
  } catch (err) {
    return {
      kind: "yaml-load-failed",
      agent: deps.agent,
      error: `inventory: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // ------------------------------------------------------------------------
  // 3. Live MCP runtime via Phase 85 IPC.
  // ------------------------------------------------------------------------
  let mcpRuntime: readonly McpServerSnapshot[];
  try {
    mcpRuntime = await deps.listMcpStatus(deps.agent);
  } catch (err) {
    return {
      kind: "ipc-failed",
      agent: deps.agent,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // ------------------------------------------------------------------------
  // 4. Build YAML mirror — explicit field-by-field copy. NEVER spread
  //    ...agentCfg or ...mcpServers (would risk leaking env values).
  // ------------------------------------------------------------------------
  // TargetCapability schema infers `envKeys: string[]` (mutable). Keep the
  // local shape mutable so the assembled `capability` literal below assigns
  // cleanly without a copy step.
  const yamlMcpServers: { name: string; envKeys: string[] }[] = [];
  for (const entry of agentCfg.mcpServers ?? []) {
    if (typeof entry === "string") {
      // Inline string form — this is a reference to a top-level mcpServers
      // record; we don't have the env shape here so envKeys is empty.
      yamlMcpServers.push({ name: entry, envKeys: [] });
      continue;
    }
    // Object form — extract KEY NAMES only via Object.keys. NEVER access
    // entry.env[key] anywhere in this function (NO-LEAK pin).
    const envKeys = Object.keys(entry.env ?? {}).slice().sort();
    yamlMcpServers.push({ name: entry.name, envKeys });
  }
  yamlMcpServers.sort((a, b) => a.name.localeCompare(b.name));

  // sessionKinds — derive from agent's schedules array (when present).
  // Empty by default; v1 surfaces "scheduled" + "direct" when schedules exist
  // so target's parity-with-cron status is detectable. Cron-specific
  // detection is the Plan 92-04 destructive-embed concern.
  const sessionKinds: string[] = ["direct"];
  if ((agentCfg.schedules ?? []).length > 0) {
    sessionKinds.push("scheduled");
  }
  sessionKinds.sort();

  const yaml = {
    skills: [...(agentCfg.skills ?? [])].sort(),
    mcpServers: yamlMcpServers,
    model: agentCfg.model ?? "",
    allowedModels: [...(agentCfg.allowedModels ?? [])].sort(),
    memoryAutoLoad: agentCfg.memoryAutoLoad ?? true,
    sessionKinds,
  };

  // ------------------------------------------------------------------------
  // 5. Build workspace block — sort everything for byte-deterministic output.
  // ------------------------------------------------------------------------
  const workspace = {
    memoryRoot,
    memoryFiles: [...inventory.memoryFiles].sort((a, b) =>
      a.path.localeCompare(b.path),
    ),
    memoryMdSha256: inventory.memoryMdSha256,
    uploads: [...inventory.uploads].sort(),
    skillsInstalled: [...inventory.skillsInstalled].sort(),
  };

  // ------------------------------------------------------------------------
  // 6. Build mcpRuntime block — drop envKeys from snapshots before
  //    serialization (envKeys live on the YAML mirror; runtime block is
  //    health-only).
  // ------------------------------------------------------------------------
  const mcpRuntimeSorted = [...mcpRuntime]
    .map((r) => ({
      name: r.name,
      status: r.status,
      lastError: r.lastError,
      failureCount: r.failureCount,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const capability: TargetCapability = {
    agent: deps.agent,
    generatedAt: startDate.toISOString(),
    yaml,
    workspace,
    mcpRuntime: mcpRuntimeSorted,
  };

  // ------------------------------------------------------------------------
  // 7. Defensive schema validation — catches shape drift between probe
  //    builder and consumer expectations early.
  // ------------------------------------------------------------------------
  const parsed = targetCapabilitySchema.safeParse(capability);
  if (!parsed.success) {
    return {
      kind: "yaml-load-failed",
      agent: deps.agent,
      error: `schema: ${parsed.error.message}`,
    };
  }

  // ------------------------------------------------------------------------
  // 8. Write atomically (mkdir + writeFile to .tmp + rename).
  // ------------------------------------------------------------------------
  await mkdir(deps.outputDir, { recursive: true });
  const outPath = join(deps.outputDir, "TARGET-CAPABILITY.json");
  const tmp = `${outPath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(parsed.data, null, 2), "utf8");
  await rename(tmp, outPath);

  const endMs = (deps.now ?? (() => new Date()))().getTime();
  const durationMs = Math.max(0, endMs - startMs);

  deps.log.info(
    {
      agent: deps.agent,
      capabilityPath: outPath,
      yamlSkills: yaml.skills.length,
      yamlMcpServers: yaml.mcpServers.length,
      memoryFiles: workspace.memoryFiles.length,
      durationMs,
    },
    "cutover probe: emitted TARGET-CAPABILITY.json",
  );

  return {
    kind: "probed",
    agent: deps.agent,
    capabilityPath: outPath,
    durationMs,
  };
}
