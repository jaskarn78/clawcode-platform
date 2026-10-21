/**
 * Phase 130 — `defineMCPTool` helper.
 *
 * Parallel to `defineSkill` for MCP-server-side manifests
 * (`mcp-manifest.json`). Same structured-error UX.
 *
 * See `.planning/phases/130-manifest-driven-plugin-sdk/130-CONTEXT.md` D-01a.
 */
import {
  MCPToolManifestSchema,
  type MCPToolManifest,
} from "./manifest-schema.js";

export function defineMCPTool(manifest: MCPToolManifest): MCPToolManifest {
  const result = MCPToolManifestSchema.safeParse(manifest);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid MCP tool manifest:\n${issues}`);
  }
  return result.data;
}
