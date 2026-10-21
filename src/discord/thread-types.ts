import { join } from "node:path";
import { homedir } from "node:os";

/**
 * A single thread-to-agent binding.
 * Maps a Discord thread to an agent session for message routing.
 */
export type ThreadBinding = {
  readonly threadId: string;
  readonly parentChannelId: string;
  readonly agentName: string;
  readonly sessionName: string;
  readonly createdAt: number;
  readonly lastActivity: number;
  /**
   * Phase 999.25 — set when `relayCompletionToParent` has fired for this
   * binding (explicit `subagent_complete` tool, the quiescence-timer
   * sweep, or the existing session-end callback — whichever wins).
   * Once set, subsequent relay paths skip to avoid double-posting.
   *
   * Optional + nullable for back-compat: pre-Phase-999.25 entries parse
   * unchanged (treated as not-yet-completed). Persisted to
   * `thread-bindings.json` so the dedupe survives daemon restart.
   */
  readonly completedAt?: number | null;
  /**
   * Phase 999.36 sub-bug D (D-13, D-14) — set when the Discord post
   * pipeline has confirmed delivery of the LAST chunk for this binding.
   *
   * Used as the AND-clause partner to `streamFullyDrained` (implicit:
   * `lastDeliveryAt !== null` ⇒ stream drained AND delivered) — gates
   * the `subagent_complete` event firing in `markRelayCompleted`.
   *
   * Set by:
   *   - postInitialMessage finally block (after editor.flush + overflow loop)
   *   - relayCompletionToParent finally block (after parent main-channel post drains)
   *   - session-end callback (treats session-end as delivery-equivalent terminal state)
   *
   * NOT set by quiescence-sweep — quiescence emits `subagent_idle_warning`
   * instead and leaves `lastDeliveryAt` null.
   *
   * Optional + nullable for back-compat: pre-Phase-999.36 entries parse
   * unchanged. Persisted to thread-bindings.json (JSON registry, NOT SQL —
   * D-16 forbids SQL column changes; JSON registry shape is allowed,
   * matching the `completedAt` precedent from Phase 999.25).
   */
  readonly lastDeliveryAt?: number | null;
  /**
   * Set by `postInitialMessage` alongside `lastDeliveryAt` — `true` when
   * the SDK turn produced real content (`isRealSubagentContent` accepted
   * the trimmed reply); `false` when only the unedited "🔄 Working…"
   * placeholder is in the thread, or the SDK turn threw before producing
   * output.
   *
   * Persisted so out-of-band relay paths (quiescence sweep, session-end
   * backstop) can refuse to relay a placeholder. The auto-relay-after-turn-1
   * path in the spawner already gates on the local equivalent (commit
   * `bdf2cdc3` — `autorelay-placeholder-misfire`).
   *
   * Session-end stamps this `true` (session-end is delivery-equivalent)
   * so legacy bindings created before this field existed don't change
   * relay behaviour for that path.
   *
   * Optional + nullable for back-compat: pre-existing bindings parse
   * unchanged (treated as not-yet-known; quiescence-relay refuses unless
   * the value is explicitly `true`).
   */
  readonly producedRealContent?: boolean | null;
};

/**
 * The full thread binding registry -- an immutable collection of bindings.
 */
export type ThreadBindingRegistry = {
  readonly bindings: readonly ThreadBinding[];
  readonly updatedAt: number;
};

/**
 * Per-agent thread configuration.
 */
export type ThreadConfig = {
  readonly idleTimeoutMinutes: number;
  readonly maxThreadSessions: number;
};

/**
 * Default thread configuration values.
 * 24h idle timeout, max 3 concurrent thread sessions per agent.
 *
 * Phase 99 sub-scope N (2026-04-26) — lowered from 10 to 3 to cap
 * blast-radius if Layer 1 disallowedTools is somehow bypassed (e.g. SDK
 * regression, manual config tampering). Operator can override per-agent
 * in clawcode.yaml `threads.maxThreadSessions`. Real incident: a 5-deep
 * Admin Clawdy subagent chain spawned by a single operator task — under
 * the old default of 10, the chain could have grown twice as deep before
 * the per-agent cap stopped it.
 */
export const DEFAULT_THREAD_CONFIG: ThreadConfig = {
  idleTimeoutMinutes: 1440,
  maxThreadSessions: 3,
} as const;

/**
 * Default path for the thread bindings registry file.
 */
export const THREAD_REGISTRY_PATH: string = join(
  homedir(),
  ".clawcode",
  "manager",
  "thread-bindings.json",
);
