/**
 * Phase 62 Plan 01 — Zod schemas for policy YAML shape.
 *
 * Defines the declarative policy DSL: PolicyFile -> PolicyRule[] with
 * source filters, throttle config, priority, and enabled flags.
 * Used by policy-loader.ts for boot-time and hot-reload validation.
 */

import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// PolicySource — glob-style source filter (optional per rule)
// ---------------------------------------------------------------------------

export const PolicySourceSchema = z.object({
  kind: z.string().optional(),
  id: z.string().optional(),
});

export type PolicySource = z.infer<typeof PolicySourceSchema>;

// ---------------------------------------------------------------------------
// PolicyThrottle — per-rule rate limiting config
// ---------------------------------------------------------------------------

export const PolicyThrottleSchema = z.object({
  maxPerMinute: z.number().int().positive(),
});

export type PolicyThrottle = z.infer<typeof PolicyThrottleSchema>;

// ---------------------------------------------------------------------------
// PolicyRule — a single routing rule in the policy file
// ---------------------------------------------------------------------------

export const PolicyRuleSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  priority: z.number().int().default(0),
  source: PolicySourceSchema.optional(),
  target: z.string().min(1),
  payload: z.string().min(1),
  throttle: PolicyThrottleSchema.optional(),
});

export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

// ---------------------------------------------------------------------------
// PolicyFile — top-level YAML structure
// ---------------------------------------------------------------------------

export const PolicyFileSchema = z.object({
  version: z.literal(1),
  rules: z.array(PolicyRuleSchema),
});

export type PolicyFile = z.infer<typeof PolicyFileSchema>;
