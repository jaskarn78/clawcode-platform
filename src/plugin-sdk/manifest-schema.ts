/**
 * Phase 130 — Zod manifest schemas for skills and MCP tools.
 *
 * Skills carry YAML frontmatter at the top of `SKILL.md` that parses against
 * `SkillManifestSchema`. MCP tools (optional this phase) carry a parallel
 * `mcp-manifest.json` validated by `MCPToolManifestSchema`.
 *
 * See `.planning/phases/130-manifest-driven-plugin-sdk/130-CONTEXT.md` D-01,
 * D-01a, D-04a.
 */
import { z } from "zod";
import { CAPABILITY_VOCABULARY } from "./capability-vocabulary.js";

/** Kebab-case identifier — `^[a-z][a-z0-9-]*$`. */
const KEBAB_CASE = /^[a-z][a-z0-9-]*$/;

/** Strict semver `M.m.p`. Pre-release / build metadata intentionally rejected
 *  this phase — keep manifest versions boring. */
const SEMVER = /^\d+\.\d+\.\d+$/;

/** Owner = kebab-case agent name OR literal `"*"` for fleet-wide skills. */
const OWNER = z.union([
  z.literal("*"),
  z.string().regex(KEBAB_CASE, "owner must be kebab-case agent name or '*'"),
]);

/** Capability enum derived from `CAPABILITY_VOCABULARY`. */
const CapabilitySchema = z.enum(CAPABILITY_VOCABULARY);

export const SkillManifestSchema = z.object({
  name: z.string().regex(KEBAB_CASE, "skill name must be kebab-case"),
  description: z.string().min(1, "description required"),
  version: z.string().regex(SEMVER, "version must be semver M.m.p"),
  owner: OWNER,
  capabilities: z.array(CapabilitySchema).default([]),
  requiredTools: z.array(z.string()).default([]),
  requiredMcpServers: z.array(z.string()).default([]),
  /**
   * Phase 999.42 D7a — fingerprint12 of the trajectory that produced this
   * skill; written by approveDraft. Optional — pre-999.42 and hand-authored
   * skills omit it and do not participate in patch-suggest (D7).
   */
  originatingFingerprint: z.string().optional(),
});

export type SkillManifest = z.infer<typeof SkillManifestSchema>;

export const MCPToolManifestSchema = SkillManifestSchema.extend({
  /** MCP server name this tool lives in (when defined alongside the server). */
  mcpServer: z.string().optional(),
});

export type MCPToolManifest = z.infer<typeof MCPToolManifestSchema>;
