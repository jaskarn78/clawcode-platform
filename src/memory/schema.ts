import { z } from "zod/v4";

/** Valid memory source values. */
export const memorySourceSchema = z.enum([
  "conversation",
  "manual",
  "system",
  "consolidation",
  "episode",
]);

/** Schema for creating a new memory entry. */
export const createMemoryInputSchema = z.object({
  content: z.string().min(1),
  source: memorySourceSchema,
  importance: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional(),
});

/** Schema for consolidation pipeline configuration. */
export const consolidationConfigSchema = z.object({
  enabled: z.boolean().default(true),
  weeklyThreshold: z.number().int().min(1).default(7),
  monthlyThreshold: z.number().int().min(1).default(4),
  summaryModel: z.enum(["sonnet", "opus", "haiku"]).optional(),
  schedule: z.string().default("0 3 * * *"),
});

/** Schema for relevance decay configuration. */
export const decayConfigSchema = z.object({
  halfLifeDays: z.number().int().min(1).default(30),
  semanticWeight: z.number().min(0).max(1).default(0.7),
  decayWeight: z.number().min(0).max(1).default(0.3),
});

/** Schema for memory deduplication configuration. */
export const dedupConfigSchema = z.object({
  enabled: z.boolean().default(true),
  similarityThreshold: z.number().min(0).max(1).default(0.85),
});

/** Schema for tier configuration. */
export const tierConfigSchema = z.object({
  hotAccessThreshold: z.number().int().min(1).default(3),
  hotAccessWindowDays: z.number().int().min(1).default(7),
  hotDemotionDays: z.number().int().min(1).default(7),
  coldRelevanceThreshold: z.number().min(0).max(1).default(0.05),
  hotBudget: z.number().int().min(1).default(20),
  // Phase 100-fu — centrality-based hot promotion. A warm memory whose
  // inbound backlink count meets or exceeds this threshold promotes to
  // hot tier even when its access_count is below hotAccessThreshold.
  // Targets the "hub" pattern where heavily-linked memories are
  // structurally important but rarely retrieved directly.
  //
  // 2026-04-30 — this field was missing from the zod schema even
  // though DEFAULT_TIER_CONFIG in tiers.ts had it. Result: zod stripped
  // the field on parse, runtime tierConfig.centralityPromoteThreshold
  // was undefined, and shouldPromoteToHot's `backlinkCount >= undefined`
  // check always returned false — silently breaking centrality-based
  // promotion since Phase 100-fu shipped.
  centralityPromoteThreshold: z.number().int().min(1).default(5),
});

/** Schema for episode input validation. */
export const episodeInputSchema = z.object({
  title: z.string().min(1).max(200),
  summary: z.string().min(1),
  importance: z.number().min(0).max(1).default(0.6),
  tags: z.array(z.string()).default([]),
  occurredAt: z.string().datetime().optional(),
});

/** Schema for episode archival configuration. */
export const episodeConfigSchema = z.object({
  archivalAgeDays: z.number().int().min(1).default(90),
});

/** Schema for conversation persistence configuration. */
export const conversationConfigSchema = z.object({
  enabled: z.boolean().default(true),
  turnRetentionDays: z.number().int().min(7).default(90),
  // Phase 67 — SESS-02: how many recent session summaries to render in the brief
  resumeSessionCount: z.number().int().min(1).max(10).default(3),
  // Phase 67 — SESS-03: gap-skip threshold (0 = always inject; no upper bound)
  resumeGapThresholdHours: z.number().min(0).default(4),
  // Phase 67 — dedicated budget for conversation_context section (NOT shared with resume_summary)
  conversationContextBudget: z.number().int().min(500).default(2000),
  // Phase 68 — RETR-03: half-life for retrieval-time decay weighting over
  // conversation search results (memories + session-summaries + raw turns).
  // 14 days (faster than general-memory default of 30) because conversation
  // recency is disproportionately valuable for "what did we talk about?".
  retrievalHalfLifeDays: z.number().int().min(1).default(14),
  // Gap 3 (memory-persistence-gaps): how often to write a non-terminating
  // mid-session summary to the memory DB while a session is live. 0 disables
  // the periodic flush; positive values produce one MemoryEntry tagged
  // "mid-session" per interval per active session. Default 15 min balances
  // catastrophe-recovery coverage (SIGKILL / OOM / power loss between clean
  // shutdowns) against Haiku spend + DB write volume.
  flushIntervalMinutes: z.number().int().min(0).default(15),
});

/** Schema for memory system configuration. */
export const memoryConfigSchema = z.object({
  compactionThreshold: z.number().min(0).max(1).default(0.75),
  searchTopK: z.number().int().min(1).default(10),
  consolidation: consolidationConfigSchema.default(() => ({
    enabled: true,
    weeklyThreshold: 7,
    monthlyThreshold: 4,
    schedule: "0 3 * * *",
  })),
  decay: decayConfigSchema.default(() => ({
    halfLifeDays: 30,
    semanticWeight: 0.7,
    decayWeight: 0.3,
  })),
  deduplication: dedupConfigSchema.default(() => ({
    enabled: true,
    similarityThreshold: 0.85,
  })),
  tiers: tierConfigSchema.default(() => ({
    hotAccessThreshold: 3,
    hotAccessWindowDays: 7,
    hotDemotionDays: 7,
    coldRelevanceThreshold: 0.05,
    hotBudget: 20,
    centralityPromoteThreshold: 5,
  })),
  episodes: episodeConfigSchema.default(() => ({
    archivalAgeDays: 90,
  })),
  conversation: conversationConfigSchema.optional(),
});

/** Inferred types from schemas. */
export type MemoryConfig = z.infer<typeof memoryConfigSchema>;

/** Inferred consolidation config type. */
export type ConsolidationConfig = z.infer<typeof consolidationConfigSchema>;

/** Inferred decay config type. */
export type DecayConfig = z.infer<typeof decayConfigSchema>;

/** Inferred deduplication config type. */
export type DedupConfig = z.infer<typeof dedupConfigSchema>;

/** Inferred tier config type. */
export type TierConfig = z.infer<typeof tierConfigSchema>;

/** Inferred episode input type. */
export type EpisodeInputValidated = z.infer<typeof episodeInputSchema>;

/** Inferred episode config type. */
export type EpisodeConfig = z.infer<typeof episodeConfigSchema>;

/** Inferred conversation config type. */
export type ConversationConfig = z.infer<typeof conversationConfigSchema>;
