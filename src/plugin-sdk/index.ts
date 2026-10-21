/**
 * Phase 130 — `src/plugin-sdk/` package barrel.
 *
 * Public surface for skill + MCP-tool manifest authoring. Plan 02 wires
 * the daemon-side loader chokepoint that consumes these schemas; this
 * package is intentionally additive and runtime-independent.
 */
export { defineSkill } from "./define-skill.js";
export { defineMCPTool } from "./define-mcp-tool.js";
export {
  SkillManifestSchema,
  MCPToolManifestSchema,
  type SkillManifest,
  type MCPToolManifest,
} from "./manifest-schema.js";
export {
  CAPABILITY_VOCABULARY,
  type Capability,
} from "./capability-vocabulary.js";
