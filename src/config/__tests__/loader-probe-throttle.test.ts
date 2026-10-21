import { describe, it, expect } from "vitest";
import { mcpServerSchema } from "../schema.js";

/**
 * INC-2026-08-11 — guards the inert-knob failure mode.
 *
 * `minProbeIntervalMs` has to be carried in THREE places to work: this zod
 * schema, `ResolvedAgentConfig.mcpServers[]` in shared/types.ts, and an
 * explicit spread in loader.ts (which copies mcpServer fields one at a time).
 * Miss any one and the knob parses, validates, and is silently dropped — the
 * throttle would never engage and nothing would report an error.
 */
describe("mcpServerSchema.minProbeIntervalMs", () => {
  const base = { name: "browser", command: "x", args: [] };

  it("keeps a configured interval", () => {
    expect(mcpServerSchema.parse({ ...base, minProbeIntervalMs: 900_000 }).minProbeIntervalMs).toBe(
      900_000,
    );
  });

  it("is undefined when omitted — the fleet default is probe every tick", () => {
    expect(mcpServerSchema.parse(base).minProbeIntervalMs).toBeUndefined();
  });

  it("rejects a negative interval rather than coercing it", () => {
    expect(() => mcpServerSchema.parse({ ...base, minProbeIntervalMs: -1 })).toThrow();
  });

  it("rejects a non-integer", () => {
    expect(() => mcpServerSchema.parse({ ...base, minProbeIntervalMs: 1.5 })).toThrow();
  });
});
