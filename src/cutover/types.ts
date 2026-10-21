/**
 * Phase 92 Plan 01 — Cutover-pipeline types (D-11 amended).
 *
 * Schemas + discriminated unions consumed by:
 *   - src/cutover/mc-history-ingestor.ts (PRIMARY source per D-11)
 *   - src/cutover/discord-ingestor.ts   (FALLBACK / SECONDARY source per D-11)
 *   - src/cutover/source-profiler.ts    (reads UNION of both staging JSONLs)
 *   - Plans 92-02 / 92-05 / 92-06 (downstream consumers via the AgentProfile
 *     7-key contract + the IngestOutcome / ProfileOutcome unions)
 *
 * Source-of-truth references:
 *   - 92-CONTEXT.md D-01 (SUPERSEDED by D-11)
 *   - 92-CONTEXT.md D-02 (single-LLM-pass profiler with 7-key output)
 *   - 92-CONTEXT.md D-11 (Mission Control REST API as PRIMARY source corpus)
 *   - 92-CONTEXT.md "Claude's Discretion" (PROFILER_CHUNK_THRESHOLD_MSGS = 50000)
 *
 * Invariants pinned for static-grep regression:
 *   - PROFILER_CHUNK_THRESHOLD_MSGS = 50000 stays a top-level export
 *   - MC_DEFAULT_BASE_URL = "http://10.0.0.3:4000" stays a top-level export
 *   - agentProfileSchema enumerates EXACTLY the 7 contract keys
 *   - historyEntrySchema is a discriminatedUnion("origin", [...])
 *   - The IngestOutcome / McIngestOutcome / DiscordIngestOutcome / ProfileOutcome
 *     unions form closed sets exhaustively switched downstream
 */

import { z } from "zod/v4";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Chunking threshold (D-Claude's-Discretion).
 *
 * When the union of mc-history.jsonl + discord-history.jsonl exceeds this
 * many entries, the profiler splits the corpus into ≤30-day windows and
 * runs one TurnDispatcher pass per window. Pinned in source as an exported
 * constant for both grep-regression and cross-plan reference.
 */
export const PROFILER_CHUNK_THRESHOLD_MSGS = 50000;

/**
 * D-11 — Mission Control default base URL. Override via env MC_API_BASE
 * or --mc-base CLI flag. Pinned as a top-level export so grep-discoverable.
 */
export const MC_DEFAULT_BASE_URL = "http://10.0.0.3:4000";

/** One {intent, count} row for the profiler's topIntents[] output. */
export const topIntentSchema = z.object({
  intent: z.string().min(1),
  count: z.number().int().nonnegative(),
});

/** Inferred TopIntent type. */
export type TopIntent = z.infer<typeof topIntentSchema>;

/**
 * The canonical AgentProfile shape (D-02). Exactly 7 keys, no extras.
 * Downstream:
 *   - Plan 92-02 diff engine reads tools/skills/mcpServers/memoryRefs/
 *     models/uploads to compute CutoverGap rows
 *   - Plan 92-05 canary synthesizer reads topIntents[] for prompt batteries.
 *     D-11: cron-clustered intents prefixed `cron:` so Phase 47 cron parity
 *     surfaces in the canary battery distinct from user-initiated intents.
 */
export const agentProfileSchema = z.object({
  tools: z.array(z.string()),
  skills: z.array(z.string()),
  mcpServers: z.array(z.string()),
  memoryRefs: z.array(z.string()),
  models: z.array(z.string()),
  uploads: z.array(z.string()),
  topIntents: z.array(topIntentSchema),
});

export type AgentProfile = z.infer<typeof agentProfileSchema>;

/**
 * D-11 — One Mission Control session-history entry, post JSONL flattening.
 *
 * Mirrors the relayed message records that MC's
 * GET /api/openclaw/sessions/{id}/history returns from the OpenClaw gateway,
 * narrowed to the fields the profiler actually consumes.
 *
 * Idempotency key: (sessionId, sequenceIndex). The ingestor maintains a
 * dedup Set populated from the existing JSONL so reruns never duplicate.
 *
 * `kind` is propagated from the parent session and is critical for the
 * profiler's cron-prefix rule — when kind === "cron", the LLM clusters
 * the intent under "cron:<intent-name>" so cutover parity covers cron
 * dispatch as a distinct surface.
 */
export const mcHistoryEntrySchema = z.object({
  origin: z.literal("mc"),
  sessionId: z.string().min(1),
  sequenceIndex: z.number().int().nonnegative(),
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string(),
  model: z.string().optional(),
  ts: z.string(), // ISO 8601
  kind: z.enum(["direct", "cron", "orchestra", "scheduled", "unknown"]),
  label: z.string().optional(),
});
export type McHistoryEntry = z.infer<typeof mcHistoryEntrySchema>;

/**
 * One Discord message after JSONL flattening. Mirrors the
 * plugin:discord:fetch_messages payload — narrowed to the fields the
 * profiler actually consumes. Per D-11, the ingestor injects
 * `origin: "discord"` before validating so the profiler can discriminate
 * when reading the merged corpus.
 */
export const discordHistoryEntrySchema = z.object({
  origin: z.literal("discord"),
  message_id: z.string().min(1),
  channel_id: z.string().min(1),
  author_id: z.string().min(1),
  author_name: z.string().optional(),
  ts: z.string(), // ISO 8601 — sort + 30-day chunking key
  content: z.string(),
  attachments: z
    .array(
      z.object({
        name: z.string(),
        url: z.string().optional(),
        type: z.string().optional(),
        size: z.number().optional(),
      }),
    )
    .default([]),
  is_bot: z.boolean().default(false),
});

export type DiscordHistoryEntry = z.infer<typeof discordHistoryEntrySchema>;

/**
 * D-11 — discriminated union of history entries from EITHER origin.
 *
 * The profiler reads BOTH staging JSONL files (mc-history.jsonl and
 * discord-history.jsonl), parses each line through this union, and uses
 * the `origin` discriminator to:
 *   - Build per-origin dedup keys: (sessionId, sequenceIndex) for "mc",
 *     (channel_id, message_id) for "discord"
 *   - Render LLM-prompt entries with the right context tags
 *   - Cluster cron intents under the "cron:" prefix when origin==="mc"
 *     and kind==="cron"
 */
export const historyEntrySchema = z.discriminatedUnion("origin", [
  mcHistoryEntrySchema,
  discordHistoryEntrySchema,
]);
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

/**
 * D-11 — Outcome of a Mission Control ingest cycle. Discriminated by
 * `kind`. Downstream (Plan 92-06 report writer + the CLI exit-code branch
 * in cutover-ingest.ts) does an exhaustive switch on this.
 *
 * SECURITY: error strings in this outcome MUST NOT contain the bearer
 * token. mc-history-ingestor.ts uses a sanitizeError() helper that strips
 * the token literal before propagation.
 */
export type McIngestOutcome =
  | {
      kind: "ingested";
      agent: string;
      sessionsProcessed: number;
      newEntries: number;
      totalEntries: number;
      durationMs: number;
      jsonlPath: string;
    }
  | {
      kind: "no-changes";
      agent: string;
      totalEntries: number;
      durationMs: number;
      jsonlPath: string;
    }
  | {
      kind: "agent-not-found-in-mc";
      agent: string;
      gatewayAgentId: string;
    }
  | {
      kind: "missing-bearer-token";
      agent: string;
    }
  | {
      kind: "mc-gateway-503";
      agent: string;
      error: string;
      durationMs: number;
    }
  | {
      kind: "mc-fetch-failed";
      agent: string;
      phase: "agents" | "sessions" | "history";
      error: string;
      durationMs: number;
    };

/**
 * Outcome of a single Discord ingest cycle. Same exhaustive-switch
 * contract as McIngestOutcome.
 */
export type DiscordIngestOutcome =
  | {
      kind: "ingested";
      agent: string;
      channelsProcessed: number;
      newMessages: number;
      totalMessages: number;
      durationMs: number;
      jsonlPath: string;
    }
  | {
      kind: "no-changes";
      agent: string;
      totalMessages: number;
      durationMs: number;
      jsonlPath: string;
    }
  | {
      kind: "discord-fetch-failed";
      agent: string;
      channelId: string;
      error: string;
      durationMs: number;
    }
  | {
      kind: "no-channels";
      agent: string;
    };

/**
 * D-11 — CLI-level combined outcome. The cutover ingest CLI emits one of
 * these to stdout summarizing what happened across both sources.
 */
export type IngestOutcome =
  | {
      kind: "ingested-both";
      agent: string;
      mc: McIngestOutcome;
      discord: DiscordIngestOutcome;
    }
  | {
      kind: "ingested-mc-only";
      agent: string;
      mc: McIngestOutcome;
    }
  | {
      kind: "ingested-discord-only";
      agent: string;
      discord: DiscordIngestOutcome;
    };

/**
 * Outcome of a single profile cycle. Same exhaustive-switch contract
 * as the ingest outcomes.
 */
export type ProfileOutcome =
  | {
      kind: "profiled";
      agent: string;
      chunksProcessed: number;
      messagesProcessed: number;
      profilePath: string;
      durationMs: number;
    }
  | {
      kind: "no-history";
      agent: string;
      jsonlPaths: readonly string[];
    }
  | {
      kind: "dispatcher-failed";
      agent: string;
      error: string;
      durationMs: number;
    }
  | {
      kind: "schema-validation-failed";
      agent: string;
      error: string;
      rawResponse: string;
    };

/**
 * Phase 92 Plan 01 — Composite "AgentProfilerOutcome" alias for the plan
 * frontmatter's artifact spec. Most call-sites can use ProfileOutcome
 * directly; this alias exists so cross-plan references in 92-02..06 can
 * import a single name when they want the union.
 */
export type AgentProfilerOutcome = ProfileOutcome;

// ============================================================================
// Phase 92 Plan 02 — Target capability probe + diff engine types (D-04 + D-11)
// ============================================================================
//
// Extends the cutover pipeline contract with:
//   - CutoverGap: typed discriminated union of EXACTLY 9 kinds (D-11 added
//     `cron-session-not-mirrored`). 4 additive + 5 destructive variants.
//   - TargetCapability: mirror-shape of AgentProfile + workspace inventory +
//     MCP runtime state (read by `src/cutover/target-probe.ts`).
//   - ProbeOutcome / DiffOutcome: exhaustive-switch outcome unions for the
//     `cutover probe` and `cutover diff` CLI subcommands.
//   - sortGaps + assertNever: deterministic-order helper + compile-time
//     exhaustiveness witness.
//
// Adding a 10th CutoverGap kind requires updating downstream consumers:
//   - src/cutover/diff-engine.ts                 (the producer)
//   - src/cutover/additive-applier.ts            (Plan 92-03 — 4 additive)
//   - src/cutover/destructive-embed-renderer.ts  (Plan 92-04 — 5 destructive)
//   - src/cutover/report-writer.ts               (Plan 92-06)
// The exhaustive-switch + assertNever pattern enforces this at compile time.

/**
 * D-04 typed CutoverGap discriminated union — EXACTLY 9 kinds (D-11 added
 * `cron-session-not-mirrored`).
 *
 * Severity:
 *   - additive    → Plan 92-03 auto-applier handles these (no operator gate)
 *   - destructive → Plan 92-04 destructive embed renderer; admin-clawdy
 *     ephemeral confirmation Accept/Reject/Defer required
 *
 * Identifier discipline (deterministic-sort key):
 *   - missing-skill          → skill name
 *   - missing-mcp            → MCP server name
 *   - missing-memory-file    → memory file path (relative to memoryRoot)
 *   - missing-upload         → upload filename
 *   - outdated-memory-file   → memory file path
 *   - model-not-in-allowlist → model id
 *   - mcp-credential-drift   → MCP server name
 *   - tool-permission-gap    → tool name (e.g. "Bash")
 *   - cron-session-not-mirrored → MC sessionKey (e.g. "cron:acme-db-sync")
 */
export type CutoverGap =
  | {
      kind: "missing-skill";
      identifier: string;
      severity: "additive";
      sourceRef: { skillName: string };
      targetRef: { skills: readonly string[] };
    }
  | {
      kind: "missing-mcp";
      identifier: string;
      severity: "additive";
      sourceRef: { mcpServerName: string; toolsUsed: readonly string[] };
      targetRef: { mcpServers: readonly string[] };
    }
  | {
      kind: "missing-memory-file";
      identifier: string;
      severity: "additive";
      sourceRef: { path: string; sourceHash: string };
      targetRef: { exists: false };
    }
  | {
      kind: "missing-upload";
      identifier: string;
      severity: "additive";
      sourceRef: { filename: string };
      targetRef: { uploads: readonly string[] };
    }
  | {
      kind: "outdated-memory-file";
      identifier: string;
      severity: "destructive";
      sourceRef: { path: string; sourceHash: string };
      targetRef: { path: string; targetHash: string };
    }
  | {
      kind: "model-not-in-allowlist";
      identifier: string;
      severity: "additive";
      sourceRef: { modelId: string };
      targetRef: { allowedModels: readonly string[] };
    }
  | {
      kind: "mcp-credential-drift";
      identifier: string;
      severity: "destructive";
      sourceRef: { mcpServerName: string; envKeys: readonly string[] };
      targetRef: {
        mcpServerName: string;
        envKeys: readonly string[];
        status: string;
      };
    }
  | {
      kind: "tool-permission-gap";
      identifier: string;
      severity: "destructive";
      sourceRef: { toolName: string };
      targetRef: { aclDenies: readonly string[] };
    }
  | {
      kind: "cron-session-not-mirrored";
      identifier: string;
      severity: "destructive";
      sourceRef: {
        sessionKey: string;
        label: string;
        kind: "cron";
        lastSeenAt: string;
      };
      targetRef: { mirroredCronEntries: readonly string[] };
    };

/** Sub-union of CutoverGap variants safe for Plan 92-03's auto-applier. */
export type AdditiveCutoverGap = Extract<CutoverGap, { severity: "additive" }>;

/**
 * Sub-union of CutoverGap variants requiring Plan 92-04's admin-clawdy
 * ephemeral Accept/Reject/Defer confirmation before any mutation.
 */
export type DestructiveCutoverGap = Extract<
  CutoverGap,
  { severity: "destructive" }
>;

/**
 * Compile-time exhaustiveness witness — Plan 92-03/04/06 consumers MUST
 * call this in their default branches so adding a 10th CutoverGap kind
 * fails the TypeScript build until every consumer is updated.
 *
 * Throws at runtime if reached (which only happens if an as-cast bypassed
 * the type system). The runtime throw includes the variant payload for
 * diagnostic value.
 */
export function assertNever(x: never): never {
  throw new Error(
    "Unhandled CutoverGap variant: " + JSON.stringify(x),
  );
}

/**
 * Deterministic ordering for CutoverGap[] — sorts by (kind asc, identifier asc).
 *
 * Returns a NEW array (immutability rule from CLAUDE.md): the input array is
 * never sorted in place. Downstream consumers (Plan 92-04 embed renderer,
 * Plan 92-06 report writer) rely on this canonical order so the rendered
 * output is byte-stable across reruns of the same input.
 */
export function sortGaps(
  gaps: readonly CutoverGap[],
): readonly CutoverGap[] {
  return [...gaps].sort((a, b) =>
    a.kind === b.kind
      ? a.identifier.localeCompare(b.identifier)
      : a.kind.localeCompare(b.kind),
  );
}

/**
 * TargetCapability — mirror-shape of AgentProfile + workspace inventory +
 * MCP runtime state. Emitted by `probeTargetCapability` and read by
 * `diffAgentVsTarget`.
 *
 * NO-LEAK invariant (regression-pinned): `mcpServers[].envKeys` carries
 * KEY NAMES ONLY (e.g. ["STRIPE_SECRET_KEY"]). Values NEVER appear in
 * this schema. The probe's extraction step uses `Object.keys(env)` —
 * never accesses `env[key]`.
 *
 * D-11 — `sessionKinds[]` lists the direct/cron/orchestra/scheduled session
 * types the target supports. Diff against AgentProfile-derived cron sessions
 * surfaces `cron-session-not-mirrored` gaps when MC has cron but target
 * lacks the schedule entry.
 */
export const targetCapabilitySchema = z.object({
  agent: z.string(),
  generatedAt: z.string(),
  yaml: z.object({
    skills: z.array(z.string()),
    mcpServers: z.array(
      z.object({
        name: z.string(),
        // KEY NAMES ONLY — values never enter this surface (NO-LEAK pin).
        envKeys: z.array(z.string()),
      }),
    ),
    model: z.string(),
    allowedModels: z.array(z.string()),
    memoryAutoLoad: z.boolean(),
    // D-11 — direct/cron/orchestra/scheduled session types the target
    // currently mirrors (e.g. via Phase 47 cron schedules + orchestra wiring).
    sessionKinds: z.array(z.string()).default([]),
  }),
  workspace: z.object({
    memoryRoot: z.string(),
    memoryFiles: z.array(
      z.object({
        // Path relative to memoryRoot, e.g. "memory/2026-04-15-x.md".
        path: z.string(),
        sha256: z.string(),
      }),
    ),
    // Sha256 of MEMORY.md root file, or null if absent.
    memoryMdSha256: z.string().nullable(),
    // Filenames in uploads/discord/.
    uploads: z.array(z.string()),
    // Skill directory names actually present on disk under skills/.
    skillsInstalled: z.array(z.string()),
  }),
  mcpRuntime: z.array(
    z.object({
      name: z.string(),
      status: z.enum(["healthy", "warning", "critical", "unknown"]),
      lastError: z.string().nullable(),
      failureCount: z.number().int().nonnegative(),
    }),
  ),
});

export type TargetCapability = z.infer<typeof targetCapabilitySchema>;

/**
 * Outcome of a single `cutover probe` cycle. Exhaustively switched in the
 * Plan 92-06 report writer.
 *
 * Note: the YAML loader, agent lookup, workspace inventory, and MCP IPC
 * are all separately failable; `probeTargetCapability` collapses
 * inventory-failures into `yaml-load-failed` (with phase prefix in error)
 * to keep the outcome surface tractable for Plan 92-06.
 */
export type ProbeOutcome =
  | {
      kind: "probed";
      agent: string;
      capabilityPath: string;
      durationMs: number;
    }
  | { kind: "agent-not-found"; agent: string }
  | { kind: "yaml-load-failed"; agent: string; error: string }
  | { kind: "ipc-failed"; agent: string; error: string };

/**
 * Outcome of a single `cutover diff` cycle. Exhaustively switched in
 * Plan 92-06's report-writer + the CLI exit-code branch.
 */
export type DiffOutcome =
  | {
      kind: "diffed";
      agent: string;
      gapCount: number;
      additiveCount: number;
      destructiveCount: number;
      gapsPath: string;
      durationMs: number;
    }
  | { kind: "missing-profile"; agent: string; profilePath: string }
  | { kind: "missing-capability"; agent: string; capabilityPath: string };

// ============================================================================
// Phase 92 Plan 03 — Cutover ledger row + additive-applier outcome (D-05 + D-10)
// ============================================================================
//
// Adds:
//   - cutoverLedgerActionSchema / CutoverLedgerAction
//   - cutoverLedgerRowSchema    / CutoverLedgerRow
//   - AdditiveApplyOutcome (discriminated union)
//
// The ledger row is the audit witness for every applied (or attempted)
// cutover fix. Append-only JSONL at `~/.clawcode/manager/cutover-ledger.jsonl`
// per Phase 84 / Phase 82 ledger.ts conventions:
//   1. Validated on WRITE (zod parse before fs touch)
//   2. appendFile only — no read-modify-write
//   3. No truncate/clear/rewrite helpers exposed
//
// `preChangeSnapshot` is the D-10 reversibility hook for destructive gaps
// (Plan 92-04 territory). Additive gaps are trivially reversible (delete
// the added file, remove the YAML entry) so they emit `null` for that field.

/**
 * D-05 ledger row action vocabulary.
 *
 *  - "apply-additive"      Plan 92-03 wrote a fix for an additive gap
 *  - "apply-destructive"   Plan 92-04 wrote a fix after admin-clawdy Accept
 *  - "reject-destructive"  Plan 92-04 logged operator Reject
 *  - "rollback"            Plan 92-06 rewound a prior fix
 *  - "skip-verify"         Plan 92-06 escape hatch (D-09 emergency cutover)
 */
export const cutoverLedgerActionSchema = z.enum([
  "apply-additive",
  "apply-destructive",
  "reject-destructive",
  "rollback",
  "skip-verify",
]);
export type CutoverLedgerAction = z.infer<typeof cutoverLedgerActionSchema>;

/**
 * D-05 single-row schema for `~/.clawcode/manager/cutover-ledger.jsonl`.
 *
 * Validated on WRITE — `appendCutoverRow` zod-parses BEFORE mkdir+appendFile
 * so a malformed row never reaches the filesystem.
 *
 * `preChangeSnapshot` is the D-10 reversibility hook: destructive applies
 * (Plan 92-04) populate it; additive applies (Plan 92-03) leave it `null`.
 *
 * `reason` is populated for skip-verify, reject-destructive, and any
 * refusal (e.g., secret-scan-refused). `null` for normal apply rows.
 */
export const cutoverLedgerRowSchema = z.object({
  // ISO 8601 with time component — Phase 82 ledger.ts ts invariant.
  timestamp: z
    .string()
    .refine(
      (v) => !Number.isNaN(Date.parse(v)) && v.includes("T"),
      "timestamp must be ISO 8601 with time component",
    ),
  agent: z.string().min(1),
  action: cutoverLedgerActionSchema,
  // CutoverGap['kind'] for apply rows; meta values like "skip-verify" otherwise.
  kind: z.string().min(1),
  identifier: z.string(),
  // sha256 of source content (null when not applicable, e.g. yaml-only updates).
  sourceHash: z.string().nullable(),
  // sha256 of target content after apply (null on dry-run / refusal).
  targetHash: z.string().nullable(),
  // true for additive; for destructive only when preChangeSnapshot fits.
  reversible: z.boolean(),
  // false at apply time; rollback action appends a new row (NOT mutate).
  rolledBack: z.boolean(),
  // Base64-gzipped pre-apply content for files < 64KB (destructive only).
  preChangeSnapshot: z.string().nullable(),
  // skip-verify / reject-destructive / refusal-due-to-secret-scan reasons.
  reason: z.string().nullable(),
});
export type CutoverLedgerRow = z.infer<typeof cutoverLedgerRowSchema>;

/**
 * D-05 — Outcome of one `cutover apply-additive` invocation.
 *
 * Discriminated by `kind`. Plan 92-06 report writer + the CLI exit-code
 * branch in cutover-apply-additive.ts switch exhaustively over this union.
 *
 * One terminal outcome per invocation. Per-gap success contributes to
 * `gapsApplied`; idempotency-skipped gaps contribute to `gapsSkipped`.
 * A single secret-scan-refused / yaml-write-failed / rsync-failed
 * short-circuits the run.
 */
export type AdditiveApplyOutcome =
  | {
      kind: "applied";
      agent: string;
      gapsApplied: number;
      gapsSkipped: number;
      destructiveDeferred: number;
      ledgerPath: string;
      durationMs: number;
    }
  | {
      kind: "dry-run";
      agent: string;
      plannedAdditive: number;
      destructiveDeferred: number;
    }
  | {
      kind: "no-gaps-file";
      agent: string;
      gapsPath: string;
    }
  | {
      kind: "secret-scan-refused";
      agent: string;
      identifier: string;
      reason: string;
    }
  | {
      kind: "yaml-write-failed";
      agent: string;
      identifier: string;
      error: string;
    }
  | {
      kind: "rsync-failed";
      agent: string;
      identifier: string;
      error: string;
    }
  | {
      kind: "destructive-gaps-deferred";
      agent: string;
      destructiveCount: number;
    };

// ============================================================================
// Phase 92 Plan 04 — Destructive-fix admin-clawdy embed surface (D-06 + D-07 + D-10)
// ============================================================================
//
// Adds:
//   - CUTOVER_BUTTON_PREFIX constant + namespace marker
//   - destructiveButtonActionSchema / DestructiveButtonAction enum (accept/reject/defer)
//   - CutoverButtonCustomId template-literal type (cutover-{agent}-{gapId}:{action})
//   - parseCutoverButtonCustomId — null-safe parser (collision-safe with all other
//     prefix namespaces: model-confirm:, skills-picker:, plugins-picker:, marketplace-,
//     cancel:, modal-, skills-action-confirm:, plugin-confirm-x:)
//   - DestructiveButtonOutcome — 6-variant discriminated union returned by the
//     button-handler; consumed by Plan 92-06 report writer
//
// customId namespace is reserved by this plan. Collision regression test in
// daemon-cutover-button.test.ts D2 pins parseCutoverButtonCustomId returns null
// for ALL existing prefix shapes and NON-null only for cutover-* shape.

/**
 * D-06 namespace marker for cutover destructive-fix buttons. Reserved exclusively
 * for Plan 92-04. Any string starting with this prefix is a cutover button and
 * is routed to handleCutoverButtonInteraction; any string NOT starting with this
 * prefix is left for other handlers to pick up.
 *
 * Collision-safe with: model-confirm:, model-cancel:, skills-picker:,
 * plugins-picker:, marketplace-, cancel:, modal-, skills-action-confirm:,
 * plugin-confirm-x:. Pinned by D2 collision regression test.
 */
export const CUTOVER_BUTTON_PREFIX = "cutover-";

/**
 * D-06 button-action vocabulary. Operator clicks one of three buttons in
 * the destructive-fix admin-clawdy embed:
 *   - accept: invoke applyDestructiveFix with pre-captured snapshot
 *   - reject: append reject-destructive ledger row; target unchanged
 *   - defer:  no-op at applier layer; next verify run re-surfaces the gap
 */
export const destructiveButtonActionSchema = z.enum([
  "accept",
  "reject",
  "defer",
]);
export type DestructiveButtonAction = z.infer<
  typeof destructiveButtonActionSchema
>;

/**
 * Template-literal type pinning the customId shape for cutover destructive
 * buttons: `cutover-{agent}-{gapId}:{action}`. The agent + gapId components
 * MAY contain hyphens (agent names like "fin-client" are common); the
 * parser splits on the LAST hyphen of the body to extract gapId, and on the
 * LAST colon to extract action. The body is the substring between the prefix
 * and the action delimiter.
 */
export type CutoverButtonCustomId =
  `cutover-${string}-${string}:${DestructiveButtonAction}`;

/**
 * Parse a Discord ButtonInteraction.customId into its (agent, gapId, action)
 * components. Returns `null` when:
 *   - The customId does NOT start with `cutover-` (collision-safe gate — leaves
 *     other handlers' customIds untouched)
 *   - There is no `:` separator in the string
 *   - The action component is not one of accept/reject/defer
 *   - The body (between prefix and `:`) lacks a hyphen separator (so we cannot
 *     split it into agent + gapId)
 *
 * Body shape: `agent-gapId`. Splits on the LAST hyphen to allow agent names
 * with hyphens (fin-client, content-creator, etc.).
 *
 * Collision regression: returns null for all of these (D2 test):
 *   - "model-confirm:fin:n"
 *   - "model-cancel:fin:n"
 *   - "skills-picker:fin:n"
 *   - "plugins-picker:fin:n"
 *   - "marketplace-skills-confirm:fin:n"
 *   - "cancel:abc"
 *   - "modal-1:fin"
 *   - "skills-action-confirm:fin:n"
 *   - "plugin-confirm-x:fin:n"
 *
 * Returns NON-null for "cutover-fin-client-abc:accept".
 */
export function parseCutoverButtonCustomId(
  customId: string,
): {
  agent: string;
  gapId: string;
  action: DestructiveButtonAction;
} | null {
  if (!customId.startsWith(CUTOVER_BUTTON_PREFIX)) return null;
  const colonIdx = customId.lastIndexOf(":");
  if (colonIdx < 0) return null;
  const action = customId.slice(colonIdx + 1);
  const parsedAction = destructiveButtonActionSchema.safeParse(action);
  if (!parsedAction.success) return null;
  const body = customId.slice(CUTOVER_BUTTON_PREFIX.length, colonIdx);
  // Body shape: agent-gapId — split on LAST hyphen to allow agent names with
  // hyphens (fin-client, content-creator, ...).
  const lastHyphen = body.lastIndexOf("-");
  if (lastHyphen < 0) return null;
  const agent = body.slice(0, lastHyphen);
  const gapId = body.slice(lastHyphen + 1);
  if (!agent || !gapId) return null;
  return { agent, gapId, action: parsedAction.data };
}

/**
 * D-06 — Outcome of a single destructive-button interaction. Discriminated by
 * `kind`. Plan 92-06 report writer + the slash-commands.ts inline handler
 * switch exhaustively over this union.
 *
 *   - accepted-applied:      Operator clicked Accept, applyDestructiveFix succeeded
 *   - accepted-apply-failed: Operator clicked Accept, applier returned failure
 *                            (ledger row appended for audit trail with reason)
 *   - rejected:              Operator clicked Reject; ledger row written, target
 *                            unchanged
 *   - deferred:              Operator clicked Defer; NO ledger row, NO mutation
 *                            (next verify run re-surfaces the gap)
 *   - expired:               Discord collector timed out before any click
 *   - invalid-customId:      customId failed parseCutoverButtonCustomId, OR
 *                            gapById returned null (gap-not-found case)
 */
export type DestructiveButtonOutcome =
  | {
      kind: "accepted-applied";
      agent: string;
      gapKind: string;
      identifier: string;
      ledgerRow: CutoverLedgerRow;
    }
  | {
      kind: "accepted-apply-failed";
      agent: string;
      gapKind: string;
      identifier: string;
      error: string;
    }
  | {
      kind: "rejected";
      agent: string;
      gapKind: string;
      identifier: string;
      ledgerRow: CutoverLedgerRow;
    }
  | {
      kind: "deferred";
      agent: string;
      gapKind: string;
      identifier: string;
    }
  | { kind: "expired"; customId: string }
  | { kind: "invalid-customId"; customId: string };

// ============================================================================
// Phase 92 Plan 05 — Dual-entry canary runner (CUT-08, D-08, D-11)
// ============================================================================
//
// Adds:
//   - CANARY_TIMEOUT_MS / CANARY_CHANNEL_ID / CANARY_TOP_INTENT_LIMIT /
//     CANARY_API_ENDPOINT constants (D-08 + D-Claude's-Discretion fin-test channel)
//   - canaryPromptSchema / CanaryPrompt (synthesizer output row)
//   - canaryInvocationResultSchema / CanaryInvocationResult
//   - CanarySynthesizeOutcome / CanaryRunOutcome / CanaryReportOutcome unions
//
// The canary runner exercises the cutover candidate end-to-end via BOTH
// production entry points: Discord bot (TurnDispatcher.dispatchStream) AND
// API (POST /v1/chat/completions). 20 prompts × 2 paths = 40 invocations
// per run. Each invocation has a 30s timeout (D-08 — timeout = failure).

/**
 * D-08 — per-path timeout in milliseconds. Any single Discord-bot OR API
 * invocation that exceeds this limit is recorded as `failed-timeout` and
 * the runner moves on to the next path/prompt. Pinned by static-grep.
 */
export const CANARY_TIMEOUT_MS = 30_000;

/**
 * D-Claude's-Discretion — canary channel ID for Discord bot path. This is
 * the recently-freed fin-test channel already bound to fin-client's
 * channels[] in clawcode.yaml (Phase 90.1 channel remap). Used only in
 * production wiring; tests DI a synthetic channel ID.
 */
export const CANARY_CHANNEL_ID = "000000000000000114";

/**
 * D-08 — number of top intents (sorted by count DESC) the synthesizer
 * uses to derive prompts. Cron-prefixed intents (per D-11 / Plan 92-01)
 * are preserved in the slice and surface as "manual trigger" prompts in
 * the canary battery so cron parity is exercised.
 */
export const CANARY_TOP_INTENT_LIMIT = 20;

/**
 * Phase 73 OpenAI-shape endpoint for the API path. Loopback only — the
 * canary never reaches an external network. Pinned by static-grep
 * regression rejecting non-localhost https/http URLs in canary-runner.ts.
 */
export const CANARY_API_ENDPOINT =
  "http://localhost:3101/v1/chat/completions";

/**
 * One synthesized canary prompt row. The synthesizer emits one of these
 * per top intent — the prompt is a representative user message that
 * exercises the intent end-to-end.
 */
export const canaryPromptSchema = z.object({
  intent: z.string().min(1),
  prompt: z.string().min(1),
});
export type CanaryPrompt = z.infer<typeof canaryPromptSchema>;

/**
 * One invocation result — produced by `runCanary` for each (prompt, path)
 * pair. status="passed" requires HTTP 200 (API) or non-empty Discord
 * reply (bot path) within `CANARY_TIMEOUT_MS`.
 */
export const canaryInvocationResultSchema = z.object({
  intent: z.string(),
  prompt: z.string(),
  path: z.enum(["discord-bot", "api"]),
  status: z.enum([
    "passed",
    "failed-empty",
    "failed-error",
    "failed-timeout",
  ]),
  responseChars: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  error: z.string().nullable(),
});
export type CanaryInvocationResult = z.infer<
  typeof canaryInvocationResultSchema
>;

/**
 * Outcome of the synthesizer (one LLM pass over the topIntents[]).
 * Discriminated by `kind`. Plan 92-06 report writer + the CLI exit-code
 * branch in cutover-canary.ts switch exhaustively over this union.
 */
export type CanarySynthesizeOutcome =
  | {
      kind: "synthesized";
      agent: string;
      prompts: readonly CanaryPrompt[];
      durationMs: number;
    }
  | {
      kind: "no-intents";
      agent: string;
    }
  | {
      kind: "dispatcher-failed";
      agent: string;
      error: string;
    }
  | {
      kind: "schema-validation-failed";
      agent: string;
      error: string;
      rawResponse: string;
    };

/**
 * Outcome of one full canary run (synthesize → 40 invocations → report).
 * passRate is the percentage of invocations with status="passed".
 */
export type CanaryRunOutcome =
  | {
      kind: "ran";
      agent: string;
      results: readonly CanaryInvocationResult[];
      passRate: number;
      reportPath: string;
      durationMs: number;
    }
  | {
      kind: "no-prompts";
      agent: string;
    }
  | {
      kind: "abort-on-error";
      agent: string;
      error: string;
    };

/**
 * Outcome of the report writer (atomic temp+rename to CANARY-REPORT.md).
 */
export type CanaryReportOutcome =
  | {
      kind: "written";
      agent: string;
      reportPath: string;
      passRate: number;
    }
  | {
      kind: "write-failed";
      agent: string;
      error: string;
    };

// ============================================================================
// Phase 92 Plan 06 — CUTOVER-REPORT.md schema, verify pipeline, rollback,
// and set-authoritative precondition (CUT-09, CUT-10, D-09, D-10)
// ============================================================================
//
// Adds the capstone surfaces consumed by:
//   - src/cutover/report-writer.ts        (writes CUTOVER-REPORT.md, reads it back
//                                          for the precondition check)
//   - src/cutover/verify-pipeline.ts      (orchestrates Plans 92-01..05 end-to-end)
//   - src/cli/commands/cutover-verify.ts  (CLI wrapper)
//   - src/cli/commands/cutover-rollback.ts (LIFO ledger-rewind)
//   - src/cli/commands/sync-set-authoritative.ts (Phase 91 precondition gate)

/**
 * D-09 — 24h freshness window (in milliseconds) for CUTOVER-REPORT.md to be
 * accepted by `clawcode sync set-authoritative clawcode --confirm-cutover`.
 * Pinned at exact arithmetic by static-grep.
 */
export const REPORT_FRESHNESS_MS = 24 * 60 * 60 * 1000;

/**
 * D-09 — root directory for per-agent CUTOVER-REPORT.md files. Each agent gets
 * a subdirectory; the most recent report is written as `latest.md`.
 */
export const DEFAULT_CUTOVER_REPORT_DIR = join(
  homedir(),
  ".clawcode",
  "manager",
  "cutover-reports",
);

/**
 * Default path for the per-agent latest CUTOVER-REPORT.md. Tests pass an
 * override; production reads from this path.
 */
export const defaultCutoverReportPath = (agent: string): string =>
  join(DEFAULT_CUTOVER_REPORT_DIR, agent, "latest.md");

/**
 * D-09 — frontmatter schema for CUTOVER-REPORT.md. Validated on read by
 * `readCutoverReport`; assembled by `writeCutoverReport`. Plan 91 set-
 * authoritative reads this back to gate on cutover_ready + freshness.
 */
export const cutoverReportFrontmatterSchema = z.object({
  agent: z.string(),
  cutover_ready: z.boolean(),
  report_generated_at: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), "must be ISO 8601"),
  gap_count: z.number().int().nonnegative(),
  additive_gap_count: z.number().int().nonnegative(),
  destructive_gap_count: z.number().int().nonnegative(),
  canary_pass_rate: z.number().nonnegative(),
  canary_total_invocations: z.number().int().nonnegative(),
});
export type CutoverReportFrontmatter = z.infer<
  typeof cutoverReportFrontmatterSchema
>;

/**
 * Outcome of `runVerifyPipeline` — the full ingest → profile → probe → diff
 * → apply-additive (dry-run unless --apply-additive) → canary (if eligible)
 * → report cycle. Discriminated by `kind`. The CLI wrapper exhaustively
 * switches on `outcome.kind` for exit-code policy.
 *
 * Per-phase failure variants bubble through verbatim so the operator sees
 * exactly which step broke. `verified-ready` and `verified-not-ready` both
 * carry the report path because writeCutoverReport always emits the report
 * (even on canary failure / not-ready states) — silent abort breaks the
 * CUT-09 "operator inspects report" contract.
 */
export type VerifyOutcome =
  | {
      kind: "verified-ready";
      agent: string;
      reportPath: string;
      gapCount: 0;
      canaryPassRate: number;
    }
  | {
      kind: "verified-not-ready";
      agent: string;
      reportPath: string;
      gapCount: number;
      destructiveCount: number;
      canaryPassRate: number;
      reason: string;
    }
  | { kind: "ingest-failed"; agent: string; error: string }
  | { kind: "profile-failed"; agent: string; error: string }
  | { kind: "probe-failed"; agent: string; error: string }
  | { kind: "diff-failed"; agent: string; error: string }
  | {
      kind: "additive-apply-failed";
      agent: string;
      error: string;
      identifier: string;
    }
  | { kind: "canary-failed"; agent: string; error: string }
  | { kind: "report-write-failed"; agent: string; error: string };

/**
 * Outcome of `runCutoverRollback` — LIFO rewind of cutover-ledger.jsonl rows
 * newer than a target timestamp. Idempotent via "rollback-of:<origTimestamp>"
 * reason markers; re-running over already-rolled-back rows is a no-op.
 */
export type RollbackOutcome =
  | {
      kind: "rolled-back";
      agent: string;
      rowsReverted: number;
      rowsSkippedIrreversible: number;
      rowsAlreadyRolledBack: number;
    }
  | { kind: "no-rows-newer-than"; agent: string; targetTs: string }
  | { kind: "ledger-not-found"; agent: string }
  | {
      kind: "rollback-failed";
      agent: string;
      error: string;
      partialRowsReverted: number;
    };

/**
 * D-09 — outcome of `checkCutoverReportPrecondition` called inside Phase 91's
 * executeForwardCutover BEFORE driveDrain. The precondition gate refuses unless
 * the report exists, parses, is fresh (<24h), and `cutover_ready: true`.
 *
 * `precondition-skipped-by-flag` is the ONLY non-passed kind that allows the
 * caller to proceed (after appending a `skip-verify` audit row to the cutover
 * ledger per D-09 emergency override). All other non-passed kinds exit 1.
 */
export type SetAuthoritativePreconditionResult =
  | { kind: "precondition-passed"; reportPath: string; ageMs: number }
  | { kind: "precondition-skipped-by-flag"; reason: string }
  | { kind: "report-missing"; reportPath: string }
  | { kind: "report-stale"; reportPath: string; ageMs: number }
  | { kind: "report-not-ready"; reportPath: string; reason: string }
  | { kind: "report-invalid"; reportPath: string; error: string };
