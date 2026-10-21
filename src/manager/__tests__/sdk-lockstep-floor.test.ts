/**
 * Phase 999.169 SC-4 — CI fails a build whose declared version cannot serve the
 * catalog, or whose installed binary is not the SDK's matched CLI.
 *
 * Runs against the REAL install (`npm ci` output), not a fixture: the exact SDK
 * pin in package.json is the one declaration, and this proves what it resolves to.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MODEL_ALIAS_CATALOG, type ModelAliasSpec } from "../../shared/model-catalog.js";
import { cliVersionSatisfies } from "../../shared/cli-version.js";
import { probeFleetBinary, readClaudeBinaryOverride, readInstalledSdk } from "../../shared/claude-binary.js";
import { checkClaudeBinaryLockstep } from "../cli-version-guard.js";

const sdk = readInstalledSdk();

describe("999.169 — the declared SDK serves every model and ships its matched binary", () => {
  it("package.json pins the SDK exactly (no range — the pin IS the declared CLI version)", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["@anthropic-ai/claude-agent-sdk"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(sdk?.version).toBe(pkg.dependencies["@anthropic-ai/claude-agent-sdk"]);
  });

  it("the installed SDK declares its matched CLI", () => {
    expect(sdk?.claudeCodeVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("that CLI satisfies every catalog minCliVersion", () => {
    const catalog: Readonly<Record<string, ModelAliasSpec>> = MODEL_ALIAS_CATALOG;
    const unmet = Object.entries(catalog)
      .filter(([, spec]) => spec.minCliVersion !== undefined)
      .filter(([, spec]) => cliVersionSatisfies(sdk!.claudeCodeVersion!, spec.minCliVersion!) === false)
      .map(([alias, spec]) => `${alias} needs ${spec.minCliVersion}`);
    expect(unmet).toEqual([]);
  });

  it.skipIf(readClaudeBinaryOverride() !== undefined)(
    "the bundled binary actually installed reports exactly that version (lockstep ok)",
    () => {
      const verdict = checkClaudeBinaryLockstep(probeFleetBinary());
      expect(verdict).toMatchObject({ kind: "ok" });
    },
  );
});
