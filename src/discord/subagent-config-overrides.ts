import type { ResolvedAgentConfig } from "../shared/types.js";

/**
 * Phase 999.57 (2026-05-15) — single-source-of-truth factory for the
 * inheritance-override slice spread last into the `subagentConfig` at
 * `SubagentThreadSpawner.spawnInThread`.
 *
 * **Why this exists:** subagent sessions previously inherited the source
 * agent's entire `ResolvedAgentConfig` via object spread (verified at
 * `subagent-thread-spawner.ts:786-800`). That spread carried four
 * lifecycle/memory hooks the subagent should never share with its source
 * agent:
 *   - heartbeat (the runner fires per-agent checks on a timer)
 *   - MEMORY.md auto-load (injects parent's persistent memory file)
 *   - hybrid-RRF retrieval (surfaces parent's `memories.db` content per turn)
 *   - flush timers (writes mid-session summaries into parent's `memories.db`)
 *
 * Production failures (admin-clawdy → research, 2026-05-15 18:04 + 18:09)
 * surfaced two of these as visible leaks: a heartbeat-driven inbox check
 * reading the parent's `memoryPath`, and a memory-retrieval call surfacing
 * HeyGen-tagged content unrelated to the subagent's task. BACKLOG.md +
 * RESEARCH.md cover the full chain.
 *
 * **Important — three of the override fields are defensive markers, not
 * runtime gates by themselves:**
 *   - `heartbeat.enabled: false` (D-01): the existing gate at
 *     `runner.ts:271` short-circuits on `agentConfig && enabled === false`.
 *     The runner's local `agentConfigs` map is populated once at daemon
 *     boot from `resolvedAgents` and never auto-rotates as subagents start.
 *     So this field by itself is dead — `agentConfigs.get(subagentName)`
 *     returns `undefined`, the `&&` short-circuits truthy, and the check
 *     loop fires anyway. The 999.57 fix pairs this override with a call
 *     to `heartbeatRunner.setAgentConfigs([subagentConfig])` in the
 *     spawner immediately AFTER `sessionManager.startAgent(...)` — the
 *     runner's setter is an additive upsert (`runner.ts:143-147`), so
 *     registering the subagent's `enabled:false` config makes the existing
 *     gate fire correctly. See RESEARCH.md Finding 1.
 *   - `memoryScannerEnabled: false` (D-03): the scanner registration
 *     loop at `daemon.ts:3239-3274` runs once at daemon boot over
 *     `resolvedAgents`. Subagents are never iterated — no per-session
 *     scanner is constructed. The override has no current consumer.
 *     Kept here as a defensive marker so a future refactor that wires
 *     per-session scanners cannot silently leak. See RESEARCH.md
 *     Finding 3.
 *   - The runtime-effective overrides (`memoryAutoLoad`,
 *     `memoryRetrievalTopK`, `memoryRetrievalTokenBudget`,
 *     `memoryFlushIntervalMs`, `memory.conversation.flushIntervalMinutes`)
 *     gate at real code paths (`session-config.ts:467`, the retriever
 *     factory at `session-manager.ts:681-718`, and the two flush timers
 *     in `startAgent`). These do the actual leak prevention.
 *
 * **D-05 inboxEnabled was dropped:** RESEARCH Finding 2 confirmed via
 * grep that `inboxEnabled` does not exist on `ResolvedAgentConfig`,
 * `defaultsSchema`, or the agent schema. The "inbox watcher leak" the
 * BACKLOG postulated is actually the heartbeat-inbox-check at
 * `src/heartbeat/checks/inbox.ts:61-70`, which reads from
 * `sessionManager.getAgentConfig(name).memoryPath`. That leak is fixed by
 * the heartbeat-runner-side registration above (Finding 1 fix), not by a
 * new per-agent inbox toggle. No `inboxEnabled` field is set here.
 *
 * **Pitfall 3 — `memory.conversation` is optional.** The agent config
 * schema makes `memory.conversation` an optional block (see
 * `src/shared/types.ts:327`). `sourceConfig.memory.conversation` may be
 * `undefined` — guard the override with a conditional. Spread-on-undefined
 * compiles but the resulting object would be `{ flushIntervalMinutes: 0 }`
 * with all other fields missing, breaking downstream readers that expect
 * the full shape. Conditional spread keeps the field undefined when the
 * source didn't supply it.
 *
 * @param parentConfig the caller agent's resolved config (used by the
 *   spawn site for channel-scoped fields like `channels`, `threads`, and
 *   `webhook.webhookUrl`). Currently unused inside the factory but
 *   reserved per CONTEXT.md D-07 for future overrides that need to read
 *   from the caller's identity (e.g., per-parent retrieval policy).
 * @param sourceConfig the identity-source config — when delegating, the
 *   delegate; otherwise the parent. The factory pulls the structural
 *   defaults from `sourceConfig.heartbeat` and `sourceConfig.memory` so
 *   the override slice carries every field required by
 *   `ResolvedAgentConfig` even though only one field per block is being
 *   flipped.
 * @param isDelegated true when the spawn site set `delegateTo` to a
 *   non-empty agent name. Currently unused — D-06 fixes the override set
 *   the same regardless of delegation status. Reserved per CONTEXT.md
 *   D-07 for a future per-delegation override (e.g., a `gsd-research`
 *   delegate that legitimately wants memory retrieval).
 */
export function buildSubagentOverrides(
  parentConfig: ResolvedAgentConfig,
  sourceConfig: ResolvedAgentConfig,
  isDelegated: boolean,
): Partial<ResolvedAgentConfig> {
  // Mark the unused params as intentionally reserved (D-07 future hooks)
  // so the linter doesn't strip the signature.
  void parentConfig;
  void isDelegated;

  return {
    // Phase 999.82 Plan 03 (2026-05-27) — the interim v2-force is REVERTED.
    //
    // Phase 140 (commit `6147c0db`) used to force `llmRuntime.backend =
    // "anthropic-agent-sdk"` here: the spawn site spreads the SOURCE agent's
    // whole config (incl. `llmRuntime`) into the subagent, so a v3
    // (`claude-code-interactive`) parent's subagent inherited that backend and
    // spawned as a `claude --channels` session with an INERT daemon Query —
    // but the spawner dispatched the subagent's turn via `streamFromAgent` (the
    // v2 SDK iterate path). No tokens flowed from the inert Query, the Phase 127
    // stream-stall tracker false-tripped at ~180s, and EVERY v3-parent subagent
    // failed with "⚠️ a tool wedged". The v2-force was the workaround.
    //
    // 999.82 fixes the dispatch instead of forcing v2: Plan 04 replaces the
    // `streamFromAgent` call with a channel push → ack → Stop-hook fallback over
    // the subagent's OWN ClawCode channel (Plan 03 wires that channel before
    // startAgent). With the wedge root-cause gone, a v3 parent's subagent SHOULD
    // run as v3 — the optimal substrate (subscription pool, same as the parent
    // chat) rather than the masking/SDK pool. So this factory no longer sets
    // `llmRuntime` at all: the subagent INHERITS the source agent's backend via
    // the spawn-site spread (v3 parent → v3 subagent; v2 parent → v2 subagent),
    // and `failoverChain` flows through that same source spread unchanged.
    //
    // `feedback_silent_path_bifurcation`: this remains the SINGLE source of the
    // override slice. The backend is now decided ONLY by inheritance — do not
    // re-introduce a second backend gate here. The memory/heartbeat leak guards
    // below (D-01..D-04, threat T-999.82-03-03) are UNCHANGED — only the
    // llmRuntime force was removed.
    //
    // D-01 — heartbeat gate. Effective only when paired with the
    // `heartbeatRunner.setAgentConfigs([subagentConfig])` upsert from the
    // spawner (see runner.ts:143-147 and Finding 1). Spread the source's
    // required fields first so the slice satisfies `ResolvedAgentConfig`'s
    // shape; flip `enabled` to false last.
    heartbeat: {
      ...sourceConfig.heartbeat,
      enabled: false,
    },
    // D-02 — block MEMORY.md auto-load at session prefix assembly
    // (`session-config.ts:467` — `if (config.memoryAutoLoad !== false)`).
    memoryAutoLoad: false,
    // D-04 — block hybrid-RRF retrieval at the retriever closure
    // (`session-manager.ts:681-718` → `retrieveMemoryChunks`). `topK: 0`
    // returns an empty hydrated set; `tokenBudget: 0` caps zero injection
    // as a belt-and-suspenders guard in case a downstream consumer
    // bypasses the topK gate.
    memoryRetrievalTopK: 0,
    memoryRetrievalTokenBudget: 0,
    // D-03 (defensive marker — see Finding 3 in jsdoc above).
    memoryScannerEnabled: false,
    // D-03 — disk-flush timer. `startMemoryFileFlushTimer`
    // (session-manager.ts:1390-1423) gates on this value; the schema
    // default (15min = 900_000ms) is a no-op for the short-lived
    // subagent. Carried explicitly so a future schema default change
    // can't accidentally re-enable disk flushing for subagents.
    memoryFlushIntervalMs: 900_000,
    // Finding 4 — DB-flush timer. `startFlushTimer` (session-manager.ts:
    // 2624-2671) reads `memory.conversation?.flushIntervalMinutes ?? 15`
    // and writes `mid-session` MemoryEntries into the shared
    // `memories.db` (the subagent shares `memoryPath` with the source —
    // see Finding 5). Setting to 0 disables the timer (line 2634
    // short-circuits on `intervalMs <= 0`). Conditional spread per
    // Pitfall 3 — the conversation block is optional.
    memory: {
      ...sourceConfig.memory,
      conversation: sourceConfig.memory.conversation
        ? { ...sourceConfig.memory.conversation, flushIntervalMinutes: 0 }
        : undefined,
    },
  };
}
