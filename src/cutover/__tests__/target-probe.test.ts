/**
 * Phase 92 Plan 02 Task 1 (RED) — target-probe tests.
 *
 * Pins the contract for `probeTargetCapability(deps)` defined in the
 * plan's <interfaces> block. All tests fail at this stage because
 * src/cutover/target-probe.ts does not yet exist (RED gate).
 *
 * Behavioral pins:
 *   PR1 happy-path             — outcome.kind === "probed"; written JSON validates
 *   PR2 agent-not-found        — config has no matching agent → typed outcome
 *   PR3 yaml-load-failed       — loadConfig rejects → typed outcome with err
 *   PR4 ipc-failed             — listMcpStatus rejects → typed outcome with err
 *   PR5 NO-LEAK                — env values never appear in TARGET-CAPABILITY.json
 *                                (sk_live_secret_42 is the canary literal here)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  probeTargetCapability,
  type ProbeDeps,
  type McpServerSnapshot,
} from "../target-probe.js";
import { targetCapabilitySchema } from "../types.js";

function makeLog() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  } as unknown as import("pino").Logger;
}

/**
 * Build a minimal Config-shaped object the probe reads. The probe touches
 * only `agents[]` and per-agent fields (skills, mcpServers, model,
 * allowedModels, memoryAutoLoad). Everything else is unused — we cast
 * via `as unknown` so we don't have to materialize the full Config schema.
 */
function makeConfigWithAgent(agentName: string, overrides: Record<string, unknown> = {}) {
  return {
    agents: [
      {
        name: agentName,
        skills: ["content-engine"],
        mcpServers: [
          {
            name: "1password",
            command: "/usr/bin/op",
            args: [],
            env: { OP_SERVICE_ACCOUNT_TOKEN: "redact-me-please" },
            optional: false,
          },
        ],
        model: "claude-sonnet-4-6",
        allowedModels: ["claude-sonnet-4-6", "claude-opus-4"],
        memoryAutoLoad: true,
        channels: ["1234567890"],
        ...overrides,
      },
    ],
  };
}

let outputDir: string;
beforeEach(async () => {
  outputDir = await mkdtemp(join(tmpdir(), "cutover-probe-"));
});
afterEach(async () => {
  await rm(outputDir, { recursive: true, force: true });
});

function makeBaseDeps(
  overrides: Partial<ProbeDeps> = {},
): ProbeDeps {
  const happyMcp: readonly McpServerSnapshot[] = [
    {
      name: "1password",
      status: "healthy",
      lastError: null,
      failureCount: 0,
      envKeys: ["OP_SERVICE_ACCOUNT_TOKEN"],
    },
  ];
  return {
    agent: "fin-client",
    outputDir,
    loadConfig: vi.fn(async () => makeConfigWithAgent("fin-client") as unknown as never),
    listMcpStatus: vi.fn(async () => happyMcp),
    readWorkspaceInventory: vi.fn(async () => ({
      memoryFiles: [
        { path: "memory/2026-04-15-x.md", sha256: "abc123" },
      ],
      memoryMdSha256: "deadbeef",
      uploads: ["chart.png"],
      skillsInstalled: ["content-engine"],
    })),
    log: makeLog(),
    ...overrides,
  };
}

describe("probeTargetCapability — PR1 happy path", () => {
  it("emits TARGET-CAPABILITY.json that validates against the schema", async () => {
    const deps = makeBaseDeps();
    const outcome = await probeTargetCapability(deps);

    expect(outcome.kind).toBe("probed");
    if (outcome.kind === "probed") {
      expect(outcome.agent).toBe("fin-client");
      expect(outcome.capabilityPath).toBe(
        join(outputDir, "TARGET-CAPABILITY.json"),
      );
      const raw = await readFile(outcome.capabilityPath, "utf8");
      const parsed = JSON.parse(raw);
      const validated = targetCapabilitySchema.safeParse(parsed);
      expect(validated.success).toBe(true);
      if (validated.success) {
        expect(validated.data.agent).toBe("fin-client");
        // YAML mirror: skill names + sorted env KEY names only.
        expect(validated.data.yaml.skills).toEqual(["content-engine"]);
        expect(validated.data.yaml.mcpServers).toEqual([
          { name: "1password", envKeys: ["OP_SERVICE_ACCOUNT_TOKEN"] },
        ]);
        expect(validated.data.yaml.allowedModels).toEqual([
          "claude-opus-4",
          "claude-sonnet-4-6",
        ]);
        expect(validated.data.yaml.memoryAutoLoad).toBe(true);
        expect(validated.data.workspace.uploads).toEqual(["chart.png"]);
        expect(validated.data.workspace.skillsInstalled).toEqual([
          "content-engine",
        ]);
        expect(validated.data.mcpRuntime[0]?.status).toBe("healthy");
      }
    }
  });
});

describe("probeTargetCapability — PR2 agent-not-found", () => {
  it("returns {kind:'agent-not-found'} when config has no matching agent", async () => {
    const deps = makeBaseDeps({
      loadConfig: vi.fn(async () =>
        makeConfigWithAgent("other-agent") as unknown as never,
      ),
    });
    const outcome = await probeTargetCapability(deps);
    expect(outcome.kind).toBe("agent-not-found");
    if (outcome.kind === "agent-not-found") {
      expect(outcome.agent).toBe("fin-client");
    }
  });
});

describe("probeTargetCapability — PR3 yaml-load-failed", () => {
  it("returns {kind:'yaml-load-failed'} when loadConfig rejects", async () => {
    const deps = makeBaseDeps({
      loadConfig: vi.fn(async () => {
        throw new Error("clawcode.yaml not found");
      }),
    });
    const outcome = await probeTargetCapability(deps);
    expect(outcome.kind).toBe("yaml-load-failed");
    if (outcome.kind === "yaml-load-failed") {
      expect(outcome.error).toMatch(/clawcode\.yaml not found/);
    }
  });
});

describe("probeTargetCapability — PR4 ipc-failed", () => {
  it("returns {kind:'ipc-failed'} when listMcpStatus rejects", async () => {
    const deps = makeBaseDeps({
      listMcpStatus: vi.fn(async () => {
        throw new Error("daemon not running");
      }),
    });
    const outcome = await probeTargetCapability(deps);
    expect(outcome.kind).toBe("ipc-failed");
    if (outcome.kind === "ipc-failed") {
      expect(outcome.error).toMatch(/daemon not running/);
    }
  });
});

describe("probeTargetCapability — PR5 NO-LEAK env values redacted", () => {
  it("written JSON contains envKeys names only — env VALUES never leak", async () => {
    // Inject a sentinel literal we can grep for in the output.
    const sensitiveCfg = makeConfigWithAgent("fin-client");
    // Replace with a single MCP server carrying a fake-but-recognizable secret.
    (sensitiveCfg.agents[0] as { mcpServers: unknown }).mcpServers = [
      {
        name: "stripe",
        command: "/bin/stripe",
        args: [],
        env: { STRIPE_SECRET_KEY: "sk_live_secret_42" },
        optional: false,
      },
    ];
    const deps = makeBaseDeps({
      loadConfig: vi.fn(async () => sensitiveCfg as unknown as never),
      listMcpStatus: vi.fn(async () => [
        {
          name: "stripe",
          status: "healthy" as const,
          lastError: null,
          failureCount: 0,
          envKeys: ["STRIPE_SECRET_KEY"],
        },
      ]),
    });
    const outcome = await probeTargetCapability(deps);
    expect(outcome.kind).toBe("probed");
    if (outcome.kind === "probed") {
      const raw = await readFile(outcome.capabilityPath, "utf8");
      // Env KEY name must be present.
      expect(raw).toContain("STRIPE_SECRET_KEY");
      // Env VALUE literal must NOT appear anywhere — primary NO-LEAK pin.
      expect(raw).not.toContain("sk_live_secret_42");
    }
  });
});
