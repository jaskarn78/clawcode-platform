/**
 * Phase 999.19-02 — delegated-work consolidation.
 *
 * When a delegated subagent (`delegateTo` set) finishes its turn, the
 * spawner — before it archives the thread and stops the session — writes
 * ONE summary memory record directly into the DELEGATE agent's per-agent
 * `MemoryStore`. The delegate (`research` / `fin-research`) is always a
 * configured top-level agent, so its `MemoryStore` + the shared
 * `EmbeddingService` are live regardless of session state — this is a
 * direct DB write, NOT a message dispatch (CONTEXT.md D4).
 *
 * The record shape (CONTEXT.md D5) is a single flat `content` string +
 * one embedding, `source: "consolidation"`, `importance: 0.7`,
 * `tags: ["delegated-research", "subagent", <parentAgentName>]`. The
 * delegate later surfaces it via the existing Phase 90 MEM-03 hybrid-RRF
 * retrieval path — no retrieval-side changes.
 *
 * Failure contract (Phase 999.39 fail-loud precedent): a consolidation
 * failure is caught, logged at WARN with full context, and swallowed.
 * It must NEVER block the spawner's archive/stop chain or throw out of
 * `postInitialMessage` — a leaked-but-archived thread beats a stuck
 * session.
 */
import type { Logger } from "pino";
import type { MemoryStore } from "../memory/store.js";

/** Max chars of the operator's task baked into the record (D5). */
const TASK_MAX_CHARS = 200;
/** Max chars of the delegate's relayed findings baked into the record (D5). */
const FINDINGS_MAX_CHARS = 1200;

/**
 * Injected dependencies — DI-friendly so unit tests can stub the store,
 * the embedder, and the logger without a real DB or a real model.
 */
export interface ConsolidationDeps {
  /** Resolve the delegate agent's live `MemoryStore` (always configured). */
  readonly getMemoryStore: (agent: string) => MemoryStore | undefined;
  /** Embed arbitrary text via the shared process-wide `EmbeddingService`. */
  readonly embedText: (text: string) => Promise<Float32Array>;
  readonly log: Logger;
}

/** The facts that go into a delegated-work consolidation record. */
export interface ConsolidationInput {
  /** The delegate agent name — `config.delegateTo`. */
  readonly delegateAgent: string;
  /** The parent agent that delegated the work — `config.parentAgentName`. */
  readonly parentAgent: string;
  /** The operator's request to the delegate — `config.task`. */
  readonly task: string;
  /** The delegate's final relayed text (the deliverable). */
  readonly keyFindings: string;
  /** The Discord thread ID the work happened in. */
  readonly threadId: string;
  /** Full Discord thread URL when resolvable; else the bare ID is used. */
  readonly threadUrl?: string;
}

/**
 * Truncate `text` to at most `max` chars, appending an ellipsis when the
 * string was actually cut. Strings are truncated, never dropped — a
 * 5000-char task still produces a valid ~200-char prefix.
 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/**
 * Build the flat `content` string for a delegated-work memory record per
 * CONTEXT.md D5. Exported so the unit test can assert the shape directly.
 */
export function buildConsolidationContent(input: ConsolidationInput): string {
  const task = truncate(input.task.trim(), TASK_MAX_CHARS);
  const findings = truncate(input.keyFindings.trim(), FINDINGS_MAX_CHARS);
  const threadRef = input.threadUrl ?? input.threadId;
  const completed = new Date().toISOString();
  return (
    `[Delegated research] ${task}\n\n` +
    `Key findings:\n${findings}\n\n` +
    `Thread: ${threadRef}\n` +
    `Delegated by: ${input.parentAgent}\n` +
    `Completed: ${completed}`
  );
}

/**
 * Write one `source: "consolidation"` memory record into the delegate
 * agent's `MemoryStore`. Direct DB write — no live delegate session
 * required. All failures are caught, logged at WARN, and swallowed; this
 * function never throws.
 */
export async function consolidateDelegatedWork(
  input: ConsolidationInput,
  deps: ConsolidationDeps,
): Promise<void> {
  const store = deps.getMemoryStore(input.delegateAgent);
  if (!store) {
    // Defensive — a configured delegate always has a store; this should
    // not happen. WARN and return rather than throwing into the spawner.
    deps.log.warn(
      { delegate: input.delegateAgent, threadId: input.threadId },
      "consolidation skipped — no memory store for delegate",
    );
    return;
  }

  try {
    const content = buildConsolidationContent(input);
    const embedding = await deps.embedText(content);
    store.insert(
      {
        content,
        source: "consolidation",
        importance: 0.7,
        tags: ["delegated-research", "subagent", input.parentAgent],
      },
      embedding,
    );
    deps.log.info(
      {
        delegate: input.delegateAgent,
        threadId: input.threadId,
        parentAgent: input.parentAgent,
      },
      "delegated work consolidated to delegate memory",
    );
  } catch (err) {
    deps.log.warn(
      {
        threadId: input.threadId,
        delegate: input.delegateAgent,
        error: (err as Error).message,
      },
      "delegated-work consolidation failed (non-fatal)",
    );
  }
}
