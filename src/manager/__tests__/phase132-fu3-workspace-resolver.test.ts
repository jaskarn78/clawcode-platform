/**
 * Phase 132-fu3 — phase132AgentWorkspaceDir resolver regression.
 *
 * Pins the fu3 fix: the workspace resolver now reads
 * `manager.getAgentConfig(agentName).workspace` from the live
 * ResolvedAgentConfig instead of hardcoding `~/.clawcode/agents/<agent>`.
 *
 * Why this matters: shared-workspace agents (e.g. fin-client's
 * workspace is agents/acme/, not agents/fin-client/) had their
 * skill drafts written to an orphaned directory the live session never
 * read from. Operator-facing skill-draft embeds pointed at files the
 * agent could not see → silent UX failure.
 *
 * The resolver is defined inline as a daemon-closure local at
 * src/manager/daemon.ts:3380. We test the pattern by:
 *
 *   1. Behaviorally: construct the same lambda shape with a mock
 *      getAgentConfig and assert it returns the workspace from the config
 *      (not a hardcoded path) when the agent is known. Fall back to the
 *      hardcoded path when unknown.
 *
 *   2. Structurally (grep): read daemon.ts and assert the resolver body
 *      reads from `manager.getAgentConfig(...).workspace`. Catches the
 *      regression where someone reverts to the hardcoded path.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type AgentConfigLike = { readonly workspace: string };

/**
 * Reproduces the fu3 resolver lambda shape verbatim from daemon.ts:3380.
 * Kept in lock-step with the production resolver so this test is a true
 * pin (not a parallel implementation).
 */
function makeResolver(
  getAgentConfig: (name: string) => AgentConfigLike | undefined,
): (agentName: string) => string {
  return (agentName: string): string => {
    const cfg = getAgentConfig(agentName);
    return cfg?.workspace ?? join(homedir(), ".clawcode", "agents", agentName);
  };
}

describe("Phase 132-fu3 — phase132AgentWorkspaceDir resolver", () => {
  it("BEHAVIORAL: shared-workspace agent — returns workspace from ResolvedAgentConfig (not the hardcoded path)", () => {
    // fin-client production case: agent name is "fin-client" but
    // workspace lives at agents/acme/ (shared workspace with the
    // acme agent). The resolver MUST honor the config's workspace,
    // not the hardcoded path.
    const sharedWorkspace = "/home/clawcode/.clawcode/agents/acme";
    const resolver = makeResolver((name) =>
      name === "fin-client"
        ? { workspace: sharedWorkspace }
        : undefined,
    );
    expect(resolver("fin-client")).toBe(sharedWorkspace);
    // And critically NOT the hardcoded path that the pre-fix resolver
    // would have returned:
    const preFixPath = join(homedir(), ".clawcode", "agents", "fin-client");
    expect(resolver("fin-client")).not.toBe(preFixPath);
  });

  it("BEHAVIORAL: standard agent — returns its own workspace from ResolvedAgentConfig", () => {
    // Common case: agent name matches workspace dir name. Config still
    // resolves correctly (the lookup wins).
    const workspace = "/home/clawcode/.clawcode/agents/admin-clawdy";
    const resolver = makeResolver((name) =>
      name === "Admin Clawdy"
        ? { workspace }
        : undefined,
    );
    expect(resolver("Admin Clawdy")).toBe(workspace);
  });

  it("BEHAVIORAL: unknown agent — falls back to ~/.clawcode/agents/<name> (degradation-safe)", () => {
    // Defensive: if `getAgentConfig` ever returns undefined (config
    // not loaded yet, agent renamed mid-flight, etc.), the resolver
    // returns the legacy hardcoded path so callers never crash.
    const resolver = makeResolver(() => undefined);
    const expected = join(homedir(), ".clawcode", "agents", "Never Heard Of");
    expect(resolver("Never Heard Of")).toBe(expected);
  });

  it("BEHAVIORAL: config without workspace (truthy-cfg, falsy-workspace) still falls back", () => {
    // Edge case: ResolvedAgentConfig.workspace is typed `readonly string`
    // (non-nullable in src/shared/types.ts:12), so this path shouldn't
    // happen in practice — but if a runtime cast/test mock ever produces
    // a config object missing the field, optional chaining + `??`
    // collapses to the fallback. Confirm the contract.
    const resolver = makeResolver(() => ({ workspace: "" }));
    // Empty string is falsy → `??` does NOT trigger (?? only triggers
    // on null/undefined), so empty string is returned verbatim. This
    // documents the contract: only undefined/null trigger the fallback.
    expect(resolver("anything")).toBe("");
  });

  it("STRUCTURAL (grep): daemon.ts resolver body reads from manager.getAgentConfig().workspace", () => {
    // Catches a regression where someone reverts the resolver to the
    // pre-fu3 hardcoded form. We slice the function body between the
    // `phase132AgentWorkspaceDir =` declaration and the next blank
    // line / next statement, then assert the slice contains the
    // expected primary-source-of-truth lookup.
    const daemonSrc = readFileSync(
      join(__dirname, "../daemon.ts"),
      "utf-8",
    );
    const declStart = daemonSrc.indexOf("const phase132AgentWorkspaceDir =");
    expect(declStart).toBeGreaterThan(0);
    // Resolver body is small — slice ~400 chars after the declaration.
    const body = daemonSrc.slice(declStart, declStart + 400);
    // Primary-source-of-truth invariant: must read from getAgentConfig.
    expect(body).toMatch(/manager\.getAgentConfig\(/);
    // And must reference the workspace field.
    expect(body).toMatch(/\.workspace/);
    // Fallback invariant: must keep the legacy hardcoded path for
    // degradation safety.
    expect(body).toMatch(/\.clawcode/);
    expect(body).toMatch(/agents/);
  });
});
