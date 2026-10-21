import { describe, it, expect } from "vitest";
import { agentSchema, defaultsSchema } from "../schema.js";

/**
 * 999.106 QW-2 (worker diet) — guards the inert-knob failure mode for
 * `defaults.workflow.worker.mcpServers`.
 *
 * The knob's contract is three-state and ABSENCE IS MEANINGFUL:
 *   absent      → workflow workers inherit the parent's full MCP roster
 *                 (pre-QW-2 behavior; the safe first-deploy default)
 *   `[]`        → tool-free workers fleet-wide
 *   `[names…]`  → fail-closed allowlist (∩ parent roster at spawn)
 *
 * There is deliberately NO zod .default() — so unlike the sibling workflow
 * knobs there is no schema/daemon-`??` pair to drift. This test pins all
 * three states surviving the parse, and that the sibling knob defaults are
 * untouched by the new nested object.
 */
describe("defaults.workflow.worker.mcpServers (999.106 QW-2)", () => {
  const workflowSchema = defaultsSchema.shape.workflow;

  it("absent worker block parses to undefined (inherit)", () => {
    const parsed = workflowSchema.parse({});
    expect(parsed?.worker).toBeUndefined();
  });

  it("keeps an explicit empty list (tool-free workers)", () => {
    const parsed = workflowSchema.parse({ worker: { mcpServers: [] } });
    expect(parsed?.worker?.mcpServers).toEqual([]);
  });

  it("keeps a named allowlist verbatim", () => {
    const parsed = workflowSchema.parse({
      worker: { mcpServers: ["search", "gworkspace"] },
    });
    expect(parsed?.worker?.mcpServers).toEqual(["search", "gworkspace"]);
  });

  it("rejects non-string entries rather than coercing", () => {
    expect(() =>
      workflowSchema.parse({ worker: { mcpServers: [42] } }),
    ).toThrow();
  });

  it("does not disturb the sibling knob defaults", () => {
    const parsed = workflowSchema.parse({ worker: { mcpServers: [] } });
    expect(parsed?.maxConcurrentWorkers).toBe(3);
    expect(parsed?.memoryHighWatermarkPercent).toBe(85);
    expect(parsed?.admissionTimeoutMs).toBe(3_600_000);
  });
});
