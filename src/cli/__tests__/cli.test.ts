import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile, access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as yamlStringify } from "yaml";
import { initAction } from "../index.js";
import { loadConfig } from "../../config/loader.js";
import { resolveAllAgents } from "../../config/loader.js";
import { createWorkspaces } from "../../agent/workspace.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "clawcode-cli-test-"));
  tempDirs.push(dir);
  return dir;
}

function makeValidConfig(tmpDir: string) {
  return {
    version: 1,
    defaults: {
      model: "sonnet",
      skills: [],
      basePath: join(tmpDir, "agents"),
    },
    agents: [
      { name: "alpha", channels: ["123"], skills: [] },
      { name: "beta", channels: ["456"], skills: [] },
    ],
  };
}

async function writeConfig(dir: string, config: unknown): Promise<string> {
  const configPath = join(dir, "clawcode.yaml");
  await writeFile(configPath, yamlStringify(config), "utf-8");
  return configPath;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs.length = 0;
});

describe("initAction", () => {
  it("creates workspace directories for each agent with valid config", async () => {
    const tmp = await makeTempDir();
    const config = makeValidConfig(tmp);
    const configPath = await writeConfig(tmp, config);

    await initAction({ config: configPath });

    // Both workspace directories should exist
    await expect(access(join(tmp, "agents", "alpha"))).resolves.toBeUndefined();
    await expect(access(join(tmp, "agents", "beta"))).resolves.toBeUndefined();
  });

  it("writes SOUL.md and IDENTITY.md into each workspace", async () => {
    const tmp = await makeTempDir();
    const config = makeValidConfig(tmp);
    const configPath = await writeConfig(tmp, config);

    await initAction({ config: configPath });

    for (const name of ["alpha", "beta"]) {
      const wsPath = join(tmp, "agents", name);
      await expect(access(join(wsPath, "SOUL.md"))).resolves.toBeUndefined();
      await expect(access(join(wsPath, "IDENTITY.md"))).resolves.toBeUndefined();
    }
  });

  it("creates memory/ and skills/ subdirectories in each workspace", async () => {
    const tmp = await makeTempDir();
    const config = makeValidConfig(tmp);
    const configPath = await writeConfig(tmp, config);

    await initAction({ config: configPath });

    for (const name of ["alpha", "beta"]) {
      const wsPath = join(tmp, "agents", name);
      await expect(access(join(wsPath, "memory"))).resolves.toBeUndefined();
      await expect(access(join(wsPath, "skills"))).resolves.toBeUndefined();
    }
  });

  it("IDENTITY.md contains the agent's name", async () => {
    const tmp = await makeTempDir();
    const config = makeValidConfig(tmp);
    const configPath = await writeConfig(tmp, config);

    await initAction({ config: configPath });

    const alphaIdentity = await readFile(join(tmp, "agents", "alpha", "IDENTITY.md"), "utf-8");
    expect(alphaIdentity).toContain("alpha");

    const betaIdentity = await readFile(join(tmp, "agents", "beta", "IDENTITY.md"), "utf-8");
    expect(betaIdentity).toContain("beta");
  });

  it("throws ConfigFileNotFoundError for missing config file", async () => {
    await expect(
      initAction({ config: "/nonexistent/path/clawcode.yaml" }),
    ).rejects.toThrow("Config file not found");
  });

  it("throws ConfigValidationError for invalid config (missing version)", async () => {
    const tmp = await makeTempDir();
    const invalidConfig = { agents: [{ name: "test", channels: ["1"] }] };
    const configPath = await writeConfig(tmp, invalidConfig);

    await expect(initAction({ config: configPath })).rejects.toThrow(
      "Config validation failed",
    );
  });

  it("--dry-run does NOT create any directories", async () => {
    const tmp = await makeTempDir();
    const config = makeValidConfig(tmp);
    const configPath = await writeConfig(tmp, config);

    await initAction({ config: configPath, dryRun: true });

    // Workspace directories should NOT exist
    await expect(access(join(tmp, "agents", "alpha"))).rejects.toThrow();
    await expect(access(join(tmp, "agents", "beta"))).rejects.toThrow();
  });
});

describe("full pipeline (programmatic)", () => {
  it("loadConfig -> resolveAllAgents -> createWorkspaces produces correct WorkspaceResult[]", async () => {
    const tmp = await makeTempDir();
    const rawConfig = makeValidConfig(tmp);
    const configPath = await writeConfig(tmp, rawConfig);

    const config = await loadConfig(configPath);
    const agents = resolveAllAgents(config);
    const results = await createWorkspaces(agents);

    expect(results).toHaveLength(2);
    expect(results[0].agentName).toBe("alpha");
    expect(results[1].agentName).toBe("beta");
    expect(results[0].path).toBe(join(tmp, "agents", "alpha"));
    expect(results[1].path).toBe(join(tmp, "agents", "beta"));

    // Verify files actually exist
    await expect(access(join(tmp, "agents", "alpha", "SOUL.md"))).resolves.toBeUndefined();
    await expect(access(join(tmp, "agents", "beta", "IDENTITY.md"))).resolves.toBeUndefined();
  });
});
