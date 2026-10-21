/**
 * Phase 135 Plan 03 Task 1 — voice key op:// resolution tests.
 *
 * Pins the loader-side contract for `resolveVoiceKey` and the
 * `resolveAgentConfig`-level integration that flows resolved values
 * into `ResolvedAgentConfig.voice.{deepgramKey, elevenLabsKey}`.
 *
 * Cases:
 *   - LV-1: literal value → passthrough.
 *   - LV-2: op:// URI + resolver → resolved value.
 *   - LV-3: op:// URI + no resolver → passthrough (offline tools).
 *   - LV-4: op:// URI + resolver that throws → loud fail with agent +
 *           field name in the error message.
 *   - LV-5: full `resolveAllAgents` integration via on-disk yaml — both
 *           voice keys land on `ResolvedAgentConfig.voice` as resolved
 *           values.
 *   - LV-6: agent without a voice block → `voice: undefined`.
 *   - LV-7: bad op:// reference at agent boot throws with agent + field
 *           context (loud-fail per Phase 999.10).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveVoiceKey, resolveAllAgents, loadConfig } from "../loader.js";

describe("resolveVoiceKey — Phase 135 Plan 03 op:// resolution", () => {
  it("LV-1: literal value passes through unchanged", () => {
    const result = resolveVoiceKey("sk-literal-key", () => "should-not-be-called", {
      agentName: "agent-x",
      fieldName: "deepgramKey",
    });
    expect(result).toBe("sk-literal-key");
  });

  it("LV-2: op:// URI with resolver returns resolved value", () => {
    const result = resolveVoiceKey(
      "op://example-vault/dg/credential",
      (ref) => `RESOLVED::${ref}`,
      { agentName: "agent-x", fieldName: "deepgramKey" },
    );
    expect(result).toBe("RESOLVED::op://example-vault/dg/credential");
  });

  it("LV-3: op:// URI with no resolver passes through (test/offline tools)", () => {
    const result = resolveVoiceKey("op://example-vault/dg/credential", undefined, {
      agentName: "agent-x",
      fieldName: "deepgramKey",
    });
    expect(result).toBe("op://example-vault/dg/credential");
  });

  it("LV-4: resolver throw produces a contextual error (agent + field in message)", () => {
    expect(() =>
      resolveVoiceKey(
        "op://example-vault/missing/item",
        () => {
          throw new Error("not found in vault");
        },
        { agentName: "fin-client", fieldName: "elevenLabsKey" },
      ),
    ).toThrow(/agents\[fin-client\]\.voice\.elevenLabsKey/);
  });
});

describe("resolveAllAgents — voice keys flow through op:// resolution", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "voice-resolve-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function loadFromYaml(yaml: string) {
    const configPath = join(tempDir, "clawcode.yaml");
    await writeFile(configPath, yaml, "utf-8");
    return loadConfig(configPath);
  }

  it("LV-5: voice keys are op:// resolved before reaching ResolvedAgentConfig.voice", async () => {
    const yaml = `version: 1
agents:
  - name: agent-voice
    workspace: ${join(tempDir, "agent-voice")}
    channels: []
    voice:
      channelId: "vc-1"
      deepgramKey: "op://example-vault/dg/credential"
      elevenLabsKey: "op://example-vault/el/credential"
      voiceId: "voice-x"
`;
    const config = await loadFromYaml(yaml);
    const resolved = resolveAllAgents(config, (ref) => `RESOLVED::${ref}`);

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.voice).toBeDefined();
    expect(resolved[0]?.voice?.deepgramKey).toBe("RESOLVED::op://example-vault/dg/credential");
    expect(resolved[0]?.voice?.elevenLabsKey).toBe("RESOLVED::op://example-vault/el/credential");
    expect(resolved[0]?.voice?.voiceId).toBe("voice-x");
    expect(resolved[0]?.voice?.channelId).toBe("vc-1");
  });

  it("LV-6: agent without voice block → ResolvedAgentConfig.voice is undefined", async () => {
    const yaml = `version: 1
agents:
  - name: agent-no-voice
    workspace: ${join(tempDir, "agent-no-voice")}
    channels: []
`;
    const config = await loadFromYaml(yaml);
    const resolved = resolveAllAgents(config, (ref) => `RESOLVED::${ref}`);

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.voice).toBeUndefined();
  });

  it("LV-7: bad op:// reference at agent boot throws with agent + field context", async () => {
    const yaml = `version: 1
agents:
  - name: agent-voice
    workspace: ${join(tempDir, "agent-voice")}
    channels: []
    voice:
      channelId: "vc-1"
      deepgramKey: "op://example-vault/bad/ref"
      elevenLabsKey: "literal-key"
      voiceId: "voice-x"
`;
    const config = await loadFromYaml(yaml);

    expect(() =>
      resolveAllAgents(config, () => {
        throw new Error("op read returned non-zero");
      }),
    ).toThrow(/agents\[agent-voice\]\.voice\.deepgramKey/);
  });

  it("LV-8 (WS-A9): with a degradation handler, a failing voice key disables voice and does NOT throw", async () => {
    // INC-2026-06-04 — after the op cap blew, the voice loud-fail was the
    // SECONDARY crash mode (14 boots). With the daemon-boot degradation handler
    // present, voice must degrade (disabled) so the daemon boots, never crash.
    const yaml = `version: 1
agents:
  - name: agent-voice
    workspace: ${join(tempDir, "agent-voice")}
    channels: []
    voice:
      channelId: "vc-1"
      deepgramKey: "op://example-vault/bad/ref"
      elevenLabsKey: "literal-key"
      voiceId: "voice-x"
`;
    const config = await loadFromYaml(yaml);
    const degraded: Array<{ agent: string; server: string; message: string }> =
      [];
    const resolved = resolveAllAgents(
      config,
      () => {
        throw new Error("op read rate-limited");
      },
      (info) => degraded.push(info),
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.voice).toBeUndefined(); // voice disabled → daemon boots
    expect(degraded).toHaveLength(1);
    expect(degraded[0]?.server).toBe("voice");
    expect(degraded[0]?.message).toMatch(/agents\[agent-voice\]\.voice\.deepgramKey/);
  });
});
