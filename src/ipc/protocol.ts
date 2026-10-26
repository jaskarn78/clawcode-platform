import { z } from "zod/v4";

/**
 * Supported IPC methods for CLI-to-daemon communication.
 * Maps to D-05: start, stop, restart, start-all, status.
 */
export const IPC_METHODS = [
  // Lifecycle
  "start",
  "stop",
  "restart",
  "start-all",
  "stop-all",
  "status",
  // Observability
  "routes",
  "rate-limit-status",
  "heartbeat-status",
  "schedules",
  "skills",
  "threads",
  "usage",
  "context-zone-status",
  "episode-list",
  "delivery-queue-status",
  "mcp-servers",
  // Phase 85 Plan 01 TOOL-01 — per-agent MCP state snapshot from the
  // SessionManager state map (fed by the warm-path readiness probe +
  // the `mcp-reconnect` heartbeat). Read by Plan 03's `/clawcode-tools`
  // slash command and by operators verifying live tool health.
  "list-mcp-status",
  // Phase 94 Plan 01 TOOL-01 — on-demand capability probe trigger.
  // Operators run `clawcode mcp-probe -a <agent>` to force an immediate
  // probe of all configured MCP servers (boot + heartbeat schedule
  // continues unaffected). Writes results back via setMcpStateForAgent
  // and returns the resulting capabilityProbe entries to the caller.
  "mcp-probe",
  // Phase 94 Plan 05 TOOL-08 / TOOL-09 — built-in Discord helpers wired
  // through the clawcode MCP server. The MCP tool handlers in
  // src/mcp/server.ts forward to these IPC methods so the daemon owns
  // the discord.js client + WebhookManager singletons (same pattern as
  // send-attachment / read-thread).
  "fetch-discord-messages",
  "share-file",
  // Phase 999.128 — named workflow templates listing (backs the
  // `workflow_templates` MCP tool + `clawcode workflows templates`).
  "list-workflow-templates",
  // Phase 999.130 — weekly fleet report card on demand (CLI / dashboard).
  "report-card",
  // Phase 999.132 — per-client fact vault (<workspace>/clients/<slug>/facts.json).
  "client-fact-set",
  "client-facts",
  // Phase 91 Plan 05 SYNC-08 — OpenClaw↔ClawCode sync snapshot. Reads
  // ~/.clawcode/manager/sync-state.json (authoritativeSide, open conflicts,
  // perFileHashes) and the last line of ~/.clawcode/manager/sync.jsonl
  // (last cycle outcome). Consumed by the /clawcode-sync-status inline
  // slash handler in slash-commands.ts — zero LLM turn cost, daemon-routed.
  "list-sync-status",
  // Phase 103 OBS-06 — per-agent OAuth Max rate-limit snapshots (NOT the
  // Discord outbound rate-limiter — that's the existing "rate-limit-status"
  // IPC at line 17, which is a SEPARATE domain). Reads the per-agent
  // RateLimitTracker constructed by SessionManager.startAgent. Consumed by
  // the /clawcode-usage Discord slash command + /clawcode-status session/
  // weekly bar suffix (Plan 03).
  "list-rate-limit-snapshots",
  // Phase 116-postdeploy 2026-05-11 — fleet aggregate over per-agent
  // RateLimitTracker. Loops manager.getRunningAgents() and calls the
  // single-agent handler internally. Backs GET /api/usage on the SPA's
  // Usage page (subscription utilization surface).
  "list-rate-limit-snapshots-fleet",
  // Phase 115 Plan 05 — lazy-load memory tools backing the agent-facing
  // clawcode_memory_* MCP tools (search / recall / edit / archive). Each
  // resolves into the per-agent MemoryStore with cross-agent isolation
  // enforced at this resolution layer. The MCP tool surface called these
  // IPC methods via `sendIpcRequest` but the allowlist had not picked
  // them up — caught 2026-05-12 by the protocol-daemon-parity sentinel.
  "clawcode-memory-search",
  "clawcode-memory-recall",
  "clawcode-memory-edit",
  "clawcode-memory-archive",
  // Memory overhaul 2026-10-25 (WP5) - corrections on saved memories:
  // forget retires a row (superseded_by = "forgotten"); update inserts the
  // new content and marks the old row superseded by it. Backs the
  // clawcode_memory_forget / clawcode_memory_update MCP tools.
  "clawcode-memory-forget",
  "clawcode-memory-update",
  // Phase 999.14 MCP-10 — operator escape hatches for the stale-binding
  // sweep. `threads-prune-stale` runs the sweep on demand with an
  // operator-supplied threshold; `threads-prune-agent` force-prunes ALL
  // bindings for one agent without calling Discord. Same parity-drift
  // class as the clawcode-memory-* methods above.
  "threads-prune-stale",
  "threads-prune-agent",
  // Quick 260511-pw3 — schema-registry introspection for cross-agent
  // typed delegations. Returns the target's accepted schemas with
  // `callerAllowed` + `registered` flags so the sender's LLM can choose
  // a valid schema before calling `delegate_task`. Same parity-drift
  // class — backed the new `list_agent_schemas` MCP tool but the wire
  // allowlist had not picked it up.
  "list-agent-schemas",
  // Messaging
  // Phase 999.2 Plan 02 D-RNI-IPC-01 / D-RNI-IPC-02 — canonical IPC names
  // (ask-agent, post-to-agent) registered FIRST; old names retained as
  // back-compat aliases so existing CLI tools and external IPC consumers
  // continue to work. Daemon switch handles both via stacked-case form
  // (RESEARCH.md §Pattern 2). Soft removal slated ~30 days post-deploy
  // (D-RNX-03) once operator confirms no agent SOUL/SKILL still references
  // them — operators grep daemon logs for `deprecated.*alias.*used` to
  // confirm the trigger.
  "ask-agent",
  "send-message", // DEPRECATED — use ask-agent (Phase 999.2 D-RNI-IPC-01); kept for back-compat
  "post-to-agent",
  "send-to-agent", // DEPRECATED — use post-to-agent (Phase 999.2 D-RNI-IPC-02); kept for back-compat
  "send-attachment",
  // /clawcode-goal — autonomous "run until the condition is met" loop on the
  // channel's agent (set / status / clear).
  "goal-set",
  "goal-status",
  "goal-clear",
  // Backlog 999.95 — push live HTML (or a URL) to the dashboard preview store
  // and, on the first push of an id, post a one-tap Discord activity-launch
  // button. MCP tool `show_preview` → this verb → daemon closure-intercept
  // handler (the switch BEFORE routeMethod, which captures previewStore +
  // discordBridgeRef). Newline-safe over IPC (JSON.stringify escapes embedded
  // \n); payload is size-capped in the tool (zod) AND the handler. Without
  // this allowlist entry ipcRequestSchema rejects it -32600 (the
  // silent-path-bifurcation lesson repeated throughout this file).
  "show-preview",
  "slash-commands",
  "webhooks",
  // Phase 999.117 WS-6 — `clawcode a2a status`. Reports the loop governor's
  // resolved thresholds, tracked conversations, open circuit breakers and
  // dedupe size.
  "a2a-status",
  "fork-session",
  // Memory
  "memory-search",
  "memory-lookup",
  "memory-list",
  "memory-graph",
  "memory-save",
  // Phase 999.113 WS-7 (2026-08-28) — operator-triggered consolidation.
  // Until now `runConsolidation` was reachable ONLY from the 03:00 cron, so
  // the first fleet-wide run after the WS-3 fix could be neither previewed nor
  // staged, and "did consolidation work?" required reading JSONL on the box.
  // Preview (default) is a pure read; `run: true` executes the same code path
  // the cron uses.
  "consolidate-now",
  // Phase 107 VEC-CLEAN-03 — operator-driven orphan cleanup. Removes
  // vec_memories rows whose memory_id no longer exists in `memories`
  // (orphans accumulated from historical CHECK-constraint table-recreation
  // migrations or any future delete path that bypasses MemoryStore.delete).
  // Backs `clawcode memory cleanup-orphans [-a <agent>]`. Daemon-side
  // dispatch is a closure intercept BEFORE routeMethod that resolves
  // MemoryStore via manager.getMemoryStore(agent) and calls
  // store.cleanupOrphans() per agent. Returns { results: [...] }.
  "memory-cleanup-orphans",
  // Phase 999.119 — memory integrity doctor. Read-only census of rows that
  // reference a memory/chunk which no longer exists (the FK traps behind
  // the 2026-09 auto-linker / tier-maintenance failures); `repair: true`
  // removes them, imports legacy cold-archive files back into the store
  // and runs PRAGMA optimize. Backs `clawcode memory doctor [-a] [--repair]`.
  "memory-doctor",
  // Phase 115 D-08 — embedding-v2 migration IPC surface. Operator-driven
  // via `clawcode memory migrate-embeddings <subcommand>` CLI. Each one
  // takes `agent` (single agent) or omits it (all agents). State machine
  // lives in src/memory/migrations/embedding-v2.ts; daemon-side handlers
  // construct EmbeddingV2Migrator per-agent on each call (no shared
  // singleton — Phase 90 per-agent isolation lock).
  "embedding-migration-status",
  "embedding-migration-transition",
  "embedding-migration-pause",
  "embedding-migration-resume",
  // Phase 999.8 follow-up — operator-triggered tier-maintenance backfill.
  // Runs the same `TierManager.runMaintenance()` the heartbeat runs every
  // 6h, but on-demand for one agent or all agents at once. Used to seed
  // hot/cold tier distribution after the Phase 107 heartbeat-discovery
  // fix without waiting for the next scheduled tick.
  "tier-maintenance-tick",
  // Subagent threads
  "spawn-subagent-thread",
  "cleanup-subagent-thread",
  // Phase 999.25 — explicit work-completion signal from the subagent.
  // Decouples relayCompletionToParent from session-end so operators see
  // results in their channel within seconds of work-done, not hours
  // later when the session is finally stopped. Handler looks up the
  // calling agent's binding by sessionName, skips if no binding (silent
  // no-op for operator agents that mistakenly call this), skips if
  // already completed (idempotent), else fires relay + sets
  // binding.completedAt.
  "subagent-complete",
  // Post a Discord Components v2 (CV2) embed to the agent's bound
  // channel. Handler in daemon.ts forwards to bridge.postCv2ToAgentChannel
  // which sends via client.rest.post(Routes.channelMessages) — bypassing
  // discord.js's MessagePayload.resolveBody (it would inject `content:
  // ''` and `embeds: []` which Discord rejects when IsComponentsV2 is
  // set). Spec validated by zod schema in the MCP tool surface
  // (src/mcp/server.ts post_cv2_embed). Without this entry the IPC schema
  // gate (ipcRequestSchema.safeParse below) rejects every call with
  // `{ code: -32600, message: "Invalid Request" }` — exactly the
  // silent-path-bifurcation class called out in feedback_silent_path_bifurcation
  // (CV2 was the latest victim).
  "post-cv2-embed",
  // Auto-steer (2026-05-23) — parent agent → subagent mid-flight
  // redirection without cancel-and-respawn. Handler runs the steer prep
  // (interrupt + reset relay gates) and posts the framed guidance into
  // the subagent's thread; bridge's auto-steer trigger then picks it up
  // and drives the next subagent turn through the normal dispatch
  // pipeline. The bot-authored steer post is whitelisted by the
  // bridge's `pendingSteerMessageIds` set so it isn't filtered.
  "steer-subagent",
  "read-thread",
  "message-history",
  // Phase 100 follow-up — operator/agent-driven Discord thread archive.
  // Closes the "no archive tool" capability gap raised 2026-04-26 + auto-prunes
  // the registry binding so maxThreadSessions accounting stays correct.
  "archive-discord-thread",
  // Phase 100 follow-up — operator-surfaced 2026-04-27. Backs the
  // `schedule_reminder` MCP tool that lets agents set ad-hoc one-off
  // reminders firing as standalone turns (delivered via the f984008
  // trigger-delivery callback). Daemon-side handler invokes
  // schedulerSource.addOneShotReminder. In-memory only — does not survive
  // daemon restart.
  "schedule-reminder",
  // Phase 999.99 — runtime recurring-poll primitive. Backs the
  // `schedule_recurring` + `cancel_schedule` MCP tools so an agent told
  // "poll X every 5 min" registers a delivered recurring schedule whose
  // every tick posts a standalone Discord message (via the f984008
  // trigger-delivery callback) instead of self-firing a turn that buffers
  // in driverIter. Daemon-side handlers invoke
  // schedulerSource.addRecurringSchedule / cancelRecurring. Without these
  // allowlist entries ipcRequestSchema rejects them -32600 (the
  // silent-path-bifurcation gate repeated throughout this file).
  "schedule-recurring",
  "cancel-schedule",
  // Security (Phase 27)
  "approve-command",
  "deny-command",
  "allow-always",
  "check-command",
  "update-security",
  "security-status",
  // Model tiering (Phase 39)
  "ask-advisor",
  // 999.147 — CLI path for the relief action behind the MemoryGuard button.
  // Routed through the daemon rather than killing from the CLI process so the
  // pid-reuse / cgroup-membership / not-the-daemon checks and the audit trail
  // are the SAME code for both surfaces. (A CLI-side cgroup check would
  // resolve the CLI's own cgroup, not the fleet's, and fail closed on
  // everything.) Params: {pid, startTicks?, actor?}.
  "memory-relieve",
  // 999.160 v1.2 — `clawcode icons sync`: upload cc_*.png as application emojis through the bridge. Params: {icons: [{name, png(base64)}]}.
  "discord-sync-icons",
  "set-model",
  // Phase 117 Plan 117-11 — operator-driven per-channel verbose-level toggle
  // for advisor visibility. Backs the /clawcode-verbose slash command in
  // src/discord/slash-commands.ts (handleVerboseSlash). Daemon-side handler
  // upserts via VerboseState.setLevel and returns {level, updatedAt}; the
  // Discord bridge consumes the resulting state at the single mutation
  // point seeded by 117-09 (bridge.ts:~810). Operator-scope (admin-only
  // slash command, ephemeral replies) — see slash-types.ts entry with
  // defaultMemberPermissions:"0".
  "set-verbose-level",
  "set-verification",
  // Phase 999.164 — /clawcode-quick per-agent quick-lane toggle (persisted).
  "set-fast-lane",
  // Phase 999.171 — /clawcode-ux per-agent UX feature toggle (persisted).
  "set-ux-feature",
  "verify-claim",
  // Phase 87 CMD-02 — live SDK permission-mode swap via Query.setPermissionMode.
  "set-permission-mode",
  // Phase 88 MKT-01..07 — marketplace list / install / remove routed through
  // the pure-exported-handler blueprint (Phase 86 Plan 02). Returns typed
  // outcomes consumed by the Discord /clawcode-skills-browse + /clawcode-skills
  // inline handlers.
  "marketplace-list",
  "marketplace-install",
  "marketplace-remove",
  // Phase 90 Plan 05 HUB-02 / HUB-04 — ClawHub plugin listing + install.
  // Parallel to marketplace-list/install but routes through the ClawHub
  // plugin registry (not the skill flow) and writes to agents[*].mcpServers
  // via updateAgentMcpServers (yaml-writer.ts).
  "marketplace-list-plugins",
  "marketplace-install-plugin",
  // Phase 90 Plan 06 HUB-05 / HUB-07 — install-time config UX primitives.
  //   clawhub-oauth-start:  kick off GitHub device-code flow + return user_code
  //   clawhub-oauth-poll:   long-lived poll (up to 15min) that stores token in 1P
  //   marketplace-probe-op-items: 1Password op:// rewrite proposal for one field
  "clawhub-oauth-start",
  "clawhub-oauth-poll",
  "marketplace-probe-op-items",
  // Cost tracking (Phase 40)
  "costs",
  // Latency (Phase 50)
  "latency",
  // Bench (Phase 51)
  "bench-run-prompt",
  // Cache (Phase 52)
  "cache",
  // Tools (Phase 55)
  "tools",
  // Effort (reasoning level)
  "set-effort",
  "get-effort",
  // Document RAG (Phase 49)
  //
  // Phase 101 Plan 02 T04 — `ingest-document` request shape extended
  // (params are passed loose `Record<string, unknown>` over the wire,
  // so this lives as documentation rather than a runtime guard):
  //   {
  //     agent: string;
  //     file_path: string;
  //     source?: string;
  //     taskHint?: 'standard' | 'high-precision';
  //     extract?: 'text' | 'structured' | 'both';
  //     schemaName?: 'taxReturn';
  //     backend?: 'tesseract-cli' | 'tesseract-wasm' | 'claude-haiku' |
  //              'claude-sonnet' | 'mistral' | 'none';
  //     force?: boolean;
  //   }
  // Response: {
  //   ok: true;
  //   source: string;
  //   chunks_created: number;
  //   total_chars: number;
  //   structured?: unknown;   // when extract !== 'text'
  //   paths: { textMd: string; structuredJson?: string };
  //   telemetry: IngestTelemetry;
  // }
  "ingest-document",
  // Phase 999.43 Plan 02 T01 — Discord-attachment auto-ingest dispatcher.
  // Fire-and-forget call site (bridge.ts) writes a `documents` row with
  // full D-04 provenance after the Phase 101 engine + cross-ingest succeed.
  // Distinct from `ingest-document` (manual / operator-driven) per
  // feedback_silent_path_bifurcation.md — single auto-ingest entry point.
  // Request shape:
  //   {
  //     agent: string;
  //     file_path: string;
  //     filename: string;
  //     mime_type: string | null;
  //     size: number;
  //     vision_analysis: string | null;
  //     channel_id: string;
  //     message_id: string;
  //     user_id: string;
  //     user_name: string;
  //   }
  // Response (skip): { ok: true, skipped: true, reason: string }
  // Response (ok):   { ok: true, skipped: false, source, chunks_created,
  //                    content_class, agent_weight, content_weight }
  // Response (err):  { ok: false, skipped: false, error: string }
  "auto-ingest-attachment",
  // Phase 999.154 — run the real-provider vision canary now:
  //   Response: { ok, providers: {id: passed}, health: {id: snapshot} }
  "vision-canary",
  // Phase 999.154 WS-5 — strip stored fake vision analyses (dry-run unless
  // apply). Params: { agent?: string, apply?: boolean }
  //   Response: { apply, reports: CleanupReport[] }
  "vision-cleanup",
  // Phase 999.43 Plan 04 — three override surfaces (Discord emoji, MCP
  // tool, CLI) converge on ONE daemon write path per
  // feedback_silent_path_bifurcation.md.
  //
  //   set-doc-priority             — by source filepath (MCP + CLI)
  //   set-doc-priority-by-message  — by Discord message_id (emoji branch)
  //   reclassify-docs              — bulk glob rule (CLI only)
  //
  // D-08 sandbox is enforced at the daemon handler (Layer-2 defense-in-
  // depth) based on a `who: "operator"|"agent"` discriminator. The MCP
  // tool's `z.enum(["medium","low"])` schema is Layer-1 (Phase 999.43 D-08
  // LOCKED VERBATIM — agents cannot escalate own doc beyond MEDIUM).
  //
  // Request shapes:
  //   set-doc-priority:            { agent, source, level: high|medium|low,
  //                                  who: operator|agent, callerAgent?,
  //                                  reason? }
  //   set-doc-priority-by-message: { agent, message_id, level, who,
  //                                  callerAgent?, reason? }
  //   reclassify-docs:             { agent, rule: "<pattern>=<level>",
  //                                  who: operator }
  //
  // Responses:
  //   set-doc-priority(-by-message):  { ok:true,  source, old_level,
  //                                     new_level, who }
  //                                   { ok:false, error }
  //   reclassify-docs:                { ok:true,  updated: number }
  "set-doc-priority",
  "set-doc-priority-by-message",
  "reclassify-docs",
  "search-documents",
  "delete-document",
  "list-documents",
  // Agent provisioning
  "agent-create",
  // Cross-agent RPC / handoffs (Phase 59)
  "delegate-task",
  "task-status",
  "cancel-task",
  "task-complete",
  "task-retry",
  // Observability (Phase 63)
  "list-tasks",
  // OpenAI-compatible endpoint key management (Phase 69)
  "openai-key-create",
  "openai-key-list",
  "openai-key-revoke",
  // Phase 116-postdeploy 2026-05-12 — read-only endpoint info for the new
  // dashboard /openai page. Returns `{enabled, host, port}` so the SPA can
  // render the base URL + curl example without hardcoding port 3101.
  "openai-endpoint-info",
  // Phase 116-postdeploy 2026-05-12 — list recent dream-pass artefacts
  // for the new dashboard /memory page. Reads memory/dreams/*.md under
  // an agent's memoryPath and returns recent files with parsed dates +
  // body previews. Pure file-scan; no DB hit.
  "list-dream-artifacts",
  // Browser automation MCP (Phase 70) — routes per-agent tool calls from
  // the out-of-process `clawcode browser-mcp` subprocess to the daemon's
  // shared BrowserManager + the pure handlers in src/browser/tools.ts.
  "browser-tool-call",
  // Web search MCP (Phase 71) — routes per-agent tool calls from the
  // out-of-process `clawcode search-mcp` subprocess to the daemon's
  // shared BraveClient/ExaClient + URL fetcher + the pure handlers in
  // src/search/tools.ts.
  "search-tool-call",
  // Image generation MCP (Phase 72) — routes per-agent tool calls from
  // the out-of-process `clawcode image-mcp` subprocess to the daemon's
  // shared image provider clients + the pure handlers in
  // src/image/tools.ts.
  "image-tool-call",
  // Phase 145 WS3 — platform-neutral interactive prompt. Routes the
  // `ask_user_question` MCP tool (Plan 04) from the agent's MCP subprocess to
  // the daemon, which resolves the agent's bound channel + platform and
  // dispatches a native prompt (Discord buttons / Slack Block Kit) or the
  // universal text fallback, then blocks (daemon-side bounded timeout) until
  // the channel operator answers. Mirrors the browser/search/image-tool-call
  // MCP→daemon→side-effect→result round-trip. Param/result types declared in
  // src/ipc/types.ts (IpcAskUserQuestionParams / IpcAskUserQuestionResult).
  // Without this allowlist entry ipcRequestSchema rejects the method -32600.
  "ask-user-question",
  // Phase 145 WS2 (Plan 05) — background workflow orchestrator. Routes the
  // `start_workflow` MCP tool (this plan) from the agent's MCP subprocess to
  // the daemon, which resolves the agent's config, validates the spec, and
  // launches a daemon-side BACKGROUND job (WorkflowOrchestrator.launchWorkflow):
  // it allocates a `wf_…` id synchronously, fans workers out (each with the
  // lifted maxTurnDurationMs ceiling + reaper-survival binding), and the daemon
  // RETURNS THE ID IMMEDIATELY — does NOT await worker completion. That fast
  // return is the SC-2 turn-decoupling: the triggering turn settles in seconds,
  // so no turn watchdog ever spans the workflow's wall-clock duration. Param/
  // result types in src/ipc/types.ts (IpcStartWorkflowParams / Result).
  // Without this allowlist entry ipcRequestSchema rejects the method -32600.
  "start-workflow",
  // Phase 999.165 — stop a workflow or one of its steps (ownership-checked).
  "cancel-workflow",
  // Phase 999.165 — steer a running workflow / edit its plan (ownership-checked).
  "steer-workflow",
  "edit-workflow",
  // 2026-06-26 — pull-based workflow status (the daemon analog of Claude Code's
  // `/workflows`). Read-only `WorkflowOrchestrator.listWorkflows` projection
  // for the `/clawcode-workflows` slash command + dashboard panel. Optional
  // `{ agent }` filter. Without this allowlist entry ipcRequestSchema rejects
  // the method -32600 (the silent-path-bifurcation trap — verb needs BOTH a
  // daemon dispatch case AND this allowlist entry).
  "workflow-status",
  // Phase 92 Plan 04 CUT-06 / CUT-07 — destructive-fix admin-clawdy embed
  // surface. Two IPC methods:
  //   - cutover-verify-summary: returns DestructiveCutoverGap[] for the
  //     /clawcode-cutover-verify slash command's embed batch render
  //   - cutover-button-action: handles Accept/Reject/Defer routed from
  //     the slash-commands.ts button collector with customId prefix
  //     `cutover-`. Closure-based intercept BEFORE routeMethod (mirrors
  //     marketplace handler pattern in daemon.ts ~line 2185).
  "cutover-verify-summary",
  "cutover-button-action",
  // Phase 92 Plan 06 GAP CLOSURE — operator-facing CLI ↔ daemon wiring for
  // CUT-09 + CUT-10. The CLI scaffolds in `src/cli/commands/cutover-verify.ts`
  // and `cutover-rollback.ts` no longer return exit-1 stubs; they connect to
  // the daemon via these IPC methods so the full pipeline (ingest → profile
  // → probe → diff → apply-additive → canary → report) and LIFO ledger
  // rewind are invocable from the operator CLI.
  //
  //   - cutover-verify:   runs runVerifyPipeline with production-wired DI
  //                       (turnDispatcher / dispatchStream / fetchApi /
  //                       listMcpStatus) and writes CUTOVER-REPORT.md.
  //                       Returns {cutoverReady, gapCount, canaryPassRate,
  //                       reportPath}.
  //   - cutover-rollback: reads cutover-ledger.jsonl, filters rows newer
  //                       than ledgerTo, reverses each in LIFO order via
  //                       Phase 86 atomic YAML writers + filesystem unlink
  //                       + destructive snapshot restore. Appends NEW
  //                       rollback rows (append-only invariant preserved).
  //                       Returns {rewoundCount, errors[]}.
  "cutover-verify",
  "cutover-rollback",
  // Phase 95 Plan 03 DREAM-07 — operator-driven dream-pass trigger.
  // Backs both `clawcode dream <agent>` (CLI) and `/clawcode-dream`
  // (Discord slash, admin-only). Daemon-side handler builds DI deps
  // (runDreamPass + applyDreamResult + isAgentIdle) at the edge and
  // returns {outcome: DreamPassOutcome, applied: DreamApplyOutcome,
  // agent, startedAt}. See src/manager/daemon.ts handleRunDreamPassIpc.
  "run-dream-pass",
  // Phase 142 — operator-driven agent-optimizer trigger. Backs /clawcode-optimize
  // (Discord slash, admin-only). Daemon edge builds DI deps + calls
  // handleRunAgentOptimizationIpc; the measured loop stages proposals for review.
  "run-agent-optimization",
  // Phase 96 Plan 05 D-03 — operator-driven filesystem capability probe
  // refresh. Backs both `clawcode probe-fs <agent>` (CLI) and
  // `/clawcode-probe-fs` (Discord slash, admin-only). Daemon-side handler
  // resolves fileAccess for the agent, runs runFsProbe (96-01), persists
  // snapshot via writeFsSnapshot, and returns FsProbeOutcome to caller.
  // See src/manager/daemon-fs-ipc.ts handleProbeFsIpc.
  "probe-fs",
  // Phase 96 Plan 05 D-04 — read-only FS capability snapshot for operator
  // inspection. Backs `clawcode fs-status -a <agent>` (CLI) and the
  // /clawcode-status Capability section render. Reads the persisted
  // fs-capability.json without re-probing. Mirrors list-mcp-status.
  "list-fs-status",
  // Phase 100 follow-up — runtime gsd.projectDir override. Backs the
  // /gsd-set-project Discord slash command. Persists to
  // ~/.clawcode/manager/gsd-project-overrides.json (atomic temp+rename) +
  // splices a new ResolvedAgentConfig into the daemon's resolvedAgents
  // array + calls manager.restartAgent so the new SDK session boots with
  // the new gsd.projectDir as cwd. Returns {ok, agent, projectDir}.
  "set-gsd-project",
  // Phase 104 — secret cache observability + manual invalidation.
  // `secrets-status` returns the SecretsResolver counter snapshot
  // (cacheSize, hits, misses, retries, rateLimitHits, last*) so operators
  // can render cache health in /clawcode-status. `secrets-invalidate`
  // flushes one URI (when params.uri provided) or the entire cache,
  // closing the manual-rotation gap from Phase 104 Pitfall 3.
  "secrets-status",
  "secrets-invalidate",
  // WS-5 (2026-08-28) — `secrets-refresh` forces a LIVE re-read of one URI
  // (params.uri) or of every held secret: drops the in-memory cache entry AND
  // the last-known-good entry, then resolves. Needed because with
  // `defaults.secrets.lkgFreshMs` > 0 a plain invalidate is undone by the
  // next resolve serving the still-fresh LKG value.
  "secrets-refresh",
  // Phase 106 TRACK-CLI-01 — restore mcp-tracker IPC. Plan 999.15-03
  // wired the daemon dispatch (daemon.ts case branch), the CLI client
  // (src/cli/commands/mcp-tracker.ts), and the handler
  // (src/manager/mcp-tracker-snapshot.ts) — but missed THIS enum entry,
  // so `ipcRequestSchema.safeParse` rejected the method with -32600
  // "Invalid Request" before dispatch ever ran. Direct mirror of
  // commit a9c39c7 (Phase 96-05 same regression for probe-fs +
  // list-fs-status).
  "mcp-tracker-snapshot",
  // Phase 109-D — fleet-wide observability snapshot. Returns FleetStatsData
  // (cgroup memory pressure + claude proc drift + per-MCP-type RSS aggregate).
  // Read-only; safe to poll. Linux-only signals degrade to null on hosts
  // without /proc or cgroup v2 — never throws.
  "fleet-stats",
  // Phase 109-A — per-pool 1Password broker status snapshot (rps + throttle
  // counters + last Retry-After). Decoupled from the heartbeat narrow
  // surface; consumed by `clawcode broker-status` CLI for live operator
  // visibility into 1P quota pressure across the fleet.
  "broker-status",
  // Phase 999.84 Plan 01 — debug-only PTY write to a v3 agent's
  // `claude --channels` PTY stdin. Gated behind the
  // `CLAWCODE_DEBUG_PTY_WRITE=1` env var on the daemon process; off → returns
  // `{ skipped: true, reason: "flag-off" }` without touching the agent.
  // Used ONLY to run the parent-channel turn-trigger discriminating
  // experiment (write PTY text to a running v3 parent → observe whether a
  // turn fires). See `999.84-RESEARCH.md`. NEVER called by production code.
  "debug-pty-write",
  // Phase 110 Stage 0b 0B-RT-13 — daemon-side IPC method that returns the
  // current TOOL_DEFINITIONS for a given shim type, JSON-Schema-converted
  // from the existing TypeScript Zod definitions in
  // src/{search,image,browser}/tools.ts. Future Wave 2-4 Go shims call
  // this at boot to fetch tool schemas, keeping Zod single-sourced (no
  // schema duplication into Go). Sequencing constraint (CONTEXT.md):
  // ships in its own commit BEFORE any Go shim builds against it.
  "list-mcp-tools",
  // Phase 115 Plan 07 sub-scope 15 — tool-cache management IPC (folds
  // Phase 999.40). Operator-facing introspection + maintenance. Wired
  // from `clawcode tool-cache {status|clear|inspect}` CLI subcommands
  // in T04. Daemon-side handlers live in src/manager/daemon.ts ~line
  // 3260 (early intercepts before routeMethod).
  "tool-cache-status",
  "tool-cache-clear",
  "tool-cache-inspect",
  // Phase 116-03 — Tier 1.5 operator workflow IPC methods (F26/F27/F28).
  // Handlers live in src/manager/daemon.ts in the closure-intercept block
  // labeled "Phase 116-03". REST proxies in src/dashboard/server.ts in the
  // "=== Phase 116-03 routes ===" block.
  "get-agent-config",
  "update-agent-config",
  "hot-reload-now",
  "search-conversations",
  "list-recent-conversations",
  "list-tasks-kanban",
  "create-task",
  "transition-task",
  // Phase 116-04 — Tier 2 deep-dive IPC methods (F11-F15).
  // Handlers live in src/manager/daemon.ts in the closure-intercept block
  // labeled "Phase 116-04". REST proxies in src/dashboard/server.ts in the
  // "=== Phase 116-04 routes ===" block.
  //
  //   list-recent-turns   -> F11 drawer transcript (last N conversation_turns)
  //   get-turn-trace      -> F12 trace waterfall (trace_spans for one turn_id)
  //   list-ipc-inboxes    -> F13 cross-agent IPC inbox + delivery snapshot
  //   get-memory-snapshot -> F14 memory tier counts + tier-1 file previews
  //                          (READ-ONLY per 116-DEFERRED — no in-UI editor)
  //   get-dream-queue     -> F15 dream-pass events + D-10 pending vetos
  //   veto-dream-run      -> F15 operator-fired veto on a pending window
  "list-recent-turns",
  "get-turn-trace",
  "list-ipc-inboxes",
  "get-memory-snapshot",
  "get-dream-queue",
  "veto-dream-run",
  // Phase 999.188 — operator approval closes the veto window and applies now.
  "approve-dream-run",
  // Phase 116-05 — Fleet-scale + cost (F16/F17).
  // Handlers live in src/manager/daemon.ts in the closure-intercept block
  // labeled "Phase 116-05". REST proxies in src/dashboard/server.ts in
  // the "=== Phase 116-05 routes ===" block.
  //
  //   costs-daily   -> F17 per-day cost trend rows for the cost dashboard
  //                    (extends the existing `costs` aggregate handler).
  //   budget-status -> F17 EscalationBudget gauges — token usage per
  //                    period (daily/weekly) per agent per model, alongside
  //                    the configured limit. Tokens-not-USD by schema; the
  //                    cost dashboard renders these on a separate row from
  //                    the USD spend cards. See 116-05-SUMMARY decisions.
  "costs-daily",
  "budget-status",
  // Phase 116-06 — Tier 3 polish IPC methods (F18/F20/F22/F23 + telemetry).
  // Handlers live in src/manager/daemon.ts in the closure-intercept block
  // labeled "Phase 116-06". REST proxies in src/dashboard/server.ts in the
  // "=== Phase 116-06 routes ===" block.
  //
  //   activity-by-day        -> F18 + F22 activity heatmap (turn count per
  //                             (date, agent) bucket within the window;
  //                             fleet aggregate sums client-side).
  //   list-dashboard-audit   -> F23 + T07 audit log viewer (read the JSONL
  //                             tail; filtered by action / agent / since).
  //   dashboard-telemetry-summary -> T07 cutover instrumentation badge:
  //                             counts of dashboard_v2_page_view +
  //                             dashboard_v2_error in the last 24h.
  "activity-by-day",
  "list-dashboard-audit",
  "dashboard-telemetry-summary",
  // Phase 116-postdeploy 2026-05-12 — F03 tile 24h activity sparkline.
  // Handler in src/manager/daemon.ts (`case "agent-activity":` adjacent
  // to `case "latency":`). REST proxy at /api/agents/:name/activity
  // in src/dashboard/server.ts. Replaces the Skeleton placeholder the
  // tile has rendered since Phase 116-01.
  "agent-activity",
  // Phase 116-postdeploy 2026-05-12 — Basic-mode "Restart daemon" quick
  // action. Sends SIGHUP to itself (process.kill(process.pid, 'SIGHUP'))
  // which triggers the existing graceful-shutdown path (daemon.ts line
  // ~7563) and exits with code 129 — systemd's RestartForceExitStatus=129
  // declaration restarts the process. Phase 999.6's pre-deploy snapshot
  // preserves the running-agent fleet across the restart so operators
  // don't lose live work. REST proxy at POST /api/daemon/restart.
  //
  // History: an earlier draft of this fix-pass shipped a `restart-discord-
  // bot` IPC that called bridge.stop()→start() on the singleton bridge.
  // That was unsafe — DiscordBridge.stop() calls client.destroy() which
  // permanently invalidates every captured `discordClient` reference in
  // WebhookManager / SubagentThreadSpawner / restart-greeting bot-direct
  // sender. SIGHUP self-restart sidesteps the entire closure-trap.
  "restart-daemon",
  // Phase 999.176 — fleet account swap. Read-only status + the single agent-
  // reachable verb (submit a pasted OAuth code to the pending login session).
  // Starting a login or a swap is slash-command-only by design.
  "account-status",
  "account-login-submit",
  // Phase 116-postdeploy 2026-05-12 — GSD planning artefacts surfaced on
  // the Tasks Kanban (Backlog + Running columns). Scans the repo's
  // .planning/ tree at request time and returns a stable virtual-task
  // shape (PlanningTasksResponse from src/manager/planning-tasks.ts).
  // Working directory is process.cwd(); production installs running
  // from /opt/clawcode (no .planning/) get an empty response — graceful
  // no-op, not an error. REST proxy at GET /api/planning/tasks.
  "list-planning-tasks",
  // Phase 116-postdeploy 2026-05-12 — main-dashboard tile sort. Returns
  // per-agent turn counts (24h + 7d) plus the most-recent turn timestamp
  // so the SPA can order the AgentTileGrid by "most used 24h" instead of
  // the alphabetical/registration-order default. Handler in daemon.ts
  // (`case "fleet-activity-summary":`); REST proxy at
  // GET /api/fleet-activity-summary in src/dashboard/server.ts.
  // Subagents (-sub-) and ephemeral threads (-thread-) are filtered out
  // server-side — they're not tile-rendered on the main dashboard.
  "fleet-activity-summary",
  // Phase 124 Plan 01 — operator-triggered session compaction (`clawcode session compact <agent>`
  // CLI + /clawcode-session-compact Discord admin command). Handler at
  // src/manager/daemon-compact-session-ipc.ts → handleCompactSession; dispatched
  // from daemon.ts case "compact-session". Hybrid flow: compactForAgent() extracts
  // facts into memory.db + forkSession() writes new JSONL artifact. Live hot-swap
  // deferred (closure-captured sessionId). Missing this allowlist entry caused
  // post-deploy "Invalid Request" — exact silent-path-bifurcation manifestation
  // of the Phase 106 / Phase 999.15 / Phase 115-08 class. Lesson reinforced:
  // every new IPC verb requires both daemon dispatch case AND protocol allowlist.
  "compact-session",
  // Phase 120 Plan 04 — `clawcode tool-latency-audit` CLI. Daemon dispatch
  // at `daemon.ts:4084` uses an `if (method === "tool-latency-audit")`
  // form (not a `case`), which the original parity sentinel
  // (`protocol-daemon-parity.test.ts`) failed to catch because its case-
  // extraction regex only matched the `case "..."` form. Same silent-path-
  // bifurcation class as Phase 106 / 999.15 / 115-08 / 116-postdeploy /
  // 124-01: handler appears reachable in source, Zod rejects request as
  // "Invalid Request" at the schema layer. Surfaced during Phase 120 Plan 04
  // verification on clawdy. The sentinel extractor is widened in the same
  // commit to also match `if (method === "...")` form so this whole class
  // of drift is caught on the next CI run.
  "tool-latency-audit",
  // Phase 120 Plan 04 (deviation Rule 2) — same gap caught by widening the
  // parity sentinel. `daemon.ts:4224` dispatches `skill-create` via the
  // `if (method === "...")` form; the case-only sentinel missed it. Added
  // here together with `tool-latency-audit` to keep the next CI run green
  // and prevent a "fix one, expose another" thrash.
  "skill-create",
  // Phase 132 Plan 03 — operator review surface IPC methods. Dispatched by
  // the three /approve-skill, /reject-skill, /edit-skill admin-only slash
  // commands (slash-types.ts CONTROL_COMMANDS entries). Daemon dispatch
  // case branches live in daemon.ts routeMethod. Each handler routes to
  // src/manager/skill-draft-actions.ts (approveDraft / rejectDraft /
  // locateDraftForEdit) — pure-IO module shared with potential future
  // CLI surface (`clawcode skill {approve,reject,edit} <draft-id>`).
  //
  // Same silent-path-bifurcation lesson as compact-session (Plan 124-01),
  // tool-latency-audit + skill-create (Plan 120-04): every new IPC verb
  // requires BOTH a daemon dispatch case AND this protocol allowlist entry,
  // or the Zod request schema rejects it as "Invalid Request" post-deploy.
  "approve-skill-draft",
  "reject-skill-draft",
  "edit-skill-draft",
  // Phase 138 Plan 05 — `clawcode failover` operator surface. Backs the
  // failover {status, reset, set} CLI subcommands. `failover-status`
  // lists active runtime-override rows; `failover-reset` clears one
  // agent's override; `failover-set` force-overrides (admin escape
  // hatch — `expires_at = NULL`, until-cleared). All three dispatch to
  // routeMethod cases in daemon.ts that operate on the live
  // FailoverStateStore. Same silent-path-bifurcation lesson noted for
  // skill-create above — a new IPC verb needs BOTH this allowlist entry
  // AND a daemon dispatch case.
  "failover-status",
  "failover-reset",
  "failover-set",
  // Phase 999.42 Plan 06 — capability C skill PATCH lifecycle operator
  // review surface IPC methods. Dispatched by the three /patch-skill,
  // /approve-patch, /reject-patch admin-only slash commands (slash-types.ts
  // CONTROL_COMMANDS entries). Daemon dispatch case branches live in
  // daemon.ts routeMethod. Each handler routes to
  // src/manager/skill-patch-actions.ts (Plan 05):
  //   list-skill-patches  → listPatchesForSkill (scan skill-patches/ by slug)
  //   apply-skill-patch   → applyPatch  (D6 base-hash conflict guard + D5
  //                          version-validate, writes skills/<slug>/SKILL.md)
  //   reject-skill-patch  → rejectPatch (moves to skills-rejected/)
  //
  // Same silent-path-bifurcation lesson as approve-skill-draft (Plan 132-03),
  // compact-session (Plan 124-01), tool-latency-audit + skill-create
  // (Plan 120-04): every new IPC verb requires BOTH a daemon dispatch case
  // AND this protocol allowlist entry, or the Zod request schema rejects it
  // as "Invalid Request" post-deploy.
  "list-skill-patches",
  "apply-skill-patch",
  "reject-skill-patch",
] as const;

export type IpcMethod = (typeof IPC_METHODS)[number];

/**
 * JSON-RPC 2.0 request schema for IPC messages.
 * Validates: jsonrpc must be "2.0", id is required string,
 * method must be one of IPC_METHODS, params is a record.
 */
export const ipcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.string(),
  method: z.enum(IPC_METHODS),
  params: z.record(z.string(), z.unknown()).default({}),
});

export type IpcRequest = z.infer<typeof ipcRequestSchema>;

/**
 * JSON-RPC 2.0 error object schema.
 */
const ipcErrorObjectSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional(),
});

/**
 * JSON-RPC 2.0 response schema for IPC messages.
 * Must have either result or error (or both), but not neither.
 */
export const ipcResponseSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.string(),
    result: z.unknown().optional(),
    error: ipcErrorObjectSchema.optional(),
  })
  .check(
    z.refine((data) => data.result !== undefined || data.error !== undefined, {
      message: "Response must have either result or error",
    }),
  );

export type IpcResponse = z.infer<typeof ipcResponseSchema>;

/**
 * Phase 104 — `secrets-status` IPC response shape.
 *
 * Validates the counter snapshot returned by SecretsResolver.snapshot()
 * (cacheSize + hit/miss/retry/rateLimitHits counters + optional ISO 8601
 * lastFailureAt/lastRefreshedAt timestamps + optional lastFailureReason
 * string). Every count field is a non-negative integer; `breakerOpen` is the
 * one boolean (live circuit-breaker state, not a count).
 *
 * INC-2026-08-08 — the resolver has ALWAYS tracked envFallbackServed /
 * staleServed / breakerOpen (SecretsCounters, secrets-resolver.ts) but this
 * wire contract dropped them, so the only operator-visible signal that the
 * fleet was running on fallbacks instead of live 1Password reads was a pino
 * line. They are REQUIRED (not optional) because snapshot() always populates
 * them; only the timestamp/reason fields are genuinely absent-able.
 *
 * SEC-07 invariant: this response shape contains COUNTERS, timestamps, and
 * a failure-reason string (e.g., "rate-limited", "auth-error", or the
 * underlying error message — operator-controlled CLI noise). It MUST NOT
 * contain any resolved secret value. cacheSize is the count of cached
 * entries, never a list of values.
 */
export const SecretsStatusResponseSchema = z.object({
  ok: z.literal(true),
  cacheSize: z.number().int().nonnegative(),
  hits: z.number().int().nonnegative(),
  misses: z.number().int().nonnegative(),
  retries: z.number().int().nonnegative(),
  rateLimitHits: z.number().int().nonnegative(),
  // INC-2026-08-08 — degradation counters: how many resolutions were served
  // from the operator env fallback / the STALE last-known-good store instead
  // of a live read, and whether op reads are currently suppressed.
  envFallbackServed: z.number().int().nonnegative(),
  staleServed: z.number().int().nonnegative(),
  breakerOpen: z.boolean(),
  // WS-5 (2026-08-28) — the 1Password read-budget pair. `lkgFreshServed` =
  // resolutions served from a fresh last-known-good entry with no `op` call
  // (reads NOT spent); `opReads` = `op read` invocations since boot, retries
  // included (reads spent). Required: snapshot() always populates both.
  lkgFreshServed: z.number().int().nonnegative(),
  opReads: z.number().int().nonnegative(),
  lastFailureAt: z.string().datetime().optional(),
  lastFailureReason: z.string().optional(),
  lastRefreshedAt: z.string().datetime().optional(),
});
export type SecretsStatusResponse = z.infer<typeof SecretsStatusResponseSchema>;

/**
 * Phase 104 — `secrets-invalidate` IPC request shape.
 *
 * Optional `uri` flushes one cache entry; omit (or pass empty params) to
 * flush the entire cache. The `op://` prefix guard provides defense-in-
 * depth against accidental cache poisoning — operators can only target
 * URIs they could have configured in clawcode.yaml in the first place.
 */
export const SecretsInvalidateRequestSchema = z.object({
  uri: z.string().startsWith("op://").optional(),
});
export type SecretsInvalidateRequest = z.infer<typeof SecretsInvalidateRequestSchema>;

/**
 * Phase 104 — `secrets-invalidate` IPC response shape.
 *
 * `invalidated` is the literal string `"all"` when the entire cache was
 * flushed, or the specific URI that was removed.
 */
export const SecretsInvalidateResponseSchema = z.object({
  ok: z.literal(true),
  invalidated: z.union([z.literal("all"), z.string()]),
});
export type SecretsInvalidateResponse = z.infer<typeof SecretsInvalidateResponseSchema>;

/**
 * WS-5 (2026-08-28) — `secrets-refresh` IPC request shape.
 *
 * Same contract as `secrets-invalidate`: optional `op://`-prefixed `uri`
 * targets one secret; omit it to refresh every secret the daemon holds. The
 * prefix guard keeps the surface limited to URIs an operator could have put
 * in clawcode.yaml in the first place.
 */
export const SecretsRefreshRequestSchema = z.object({
  uri: z.string().startsWith("op://").optional(),
});
export type SecretsRefreshRequest = z.infer<typeof SecretsRefreshRequestSchema>;

/**
 * WS-5 (2026-08-28) — one refresh outcome. `reason` is present only on
 * failure and is the underlying error message (URI + `op` CLI noise).
 * SEC-07: never a resolved value.
 */
export const SecretsRefreshOutcomeSchema = z.object({
  uri: z.string(),
  ok: z.boolean(),
  reason: z.string().optional(),
});
export type SecretsRefreshOutcomeWire = z.infer<typeof SecretsRefreshOutcomeSchema>;

/**
 * WS-5 (2026-08-28) — `secrets-refresh` IPC response shape.
 *
 * Single-URI form: the outcome itself (`{ ok, uri, reason? }`).
 * All form: `{ ok, refreshed: "all", total, failed, results[] }` where `ok`
 * is true only when every outcome succeeded.
 */
export const SecretsRefreshAllResponseSchema = z.object({
  ok: z.boolean(),
  refreshed: z.literal("all"),
  total: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  results: z.array(SecretsRefreshOutcomeSchema),
});
export type SecretsRefreshAllResponse = z.infer<typeof SecretsRefreshAllResponseSchema>;
export const SecretsRefreshResponseSchema = z.union([
  SecretsRefreshOutcomeSchema,
  SecretsRefreshAllResponseSchema,
]);
export type SecretsRefreshResponse = z.infer<typeof SecretsRefreshResponseSchema>;

/**
 * Phase 110 Stage 0b 0B-RT-13 — `list-mcp-tools` IPC contract.
 *
 * Future Wave 2-4 Go shims call this method at boot to fetch the canonical
 * MCP tool list for their shim type, JSON-Schema-converted from the
 * single-source-of-truth TypeScript Zod definitions in
 * `src/{search,image,browser}/tools.ts`. Keeps schemas single-sourced —
 * the Go shim does NOT duplicate Zod definitions (Pitfall 4 in 110-RESEARCH.md).
 *
 * Method shape (locked in 110-CONTEXT.md):
 *   - Request:  { shimType: "search" | "image" | "browser" }
 *   - Response: { tools: ToolSchema[] }
 *     where each ToolSchema mirrors the MCP `tools/list` response item:
 *       { name: string, description: string, inputSchema: object (JSON Schema) }
 *
 * Adds ~1 ms IPC round-trip on shim boot — negligible.
 *
 * Sequencing constraint: this contract + its handler ship BEFORE any Go
 * shim builds against it (Wave 1 prerequisite for Waves 2-4).
 */
export const listMcpToolsRequestSchema = z.object({
  shimType: z.enum(["search", "image", "browser"]),
});
export type ListMcpToolsRequest = z.infer<typeof listMcpToolsRequestSchema>;

/**
 * One tool entry in the response, mirroring the MCP `tools/list` shape.
 *
 * `inputSchema` is opaque to the daemon — it's the JSON-Schema-converted
 * Zod schema. The daemon serializes; the Go shim passes it through to
 * `mcp.AddTool` verbatim. Validating the inner schema would require
 * pinning a JSON-Schema dialect here; instead we accept any object so
 * the converter (zod/v4 native `z.toJSONSchema`) can evolve without a
 * second migration here.
 */
export const mcpToolSchemaSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
});
export type McpToolSchema = z.infer<typeof mcpToolSchemaSchema>;

export const listMcpToolsResponseSchema = z.object({
  tools: z.array(mcpToolSchemaSchema),
});
export type ListMcpToolsResponse = z.infer<typeof listMcpToolsResponseSchema>;

// ---------------------------------------------------------------------------
// Phase 138 Plan 02 — credit telemetry IPC contract.
//
// The `heartbeat-status` IPC payload widens with a NEW TOP-LEVEL
// `creditTelemetry` field (NOT per-agent — fleet-aggregate per provider).
// `ProviderTelemetryAggregator.snapshot()` (src/manager/provider-telemetry-
// aggregator.ts) produces a value of this shape; the daemon's
// `buildHeartbeatStatusPayload` attaches it when an aggregator is wired.
//
// The field is ADDITIVE — pre-138 dashboard / CLI consumers ignore the
// unknown key, so the contract stays backwards-compatible.
//
// **Cap cascade (CONTEXT D6).** `cap_usd` is the fleet-level cap for a
// provider, resolved by the aggregator as `max` across agents of
// `agent.providers.<name>.dailyCapUsd ?? defaults.providers.<name>.dailyCapUsd
// ?? DEFAULT_DAILY_CAP_USD (6.67)`.
//
// **Sparkline.** 24 daily cost samples (one per UTC day, oldest first,
// today at index 23). Daily resolution matches the locked `provider_usage`
// PK `(date, provider, model)` — Phase 138 ships sparklines, not hourly
// historical charts (deferred to the Phase 116 dashboard redesign).
// ---------------------------------------------------------------------------

/** One per-provider entry in the fleet credit-telemetry payload. */
export const CreditTelemetryEntrySchema = z.object({
  provider: z.enum(["anthropic", "openai"]),
  cost_usd: z.number(),
  cap_usd: z.number().positive(),
  /** cost/cap × 100. Can exceed 100 (overage); UI clamps for display. */
  pct: z.number().min(0),
  tokens_in: z.number().int().nonnegative(),
  tokens_out: z.number().int().nonnegative(),
  turn_count: z.number().int().nonnegative(),
  /** Per-model breakdown for the dashboard drawer. */
  models: z.array(
    z.object({
      model: z.string(),
      tokens_in: z.number().int().nonnegative(),
      tokens_out: z.number().int().nonnegative(),
      cost_usd: z.number(),
    }),
  ),
  /** Daily cost, last 24 UTC days (oldest first, today at index 23). */
  sparkline: z.array(z.number()).length(24),
  /** Which agents contributed to this provider's aggregate. */
  agents: z.array(z.string()),
});
export type CreditTelemetryEntry = z.infer<typeof CreditTelemetryEntrySchema>;

/** Fleet-aggregate credit telemetry — one entry per active provider. */
export const CreditTelemetryPayloadSchema = z.object({
  /** UTC `YYYY-MM-DD` the snapshot was computed for. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  providers: z.array(CreditTelemetryEntrySchema),
});
export type CreditTelemetryPayload = z.infer<typeof CreditTelemetryPayloadSchema>;

// ---------------------------------------------------------------------------
// Phase 138 Plan 05 — `clawcode failover` IPC contract.
// ---------------------------------------------------------------------------
//
// The CLI sends `failover-{status,reset,set}` to the daemon; the daemon
// operates on the live FailoverStateStore. `failover-set` accepts a
// backend ID — kept in-sync with `llmRuntimeBackendSchema` in
// `src/config/schema.ts` (the canonical source). It is inlined here as
// a local enum rather than imported to keep `protocol.ts` free of a
// `config/` dependency (the wire contract owns its own validation
// surface). `portable-fork` is deliberately excluded — same scaffold-
// only exclusion as the config enum: `clawcode failover set <agent>
// portable-fork` is rejected at CLI parse time.

/** Backend IDs accepted by `failover-set`. Mirrors llmRuntimeBackendSchema. */
export const failoverBackendSchema = z.enum([
  "anthropic-agent-sdk",
  "codex-cli",
]);
export type FailoverBackend = z.infer<typeof failoverBackendSchema>;

/** `clawcode failover status [<agent>]` — list active override rows. */
export const FailoverStatusRequestSchema = z.object({
  type: z.literal("failover-status"),
  /** When present, scope the listing to one agent. */
  agent: z.string().optional(),
});
export type FailoverStatusRequest = z.infer<typeof FailoverStatusRequestSchema>;

/** `clawcode failover reset <agent>` — clear one agent's override. */
export const FailoverResetRequestSchema = z.object({
  type: z.literal("failover-reset"),
  agent: z.string().min(1),
});
export type FailoverResetRequest = z.infer<typeof FailoverResetRequestSchema>;

/** `clawcode failover set <agent> <backend>` — force a manual override. */
export const FailoverSetRequestSchema = z.object({
  type: z.literal("failover-set"),
  agent: z.string().min(1),
  backend: failoverBackendSchema,
});
export type FailoverSetRequest = z.infer<typeof FailoverSetRequestSchema>;

/** One failover-state row as returned over IPC. */
export const FailoverRowSchema = z.object({
  agent: z.string(),
  active_backend: z.string(),
  reason: z.string(),
  triggered_at: z.number(),
  expires_at: z.number().nullable(),
});
export type FailoverRowDto = z.infer<typeof FailoverRowSchema>;

/** Response for `failover-status` — the active (non-expired) override rows. */
export const FailoverStatusResponseSchema = z.object({
  rows: z.array(FailoverRowSchema),
});
export type FailoverStatusResponse = z.infer<
  typeof FailoverStatusResponseSchema
>;

/** Response for `failover-reset` / `failover-set` — the applied mutation. */
export const FailoverMutationResponseSchema = z.object({
  ok: z.literal(true),
  agent: z.string(),
  /** "reset" | "set" — which mutation was applied. */
  action: z.enum(["reset", "set"]),
  /** Present for "set" — the backend the agent was overridden to. */
  backend: z.string().optional(),
});
export type FailoverMutationResponse = z.infer<
  typeof FailoverMutationResponseSchema
>;
