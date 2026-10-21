/**
 * claude.ai connector entitlement: only an opted-in, non-admin agent whose owner
 * is in `defaults.claudeAiConnectors.allowedOwners` runs with the account's
 * connectors; everything else keeps ENABLE_CLAUDEAI_MCP_SERVERS=false.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveClaudeAiConnectorsEntitlement } from "../claudeai-connectors-entitlement.js";
import { resolveAgentConfig } from "../loader.js";
import { agentSchema, defaultsSchema } from "../schema.js";
import { buildSessionConfig, type SessionConfigDeps } from "../../manager/session-config.js";

const JAS = ["owner_a"];

describe("resolveClaudeAiConnectorsEntitlement", () => {
  it("no opt-in → not entitled, nothing to warn about", () => {
    expect(resolveClaudeAiConnectorsEntitlement({ name: "personal", owner: "owner_a" }, JAS)).toEqual({
      entitled: false,
    });
  });

  it("opted in + allowed owner + not admin → entitled", () => {
    expect(
      resolveClaudeAiConnectorsEntitlement({ name: "personal", owner: "owner_a", claudeAiConnectors: true }, JAS),
    ).toEqual({ entitled: true });
  });

  it("an admin agent is refused even when its owner is allowed (cross-owner request sink)", () => {
    const d = resolveClaudeAiConnectorsEntitlement(
      { name: "Admin Clawdy", owner: "owner_a", admin: true, claudeAiConnectors: true },
      JAS,
    );
    expect(d.entitled).toBe(false);
    expect(d.refusedReason).toMatch(/admin/);
  });

  it("an owner outside allowedOwners is refused", () => {
    const d = resolveClaudeAiConnectorsEntitlement(
      { name: "fin-client", owner: "client_a", claudeAiConnectors: true },
      JAS,
    );
    expect(d.entitled).toBe(false);
    expect(d.refusedReason).toMatch(/'client_a'/);
  });

  it("an untenanted agent is refused", () => {
    const d = resolveClaudeAiConnectorsEntitlement({ name: "x", claudeAiConnectors: true }, JAS);
    expect(d.entitled).toBe(false);
    expect(d.refusedReason).toMatch(/no owner/);
  });

  it("an empty allowlist refuses everyone (fail-closed default)", () => {
    const d = resolveClaudeAiConnectorsEntitlement(
      { name: "personal", owner: "owner_a", claudeAiConnectors: true },
      [],
    );
    expect(d.entitled).toBe(false);
  });
});

describe("loader → ResolvedAgentConfig.claudeAiConnectors", () => {
  afterEach(() => vi.restoreAllMocks());

  const withAllow = (owners: string[] | undefined) =>
    defaultsSchema.parse(owners === undefined ? {} : { claudeAiConnectors: { allowedOwners: owners } });
  const resolve = (agent: Record<string, unknown>, owners?: string[]) =>
    resolveAgentConfig(agentSchema.parse({ name: "a", channels: [], ...agent }), withAllow(owners));

  it("entitled agent carries claudeAiConnectors: true", () => {
    expect(resolve({ owner: "owner_a", claudeAiConnectors: true }, ["owner_a"]).claudeAiConnectors).toBe(true);
  });

  it("non-opted agents keep a byte-identical resolved config (no key)", () => {
    const r = resolve({ owner: "owner_a" }, ["owner_a"]);
    expect("claudeAiConnectors" in r).toBe(false);
  });

  it("a refused opt-in is warned and omitted", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = resolve({ name: "fin-client", owner: "client_a", claudeAiConnectors: true }, ["owner_a"]);
    expect("claudeAiConnectors" in r).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/fin-client\.claudeAiConnectors: true refused/));
  });

  it("admin agent opt-in is refused", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = resolve({ name: "Admin Clawdy", owner: "owner_a", admin: true, claudeAiConnectors: true }, ["owner_a"]);
    expect("claudeAiConnectors" in r).toBe(false);
  });

  it("no defaults.claudeAiConnectors block → nobody is entitled", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = resolve({ owner: "owner_a", claudeAiConnectors: true });
    expect("claudeAiConnectors" in r).toBe(false);
  });
});

describe("buildSessionConfig threads the entitlement (both paths)", () => {
  const deps = (): SessionConfigDeps => ({ tierManagers: new Map(), skillsCatalog: new Map(), allAgentConfigs: [] });
  const resolved = (agent: Record<string, unknown>) =>
    resolveAgentConfig(
      agentSchema.parse({ name: "personal", channels: [], ...agent }),
      defaultsSchema.parse({ claudeAiConnectors: { allowedOwners: ["owner_a"] } }),
    );

  it("entitled → session config carries claudeAiConnectors: true", async () => {
    const cfg = await buildSessionConfig(resolved({ owner: "owner_a", claudeAiConnectors: true }), deps());
    expect(cfg.claudeAiConnectors).toBe(true);
  });

  it("not entitled → key omitted (byte-stability pin)", async () => {
    const cfg = await buildSessionConfig(resolved({ owner: "owner_a" }), deps());
    expect("claudeAiConnectors" in cfg).toBe(false);
  });

  it("a sub/thread config spread from an entitled parent keeps the entitlement", async () => {
    const parent = resolved({ owner: "owner_a", claudeAiConnectors: true });
    const cfg = await buildSessionConfig({ ...parent, name: "personal-sub-abc123" }, deps());
    expect(cfg.claudeAiConnectors).toBe(true);
  });
});
