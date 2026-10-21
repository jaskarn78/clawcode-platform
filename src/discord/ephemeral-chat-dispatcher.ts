/**
 * Phase 999.86 — Thin adapter that lets `DiscordBridge` route v3 chat
 * dispatches through `WarmWorkerPool` without importing the pool directly.
 *
 * Separation:
 *   - `bridge.ts` depends on `EphemeralChatDispatcher` only (a narrow
 *     surface).
 *   - The pool's surface is wider (start/stop/size/configuration) and lives
 *     in `src/manager/`. Threading the full pool through to the discord
 *     bridge would couple the wrong layers.
 *
 * The dispatcher exists so tests can inject a mock without spawning real
 * `claude --channels` workers, and so the daemon can wire the pool in
 * exactly one place.
 */

import type { Logger } from "pino";

import type { WarmWorkerPool } from "../manager/warm-worker-pool.js";

export interface EphemeralChatDispatchInput {
  readonly parent: string;
  readonly userMessage: string;
  readonly correlationId: string;
  readonly onProgress?: (accumulated: string) => void;
  readonly timeoutMs?: number;
}

export interface EphemeralChatDispatchResult {
  readonly result: string;
  readonly wasWarm: boolean;
}

export interface EphemeralChatDispatcher {
  dispatch(input: EphemeralChatDispatchInput): Promise<EphemeralChatDispatchResult>;
}

export interface DefaultEphemeralChatDispatcherDeps {
  readonly pool: WarmWorkerPool;
  readonly logger: Logger;
}

export class DefaultEphemeralChatDispatcher
  implements EphemeralChatDispatcher
{
  constructor(private readonly deps: DefaultEphemeralChatDispatcherDeps) {}

  async dispatch(
    input: EphemeralChatDispatchInput,
  ): Promise<EphemeralChatDispatchResult> {
    this.deps.logger.info(
      {
        parent: input.parent,
        correlationId: input.correlationId,
        messageLength: input.userMessage.length,
      },
      "phase99986-ephemeral-chat-dispatch",
    );
    return this.deps.pool.dispatch(input.parent, input.userMessage, {
      correlationId: input.correlationId,
      onProgress: input.onProgress,
      timeoutMs: input.timeoutMs,
    });
  }
}
