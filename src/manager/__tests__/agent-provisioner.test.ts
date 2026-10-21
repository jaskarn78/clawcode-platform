import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { provisionAgent, validateAgentName } from "../agent-provisioner.js";

describe("validateAgentName", () => {
  it("accepts lowercase alphanumeric with hyphens", () => {
    expect(() => validateAgentName("scout")).not.toThrow();
    expect(() => validateAgentName("research-bot")).not.toThrow();
    expect(() => validateAgentName("agent-42")).not.toThrow();
  });

  it("rejects names with uppercase, spaces, or invalid chars", () => {
    expect(() => validateAgentName("Scout")).toThrow();
    expect(() => validateAgentName("my agent")).toThrow();
    expect(() => validateAgentName("agent_one")).toThrow();
    expect(() => validateAgentName("2fast")).toThrow();
  });

  it("rejects names outside length bounds", () => {
    expect(() => validateAgentName("a")).toThrow();
    expect(() => validateAgentName("x".repeat(33))).toThrow();
  });
});

describe("provisionAgent", () => {
  let tmpDir: string;
  let configPath: string;
  let agentsBasePath: string;

  beforeEach(async () => {
    // node:fs/promises mkdir with `recursive: true` returns the first
    // directory path created, OR undefined if every path already exists.
    // Build the path eagerly and pass it to mkdir so we always have a value.
    tmpDir = join(tmpdir(), `clawcode-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    configPath = join(tmpDir, "clawcode.yaml");
    agentsBasePath = join(tmpDir, "agents");

    const seed = `version: 1
# Comment above defaults — must survive append
defaults:
  model: sonnet
agents:
  - name: existing-agent
    channels:
      - "111"
    model: sonnet
`;
    await writeFile(configPath, seed, "utf-8");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("appends a new agent entry to the config's agents sequence", async () => {
    const result = await provisionAgent(
      { name: "new-agent", soul: "You are helpful.", channelId: "999", model: "opus" },
      { configPath, agentsBasePath },
    );

    expect(result.name).toBe("new-agent");
    expect(result.model).toBe("opus");
    expect(result.channelId).toBe("999");

    const raw = await readFile(configPath, "utf-8");
    const parsed = parseYaml(raw) as { agents: Array<{ name: string; channels: string[]; model: string }> };
    expect(parsed.agents).toHaveLength(2);
    const added = parsed.agents.find((a) => a.name === "new-agent");
    expect(added).toEqual({ name: "new-agent", channels: ["999"], model: "opus" });
  });

  it("preserves comments in the yaml file", async () => {
    await provisionAgent(
      { name: "scout", soul: "Curious explorer.", channelId: "42" },
      { configPath, agentsBasePath },
    );

    const raw = await readFile(configPath, "utf-8");
    expect(raw).toContain("# Comment above defaults — must survive append");
  });

  it("writes SOUL.md to the new agent's workspace", async () => {
    await provisionAgent(
      { name: "scout", soul: "Curious explorer.\nAsks good questions.", channelId: "42" },
      { configPath, agentsBasePath },
    );

    const soulPath = join(agentsBasePath, "scout", "SOUL.md");
    const content = await readFile(soulPath, "utf-8");
    expect(content).toContain("Curious explorer.");
    expect(content).toContain("Asks good questions.");
  });

  it("rejects a duplicate agent name", async () => {
    await expect(
      provisionAgent(
        { name: "existing-agent", soul: "Another one.", channelId: "999" },
        { configPath, agentsBasePath },
      ),
    ).rejects.toThrow(/already exists/);
  });

  it("rejects invalid model", async () => {
    await expect(
      provisionAgent(
        { name: "x-agent", soul: "Hi.", channelId: "1", model: "gpt-5" },
        { configPath, agentsBasePath },
      ),
    ).rejects.toThrow(/Invalid model/);
  });

  it("rejects empty soul", async () => {
    await expect(
      provisionAgent(
        { name: "x-agent", soul: "   ", channelId: "1" },
        { configPath, agentsBasePath },
      ),
    ).rejects.toThrow(/soul is required/);
  });

  it("defaults model to sonnet when not specified", async () => {
    const result = await provisionAgent(
      { name: "quiet-one", soul: "Listens.", channelId: "7" },
      { configPath, agentsBasePath },
    );
    expect(result.model).toBe("sonnet");
  });
});
