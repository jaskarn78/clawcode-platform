/**
 * Phase 92 Plan 02 Task 1 (RED) — diff-engine tests.
 *
 * Pins the contract for `diffAgentVsTarget(profile, target)` defined in
 * the plan's <interfaces> block. All tests fail at this stage because
 * src/cutover/diff-engine.ts does not yet exist (RED gate).
 *
 * Behavioral pins (D-04 + D-11):
 *   D1 missing-skill              — skill in profile, absent in target.yaml.skills
 *   D2 missing-mcp                — MCP in profile, absent in target.yaml.mcpServers
 *   D3 missing-memory-file        — memory ref in profile, absent in target inventory
 *   D4 missing-upload             — upload in profile, absent in target inventory
 *   D5 outdated-memory-file       — same path on both sides, hashes differ
 *   D6 model-not-in-allowlist     — model used in profile, not in target.yaml.allowedModels
 *   D7 mcp-credential-drift       — MCP critical w/ auth-shaped lastError
 *   D8 tool-permission-gap        — tool in profile + target advertises ACL deny
 *   D9 cron-session-not-mirrored  — cron session in profile, not mirrored on target (D-11)
 *   D-DETERMINISM                 — same input twice → byte-identical output (kind, identifier sort)
 *   D-EXHAUSTIVE                  — compile-time exhaustive switch over all 9 kinds
 */

import { describe, it, expect } from "vitest";
import { diffAgentVsTarget } from "../diff-engine.js";
import {
  assertNever,
  type AgentProfile,
  type CutoverGap,
  type TargetCapability,
} from "../types.js";

// ---------------------------------------------------------------------------
// Factory helpers — keep tests DRY and only-the-relevant-fields-set readable.
// ---------------------------------------------------------------------------

function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    tools: [],
    skills: [],
    mcpServers: [],
    memoryRefs: [],
    models: ["claude-sonnet-4-6"],
    uploads: [],
    topIntents: [],
    ...overrides,
  };
}

function makeTarget(
  overrides: Partial<TargetCapability> = {},
): TargetCapability {
  const base: TargetCapability = {
    agent: "fin-client",
    generatedAt: "2026-04-24T22:30:00Z",
    yaml: {
      skills: [],
      mcpServers: [],
      model: "claude-sonnet-4-6",
      allowedModels: ["claude-sonnet-4-6"],
      memoryAutoLoad: true,
      sessionKinds: [],
    },
    workspace: {
      memoryRoot: "/home/clawcode/.clawcode/agents/fin-client",
      memoryFiles: [],
      memoryMdSha256: null,
      uploads: [],
      skillsInstalled: [],
    },
    mcpRuntime: [],
    ...overrides,
  };
  return base;
}

// ---------------------------------------------------------------------------
// Per-kind detection tests
// ---------------------------------------------------------------------------

describe("diffAgentVsTarget — D1 missing-skill", () => {
  it("emits missing-skill when profile uses a skill the target lacks", () => {
    const result = diffAgentVsTarget(
      makeProfile({ skills: ["content-engine"] }),
      makeTarget({ yaml: { ...makeTarget().yaml, skills: [] } }),
    );
    const gap = result.find(
      (g) => g.kind === "missing-skill" && g.identifier === "content-engine",
    );
    expect(gap).toBeDefined();
    if (gap && gap.kind === "missing-skill") {
      expect(gap.severity).toBe("additive");
      expect(gap.sourceRef.skillName).toBe("content-engine");
    }
  });
});

describe("diffAgentVsTarget — D2 missing-mcp", () => {
  it("emits missing-mcp when profile uses an MCP server the target lacks", () => {
    const result = diffAgentVsTarget(
      makeProfile({
        mcpServers: ["1password"],
        tools: ["mcp__1password__read"],
      }),
      makeTarget({ yaml: { ...makeTarget().yaml, mcpServers: [] } }),
    );
    const gap = result.find(
      (g) => g.kind === "missing-mcp" && g.identifier === "1password",
    );
    expect(gap).toBeDefined();
    if (gap && gap.kind === "missing-mcp") {
      expect(gap.severity).toBe("additive");
      expect(gap.sourceRef.mcpServerName).toBe("1password");
      expect(gap.sourceRef.toolsUsed).toContain("mcp__1password__read");
    }
  });
});

describe("diffAgentVsTarget — D3 missing-memory-file", () => {
  it("emits missing-memory-file when profile references a memory file absent on target", () => {
    const result = diffAgentVsTarget(
      makeProfile({ memoryRefs: ["vault/x.md"] }),
      makeTarget(),
    );
    const gap = result.find(
      (g) =>
        g.kind === "missing-memory-file" && g.identifier === "vault/x.md",
    );
    expect(gap).toBeDefined();
    if (gap && gap.kind === "missing-memory-file") {
      expect(gap.severity).toBe("additive");
      expect(gap.targetRef.exists).toBe(false);
    }
  });
});

describe("diffAgentVsTarget — D4 missing-upload", () => {
  it("emits missing-upload when profile references an upload not present on target", () => {
    const result = diffAgentVsTarget(
      makeProfile({ uploads: ["chart.png"] }),
      makeTarget(),
    );
    const gap = result.find(
      (g) => g.kind === "missing-upload" && g.identifier === "chart.png",
    );
    expect(gap).toBeDefined();
    if (gap && gap.kind === "missing-upload") {
      expect(gap.severity).toBe("additive");
      expect(gap.sourceRef.filename).toBe("chart.png");
    }
  });
});

describe("diffAgentVsTarget — D5 outdated-memory-file", () => {
  // For v1, AgentProfile.memoryRefs is plain strings (no hashes). We extend
  // the fixture via a cast so the compile-time CutoverGap variant is
  // exercised + Plan 92-04's destructive embed renderer has a code path
  // even before profiler enrichment ships.
  type ExtendedProfile = AgentProfile & {
    memoryRefHashes?: Readonly<Record<string, string>>;
  };
  it("emits outdated-memory-file when path matches but hashes differ", () => {
    const profile = makeProfile({ memoryRefs: ["memory/x.md"] });
    const extended: ExtendedProfile = {
      ...profile,
      memoryRefHashes: { "memory/x.md": "source-hash-aaa" },
    };
    const target = makeTarget({
      workspace: {
        ...makeTarget().workspace,
        memoryFiles: [{ path: "memory/x.md", sha256: "target-hash-bbb" }],
      },
    });
    const result = diffAgentVsTarget(
      extended as AgentProfile,
      target,
    );
    const gap = result.find(
      (g) =>
        g.kind === "outdated-memory-file" && g.identifier === "memory/x.md",
    );
    expect(gap).toBeDefined();
    if (gap && gap.kind === "outdated-memory-file") {
      expect(gap.severity).toBe("destructive");
      expect(gap.sourceRef.sourceHash).toBe("source-hash-aaa");
      expect(gap.targetRef.targetHash).toBe("target-hash-bbb");
    }
  });
});

describe("diffAgentVsTarget — D6 model-not-in-allowlist", () => {
  it("emits model-not-in-allowlist when profile used a model excluded from target allowlist", () => {
    const result = diffAgentVsTarget(
      makeProfile({ models: ["claude-opus-4"] }),
      makeTarget({
        yaml: {
          ...makeTarget().yaml,
          allowedModels: ["claude-sonnet-4-6"],
        },
      }),
    );
    const gap = result.find(
      (g) =>
        g.kind === "model-not-in-allowlist" &&
        g.identifier === "claude-opus-4",
    );
    expect(gap).toBeDefined();
    if (gap && gap.kind === "model-not-in-allowlist") {
      expect(gap.severity).toBe("additive");
      expect(gap.sourceRef.modelId).toBe("claude-opus-4");
    }
  });
});

describe("diffAgentVsTarget — D7 mcp-credential-drift", () => {
  it("emits mcp-credential-drift when MCP server is critical with auth-shaped lastError", () => {
    const result = diffAgentVsTarget(
      makeProfile({ mcpServers: ["stripe"] }),
      makeTarget({
        yaml: {
          ...makeTarget().yaml,
          mcpServers: [{ name: "stripe", envKeys: ["STRIPE_SECRET_KEY"] }],
        },
        mcpRuntime: [
          {
            name: "stripe",
            status: "critical",
            lastError: "401 invalid_key",
            failureCount: 7,
          },
        ],
      }),
    );
    const gap = result.find(
      (g) =>
        g.kind === "mcp-credential-drift" && g.identifier === "stripe",
    );
    expect(gap).toBeDefined();
    if (gap && gap.kind === "mcp-credential-drift") {
      expect(gap.severity).toBe("destructive");
      expect(gap.targetRef.status).toBe("critical");
      expect(gap.targetRef.envKeys).toContain("STRIPE_SECRET_KEY");
    }
  });
});

describe("diffAgentVsTarget — D8 tool-permission-gap", () => {
  // For v1, TargetCapability does not carry aclDenies natively. We extend
  // the fixture via a cast so the compile-time variant is exercised + Plan
  // 92-04 has a code path.
  type ExtendedTarget = TargetCapability & {
    aclDenies?: readonly string[];
  };
  it("emits tool-permission-gap when profile uses a tool the target ACL denies", () => {
    const profile = makeProfile({ tools: ["Bash"] });
    const target = makeTarget();
    const extended: ExtendedTarget = {
      ...target,
      aclDenies: ["Bash"],
    };
    const result = diffAgentVsTarget(profile, extended as TargetCapability);
    const gap = result.find(
      (g) => g.kind === "tool-permission-gap" && g.identifier === "Bash",
    );
    expect(gap).toBeDefined();
    if (gap && gap.kind === "tool-permission-gap") {
      expect(gap.severity).toBe("destructive");
      expect(gap.sourceRef.toolName).toBe("Bash");
      expect(gap.targetRef.aclDenies).toContain("Bash");
    }
  });
});

describe("diffAgentVsTarget — D9 cron-session-not-mirrored (D-11)", () => {
  // AgentProfile carries cron-prefixed intents (D-11 amendment in Plan 92-01).
  // The differ surfaces them as gaps when target.yaml.sessionKinds[] does
  // not include the matching cron entry.
  it("emits cron-session-not-mirrored when MC has cron but target lacks the schedule", () => {
    const result = diffAgentVsTarget(
      makeProfile({
        topIntents: [
          { intent: "cron:acme-db-sync", count: 12 },
          { intent: "portfolio-analysis", count: 47 },
        ],
      }),
      makeTarget({
        yaml: {
          ...makeTarget().yaml,
          sessionKinds: ["direct", "scheduled"], // no cron entry
        },
      }),
    );
    const gap = result.find(
      (g) =>
        g.kind === "cron-session-not-mirrored" &&
        g.identifier === "cron:acme-db-sync",
    );
    expect(gap).toBeDefined();
    if (gap && gap.kind === "cron-session-not-mirrored") {
      expect(gap.severity).toBe("destructive");
      expect(gap.sourceRef.kind).toBe("cron");
      expect(gap.sourceRef.sessionKey).toBe("cron:acme-db-sync");
    }
    // Non-cron intents must NOT surface as cron-session gaps.
    const portfolioGap = result.find(
      (g) =>
        g.kind === "cron-session-not-mirrored" &&
        g.identifier === "portfolio-analysis",
    );
    expect(portfolioGap).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Determinism + exhaustiveness
// ---------------------------------------------------------------------------

describe("diffAgentVsTarget — D-DETERMINISM sorted output, byte-identical reruns", () => {
  it("returns gaps sorted by (kind asc, identifier asc) and same input → deep-equal output", () => {
    // Construct a profile that yields 4 gaps spanning different kinds,
    // intentionally added in non-canonical order.
    const profile = makeProfile({
      skills: ["zeta", "alpha"],
      mcpServers: ["beta"],
      uploads: ["x.png"],
    });
    const target = makeTarget();

    const first = diffAgentVsTarget(profile, target);
    const second = diffAgentVsTarget(profile, target);

    // Determinism: deep equality across two calls.
    expect(second).toEqual(first);

    // Sort key: kind asc THEN identifier asc.
    const tuples = first.map((g) => [g.kind, g.identifier] as const);
    const sorted = [...tuples].sort((a, b) =>
      a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0]),
    );
    expect(tuples).toEqual(sorted);

    // Concretely: missing-mcp(beta), missing-skill(alpha), missing-skill(zeta),
    // missing-upload(x.png).
    expect(tuples).toEqual([
      ["missing-mcp", "beta"],
      ["missing-skill", "alpha"],
      ["missing-skill", "zeta"],
      ["missing-upload", "x.png"],
    ]);
  });
});

describe("diffAgentVsTarget — D-EXHAUSTIVE compile-time switch over all 9 kinds", () => {
  it("compile-time exhaustive switch over all 9 CutoverGap kinds", () => {
    const gaps: readonly CutoverGap[] = [];
    for (const gap of gaps) {
      switch (gap.kind) {
        case "missing-skill":
        case "missing-mcp":
        case "missing-memory-file":
        case "missing-upload":
        case "outdated-memory-file":
        case "model-not-in-allowlist":
        case "mcp-credential-drift":
        case "tool-permission-gap":
        case "cron-session-not-mirrored":
          break;
        default:
          assertNever(gap);
      }
    }
    // Run-time presence; the actual check is the TypeScript compile.
    expect(true).toBe(true);
  });
});
