/**
 * Quick 260715-j1j review CR-02 — full-config validation on the patch-agent
 * write path.
 *
 * The daemon's `update-agent-config` IPC pre-validates the PARTIAL with
 * `agentSchema.partial()`, which cannot see cross-field superRefine
 * invariants on configSchema (D7: `effort: ultracode` requires
 * `nativeWorkflow: true` on the same agent). Pre-CR-02, a dashboard save of
 * `effort: ultracode` onto a non-opted agent wrote a YAML that the chokidar
 * reload rejects AND the next daemon boot fails on (`loadConfig` throws →
 * fleet down) while the operator saw a success toast.
 *
 * Pinned here:
 *   - patching effort:ultracode onto an agent WITHOUT nativeWorkflow →
 *     outcome "invalid" carrying the D7 message, and the YAML on disk is
 *     BYTE-IDENTICAL (nothing written, no tmp leak);
 *   - the same patch onto an agent WITH nativeWorkflow: true → "updated";
 *   - a normal effort patch is unaffected (back-compat).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { patchAgentInYaml } from "../yaml-patcher.js";

const BASE_YAML = `version: 1
agents:
  - name: power-agent
    channels: ["1234567890123456"]
    model: opus
    effort: high
  - name: opted-agent
    channels: ["6543210987654321"]
    model: opus
    effort: high
    nativeWorkflow: true
`;

describe("quick 260715-j1j CR-02 — patchAgentInYaml full-config validation", () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "yaml-patcher-cr02-"));
    configPath = join(tempDir, "clawcode.yaml");
    await writeFile(configPath, BASE_YAML, "utf8");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("rejects effort:ultracode onto a non-opted agent — outcome 'invalid', YAML on disk unchanged, no tmp leak", async () => {
    const result = await patchAgentInYaml({
      existingConfigPath: configPath,
      agentName: "power-agent",
      partial: { effort: "ultracode" },
    });
    expect(result.outcome).toBe("invalid");
    if (result.outcome === "invalid") {
      expect(result.reason).toMatch(/ultracode requires nativeWorkflow: true/);
    }
    // Nothing written: on-disk bytes are identical to the pre-patch file.
    const onDisk = await readFile(configPath, "utf8");
    expect(onDisk).toBe(BASE_YAML);
    // No leaked .tmp sibling (validation runs BEFORE any write).
    const files = await readdir(tempDir);
    expect(files.filter((f) => f.includes(".tmp"))).toHaveLength(0);
  });

  it("accepts effort:ultracode onto an agent that already carries nativeWorkflow: true", async () => {
    const result = await patchAgentInYaml({
      existingConfigPath: configPath,
      agentName: "opted-agent",
      partial: { effort: "ultracode" },
    });
    expect(result.outcome).toBe("updated");
    const onDisk = await readFile(configPath, "utf8");
    expect(onDisk).toContain("effort: ultracode");
  });

  it("back-compat: a plain effort patch on a non-opted agent still writes", async () => {
    const result = await patchAgentInYaml({
      existingConfigPath: configPath,
      agentName: "power-agent",
      partial: { effort: "max" },
    });
    expect(result.outcome).toBe("updated");
    const onDisk = await readFile(configPath, "utf8");
    expect(onDisk).toContain("effort: max");
  });

  it("catches OTHER configSchema.superRefine invariants too (memoryPath conflict)", async () => {
    // The CR-02 fix is deliberately general: ANY cross-field invariant a
    // partial parse cannot see must reject pre-write. memoryPath collision
    // is the oldest superRefine check — pin it as the representative.
    await patchAgentInYaml({
      existingConfigPath: configPath,
      agentName: "power-agent",
      partial: { memoryPath: "/tmp/shared-mem" },
    });
    const result = await patchAgentInYaml({
      existingConfigPath: configPath,
      agentName: "opted-agent",
      partial: { memoryPath: "/tmp/shared-mem" },
    });
    expect(result.outcome).toBe("invalid");
    if (result.outcome === "invalid") {
      expect(result.reason).toMatch(/memoryPath conflict/);
    }
  });
});
