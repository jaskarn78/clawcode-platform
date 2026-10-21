/**
 * Phase 69 Plan 03 Task 4 — IPC handlers for `openai-key-*` methods.
 *
 * Exposes three handlers (create/list/revoke) that the daemon's routeMethod
 * switch dispatches to when the CLI calls `clawcode openai-key`. The
 * handlers delegate to the already-opened `apiKeysStore` (passed in via the
 * deps bag from the daemon's OpenAiEndpointHandle) so we don't double-open
 * the SQLite file.
 *
 * Request / response shapes are defined as Zod schemas so CLI ↔ daemon
 * payloads stay structurally typed. The daemon's IPC server re-validates at
 * the boundary before calling a handler.
 *
 * Revoke-clears-session semantics: when a key is revoked, the handler also
 * walks every agent's ApiKeySessionIndex and deletes the row for that
 * key_hash — so a subsequent key re-activation (if any) starts a fresh
 * session rather than inheriting the revoked key's state.
 */

import { z } from "zod/v4";

import type { ApiKeysStore, ApiKeyRow } from "./keys.js";
import type { SessionManager } from "../manager/session-manager.js";
import { ApiKeySessionIndex } from "./session-index.js";

// ---------------------------------------------------------------------------
// Zod schemas (validated by daemon routeMethod before calling a handler)
// ---------------------------------------------------------------------------

/**
 * Create-key request schema. Discriminated union on `{agent}` vs `{all:true}`:
 *   - `{agent: "name"}` — legacy pinned key (back-compat).
 *   - `{all: true}`     — multi-agent key (P51-MULTI-AGENT-KEY).
 *
 * The two shapes are mutually exclusive — Zod rejects both fields in the
 * same payload. `label` + `expiresAt` are optional on either shape.
 */
const openAiKeyCreateRequestSingleSchema = z
  .object({
    agent: z.string().min(1),
    all: z.undefined().optional(),
    label: z.string().min(1).optional(),
    expiresAt: z.number().int().positive().optional(),
  })
  .strict();

const openAiKeyCreateRequestAllSchema = z
  .object({
    agent: z.undefined().optional(),
    all: z.literal(true),
    label: z.string().min(1).optional(),
    expiresAt: z.number().int().positive().optional(),
  })
  .strict();

export const openAiKeyCreateRequestSchema = z.union([
  openAiKeyCreateRequestSingleSchema,
  openAiKeyCreateRequestAllSchema,
]);
export type OpenAiKeyCreateRequest = z.infer<typeof openAiKeyCreateRequestSchema>;

export const openAiKeyCreateResponseSchema = z.object({
  key: z.string(),
  keyHash: z.string(),
  agent: z.string(),
  label: z.string().nullable(),
  expiresAt: z.number().nullable(),
  createdAt: z.number(),
});
export type OpenAiKeyCreateResponse = z.infer<typeof openAiKeyCreateResponseSchema>;

export const openAiKeyRowSchema = z.object({
  key_hash: z.string(),
  agent_name: z.string(),
  label: z.string().nullable(),
  created_at: z.number(),
  last_used_at: z.number().nullable(),
  expires_at: z.number().nullable(),
  disabled_at: z.number().nullable(),
  // Quick task 260419-p51 — scope row, never null post-migration.
  scope: z.string(),
});
export type OpenAiKeyRow = z.infer<typeof openAiKeyRowSchema>;

export const openAiKeyListResponseSchema = z.object({
  rows: z.array(openAiKeyRowSchema),
});
export type OpenAiKeyListResponse = z.infer<typeof openAiKeyListResponseSchema>;

export const openAiKeyRevokeRequestSchema = z.object({
  identifier: z.string().min(1),
});
export type OpenAiKeyRevokeRequest = z.infer<typeof openAiKeyRevokeRequestSchema>;

export const openAiKeyRevokeResponseSchema = z.object({
  revoked: z.boolean(),
});
export type OpenAiKeyRevokeResponse = z.infer<typeof openAiKeyRevokeResponseSchema>;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** Injection bag — provided by daemon.ts at IPC handler construction time. */
export interface OpenAiKeyIpcDeps {
  /** The already-opened store (owned by OpenAiEndpointHandle). */
  readonly apiKeysStore: ApiKeysStore;
  /**
   * Accessors for per-agent memories.db handles so revoke can clear the
   * corresponding api_key_sessions row. Production wires
   * `(agent) => sessionManager.getMemoryStore(agent)?.getDatabase()`.
   */
  readonly sessionManager: Pick<SessionManager, "getMemoryStore">;
  /** List of top-level agent names for create-validation. */
  readonly agentNames: () => ReadonlyArray<string>;
}

/**
 * `openai-key-create` handler — returns the plaintext key exactly once.
 *
 * Branches on the discriminated union:
 *   - `{all: true}`       → createAllKey (scope='all', agent_name='*')
 *   - `{agent: "name"}`   → createKey (scope='agent:<name>', validated against
 *                             the configured agent fleet)
 */
export function handleOpenAiKeyCreate(
  deps: OpenAiKeyIpcDeps,
  request: OpenAiKeyCreateRequest,
): OpenAiKeyCreateResponse {
  if (request.all === true) {
    // --all key — no single-agent validation (bearer accepted on any configured
    // agent at request time; server.ts does the scope check).
    const { key, row } = deps.apiKeysStore.createAllKey({
      label: request.label,
      expiresAt: request.expiresAt,
    });
    return {
      key,
      keyHash: row.key_hash,
      agent: row.agent_name,
      label: row.label,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  }

  // Legacy pinned-key path — validate the agent name against the configured fleet.
  const agents = deps.agentNames();
  if (!agents.includes(request.agent)) {
    throw new Error(
      `Unknown agent: '${request.agent}'. Available: ${agents.join(", ") || "<none>"}`,
    );
  }
  const { key, row } = deps.apiKeysStore.createKey(request.agent, {
    label: request.label,
    expiresAt: request.expiresAt,
  });
  return {
    key,
    keyHash: row.key_hash,
    agent: row.agent_name,
    label: row.label,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

/** `openai-key-list` handler — never returns plaintext keys. */
export function handleOpenAiKeyList(
  deps: OpenAiKeyIpcDeps,
): OpenAiKeyListResponse {
  const rows: ReadonlyArray<ApiKeyRow> = deps.apiKeysStore.listKeys();
  return { rows: rows.map((r) => ({ ...r })) };
}

/** `openai-key-revoke` handler — also clears api_key_sessions across agents. */
export function handleOpenAiKeyRevoke(
  deps: OpenAiKeyIpcDeps,
  request: OpenAiKeyRevokeRequest,
): OpenAiKeyRevokeResponse {
  // Snapshot the keys that will be affected so we can clear their session
  // rows after revocation. We match the same identifier-resolution order
  // ApiKeysStore.revokeKey uses (full-key → hex-prefix → label) but without
  // the "wins-on-first-match" short-circuit — revoke itself is the source
  // of truth for WHICH row changed; we read the freshly-updated row(s) out
  // of the store afterward.
  const beforeHashes = new Set(deps.apiKeysStore.listKeys().map((r) => r.key_hash));
  const revoked = deps.apiKeysStore.revokeKey(request.identifier);
  if (!revoked) return { revoked: false };

  // Determine which hash was revoked — scan for rows whose disabled_at
  // transitioned from null → non-null since we snapshotted.
  const after = deps.apiKeysStore.listKeys();
  const targetHashes = after
    .filter((r) => r.disabled_at !== null && beforeHashes.has(r.key_hash))
    .map((r) => r.key_hash);

  // Clear api_key_sessions for every affected hash across every agent's
  // memories.db. Best-effort — failures log but do not fail the revoke.
  for (const hash of targetHashes) {
    // Find which agent owns the row (agent_name was stored at create time).
    const owner = after.find((r) => r.key_hash === hash)?.agent_name;
    if (!owner) continue;
    try {
      const memStore = deps.sessionManager.getMemoryStore(owner);
      if (!memStore) continue;
      new ApiKeySessionIndex(memStore.getDatabase()).delete(hash);
    } catch {
      /* non-fatal — the key is still disabled; session mapping is residual */
    }
  }
  return { revoked: true };
}

/**
 * Route a raw `{method, params}` pair to one of the three openai-key
 * handlers. Returns the unknown (JSON-serializable) response; daemon.ts's
 * routeMethod delegates to this one function.
 */
export function routeOpenAiKeyIpc(
  deps: OpenAiKeyIpcDeps,
  method: string,
  params: Record<string, unknown>,
): unknown {
  switch (method) {
    case "openai-key-create": {
      const req = openAiKeyCreateRequestSchema.parse(params);
      return handleOpenAiKeyCreate(deps, req);
    }
    case "openai-key-list": {
      return handleOpenAiKeyList(deps);
    }
    case "openai-key-revoke": {
      const req = openAiKeyRevokeRequestSchema.parse(params);
      return handleOpenAiKeyRevoke(deps, req);
    }
    default:
      throw new Error(`routeOpenAiKeyIpc: unknown method ${method}`);
  }
}
