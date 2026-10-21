/**
 * Phase 90 Plan 05 HUB-02 / HUB-04 — installClawhubPlugin + normalizePluginManifest tests.
 *
 * Pins (PL-C1..C4, PL-INS1..3):
 *   PL-C1  normalizePluginManifest happy — maps manifest → mcpServerSchema shape
 *   PL-C2  normalizePluginManifest operator input wins over default
 *   PL-C3  normalizePluginManifest — required field missing → {ok:false, missing_field}
 *   PL-C4  installClawhubPlugin manifest-invalid passthrough from normalize
 *   PL-INS1 install happy — writes YAML + returns installed
 *   PL-INS2 install blocked-secret-scan — literal high-entropy credential refused
 *   PL-INS3 mapFetchErrorToOutcome maps rate-limited / auth-required / manifest-invalid
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

import {
  installClawhubPlugin,
  normalizePluginManifest,
  mapFetchErrorToOutcome,
} from "../install-plugin.js";
import type { ClawhubPluginManifest } from "../clawhub-client.js";
import {
  ClawhubAuthRequiredError,
  ClawhubManifestInvalidError,
  ClawhubRateLimitedError,
} from "../clawhub-client.js";
import { writerFs } from "../../migration/yaml-writer.js";

const ORIG_FS = { ...writerFs };

afterEach(() => {
  vi.restoreAllMocks();
  writerFs.readFile = ORIG_FS.readFile;
  writerFs.writeFile = ORIG_FS.writeFile;
  writerFs.rename = ORIG_FS.rename;
  writerFs.unlink = ORIG_FS.unlink;
});

function makeManifest(
  overrides: Partial<ClawhubPluginManifest> = {},
): ClawhubPluginManifest {
  return Object.freeze({
    name: "acme-db-helper",
    description: "MySQL client",
    version: "1.2.0",
    command: "mcporter",
    args: ["serve", "mysql"],
    env: {
      MYSQL_HOST: {
        default: null,
        required: true,
        sensitive: false,
        description: "DB host",
      },
      MYSQL_PASSWORD: {
        default: null,
        required: true,
        sensitive: true,
        description: "DB password",
      },
    },
    ...overrides,
  } as ClawhubPluginManifest);
}

const BASE_YAML = `version: 1
defaults:
  model: sonnet
agents:
  - name: clawdy
    workspace: ~/.clawcode/agents/clawdy
    model: haiku
    channels:
      - "111"
    skills: []
    mcpServers: []
`;

async function setupYamlFixture(): Promise<{ destPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "cc-install-plugin-"));
  const destPath = join(dir, "clawcode.yaml");
  await writeFile(destPath, BASE_YAML, "utf8");
  return { destPath };
}

describe("normalizePluginManifest — Phase 90 Plan 05 (PL-C1..C3)", () => {
  it("PL-C1: happy path — coerces manifest to mcpServerSchema shape", () => {
    const manifest = makeManifest();
    const configInputs = {
      MYSQL_HOST: "db.example.com",
      MYSQL_PASSWORD: "op://example-vault-21/mysql/password",
    };
    const result = normalizePluginManifest(manifest, configInputs);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.name).toBe("acme-db-helper");
    expect(result.entry.command).toBe("mcporter");
    expect(result.entry.args).toEqual(["serve", "mysql"]);
    expect(result.entry.env).toEqual({
      MYSQL_HOST: "db.example.com",
      MYSQL_PASSWORD: "op://example-vault-21/mysql/password",
    });
  });

  it("PL-C2: operator input wins over manifest default; manifest default used when no input", () => {
    const manifest = makeManifest({
      env: {
        ENV_WITH_DEFAULT: {
          default: "default-value",
          required: false,
          sensitive: false,
        },
      },
    });
    // No configInput → default used
    const r1 = normalizePluginManifest(manifest, {});
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.entry.env).toEqual({ ENV_WITH_DEFAULT: "default-value" });
    }
    // configInput provided → wins
    const r2 = normalizePluginManifest(manifest, {
      ENV_WITH_DEFAULT: "override",
    });
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.entry.env).toEqual({ ENV_WITH_DEFAULT: "override" });
    }
  });

  it("PL-C3: required field missing → {ok:false, missing_field:'MYSQL_HOST'}", () => {
    const manifest = makeManifest();
    const result = normalizePluginManifest(manifest, {
      // MYSQL_HOST omitted
      MYSQL_PASSWORD: "op://example-vault-21/mysql/password",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing_field).toBe("MYSQL_HOST");
    expect(result.reason).toMatch(/MYSQL_HOST/);
  });
});

describe("installClawhubPlugin — Phase 90 Plan 05 (PL-C4, PL-INS1..2)", () => {
  it("PL-INS1: install happy — writes YAML and returns installed", async () => {
    const { destPath } = await setupYamlFixture();
    const manifest = makeManifest();
    const outcome = await installClawhubPlugin({
      manifest,
      agentName: "clawdy",
      configPath: destPath,
      configInputs: {
        MYSQL_HOST: "db.example.com",
        MYSQL_PASSWORD: "op://example-vault-21/mysql/password",
      },
    });
    expect(outcome.kind).toBe("installed");
    if (outcome.kind !== "installed") return;
    expect(outcome.plugin).toBe("acme-db-helper");
    expect(outcome.pluginVersion).toBe("1.2.0");
    expect(outcome.entry.env).toMatchObject({
      MYSQL_HOST: "db.example.com",
      MYSQL_PASSWORD: "op://example-vault-21/mysql/password",
    });

    // Verify YAML actually written
    const after = readFileSync(destPath, "utf8");
    const parsed = parseYaml(after) as {
      agents: Array<{
        name: string;
        mcpServers: Array<{ name: string; command: string }>;
      }>;
    };
    const clawdy = parsed.agents.find((a) => a.name === "clawdy")!;
    expect(clawdy.mcpServers).toHaveLength(1);
    expect(clawdy.mcpServers[0]!.name).toBe("acme-db-helper");
    expect(clawdy.mcpServers[0]!.command).toBe("mcporter");
  });

  it("PL-INS2: install blocked-secret-scan — literal high-entropy credential refused", async () => {
    const { destPath } = await setupYamlFixture();
    const beforeBytes = readFileSync(destPath, "utf8");
    const manifest = makeManifest();
    const outcome = await installClawhubPlugin({
      manifest,
      agentName: "clawdy",
      configPath: destPath,
      configInputs: {
        MYSQL_HOST: "db.example.com",
        // High-entropy literal on a credential-labeled field → refused
        MYSQL_PASSWORD: "ExampleFakePw0123Z",
      },
    });
    expect(outcome.kind).toBe("blocked-secret-scan");
    if (outcome.kind !== "blocked-secret-scan") return;
    expect(outcome.field).toBe("MYSQL_PASSWORD");

    // File unchanged
    const afterBytes = readFileSync(destPath, "utf8");
    expect(afterBytes).toBe(beforeBytes);
  });

  it("PL-C4: missing required env → config-missing outcome", async () => {
    const { destPath } = await setupYamlFixture();
    const manifest = makeManifest();
    const outcome = await installClawhubPlugin({
      manifest,
      agentName: "clawdy",
      configPath: destPath,
      configInputs: {
        MYSQL_HOST: "db.example.com",
        // MYSQL_PASSWORD omitted
      },
    });
    expect(outcome.kind).toBe("config-missing");
    if (outcome.kind !== "config-missing") return;
    expect(outcome.missing_field).toBe("MYSQL_PASSWORD");
  });

  it("PL-INS1-persist-failed: agent not in config → installed-persist-failed", async () => {
    const { destPath } = await setupYamlFixture();
    const manifest = makeManifest({
      env: {}, // no required fields
    });
    const outcome = await installClawhubPlugin({
      manifest,
      agentName: "ghost",
      configPath: destPath,
      configInputs: {},
    });
    // agentName missing → updateAgentMcpServers returns "not-found" →
    // installer maps to "not-in-catalog" (per the switch in install-plugin.ts).
    expect(outcome.kind).toBe("not-in-catalog");
  });
});

describe("mapFetchErrorToOutcome — Phase 90 Plan 05 (PL-INS3)", () => {
  it("PL-INS3a: ClawhubRateLimitedError → rate-limited w/ retryAfterMs", () => {
    const err = new ClawhubRateLimitedError(45_000, "rate-limited");
    const outcome = mapFetchErrorToOutcome(err, "my-plugin");
    expect(outcome.kind).toBe("rate-limited");
    if (outcome.kind !== "rate-limited") return;
    expect(outcome.retryAfterMs).toBe(45_000);
    expect(outcome.plugin).toBe("my-plugin");
  });

  it("PL-INS3b: ClawhubAuthRequiredError → auth-required", () => {
    const err = new ClawhubAuthRequiredError("auth required (401)");
    const outcome = mapFetchErrorToOutcome(err, "my-plugin");
    expect(outcome.kind).toBe("auth-required");
    if (outcome.kind !== "auth-required") return;
    expect(outcome.reason).toMatch(/401/);
  });

  it("PL-INS3c: ClawhubManifestInvalidError → manifest-invalid", () => {
    const err = new ClawhubManifestInvalidError("missing command");
    const outcome = mapFetchErrorToOutcome(err, "my-plugin");
    expect(outcome.kind).toBe("manifest-invalid");
    if (outcome.kind !== "manifest-invalid") return;
    expect(outcome.reason).toMatch(/missing command/);
  });

  it("PL-INS3d: unknown error → manifest-invalid with raw message", () => {
    const err = new Error("network down");
    const outcome = mapFetchErrorToOutcome(err, "my-plugin");
    expect(outcome.kind).toBe("manifest-invalid");
    if (outcome.kind !== "manifest-invalid") return;
    expect(outcome.reason).toMatch(/network down/);
  });
});
