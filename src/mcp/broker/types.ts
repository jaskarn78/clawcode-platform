/**
 * Phase 108 — Broker shared type contracts.
 *
 * Pure type declarations + one frozen const literal for broker error
 * codes. No runtime behavior. Imported by pooled-child.ts (this plan,
 * 108-01) and broker.ts / shim-server.ts (next plan, 108-02).
 *
 * Security invariant (Phase 104 SEC-07):
 *   `BrokerLogFields` deliberately has NO field that carries a literal
 *   `OP_SERVICE_ACCOUNT_TOKEN`. The only token reference is `pool`,
 *   which embeds the short tokenHash (sha256(token).slice(0,8)).
 */

/** JSON-RPC 2.0 id — protocol allows number or string. */
export type JsonRpcId = number | string;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

/** Any message a child may emit on stdout — request/response/notification. */
export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

/**
 * Broker-internal error codes. Returned to agents in the JSON-RPC
 * `error` slot when the broker cannot complete a call (crash / drain).
 *
 * Pinned to the JSON-RPC server-defined range (-32099..-32000) per the
 * spec so the codes do not collide with method-defined errors emitted
 * by the upstream `@takescake/1password-mcp` server.
 */
export const BrokerErrorCode = {
  PoolChildCrashed: -32001,
  PoolDrainTimeout: -32002,
  PoolNotInitialized: -32003,
  /** Reserved for Pitfall 2 (token hot-reload) — wired in 108-05. */
  HotReloadUnsupported: -32004,
} as const;
export type BrokerErrorCode = (typeof BrokerErrorCode)[keyof typeof BrokerErrorCode];

/**
 * Structured pino log fields used by every broker log call.
 *
 * Decision §5 (CONTEXT.md) — operators grep `journalctl -u clawcode |
 * grep "mcp-broker" | grep "agent=fin-client"` to see which
 * 1Password calls a specific agent made. Every dispatched message
 * gets logged with this shape.
 */
export type BrokerLogFields = {
  component: "mcp-broker";
  /** "1password-mcp:<tokenHash>" — never the literal token. */
  pool: string;
  agent?: string;
  turnId?: string;
  tool?: string;
};

/**
 * Spawn-fn injection point. Production wires this to
 * `child_process.spawn`; tests pass a fake that returns a
 * `FakePooledChild` (which is `ChildProcess`-shaped).
 *
 * Used by the broker (108-02), not by PooledChild itself —
 * PooledChild is constructed with an already-spawned child.
 */
export type PooledChildSpawnFn = (
  command: string,
  args: string[],
  options: { env: Record<string, string> },
) => import("node:child_process").ChildProcess;
