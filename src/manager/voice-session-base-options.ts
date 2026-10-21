/**
 * OpenAI VOICE route — full-but-lean session base-options builder.
 *
 * Background: the OpenAI endpoint (`/v1/chat/completions`, port 3101) normally
 * runs each agent turn as a STATELESS transient session — soul string only, no
 * workspace, no tools, no memory (see `src/openai/driver.ts`
 * `materializeHandle()`). That is correct for the OpenClaw template path and the
 * default native path.
 *
 * For agents that OPT IN via `agents.<name>.openaiVoice.enabled === true`, the
 * voice turn must instead run the FULL agent session — workspace cwd + the
 * assembled identity/skills/MCP system prompt + the agent's MCP servers/tools +
 * the hot memories already folded into the stable prefix + effort — but
 * OPTIMIZED FOR LOW LATENCY (trimmed MCP allowlist + effort/memory override
 * knobs keep the assembled stable prefix small → low TTFT).
 *
 * This module holds the PURE pieces of that mapping so they can be unit-tested
 * in isolation:
 *
 *   - `isVoiceEnabled(cfg)`            — the opt-in gate.
 *   - `applyVoiceOverrides(cfg, voice)`— cascade the voice-only overrides over
 *                                        the agent's base ResolvedAgentConfig
 *                                        (unset → inherit). Trims `mcpServers`
 *                                        by the allowlist BEFORE buildSessionConfig
 *                                        runs so the assembled MCP prompt block
 *                                        reflects the allowlist (token savings).
 *   - `mapSessionConfigToVoiceBaseOptions(...)` — mirror the lean subset of
 *                                        `SdkSessionAdapter.createSession`'s
 *                                        AgentSessionConfig→SdkQueryOptions
 *                                        mapping (systemPrompt preset, mcp
 *                                        transform, cwd, effort, settingSources,
 *                                        clean env). A one-shot voice query does
 *                                        NOT need advisorModel/mutableSuffix/
 *                                        sandbox/disallowedTools.
 *
 * The SessionManager method `buildVoiceSessionBaseOptions` orchestrates these
 * three with a live `buildSessionConfig` call in the middle (see
 * `session-manager.ts`). The driver consumes the result via the
 * `buildVoiceSessionBaseOptions` dep and uses `staticPrefixHash` in place of the
 * soul fingerprint in the transient cache key.
 */

import type { ResolvedAgentConfig } from "../shared/types.js";
import type { OpenaiVoiceConfig } from "../config/schema.js";
import type { AgentSessionConfig } from "./types.js";
import type { SdkQueryOptions } from "./sdk-types.js";
import {
  buildSystemPromptOption,
  transformMcpServersForSdk,
  narrowEffortForSdkOption,
} from "./session-adapter.js";
import { resolveExecutorModelForGates } from "./model-resolver.js";
import { CACHE_BREAKPOINT_MARKER } from "./context-assembler.js";
import { buildAnthropicSafeEnv } from "./spawn-env.js";
import { sha256Hex } from "../openai/caller-identity.js";

/** Opt-in gate. Voice runs the full session ONLY when explicitly enabled. */
export function isVoiceEnabled(
  cfg: ResolvedAgentConfig | undefined,
): cfg is ResolvedAgentConfig & { openaiVoice: OpenaiVoiceConfig } {
  return cfg?.openaiVoice?.enabled === true;
}

/**
 * Filter the agent's MCP servers by the voice allowlist (by server name).
 *
 *   - allowlist omitted (undefined) → keep NONE (safe default — see below).
 *   - allowlist `[]`                → keep NONE.
 *   - allowlist `[names…]`          → keep only the named servers.
 *
 * SAFE DEFAULT (security): an OMITTED allowlist yields NO MCP servers. The voice
 * full-session is an internet-facing, bypassPermissions execution surface;
 * defaulting to "all the agent's servers" would silently expose write/DB tools
 * (e.g. acme-db, acme-content, smarthome) to a voice key. Operators
 * must EXPLICITLY allowlist the tools a voice agent may use.
 *
 * Applied to the ResolvedAgentConfig BEFORE buildSessionConfig so the assembled
 * MCP prompt block (and the SDK mcpServers map) reflect the trimmed set — also
 * the token-savings lever that keeps the voice stable prefix small for low TTFT.
 */
function filterMcpServersByAllowlist(
  mcpServers: ResolvedAgentConfig["mcpServers"],
  allowlist: readonly string[] | undefined,
): ResolvedAgentConfig["mcpServers"] {
  if (allowlist === undefined) return [];
  const allow = new Set(allowlist);
  return mcpServers.filter((s) => allow.has(s.name));
}

/**
 * Cascade the voice-only overrides over the agent's base config. Each override
 * is `voice.<field> ?? cfg.<field>` (unset → inherit). Returns a NEW config
 * object — never mutates the input (immutability rule).
 *
 * NOTE: per-turn RAG retrieval is intentionally NOT performed here — voice
 * relies on the hot memories already folded into the stable prefix by
 * buildSessionConfig (a deliberate latency choice). The memory* overrides only
 * tune how buildSessionConfig assembles that stable prefix.
 */
export function applyVoiceOverrides(
  cfg: ResolvedAgentConfig,
  voice: OpenaiVoiceConfig,
): ResolvedAgentConfig {
  return {
    ...cfg,
    effort: voice.effort ?? cfg.effort,
    memoryAutoLoad: voice.memoryAutoLoad ?? cfg.memoryAutoLoad,
    memoryRetrievalTopK: voice.memoryRetrievalTopK ?? cfg.memoryRetrievalTopK,
    memoryRetrievalTokenBudget:
      voice.memoryRetrievalTokenBudget ?? cfg.memoryRetrievalTokenBudget,
    mcpServers: filterMcpServersByAllowlist(cfg.mcpServers, voice.mcpAllowlist),
  };
}

/** Result of the voice base-options mapping. */
export interface VoiceSessionBaseOptions {
  /** SDK query options the driver feeds to a one-shot voice query. */
  readonly baseOptions: SdkQueryOptions;
  /**
   * sha256(static portion of the assembled stable prefix).slice(0,16). The
   * static portion = the bytes BEFORE the `CACHE_BREAKPOINT_MARKER` (identity +
   * skills + MCP block — excludes rotating hot memories), so the transient
   * cache key is stable turn-to-turn and the warm handle is reused (the whole
   * point of voice mode). Used in place of the soul fingerprint in the driver's
   * transient cache key.
   */
  readonly staticPrefixHash: string;
}

/**
 * Compute the static-prefix hash from the assembled stable prefix. Splits on
 * `CACHE_BREAKPOINT_MARKER` and hashes the part BEFORE it. When the marker is
 * absent (both-empty edge case, or a builder that didn't place it), `split`
 * returns the whole string at `[0]` — still deterministic.
 */
export function computeStaticPrefixHash(stablePrefix: string): string {
  const staticPortion = stablePrefix.split(CACHE_BREAKPOINT_MARKER)[0] ?? "";
  return sha256Hex(staticPortion).slice(0, 16);
}

/**
 * Map an assembled `AgentSessionConfig` into the lean SDK `baseOptions` a
 * one-shot voice query needs. MIRRORS the relevant subset of
 * `SdkSessionAdapter.createSession`:
 *
 *   - `systemPrompt`     — `buildSystemPromptOption(stablePrefix, excludeDynamic)`
 *                          (preset+append, prompt-cache preserved).
 *   - `model`            — `resolveExecutorModelForGates(config.model)` (handles
 *                          the full 8-value union incl. fable + `<family>@latest`,
 *                          which it collapses to the family's pinned concrete id
 *                          — snapshot-free, correct for a one-shot voice query).
 *                          NOT TIER_MODEL_MAP (keyed by the 3-value Tier — would
 *                          feed the SDK `undefined` for fable/@latest agents) and
 *                          NOT bare `resolveModelId` (passes `@latest` through
 *                          literally → an invalid SDK model id).
 *   - `cwd`              — the agent workspace.
 *   - `mcpServers`       — `transformMcpServersForSdk(config.mcpServers, name)`
 *                          (passing `name` injects the agent identity/token into
 *                          the `clawcode` MCP server's env — the memory-IPC gate
 *                          proof; omitting it makes the daemon fail open).
 *   - `settingSources`   — `config.settingSources ?? ["project"]`.
 *   - `effort`           — `narrowEffortForSdkOption(config.effort)`.
 *   - clean env          — `buildAnthropicSafeEnv()` (strips
 *                          ANTHROPIC_API_KEY → OAuth subscription auth; the
 *                          OpenAI route never talks to api.anthropic.com).
 *
 * Deliberately OMITS advisorModel / mutableSuffix / sandboxPlan / disallowedTools
 * / stream-stall knobs — none apply to a one-shot voice turn.
 */
export function mapSessionConfigToVoiceBaseOptions(
  sessionConfig: AgentSessionConfig,
): VoiceSessionBaseOptions {
  const stablePrefix = sessionConfig.systemPrompt;
  const baseOptions = {
    systemPrompt: buildSystemPromptOption(
      stablePrefix,
      sessionConfig.excludeDynamicSections,
    ),
    model: resolveExecutorModelForGates(sessionConfig.model),
    cwd: sessionConfig.workspace,
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    mcpServers: transformMcpServersForSdk(
      sessionConfig.mcpServers,
      sessionConfig.name,
    ),
    settingSources: sessionConfig.settingSources ?? ["project"],
    effort: narrowEffortForSdkOption(sessionConfig.effort),
    env: buildAnthropicSafeEnv(),
  } satisfies SdkQueryOptions;

  return {
    baseOptions,
    staticPrefixHash: computeStaticPrefixHash(stablePrefix),
  };
}
