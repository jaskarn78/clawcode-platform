// src/heartbeat/check-registry.ts
//
// Phase 999.8 Plan 03 — static heartbeat-check registry.
//
// WHY: tsup builds the daemon with `splitting: false`, bundling only
// `src/cli/index.ts` into a single `dist/cli/index.js`. The pre-Plan-03
// `discoverChecks` did `readdirSync(dist/heartbeat/checks) + import(...)` at
// runtime — but `dist/heartbeat/checks/` never exists in the bundled output,
// so production silently logged `"checkCount":0` on every restart. None of
// the 11 health checks (tier-maintenance, consolidation, mcp-reconnect,
// fs-probe, attachment-cleanup, task-retention, trace-retention, thread-idle,
// context-fill, inbox heartbeat path, auto-linker safety net) ever fired.
//
// FIX: import every check statically. tsup follows the import graph, so each
// check ends up in the bundle. The registry is `Object.freeze`'d to make the
// "constant data" intent explicit and the `readonly CheckModule[]` type
// prevents accidental mutation.
//
// Pitfall 7 (RESEARCH): NO try/catch around the imports. If a check module is
// broken, ESM raises at module-load time and the daemon refuses to start —
// which is the correct, fail-fast behaviour. The pre-Plan-03 silent-skip is
// what enabled the regression to live in prod for so long.
//
// Pitfall 1 (RESEARCH): the registry consumes only the DEFAULT export. inbox.ts
// also exposes a NAMED export `setInboxSourceActive` that daemon.ts:2120
// imports dynamically — that contract is unrelated to the registry and must
// not be perturbed. inbox-named-export.test.ts is the regression guard.
import type { CheckModule } from "./types.js";
import attachmentCleanup from "./checks/attachment-cleanup.js";
import autoIngestRescan from "./checks/auto-ingest-rescan.js";
import autoLinker from "./checks/auto-linker.js";
import consolidation from "./checks/consolidation.js";
import contextFill from "./checks/context-fill.js";
import fsProbe from "./checks/fs-probe.js";
import homelabRefresh from "./checks/homelab-refresh.js";
import inbox from "./checks/inbox.js";
import mcpBroker from "./checks/mcp-broker.js";
import mcpReconnect from "./checks/mcp-reconnect.js";
import memoryCensus from "./checks/memory-census.js";
import remoteMcpReconnect from "./checks/remote-mcp-reconnect.js";
import sessionLogFlush from "./checks/session-log-flush.js";
import sessionRetention from "./checks/session-retention.js";
import summarizePending from "./checks/summarize-pending.js";
import taskRetention from "./checks/task-retention.js";
import threadIdle from "./checks/thread-idle.js";
import tierMaintenance from "./checks/tier-maintenance.js";
import traceRetention from "./checks/trace-retention.js";

export const CHECK_REGISTRY: readonly CheckModule[] = Object.freeze([
  attachmentCleanup,
  // P1-RESCAN — periodic inbox rescan (makes auto-ingest never-drop true).
  autoIngestRescan,
  autoLinker,
  consolidation,
  contextFill,
  fsProbe,
  // Phase 999.47 Plan 02 — hourly homelab inventory refresh tick.
  // Fleet-level (sentinel-agent gated; one tick per fleet per hour).
  homelabRefresh,
  inbox,
  // Phase 108 — pool liveness probe for the daemon-managed
  // OnePasswordMcpBroker. NEVER calls a tool dispatch path; only reads
  // `broker.getPoolStatus()`. See checks/mcp-broker.ts header.
  mcpBroker,
  mcpReconnect,
  // Phase 999.122 — read-only memory census every 15 min; carries the
  // `memory doctor` numbers on /api/health for the fleet brief.
  memoryCensus,
  // 2026-09-24 — in-place reconnect of ssh-stdio MCP servers (Mac nodes)
  // after the remote machine sleeps/reboots. See checks/remote-mcp-reconnect.ts.
  remoteMcpReconnect,
  // 2026-06-18 — materialises daily session logs from the ConversationStore,
  // decoupled from compaction (which stopped firing on the SDK-session fleet),
  // so memory consolidation has input. See checks/session-log-flush.ts.
  sessionLogFlush,
  // Phase 999.119 pass 2 — daily conversation_sessions hygiene (closes
  // orphaned `active` rows, prunes empty terminated rows > 30 d).
  sessionRetention,
  // Phase 99-C — drains pending session-summary backlog (sessions that
  // ended/crashed without ever firing the SessionSummarizer). See
  // checks/summarize-pending.ts header.
  summarizePending,
  taskRetention,
  threadIdle,
  tierMaintenance,
  traceRetention,
]);
