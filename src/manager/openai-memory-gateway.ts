/**
 * clawdy-v2 #8 — concrete MemoryGateway for the OpenAI memory REST endpoints.
 *
 * Lives daemon-side (it reaches `src/memory`); the OpenAI server only sees the
 * `MemoryGateway` interface (`src/openai/memory-gateway.ts`). Wired in
 * `endpoint-bootstrap.ts` from `SessionManager.getMemoryStore` + `embedText`.
 *
 * Storage mapping (StoredMemory ↔ MemoryStore record):
 *   - client `id` (UUID)      → `origin_id` as `ios:<id>`  (stable + idempotent)
 *   - `fact`                  → memory `content`           (embedded for parity)
 *   - source                  → `'manual'`
 *   - tag                     → `['ios-memory']`           (fixed, collision-safe)
 *   - savedAt/context/sourceSessionID → the opaque `metadata` JSON column
 *
 * GET is scoped to `origin_id LIKE 'ios:%'` so it returns ONLY device-ingested
 * rows — never the agent's soul/conversation/consolidation/dream corpus.
 */

import type { MemoryStore } from "../memory/store.js";
import type {
  MemoryGateway,
  StoredMemoryInput,
  StoredMemoryRecord,
} from "../openai/memory-gateway.js";

/** origin_id namespace for device-ingested memories. */
const IOS_ORIGIN_PREFIX = "ios:";
/** Fixed, collision-safe tag (findByTag uses LIKE '%tag%' — keep it literal). */
const IOS_TAG = "ios-memory";

/** The iOS-only fields packed into the memory row's `metadata` column. */
interface IosMeta {
  savedAt?: string;
  context?: string;
  sourceSessionID?: string;
}

function encodeMeta(m: IosMeta): string {
  return JSON.stringify(m);
}

function decodeMeta(raw: string | null): IosMeta {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as unknown;
    return o !== null && typeof o === "object" ? (o as IosMeta) : {};
  } catch {
    return {};
  }
}

export interface MemoryGatewayDeps {
  /** Per-agent memory store lookup (undefined when the agent has none). */
  readonly getStore: (agentName: string) => MemoryStore | undefined;
  /** Embed a string to a 384-dim float32 vector (the per-agent embedder). */
  readonly embed: (text: string) => Promise<Float32Array>;
}

export function createMemoryGateway(deps: MemoryGatewayDeps): MemoryGateway {
  return {
    async ingest(agentName: string, mem: StoredMemoryInput): Promise<void> {
      const store = deps.getStore(agentName);
      if (!store) return;
      const originId = IOS_ORIGIN_PREFIX + mem.id;
      const embedding = await deps.embed(mem.fact);
      // origin_id path → INSERT-OR-IGNORE idempotency; skipDedup because a
      // device-authored digest is not subject to content-similarity merging.
      store.insert(
        {
          content: mem.fact,
          source: "manual",
          tags: [IOS_TAG],
          origin_id: originId,
          skipDedup: true,
        },
        embedding,
      );
      // Round-trip the iOS-only fields via the opaque metadata column. A
      // post-insert UPDATE keeps the hot insert() path untouched; it re-runs
      // (idempotent, same value) on a re-ingest of the same id.
      store.setMetadataByOriginId(
        originId,
        encodeMeta({
          savedAt: mem.savedAt,
          context: mem.context,
          sourceSessionID: mem.sourceSessionID,
        }),
      );
    },

    list(agentName: string): StoredMemoryRecord[] {
      const store = deps.getStore(agentName);
      if (!store) return [];
      return store
        .listByOriginPrefix(IOS_ORIGIN_PREFIX + "%")
        .map((row): StoredMemoryRecord => {
          const meta = decodeMeta(row.metadata);
          return {
            id: row.originId.startsWith(IOS_ORIGIN_PREFIX)
              ? row.originId.slice(IOS_ORIGIN_PREFIX.length)
              : row.originId,
            // The device timestamp if we kept it, else created_at (≈ ingest
            // time ≈ savedAt). savedAt is optional on the iOS decode side.
            savedAt: meta.savedAt ?? row.createdAt,
            fact: row.content,
            ...(meta.context !== undefined ? { context: meta.context } : {}),
            ...(meta.sourceSessionID !== undefined
              ? { sourceSessionID: meta.sourceSessionID }
              : {}),
          };
        });
    },

    updateFact(agentName: string, id: string, fact: string): boolean {
      const store = deps.getStore(agentName);
      if (!store) return false;
      return store.updateContentByOriginId(IOS_ORIGIN_PREFIX + id, fact);
    },

    forget(agentName: string, id: string): boolean {
      const store = deps.getStore(agentName);
      if (!store) return false;
      return store.deleteByOriginId(IOS_ORIGIN_PREFIX + id);
    },
  };
}
