/**
 * M2 — shared per-thread relay mutex.
 *
 * The subagent-completion relay can be triggered from THREE concurrent paths:
 *   1. the explicit `subagent_complete` IPC, via
 *      `relayAndMarkCompletedByThreadId` (relay-and-mark-completed.ts);
 *   2. the daemon's session-end backstop, which calls
 *      `spawner.relayCompletionToParent(threadId)` directly (daemon.ts);
 *   3. the spawner's own turn-1 auto-relay, which also calls
 *      `relayCompletionToParent(thread.id)` directly (subagent-thread-spawner.ts).
 *
 * Without coordination, two of these can both POST the completion summary to
 * the parent channel for the SAME thread (the `completedAt` dedupe flag is
 * stamped only AFTER the post, so a check-then-post in two paths races).
 *
 * This module is the SINGLE per-thread critical section every post path holds,
 * so the dedupe-check + post (+ stamp) is atomic per thread across all three
 * entry points. The actual exactly-once enforcement lives in
 * `relayCompletionToParent` (re-check `completedAt` inside the lock, skip if
 * set), which every path funnels its Discord post through.
 *
 * Mirrors `withRegistryLock` (thread-registry.ts): a `Map<threadId, Promise>`
 * chain; the stored chain promise never rejects (a failed op is isolated so one
 * failure does not skip the next caller); the real result/rejection still
 * returns to the current caller. Entries self-prune on settle.
 */

const relayChains = new Map<string, Promise<unknown>>();

export function withRelayLock<T>(
  threadId: string,
  op: () => Promise<T>,
): Promise<T> {
  const prev = relayChains.get(threadId) ?? Promise.resolve();
  const run = prev.then(op, op);
  const guard = run.then(
    () => undefined,
    () => undefined,
  );
  relayChains.set(threadId, guard);
  // Prune the entry once this op settles IF it is still the tail — keeps the
  // map from growing per distinct thread forever.
  void guard.then(() => {
    if (relayChains.get(threadId) === guard) {
      relayChains.delete(threadId);
    }
  });
  return run;
}
