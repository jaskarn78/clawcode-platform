/**
 * Phase 130 Plan 02 T-05 — migrated fleet-wide skill validation.
 *
 * Loops the 6 fleet-wide skills under `~/.clawcode/skills/` (back-filled
 * by T-05) and asserts each loads cleanly through the Plan 02 chokepoint
 * with `status === "loaded"`. None declare `requiredMcpServers`, so an
 * empty `enabledMcpServers` argument is sufficient.
 *
 * Skipped automatically when `~/.clawcode/skills/` is absent (CI envs
 * without the production layout). This keeps the test as a local-only
 * post-migration sanity check without breaking CI.
 *
 * See `.planning/phases/130-manifest-driven-plugin-sdk/admin-clawdy-skills-inventory.md`
 * for the migration audit.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadSkillManifest } from "../skill-loader.js";

const FLEET_SKILLS_DIR = path.join(os.homedir(), ".clawcode", "skills");
const MIGRATED_SKILLS = [
  "frontend-design",
  "new-reel",
  "new-reel-v2",
  "self-improving-agent",
  "subagent-thread",
  "tuya-ac",
];

const fleetDirExists = fs.existsSync(FLEET_SKILLS_DIR);

describe.skipIf(!fleetDirExists)(
  "Phase 130 Plan 02 T-05 — migrated fleet-wide skills load cleanly",
  () => {
    for (const skillName of MIGRATED_SKILLS) {
      it(`${skillName} loads with status="loaded"`, () => {
        // Silence the structured logs so test output stays clean.
        vi.spyOn(console, "info").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});

        const skillDir = path.join(FLEET_SKILLS_DIR, skillName);
        if (!fs.existsSync(skillDir)) {
          // Skill not present in this environment — skip individually.
          // (Operators with a partial fleet shouldn't see false failures.)
          return;
        }

        const result = loadSkillManifest(skillDir, []);
        if (result.status !== "loaded") {
          const detail =
            result.status === "refused-mcp-missing"
              ? ` missingMcp=${result.missingMcp.join(",")}`
              : result.status === "parse-error"
                ? ` reason=${result.reason}`
                : "";
          throw new Error(
            `expected ${skillName} to load with status="loaded", got "${result.status}"${detail}`,
          );
        }
        expect(result.manifest.name).toBeTruthy();
        expect(result.manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(Array.isArray(result.manifest.capabilities)).toBe(true);
        expect(result.manifest.requiredMcpServers).toEqual([]);
      });
    }
  },
);
