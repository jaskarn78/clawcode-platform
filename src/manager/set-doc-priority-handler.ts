/**
 * Phase 999.43 Plan 04 T01 — `set-doc-priority` + `reclassify-docs` +
 * `set-doc-priority-by-message` IPC handler bodies. Extracted from
 * daemon.ts for direct testability (auto-ingest-handler.ts precedent).
 *
 * Plan 04 ships THREE override surfaces (Discord emoji, MCP tool, CLI)
 * that all converge on the SAME daemon-level write — single-source-of-truth
 * per feedback_silent_path_bifurcation.md. The `who` discriminator
 * differentiates the caller; D-08 sandbox enforcement is gated on it.
 *
 * D-08 sandbox (LOCKED VERBATIM from 999.43-CONTEXT.md):
 *   - Agents can only adjust docs they themselves ingested
 *     (`documents.agent_name === caller`) — Phase 90 isolation.
 *   - Agents CANNOT escalate own doc beyond MEDIUM (operator-only HIGH
 *     via emoji or CLI).
 *   - Every set_priority call writes an audit-log entry with
 *     (agent, doc_id, old_level, new_level, who, ts, reason?).
 *
 * Audit-log JSONL: `${agentConfig.memoryPath}/audit-priority-changes.jsonl`.
 * Pattern matches Phase 95 dream-veto-store (append-only newline-delimited
 * JSON via `fs.appendFile`). Defense-in-depth: even if the MCP-side
 * `z.enum(["medium","low"])` (Layer-1 sandbox) is bypassed, this handler
 * (Layer-2 sandbox) still rejects "high" when `who === "agent"`.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "pino";
import type { DocumentStore, ContentPriorityLevel } from "../documents/store.js";
import { CONTENT_PRIORITY_WEIGHTS } from "../documents/store.js";
import { ManagerError } from "../shared/errors.js";

/** IPC request payload for `set-doc-priority`. */
export type SetDocPriorityParams = {
  readonly agent: string;
  readonly source: string;
  readonly level: ContentPriorityLevel;
  readonly who: "operator" | "agent";
  readonly callerAgent?: string;
  readonly reason?: string;
};

/** IPC request payload for `set-doc-priority-by-message`. */
export type SetDocPriorityByMessageParams = {
  readonly agent: string;
  readonly message_id: string;
  readonly level: ContentPriorityLevel;
  readonly who: "operator" | "agent";
  readonly callerAgent?: string;
  readonly reason?: string;
};

/** IPC request payload for `reclassify-docs`. */
export type ReclassifyDocsParams = {
  readonly agent: string;
  readonly rule: string;
  readonly who: "operator";
};

/** Result shape — `ok:false` carries an error string (no throw on refusal). */
export type SetDocPriorityResult =
  | {
      readonly ok: true;
      readonly source: string;
      readonly old_level: ContentPriorityLevel;
      readonly new_level: ContentPriorityLevel;
      readonly who: "operator" | "agent";
    }
  | { readonly ok: false; readonly error: string };

export type ReclassifyDocsResult = {
  readonly ok: true;
  readonly updated: number;
};

/** DI deps — daemon wires concrete impls; tests pass stubs. */
export type SetDocPriorityDeps = {
  readonly getDocumentStore: (agent: string) => DocumentStore | undefined;
  readonly getAgentMemoryPath: (agent: string) => string | undefined;
  readonly logger: Logger;
  /** Optional: override clock for deterministic audit timestamps in tests. */
  readonly nowIso?: () => string;
  /** Optional: override append helper (defaults to node:fs/promises). */
  readonly appendFileFn?: typeof appendFile;
  /** Optional: override mkdir helper (defaults to node:fs/promises). */
  readonly mkdirFn?: typeof mkdir;
};

/** Audit-log row shape — single-line JSON appended to the JSONL file. */
type AuditRow = {
  readonly ts: string;
  readonly agent: string;
  readonly source: string;
  readonly who: "operator" | "agent";
  readonly callerAgent?: string | null;
  readonly outcome:
    | "applied"
    | "applied-bulk"
    | "refused-escalation"
    | "refused-isolation";
  readonly oldLevel?: ContentPriorityLevel | null;
  readonly newLevel?: ContentPriorityLevel;
  readonly attemptedLevel?: ContentPriorityLevel;
  readonly reason?: string | null;
  readonly rule?: string;
};

async function writeAuditLog(
  memoryPath: string,
  row: AuditRow,
  appendFileFn: typeof appendFile,
  mkdirFn: typeof mkdir,
): Promise<void> {
  const file = `${memoryPath}/audit-priority-changes.jsonl`;
  // Defensive: ensure the parent dir exists. Idempotent.
  await mkdirFn(dirname(file), { recursive: true });
  await appendFileFn(file, JSON.stringify(row) + "\n", { encoding: "utf8" });
}

/**
 * Phase 999.43 Plan 04 T01 — core priority-change write surface.
 *
 * D-08 sandbox enforcement lives HERE (Layer-2 defense-in-depth) even
 * though the MCP tool's `z.enum(["medium","low"])` schema (Layer-1)
 * already rejects HIGH from agent calls at the SDK boundary. If the
 * MCP schema is ever bypassed or modified, this layer still holds.
 *
 * Returns `{ok:false, error}` for refusals (D-08 sandbox + Phase 90
 * isolation). Throws ManagerError ONLY for unrecoverable lookup misses
 * (missing agent / missing doc store / missing doc row).
 */
export async function handleSetDocPriority(
  params: SetDocPriorityParams,
  deps: SetDocPriorityDeps,
): Promise<SetDocPriorityResult> {
  const { agent: agentName, source, level: levelRaw, who, callerAgent, reason } =
    params;
  const logger = deps.logger;
  const appendFileFn = deps.appendFileFn ?? appendFile;
  const mkdirFn = deps.mkdirFn ?? mkdir;
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());

  if (levelRaw !== "high" && levelRaw !== "medium" && levelRaw !== "low") {
    throw new ManagerError(`invalid level '${levelRaw}'`);
  }
  if (who !== "operator" && who !== "agent") {
    throw new ManagerError(`invalid who '${who}'`);
  }

  const docStore = deps.getDocumentStore(agentName);
  if (!docStore) {
    throw new ManagerError(
      `Document store not found for agent '${agentName}'`,
    );
  }
  const existing = docStore.getDocumentRow(source);
  if (!existing) {
    throw new ManagerError(
      `Document '${source}' not found in agent '${agentName}' store`,
    );
  }

  const memoryPath = deps.getAgentMemoryPath(agentName);
  if (!memoryPath) {
    throw new ManagerError(
      `Agent memoryPath not found for '${agentName}' (audit-log target)`,
    );
  }

  const oldLevel: ContentPriorityLevel =
    existing.override_class ?? existing.auto_classified_class;

  // D-08 sandbox enforcement — agent calls only.
  if (who === "agent") {
    if (!callerAgent) {
      throw new ManagerError("callerAgent required when who='agent'");
    }
    // Phase 90 isolation: agent may only mutate docs it ingested.
    if (existing.agent_name !== callerAgent) {
      await writeAuditLog(
        memoryPath,
        {
          ts: nowIso(),
          agent: agentName,
          source,
          who,
          callerAgent,
          attemptedLevel: levelRaw,
          oldLevel,
          outcome: "refused-isolation",
          reason: reason ?? null,
        },
        appendFileFn,
        mkdirFn,
      );
      logger.info(
        {
          tag: "phase999.43-priority",
          agent: agentName,
          source,
          who,
          callerAgent,
          outcome: "refused-isolation",
        },
        "phase999.43-priority refused (Phase 90 isolation)",
      );
      return {
        ok: false,
        error: `Phase 90 isolation: '${callerAgent}' cannot modify doc owned by '${existing.agent_name}'`,
      };
    }
    // D-08 sandbox: agents cannot escalate own doc beyond MEDIUM.
    if (levelRaw === "high") {
      await writeAuditLog(
        memoryPath,
        {
          ts: nowIso(),
          agent: agentName,
          source,
          who,
          callerAgent,
          attemptedLevel: levelRaw,
          oldLevel,
          outcome: "refused-escalation",
          reason: reason ?? null,
        },
        appendFileFn,
        mkdirFn,
      );
      logger.info(
        {
          tag: "phase999.43-priority",
          agent: agentName,
          source,
          who,
          callerAgent,
          outcome: "refused-escalation",
        },
        "phase999.43-priority refused (D-08 sandbox)",
      );
      return {
        ok: false,
        error:
          "D-08 sandbox: agents cannot escalate own doc beyond MEDIUM. Operator must use 🔴 emoji reaction or `clawcode rag set-priority`.",
      };
    }
  }

  // Apply the write.
  docStore.setDocumentPriority(source, levelRaw, who);

  await writeAuditLog(
    memoryPath,
    {
      ts: nowIso(),
      agent: agentName,
      source,
      who,
      callerAgent: callerAgent ?? null,
      newLevel: levelRaw,
      oldLevel,
      outcome: "applied",
      reason: reason ?? null,
    },
    appendFileFn,
    mkdirFn,
  );

  logger.info(
    {
      tag: "phase999.43-priority",
      agent: agentName,
      source,
      oldLevel,
      newLevel: levelRaw,
      who,
      callerAgent: callerAgent ?? null,
      reason: reason ?? null,
    },
    "phase999.43-priority override applied",
  );

  return {
    ok: true,
    source,
    old_level: oldLevel,
    new_level: levelRaw,
    who,
  };
}

/**
 * Phase 999.43 Plan 04 T01 — emoji-reaction entrypoint. Resolves the
 * `documents` row by Discord `message_id` then delegates to the same
 * `handleSetDocPriority` body. SINGLE-SOURCE-OF-TRUTH per
 * feedback_silent_path_bifurcation.md.
 */
export async function handleSetDocPriorityByMessage(
  params: SetDocPriorityByMessageParams,
  deps: SetDocPriorityDeps,
): Promise<SetDocPriorityResult> {
  const docStore = deps.getDocumentStore(params.agent);
  if (!docStore) {
    throw new ManagerError(
      `Document store not found for agent '${params.agent}'`,
    );
  }
  const row = docStore.getDocumentRowByMessageId(params.message_id);
  if (!row) {
    return {
      ok: false,
      error: `No ingested document found for message '${params.message_id}' — was the attachment auto-ingested?`,
    };
  }
  return handleSetDocPriority(
    {
      agent: params.agent,
      source: row.source,
      level: params.level,
      who: params.who,
      callerAgent: params.callerAgent,
      reason: params.reason,
    },
    deps,
  );
}

/**
 * Phase 999.43 Plan 04 T01 — bulk reclassify with a `<pattern>=<level>`
 * glob rule. CLI-only entrypoint (operator-driven). Walks every source
 * in the agent's document store; matches against the basic `*` glob;
 * applies the new level + writes an audit line per match.
 */
export async function handleReclassifyDocs(
  params: ReclassifyDocsParams,
  deps: SetDocPriorityDeps,
): Promise<ReclassifyDocsResult> {
  const logger = deps.logger;
  const appendFileFn = deps.appendFileFn ?? appendFile;
  const mkdirFn = deps.mkdirFn ?? mkdir;
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());

  const match = params.rule.match(/^(.+?)=(high|medium|low)$/i);
  if (!match) {
    throw new ManagerError(
      `invalid rule '${params.rule}' — expected '<pattern>=<level>'`,
    );
  }
  const [, pattern, level] = match;
  const levelLower = level.toLowerCase() as ContentPriorityLevel;
  if (!(levelLower in CONTENT_PRIORITY_WEIGHTS)) {
    // Shouldn't happen — regex pinned to the three values — but keep the
    // belt-and-suspenders branch so a malformed regex never silently writes.
    throw new ManagerError(`invalid level in rule '${params.rule}'`);
  }

  const docStore = deps.getDocumentStore(params.agent);
  if (!docStore) {
    throw new ManagerError(
      `Document store not found for agent '${params.agent}'`,
    );
  }
  const memoryPath = deps.getAgentMemoryPath(params.agent);
  if (!memoryPath) {
    throw new ManagerError(
      `Agent memoryPath not found for '${params.agent}' (audit-log target)`,
    );
  }

  // Convert basic glob (`*` only) to anchored regex. Escape regex
  // metachars first so user-supplied patterns can't accidentally
  // smuggle regex semantics.
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*") +
      "$",
  );
  // listDocumentSources iterates the `documents` provenance table (Plan 04
   // addition); `listSources` would only see chunked docs and miss any
   // provenance row whose chunks haven't been seeded — which would
   // silently under-apply the rule on operator-set documents that were
   // upsert'd but not yet chunk-ingested.
  const sources = docStore.listDocumentSources();
  let updated = 0;
  for (const src of sources) {
    if (!re.test(src)) continue;
    const existing = docStore.getDocumentRow(src);
    if (!existing) continue;
    const oldLevel: ContentPriorityLevel =
      existing.override_class ?? existing.auto_classified_class;
    docStore.setDocumentPriority(src, levelLower, params.who);
    await writeAuditLog(
      memoryPath,
      {
        ts: nowIso(),
        agent: params.agent,
        source: src,
        who: params.who,
        newLevel: levelLower,
        oldLevel,
        outcome: "applied-bulk",
        rule: params.rule,
      },
      appendFileFn,
      mkdirFn,
    );
    updated += 1;
  }

  logger.info(
    {
      tag: "phase999.43-priority",
      agent: params.agent,
      rule: params.rule,
      updated,
      level: levelLower,
    },
    "phase999.43-priority bulk reclassify",
  );

  return { ok: true, updated };
}
