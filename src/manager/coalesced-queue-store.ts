/**
 * 999.178 R1 — durable mirror of the per-agent queued-ask buffer.
 *
 * The bridge coalesces rapid-fire messages that arrive while a turn is running
 * (`message-coalescer.ts`) and parks the single depth-1 queued message inside a
 * live dispatch. Both live only in memory, so a `systemctl restart` in a
 * Client A-quiet window used to drop every queued ask silently. This store is the
 * on-disk record: an ask is written when it is buffered and removed when it is
 * delivered, so a restart mid-buffer restores and re-drains them.
 *
 * Shape and discipline mirror the other manager-dir state files
 * (verification-state-store, ux-feature-state-store):
 *   - atomic tmp + rename, mode 0600 (this is client content);
 *   - one in-process write chain so two writes can't clobber each other;
 *   - envelope validated strictly, each entry validated on its own so one bad
 *     row drops only that row;
 *   - entries older than 6h are dropped on load (with a log line) so a stale
 *     file can never resurrect an ancient ask or retry-loop a poisoned one.
 *
 * Removal policy: an ask is deleted on terminal DELIVERED, NOT at takePending
 * (a crash mid-drain must restore it) and NOT on FAILED (a failed drain is
 * retried once per restart until it succeeds or ages out — losing an ask is
 * worse than retrying one). See the bridge for the call sites.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import type { Logger } from "pino";
import { z } from "zod/v4";

/** Canonical path — beside the other per-agent state files in the manager dir. */
export const DEFAULT_COALESCED_QUEUE_STATE_PATH = join(
  homedir(),
  ".clawcode",
  "manager",
  "coalesced-queue.json",
);

/** Asks older than this are dropped on load. */
export const COALESCED_QUEUE_STALE_MS = 6 * 60 * 60 * 1000;

/**
 * `coalesced` = a message that overflowed the depth-1 queue (message 3+).
 * `depth1`    = the single message parked in the depth-1 queued slot (message 2).
 * Both restore identically (re-added to the coalescer for a combined drain);
 * the kind is kept for logging and the queued-count accounting.
 */
export type PersistedAskKind = "coalesced" | "depth1";

export type PersistedQueuedAsk = Readonly<{
  agentName: string;
  messageId: string;
  channelId: string;
  content: string;
  receivedAt: number;
  kind: PersistedAskKind;
}>;

const askSchema = z.object({
  agentName: z.string().min(1),
  messageId: z.string().min(1),
  channelId: z.string().min(1),
  content: z.string(),
  receivedAt: z.number().finite(),
  kind: z.enum(["coalesced", "depth1"]),
});

const fileSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  // Keyed by messageId; values validated one at a time so a bad row drops alone.
  asks: z.record(z.string(), z.unknown()),
});

interface StateFile {
  version: 1;
  updatedAt: string;
  asks: Record<string, unknown>;
}

const EMPTY: StateFile = { version: 1, updatedAt: "", asks: {} };

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readOrEmpty(filePath: string, log?: Logger): Promise<StateFile> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log?.warn({ filePath, error: errMessage(err) }, "coalesced-queue read failed");
    }
    return { ...EMPTY, asks: {} };
  }
  try {
    const parsed = fileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      log?.warn({ filePath }, "coalesced-queue envelope invalid — treating as empty");
      return { ...EMPTY, asks: {} };
    }
    return parsed.data as StateFile;
  } catch (err) {
    log?.warn({ filePath, error: errMessage(err) }, "coalesced-queue JSON parse failed");
    return { ...EMPTY, asks: {} };
  }
}

/** Every valid, non-stale ask. Pure over its inputs (the file text). */
function collectValid(
  file: StateFile,
  now: number,
  staleMs: number,
): { fresh: PersistedQueuedAsk[]; dropped: number } {
  const fresh: PersistedQueuedAsk[] = [];
  let dropped = 0;
  for (const [messageId, entry] of Object.entries(file.asks)) {
    const parsed = askSchema.safeParse(entry);
    if (!parsed.success || parsed.data.messageId !== messageId) {
      dropped += 1;
      continue;
    }
    if (now - parsed.data.receivedAt >= staleMs) {
      dropped += 1;
      continue;
    }
    fresh.push(Object.freeze({ ...parsed.data }));
  }
  return { fresh, dropped };
}

/**
 * Load every queued ask still worth restoring, oldest first. Stale/invalid
 * rows are dropped (a single log line reports the count). Never throws — a
 * restore fault must not block boot.
 */
export async function loadCoalescedQueue(
  filePath: string,
  now: number = Date.now(),
  log?: Logger,
  staleMs: number = COALESCED_QUEUE_STALE_MS,
): Promise<PersistedQueuedAsk[]> {
  const file = await readOrEmpty(filePath, log);
  const { fresh, dropped } = collectValid(file, now, staleMs);
  if (dropped > 0) {
    log?.info({ filePath, dropped }, "coalesced-queue restore — dropped stale/invalid asks");
  }
  fresh.sort((a, b) => a.receivedAt - b.receivedAt);
  return fresh;
}

// ---------------------------------------------------------------------------
// Writes — serialized so two concurrent mutations can't lose each other's row.
// ---------------------------------------------------------------------------

let writeChain: Promise<unknown> = Promise.resolve();

async function writeAtomic(filePath: string, asks: Record<string, unknown>, log?: Logger): Promise<void> {
  const next: StateFile = { version: 1, updatedAt: new Date().toISOString(), asks };
  const tmp = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await mkdir(dirname(filePath), { recursive: true });
    // 0600 — client content must not be world-readable.
    await writeFile(tmp, JSON.stringify(next), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, filePath);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    log?.warn({ filePath, error: errMessage(err) }, "coalesced-queue write failed");
    throw err;
  }
}

async function mutate(
  filePath: string,
  fn: (asks: Record<string, unknown>) => Record<string, unknown> | null,
  log?: Logger,
): Promise<void> {
  const existing = await readOrEmpty(filePath, log);
  const next = fn({ ...existing.asks });
  if (next === null) return; // no-op — nothing to write
  await writeAtomic(filePath, next, log);
}

/** Add or replace one ask by messageId (idempotent). */
export function upsertQueuedAsk(
  filePath: string,
  ask: PersistedQueuedAsk,
  log?: Logger,
): Promise<void> {
  const run = writeChain.then(() =>
    mutate(
      filePath,
      (asks) => ({ ...asks, [ask.messageId]: { ...ask } }),
      log,
    ),
  );
  writeChain = run.catch(() => undefined);
  return run;
}

/** Remove one ask by messageId. A no-op (no write) when it is absent. */
export function removeQueuedAsk(
  filePath: string,
  messageId: string,
  log?: Logger,
): Promise<void> {
  const run = writeChain.then(() =>
    mutate(
      filePath,
      (asks) => {
        if (!Object.hasOwn(asks, messageId)) return null;
        const rest = { ...asks };
        delete rest[messageId];
        return rest;
      },
      log,
    ),
  );
  writeChain = run.catch(() => undefined);
  return run;
}

/** Remove several asks by messageId in one write. */
export function removeQueuedAsks(
  filePath: string,
  messageIds: readonly string[],
  log?: Logger,
): Promise<void> {
  const run = writeChain.then(() =>
    mutate(
      filePath,
      (asks) => {
        let changed = false;
        const rest = { ...asks };
        for (const id of messageIds) {
          if (Object.hasOwn(rest, id)) {
            delete rest[id];
            changed = true;
          }
        }
        return changed ? rest : null;
      },
      log,
    ),
  );
  writeChain = run.catch(() => undefined);
  return run;
}
