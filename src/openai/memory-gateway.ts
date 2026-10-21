/**
 * clawdy-v2 #8 — cross-session memory gateway seam.
 *
 * The OpenAI server exposes four REST endpoints the clawdy-iOS Memory surface
 * calls (`docs/MEMORY-CONTRACT.md` v1): ingest / list / edit / forget. The
 * server must stay decoupled from `src/memory` and `src/manager` (it imports
 * neither — see `server.ts` header), so it talks to memory ONLY through this
 * interface. The concrete implementation (which reaches the per-agent
 * `MemoryStore` + embedder) is constructed daemon-side in
 * `src/manager/openai-memory-gateway.ts` and injected via `OpenAiServerConfig`.
 *
 * "Recall" (the agent referencing a prior-session fact in a new turn) is OUT OF
 * SCOPE for this contract — these are the ingest/view/edit/delete seams only.
 */

/** The ingest body / list row from the iOS client (`StoredMemory`, v1). */
export interface StoredMemoryInput {
  /** Client-minted stable UUID. Maps to the store's `origin_id` as `ios:<id>`. */
  readonly id: string;
  /** ISO-8601 datetime the device distilled the fact. */
  readonly savedAt: string;
  /** The user-facing remembered line (non-empty). Maps to memory `content`. */
  readonly fact: string;
  /** Optional brief source descriptor. */
  readonly context?: string;
  /** Optional UUID of the session the fact was distilled from. */
  readonly sourceSessionID?: string;
}

/** A memory row returned by `list` (the GET envelope's `memories[]` element). */
export interface StoredMemoryRecord {
  readonly id: string;
  readonly savedAt: string;
  readonly fact: string;
  readonly context?: string;
  readonly sourceSessionID?: string;
}

/**
 * The memory operations the OpenAI server needs. All are scoped to a single
 * resolved agent (the bearer key's `agent_name`). Implementations are
 * best-effort and MUST NOT throw for an unknown agent (the contract's client
 * degrades to `[]` / ignores the result) — return `[]` / `false` instead.
 */
export interface MemoryGateway {
  /** Push a distilled memory (idempotent on `id`). Best-effort. */
  ingest(agentName: string, mem: StoredMemoryInput): Promise<void>;
  /** List the device-ingested memories for this agent (newest first). */
  list(agentName: string): StoredMemoryRecord[];
  /** Edit a fact by client id. Returns true if a row matched. */
  updateFact(agentName: string, id: string, fact: string): boolean;
  /** Forget a memory by client id. Returns true if a row matched. */
  forget(agentName: string, id: string): boolean;
}
