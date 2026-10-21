/**
 * Quick 260511-pw3 — schema-registry introspection tests.
 *
 * Covers:
 *   1. TaskManager.listSchemasForAgent — returns the target's accepted
 *      schemas with callerAllowed + registered flags.
 *   2. TaskManager.acceptedSchemasForTarget — used as the payload on
 *      delegate_task unknown_schema errors.
 *   3. Sentinel — daemon.ts `case "delegate-task":` translates
 *      ValidationError("unknown_schema") into ManagerError with structured
 *      `data: { reason, schema, target, acceptedSchemas }` so the IPC
 *      server forwards the accepted list to the wire. Pins the production
 *      caller chain (anti-pattern: silent path bifurcation).
 *   4. Sentinel — daemon.ts `case "list-agent-schemas":` exists and reads
 *      from the same TaskManager method.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TaskManager } from "../task-manager.js";
import { SchemaRegistry } from "../schema-registry.js";
import { compileJsonSchema } from "../handoff-schema.js";

// ---------------------------------------------------------------------------
// Fixture builders — match the pattern used in task-manager.test.ts
// ---------------------------------------------------------------------------

function makeRegistry(schemaNames: readonly string[]): SchemaRegistry {
  return SchemaRegistry.fromEntries(
    schemaNames.map((name) => ({
      name,
      input: compileJsonSchema({
        type: "object",
        properties: { x: { type: "string" } },
        required: ["x"],
      }),
      output: compileJsonSchema({
        type: "object",
        properties: { y: { type: "string" } },
        required: ["y"],
      }),
    })),
  );
}

type AgentConfig = {
  readonly name: string;
  readonly model: "sonnet" | "opus" | "haiku";
  readonly acceptsTasks?: Readonly<Record<string, readonly string[]>>;
};

function makeManager(
  configs: Record<string, AgentConfig>,
  registry: SchemaRegistry,
): TaskManager {
  // Minimal store/dispatcher stubs — these methods aren't exercised by the
  // introspection paths.
  const stubStore = {
    insert: () => undefined,
    get: () => null,
    transition: () => undefined,
    listByCausation: () => [],
  } as unknown as ConstructorParameters<typeof TaskManager>[0]["store"];

  const stubDispatcher = (() => Promise.resolve()) as unknown as ConstructorParameters<
    typeof TaskManager
  >[0]["turnDispatcher"];

  const stubBudget = {
    consume: () => undefined,
    available: () => Number.MAX_SAFE_INTEGER,
  } as unknown as ConstructorParameters<typeof TaskManager>[0]["escalationBudget"];

  return new TaskManager({
    store: stubStore,
    turnDispatcher: stubDispatcher,
    schemaRegistry: registry,
    escalationBudget: stubBudget,
    getAgentConfig: (name: string) => configs[name] ?? null,
  });
}

// ---------------------------------------------------------------------------
// TaskManager.listSchemasForAgent
// ---------------------------------------------------------------------------

describe("TaskManager.listSchemasForAgent", () => {
  it("returns each accepted schema with callerAllowed + registered flags", () => {
    const registry = makeRegistry(["research.brief", "data.export"]);
    const configs: Record<string, AgentConfig> = {
      caller: { name: "caller", model: "sonnet", acceptsTasks: {} },
      projects: {
        name: "projects",
        model: "sonnet",
        acceptsTasks: {
          "research.brief": ["caller"], // caller allowed
          "data.export": ["other-agent"], // caller NOT allowed
          "missing.schema": ["caller"], // not in registry
        },
      },
    };
    const mgr = makeManager(configs, registry);
    const result = mgr.listSchemasForAgent("caller", "projects");
    expect(result).toEqual([
      { name: "research.brief", callerAllowed: true, registered: true },
      { name: "data.export", callerAllowed: false, registered: true },
      { name: "missing.schema", callerAllowed: true, registered: false },
    ]);
  });

  it("returns empty array when target is unknown", () => {
    const mgr = makeManager({}, makeRegistry([]));
    expect(mgr.listSchemasForAgent("caller", "ghost")).toEqual([]);
  });

  it("returns empty array when target has no acceptsTasks", () => {
    const configs: Record<string, AgentConfig> = {
      bare: { name: "bare", model: "sonnet" },
    };
    const mgr = makeManager(configs, makeRegistry([]));
    expect(mgr.listSchemasForAgent("caller", "bare")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TaskManager.acceptedSchemasForTarget
// ---------------------------------------------------------------------------

describe("TaskManager.acceptedSchemasForTarget", () => {
  it("intersects acceptsTasks keys with the fleet registry", () => {
    const registry = makeRegistry(["research.brief", "data.export"]);
    const configs: Record<string, AgentConfig> = {
      projects: {
        name: "projects",
        model: "sonnet",
        acceptsTasks: {
          "research.brief": ["caller"],
          "data.export": ["caller"],
          "missing.schema": ["caller"], // omitted from result — not registered
        },
      },
    };
    const mgr = makeManager(configs, registry);
    const result = mgr.acceptedSchemasForTarget("projects");
    expect([...result].sort()).toEqual(["data.export", "research.brief"]);
  });

  it("returns frozen empty array for unknown target", () => {
    const mgr = makeManager({}, makeRegistry([]));
    const result = mgr.acceptedSchemasForTarget("ghost");
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Sentinel — production caller chain pinned in daemon.ts
// ---------------------------------------------------------------------------

describe("Sentinel — daemon.ts production chain", () => {
  const repoRoot = join(__dirname, "..", "..", "..");
  const daemonSrc = readFileSync(
    join(repoRoot, "src/manager/daemon.ts"),
    "utf8",
  );
  const mcpSrc = readFileSync(
    join(repoRoot, "src/mcp/server.ts"),
    "utf8",
  );

  it("case delegate-task catches ValidationError(unknown_schema) and attaches acceptedSchemas to ManagerError.data", () => {
    // Pin the catch + acceptedSchemasForTarget call. Without this, a future
    // refactor could remove the structured data and the MCP wrapper would
    // silently fall back to the generic "Delegate failed: ..." string —
    // the exact regression Quick 260511-pw3 is fixing.
    expect(daemonSrc).toMatch(
      /case "delegate-task":[\s\S]*?taskManager\.acceptedSchemasForTarget\(target\)/,
    );
    expect(daemonSrc).toMatch(
      /reason:\s*"unknown_schema",[\s\S]*?acceptedSchemas/,
    );
  });

  it("case list-agent-schemas exists and calls taskManager.listSchemasForAgent", () => {
    expect(daemonSrc).toMatch(
      /case "list-agent-schemas":[\s\S]*?taskManager\.listSchemasForAgent\(caller, target\)/,
    );
  });

  it("MCP server registers list_agent_schemas tool", () => {
    expect(mcpSrc).toMatch(/server\.tool\(\s*"list_agent_schemas"/);
  });

  it("MCP TOOL_DEFINITIONS includes list_agent_schemas mapped to IPC method list-agent-schemas", () => {
    expect(mcpSrc).toMatch(
      /list_agent_schemas:\s*{[\s\S]*?ipcMethod:\s*"list-agent-schemas"/,
    );
  });

  it("delegate_task MCP wrapper renders acceptedSchemas on unknown_schema errors", () => {
    // Pin the structured-error branch in the MCP delegate_task handler.
    // The branch must read `errData.reason === "unknown_schema"` and
    // surface `acceptedSchemas` in the rendered text.
    expect(mcpSrc).toMatch(/reason: unknown[\s\S]*?unknown_schema/);
    expect(mcpSrc).toMatch(/acceptedSchemas/);
  });
});
