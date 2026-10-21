/**
 * Public surface of `src/advisor/`.
 *
 * Call sites (daemon IPC handler, MCP tool, Discord bridge,
 * capability manifest, session adapter) import everything advisor-
 * related from this barrel — they MUST NOT reach into individual
 * module files. This keeps the seam tight and lets future
 * refactors move internals without breaking consumers.
 *
 * Phase 117 scope: types, service, registry, prompts. Backend
 * implementations (`LegacyForkAdvisor`, `AnthropicSdkAdvisor`,
 * `PortableForkAdvisor`) ship in Plans 117-03 / 117-04 / 117-05 and
 * are intentionally NOT re-exported here yet — they should be
 * imported directly from `./backends/...` when registered at boot.
 */

// Types
export type {
  AdvisorService,
  AdvisorRequest,
  AdvisorResponse,
  BackendId,
  AdvisorInvokedEvent,
  AdvisorResultedEvent,
} from "./types.js";
export type { AdvisorBackend } from "./backends/types.js";
export type { AdvisorServiceDeps } from "./service.js";

// Service
export { DefaultAdvisorService } from "./service.js";

// Registry + model alias resolver
export {
  resolveBackend,
  BackendRegistry,
  resolveAdvisorModel,
  ADVISOR_MODEL_ALIASES,
} from "./registry.js";

// Prompts
export { buildAdvisorSystemPrompt } from "./prompts.js";
