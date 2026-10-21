// Memory module barrel export

export { MemoryStore } from "./store.js";
export { EmbeddingService } from "./embedder.js";
export { SemanticSearch } from "./search.js";
export { SessionLogger } from "./session-log.js";

export type {
  MemoryEntry,
  MemoryTier,
  CreateMemoryInput,
  SearchResult,
  SessionLogEntry,
  MemorySource,
  EmbeddingVector,
} from "./types.js";

export {
  memorySourceSchema,
  createMemoryInputSchema,
  memoryConfigSchema,
  tierConfigSchema,
  type MemoryConfig,
  type TierConfig,
} from "./schema.js";

export {
  shouldPromoteToHot,
  shouldDemoteToWarm,
  shouldArchiveToCold,
  DEFAULT_TIER_CONFIG,
} from "./tiers.js";

export { CompactionManager, CharacterCountFillProvider } from "./compaction.js";
export type {
  CompactionDeps,
  ConversationTurn,
  ContextFillProvider,
  CompactionResult,
} from "./compaction.js";

export { MemoryError, EmbeddingError } from "./errors.js";

export {
  TierManager,
  embeddingToBase64,
  base64ToEmbedding,
  generateColdSlug,
} from "./tier-manager.js";
export type { TierManagerDeps, MaintenanceResult } from "./tier-manager.js";
