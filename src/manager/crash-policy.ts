/**
 * Crash-policy classification for the daemon's global `uncaughtException` handler.
 *
 * Born from the 2026-06-19 prod-down: a single managed child's asynchronous
 * EPIPE (the SDK writing to a dead `claude`'s stdin) reached the global
 * `uncaughtException` handler, which unconditionally `process.exit(1)`-ed → it
 * took down the ENTIRE 11-agent fleet (systemd crash-loop). An EPIPE is never a
 * sign of corrupted daemon state — it only means "the pipe/socket peer went
 * away." Killing the fleet for a broken-pipe write is never the right response.
 *
 * The PRIMARY fix is the stdio-stream guard at the spawn seam
 * (`detached-spawn.ts` `guardChildStreams`), which stops the EPIPE from ever
 * reaching this handler for the v2/SDK persistent spawn path (the incident
 * path). This classifier is the defense-in-depth net for the OTHER
 * claude-spawning paths that do NOT route through that seam — the create-time
 * drain query (`session-adapter.ts`), per-turn queries, the OpenAI voice
 * drivers, and fork/escalation queries. The SDK guards none of their stdio
 * streams either, so any of them could re-raise the same fatal EPIPE.
 *
 * Scope is deliberately narrow (matches the incident evidence — do not widen
 * blindly):
 *   - ONLY the `uncaughtException` handler consults this. `unhandledRejection`
 *     stays strict: a rejected promise comes from an awaited path that has its
 *     own error handling, so an unhandled one is a genuine bug worth crashing on.
 *   - ONLY `EPIPE` is non-fatal today (the proven "peer went away" code). If we
 *     ever observe `ECONNRESET` (or similar) crashing the daemon from a
 *     non-seam path, add it to {@link NON_FATAL_PIPE_ERROR_CODES} — it is the
 *     same class. Every other uncaught error stays fatal, preserving the daemon's
 *     genuine crash-on-corruption backstop (INC-2026-06-04).
 */

/** Minimal shape of an error carrying an optional libuv/syscall `code`. */
interface CodedError {
  readonly code?: unknown;
}

/**
 * Uncaught-error codes that are non-fatal at the process level — a write whose
 * peer (a managed child, a disconnected IPC client) went away. Logged + survived,
 * never `process.exit`-ed. Kept to exactly the incident evidence (EPIPE); widen
 * only on observed need.
 */
export const NON_FATAL_PIPE_ERROR_CODES: readonly string[] = ["EPIPE"];

/**
 * True when an uncaught error is a broken-pipe error that must NOT exit the
 * daemon (log + continue instead). Pure + total — safe to unit-test in
 * isolation and to call from the hot global-handler path.
 */
export function isNonFatalPipeError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as CodedError).code;
  return typeof code === "string" && NON_FATAL_PIPE_ERROR_CODES.includes(code);
}
