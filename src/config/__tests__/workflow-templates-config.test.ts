/**
 * Phase 999.128 — workflow templates parse from config and resolve per agent
 * (fleet templates merged with per-agent ones, agent wins by name).
 */

import { describe, it, expect } from "vitest";
import { agentSchema, defaultsSchema } from "../schema.js";
import { resolveAgentConfig } from "../loader.js";

describe("workflow templates in config", () => {
  it("parses fleet + agent templates and merges them by name in the resolved config", () => {
    const defaults = defaultsSchema.parse({
      workflow: {
        templates: [
          {
            name: "market-scan",
            description: "Weekly scan",
            params: [{ name: "ticker" }, { name: "horizon", default: "1 week" }],
            waves: [[{ stepId: "news-{{ticker}}", prompt: "News on {{ticker}} over {{horizon}}." }], [{ stepId: "synth", prompt: "Combine for {{ticker}}." }]],
          },
          { name: "audit", steps: [{ stepId: "a", prompt: "fleet audit" }] },
        ],
      },
    });
    const agent = agentSchema.parse({
      name: "fin-research",
      channels: [],
      workflowTemplates: [{ name: "audit", steps: [{ stepId: "a", prompt: "agent audit", mcpServers: ["search"] }] }],
    });
    const resolved = resolveAgentConfig(agent, defaults);
    expect(resolved.workflowTemplates?.map((t) => t.name)).toEqual(["audit", "market-scan"]);
    expect(resolved.workflowTemplates?.[0]?.steps?.[0]).toEqual({ stepId: "a", prompt: "agent audit", mcpServers: ["search"] });
    expect(resolved.workflowTemplates?.[1]?.params?.[1]).toEqual({ name: "horizon", default: "1 week" });
  });

  it("rejects malformed templates at parse time", () => {
    expect(() =>
      defaultsSchema.parse({ workflow: { templates: [{ name: "bad name", steps: [{ stepId: "a", prompt: "x" }] }] } }),
    ).toThrow();
    expect(() =>
      defaultsSchema.parse({ workflow: { templates: [{ name: "too-wide", steps: Array.from({ length: 9 }, (_, i) => ({ stepId: `s${i}`, prompt: "x" })) }] } }),
    ).toThrow();
  });

  it("an agent with no templates anywhere resolves to an empty list", () => {
    const resolved = resolveAgentConfig(agentSchema.parse({ name: "plain", channels: [] }), defaultsSchema.parse({}));
    expect(resolved.workflowTemplates).toEqual([]);
  });
});
