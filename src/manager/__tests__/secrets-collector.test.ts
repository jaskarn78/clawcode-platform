/**
 * Phase 999.10 Plan 02 — collectAllOpRefs unit tests (COLL-01..COLL-07).
 *
 * Pure-function walker — no I/O, no logging. Each test constructs a minimal
 * `Config`-shaped fixture (cast `as unknown as Config` where the schema
 * requires fields irrelevant to the walker's contract) and asserts the
 * exact set of op:// URIs returned.
 *
 * Three zones in scope (matches plan 02 must-haves + roadmap entry):
 *   1. discord.botToken
 *   2. mcpServers.<name>.env.<key>
 *   3. agents.<name>.mcpEnvOverrides.<server>.<key>
 */

import { describe, it, expect } from "vitest";
import type { Config } from "../../config/schema.js";
import { collectAllOpRefs } from "../secrets-collector.js";

/** Build a minimal Config-shaped fixture. Fields the walker doesn't read are stubbed. */
function makeConfig(overrides: Partial<Config> = {}): Config {
  // Cast through unknown — the walker only reads discord, mcpServers, agents.
  // A full schema-valid fixture is unnecessary for unit-testing the walker.
  return {
    version: 1,
    defaults: {} as Config["defaults"],
    agents: [],
    mcpServers: {},
    triggers: undefined,
    ...overrides,
  } as unknown as Config;
}

describe("collectAllOpRefs", () => {
  it("COLL-01: returns op:// URI from discord.botToken", () => {
    const cfg = makeConfig({
      discord: { botToken: "op://example-vault-21/Discord/token" },
    } as Partial<Config>);
    expect(collectAllOpRefs(cfg)).toEqual(["op://example-vault-21/Discord/token"]);
  });

  it("COLL-02: returns op:// URIs from mcpServers[].env", () => {
    const cfg = makeConfig({
      mcpServers: {
        github: {
          command: "node",
          args: [],
          env: { GITHUB_TOKEN: "op://example-vault-21/GitHub/pat" },
        },
        mysql: {
          command: "node",
          args: [],
          env: {
            MYSQL_PASS: "op://example-vault-21/MySQL/password",
            MYSQL_HOST: "localhost", // literal — must NOT appear
          },
        },
      } as unknown as Config["mcpServers"],
    });
    const result = collectAllOpRefs(cfg);
    expect(result).toContain("op://example-vault-21/GitHub/pat");
    expect(result).toContain("op://example-vault-21/MySQL/password");
    expect(result).not.toContain("localhost");
    expect(result).toHaveLength(2);
  });

  it("COLL-03: returns op:// URIs from agents[].mcpEnvOverrides", () => {
    const cfg = makeConfig({
      agents: [
        {
          name: "acme-agent",
          mcpEnvOverrides: {
            "1password": {
              OP_SERVICE_ACCOUNT_TOKEN:
                "op://example-vault-21/Acme Service Account/credential",
            },
          },
        } as unknown as Config["agents"][number],
      ],
    });
    expect(collectAllOpRefs(cfg)).toEqual([
      "op://example-vault-21/Acme Service Account/credential",
    ]);
  });

  it("COLL-04: dedups duplicate URIs across zones", () => {
    const sharedUri = "op://example-vault-21/Shared/token";
    const cfg = makeConfig({
      discord: { botToken: sharedUri } as Config["discord"],
      mcpServers: {
        a: { command: "x", args: [], env: { K: sharedUri } },
      } as unknown as Config["mcpServers"],
      agents: [
        {
          name: "a",
          mcpEnvOverrides: { srv: { K: sharedUri } },
        } as unknown as Config["agents"][number],
      ],
    });
    const result = collectAllOpRefs(cfg);
    expect(result).toEqual([sharedUri]);
    expect(result).toHaveLength(1);
  });

  it("COLL-05: ignores literal (non-op://) values", () => {
    const cfg = makeConfig({
      discord: { botToken: "literal-token-123" } as Config["discord"],
      mcpServers: {
        a: {
          command: "x",
          args: [],
          env: { K: "literal-value", L: "" },
        },
      } as unknown as Config["mcpServers"],
      agents: [
        {
          name: "a",
          mcpEnvOverrides: { srv: { K: "plain-secret" } },
        } as unknown as Config["agents"][number],
      ],
    });
    expect(collectAllOpRefs(cfg)).toEqual([]);
  });

  it("COLL-06: handles missing discord (undefined botToken) without throwing", () => {
    // discord absent
    expect(() => collectAllOpRefs(makeConfig({ discord: undefined }))).not.toThrow();
    // discord present but no botToken
    expect(() =>
      collectAllOpRefs(
        makeConfig({ discord: {} as Config["discord"] }),
      ),
    ).not.toThrow();
    expect(
      collectAllOpRefs(makeConfig({ discord: {} as Config["discord"] })),
    ).toEqual([]);
  });

  it("COLL-07: handles missing mcpServers / empty agents map without throwing", () => {
    const cfg = makeConfig({
      mcpServers: undefined as unknown as Config["mcpServers"],
      agents: [],
    });
    expect(() => collectAllOpRefs(cfg)).not.toThrow();
    expect(collectAllOpRefs(cfg)).toEqual([]);

    // Agent without mcpEnvOverrides — must not throw.
    const cfg2 = makeConfig({
      agents: [{ name: "a" } as unknown as Config["agents"][number]],
    });
    expect(collectAllOpRefs(cfg2)).toEqual([]);
  });

  // Phase 110 follow-up — Zone 4: defaults.search.{brave,exa}.apiKey.
  it("COLL-08: returns op:// URI from defaults.search.brave.apiKey", () => {
    const cfg = makeConfig({
      defaults: {
        search: {
          brave: { apiKey: "op://example-vault-21/Brave Search API Key/credential" },
          exa: {},
        },
      } as unknown as Config["defaults"],
    });
    expect(collectAllOpRefs(cfg)).toEqual([
      "op://example-vault-21/Brave Search API Key/credential",
    ]);
  });

  it("COLL-09: returns op:// URI from defaults.search.exa.apiKey", () => {
    const cfg = makeConfig({
      defaults: {
        search: {
          brave: {},
          exa: { apiKey: "op://example-vault-21/Exa/credential" },
        },
      } as unknown as Config["defaults"],
    });
    expect(collectAllOpRefs(cfg)).toEqual(["op://example-vault-21/Exa/credential"]);
  });

  it("COLL-10: collects both brave + exa apiKey op:// refs in one pass", () => {
    const cfg = makeConfig({
      defaults: {
        search: {
          brave: { apiKey: "op://example-vault-21/Brave/credential" },
          exa: { apiKey: "op://example-vault-21/Exa/credential" },
        },
      } as unknown as Config["defaults"],
    });
    const result = collectAllOpRefs(cfg);
    expect(result).toContain("op://example-vault-21/Brave/credential");
    expect(result).toContain("op://example-vault-21/Exa/credential");
    expect(result).toHaveLength(2);
  });

  it("COLL-11: ignores literal (non-op://) brave.apiKey / exa.apiKey", () => {
    const cfg = makeConfig({
      defaults: {
        search: {
          brave: { apiKey: "BSA-literal-key" },
          exa: { apiKey: "" },
        },
      } as unknown as Config["defaults"],
    });
    expect(collectAllOpRefs(cfg)).toEqual([]);
  });

  it("COLL-12: handles missing defaults.search / undefined apiKey without throwing", () => {
    // No defaults.
    expect(() =>
      collectAllOpRefs(makeConfig({ defaults: undefined } as unknown as Partial<Config>)),
    ).not.toThrow();
    // defaults present but no search.
    expect(() =>
      collectAllOpRefs(
        makeConfig({ defaults: {} as Config["defaults"] }),
      ),
    ).not.toThrow();
    // search present but no brave/exa.apiKey set.
    expect(
      collectAllOpRefs(
        makeConfig({
          defaults: {
            search: { brave: {}, exa: {} },
          } as unknown as Config["defaults"],
        }),
      ),
    ).toEqual([]);
  });
});
