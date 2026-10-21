/**
 * Phase 999.10 — collect every op:// URI reachable from the parsed
 * clawcode.yaml config so SecretsResolver.preResolveAll can warm the cache
 * once at boot, before any agent spawn.
 *
 * Six zones in scope (999.135 extends from five to six):
 *   1. discord.botToken (single optional string)
 *   2. mcpServers.<name>.env.<key> (server-shared env)
 *   3. agents.<name>.mcpEnvOverrides.<server>.<key> (per-agent overrides)
 *   4. defaults.search.{brave,exa}.apiKey (Phase 110 — daemon-side
 *      BraveClient/ExaClient construction site; Phase 71+ created the
 *      need by routing search through the daemon's process.env which
 *      systemd EnvironmentFile didn't populate)
 *   5. agents.<name>.voice.{deepgramKey, elevenLabsKey} (Phase 135 —
 *      per-agent Deepgram STT + ElevenLabs TTS credentials, resolved
 *      at agent boot before VoiceManager opens the streaming WSs)
 *   6. agents.<name>.training.strava.fetchKeyRef + defaults.training.strava
 *      .fetchKeyRef (999.135 — the Strava worker fetch-key the engine's
 *      token broker resolves ONCE at boot; both athletes share the same
 *      op:// URI, so the Set collapses N agents to ONE read) PLUS
 *      defaults.training.dashboard.linkSecretRef (999.136 — the HMAC secret
 *      createTrainingLinkSigner resolves once at boot)
 *
 * Dedups via Set — the same op:// URI referenced from multiple zones
 * collapses to one cache entry (which is correct: one URI = one secret).
 *
 * Pure function, no side effects, no I/O, no logging — DI-friendly + safe
 * to call from the boot path before logger transports are fully wired.
 *
 * Predicate matches the existing `isOpRef` in src/config/loader.ts (line 57)
 * — case-sensitive `op://` prefix only; broader vault/item/field validation
 * lives at the schema layer, not here.
 */
import type { Config } from "../config/schema.js";

/**
 * Case-sensitive op:// prefix guard. Mirrors the loader's `isOpRef`
 * predicate verbatim so the walker never disagrees with the resolver about
 * what counts as a 1Password reference.
 */
function isOpRef(value: unknown): value is string {
  return (
    typeof value === "string"
    && value.startsWith("op://")
    && value.length > "op://".length
  );
}

/**
 * Walk the parsed config and return every distinct op:// URI it contains
 * across the three in-scope zones. Returns insertion-order array of unique
 * URIs (Set semantics) — caller can pass directly to
 * `SecretsResolver.preResolveAll`.
 *
 * Defensive against missing zones: a config without `discord`, `mcpServers`,
 * or any agent's `mcpEnvOverrides` returns `[]` without throwing — boot
 * paths can call this unconditionally.
 */
export function collectAllOpRefs(config: Config): readonly string[] {
  const refs = new Set<string>();

  // Zone 1: discord.botToken (single optional string).
  if (isOpRef(config.discord?.botToken)) {
    refs.add(config.discord!.botToken!);
  }

  // Zone 2: mcpServers[].env (top-level shared servers — record keyed on
  // server name; each server has an env: Record<string, string>).
  if (config.mcpServers) {
    for (const server of Object.values(config.mcpServers)) {
      if (server && typeof server === "object" && "env" in server && server.env) {
        for (const value of Object.values(server.env as Record<string, string>)) {
          if (isOpRef(value)) refs.add(value);
        }
      }
    }
  }

  // Zone 3: agents[].mcpEnvOverrides (per-agent vault-scope overrides —
  // shape: { [serverName]: { [envKey]: value } }).
  if (Array.isArray(config.agents)) {
    for (const agent of config.agents) {
      const overrides = (agent as { mcpEnvOverrides?: Record<string, Record<string, string>> })
        .mcpEnvOverrides;
      if (!overrides) continue;
      for (const serverOverride of Object.values(overrides)) {
        if (serverOverride && typeof serverOverride === "object") {
          for (const value of Object.values(serverOverride)) {
            if (isOpRef(value)) refs.add(value);
          }
        }
      }
    }
  }

  // Zone 4 (Phase 110 follow-up): defaults.search.{brave,exa}.apiKey.
  // Daemon-side BraveClient / ExaClient construction reads these via the
  // SecretsResolver cache after preResolveAll. Schema makes them optional
  // strings, so the defaults block + missing field both safely return [].
  const search = config.defaults?.search;
  if (search) {
    const braveApiKey = search.brave?.apiKey;
    if (isOpRef(braveApiKey)) refs.add(braveApiKey);
    const exaApiKey = search.exa?.apiKey;
    if (isOpRef(exaApiKey)) refs.add(exaApiKey);
  }

  // Zone 5 (Phase 135 Plan 01): agents[].voice.{deepgramKey, elevenLabsKey}.
  // Per-agent voice subsystem credentials. Both fields are required when
  // the `voice` block is present (enforced by voiceConfigSchema), but
  // they may be either literal secrets or op:// URIs. Only the op:// shape
  // belongs in the warm-up set — literals are passed through to Plan 02's
  // STT/TTS clients verbatim by the loader. Mirrors the Zone-3 walk pattern.
  if (Array.isArray(config.agents)) {
    for (const agent of config.agents) {
      const voice = (agent as {
        voice?: { deepgramKey?: string; elevenLabsKey?: string };
      }).voice;
      if (!voice) continue;
      if (isOpRef(voice.deepgramKey)) refs.add(voice.deepgramKey);
      if (isOpRef(voice.elevenLabsKey)) refs.add(voice.elevenLabsKey);
    }
  }

  return Array.from(refs);
}
