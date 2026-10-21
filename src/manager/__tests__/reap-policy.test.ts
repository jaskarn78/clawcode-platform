/**
 * P4 (memory program) — remediation lattice + fork/pool scan + P4 scanner
 * predicates + schema surface.
 */
import { describe, it, expect } from "vitest";
import {
  resolveRemediationMode,
  scanForForkPoolSessions,
  forkPoolParentOf,
  SESSION_KIND_POLICIES,
  type RemediationConfig,
} from "../reap-policy.js";
import {
  isNpmWrapperCmdline,
  isClaudeCliCmdline,
} from "../../mcp/orphan-reaper.js";

const envOn = { CLAWCODE_REMEDIATION_DISABLE: "1" };
const envOff = {};

describe("resolveRemediationMode — tighten-only lattice", () => {
  it("grandfathered classes default reap even with enabled:false/absent config", () => {
    expect(resolveRemediationMode("mcp-orphan", undefined, envOff)).toBe("reap");
    expect(resolveRemediationMode("chrome", { enabled: false }, envOff)).toBe("reap");
    expect(resolveRemediationMode("sub", {}, envOff)).toBe("reap");
  });

  it("new classes default off", () => {
    for (const cls of ["survivor-cli", "npm", "fork", "pool"] as const) {
      expect(resolveRemediationMode(cls, undefined, envOff)).toBe("off");
    }
  });

  it("enabled:false clamps an explicit reap on a NEW class to alert", () => {
    const cfg: RemediationConfig = { enabled: false, classes: { npm: "reap" } };
    expect(resolveRemediationMode("npm", cfg, envOff)).toBe("alert");
  });

  it("enabled:true honors explicit reap on a new class", () => {
    const cfg: RemediationConfig = { enabled: true, classes: { npm: "reap" } };
    expect(resolveRemediationMode("npm", cfg, envOff)).toBe("reap");
  });

  it("explicit off/alert on a grandfathered class is honored (tighten)", () => {
    expect(
      resolveRemediationMode("chrome", { classes: { chrome: "off" } }, envOff),
    ).toBe("off");
    expect(
      resolveRemediationMode("sub", { classes: { sub: "alert" } }, envOff),
    ).toBe("alert");
  });

  it("env kill-switch clamps EVERYTHING (incl. grandfathered) to ≤ alert", () => {
    expect(resolveRemediationMode("mcp-orphan", undefined, envOn)).toBe("alert");
    expect(
      resolveRemediationMode(
        "npm",
        { enabled: true, classes: { npm: "reap" } },
        envOn,
      ),
    ).toBe("alert");
    // off stays off — the switch never loosens.
    expect(resolveRemediationMode("fork", undefined, envOn)).toBe("off");
  });
});

describe("scanForForkPoolSessions", () => {
  const NOW = 1_700_000_000_000;
  const mk = (name: string, ageSec: number, status = "running") => ({
    name,
    status,
    startedAt: NOW - ageSec * 1000,
  });
  const base = {
    runningAgentNames: new Set(["alpha"]),
    isPoolManaged: () => true,
    poolCapForParent: () => 2,
    parentOf: forkPoolParentOf,
    now: NOW,
  };

  it("ignores agents/workers, non-running, and under-min-age sessions", () => {
    const out = scanForForkPoolSessions({
      ...base,
      sessions: [
        mk("alpha", 99_999),
        mk("alpha-sub-x1y2z3", 99_999),
        mk("beta-fork-x1y2z3", 99_999, "stopping"),
        mk("beta-fork-a1b2c3", 30), // under fork minAge 600
      ],
    });
    expect(out).toEqual([]);
  });

  it("fork: orphaned parent + max-age trigger; healthy young fork passes", () => {
    const out = scanForForkPoolSessions({
      ...base,
      sessions: [
        mk("beta-fork-x1y2z3", 700), // parent beta not running
        mk("alpha-fork-a1b2c3", SESSION_KIND_POLICIES.fork.maxAgeMinutes * 60 + 5),
        mk("alpha-fork-q9w8e7", 700), // healthy: parent running, under max-age
      ],
    });
    expect(out.map((c) => [c.name, c.reason])).toEqual([
      ["beta-fork-x1y2z3", "orphaned-parent"],
      ["alpha-fork-a1b2c3", "max-age"],
    ]);
  });

  it("pool: parked-warm managed under-cap is NEVER a candidate (no idleness trigger)", () => {
    const out = scanForForkPoolSessions({
      ...base,
      sessions: [mk("alpha-pool-x1y2z3", 999_999)], // days old, still fine
    });
    expect(out).toEqual([]);
  });

  it("pool: orphaned parent / unmanaged / over-cap (oldest excess only)", () => {
    const out = scanForForkPoolSessions({
      ...base,
      isPoolManaged: (n) => n !== "alpha-pool-unmngd",
      sessions: [
        mk("gone-pool-x1y2z3", 700), // parent not running
        mk("alpha-pool-unmngd", 700),
        mk("alpha-pool-old111", 5000),
        mk("alpha-pool-old222", 4000),
        mk("alpha-pool-new333", 700), // cap 2 → oldest 1 of 3 is excess
      ],
    });
    expect(out.map((c) => [c.name, c.reason])).toEqual([
      ["gone-pool-x1y2z3", "orphaned-parent"],
      ["alpha-pool-unmngd", "unmanaged-pool"],
      ["alpha-pool-old111", "over-cap"],
    ]);
  });

  it("forkPoolParentOf strips fork/pool suffixes incl. -opt", () => {
    expect(forkPoolParentOf("alpha-fork-x1y2z3")).toBe("alpha");
    expect(forkPoolParentOf("alpha-fork-x1y2z3-opt")).toBe("alpha");
    expect(forkPoolParentOf("a-b-pool-q9w8e7")).toBe("a-b");
    expect(forkPoolParentOf("plain-agent")).toBe("plain-agent");
  });
});

describe("P4 scanner predicates", () => {
  it("isNpmWrapperCmdline matches wrappers, not exec'd servers", () => {
    expect(isNpmWrapperCmdline(["npm", "exec", "mcp-server-mysql@latest"])).toBe(true);
    expect(isNpmWrapperCmdline(["/usr/bin/npx", "-y", "foo"])).toBe(true);
    expect(
      isNpmWrapperCmdline(["node", "/usr/local/lib/node_modules/npm/bin/npx-cli.js", "-y", "foo"]),
    ).toBe(true);
    // The LIVE exec'd server under the _npx install path must NOT match.
    expect(
      isNpmWrapperCmdline([
        "node",
        "/home/clawcode/.npm/_npx/abc123/node_modules/.bin/mcp-server-mysql",
      ]),
    ).toBe(false);
    // argv beyond index 1 is never a signal.
    expect(isNpmWrapperCmdline(["node", "server.js", "--via", "npm"])).toBe(false);
  });

  it("isClaudeCliCmdline matches claude + bwrap-wrapped claude only", () => {
    expect(isClaudeCliCmdline(["/opt/claude-bin/claude", "--print"])).toBe(true);
    expect(isClaudeCliCmdline(["claude"])).toBe(true);
    expect(
      isClaudeCliCmdline(["bwrap", "--bind", "/", "/", "/opt/bin/claude"]),
    ).toBe(true);
    expect(isClaudeCliCmdline(["bwrap", "--bind", "/", "/", "python3"])).toBe(false);
    expect(isClaudeCliCmdline(["node", "/opt/clawcode/dist/index.js"])).toBe(false);
    expect(isClaudeCliCmdline([])).toBe(false);
  });
});

describe("schema defaults.memoryGuard.remediation", () => {
  it("parses with defaults (enabled:false) and rejects unknown class/mode", async () => {
    const { defaultsSchema } = await import("../../config/schema.js");
    const parsed = defaultsSchema.parse({
      memoryGuard: { remediation: { classes: { npm: "alert" } } },
    });
    expect(parsed.memoryGuard?.remediation).toMatchObject({
      enabled: false,
      classes: { npm: "alert" },
    });
    expect(() =>
      defaultsSchema.parse({
        memoryGuard: { remediation: { classes: { daemon: "reap" } } },
      }),
    ).toThrow();
    expect(() =>
      defaultsSchema.parse({
        memoryGuard: { remediation: { classes: { npm: "kill" } } },
      }),
    ).toThrow();
  });
});
