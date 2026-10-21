/**
 * Types and constants for config hot-reload infrastructure.
 */

/**
 * A single field-level change detected between two config versions.
 */
export type ConfigChange = {
  readonly fieldPath: string;
  readonly oldValue: unknown;
  readonly newValue: unknown;
  readonly reloadable: boolean;
};

/**
 * Result of diffing two config objects.
 */
export type ConfigDiff = {
  readonly changes: readonly ConfigChange[];
  readonly hasReloadableChanges: boolean;
  readonly hasNonReloadableChanges: boolean;
};

/**
 * A single entry in the JSONL audit trail.
 */
export type AuditEntry = {
  readonly timestamp: string;
  readonly fieldPath: string;
  readonly oldValue: unknown;
  readonly newValue: unknown;
};

/**
 * Event emitted when a config change is detected.
 */
export type ConfigChangeEvent = {
  readonly diff: ConfigDiff;
  readonly timestamp: string;
};

/**
 * Field path prefixes that can be hot-reloaded without daemon restart.
 */
export const RELOADABLE_FIELDS: ReadonlySet<string> = new Set([
  "agents.*.channels",
  "agents.*.skills",
  "agents.*.schedules",
  "agents.*.heartbeat",
  "defaults.heartbeat",
  // 2026-09-02 WS4 — memoryGuard knobs are read per-tick off the live config
  // binding (daemon.ts `resolveConfig: () => config.defaults.memoryGuard`,
  // rebound on every reload), so a file-save applies on the next 60s sample.
  // Listing it here does not change that — the value already went live — but
  // it stops the differ classifying the block as restart-required and telling
  // an operator their edit did nothing. Sole exception: `sampleIntervalMs`,
  // read once in start() when the timer is armed, which IS restart-required.
  "defaults.memoryGuard",
  // Phase 999.176 — read lazily by AccountService.getSlots on every use.
  "defaults.accountSwap",
  // Phase 83 EFFORT-01 — runtime override via handle.setEffort → next turn.
  // No socket/db/workspace resource touched; buildOptions re-reads
  // currentEffort per turn, so YAML edits are picked up on restart AND a
  // live /clawcode-effort call invokes q.setMaxThinkingTokens immediately.
  "agents.*.effort",
  "defaults.effort",
  // Phase 86 MODEL-01 — allowlist is read lazily by the Discord picker
  // on every invocation (no cached state in a session handle). A YAML
  // edit takes effect on the NEXT /clawcode-model interaction without
  // restart. Runtime model SWITCHES remain non-reloadable (agents.*.model
  // still requires session restart per types.ts:63) — the allowlist
  // governs what's PICKABLE, not what's active.
  "agents.*.allowedModels",
  "defaults.allowedModels",
  // Phase 999.100 — mid-turn steering knobs. The bridge gate re-reads the
  // fully-resolved block from getAgentConfig on EVERY inbound message (no
  // cached state in a session handle), so a YAML flip of autoClassify /
  // thresholds takes effect on the next message without daemon restart.
  "agents.*.steering",
  "defaults.steering",
  // 2026-08-26 — verification gate + activity trail. Same shape as
  // steering: every consumer re-reads the resolved block live —
  // TurnDispatcher.resolveVerification via manager.getAgentConfig on each
  // gate call, and the bridge trail gate via sessionManager.getAgentConfig
  // on every inbound message. Neither caches in a session handle.
  //
  // This entry was MISSING for the whole life of the block (shipped
  // 2026-07-31 as financialVerification). Consequence: a yaml edit that
  // touched ONLY this block produced a diff with zero reloadable changes,
  // so ConfigReloader.applyChanges early-returned BEFORE
  // setAllAgentConfigs — the live config map kept the boot snapshot and
  // the edit silently did nothing until the next restart (the log did
  // say "requires daemon restart", contradicting the incident doc's
  // "hot flip" plan for ruleClaims.maxVerifyHops / holdDelivery /
  // pendingMarker). It only ever appeared to work when bundled with some
  // OTHER reloadable edit that happened to trigger the republish.
  // Found 2026-08-26 while renaming the key on prod.
  "agents.*.verification",
  "defaults.verification",
  // Deprecated alias — keep in lockstep with the schema alias; remove
  // together once every yaml is on `verification`.
  "agents.*.financialVerification",
  "defaults.financialVerification",
  // Phase 89 GREET-07 — both flags read lazily by SessionManager.restartAgent
  // on every call (no cached state). A YAML edit takes effect on the NEXT
  // restart without daemon bounce.
  "agents.*.greetOnRestart",
  "defaults.greetOnRestart",
  "agents.*.greetCoolDownMs",
  "defaults.greetCoolDownMs",
  // Phase 90 MEM-01 — Next session boot picks up a YAML edit. MEMORY.md
  // content itself is re-read at every session boot (mtime naturally
  // busts the stable-prefix cache); the schema flag gates the read.
  "agents.*.memoryAutoLoad",
  "defaults.memoryAutoLoad",
  "agents.*.memoryAutoLoadPath",
  // Phase 90 MEM-03 — top-K + token budget read lazily by
  // getMemoryRetrieverForAgent at each turn. A YAML edit takes effect on
  // the NEXT turn without daemon bounce.
  "agents.*.memoryRetrievalTopK",
  "defaults.memoryRetrievalTopK",
  "defaults.memoryRetrievalTokenBudget",
  // Phase 115 sub-scope 3 — per-agent + agents-prefix token budget.
  // Reloadable: same closure-re-read path as memoryRetrievalTopK above.
  // Plan 115-01 lit up this previously-dead knob; the closure in
  // SessionManager.getMemoryRetrieverForAgent reads
  // config?.memoryRetrievalTokenBudget on each retrieval.
  "agents.*.memoryRetrievalTokenBudget",
  // Phase 115 sub-scope 4 — tag-exclusion list for hybrid-RRF retrieval.
  // Reloadable: same closure-re-read path. Locked default
  // ["session-summary","mid-session","raw-fallback"] per CONTEXT.md
  // sub-scope 4.
  "agents.*.memoryRetrievalExcludeTags",
  "defaults.memoryRetrievalExcludeTags",
  // Phase 90 MEM-02 — scanner enable flag. Reloadable semantics: a YAML
  // flip from true→false at runtime does NOT stop an already-running
  // scanner (requires daemon restart); a false→true flip starts scanners
  // only for newly-added agents. Pragmatic compromise vs. full watcher-
  // lifecycle churn.
  "agents.*.memoryScannerEnabled",
  "defaults.memoryScannerEnabled",
  // Phase 90 MEM-04 — flush cadence. Reloadable: YAML edit takes effect
  // on the NEXT agent start (current timers keep running at the old
  // interval). A full daemon restart is NOT required for the fleet to
  // pick up a new default.
  "agents.*.memoryFlushIntervalMs",
  "defaults.memoryFlushIntervalMs",
  // Phase 90 MEM-05 — reaction emoji read lazily by TurnDispatcher at each
  // cue-detection event. A YAML edit takes effect on the NEXT cue-detected
  // turn.
  "agents.*.memoryCueEmoji",
  "defaults.memoryCueEmoji",
  // Phase 94 TOOL-10 / D-10 — system-prompt directives. Reloadable: a
  // YAML edit takes effect on the NEXT prompt assembly (per-turn boundary
  // — assembler reads via the loader resolver each turn). No socket / DB /
  // workspace restart required. 8th application of the Phase 83/86/89/90
  // additive-optional reloadable blueprint.
  "agents.*.systemPromptDirectives",
  "defaults.systemPromptDirectives",
  // Phase 95 DREAM-01..03 — dream cycle config. Reloadable: a YAML edit
  // takes effect on the NEXT cron tick / NEXT dream-pass invocation
  // (95-02 cron reads via the loader resolver each fire). Current in-
  // flight dream passes complete at the previous setting. 9th application
  // of the Phase 83/86/89/90/94 additive-optional reloadable blueprint.
  "agents.*.dream",
  "defaults.dream",
  // Phase 142 follow-up — agent-optimizer config is NOT reloadable; it is listed
  // in NON_RELOADABLE_FIELDS below. (The original "reloadable like dream" claim
  // was false: the `/clawcode-optimize` trigger reads the boot-time
  // `resolvedAgents` const in daemon.ts, and neither the ConfigWatcher onChange
  // handler nor ConfigReloader re-splices it or has an optimizer apply-path — so
  // a hot edit logged "config hot-reloaded" but the trigger still saw the prior
  // value. Made honest: editing the block now reports restart-required.)
  // Phase 96 D-03 / D-09 — fileAccess + outputDir reloadable.
  // Reload semantics:
  //   - fileAccess: classifying as reloadable signals "no daemon restart
  //     needed". The next 60s heartbeat tick (src/heartbeat/checks/fs-
  //     probe.ts — Phase 96 plan 07 task 1) reads the freshly-loaded paths
  //     via deps.getResolvedConfig(agent) and runs runFsProbe against the
  //     new declarations. Operators wanting sub-60s response can run
  //     /clawcode-probe-fs <agent> (Phase 96 plan 05) manually.
  //   - outputDir: resolveOutputDirTemplate is read lazily on each
  //     clawcode_share_file call (Phase 96 plan 04) — a YAML edit takes
  //     effect on the NEXT share invocation. No restart required.
  // 10th and 11th applications of the Phase 83/86/89/90/94/95 additive-
  // optional reloadable blueprint.
  "agents.*.fileAccess",
  "defaults.fileAccess",
  "agents.*.outputDir",
  "defaults.outputDir",
  // Phase 110 Stage 0a — shimRuntime + brokers schema scaffolding.
  //   - defaults.shimRuntime: per-shim-type runtime selector. Reloadable
  //     via the existing prefix-match classifier (children of the prefix
  //     all classify reloadable). Stage 0a accepts only "node"; Stage 0b
  //     widens the enum and lands the alternate-runtime spawn path. The
  //     swap happens on the NEXT agent start (current shims keep running
  //     under their boot-time runtime — same posture as Phase 90 MEM-04).
  //   - defaults.brokers: server-id keyed dispatch table. Schema-only in
  //     Stage 0a; the broker dispatcher is wired in Stage 1a. Mirrors the
  //     Phase 109-C `brokerPooling` precedent (schema present, consumer
  //     reads at its own cadence) so a runtime YAML edit in Stage 0a is
  //     a no-op until Stage 1a lands. Classified reloadable so the
  //     Stage 1a wiring picks up edits without a restart.
  "defaults.shimRuntime",
  "defaults.brokers",
  // defaults.bridge.haikuDirectRouting — read per call by haiku-direct.
  "defaults.bridge",
  // Phase 109-B — orphan-claude reaper config. Mode/minAgeSeconds edits
  // hot-reload via the daemon's onTickAfter closure, which reads
  // `config.defaults.orphanClaudeReaper` on each 60s tick. The closure-
  // capture fix (same PR that landed subagentReaper reloadable) ensures
  // the ModeGetter sees the post-reload value without a daemon restart.
  "defaults.orphanClaudeReaper",
  // Phase 999.X — subagent-thread reaper config. Mode/idle/minAge edits
  // hot-reload through the existing ConfigReloader path (Phase 109-B
  // precedent — same shape as defaults.orphanClaudeReaper above). The
  // daemon's onTickAfter closure reads `config.defaults.subagentReaper`
  // each tick, so a YAML edit takes effect on the next 60s sweep without
  // a restart.
  "defaults.subagentReaper",
  // Phase 999.25 — subagent completion relay. enabled +
  // quiescenceMinutes hot-reload via the same closure-capture-fixed
  // path as subagentReaper above. The daemon's quiescence sweep reads
  // `config.defaults.subagentCompletion` on each 60s tick.
  "defaults.subagentCompletion",
  // Phase 127 — stream-stall supervisor threshold (no-useful-tokens timeout).
  //
  // 🚨 Phase 999.114 CORRECTION — the paragraph that stood here was WRONG and
  // cost a live debugging session. It claimed "the setInterval checker in
  // persistent-session-handle.ts + wrapSdkQuery re-reads the live
  // ResolvedAgentConfig.streamStallTimeoutMs on every tick ... without daemon
  // restart". Neither half holds:
  //   - `wrapSdkQuery` is @deprecated with NO production caller
  //     (session-adapter.ts states this in-line).
  //   - persistent-session-handle.ts captures the number ONCE at handle
  //     construction (`streamStallTimeoutMsOption ?? 180_000`) and hands the
  //     tracker a FIXED `thresholdMs`.
  // A `clawcode reload` does re-RESOLVE the value (the `phase127-resolver` log
  // line is emitted again), and that resolved value is what the NEXT session
  // gets — but a LIVE session keeps its old threshold until it is re-created.
  // The 2026-08-22 fin-research fix appeared to hot-apply only because a daemon
  // restart resumed the session two minutes later.
  //
  // These entries stay listed because a reload genuinely updates the resolved
  // config that every subsequent session reads — but the boundary is
  // NEXT-SESSION, not next-tick. To apply a change to a turn happening right
  // now, restart the agent.
  //
  // Per-model overrides (defaults.modelOverrides.<family>.streamStallTimeoutMs)
  // are read by the same loader resolver at agent-start and follow the same
  // next-session boundary.
  "agents.*.streamStallTimeoutMs",
  "defaults.streamStallTimeoutMs",
  "defaults.modelOverrides",
  // Phase 100 GSD-07 — settingSources + gsd.projectDir DELIBERATELY EXCLUDED
  // from RELOADABLE_FIELDS. See NON_RELOADABLE_FIELDS below + Plan 100-02
  // session-adapter wiring for rationale: both fields are SDK session-boot
  // baseOptions (passed to sdk.query at session start, NOT re-read per turn),
  // so a runtime YAML edit cannot retroactively change a live SDK session.
  // Operators MUST run `clawcode restart admin-clawdy` for an edit to take
  // effect. 1st application of an agent-restart classification in Phase 100
  // (vs. the 11 prior reloadable classifications in 83/86/89/90/94/95/96).
  //
  // Phase 999.47 Plan 02 — homelab refresh tick. Prefix-match: children
  // of `defaults.homelab.*` all classify reloadable. The heartbeat
  // check `homelab-refresh` reads the live resolved config via the
  // standard ConfigReloader closure pattern (mirrors
  // `defaults.streamStallTimeoutMs` Phase 127 precedent above). NOTE:
  // `repoPath` is captured into refresh.sh's working directory at boot
  // (Plan 03) and is documented as documentation-of-intent only —
  // operators changing the inventory repo location should run
  // `clawcode restart` for the new path to take effect cleanly.
  "defaults.homelab",
  // Phase 999.43 — auto-ingest Discord attachments + per-agent
  // ingestion priority. Both are read LAZILY on each
  // `attachmentReceived` event (Plan 02 dispatcher reads via
  // SessionManager.getAgentConfig at receive time — no cached
  // session-boot capture). A clawcode.yaml edit takes effect on the
  // NEXT attachment Discord delivers. Mirrors the Phase 90 MEM-03
  // closure-re-read pattern (types.ts:78-83). 12th application of
  // the additive-optional reloadable blueprint.
  "agents.*.autoIngestAttachments",
  "defaults.autoIngestAttachments",
  "agents.*.ingestionPriority",
  "defaults.ingestionPriority",
  // Phase 132 — autonomous skill drafting (Hermes pattern). Both knobs
  // are read LAZILY at task-completion event emit time (Plan 02's
  // distiller dispatcher reads via SessionManager.getAgentConfig — no
  // cached session-boot capture). A clawcode.yaml edit takes effect on
  // the NEXT eligible `task.completed` event. Mirrors the Phase 999.43
  // closure-re-read pattern (types.ts:212-219). 13th application of
  // the additive-optional reloadable blueprint
  // (Phase 83/86/89/90/94/95/96/110/115/117/127/999.43).
  //
  // Known carry-over from Phase 999.43: boolean reloadable fields may
  // not hot-reload cleanly on every flipped-edge without daemon restart
  // — workaround is `systemctl restart clawcode` after toggling
  // `autonomousSkillDrafting`. Documented in CONTEXT.md §deferred for
  // Plan 05 SUMMARY.
  "agents.*.autonomousSkillDrafting",
  "defaults.autonomousSkillDrafting",
  "agents.*.skillDistiller",
  "defaults.skillDistiller",
  // Phase 999.42 capability C / CONTEXT D7 — the patch-suggest gate.
  // The coarse `*.skillDistiller` entries above already cover the whole
  // block (nested fields included); these explicit `suggestPatches`
  // paths are listed for grep-verifiability + intent — a clawcode.yaml
  // flip of `skillDistiller.suggestPatches` takes effect on the NEXT
  // distiller dispatch (read lazily via the closure-re-read blueprint —
  // 14th application). Same hot-reload caveat as autonomousSkillDrafting.
  "agents.*.skillDistiller.suggestPatches",
  "defaults.skillDistiller.suggestPatches",
  // Phase 137 Plan 04 — per-provider credentials hot-reload.
  //
  // RELOADABLE (different from the NON_RELOADABLE llmRuntime.backend
  // entry below): credentials can rotate hot. Operators rotate the
  // OpenAI API key in 1Password and edit clawcode.yaml; ConfigWatcher
  // delta detection invalidates the per-agent OpenAiCredentialsResolver
  // cache so the next turn re-resolves and picks up the new value
  // without daemon restart. The architectural distinction: backend
  // selection is captured into spawn-boot at agent restart (cannot
  // hot-swap), but credentials are resolved lazily at first spawn AND
  // cached at the resolver level — invalidating the resolver cache
  // (via `OpenAiCredentialsResolver.invalidateCache()`) forces the
  // next CodexQuery spawn to re-resolve.
  //
  // Wired through ConfigWatcher.onChange in src/manager/daemon.ts:
  // on `providers.openai.apiKeyPath` delta detection, the daemon
  // walks `openaiCredentialsRegistry` and calls invalidateCache() on
  // affected entries. Mirrors the SecretsResolver cache invalidation
  // pattern from Phase 999.10 Wave 3 (applySecretsDiff).
  //
  // Documentation-of-intent: the prefix entries (`agents.*.providers`,
  // `defaults.providers`) cover any future per-provider blocks (e.g.,
  // OpenAI org/project headers, Anthropic API key) that land in the
  // same shape. The differ's prefix classifier descends into children
  // automatically.
  "agents.*.providers",
  "agents.*.providers.openai",
  "agents.*.providers.openai.apiKeyPath",
  "defaults.providers",
  "defaults.providers.openai",
  "defaults.providers.openai.apiKeyPath",
  // Phase 138 — cap tuning is hot-reload; ConfigWatcher delta updates
  // the threshold without daemon restart. The `agents.*.providers` +
  // `defaults.providers` prefix entries above already cover these via
  // prefix descent; the explicit leaf entries are documentation-of-
  // intent so the reloadable surface is greppable per field.
  "agents.*.providers.anthropic.dailyCapUsd",
  "agents.*.providers.openai.dailyCapUsd",
  "defaults.providers.anthropic.dailyCapUsd",
  "defaults.providers.openai.dailyCapUsd",
  // Phase 138 Plan 05 D4 — `llmRuntime.failoverChain` is RELOADABLE
  // (planner extension to CONTEXT D4). The DISTINCTION from the
  // NON_RELOADABLE `llmRuntime.backend` entry below: `backend` is
  // captured into spawn-boot at agent restart, but `failoverChain` is
  // consumed by the failover CRON's pure-function tick (which reads
  // live config every minute) — never baked into a session handle. An
  // operator opting an agent in / out of failover edits clawcode.yaml;
  // the next cron tick observes the new chain with no restart. The
  // failover *override itself* lives in the `failover_state` SQLite
  // table (a separate runtime-state channel — CONTEXT D3), not config.
  "agents.*.llmRuntime.failoverChain",
  "defaults.llmRuntime.failoverChain",
  // Phase 999.171 — per-agent UX toggles. liveThinking only gates rendering
  // and the bridge reads it per message via sessionManager.getAgentConfig (no
  // cached state in a session handle), so an edit is hot. 999.178 R1 adds
  // statusPing, which the bridge also reads per message, so it stays hot under
  // this coarse prefix (no carve-out). The two session-start subpaths
  // (promptSuggestions, researchSubagents) are carved
  // out as restart-required in NON_RELOADABLE_FIELDS below; the more-specific
  // pattern wins in classifyField. This entry is the COARSE block prefix, not
  // an exact `.liveThinking` leaf, because a newly added block diffs as the
  // single leaf `agents.<name>.uxFeatures` — an exact leaf entry would
  // misreport the most common edit (turning the block on) as restart-required.
  // 999.172 — a whole block added or removed that SETS a session-start key is
  // classified restart-required by differ.ts `wholeBlockCarriesRestartKey`.
  "agents.*.uxFeatures",
]);

/**
 * Field path prefixes that require a daemon restart to take effect.
 */
export const NON_RELOADABLE_FIELDS: ReadonlySet<string> = new Set([
  "agents.*.model",
  "agents.*.workspace",
  // claude.ai connector entitlement — decides ENABLE_CLAUDEAI_MCP_SERVERS in the
  // spawn env and whether the claude-launch guard hook is registered; both are
  // frozen at session start. Restart the agent (or the daemon) to apply.
  "agents.*.claudeAiConnectors",
  "defaults.claudeAiConnectors",
  // Phase 142 follow-up — agent-optimizer config requires a daemon restart.
  // The `/clawcode-optimize` trigger resolves `agents.*.optimizer` off the
  // boot-time `resolvedAgents` const (daemon.ts), which the ConfigWatcher never
  // re-splices and ConfigReloader has no apply-path for. Rather than build a
  // hot-apply path (re-splicing boot state captured by many closures — more risk
  // than this opt-in, manually-triggered feature warrants), we classify it
  // restart-required so the differ reports an honest "requires restart" signal
  // instead of a misleading "config hot-reloaded". Operators enabling/disabling
  // the optimizer run: clawcode restart <agent>  (or restart the daemon).
  // Documentation-of-intent like the memoryPath entry below — the classifier
  // already falls through to reloadable:false for any non-RELOADABLE field; the
  // differ tests assert optimizer ends up reloadable:false.
  "agents.*.optimizer",
  "defaults.optimizer",
  // dashboard-rework — per-agent native plugins are captured into the spawn
  // argv / SDK options at session start; changing them needs an agent restart.
  "agents.*.plugins",
  // Quick 260715-j1j (D5) — nativeWorkflow subtracts "Workflow" from the
  // resolved disallowedTools, which is BAKED INTO the SDK session at
  // create/resume (session-adapter.ts) and into the v3 spawn argv + steer
  // prompts. A YAML flip cannot reach a live session. Documentation-of-intent
  // like the memoryPath entry below — the classifier already falls through
  // to reloadable:false for unclassified fields.
  "agents.*.nativeWorkflow",
  // Phase 75 SHARED-01 — memoryPath determines which memories.db / inbox/ /
  // heartbeat.log / session-state dir this agent owns. Swapping those at
  // runtime would require (a) closing the live MemoryStore + UsageTracker +
  // TraceStore, (b) re-opening against new paths, and (c) re-attaching the
  // chokidar InboxSource watcher and heartbeat runner — none of which are
  // implemented and all of which risk data loss. Operators must run
  // `systemctl stop clawcode && apply && systemctl start clawcode`.
  // The classifier falls through to `false` for any field not in
  // RELOADABLE_FIELDS, so this entry is documentation-of-intent; the
  // differ tests in differ.test.ts assert memoryPath ends up reloadable:false.
  "agents.*.memoryPath",
  // Phase 100 GSD-07 — settingSources + gsd.projectDir are SDK session-boot
  // baseOptions (cwd + settingSources at src/manager/session-adapter.ts:585-636
  // — see Plan 100-02). They are NOT re-read per turn. A clawcode.yaml edit
  // takes effect ONLY on the NEXT agent restart (`clawcode restart <name>`).
  // The classifier in differ.ts:144-149 already falls through to false for
  // unclassified paths; the explicit entries below match the Phase 75
  // SHARED-01 memoryPath documentation-of-intent pattern (line above).
  // Architectural rationale (RESEARCH.md Architecture Pattern 5): cwd is
  // captured into baseOptions when the SDK builds its query handle; mutating
  // the YAML after that point cannot reach the active session. Same for
  // settingSources, which controls which skills/commands/CLAUDE.md the SDK
  // scans at session start. 1st application of an agent-restart classification
  // in Phase 100 — the 11 prior phases (83/86/89/90/94/95/96) all classified
  // their additive fields as RELOADABLE. Operators wanting these to take
  // effect run: clawcode restart admin-clawdy
  "agents.*.settingSources",
  "defaults.settingSources",
  "agents.*.gsd",
  "agents.*.gsd.projectDir",
  "defaults.gsd",
  "defaults.gsd.projectDir",
  "defaults.model",
  "defaults.basePath",
  // Phase 115 sub-scope 2 — excludeDynamicSections is captured into the SDK's
  // baseOptions inside session-adapter.ts createSession / resumeSession when
  // the session is built; it is NOT re-read per turn. Same architectural
  // pattern as Phase 100's settingSources / gsd above. A clawcode.yaml edit
  // takes effect ONLY on the NEXT agent restart. Operators wanting an
  // immediate change must run: `clawcode restart <agent>`.
  "agents.*.excludeDynamicSections",
  "defaults.excludeDynamicSections",
  // WS-1 (999.99) — attributed-stream demux flag. Consumed once at session
  // build (buildEpoch wraps the raw driver iterator); a live edit cannot
  // rewire an existing epoch's reader, so flips are restart-applied. The
  // wiring commit documented NON-RELOADABLE but never registered it here —
  // without this entry the watcher couldn't report restart-required
  // honestly (999.99-F2 integration follow-up, 2026-07-24).
  "agents.*.delivery",
  "defaults.delivery",
  // Phase 115 sub-scope 5 (Plan 04) — cacheBreakpointPlacement is captured
  // into the assembled stable prefix at session create/resume time (the
  // marker placement is baked into systemPrompt.append). Same architectural
  // pattern as excludeDynamicSections above. A clawcode.yaml edit takes
  // effect ONLY on the NEXT agent restart. Operators wanting an immediate
  // change must run: `clawcode restart <agent>`.
  "agents.*.cacheBreakpointPlacement",
  "defaults.cacheBreakpointPlacement",
  // Phase 136 — llmRuntime.backend is captured into the SDK / backend
  // boot path at session start (createLlmRuntimeService → backend
  // constructor); it is NOT re-read per turn. Same architectural pattern
  // as Phase 117 advisor.backend (NON_RELOADABLE via the same set) and
  // Phase 999.54 mcpServers.alwaysLoad. A clawcode.yaml edit takes
  // effect ONLY on the NEXT agent restart. Operators wanting an
  // immediate change must run: `clawcode restart <agent>` (or the whole
  // daemon for fleet-wide). Doc-of-intent — the differ falls through
  // to false for unclassified paths, so the explicit entries mirror
  // the Phase 100 / Phase 115 precedent.
  "agents.*.llmRuntime",
  "agents.*.llmRuntime.backend",
  "defaults.llmRuntime",
  "defaults.llmRuntime.backend",
  // Phase 137 Plan 01 — codex sub-config is also NON_RELOADABLE:
  // the codex binary path is captured into spawn-env at agent boot
  // (the binaryPathPromise on the CodexAgentCli instance resolves
  // once via discoverCliBinary). Flipping requires `clawcode restart
  // <agent>`. Same boot-time-capture pattern as Phase 110
  // `shimRuntime`.
  "agents.*.llmRuntime.codex",
  "agents.*.llmRuntime.codex.pathToCodexExecutable",
  "defaults.llmRuntime.codex",
  "defaults.llmRuntime.codex.pathToCodexExecutable",
  // Phase 137 Plan 03 T-03 — codex.model is also NON_RELOADABLE.
  // CodexSdkModule reads config.llmRuntime.codex.model once at
  // query construction time and bakes it into the spawn argv;
  // YAML edits take effect on the next `clawcode restart`. Same
  // boot-time-capture pattern as pathToCodexExecutable above.
  "agents.*.llmRuntime.codex.model",
  "defaults.llmRuntime.codex.model",
  // Phase 999.54 (D-04) — mcpServers[].alwaysLoad is captured into the SDK's
  // baseOptions inside session-adapter.ts createSession / resumeSession via
  // transformMcpServersForSdk (Plan 01) when the session is built; it is NOT
  // re-read per turn. Same architectural pattern as Phase 100 GSD-07's
  // settingSources / gsd and Phase 115 sub-scope 2/5's excludeDynamicSections /
  // cacheBreakpointPlacement above. A clawcode.yaml edit takes effect ONLY on
  // the NEXT agent restart. Operators wanting an immediate change must run:
  // `clawcode restart <agent>`. The classifier in differ.ts:144-149 falls
  // through to `reloadable: false` for unclassified paths; the explicit
  // entries below match the documentation-of-intent precedent (grep target
  // for future maintainers + Plan 04 regression-test source-of-truth).
  // Phase 999.54 Plan 02 baked `alwaysLoad: true` into the auto-injected
  // `clawcode` server; Phase 999.162 removed that server-level pin (the hot
  // tools pin themselves per-tool via `_meta["anthropic/alwaysLoad"]` in
  // src/mcp/server.ts). Per-agent inline-object overrides still win via the
  // resolvedMcpMap.has("clawcode") gate.
  "defaults.mcpServers.*.alwaysLoad",
  "agents.*.mcpServers.*.alwaysLoad",
  // Per-agent OS sandbox (bubblewrap). The bind-plan + bwrap argv are computed
  // at session-config time and frozen into the child spawn (argv + environ are
  // fixed at fork) — identical boot-capture reason as the other spawn-time
  // settings above. A `clawcode reload` cannot wrap (or unwrap) an already-spawned
  // claude in a mount namespace; flips require `clawcode restart <agent>`.
  "agents.*.sandbox",
  "agents.*.sandbox.enabled",
  "agents.*.sandbox.allowRuntimeOp",
  "defaults.sandbox",
  "defaults.sandbox.enabled",
  "defaults.sandbox.allowRuntimeOp",
  // Phase 135 Plan 01 — per-agent voice config block.
  // Voice channel state (joinVoiceChannel result, AudioPlayer subscription,
  // Deepgram WS, ElevenLabs streaming session) is captured at session boot
  // via VoiceManager.autoJoin (Plan 02). Hot-swapping the voice block at
  // runtime would require (a) tearing down the live VoiceConnection, (b)
  // closing the Deepgram WS, (c) re-resolving the op:// keys, and (d)
  // re-joining — all of which have user-visible side effects (the bot
  // briefly leaves and rejoins the channel; in-flight transcripts are
  // dropped). Operators wanting an immediate change must restart the
  // agent. Mirrors the Phase 117 advisor.backend / Phase 100 settingSources
  // / Phase 136 llmRuntime.backend boot-time-capture pattern above.
  "agents.*.voice",
  // Phase 999.171 — the two session-start UX toggles (999.172 prompt
  // suggestions, 999.173 research subagents) are captured when the session
  // starts, so an edit needs `clawcode restart <agent>`. These MORE-SPECIFIC
  // subpaths beat the coarse RELOADABLE uxFeatures block entry above;
  // liveThinking stays hot. promptSuggestions is consumed since 999.172;
  // researchSubagents is inert until 999.173.
  "agents.*.uxFeatures.promptSuggestions",
  "agents.*.uxFeatures.researchSubagents",
  // Phase 999.173 — research-subagent knobs ride the session-start `agents`
  // option, so an edit needs `clawcode restart <agent>`.
  "agents.*.research",
]);
