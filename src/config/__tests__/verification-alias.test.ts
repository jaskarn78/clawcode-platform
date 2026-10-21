/**
 * 2026-08-26 rename — `financialVerification` → `verification`.
 *
 * WHY THIS SUITE EXISTS. `agentSchema` is NON-STRICT: an unrecognised key
 * is silently dropped, not rejected. So a rename shipped without an alias
 * would NOT crash a prod yaml still saying `financialVerification:` — it
 * would quietly discard the whole block. `streamStatus`/`verifiedBadge`
 * would fall to false and the 999.63b shadow gate would stop evaluating
 * mid-window, with nothing in the log to say so.
 *
 * That is precisely the silent-failure class the gate exists to prevent,
 * so the alias is pinned by tests until prod is confirmed migrated.
 *
 * These go through loadConfig (real YAML), not a hand-built object, because
 * the YAML path is the one prod actually takes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadConfig, resolveAgentConfig } from "../loader.js";

describe("verification / financialVerification alias", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "clawcode-alias-"));
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function load(yamlLines: string[]) {
    const cfgPath = join(tmpDir, "clawcode.yaml");
    await writeFile(cfgPath, yamlLines.join("\n"), "utf-8");
    return (await loadConfig(cfgPath)) as unknown as {
      agents: Parameters<typeof resolveAgentConfig>[0][];
      defaults: Parameters<typeof resolveAgentConfig>[1];
    };
  }

  /** Byte-for-byte the block live on prod at rename time. */
  const LEGACY_YAML = [
    "version: 1",
    "agents:",
    "  - name: fin-client",
    "    financialVerification:",
    "      ux:",
    "        streamStatus: true",
    "        verifiedBadge: true",
    "",
  ];
  const NEW_YAML = LEGACY_YAML.map((l) =>
    l.replace("financialVerification:", "verification:"),
  );

  it("the live prod block still resolves under the legacy key", async () => {
    const { agents, defaults } = await load(LEGACY_YAML);
    const resolved = resolveAgentConfig(agents[0]!, defaults);
    // The whole point: NOT undefined, and carrying the operator's values.
    expect(resolved.verification).toBeDefined();
    expect(resolved.verification?.ux?.streamStatus).toBe(true);
    expect(resolved.verification?.ux?.verifiedBadge).toBe(true);
  });

  it("legacy and new keys resolve identically", async () => {
    const legacy = await load(LEGACY_YAML);
    const fresh = await load(NEW_YAML);
    expect(
      resolveAgentConfig(legacy.agents[0]!, legacy.defaults).verification,
    ).toEqual(
      resolveAgentConfig(fresh.agents[0]!, fresh.defaults).verification,
    );
  });

  it("the canonical key wins when a yaml carries both", async () => {
    const { agents, defaults } = await load([
      "version: 1",
      "agents:",
      "  - name: fin-client",
      "    financialVerification:",
      "      ux:",
      "        streamStatus: false",
      "    verification:",
      "      ux:",
      "        streamStatus: true",
      "",
    ]);
    expect(
      resolveAgentConfig(agents[0]!, defaults).verification?.ux?.streamStatus,
    ).toBe(true);
  });

  it("the alias works on the fleet-defaults surface too", async () => {
    const { agents, defaults } = await load([
      "version: 1",
      "defaults:",
      "  financialVerification:",
      "    ux:",
      "      streamStatus: true",
      "agents:",
      "  - name: any-agent",
      "",
    ]);
    expect(
      resolveAgentConfig(agents[0]!, defaults).verification?.ux?.streamStatus,
    ).toBe(true);
  });
});
