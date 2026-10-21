/**
 * Phase 103 OBS-07 — slash-command-cap regression test (Pitfall 6).
 *
 * Discord enforces a hard 100-per-guild limit on application commands.
 * As ClawCode grows new operator surfaces, the cumulative
 * CONTROL_COMMANDS + DEFAULT_SLASH_COMMANDS budget must stay under 90 to
 * leave headroom for per-agent custom commands defined in clawcode.yaml
 * (each agent can register up to 10 extras before the 100-cap fires).
 *
 * Also pins:
 *   - `clawcode-usage` is registered as a CONTROL_COMMAND (daemon-routed)
 *   - Its ipcMethod is the new `list-rate-limit-snapshots` (Pitfall 5
 *     closure — does NOT collide with existing `rate-limit-status`)
 */
import { describe, it, expect } from "vitest";
import {
  CONTROL_COMMANDS,
  DEFAULT_SLASH_COMMANDS,
  GSD_SLASH_COMMANDS,
} from "../slash-types.js";

describe("Discord slash command count (Pitfall 6)", () => {
  it("CONTROL_COMMANDS + DEFAULT_SLASH_COMMANDS total stays under 90", () => {
    const total = CONTROL_COMMANDS.length + DEFAULT_SLASH_COMMANDS.length;
    expect(total).toBeLessThanOrEqual(90);
  });

  it("CONTROL_COMMANDS + DEFAULT + GSD total stays under 100 (Discord guild cap)", () => {
    const total =
      CONTROL_COMMANDS.length +
      DEFAULT_SLASH_COMMANDS.length +
      GSD_SLASH_COMMANDS.length;
    expect(total).toBeLessThanOrEqual(100);
  });

  it("clawcode-usage is registered as CONTROL_COMMAND with list-rate-limit-snapshots IPC", () => {
    const entry = CONTROL_COMMANDS.find((c) => c.name === "clawcode-usage");
    expect(entry).toBeDefined();
    expect(entry?.ipcMethod).toBe("list-rate-limit-snapshots");
    expect(entry?.control).toBe(true);
  });

  it("clawcode-usage has an optional 'agent' option", () => {
    const entry = CONTROL_COMMANDS.find((c) => c.name === "clawcode-usage");
    const agentOpt = entry?.options.find((o) => o.name === "agent");
    expect(agentOpt).toBeDefined();
    expect(agentOpt?.required).toBe(false);
  });
});
